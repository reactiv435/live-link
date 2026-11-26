// VTuber, one click (V3-ONE-CLICK.md). Started by VTuber.bat. It does by itself everything v2 asked the owner to do:
//   - connects to OBS (password read from OBS's own settings file; tries again every 2 s while OBS is closed),
//   - finds the camera that is him and how it is turned in the scene on air,
//   - adds the avatar to OBS directly above that camera wherever the camera is visible (hidden while OFF),
//   - opens OBS's small window of that camera and sends it behind the other windows,
//   - opens the ONE page (vtuber.html) in its own Chrome window, which picks that small window up without asking,
//   - switches the avatar off in OBS within 3 s when the page closes or crashes, closes the small window it opened,
//     and stops when the page is gone.
// It never touches anything else in OBS, and only ever sizes / closes the windows it opened itself.
// The earlier VTuber's server (start-vtuber.bat) holding the place is closed by itself; nothing else is ever closed.
// Tests only: VTUBER_PORT, VTUBER_OBS_URL, VTUBER_OBS_CONFIG, VTUBER_RECORD, VTUBER_PROFILE, VTUBER_CHROME_ARGS (a JSON
// list of extra Chrome switches), VTUBER_NO_CHROME=1 (open no window), VTUBER_STAY=1 (do not stop when the page is gone),
// opts.chromeCmd (tests: a pretend Chrome, [exe, ...args], started instead of the real one),
// VTUBER_SOUND_CMD (a JSON list: a pretend PC-sound helper; a test run never listens to the real PC without it),
// VTUBER_SOUND=off (never listen to the PC's sound: OBS's level or his voice instead),
// VTUBER_OLD_BAT (a pretend start-vtuber.bat under tmp/), VTUBER_TEST_NO_AUTOSELECT=1 (Chrome shows its share list).
//
// V6: the same app can run INSIDE LIVE Link (livelink-host.js starts it with opts.embedded). Then there is no Chrome: the
// page is a LIVE Link window, LIVE Link hands that page the camera's window by its exact window number (no share list),
// the files it keeps live in opts.dataDir, viewer events come in through event(), and what the card shows is told to
// the parent through opts.onHost. It never ends by itself when the page is gone (the parent decides), and it never
// closes, sizes or looks for any Chrome window. VTuber.bat (not embedded) behaves exactly as before.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('./vendor/ws');
const serverJs = require('./server.js');
const { ObsLink } = require('./obs-link.js');
const scene = require('./obs-scene.js');
const win = require('./win-windows.js');
const Wire = require('./js/mask-wire.js');
const { createSound } = require('./sound.js');

const ROOT = __dirname;
const PAGE_TITLE = 'VTuber';
const GENERIC_NEEDLE = 'Projector - Source:';        // how OBS 32 (English) starts the title of a source's window
const PAGE_GONE_MS = 2000;                            // no sign of the page for this long = the avatar goes off in OBS
const SHOT_REQUESTS = new Set(['GetVersion', 'GetInputList', 'GetSourceScreenshot', 'GetCurrentProgramScene', 'GetSceneItemId', 'GetSceneItemTransform']);
const AVATAR_SENDS = new Set(['avatar-ack', 'avatar-hello']);   // all an avatar page in OBS may say on the relay
// the avatar page in OBS shown but silent: press its "Refresh" after 4 s, give it a new address after 6 s more, then say so
const WATCH_MS = [4000, 6000, 8000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMBED_PORTS = [8791, 8792, 8793, 8794, 8795];   // inside LIVE Link: the show's own place first, then the next free one
// a system with no window helper (macOS, Linux): no window is ever listed, sized or closed; the camera is read the slower way
const NO_WINDOWS = { listWindows: async () => [], placeWindow: async () => false, closeWindow: async () => false, frontWindow: async () => false, hideWindow: async () => false };

function findChrome() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.CHROME_PATH, path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return list.find((p) => p && fs.existsSync(p)) || null;
}
/** Chrome's main version, from the version folder beside chrome.exe (no program has to run for it) */
function chromeMajor(exe) {
  try {
    const v = fs.readdirSync(path.dirname(exe)).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)).map((n) => n.split('.').map(Number))
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || b[3] - a[3])[0];
    return v ? String(v[0]) : '';
  } catch { return ''; }
}
const uaMajor = (ua) => { const m = /(?:Chrome|Edg)\/(\d+)/.exec(String(ua || '')); return m ? m[1] : ''; };

/**
 * startOneClick(opts) -> { port, state(), stop(), done (resolves when it stopped by itself) }
 * opts (all optional; the env overrides above are the defaults): port, obsUrl, obsConfig, recordFile, profileDir,
 * chromeArgs, noChrome, stay, logFile, windows (a stand-in for win-windows.js in tests).
 */
