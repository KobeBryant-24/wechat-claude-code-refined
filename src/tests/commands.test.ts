import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config file lives under the home directory, and both it and the
// snippet store resolve their paths at module load. Point the home directory
// at a temp dir before importing anything, so the tests neither read nor
// write the real ~/.wechat-claude-code.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'wcc-commands-test-'));
process.env.HOME = TMP_ROOT;
process.env.USERPROFILE = TMP_ROOT;

const { routeCommand } = await import('../commands/router.js');
const { loadConfig } = await import('../config.js');

type Session = import('../session.js').Session;
type CommandContext = import('../commands/router.js').CommandContext;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    workingDirectory: TMP_ROOT,
    state: 'idle',
    chatHistory: [],
    ...overrides,
  };
}

function makeCtx(session: Session, text: string): CommandContext {
  return {
    accountId: 'acct',
    session,
    updateSession: (partial: Partial<Session>) => { Object.assign(session, partial); },
    clearSession: () => makeSession(),
    startedAt: Date.now(),
    text,
  };
}

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('/compact-msg', () => {
  test('is off by default', () => {
    const session = makeSession();
    const result = routeCommand(makeCtx(session, '/compact-msg'));

    assert.equal(result.handled, true);
    assert.ok(result.reply!.includes('关闭'), result.reply);
  });

  test('on turns it on for this session, and it is remembered', () => {
    const session = makeSession();
    const result = routeCommand(makeCtx(session, '/compact-msg on'));

    assert.equal(result.handled, true);
    assert.equal(session.compactMsg, true);
    assert.ok(result.reply!.includes('已开启'));
  });

  test('off turns it back off', () => {
    const session = makeSession({ compactMsg: true });
    const result = routeCommand(makeCtx(session, '/compact-msg off'));

    assert.equal(session.compactMsg, false);
    assert.ok(result.reply!.includes('已关闭'));
  });

  test('status reports where the setting came from', () => {
    const session = makeSession({ compactMsg: true });
    const result = routeCommand(makeCtx(session, '/compact-msg status'));

    assert.ok(result.reply!.includes('开启'));
    assert.ok(result.reply!.includes('本会话设置'), result.reply);
  });

  test('a session that never chose inherits the service default', () => {
    const session = makeSession();
    const result = routeCommand(makeCtx(session, '/compact-msg'));

    assert.ok(result.reply!.includes('服务默认'), result.reply);
  });

  test('default on changes the service-level default', () => {
    const result = routeCommand(makeCtx(makeSession(), '/compact-msg default on'));
    assert.equal(result.handled, true);
    assert.equal(loadConfig().compactMsg, true);

    // A session that has not chosen now inherits "on".
    const inheriting = makeSession();
    const status = routeCommand(makeCtx(inheriting, '/compact-msg'));
    assert.ok(status.reply!.includes('开启'), status.reply);

    // Put it back.
    routeCommand(makeCtx(makeSession(), '/compact-msg default off'));
    assert.equal(loadConfig().compactMsg, false);
  });

  test('an unrecognized argument shows the usage', () => {
    const result = routeCommand(makeCtx(makeSession(), '/compact-msg maybe'));
    assert.equal(result.handled, true);
    assert.ok(result.reply!.includes('用法'), result.reply);
  });
});

describe('/continue', () => {
  test('is refused while a turn is running', () => {
    const session = makeSession({ state: 'processing', sdkSessionId: 'abc' });
    const result = routeCommand(makeCtx(session, '/continue'));

    assert.equal(result.handled, true);
    assert.equal(result.continueSession, undefined);
    assert.ok(result.reply!.includes('进行中'), result.reply);
  });

  test('is refused when there is no session to continue', () => {
    const session = makeSession();
    const result = routeCommand(makeCtx(session, '/continue'));

    assert.equal(result.handled, true);
    assert.equal(result.continueSession, undefined);
    assert.ok(result.reply!.includes('没有可续接的会话'), result.reply);
  });

  test('asks the caller to run a continuation', () => {
    const session = makeSession({ sdkSessionId: 'abc' });
    const result = routeCommand(makeCtx(session, '/continue'));

    assert.equal(result.handled, true);
    assert.equal(result.continueSession, true);
    // No chat reply: the continuation itself is the reply, and an
    // acknowledgement would spend a message of the user's budget.
    assert.equal(result.reply, undefined);
  });
});

describe('/stop', () => {
  test('says so when nothing is running', () => {
    const result = routeCommand(makeCtx(makeSession(), '/stop'));
    assert.equal(result.handled, true);
    assert.ok(result.reply!.includes('没有进行中的对话'), result.reply);
  });
});

describe('command routing', () => {
  test('an unknown command still falls through to the skill lookup', () => {
    const result = routeCommand(makeCtx(makeSession(), '/definitely-not-a-skill'));
    assert.equal(result.handled, true);
    assert.ok(result.reply!.includes('未找到 skill'), result.reply);
  });

  test('the config file the default was written to is a real file', () => {
    routeCommand(makeCtx(makeSession(), '/compact-msg default on'));
    const path = join(TMP_ROOT, '.wechat-claude-code', 'config.json');
    assert.ok(existsSync(path), path);
    assert.equal(JSON.parse(readFileSync(path, 'utf-8')).compactMsg, true);
    routeCommand(makeCtx(makeSession(), '/compact-msg default off'));
  });
});
