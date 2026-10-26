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
  /session <ID>     切换到指定的 SDK 会话（完整 ID 或唯一前缀）
  /session <序号>   按 /session 列表里的编号切换
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

/**
 * Switch to an existing Claude Code SDK session by ID.
 *
 * IMPORTANT: Claude Code couples sessions to their working directory. From the
 * docs (sessions): a session "is anchored to your current directory", `claude
 * --resume` ignores the spawn cwd and uses the cwd recorded in the session
 * transcript (the latest `cwd` field in the JSONL — after v2.1.169's `/cd`
 * command, a session can relocate to a different directory mid-flight, and
 * --resume will look for the session there). v2.1.223+ can find a session
 * across directories, but the resumed session still uses its own recorded cwd.
 *
 * Because of this coupling, we MUST update both `sdkSessionId` AND
 * `workingDirectory` together, or tool calls (file reads, Bash, etc.) will run
 * against the wrong project. There is no `--keep-cwd` opt-out — it would
 * silently desync daemon state from what Claude Code actually does.
 */
export function handleSession(ctx: CommandContext, args: string): CommandResult {
  const raw = args.trim();

  if (!raw) {
    // No ID supplied — list recently used SDK sessions so the user can pick one.
    return { reply: listSdkSessions(ctx), handled: true };
  }

  // Two reference forms, deliberately kept disjoint:
  //   /session <1>       angle-bracketed index into the last listing
  //   /session 1         session-id prefix (bare number)
  // A bare number cannot mean both. UUIDs are hex, so "0162" is a real
  // session prefix, but "1" is also how you'd say "the first row" — and one
  // character matches a large slice of the namespace, so the index form would
  // read as ambiguous on almost any machine. Angle brackets remove the
  // collision instead of letting one meaning win arbitrarily.
  let id = raw;
  const indexMatch = /^<(\d+)>$/.exec(raw);
  if (indexMatch) {
    const snapshot = ctx.session.lastSessionList ?? [];
    const entry = snapshot[parseInt(indexMatch[1], 10) - 1];
    if (!entry) {
      return {
        reply:
          `⚠️ 编号 ${indexMatch[1]} 超出范围（上次列表只有 ${snapshot.length} 条）\n` +
          `请先 /session 重新生成列表`,
        handled: true,
      };
    }
    id = entry.id;
  }

  // Resolve to a REAL transcript before binding anything. `id` may be a short
  // prefix; `lookup.fullId` is always the complete UUID we must store, because
  // `claude --resume` accepts nothing shorter.
  const lookup = findSessionFile(id);

  if (lookup.kind === 'ambiguous') {
    const shown = lookup.matches.slice(0, 5).map((m) => `  · ${m}`).join('\n');
    return {
      reply:
        `⚠️ "${raw}" 同时匹配 ${lookup.matches.length} 个会话，未切换：\n${shown}\n` +
        `请补长前缀（能唯一确定一个），或用 /session 重新看列表。`,
      handled: true,
    };
  }

  if (lookup.kind === 'missing') {
    // Never bind an id that has no transcript on disk. Binding it makes the
    // daemon send `claude --resume <garbage>` on the next message, which
    // Claude rejects outright — every turn then silently starts fresh while
    // the state table claims a resume is configured.
    ctx.updateSession({ sdkSessionId: undefined });
    return {
      reply:
        `⚠️ 找不到会话 ${raw}\n` +
        `已断开当前会话绑定，下次消息将开一个全新会话。\n` +
        `用 /session 查看可切换的会话列表。`,
      handled: true,
    };
  }

  // Look up the session's recorded cwd (the LATEST one, since mid-session
  // `/cd` can relocate the session).
  const recordedCwd = readSessionMeta(lookup.sessionPath).cwd;

  if (recordedCwd) {
    ctx.updateSession({ sdkSessionId: lookup.fullId, workingDirectory: recordedCwd });
    return {
      reply:
        `✅ 已切换到 SDK 会话: ${lookup.fullId}\n` +
        `📁 工作目录已自动同步: ${recordedCwd}\n` +
        `下次消息将用 --resume 恢复该会话。`,
      handled: true,
    };
  }

  // No cwd recorded in the transcript (very rare for SDK sessions). We still
  // bind the full session ID but warn — the daemon's workingDirectory may not
  // match what Claude Code will use on resume.
  ctx.updateSession({ sdkSessionId: lookup.fullId });
  return {
    reply:
      `✅ 已切换到 SDK 会话: ${lookup.fullId}\n` +
      `⚠️ 未在 transcript 中找到 cwd 记录，当前工作目录保持为 ${ctx.session.workingDirectory}\n` +
      `（如 Claude 实际使用的目录不一致，可用 /cwd 手动修正）\n` +
      `下次消息将用 --resume 恢复该会话。`,
    handled: true,
  };
}

