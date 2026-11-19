// Tracker v2 STAND-INS for the two signal modules, with exactly the interfaces fixed in V2-PLAN.md:
//   tracking/lib/face-signal.js (FACE agent)  -> VTFaceSignal
//   tracking/lib/body-signal.js (BODY agent)  -> VTBodySignal
// The workers load the real file first and fall back to these only when it does not exist (or fails to load), and
// the tracker page then says so. They do the plain, uncalibrated minimum so the plumbing can be run and measured.
// Pure UMD (no DOM). Exposed under different names so they can never shadow the real modules.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.VTFaceSignalStub = api.VTFaceSignalStub; root.VTBodySignalStub = api.VTBodySignalStub; }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RAD = 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const r3 = (v) => Math.round(v * 1000) / 1000 + 0;      // "+ 0": never a minus zero
  const r1 = (v) => Math.round(v * 10) / 10 + 0;

  function euler(m) {
    // column-major 4x4: face-model axes in camera space (x = picture right, y = up, z = toward the camera)
    const n = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const rx = n(m[0], m[1], m[2]);
    const fw = n(m[8], m[9], m[10]);
    return [Math.atan2(fw[0], fw[2]) * RAD, Math.asin(clamp(fw[1], -1, 1)) * RAD, -Math.atan2(rx[1], rx[0]) * RAD];
  }

  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  const VTFaceSignalStub = {
    stub: true,
    create(opts = {}) {
      let mirror = !!opts.mirror;
      let calib = { rot: [0, 0, 0], pos: null, bs: {}, capturedAt: 0 };
      let last = null, frames = 0;
      // The guided neutral capture of V2-FIX-ROUND.md (the same three calls the real face-signal.js offers):
      // only frames with a face, the mouth closed, no smile, the eyes open and the head still are collected; the
      // median of `holdMs` of them becomes the neutral; `timeoutMs` without enough of them changes nothing.
      let cap = null;
      let capStatus = { state: 'idle', progress: 0, reason: null, seq: 0 };
      const endCapture = (state, reason) => { capStatus = { state, progress: state === 'done' ? 1 : capStatus.progress, reason, seq: capStatus.seq + 1 }; cap = null; };
      /** one frame of a running capture; f = null when no face was found */
      function captureStep(f, tMs, w, h) {
        if (cap.t0 === null) cap.t0 = tMs;
        let why = null;
        if (!f) why = 'no-face';
        else {
          const dt = cap.prev ? Math.max(1, tMs - cap.prevT) : 0;
          const turn = cap.prev && dt < 500 ? Math.max(Math.abs(f.rot[0] - cap.prev.rot[0]), Math.abs(f.rot[1] - cap.prev.rot[1]), Math.abs(f.rot[2] - cap.prev.rot[2])) * 1000 / dt : 0;   // degrees a second
          const slide = cap.prev && dt < 500 ? Math.hypot(f.cx - cap.prev.cx, f.cy - cap.prev.cy) / f.hw * 1000 / dt : 0;                                                                // head widths a second
          const r = f.raw;
          if ((r.jawOpen || 0) > 0.25 || (r.mouthFunnel || 0) > 0.45) why = 'mouth-open';
          else if (((r.mouthSmileLeft || 0) + (r.mouthSmileRight || 0)) / 2 > 0.4) why = 'smiling';
          else if (((r.eyeBlinkLeft || 0) + (r.eyeBlinkRight || 0)) / 2 > 0.5) why = 'eyes-closed';
          else if (turn > 40 || slide > 0.5) why = 'moving';
          cap.prev = f; cap.prevT = tMs;
        }
        if (!why) {
          cap.good += cap.lastGoodT !== null && tMs - cap.lastGoodT < 250 ? tMs - cap.lastGoodT : 33;
          cap.lastGoodT = tMs;
          cap.rows.push({ rot: f.rot, pos: [f.cx / w, f.cy / h, f.hw / w], raw: f.raw });
        } else cap.lastGoodT = null;
        capStatus = { state: 'collecting', progress: Math.min(1, cap.good / cap.holdMs), reason: why, seq: capStatus.seq };
        if (cap.good >= cap.holdMs) {
          const rows = cap.rows, bs = {};
          for (const k in rows[0].raw) bs[k] = median(rows.map((x) => x.raw[k] || 0));
          calib = { rot: [0, 1, 2].map((i) => median(rows.map((x) => x.rot[i]))), pos: [0, 1, 2].map((i) => median(rows.map((x) => x.pos[i]))), bs, capturedAt: tMs };
          endCapture('done', null);
        } else if (tMs - cap.t0 >= cap.timeoutMs) endCapture('rejected', 'timeout');
      }
      return {
        stub: true,
        process(res, tMs, size) {
          const ok = res && res.faceLandmarks && res.faceLandmarks.length && res.faceBlendshapes && res.faceBlendshapes.length;
          const w = (size && size.width) || 1, h = (size && size.height) || 1;
          if (!ok) { last = null; if (cap) captureStep(null, tMs, w, h); return null; }
          const lm = res.faceLandmarks[0];
          const rot = res.facialTransformationMatrixes && res.facialTransformationMatrixes.length ? euler(res.facialTransformationMatrixes[0].data) : [0, 0, 0];
          // head centre and width in picture pixels (cheek to cheek: 234, 454)
          const cx = (lm[234].x + lm[454].x) / 2 * w, cy = (lm[234].y + lm[454].y) / 2 * h;
          const hw = Math.hypot((lm[454].x - lm[234].x) * w, (lm[454].y - lm[234].y) * h) || 1;
          const raw = {};
          for (const c of res.faceBlendshapes[0].categories) raw[c.categoryName] = c.score;
          last = { rot, cx, cy, hw, raw };
          frames++;
          if (cap) captureStep(last, tMs, w, h);
          if (!calib.pos) calib.pos = [cx / w, cy / h, hw / w];
          const sgn = mirror ? -1 : 1;
          const bs = {};
          for (const k in raw) {
            if (k === '_neutral') continue;
            // MediaPipe's Left / Right are the PERSON's. On the un-mirrored picture the person's left is picture right.
            const out = mirror ? k : (k.endsWith('Left') ? k.slice(0, -4) + 'Right' : k.endsWith('Right') ? k.slice(0, -5) + 'Left' : k);
            const base = calib.bs[k] || 0;
            bs[out] = r3(clamp((raw[k] - base) / (1 - Math.min(base, 0.8)), 0, 1));
          }
          const gx = ((raw.eyeLookOutLeft || 0) - (raw.eyeLookInLeft || 0) + (raw.eyeLookInRight || 0) - (raw.eyeLookOutRight || 0)) / 2;   // + = toward the person's left = picture right (un-mirrored)
          const gy = ((raw.eyeLookUpLeft || 0) + (raw.eyeLookUpRight || 0) - (raw.eyeLookDownLeft || 0) - (raw.eyeLookDownRight || 0)) / 2;
          return {
            rot: [r1(sgn * (rot[0] - calib.rot[0])), r1(rot[1] - calib.rot[1]), r1(sgn * (rot[2] - calib.rot[2]))],
            pos: [r3(sgn * (cx - calib.pos[0] * w) / hw), r3(-(cy - calib.pos[1] * h) / hw), r3((hw / w) / calib.pos[2])],
            bs, gaze: [r3(clamp(sgn * gx, -1, 1)), r3(clamp(gy, -1, 1))], lm: {}, stub: true,
          };
        },
        setMirror(b) { mirror = !!b; },
        /** Start (or start again) a guided capture. Nothing changes until it ends `done`. */
        captureNeutral(o = {}) {
          cap = { holdMs: o && o.holdMs > 0 ? Number(o.holdMs) : 2000, timeoutMs: o && o.timeoutMs > 0 ? Number(o.timeoutMs) : 5000, t0: null, good: 0, lastGoodT: null, prev: null, prevT: 0, rows: [] };
          capStatus = { state: 'collecting', progress: 0, reason: null, seq: capStatus.seq };
        },
        captureStatus() { return { ...capStatus }; },
        calibrationInfo() { return { captured: calib.capturedAt > 0, capturedAtMs: calib.capturedAt > 0 ? calib.capturedAt : null, adaptive: false, samples: frames }; },
        getCalibration() { return JSON.parse(JSON.stringify(calib)); },
        setCalibration(obj) { if (obj && typeof obj === 'object' && Array.isArray(obj.rot) && obj.rot.length >= 3) calib = { rot: obj.rot.slice(0, 3), pos: Array.isArray(obj.pos) && obj.pos.length >= 3 ? obj.pos.slice(0, 3) : null, bs: { ...(obj.bs || {}) }, capturedAt: Number(obj.capturedAt) > 0 ? Number(obj.capturedAt) : 0 }; },
        reset() { last = null; },
      };
    },
  };

  const VTBodySignalStub = {
    stub: true,
    create(opts = {}) {
      let mirror = !!opts.mirror;
      return {
        stub: true,
        process(input, tMs, size) {
          const w = (size && size.width) || 1, h = (size && size.height) || 1;
          const pose = input && input.pose, hr = input && input.hands;
          const sx = (x) => (mirror ? 1 - x : x);
          let body = null;
          const lm = pose && pose.landmarks && pose.landmarks[0];
          if (lm) {
            // 11 / 12 = the person's left / right shoulder. Picture-left shoulder: un-mirrored it is the person's RIGHT (12).
            const P = (i) => ({ x: sx(lm[i].x) * w, y: lm[i].y * h, z: (lm[i].z || 0) * w, v: lm[i].visibility === undefined ? 1 : lm[i].visibility });
            const idx = mirror ? { ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16 } : { ls: 12, rs: 11, le: 14, re: 13, lw: 16, rw: 15 };
            const ls = P(idx.ls), rs = P(idx.rs);
            const sw = Math.hypot(rs.x - ls.x, rs.y - ls.y) || 1;
            const arm = (s, ei, wi) => {
              const e = P(ei), wr = P(wi);
              const conf = Math.min(e.v, wr.v);
              if (conf < 0.3) return null;
              const rel = (p) => [r3((p.x - s.x) / sw), r3(-(p.y - s.y) / sw), r3(-(p.z - s.z) / sw)];
              return { elbow: rel(e), wrist: rel(wr), conf: r3(conf) };
            };
            body = {
              tilt: r1(Math.atan2(rs.y - ls.y, rs.x - ls.x) * RAD),
              twist: r1(Math.atan2(-(rs.z - ls.z), rs.x - ls.x) * RAD),
              lean: [0, 0], shrug: [0, 0],
              arms: { l: arm(ls, idx.le, idx.lw), r: arm(rs, idx.re, idx.rw) },
              stub: true,
            };
          }
          const hands = { l: null, r: null };
          const hl = hr && hr.landmarks ? hr.landmarks : [];
          for (let i = 0; i < hl.length && i < 2; i++) {
            const p = hl[i];
            const px = sx((p[0].x + p[5].x + p[17].x) / 3), py = (p[0].y + p[5].y + p[17].y) / 3;
            let dx = (sx(p[9].x) - sx(p[0].x)) * w, dy = -(p[9].y - p[0].y) * h;
            const l = Math.hypot(dx, dy) || 1;
            const side = px < 0.5 ? 'l' : 'r';
            if (hands[side]) continue;
            hands[side] = { palm: [r3(px), r3(py), 0], dir: [r3(dx / l), r3(dy / l), 0], curl: [0, 0, 0, 0, 0], pose: null, conf: 1, stub: true };
          }
          return { body, hands };
        },
        setMirror(b) { mirror = !!b; },
        reset() {},
      };
    },
  };

  return { VTFaceSignalStub, VTBodySignalStub };
});
