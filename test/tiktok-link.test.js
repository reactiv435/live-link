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
      WebcastEvent: { LIKE: 'like', ROOM_USER: 'roomUser', STREAM_END: 'streamEnd' },
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
