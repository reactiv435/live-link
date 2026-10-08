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
  retryNow() { this.retries = (this.retries || 0) + 1; }
  wake(fromSleep) { this.wakes = (this.wakes || []).concat(fromSleep); }
  _set(p) { this.state = { ...this.state, ...p }; if (p.roomId && p.roomId !== this.lastRoom) { this.lastRoom = p.roomId; this.emit('roomChanged', p.roomId); } this.emit('state', { ...this.state }); }
  goLive(room = 'R1') { this._set({ status: 'live', roomId: room }); }
  like(count, total) { this.emit('like', { count, total, at: Date.now() }); }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } return false; }

async function setup(mockOpts = {}, ctlOpts = {}) {
  const mock = createMock({ pushIntervalMs: 60, ...mockOpts });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-'));
  const store = new Store({ dir });
  const link = new FakeLink();
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  const logs = [];
  const ctl = new Controller({ api, link, store, appVersion: '1.0.0', deviceName: 'TEST-PC', log: (l, m) => logs.push(`${l} ${m}`), ...ctlOpts });
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
  assert.match(t.ctl.s.message.text, /switched on for your channel yet/);
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
  assert.ok(await until(() => t.mock.state.pushes.some(p => p.rebaseline && !p.dry_run && p.session_total === 620)), 'baselined where Test mode ended');
  t.link.like(3, '630');
  assert.ok(await until(() => t.mock.state.credited === 30, 4000), `credited ${t.mock.state.credited}`);
  await wait(300);
  assert.strictEqual(t.mock.state.credited, 30, 'the 500 test taps were not credited; the 10 after Test mode ended were');
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

test('Pause stops watching TikTok (not kept across a restart); Resume re-baselines', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  t.link.like(10, '120');
  assert.ok(await until(() => t.mock.state.credited === 20), `credited ${t.mock.state.credited}`);
  assert.strictEqual(t.ctl.s.atom, 'live');
  t.ctl.setPaused(true);
  assert.strictEqual(t.link.username, null, 'Disconnect stops the TikTok link');
  assert.strictEqual(t.ctl.s.atom, 'off');
  assert.strictEqual(t.store.get('paused'), undefined, 'not saved: a restart always watches again');
  assert.match(t.ctl.s.message.text, /^Paused/);
  assert.strictEqual(t.ctl.s.steps.find((r) => r.key === 'live').state, 'off');
  t.ctl.setPaused(false);
  assert.strictEqual(t.link.username, 'test_host', 'Resume starts watching again');
  t.link.goLive('R1');
  t.link.like(500, '900');                 // 380 taps happened while disconnected, then this batch of 500
  assert.ok(await until(() => t.mock.state.pushes.some((p) => p.rebaseline && p.session_total === 400)), 'baselined just before the first fresh batch');
  t.link.like(5, '905');
  assert.ok(await until(() => t.mock.state.credited === 525, 4000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('a LIVE session: timer + taps/min while live, end-of-LIVE summary when TikTok says offline', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  const ended = [];
  t.ctl.on('sessionEnded', (x) => ended.push(x));
  t.link.goLive('R1');
  assert.strictEqual(typeof t.ctl.s.liveSince, 'number', 'LIVE timer starts');
  t.link._set({ viewers: 42 });
  t.link.like(10, '110');                              // baseline 100: both batches count
  t.link.like(5, '115');
  t.ctl._render();
  assert.strictEqual(t.ctl.s.tapsPerMin, 15);
  assert.ok(await until(() => t.ctl.s.taps.accepted === 15), `accepted ${t.ctl.s.taps.accepted}`);
  t.link._set({ viewers: 30 });
  t.link._set({ status: 'reconnecting' });             // the stream dropped...
  assert.strictEqual(ended.length, 0, 'a drop alone is not the end');
  t.link._set({ status: 'offline', roomId: null });    // ...and TikTok confirms the LIVE is over
  assert.strictEqual(ended.length, 1);
  const x = ended[0];
  assert.strictEqual(x.taps, 15);
  assert.strictEqual(x.accepted, 15);
  assert.strictEqual(x.peakViewers, 42);
  assert.strictEqual(x.reason, 'ended');
  assert.ok(x.endedAt >= x.startedAt);
  assert.strictEqual(t.ctl.s.liveSince, null);
  assert.deepStrictEqual(t.store.get('lastSession'), x, 'summary kept across restarts');
  await t.done();
});

test('Disconnect ends the session; a blip with no taps leaves no summary', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.ctl.setPaused(true);
  assert.strictEqual(t.ctl.s.lastSession, null, 'connected for a moment, no taps: nothing to report');
  t.ctl.setPaused(false);
  t.link.goLive('R2');
  t.link.like(3, '53');
  t.ctl.setPaused(true);
  assert.strictEqual(t.ctl.s.lastSession.taps, 3);
  assert.strictEqual(t.ctl.s.lastSession.reason, 'disconnected');
  assert.strictEqual(t.ctl.s.atom, 'off');
  await t.done();
});

test('connected before the first tap (total == count): the baseline is 1, never the 0 the site refuses', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '10');                               // a fresh room: the first batch IS the whole room total
  assert.ok(await until(() => t.mock.state.pushes.length === 1), 'baseline push accepted');
  assert.strictEqual(t.mock.state.pushes[0].session_total, 1);
  t.link.like(5, '15');
  assert.ok(await until(() => t.mock.state.credited === 14), `credited ${t.mock.state.credited}`);
  assert.ok(!t.mock.state.rejected, `the site refused ${t.mock.state.rejected} pushes`);
  await t.done();
});

