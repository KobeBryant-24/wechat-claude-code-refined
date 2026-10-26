import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyResumeSafetyGuards } from '../claude/resume-guards.js';

const NOW = 1_800_000_000_000;
const LONGO = NOW - 600_000; // 10 min ago — outside every "recent" window

const autoDecision = {
  action: 'notify' as const,
  message: '上次被打断了',
  resume: 'auto' as const,
};

/** Call with every guard-signal absent, so each test can introduce one. */
function guards(over: {
  query?: string;
  queryAt?: number;
  reapAt?: number;
  loop?: { autoResumeCount?: number; lastAutoResumeAt?: number };
} = {}) {
  return applyResumeSafetyGuards(
    autoDecision,
    over.query,
    over.queryAt,
    over.reapAt,
    NOW,
    over.loop,
  );
}

describe('pass-through', () => {
  test('silent stays silent', () => {
    const d = applyResumeSafetyGuards({ action: 'silent' }, undefined, undefined, undefined, NOW);
    assert.equal(d.action, 'silent');
    assert.equal(d.resume, 'none');
  });

  test('non-auto resume is passed through untouched, with no downgrade', () => {
    const d = applyResumeSafetyGuards(
      { action: 'notify', message: 'hi', resume: 'none' },
      'rm -rf everything',
      NOW - 1,
      NOW - 1,
      NOW,
    );
    assert.equal(d.resume, 'none');
    assert.equal(d.downgradeReason, undefined, 'guards only gate resume:auto');
  });

  test('a clean auto decision survives all guards', () => {
    const d = guards({ query: '看看日志', queryAt: LONGO, reapAt: LONGO });
    assert.equal(d.resume, 'auto');
    assert.equal(d.downgradeReason, undefined);
  });
});

describe('guard 1: dangerous keywords', () => {
  test('downgrades destructive queries', () => {
    for (const q of [
      'rm -rf /',
      'git reset --hard HEAD',
      'git push --force origin',
      'delete all the files',
      'format c:',
    ]) {
      const d = guards({ query: q, queryAt: LONGO });
      assert.equal(d.resume, 'ask', `should downgrade: ${q}`);
      assert.match(d.downgradeReason ?? '', /^dangerous_keyword:/);
    }
  });

  test('leaves ordinary queries alone', () => {
    for (const q of [
      '部署一下',
      '看看 /restart 这个逻辑',
      'rm 是什么命令',
      // Force-push detection must key on the flag, not on any "f" in the line.
      'git push origin main',
      'git push myfeature origin',
    ]) {
      const d = guards({ query: q, queryAt: LONGO });
      assert.equal(d.resume, 'auto', `should NOT downgrade: ${q}`);
    }
  });

  test('catches every spelling of a force push', () => {
    for (const q of [
      'git push -f origin',
      'git push --force origin',
      'git push --force-with-lease origin main',
    ]) {
      const d = guards({ query: q, queryAt: LONGO });
      assert.equal(d.resume, 'ask', `should downgrade: ${q}`);
    }
  });
});

describe('guard 2: recent orphan reap', () => {
  test('downgrades right after a reap', () => {
    const d = guards({ queryAt: LONGO, reapAt: NOW - 30_000 });
    assert.equal(d.resume, 'ask');
    assert.match(d.downgradeReason ?? '', /^recent_orphan_reap:/);
  });

  test('lets auto through once the reap window has passed', () => {
    const d = guards({ queryAt: LONGO, reapAt: NOW - 120_000 });
    assert.equal(d.resume, 'auto');
  });
});

describe('guard 3: query just before the crash', () => {
  test('downgrades when the user is likely still at the keyboard', () => {
    const d = guards({ queryAt: NOW - 2_000 });
    assert.equal(d.resume, 'ask');
    assert.match(d.downgradeReason ?? '', /^recent_user_query:/);
  });

  test('lets auto through for an older query', () => {
    const d = guards({ queryAt: NOW - 30_000 });
    assert.equal(d.resume, 'auto');
  });
});

describe('guard 0: auto-resume loop breaker', () => {
  test('trips on the third consecutive auto-resume inside the window', () => {
    const d = guards({
      queryAt: LONGO,
      loop: { autoResumeCount: 2, lastAutoResumeAt: NOW - 60_000 },
    });
    assert.equal(d.resume, 'ask');
    assert.match(d.downgradeReason ?? '', /^auto_resume_loop:2x$/);
  });

  // The message matters: the LLM's own text describes a cycle it can't see,
  // so the guard replaces it rather than trusting the model's read.
  test('replaces the message instead of passing the LLM text through', () => {
    const d = guards({
      queryAt: LONGO,
      loop: { autoResumeCount: 3, lastAutoResumeAt: NOW - 60_000 },
    });
    assert.notEqual(d.message, autoDecision.message);
    assert.match(d.message ?? '', /循环/);
    assert.match(d.message ?? '', /继续/);
  });

  test('allows the first and second attempt', () => {
    for (const n of [0, 1]) {
      const d = guards({
        queryAt: LONGO,
        loop: { autoResumeCount: n, lastAutoResumeAt: NOW - 60_000 },
      });
      assert.equal(d.resume, 'auto', `count=${n} should still auto`);
    }
  });

  test('does not trip on auto-resumes that are far in the past', () => {
    const d = guards({
      queryAt: LONGO,
      loop: { autoResumeCount: 5, lastAutoResumeAt: NOW - 60 * 60 * 1000 },
    });
    assert.equal(d.resume, 'auto', 'an hour-old count is not a live loop');
  });

  test('is inert when no loop state was recorded', () => {
    assert.equal(guards({ queryAt: LONGO }).resume, 'auto');
    assert.equal(
      applyResumeSafetyGuards(autoDecision, 'x', LONGO, undefined, NOW, {}).resume,
      'auto',
    );
  });

  // Ordering matters: the loop breaker is the most fundamental signal, so it
  // must win over the keyword guard rather than being masked by it.
  test('takes precedence over the dangerous-keyword guard', () => {
    const d = guards({
      query: 'rm -rf /',
      queryAt: LONGO,
      loop: { autoResumeCount: 2, lastAutoResumeAt: NOW - 60_000 },
    });
    assert.match(d.downgradeReason ?? '', /^auto_resume_loop:/);
  });
});