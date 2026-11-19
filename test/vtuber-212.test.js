'use strict';
// 2.1.2: TikTok events for a VTuber on this computer (src/core/vtuber-link.js). Every test talks to a local HTTP server
// on a random free port (never the real 8791) and never to TikTok or the site's real endpoints.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TikTokLink } = require('../src/core/tiktok-link');
const { VtuberLink, buildEvent, DEFAULT_PORT, PATH, PROBE_EVERY_MS, LIKE_EVERY_MS } = require('../src/core/vtuber-link');
const { createMock } = require('./mock-server');
const { LiveLinkApi } = require('../src/core/api');
const { Controller } = require('../src/core/controller');
const { Store } = require('../src/core/store');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); } return false; }
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Every server, link and timer a test opens is closed in its t.after, so a failing test can't keep this file running.
// The file-level after() is the last net for the stand-in servers.
const openServers = new Set();
after(async () => { for (const s of [...openServers]) await s.close(); });

// A stand-in VTuber server. mode: 'ok' (GET 200 {ok,v}, POST 204) | 'down' (GET 503: something answers, not a VTuber).
function vtuberServer() {
  const s = { mode: 'ok', gets: [], posts: [] };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rec = { at: Date.now(), method: req.method, url: req.url, headers: req.headers, remote: req.socket.remoteAddress };
      if (req.method === 'GET') {
        s.gets.push(rec);
        if (s.mode === 'ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, v: 1 })); }
        else { res.writeHead(503); res.end(); }
        return;
      }
      rec.body = body;
      try { rec.json = JSON.parse(body); } catch {}
      s.posts.push(rec);
      res.writeHead(s.mode === 'ok' ? 204 : 503); res.end();
    });
  });
  s.listen = () => new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; r(s.port); }));
  s.close = () => s.closing || (s.closing = new Promise((r) => {   // safe to call twice
    openServers.delete(s);
    s.server.closeAllConnections && s.server.closeAllConnections();
    s.server.close(() => r());
  }));
  openServers.add(s);
  s.events = (type) => s.posts.filter((p) => p.json && (!type || p.json.type === type)).map((p) => p.json);
  return s;
}

