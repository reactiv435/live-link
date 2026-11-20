'use strict';
// V8 (the puppet show), contract C1 / C2 / C4: who the viewer is on every event (handle, uid, picture), the picture
// hosts, per-viewer taps, and a pressed key as a `control` message. Every test talks to a local stand-in VTuber on a
// random free port (never 8791) or to a function inside the test; never to TikTok, never to the real site.
// Every viewer here is made up; every picture address is made up (no real viewer's picture is in this file).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TikTokLink } = require('../src/core/tiktok-link');
const { VtuberLink, buildEvent, buildControl, PUPPET_MOVES } = require('../src/core/vtuber-link');
const { TIKTOK_PICTURE_HOSTS, cleanPictureUrl, pickAvatar, cleanUid, cleanHandle, hostFamily, coverHosts, PictureStats } = require('../src/core/pictures');
const { createMock } = require('./mock-server');
const { LiveLinkApi } = require('../src/core/api');
const { Controller } = require('../src/core/controller');
const { Store } = require('../src/core/store');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); } return false; }

const openServers = new Set();
after(async () => { for (const s of [...openServers]) await s.close(); });

// A stand-in VTuber: GET answers { ok, v } (v = the contract it speaks), POST 204.
function vtuberServer(v = 2) {
  const s = { v, gets: [], posts: [] };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') { s.gets.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, v: s.v })); return; }
      let json = null; try { json = JSON.parse(body); } catch {}
      s.posts.push({ headers: req.headers, bytes: Buffer.byteLength(body), json });
      res.writeHead(204); res.end();
    });
  });
  s.listen = () => new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; r(s.port); }));
  s.close = () => s.closing || (s.closing = new Promise((r) => { openServers.delete(s); s.server.closeAllConnections && s.server.closeAllConnections(); s.server.close(() => r()); }));
  openServers.add(s);
  s.events = (type) => s.posts.filter((p) => p.json && (!type || p.json.type === type)).map((p) => p.json);
  return s;
}

class FakeLink extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle', roomId: null }; this.pictures = new PictureStats(); }
  set(status, roomId = 'R1') { this.state = { ...this.state, status, roomId }; this.emit('state', { ...this.state }); }
}

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
  return { made, lib: { TikTokLiveConnection, UserOfflineError: class extends Error {}, SignatureRateLimitError: class extends Error {},
    ControlEvent: { CONNECTED: 'connected', DISCONNECTED: 'disconnected', ERROR: 'error', WEBSOCKET_DATA: 'websocketData' },
    WebcastEvent: { LIKE: 'like', ROOM_USER: 'roomUser', STREAM_END: 'streamEnd', GIFT: 'gift', CHAT: 'chat', FOLLOW: 'follow', SHARE: 'share', SOCIAL: 'social' } } };
}
const noTimers = { setInterval: () => ({}), clearInterval: () => {} };

// made-up pictures, in the shape tiktok-live-proto v3 decodes (user.avatarThumb = ImageModel { urlList })
const PIC = (who, host = 'p16-sign-va.tiktokcdn.com') => `https://${host}/tos-maliva-avt-0068/${who}~tplv-tiktokx-cropcenter:100:100.webp?dr=1&x-expires=1900000000&x-signature=MADEUP`;
const user = (who, id, extra = {}) => ({ userId: id, displayId: who, nickname: who.toUpperCase(), avatarThumb: { urlList: [PIC(who), PIC(who).replace('.webp', '.jpeg')] }, ...extra });

// ---------------------------------------------------------------- C2: the picture hosts

