/**
 * Session watch — "tell me when this Claude Code session finishes its turn".
 *
 * The bridge answers WeChat, but the work the user cares about may be
 * running somewhere else: a Claude Code session in a terminal, a long
 * agent task, a job started last night. The user wants a ping when that
 * session is done, not another WeChat conversation to babysit.
 *
 * The only durable signal a Claude Code session leaves behind is its
 * transcript — one JSONL line per event under
 * `~/.claude/projects/<project>/<sessionId>.jsonl`. Two shapes matter:
 *
 *   - `type: "user"`    — the person (or a queued prompt) spoke.
 *   - `type: "assistant"` — Claude replied. `message.stop_reason` says
 *     whether the turn is over: `tool_use` means it is still working,
 *     `end_turn` means it produced its final answer.
 *
 * A tool result also arrives as a `type: "user"` entry, but it is the
 * *tool* talking, not the person — the turn is still running. Treating it
 * as a prompt would make the watch fire on the wrong boundary.
 *
 * At most one session is watched at a time. Registering a new one
 * replaces the old: the user is pointing the watch at whatever they are
 * waiting for now, and a second silent watch would just be a way to
 * forget about the first.
 */

import { openSync, readSync, closeSync, fstatSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../constants.js';
import { claudeProjectsDir } from '../paths.js';
import { loadJson, saveJson } from '../store.js';
import { logger } from '../logger.js';

/**
 * How much of the transcript's tail to read when working out whether the
 * session is busy. Big enough to cover the last few turns even for a
 * long agent run, small enough that registration stays instant.
 */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** How often the watcher's poll runs. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * Stop reasons that mean the assistant produced its final answer and the
 * turn is over.
 *
 * `tool_use` is deliberately absent: it means the turn continues. So does
 * `pause_turn` — the model is yielding control, not finishing.
 */
const FINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence']);

/** A single meaningful line of a transcript. */
export type TranscriptEvent =
  | { kind: 'user_prompt'; timestamp: number }
  | {
      kind: 'assistant';
      stopReason: string;
      text: string;
      messageId: string;
      timestamp: number;
    };

/**
 * Parse one transcript line.
 *
 * Returns null for everything that is not a turn boundary: metadata
 * entries (`last-prompt`, `mode`, `attachment`, …), unparseable lines,
 * and subagent turns — a subagent's conversation is recorded in the same
 * file but is a different conversation, and its final answer says nothing
 * about whether the session being watched is done.
 */
export function parseTranscriptLine(line: string): TranscriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.isSidechain === true) return null;

  const timestamp = typeof obj.timestamp === 'string'
    ? Date.parse(obj.timestamp)
    : Date.now();

  if (obj.type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') {
      return content.trim() ? { kind: 'user_prompt', timestamp } : null;
    }
    if (!Array.isArray(content)) return null;
    // A tool result is a user entry too. It is the tool reporting back —
    // the turn is still running, so it is not a prompt boundary.
    if (content.some((b: any) => b?.type === 'tool_result')) return null;
    const text = content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('')
      .trim();
    return text ? { kind: 'user_prompt', timestamp } : null;
  }

  if (obj.type === 'assistant') {
    const message = obj.message ?? {};
    const content = message.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text ?? '')
        .join('');
    } else if (typeof content === 'string') {
      text = content;
    }
    return {
      kind: 'assistant',
      stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : '',
      text,
      messageId: typeof message.id === 'string' ? message.id : String(obj.uuid ?? ''),
      timestamp,
    };
  }

  return null;
}

