'use strict';
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const { TikTokLink } = require('../src/core/tiktok-link');

// A fake tiktok-live-connector with the same event names the real 2.4.4 uses.
function fakeLib(scenario) {
  class UserOfflineError extends Error {}
  class SignatureRateLimitError extends Error {}
  const made = [];
  class TikTokLiveConnection extends EventEmitter {
    constructor(user, opts) { super(); this.user = user; this.opts = opts; this.disconnected = false; made.push(this); }
    async connect() {
      const step = scenario.shift() || 'hang';
      if (step === 'live') { setImmediate(() => this.emit('connected', { roomId: 'R1' })); return { roomId: 'R1' }; }
      if (step === 'offline') throw new UserOfflineError("The requested user isn't online :(");
      if (step === 'ratelimit') throw new TypeError("Cannot read properties of undefined (reading 'retry-after')");
      if (step === 'neterr') throw new Error('getaddrinfo ENOTFOUND www.tiktok.com');
      if (step === 'deferred') return new Promise((resolve) => { this.finish = () => { this.emit('connected', { roomId: 'LATE' }); resolve(); }; });
      return new Promise(() => {});
    }
    disconnect() { this.disconnected = true; }
  }
  return {
    made,
    lib: {
      TikTokLiveConnection, UserOfflineError, SignatureRateLimitError,
      ControlEvent: { CONNECTED: 'connected', DISCONNECTED: 'disconnected', ERROR: 'error', WEBSOCKET_DATA: 'websocketData' },
      WebcastEvent: { LIKE: 'like', ROOM_USER: 'roomUser', STREAM_END: 'streamEnd', GIFT: 'gift' },
    },
  };
}

function timers() {
  const t = { list: [] };
  t.setTimeout = (fn, ms) => { const h = { fn, ms }; t.list.push(h); return h; };
  t.clearTimeout = (h) => { t.list = t.list.filter(x => x !== h); };
  t.setInterval = () => ({ interval: true });
  t.clearInterval = () => {};
  return t;
}
const tick = () => new Promise(r => setImmediate(r));

test('connects without replaying backlog and parses v3 likes (count + string total)', async () => {
  const f = fakeLib(['live']);
  const link = new TikTokLink({ lib: f.lib, ...timers() });
  const likes = [], rooms = [];
  link.on('like', l => likes.push(l));
  link.on('roomChanged', r => rooms.push(r));
  link.start('@The_Boneyard_AI');
  await tick(); await tick();
  assert.strictEqual(f.made[0].user, 'the_boneyard_ai');
  assert.strictEqual(f.made[0].opts.processInitialData, false);
  assert.strictEqual(link.state.status, 'live');
  assert.deepStrictEqual(rooms, ['R1']);
  f.made[0].emit('like', { count: 12, total: '4012', user: { displayId: 'fan' } });
  f.made[0].emit('like', { likeCount: 3, totalLikeCount: 4015 });            // older shape
  f.made[0].emit('like', { count: 4, total: '0' });                          // proto default: no total
  assert.deepStrictEqual(likes.map(l => [l.count, Number.isNaN(l.total) ? 'none' : l.total]), [[12, 4012], [3, 4015], [4, 'none']]);
  link.stop();
});

