/**
 * 共享路径解析器。
 *
 * 之前 `src/` 里有 6 处各自独立地推导 Claude 配置目录
 * （`join(homedir(), '.claude', ...)`），改一处忘另一处就会漂移。这里
 * 收敛成一处，规则与 Claude Code CLI 自身完全一致：
 *
 *   1. 环境变量 `CLAUDE_CONFIG_DIR` 优先；
 *   2. 否则 `~/.claude`。
 *
 * 注意是「读实际环境」，不是把某个路径写死在代码里 —— 换机器、改配置目录
 * 都不需要动代码。
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './constants.js';

/** Claude Code 的配置目录根（`~/.claude` 或 `CLAUDE_CONFIG_DIR`）。 */
export function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), '.claude');
}

/** 会话转录目录（`<claudeConfigDir>/projects`）。 */
export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), 'projects');
}

/** 已安装 skill 的目录（`<claudeConfigDir>/skills`）。 */
export function claudeSkillsDir(): string {
  return join(claudeConfigDir(), 'skills');
}

/**
 * 本项目的运行目录 —— 源码、编译产物（`dist/`）、依赖（`node_modules/`）
 * 和守护进程都在这里。由模块自身位置推导，不依赖 cwd，也不写死。
 *
 * 编译后本文件位于 `<projectDir>/dist/paths.js`，所以往上一级就是运行目录。
 */
export function projectDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * 安装状态：记录「代码 clone 在哪」和「skill 装到哪」。
 *
 * skill 文档（`skill/SKILL.md`）需要知道运行目录才能给出正确的命令，但它
 * 自己不在运行目录里，所以由安装流程把这个对应关系写下来。守护进程启动时
 * 也会刷新一次，保证记录永远指向真实的运行位置。
 */
export interface InstallState {
  /** 代码运行目录（用户 clone 出来的那个目录）。 */
  projectDir: string;
  /** skill 在 Claude 全局目录里的安装位置。 */
  skillDir?: string;
  /** ISO 时间戳。 */
  installedAt?: string;
}

export function installStatePath(): string {
  return join(DATA_DIR, 'install.json');
}

export function readInstallState(): InstallState | null {
  try {
    const parsed = JSON.parse(readFileSync(installStatePath(), 'utf-8')) as InstallState;
    if (!parsed || typeof parsed.projectDir !== 'string' || !parsed.projectDir) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeInstallState(state: InstallState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(installStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * 守护进程启动时调用：把真实的运行位置写进安装状态。
 *
 * 只在记录缺失或指向别处时写入，避免每次启动都无谓地改文件。
 */
export function refreshInstallState(): InstallState {
  const current = readInstallState();
  const next: InstallState = {
    ...(current ?? {}),
    projectDir: projectDir(),
    installedAt: current?.installedAt ?? new Date().toISOString(),
  };
  if (!current || current.projectDir !== next.projectDir) {
    writeInstallState(next);
  }
  return next;
}

/** 运行目录是否确实存在（用于校验安装状态没有过期）。 */
export function projectDirExists(dir: string): boolean {
  return existsSync(join(dir, 'package.json'));
}
