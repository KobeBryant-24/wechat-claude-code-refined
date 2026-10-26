import { loadJson, saveJson, validateAccountId } from './store.js';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DEFAULT_WORKING_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type SessionState = 'idle' | 'processing';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  sdkSessionId?: string;
  previousSdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
  /**
   * Snapshot of the most recent `/session` listing. Lets the user switch with
   * `/session <number>` (e.g. `/session <3>`) instead of pasting a UUID.
   * Refreshed each time `/session` is invoked without args.
   */
  lastSessionList?: Array<{ id: string }>;
  /**
   * The most recent user message that was handed to sendToClaude, regardless
   * of whether the turn completed or was interrupted. Persisted forever (not
   * cleared on success) so a fresh daemon can hand it to Claude as part of
   * the startup auto-resume JSON prompt. Lets the model decide — based on the
   * full JSONL tail — whether to send the user a recovery message after a
   * redeploy/restart cycle.
   */
  lastUserQuery?: string;
  /**
   * Wall-clock timestamp (ms) of the most recent startup auto-resume
   * consultation that resulted in a `notify` (or `silent`) decision. Used to
   * suppress redundant consultations on tight restart loops: if the daemon
   * crashes and watchdog restarts it 5 times in 30s, we shouldn't run 5
   * Claude calls producing 5 potentially-duplicate "interrupted turn"
   * messages. Cooldown is 60s.
   *
   * Cleared when a new user message arrives (handleMessage path) so the next
   * restart after a fresh turn is allowed to consult again.
   */
  lastConsultedAt?: number;
  /**
   * Wall-clock timestamp (ms) when the most recent user query was dispatched
   * to `sendToClaude`. Used by the consultation safety guard to refuse
   * auto-resume when the user's message landed < 5s before the bridge died
   * (suggests the user is still actively testing / hasn't disengaged from
   * the keyboard).
   */
  lastUserQueryAt?: number;
  /**
   * Wall-clock timestamp (ms) when the singleton-lock reaper killed a
   * previous main.js during this startup. Indicates the prior instance died
   * in a way the wrapper didn't notice (SIGKILL, TerminateProcess) and the
   * bridge was already in a crash loop. Auto-resume is refused in this
   * window so we don't pile a Claude call on top of an unstable service.
   */
  lastOrphanReapAt?: number;
  /**
   * Set when a turn starts, cleared when it finishes cleanly. Survives a crash
   * because the session file is written before the SDK query starts, so a
   * fresh daemon can tell "the previous process died mid-turn" as a *fact*
   * instead of inferring it from a transcript whose last tool_use has no
   * matching tool_result.
   */
  pendingTurn?: {
    /** The user text this turn was answering (possibly truncated). */
    query: string;
    /** Wall-clock ms when the turn was dispatched. */
    startedAt: number;
  };
  /**
   * The command of the last tool_use that never received a tool_result, i.e.
   * the command the dying process was executing when it was killed. For a
   * `npm run redeploy` this is the deploy itself — which *did* run to
   * completion; it just never got to report back.
   */
  interruptedCommand?: string;
  /**
   * How many times auto-resume has fired for this session, and when it last
   * did. A deploy-triggered restart re-enters the consultation on every
   * spawn, so without a counter a misjudged decision can loop forever: fire
   * resume → agent redoes the deploy → process restarts → consult again.
   */
  autoResumeCount?: number;
  lastAutoResumeAt?: number;
  /**
   * Whether this session collects a turn's output and delivers it as one
   * unit instead of streaming it piece by piece.
   *
   * `true`  — collect, then send the messages themselves if the turn was
   *           short and quick, or a summary plus a file otherwise. Costs 2
   *           messages of the user's outbound budget no matter how much
   *           was produced.
   * `false` — stream each piece as it arrives. The turn can produce more
   *           messages than the budget allows; the overflow waits in the
   *           queue and goes out when the user writes again.
   * unset  — inherit the service-level default (off unless changed).
   *
   * Remembered per session, so `/compact-msg on` applies to the
   * conversation you are in and keeps applying to it.
   */
  compactMsg?: boolean;
}

const DEFAULT_MAX_HISTORY = 100;

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    validateAccountId(accountId);
    const session = loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: DEFAULT_WORKING_DIR,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    });

    // Backward compatibility: ensure chatHistory exists
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }

    return session;
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length before saving
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      sdkSessionId: undefined,          // explicitly clear so Object.assign removes it
      previousSdkSessionId: undefined,
      workingDirectory: currentSession?.workingDirectory ?? DEFAULT_WORKING_DIR,
      model: currentSession?.model,
      // The delivery preference survives a /clear: it is a property of the
      // channel, not of the conversation that was cleared.
      compactMsg: currentSession?.compactMsg,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
    save(accountId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    // Markdown table — WeChat renders natively. Mirrors the columns used by
    // the SDK transcript path so users get a consistent look whether the
    // listing comes from the local bridge cache or the live JSONL tail.
    const lines: string[] = [];
    lines.push('| # | 时间 | 角色 | 内容 |');
    lines.push('| --- | --- | --- | --- |');

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const num = messages.length - i; // newest = 1
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '👤 用户' : '🤖 Claude';
      // Mark slash commands so users can tell local-control actions apart
      // from regular conversation when reviewing history.
      let content = (msg.content || '').replace(/\s+/g, ' ').trim();
      if (msg.role === 'user' && content.startsWith('/')) {
        content = '⚙ ' + content;
      }
      if (content.length > 80) content = content.slice(0, 79) + '…';
      lines.push(`| ${num} | ${time} | ${role} | ${content} |`);
    }

    return lines.join('\n');
  }

  return { load, save, clear, addChatMessage, getChatHistoryText };
}