test('not live -> offline at the offline interval, and it resets the error backoff', async () => {
  const f = fakeLib(['neterr', 'neterr', 'offline', 'neterr']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  link.setOfflinePoll(90000);
  link.start('host');
  const waits = [];
  for (let i = 0; i < 4; i++) {
    await tick();
    const h = T.list.at(-1); waits.push([link.state.status, h.ms]);
    T.list = []; h.fn();
  }
  assert.deepStrictEqual(waits, [['error', 10000], ['error', 20000], ['offline', 90000], ['error', 10000]]);
  link.stop();
});

test('2.4.4 rate-limit TypeError waits at least 60 s, and Reconnect can not jump it', async () => {
  const f = fakeLib(['ratelimit']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  link.start('host');
  await tick();
  assert.strictEqual(link.state.errorKind, 'rate-limit');
  assert.ok(T.list.at(-1).ms >= 60000);
  link.retryNow();
  assert.strictEqual(f.made.length, 1, 'no new attempt during the rate-limit wait');
  link.stop();
});

test('a dropped LIVE retries in 10 s; Reconnect does nothing while live', async () => {
  const f = fakeLib(['live']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  link.start('host');
  await tick(); await tick();
  link.retryNow();
  assert.strictEqual(f.made.length, 1, 'a healthy socket is left alone');
  f.made[0].emit('disconnected');
  assert.strictEqual(link.state.status, 'reconnecting');
  assert.strictEqual(T.list.at(-1).ms, 10000);
  link.stop();
});

test('a connect still in flight when stop() runs can not change the state later', async () => {
  const f = fakeLib(['deferred']);
  const link = new TikTokLink({ lib: f.lib, ...timers() });
  link.start('host');
  await tick();
  const stale = f.made[0];
  link.stop();
  stale.finish();                                     // TikTok answers after we gave up
  await tick(); await tick();
  assert.strictEqual(link.state.status, 'idle');
  assert.strictEqual(link.state.roomId, null);
  assert.strictEqual(stale.disconnected, true, 'the late connection is closed');
});

test('TikTok "stream ended" goes straight to offline: no reconnect attempt, no drop', async () => {
  const f = fakeLib(['live']);
  const tm = timers();
  const link = new TikTokLink({ lib: f.lib, ...tm });
  const states = [];
  link.on('state', (st) => states.push(st.status));
  link.start('host');
  await tick(); await tick();
  assert.strictEqual(link.state.status, 'live');
  f.made[0].emit('streamEnd', { action: 3 });
  f.made[0].emit('disconnected');
  assert.strictEqual(link.state.status, 'offline');
  assert.ok(!states.includes('reconnecting'));
  assert.strictEqual(tm.list[tm.list.length - 1].ms, link.offlinePollMs, 'next check at the offline interval');
});

function giftFrame({ count = 1, end = 0, coins = 1, type = 1, combo = true, group = 'G1', giftId = '5655', name = 'Rose', user = 'maria', to = 'host', msgId } = {}) {
  return { giftId, repeatCount: count, repeatEnd: end, groupId: group, common: { msgId: msgId || String(Math.random()).slice(2) },
    gift: { id: giftId, name, type, combo, diamondCount: coins, image: { urlList: ['https://p16-webcast.tiktokcdn.com/rose.png'] } },
    user: { userId: 'u-' + user, displayId: user, nickname: user.toUpperCase() }, toUser: to ? { displayId: to } : undefined };
}

test('gifts (no group id): a combo credits each new step once; a repeated end and stale frames add nothing; a new combo gets a new key', async () => {
  const f = fakeLib(['live']);
  const link = new TikTokLink({ lib: f.lib, ...timers() });
  const got = [];
  link.on('gift', (g) => got.push(g));
  link.start('host');
  await tick(); await tick();
  const c = f.made[0];
  c.emit('gift', giftFrame({ count: 1, group: '0' }));   // no group id: the end/gap rules apply
  c.emit('gift', giftFrame({ count: 2, group: '0' }));
  c.emit('gift', giftFrame({ count: 2, group: '0' }));            // repeated frame
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '0' }));     // end (frames 3-4 were lost)
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '0' }));     // the same end again
  c.emit('gift', giftFrame({ count: 1, group: '0' }));             // a NEW combo (lower count after an end)
  assert.deepStrictEqual(got.map((g) => [g.count, g.units]), [[1, 1], [2, 1], [5, 3], [1, 1]]);
  assert.strictEqual(got[0].key, got[2].key, 'same combo, same key');
  assert.notStrictEqual(got[3].key, got[0].key, 'new combo, new key');
  assert.match(got[0].key, /^[A-Za-z0-9:_.-]{8,120}$/);
  assert.strictEqual(got[0].coins, 1);
  assert.strictEqual(got[0].userHandle, 'maria');
  assert.strictEqual(got[0].imageUrl, 'https://p16-webcast.tiktokcdn.com/rose.png');
});

