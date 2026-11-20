// VTuber tracker v2, the page: settings, the picture source, the small picture, the numbers. The work itself runs in
// workers so it never waits for this page:
//   worker-hub.js   frames in (window capture / OBS screenshots / a video file), capture-time stamps, newest-frame-only
//                   hand-over, tracking/lib/body-signal.js, the `perf` message, the relay WebSocket, the measurements
//   worker-face.js  FaceLandmarker on every frame + tracking/lib/face-signal.js
//   worker-body.js  PoseLandmarker and HandLandmarker: one worker doing both, or (?split=1) two workers, one model each
// Nothing leaves this PC. The OBS password is kept in localStorage only and is never logged or shown.

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const RELAY_URL = Q.get('ws') || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
const MP_VERSION = Q.get('mp') === '0.10.21' || Q.get('mp') === '1.2.3' ? Q.get('mp') : '0.10.21';
// body models: false = one worker runs pose then hands; true = two workers run them side by side on the same frame
const SPLIT = Q.get('split') ? Q.get('split') === '1' : false;
const BODY_WORKERS = SPLIT ? ['P', 'H'] : ['P'];
// ?embed=1: this page runs unseen inside vtuber.html (the one-click page), which drives it and shows its small picture
const EMBED = Q.get('embed') === '1';
const LS_SETTINGS = EMBED ? 'vt3_tracker_settings' : 'vt2_tracker_settings';
const LS_PW = 'vt_obs_pw';
const LS_CALIB = 'vt2_face_calib';

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  source: 'display', faceMax: 30, bodyMax: 30, body: 'on', delegate: 'GPU', mirror: 'follow', line: 'follow', shed: 'auto', pv: 'on',
  crop: 'auto', cropL: 0, cropR: 0, cropT: 0, cropB: 0, turn: 0, flip: 'none',
  host: '127.0.0.1', port: 4455, sourceName: '', obsWidth: 540, obsFps: 30, obsView: 'auto', obsTurn: 0, obsFlip: 'none', obsCropL: 0, obsCropR: 0, obsCropT: 0, obsCropB: 0,
  camId: '', micId: '', audio: 'none',
};
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') }; } catch (e) { /* keep defaults */ }
const saveSettings = () => { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ } };
// Inside the one-click page (and so inside LIVE Link) the OBS password never comes near this page: the app itself talks
// to OBS. The box of the earlier, stand-alone tracker page is taken out there, and nothing is read from or kept in storage.
const getPw = () => { if (EMBED) return ''; try { return localStorage.getItem(LS_PW) || ''; } catch (e) { return ''; } };
if (EMBED) { try { localStorage.removeItem(LS_PW); } catch (e) { /* ignore */ } const pwBox = document.getElementById('password'); if (pwBox) pwBox.remove(); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- the saved calibration
// What face-signal.js holds is kept in two places: on the avatar server (a file on this PC, so the normal Chrome page
// and the start-tracker.bat window share it) and in this browser (the fallback when the server cannot keep it).
// Saved as { data, stub, at: when saved, capturedAt: when "Capture neutral face" last succeeded, origin: 'capture' | 'seed' | 'auto' }.
const CALIB_URL = new URL('../api/calibration', location.href).href;
const loadCalib = () => { try { const c = JSON.parse(localStorage.getItem(LS_CALIB) || 'null'); return c && typeof c === 'object' && c.data ? c : null; } catch (e) { return null; } };
async function loadServerCalib() {
  try {
    const r = await fetch(CALIB_URL, { cache: 'no-store' });
    if (!r.ok) return null;
    const c = await r.json();
    return c && typeof c === 'object' && c.data && typeof c.data === 'object' ? c : null;
  } catch (e) { return null; }
}
function storeCalib(c, where = 'both') {
  if (where !== 'server') { try { localStorage.setItem(LS_CALIB, JSON.stringify(c)); } catch (e) { /* ignore */ } }
  if (where !== 'local') fetch(CALIB_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }).catch(() => {});
}
function dropCalib() {
  try { localStorage.removeItem(LS_CALIB); } catch (e) { /* ignore */ }
  fetch(CALIB_URL, { method: 'DELETE' }).catch(() => {});
}
// What the face worker starts from: the newer of the two saved copies; with nothing saved, the calibration learned
// beforehand from the owner's own footage, if that file is there (tracking/calib-owner.json, kept on this PC, never
// in git); else nothing (generic values).
let startCalib = null, seedCalib = null;
async function loadStartCalib() {
  const local = loadCalib(), server = await loadServerCalib();
  const saved = server && (!local || (Number(server.at) || 0) >= (Number(local.at) || 0)) ? server : local;
  if (saved) {
    startCalib = saved;
    if (saved === server) storeCalib(saved, 'local'); else storeCalib(saved, 'server');      // both places agree again
    const oldStamp = saved.data && saved.data.capturedAt > 1e12 ? saved.data.capturedAt : null;   // saved by the page before capturedAt was kept beside the data
    st.calib = { from: 'saved', origin: saved.origin || (saved.capturedAt || oldStamp ? 'capture' : 'auto'), savedAt: Number(saved.at) || null, capturedAt: Number(saved.capturedAt) || oldStamp, info: null };
    return;
  }
  try {
    const r = await fetch('./calib-owner.json', { cache: 'no-store' });
    if (r.ok) { const data = await r.json(); if (data && typeof data === 'object') seedCalib = { data, stub: false, seed: true }; }
  } catch (e) { /* no such file: start from the generic values */ }
  startCalib = seedCalib;
  st.calib = seedCalib ? { from: 'seed', origin: 'seed', savedAt: null, capturedAt: null, info: null } : { from: 'none', origin: 'auto', savedAt: null, capturedAt: null, info: null };
}