test('a refused push keeps its totals: resent without the events, nothing lost', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  t.mock.state.failNext.push({ path: 'live-link-push', status: 400, error: 'validation', extra: { details: { field: 'events.at' } } });
  t.link.like(20, '130');
  assert.ok(await until(() => t.mock.state.credited === 30), `credited ${t.mock.state.credited}`);
  assert.ok(t.mock.state.pushes.some(p => p.session_total === 130 && p.events.length === 0), 'same total, no events');
  t.link.like(5, '135');
  assert.ok(await until(() => t.mock.state.credited === 35), `credited ${t.mock.state.credited}`);
  assert.strictEqual(t.ctl.s.pushRejected, null);
  await t.done();
});

test('a refused session_total: the app counts again from now, says so, and is not stuck', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  t.mock.state.failNext.push({ path: 'live-link-push', status: 400, error: 'validation', extra: { details: { field: 'session_total' } } });
  t.link.like(20, '130');
  assert.ok(await until(() => t.ctl.s.pushRejected !== null), 'the refusal is shown');
  assert.strictEqual(t.ctl.s.pushRejected.field, 'session_total');
  assert.ok(await until(() => t.mock.state.pushes.some(p => p.rebaseline && p.session_total === 130)), 'counts from now');
  t.link.like(5, '135');
  assert.ok(await until(() => t.mock.state.credited === 5), `credited ${t.mock.state.credited}`);
  assert.strictEqual(t.ctl.s.pushRejected, null, 'cleared by the next good push');
  await t.done();
});

test('Connect in the same LIVE: taps from the disconnected stretch never count, even when the first push would race the first like', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  t.link.like(10, '120');
  assert.ok(await until(() => t.mock.state.credited === 20), `credited ${t.mock.state.credited}`);
  t.ctl.setPaused(true);
  t.ctl.setPaused(false);
  t.link.goLive('R1');                     // same room: no roomChanged, same batcher
  await wait(1300);                        // longer than a push interval: nothing stale may go out meanwhile
  assert.ok(!t.mock.state.pushes.some(p => p.session_total === 120 && p.rebaseline), 'no baseline at the stale total');
  t.link.like(5, '905');                   // 780 taps happened while disconnected
  assert.ok(await until(() => t.mock.state.credited === 25, 4000), `credited ${t.mock.state.credited}`);
  await wait(300);
  assert.strictEqual(t.mock.state.credited, 25);
  await t.done();
});

