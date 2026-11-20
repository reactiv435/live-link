// Tracker v2, the hub worker: everything on the path "camera frame -> perf message" that is not a model runs here, so
// nothing on that path waits for the page (a covered or minimised page slows its own timers, not this worker).
//   * takes the frames in (a MediaStream's frames handed over by the page, or OBS screenshots it fetches itself),
//     stamps each with its capture time, crops it to the picture, and hands the NEWEST one to the face worker and the
//     body worker(s) whenever they are free (never a queue: lib/scheduler.js);
//   * joins the raw pose + hand results of one frame and calls tracking/lib/body-signal.js (BODY agent);
//   * builds one `perf` message per face frame (lib/perf-assembly.js) and sends it at once over the relay WebSocket;
//   * keeps the v1 messages going (`face` a few times a second, `hands` for the hand-line page, `wave` from the page);
//   * measures: frames in, rates, model times, capture-to-send delay, drops; runs the load-shedding ladder.
// Classic worker. The OBS password only ever passes through memory here; it is never logged or posted back.
'use strict';
importScripts('./lib/scheduler.js', './lib/perf-assembly.js', './lib/picture-rect.js', './lib/hands-v1.js', './lib/raw-pack.js');

// the BODY agent's module; the stand-in only when that file is missing or broken
let BS = null, bodyStub = false, bodyStubWhy = '';
try { importScripts('./lib/body-signal.js'); BS = self.VTBodySignal || null; if (!BS) bodyStubWhy = 'body-signal.js loaded but VTBodySignal is missing'; }
catch (e) { bodyStubWhy = 'body-signal.js could not be loaded'; }
if (!BS) { importScripts('./lib/signal-stubs.js'); BS = self.VTBodySignalStub; bodyStub = true; }

const { Dispatcher, LoadLadder, ClockMap, Rate, Window } = self.VTSched;
const VTPerf = self.VTPerf, VTRect = self.VTRect;
const epoch = () => performance.timeOrigin + performance.now();
const post = (m, tr) => self.postMessage(m, tr || []);

// the two browser ES modules shared with v1 (OBS WebSocket client, camera-in-scene maths)
let ObsClient = null, V = null, obs = null;
const boot = Promise.all([import('./lib/obsws.js'), import('./lib/view.js')]).then(([a, b]) => { ObsClient = a.ObsClient; V = b; obsView = V.IDENTITY; obs = new ObsClient(); obs.onclose = onObsClose; });

let cfg = {
  relayUrl: '', source: 'none', faceMax: 60, bodyMax: 30, bodyOn: true, v1FaceHz: 5, mirror: 'follow', line: 'follow',
  crop: 'auto', cropManual: { l: 0, r: 0, t: 0, b: 0 }, turn: 0, flip: 'none', shed: 'auto', preview: false, tap: false,
  obs: { host: '127.0.0.1', port: 4455, sourceName: '', width: 540, quality: 60, inflight: 2, fps: 30, view: 'auto', turn: 0, flip: 'none', cropL: 0, cropR: 0, cropT: 0, cropB: 0 },
};
const ports = { F: null, P: null, H: null };
const ready = { F: false, P: false, H: false };
const readySince = { F: 0, P: 0, H: 0 };
const ctl = { mirror: false, line: null, mask: false };          // what the control panel last said (mask: the Mask is the chosen character)
const S = {
  framesIn: 0, seq: 0, perfSeq: 0, srcW: 0, srcH: 0, w: 0, h: 0, lastFrameAt: 0, lastFaceAt: 0, lastFaceFoundAt: 0, faceFound: false,
  facesDone: 0, bodiesDone: 0, bodiesHand: 0, prepErrors: 0, prepError: '', obsLate: 0, rect: null, rectInfo: null, lastBodyRan: 0, sentBytes: 0, startedAt: 0,
  bodySignalErrors: 0, lastBodySignalError: '',
};
const R = { in: new Rate(), face: new Rate(), body: new Rate(), perf: new Rate(1000) };
const W = {
  delay: new Window(900), faceMs: new Window(600), sigF: new Window(300), poseMs: new Window(600), handsMs: new Window(600), sigB: new Window(300),
  bodyAge: new Window(600), bodyDelay: new Window(600), waitF: new Window(300), waitB: new Window(300), rpc: new Window(120), dec: new Window(120), prep: new Window(300),
};
let dbg = null;                                      // the raw numbers while a measurement runs
let lastBody = null;
const clock = new ClockMap();
const ladder = new LoadLadder();
const stallAt = { F: 0, P: 0, H: 0 };
let bodySignal = BS.create({ mirror: false });
const handsV1 = self.VTHandsV1.create();
const split = () => !!ports.H;                       // two body workers (pose | hands) instead of one doing both
const bodyReady = () => ready.P && (!split() || ready.H);