const LIST_LIMIT = 10;
const SUMMARY_MAX = 50;        // visible summary length
const HEAD_WINDOW = 32 * 1024; // enough for first user msg + early custom-title
const TAIL_WINDOW = 64 * 1024; // tail window for latest cwd after late /cd

interface SdkSessionInfo {
  id: string;
  projectDir: string;
  cwd?: string;
  summary?: string;       // first user message, truncated
  customTitle?: string;   // /rename'd title, if any
  gitBranch?: string;
  mtimeMs: number;
  sizeBytes: number;
}

interface SessionMeta {
  cwd?: string;
  summary?: string;
  customTitle?: string;
  gitBranch?: string;
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

/**
 * Pull the bits we need from a session JSONL without reading the whole file:
 *   - cwd: latest entry's cwd (Claude's `/cd` can relocate mid-session; the
 *     most recent record is what `claude --resume` will actually use)
 *   - summary: text of the first user message (truncated)
 *   - customTitle: last `custom-title` entry written by `/rename`
 *   - gitBranch: from any entry that records it
 *
 * Mirrors what the official Claude Agent SDK's `listSessions()` does — scan
 * the project directory + read head/tail of each transcript, no subprocess,
 * no API call.
 */
function readSessionMeta(sessionPath: string): SessionMeta {
  let fd: number | undefined;
  const out: SessionMeta = {};
  try {
    const size = statSync(sessionPath).size;
    if (size === 0) return out;

    fd = openSync(sessionPath, 'r');

    // Head pass: cwd (latest in head wins), first user message, custom-title
    // entries, and gitBranch. HEAD_WINDOW is large enough for the first user
    // turn + any in-session /rename done early.
    const headSize = Math.min(HEAD_WINDOW, size);
    const headBuf = Buffer.alloc(headSize);
    const headRead = readSync(fd, headBuf, 0, headBuf.length, 0);
    const headText = headBuf.toString('utf-8', 0, headRead);

    for (const line of headText.split('\n')) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      if (typeof obj.cwd === 'string' && obj.cwd) {
        out.cwd = obj.cwd;
      }
      if (typeof obj.gitBranch === 'string' && obj.gitBranch) {
        out.gitBranch = obj.gitBranch;
      }
      if (!out.summary && obj.type === 'user' && obj.message?.role === 'user') {
        const text = extractFirstText(obj.message.content);
        if (text) out.summary = truncateSummary(text);
      }
      // Claude Code's `/rename` and the SDK's `rename_session()` append a
      // top-level entry like {"type":"custom-title","title":"...","sessionId":"..."}.
      // Latest one in the file wins (matches SDK behavior).
      if (obj.type === 'custom-title' && typeof obj.title === 'string' && obj.title) {
        out.customTitle = obj.title;
      }
    }

    // If the file is bigger than HEAD_WINDOW, a `/cd` after the head window
    // won't show up there — fall through to the tail to pick up the freshest
    // cwd recorded.
    if (size > HEAD_WINDOW) {
      const tailSize = Math.min(TAIL_WINDOW, size - HEAD_WINDOW);
      const tailBuf = Buffer.alloc(tailSize);
      const tailOffset = size - tailBuf.length;
      const tailRead = readSync(fd, tailBuf, 0, tailBuf.length, tailOffset);
      const tailText = tailBuf.toString('utf-8', 0, tailRead);
      const tailLines = tailText.split('\n');
      // If we didn't start at offset 0, the first line is a partial record
      // straddling the boundary; drop it so we never parse garbage.
      const startIdx = tailOffset > 0 ? 1 : 0;
      for (let i = tailLines.length - 1; i >= startIdx; i--) {
        const line = tailLines[i];
        if (!line.trim()) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        if (typeof obj.cwd === 'string' && obj.cwd) {
          out.cwd = obj.cwd;
          break;
        }
      }
    }
  } catch {
    // unreadable — return whatever we managed to collect
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return out;
}

function extractFirstText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'text') {
        const text = (block as any).text;
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    }
  }
  return undefined;
}