// A port nothing listens on (taken and released at once).
function deadPort() {
  return new Promise((r) => { const srv = http.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
}

// Stands in for TikTokLink: state + events only.
class FakeLink extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle', roomId: null }; }
  set(status, roomId = 'R1') { this.state = { ...this.state, status, roomId }; this.emit('state', { ...this.state }); }
}

// A fake tiktok-live-connector with the same event names the real 2.4.4 uses (incl. chat / follow / share / social).
function fakeLib(scenario) {
  const made = [];
  class TikTokLiveConnection extends EventEmitter {
    constructor(user, opts) { super(); this.user = user; this.opts = opts; made.push(this); }
    async connect() {
      const step = scenario.shift() || 'hang';
      if (step === 'live') { setImmediate(() => this.emit('connected', { roomId: 'R1' })); return { roomId: 'R1' }; }
      return new Promise(() => {});
    }
    disconnect() {}
  }
  return {
    made,
    lib: {
      TikTokLiveConnection, UserOfflineError: class extends Error {}, SignatureRateLimitError: class extends Error {},
      ControlEvent: { CONNECTED: 'connected', DISCONNECTED: 'disconnected', ERROR: 'error', WEBSOCKET_DATA: 'websocketData' },
      WebcastEvent: { LIKE: 'like', ROOM_USER: 'roomUser', STREAM_END: 'streamEnd', GIFT: 'gift', CHAT: 'chat', FOLLOW: 'follow', SHARE: 'share', SOCIAL: 'social' },
    },
  };
}
const noTimers = { setInterval: () => ({}), clearInterval: () => {} };

function giftFrame({ count = 1, end = 0, coins = 1, type = 1, combo = true, group = 'G1', giftId = '5655', name = 'Rose', user = 'maria', to = 'host', msgId } = {}) {
  return { giftId, repeatCount: count, repeatEnd: end, groupId: group, common: { msgId: msgId || String(Math.random()).slice(2) },
    gift: { id: giftId, name, type, combo, diamondCount: coins, image: { urlList: ['https://p16-webcast.tiktokcdn.com/rose.png'] } },
    user: { userId: 'u-' + user, displayId: user, nickname: user.toUpperCase() }, toUser: to ? { displayId: to } : undefined };
}

async function liveLink(t, scenario = ['live'], user = 'host') {
  const f = fakeLib(scenario);
  const logs = [];
  const link = new TikTokLink({ lib: f.lib, ...noTimers, log: (l, m) => logs.push(`${l} ${m}`) });
  t.after(() => link.stop());
  link.start(user);
  await tick(); await tick();
  return { f, link, logs, c: f.made[0] };
}

// ---------------------------------------------------------------- tiktok-link: the local-only events

test('giftEnd: one per finished combo (its end frame, final count) and one per single gift; the credited gift frames are unchanged', async (t) => {
  const { link, c } = await liveLink(t);
  const gifts = [], ends = [];
  link.on('gift', (g) => gifts.push(g));
  link.on('giftEnd', (g) => ends.push(g));
  // the same frames as the 1.0.4 no-group-id test: crediting must come out exactly as before
  c.emit('gift', giftFrame({ count: 1, group: '0' }));
  c.emit('gift', giftFrame({ count: 2, group: '0' }));
  c.emit('gift', giftFrame({ count: 2, group: '0' }));             // repeated frame
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '0' }));     // end (frames 3-4 were lost)
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '0' }));     // the same end again
  c.emit('gift', giftFrame({ count: 1, group: '0' }));             // a NEW combo, not finished yet
  assert.deepEqual(gifts.map((g) => [g.count, g.units]), [[1, 1], [2, 1], [5, 3], [1, 1]]);
  assert.deepEqual(ends.map((e) => [e.key, e.count]), [[gifts[0].key, 5]], 'one end, with the final count');
  // with a real group id: frames 1..5, the end repeats 5, a stray late frame, the end again
  for (let n = 1; n <= 5; n++) c.emit('gift', giftFrame({ count: n, group: '1759900000123', user: 'ben' }));
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '1759900000123', user: 'ben' }));
  c.emit('gift', giftFrame({ count: 4, group: '1759900000123', user: 'ben' }));
  c.emit('gift', giftFrame({ count: 5, end: 1, group: '1759900000123', user: 'ben' }));
  assert.equal(gifts.filter((g) => g.userHandle === 'ben').length, 5, '5 credited frames, as before');
  assert.deepEqual(ends.slice(1).map((e) => [e.count, e.userHandle, e.userName, e.name, e.coins]), [[5, 'ben', 'BEN', 'Rose', 1]]);
  // a single gift (delivered twice), an unpriced gift and a gift to another host
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '777' }));
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '777' }));
  c.emit('gift', giftFrame({ coins: 0, name: 'Free gift', end: 1 }));
  c.emit('gift', giftFrame({ to: 'someone_else', coins: 5, end: 1 }));
  assert.deepEqual(ends.slice(2).map((e) => [e.name, e.count, e.coins]), [['Galaxy', 1, 1000]]);
  assert.equal(ends[2].key, gifts.at(-1).key, 'same key as the credited single gift');
  // a combo that starts and ends in one frame
  c.emit('gift', giftFrame({ count: 3, end: 1, group: '1759900000999', user: 'cat' }));
  assert.deepEqual(ends.slice(3).map((e) => e.count), [3]);
});

