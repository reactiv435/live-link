'use strict';
// ReactivVibe LIVE Link: Electron main process. Owns the TikTok link, the site client, the tray and one window.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, safeStorage, nativeImage, Notification, powerMonitor, dialog, globalShortcut, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { TikTokLink } = require('./core/tiktok-link');
const { LiveLinkApi } = require('./core/api');
const { Controller } = require('./core/controller');
const { Store } = require('./core/store');
const { ShowManager } = require('./core/show-manager');
const { Updater } = require('./core/updater');
const { TikTokSignIn, USER_AGENT: CHROME_UA, LOGIN_URL, SESSION_COOKIES, SIGNIN_HOSTS } = require('./core/tiktok-signin');
const { pickCaptureSource, extFor, CHUNK_MS } = require('./core/capture');
const SITE = require('./site-config.json');

// The bundled ffmpeg (records the LIVE, cuts the review clips) and the clip font. Packaged: resources/ffmpeg/<os>-<cpu>/
// and resources/fonts/. Development: the ffmpeg-static package, or FFMPEG=<path>.
function ffmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', `${process.platform}-${process.arch}`, exe);
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try { return require('ffmpeg-static'); } catch { return null; }
}
function fontPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'fonts', 'ChakraPetch-Bold.ttf') : path.join(__dirname, '..', 'assets', 'fonts', 'ChakraPetch-Bold.ttf');
}

const APP_ID = 'ai.reactivvibe.livelink';
const VERSION = app.getVersion();
const IS_MAC = process.platform === 'darwin';
// Windows passes --hidden from the login item; a Mac login item can't carry args, so macOS is asked once the app is
// ready (getLoginItemSettings isn't reliable before that).
let START_HIDDEN = process.argv.includes('--hidden');
const API_BASE = process.env.LIVE_LINK_API || SITE.apiBase;      // LIVE_LINK_API = the local mock for testing

// A second copy must stop HERE: if it ran on, its startup token refresh would rotate the device token and
// knock the running copy offline mid-show. app.quit() is asynchronous, so exit and return.
if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
app.setAppUserModelId(APP_ID);

// ---------------------------------------------------------------- logging (userData/logs/live-link.log, ~1 MB)
let logFile = null;
function log(level, msg) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  try {
    if (!logFile) { const dir = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(dir, { recursive: true }); logFile = path.join(dir, 'live-link.log'); }
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch {}
}
process.on('uncaughtException', (e) => log('error', `uncaught: ${e && e.stack || e}`));
process.on('unhandledRejection', (e) => log('error', `unhandled: ${e && e.stack || e}`));

let win = null, tray = null, ctl = null, store = null, show = null;
let trayKind = '';

// Pop-ups: connected to the LIVE, lost it for more than 20 s, and the end-of-LIVE summary.
function notify(title, body, onClick) {
  if (!store || store.get('notify') === false || !Notification.isSupported()) return;
  // silent: a hosting PC is usually capturing its own audio into the stream
  try { const n = new Notification({ title, body, icon: iconPath('icon.png'), silent: true }); if (onClick) n.on('click', onClick); n.show(); } catch {}
}

