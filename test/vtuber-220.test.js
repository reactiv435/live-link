'use strict';
// 2.2.0: the VTuber inside LIVE Link.
//  - vendor/vtuber is exactly the pinned commit of the VTuber repo (nobody edits it by hand), and holds nothing private.
//  - core/vtuber-host.js: start / stop / crash / start again of the VTuber's own process, here a plain Node child
//    standing in for Electron's utility process, running the REAL vendor/vtuber/livelink-host.js against a pretend OBS
//    (test/vtuber-dev: no real window, free ports; never 8791, never 4455, never the real OBS or its settings).
//  - core/vtuber-link.js: events are handed over inside the app while a VTuber runs in it, over HTTP otherwise.
//  - the card: every state is one plain sentence; the site's switch (missing = ON).
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { fork } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { VtuberHost, vtuberCard, vtuberEnabled, pickCameraSource } = require('../src/core/vtuber-host');
const { VtuberLink } = require('../src/core/vtuber-link');
const sync = require('../scripts/sync-vtuber');

const ROOT = path.join(__dirname, '..');
const VT = path.join(ROOT, 'vendor', 'vtuber');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'll-vtuber-'));
test.after(() => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await wait(40); } }
const NEVER = new Set([8791, 4455]);
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => (NEVER.has(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
const AV = 'VTuber Avatar';
const avatarItems = (snap) => { const out = []; for (const sc of snap.scenes) for (const it of sc.items) if (it.source === AV) out.push(it); return out; };
// Electron's utility process, stood in for by a plain Node child (the VTuber's entry speaks to either)
const nodeSpawn = (children) => (entry, env) => {
  const child = fork(entry, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  return { post: (m) => child.send(m), onMessage: (fn) => child.on('message', fn), onExit: (fn) => child.on('exit', fn), kill: () => child.kill(), pid: child.pid };
};
async function pretendObs(t) {
  const { startMock } = await import('./vtuber-dev/tracking/mock-obs-scenes.js');
  const port = await freePort();
  const mock = await startMock({ port, projector: 'virtual', quiet: true, video: false });
  t.after(() => mock.close());
  const cfg = path.join(WORK, 'obs-' + port + '.json');
  fs.writeFileSync(cfg, JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: mock.password, server_port: port }));
  return { mock, obsUrl: 'ws://127.0.0.1:' + port, obsConfig: cfg };
}

// ------------------------------------------------------------------------------------------------ the pinned copy
test('2.2.0 vendor/vtuber is exactly the pinned VTuber commit, complete, and holds nothing private', () => {
  assert.deepEqual(sync.check(), [], 'vendor/vtuber or test/vtuber-dev differs from its pin: run scripts/sync-vtuber.js (never edit the copy by hand)');
  const pin = JSON.parse(fs.readFileSync(sync.PIN, 'utf8'));
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  const files = Object.keys(pin.files);
  for (const must of ['livelink-host.js', 'one-click.js', 'server.js', 'vtuber.html', 'avatar.html', 'js/vtuber.js', 'js/avatar.js', 'mask/mask-core.js', 'vendor/ws/index.js', 'vendor/babylon.js',
    'assets/models/ryo-arena.glb', 'assets/models/melanie-arena.glb', 'tracking/tracker.html', 'tracking/vendor/models/face_landmarker.task', 'tracking/vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
    'sound-loopback.ps1', 'win-windows.ps1']) assert.ok(files.includes(must), 'missing: ' + must);
  for (const f of [...files, ...Object.keys(pin.dev)]) assert.ok(!sync.isNever(f), 'must never be copied: ' + f);   // (V9: the countdown song is the one exception, test/v9-sync-music.test.js)
  assert.ok(!files.some((f) => /^(tools|tests|review|research)\//.test(f)), 'no tools, tests or review media in the app');
  assert.ok(pin.bytes > 30e6 && pin.bytes < 75e6, 'size ' + Math.round(pin.bytes / 1e6) + ' MB');
  // it ships inside the app as plain files (the local server streams them; PowerShell runs the two helper scripts)
  const pkg = require('../package.json');
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'vendor/vtuber' && r.to === 'vtuber'));
  assert.ok(!pkg.build.files.some((f) => /vendor|test/.test(f)), 'the copy is never packed twice, the test helpers never ship');
  assert.match(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);
  assert.equal(pkg.version, '2.4.0');
});

// ------------------------------------------------------------------------------------------------ the card
test('2.2.0 the VTuber card: every state is one plain sentence that says what to do', () => {
  const base = { installed: true, status: 'idle', problem: null, port: 0, vt: null };
  const run = (vt) => ({ ...base, status: 'running', port: 8791, vt: { on: false, obs: 'ok', camera: 'Cam', character: null, avatar: { placed: 1, problem: null, removed: false, silent: false }, capture: 'window', page: true, pageEver: true, ...vt } });
  const cases = [
    [base, 'off', /Ryo, Melanie or the Mask/, 'Open VTuber'],
    [{ ...base, installed: false }, 'fix', /missing from this install/, null],
    [{ ...base, status: 'starting' }, 'wait', /Starting VTuber/, null],
    [{ ...base, problem: 'STANDALONE' }, 'fix', /already open from your desktop shortcut\. Close that window, then press Open VTuber/, 'Open VTuber'],
    [{ ...base, problem: 'NO_PORT' }, 'fix', /Another program is using VTuber's place.*Restart the computer/, 'Open VTuber'],
    [{ ...base, problem: 'CRASH' }, 'fix', /^VTuber stopped\. Press Open VTuber\.$/, 'Open VTuber'],
    [{ ...base, problem: 'ERROR' }, 'fix', /^VTuber stopped\. Press Open VTuber\.$/, 'Open VTuber'],
    [run({ obs: 'closed', camera: null }), 'fix', /^VTuber needs OBS\. Open OBS/, 'Show VTuber'],
    [run({ obs: 'off', camera: null }), 'fix', /Tools, then WebSocket Server Settings, tick "Enable WebSocket server"/, 'Show VTuber'],
    [run({ obs: 'password', camera: null }), 'fix', /Paste it in the VTuber window/, 'Show VTuber'],
    [run({ camera: null }), 'fix', /^VTuber could not find a camera it knows in OBS\. It works with DroidCam and Video Capture Device sources\.$/, 'Show VTuber'],
    [run({ camera: null, cameraAsk: true }), 'fix', /more than one camera\. In the VTuber window, click the picture that shows you/, 'Show VTuber'],
    [run({ avatar: { placed: 0, problem: 'name-taken' } }), 'fix', /already has something else called "VTuber Avatar"/, 'Show VTuber'],
    [run({ avatar: { placed: 0, problem: 'not-visible' } }), 'fix', /hidden in every OBS scene/, 'Show VTuber'],
    [run({ on: true, character: 'ryo', avatar: { placed: 1, silent: true } }), 'fix', /right-click "VTuber Avatar" and click Refresh/, 'Show VTuber'],
    [run({}), 'ok', /pick Ryo, Melanie or the Mask and press ON/, 'Show VTuber'],
    [run({ on: true, character: 'melanie' }), 'on', /VTuber is ON: your viewers see Melanie/, 'Show VTuber'],
    [run({ on: true, character: 'mask' }), 'on', /see the Mask instead of your camera/, 'Show VTuber'],
  ];
  for (const [h, tone, text, button] of cases) {
    const c = vtuberCard(h);
    assert.equal(c.show, true);
    assert.equal(c.tone, tone, JSON.stringify(h));
    assert.match(c.text, text);
    assert.equal(c.button, button);
    assert.ok(c.text.length <= 190, 'short enough to read at a glance: ' + c.text);
    assert.ok(!/websocket(?! server)|projector|utility process|port \d|127\.0\.0\.1|fps|undefined|null/i.test(c.text), 'plain words only: ' + c.text);
  }
  // the site's switch: a missing switch means ON (no site change is needed for launch); an explicit false hides the card
  for (const cfg of [null, undefined, {}, { vtuber: null }, { vtuber: {} }, { vtuber: { enabled: true } }, { vtuber: { enabled: 'no' } }]) assert.equal(vtuberEnabled(cfg), true, JSON.stringify(cfg));
  assert.equal(vtuberEnabled({ vtuber: { enabled: false } }), false);
  assert.equal(vtuberCard(base, { enabled: false }).show, false, 'switched off by the site: no card');
  assert.equal(vtuberCard(run({ on: true }), { enabled: false }).show, true, 'a VTuber that is running is never left without its card');
  assert.equal(vtuberCard(null).show, false);
});

test('2.2.0 the camera window is picked by its exact window number, never by name', () => {
  const list = [{ id: 'window:1234:0', name: 'Projector - Source: DroidCam OBS 2' }, { id: 'window:12345:0', name: 'Projector - Source: DroidCam OBS 2' }, { id: 'window:99:1', name: 'Other' }, { id: 'screen:0:0', name: 'Screen 1' }];
  assert.equal(pickCameraSource(list, { hwnd: 12345, title: 'Projector - Source: DroidCam OBS 2' }).id, 'window:12345:0');
  assert.equal(pickCameraSource(list, { hwnd: 1234, title: 'x' }).id, 'window:1234:0', 'a longer number that starts the same is another window');
  assert.equal(pickCameraSource(list, { hwnd: 123, title: 'Projector - Source: DroidCam OBS 2' }), null, 'the same name is not enough');
  assert.equal(pickCameraSource(list, { hwnd: 0, title: 'Screen 1' }), null);
  for (const bad of [null, undefined, {}, { hwnd: 'window' }, { hwnd: -5 }, { hwnd: 1.5 }]) assert.equal(pickCameraSource(list, bad), null);
  assert.equal(pickCameraSource(null, { hwnd: 99 }), null);
});

// ------------------------------------------------------------------------------------------------ a test run is fenced in
test('2.2.0 fix round: the VTuber window asks for nothing but its own local address; the Mac microphone sentence names both uses', () => {
  const { setupVtuberSession, requestAllowed } = require('../src/core/vtuber-session');
  for (const u of ['http://127.0.0.1:8791/vtuber.html', 'http://127.0.0.1:8791/api/vt/state', 'ws://127.0.0.1:8791/ws?bin=1', 'data:image/png;base64,AA', 'blob:http://127.0.0.1:8791/abc']) assert.equal(requestAllowed(u, 8791), true, u);
  for (const u of ['https://example.com/x.js', 'http://example.com/', 'http://127.0.0.1:8792/', 'http://localhost:8791/', 'ws://127.0.0.1:4455/', 'wss://example.com/', 'file:///C:/x', 'https://127.0.0.1:8791/', 'not a url']) assert.equal(requestAllowed(u, 8791), false, u);
  assert.equal(requestAllowed('http://127.0.0.1:8791/', 0), false, 'no VTuber running: nothing');
  // the app's session cancels the rest; the check script's session (no ownOnly) is left as it was
  let hook = null;
  const ses = { webRequest: { onBeforeRequest: (fn) => { hook = fn; } }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} };
  setupVtuberSession(ses, { desktopCapturer: {}, port: () => 8791, cameraWindow: () => null });
  assert.equal(hook, null);
  setupVtuberSession(ses, { desktopCapturer: {}, port: () => 8791, cameraWindow: () => null, ownOnly: true });
  const ask = (url) => { let out = null; hook({ url }, (r) => { out = r; }); return out; };
  assert.deepEqual(ask('http://127.0.0.1:8791/js/vtuber.js'), { cancel: false });
  assert.deepEqual(ask('https://cdn.example.com/lib.js'), { cancel: true });
  const mic = require('../package.json').build.mac.extendInfo.NSMicrophoneUsageDescription;
  assert.match(mic, /microphone/i); assert.match(mic, /records/); assert.doesNotMatch(mic, /Nothing is recorded/);
});

test('2.2.0 a test run never starts a VTuber that could reach the real OBS or the real VTuber', async () => {
  const spawned = [];
  const mk = (testConfig) => new VtuberHost({ dir: VT, dataDir: path.join(WORK, 'fence'), test: true, testConfig, spawn: (e, env) => { spawned.push(env); throw new Error('must not start'); } });
  const good = { obsUrl: 'ws://127.0.0.1:4999', obsConfig: 'x.json', ports: [8899] };
  for (const bad of [null, {}, { ...good, obsUrl: '' }, { ...good, obsUrl: 'ws://127.0.0.1:4455' }, { ...good, obsUrl: 'ws://127.0.0.1' }, { ...good, obsConfig: '' }, { ...good, ports: [] }, { ...good, ports: [8791] }, { ...good, ports: [8899, 4455] }]) {
    const h = mk(bad);
    assert.equal(h.config(), null, JSON.stringify(bad));
    const r = await h.start();
    assert.deepEqual(r, { ok: false, problem: 'TEST' });
    assert.match(vtuberCard(h.getState()).text, /test copy/);
  }
  assert.equal(spawned.length, 0);
  const ok = mk(good).config();
  assert.equal(ok.test, true); assert.deepEqual(ok.ports, [8899]); assert.equal(ok.obsUrl, good.obsUrl);
  // a real run names no OBS and no ports (the VTuber finds the host's own OBS and its own place); a Mac reads the camera the slower way
  const real = new VtuberHost({ dir: VT, dataDir: path.join(WORK, 'real'), platform: 'darwin' }).config();
  assert.deepEqual(real, { dataDir: path.join(WORK, 'real'), windowCapture: false });
  assert.equal(new VtuberHost({ dir: VT, dataDir: 'x', platform: 'win32' }).config().windowCapture, true);
  // a missing install says so instead of failing in the dark
  const none = new VtuberHost({ dir: path.join(WORK, 'nowhere'), dataDir: 'x', spawn: () => { throw new Error('no'); } });
  assert.equal(none.installed, false);
  assert.match(vtuberCard(none.getState()).text, /missing from this install/);
});

// ------------------------------------------------------------------------------------------------ the real process
test('2.2.0 the VTuber process: start, the card follows, events handed over in-app, crash = card offers Open again, start again, stop = avatar off in OBS', async (t) => {
  const { mock, obsUrl, obsConfig } = await pretendObs(t);
  const port = await freePort();
  const children = [], logs = [];
  const host = new VtuberHost({ dir: VT, dataDir: path.join(WORK, 'data'), test: true, testConfig: { obsUrl, obsConfig, ports: [port], windowCapture: false }, spawn: nodeSpawn(children), log: (lvl, text) => logs.push(lvl + ' ' + text) });
  t.after(() => { for (const c of children) { try { c.kill(); } catch {} } });
  const states = []; host.on('state', (s) => states.push(s));
  assert.equal(vtuberCard(host.getState()).tone, 'off');
  assert.equal(host.event({ v: 1, type: 'like', count: 3 }), false, 'no VTuber: nothing is taken');

  const both = [host.start(), host.start()];                 // a double click starts ONE
  assert.equal(vtuberCard(host.getState()).tone, 'wait');
  const r = await both[0];
  assert.deepEqual(r, { ok: true, port });
  assert.deepEqual(await both[1], r);
  assert.equal(children.length, 1);
  assert.equal(host.running, true);
  await until(() => host.vt && host.vt.obs === 'ok' && host.vt.avatar.placed > 0, 12000, 'the VTuber found the pretend OBS and placed the avatar');
  assert.ok(states.some((s) => s.status === 'starting') && states.some((s) => s.status === 'running'));
  assert.ok(fs.existsSync(path.join(WORK, 'data', 'vtuber-obs.json')), 'its files live in the data folder LIVE Link named');
  assert.ok(avatarItems(mock.snapshot()).length > 0 && avatarItems(mock.snapshot()).every((i) => !i.enabled));
  assert.equal(host.isOn, false);

  // the page (LIVE Link's VTuber window): loads vtuber.html, joins the relay, presses ON
  const WebSocket = require('../vendor/vtuber/vendor/ws');
  const page = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/vtuber.html`); await res.arrayBuffer();
    const cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
    const ws = await new Promise((resolve, reject) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } }); w.on('open', () => resolve(w)); w.on('error', reject); });
    const pulse = setInterval(() => { fetch(`http://127.0.0.1:${port}/api/vt/state?hb=1`, { headers: { Cookie: cookie } }).then((x) => x.arrayBuffer(), () => {}); }, 400);
    t.after(() => { clearInterval(pulse); try { ws.terminate(); } catch {} });
    return { ws, stop: () => { clearInterval(pulse); try { ws.terminate(); } catch {} } };
  };
  const on = (ws, character) => ws.send(JSON.stringify({ t: 'avatar', on: true, character, bg: 'preset:courtyard', face: 'auto', faceHoldMs: 0, mirror: false, zoom: 1, offsetY: 0 }));
  const p1 = await page();
  on(p1.ws, 'ryo');
  await until(() => host.isOn && host.vt.character === 'ryo', 5000, 'ON reaches LIVE Link');
  assert.match(vtuberCard(host.getState()).text, /VTuber is ON: your viewers see Ryo/);
  await until(() => avatarItems(mock.snapshot()).every((i) => i.enabled), 3000, 'the avatar shows in OBS');

  // the avatar page as OBS loads it
  const stampOf = () => new URL(mock.snapshot().inputs.find((i) => i.name === AV).settings.url).searchParams.get('run');
  const avatar = async () => {
    const got = [];
    const ws = await new Promise((resolve, reject) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws?oneclick=1&run=${stampOf()}`); w.on('open', () => resolve(w)); w.on('error', reject); });
    ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.t === 'mask-event') got.push(m.e); } catch {} });
    t.after(() => { try { ws.terminate(); } catch {} });
    return { got, ws };
  };
  const av = await avatar();

  // the TikTok events: a pretend LIVE; the VTuber runs in the app, so they are handed over (no HTTP request at all)
  const httpSeen = [];
  const trap = http.createServer((req, res) => { httpSeen.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"v":1}'); });
  const trapPort = await new Promise((resolve) => trap.listen(0, '127.0.0.1', () => resolve(trap.address().port)));
  t.after(() => new Promise((res) => { trap.closeAllConnections && trap.closeAllConnections(); trap.close(res); }));
  const feed = new EventEmitter(); feed.state = { status: 'idle' };
  const vlink = new VtuberLink({ port: trapPort, probeEveryMs: 200, direct: () => (host.running ? (ev) => host.event(ev) : null) }).attach(feed);
  t.after(() => vlink.stop());
  feed.emit('state', { status: 'live' });
  feed.emit('giftEnd', { key: 's:1', name: 'Galaxy', coins: 1000, count: 2, userName: 'Mira.B', at: Date.now() });
  feed.emit('comment', { name: 'Jo', text: 'hello   there', at: Date.now() });
  feed.emit('like', { count: 12, name: 'Jo' });
  feed.emit('follow', { name: 'New', userId: 'u1', at: Date.now() });
  feed.emit('share', { name: 'Jo', at: Date.now() });
  await until(() => av.got.length === 5, 4000, 'all five kinds reach the avatar page');
  assert.deepEqual(av.got.find((e) => e.type === 'gift'), { type: 'gift', name: 'Mira.B', gift: 'Galaxy', coins: 1000, count: 2, text: null });
  assert.equal(av.got.find((e) => e.type === 'comment').text, 'hello there');
  assert.deepEqual(av.got.map((e) => e.type).sort(), ['comment', 'follow', 'gift', 'like', 'share']);
  await wait(450);
  assert.deepEqual(httpSeen, [], 'while the VTuber runs inside the app nothing is asked or sent over HTTP');
  assert.equal(vlink.stats.direct, 5); assert.equal(vlink.stats.probes, 0);
  assert.ok(!logs.some((l) => /Mira|hello|Jo\b/.test(l)), 'no viewer name or comment in the log');
  assert.ok(!logs.some((l) => l.includes(mock.password)), 'no OBS password in the log');

  // a crash of the VTuber's process: the avatar page in OBS hides by itself (its own rule), LIVE Link says so and offers Open
  let exits = 0; host.on('exit', () => exits++);
  // SIGKILL = a real crash on every system (on macOS a plain kill() is SIGTERM, which the VTuber answers with an orderly stop)
  children[0].kill('SIGKILL');
  await until(() => host.status === 'idle', 5000, 'LIVE Link notices');
  assert.equal(host.problem, 'CRASH'); assert.equal(exits, 1); assert.equal(host.running, false); assert.equal(host.isOn, false);
  assert.deepEqual(vtuberCard(host.getState()), { show: true, tone: 'fix', title: 'VTuber', text: 'VTuber stopped. Press Open VTuber.', button: 'Open VTuber' });
  // the feed must not care: events now fall back to the HTTP way (here the trap stands in for a desktop-shortcut VTuber)
  feed.emit('share', { name: 'Jo', at: Date.now() });
  await until(() => httpSeen.length > 0, 3000, 'the HTTP way takes over when no VTuber runs in the app');
  p1.stop();

  // Open again: a fresh process on the same place; it adopts the avatar it left in OBS (still one source, hidden first)
  const r2 = await host.start();
  assert.deepEqual(r2, { ok: true, port });
  assert.equal(children.length, 2);
  await until(() => host.vt && host.vt.obs === 'ok' && host.vt.avatar.placed > 0, 12000, 'placed again');
  await until(() => avatarItems(mock.snapshot()).every((i) => !i.enabled), 4000, 'hidden until ON is pressed again');
  assert.equal(mock.snapshot().inputs.filter((i) => i.name === AV).length, 1);
  const p2 = await page();
  on(p2.ws, 'melanie');
  await until(() => host.isOn && avatarItems(mock.snapshot()).every((i) => i.enabled), 5000, 'ON again');

  // stop (the window closed, or LIVE Link quits): the avatar is off in OBS within 3 s, then the process ends, no "crash"
  const t0 = Date.now();
  const stopped = host.stop();
  await until(() => avatarItems(mock.snapshot()).every((i) => !i.enabled), 3000, 'off in OBS within 3 s');
  const offMs = Date.now() - t0;
  await stopped;
  assert.ok(offMs <= 3000, 'off after ' + offMs + ' ms');
  assert.equal(host.status, 'idle'); assert.equal(host.problem, null);
  assert.equal(vtuberCard(host.getState()).tone, 'off');
  await host.stop();                                          // stopping twice is harmless
  p2.stop();
});

test('2.2.0 the desktop-shortcut VTuber holds the place: LIVE Link leaves it alone, says so, and its events still reach it over HTTP', async (t) => {
  const { mock, obsUrl, obsConfig } = await pretendObs(t);
  const port = await freePort();
  // "the desktop-shortcut VTuber": the same app, started the standalone way on a test place
  const { startOneClick } = require('../vendor/vtuber/one-click.js');
  const standalone = await startOneClick({ port, obsUrl, obsConfig, noChrome: true, stay: true, windows: { listWindows: async () => [], placeWindow: async () => true, closeWindow: async () => true, frontWindow: async () => true },
    recordFile: path.join(WORK, 'standalone-record.json'), logFile: path.join(WORK, 'standalone.log'), giftsFile: path.join(WORK, 'standalone-gifts.json'), restFile: path.join(WORK, 'standalone-rest.json') });
  t.after(() => standalone.stop('test over'));
  const children = [];
  const host = new VtuberHost({ dir: VT, dataDir: path.join(WORK, 'data2'), test: true, testConfig: { obsUrl, obsConfig, ports: [port], windowCapture: false }, spawn: nodeSpawn(children) });
  t.after(() => { for (const c of children) { try { c.kill(); } catch {} } });
  const r = await host.start();
  assert.deepEqual(r, { ok: false, problem: 'STANDALONE' });
  await until(() => host.status === 'idle', 4000, 'its process ended');
  assert.match(vtuberCard(host.getState()).text, /already open from your desktop shortcut/);
  assert.equal(standalone.state().stopping, false, 'the running VTuber was not touched');
  // gifts still reach that VTuber the 2.1.2 way
  const feed = new EventEmitter(); feed.state = { status: 'idle' };
  const vlink = new VtuberLink({ port, probeEveryMs: 200, direct: () => (host.running ? (ev) => host.event(ev) : null) }).attach(feed);
  t.after(() => vlink.stop());
  feed.emit('state', { status: 'live' });
  await until(() => vlink.ok, 4000, 'the standalone answers the ask');
  feed.emit('giftEnd', { key: 's:9', name: 'Rose', coins: 1, count: 1, userName: 'A', at: Date.now() });
  await until(() => vlink.stats.sent === 1, 3000, 'sent over HTTP');
  assert.equal(vlink.stats.direct, 0);
  // http: false (a test run of the app): nothing is ever asked
  const quiet = new VtuberLink({ port, http: false, probeEveryMs: 50 }).attach(feed);
  t.after(() => quiet.stop());
  quiet._state({ status: 'live' });
  await wait(200);
  assert.equal(quiet.stats.probes, 0); assert.equal(quiet.ok, false);
});