test('comments, follows and shares are read (2.4.4 chat / follow / share, social as a fallback) with the gift cuts, and never confirm a room', async (t) => {
  const { link, c } = await liveLink(t);
  const got = [];
  for (const ev of ['comment', 'follow', 'share']) link.on(ev, (x) => got.push([ev, x]));
  c.emit('chat', { content: 'hello\nthere', user: { userId: 'u1', displayId: '@mira', nickname: 'Mira B' } });
  c.emit('chat', { comment: 'old shape', user: { displayId: 'old' } });
  c.emit('chat', { content: '   ', user: { nickname: 'x' } });                  // nothing to say: no event
  c.emit('follow', { user: { userId: 'u2', displayId: 'fan2', nickname: 'Fan Two' }, common: { displayText: { key: 'pm_main_follow_message_viewer_2' } } });
  c.emit('share', { user: { userId: 'u3', displayId: 'fan3' }, common: { displayText: { key: 'pm_mt_guidance_share' } } });
  c.emit('social', { user: { userId: 'u4', nickname: 'Four' }, common: { displayText: { key: 'x', defaultPattern: '{0:user} followed the LIVE creator' } } });
  c.emit('social', { user: { userId: 'u5', nickname: 'Five' }, common: { displayText: { key: 'x', defaultPattern: '{0:user} shared the LIVE' } } });
  c.emit('social', { user: { userId: 'u6' }, common: { displayText: { key: 'pm_something_else' } } });   // neither: nothing
  assert.deepEqual(got.map(([ev, x]) => [ev, x.name, x.handle, x.text]), [
    ['comment', 'Mira B', 'mira', 'hello there'],
    ['comment', 'old', 'old', 'old shape'],
    ['follow', 'Fan Two', 'fan2', undefined],
    ['share', 'fan3', 'fan3', undefined],
    ['follow', 'Four', null, undefined],
    ['share', 'Five', null, undefined],
  ]);
  assert.equal(got[0][1].userId, 'u1');
  // an emoji across the cut never leaves half of it behind
  c.emit('chat', { content: 'x'.repeat(499) + '\u{1F525}', user: { nickname: 'N'.repeat(79) + '\u{1F339}' } });
  const last = got.at(-1)[1];
  assert.ok(last.text.length <= 500 && last.name.length <= 80 && !LONE.test(last.text) && !LONE.test(last.name));
});

test('a VTuber listener that throws never breaks the feed: gifts and likes still arrive, the log names no viewer and no comment', async (t) => {
  const { link, c, logs } = await liveLink(t);
  const likes = [], gifts = [];
  link.on('like', (l) => likes.push(l));
  link.on('gift', (g) => gifts.push(g));
  link.on('comment', () => { throw new Error('boom secret comment words'); });
  link.on('giftEnd', () => { throw new TypeError('boom'); });
  c.emit('chat', { content: 'secret comment words', user: { nickname: 'Secret Name' } });
  c.emit('gift', giftFrame({ type: 0, combo: false, msgId: '12345678' }));
  c.emit('like', { count: 3, total: '103' });
  assert.equal(likes.length, 1);
  assert.equal(gifts.length, 1);
  assert.equal(link.state.status, 'live');
  const all = logs.join('\n');
  assert.ok(!/secret|Secret|MARIA|maria/.test(all), all);
});

