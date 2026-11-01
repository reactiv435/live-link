'use strict';
// 2.0.9: a viewer sample goes out every few minutes while a LIVE runs, on its own endpoint. It never stops the taps
// and never reaches the host's screen: a failed or missing endpoint only ends up in the log.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { createMock } = require('./mock-server');
const { LiveLinkApi } = require('../src/core/api');
const { Controller } = require('../src/core/controller');
const { Store } = require('../src/core/store');

class FakeLink extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null }; this.username = null; }
  get running() { return !!this.username; }
  setOfflinePoll() {}
  start(u) { this.username = u; }
  stop() { this.username = null; this._set({ status: 'idle', roomId: null, viewers: 0 }); }
  retryNow() {}
  wake() {}
  _set(p) { this.state = { ...this.state, ...p }; if (p.roomId && p.roomId !== this.lastRoom) { this.lastRoom = p.roomId; this.emit('room', p.roomId); } this.emit('state', this.state); }
  goLive(room = 'R1', viewers = 0) { this._set({ status: 'live', roomId: room, viewers }); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); } return false; }

async function rig(opts = {}) {
  const mock = createMock({ autoApprove: true, pushIntervalMs: 60, ...opts });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-209-'));
  const store = new Store({ dir });
  const link = new FakeLink();
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  const ctl = new Controller({ api, link, store, appVersion: '2.0.9', deviceName: 'TEST-PC' });
  await ctl.pair('TEST2345');
  ctl.cfg.viewers_interval_ms = 40;
  return { mock, link, ctl };
}

test('viewers: samples go out while LIVE, carry only the room and the count, and stop when the LIVE ends', async () => {
  const { mock, link, ctl } = await rig();
  link.goLive('R1', 212);
  assert.ok(await until(() => mock.state.viewerSamples.length >= 2));
  assert.deepEqual(mock.state.viewerSamples[0], { tiktok_room_id: 'R1', viewers: 212 });
  link._set({ viewers: 240 });
  assert.ok(await until(() => mock.state.viewerSamples.some((v) => v.viewers === 240)));
  link._set({ status: 'offline', roomId: null, viewers: 0 });
  await wait(120);
  const n = mock.state.viewerSamples.length;
  await wait(120);
  assert.equal(mock.state.viewerSamples.length, n, 'no samples after the LIVE ended');
  ctl.stop(); await mock.close();
});

test('viewers: a count of 0 sends nothing but keeps watching, and a reconnect picks the samples back up', async () => {
  const { mock, link, ctl } = await rig();
  link.goLive('R1', 0);
  await wait(150);
  assert.equal(mock.state.viewerSamples.length, 0, "TikTok's 0 means no number");
  link._set({ viewers: 55 });
  assert.ok(await until(() => mock.state.viewerSamples.length >= 1));
  link._set({ status: 'reconnecting' });
  await wait(100);
  const n = mock.state.viewerSamples.length;
  link._set({ status: 'live' });
  assert.ok(await until(() => mock.state.viewerSamples.length > n));
  ctl.stop(); await mock.close();
});

test('viewers: test mode sends nothing', async () => {
  const { mock, link, ctl } = await rig();
  ctl.s.dryRun = true;
  link.goLive('R1', 212);
  await wait(150);
  assert.equal(mock.state.viewerSamples.length, 0);
  ctl.stop(); await mock.close();
});

test('viewers: a failed sample is retried by the next one and never reaches the host', async () => {
  const { mock, link, ctl } = await rig();
  mock.state.failNext.push({ path: 'live-link-viewers', status: 503 });
  const before = ctl.getState().siteError;
  link.goLive('R1', 90);
  assert.ok(await until(() => mock.state.viewerSamples.length >= 1));
  assert.equal(ctl.getState().siteError, before);
  assert.equal(mock.state.calls.filter((c) => c.path === 'live-link-viewers').length >= 2, true);
  ctl.stop(); await mock.close();
});

test('viewers: revoked-looking answers leave the sign-in alone', async () => {
  const { mock, link, ctl } = await rig();
  mock.state.failNext.push({ path: 'live-link-viewers', status: 401, error: 'device_revoked' });
  link.goLive('R1', 90);
  assert.ok(await until(() => mock.state.viewerSamples.length >= 1));
  assert.equal(ctl.getState().phase, 'ready');
  ctl.stop(); await mock.close();
});

test('viewers: a site without the endpoint (404) ends the samples until the next LIVE, and taps keep flowing', async () => {
  const { mock, link, ctl } = await rig();
  mock.state.failNext.push({ path: 'live-link-viewers', status: 404, error: 'NOT_FOUND' });
  link.goLive('R1', 90);
  assert.ok(await until(() => mock.state.calls.some((c) => c.path === 'live-link-viewers')));
  await wait(150);
  assert.equal(mock.state.calls.filter((c) => c.path === 'live-link-viewers').length, 1, 'one try, then quiet');
  assert.ok(await until(() => mock.state.statuses.some((s) => s.tiktok_live === true)));
  link._set({ status: 'offline', roomId: null, viewers: 0 });
  await wait(50);
  link.goLive('R2', 70);
  assert.ok(await until(() => mock.state.viewerSamples.some((v) => v.tiktok_room_id === 'R2')));
  ctl.stop(); await mock.close();
});