test('Disconnect sends the taps already collected before it stops', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  t.link.like(40, '150');
  t.ctl.setPaused(true);                   // before the next push would have gone out
  assert.ok(await until(() => t.mock.state.credited === 50), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('the error text sent with a status is capped (an oversized body would be refused)', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link._set({ status: 'error', error: 'x'.repeat(20000) });
  assert.strictEqual(t.ctl._statusBody(false).last_error.length, 500);
  await t.done();
});

test('the token refresh keeps retrying past its schedule until the site answers', async () => {
  const t = await setup({ autoApprove: true }, { refreshRetryMs: [30, 30] });
  await t.ctl.pair('TEST2345');
  const before = t.store.getToken();
  for (let i = 0; i < 4; i++) t.mock.state.failNext.push({ path: 'live-link-refresh', status: 503 });
  await t.ctl._refreshToken();
  assert.ok(await until(() => t.store.getToken() !== before), 'rotated on the 5th try');
  assert.strictEqual(t.ctl.s.siteError, null, 'background failures never claimed the site was down');
  await t.done();
});

test('stopping the link on purpose closes the LIVE session as "stopped"', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  const ended = [];
  t.ctl.on('sessionEnded', (x) => ended.push(x));
  t.link.goLive('R1');
  t.link.like(4, '104');
  t.link.stop();
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].reason, 'stopped');
  assert.strictEqual(ended[0].roomId, 'R1');
  assert.strictEqual(t.ctl.s.liveSince, null);
  await t.done();
});

test('taps credited after the LIVE ended (deferred backlog) still land in its summary', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  t.link.like(1200, '1310');
  t.link._set({ status: 'offline', roomId: null });                  // the LIVE ends with 1,210 taps still to credit
  assert.ok(await until(() => t.mock.state.credited === 1210, 6000), `credited ${t.mock.state.credited}`);
  assert.ok(await until(() => t.ctl.s.lastSession && t.ctl.s.lastSession.accepted === 1210),
    `summary says ${t.ctl.s.lastSession && t.ctl.s.lastSession.accepted}`);
  assert.strictEqual(t.store.get('lastSession').accepted, 1210);
  await t.done();
});

test('a token refresh whose answer is lost is retried while the previous token still works', async () => {
  const t = await setup({ autoApprove: true }, { refreshRetryMs: [50, 50, 50, 50] });
  await t.ctl.pair('TEST2345');
  const before = t.store.getToken();
  t.mock.state.failNext.push({ path: 'live-link-refresh', status: 503 });
  await t.ctl._refreshToken();                         // fails: the app keeps its token and schedules a retry
  assert.strictEqual(t.store.getToken(), before);
  assert.ok(await until(() => t.store.getToken() !== before), 'the retry rotated the token');
  assert.strictEqual(t.ctl.s.phase, 'ready');
  await t.done();
});

