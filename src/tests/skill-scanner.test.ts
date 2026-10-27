import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { scanAllSkills } = await import('../claude/skill-scanner.js');

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-skill-scan-'));
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

/** Write a minimal SKILL.md with the given frontmatter. */
function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf-8',
  );
}

/**
 * Link a directory into the skills dir. Windows uses a junction (no admin
 * rights needed), POSIX uses a plain symlink — the same choice
 * scripts/install-skill.mjs makes.
 */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

describe('scanAllSkills', () => {
  test('finds a skill installed as a directory junction', () => {
    const claudeDir = join(TMP_ROOT, 'claude-junction');
    const source = join(TMP_ROOT, 'source-junction');
    const skillsDir = join(claudeDir, 'skills');

    writeSkill(source, 'linked-skill', '装在联接里的 skill');
    mkdirSync(skillsDir, { recursive: true });
    linkDir(source, join(skillsDir, 'linked-skill'));

    // Confirm the fixture really is a link, not a copy — otherwise the test
    // would pass for the wrong reason.
    assert.equal(lstatSync(join(skillsDir, 'linked-skill')).isSymbolicLink(), true);

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const found = scanAllSkills().find((s) => s.name === 'linked-skill');

    assert.ok(found, 'the junction must be followed');
    assert.equal(found?.description, '装在联接里的 skill');
    assert.equal(found?.path, join(skillsDir, 'linked-skill'));
  });

  test('still finds a skill installed as a plain directory', () => {
    const claudeDir = join(TMP_ROOT, 'claude-plain');
    const skillsDir = join(claudeDir, 'skills');

    writeSkill(join(skillsDir, 'plain-skill'), 'plain-skill', '直接放在 skills 目录里');

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const found = scanAllSkills().find((s) => s.name === 'plain-skill');

    assert.ok(found);
    assert.equal(found?.description, '直接放在 skills 目录里');
  });

  test('honors CLAUDE_CONFIG_DIR instead of ~/.claude', () => {
    const claudeDir = join(TMP_ROOT, 'claude-env');
    writeSkill(join(claudeDir, 'skills', 'env-skill'), 'env-skill', '只存在于自定义目录');

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const found = scanAllSkills().find((s) => s.name === 'env-skill');

    assert.ok(found, 'the custom config dir must be scanned');
  });

  test('a broken link is skipped instead of throwing', () => {
    const claudeDir = join(TMP_ROOT, 'claude-broken');
    const skillsDir = join(claudeDir, 'skills');

    mkdirSync(skillsDir, { recursive: true });
    linkDir(join(TMP_ROOT, 'does-not-exist'), join(skillsDir, 'broken-skill'));

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const found = scanAllSkills().find((s) => s.name === 'broken-skill');

    assert.equal(found, undefined, 'a dangling link yields no skill');
  });

  test('a directory without SKILL.md is skipped', () => {
    const claudeDir = join(TMP_ROOT, 'claude-empty');
    const skillsDir = join(claudeDir, 'skills');

    mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'not-a-skill', 'README.md'), 'no frontmatter here', 'utf-8');

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const found = scanAllSkills().find((s) => s.path === join(skillsDir, 'not-a-skill'));

    assert.equal(found, undefined);
  });
});
