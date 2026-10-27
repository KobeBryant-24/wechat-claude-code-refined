import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { claudeConfigDir, claudeSkillsDir } from '../paths.js';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Only extracts `name` and `description` fields. Tolerant of CRLF line
 * endings (Windows-saved files) by matching `\r?\n` between markers and
 * stripping trailing `\r` from captured values.
 */
function parseSkillMd(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const frontmatter = match[1];
    // With CRLF input, `(.+)$` (m flag) still stops at the LF, leaving a
    // trailing \r on the captured value. Strip it explicitly.
    const stripCr = (s: string) => s.replace(/\r$/, '');
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

    if (!nameMatch) return null;

    return {
      name: stripCr(nameMatch[1]).trim().replace(/^["']|["']$/g, ''),
      description: descMatch
        ? stripCr(descMatch[1]).trim().replace(/^["']|["']$/g, '')
        : '',
    };
  } catch {
    logger.warn(`Failed to read SKILL.md: ${filePath}`);
    return null;
  }
}

/**
 * Scan a directory for SKILL.md files, reading skill info from each.
 */
function scanDirectory(baseDir: string, depth: number = 2): SkillInfo[] {
  const skills: SkillInfo[] = [];

  if (!existsSync(baseDir)) return skills;

  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const fullPath = join(baseDir, entry.name);

    // 早期版本把旧安装的备份留在 skills/ 下面（*.bak-*），那不是 skill。
    // 新版安装脚本会把它们挪到 <claudeDir>/skill-backups/，这里只是兜底。
    if (entry.name.includes('.bak-')) continue;

    // 目录联接 / 符号链接：readdir 的 Dirent 不跟随链接，isDirectory() 对
    // 链接返回 false，必须 stat 一次才知道它是不是目录。skill 正是用目录
    // 联接装进 <claudeConfigDir>/skills/ 的，不跟随就扫不到它。
    let isDir = entry.isDirectory();
    if (!isDir) {
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue; // 断掉的链接
      }
    }
    if (!isDir) continue;

    if (depth > 1) {
      // Recurse one level deeper
      skills.push(...scanDirectory(fullPath, depth - 1));
    }

    const skillFile = join(fullPath, 'SKILL.md');
    if (existsSync(skillFile)) {
      const info = parseSkillMd(skillFile);
      if (info) {
        skills.push({ ...info, path: fullPath });
      }
    }
  }

  return skills;
}

/**
 * Scan all known skill directories for installed Claude Code skills.
 *
 * `<claudeConfigDir>` is `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.
 *
 * Locations scanned:
 * 1. <claudeConfigDir>/skills/ (each subdirectory)
 * 2. <claudeConfigDir>/plugins/cache/{plugin}/skills/ (each subdirectory)
 * 3. <claudeConfigDir>/plugins/cache/{plugin}/superpowers/skills/ (each subdirectory)
 *
 * Directory junctions / symlinks are followed — see scanDirectory.
 */
export function scanAllSkills(): SkillInfo[] {
  const claudeDir = claudeConfigDir();
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  // 1. <claudeConfigDir>/skills/*/
  const userSkillsDir = claudeSkillsDir();
  for (const skill of scanDirectory(userSkillsDir, 1)) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      skills.push(skill);
    }
  }

  // 2. ~/.claude/plugins/cache/*/skills/*/
  const pluginsCacheDir = join(claudeDir, 'plugins', 'cache');
  if (existsSync(pluginsCacheDir)) {
    let cacheEntries: Dirent[];
    try {
      cacheEntries = readdirSync(pluginsCacheDir, { withFileTypes: true });
    } catch {
      cacheEntries = [];
    }

    for (const cacheEntry of cacheEntries) {
      // A plugin cache dir can itself be a junction (plugins installed by
      // link), and readdir's Dirent reports links as non-directories.
      let isDir = cacheEntry.isDirectory();
      if (!isDir) {
        try {
          isDir = statSync(join(pluginsCacheDir, cacheEntry.name)).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      const cacheDir = join(pluginsCacheDir, cacheEntry.name);

      // Regular skills
      const pluginSkillsDir = join(cacheDir, 'skills');
      for (const skill of scanDirectory(pluginSkillsDir, 1)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      }

      // Superpowers skills
      const superpowersSkillsDir = join(cacheDir, 'superpowers', 'skills');
      for (const skill of scanDirectory(superpowersSkillsDir, 1)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      }
    }
  }

  logger.info(`Scanned ${skills.length} skills`);
  return skills;
}

/**
 * Format a list of skills into a readable string for display.
 */
export function formatSkillList(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return 'No skills found.';
  }

  const lines = skills.map((s, i) => {
    const desc = s.description ? ` - ${s.description}` : '';
    return `  ${i + 1}. ${s.name}${desc}`;
  });

  return `Available skills (${skills.length}):\n${lines.join('\n')}`;
}

/**
 * Find a skill by name (case-insensitive match).
 */
export function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const lower = name.toLowerCase();
  return skills.find(
    (s) => s.name.toLowerCase() === lower || s.name.toLowerCase().replace(/\s+/g, '-') === lower,
  );
}
