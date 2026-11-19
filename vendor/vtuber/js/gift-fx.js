// ROUND 5: gift missiles for Ryo and Melanie, the LOGIC (pure UMD: no DOM, no Babylon, no network). js/gifts3d.js draws it.
//
//   const fx = VTGiftFx.create({ map, geo, seed });
//   fx.fire(ev, tSeconds)       the same viewer events the Mask takes (js/mask-wire.js cleanEvent): gift / like / follow /
//                               share / comment. -> 'now' | 'queued' | 'merged' | false (ignored)
//   fx.sample(tSeconds)         everything a frame needs (one reused object, nothing allocated): missiles in the air,
//                               bursts, rings, sparkles, and `react` = what the character does about it
//   fx.missilePos(i, t, out)    where missile i of the last sample was at time t (for its trail)
//
// What a viewer sees: small missiles launch from below the picture, climb into the sky above the character, circle the
// head (behind it too: the 3D head hides them there), then dive in and burst on the face. The character flinches on every
// hit; a mid gift ends in a bigger blast and a shocked face, a big gift in a finale. Then the face is his again.
//
// The gift list is the Mask's (the same rows, the same pick: a gift's name first, then its coin value):
//   chip (small)     2 - 5 missiles, one turn, a pop each, a flinch each
//   barrage (mid)    7 in a train, the last one bigger; the shocked face for a moment
//   grow (big)       10 in a train, all in within a third of a second, a gold detonation: the FINALE (knocked back, shocked)
//   shatter (biggest) two trains of 8 circling against each other, a white-hot finale with three rings and falling embers
//
// NO PILE-UP: at most MAX_AIR missiles are in the air. A wave starts at most every `waveGap` seconds. A big or biggest
// gift has a finale, and finales rest (FINALE_REST): one that arrives too soon WAITS (one waiting per kind; more of the
// same kind merge into it). A small or mid gift that finds the air full waits the same way. Taps: at most 6 sparkles
// a second, however many hundreds arrive.
//
// TikTok's LIVE rules: this module produces no text at all, and nothing here runs by itself. Reactions only.
// Space: "head heights" (crown to chin = 1), origin = the middle of the face on the eye line at the head's centre depth,
// +x picture right, +y up, +z toward the camera.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTGiftFx = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const DEFAULT_GIFT_MAP = [{ upTo: 9, effect: 'chip' }, { upTo: 199, effect: 'barrage' }, { upTo: 999, effect: 'grow' }, { upTo: Infinity, effect: 'shatter' }];
  // brand colours only: crimson, gold, chrome (white-hot). No ice here.
  const CRIMSON = [1.0, 0.13, 0.20], GOLD = [1.0, 0.66, 0.18], CHROME = [1.0, 0.95, 0.90], HOT = [1.0, 0.36, 0.10];
  const MAX_AIR = 24, MAX_BURST = 28, MAX_RING = 6, MAX_SPARKLE = 16, PTS = 26;
  const TIER = {
    //          missiles  size  turns  launch gap  rank  finale  shock s  the least time between two waves of it
    chip: { n: 3, size: 0.8, turns: 1.0, gap: 0.15, rank: 1, finale: 0, shock: 0, rest: 0.4 },
    barrage: { n: 7, size: 1.0, turns: 1.25, gap: 0.12, rank: 2, finale: 1, shock: 0.9, rest: 1.2 },
    grow: { n: 10, size: 1.15, turns: 1.5, gap: 0.09, rank: 3, finale: 2, shock: 1.5, rest: 4.0 },
    shatter: { n: 16, size: 1.25, turns: 2.0, gap: 0.07, rank: 4, finale: 3, shock: 2.2, rest: 6.0 },
  };
  const FLIGHT = { launch: 0.55, turn: 1.25, dive: 0.30 };
  // the head, as the drawing module measured it (defaults = a chibi head); all in head heights
  const GEO = { crown: 0.56, chin: -0.44, halfW: 0.52, faceZ: 0.42, top: 0.93, bottom: -1.55 };
  const SPOTS = [[0, 0.20], [-0.20, -0.10], [0.20, -0.10], [0, -0.06], [0, -0.28], [-0.16, 0.10], [0.16, 0.10]];
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  function create({ map = DEFAULT_GIFT_MAP, seed = 20261119, geo = null } = {}) {
    const G = Object.assign({}, GEO, geo || {});
    let s0 = seed | 0;
    const rnd = () => { s0 = (s0 + 0x6D2B79F5) | 0; let t = Math.imul(s0 ^ (s0 >>> 15), 1 | s0); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const missiles = [], bursts = [], rings = [], sparkles = [], shocks = [], knocks = [], cues = [];
    const waiting = { chip: null, barrage: null, grow: null, shatter: null };
    const lastWave = { chip: -99, barrage: -99, grow: -99, shatter: -99 };
    let lastAny = -99, finaleFreeAt = -99, likeAt = -99, likeStreak = 0, sparkleAt = -99, lastT = -99;
    const stats = { fired: 0, queued: 0, merged: 0, ignored: 0, waves: 0, maxAir: 0 };

    const R = () => clamp(G.halfW * 0.95, 0.42, 0.60);     // round the head itself (the hair's tips may reach further)
    /** one missile: its waypoints (launch, apex, the turns round the head, the spot on the face) and their times */
    function missile(t0, k, { size, turns, dir, col, spot, big = 0 }) {
      const p = new Float32Array(PTS * 3), tt = new Float32Array(PTS), r = R();
      const endA = dir * (0.55 + 0.25 * rnd()), startA = endA - dir * turns * 2 * Math.PI;
      const steps = Math.max(4, Math.min(PTS - 4, Math.round(turns * 8)));
      const yTop = Math.min(G.crown * 0.72, G.top - 0.22), yEnd = 0.10 + 0.10 * rnd();
      let n = 0;
      const put = (x, y, z, t) => { p[n * 3] = x; p[n * 3 + 1] = y; p[n * 3 + 2] = z; tt[n] = t; n++; };
      const side = Math.sin(startA) >= 0 ? 1 : -1, wob = (rnd() - 0.5) * 0.10;
      put(side * (0.30 + 0.25 * rnd()), G.bottom - 0.15, 0.55, 0);
      put(side * (0.42 + wob), Math.min(G.top - 0.10, G.crown + 0.06), 0.30, FLIGHT.launch);
      const orbitT = turns * FLIGHT.turn;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps, a = startA + (endA - startA) * u, rr = r * (1 + 0.06 * Math.sin(u * 9 + k));
        put(rr * Math.sin(a), yTop + (yEnd - yTop) * u * u + 0.03 * Math.sin(u * 11 + k * 2), rr * Math.cos(a), FLIGHT.launch + 0.12 + orbitT * u);
      }
      const dur = FLIGHT.launch + 0.12 + orbitT + FLIGHT.dive;
      put(spot[0], spot[1], G.faceZ, dur);
      return { t0, dur, p, tt, n, size, col, big, seed: rnd(), hitDone: false };
    }
    /** position on the path at local time s (seconds from launch): Catmull-Rom through the waypoints */
    function pathPos(m, s, out, o) {
      const n = m.n, tt = m.tt, p = m.p;
      if (s <= 0) { out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; return out; }
      if (s >= m.dur) { const e = (n - 1) * 3; out[o] = p[e]; out[o + 1] = p[e + 1]; out[o + 2] = p[e + 2]; return out; }
      let i = 0; while (i < n - 2 && tt[i + 1] <= s) i++;
      let u = (s - tt[i]) / (tt[i + 1] - tt[i]);
      if (i === n - 2) u = u * u * (0.6 + 0.4 * u);                              // the dive speeds up into the face
      const i0 = Math.max(0, i - 1) * 3, i1 = i * 3, i2 = (i + 1) * 3, i3 = Math.min(n - 1, i + 2) * 3, u2 = u * u, u3 = u2 * u;
      for (let c = 0; c < 3; c++) {
        const a = p[i0 + c], b = p[i1 + c], d = p[i2 + c], e = p[i3 + c];
        out[o + c] = 0.5 * (2 * b + (d - a) * u + (2 * a - 5 * b + 4 * d - e) * u2 + (3 * b - a - 3 * d + e) * u3);
      }
      return out;
    }
    const air = (t) => { let n = 0; for (const m of missiles) if (t < m.t0 + m.dur) n++; return n; };
    const spotOf = (i) => { const s = SPOTS[i % SPOTS.length]; return [s[0] + (rnd() - 0.5) * 0.08, s[1] + (rnd() - 0.5) * 0.08]; };

    /** start one wave of a tier now */
    function wave(name, t, count) {
      const T = TIER[name];
      let n = name === 'chip' ? clamp(1 + (count || 1), 2, 5) : T.n;
      n = Math.min(n, MAX_AIR - air(t));
      if (n <= 0) return false;
      const dir0 = rnd() < 0.5 ? 1 : -1, spotBase = Math.floor(rnd() * SPOTS.length);
      let lastHit = t;
      for (let i = 0; i < n; i++) {
        const two = name === 'shatter', dir = two ? (i % 2 ? -dir0 : dir0) : dir0, k = two ? Math.floor(i / 2) : i;
        const big = name === 'barrage' && i === n - 1 ? 1 : 0;
        const col = name === 'chip' ? (i % 2 ? CHROME : GOLD) : name === 'barrage' ? (i % 3 === 2 ? GOLD : CRIMSON) : name === 'grow' ? (i % 2 ? GOLD : HOT) : [GOLD, CHROME, CRIMSON][i % 3];
        // a big gift's train closes up at the end: its missiles land within a third of a second
        const late = (name === 'grow' || name === 'shatter') ? k * T.gap * 0.72 : 0;
        const m = missile(t + k * T.gap, i, { size: T.size * (big ? 1.6 : 1), turns: T.turns, dir, col, spot: big ? [0, -0.02] : spotOf(spotBase + i), big });
        if (late > 0) { m.dur -= Math.min(late, m.dur * 0.2); m.tt[m.n - 1] = m.dur; for (let j = 2; j < m.n - 1; j++) m.tt[j] = FLIGHT.launch + 0.12 + (m.dur - FLIGHT.dive - FLIGHT.launch - 0.12) * ((j - 2) / (m.n - 4)); }
        missiles.push(m);
        cues.push({ t: m.t0, kind: 'whoosh', size: m.size, dur: 0.5 }); cues.push({ t: m.t0 + m.dur, kind: 'bang', size: m.size });
        lastHit = Math.max(lastHit, m.t0 + m.dur);
      }
      if (T.finale === 1) { shocks.push({ t0: lastHit, dur: T.shock }); knocks.push({ t0: lastHit, s: 0.55 }); cues.push({ t: lastHit, kind: 'boom', size: 1.0 }); }
      if (T.finale >= 2) {
        const tf = lastHit + 0.10, big3 = T.finale === 3;
        bursts.push({ t0: tf, x: 0, y: -0.04, z: G.faceZ + 0.04, size: big3 ? 3.4 : 2.6, col: big3 ? CHROME : GOLD, kind: 2, seed: rnd() });
        rings.push({ t0: tf, size: big3 ? 1.5 : 1.15, col: big3 ? CHROME : GOLD });
        if (big3) { rings.push({ t0: tf + 0.14, size: 1.2, col: GOLD }); rings.push({ t0: tf + 0.30, size: 0.95, col: CRIMSON }); bursts.push({ t0: tf + 0.05, x: 0, y: 0.05, z: G.faceZ + 0.02, size: 2.2, col: GOLD, kind: 3, seed: rnd() }); }
        shocks.push({ t0: tf, dur: T.shock }); knocks.push({ t0: tf, s: big3 ? 1.0 : 0.8 });
        cues.push({ t: tf - 0.9, kind: 'charge', size: 1.4, dur: 0.9 }); cues.push({ t: tf, kind: 'boom', size: big3 ? 2.4 : 1.5 });
        finaleFreeAt = tf + T.rest;
      }
      lastWave[name] = t; lastAny = t; stats.waves++;
      stats.maxAir = Math.max(stats.maxAir, air(t + 0.01));
      return true;
    }
    /** may a wave of this tier start right now? */
    function free(name, t) {
      const T = TIER[name];
      if (t - lastWave[name] < T.rest || t - lastAny < 0.3) return false;
      if (T.finale >= 2 && t < finaleFreeAt) return false;
      const need = name === 'chip' ? 2 : T.n;
      return air(t) + need <= MAX_AIR;
    }
    /** what is waiting starts as soon as it may (the biggest first) */
    function drain(t) {
      for (const name of ['shatter', 'grow', 'barrage', 'chip']) {
        const w = waiting[name];
        if (w && free(name, t)) { waiting[name] = null; wave(name, t, w.count); }
      }
    }
    const pick = (ev) => {
      const nm = String(ev.gift == null ? '' : ev.gift).trim().toLowerCase(), v = Number(ev.coins != null ? ev.coins : ev.value) || 1;
      return (nm && map.find((r) => r.gift && String(r.gift).toLowerCase() === nm)) || map.find((r) => !r.gift && v <= (r.upTo == null ? Infinity : r.upTo)) || map.filter((r) => !r.gift).pop() || null;
    };
    function sparkle(t, n, big) {
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, r = R() * (0.75 + 0.45 * rnd());
        sparkles.push({ t0: t + i * 0.05, x: r * Math.sin(a) * 0.95, y: clamp(0.05 + 0.75 * Math.cos(a) * 0.9 + 0.1, G.chin, G.top - 0.08), z: G.faceZ * (0.4 + 0.6 * rnd()), size: (big ? 1.5 : 1) * (0.7 + 0.5 * rnd()), col: i % 3 ? GOLD : CHROME });
      }
      if (sparkles.length > 64) sparkles.splice(0, sparkles.length - 48);
    }
    function fire(ev, t) {
      if (!ev || typeof ev.type !== 'string' || !Number.isFinite(t)) return false;
      prune(t); drain(t);
      if (ev.type === 'gift') {
        const row = pick(ev), name = row && TIER[row.effect] ? row.effect : null;
        if (!name) { stats.ignored++; return false; }
        const count = clamp(Number(ev.count) || 1, 1, 9999);
        if (!waiting[name] && free(name, t)) { wave(name, t, count); stats.fired++; return 'now'; }
        if (waiting[name]) { waiting[name].count = Math.min(8, waiting[name].count + count); stats.merged++; return 'merged'; }
        waiting[name] = { count: Math.min(8, count), at: t }; stats.queued++; return 'queued';
      }
      if (ev.type === 'like') {
        likeStreak = likeStreak * Math.exp(-(t - likeAt) / 1.5) + clamp(Number(ev.count != null ? ev.count : ev.value) || 1, 1, 50); likeAt = t;
        if (t - sparkleAt < 1 / 6) return false;
        sparkleAt = t; sparkle(t, likeStreak > 40 ? 3 : likeStreak > 12 ? 2 : 1, false);
        return 'now';
      }
      if (ev.type === 'follow' || ev.type === 'share') {
        if (t - sparkleAt < 0.25) return false;
        sparkleAt = t; sparkle(t, 6, true); rings.push({ t0: t, size: 0.7, col: ev.type === 'follow' ? GOLD : CHROME, soft: 1 });
        return 'now';
      }
      return false;          // comments: nothing on the heroes (chat is not buried under effects)
    }
    function prune(t) {
      const drop = (list, life) => { let k = 0; for (let i = 0; i < list.length; i++) if (t - list[i].t0 < life(list[i])) list[k++] = list[i]; list.length = k; };
      drop(missiles, (m) => m.dur + 0.5); drop(bursts, () => 2.2); drop(rings, () => 1.4); drop(sparkles, () => 0.9); drop(shocks, (s) => s.dur + 0.5); drop(knocks, () => 1.5);
      if (cues.length > 400) cues.splice(0, 200);
    }

    // ---- one frame (everything in `out` is reused)
    const out = {
      nM: 0, mPos: new Float32Array(MAX_AIR * 3), mDir: new Float32Array(MAX_AIR * 3), mSize: new Float32Array(MAX_AIR), mCol: new Float32Array(MAX_AIR * 3), mAge: new Float32Array(MAX_AIR), mLeft: new Float32Array(MAX_AIR),
      nB: 0, bPos: new Float32Array(MAX_BURST * 3), bAge: new Float32Array(MAX_BURST), bSize: new Float32Array(MAX_BURST), bCol: new Float32Array(MAX_BURST * 3), bKind: new Uint8Array(MAX_BURST), bSeed: new Float32Array(MAX_BURST),
      nR: 0, rAge: new Float32Array(MAX_RING), rSize: new Float32Array(MAX_RING), rCol: new Float32Array(MAX_RING * 3), rSoft: new Uint8Array(MAX_RING),
      nS: 0, sPos: new Float32Array(MAX_SPARKLE * 3), sAge: new Float32Array(MAX_SPARKLE), sSize: new Float32Array(MAX_SPARKLE), sCol: new Float32Array(MAX_SPARKLE * 3),
      react: { flinch: 0, shock: 0, brace: 0, knock: 0, shakeX: 0, shakeY: 0, squash: 0, lookX: 0, lookY: 0, look: 0 },
      busy: 0, waiting: 0, t: 0,
    };
    const live = [], tmp = new Float32Array(3);
    function sample(t) {
      if (t !== lastT) { if (Math.floor(t) !== Math.floor(lastT)) prune(t); lastT = t; drain(t); }
      const re = out.react;
      re.flinch = 0; re.shock = 0; re.brace = 0; re.knock = 0; re.shakeX = 0; re.shakeY = 0; re.squash = 0; re.look = 0;
      let nM = 0, nB = 0, lead = -1, leadLeft = 1e9;
      live.length = 0;
      for (const m of missiles) {
        const s = t - m.t0;
        if (s < 0) continue;
        if (s >= m.dur) {
          // it has landed: a burst where it hit (made once), the flinch from it
          if (!m.hitDone) { m.hitDone = true; const e = (m.n - 1) * 3; bursts.push({ t0: m.t0 + m.dur, x: m.p[e], y: m.p[e + 1], z: m.p[e + 2] + 0.02, size: m.size, col: m.col, kind: m.big ? 1 : 0, seed: m.seed }); }
          continue;
        }
        if (nM >= MAX_AIR) continue;
        pathPos(m, s, out.mPos, nM * 3); pathPos(m, Math.max(0, s - 0.02), tmp, 0);
        let dx = out.mPos[nM * 3] - tmp[0], dy = out.mPos[nM * 3 + 1] - tmp[1], dz = out.mPos[nM * 3 + 2] - tmp[2];
        const l = Math.hypot(dx, dy, dz) || 1;
        out.mDir[nM * 3] = dx / l; out.mDir[nM * 3 + 1] = dy / l; out.mDir[nM * 3 + 2] = dz / l;
        out.mSize[nM] = m.size; out.mAge[nM] = s; out.mLeft[nM] = m.dur - s; out.mCol.set(m.col, nM * 3);
        live[nM] = m;
        if (m.dur - s < leadLeft) { leadLeft = m.dur - s; lead = nM; }
        // bracing: the nearer the first landing, the more (mid gifts and up read as "here it comes")
        if (m.size >= 1) re.brace = Math.max(re.brace, clamp(1 - (m.dur - s) / 1.4, 0, 1) * clamp(s / 0.6, 0, 1));
        nM++;
      }
      out.nM = nM;
      if (lead >= 0) { re.lookX = clamp(out.mPos[lead * 3] / 0.6, -1, 1); re.lookY = clamp((out.mPos[lead * 3 + 1] - 0.05) / 0.6, -1, 1); re.look = clamp(out.mAge[lead] / 0.5, 0, 1) * clamp(leadLeft / 0.15, 0, 1); }
      for (const b of bursts) {
        const age = t - b.t0;
        if (age < 0) continue;
        // the hit itself: a flinch that snaps on and lets go, a nod back, a shake
        const k = b.kind >= 2 ? 1.6 : b.kind === 1 ? 1.1 : 0.55 * b.size / 0.8;
        re.flinch += Math.min(1, k) * Math.exp(-age * 6.5) * Math.min(1, age * 40);
        const e = k * Math.exp(-age * 7);
        re.knock += 5.5 * e; re.shakeX += 0.012 * e * Math.sin(age * 46 + b.seed * 40); re.shakeY += 0.010 * e * Math.cos(age * 39 + b.seed * 17);
        if (b.kind >= 2) re.squash += 0.09 * Math.exp(-age * 5) * Math.cos(age * 22);
        if (age > (b.kind >= 2 ? 2.0 : 1.1) || nB >= MAX_BURST) continue;
        out.bPos[nB * 3] = b.x; out.bPos[nB * 3 + 1] = b.y; out.bPos[nB * 3 + 2] = b.z; out.bAge[nB] = age; out.bSize[nB] = b.size; out.bCol.set(b.col, nB * 3); out.bKind[nB] = b.kind; out.bSeed[nB] = b.seed; nB++;
      }
      out.nB = nB;
      for (const k of knocks) { const age = t - k.t0; if (age >= 0) re.knock += 14 * k.s * Math.exp(-age * 3.2) * Math.min(1, age * 25); }
      for (const s of shocks) { const age = t - s.t0; if (age >= 0 && age < s.dur + 0.3) re.shock = Math.max(re.shock, Math.min(1, age / 0.06) * (age < s.dur ? 1 : 1 - (age - s.dur) / 0.3)); }
      re.flinch = clamp(re.flinch, 0, 1) * (1 - 0.85 * re.shock); re.knock = Math.min(re.knock, 20);
      let nR = 0;
      for (const r of rings) { const age = t - r.t0; if (age < 0 || age > 1.1 || nR >= MAX_RING) continue; out.rAge[nR] = age; out.rSize[nR] = r.size; out.rCol.set(r.col, nR * 3); out.rSoft[nR] = r.soft ? 1 : 0; nR++; }
      out.nR = nR;
      let nS = 0;
      for (let i = sparkles.length - 1; i >= 0 && nS < MAX_SPARKLE; i--) { const s = sparkles[i], age = t - s.t0; if (age < 0 || age > 0.7) continue; out.sPos[nS * 3] = s.x; out.sPos[nS * 3 + 1] = s.y + 0.12 * age; out.sPos[nS * 3 + 2] = s.z; out.sAge[nS] = age; out.sSize[nS] = s.size; out.sCol.set(s.col, nS * 3); nS++; }
      out.nS = nS;
      out.waiting = (waiting.chip ? 1 : 0) + (waiting.barrage ? 1 : 0) + (waiting.grow ? 1 : 0) + (waiting.shatter ? 1 : 0);
      out.busy = nM + nB + nR + nS + out.waiting; out.t = t;
      return out;
    }
    /** missile i of the last sample, at another time (its trail) */
    function missilePos(i, t, o, off) { const m = live[i]; return m ? pathPos(m, t - m.t0, o, off || 0) : o; }
    const cuesBetween = (a, b) => cues.filter((c) => c.t >= a && c.t < b);
    return { fire, sample, missilePos, cuesBetween, stats, geo: G, map, air };
  }
  return { create, DEFAULT_GIFT_MAP, TIER, FLIGHT, GEO, MAX_AIR, MAX_BURST, MAX_RING, MAX_SPARKLE, COLORS: { CRIMSON, GOLD, CHROME, HOT } };
});