async function startOneClick(opts = {}) {
  const port = Number(opts.port || process.env.VTUBER_PORT) || 8791;
  const obsUrl = opts.obsUrl || process.env.VTUBER_OBS_URL || '';
  const obsConfig = opts.obsConfig || process.env.VTUBER_OBS_CONFIG || '';
  // A run on any port but the show's own is a test: it must name its pretend OBS and a fixture settings file, so it can
  // never reach the real OBS (port 4455) or read the real OBS settings (under %APPDATA%\obs-studio).
  const embedded = !!opts.embedded;
  // (inside LIVE Link the next free place 8792 - 8795 is a real run too: only then may the caller say "not a test")
  const test = opts.test === false && embedded && EMBED_PORTS.includes(port) ? false : opts.test === true ? true : port !== 8791;
  // can the page be handed the camera's window? Chrome: yes. Inside LIVE Link: on Windows (by its window number).
  const windowCapture = !embedded ? true : opts.windowCapture !== undefined ? !!opts.windowCapture : process.platform === 'win32';
  const host = (m) => { if (opts.onHost) { try { opts.onHost(m); } catch { /* the parent's problem */ } } };
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : null;
  const kept = (name, fallback) => (dataDir ? path.join(dataDir, name) : fallback);
  if (test) {
    if (!obsUrl) throw new Error('a test run (port ' + port + ') needs VTUBER_OBS_URL: it must never reach the real OBS');
    if (!obsConfig) throw new Error('a test run (port ' + port + ') needs VTUBER_OBS_CONFIG (a fixture file): it must never read the real OBS settings');
    let u = null;
    try { u = new URL(obsUrl); } catch { /* checked below */ }
    if (!u || !u.port || u.port === '4455') throw new Error('a test run must name a pretend OBS on its own port (never 4455): ' + obsUrl);
    const real = process.env.APPDATA ? path.resolve(process.env.APPDATA, 'obs-studio').toLowerCase() : null;
    if (real && path.resolve(obsConfig).toLowerCase().startsWith(real)) throw new Error('a test run must never read the real OBS settings');
  }
  const testDir = path.join(ROOT, 'tmp', 'v3', 'run-' + port);
  const recordFile = opts.recordFile || process.env.VTUBER_RECORD || kept('vtuber-obs.json', test ? path.join(testDir, 'vtuber-obs.json') : path.join(ROOT, 'vtuber-obs.json'));
  const profileDir = opts.profileDir || process.env.VTUBER_PROFILE || (test ? path.join(testDir, 'chrome') : path.join(ROOT, 'tracking', 'chrome-vtuber'));
  let chromeArgs = opts.chromeArgs || [];
  if (!opts.chromeArgs && process.env.VTUBER_CHROME_ARGS) { try { chromeArgs = JSON.parse(process.env.VTUBER_CHROME_ARGS); } catch { chromeArgs = []; } }
  const noChrome = embedded ? true : opts.noChrome !== undefined ? opts.noChrome : process.env.VTUBER_NO_CHROME === '1';
  // the primary screen's work area, for the VTuber window's size: read once while the rest starts (opts.workArea: tests)
  const workArea = opts.workArea !== undefined ? Promise.resolve(opts.workArea) : noChrome || opts.chromeCmd ? Promise.resolve(null) : primaryWorkArea();
  const stay = embedded ? true : opts.stay !== undefined ? opts.stay : process.env.VTUBER_STAY === '1';
  const W = opts.windows || (process.platform === 'win32' ? win : NO_WINDOWS);
  const logFile = opts.logFile !== undefined ? opts.logFile : kept('vtuber.log', test ? path.join(testDir, 'vtuber.log') : path.join(ROOT, 'tmp', 'vtuber.log'));
  let logLines = 0;
  const log = (text) => {
    host({ t: 'log', line: String(text) });              // (never names, comments or the password: see the callers)
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // inside LIVE Link the log is never cleared by hand: kept to about 1 MB (looked at every 200 lines)
      if (embedded && logLines++ % 200 === 0) { try { if (fs.statSync(logFile).size > 1000000) fs.renameSync(logFile, logFile + '.old'); } catch { /* no log yet */ } }
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + text + '\n');
    } catch { /* no log */ }
  };
  // the Mask's files: the gift list (git-tracked defaults; his own copy wins and is git-ignored) and his resting face
  const giftsDefault = path.join(ROOT, 'mask', 'gifts.json');
  const giftsOwner = opts.giftsFile || kept('gifts-owner.json', test ? path.join(testDir, 'gifts-owner.json') : path.join(ROOT, 'gifts-owner.json'));
  const restFile = opts.restFile || kept('mask-rest.json', test ? path.join(testDir, 'mask-rest.json') : path.join(ROOT, 'tracking', 'mask-rest.json'));
  // V9: the host's own show signs (uploaded in the VTuber window). Inside LIVE Link: its data folder (never the app's own
  // files, which are read-only once packaged); the desktop-shortcut VTuber: a git-ignored folder next to it; a test: its own.
  const signDir = opts.signDir || kept('signs', test ? path.join(testDir, 'signs') : path.join(ROOT, 'signs-owner'));
  let soundCmd = opts.soundCmd || null;
  if (!soundCmd && process.env.VTUBER_SOUND_CMD) { try { const c = JSON.parse(process.env.VTUBER_SOUND_CMD); if (Array.isArray(c) && c.length) soundCmd = c.map(String); } catch { soundCmd = null; } }
  const base = 'http://127.0.0.1:' + port;
  // ?oneclick=1: the avatar page hides the avatar by itself when this app is gone (a crash must never leave him covered).
  // &run=: a new stamp on every start, so OBS loads the page again (a page OBS tried before this app ran never retries).
  const stamps = new Set();
  let avatarUrl = '';
  const newStamp = () => { const st = Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); stamps.add(st); avatarUrl = base + '/avatar.html?oneclick=1&run=' + st; return st; };
  let stamp = newStamp();
  // the relay takes messages only from this run's own pages: the page window (a cookie its Chrome got with vtuber.html)
  // and the avatar page in OBS (its address carries the stamp). Pages of the earlier VTuber (v2 control / tracker pages,
  // which reconnect by themselves) still get the messages, but nothing they send is taken: no second face, no ON / OFF.
  const COOKIE = 'vt3_' + port, TOKEN = crypto.randomBytes(16).toString('hex');
  const ownPage = (req) => String((req && req.headers.cookie) || '').split(/;\s*/).includes(COOKIE + '=' + TOKEN);
  let ignored = 0;
  function accept(req) {
    if (ownPage(req)) return { kind: 'page' };
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    if (q.get('oneclick') === '1' && stamps.has(q.get('run') || '')) return { kind: 'avatar', only: AVATAR_SENDS };
    if (ignored++ < 5) log('a page of an earlier VTuber (or of an earlier start) joined the relay: nothing it sends is taken');
    return null;
  }
  const headers = (req) => ((req.url || '').split('?')[0] === '/vtuber.html' ? { 'Set-Cookie': COOKIE + '=' + TOKEN + '; Path=/; HttpOnly; SameSite=Strict' } : null);
  try { fs.mkdirSync(path.dirname(recordFile), { recursive: true }); } catch { /* saved later or not at all */ }

  // ---------------------------------------------------------------- what was added to OBS (kept on this PC, git-ignored)
  let record = { items: [], input: null, camera: null, projector: null, lastTitle: null };
  try { const r = JSON.parse(fs.readFileSync(recordFile, 'utf8')); if (r && typeof r === 'object') record = { ...record, ...r, items: Array.isArray(r.items) ? r.items : [] }; } catch { /* first run */ }
  // B2 (fix round): `pickerSeen` / `noWindowFor` written before rule 2 came from a 7 s timeout alone (a slow start was
  // taken for Chrome's share list, and two of them put every later start on the slower way). They prove nothing: dropped
  // here, in code, the first time this version reads the record. From rule 2 on only a share list that was really seen
  // as a window counts, and a good start clears the count.
  const PICKER_RULE = 2;
  let recordMigrated = '';
  if (record.pickerRule !== PICKER_RULE) {
    if (record.pickerSeen || record.noWindowFor) recordMigrated = 'earlier share-list counts dropped (pickerSeen ' + (record.pickerSeen || 0) + ', noWindowFor ' + (record.noWindowFor || 'none') + '): they came from the old 7 s rule';
    delete record.pickerSeen; delete record.noWindowFor;
    record.pickerRule = PICKER_RULE;
  }
  const saveRecord = () => { try { fs.writeFileSync(recordFile + '.tmp', JSON.stringify(record, null, 1)); fs.renameSync(recordFile + '.tmp', recordFile); } catch (e) { log('could not save the record: ' + e.message); } };

  const S = {
    obs: 'closed', camera: null, cameraWhy: '', cameras: [], view: { turn: 0, flip: 'none' }, program: '',
    avatar: { placed: 0, scenes: [], problem: null, removed: false },
    projector: { state: 'none', title: '', hwnd: 0, ours: false },
    on: false, lastAvatar: null, startedAt: Date.now(),
    pageSeenAt: 0, pageEver: false, chrome: null, chromeNeedle: '', chromeStartedAt: 0, chromeExitedAt: 0, noChild: !!noChrome,
    restartUntil: 0, restartAt: 0, stopping: false, onAirOther: null,
    lifeAt: 0, watch: { stage: 0, from: 0 }, avatarSilent: false,       // the avatar page in OBS: its last word, the watchdog
    projectorShown: false, projectorAllowed: false,                     // the camera window opens once a run (or on a camera pick)
    chromeMajor: '', noWindowRun: false, pageMajor: '',                 // Chrome showed its share list: the slower way
    noWindowUntil: 0, windowTimeouts: 0, wasSlower: false,              // the window came too late: the slower way for a minute, then one more try
    rates: null, ratesAt: 0, ratesWarnAt: 0, ratesShed: 0,              // B3: what the page measured, for one log line a minute
    mask: false, giftsRev: 0, restRev: 0, events: 0, eventsSeenAt: 0,   // the Mask: chosen?, its files' stamps, viewer events taken
  };
  const stampOf = (file) => { try { return Math.round(fs.statSync(file).mtimeMs); } catch { return 0; } };
  /** the gift list in use: his copy when there is a readable one, else the defaults */
  function readGifts() {
    for (const [file, mine] of [[giftsOwner, true], [giftsDefault, false]]) {
      try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); const rows = Wire.cleanGiftRows(Array.isArray(j) ? j : j && j.rows); if (rows && rows.length > 1) return { rows, mine }; } catch { /* the next one */ }
    }
    return { rows: Wire.cleanGiftRows([{ upTo: 9, effect: 'chip' }, { upTo: 199, effect: 'barrage' }, { upTo: 999, effect: 'grow' }, { effect: 'shatter' }]), mine: false };
  }
  S.giftsRev = stampOf(giftsOwner) || 1; S.restRev = stampOf(restFile);
  const link = new ObsLink({ url: obsUrl || undefined, configFile: obsConfig || undefined });
  // ---------------------------------------------------------------- the Mask: its music, its viewer events
  // a test run never listens to the real PC: only to a pretend helper it names itself
  const sound = createSound({
    log: (t) => log(t), cmd: soundCmd, allowReal: !test && String(process.env.VTUBER_SOUND || '').toLowerCase() !== 'off',
    onAudio: (m) => { if (app && S.on && S.mask) app.broadcast(m); },
  });
  link.on('event', (type, data) => { if (type === 'InputVolumeMeters') sound.meters(data); });
  const METER_KINDS = ['wasapi_output_capture', 'wasapi_process_output_capture', 'pulse_output_capture', 'coreaudio_output_capture'];
  async function meterInputs() {
    if (link.state !== 'ok') return;
    try { const r = await link.call('GetInputList', {}); sound.meterInputs((r.inputs || []).filter((i) => METER_KINDS.includes(i.unversionedInputKind || i.inputKind)).map((i) => i.inputName)); } catch { /* next time */ }
  }
  function setMask(on) {
    on = !!on;
    if (on === S.mask) return;
    S.mask = on;
    log(on ? 'the music is listened to (the Mask is chosen, or shuffle to the beat is on)' : 'the music is no longer listened to');
    sound.want(on);
    link.subscribe(on ? 65536 : 0);
    if (on) meterInputs();
  }
  /** a viewer event (from LIVE Link, or a "Try the effects" button): on to the avatar page, while the avatar is on air
   *  (the Mask, or Ryo / Melanie: round 5, their gift missiles) */
  function fireEvent(ev) {
    if (!app || !S.on) return false;
    S.events++;
    app.broadcast({ t: 'mask-event', e: ev });
    return true;
  }
  // at most 20 gifts and 10 other events a second (the contract with LIVE Link)
  const rateOk = createRate();
  /**
   * One viewer event, whichever door it came through (the HTTP door below, or LIVE Link handing it over inside the app):
   * every field checked and clipped, the same caps. -> 'bad' | 'rate' | 'ok' (on to the avatar page) | 'off' (taken, the
   * avatar is not on air). Names and comment text are never written to disk (not to the log either).
   */
  function takeEvent(raw) {
    let ev = null;
    // V8 (V8-PHASE2.md C3 / C4): LIVE Link's show state (song on air, cover, hype rank, his grade) and its global keys
    // come through the same two doors. The show state goes to every page of this run (the avatar page draws it, the
    // window greys "Boss fight" while a song is on air) and is kept for a page that loads again; a key only while on air.
    if (raw && typeof raw === 'object' && (raw.type === 'show' || raw.type === 'control')) {
      try { ev = Wire.cleanAny(raw); } catch { ev = null; }
      if (!ev) return 'bad';
      if (!rateOk(ev.type)) return 'rate';
      if (ev.type === 'show') { if (!S.showSeenAt) log('LIVE Link is sending the show state (song on air, hype)'); S.showSeenAt = Date.now(); if (app) app.broadcast({ t: 'v8-show', s: ev, rx: Date.now() }); return 'ok'; }
      // (a key also goes on while the avatar is OFF in OBS: the pages decide; the avatar page only acts while it is on air)
      // (release A: the control 'eat' = EAT IT goes on as action 'eat'; it is not the puppet move "eat a comment", which is 'tap' + name 'eat')
      if (!app) return 'off';
      // V9: the show sign's and the live overlay's keys go to the VTuber window (it owns the two switches and says so in its next `avatar` message)
      if (ev.action === 'sign' || ev.action === 'overlay') { app.broadcast({ t: 'v9-sign-cmd', what: ev.action, from: 'key' }); return S.on ? 'ok' : 'off'; }
      app.broadcast({ t: 'v8-cmd', action: ev.action === 'puppet' ? 'tap' : ev.action, name: ev.name, from: 'key' });
      return S.on ? 'ok' : 'off';
    }
    try { ev = Wire.cleanEvent(raw); } catch { ev = null; }
    if (!ev) return 'bad';
    if (!rateOk(ev.type)) return 'rate';
    if (!S.eventsSeenAt) log('LIVE Link is sending viewer events');
    S.eventsSeenAt = Date.now();
    return fireEvent(ev) ? 'ok' : 'off';
  }
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  /**
   * POST /api/tiktok-event (V4-MASK.md): only from this PC, never from a web page (no Origin), only with LIVE Link's
   * header; every field checked and clipped; 204. GET: { ok, v } so LIVE Link can see a VTuber is listening.
   * Names and comment text are never written to disk (not to the log either).
   */
  function tiktokApi(req, res) {
    const send = (code, obj, extra) => {
      const body = obj ? Buffer.from(JSON.stringify(obj)) : null;
      res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(body ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length } : {}), ...extra });
      res.end(body || undefined);
    };
    const refuse = (code, error, extra) => { req.resume(); send(code, { error }, extra); };
    if (!LOOPBACK.has(req.socket.remoteAddress || '')) return refuse(403, 'forbidden');
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined) return refuse(403, 'forbidden');   // a web page
    if (req.method === 'GET' || req.method === 'HEAD') { req.resume(); return send(200, { ok: true, v: 2 }, { 'X-VTuber-Events': '2' }); }   // (the header: this VTuber also takes v2 events, `show` and `control`)
    if (req.method !== 'POST') return refuse(405, 'method', { Allow: 'GET, POST' });
    if (req.headers['x-livelink-event'] !== '1') return refuse(403, 'forbidden');
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return refuse(415, 'send JSON');
    const MAX = 2048;
    if (Number(req.headers['content-length']) > MAX) return refuse(413, 'too big');
    const parts = []; let size = 0, over = false;
    req.on('data', (d) => { size += d.length; if (size > MAX) { over = true; if (size > 65536) req.destroy(); } else parts.push(d); });
    req.on('error', () => {});
    req.on('end', () => {
      if (over) return send(413, { error: 'too big' });
      let raw = null;
      try { raw = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { raw = null; }
      const took = takeEvent(raw);
      if (took === 'bad') return send(400, { error: 'not an event' });
      if (took === 'rate') return send(429, { error: 'slow down' }, { 'Retry-After': '1' });
      send(204, null);
    });
  }
  let app = null, col = null, camera = null;

  // ---------------------------------------------------------------- one job at a time
  let chain = Promise.resolve();
  const queue = (fn) => { const p = chain.then(fn, fn); chain = p.catch((e) => log('job failed: ' + (e && e.message))); return p; };

  // ---------------------------------------------------------------- the avatar: on / off
  async function applyOn(on) {
    S.on = !!on;
    if (link.state === 'ok' && record.items.length) await scene.setAvatarEnabled(link, record.items, S.on);
  }
  /** The page is gone (closed, crashed) or the app stops: the avatar page is told OFF and the items are hidden in OBS. */
  function forceOff(why) {
    if (!S.on && !(S.lastAvatar && S.lastAvatar.on)) return Promise.resolve();
    log('avatar off: ' + why);
    if (S.lastAvatar && app) { S.lastAvatar = { ...S.lastAvatar, on: false }; app.broadcast(S.lastAvatar); }
    return queue(() => applyOn(false));
  }

  // ---------------------------------------------------------------- OBS: read, choose, add, open the camera's window
  async function refresh(why) {
    if (link.state !== 'ok' || S.stopping) return;
    col = await scene.readCollection(link);
    S.program = col.program;
    const list = scene.cameraList(col);
    // under More each camera is named with the scenes it shows in, so he can tell his two phones apart
    S.cameras = list.map((c) => ({ name: c.name, kind: c.kind, visibleScenes: c.visibleScenes, scenes: [...new Set(c.placements.filter((p) => p.visible).map((p) => p.scene))] }));
    // The camera that is him is picked ONCE (the phone in the scene on air; none there: the phone with the biggest box
    // in any scene) and SAVED: kept from show to show, whatever is on air at the start, until he picks another under
    // More. Never switched mid-show.
    // (more than one camera and none of them a DroidCam: nothing is picked; the page asks him once, and that is saved)
    const pick = scene.chooseCamera(col, record.camera);
    if (pick && pick.why === 'ask' && S.cameraWhy !== 'ask') log('more than one camera in OBS and no DroidCam: the page asks which one is him (' + list.length + ' cameras)');
    if (pick && pick.camera && pick.why !== 'chosen' && pick.why !== 'not-visible') {
      record.camera = pick.camera.name; record.cameraWhy = pick.why;
      log('camera picked by itself and kept from now on: ' + pick.camera.name + ' (' + pick.why + ', on air: ' + col.program + ')');
      saveRecord();
    }
    camera = pick ? pick.camera || null : null;
    S.camera = camera ? camera.name : null;
    S.cameraWhy = !pick ? 'none' : pick.why === 'chosen' ? (record.cameraWhy || 'chosen') : pick.why;
    // ON, and the scene on air shows only his OTHER phone: a hint on the page (he may have picked the wrong one)
    const onAir = list.filter((c) => scene.CAMERA_KINDS.includes(c.kind) && c.placements.some((p) => p.visible && p.scene === col.program)).map((c) => c.name);
    S.onAirOther = camera && onAir.length && !onAir.includes(camera.name) ? onAir[0] : null;
    const main = camera ? scene.mainPlacement(col, camera) : null;
    S.view = main ? main.view : { turn: 0, flip: 'none' };
    if (camera && !S.avatar.removed) {
      try {
        const r = await scene.syncAvatar(link, col, camera, { url: avatarUrl, on: S.on, ours: !!record.input });
        record.items = r.items; record.input = r.input;
        S.avatar = { placed: r.items.length, scenes: r.items.map((i) => i.scene), problem: r.items.length ? null : 'not-visible', removed: false };
        if (r.added || r.removed) log('avatar in OBS: ' + r.items.length + ' placements (' + r.added + ' added, ' + r.removed + ' taken out) [' + why + ']');
      } catch (e) {
        S.avatar = { placed: 0, scenes: [], problem: e.code === 'name-taken' ? 'name-taken' : 'failed', removed: false };
        log('avatar sync failed: ' + e.message);
      }
      saveRecord();
    } else if (!camera) S.avatar = { placed: 0, scenes: [], problem: pick && pick.why === 'ask' ? 'pick-camera' : 'no-camera', removed: S.avatar.removed };
    await ensureProjector();
  }

  // his own, already open window of that camera (English OBS 32: "Projector - Source: <name>"); other languages are
  // found by the before / after comparison when this app asks OBS to open one
  // A test run on real windows never takes a window it did not open itself: the owner's real OBS camera window may be
  // open on this PC (tools/test-safety.cjs). Only the show's own run (port 8791), or a test's stand-in window list, adopts.
  const mayAdopt = !test || (!!opts.windows && opts.adoptOwn !== false);
  const projectorMatch = (title, name) => mayAdopt && title === 'Projector - Source: ' + name;
  const failProjector = (why) => { log(why); S.projector = { state: 'failed', title: '', hwnd: 0, ours: false }; };
  /**
   * The camera's small OBS window: the one this app opened before (still open), else his own, else OBS is asked to open
   * one; which window that is = the window that was not there before and carries the camera's name (no guessing at
   * OBS's wording). Only a window this app opened is sized and sent behind the others (`fix`: also when it was minimised).
   */
  async function ensureProjector(fix = false) {
    if (!S.camera || link.state !== 'ok') return;
    const name = S.camera;
    if (shotsOnly()) { if (S.projector.state !== 'skipped') log(embedded && !windowCapture ? 'the camera is read the slower way here (pictures from OBS): no camera window is opened' : 'Chrome here cannot take the camera window by itself: the slower way, no camera window'); S.projector = { state: 'skipped', title: '', hwnd: 0, ours: false }; return; }
    let list = await W.listWindows();
    const old = record.projector;
    if (old && old.camera !== name) { await W.closeWindow(old.hwnd, old.title); record.projector = null; list = await W.listWindows(); }
    let w = record.projector ? list.find((x) => x.hwnd === record.projector.hwnd && x.title === record.projector.title) : null;
    let ours = !!w, opened = false;
    if (!w) { record.projector = null; w = list.find((x) => projectorMatch(x.title, name)) || null; }
    if (!w && S.projectorShown && !S.projectorAllowed) {
      // it was open this run and is gone now (closed, or OBS was restarted): opening it again would pop it up over his
      // other windows (TikTok LIVE Studio) mid-show. The page reads the camera the slower way instead.
      if (S.projector.state !== 'gone') log('the camera window is gone: the slower way from now on (no window pops up mid-show)');
      S.projector = { state: 'gone', title: '', hwnd: 0, ours: false };
      return;
    }
    if (!w) {
      const before = new Set(list.map((x) => x.hwnd));
      try { await link.call('OpenSourceProjector', { sourceName: name, monitorIndex: -1 }); }
      catch (e) { failProjector('OBS did not open the camera window: ' + e.message); return; }
      for (let i = 0; i < 20 && !w; i++) { await sleep(300); list = await W.listWindows(); w = list.find((x) => !before.has(x.hwnd) && x.title.includes(name)) || null; }
      if (!w) { failProjector('the camera window did not appear'); return; }
      ours = opened = true;
      record.projector = { hwnd: w.hwnd, title: w.title, camera: name };
      log('camera window opened: "' + w.title + '"');
    }
    if (ours && (opened || fix || w.minimised)) {
      // inside: the picture about 540 real pixels high (what the page reads; on his 4K screen at 250 % that is about
      // 420 x 220 of what he sees) and a little wider than the picture (black bars left and right help the tracker)
      const main = camera ? scene.mainPlacement(col, camera) : null;
      const shape = main && main.src.w > 0 && main.src.h > 0 ? Math.min(2.4, Math.max(0.42, main.src.w / main.src.h)) : 16 / 9;
      const high = shape >= 1 ? 540 : 760;
      await W.placeWindow(w.hwnd, w.title, Math.round(high * shape) + 96, high);
    }
    S.projector = { state: 'open', title: w.title, hwnd: w.hwnd, ours };
    S.projectorShown = true; S.projectorAllowed = false;
    record.lastTitle = w.title;
    saveRecord();
    // Chrome picks the window whose title CONTAINS the name it was started with (the first one when several do): the
    // page's Chrome was started before this window's real name was known and that name does not single it out: again.
    const needle = S.chromeNeedle;
    const others = needle ? list.filter((x) => x.hwnd !== w.hwnd && x.title.includes(needle)).length : 0;
    if (!embedded && S.chrome && !S.noChild && needle !== w.title && (!w.title.includes(needle) || others)) {
      log('the camera window is named "' + w.title + '": the page restarts once to pick it up');
      await launchChrome(true);
    }
  }
  /**
   * While the page reads the camera's window, Chrome shows a small bar of its own ("http://127.0.0.1:<port> is sharing a
   * window." with Stop sharing / Hide): one more window he would have to deal with. It is hidden, as its own Hide button
   * does, and only that bar: a window of this app's own Chrome (the page window's process) naming this app's address.
   */
  let barRound = 0;
  async function hideSharingBar() {
    if (!W.hideWindow || embedded) return;               // inside LIVE Link there is no Chrome and no sharing bar
    const round = ++barRound;
    for (const wait of [700, 800, 1500, 3000, 6000, 18000]) {   // looks at about 0.7, 1.5, 3, 6, 12 and 30 s
      await sleep(wait);
      if (round !== barRound || S.stopping) return;
      const list = await W.listWindows();
      const pageWin = list.find((x) => x.title === PAGE_TITLE && (!S.chrome || x.pid === S.chrome.pid)) || list.find((x) => x.title === PAGE_TITLE);
      if (!pageWin) continue;
      for (const x of list) {                              // the list holds visible windows only: a hidden bar is not in it
        if (x.pid !== pageWin.pid || x.hwnd === pageWin.hwnd || !x.title.includes('127.0.0.1:' + port)) continue;
        if (await W.hideWindow(x.hwnd, x.title)) { log('hid the sharing bar of Chrome (' + x.hwnd + (x.hwnd === S.barHidden ? ', again' : '') + '): "' + x.title + '"'); S.barHidden = x.hwnd; }
      }
    }
  }
  /** Is the camera's window the one the page's Chrome will pick up? (Then the page may ask for it: never a picker.) */
  function windowReady() {
    const p = S.projector;
    if (embedded) return p.state === 'open' && windowCapture && Date.now() >= S.restartUntil;   // LIVE Link hands the page exactly this window
    return p.state === 'open' && !S.noChild && !!S.chrome && !!S.chromeNeedle && p.title.includes(S.chromeNeedle) && Date.now() >= S.restartUntil;
  }
  async function closeProjector() {
    const p = record.projector;
    if (!p) return;
    await W.closeWindow(p.hwnd, p.title);
    record.projector = null;
    S.projector = { state: 'none', title: '', hwnd: 0, ours: false };
    saveRecord();
  }

  // ---------------------------------------------------------------- the page's own Chrome window
  function seedProfile() {
    // the microphone is allowed for this page in this profile, so no question pops up (the profile is the app's own)
    const file = path.join(profileDir, 'Default', 'Preferences');
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prefs = {}; }
    const p = (prefs.profile = prefs.profile || {}), cs = (p.content_settings = p.content_settings || {}), ex = (cs.exceptions = cs.exceptions || {});
    const mic = (ex.media_stream_mic = ex.media_stream_mic || {});
    const key = base + ',*';
    if (mic[key] && mic[key].setting === 1 && prefs.credentials_enable_service === false && p.password_manager_enabled === false) return;
    mic[key] = { setting: 1 };
    prefs.credentials_enable_service = false; p.password_manager_enabled = false;   // no "Save password?" after the paste box
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(prefs)); } catch (e) { log('could not prepare the profile: ' + e.message); }
  }
  /**
   * End the app's OWN Chrome now (the process this app started on its own profile, and what it started), without waiting
   * for it: its window is gone but the process lingers (seen: 5 - 30 s), and meanwhile the app would neither end nor open
   * a new window. Never any other Chrome.
   */
  async function endOwnChrome(why) {
    const c = S.chrome;
    if (!c || !c.pid) return false;
    S.chrome = null;
    log('ending the page\'s own Chrome (pid ' + c.pid + '): ' + why);
    await run('taskkill', ['/PID', String(c.pid), '/T', '/F'], 6000);
    try { c.kill(); } catch { /* gone */ }
    return true;
  }
  /** is the page's window still on screen? (a page that hangs for a moment is not a closed one) */
  async function pageWindowThere() {
    try { const list = await W.listWindows(); return list.some((x) => x.title === PAGE_TITLE); } catch { return false; }
  }
  async function launchChrome(again = false) {
    if (noChrome || S.stopping) return;
    if (S.chrome && again) {
      // the page comes back by itself in a few seconds and takes over the ON / OFF the server keeps: no OFF meanwhile
      S.restartUntil = Date.now() + 20000; S.restartAt = Date.now();
      const old = S.chrome; S.chrome = null;
      try { old.kill(); } catch { /* gone */ }
      await sleep(1200);
    }
    // the control deck's size: 1366 x 768, never bigger than the primary screen's work area, never under 1000 x 640
    const size = windowSizeFor(await Promise.race([workArea, sleep(3000).then(() => null)]));
    if (S.chrome) return;
    const pretend = opts.chromeCmd || null;              // tests only
    const exe = pretend ? pretend[0] : findChrome();
    const url = base + '/vtuber.html';
    if (!exe) {                                          // no Chrome or Edge: the default browser (it will ask for the microphone once)
      log('Chrome not found: opening the default browser');
      S.noChild = true;
      try { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref(); } catch { /* nothing to open it with */ }
      return;
    }
    seedProfile();
    // (a test run never starts its Chrome with the general name: that would pick ANY OBS camera window on this PC)
    const needle = S.projector.title || record.lastTitle || (test ? 'VTuber test: no camera window yet' : GENERIC_NEEDLE);
    const args = [
      '--user-data-dir=' + profileDir, '--app=' + url, '--window-size=' + size.w + ',' + size.h, '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion', '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=GetDisplayMediaRequiresUserActivation', '--disable-background-networking', '--disable-component-update',
      ...(test && process.env.VTUBER_TEST_NO_AUTOSELECT === '1' ? [] : ['--auto-select-desktop-capture-source=' + needle]), ...chromeArgs,
    ];
    const proc = spawn(exe, pretend ? [...pretend.slice(1), ...args] : args, { stdio: 'ignore', windowsHide: false });
    S.chrome = proc; S.chromeNeedle = needle; S.chromeStartedAt = Date.now(); S.chromeExitedAt = 0;
    proc.on('error', () => { if (S.chrome === proc) { S.chrome = null; S.noChild = true; } });
    S.launches = (S.launches || 0) + 1;
    proc.on('exit', () => {
      if (S.chrome !== proc) return;
      S.chrome = null;
      // Chrome handed the page to a copy of itself that was already running with this profile: there is no child to watch
      if (Date.now() - S.chromeStartedAt < 5000) S.noChild = true; else S.chromeExitedAt = Date.now();
    });
    log('page window started');
  }
  async function bringToFront() {
    if (embedded) { host({ t: 'front' }); return true; }   // the page is LIVE Link's window: LIVE Link raises it
    const list = await W.listWindows();
    const w = list.find((x) => x.title === PAGE_TITLE && (!S.chrome || x.pid === S.chrome.pid)) || list.find((x) => x.title === PAGE_TITLE);
    if (w) { await W.frontWindow(w.hwnd, w.title); return true; }
    if (!S.chrome) { S.noChild = !!noChrome; await launchChrome(); return true; }
    // its window was just closed and its Chrome is still ending: that Chrome is ended now and a new window opens at once
    S.goneAt = 0; S.chromeExitedAt = 0;
    await endOwnChrome('a new window is wanted while the old one is still ending');
    await sleep(300);
    S.noChild = !!noChrome;
    await launchChrome();
    return true;
  }

  // ---------------------------------------------------------------- the page's requests
  /** Chrome showed its share list instead of taking the window by itself (this run, or before with this Chrome version) */
  function shotsOnly() { return (embedded && !windowCapture) || S.noWindowRun || Date.now() < S.noWindowUntil || (!!record.noWindowFor && record.noWindowFor === (S.pageMajor || S.chromeMajor)); }
  const WINDOW_RETRY_MS = opts.windowRetryMs || 60000;
  /** a window capture started well: whatever was counted against the window path is forgotten (B2) */
  function goodWindowStart() {
    S.windowTimeouts = 0;
    if (record.pickerSeen || record.noWindowFor) { delete record.pickerSeen; delete record.noWindowFor; saveRecord(); log('the camera window is read directly again: earlier share-list counts cleared'); }
  }
  // ---------------------------------------------------------------- B3: the numbers of a show, in the log
  // The page sends what its reader measured with every pulse (numbers only: no names, no picture, no face data):
  // updates a second, body checks a second, the share of body checks that saw a hand, OBS's answer time, the load step.
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  function takeRates(text) {
    const p = String(text || '').split(',');
    if (p.length < 6) return;
    const r = { upd: num(p[0], 0, 240), body: num(p[1], 0, 240), hand: num(p[2], -1, 100), rpc: num(p[3], 0, 60000), shed: num(p[4], 0, 9), pic: num(p[5], 0, 240) };
    if (r.upd === null || r.body === null) return;
    if (!S.on) { S.rates = null; S.ratesAt = 0; S.ratesShed = r.shed || 0; return; }   // only a show is measured
    const now = Date.now(), R = S.rates || (S.rates = { n: 0, upd: 0, updMin: 1e9, body: 0, bodyMin: 1e9, handN: 0, hand: 0, rpc: 0, rpcN: 0, rpcMax: 0, pic: 0, shed: 0 });
    R.n++; R.upd += r.upd; R.updMin = Math.min(R.updMin, r.upd); R.body += r.body; R.bodyMin = Math.min(R.bodyMin, r.body); R.pic += r.pic || 0; R.shed = Math.max(R.shed, r.shed || 0);
    if (r.hand !== null && r.hand >= 0) { R.handN++; R.hand += r.hand; }
    if (r.rpc !== null && r.rpc > 0) { R.rpcN++; R.rpc += r.rpc; R.rpcMax = Math.max(R.rpcMax, r.rpc); }
    if (!S.ratesAt) S.ratesAt = now;
    // at once (at most every 20 s): the body checks fell under 10 a second, or the load ladder stepped
    const shed = r.shed || 0;
    if (S.on && r.pic >= 12 && ((r.body < 10 && now - S.ratesWarnAt > 20000) || shed !== S.ratesShed)) {
      S.ratesWarnAt = now;
      log('rates now: updates/s ' + r.upd.toFixed(1) + ', body checks/s ' + r.body.toFixed(1) + ', load step ' + shed + (shed !== S.ratesShed ? ' (was ' + S.ratesShed + ')' : '') + ', path ' + capPath());
    }
    S.ratesShed = shed;
  }
  const capPath = () => (String(S.capKey || '').startsWith('window|') ? 'window' : String(S.capKey || '').startsWith('shots|') ? 'slower' : 'none');
  function logRates(now) {
    const R = S.rates;
    if (!R || !R.n || now - S.ratesAt < (opts.ratesMs || 60000)) return;
    if (S.on) {
      log('rates (' + Math.round((now - S.ratesAt) / 1000) + ' s, ' + R.n + ' readings): updates/s ' + (R.upd / R.n).toFixed(1) + ' (lowest ' + R.updMin.toFixed(1) + '), body checks/s ' + (R.body / R.n).toFixed(1) +
        ' (lowest ' + R.bodyMin.toFixed(1) + '), hand seen ' + (R.handN ? Math.round(R.hand / R.handN) + ' % of body checks' : 'not measured') +
        ', OBS answer ' + (R.rpcN ? Math.round(R.rpc / R.rpcN) + ' ms (longest ' + Math.round(R.rpcMax) + ')' : 'not used') + ', pictures/s ' + (R.pic / R.n).toFixed(1) + ', load step ' + R.shed + ', path ' + capPath());
    }
    S.rates = null; S.ratesAt = now;
  }
  function publicState() {
    const p = S.projector.state;
    return {
      obs: S.obs, camera: S.camera, cameraWhy: S.cameraWhy, cameras: S.cameras, view: S.view, onAirOther: S.onAirOther,
      // window: the page may ask Chrome for the camera's window (it is there and Chrome will pick exactly it);
      // shots: the slower way (OBS could not open the window, or this page's Chrome is not one this app started);
      // none: wait (no camera yet, or the page's Chrome is about to restart with the window's real name)
      // the Mask: where its music comes from ('pc' | 'obs' | 'voice' | 'none'), the stamps of its gift list and of the
      // saved resting face (the page passes them on; a change = the avatar page reads the file again), LIVE Link seen
      mask: { sound: sound.state(), gifts: S.giftsRev, rest: S.restRev, liveLink: !!S.eventsSeenAt && Date.now() - S.eventsSeenAt < 120000 },
      capture: {
        mode: p === 'failed' || p === 'gone' || p === 'skipped' || shotsOnly() || (p === 'open' && S.noChild && !embedded) ? 'shots' : windowReady() ? 'window' : 'none',
        title: S.projector.title, hwnd: S.projector.hwnd,
      },
      avatar: { ...S.avatar, silent: S.avatarSilent }, on: S.on, shotsPort: port,
      ...(embedded ? { embedded: true } : {}),          // the page words three sentences for LIVE Link (no VTuber.bat there)
    };
  }
  function readBody(req, max = 16384) {
    return new Promise((resolve) => {
      const parts = []; let size = 0;
      req.on('data', (d) => { size += d.length; if (size <= max) parts.push(d); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }
  function api(req, res) {
    const [pathname, query = ''] = (req.url || '').split('?');
    if (pathname === '/api/tiktok-event') { tiktokApi(req, res); return true; }
    if (!pathname.startsWith('/api/vt/')) return false;
    const what = pathname.slice(8);
    const send = (code, obj, type) => {
      const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Cache-Control': 'no-store', 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    const site = req.headers['sec-fetch-site'];
    if (!serverJs.originAllowed(req.headers.origin) || (site && site !== 'same-origin' && site !== 'none')) { req.resume(); send(403, { error: 'forbidden' }); return true; }
    if (req.method === 'GET') {
      if (what === 'state') {
        if (/(^|&)hb=1(&|$)/.test(query)) { seen(); S.pageMajor = uaMajor(req.headers['user-agent']) || S.pageMajor; const cap = new URLSearchParams(query).get('cap'); const qs = new URLSearchParams(query); if (cap !== null && cap !== S.capKey) { S.capKey = cap; S.goodKey = ''; if (cap.startsWith('window|')) hideSharingBar(); } if (qs.get('ok') === '1' && S.capKey && S.capKey.startsWith('window|') && S.goodKey !== S.capKey) { S.goodKey = S.capKey; goodWindowStart(); } const rates = qs.get('r'); if (rates) takeRates(rates); }
        send(200, publicState());
      } else if (what === 'front') {
        if (stopCalled) send(503, { stopping: true });     // ending: the next VTuber.bat waits for this one to finish
        else bringToFront().then((ok) => send(200, { ok }));
      }
      else if (what === 'shot') {
        const name = new URLSearchParams(query).get('name') || '';
        if (link.state !== 'ok' || !S.cameras.some((c) => c.name === name)) { send(404, { error: 'no picture' }); return true; }
        link.call('GetSourceScreenshot', { sourceName: name, imageFormat: 'jpg', imageWidth: 240, imageCompressionQuality: 60 }).then((r) => {
          send(200, Buffer.from(String(r.imageData || '').split(',')[1] || '', 'base64'), 'image/jpeg');
        }, () => send(404, { error: 'no picture' }));
      } else if (what === 'gifts') send(200, { ...readGifts(), effects: Wire.EFFECTS });
      else if (what === 'mask-rest') {
        let n = null;
        try { n = JSON.parse(fs.readFileSync(restFile, 'utf8')); } catch { n = null; }
        send(200, n && typeof n === 'object' && Array.isArray(n.lm) ? n : null);
      } else send(404, { error: 'unknown' });
      return true;
    }
    if (req.method !== 'POST') { req.resume(); send(405, { error: 'method' }); return true; }
    readBody(req, what === 'mask-rest' ? 262144 : 16384).then(async (body) => {
      try {
        if (what === 'try') {                              // "Try the effects": the same road a real viewer's event takes
          const ev = Wire.cleanEvent(Wire.TRY_EVENTS[body.kind]);
          send(200, { ok: !!ev && fireEvent(ev), on: S.on });
        } else if (what === 'gifts') {                     // his gift list: saved as his own copy (reset: back to the defaults)
          if (body.reset === true) { try { fs.unlinkSync(giftsOwner); } catch { /* there was none */ } }
          else {
            const rows = Wire.cleanGiftRows(body.rows);
            if (!rows) { send(400, { error: 'not a gift list' }); return; }
            fs.mkdirSync(path.dirname(giftsOwner), { recursive: true });
            fs.writeFileSync(giftsOwner + '.tmp', JSON.stringify({ rows }, null, 1)); fs.renameSync(giftsOwner + '.tmp', giftsOwner);
          }
          S.giftsRev = Math.max(S.giftsRev + 1, stampOf(giftsOwner) || Date.now());
          send(200, { ...readGifts(), rev: S.giftsRev });
        } else if (what === 'mask-rest') {                 // his resting face for the Mask (made by the page from the two calm seconds)
          const n = body && body.neutral;
          if (!n || typeof n !== 'object' || !Array.isArray(n.lm) || n.lm.length !== 1434 || !n.lm.every((v) => typeof v === 'number' && Number.isFinite(v))) { send(400, { error: 'not a resting face' }); return; }
          fs.mkdirSync(path.dirname(restFile), { recursive: true });
          fs.writeFileSync(restFile + '.tmp', JSON.stringify(n)); fs.renameSync(restFile + '.tmp', restFile);
          S.restRev = Math.max(S.restRev + 1, stampOf(restFile) || Date.now());
          log("the Mask's resting face saved");
          send(200, { ok: true, rev: S.restRev });
        } else if (what === 'bye') { S.pageSeenAt = 0; S.goneAt = Date.now(); await forceOff('the page closed'); send(200, { ok: true }); }
        else if (what === 'password') { link.setPassword(typeof body.password === 'string' ? body.password : ''); send(200, { ok: true }); }
        else if (what === 'camera') {
          record.camera = typeof body.name === 'string' && body.name ? body.name : null;
          record.cameraWhy = 'chosen';
          S.projectorAllowed = true;                       // he is at this window, picking: the new camera's window may open
          saveRecord();
          await queue(() => refresh('camera chosen'));
          send(200, publicState());
        } else if (what === 'remove') {
          await forceOff('removed from OBS');
          await queue(async () => {
            if (link.state !== 'ok') throw new Error('OBS is not connected');
            await scene.removeAvatar(link, record.items);
            record.items = []; record.input = null; saveRecord();
            S.avatar = { placed: 0, scenes: [], problem: null, removed: true };
            log('avatar taken out of OBS');
          });
          send(200, publicState());
        } else if (what === 'add') {
          S.avatar.removed = false;
          await queue(() => refresh('put back'));
          send(200, publicState());
        } else if (what === 'picker') {
          // B2. The page asked for the camera window and it has not come. Two different things, told apart here:
          //  - Chrome's share list is really on screen (a window of the page's own Chrome that is neither the page nor
          //    the sharing bar): it is closed, the slower way for this run, and it COUNTS (seen on two starts with no
          //    good start between them = the slower way on the next starts too, while this Chrome version stays);
          //  - nothing of the kind is on screen: the PC was slow. That is never counted. { probe: true } (the page is
          //    still waiting, up to 15 s) changes nothing; the page giving up = the slower way for a minute, then the
          //    window is tried once more while the slower way keeps running; late again = the slower way for this run.
          const major = uaMajor(req.headers['user-agent']) || S.chromeMajor;
          let closed = 0;
          if (!embedded) try {                             // (inside LIVE Link no share list exists, and the page's process owns LIVE Link's own windows: nothing is ever closed)
            const wins = await W.listWindows();
            const pageWin = wins.find((x) => x.title === PAGE_TITLE && (!S.chrome || x.pid === S.chrome.pid));
            for (const x of wins) if (pageWin && x.pid === pageWin.pid && x.hwnd !== pageWin.hwnd && !x.title.includes(' is sharing ')) { await W.closeWindow(x.hwnd, x.title); closed++; }
          } catch { /* the page reloads anyway */ }
          if (closed) {
            S.noWindowRun = true; S.restartUntil = Date.now() + 15000; S.restartAt = Date.now();
            record.pickerSeen = (record.pickerSeen || 0) + 1;
            if (major && record.pickerSeen >= 2) record.noWindowFor = major;
            saveRecord();
            log('Chrome showed its share list (' + closed + ' window(s) closed): the slower way' + (record.noWindowFor === major ? ' from now on with Chrome ' + major : ' for this run') + ' [seen ' + record.pickerSeen + ' time(s)]');
          } else if (body.probe !== true) {
            S.restartUntil = Date.now() + 15000; S.restartAt = Date.now();
            S.windowTimeouts++;
            if (S.windowTimeouts >= 2 || body.retry === true) { S.noWindowRun = true; log('the camera window came too late again (no share list on screen): the slower way for this run. Nothing is counted for the next start.'); }
            else { S.noWindowUntil = Date.now() + WINDOW_RETRY_MS; log('the camera window came too late (no share list on screen): the slower way for now, the window is tried again in ' + Math.round(WINDOW_RETRY_MS / 1000) + ' s. Nothing is counted.'); }
          }
          send(200, { ...publicState(), closed });
        } else if (what === 'picture') {                  // the page says the camera window gives no picture: look after it
          await queue(() => ensureProjector(true));
          send(200, publicState());
        } else send(404, { error: 'unknown' });
      } catch (e) { send(500, { error: 'failed' }); log(what + ' failed: ' + (e && e.message)); }
    });
    return true;
  }
  /** a sign of life from the page (its pulse, or its tracker / microphone talking over the relay) */
  function seen() { const now = Date.now(); S.pageSeenAt = now; S.pageEver = true; if (now - S.restartAt > 1500) S.restartUntil = 0; }
  /** the avatar page in OBS said something (hello / ack): it is alive */
  function lifeSeen() {
    S.lifeAt = Date.now();
    if (S.watch.stage) log('the avatar page in OBS answers again');
    S.watch.stage = 0; S.avatarSilent = false;
  }
  // every relayed `avatar` message from this run's page window decides ON / OFF in OBS
  function onRelay(msg, who) {
    if (who && who.kind === 'avatar') { lifeSeen(); return; }
    if (msg.t === 'perf' || msg.t === 'mic') { seen(); return; }
    if (msg.t !== 'avatar') return;
    S.lastAvatar = msg;
    setMask(msg.mask === true || (typeof msg.shuffle === 'string' && msg.shuffle !== ''));   // V7: shuffle to the beat on Ryo / Melanie needs the music too
    const on = msg.on === true;
    if (on !== S.on) queue(() => applyOn(on));
  }

  // The fallback picture path: the tracker asks for camera pictures one by one. It talks to THIS server (no password);
  // the server passes on only the few read-only requests that path needs. The OBS password never reaches a page.
  const shotServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  shotServer.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.0.0', rpcVersion: 1 } }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const d = msg.d || {};
      if (msg.op === 1) { ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return; }
      if (msg.op !== 6) return;
      const answer = (ok, data, code, comment) => {
        if (ws.readyState !== 1) return;
        const out = { requestType: d.requestType, requestId: d.requestId, requestStatus: ok ? { result: true, code: 100 } : { result: false, code, comment } };
        if (ok) out.responseData = data;
        ws.send(JSON.stringify({ op: 7, d: out }));
      };
      if (!SHOT_REQUESTS.has(d.requestType)) { answer(false, null, 204, 'not passed on'); return; }
      link.call(d.requestType, d.requestData || {}).then((r) => answer(true, r), (e) => answer(false, null, typeof e.code === 'number' ? e.code : 207, e.message));
    });
    ws.on('error', () => {});
  });
  const upgrade = (req, socket, head) => {
    if ((req.url || '/').split('?')[0] !== '/') return false;
    if (!ownPage(req)) { socket.destroy(); return true; }   // camera pictures only for this run's own page window
    shotServer.handleUpgrade(req, socket, head, (ws) => shotServer.emit('connection', ws, req));
    return true;
  };

  app = await serverJs.start(port, { api, onRelay, upgrade, accept, headers, ...(test && typeof opts.picFetch === 'function' ? { picFetch: opts.picFetch } : {}), ...(dataDir ? { calibFile: path.join(dataDir, 'calib-saved.json') } : {}), signDir, ...(embedded ? { ownOriginOnly: true, onMissing: (p) => log('a file the page asked for is not there: ' + p) } : {}) });
  if (!embedded) S.chromeMajor = chromeMajor(findChrome() || '');
  log('started on ' + base + (obsUrl ? ' (test OBS)' : ''));
  // Inside LIVE Link: the parent hears "ready" NOW, the moment the page can be served. What follows (finding OBS, adding
  // the avatar, opening the camera's window: on a slow PC the window listings alone can take minutes) is reported on its
  // own through `state` and `camera-window`, so a slow first start is never taken for a dead one and ended half way.
  if (embedded) host({ t: 'ready', port, test, wire: 2 });      // (wire 2: this VTuber takes event v2, `show` and `control`)
  if (recordMigrated) { log(recordMigrated); saveRecord(); }

  link.on('state', (state) => {
    S.obs = state;
    log('OBS: ' + state);
    if (state === 'ok') { queue(() => refresh('connected')); if (S.mask) meterInputs(); }
    else { S.projector = { state: 'none', title: '', hwnd: 0, ours: false }; }
  });
  link.start();

  // ---------------------------------------------------------------- the clock: scene changes, the page's pulse, stopping
  let done;
  const finished = new Promise((r) => { done = r; });
  let lastProgramCheck = 0;
  const watchMs = opts.watchMs || WATCH_MS;
  /**
   * The avatar is ON and its scene is on air, but the avatar page in OBS says nothing (it never loaded, or it died): press
   * the source's own "Refresh" button, then give it a new address, then tell him in one sentence. Any word from it ends this.
   */
  function watchAvatar(now) {
    const w = S.watch;
    const shown = S.on && link.state === 'ok' && !!record.input && !S.avatar.removed && record.items.some((i) => i.scene === S.program);
    if (!shown) { w.from = 0; w.stage = 0; S.avatarSilent = false; return; }
    if (!w.from) w.from = now;
    if (w.stage >= 3 || now - Math.max(S.lifeAt, w.from) <= watchMs[w.stage]) return;
    const stage = w.stage++;
    w.from = now;
    if (stage === 0) {
      log('the avatar page in OBS gives no answer: pressing its Refresh');
      link.call('PressInputPropertiesButton', { inputName: record.input, propertyName: 'refreshnocache' }).catch((e) => log('Refresh failed: ' + e.message));
    } else if (stage === 1) {
      stamp = newStamp();
      log('the avatar page in OBS still gives no answer: a new address for it');
      queue(() => refresh('the avatar page gave no answer'));
    } else { S.avatarSilent = true; log('the avatar page in OBS gives no answer: the page says so'); }
  }
  let toldWindow = '', toldState = '';
  /** the card's state inside LIVE Link: plain codes only (no names of viewers, no password, no picture) */
  function hostState() {
    const a = S.lastAvatar || {};
    return {
      on: S.on, obs: S.obs, camera: S.camera, cameraAsk: S.cameraWhy === 'ask', cameraKind: (S.cameras.find((c) => c.name === S.camera) || {}).kind || null,
      character: a.mask === true ? 'mask' : typeof a.character === 'string' ? a.character.slice(0, 24) : null,
      avatar: { placed: S.avatar.placed, problem: S.avatar.problem, removed: !!S.avatar.removed, silent: !!S.avatarSilent },
      capture: publicState().capture.mode, sound: sound.state().src, page: !!S.pageSeenAt, pageEver: S.pageEver,
      // V8: is the Puppet show switched on (the Mask picked, its master switch on)? LIVE Link gives its global keys back when it is not
      puppet: puppetOn(a),
    };
  }
  function tellHost() {
    if (!opts.onHost) return;
    const p = S.projector, w = p.state === 'open' && p.hwnd ? p.hwnd + '|' + p.title : '';
    if (w !== toldWindow) { toldWindow = w; host(w ? { t: 'camera-window', hwnd: p.hwnd, title: p.title } : { t: 'camera-window', none: true }); }
    const st = hostState(), key = JSON.stringify(st);
    if (key !== toldState) { toldState = key; host({ t: 'state', ...st }); }
  }
  const clock = setInterval(() => {
    const now = Date.now();
    if (S.stopping) return;
    tellHost();
    watchAvatar(now);
    logRates(now);
    // the minute on the slower way is over: the camera window is looked for again (the page then tries it once more)
    const slower = shotsOnly();
    if (S.wasSlower && !slower && link.state === 'ok') { log('trying the camera window again'); queue(() => ensureProjector()); }
    S.wasSlower = slower;
    if (S.pageEver && S.pageSeenAt && now - S.pageSeenAt > PAGE_GONE_MS && now >= S.restartUntil) { S.pageSeenAt = 0; forceOff('no sign of the page for ' + PAGE_GONE_MS + ' ms'); S.goneAt = now; }
    if (S.pageSeenAt) S.goneAt = 0;
    if (link.state === 'ok' && now - lastProgramCheck >= 2000) {
      lastProgramCheck = now;
      link.call('GetCurrentProgramScene').then((r) => { const n = r.currentProgramSceneName || r.sceneName; if (n && n !== S.program && col) queue(() => refresh('scene on air changed')); }, () => {});
    }
    if (stay) return;
    // the page has been gone 4 s, its window is no longer on screen, but its Chrome has not ended: end it (its own, never
    // another), so the app ends now and the next double-click opens a window at once
    if (S.pageEver && !S.pageSeenAt && S.goneAt && now - S.goneAt > 4000 && now >= S.restartUntil && S.chrome && !S.noChild && !S.ending) {
      S.ending = true;
      pageWindowThere().then(async (there) => {
        if (!there && !S.pageSeenAt && S.chrome && !S.stopping) { await endOwnChrome('its window is closed and it did not end by itself'); S.chromeExitedAt = Date.now() - 1500; }
        else if (there) S.goneAt = Date.now();          // the window is there (a page that hangs): look again in 4 s
        S.ending = false;
      }, () => { S.ending = false; });
    }
    // the page is gone for good: its Chrome window was closed, or (no window of ours to watch) it stayed silent for 10 s
    const silent = S.pageSeenAt ? 0 : now - (S.goneAt || S.startedAt);
    const childGone = !S.noChild && !S.chrome && S.chromeExitedAt && now - S.chromeExitedAt > 1500;
    if (childGone && !S.pageSeenAt && S.reopen) { S.reopen = false; S.chromeExitedAt = 0; launchChrome(); return; }
    if ((childGone && !S.pageSeenAt) || (S.noChild && S.pageEver && !S.pageSeenAt && silent > 10000) || (!S.pageEver && now - S.startedAt > 120000)) stop('the page is gone');
  }, 500);

  let stopCalled = false;
  async function stop(why) {
    if (stopCalled) return finished;
    stopCalled = true;
    log('stopping: ' + why);
    clearInterval(clock);
    const closing = Promise.race([closeProjector(), sleep(4000)]).catch(() => {});
    try { await Promise.race([forceOff('stopping'), sleep(3000)]); } catch { /* ignore */ }
    S.stopping = true;
    try { await Promise.race([chain, sleep(3000)]); } catch { /* ignore */ }
    await closing;
    link.stop(); sound.stop();
    if (S.chrome) { const c = S.chrome; S.chrome = null; try { c.kill(); } catch { /* gone */ } }
    for (const c of app.wss.clients) { try { c.terminate(); } catch { /* gone */ } }
    for (const c of shotServer.clients) { try { c.terminate(); } catch { /* gone */ } }
    await new Promise((r) => { app.server.close(() => r()); if (app.server.closeAllConnections) app.server.closeAllConnections(); });
    done(why);
  }

  // OBS first when it answers at once (so the page's Chrome knows the camera window's exact name), then the page
  for (let i = 0; i < 12 && link.state !== 'ok'; i++) await sleep(250);
  if (link.state === 'ok') await chain;
  await launchChrome();
  tellHost();

  return {
    port, stop, done: finished, link, bringToFront, cookie: COOKIE + '=' + TOKEN, event: takeEvent, embedded, test, hostState, picStats: () => (app && app.pic ? app.pic.stats() : null),
    state: () => ({ ...publicState(), launches: S.launches || 0, chromePid: S.chrome ? S.chrome.pid : 0, projector: { ...S.projector }, record: JSON.parse(JSON.stringify(record)), stopping: S.stopping, stamp, avatarUrl, windowPath: { slower: shotsOnly(), run: S.noWindowRun, until: S.noWindowUntil, timeouts: S.windowTimeouts }, watch: { ...S.watch }, pageEver: S.pageEver }),
  };
}