// ---------------------------------------------------------------- handing frames to the model workers
let handSeenAt = -1e12, handProbeAt = -1e12, wristSeen = false, gate = { seq: -1, run: true };
const flags = () => (cfg.shed === 'off' ? { lite: false, half: false, small: false, gate: false } : ladder.flags);
/** Load shedding: hands only when one was seen in the last second, the pose sees a wrist, or as a probe twice a second. */
function runHandsFor(seq) {
  if (gate.seq === seq) return gate.run;
  const now = epoch();
  const run = !flags().gate || now - handSeenAt < 1000 || wristSeen || now - handProbeAt > 500;
  if (run) handProbeAt = now;
  gate = { seq, run };
  return run;
}
const disp = new Dispatcher({
  now: epoch,
  clone: (f) => f.clone(),
  close: (f) => { try { f.close(); } catch (e) { /* already closed */ } },
  send: (id, frame, info, wait) => {
    (id === 'F' ? W.waitF : W.waitB).add(wait);
    const m = { t: 'frame', frame, at: info.at, seq: info.seq, w: info.w, h: info.h };
    if (id !== 'F') { m.runHands = runHandsFor(info.seq); m.small = flags().small; }
    try { ports[id].postMessage(m, [frame]); }
    catch (e) { try { frame.close(); } catch (e2) { /* ignore */ } disp.ready(id); }
  },
});

function applyPolicies() {
  // OBS screenshots are already asked for at a set rate: only cap below that rate (their ask times jitter too much to cap at it)
  const paced = cfg.source === 'obs' ? cfg.obs.fps : Infinity;
  disp.policy('F', { enabled: ready.F, minGapMs: paced <= cfg.faceMax ? 0 : 1000 / Math.max(1, cfg.faceMax) });
  disp.policy('body', { enabled: cfg.bodyOn && bodyReady(), minGapMs: paced <= cfg.bodyMax ? 0 : 1000 / Math.max(1, cfg.bodyMax), every: flags().half ? 2 : 1 });
  if (!cfg.bodyOn) lastBody = null;
}
function pushShed() {
  if (ports.P) ports.P.postMessage({ t: 'shed', lite: flags().lite });
  applyPolicies();
}
const mirrorOn = () => (cfg.mirror === 'follow' ? !!ctl.mirror : cfg.mirror === 'on');
const lineOn = () => (cfg.line === 'follow' ? ctl.line === true : cfg.line === 'on');
function pushControl() {
  const m = mirrorOn(), l = lineOn();
  if (ports.F) { ports.F.postMessage({ t: 'mirror', on: m }); ports.F.postMessage({ t: 'raw', on: ctl.mask }); }
  try { bodySignal.setMirror(m); } catch (e) { /* ignore */ }
  post({ t: 'control', mirror: m, line: l, panelMirror: !!ctl.mirror, panelLine: ctl.line });
}

function onFace(m) {
  disp.ready('F');
  if (!m.ok) return;
  const now = epoch();
  S.facesDone++; S.lastFaceAt = now; S.faceFound = !!m.found;
  if (m.found) S.lastFaceFoundAt = now;
  R.face.hit(now); R.perf.hit(now);
  const msg = VTPerf.assemble({ seq: ++S.perfSeq, at: m.at, fps: R.perf.get(now), sent: now, face: m.face, bodyPart: cfg.bodyOn ? lastBody : null });
  send(JSON.stringify(msg));
  // the Mask: the raw result as one binary message (the relay hands it only to the avatar page)
  if (m.raw && ctl.mask && ws && wsOpen && ws.readyState === 1) { try { ws.send(m.raw); S.rawSent = (S.rawSent || 0) + 1; } catch (e) { /* closing */ } }
  const d = now - m.at;
  const age = lastBody && cfg.bodyOn ? m.at - lastBody.at : null;
  W.delay.add(d); W.faceMs.add(m.ms[0]); W.sigF.add(m.ms[1]);
  if (age !== null) W.bodyAge.add(age);
  if (dbg) { dbg.delay.push(d); dbg.faceMs.push(m.ms[0]); dbg.sigF.push(m.ms[1]); dbg.at.push(m.at); dbg.bodyAge.push(age === null ? -1e6 : age); }
  if (cfg.v1FaceHz > 0 && now - v1FaceAt >= 1000 / cfg.v1FaceHz) { v1FaceAt = now; send(JSON.stringify(VTPerf.v1Face(m.face, now, 'face', msg.fps))); }
}