test('malformed chat / follow / share / social payloads (and a failing gift end) never throw into the feed: skipped, one log line per kind, no payload in it', async (t) => {
  const srv = vtuberServer(); await srv.listen();
  t.after(() => srv.close());
  const { link, c, logs } = await liveLink(t);
  const v = new VtuberLink({ port: srv.port }).attach(link);
  t.after(() => v.stop());
  assert.ok(await until(() => v.ok));
  const likes = [], gifts = [], got = [];
  link.on('like', (l) => likes.push(l));
  link.on('gift', (g) => gifts.push(g));
  for (const ev of ['comment', 'follow', 'share']) link.on(ev, () => got.push(ev));
  const boom = (what) => ({ toString() { throw new Error('secret ' + what); } });     // String(x) throws
  const badUser = { get user() { throw new RangeError('secret user'); } };
  const bad = {
    chat: [null, undefined, 42, 'secret string', [], Object.create(null), badUser,
      { content: boom('text') }, { get content() { throw new Error('secret getter'); } },
      { content: 'secret words', user: { nickname: boom('name') } },
      { content: 'secret words', user: { displayId: boom('handle') } },
      { content: 'secret words', user: { userId: boom('id') } }],
    follow: [null, 7, badUser, { user: { nickname: boom('name') } }, { user: { displayId: boom('handle') } }],
    share: [undefined, 'x', { user: 5 }, badUser, { user: { uniqueId: boom('handle') } }],
    social: [null, { common: 7 }, badUser, { common: { displayText: { key: Symbol('secret') } } },
      { common: { get displayText() { throw new Error('secret getter'); } } }, { displayType: boom('type') },
      { common: { displayText: { key: 'pm_main_follow_message_viewer_2' } }, user: { nickname: boom('name') } }],
  };
  for (const [ev, list] of Object.entries(bad)) list.forEach((d, i) => assert.doesNotThrow(() => c.emit(ev, d), `${ev} #${i}`));
  // the local gift-end step fails (whatever the cause): the gift is still credited and the next one still works
  const emitLocal = link._emitLocal;
  link._emitLocal = function (ev, x) { if (ev === 'giftEnd') throw new TypeError('secret end'); return emitLocal.call(this, ev, x); };
  assert.doesNotThrow(() => c.emit('gift', giftFrame({ type: 0, combo: false, coins: 10, name: 'Cap', giftId: '900', msgId: '424241' })));
  link._emitLocal = emitLocal;
  assert.equal(gifts.length, 1, 'credited');
  assert.equal(link._giftEnd, null, 'nothing left over for the next gift');
  // the feed carries on: a good comment, follow, share, taps and a gift all arrive, and reach the VTuber
  assert.ok(await until(() => v.inFlight === 0));
  c.emit('chat', { content: 'all good', user: { userId: 'ok1', displayId: 'okay', nickname: 'Okay' } });
  c.emit('follow', { user: { userId: 'ok2', nickname: 'Okay Two' } });
  c.emit('share', { user: { userId: 'ok3', nickname: 'Okay Three' } });
  c.emit('like', { count: 4, total: '104' });
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 100, name: 'Crown', giftId: '901', msgId: '424242', user: 'ben' }));
  assert.deepEqual(got.slice(-3), ['comment', 'follow', 'share']);
  assert.equal(likes.length, 1);
  assert.equal(gifts.length, 2);
  assert.equal(link.state.status, 'live');
  assert.ok(await until(() => srv.events('comment').some((e) => e.text === 'all good') && srv.events('gift').some((e) => e.gift === 'Crown')
    && srv.events('follow').some((e) => e.name === 'Okay Two') && srv.events('share').some((e) => e.name === 'Okay Three')));
  assert.ok(!srv.posts.some((p) => /secret/.test(p.body)), 'nothing from a malformed payload reached the VTuber');
  // one line per kind, naming only the kind and the error type
  for (const kind of ['comment', 'follow', 'share', 'social', 'giftEnd']) {
    assert.equal(logs.filter((l) => l.includes(`skipped a malformed TikTok ${kind} message`)).length, 1, kind);
  }
  assert.ok(!/secret|Okay|maria|\bben\b/i.test(logs.join('\n')), logs.join('\n'));
});

test('tiktok-live-connector 2.4.4: the event names, and how a social message becomes follow / share', async (t) => {
  const L = require('tiktok-live-connector');
  assert.equal(L.WebcastEvent.CHAT, 'chat');
  assert.equal(L.WebcastEvent.FOLLOW, 'follow');
  assert.equal(L.WebcastEvent.SHARE, 'share');
  assert.equal(L.WebcastEvent.SOCIAL, 'social');
  assert.equal(L.WebcastEvent.GIFT, 'gift');
  assert.equal(L.WebcastEvent.LIKE, 'like');
  // The library's own decoder routing, run on a plain emitter (no connection, no network).
  const e = new EventEmitter(), got = [];
  for (const ev of ['chat', 'follow', 'share', 'social']) e.on(ev, () => got.push(ev));
  const route = L.TikTokLiveConnection.prototype.processDecodedData;
  await route.call(e, { type: 'WebcastSocialMessage', data: { common: { displayText: { key: 'pm_main_follow_message_viewer_2' } } } });
  await route.call(e, { type: 'WebcastSocialMessage', data: { common: { displayText: { key: 'pm_mt_guidance_share' } } } });
  await route.call(e, { type: 'WebcastSocialMessage', data: { common: { displayText: { key: 'pm_other' } } } });
  await route.call(e, { type: 'WebcastChatMessage', data: { content: 'hi' } });
  assert.deepEqual(got, ['follow', 'share', 'social', 'chat']);
});

// ---------------------------------------------------------------- the payload

