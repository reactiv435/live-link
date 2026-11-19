// js/body.js  (BODY agent, VTuber v2)  ->  window.VTBody
//
// Everything below the neck: torso (lean, twist, shoulder tilt, shrug), arms (two-bone IK toward his hands), hands
// (turned with his palm and finger direction; a small squash stands in for "fist" because the models have no finger
// joints), tails (springs that swing and lag behind the body) and the idle life of the body (breathing, weight settle,
// a small bounce when he talks loudly).
//
//   const body = VTBody.create(scene, hero, opts?);
//   every frame, AFTER the idle clip has posed the skeleton and BEFORE the face side turns the head:
//     body.update(perf, tMs, dtMs, ctx);
//   perf = the newest `perf` message (protocol v2, V2-PLAN.md) or null. The same object may be passed again every frame:
//          a new body sample is recognised by `body.at` / `hands.at` (the tracker's own capture time of the body
//          result, which it repeats under several face frames), else by `seq` / `at`.
//   tMs  = the page clock in ms (performance.now(), or a stepped clock in a capture).  dtMs = time since the last frame.
//   ctx  = { head: { yaw, pitch, roll } in degrees (what the face side decided, same signs as perf.face.rot), talk: 0..1,
//            shift: { x, y, z } the offset the face side gives the whole avatar (the holder), in scene units }   all optional.
//   hero needs only `root` (the model's top node: the loader's __root__) and optionally `id`.
//
// Coordinates. `perf` uses +x = picture right, +y = up, +z = toward the camera, in shoulder widths. The heroes are glTF
// models that face the viewer, so glTF model space (the space of the children of hero.root) has the same three axes:
// +x = screen right (the hero's own LEFT), +y up, +z toward the viewer. All the maths here is done in that space with
// plain arrays; the Babylon nodes are only read (position / rotationQuaternion / scaling) and written (rotation, and
// position for hips and shoulders). "l" / "r" always mean SCREEN left / right: perf.body.arms.l drives the hero's RIGHT arm.
//
// The module never keeps a change from one frame to the next inside the skeleton: each frame it starts from the pose it
// finds (the idle clip). If the caller does not re-pose the skeleton every frame, the previous frame's base pose is reused.
(function (global) {
  'use strict';
  const RAD = Math.PI / 180, TAU = Math.PI * 2;
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ------------------------------------------------------------------ small maths (arrays; Hamilton quaternions [x,y,z,w])
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a, fb) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : (fb || [0, 1, 0]); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const fin = (v) => typeof v === 'number' && isFinite(v);
  const vec3ok = (v) => Array.isArray(v) && v.length >= 3 && fin(v[0]) && fin(v[1]) && fin(v[2]);
  const QI = [0, 0, 0, 1];
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]); return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]; };
  const qrot = (q, v) => {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  };
  const qaxis = (axis, ang) => { const s = Math.sin(ang / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)]; };
  /** Shortest turn that takes unit vector a onto unit vector b. */
  const qfromto = (a, b) => {
    const d = dot(a, b);
    if (d > 0.999999) return [0, 0, 0, 1];
    if (d < -0.999999) { let ax = cross([1, 0, 0], a); if (len(ax) < 1e-4) ax = cross([0, 1, 0], a); return qaxis(norm(ax), Math.PI); }
    const c = cross(a, b);
    return qnorm([c[0], c[1], c[2], 1 + d]);
  };
  const qslerp = (a, b, t) => {
    if (t <= 0) return a; if (t >= 1) return b;
    let c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
    if (c < 0) { c = -c; s = -1; }
    if (c > 0.9995) return qnorm([lerp(a[0], s * b[0], t), lerp(a[1], s * b[1], t), lerp(a[2], s * b[2], t), lerp(a[3], s * b[3], t)]);
    const th = Math.acos(c), k0 = Math.sin((1 - t) * th) / Math.sin(th), k1 = s * Math.sin(t * th) / Math.sin(th);
    return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
  };
  /** Rotation whose matrix has the unit columns x, y, z (so it takes e_x to x, e_y to y, e_z to z). */
  const qbasis = (x, y, z) => {
    const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
    return qnorm(q);
  };
  /** One step of a damped spring (implicit, stable for any dt). s = { x, v }. zeta 1 = no overshoot. */
  const spring = (s, target, omega, zeta, dt) => {
    if (!(dt > 0)) return s.x;
    const f = 1 + 2 * dt * zeta * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo, inv = 1 / (f + hhoo);
    const x = (f * s.x + dt * s.v + hhoo * target) * inv, v = (s.v + hoo * (target - s.x)) * inv;
    s.x = x; s.v = v;
    return x;
  };
  const spring3 = (s, target, omega, zeta, dt) => { for (let k = 0; k < 3; k++) { s.k.x = s.x[k]; s.k.v = s.v[k]; spring(s.k, target[k], omega, zeta, dt); s.x[k] = s.k.x; s.v[k] = s.k.v; } return s.x; };
  const newSpring3 = (x) => ({ x: [x[0], x[1], x[2]], v: [0, 0, 0], k: { x: 0, v: 0 } });
  /** limit * tanh(x / limit): a soft stop. */
  const soft = (x, limit) => limit * Math.tanh(x / limit);
  /** A small repeatable random source (so captures are the same every run). */
  const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

  // ------------------------------------------------------------------ tuning (all in one place; body.params is live)
  const DEFAULTS = {
    // --- timing
    lead: 0.5,            // 0 = pure interpolation (one tracking interval behind); 0.5 = half interpolation, half prediction
    staleMs: 450,         // no new perf for this long = the tracker is gone: everything eases to idle
    // --- arms
    humanReach: 1.5,      // his shoulder-to-wrist length in shoulder widths (a straight arm)
    armGain: [1.0, 1.25, 1.15],   // sideways (per shoulder width), up / down and toward the camera (per share of reach)
    armLift: 0.18,        // the whole gesture space sits this share of the arm length higher, so chest-height talk reads at the chest
    armOmega: 42, armZeta: 0.82,  // spring that carries the hand to its target (rad/s; 0.82 = a trace of overshoot)
    armAheadMs: 30,       // the spring aims this far ahead along the hand's motion (cancels most of the spring's own lag)
    holdMs: 200,          // a lost arm keeps its last pose this long (bridges the hand model's short drop-outs)...
    holdChecks: 1.4, holdMaxMs: 500,   // ...or this many body checks, when those come slower than 7 a second (a busy PC checks the body 4 to
                          // 5 times a second: one missed check there is 250 ms, and must be bridged like one missed frame at full rate)
    fadeOutMs: 400,       // then eases to the idle pose over this long (V5: was 480; his hands gone = arms down in about half a second)
    // --- B4 (fix round): a raised hand. From his shoulder line up, the height of the middle of his hand is read against
    //     his HEAD (0 = shoulder line, 1 = the middle of his head) and carried to the same share between the avatar's
    //     shoulder and the middle of ITS head. A chibi arm is short and the head huge: the plain gains left a fist
    //     held beside his chin at the avatar's chest. A hand held toward the camera shows higher in his picture than
    //     its true height, so some of the forward reach counts as height (judged on frames of his footage).
    raise: [-0.05, 0.3],  // the middle of his hand, in shoulder widths over his shoulder line: no effect below, full above
    raiseGain: 1.0, raiseFromDepth: 0.4, raiseMax: 1.45,
    // --- B1 (fix round): talk gestures. While he speaks and no hand of his is in the picture, the arms make small, varied
    //     moves in front of the body (never a loop: every phrase is drawn afresh). Real hands take over the moment they
    //     are seen, through the same spring; gestures come back gestAfterHandMs after they leave. gestures:false = off.
    gestures: true,
    gestOnMs: 320, gestOffMs: 900,        // speaking this long starts them; this long without speech ends them
    gestAfterHandMs: 1100,                // no gestures this long after a real hand or arm was seen
    gestOmega: 7.5, gestZeta: 1.0,        // the soft spring that carries a gesturing hand (a tracked hand uses armOmega)
    gestFadeInMs: 260, gestFadeOutMs: 750,
    gestPhrase: [1.3, 3.2],               // seconds one gesture is held
    // round 5 (calmer): after every gesture the arms REST for gestRest seconds, and the next one waits for an emphasis in
    // his voice (gestCue over its own running level; at most gestCueWaitS), so a move lands on a word instead of a timer
    gestRest: [1.8, 4.2], gestCue: 0.10, gestCueWaitS: 1.6,
    gestBeat: 0.075, gestDrift: 0.025,     // shares of the arm's reach: the bob on a syllable, the slow wander
    gestPointEvery: 6000,                 // an emphasis may bring a point at most this often (ms)
    fadeInMs: 140,        // a returning arm eases in over this long (up to 2.5 times longer when the hand has far to travel)
    poleDefault: [0.4, -0.88, -0.25],   // where the elbow points when his elbow is not seen: down, a little out and back (x is mirrored per side)
    poleFromElbow: 0.45,  // how much of his real elbow direction is used when it is seen
    minReach: 0.38,       // the hand never comes closer to the shoulder than this share of the arm length
    maxReach: 0.95,       // the arm never goes dead straight
    // --- the zone around the head (targets expressed in head sizes, so "hand at the cheek" lands at the avatar's cheek)
    headZone: [1.0, 1.8], // full effect inside 1.0 head widths of his head centre, none beyond 1.8
    palmLen: 0.24,        // wrist to the middle of his hand, in shoulder widths
    headGain: [0.95, 0.95],
    // --- colliders (model units are measured from the mesh; these are margins)
    headMargin: 1.08, faceFront: 1.9,   // the head ellipsoid is this much deeper in front of the face, so a hand ends beside the face, not across it
    torsoMargin: 1.12, handRadius: 0.36,  // hand radius as a share of the forearm length
    // --- hands
    handOmega: 28,        // how fast the hand turns toward his palm / finger direction (1/s)
    wristMax: 78,         // degrees between the forearm and the fingers
    fistSquash: 0.52, fistBulge: 0.16,   // a fist: the hand is this much shorter and a little thicker (judged on stills: review/v2-body-fist.jpg)
    openStretch: 0.06,    // a wide open hand: a touch longer
    curlOmega: 26,
    // --- torso
    tiltGain: 1.25, tiltMax: 14,        // shoulder-line roll, degrees
    twistGain: 1.1, twistMax: 26,
    leanRoll: 22, leanShift: 0.16, leanMaxX: 0.45,   // degrees and shoulder widths of sideways lean per shoulder width of his
    leanPitch: 16, leanMaxZ: 0.5,
    torsoOmega: 20, torsoZeta: 0.9,
    headCounter: 0.85,    // share of the torso's turn that the neck takes back, so the head is not a block with the chest
    plant: 0.55,          // share of the face side's whole-avatar slide (ctx.shift) that the hips do NOT follow: the body leans instead of sliding
    plantMax: 7,          // ...up to this many degrees of spine bend
    shrugAngle: 20, shrugLift: 0.1,     // clavicle turn (deg) and rise (shoulder widths) at a full shrug
    shrugOmega: 22,
    // --- idle life
    breathPeriod: 3.9, breathPitch: 1.0, breathLift: 0.014, breathArm: 1.3,
    settleShift: 0.022, settleRoll: 0.9, settleEvery: [6, 12],
    talkLean: 1.2, bounce: 0.045, bounceOmega: 20, bounceZeta: 0.38, bounceAt: 0.5,
    armSway: 1.6,         // idle arms: degrees of slow drift
    armHang: 0.6, armHangMax: 12,   // a resting arm keeps hanging when the chest rolls (a lean, a tilt): it turns back by this share of the
                          // roll, up to this many degrees, instead of swinging out with the shoulders like a coat hanger...
    armHangShrug: 0.7,    // ...and by this share of the turn a raised shoulder gives it (a shoulder goes up, the arm still hangs: while
                          // he drinks, the other shoulder reads as raised and that arm stood out at 50 degrees)
    // --- tails
    tailSwing: [5, 8, 11, 13], tailPeriod: 3.1, tailPhase: 0.7,
    tailOmega: [13, 10, 8, 7], tailZeta: 0.42, tailLag: 55, tailTwist: 0.5, tailMax: 28,
  };

  // ------------------------------------------------------------------ rig discovery
  function findRig(hero) {
    const all = hero.root.getChildTransformNodes(false);
    const by = (re) => all.filter((n) => re.test(n.name));
    const one = (re) => by(re)[0] || null;
    const hips = one(/^hips$/i);
    const arms = {};
    for (const side of ['Left', 'Right']) {
      arms[side] = { shoulder: one(new RegExp('^' + side + 'Shoulder$', 'i')), arm: one(new RegExp('^' + side + 'Arm$', 'i')), fore: one(new RegExp('^' + side + 'ForeArm$', 'i')), hand: one(new RegExp('^' + side + 'Hand$', 'i')) };
      if (!arms[side].arm || !arms[side].fore || !arms[side].hand) throw new Error('VTBody: missing ' + side + ' arm joints');
    }
    // the chest is the joint both arm chains hang from; the spine is the chain from the hips up to it
    const chest = (arms.Left.shoulder || arms.Left.arm).parent;
    const spine = [];
    for (let n = chest; n && n !== hips && n !== hero.root; n = n.parent) spine.unshift(n);
    const head = one(/^head$/i);
    let neck = null;
    for (let n = head && head.parent; n && n !== chest; n = n.parent) neck = n;   // the joint right above the chest on the way to the head
    if (!neck) neck = head;
    const tails = by(/^tail/i);
    const depth = (n) => { let d = 0; for (let p = n.parent; p; p = p.parent) d++; return d; };
    tails.sort((a, b) => depth(a) - depth(b));
    return { hips, spine, chest, neck, head, arms, tails };
  }

  // ------------------------------------------------------------------ the module
  function create(scene, hero, opts) {
    if (!hero || !hero.root) throw new Error('VTBody.create: hero.root is missing');
    const P = Object.assign({}, DEFAULTS, opts || {});
    const rig = findRig(hero);
    const random = rng(hero.id === 'melanie' ? 7411 : 2903);

    // ---- node table, parents first. model space = the space of hero.root's children.
    const N = [];           // { node, par, lp, lq, ls, bp, bq, mp, mq, ms, wq, wp }
    const index = new Map();
    function addNode(node) {
      if (!node || node === hero.root) return -1;
      if (index.has(node)) return index.get(node);
      const par = addNode(node.parent);
      if (!node.rotationQuaternion) node.rotationQuaternion = global.BABYLON.Quaternion.FromEulerAngles(node.rotation.x, node.rotation.y, node.rotation.z);
      const i = N.length;
      N.push({ node, par, lp: [0, 0, 0], lq: [0, 0, 0, 1], ls: 1, bp: [0, 0, 0], bq: [0, 0, 0, 1], mp: [0, 0, 0], mq: [0, 0, 0, 1], ms: 1, wq: null, wp: null });
      index.set(node, i);
      return i;
    }
    const I = { hips: addNode(rig.hips), spine: rig.spine.map(addNode), neck: addNode(rig.neck), head: addNode(rig.head), tails: rig.tails.map(addNode) };
    const chestI = I.spine.length ? I.spine[I.spine.length - 1] : I.hips;
    // screen side from where the arm sits: model -x = screen left
    const A = {};
    function readLocal(n) {
      const nd = n.node, p = nd.position, q = nd.rotationQuaternion, s = nd.scaling;
      n.lp = [p.x, p.y, p.z]; n.lq = [q.x, q.y, q.z, q.w]; n.ls = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
    }
    function fkFrom(start) {
      for (let i = start; i < N.length; i++) {
        const n = N[i];
        if (n.par < 0) { n.mp = n.lp; n.mq = n.lq; n.ms = n.ls; }
        else { const p = N[n.par]; n.mp = add(p.mp, mul(qrot(p.mq, n.lp), p.ms)); n.mq = qmul(p.mq, n.lq); n.ms = p.ms * n.ls; }
      }
    }
    for (const side of ['Left', 'Right']) {
      const a = rig.arms[side];
      const e = { shoulder: a.shoulder ? addNode(a.shoulder) : -1, arm: addNode(a.arm), fore: addNode(a.fore), hand: addNode(a.hand) };
      A[side] = e;
    }
    N.forEach(readLocal); fkFrom(0);
    const sides = {};
    {
      const xl = N[A.Left.arm].mp[0], xr = N[A.Right.arm].mp[0];
      sides.r = xl >= xr ? A.Left : A.Right;     // screen right = larger model x
      sides.l = xl >= xr ? A.Right : A.Left;
      sides.l.out = -1; sides.r.out = 1;
    }

    // ---- measurements from the mesh in its bind pose (mesh space = model space up to a uniform scale)
    const M = measure();
    function measure() {
      const out = { ok: false };
      const meshes = hero.root.getChildMeshes(false).filter((m) => m.skeleton && m.getTotalVertices() > 0);
      const B = global.BABYLON;
      const dist = (i, j) => len(sub(N[i].mp, N[j].mp));
      for (const s of ['l', 'r']) {
        const a = sides[s];
        a.L1 = dist(a.arm, a.fore); a.L2 = dist(a.fore, a.hand); a.reach = a.L1 + a.L2;
        a.fLocal = norm(qrot(qconj(N[a.hand].mq), norm(sub(N[a.hand].mp, N[a.fore].mp))));   // fallback: fingers continue the forearm
        a.nLocal = null; a.handLen = a.L2 * 0.6; a.squashAxis = 0;
      }
      out.sw = dist(sides.l.arm, sides.r.arm);
      out.spineLen = Math.max(1e-3, I.hips >= 0 ? dist(I.hips, I.neck) : out.sw);
      // fallbacks when the mesh cannot be read
      const hp = N[I.head].mp;
      out.head = { c: [hp[0], hp[1] + out.sw * 0.55, hp[2]], r: [out.sw * 0.75, out.sw * 0.7, out.sw * 0.7], q: [0, 0, 0, 1] };
      out.torso = { c: lerp3(N[I.hips].mp, N[chestI].mp, 0.5), r: [out.sw * 0.5, out.sw * 0.75, out.sw * 0.38] };
      if (!meshes.length || !B) return finish(out);
      const sk = meshes[0].skeleton;
      const boneOf = (i) => (i < 0 ? null : sk.bones.find((b) => b.name === N[i].node.name) || null);
      const bind = (i) => {     // { p, q, s } of joint i in mesh space at bind
        const b = boneOf(i);
        if (!b) return null;
        const inv = (b.getAbsoluteInverseBindMatrix ? b.getAbsoluteInverseBindMatrix() : b.getInvertedAbsoluteTransform());
        const m = B.Matrix.Invert(inv).m;
        const X = [m[0], m[1], m[2]], Y = [m[4], m[5], m[6]], Z = [m[8], m[9], m[10]];
        const s = (len(X) + len(Y) + len(Z)) / 3;
        return { p: [m[12], m[13], m[14]], q: qbasis(norm(X), norm(Y), norm(Z)), s, bone: sk.bones.indexOf(b) };
      };
      const bHead = bind(I.head), bHips = bind(I.hips);
      if (!bHead || !bHips) return finish(out);
      const k = N[I.head].ms / bHead.s;       // mesh units -> model units
      // which bones count as "head" (the head and everything under it) and as "torso" (hips + spine, not limbs or tail)
      const under = (b, top) => { for (let p = b; p; p = p.getParent()) if (p === top) return true; return false; };
      const headBone = sk.bones[bHead.bone];
      const isHead = sk.bones.map((b) => under(b, headBone));
      const torsoNames = new Set([N[I.hips].node.name, ...I.spine.map((i) => N[i].node.name)]);
      const isTorso = sk.bones.map((b) => torsoNames.has(b.name));
      const handBone = { l: boneOf(sides.l.hand), r: boneOf(sides.r.hand) };
      const hi = { l: sk.bones.indexOf(handBone.l), r: sk.bones.indexOf(handBone.r) };
      const hv = [], tv = [], handV = { l: [], r: [] };
      for (const mesh of meshes) {
        const pos = mesh.getVerticesData(B.VertexBuffer.PositionKind), mi = mesh.getVerticesData(B.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData(B.VertexBuffer.MatricesWeightsKind);
        if (!pos || !mi || !mw) continue;
        for (let v = 0; v < pos.length / 3; v++) {
          let wh = 0, wt = 0, wl = 0, wr = 0;
          for (let c = 0; c < 4; c++) { const j = mi[v * 4 + c], w = mw[v * 4 + c]; if (!w) continue; if (isHead[j]) wh += w; if (isTorso[j]) wt += w; if (j === hi.l) wl += w; if (j === hi.r) wr += w; }
          const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
          if (wh >= 0.6) hv.push(p); else if (wt >= 0.6) tv.push(p);
          if (wl >= 0.6) handV.l.push(p); else if (wr >= 0.6) handV.r.push(p);
        }
      }
      const pct = (arr, axis, q) => { const a = arr.map((p) => p[axis]).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]; };
      const boxOf = (arr, lo, hi2) => { const c = [], r = []; for (let ax = 0; ax < 3; ax++) { const a = pct(arr, ax, lo), b = pct(arr, ax, hi2); c.push((a + b) / 2); r.push((b - a) / 2); } return { c, r }; };
      // model-space placement of a mesh-space point that rides on joint i (bind) -> the joint's local frame
      const toLocal = (b, p) => mul(qrot(qconj(b.q), sub(p, b.p)), 1 / b.s);
      if (hv.length > 50) {
        const bx = boxOf(hv, 0.03, 0.97);
        out.headBind = { local: toLocal(bHead, bx.c), r: mul(bx.r, k), q: bHead.q };
        out.headBox = { c: mul(bx.c, k), r: mul(bx.r, k) };
      }
      if (tv.length > 50) {
        const bx = boxOf(tv, 0.02, 0.98);
        out.torsoBind = { local: toLocal(bHips, bx.c), r: mul(bx.r, k), q: bHips.q };
      }
      for (const s of ['l', 'r']) {
        const a = sides[s], bH = bind(a.hand), bF = bind(a.fore);
        if (!bH || !bF) continue;
        // finger axis at bind: from the wrist to the far end of the hand's own vertices (else: the forearm continued)
        let f = norm(sub(bH.p, bF.p));
        const vs = handV[s];
        if (vs.length > 20) {
          let far = 0;
          const mean = [0, 0, 0];
          for (const p of vs) { const d = dot(sub(p, bH.p), f); if (d > far) far = d; mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
          const mdir = sub(mul(mean, 1 / vs.length), bH.p);
          if (len(mdir) > 1e-6) f = norm(lerp3(f, norm(mdir), 0.5));
          a.handLen = far * k;
        }
        // palm normal at bind: the thumb points forward (+z) in a T pose with the palms down and in a relaxed arm alike
        let thumb = sub([0, 0, 1], mul(f, f[2]));
        if (len(thumb) < 0.2) thumb = sub([0, 1, 0], mul(f, f[1]));
        thumb = norm(thumb);
        const nrm = norm(mul(cross(f, thumb), a.out));     // out = +1 for the hero's left hand (screen right)
        a.fLocal = norm(qrot(qconj(bH.q), f));
        a.nLocal = norm(qrot(qconj(bH.q), nrm));
        const af = a.fLocal.map(Math.abs);
        a.squashAxis = af[0] > af[1] && af[0] > af[2] ? 0 : af[1] > af[2] ? 1 : 2;
      }
      out.ok = true;
      return finish(out);
    }
    function finish(out) {
      for (const s of ['l', 'r']) {
        const a = sides[s];
        if (!a.nLocal) {     // no bind data: any direction square to the fingers
          let t = cross(a.fLocal, [0, 0, 1]); if (len(t) < 0.2) t = cross(a.fLocal, [0, 1, 0]);
          a.nLocal = norm(t);
        }
      }
      return out;
    }

    // ---- state
    // B1: where a gesturing wrist goes, from the shoulder, in shares of the arm's reach: [outward, up, toward the viewer].
    // All of them keep the hand in front of the body, between the belt and the chest; `pose` = the fingers (js/hands3d.js).
    const GEST = {
      rise: { p: [0.10, -0.60, 0.50], pose: null },       // the forearm lifts a little, relaxed fingers
      open: { p: [0.20, -0.50, 0.52], pose: 'open' },     // an open palm, a little out to the side
      beat: { p: [0.04, -0.36, 0.60], pose: null },       // a small beat in front of the chest
      wide: { p: [0.30, -0.58, 0.46], pose: 'open' },     // both hands apart, low
      point: { p: [0.14, -0.16, 0.72], pose: 'point' },   // on emphasis only
    };
    const gestArm = () => ({ want: false, name: null, p: [0, 0, 0], jit: [0, 0, 0], ph: [0, 0, 0], until: 0, last: null, pointUntil: 0 });
    const armState = () => ({ src: null, gestAt: -1e9, mix: 0, lin: 0, w: 0, seenAt: -1e9, have: false, goal: null, pos: newSpring3([0, 0, 0]), pole: null, handLin: 0, handSeenAt: -1e9, handQ: null, curl: { x: 0, v: 0 }, open: { x: 0, v: 0 }, raw: null, target: null, pushed: 0 });
    let S;
    function resetState() {
      S = {
        buf: { s0: null, s1: null, t0: 0, t1: 0, offset: null, interval: 40, gap: 33, lastKey: null, lastAt: -1e9, lastArrive: -1e9 },
        arm: { l: armState(), r: armState() },
        torso: { w: 0, tilt: { x: 0, v: 0 }, twist: { x: 0, v: 0 }, lx: { x: 0, v: 0 }, lz: { x: 0, v: 0 }, shrug: { l: { x: 0, v: 0 }, r: { x: 0, v: 0 } } },
        life: { settle: { x: 0, v: 0 }, settleGoal: 0, settleNext: 0, bounce: { x: 0, v: 0 }, talkFast: 0, talkSlow: 0, bounceAt: -1e9, t0: null },
        tail: rig.tails.map(() => ({ a: { x: 0, v: 0 }, b: { x: 0, v: 0 }, y: { x: 0, v: 0 } })),
        vel: { p: null, v: [0, 0, 0], twist: 0, twistV: 0 },
        gest: { on: false, speakT: 0, quietT: 1e9, nextAt: 0, pointAt: -1e9, handAt: -1e9, arm: { l: gestArm(), r: gestArm() } },
        frames: 0,
      };
    }
    resetState();
    const gesture = { l: { pose: null, w: 0, name: null }, r: { pose: null, w: 0, name: null }, on: false };   // read by js/hands3d.js and the tools
    const debug = { costMs: 0, costMax: 0, costAvg: 0, arms: { l: null, r: null }, torso: null, interval: 0, offset: 0, pushes: 0, sig: null, measured: M.ok };

    // ---- perf -> a flat sample
    function readArm(a) {
      if (!a || !vec3ok(a.wrist)) return null;
      return { w: [a.wrist[0], a.wrist[1], a.wrist[2]], e: vec3ok(a.elbow) ? [a.elbow[0], a.elbow[1], a.elbow[2]] : null };
    }
    function readHand(h) {
      if (!h || !vec3ok(h.palm) || !vec3ok(h.dir)) return null;
      const c = Array.isArray(h.curl) ? h.curl : null;
      let four = 0;
      if (c && c.length >= 5) four = (c[1] + c[2] + c[3] + c[4]) / 4;
      else if (h.pose === 'fist') four = 1;
      return { palm: norm(h.palm), dir: norm(h.dir), curl: fin(four) ? clamp(four, 0, 1) : 0, pose: h.pose || null };
    }
    function extract(perf) {
      const b = perf.body || null, h = perf.hands || null;
      const out = { body: !!b, tilt: 0, twist: 0, lx: 0, lz: 0, shrug: [0, 0], head: null, arm: { l: null, r: null }, hand: { l: null, r: null } };
      if (b) {
        out.tilt = fin(b.tilt) ? b.tilt : 0; out.twist = fin(b.twist) ? b.twist : 0;
        if (Array.isArray(b.lean)) { out.lx = fin(b.lean[0]) ? b.lean[0] : 0; out.lz = fin(b.lean[1]) ? b.lean[1] : 0; }
        if (Array.isArray(b.shrug)) out.shrug = [fin(b.shrug[0]) ? b.shrug[0] : 0, fin(b.shrug[1]) ? b.shrug[1] : 0];
        if (Array.isArray(b.head) && fin(b.head[0]) && fin(b.head[1]) && b.head[2] > 0.05) out.head = [b.head[0], b.head[1], b.head[2]];
        if (b.arms) { out.arm.l = readArm(b.arms.l); out.arm.r = readArm(b.arms.r); }
      }
      if (h) { out.hand.l = readHand(h.l); out.hand.r = readHand(h.r); }
      return out;
    }
    function ingest(perf, tMs) {
      const b = S.buf;
      if (!perf || typeof perf !== 'object') return;
      // The tracker sends one perf per FACE frame and repeats its newest body result under each, with that result's
      // own capture time in body.at / hands.at. A body sample is new when that time changes, and that time (not the
      // face frame's) places it on the clock. Without it (the lab, older senders) every message is one sample at perf.at.
      const pb = perf.body, ph = perf.hands;
      const own = pb && fin(pb.at) ? pb.at : (ph && fin(ph.at) ? ph.at : null);
      const key = own != null ? 'b' + own : (perf.seq != null ? perf.seq : '') + '|' + perf.at;
      if (key === b.lastKey) { if (own != null) b.lastArrive = tMs; return; }      // the same sample again: the tracker is alive, nothing new
      b.lastKey = key;
      const at = own != null ? own : (fin(perf.at) ? perf.at : tMs);
      if (at <= b.lastAt && at > b.lastAt - 2000) return;       // older than the newest one already in hand
      const lat = tMs - at;
      if (b.offset == null || lat < b.offset || Math.abs(lat - b.offset) > 1500) b.offset = lat; else b.offset += (lat - b.offset) * 0.01;
      const gap = at - b.lastAt;
      if (gap > 0 && gap < 1000) b.gap += (clamp(gap, 8, 600) - b.gap) * 0.3;       // the real time between body samples (not capped like `interval`)
      b.s0 = gap > 0 && gap < 250 ? b.s1 : null; b.t0 = b.t1;
      b.s1 = extract(perf); b.t1 = at + b.offset; b.lastAt = at; b.lastArrive = tMs;
      if (b.s0) b.interval += (clamp(b.t1 - b.t0, 8, 150) - b.interval) * 0.15;
    }
    const mixArm = (a, b, u) => {
      if (!b) return null; if (!a) return b;
      return { w: lerp3(a.w, b.w, u), e: b.e ? (a.e ? lerp3(a.e, b.e, u) : b.e) : null };
    };
    const mixHand = (a, b, u) => {
      if (!b) return null; if (!a) return b;
      const uc = clamp(u, 0, 1.25);
      return { palm: norm(lerp3(a.palm, b.palm, uc), b.palm), dir: norm(lerp3(a.dir, b.dir, uc), b.dir), curl: clamp(lerp(a.curl, b.curl, uc), 0, 1), pose: b.pose };
    };
    function sampleAt(tMs) {
      const b = S.buf;
      if (!b.s1 || tMs - b.lastArrive > P.staleMs) return null;
      if (!b.s0 || !(b.t1 > b.t0)) return b.s1;
      const lag = b.interval * (1 - clamp(P.lead, 0, 0.6));
      const u = clamp((tMs - lag - b.t0) / (b.t1 - b.t0), 0, 1 + clamp(P.lead, 0, 0.6) + 0.1);
      const a = b.s0, c = b.s1, ub = clamp(u, 0, 1.15);
      const out = { body: c.body, tilt: c.tilt, twist: c.twist, lx: c.lx, lz: c.lz, shrug: c.shrug, head: c.head, arm: { l: mixArm(a.arm.l, c.arm.l, u), r: mixArm(a.arm.r, c.arm.r, u) }, hand: { l: mixHand(a.hand.l, c.hand.l, u), r: mixHand(a.hand.r, c.hand.r, u) } };
      if (a.body && c.body) {
        out.tilt = lerp(a.tilt, c.tilt, ub); out.twist = lerp(a.twist, c.twist, ub); out.lx = lerp(a.lx, c.lx, ub); out.lz = lerp(a.lz, c.lz, ub);
        out.shrug = [lerp(a.shrug[0], c.shrug[0], ub), lerp(a.shrug[1], c.shrug[1], ub)];
        if (a.head && c.head) out.head = lerp3(a.head, c.head, ub);
      }
      return out;
    }

    // ---- writing a joint
    /** Turn joint i by the model-space rotation d, on top of its present pose. */
    function turn(i, d) {
      const n = N[i], qp = n.par < 0 ? QI : N[n.par].mq;
      n.lq = qnorm(qmul(qconj(qp), qmul(d, qmul(qp, n.lq))));
    }
    /** Give joint i the model-space orientation q. */
    function orient(i, q) { const n = N[i], qp = n.par < 0 ? QI : N[n.par].mq; n.lq = qnorm(qmul(qconj(qp), q)); }
    /** Move joint i by the model-space offset d. */
    function shift(i, d) {
      const n = N[i];
      if (n.par < 0) { n.lp = add(n.lp, d); return; }
      const p = N[n.par];
      n.lp = add(n.lp, mul(qrot(qconj(p.mq), d), 1 / p.ms));
    }

    // ---- colliders
    function ellipsoid(center, q, r, p, frontStretch) {
      // returns the point pushed out of the ellipsoid (or p itself), and how far it moved
      const loc = qrot(qconj(q), sub(p, center));
      const rz = loc[2] > 0 ? r[2] * frontStretch : r[2];
      let u = [loc[0] / r[0], loc[1] / r[1], loc[2] / rz];
      const l = len(u);
      if (l >= 1) return null;
      if (l < 1e-4) u = [0, 0, 1]; else u = mul(u, 1 / l);
      const outLoc = [u[0] * r[0], u[1] * r[1], u[2] * rz];
      return add(center, qrot(q, outLoc));
    }
    /** The body pushes a hand straight FORWARD (the hand keeps its height and side), never up toward the face. */
    function forward(center, q, r, p) {
      const loc = qrot(qconj(q), sub(p, center));
      const k = 1 - (loc[0] / r[0]) * (loc[0] / r[0]) - (loc[1] / r[1]) * (loc[1] / r[1]);
      if (k <= 0) return null;
      const z = r[2] * Math.sqrt(k);
      if (loc[2] >= z) return null;
      return add(center, qrot(q, [loc[0], loc[1], z]));
    }
    function colliders(ctx) {
      // head: rides on the head joint; the face side turns the head after us, so its turn (ctx.head) is added here
      const hn = N[I.head];
      let hq = M.headBind ? qmul(hn.mq, qconj(M.headBindQ0)) : QI, hc, hr;
      const neck = N[I.neck].mp;
      if (M.headBind) { hc = add(hn.mp, mul(qrot(hn.mq, M.headBind.local), hn.ms)); hr = M.headBind.r; }
      else { hc = add(M.head.c, sub(hn.mp, M.headP0)); hr = M.head.r; }
      const h = ctx && ctx.head;
      if (h) {
        const yaw = fin(h.yaw) ? h.yaw : fin(h[0]) ? h[0] : 0, pitch = fin(h.pitch) ? h.pitch : fin(h[1]) ? h[1] : 0, roll = fin(h.roll) ? h.roll : fin(h[2]) ? h[2] : 0;
        const d = qmul(qaxis([0, 0, 1], -roll * RAD), qmul(qaxis([0, 1, 0], yaw * RAD), qaxis([1, 0, 0], -pitch * RAD)));
        hc = add(neck, qrot(d, sub(hc, neck))); hq = qmul(d, hq);
      }
      const hand = (sides.l.L2 + sides.r.L2) / 2 * P.handRadius;
      const tn = N[I.hips];
      let tc, tr, tq;
      if (M.torsoBind) { tc = add(tn.mp, mul(qrot(tn.mq, M.torsoBind.local), tn.ms)); tr = M.torsoBind.r; tq = qmul(tn.mq, qconj(M.torsoBindQ0)); }
      else { tc = M.torso.c; tr = M.torso.r; tq = QI; }
      return {
        head: { c: hc, q: hq, r: [hr[0] * P.headMargin + hand, hr[1] * P.headMargin + hand, hr[2] * P.headMargin + hand] },
        torso: { c: tc, q: tq, r: [tr[0] * P.torsoMargin + hand, tr[1] * P.torsoMargin + hand, tr[2] * P.torsoMargin + hand] },
      };
    }
    if (M.headBind) M.headBindQ0 = M.headBind.q;
    if (M.torsoBind) M.torsoBindQ0 = M.torsoBind.q;
    M.headP0 = N[I.head].mp.slice();

    function constrain(a, shoulder, p, col, st, fdir) {
      // reach, then the colliders, then reach again (the colliders win near the body; the reach wins far away)
      const reachMax = a.reach * P.maxReach, reachMin = a.reach * P.minReach;
      const fit = (q) => {
        const d = sub(q, shoulder), l = len(d);
        if (l > reachMax) return add(shoulder, mul(d, reachMax / l));
        if (l < reachMin) return add(shoulder, mul(l > 1e-6 ? mul(d, 1 / l) : norm([a.out * 0.3, -0.8, 0.5]), reachMin));
        return q;
      };
      let q = fit(p), moved = 0;
      for (let k = 0; k < 2; k++) {
        const h = ellipsoid(col.head.c, col.head.q, col.head.r, q, P.faceFront);
        if (h) { moved += len(sub(h, q)); q = h; }
        const t = forward(col.torso.c, col.torso.q, col.torso.r, q);
        if (t) { moved += len(sub(t, q)); q = t; }
        if (fdir) {     // the middle of the hand as well (fingers that point into the body or the head)
          const off = mul(fdir, a.handLen * 0.5), m = add(q, off);
          const hm = ellipsoid(col.head.c, col.head.q, col.head.r, m, P.faceFront);
          if (hm) { moved += len(sub(hm, m)); q = sub(hm, off); }
          const m2 = add(q, off), tm = forward(col.torso.c, col.torso.q, col.torso.r, m2);
          if (tm) { moved += len(sub(tm, m2)); q = sub(tm, off); }
        }
        q = fit(q);
      }
      if (st) st.pushed = moved;
      return q;
    }

    // ---- the frame
    function update(perf, tMs, dtMs, ctx) {
      const c0 = nowMs();
      const dt = clamp(fin(dtMs) ? dtMs : 16.7, 0, 100) / 1000;
      // 1. the pose we start from (the idle clip). If nobody re-posed the skeleton, reuse last frame's base.
      for (const n of N) {
        const q = n.node.rotationQuaternion, p = n.node.position;
        const sameQ = n.wq && q.x === n.wq[0] && q.y === n.wq[1] && q.z === n.wq[2] && q.w === n.wq[3];
        const sameP = !n.wp || (p.x === n.wp[0] && p.y === n.wp[1] && p.z === n.wp[2]);
        readLocal(n);
        if (sameQ) n.lq = n.bq.slice(); else n.bq = n.lq.slice();
        if (n.wp && sameP) n.lp = n.bp.slice(); else n.bp = n.lp.slice();
        n.hs = null;
      }
      fkFrom(0);
      ingest(perf, tMs);
      const sig = sampleAt(tMs);
      debug.sig = sig; debug.interval = S.buf.interval; debug.offset = S.buf.offset; debug.gap = S.buf.gap;

      // 2. idle life: breathing, weight settle, talk bounce
      const L = S.life, sec = tMs / 1000;
      if (L.t0 == null) { L.t0 = sec; L.settleNext = sec + lerp(P.settleEvery[0], P.settleEvery[1], random()) * 0.5; }
      const breath = Math.sin(TAU * sec / P.breathPeriod), breath2 = Math.sin(TAU * sec / P.breathPeriod - 0.9);
      if (sec >= L.settleNext) { L.settleGoal = (L.settleGoal > 0 ? -1 : 1) * lerp(0.55, 1, random()); L.settleNext = sec + lerp(P.settleEvery[0], P.settleEvery[1], random()); }
      const drift = 0.35 * Math.sin(TAU * sec / 11.3) + 0.2 * Math.sin(TAU * sec / 7.1 + 1.3);
      const settle = spring(L.settle, L.settleGoal + drift, 3.2, 0.7, dt);
      const talk = clamp(ctx && fin(ctx.talk) ? ctx.talk : 0, 0, 1);
      L.talkFast += (talk - L.talkFast) * (1 - Math.exp(-dt * 30)); L.talkSlow += (talk - L.talkSlow) * (1 - Math.exp(-dt * 2.5));
      if (talk > P.bounceAt && L.talkFast - L.talkSlow > 0.18 && tMs - L.bounceAt > 380) { L.bounce.v += P.bounceOmega * (0.6 + 0.8 * (talk - P.bounceAt)); L.bounceAt = tMs; }
      const bounce = spring(L.bounce, 0, P.bounceOmega, P.bounceZeta, dt);
      const unit = M.sw;       // the avatar's shoulder width: the unit for every offset

      // 3. torso
      const T = S.torso, bodySeen = !!(sig && sig.body);
      T.w += ((bodySeen ? 1 : 0) - T.w) * (1 - Math.exp(-dt * (bodySeen ? 10 : 3.5)));
      const tw = T.w;
      const tilt = spring(T.tilt, bodySeen ? soft(sig.tilt * P.tiltGain, P.tiltMax) : 0, P.torsoOmega, P.torsoZeta, dt);
      const twist = spring(T.twist, bodySeen ? soft(sig.twist * P.twistGain, P.twistMax) : 0, P.torsoOmega, P.torsoZeta, dt);
      const lx = spring(T.lx, bodySeen ? soft(sig.lx, P.leanMaxX) : 0, P.torsoOmega, P.torsoZeta, dt);
      const lz = spring(T.lz, bodySeen ? soft(sig.lz, P.leanMaxZ) : 0, P.torsoOmega, P.torsoZeta, dt);
      const ns = I.spine.length;
      // The face side slides the WHOLE avatar in the frame with his head (ctx.shift, the holder's offset). A person who
      // leans keeps the hips where they are: take part of that slide back at the hips and bend the spine so the head
      // stays where the face side put it. (World x is model -x; world z is model z.)
      let plantX = 0, plantZ = 0;
      const shf = ctx && ctx.shift;
      if (shf && fin(shf.x) && fin(shf.z) && I.hips >= 0) {
        const cap = P.plantMax * RAD * M.spineLen;      // a chibi's head is huge for its spine: limit the bend, let the rest slide
        plantX = soft(P.plant * shf.x, cap); plantZ = soft(-P.plant * shf.z, cap);
      }
      const rollAll = -(tilt + lx * P.leanRoll) - settle * P.settleRoll * 0.6 + plantX / M.spineLen / RAD;   // about +z; clockwise on screen = negative
      const pitchAll = lz * P.leanPitch + breath * P.breathPitch + L.talkFast * P.talkLean - plantZ / M.spineLen / RAD; // about +x; forward = positive
      const yawAll = twist;
      S.roll = rollAll;
      let total = QI;
      for (let k = 0; k < ns; k++) {
        const lo = ns > 1 ? 1 - k / (ns - 1) : 0.5;          // 1 at the bottom joint, 0 at the chest
        const share = (ns > 1 ? lerp(0.8, 1.2, 1 - lo) : 1) / ns;
        const d = qmul(qaxis([0, 1, 0], yawAll * RAD * share), qmul(qaxis([1, 0, 0], pitchAll * RAD * share), qaxis([0, 0, 1], rollAll * RAD * share)));
        turn(I.spine[k], d); total = qmul(d, total);
        fkFrom(I.spine[k]);
      }
      if (I.hips >= 0) {
        shift(I.hips, [(lx * P.leanShift + settle * P.settleShift) * unit + plantX, bounce * P.bounce * unit - Math.abs(settle) * 0.004 * unit, plantZ]);
        turn(I.hips, qaxis([0, 0, 1], settle * P.settleRoll * RAD));
      }
      fkFrom(0);
      if (I.neck >= 0 && P.headCounter > 0) { turn(I.neck, qslerp(QI, qconj(total), P.headCounter)); fkFrom(I.neck); }
      debug.torso = { tilt, twist, lx, lz, w: tw, settle, bounce };

      // 4. shoulders: shrug + breathing
      for (const s of ['l', 'r']) {
        const a = sides[s];
        if (a.shoulder < 0) continue;
        const want = bodySeen ? clamp(sig.shrug[s === 'l' ? 0 : 1], 0, 1) : 0;
        const sh = spring(T.shrug[s], want, P.shrugOmega, 0.75, dt);
        a.shrugNow = sh;
        const lift = sh * P.shrugLift + (0.5 + 0.5 * breath2) * P.breathLift;
        turn(a.shoulder, qaxis([0, 0, 1], a.out * sh * P.shrugAngle * RAD));     // screen-left shoulder: clockwise lifts its tip
        shift(a.shoulder, [0, lift * unit, 0]);
      }
      fkFrom(0);

      // 4b. B1: talk gestures (what each arm would do if no hand of his is seen)
      gestures(ctx, sig, talk, tMs, dt, sec);

      // 5. arms
      const col = colliders(ctx);
      debug.pushes = 0;
      for (const s of ['l', 'r']) arm(s, sig, tMs, dt, col, breath, sec);

      // 6. tails
      tails(tMs, dt, twist);

      // 7. write
      for (const n of N) {
        const q = n.node.rotationQuaternion, p = n.node.position;
        q.copyFromFloats(n.lq[0], n.lq[1], n.lq[2], n.lq[3]); n.wq = [q.x, q.y, q.z, q.w];
        if (n.lp[0] !== n.bp[0] || n.lp[1] !== n.bp[1] || n.lp[2] !== n.bp[2] || n.wp) { p.copyFromFloats(n.lp[0], n.lp[1], n.lp[2]); n.wp = [p.x, p.y, p.z]; }
        if (n.hs) n.node.scaling.copyFromFloats(n.hs[0], n.hs[1], n.hs[2]);
        else if (n.hsBase) { n.node.scaling.copyFromFloats(n.hsBase[0], n.hsBase[1], n.hsBase[2]); }
      }
      S.frames++;
      const cost = nowMs() - c0;
      debug.costMs = cost; debug.costAvg += (cost - debug.costAvg) * 0.05; if (S.frames > 30 && cost > debug.costMax) debug.costMax = cost;
    }

    /**
     * B1. He speaks, and no hand of his is in the picture: each arm is given a small gesture to make (or none: pauses
     * are part of it). A new one is drawn every 1.3 - 3.8 s from a small vocabulary, with its own offsets and phases, so
     * the same move never comes round on a beat; the voice's own rise and fall bobs the hand on each syllable.
     */
    function gestures(ctx, sig, talk, tMs, dt, sec) {
      const G = S.gest, L = S.life;
      const v = ctx && ctx.voice && ctx.voice.on ? ctx.voice : null;
      const speaking = v ? !!v.talking : talk > 0.16;
      if (speaking) { G.speakT += dt * 1000; G.quietT = 0; } else { G.quietT += dt * 1000; if (G.quietT > 250) G.speakT = 0; }
      const realSeen = !!(sig && (sig.arm.l || sig.arm.r || sig.hand.l || sig.hand.r));
      if (realSeen) G.handAt = tMs;
      const allowed = P.gestures !== false && !(ctx && ctx.tracked === false) && tMs - G.handAt > P.gestAfterHandMs;
      const was = G.on;
      G.on = allowed && (G.on ? G.quietT < P.gestOffMs : G.speakT >= P.gestOnMs);
      if (G.on && !was) { G.nextAt = sec + 0.25; G.armed = true; G.resting = true; }
      if (!G.on) { G.arm.l.want = G.arm.r.want = false; gesture.on = false; return; }
      gesture.on = true;
      const pick = (g, name, hold) => {
        g.want = !!name; g.name = name; g.until = sec + hold;
        if (!name) return;
        g.last = name; g.p = GEST[name].p;
        g.jit = [(random() - 0.5) * 0.14, (random() - 0.5) * 0.14, (random() - 0.5) * 0.10];
        g.ph = [random() * TAU, random() * TAU, random() * TAU];
      };
      const jump = L.talkFast - L.talkSlow;
      if (sec >= G.nextAt) {
        if (!G.resting) {
          // the gesture is over: both arms rest for a while
          const rest = lerp(P.gestRest[0], P.gestRest[1], random());
          pick(G.arm.l, null, rest); pick(G.arm.r, null, rest);
          G.resting = true; G.armed = false; G.nextAt = sec + rest;
        } else G.armed = true;                            // rested: the next emphasis starts a gesture
      }
      if (G.armed && sec >= G.nextAt && (jump > P.gestCue || sec - G.nextAt > P.gestCueWaitS)) {
        const hold = lerp(P.gestPhrase[0], P.gestPhrase[1], random()), r = random();
        const names = ['rise', 'rise', 'open', 'beat', 'beat'];
        const one = (g) => { let n = names[Math.floor(random() * names.length)]; if (n === g.last) n = names[Math.floor(random() * names.length)]; return n; };
        if (r < 0.40) { pick(G.arm.l, one(G.arm.l), hold); pick(G.arm.r, null, hold); }
        else if (r < 0.80) { pick(G.arm.r, one(G.arm.r), hold); pick(G.arm.l, null, hold); }
        else { const both = random() < 0.4 ? 'wide' : null; pick(G.arm.l, both || one(G.arm.l), hold); pick(G.arm.r, both || one(G.arm.r), hold); }
        G.resting = false; G.armed = false; G.nextAt = sec + hold;
      }
      // emphasis (his voice jumps over its own running level): now and then the raised hand points
      if (jump > 0.24 && tMs - G.pointAt > P.gestPointEvery && random() < 0.06) {
        const g = G.arm.l.want && !G.arm.r.want ? G.arm.l : G.arm.r.want && !G.arm.l.want ? G.arm.r : (random() < 0.5 ? G.arm.l : G.arm.r);
        pick(g, 'point', 0.9 + 0.5 * random()); G.pointAt = tMs; G.resting = false; G.armed = false; G.nextAt = Math.max(G.nextAt, g.until);
      }
      G.beat = clamp(jump, -0.25, 0.5);
    }
    /** B1: where the gesturing wrist of arm `s` aims right now (model space), or null */
    function gestureGoal(s, shoulder, sec) {
      const g = S.gest.arm[s], a = sides[s];
      if (!S.gest.on || !g.want) return null;
      const d = P.gestDrift, b = (S.gest.beat || 0) * P.gestBeat;
      const x = g.p[0] + g.jit[0] + d * Math.sin(TAU * sec / 5.3 + g.ph[0]);
      const y = g.p[1] + g.jit[1] + d * Math.sin(TAU * sec / 3.7 + g.ph[1]) + b;
      const z = g.p[2] + g.jit[2] + 0.7 * d * Math.sin(TAU * sec / 4.6 + g.ph[2]) + 0.35 * b;
      return add(shoulder, [x * a.out * a.reach, y * a.reach, z * a.reach]);
    }

    /** Two-bone IK: turn the upper arm and forearm (from their present pose) so the wrist sits at p. Returns the elbow. */
    function ikTo(a, p, pole, col) {
      const nA = N[a.arm], nF = N[a.fore], nH = N[a.hand], shoulder = nA.mp;
      const d = sub(p, shoulder), dl = Math.max(len(d), 1e-6), dir = mul(d, 1 / dl);
      const a1 = clamp((a.L1 * a.L1 - a.L2 * a.L2 + dl * dl) / (2 * dl), -a.L1, a.L1), h = Math.sqrt(Math.max(0, a.L1 * a.L1 - a1 * a1));
      let perp = sub(pole, mul(dir, dot(pole, dir)));
      if (len(perp) < 1e-3) perp = sub([a.out, 0, 0], mul(dir, dir[0] * a.out));
      perp = norm(perp, [0, -1, 0]);
      let elbow = add(shoulder, add(mul(dir, a1), mul(perp, h)));
      // the elbow may not sit inside the chest: swing it outward
      const te = ellipsoid(col.torso.c, col.torso.q, [col.torso.r[0] * 0.8, col.torso.r[1], col.torso.r[2] * 0.8], elbow, 1);
      if (te) { let p2 = sub(te, shoulder); p2 = sub(p2, mul(dir, dot(p2, dir))); if (len(p2) > 1e-4) elbow = add(shoulder, add(mul(dir, a1), mul(norm(p2), h))); }
      turn(a.arm, qfromto(norm(sub(nF.mp, nA.mp)), norm(sub(elbow, shoulder)))); fkFrom(a.arm);
      turn(a.fore, qfromto(norm(sub(nH.mp, nF.mp)), norm(sub(p, nF.mp)))); fkFrom(a.fore);
      return elbow;
    }

    function arm(s, sig, tMs, dt, col, breath, sec) {
      const a = sides[s], st = S.arm[s];
      const nA = N[a.arm], nF = N[a.fore], nH = N[a.hand];
      const baseA = nA.lq, baseF = nF.lq, baseH = nH.lq;
      // idle arms breathe and drift a little, so a resting arm is never frozen
      const swayAng = (breath * P.breathArm + P.armSway * Math.sin(TAU * sec / 9.7 + (s === 'l' ? 0 : 2.1))) * RAD;
      // the chest's roll and the raised shoulder's turn, taken back at the shoulder joint of an arm that rests
      const hang = (clamp(-(S.roll || 0) * P.armHang, -P.armHangMax, P.armHangMax) - a.out * (a.shrugNow || 0) * P.shrugAngle * P.armHangShrug) * RAD;
      const idleA = qnorm(qmul(qconj(N[nA.par].mq), qmul(qaxis([0, 0, 1], a.out * swayAng + hang), qmul(N[nA.par].mq, baseA))));
      const shoulder = nA.mp;
      const sa = sig ? sig.arm[s] : null, sh = sig ? sig.hand[s] : null;
      if (sa) {
        // --- where his hand is. Sideways: in shoulder widths (hands at his midline meet at the avatar's midline, a hand
        //     outside his shoulder goes the same share of a shoulder width outside the avatar's). Up / down and toward the
        //     camera: as a share of his reach carried to the avatar's reach (a chibi arm is half as long for its shoulders).
        const k = a.reach / P.humanReach;
        let off = [sa.w[0] * M.sw * P.armGain[0], sa.w[1] * k * P.armGain[1] + P.armLift * a.reach, sa.w[2] * k * P.armGain[2]];
        const ol = len(off), full = a.reach * P.maxReach;
        if (ol > 0.8 * full) off = mul(off, (0.8 * full + soft(ol - 0.8 * full, 0.2 * full)) / ol);
        let goal = add(shoulder, off);
        // --- near his head: the same place around the AVATAR's head, in head sizes. Measured at the middle of his hand
        //     (a wrist can be far from the face while the fingers touch the chin), and aimed with the middle of the
        //     avatar's hand.
        if (sig.head) {
          const hw = sig.head[2], fd = sh ? sh.dir : null;
          const px = sa.w[0] + (fd ? fd[0] * P.palmLen : 0), py = sa.w[1] + (fd ? fd[1] * P.palmLen : 0);
          const rel = [(px + a.out * 0.5 - sig.head[0]) / hw, (py - sig.head[1]) / hw];
          const d = Math.hypot(rel[0], rel[1]);
          const wz = 1 - smooth((d - P.headZone[0]) / (P.headZone[1] - P.headZone[0]));
          if (wz > 0) {
            const hc = col.head.c, hr = col.head.r;
            const g2 = [hc[0] + rel[0] * 2 * hr[0] * P.headGain[0], hc[1] + rel[1] * 2 * hr[1] * P.headGain[1], Math.max(goal[2], hc[2] + hr[2] * 0.2)];
            if (fd) { g2[0] -= fd[0] * a.handLen * 0.5; g2[1] -= fd[1] * a.handLen * 0.5; }
            goal = lerp3(goal, g2, wz);
          }
        }
        // --- B4: a raised hand, by its height against his head (see `raise` in the tuning)
        if (sig.head && sig.head[1] > 0.2 && P.raiseGain > 0) {
          const fd = sh ? sh.dir : null;
          const py = sa.w[1] + (fd ? fd[1] * P.palmLen : 0.7 * P.palmLen) + P.raiseFromDepth * Math.max(0, sa.w[2]);
          const wr = smooth((py - P.raise[0]) / (P.raise[1] - P.raise[0]));
          if (wr > 0) {
            const u = clamp(py / sig.head[1], 0, P.raiseMax);
            const y = shoulder[1] + u * (col.head.c[1] - shoulder[1]) * P.raiseGain - (fd ? fd[1] : 0.7) * a.handLen * 0.5;   // the avatar's wrist
            if (y > goal[1]) goal[1] = lerp(goal[1], y, wr);
            debug.raise = debug.raise || {}; debug.raise[s] = { py, u, wr };
          }
        }
        goal = constrain(a, shoulder, goal, col, null, sh ? sh.dir : null);
        if (!st.have || st.lin <= 0) {
          st.mix = 1;                                    // a fresh tracked arm: the quick spring at once
          // a fresh arm: start the spring at the goal; the blend from the idle pose is the motion. The farther the
          // hand has to travel from where it hangs, the longer the blend (an arm cannot teleport overhead).
          st.pos = newSpring3(goal); st.pole = null; st.prevGoal = null; st.gv = [0, 0, 0];
          st.fadeIn = P.fadeInMs * (1 + Math.min(1.5, len(sub(goal, nH.mp)) / a.reach));
        }
        st.goal = goal; st.have = true; st.seenAt = tMs; st.src = 'real';
        // elbow direction
        let pole = [P.poleDefault[0] * a.out, P.poleDefault[1], P.poleDefault[2]];
        if (sa.e) {
          const ww = dot(sa.w, sa.w);
          const off = ww > 1e-6 ? sub(sa.e, mul(sa.w, dot(sa.e, sa.w) / ww)) : sa.e;
          if (len(off) > 0.12) pole = lerp3(norm(pole), norm(off), P.poleFromElbow);
        }
        pole = norm(pole);
        st.pole = st.pole ? norm(lerp3(st.pole, pole, 1 - Math.exp(-dt * 14))) : pole;
      }
      // how long a lost arm is held: 200 ms, or a little over one body check when those come slowly
      const holdMs = Math.max(P.holdMs, Math.min(P.holdMaxMs, P.holdChecks * S.buf.gap));
      const held = st.have && st.src === 'real' && tMs - st.seenAt < holdMs;
      // --- B1: no hand of his for this arm: a talk gesture, if one is wanted. The same spring carries the hand, so a
      //     tracked hand takes over (and hands back) without a jump.
      if (!sa && !held) {
        let goal = gestureGoal(s, shoulder, sec);
        if (goal) {
          goal = constrain(a, shoulder, goal, col, null, null);
          if (!st.have || st.lin <= 0) {                 // from rest: the hand starts where it hangs and is carried up
            st.pos = newSpring3(nH.mp); st.pole = null; st.prevGoal = null; st.gv = [0, 0, 0]; st.fadeIn = P.gestFadeInMs; st.mix = 0;
          }
          st.goal = goal; st.have = true; st.gestAt = tMs; st.src = 'gest';
          const pole = norm([P.poleDefault[0] * a.out, P.poleDefault[1], P.poleDefault[2]]);
          st.pole = st.pole ? norm(lerp3(st.pole, pole, 1 - Math.exp(-dt * 6))) : pole;
        }
      }
      const gesturing = st.src === 'gest' && tMs - st.gestAt < 120;
      const tracked = !!sa || held || gesturing;
      st.mix = clamp(st.mix + (sa || held ? dt / 0.35 : -dt / 0.4), 0, 1);     // 1 = a tracked hand's quick spring, 0 = a gesture's soft one
      st.lin = clamp(st.lin + (tracked ? dt * 1000 / (st.fadeIn || P.fadeInMs) : -dt * 1000 / (st.src === 'gest' ? P.gestFadeOutMs : P.fadeOutMs)), 0, 1);
      const g3 = gesture[s]; g3.w = gesturing ? smooth(st.lin) * (1 - st.mix) : 0; g3.name = gesturing ? S.gest.arm[s].name : null; g3.pose = gesturing && g3.name ? GEST[g3.name].pose : null;
      if (st.lin <= 0) st.have = false;
      const w = st.w = smooth(st.lin);
      let ikA = idleA, ikF = baseF, ikH = baseH, hs = null;
      if (w > 0 && st.goal) {
        // the spring chases a point a little AHEAD of the goal along the goal's own motion, so a moving hand is not
        // trailed by the spring's lag; a still hand has no motion, so nothing is added at rest
        let aim = st.goal;
        if (dt > 0 && st.prevGoal && sa) {
          const k = 1 - Math.exp(-dt * 60);
          st.gv = lerp3(st.gv || [0, 0, 0], mul(sub(st.goal, st.prevGoal), 1 / dt), k);
          let ahead = mul(st.gv, P.armAheadMs / 1000);
          const al = len(ahead), cap = 0.22 * a.reach;
          if (al > cap) ahead = mul(ahead, cap / al);
          aim = add(st.goal, ahead);
        } else st.gv = st.gv ? mul(st.gv, Math.exp(-dt * 25)) : [0, 0, 0];
        st.prevGoal = st.goal;
        const km = smooth(st.mix);
        let p = spring3(st.pos, aim, lerp(P.gestOmega, P.armOmega, km), lerp(P.gestZeta, P.armZeta, km), dt).slice();
        p = constrain(a, shoulder, p, col, st, sh ? sh.dir : null);
        if (st.pushed > 1e-5) debug.pushes++;
        // --- two-bone IK from the idle pose
        nA.lq = baseA; fkFrom(a.arm);
        const elbow = ikTo(a, p, st.pole, col);
        ikA = nA.lq; ikF = nF.lq;
        // --- hand: his finger direction and palm, limited at the wrist
        const fore = norm(sub(nH.mp, nF.mp));
        if (sh) st.handSeenAt = tMs;
        const handTracked = !!sh || tMs - st.handSeenAt < holdMs;
        st.handLin = clamp(st.handLin + (handTracked ? dt * 1000 / P.fadeInMs : -dt * 1000 / 320), 0, 1);
        const hwt = smooth(st.handLin);
        if (sh) {
          let f = sh.dir;
          const ang = Math.acos(clamp(dot(f, fore), -1, 1)), lim = P.wristMax * RAD;
          if (ang > lim) f = qrot(qaxis(norm(cross(fore, f), [0, 0, 1]), lim), fore);
          let nrm = sub(sh.palm, mul(f, dot(sh.palm, f)));
          nrm = norm(nrm, norm(cross(f, [0, 0, 1])));
          const third = cross(f, nrm);
          const lf = a.fLocal, ln = norm(sub(a.nLocal, mul(lf, dot(a.nLocal, lf)))), lt = cross(lf, ln);
          // rotation that takes (lf, ln, lt) to (f, nrm, third)
          const qt = qmul(qbasis(f, nrm, third), qconj(qbasis(lf, ln, lt)));
          st.handQ = st.handQ && st.handLin > 0.02 ? qslerp(st.handQ, qt, 1 - Math.exp(-dt * P.handOmega)) : qt;
          spring(st.curl, sh.curl, P.curlOmega, 0.9, dt);
        } else spring(st.curl, 0.25, 8, 1, dt);
        if (st.handQ && hwt > 0) {
          const natural = nH.lq;
          orient(a.hand, st.handQ);
          nH.lq = qslerp(natural, nH.lq, hwt);
        }
        ikH = nH.lq;
        // a fist is shorter and thicker, an open hand a touch longer (the models have no finger joints)
        const c = clamp(st.curl.x, 0, 1), amt = hwt * w;
        const kLen = 1 + amt * (c > 0.25 ? -P.fistSquash * smooth((c - 0.25) / 0.6) : P.openStretch * (1 - c / 0.25));
        const kWide = 1 + amt * (c > 0.25 ? P.fistBulge * smooth((c - 0.25) / 0.6) : 0);
        if (!nH.hsBase) { const sc = nH.node.scaling; nH.hsBase = [sc.x, sc.y, sc.z]; }
        hs = nH.hsBase.map((v, k) => v * (k === a.squashAxis ? kLen : kWide));
        st.target = p; st.elbow = elbow;
      } else { st.handLin = 0; st.handQ = null; st.target = null; }
      // blend with the idle pose
      nA.lq = qslerp(idleA, ikA, w); nF.lq = qslerp(baseF, ikF, w); nH.lq = qslerp(baseH, ikH, w);
      nH.hs = hs;
      fkFrom(a.arm);
      // half way between the idle pose and the tracked pose the hand can cut through the body: push that out too
      if (w > 0.001 && w < 0.999 && st.pole) {
        let q = nH.mp, moved = false;
        const hb = ellipsoid(col.head.c, col.head.q, col.head.r, q, P.faceFront);
        if (hb) { q = hb; moved = true; }
        const tb = forward(col.torso.c, col.torso.q, col.torso.r, q);
        if (tb) { q = tb; moved = true; }
        if (moved) { ikTo(a, q, st.pole, col); debug.pushes++; }
      }
      debug.arms[s] = { src: st.have ? st.src : null, mix: st.mix, w, hand: st.handLin, goal: st.goal, target: st.target, wrist: nH.mp.slice(), elbow: nF.mp.slice(), shoulder: shoulder.slice(), pushed: st.pushed, curl: st.curl.x };
    }

    function tails(tMs, dt, twist) {
      if (!I.tails.length) return;
      const sec = tMs / 1000, V = S.vel;
      // how the body moves: hips + chest, low-passed
      const ref = lerp3(N[I.hips].mp, N[chestI].mp, 0.5);
      if (V.p && dt > 0) { const raw = mul(sub(ref, V.p), 1 / dt); const k = 1 - Math.exp(-dt * 18); V.v = lerp3(V.v, raw, k); V.twistV += ((twist - V.twist) / dt - V.twistV) * k; }
      V.p = ref; V.twist = twist;
      const first = N[I.tails[0]], last = N[I.tails[I.tails.length - 1]];
      const along = sub(last.mp, first.mp), al = Math.max(len(along), 1e-4);
      const lagZ = clamp(-P.tailLag * (along[0] * V.v[1] - along[1] * V.v[0]) / al / Math.max(M.sw, 1e-4), -P.tailMax, P.tailMax);      // screen-plane lag, degrees
      const lagY = clamp(-P.tailTwist * V.twistV * 0.1, -P.tailMax, P.tailMax);
      const side = norm(cross([0, 0, 1], norm(along)), [0, 1, 0]);
      for (let k = 0; k < I.tails.length; k++) {
        const ts = S.tail[k], kk = Math.min(k, P.tailSwing.length - 1);
        const ph = TAU * sec / P.tailPeriod - k * P.tailPhase;
        const swing = P.tailSwing[kk] * Math.min(1, 3 / I.tails.length) * (Math.sin(ph) + 0.35 * Math.sin(ph * 0.43 + 1.7));
        const gain = 0.5 + 0.5 * (k + 1) / I.tails.length;
        const az = spring(ts.a, swing * 0.55 + lagZ * gain, P.tailOmega[kk], P.tailZeta, dt);
        const ab = spring(ts.b, swing * 0.45 * Math.cos(ph * 0.8), P.tailOmega[kk], P.tailZeta, dt);
        const ay = spring(ts.y, lagY * gain, P.tailOmega[kk], P.tailZeta, dt);
        turn(I.tails[k], qmul(qaxis([0, 1, 0], ay * RAD), qmul(qaxis([0, 0, 1], az * RAD), qaxis(side, ab * RAD))));
        fkFrom(I.tails[k]);
      }
    }

    function reset() {
      resetState();
      for (const n of N) { n.wq = null; n.wp = null; if (n.hsBase) n.node.scaling.copyFromFloats(n.hsBase[0], n.hsBase[1], n.hsBase[2]); }
    }

    return {
      update, reset, params: P, debug, gesture,
      /** V5 (js/hands3d.js): each hand's joint node and its own axes at bind (finger direction, palm normal), per PICTURE side */
      hands: { l: { node: N[sides.l.hand].node, fLocal: sides.l.fLocal.slice(), nLocal: sides.l.nLocal.slice(), out: sides.l.out }, r: { node: N[sides.r.hand].node, fLocal: sides.r.fLocal.slice(), nLocal: sides.r.nLocal.slice(), out: sides.r.out } },
      info: { sw: M.sw, reach: { l: sides.l.reach, r: sides.r.reach }, measured: M.ok, head: M.headBox || null, joints: N.map((n) => n.node.name) },
      /** model-space position of a joint by name (after the last update): for the lab's overlays and the tests */
      jointPosition(name) { const n = N.find((x) => x.node.name === name); return n ? n.mp.slice() : null; },
      colliders: (ctx) => colliders(ctx),
      /**
       * How deep each hand is in the head / the body after the last update: for the wrist and the middle of the hand,
       * the distance from the collider's centre as a share of its measured size (no margins). Below 1 = inside.
       */
      probe(ctx) {
        const col = colliders(ctx), hand = (sides.l.L2 + sides.r.L2) / 2 * P.handRadius, out = {};
        const u = (c, margin, p) => { const loc = qrot(qconj(c.q), sub(p, c.c)); const r = c.r.map((v) => (v - hand) / margin); return Math.hypot(loc[0] / r[0], loc[1] / r[1], loc[2] / r[2]); };
        for (const s of ['l', 'r']) {
          const a = sides[s], wrist = N[a.hand].mp, mid = add(wrist, mul(qrot(N[a.hand].mq, a.fLocal), a.handLen * 0.5));
          out[s] = { head: Math.min(u(col.head, P.headMargin, wrist), u(col.head, P.headMargin, mid)), torso: Math.min(u(col.torso, P.torsoMargin, wrist), u(col.torso, P.torsoMargin, mid)), w: S.arm[s].w };
        }
        return out;
      },
    };
  }

  const api = { create, DEFAULTS, _math: { qmul, qrot, qconj, qfromto, qslerp, qbasis, qaxis, spring, norm, cross, dot } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.VTBody = api;
})(typeof window !== 'undefined' ? window : globalThis);
