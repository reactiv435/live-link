// js/hands3d.js  (V5, HANDS)  ->  window.VTHands3D / module.exports
//
// The models have ONE joint per hand and no finger joints, so until V5 his fingers could not be shown at all (a fist was
// a squashed hand). This file gives each hero a pair of articulated hands built in code:
//   - at load the model's own hand triangles are folded away (the index buffer keeps its length: every removed triangle
//     becomes a degenerate one, and the original indices are kept so `setEnabled(false)` puts them back);
//   - a palm and five fingers (two joints each, the thumb too) are attached to each Hand joint, sized from the removed
//     vertices and a little oversized so a pose reads at phone size;
//   - every frame the finger curls follow perf.hands.{l,r}.curl through springs, and a pose the tracker recognises
//     ('open' | 'fist' | 'point' | 'peace' | 'thumb') SNAPS to an authored finger pose, with evidence on two samples,
//     hysteresis and a minimum hold, so it never flickers. No hand in the picture = a relaxed half-curl.
//   - a wave (an open raised hand going side to side) is detected and reported in `debug` (the arm IK shows the motion).
//
//   const h3 = VTHands3D.create(scene, hero, opts?);      hero.body (js/body.js) must exist: it knows which joint is
//                                                         which hand and the hand's own axes
//   every frame, AFTER hero.body.update(...):  h3.update(perf, tMs, dtMs);
//   h3.setEnabled(false)   the model's own hands again (avatar.html?hands3d=0 never creates this module at all)
//   h3.debug               { l: { pose, wave, curl: [5], present }, r: ..., costMs, costAvg, snaps: { pose: count }, waves }
//
// "l" / "r" = the left / right side of the PICTURE, as everywhere in `perf` (perf.hands.l drives the hero's RIGHT hand).
// The pure logic (PoseSnap, WaveDetector, fingerTargets) needs no DOM and no Babylon: VTHands3D.logic, used by the tests.
(function (global) {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const fin = (v) => typeof v === 'number' && isFinite(v);
  const RAD = Math.PI / 180;

  // ------------------------------------------------------------------ logic (pure)
  /**
   * The authored finger poses. curl: [thumb, index, middle, ring, pinky], 0 = straight .. 1 = folded into the palm.
   * spread: how far the fingers fan out (-0.3 = pressed together .. 1 = wide). vee: index and middle apart (peace).
   * thumbOut: 0 = the thumb lies along the palm's edge, 1 = it stands straight out to the side (thumbs-up).
   */
  const POSES = {
    open: { curl: [0, 0, 0, 0, 0], spread: 1, vee: 0, thumbOut: 0.55 },
    fist: { curl: [1, 1, 1, 1, 1], spread: -0.2, vee: 0, thumbOut: 0 },
    point: { curl: [1, 0, 1, 1, 1], spread: -0.2, vee: 0, thumbOut: 0 },
    peace: { curl: [1, 0, 0, 1, 1], spread: 0, vee: 1, thumbOut: 0 },
    thumb: { curl: [0, 1, 1, 1, 1], spread: -0.2, vee: 0, thumbOut: 1 },
  };
  const RELAXED = { curl: [0.35, 0.3, 0.38, 0.45, 0.5], spread: -0.1, vee: 0, thumbOut: 0.1 };
  // round 5: a relaxed hand per hero. Ryo's black gloves read as claws with the fingers apart and half curled: his rest is
  // fingers together, gently graded, the thumb resting along the index. Melanie's small skin hand keeps a softer curl.
  const REST = {
    ryo: { curl: [0.20, 0.14, 0.18, 0.24, 0.30], spread: -0.28, vee: 0, thumbOut: 0.04 },
    melanie: { curl: [0.26, 0.20, 0.26, 0.32, 0.38], spread: -0.18, vee: 0, thumbOut: 0.08 },
  };
  // enterBy: the rare poses need one sample more (a false PEACE showed for one sample with both hands on the chest).
  // exitGaps: at a slow body-check rate (4 a second) a held pose must not run out between two samples: the exit time is
  // never under exitGaps sample intervals (round 5; was a fixed 240 ms).
  const SNAP = { enterSamples: 2, enterBy: { peace: 3, thumb: 3 }, enterMs: 30, holdMs: 320, exitMs: 240, exitGaps: 2.4, exitMaxMs: 900, popMs: 160, pop: 0.16 };

  /**
   * One per hand. push(label, tMs) once per NEW tracker sample (label = perf.hands.x.pose or null; with no hand call
   * push(null, tMs)); get(tMs) every frame -> { pose, since, pop } (pop = the extra scale of the snap, 0.. SNAP.pop).
   *   enter: the same label on `enterSamples` samples running, at least `enterMs` apart from the first one
   *   hold:  a snapped pose stays at least `holdMs`, whatever arrives
   *   exit:  after that it ends when its label has not been seen for `exitMs` (a single odd sample changes nothing);
   *          another label takes over directly once it has its own enter evidence
   */
  class PoseSnap {
    constructor(o) { this.o = Object.assign({}, SNAP, o || {}); this.pose = null; this.since = -1e9; this.seen = -1e9; this.cand = null; this.candN = 0; this.candAt = 0; this.count = {}; this.gap = 0; this.lastSample = null; }
    /** fresh = false: not a new tracker sample (the page saying "still nothing" every frame): the sample interval is not measured from it */
    push(label, t, fresh) {
      const o = this.o;
      if (fresh !== false) { if (this.lastSample != null && t > this.lastSample) { const g = Math.min(1000, t - this.lastSample); this.gap = this.gap ? this.gap + (g - this.gap) * 0.3 : g; } this.lastSample = t; }
      label = label && POSES[label] ? label : null;
      if (label && label === this.pose) { this.seen = t; this.cand = null; this.candN = 0; return; }
      if (!label) { this.cand = null; this.candN = 0; return; }
      if (label === this.cand) this.candN++; else { this.cand = label; this.candN = 1; this.candAt = t; }
      if (this.candN >= ((o.enterBy && o.enterBy[label]) || o.enterSamples) && t - this.candAt >= o.enterMs && (!this.pose || t - this.since >= o.holdMs)) {
        this.pose = label; this.since = t; this.seen = t; this.cand = null; this.candN = 0;
        this.count[label] = (this.count[label] || 0) + 1;
      }
    }
    get(t) {
      const o = this.o;
      const exit = Math.min(o.exitMaxMs || 900, Math.max(o.exitMs, (o.exitGaps || 0) * this.gap));
      if (this.pose && t - this.seen > exit && t - this.since >= o.holdMs) this.pose = null;
      const u = this.pose ? (t - this.since) / o.popMs : 1;
      return { pose: this.pose, since: this.since, pop: u >= 0 && u < 1 ? o.pop * (1 - u) * (1 - u) : 0 };
    }
    reset() { this.pose = null; this.cand = null; this.candN = 0; this.since = -1e9; this.seen = -1e9; }
  }

  const WAVE = { minSwing: 0.1, windowMs: 1300, holdMs: 700, minY: -0.25, minOpen: 0.45 };
  /**
   * A wave = an open raised hand whose wrist goes side to side: 2 or more changes of direction inside `windowMs`, each
   * after a swing of at least `minSwing` shoulder widths. push(x, tMs, eligible) per new sample; `waving` after it.
   */
  class WaveDetector {
    constructor(o) { this.o = Object.assign({}, WAVE, o || {}); this.reset(); this.count = 0; }
    reset() { this.dir = 0; this.ext = null; this.turns = []; this.waving = false; this.lastTurn = -1e9; }
    push(x, t, eligible) {
      const o = this.o;
      if (!eligible || !fin(x)) { this.reset(); return false; }
      if (this.ext == null) { this.ext = x; return false; }
      if (this.dir === 0) { if (Math.abs(x - this.ext) >= o.minSwing) { this.dir = x > this.ext ? 1 : -1; this.ext = x; } }
      else if ((x - this.ext) * this.dir > 0) this.ext = x;                    // still going the same way: a new extreme
      else if ((this.ext - x) * this.dir >= o.minSwing) { this.dir = -this.dir; this.ext = x; this.turns.push(t); this.lastTurn = t; }
      while (this.turns.length && t - this.turns[0] > o.windowMs) this.turns.shift();
      const was = this.waving;
      this.waving = this.turns.length >= 2 || (was && t - this.lastTurn <= o.holdMs);
      if (this.waving && !was) this.count++;
      return this.waving;
    }
  }

  /** His measured curl (0..1 per finger) as the drawn curl: a small dead zone, then a little more than he does. */
  const liveCurl = (c) => { const x = clamp((Number(c) || 0) - 0.06, 0, 1) / 0.8; return clamp(x, 0, 1); };
  /**
   * What the fingers should aim at. hand = perf.hands.x or null; pose = the snapped pose or null.
   * -> { curl: [5], spread, vee, thumbOut } (a new object).
   */
  function fingerTargets(hand, pose, rest, out) {
    const o = out || { curl: [0, 0, 0, 0, 0], spread: 0, vee: 0, thumbOut: 0 }, c = o.curl;
    const from = pose && POSES[pose] ? POSES[pose] : (!hand || !Array.isArray(hand.curl) || hand.curl.length < 5) ? (rest || RELAXED) : null;
    if (from) { for (let i = 0; i < 5; i++) c[i] = from.curl[i]; o.spread = from.spread; o.vee = from.vee || 0; o.thumbOut = from.thumbOut; return o; }
    for (let i = 0; i < 5; i++) c[i] = liveCurl(hand.curl[i]);
    const four = (c[1] + c[2] + c[3] + c[4]) / 4;
    const open = fin(hand.open) ? clamp(hand.open, 0, 1) : 1 - four;
    o.spread = lerp(-0.2, 0.9, clamp(open * (1 - four), 0, 1)); o.vee = 0; o.thumbOut = clamp(0.6 * (1 - c[0]) * (0.4 + 0.6 * four), 0, 1);
    return o;
  }
  /** critically damped-ish spring step (state { x, v }) */
  function spring(s, goal, omega, zeta, dt) {
    const n = Math.max(1, Math.ceil(dt * omega / 0.5)), h = dt / n;
    for (let i = 0; i < n; i++) { s.v += (omega * omega * (goal - s.x) - 2 * zeta * omega * s.v) * h; s.x += s.v * h; }
    return s.x;
  }

  // ------------------------------------------------------------------ the drawn hands (Babylon)
  const LOOK = {
    // albedo colours (gamma space, as the eye sees them on the model under the page's lights)
    ryo: { skin: [0.98, 0.80, 0.68], palm: [0.07, 0.07, 0.08], plate: [0.46, 0.46, 0.48], glove: true, size: 1.12 },
    melanie: { skin: [0.94, 0.73, 0.62], palm: null, plate: null, glove: false, size: 1.75 },
  };
  const DEFAULTS = { curlOmega: 30, curlZeta: 0.85, relaxOmega: 9, removeAt: 0.5 };

  function create(scene, hero, opts) {
    const B = global.BABYLON, body = hero && hero.body;
    if (!B || !body || !body.hands) throw new Error('hands3d: needs Babylon and hero.body.hands');
    const P = Object.assign({}, DEFAULTS, opts || {});
    const look = LOOK[hero.id] || LOOK.ryo, rest = REST[hero.id] || RELAXED;
    const meshes = hero.root.getChildMeshes(false).filter((m) => m.skeleton && m.getTotalVertices() > 0);
    const sk = meshes.length ? meshes[0].skeleton : null;
    if (!sk) throw new Error('hands3d: no skinned mesh');
    const V3 = B.Vector3;
    const debug = { l: null, r: null, costMs: 0, costAvg: 0, snaps: {}, waves: 0, removed: 0, enabled: true };

    // ---- the model's own hands: which triangles, and how large the hand is in its joint's own frame
    const sides = {};
    for (const s of ['l', 'r']) {
      const bh = body.hands[s];
      const bone = sk.bones.find((b) => b.name === bh.node.name);
      if (!bone) throw new Error('hands3d: no bone ' + bh.node.name);
      sides[s] = { s, node: bh.node, bone: sk.bones.indexOf(bone), inv: (bone.getAbsoluteInverseBindMatrix ? bone.getAbsoluteInverseBindMatrix() : bone.getInvertedAbsoluteTransform()).clone(),
        f: new V3(bh.fLocal[0], bh.fLocal[1], bh.fLocal[2]).normalize(), n: new V3(bh.nLocal[0], bh.nLocal[1], bh.nLocal[2]), out: bh.out, pts: [] };
      const S = sides[s];
      S.n = S.n.subtract(S.f.scale(V3.Dot(S.n, S.f))).normalize();
      S.x = V3.Cross(S.f, S.n).normalize();          // (x, f, n) is a right-handed frame; the thumb is on the -out side of x
      S.thumb = -S.out;
    }
    const saved = [];
    for (const mesh of meshes) {
      const pos = mesh.getVerticesData(B.VertexBuffer.PositionKind), mi = mesh.getVerticesData(B.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData(B.VertexBuffer.MatricesWeightsKind), idx = mesh.getIndices();
      if (!pos || !mi || !mw || !idx) continue;
      const nv = pos.length / 3, w = { l: new Float32Array(nv), r: new Float32Array(nv) };
      for (let v = 0; v < nv; v++) for (let c = 0; c < 4; c++) { const j = mi[v * 4 + c], x = mw[v * 4 + c]; if (!x) continue; if (j === sides.l.bone) w.l[v] += x; else if (j === sides.r.bone) w.r[v] += x; }
      const next = Array.from(idx);
      let cut = 0;
      const tmp = new V3();
      for (let i = 0; i + 2 < idx.length; i += 3) {
        for (const s of ['l', 'r']) {
          const a = idx[i], b = idx[i + 1], c = idx[i + 2];
          if ((w[s][a] + w[s][b] + w[s][c]) / 3 >= P.removeAt) { next[i + 1] = a; next[i + 2] = a; cut++; }
        }
      }
      for (const s of ['l', 'r']) for (let v = 0; v < nv; v++) if (w[s][v] >= 0.6) { V3.TransformCoordinatesFromFloatsToRef(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], sides[s].inv, tmp); sides[s].pts.push([V3.Dot(tmp, sides[s].x), V3.Dot(tmp, sides[s].f), V3.Dot(tmp, sides[s].n)]); }
      if (cut) { saved.push({ mesh, original: Array.from(idx), cut: next }); debug.removed += cut; }
    }
    const applyIndices = (on) => { for (const m of saved) m.mesh.updateIndices(on ? m.cut : m.original); };

    // ---- materials: matt, lit like the model (no plastic highlight)
    const mat = (name, c) => {
      const m = new B.PBRMaterial('h3-' + hero.id + '-' + name, scene);
      m.albedoColor = new B.Color3(c[0], c[1], c[2]).toLinearSpace(); m.metallic = 0; m.roughness = 1; m.backFaceCulling = false;
      m.specularIntensity = 0; m.environmentIntensity = 0.6; m.directIntensity = 1;
      const src = meshes[0].material;
      if (src) { for (const k of ['environmentIntensity', 'directIntensity', 'unlit']) if (src[k] !== undefined) m[k] = src[k]; }
      return m;
    };
    const mSkin = mat('skin', look.skin), mPalm = look.palm ? mat('palm', look.palm) : mSkin, mPlate = look.plate ? mat('plate', look.plate) : null;

    // ---- one hand
    function build(S) {
      const pct = (ax, q) => { const a = S.pts.map((p) => p[ax]).sort((x, y) => x - y); return a.length ? a[Math.round((a.length - 1) * q)] : 0; };
      // size from the model's own hand (joint-local units); a fallback from the forearm when the hand could not be read
      let len = pct(1, 0.98), wid = pct(0, 0.95) - pct(0, 0.05), thick = pct(2, 0.92) - pct(2, 0.08);
      if (!(len > 1e-6)) { len = 1; wid = 0.6; thick = 0.3; }
      wid = clamp(wid, 0.5 * len, 0.85 * len); thick = clamp(thick, 0.22 * len, 0.4 * len);
      const k = look.size, L = len * k, W = wid * k, T = thick * k;
      const palmLen = 0.52 * L, fingerLen = 0.5 * L, r = 0.118 * W;
      const root = new B.TransformNode('h3-' + hero.id + '-' + S.s, scene);
      root.parent = S.node;
      root.rotationQuaternion = B.Quaternion.RotationQuaternionFromAxis(S.x, S.f, S.n);
      // the model's wrist sits a little inside the cuff: start the palm just before the joint so no gap shows
      const palmNode = new B.TransformNode('h3p', scene); palmNode.parent = root;
      const palm = B.MeshBuilder.CreateSphere('h3-palm', { diameter: 1, segments: 10 }, scene);
      palm.parent = palmNode; palm.scaling.set(W * 1.02, palmLen * 1.22, T * 1.05); palm.position.set(0, palmLen * 0.48, 0); palm.material = mPalm;
      const parts = [palm];
      if (mPlate) {
        const plate = B.MeshBuilder.CreateBox('h3-plate', { size: 1 }, scene);
        plate.parent = palmNode; plate.scaling.set(W * 0.5, palmLen * 0.42, T * 0.2); plate.position.set(0, palmLen * 0.5, -T * 0.5); plate.material = mPlate; parts.push(plate);
      }
      const seg = (parent, length, radius, material) => {
        const m = B.MeshBuilder.CreateCapsule('h3-seg', { height: length + 2 * radius, radius, tessellation: 8, subdivisions: 1, capSubdivisions: 4 }, scene);
        m.parent = parent; m.position.set(0, length / 2, 0); m.material = material; parts.push(m); return m;
      };
      const fingers = [];
      // index .. pinky: across the palm from the thumb side
      const X = [0.36, 0.12, -0.12, -0.36], LEN = [0.92, 1.0, 0.93, 0.76], Y0 = [0.93, 1.0, 0.96, 0.86];
      for (let i = 0; i < 4; i++) {
        const base = new B.TransformNode('h3-f' + i, scene); base.parent = root; base.position.set(S.thumb * X[i] * W, palmLen * Y0[i], 0);
        const l1 = fingerLen * LEN[i] * 0.55, l2 = fingerLen * LEN[i] * 0.45;
        seg(base, l1, r, mSkin);
        const mid = new B.TransformNode('h3-f' + i + 'b', scene); mid.parent = base; mid.position.set(0, l1, 0);
        seg(mid, l2, r * 0.94, mSkin);
        base.rotationQuaternion = new B.Quaternion(); mid.rotationQuaternion = new B.Quaternion();
        fingers.push({ base, mid, fan: X[i] / 0.36 });
      }
      // thumb: from the palm's edge
      const tb = new B.TransformNode('h3-t', scene); tb.parent = root; tb.position.set(S.thumb * 0.46 * W, palmLen * 0.34, T * 0.12);
      const t1 = fingerLen * 0.5, t2 = fingerLen * 0.42;
      seg(tb, t1, r * 1.12, mSkin);
      const tm = new B.TransformNode('h3-tb', scene); tm.parent = tb; tm.position.set(0, t1, 0);
      seg(tm, t2, r * 1.05, mSkin);
      tb.rotationQuaternion = new B.Quaternion(); tm.rotationQuaternion = new B.Quaternion();
      for (const m of parts) { m.isPickable = false; m.alwaysSelectAsActiveMesh = true; }
      return { root, parts, fingers, thumb: { base: tb, mid: tm } };
    }
    const AX = new V3(1, 0, 0), AY = new V3(0, 1, 0), AZ = new V3(0, 0, 1);
    const q1 = new B.Quaternion(), q2 = new B.Quaternion(), q3 = new B.Quaternion();
    /** lay the finger joints of one hand: c = [5] curls, spread, vee, thumbOut */
    function pose(S, c, spread, vee, thumbOut) {
      const H = S.hand, sg = S.thumb;
      for (let i = 0; i < 4; i++) {
        const f = H.fingers[i], k = clamp(c[i + 1], -0.1, 1.05);
        // fan (about the palm normal): spread opens the fingers, vee parts index and middle only; a curled finger does not fan
        let fan = f.fan * spread * 9 * (1 - 0.8 * clamp(k, 0, 1));
        if (vee > 0) fan += (i === 0 ? 13 : i === 1 ? -11 : 0) * vee * (1 - clamp(k, 0, 1));
        B.Quaternion.RotationAxisToRef(AX, k * 86 * RAD, q1);          // a positive turn about x folds toward the palm (+z): checked with probe()
        B.Quaternion.RotationAxisToRef(AZ, -sg * fan * RAD, q2);
        q2.multiplyToRef(q1, f.base.rotationQuaternion);
        B.Quaternion.RotationAxisToRef(AX, k * 100 * RAD, f.mid.rotationQuaternion);
      }
      // thumb: at rest it leans away from the palm's edge; curled it folds across the palm; out = straight to the side
      const k = clamp(c[0], 0, 1), o = clamp(thumbOut, 0, 1);
      const side = lerp(lerp(34, 78, o), -8, k);            // degrees away from the fingers' direction, toward the thumb side
      const fold = lerp(lerp(14, 0, o), 58, k);             // degrees toward the palm
      B.Quaternion.RotationAxisToRef(AZ, -sg * side * RAD, q1);
      B.Quaternion.RotationAxisToRef(AX, fold * RAD, q2);
      B.Quaternion.RotationAxisToRef(AY, -sg * 40 * k * RAD, q3);
      q1.multiplyToRef(q2, q2); q2.multiplyToRef(q3, H.thumb.base.rotationQuaternion);
      B.Quaternion.RotationAxisToRef(AZ, sg * lerp(8, 62, k) * RAD, H.thumb.mid.rotationQuaternion);
    }

    for (const s of ['l', 'r']) {
      const S = sides[s];
      S.hand = build(S);
      S.snap = new PoseSnap(); S.wave = new WaveDetector();
      S.curl = rest.curl.map((x) => ({ x, v: 0 })); S.spread = { x: rest.spread, v: 0 }; S.vee = { x: 0, v: 0 }; S.thumbOut = { x: rest.thumbOut, v: 0 };
      S.lastKey = null; S.last = null; S.seenAt = -1e9; S.goal = { curl: [0, 0, 0, 0, 0], spread: 0, vee: 0, thumbOut: 0 }; S.now = [0, 0, 0, 0, 0];
      pose(S, rest.curl, rest.spread, 0, rest.thumbOut);
      debug[s] = { pose: null, wave: false, curl: rest.curl.slice(), present: false };
    }
    applyIndices(true);

    // body.js stood in for a fist by squashing the whole hand: with real fingers that must not happen
    const bp = body.params || {}, bodySaved = { fistSquash: bp.fistSquash, fistBulge: bp.fistBulge, openStretch: bp.openStretch };
    const squash = (on) => { if (on) { bp.fistSquash = bodySaved.fistSquash; bp.fistBulge = bodySaved.fistBulge; bp.openStretch = bodySaved.openStretch; } else { bp.fistSquash = 0; bp.fistBulge = 0; bp.openStretch = 0; } };
    squash(false);
    let enabled = true, frames = 0;
    function setEnabled(on) {
      on = !!on;
      if (on === enabled) return;
      enabled = on; debug.enabled = on;
      applyIndices(on); squash(!on);
      for (const s of ['l', 'r']) sides[s].hand.root.setEnabled(on);
    }
    const stale = 450;
    function update(perf, tMs, dtMs) {
      if (!enabled) return;
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const dt = clamp((Number(dtMs) || 0) / 1000, 0, 0.1);
      const ph = perf && perf.hands ? perf.hands : null, pb = perf && perf.body ? perf.body : null;
      // which tracker sample this is, as a number (no string is built 60 times a second)
      const key = perf ? (ph && fin(ph.at) ? ph.at * 4 : pb && fin(pb.at) ? pb.at * 4 + 1 : (Number(perf.at) || 0) * 4 + 2 + (Number(perf.seq) || 0) % 2) : null;
      for (const s of ['l', 'r']) {
        const S = sides[s], h = ph && ph[s] && typeof ph[s] === 'object' ? ph[s] : null;
        if (key !== null && key !== S.lastKey) {
          S.lastKey = key;
          // the hand model was not run for this sample (hands with no `at` beside a fresh body): no news
          S.snap.push(h ? h.pose : null, tMs);
          const arm = pb && pb.arms ? pb.arms[s] : null;
          const open = h ? (fin(h.open) ? h.open : h.pose === 'open' ? 1 : 0) : 0;
          S.wave.push(arm && Array.isArray(arm.wrist) ? arm.wrist[0] : NaN, tMs, !!(h && arm && Array.isArray(arm.wrist) && arm.wrist[1] > S.wave.o.minY && open >= S.wave.o.minOpen));
          S.last = h; if (h) S.seenAt = tMs;
        }
        const live = S.last && tMs - S.seenAt < stale && perf ? S.last : null;
        if (!live && tMs - S.seenAt >= stale) { S.snap.push(null, tMs, false); if (S.wave.waving) S.wave.reset(); }
        const st = S.snap.get(tMs);
        // fix round B1: no hand of his, and the body is making a talk gesture with this arm: its fingers (open palm, point)
        const gp = !live && !st.pose && hero.body && hero.body.gesture ? hero.body.gesture[s] : null;
        const goal = fingerTargets(live, st.pose || (gp && gp.w > 0.35 ? gp.pose : null), rest, S.goal);
        const om = live || st.pose ? P.curlOmega : P.relaxOmega;
        for (let i = 0; i < 5; i++) spring(S.curl[i], goal.curl[i], om, P.curlZeta, dt);
        spring(S.spread, goal.spread, om, P.curlZeta, dt); spring(S.vee, goal.vee, om, P.curlZeta, dt); spring(S.thumbOut, goal.thumbOut, om, P.curlZeta, dt);
        for (let i = 0; i < 5; i++) S.now[i] = S.curl[i].x;
        pose(S, S.now, S.spread.x, S.vee.x, S.thumbOut.x);
        const sc = 1 + st.pop;
        S.hand.root.scaling.set(sc, sc, sc);
        const d = debug[s];
        d.pose = st.pose; d.wave = S.wave.waving; d.present = !!live; for (let i = 0; i < 5; i++) d.curl[i] = S.curl[i].x;
      }
      debug.snaps.l = sides.l.snap.count; debug.snaps.r = sides.r.snap.count;
      debug.waves = sides.l.wave.count + sides.r.wave.count;
      if (t0) { debug.costMs = performance.now() - t0; frames++; debug.costAvg += (debug.costMs - debug.costAvg) / Math.min(frames, 300); }
    }
    function dispose() {
      setEnabled(false);
      for (const s of ['l', 'r']) { for (const m of sides[s].hand.parts) m.dispose(); sides[s].hand.root.dispose(); }
    }
    /** for the tools: where the palm faces and where the index finger's tip is against the palm, in world space */
    function probe(s) {
      const S = sides[s], H = S.hand;
      H.root.computeWorldMatrix(true);
      const m = H.root.getWorldMatrix(), nrm = V3.TransformNormal(AZ, m).normalize(), up = V3.TransformNormal(AY, m).normalize();
      const f = H.fingers[0]; f.base.computeWorldMatrix(true); f.mid.computeWorldMatrix(true);
      const tip = V3.TransformCoordinates(new V3(0, 1, 0).scale(f.mid.getChildMeshes()[0].position.y * 2), f.mid.getWorldMatrix());
      const d = tip.subtract(f.base.getAbsolutePosition()).normalize();
      return { palm: [nrm.x, nrm.y, nrm.z], fingers: [up.x, up.y, up.z], tipTowardPalm: V3.Dot(d, nrm), tipAlongFingers: V3.Dot(d, up) };
    }
    return { update, setEnabled, dispose, debug, params: P, sides, probe };
  }

  const api = { create, POSES, RELAXED, REST, SNAP, WAVE, LOOK, logic: { PoseSnap, WaveDetector, fingerTargets, liveCurl, spring, POSES, RELAXED, SNAP, WAVE } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.VTHands3D = api;
})(typeof window !== 'undefined' ? window : globalThis);