const previewOn = () => settings.pv !== 'off' && document.visibilityState === 'visible';
function hubCfg() {
  return {
    relayUrl: RELAY_URL, source: settings.source, faceMax: Number(settings.faceMax) || 30, bodyMax: Number(settings.bodyMax) || 30,
    bodyOn: settings.body !== 'off', mirror: settings.mirror, line: settings.line, shed: settings.shed, preview: previewOn(),
    crop: settings.crop, cropManual: { l: settings.cropL, r: settings.cropR, t: settings.cropT, b: settings.cropB }, turn: Number(settings.turn) || 0, flip: settings.flip,
    v1FaceHz: clamp(Number(Q.get('v1face')) || 5, 1, 60), tap: Q.get('tap') === '1', luma: Q.get('luma') === '1',
    obs: {
      host: settings.host, port: settings.port, sourceName: settings.sourceName, width: settings.obsWidth, fps: settings.obsFps, quality: 60, inflight: clamp(Number(Q.get('inflight')) || 2, 1, 4),
      view: settings.obsView, turn: Number(settings.obsTurn) || 0, flip: settings.obsFlip, cropL: settings.obsCropL, cropR: settings.obsCropR, cropT: settings.obsCropT, cropB: settings.obsCropB,
    },
  };
}

// ---------------------------------------------------------------- state
const st = {
  stats: null, info: { F: null, P: null, H: null }, relay: false, control: { mirror: false, line: false },
  obs: { state: 'off', text: '', inputs: [], sourceError: '', viewText: '' },
  sourceError: '', capturing: false, streamKind: '', trackLabel: '', rect: null, rectInfo: null,
  workerError: { F: '', P: '', H: '', hub: '' }, restarts: { F: 0, P: 0, H: 0 }, audioText: 'off', wavePublished: 0, calibKind: '',
  relayAt: performance.now(), relayWasOpen: false,  // when the avatar link last changed; whether it has been up at all
  bodySlow: false, bodySlowSince: 0,
  // which calibration the face worker holds: from 'none' | 'seed' | 'saved' | 'now'; origin 'capture' | 'seed' | 'auto'
  calib: { from: 'none', origin: 'auto', savedAt: null, capturedAt: null, info: null },
  // the guided "Capture neutral face": state 'idle' | 'collecting' | 'done' | 'rejected'
  cap: { state: 'idle', progress: 0, reason: null, text: '', waiting: false },
};

// ---------------------------------------------------------------- workers
let hub = null;
const model = { F: null, P: null, H: null };
function makeModelWorker(who, port) {
  const w = new Worker(who === 'F' ? './worker-face.js' : './worker-body.js');
  w.onmessage = (ev) => onModel(who, ev.data);
  w.onerror = (e) => { st.workerError[who] = (who === 'F' ? 'Face' : who === 'H' ? 'Hand' : 'Body') + ' worker failed: ' + (e.message || 'unknown error'); };
  // ?bdelegate=CPU (measurements only): body + hands on the processor while the face stays on the graphics card
  const delegate = who !== 'F' && Q.get('bdelegate') ? Q.get('bdelegate') : settings.delegate;
  const init = { t: 'init', who, port, delegate, mp: MP_VERSION, mirror: st.control.mirror };
  if (who === 'F') {
    const c = calibCleared ? null : loadCalib() || startCalib;                  // a restarted worker gets what was saved last
    if (c && c.data) { init.calib = c.data; init.calibStub = !!c.stub; }
    if (Q.get('facesig') === 'stub') init.forceStub = true;                      // testing: the stand-in instead of face-signal.js
  }
  else { init.tasks = SPLIT ? (who === 'P' ? 'pose' : 'hands') : 'both'; if (Q.get('pose') === 'lite') init.pose = 'lite'; if (Q.get('handconf')) init.handConf = Number(Q.get('handconf')); }
  w.postMessage(init, [port]);
  if (who === 'F') w.postMessage({ t: 'preview', on: previewOn() });
  model[who] = w;
  return w;
}
function startWorkers() {
  hub = new Worker('./worker-hub.js');
  hub.onmessage = onHub;
  hub.onerror = (e) => { st.workerError.hub = 'The tracker core failed to start: ' + (e.message || 'unknown error'); };
  const ports = {}, list = [];
  for (const who of ['F', ...BODY_WORKERS]) { const ch = new MessageChannel(); makeModelWorker(who, ch.port1); ports[who] = ch.port2; list.push(ch.port2); }
  hub.postMessage({ t: 'init', cfg: hubCfg(), ports }, list);
}
/** A model worker hung: throw it away and start a fresh one. */
function restartWorker(who) {
  if (!model[who]) return;
  try { model[who].terminate(); } catch (e) { /* ignore */ }
  st.info[who] = null; st.restarts[who]++;
  const ch = new MessageChannel();
  makeModelWorker(who, ch.port1);
  hub.postMessage({ t: 'port', who, port: ch.port2 }, [ch.port2]);
}
const pushCfg = () => { if (hub) hub.postMessage({ t: 'cfg', patch: hubCfg() }); };
function pushPreview() {
  if (model.F) model.F.postMessage({ t: 'preview', on: previewOn() });
  pushCfg();
}

function onModel(who, m) {
  if (m.t === 'info') st.info[who] = m;
  else if (m.t === 'pv') { pv.face = m.lm; pv.dirty = true; }
  else if (m.t === 'capture' && who === 'F') onCapture(m);
  else if (m.t === 'mask-rest' && who === 'F') { if (window.__trackerMaskRest) { try { window.__trackerMaskRest(m); } catch (e) { /* the one page's business */ } } }
  else if (m.t === 'calib' && who === 'F') {
    if (m.info) st.calib.info = m.info;
    if (calibAsked.length) { for (const r of calibAsked.splice(0)) r(m.data); return; }      // a dev read-back: not a new capture
    if (calibCleared) return;                                                                  // "Clear" was pressed: nothing is kept until the next capture
    storeCalib({ data: m.data, stub: !!m.stub, at: Date.now(), capturedAt: st.calib.capturedAt || null, origin: st.calib.origin });
    st.calibKind = m.stub ? 'stub' : 'real';
  }
}

