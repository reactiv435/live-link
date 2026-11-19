'use strict';
// The VTuber card, end to end, on the REAL app (from source, or a packaged build with --app), fenced in as a test run:
//   - its own data folder (LIVE_LINK_USER_DATA), a local stand-in for the site (test/mock-server.js), no TikTok,
//   - a pretend OBS (test/vtuber-dev, no real window, its own port; never 4455) and a test place for the VTuber
//     (never 8791), Chromium's fake microphone, a pretend TikTok LIVE with made-up viewers (LIVE_LINK_TEST_FEED).
// It does what a host does: open LIVE Link, click VTuber, pick a character, press ON. Then it measures what the
// tracker sends (updates a second, picture -> pose), the avatar page as OBS would load it (frames a second, errors,
// a non-empty picture), that viewer events arrive, and that closing VTuber hides the avatar in OBS within 3 s.
//
//   node scripts/vtuber-smoke.js [--app <path to the packaged LIVE Link program>] [--video <clip or still picture>]
//        [--secs 30] [--out <folder>] [--feed 5] [--characters ryo,mask] [--need-face 1] [--min-updates 0]
//        [--soak-min 0] [--no-avatar] [--keep-data]
// --video: what the pretend camera shows (a path; nothing is copied or uploaded). Without it: a plain grey picture
// (no face to find: the run then only proves the road, not the tracking).
// Exit code 0 = no problem found. The numbers are written to <out>/result.json.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('../vendor/vtuber/vendor/ws');
const { createMock } = require('../test/mock-server');

const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const k = argv.indexOf('--' + n); return k < 0 ? d : argv[k + 1]; };
const flag = (n) => argv.includes('--' + n);
const SECS = Number(opt('secs', 30)), FEED = Number(opt('feed', 5)), SOAK_MIN = Number(opt('soak-min', 0));
const CHARACTERS = String(opt('characters', 'ryo,mask')).split(',').filter(Boolean);
const NEED_FACE = opt('need-face', opt('video', '') ? '1' : '0') === '1';
const MIN_UPDATES = Number(opt('min-updates', 0));
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'll-vtuber-smoke-' + Date.now())));
const APP = opt('app', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEVER = new Set([8791, 4455]);
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => (NEVER.has(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
async function until(fn, ms, step = 100) { const t0 = Date.now(); for (;;) { let v = false; try { v = await fn(); } catch { v = false; } if (v) return Date.now() - t0; if (Date.now() - t0 > ms) return -1; await sleep(step); } }
const q = (list, p) => { if (!list.length) return null; const a = [...list].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

// ---------------------------------------------------------------- a very small DevTools client (pages only)
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
});
async function target(port, match, ms = 30000) {
  let found = null;
  await until(async () => { const list = await getJson(port, '/json/list'); found = list.find((t) => t.type === 'page' && match(t.url)); return !!found; }, ms, 250);
  return found;
}
function attach(t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let id = 0; const waiting = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.error) w.rej(new Error(m.error.message)); else w.res(m.result); });
    ws.on('open', () => resolve({
      send, close: () => { try { ws.close(); } catch {} },
      async eval(expr) {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error('page error: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result.value;
      },
      async shot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }); const b = Buffer.from(r.data, 'base64'); fs.writeFileSync(file, b); return b.length; },
    }));
    ws.on('error', reject);
  });
}
function findChrome() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [process.env.CHROME_PATH, path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p)) || null;
}

