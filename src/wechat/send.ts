import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { WeChatApi, isSendHaltError } from './api.js';
import { MessageItemType, MessageType, MessageState, TypingStatus, type MessageItem, type OutboundMessage } from './types.js';
import { uploadFile } from './upload.js';
import { logger } from '../logger.js';
import { splitMessageByBytes } from './split.js';
import { OutboundQuota, withQuotaHint } from './outbound-quota.js';
import {
  writePendingSync, deletePendingSync, loadPendingByMtime,
  cleanupStaleTmpFiles, enforcePendingCap, type PendingRecord,
} from '../pending-store.js';

const TYPING_KEEPALIVE_MS = 5_000;

export interface SenderOptions {
  /**
   * Minimum gap between two sends to the same user.
   *
   * Production uses the default (2.5s). Tests set it to 0 so a queue of a
   * dozen messages drains in milliseconds instead of half a minute — the
   * pacing is a courtesy to the server, not part of the logic under test.
   */
  minSendIntervalMs?: number;
}

export function createSender(api: WeChatApi, botAccountId: string, opts: SenderOptions = {}) {
  const typingTicketCache = new Map<string, { ticket: string; fetchedAt: number }>();
  const TICKET_TTL = 24 * 60 * 60 * 1000;

  async function getTypingTicket(userId: string, contextToken?: string): Promise<string> {
    const cached = typingTicketCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < TICKET_TTL) {
      return cached.ticket;
    }
    try {
      const resp = await api.getConfig(userId, contextToken);
      if (resp.ret === 0 && resp.typing_ticket) {
        typingTicketCache.set(userId, { ticket: resp.typing_ticket, fetchedAt: Date.now() });
        return resp.typing_ticket;
      }
      logger.warn('getConfig returned no typing_ticket', { ret: resp.ret });
    } catch (err) {
      logger.warn('getConfig failed', { err: err instanceof Error ? err.message : String(err) });
    }
    return '';
  }

  /**
   * Start typing indicator with keepalive. Returns a stop function.
   * Fire-and-forget: errors are logged but not thrown.
   */
  function startTyping(toUserId: string, contextToken: string): () => void {
    let cancelled = false;
    const key = userKey(toUserId);
    const cancel = () => { cancelled = true; };
    typingCancels.set(key, cancel);

    (async () => {
      const ticket = await getTypingTicket(toUserId, contextToken);
      if (!ticket || cancelled) {
        typingCancels.delete(key);
        return;
      }

      try {
        await api.sendTyping({
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        });
      } catch (err) {
        logger.debug('sendTyping start failed', { err: err instanceof Error ? err.message : String(err) });
        typingCancels.delete(key);
        return;
      }

      // Keepalive loop
      while (!cancelled) {
        await new Promise(r => setTimeout(r, TYPING_KEEPALIVE_MS));
        if (cancelled) break;
        try {
          await api.sendTyping({
            ilink_user_id: toUserId,
            typing_ticket: ticket,
            status: TypingStatus.TYPING,
          });
        } catch {
          break;
        }
      }

      // Send CANCEL to tell WeChat we're done typing
      if (!ticket) return;
      try {
        await api.sendTyping({
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: TypingStatus.CANCEL,
        });
      } catch {
        // ignore
      }
      typingCancels.delete(key);
    })();

    return cancel;
  }

  /**
   * Cancel the typing keepalive loop for this user. Called by /stop and by
   * the turn-end cleanup so we can stop typing without holding the closure
   * externally. Idempotent — multiple calls are safe.
   */
  function stopTyping(toUserId: string, contextToken: string): void {
    const key = userKey(toUserId);
    const cancel = typingCancels.get(key);
    if (cancel) {
      cancel();
      // typingCancels.delete is handled inside startTyping's async loop
      // when it sees cancelled=true. Don't delete here to avoid racing the
      // CANCEL send.
    }
  }

  // ── Per-user send buffer ─────────────────────────────────────────────────
  // Replaces main.ts's flushChain + pendingRetry + retryTimer + terminal
  // retry loop. Owns the actual sendMessage cadence; emitText is fire-and-
  // forget through enqueue. circuit breaker state lives in api.ts; this
  // layer only consults it via getCircuitRetryDelay().

  // Discriminated union so the worker can dispatch text and file sends the
  // same way: pop, send-or-throw, unshift on failure. A single per-user
  // queue keeps ordering predictable across interleaved text/file items.
  //
  // Each text chunk has its own uuid → its own clientId → its own persistent
  // record. iLink dedups by clientId, so retries of the same chunk (same
  // clientId across attempts) only deliver once to the user.
  type TextQueueItem = {
    kind: 'text';
    uuid: string;
    toUserId: string;
    contextToken: string;
    text: string;
    role: 'interstitial' | 'final';
    enqueuedAt: number;
  };
  type FileQueueItem = {
    kind: 'file';
    uuid: string;
    toUserId: string;
    contextToken: string;
    filePath: string;
    enqueuedAt: number;
  };
  type QueueItem = TextQueueItem | FileQueueItem;

  const queues = new Map<string, QueueItem[]>();
  const workers = new Map<string, Promise<void>>();
  const lastSentTimeMap = new Map<string, number>();
  // Per-user typing cancel callbacks. startTyping registers its cancel here
  // so /stop and turn-end cleanup can cancel without holding the closure.
  const typingCancels = new Map<string, () => void>();

  /**
   * The user's outbound budget for the current turn.
   *
   * iLink allows 10 outbound messages per inbound message, and the budget
   * refills only when the user writes again. See `outbound-quota.ts`.
   */
  const quota = new OutboundQuota();

  /**
   * Queue key for a user.
   *
   * Keyed by the user alone, not by (user, contextToken). Every inbound
   * message carries a fresh contextToken, so keying by the token split one
   * person's backlog across a new queue per message: the backlog of one turn
   * was invisible to the next, and each turn got its own worker hammering
   * the same budget in parallel. The contextToken is still carried per item
   * — and refreshed when the user writes — it just no longer decides which
   * queue a message belongs to.
   */
  function userKey(toUserId: string): string {
    return toUserId;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Drop all queued items for this user. Worker keeps running until it next
   * finds the queue empty, then exits. Items already shifted out (in flight)
   * are not cancelled — they go through. Used by /stop.
   */
  function clearQueue(toUserId: string, contextToken: string): number {
    const key = userKey(toUserId);
    const queue = queues.get(key);
    if (!queue) return 0;
    const dropped = queue.length;
    queue.length = 0;
    logger.info('sender queue cleared', { key, dropped });
    return dropped;
  }

  function getLastSentTime(toUserId: string, contextToken: string): number {
    return lastSentTimeMap.get(userKey(toUserId)) ?? 0;
  }

  /** Messages still queued for this user, waiting on budget or on the worker. */
  function pendingCount(toUserId: string): number {
    return queues.get(userKey(toUserId))?.length ?? 0;
  }

  /**
   * A message arrived from the user.
   *
   * Three things follow from that, and all three are the same fact seen from
   * different sides: the user's outbound budget was refilled by their
   * message. So the counter restarts, the circuit breaker closes (the
   * condition that opened it no longer holds), and whatever is still queued
   * from the previous turn is now sendable again.
   *
   * Queued messages are also re-stamped with the new contextToken. The one
   * they carry may have gone stale while they waited, and a stale token
   * makes the server reject the send — the same `ret:-2` an exhausted quota
   * produces, so the two are indistinguishable at the send site.
   */
  function noteInbound(toUserId: string, contextToken: string): void {
    quota.reset(toUserId);
    api.resetCircuit(toUserId);

    const key = userKey(toUserId);
    const queue = queues.get(key);
    if (!queue || queue.length === 0) return;

    for (const item of queue) {
      if (item.contextToken === contextToken) continue;
      item.contextToken = contextToken;
      // Keep the on-disk copy in step, so a crash before this message goes
      // out does not resurrect the stale token.
      try {
        const record: PendingRecord = item.kind === 'text'
          ? {
              uuid: item.uuid, kind: 'text', toUserId: item.toUserId,
              contextToken, text: item.text, role: item.role, enqueuedAt: item.enqueuedAt,
            }
          : {
              uuid: item.uuid, kind: 'file', toUserId: item.toUserId,
              contextToken, filePath: item.filePath, enqueuedAt: item.enqueuedAt,
            };
        writePendingSync(botAccountId, record);
      } catch (err) {
        logger.warn('Failed to refresh pending record context token', {
          uuid: item.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('sender: re-driving queued messages after user message', {
      toUserId, queued: queue.length,
    });
    ensureWorker(key);
  }

  /**
   * Enqueue text by splitting it into <=4000-char chunks and treating each
   * chunk as an independent unit with its own uuid. Each chunk is written
   * to disk atomically BEFORE being pushed onto the in-memory queue, so a
   * process crash can never lose a chunk that the worker hasn't yet tried
   * to send. The persistent record survives restart via restorePending().
   */
  function enqueue(toUserId: string, contextToken: string, text: string, role: 'interstitial' | 'final'): void {
    enqueueWith(toUserId, contextToken, text, role, false);
  }

  /**
   * Enqueue a message ahead of whatever is already queued for this user.
   *
   * The queue is per user, so a command's reply would otherwise sit behind
   * the previous turn's leftovers — and a backlog can be large enough to
   * consume the whole turn's budget, which would make the reply
   * undeliverable. Priority messages jump the backlog.
   */
  function enqueuePriority(toUserId: string, contextToken: string, text: string, role: 'interstitial' | 'final'): void {
    enqueueWith(toUserId, contextToken, text, role, true);
  }

  function enqueueWith(
    toUserId: string,
    contextToken: string,
    text: string,
    role: 'interstitial' | 'final',
    priority: boolean,
  ): void {
    if (!text.trim()) return;
    // Split by characters *and* by UTF-8 bytes. The server's limit is on
    // bytes, and 4000 characters of Chinese or emoji can cross it — a chunk
    // that does is rejected with the same `ret:-2` that an exhausted quota
    // produces, so the two are indistinguishable at the send site.
    const chunks = splitMessageByBytes(text);
    const key = userKey(toUserId);
    const items: QueueItem[] = [];
    for (const chunkText of chunks) {
      const uuid = randomUUID();
      const item: TextQueueItem = {
        kind: 'text', uuid, toUserId, contextToken,
        text: chunkText, role, enqueuedAt: Date.now(),
      };
      // Atomic write first — if disk fails, do NOT push to in-memory queue,
      // because a chunk that isn't on disk would be lost on crash and would
      // also fail to be cleaned up by deletePendingSync later.
      try {
        const record: PendingRecord = {
          uuid, kind: 'text', toUserId, contextToken,
          text: chunkText, role, enqueuedAt: item.enqueuedAt,
        };
        writePendingSync(botAccountId, record);
        enforcePendingCap(botAccountId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to persist text chunk, dropping', {
          uuid, error: msg,
        });
        continue;
      }
      items.push(item);
    }
    if (priority) {
      pushItemsFront(key, items);
    } else {
      for (const item of items) pushItem(key, item);
    }
  }

  /**
   * Queue a file for delivery through the same per-user worker. Files share
   * the per-user queue so they pace against text messages (MIN_SEND_INTERVAL)
   * and respect the circuit breaker without any caller-side coordination.
   * Same atomic-write-then-push ordering as enqueue().
   */
  function enqueueFile(toUserId: string, contextToken: string, filePath: string): void {
    if (!filePath.trim()) return;
    const uuid = randomUUID();
    const item: FileQueueItem = {
      kind: 'file', uuid, toUserId, contextToken,
      filePath, enqueuedAt: Date.now(),
    };
    try {
      const record: PendingRecord = {
        uuid, kind: 'file', toUserId, contextToken,
        filePath, enqueuedAt: item.enqueuedAt,
      };
      writePendingSync(botAccountId, record);
      enforcePendingCap(botAccountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to persist file, dropping', {
        uuid, error: msg,
      });
      return;
    }
    pushItem(userKey(toUserId), item);
  }

  /**
   * Restore persisted chunks from disk onto the per-user queues. Called
   * once at daemon startup after createSender(). Order matches enqueuedAt
   * ascending so chunks delivered to users in the right sequence.
   *
   * The records are already on disk from before the crash; we re-push them
   * onto the in-memory queue (which starts a worker if none is running).
   * Each chunk is sent with the same clientId it had before (`wcc-${uuid}`),
   * so iLink's clientId dedup keeps the user from seeing duplicates.
   */
  function restorePending(): number {
    cleanupStaleTmpFiles(botAccountId);
    const records = loadPendingByMtime(botAccountId);
    if (records.length === 0) return 0;

    logger.info('Restoring pending records from disk', {
      count: records.length,
    });
    for (const r of records) {
      const key = userKey(r.toUserId);
      if (r.kind === 'text') {
        const item: TextQueueItem = {
          kind: 'text', uuid: r.uuid,
          toUserId: r.toUserId, contextToken: r.contextToken,
          text: r.text ?? '',
          role: r.role ?? 'final',
          enqueuedAt: r.enqueuedAt,
        };
        pushItem(key, item);
      } else {
        const item: FileQueueItem = {
          kind: 'file', uuid: r.uuid,
          toUserId: r.toUserId, contextToken: r.contextToken,
          filePath: r.filePath ?? '',
          enqueuedAt: r.enqueuedAt,
        };
        pushItem(key, item);
      }
    }
    return records.length;
  }

  function pushItem(key: string, item: QueueItem): void {
    let queue = queues.get(key);
    if (!queue) { queue = []; queues.set(key, queue); }
    queue.push(item);
    ensureWorker(key);
    // Observability: how much we're queuing while the budget is spent.
    if (api.getCircuitRetryDelay() > 0) {
      logger.debug('enqueued during circuit open', { key, queueLength: queue.length });
    }
  }

  /**
   * Put items at the head of the queue, preserving their relative order.
   *
   * `unshift` reverses, so a multi-chunk priority message would arrive
   * backwards. Unshift in reverse to compensate.
   */
  function pushItemsFront(key: string, items: QueueItem[]): void {
    if (items.length === 0) return;
    let queue = queues.get(key);
    if (!queue) { queue = []; queues.set(key, queue); }
    for (let i = items.length - 1; i >= 0; i--) {
      queue.unshift(items[i]);
    }
    ensureWorker(key);
  }

  /**
   * Start the worker for this key if one is not already running.
   *
   * The worker deletes itself from `workers` when it stops — on an empty
   * queue, or when it halts waiting for the user. That is what lets a
   * later message re-drive a queue that is still full.
   */
  function ensureWorker(key: string): void {
    if (workers.has(key)) return;
    const p = workerLoop(key).catch((err) => {
      logger.error('sender worker crashed, queue may be stranded', {
        key,
        queueLength: queues.get(key)?.length ?? 0,
        error: err instanceof Error ? err.message : String(err),
      });
      // Only clear the registration if it is still ours — a newer worker may
      // have taken over this key while this one was unwinding.
      if (workers.get(key) === p) workers.delete(key);
      // Do NOT auto-restart: an unexpected crash is likely a code bug, not
      // a transient failure. The next enqueue() will start a fresh worker
      // that drains whatever is left in `queues`.
    });
    workers.set(key, p);
  }

  async function workerLoop(key: string): Promise<void> {
    while (true) {
      const queue = queues.get(key);
      if (!queue || queue.length === 0) {
        workers.delete(key);
        return;
      }

      // The turn's outbound budget is spent. Waiting cannot refill it —
      // only a new message from the user can — so stop here rather than
      // burning requests against a server that will reject them all. The
      // message stays at the head of the queue and on disk, and goes out
      // when the user next writes.
      const head = queue[0];
      if (quota.exhausted(head.toUserId)) {
        logger.info('sender worker paused: outbound budget spent for this turn', {
          key, queued: queue.length, used: quota.usedFor(head.toUserId),
        });
        workers.delete(key);
        return;
      }

      // Per-user send pacing. api.sendMessage also paces internally via
      // nextSendTime (MIN_SEND_INTERVAL), but checking here too avoids
      // burning a retry-iteration on a request we know will just wait.
      const lastSent = lastSentTimeMap.get(key) ?? 0;
      const sinceLast = Date.now() - lastSent;
      if (sinceLast < MIN_SEND_INTERVAL_MS) {
        const wait = MIN_SEND_INTERVAL_MS - sinceLast;
        await sleep(wait);
        continue;
      }
      const item = queue.shift()!;
      try {
        // The slot this send will occupy, computed before the send so the
        // last message of the budget can carry the "reply /continue" hint.
        const slot = quota.nextSlot(item.toUserId);
        if (item.kind === 'text') {
          await sendChunk(item, slot);
        } else {
          await sendFileRaw(item);
        }
        // Charged only on success: a message that never reached the user
        // did not spend any of their budget.
        quota.consume(item.toUserId);
        // ★ Success: delete the persistent record so restart won't re-send.
        try {
          deletePendingSync(botAccountId, item.uuid);
        } catch (err) {
          logger.warn('Failed to delete pending record after success', {
            uuid: item.uuid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        lastSentTimeMap.set(key, Date.now());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // A failure that waiting cannot fix. An exhausted quota refills only
        // when the user writes, and a stale session token is replaced only
        // when the user writes. Retrying would be retrying a request that
        // cannot succeed, and each attempt spends more of a budget that is
        // already gone. Stop instead: the message stays at the head of the
        // queue and on disk, and goes out when the user next writes.
        if (isSendHaltError(msg)) {
          queue.unshift(item);
          logger.warn('sender worker halted: cannot succeed until the user writes', {
            key, kind: item.kind, uuid: item.uuid, error: msg,
          });
          workers.delete(key);
          return;
        }

        // Ordinary failure (network blip, 5xx): the persistent record was
        // already written at enqueue time, so the chunk survives any further
        // crashes untouched. Put the item back at the head to preserve
        // order, wait, retry.
        queue.unshift(item);
        logger.warn('sender worker send failed, will retry', {
          key, kind: item.kind, uuid: item.uuid, error: msg, backoffMs: 3000,
        });
        await sleep(3000);
      }
    }
  }

  // Mirror WeChatApi.MIN_SEND_INTERVAL — duplicated instead of imported so
  // the worker can pace sends without a circular dep on the API instance.
  const MIN_SEND_INTERVAL_MS = opts.minSendIntervalMs ?? 2500;

  /**
   * Send a single text chunk. The chunk is already <=4000 chars by the
   * split in enqueue(); this just calls the API with a stable clientId
   * derived from the chunk's uuid. iLink dedups by clientId, so any retry
   * (network timeout, circuit breaker, etc.) hits the same clientId and
   * the user sees the message exactly once.
   *
   * `slot` is the position this send takes in the turn's budget. When it is
   * the last one, the message carries the hint that tells the user how to
   * get the rest — free, because it rides on a message that was going out
   * anyway.
   */
  async function sendChunk(item: TextQueueItem, slot: number): Promise<void> {
    const clientId = `wcc-${item.uuid}`;
    const text = withQuotaHint(item.text, slot, quota.budget);
    await sendTextRaw(item.toUserId, item.contextToken, text, clientId);
  }

  /**
   * Send a single file item through the upload + sendMessage pipeline.
   * File-not-found and upload errors are handled by sendFileImpl — the
   * worker just sees the throw and re-enqueues (record stays on disk).
   */
  async function sendFileRaw(item: FileQueueItem): Promise<void> {
    await sendFileImpl(item.toUserId, item.contextToken, item.filePath, item.uuid);
  }

  /** Low-level sendText — no queueing, no retry, direct API call. */
  async function sendTextRaw(toUserId: string, contextToken: string, text: string, clientId: string): Promise<void> {
    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    await api.sendMessage({ msg });
    logger.info('Text message sent', { toUserId, clientId });
  }

  /**
   * Public sendText — direct API call, no queueing. Kept exported for
   * legacy callers and as a fallback when the queue isn't desired (rare).
   *
   * All new code paths should use `enqueue()` instead so rate-limit and
   * circuit-breaker handling stay centralized in the worker.
   */
  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    return sendTextRaw(toUserId, contextToken, text, `wcc-legacy-${Date.now()}`);
  }

  /**
   * Internal file-send implementation called by the per-user worker for each
   * kind:'file' queue item. Error paths go through enqueue() so the user-
   * facing "文件不存在 / 发送失败" messages themselves respect circuit
   * breaker + pacing — no caller-side coordination needed.
   *
   * The file item's uuid is the clientId, so iLink dedups retries too.
   */
  async function sendFileImpl(toUserId: string, contextToken: string, filePath: string, uuid: string): Promise<void> {
    const resolved = resolve(filePath.replace(/^~/, process.env.HOME || ''));
    if (!existsSync(resolved)) {
      enqueue(toUserId, contextToken, `文件不存在: ${resolved}`, 'final');
      return;
    }

    try {
      const media = await uploadFile(api, toUserId, resolved);
      const clientId = `wcc-${uuid}`;

      // Convert aesKeyHex to base64: treat hex string as UTF-8, then base64 encode
      // (matches OpenClaw's format: Buffer.from(hexString).toString("base64"))
      const aesKeyBase64 = Buffer.from(media.aesKeyHex).toString('base64');

      let item: MessageItem;
      if (media.mediaType === 'image') {
        item = {
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: media.encryptQueryParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: media.fileSize,
          },
        };
      } else {
        item = {
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: media.encryptQueryParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: media.fileName,
            len: String(media.rawSize),
          },
        };
      }

      const msg: OutboundMessage = {
        from_user_id: botAccountId,
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [item],
      };

      logger.info('Sending file message', { toUserId, clientId, fileName: media.fileName, mediaType: media.mediaType });
      await api.sendMessage({ msg });
      logger.info('File message sent', { toUserId, clientId, fileName: media.fileName, mediaType: media.mediaType });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to send file', { filePath: resolved, error: msg });
      // Don't tell the user about a failure we cannot even report: when the
      // budget is spent or the session token is stale, the notice itself
      // would be rejected the same way the file was.
      if (!msg.includes('rate-limited') && !isSendHaltError(msg)) {
        enqueue(toUserId, contextToken, `发送文件失败: ${msg}`, 'final');
      }
      throw err;
    }
  }

  return {
    sendText,
    startTyping,
    stopTyping,
    enqueue,
    enqueuePriority,
    enqueueFile,
    clearQueue,
    getLastSentTime,
    pendingCount,
    noteInbound,
    restorePending,
  };
}