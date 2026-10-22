'use strict';
// 2.0.8: the new recording reasons reach the site's status (tiktok_signin_needed, stream_sub_only, capture_*, and the
// informational recording_window_capture), and the checklist row reads right for each.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { createMock } = require('./mock-server');
const { LiveLinkApi } = require('../src/core/api');
const { Controller, REASON_RE } = require('../src/core/controller');
const { Store } = require('../src/core/store');

class FakeLink extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null }; this.username = null; }
  get running() { return !!this.username; }
  setOfflinePoll() {}
  start(u) { this.username = u; }
  stop() { this.username = null; this._set({ status: 'idle', roomId: null }); }
  retryNow() {}
  wake() {}
  _set(p) { this.state = { ...this.state, ...p }; if (p.roomId && p.roomId !== this.lastRoom) { this.lastRoom = p.roomId; this.emit('roomChanged', p.roomId); } this.emit('state', { ...this.state }); }
  goLive(room = 'R1') { this._set({ status: 'live', roomId: room }); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } return false; }

test('2.0.8 reasons: a back-up recording is reported as recording_window_capture with a done row; sign-in needed is a problem row with a sentence ending in the code', async () => {
  const mock = createMock({ autoApprove: true, pushIntervalMs: 60 });
  const port = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-208-'));
  const store = new Store({ dir });
  const link = new FakeLink();
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  const ctl = new Controller({ api, link, store, appVersion: '2.0.8', deviceName: 'TEST-PC' });
  await ctl.pair('TEST2345');
  link.goLive('R1');
  const lastStatus = () => mock.state.statuses[mock.state.statuses.length - 1];
  assert.ok(await until(() => mock.state.statuses.some((s) => s.tiktok_live === true)));
  // the back-up records: informational
  ctl.setRecordingIssue({ reason: 'recording_window_capture', text: "Recording the host's stream window instead of TikTok's video (back-up recording)", detail: 'window: TikTok LIVE Studio', level: 'info' });
  assert.ok(await until(() => lastStatus().reason === 'recording_window_capture'), JSON.stringify(mock.state.statuses.slice(-2)));
  assert.match(lastStatus().last_error, /stream window.*\[window: TikTok LIVE Studio\] \(recording_window_capture\)$/);
  assert.equal(lastStatus().tiktok_live, true);
  let row = ctl.getState().steps.find((s) => s.key === 'rec');
  assert.deepEqual([row.state, row.action], ['done', undefined]);
  assert.match(row.text, /Recording your stream window/);
  assert.equal(ctl.getState().recordingIssue.level, 'info');
  // sign-in needed: a problem
  ctl.setRecordingIssue({ reason: 'tiktok_signin_needed', text: 'TikTok only shows this LIVE\'s video to signed-in viewers', detail: 'room info: status 4003110 (restricted)' });
  assert.ok(await until(() => lastStatus().reason === 'tiktok_signin_needed'));
  assert.match(lastStatus().last_error, /\(tiktok_signin_needed\)$/);
  row = ctl.getState().steps.find((s) => s.key === 'rec');
  assert.deepEqual([row.state, row.action], ['problem', 'check']);
  assert.match(row.text, /Sign in to TikTok in Settings/);
  for (const r of ['tiktok_signin_needed', 'stream_sub_only', 'capture_no_window', 'capture_failed', 'recording_window_capture']) assert.match(r, REASON_RE);
  // cleared
  ctl.setRecordingIssue(null);
  assert.ok(await until(() => lastStatus().reason === null));
  assert.equal(ctl.getState().steps.find((s) => s.key === 'rec'), undefined);
  ctl.stop(); await mock.close();
});
