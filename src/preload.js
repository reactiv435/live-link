'use strict';
// The only bridge between the window and the app. The page gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveLink', {
  getState: () => ipcRenderer.invoke('getState'),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  pair: (code) => ipcRenderer.invoke('pair', String(code || '')),
  unpair: () => ipcRenderer.invoke('unpair'),
  retry: () => ipcRenderer.invoke('retry'),
  setManualRoom: (text) => ipcRenderer.invoke('setManualRoom', String(text || '')),
  setSetting: (key, value) => ipcRenderer.invoke('setSetting', String(key), value),
  open: (which) => ipcRenderer.invoke('open', String(which)),
  onState: (cb) => { const f = (_e, s) => cb(s); ipcRenderer.on('state', f); return () => ipcRenderer.removeListener('state', f); },
  // 2.0: recording + review clips
  getShow: () => ipcRenderer.invoke('show:get'),
  onShow: (cb) => { const f = (_e, s) => cb(s); ipcRenderer.on('show', f); return () => ipcRenderer.removeListener('show', f); },
  getPreview: () => ipcRenderer.invoke('show:preview'),
  listRecordings: () => ipcRenderer.invoke('show:list'),
  openRecording: (dir) => ipcRenderer.invoke('show:open', dir ? String(dir) : ''),
  deleteRecording: (dir) => ipcRenderer.invoke('show:delete', String(dir || '')),
  makeClips: (dir) => ipcRenderer.invoke('show:makeClips', String(dir || '')),
  stopRecording: () => ipcRenderer.invoke('show:stop'),
  startRecording: () => ipcRenderer.invoke('show:start'),
  chooseRecordFolder: () => ipcRenderer.invoke('show:chooseFolder'),
  // 2.0.3: "Clip that" moments
  markMoment: () => ipcRenderer.invoke('show:mark'),
  openMoments: (dir) => ipcRenderer.invoke('show:openMoments', String(dir || '')),
  // 2.0.5: in-app updates + the full-show file
  getUpdater: () => ipcRenderer.invoke('updater:get'),
  onUpdater: (cb) => { const f = (_e, s) => cb(s); ipcRenderer.on('updater', f); return () => ipcRenderer.removeListener('updater', f); },
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  retryUpdate: () => ipcRenderer.invoke('updater:retry'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  makeFullShow: (dir) => ipcRenderer.invoke('show:makeFullShow', String(dir || '')),
  openFullShow: (dir) => ipcRenderer.invoke('show:openFullShow', String(dir || '')),
  // 2.0.7: "Not recording" -> ask TikTok for the video again now
  retryRecording: () => ipcRenderer.invoke('show:retryStream'),
});