/** The events in a set of transcript lines, in order. */
export function parseTranscriptLines(lines: string[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of lines) {
    const event = parseTranscriptLine(line);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Whether the session is idle — its last meaningful event is a final
 * answer, so nothing is running.
 */
export function isIdleTranscript(lines: string[]): boolean {
  const events = parseTranscriptLines(lines);
  const last = events[events.length - 1];
  if (!last) return true;
  if (last.kind !== 'assistant') return false;
  return FINAL_STOP_REASONS.has(last.stopReason);
}

/**
 * Read the tail of a transcript.
 *
 * Returns the complete lines in the window plus the offset of the first
 * byte after the last newline, so a follow-up read can continue from
 * there without re-reading (or missing) anything.
 *
 * A window that starts mid-line yields a first line that cannot be
 * parsed on its own; it is dropped. The offset still advances past it.
 */
export function readTranscriptTail(
  transcriptPath: string,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): { lines: string[]; alignedOffset: number } | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { lines: [], alignedOffset: 0 };

    const length = Math.min(maxBytes, size);
    const tailStart = size - length;
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, tailStart);
    if (read <= 0) return { lines: [], alignedOffset: tailStart };

    // Byte offsets, not character offsets — the tail may end mid-character
    // and a character index would drift on multi-byte text.
    const lastNl = buf.lastIndexOf(0x0a, read - 1);
    if (lastNl === -1) return { lines: [], alignedOffset: tailStart };
    const alignedOffset = tailStart + lastNl + 1;

    let body = buf.toString('utf-8', 0, lastNl + 1);
    if (tailStart > 0) {
      // Our window began mid-line: that first line is a fragment.
      const firstNl = body.indexOf('\n');
      body = firstNl === -1 ? '' : body.slice(firstNl + 1);
    }
    const lines = body.split('\n').filter(l => l.trim());
    return { lines, alignedOffset };
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Read whole lines from `fromOffset` onwards.
 *
 * `fromOffset` is expected to be line-aligned (every writer here lands
 * right after a newline). If it is not — the file was replaced with
 * different content — the first line in the window is a fragment and is
 * dropped rather than parsed as a broken record.
 *
 * A trailing partial line — the file was written to while we were reading —
 * is left for the next poll rather than parsed half a record at a time.
 */
export function readTranscriptFrom(
  transcriptPath: string,
  fromOffset: number,
): { lines: string[]; nextOffset: number } | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= fromOffset) return { lines: [], nextOffset: fromOffset };

    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, fromOffset);
    if (read <= 0) return { lines: [], nextOffset: fromOffset };

    const lastNl = buf.lastIndexOf(0x0a, read - 1);
    if (lastNl === -1) return { lines: [], nextOffset: fromOffset };

    let body = buf.toString('utf-8', 0, lastNl + 1);
    let consumed = lastNl + 1;

    if (fromOffset > 0) {
      // Is the offset really at a line boundary?
      const prev = Buffer.alloc(1);
      const prevRead = readSync(fd, prev, 0, 1, fromOffset - 1);
      if (prevRead === 1 && prev[0] !== 0x0a) {
        const firstNl = body.indexOf('\n');
        if (firstNl === -1) return { lines: [], nextOffset: fromOffset };
        consumed = Buffer.byteLength(body.slice(0, firstNl), 'utf-8') + 1;
        body = body.slice(firstNl + 1);
      }
    }

    const lines = body.split('\n').filter(l => l.trim());
    return { lines, nextOffset: fromOffset + consumed };
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * The part of a watch that is written to disk.
 *
 * The transcript's path is deliberately not part of it: the file lives in
 * the user's Claude Code project directory, and the session may move
 * between projects. The path is resolved from the session id whenever it
 * is needed.
 */
interface PersistedWatch {
  /** Full session id (the transcript's file name). */
  sessionId: string;
  /** Who to notify. */
  toUserId: string;
  /** The context token to send the notification with. */
  contextToken: string;
  /** When the watch was registered. */
  registeredAt: number;
  /**
   * True while no prompt has been seen for the turn we are waiting for.
   *
   * A session that was busy when the watch was created is already past
   * its prompt, so this starts false. A session that was idle has not
   * started its turn yet, so it starts true.
   */
  needUserPrompt: boolean;
  /** Whether the session is working right now. */
  busy: boolean;
  /** Byte offset of the next unread byte of the transcript. */
  offset: number;
}

/** The live state of the watched session. */
export interface NotifyWatch extends PersistedWatch {
  /** Absolute path of the transcript being watched. */
  transcriptPath: string;
}

/** What `/notify-me` reports back about the current watch. */
export interface NotifyWatchStatus {
  sessionId: string;
  registeredAt: number;
  busy: boolean;
}

export interface SessionWatcherOptions {
  sender: {
    enqueue: (
      toUserId: string,
      contextToken: string,
      text: string,
      role: 'interstitial' | 'final',
    ) => void;
  };
  pollIntervalMs?: number;
  /** Where the watch is persisted. Defaults to `<data dir>/watch.json`. */
  storePath?: string;
  /**
   * Where Claude Code keeps its session transcripts.
   *
   * Defaults to `~/.claude/projects`. Overridable so the watcher's
   * restart path can be exercised without the real one.
   */
  projectsDir?: string;
}