function truncateSummary(text: string): string {
  // Strip leading "-" (slash command queued via stdin often serializes as
  // "-\n<cmd>"), collapse whitespace, and clip to a readable length.
  const cleaned = text
    .replace(/^[-–—]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= SUMMARY_MAX) return cleaned;
  return cleaned.slice(0, SUMMARY_MAX - 1) + '…';
}

function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

function decodeProjectDirName(encoded: string): string {
  // Claude Code stores sessions under ~/.claude/projects/<encoded-cwd>/
  // where the cwd's path separators and dots are escaped to dashes. We can
  // partially recover a human-readable hint, but the encoding is lossy
  // (real dashes become "--"), so we keep it short and just say "project".
  return encoded || '(unknown)';
}

function listSdkSessions(ctx: CommandContext): string {
  const home = homedir();
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) {
    return `📂 找不到 ${projectsDir}\n请先在 Claude Code 终端跑过一次对话以生成会话文件。`;
  }

  const sessions: SdkSessionInfo[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch (err) {
    return `📂 无法读取 ${projectsDir}: ${err instanceof Error ? err.message : String(err)}`;
  }

  for (const projectDir of projectDirs) {
    const fullProjectDir = join(projectsDir, projectDir);
    let dirStat;
    try {
      dirStat = statSync(fullProjectDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(fullProjectDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = join(fullProjectDir, file);
      try {
        const fileStat = statSync(fullPath);
        const meta = readSessionMeta(fullPath);
        sessions.push({
          id: file.replace(/\.jsonl$/, ''),
          projectDir,
          cwd: meta.cwd,
          summary: meta.summary,
          customTitle: meta.customTitle,
          gitBranch: meta.gitBranch,
          mtimeMs: fileStat.mtimeMs,
          sizeBytes: fileStat.size,
        });
      } catch {
        // skip unreadable
      }
    }
  }

  if (sessions.length === 0) {
    return '📂 暂无 SDK 会话记录。请先在 Claude Code 终端跑过一次对话。';
  }

  // Most recently active first; cap to LIST_LIMIT entries.
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = sessions.slice(0, LIST_LIMIT);

  const currentId = ctx.session.sdkSessionId;
  const previousId = ctx.session.previousSdkSessionId;
  const seen = new Set<string>();

  // Build the ordered display list: pinned first, then the rest. The order
  // we walk here is the order numbers refer to in `/session <n>` (bracketed).
  const ordered: Array<{ session: SdkSessionInfo; tag: string }> = [];
  if (currentId) {
    const found = sessions.find((s) => s.id === currentId);
    if (found) { ordered.push({ session: found, tag: '★ 当前' }); seen.add(found.id); }
  }
  if (previousId && !seen.has(previousId)) {
    const found = sessions.find((s) => s.id === previousId);
    if (found) { ordered.push({ session: found, tag: '◦ 上次' }); seen.add(found.id); }
  }
  for (const s of top) {
    if (seen.has(s.id)) continue;
    ordered.push({ session: s, tag: '' });
  }

  const lines: string[] = [];
  lines.push(`📂 可用 SDK 会话（最近 ${top.length} 个，按最后活动排序）：`);
  lines.push('');
  // Markdown table. WeChat renders this natively (better than ASCII boxes
  // which don't align in the client's proportional font). Column widths are
  // chosen so a typical row fits without horizontal scroll on mobile.
  lines.push('| # | 标题 | ID | 目录 | 时间 | 大小 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  let lastHadTag = false;
  for (let i = 0; i < ordered.length; i++) {
    const { session: s, tag } = ordered[i];
    if (tag && i > 0 && !lastHadTag) lines.push('');
    const numStr = tag ? `${tag} ${i + 1}` : String(i + 1);
    lines.push(formatSessionRow(s, numStr));
    if (tag) lastHadTag = true;
  }

  if (sessions.length > top.length) {
    lines.push('');
    lines.push(`…还有 ${sessions.length - top.length} 个较旧的会话`);
  }

  // Persist the snapshot so `/session <n>` can resolve index lookups.
  ctx.updateSession({ lastSessionList: ordered.map(({ session }) => ({ id: session.id })) });

  lines.push('');
  lines.push('用法:');
  lines.push('  /session <序号>          按上面的编号切换（下次消息用 --resume 恢复）');
  lines.push('  /session <会话号前缀>     按会话号前缀切换，ID 列可直接复制');
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSessionLocation(s: SdkSessionInfo): string {
  // Prefer the recorded cwd over the lossy encoded dirname. The encoded
  // form ('F--AI-Code-Project') is shown only when we couldn't read cwd.
  if (s.cwd) return s.cwd;
  return decodeProjectDirName(s.projectDir);
}

/**
 * Render one session as a single table row. Uses WeChat-rendered markdown
 * table format: the receiver renders the columns natively, so we don't have
 * to fake alignment with box-drawing characters (which look bad in
 * monospace terminals but also don't align in WeChat's proportional font).
 *
 * Columns are space-budgeted so the worst case still fits in a single WeChat
 * text bubble without horizontal scrolling:
 *   # | 标题 (28 chars) | ID (8) | 目录 (40) | 时间 (10) | 大小 (8)
 *
 * The current/pinned tag is folded into the # column as a badge so the
 * table header never needs a dedicated "status" column.
 *
 * `numStr` is the cell content for the # column — typically just a number,
 * or "★ 当前 N" / "◦ 上次 N" for pinned entries. The caller has already
 * formatted the badge so this function stays free of presentation choices.
 */
function formatSessionRow(s: SdkSessionInfo, numStr: string): string {
  const headline = s.customTitle ?? s.summary ?? shortId(s.id);
  const title = truncateForCell(headline, 28);
  const id = shortId(s.id);
  const location = truncateForCell(formatSessionLocation(s), 40);
  const time = truncateForCell(formatRelativeTime(s.mtimeMs), 10);
  const size = formatBytes(s.sizeBytes);
  return `| ${numStr} | ${title} | \`${id}\` | ${location} | ${time} | ${size} |`;
}

/**
 * Pad / truncate a string for a single markdown table cell. Cells can't
 * contain raw newlines in WeChat's renderer, so we collapse whitespace.
 * Use this for short, single-line columns (e.g. the /session listing);
 * for multi-line transcript content use escapeForCell instead.
 */
function truncateForCell(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  if (max <= 1) return flat.slice(0, max);
  return flat.slice(0, max - 1) + '…';
}

/**
 * Sanitize a string for a markdown table cell that may contain multi-line
 * content (assistant paragraphs, tool input blobs, etc).
 *
 * - Literal newlines become `<br>` so multi-line content keeps its
 *   structure when WeChat renders the cell. A raw `\n` would terminate the
 *   table row and corrupt the surrounding rows.
 * - Pipes are escaped to `\|` since they would otherwise be interpreted as
 *   column separators.
 * - Long content is trimmed by **line count first** (keeps paragraph
 *   structure intact), then by per-line character count as a guard rail
 *   against pathological inputs (e.g. a single 5KB log line). A trailing
 *   `…` makes it obvious the cell was trimmed.
 */
function escapeForCell(
  text: string,
  opts: { maxLines?: number; maxLineLen?: number } = {},
): string {
  const { maxLines = 8, maxLineLen = 240 } = opts;
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  let lines = rawLines.map((l) => l.trimEnd());
  // Trim trailing empty lines but keep internal blanks that separate
  // paragraphs.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines.push('…');
  }

  return lines
    .map((line) => {
      let s = line.replace(/\|/g, '\\|');
      if (s.length > maxLineLen) {
        s = s.slice(0, maxLineLen - 1) + '…';
      }
      return s;
    })
    .join('<br>');
}

function shortId(id: string): string {
  // The one definition of "the short session id" — see shortSessionId.
  return shortSessionId(id);
}

// ---------------------------------------------------------------------------
// /history: read the SDK session transcript from JSONL
// ---------------------------------------------------------------------------

const TRANSCRIPT_TAIL = 512 * 1024;  // bounded tail read (512 KB)
const CONTENT_MAX = 800;             // per-message text truncation
const TOOL_BRIEF_MAX = 100;

interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  toolUses: Array<{ name: string; brief: string }>;
  timestamp: number;
}

function encodeProjectDir(cwd: string): string {
  // Claude Code replaces every non-alphanumeric char in cwd with `-`.
  // See https://code.claude.com/docs/en/sessions — `~/.claude/projects/`
  // uses this encoding for the project directory name.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function findSdkSessionPath(sessionId: string, cwd: string): string | undefined {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return undefined;
  // Exact match first (fast path).
  const exact = join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  if (existsSync(exact)) return exact;
  // Fall back to scanning every project dir — handles the case where the
  // session was created in another cwd or moved via `/cd`.
  let projectDirs: string[];
  try { projectDirs = readdirSync(projectsDir); } catch { return undefined; }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Read the tail of an SDK session JSONL and return the last `messageLimit`
 * user/assistant entries. Bounded I/O — never reads the full (potentially
 * 100 MB+) transcript.
 */
function readSdkTranscript(
  sessionPath: string,
  messageLimit: number,
  skipFromTail = 0,
): TranscriptEntry[] {
  // skipFromTail discards the N most recent entries first (offset semantics:
  // 0 = newest page; N = skip the latest N entries and return what comes
  // before). This is what /history <limit> <offset> uses to paginate
  // backwards through an old transcript.
  const entries: TranscriptEntry[] = [];
  let fd: number | undefined;
  try {
    const size = statSync(sessionPath).size;
    if (size === 0) return entries;

    fd = openSync(sessionPath, 'r');
    const readSize = Math.min(TRANSCRIPT_TAIL, size);
    const offset = Math.max(0, size - readSize);
    const buf = Buffer.alloc(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, offset);
    const text = buf.toString('utf-8', 0, bytesRead);

    const lines = text.split('\n');
    // If we didn't read from offset 0, the first line is partial — drop it.
    const startIdx = offset > 0 ? 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.type === 'user' && obj.message?.role === 'user') {
        const entry = formatUserEntry(obj);
        if (entry) entries.push(entry);
      } else if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const entry = formatAssistantEntry(obj);
        if (entry) entries.push(entry);
      }
      // Skip queue-operation, last-prompt, mode, permission-mode, attachment,
      // custom-title, and other metadata-only entries.
    }
  } catch {
    // unreadable — return whatever we got
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }

  // Apply offset (skip the most recent N entries) and limit, both measured
  // in chat-message units, not raw JSONL lines.
  const tail = entries.slice(-(messageLimit + skipFromTail));
  return skipFromTail > 0 ? tail.slice(0, -skipFromTail) : tail;
}

