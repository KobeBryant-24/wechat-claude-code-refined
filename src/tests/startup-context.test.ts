import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRestartReason,
  looksLikeDeployCommand,
  findOrphanToolUse,
  buildStartupContextBlock,
  deployCompletionOverride,
  type StartupFacts,
} from '../claude/startup-context.js';

const TMP = mkdtempSync(join(tmpdir(), 'wcc-startup-ctx-'));

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(TMP, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

/** Build a transcript entry whose message content is the given blocks. */
function entry(content: unknown[]) {
  return { type: 'assistant', message: { role: 'assistant', content } };
}

function use(id: string, input: Record<string, unknown>) {
  return { type: 'tool_use', id, name: 'PowerShell', input };
}
function result(toolUseId: string) {
  return { type: 'tool_result', tool_use_id: toolUseId };
}

describe('parseRestartReason', () => {
  test('maps each watchdog reason verbatim', () => {
    for (const r of [
      'initial_startup',
      'manual_restart',
      'clean_exit_respawn',
      'crash_backoff_respawn',
    ]) {
      assert.equal(parseRestartReason(r), r);
    }
  });

  test('anything unrecognized is "unknown", not a crash', () => {
    assert.equal(parseRestartReason(undefined), 'unknown');
    assert.equal(parseRestartReason(''), 'unknown');
    assert.equal(parseRestartReason('manual-restart'), 'unknown');
  });
});

describe('looksLikeDeployCommand', () => {
  test('matches the commands that actually restart the bridge', () => {
    for (const cmd of [
      'npm run redeploy',
      'npm run deploy',
      'npm run daemon:restart',
      'node scripts/restart-bridge.cjs',
      'node scripts/windows-service.cjs restart',
      'curl -X POST http://127.0.0.1:9911/restart',
      'Invoke-RestMethod -Uri http://127.0.0.1:9911/restart -Method Post',
    ]) {
      assert.equal(looksLikeDeployCommand(cmd), true, `should match: ${cmd}`);
    }
  });

  // The test that matters most: a user asking *about* restarting, or a plain
  // read, must not be mistaken for the deploy itself.
  test('does not match ordinary commands', () => {
    for (const cmd of [
      'git status',
      'npm test',
      'npm run build',
      'Get-Content package.json',
      'echo "how do I restart the service?"',
      'rg restart src/',
    ]) {
      assert.equal(looksLikeDeployCommand(cmd), false, `should not match: ${cmd}`);
    }
  });

  test('undefined is not a deploy', () => {
    assert.equal(looksLikeDeployCommand(undefined), false);
  });
});

describe('findOrphanToolUse', () => {
  test('returns nothing when every tool_use got a result', () => {
    const path = writeTranscript('complete.jsonl', [
      entry([use('call_1', { command: 'npm test' })]),
      { type: 'user', message: { role: 'user', content: [result('call_1')] } },
    ]);
    assert.equal(findOrphanToolUse(path), undefined);
  });

  test('returns the command of the tool_use that never got a result', () => {
    const path = writeTranscript('orphan.jsonl', [
      entry([use('call_1', { command: 'npm test' })]),
      { type: 'user', message: { role: 'user', content: [result('call_1')] } },
      entry([use('call_2', { command: 'npm run redeploy' })]),
      // ...and then the process was SIGTERMed: no result for call_2.
    ]);
    assert.equal(findOrphanToolUse(path), 'npm run redeploy');
  });

  test('picks the LAST orphan when several went unanswered', () => {
    const path = writeTranscript('many-orphans.jsonl', [
      entry([use('call_1', { command: 'first' })]),
      entry([use('call_2', { command: 'second' })]),
      entry([use('call_3', { command: 'third' })]),
    ]);
    assert.equal(findOrphanToolUse(path), 'third');
  });

  test('falls back to description, then tool name, when there is no command', () => {
    const withDescription = writeTranscript('desc.jsonl', [
      entry([use('call_1', { description: 'restart the bridge' })]),
    ]);
    assert.equal(findOrphanToolUse(withDescription), 'restart the bridge');

    const bare = writeTranscript('bare.jsonl', [
      entry([{ type: 'tool_use', id: 'c1', name: 'PowerShell' }]),
    ]);
    assert.equal(findOrphanToolUse(bare), 'PowerShell');
  });

  test('survives a truncated final line and non-JSON noise', () => {
    const path = join(TMP, 'messy.jsonl');
    writeFileSync(
      path,
      JSON.stringify(entry([use('call_1', { command: 'npm test' })])) + '\n' +
        'not json at all\n' +
        '{"broken": \n' +
        JSON.stringify(entry([use('call_2', { command: 'npm run redeploy' })])) + '\n' +
        '{"partial": "cut off',
      'utf8',
    );
    assert.equal(findOrphanToolUse(path), 'npm run redeploy');
  });

  test('returns undefined for a missing file rather than throwing', () => {
    assert.equal(findOrphanToolUse(join(TMP, 'does-not-exist.jsonl')), undefined);
  });

  // The distinction that matters on a long transcript: an abandoned call from
  // an old turn stays unanswered forever. Reporting it as "the command that
  // just killed us" would be a confident lie.
  test('ignores a stale orphan from an old turn once later calls completed', () => {
    const path = writeTranscript('stale-orphan.jsonl', [
      entry([use('call_1', { command: 'abandoned long ago' })]),
      entry([use('call_2', { command: 'npm test' })]),
      { type: 'user', message: { role: 'user', content: [result('call_2')] } },
    ]);
    assert.equal(findOrphanToolUse(path), undefined);
  });

  test('reports the pending call when parallel tool_use blocks are answered out of order', () => {
    const path = writeTranscript('parallel.jsonl', [
      entry([use('a', { command: 'first' }), use('b', { command: 'npm run redeploy' })]),
      { type: 'user', message: { role: 'user', content: [result('a')] } },
    ]);
    assert.equal(findOrphanToolUse(path), 'npm run redeploy');
  });

  test('reports nothing once every parallel call is answered', () => {
    const path = writeTranscript('parallel-done.jsonl', [
      entry([use('a', { command: 'first' }), use('b', { command: 'second' })]),
      { type: 'user', message: { role: 'user', content: [result('a'), result('b')] } },
    ]);
    assert.equal(findOrphanToolUse(path), undefined);
  });

  // The window is a tail read, so the boundary can land mid-line. Whatever we
  // drop there must be the fragment only.
  test('still finds the orphan when the read window starts mid-line', () => {
    const path = writeTranscript('windowed.jsonl', [
      entry([use('call_1', { command: 'padding '.repeat(200) })]),
      entry([use('call_2', { command: 'npm run redeploy' })]),
    ]);
    assert.equal(findOrphanToolUse(path, 400), 'npm run redeploy');
  });

  // The bug this guards: `start - 1` is only readable when start > 0, and the
  // old code dropped the window's first line unconditionally — so every file
  // that fit inside the window lost one line, and a single-line file lost
  // everything. Sweep the file size across the boundary at 1-byte granularity:
  // the orphan must be found on both sides of it, and at every offset.
  test('finds the orphan at every file size straddling the window boundary', () => {
    const WINDOW = 512;
    for (let pad = 380; pad <= 620; pad++) {
      const path = writeTranscript(`sweep-${pad}.jsonl`, [
        entry([use('call_1', { command: 'p'.repeat(pad) })]),
        entry([use('call_2', { command: 'npm run redeploy' })]),
      ]);
      assert.equal(
        findOrphanToolUse(path, WINDOW),
        'npm run redeploy',
        `pad=${pad} (file ${statSync(path).size}B, window ${WINDOW}B)`,
      );
    }
  });

  // Same sweep for the negative case: a transcript whose calls all completed
  // must never report an orphan, at any size. A boundary that silently keeps
  // the first line would let a real orphan leak through as a false positive.
  test('reports nothing for a complete transcript at any size', () => {
    const WINDOW = 512;
    for (let pad = 380; pad <= 620; pad++) {
      const path = writeTranscript(`sweep-complete-${pad}.jsonl`, [
        entry([use('call_1', { command: 'p'.repeat(pad) })]),
        entry([use('call_2', { command: 'npm test' })]),
        { type: 'user', message: { role: 'user', content: [result('call_2')] } },
      ]);
      assert.equal(
        findOrphanToolUse(path, WINDOW),
        undefined,
        `pad=${pad} (file ${statSync(path).size}B, window ${WINDOW}B)`,
      );
    }
  });
});

describe('buildStartupContextBlock', () => {
  const base: StartupFacts = {
    restartReason: 'manual_restart',
    processStartedAt: new Date('2026-10-21T10:50:12').getTime(),
    diedMidTurn: true,
    interruptedCommand: 'npm run redeploy',
    interruptedCommandIsDeploy: true,
  };

  test('states the facts the transcript cannot show', () => {
    const block = buildStartupContextBlock(base, new Date('2026-10-21T10:50:49').getTime());
    assert.match(block, /2026-10-21 10:50:12/);
    assert.match(block, /37 秒/);
    assert.match(block, /主动重启/);
    assert.match(block, /npm run redeploy/);
    assert.match(block, /部署\/重启类：是/);
  });

  // The rule that actually flips the model's prior. Without it stated, the
  // model reads "no tool_result" as "failed" every time.
  test('states the no-tool_result-does-not-mean-failure rule explicitly', () => {
    const block = buildStartupContextBlock(base);
    assert.match(block, /没有 tool_result ≠ 命令失败/);
    assert.match(block, /默认假设那个动作已经成功/);
  });

  test('handles the no-interrupted-command case without claiming one', () => {
    const block = buildStartupContextBlock({
      ...base,
      interruptedCommand: undefined,
      interruptedCommandIsDeploy: false,
    });
    assert.match(block, /未能识别/);
    assert.doesNotMatch(block, /undefined/);
  });

  test('labels a crash restart as a crash, not a deliberate restart', () => {
    const block = buildStartupContextBlock({ ...base, restartReason: 'crash_backoff_respawn' });
    assert.match(block, /崩溃/);
  });
});

describe('deployCompletionOverride', () => {
  const deployFacts: StartupFacts = {
    restartReason: 'manual_restart',
    processStartedAt: 0,
    diedMidTurn: true,
    interruptedCommand: 'npm run redeploy',
    interruptedCommandIsDeploy: true,
  };

  test('a manual restart carrying a deploy is a completed deploy', () => {
    const o = deployCompletionOverride(deployFacts);
    assert.ok(o, 'expected an override');
    assert.equal(o?.resume, 'none');
    assert.equal(o?.overrideReason, 'deploy_completed_by_restart');
  });

  test('does not override a crash restart — that one really may need resuming', () => {
    assert.equal(
      deployCompletionOverride({ ...deployFacts, restartReason: 'crash_backoff_respawn' }),
      undefined,
    );
  });

  test('does not override when the interrupted command was ordinary work', () => {
    assert.equal(
      deployCompletionOverride({
        ...deployFacts,
        interruptedCommand: 'npm test',
        interruptedCommandIsDeploy: false,
      }),
      undefined,
    );
  });

  test('does not override a manual restart that interrupted no tool call', () => {
    assert.equal(
      deployCompletionOverride({
        ...deployFacts,
        interruptedCommand: undefined,
        interruptedCommandIsDeploy: false,
      }),
      undefined,
    );
  });
});

process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));