// ---------------------------------------------------------------- "Capture neutral face" (guided; the face worker reports, this page only shows it)
const CAP_IDLE = 'Look at the camera with a relaxed face and your mouth closed. Press the button, then hold still for two seconds. Do it once per session (light and camera height change from day to day).';
const CAP_HOLD = 'Hold still, relaxed face, mouth closed ...';
const CAP_FIX = { 'no-face': 'I cannot see your face', 'mouth-open': 'close your mouth', smiling: 'relax your mouth, no smile', 'eyes-closed': 'open your eyes', moving: 'keep your head still' };
const CAP_WHY = { 'no-face': 'no face was visible', 'mouth-open': 'your mouth was open', smiling: 'you were smiling', 'eyes-closed': 'your eyes were closed', moving: 'your head was moving' };
const CAP_NO_PICTURE = 'Not captured: no picture is reaching the tracker. Start the capture first (the big box must say TRACKING). Try again.';
let capAskedAt = 0;                               // when the button was pressed, or the worker last reported
function onCapture(m) {
  const s = m.status || {}, cap = st.cap;
  if (m.info) st.calib.info = m.info;
  // the saved calibration was handed over but the module could not use it (made by another build): say "none", not "from an earlier session"
  if (m.loaded === false && (st.calib.from === 'saved' || st.calib.from === 'seed')) st.calib = { from: 'none', origin: 'auto', savedAt: null, capturedAt: null, info: m.info || null };
  capAskedAt = performance.now();
  if (m.stalled) { st.cap = { state: 'rejected', progress: 0, reason: 'no-picture', text: CAP_NO_PICTURE, waiting: true }; renderCapture(); return; }
  if (!cap.waiting) return;                       // not asked for by the button: only the calibration line is refreshed
  if (s.state === 'collecting') {
    st.cap = { state: 'collecting', progress: clamp(Number(s.progress) || 0, 0, 1), reason: s.reason || null, text: CAP_HOLD + (s.reason && CAP_FIX[s.reason] ? ' (' + CAP_FIX[s.reason] + ')' : ''), waiting: true };
  } else if (s.state === 'done') {
    calibCleared = false;
    st.calib = { from: 'now', origin: 'capture', savedAt: Date.now(), capturedAt: Date.now(), info: m.info || st.calib.info };
    st.cap = { state: 'done', progress: 1, reason: null, text: 'Captured. This relaxed face is now your neutral. It is saved on this PC and used again next time.', waiting: false };
    if (hub) hub.postMessage({ t: 'body-reset' });                // the body's rest pose is taken from the same moment
  } else if (s.state === 'rejected') {
    const code = m.why || s.why || s.reason || 'timeout', why = CAP_WHY[code];
    // "no face" because no picture came at all (the source stopped meanwhile) is said as what it is
    const noPicture = (code === 'no-face' || !why) && (!st.stats || st.stats.lastFrameAgo < 0 || st.stats.lastFrameAgo > 1200);
    st.cap = { state: 'rejected', progress: 0, reason: noPicture ? 'no-picture' : code, waiting: false,
      text: noPicture ? CAP_NO_PICTURE : 'Not captured: ' + (why ? why : 'I did not get two calm seconds') + '. Nothing was changed. Try again.' };
  }
  renderCapture();
}
function startCapture() {
  const s = st.stats, F = st.info.F;
  const flowing = F && F.ready && s && s.lastFrameAgo >= 0 && s.lastFrameAgo < 1200;
  if (!flowing || !model.F) { st.cap = { state: 'rejected', progress: 0, reason: 'no-picture', text: CAP_NO_PICTURE, waiting: false }; renderCapture(); return; }
  st.cap = { state: 'collecting', progress: 0, reason: null, text: CAP_HOLD, waiting: true };
  capAskedAt = performance.now();
  renderCapture();
  model.F.postMessage({ t: 'cmd', op: 'captureNeutral' });
}
function clearCapture() {
  calibCleared = true;
  dropCalib();
  if (model.F) model.F.postMessage({ t: 'cmd', op: 'clearCalibration' });
  st.calib = { from: 'none', origin: 'auto', savedAt: null, capturedAt: null, info: null };
  st.cap = { state: 'idle', progress: 0, reason: null, text: 'Cleared: nothing is saved now. ' + CAP_IDLE, waiting: false };
  renderCapture();
}
const when = (ms) => {
  const d = new Date(ms), t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? 'today ' + t : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + t;
};
/** Which calibration the face is read with, in plain words. */
function calibUseText() {
  const c = st.calib;
  if (c.from === 'now') return 'captured now (' + when(c.capturedAt) + ').';
  if (c.from === 'none') return 'none yet (press Capture neutral face).';
  if (c.origin === 'seed') return 'the one learned beforehand from your test clips. Press Capture neutral face to replace it with today\'s face.';
  // when it was captured: kept beside the saved data; a file saved without that still has the module's own clock time
  const capAt = c.capturedAt || (c.info && c.info.captured && c.info.capturedAtMs > 1e12 ? c.info.capturedAtMs : null);
  if (capAt && !(c.info && c.info.captured === false)) return 'from an earlier session (captured ' + when(capAt) + '). Capture again if the light or the camera height changed.';
  return 'from an earlier session (saved ' + (c.savedAt ? when(c.savedAt) : 'earlier') + ', no neutral face was captured in it). Press Capture neutral face.';
}
function renderCapture() {
  const c = st.cap, box = $('capBox');
  if (box.dataset.state !== c.state) box.dataset.state = c.state;
  $('calibMsg').textContent = c.text || CAP_IDLE;
  $('capBarWrap').hidden = c.state !== 'collecting';
  $('capBar').style.width = (c.progress * 100).toFixed(0) + '%';
  $('calibUse').textContent = 'Calibration in use: ' + calibUseText();
}

const calibAsked = [];
let calibCleared = false;
// face-signal.js keeps learning his ranges while he performs: what it holds is saved once a minute (while a face is
// tracked), so the next session starts from it.
function keepCalibration() {
  if (calibCleared || !model.F || !st.stats || !st.stats.faceFound) return;
  model.F.postMessage({ t: 'cmd', op: 'getCalibration' });
}
const measures = new Map();
let measureId = 0;
function onHub(ev) {
  const m = ev.data;
  if (m.t === 'stats') { st.stats = m; watchBody(m); uiTick(); }
  else if (m.t === 'relay') { if (st.relay !== m.open) st.relayAt = performance.now(); st.relay = m.open; if (m.open) st.relayWasOpen = true; uiTick(); }
  else if (m.t === 'control') st.control = m;
  else if (m.t === 'obs') { st.obs = m; fillInputs(); }
  else if (m.t === 'obs-source') { settings.sourceName = m.name; saveSettings(); }
  else if (m.t === 'rect') { st.rect = m.rect; st.rectInfo = m.info; }
  else if (m.t === 'pvimg') { if (pv.img) pv.img.close(); pv.img = m.bmp; pv.w = m.w; pv.h = m.h; pv.dirty = true; }
  else if (m.t === 'pv') { pv.pose = m.pose; pv.hands = m.hands; pv.dirty = true; }
  else if (m.t === 'ended') onStreamEnded(m.kind);
  else if (m.t === 'stall') restartWorker(m.who);
  else if (m.t === 'measured') { const r = measures.get(m.id); if (r) { measures.delete(m.id); r(m.data); } }
  else if (m.t === 'tap' && window.__trackerTap) window.__trackerTap(m.text);
  else if (m.t === 'flip') (window.__flips = window.__flips || []).push(m);
}

