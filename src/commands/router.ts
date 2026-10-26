import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSend, handleUnknown } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  /**
   * How many messages are still queued for this user, waiting on the
   * outbound budget. Lets `/status` show what is stuck and why.
   */
  getPendingCount?: () => number;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  claudePrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
  /**
   * Deliver this reply ahead of whatever is still queued for the user.
   *
   * A command reply is the user waiting for an answer to a question they
   * just asked. If the previous turn left a backlog, the reply would be
   * queued behind it — and a backlog can be long enough to eat the whole
   * turn's budget, leaving the reply undeliverable.
   */
  priority?: boolean;
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
    case 'send':
      return handleSend(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}
