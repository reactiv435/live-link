// Tracker v2, the body model worker: PoseLandmarker (full, or lite when shedding load) and / or HandLandmarker on the
// frame it is handed. It only runs the models; the hub joins the raw results and calls tracking/lib/body-signal.js.
// One copy runs both models one after the other ("both"), or two copies run one model each on the same frame at the
// same time ("pose" + "hands"). Classic worker.
//   page -> worker : init { port, who, delegate, mp, tasks: 'both' | 'pose' | 'hands', pose: 'full' | 'lite' }, delegate { delegate }
//   hub  -> worker : (on the port) frame { frame, at, seq, w, h, runHands, small }, shed { lite }
//   worker -> hub  : raw { seq, at, w, h, ok, pose?, hands?, ms: [pose, hands] }, state { ready }
//       pose:  undefined = not this worker's job | null = the model did not run | { n, lm, world }  (33 x [x, y, z, visibility, presence])
//       hands: undefined = not this worker's job | null = not run for this frame | [{ lm, world, handed, score }]  (21 x [x, y, z])
//   worker -> page : info { ... }
'use strict';
importScripts('./lib/worker-common.js', './lib/scheduler.js', './lib/raw-pack.js');
const { packPose, packHands } = self.VTRaw;
const { epoch, loadVision, glRenderer, makeTask, warmUp } = self.VTW;

const POSE = { full: './vendor/models/pose_landmarker_full.task', lite: './vendor/models/pose_landmarker_lite.task' };
const POSE_OPTS = { numPoses: 1, outputSegmentationMasks: false, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 };
const HAND = './vendor/models/hand_landmarker.task';
// 0.25 instead of MediaPipe's 0.5: measured by the BODY agent on three clips, it finds far more real hands (127 -> 251,
// 307 -> 444, 552 -> 588 frames) at no extra model time; the few false ones sit at the picture edge and are rejected
// by body-signal.js.
let HAND_OPTS = { numHands: 2, minHandDetectionConfidence: 0.25, minHandPresenceConfidence: 0.25, minTrackingConfidence: 0.25 };

let hub = null, pose = null, hands = null, who = 'P';
let cfg = { delegate: 'GPU', mp: '0.10.21', tasks: 'both' };
const st = { ready: false, tasks: 'both', poseDelegate: '', handsDelegate: '', poseModel: 'full', fellBack: false, error: '', renderer: '', rebuilds: 0, lastRebuildWhy: '', lost: 0, fails: 0, warn: '' };
let t0ms = null, lastTs = 0, building = false, wantModel = 'full', forcedCpu = false;
const driftPose = new self.VTSched.DriftWatch(), driftHands = new self.VTSched.DriftWatch();
const doPose = () => cfg.tasks !== 'hands', doHands = () => cfg.tasks !== 'pose';

const info = () => self.postMessage({ t: 'info', who, ...st, mp: self.VTW.version });
const setReady = (v) => { st.ready = v; if (hub) hub.postMessage({ t: 'state', ready: v }); info(); };

async function build(why, what = 'all') {
  if (building) { if (why === 'model') setTimeout(() => build(why, what), 200); return; }
  building = true;
  setReady(false);
  try {
    const lost = () => { st.lost++; build('the graphics context was lost'); };
    const warn = [];
    if (doPose() && (what !== 'hands' || !pose)) {
      if (pose) { try { pose.close(); } catch (e) { /* ignore */ } pose = null; }
      const model = wantModel;
      const r = await makeTask('PoseLandmarker', POSE[model], POSE_OPTS, cfg.delegate, lost);
      lastTs = warmUp(r.task, lastTs);
      pose = r.task; st.poseDelegate = r.delegate; st.poseModel = model;
      if (r.fellBack) warn.push('Body tracking fell back to the PROCESSOR (slow): ' + (r.error || ''));
      // another model (full <-> lite), another delegate, a task rebuilt after errors: its times start a new story
      if (why !== 'slow') driftPose.reset(epoch());
    }
    if (doHands() && (what !== 'pose' || !hands)) {
      if (hands) { try { hands.close(); } catch (e) { /* ignore */ } hands = null; }
      const r = await makeTask('HandLandmarker', HAND, HAND_OPTS, cfg.delegate, lost);
      lastTs = warmUp(r.task, lastTs);
      hands = r.task; st.handsDelegate = r.delegate;
      if (r.fellBack) warn.push('Hand tracking fell back to the PROCESSOR (slow): ' + (r.error || ''));
      if (why !== 'slow') driftHands.reset(epoch());
    }
    if (forcedCpu) warn.push('Body + hand tracking was moved to the PROCESSOR after repeated graphics errors (very slow).');
    st.fellBack = warn.length > 0; st.warn = warn.join(' '); st.fails = 0; st.error = '';
    if (why && why !== 'model') { st.rebuilds++; st.lastRebuildWhy = why; }
    building = false;
    setReady(true);
    if (doPose() && wantModel !== st.poseModel) build('model', 'pose');
  } catch (e) {
    building = false;
    st.error = 'Could not load the body / hand models: ' + (e && e.message ? e.message : e);
    info();
  }
}