// ---------------------------------------------------------------- picture sources (all of them end up as frames in the hub)
const vid = $('vid');
let stream = null, fileUrl = null, ownsStream = false;
function stopStream() {
  if (hub) hub.postMessage({ t: 'stop' });
  if (stream && ownsStream) stream.getTracks().forEach((t) => t.stop());
  stream = null; st.capturing = false; st.streamKind = ''; st.trackLabel = '';
}
function stopVideoEl() {
  vid.pause();
  if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; }
  vid.removeAttribute('src'); vid.load();
}
function attachStream(s, kind, owns) {
  const track = s.getVideoTracks()[0];
  if (!track) { st.sourceError = 'That source has no picture.'; return false; }
  if (typeof MediaStreamTrackProcessor !== 'function') { st.sourceError = 'This browser cannot read video frames (use a current Chrome or Edge).'; return false; }
  stream = s; ownsStream = owns; st.capturing = true; st.streamKind = kind; st.trackLabel = track.label || '';
  track.addEventListener('ended', () => { if (stream === s) onStreamEnded(kind); });
  // The frames go straight from the capture to the hub worker; this page is not in between.
  const proc = new MediaStreamTrackProcessor({ track, maxBufferSize: 2 });
  hub.postMessage({ t: 'stream', readable: proc.readable, kind }, [proc.readable]);
  return true;
}
function onStreamEnded(kind) {
  if (!st.capturing || st.streamKind !== kind) return;
  stopStream();
  st.sourceError = kind === 'display' ? 'The window capture stopped (the projector window was closed, or sharing was stopped). Press "Start capture" again.'
    : kind === 'cam' ? 'The webcam stopped.' : 'The video stopped.';
}
async function startDisplay() {
  stopStream(); stopVideoEl();
  st.sourceError = '';
  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      // a big projector window is scaled down by the capture itself: nothing above 1920 x 1440 is of use to the models
      video: { displaySurface: 'window', frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1440 }, cursor: 'never' },
      audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    });
  } catch (e) {
    st.sourceError = e && e.name === 'NotAllowedError' ? 'No window was picked. Press "Start capture" and choose the OBS projector window.' : 'Could not start the capture: ' + (e && e.message ? e.message : e);
    return false;
  }
  return attachStream(s, 'display', true);
}
let fileStarts = 0;
async function startFile(urlOrFile) {
  stopStream(); stopVideoEl();
  st.sourceError = '';
  const mine = ++fileStarts;
  if (typeof urlOrFile === 'string') vid.src = urlOrFile;
  else { fileUrl = URL.createObjectURL(urlOrFile); vid.src = fileUrl; }
  vid.loop = true;
  // Silent: when the wave uses this file its sound is routed into the analyser only; otherwise it is muted.
  vid.muted = !(settings.audio === 'file' && audio.elementSourceFor === vid);
  try { await vid.play(); }
  catch (e) {
    if (mine !== fileStarts) return false;        // a newer pick took over while this one was starting: not an error
    st.sourceError = 'Could not play that file. Is it a video this browser can play (mp4)?';
    return false;
  }
  if (mine !== fileStarts) return false;
  // the file becomes a MediaStream, so a test runs through exactly the same code as the live picture
  const s = vid.captureStream ? vid.captureStream() : null;
  if (!s) { st.sourceError = 'This browser cannot turn a video file into a stream.'; return false; }
  return attachStream(s, 'file', false);
}
async function startCam() {
  stopStream(); stopVideoEl();
  st.sourceError = '';
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: settings.camId ? { exact: settings.camId } : undefined, width: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false,
    });
    listDevices();
    return attachStream(s, 'cam', true);
  } catch (e) {
    st.sourceError = 'Could not open the webcam (another app may be using it): ' + e.message;
    return false;
  }
}
function applySource() {
  st.sourceError = '';
  stopStream(); stopVideoEl();
  pushCfg();
  if (settings.source === 'obs') hub.postMessage({ t: 'obs-connect', password: getPw() });
  showRows();
}

// ---------------------------------------------------------------- the small picture
const pvCanvas = $('preview');
const pctx = pvCanvas.getContext('2d');
const pv = { img: null, w: 0, h: 0, face: null, pose: null, hands: [], dirty: false };
const ARMS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
function drawPreview() {
  requestAnimationFrame(drawPreview);            // stops by itself while this window is hidden, which is what we want
  if (!pv.dirty || !pv.img) return;
  pv.dirty = false;
  const Wd = 360, Hd = Math.round(Wd * pv.img.height / pv.img.width);
  if (pvCanvas.width !== Wd || pvCanvas.height !== Hd) { pvCanvas.width = Wd; pvCanvas.height = Hd; }
  pctx.save();
  if (st.control.mirror) { pctx.translate(Wd, 0); pctx.scale(-1, 1); }
  pctx.drawImage(pv.img, 0, 0, Wd, Hd);
  const fresh = st.stats && st.stats.lastFrameAgo >= 0 && st.stats.lastFrameAgo < 1000;
  if (fresh && pv.pose && settings.body !== 'off') {
    const p = pv.pose;
    pctx.strokeStyle = EMBED ? 'rgba(217,221,226,0.9)' : 'rgba(96,180,255,0.95)'; pctx.lineWidth = 2.5;
    pctx.beginPath();
    for (const [a, b] of ARMS) {
      if (p[a * 3 + 2] < 0.3 || p[b * 3 + 2] < 0.3) continue;
      pctx.moveTo(p[a * 3] * Wd, p[a * 3 + 1] * Hd); pctx.lineTo(p[b * 3] * Wd, p[b * 3 + 1] * Hd);
    }
    pctx.stroke();
    pctx.fillStyle = EMBED ? '#d9dde2' : '#60b4ff';
    for (const i of [11, 12, 13, 14, 15, 16]) { if (p[i * 3 + 2] < 0.3) continue; pctx.beginPath(); pctx.arc(p[i * 3] * Wd, p[i * 3 + 1] * Hd, 4, 0, 6.3); pctx.fill(); }
  }
  if (fresh && pv.face) {
    pctx.fillStyle = 'rgba(255,255,255,0.8)';
    const f = pv.face;
    for (let i = 0; i < f.length; i += 2) pctx.fillRect(f[i] * Wd - 0.6, f[i + 1] * Hd - 0.6, 1.3, 1.3);
  }
  if (fresh && settings.body !== 'off') {
    for (const h of pv.hands || []) {
      pctx.strokeStyle = 'rgba(255,214,102,0.95)'; pctx.lineWidth = 1.6;
      pctx.beginPath();
      for (const [a, b] of BONES) { pctx.moveTo(h[a * 2] * Wd, h[a * 2 + 1] * Hd); pctx.lineTo(h[b * 2] * Wd, h[b * 2 + 1] * Hd); }
      pctx.stroke();
    }
  }
  pctx.restore();
}

