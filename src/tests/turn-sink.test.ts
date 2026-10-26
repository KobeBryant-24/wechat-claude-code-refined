import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR is resolved at module load from WCC_DATA_DIR, so the env var has
// to be set before the sink is first imported. Dynamic import, not static.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-sink-test-'));
process.env.WCC_DATA_DIR = TMP_ROOT;

const { createNormalSink, createCompactSink } = await import('../claude/turn-sink.js');

interface Sent {
  kind: 'text' | 'file';
  text: string;
  filePath?: string;
  role: string;
}

/** A sender stand-in that records what it was asked to deliver. */
function makeSender() {
  const sent: Sent[] = [];
  return {
    sent,
    enqueue(_toUserId: string, _contextToken: string, text: string, role: 'interstitial' | 'final') {
      sent.push({ kind: 'text', text, role });
    },
    enqueueFile(_toUserId: string, _contextToken: string, filePath: string) {
      sent.push({ kind: 'file', text: '', filePath, role: 'final' });
    },
  };
}

const sinkOpts = (sender: ReturnType<typeof makeSender>) => ({
  sender,
  toUserId: 'u1',
  contextToken: 'ctx',
  cwd: process.cwd(),
});

/** Let the sink's promise chain run. */
const tick = () => new Promise(r => setTimeout(r, 5));

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('normal sink', () => {
  test('streams each piece as it arrives, before the turn ends', async () => {
    const sender = makeSender();
    const sink = createNormalSink(sinkOpts(sender));

    sink.emit('piece one', 'interstitial');
    sink.emit('piece two', 'final');

    await tick();

    // Delivered during the turn — not held back for the end.
    assert.equal(sender.sent.length, 2);
    assert.equal(sender.sent[0].text, 'piece one');
    assert.equal(sender.sent[1].text, 'piece two');
  });

  test('delivers the final text when nothing was streamed at all', async () => {
    const sender = makeSender();
    const sink = createNormalSink(sinkOpts(sender));

    await sink.deliver({ finalText: 'the whole answer', elapsedMs: 1_000 });

    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].text, 'the whole answer');
    assert.equal(sender.sent[0].role, 'final');
  });

  test('does not deliver the final text twice when the turn was streamed', async () => {
    const sender = makeSender();
    const sink = createNormalSink(sinkOpts(sender));

    sink.emit('streamed', 'final');
    await tick();
    await sink.deliver({ finalText: 'the whole answer', elapsedMs: 1_000 });

    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].text, 'streamed');
  });

  test('an empty turn delivers nothing', async () => {
    const sender = makeSender();
    const sink = createNormalSink(sinkOpts(sender));

    sink.emit('   ', 'final');
    await sink.deliver({ elapsedMs: 1_000 });

    assert.equal(sender.sent.length, 0);
  });
});

describe('compact sink', () => {
  test('holds everything back until the turn ends', async () => {
    const sender = makeSender();
    const sink = createCompactSink(sinkOpts(sender));

    sink.emit('piece one', 'interstitial');
    sink.emit('piece two', 'final');
    await tick();

    assert.equal(sender.sent.length, 0, 'nothing goes out while the turn runs');
  });

  test('a short, quick turn is delivered as its own messages, in order', async () => {
    const sender = makeSender();
    const sink = createCompactSink(sinkOpts(sender));

    sink.emit('piece one', 'interstitial');
    sink.emit('piece two', 'final');

    await sink.deliver({ finalText: 'piece one\n\npiece two', elapsedMs: 2_000 });

    assert.equal(sender.sent.length, 2);
    assert.equal(sender.sent[0].text, 'piece one');
    assert.equal(sender.sent[1].text, 'piece two');
    assert.equal(sender.sent[0].role, 'interstitial');
    assert.equal(sender.sent[1].role, 'final');
  });

  test('a long turn is delivered as a summary plus a file', async () => {
    const sender = makeSender();
    const sink = createCompactSink(sinkOpts(sender));

    sink.emit('z'.repeat(9000), 'final');

    // Aborted, so the summary call is skipped — this test is about the
    // delivery shape, not the summarizer.
    await sink.deliver({ finalText: 'z'.repeat(9000), elapsedMs: 40_000, aborted: true });

    assert.equal(sender.sent.length, 2);
    assert.equal(sender.sent[0].kind, 'text');
    assert.equal(sender.sent[1].kind, 'file');
    assert.ok(sender.sent[0].text.includes('已中断'), 'the header explains what happened');
    assert.ok(sender.sent[0].text.includes('📎 完整内容'), 'the text points at the file');

    // The file really is on disk, with the whole turn in it.
    const path = sender.sent[1].filePath!;
    assert.ok(existsSync(path), 'the attachment must exist');
    const md = readFileSync(path, 'utf-8');
    assert.ok(md.includes('z'.repeat(100)));
    assert.ok(md.includes('块 3'), 'the blocks are separated in the file');
  });

  test('a turn that produced nothing delivers nothing', async () => {
    const sender = makeSender();
    const sink = createCompactSink(sinkOpts(sender));

    await sink.deliver({ elapsedMs: 1_000 });

    assert.equal(sender.sent.length, 0);
  });

  test('the final text is used when the turn streamed nothing', async () => {
    const sender = makeSender();
    const sink = createCompactSink(sinkOpts(sender));

    await sink.deliver({ finalText: 'the whole answer', elapsedMs: 1_000 });

    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].text, 'the whole answer');
  });
});
