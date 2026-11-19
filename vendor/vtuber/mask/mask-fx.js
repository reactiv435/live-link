// V4 MASK: gift and chat effects. Pure UMD, no DOM, no network: it only turns EVENTS into numbers for the particle
// look. Phase 2 feeds it from LIVE Link's TikTok feed; Phase 1 feeds it a scripted list.
//
//   const fx = VTMaskFx.create({ map: VTMaskFx.DEFAULT_GIFT_MAP });
//   fx.fire({ type: 'gift', gift: 'Rose', coins: 1, count: 3, name: 'Sam' }, tSeconds)   -> true, or false when it was ignored
//   fx.fire({ type: 'like', value: 5 }, t)          value = taps in this message
//   fx.fire({ type: 'comment', text: 'hello', name: 'Sam' }, t)
//   fx.fire({ type: 'follow' | 'share', name: 'Sam' }, t)
//   fx.fire({ type: 'command', text: 'boom' | 'grow', name: 'Sam' }, t)
//   const s = fx.sample(t);      everything a frame needs (see sample() below); the same t always gives the same answer
//
// The gift list is plain data, meant to be edited (later from a small settings file): gifts are sorted by their
// coin VALUE, the first row whose `upTo` holds the gift wins.
//   chip     a few small missiles; each chips points off where it lands
//   barrage  a volley on one part of the face: that part is blasted apart and reforms
//   grow     the face grows huge, holds, and comes back
//   shatter  missiles from all sides, the whole face flies apart white-hot, cools through gold to crimson and rebuilds
//
// TikTok's LIVE rules, kept here on purpose: this module never produces text that asks for anything. The only text
// it ever returns is a viewer's display name on a follow / share ring, and "<name> sent <gift>" for a mid gift or
// bigger (recognition after the fact; cut to 18 + 20 characters, shown 2.5 s, at most two at once). Effects
// react to what viewers do; nothing runs by itself, and nothing replaces his live face.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskFx = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const DEFAULT_GIFT_MAP = [
    // a row with `gift` matches that gift by name and wins; rows with `upTo` are the coin ranges (the fallback)
    { upTo: 9, effect: 'chip' },          // a rose, a finger heart
    { upTo: 199, effect: 'barrage' },     // a doughnut, a cap, a hand heart
    { upTo: 999, effect: 'grow' },        // a galaxy-size gift
    { upTo: Infinity, effect: 'shatter' },
  ];
  const COMMANDS = { boom: { cooldown: 8 }, grow: { cooldown: 10 } };
  // places on the face, in the mask's rest space (eye distance = 1, eyes at y = 0, x picture right, z toward the camera)
  const SPOTS = { forehead: [0, 0.62, 0.22], cheekL: [-0.62, -0.55, 0.22], cheekR: [0.62, -0.55, 0.22], nose: [0, -0.45, 0.6], chin: [0, -1.45, 0.3], browL: [-0.5, 0.3, 0.2], browR: [0.5, 0.3, 0.2], jawL: [-0.75, -1.05, 0.0], jawR: [0.75, -1.05, 0.0] };
  // the colours a gift may bring: gold and white-hot from the house palette, crimson-hot, and ONE chosen accent (ice) for the mid gift
  const GOLD = [1.0, 0.62, 0.16], WHITE = [1.0, 0.95, 0.9], ICE = [0.35, 0.95, 1.0], HOT = [1.0, 0.22, 0.08];
  const NI = 10;
  const VISUALIZERS = ['orb', 'tunnel', 'yinyang', 'ridges', 'blackhole', 'helix'];

  function create({ map = DEFAULT_GIFT_MAP, seed = 20261118 } = {}) {
    let s0 = seed | 0;
    const rnd = () => { s0 = (s0 + 0x6D2B79F5) | 0; let t = Math.imul(s0 ^ (s0 >>> 15), 1 | s0); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const missiles = [], impacts = [], scales = [], shatters = [], pulses = [], rings = [], rainbows = [], flashes = [], names = [], kicks = [], glints = [], locks = [], braces = [], cues = [], taps = [], modes = [], forms = [{ t0: -99, f: 'orb' }];
    const last = { comment: [], cmd: {}, likeStreak: 0, likeAt: -9, tapAt: -9 }, streaks = [];

    /** a missile from off screen to a spot on the face; its impact is booked for the moment it lands */
    /**
     * A missile from off screen to a spot on the face; its landing is booked for the moment it arrives. A GIFT missile
     * lands as a small explosion (`blast`: flash, sparks, embers, a ring over the face, a scorch) and is heard (a
     * whoosh, a bang); a comment streak only chips.
     */
    function launch(t0, target, { dur = 0.55, col = GOLD, size = 1, strength = 0.45, radius = 0.30, ret = 3.0, trail = 110, gift = false, from = 0 } = {}) {
      const side = from || (rnd() < 0.5 ? -1 : 1), top = !from && rnd() < 0.3;
      const start = top ? [(rnd() - 0.5) * 4, 3.6 + rnd(), 2 + rnd() * 3] : [side * (3.2 + rnd()), -1.5 + rnd() * 3.5, 2 + rnd() * 3.5];
      const ctrl = [start[0] * 0.35 + (rnd() - 0.5) * 1.2, start[1] * 0.5 + 0.6 + rnd() * 0.8, 2.2 + rnd() * 1.5];
      missiles.push({ t0, dur, start, ctrl, target, col, size, trail, seed: rnd() });
      impacts.push({ t0: t0 + dur, pos: target, r: radius, s: strength, ret, col, size, blast: gift ? size : 0, seed: rnd() });
      if (size >= 1) kicks.push({ t0: t0 + dur, s: (gift ? 0.16 : 0.10) * size });       // every landing nudges the camera; the big ones more (below)
      if (gift) { cues.push({ t: t0, kind: 'whoosh', size, dur }); cues.push({ t: t0 + dur, kind: 'bang', size }); }
    }
    const jitter = (p, j) => [p[0] + (rnd() - 0.5) * j, p[1] + (rnd() - 0.5) * j, p[2]];
    const anySpot = () => { const k = Object.keys(SPOTS); return SPOTS[k[Math.floor(rnd() * k.length)]]; };
    const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    /** the second before a big gift lands: glints gather at the edges of the picture, a ring closes on the face, the face braces */
    function buildUp(t, col, n = 7, len = 1.0) {
      for (let i = 0; i < n; i++) glints.push({ t0: t + i * (len * 0.11), dur: len - i * (len * 0.11) + 0.25, side: i % 2 ? 1 : -1, y: -1.9 + 3.6 * rnd(), col, size: 1.1 + 0.5 * rnd() });
      braces.push({ t0: t, dur: len });
      locks.push({ t0: t + 0.12, dur: len - 0.12, pos: SPOTS.nose, r0: 2.0, r1: 1.05, col });
      cues.push({ t, kind: 'charge', size: 1.6, dur: len });
    }
    const effects = {
      // small: a few missiles, each a crisp little explosion
      chip(t, ev) {
        const n = Math.max(3, Math.min(8, 2 + (Number(ev && ev.count) || 1)));
        for (let i = 0; i < n; i++) launch(t + i * 0.17, jitter(anySpot(), 0.3), { col: GOLD, dur: 0.62, strength: 0.95, radius: 0.42, ret: 2.0, size: 1.15, gift: true });
      },
      // mid: a glint at the edge and a ring on the face (lock-on), a staggered salvo whose explosions WALK across the
      // face, then one bigger blast
      barrage(t) {
        const lines = [[SPOTS.jawL, SPOTS.browR], [SPOTS.jawR, SPOTS.browL], [SPOTS.cheekL, SPOTS.cheekR], [SPOTS.forehead, SPOTS.chin]];
        const [A, B] = lines[Math.floor(rnd() * lines.length)], from = A[0] <= B[0] ? -1 : 1, lock = 0.5;
        glints.push({ t0: t, dur: lock + 0.25, side: from, y: 0.9, col: ICE, size: 1.5 }); glints.push({ t0: t + 0.12, dur: lock + 0.15, side: from, y: -0.4, col: WHITE, size: 1.1 });
        locks.push({ t0: t, dur: lock + 0.1, pos: lerp3(A, B, 0.5), r0: 1.25, r1: 0.55, col: ICE });
        cues.push({ t, kind: 'charge', size: 0.8, dur: lock });
        for (let i = 0; i < 8; i++) launch(t + lock + i * 0.115, jitter(lerp3(A, B, i / 7), 0.14), { col: i % 3 ? ICE : WHITE, dur: 0.55, strength: 0.95, radius: 0.38, ret: 1.9, size: 1.3, gift: true, from });
        const tEnd = t + lock + 8 * 0.115 + 0.18;
        launch(tEnd, lerp3(A, B, 0.55), { col: ICE, dur: 0.5, strength: 1.5, radius: 0.80, ret: 1.25, size: 2.4, gift: true, from, trail: 140 });       // the last one takes the whole part off
        flashes.push({ t0: tEnd + 0.5, col: ICE, a: 0.34, dur: 0.38 }); kicks.push({ t0: tEnd + 0.5, s: 0.85 }); cues.push({ t: tEnd + 0.5, kind: 'boom', size: 1.0 });
      },
      // big: a second of build-up, a salvo that lands together, a detonation, and the face swells from it
      grow(t, ev, peak = 1.45, hold = 1.6) {
        buildUp(t, GOLD, 6);
        const T = t + 1.0;
        for (let i = 0; i < 6; i++) launch(T + i * 0.03, jitter(anySpot(), 0.3), { col: GOLD, dur: 0.55 - i * 0.03, strength: 0.45, radius: 0.36, ret: 2.6, size: 1.6, gift: true });
        impacts.push({ t0: T + 0.55, pos: SPOTS.nose, r: 0.9, s: 0.5, ret: 2.0, col: GOLD, size: 3.0, blast: 3.0, seed: rnd() });
        scales.push({ t0: T + 0.55, peak, up: 0.38, hold, down: 0.7 }); flashes.push({ t0: T + 0.55, col: GOLD, a: 0.5, dur: 0.5 }); rings.push({ t0: T + 0.55, col: GOLD, s: 1 });
        kicks.push({ t0: T + 0.55, s: 0.9 }); cues.push({ t: T + 0.55, kind: 'boom', size: 1.5 });
      },
      // biggest: the same build-up, missiles from all sides, and the whole face is blown apart white-hot, cools and rebuilds
      shatter(t, ev, power = 1.6) {
        buildUp(t, WHITE, 8);
        const T = t + 1.0, k = Object.keys(SPOTS);
        for (let i = 0; i < 14; i++) launch(T + i * 0.012, jitter(SPOTS[k[i % k.length]], 0.3), { col: [GOLD, WHITE, HOT][i % 3], dur: 0.6 - i * 0.012, strength: 0.5, radius: 0.4, ret: 1.4, size: 1.7, trail: 130, gift: true });
        impacts.push({ t0: T + 0.6, pos: SPOTS.nose, r: 1.2, s: 0.6, ret: 1.6, col: WHITE, size: 4.0, blast: 4.0, seed: rnd() });
        shatters.push({ t0: T + 0.6, s: power, ret: 1.7 }); rainbows.push({ t0: T + 0.6, dur: 1.9 });
        flashes.push({ t0: T + 0.6, col: WHITE, a: 0.7, dur: 0.32 }); rings.push({ t0: T + 0.6, col: WHITE, s: 1.3 }); kicks.push({ t0: T + 0.6, s: 1.3 });
        scales.push({ t0: T + 0.6, peak: 1.12, up: 0.2, hold: 0.2, down: 1.2 }); cues.push({ t: T + 0.6, kind: 'boom', size: 2.4 });
      },
    };
    const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
    /** which row of the gift list a gift falls in: its NAME first (when the list names it), else its coin value */
    function pick(ev) {
      const nm = clean(ev.gift, 40).toLowerCase(), v = Number(ev.coins != null ? ev.coins : ev.value) || 1;
      return (nm && map.find((r) => r.gift && String(r.gift).toLowerCase() === nm)) || map.find((r) => !r.gift && v <= (r.upTo == null ? Infinity : r.upTo)) || map.filter((r) => !r.gift).pop() || null;
    }
    /** Face <-> Visualizer (the big button). mode: 'visualizer' | 'face'. The change takes 1.5 s and is a moment in itself. */
    function setMode(mode, t) { const m = mode === 'visualizer' ? 1 : 0; if (modes.length && modes[modes.length - 1].m === m) return false; modes.push({ t0: t, m }); flashes.push({ t0: t + (m ? 0 : 1.15), col: WHITE, a: m ? 0.22 : 0.35, dur: 0.35 }); kicks.push({ t0: t + (m ? 0.05 : 1.2), s: 0.35 }); return true; }
    /** Which formation the Visualizer shows: 'orb' | 'tunnel' | 'yinyang' | 'ridges'. Changed while it is on, the points fly from one into the other (1.3 s). */
    function setVisualizer(name, t) {
      if (!VISUALIZERS.includes(name) || forms[forms.length - 1].f === name) return false;
      forms.push({ t0: t, f: name }); if (forms.length > 8) forms.splice(0, forms.length - 8);
      return true;
    }
    function fire(ev, t) {
      if (!ev || typeof ev.type !== 'string') return false;
      if (ev.type === 'mode') return setMode(ev.mode, t);
      if (ev.type === 'viz') return setVisualizer(ev.name, t);
      if (ev.type === 'gift') {
        const row = pick(ev);
        if (!row || !effects[row.effect]) return false;
        effects[row.effect](t, ev);
        // recognition, for mid gifts and up: who sent what, for 2.5 s. Never a request, never a goal.
        if (row.effect !== 'chip') { const nm = clean(ev.name, 18), gf = clean(ev.gift, 20); if (nm) names.push({ t0: t, text: gf ? nm + ' sent ' + gf : nm, kind: 'gift' }); }
        return true;
      }
      if (ev.type === 'like') {
        // a streak of taps makes each pulse bigger; it cools in about a second
        last.likeStreak = last.likeStreak * Math.exp(-(t - last.likeAt) / 1.2) + (Number(ev.value) || 1); last.likeAt = t;
        pulses.push({ t0: t, s: Math.min(1.6, 0.25 + 0.09 * last.likeStreak) });
        // each batch of taps leaves a glint on the face that ripples through the points (at most 8 a second, however many
        // hundreds arrive), and the streak feeds a glow that builds and fades
        if (t - last.tapAt > 0.125) { last.tapAt = t; taps.push({ t0: t, pos: jitter(anySpot(), 0.5) }); if (taps.length > 64) taps.splice(0, 32); }
        streaks.push({ t0: t, v: Number(ev.value != null ? ev.value : ev.count) || 1 }); if (streaks.length > 400) streaks.splice(0, 200);
        return true;
      }
      if (ev.type === 'comment') {
        last.comment = last.comment.filter((x) => t - x < 1);
        if (last.comment.length >= 6) return false;                      // a flood of chat does not bury the face
        last.comment.push(t);
        launch(t, jitter(anySpot(), 0.4), { col: WHITE, dur: 0.45, strength: 0.16, radius: 0.20, ret: 4.0, size: 0.6, trail: 60 }); return true;
      }
      if (ev.type === 'follow' || ev.type === 'share') {
        rings.push({ t0: t, col: ev.type === 'follow' ? GOLD : WHITE, s: 1 });
        const nm = clean(ev.name, 18);
        if (nm) names.push({ t0: t, text: nm, kind: ev.type });
        return true;
      }
      if (ev.type === 'command') {
        const c = String(ev.text || '').trim().toLowerCase().replace(/^!/, '');
        if (!COMMANDS[c] || (last.cmd[c] !== undefined && t - last.cmd[c] < COMMANDS[c].cooldown)) return false;
        last.cmd[c] = t;
        if (c === 'boom') { kicks.push({ t0: t, s: 0.45 }); shatters.push({ t0: t, s: 0.75, ret: 2.2 }); flashes.push({ t0: t, col: HOT, a: 0.35, dur: 0.3 }); rings.push({ t0: t, col: HOT, s: 0.8 }); }
        else { scales.push({ t0: t, peak: 1.25, up: 0.38, hold: 1.1, down: 0.7 }); rings.push({ t0: t, col: GOLD, s: 0.8 }); }
        return true;
      }
      return false;
    }

    /**
     * -> { imp: Float32Array(NI * 4) [x, y, z, radius], impT: Float32Array(NI * 4) [age, strength, return rate, 0],
     *      impC: Float32Array(NI * 3), nImp, shatter, rainbow (the heat of a shatter: 1 white-hot -> gold -> 0 crimson), pulse, scale,
     *      ring: [age, strength], ringCol, flash: [r, g, b, a], kick: [x, y, strength] (a short camera shake),
     *      missiles: [{ u (above 1 = landed, trail burning out), start, ctrl, target, col, size, trail, seed }],
     *      bursts: [{ pos, age, s, col, size, blast, seed }] (a landing; blast > 0 = a gift: an explosion), glints: [{ side, y, k, col, size }],
     *      lock: { pos, r, a, col } | null (a ring closing on the face), brace (0..1, the face before a big gift),
     *      names: [{ text, kind: 'follow' | 'share' | 'gift', age }], busy }
     */
    function sample(t) {
      const out = { imp: new Float32Array(NI * 4), impT: new Float32Array(NI * 4), impC: new Float32Array(NI * 3), shatter: 0, rainbow: 0, pulse: 0, scale: 1, ring: [99, 0], ringCol: GOLD, flash: [0, 0, 0, 0], missiles: [], bursts: [], glints: [], lock: null, brace: 0, taps: new Float32Array(24), streak: 0, viz: 0, kick: [0, 0, 0], nImp: 0, names: [], busy: 0 };
      let n = 0;
      for (let i = impacts.length - 1; i >= 0 && n < NI; i--) {
        const m = impacts[i], age = t - m.t0;
        if (age < 0 || age > 5) continue;
        out.imp.set([m.pos[0], m.pos[1], m.pos[2], m.r], n * 4); out.impT.set([age, m.s, m.ret, m.blast || 0], n * 4); out.impC.set(m.col, n * 3); n++;
      }
      out.nImp = n;
      for (const m of impacts) { const age = t - m.t0; if (age >= 0 && age < (m.blast ? 1.7 : 0.32)) out.bursts.push({ pos: m.pos, age, s: m.s, col: m.col, size: m.size || 1, blast: m.blast || 0, seed: m.seed || 0 }); }      // each landing: a flash; a gift: an explosion
      for (const m of glints) { const age = t - m.t0; if (age >= 0 && age < m.dur) out.glints.push({ side: m.side, y: m.y, k: age / m.dur, col: m.col, size: m.size }); }
      for (const m of locks) { const age = t - m.t0; if (age >= 0 && age < m.dur) { const k = age / m.dur, e = 1 - (1 - k) * (1 - k); out.lock = { pos: m.pos, r: m.r0 + (m.r1 - m.r0) * e, a: Math.min(1, k * 4) * (k > 0.85 ? (1 - k) / 0.15 : 1), col: m.col }; } }
      for (const m of braces) { const age = t - m.t0; if (age >= 0 && age < m.dur + 0.12) out.brace = Math.max(out.brace, age < m.dur ? Math.pow(age / m.dur, 0.7) : 1 - (age - m.dur) / 0.12); }
      out.scale *= 1 - 0.07 * out.brace;
      let nt = 0;
      for (let i = taps.length - 1; i >= 0 && nt < 6; i--) { const age = t - taps[i].t0; if (age >= 0 && age < 1.3) { out.taps.set([taps[i].pos[0], taps[i].pos[1], taps[i].pos[2], age], nt * 4); nt++; } }
      for (let k = nt; k < 6; k++) out.taps[k * 4 + 3] = 99;
      let sv = 0; for (const m of streaks) { const age = t - m.t0; if (age >= 0 && age < 6) sv += m.v * Math.exp(-age / 1.6); }
      out.streak = 1 - Math.exp(-sv / 14);                                // builds with a streak, saturates: hundreds of taps are a full glow, not noise
      // Face <-> Visualizer: 0 = his face, 1 = the visualizer; eased over 1.5 s from the press
      let v = 0; for (const m of modes) { const age = t - m.t0; if (age < 0) break; const k = Math.min(1, age / 1.5), e = k * k * (3 - 2 * k); v = m.m ? Math.max(v, e) * 1 + (1 - Math.max(v, e)) * 0 : v * (1 - e); if (m.m) v = Math.max(v, e); }
      out.viz = v;
      // the formation: [now, the one it is leaving, how far (0..1)]
      let fi = 0; for (let i = 0; i < forms.length; i++) if (forms[i].t0 <= t) fi = i;
      const fk = Math.min(1, (t - forms[fi].t0) / 1.3);
      out.form = [forms[fi].f, fi > 0 ? forms[fi - 1].f : forms[fi].f, fi > 0 && v > 0 ? fk : 1];
      for (const m of kicks) { const age = t - m.t0; if (age >= 0 && age < 0.9) { const e = m.s * Math.exp(-age * 6.5); out.kick[0] += e * Math.sin(age * 41 + m.t0 * 7); out.kick[1] += e * Math.cos(age * 33 + m.t0 * 5); out.kick[2] += e; } }
      for (let k = n; k < NI; k++) out.impT[k * 4] = 99;
      for (const m of missiles) { const age = t - m.t0; if (age >= 0 && age < m.dur + 0.45) out.missiles.push({ u: age / m.dur, ...m }); }      // u > 1: it has landed, its trail is still burning out
      for (const m of shatters) { const age = t - m.t0; if (age > 0) out.shatter += m.s * (Math.exp(-age * m.ret) - Math.exp(-age * 15)); }
      for (const m of rainbows) { const age = t - m.t0; if (age > 0 && age < m.dur) out.rainbow = Math.max(out.rainbow, Math.min(1, age * 8) * Math.pow(1 - age / m.dur, 1.5)); }
      for (const m of pulses) { const age = t - m.t0; if (age >= 0) out.pulse += m.s * Math.exp(-age * 5.5); }
      for (const m of scales) {
        const age = t - m.t0; if (age < 0 || age > m.up + m.hold + m.down) continue;
        let k;
        if (age < m.up) { const x = age / m.up - 1, c = 1.9; k = 1 + (c + 1) * x * x * x + c * x * x; }           // out, a little past, back (ease-out-back)
        else if (age < m.up + m.hold) k = 1;
        else { const x = (age - m.up - m.hold) / m.down; k = 1 - x * x * (3 - 2 * x); }
        out.scale *= 1 + (m.peak - 1) * k;
      }
      for (const m of rings) { const age = t - m.t0; if (age >= 0 && age < out.ring[0]) { out.ring = [age, m.s]; out.ringCol = m.col; } }
      for (const m of flashes) { const age = t - m.t0; if (age >= 0 && age < m.dur) { const a = m.a * (1 - age / m.dur); if (a > out.flash[3]) out.flash = [m.col[0], m.col[1], m.col[2], a]; } }
      for (const m of names) { const age = t - m.t0; if (age >= 0 && age < 2.5) out.names.push({ text: m.text, kind: m.kind, age }); }
      if (out.names.length > 2) out.names = out.names.slice(-2);          // never a wall of names
      out.busy = out.missiles.length + n;
      return out;
    }
    /** the gift sounds that start in [a, b): [{ t, kind: 'whoosh' | 'bang' | 'boom' | 'charge', size, dur }] (mask-sfx.js plays them) */
    const cuesBetween = (a, b) => cues.filter((c) => c.t >= a && c.t < b);
    return { fire, sample, setMode, setVisualizer, cuesBetween, map };
  }
  return { create, DEFAULT_GIFT_MAP, COMMANDS, SPOTS, VISUALIZERS };
});