test('a new LIVE does not drop the taps the site still owes the last one (deferred backlog is drained)', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  t.link.like(2000, '2110');                                         // 2,010 owed; the site credits 500 per push
  assert.ok(await until(() => t.mock.state.credited >= 500), `credited ${t.mock.state.credited}`);
  t.link._set({ status: 'offline', roomId: null });
  t.link.goLive('R2');                                               // the next LIVE begins at once
  assert.ok(await until(() => t.mock.state.credited === 2010, 15000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('Disconnect right after a burst still delivers the whole backlog it saw', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  t.link.like(1200, '1310');
  t.ctl.setPaused(true);
  assert.ok(await until(() => t.mock.state.credited === 1210, 10000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('turning Test mode on sends the real taps already seen as real', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline 100
  assert.ok(await until(() => !t.ctl.batcher.rebase), 'the app has the baseline answer');
  t.link.like(40, '150');
  t.ctl.setDryRun(true);
  assert.ok(await until(() => t.mock.state.credited === 50), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('Test mode turned off during a TikTok outage: the outage\'s test taps never count', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.ctl.setDryRun(true);
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.some(p => p.dry_run)));
  t.link._set({ status: 'reconnecting' });                           // TikTok drops...
  t.ctl.setDryRun(false);                                            // ...Test mode ends during the outage
  t.link._set({ status: 'live' });                                   // same room again; 90 test taps happened meanwhile
  t.link.like(5, '205');
  assert.ok(await until(() => t.mock.state.pushes.some(p => !p.dry_run && p.rebaseline && p.session_total === 200)), 'baselined at the fresh total');
  t.link.like(5, '210');
  assert.ok(await until(() => t.mock.state.credited === 10), `credited ${t.mock.state.credited}`);
  await wait(300);
  assert.strictEqual(t.mock.state.credited, 10);
  await t.done();
});

const gift = (key, count, { coins = 1, name = 'Rose', handle = 'maria', units = 1 } = {}) =>
  ({ key, count, units, coins, giftId: '5655', name, imageUrl: null, userHandle: handle, userName: handle.toUpperCase(), at: Date.now() });

test('gifts: a combo is credited live at 10 taps per coin, never twice, and shows in the window', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));   // baseline
  t.link.emit('gift', gift('c:combo0000001:0', 1));
  t.link.emit('gift', gift('c:combo0000001:0', 2));
  t.link.emit('gift', gift('c:combo0000001:0', 3));
  assert.ok(await until(() => t.mock.state.giftTaps === 30), `gift taps ${t.mock.state.giftTaps}`);
  t.link.emit('gift', gift('c:combo0000001:0', 3, { units: 0 }));    // a repeat can never add
  await wait(1300);
  assert.strictEqual(t.mock.state.giftTaps, 30);
  assert.ok(await until(() => t.ctl.s.gifts.taps === 30), `app gift taps ${t.ctl.s.gifts.taps}`);
  assert.strictEqual(t.ctl.s.gifts.coins, 3);
  assert.strictEqual(t.ctl.s.gifts.recent[0].units, 3, 'merged into one line');
  assert.strictEqual(t.ctl.s.gifts.top.who, 'maria');
  assert.strictEqual(t.ctl.s.giftsEnabled, true);
  await t.done();
});

test('gifts: a gift before any like total goes out gifts-only, without setting a baseline', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.emit('gift', gift('m:70000009001', 1, { coins: 1000, name: 'Galaxy' }));
  assert.ok(await until(() => t.mock.state.giftTaps === 10000), `gift taps ${t.mock.state.giftTaps}`);
  const p = t.mock.state.pushes.find((x) => x.gifts);
  assert.strictEqual(p.session_total, undefined, 'no made-up total');
  assert.ok(!t.mock.state.rooms.has('R1'), 'no baseline was set');
  t.link.like(5, '205');
  t.link.like(5, '210');
  assert.ok(await until(() => t.mock.state.credited === 10), `credited ${t.mock.state.credited}`);
  await wait(300);
  assert.strictEqual(t.mock.state.credited, 10, 'likes from before LIVE Link saw a total never count');
  await t.done();
});

test('gifts in Test mode are checked but never credited', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.ctl.setDryRun(true);
  t.link.goLive('R1');
  t.link.emit('gift', gift('m:70000009002', 1, { coins: 30, name: 'Doughnut' }));
  assert.ok(await until(() => t.mock.state.pushes.some((x) => x.gifts && x.dry_run)));
  assert.strictEqual(t.mock.state.giftTaps, 0);
  await t.done();
});

test('gifts seen right before Disconnect still reach the site', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.link.emit('gift', gift('m:70000009003', 1, { coins: 5, name: 'Finger Heart' }));
  t.ctl.setPaused(true);
  assert.ok(await until(() => t.mock.state.giftTaps === 50), `gift taps ${t.mock.state.giftTaps}`);
  await t.done();
});

test('a refusal of something else keeps the gifts; refused gifts are dropped and taps keep flowing', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.mock.state.failNext.push({ path: 'live-link-push', status: 400, error: 'validation', extra: { details: { field: 'events.at' } } });
  t.link.like(10, '120');
  t.link.emit('gift', gift('m:70000009004', 1, { coins: 1 }));
  assert.ok(await until(() => t.mock.state.giftTaps === 10 && t.mock.state.credited === 20), `gifts ${t.mock.state.giftTaps} taps ${t.mock.state.credited}`);
  t.mock.state.failNext.push({ path: 'live-link-push', status: 400, error: 'validation', extra: { details: { field: 'gifts.name' } } });
  t.link.like(10, '130');
  t.link.emit('gift', gift('m:70000009005', 1, { coins: 1 }));
  assert.ok(await until(() => t.mock.state.credited === 30), `credited ${t.mock.state.credited}`);
  await wait(1500);
  assert.strictEqual(t.mock.state.giftTaps, 10, 'the refused gift was not resent forever');
  assert.ok(t.logs.some((l) => /gift frames dropped/.test(l)));
  await t.done();
});