// ---------------------------------------------------------------- body: join pose + hands of one frame, then body-signal.js
// the packed arrays -> the same shape MediaPipe returns (what body-signal.js is written against): lib/raw-pack.js
const { poseShape, handsShape } = self.VTRaw;
let cur = null, pvBodyAt = 0;
function onRaw(who, m) {
  disp.ready(who);
  if (!cur || cur.seq !== m.seq) cur = { seq: m.seq, at: m.at, w: m.w, h: m.h, pose: undefined, hands: undefined, ms: [0, 0], got: 0, ok: true };
  if (!m.ok) cur.ok = false;
  if (m.pose !== undefined) { cur.pose = m.pose; cur.ms[0] = m.ms[0]; }
  if (m.hands !== undefined) { cur.hands = m.hands; cur.ms[1] = m.ms[1]; }
  if (++cur.got < (split() ? 2 : 1)) return;
  const c = cur; cur = null;
  if (!c.ok || !c.pose) return;
  const now = epoch();
  const a = performance.now();
  const pres = poseShape(c.pose), hres = handsShape(c.hands);
  let out = null;
  try { out = bodySignal.process({ pose: pres, hands: hres }, c.at, { width: c.w, height: c.h }) || null; }
  catch (e) { S.bodySignalErrors++; S.lastBodySignalError = String(e && e.message ? e.message : e); }
  const v1 = handsV1.process(hres ? hres.landmarks : [], c.at, c.w, c.h, mirrorOn(), lineOn());
  const sig = performance.now() - a;
  // for the hands gate: was a hand found, does the pose see a wrist inside the picture
  if (c.hands && c.hands.length) { handSeenAt = now; S.bodiesHand++; }   // bodiesHand: body checks that saw a hand (a count; for the app log and the page's hint)
  wristSeen = false;
  if (c.pose.n) for (const i of [15, 16]) { const k = i * 5, x = c.pose.lm[k], y = c.pose.lm[k + 1]; if (c.pose.lm[k + 3] > 0.5 && x > -0.05 && x < 1.05 && y > -0.05 && y < 1.08) wristSeen = true; }
  S.bodiesDone++; S.lastBodyRan = now; R.body.hit(now);
  lastBody = { at: c.at, body: out ? out.body || null : null, hands: out ? out.hands || null : null };
  send(JSON.stringify(v1));
  // V8: the hand puppets (only while their switch is on, and only when the hand model ran on this frame): the raw 21
  // points of each hand go to the avatar page, where js/v8/hand-puppets.js turns them into the angel and the devil
  if (ctl.puppets && c.hands !== undefined && ws && wsOpen && ws.readyState === 1) {
    const r4 = (a) => { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.round(a[i] * 1e4) / 1e4; return o; };
    try { ws.send(JSON.stringify({ t: 'v8-hands', at: c.at, w: c.w, h: c.h, hands: (c.hands || []).slice(0, 2).map((x) => ({ handed: x.handed, score: Math.round((x.score || 0) * 1e3) / 1e3, lm: r4(x.lm), world: x.world ? r4(x.world) : null })) })); S.puppetsSent = (S.puppetsSent || 0) + 1; } catch (e) { /* closing */ }
  }
  W.poseMs.add(c.ms[0]); if (c.hands) W.handsMs.add(c.ms[1]); W.sigB.add(sig); W.bodyDelay.add(now - c.at);
  if (dbg) { dbg.poseMs.push(c.ms[0]); dbg.handsMs.push(c.hands ? c.ms[1] : -1); dbg.sigB.push(sig); dbg.bodyDelay.push(now - c.at); }
  if (cfg.preview && now - pvBodyAt > 90) {
    pvBodyAt = now;
    let pa = null;
    if (c.pose.n) { pa = new Float32Array(33 * 3); for (let i = 0; i < 33; i++) { pa[i * 3] = c.pose.lm[i * 5]; pa[i * 3 + 1] = c.pose.lm[i * 5 + 1]; pa[i * 3 + 2] = c.pose.lm[i * 5 + 3]; } }
    const hl = (c.hands || []).map((x) => { const o = new Float32Array(42); for (let i = 0; i < 21; i++) { o[i * 2] = x.lm[i * 3]; o[i * 2 + 1] = x.lm[i * 3 + 1]; } return o; });
    post({ t: 'pv', who: 'B', pose: pa, hands: hl, at: c.at });
  }
}

function wirePort(who, port) {
  if (ports[who]) { try { ports[who].close(); } catch (e) { /* ignore */ } disp.reset(who); }
  else disp.add(who, who === 'F' ? {} : { group: 'body' });
  ports[who] = port; ready[who] = false;
  if (who !== 'F') cur = null;
  port.onmessage = (ev) => {
    const m = ev.data;
    if (m.t === 'face') onFace(m);
    else if (m.t === 'raw') onRaw(who, m);
    else if (m.t === 'state') {
      ready[who] = !!m.ready; readySince[who] = epoch();
      if (!m.ready) { disp.reset(who); if (who !== 'F') cur = null; }
      applyPolicies();
      if (m.ready) { pushControl(); if (who === 'P') pushShed(); }
    }
  };
  applyPolicies();
}

// ---------------------------------------------------------------- relay WebSocket
let ws = null, wsOpen = false, v1FaceAt = 0;
// what else is on the relay: the avatar page says "here" once a second; another tracker page sends its own perf messages
let avatarAckAt = -1e12, otherLiveAt = -1e12;
const otherTrackerLive = (now) => now - otherLiveAt < 1500;
function connectRelay() {
  if (!cfg.relayUrl) return;
  let s;
  try { s = new WebSocket(cfg.relayUrl); } catch (e) { setTimeout(connectRelay, 2000); return; }
  ws = s;
  s.onopen = () => { wsOpen = true; avatarAckAt = epoch(); post({ t: 'relay', open: true }); };      // the avatar page gets a few seconds to say "here"
  s.onclose = () => { wsOpen = false; if (ws === s) ws = null; post({ t: 'relay', open: false }); setTimeout(connectRelay, 1500); };
  s.onerror = () => {};
  s.onmessage = (ev) => {
    const text = ev.data;
    if (typeof text !== 'string') return;
    if (text.startsWith('{"t":"perf"')) { if (!text.endsWith('"idle":true}')) otherLiveAt = epoch(); return; }   // another tracker page that is tracking
    if (text.startsWith('{"t":"avatar-ack"')) { avatarAckAt = epoch(); return; }
    if (text.indexOf('"avatar"') < 0 && text.indexOf('"hands-line"') < 0) return;   // everything else is other pages' traffic
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'avatar' && typeof m.mirror === 'boolean') { const mask = m.mask === true, changed = mask !== ctl.mask || m.mirror !== ctl.mirror; ctl.mirror = m.mirror; ctl.mask = mask; ctl.puppets = mask && m.on === true && !!m.v8 && m.v8.on !== false && m.v8.hands === true; if (changed) pushControl(); }      // (V8: puppets = the angel / devil hand puppets are switched on)
    else if (m.t === 'hands-line') { ctl.line = !!m.on; pushControl(); }
  };
}
function send(text) {
  if (ws && wsOpen && ws.readyState === 1) { ws.send(text); S.sentBytes += text.length; }
  if (cfg.tap) post({ t: 'tap', text });
}

