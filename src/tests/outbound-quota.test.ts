import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OutboundQuota,
  withQuotaHint,
  QUOTA_EXHAUSTED_HINT,
  OUTBOUND_QUOTA,
} from '../wechat/outbound-quota.js';

describe('OutboundQuota', () => {
  test('a fresh user has a full budget', () => {
    const q = new OutboundQuota();
    assert.equal(q.usedFor('u1'), 0);
    assert.equal(q.nextSlot('u1'), 1);
    assert.equal(q.exhausted('u1'), false);
  });

  test('consume advances the slot and the count', () => {
    const q = new OutboundQuota();
    q.consume('u1');
    assert.equal(q.usedFor('u1'), 1);
    assert.equal(q.nextSlot('u1'), 2);
  });

  // The budget is per person, not per conversation. Two context tokens for
  // the same user draw from the same pool.
  test('the budget is per user, not per context token', () => {
    const q = new OutboundQuota();
    for (let i = 0; i < 5; i++) q.consume('u1');
    assert.equal(q.usedFor('u1'), 5);
    assert.equal(q.usedFor('u2'), 0, 'a different user has their own budget');
  });

  test('the budget is exhausted exactly at the limit', () => {
    const q = new OutboundQuota();
    for (let i = 0; i < OUTBOUND_QUOTA; i++) {
      assert.equal(q.exhausted('u1'), false, `must still have room after ${i + 1} sends`);
      q.consume('u1');
    }
    assert.equal(q.exhausted('u1'), true);
    assert.equal(q.usedFor('u1'), OUTBOUND_QUOTA);
  });

  // A new message from the user is the only thing that refills the quota.
  test('reset restores the full budget', () => {
    const q = new OutboundQuota();
    for (let i = 0; i < OUTBOUND_QUOTA; i++) q.consume('u1');
    assert.equal(q.exhausted('u1'), true);
    q.reset('u1');
    assert.equal(q.exhausted('u1'), false);
    assert.equal(q.usedFor('u1'), 0);
  });

  test('reset only touches the user it was given', () => {
    const q = new OutboundQuota();
    q.consume('u1');
    q.consume('u2');
    q.reset('u1');
    assert.equal(q.usedFor('u1'), 0);
    assert.equal(q.usedFor('u2'), 1);
  });
});

describe('withQuotaHint', () => {
  test('leaves every message but the last one untouched', () => {
    for (let slot = 1; slot < OUTBOUND_QUOTA; slot++) {
      assert.equal(withQuotaHint('hello', slot), 'hello', `slot ${slot} must not be decorated`);
    }
  });

  test('decorates the last message of the budget', () => {
    const out = withQuotaHint('hello', OUTBOUND_QUOTA);
    assert.ok(out.startsWith('hello'), 'the original text must survive');
    assert.ok(out.includes(QUOTA_EXHAUSTED_HINT), 'the hint must be present');
    assert.ok(out.includes('/continue'), 'the hint must name the way out');
  });

  test('a non-default limit decorates that limit instead', () => {
    const out = withQuotaHint('hello', 3, 3);
    assert.ok(out.includes(QUOTA_EXHAUSTED_HINT));
    assert.equal(withQuotaHint('hello', 2, 3), 'hello');
  });
});
