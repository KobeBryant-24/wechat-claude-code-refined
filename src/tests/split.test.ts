import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, splitMessageByBytes, MAX_CHUNK } from '../wechat/split.js';

describe('splitMessage', () => {
  test('short text is a single chunk', () => {
    assert.deepEqual(splitMessage('hello'), ['hello']);
  });

  test('text at the limit is a single chunk', () => {
    const text = 'a'.repeat(MAX_CHUNK);
    assert.deepEqual(splitMessage(text), [text]);
  });

  test('text past the limit is split', () => {
    const text = 'a'.repeat(MAX_CHUNK + 1);
    const chunks = splitMessage(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX_CHUNK);
    assert.equal(chunks[1].length, 1);
  });

  test('paragraph boundaries are preferred over hard cuts', () => {
    const para = 'x'.repeat(2000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = splitMessage(text);
    // Three whole paragraphs, each under the limit — the splitter takes the
    // paragraph boundary rather than filling a chunk to 4000 characters.
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) {
      assert.equal(chunk, para, 'each chunk must be exactly one paragraph');
    }
  });

  // The chunk count is a budget decision: the sender charges one quota unit
  // per chunk. If the split moved, the budget would move with it.
  test('the chunk count is stable for a given input', () => {
    const text = Array.from({ length: 60 }, (_, i) => `段落 ${i}\n` + '内容'.repeat(300)).join('\n\n');
    const first = splitMessage(text);
    const second = splitMessage(text);
    assert.deepEqual(first, second);
    assert.equal(first.join('').length <= text.length, true);
  });

  test('empty text yields no chunks', () => {
    assert.deepEqual(splitMessageByBytes(''), []);
  });
});

describe('splitMessageByBytes', () => {
  // 4000 characters of 4-byte code points is 16000 bytes — under the
  // server's 16384-byte ceiling, but a decoration on top would cross it.
  test('a chunk over the byte ceiling is cut further', () => {
    const text = '😀'.repeat(4000);
    const chunks = splitMessageByBytes(text);
    assert.ok(chunks.length > 1, 'must split');
    for (const chunk of chunks) {
      assert.ok(
        Buffer.byteLength(chunk, 'utf8') <= 16384,
        `chunk of ${Buffer.byteLength(chunk, 'utf8')} bytes exceeds the ceiling`,
      );
    }
  });

  test('every chunk stays within the byte ceiling', () => {
    const text = ('😀'.repeat(900) + '\n\n').repeat(20);
    for (const chunk of splitMessageByBytes(text)) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 16384);
    }
  });

  test('the content survives the split', () => {
    const text = '😀'.repeat(5000);
    const chunks = splitMessageByBytes(text);
    assert.equal(chunks.join(''), text, 'no characters may be lost');
  });

  test('ordinary text is unaffected', () => {
    const text = 'hello world';
    assert.deepEqual(splitMessageByBytes(text), [text]);
  });

  test('a custom byte ceiling is honoured', () => {
    const text = 'a'.repeat(100);
    const chunks = splitMessageByBytes(text, 100, 10);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 10);
    }
    assert.equal(chunks.join(''), text);
  });
});
