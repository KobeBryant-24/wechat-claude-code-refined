import { WeChatApi } from './api.js';
import { loadSyncBuf, saveSyncBuf } from './sync-buf.js';
import { logger } from '../logger.js';
import { loadJson, saveJson } from '../store.js';
import { DATA_DIR } from '../constants.js';
import { join } from 'node:path';
import type { MessageItem, WeixinMessage } from './types.js';

const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_EXPIRED_PAUSE_MS = 60 * 60 * 1000; // 1 hour
const BACKOFF_THRESHOLD = 3;
const BACKOFF_LONG_MS = 30_000;
const BACKOFF_SHORT_MS = 3_000;
const RECENT_PATH = join(DATA_DIR, 'monitor-recent.json');
// Two-layer dedup against iLink's habit of re-delivering the same
// message_id across successive polls when its ack mechanism hiccups.
// message_id is the primary key (survives across restarts via disk).
// text-key catches re-deliveries with a NEW message_id but the same body,
// which happens when the user types the same thing twice within seconds
// (e.g. retrying after they think it didn't go through).
const TEXT_DEDUP_WINDOW_MS = 10_000;
const MAX_RECENT_IDS = 2000;

interface RecentEntry {
  id: number;
  text: string;
  ts: number;
}
type RecentStore = RecentEntry[];

export interface MonitorCallbacks {
  onMessage: (msg: WeixinMessage) => Promise<void>;
  onSessionExpired: () => void;
}

export function createMonitor(api: WeChatApi, callbacks: MonitorCallbacks) {
  const controller = new AbortController();
  let stopped = false;
  const recent: RecentEntry[] = loadJson<RecentStore>(RECENT_PATH, []);
  const recentIds = new Set<number>(recent.map((r) => r.id));
  let dirty = false;
  let saveTimer: NodeJS.Timeout | null = null;

  function persistSoon(): void {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        saveJson(RECENT_PATH, recent);
      } catch (err) {
        logger.warn('Failed to persist recent-msg cache', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 50);
  }

  function rememberMessage(msg: WeixinMessage): void {
    if (!msg.message_id) return;
    const text = extractTextFromItemsLocal(msg.item_list ?? []);
    const now = Date.now();
    // Drop entries older than 1 hour. iLink has been observed to
    // re-deliver the same message after 13 seconds (and we've seen it
    // repeat across the 60s mark too), so 1h gives comfortable margin
    // while bounding memory. Capacity cap is the hard limit if volume
    // exceeds that.
    while (recent.length > 0 && now - recent[0]!.ts > 60 * 60_000) {
      const dropped = recent.shift()!;
      recentIds.delete(dropped.id);
    }
    while (recent.length >= MAX_RECENT_IDS) {
      const dropped = recent.shift()!;
      recentIds.delete(dropped.id);
    }
    recent.push({ id: msg.message_id, text, ts: now });
    recentIds.add(msg.message_id);
    persistSoon();
  }

  function isDuplicate(msg: WeixinMessage): boolean {
    if (msg.message_id && recentIds.has(msg.message_id)) return true;
    const text = extractTextFromItemsLocal(msg.item_list ?? []);
    if (!text) return false;
    const now = Date.now();
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i]!;
      if (now - r.ts > TEXT_DEDUP_WINDOW_MS) break;
      if (r.text === text) return true;
    }
    return false;
  }

  async function run(): Promise<void> {
    let consecutiveFailures = 0;

    while (!controller.signal.aborted) {
      try {
        const buf = loadSyncBuf();
        logger.debug('Polling for messages', { hasBuf: buf.length > 0 });

        const resp = await api.getUpdates(buf || undefined);

        if (resp.ret === SESSION_EXPIRED_ERRCODE) {
          logger.warn('Session expired, pausing for 1 hour');
          callbacks.onSessionExpired();
          await sleep(SESSION_EXPIRED_PAUSE_MS, controller.signal);
          consecutiveFailures = 0;
          continue;
        }

        if (resp.ret !== undefined && resp.ret !== 0) {
          logger.warn('getUpdates returned error', { ret: resp.ret, retmsg: resp.retmsg });
        }

        // Save the new sync buffer regardless of ret
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
        }

        // Process messages (with deduplication)
        const messages = resp.msgs ?? [];
        if (messages.length > 0) {
          logger.info('Received messages', { count: messages.length });
          for (const msg of messages) {
            // DIAG: log every message arrival with dedup state
            logger.info('DIAG_DEDUP_CHECK', {
              message_id: msg.message_id,
              message_id_type: typeof msg.message_id,
              recentIds_size: recentIds.size,
              recent_size: recent.length,
              recentIds_has: msg.message_id ? recentIds.has(msg.message_id) : null,
              recentIds_first_5: Array.from(recentIds).slice(0, 5),
            });
            // Two-layer dedup: by message_id (persistent across restarts)
            // and by (text + 5s window) to catch re-deliveries with new
            // message_ids but identical body. iLink's ack mechanism is
            // unreliable — we see the same message reappear across
            // successive polls even after the wrapper fully restarted.
            if (isDuplicate(msg)) {
              logger.info('DIAG_DEDUP_HIT', { message_id: msg.message_id });
              logger.debug('Skipping duplicate message', { message_id: msg.message_id });
              continue;
            }
            rememberMessage(msg);
            // Fire-and-forget: don't block the polling loop on message processing
            // This allows permission responses (y/n) to be received while a query is running
            callbacks.onMessage(msg).catch((err) => {
              const msg2 = err instanceof Error ? err.message : String(err);
              logger.error('Error processing message', { error: msg2, messageId: msg.message_id });
            });
          }
        }

        consecutiveFailures = 0;
      } catch (err) {
        if (controller.signal.aborted) {
          break;
        }

        consecutiveFailures++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Monitor error', { error: errorMsg, consecutiveFailures });

        const backoff = consecutiveFailures >= BACKOFF_THRESHOLD ? BACKOFF_LONG_MS : BACKOFF_SHORT_MS;
        logger.info(`Backing off ${backoff}ms`, { consecutiveFailures });
        await sleep(backoff, controller.signal);
      }
    }

    stopped = true;
    logger.info('Monitor stopped');
  }

  function stop(): void {
    if (!controller.signal.aborted) {
      logger.info('Stopping monitor...');
      controller.abort();
    }
  }

  return { run, stop };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// Local copy of text extraction (kept in sync with main.ts). Duplicated
// rather than shared because pulling it out into its own module would
// require touching every caller in main.ts. The behavior we need is
// trivial: concatenate text_item.text fields.
function extractTextFromItemsLocal(items: readonly MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.text_item?.text) {
      parts.push(item.text_item.text);
    }
  }
  return parts.join('');
}