function formatUserEntry(obj: any): TranscriptEntry | null {
  const content = obj.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        text = block.text;
        break;
      }
    }
    // Pure tool_result blocks — skip showing them, the assistant's next
    // message will reference the result.
    if (!text) return null;
  }
  return {
    role: 'user',
    content: truncateContent(stripQueuePrefix(text)),
    toolUses: [],
    timestamp: parseTimestamp(obj.timestamp),
  };
}

function formatAssistantEntry(obj: any): TranscriptEntry | null {
  const content = obj.message?.content;
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  const toolUses: Array<{ name: string; brief: string }> = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block?.type === 'tool_use' && block.name) {
      toolUses.push({
        name: block.name,
        brief: formatToolUseBrief(block.name, block.input),
      });
    }
  }
  const text = textParts.join('\n').trim();
  if (!text && toolUses.length === 0) return null;
  return {
    role: 'assistant',
    content: truncateContent(text),
    toolUses,
    timestamp: parseTimestamp(obj.timestamp),
  };
}

function formatToolUseBrief(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const shorten = (p: string) => {
    const home = homedir();
    return p.startsWith(home) ? '~' + p.slice(home.length) : p;
  };
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shorten(String(input.file_path ?? input.notebook_path ?? ''));
    case 'Bash':
      return String(input.command ?? '').split('\n')[0].slice(0, TOOL_BRIEF_MAX);
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Grep':
      return [
        input.path ? shorten(String(input.path)) : '',
        input.pattern ? String(input.pattern) : '',
      ].filter(Boolean).join(' ');
    case 'Agent':
    case 'Task':
      return String(input.description ?? input.prompt ?? '').slice(0, TOOL_BRIEF_MAX);
    case 'WebFetch':
      return String(input.url ?? '').slice(0, TOOL_BRIEF_MAX);
    case 'WebSearch':
      return String(input.query ?? '').slice(0, TOOL_BRIEF_MAX);
    default:
      try {
        return JSON.stringify(input).slice(0, TOOL_BRIEF_MAX);
      } catch {
        return '';
      }
  }
}

