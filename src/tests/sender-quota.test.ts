import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR is resolved at module load from WCC_DATA_DIR, so the env var has to
// be set before the sender is first imported. Dynamic import, not static.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-sender-test-'));
process.env.WCC_DATA_DIR = TMP_ROOT;

const { createSender } = await import('../wechat/send.js');
const { QUOTA_EXHAUSTED_HINT, OUTBOUND_QUOTA } = await import('../wechat/outbound-quota.js');

interface SentMessage {
  toUserId: string;
  contextToken: string;
  text: string;
}

/** A WeChatApi stand-in that records what it was asked to send. */
class FakeApi {
  sent: SentMessage[] = [];
  circuitOpen = false;
  failWith: string | undefined;

  async sendMessage(req: any): Promise<void> {
    if (this.failWith) throw new Error(this.failWith);
    this.sent.push({
      toUserId: req.msg.to_user_id,
      contextToken: req.msg.context_token,
      text: req.msg.item_list[0].text_item.text,
    });
  }
  getCircuitRetryDelay(): number {
    return this.circuitOpen ? 30_000 : 0;
  }
  resetCircuit(): void {
    this.circuitOpen = false;
  }
  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }
  async getConfig(): Promise<any> {
    return { ret: 0, typing_ticket: '' };
  }
  async sendTyping(): Promise<void> {}
  async getUploadUrl(): Promise<any> {
    return { ret: 0 };
  }
}

const USER = 'test-user';

/**
 * Senders created by the tests, so the retry loop can be stopped at the end.
 *
 * A worker that keeps retrying an ordinary failure holds a timer open
 * forever, which keeps the test process alive after the assertions are done.
 */
const created: Array<{ clearQueue: (u: string, c: string) => number }> = [];

after(async () => {
  for (const sender of created) {
    sender.clearQueue(USER, '');
    sender.clearQueue('other-user', '');
  }
  // Give the workers a beat to notice the queue is empty and exit.
  await new Promise(r => setTimeout(r, 50));
});

/** Wait until `predicate` holds, or fail. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Let the worker's timers fire without asserting on them. */
function settle(ms = 120): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** A sender with no pacing, registered for cleanup. */
function makeSender(api: FakeApi) {
  const sender = createSender(api as any, 'test-account', { minSendIntervalMs: 0 });
  created.push(sender);
  return sender;
}

describe('sender outbound budget', () => {
  test('the budget stops sending at 10 and the 10th carries the hint', async () => {
    const api = new FakeApi();
    const sender = makeSender(api);

    for (let i = 0; i < 12; i++) {
      sender.enqueue(USER, 'ctx-1', `msg ${i}`, 'final');
    }

    await waitFor(() => api.sent.length === OUTBOUND_QUOTA, 'the budget to be spent');
    await settle();

    assert.equal(api.sent.length, OUTBOUND_QUOTA, 'must not send past the budget');
    assert.equal(sender.pendingCount(USER), 2, 'the rest must stay queued');

    // The hint rides on the last message of the budget — a separate message
    // would be rejected by the server, so it has to be free.
    const last = api.sent[OUTBOUND_QUOTA - 1];
    assert.ok(last.text.includes(QUOTA_EXHAUSTED_HINT), 'the 10th message must carry the hint');
    assert.ok(last.text.includes('msg 9'), 'the original content must survive');
    for (const earlier of api.sent.slice(0, OUTBOUND_QUOTA - 1)) {
      assert.ok(!earlier.text.includes(QUOTA_EXHAUSTED_HINT), 'only the last message is decorated');
    }
  });

  test('a new message from the user refills the budget and releases the backlog', async () => {
    const api = new FakeApi();
    const sender = makeSender(api);

    for (let i = 0; i < 12; i++) {
      sender.enqueue(USER, 'ctx-1', `msg ${i}`, 'final');
    }
    await waitFor(() => api.sent.length === OUTBOUND_QUOTA, 'the budget to be spent');
    assert.equal(sender.pendingCount(USER), 2);

    // The user writes again: quota refilled, breaker closed, backlog released.
    sender.noteInbound(USER, 'ctx-2');

    await waitFor(() => api.sent.length === 12, 'the backlog to be released');
    assert.equal(sender.pendingCount(USER), 0);
  });

  test('one user does not spend another user\'s budget', async () => {
    const api = new FakeApi();
    const sender = makeSender(api);

    for (let i = 0; i < 12; i++) {
      sender.enqueue(USER, 'ctx-1', `msg ${i}`, 'final');
    }
    await waitFor(() => api.sent.length === OUTBOUND_QUOTA, 'the budget to be spent');

    sender.enqueue('other-user', 'ctx-1', 'hello', 'final');
    await waitFor(() => api.sent.length === OUTBOUND_QUOTA + 1, 'the other user to be served');
    assert.equal(api.sent[OUTBOUND_QUOTA].toUserId, 'other-user');
  });
});