// ---------------------------------------------------------------- the earlier VTuber's server holding the place
const run = (exe, args, ms) => new Promise((resolve) => {
  execFile(exe, args, { windowsHide: true, timeout: ms, encoding: 'utf8' }, (err, out) => resolve(err && !out ? '' : String(out || '')));
});

// ---------------------------------------------------------------- the VTuber window's size
/** the control deck's size (js/v9-deck-logic.js: its wide layout from 1000 px); LIVE Link opens its window by the same rule */
const VT_WINDOW = Object.freeze({ w: 1366, h: 768, minW: 1000, minH: 640 });
/**
 * the VTuber window: 1366 x 768, never bigger than the primary screen's work area (the screen without the taskbar), and
 * never smaller than 1000 x 640. `work` = { w, h } in Chrome's --window-size units, or null (unknown: 1366 x 768).
 */
function windowSizeFor(work) {
  const fit = (want, have, min) => (Number(have) > 0 ? Math.max(min, Math.min(want, Math.floor(Number(have)))) : want);
  return { w: fit(VT_WINDOW.w, work && work.w, VT_WINDOW.minW), h: fit(VT_WINDOW.h, work && work.h, VT_WINDOW.minH) };
}
/**
 * the primary screen's work area in device-independent pixels (what Chrome's --window-size counts, at any Windows
 * scaling: the pixels Windows reports, times 96 / the screen's dpi), or null. Read-only: it only asks Windows.
 */