// ---------------------------------------------------------------- the picture inside the frame (crop / turn / flip)
let plan = null;          // null = hand the frame on as it is
let turnCanvas = null;
let obsView = null, obsViewText = '';
function rebuildPlan() {
  plan = null;
  const w = S.srcW, h = S.srcH;
  if (!w || !h) return;
  if (cfg.source === 'obs') {
    const o = cfg.obs;
    const v = o.view === 'manual' ? V.viewFromManual(o) : o.view === 'auto' ? obsView : V.IDENTITY;
    if (V.isIdentity(v)) return;
    const z = V.viewSize(v, w, h);
    if (z.sw < 16 || z.sh < 16) return;
    plan = { ...z, turn: v.turn, flipH: v.flipH, flipV: v.flipV };
  } else {
    let r = null;
    if (cfg.source === 'display' && cfg.crop === 'auto') r = S.rect;
    else if (cfg.crop === 'manual') r = VTRect.manual(w, h, cfg.cropManual);
    r = r ? VTRect.clampTo(r, w, h) : null;
    const turn = [0, 90, 180, 270].includes(cfg.turn) ? cfg.turn : 0;
    const flipH = cfg.flip === 'h', flipV = cfg.flip === 'v';
    if (!r && !turn && !flipH && !flipV) return;
    const c = r || { x: 0, y: 0, w: w & ~1, h: h & ~1 };
    const side = turn === 90 || turn === 270;
    plan = { sx: c.x, sy: c.y, sw: c.w, sh: c.h, dw: c.w, dh: c.h, cw: side ? c.h : c.w, ch: side ? c.w : c.h, turn, flipH, flipV };
  }
  plan.simple = !plan.turn && !plan.flipH && !plan.flipV && plan.dw === plan.sw && plan.dh === plan.sh;
}
/** The frame as the models should see it. Crop only = no copy (a view on the same pixels). Turn / flip = one redraw. */
function prepare(frame) {
  if (!plan) return frame;
  let out;
  if (plan.simple) {
    const vr = frame.visibleRect || { x: 0, y: 0 };
    out = new VideoFrame(frame, { visibleRect: { x: vr.x + plan.sx, y: vr.y + plan.sy, width: plan.sw, height: plan.sh }, displayWidth: plan.sw, displayHeight: plan.sh });
  } else {
    if (!turnCanvas) turnCanvas = new OffscreenCanvas(plan.cw, plan.ch);
    if (turnCanvas.width !== plan.cw || turnCanvas.height !== plan.ch) { turnCanvas.width = plan.cw; turnCanvas.height = plan.ch; }
    const c = turnCanvas.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.translate(plan.cw / 2, plan.ch / 2);
    c.rotate(plan.turn * Math.PI / 180);
    c.scale(plan.flipH ? -1 : 1, plan.flipV ? -1 : 1);
    c.drawImage(frame, plan.sx, plan.sy, plan.sw, plan.sh, -plan.dw / 2, -plan.dh / 2, plan.dw, plan.dh);
    out = new VideoFrame(turnCanvas, { timestamp: frame.timestamp });
  }
  frame.close();
  return out;
}

// ---------------------------------------------------------------- finding the picture in a captured window
const snap = { want: 0, frames: [], nextAt: 0, canvas: null, k: 1, why: '', lastRunAt: 0 };
function startRectFind(why, delayMs = 300) {
  if (cfg.source !== 'display' || cfg.crop !== 'auto') return;
  snap.want = 5; snap.frames = []; snap.nextAt = epoch() + delayMs; snap.why = why; snap.lastRunAt = epoch();
}
function takeSnapshot(frame) {
  const w = frame.displayWidth, h = frame.displayHeight;
  const k = Math.min(1, 1280 / Math.max(w, h));
  const cw = Math.max(2, Math.round(w * k)), ch = Math.max(2, Math.round(h * k));
  if (snap.frames.length && (snap.frames[0].width !== cw || snap.frames[0].height !== ch)) snap.frames = [];   // the window was resized meanwhile
  if (!snap.canvas) snap.canvas = new OffscreenCanvas(cw, ch);
  if (snap.canvas.width !== cw || snap.canvas.height !== ch) { snap.canvas.width = cw; snap.canvas.height = ch; }
  const c = snap.canvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(frame, 0, 0, cw, ch);
  snap.frames.push(c.getImageData(0, 0, cw, ch));
  snap.k = k; snap.want--; snap.nextAt = epoch() + 150;
  if (snap.want > 0) return;
  let r = null;
  try { r = VTRect.find(snap.frames); } catch (e) { r = null; }
  snap.frames = [];
  if (!r) return;
  const full = VTRect.scale(r, 1 / k);
  S.rect = VTRect.clampTo(full, S.srcW, S.srcH);
  S.rectInfo = { conf: r.conf, why: r.why, title: Math.round(r.title / k), bars: r.bars, motion: r.motion, src: [S.srcW, S.srcH], found: snap.why, at: epoch() };
  rebuildPlan();
  post({ t: 'rect', rect: S.rect, info: S.rectInfo });
}

