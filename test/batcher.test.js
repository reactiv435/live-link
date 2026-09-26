'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LikeBatcher } = require('../src/core/batcher');

test('first push reports the total from before our first batch, then the real total', () => {
  const b = new LikeBatcher();
  b.reset('room1');
  const now = 1_000_000;
  b.add({ count: 15, total: '1015', at: now });          // v3 sends total as a string
  b.add({ count: 5, total: '1020', at: now + 200 });
  let t = b.take(now + 300, 0);
  assert.strictEqual(t.sessionTotal, 1000, 'baseline = total before the first batch');
  assert.deepStrictEqual(t.events.map(e => e.count), [20]);
  b.markSent(t.sessionTotal);
  assert.ok(b.hasNews(), 'the real total is still unsent');
  t = b.take(now + 2300, 0);
  assert.strictEqual(t.sessionTotal, 1020);
  assert.strictEqual(t.events.length, 0);
  b.markSent(t.sessionTotal);
  assert.ok(!b.hasNews());
});

test('counts above 500 are split, events older than 9 s are dropped as stale', () => {
  const b = new LikeBatcher();
  const now = 5_000_000;
  b.add({ count: 1234, total: 99999, at: now });
  b.add({ count: 7, total: 100006, at: now - 20000 });   // 20 s old
  const t = b.take(now + 100, 0);
  assert.deepStrictEqual(t.events.map(e => e.count), [500, 500, 234]);
  assert.strictEqual(t.stale, 7);
  assert.ok(t.events.every(e => e.type === 'like' && !Number.isNaN(Date.parse(e.at))));
});

test('clock offset shifts event times to server time', () => {
  const b = new LikeBatcher();
  const now = Date.parse('2026-09-26T10:00:00.000Z');
  b.add({ count: 3, total: 10, at: now });
  const t = b.take(now + 100, 60000);
  assert.strictEqual(t.events[0].at, '2026-09-26T10:01:00.500Z');
});

test('more than 200 events keeps the newest 200', () => {
  const b = new LikeBatcher();
  const now = 9_000_000;
  for (let i = 0; i < 8; i++) b.add({ count: 500 * 30, total: 1e6 + i, at: now - i * 1000 });   // 8 s x 30 events
  const t = b.take(now + 100, 0);
  assert.strictEqual(t.events.length, 200);
  assert.strictEqual(t.dropped, 40);
});

test('no total yet -> nothing to credit', () => {
  const b = new LikeBatcher();
  b.add({ count: 5, total: NaN, at: 1 });
  assert.strictEqual(b.nextTotal(), null);
});
