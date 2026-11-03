'use strict';
// 2.1.0: quiet auto-update (when an update may install by itself, installing on quit without opening again), the
// TikTok sign-in as a checklist row and a status field, and the next show from live-link-config.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mock-server');
const { LiveLinkApi } = require('../src/core/api');
const { Controller } = require('../src/core/controller');
const { Store } = require('../src/core/store');
const { Updater, macSwapScript, shouldAutoInstall, AUTO } = require('../src/core/updater');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } return false; }
const settle = (u, status) => new Promise((resolve) => { const f = (s) => { if (s.status === status) { u.off('state', f); resolve(s); } }; u.on('state', f); if (u.state.status === status) resolve(u.getState()); });

test('shouldAutoInstall: only on an idle computer, with nothing running and no show coming up', () => {
  const now = 1_800_000_000_000;
  const ok = { status: 'ready', readyAt: now - AUTO.readyFor - 1, busy: null, live: false, lastLiveEndedAt: null, nextShowAt: null, idleSeconds: AUTO.idleFor, now };
  assert.deepEqual(shouldAutoInstall(ok), { ok: true, why: null });
  const why = (p) => shouldAutoInstall({ ...ok, ...p }).why;
  assert.equal(why({ enabled: false }), 'off');
  assert.equal(why({ status: 'downloading' }), 'not_ready');
  assert.equal(why({ busy: 'recording' }), 'recording');
  assert.equal(why({ busy: 'clips' }), 'clips');
  assert.equal(why({ live: true }), 'live');
  assert.equal(why({ readyAt: now - 60000 }), 'too_soon');
  assert.equal(why({ readyAt: undefined }), 'too_soon');
  assert.equal(why({ lastLiveEndedAt: now - 5 * 60000 }), 'just_live');
  assert.equal(why({ lastLiveEndedAt: now - AUTO.afterLive - 1 }), null);
  assert.equal(why({ nextShowAt: now + 90 * 60000 }), 'show_soon');
  assert.equal(why({ nextShowAt: now - 30 * 60000 }), 'show_soon', 'a show that started half an hour ago may still be on');
  assert.equal(why({ nextShowAt: now + 3 * 3600000 }), null);
  assert.equal(why({ nextShowAt: now - 7 * 3600000 }), null, 'a show from 7 hours ago is over');
  assert.equal(why({ idleSeconds: 60 }), 'in_use');
  assert.equal(why({ idleSeconds: undefined }), 'in_use');
});

test('install on quit (Windows): the installer runs silently and does not open LIVE Link again; readyAt is stamped once', async () => {
  const BYTES = Buffer.from('pretend installer '.repeat(500));
  const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-upd210-'));
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push([cmd, args, opts]); const p = new EventEmitter(); p.unref = () => {}; setImmediate(() => p.emit('close', 0)); return p; };
  const fetch = async () => new Response(BYTES, { status: 200, headers: { 'content-length': String(BYTES.length) } });
  const u = new Updater({ dir, platform: 'win32', appVersion: '2.0.9', appPath: 'C:\\LIVE Link\\LIVE Link.exe', fetch, spawn, busy: () => null });
  const offer = { available: true, version: '2.1.0', url: 'https://bxiejoktoknybpraxebm.supabase.co/storage/v1/object/sign/live-link/2.1.0/LIVE-Link-Setup-2.1.0.exe?token=x', sha256: SHA };
  const before = Date.now();
  u.offer(offer);
  await settle(u, 'ready');
  const at = u.state.readyAt;
  assert.ok(at >= before && at <= Date.now(), 'readyAt is when the update became ready');
  u.offer(offer);   // a config refresh: same update, the clock doesn't restart
  assert.equal(u.state.readyAt, at);
  assert.deepEqual(await u.install({ relaunch: false }), { ok: true });
  assert.deepEqual(spawned[0][1], ['/S', '--updated']);
});

test('Mac: the swap script opens the app again only when asked', () => {
  const again = macSwapScript(4242, '/tmp/n/LIVE Link.app', '/Applications/LIVE Link.app');
  const quiet = macSwapScript(4242, '/tmp/n/LIVE Link.app', '/Applications/LIVE Link.app', false);
  assert.match(again, /^open '\/Applications\/LIVE Link\.app'$/m);
  assert.doesNotMatch(quiet, /^open /m);
  assert.match(quiet, /ditto '\/tmp\/n\/LIVE Link\.app' '\/Applications\/LIVE Link\.app'/, 'it still swaps the new app in');
});

class FakeLink extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null }; this.username = null; }
  get running() { return !!this.username; }
  setOfflinePoll() {}
  start(u) { this.username = u; }
  stop() { this.username = null; this._set({ status: 'idle', roomId: null }); }
  retryNow() {}
  wake() {}
  _set(p) { this.state = { ...this.state, ...p }; if (p.roomId && p.roomId !== this.lastRoom) { this.lastRoom = p.roomId; this.emit('roomChanged', p.roomId); } this.emit('state', { ...this.state }); }
}

async function paired(mockOpts) {
  const mock = createMock({ autoApprove: true, pushIntervalMs: 60, ...mockOpts });
  const port = await mock.listen(0);
  const store = new Store({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-210-')) });
  const api = new LiveLinkApi({ baseUrl: `http://127.0.0.1:${port}/functions/v1/`, getToken: () => store.getToken() });
  const ctl = new Controller({ api, link: new FakeLink(), store, appVersion: '2.1.0', deviceName: 'TEST-PC' });
  await ctl.pair('TEST2345');
  assert.ok(await until(() => ctl.getState().phase === 'ready'), ctl.getState().phase);
  return { mock, ctl };
}

test('2.1.0: the next show comes from live-link-config; the TikTok sign-in is a checklist row and reaches the status', async (t) => {
  const at = new Date(Date.now() + 2 * 3600000).toISOString();
  const { mock, ctl } = await paired({ nextShowAt: at });
  t.after(async () => { ctl.stop(); await mock.close(); });   // a failed check must not leave the server holding the run open
  assert.ok(Math.abs(ctl.getState().nextShowAt - Date.parse(at)) < 5000, String(ctl.getState().nextShowAt));
  const lastStatus = () => mock.state.statuses[mock.state.statuses.length - 1];
  const row = () => ctl.getState().steps.find((s) => s.key === 'signin');
  // not known yet: no row, and no field the site could misread
  assert.equal(row(), undefined);
  assert.ok(await until(() => mock.state.statuses.length > 0));
  assert.equal('tiktok_signed_in' in lastStatus(), false);
  ctl.setSignedIn(false);
  assert.deepEqual([row().state, row().action], ['todo', 'signin']);
  assert.ok(await until(() => lastStatus().tiktok_signed_in === false), JSON.stringify(lastStatus()));
  // set right after the 'false' call reached the site (still in flight): it must go out in seconds, not a minute later
  ctl.setSignedIn(true);
  assert.deepEqual([row().state, row().action], ['done', undefined]);
  assert.ok(await until(() => lastStatus().tiktok_signed_in === true), JSON.stringify(lastStatus()));
});

test('2.1.0: a next show that is not a real time, or is weeks away, is ignored', async () => {
  for (const bad of ['soon', new Date(Date.now() + 30 * 86400000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString()]) {
    const { mock, ctl } = await paired({ nextShowAt: bad });
    assert.equal(ctl.getState().nextShowAt, null, bad);
    ctl.stop(); await mock.close();
  }
});
