// V9 CABLES: the stream of energy between his hands, as numbers (no drawing here: js/v9/fx-quantum-stream.js draws it;
// tests/v9-cables-stream.test.js runs this in Node on simulated hands). The cable looks share it (the look picks the
// colours and how it is drawn).
//
//   const qs = VTQuantumStream.create();
//   const o = qs.step(F)        F = the frame object the hands layer gives an effect (js/v9/mask-hands.js): t, dt, c (the
//                               thing between his hands), hands, face { x, y, w }, au, ev; + F.link { burst } from the cables
//   o.a, o.b      the two ends of the stream (frame units: x -A..A, y -1..1, y up)
//   o.held        0 = it floats in front of the chest (no hands), 1 = it is between / on his hands
//   o.coil        0 = a long ribbon from end to end .. 1 = coiled into a sphere (o.ball = its radius) at the middle
//   o.thick       half the ribbon's thickness (the bass swells it)      o.pulse   a kick, decaying
//   o.orb         0..1, the orb a fist charges                          o.strand  { k, x, y }: the strand a pinch pulls out
//   o.scatter     0..1, blown apart (a palm push, a drop, a big gift)   o.drain / o.energy   hands down = it drains into the cables
//   o.drops, o.nDrops   the droplets: DROP numbers each (x, y, vx, vy, age, life, size, kind: 0 bubble, 1 thrown, 2 spark)
//   o.events      what happened this frame: 'drain' (once per draining: the cables take it), 'burst', 'throw'
//
//   hands apart = a long ribbon; together = a sphere; pinch-drag = a strand; a throw flings droplets the way he threw; a
//   fist charges the orb; a palm push scatters it; hands down = it drains; no hands = it floats at the chest, on the music.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTQuantumStream = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const DROP = 8, MAX_DROPS = 420;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const ss = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const ease = (v, to, dt, r) => v + (to - v) * (1 - Math.exp(-dt * r));

  function create({ seed = 0x9e3779b1 } = {}) {
    let sd = seed | 0;
    const rnd = () => { sd = (sd + 0x6d2b79f5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const drops = new Float32Array(MAX_DROPS * DROP);
    const st = { born: false, k: 0, held: 0, a: [0, 0], b: [0, 0], coil: 0.3, thick: 0.02, pulse: 0, orb: 0, strand: { k: 0, x: 0, y: 0 }, scatter: 0, drain: 0, drainTold: false, n: 0, acc: 0, spawned: 0, flow: 0, face: { x: 0, y: 0.4, w: 0.3 }, hitAt: -9 };

    function spawn(x, y, vx, vy, life, size, kind) {
      let i = st.n;
      if (i >= MAX_DROPS) { i = Math.floor(rnd() * MAX_DROPS); } else st.n++;      // full: a new one takes an old one's place
      const d = i * DROP; drops[d] = x; drops[d + 1] = y; drops[d + 2] = vx; drops[d + 3] = vy; drops[d + 4] = 0; drops[d + 5] = life; drops[d + 6] = size; drops[d + 7] = kind;
      st.spawned++;
    }
    /** a point on the stream (0..1 along it), roughly: the ribbon's line or the sphere's shell */
    function along(u, out) {
      const mx = (st.a[0] + st.b[0]) / 2, my = (st.a[1] + st.b[1]) / 2, ball = ballR();
      const lx = st.a[0] + (st.b[0] - st.a[0]) * u, ly = st.a[1] + (st.b[1] - st.a[1]) * u, an = u * 6.283;
      out[0] = lx + (mx + Math.cos(an) * ball - lx) * st.coil; out[1] = ly + (my + Math.sin(an) * ball - ly) * st.coil; return out;
    }
    const ballR = () => st.face.w * (0.42 + 0.18 * st.orb) * (1 + 0.12 * st.pulse);
    const P = [0, 0];

    function step(F) {
      let dt = num(F && F.dt, 0); const t = num(F && F.t, 0);
      if (!(dt > 0)) dt = 0;
      if (dt > 0.5) { dt = 1 / 30; st.n = 0; }                                         // a long gap: the droplets of before are gone
      const au = (F && F.au) || {}, level = clamp(num(au.level, 0), 0, 1), bass = clamp(num(au.bass, 0), 0, 1), high = clamp(num(au.high, 0), 0, 1);
      const kickNow = clamp(num(au.kickNow, 0), 0, 1.5), hitNow = clamp(num(au.hitNow, 0), 0, 1.5);
      const f = F && F.face; if (f && Number.isFinite(f.x) && Number.isFinite(f.y) && f.w > 0.02 && f.w < 3) st.face = { x: f.x, y: f.y, w: f.w };
      const face = st.face, w = face.w, c = (F && F.c) || {}, ev = (F && F.ev) || [], link = (F && F.link) || null, events = [];
      const hands = ((F && F.hands) || []).filter((h) => h && h.on !== false && Number.isFinite(h.x) && Number.isFinite(h.y)).slice(0, 2).sort((p, q) => p.x - q.x);
      // ---- hands down = it drains into the cables; hands up again (or gone) = it flows back
      const low = face.y - 1.9 * w, down = hands.length > 0 && hands.every((h) => h.y < low);
      st.drain = ease(st.drain, down ? 1 : 0, dt, down ? 3.2 : 3.0);
      if (st.drain > 0.5 && !st.drainTold) { st.drainTold = true; events.push('drain'); }
      if (st.drain < 0.2) st.drainTold = false;
      const energy = 1 - st.drain;
      // ---- where its ends are
      st.held = ease(st.held, hands.length ? 1 : 0, dt, 5);
      const chestY = face.y - 1.25 * w, sway = 0.05 * w * Math.sin(t * 0.7);
      let ax, ay, bx, by, coilT;
      if (hands.length >= 2) {
        ax = hands[0].x; ay = hands[0].y; bx = hands[1].x; by = hands[1].y;
        coilT = 1 - ss(0.70, 1.40, Math.hypot(bx - ax, by - ay) / w);
      } else if (hands.length === 1) {
        // one hand: it hangs between the hand and the chest, a loose coil
        const h = hands[0], dx = face.x - h.x, dy = chestY - h.y; ax = h.x; ay = h.y; bx = h.x + dx * 0.55; by = h.y + dy * 0.55; coilT = 0.45;
        if (bx < ax) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; }
      } else { ax = face.x - 0.50 * w + sway; ay = chestY + 0.04 * w * Math.sin(t * 0.9); bx = face.x + 0.50 * w + sway; by = chestY - 0.04 * w * Math.sin(t * 0.9 + 1); coilT = 0.55 + 0.12 * Math.sin(t * 0.33); }
      const r = st.born ? (hands.length ? 16 : 3.5) : 1e6; st.born = true;
      st.a[0] = ease(st.a[0], ax, dt || 1, r); st.a[1] = ease(st.a[1], ay, dt || 1, r); st.b[0] = ease(st.b[0], bx, dt || 1, r); st.b[1] = ease(st.b[1], by, dt || 1, r);
      st.coil = ease(st.coil, coilT, dt, 4.5);
      // ---- the music
      st.pulse = Math.max(st.pulse * Math.exp(-dt * 6), kickNow);
      st.flow += dt * (0.6 + 2.0 * level + 1.2 * st.pulse);
      st.thick = ease(st.thick, w * (0.085 + 0.120 * bass + 0.050 * level), dt, 9);
      // ---- a fist charges the orb
      const charge = clamp(num(c.charge, 0), 0, 1);
      st.orb = c.charging ? ease(st.orb, Math.max(st.orb, charge), dt, 12) : st.orb * Math.exp(-dt * 1.6);
      // ---- a pinch pulls a strand
      const ph = c.grabbing ? hands.find((h) => h.pose === 'pinch') || hands[0] : null;
      if (ph && ph.tip && Number.isFinite(ph.tip[0]) && Number.isFinite(ph.tip[1])) {
        if (st.strand.k < 0.02) { st.strand.x = (st.a[0] + st.b[0]) / 2; st.strand.y = (st.a[1] + st.b[1]) / 2; }
        st.strand.k = ease(st.strand.k, 1, dt, 7); st.strand.x = ease(st.strand.x, ph.tip[0], dt, 20); st.strand.y = ease(st.strand.y, ph.tip[1], dt, 20);
      } else st.strand.k = ease(st.strand.k, 0, dt, 5);
      // ---- what happened
      st.scatter *= Math.exp(-dt * 1.7);
      const mx = (st.a[0] + st.b[0]) / 2, my = (st.a[1] + st.b[1]) / 2;
      for (const e of ev) {
        if (!e) continue;
        if (e.type === 'throw') {
          // droplets fly the way he threw
          let vx = num(c.vx, 0), vy = num(c.vy, 0); const sp = Math.hypot(vx, vy);
          if (sp < 1e-3) { vx = 0; vy = 1; } else { vx /= sp; vy /= sp; }
          const v0 = clamp(sp, 0.5, 2.2), ox = num(c.x, mx), oy = num(c.y, my);
          for (let i = 0; i < 18; i++) { const an = (rnd() - 0.5) * 0.55, cs = Math.cos(an), sn = Math.sin(an), v = v0 * (0.55 + 0.75 * rnd()); spawn(clamp(ox, -2, 2) + (rnd() - 0.5) * 0.06, clamp(oy, -2, 2) + (rnd() - 0.5) * 0.06, (vx * cs - vy * sn) * v, (vx * sn + vy * cs) * v, 0.9 + 0.9 * rnd(), w * (0.030 + 0.055 * rnd() * rnd()), 1); }
          events.push('throw');
        } else if (e.type === 'blast') { st.scatter = Math.max(st.scatter, clamp(0.85 + 0.15 * num(e.power, 1), 0, 1)); ring(22, 0.9); }
      }
      // a drop: it bursts (not more than once in half a second)
      if (hitNow > 0.55 && t - st.hitAt > 0.5) { st.hitAt = t; st.scatter = Math.max(st.scatter, clamp(0.6 + 0.4 * hitNow, 0, 1)); ring(30, 1.1); events.push('burst'); }
      function ring(n, sp) { for (let i = 0; i < n; i++) { const an = rnd() * 6.283, v = sp * (0.35 + 0.8 * rnd()); along(rnd(), P); spawn(P[0], P[1], Math.cos(an) * v, Math.sin(an) * v * 0.8 + 0.15, 0.7 + 0.9 * rnd(), w * (0.022 + 0.06 * rnd() * rnd()), rnd() < 0.55 ? 0 : 2); } }
      // ---- the droplets: the highs fling them off, a gift pours them out
      const burst = clamp(num(link && link.burst, 0), 0, 1.5);
      st.acc += dt * (5 + 30 * high + 62 * burst) * (0.25 + 0.75 * energy);
      while (st.acc >= 1) {
        st.acc -= 1; along(rnd(), P);
        const an = rnd() * 6.283, v = (0.10 + 0.30 * rnd()) * (1 + 1.5 * burst + st.pulse), spark = rnd() < 0.45;
        spawn(P[0] + Math.cos(an) * st.thick, P[1] + Math.sin(an) * st.thick, Math.cos(an) * v, Math.sin(an) * v + 0.08, spark ? 0.35 + 0.5 * rnd() : 1.2 + 1.6 * rnd(), w * (spark ? 0.012 + 0.02 * rnd() : 0.020 + 0.07 * rnd() * rnd()), spark ? 2 : 0);
      }
      for (let i = st.n - 1; i >= 0; i--) {
        const d = i * DROP; drops[d + 4] += dt;
        const gone = drops[d + 4] >= drops[d + 5] || Math.abs(drops[d]) > 2.4 || Math.abs(drops[d + 1]) > 2.4 || !Number.isFinite(drops[d] + drops[d + 1] + drops[d + 2] + drops[d + 3]);
        if (gone) { st.n--; if (i !== st.n) drops.copyWithin(d, st.n * DROP, st.n * DROP + DROP); continue; }
        const kind = drops[d + 7], dr = Math.exp(-dt * (kind === 1 ? 0.9 : kind === 2 ? 2.2 : 1.5));
        drops[d + 2] = clamp(drops[d + 2] * dr, -4, 4); drops[d + 3] = clamp(drops[d + 3] * dr + dt * (kind === 1 ? -0.35 : kind === 2 ? -0.5 : 0.10), -4, 4);      // a thrown drop falls, a bubble floats
        drops[d] += drops[d + 2] * dt; drops[d + 1] += drops[d + 3] * dt;
      }
      st.k = ease(st.k, 1, dt, 2.2);
      return { k: st.k * (0.10 + 0.90 * energy), held: st.held, a: st.a, b: st.b, coil: st.coil, ball: ballR(), thick: st.thick * (1 + 0.45 * st.pulse) * (0.35 + 0.65 * energy), pulse: st.pulse, orb: st.orb, strand: st.strand, scatter: st.scatter, drain: st.drain, energy, flow: st.flow, drops, nDrops: st.n, events, hands: hands.length };
    }
    return { step, spawned: () => st.spawned, along, state: st };
  }
  return { create, DROP, MAX_DROPS };
});