test('buildEvent: the contract shape, every field clipped, nothing sent for an empty like or comment', () => {
  const at = 1_800_000_000_000;
  assert.deepEqual(buildEvent('gift', { name: 'Mira', gift: 'Galaxy', coins: 1000, count: 3 }, at),
    { v: 1, type: 'gift', name: 'Mira', gift: 'Galaxy', coins: 1000, count: 3, text: null, at });
  assert.deepEqual(Object.keys(buildEvent('follow', { name: 'a' }, at)), ['v', 'type', 'name', 'gift', 'coins', 'count', 'text', 'at']);
  assert.deepEqual(buildEvent('follow', { name: 'Fan' }, at), { v: 1, type: 'follow', name: 'Fan', gift: null, coins: null, count: null, text: null, at });
  assert.deepEqual(buildEvent('share', {}, at), { v: 1, type: 'share', name: 'Someone', gift: null, coins: null, count: null, text: null, at });
  assert.deepEqual(buildEvent('like', { name: 'T', count: 12.7 }, at), { v: 1, type: 'like', name: 'T', gift: null, coins: null, count: 12, text: null, at });
  assert.equal(buildEvent('like', { count: 0 }, at), null);
  assert.equal(buildEvent('comment', { name: 'x', text: ' \n\t ' }, at), null);
  assert.equal(buildEvent('wave', {}, at), null);
  const long = buildEvent('comment', { name: 'N'.repeat(39) + '\u{1F525}', text: 'line one\nline two ' + 'y'.repeat(140) + '\u{1F339}' }, at);
  assert.ok(long.name.length <= 40 && !LONE.test(long.name), long.name);
  assert.equal(long.name, 'N'.repeat(39), 'an emoji that does not fit is left out whole');
  assert.ok(long.text.length <= 150 && !LONE.test(long.text));
  assert.ok(!/[\u0000-\u001f]/.test(long.text), 'no control characters');
  const g = buildEvent('gift', { name: '', gift: '', coins: 0, count: 1e9 }, at);
  assert.deepEqual([g.name, g.gift, g.coins, g.count], ['Someone', 'Gift', null, 100000]);
  assert.equal(buildEvent('gift', { count: -3 }, at).count, 1);
});

// ---------------------------------------------------------------- vtuber-link against a local server

test('defaults: port 8791, the contract path, a 15 s ask and 4 like sends a second at most (no request made here)', (t) => {
  assert.equal(DEFAULT_PORT, 8791);
  assert.equal(PATH, '/api/tiktok-event');
  assert.equal(PROBE_EVERY_MS, 15000);
  assert.ok(LIKE_EVERY_MS >= 250);
  const v = new VtuberLink();
  t.after(() => v.stop());
  assert.equal(v.port, 8791);
});

test('sends each event to 127.0.0.1 with the contract headers and body, only after the ask found a VTuber', async (t) => {
  const srv = vtuberServer(); await srv.listen();
  t.after(() => srv.close());
  const link = new FakeLink();
  const logs = [];
  const v = new VtuberLink({ port: srv.port, log: (l, m) => logs.push(`${l} ${m}`) }).attach(link);
  t.after(() => v.stop());
  link.emit('comment', { name: 'Early', text: 'before the LIVE' });           // no LIVE yet: nothing, not even an ask
  await wait(50);
  assert.equal(srv.gets.length + srv.posts.length, 0);
  link.set('live');
  assert.ok(await until(() => v.ok));
  assert.equal(srv.gets.length, 1);
  assert.equal(srv.gets[0].headers['x-livelink-event'], '1');
  link.emit('giftEnd', { key: 'm:abcdefgh', count: 2, coins: 1000, name: 'Galaxy', userHandle: 'mira', userName: 'Mira B', at: 1_800_000_000_000 });
  link.emit('comment', { name: 'Mira B', handle: 'mira', text: 'what a song', at: 1_800_000_000_001 });
  link.emit('follow', { name: 'Fan', userId: 'u2', at: 1_800_000_000_002 });
  link.emit('share', { name: 'Sharer', userId: 'u3', at: 1_800_000_000_003 });
  link.emit('like', { count: 7, total: 100, name: 'Tapper', handle: 'tap' });
  assert.ok(await until(() => srv.posts.length === 5), `posts ${srv.posts.length}`);
  for (const p of srv.posts) {
    assert.equal(p.url, '/api/tiktok-event');
    assert.equal(p.headers['content-type'], 'application/json');
    assert.equal(p.headers['x-livelink-event'], '1');
    assert.equal(p.headers.origin, undefined, 'no Origin header (the VTuber refuses web pages)');
    assert.equal(p.remote, '127.0.0.1');
  }
  const byType = Object.fromEntries(srv.events().map((e) => [e.type, e]));
  assert.deepEqual(byType.gift, { v: 1, type: 'gift', name: 'Mira B', gift: 'Galaxy', coins: 1000, count: 2, text: null, at: 1_800_000_000_000 });
  assert.deepEqual(byType.comment, { v: 1, type: 'comment', name: 'Mira B', gift: null, coins: null, count: null, text: 'what a song', at: 1_800_000_000_001 });
  assert.deepEqual(byType.follow, { v: 1, type: 'follow', name: 'Fan', gift: null, coins: null, count: null, text: null, at: 1_800_000_000_002 });
  assert.deepEqual(byType.share, { v: 1, type: 'share', name: 'Sharer', gift: null, coins: null, count: null, text: null, at: 1_800_000_000_003 });
  assert.equal(byType.like.count, 7);
  assert.equal(byType.like.name, 'Tapper');
  // one quiet line, with no viewer name or comment in it
  assert.deepEqual(logs.filter((l) => /VTuber/.test(l)).length, 1);
  assert.ok(!/Mira|Fan|Sharer|Tapper|song/.test(logs.join('\n')));
});

