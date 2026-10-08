'use strict';
// ReactivVibe LIVE Link: Electron main process. Owns the TikTok link, the site client, the tray and one window.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, safeStorage, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { TikTokLink } = require('./core/tiktok-link');
const { LiveLinkApi } = require('./core/api');
const { Controller } = require('./core/controller');
const { Store } = require('./core/store');
const SITE = require('./site-config.json');

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

let win = null, tray = null, ctl = null, store = null;
let trayKind = '';

// Pop-ups: connected to the LIVE, lost it for more than 20 s, and the end-of-LIVE summary.
function notify(title, body) {
  if (!store || store.get('notify') === false || !Notification.isSupported()) return;
  // silent: a hosting PC is usually capturing its own audio into the stream
  try { new Notification({ title, body, icon: iconPath('icon.png'), silent: true }).show(); } catch {}
}
const fmtDur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
let prevAtom = 'off', dropTimer = null, dropNotified = false;
// A real drop: TikTok is being re-tried. Stopping on purpose (idle) or the LIVE ending (offline) is not a drop.
const DROP_STATES = ['reconnecting', 'connecting', 'error'];
let pendingEnd = null;   // { timer, show } while an end-of-LIVE pop-up waits for its last pushes to land
function flushPendingEnd() { if (pendingEnd) { clearTimeout(pendingEnd.timer); const p = pendingEnd; pendingEnd = null; p.show(); } }
function watchConnection(s) {
  if (s.atom === 'live' && prevAtom !== 'live') {
    flushPendingEnd();                                                      // the old LIVE's summary comes first
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }          // a quick blip: stay quiet
    else notify(dropNotified ? 'Reconnected to your LIVE' : 'Connected to your LIVE',
      `LIVE Link is reading @${s.tiktokUsername}'s taps${s.dryRun ? ' (test mode: nothing is added)' : ''}.`);
    dropNotified = false;
  } else if (prevAtom === 'live' && s.atom !== 'live' && !s.paused && DROP_STATES.includes(s.tiktok.status)) {
    dropTimer = setTimeout(() => {
      dropTimer = null;
      const l = lastState || {};
      if (l.atom !== 'live' && !l.paused && DROP_STATES.includes((l.tiktok || {}).status)) {
        dropNotified = true;
        notify('Lost your LIVE', 'LIVE Link lost the connection to TikTok and is reconnecting by itself.');
      }
    }, 20000);
  }
  if (s.tiktok.status === 'offline' || s.tiktok.status === 'idle') {
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
    dropNotified = false;
  }
  prevAtom = s.atom;
}
let quitting = false;
let lastState = null;

function iconPath(name) { return path.join(__dirname, '..', 'build', name); }
// The menu bar wants ~18 pt icons (with an @2x twin next to it); the Windows tray uses the 32 px ones.
const trayIcon = (kind) => iconPath(IS_MAC ? `trayMac-${kind}.png` : `tray-${kind}.png`);

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

function trayLabel(s) {
  if (!s) return 'Starting...';
  if (s.phase !== 'ready') return s.message ? s.message.text.slice(0, 60) : s.phase;
  if (s.paused) return 'Disconnected (press Connect in the app)';
  if (s.tiktok.status === 'live') return `LIVE on @${s.tiktokUsername} · ${s.dryRun ? 'TEST MODE (nothing is added)' : `${s.taps.accepted} taps sent`}`;
  return s.message ? s.message.text.slice(0, 60) : 'Ready';
}

function updateTray(s) {
  if (!tray) return;
  const label = trayLabel(s);
  tray.setToolTip(`ReactivVibe LIVE Link\n${label}`);
  const want = s && s.atom === 'live' ? 'live' : 'off';
  if (want !== trayKind) { trayKind = want; tray.setImage(nativeImage.createFromPath(trayIcon(want))); }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open LIVE Link', click: showWindow },
    { label: s && s.paused ? 'Connect' : 'Disconnect', enabled: !!(s && s.phase === 'ready'), click: () => ctl && ctl.setPaused(!(s && s.paused)) },
    { label: 'Check TikTok now', click: () => ctl && ctl.retryNow() },
    { type: 'separator' },
    { label: 'Quit (stops sending taps)', click: () => { quitting = true; app.quit(); } },
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
    cipher: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  if (!store.get('deviceName')) store.set('deviceName', os.hostname().slice(0, 40));

  const link = new TikTokLink({ log });
  const api = new LiveLinkApi({ baseUrl: API_BASE, apiKey: SITE.publishableKey, getToken: () => store.getToken(), userAgent: `ReactivVibe-LIVE-Link/${VERSION}` });
  ctl = new Controller({ api, link, store, log, appVersion: VERSION, deviceName: store.get('deviceName') });

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
      const title = x.reason === 'disconnected' ? 'LIVE Link disconnected' : x.reason === 'stopped' ? 'LIVE Link stopped watching' : 'Your LIVE ended';
      const why = x.reason === 'stopped' && st.message && st.message.level !== 'ok' && st.message.level !== 'info' ? `${st.message.text}\n` : '';
      notify(title, `${why}${fmtDur(x.endedAt - x.startedAt)} · ${x.taps.toLocaleString()} taps · ${kept.accepted.toLocaleString()} sent to the bar · peak ${x.peakViewers.toLocaleString()} watching${x.dryRun ? ' (test mode)' : ''}`);
    };
    // A stop shows at once (after the controller settles, so it can say why); an end waits ~3 s for its last pushes.
    pendingEnd = { show, timer: setTimeout(() => { pendingEnd = null; show(); }, x.reason === 'stopped' ? 0 : 3000) };
  });
  ctl.on('state', (s) => {
    lastState = s;
    watchConnection(s);
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
  }));
  ipcMain.handle('pair', async (_e, code) => {
    try { await ctl.pair(String(code || '')); return { ok: true }; }
    catch (e) { return { ok: false, code: e.code || 'error', message: e.message }; }
  });
  ipcMain.handle('unpair', () => { ctl.unpair(); return true; });
  ipcMain.handle('retry', () => { ctl.retryNow(); return true; });
  ipcMain.handle('setSetting', (_e, key, value) => {
    if (key === 'startWithWindows') app.setLoginItemSettings(IS_MAC ? { openAtLogin: !!value } : { openAtLogin: !!value, args: ['--hidden'] });
    else if (key === 'dryRun') ctl.setDryRun(!!value);
    else if (key === 'paused') ctl.setPaused(!!value);
    else if (key === 'notify') store.set('notify', !!value);
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
app.on('before-quit', () => { quitting = true; if (ctl) ctl.stop(); });
