'use strict';
// Used by scripts/vtuber-smoke.js when no Chrome is found: shows the VTuber's avatar page in a hidden window of the
// given size, the way OBS's own browser would load it, so the smoke test can look at it over the DevTools port.
//   electron scripts/vtuber-avatar-shell.js <url> <width> <height> --remote-debugging-port=<n> --user-data-dir=<folder>
const { app, BrowserWindow } = require('electron');
const [url, w, h] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!/^http:\/\/127\.0\.0\.1:\d+\/avatar\.html/.test(String(url))) { process.stderr.write('only the local avatar page\n'); app.exit(2); }
else app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: Number(w) || 720, height: Number(h) || 1280, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setAudioMuted(true);
  win.loadURL(url);
});