test('gifts through the real link: one send per finished combo with its final count, one per single gift; a combo that never ends goes out once it is quiet', async (t) => {
  const srv = vtuberServer(); await srv.listen();
  t.after(() => srv.close());
  const { link, c } = await liveLink(t);
  const v = new VtuberLink({ port: srv.port, comboQuietMs: 300 }).attach(link);   // the link is already LIVE
  t.after(() => v.stop());
  assert.ok(await until(() => v.ok));
  for (let n = 1; n <= 10; n++) c.emit('gift', giftFrame({ count: n, group: '1759900000123', user: 'mira' }));
  c.emit('gift', giftFrame({ count: 10, end: 1, group: '1759900000123', user: 'mira' }));
  c.emit('gift', giftFrame({ count: 10, end: 1, group: '1759900000123', user: 'mira' }));   // the end again
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '7777777', user: 'ben' }));
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '7777777', user: 'ben' }));   // twice
  for (let n = 1; n <= 4; n++) c.emit('gift', giftFrame({ count: n, group: '1759900000456', user: 'cat', name: 'Heart', coins: 5 }));   // no end frame
  assert.ok(await until(() => srv.events('gift').length === 2), `gift posts ${srv.events('gift').length}`);
  await wait(100);
  assert.equal(srv.events('gift').length, 2, 'nothing per running frame');
  assert.ok(await until(() => srv.events('gift').length === 3, 3000), 'the quiet combo goes out');
  c.emit('gift', giftFrame({ count: 4, end: 1, group: '1759900000456', user: 'cat', name: 'Heart', coins: 5 }));   // its end, late
  await wait(400);
  const g = srv.events('gift').map((e) => [e.name, e.gift, e.coins, e.count]).sort();
  assert.deepEqual(g, [['BEN', 'Galaxy', 1000, 1], ['CAT', 'Heart', 5, 4], ['MIRA', 'Rose', 1, 10]]);
});

test('likes are summed and sent at most 4 times a second, nothing lost', async (t) => {
  const srv = vtuberServer(); await srv.listen();
  t.after(() => srv.close());
  const link = new FakeLink();
  const v = new VtuberLink({ port: srv.port }).attach(link);
  t.after(() => v.stop());
  const sends = [];
  const send = v._send.bind(v);
  v._send = (type, ...a) => { if (type === 'like') sends.push(performance.now()); return send(type, ...a); };
  link.set('live');
  assert.ok(await until(() => v.ok));
  const t0 = Date.now();
  let taps = 0;
  for (let i = 0; i < 60; i++) { const n = 1 + (i % 3); taps += n; link.emit('like', { count: n, total: NaN, name: 'Tapper' + (i % 5) }); await wait(20); }
  const spanMs = Date.now() - t0;
  assert.ok(await until(() => srv.events('like').reduce((s, e) => s + e.count, 0) === taps, 2000), 'every tap arrives');
  assert.equal(sends.length, srv.events('like').length);
  // the sends are timed here, a hair after the link's own 250 ms clock: allow 5 ms of jitter per gap
  for (let i = 1; i < sends.length; i++) assert.ok(sends[i] - sends[i - 1] >= 245, `gap ${sends[i] - sends[i - 1]} ms`);
  assert.ok(sends.length <= Math.ceil(spanMs / 250) + 2, `${sends.length} sends in ${spanMs} ms`);
  assert.ok(sends.length >= 3, 'batched, not held back');
  for (const a of sends) assert.ok(sends.filter((b) => b >= a && b < a + 4 * 245).length <= 4, 'at most 4 in any one second (less the jitter)');
});

