import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSend, handleShow, handleSession, handleCompactMsg, handleContinue, handleStop, handleNotifyMe, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  /**
   * Service process start time (ms since epoch). Captured once at daemon
   * startup and reused across all messages so `/status` can show uptime.
   */
  startedAt: number;
  /**
   * How many messages are still queued for this user, waiting on the
   * outbound budget. Lets `/status` show what is stuck and why.
   */
  getPendingCount?: () => number;
  /**
   * The session currently being watched by `/notify-me`, if any.
   *
   * The watch lives in a service-level component, not in the session
   * record, so the caller supplies it.
   */
  getNotifyWatch?: () => { sessionId: string; registeredAt: number; busy: boolean } | undefined;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  claudePrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
  /**
   * Resume the current SDK session and let the assistant continue.
   *
   * The caller runs it — a continuation needs the sender, the session store,
   * and the abort controllers, none of which the command context carries.
   * It is deliberately *not* a `claudePrompt`: a continuation must not
   * overwrite the session's `lastUserQuery`, because that records what the
   * user actually asked.
   */
  continueSession?: boolean;
  /**
   * Deliver this reply ahead of whatever is still queued for the user.
   *
   * A command reply is the user waiting for an answer to a question they
   * just asked. If the previous turn left a backlog, the reply would be
   * queued behind it — and a backlog can be long enough to eat the whole
   * turn's budget, leaving the reply undeliverable.
   */
  priority?: boolean;
  /**
   * Register, replace, or cancel the service-level session watch.
   *
   * The caller runs it — the watch needs the sender, the transcript
   * lookup, and the persistent store, none of which the command context
   * carries.
   */
  notifyAction?:
    | { kind: 'register'; sessionId: string; transcriptPath: string }
    | { kind: 'cancel' };
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'session':
    case 'resume':
      return handleSession(ctx, args);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'compact-msg':
      return handleCompactMsg(ctx, args);
    case 'continue':
      return handleContinue(ctx, args);
    case 'stop':
      return handleStop(ctx);
    case 'notify-me':
      return handleNotifyMe(ctx, args);
    case 'send':
      return handleSend(ctx, args);
    case 'show':
      return handleShow(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}
