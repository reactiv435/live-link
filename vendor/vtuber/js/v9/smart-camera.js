// V9 SMART CAMERA: a virtual camera round the Mask that cuts with the music like a TV director. His ask (11-25):
// "our camera doesn't have to be right in front of us ... cut to the side or above or down in that virtual space";
// his pick: STRAIGHT ON in verses, a CUT to the side, above or below on drops and section changes.
// OPT-IN, off by default. Off = mask-live.js holds no camera = the Mask draws exactly what it drew before.
// Pure numbers (UMD, no DOM): the avatar page, the try page, the render tool and the tests run the same code.
//
// THE GLUE (mask-live.js makes one the first time he switches it on):
//   const cam = VTSmartCam.create({ seed });
//   cam.setOn(true | false)
//   cam.audio(f, t)                      every music frame the Mask hears ({ bass, mid, high, beat, kick, hit, level, bright })
//   cam.frame(t, dt, scene, stage, style) once per drawn frame, before the scene is drawn. It gives the scene
//                                        * scene.cam: the hook mask-looks.js calls with its camera (the eye is moved
//                                          round the point the camera looks at; nothing else of the camera changes)
//                                        * his HANDS (scene.hfx) the camera they had without it: they are his real
//                                          hands in the picture plane, in front, and never swing with the camera
//                                        * the style (scene.v9) a far eye whose glow fades by angle (the glow is drawn
//                                          without depth: from the side it would show through the nose)
//   cam.aside(reason, on)                the page asks it to stand straight on (the countdown ...)
//   cam.fire('drop' | 'section')         the try page's buttons (a cut still waits for a beat and the 2 s rule)
//   cam.stats()                          what the director is doing: shot, why, hold left, tempo ...
//
// THE DIRECTOR alone (the tests drive it with made-up music):
//   const dir = VTSmartCam.createDirector({ seed });
//   dir.audio(f, t); const pose = dir.step(t, dt, { aside: '' | reason, head: [x, y, z] (where his face points) | null });
//   pose = { yaw, pitch (degrees; + = the camera to the picture's right / above), dist (x the camera's distance), shot, label, why, kind, cut }
// How it decides:
//   * verses and calm parts: straight on, a slow breathing drift;
//   * a DROP (the beat clock's drop: the bass was away, a strong kick brings it back) or a SECTION CHANGE (the energy of
//     the last bar against the four before it; the clock's phrase lines make it surer): a cut to a new angle (the side,
//     above, below, a low hero shot, a tight push-in);
//   * it holds for a phrase (4 bars at the song's tempo, 8 when 4 bars are under 5 s; 6-10 s without a tempo), then
//     cuts on (still loud) or eases back (calm);
//   * cuts land on a beat (a phrase's end waits for the bar line); never two within 2 s; never the same angle twice in a row;
//   * a build (the bass away, or the energy rising bar after bar) pushes in slowly; between songs: straight on;
//   * mostly hard cuts, now and then a quick whip or a slow orbit; nothing swings fast for long;
//   * STEP ASIDE (the boss fight, an album eat, a chat vote, the score, the countdown / transform, the Visualizer):
//     back straight on and held.
// Limits: within 50 degrees left / right and 30 above / below; never more than 54 / 34 degrees from where his FACE
// points (the face is a mask, not a whole head: its edge shows past about 60), so never behind the head.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTSmartCam = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';
  const D = Math.PI / 180;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  const fin = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const sine = (u) => 0.5 - 0.5 * Math.cos(Math.PI * u);
  const cubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const mod = (a, n) => ((a % n) + n) % n;
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function findBeat() {
    if (root.VTBeat && root.VTBeat.createClock) return root.VTBeat;
    try { if (typeof require === 'function') return require('../beat-clock.js'); } catch (e) { /* no clock: kicks only */ }
    return null;
  }

  // ---------------------------------------------------------------- the shots (yaw + = the camera to the picture's right, pitch + = above)
  const SHOTS = {
    front: { yaw: 0, pitch: 0, dist: 1.00, label: 'STRAIGHT ON', side: 0 },
    sideL: { yaw: -44, pitch: 4, dist: 0.94, label: 'SIDE LEFT', side: -1 },
    sideR: { yaw: 44, pitch: 4, dist: 0.94, label: 'SIDE RIGHT', side: 1 },
    above: { yaw: 9, pitch: 26, dist: 0.97, label: 'ABOVE', side: 1 },
    below: { yaw: -7, pitch: -21, dist: 0.95, label: 'BELOW', side: -1 },
    heroL: { yaw: -27, pitch: -16, dist: 0.86, label: 'LOW HERO LEFT', side: -1 },
    heroR: { yaw: 27, pitch: -16, dist: 0.86, label: 'LOW HERO RIGHT', side: 1 },
    push: { yaw: 4, pitch: 3, dist: 0.74, label: 'PUSH-IN', side: 0 },
  };
  const LIM = { yaw: 50, pitch: 30, relYaw: 54, relPitch: 34, distMin: 0.66, distMax: 1.1, gap: 2.0 };
  // which shots a moment asks for, and how much
  const WANT = {
    drop: { sideL: 3, sideR: 3, heroL: 3, heroR: 3, below: 1.5, above: 1.5, push: 1 },
    up: { sideL: 2.5, sideR: 2.5, above: 2, heroL: 2, heroR: 2, below: 1, push: 1.5 },
    down: { front: 5, push: 2 },
    phrase: { front: 10, sideL: 2, sideR: 2, above: 1.5, below: 1.2, heroL: 1.5, heroR: 1.5, push: 1.2 },
  };
  // the glow of an eye fades by the angle between where the eye looks (a little out to its own side) and the camera.
  // open: the lid opening at which the styles' eye light starts and is full (sstep(0.13, 0.40, open) in mask-v9.js and mask-cables.js)
  const EYE = { out: 15, from: 60, to: 72, open: [0.13, 0.40] };
  const T = {
    silence: 0.06, silentAfter: 1.2, noAudio: 1.0,  // between songs: the level under this for 1.2 s, or no music frames for 1 s
    hotK: 0.75, hotMin: 0.40,                       // loud = the last two bars at 75 % of the song's loudest, and not quiet at all
    upTh: 0.24, phraseTh: 0.16, dropRise: 0.36,      // a section change: the last bar against the four before (of the song's loudest); this much up = a drop
    awayK: 0.42, awayFor: 1.0, dropAway: 1.5,        // the bass "away": under 42 % of its loudest
    pushIn: 7, pushOut: 1.5, pushAmt: 0.18,          // the slow push of a build: 7 s to full, 18 % closer
    beatWait: 2.0, downWait: 2.4,                    // a cut waits at most this long for a beat (for a bar line: this long)
    kickOn: 0.3, kickWait: 1.2,                      // a cut lands on a KICK heard (its first picture); the clock's beat only when no kick comes for 1.2 s
  };

  /** a soft limit: x as it is up to lim - 8, then bending smoothly to lim */
  const soft = (x, lim) => { const a = Math.abs(x), k = lim - 8; return a <= k ? x : Math.sign(x) * (k + 8 * Math.tanh((a - k) / 8)); };

  function createDirector(o) {
    o = o || {};
    const R = rng(o.seed || 7);
    const Beat = o.beat !== undefined ? o.beat : findBeat();
    // (spread: the clock's tempo scan cut over 8 music frames, so no frame of the render thread pays for all of it at once)
    let clock = Beat ? Beat.createClock({ spread: o.spread === undefined ? 8 : o.spread }) : null;
    const M = { prevT: null, lastAudioT: -99, silentFor: 9, e: 0, peak: 0.12, bassE: 0, bassPeak: 0.1, away: 0, locked: false, bpm: 0, k: null,
      barSum: 0, barDur: 0, bars: [], lastSection: -99, lastDrop: -99, lastUp: -99, lastDown: -99, beat: false, down: false, beatAt: -99, events: [], build: false, push: 0, rising: false, seen: 0,
      kick: false, kickAt: -99, prevKick: 0, downAt: -99 };
    const C = { shot: 'front', prev: '', lastSide: 0, since: 0, holdEnd: Infinity, hold: 8, loudWait: 16, move: null, lastCut: -99, cuts: 0, why: 'start', kind: 'cut', mode: 'calm',
      pend: null, drift: { yaw: 3, dist: 0.03 }, head: [0, 0, 1], t: null, asideWhy: '', asideEnd: -99, log: [], cutNow: false, pose: null, base: null, lastMove: -99, fresh: true };

    // ---------------------------------------------------------------- the music
    /** a new song (between songs, time going back, the camera switched off): nothing of the last one is kept, its loudness neither
     *  (the build's push is the camera's: it eases out by itself, never all at once) */
    function resetMusic() {
      if (clock && clock.reset) clock.reset();
      M.bars = []; M.barSum = 0; M.barDur = 0; M.events = []; M.away = 0; M.locked = false; M.bpm = 0; M.k = null; M.build = false; M.rising = false; M.prevT = null;
      M.e = 0; M.peak = 0.12; M.bassE = 0; M.bassPeak = 0.1; M.seen = 0; M.lastSection = M.lastDrop = M.lastUp = M.lastDown = -99; M.kick = false; M.beat = false; M.down = false; M.prevKick = 0;
    }
    /** a musical phrase: 4 bars at the song's tempo (8 when 4 bars are under 5 s; `long` = now and then 8 for variety), else 6-10 s */
    function phrase(long) {
      if (M.locked && M.bpm > 30) { const bar = 240 / M.bpm, n = 4 * bar < 5 || (long && 8 * bar <= 16) ? 8 : 4; return { sec: n * bar, bars: n }; }
      return { sec: 6 + 4 * R(), bars: 0 };
    }
    const barSec = () => (M.locked && M.bpm > 30 ? 240 / M.bpm : 2);
    function pushBar(mean, t, k) {
      M.bars.push(mean); if (M.bars.length > 24) M.bars.shift();
      const n = M.bars.length, pk = Math.max(M.peak, 0.15), bar = M.locked && M.bpm > 30 ? 240 / M.bpm : 2;
      M.rising = n >= 3 && M.bars[n - 1] > M.bars[n - 2] + 0.03 * pk && M.bars[n - 2] > M.bars[n - 3] + 0.03 * pk && M.bars[n - 1] < 0.85 * pk;      // (rising to the song's loudest is the drop, not a build)
      if (n < 5 || t - M.lastDrop < 4 * bar) return;
      let b = 0; for (let i = n - 5; i < n - 1; i++) b += M.bars[i] / 4;
      const rel = (M.bars[n - 1] - b) / pk;
      // the bar that just ended began a phrase (the clock has heard where this song's phrases start): a change is surer there
      const line = !!(k && k.locked && k.anchor === 'heard' && mod(k.bar - 1, 4) === 0);
      if (Math.abs(rel) <= (line ? T.phraseTh : T.upTh)) return;
      const up = rel > 0;
      // the same way again only after 4 bars; the other way (a break, and back) after one
      if (t - (up ? M.lastUp : M.lastDown) < 4 * bar - 0.05 || t - (up ? M.lastDown : M.lastUp) < bar - 0.05) return;
      // a big rise after a break (or a very big one) is the drop, even when the bass was never away long enough for the clock to call one
      const drop = up && (rel > T.dropRise || t - M.lastDown < 12 * bar);
      M.events.push({ kind: drop ? 'drop' : up ? 'up' : 'down', t, rel });
      if (up) M.lastUp = t; else M.lastDown = t;
      M.lastSection = t; if (drop) M.lastDrop = t;
    }
    function audio(f, t) {
      if (!f || typeof f !== 'object') return;
      t = fin(t, M.prevT === null ? 0 : M.prevT + 1 / 60);
      if (M.prevT !== null && t < M.prevT - 1) resetMusic();
      const dt = M.prevT === null ? 1 / 60 : clamp(t - M.prevT, 0, 0.25); M.prevT = t; M.lastAudioT = t;
      const level = clamp(fin(f.level, 0), 0, 2), bass = clamp(fin(f.bass, 0), 0, 2), high = clamp(fin(f.high, 0), 0, 2), kick = clamp(fin(f.kick, 0), 0, 2), hit = clamp(fin(f.hit, 0), 0, 2);
      M.silentFor = level < T.silence ? M.silentFor + dt : 0;
      const E = 0.40 * level + 0.35 * bass + 0.25 * high, a = 1 - Math.exp(-dt / 0.5), b = 1 - Math.exp(-dt / 0.6), slow = Math.exp(-dt / 45);
      M.e += (E - M.e) * a; M.peak = Math.max(M.peak * slow, M.e, 0.12);
      M.bassE += (bass - M.bassE) * b; M.bassPeak = Math.max(M.bassPeak * slow, M.bassE, 0.1);
      const awayWas = M.away;
      M.away = M.bassE < T.awayK * M.bassPeak && level >= T.silence ? M.away + dt : 0;
      M.seen += level >= T.silence ? dt : 0;
      let k = null;
      if (clock) { try { k = clock.push(f, t); } catch (e) { k = null; } }
      M.k = k; M.locked = !!(k && k.locked && !k.silent); if (M.locked) M.bpm = fin(k.bpm, 0);
      // the beat (and the bar line): the clock's when it has the tempo, else every kick
      const isBeat = M.locked ? !!k.beat : kick >= 0.3;
      if (isBeat) { M.beat = true; M.down = M.down || (M.locked ? k.inBar === 0 : true); M.beatAt = t; if (M.locked ? k.inBar === 0 : true) M.downAt = t; }
      // a kick heard (its onset): where a cut lands
      if (kick >= T.kickOn && M.prevKick < T.kickOn) { M.kick = true; M.kickAt = t; }
      M.prevKick = kick;
      // a bar: the clock's bar lines, else every 2 s (none in the silence between songs: the next song is not heard "rising" out of it)
      if (M.silentFor >= T.silentAfter) { M.barSum = 0; M.barDur = 0; }
      else { M.barSum += E * dt; M.barDur += dt; }
      if ((M.locked ? !!(k.beat && k.inBar === 0) : M.barDur >= 2) && M.barDur > 0.5) { pushBar(M.barSum / M.barDur, t, k); M.barSum = 0; M.barDur = 0; }
      // a drop: the clock's, or (no clock drop near) the bass back with a strong kick after it was away 1.5 s
      const clockDrop = !!(k && k.boundary === 'drop');      // (an event from a bar line above may already be the drop: then not twice)
      const ownDrop = !clockDrop && Math.max(awayWas, M.away) >= T.dropAway && bass >= 0.6 * M.bassPeak && (kick >= 0.5 || hit >= 0.5);
      const evDrop = M.events.some((e) => e.kind === 'drop' && e.t === t);
      if (evDrop) M.lastDrop = t;
      else if ((clockDrop || ownDrop) && t - M.lastDrop > 4) { M.events.push({ kind: 'drop', t }); M.lastDrop = t; M.lastUp = t; M.lastSection = t; M.away = 0; }
      M.build = (M.away >= T.awayFor && level > 0.2) || M.rising;
    }
    /** the try page's buttons */
    function fire(kind, t) { M.events.push({ kind: kind === 'drop' ? 'drop' : 'up', t: fin(t, M.lastAudioT), forced: true }); if (kind === 'drop') M.lastDrop = fin(t, M.lastAudioT); }

    // ---------------------------------------------------------------- the camera
    const shotPose = (name, t) => {
      const s = SHOTS[name] || SHOTS.front;
      let yaw = s.yaw, pitch = s.pitch, dist = s.dist;
      const h = clamp((t - C.since) / Math.max(1, C.hold), 0, 1);
      if (name === 'front') {      // straight on: a slow breathing drift
        yaw += 2.0 * Math.sin(t * 0.21) + 0.8 * Math.sin(t * 0.077 + 2);
        pitch += 1.2 * Math.sin(t * 0.16 + 1.3);
        dist *= 1 + 0.012 * Math.sin(t * 0.27);
      } else {                     // on an angle: it creeps (a few degrees and a few per cent over the whole hold), eased in and out: never a linear pan
        const e = sine(h);
        yaw += C.drift.yaw * (e - 0.5) * 2;
        dist *= 1 - C.drift.dist * e;
      }
      return { yaw, pitch, dist };
    };
    function poseNow(t) {
      const to = shotPose(C.shot, t), m = C.move;
      if (!m || m.dur <= 0) return to;
      const u = clamp((t - m.t0) / m.dur, 0, 1), e = m.kind === 'whip' ? cubic(u) : sine(u);
      if (u >= 1) { C.move = null; return to; }
      return { yaw: m.from.yaw + (to.yaw - m.from.yaw) * e, pitch: m.from.pitch + (to.pitch - m.from.pitch) * e, dist: m.from.dist + (to.dist - m.from.dist) * e };
    }
    function go(name, t, kind, why, counts, long) {
      // a move starts where the camera was BEFORE the build's push and the limits (they are laid on after, each picture):
      // so the push is never counted twice, and a push that ends here is kept in the start (no jump in the size of him)
      const pushWas = C.pose ? fin(C.pose.push, 0) : 0;
      if (!(M.build && (name === 'front' || name === 'push'))) M.push = 0;      // (a build goes on pushing in across a cut back straight on)
      const b = C.base || poseNow(t), keep = (1 - T.pushAmt * pushWas) / Math.max(0.05, 1 - T.pushAmt * sstep(0, 1, M.push));
      const from = { yaw: b.yaw, pitch: b.pitch, dist: b.dist * keep };
      const dur = kind === 'whip' ? 0.24 : kind === 'orbit' ? 2.4 : kind === 'ease' ? 1.3 : kind === 'aside' ? 0.5 : 0;
      C.prev = C.shot; C.shot = name; C.since = t; C.why = why; C.kind = kind;
      C.move = dur > 0 ? { from, t0: t, dur, kind } : null;
      const ph = phrase(long); C.hold = ph.sec; C.holdBars = ph.bars; C.loudWait = 2 * phrase(false).sec;
      C.holdEnd = name === 'front' ? Infinity : t + ph.sec;
      C.drift = { yaw: (R() < 0.5 ? -1 : 1) * (2.5 + 2 * R()), dist: 0.02 + 0.025 * R() };
      if (SHOTS[name].side) C.lastSide = SHOTS[name].side;
      if (counts !== false) { C.lastCut = t; C.cuts++; C.cutNow = true; }
      C.lastMove = t;      // (every move, an ease back straight on too: the next cut is 2 s after it at the soonest)
      C.log.push({ t: +t.toFixed(3), shot: name, kind, why, cut: counts !== false }); if (C.log.length > 40) C.log.shift();
    }
    function choose(want) {
      const names = Object.keys(want).filter((n) => n !== C.shot);
      let pool = names.filter((n) => n !== C.prev); if (!pool.length) pool = names;
      let sum = 0; const w = pool.map((n) => { const s = SHOTS[n].side, x = want[n] * (s && s === C.lastSide ? 0.5 : 1); sum += x; return x; });
      let r = R() * sum; for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i]; }
      return pool[pool.length - 1];
    }
    const hot = () => { const n = M.bars.length; const v = n >= 2 ? (M.bars[n - 1] + M.bars[n - 2]) / 2 : M.e; return v >= Math.max(T.hotK * M.peak, T.hotMin) && M.seen > 6; };

    function step(t, dt, ctx) {
      t = fin(t, C.t === null ? 0 : C.t); dt = clamp(fin(dt, 0), 0, 10);
      if (C.t !== null && t < C.t - 0.5) { C.move = null; C.since = t; C.lastCut = -99; C.lastMove = -99; C.holdEnd = C.shot === 'front' ? Infinity : t + C.hold; C.pend = null; }
      if (C.fresh) { C.fresh = false; C.since = t; C.asideEnd = t; }      // (just made, or switched on again: straight on counts from now, and no cut in its first 2 s)
      C.t = t; C.cutNow = false;
      const de = Math.min(dt, 0.25);
      // where his face points (smoothed; lost = slowly back to the front)
      const hd = ctx && ctx.head, ok = hd && hd.length >= 3 && Number.isFinite(hd[0]) && Number.isFinite(hd[1]) && Number.isFinite(hd[2]) && Math.hypot(hd[0], hd[1], hd[2]) > 0.5;
      const want = ok ? (() => { const l = Math.hypot(hd[0], hd[1], hd[2]); return [hd[0] / l, hd[1] / l, hd[2] / l]; })() : [0, 0, 1];
      const hk = 1 - Math.exp(-de / (ok ? 0.35 : 1.5)); for (let i = 0; i < 3; i++) C.head[i] += (want[i] - C.head[i]) * hk;
      const aside = ctx && ctx.aside ? String(ctx.aside) : '';
      const live = t - M.lastAudioT < T.noAudio && M.silentFor < T.silentAfter;
      const beat = M.beat, down = M.down, kickNow = M.kick; M.beat = false; M.down = false; M.kick = false;
      M.push = M.build && live && !aside ? Math.min(1, M.push + de / T.pushIn) : Math.max(0, M.push - de / T.pushOut);
      if (aside) {
        C.mode = 'aside'; C.asideWhy = aside; C.asideEnd = t; C.pend = null; M.events = [];
        if (C.shot !== 'front') go('front', t, 'aside', 'step aside: ' + aside, false);
      } else if (!live) {
        if (C.mode !== 'between') resetMusic();      // the next song starts from nothing (no "drop" out of the silence)
        C.mode = 'between'; C.pend = null; M.events = [];
        if (C.shot !== 'front') go('front', t, 'ease', 'between songs', false);
      } else {
        C.mode = M.build ? 'build' : hot() ? 'loud' : 'calm';
        // what the music asks for
        for (const ev of M.events.splice(0)) {
          if (ev.kind === 'drop') C.pend = { to: choose(WANT.drop), why: 'the drop', at: t, down: false, kind: R() < 0.12 ? 'whip' : 'cut' };
          else if (ev.kind === 'up') {
            if (C.shot === 'front' || t - C.since > 0.5 * C.hold || ev.forced) C.pend = C.pend && C.pend.why === 'the drop' ? C.pend : { to: choose(WANT.up), why: 'section change', at: t, down: false, kind: C.shot !== 'front' && R() < 0.15 ? 'whip' : R() < 0.12 ? 'orbit' : 'cut' };
          // calmer: it waits a whole bar first (a one-bar break before the music comes back is not a verse: no cut there and back)
          } else if (ev.kind === 'down' && C.shot !== 'front') C.pend = C.pend && C.pend.why === 'the drop' ? C.pend : { to: R() < 0.3 && C.shot !== 'push' ? 'push' : 'front', why: 'section change (calmer)', at: t + barSec(), down: false, kind: 'cut' };
        }
        // a phrase has run out: on while it is loud, else back straight on
        if (!C.pend) {
          const loud = hot();
          if (C.shot !== 'front' && t >= C.holdEnd - 0.05) C.pend = loud ? { to: choose(WANT.phrase), why: 'next phrase', at: t, down: true, kind: R() < 0.12 ? 'whip' : R() < 0.22 ? 'orbit' : 'cut', long: R() < 0.5 } : { to: 'front', why: 'calm: back straight on', at: t, down: true, kind: 'ease' };
          // straight on while it stays loud: two phrases, then an angle
          else if (C.shot === 'front' && loud && t - C.since >= C.loudWait - 0.05 && t - C.lastCut >= C.loudWait - 0.05) C.pend = { to: choose(WANT.up), why: 'loud: next phrase', at: t, down: true, kind: R() < 0.15 ? 'orbit' : 'cut' };
        }
        // a cut lands on a beat (a phrase's end on a bar line), never within 2 s of the last, never in the 2 s after stepping aside
        const P = C.pend;
        if (P) {
          if (P.to === C.shot) C.pend = null;
          else if (t - Math.max(C.lastCut, C.lastMove) >= LIM.gap && t - C.asideEnd >= LIM.gap) {
            // on the kick itself: the first kick heard once it is wanted (a phrase is whole bars from the last cut, which was on
            // a kick: so its first kick is the bar line's); the clock's beat (its bar line for a phrase) only when no kick comes
            const waited = t - Math.max(P.at, Math.max(C.lastCut, C.lastMove) + LIM.gap, C.asideEnd + LIM.gap), onKick = kickNow;      // (waited: since a cut is allowed)
            const drop = P.why === 'the drop', onBeat = waited > (drop ? T.beatWait : T.kickWait) && beat && (!P.down || down || waited > T.downWait);      // (the drop waits longer for its kick)
            if (waited >= 0 && (onKick || onBeat || waited > T.beatWait + (P.down ? T.downWait : drop ? 0.6 : 0))) { go(P.to, t, P.kind, P.why, true, P.long); C.pend = null; }
          } else if (t - P.at > 6) C.pend = null;                      // too old: dropped
        }
      }
      // the pose: the shot (and its move), the build's push, the limits
      let p = poseNow(t);
      C.base = { yaw: fin(p.yaw, 0), pitch: fin(p.pitch, 0), dist: fin(p.dist, 1) };      // (where a move starts from: before the push and the limits)
      const pushK = sstep(0, 1, M.push);
      let yaw = fin(p.yaw, 0), pitch = fin(p.pitch, 0), dist = fin(p.dist, 1) * (1 - T.pushAmt * pushK);
      yaw = clamp(yaw, -LIM.yaw, LIM.yaw); pitch = clamp(pitch, -LIM.pitch, LIM.pitch);
      const hy = Math.atan2(C.head[0], C.head[2]) / D, hp = Math.asin(clamp(C.head[1] / (Math.hypot(C.head[0], C.head[1], C.head[2]) || 1), -1, 1)) / D;
      if (Number.isFinite(hy) && Number.isFinite(hp)) { yaw = hy + soft(yaw - hy, LIM.relYaw); pitch = hp + soft(pitch - hp, LIM.relPitch); }
      yaw = clamp(fin(yaw, 0), -LIM.yaw, LIM.yaw); pitch = clamp(fin(pitch, 0), -LIM.pitch, LIM.pitch); dist = clamp(fin(dist, 1), LIM.distMin, LIM.distMax);
      C.pose = { yaw, pitch, dist, shot: C.shot, label: SHOTS[C.shot].label, why: C.why, kind: C.kind, cut: C.cutNow, moving: !!C.move, mode: C.mode, push: pushK, headYaw: fin(hy, 0), headPitch: fin(hp, 0) };
      return C.pose;
    }
    function stats() {
      const t = C.t === null ? 0 : C.t;
      return { shot: C.shot, label: SHOTS[C.shot].label, why: C.why, kind: C.kind, mode: C.mode, aside: C.mode === 'aside' ? C.asideWhy : '', cuts: C.cuts, sinceCut: C.lastCut > -99 ? t - C.lastCut : null,
        holdLeft: Number.isFinite(C.holdEnd) ? Math.max(0, C.holdEnd - t) : null, holdBars: C.holdBars || 0, pending: C.pend ? C.pend.to + ' (' + C.pend.why + ')' : '',
        bpm: M.locked ? Math.round(M.bpm) : 0, locked: M.locked, bar: M.k && M.k.locked ? M.k.bar : null, phraseKnown: !!(M.k && M.k.anchor === 'heard'),
        energy: M.e, peak: M.peak, loud: hot(), build: M.build, push: M.push, yaw: C.pose ? C.pose.yaw : 0, pitch: C.pose ? C.pose.pitch : 0, dist: C.pose ? C.pose.dist : 1, log: C.log.slice(-8) };
    }
    /** all of it back to the start (the camera switched off): straight on, no music heard, nothing waiting */
    function reset() {
      resetMusic(); M.lastAudioT = -99; M.silentFor = 9; M.push = 0;
      C.shot = 'front'; C.prev = ''; C.move = null; C.pend = null; C.holdEnd = Infinity; C.lastCut = -99; C.lastMove = -99; C.asideEnd = -99; C.why = 'start'; C.kind = 'cut'; C.mode = 'calm'; C.pose = null; C.base = null; C.fresh = true;
    }
    return { audio, step, fire, stats, reset, get log() { return C.log.slice(); } };
  }

  // ---------------------------------------------------------------- small matrix helpers (column-major, as mask-gl.js's M4)
  function lookAt(e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]; let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
  }
  function mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; }
  /** the inverse of a camera (rotation + move) */
  function rigidInv(m) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = m[r * 4 + c];
    for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
    o[15] = 1; return o;
  }
  /** the eye `cam` moved round `tg` by pose (yaw / pitch in degrees, dist = x its distance), in place */
  function orbit(cam, tg, p) {
    const vx = cam[0] - tg[0], vy = cam[1] - tg[1], vz = cam[2] - tg[2], L = Math.hypot(vx, vy, vz);
    if (!(L > 1e-6) || !p) return cam;
    const a = Math.atan2(vx, vz) + p.yaw * D, e = clamp(Math.asin(clamp(vy / L, -1, 1)) + p.pitch * D, -1.2, 1.2), len = L * p.dist;
    const nx = tg[0] + len * Math.cos(e) * Math.sin(a), ny = tg[1] + len * Math.sin(e), nz = tg[2] + len * Math.cos(e) * Math.cos(a);
    if (Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)) { cam[0] = nx; cam[1] = ny; cam[2] = nz; }
    return cam;
  }
  /** the lid opening that gives `v` times the light `open` gives (the styles light an eye by sstep(0.13, 0.40, open)) */
  function openFor(open, v) {
    const a = EYE.open[0], b = EYE.open[1], y = clamp(v, 0, 1) * sstep(a, b, open);
    if (y >= 1 - 1e-9) return open; if (y <= 0) return Math.min(open, a);
    return a + (b - a) * (0.5 - Math.sin(Math.asin(1 - 2 * y) / 3));      // (the inverse of the smooth step)
  }
  /** 0..1: how much of an eye's glow may show from `cam` (model = the head's matrix, c = the eye's middle in head space) */
  function eyeVis(model, cam, c) {
    if (!model || !cam || !c) return 1;
    const sx = c[0] >= 0 ? 1 : -1, s = Math.sin(EYE.out * D) * sx, k = Math.cos(EYE.out * D);
    const px = model[0] * c[0] + model[4] * c[1] + model[8] * c[2] + model[12], py = model[1] * c[0] + model[5] * c[1] + model[9] * c[2] + model[13], pz = model[2] * c[0] + model[6] * c[1] + model[10] * c[2] + model[14];
    const nx = model[0] * s + model[8] * k, ny = model[1] * s + model[9] * k, nz = model[2] * s + model[10] * k, nl = Math.hypot(nx, ny, nz);
    const dx = cam[0] - px, dy = cam[1] - py, dz = cam[2] - pz, dl = Math.hypot(dx, dy, dz);
    if (!(nl > 1e-9) || !(dl > 1e-9)) return 1;
    const ang = Math.acos(clamp((nx * dx + ny * dy + nz * dz) / (nl * dl), -1, 1)) / D;
    return Number.isFinite(ang) ? 1 - sstep(EYE.from, EYE.to, ang) : 1;
  }

  /** mask-looks.js's own place after the camera (S.place = { zoom, x, y }): the same sums, so the same numbers */
  function placed(vp0, PLC) {
    const ps = PLC ? PLC.zoom : 1, pox = PLC ? 2 * PLC.x : 0, poy = PLC ? 2 * PLC.y : 0;
    let vp = vp0;
    if (PLC && (ps !== 1 || pox || poy)) { vp = vp0.slice(); for (let c = 0; c < 4; c++) { vp[c * 4] = ps * vp0[c * 4] + pox * vp0[c * 4 + 3]; vp[c * 4 + 1] = ps * vp0[c * 4 + 1] + poy * vp0[c * 4 + 3]; } }
    return vp;
  }

  // ---------------------------------------------------------------- the glue (mask-live.js)
  function create(o) {
    o = o || {};
    const dir = o.director || createDirector(o);      // (o.director: a stand-in with the same audio / step / stats / fire: the render tool's stills hold one angle)
    const asides = new Map();
    let on = false, pose = null, fix = null, home = null, frames = 0, ms = 0, errors = 0, lastError = '';
    /** off = the director forgets everything (on again = it starts from nothing: no cut on old music) */
    function setOn(v) { const was = on; on = !!v; if (was && !on) { if (dir.reset) dir.reset(); pose = null; fix = null; home = null; } return on; }
    function audio(f, t) { if (on) dir.audio(f, t); }
    /** an error inside the camera: said once, and the Mask draws on (this picture from its own camera) */
    function oops(e) { errors++; if (errors === 1) { lastError = String(e && e.message ? e.message : e).slice(0, 160); try { console.warn('V9 smart camera: ' + lastError + ' (the Mask draws on from its own camera; said once)'); } catch (er) { /* no console */ } } }
    /** the reason the Mask's own show needs the camera straight on right now ('' = none) */
    function asideWhy(scene, stage, style) {
      for (const [k, v] of asides) if (v) return k;
      const fx = scene.fx;
      if (fx && fx.viz > 0.02) return 'visualizer';
      const u = scene.v8 && scene.v8.u ? scene.v8.u : null;
      if (u && (u.gone || u.nDmg > 0)) return 'boss fight';      // the face shattered, or holes in it (the crack / cosmic moves look right from any angle: no need)
      const st = stage && stage.state ? stage.state : null;
      if (st) {
        if (st.boss) return 'boss fight';
        if (st.vote) return 'chat vote';
        if (st.moves && st.moves.eat && st.moves.eat.on) return 'album eat';
        if (st.song && st.song.image && st.t - st.song.t0 < 3.0) return 'album eat';
        if (st.score && st.t - st.score.t0 < 4.6) return 'the score';
      }
      let ss = null; try { ss = style && style.stats ? style.stats() : null; } catch (e) { ss = null; }
      if (ss && ss.shown > 0.01 && ss.shown < 0.99) return 'transform';
      return '';      // (the countdown: the page says so, cam.aside('countdown', true / false))
    }
    function frame(t, dt, scene, stage, style) {
      if (!on || !scene) return;
      const b = typeof performance !== 'undefined' ? performance.now() : 0;
      const h0 = scene.hfx, v0 = scene.v9;
      try {
        const R = scene.head && scene.head.R && scene.head.R.length >= 9 ? scene.head.R : null;
        pose = dir.step(t, dt, { aside: asideWhy(scene, stage, style), head: R ? [R[2], R[5], R[8]] : null });
        const P = pose; fix = null; home = null;
        scene.cam = (cam, S, VIEW, hUp) => {
          const keep = [cam[0], cam[1], cam[2]];
          try {
            // the point mask-looks.js's camera looks at (the same numbers, in the same order, as there)
            const KK = S.fx ? S.fx.kick : [0, 0, 0], tg = [-KK[0] * 0.05, VIEW.targetY - KK[1] * 0.04 + hUp, 0];
            home = { cam: keep.slice(), tg, fov: VIEW.fov, place: S.place || null };
            orbit(cam, tg, P);
            // (without the Mask's matrix helpers: his hands get vp * (this camera)^-1 * (the camera without it))
            fix = mul(rigidInv(lookAt(cam, tg, [0, 1, 0])), lookAt(home.cam, tg, [0, 1, 0]));
            for (let i = 0; i < 3; i++) if (!Number.isFinite(cam[i])) throw new Error('the eye left the world');
          } catch (e) { cam[0] = keep[0]; cam[1] = keep[1]; cam[2] = keep[2]; fix = null; home = null; oops(e); }      // (this picture: the Mask's own camera)
        };
        // his hands keep the camera they had without this one, to the last digit: the Mask's own sums on the Mask's own numbers
        if (h0 && h0.render) {
          scene.hfx = Object.assign({}, h0, { render: (X) => {
            let Y = X;
            try {
              const M = root.VTMaskGL && root.VTMaskGL.M4;
              if (home && M && X && X.G && X.G.H > 0) Y = Object.assign({}, X, { vp: placed(M.mul(M.perspective(home.fov, X.G.W / X.G.H, 2, 60), M.lookAt(home.cam, home.tg, [0, 1, 0])), home.place) });
              else if (fix && X && X.vp) Y = Object.assign({}, X, { vp: mul(X.vp, fix) });
            } catch (e) { Y = X; oops(e); }
            return h0.render(Y);
          } });
        }
        if (v0 && v0.render) {
          scene.v9 = Object.assign({}, v0, { render: (X) => {
            const eyes = X && X.core && X.core.eyes;
            if (!eyes || !X.cam || !X.model) return v0.render(X);
            // the glow of an eye the camera sees from too far round is faded: its lids' "open" is lowered for this call only
            const keep = eyes.map((e) => e.open);
            try { for (let i = 0; i < eyes.length; i++) { const v = eyeVis(X.model, X.cam, eyes[i].c); if (v < 1) eyes[i].open = openFor(keep[i], v); } } catch (e) { for (let i = 0; i < eyes.length; i++) eyes[i].open = keep[i]; oops(e); }
            try { return v0.render(X); } finally { for (let i = 0; i < eyes.length; i++) eyes[i].open = keep[i]; }
          } });
        }
      } catch (e) { scene.cam = null; scene.hfx = h0; scene.v9 = v0; fix = null; home = null; oops(e); return; }      // (an error in the camera: this picture as the Mask draws it on its own)
      frames++; if (b) ms += ((typeof performance !== 'undefined' ? performance.now() : b) - b - ms) * 0.05;
    }
    function stats() { return Object.assign({ on, ms, errors, error: lastError }, dir.stats()); }
    return {
      setOn, audio, frame, stats, get on() { return on; }, get pose() { return pose; },
      aside: (why, v) => { if (v) asides.set(String(why || 'asked'), true); else asides.delete(String(why || 'asked')); },
      fire: (kind, t) => { if (on) dir.fire(kind, t); }, director: dir,      // (off: nothing is kept for later)
    };
  }

  return { create, createDirector, SHOTS, LIM, WANT, EYE, T, orbit, eyeVis, openFor, lookAt, mul, rigidInv, soft, placed };
});
