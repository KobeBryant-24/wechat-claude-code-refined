import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The watcher keeps its state under WCC_DATA_DIR. Point it at a temp dir
// before importing anything, so the tests never touch the real one.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-watch-test-'));
process.env.WCC_DATA_DIR = TMP_ROOT;

const {
  createSessionWatcher,
  parseTranscriptLine,
  isIdleTranscript,
  shortSessionId,
} = await import('../claude/session-watcher.js');

const SESSION_ID = 'abc12345-bef3-4bc8-93e1-ababe82a62e6';
const OTHER_ID = 'ffff0000-1111-2222-3333-444455556666';

/** A user message entry. */
function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    uuid: 'u-' + text.length,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  });
}

/** A user entry that carries a tool result — the tool talking, not the person. */
function toolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    uuid: 'u-tool',
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  });
}

/** An assistant entry. */
function assistantLine(stopReason: string, text = '', messageId = 'm1'): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    uuid: 'a-' + stopReason + '-' + text.length,
    timestamp: new Date().toISOString(),
    message: {
      id: messageId,
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      stop_reason: stopReason,
    },
  });
}

function writeTranscript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function appendTranscript(path: string, lines: string[]): void {
  appendFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function makeSender() {
  const sent: Array<{ toUserId: string; contextToken: string; text: string }> = [];
  return {
    sent,
    enqueue(toUserId: string, contextToken: string, text: string) {
      sent.push({ toUserId, contextToken, text });
    },
  };
}

let counter = 0;
function transcriptPath(): string {
  counter += 1;
  return join(TMP_ROOT, `sess-${counter}.jsonl`);
}

function storePath(): string {
  counter += 1;
  return join(TMP_ROOT, `watch-${counter}.json`);
}

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('parseTranscriptLine', () => {
  test('a user message is a prompt', () => {
    const event = parseTranscriptLine(userLine('do the thing'));
    assert.equal(event?.kind, 'user_prompt');
  });

  test('a tool result is not a prompt — the turn is still running', () => {
    assert.equal(parseTranscriptLine(toolResultLine()), null);
  });

  test('an assistant entry carries its stop reason', () => {
    const event = parseTranscriptLine(assistantLine('tool_use', 'working'));
    assert.equal(event?.kind, 'assistant');
    assert.equal((event as any).stopReason, 'tool_use');
    assert.equal((event as any).text, 'working');
  });

  test('a subagent turn is ignored', () => {
    const line = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' },
    });
    assert.equal(parseTranscriptLine(line), null);
  });

  test('metadata and garbage are ignored', () => {
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' })), null);
    assert.equal(parseTranscriptLine('not json'), null);
    assert.equal(parseTranscriptLine(''), null);
  });
});

describe('isIdleTranscript', () => {
  test('a final answer means the session is idle', () => {
    assert.equal(isIdleTranscript([userLine('hi'), assistantLine('end_turn', 'hello')]), true);
  });

  test('a tool call means the session is still working', () => {
    assert.equal(isIdleTranscript([userLine('hi'), assistantLine('tool_use', 'working')]), false);
  });

  test('a fresh prompt means the session is working', () => {
    assert.equal(isIdleTranscript([userLine('hi'), assistantLine('end_turn'), userLine('again')]), false);
  });

  test('an empty transcript is idle', () => {
    assert.equal(isIdleTranscript([]), true);
  });
});