describe('sender queue keying', () => {
  // The queue used to be keyed by (user, contextToken). Every inbound
  // message carries a fresh contextToken, so each turn got its own queue —
  // and the previous turn's backlog was invisible to the next.
  test('messages from different turns share one queue', async () => {
    const api = new FakeApi();
    const sender = makeSender(api);

    sender.enqueue(USER, 'ctx-1', 'first', 'final');
    await waitFor(() => api.sent.length === 1, 'the first message to go out');

    sender.enqueue(USER, 'ctx-2', 'second', 'final');
    await waitFor(() => api.sent.length === 2, 'the second message to go out');

    assert.equal(sender.pendingCount(USER), 0);
  });

  test('queued messages are re-stamped with the newest context token', async () => {
    const api = new FakeApi();
    const sender = makeSender(api);

    // Spend the budget so the next message stays queued with a stale token.
    for (let i = 0; i < 12; i++) {
      sender.enqueue(USER, 'ctx-old', `msg ${i}`, 'final');
    }
    await waitFor(() => api.sent.length === OUTBOUND_QUOTA, 'the budget to be spent');
    assert.equal(api.sent[0].contextToken, 'ctx-old');

    sender.noteInbound(USER, 'ctx-new');
    await waitFor(() => api.sent.length === 12, 'the backlog to be released');

    // The two that were stuck must go out with the fresh token, not the one
    // they were queued with.
    assert.equal(api.sent[OUTBOUND_QUOTA].contextToken, 'ctx-new');
    assert.equal(api.sent[OUTBOUND_QUOTA + 1].contextToken, 'ctx-new');
  });
});

describe('sender halt semantics', () => {
  test('a send that cannot succeed stops the worker instead of retrying', async () => {
    const api = new FakeApi();
    api.failWith = 'circuit breaker open: outbound quota exhausted (ret:-2)';
    const sender = makeSender(api);

    sender.enqueue(USER, 'ctx-1', 'hello', 'final');
    await waitFor(() => sender.pendingCount(USER) === 1, 'the message to be put back');
    await settle(200);

    // One attempt, then silence. Retrying would be retrying a request that
    // cannot succeed, and each attempt spends more of a budget that is gone.
    assert.equal(api.sent.length, 0);
    assert.equal(sender.pendingCount(USER), 1, 'the message must survive for later');
  });

  test('an ordinary failure is retried', async () => {
    const api = new FakeApi();
    api.failWith = 'HTTP 503: service unavailable';
    const sender = makeSender(api);

    sender.enqueue(USER, 'ctx-1', 'hello', 'final');
    await waitFor(() => sender.pendingCount(USER) === 1, 'the message to be put back');
    await settle(200);

    // Still queued, but the worker is alive and will try again.
    assert.equal(sender.pendingCount(USER), 1);
  });
});

process.on('exit', () => rmSync(TMP_ROOT, { recursive: true, force: true }));
