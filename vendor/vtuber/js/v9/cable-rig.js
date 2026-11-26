// V9 CABLES: the cable rig. Pure numbers (Node can run it; tests/v9-cables-rig.test.js), shared by every cable look
// (Quantum Flow, Matrix Link, Cyber Core: the look only picks the colours).
//
// A cable is a rope of NODES points with weight. Its first point is pinned to a SOCKET on the head (head space: his eye
// distance = 1, eyes at y = 0, +z toward the camera; the same space mask-v9.js draws the cranium in). Every other point
// is pulled toward the cable's REST SHAPE (stiff near the socket, loose at the tip), carries its own speed, and is held
// at its distance from the one before it: so a cable SWINGS when the head turns and settles afterwards. The far part of
// a cable hangs in the room, not on the head: it follows the head's turn left / right but stays upright when he tilts.
//
//   const rig = VTCableRig.create({ cables: VTCableRig.layout() });
//   rig.step(t, dt, model, { grow, bass, level, calm, slack, tight })   model = the head's 4 x 4 (mask-gl M4.trs) or null (= hold the last)
//                                slack 0..1 = the cables hang heavy (asleep); tight 0..1 = they are drawn taut (0 / absent = as always)
//   rig.pos                      Float32Array(count * nodes * 4): world x, y, z, 0 per node  (-> one data texture)
//   rig.kick(t, s)               the music: a packet of light from the head outward on every cable, one after another
//   rig.drop(t, s)               a surge (every cable lit end to end) + one whip
//   rig.tap(t, r01) -> cable     chat: one spark runs IN along one cable (toward the head, into the stream)
//   rig.gift(t, coins)           a burst sized by the gift (small = a few cables, big = all of them + a surge)
//   rig.drain(t)                 the stream drains into the cables: light runs in on all of them
//   rig.packets(cable, t)        [{ u (0 = socket .. 1 = tip), s, inward }]      rig.surge(cable, t)   rig.burst(t)
//   rig.glow(cable, t, audio)    rig.width(cable, audio)    rig.lit(cable, hypeRank)
// Nothing a tracker can do makes it explode: no face = the last head is held; a jump = the rope is carried along; a 0,
// negative or broken dt = nothing moves; a huge dt = it is laid back in its rest shape; every point is kept within the
// cable's length of its socket and outside the head.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTCableRig = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const NODES = 16;
  const SKULL = { c: [0, 0.12, -0.92], r: [1.10, 1.42, 1.26] };       // mask-v9.js's cranium
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const mulberry = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  /** a point on the cranium (a little outside it) from two angles: az (0 = his front, + = toward +x), el (0 = the equator, pi/2 = the top) */
  function onSkull(az, el, out = 1.0) {
    const d = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    return { p: [SKULL.c[0] + d[0] * SKULL.r[0] * out, SKULL.c[1] + d[1] * SKULL.r[1] * out, SKULL.c[2] + d[2] * SKULL.r[2] * out], n: norm([d[0] / SKULL.r[0], d[1] / SKULL.r[1], d[2] / SKULL.r[2]]) };
  }
  /**
   * The cables of the look (his tile: two bundles from the crown, violet to his right = the picture's left, gold to the
   * other side, long wavy ones from behind the ears, a few that fall past the shoulders). hue 0 / 1 = the look's two
   * colours; sheath = a clear tube with the light inside; order = when the hype lights it (0 first).
   * side: -1 = the picture's left (x < 0), +1 = the right.
   */
  function layout(seed = 20261125) {
    const rnd = mulberry(seed), out = [];
    const add = (side, az, el, fall, len, r, hue, o = {}) => {
      const s = onSkull(side * az, el, 1.02), dir = norm([s.n[0] + (o.lean ? o.lean[0] * side : 0), s.n[1] + (o.lean ? o.lean[1] : 0), s.n[2] + (o.lean ? o.lean[2] : 0)]);
      out.push({ socket: s.p, dir, fall: norm([fall[0] * side, fall[1], fall[2]]), len, r: r * 0.62, hue, side, sheath: !!o.sheath, wave: o.wave === undefined ? 0.22 : o.wave, freq: o.freq || 1.6, phase: rnd() * 6.283, curl: o.curl || 0.5, group: o.group || 'crown' });
    };
    for (const side of [-1, 1]) {
      const main = side < 0 ? 0 : 1, other = 1 - main;
      // the crown bundle: up and out, then over and away, a fan of arcs
      add(side, 0.55, 1.12, [1.0, 0.55, 0.10], 5.2, 0.105, main, { sheath: true, wave: 0.30, freq: 1.3, lean: [0.3, 0.9, 0] });
      add(side, 0.95, 0.98, [1.0, 0.25, 0.20], 5.0, 0.085, main, { wave: 0.26, freq: 1.7, lean: [0.5, 0.7, 0] });
      add(side, 1.30, 0.92, [1.0, 0.02, 0.05], 4.6, 0.075, main, { wave: 0.34, freq: 2.0, lean: [0.6, 0.5, 0] });
      add(side, 0.30, 1.28, [0.8, 0.95, -0.1], 4.6, 0.060, other, { wave: 0.20, freq: 1.5, lean: [0.2, 1.0, 0] });
      add(side, 1.75, 1.05, [1.0, 0.40, -0.35], 4.8, 0.070, main, { sheath: true, wave: 0.24, freq: 1.2, lean: [0.5, 0.8, -0.2] });
      add(side, 2.30, 0.95, [0.9, 0.15, -0.6], 4.4, 0.055, main, { wave: 0.30, freq: 1.9, lean: [0.4, 0.6, -0.4] });
      // from behind the ears: long, almost level, wavy
      add(side, 1.62, 0.22, [1.0, 0.10, 0.25], 4.8, 0.090, main, { sheath: true, wave: 0.36, freq: 2.2, group: 'ear', lean: [0.8, 0.25, 0] });
      add(side, 1.80, 0.05, [1.0, -0.12, 0.20], 4.6, 0.065, other, { wave: 0.32, freq: 2.6, group: 'ear', lean: [0.8, 0.0, 0] });
      add(side, 1.95, 0.36, [1.0, 0.22, -0.2], 4.4, 0.050, main, { wave: 0.28, freq: 2.4, group: 'ear', lean: [0.8, 0.3, -0.2] });
      // and the ones that fall: past the jaw, in front of the shoulders
      add(side, 1.70, -0.30, [0.50, -1.0, 0.55], 4.6, 0.085, main, { sheath: true, wave: 0.30, freq: 1.5, group: 'fall', lean: [0.9, -0.2, 0.2] });
      add(side, 2.05, -0.42, [0.75, -1.0, 0.30], 4.2, 0.060, other, { wave: 0.34, freq: 2.1, group: 'fall', lean: [0.9, -0.3, 0] });
      add(side, 2.45, -0.20, [0.95, -0.7, -0.1], 4.4, 0.050, main, { wave: 0.26, freq: 1.8, group: 'fall', lean: [0.7, -0.2, -0.4] });
      // thin ones between them: the bundle is a tangle, not a row
      add(side, 0.75, 1.20, [0.9, 0.75, 0.0], 5.6, 0.050, other, { wave: 0.40, freq: 2.4, lean: [0.4, 0.9, 0] });
      add(side, 1.15, 1.05, [1.0, 0.35, 0.1], 5.4, 0.046, main, { wave: 0.42, freq: 2.8, lean: [0.5, 0.6, 0] });
      add(side, 2.15, 1.15, [0.9, 0.6, -0.4], 5.0, 0.048, other, { wave: 0.36, freq: 2.2, lean: [0.4, 0.8, -0.3] });
      add(side, 1.50, 0.60, [1.0, 0.15, 0.15], 5.2, 0.048, other, { wave: 0.45, freq: 3.0, group: 'ear', lean: [0.8, 0.3, 0] });
      add(side, 1.72, 0.12, [1.0, -0.3, 0.3], 5.0, 0.044, main, { wave: 0.40, freq: 2.7, group: 'ear', lean: [0.8, 0.1, 0.1] });
      add(side, 1.85, -0.36, [0.6, -1.0, 0.45], 5.0, 0.046, main, { wave: 0.40, freq: 2.3, group: 'fall', lean: [0.9, -0.3, 0.1] });
    }
    // the order the hype lights them in: the thick ones of both sides first
    const idx = out.map((c, i) => i).sort((a, b) => out[b].r - out[a].r || a - b);
    idx.forEach((i, k) => { out[i].order = k / (out.length - 1); });
    return out;
  }

  /** the rest shape of a cable: NODES points in head space. It leaves along `dir`, bends over toward `fall`, and waves. */
  function restShape(c, nodes = NODES) {
    const pts = new Float32Array(nodes * 3), seg = c.len / (nodes - 1); let p = c.socket.slice();
    const side = norm([c.fall[1] * c.dir[2] - c.fall[2] * c.dir[1] + 1e-4, c.fall[2] * c.dir[0] - c.fall[0] * c.dir[2] + 1e-4, c.fall[0] * c.dir[1] - c.fall[1] * c.dir[0] + 1e-4]);
    const up2 = norm([side[1] * c.fall[2] - side[2] * c.fall[1], side[2] * c.fall[0] - side[0] * c.fall[2], side[0] * c.fall[1] - side[1] * c.fall[0]]);
    pts.set(p, 0);
    for (let i = 1; i < nodes; i++) {
      const u = i / (nodes - 1), k = Math.pow(clamp(u / c.curl, 0, 1), 1.4), w = c.wave * Math.min(1, u * 3), a = u * c.freq * 6.283 + c.phase;
      // further out the cable sinks (it has weight)
      const sag = -0.55 * u * u;
      const d = norm([c.dir[0] * (1 - k) + c.fall[0] * k + (side[0] * Math.cos(a) + up2[0] * Math.sin(a * 0.7)) * w * 2.2, c.dir[1] * (1 - k) + c.fall[1] * k + sag + (side[1] * Math.cos(a) + up2[1] * Math.sin(a * 0.7)) * w * 2.2, c.dir[2] * (1 - k) + c.fall[2] * k + (side[2] * Math.cos(a) + up2[2] * Math.sin(a * 0.7)) * w * 2.2]);
      p = [p[0] + d[0] * seg, p[1] + d[1] * seg, p[2] + d[2] * seg];
      // never through the head
      const q = Math.hypot((p[0] - SKULL.c[0]) / SKULL.r[0], (p[1] - SKULL.c[1]) / SKULL.r[1], (p[2] - SKULL.c[2]) / SKULL.r[2]);
      if (q < 1.06) { const f = 1.06 / Math.max(q, 1e-3); p = [SKULL.c[0] + (p[0] - SKULL.c[0]) * f, SKULL.c[1] + (p[1] - SKULL.c[1]) * f, SKULL.c[2] + (p[2] - SKULL.c[2]) * f]; }
      pts.set(p, i * 3);
    }
    return pts;
  }

  function create({ cables = layout(), nodes = NODES } = {}) {
    const count = cables.length, pos = new Float32Array(count * nodes * 4), prev = new Float32Array(count * nodes * 3), tgt = new Float32Array(3);
    const rest = cables.map((c) => restShape(c, nodes));
    const order = cables.map((c, i) => i).sort((a, b) => ((a * 7919 + 13) % count) - ((b * 7919 + 13) % count));      // the order a kick runs through them
    const rank = new Array(count); order.forEach((c, k) => { rank[c] = k; });
    const st = { model: null, s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], T: [0, 0, 0], yaw: 0, has: false, grow: 0, kicks: [], drops: [], taps: [], gifts: [], whips: [], drains: [], lastRoot: new Float32Array(count * 3) };

    /** the rest shape at `grow` (0 = everything in the socket, 1 = all of it out): the cable is paid out along its own curve */
    function restAt(c, i, grow, out) {
      const R = rest[c], f = clamp(grow, 0, 1) * i, i0 = Math.min(nodes - 2, Math.floor(f)), k = f - i0;
      out[0] = R[i0 * 3] + (R[i0 * 3 + 3] - R[i0 * 3]) * k; out[1] = R[i0 * 3 + 1] + (R[i0 * 3 + 4] - R[i0 * 3 + 1]) * k; out[2] = R[i0 * 3 + 2] + (R[i0 * 3 + 5] - R[i0 * 3 + 2]) * k;
      return out;
    }
    const L3 = [0, 0, 0];
    /** where node i of cable c wants to be, in the world: near the socket it turns with the head, far out it only follows the head's turn left / right */
    function target(c, i, out) {
      restAt(c, i, st.grow, L3);
      const S = cables[c].socket, dx = L3[0] - S[0], dy = L3[1] - S[1], dz = L3[2] - S[2], R = st.R, s = st.s;
      const ax = R[0] * dx + R[1] * dy + R[2] * dz, ay = R[3] * dx + R[4] * dy + R[5] * dz, az = R[6] * dx + R[7] * dy + R[8] * dz;
      const cy = Math.cos(st.yaw), sy = Math.sin(st.yaw), bx = cy * dx + sy * dz, by = dy, bz = -sy * dx + cy * dz;
      const w = 0.8 * Math.pow(i / (nodes - 1), 1.3);
      const rx = R[0] * S[0] + R[1] * S[1] + R[2] * S[2], ry = R[3] * S[0] + R[4] * S[1] + R[5] * S[2], rz = R[6] * S[0] + R[7] * S[1] + R[8] * S[2];
      out[0] = st.T[0] + s * (rx + ax + (bx - ax) * w); out[1] = st.T[1] + s * (ry + ay + (by - ay) * w); out[2] = st.T[2] + s * (rz + az + (bz - az) * w);
      return out;
    }
    function setModel(m) {
      if (!m || m.length < 16) return false;
      for (let k = 0; k < 16; k++) if (!Number.isFinite(m[k])) return false;
      const s = Math.hypot(m[0], m[1], m[2]); if (!(s > 1e-4) || s > 1e3) return false;
      st.s = s; st.R = [m[0] / s, m[4] / s, m[8] / s, m[1] / s, m[5] / s, m[9] / s, m[2] / s, m[6] / s, m[10] / s]; st.T = [m[12], m[13], m[14]];
      st.yaw = Math.atan2(st.R[2], st.R[8]);            // where the head's forward (+z) points, round the world's up
      st.model = m; return true;
    }
    function lay() { for (let c = 0; c < count; c++) for (let i = 0; i < nodes; i++) { target(c, i, tgt); const o = (c * nodes + i) * 4, q = (c * nodes + i) * 3; pos[o] = prev[q] = tgt[0]; pos[o + 1] = prev[q + 1] = tgt[1]; pos[o + 2] = prev[q + 2] = tgt[2]; } }
    function keep(c) {
      // each point at its distance from the one before; outside the head; within the cable's length of the socket
      const C = cables[c], seg = C.len * st.grow * st.s / (nodes - 1), o0 = c * nodes * 4, R = st.R, s = st.s, T = st.T, maxD = C.len * s * 1.2;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < nodes; i++) {
          const a = o0 + (i - 1) * 4, b = o0 + i * 4; let dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2]; const l = Math.hypot(dx, dy, dz);
          if (l > 1e-9) { const f = seg / l; pos[b] = pos[a] + dx * f; pos[b + 1] = pos[a + 1] + dy * f; pos[b + 2] = pos[a + 2] + dz * f; } else { pos[b] = pos[a]; pos[b + 1] = pos[a + 1] + seg; pos[b + 2] = pos[a + 2]; }
          if (i >= 2 && st.grow > 0.05) {
            // into head space, out of the cranium, back
            const wx = (pos[b] - T[0]) / s, wy = (pos[b + 1] - T[1]) / s, wz = (pos[b + 2] - T[2]) / s;
            const hx = R[0] * wx + R[3] * wy + R[6] * wz - SKULL.c[0], hy = R[1] * wx + R[4] * wy + R[7] * wz - SKULL.c[1], hz = R[2] * wx + R[5] * wy + R[8] * wz - SKULL.c[2];
            const q = Math.hypot(hx / SKULL.r[0], hy / SKULL.r[1], hz / SKULL.r[2]);
            if (q < 1.0 && q > 1e-6) { const f = 1.0 / q, px = SKULL.c[0] + hx * f, py = SKULL.c[1] + hy * f, pz = SKULL.c[2] + hz * f; pos[b] = T[0] + s * (R[0] * px + R[1] * py + R[2] * pz); pos[b + 1] = T[1] + s * (R[3] * px + R[4] * py + R[5] * pz); pos[b + 2] = T[2] + s * (R[6] * px + R[7] * py + R[8] * pz); }
          }
        }
      }
      for (let i = 1; i < nodes; i++) {
        const b = o0 + i * 4, dx = pos[b] - pos[o0], dy = pos[b + 1] - pos[o0 + 1], dz = pos[b + 2] - pos[o0 + 2], l = Math.hypot(dx, dy, dz);
        if (l > maxD) { const f = maxD / l; pos[b] = pos[o0] + dx * f; pos[b + 1] = pos[o0 + 1] + dy * f; pos[b + 2] = pos[o0 + 2] + dz * f; }
      }
    }

    function step(t, dt, model, o = {}) {
      const first = !st.has, grow = clamp(Number.isFinite(o.grow) ? o.grow : 1, 0, 1);
      if (setModel(model)) st.has = true;
      if (!st.has) return;
      const growWas = st.grow; st.grow = grow;
      if (first || !(dt < 0.5)) { if (first || dt >= 0.5) lay(); if (!(dt > 0)) pin(); return; }      // a huge dt: laid back in its rest shape. A broken dt: nothing moves.
      if (!(dt > 0)) { pin(); return; }
      const n = Math.max(1, Math.min(6, Math.ceil(dt / (1 / 60)))), h = Math.min(dt, 0.1) / n, bass = clamp(o.bass || 0, 0, 1), level = clamp(o.level || 0, 0, 1), calm = !!o.calm;
      const slack = clamp(o.slack || 0, 0, 1), tight = clamp(o.tight || 0, 0, 1);        // (countdown 2.0: both 0 unless it asks)
      const damp = Math.exp(-h * 3.4);
      // a whip waiting to be given
      let whipS = 0; for (const w of st.whips) if (!w.done) { whipS = Math.max(whipS, w.s); w.done = true; }
      for (let c = 0; c < count; c++) {
        const o0 = c * nodes * 4, q0 = c * nodes * 3, C = cables[c];
        // the socket: where the head puts it. A jump (a new face somewhere else) carries the whole rope along.
        target(c, 0, tgt);
        const jx = tgt[0] - pos[o0], jy = tgt[1] - pos[o0 + 1], jz = tgt[2] - pos[o0 + 2], jump = Math.hypot(jx, jy, jz);
        if (jump > 0.9 * st.s) for (let i = 1; i < nodes; i++) { pos[o0 + i * 4] += jx; pos[o0 + i * 4 + 1] += jy; pos[o0 + i * 4 + 2] += jz; prev[q0 + i * 3] += jx; prev[q0 + i * 3 + 1] += jy; prev[q0 + i * 3 + 2] += jz; }
        if (whipS > 0) {
          // one whip: every point is thrown away from the head, the tip the most
          const ws = Math.min(whipS, 1.5) * 3.2 * st.s;
          for (let i = 1; i < nodes; i++) { const u = i / (nodes - 1), b = o0 + i * 4; let dx = pos[b] - st.T[0], dy = pos[b + 1] - st.T[1] + 0.4, dz = pos[b + 2] - st.T[2]; const l = Math.hypot(dx, dy, dz) || 1; const v = ws * u * (0.7 + 0.6 * Math.sin(c * 2.4 + i)) * h; prev[q0 + i * 3] -= dx / l * v; prev[q0 + i * 3 + 1] -= (dy / l * 0.6 + 0.5) * v; prev[q0 + i * 3 + 2] -= dz / l * v; }
        }
        for (let sub = 0; sub < n; sub++) {
          const tt = t - dt + (sub + 1) * h;
          pos[o0] = tgt[0]; pos[o0 + 1] = tgt[1]; pos[o0 + 2] = tgt[2]; prev[q0] = tgt[0]; prev[q0 + 1] = tgt[1]; prev[q0 + 2] = tgt[2];
          for (let i = 1; i < nodes; i++) {
            const b = o0 + i * 4, q = q0 + i * 3, u = i / (nodes - 1);
            target(c, i, L3);
            const k = (11 + 420 * Math.pow(1 - u, 3.2)) * (1 + 2.5 * tight);        // stiff at the socket, loose at the tip (taut: stiffer all along)
            const ex = L3[0] - pos[b], ey = L3[1] - pos[b + 1], ez = L3[2] - pos[b + 2], far = (ex * ex + ey * ey + ez * ez) / (st.s * st.s), kk = k * (1 + far * 0.7);      // far from home it is pulled harder: a cable never stays hung up on the head
            let ax = kk * ex, ay = kk * ey - slack * 30 * Math.pow(u, 1.2) * st.s, az = kk * ez;      // (slack: its weight pulls it down)
            if (!calm) {
              // it is alive: a slow float, more with the song
              const amp = (0.5 + 1.6 * level + 1.4 * bass) * u * st.s * (1 - 0.75 * tight) * (1 - 0.6 * slack), ph = C.phase + i * 0.55;
              ax += amp * Math.sin(tt * 0.9 + ph); ay += amp * 0.8 * Math.sin(tt * 1.13 + ph * 1.7 + 1.0); az += amp * 0.7 * Math.sin(tt * 0.71 + ph * 0.6 + 2.0);
            }
            let vx = (pos[b] - prev[q]) * damp, vy = (pos[b + 1] - prev[q + 1]) * damp, vz = (pos[b + 2] - prev[q + 2]) * damp;
            const vm = Math.hypot(vx, vy, vz), vmax = 14 * st.s * h; if (vm > vmax) { const f = vmax / vm; vx *= f; vy *= f; vz *= f; }
            prev[q] = pos[b]; prev[q + 1] = pos[b + 1]; prev[q + 2] = pos[b + 2];
            pos[b] += vx + ax * h * h; pos[b + 1] += vy + ay * h * h; pos[b + 2] += vz + az * h * h;
          }
          keep(c);
        }
        // anything that is not a number: this cable is laid back in its rest shape
        let ok = true; for (let i = 0; i < nodes && ok; i++) { const b = o0 + i * 4; if (!Number.isFinite(pos[b] + pos[b + 1] + pos[b + 2])) ok = false; }
        if (!ok) for (let i = 0; i < nodes; i++) { target(c, i, tgt); const b = o0 + i * 4, q = q0 + i * 3; pos[b] = prev[q] = tgt[0]; pos[b + 1] = prev[q + 1] = tgt[1]; pos[b + 2] = prev[q + 2] = tgt[2]; }
      }
      if (growWas !== grow && grow <= 0) lay();
      const cut = (a, age) => { while (a.length && t - a[0].t > age) a.shift(); };
      cut(st.kicks, 3); cut(st.drops, 8); cut(st.taps, 3); cut(st.gifts, 8); cut(st.whips, 1); cut(st.drains, 3);
    }
    /** the sockets are put where the head has them, the ropes are kept sane; nothing else moves */
    function pin() { for (let c = 0; c < count; c++) { target(c, 0, tgt); const o0 = c * nodes * 4, jx = tgt[0] - pos[o0], jy = tgt[1] - pos[o0 + 1], jz = tgt[2] - pos[o0 + 2]; for (let i = 0; i < nodes; i++) { const b = o0 + i * 4, q = (c * nodes + i) * 3; pos[b] += jx; pos[b + 1] += jy; pos[b + 2] += jz; prev[q] = pos[b]; prev[q + 1] = pos[b + 1]; prev[q + 2] = pos[b + 2]; } keep(c); } }

    // ------------------------------------------------------------------ the light that travels
    const KICK_STAGGER = 0.30, KICK_RUN = 0.55;
    function kick(t, s) { st.kicks.push({ t, s: clamp(s, 0, 1.5) }); if (st.kicks.length > 8) st.kicks.shift(); }
    function whip(t, s) { st.whips.push({ t, s: clamp(Number(s) || 0, 0, 1.5), done: false }); }
    function drop(t, s) { st.drops.push({ t, s: clamp(s, 0, 1.5) }); whip(t, s); }
    function tap(t, r01) { const c = Math.min(count - 1, Math.floor(clamp(r01, 0, 0.999999) * count)); st.taps.push({ t, c }); if (st.taps.length > 24) st.taps.shift(); return c; }
    function gift(t, coins) {
      const size = clamp(Math.log10(Math.max(1, Number(coins) || 1) + 1) / 3.7, 0.15, 1), all = size >= 0.8, n = all ? count : Math.max(2, Math.round(count * (0.10 + 0.45 * size)));
      st.gifts.push({ t, size, n, all, seed: Math.floor(t * 131) % count });
      if (all) st.drops.push({ t, s: size });
      return size;
    }
    /** the stream between his hands drains into the cables: light runs in on every cable, the ones that hang by the hands first */
    function drain(t) { st.drains.push({ t }); if (st.drains.length > 4) st.drains.shift(); }
    function packets(c, t) {
      const out = [];
      for (const d of st.drains) { const age = t - d.t - (cables[c].group === 'fall' ? 0 : 0.20) - 0.16 * rank[c] / Math.max(1, count - 1), u = 1 - age / 0.65; if (age >= 0 && u >= -0.1) out.push({ u: Math.max(0, u), s: 0.9, inward: true }); }
      for (const k of st.kicks) { const age = t - k.t - KICK_STAGGER * rank[c] / Math.max(1, count - 1), u = age / (KICK_RUN + 0.25 * (c % 3) / 2); if (age >= 0 && u <= 1.15) out.push({ u, s: k.s * (1 - 0.35 * clamp(u, 0, 1)), inward: false }); }
      for (const k of st.taps) { if (k.c !== c) continue; const age = t - k.t, u = 1 - age / 0.7; if (age >= 0 && u >= -0.1) out.push({ u: Math.max(0, u), s: 1, inward: true }); }
      for (const g of st.gifts) { if (g.all) continue; const j = (rank[c] - g.seed + count) % count; if (j >= g.n) continue; const age = t - g.t - 0.05 * j, u = 1 - age / 0.6; if (age >= 0 && u >= -0.1) out.push({ u: Math.max(0, u), s: 0.6 + 0.6 * g.size, inward: true }); }
      return out;
    }
    function surge(c, t) { let v = 0; for (const d of st.drops) { const age = t - d.t - 0.06 * rank[c] / Math.max(1, count - 1); if (age >= 0) v = Math.max(v, d.s * Math.min(1, age / 0.05) * Math.exp(-age * 1.3)); } return clamp(v, 0, 1.5); }
    function burst(t) { let v = 0; for (const g of st.gifts) { const age = t - g.t; if (age >= 0) v = Math.max(v, g.size * Math.exp(-age * 1.8)); } return v; }
    const glow = (c, t, a) => 0.24 + 0.08 * Math.sin(t * 0.9 + cables[c].phase) + 0.60 * clamp((a && a.bass) || 0, 0, 1) + 0.18 * clamp((a && a.level) || 0, 0, 1);
    const width = (c, a) => cables[c].r * (1 + 0.38 * clamp((a && a.bass) || 0, 0, 1));
    /** how lit a cable is at a hype rank (-1 = no hype .. 5 = MYTHIC): the thick ones first, all of them at the top */
    const lit = (c, rankH) => { const r = (Number.isFinite(rankH) ? rankH : -1) + 1; return cables[c].order <= 0.30 + 0.40 * clamp(r, 0, 1) + 0.30 * clamp((r - 1) / 5, 0, 1) + 1e-9 ? 1 : 0.30; };      // (a third without hype, most of them at the first rank, all at the top)

    return { pos, nodes, count, cables, step, kick, drop, whip, tap, gift, drain, packets, surge, burst, glow, width, lit, restLocal: (c, i) => [rest[c][i * 3], rest[c][i * 3 + 1], rest[c][i * 3 + 2]], state: st };
  }
  return { create, layout, restShape, onSkull, SKULL, NODES };
});
