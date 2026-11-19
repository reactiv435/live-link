// Tracker v2, Worker F: FaceLandmarker on every frame it is handed, then tracking/lib/face-signal.js (FACE agent) turns
// the raw result into the `face` part of the perf message. Classic worker.
//   page -> worker : init { port, delegate, mp, mirror, calib, forceStub }, cmd { op }, preview { on }
//   hub  -> worker : (on the port) frame { frame, at, seq, w, h }, mirror { on }
//   hub  -> worker : raw { on }   (the Mask is the chosen character: the raw result goes along with every face message)
//   worker -> hub  : face { seq, at, ok, face, ms: [model, signal], found, raw }, state { ready }   (ok false = the model did not run;
//                    raw = js/mask-wire.js packFace: the 478 points + 52 scores + matrix, only while the Mask is chosen)
//   worker -> page : mask-rest { ok, frames: [raw ...], w, h }   the raw results of a guided capture when it ends (ok = it ended `done`): the Mask's resting face
//   worker -> page : info { ... }, calib { data, info }, pv { lm },
//                    capture { status: { state, progress, reason, seq }, info: { captured, capturedAtMs, adaptive, samples }, why, stalled }
//                      = the guided "Capture neutral face" (V2-FIX-ROUND.md): about 10 a second while it collects, once when it ends
'use strict';
importScripts('./lib/worker-common.js', './lib/scheduler.js');
let Wire = null;
try { importScripts('../js/mask-wire.js'); Wire = self.VTMaskWire || null; } catch (e) { Wire = null; }   // the Mask's raw points; without the file only the Mask is lost
const { epoch, loadVision, glRenderer, makeTask, warmUp } = self.VTW;

// the FACE agent's module; the stand-in only when that file is missing or broken
let FS = null, stub = false, stubWhy = '';
try { importScripts('./lib/face-signal.js'); FS = self.VTFaceSignal || null; if (!FS) stubWhy = 'face-signal.js loaded but VTFaceSignal is missing'; }
catch (e) { stubWhy = 'face-signal.js could not be loaded'; }
if (!FS) { importScripts('./lib/signal-stubs.js'); FS = self.VTFaceSignalStub; stub = true; }

const MODEL = './vendor/models/face_landmarker.task';
const OPTS = { numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5 };
let hub = null, task = null, signal = null;
let cfg = { delegate: 'GPU', mp: '0.10.21', mirror: false };
const st = { ready: false, delegate: '', fellBack: false, error: '', renderer: '', rebuilds: 0, lastRebuildWhy: '', lost: 0, fails: 0, signalErrors: 0, lastSignalError: '', warn: '' };
let t0ms = null, lastTs = 0, preview = false, lastPv = 0, building = false, forcedCpu = false;
let rawOn = false, rawSeq = 0;          // the Mask is chosen: every result also goes out raw
let restFrames = null;                  // while a guided capture runs: its raw results (at most 6 s of them)
const drift = new self.VTSched.DriftWatch();

