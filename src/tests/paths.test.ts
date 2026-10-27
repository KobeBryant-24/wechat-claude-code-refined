import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

// src/paths.ts reads WCC_DATA_DIR at import time (through src/constants.ts),
// so point it at a temp dir before importing anything. The tests must never
// touch the real ~/.wechat-claude-code.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-paths-test-'));
process.env.WCC_DATA_DIR = TMP_ROOT;

const {
  claudeConfigDir,
  claudeProjectsDir,
  claudeSkillsDir,
  projectDir,
  installStatePath,
  readInstallState,
  writeInstallState,
  refreshInstallState,
  projectDirExists,
} = await import('../paths.js');

const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

describe('claudeConfigDir', () => {
  test('follows CLAUDE_CONFIG_DIR when it is set', () => {
    const custom = join(TMP_ROOT, 'custom-claude');
    process.env.CLAUDE_CONFIG_DIR = custom;
    assert.equal(claudeConfigDir(), resolve(custom));
  });

  test('falls back to ~/.claude when it is not set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(claudeConfigDir(), join(homedir(), '.claude'));
  });

  test('an empty or blank value counts as not set', () => {
    process.env.CLAUDE_CONFIG_DIR = '   ';
    assert.equal(claudeConfigDir(), join(homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = '';
    assert.equal(claudeConfigDir(), join(homedir(), '.claude'));
  });

  test('a relative value is resolved against the cwd', () => {
    process.env.CLAUDE_CONFIG_DIR = 'relative-claude-dir';
    assert.equal(claudeConfigDir(), resolve('relative-claude-dir'));
  });
});

describe('derived Claude directories', () => {
  test('projects and skills hang off the config dir', () => {
    const custom = join(TMP_ROOT, 'custom-claude');
    process.env.CLAUDE_CONFIG_DIR = custom;
    assert.equal(claudeProjectsDir(), join(resolve(custom), 'projects'));
    assert.equal(claudeSkillsDir(), join(resolve(custom), 'skills'));
  });

  test('they follow the config dir when it changes', () => {
    process.env.CLAUDE_CONFIG_DIR = join(TMP_ROOT, 'first');
    assert.equal(claudeSkillsDir(), join(resolve(TMP_ROOT), 'first', 'skills'));
    process.env.CLAUDE_CONFIG_DIR = join(TMP_ROOT, 'second');
    assert.equal(claudeSkillsDir(), join(resolve(TMP_ROOT), 'second', 'skills'));
  });
});

describe('projectDir', () => {
  test('points at the checkout root, not at dist/', () => {
    const dir = projectDir();
    assert.ok(existsSync(join(dir, 'package.json')), `${dir} should be the project root`);
    assert.ok(existsSync(join(dir, 'skill', 'SKILL.md')), `${dir} should hold the skill docs`);
  });

  test('is stable across calls', () => {
    assert.equal(projectDir(), projectDir());
  });
});

describe('install state', () => {
  before(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  test('is absent before anything is installed', () => {
    assert.equal(readInstallState(), null);
  });

  test('lives under the data dir', () => {
    assert.equal(installStatePath(), join(TMP_ROOT, 'install.json'));
  });

  test('round-trips through disk', () => {
    writeInstallState({ projectDir: '/some/where', skillDir: '/claude/skills/wechat-claude-code' });
    const state = readInstallState();
    assert.equal(state?.projectDir, '/some/where');
    assert.equal(state?.skillDir, '/claude/skills/wechat-claude-code');
  });

  test('refuses a record with no project dir', () => {
    writeFileSync(installStatePath(), JSON.stringify({ skillDir: '/x' }), 'utf-8');
    assert.equal(readInstallState(), null);
  });

  test('survives a corrupt record', () => {
    writeFileSync(installStatePath(), '{not json', 'utf-8');
    assert.equal(readInstallState(), null);
  });

  test('refresh records where the code actually lives', () => {
    const state = refreshInstallState();
    assert.equal(state.projectDir, projectDir());
    assert.ok(state.installedAt, 'an install timestamp is recorded');

    const onDisk = JSON.parse(readFileSync(installStatePath(), 'utf-8'));
    assert.equal(onDisk.projectDir, projectDir());
  });

  test('refresh keeps the original install timestamp', () => {
    const first = refreshInstallState();
    const second = refreshInstallState();
    assert.equal(second.installedAt, first.installedAt);
  });
});

describe('projectDirExists', () => {
  test('a real checkout passes', () => {
    assert.equal(projectDirExists(projectDir()), true);
  });

  test('a directory without package.json does not', () => {
    assert.equal(projectDirExists(TMP_ROOT), false);
  });
});