// ---------------------------------------------------------------- audio -> wave (v1 hand line; unchanged behaviour, sent through the hub)
const audio = { ctx: null, analyser: null, node: null, stream: null, el: null, elementSourceFor: null, buf: new Float32Array(2048), fileUrl: null };
const elNodes = new WeakMap(); // a media element can be wired to WebAudio only once
const r3 = (v) => Math.round(v * 1000) / 1000;
function stopAudio() {
  if (audio.node) { try { audio.node.disconnect(); } catch (e) { /* ignore */ } audio.node = null; }
  if (audio.stream) { audio.stream.getTracks().forEach((t) => t.stop()); audio.stream = null; }
  if (audio.el && audio.el !== vid) { audio.el.pause(); audio.el.removeAttribute('src'); audio.el.load(); }
  if (audio.fileUrl) { URL.revokeObjectURL(audio.fileUrl); audio.fileUrl = null; }
  audio.el = null; audio.elementSourceFor = null;
  if (settings.source === 'file') vid.muted = true;
  st.audioText = 'off';
}
async function ensureCtx() {
  if (!audio.ctx) {
    audio.ctx = new AudioContext();
    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 2048;
    audio.analyser.smoothingTimeConstant = 0;
    // the analyser is NOT connected to the speakers: this page never makes sound
  }
  if (audio.ctx.state !== 'running') { try { await audio.ctx.resume(); } catch (e) { /* needs a click */ } }
}
function wireElement(el) {
  let node = elNodes.get(el);
  if (!node) { node = audio.ctx.createMediaElementSource(el); elNodes.set(el, node); }
  node.connect(audio.analyser);
  audio.node = node; audio.el = el; audio.elementSourceFor = el;
  el.muted = false; // its sound now goes only into the analyser, not to the speakers
}
async function startAudio(kind, fileOrUrl) {
  stopAudio();
  settings.audio = kind; saveSettings();
  if (kind === 'none') return;
  await ensureCtx();
  try {
    if (kind === 'display') {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 320 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
      });
      if (!s.getAudioTracks().length) {
        s.getTracks().forEach((t) => t.stop());
        st.audioText = 'No sound was shared. Press the button again, choose "Entire screen" and tick "Also share system audio".';
        return;
      }
      audio.stream = s;
      audio.node = audio.ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
      audio.node.connect(audio.analyser);
      s.getAudioTracks()[0].addEventListener('ended', () => { stopAudio(); st.audioText = 'Sharing stopped.'; });
      st.audioText = 'system sound: on';
    } else if (kind === 'mic') {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: settings.micId ? { exact: settings.micId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      audio.stream = s;
      audio.node = audio.ctx.createMediaStreamSource(s);
      audio.node.connect(audio.analyser);
      st.audioText = 'microphone: on';
      listDevices();
    } else if (kind === 'file') {
      if (!fileOrUrl && settings.source === 'file' && vid.src) {
        wireElement(vid);
        st.audioText = 'sound of the test video: on (silent on the speakers)';
      } else if (fileOrUrl) {
        const el = $('aud');
        if (typeof fileOrUrl === 'string') el.src = fileOrUrl;
        else { audio.fileUrl = URL.createObjectURL(fileOrUrl); el.src = audio.fileUrl; }
        el.loop = true;
        wireElement(el);
        await el.play();
        st.audioText = 'audio file: on (silent on the speakers)';
      } else {
        st.audioText = 'Pick an audio or video file.';
      }
    }
  } catch (e) {
    st.audioText = 'Could not start the sound: ' + (e && e.message ? e.message : e);
  }
}
function waveTick() {
  if (!audio.ctx || !audio.node || audio.ctx.state !== 'running' || !hub) return;
  audio.analyser.getFloatTimeDomainData(audio.buf);
  const N = 1024; const off = audio.buf.length - N; const step = N / 64;
  const samples = new Array(64);
  let sq = 0;
  for (let i = 0; i < 64; i++) {
    let a = 0;
    for (let j = 0; j < step; j++) { const v = audio.buf[off + i * step + j]; a += v; sq += v * v; }
    samples[i] = r3(clamp(a / step, -1, 1));
  }
  hub.postMessage({ t: 'send', text: JSON.stringify({ t: 'wave', samples, rms: r3(Math.sqrt(sq / N)), at: Date.now() }) });
  st.wavePublished++;
}
async function listDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    for (const [id, kind] of [['camId', 'videoinput'], ['micId', 'audioinput']]) {
      const sel = $(id);
      sel.textContent = '';
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '(default)'; sel.appendChild(o0);
      devs.filter((d) => d.kind === kind && d.deviceId).forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || (kind + ' ' + (i + 1));
        sel.appendChild(o);
      });
      sel.value = settings[id] || '';
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- UI
function showRows() {
  for (const el of document.querySelectorAll('[data-src]')) el.hidden = el.dataset.src !== settings.source;
  for (const el of document.querySelectorAll('[data-notsrc]')) el.hidden = el.dataset.notsrc === settings.source;
  for (const el of document.querySelectorAll('[data-aud]')) el.hidden = el.dataset.aud !== $('audio').value;
  for (const el of document.querySelectorAll('[data-crop]')) el.hidden = el.dataset.crop !== settings.crop;
  for (const el of document.querySelectorAll('[data-obsview]')) el.hidden = el.dataset.obsview !== settings.obsView;
}
let inputsShown = '';
function fillInputs() {
  const names = st.obs.inputs || [];
  const key = names.join('\n') + '|' + settings.sourceName;
  if (key === inputsShown) return;
  inputsShown = key;
  const sel = $('sourceName');
  sel.textContent = '';
  const first = document.createElement('option');
  first.value = ''; first.textContent = names.length ? '-- pick your camera source --' : (st.obs.state === 'connected' ? '(OBS has no sources)' : '(connect first)');
  sel.appendChild(first);
  for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
  if (settings.sourceName && names.includes(settings.sourceName)) sel.value = settings.sourceName;
}

