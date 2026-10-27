#!/usr/bin/env node
/**
 * 把 skill 文档装进 Claude 全局目录。
 *
 * 本项目分成两半：
 *
 *   运行目录 —— 用户 clone 出来的代码目录，装依赖、跑构建、跑守护进程。
 *   skill 目录 —— Claude 全局目录里的 `<claudeDir>/skills/<name>/`，只放文档。
 *
 * 这里在两者之间建一个**目录联接**（Windows junction / POSIX symlink），
 * 指向运行目录里的 `skill/`。这样：
 *
 *   - Claude 能在全局目录下发现这个 skill；
 *   - skill 目录里不含任何运行代码，和运行目录彻底分开；
 *   - 改了文档立刻生效，不用重新安装。
 *
 * 所有路径都由脚本自身位置和环境变量推导，没有一个字是写死的。
 *
 * 用法：npm run skill:install
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 路径推导 --------------------------------------------------------------

/** 本脚本所在目录（<运行目录>/scripts）。 */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 运行目录：源码、dist/、node_modules/ 都在这里。 */
const PROJECT_DIR = resolve(SCRIPT_DIR, '..');
/** 要被联接出去的文档目录。 */
const SKILL_SOURCE = join(PROJECT_DIR, 'skill');

/** Claude Code 的配置目录：环境变量优先，否则 ~/.claude。与 CLI 自身规则一致。 */
const CLAUDE_DIR = (() => {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.claude');
})();

/** 数据目录：运行状态、账号、日志都放这里。 */
const DATA_DIR = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-claude-code');

// ---- skill 名字从 SKILL.md 的 frontmatter 读，不写死 ------------------------

function readSkillName() {
  try {
    const content = readFileSync(join(SKILL_SOURCE, 'SKILL.md'), 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = match?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
    return name || 'wechat-claude-code';
  } catch {
    return 'wechat-claude-code';
  }
}

const SKILL_NAME = readSkillName();
const SKILLS_DIR = join(CLAUDE_DIR, 'skills');
const SKILL_LINK = join(SKILLS_DIR, SKILL_NAME);
/**
 * 旧安装的备份放这儿，**不放进 skills/ 目录** —— Claude Code 会把
 * <claudeDir>/skills/ 下的每个子目录都当成一个 skill，备份留在那儿会
 * 变成一个重复的 skill 冒出来。
 */
const BACKUP_ROOT = join(CLAUDE_DIR, 'skill-backups');

// ---- 联接 ------------------------------------------------------------------

/** 目标是否已经是指向 SKILL_SOURCE 的联接。 */
function linkPointsToSource(linkPath) {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    // Windows junction 的 readlink 结果带 \\?\ 前缀，realpath 归一化更可靠。
    const target = realpathSync(linkPath);
    const source = realpathSync(SKILL_SOURCE);
    return target.toLowerCase() === source.toLowerCase();
  } catch {
    return false;
  }
}

function describeLink(linkPath) {
  try {
    const raw = readlinkSync(linkPath);
    return raw.replace(/^\\\\\?\\/, '');
  } catch {
    return '(未知)';
  }
}

function installLink() {
  if (!existsSync(SKILL_SOURCE)) {
    console.error(`✗ 找不到文档目录：${SKILL_SOURCE}`);
    console.error('  仓库结构不对，skill/ 目录应该在运行目录下面。');
    process.exit(1);
  }

  mkdirSync(SKILLS_DIR, { recursive: true });

  if (existsSync(SKILL_LINK) || isLink(SKILL_LINK)) {
    if (linkPointsToSource(SKILL_LINK)) {
      console.log(`✓ 已就位：${SKILL_LINK}`);
      console.log(`  └─► ${SKILL_SOURCE}`);
      return;
    }
    if (isLink(SKILL_LINK)) {
      // 指向别处的联接 —— 换掉它
      console.log(`• 移除旧联接：${SKILL_LINK} → ${describeLink(SKILL_LINK)}`);
      rmSync(SKILL_LINK, { force: true });
    } else {
      // 真实目录（多半是手工复制进去的旧版 skill）—— 挪走而不是删
      const backup = backupPath();
      mkdirSync(BACKUP_ROOT, { recursive: true });
      renameSync(SKILL_LINK, backup);
      console.log(`• 已有目录已备份到：${backup}`);
    }
  }

  // Windows 用 junction（目录联接），不需要管理员权限；POSIX 用 symlink。
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(SKILL_SOURCE, SKILL_LINK, linkType);
  console.log(`✓ 已安装：${SKILL_LINK}`);
  console.log(`  └─► ${SKILL_SOURCE}`);
}

/** lstat 判定链接（含 Windows junction）。 */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 备份落地位置：<claudeDir>/skill-backups/<name>-<时间戳>。 */
function backupPath() {
  return join(BACKUP_ROOT, `${SKILL_NAME}-${Date.now()}`);
}

/**
 * 把早期版本遗留在 skills/ 里的 `*.bak-*` 备份挪到 skill-backups/。
 *
 * Claude Code 会把 <claudeDir>/skills/ 下的每个子目录都当成一个 skill，
 * 备份目录留在那儿就会冒出一个重复的 skill。
 */
function sweepStaleBackups() {
  let entries;
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch {
    return;
  }
  const stale = entries.filter((name) => name.startsWith(`${SKILL_NAME}.bak-`));
  if (stale.length === 0) return;

  mkdirSync(BACKUP_ROOT, { recursive: true });
  for (const name of stale) {
    const from = join(SKILLS_DIR, name);
    // wechat-claude-code.bak-1793115004502 → wechat-claude-code-1793115004502
    const suffix = name.slice(`${SKILL_NAME}.bak-`.length);
    const to = join(BACKUP_ROOT, `${SKILL_NAME}-${suffix}`);
    try {
      renameSync(from, to);
      console.log(`• 旧备份已移出 skills 目录：${from} → ${to}`);
    } catch (err) {
      console.warn(`! 没能移动旧备份 ${from}：${err.message}`);
    }
  }
}

// ---- 安装状态 --------------------------------------------------------------

/**
 * 把「代码在哪 / skill 装在哪」记下来。skill 文档本身不在运行目录里，
 * 需要靠这个文件才知道该往哪跑命令。
 */
function writeInstallState() {
  mkdirSync(DATA_DIR, { recursive: true });
  const statePath = join(DATA_DIR, 'install.json');
  const state = {
    projectDir: PROJECT_DIR,
    skillDir: SKILL_LINK,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  return statePath;
}

// ---- 主流程 ----------------------------------------------------------------

console.log('=== 安装 skill 到 Claude 全局目录 ===');
console.log(`运行目录     : ${PROJECT_DIR}`);
console.log(`文档目录     : ${SKILL_SOURCE}`);
console.log(`Claude 目录  : ${CLAUDE_DIR}${process.env.CLAUDE_CONFIG_DIR ? '  (来自 CLAUDE_CONFIG_DIR)' : '  (默认 ~/.claude)'}`);
console.log('');

sweepStaleBackups();
installLink();

const statePath = writeInstallState();
console.log('');
console.log(`✓ 安装状态已记录：${statePath}`);
console.log('');
console.log('接下来：');
console.log(`  cd "${PROJECT_DIR}"`);
console.log('  npm run setup              # 扫码绑定微信');
console.log('  npm run daemon -- start    # 注册并启动守护进程（Windows 用 npm run daemon:reinstall）');
