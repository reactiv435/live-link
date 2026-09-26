'use strict';
// The only bridge between the window and the app. The page gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveLink', {
  getState: () => ipcRenderer.invoke('getState'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  pair: (code) => ipcRenderer.invoke('pair', String(code || '')),
  unpair: () => ipcRenderer.invoke('unpair'),
  retry: () => ipcRenderer.invoke('retry'),
  setSetting: (key, value) => ipcRenderer.invoke('setSetting', String(key), value),
  open: (which) => ipcRenderer.invoke('open', String(which)),
  onState: (cb) => { const f = (_e, s) => cb(s); ipcRenderer.on('state', f); return () => ipcRenderer.removeListener('state', f); },
});