/** Body + hands under 10 checks a second for 3 s while the picture flows: the arms cannot follow properly. Said as a warning. */
function watchBody(s) {
  const flowing = settings.body !== 'off' && s.live && s.inFps >= 12 && (s.bodyMax || 30) >= 10 && BODY_WORKERS.every((w) => s.ready[w]);
  const now = performance.now();
  if (!flowing) { st.bodySlow = false; st.bodySlowSince = 0; return; }
  if (s.bodyFps < 10) { if (!st.bodySlowSince) st.bodySlowSince = now; if (now - st.bodySlowSince >= 3000) st.bodySlow = true; }
  else if (s.bodyFps >= 11 || !st.bodySlow) { st.bodySlow = false; st.bodySlowSince = 0; }
}
/** The link to the avatar server is down (the hub tries again every 1.5 s). Only the very first connection gets 2.5 s to come up. */
const relayDown = () => !st.relay && (st.relayWasOpen || performance.now() - st.relayAt > 2500);
function computeStatus() {
  const s = st.stats, F = st.info.F;
  let err = st.workerError.hub || st.workerError.F || (F && !F.ready && F.error);
  if (!err && settings.body !== 'off') for (const who of BODY_WORKERS) err = err || st.workerError[who] || (st.info[who] && !st.info[who].ready && st.info[who].error);
  if (err) return ['bad', 'TRACKER ERROR', err];
  // never green while nothing reaches the avatar
  if (relayDown()) return ['bad', 'AVATAR NOT CONNECTED', 'Nothing reaches the avatar: this page cannot talk to the avatar server. Is its black window (start-vtuber.bat) still open? Start it again; this page reconnects by itself.'];
  if (!s || !F || !F.ready) return ['wait', 'LOADING', 'Loading the tracking models...'];
  if (settings.source === 'obs') {
    if (st.obs.state === 'auth') return ['bad', 'WRONG PASSWORD', st.obs.text];
    if (st.obs.state !== 'connected') return ['bad', 'NOT CONNECTED', st.obs.text || 'Not connected to OBS.'];
    if (!settings.sourceName) return ['warn', 'NO FRAMES', 'Connected to OBS. Now pick your camera source in the list.'];
  } else if (!st.capturing) {
    const what = settings.source === 'display' ? 'Press "Start capture" and pick the OBS projector window.' : settings.source === 'file' ? 'Pick a video file.' : 'Press Start to open the webcam.';
    return ['warn', 'NOT STARTED', st.sourceError || what];
  }
  if (s.lastFrameAgo < 0 || s.lastFrameAgo > 1200) {
    const why = settings.source === 'obs' ? (st.obs.sourceError || 'Connected to OBS, but no picture is coming from "' + settings.sourceName + '".')
      : settings.source === 'display' ? 'The window is captured but no picture is arriving. Is the projector window minimised? Is the camera on?' : 'No picture yet.';
    return ['warn', 'NO FRAMES', st.sourceError || why];
  }
  if (!s.faceFound) return ['warn', 'NO FACE', 'Picture is coming in, but no face is visible.'];
  return ['good', 'TRACKING', 'Face found. ' + s.perfFps.toFixed(0) + ' updates a second, ' + s.delay.med.toFixed(0) + ' ms behind the camera.'];
}
function warnings() {
  const out = [];
  const s = st.stats, F = st.info.F;
  const all = [F, ...BODY_WORKERS.map((w) => st.info[w])];
  for (const i of all) if (i && i.warn) out.push(i.warn);
  if (F && F.stub) out.push('Face signal: using the simple stand-in (' + (F.stubWhy || 'face-signal.js missing') + ').');
  if (s && s.bodyStub && settings.body !== 'off') out.push('Body signal: using the simple stand-in (' + (s.bodyStubWhy || 'body-signal.js missing') + ').');
  for (const i of all) if (i && /swiftshader|basic render|software/i.test(i.renderer || '')) { out.push('The browser is drawing without the graphics card (' + i.renderer + '): tracking will be slow.'); break; }
  if (F && F.signalErrors) out.push('face-signal.js threw ' + F.signalErrors + ' times: ' + F.lastSignalError);
  if (s && s.bodySignalErrors) out.push('body-signal.js threw ' + s.bodySignalErrors + ' times: ' + s.lastBodySignalError);
  if (st.bodySlow && s) out.push('Hands paused or slow: the PC is too busy (only ' + s.bodyFps.toFixed(0) + ' body checks a second, 10 are needed). Close other programs if you can.');
  if (s && s.shedLevel > 0) out.push('The PC is busy: body + hands lightened (' + s.shed + ').');
  if (s && st.relay && !s.avatarHeard) out.push('The avatar page is not open: nothing is listening. In OBS, check that the avatar Browser source is there and showing.');
  if (s && s.otherTracker) out.push(s.live ? 'Another tracker page is also sending to the avatar. Close one of the two.' : 'Another tracker page is doing the tracking. This one stays silent; close it if you do not need it.');
  if (settings.source === 'display' && settings.crop === 'auto' && st.rectInfo && st.rectInfo.conf < 0.5 && st.capturing) out.push('Not sure where the picture is inside the window. Check the small picture; if it shows the title bar or black bars, choose "Set by hand".');
  if (s && s.prepErrors) out.push('Could not cut the picture out of the frame (' + s.prepError + ').');
  const nr = st.restarts.F + st.restarts.P + st.restarts.H;
  if (nr > 0) out.push('A tracking worker was restarted ' + nr + ' time(s) after it stopped answering.');
  return out;
}
const ms = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
function uiTick() {
  const [cls, big, detail] = computeStatus();
  const box = $('status');
  if (box.dataset.cls !== cls) { box.dataset.cls = cls; box.className = 'status ' + cls; }
  $('statusBig').textContent = big;
  $('statusDetail').textContent = detail;
  const w = warnings();
  $('statusWarn').hidden = !w.length;
  $('statusWarn').textContent = w.join('\n');
  const s = st.stats, F = st.info.F, P = st.info.P, H = SPLIT ? st.info.H : st.info.P;
  if (s) {
    $('mIn').textContent = s.inFps.toFixed(0);
    $('mFace').textContent = s.faceFps.toFixed(0);
    $('mFaceMs').textContent = '(model ' + ms(s.ms.face) + ' ms)';
    $('mBody').textContent = settings.body === 'off' ? 'off' : s.bodyFps.toFixed(0);
    $('mBodyMs').textContent = settings.body === 'off' ? '' : '(pose ' + ms(s.ms.pose) + ' ms + hands ' + ms(s.ms.hands) + ' ms)';
    $('mPerf').textContent = s.perfFps.toFixed(0);
    $('mDelay').textContent = s.delay.med.toFixed(0);
    $('mDelay95').textContent = '(19 of 20 under ' + s.delay.p95.toFixed(0) + ' ms)' + (settings.source === 'obs' ? ' incl. OBS answer ' + ms(s.ms.rpc) + ' + unpack ' + ms(s.ms.dec) + ' ms' : '');
    $('mDrop').textContent = 'face ' + s.drop.F + ', body ' + s.drop.B + ' (of ' + s.frames.in + ' in)';
    $('mSize').textContent = s.pic[0] ? s.pic[0] + ' x ' + s.pic[1] + (s.cropped ? ' (cut from ' + s.src[0] + ' x ' + s.src[1] + ')' : '') : '--';
    $('mShed').textContent = s.shed === 'off' ? 'never (switched off)' : s.shedLevel ? s.shed : 'no';
    $('mShed').className = s.shedLevel ? 'warnv' : '';
    $('mMirror').textContent = s.mirror ? 'ON' : 'off';
    $('mLine').textContent = s.line ? 'ON' : 'off';
  }
  const runs = [];
  if (F && F.ready) runs.push('face ' + (F.delegate === 'GPU' ? 'graphics card' : 'PROCESSOR'));
  if (P && P.ready && settings.body !== 'off') runs.push('pose ' + (P.poseDelegate === 'GPU' ? 'graphics card' : 'PROCESSOR') + ' (' + P.poseModel + ')');
  if (H && H.ready && settings.body !== 'off') runs.push('hands ' + (H.handsDelegate === 'GPU' ? 'graphics card' : 'PROCESSOR'));
  $('mRuns').textContent = runs.length ? runs.join(', ') + (F && F.mp ? '; MediaPipe ' + F.mp : '') : '--';
  $('mRuns').className = (F && F.fellBack) || (P && P.fellBack) || (H && H.fellBack) ? 'warnv' : '';
  const heard = st.relay && s && s.avatarHeard;
  $('mRelay').textContent = !st.relay ? 'not connected (start the avatar server)' : heard ? 'connected, the avatar page is listening' : 'server connected, but no avatar page is open';
  $('mRelay').className = !st.relay ? 'badv' : heard ? 'okv' : 'warnv';
  // a capture the face worker never answered (it was restarted meanwhile) must not sit there for ever
  if (st.cap.state === 'collecting' && performance.now() - capAskedAt > 9000) { st.cap = { state: 'rejected', progress: 0, reason: 'no-answer', text: 'Not captured: the tracker did not answer. Nothing was changed. Try again.', waiting: true }; }
  renderCapture();
  $('audioState').textContent = st.audioText;
  $('pwState').textContent = getPw() ? 'A password is saved (hidden).' : 'No password saved.';
  $('capState').textContent = st.capturing && st.streamKind === 'display' ? 'capturing' + (st.trackLabel ? ': ' + st.trackLabel : '') : '';
  $('obsViewState').textContent = settings.obsView === 'auto' ? (st.obs.viewText || '') : '';
  const ri = st.rectInfo, r = st.rect;
  $('cropState').textContent = settings.source !== 'display' || !st.capturing ? ''
    : settings.crop === 'off' ? 'Using the whole window.'
      : settings.crop === 'manual' ? 'Cutting off the margins you set.'
        : r && ri ? 'Picture found: ' + r.w + ' x ' + r.h + ' inside the ' + ri.src[0] + ' x ' + ri.src[1] + ' window (title bar ' + ri.title + ' px; bars left ' + ri.bars.l + ', right ' + ri.bars.r + ', top ' + ri.bars.t + ', bottom ' + ri.bars.b + '). ' + (ri.conf >= 0.5 ? 'Sure.' : 'NOT sure: check the small picture.')
          : 'Looking for the picture...';
}