// "Clip that" hotkey: held only while a recording runs, so the key isn't taken from other apps the rest of the time.
// No pop-up or sound when pressed (the PC may be capturing its screen and audio into the stream): the taskbar flashes.
const MOMENT_KEYS = { F8: 'F8', F9: 'F9', F10: 'F10', 'Ctrl+Shift+M': 'CommandOrControl+Shift+M', off: null };
let momentKeyHeld = null, momentKeyOk = true;
function momentKey() { const k = store && store.get('momentKey'); return Object.prototype.hasOwnProperty.call(MOMENT_KEYS, k) ? k : 'F8'; }
function syncMomentKey(recording) {
  const want = recording ? MOMENT_KEYS[momentKey()] : null;
  if (momentKeyHeld === want) return;
  if (momentKeyHeld) { try { globalShortcut.unregister(momentKeyHeld); } catch {} momentKeyHeld = null; }
  momentKeyOk = true;
  if (!want) return;
  try { momentKeyOk = globalShortcut.register(want, () => markMoment('hotkey')); } catch { momentKeyOk = false; }
  if (momentKeyOk) momentKeyHeld = want;
  else log('warn', `"Clip that" hotkey ${momentKey()} is taken by another app`);
}
function markMoment(by) {
  const r = show ? show.markMoment(by) : { ok: false };
  if (r.ok && win && !win.isDestroyed()) {
    win.flashFrame(true);
    setTimeout(() => { if (win && !win.isDestroyed()) win.flashFrame(false); }, 1500);
  }
  return r;
}
const showState = () => ({ ...show.getState(), momentKey: momentKey(), momentKeyOk });
const fmtDur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
let prevConnected = false, dropTimer = null, dropNotified = false, lastLostAt = -Infinity;
// A real drop: TikTok is being re-tried. Stopping on purpose (idle) or the LIVE ending (offline) is not a drop.
const DROP_STATES = ['reconnecting', 'connecting', 'error'];
// A flaky connection must not bury the host in pop-ups: one "Lost your LIVE" per 5 minutes.
const LOST_POPUP_GAP_MS = 5 * 60000;
let pendingEnd = null;   // { timer, show } while an end-of-LIVE pop-up waits for its last pushes to land
function flushPendingEnd() { if (pendingEnd) { clearTimeout(pendingEnd.timer); const p = pendingEnd; pendingEnd = null; p.show(); } }
// Pop-ups follow the TikTok connection (s.connected), not the atom's colour: a gold "hold" atom is still connected.
function watchConnection(s) {
  const on = !!s.connected;
  if (on && !prevConnected) {
    flushPendingEnd();                                                      // the old LIVE's summary comes first
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }          // a quick blip: stay quiet
    else if (dropNotified === 'shown') notify('Reconnected to your LIVE', `LIVE Link is reading @${s.tiktokUsername}'s taps again.`);
    else if (!dropNotified) notify('Connected to your LIVE', `LIVE Link is reading @${s.tiktokUsername}'s taps${s.dryRun ? ' (test mode: nothing is added)' : ''}.`);
    // ('quiet': its "Lost" pop-up was skipped as too soon after the last one, so the return is quiet too)
    dropNotified = false;
  } else if (prevConnected && !on && !s.paused && DROP_STATES.includes(s.tiktok.status)) {
    clearTimeout(dropTimer);
    dropTimer = setTimeout(() => {
      dropTimer = null;
      const l = lastState || {};
      if (!l.connected && !l.paused && DROP_STATES.includes((l.tiktok || {}).status)) {
        if (Date.now() - lastLostAt >= LOST_POPUP_GAP_MS) {
          lastLostAt = Date.now();
          dropNotified = 'shown';
          notify('Lost your LIVE', 'LIVE Link lost the connection to TikTok and is reconnecting by itself.');
        } else dropNotified = 'quiet';
      }
    }, 20000);
  }
  if (s.tiktok.status === 'offline' || s.tiktok.status === 'idle') {
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
    dropNotified = false;
  }
  prevConnected = on;
}
let quitting = false;
let lastState = null;
let updater = null, forceQuit = false;

// Why an update can't download / install right now (null = it can). Downloads wait for the LIVE to end; installing
// (which restarts LIVE Link) also waits for the recording and the clips.
function updateBusy(kind) {
  const st = show ? show.getState() : {};
  if (st.recording && st.recording.recording) return 'recording';
  if (st.busy) return 'clips';
  if (kind === 'download' && lastState && lastState.connected && lastState.tiktok && lastState.tiktok.status === 'live') return 'live';
  return null;
}

// "Keep LIVE Link open" text for the tray and the quit question.
function clipWork() {
  const st = show ? show.getState() : null;
  if (!st || !st.busy) return null;
  const c = st.clips;
  if (!c) return 'getting ready to make your clips';
  if (c.phase === 'clip') return `making review clips (${c.index} of ${c.total})`;
  if (c.phase === 'full') return `uploading full reviews (${c.index} of ${c.total})`;
  if (c.phase === 'moment') return `making your "Clip that" moments (${c.index} of ${c.total})`;
  if (c.phase === 'fullshow') return 'saving your full show as one file';
  return 'finding the reviews from your LIVE';
}

function iconPath(name) { return path.join(__dirname, '..', 'build', name); }
// The menu bar wants ~18 pt icons (with an @2x twin next to it); the Windows tray uses the 32 px ones.
const trayIcon = (kind) => iconPath(IS_MAC ? `trayMac-${kind}.png` : `tray-${kind}.png`);

