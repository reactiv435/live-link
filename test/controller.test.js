'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { createMock } = require('./mock-server');
const { LiveLinkApi, ApiError } = require('../src/core/api');
const { Controller } = require('../src/core/controller');
const { Store } = require('../src/core/store');

// Stands in for TikTokLink: the controller only uses start/stop/retryNow/setOfflinePoll/running/state + events.
class FakeLink extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null }; this.username = null; this.starts = 0; }
  get running() { return !!this.username; }
  setOfflinePoll(ms) { this.offlinePoll = ms; }
  start(u) { if (u === this.username) return; this.username = u; this.starts++; }
  stop() { this.username = null; this._set({ status: 'idle', roomId: null }); }
  retryNow() {}
  _set(p) { this.state = { ...this.state, ...p }; if (p.roomId && p.roomId !== this.lastRoom) { this.lastRoom = p.roomId; this.emit('roomChanged', p.roomId); } this.emit('state', { ...this.state }); }
  goLive(room = 'R1') { this._set({ status: 'live', roomId: room }); }
  like(count, total) { this.emit('like', { count, total, at: Date.now() }); }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } return false; }

async function setup(mockOpts = {}) {
  const mock = createMock({ pushIntervalMs: 60, ...mockOpts });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-'));
  const store = new Store({ dir });
  const link = new FakeLink();
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  const logs = [];
  const ctl = new Controller({ api, link, store, appVersion: '1.0.0', deviceName: 'TEST-PC', log: (l, m) => logs.push(`${l} ${m}`) });
  return { mock, store, link, api, ctl, logs, done: async () => { ctl.stop(); await mock.close(); } };
}

test('pair -> approve -> watches TikTok -> taps are credited through session_total', async () => {
  const t = await setup();
  await t.ctl.start();
  assert.strictEqual(t.ctl.s.phase, 'unpaired');
  await t.ctl.pair('test-2345');                       // dashes/lowercase are cleaned
  assert.strictEqual(t.ctl.s.phase, 'pending_approval');
  assert.strictEqual(t.link.username, null, 'no TikTok connection before Approve');
  t.mock.approveAll();
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.phase, 'ready');
  assert.strictEqual(t.link.username, 'test_host');
  assert.strictEqual(t.link.offlinePoll, 30000, 'site says live -> check TikTok every 30 s');

  t.link.goLive('R1');
  t.link.like(15, '1015');                             // first batch: baseline = 1000
  t.link.like(5, '1020');
  assert.ok(await until(() => t.mock.state.credited === 20), `credited ${t.mock.state.credited}`);
  t.link.like(30, '1050');
  assert.ok(await until(() => t.mock.state.credited === 50), `credited ${t.mock.state.credited}`);
  assert.ok(await until(() => t.ctl.s.taps.accepted === 50), `app counted ${t.ctl.s.taps.accepted}`);
  assert.strictEqual(t.ctl.s.message.level, 'ok');
  const p = t.mock.state.pushes[0];
  assert.strictEqual(p.tiktok_room_id, 'R1');
  assert.strictEqual(p.dry_run, false);
  assert.ok(p.status && p.status.tiktok_live === true, 'status rides inside the push');
  await t.done();
});

test('a failed push is retried with the SAME batch_id and nothing is double counted', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline push
  t.mock.state.failNext.push({ path: 'live-link-push', status: 503 });
  t.link.like(40, '150');
  assert.ok(await until(() => t.mock.state.credited === 50, 6000), `credited ${t.mock.state.credited}`);
  const pushCalls = t.mock.state.calls.filter(c => c.path === 'live-link-push');
  const ids = pushCalls.map(c => c.body.batch_id);
  assert.strictEqual(ids[1], ids[2], 'retry reused the batch id');
  await t.done();
});