test('the end-of-LIVE summary includes gifts and the top gifter', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.link.emit('gift', gift('m:70000009006', 1, { coins: 30, name: 'Doughnut', handle: 'sam' }));
  t.link.emit('gift', gift('m:70000009007', 1, { coins: 1, name: 'Rose', handle: 'maria' }));
  assert.ok(await until(() => t.mock.state.giftTaps === 310));
  assert.ok(await until(() => t.ctl.s.gifts.taps === 310));
  t.link._set({ status: 'offline', roomId: null });
  const x = t.ctl.s.lastSession;
  assert.strictEqual(x.giftCoins, 31);
  assert.strictEqual(x.giftTaps, 310);
  assert.deepStrictEqual(x.topGifter, { who: 'sam', coins: 30 });
  await t.done();
});

test('a push the site finds too big (413) keeps its gifts and sends them in smaller batches: none lost', async () => {
  const t = await setup({ autoApprove: true, maxBody: 3500 });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  for (let i = 0; i < 30; i++) t.link.emit('gift', gift(`m:80000000${String(i).padStart(2, '0')}`, 1, { name: 'Rose ' + 'x'.repeat(40), handle: 'fan_' + 'y'.repeat(40) + i }));
  assert.ok(await until(() => t.mock.state.giftTaps === 300, 15000), `gift taps ${t.mock.state.giftTaps}, 413s ${t.mock.state.tooBig}`);
  assert.ok(t.mock.state.tooBig >= 1, 'the site did refuse a too-big push');
  assert.ok(!t.logs.some((l) => /gift frames dropped/.test(l)), 'no gift was dropped');
  await t.done();
});

test('Disconnect right after a big gift burst delivers EVERY queued gift, in chunks', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  for (let i = 0; i < 80; i++) t.link.emit('gift', gift(`m:81000000${String(i).padStart(2, '0')}`, 1, { name: 'Rose ' + 'x'.repeat(40), handle: 'fan_' + 'y'.repeat(30) + i }));
  t.ctl.setPaused(true);                                             // before the next push would have gone out
  assert.ok(await until(() => t.mock.state.giftTaps === 800, 15000), `gift taps ${t.mock.state.giftTaps}`);
  assert.strictEqual(t.ctl.batcher.gifts.length, 0);
  await t.done();
});

test('gifts seen during Test mode never count after Test mode ends', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.ctl.setDryRun(true);
  t.link.goLive('R1');
  t.link.like(10, '110');
  t.link.emit('gift', gift('m:8200000001', 1, { coins: 1000, name: 'Galaxy' }));
  t.ctl.setDryRun(false);                                            // before the dry push went out
  await wait(2500);
  assert.strictEqual(t.mock.state.giftTaps, 0);
  await t.done();
});

test('quitting right after a gift sends it first', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.link.emit('gift', gift('m:8300000001', 1, { coins: 1000, name: 'Galaxy' }));
  assert.ok(t.ctl.hasPendingGifts());
  await t.ctl.flushBeforeQuit(3000);
  assert.strictEqual(t.mock.state.giftTaps, 10000);
  assert.ok(!t.ctl.hasPendingGifts());
  await t.done();
});

// ---------------------------------------------------------------- 1.0.5: smooth-running review fixes

test('Pause is never restored after a restart (an older version\'s saved flag is dropped)', async () => {
  const t = await setup({ autoApprove: true });
  t.store.set('paused', true);                                        // what 1.0.4 saved
  const ctl2 = new Controller({ api: t.api, link: t.link, store: t.store, appVersion: '1.0.5', deviceName: 'TEST-PC' });
  assert.strictEqual(ctl2.s.paused, false);
  assert.strictEqual(t.store.get('paused'), undefined);
  ctl2.stop();
  await t.done();
});

test('paused: the site is told why, and it resumes by itself when the next show starts', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  const resumed = [];
  t.ctl.on('autoResumed', () => resumed.push(1));
  t.ctl.setPaused(true);
  assert.ok(await until(() => t.mock.state.statuses.some((x) => x.last_error === 'Paused in the app' && x.connected === false)), 'status says "Paused in the app"');
  t.mock.state.host.site_live = true;
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.paused, true, 'a show that was already on does not resume it');
  t.mock.state.host.site_live = false;                                // the show ends...
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.paused, true);
  assert.strictEqual(t.ctl._configEvery(), 15000, 'while paused, the site is checked often for the next show');
  t.mock.state.host.site_live = true;                                 // ...and the next one starts
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.paused, false);
  assert.strictEqual(t.link.username, 'test_host', 'watching TikTok again');
  assert.strictEqual(resumed.length, 1, 'the app shows a pop-up');
  await t.done();
});