// ---------------------------------------------------------------- measurement only (?luma=1): black / white flips of the picture
// tools/v2-tracker-latency.mjs captures a window that flips colour at known times; this reports when each flip was
// captured (the frame's capture time) and when it reached this worker.
let lumaCanvas = null, lumaState = null;
function watchLuma(frame, at, arrive) {
  if (!lumaCanvas) lumaCanvas = new OffscreenCanvas(8, 8);
  const c = lumaCanvas.getContext('2d', { willReadFrequently: true });
  const w = frame.displayWidth, h = frame.displayHeight;
  c.drawImage(frame, w * 0.35, h * 0.45, w * 0.3, h * 0.3, 0, 0, 8, 8);
  const d = c.getImageData(0, 0, 8, 8).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  const v = sum / (64 * 3), st = v > 128 ? 1 : 0;
  if (st !== lumaState) { lumaState = st; post({ t: 'flip', at, arrive, state: st, v }); }
}

// ---------------------------------------------------------------- frames in
let pvAt = 0, pvBusy = false;
function onSourceFrame(frame, at, arrive) {
  S.framesIn++; S.lastFrameAt = arrive; R.in.hit(arrive);
  const w = frame.displayWidth, h = frame.displayHeight;
  if (w !== S.srcW || h !== S.srcH) {
    S.srcW = w; S.srcH = h; S.rect = null; S.rectInfo = null;
    rebuildPlan();
    startRectFind('picture size changed');
  }
  if (snap.want > 0 && arrive >= snap.nextAt) { try { takeSnapshot(frame); } catch (e) { snap.want = 0; } }
  if (cfg.luma) { try { watchLuma(frame, at, arrive); } catch (e) { /* measurement only */ } }
  let f;
  const a = performance.now();
  try { f = prepare(frame); }
  catch (e) { S.prepErrors++; S.prepError = String(e && e.message ? e.message : e); f = frame; }
  W.prep.add(performance.now() - a);
  S.w = f.displayWidth; S.h = f.displayHeight;
  if (cfg.preview && !pvBusy && arrive - pvAt > 100) {
    pvAt = arrive; pvBusy = true;
    const c = f.clone();
    const pw = 360, ph = Math.max(2, Math.round(pw * S.h / S.w));
    createImageBitmap(c, { resizeWidth: pw, resizeHeight: ph, resizeQuality: 'low' }).then(
      (bmp) => { c.close(); pvBusy = false; post({ t: 'pvimg', bmp, at, w: S.w, h: S.h }, [bmp]); },
      () => { c.close(); pvBusy = false; });
  }
  disp.offer(f, { at, arrive, seq: ++S.seq, w: S.w, h: S.h });
}

// A MediaStream's frames (window capture, a video file, a webcam): the page makes the frame reader and hands it over.
let srcGen = 0, reader = null;
async function pump(readable, kind) {
  stopSource();
  const gen = ++srcGen;
  clock.reset();
  S.srcW = 0; S.srcH = 0; S.rect = null; S.rectInfo = null; S.startedAt = epoch();
  reader = readable.getReader();
  const mine = reader;
  try {
    for (;;) {
      const { value, done } = await mine.read();
      if (done) break;
      if (gen !== srcGen) { value.close(); break; }
      const arrive = epoch();
      onSourceFrame(value, clock.map(value.timestamp / 1000, arrive), arrive);
    }
  } catch (e) { /* the stream was cut */ }
  if (gen === srcGen) { reader = null; post({ t: 'ended', kind }); }
}
function stopSource() {
  srcGen++;
  if (reader) { const r = reader; reader = null; r.cancel().catch(() => {}); }
  disp.clear();
  S.srcW = 0; S.srcH = 0; plan = null; lastBody = null; snap.want = 0; cur = null;
}