// ---------------------------------------------------------------- 2.0.8: TikTok sign-in for the recorder
// A separate, persistent browser session ("partition") on this computer holds the host's TikTok sign-in. The sign-in
// window shows TikTok's own login page in it; the recorder's lookups are made with its cookies (session.fetch). The app
// never reads the password or the cookie values: it only checks that a sign-in cookie EXISTS. Sign out clears it all.
const TT_PARTITION = 'persist:tiktok-signin';
let ttSession = null, signInWin = null, signInPoll = null;
function tiktokSession() {
  if (!ttSession) { ttSession = session.fromPartition(TT_PARTITION); ttSession.setUserAgent(CHROME_UA); }
  return ttSession;
}
async function hasTikTokSession() {
  try {
    const cookies = await tiktokSession().cookies.get({ domain: 'tiktok.com' });
    return cookies.some((c) => SESSION_COOKIES.includes(c.name) && c.value);
  } catch { return false; }
}
const signInNote = (text) => { if (win && !win.isDestroyed()) win.webContents.send('tiktok', { signedIn: !!(show && show.signedInNow), note: text || null }); };
function openTikTokSignIn() {
  if (signInWin && !signInWin.isDestroyed()) { signInWin.show(); signInWin.focus(); return true; }
  signInWin = new BrowserWindow({
    width: 520, height: 820, minWidth: 420, minHeight: 600, title: 'Sign in to TikTok (for LIVE Link recording)', parent: win || undefined, autoHideMenuBar: true,
    backgroundColor: '#0a0a0a', icon: iconPath(IS_MAC ? 'icon.png' : 'icon.ico'),
    webPreferences: { partition: TT_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  const w = signInWin;
  w.removeMenu();
  w.webContents.setUserAgent(CHROME_UA);
  // Only TikTok (and its sign-in helpers) may load in this window; anything else goes to the normal browser.
  const okUrl = (u) => { try { return SIGNIN_HOSTS.test(new URL(u).hostname); } catch { return false; } };
  w.webContents.setWindowOpenHandler(({ url }) => (okUrl(url) ? { action: 'allow', overrideBrowserWindowOptions: { parent: w, autoHideMenuBar: true, webPreferences: { partition: TT_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } } } : (shell.openExternal(url), { action: 'deny' })));
  w.webContents.on('will-navigate', (e, url) => { if (!okUrl(url)) { e.preventDefault(); shell.openExternal(url); } });
  w.loadURL(LOGIN_URL);
  log('info', 'TikTok sign-in window opened');
  signInNote('Sign in to TikTok in the window that opened. LIVE Link closes it by itself once you are signed in.');
  clearInterval(signInPoll);
  signInPoll = setInterval(async () => {
    if (!signInWin || signInWin.isDestroyed()) { clearInterval(signInPoll); signInPoll = null; return; }
    if (await hasTikTokSession()) {
      clearInterval(signInPoll); signInPoll = null;
      log('info', 'TikTok sign-in: a session cookie is present');
      store.set('tiktokSignedInAt', Date.now());
      try { signInWin.close(); } catch {}
      signInWin = null;
      if (show) { await show.refreshSignIn(); show.retryStream(); }
      signInNote('Signed in. LIVE Link now asks TikTok for your LIVE video as a signed-in viewer.');
      notify('Signed in to TikTok', 'LIVE Link can now ask TikTok for your LIVE video as a signed-in viewer.');
    }
  }, 1500);
  w.on('closed', () => { if (signInWin === w) signInWin = null; clearInterval(signInPoll); signInPoll = null; if (show) show.refreshSignIn().then(() => signInNote(null)); });
  return true;
}
async function signOutTikTok() {
  if (signInWin && !signInWin.isDestroyed()) { try { signInWin.close(); } catch {} }
  try { await tiktokSession().clearStorageData(); } catch (e) { log('warn', `TikTok sign-out: ${e && e.message}`); }
  try { await tiktokSession().clearCache(); } catch {}
  store.set('tiktokSignedInAt', null);
  if (show) await show.refreshSignIn();
  log('info', 'TikTok sign-in: signed out (session cleared)');
  signInNote('Signed out of TikTok.');
  return true;
}

// ---------------------------------------------------------------- 2.0.8: the back-up recording (the stream window)
// A hidden window runs the browser's screen recorder (ui/capture.html). Its screen-share request is answered here with
// the window the host chose (or the best match: TikTok LIVE Studio, OBS...), plus the system's audio on Windows
// (on a Mac the page adds the microphone instead: the system's audio can't be captured this way). The pieces it hands
// over are appended to capture-<run>.<webm|mp4> in the recording folder; recorder.js owns the run.
const CAPTURE_PARTITION = 'capture-recorder';
function captureDriver() {
  let cwin = null, out = null, cur = null;
  const sources = async () => {
    const list = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    return list.map((s) => ({ id: s.id, name: s.name, kind: /^screen:/.test(s.id) ? 'screen' : 'window', _src: s }));
  };
  const closeWin = () => { if (cwin && !cwin.isDestroyed()) { try { cwin.destroy(); } catch {} } cwin = null; };
  const finishFile = () => new Promise((resolve) => { const o = out; out = null; if (!o) return resolve(); o.end(() => resolve()); });
  const endCurrent = async (info) => {
    const c = cur; if (!c) return;
    cur = null;
    clearTimeout(c.startTimer);
    // Late pieces can still arrive right after "ended" (they are handed over asynchronously): give them a moment.
    await new Promise((r) => setTimeout(r, 800));
    await finishFile();
    closeWin();
    try { c.onEnd(info || {}); } catch (e) { log('warn', `capture: onEnd failed (${e && e.message})`); }
  };
  ipcMain.on('capture:chunk', (_e, buf, meta) => {
    const b = Buffer.from(buf);
    // The last piece can land just after "ended" (it is handed over asynchronously): the file stays open for it.
    if (out) { try { out.write(b); } catch (e) { log('warn', `capture: write failed (${e && e.message})`); } }
    else if (cur) { cur.pending.push(b); return; }        // before the file exists (its name needs the recorder's format)
    else return;
    if (cur) { try { cur.onProgress({ mediaMs: meta && meta.mediaMs, bytes: meta && meta.bytes }); } catch {} }
  });
  ipcMain.on('capture:started', (_e, info) => { if (cur && cur.resolveStart) { const r = cur.resolveStart; cur.resolveStart = null; r(info || {}); } });
  ipcMain.on('capture:ended', (_e, info) => { if (!cur) return; if (cur.resolveStart) { const rj = cur.rejectStart; cur.resolveStart = null; cur.rejectStart = null; endCurrent(info); rj(new Error((info && info.error) || 'the screen recorder stopped before it started')); return; } endCurrent(info); });
  ipcMain.on('capture:log', (_e, text) => log('info', `capture: ${String(text || '').slice(0, 300)}`));
  return {
    sources: async () => (await sources()).map(({ id, name, kind }) => ({ id, name, kind })),
    pick: async (preferred) => { const s = pickCaptureSource(await sources(), preferred); return s ? { id: s.id, name: s.name, kind: s.kind, _src: s._src } : null; },
    start: async ({ dir, base, source, onProgress, onEnd }) => {
      if (cur) throw new Error('a capture is already running');
      if (!source || !source._src) throw new Error('no window to record');
      const ses = session.fromPartition(CAPTURE_PARTITION);
      ses.setDisplayMediaRequestHandler((_req, cb) => { cb({ video: source._src, ...(IS_MAC ? {} : { audio: 'loopback' }) }); }, { useSystemPicker: false });
      cwin = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { partition: CAPTURE_PARTITION, preload: path.join(__dirname, 'capture-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } });
      cwin.on('closed', () => { if (cur) endCurrent({ error: 'the recorder window closed' }); });
      const c = { onProgress, onEnd, resolveStart: null, rejectStart: null, startTimer: null, file: null, pending: [] };
      cur = c;
      const started = new Promise((resolve, reject) => { c.resolveStart = resolve; c.rejectStart = reject; c.startTimer = setTimeout(() => { if (c.resolveStart) { c.resolveStart = null; c.rejectStart = null; endCurrent({ error: 'timed out' }); reject(new Error('the screen recorder did not start within 25 s')); } }, 25000); });
      await cwin.loadFile(path.join(__dirname, 'ui', 'capture.html'));
      if (cur !== c) throw new Error('capture cancelled');
      cwin.webContents.send('capture:start', { timesliceMs: CHUNK_MS, audio: IS_MAC ? 'microphone' : 'system' });
      const info = await started;
      clearTimeout(c.startTimer);
      const file = path.join(dir, `${base}.${extFor(info.mime)}`);
      c.file = file;
      out = fs.createWriteStream(file, { flags: 'a' });
      out.on('error', (e) => log('warn', `capture: file error (${e && e.message})`));
      for (const b of c.pending.splice(0)) out.write(b);
      log('info', `capture: ${path.basename(file)} (${info.mime || 'browser format'}${info.width ? `, ${info.width}x${info.height}` : ''}, audio: ${info.audio || 'unknown'})`);
      return { file, mime: info.mime || null, width: info.width || null, height: info.height || null, audio: info.audio || null };
    },
    stop: async () => {
      if (!cur) return;
      if (cwin && !cwin.isDestroyed()) { try { cwin.webContents.send('capture:stop'); } catch {} }
      // endCurrent runs when the page says it ended (recorder.js waits a few seconds, then closes the run itself).
    },
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 780, resizable: true, minWidth: 420, minHeight: 600, maximizable: false, fullscreenable: false,
    backgroundColor: '#0a0a0a', title: 'ReactivVibe LIVE Link', autoHideMenuBar: true, show: !START_HIDDEN,
    icon: iconPath(IS_MAC ? 'icon.png' : 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (!IS_MAC) win.removeMenu();   // a Mac app keeps its app menu (Quit, and Copy/Paste for the pair code)
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!store.get('trayHintShown') && Notification.isSupported()) {
      const where = IS_MAC ? 'from the menu bar. Quit it from the menu-bar icon or with Cmd+Q.' : 'from the tray. Right-click the tray icon to quit.';
      new Notification({ title: 'LIVE Link is still running', body: `It keeps sending your TikTok taps ${where}`, icon: iconPath('icon.png'), silent: true }).show();
      store.set('trayHintShown', true);
    }
  });
}

function showWindow() { if (!win) createWindow(); win.show(); win.focus(); }

const HOLD_LABEL = { test: 'TEST MODE (nothing is added)', show: 'start your show on the site', song: 'no song on air' };
// withCount: the tooltip shows the running tap count; the menu doesn't (it would have to be rebuilt every push).
function trayLabel(s, withCount = true) {
  if (!s) return 'Starting...';
  if (s.phase !== 'ready') return s.message ? s.message.text.slice(0, 60) : s.phase;
  if (s.paused) return 'Paused (resumes when your next show starts)';
  if (s.connected) return `LIVE on @${s.tiktokUsername} · ${s.hold ? HOLD_LABEL[s.hold] : withCount ? `${s.taps.accepted.toLocaleString()} taps sent` : 'filling the hype bar'}`;
  return s.message ? s.message.text.slice(0, 60) : 'Ready';
}

// Tray icon: green = filling the bar, gold = connected but holding, grey = paused, red = not watching.
const trayKindOf = (s) => !s ? 'off' : s.paused && s.phase === 'ready' ? 'paused' : s.atom === 'live' ? 'live' : s.atom === 'hold' ? 'hold' : 'off';
let trayMenuKey = '';
function updateTray(s) {
  if (!tray) return;
  const work = clipWork();
  tray.setToolTip(`ReactivVibe LIVE Link\n${trayLabel(s)}${work ? `\nKeep open: ${work}` : ''}`);
  const label = work ? `Keep open: ${work}` : trayLabel(s, false);
  const want = trayKindOf(s);
  if (want !== trayKind) { trayKind = want; tray.setImage(nativeImage.createFromPath(trayIcon(want))); }
  // Rebuilding the menu on every state (several a second while taps flow) makes an open menu flicker on Windows.
  const paused = !!(s && s.paused), ready = !!(s && s.phase === 'ready');
  const key = `${label}|${paused}|${ready}`;
  if (key === trayMenuKey) return;
  trayMenuKey = key;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open LIVE Link', click: showWindow },
    { label: paused ? 'Resume' : 'Pause', enabled: ready, click: () => ctl && ctl.setPaused(!(lastState && lastState.paused)) },
    { label: 'Check TikTok now', click: () => { if (ctl) ctl.retryNow(); if (show) show.retryStream(); } },
    { type: 'separator' },
    { label: 'Quit (stops sending taps)', click: () => app.quit() },
  ]));
}

function allowedUrl(which) {
  const s = lastState || {};
  const dash = s.dashboardUrl || SITE.dashboardUrl;
  switch (which) {
    case 'dashboard': return dash;
    case 'site': return SITE.siteUrl;
    case 'update': {
      // Only signed links from our own Supabase project or the site itself.
      const u = s.update && s.update.url;
      return u && /^https:\/\/(bxiejoktoknybpraxebm\.supabase\.co|(www\.)?reactivvibeai\.com)\//.test(u) ? u : dash;
    }
    default: return null;
  }
}

app.whenReady().then(async () => {
  if (IS_MAC) {
    try { if (app.getLoginItemSettings().wasOpenedAtLogin) START_HIDDEN = true; } catch {}
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  }
  store = new Store({
    dir: app.getPath('userData'),
    allowPlain: !app.isPackaged,   // a packaged app never writes the sign-in token in clear text
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  if (!store.get('deviceName')) store.set('deviceName', os.hostname().slice(0, 40));

  // The link keeps refused lookups, this LIVE's room and a pasted room in the settings file (they must survive a restart).
  const link = new TikTokLink({ log, persist: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } });
  const api = new LiveLinkApi({ baseUrl: API_BASE, apiKey: SITE.publishableKey, getToken: () => store.getToken(), userAgent: `ReactivVibe-LIVE-Link/${VERSION}` });
  ctl = new Controller({ api, link, store, log, appVersion: VERSION, deviceName: store.get('deviceName') });

  // Recording + review clips + the "remind chat" nudge. 2.0.8: the recorder's lookups can use the host's TikTok sign-in
  // (a separate browser session on this PC), and the back-up recording can capture the stream window.
  const signIn = new TikTokSignIn({ fetch: (url, init) => tiktokSession().fetch(url, init), hasSession: hasTikTokSession, log });
  show = new ShowManager({ ctl, link, api, store, log, ffmpegPath: ffmpegPath(), fontFile: fontPath(), defaultRoot: path.join(app.getPath('videos'), 'LIVE Link Recordings'), signIn, capture: captureDriver(), captureAudio: IS_MAC ? 'microphone' : 'system' });
  if (!show.ffmpegOk) log('warn', `recording unavailable: ffmpeg not found (${ffmpegPath()})`);
  show.refreshSignIn().then((on) => { if (on) log('info', 'TikTok sign-in: a saved sign-in is present'); });
  ipcMain.handle('tiktok:signin', () => openTikTokSignIn());
  ipcMain.handle('tiktok:signout', () => signOutTikTok());
  ipcMain.handle('tiktok:get', async () => ({ signedIn: await show.refreshSignIn(), available: true }));
  ipcMain.handle('capture:sources', () => show.captureSources());
  ipcMain.handle('show:captureNow', () => show.captureNow());
  show.on('state', (st) => {
    syncMomentKey(!!(st.recording && st.recording.recording));
    if (win && !win.isDestroyed()) win.webContents.send('show', { ...st, momentKey: momentKey(), momentKeyOk });
  });
  show.on('momentsMade', (x) => notify('Moment clips ready', `${x.made} "Clip that" moment${x.made === 1 ? ' is' : 's are'} ready to post. Click to open the folder.`, () => { if (x.outDir) shell.openPath(x.outDir); }));
  // The LIVE is on but nothing has been recorded for a minute: one pop-up per failure, with the reason.
  show.on('recordingFailed', (f) => notify('Not recording your LIVE', `${f.text}. LIVE Link keeps trying; open it for details.`, showWindow));
  show.on('nudge', () => notify('Remind chat to tap', 'Nobody has tapped for 2 minutes. Tell chat: tapping the screen fills the hype bar.'));
  // One pop-up when everything after the LIVE is done: the clips, the moments, the full-show file.
  show.on('safeToClose', (x) => {
    const c = x.clips;
    const parts = [];
    if (c && c.sent) parts.push(`${c.sent} review clip${c.sent === 1 ? '' : 's'} sent`);
    if (c && c.failed) parts.push(`${c.failed} didn't send (Recordings > Make & send clips)`);
    if (x.fullShow) parts.push('full show saved');
    notify(c && c.failed ? 'Done, with some clips to resend' : 'All done: safe to close LIVE Link', `${parts.length ? `${parts.join(' · ')}. ` : ''}It's safe to close LIVE Link.`,
      x.fullShow ? () => shell.openPath(x.dir) : undefined);
  });
  show.on('state', () => { if (updater) updater.poke(); updateTray(lastState); });

  // In-app updates: downloaded in the background when no LIVE/recording/clips are running, installed on "Restart to update".
  updater = new Updater({ dir: path.join(app.getPath('userData'), 'updates'), appVersion: VERSION, appPath: process.execPath, log, busy: updateBusy });
  updater.on('state', (u) => { if (win && !win.isDestroyed()) win.webContents.send('updater', u); });
  // 2.0.8: one pop-up per new version (ever, not per app run), on top of the big banner in the window.
  updater.on('newVersion', ({ version }) => {
    if (store.get('updateNotifiedVersion') === version) return;
    store.set('updateNotifiedVersion', version);
    log('info', `update ${version} is out`);
    notify(`Update LIVE Link: ${version} is ready`, 'Open LIVE Link and click "Restart to update". It never installs during a LIVE, a recording or while clips are made.', showWindow);
  });
  ipcMain.handle('updater:get', () => updater.getState());
  ipcMain.handle('updater:check', async () => { const u = await ctl.checkForUpdate(); updater.offer(u); if (updater.state.status === 'error') updater.tryDownload(); return { update: u, updater: updater.getState() }; });
  ipcMain.handle('updater:retry', () => { updater.tryDownload(); return updater.getState(); });
  ipcMain.handle('updater:install', async () => {
    const r = await updater.install();
    if (r.ok) { log('info', `installing update ${updater.state.version}`); forceQuit = true; setTimeout(() => app.quit(), 300); }
    return r;
  });
  ipcMain.handle('show:makeFullShow', (_e, dir) => show.makeFullShow(String(dir || '')));
  ipcMain.handle('show:openFullShow', (_e, dir) => {
    const f = show.fullShowFile(String(dir || ''));
    if (f && fs.existsSync(f)) { shell.showItemInFolder(f); return true; }
    return false;
  });
  show.on('storageReminder', (x) => notify('Time to clear old recordings', `Your LIVE recordings use ${(x.totalBytes / 1024 ** 3).toFixed(0)} GB. Open LIVE Link > Recordings to delete the ones you don't need.`));

  ctl.on('sessionEnded', (x) => {
    dropNotified = false;
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }   // the next LIVE gets its "Connected" pop-up
    if (quitting) return;
    flushPendingEnd();
    const show = () => {
      if (quitting) return;
      const st = ctl.getState();
      // The last pushes (and any backlog) land after the session closes: use the kept summary's count when it's this one.
      const kept = st.lastSession && st.lastSession.startedAt === x.startedAt ? st.lastSession : x;
      const title = x.reason === 'disconnected' ? 'LIVE Link paused' : x.reason === 'stopped' ? 'LIVE Link stopped watching' : 'Your LIVE ended';
      const why = x.reason === 'stopped' && st.message && st.message.level !== 'ok' && st.message.level !== 'info' ? `${st.message.text}\n` : '';
      notify(title, `${why}${fmtDur(x.endedAt - x.startedAt)} · ${x.taps.toLocaleString()} taps · ${kept.accepted.toLocaleString()} sent to the bar · peak ${x.peakViewers.toLocaleString()} watching${x.dryRun ? ' (test mode)' : ''}`);
    };
    // A stop shows at once (after the controller settles, so it can say why); an end waits ~3 s for its last pushes.
    pendingEnd = { show, timer: setTimeout(() => { pendingEnd = null; show(); }, x.reason === 'stopped' ? 0 : 3000) };
  });
  ctl.on('autoResumed', () => notify('LIVE Link resumed', 'Your show started on reactivvibeai.com, so LIVE Link is watching your TikTok again.'));
  // A sleeping computer drops its sockets and timers: look again as soon as it wakes or is unlocked.
  powerMonitor.on('resume', () => { log('info', 'system resumed from sleep'); ctl.wake(true); });
  powerMonitor.on('shutdown', () => { forceQuit = true; });   // the computer is shutting down: don't hold it up with a question
  powerMonitor.on('unlock-screen', () => ctl.wake(false));
  ctl.on('state', (s) => {
    lastState = s;
    watchConnection(s);
    if (updater) { updater.offer(s.update); updater.poke(); }
    updateTray(s);
    if (win && !win.isDestroyed()) win.webContents.send('state', s);
  });

  ipcMain.handle('getState', () => lastState || ctl.getState());
  ipcMain.handle('getSettings', () => ({
    startWithWindows: app.getLoginItemSettings().openAtLogin,
    dryRun: !!store.get('dryRun'),
    notify: store.get('notify') !== false,
    deviceName: store.get('deviceName'),
    version: VERSION,
    platform: process.platform,
    testServer: API_BASE !== SITE.apiBase ? API_BASE : null,
    recordEnabled: show ? show.enabled() : true,
    recordRoot: show ? show.root() : null,
    recordAvailable: !!(show && show.ffmpegOk),
    momentKey: momentKey(),
    momentKeyOk,
    // 2.0.8
    tiktokSignedIn: !!(show && show.signedInNow),
    captureAvailable: !!(show && show.captureAvailable()),
    captureEnabled: !!(show && show.captureEnabled()),
    captureSource: show ? show.captureSource() : null,
    captureAudio: IS_MAC ? 'microphone' : 'system',
  }));
  ipcMain.handle('show:get', () => showState());
  ipcMain.handle('show:mark', () => markMoment('button'));
  ipcMain.handle('show:openMoments', (_e, dir) => {
    const d = show.momentsDir(String(dir || ''));
    if (!d) return false;
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    shell.openPath(d);
    return true;
  });
  ipcMain.handle('show:list', () => show.listRecordings());
  ipcMain.handle('show:preview', () => {
    const p = show.previewPath();
    try { return p ? `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` : null; } catch { return null; }
  });
  ipcMain.handle('show:open', (_e, dir) => {
    const target = dir && show._inRoot(dir) ? dir : show.root();
    try { fs.mkdirSync(target, { recursive: true }); } catch {}
    shell.openPath(target);
    return true;
  });
  ipcMain.handle('show:delete', (_e, dir) => show.deleteRecording(dir));
  ipcMain.handle('show:makeClips', (_e, dir) => show.makeClips(dir));
  ipcMain.handle('show:stop', async () => { await show.stopByHost(); return true; });
  ipcMain.handle('show:start', () => { show.resumeByHost(); return true; });
  ipcMain.handle('show:retryStream', () => show.retryStream());
  ipcMain.handle('show:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Where should LIVE Link save your LIVE recordings?', defaultPath: show.root(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    if (show.recorder.active) return { error: 'recording' };
    store.set('recordRoot', r.filePaths[0]);
    show._checkStorage(false);
    show._emit();
    return { root: r.filePaths[0] };
  });
  ipcMain.handle('pair', async (_e, code) => {
    try { await ctl.pair(String(code || '')); return { ok: true }; }
    catch (e) { return { ok: false, code: e.code || 'error', message: e.message }; }
  });
  ipcMain.handle('unpair', () => { ctl.unpair(); return true; });
  ipcMain.handle('retry', () => { ctl.retryNow(); if (show) show.retryStream(); return true; });
  ipcMain.handle('setManualRoom', async (_e, text) => {
    try { return await ctl.setManualRoom(String(text || '').slice(0, 500)); }
    catch (e) { log('warn', `pasted LIVE link: ${e && e.message}`); return { ok: false, error: 'error' }; }
  });
  ipcMain.handle('setSetting', (_e, key, value) => {
    if (key === 'startWithWindows') app.setLoginItemSettings(IS_MAC ? { openAtLogin: !!value } : { openAtLogin: !!value, args: ['--hidden'] });
    else if (key === 'dryRun') ctl.setDryRun(!!value);
    else if (key === 'paused') ctl.setPaused(!!value);
    else if (key === 'notify') store.set('notify', !!value);
    else if (key === 'recordEnabled') {
      store.set('recordEnabled', !!value);
      if (!value) show.stopRecording('recording switched off in Settings');
      else show.resumeByHost();
      show._emit();
    }
    else if (key === 'momentKey') {
      if (!Object.prototype.hasOwnProperty.call(MOMENT_KEYS, value)) return false;
      store.set('momentKey', value);
      syncMomentKey(show.recorder.active);
      show._emit();
      return { ok: momentKeyOk };
    }
    else if (key === 'captureEnabled') return { ok: true, enabled: show.setCaptureEnabled(!!value) };
    else if (key === 'captureSource') return { ok: true, source: show.setCaptureSource(value == null ? null : String(value)) };
    else return false;
    return true;
  });
  ipcMain.handle('open', (_e, which) => {
    if (which === 'logs') { shell.openPath(path.join(app.getPath('userData'), 'logs')); return true; }
    if (which === 'source') { shell.showItemInFolder(path.join(process.resourcesPath || '', 'source', 'SOURCE.md')); return true; }
    if (which === 'license') { shell.openPath(path.join(process.resourcesPath || '', 'LICENSE.txt')); return true; }
    const url = allowedUrl(which);
    if (url && /^https:\/\//.test(url)) { shell.openExternal(url); return true; }
    return false;
  });

  createWindow();
  tray = new Tray(nativeImage.createFromPath(trayIcon('off')));
  trayKind = 'off';
  tray.on('click', showWindow);
  updateTray(null);

  log('info', `LIVE Link ${VERSION} starting (api ${API_BASE})`);
  await ctl.start();

  // Development smoke test only (scripts/smoke.js): pair against the local mock, report, quit.
  if (!app.isPackaged && process.env.LIVE_LINK_SMOKE && API_BASE !== SITE.apiBase) {
    if (ctl.getState().phase === 'unpaired') { try { await ctl.pair(process.env.LIVE_LINK_SMOKE); } catch (e) { log('error', `SMOKE pair failed: ${e.code} ${e.message}`); } }
    setTimeout(() => {
      const s = ctl.getState();
      log('info', `SMOKE phase=${s.phase} tiktok=${s.tiktok.status} user=${s.tiktokUsername} encrypted=${safeStorage.isEncryptionAvailable()} msg="${s.message && s.message.text}"`);
      quitting = true; app.exit(0);
    }, 6000);
  }

  // Update info arrives inside live-link-config (`latest` with a short-lived signed link): see Controller.
});

app.on('second-instance', showWindow);
// Mac: clicking the Dock icon brings the window back. The launch itself also fires 'activate'; a quiet start at
// login must not pop the window, so the first one is skipped then.
let skipActivate = true;
app.on('activate', () => { if (skipActivate && START_HIDDEN) { skipActivate = false; return; } skipActivate = false; showWindow(); });
app.on('window-all-closed', (e) => { /* stay in the tray */ });
// Before quitting: up to 3 s for queued gifts (quitting right after a gift must not lose it), then up to 1.5 s to
// tell the site this computer stopped watching (the dashboard shows it at once), then quit.
let quitFlushed = false;
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
// Quitting while clips are still being made: ask first (they'd finish next time, but the host should know).
let quitAsking = false;
app.on('before-quit', (e) => {
  const work = !forceQuit && !quitFlushed && clipWork();
  if (work) {
    e.preventDefault();
    if (quitAsking) return;
    quitAsking = true;
    showWindow();
    dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Keep LIVE Link running', 'Quit anyway'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'LIVE Link is still working', message: `LIVE Link is still ${work}.`,
      detail: 'Leave it running and you get an "All done: safe to close" pop-up when it finishes. If you quit now, it picks up where it left off the next time you open LIVE Link.',
    }).then(({ response }) => { quitAsking = false; if (response === 1) { forceQuit = true; app.quit(); } }).catch(() => { quitAsking = false; });
    return;
  }
  quitting = true;
  if (quitFlushed || !ctl) { if (ctl) ctl.stop(); return; }
  quitFlushed = true;
  const needGifts = ctl.hasPendingGifts(), needStatus = ctl.getState().phase === 'ready', needRec = !!(show && show.recorder.active);
  if (!needGifts && !needStatus && !needRec) { ctl.stop(); return; }          // nothing to send or close: quit right away
  e.preventDefault();
  // A recording is closed properly first (ffmpeg finishes its last piece), in parallel with the gift flush.
  const rec = needRec ? show.shutdown().catch(() => {}) : Promise.resolve();
  const gifts = needGifts ? ctl.flushBeforeQuit(3000).catch(() => {}) : Promise.resolve();
  // Quit again from a FRESH task. Called from this handler's own promise callbacks it can run nested inside the first
  // quit, whose "prevented" result then cancels it: on macOS the app never exited (Cmd+Q / SIGTERM did nothing).
  Promise.all([gifts, rec]).then(() => ctl.sendFinalStatus(1500)).catch(() => {}).finally(() => setTimeout(() => app.quit(), 0));
  setTimeout(() => { log('warn', 'quit did not finish in 11 s: exiting'); app.exit(0); }, needRec ? 11000 : 6000).unref();
});
