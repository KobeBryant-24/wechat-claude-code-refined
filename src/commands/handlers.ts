import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { DEFAULT_WORKING_DIR } from '../constants.js';
import { readSnippet, snippetPath, isValidSnippetId } from '../claude/snippet-store.js';
import { shortSessionId } from '../claude/session-watcher.js';
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /stop             停止当前对话并清空排队消息
  /continue         继续上次未完成的对话（额度用完时续发剩余内容）
  /clear            清除当前会话
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /notify-me <会话ID>  监控该会话，本轮完成时微信通知我
  /notify-me off    取消会话监控
  /compact          压缩上下文（开始新 SDK 会话，保留历史）
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）

文件：
  /send <路径>      发送本地文件（图片直接显示，其他文件作为附件）
  /show <编号>     重新获取被压缩消息的完整原文（7 天内有效）

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换 Claude 模型
  /prompt [内容]    查看或设置系统提示词（全局生效）
  /compact-msg on|off  整合消息开关（按会话记忆）

其他：
  /skills [full]    列出已安装的 skill（full 显示描述）
  /version          查看版本信息
  /<skill> [参数]   触发已安装的 skill

直接输入文字即可与 Claude Code 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true, priority: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

type SessionLookup =
  | { kind: 'found'; projectDir: string; sessionPath: string; fullId: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'missing' };

/**
 * Resolve a user-supplied session reference to a real transcript on disk.
 *
 * `id` may be a full UUID or ANY unique prefix of one. Prefix support is not
 * a nicety: `listSdkSessions` only ever shows `shortId` (first 8 chars), so
 * the short form is what users copy out of the listing and type back.
 *
 * Exact matching alone silently broke that round-trip. The old
 * `handleSession` bound whatever the user typed, so `/session e2100b43`
 * stored `e2100b43` as `sdkSessionId`, and the next message spawned
 * `claude --resume e2100b43` — which Claude rejects ("is not a UUID and does
 * not match any session title"). The daemon then fell back to a fresh session
 * on every turn while the state table claimed a resume was configured.
 */
function findSessionFile(id: string): SessionLookup {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return { kind: 'missing' };

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return { kind: 'missing' };
  }

  // Exact match first — cheap, and the common case for a pasted UUID.
  for (const projectDir of projectDirs) {
    const candidate = join(projectsDir, projectDir, `${id}.jsonl`);
    if (existsSync(candidate)) {
      return { kind: 'found', projectDir, sessionPath: candidate, fullId: id };
    }
  }

  // Prefix sweep across every project dir. Transcripts sit directly in the
  // project dir; subagent sidecars live under <sessionId>/subagents/, so
  // readdir of the project dir never picks those up.
  const needle = id.toLowerCase();
  const matches: Array<{ fullId: string; sessionPath: string }> = [];
  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = readdirSync(join(projectsDir, projectDir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fullId = file.slice(0, -'.jsonl'.length);
      if (fullId.toLowerCase().startsWith(needle)) {
        matches.push({ fullId, sessionPath: join(projectsDir, projectDir, file) });
      }
    }
  }

  if (matches.length === 1) {
    return {
      kind: 'found',
      projectDir: '',
      sessionPath: matches[0].sessionPath,
      fullId: matches[0].fullId,
    };
  }
  if (matches.length > 1) {
    // Don't guess. Sorted so the reply is stable across runs.
    return { kind: 'ambiguous', matches: matches.map((m) => m.fullId).sort() };
  }
  return { kind: 'missing' };
}
function shortId(id: string): string {
  // The one definition of "the short session id" — see shortSessionId.
  return shortSessionId(id);
}
export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model claude-sonnet-4-6', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const pending = ctx.getPendingCount?.() ?? 0;
  const compact = s.compactMsg ?? loadConfig().compactMsg ?? false;
  const watched = ctx.getNotifyWatch?.();
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `会话ID: ${s.sdkSessionId ?? '无'}`,
    `状态: ${s.state}`,
    `整合消息: ${compact ? '开启' : '关闭'}`,
    `监控会话: ${watched ? `${shortId(watched.sessionId)}（${watched.busy ? '运行中' : '空闲'}）` : '无'}`,
    `待发消息: ${pending}${pending > 0 ? '（额度用完时在排队，回复任意消息即可续发）' : ''}`,
  ];
  return { reply: lines.join('\n'), handled: true, priority: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true, priority: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n使用 /skills full 查看完整描述`, handled: true, priority: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  newSession.workingDirectory = DEFAULT_WORKING_DIR;
  // A full reset drops the per-session delivery preference too, so the
  // session goes back to inheriting the service-level default.
  newSession.compactMsg = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 SDK 会话，无需压缩。', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✅ 上下文已压缩\n\n下次消息将开始新的 SDK 会话（token 清零）\n聊天历史已保留，可用 /history 查看',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-claude-code v${version}`, handled: true, priority: true };
  } catch {
    return { reply: 'wechat-claude-code (version unknown)', handled: true, priority: true };
  }
}