async function onFrame(m) {
  const frame = m.frame;
  let pres, hres, small = null, ok = false;
  const a = performance.now();
  let b = a, c = a;
  if (st.ready) {
    try {
      if (t0ms === null) t0ms = m.at;
      const ts = Math.max(lastTs + 1, Math.round(m.at - t0ms));     // strictly rising ms, taken from the capture time
      lastTs = ts;
      if (doPose()) {
        // load shedding: the pose model looks at a half-size copy (it works on 256 x 256 inside anyway)
        if (m.small && m.w >= 480) small = await createImageBitmap(frame, { resizeWidth: m.w >> 1, resizeHeight: m.h >> 1, resizeQuality: 'low' });
        if (!st.ready || !pose) throw new Error('models are being rebuilt');
        pres = packPose(pose.detectForVideo(small || frame, ts));
      }
      b = performance.now();
      if (doHands()) hres = m.runHands === false ? null : packHands(hands.detectForVideo(frame, ts));
      c = performance.now();
      ok = true; st.fails = 0;
    } catch (e) {
      if (st.ready) { st.fails++; st.error = 'body / hand model error: ' + (e && e.message ? e.message : e); }
    }
  }
  try { frame.close(); } catch (e) { /* ignore */ }
  if (small) { try { small.close(); } catch (e) { /* ignore */ } }
  const msg = { t: 'raw', seq: m.seq, at: m.at, w: m.w, h: m.h, ok, ms: [b - a, c - b] };
  if (doPose()) msg.pose = ok ? pres : null;
  if (doHands()) msg.hands = ok ? hres : null;
  hub.postMessage(msg);
  const now = epoch();
  // the watchdogs only count like with like: the pose model when it found a body, the hand model when it found
  // exactly one hand (none is quicker, two take longer; a change of what is in the picture is not a slow model)
  if (ok) { if (doPose()) driftPose.add(b - a, now, !!(pres && pres.n)); if (doHands() && hres) driftHands.add(c - b, now, hres.length === 1); }
  if (st.fails >= 3) {
    if (cfg.delegate === 'GPU' && st.rebuilds >= 2) { cfg.delegate = 'CPU'; forcedCpu = true; }      // the graphics card keeps failing: use the processor, and say so
    build('errors');
  } else if (doPose() && driftPose.check(now)) { driftPose.rebuilt(now); build('slow', 'pose'); }
  else if (doHands() && driftHands.check(now)) { driftHands.rebuilt(now); build('slow', 'hands'); }
}

function onHub(ev) {
  const m = ev.data;
  if (m.t === 'frame') onFrame(m);
  else if (m.t === 'shed') {
    wantModel = m.lite ? 'lite' : 'full';
    if (doPose() && pose && wantModel !== st.poseModel) build('model', 'pose');
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.t === 'init') {
    who = m.who || 'P';
    cfg = { ...cfg, delegate: m.delegate === 'CPU' ? 'CPU' : 'GPU', mp: m.mp || '0.10.21', tasks: ['both', 'pose', 'hands'].includes(m.tasks) ? m.tasks : 'both' };
    st.tasks = cfg.tasks;
    if (m.pose === 'lite') wantModel = 'lite';
    if (m.handConf > 0 && m.handConf < 1) HAND_OPTS = { numHands: 2, minHandDetectionConfidence: m.handConf, minHandPresenceConfidence: m.handConf, minTrackingConfidence: m.handConf };   // ?handconf= (measurements only)
    hub = m.port; hub.onmessage = onHub;
    st.renderer = glRenderer();
    try { await loadVision(cfg.mp); } catch (e) { st.error = 'Could not load MediaPipe: ' + (e && e.message ? e.message : e); info(); return; }
    await build('');
  } else if (m.t === 'delegate') { cfg.delegate = m.delegate === 'CPU' ? 'CPU' : 'GPU'; st.rebuilds = 0; forcedCpu = false; build(''); }
};