// ---------------------------------------------------------------- OBS screenshots (the fallback frame source)
let obsState = 'off', obsText = '', obsGen = 0, obsPw = '', obsRetry = null, obsSourceError = '', obsInputs = [];
const ob = { seq: 0, newest: -1, inflight: 0, nextAt: 0, timer: null, extra: 0, slow: 0, fast: 0 };
const obLimit = () => Math.max(1, cfg.obs.inflight) + ob.extra;
const postObs = () => post({ t: 'obs', state: obsState, text: obsText, inputs: obsInputs, sourceError: obsSourceError, viewText: obsViewText, sourceName: cfg.obs.sourceName });
async function obsConnect() {
  clearTimeout(obsRetry);
  const gen = ++obsGen;
  ob.inflight = 0;
  obsState = 'connecting'; obsText = 'Connecting to OBS...'; obsSourceError = ''; postObs();
  try {
    await obs.connect(cfg.obs.host, cfg.obs.port, obsPw);
    if (gen !== obsGen) return;
    obsState = 'connected'; obsText = 'Connected to OBS';
    await obsRefreshInputs();
    obsReadView();
    postObs();
    S.startedAt = epoch();
    obsAsk();
  } catch (e) {
    if (gen !== obsGen) return;
    if (e.kind === 'auth') { obsState = 'auth'; obsText = e.message + '. Type the password again and press Save + Connect.'; }
    else { obsState = 'retry'; obsText = e.message + ' Trying again...'; obsRetry = setTimeout(obsConnect, 2000); }
    postObs();
  }
}
function onObsClose() {
  if (cfg.source !== 'obs') return;
  obsState = 'retry'; obsText = 'OBS connection lost. Trying again...'; postObs();
  clearTimeout(obsRetry);
  obsRetry = setTimeout(obsConnect, 1000);
}
function obsDisconnect() { obsGen++; clearTimeout(obsRetry); clearTimeout(ob.timer); ob.timer = null; ob.inflight = 0; obs.close(); obsState = 'off'; obsText = ''; postObs(); }
async function obsRefreshInputs() {
  try {
    const res = await obs.call('GetInputList', {});
    obsInputs = (res.inputs || []).map((i) => i.inputName).filter((n) => typeof n === 'string');
    if (!cfg.obs.sourceName) { const guess = obsInputs.find((n) => /droidcam/i.test(n)); if (guess) { cfg.obs.sourceName = guess; post({ t: 'obs-source', name: guess }); } }
    obsSourceError = cfg.obs.sourceName && !obsInputs.includes(cfg.obs.sourceName) ? 'Saved source "' + cfg.obs.sourceName + '" is not in OBS. Pick the camera source.' : '';
  } catch (e) { obsSourceError = 'Could not read the source list from OBS.'; }
}
// How the camera sits in the scene on air. GetSourceScreenshot hands over the RAW source, so the scene item's crop,
// flip and turn are applied here (as v1 did). Three small read-only requests every 2 s.
let viewBusy = false;
async function obsReadView() {
  if (viewBusy || cfg.source !== 'obs' || cfg.obs.view !== 'auto' || obsState !== 'connected' || !cfg.obs.sourceName) return;
  viewBusy = true;
  const name = cfg.obs.sourceName;
  try {
    const sc = await obs.call('GetCurrentProgramScene', {});
    const sceneName = sc.sceneName || sc.currentProgramSceneName;
    let id;
    try { id = (await obs.call('GetSceneItemId', { sceneName, sourceName: name })).sceneItemId; }
    catch (e) {
      if (e.kind !== 'request') throw e;
      const text = 'not found directly in the scene on air ("' + sceneName + '"): picture used as it is. If the camera is turned or cropped there, choose "Set by hand".';
      if (text !== obsViewText) { obsView = V.IDENTITY; obsViewText = text; rebuildPlan(); postObs(); }
      return;
    }
    const tr = (await obs.call('GetSceneItemTransform', { sceneName, sceneItemId: id })).sceneItemTransform;
    if (name !== cfg.obs.sourceName || cfg.obs.view !== 'auto') return;
    const v = V.viewFromObs(tr);
    const text = V.describeView(v) + ' (read from the OBS scene "' + sceneName + '")';
    if (text !== obsViewText || JSON.stringify(v) !== JSON.stringify(obsView)) { obsView = v; obsViewText = text; rebuildPlan(); postObs(); }
  } catch (e) { /* connection trouble: keep the last known view */ } finally { viewBusy = false; }
}
function b64bytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** Keep up to `inflight` screenshot requests going, spaced at the chosen rate; use only the newest answer. */
function obsAsk() {
  if (cfg.source !== 'obs' || obsState !== 'connected' || !cfg.obs.sourceName) return;
  if (ob.inflight >= obLimit()) return;
  const now = epoch();
  const gap = 1000 / Math.max(1, cfg.obs.fps);
  // asks go out on a steady beat (the next one is due one gap after the last one WAS DUE, so a late timer does not
  // slow the beat down); whichever comes first, the timer or an answer arriving, sends the next one
  if (now < ob.nextAt - 1) {
    if (!ob.timer) ob.timer = setTimeout(() => { ob.timer = null; obsAsk(); }, Math.max(1, ob.nextAt - now));
    return;
  }
  ob.nextAt = Math.max(ob.nextAt + gap, now + gap * 0.5);      // when it fell behind: no burst of asks for the same instant
  ob.inflight++;
  const n = ++ob.seq, gen = obsGen;
  obs.call('GetSourceScreenshot', {
    sourceName: cfg.obs.sourceName, imageFormat: 'jpg',
    imageWidth: Math.min(1920, Math.max(160, Math.round(cfg.obs.width))), imageCompressionQuality: Math.min(100, Math.max(20, cfg.obs.quality)),
  }, 2000).then(async (res) => {
    if (gen !== obsGen) return;
    ob.inflight = Math.max(0, ob.inflight - 1);
    obsAsk();
    const t1 = epoch();
    W.rpc.add(t1 - now);
    if (obsSourceError) { obsSourceError = ''; postObs(); }
    try {
      const data = res.imageData || '';
      const mime = /^data:([^;,]+)/.exec(data);
      const bmp = await createImageBitmap(new Blob([b64bytes(data.slice(data.indexOf(',') + 1))], { type: mime ? mime[1] : 'image/jpeg' }));
      const t2 = epoch();
      W.dec.add(t2 - t1);
      if (n < ob.newest || gen !== obsGen || cfg.source !== 'obs') { bmp.close(); S.obsLate++; return; }   // an older picture than one already used
      ob.newest = n;
      const frame = new VideoFrame(bmp, { timestamp: Math.round(now * 1000) });
      bmp.close();
      onSourceFrame(frame, now, t2);      // capture time = when the picture was asked for (OBS renders it right then)
    } catch (e) { /* a broken picture: skip it */ }
  }, (e) => {
    if (gen !== obsGen) return;
    ob.inflight = Math.max(0, ob.inflight - 1);
    const was = obsSourceError;
    if (e.code === 600) obsSourceError = 'OBS has no source called "' + cfg.obs.sourceName + '". Pick the camera source.';
    else if (e.kind === 'request') obsSourceError = 'OBS could not give a picture of "' + cfg.obs.sourceName + '" (is the camera on?).';
    if (was !== obsSourceError) postObs();
    setTimeout(obsAsk, 250);
  });
  if (ob.inflight < obLimit()) obsAsk();
}