test('app offline for a while: the room total catches up (500 per push, rest deferred)', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R9');
  t.link.like(1, '1001');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.link.like(20, '2201');                             // 1,200 taps happened while we were away
  assert.ok(await until(() => t.mock.state.credited === 1201, 6000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('dry run checks everything but credits nothing', async () => {
  const t = await setup({ autoApprove: true, enabled: false });
  await t.ctl.pair('TEST2345');
  assert.strictEqual(t.link.username, null, 'disabled + not dry run -> no TikTok');
  assert.match(t.ctl.s.message.text, /isn't switched on/);
  t.ctl.setDryRun(true);
  assert.strictEqual(t.link.username, 'test_host');
  t.link.goLive('R2');
  t.link.like(10, '510');
  t.link.like(10, '520');
  assert.ok(await until(() => t.mock.state.pushes.length >= 2));
  assert.strictEqual(t.mock.state.credited, 0);
  assert.ok(t.mock.state.pushes.every(p => p.dry_run === true));
  await t.done();
});

test('revoked device: stops, forgets the token, asks to reconnect', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.mock.revokeAll();
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.phase, 'revoked');
  assert.strictEqual(t.store.getToken(), null);
  assert.strictEqual(t.link.username, null);
  await t.done();
});

test('unverified TikTok / missing username never connects', async () => {
  const t = await setup({ autoApprove: true, verified: false });
  await t.ctl.pair('TEST2345');
  assert.strictEqual(t.link.username, null);
  assert.match(t.ctl.s.message.text, /verify your TikTok|Add your TikTok username/i);
  await t.done();
});

test('too-old app version -> update required, no TikTok', async () => {
  const t = await setup({ autoApprove: true, minAppVersion: '1.2.0' });
  await t.ctl.pair('TEST2345');
  assert.strictEqual(t.ctl.s.phase, 'update_required');
  assert.strictEqual(t.link.username, null);
  await t.done();
});

test('restart: refresh rotates the token and the old one stops working', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  const first = t.store.getToken();
  t.ctl.stop();
  await t.ctl.start();
  const second = t.store.getToken();
  assert.ok(second && second !== first);
  assert.strictEqual(t.ctl.s.phase, 'ready');
  await t.done();
});

test('bad pair code surfaces the error code', async () => {
  const t = await setup();
  await assert.rejects(() => t.ctl.pair('WRONG999'), (e) => e.code === 'invalid_code');
  await t.done();
});


test('a LIVE that ends before the next push still gets its last taps and backlog credited', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));      // baseline (100)
  t.link.like(1200, '1310');                                         // big burst...
  t.link._set({ status: 'offline', roomId: null });                  // ...then the stream ends at once
  assert.ok(await until(() => t.mock.state.credited === 1210, 6000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('leaving test mode never credits the taps seen during the test', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  t.link.like(10, '120');
  assert.ok(await until(() => t.mock.state.credited === 20), `credited ${t.mock.state.credited}`);
  t.ctl.setDryRun(true);
  t.link.like(500, '620');                                           // test-period taps
  assert.ok(await until(() => t.mock.state.pushes.some(p => p.dry_run)));
  t.ctl.setDryRun(false);
  t.link.like(7, '627');
  assert.ok(await until(() => t.mock.state.pushes.some(p => p.rebaseline)), 'asked the site to re-baseline');
  t.link.like(3, '630');
  assert.ok(await until(() => t.mock.state.credited === 23, 4000), `credited ${t.mock.state.credited}`);
  await wait(300);
  assert.strictEqual(t.mock.state.credited, 23, 'the 500 test taps (and the re-baseline gap) were not credited');
  await t.done();
});

test('disconnect while a push retry is pending, then connect again: pushes still work', async () => {
  const t = await setup({ autoApprove: true });
  t.mock.state.codes.set('SECOND22', { host_id: 'host-1', expires: Date.now() + 600000, used: false });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.mock.state.failNext.push({ path: 'live-link-push', status: 503 });
  t.link.like(10, '120');
  assert.ok(await until(() => t.mock.state.calls.filter(c => c.path === 'live-link-push').length === 2));
  t.ctl.unpair();                                                    // retry timer pending right now
  assert.strictEqual(t.ctl.s.phase, 'unpaired');
  await t.ctl.pair('SECOND22');
  t.link.goLive('R7');
  t.link.like(5, '905');
  t.link.like(5, '910');
  assert.ok(await until(() => t.mock.state.pushes.some(p => p.tiktok_room_id === 'R7' && p.session_total === 910), 4000));
  assert.notStrictEqual(t.ctl.s.phase, 'revoked');
  await t.done();
});

test('site says not_live: pause, forget those taps, resume counting when the show starts', async () => {
  const t = await setup({ autoApprove: true, notLiveReturns409: true });
  t.mock.state.host.site_live = false;
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(50, '1050');                                          // pre-show taps
  assert.ok(await until(() => t.ctl.pausedForSite));
  t.link.like(50, '1100');
  t.mock.state.host.site_live = true;                                // host starts the show
  await t.ctl._loadConfig();
  t.link.like(20, '1120');
  t.link.like(10, '1130');
  assert.ok(await until(() => t.mock.state.credited === 30, 4000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('a 401 for a token the app already rotated does not unpair it', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  const tok = t.store.getToken();
  t.ctl._handleApiError(new ApiError(401, 'device_revoked', 'old', { tokenUsed: 'an-older-token' }), 'config');
  assert.strictEqual(t.ctl.s.phase, 'ready');
  assert.strictEqual(t.store.getToken(), tok);
  await t.done();
});

test('failing status calls back off instead of hammering every 1.5 s', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  for (let i = 0; i < 10; i++) t.mock.state.failNext.push({ path: 'live-link-status', status: 503 });
  t.link._set({ status: 'offline', roomId: null, error: null });     // a state change -> status call
  await wait(4500);
  const n = t.mock.state.calls.filter(c => c.path === 'live-link-status').length;
  assert.ok(n <= 2, `${n} status calls in 4.5 s`);
  await t.done();
});

test('a 2xx with a garbled body is not treated as a config', async () => {
  const bad = new LiveLinkApi({ baseUrl: 'http://x/', getToken: () => 't', fetch: async () => ({ ok: true, status: 200, text: async () => '<html>proxy</html>', headers: { get: () => null } }) });
  await assert.rejects(() => bad.config(), (e) => e.code === 'network');
});


test('config: dashboard link (site only) and signed update link are picked up', async () => {
  const t = await setup({ autoApprove: true, latest: { version: '1.0.1', download_url: 'https://bxiejoktoknybpraxebm.supabase.co/storage/v1/object/sign/live-link/1.0.1/LIVE-Link-Setup-1.0.1.exe?token=x', sha256: 'ab' } });
  await t.ctl.pair('TEST2345');
  assert.strictEqual(t.ctl.s.dashboardUrl, 'https://reactivvibeai.com/dashboard?tab=live-link');
  assert.deepStrictEqual([t.ctl.s.update.available, t.ctl.s.update.version], [true, '1.0.1']);
  t.ctl.cfg.dashboard_url = 'https://evil.example/phish';
  t.ctl._applyConfig();
  assert.strictEqual(t.ctl.s.dashboardUrl, null, 'only reactivvibeai.com links are opened');
  await t.done();
});

test('unverified TikTok says "verify", not "add your username", and the checklist shows each step', async () => {
  const t = await setup({ autoApprove: true, verified: false });
  await t.ctl.pair('TEST2345');
  assert.match(t.ctl.s.message.text, /verify your TikTok/i);
  const byKey = Object.fromEntries(t.ctl.s.steps.map((r) => [r.key, r]));
  assert.strictEqual(byKey.pc.state, 'done');
  assert.strictEqual(byKey.tt.state, 'todo');
  assert.strictEqual(byKey.tt.action, 'dashboard');
  assert.strictEqual(byKey.live.state, 'off');
  assert.strictEqual(byKey.site.state, 'done');
  await t.done();
});

test('checklist: test mode and a not-yet-live TikTok show as waiting with a Check now action', async () => {
  const t = await setup({ autoApprove: true, enabled: false });
  await t.ctl.pair('TEST2345');
  t.ctl.setDryRun(true);
  t.link._set({ status: 'offline', roomId: null, retryAt: Date.now() + 30000 });
  const byKey = Object.fromEntries(t.ctl.s.steps.map((r) => [r.key, r]));
  assert.strictEqual(byKey.tt.state, 'done');
  assert.strictEqual(byKey.send.state, 'test');
  assert.strictEqual(byKey.live.state, 'wait');
  assert.strictEqual(byKey.live.action, 'check');
  assert.ok(byKey.live.retryAt > Date.now());
  assert.match(t.ctl.s.message.text, /Waiting for @test_host to go LIVE/);
  await t.done();
});