test('"Check TikTok now" resumes a paused app', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.ctl.setPaused(true);
  t.ctl.retryNow();
  assert.strictEqual(t.ctl.s.paused, false);
  assert.strictEqual(t.link.username, 'test_host');
  await t.done();
});

test('the atom is green only while taps fill the bar: gold for test mode, no song, or the show not on', async () => {
  const t = await setup({ autoApprove: true, target: null });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  assert.strictEqual(t.ctl.s.atom, 'hold');
  assert.strictEqual(t.ctl.s.hold, 'song');
  assert.strictEqual(t.ctl.s.connected, true);
  assert.match(t.ctl.s.message.text, /Put a song on air/);
  t.mock.state.target = { submission_id: 'sub-1', title: 'Test Song' };
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.atom, 'live');
  assert.strictEqual(t.ctl.s.hold, null);
  t.ctl.setDryRun(true);
  assert.strictEqual(t.ctl.s.atom, 'hold');
  assert.strictEqual(t.ctl.s.hold, 'test');
  t.ctl.setDryRun(false);
  t.mock.state.host.site_live = false;
  await t.ctl._loadConfig();
  assert.strictEqual(t.ctl.s.hold, 'show');
  assert.match(t.ctl.s.message.text, /Start your show/);
  t.link._set({ status: 'reconnecting' });
  assert.strictEqual(t.ctl.s.atom, 'connecting');
  assert.strictEqual(t.ctl.s.connected, false);
  await t.done();
});

test('a dropped LIVE says so ("lost") while it reconnects', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link._set({ status: 'reconnecting' });
  assert.strictEqual(t.ctl.s.lost, true);
  assert.match(t.ctl.s.message.text, /^Lost the connection to your LIVE/);
  t.link._set({ status: 'live' });
  assert.strictEqual(t.ctl.s.lost, false);
  await t.done();
});

test('TikTok trouble with working internet never says "check the internet"; without it, it does', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link._set({ status: 'error', errorKind: 'timeout', error: 'TikTok did not answer for 90 s' });
  assert.match(t.ctl.s.message.text, /your internet works/);
  assert.doesNotMatch(t.ctl.s.message.text, /Check this computer's internet/);
  assert.match(t.ctl.s.steps.find((r) => r.key === 'live').text, /your internet works/);
  t.ctl.s.siteError = "Can't reach the site (getaddrinfo ENOTFOUND).";
  t.ctl._render();
  assert.match(t.ctl.s.steps.find((r) => r.key === 'live').text, /Check this computer's internet/);
  await t.done();
});

test('the site coming back after a network outage makes TikTok try again at once', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  const before = t.link.retries || 0;
  t.ctl._handleApiError(new ApiError(0, 'network', "Can't reach the site (ENOTFOUND)."), 'config');
  await t.ctl._loadConfig();
  assert.strictEqual(t.link.retries, before + 1);
  await t.ctl._loadConfig();
  assert.strictEqual(t.link.retries, before + 1, 'only once per outage');
  await t.done();
});

test('a push the site keeps failing on (5xx) while the rest of the site answers is resent without its events', async () => {
  const t = await setup({ autoApprove: true }, { retryStepsMs: [40, 40, 40, 40, 40] });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));    // baseline 100
  t.mock.state.failWhen = (p, body) => p === 'live-link-push' && body.events && body.events.length > 0;
  t.link.like(40, '150');
  assert.ok(await until(() => t.mock.state.credited === 50, 5000), `credited ${t.mock.state.credited}`);
  assert.ok(t.logs.some((l) => /resending without its events/.test(l)), 'logged');
  t.mock.state.failWhen = null;
  t.link.like(5, '155');
  assert.ok(await until(() => t.mock.state.credited === 55, 3000), 'taps keep flowing afterwards');
  await t.done();
});

test('while the WHOLE site fails, a push is only retried (never peeled)', async () => {
  const t = await setup({ autoApprove: true }, { retryStepsMs: [40, 40, 40, 40, 40] });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.mock.state.failWhen = () => true;
  t.link.like(40, '150');
  await wait(800);
  assert.ok(!t.logs.some((l) => /resending without/.test(l)), 'not treated as a poison batch');
  t.mock.state.failWhen = null;
  assert.ok(await until(() => t.mock.state.credited === 50, 4000), `credited ${t.mock.state.credited}`);
  await t.done();
});