// ---------------------------------------------------------------- housekeeping timers (worker timers are not slowed when the page is hidden)
function noFaceWhy() {
  if (cfg.source === 'obs') {
    if (obsState === 'auth') return 'password';
    if (obsState !== 'connected') return 'obs';
    if (!cfg.obs.sourceName) return 'source';
  }
  return 'frames';
}
setInterval(() => {
  const now = epoch();
  // A tracker page that is open but not tracking keeps quiet while ANOTHER tracker page is tracking: its "no face"
  // messages would be mixed into the other one's on the same relay and make the avatar stutter.
  const quiet = otherTrackerLive(now);
  // no picture at all: say so a few times a second (the avatar eases to its idle pose)
  if (now - S.lastFaceAt > 500 && !quiet) {
    send(JSON.stringify({ ...VTPerf.assemble({ seq: ++S.perfSeq, at: now, fps: 0, sent: now, face: null, bodyPart: null }), idle: true }));
    send(JSON.stringify(VTPerf.v1Face(null, now, noFaceWhy())));
  }
  // no hand tracking running: the hand-line page is told there are no hands
  if (now - S.lastBodyRan > 500 && !quiet) send(JSON.stringify(handsV1.none(now, lineOn())));
  // a model worker that has been on one frame for 12 s is stuck: the page restarts it
  for (const who of ['F', 'P', 'H']) {
    if (ports[who] && ready[who] && disp.busyFor(who) > 12000 && now - stallAt[who] > 20000) { stallAt[who] = now; post({ t: 'stall', who }); }
  }
  // the picture may be cropped wrongly: look again when no face has been seen for a while
  if (cfg.source === 'display' && cfg.crop === 'auto' && S.lastFrameAt && now - S.lastFrameAt < 1000 && now - S.lastFaceFoundAt > 6000 && now - snap.lastRunAt > 20000 && snap.want === 0) startRectFind('no face seen');
}, 250);

setInterval(() => {                                   // once a second: the load-shedding ladder
  const now = epoch();
  // judge only a settled tracker: all workers ready, and the picture flowing, for 10 s
  if (cfg.shed === 'off' || !cfg.bodyOn || !ready.F || !bodyReady() || now - Math.max(S.startedAt, readySince.F, readySince.P, readySince.H) < 10000) return;
  // the goals follow the caps set on the page: a body that runs at its own "Up to 15" is on target, not behind
  if (ladder.update({ inFps: R.in.get(now), faceMax: cfg.faceMax, bodyMax: cfg.bodyMax, faceFps: R.face.get(now), bodyFps: R.body.get(now), bodyOn: true })) pushShed();
}, 1000);

setInterval(() => { if (obs) obsReadView(); }, 2000);

setInterval(() => {                                   // once a second: OBS screenshots, how many requests at a time
  if (cfg.source !== 'obs' || obsState !== 'connected') { ob.extra = 0; ob.slow = 0; ob.fast = 0; return; }
  const want = Math.max(1, cfg.obs.fps), got = R.in.get(epoch()), beat = 1000 / want;
  // one more request in flight only while the usual number does not reach the rate because OBS answers slower than the beat
  if (!ob.extra) { ob.slow = got < want * 0.85 && W.rpc.median > beat ? ob.slow + 1 : 0; if (ob.slow >= 3) { ob.extra = 1; ob.slow = 0; obsAsk(); } }
  else { ob.fast = W.rpc.median < beat * 0.6 ? ob.fast + 1 : 0; if (ob.fast >= 10) { ob.extra = 0; ob.fast = 0; } }
}, 1000);