test('nothing listening: no sends at all, one ask every interval while LIVE, none after the LIVE; found and lost logged once each', async (t) => {
  const srv = vtuberServer(); srv.mode = 'down'; await srv.listen();
  t.after(() => srv.close());
  const link = new FakeLink();
  const logs = [];
  const v = new VtuberLink({ port: srv.port, probeEveryMs: 200, log: (l, m) => logs.push(`${l} ${m}`) }).attach(link);
  t.after(() => v.stop());
  link.set('live');
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    link.emit('giftEnd', { key: 'm:k' + i + 'xxxxxx', count: 1, coins: 1, name: 'Rose', userName: 'A' });
    link.emit('comment', { name: 'A', text: 'hi' });
    link.emit('like', { count: 5, name: 'A' });
    await wait(50);
  }
  const span = Date.now() - t0;
  assert.equal(srv.posts.length, 0, 'not one event sent while the ask fails');
  assert.ok(srv.gets.length >= 3 && srv.gets.length <= Math.ceil(span / 200) + 2, `${srv.gets.length} asks in ${span} ms`);
  assert.equal(logs.length, 0, 'never found: nothing to say');
  // the VTuber comes up: found on the next ask, events flow
  srv.mode = 'ok';
  assert.ok(await until(() => v.ok, 2000));
  link.emit('follow', { name: 'B', userId: 'b' });
  assert.ok(await until(() => srv.events('follow').length === 1));
  // it goes away: the first failed send stops the sending, no more attempts until an ask succeeds again
  await srv.close();
  link.emit('share', { name: 'C' });
  assert.ok(await until(() => !v.ok && v.inFlight === 0, 6000));
  const failed = v.stats.failed;
  for (let i = 0; i < 10; i++) link.emit('comment', { name: 'C', text: 'still there?' });
  assert.equal(v.stats.failed, failed, 'nothing more was attempted');
  assert.equal(v.inFlight, 0);
  assert.deepEqual(logs.map((l) => l.replace(/\(port \d+\)/, '(port N)')), [
    'info VTuber found on this computer (port N): TikTok events go to it',
    'info VTuber on this computer stopped answering: no events go to it until it is back',
  ]);
  // the LIVE ends: the asking stops
  link.set('offline', null);
  const probes = v.stats.probes;
  await wait(600);
  assert.equal(v.stats.probes, probes, 'no asks without a LIVE');
});

test('a port with nothing on it: the ask fails quietly, nothing is sent, nothing is logged', async (t) => {
  const port = await deadPort();
  const link = new FakeLink();
  const logs = [];
  const v = new VtuberLink({ port, probeEveryMs: 150, probeTimeoutMs: 1000, log: (l, m) => logs.push(`${l} ${m}`) }).attach(link);
  t.after(() => v.stop());
  link.set('live');
  for (let i = 0; i < 10; i++) { link.emit('giftEnd', { key: 'm:zzzzzzzz' + i, count: 1, coins: 1, name: 'Rose', userName: 'A' }); await wait(40); }
  assert.ok(await until(() => v.stats.probes >= 2, 6000));
  assert.equal(v.ok, false);
  assert.equal(v.stats.sent + v.stats.failed, 0);
  assert.equal(logs.length, 0);
});

test('follows show once per viewer; never more than 10 other events a second (the VTuber\'s limit)', async (t) => {
  const srv = vtuberServer(); await srv.listen();
  t.after(() => srv.close());
  const link = new FakeLink();
  const v = new VtuberLink({ port: srv.port }).attach(link);
  t.after(() => v.stop());
  link.set('live');
  assert.ok(await until(() => v.ok));
  link.emit('follow', { name: 'F', userId: 'u1' });
  link.emit('follow', { name: 'F', userId: 'u1' });            // follow, unfollow, follow
  link.emit('follow', { name: 'G', userId: 'u2' });
  for (let i = 0; i < 30; i++) link.emit('comment', { name: 'C', text: 'spam ' + i });
  await wait(300);
  assert.equal(srv.events('follow').length, 2);
  assert.ok(srv.events('comment').length <= 8, `${srv.events('comment').length} comments in one second`);
  assert.ok(v.stats.dropped >= 22);
});