/**
 * `/compact-msg on|off` — how this session delivers a turn's output.
 *
 * On: the turn is collected and delivered as one unit. A short, quick turn
 * goes out as its own messages, in the order they were produced; anything
 * longer or slower goes out as a summary plus a file. Either way the turn
 * costs 2 messages of the user's budget instead of however many it happened
 * to produce.
 *
 * Off: each piece goes out as it is produced. The turn can produce more
 * messages than iLink's 10-message budget allows; the overflow waits in the
 * queue and goes out when the user writes again — which is what `/continue`
 * is for.
 *
 * The setting is remembered per session, so it keeps applying to this
 * conversation. `default on|off` changes the service-level default that
 * sessions which have not chosen inherit.
 */
export function handleCompactMsg(ctx: CommandContext, args: string): CommandResult {
  const arg = args.trim().toLowerCase();
  const config = loadConfig();

  if (arg.startsWith('default')) {
    const sub = arg.replace(/^default\s*/, '').trim();
    if (sub !== 'on' && sub !== 'off') {
      return {
        reply: '用法: /compact-msg default on | default off\n设置未被单独指定过的会话所继承的默认值。',
        handled: true,
      };
    }
    config.compactMsg = sub === 'on';
    saveConfig(config);
    return {
      reply: `✅ 服务默认已设为：${sub === 'on' ? '开启' : '关闭'}\n` +
        `未被单独设置的会话将继承这个默认值。`,
      handled: true,
    };
  }

  if (arg === 'on' || arg === 'off') {
    ctx.updateSession({ compactMsg: arg === 'on' });
    return {
      reply: arg === 'on'
        ? '✅ 已开启整合消息（compact-msg）\n' +
          '本会话之后：回复先整合，超过 4 条或耗时超过 30 秒时改为「摘要 + 附件」。'
        : '✅ 已关闭整合消息（compact-msg）\n' +
          '本会话之后：回复实时分段发送，额度用完时用 /continue 续发。',
      handled: true,
    };
  }

  if (arg && arg !== 'status') {
    return {
      reply: '用法: /compact-msg on | off | status | default on | default off',
      handled: true,
    };
  }

  const effective = ctx.session.compactMsg ?? config.compactMsg ?? false;
  const scope = ctx.session.compactMsg !== undefined
    ? '本会话设置'
    : '服务默认';
  return {
    reply: `📦 整合消息（compact-msg）：${effective ? '开启' : '关闭'}（来源：${scope}）\n` +
      `开启后：回复先整合，≤4 条且 ≤30 秒直接发送，否则发「摘要 + 附件」。\n` +
      `关闭后：实时分段发送，额度用完用 /continue 续发。`,
    handled: true,
  };
}

/**
 * `/stop` when nothing is running.
 *
 * The interesting case — a turn in flight — never reaches here: the daemon
 * intercepts it before the message enters the serial queue, so it takes
 * effect immediately instead of waiting for the current turn to finish.
 */
export function handleStop(_ctx: CommandContext): CommandResult {
  return { reply: 'ℹ️ 当前没有进行中的对话。', handled: true, priority: true };
}

/**
 * `/continue` — pick the conversation back up.
 *
 * The usual reason to send it: the turn's 10-message budget ran out and the
 * tail of the answer is still queued. Sending this message is itself what
 * releases that backlog — the user's message refills their budget — and it
 * also asks the assistant to continue the work it was doing.
 */
export function handleContinue(ctx: CommandContext, _args: string): CommandResult {
  if (ctx.session.state === 'processing') {
    return {
      reply: '⚠️ 当前还有一轮对话在进行中。\n先用 /stop 停止它，再回复 /continue。',
      handled: true,
    };
  }
  if (!ctx.session.sdkSessionId) {
    return {
      reply: '⚠️ 当前没有可续接的会话。\n直接发一条消息开始新会话即可。',
      handled: true,
    };
  }
  // The actual continuation is run by the caller — it needs the sender, the
  // abort controllers, and the session store, none of which the command
  // context carries.
  return { handled: true, continueSession: true };
}

