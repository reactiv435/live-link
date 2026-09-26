'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { createMock } = require('./mock-server');
const { LiveLinkApi } = require('../src/core/api');
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
  assert.match(t.ctl.s.message.text, /Add your TikTok username|Verify your TikTok/);
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