// ---------------------------------------------------------------- the guided neutral capture
// face-signal.js collects and judges the frames (captureNeutral / captureStatus / calibrationInfo); this worker only
// reports what it says. The page never shows "Captured" before the module's state is `done`.
const CAPTURE = { holdMs: 2000, timeoutMs: 5000 };
let guide = null;       // the three capture calls of the signal module
let capWatch = null;    // while a capture runs: { seq, t0, postAt, why: { reason: frames }, timer, stalled }
/** The three calls: from the module itself, or (a face-signal.js from before the guided capture) read from what it does offer. */
function guidedApi(sig) {
  if (typeof sig.captureStatus === 'function' && typeof sig.calibrationInfo === 'function') return sig;
  let cur = { state: 'idle', progress: 0, reason: null, seq: 0 }, t0 = 0, mark = 0;
  const held = () => { try { return sig.getCalibration() || {}; } catch (e) { return {}; } };
  return {
    legacy: true,
    captureNeutral() { mark = held().capturedAt || 0; t0 = epoch(); sig.captureNeutral(1000); cur = { state: 'collecting', progress: 0, reason: null, seq: cur.seq }; },
    captureStatus() {
      if (cur.state === 'collecting') {
        const at = held().capturedAt || 0, el = epoch() - t0;
        if (at && at !== mark) cur = { state: 'done', progress: 1, reason: null, seq: cur.seq + 1 };      // the old module only says so when its capture is really in
        else if (el > CAPTURE.timeoutMs) cur = { state: 'rejected', progress: 0, reason: 'timeout', seq: cur.seq + 1 };
        else cur.progress = Math.min(0.9, el / 1400);
      }
      return { ...cur };
    },
    calibrationInfo() { const c = held(); return { captured: !!c.capturedAt, capturedAtMs: c.capturedAt || null, adaptive: true, samples: c.frames || 0 }; },
  };
}
const calibInfo = () => { try { return guide.calibrationInfo(); } catch (e) { return null; } };
const captureNow = () => { try { return guide.captureStatus(); } catch (e) { return { state: 'idle', progress: 0, reason: null, seq: 0 }; } };
const postCapture = (status, extra) => self.postMessage({ t: 'capture', who: 'F', status, info: calibInfo(), legacy: !!guide.legacy, ...extra });
function stopWatch() { if (capWatch) { clearInterval(capWatch.timer); capWatch = null; } }
function startCapture() {
  stopWatch();
  try { guide.captureNeutral({ ...CAPTURE }); }
  catch (e) { postCapture({ state: 'rejected', progress: 0, reason: 'timeout', seq: -1 }, { error: String(e && e.message ? e.message : e) }); return; }
  const s = captureNow();
  capWatch = { seq: s.seq, t0: epoch(), postAt: 0, why: {}, stalled: false, timer: setInterval(() => watchCapture(false), 250) };
  restFrames = Wire ? { list: [], w: 0, h: 0 } : null;
  postCapture(s);
}
/** After every frame while a capture runs (and on a slow timer, so the page also hears about a capture that no frame reaches). */
function watchCapture(fromFrame) {
  if (!capWatch) return;
  const s = captureNow(), now = epoch();
  if (s.seq !== capWatch.seq || s.state !== 'collecting') {            // it ended: done or rejected
    let why = null, n = 0;
    for (const k in capWatch.why) if (capWatch.why[k] > n) { n = capWatch.why[k]; why = k; }
    stopWatch();
    postCapture(s, { why: s.why || why });                              // why = what was wrong in most of the frames that were not accepted (the module's own count when it gives one)
    if (s.state === 'done') sendCalib();
    // the same calm seconds are the Mask's resting face: the page makes it from these raw results (the last 2.5 s)
    const rest = restFrames; restFrames = null;
    // (ok false = the capture was NOT accepted: the page then only uses them while the Mask has no resting face at all)
    if (rest && rest.list.length >= 20) { const list = rest.list.slice(-75); try { self.postMessage({ t: 'mask-rest', who: 'F', ok: s.state === 'done', frames: list, w: rest.w, h: rest.h }, list); } catch (e) { /* the page does without */ } }
    return;
  }
  if (fromFrame && s.reason) capWatch.why[s.reason] = (capWatch.why[s.reason] || 0) + 1;
  if (!fromFrame && !capWatch.stalled && now - capWatch.t0 > CAPTURE.timeoutMs + 1500) {
    // no frame reached the module, so it could not even time out. The page is told; the module is still watched
    // after every frame (should it finish later, the page hears that too).
    capWatch.stalled = true; clearInterval(capWatch.timer);
    postCapture(s, { stalled: true });
    return;
  }
  if (!capWatch.stalled && now - capWatch.postAt >= 100) { capWatch.postAt = now; postCapture(s); }
}

const info = () => self.postMessage({ t: 'info', who: 'F', ...st, stub, stubWhy, mp: self.VTW.version });
const setReady = (v) => { st.ready = v; if (hub) hub.postMessage({ t: 'state', ready: v }); info(); };

async function build(why) {
  if (building) return;
  building = true;
  setReady(false);
  try {
    if (task) { try { task.close(); } catch (e) { /* ignore */ } task = null; }
    const r = await makeTask('FaceLandmarker', MODEL, OPTS, cfg.delegate, () => { st.lost++; build('the graphics context was lost'); });
    lastTs = warmUp(r.task, lastTs);
    task = r.task; st.delegate = r.delegate; st.fellBack = r.fellBack; st.fails = 0;
    st.warn = r.fellBack ? 'Face tracking fell back to the PROCESSOR (slow): ' + (r.error || '')
      : forcedCpu ? 'Face tracking was moved to the PROCESSOR after repeated graphics errors (slow).' : '';
    if (forcedCpu) st.fellBack = true;
    if (why) { st.rebuilds++; st.lastRebuildWhy = why; }
    if (why !== 'slow') drift.reset(epoch());       // a new task for another reason: what the watchdog learned no longer applies
    st.error = '';
    building = false;
    setReady(true);
  } catch (e) {
    building = false;
    st.error = 'Could not load the face model: ' + (e && e.message ? e.message : e);
    info();
  }
}

