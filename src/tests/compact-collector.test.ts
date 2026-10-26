import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CompactCollector,
  buildCompactMarkdown,
  decideCompactDelivery,
  DIRECT_SEND_MAX_BLOCKS,
  DIRECT_SEND_MAX_MS,
} from '../claude/compact-collector.js';

describe('CompactCollector', () => {
  test('keeps the order the turn produced', () => {
    const c = new CompactCollector();
    c.add('first', 'interstitial');
    c.add('second', 'final');
    c.add('third', 'final');

    const blocks = c.toBlocks();
    assert.deepEqual(blocks.map(b => b.text), ['first', 'second', 'third']);
    assert.deepEqual(blocks.map(b => b.role), ['interstitial', 'final', 'final']);
  });

  test('ignores empty messages', () => {
    const c = new CompactCollector();
    c.add('', 'final');
    c.add('   ', 'final');
    assert.equal(c.isEmpty, true);
    assert.equal(c.messageCount, 0);

    c.add('real', 'final');
    assert.equal(c.isEmpty, false);
    assert.equal(c.messageCount, 1);
  });

  test('splits a long message into the blocks WeChat would receive', () => {
    const c = new CompactCollector();
    // 9000 characters → three 4000-char chunks.
    c.add('x'.repeat(9000), 'final');

    const blocks = c.toBlocks();
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].text.length, 4000);
    assert.equal(blocks[2].text.length, 1000);
  });

  test('a message with a role keeps that role on every block it splits into', () => {
    const c = new CompactCollector();
    c.add('y'.repeat(5000), 'interstitial');

    const blocks = c.toBlocks();
    assert.equal(blocks.length, 2);
    for (const b of blocks) {
      assert.equal(b.role, 'interstitial');
    }
  });
});

describe('decideCompactDelivery', () => {
  const block = (n: number) => ({
    text: `block ${n}`,
    role: 'final' as const,
  });

  test('a short, quick turn is sent directly', () => {
    const blocks = [block(1), block(2), block(3), block(4)];
    const decision = decideCompactDelivery(blocks, 5_000);
    assert.equal(decision.mode, 'direct');
    assert.equal(decision.blocks.length, 4);
  });

  test('too many blocks goes to the file route', () => {
    const blocks = Array.from({ length: DIRECT_SEND_MAX_BLOCKS + 1 }, (_, i) => block(i));
    const decision = decideCompactDelivery(blocks, 5_000);
    assert.equal(decision.mode, 'file');
  });

  test('too slow goes to the file route', () => {
    const blocks = [block(1)];
    const decision = decideCompactDelivery(blocks, DIRECT_SEND_MAX_MS + 1);
    assert.equal(decision.mode, 'file');
  });

  test('exactly at both limits is still direct', () => {
    const blocks = Array.from({ length: DIRECT_SEND_MAX_BLOCKS }, (_, i) => block(i));
    const decision = decideCompactDelivery(blocks, DIRECT_SEND_MAX_MS);
    assert.equal(decision.mode, 'direct');
  });

  test('the file route is the fallback, not the default', () => {
    // One small block, fast: the common case must not cost a file.
    const decision = decideCompactDelivery([block(1)], 100);
    assert.equal(decision.mode, 'direct');
  });
});

describe('buildCompactMarkdown', () => {
  test('separates the blocks with a horizontal rule', () => {
    const md = buildCompactMarkdown(
      [
        { text: 'first block', role: 'final' },
        { text: 'second block', role: 'interstitial' },
      ],
      { generatedAt: Date.now(), elapsedMs: 12_000, aborted: false },
    );

    const lines = md.split('\n');
    assert.ok(lines[0].startsWith('# 微信对话记录'));
    assert.ok(md.includes('生成耗时：12 秒'));
    assert.ok(md.includes('消息块数：2'));
    assert.ok(md.includes('状态：完整'));

    // A rule between the two blocks — that is the only thing distinguishing
    // "two messages in one file" from "one long message".
    const separators = lines.filter(l => l.trim() === '---').length;
    assert.equal(separators, 2, 'one after the header, one between the blocks');

    assert.ok(md.includes('## 块 1 · 最终回答'));
    assert.ok(md.includes('## 块 2 · 过程说明'));
  });

  test('an aborted turn says so', () => {
    const md = buildCompactMarkdown(
      [{ text: 'partial', role: 'final' }],
      { generatedAt: Date.now(), elapsedMs: 1_000, aborted: true },
    );
    assert.ok(md.includes('状态：⚠️ 被中断，以上为已生成的部分'));
  });
});