test('quitting tells the site this computer stopped watching, and nothing goes out after it', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  assert.ok(await t.ctl.sendFinalStatus(1500));
  const last = t.mock.state.statuses.at(-1);
  assert.strictEqual(last.connected, false);
  assert.match(last.last_error, /closed/);
  const n = t.mock.state.calls.length;
  t.link.like(10, '110');
  await wait(400);
  assert.strictEqual(t.mock.state.calls.length, n);
  await t.mock.close();
});

test('waking from sleep looks at TikTok and the site right away; a paused app stays paused', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  const configs = () => t.mock.state.calls.filter((c) => c.path.startsWith('live-link-config')).length;
  const c0 = configs();
  t.ctl.wake(true);
  assert.deepStrictEqual(t.link.wakes, [true]);
  assert.ok(await until(() => configs() === c0 + 1));
  t.ctl.setPaused(true);
  t.ctl.wake(false);
  assert.deepStrictEqual(t.link.wakes, [true], 'a paused app does not touch TikTok');
  await t.done();
});

test('a saved sign-in the OS refuses to open (Mac Keychain "Deny") is never wiped; Retry opens it once allowed', async () => {
  const mock = createMock({ pushIntervalMs: 60, autoApprove: true });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-'));
  let allow = true;
  const cipher = { available: () => true, encrypt: (s) => Buffer.from('enc:' + s), decrypt: (b) => { if (!allow) throw new Error('denied'); return b.toString().slice(4); } };
  const s1 = new Store({ dir, cipher, allowPlain: false });
  const api1 = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => s1.getToken() });
  const c1 = new Controller({ api: api1, link: new FakeLink(), store: s1, appVersion: '1.0.5', deviceName: 'MAC' });
  await c1.pair('TEST2345');
  c1.stop();
  allow = false;                                                      // the next launch: Keychain says no
  const s2 = new Store({ dir, cipher, allowPlain: false });
  const link = new FakeLink();
  const api2 = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => s2.getToken() });
  const c2 = new Controller({ api: api2, link, store: s2, appVersion: '1.0.5', deviceName: 'MAC', platform: 'darwin' });
  await c2.start();
  assert.strictEqual(c2.s.phase, 'locked');
  assert.match(c2.s.message.text, /Always Allow/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).tokenEnc, 'the saved sign-in is kept');
  c2.retryNow();                                                      // still denied
  assert.strictEqual(c2.s.phase, 'locked');
  allow = true;
  c2.retryNow();
  assert.ok(await until(() => c2.s.phase === 'ready'), `phase ${c2.s.phase}`);
  assert.strictEqual(link.username, 'test_host');
  c2.stop();
  await mock.close();
});

test('a packaged app never writes the sign-in token in clear text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-'));
  const s = new Store({ dir, cipher: { available: () => false }, allowPlain: false });
  s.setToken('secret-token');
  assert.strictEqual(s.getToken(), 'secret-token', 'kept in memory for this run');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(!('tokenPlain' in saved) && !('tokenEnc' in saved));
  // an old clear-text token moves into the OS store once one exists
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tokenPlain: 'old-token' }));
  const s2 = new Store({ dir, cipher: { available: () => true, encrypt: (x) => Buffer.from('enc:' + x), decrypt: (b) => b.toString().slice(4) }, allowPlain: false });
  assert.strictEqual(s2.getToken(), 'old-token');
  const moved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(moved.tokenEnc && !moved.tokenPlain);
});

test('after a 413 the gift batch size grows back once pushes are clean again', async () => {
  const t = await setup({ autoApprove: true });
  await t.ctl.pair('TEST2345');
  t.link.goLive('R1');
  t.link.like(10, '110');
  assert.ok(await until(() => t.mock.state.pushes.length === 1));
  t.ctl.giftsPerPush = 5;
  for (let i = 0; i < 12; i++) {
    t.link.emit('gift', gift(`m:84000000${String(i).padStart(2, '0')}`, 1));
    assert.ok(await until(() => t.mock.state.pushes.filter((p) => p.gifts).length === i + 1, 3000), `gift push ${i}`);
  }
  assert.strictEqual(t.ctl.giftsPerPush, 10);
  await t.done();
});