/**
 * `/notify-me <session-id>` — ping me when that session finishes its turn.
 *
 * The watched session is a Claude Code session, identified the way
 * `/session` identifies one: the full id, or any unique prefix of it. The
 * 8-character id in the `/session` listing is what users actually copy.
 *
 * Only one session is watched at a time. Registering a new one replaces
 * the old — the user is pointing the watch at whatever they are waiting
 * for now, and a second silent watch would be a way to forget the first.
 *
 * The watch itself is a service-level component (it keeps running while
 * the user is not talking), so the command only decides *what* to watch;
 * the caller does the registering.
 */
export function handleNotifyMe(ctx: CommandContext, args: string): CommandResult {
  const arg = args.trim();

  if (!arg) {
    const watched = ctx.getNotifyWatch?.();
    if (!watched) {
      return {
        reply: '🔕 当前没有正在监控的会话\n\n' +
          '用法: /notify-me <会话ID>\n' +
          '（会话ID 见 /session 列表的 ID 列）\n' +
          '取消: /notify-me off',
        handled: true,
        priority: true,
      };
    }
    return {
      reply: `🔔 正在监控会话 ${shortId(watched.sessionId)}\n` +
        `状态: ${watched.busy ? '该会话正在运行中，等待本轮结束' : '该会话当前空闲，等待下一个任务完成'}\n` +
        `注册时间: ${new Date(watched.registeredAt).toLocaleString('zh-CN')}\n\n` +
        '取消: /notify-me off',
      handled: true,
      priority: true,
    };
  }

  if (arg === 'off' || arg === 'cancel' || arg === 'stop') {
    return { handled: true, notifyAction: { kind: 'cancel' } };
  }

  const lookup = findSessionFile(arg);
  if (lookup.kind === 'ambiguous') {
    const shown = lookup.matches.slice(0, 5).map((m) => `  · ${m}`).join('\n');
    return {
      reply: `⚠️ "${arg}" 同时匹配 ${lookup.matches.length} 个会话，未开始监控：\n${shown}\n` +
        '请补长前缀（能唯一确定一个），或用 /session 重新看列表。',
      handled: true,
      priority: true,
    };
  }

  if (lookup.kind === 'missing') {
    return {
      reply: `⚠️ 找不到会话 ${arg}\n` +
        '用 /session 查看可用的会话列表。',
      handled: true,
      priority: true,
    };
  }

  return {
    handled: true,
    notifyAction: {
      kind: 'register',
      sessionId: lookup.fullId,
      transcriptPath: lookup.sessionPath,
    },
  };
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

/**
 * Re-send a message body that the tool-noise filter compressed away.
 *
 * Every compressed body is stored under `~/.wechat-claude-code/snippets/<id>.md`
 * for a week, and its id is printed in the compressed message. This is the
 * escape hatch: the user can always get the original back.
 *
 * The id comes straight from a WeChat message and is joined onto a filesystem
 * path, so `isValidSnippetId` (8 lowercase hex chars) gates it — `../../` and
 * absolute paths never reach `join`.
 */
export function handleShow(_ctx: CommandContext, args: string): CommandResult {
  const id = args.trim().toLowerCase();

  if (!id) {
    return {
      reply: '用法: /show <编号>\n例: /show a1b2c3d4\n（编号见被压缩消息里的「编号 xxxxxxxx」）',
      handled: true,
    };
  }

  if (!isValidSnippetId(id)) {
    return { reply: `编号格式不对: ${id}\n应是 8 位十六进制字母数字（a-f 和 0-9）。`, handled: true };
  }

  const text = readSnippet(id);
  if (text === undefined) {
    return {
      reply: `找不到编号 ${id}\n可能已被清理（保留 7 天），或者编号输错了。`,
      handled: true,
    };
  }

  return {
    reply: `📄 编号 ${id} 的完整原文（${text.length} 字）：`,
    sendFile: snippetPath(id)!,
    handled: true,
    priority: true,
  };
}

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /send <文件路径>\n例: /send ~/Documents/report.pdf\n     /send ./chart.png', handled: true };
  }

  const resolved = args.startsWith('/')
    ? args
    : resolve(ctx.session.workingDirectory, args.replace(/^~/, homedir()));
  if (!existsSync(resolved)) {
    return { reply: `文件不存在: ${resolved}`, handled: true };
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { reply: `这是一个目录，请指定文件: ${resolved}`, handled: true };
  }

  if (stat.size > 25 * 1024 * 1024) {
    return { reply: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`, handled: true };
  }

  return { handled: true, sendFile: resolved };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
