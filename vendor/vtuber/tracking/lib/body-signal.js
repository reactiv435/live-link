// tracking/lib/body-signal.js  (BODY agent, VTuber v2)  ->  self.VTBodySignal / module.exports
//
// Raw MediaPipe PoseLandmarker + HandLandmarker results -> the `body` and `hands` parts of the `perf` message.
// Pure (no DOM): safe in a worker and in Node tests.
//
//   const sig = VTBodySignal.create({ mirror });
//   const { body, hands } = sig.process({ pose, hands }, tMs, { width, height });
//     pose  = PoseLandmarker.detectForVideo(...) result or null   (landmarks[0][33] {x,y,z,visibility}, worldLandmarks[0][33])
//     hands = HandLandmarker.detectForVideo(...) result or null   (landmarks[k][21], worldLandmarks[k][21], handedness[k][0])
//     tMs   = the capture time of the frame (ms, rising); width / height = the picture size in pixels (for the aspect)
//     optional third field `region: [x0, y0, x1, y1]` (fractions of the frame): the part of the frame that is real camera
//     picture. Live it is the whole frame (leave it out). The test footage is the STREAM picture, where the camera sits
//     inside a larger frame with black bands: points in the bands are not "in the picture".
//   VTBodySignal.fromRaw(frame) rebuilds that input from one frame of tmp/raw/<clip>.json (tools/record-raw.mjs).
//
// OUTPUT (protocol v2, V2-PLAN.md). "l" / "r" = the left / right side of the PICTURE THE VIEWER SEES, after `mirror`.
// +x = picture right, +y = up, +z = toward the camera. Lengths are in shoulder widths.
//   body: null | {
//     tilt, twist,          degrees. tilt + = clockwise on screen (picture-right shoulder lower). twist + = the chest turns toward picture right.
//     lean: [x, z],         chest shift against his own resting place: +x picture right, +z toward the camera
//     shrug: [l, r],        0..1
//     arms: { l: null | { wrist: [x,y,z], elbow: [x,y,z] | null, conf, src: 'hand' | 'pose' }, r: ... }
//                           origin = that side's shoulder. `elbow` is null when his elbow is not reliably in the picture.
//     head: [x, y, w],      ADDED: his head centre from the middle of the shoulders, and his head width (for hands near the head)
//     sw: number            ADDED: shoulder width as a share of the picture width (diagnostics)
//   }
//   hands: { l: null | { palm: [x,y,z], dir: [x,y,z], curl: [thumb, index, middle, ring, pinky] 0..1,
//                        pose: 'open'|'fist'|'point'|'peace'|'thumb'|null, conf, open: 0..1 (ADDED: 1 = flat hand) }, r: ...,
//            overFace: true | false }   ADDED (fix round): a detected hand (also one that was refused as an arm driver) lies
//                           over his lower face, between the nose and below the chin, within the face width. The face
//                           side holds the mouth / brows / lids while it is true. Always present; false when no hand is seen.
//                           palm = the direction the palm faces; dir = wrist toward the middle knuckle.
// A part that is not reliably seen is null. Nothing is held or guessed here: the avatar side (js/body.js) decides how to
// bridge a gap. The mirror is applied once, here, to the finished values (x flips, the sides swap, tilt and twist flip).
//
// Rules that keep the avatar honest (fix round, review findings 3, 6, 6b, 7):
//   * "Seen on two checks running" is counted in RUNS of the hand model, not in milliseconds: on a busy PC the body is
//     checked 4 to 8 times a second and a rule in ms would never confirm a hand. `hands: null` = the hand model was not
//     run for this frame (the tracker's load gate): no news, neither "a hand" nor "no hand".
//   * An arm never STARTS from the pose model's wrist alone. The pose wrist drives an arm only where the hand model
//     also sees a hand at that wrist (two runs running for a new arm); after such evidence it may carry the arm on
//     while it stays sure and moves on smoothly from where the arm was (2 s at most). With his hands out of view the
//     pose model still reports wrists at 0.8+, jumping about: those never raise an arm.
//   * One hand found twice (two sizes: a cup or a phone in the hand does that) is one hand: it is never handed to the
//     other arm.
//   * A shoulder line that collapses to under 0.6 of his usual width, or stands at more than 40 degrees, is not a
//     seated body facing the camera (he leans in close and sideways, a shoulder is out of the picture): body = null
//     until the shoulders are back. His resting posture is not learned from such frames.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VTBodySignal = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  const DEG = 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
  const angle = (a, b) => Math.acos(clamp(dot(a, b) / (len(a) * len(b) || 1), -1, 1)) * DEG;

  /** One Euro filter (Casiez et al.): heavy smoothing when still, almost none when moving. */
  class OneEuro {
    constructor(minCutoff, beta, dCutoff) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff || 1; this.x = null; this.dx = 0; this.t = null; }
    static alpha(cutoff, dt) { return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt)); }
    reset() { this.x = null; this.dx = 0; this.t = null; }
    filter(v, tMs) {
      if (this.x === null || this.t === null) { this.x = v; this.dx = 0; this.t = tMs; return v; }
      let dt = (tMs - this.t) / 1000;
      if (!(dt > 0)) return this.x;
      if (dt > 0.25) { this.x = v; this.dx = 0; this.t = tMs; return v; }   // a gap: start again, do not slide across it
      this.t = tMs;
      const raw = (v - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (raw - this.dx);
      this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
      return this.x;
    }
  }
  class Euro3 {
    constructor(mc, beta) { this.f = [new OneEuro(mc, beta), new OneEuro(mc, beta), new OneEuro(mc, beta)]; }
    reset() { this.f.forEach((f) => f.reset()); }
    filter(v, t) { return [this.f[0].filter(v[0], t), this.f[1].filter(v[1], t), this.f[2].filter(v[2], t)]; }
  }
  /** His own resting value of a channel: settles quickly at the start, then follows very slowly. */
  class Baseline {
    constructor(tauSlow, tauUp) { this.tauSlow = tauSlow; this.tauUp = tauUp || 0; this.reset(); }
    reset() { this.b = null; this.age = 0; }
    update(v, dt) {
      if (this.b === null) { this.b = v; this.age = 0; return v; }
      let tau = this.age < 1.2 ? 0.35 : this.tauSlow;
      if (this.tauUp && v > this.b) tau = Math.min(tau, this.tauUp);
      this.b += (v - this.b) * (1 - Math.exp(-dt / tau));
      this.age += dt;
      return this.b;
    }
  }

  const DEFAULTS = {
    shoulderVis: 0.5,      // both shoulders must be at least this visible for a body
    elbowVis: 0.6,         // an elbow below this (or off the picture) is not passed on
    wristVis: 0.8,         // a wrist with no matched hand must be this visible (and inside the picture) to drive the arm at all...
    poseSupport: 0.45,     // ...AND the hand model must see a hand within this (shoulder widths) of it: a detection that could not be
                           // used as the arm's hand (half out of the picture) still proves a hand is there. Never the pose wrist alone.
    poseCarryMs: 2000,     // without such a detection the pose wrist may only carry on an arm that hand evidence started, for at most this long
                           // after the last evidence (his raised hand at the picture edge, too blurred for the hand model: 1.2 s in one clip)...
    poseJump: [0.12, 1.5], // ...and only while it moves on smoothly from where the arm was: at most [shoulder widths] + [shoulder widths
                           // a second] x the time since. A wrist the pose model makes up jumps about; one it tracks does not. A frame
                           // that jumps is left out (the avatar holds the arm); the carry goes on from the last good place.
                           // Measured on 16 clips against a 350 ms limit with a loose step: carried frames that led back to a real hand
                           // 93 -> 121, carried frames after which the hand was gone 111 -> 83 (longest such stretch 0.3 s).
    edge: 0.02,            // picture margin: a pose wrist closer to the edge than this (share of the picture) is not trusted
    elbowEdge: 0.03,       // the same for an elbow (his elbows sit right at the bottom edge: there the model is guessing)
    handInside: 14,        // of the 21 hand points, at least this many must be inside the picture
    handSize: [0.07, 1.2], // wrist to middle knuckle in shoulder widths: smaller or larger is not a hand (a hand held up to the lens is about 0.9)
    matchMax: 1.1,         // upper limit of the matching cost (distance + stickiness + label)
    wristGate: 0.8,        // a hand farther than this (shoulder widths) from an arm's clearly seen pose wrist is not that arm's hand...
    stickGate: 0.35,       // ...unless it is this close to where that arm's hand was a moment ago
    twinDist: 0.32,        // two detections with the same label and wrists closer than this are one hand seen twice
    twinCentre: 0.4,       // two detections whose centres are closer than this (in lengths of the larger hand) are one hand seen twice, whatever their labels and sizes...
    twinOverlap: 0.5, twinRatio: 0.8,     // ...and so are two where more than this share of the smaller one's box lies inside the other's
                           // box AND the smaller hand is under twinRatio of the larger one's length
    twinWristVis: 0.8, twinWrist: 0.35,   // (unless the pose model sees both wrists this clearly, one within this of each detection).
                           // Measured on 16 clips: one hand seen twice has 0.63 to 1.00 of its box inside the other (median 0.94 and
                           // up) at 0.15 to 0.77 of its size; two real hands 0.00 to 0.26 at 0.63 to 1.00 (a frame or two up to 0.9
                           // while two hands cross: the arm's hold covers those).
    confirmFrames: 2, confirmGapMs: 400,   // a hand not seen for confirmGapMs (or 2.5 body checks, whichever is longer) must show in this many checks running before it counts
    confirmWithinMs: 120,  // "running" = on the hand model's previous run, or within this many ms (at 30 a second: a miss of a frame or two between)
    runGapMs: 700,         // two runs further apart than this are not "running" (a pause)
    overFace: [0.5, -0.05, 0.75], overFaceMin: 3,   // the lower face in face widths from the nose: half width, from, to (down); hand points needed inside
    faceBox: [0.6, -0.9, 0.85], faceGhostMin: 8,    // the whole face (half width, from, to): a "hand" with this many of its 21 points on it...
    faceWrist: 0.7, faceWristVis: 0.5, faceHandSize: 0.12,   // ...is a hand only if a pose wrist the model half believes lies this near its wrist
                           // (shoulder widths) and it is not tiny. At the live thresholds the hand model reads his talking mouth and
                           // his jaw as a small "hand" for 5 to 13 frames at a time (measured: 20 such stretches in 7 of 16 clips; every
                           // real hand at the face had its wrist seen at 0.62 or more within 0.6).
    collapse: [0.6, 0.66], // the shoulder width under [0] of his usual one = no body; it is back at [1] (a little apart, so it does not flicker)
    collapseAdoptS: 5,     // a small but steady, level shoulder line for this long is his new distance, not a collapse
    tiltGarbage: 40,       // a shoulder line at more than this many degrees is not a seated body
    tiltLimit: 35, leanLimit: 1.2, twistLimit: 60,   // last-resort limits of what is sent
    stickiness: 0.6,       // weight of "the same hand as a moment ago" in the matching
    labelWeight: 0.3,      // weight of MediaPipe's left / right label in the matching
    camDist: 2.2,          // camera distance in shoulder widths (turns "the shoulders look bigger" into lean z)
    handDepth: 0.55,       // share of the hand-size depth cue in the wrist's z (the rest is the pose model's z)
    handScale: 1.0,        // correction of the hand model's size against the pose model's (1 = trust both)
    zRange: [-0.35, 1.6],  // limits of the wrist's z
    baselineS: 25,         // seconds: how slowly "his resting posture" follows him
    shrugFull: 0.11, shrugDead: 0.025, // shoulder rise (shoulder widths) that counts as a full shrug / is ignored
    // filters: [minCutoff Hz, beta]. Hand points arrive raw from MediaPipe; pose points are already smoothed there.
    fWristHand: [1.6, 4.0], fWristPose: [2.2, 3.0], fWristZ: [0.9, 1.0], fElbow: [1.6, 1.5],
    fPalm: [1.4, 2.0], fCurl: [2.5, 4.0], fTilt: [1.8, 0.08], fTwist: [1.0, 0.03], fLean: [1.5, 2.0], fShrug: [1.8, 1.5], fHead: [1.5, 1.0],
    poseHoldFrames: 3,     // a hand shape label must be seen this many frames in a row before it replaces the old one
  };

  const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

  function create(options) {
    const P = Object.assign({}, DEFAULTS, options || {});
    let mirror = !!(options && options.mirror);
    const debug = {};
    let S;
    const sideState = () => ({
      wrist: new Euro3(P.fWristHand[0], P.fWristHand[1]), wristSrc: null, wz: new OneEuro(P.fWristZ[0], P.fWristZ[1]), elbow: new Euro3(P.fElbow[0], P.fElbow[1]),
      palm: new Euro3(P.fPalm[0], P.fPalm[1]), dir: new Euro3(P.fPalm[0], P.fPalm[1]), curl: [0, 1, 2, 3, 4].map(() => new OneEuro(P.fCurl[0], P.fCurl[1])),
      shrug: new OneEuro(P.fShrug[0], P.fShrug[1]), shrugBase: new Baseline(P.baselineS, 1.0), shrugPic: new Baseline(P.baselineS, 1.0),
      prev: null, prevT: -1e9, pose: null, cand: null, candN: 0, streak: 0, lastHandT: null, lastHandRun: -9, outT: null,
      supStreak: 0, lastSupT: -1e9, lastSupRun: -9, evT: null, armT: null, armPx: null,
    });
    function reset() {
      S = {
        t: null,
        // anatomical sides: L = his left (pose points 11, 13, 15), R = his right (12, 14, 16)
        L: sideState(), R: sideState(),
        tilt: new OneEuro(P.fTilt[0], P.fTilt[1]), twist: new OneEuro(P.fTwist[0], P.fTwist[1]), leanX: new OneEuro(P.fLean[0], P.fLean[1]), leanZ: new OneEuro(P.fLean[0] * 0.6, P.fLean[1]),
        head: new Euro3(P.fHead[0], P.fHead[1]),
        bTilt: new Baseline(P.baselineS), bTwist: new Baseline(P.baselineS), bMid: new Baseline(P.baselineS), bUnit: new Baseline(P.baselineS), bHeadW: new Baseline(P.baselineS, 1.0),
        votes: { Left: { L: 1, R: 0 }, Right: { L: 0, R: 1 } },     // MediaPipe's label -> which arm it really was (learned from positions)
        dtAvg: null,                    // the usual time between two body checks (ms)
        runN: 0,                        // runs of the hand model so far
        collapsed: false, lowT: null, lowRef: 0,
        over: false, overT: -1e9, ofStreak: 0, ofT: -1e9, ofRun: -9,
      };
    }
    reset();

    function handFeatures(lm, world, side) {
      // world points: x right, y DOWN, z AWAY from the camera -> x right, y up, z toward the camera
      const w = (i) => [world[i].x, -world[i].y, -world[i].z];
      const p0 = w(0), v5 = sub(w(5), p0), v17 = sub(w(17), p0), v9 = sub(w(9), p0);
      const dir = norm(v9);
      let palm = norm(cross(v5, v17));          // right hand: the palm faces this way
      if (side === 'L') palm = [-palm[0], -palm[1], -palm[2]];
      const curl = [];
      for (let f = 0; f < 5; f++) {
        const c = FINGERS[f], a = w(c[0]), b = w(c[1]), d = w(c[2]), e = w(c[3]);
        if (f === 0) curl.push(clamp((angle(sub(b, a), sub(d, b)) + angle(sub(d, b), sub(e, d)) - 25) / 70, 0, 1));
        else curl.push(clamp((angle(sub(a, p0), sub(b, a)) + angle(sub(b, a), sub(d, b)) + angle(sub(d, b), sub(e, d)) - 35) / 190, 0, 1));
      }
      // thumb held away from the hand (for "thumb"): its tip far from the index knuckle, in palm lengths
      const thumbOut = len(sub(w(4), w(5))) / (len(v9) || 1);
      return { dir, palm, curl, thumbOut };
    }
    function labelOf(curl, thumbOut) {
      const [t, i, m, r, p] = curl;
      if (i < 0.35 && m < 0.35 && r < 0.4 && p < 0.45) return 'open';
      if (i < 0.3 && m < 0.3 && r > 0.5 && p > 0.5) return 'peace';
      if (i < 0.3 && m > 0.5 && r > 0.5 && p > 0.5) return 'point';
      if (i > 0.55 && m > 0.55 && r > 0.55 && p > 0.5) return t < 0.35 && thumbOut > 0.6 ? 'thumb' : 'fist';
      return null;
    }

    function process(input, tMs, dims) {
      const W = (dims && dims.width) || 1, H = (dims && dims.height) || 1;
      const RG = dims && Array.isArray(dims.region) && dims.region.length === 4 ? dims.region : [0, 0, 1, 1];
      const rw = RG[2] - RG[0], rh = RG[3] - RG[1];
      /** is the point inside the camera picture, `m` (a share of the picture) away from its edges? */
      const inPic = (p, m) => p.x >= RG[0] + m * rw && p.x <= RG[2] - m * rw && p.y >= RG[1] + m * rh && p.y <= RG[3] - m * rh;
      if (S.t !== null && tMs < S.t - 1) reset();
      if (S.t !== null) {
        const gap = tMs - S.t;
        // the real time between body checks: 33 ms on a free PC, 130 to 250 ms on a busy one
        if (gap > 0 && gap <= 1000) S.dtAvg = S.dtAvg === null ? clamp(gap, 10, 500) : S.dtAvg + 0.3 * (clamp(gap, 10, 500) - S.dtAvg);
        // a pause: nothing that was "running" before it is still running after it
        if (gap > 1000) { for (const k of ['L', 'R']) { const st = S[k]; st.streak = 0; st.supStreak = 0; st.armT = null; st.evT = null; st.lastHandT = null; } S.ofStreak = 0; S.over = false; }
      }
      const dt = S.t === null ? 1 / 30 : clamp((tMs - S.t) / 1000, 0.001, 0.25);
      S.t = tMs;
      const poseRes = input && input.pose, handRes = input && input.hands;
      // `hands: null` = the hand model was not run for this frame (the tracker runs it less often on a busy PC)
      const handRan = !!handRes;
      if (handRan) S.runN++;
      const dtB = S.dtAvg === null ? 33 : S.dtAvg;
      const gapOk = Math.max(P.confirmGapMs, 2.5 * dtB);      // "a moment ago", in the body's own rhythm
      const lm = poseRes && poseRes.landmarks && poseRes.landmarks[0] || null;
      const wl = poseRes && poseRes.worldLandmarks && poseRes.worldLandmarks[0] || null;
      const px = (p) => [p.x * W, p.y * H];
      const vis = (i) => (lm[i].visibility == null ? 1 : lm[i].visibility);
      const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

      // ---------------------------------------------------------------- the body frame (un-mirrored picture, his own L / R)
      let bodyOk = !!(lm && lm.length >= 25 && vis(11) >= P.shoulderVis && vis(12) >= P.shoulderVis);
      let unit = 0, sL = null, sR = null, twistRaw = 0, swWorld = 0.34;
      if (bodyOk) {
        sL = px(lm[11]); sR = px(lm[12]);
        const sw2 = d2(sL, sR);
        if (wl && wl[11] && wl[12]) {
          const a = wl[11], b = wl[12];
          twistRaw = Math.atan2(a.z - b.z, a.x - b.x) * DEG;          // + = toward picture right (un-mirrored)
          swWorld = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) || 0.34;
        }
        unit = sw2 / Math.max(0.6, Math.cos(clamp(twistRaw, -50, 50) / DEG));   // the shoulder width he would show facing the camera
        if (!(unit > 4)) bodyOk = false;
      }
      // Is this a seated body facing the camera at all? When he leans in close and sideways one shoulder leaves the
      // picture and the pose model squeezes both shoulders into what is left: the width collapses, the line stands on
      // end. Such frames are no body (and his resting posture is not learned from them).
      let tiltRaw = 0;
      if (bodyOk) {
        tiltRaw = Math.atan2(sL[1] - sR[1], sL[0] - sR[0]) * DEG;          // + = picture-right shoulder (his left) lower = clockwise
        const base = S.bUnit.b;
        let bad = Math.abs(tiltRaw) > P.tiltGarbage;
        if (!bad && base !== null && S.bUnit.age >= 1) bad = unit < P.collapse[S.collapsed ? 1 : 0] * base;
        if (bad) {
          // unless he has really moved back for good: small, but steady and level for some seconds = his new distance
          if (S.lowT === null || Math.abs(unit - S.lowRef) > 0.2 * S.lowRef || Math.abs(tiltRaw) > 25) { S.lowT = tMs; S.lowRef = unit; }
          else if (tMs - S.lowT > P.collapseAdoptS * 1000) {
            bad = false;
            for (const b of [S.bTilt, S.bTwist, S.bMid, S.bUnit, S.bHeadW]) b.reset();
            for (const k of ['L', 'R']) { S[k].shrugBase.reset(); S[k].shrugPic.reset(); }
          }
        }
        if (!bad) S.lowT = null;
        S.collapsed = bad;
        if (bad) { bodyOk = false; unit = base || 0; }      // hands are still measured against his usual shoulder width
      }

      // ---------------------------------------------------------------- hands: which arm is each one on
      const cands = [];
      const dets = [];        // every detection of the hand model that has the size of a hand: also those that cannot drive an arm
      const hl = handRes && handRes.landmarks || [];
      const hw = handRes && handRes.worldLandmarks || [];
      const hh = handRes && (handRes.handedness || handRes.handednesses) || [];
      // his face in the picture, from the pose points: the nose, "across" = along the ear line (the eye line when that
      // gives more), "down" = square to it, in face widths. Used twice: to throw out his own mouth read as a hand, and
      // for `hands.overFace`.
      let face = null;
      if (lm && lm.length >= 9 && vis(0) >= 0.5) {
        const nose = px(lm[0]);
        let a = px(lm[5]), b = px(lm[2]), fw = d2(a, b) * 2.3;                      // eye to eye is about 0.43 of the face width
        if (vis(7) >= 0.3 && vis(8) >= 0.3) { const ea = px(lm[8]), eb = px(lm[7]), w2 = d2(ea, eb); if (w2 > fw) { a = ea; b = eb; fw = w2; } }
        if (unit) fw = clamp(fw, 0.3 * unit, 0.8 * unit);
        const dl = d2(a, b);
        if (fw > 4 && dl > 1) face = { nose, ux: (b[0] - a[0]) / dl, uy: (b[1] - a[1]) / dl, fw };
      }
      /** how many of a detection's points lie in a box on the face: [half width, from, to] in face widths from the nose */
      const onFace = (pts, box) => {
        let n = 0;
        for (const q of pts) {
          const x = q.x * W - face.nose[0], y = q.y * H - face.nose[1];
          const across = (x * face.ux + y * face.uy) / face.fw, down = (-x * face.uy + y * face.ux) / face.fw;
          if (Math.abs(across) <= box[0] && down >= box[1] && down <= box[2]) n++;
        }
        return n;
      };
      for (let k = 0; k < hl.length; k++) {
        const pts = hl[k];
        if (!pts || pts.length < 21) continue;
        const wrist = px(pts[0]), mid = px(pts[9]);
        // a real hand is neither a dot nor a giant: wrist to middle knuckle against the shoulders (when they are known)
        const sz = unit ? d2(wrist, mid) / unit : null;
        if (sz !== null && (sz < P.handSize[0] || sz > P.handSize[1])) continue;
        // A "hand" lying on his face: the hand model, run as willingly as the live tracker runs it, reads his talking
        // mouth or his jaw as a small hand. A real hand at the face is held up by an arm the pose model sees.
        if (face && onFace(pts, P.faceBox) >= P.faceGhostMin) {
          let arm = false;
          if (unit) for (const wi of [15, 16]) if (vis(wi) >= P.faceWristVis && d2(wrist, px(lm[wi])) <= P.faceWrist * unit) arm = true;
          if (!arm || sz < P.faceHandSize) continue;
        }
        const det = { k, pts, cand: null, out: false };
        dets.push(det);
        if (!hw[k] || hw[k].length < 21) continue;
        let inside = 0, cx = 0, cy = 0;
        for (const p of pts) { if (inPic(p, 0)) inside++; cx += p.x * W; cy += p.y * H; }
        if (inside < P.handInside) continue;
        const cat = hh[k] && hh[k][0] || null;
        // cen = the middle of the 21 points; len = wrist to middle knuckle to middle fingertip
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const p of pts) { const x = p.x * W, y = p.y * H; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        det.cand = { k, wrist, mid, cen: [cx / 21, cy / 21], len: d2(wrist, mid) + d2(mid, px(pts[12])), box: [x0, y0, x1, y1], label: cat ? cat.categoryName : null, score: cat && cat.score != null ? cat.score : 0.5, pts, world: hw[k], det, twinOf: null };
        cands.push(det.cand);
      }
      // The same hand found twice: keep one. It happens when a hand is blurred or half out of the picture (two
      // detections of about one size at one place), and when he holds something: a cup at the mouth is reported as a
      // large hand AND a smaller one inside it, often with different labels. The second copy must never become the
      // OTHER arm's hand (three of three drinks sent the wrong hand to the mouth).
      {
        const ref0 = unit || 0.3 * W;
        // which copy is the hand: the one at a pose wrist the model is sure of, else the larger, else the surer
        const fit = (c) => { let f = 9; if (bodyOk) for (const wi of [15, 16]) if (vis(wi) >= 0.5) f = Math.min(f, d2(c.wrist, px(lm[wi])) / ref0); return f; };
        for (let a = 0; a < cands.length; a++) for (let b = a + 1; b < cands.length; b++) {
          const A = cands[a], B = cands[b];
          if (A.drop || B.drop) continue;
          const dw = d2(A.wrist, B.wrist) / ref0, dm = d2(A.mid, B.mid) / ref0;
          const ix = Math.min(A.box[2], B.box[2]) - Math.max(A.box[0], B.box[0]), iy = Math.min(A.box[3], B.box[3]) - Math.max(A.box[1], B.box[1]);
          const small = Math.min((A.box[2] - A.box[0]) * (A.box[3] - A.box[1]), (B.box[2] - B.box[0]) * (B.box[3] - B.box[1]));
          let stacked = d2(A.cen, B.cen) / Math.max(A.len, B.len, 1e-6) < P.twinCentre;
          if (!stacked && ix > 0 && iy > 0 && ix * iy > P.twinOverlap * small && Math.min(A.len, B.len) < P.twinRatio * Math.max(A.len, B.len)) {
            // one box inside the other, one hand clearly smaller: one hand twice, unless the pose model clearly sees
            // BOTH wrists, one at each (his two hands really are together, one nearer the camera)
            const at = (c, wi) => vis(wi) >= P.twinWristVis && d2(c.wrist, px(lm[wi])) / ref0 <= P.twinWrist;
            stacked = !(bodyOk && ((at(A, 15) && at(B, 16)) || (at(A, 16) && at(B, 15))));
          }
          const alike = (dw < 0.14 && dm < 0.14) || (A.label === B.label && dw < P.twinDist && dm < P.twinDist);
          if (!stacked && !alike) continue;
          let lose;
          if (!stacked) lose = A.score >= B.score ? B : A;
          else {
            const fa = fit(A), fb = fit(B);
            if (Math.abs(fa - fb) > 0.15) lose = fa < fb ? B : A;
            else if (Math.abs(A.len - B.len) > 0.15 * Math.max(A.len, B.len)) lose = A.len > B.len ? B : A;
            else lose = A.score >= B.score ? B : A;
          }
          lose.drop = true; lose.twinOf = lose === A ? B : A;
        }
        for (let a = cands.length - 1; a >= 0; a--) if (cands[a].drop) cands.splice(a, 1);
      }
      const labelSide = (label) => { const v = S.votes[label]; if (!v) return null; return v.L >= v.R ? 'L' : 'R'; };
      const labelTrust = (label) => { const v = S.votes[label]; if (!v) return 0; const n = v.L + v.R; return Math.abs(v.L - v.R) / n; };
      const assign = { L: null, R: null };
      const ref = unit || 0.5 * W;
      const cost = (c, side) => {
        let s = 0, n = 0;
        if (bodyOk) {
          const wi = side === 'L' ? 15 : 16, ei = side === 'L' ? 13 : 14;
          const pw = px(lm[wi]), v = vis(wi);
          // the pose wrist when it is believable, else how far the hand is from where the forearm leaves the elbow
          if (v >= 0.25) { s += d2(c.wrist, pw) / ref * (0.5 + 0.5 * v); n++; }
          else if (vis(ei) >= 0.4) { s += Math.max(0, d2(c.wrist, px(lm[ei])) / ref - 0.75) + 0.3; n++; }
          else { s += 0.6; n++; }
        } else { s += ((c.wrist[0] / W < 0.5) === (side === 'R') ? 0.2 : 0.7); n++; }      // no body: his right hand is on picture left
        const st = S[side];
        if (st.prev && tMs - st.prevT < gapOk) s += P.stickiness * Math.min(1.5, d2(c.wrist, st.prev) / ref);
        else s += P.stickiness * 0.35;
        const ls = labelSide(c.label);
        if (ls && ls !== side) s += P.labelWeight * labelTrust(c.label);
        return s;
      };
      // may this hand belong to this arm at all?
      const allowed = (c, side) => {
        if (!bodyOk) return true;
        const st = S[side];
        if (st.prev && tMs - st.prevT < gapOk && d2(c.wrist, st.prev) / ref < P.stickGate) return true;
        const wi = side === 'L' ? 15 : 16;
        if (vis(wi) >= 0.5 && d2(c.wrist, px(lm[wi])) / ref > P.wristGate) return false;
        return true;
      };
      const BIG = 99;
      const full = (c, side) => (allowed(c, side) ? cost(c, side) : BIG);
      if (cands.length === 1) {
        const c = cands[0], cl = full(c, 'L'), cr = full(c, 'R');
        const side = cl <= cr ? 'L' : 'R';
        if (Math.min(cl, cr) < P.matchMax + P.stickiness) assign[side] = c;
      } else if (cands.length >= 2) {
        let best = null;
        for (let a = 0; a < cands.length; a++) for (let b = 0; b < cands.length; b++) {
          if (a === b) continue;
          const total = Math.min(full(cands[a], 'L'), 3) + Math.min(full(cands[b], 'R'), 3);
          if (!best || total < best.total) best = { total, a, b };
        }
        if (full(cands[best.a], 'L') < P.matchMax + P.stickiness) assign.L = cands[best.a];
        if (full(cands[best.b], 'R') < P.matchMax + P.stickiness) assign.R = cands[best.b];
      }
      // learn what MediaPipe's label means from clear cases (a hand right at one pose wrist and far from the other)
      if (bodyOk) for (const side of ['L', 'R']) {
        const c = assign[side];
        if (!c || !c.label || !S.votes[c.label]) continue;
        const near = d2(c.wrist, px(lm[side === 'L' ? 15 : 16])) / ref, far = d2(c.wrist, px(lm[side === 'L' ? 16 : 15])) / ref;
        if (near < 0.3 && far > 0.7 && vis(side === 'L' ? 15 : 16) > 0.6) { const v = S.votes[c.label]; v[side] = Math.min(400, v[side] + 1); }
      }

      // ---------------------------------------------------------------- per side: hand shape, arm
      const sideOut = { L: { arm: null, hand: null }, R: { arm: null, hand: null } };
      for (const side of ['L', 'R']) {
        const st = S[side], o = sideOut[side];
        let c = assign[side];
        const si = side === 'L' ? 11 : 12, ei = side === 'L' ? 13 : 14, wi = side === 'L' ? 15 : 16;
        // A hand that appears from nothing must be there on two checks running before it is believed: the hand model
        // now and then reports a "hand" for a single frame (a shirt print, the other hand seen twice). A hand that was
        // just there needs no second look. "Running" is counted in runs of the hand model: the previous run, whenever
        // that was (4 checks a second on a busy PC are 250 ms apart), or within 120 ms as before at full rate.
        if (handRan) {
          const just = st.lastHandT != null && (tMs - st.lastHandT < P.confirmWithinMs || (st.lastHandRun === S.runN - 1 && tMs - st.lastHandT <= P.runGapMs));
          if (c) { st.streak = just ? st.streak + 1 : 1; st.lastHandT = tMs; st.lastHandRun = S.runN; }
          else if (st.lastHandT == null || tMs - st.lastHandT >= P.confirmWithinMs) st.streak = 0;
        }
        if (c && (st.outT == null || tMs - st.outT > gapOk) && st.streak < P.confirmFrames) { st.prev = c.wrist; st.prevT = tMs; c = null; }
        if (c) { st.outT = tMs; c.det.out = true; }
        if (c) {
          st.prev = c.wrist; st.prevT = tMs;
          const f = handFeatures(c.pts, c.world, side);
          const palm = norm(st.palm.filter(f.palm, tMs)), dir = norm(st.dir.filter(f.dir, tMs));
          const curl = f.curl.map((v, i) => clamp(st.curl[i].filter(v, tMs), 0, 1));
          const lab = labelOf(curl, f.thumbOut);
          if (lab === st.pose) { st.cand = null; st.candN = 0; }
          else if (lab === st.cand) { if (++st.candN >= P.poseHoldFrames) { st.pose = lab; st.cand = null; st.candN = 0; } }
          else { st.cand = lab; st.candN = 1; }
          o.hand = { palm, dir, curl, pose: st.pose, conf: c.score, open: 1 - (curl[1] + curl[2] + curl[3] + curl[4]) / 4 };
        } else {
          st.palm.reset(); st.dir.reset(); st.curl.forEach((x) => x.reset()); st.pose = null; st.cand = null; st.candN = 0;
          if (tMs - st.prevT > gapOk) st.prev = null;
        }
        // no body (not seen, or collapsed): no arm, and nothing of an arm carries over to when it is back
        if (!bodyOk) { st.wrist.reset(); st.wz.reset(); st.elbow.reset(); st.wristSrc = null; st.supStreak = 0; st.armT = null; st.evT = null; continue; }
        const sh = side === 'L' ? sL : sR;
        // the wrist: from the hand when one is matched (precise), else from the pose when it is clearly in the picture
        let wp = null, src = null, conf = 0;
        if (c) { wp = c.wrist; src = 'hand'; conf = c.score; st.evT = tMs; }
        else {
          // No hand matched to this arm. The pose model's wrist may stand in for it (his raised fist half out of the
          // picture, a hand too blurred to match), but never on its own word: with his hands in his lap it still
          // reports wrists in front of his chest at 0.8 and more, jumping about (that raised a ghost arm while he only
          // talked). So the hand model must see a hand AT this wrist, on two runs running for an arm that is not up
          // yet. A detection that could not be used as this arm's hand (too few points inside the picture) counts;
          // the other arm's hand does not. Without one, the wrist may only carry a live arm on, while it moves on
          // smoothly from where the arm was.
          const p = lm[wi], pw = px(p);
          const sure = vis(wi) >= P.wristVis && inPic(p, P.edge);
          let sup = false;
          if (sure && handRan) {
            const other = assign[side === 'L' ? 'R' : 'L'], reach = P.poseSupport * unit;
            for (const d of dets) {
              let owner = d.cand;
              while (owner && owner.drop) owner = owner.twinOf;
              if (owner && owner === other) continue;
              let near = false;
              for (const q of d.pts) if (Math.hypot(q.x * W - pw[0], q.y * H - pw[1]) <= reach) { near = true; break; }
              if (near) { sup = true; break; }
            }
          }
          if (handRan) {
            const just = tMs - st.lastSupT < P.confirmWithinMs || (st.lastSupRun === S.runN - 1 && tMs - st.lastSupT <= P.runGapMs);
            if (sup) { st.supStreak = just ? st.supStreak + 1 : 1; st.lastSupT = tMs; st.lastSupRun = S.runN; }
            else if (tMs - st.lastSupT >= P.confirmWithinMs) st.supStreak = 0;
          }
          const live = st.armT != null && tMs - st.armT <= gapOk;
          const evid = sup && (live || st.supStreak >= P.confirmFrames);
          const carry = !evid && live && st.evT != null && tMs - st.evT <= P.poseCarryMs
            && d2(pw, st.armPx) / unit <= P.poseJump[0] + P.poseJump[1] * (tMs - st.armT) / 1000;
          if (sure && (evid || carry)) { wp = pw; src = 'pose'; conf = vis(wi) * 0.6; if (evid) st.evT = tMs; }
        }
        if (wp) { st.armT = tMs; st.armPx = wp; }
        if (!wp) { st.wrist.reset(); st.wz.reset(); st.elbow.reset(); st.wristSrc = null; continue; }
        // depth: the pose model's own guess, and (with a hand) how big the hand looks against how big the shoulders look
        let z = 0, zn = 0;
        if (wl && wl[wi] && wl[si]) { z += (1 - (c ? P.handDepth : 0)) * (-(wl[wi].z - wl[si].z) / swWorld); zn += 1 - (c ? P.handDepth : 0); }
        if (c) {
          let a = 0, b = 0;
          for (const [i, j] of [[0, 5], [0, 17], [5, 17], [0, 9], [9, 13], [5, 9]]) {
            a += d2(px(c.pts[i]), px(c.pts[j]));
            b += Math.hypot(c.world[i].x - c.world[j].x, c.world[i].y - c.world[j].y);
          }
          const rho = (a / (b || 1e-6)) / (unit / swWorld) * P.handScale;       // > 1 = the hand is nearer than the shoulders
          const zh = P.camDist * (1 - 1 / clamp(rho, 0.5, 4));
          o.rho = rho;
          z += P.handDepth * zh; zn += P.handDepth;
        }
        z = clamp(zn ? z / zn : 0, P.zRange[0], P.zRange[1]);
        if (st.wristSrc !== src) { st.wrist = new Euro3(src === 'hand' ? P.fWristHand[0] : P.fWristPose[0], src === 'hand' ? P.fWristHand[1] : P.fWristPose[1]); if (st.wristSrc && st.lastWrist) st.wrist.filter(st.lastWrist, tMs - dt * 1000); st.wristSrc = src; }
        const wxy = st.wrist.filter([(wp[0] - sh[0]) / unit, -(wp[1] - sh[1]) / unit, 0], tMs);
        const wz = st.wz.filter(z, tMs);
        st.lastWrist = [wxy[0], wxy[1], 0];
        let elbow = null;
        const pe = lm[ei];
        if (vis(ei) >= P.elbowVis && inPic(pe, P.elbowEdge)) {
          const e = px(pe);
          const ez = wl && wl[ei] && wl[si] ? clamp(-(wl[ei].z - wl[si].z) / swWorld, -1, 1.2) : 0;
          elbow = st.elbow.filter([(e[0] - sh[0]) / unit, -(e[1] - sh[1]) / unit, ez], tMs);
        } else st.elbow.reset();
        o.arm = { wrist: [wxy[0], wxy[1], wz], elbow, conf, src };
      }

      // ---------------------------------------------------------------- torso
      let body = null;
      if (bodyOk) {
        // picture left / right in the UN-mirrored picture: his right shoulder (12) is on picture left
        const mid = [(sL[0] + sR[0]) / 2, (sL[1] + sR[1]) / 2];
        const tilt = clamp(S.tilt.filter(tiltRaw - S.bTilt.update(tiltRaw, dt), tMs), -P.tiltLimit, P.tiltLimit);
        const twist = clamp(S.twist.filter(twistRaw - S.bTwist.update(twistRaw, dt), tMs), -P.twistLimit, P.twistLimit);
        // lean x: how far the middle of the shoulders has moved IN THE PICTURE from its resting place, in shoulder
        // widths (resting place kept in picture units: coming closer to the camera alone is not a sideways lean)
        const midN = mid[0] / W;
        const leanX = clamp(S.leanX.filter((midN - S.bMid.update(midN, dt)) * W / unit, tMs), -P.leanLimit, P.leanLimit);
        const ub = S.bUnit.update(unit, dt);
        const leanZ = S.leanZ.filter(clamp(P.camDist * (1 - ub / unit), -0.8, 0.8), tMs);
        // head: ears when both are seen
        let head = null, earY = null;
        if (vis(7) >= 0.5 && vis(8) >= 0.5) {
          const eL = px(lm[7]), eR = px(lm[8]);
          const wNow = d2(eL, eR) / unit * 1.12, wb = S.bHeadW.update(wNow, dt);
          head = S.head.filter([((eL[0] + eR[0]) / 2 - mid[0]) / unit, -((eL[1] + eR[1]) / 2 - mid[1]) / unit, Math.max(wNow, wb * 0.85)], tMs);
          earY = (eL[1] + eR[1]) / 2;
        } else S.head.reset();
        // shrug: the shoulder comes UP in the picture AND closer to the ears. Both must agree, so a nod (ears down,
        // shoulders where they were) or sitting up (everything up together) is not a shrug.
        const shrug = { L: 0, R: 0 };
        for (const side of ['L', 'R']) {
          const st = S[side];
          const sy = (side === 'L' ? sL : sR)[1] / unit;                // lower in the picture = larger
          const rest = st.shrugPic.update(sy, dt);
          if (earY == null) { st.shrug.reset(); continue; }
          const d = sy - earY / unit;                                   // ear to shoulder height
          const base = st.shrugBase.update(d, dt);
          const cue = Math.min(base - d, rest - sy);
          shrug[side] = clamp(st.shrug.filter(clamp((cue - P.shrugDead) / P.shrugFull, 0, 1), tMs), 0, 1);
        }
        body = { tilt, twist, lean: [leanX, leanZ], shrug: [shrug.R, shrug.L], arms: { l: sideOut.R.arm, r: sideOut.L.arm }, head, sw: unit / W };
      }
      // ---------------------------------------------------------------- a hand over the lower face (for the face side)
      // Any detection that passed as a hand counts, also one refused as an arm driver (a second copy of one hand, a
      // hand half out of the picture); one that is not an arm's confirmed hand must show on two runs running
      // (a single-frame ghost must not freeze his face).
      if (handRan) {
        let over = false, sureNow = false;
        if (face) for (const d of dets) if (onFace(d.pts, P.overFace) >= P.overFaceMin) { over = true; if (d.out) sureNow = true; }
        const just = tMs - S.ofT < P.confirmWithinMs || (S.ofRun === S.runN - 1 && tMs - S.ofT <= P.runGapMs);
        if (over) { S.ofStreak = just ? S.ofStreak + 1 : 1; S.ofT = tMs; S.ofRun = S.runN; }
        else if (tMs - S.ofT >= P.confirmWithinMs) S.ofStreak = 0;
        S.over = over && (sureNow || S.ofStreak >= P.confirmFrames);
        S.overT = tMs;
      } else if (tMs - S.overT > gapOk) S.over = false;          // the hand model was not run: its last word stands for a moment
      const hands = { l: sideOut.R.hand, r: sideOut.L.hand, overFace: S.over };
      debug.unit = unit; debug.cands = cands.length; debug.dets = dets.length; debug.assign = { L: assign.L ? assign.L.k : null, R: assign.R ? assign.R.k : null }; debug.votes = S.votes;
      debug.rho = { L: sideOut.L.rho, R: sideOut.R.rho }; debug.collapsed = S.collapsed; debug.dtAvg = dtB;
      if (!mirror) return { body, hands };
      // ---------------------------------------------------------------- the mirror, once
      const fx = (v) => (v ? [-v[0], v[1], v[2]] : v);
      const fa = (a) => (a ? { wrist: fx(a.wrist), elbow: fx(a.elbow), conf: a.conf, src: a.src } : null);
      const fh = (h) => (h ? Object.assign({}, h, { palm: fx(h.palm), dir: fx(h.dir) }) : null);
      return {
        body: body && { tilt: -body.tilt, twist: -body.twist, lean: [-body.lean[0], body.lean[1]], shrug: [body.shrug[1], body.shrug[0]], arms: { l: fa(body.arms.r), r: fa(body.arms.l) }, head: body.head && [-body.head[0], body.head[1], body.head[2]], sw: body.sw },
        hands: { l: fh(hands.r), r: fh(hands.l), overFace: hands.overFace },
      };
    }

    return { process, reset, setMirror(v) { mirror = !!v; }, get mirror() { return mirror; }, params: P, debug };
  }

  /** One frame of tmp/raw/<clip>.json -> the shape MediaPipe returns. */
  function fromRaw(frame) {
    const un = (flat, n) => { const out = []; for (let i = 0; i + n <= flat.length; i += n) out.push(n === 4 ? { x: flat[i], y: flat[i + 1], z: flat[i + 2], visibility: flat[i + 3] } : { x: flat[i], y: flat[i + 1], z: flat[i + 2] }); return out; };
    const pose = frame && frame.pose ? { landmarks: [un(frame.pose.lm, 4)], worldLandmarks: frame.pose.world ? [un(frame.pose.world, 4)] : [] } : null;
    const hs = frame && frame.hands || [];
    const hands = { landmarks: hs.map((h) => un(h.lm, 3)), worldLandmarks: hs.map((h) => (h.world ? un(h.world, 3) : [])), handedness: hs.map((h) => [{ categoryName: h.handed, score: h.score == null ? 0.5 : h.score }]) };
    return { pose, hands };
  }

  return { create, fromRaw, DEFAULTS, OneEuro };
});
