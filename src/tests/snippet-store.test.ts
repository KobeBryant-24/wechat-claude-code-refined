import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR is resolved at module load from WCC_DATA_DIR, so the env var has to
// be set before the store is first imported. Dynamic import, not static.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-snippet-test-'));
process.env.WCC_DATA_DIR = TMP_ROOT;

const store = await import('../claude/snippet-store.js');

describe('snippet id validation', () => {
  test('accepts 8 lowercase hex chars', () => {
    assert.equal(store.isValidSnippetId('a1b2c3d4'), true);
    assert.equal(store.isValidSnippetId('00000000'), true);
    assert.equal(store.isValidSnippetId('deadbeef'), true);
  });

  test('rejects uppercase — ids are generated lowercase and stay case-sensitive on disk', () => {
    assert.equal(store.isValidSnippetId('A1B2C3D4'), false);
  });

  test('rejects wrong length', () => {
    assert.equal(store.isValidSnippetId('a1b2c3'), false);
    assert.equal(store.isValidSnippetId('a1b2c3d4e5'), false);
  });

  // These arrive straight from a WeChat message and get joined onto a path.
  // Anything that could escape the snippets dir must be refused.
  test('rejects path traversal and separators', () => {
    for (const bad of [
      '../../etc',
      '..\\..\\win',
      '/etc/passwd',
      'C:evil',
      'a1b2c3d4/',
      'a1b2c3d4.md',
      './a1b2c3d4',
    ]) {
      assert.equal(store.isValidSnippetId(bad), false, `should reject: ${bad}`);
    }
  });
});

describe('save / read round-trip', () => {
  test('saves text and reads it back byte-identical', () => {
    const body = '第一行\n```json\n{"a":1}\n```\n~/.some/path\n最后一行';
    const saved = store.saveSnippet(body);
    assert.equal(saved.charCount, body.length);
    assert.equal(store.readSnippet(saved.id), body);
  });

  test('snippetPath rejects a malformed id instead of returning a usable path', () => {
    assert.equal(store.snippetPath('../../secret'), undefined);
  });

  test('reads back undefined for an id that was never written', () => {
    assert.equal(store.readSnippet('ffffffff'), undefined);
  });

  test('ids are unique across saves', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(store.saveSnippet(`body ${i}`).id);
    }
    assert.equal(ids.size, 50, 'expected 50 distinct ids');
  });
});

describe('cleanupExpiredSnippets', () => {
  test('removes entries past the 7-day window and keeps fresh ones', async () => {
    const old = store.saveSnippet('old body');
    const fresh = store.saveSnippet('fresh body');

    // Backdate `old` by 8 days, comfortably past retention.
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(TMP_ROOT, 'snippets', `${old.id}.md`), eightDaysAgo, eightDaysAgo);

    const removed = store.cleanupExpiredSnippets();
    assert.ok(removed >= 1, 'expected at least one removal');
    assert.equal(existsSync(join(TMP_ROOT, 'snippets', `${old.id}.md`)), false);
    assert.equal(existsSync(join(TMP_ROOT, 'snippets', `${fresh.id}.md`)), true);
  });

  test('is idempotent — a second sweep removes nothing more', () => {
    store.saveSnippet('another body');
    store.cleanupExpiredSnippets();
    assert.equal(store.cleanupExpiredSnippets(), 0);
  });
});

process.on('exit', () => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});