test('C2 picture hosts: only https on a listed TikTok picture server (the name itself or a sub-domain); look-alikes, logins, ports, long or odd addresses are refused', () => {
  assert.deepEqual([...TIKTOK_PICTURE_HOSTS], ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ibyteimg.com', 'byteimg.com']);
  const ok = [
    'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/abc~tplv-obj.webp',      // the one host measured from real gifts
    'https://p16-sign-va.tiktokcdn.com/a/b.jpeg?x-expires=1&x-signature=x',
    'https://p19-pu-sign-useast8.tiktokcdn-us.com/a.webp',
    'https://p16-pu-sign-no.tiktokcdn-eu.com/a.webp',
    'https://p16-oec-va.ibyteimg.com/a.png', 'https://sf16.byteimg.com/a.png', 'https://tiktokcdn.com/a.png', 'HTTPS://P16-SIGN.TIKTOKCDN.COM/a.png',
    'https://p16.tiktokcdn.com:443/a.png',
  ];
  for (const u of ok) assert.ok(cleanPictureUrl(u), u);
  assert.equal(cleanPictureUrl('HTTPS://P16-SIGN.TIKTOKCDN.COM/a.png'), 'https://p16-sign.tiktokcdn.com/a.png', 'normalised');
  const bad = [
    'http://p16-sign-va.tiktokcdn.com/a.png',                    // not https
    'https://tiktokcdn.com.evil.example/a.png', 'https://eviltiktokcdn.com/a.png', 'https://tiktokcdn.co/a.png', 'https://tiktokcdn-us.com.x.io/a.png',
    'https://user:pw@p16.tiktokcdn.com/a.png', 'https://p16.tiktokcdn.com:8443/a.png',
    'https://p16.tiktokcdn.com/a b.png', 'https://p16.tiktokcdn.com/a"b.png', 'https://p16.tiktokcdn.com/\u202ea.png', 'https://p16.tiktokcdn.com/a\n.png',
    'https://127.0.0.1/a.png', 'https://localhost/a.png', 'file:///c:/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
    'https://p16.tiktokcdn.com/' + 'a'.repeat(600), '', 'https://', null, undefined, 42, {}, ['https://p16.tiktokcdn.com/a.png'],
    'https://www.tiktok.com/@someone', 'https://reactivvibeai.com/a.png', 'https://bxiejoktoknybpraxebm.supabase.co/storage/v1/object/public/x/a.png',
  ];
  for (const u of bad) assert.equal(cleanPictureUrl(u), null, String(u).slice(0, 60));
  // covers: the site's storage host only, taken from the site's own API address
  const cover = coverHosts('https://bxiejoktoknybpraxebm.supabase.co/functions/v1/');
  assert.deepEqual(cover, ['bxiejoktoknybpraxebm.supabase.co']);
  assert.ok(cleanPictureUrl('https://bxiejoktoknybpraxebm.supabase.co/storage/v1/object/public/submission-attachments/u/a.png', cover));
  assert.equal(cleanPictureUrl('https://other.supabase.co/storage/v1/object/public/x/a.png', cover), null, 'another project is not the site');
  assert.equal(cleanPictureUrl(PIC('x'), cover), null, 'a TikTok picture is not a cover');
  assert.deepEqual(coverHosts('not a url'), []);
  assert.deepEqual(coverHosts('http://127.0.0.1:8799/functions/v1/'), [], 'a test run has no cover host');
});

test('C1 who: the picture is read from every shape a TikTok user object comes in; a .webp or .jpeg before a .heic; ids are digits only; handles are cleaned', () => {
  assert.equal(pickAvatar(user('maria', '7000000000000000001')), PIC('maria'));
  assert.equal(pickAvatar({ avatarThumb: { urlList: [PIC('a').replace('.webp', '.heic'), PIC('a')] } }), PIC('a'), 'a browser cannot draw .heic');
  assert.equal(pickAvatar({ avatarThumb: { urlList: [PIC('a').replace('.webp', '.heic')] } }), PIC('a').replace('.webp', '.heic'), 'only a .heic: still passed on');
  assert.equal(pickAvatar({ avatarThumb: { urlList: ['https://evil.example/a.png', PIC('b')] } }), PIC('b'), 'the first ALLOWED one');
  assert.equal(pickAvatar({ avatarMedium: { urlList: [PIC('m')] } }), PIC('m'));
  assert.equal(pickAvatar({ profilePictureUrl: PIC('old') }), PIC('old'), 'older decoders');
  assert.equal(pickAvatar({ profilePicture: { urls: [PIC('older')] } }), PIC('older'));
  assert.equal(pickAvatar({ avatarThumb: { url_list: [PIC('snake')] } }), PIC('snake'));
  for (const u of [null, undefined, 7, 'x', {}, { avatarThumb: null }, { avatarThumb: { urlList: 'nope' } }, { avatarThumb: { urlList: [null, 5, {}] } }, { avatarThumb: { urlList: ['https://evil.example/a.png'] } }]) assert.equal(pickAvatar(u), null);
  assert.equal(cleanUid('7000000000000000001'), '7000000000000000001');
  assert.equal(cleanUid(12345), '12345');
  assert.equal(cleanUid(7000000000000000001n), '7000000000000000001');
  for (const v of ['u-maria', 'maria', '', '0', '000', '1'.repeat(31), -5, 1.5, null, undefined, {}, '12 34']) assert.equal(cleanUid(v), null, String(v));
  assert.equal(cleanHandle('@maria.b_99'), 'maria.b_99');
  assert.equal(cleanHandle('ma ria<script>'), 'mariascript');
  assert.equal(cleanHandle('x'.repeat(60)).length, 40);
  assert.equal(cleanHandle(null), '');
});

test('C2 measuring: only the server FAMILY of a viewer picture is counted (never the address, never the viewer), allowed and refused apart', () => {
  const st = new PictureStats();
  pickAvatar(user('a', '1'), TIKTOK_PICTURE_HOSTS, st);
  pickAvatar(user('b', '2'), TIKTOK_PICTURE_HOSTS, st);
  pickAvatar({ avatarThumb: { urlList: ['https://p16-sign.newcdn-example.net/secret-viewer-name.webp?x-signature=SECRET'] } }, TIKTOK_PICTURE_HOSTS, st);
  pickAvatar({ nickname: 'no picture' }, TIKTOK_PICTURE_HOSTS, st);
  assert.equal(hostFamily('https://p16-sign-va.tiktokcdn.com/x'), 'tiktokcdn.com');
  const line = st.line();
  assert.match(line, /passed on: tiktokcdn\.com 2; not on the list \(no picture shown\): newcdn-example\.net 1; viewers without a picture: 1/);
  assert.doesNotMatch(line, /secret|SECRET|signature|https|p16/, 'no address, no viewer');
  st.reset();
  assert.equal(st.line(), null);
});

// ---------------------------------------------------------------- C1: the event

test('C1 event v2: handle, uid and avatar are added and checked again; every v1 field is unchanged; a v1 event is exactly the 2.2.0 event', () => {
  const x = { name: 'Mira B', handle: '@mira.b', uid: '7000000000000000002', avatar: PIC('mira'), text: 'what a song' };
  assert.deepEqual(buildEvent('comment', x, 1_800_000_000_001, 2),
    { v: 2, type: 'comment', name: 'Mira B', gift: null, coins: null, count: null, text: 'what a song', at: 1_800_000_000_001, handle: 'mira.b', uid: '7000000000000000002', avatar: PIC('mira') });
  assert.deepEqual(buildEvent('comment', x, 1_800_000_000_001),
    { v: 1, type: 'comment', name: 'Mira B', gift: null, coins: null, count: null, text: 'what a song', at: 1_800_000_000_001 }, 'v1: no new field at all');
  const bad = buildEvent('like', { name: 'T', count: 3, handle: 'a b<c>', uid: 'u-tapper', avatar: 'https://evil.example/a.png' }, 5, 2);
  assert.deepEqual([bad.handle, bad.uid, bad.avatar], ['abc', null, null]);
  const none = buildEvent('follow', { name: 'F' }, 5, 2);
  assert.deepEqual([none.v, none.handle, none.uid, none.avatar], [2, '', null, null]);
  const long = buildEvent('gift', { name: 'G', gift: 'Rose', coins: 1, count: 2, avatar: 'https://p16.tiktokcdn.com/' + 'a'.repeat(590) }, 5, 2);
  assert.equal(long.avatar, null, 'over 600 characters');
});

test('C1 through the real TikTok link: likes, comments, follows, shares and gifts carry the viewer id and picture; the site push never does', async (t) => {
  const mock = createMock({ pushIntervalMs: 60, autoApprove: true });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-v8-'));
  const store = new Store({ dir });
  const f = fakeLib(['live']);
  const link = new TikTokLink({ lib: f.lib, ...noTimers });
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  const ctl = new Controller({ api, link, store, appVersion: '1.0.0', deviceName: 'TEST-PC' });
  const got = [];
  const direct = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const v = new VtuberLink({ http: false, direct: () => direct, likeEveryMs: 30 }).attach(link);
  t.after(async () => { v.stop(); try { ctl.stop && ctl.stop(); } catch {} link.stop(); await mock.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  await ctl.pair('TEST2345');
  assert.ok(await until(() => link.state.status === 'live'), 'live');
  const c = f.made[0];
  c.emit('like', { count: 10, total: '110', user: user('tapper', '7000000000000000010') });
  c.emit('chat', { content: 'goo', user: user('chatter', '7000000000000000011') });
  c.emit('follow', { user: user('fan', '7000000000000000012') });
  c.emit('share', { user: user('sharer', '7000000000000000013', { avatarThumb: { urlList: ['https://evil.example/x.png'] } }) });
  c.emit('gift', { giftId: '11046', repeatCount: 1, repeatEnd: 0, groupId: '0', common: { msgId: '70000009001' },
    gift: { id: '11046', name: 'Galaxy', type: 0, combo: false, diamondCount: 1000, image: { urlList: ['https://p16-webcast.tiktokcdn.com/galaxy.png'] } },
    user: user('ben', '7000000000000000014'), toUser: { displayId: 'test_host' } });
  assert.ok(await until(() => got.length === 5), `got ${got.length}`);
  const by = Object.fromEntries(got.map((e) => [e.type, e]));
  assert.deepEqual([by.like.v, by.like.name, by.like.handle, by.like.uid, by.like.avatar, by.like.count], [2, 'TAPPER', 'tapper', '7000000000000000010', PIC('tapper'), 10]);
  assert.deepEqual([by.comment.handle, by.comment.uid, by.comment.avatar, by.comment.text], ['chatter', '7000000000000000011', PIC('chatter'), 'goo']);
  assert.deepEqual([by.follow.handle, by.follow.uid, by.follow.avatar], ['fan', '7000000000000000012', PIC('fan')]);
  assert.deepEqual([by.share.handle, by.share.uid, by.share.avatar], ['sharer', '7000000000000000013', null], 'a picture on an unknown server is not passed on');
  assert.deepEqual([by.gift.name, by.gift.handle, by.gift.uid, by.gift.avatar, by.gift.gift, by.gift.coins, by.gift.count], ['BEN', 'ben', '7000000000000000014', PIC('ben'), 'Galaxy', 1000, 1]);
  // the site: the push carries the gift exactly as in 2.2.0, with no viewer id and no picture of the viewer in it
  assert.ok(await until(() => mock.state.pushes.some((p) => (p.gifts || []).length)), 'the gift reached the stand-in site');
  const sent = JSON.stringify(mock.state.calls.map((x) => x.body));
  assert.doesNotMatch(sent, /avatar|7000000000000000014|tos-maliva-avt|x-signature/, 'no viewer id, no viewer picture goes to the site');
  const g = mock.state.pushes.flatMap((p) => p.gifts || [])[0];
  assert.deepEqual(Object.keys(g).sort(), ['at', 'coins', 'count', 'gift_id', 'image_url', 'key', 'name', 'user_handle', 'user_name']);
  // the count of picture servers (family names only) is there for the log
  assert.match(link.pictures.line(), /passed on: tiktokcdn\.com 4; not on the list \(no picture shown\): evil\.example 1/);
});

// ---------------------------------------------------------------- which VTuber gets what

test('over HTTP: a VTuber that answers v 2 gets v2 events, show and control; one that answers v 1 gets exactly the 2.2.0 events and nothing else', async (t) => {
  for (const peer of [2, 1]) {
    const srv = vtuberServer(peer); await srv.listen();
    const link = new FakeLink();
    const changes = [];
    const v = new VtuberLink({ port: srv.port, likeEveryMs: 30, onChange: () => changes.push(v.canControl) }).attach(link);
    try {
      assert.equal(v.canControl, false, 'no LIVE: nothing can be sent');
      assert.equal(v.sendControl('puppet', 'goo'), false);
      link.set('live');
      assert.ok(await until(() => v.ok));
      assert.equal(v.canControl, peer === 2);
      assert.equal(changes[changes.length - 1], peer === 2, 'the keys are told when a VTuber is found');
      link.emit('comment', { name: 'Mira B', handle: 'mira', userId: '7000000000000000002', avatar: PIC('mira'), text: 'fire', at: 1_800_000_000_001 });
      link.emit('like', { count: 7, name: 'Tapper', handle: 'tap', userId: '7000000000000000003', avatar: PIC('tap') });
      const show = { v: 2, type: 'show', onAir: true, song: { id: 'sub-1', title: 'Test Song', cover: null }, hype: { taps: 0, rank: 0, label: 'Tap to hype it up', mythic: 0 }, score: null, at: 5 };
      assert.equal(v.sendShow(show), peer === 2);
      assert.equal(v.sendControl('puppet', 'goo'), peer === 2);
      assert.equal(v.sendControl('fight'), peer === 2);
      assert.ok(await until(() => srv.posts.length === (peer === 2 ? 5 : 2)), `peer v${peer}: posts ${srv.posts.length}`);
      await wait(80);
      assert.equal(srv.posts.length, peer === 2 ? 5 : 2);
      const comment = srv.events('comment')[0], like = srv.events('like')[0];
      if (peer === 2) {
        assert.deepEqual(comment, { v: 2, type: 'comment', name: 'Mira B', gift: null, coins: null, count: null, text: 'fire', at: 1_800_000_000_001, handle: 'mira', uid: '7000000000000000002', avatar: PIC('mira') });
        assert.deepEqual([like.v, like.count, like.handle, like.uid, like.avatar], [2, 7, 'tap', '7000000000000000003', PIC('tap')]);
        assert.deepEqual(srv.events('show')[0], show);
        assert.deepEqual(srv.events('control').map((e) => [e.v, e.action, e.name]), [[2, 'puppet', 'goo'], [2, 'fight', '']]);
        for (const p of srv.posts) { assert.equal(p.headers['x-livelink-event'], '1'); assert.ok(p.bytes <= 2048, 'fits the VTuber\'s 2 KB door'); }
        assert.deepEqual([v.stats.show, v.stats.control], [1, 2]);
      } else {
        assert.deepEqual(comment, { v: 1, type: 'comment', name: 'Mira B', gift: null, coins: null, count: null, text: 'fire', at: 1_800_000_000_001 });
        assert.deepEqual(Object.keys(like).sort(), ['at', 'coins', 'count', 'gift', 'name', 'text', 'type', 'v']);
        assert.equal(srv.events('show').length + srv.events('control').length, 0);
      }
      link.set('offline', null);
      assert.equal(v.canControl, false);
      assert.equal(changes[changes.length - 1], false, 'the keys are told when the LIVE ends');
    } finally { v.stop(); await srv.close(); }
  }
});

test('the biggest v2 event (longest name, comment, handle, picture address) still fits the VTuber\'s 2 KB door', () => {
  const ev = buildEvent('comment', { name: '\u{1F525}'.repeat(40), text: '\u{1F525}'.repeat(150), handle: 'h'.repeat(40), uid: '9'.repeat(30), avatar: 'https://p16.tiktokcdn.com/' + 'a'.repeat(574) }, Date.now(), 2);
  assert.equal(ev.avatar.length, 600);
  assert.ok(Buffer.byteLength(JSON.stringify(ev)) <= 2048, `bytes ${Buffer.byteLength(JSON.stringify(ev))}`);
});

test('inside the app: the VTuber says which contract it speaks (direct().v); without it the 2.2.0 events go out unchanged', () => {
  for (const peer of [undefined, 1, 2]) {
    const link = new FakeLink();
    const got = [];
    const fn = (ev) => { got.push(ev); return true; };
    if (peer) fn.v = peer;
    const v = new VtuberLink({ http: false, direct: () => fn }).attach(link);
    link.set('live');
    link.emit('follow', { name: 'Fan', handle: 'fan', userId: '7000000000000000012', avatar: PIC('fan'), at: 9 });
    assert.equal(v.sendControl('vote'), peer === 2);
    if (peer === 2) assert.deepEqual(got, [{ v: 2, type: 'follow', name: 'Fan', gift: null, coins: null, count: null, text: null, at: 9, handle: 'fan', uid: '7000000000000000012', avatar: PIC('fan') }, { v: 2, type: 'control', action: 'vote', name: '', at: got[1] && got[1].at }]);
    else assert.deepEqual(got, [{ v: 1, type: 'follow', name: 'Fan', gift: null, coins: null, count: null, text: null, at: 9 }]);
    v.stop();
  }
});

// ---------------------------------------------------------------- taps: one viewer per event

test('v2 taps: each like event is ONE viewer with their own taps and picture; at most 4 sends a second; the total is never lost', async () => {
  const link = new FakeLink();
  const got = [];
  const fn = Object.assign((ev) => { got.push({ ...ev, gotAt: Date.now() }); return true; }, { v: 2 });
  const v = new VtuberLink({ http: false, direct: () => fn, likeEveryMs: 60, crowdAfterMs: 100000 }).attach(link);
  link.set('live');
  const A = { name: 'Ann', handle: 'ann', userId: '7000000000000000021', avatar: PIC('ann') };
  const B = { name: 'Bo', handle: 'bo', userId: '7000000000000000022', avatar: PIC('bo') };
  const C = { name: 'Cy', handle: 'cy', userId: null, avatar: null };                    // no id: known by the handle
  link.emit('like', { count: 5, ...A }); link.emit('like', { count: 2, ...B }); link.emit('like', { count: 3, ...A });
  link.emit('like', { count: 4, ...C }); link.emit('like', { count: 1 });                // the last one has no viewer on it
  assert.ok(await until(() => got.length === 4, 3000), `got ${got.length}`);
  await wait(150);
  assert.equal(got.length, 4);
  assert.deepEqual(got.map((e) => [e.name, e.handle, e.uid, e.avatar, e.count]).sort((a, b) => b[4] - a[4]), [
    ['Ann', 'ann', '7000000000000000021', PIC('ann'), 8], ['Cy', 'cy', null, null, 4], ['Bo', 'bo', '7000000000000000022', PIC('bo'), 2], ['Someone', '', null, null, 1]]);
  assert.equal(got[0].name, 'Ann', 'the viewer with the most waiting taps goes first');
  for (let i = 1; i < got.length; i++) assert.ok(got[i].gotAt - got[i - 1].gotAt >= 50, `sends ${i - 1} and ${i} are at least one step apart`);
  assert.equal(got.reduce((n, e) => n + e.count, 0), 15, 'every tap is in exactly one event');
  v.stop();
});

test('v2 taps in a big room: viewers who waited too long go out summed with no viewer on them, taking turns with the named ones; nothing is lost; nothing after the LIVE', async () => {
  const link = new FakeLink();
  const got = [];
  const fn = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const v = new VtuberLink({ http: false, direct: () => fn, likeEveryMs: 40, crowdAfterMs: 120 }).attach(link);
  link.set('live');
  let total = 0;
  for (let i = 0; i < 60; i++) { const n = 1 + (i % 4); total += n; link.emit('like', { count: n, name: 'V' + i, handle: 'v' + i, userId: (7000000000000000100n + BigInt(i)).toString(), avatar: PIC('v' + i) }); }
  assert.ok(await until(() => got.reduce((n, e) => n + e.count, 0) === total, 4000), `sum ${got.reduce((n, e) => n + e.count, 0)} of ${total}`);
  const named = got.filter((e) => e.uid), crowd = got.filter((e) => !e.uid && !e.handle);
  assert.ok(named.length >= 2 && named.length <= 6, `named ${named.length}`);
  assert.ok(crowd.length >= 1, 'the rest went out summed');
  for (const e of crowd) assert.deepEqual([e.name, e.handle, e.uid, e.avatar], ['Someone', '', null, null]);
  assert.ok(got.length <= 12, `60 viewers became ${got.length} events`);
  // the LIVE ends with taps waiting: they are dropped, never sent late
  link.emit('like', { count: 9, name: 'Late', handle: 'late', userId: '7000000000000000999' });
  const n = got.length;
  link.set('offline', null);
  await wait(150);
  assert.equal(got.length, n);
  v.stop();
});

test('a v1 VTuber still gets its taps summed as in 2.2.0 (one event, the last tapper\'s name)', async () => {
  const link = new FakeLink();
  const got = [];
  const v = new VtuberLink({ http: false, direct: () => (ev) => { got.push(ev); return true; }, likeEveryMs: 40 }).attach(link);
  link.set('live');
  link.emit('like', { count: 5, name: 'Ann', handle: 'ann', userId: '7000000000000000021', avatar: PIC('ann') });
  link.emit('like', { count: 2, name: 'Bo', handle: 'bo', userId: '7000000000000000022', avatar: PIC('bo') });
  assert.ok(await until(() => got.length === 1));
  await wait(120);
  assert.deepEqual(got.map((e) => [e.v, e.name, e.count, 'avatar' in e]), [[1, 'Bo', 7, false]]);
  v.stop();
});

// ---------------------------------------------------------------- C4: a pressed key

test('C4 control: only the three actions and the five moves; its own cap of 6 a second that never eats the viewers\' events', () => {
  assert.deepEqual(PUPPET_MOVES, ['goo', 'fire', 'melt', 'crack', 'eat']);
  assert.deepEqual(buildControl('puppet', 'goo', 77), { v: 2, type: 'control', action: 'puppet', name: 'goo', at: 77 });
  assert.deepEqual(buildControl('fight', 'ignored', 77), { v: 2, type: 'control', action: 'fight', name: '', at: 77 });
  assert.deepEqual(buildControl('vote', undefined, 77), { v: 2, type: 'control', action: 'vote', name: '', at: 77 });
  for (const [a, n] of [['puppet', 'explode'], ['puppet', ''], ['puppet', undefined], ['gift', 'goo'], ['', 'goo'], [null, null], ['__proto__', 'goo']]) assert.equal(buildControl(a, n), null, `${a}/${n}`);
  const link = new FakeLink();
  const got = [];
  let t = 1000;
  const fn = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const v = new VtuberLink({ http: false, direct: () => fn, mono: () => t }).attach(link);
  link.set('live');
  assert.equal(v.sendControl('puppet', 'explode'), false);
  let ok = 0;
  for (let i = 0; i < 20; i++) if (v.sendControl('puppet', 'fire')) ok++;
  assert.equal(ok, 6, 'six a second');
  for (let i = 0; i < 10; i++) link.emit('comment', { name: 'C', text: 'still here ' + i });
  assert.equal(got.filter((e) => e.type === 'comment').length, 10, 'the viewers\' ten a second are untouched');
  t += 1000;
  assert.equal(v.sendControl('fight'), true, 'the next second: again');
  assert.equal(v.sendShow({ v: 1, type: 'show' }), false, 'only a v2 show message');
  assert.equal(v.sendShow({ v: 2, type: 'comment' }), false);
  v.stop();
  assert.equal(v.sendControl('fight'), false, 'stopped');
});
