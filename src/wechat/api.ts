import type {
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlResp,
  SendTypingReq,
  GetConfigResp,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random base64 identifier. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;
  private readonly nextSendTime = new Map<string, number>();
  private static readonly MIN_SEND_INTERVAL = 2500;
  // Cooldown applied after a rate-limit (ret:-2). Aligned with the circuit
  // breaker window so they don't fight each other.
  private static readonly RATE_LIMIT_COOLDOWN_MS = 30_000;

  // ── Circuit breaker ────────────────────────────────────────────────────
  // Trips on the first `ret:-2` and stays open with an **exponential
  // backoff** capped at CIRCUIT_MAX_OPEN_MS: 30s → 60s → 120s → … → 300s.
  //
  // The backoff was originally a retry schedule, and it was built on a wrong
  // model: it treated iLink's 10-message limit as a burst rate limit that
  // time would refill. It does not — the budget refills only when the user
  // sends a message. So the schedule was never going to succeed; it just
  // stretched the interval between guaranteed failures.
  //
  // The calculation is kept because it is still the honest description of how
  // long a penalty has lasted, and because removing it would change the
  // shape of the code for no gain. What changed is who closes the breaker:
  // `resetCircuit()`, called when the user speaks — not a timer, and not a
  // probe send. The sender no longer waits out the backoff; it stops and
  // keeps the message queued until the user comes back.
  private static readonly CIRCUIT_THRESHOLD = 1;
  private static readonly CIRCUIT_WINDOW_MS = 30_000;
  private static readonly CIRCUIT_OPEN_MS = 30_000;        // initial backoff
  private static readonly CIRCUIT_MAX_OPEN_MS = 5 * 60_000; // 5 min cap
  private readonly _rateLimitEvents: number[] = [];
  private _circuitUntil = 0;
  // How many consecutive trips we've had since the last successful send.
  // Drives the backoff multiplier. Reset to 0 when a probe succeeds.
  private _circuitTripCount = 0;

  // ret:-2 + errmsg="unknown error" is a stale-session signal (same family
  // as errcode:-14), not a real rate-limit. Pause that user 10 minutes
  // instead of cycling through the rate-limit path.
  private static readonly STALE_SESSION_PAUSE_MS = 10 * 60 * 1000;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new messages. Timeout 35s for long-polling. */
  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  /** Send a message to a user. */
  async sendMessage(req: SendMessageReq): Promise<void> {
    // Circuit breaker: fail fast without calling the API while open.
    // This is what breaks the 14-minute head-banging loop.
    if (this._isCircuitOpen()) {
      const remainingSec = Math.ceil((this._circuitUntil - Date.now()) / 1000);
      logger.warn('sendMessage rejected by circuit breaker', { remainingSec });
      throw new Error(`circuit breaker open, ${remainingSec}s remaining`);
    }

    const userId = req.msg?.to_user_id;
    if (userId) {
      const now = Date.now();
      const nextAvailable = (this.nextSendTime.get(userId) ?? 0) + WeChatApi.MIN_SEND_INTERVAL;
      const sendAt = Math.max(now, nextAvailable);
      this.nextSendTime.set(userId, sendAt);
      const waitMs = sendAt - now;
      if (waitMs > 0) {
        logger.debug('Rate limiter waiting', { userId, waitMs });
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    const res = await this.request<{ ret?: number; errmsg?: string }>('ilink/bot/sendmessage', req);
    if (res.ret === -2) {
      // Distinguish stale-session (ret:-2 + errmsg "unknown error") from quota
      // exhaustion. Hermes WeChat adapter established this pattern: the
      // stale-session case behaves like errcode:-14 and is fixed by re-login,
      // not by retry.
      const errmsg = (res.errmsg ?? '').toLowerCase();
      if (errmsg === 'unknown error') {
        logger.warn('sendMessage stale session detected (ret:-2 + unknown error)', { userId });
        if (userId) {
          this.nextSendTime.set(userId, Date.now() + WeChatApi.STALE_SESSION_PAUSE_MS);
        }
        throw new Error('stale session — user must send a message to refresh context_token');
      }

      // Outbound quota exhausted. This is a *quota*, not a rate limit: the
      // budget does not refill with time, only with a new message from the
      // user. Retrying here is therefore pointless — the request cannot
      // succeed no matter how long we wait — and it escalates the penalty
      // rather than clearing it. So: trip the breaker, and stop. The sender
      // keeps the message queued and delivers it when the user next speaks.
      this._tripCircuit();
      if (userId) {
        this.nextSendTime.set(userId, Date.now() + WeChatApi.RATE_LIMIT_COOLDOWN_MS);
      }
      throw new Error('circuit breaker open: outbound quota exhausted (ret:-2)');
    }

    // Successful send — clear the consecutive-trip counter so the next
    // rate-limit incident starts fresh at 30s instead of an escalated
    // value left over from a previously-resolved incident.
    this._recordSendSuccess();
  }


  // ── Circuit breaker helpers ────────────────────────────────────────────

  /** True while the breaker is open (sends should fail fast). */
  private _isCircuitOpen(): boolean {
    if (this._circuitUntil === 0) return false;
    if (Date.now() >= this._circuitUntil) {
      // Cooldown elapsed — half-open: allow a probe send. If it succeeds,
      // _tripCount is reset. If it fails, _tripCircuit() will escalate.
      this._circuitUntil = 0;
      this._rateLimitEvents.length = 0;
      return false;
    }
    return true;
  }

  /** Record a rate-limit event and open the breaker if threshold is met. */
  private _tripCircuit(): void {
    const now = Date.now();
    const windowStart = now - WeChatApi.CIRCUIT_WINDOW_MS;
    while (this._rateLimitEvents.length > 0 && this._rateLimitEvents[0] < windowStart) {
      this._rateLimitEvents.shift();
    }
    this._rateLimitEvents.push(now);
    if (this._rateLimitEvents.length >= WeChatApi.CIRCUIT_THRESHOLD) {
      // Exponential backoff: 30s → 60s → 120s → 240s → 300s (cap).
      // Each consecutive trip without a successful probe doubles the wait,
      // so a sustained iLink rate-limit doesn't bounce us every 30s.
      this._circuitTripCount += 1;
      const backoffMs = Math.min(
        WeChatApi.CIRCUIT_OPEN_MS * Math.pow(2, this._circuitTripCount - 1),
        WeChatApi.CIRCUIT_MAX_OPEN_MS,
      );
      const openUntil = Math.max(this._circuitUntil, now + backoffMs);
      if (openUntil > this._circuitUntil) {
        logger.warn('Circuit breaker tripped', {
          events: this._rateLimitEvents.length,
          openMs: backoffMs,
          tripCount: this._circuitTripCount,
        });
      }
      this._circuitUntil = openUntil;
    }
  }

  /**
   * Called after a successful sendMessage. Resets the consecutive-trip counter
   * so the next rate-limit window starts fresh at 30s instead of the escalated
   * value left over from the previous incident.
   */
  private _recordSendSuccess(): void {
    if (this._circuitTripCount > 0) {
      logger.debug('Circuit breaker reset after successful probe', {
        previousTripCount: this._circuitTripCount,
      });
      this._circuitTripCount = 0;
    }
  }

  /**
   * Milliseconds until the circuit breaker is expected to close. Returns 0
   * if the breaker is currently closed (or has never tripped).
   *
   * Since the breaker stopped being a retry schedule, this is reporting only:
   * it says how long the current penalty lasts, and nothing waits on it.
   */
  getCircuitRetryDelay(): number {
    if (this._circuitUntil === 0) return 0;
    return Math.max(0, this._circuitUntil - Date.now());
  }

  /**
   * Close the breaker and clear the per-user cooldown.
   *
   * A message from the user refills their outbound quota, so a breaker that
   * opened because the quota ran out is describing a condition that no longer
   * holds. Waiting it out was the wrong model — the budget does not refill
   * with time — so the correct trigger for closing it is the user speaking.
   *
   * The escalation counter resets too: the next turn's budget is a fresh
   * budget and must not inherit the previous one's penalty.
   */
  resetCircuit(userId?: string): void {
    if (this._circuitUntil !== 0 || this._circuitTripCount !== 0) {
      logger.info('Circuit breaker reset', {
        previousTripCount: this._circuitTripCount,
        scope: userId ?? 'all',
      });
    }
    this._circuitUntil = 0;
    this._rateLimitEvents.length = 0;
    this._circuitTripCount = 0;

    if (userId) {
      // Drop the stale 30s penalty. The 2.5s pacing is not stored here —
      // it is re-derived from this timestamp on the next send — so removing
      // the entry removes the penalty and nothing else.
      this.nextSendTime.delete(userId);
    } else {
      this.nextSendTime.clear();
    }
  }

  /** True while the breaker is open. */
  isCircuitOpen(): boolean {
    return this._isCircuitOpen();
  }

  async getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.request<GetConfigResp>(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      10_000,
    );
  }

  /** Send a typing indicator to a user. */
  async sendTyping(req: SendTypingReq): Promise<void> {
    await this.request('ilink/bot/sendtyping', req, 10_000);
  }

  /** Get a presigned upload URL for media files. */
  async getUploadUrl(req: import('./types.js').GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.request<GetUploadUrlResp>('ilink/bot/getuploadurl', req);
  }
}

/**
 * True for send failures that waiting cannot fix.
 *
 * Both of these need a *new message from the user* before anything can go
 * out: an exhausted quota refills only when the user speaks, and a stale
 * session token is replaced only when the user speaks. The sender treats
 * them the same way — stop, keep the message queued, and wait for the user.
 */
export function isSendHaltError(message: string): boolean {
  return message.includes('circuit breaker') || message.includes('stale session');
}