async function primaryWorkArea() {
  if (process.platform !== 'win32') return null;
  const ps = 'Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
    '$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $d = $g.DpiX; $g.Dispose(); if (-not $d) { $d = 96 }; ' +
    "'' + [int][Math]::Floor($a.Width * 96 / $d) + 'x' + [int][Math]::Floor($a.Height * 96 / $d)";
  const m = /(\d+)x(\d+)/.exec(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 10000));
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? { w: Number(m[1]), h: Number(m[2]) } : null;
}
/** the process listening on 127.0.0.1:<port> (0 = none) */
async function listeningPid(port) {
  const out = await run('netstat', ['-ano', '-p', 'tcp'], 8000);
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'TCP' && (p[1] === '127.0.0.1:' + port || p[1] === '0.0.0.0:' + port) && (p[3] === 'LISTENING' || p[2] === '0.0.0.0:0')) return Number(p[4]) || 0;
  }
  return 0;
}
/** a process and its parent: name, command line (read-only, through Windows' own process list) */
async function processInfo(pid) {
  const ps = "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + Number(pid) + "'; if (-not $p) { 'null'; exit }; " +
    "$q = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); " +
    "[pscustomobject]@{ name = $p.Name; cmd = $p.CommandLine; ppid = $p.ParentProcessId; pname = $(if ($q) { $q.Name } else { '' }); pcmd = $(if ($q) { $q.CommandLine } else { '' }) } | ConvertTo-Json -Compress";
  try { return JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000)).trim() || 'null'); } catch { return null; }
}
const portFree = (port) => new Promise((res) => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); res(false); }); c.once('error', () => res(true)); });
/**
 * Is the place held by THIS folder's own earlier server (v2: start-vtuber.bat runs `node server.js` here)? Then close
 * it (its black window too) and say so in the log. Only that exact program is ever closed: node running this folder's
 * server.js, started by this folder's start-vtuber.bat (or by its full path). Returns true when the place is free now.
 */
