// V9 HANDS: what his hands are doing, for the hand effects ("Particle Play" is the first). Pure UMD, no DOM, no clock of
// its own. Two parts:
//
//   const g = VTHandGestures.create();
//   const s = g.step(tSeconds, hands, { aspect });       // hands: the hand model's [{ lm, world, handed, score }], as the tracker sends them
//   s.hands = [{ id, side, on, k, x, y, size, pose, poseFor, facing, pts, z (21 depths), pinchAt, tip, dir, push, ... }]   (at most two, his right hand first)
//   s.events = [{ type: 'push' | 'pull' | 'twist' | 'pose', ... }]
//
//   const c = VTHandGestures.control();                   // the effect's own state: where the core is, how big, the charge ...
//   const u = c.step(tSeconds, dt, s, { kick, hit, level });
//   u = { k, mode, x, y, r, charge, charging, grab, flying, magnet, dir, beam, blast, events }   (effect-agnostic: 'the thing between his hands')
//
// Poses: 'open' (flat hand), 'fist', 'pinch' (thumb on index, the other fingers clearly straighter), 'point' (index
// out, the rest in), 'relaxed' (anything else: a resting or talking hand). Every pose has its own way in and a wider
// way out (hysteresis) and must be seen for a moment before it counts (dwell), so a hand between two shapes does not
// flicker. The moves (push, pull, twist) need the right pose first and have a rest time after they fire.
// All lengths are in picture heights (x is multiplied by the aspect), so a hand is the same size in every direction.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTHandGestures = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ss = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const ease = (v, to, dt, up, down) => v + (to - v) * (1 - Math.exp(-dt * (to > v ? up : (down === undefined ? up : down))));
  const TAU = Math.PI * 2;

  const DEFAULTS = {
    minScore: 0.4, minSize: 0.07, maxY: 0.93,      // what counts as a hand held up (the same rule the hand puppets use)
    appear: 0.25, fadeIn: 0.3,
    // DROPOUTS (his words: "they can just stay there until the tracking picks back up"): a hand the model loses STAYS
    // where it was, in its pose, for `hold` seconds, then fades slowly. Only a hand last seen at an edge of the picture
    // and moving out of it has LEFT and goes sooner. When it is found again near by it glides there (`glide` s, no snap);
    // found again far away (further than `reach`) it cross-fades (`crossFade` s) instead of sliding across the picture.
    hold: 2.0, fadeOut: 0.8, glide: 0.15, glideAfter: 0.10, reach: 0.30, crossFade: 0.3,
    leave: { hold: 0.25, fade: 0.35, edge: 0.10, bottom: 0.86, speed: 0.12 },
    gate: 0.22, voteTau: 0.5,
    featTau: 0.07,                                  // s: the finger numbers are eased this much before a pose is read
    dwell: 0.12,                                    // s a new pose must be seen before it counts
    fist: { in: 0.50, out: 0.64 },                  // mean straightness of the four fingers
    open: { in: 0.82, out: 0.66 },                  // the least straight of the four fingers
    point: { index: 0.86, rest: 0.60, indexOut: 0.74, restOut: 0.74 },
    pinch: { in: 0.22, out: 0.42, index: 0.52, rest: 0.66, lead: 0.10 },   // thumb-to-index gap in palm lengths; the other three fingers must be straighter
    // push / pull: an open hand comes at the camera (it GROWS) or goes away (it shrinks). Read as the hand's size now
    // against its own size over the last moment (a quick average against a slow one), so shake does not count and a slow
    // drift does not count. by = how much bigger (the log of it), calm = it may not be sweeping sideways meanwhile.
    push: { by: 0.27, openFor: 0.45, rest: 1.0, fast: 0.05, slow: 0.40, calm: 0.55, after: 1.3, settled: 0.7, edge: 0.012 },   // settled: s the hand must have been up, whole, inside the picture
    pull: { by: -0.27, openFor: 0.45, rest: 1.0 },
    twist: { w: 0.45, dwell: 0.12, within: 0.9, rest: 0.8, open: 0.80, steady: 0.35, calm: 0.6 },    // the flat hand turns over (palm <-> back of the hand)
    pos: { minCut: 2.2, beta: 7.0 }, pts: { minCut: 3.0, beta: 9.0 },
  };

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

  function points(lm) {
    if (!lm) return null;
    if (typeof lm[0] === 'number') { if (lm.length < 63) return null; const o = []; for (let i = 0; i < 21; i++) o.push([lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]]); return o; }
    if (lm.length < 21) return null;
    return lm.slice(0, 21).map((p) => (Array.isArray(p) ? [p[0], p[1], p[2] || 0] : [p.x, p.y, p.z || 0]));
  }
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /** one detection, before any smoothing: the numbers every pose is read from */
  function measure(hand, aspect) {
    const im = points(hand && hand.lm);
    if (!im) return null;
    const P = im.map((p) => [p[0] * aspect, p[1], p[2] * aspect]);
    const W = points(hand.world) || P;                    // metres when the model gives them: turning the hand does not change them
    const palm = [(im[0][0] + im[5][0] + im[9][0] + im[17][0]) / 4, (im[0][1] + im[5][1] + im[9][1] + im[17][1]) / 4];
    const palmLen = d3(W[0], W[9]) || 1e-6;
    const straight = [];
    for (const b of [5, 9, 13, 17]) straight.push(d3(W[b], W[b + 3]) / ((d3(W[b], W[b + 1]) + d3(W[b + 1], W[b + 2]) + d3(W[b + 2], W[b + 3])) || 1e-6));
    const gap = d3(W[4], W[8]) / palmLen;
    // the size of the hand as the camera sees it: the palm's four lines WITH their depth (so turning the hand changes it
    // little; measured on his clips this is the steadiest of six ways), and the box round all 21 points as a second opinion
    const size = (d3(P[0], P[5]) + d3(P[0], P[17]) + d3(P[0], P[9]) + d3(P[5], P[17])) / 4 * 2.25;      // about wrist to middle fingertip
    let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (const q of P) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    const box = Math.hypot(x1 - x0, y1 - y0);
    // which way the palm faces: the turn wrist -> index knuckle -> pinky knuckle in the picture (its sign flips when the hand turns over)
    const ax = P[5][0] - P[0][0], ay = P[5][1] - P[0][1], bx = P[17][0] - P[0][0], by = P[17][1] - P[0][1];
    const wind = (ax * by - ay * bx) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1e-6);
    const tilt = Math.atan2(P[9][0] - P[0][0], -(P[9][1] - P[0][1]));
    const dl = Math.hypot(P[8][0] - P[5][0], P[8][1] - P[5][1]) || 1e-6;
    return {
      palm, size, box, straight, gap, wind, tilt, P,
      dir: [(P[8][0] - P[5][0]) / dl, (P[8][1] - P[5][1]) / dl],
      score: Number.isFinite(hand.score) ? hand.score : 0.5, label: hand.handed === 'Right' ? 1 : hand.handed === 'Left' ? -1 : 0,
    };
  }

  /** the pose the eased numbers ask for right now, given the pose the hand is in (so each pose has a wider way out) */
  function poseOf(f, cur, P) {
    const [i, m, r, p] = f.straight, mean4 = (i + m + r + p) / 4, rest3 = (m + r + p) / 3, least = Math.min(i, m, r, p);
    const fist = mean4 < (cur === 'fist' ? P.fist.out : P.fist.in);
    const pinch = cur === 'pinch'
      ? f.gap < P.pinch.out && !(mean4 < P.fist.in)
      : f.gap < P.pinch.in && i > P.pinch.index && rest3 > P.pinch.rest && rest3 - i > P.pinch.lead && !fist;
    const point = cur === 'point'
      ? i > P.point.indexOut && rest3 < P.point.restOut
      : i > P.point.index && rest3 < P.point.rest && f.gap > P.pinch.in;
    const open = cur === 'open' ? least > P.open.out : least > P.open.in && f.gap > P.pinch.in;
    // the more special shape wins: a pinch made from an open hand is a pinch, not "still open"
    return pinch ? 'pinch' : point ? 'point' : fist ? 'fist' : open ? 'open' : 'relaxed';
  }

  function create({ params = null } = {}) {
    const P = Object.assign({}, DEFAULTS, params);
    let now = null, tracks = [], nextId = 1;

    function newTrack(m, t) {
      return {
        id: nextId++, born: t, last: t, seenFor: 0, k: 0, on: false, vote: 0, voteW: 0, x: m.palm[0], y: m.palm[1], size: m.size,
        fx: oneEuro(P.pos), fy: oneEuro(P.pos), fp: Array.from({ length: 42 }, () => oneEuro(P.pts)), pts: null,
        f: null, pose: 'relaxed', poseAt: t, cand: 'relaxed', candAt: t,
        wholeAt: t + 9, ln3: [], lnF: null, lnS: null, bF: null, bS: null, rate: 0, rateB: 0, pushAt: -9, pullAt: -9, facedAt: t,
        facing: 0, faceCand: 0, faceCandAt: t, lastFlat: -9, twistAt: -9, here: false, vx: 0, vy: 0, side: 1, sideSure: false, dying: false, leaving: false, glide: null, shown: null, sx: m.palm[0], sy: m.palm[1],
      };
    }

    function update(tr, m, t, dt, ev, asp) {
      tr.here = true;
      const gapT = t - tr.last; tr.last = t; tr.seenFor += dt;
      // back from a hold: it glides from where it was held to where it is (the smoothing starts fresh at the new place)
      const back = gapT > P.glideAfter && !!tr.shown;
      if (back) { tr.glide = { t0: t, pts: Float32Array.from(tr.shown) }; tr.fx.reset(); tr.fy.reset(); for (const f of tr.fp) f.reset(); }
      const ox = tr.x, oy = tr.y;
      tr.x = tr.fx.step(m.palm[0], dt); tr.y = tr.fy.step(m.palm[1], dt);
      if (dt > 0 && gapT < 0.25 && !back) { const a = 1 - Math.exp(-dt / 0.08); tr.vx += ((tr.x - ox) / dt - tr.vx) * a; tr.vy += ((tr.y - oy) / dt - tr.vy) * a; } else { tr.vx = 0; tr.vy = 0; }
      if (!tr.pts) tr.pts = new Float32Array(42);
      for (let i = 0; i < 21; i++) { tr.pts[i * 2] = tr.fp[i * 2].step(m.P[i][0], dt); tr.pts[i * 2 + 1] = tr.fp[i * 2 + 1].step(m.P[i][1], dt); }
      // (round 7) the DEPTH of each point, as the hand model gives it (the wrist's own = 0, nearer the camera = smaller; the same unit as x): a modelled hand needs it
      if (!tr.pz) { tr.pz = new Float32Array(21); tr.fz = Array.from({ length: 21 }, () => oneEuro(P.pts)); }
      if (back) for (const f of tr.fz) f.reset();
      for (let i = 0; i < 21; i++) { const zv = m.P[i][2] - m.P[0][2]; tr.pz[i] = tr.fz[i].step(Number.isFinite(zv) ? zv : 0, dt); }
      if (m.label) { const w = Math.exp(-dt / P.voteTau); tr.vote = tr.vote * w + m.label * (1 - w) * m.score; tr.voteW = tr.voteW * w + (1 - w) * m.score; if (tr.voteW < 1e-3) { tr.vote = m.label * m.score; tr.voteW = m.score; } }
      // the finger numbers, eased
      const a = dt > 0 ? 1 - Math.exp(-dt / P.featTau) : 1;
      if (!tr.f) tr.f = { straight: m.straight.slice(), gap: m.gap, wind: m.wind };
      else { for (let i = 0; i < 4; i++) tr.f.straight[i] += (m.straight[i] - tr.f.straight[i]) * a; tr.f.gap += (m.gap - tr.f.gap) * a; tr.f.wind += (m.wind - tr.f.wind) * a; }
      tr.tilt = m.tilt; tr.dir = m.dir;
      // the pose: what the numbers ask for must stay the same for the dwell before it counts
      const want = poseOf(tr.f, tr.pose, P);
      if (want !== tr.cand) { tr.cand = want; tr.candAt = t; }
      if (tr.cand !== tr.pose && t - tr.candAt >= P.dwell) { ev.push({ type: 'pose', id: tr.id, pose: tr.cand, from: tr.pose, t }); tr.pose = tr.cand; tr.poseAt = t; }
      // towards / away from the camera: how fast the hand grows, eased (a missed stretch of frames starts it again)
      // (the middle of the last three sizes: one wild frame of the hand model does not count)
      if (gapT > 0.25 || back || !(dt > 0)) tr.ln3.length = 0;
      tr.ln3.push([Math.log(Math.max(1e-4, m.size)), Math.log(Math.max(1e-4, m.box))]); if (tr.ln3.length > 3) tr.ln3.shift();
      const med = (k) => { const a = tr.ln3.map((v) => v[k]).sort((x, y) => x - y); return a[a.length >> 1]; }, ln = med(0), lb = med(1);
      if (tr.ln3.length < 3 || tr.lnF === null) { tr.lnF = ln; tr.lnS = ln; tr.bF = lb; tr.bS = lb; }
      else { const kf = 1 - Math.exp(-dt / P.push.fast), ks = 1 - Math.exp(-dt / P.push.slow); tr.lnF += (ln - tr.lnF) * kf; tr.lnS += (tr.lnF - tr.lnS) * ks; tr.bF += (lb - tr.bF) * kf; tr.bS += (tr.bF - tr.bS) * ks; }
      tr.rate = tr.lnF - tr.lnS; tr.rateB = tr.bF - tr.bS;
      const speed = Math.hypot(tr.vx * asp, tr.vy);
      // a hand that is coming into the picture, or is cut by its edge, grows and shrinks by itself: that is not a push
      let whole = true; for (let i = 0; i < 21 && whole; i++) { const x = m.P[i][0] / asp, y = m.P[i][1]; if (x < P.push.edge || x > 1 - P.push.edge || y < P.push.edge || y > 1 - P.push.edge) whole = false; }
      if (!whole || !tr.on || back) tr.wholeAt = t + 1e-9;      // (and a hand just found again must settle first: its size is new) else if (tr.wholeAt > t) tr.wholeAt = t;
      const settled = whole && tr.on && t - tr.wholeAt >= P.push.settled;
      tr.size += (m.size - tr.size) * (dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1);
      const side = tr.side;
      // which way the palm faces (+1 = the palm to the camera), with its own way in and out and a dwell
      const fw = -tr.f.wind * side, mean4 = (tr.f.straight[0] + tr.f.straight[1] + tr.f.straight[2] + tr.f.straight[3]) / 4;
      const fc = fw > P.twist.w ? 1 : fw < -P.twist.w ? -1 : 0;
      if (fc !== tr.faceCand) { tr.faceCand = fc; tr.faceCandAt = t; }
      if (fc !== 0 && fc !== tr.facing && t - tr.faceCandAt >= P.twist.dwell) {
        const was = tr.facing;
        tr.facing = fc;
        // a twist: the hand was flat-ish, turned over within a moment, and is flat-ish again
        if (was !== 0 && tr.on && mean4 > P.twist.open && t - tr.lastFlat < P.twist.within && tr.lastFlat - tr.facedAt >= P.twist.steady && speed < P.twist.calm && t - tr.twistAt > P.twist.rest) { tr.twistAt = t; ev.push({ type: 'twist', id: tr.id, facing: fc, t }); }
        tr.facedAt = t;
      }
      if (tr.facing !== 0 && fc === tr.facing && mean4 > P.twist.open) tr.lastFlat = t;
      // has it LEFT? last seen at an edge of the picture and moving out of it (then a loss is not a dropout)
      { const px = m.palm[0], py = m.palm[1], ex = px < P.leave.edge ? -1 : px > 1 - P.leave.edge ? 1 : 0, ey = py > P.leave.bottom ? 1 : py < P.leave.edge ? -1 : 0; tr.leaving = (ex !== 0 || ey !== 0) && tr.vx * ex + tr.vy * ey > P.leave.speed; }
      // push / pull: an open hand that comes at the camera fast, or goes away fast
      const openFor = tr.pose === 'open' ? t - tr.poseAt : 0;
      const moved = Math.max(t - tr.pushAt, 0) > P.push.after && Math.max(t - tr.pullAt, 0) > P.push.after;      // the way back from a push is not a pull
      if (settled && moved && openFor >= P.push.openFor && speed < P.push.calm && tr.rate > P.push.by && tr.rateB > P.push.by * 0.6) { tr.pushAt = t; ev.push({ type: 'push', id: tr.id, power: clamp(tr.rate / (1.6 * P.push.by), 0.6, 1.4), t }); }
      else if (settled && moved && openFor >= P.pull.openFor && speed < P.push.calm && tr.rate < P.pull.by && tr.rateB < P.pull.by * 0.6) { tr.pullAt = t; ev.push({ type: 'pull', id: tr.id, t }); }
    }

    function step(t, hands, opts) {
      const o = opts || {}, aspect = Number.isFinite(o.aspect) && o.aspect > 0 ? o.aspect : 0.5625;
      const dt = now == null ? 0 : clamp(t - now, 0, 0.25);
      now = t;
      const ev = [], ms = [];
      for (const h of hands || []) {
        const m = measure(h, aspect);
        if (!m || m.score < P.minScore || m.size < P.minSize || m.palm[1] > P.maxY) continue;
        const twin = ms.find((q) => Math.hypot((q.palm[0] - m.palm[0]) * aspect, q.palm[1] - m.palm[1]) < 0.05);
        if (twin) { if (m.score > twin.score) ms[ms.indexOf(twin)] = m; continue; }
        ms.push(m);
      }
      ms.sort((a, b) => b.score - a.score); ms.length = Math.min(ms.length, 2);
      for (const tr of tracks) tr.here = false;
      const free = ms.slice(), pairs = [];
      for (const tr of tracks) if (!tr.dying) for (const m of free) pairs.push([Math.hypot((m.palm[0] - tr.x) * aspect, m.palm[1] - tr.y), tr, m]);
      pairs.sort((a, b) => a[0] - b[0]);
      for (const [d, tr, m] of pairs) {
        // a hand that was lost for a moment may have moved on: the reach grows with the time it was gone
        if (d > Math.min(P.reach, P.gate + 1.2 * Math.max(0, t - tr.last - dt)) || tr.here || !free.includes(m)) continue;
        free.splice(free.indexOf(m), 1);
        update(tr, m, t, dt, ev, aspect);
      }
      // a hand found where no hand of ours is
      for (const m of free) {
        const live = tracks.filter((tr) => !tr.dying), unseen = live.filter((tr) => !tr.here).sort((x, y) => x.last - y.last);
        // the SAME hand come back in another place (its label says so, or both places are taken): the held one fades
        // out there while this one fades in here (a cross-fade: it never slides across the picture)
        const same = unseen.find((tr) => tr.on && m.label !== 0 && m.label === tr.side && !live.some((o) => o !== tr && o.side === -tr.side && !o.here)) || (live.length >= 2 ? unseen[0] : null);
        if (live.length >= 2 && !same) continue;
        const tr = newTrack(m, t);
        if (same) { same.dying = true; tr.side = same.side; tr.seenFor = P.appear; tr.pose = 'relaxed'; ev.push({ type: 'hand-moved', id: tr.id, from: same.id, t }); }
        else {
          const o = live[0] || null;
          if (!o) tr.side = m.label || (m.palm[0] < 0.5 ? 1 : -1);
          else if (m.label && m.label !== o.side) tr.side = m.label;
          else if (t - o.born < 0.5 && !o.sideSure) { const mineLeft = m.palm[0] < o.x; tr.side = mineLeft ? 1 : -1; o.side = -tr.side; }   // two new hands with one label: the one on the picture's left is his right
          else tr.side = -o.side;                          // the hand that is already there keeps its side: no swap
        }
        tracks.push(tr); update(tr, m, t, 0, ev, aspect);
      }
      for (const tr of tracks) {
        const lostFor = t - tr.last, holdFor = tr.dying ? 0 : tr.leaving ? P.leave.hold : P.hold, was = tr.on;
        if (!tr.here) tr.seenFor = Math.max(0, tr.seenFor - dt * 0.25);
        tr.on = !tr.dying && lostFor <= holdFor && (tr.on || tr.seenFor >= P.appear);
        tr.k = clamp(tr.k + (tr.on ? dt / P.fadeIn : -dt / (tr.dying ? P.crossFade : tr.leaving ? P.leave.fade : P.fadeOut)), 0, 1);
        if (tr.on !== was) ev.push({ type: tr.on ? 'hand-in' : 'hand-out', id: tr.id, t });
        // a held hand keeps its pose (a charge goes on through a dropout); a hand that is GONE holds none
        if (!tr.on && tr.pose !== 'relaxed') { tr.pose = 'relaxed'; tr.poseAt = t; tr.cand = 'relaxed'; tr.candAt = t; }
        if (tr.on) tr.sideSure = tr.sideSure || t - tr.born > 0.5;
        // alone, seen, and its labels say clearly the other side: it was named wrong, put it right (never while two hands are up)
        if (tr.here && tracks.filter((q) => !q.dying).length === 1 && tr.voteW > 0.05 && tr.vote * tr.side < -0.6 * tr.voteW) { tr.side = -tr.side; tr.facing = 0; tr.faceCand = 0; }      // (its palm side is read again: this is not a twist)
      }
      tracks = tracks.filter((tr) => tr.k > 0 || tr.here || (!tr.dying && t - tr.last <= (tr.leaving ? P.leave.hold : P.hold)));
      // his right hand first; a hand that is fading out in its old place (cross-fade) last
      const list = tracks.filter((tr) => tr.k > 0 && tr.pts).sort((x, y) => (x.dying ? 1 : 0) - (y.dying ? 1 : 0) || y.side - x.side);
      const out = list.map((tr) => {
        const A = aspect, lost = t - tr.last;
        // what is SHOWN: the smoothed points; while it glides back from a hold, a part of where it was held; while it is held, a slow drift so it does not look frozen
        const g = tr.glide ? 1 - ss(0, P.glide, t - tr.glide.t0) : 0, dr = tr.here ? 0 : Math.min(1, lost / 0.4), ddx = dr * 0.0035 * Math.sin(t * 1.3 + tr.id * 2.1), ddy = dr * 0.0045 * Math.sin(t * 1.7 + tr.id);
        if (!tr.shown) tr.shown = new Float32Array(42);
        const p = tr.shown;
        for (let i = 0; i < 21; i++) { p[i * 2] = tr.pts[i * 2] + (g ? (tr.glide.pts[i * 2] - tr.pts[i * 2]) * g : 0) + ddx * A; p[i * 2 + 1] = tr.pts[i * 2 + 1] + (g ? (tr.glide.pts[i * 2 + 1] - tr.pts[i * 2 + 1]) * g : 0) + ddy; }
        if (g <= 0) tr.glide = null;
        const x = (p[0] + p[10] + p[18] + p[34]) / 4 / A, y = (p[1] + p[11] + p[19] + p[35]) / 4;
        tr.sx = x; tr.sy = y;
        return {
          id: tr.id, side: tr.side, on: tr.on, k: tr.k, seen: tr.here, held: !tr.here && tr.on, lost, moving: !!tr.dying, x, y, size: tr.size, pose: tr.pose, poseFor: t - tr.poseAt, facing: tr.facing || 1,
          pts: p, z: tr.pz || null, tilt: tr.tilt || 0, rate: tr.rate, conf: tr.voteW, vx: tr.here ? tr.vx : 0, vy: tr.here ? tr.vy : 0,   // picture units a second
          pinchAt: [(p[8] + p[16]) / 2 / A, (p[9] + p[17]) / 2],          // between the thumb tip and the index tip (picture units)
          tip: [p[16] / A, p[17]], dir: tr.dir || [0, -1],
          f: tr.f ? { straight: tr.f.straight.slice(), gap: tr.f.gap, wind: tr.f.wind } : null,
        };
      });
      return { t, aspect, hands: out, events: ev };
    }
    return { step, params: P, reset() { tracks = []; now = null; } };
  }

  // ------------------------------------------------------------------------------------------------ the effect's state
  const CONTROL = {
    rest: [0.5, 0.80],                 // where the core rests (picture units) when no hand is up; it fades out there
    r: { min: 0.04, max: 0.17, perSpread: 0.37, one: 0.055 },   // core radius in picture heights
    fistFor: 0.35,                     // s a fist must be held before it charges
    charge: { rate: 0.30, both: 0.22, level: 0.25, kick: 0.07, leak: 0.12 },
    pinchFor: 0.14, releaseBack: 1.4,  // s a pinch must be held before it grabs; s the core takes to go back after he lets go
    pointFor: 0.22,
    magnetFor: 1.7,
    throwSpeed: 0.55, flyFor: 1.15,    // picture heights a second the pinch must move at when he lets go to THROW it; s it flies before it comes back
    orbit: { one: 1.25, speed: 1.6 },  // one hand: the core's orbit round the palm in hand sizes, radians a second
  };

  function control({ params = null } = {}) {
    const C = Object.assign({}, CONTROL, params);
    const st = { k: 0, x: C.rest[0], y: C.rest[1], r: C.r.one, mode: 'none', charge: 0, charging: false, chargedAt: -9, grab: 0, grabId: 0, gx: 0, gy: 0, freeAt: -9, magnet: 0, magnetAt: -9, dir: 1, dirAt: -9, beam: 0, beamId: 0, blast: 0, blastAt: -9, ang: 0, heat: 0, gvx: 0, gvy: 0, gv: [], fly: 0, fvx: 0, fvy: 0, flyAt: -9 };
    function step(t, dt, s, au) {
      const A = au || {}, ev = [], hs = (s && s.hands ? s.hands : []).filter((h) => h.on), asp = s ? s.aspect : 0.5625;
      const mode = hs.length >= 2 ? 'two' : hs.length === 1 ? 'one' : 'none';
      if (mode !== st.mode) { ev.push({ type: 'mode', mode, from: st.mode }); st.mode = mode; }
      st.k = ease(st.k, mode === 'none' ? 0 : 1, dt, 3.2, 2.2);
      // ---- the events of the hands
      for (const e of (s && s.events) || []) {
        if (e.type === 'push' && t - st.blastAt > 0.6) { const p = clamp(0.55 + 0.6 * st.charge, 0.55, 1.4) * (e.power || 1); st.blast = Math.max(st.blast, p); st.blastAt = t; st.magnet = 0; st.magnetAt = -9; ev.push({ type: 'blast', power: p, charge: st.charge }); st.charge *= 0.15; }
        else if (e.type === 'pull' && t - st.magnetAt > 0.6 && t - st.blastAt > 0.6) { st.magnetAt = t; ev.push({ type: 'magnet' }); }
        else if (e.type === 'twist' && t - st.dirAt > 0.7) { st.dir = -st.dir; st.dirAt = t; ev.push({ type: 'reverse', dir: st.dir }); }
      }
      st.magnet = ease(st.magnet, t - st.magnetAt < C.magnetFor && mode !== 'none' ? 1 : 0, dt, 6, 2.5);
      st.blast = Math.max(0, st.blast - dt * 1.6);
      // ---- fist: charge (the music adds to it); letting go of a full charge fires it
      const fists = hs.filter((h) => h.pose === 'fist' && h.poseFor >= C.fistFor).length;
      const was = st.charging; st.charging = fists > 0;
      if (st.charging) {
        if (!was) ev.push({ type: 'charge-start' });
        st.charge = clamp(st.charge + dt * (C.charge.rate + C.charge.both * (fists - 1) + C.charge.level * (A.level || 0)) + C.charge.kick * (A.kickNow || 0), 0, 1);
        if (st.charge >= 1 && t - st.chargedAt > 1) { st.chargedAt = t; ev.push({ type: 'charged' }); }
      } else {
        if (was) ev.push({ type: 'charge-hold', charge: st.charge });       // the charge stays in it (it leaks away slowly): a push throws it out with that power
        st.charge = Math.max(0, st.charge - dt * C.charge.leak);
      }
      st.heat = ease(st.heat, st.charging ? 0.35 + 0.65 * st.charge : 0, dt, 5, 3);
      // ---- pinch: grab and drag
      const pin = hs.find((h) => h.pose === 'pinch' && h.poseFor >= C.pinchFor && (st.grabId === 0 || h.id === st.grabId)) || hs.find((h) => h.pose === 'pinch' && h.poseFor >= C.pinchFor);
      if (pin) {
        if (st.grabId !== pin.id) { st.grabId = pin.id; ev.push({ type: st.fly > 0 ? 'catch' : 'grab', id: pin.id }); st.fly = 0; st.gvx = 0; st.gvy = 0; st.gv.length = 0; }
        else if (dt > 0) { const a = 1 - Math.exp(-dt / 0.07); st.gvx += ((pin.pinchAt[0] - st.gx) / dt - st.gvx) * a; st.gvy += ((pin.pinchAt[1] - st.gy) / dt - st.gvy) * a; st.gv.push([t, st.gvx, st.gvy]); while (st.gv.length && t - st.gv[0][0] > 0.3) st.gv.shift(); }
        st.gx = pin.pinchAt[0]; st.gy = pin.pinchAt[1];
      } else if (st.grabId) {
        st.grabId = 0; st.freeAt = t;
        // the fingers open a moment AFTER the flick's fastest point: the throw takes the fastest of the last 0.3 s
        let sp = 0; for (const q of st.gv) { const v = Math.hypot(q[1] * asp, q[2]); if (v > sp) { sp = v; st.gvx = q[1]; st.gvy = q[2]; } } st.gv.length = 0;
        if (sp > C.throwSpeed) { st.fly = 1; st.flyAt = t; st.fvx = st.gvx; st.fvy = st.gvy; st.grab = 0; ev.push({ type: 'throw', speed: sp, vx: st.gvx, vy: st.gvy }); }
        else ev.push({ type: 'release' });
      }
      st.grab = ease(st.grab, pin ? 1 : 0, dt, 14, 2.2 / C.releaseBack);
      // ---- point: a beam from the fingertip
      const pt = hs.find((h) => h.pose === 'point' && h.poseFor >= C.pointFor);
      if (pt && !st.beamId) ev.push({ type: 'beam-on', id: pt.id }); else if (!pt && st.beamId) ev.push({ type: 'beam-off' });
      st.beamId = pt ? pt.id : 0; st.beam = ease(st.beam, pt ? 1 : 0, dt, 12, 6);
      const beam = pt ? { on: true, x: pt.tip[0], y: pt.tip[1], dx: pt.dir[0], dy: pt.dir[1], id: pt.id } : { on: false };
      // ---- where the core wants to be, and how big
      let tx = C.rest[0], ty = C.rest[1], tr = C.r.one * 0.8;
      if (mode === 'two') {
        const a = hs[0], b = hs[1], spread = Math.hypot((a.x - b.x) * asp, a.y - b.y);
        tx = (a.x + b.x) / 2; ty = (a.y + b.y) / 2; tr = clamp(spread * C.r.perSpread, C.r.min, C.r.max);
        st.spread = spread;
      } else if (mode === 'one') {
        const h = hs[0]; st.ang += dt * C.orbit.speed * st.dir * (1 + 0.6 * (A.level || 0));
        const R = h.size * C.orbit.one;
        tx = h.x + Math.cos(st.ang) * R / asp; ty = h.y - 0.25 * h.size + Math.sin(st.ang) * R * 0.55; tr = C.r.one;
      }
      // a charge pulls it in; a grab takes it to the pinch
      tr *= 1 - 0.28 * st.heat;
      const g = st.grab;
      tx = tx + (st.gx - tx) * g; ty = ty + (st.gy - ty) * g;
      // thrown: it flies on its own (slowing, turning back at the picture's edges), then comes home
      if (st.fly > 0) {
        st.x += st.fvx * dt; st.y += st.fvy * dt; const dr = Math.exp(-dt * 1.3); st.fvx *= dr; st.fvy *= dr;
        if (st.x < 0.06 && st.fvx < 0) st.fvx = -st.fvx * 0.7; if (st.x > 0.94 && st.fvx > 0) st.fvx = -st.fvx * 0.7;
        if (st.y < 0.06 && st.fvy < 0) st.fvy = -st.fvy * 0.7; if (st.y > 0.94 && st.fvy > 0) st.fvy = -st.fvy * 0.7;
        if (t - st.flyAt > C.flyFor || mode === 'none') { st.fly = 0; st.freeAt = t; ev.push({ type: 'return' }); }
      }
      const home = clamp((t - st.freeAt) / 0.8, 0.12, 1);          // after a throw or a let-go it comes back softly
      const follow = st.fly > 0 ? 0 : mode === 'none' ? 1.2 : (9 + 10 * g) * (g > 0.5 ? 1 : home);
      if (st.k < 0.02 && mode !== 'none') { st.x = tx; st.y = ty; st.r = tr; }       // it appears where the hands are, it does not fly in from its rest
      st.x = ease(st.x, tx, dt, follow); st.y = ease(st.y, ty, dt, follow); st.r = ease(st.r, tr, dt, 7, 5);
      return { k: st.k, mode, x: st.x, y: st.y, r: st.r, charge: st.charge, charging: st.charging, heat: st.heat, grab: st.grab, grabbing: !!pin, flying: st.fly > 0, vx: st.fly > 0 ? st.fvx : 0, vy: st.fly > 0 ? st.fvy : 0, magnet: st.magnet, dir: st.dir, beam, beamK: st.beam, blast: st.blast, blastAge: t - st.blastAt, events: ev, hands: hs };
    }
    return { step, state: st, params: C };
  }

  return { create, control, measure, poseOf, DEFAULTS, CONTROL };
});