test('gifts: single gifts count once per message; unpriced gifts and gifts to another host are skipped', async () => {
  const f = fakeLib(['live']);
  const link = new TikTokLink({ lib: f.lib, ...timers() });
  const got = [];
  link.on('gift', (g) => got.push(g));
  link.start('host');
  await tick(); await tick();
  const c = f.made[0];
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '777' }));
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '777' }));   // delivered twice
  c.emit('gift', giftFrame({ coins: 0, name: 'Free gift' }));
  c.emit('gift', giftFrame({ to: 'someone_else', coins: 5 }));
  assert.strictEqual(got.length, 1);
  assert.match(got[0].key, /^m:[A-Za-z0-9:_.-]{6,118}$/, 'a short message id is hashed so keys are 8+ chars');
  assert.strictEqual(got[0].units, 1);
  assert.strictEqual(got[0].coins, 1000);
});

test('gifts: names are cut without splitting an emoji, and a missing handle falls back so the site never refuses it', async () => {
  const f = fakeLib(['live']);
  const link = new TikTokLink({ lib: f.lib, ...timers() });
  const got = [];
  link.on('gift', (g) => got.push(g));
  link.start('host');
  await tick(); await tick();
  const frame = giftFrame({ type: 0, combo: false, msgId: '123456789' });
  frame.user = { userId: 'u9', nickname: 'A'.repeat(79) + '\u{1F525}\u{1F525}' };   // no handle; emoji straddles the 80 cut
  frame.gift.name = 'B'.repeat(59) + '\u{1F339}';
  f.made[0].emit('gift', frame);
  const g = got[0];
  assert.ok(g.userHandle.length > 0 && g.userHandle.length <= 60, 'handle never empty');
  assert.ok(g.userName.length <= 80);
  assert.ok(g.name.length <= 60);
  for (const v of [g.userHandle, g.userName, g.name]) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v), `no lone surrogate in ${JSON.stringify(v)}`);
});

test('gifts with a real group id: a late lower frame is stale, never a new combo; the end frame is recorded', async () => {
  const f = fakeLib(['live']);
  const link = new TikTokLink({ lib: f.lib, ...timers() });
  const got = [];
  link.on('gift', (g) => got.push(g));
  link.start('host');
  await tick(); await tick();
  const c = f.made[0];
  for (let n = 1; n <= 5; n++) c.emit('gift', giftFrame({ count: n, group: '1759900000123' }));
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '1759900000123' }));   // real end frames repeat the last count
  c.emit('gift', giftFrame({ count: 4, group: '1759900000123' }));           // a stray late frame
  assert.deepStrictEqual(got.map((g) => g.units), [1, 1, 1, 1, 1], '5 units, nothing extra');
  assert.ok(got.every((g) => g.key === got[0].key));
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 60000, msgId: '99999999' }));   // out of range: skipped
  assert.strictEqual(got.length, 5);
});

// ---------------------------------------------------------------- 1.0.5

function clockLink(scenario) {
  const f = fakeLib(scenario);
  const T = timers();
  const clock = { t: 1000 };
  const link = new TikTokLink({ lib: f.lib, ...T, mono: () => clock.t, now: () => clock.t });
  return { f, T, clock, link, fire: () => { const h = T.list.at(-1); T.list = []; h.fn(); return h.ms; } };
}

