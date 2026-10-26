/**
 * Startup context — the facts a restarting bridge knows and the transcript
 * cannot tell it.
 *
 * The motivation is a specific, reproducible failure. `npm run redeploy` is
 * `npm run build && npm run daemon:restart`, so the restart step kills the very
 * process running the deploy. That process dies before its `tool_result` is
 * written, so the transcript ends with a `tool_use` and nothing after it. To
 * the next process, that is indistinguishable from "the command never ran" —
 * so the consultation asks the model to judge, the model reads "no result" as
 * "failed", and the auto-resume redoes a deploy that already succeeded.
 *
 * This has now been misdiagnosed twice by a model that could read the entire
 * transcript. It is not a reasoning gap, it is an information gap: the
 * observer died at the moment of observation, so the observation is not in the
 * record. The fix is to stop asking the model and ask the process that was
 * actually there.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

/** How `WCC_RESTART_REASON` maps to what the bridge should assume. */
export type RestartReason =
  | 'initial_startup'
  | 'manual_restart'
  | 'clean_exit_respawn'
  | 'crash_backoff_respawn'
  | 'unknown';

const REASON_LABELS: Record<RestartReason, string> = {
  initial_startup: 'watchdog 首次拉起（之前没有本服务的进程）',
  manual_restart: 'watchdog 收到了一次显式的 POST /restart —— 有人主动重启了你',
  clean_exit_respawn: '上一个进程干净退出后 watchdog 立刻拉起了你',
  crash_backoff_respawn: '上一个进程崩溃，watchdog 退避后重新拉起了你',
  unknown: '原因未知',
};

export function parseRestartReason(raw: string | undefined): RestartReason {
  switch (raw) {
    case 'initial_startup':
    case 'manual_restart':
    case 'clean_exit_respawn':
    case 'crash_backoff_respawn':
      return raw;
    default:
      return 'unknown';
  }
}

export interface StartupFacts {
  restartReason: RestartReason;
  /** Wall-clock ms when this process started. */
  processStartedAt: number;
  /** True when the previous process died while a turn was in flight. */
  diedMidTurn: boolean;
  /** The command the dying process was running, when we could identify it. */
  interruptedCommand?: string;
  /** Whether that command looks like a deploy/restart. */
  interruptedCommandIsDeploy: boolean;
}

/**
 * Commands that restart or replace the bridge. Matching on the actual command
 * string of a `tool_use` (never on prose), so a user merely *mentioning*
 * "restart" can't trip this.
 *
 * `npm run redeploy` reaching the restart step already proves the build
 * succeeded — it is `build && restart` — so a `manual_restart` carrying one of
 * these commands is strong evidence the deploy landed.
 */
const DEPLOY_COMMAND = [
  /\bnpm\s+run\s+redeploy\b/i,
  /\bnpm\s+run\s+(?:daemon:)?(?:re)?deploy\b/i,
  /\bnpm\s+run\s+daemon:restart\b/i,
  /\brestart-bridge\b/i,
  /windows-service\.cjs\s+restart\b/i,
  /\bsc\.?exe?\s+(?:stop|start)\s+wechat/i,
  /\bwatchdog-v2[^\n]*\/restart\b/i,
  // The documented restart path: an HTTP POST to watchdog's /restart. Matched
  // on a URL rather than a bare "/restart" so that reading or grepping for the
  // route does not read as an actual restart.
  /\bhttps?:\/\/[^\s]*\/restart\b/i,
  /\bcurl\b[^\n]*\/restart\b/i,
];

export function looksLikeDeployCommand(command: string | undefined): boolean {
  if (!command) return false;
  return DEPLOY_COMMAND.some((re) => re.test(command));
}

// ── transcript forensics ────────────────────────────────────────────────────

/** Read at most `maxChars` from the end of a file, as UTF-8. */
function readTailChars(path: string, maxChars: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxChars);
    const length = size - start;
    if (length <= 0) return '';
    fd = openSync(path, 'r');
    // Drop the first line only if it is a *fragment*. If the window opens at a
    // line boundary — or covers the whole file — every line is complete, and
    // dropping one can silently lose the very orphan we are looking for.
    let skipFirstLine = false;
    if (start > 0) {
      const probe = Buffer.alloc(1);
      readSync(fd, probe, 0, 1, start - 1);
      skipFirstLine = probe[0] !== 0x0a;
    }

    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    const text = buf.toString('utf8');
    if (!skipFirstLine) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* nothing useful to do */ }
    }
  }
}

interface TranscriptBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
}

