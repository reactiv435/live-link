// V9 HANDS: SIMULATED hands, for the demo and for measuring the gesture reader. Pure UMD.
// A jointed hand (21 points, the hand model's own order) is posed by a few numbers (finger curls, the thumb, turn, size,
// place) and written the way the tracker sends a hand: { handed, score, lm: 63 picture numbers, world: 63 metres }.
// A SCRIPT is a list of keys per hand; between keys every number eases (no straight lines, no constant speeds) and a
// small sway is laid on top, so it moves like a hand and not like a robot. NOT his real hands: nothing here has seen a camera.
//
//   VTHandSim.hand({ side: 1 | -1, x, y, scale, curl: [i, m, r, p], thumb: [open, fist, pinch], roll, yaw, pitch }, aspect)
//   VTHandSim.play(script, t, { face: { x, y, w }, aspect, rnd, noise })  -> [hand, hand]
//   VTHandSim.DEMO = { seconds, keys, labels }      // the 25 s demo: every gesture in turn
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTHandSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const D = Math.PI / 180, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  // a right hand, palm to the camera, fingers up; x = picture right, y = up, z = towards the camera; unit = wrist to middle knuckle
  const FINGERS = [
    { base: [0.28, 0.93, 0], len: [0.42, 0.26, 0.20], fan: 11 }, { base: [0.03, 1.0, 0], len: [0.47, 0.30, 0.21], fan: 1 },
    { base: [-0.21, 0.94, 0], len: [0.43, 0.28, 0.20], fan: -9 }, { base: [-0.42, 0.81, 0], len: [0.33, 0.20, 0.18], fan: -22 },
  ];
  const THUMB = {
    open: [[0.28, 0.20, 0.06], [0.56, 0.36, 0.10], [0.78, 0.52, 0.12], [0.93, 0.68, 0.12]],
    fist: [[0.26, 0.22, 0.10], [0.44, 0.48, 0.30], [0.28, 0.70, 0.42], [0.06, 0.78, 0.42]],
  };
  const PALM_M = 0.095;

  function local(curl, thumb) {
    const P = new Array(21); P[0] = [0, 0, 0];
    FINGERS.forEach((f, k) => {
      const c = clamp(curl[k], 0, 1.1), a = [c * 85 * D, c * 185 * D, c * 250 * D], sf = Math.sin(f.fan * D), cf = Math.cos(f.fan * D);
      let p = f.base.slice(); P[5 + k * 4] = p;
      for (let j = 0; j < 3; j++) { const ca = Math.cos(a[j]), sa = Math.sin(a[j]); p = [p[0] + f.len[j] * sf * ca, p[1] + f.len[j] * cf * ca, p[2] + f.len[j] * sa]; P[6 + k * 4 + j] = p; }
    });
    const tip = P[8], pin = [[0.27, 0.22, 0.08], [0.46, 0.46, 0.22], null, [tip[0] + 0.035, tip[1] - 0.03, tip[2] + 0.02]];
    pin[2] = [(pin[1][0] + pin[3][0]) / 2 + 0.06, (pin[1][1] + pin[3][1]) / 2 - 0.02, (pin[1][2] + pin[3][2]) / 2 + 0.04];
    const w = thumb || [1, 0, 0], sum = (w[0] + w[1] + w[2]) || 1;
    for (let j = 0; j < 4; j++) { const o = [0, 0, 0]; for (let q = 0; q < 3; q++) { o[q] = (THUMB.open[j][q] * w[0] + THUMB.fist[j][q] * w[1] + pin[j][q] * w[2]) / sum; } P[1 + j] = o; }
    return P;
  }

  /** one posed hand as the tracker would send it */
  function hand(h, aspect) {
    const P = local(h.curl || [0, 0, 0, 0], h.thumb), sd = h.side >= 0 ? 1 : -1;
    const cr = Math.cos(h.roll || 0), sr = Math.sin(h.roll || 0), cy = Math.cos(h.yaw || 0), sy = Math.sin(h.yaw || 0), cp = Math.cos(h.pitch || 0), sp = Math.sin(h.pitch || 0);
    const lm = new Array(63), world = new Array(63), s = h.scale;
    let wz = 0;
    for (let i = 0; i < 21; i++) {
      let x = P[i][0] * sd, y = P[i][1] - 0.55, z = P[i][2];
      let t = y * cp - z * sp; z = y * sp + z * cp; y = t;                 // pitch: about x
      t = x * cy + z * sy; z = -x * sy + z * cy; x = t;                     // yaw: about the forearm (this is the twist)
      t = x * cr - y * sr; y = x * sr + y * cr; x = t;                      // roll: in the picture
      if (i === 0) wz = z;
      lm[i * 3] = h.x + s * x / aspect; lm[i * 3 + 1] = h.y - s * y; lm[i * 3 + 2] = -s * (z - wz) / aspect;
      world[i * 3] = x * PALM_M; world[i * 3 + 1] = -y * PALM_M; world[i * 3 + 2] = -z * PALM_M;
    }
    return { handed: sd > 0 ? 'Right' : 'Left', score: h.score === undefined ? 0.9 : h.score, lm, world };
  }

  const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);
  const NUM = ['u', 'v', 's', 'roll', 'yaw', 'pitch', 'on'];
  const REST = { u: 0, v: 3.2, s: 0.42, c: [0.35, 0.4, 0.45, 0.5], th: [1, 0, 0], roll: 0, yaw: 0, pitch: 0, on: 0 };
  /** the value of one hand's keys at time t: each key = { t, ...numbers } and holds what it does not name from the key before */
  function at(keys, t) {
    let a = null, b = null; const full = [];
    let cur = Object.assign({}, REST, { c: REST.c.slice(), th: REST.th.slice() });
    for (const k of keys) { cur = Object.assign({}, cur, k, { c: (k.c || cur.c).slice(), th: (k.th || cur.th).slice() }); full.push(cur); }
    for (let i = 0; i < full.length; i++) { if (full[i].t <= t) a = full[i]; else { b = full[i]; break; } }
    if (!a) return full[0]; if (!b) return a;
    const f = smoother(clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1)), o = { c: [], th: [] };
    for (const n of NUM) o[n] = a[n] + (b[n] - a[n]) * f;
    for (let i = 0; i < 4; i++) o.c[i] = a.c[i] + (b.c[i] - a.c[i]) * f;
    for (let i = 0; i < 3; i++) o.th[i] = a.th[i] + (b.th[i] - a.th[i]) * f;
    return o;
  }

  /** the two hands of a script at time t. face = where his face is in the picture ({ x, y, w } in picture units, w = its width as a part of the picture HEIGHT) */
  function play(script, t, o) {
    const face = o.face, asp = o.aspect, out = [], rnd = o.rnd || Math.random, noise = o.noise || 0, sway = o.sway === undefined ? 1 : o.sway;
    const gauss = () => { let a = 0; for (let i = 0; i < 4; i++) a += rnd(); return (a - 2) * 1.73; };
    for (const [key, sd] of [['R', 1], ['L', -1]]) {
      const k = at(script.keys[key], t); if (!(k.on > 0.5)) continue;
      const ph = sd > 0 ? 0 : 1.9;
      const h = hand({
        side: sd,
        x: face.x + (k.u + sway * 0.035 * Math.sin(t * 1.3 + ph) + sway * 0.02 * Math.sin(t * 2.9 + ph * 2)) * face.w / asp,
        y: face.y + (k.v + sway * 0.04 * Math.sin(t * 1.1 + 1 + ph) + sway * 0.015 * Math.sin(t * 3.3 + ph)) * face.w,
        scale: k.s * face.w * (1 + sway * 0.012 * Math.sin(t * 0.9 + ph)),
        curl: k.c.map((c, i) => c + sway * 0.03 * Math.sin(t * 1.7 + i + ph)), thumb: k.th,
        roll: k.roll + sway * 0.05 * Math.sin(t * 0.8 + ph), yaw: k.yaw + sway * 0.06 * Math.sin(t * 1.05 + ph), pitch: k.pitch + sway * 0.05 * Math.sin(t * 0.7 + 2 + ph),
      }, asp);
      if (noise) { for (let i = 0; i < 63; i++) { h.lm[i] += gauss() * noise * (i % 3 === 2 ? 2.5 : 1) / (i % 3 === 0 ? asp : 1); h.world[i] += gauss() * noise * 0.6; } h.score = clamp(0.9 + gauss() * 0.04, 0.5, 1); }
      out.push(h);
    }
    return out;
  }

  // ---------------------------------------------------------------- pose shorthands (the numbers a key can carry)
  const OPEN = { c: [0.04, 0.03, 0.05, 0.08], th: [1, 0, 0] }, RELAX = { c: [0.30, 0.34, 0.38, 0.42], th: [1, 0, 0] }, CLAW = { c: [0.30, 0.33, 0.35, 0.36], th: [1, 0, 0] };
  const FIST = { c: [1, 1, 1, 1], th: [0, 1, 0] }, PINCH = { c: [0.52, 0.12, 0.10, 0.12], th: [0, 0, 1] }, POINT = { c: [0.02, 0.98, 1, 1], th: [0.25, 0.75, 0] };
  // places are in FACE WIDTHS from the middle of his face: u = to the picture's right, v = down. His right hand is on the picture's left.
  const K = (t, pose, more) => Object.assign({ t }, pose, more);

  /** the demo: 25 s, each gesture in turn (the labels name them) */
  const DEMO = {
    seconds: 25,
    labels: [
      [1.3, 3.7, 'TWO HANDS UP', 'the galaxy appears between them'], [3.7, 6.5, 'SPREAD YOUR HANDS', 'it grows and shrinks'],
      [6.5, 10.1, 'PINCH', 'catch it, drag it, throw it'], [10.1, 12.7, 'FIST', 'charge it (the music adds charge)'],
      [12.7, 14.3, 'PALM PUSH', 'blast the particles out'], [14.3, 16.7, 'PALM PULL', 'magnetize them back to your hands'],
      [16.7, 19.1, 'POINT', 'a stream from your fingertip'], [19.1, 21.3, 'TWIST', 'reverse the spin'],
      [21.3, 23.2, 'ONE HAND', 'it orbits your hand'], [23.2, 24.8, 'THE DROP', 'the music fires a burst'],
    ],
    keys: {
      R: [
        K(0, RELAX, { u: -1.0, v: 3.0, s: 0.54, on: 0, roll: 0.25, yaw: 0.2, pitch: 0.1 }),
        K(0.5, RELAX, { on: 1, v: 2.6 }), K(1.5, CLAW, { u: -0.92, v: 1.35, roll: 0.5, yaw: 0.35 }), K(3.7, CLAW, { u: -0.90, v: 1.30 }),
        K(4.6, OPEN, { u: -1.22, v: 1.05, roll: 0.35 }), K(5.5, CLAW, { u: -0.52, v: 1.25, roll: 0.6 }), K(6.4, CLAW, { u: -0.88, v: 1.25, roll: 0.5 }),
        // pinch: catch (in the middle), drag up across the face and round, then a quick flick up-right = the throw
        K(6.9, RELAX, { u: -0.30, v: 1.22, roll: 0.25, yaw: 0.15 }), K(7.25, PINCH, { u: -0.20, v: 1.22 }), K(8.0, PINCH, { u: -0.55, v: 0.25 }), K(8.7, PINCH, { u: 0.10, v: 0.75 }),
        K(8.95, PINCH, { u: -0.18, v: 1.05 }), K(9.17, OPEN, { u: 0.34, v: 0.42 }), K(9.4, OPEN, { u: 0.40, v: 0.38 }), K(10.0, CLAW, { u: -0.86, v: 1.28, roll: 0.5, yaw: 0.35 }),
        // fist: charge
        K(10.4, FIST, { u: -0.80, v: 1.25, roll: 0.3 }), K(12.45, FIST, { u: -0.74, v: 1.22 }),
        // open palms, then the push at the camera (the hand grows), and back
        K(12.75, OPEN, { u: -0.82, v: 1.2, roll: 0.15, yaw: 0, pitch: 0, s: 0.54 }), K(13.1, OPEN, { s: 0.54 }), K(13.36, OPEN, { s: 0.84, u: -0.86, v: 1.12 }), K(14.2, OPEN, { s: 0.58, u: -0.84, v: 1.2 }),
        // the pull (the hand gets smaller), and back
        K(14.75, OPEN, { s: 0.58 }), K(15.03, OPEN, { s: 0.38, u: -0.76, v: 1.3 }), K(16.5, CLAW, { s: 0.54, u: -0.86, v: 1.28, roll: 0.45, yaw: 0.3 }),
        // point: the index out, sweeping
        K(17.0, POINT, { u: -0.78, v: 1.35, roll: 1.05, yaw: 0.1 }), K(17.9, POINT, { roll: 0.55, u: -0.80, v: 1.3 }), K(18.8, POINT, { roll: 1.25, u: -0.76, v: 1.38 }),
        // twist: flat hands turn over (the back of the hand to the camera), and back
        K(19.25, OPEN, { u: -0.86, v: 1.25, roll: 0.2, yaw: 0 }), K(19.6, OPEN, { yaw: 0 }), K(19.95, OPEN, { yaw: 3.0 }), K(20.5, OPEN, { yaw: 3.0 }), K(20.85, OPEN, { yaw: 0 }), K(21.3, CLAW, { u: -0.86, v: 1.25, roll: 0.45, yaw: 0.3 }),
        // one hand: this one stays, held a little higher
        K(22.0, CLAW, { u: -0.62, v: 1.05, roll: 0.3 }), K(23.3, CLAW, { u: -0.60, v: 1.08 }), K(23.9, RELAX, { u: -0.85, v: 1.6 }), K(24.5, RELAX, { u: -1.0, v: 3.5, on: 1 }), K(24.6, RELAX, { on: 0 }),
      ],
      L: [
        K(0, RELAX, { u: 1.0, v: 3.0, s: 0.54, on: 0, roll: -0.25, yaw: -0.2, pitch: 0.1 }),
        K(0.62, RELAX, { on: 1, v: 2.6 }), K(1.62, CLAW, { u: 0.92, v: 1.38, roll: -0.5, yaw: -0.35 }), K(3.7, CLAW, { u: 0.90, v: 1.32 }),
        K(4.66, OPEN, { u: 1.22, v: 1.08, roll: -0.35 }), K(5.56, CLAW, { u: 0.52, v: 1.27, roll: -0.6 }), K(6.45, CLAW, { u: 0.88, v: 1.27, roll: -0.5 }),
        K(10.0, CLAW, { u: 0.90, v: 1.30 }), K(10.45, FIST, { u: 0.80, v: 1.27, roll: -0.3 }), K(12.5, FIST, { u: 0.74, v: 1.24 }),
        K(12.8, OPEN, { u: 0.82, v: 1.22, roll: -0.15, yaw: 0, pitch: 0, s: 0.54 }), K(13.12, OPEN, { s: 0.54 }), K(13.38, OPEN, { s: 0.84, u: 0.86, v: 1.14 }), K(14.2, OPEN, { s: 0.58, u: 0.84, v: 1.22 }),
        K(14.77, OPEN, { s: 0.58 }), K(15.05, OPEN, { s: 0.38, u: 0.76, v: 1.32 }), K(16.5, CLAW, { s: 0.54, u: 0.88, v: 1.3, roll: -0.45, yaw: -0.3 }),
        K(19.0, CLAW, { u: 0.90, v: 1.3 }), K(19.3, OPEN, { u: 0.86, v: 1.27, roll: -0.2, yaw: 0 }), K(19.64, OPEN, { yaw: 0 }), K(19.99, OPEN, { yaw: -3.0 }), K(20.54, OPEN, { yaw: -3.0 }), K(20.89, OPEN, { yaw: 0 }), K(21.3, CLAW, { u: 0.88, v: 1.27, roll: -0.45, yaw: -0.3 }),
        K(21.9, RELAX, { u: 1.0, v: 2.4 }), K(22.2, RELAX, { u: 1.05, v: 3.5, on: 1 }), K(22.25, RELAX, { on: 0 }),
      ],
    },
  };

  return { hand, play, at, local, DEMO, POSES: { OPEN, RELAX, CLAW, FIST, PINCH, POINT }, K, REST };
});
