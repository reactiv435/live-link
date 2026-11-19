// face-signal.js: MediaPipe's raw face result -> the `face` part of the `perf` message (protocol v2).
// Pure UMD module: no DOM, safe in a worker, in a page (<script>) and in Node tests.
//   browser / worker:  self.VTFaceSignal      Node: require(...) or globalThis.VTFaceSignal
//
//   const fs = VTFaceSignal.create({ mirror: false });
//   const face = fs.process(faceResult, tMs, { width, height });   // faceResult = FaceLandmarker.detectForVideo(...)
//   fs.setMirror(bool); fs.getCalibration(); fs.setCalibration(obj); fs.reset();
//   fs.captureNeutral({ holdMs, timeoutMs }); fs.captureStatus(); fs.calibrationInfo();     (the guided neutral capture)
//
// What it returns (null when there is no face):
//   rot:  [yaw, pitch, roll]  degrees, minus his rest pose; +yaw toward picture right, +pitch up, +roll clockwise on screen
//   pos:  [x, y, s]           head centre against the rest position, in head widths (+x picture right, +y up); s = size ratio
//   bs:   { 52 ARKit names }  0..1, CALIBRATED: his neutral face reads 0, his strong version reads about 1.
//                             eyeBlinkLeft / eyeBlinkRight are the corrected eyelid closure (see `blink`).
//                             Channels MediaPipe does not produce are rebuilt from the landmarks (eyeWide*, mouthFrown*,
//                             cheekSquint*) or stay 0 (cheekPuff, tongueOut, noseSneer*, jawForward).
//   gaze: [x, y]              -1..1, +x picture right, +y up; from the iris landmarks (steadier than eyeLook* with low lids)
//   blink: [l, r]             0..1 eyelid closure, FAST and unfiltered; looking down and smiling do not read as a blink
//   lm:   { ... }             channels measured on the landmarks in the HEAD's own frame (so a turned head does not fake
//                             an expression), each against his neutral and scaled by his range. See LM_CHANNELS below.
// "Left" / "Right" everywhere mean the LEFT / RIGHT SIDE OF THE PICTURE the viewer sees after `mirror`:
//   mirror off: the picture is the camera picture, so picture-left = the person's right (MediaPipe's "...Right");
//   mirror on:  the picture is flipped, picture-left = the person's left. x directions flip the same way.
// The input itself is never flipped: feed the unmirrored camera frame's result.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTFaceSignal = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const remap01 = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
  const DEG = 180 / Math.PI;

  /** MediaPipe's blendshape order (index 0 is the unused '_neutral'). */
  const MP_NAMES = ['_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff',
    'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft',
    'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
    'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
    'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft',
    'mouthPressRight', 'mouthPucker', 'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
    'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
    'noseSneerLeft', 'noseSneerRight'];
  const BS_NAMES = MP_NAMES.slice(1).concat(['tongueOut']);            // the 52 ARKit names
  const swapName = (n) => (/Left$/.test(n) ? n.replace(/Left$/, 'Right') : /Right$/.test(n) ? n.replace(/Right$/, 'Left') : n);
  const MP_INDEX = Object.fromEntries(MP_NAMES.map((n, i) => [n, i]));

  // ------------------------------------------------------------------ landmark channels (`lm`)
  // Everything is measured after the landmarks have been turned back into the head's own frame with the face matrix,
  // in units of the distance between the two eye centres (IOD), then: (value - his neutral) / his range.
  // "about +-1" = his strong version; values are clamped to the range given.
  const LM_CHANNELS = {
    browL: 'brow height, picture-left brow: -1 pulled down .. 0 neutral .. +1 raised                 [-1.3, 1.3]',
    browR: 'same, picture-right brow',
    browTiltL: 'brow angle: -1 inner end down (angry) .. +1 inner end up (worried)                       [-1.3, 1.3]',
    browTiltR: 'same, picture-right brow',
    browPinch: 'brows drawn together (a frown): 0 .. 1                                                  [0, 1.3]',
    eyeOpenL: 'eyelid opening held for a moment (blinks removed): 0 shut .. 1 his normal .. ~1.5 wide   [0, 1.6]',
    eyeOpenR: 'same, picture-right eye',
    squintL: 'lower lid pushed up (smile, wince): 0 .. 1                                                [0, 1.3]',
    squintR: 'same, picture-right eye',
    mouthOpen: 'gap between the lips: 0 closed .. 1 his widest                                          [0, 1.3]',
    mouthWide: 'mouth width: -1 pucker .. 0 neutral .. +1 stretched wide                                [-1.3, 1.3]',
    cornerL: 'lip corner height against the lips, picture-left corner: -1 down (frown) .. +1 up (smile) [-1.3, 1.3]',
    cornerR: 'same, picture-right corner',
    lipPress: 'lips pressed or rolled in (they get thinner): 0 .. 1                                     [0, 1.3]',
    jaw: 'chin dropped (the jaw, whatever the lips do): 0 .. 1                                          [0, 1.3]',
    mouthX: 'mouth pushed sideways: -1 picture left .. +1 picture right                                 [-1.3, 1.3]',
    upperLip: 'upper lip pulled up toward the nose (sneer, disgust): 0 .. 1                             [0, 1.3]',
  };

  // Landmark numbers of the 478-point mesh. 'r' = the PERSON's right side (picture-left in an unmirrored picture).
  const P = {
    r: { out: 33, inn: 133, up: [159, 158, 160], lo: [145, 153, 144], brow: [70, 63, 105, 66, 107], iris: 468, corner: 61 },
    l: { out: 263, inn: 362, up: [386, 385, 387], lo: [374, 380, 373], brow: [300, 293, 334, 296, 336], iris: 473, corner: 291 },
    lipTop: 0, lipBot: 17, inUp: 13, inLo: 14, noseBase: 2, chin: 152, edgeR: 234, edgeL: 454, bridge: 168,
  };
  const BROW_W = [0.5, 1, 1, 1, 1];                                     // the outermost brow point is the least reliable

  // ------------------------------------------------------------------ calibration defaults
  // rest = neutral value, up / dn = distance from rest to the strong version. For blendshapes dn is unused.
  // These are GENERIC starting values; his own numbers replace them (captureNeutral, the slow adaptation, or a saved
  // calibration from setCalibration). Geometric channels are in IOD units.
  const D = (rest, up, dn) => ({ rest, up, dn: dn == null ? up : dn });
  const GEO_DEFAULT = {
    browHr: D(0.36, 0.085, 0.045), browHl: D(0.36, 0.085, 0.045),
    browTr: D(0.02, 0.05, 0.05), browTl: D(0.02, 0.05, 0.05),
    browGap: D(0.36, 0.03, 0.05),
    gapR: D(0.30, 0.10, 0.30), gapL: D(0.30, 0.10, 0.30),               // lid gap / eye width
    lowR: D(-0.13, 0.06, 0.05), lowL: D(-0.13, 0.06, 0.05),             // lower lid against the corner line / eye width
    irisXr: D(0, 0.13, 0.13), irisXl: D(0, 0.13, 0.13), irisY: D(0, 0.07, 0.07),
    mouthW: D(0.80, 0.22, 0.20), mouthO: D(0.0, 0.45, 0.02),
    cornR: D(0.0, 0.09, 0.07), cornL: D(0.0, 0.09, 0.07),
    lipT: D(0.30, 0.08, 0.13), jawD: D(1.05, 0.30, 0.05),
    mouthX: D(0, 0.07, 0.07), upLip: D(0.30, 0.05, 0.06),
  };
  const BS_DEFAULT_UP = {                                                // typical strong values of the usable blendshapes
    browDownLeft: 0.6, browDownRight: 0.6, browInnerUp: 0.6, browOuterUpLeft: 0.6, browOuterUpRight: 0.6,
    eyeBlinkLeft: 0.6, eyeBlinkRight: 0.6, eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6, eyeLookInLeft: 0.6, eyeLookInRight: 0.6,
    eyeLookOutLeft: 0.6, eyeLookOutRight: 0.6, eyeLookUpLeft: 0.3, eyeLookUpRight: 0.3, eyeSquintLeft: 0.3, eyeSquintRight: 0.3,
    jawLeft: 0.2, jawRight: 0.2, jawOpen: 0.5, mouthClose: 0.2, mouthDimpleLeft: 0.3, mouthDimpleRight: 0.3,
    mouthFunnel: 0.25, mouthLeft: 0.3, mouthRight: 0.3, mouthLowerDownLeft: 0.5, mouthLowerDownRight: 0.5, mouthPressLeft: 0.3,
    mouthPressRight: 0.3, mouthPucker: 0.6, mouthRollLower: 0.3, mouthRollUpper: 0.25, mouthShrugLower: 0.5, mouthShrugUpper: 0.3,
    mouthSmileLeft: 0.8, mouthSmileRight: 0.8, mouthStretchLeft: 0.4, mouthStretchRight: 0.4, mouthUpperUpLeft: 0.7, mouthUpperUpRight: 0.7,
  };
  /**
   * Head-pose correction. Even in the head's own frame the measurements drift when the head nods or turns (the mesh's
   * depth is only an estimate): a nod of 10 degrees reads like a third of a brow raise. Per channel: change of the raw
   * measurement per 10 degrees of [pitch, yaw] away from the rest pose, fitted on the owner's recorded footage
   * (6600 frames, tmp/face/dump_geo.mjs). Only channels with a clear geometric drift are corrected; gaze and the mouth
   * opening are left alone (there the head really does move with the expression).
   */
  const POSE = {
    browHr: [0.0284, -0.0172], browHl: [0.0259, -0.0197], browTr: [-0.0331, 0], browTl: [-0.0056, 0],
    lowR: [-0.0322, 0], lowL: [-0.0335, -0.0096], cornR: [0.017, -0.0108], cornL: [0.017, -0.0085],
    jawD: [0.0717, -0.0147], mouthX: [0, -0.034],
  };
  /** Dead or near-dead in MediaPipe's model (measured on his footage too): rebuilt from the landmarks, or left at 0. */
  const DEAD = ['cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'mouthFrownLeft',
    'mouthFrownRight', 'noseSneerLeft', 'noseSneerRight'];
  const BS_DEAD = 0.025;                                                 // calibrated blendshapes: movement under this is noise

  // ------------------------------------------------------------------ filters
  /** One Euro filter (Casiez et al.): cutoff = minCutoff + beta * |speed|. */
  class OneEuro {
    constructor(minCutoff, beta, dCutoff) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff == null ? 1 : dCutoff; this.x = null; this.dx = 0; this.t = null; }
    reset() { this.x = null; this.dx = 0; this.t = null; }
    filter(v, tMs) {
      if (this.x === null || this.t === null) { this.x = v; this.dx = 0; this.t = tMs; return v; }
      let dt = (tMs - this.t) / 1000;
      if (!(dt > 0)) return this.x;
      if (dt > 0.5) dt = 0.5;
      this.t = tMs;
      const alpha = (fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
      this.dx += alpha(this.dc) * ((v - this.x) / dt - this.dx);
      this.x += alpha(this.mc + this.beta * Math.abs(this.dx)) * (v - this.x);
      return this.x;
    }
  }
  /** Filter settings [minCutoff Hz, beta, derivative cutoff Hz], tuned on his footage (tools/face-signal-check.mjs). */
  const FILTER = {
    channel: [2.0, 2.5, 6],     // calibrated expression channels (units per second)
    lid: [3.0, 4.0, 8],         // the held eyelid opening
    gaze: [2.5, 2.0, 6],
    rot: [1.5, 0.12, 4],        // degrees
    pos: [1.2, 3.0, 4],         // head widths
  };

  /** Lowest value of the last `ms` (a blink is too short to move it) / highest value (a blink dip does not pull it down). */
  class Window {
    constructor(ms, max) { this.ms = ms; this.max = !!max; this.q = []; }
    reset() { this.q.length = 0; }
    push(v, t) {
      const q = this.q;
      q.push(t, v);
      while (q.length > 2 && t - q[0] > this.ms) q.splice(0, 2);
      let m = v;
      for (let i = 1; i < q.length; i += 2) if (this.max ? q[i] > m : q[i] < m) m = q[i];
      return m;
    }
  }

  // ------------------------------------------------------------------ what "neutral" and "strong" are, per channel
  /**
   * Which value of everything seen counts as "his neutral", per channel, as a quantile. NEVER the most common value:
   * while he talks or laughs the most common lip gap / smile / brow height IS the talking, laughing, raised one, and a
   * neutral learned from it swallows exactly those expressions (the day-one failure of the first v2).
   *   one-sided channels (the expression only ever adds: lip gap, jaw drop, smile, brow raise, squint): a LOW quantile;
   *   channels whose expression takes away (brows drawn together, lips pressed thin, upper lip pulled up): a HIGH one;
   *   the lid gap: a little above the middle (blinks, looking down and smiling all pull it down, wide eyes are rare);
   *   two-sided channels (brow angle, gaze, mouth sideways, the mouth's width and corners): about the middle.
   * And the channels a SMILE moves (mouth corners and width, the lower lids, the lid gap) do not learn at all from frames
   * in which MediaPipe's own smile score says he is smiling (SMILE_CH below): however long he laughs, the laugh never
   * becomes the neutral, and a closed smile after a long laugh still reads as a smile.
   */
  const REST_Q = { browHr: 0.22, browHl: 0.22, browTr: 0.5, browTl: 0.5, browGap: 0.8, gapR: 0.65, gapL: 0.65, lowR: 0.25, lowL: 0.25,
    irisXr: 0.5, irisXl: 0.5, irisY: 0.5, mouthW: 0.4, mouthO: 0.12, cornR: 0.4, cornL: 0.4, lipT: 0.75, jawD: 0.2, mouthX: 0.5, upLip: 0.7 };
  const SMILE_CH = { cornR: 1, cornL: 1, mouthW: 1, lowR: 1, lowL: 1, gapR: 1, gapL: 1 };
  /** The learned neutral of these can never be more than this, whatever he does for however long (IOD units). */
  const REST_CAP = { mouthO: 0.07 };
  /** Blendshapes are all one-sided. The learned neutral never passes the cap: a laugh held for a minute stays a laugh. */
  const BS_REST_Q = 0.15, BS_REST_Q_EYE = 0.3;
  const BS_REST_CAP = { mouthSmileLeft: 0.12, mouthSmileRight: 0.12, jawOpen: 0.06, mouthFunnel: 0.08, browInnerUp: 0.15, browOuterUpLeft: 0.12, browOuterUpRight: 0.12,
    browDownLeft: 0.12, browDownRight: 0.12, eyeSquintLeft: 0.5, eyeSquintRight: 0.5, eyeBlinkLeft: 0.35, eyeBlinkRight: 0.35, eyeLookDownLeft: 0.4, eyeLookDownRight: 0.4,
    eyeLookInLeft: 0.3, eyeLookInRight: 0.3, eyeLookOutLeft: 0.3, eyeLookOutRight: 0.3, eyeLookUpLeft: 0.2, eyeLookUpRight: 0.2, mouthShrugLower: 0.35, mouthShrugUpper: 0.35,
    mouthPressLeft: 0.25, mouthPressRight: 0.25, mouthRollLower: 0.25, mouthRollUpper: 0.25, mouthPucker: 0.2, mouthUpperUpLeft: 0.12, mouthUpperUpRight: 0.12,
    mouthLowerDownLeft: 0.12, mouthLowerDownRight: 0.12 };
  const BS_REST_CAP_DEFAULT = 0.15;
  /**
   * How much a neutral is trusted, in SECONDS of his own footage it is worth. The neutral in use is the weighted mean of
   * that anchor and what the session has shown so far (the quantile above), so nothing is ever frozen:
   *   fresh    = the generic numbers of this file (day one, nothing saved): outweighed after a few seconds;
   *   loaded   = a saved calibration that was learned, not captured (also the seed made from the test clips): a minute,
   *              so a frown or raised brows he holds for half a minute still read at the end of it;
   *   captured = the guided capture: it wins for the first minutes, and a slightly wrong one heals in minutes.
   * A captured neutral may also only drift by DRIFT of the channel's range, so a long laugh cannot move it far.
   * Gaze is steadied ten times longer (he may look at a side screen for minutes: that is a look, not a new neutral).
   */
  const TRUST = { fresh: 2, loaded: 60, captured: 150 }, DRIFT = 0.45, SLOW = { irisXr: 10, irisXl: 10, irisY: 10 };
  const MEMORY_S = 600;                                                  // what was seen is forgotten over about ten minutes

  /** One channel's statistics: a slowly forgetting histogram of everything seen (weights in seconds) and an anchor. */
  class Stat {
    constructor(def, lo, hi, q, cap, slow) {
      this.lo = lo; this.hi = hi; this.n = 48; this.q = q; this.cap = cap == null ? Infinity : cap; this.slow = slow || 1;
      this.h = new Float32Array(this.n); this.total = 0;
      this.rest = def.rest; this.up = def.up; this.dn = def.dn;
      this.anchor = { rest: def.rest, up: def.up, dn: def.dn }; this.trust = TRUST.fresh; this.captured = false;
    }
    add(v, w) {
      const k = clamp(Math.floor((v - this.lo) / (this.hi - this.lo) * this.n), 0, this.n - 1);
      this.h[k] += w; this.total += w;
    }
    decay(f) { for (let i = 0; i < this.n; i++) this.h[i] *= f; this.total *= f; }
    forget() { this.h.fill(0); this.total = 0; }
    _pct(q) {
      let acc = 0;
      const want = q * this.total;
      for (let i = 0; i < this.n; i++) {
        if (acc + this.h[i] >= want) return this.lo + (i + (this.h[i] > 0 ? (want - acc) / this.h[i] : 0.5)) * (this.hi - this.lo) / this.n;
        acc += this.h[i];
      }
      return this.hi;
    }
    /** A new anchor: `kind` = 'loaded' | 'captured'. What the session showed before a capture is forgotten. */
    setAnchor(rest, up, dn, kind) {
      this.rest = rest; this.anchor.rest = rest;
      if (up != null) { this.up = up; this.anchor.up = up; }
      if (dn != null) { this.dn = dn; this.anchor.dn = dn; }
      this.captured = kind === 'captured'; this.trust = TRUST[kind] || TRUST.loaded;
      if (this.captured) this.forget();
    }
    /** Re-estimate (called about twice a second). `ease` 0..1 = how far to move toward the new estimate. */
    refresh(ease) {
      if (this.total < 1) return;                                        // under a second of footage: nothing to say yet
      const A = this.anchor, w0 = this.trust * this.slow, est = Math.min(this._pct(this.q), this.cap);
      let target = (w0 * A.rest + this.total * est) / (w0 + this.total);
      if (this.captured) target = clamp(target, A.rest - DRIFT * A.dn, A.rest + DRIFT * A.up);
      this.rest += (target - this.rest) * ease;
      if (this.total < 3) return;
      const up = this._pct(0.995) - this.rest, dn = this.rest - this._pct(0.005);
      // the range grows when he shows more; it never falls far under the saved / default one
      this.up += (Math.max(A.up * 0.85, up) - this.up) * ease;
      this.dn += (Math.max(A.dn * 0.85, dn) - this.dn) * ease;
    }
    /** value -> about -1..1 (0 = neutral, +-1 = strong), with a small dead zone. */
    norm(v, dead) {
      const d = v - this.rest;
      const r = d >= 0 ? this.up : this.dn, z = dead || 0;
      const a = Math.abs(d) / Math.max(1e-6, r);
      return a <= z ? 0 : Math.sign(d) * (a - z) / (1 - z);
    }
  }

  // ------------------------------------------------------------------ the guided neutral capture
  /**
   * A frame may only go into a captured neutral when it passes these checks. They use ABSOLUTE numbers (MediaPipe's raw
   * blendshape scores, lip gap and lid gap in eye-distance units), so they work on day one with no calibration at all.
   * Measured on the owner's clips: talking opens the lips to 0.11-0.14 (closed: 0.00-0.02) and the jaw score to 0.03-0.24;
   * a smile scores 0.3-0.9 (talking: under 0.1); a blink scores over 0.6 with a lid gap under 0.1 (open: 0.20-0.32).
   */
  const CAPTURE = { holdMs: 2000, timeoutMs: 5000, lipGap: 0.06, jawOpen: 0.12, smileAvg: 0.2, smileOne: 0.35, blink: 0.55, lidGap: 0.13,
    stillDeg: 6, stillPos: 0.1, settleMs: 400, minFrames: 8 };
  const median = (arr) => { const a = Float64Array.from(arr).sort(); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : NaN; };

  // ------------------------------------------------------------------ input in either shape
  /** MediaPipe's FaceLandmarkerResult, or one `face` record of tmp/raw/<clip>.json ({ bs, lm, mat }) -> { bs, lm, mat, flat }. */
  function readInput(res) {
    if (!res) return null;
    if (res.lm && res.bs && res.mat) return { bs: res.bs, lm: res.lm, mat: res.mat, flat: true, names: null };
    const lm = res.faceLandmarks && res.faceLandmarks[0], bsr = res.faceBlendshapes && res.faceBlendshapes[0];
    const mat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
    if (!lm || !lm.length || !bsr || !bsr.categories || !mat) return null;
    return { bs: bsr.categories, lm, mat: mat.data || mat, flat: false, names: true };
  }
  /** One record of tmp/raw/<clip>.json -> the object FaceLandmarker.detectForVideo returns (for tools that want that shape). */
  function resultFromRaw(rec, bsNames) {
    if (!rec) return { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
    const names = bsNames || MP_NAMES, lm = [];
    for (let i = 0; i < rec.lm.length; i += 3) lm.push({ x: rec.lm[i], y: rec.lm[i + 1], z: rec.lm[i + 2] });
    return {
      faceLandmarks: [lm],
      faceBlendshapes: [{ categories: rec.bs.map((score, index) => ({ index, score, categoryName: names[index] })) }],
      facialTransformationMatrixes: [{ rows: 4, columns: 4, data: rec.mat }],
    };
  }

  // ------------------------------------------------------------------ the signal
  function create(options) {
    let mirror = !!(options && options.mirror);
    const stats = {}, bsStats = {};
    for (const k in GEO_DEFAULT) { const d = GEO_DEFAULT[k]; stats[k] = new Stat(d, d.rest - 4 * d.dn - 0.05, d.rest + 4 * d.up + 0.05, REST_Q[k], REST_CAP[k], SLOW[k]); }
    for (const n of MP_NAMES.slice(1)) {
      const eye = /^eye/.test(n);
      bsStats[n] = new Stat(D(0.03, BS_DEFAULT_UP[n] || 0.5, 0.5), 0, 1, eye ? BS_REST_Q_EYE : BS_REST_Q, BS_REST_CAP[n] == null ? BS_REST_CAP_DEFAULT : BS_REST_CAP[n], /^eyeLook/.test(n) ? 10 : 1);
    }
    // The head's rest pose, place and size are NEVER taken from a saved calibration (a seed learned from another picture
    // layout put the avatar off centre and a size too close): they are the average of the first second and a half of the
    // session, set again by every capture, and afterwards re-centred very slowly so the avatar does not sit off centre
    // for a whole show.
    const head = { yaw: 0, pitch: 0, roll: 0, cx: null, cy: null, hw: null, n: 0 };
    const HEAD_LEARN_FRAMES = 45, HEAD_TAU_POS = 40, HEAD_TAU_ROT = 90;
    const filt = {}, raw = new Float32Array(52), geo = {};
    const fil = (key, kind) => filt[key] || (filt[key] = new OneEuro(...FILTER[kind]));
    const lid = { r: mkLid(), l: mkLid() };
    let lastT = null, sinceStats = 0, frames = 0, bsIndex = null;
    let capture = null, captured = false, capturedAtMs = null;
    const capStatus = { state: 'idle', progress: 0, reason: null, seq: 0, why: null };
    const shut = { r: false, l: false };
    let bothShutT = -1e9;

    function mkLid() { return { dn: new Window(250, false), sq: new Window(250, false), open: new Window(380, true) }; }   // 380 ms: his blink plus the slow reopening after it
    function resetFilters() { for (const k in filt) filt[k].reset(); for (const s of ['r', 'l']) { lid[s].dn.reset(); lid[s].sq.reset(); lid[s].open.reset(); } }

    /** The measurements of one frame, in the head's own frame, IOD units (person sides 'r' / 'l'). */
    function measure(inp, W, H) {
      const L = inp.lm, m = inp.mat;
      // head axes in camera space (x image right, y up, z toward the camera); the matrix also carries a scale
      const nx = Math.hypot(m[0], m[1], m[2]) || 1, ny = Math.hypot(m[4], m[5], m[6]) || 1, nz = Math.hypot(m[8], m[9], m[10]) || 1;
      const ax = [m[0] / nx, m[1] / nx, m[2] / nx], ay = [m[4] / ny, m[5] / ny, m[6] / ny], az = [m[8] / nz, m[9] / nz, m[10] / nz];
      const pt = inp.flat
        ? (i) => { const x = L[i * 3] * W, y = -L[i * 3 + 1] * H, z = -L[i * 3 + 2] * W; return [x * ax[0] + y * ax[1] + z * ax[2], x * ay[0] + y * ay[1] + z * ay[2], x * az[0] + y * az[1] + z * az[2]]; }
        : (i) => { const p = L[i], x = p.x * W, y = -p.y * H, z = -p.z * W; return [x * ax[0] + y * ax[1] + z * ax[2], x * ay[0] + y * ay[1] + z * ay[2], x * az[0] + y * az[1] + z * az[2]]; };
      const img = inp.flat ? (i) => [L[i * 3] * W, L[i * 3 + 1] * H, L[i * 3 + 2] * W] : (i) => [L[i].x * W, L[i].y * H, L[i].z * W];
      const eye = {};
      for (const s of ['r', 'l']) {
        const q = P[s], o = pt(q.out), n = pt(q.inn);
        const c = [(o[0] + n[0]) / 2, (o[1] + n[1]) / 2, (o[2] + n[2]) / 2], w = Math.hypot(o[0] - n[0], o[1] - n[1]) || 1;
        let gap = 0, lowY = 0;
        for (let k = 0; k < 3; k++) { const u = pt(q.up[k]), d = pt(q.lo[k]); gap += u[1] - d[1]; if (k === 0) lowY = d[1]; }
        let by = 0, bw = 0;
        const bp = q.brow.map(pt);
        for (let k = 0; k < 5; k++) { by += bp[k][1] * BROW_W[k]; bw += BROW_W[k]; }
        const ir = pt(q.iris);
        eye[s] = { c, w, gap: Math.max(0, gap / 3) / w, low: (lowY - c[1]) / w, browY: by / bw - c[1],
          tilt: (bp[4][1] + 0.5 * bp[3][1]) / 1.5 - (bp[0][1] + 0.5 * bp[1][1]) / 1.5, browIn: bp[4], ix: (ir[0] - c[0]) / w, iy: (ir[1] - c[1]) / w };
      }
      const iod = Math.hypot(eye.r.c[0] - eye.l.c[0], eye.r.c[1] - eye.l.c[1], eye.r.c[2] - eye.l.c[2]) || 1;
      const cr = pt(P.r.corner), cl = pt(P.l.corner), top = pt(P.lipTop), bot = pt(P.lipBot), iu = pt(P.inUp), il = pt(P.inLo), nb = pt(P.noseBase), ch = pt(P.chin);
      const open = Math.max(0, iu[1] - il[1]);
      // the lip line the corners are measured against: the upper lip, lowered by part of the opening (a dropped jaw
      // takes the corners down with it; that is not a frown)
      const ref = iu[1] - 0.42 * open;
      const g = geo;
      g.browHr = eye.r.browY / iod; g.browHl = eye.l.browY / iod; g.browTr = eye.r.tilt / iod; g.browTl = eye.l.tilt / iod;
      g.browGap = Math.abs(eye.l.browIn[0] - eye.r.browIn[0]) / iod;
      g.gapR = eye.r.gap; g.gapL = eye.l.gap; g.lowR = eye.r.low; g.lowL = eye.l.low;
      g.irisXr = eye.r.ix; g.irisXl = eye.l.ix; g.irisY = (eye.r.iy + eye.l.iy) / 2;
      g.mouthW = Math.hypot(cr[0] - cl[0], cr[1] - cl[1]) / iod; g.mouthO = open / iod;
      g.cornR = (cr[1] - ref) / iod; g.cornL = (cl[1] - ref) / iod;
      g.lipT = Math.max(0, (top[1] - iu[1]) + (il[1] - bot[1])) / iod; g.jawD = (nb[1] - ch[1]) / iod;
      g.mouthX = ((cr[0] + cl[0]) / 2 - nb[0]) / iod; g.upLip = (nb[1] - top[1]) / iod;
      // head: where it is in the picture and how big
      const a = img(P.edgeR), b = img(P.edgeL), br = img(P.bridge);
      g._cx = br[0]; g._cy = br[1]; g._hw = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) || 1;
      // head angles (as v1): column-major 4x4, face-model axes in camera space
      g._yaw = Math.atan2(az[0], az[2]) * DEG; g._pitch = Math.asin(clamp(az[1], -1, 1)) * DEG; g._roll = -Math.atan2(ax[1], ax[0]) * DEG;
      // take the head-pose drift out (against the rest pose, limited to +-25 degrees)
      const dp = clamp(g._pitch - head.pitch, -25, 25) / 10, dy = clamp(g._yaw - head.yaw, -25, 25) / 10;
      for (const k in POSE) g[k] -= POSE[k][0] * dp + POSE[k][1] * dy;
    }

    function process(faceResult, tMs, size) {
      const inp = readInput(faceResult);
      const t = Number(tMs) || 0;
      if (capture && capture.t0 === null) capture.t0 = t;               // the capture's clock starts with the first frame after the call
      if (!inp) {
        if (lastT !== null && t - lastT > 400) { resetFilters(); lastT = null; }
        if (capture) captureFrame(null, t, 0, 1, 1);
        return null;
      }
      const W = (size && size.width) || 1, H = (size && size.height) || 1;
      measure(inp, W, H);
      const g = geo;
      // one broken landmark must not reach the learned neutral or the head's rest place: such a frame is "no face"
      let finite = Number.isFinite(g._cx) && Number.isFinite(g._cy) && Number.isFinite(g._hw) && Number.isFinite(g._yaw) && Number.isFinite(g._pitch) && Number.isFinite(g._roll);
      if (finite) for (const k in stats) if (!Number.isFinite(g[k])) { finite = false; break; }
      if (!finite) { if (capture) captureFrame(null, t, 0, W, H); return null; }
      if (lastT !== null && (t - lastT > 400 || t < lastT)) resetFilters();
      const dt = lastT === null ? 1 / 30 : clamp((t - lastT) / 1000, 0.001, 0.5);
      lastT = t; frames++;
      // --- raw blendshapes by MediaPipe index
      if (inp.names) {
        if (!bsIndex || bsIndex.length !== inp.bs.length) bsIndex = inp.bs.map((c) => (c.categoryName in MP_INDEX ? MP_INDEX[c.categoryName] : -1));
        raw.fill(0);
        for (let i = 0; i < inp.bs.length; i++) if (bsIndex[i] >= 0) raw[bsIndex[i]] = Number.isFinite(inp.bs[i].score) ? inp.bs[i].score : 0;
      } else for (let i = 0; i < 52; i++) raw[i] = Number.isFinite(inp.bs[i]) ? inp.bs[i] : 0;

      // --- learn: every frame into the histograms (weighted by its time); the estimates move about twice a second
      const w = Math.min(dt, 0.1);
      const smL = raw[MP_INDEX.mouthSmileLeft], smR = raw[MP_INDEX.mouthSmileRight];
      const smiling = (smL + smR) / 2 > CAPTURE.smileAvg || Math.max(smL, smR) > CAPTURE.smileOne;       // absolute scores: works on day one
      for (const k in stats) if (!(smiling && SMILE_CH[k])) stats[k].add(g[k], w);
      for (let i = 1; i < 52; i++) bsStats[MP_NAMES[i]].add(raw[i], w);
      if (capture) captureFrame(g, t, dt, W, H);
      sinceStats += dt;
      if (sinceStats >= 0.5) {
        const f = Math.exp(-sinceStats / MEMORY_S);
        const ease = frames < 900 ? 0.5 : 0.15;
        for (const k in stats) { stats[k].decay(f); stats[k].refresh(ease); }
        for (const n in bsStats) { bsStats[n].decay(f); bsStats[n].refresh(ease); }
        sinceStats = 0;
      }
      // head rest pose and place: the plain average of the first frames of the session, then a very slow re-centring
      if (head.cx === null) { head.yaw = g._yaw; head.pitch = g._pitch; head.roll = g._roll; head.cx = g._cx / W; head.cy = g._cy / H; head.hw = g._hw / W; head.n = 1; }
      else {
        head.n++;
        const learning = head.n <= HEAD_LEARN_FRAMES;
        const ap = learning ? 1 / head.n : 1 - Math.exp(-dt / HEAD_TAU_POS), ar = learning ? 1 / head.n : 1 - Math.exp(-dt / HEAD_TAU_ROT);
        head.yaw += (g._yaw - head.yaw) * ar; head.pitch += (g._pitch - head.pitch) * ar; head.roll += (g._roll - head.roll) * ar;
        head.cx += (g._cx / W - head.cx) * ap; head.cy += (g._cy / H - head.cy) * ap; head.hw += (g._hw / W - head.hw) * ap;
      }

      // --- sides: s = which person side is the picture's left / right, sx = sign of picture-right
      const pl = mirror ? 'l' : 'r', pr = mirror ? 'r' : 'l', sx = mirror ? -1 : 1;
      const S = (person) => (person === 'r' ? 'R' : 'L');               // suffix of the geo keys / MediaPipe names
      const out = { rot: null, pos: null, bs: {}, gaze: null, blink: null, lm: {} };

      // --- eyelids: fast closure (as v1's EyeLid: sustained look-down and squint taken out, lid gap as the "really shut" proof)
      const closure = {}, held = {};
      for (const p of ['r', 'l']) {
        const sfx = p === 'r' ? 'Right' : 'Left', gk = p === 'r' ? 'gapR' : 'gapL';
        const bl = Math.max(0, raw[MP_INDEX['eyeBlink' + sfx]] - Math.max(0, bsStats['eyeBlink' + sfx].rest - 0.12));
        const sustained = 0.5 * lid[p].dn.push(raw[MP_INDEX['eyeLookDown' + sfx]], t) + 0.2 * lid[p].sq.push(raw[MP_INDEX['eyeSquint' + sfx]], t);
        const ratio = g[gk] / Math.max(1e-4, stats[gk].rest);
        closure[p] = Math.max(remap01(bl - sustained, 0.16, 0.36), remap01(1 - ratio, 0.68, 0.8));
        // a HELD closure (eyes squeezed shut for a second) stays shut for as long as the lid gap itself is still closed:
        // the look-down / squint scores that climb during it are part of the squeeze, not a reason to reopen half way
        if (shut[p] && ratio < 0.45) closure[p] = 1;
        // the eyelid opening held over a blink's length: a blink does not pull it down, a wide eye shows at once
        held[p] = lid[p].open.push(ratio, t);
      }
      // a wink must not half-close the other eye: when one eye is clearly shut and the other's own lid gap is open, release it
      // (in his real blinks both lid gaps fall under half within a frame; in a wink the open eye's gap stays near 1)
      const ratioOf = (p) => geo[p === 'r' ? 'gapR' : 'gapL'] / Math.max(1e-4, stats[p === 'r' ? 'gapR' : 'gapL'].rest);
      const before = { r: closure.r, l: closure.l };
      for (const [a, b] of [['r', 'l'], ['l', 'r']]) {
        const gb = ratioOf(b);
        if (before[a] > 0.8 && ratioOf(a) < 0.5 && gb > 0.7) closure[b] = before[b] * remap01(1 - gb, 0, 0.3);
      }
      // both lids CLOSE together as well: one eye reads shut and the other's own lid gap is already well on its way
      // down (under 60 % of his normal; in a wink the open eye stays near 100 %)
      for (const [a, b] of [['r', 'l'], ['l', 'r']]) if (closure[a] > 0.8 && closure[b] < closure[a] && ratioOf(b) < 0.6) closure[b] = closure[a];
      shut.r = closure.r > 0.8; shut.l = closure.l > 0.8;
      // both lids OPEN together after a blink: for a fifth of a second after both were shut the slower eye follows the
      // faster one (one eye's score lags by 1-3 frames and showed as a wink flash). A real wink is never "both shut".
      if (closure.r > 0.6 && closure.l > 0.6) bothShutT = t;
      else if (t - bothShutT < 200) closure.r = closure.l = Math.min(closure.r, closure.l);
      out.blink = [r3(closure[pl]), r3(closure[pr])];

      // --- landmark channels
      const N = (k, dead) => stats[k].norm(g[k], dead);
      const lmv = {
        browL: N('browH' + pl, 0.12), browR: N('browH' + pr, 0.12),
        browTiltL: N('browT' + pl, 0.15), browTiltR: N('browT' + pr, 0.15),
        browPinch: Math.max(0, -N('browGap', 0.1)),
        squintL: Math.max(0, N('low' + S(pl), 0.1)), squintR: Math.max(0, N('low' + S(pr), 0.1)),
        mouthOpen: Math.max(0, N('mouthO', 0.05)),
        mouthWide: N('mouthW', 0.06),
        cornerL: N('corn' + S(pl), 0.12), cornerR: N('corn' + S(pr), 0.12),
        lipPress: Math.max(0, -N('lipT', 0.12)),
        jaw: Math.max(0, N('jawD', 0.06)),
        mouthX: sx * N('mouthX', 0.1),
        upperLip: Math.max(0, -N('upLip', 0.12)),
      };
      for (const k in lmv) out.lm[k] = r3(clamp(fil('lm.' + k, 'channel').filter(lmv[k], t), -1.3, 1.3));
      // held eyelid opening: 0 shut .. 1 normal .. ~1.5 wide (above normal it is scaled by his "wide" range)
      for (const [k, p] of [['eyeOpenL', pl], ['eyeOpenR', pr]]) {
        const gk = p === 'r' ? 'gapR' : 'gapL', st = stats[gk];
        const v = held[p] <= 1 ? held[p] : 1 + 0.5 * clamp((held[p] - 1) * st.rest / Math.max(1e-4, st.up), 0, 1.2);
        out.lm[k] = r3(clamp(fil('lm.' + k, 'lid').filter(v, t), 0, 1.6));
      }

      // --- blendshapes: calibrated, sides swapped to the picture
      const bs = out.bs;
      for (let i = 1; i < 52; i++) {
        const n = MP_NAMES[i];
        if (DEAD.indexOf(n) >= 0) continue;
        const st = bsStats[n];
        const v = clamp01(Math.max(0, st.norm(raw[i], BS_DEAD)));
        bs[mirror ? n : swapName(n)] = r3(clamp01(fil('bs.' + n, 'channel').filter(v, t)));
      }
      // rebuilt from the landmarks (MediaPipe's own are dead), and the corrected lids
      bs.eyeBlinkLeft = out.blink[0]; bs.eyeBlinkRight = out.blink[1];
      bs.eyeWideLeft = r3(clamp01((out.lm.eyeOpenL - 1) / 0.5)); bs.eyeWideRight = r3(clamp01((out.lm.eyeOpenR - 1) / 0.5));
      bs.mouthFrownLeft = r3(clamp01(-out.lm.cornerL)); bs.mouthFrownRight = r3(clamp01(-out.lm.cornerR));
      bs.cheekSquintLeft = r3(clamp01(out.lm.squintL)); bs.cheekSquintRight = r3(clamp01(out.lm.squintR));
      bs.cheekPuff = 0; bs.jawForward = 0; bs.noseSneerLeft = r3(clamp01(out.lm.upperLip)); bs.noseSneerRight = bs.noseSneerLeft; bs.tongueOut = 0;

      // --- gaze from the iris: the more open eye counts more (a lowered lid hides the iris)
      const wr = clamp01(held.r), wl = clamp01(held.l), ws = wr + wl || 1;
      const gx = (N('irisXr', 0.06) * wr + N('irisXl', 0.06) * wl) / ws;
      const up = (bsStats.eyeLookUpLeft.norm(raw[MP_INDEX.eyeLookUpLeft], BS_DEAD) + bsStats.eyeLookUpRight.norm(raw[MP_INDEX.eyeLookUpRight], BS_DEAD)) / 2;
      const down = (bsStats.eyeLookDownLeft.norm(raw[MP_INDEX.eyeLookDownLeft], BS_DEAD) + bsStats.eyeLookDownRight.norm(raw[MP_INDEX.eyeLookDownRight], BS_DEAD)) / 2;
      const gy = 0.5 * N('irisY', 0.08) + 0.5 * (Math.max(0, up) - Math.max(0, down));
      out.gaze = [r3(clamp(fil('gx', 'gaze').filter(sx * gx, t), -1, 1)), r3(clamp(fil('gy', 'gaze').filter(gy, t), -1, 1))];

      // --- head
      out.rot = [r2(fil('yaw', 'rot').filter(sx * (g._yaw - head.yaw), t)), r2(fil('pitch', 'rot').filter(g._pitch - head.pitch, t)), r2(fil('roll', 'rot').filter(sx * (g._roll - head.roll), t))];
      const hwPx = head.hw * W;
      out.pos = [r4(fil('px', 'pos').filter(sx * (g._cx - head.cx * W) / hwPx, t)), r4(fil('py', 'pos').filter(-(g._cy - head.cy * H) / hwPx, t)), r4(fil('ps', 'pos').filter(g._hw / hwPx, t))];
      return out;
    }

    // ---------------------------------------------------------------- guided capture
    /** One frame of a running capture. g = this frame's measurements, or null when there is no (usable) face. */
    function captureFrame(g, t, dt, W, H) {
      const c = capture, C = CAPTURE;
      let reason = null;
      if (!g) reason = 'no-face';
      else {
        const sm = (raw[MP_INDEX.mouthSmileLeft] + raw[MP_INDEX.mouthSmileRight]) / 2, sm1 = Math.max(raw[MP_INDEX.mouthSmileLeft], raw[MP_INDEX.mouthSmileRight]);
        if (g.mouthO > C.lipGap || raw[MP_INDEX.jawOpen] > C.jawOpen) reason = 'mouth-open';
        else if (sm > C.smileAvg || sm1 > C.smileOne) reason = 'smiling';
        else if (Math.max(raw[MP_INDEX.eyeBlinkLeft], raw[MP_INDEX.eyeBlinkRight]) > C.blink || Math.min(g.gapR, g.gapL) < C.lidGap) reason = 'eyes-closed';
        else {
          // still = within a few degrees and a tenth of a head width of where the collection started
          const pose = [g._yaw, g._pitch, g._roll, g._cx / g._hw, g._cy / g._hw];
          if (!c.ref) { c.ref = pose; c.movedAt = null; }
          const off = Math.max(Math.abs(pose[0] - c.ref[0]), Math.abs(pose[1] - c.ref[1]), Math.abs(pose[2] - c.ref[2])) > C.stillDeg || Math.hypot(pose[3] - c.ref[3], pose[4] - c.ref[4]) > C.stillPos;
          if (off) {
            reason = 'moving';
            if (c.movedAt === null) c.movedAt = t;
            // he has settled somewhere else: start collecting again from there
            else if (t - c.movedAt > C.settleMs) { c.ref = pose; c.movedAt = null; c.good = 0; c.n = 0; for (const k in c.geo) c.geo[k].length = 0; for (const a of c.bs) a.length = 0; for (const a of c.head) a.length = 0; }
          } else c.movedAt = null;
        }
      }
      if (reason) { c.why[reason] = (c.why[reason] || 0) + 1; }
      else {
        c.n++; c.good += Math.min(100, dt * 1000);
        for (const k in stats) c.geo[k].push(g[k]);
        for (let i = 1; i < 52; i++) c.bs[i].push(raw[i]);
        const hv = [g._yaw, g._pitch, g._roll, g._cx / W, g._cy / H, g._hw / W];
        for (let i = 0; i < 6; i++) c.head[i].push(hv[i]);
      }
      capStatus.state = 'collecting'; capStatus.reason = reason; capStatus.progress = clamp01(c.good / c.holdMs);
      if (c.good >= c.holdMs && c.n >= C.minFrames) finishCapture();
      else if (t - c.t0 >= c.timeoutMs) endCapture('rejected', 'timeout');
    }
    function endCapture(state, reason) {
      const c = capture;
      capture = null;
      let why = null, most = 0;
      if (c && state === 'rejected') for (const k in c.why) if (c.why[k] > most) { most = c.why[k]; why = k; }
      capStatus.state = state; capStatus.reason = reason; capStatus.why = why; capStatus.seq++;
      if (state === 'done') capStatus.progress = 1;
    }
    /** The median of the accepted frames becomes his neutral, and the head's rest pose and place. */
    function finishCapture() {
      const c = capture;
      for (const k in stats) stats[k].setAnchor(median(c.geo[k]), null, null, 'captured');
      for (let i = 1; i < 52; i++) bsStats[MP_NAMES[i]].setAnchor(median(c.bs[i]), null, null, 'captured');
      const h = c.head.map(median);
      head.yaw = h[0]; head.pitch = h[1]; head.roll = h[2]; head.cx = h[3]; head.cy = h[4]; head.hw = h[5]; head.n = HEAD_LEARN_FRAMES + 1;
      captured = true; capturedAtMs = Date.now();
      endCapture('done', null);
    }

    const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000, r4 = (v) => Math.round(v * 10000) / 10000;

    return {
      process,
      setMirror(on) { mirror = !!on; },
      /**
       * Starts a GUIDED capture of "his neutral face, looking straight, sitting where he sits" (calling it again restarts
       * it). Only frames that pass the checks count (a face is there, mouth closed, no smile, eyes open, head roughly
       * still); when `holdMs` of them are in, their MEDIAN becomes the neutral and captureStatus() says 'done'. Without
       * enough good frames inside `timeoutMs` it ends 'rejected' and NOTHING in the calibration changes.
       * (A bare number is taken as holdMs, as the first version of this call took one.)
       */
      captureNeutral(opts) {
        const o = typeof opts === 'number' ? { holdMs: opts } : (opts || {});
        const holdMs = Number(o.holdMs) > 0 ? Number(o.holdMs) : CAPTURE.holdMs, timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : CAPTURE.timeoutMs;
        const geoS = {}; for (const k in stats) geoS[k] = [];
        capture = { holdMs, timeoutMs: Math.max(timeoutMs, holdMs), t0: null, wall: Date.now(), good: 0, n: 0, geo: geoS, bs: Array.from({ length: 52 }, () => []), head: Array.from({ length: 6 }, () => []), ref: null, movedAt: null, why: {} };
        capStatus.state = 'collecting'; capStatus.progress = 0; capStatus.reason = null; capStatus.why = null;
      },
      /**
       * { state: 'idle' | 'collecting' | 'done' | 'rejected', progress: 0..1 (share of holdMs of GOOD frames so far),
       *   reason: why the last frame was not accepted (collecting): 'no-face' | 'mouth-open' | 'smiling' | 'eyes-closed' |
       *           'moving' | null, or why it ended (rejected): 'timeout',
       *   seq: goes up by one every time a capture ends, why: (rejected only) the check that failed most often }
       */
      captureStatus() {
        // no frames at all are arriving (process is not being called): the capture still ends
        if (capture && Date.now() - capture.wall > capture.timeoutMs + 1500) { capture.why['no-face'] = (capture.why['no-face'] || 0) + 1e6; endCapture('rejected', 'timeout'); }
        return { state: capStatus.state, progress: r3(capStatus.progress), reason: capStatus.reason, seq: capStatus.seq, why: capStatus.why };
      },
      /** captured: a guided capture is in use (made now or loaded); capturedAtMs: when (clock time) or null; samples: frames seen this session. */
      calibrationInfo() { return { captured, capturedAtMs: captured ? capturedAtMs : null, adaptive: true, samples: frames }; },
      get capturing() { return !!capture; },
      /** A plain object (JSON-safe) with everything learned: neutral and range per channel ([rest, up, dn, captured 0 / 1]). */
      getCalibration() {
        const pack = (set) => { const o = {}; for (const k in set) o[k] = [r4(set[k].rest), r4(set[k].up), r4(set[k].dn), set[k].captured ? 1 : 0]; return o; };
        return { v: 1, frames, captured, capturedAtMs: captured ? capturedAtMs : null, geo: pack(stats), bs: pack(bsStats),
          head: { yaw: r2(head.yaw), pitch: r2(head.pitch), roll: r2(head.roll), cx: head.cx, cy: head.cy, hw: head.hw } };
      },
      /**
       * Load a saved calibration. Its flags are honoured: a CAPTURED neutral comes back as a captured one (trusted for
       * minutes), a learned one (or the seed) as a starting point that the session outweighs in well under a minute.
       * Nothing loaded is frozen, and the head's rest pose and place are never loaded (see `head` above).
       */
      setCalibration(obj) {
        if (!obj || obj.v !== 1) return false;
        const was = obj.captured === true;                               // files written before the guided capture have no such flag: not trusted as captured
        const unpack = (set, src) => {
          for (const k in set) {
            const v = src && src[k];
            if (!Array.isArray(v) || v.length < 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) continue;
            set[k].setAnchor(v[0], Math.max(1e-3, v[1]), Math.max(1e-3, v[2]), was && v[3] === 1 ? 'captured' : 'loaded');
          }
        };
        unpack(stats, obj.geo); unpack(bsStats, obj.bs);
        captured = was; capturedAtMs = was && Number.isFinite(obj.capturedAtMs) ? obj.capturedAtMs : null;
        return true;
      },
      /** Forget the filters' history (a new source, a cut in the footage). Calibration is kept; the head's rest place is learned again. */
      reset() { resetFilters(); lastT = null; head.cx = null; head.n = 0; shut.r = shut.l = false; bothShutT = -1e9; },
      /** For tools: the last frame's raw measurements (head frame, IOD units), raw blendshapes, the neutral in use. */
      debug() { return { geo: Object.assign({}, geo), raw: Array.from(raw), rest: Object.fromEntries(Object.keys(stats).map((k) => [k, stats[k].rest])), head: Object.assign({}, head) }; },
    };
  }

  return { create, resultFromRaw, OneEuro, MP_NAMES, BS_NAMES, LM_CHANNELS, FILTER, DEAD, POSE, CAPTURE, TRUST, REST_Q, version: 3 };
});