async function closeOldServer(port, opts = {}, log = () => {}) {
  const test = port !== 8791;
  let bat = path.join(ROOT, 'start-vtuber.bat');
  const fake = opts.oldServerBat || process.env.VTUBER_OLD_BAT;
  if (test && fake) {                                  // a test's pretend start-vtuber.bat: only ever one under tmp/
    const f = path.resolve(fake);
    if (!f.toLowerCase().startsWith(path.join(ROOT, 'tmp').toLowerCase() + path.sep)) throw new Error('a pretend start-vtuber.bat must be under tmp/');
    bat = f;
  }
  const pid = await listeningPid(port);
  if (!pid) return portFree(port);
  const p = await processInfo(pid);
  if (!p || String(p.name).toLowerCase() !== 'node.exe') { log('the place ' + port + ' is held by another program (' + (p && p.name) + ', pid ' + pid + '): not touched'); return false; }
  const m = /^\s*(?:"[^"]*"|\S+)\s+(?:"([^"]+)"|(\S+))\s*$/.exec(String(p.cmd || ''));
  const script = m ? (m[1] || m[2]) : '';
  const lower = (x) => String(x || '').toLowerCase();
  const byBat = lower(p.pname) === 'cmd.exe' && lower(p.pcmd).replace(/"/g, '').includes(lower(bat));
  const ownScript = lower(script) === lower(path.join(ROOT, 'server.js')) || (lower(script) === 'server.js' && byBat);
  if (!ownScript) { log('the place ' + port + ' is held by node (pid ' + pid + ', not this folder\'s earlier server): not touched'); return false; }
  log('the earlier VTuber server (start-vtuber.bat, pid ' + pid + ') holds the place: closing it');
  if (byBat) await run('taskkill', ['/PID', String(p.ppid), '/T', '/F'], 8000);   // its black window and the server in it
  else await run('taskkill', ['/PID', String(pid), '/F'], 8000);
  for (let i = 0; i < 40; i++) { if (await portFree(port)) return true; await sleep(150); }
  return false;
}

/** Is a VTuber already running on this port? Then only bring its page to the front. */
function alreadyRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/vt/front', timeout: 8000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

/**
 * Start the app; the place taken: a VTuber that runs = its window comes to the front (null); one that is just ending =
 * wait for it; this folder's earlier server (start-vtuber.bat) = closed by itself, then start. Anything else: EADDRINUSE.
 */
async function bootOneClick(opts = {}) {
  const port = Number(opts.port || process.env.VTUBER_PORT) || 8791;
  let tookOver = false;
  for (let tries = 0; ; tries++) {
    try { return await startOneClick(opts); } catch (err) {
      if (!err || err.code !== 'EADDRINUSE') throw err;
      const code = await alreadyRunning(port);
      if (code === 200) return null;
      if ((code === 503 || code === 0) && tries < 24) { await sleep(500); continue; }
      if (!tookOver) {
        tookOver = true;
        const logFile = opts.logFile !== undefined ? opts.logFile : port !== 8791 ? path.join(ROOT, 'tmp', 'v3', 'run-' + port, 'vtuber.log') : path.join(ROOT, 'tmp', 'vtuber.log');
        const log = (t) => { try { const f = logFile; if (!f) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, new Date().toISOString() + ' ' + t + '\n'); } catch { /* no log */ } };
        if (await closeOldServer(port, opts, log)) continue;
      }
      throw err;
    }
  }
}

/** does a VTuber answer on this place? (asked the quiet way: nothing comes to the front, nothing is counted as its page) */
function vtuberAnswers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/vt/state', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 65536) body += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch { j = null; } resolve(res.statusCode === 200 && !!j && typeof j.obs === 'string' && 'capture' in j); });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
/**
 * Start the app inside LIVE Link (livelink-host.js). The place: 8791 first (the address OBS already knows); held by a
 * VTuber (the desktop shortcut's) = code 'STANDALONE', nothing is closed; held by another program = the next free one
 * of 8792 - 8795 (the avatar's address in OBS is rewritten on every start, so OBS follows); none free = code 'NO_PORT'.
 * opts.ports: tests name their own free places (never 8791).
 */
async function bootEmbedded(opts = {}) {
  const ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports.map(Number) : EMBED_PORTS;
  for (const port of ports) {
    try { return await startOneClick({ ...opts, embedded: true, port }); } catch (err) {
      if (!err || err.code !== 'EADDRINUSE') throw err;
      if (await vtuberAnswers(port)) { const e = new Error('a VTuber is already running on this PC (place ' + port + ')'); e.code = 'STANDALONE'; e.port = port; throw e; }
    }
  }
  const e = new Error('no free place for the VTuber (' + ports.join(', ') + ')'); e.code = 'NO_PORT'; throw e;
}

if (require.main === module) {
  let running = null;
  // Anything unexpected: the avatar goes OFF in OBS (his camera comes back) and the small window closes, then the app
  // ends; the next double-click starts it fresh. Without this a crash could leave the avatar covering his camera.
  const crash = (err) => {
    try { fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'tmp', 'vtuber.log'), new Date().toISOString() + ' crashed: ' + ((err && err.stack) || err) + '\n'); } catch { /* no log */ }
    const end = () => process.exit(1);
    if (!running) return end();
    Promise.race([running.stop('crashed').catch(() => {}), sleep(5000)]).then(end, end);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  bootOneClick().then((vt) => {
    if (!vt) process.exit(0);                            // it was running already: its window is in front now
    running = vt;
    const bye = (why) => vt.stop(why).then(() => process.exit(0));
    process.on('SIGINT', () => bye('stopped by hand')); process.on('SIGTERM', () => bye('stopped')); process.on('SIGHUP', () => bye('window closed'));
    vt.done.then(() => process.exit(0));
  }, async (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('VTuber could not start: another program is using its place on this PC. Restart the PC, then double-click VTuber.bat again.');
      process.exit(2);
    }
    try { fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'tmp', 'vtuber.log'), new Date().toISOString() + ' could not start: ' + (err && err.message) + '\n'); } catch { /* no log */ }
    console.error('VTuber could not start. Close this window and double-click VTuber.bat again.');
    process.exit(1);
  });
}