describe('session watcher', () => {
  test('notifies when a running session finishes its turn', () => {
    const path = transcriptPath();
    writeTranscript(path, [userLine('do it'), assistantLine('tool_use', 'working')]);
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });

    const reg = watcher.register({
      sessionId: SESSION_ID,
      transcriptPath: path,
      toUserId: 'u1',
      contextToken: 'ctx',
    });
    assert.equal(reg.busy, true, 'the session was mid-turn');
    assert.equal(sender.sent.length, 0, 'registering does not notify');

    appendTranscript(path, [assistantLine('end_turn', 'all done')]);
    watcher.pollOnce();

    assert.equal(sender.sent.length, 1);
    assert.ok(sender.sent[0].text.includes('abc12345'), sender.sent[0].text);
    assert.ok(sender.sent[0].text.includes('已完成本轮'), sender.sent[0].text);
    assert.equal(sender.sent[0].toUserId, 'u1');
    assert.equal(watcher.current(), undefined, 'the watch is done');
  });

  test('a final answer with no prompt of its own does not count', () => {
    const path = transcriptPath();
    writeTranscript(path, [userLine('hi'), assistantLine('end_turn', 'hello')]);
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });

    const reg = watcher.register({
      sessionId: SESSION_ID,
      transcriptPath: path,
      toUserId: 'u1',
      contextToken: 'ctx',
    });
    assert.equal(reg.busy, false, 'the session was idle');

    // An answer to a turn whose prompt we never saw — not the turn we
    // were told to wait for.
    appendTranscript(path, [assistantLine('end_turn', 'stray')]);
    watcher.pollOnce();
    assert.equal(sender.sent.length, 0, 'no prompt, no notification');

    // Now the real turn starts and ends.
    appendTranscript(path, [userLine('again'), assistantLine('end_turn', 'ok')]);
    watcher.pollOnce();
    assert.equal(sender.sent.length, 1);
  });

  test('a tool result in the middle of a turn does not end the watch early', () => {
    const path = transcriptPath();
    writeTranscript(path, [userLine('hi'), assistantLine('end_turn', 'hello')]);
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });
    watcher.register({
      sessionId: SESSION_ID, transcriptPath: path, toUserId: 'u1', contextToken: 'ctx',
    });

    appendTranscript(path, [toolResultLine(), assistantLine('end_turn', 'still the same turn')]);
    watcher.pollOnce();
    assert.equal(sender.sent.length, 0, 'the tool result is not a turn boundary');
  });

  test('registering replaces the previous watch', () => {
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });
    const first = transcriptPath();
    const second = transcriptPath();
    writeTranscript(first, [userLine('a'), assistantLine('tool_use')]);
    writeTranscript(second, [userLine('b'), assistantLine('tool_use')]);

    watcher.register({ sessionId: SESSION_ID, transcriptPath: first, toUserId: 'u1', contextToken: 'ctx' });
    const reg = watcher.register({ sessionId: OTHER_ID, transcriptPath: second, toUserId: 'u1', contextToken: 'ctx' });

    assert.equal(reg.replaced?.sessionId, SESSION_ID);
    assert.equal(watcher.current()?.sessionId, OTHER_ID);

    // The replaced session finishing must not notify.
    appendTranscript(first, [assistantLine('end_turn', 'done')]);
    watcher.pollOnce();
    assert.equal(sender.sent.length, 0);
  });

  test('cancelling returns the watch it dropped', () => {
    const path = transcriptPath();
    writeTranscript(path, [userLine('a'), assistantLine('tool_use')]);
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });
    watcher.register({ sessionId: SESSION_ID, transcriptPath: path, toUserId: 'u1', contextToken: 'ctx' });

    const dropped = watcher.cancel();
    assert.equal(dropped?.sessionId, SESSION_ID);
    assert.equal(watcher.current(), undefined);

    // A cancelled watch stays cancelled.
    appendTranscript(path, [assistantLine('end_turn', 'done')]);
    watcher.pollOnce();
    assert.equal(sender.sent.length, 0);
  });

  test('the watch survives a restart', () => {
    // A fake Claude Code project directory, so the watcher can find the
    // transcript by session id on startup without touching the real one.
    const projects = join(TMP_ROOT, 'projects', 'proj-restart');
    mkdirSync(projects, { recursive: true });
    const path = join(projects, `${SESSION_ID}.jsonl`);
    const store = storePath();
    writeTranscript(path, [userLine('a'), assistantLine('tool_use')]);

    const first = createSessionWatcher({ sender: makeSender(), storePath: store, projectsDir: join(TMP_ROOT, 'projects') });
    first.register({ sessionId: SESSION_ID, transcriptPath: path, toUserId: 'u1', contextToken: 'ctx' });

    // A fresh daemon picks the watch back up.
    const sender = makeSender();
    const second = createSessionWatcher({ sender, storePath: store, projectsDir: join(TMP_ROOT, 'projects') });
    assert.equal(second.current()?.sessionId, SESSION_ID);

    appendTranscript(path, [assistantLine('end_turn', 'finished while we were down')]);
    second.pollOnce();
    assert.equal(sender.sent.length, 1, 'the completion is still reported');
  });

  test('a session that disappears ends the watch and says so', () => {
    const path = transcriptPath();
    writeTranscript(path, [userLine('a'), assistantLine('tool_use')]);
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });
    watcher.register({ sessionId: SESSION_ID, transcriptPath: path, toUserId: 'u1', contextToken: 'ctx' });

    unlinkSync(path);
    watcher.pollOnce();

    assert.equal(sender.sent.length, 1);
    assert.ok(sender.sent[0].text.includes('已不存在'), sender.sent[0].text);
    assert.equal(watcher.current(), undefined);
  });

  test('the notification carries a fresh context token', () => {
    const path = transcriptPath();
    writeTranscript(path, [userLine('a'), assistantLine('tool_use')]);
    const sender = makeSender();
    const watcher = createSessionWatcher({ sender, storePath: storePath() });
    watcher.register({ sessionId: SESSION_ID, transcriptPath: path, toUserId: 'u1', contextToken: 'old' });

    watcher.noteInbound('u1', 'fresh');
    appendTranscript(path, [assistantLine('end_turn', 'done')]);
    watcher.pollOnce();

    assert.equal(sender.sent[0].contextToken, 'fresh');
  });

  test('the watch is written to disk without the transcript path', () => {
    const path = transcriptPath();
    const store = storePath();
    writeTranscript(path, [userLine('a'), assistantLine('tool_use')]);
    const watcher = createSessionWatcher({ sender: makeSender(), storePath: store });
    watcher.register({ sessionId: SESSION_ID, transcriptPath: path, toUserId: 'u1', contextToken: 'ctx' });

    assert.ok(existsSync(store), store);
    const saved = JSON.parse(readFileSync(store, 'utf-8'));
    assert.equal(saved.sessionId, SESSION_ID);
    assert.equal(saved.transcriptPath, undefined, 'the path is resolved, not stored');
  });
});

describe('shortSessionId', () => {
  test('shows the same 8 characters as the /session listing', () => {
    assert.equal(shortSessionId(SESSION_ID), 'abc12345');
  });

  test('leaves a short id alone', () => {
    assert.equal(shortSessionId('abc'), 'abc');
    assert.equal(shortSessionId('abc123456789'), 'abc123456789');
  });
});
