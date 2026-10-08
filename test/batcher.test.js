'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LikeBatcher, MAX_QUEUED_GIFTS } = require('../src/core/batcher');

test('first push reports the total from before our first batch, then the real total', () => {
  const b = new LikeBatcher('room1');
  const now = 1_000_000;
  b.add({ count: 15, total: '1015', at: now });          // v3 sends total as a string
  b.add({ count: 5, total: '1020', at: now + 200 });
  let t = b.take(now + 300, 0);
  assert.strictEqual(t.sessionTotal, 1000, 'baseline = total before the first batch');
  assert.strictEqual(t.rebaseline, true, 'a new batcher asks the site to baseline: nothing from before we watched counts');
  assert.deepStrictEqual(t.events.map(e => e.count), [20]);
  b.markSent(t.sessionTotal, t.rebaseline, t.gen);
  assert.ok(b.hasNews(), 'the real total is still unsent');
  t = b.take(now + 2300, 0);
  assert.strictEqual(t.sessionTotal, 1020);
  assert.strictEqual(t.events.length, 0);
  b.markSent(t.sessionTotal);
  assert.ok(!b.hasNews());
});

test('a defaulted total of "0" (proto v3 when the wire omits it) is NOT a room total', () => {
  const b = new LikeBatcher('r');
  b.add({ count: 3, total: '0', at: 1000 });
  assert.strictEqual(b.nextTotal(), null, 'no baseline from a defaulted 0');
  b.add({ count: 2, total: 1, at: 1100 });              // total below the batch size: also not usable
  assert.strictEqual(b.nextTotal(), null);
  b.add({ count: 5, total: 80000, at: 1200 });
  assert.strictEqual(b.nextTotal(), 79995, 'baseline comes from the first REAL total');
});

test('counts above 500 are split, events older than 9 s are dropped as stale', () => {
  const b = new LikeBatcher('r');
  const now = 5_000_000;
  b.add({ count: 1234, total: 99999, at: now });
  b.add({ count: 7, total: 100006, at: now - 20000 });   // 20 s old
  const t = b.take(now + 100, 0);
  assert.deepStrictEqual(t.events.map(e => e.count), [500, 500, 234]);
  assert.strictEqual(t.stale, 7);
  assert.ok(t.events.every(e => e.type === 'like' && !Number.isNaN(Date.parse(e.at))));
});

test('clock offset shifts event times to server time', () => {
  const b = new LikeBatcher('r');
  const now = Date.parse('2026-09-26T10:00:00.000Z');
  b.add({ count: 3, total: 10, at: now });
  const t = b.take(now + 100, 60000);
  assert.strictEqual(t.events[0].at, '2026-09-26T10:01:00.500Z');
});

test('more than 200 events keeps the newest 200', () => {
  const b = new LikeBatcher('r');
  const now = 9_000_000;
  for (let i = 0; i < 8; i++) b.add({ count: 500 * 30, total: 1e6 + i, at: now - i * 1000 });   // 8 s x 30 events
  const t = b.take(now + 100, 0);
  assert.strictEqual(t.events.length, 200);
  assert.strictEqual(t.dropped, 40);
});

test('rebaseNow: before a baseline it moves the baseline, after one it asks the site to re-baseline', () => {
  const b = new LikeBatcher('r');
  b.add({ count: 10, total: 510, at: 1 });
  b.rebaseNow();
  assert.strictEqual(b.nextTotal(), 510, 'no baseline yet: count from now');
  b.markSent(510);
  b.add({ count: 90, total: 600, at: 2 });
  b.rebaseNow();
  const t = b.take(3, 0);
  assert.strictEqual(t.rebaseline, true);
  assert.strictEqual(t.sessionTotal, 600);
  b.markSent(600, true);
  assert.strictEqual(b.rebase, false);
});