const R = { when: new Date().toISOString(), app: APP ? 'packaged' : 'source', platform: process.platform + '-' + process.arch, secs: SECS, video: opt('video', '') ? path.basename(opt('video', '')) : null, problems: [] };
const problem = (t) => { R.problems.push(t); console.log('  PROBLEM: ' + t); };
const cleanup = [];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const [sitePort, obsPort, vtPort, cdp, cdpAv] = await Promise.all([1, 2, 3, 4, 5].map(freePort));
  // the stand-in for the site: paired at once, and the host's hype bar is off, so nothing would watch TikTok even without the fence
  const site = createMock({ autoApprove: true, enabled: false, verified: true });
  await site.listen(sitePort); cleanup.push(() => site.close());
  const { startMock } = await import('../test/vtuber-dev/tracking/mock-obs-scenes.js');
  const video = opt('video', '') ? path.resolve(opt('video', '')) : false;
  if (video) process.env.PATH = [process.env.FFMPEG_DIR || '', process.env.PATH].filter(Boolean).join(path.delimiter);   // the pretend OBS cuts the clip into pictures with ffmpeg
  const mock = await startMock({ port: obsPort, projector: 'virtual', quiet: true, video, cacheDir: path.join(OUT, 'frames'), delay: 10 });
  cleanup.push(() => mock.close());
  const obsConfig = path.join(OUT, 'obs-config.json');
  fs.writeFileSync(obsConfig, JSON.stringify({ alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: mock.password, server_port: obsPort }));
  const before = mock.snapshot();

  const userData = path.join(OUT, 'userdata');
  if (!flag('keep-data')) fs.rmSync(userData, { recursive: true, force: true });   // --keep-data: a second start on the same data folder (how long a host waits after the first time)
  const env = { ...process.env, LIVE_LINK_USER_DATA: userData, LIVE_LINK_API: `http://127.0.0.1:${sitePort}/functions/v1/`, LIVE_LINK_TEST_FEED: String(FEED),
    LIVE_LINK_VTUBER_TEST: JSON.stringify({ obsUrl: 'ws://127.0.0.1:' + obsPort, obsConfig, ports: [vtPort], windowCapture: false }) };
  delete env.ELECTRON_RUN_AS_NODE;
  const exe = APP ? path.resolve(APP) : require('electron');
  const args = [...(APP ? [] : [root]), '--remote-debugging-port=' + cdp, '--use-fake-device-for-media-stream', '--mute-audio'];
  const t0 = Date.now();
  const app = spawn(exe, args, { env, stdio: 'ignore', cwd: APP ? path.dirname(exe) : root });
  let appExit = null; app.on('exit', (c) => { appExit = c; });
  cleanup.push(() => { if (appExit === null) { try { app.kill(); } catch {} } });

  // ---- the host's steps: (1) open LIVE Link [already paired on a host's computer; here the pair code is typed once]
  const mainT = await target(cdp, (u) => /ui\/index\.html/.test(u), 40000);
  if (!mainT) throw new Error('LIVE Link did not open its window');
  const ui = await attach(mainT); cleanup.push(() => ui.close());
  R.appStartMs = Date.now() - t0;
  await until(() => ui.eval('!document.getElementById("pair").classList.contains("hidden") || !document.getElementById("status").classList.contains("hidden")'), 20000);
  if (await ui.eval('!document.getElementById("pair").classList.contains("hidden")')) {
    await ui.eval('(() => { const c = document.getElementById("code"); c.value = "TEST2345"; c.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("pair-btn").click(); return 1; })()');
  }
  const cardMs = await until(() => ui.eval('!document.getElementById("status").classList.contains("hidden") && !document.getElementById("vtcard").classList.contains("hidden")'), 30000);
  if (cardMs < 0) throw new Error('the VTuber card never showed');
  R.cardBefore = await ui.eval('({ pill: document.getElementById("vtcard-pill").textContent, text: document.getElementById("vtcard-text").textContent, button: document.getElementById("vtcard-btn").textContent })');
  console.log('card: [' + R.cardBefore.pill + '] ' + R.cardBefore.text + ' -> ' + R.cardBefore.button);
  // (2) click VTuber
  const tOpen = Date.now();
  await ui.eval('document.getElementById("vtcard-btn").click(), 1');
  const pageT = await target(cdp, (u) => u.startsWith('http://127.0.0.1:' + vtPort + '/vtuber.html'), 40000);
  if (!pageT) throw new Error('the VTuber window did not open: ' + JSON.stringify(await ui.eval('document.getElementById("vtcard-text").textContent')));
  const page = await attach(pageT); cleanup.push(() => page.close());
  R.windowMs = Date.now() - tOpen;
  const sentence = () => page.eval('window.__vt ? __vt.sentence() : ""').catch(() => '');
  R.readyMs = await until(async () => /^Ready\./.test(await sentence()), 90000, 250);
  R.readySentence = await sentence();
  console.log('page: ' + R.readySentence + ' (' + R.readyMs + ' ms)');
  if (R.readyMs < 0) problem('the VTuber page never said Ready: "' + R.readySentence + '"');
  const state = () => getJson(vtPort, '/api/vt/state');
  R.capture = (await state()).capture.mode;
  R.cardReady = await ui.eval('({ pill: document.getElementById("vtcard-pill").textContent, text: document.getElementById("vtcard-text").textContent })');
  R.windowTitles = (await getJson(cdp, '/json/list')).filter((t) => t.type === 'page').map((t) => t.title);

  // ---- "the avatar in OBS": the avatar source's own address and size, in a browser with no window (as OBS's own browser has none)
  const input = mock.snapshot().inputs.find((i) => i.name === 'VTuber Avatar');
  if (!input) throw new Error('no avatar source in the pretend OBS');
  R.avatar = { size: [input.settings.width, input.settings.height], placed: mock.snapshot().scenes.filter((s) => s.items.some((i) => i.source === 'VTuber Avatar')).length };
  const stamp = new URL(input.settings.url).searchParams.get('run');
  let av = null;
  if (!flag('no-avatar')) {
    const chrome = findChrome();
    const profile = path.join(OUT, 'avatar-browser');
    let proc;
    if (chrome) proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + cdpAv, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--window-size=' + input.settings.width + ',' + input.settings.height, '--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : ['--enable-unsafe-swiftshader']), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', input.settings.url], { stdio: 'ignore' });
    else proc = spawn(require('electron'), [path.join(__dirname, 'vtuber-avatar-shell.js'), input.settings.url, String(input.settings.width), String(input.settings.height), '--remote-debugging-port=' + cdpAv, '--user-data-dir=' + profile], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    R.avatar.browser = chrome ? 'chrome (no window)' : 'electron (hidden window)';
    cleanup.push(() => { try { proc.kill(); } catch {} });
    const avT = await target(cdpAv, (u) => u.includes('/avatar.html'), 40000);
    if (!avT) problem('the avatar page did not open');
    else {
      av = await attach(avT); cleanup.push(() => av.close());
      R.avatar.readyMs = await until(() => av.eval('!!(window.__vt && __vt.debug && __vt.debug.ready)'), 90000, 250);
      if (R.avatar.readyMs < 0) problem('the avatar page never got ready');
    }
  }
  // what the tracker and the microphone send (a page the app does not know still hears these), and the viewer events
  // exactly as the avatar page gets them (a socket with the avatar source's own stamp)
  const got = { on: false, perf: 0, face: 0, body: 0, rx: [], gaps: [], mic: 0, events: {}, lastPerf: 0 };
  const relay = new WebSocket('ws://127.0.0.1:' + vtPort + '/ws');
  await new Promise((res, rej) => { relay.on('open', res); relay.on('error', rej); }); cleanup.push(() => relay.close());
  relay.on('message', (d) => {
    if (!got.on) return;
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    const now = Date.now();
    if (m.t === 'perf' && !m.idle) { got.perf++; if (got.lastPerf) got.gaps.push(now - got.lastPerf); got.lastPerf = now; if (m.face) got.face++; if (m.body) got.body++; if (typeof m.at === 'number') got.rx.push(now - m.at); }
    else if (m.t === 'mic') got.mic++;
  });
  const evSock = new WebSocket('ws://127.0.0.1:' + vtPort + '/ws?oneclick=1&run=' + stamp);
  await new Promise((res, rej) => { evSock.on('open', res); evSock.on('error', rej); }); cleanup.push(() => evSock.close());
  evSock.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } if (m.t === 'mask-event' && m.e) { const k = got.cur || 'none'; got.events[k] = got.events[k] || {}; got.events[k][m.e.type] = (got.events[k][m.e.type] || 0) + 1; } });

  // (3) pick, (4) ON
  const avatarItems = () => { const out = []; for (const sc of mock.snapshot().scenes) for (const it of sc.items) if (it.source === 'VTuber Avatar') out.push(it); return out; };
  R.runs = [];
  const heroes = await page.eval('[...document.querySelectorAll(".hero")].map((h) => h.dataset.id)');
  R.tiles = heroes;
  for (const who of CHARACTERS) {
    if (!heroes.includes(who)) { problem('no tile for ' + who + ' (tiles: ' + heroes.join(', ') + ')'); continue; }
    await page.eval('document.querySelector(' + JSON.stringify('.hero[data-id=' + who + ']') + ').click(), 1'); await sleep(400);
    if (!(await state()).on) await page.eval('document.getElementById("power").click(), 1');
    const run = { character: who };
    run.onMs = await until(async () => (NEED_FACE ? /^ON./ : /^ONb/).test(await sentence()), 20000, 150);
    run.onSentence = await sentence();
    run.obsOnMs = await until(() => avatarItems().length > 0 && avatarItems().every((i) => i.enabled), 5000, 50);
    if (run.onMs < 0) problem(who + ': the page never said ON: "' + run.onSentence + '"');
    if (run.obsOnMs < 0) problem(who + ': the avatar did not show in the pretend OBS');
    run.card = await ui.eval('document.getElementById("vtcard-pill").textContent + ": " + document.getElementById("vtcard-text").textContent');
    await sleep(5000);                                   // warm-up
    got.perf = got.face = got.body = got.mic = 0; got.rx = []; got.gaps = []; got.lastPerf = 0; got.cur = who; got.on = true;
    const m0 = Date.now(), fps = [], shots = [];
    const secs = SOAK_MIN > 0 && who === CHARACTERS[CHARACTERS.length - 1] ? SOAK_MIN * 60 : SECS;
    const marks = [];
    while (Date.now() - m0 < secs * 1000) {
      if (av) { const s = await av.eval('JSON.stringify({ fps: Math.max(__vt.fps || 0, window.VTMaskPage && VTMaskPage.fps ? VTMaskPage.fps() : 0), errors: __vt.errors.length })').then(JSON.parse).catch(() => null); if (s) { fps.push(s.fps); run.avatarErrors = s.errors; } }
      if (av && shots.length < 4 && Date.now() - m0 > shots.length * Math.min(8000, secs * 250)) { const f = path.join(OUT, who + '-' + shots.length + '.png'); shots.push(await av.shot(f).catch(() => 0)); }
      if (secs > 120 && Date.now() - m0 > (marks.length + 1) * 300000) {     // a long run: every 5 minutes, that window's own numbers
        const w = (Date.now() - m0) / 1000, heap = (p) => (p ? p.eval('performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null').catch(() => null) : null);
        const last = marks.length ? marks[marks.length - 1] : { perf: 0, w: 0, rx: 0 };
        const mk = { atMin: Math.round(w / 60), updatesPerSec: +((got.perf - last.perf) / (w - last.w)).toFixed(1), pictureToPoseMedMs: q(got.rx.slice(last.rx), 0.5), avatarFps: fps.length ? q(fps.slice(-200), 0.5) : null, pageHeapMB: await heap(page), avatarHeapMB: await heap(av), perf: got.perf, w, rx: got.rx.length };
        marks.push(mk); console.log('  soak ' + JSON.stringify({ ...mk, perf: undefined, w: undefined, rx: undefined }));
      }
      await sleep(500);
    }
    got.on = false;
    const wall = (Date.now() - m0) / 1000;
    Object.assign(run, { secs: +wall.toFixed(1), updatesPerSec: +(got.perf / wall).toFixed(1), facePerSec: +(got.face / wall).toFixed(1), bodyPerSec: +(got.body / wall).toFixed(1), micPerSec: +(got.mic / wall).toFixed(1),
      pictureToPoseMs: { med: q(got.rx, 0.5), p95: q(got.rx, 0.95) }, gapMs: { med: q(got.gaps, 0.5), p95: q(got.gaps, 0.95), max: got.gaps.length ? Math.max(...got.gaps) : null },
      avatarFps: fps.length ? { med: q(fps, 0.5), min: Math.min(...fps) } : null, shotBytes: shots, events: got.events[who] || {}, soak: marks.length ? marks : undefined });
    if (av) run.avatarPage = await av.eval('JSON.stringify({ hero: __vt.fps, mask: window.VTMaskPage ? (() => { const s = VTMaskPage.status(); return { fps: VTMaskPage.fps(), ok: s.ok, error: s.error, drawn: s.drawn, faceHz: s.faceHz, sound: s.sound, events: s.events, lagMs: s.lagMs }; })() : null, gifts: (() => { try { const g = __vt.gifts; return g ? { fired: g.fired || g.count || null } : null; } catch (e) { return null; } })() })').then(JSON.parse).catch((e) => ({ error: String(e && e.message) }));
    run.pageErrors = await page.eval('JSON.stringify({ notes: window.__vt ? __vt.notes() : [], tracker: (() => { const t = window.__vt && __vt.tracker(); return t ? { status: t.status, detail: t.detail } : null; })() })').then(JSON.parse).catch(() => null);
    console.log(who + ': ' + JSON.stringify({ updates: run.updatesPerSec, face: run.facePerSec, latency: run.pictureToPoseMs, avatarFps: run.avatarFps, errors: run.avatarErrors, events: run.events }));
    if (NEED_FACE && run.facePerSec < 5) problem(who + ': the face was found only ' + run.facePerSec + ' times a second');
    if (MIN_UPDATES && run.updatesPerSec < MIN_UPDATES) problem(who + ': ' + run.updatesPerSec + ' updates a second (wanted ' + MIN_UPDATES + ')');
    if (av && run.avatarErrors) problem(who + ': ' + run.avatarErrors + ' error(s) on the avatar page');
    if (av && shots.length && Math.max(...shots) < 3000) problem(who + ': the avatar page drew an empty picture');
    if (FEED > 0 && !(run.events.gift > 0)) problem(who + ': no gift from the pretend LIVE reached the avatar page');
    R.runs.push(run);
  }
  R.feed = { perSec: FEED, note: 'made-up viewers; no TikTok connection' };
  R.siteCalls = [...new Set(site.state.calls.map((c) => c.path))];
  if (site.state.pushes.length) problem('the pretend LIVE reached the site as taps or gifts (' + site.state.pushes.length + ' pushes)');

  // closing the card: the avatar is hidden in OBS within 3 s, the VTuber's place answers no more, LIVE Link keeps running
  const tClose = Date.now();
  await ui.eval('document.getElementById("vtcard-close").click(), 1');
  R.closeHidMs = await until(() => avatarItems().every((i) => !i.enabled), 6000, 25);
  if (R.closeHidMs < 0 || R.closeHidMs > 3000) problem('closing VTuber hid the avatar after ' + R.closeHidMs + ' ms (limit 3000)');
  R.vtGoneMs = await until(() => new Promise((res) => { const c = net.connect(vtPort, '127.0.0.1'); c.once('connect', () => { c.destroy(); res(false); }); c.once('error', () => res(true)); }), 15000, 200);
  R.closeTotalMs = Date.now() - tClose;
  await sleep(500);
  R.cardAfter = await ui.eval('document.getElementById("vtcard-pill").textContent + ": " + document.getElementById("vtcard-text").textContent');
  if (appExit !== null) problem('LIVE Link ended when VTuber was closed');
  // his scenes: only the avatar was added (hidden again); everything else exactly as it was
  const strip = (snap) => JSON.stringify({ ...snap, inputs: snap.inputs.filter((i) => i.name !== 'VTuber Avatar'), scenes: snap.scenes.map((s) => ({ ...s, items: s.items.filter((i) => i.source !== 'VTuber Avatar') })) });
  if (strip(mock.snapshot()) !== strip(before)) problem('something else changed in the pretend OBS');
  // the logs: no viewer name, no comment, no OBS password
  let logText = '';
  for (const f of [path.join(userData, 'logs', 'live-link.log'), path.join(userData, 'vtuber', 'vtuber.log')]) { try { logText += fs.readFileSync(f, 'utf8'); } catch {} }
  R.logLines = logText.split('\n').length;
  if (/Viewer \d|test comment/.test(logText)) problem('a viewer name or a comment is in a log');
  if (logText.includes(mock.password)) problem('the OBS password is in a log');
  if (/ ERROR |uncaught|unhandled/.test(logText)) problem('errors in the app log');
  R.missingFiles = [...logText.matchAll(/a file the page asked for is not there: (\S+)/g)].map((m) => m[1]).filter((p) => !/calib-owner\.json$/.test(p));
  if (R.missingFiles.length) problem('files the page asked for are not in the copy: ' + [...new Set(R.missingFiles)].join(', '));
}

main().catch((e) => { problem('the run failed: ' + ((e && e.stack) || e)); }).finally(async () => {
  for (const c of cleanup.reverse()) { try { await c(); } catch {} }
  await sleep(300);
  try { fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 1)); } catch {}
  console.log((R.problems.length ? 'FAILED (' + R.problems.length + ' problem(s))' : 'OK') + ' -> ' + path.join(OUT, 'result.json'));
  process.exit(R.problems.length ? 1 : 0);
});