function stats() {
  const now = epoch();
  const f = disp.stats('F'), b = disp.stats('body');
  return {
    t: 'stats', now, source: cfg.source, relay: wsOpen, inFps: R.in.get(now), faceFps: R.face.get(now), bodyFps: R.body.get(now), perfFps: R.perf.get(now),
    ms: { face: W.faceMs.median, faceP95: W.faceMs.p95, sigF: W.sigF.median, pose: W.poseMs.median, hands: W.handsMs.median, sigB: W.sigB.median, prep: W.prep.median, rpc: W.rpc.median, dec: W.dec.median },
    delay: { med: W.delay.median, p95: W.delay.p95 }, bodyDelay: { med: W.bodyDelay.median, p95: W.bodyDelay.p95 }, bodyAge: W.bodyAge.median, wait: { F: W.waitF.median, B: W.waitB.median },
    drop: { F: f.dropped, B: b.dropped }, skip: { F: f.skipped, B: b.skipped }, frames: { in: S.framesIn, face: S.facesDone, body: S.bodiesDone, hand: S.bodiesHand },
    src: [S.srcW, S.srcH], pic: [S.w, S.h], faceFound: S.faceFound && now - S.lastFaceAt < 600, lastFrameAgo: S.lastFrameAt ? now - S.lastFrameAt : -1,
    shed: cfg.shed === 'off' ? 'off' : ladder.describe(), shedLevel: cfg.shed === 'off' ? 0 : ladder.level, shedWhy: ladder.reason, ready: { ...ready }, split: split(),
    rect: S.rect, rectInfo: S.rectInfo, mirror: mirrorOn(), line: lineOn(), prepErrors: S.prepErrors, prepError: S.prepError, obsLate: S.obsLate, sentBytes: S.sentBytes,
    cropped: !!plan, bodyStub, bodyStubWhy, bodySignalErrors: S.bodySignalErrors, lastBodySignalError: S.lastBodySignalError, obsInflight: obLimit(),
    // the avatar page was heard in the last 4 s; another tracker page is tracking; this one is tracking too
    avatarHeard: wsOpen && now - avatarAckAt < 4000, otherTracker: otherTrackerLive(now), live: now - S.lastFaceAt < 500, bodyMax: cfg.bodyMax,
  };
}
setInterval(() => post(stats()), 500);

// ---------------------------------------------------------------- page -> hub
self.onmessage = async (ev) => {
  const m = ev.data;
  await boot;
  if (m.t === 'init') {
    cfg = { ...cfg, ...m.cfg, obs: { ...cfg.obs, ...(m.cfg.obs || {}) } };
    for (const who of ['F', 'P', 'H']) if (m.ports[who]) wirePort(who, m.ports[who]);
    connectRelay();
    pushControl();
  } else if (m.t === 'cfg') {
    const was = cfg;
    cfg = { ...cfg, ...m.patch, obs: { ...cfg.obs, ...(m.patch.obs || {}) } };
    applyPolicies(); pushControl(); pushShed();
    if (cfg.source !== was.source) {
      if (was.source === 'obs') obsDisconnect();
      if (was.source !== 'none' && was.source !== 'obs') stopSource();
      if (cfg.source === 'obs') { stopSource(); S.startedAt = epoch(); }
    }
    rebuildPlan();
    if (cfg.source === 'display' && cfg.crop === 'auto' && (was.crop !== 'auto' || was.source !== 'display') && S.srcW) startRectFind('switched to automatic');
    if (cfg.source === 'obs' && obsState === 'connected') { obsReadView(); obsAsk(); }
  } else if (m.t === 'port') wirePort(m.who, m.port);
  else if (m.t === 'stream') pump(m.readable, m.kind);
  else if (m.t === 'stop') stopSource();
  else if (m.t === 'obs-connect') { obsPw = typeof m.password === 'string' ? m.password : ''; if (cfg.source === 'obs') obsConnect(); }
  else if (m.t === 'obs-disconnect') obsDisconnect();
  else if (m.t === 'obs-refresh') { if (obsState === 'connected') obsRefreshInputs().then(postObs); }
  else if (m.t === 'find-rect') startRectFind('asked', 50);
  else if (m.t === 'body-reset') { try { bodySignal.reset(); } catch (e) { /* ignore */ } }
  else if (m.t === 'send') send(m.text);
  else if (m.t === 'measure') {
    const snapNow = () => ({ t: epoch(), frames: { in: S.framesIn, face: S.facesDone, body: S.bodiesDone }, drop: { F: disp.stats('F').dropped, B: disp.stats('body').dropped }, skip: { F: disp.stats('F').skipped, B: disp.stats('body').skipped } });
    if (m.on) dbg = { delay: [], faceMs: [], sigF: [], at: [], bodyAge: [], poseMs: [], handsMs: [], sigB: [], bodyDelay: [], start: snapNow() };
    else { const d = dbg; dbg = null; post({ t: 'measured', id: m.id, data: d ? { ...d, end: snapNow() } : null }); }
  }
};