export interface WatchRegistration {
  sessionId: string;
  /** Whether the session was working when the watch was created. */
  busy: boolean;
  /** The watch this one replaced, if any. */
  replaced?: NotifyWatch;
}

/**
 * The short form of a session id — what `/session` lists, what `/status`
 * shows, and what the watch notification names.
 *
 * One definition, so the three can never disagree about which session is
 * being talked about.
 */
export function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? sessionId.slice(0, 8) : sessionId;
}

/**
 * Find a session's transcript by its full id.
 *
 * Claude Code stores sessions under `~/.claude/projects/<project>/<id>.jsonl`,
 * where `<project>` is the working directory with its path separators
 * escaped to dashes. The project a session lives in can change — Claude
 * Code's `/cd` relocates a session mid-flight — so the location is
 * resolved from the id every time it is needed rather than remembered.
 */
export function resolveSessionTranscript(
  sessionId: string,
  projectsDir?: string,
): string | undefined {
  const root = projectsDir ?? claudeProjectsDir();
  if (!existsSync(root)) return undefined;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const projectDir of projectDirs) {
    const candidate = join(root, projectDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Watch at most one Claude Code session and report when its turn ends.
 *
 * The watch is persisted, so a daemon restart (the watchdog does it
 * constantly) does not lose it. On restart the watcher continues from the
 * byte offset it had reached, which means a turn that finished while the
 * service was down is still reported.
 */
export function createSessionWatcher(opts: SessionWatcherOptions) {
  const storePath = opts.storePath ?? join(DATA_DIR, 'watch.json');
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let watch: NotifyWatch | undefined;
  /** A persisted watch whose session could not be found on disk again. */
  let lost: NotifyWatch | undefined;
  let timer: NodeJS.Timeout | undefined;

  // Pick up where the previous daemon left off. Function declarations are
  // hoisted, so this can run before their definitions below.
  loadPersisted();

  function loadPersisted(): void {
    const data = loadJson<PersistedWatch | null>(storePath, null);
    if (!data || !data.sessionId) return;

    const base: PersistedWatch = {
      sessionId: data.sessionId,
      toUserId: data.toUserId ?? '',
      contextToken: data.contextToken ?? '',
      registeredAt: data.registeredAt ?? Date.now(),
      // Default to "still waiting for a prompt" — the conservative reading.
      needUserPrompt: data.needUserPrompt !== false,
      busy: data.busy ?? false,
      offset: data.offset ?? 0,
    };

    const transcriptPath = resolveSessionTranscript(base.sessionId, opts.projectsDir);
    if (!transcriptPath) {
      // The session is gone. Say so rather than resuming a watch that can
      // never fire — a silent watch is worse than no watch, because the
      // user believes they are covered.
      lost = { ...base, transcriptPath: '' };
      return;
    }
    watch = { ...base, transcriptPath };
  }

  function persist(): void {
    try {
      if (!watch) {
        saveJson(storePath, null);
        return;
      }
      // The transcript path is deliberately not written — see PersistedWatch.
      saveJson(storePath, {
        sessionId: watch.sessionId,
        toUserId: watch.toUserId,
        contextToken: watch.contextToken,
        registeredAt: watch.registeredAt,
        needUserPrompt: watch.needUserPrompt,
        busy: watch.busy,
        offset: watch.offset,
      });
    } catch (err) {
      logger.warn('Failed to persist session watch', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function notify(text: string, w: NotifyWatch): void {
    try {
      opts.sender.enqueue(w.toUserId, w.contextToken, text, 'final');
    } catch (err) {
      logger.error('Failed to deliver session watch notification', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function notifyComplete(w: NotifyWatch): void {
    const id = shortSessionId(w.sessionId);
    notify(
      `✅ 会话 ${id} 已完成本轮\n\n用 /session ${id} 可切换查看完整对话。`,
      w,
    );
  }

  function notifyLost(w: NotifyWatch): void {
    const id = shortSessionId(w.sessionId);
    notify(`⚠️ 被监控的会话 ${id} 已不存在，监控已结束。`, w);
  }

  /**
   * Point the watch at a session.
   *
   * Replaces whatever was watched before — only one session is watched at
   * a time, so the previous watch is dropped and reported back to the
   * caller.
   */
  function register(input: {
    sessionId: string;
    transcriptPath: string;
    toUserId: string;
    contextToken: string;
  }): WatchRegistration {
    const tail = readTranscriptTail(input.transcriptPath);
    // No transcript to read: assume the session is working, so the watch
    // waits for the next final answer rather than requiring a prompt
    // first. A missing prompt would otherwise swallow the completion.
    const busy = tail ? !isIdleTranscript(tail.lines) : true;

    const replaced = watch;
    lost = undefined;
    watch = {
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath,
      toUserId: input.toUserId,
      contextToken: input.contextToken,
      registeredAt: Date.now(),
      // A busy session is already past its prompt.
      needUserPrompt: !busy,
      busy,
      offset: tail?.alignedOffset ?? 0,
    };
    persist();
    logger.info('Session watch registered', {
      sessionId: input.sessionId,
      busy,
      replaced: replaced?.sessionId,
    });
    return { sessionId: input.sessionId, busy, replaced };
  }

  /** Stop watching. Returns the watch that was dropped, if any. */
  function cancel(): NotifyWatch | undefined {
    const dropped = watch;
    watch = undefined;
    lost = undefined;
    persist();
    if (dropped) {
      logger.info('Session watch cancelled', { sessionId: dropped.sessionId });
    }
    return dropped;
  }

  function current(): NotifyWatchStatus | undefined {
    if (!watch) return undefined;
    return {
      sessionId: watch.sessionId,
      registeredAt: watch.registeredAt,
      busy: watch.busy,
    };
  }

  /**
   * Keep the notification's context token fresh.
   *
   * The token in a queued message goes stale, and a stale token is
   * rejected by the server exactly like an exhausted quota. Every inbound
   * message carries a fresh one, so refreshing it here keeps the
   * notification deliverable when it finally fires.
   */
  function noteInbound(toUserId: string, contextToken: string): void {
    if (!watch || !contextToken) return;
    if (watch.toUserId !== toUserId) return;
    if (watch.contextToken === contextToken) return;
    watch.contextToken = contextToken;
    persist();
  }

  /**
   * Read whatever the transcript gained and decide whether the turn ended.
   *
   * Synchronous on purpose: the whole decision is a file read, and a
   * synchronous poll cannot interleave with itself.
   */
  function pollOnce(): void {
    const w = watch;
    if (!w) return;

    const result = readTranscriptFrom(w.transcriptPath, w.offset);
    if (!result) {
      // The transcript is gone — the session was deleted, or its project
      // directory was cleaned up. The watch cannot continue.
      watch = undefined;
      persist();
      logger.warn('Watched session transcript disappeared', { sessionId: w.sessionId });
      notifyLost(w);
      return;
    }

    if (result.nextOffset !== w.offset) {
      w.offset = result.nextOffset;
    }
    if (result.lines.length === 0) {
      persist();
      return;
    }

    let completed = false;
    for (const line of result.lines) {
      const event = parseTranscriptLine(line);
      if (!event) continue;

      if (event.kind === 'user_prompt') {
        w.needUserPrompt = false;
        w.busy = true;
        continue;
      }

      if (!FINAL_STOP_REASONS.has(event.stopReason)) {
        // Still working (`tool_use`, `pause_turn`, …).
        w.busy = true;
        continue;
      }

      // A final answer. It only counts as "the turn we were waiting for"
      // if we have seen its prompt — unless the session was already busy
      // when the watch was created, in which case the prompt came before
      // the watch existed and needUserPrompt was already false.
      w.busy = false;
      if (!w.needUserPrompt) {
        completed = true;
        break;
      }
    }

    persist();

    if (completed) {
      watch = undefined;
      persist();
      logger.info('Watched session finished its turn', { sessionId: w.sessionId });
      notifyComplete(w);
    }
  }

  /**
   * Begin polling.
   *
   * A persisted watch whose session has since disappeared is reported and
   * dropped — silently resuming a watch that can never fire would leave
   * the user believing they were covered.
   */
  function start(): void {
    if (lost) {
      const gone = lost;
      lost = undefined;
      persist();
      notifyLost(gone);
    }
    if (watch && !existsSync(watch.transcriptPath)) {
      const gone = watch;
      watch = undefined;
      persist();
      notifyLost(gone);
    }
    if (timer) return;
    timer = setInterval(() => {
      try {
        pollOnce();
      } catch (err) {
        logger.error('Session watch poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, pollIntervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    start,
    stop,
    register,
    cancel,
    current,
    noteInbound,
    pollOnce,
  };
}

export type SessionWatcher = ReturnType<typeof createSessionWatcher>;
