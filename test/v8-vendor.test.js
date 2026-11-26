'use strict';
// 2.3.0: the REAL vendored VTuber (vendor/vtuber, its own process, a plain Node child here) with LIVE Link's v2 side.
// Proves that the v2 detection switches on with this copy: its "ready" says wire 2, the keys part of the card appears,
// the keys follow the Mask and its Puppet show switch, the show state and a pressed key reach its pages, and the site
// is only read while a song is on air. A pretend OBS on a free port (never 4455), a free VTuber port (never 8791), the
// stand-in site (test/mock-server.js); no real key is registered, no TikTok, no real site.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { VtuberHost } = require('../src/core/vtuber-host');
const { VtuberLink } = require('../src/core/vtuber-link');
const { ShowFeed } = require('../src/core/show-feed');
const { PuppetKeys, puppetWanted, eatWanted } = require('../src/core/puppet-keys');
const { createMock } = require('./mock-server');

const VT = path.join(__dirname, '..', 'vendor', 'vtuber');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-v8-vendor-'));
test.after(() => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await wait(40); } }
const NEVER = new Set([8791, 8792, 8793, 8794, 8795, 4455]);
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => (NEVER.has(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}

test('2.3.0 the vendored VTuber speaks v2: wire 2, the keys follow the Mask and its Puppet show switch, show + control reach its pages, the site is read only with a song on air', async (t) => {
  const { startMock } = await import('./vtuber-dev/tracking/mock-obs-scenes.js');
  const obsPort = await freePort();
  const obs = await startMock({ port: obsPort, projector: 'virtual', quiet: true, video: false });
  t.after(() => obs.close());
  const obsConfig = path.join(WORK, 'obs.json');
  fs.writeFileSync(obsConfig, JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: obs.password, server_port: obsPort }));
  const port = await freePort();
  const children = [];
  const host = new VtuberHost({ dir: VT, dataDir: path.join(WORK, 'data'), test: true, testConfig: { obsUrl: 'ws://127.0.0.1:' + obsPort, obsConfig, ports: [port], windowCapture: false },
    spawn: (entry, env) => {
      const child = fork(entry, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      return { post: (m) => child.send(m), onMessage: (fn) => child.on('message', fn), onExit: (fn) => child.on('exit', fn), kill: () => child.kill() };
    } });
  t.after(() => { for (const c of children) { try { c.kill(); } catch {} } });
  assert.equal(host.wire, 2, 'the files know the v2 messages (the keys part of the card shows even before VTuber is opened)');
  host._wire = 1;                                               // forget what the files said: the "ready" message must say it too
  assert.deepEqual(await host.start(), { ok: true, port });
  assert.equal(host.wire, 2, 'its "ready" says wire 2');
  await until(() => host.vt && host.vt.obs === 'ok' && host.vt.avatar.placed > 0, 15000, 'the VTuber found the pretend OBS');

  // LIVE Link's side, wired as in main.js
  const kb = { held: new Map() };
  const keys = new PuppetKeys({ register: (acc, fn) => { kb.held.set(acc, fn); return true; }, unregister: (acc) => { kb.held.delete(acc); }, send: (a, n) => vlink.sendControl(a, n) });
  const site = createMock();
  const sitePort = await site.listen(0);
  t.after(() => site.close());
  const tiktok = new EventEmitter(); tiktok.state = { status: 'idle' };
  const direct = (ev) => host.event(ev);
  Object.defineProperty(direct, 'v', { get: () => host.wire });
  const sync = () => { const k = { canControl: vlink.canControl, enabled: true, inApp: host.running, vt: host.vt }; keys.setWanted(puppetWanted(k)); keys.setEatWanted(eatWanted(k)); };   // main.js syncPuppetKeys
  const vlink = new VtuberLink({ http: false, direct: () => (host.running ? direct : null), onChange: () => { sync(); if (vlink.canControl) feed.nudge(); } }).attach(tiktok);
  const feed = new ShowFeed({ restBase: `http://127.0.0.1:${sitePort}/rest/v1/`, apiKey: 'test-publishable-key', coverHosts: [], pollMs: 60, tickMs: 20, send: (m) => vlink.sendShow(m), wanted: () => vlink.canControl });
  host.on('state', sync);
  t.after(() => { feed.stop(); vlink.stop(); keys.release(); });

  // the VTuber window (its page): joins the relay and chooses
  const WebSocket = require('../vendor/vtuber/vendor/ws');
  const res = await fetch(`http://127.0.0.1:${port}/vtuber.html`); await res.arrayBuffer();
  const cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
  const got = [];
  const ws = await new Promise((resolve, reject) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } }); w.on('open', () => resolve(w)); w.on('error', reject); });
  ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.t === 'v8-show' || m.t === 'v8-cmd') got.push(m); } catch {} });
  const pulse = setInterval(() => { fetch(`http://127.0.0.1:${port}/api/vt/state?hb=1`, { headers: { Cookie: cookie } }).then((x) => x.arrayBuffer(), () => {}); }, 400);
  t.after(() => { clearInterval(pulse); try { ws.terminate(); } catch {} });
  const choose = (extra) => ws.send(JSON.stringify({ t: 'avatar', on: true, bg: 'preset:courtyard', face: 'auto', faceHoldMs: 0, mirror: false, zoom: 1, offsetY: 0, ...extra }));

  // 2.3.1: no TikTok LIVE is needed: a v2 VTuber in the app is enough. The Mask with the Puppet show on: the keys are held
  assert.equal(vlink.canControl, true, 'a v2 VTuber in the app, TikTok not connected');
  choose({ mask: true, v8: { on: true } });
  await until(() => host.vt.character === 'mask' && host.vt.puppet === true, 6000, 'the VTuber says: the Mask, Puppet show on');
  await until(() => kb.held.size === 9, 2000, 'the nine keys are held (the seven puppet keys + EAT IT + V9: the galaxy)');
  // a pressed key reaches the page as a command
  kb.held.get('Control+Alt+1')();
  await until(() => got.some((m) => m.t === 'v8-cmd' && m.name === 'goo'), 4000, 'Goo reached the VTuber\'s page');
  // EAT IT (Ctrl+Alt+8): the VTuber takes the message without an error (2.3.0's files do not know it yet and drop it; a later VTuber eats)
  assert.doesNotThrow(() => kb.held.get('Control+Alt+8')());
  assert.equal(host.running, true);
  // V9, the galaxy (Ctrl+Alt+9): the same (the VTuber pinned here may not know it yet and drops it)
  assert.doesNotThrow(() => kb.held.get('Control+Alt+9')());
  assert.equal(host.running, true);
  // a TikTok LIVE connects: nothing changes for the keys
  tiktok.state = { status: 'live' }; tiktok.emit('state', tiktok.state);
  assert.equal(vlink.canControl, true);
  assert.equal(kb.held.size, 9);
  // the Puppet show switch goes off: the puppet keys go back to the other programs, EAT IT stays; on again: all held again
  choose({ mask: true, v8: { on: false } });
  await until(() => host.vt.puppet === false && kb.held.size === 2, 6000, 'Puppet show off: the puppet keys are given back');
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+8', 'Control+Alt+9'], 'EAT IT and the galaxy do not follow the Puppet show switch');
  choose({ mask: true, v8: { on: true } });
  await until(() => kb.held.size === 9, 6000, 'Puppet show on again: held again');
  // Ryo is chosen: the keys are given back (EAT IT too: Ryo does not eat songs)
  choose({ character: 'ryo' });
  await until(() => host.vt.character === 'ryo' && kb.held.size === 0, 6000, 'Ryo: the keys are given back');
  choose({ mask: true, v8: { on: true } });
  await until(() => kb.held.size === 9, 6000, 'the Mask again');

  // the show feed: no song on air = not one read of the site; the state still reaches the page
  feed.update({ connected: true, target: null, hold: 'song' });
  await until(() => got.some((m) => m.t === 'v8-show' && m.s.onAir === false), 4000, '"nothing on air" reached the page');
  await wait(400);
  assert.equal(site.state.restCalls.length, 0, 'no song on air: the site is not read');
  // a song goes on air: reads begin, the page learns the song and its hype
  site.state.rest.project_hype.push({ submission_id: 'sub-1', hype_bar: 350 });
  site.state.rest.hype_plays.push({ id: 'p1', submission_id: 'sub-1', host_id: 'host-1', start_bar: 0, end_bar: null, started_at: new Date(Date.now() - 600000).toISOString(), ended_at: null });
  feed.update({ connected: true, target: { submission_id: 'sub-1', title: 'Test Song' }, hold: null });
  await until(() => got.some((m) => m.t === 'v8-show' && m.s.onAir === true && m.s.song && m.s.song.title === 'Test Song' && m.s.hype.taps === 350 && m.s.hype.rank === 2), 6000, 'the song and its hype reached the page');
  assert.ok(site.state.restCalls.length > 0 && site.state.restCalls.every((c) => c.method === 'GET' && c.apikey));
  // off air again: the reads stop
  feed.update({ connected: true, target: null, hold: 'song' });
  await wait(200);
  const n = site.state.restCalls.length;
  await wait(500);
  assert.ok(site.state.restCalls.length <= n + 3, 'off air: only the two late looks for a grade, then nothing');
  // 2.3.1: the TikTok LIVE drops: the keys stay and the show state goes on reaching the page (a song put on air now is still said)
  tiktok.state = { status: 'offline' }; tiktok.emit('state', tiktok.state);
  assert.equal(kb.held.size, 9, 'no LIVE: the keys stay (the VTuber is still open with the Mask)');
  assert.equal(vlink.canControl, true);
  site.state.rest.project_hype.push({ submission_id: 'sub-2', hype_bar: 0 });
  feed.update({ connected: false, target: { submission_id: 'sub-2', title: 'After The Drop' }, hold: null });
  await until(() => got.some((m) => m.t === 'v8-show' && m.s.onAir === true && m.s.song && m.s.song.title === 'After The Drop'), 6000, 'a song on air after the drop reached the page');
  // VTuber is closed: every key goes back
  await host.stop();
  sync();
  assert.equal(kb.held.size, 0, 'VTuber closed: no key is held');
});