test('stale after a stop: waits for a fresh total, then baselines just before its first batch', () => {
  const b = new LikeBatcher('r');
  b.add({ count: 10, total: 110, at: 1000 });
  let t = b.take(1100, 0);
  b.markSent(t.sessionTotal, t.rebaseline, t.gen);           // baseline 100
  b.add({ count: 10, total: 120, at: 1200 });
  t = b.take(1300, 0);
  b.markSent(t.sessionTotal, t.rebaseline, t.gen);           // 120 sent, 20 credited
  b.markStale();                                             // Disconnect
  assert.strictEqual(b.nextTotal(), null, 'nothing to send until TikTok gives a fresh total');
  assert.ok(!b.hasNews());
  b.add({ count: 5, total: 905, at: 9000 });                 // 780 taps happened while not watching
  t = b.take(9100, 0);
  assert.strictEqual(t.sessionTotal, 900);
  assert.strictEqual(t.rebaseline, true);
  b.markSent(t.sessionTotal, t.rebaseline, t.gen);
  assert.strictEqual(b.nextTotal(), 905, 'the next push credits only the 5 seen after reconnecting');
});

test('a baseline requested while a push is in flight is not cancelled by that push', () => {
  const b = new LikeBatcher('r');
  b.add({ count: 10, total: 110, at: 1000 });
  const t = b.take(1100, 0);                                 // first push (baseline 100) goes out...
  b.add({ count: 300, total: 410, at: 1150 });
  b.rebaseNow();                                             // ...Test mode ends before its answer
  b.markSent(t.sessionTotal, t.rebaseline, t.gen);
  assert.strictEqual(b.rebase, true, 'still pending');
  assert.strictEqual(b.nextTotal(), 410, 'baseline at the moment of the request');
});

test('a fresh room (total == count) never reports 0', () => {
  const b = new LikeBatcher('r');
  b.add({ count: 7, total: '7', at: 1000 });
  assert.strictEqual(b.nextTotal(), 1);
});

test('gift batches stay under the size cap but always take at least one frame', () => {
  const b = new LikeBatcher('r');
  for (let i = 0; i < 40; i++) b.addGift({ key: 'm:' + 'k'.repeat(30) + i, count: 1, coins: 1, gift_id: '1', name: 'n'.repeat(60), user_handle: 'h'.repeat(60), user_name: 'u'.repeat(80), at: new Date().toISOString() });
  const first = b.takeGifts(50, 2000);
  assert.ok(first.length >= 1 && JSON.stringify(first).length <= 2000, `took ${first.length}`);
  const one = b.takeGifts(50, 10);
  assert.strictEqual(one.length, 1, 'a frame bigger than the cap still goes out alone');
  assert.strictEqual(b.gifts.length, 40 - first.length - 1);
});

test('frames of one combo still waiting to be sent merge into one item with the latest count', () => {
  const b = new LikeBatcher('r');
  const item = (count) => ({ key: 'c:abcdefabcdef:0', count, coins: 1, gift_id: '1', name: 'Rose', user_handle: 'm', user_name: 'M', at: new Date(1000 + count).toISOString() });
  for (let n = 1; n <= 5; n++) b.addGift(item(n));
  b.addGift(item(3));   // a stale lower frame never lowers it
  assert.strictEqual(b.gifts.length, 1);
  assert.strictEqual(b.gifts[0].count, 5);
});

test('the gift queue holds up to 20,000 items through a long outage, then drops the oldest and counts them', () => {
  const b = new LikeBatcher('R1');
  for (let i = 0; i < MAX_QUEUED_GIFTS + 5; i++) b.addGift({ key: 'm:' + String(i).padStart(10, '0'), count: 1 });
  assert.strictEqual(b.gifts.length, MAX_QUEUED_GIFTS);
  assert.strictEqual(b.droppedGifts, 5);
  assert.strictEqual(b.gifts[0].key, 'm:0000000005', 'the oldest went first');
  b.addGift({ key: 'm:' + String(MAX_QUEUED_GIFTS + 4).padStart(10, '0'), count: 3 });   // a newer frame of a queued combo merges
  assert.strictEqual(b.gifts.length, MAX_QUEUED_GIFTS);
  assert.strictEqual(b.gifts.at(-1).count, 3);
});