function bindUi() {
  const bind = (id, key, conv, after) => {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('change', () => { settings[key] = conv ? conv(el.value) : el.value; saveSettings(); showRows(); if (after) after(); else pushCfg(); });
  };
  const int = (lo, hi, d) => (v) => clamp(parseInt(v, 10) || d, lo, hi);
  bind('source', 'source', null, applySource);
  bind('crop', 'crop');
  for (const k of ['cropL', 'cropR', 'cropT', 'cropB']) bind(k, k, int(0, 4000, 0));
  bind('turn', 'turn', (v) => ([0, 90, 180, 270].includes(Number(v)) ? Number(v) : 0));
  bind('flip', 'flip');
  bind('host', 'host', (v) => v.trim() || '127.0.0.1');
  bind('port', 'port', int(1, 65535, 4455));
  bind('obsWidth', 'obsWidth', int(160, 1920, 540));
  bind('obsFps', 'obsFps', int(5, 60, 30));
  bind('obsView', 'obsView');
  bind('obsTurn', 'obsTurn', (v) => ([0, 90, 180, 270].includes(Number(v)) ? Number(v) : 0));
  bind('obsFlip', 'obsFlip');
  for (const k of ['obsCropL', 'obsCropR', 'obsCropT', 'obsCropB']) bind(k, k, (v) => clamp(parseFloat(v) || 0, 0, 45));
  bind('mirror', 'mirror');
  bind('line', 'line');
  bind('body', 'body');
  bind('faceMax', 'faceMax', int(1, 60, 30));
  bind('bodyMax', 'bodyMax', int(1, 60, 30));
  bind('shed', 'shed');
  bind('pv', 'pv', null, pushPreview);
  bind('delegate', 'delegate', null, () => { for (const who of ['F', ...BODY_WORKERS]) model[who].postMessage({ t: 'delegate', delegate: settings.delegate }); });
  bind('camId', 'camId', null, () => { if (settings.source === 'cam' && st.capturing) startCam(); });
  bind('micId', 'micId', null, () => {});
  $('capStart').addEventListener('click', () => { startDisplay(); });
  $('capStop').addEventListener('click', () => { stopStream(); });
  $('camStart').addEventListener('click', () => { startCam(); });
  $('cropFind').addEventListener('click', () => { hub.postMessage({ t: 'find-rect' }); });
  $('sourceName').addEventListener('change', () => { settings.sourceName = $('sourceName').value; saveSettings(); pushCfg(); });
  $('refresh').addEventListener('click', () => hub.postMessage({ t: 'obs-refresh' }));
  $('connect').addEventListener('click', () => {
    const pw = $('password');
    if (pw && pw.value && !EMBED) { try { localStorage.setItem(LS_PW, pw.value); } catch (e) { /* ignore */ } pw.value = ''; }
    settings.host = $('host').value.trim() || '127.0.0.1';
    settings.port = clamp(parseInt($('port').value, 10) || 4455, 1, 65535);
    saveSettings(); pushCfg();
    hub.postMessage({ t: 'obs-connect', password: getPw() });
  });
  $('forget').addEventListener('click', () => { try { localStorage.removeItem(LS_PW); } catch (e) { /* ignore */ } });
  $('videoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await startFile(f);
    if ($('audio').value === 'file' && !$('audioFile').files[0]) startAudio('file');
  });
  // audio is started by a click (browsers need one before they allow sound capture)
  $('audio').value = 'none';
  $('audio').addEventListener('change', showRows);
  $('audioStart').addEventListener('click', () => {
    const kind = $('audio').value;
    if (kind === 'file') startAudio('file', $('audioFile').files[0] || null);
    else startAudio(kind);
  });
  $('audioStop').addEventListener('click', () => { stopAudio(); settings.audio = 'none'; saveSettings(); });
  $('calib').addEventListener('click', startCapture);
  $('calibClear').addEventListener('click', clearCapture);
  document.addEventListener('visibilitychange', pushPreview);
}