function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'string') {
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  if (typeof ts === 'number') return ts;
  return Date.now();
}

function stripQueuePrefix(text: string): string {
  // stdin queue serializes messages as "-\n<text>"; strip the marker.
  return text.replace(/^[-–—]\s*\n?/, '').trimStart();
}

function truncateContent(text: string): string {
  if (text.length <= CONTENT_MAX) return text;
  return text.slice(0, CONTENT_MAX - 1) + '…';
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatTranscriptForWeChat(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return '（该 session 的 transcript 为空）';
  // Markdown table. WeChat renders it natively, much easier to scan than the
  // old "header line + content block" layout. Tool uses are inlined into the
  // 工具 column as a compact list so the table stays 6 rows wide regardless
  // of how many tools each turn invoked.
  const lines: string[] = [];
  lines.push('| # | 时间 | 角色 | 内容 | 工具 |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const num = entries.length - i; // newest = 1
    const role = e.role === 'user' ? '👤 USER' : '🤖 CLAUDE';
    const time = formatTimestamp(e.timestamp);
    let content = e.content ? escapeForCell(e.content) : '';
    // Slash commands deserve a visual cue since they don't reach Claude.
    if (e.role === 'user' && content.startsWith('/')) {
      content = '⚙ ' + content;
    }
    const tools = e.toolUses.length
      ? e.toolUses.map((t) => {
          const brief = t.brief ? ` ${escapeForCell(t.brief)}` : '';
          return `\`${t.name}\`${brief}`;
        }).join('<br>')
      : '—';
    lines.push(`| ${num} | ${time} | ${role} | ${content} | ${tools} |`);
  }
  return lines.join('\n');
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
  const startedAt = ctx.startedAt;
  const startedAtText = new Date(startedAt).toLocaleString('zh-CN');
  const uptimeMs = Math.max(0, Date.now() - startedAt);
  const uptimeText = formatUptime(uptimeMs);
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
    `main.js PID: ${process.pid}`,
    `wrapper PID: ${process.ppid}`,
    `服务启动时间: ${startedAtText}`,
    `运行时长: ${uptimeText}`,
  ];
  return { reply: lines.join('\n'), handled: true, priority: true };
}