/**
 * Find the last tool_use in the transcript that never got a tool_result.
 *
 * That orphan is the exact command the previous process was executing when it
 * was killed. Its absence of a result means the process died mid-call — not
 * that the command failed.
 *
 * The test is "a tool_use appearing after the final tool_result", not "any
 * tool_use in the window without a result". Those differ on long transcripts:
 * a call that was abandoned mid-turn hours ago stays unanswered forever, and
 * the older form would happily report it as the command that just killed us.
 */
export function findOrphanToolUse(transcriptPath: string, maxChars = 256 * 1024): string | undefined {
  const text = readTailChars(transcriptPath, maxChars);
  if (!text) return undefined;

  let pending: TranscriptBlock | undefined;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { message?: { content?: TranscriptBlock[] } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial or non-JSON line
    }
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        // Only the call this answers clears the candidate; parallel tool_use
        // blocks ahead of it stay pending until their own results arrive.
        if (pending?.id === block.tool_use_id) pending = undefined;
      } else if (block.type === 'tool_use' && block.id) {
        pending = block;
      }
    }
  }

  return pending ? describeToolUse(pending) : undefined;
}

/** Render a tool_use block as a short human-readable command string. */
function describeToolUse(block: TranscriptBlock): string {
  const input = block.input ?? {};
  const command = input.command ?? input.cmd;
  if (typeof command === 'string' && command.trim()) return command.trim();
  const description = input.description;
  if (typeof description === 'string' && description.trim()) return description.trim();
  return block.name ?? '(unknown tool)';
}

// ── consult prompt block ────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Render the startup facts as a block for the consultation prompt.
 *
 * The inference rules are stated explicitly on purpose. The model's prior for
 * "no tool_result" is "failed", and it is strong enough to override anything
 * the transcript shows. Naming the rule is what actually flips it.
 */
export function buildStartupContextBlock(facts: StartupFacts, now = Date.now()): string {
  const lines = [
    '## 本次启动上下文（由 bridge 进程提供，是事实，不是你的推断）',
    '',
    `- 本进程启动时间：${formatTime(facts.processStartedAt)}`,
    `- 距今：${Math.max(0, Math.round((now - facts.processStartedAt) / 1000))} 秒`,
    `- 启动原因：${REASON_LABELS[facts.restartReason]}`,
    `- 上一个进程是否死在对话轮次中途：${facts.diedMidTurn ? '是' : '否'}`,
  ];

  if (facts.interruptedCommand) {
    lines.push(
      `- 死掉时正在执行的命令：${JSON.stringify(facts.interruptedCommand)}`,
      `- 该命令是否属于部署/重启类：${facts.interruptedCommandIsDeploy ? '是' : '否'}`,
    );
  } else {
    lines.push('- 死掉时正在执行的命令：未能识别');
  }

  lines.push(
    '',
    '## 判断准则（务必遵守）',
    '',
    '1. **没有 tool_result ≠ 命令失败。** 工具调用没有结果，只说明进程在它执行',
    '   途中被杀了。重启动作把进程换掉时，这是**预期结果**，不是异常。',
    '2. **启动原因是「主动重启」时，默认假设那个动作已经成功。** 有人显式调用了',
    '   重启，这通常就是某个流程的最后一步——重启本身就是目标。不要重做它。',
    '3. 如果被中断的命令属于部署/重启类，部署几乎必然已经完成：',
    '   `npm run redeploy` 是 `build && restart`，能走到重启就说明编译已经成功。',
    '   此时应判定「一切正常」，不要建议重跑。',
    '4. 只有当启动原因是崩溃/退避重启，且中断点确实停在某个未完成的工作上时，',
    '   才考虑 resume。',
    '',
  );

  return lines.join('\n');
}

/**
 * Bridge-side override for the one case we can decide without asking anyone.
 *
 * A `manual_restart` whose interrupted command was a deploy is a completed
 * deploy, not an interrupted one. The consultation is still allowed to run —
 * this only rewrites the outcome when it asks to redo the thing that just
 * replaced the process.
 */
export function deployCompletionOverride(
  facts: StartupFacts,
): { action: 'notify'; resume: 'none'; message: string; overrideReason: string } | undefined {
  if (facts.restartReason !== 'manual_restart') return undefined;
  if (!facts.interruptedCommandIsDeploy) return undefined;

  return {
    action: 'notify',
    resume: 'none',
    message: '✅ 已重启完成，上次执行到部署的最后一步——那一步就是把我换掉，所以它成功了。',
    overrideReason: 'deploy_completed_by_restart',
  };
}