test('an ended LIVE that TikTok hands out again is "not live" until real LIVE data arrives; each repeat waits longer', async () => {
  const { f, T, clock, link, fire } = clockLink(['live', 'live', 'live', 'live']);
  link.setOfflinePoll(30000);
  const states = [];
  link.on('state', (st) => states.push(st.status));
  link.start('host');
  await tick(); await tick();
  assert.strictEqual(link.state.status, 'live');
  f.made[0].emit('streamEnd', { action: 3 });
  f.made[0].emit('disconnected');
  assert.strictEqual(link.state.status, 'offline');
  assert.strictEqual(fire(), 30000);
  await tick(); await tick();                                         // TikTok offers room R1 again
  assert.strictEqual(link.state.status, 'connecting', 'not reported as LIVE');
  clock.t += 21000; link._tick();                                     // no LIVE data within 20 s
  assert.strictEqual(link.state.status, 'offline');
  assert.strictEqual(T.list.at(-1).ms, 60000, 'checks again in 2x the offline interval');
  fire(); await tick(); await tick();
  f.made[2].emit('disconnected');                                     // closes again
  assert.strictEqual(link.state.status, 'offline');
  assert.strictEqual(T.list.at(-1).ms, 120000, '4x');
  fire(); await tick(); await tick();
  assert.strictEqual(link.state.status, 'connecting');
  f.made[3].emit('roomUser', { viewerCount: 12 });                    // real LIVE data: it is back
  assert.strictEqual(link.state.status, 'live');
  assert.strictEqual(link.state.roomId, 'R1');
  assert.strictEqual(states.filter((s, i) => s === 'live' && states[i - 1] !== 'live').length, 2, 'only the real LIVE moments were "live"');
  link.stop();
});

test('a room that drops right after connecting backs off (up to 40 s); a minute up resets the backoff', async () => {
  const { f, clock, link, fire } = clockLink(['live', 'live', 'live', 'live', 'live', 'live']);
  link.start('host');
  const waits = [];
  for (let i = 0; i < 4; i++) {
    await tick(); await tick();
    f.made[i].emit('disconnected');
    waits.push(fire());
  }
  assert.deepStrictEqual(waits, [10000, 20000, 40000, 40000]);
  await tick(); await tick();
  clock.t += 61000; link._tick();                                    // up for a minute: healthy
  f.made[4].emit('disconnected');
  assert.strictEqual(fire(), 10000);
  link.stop();
});

test('a hung connect is given up after 90 s, and the message no longer blames the internet', async () => {
  const { clock, link } = clockLink(['hang']);
  link.start('host');
  await tick();
  clock.t += 60000; link._tick();
  assert.strictEqual(link.state.status, 'connecting', 'still waiting at 60 s');
  clock.t += 31000; link._tick();
  assert.strictEqual(link.state.status, 'error');
  assert.strictEqual(link.state.errorKind, 'timeout');
  assert.doesNotMatch(link.state.error, /internet/);
  link.stop();
});

test('TikTok calls get one retry each (they used to retry twice and outlast the connect cutoff)', async () => {
  const { f, link } = clockLink(['live']);
  link.start('host');
  await tick();
  assert.deepStrictEqual(f.made[0].opts.webClientOptions, { retry: { limit: 1 } });
  link.stop();
});

test('waking from sleep reconnects at once, but never inside a rate-limit wait', async () => {
  const { f, link } = clockLink(['offline', 'live', 'ratelimit']);
  link.start('host');
  await tick();
  assert.strictEqual(link.state.status, 'offline');
  link.wake(true);
  await tick(); await tick();
  assert.strictEqual(f.made.length, 2);
  assert.strictEqual(link.state.status, 'live');
  link.wake(false);                                                   // unlock with a healthy socket: left alone
  assert.strictEqual(f.made.length, 2);
  link.wake(true);                                                    // after sleep the socket is suspect
  await tick();
  assert.strictEqual(f.made.length, 3);
  assert.strictEqual(link.state.errorKind, 'rate-limit');
  link.wake(true);
  assert.strictEqual(f.made.length, 3, 'the rate-limit wait is honoured');
  link.stop();
});

test('the silent-socket reconnect works in the first 5 minutes after start too', async () => {
  const { f, clock, link } = clockLink(['live', 'live']);
  clock.t = 5000;                                                     // the steady clock starts near 0 at launch
  link.start('host');
  await tick(); await tick();
  clock.t += 121000; link._tick();
  assert.strictEqual(f.made.length, 2, 'reconnected once');
  link.stop();
});