// ---------------------------------------------------------------- the site paths are unchanged

// The same LIVE (taps + a combo + a single gift) through the real link and the controller against the mock site,
// once without and once with a VTuber attached and listening. The site must see exactly the same.
async function runShow(t, withVtuber) {
  let mock = null, dir = null, link = null, ctl = null, srv = null, v = null, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { if (ctl) ctl.stop(); else if (link) link.stop(); } catch {}
    try { if (v) v.stop(); } catch {}
    if (mock) await mock.close();
    if (srv) await srv.close();
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  t.after(close);
  mock = createMock({ pushIntervalMs: 60, autoApprove: true });
  const port = await mock.listen(0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-vt-'));
  const store = new Store({ dir });
  const f = fakeLib(['live']);
  link = new TikTokLink({ lib: f.lib, ...noTimers });
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  ctl = new Controller({ api, link, store, appVersion: '1.0.0', deviceName: 'TEST-PC' });
  const credits = [];
  link.on('gift', (g) => credits.push({ ...g, at: 0 }));
  if (withVtuber) {
    srv = vtuberServer(); await srv.listen();
    v = new VtuberLink({ port: srv.port }).attach(link);
  }
  await ctl.pair('TEST2345');
  assert.ok(await until(() => link.state.status === 'live'), 'live');
  if (v) assert.ok(await until(() => v.ok), 'VTuber found');
  const c = f.made[0];
  c.emit('like', { count: 10, total: '110', user: { displayId: 'tapper', nickname: 'Tapper' } });
  assert.ok(await until(() => mock.state.pushes.length >= 1));
  for (let n = 1; n <= 3; n++) c.emit('gift', giftFrame({ count: n, group: '1759900000123', to: 'test_host' }));
  c.emit('gift', giftFrame({ count: 3, end: 1, group: '1759900000123', to: 'test_host' }));
  c.emit('gift', giftFrame({ type: 0, combo: false, coins: 1000, name: 'Galaxy', giftId: '11046', msgId: '70000009001', user: 'ben', to: 'test_host' }));
  c.emit('chat', { content: 'nice', user: { nickname: 'Chatter' } });
  c.emit('like', { count: 5, total: '115' });
  c.emit('like', { count: 5, total: '120' });
  assert.ok(await until(() => mock.state.credited === 20 && mock.state.giftTaps === 10030, 6000), `credited ${mock.state.credited}, gift taps ${mock.state.giftTaps}`);
  await wait(300);
  const out = {
    credited: mock.state.credited, giftTaps: mock.state.giftTaps, streaks: [...mock.state.giftStreaks.entries()].sort(),
    alerts: mock.state.giftAlerts, credits, taps: ctl.s.taps.session, gifts: { ...ctl.s.gifts, recent: ctl.s.gifts.recent.map((r) => ({ ...r, at: 0 })) },
    pushGifts: mock.state.pushes.flatMap((p) => (p.gifts || []).map((g) => ({ ...g, at: 0 }))),
    vt: srv ? srv.events().map((e) => [e.type, e.name, e.gift, e.count, e.text]) : null,
  };
  await close();
  return out;
}

test('the site sees exactly the same taps and gifts with a VTuber attached as without one', async (t) => {
  const without = await runShow(t, false);
  const withVt = await runShow(t, true);
  const { vt, ...a } = withVt;
  const { vt: none, ...b } = without;
  assert.deepEqual(a, b);
  assert.equal(none, null);
  assert.equal(b.credited, 20);
  assert.equal(b.giftTaps, 10030);
  // and the VTuber got one gift per finished combo / single gift, the comment and the taps
  assert.deepEqual(vt.filter((e) => e[0] === 'gift').sort(), [['gift', 'BEN', 'Galaxy', 1, null], ['gift', 'MARIA', 'Rose', 3, null]]);
  assert.deepEqual(vt.filter((e) => e[0] === 'comment'), [['comment', 'Chatter', null, null, 'nice']]);
  assert.equal(vt.filter((e) => e[0] === 'like').reduce((s, e) => s + e[3], 0), 20);
});
