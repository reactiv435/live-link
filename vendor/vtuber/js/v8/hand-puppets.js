// V8 ENGINE: his hands as two puppets. Pure UMD, no DOM, no clock of its own (js/v8/README.md, section 4).
//
//   const hp = VTHandPuppets.create({ sourceMirrored: false });
//   const p = hp.step(tSeconds, hands, { aspect: 720 / 1280, face: [x, y] });
//   p.angel / p.devil = { on, k, held, x, y, size, tilt, mouth, mouthV, look, facing, talking, conf }
//
// His REAL right hand is the ANGEL, his real left hand the DEVIL. On the tracker's un-mirrored picture the hand model's
// label 'Right' is his own right hand (checked against the pose wrists on his clips: 95 %); the label still flips for a
// frame now and then and two hands sometimes get the same label, so a hand is FOLLOWED by where it is and its side is a
// slow vote of its labels. The mouth is a sock puppet's: the gap between the thumb tip and the finger tips, against the
// size of the palm, measured in the hand model's own 3D points when they are there (so turning the hand does not move
// the mouth), and stretched to HIS range as it is seen.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTHandPuppets = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const TAU = Math.PI * 2;

  const DEFAULTS = {
    minScore: 0.4,          // the hand model's score below which a detection is not a hand
    minSize: 0.07,          // parts of the picture height: smaller = too far away / a ghost
    maxY: 0.93,             // a palm lower than this (bottom edge) is a hand resting, not held up
    appear: 0.2, hold: 0.45, // s seen before the puppet comes; s it stays after the hand is lost
    fadeIn: 0.35, fadeOut: 0.3,
    gate: 0.22,             // picture heights: a detection further than this from a puppet is another hand
    voteTau: 0.5, flipAt: 0.45,   // the side of a hand: a slow vote of its labels; it changes sides only when the vote is clearly over
    pos: { minCut: 2.0, beta: 6.0 }, mouthF: { minCut: 6.0, beta: 1.5 }, sizeTau: 0.35, tiltF: { minCut: 2.0, beta: 1.0 },
    gap: { lo: 0.25, hi: 1.1, window: 20, floor: 0.35, ease: 1.5 },   // the thumb-to-fingers gap in palm lengths: what counts as shut / wide
                            // before he has flapped, the seconds of his own flapping it learns from, and the smallest range it will use
    talk: { window: 1.0, moves: 2, swing: 0.25 },
    argueTau: 0.6,
  };

  /** One Euro filter (Casiez 2012): steady when slow, quick when fast */
  function oneEuro({ minCut, beta }) {
    let x = null, dx = 0;
    const alpha = (cut, dt) => { const r = TAU * cut * dt; return r / (r + 1); };
    return {
      step(v, dt) {
        if (x == null || !(dt > 0)) { x = v; dx = 0; return x; }
        const d = (v - x) / dt; dx += (d - dx) * alpha(1.0, dt);
        x += (v - x) * alpha(minCut + beta * Math.abs(dx), dt);
        return x;
      },
      reset() { x = null; dx = 0; }, get value() { return x; },
    };
  }

  /** 21 points as [[x, y, z]] from a flat array of 63 or from [{ x, y, z }] */
  function points(lm) {
    if (!lm) return null;
    if (typeof lm[0] === 'number') { if (lm.length < 63) return null; const o = []; for (let i = 0; i < 21; i++) o.push([lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]]); return o; }
    if (lm.length < 21) return null;
    return lm.slice(0, 21).map((p) => [p.x, p.y, p.z || 0]);
  }
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

  /** what one detection says, before any smoothing: where the palm is, how big the hand is, its tilt and the raw mouth gap */
  function measure(hand, aspect) {
    const im = points(hand && hand.lm);
    if (!im) return null;
    const P = im.map((p) => [p[0] * aspect, p[1], p[2] * aspect]);          // true lengths: x and z are in picture widths
    const palm = [(im[0][0] + im[5][0] + im[9][0] + im[17][0]) / 4, (im[0][1] + im[5][1] + im[9][1] + im[17][1]) / 4];
    const size = d3(P[0], P[9]) + d3(P[9], P[10]) + d3(P[10], P[11]) + d3(P[11], P[12]);       // wrist to middle fingertip, stretched
    const tilt = Math.atan2(P[9][0] - P[0][0], -(P[9][1] - P[0][1]));        // 0 = fingers up, + = clockwise
    const W = points(hand.world) || P;                                       // metres when given
    const palmLen = d3(W[0], W[9]) || 1e-6;
    const gap = d3(W[4], mid(W[8], W[12])) / palmLen;
    return { palm, size, tilt, gap, score: Number.isFinite(hand.score) ? hand.score : 0.5, label: hand.handed === 'Right' ? 1 : hand.handed === 'Left' ? -1 : 0 };
  }

  function create({ sourceMirrored = false, params = null } = {}) {
    const P = Object.assign({}, DEFAULTS, params);
    let mirrored = !!sourceMirrored;
    let now = null, tracks = [], nextId = 1, argue = 0;
    const blank = (who) => ({ who, on: false, k: 0, held: false, x: 0.5, y: 0.5, size: 0.15, tilt: 0, mouth: 0, mouthV: 0, look: [0, 0], facing: who === 'angel' ? 1 : -1, talking: false, conf: 0, track: null, act: 0 });
    const pup = { angel: blank('angel'), devil: blank('devil') };

    function newTrack(m, t) {
      return { id: nextId++, born: t, seenFor: 0, last: t, vote: 0, voteW: 0, fx: oneEuro(P.pos), fy: oneEuro(P.pos), ft: oneEuro(P.tiltF), fm: oneEuro(P.mouthF), size: m.size, tilt: m.tilt, lo: P.gap.lo, hi: P.gap.hi, gaps: [], mouth: 0, mouthV: 0, flips: [], dir: 0, ext: 0, x: m.palm[0], y: m.palm[1], score: m.score, role: null, here: true };
    }

    function step(t, hands, opts) {
      const o = opts || {}, aspect = Number.isFinite(o.aspect) && o.aspect > 0 ? o.aspect : 0.5625;
      const dt = now == null ? 0 : clamp(t - now, 0, 0.25);
      now = t;
      const ev = [];
      // ---------------------------------------------------------------- this frame's hands
      const ms = [];
      for (const h of hands || []) {
        const m = measure(h, aspect);
        if (!m || m.score < P.minScore || m.size < P.minSize || m.palm[1] > P.maxY) continue;
        m.side = (mirrored ? -1 : 1) * m.label;                              // +1 = his real right hand
        // the same hand found twice (the model does that): keep the better one
        const twin = ms.find((q) => Math.hypot((q.palm[0] - m.palm[0]) * aspect, q.palm[1] - m.palm[1]) < 0.05);
        if (twin) { if (m.score > twin.score) ms[ms.indexOf(twin)] = m; continue; }
        ms.push(m);
      }
      ms.sort((a, b) => b.score - a.score); ms.length = Math.min(ms.length, 2);

      // ---------------------------------------------------------------- follow them: nearest detection to each hand we already have
      for (const tr of tracks) tr.here = false;
      const free = ms.slice();
      const pairs = [];
      for (const tr of tracks) for (const m of free) pairs.push([Math.hypot((m.palm[0] - tr.x) * aspect, m.palm[1] - tr.y), tr, m]);
      pairs.sort((a, b) => a[0] - b[0]);
      for (const [d, tr, m] of pairs) {
        // a hand that was lost for a moment may have moved on: the reach grows with the time it was gone
        if (d > Math.min(0.5, P.gate + 1.2 * Math.max(0, t - tr.last - dt)) || tr.here || !free.includes(m)) continue;
        free.splice(free.indexOf(m), 1);
        update(tr, m, t, dt);
      }
      for (const m of free) if (tracks.length < 2) { const tr = newTrack(m, t); tracks.push(tr); update(tr, m, t, 0); }
      tracks = tracks.filter((tr) => t - tr.last <= P.hold);

      // ---------------------------------------------------------------- who is the angel
      const live = tracks.filter((tr) => tr.seenFor >= P.appear);
      if (live.length === 2) {
        // two hands: the one whose labels say "right" more is the angel; when the labels do not tell them apart, his right
        // hand is the one on picture left (un-mirrored), as it is for hands that are not crossed
        const [a, b] = live;
        let da = a.vote - b.vote;
        if (Math.abs(da) < 0.3) da = (mirrored ? 1 : -1) * Math.sign(a.x - b.x) * 0.31;
        const wantA = da > 0 ? 'angel' : 'devil';
        const keep = a.role && b.role && a.role !== b.role && Math.abs(a.vote - b.vote) < P.flipAt * 2;      // already cast and not clearly wrong: stay
        if (!keep) { a.role = wantA; b.role = wantA === 'angel' ? 'devil' : 'angel'; }
      } else if (live.length === 1) {
        const a = live[0];
        if (!a.role) { if (Math.abs(a.vote) >= 0.25 || a.seenFor >= 0.5) a.role = a.vote >= 0 ? 'angel' : 'devil'; }
        else if (a.role === 'angel' && a.vote < -P.flipAt) a.role = 'devil';
        else if (a.role === 'devil' && a.vote > P.flipAt) a.role = 'angel';
      }

      // ---------------------------------------------------------------- the two puppets
      for (const who of ['angel', 'devil']) {
        const q = pup[who], tr = live.find((x) => x.role === who) || null;
        const was = q.on;
        if (tr) {
          if (q.track !== tr.id) { q.track = tr.id; if (was) ev.push({ type: 'puppet-out', t, who }); q.on = false; }
          if (!q.on) { q.on = true; q.k = Math.min(q.k, 0.0001); ev.push({ type: 'puppet-in', t, who }); }
          q.held = !tr.here;
          q.x = tr.fx.value; q.y = tr.fy.value; q.size = tr.size; q.tilt = tr.tilt; q.conf = tr.score;
          q.mouth = tr.mouth; q.mouthV = tr.mouthV; q.talking = tr.flips.length >= P.talk.moves;
          if (tr.chomp) { ev.push({ type: 'puppet-chomp', t, who }); tr.chomp = false; }
          q.act += (Math.abs(tr.mouthV) - q.act) * (1 - Math.exp(-dt / 0.4));
        } else {
          if (q.on) { q.on = false; ev.push({ type: 'puppet-out', t, who }); }
          q.held = false; q.track = null; q.mouthV = 0; q.talking = false; q.act *= Math.exp(-dt / 0.4);
        }
        q.k = q.on ? Math.min(1, q.k + dt / P.fadeIn) : Math.max(0, q.k - dt / P.fadeOut);
      }
      const both = pup.angel.on && pup.devil.on;
      argue = both ? Math.min(1, argue + dt / P.argueTau) : Math.max(0, argue - dt / P.argueTau);
      const face = Array.isArray(o.face) && Number.isFinite(o.face[0]) ? o.face : [0.5, 0.4];
      for (const who of ['angel', 'devil']) {
        const q = pup[who], other = pup[who === 'angel' ? 'devil' : 'angel'];
        if (!q.on) continue;
        // it looks at the Mask, and turns to the other puppet as the argument starts
        const fx = (face[0] - q.x) * aspect, fy = face[1] - q.y, ox = (other.x - q.x) * aspect, oy = other.y - q.y;
        const lx = fx + (ox - fx) * argue, ly = fy + (oy - fy) * argue, l = Math.hypot(lx, ly);
        if (l > 1e-4) { q.look = [lx / l, ly / l]; if (Math.abs(lx) > 0.02) q.facing = lx > 0 ? 1 : -1; }
      }
      const out = (q) => ({ on: q.on, k: q.k, held: q.held, x: q.x, y: q.y, size: q.size, tilt: q.tilt, mouth: q.mouth, mouthV: q.mouthV, look: [q.look[0], q.look[1]], facing: q.facing, talking: q.talking, conf: q.conf });
      const sp = both || pup.angel.on || pup.devil.on ? (pup.angel.act > pup.devil.act * 1.2 && pup.angel.act > 0.6 ? 'angel' : pup.devil.act > pup.angel.act * 1.2 && pup.devil.act > 0.6 ? 'devil' : null) : null;
      return { t, angel: out(pup.angel), devil: out(pup.devil), both, argue, speaker: sp, events: ev };
    }

    function update(tr, m, t, dt) {
      tr.here = true; tr.last = t; tr.seenFor += dt; tr.score += (m.score - tr.score) * (dt > 0 ? 1 - Math.exp(-dt / 0.3) : 1);
      // the side: the plain average of the labels for the first half second (a hand coming into the picture is often
      // mislabelled for a frame or two), a slow vote after that
      if (m.side) {
        const w = clamp(m.score, 0.3, 1);
        if (tr.voteW < P.voteTau * 30) { tr.vote = (tr.vote * tr.voteW + m.side * w) / (tr.voteW + w); tr.voteW += w; }
        else tr.vote += (m.side - tr.vote) * (1 - Math.exp(-dt * w / P.voteTau));
      }
      tr.x = m.palm[0]; tr.y = m.palm[1];
      tr.fx.step(m.palm[0], dt); tr.fy.step(m.palm[1], dt);
      tr.size += (m.size - tr.size) * (dt > 0 ? 1 - Math.exp(-dt / P.sizeTau) : 1);
      // the tilt is an angle: follow it the short way round
      let d = m.tilt - tr.tiltRaw0; if (tr.tiltRaw0 == null) d = 0; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      tr.tiltUn = (tr.tiltUn == null ? m.tilt : tr.tiltUn + d); tr.tiltRaw0 = m.tilt;
      const tl = tr.ft.step(tr.tiltUn, dt); tr.tilt = Math.atan2(Math.sin(tl), Math.cos(tl));
      // the mouth: his own shut and wide are learned from the last seconds of THIS hand. The more it has swung, the more its
      // own smallest and widest gap count; a hand that has not flapped keeps the starting range (so a still hand does not
      // drift open), and the range never gets smaller than `floor`.
      const G = P.gap;
      tr.gaps.push([t, m.gap]); while (t - tr.gaps[0][0] > G.window) tr.gaps.shift();
      let gmin = Infinity, gmax = -Infinity; for (const g of tr.gaps) { if (g[1] < gmin) gmin = g[1]; if (g[1] > gmax) gmax = g[1]; }
      const w = clamp((gmax - gmin) / G.floor, 0, 1), ke = dt > 0 ? 1 - Math.exp(-dt / G.ease) : 1;
      const lo = G.lo + (gmin - G.lo) * w, hi = Math.max(lo + G.floor, G.hi + (gmax - G.hi) * w);
      tr.lo += (lo - tr.lo) * ke; tr.hi += (hi - tr.hi) * ke;
      const range = Math.max(G.floor, tr.hi - tr.lo);
      const raw = clamp((m.gap - tr.lo) / range, 0, 1);
      const prev = tr.mouth;
      tr.mouth = clamp(tr.fm.step(raw, dt), 0, 1);
      tr.mouthV = dt > 0 ? (tr.mouth - prev) / dt : 0;
      // flaps: each time the mouth has swung `swing` the other way it is one move; a fast close from open is a chomp
      if (tr.ext == null) tr.ext = tr.mouth;
      if (tr.dir >= 0) { if (tr.mouth > tr.ext) tr.ext = tr.mouth; else if (tr.ext - tr.mouth >= P.talk.swing) { tr.flips.push(t); if (tr.ext > 0.5 && tr.mouthV < -2.5) tr.chomp = true; tr.dir = -1; tr.ext = tr.mouth; } }
      else { if (tr.mouth < tr.ext) tr.ext = tr.mouth; else if (tr.mouth - tr.ext >= P.talk.swing) { tr.flips.push(t); tr.dir = 1; tr.ext = tr.mouth; } }
      while (tr.flips.length && t - tr.flips[0] > P.talk.window) tr.flips.shift();
    }

    function reset() { tracks = []; now = null; argue = 0; pup.angel = blank('angel'); pup.devil = blank('devil'); }
    return { step, reset, setSourceMirrored(v) { mirrored = !!v; }, params: P, debug: () => tracks.map((tr) => ({ id: tr.id, role: tr.role, vote: tr.vote, lo: tr.lo, hi: tr.hi })) };
  }

  return { create, measure, points, oneEuro, DEFAULTS };
});
