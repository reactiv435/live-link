'use strict';
// 2.0.8: the bridge for the hidden back-up recorder page (ui/capture.html). The page gets these and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureBridge', {
  // main -> page
  onStart: (cb) => { const f = (_e, o) => cb(o); ipcRenderer.on('capture:start', f); return () => ipcRenderer.removeListener('capture:start', f); },
  onStop: (cb) => { const f = () => cb(); ipcRenderer.on('capture:stop', f); return () => ipcRenderer.removeListener('capture:stop', f); },
  // page -> main
  started: (info) => ipcRenderer.send('capture:started', info),
  chunk: (buffer, meta) => ipcRenderer.send('capture:chunk', buffer, meta),
  ended: (info) => ipcRenderer.send('capture:ended', info),
  log: (text) => ipcRenderer.send('capture:log', String(text || '').slice(0, 300)),
});