/** Format a millisecond duration as `Nd HH:mm:ss` (drops days→hours if 0). */
function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
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
  // Two numeric args: `<limit> [skipFromTail]`.
  //   /history         → limit 20, skip 0 (latest 20 entries)
  //   /history 50      → limit 50, skip 0 (latest 50)
  //   /history 50 20   → skip the latest 20, then show the next 50
  //                      (useful for paging back through long sessions)
  // `0` as the limit means "no limit" — capped at MAX_HISTORY_LIMIT.
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 2) {
    return { reply: '用法: /history [数量] [跳过]\n例: /history 50（最近50条）\n     /history 50 20（跳过最新20条，再显示50条）', handled: true };
  }
  const limitRaw = tokens[0] !== undefined ? parseInt(tokens[0], 10) : 20;
  const skipRaw = tokens[1] !== undefined ? parseInt(tokens[1], 10) : 0;
  if (isNaN(limitRaw) || limitRaw < 0 || isNaN(skipRaw) || skipRaw < 0) {
    return { reply: '用法: /history [数量] [跳过]\n数量和跳过必须是非负整数。', handled: true };
  }
  // limitRaw === 0 → "all available", capped. Negative already rejected.
  const limit = limitRaw === 0 ? MAX_HISTORY_LIMIT : Math.min(limitRaw, MAX_HISTORY_LIMIT);
  const skipFromTail = skipRaw;

  const s = ctx.session;

  // Prefer the SDK session transcript (the source of truth — what's actually
  // in Claude's context). Fall back to local chatHistory only when there is
  // no SDK session yet (e.g. before the first turn completes, or in
  // environments where the transcript isn't readable).
  let body: string;
  let source: string;
  let totalShown: number;
  let pageLabel: string;

  if (s.sdkSessionId) {
    const sessionPath = findSdkSessionPath(s.sdkSessionId, s.workingDirectory);
    if (sessionPath) {
      const entries = readSdkTranscript(sessionPath, limit, skipFromTail);
      body = formatTranscriptForWeChat(entries);
      source = `SDK session ${shortId(s.sdkSessionId)} · transcript`;
      totalShown = entries.length;
      pageLabel = skipFromTail > 0
        ? `跳过最新 ${skipFromTail} 条，显示其后 ${totalShown} 条`
        : `最近 ${totalShown} 条`;
      return {
        reply: `📝 ${source}（${pageLabel}）:\n\n${body}`,
        handled: true,
        priority: true,
      };
    }
    // sdkSessionId set but no file found — fall back to local.
    source = `SDK session ${shortId(s.sdkSessionId)}（transcript 不可读，回退到本地）`;
  } else {
    source = '本地缓存（当前没有活动的 SDK session）';
  }

  // Local fallback path — apply offset/limit here too. getChatHistoryText
  // only knows about limit, so slice the in-memory array ourselves first.
  const fullHistory = s.chatHistory || [];
  const startIdx = Math.max(0, fullHistory.length - skipFromTail - limit);
  const endIdx = Math.max(0, fullHistory.length - skipFromTail);
  const slice = fullHistory.slice(startIdx, endIdx);
  totalShown = slice.length;
  pageLabel = skipFromTail > 0
    ? `跳过最新 ${skipFromTail} 条，显示其后 ${totalShown} 条`
    : `最近 ${totalShown} 条`;
  body = totalShown === 0
    ? '（暂无对话记录）'
    : formatLocalHistory(slice);
  return { reply: `📝 ${source}（${pageLabel}）:\n\n${body}`, handled: true, priority: true };
}

/**
 * Format a slice of session.chatHistory as the same markdown table used by
 * the SDK transcript path. Mirrors the column layout of
 * formatTranscriptForWeChat so /history looks the same regardless of source.
 */
function formatLocalHistory(messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>): string {
  const lines: string[] = [];
  lines.push('| # | 时间 | 角色 | 内容 |');
  lines.push('| --- | --- | --- | --- |');
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const num = messages.length - i;
    const time = new Date(m.timestamp).toLocaleString('zh-CN');
    const role = m.role === 'user' ? '👤 用户' : '🤖 Claude';
    let content = (m.content || '').replace(/\s+/g, ' ').trim();
    if (m.role === 'user' && content.startsWith('/')) content = '⚙ ' + content;
    if (content.length > 80) content = content.slice(0, 79) + '…';
    lines.push(`| ${num} | ${time} | ${role} | ${content} |`);
  }
  return lines.join('\n');
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