function onFrame(m) {
  const frame = m.frame;
  let res = null, part = null;
  const a = performance.now();
  if (task && st.ready) {
    try {
      if (t0ms === null) t0ms = m.at;
      const ts = Math.max(lastTs + 1, Math.round(m.at - t0ms));   // strictly rising ms, taken from the capture time
      lastTs = ts;
      res = task.detectForVideo(frame, ts);
      st.fails = 0;
    } catch (e) {
      st.fails++;
      st.error = 'face model error: ' + (e && e.message ? e.message : e);
    }
  }
  const b = performance.now();
  const found = !!(res && res.faceLandmarks && res.faceLandmarks.length);
  if (res) {
    try { part = signal.process(res, m.at, { width: m.w, height: m.h }) || null; }
    catch (e) { st.signalErrors++; st.lastSignalError = String(e && e.message ? e.message : e); part = null; }
  }
  const c = performance.now();
  try { frame.close(); } catch (e) { /* ignore */ }
  // the Mask: the result as MediaPipe gave it (un-mirrored points, its own score order, its matrix), about 6 kB
  let raw = null;
  if (Wire && res && (rawOn || (restFrames && found))) {
    try {
      const mats = res.facialTransformationMatrixes, cats = res.faceBlendshapes;
      const one = found ? Wire.packFace(res.faceLandmarks[0], cats && cats[0] ? cats[0].categories : null, mats && mats[0] ? mats[0].data : null, m.w, m.h, m.at, ++rawSeq) : Wire.packFace(null, null, null, m.w, m.h, m.at, ++rawSeq);
      if (restFrames && found && restFrames.list.length < 180) { restFrames.list.push(rawOn ? one.slice(0) : one); restFrames.w = m.w; restFrames.h = m.h; }
      if (rawOn) raw = one;
    } catch (e) { raw = null; }
  }
  if (raw) hub.postMessage({ t: 'face', seq: m.seq, at: m.at, ok: true, face: part, found, ms: [b - a, c - b], raw }, [raw]);
  else hub.postMessage({ t: 'face', seq: m.seq, at: m.at, ok: res !== null, face: part, found, ms: [b - a, c - b] });
  if (capWatch) watchCapture(true);
  if (preview && found && c - lastPv > 90) {
    lastPv = c;
    const src = res.faceLandmarks[0];
    const lm = new Float32Array(src.length * 2);
    for (let i = 0; i < src.length; i++) { lm[i * 2] = src[i].x; lm[i * 2 + 1] = src[i].y; }
    self.postMessage({ t: 'pv', who: 'F', lm, at: m.at }, [lm.buffer]);
  } else if (preview && !found && c - lastPv > 250) { lastPv = c; self.postMessage({ t: 'pv', who: 'F', lm: null, at: m.at }); }
  // watchdogs: repeated errors, or the model's time creeping up (research 8.1)
  const now = epoch();
  if (res) drift.add(b - a, now, found);          // only frames with a face count: an empty picture is quicker and says nothing
  if (st.fails >= 3) {
    if (st.delegate === 'GPU' && st.rebuilds >= 2) { cfg.delegate = 'CPU'; forcedCpu = true; }      // the graphics card keeps failing: use the processor, and say so
    build('errors');
  } else if (drift.check(now)) { drift.rebuilt(now); build('slow'); }
}

function onHub(ev) {
  const m = ev.data;
  if (m.t === 'frame') onFrame(m);
  else if (m.t === 'mirror') { cfg.mirror = !!m.on; if (signal) signal.setMirror(cfg.mirror); }
  else if (m.t === 'raw') rawOn = !!m.on;
}

const sendCalib = () => { try { self.postMessage({ t: 'calib', who: 'F', data: signal.getCalibration(), stub, info: calibInfo() }); } catch (e) { /* ignore */ } };
const newSignal = () => { signal = FS.create({ mirror: cfg.mirror }); guide = guidedApi(signal); };

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.t === 'init') {
    cfg = { ...cfg, delegate: m.delegate === 'CPU' ? 'CPU' : 'GPU', mp: m.mp || '0.10.21', mirror: !!m.mirror };
    hub = m.port; hub.onmessage = onHub;
    if (m.forceStub && !stub) {                     // ?facesig=stub: the page tested against the stand-in's guided capture
      try { importScripts('./lib/signal-stubs.js'); FS = self.VTFaceSignalStub; stub = true; stubWhy = 'chosen with ?facesig=stub, for testing'; } catch (e) { /* keep the real one */ }
    }
    newSignal();
    // a saved calibration is only handed to the module that made it (the stand-in's would mean nothing to the real one)
    let loaded = m.calib ? false : undefined;       // undefined = none was handed over
    if (m.calib && !!m.calibStub === stub) { try { signal.setCalibration(m.calib); loaded = true; } catch (e) { /* a calibration from an older build: ignore */ } }
    postCapture(captureNow(), { loaded });          // so the page can say which calibration is in use
    st.renderer = glRenderer();
    try { await loadVision(cfg.mp); } catch (e) { st.error = 'Could not load MediaPipe: ' + (e && e.message ? e.message : e); info(); return; }
    await build('');
  } else if (m.t === 'preview') preview = !!m.on;
  else if (m.t === 'delegate') { cfg.delegate = m.delegate === 'CPU' ? 'CPU' : 'GPU'; st.rebuilds = 0; forcedCpu = false; build(''); }
  else if (m.t === 'cmd' && signal) {
    if (m.op === 'captureNeutral') startCapture();    // saved when, and only when, the module says `done`
    else if (m.op === 'getCalibration') sendCalib();
    else if (m.op === 'setCalibration') { try { signal.setCalibration(m.data); } catch (e) { /* ignore */ } postCapture(captureNow()); }
    else if (m.op === 'clearCalibration') { stopWatch(); newSignal(); postCapture(captureNow(), { cleared: true }); }
    else if (m.op === 'reset') { try { signal.reset(); } catch (e) { /* ignore */ } }
  }
};