// Timers for the song wave live in a worker so they keep their pace when this window is in the background.
const tickerSrc = 'let a=null;onmessage=function(e){if(a)clearInterval(a);a=null;if(e.data>0)a=setInterval(function(){postMessage(0)},e.data)}';
const mkTicker = (fn) => {
  const w = new Worker(URL.createObjectURL(new Blob([tickerSrc], { type: 'text/javascript' })));
  w.onmessage = fn;
  return w;
};

// ---------------------------------------------------------------- dev hooks (read-only; never contain the password)
window.__tracker = {
  state: () => {
    const [cls, big, detail] = computeStatus();
    return {
      status: big, statusClass: cls, detail, warnings: warnings(), stats: st.stats, info: st.info, relay: st.relay, control: st.control,
      obs: { state: st.obs.state, text: st.obs.text, sourceError: st.obs.sourceError, viewText: st.obs.viewText, inputs: st.obs.inputs }, capturing: st.capturing, streamKind: st.streamKind,
      trackLabel: st.trackLabel, sourceError: st.sourceError, rect: st.rect, rectInfo: st.rectInfo, restarts: st.restarts, settings: { ...settings }, mp: MP_VERSION, split: SPLIT,
      bodyReady: BODY_WORKERS.every((w) => st.info[w] && st.info[w].ready),
      wave: st.wavePublished, audio: st.audioText, visible: document.visibilityState, calibKind: st.calibKind, calibSeed: st.calib.from === 'seed',
      calib: { ...st.calib, text: calibUseText() }, capture: { ...st.cap }, bodySlow: st.bodySlow,
    };
  },
  set: (patch) => { Object.assign(settings, patch); saveSettings(); for (const k in patch) { const el = $(k); if (el) el.value = patch[k]; } showRows(); pushCfg(); },
  /** start: begin collecting every sample; stop: resolves with the raw numbers of the run */
  measure: (on) => new Promise((resolve) => { if (on) { hub.postMessage({ t: 'measure', on: true }); resolve(true); } else { const id = ++measureId; measures.set(id, resolve); hub.postMessage({ t: 'measure', on: false, id }); } }),
  /** what calibration the face signal module holds right now */
  calibration: () => new Promise((resolve) => { calibAsked.push(resolve); model.F.postMessage({ t: 'cmd', op: 'getCalibration' }); }),
  startFile, startDisplay, startCam, startAudio, applySource, stopStream, restartWorker,
  video: vid,
  /** the latest small picture as it came in (360 wide, before any dots are drawn on it); the same object until a new one */
  picture: () => pv.img,
};

// ---------------------------------------------------------------- boot
(async function boot() {
  bindUi();
  showRows();
  await loadStartCalib();
  renderCapture();
  startWorkers();
  setInterval(keepCalibration, 60000);
  requestAnimationFrame(drawPreview);
  mkTicker(waveTick).postMessage(33);
  setInterval(uiTick, 1000);          // the hub's numbers redraw the page twice a second; this covers the time before they come
  // dev/test only: ?videoUrl= and ?audioUrl= load same-origin test files without the file picker
  if (Q.get('videoUrl')) { settings.source = 'file'; $('source').value = 'file'; showRows(); pushCfg(); await startFile(Q.get('videoUrl')); }
  else applySource();
  if (Q.get('audioUrl')) { $('audio').value = 'file'; showRows(); await startAudio('file', Q.get('audioUrl') === 'video' ? null : Q.get('audioUrl')); }
})();
