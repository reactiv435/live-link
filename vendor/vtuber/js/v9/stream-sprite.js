// V9 CABLES, round 7: WHERE the baked stream goes, as numbers (no drawing here: js/v9/fx-quantum-stream.js draws it;
// tests/v9-cables-sprite.test.js runs this in Node on simulated hands).
// Blender renders three loops of liquid light (tools/v9/blender_bake_stream.py -> mask/v9/cables-stream-river.webp, -sphere,
// -burst); this lays them on what the stream is doing (js/v9/quantum-stream.js: its two ends, coil, thickness, the music):
//
//   const sp = VTStreamSprite.create();
//   const L = sp.step(o, { t, dt, au, w, hands })     o = quantum-stream's answer; w = the face's width; hands = [{ x, y, L, k }]
//   L.river   { k, n, P (x, y per station), Nr (its sideways line), half (half width), u (0..1 along the picture), f (which
//               picture of the loop, with a fraction), len, u0 / u1 (the piece of the picture's length it shows) }                hands apart = it is long; together = it goes
//   L.sphere  { k, x, y, r, f, hot }                                         hands together = the coiled ball; a fist = it is the orb
//   L.wraps   [{ k, n, P, Nr, half, u, f, u0, u1 }]                           the liquid that winds round each hand and wrist and curls away (a strip like the river)
//   L.halos   [{ k, x, y, r, f, spin }]                                      the liquid that winds round each hand
//   L.bursts  [{ k, x, y, r, age (0..1) }]                                   a palm push / a drop / a big gift = a splash, played once
//   L.waves   [{ u, k }]                                                     a kick = a bright wave that runs along the river
//   L.swell   the spring every hit kicks (1 = at rest): a hit swells it past its size, it comes back and settles
//   L.bright  how bright all of it is (the music, the charge of the look comes on top in the drawing)
// Everything is bounded and finite whatever comes in (a lost hand, a jump, a 0 or broken dt, numbers that are not numbers).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTStreamSprite = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const N = 33, FR = { river: 48, sphere: 48, burst: 32 };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v), num = (v, d) => (Number.isFinite(v) ? v : d);
  const ss = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const wrap = (v, n) => { v %= n; return v < 0 ? v + n : v; };

  function create() {
    const P = new Float32Array(N * 2), Nr = new Float32Array(N * 2), half = new Float32Array(N), u = new Float32Array(N);
    const st = { fr: 0, fs: 7, fh: 19, bursts: [], waves: [], lastScatter: 0, born: false, half: 0.1, sw: 0, sv: 0, lift: 0 };
    const river = { k: 0, n: N, P, Nr, half, u, f: 0, len: 0, u0: 0, u1: 1 }, sphere = { k: 0, x: 0, y: 0, r: 0.1, f: 0, hot: 0 };
    // (round 8) the liquid WRAPS each hand: a strip that comes off the river, winds once round the hand and wrist, and is
    // flung out as a curled tail (the same baked river, a narrower piece of it)
    const WN = 61, mkWrap = () => ({ k: 0, n: WN, P: new Float32Array(WN * 2), Nr: new Float32Array(WN * 2), half: new Float32Array(WN), u: new Float32Array(WN), f: 0, u0: 0, u1: 1 });
    const wrapPool = [mkWrap(), mkWrap(), mkWrap(), mkWrap()];
    const out = { river, sphere, halos: [], wraps: [], bursts: [], waves: [], bright: 0 };

    function step(o, env) {
      const e = env || {}, t = num(e.t, 0), au = e.au || {}; let dt = num(e.dt, 0); if (!(dt > 0)) dt = 0; if (dt > 0.25) dt = 0.25;
      const level = clamp(num(au.level, 0), 0, 1), bass = clamp(num(au.bass, 0), 0, 1), kickNow = clamp(num(au.kickNow, 0), 0, 1.5);
      const w = clamp(num(e.w, 0.3), 0.03, 3), K = clamp(num(o && o.k, 0), 0, 1);
      const ax = clamp(num(o && o.a && o.a[0], -0.2), -3, 3), ay = clamp(num(o && o.a && o.a[1], 0), -3, 3), bx = clamp(num(o && o.b && o.b[0], 0.2), -3, 3), by = clamp(num(o && o.b && o.b[1], 0), -3, 3);
      const coil = clamp(num(o && o.coil, 0.5), 0, 1), pulse = clamp(num(o && o.pulse, 0), 0, 1.5), orb = clamp(num(o && o.orb, 0), 0, 1), scatter = clamp(num(o && o.scatter, 0), 0, 1), held = clamp(num(o && o.held, 0), 0, 1);
      const ball = clamp(num(o && o.ball, w * 0.42), 0.01, 1.5), thick = clamp(num(o && o.thick, w * 0.1), 0.002, 0.6), flow = num(o && o.flow, 0);
      // ---- what hits it: a kick; a splash (a palm push, a drop, a big gift). NOTHING HERE MOVES IN A STRAIGHT LINE: the
      // stream's size hangs on a SPRING that every hit kicks (it swells past its size, comes back, settles), and a
      // splash is ANNOUNCED: the stream pulls in for a moment (70 ms), then it bursts.
      const ev = (o && o.events) || []; let fire = 0;
      for (const q of ev) if (q === 'burst') fire = Math.max(fire, 1);
      if (scatter > st.lastScatter + 0.30) fire = Math.max(fire, scatter);
      st.lastScatter = scatter;
      if (fire > 0 && K > 0.05) {
        if (st.bursts.length >= 3) st.bursts.shift();
        st.bursts.push({ t0: t + 0.07, x: (ax + bx) / 2, y: (ay + by) / 2, r: clamp(Math.max(Math.hypot(bx - ax, by - ay) * 0.85, w * 1.5) * (0.8 + 0.4 * fire), 0.05, 2.2), s: clamp(fire, 0.3, 1), let: false });
        st.sv -= 7 * fire;                                                           // the pull-in
      }
      for (const b of st.bursts) if (!b.let && t >= b.t0) { b.let = true; st.sv += 15 * b.s; }      // ... and the release
      if (kickNow > 0.12) { if (st.waves.length >= 3) st.waves.shift(); st.waves.push({ t0: t, s: clamp(kickNow, 0, 1.2) }); st.sv += 7.5 * clamp(kickNow, 0, 1.2); }
      for (let left = dt; left > 1e-6;) { const h = Math.min(left, 1 / 120); left -= h; st.sv += (-230 * st.sw - 15 * st.sv) * h; st.sw += st.sv * h; }
      st.sw = clamp(st.sw, -1.5, 2.5); st.sv = clamp(st.sv, -60, 60);
      const swell = clamp(1 + 0.20 * st.sw, 0.62, 1.55);
      // ---- the loops run on the music (they never stand still, they never run away)
      st.fr = wrap(st.fr + dt * (9 + 13 * level + 9 * pulse), FR.river);
      st.fs = wrap(st.fs + dt * (11 + 13 * level + 16 * orb + 8 * pulse), FR.sphere);
      st.fh = wrap(st.fh + dt * (8 + 10 * level), FR.sphere);
      // ---- the river: from a little before one hand to a little past the other, sagging a little, swaying slowly
      let dx = bx - ax, dy = by - ay; const len = Math.hypot(dx, dy) || 1e-6; dx /= len; dy /= len;
      let nx = -dy, ny = dx; if (ny < 0) { nx = -nx; ny = -ny; }                    // its sideways line points up
      const ext = 0.24 + 0.10 * (1 - held), full = len * (1 + 2 * ext);
      const ref = w * 0.40, want = clamp(0.1875 * full, 1.05 * ref, 1.70 * ref) * (0.80 + 2.2 * thick / w) * (1 + 0.5 * scatter);
      st.half = st.born ? st.half + (want - st.half) * (1 - Math.exp(-dt * 10)) : want; st.born = true;
      const hw = clamp(st.half * swell, 0.01, 1.2), sag = -(0.17 * len + 0.10 * w) * held * (0.8 + 0.2 * Math.sin(flow * 0.31)), sway = 0.016 * len;      // it hangs between his hands like a wet rope
      for (let i = 0; i < N; i++) {
        const s = i / (N - 1), uu = -ext + (1 + 2 * ext) * s, mid = Math.sin(Math.PI * clamp(uu, 0, 1));
        const off = sag * mid + sway * mid * Math.sin(uu * 3.3 - flow * 0.9) + 0.4 * sway * Math.sin(uu * 6.1 + flow * 1.3) * mid;
        // a hanging curve between the hands (not a sine: flatter in the middle, steep at the hands); past each hand it lifts and curls up
        const cat = uu <= 0 || uu >= 1 ? 0 : 1 - Math.pow(Math.abs(2 * uu - 1), 2.4), over = uu < 0 ? -uu : uu > 1 ? uu - 1 : 0, lift = 1.9 * over * over * len;
        let px = ax + dx * uu * len + nx * (sag * cat + (off - sag * mid) + lift), py = ay + dy * uu * len + ny * (sag * cat + (off - sag * mid) + lift);
        if (held < 0.999) {
          // no hands: it is a curl in front of the chest (a spiral arm, slowly turning), never a bar
          const cx = (ax + bx) / 2, cy = (ay + by) / 2, th = s * 6.6 + flow * 0.35, rr = w * (0.30 + 0.62 * s) * (1 + 0.10 * Math.sin(s * 9 + flow * 0.5));
          const sx = cx + Math.cos(th) * rr, sy = cy + Math.sin(th) * rr * 0.62;
          px += (sx - px) * (1 - held); py += (sy - py) * (1 - held);
        }
        P[i * 2] = px; P[i * 2 + 1] = py;
        half[i] = hw * (1 + 0.10 * Math.sin(uu * 7.0 - flow * 1.7)) * (1 - (1 - held) * (0.80 - 0.22 * s)) * (1 - 0.55 * Math.min(1, over * 3.2)); u[i] = s;
      }
      for (let i = 0; i < N; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1); let tx = P[i1 * 2] - P[i0 * 2], ty = P[i1 * 2 + 1] - P[i0 * 2 + 1]; const l = Math.hypot(tx, ty) || 1e-6; tx /= l; ty /= l;
        let qx = -ty, qy = tx; if (i === 0 ? qx * nx + qy * ny < 0 : qx * Nr[i * 2 - 2] + qy * Nr[i * 2 - 1] < 0) { qx = -qx; qy = -qy; }      // (it follows the curve: a curl may turn all the way round)
        Nr[i * 2] = qx; Nr[i * 2 + 1] = qy;
      }
      const toBall = ss(0.30, 0.88, coil);
      river.k = K * (1 - toBall) * (1 - 0.55 * scatter); river.f = st.fr; river.len = full;
      { const part = clamp(full / (hw / 0.1875), 0.50, 1); river.u0 = 0.5 - part / 2; river.u1 = 0.5 + part / 2; }      // (which piece of the picture's length it shows)
      // ---- the sphere: the coiled ball at the middle; a fist pulls it tight and makes it the orb
      sphere.k = K * Math.max(ss(0.22, 0.80, coil), 0.85 * orb) * (1 - 0.5 * scatter); sphere.x = (ax + bx) / 2; sphere.y = (ay + by) / 2 + sag * 0.5 * (1 - toBall);
      sphere.r = clamp(ball * 2.15 * (1 - 0.30 * orb) * swell, 0.02, 1.5); sphere.f = st.fs; sphere.hot = clamp(orb * 1.4 + 0.3 * pulse, 0, 2);
      // ---- round each hand: the liquid winds round it
      out.halos.length = 0;
      const hands = Array.isArray(e.hands) ? e.hands : [];
      for (let i = 0; i < hands.length && out.halos.length < 2; i++) {
        const h = hands[i]; if (!h || !Number.isFinite(h.x) || !Number.isFinite(h.y)) continue;
        const hl = clamp(num(h.L, 0.1), 0.02, 0.8);
        out.halos.push({ k: K * clamp(num(h.k, 1), 0, 1) * (0.55 + 0.35 * pulse) * (1 - 0.4 * toBall), x: clamp(h.x, -3, 3), y: clamp(h.y, -3, 3), r: clamp(hl * 1.20 * (0.6 + 0.4 * swell), 0.02, 1.2), f: wrap(st.fh + i * 17, FR.sphere), spin: (i ? -1 : 1) * flow * 0.22 });
      }
      // ---- the wraps: two thin, uneven loops of the liquid round each hand and wrist, each flung out as a curled tail
      out.wraps.length = 0;
      { const hs2 = hands.filter((h) => h && Number.isFinite(h.x) && Number.isFinite(h.y)).slice(0, 2).sort((p, q) => p.x - q.x);
        for (let i = 0; i < hs2.length; i++) for (let q = 0; q < 2; q++) {
          const h = hs2[i], W = wrapPool[i * 2 + q], hl = clamp(num(h.L, 0.1), 0.02, 0.8), sgn = (hs2.length === 1 ? 1 : i === 0 ? -1 : 1) * (q ? -1 : 1);
          const cx = clamp(h.x, -3, 3), cy = clamp(h.y, -3, 3), th0 = (sgn < 0 ? 0 : Math.PI) + q * 2.1 + 0.5 * Math.sin(flow * 0.23 + i + q), tilt = (q ? -0.55 : 0.35) * (i ? 1 : -1), ct = Math.cos(tilt), sn = Math.sin(tilt);
          const r0 = q ? 0.74 : 1.02, sq = q ? 0.52 : 0.70, turns = q ? 7.2 : 8.6;
          for (let j = 0; j < WN; j++) {
            const s = j / (WN - 1), th = th0 - sgn * (s * turns + 0.30 * Math.sin(flow * 0.7 + s * 5 + i + q));
            const open = Math.max(0, s - 0.62) / 0.38, rr = hl * (r0 * (1 + 0.16 * Math.sin(s * 11 + flow * 0.6 + q * 2)) + 1.25 * open * open) * (0.9 + 0.1 * swell);
            const ex = Math.cos(th) * rr, ey = Math.sin(th) * rr * sq;
            W.P[j * 2] = cx + ex * ct - ey * sn; W.P[j * 2 + 1] = cy + ex * sn + ey * ct - 0.12 * hl;
            W.half[j] = clamp(hl * (q ? 0.20 : 0.27) * (1 - 0.6 * open) * (0.65 + 0.35 * Math.sin(s * 13 - flow * 2 + q)), 0.004, 0.6); W.u[j] = s;
          }
          for (let j = 0; j < WN; j++) { const j0 = Math.max(0, j - 1), j1 = Math.min(WN - 1, j + 1); let tx = W.P[j1 * 2] - W.P[j0 * 2], ty = W.P[j1 * 2 + 1] - W.P[j0 * 2 + 1]; const l = Math.hypot(tx, ty) || 1e-6; W.Nr[j * 2] = -ty / l; W.Nr[j * 2 + 1] = tx / l; }
          W.k = K * clamp(num(h.k, 1), 0, 1) * (0.62 + 0.30 * pulse) * (1 - 0.35 * toBall) * (1 - 0.4 * scatter) * (q ? 0.8 : 1); W.f = wrap(st.fr + 13 + i * 21 + q * 9, FR.river); W.u0 = 0.04; W.u1 = 0.96;
          out.wraps.push(W);
        }
      }
      // ---- the splashes that are out (each plays once, about a second, and is gone)
      out.bursts.length = 0;
      for (let i = st.bursts.length - 1; i >= 0; i--) { const b = st.bursts[i], age = (t - b.t0) / 0.95; if (!(age < 1) || !(age > -1)) { st.bursts.splice(i, 1); continue; } if (age >= 0) out.bursts.push({ k: K * b.s, x: b.x, y: b.y, r: b.r, age }); }
      // ---- a kick: a bright wave runs along the river: it leaves fast and slows as it goes (never at one speed), bright at once, fading as it runs
      out.waves.length = 0;
      for (let i = st.waves.length - 1; i >= 0; i--) { const q = st.waves[i], a = (t - q.t0) / 0.55; if (!(a >= 0 && a < 1)) { st.waves.splice(i, 1); continue; } const e = 1 - (1 - a) * (1 - a) * (1 - a); out.waves.push({ u: -0.1 + 1.2 * e, k: q.s * Math.pow(1 - a, 1.5) * Math.min(1, 0.4 + a * 9) }); }
      out.bright = clamp((0.70 + 0.30 * level + 0.25 * bass + 0.20 * pulse) * (1 + 0.30 * clamp(st.sw, -0.6, 1.6)), 0, 2.2); out.swell = swell;
      return out;
    }
    return { step, N, state: st };
  }
  return { create, N, FRAMES: FR };
});
