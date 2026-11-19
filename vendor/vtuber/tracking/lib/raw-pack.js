// Tracker v2: the raw pose + hand results travel from the body worker to the hub as a few typed arrays (cheap to
// post), and are rebuilt there into the SHAPE MediaPipe returns, which is what tracking/lib/body-signal.js is written
// against. Pure UMD (no DOM): used by worker-body.js (pack), worker-hub.js (shape) and the Node tests.
//   VTRaw.packPose(poseResult)   -> { n: 0 | 1, lm, world }        33 x [x, y, z, visibility, presence]  (presence -1 = not given)
//   VTRaw.packHands(handResult)  -> [{ lm, world, handed, score, index }]   21 x [x, y, z] per hand
//   VTRaw.poseShape(packed)      -> { landmarks: [[{ x, y, z, visibility(, presence) }]], worldLandmarks: [[...]] }  ([] when no body)
//   VTRaw.handsShape(packed)     -> { landmarks, worldLandmarks, handednesses, handedness } | null (null = the model was not run)
// Values come back with float32 precision.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VTRaw = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const pack5 = (src) => {
    const o = new Float32Array(src.length * 5);
    for (let i = 0; i < src.length; i++) {
      const p = src[i], k = i * 5;
      o[k] = p.x; o[k + 1] = p.y; o[k + 2] = p.z || 0; o[k + 3] = p.visibility === undefined ? 1 : p.visibility; o[k + 4] = p.presence === undefined ? -1 : p.presence;
    }
    return o;
  };
  const pack3 = (src) => { const o = new Float32Array(src.length * 3); for (let i = 0; i < src.length; i++) { o[i * 3] = src[i].x; o[i * 3 + 1] = src[i].y; o[i * 3 + 2] = src[i].z || 0; } return o; };
  const un5 = (a) => { const o = new Array(a.length / 5); for (let i = 0; i < o.length; i++) { const k = i * 5; const p = { x: a[k], y: a[k + 1], z: a[k + 2], visibility: a[k + 3] }; if (a[k + 4] >= 0) p.presence = a[k + 4]; o[i] = p; } return o; };
  const un3 = (a) => { const o = new Array(a.length / 3); for (let i = 0; i < o.length; i++) { const k = i * 3; o[i] = { x: a[k], y: a[k + 1], z: a[k + 2] }; } return o; };

  function packPose(res) {
    const a = res && res.landmarks && res.landmarks[0];
    if (!a) return { n: 0, lm: null, world: null };
    const w = res.worldLandmarks && res.worldLandmarks[0];
    return { n: 1, lm: pack5(a), world: w ? pack5(w) : null };
  }
  function packHands(res) {
    const out = [];
    const sides = (res && (res.handednesses || res.handedness)) || [];
    const L = (res && res.landmarks) || [], W = (res && res.worldLandmarks) || [];
    for (let k = 0; k < L.length; k++) {
      const hd = sides[k] && sides[k][0];
      out.push({ lm: pack3(L[k]), world: W[k] ? pack3(W[k]) : null, handed: hd ? hd.categoryName : null, score: hd ? hd.score : 0, index: hd ? hd.index : 0 });
    }
    return out;
  }
  function poseShape(p) {
    if (!p || !p.n) return { landmarks: [], worldLandmarks: [] };
    return { landmarks: [un5(p.lm)], worldLandmarks: p.world ? [un5(p.world)] : [] };
  }
  function handsShape(h) {
    if (!h) return null;
    const sides = h.map((x) => [{ score: x.score, index: x.index, categoryName: x.handed, displayName: x.handed }]);
    return { landmarks: h.map((x) => un3(x.lm)), worldLandmarks: h.map((x) => (x.world ? un3(x.world) : [])), handednesses: sides, handedness: sides };
  }

  return { packPose, packHands, poseShape, handsShape };
});
