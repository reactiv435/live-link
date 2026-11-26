// V9 HANDS, effect 1: PARTICLE PLAY ("catch & throw particles"; tile 2 of his "Hand Interaction Effects" sheet).
// A spiral galaxy of particles between his hands, in the colours of his picture (violet, magenta, electric blue, a
// white-pink heart): his pick was "as shown", so the brand's no-purple rule does not apply to this effect.
//   spread the hands  = bigger / smaller          pinch = catch it, drag it, let go fast = THROW it (it flies and comes back)
//   fist = charge (it pulls in, spins up, glows hotter, a ring fills; the music adds charge)
//   palm push = the particles blast out            palm pull = they fly to the hands (magnetize)
//   point = a stream from the fingertip            twist = the spiral unwinds and winds the other way
//   music: kick = pulse, highs = sparkle, a drop = a big burst, quiet = a slow drift
// Registered with mask-hands.js (the framework owns the hands, the buffers and the drawing).
(function (root) {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v), TAU = Math.PI * 2;
  const ss = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const ease = (v, to, dt, r) => v + (to - v) * (1 - Math.exp(-dt * r));
  const WHITE = [1.75, 1.5, 1.8], PINK = [1.7, 0.55, 1.55], MAGENTA = [1.35, 0.22, 1.45], VIOLET = [0.62, 0.26, 1.55], BLUE = [0.22, 0.62, 1.9], CYAN = [0.45, 1.1, 1.9], DEEP = [0.30, 0.12, 0.95];
  const PALETTE = { rim: [1.45, 0.85, 1.95], glow: [0.60, 0.18, 1.5], fill: [0.42, 0.12, 1.0] };
  const N = 7600, ARMS = 4, WIND = 7.2;      // WIND: how far an arm turns from the heart to the rim (radians): a bit more than one turn

  function make({ rnd }) {
    const px = new Float32Array(N), py = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
    const rho = new Float32Array(N), th0 = new Float32Array(N), arm = new Uint8Array(N), tw = new Float32Array(N), sz = new Float32Array(N), free = new Float32Array(N), kind = new Uint8Array(N), hr = new Float32Array(N), ha = new Float32Array(N), lag = new Float32Array(N);
    const col = new Float32Array(N * 3);
    const g = () => { let a = 0; for (let i = 0; i < 4; i++) a += rnd(); return (a - 2) * 1.73; };
    for (let i = 0; i < N; i++) {
      const haze = rnd() < 0.13, core = rnd() < 0.10;
      rho[i] = core ? 0.02 + 0.16 * rnd() * rnd() : haze ? 0.15 + 1.05 * Math.sqrt(rnd()) : 0.10 + 0.95 * Math.pow(rnd(), 0.72);
      arm[i] = rnd() < 0.74 ? (rnd() < 0.5 ? 0 : 2) : (rnd() < 0.5 ? 1 : 3);            // two main arms (blue, magenta) and two fainter ones between them
      th0[i] = haze ? rnd() * TAU : g() * (0.07 + 0.15 * rho[i]) * (arm[i] % 2 ? 0.8 : 1.25);
      tw[i] = rnd() * TAU; lag[i] = rnd();
      sz[i] = (core ? 0.006 : 0.0042) * (0.6 + 0.9 * rnd() * rnd() + (rnd() < 0.03 ? 1.6 : 0));
      kind[i] = rnd() < 0.035 ? 1 : 0;
      hr[i] = 0.25 + 0.85 * Math.sqrt(rnd()); ha[i] = rnd() * TAU;
      const c = core ? WHITE : haze ? (rnd() < 0.5 ? VIOLET : DEEP) : arm[i] === 0 ? (rnd() < 0.3 ? CYAN : BLUE) : arm[i] === 2 ? (rnd() < 0.35 ? PINK : MAGENTA) : (rnd() < 0.5 ? VIOLET : arm[i] === 1 ? MAGENTA : BLUE);
      const w = core ? 1 : Math.max(0, 0.55 - rho[i]) * 0.9, br = (core ? 1.0 : haze ? 0.45 : 0.8) * (0.55 + 0.6 * rnd());
      for (let q = 0; q < 3; q++) col[i * 3 + q] = (c[q] * (1 - w) + WHITE[q] * w) * br;
    }
    const st = { born: false, spin: 0, dirE: 1, mag: 0, ring: -9, ringP: 0, shownK: 0, flash: 0, wisp: [], wispAt: -9, hot: 0 };

    function frame(F) {
      const { t, dt, c, au, hands } = F, K = F.k, R = Math.max(0.02, c.r) * (1 + 0.10 * au.kick + 0.05 * au.bass), cx = c.x, cy = c.y;
      // ---- what happened: blasts, the drop, a reversal
      let blast = 0;
      for (const e of F.ev) {
        if (e.type === 'blast') blast = Math.max(blast, e.power || 1);
        else if (e.type === 'throw') st.flash = Math.max(st.flash, 0.6);
        else if (e.type === 'catch' || e.type === 'grab') st.flash = Math.max(st.flash, 0.45);
        else if (e.type === 'charged') st.flash = 1;
      }
      // the drop: a burst. Not while a gesture has hold of it (grabbed, thrown, charging, magnetized): then it only pulses.
      if (au.hitNow > 0.55 && K > 0.3 && !c.grabbing && !c.flying && !c.charging && c.magnet < 0.2 && t - st.ring > 2.5) blast = Math.max(blast, 0.45 + 0.4 * au.hitNow);
      if (blast > 0) { st.ring = t; st.ringP = blast; st.flash = Math.max(st.flash, 0.8); }
      st.flash = Math.max(0, st.flash - dt * 2.4);
      st.dirE = ease(st.dirE, c.dir, dt, 2.6);                                                // the spiral unwinds through straight and winds the other way
      st.hot = ease(st.hot, c.heat, dt, 6);
      // quiet = a slow drift; loud = it turns; charging = it spins up
      st.spin += dt * c.dir * (0.35 + 1.5 * au.level + 3.2 * st.hot + 0.6 * au.kick) * (c.mode === 'one' ? 1.25 : 1);
      st.mag = c.magnet;
      const tilt = -0.30, ct = Math.cos(tilt), sn = Math.sin(tilt), squash = 0.80;
      const hN = hands.length, kSpring = c.flying ? 70 : 240, damp = c.flying ? 13 : 26;
      if (!st.born && K > 0.01) { for (let i = 0; i < N; i++) { const a = rnd() * TAU, r = R * (0.2 + 2.5 * rnd()); px[i] = cx + Math.cos(a) * r; py[i] = cy + Math.sin(a) * r; vx[i] = 0; vy[i] = 0; } st.born = true; }
      if (K < 0.004) st.born = false;
      const spark = 0.35 + 1.6 * au.high, bright = (0.62 + 0.30 * au.level + 0.55 * au.kick + 0.9 * st.hot + 0.9 * st.flash) * K;
      const wind = WIND * st.dirE;
      for (let i = 0; i < N; i++) {
        // its place in the spiral
        const r0 = rho[i], th = arm[i] * (TAU / ARMS) + st.spin + wind * Math.pow(r0, 0.72) + th0[i] + 0.05 * Math.sin(t * 1.3 + tw[i]);
        const rr = R * r0 * (1 + 0.05 * Math.sin(t * 0.9 + tw[i] * 3));
        const ex = Math.cos(th) * rr, ey = Math.sin(th) * rr * squash;
        let tx = cx + ex * ct - ey * sn, ty = cy + ex * sn + ey * ct;
        // magnetized: its place is a tight swirl on one of his hands instead
        if (st.mag > 0.001 && hN) {
          const h = hands[i % hN], m = ss(lag[i] * 0.55, lag[i] * 0.55 + 0.45, st.mag), a = ha[i] + t * 5.5 * c.dir * (1.4 - hr[i]), q = h.L * 0.85 * hr[i];
          tx += (h.x + Math.cos(a) * q - tx) * m; ty += (h.y + 0.15 * h.L + Math.sin(a) * q * 0.85 - ty) * m;
        }
        if (blast > 0) {
          const dx = px[i] - cx, dy = py[i] - cy, d = Math.hypot(dx, dy) || 1e-4, sp = blast * (0.9 + 2.6 * rnd()) * (0.5 + r0);
          vx[i] += dx / d * sp + (rnd() - 0.5) * 0.5; vy[i] += dy / d * sp + (rnd() - 0.5) * 0.5; free[i] = 0.35 + 0.85 * rnd();
        }
        let ks = kSpring, kd = damp;
        if (free[i] > 0) { free[i] -= dt; const f = ss(0.0, 0.35, free[i]); ks *= 1 - 0.985 * f; kd = damp * (1 - f) + 1.6 * f; }
        const sub = dt > 0.02 ? 2 : 1, h = dt / sub;
        for (let s = 0; s < sub; s++) { vx[i] += ((tx - px[i]) * ks - vx[i] * kd) * h; vy[i] += ((ty - py[i]) * ks - vy[i] * kd) * h; px[i] += vx[i] * h; py[i] += vy[i] * h; }
        const twk = 0.5 + 0.5 * Math.sin(t * (3 + 5 * lag[i]) + tw[i]), star = kind[i] === 1;
        const a = bright * (star ? 0.5 + spark * twk * twk * 1.6 : 0.75 + 0.35 * twk), s = sz[i] * (star ? 3.2 + 3.5 * spark * twk : 1 + 0.5 * au.kick) * (0.75 + 0.5 * Math.min(1, R / 0.14));
        F.point(px[i], py[i], s, col[i * 3], col[i * 3 + 1], col[i * 3 + 2], a, kind[i]);
      }
      // ---- the heart of it: a white-pink core with a wide violet breath
      const calm = 1 - 0.93 * st.mag, hk = K * calm;
      F.point(cx, cy, R * 2.9, VIOLET[0], VIOLET[1], VIOLET[2], hk * (0.20 + 0.12 * au.kick + 0.25 * st.hot), 2);
      F.point(cx, cy, R * 1.5, PINK[0], PINK[1], PINK[2], hk * (0.75 + 0.4 * au.kick + 0.5 * st.hot), 2);
      F.point(cx, cy, R * (0.50 + 0.12 * au.kick + 0.2 * st.hot), WHITE[0], WHITE[1], WHITE[2], hk * (1.1 + 0.8 * st.flash), 2);
      F.point(cx, cy, R * (0.55 + 0.5 * st.flash), WHITE[0], WHITE[1], WHITE[2], hk * 0.8, 1);
      // ---- the arms as bright strokes (they give the spiral its drawn, streaked look); they fade while the particles are out
      const armK = hk * (1 - ss(0.0, 0.5, c.blast)) * (c.flying ? 0.5 : 1);
      if (armK > 0.01) for (let a = 0; a < ARMS; a++) for (let sIdx = 0; sIdx < 3; sIdx++) {
        const main = a % 2 === 0, off = (sIdx - 1) * (main ? 0.20 : 0.10) + 0.06 * Math.sin(t * 0.7 + a + sIdx), CA = a === 0 ? (sIdx === 1 ? CYAN : BLUE) : a === 2 ? (sIdx === 1 ? PINK : MAGENTA) : VIOLET, n = 40, r1 = (main ? 1.0 : 0.72) - 0.12 * sIdx, wK = main ? 3.8 : 1.0, aK = main ? 1.45 : 0.45;
        F.ribbon(n, (i, o) => {
          const r0 = 0.05 + (r1 - 0.05) * (i / (n - 1)), th = a * (TAU / ARMS) + st.spin + wind * Math.pow(r0, 0.72) + off * (0.4 + r0);
          const ex = Math.cos(th) * R * r0, ey = Math.sin(th) * R * r0 * squash; o[0] = cx + ex * ct - ey * sn; o[1] = cy + ex * sn + ey * ct;
        }, (i) => R * (0.050 - 0.030 * (i / (n - 1))) * (sIdx === 1 ? 1.25 : 0.8) * wK,
        (i, o) => { const u = i / (n - 1), w = Math.max(0, 1 - u * 3.2), fl = 0.55 + 0.45 * Math.sin(u * 13 - t * (4 + 2 * au.level) * c.dir + a * 2 + sIdx); o[0] = CA[0] * (1 - w) + WHITE[0] * w; o[1] = CA[1] * (1 - w) + WHITE[1] * w; o[2] = CA[2] * (1 - w) + WHITE[2] * w; o[3] = armK * aK * (sIdx === 1 ? 0.62 : 0.34) * fl * Math.sin(Math.PI * Math.min(1, u * 1.15 + 0.08)) * (0.8 + 0.6 * au.kick); });
      }
      // ---- the charge: a ring that fills round it, and light pulled in
      if (c.charge > 0.02 && K > 0.05) {
        const rr = R * 1.32, n = 72, full = c.charge;
        F.ribbon(n, (i, o) => { const a = Math.PI / 2 - (i / (n - 1)) * TAU; o[0] = cx + Math.cos(a) * rr; o[1] = cy + Math.sin(a) * rr; }, () => R * 0.022, (i, o) => { o[0] = VIOLET[0]; o[1] = VIOLET[1]; o[2] = VIOLET[2]; o[3] = K * 0.20; });
        const m = Math.max(2, Math.round(n * full));
        F.ribbon(m, (i, o) => { const a = Math.PI / 2 - (i / (n - 1)) * TAU; o[0] = cx + Math.cos(a) * rr; o[1] = cy + Math.sin(a) * rr; }, () => R * (0.045 + 0.02 * au.kick), (i, o) => { const hot = full >= 0.999 ? 1 : 0; o[0] = PINK[0] + hot * 0.3; o[1] = PINK[1] + 0.6 * full + hot * 0.4; o[2] = PINK[2] + hot * 0.3; o[3] = K * (0.8 + 0.5 * au.kick); });
        const ea = Math.PI / 2 - full * TAU; F.point(cx + Math.cos(ea) * rr, cy + Math.sin(ea) * rr, R * 0.30, WHITE[0], WHITE[1], WHITE[2], K * 1.2, 1);
      }
      if (c.charging && K > 0.2) for (let q = 0; q < 5; q++) if (rnd() < dt * 60 * (0.5 + c.charge)) { const a = rnd() * TAU, d = R * (2.2 + 1.6 * rnd()), sp = -(1.6 + 2.2 * c.charge) * R * 3; const C2 = rnd() < 0.5 ? PINK : CYAN; F.spark(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.cos(a) * sp, Math.sin(a) * sp, 0.32, 0.007, C2[0], C2[1], C2[2], 0, 0.2, 0); }
      // ---- a blast or the drop: a ring of light running out, and sparks
      const ra = t - st.ring;
      if (ra >= 0 && ra < 0.9) {
        const e = ra / 0.9, rr = R * (1 + 6.5 * st.ringP * (1 - Math.pow(1 - e, 2.6))), n = 80, al = (1 - e) * (1 - e) * st.ringP;
        F.ribbon(n, (i, o) => { const a = (i / (n - 1)) * TAU; o[0] = cx + Math.cos(a) * rr; o[1] = cy + Math.sin(a) * rr * 0.92; }, () => 0.012 + 0.03 * (1 - e), (i, o) => { o[0] = PINK[0]; o[1] = PINK[1] + 0.4; o[2] = PINK[2] + 0.2; o[3] = al * 0.9; });
        if (ra < dt * 1.5) for (let q = 0; q < 260 * st.ringP; q++) { const a = rnd() * TAU, sp = (0.6 + 2.6 * rnd()) * st.ringP, C2 = rnd() < 0.4 ? CYAN : rnd() < 0.5 ? PINK : WHITE; F.spark(cx + Math.cos(a) * R * 0.5, cy + Math.sin(a) * R * 0.5, Math.cos(a) * sp, Math.sin(a) * sp, 0.5 + 0.8 * rnd(), 0.006 + 0.01 * rnd(), C2[0], C2[1], C2[2], rnd() < 0.15 ? 1 : 0, 2.2, -0.3); }
      }
      // ---- thrown: a comet tail
      if (c.flying) for (let q = 0; q < 6; q++) { const a = rnd() * TAU, C2 = rnd() < 0.5 ? BLUE : MAGENTA; F.spark(cx + Math.cos(a) * R * 0.6 * rnd(), cy + Math.sin(a) * R * 0.6 * rnd(), -c.vx * 0.25 + (rnd() - 0.5) * 0.3, -c.vy * 0.25 + (rnd() - 0.5) * 0.3, 0.5 + 0.4 * rnd(), 0.008, C2[0], C2[1], C2[2], rnd() < 0.1 ? 1 : 0, 2, 0); }
      // ---- his hands: wisps from the galaxy to each palm, electric strands and embers licking up off the hand
      if (t - st.wispAt > 0.09) { st.wispAt = t; for (let q = 0; q < 12; q++) st.wisp[q] = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd()]; }
      hands.forEach((h, hi) => {
        const hk2 = h.k * K; if (hk2 < 0.02) return;
        const dx = h.x - cx, dy = h.y - cy, d = Math.hypot(dx, dy) || 1e-4, nx = -dy / d, ny = dx / d;
        if (c.mode === 'two' && d > R * 1.2) for (let w = 0; w < 3; w++) {
          const ph = t * (0.9 + 0.3 * w) + hi * 2.1 + w * 1.7, bow = (0.22 + 0.10 * w) * d * Math.sin(ph) * (w % 2 ? 1 : -1), n = 26, CA = w === 1 ? BLUE : MAGENTA;
          F.ribbon(n, (i, o) => { const u = i / (n - 1), s = R * 0.75 / d + u * (1 - R * 0.75 / d - h.L * 0.35 / d), b = Math.sin(Math.PI * u) * bow + 0.04 * d * Math.sin(u * 9 + ph * 2.3); o[0] = cx + dx * s + nx * b; o[1] = cy + dy * s + ny * b; },
            (i) => 0.006 + 0.008 * Math.sin(Math.PI * i / (n - 1)), (i, o) => { const u = i / (n - 1); o[0] = CA[0]; o[1] = CA[1]; o[2] = CA[2]; o[3] = hk2 * (0.20 + 0.25 * au.level + 0.5 * st.mag + 0.3 * st.hot) * Math.sin(Math.PI * u) * (0.6 + 0.4 * Math.sin(u * 16 - t * 7 * (st.hot > 0.1 ? -1 : 1))); });
        }
        // electric strands rising off the outer side of the hand (re-drawn about 11 times a second, so they crackle)
        const out = Math.sign(h.x - cx) || (h.side > 0 ? -1 : 1);
        for (let w = 0; w < 3; w++) {
          const z = st.wisp[(hi * 5 + w) % 12] || [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], j = [4, 8, 12, 16, 20, 17, 5, 0][Math.floor(z[0] * 8)], sx = h.pts[j * 2], sy = h.pts[j * 2 + 1], len = h.L * (0.5 + 1.1 * z[1]) * (0.7 + 0.8 * au.high + 0.5 * au.kick), n = 14, lean = out * (0.15 + 0.6 * z[2]);
          F.ribbon(n, (i, o) => { const u = i / (n - 1), jag = (Math.sin(u * 19 * (0.5 + z[3]) + z[4] * 40) + Math.sin(u * 47 * (0.5 + z[5]) + z[1] * 17) * 0.7) * 0.16 * h.L * Math.sqrt(u); o[0] = sx + lean * len * u + jag; o[1] = sy + len * u * (0.85 + 0.3 * z[4]) + jag * 0.4; },
            (i) => 0.0045 * (1 - 0.7 * i / (n - 1)) + 0.0015, (i, o) => { const u = i / (n - 1), CA = z[2] < 0.3 ? BLUE : z[2] < 0.75 ? VIOLET : MAGENTA; o[0] = CA[0]; o[1] = CA[1]; o[2] = CA[2]; o[3] = hk2 * (0.16 + 0.5 * au.high + 0.25 * au.kick) * (1 - u) * (0.4 + 0.6 * z[5]); });
        }
        // tendrils of energy licking up off the fingertips and the outer edge (smooth, always moving; they grow with the music)
        for (let w = 0; w < 7; w++) {
          const j = [8, 12, 16, 20, 4, 17, 5][w], sx = h.pts[j * 2], sy = h.pts[j * 2 + 1], ph = t * (1.1 + 0.23 * w) + hi * 3.1 + w * 1.9, len = h.L * (0.75 + 0.55 * Math.sin(ph * 0.7 + w) ** 2 + 0.9 * au.kick + 0.6 * au.high) * (w < 4 ? 1 : 0.8), n = 16, CA = w % 3 === 0 ? MAGENTA : w % 3 === 1 ? VIOLET : BLUE;
          // it leaves along the finger, then turns upward
          const bx = h.pts[j * 2] - h.pts[(j - 1) * 2], by = h.pts[j * 2 + 1] - h.pts[(j - 1) * 2 + 1], bl = Math.hypot(bx, by) || 1e-6;
          F.ribbon(n, (i, o) => { const u = i / (n - 1), up = u * u, wv = Math.sin(u * 7 - ph * 2.2) * 0.10 * h.L * u + Math.sin(u * 15 + ph * 3.1) * 0.035 * h.L * u; o[0] = sx + (bx / bl) * len * 0.45 * u * (1 - up) + out * 0.10 * len * up + wv; o[1] = sy + (by / bl) * len * 0.45 * u * (1 - up) + len * (0.25 * u + 0.75 * up); },
            (i) => 0.0085 * (1 - i / (n - 1)) + 0.0015, (i, o) => { const u = i / (n - 1); o[0] = CA[0] * (1 - u * 0.4) + WHITE[0] * 0.25 * (1 - u); o[1] = CA[1] * (1 - u * 0.4) + WHITE[1] * 0.25 * (1 - u); o[2] = CA[2]; o[3] = hk2 * (0.42 + 0.5 * au.level + 0.4 * au.kick) * Math.pow(1 - u, 1.3) * (0.7 + 0.3 * Math.sin(u * 9 - ph * 4)); });
          if (rnd() < dt * 9) F.spark(sx, sy, out * 0.05 + (rnd() - 0.5) * 0.08, 0.25 + 0.3 * rnd(), 0.6 + 0.6 * rnd(), 0.006, CA[0], CA[1], CA[2], rnd() < 0.2 ? 1 : 0, 1.0, 0.15);
        }
        const rate = (26 + 90 * au.level + 120 * au.high + 200 * Math.min(1, Math.hypot(h.vx, h.vy))) * hk2;
        for (let q = 0, m = rate * dt + (rnd() < (rate * dt) % 1 ? 1 : 0); q < Math.floor(m); q++) {
          const j = Math.floor(rnd() * 21), C2 = rnd() < 0.25 ? BLUE : rnd() < 0.6 ? VIOLET : MAGENTA;
          F.spark(h.pts[j * 2] + (rnd() - 0.5) * h.L * 0.25, h.pts[j * 2 + 1] + (rnd() - 0.5) * h.L * 0.25, out * (0.02 + 0.10 * rnd()) + h.vx * 0.3, 0.05 + 0.25 * rnd() + h.vy * 0.3, 0.7 + 1.3 * rnd(), 0.0045 + 0.006 * rnd() * rnd(), C2[0], C2[1], C2[2], rnd() < 0.06 ? 1 : 0, 0.9, 0.10);
        }
        // a small swirl held in the palm (his picture has one)
        F.point(h.x, h.y + 0.1 * h.L, h.L * (1.5 + 0.5 * st.mag), MAGENTA[0], MAGENTA[1], MAGENTA[2], hk2 * (0.10 + 0.10 * au.kick + 0.35 * st.mag), 2);
      });
      // ---- a thin wisp drawn up to the Mask's chin (his picture has one): the face breathes it in
      if (c.mode === 'two' && K > 0.3 && !c.flying && F.face) {
        const fx = F.face.x + 0.10 * F.face.w, fy = F.face.y - 0.42 * F.face.w, dx = fx - cx, dy = fy - cy, d = Math.hypot(dx, dy) || 1e-4, n = 30;
        if (d > R * 1.1) F.ribbon(n, (i, o) => { const u = i / (n - 1), s0 = R * 0.9 / d, s = s0 + u * (1 - s0), b = Math.sin(Math.PI * u) * 0.22 * d * Math.sin(t * 0.6) + 0.03 * Math.sin(u * 11 - t * 3); o[0] = cx + dx * s - dy / d * b; o[1] = cy + dy * s + dx / d * b; },
          (i) => 0.004 + 0.006 * Math.sin(Math.PI * i / (n - 1)), (i, o) => { const u = i / (n - 1); o[0] = MAGENTA[0]; o[1] = MAGENTA[1]; o[2] = MAGENTA[2]; o[3] = K * calm * (0.16 + 0.25 * au.level) * Math.sin(Math.PI * u) * (0.5 + 0.5 * Math.sin(u * 14 - t * 5)); });
      }
      // ---- point: a stream out of the fingertip (the galaxy feeds it)
      if (c.beam && c.beamK > 0.02) {
        const b = c.beam, bx = b.tip[0], by = b.tip[1], ux = b.dir[0], uy = b.dir[1], len = 2.4, n = 30, bk = c.beamK * K;
        for (let w = 0; w < 3; w++) F.ribbon(n, (i, o) => { const u = i / (n - 1), wob = Math.sin(u * 14 - t * 16 + w * 2.1) * 0.012 * (0.3 + u) * (w ? 2.2 : 0.5); o[0] = bx + ux * len * u - uy * wob; o[1] = by + uy * len * u + ux * wob; },
          (i) => (w ? 0.006 : 0.013 + 0.01 * au.kick) * (1 - 0.5 * i / (n - 1)), (i, o) => { const u = i / (n - 1), CA = w === 0 ? WHITE : w === 1 ? CYAN : MAGENTA; o[0] = CA[0]; o[1] = CA[1]; o[2] = CA[2]; o[3] = bk * (w ? 0.5 : 0.9) * (1 - u * 0.75) * (0.75 + 0.5 * au.level); });
        F.point(bx, by, 0.10 + 0.05 * au.kick, WHITE[0], WHITE[1], WHITE[2], bk * 1.3, 1); F.point(bx, by, 0.22, CYAN[0], CYAN[1], CYAN[2], bk * 0.5, 2);
        for (let q = 0; q < 9; q++) { const sp = 1.6 + 2.2 * rnd(), sd = (rnd() - 0.5) * 0.35, C2 = rnd() < 0.4 ? CYAN : rnd() < 0.6 ? PINK : WHITE; F.spark(bx, by, ux * sp - uy * sd, uy * sp + ux * sd, 0.35 + 0.5 * rnd(), 0.006 + 0.007 * rnd(), C2[0], C2[1], C2[2], rnd() < 0.12 ? 1 : 0, 0.8, 0); }
        // the feed: from the galaxy into the hand
        const n2 = 22; F.ribbon(n2, (i, o) => { const u = i / (n2 - 1), bow = Math.sin(Math.PI * u) * 0.08 * Math.sin(t * 3); o[0] = cx + (b.x - cx) * u - (b.y - cy) * bow; o[1] = cy + (b.y - cy) * u + (b.x - cx) * bow; }, () => 0.007, (i, o) => { const u = i / (n2 - 1); o[0] = PINK[0]; o[1] = PINK[1]; o[2] = PINK[2]; o[3] = bk * 0.5 * Math.sin(Math.PI * u) * (0.6 + 0.4 * Math.sin(u * 20 - t * 18)); });
      }
      return PALETTE;
    }
    return { palette: PALETTE, frame };
  }
  if (!root.VTMaskHands) throw new Error('hands-particle-play: js/v9/mask-hands.js must be loaded first');
  root.VTMaskHands.register('particle-play', make);
})(typeof globalThis !== 'undefined' ? globalThis : self);