/**
 * The caps of the door, per second (the contract with LIVE Link): 20 gifts, 10 other viewer events, and (V8 fix round S2)
 * 6 show-state / key messages in a bucket of their own, so a busy room can never push out a key press or the show state.
 * -> rateOk(type, nowMs = Date.now())
 */
/** the Puppet show is on: the Mask is the picked character and the window's `v8` switches are there with `on` not false */
function puppetOn(avatarMsg) { const a = avatarMsg || {}; return a.mask === true && !!a.v8 && typeof a.v8 === 'object' && a.v8.on !== false; }
function createRate() {
  const n = { sec: 0, gift: 0, other: 0, show: 0 };
  return (type, nowMs = Date.now()) => {
    const sec = Math.floor(nowMs / 1000);
    if (sec !== n.sec) { n.sec = sec; n.gift = 0; n.other = 0; n.show = 0; }
    if (type === 'gift') return ++n.gift <= 20;
    if (type === 'show' || type === 'control') return ++n.show <= 6;
    return ++n.other <= 10;
  };
}

module.exports = { createRate, puppetOn, startOneClick, bootOneClick, bootEmbedded, vtuberAnswers, closeOldServer, findChrome, chromeMajor, EMBED_PORTS, VT_WINDOW, windowSizeFor, primaryWorkArea };
