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
    constructor(user, opts) { super(); this.user = user; this.opts = opts; made.push(this); }
    async connect() {
      const step = scenario.shift() || 'hang';
      if (step === 'live') { setImmediate(() => this.emit('connected', { roomId: 'R1' })); return { roomId: 'R1' }; }
      if (step === 'offline') throw new UserOfflineError("The requested user isn't online :(");
      if (step === 'ratelimit') throw new TypeError("Cannot read properties of undefined (reading 'retry-after')");
      if (step === 'neterr') throw new Error('getaddrinfo ENOTFOUND www.tiktok.com');
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
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
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
  assert.deepStrictEqual(likes.map(l => [l.count, l.total]), [[12, 4012], [3, 4015]]);
  link.stop();
});

test('not live -> offline, polled at the offline interval with backoff reset', async () => {
  const f = fakeLib(['offline']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  link.setOfflinePoll(90000);
  link.start('host');
  await tick();
  assert.strictEqual(link.state.status, 'offline');
  assert.strictEqual(link.state.error, null);
  assert.strictEqual(T.list.at(-1).ms, 90000);
  link.stop();
});

test('2.4.4 rate-limit TypeError waits at least 60 s', async () => {
  const f = fakeLib(['ratelimit']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  link.start('host');
  await tick();
  assert.strictEqual(link.state.errorKind, 'rate-limit');
  assert.ok(T.list.at(-1).ms >= 60000);
  link.stop();
});

test('network errors back off 10, 20, 40 s', async () => {
  const f = fakeLib(['neterr', 'neterr', 'neterr']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  link.start('host');
  const waits = [];
  for (let i = 0; i < 3; i++) {
    await tick();
    const h = T.list.at(-1); waits.push(h.ms);
    T.list = []; h.fn();
  }
  assert.deepStrictEqual(waits, [10000, 20000, 40000]);
  link.stop();
});

test('a dropped LIVE retries in 10 s; stop() mutes the old connection', async () => {
  const f = fakeLib(['live']);
  const T = timers();
  const link = new TikTokLink({ lib: f.lib, ...T });
  const states = [];
  link.on('state', s => states.push(s.status));
  link.start('host');
  await tick(); await tick();
  f.made[0].emit('disconnected');
  assert.strictEqual(link.state.status, 'reconnecting');
  assert.strictEqual(T.list.at(-1).ms, 10000);
  link.stop();
  const before = states.length;
  f.made[0].emit('like', { count: 1, total: '1' });
  f.made[0].emit('disconnected');
  assert.strictEqual(states.length, before, 'no events after stop');
});
