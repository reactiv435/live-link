// COUNTDOWN 2.0 MUSIC (review/V9-COUNTDOWN-NOTES.md, "The music"): his own countdown song, "Reactiv Awakening
// (Countdown)" (his Suno song, assets/music/countdown-music.mp3), under the countdown, its drop heard exactly at the zero,
// the moment the Mask wakes. js/v9-show-page.js drives it; nothing of it runs (no file, no AudioContext) until a
// countdown asks for the music.
//   const m = VTCountdownMusic.create({ clock: () => mask.clock(), onFrame: (f) => ... });
//   m.set({ on, vol })      on/off (off = never loads, never plays; playing -> a 0.5 s fade) and the volume 0..1
//   m.start(zeroAt)         plays so the drop is HEARD at clock time zeroAt. Again (a re-press, a new time): it seeks
//                           there with a short crossfade, never from the top. The same zeroAt again: nothing changes.
//   m.stop(sec = 0.5)       fades out and stops;  m.fadeOut(sec = 3): the same, slower ("Fade music out")
//   m.aims(zeroAt)          true while it plays (or loads) for that zero: the page then keeps the zero on that time
//   m.feeding()             true while the song is heard and the Mask hears it from here (onFrame, 60 a second); never
//                           at volume 0 (below 2 %): nobody hears it then, so the Mask hears what it did before (the loopback)
//   m.step()                keeps the next parts scheduled (it also runs on its own timer, 4 a second)
//   m.status()              { on, vol, state: off | loading | missing | ready | playing | fading | ended, ... }
// How it plays (measured: D:/claude-cache/countdown-music/NOTES.md). With R seconds left at the start:
//   R <= 106.88 s  from the song's offset 106.88 - R, on to its end;
//   R >  106.88 s  the heartbeat intro loops on whole bars (0.156 -> 13.887 s, 8 bars), each seam an 80 ms equal-power
//                  crossfade, entered at the phase that keeps the drop on the zero; the last pass runs on into the song.
// Every part is an AudioBufferSourceNode started at an exact context time (sample accurate). The context time at which
// a clock moment is HEARD comes from ctx.getOutputTimestamp() (the speakers' latency is in it). The sound card's clock
// and the page's clock drift apart a little (tens of ppm: up to ~0.1 s over 30 minutes), so while it waits for the
// zero it checks: off by more than 6 ms (three checks running), it re-anchors (the same timeline again, 30 ms linear
// crossfade: the same music a few ms apart, not heard), never in the last 3 s before the zero.
// The decoded file is checked against the master: where its first beat sits (0.155 s in the master) gives any start
// padding the decoder left (an mp3's encoder delay, ~23 ms), so the drop lands right with or without it.
// The file missing, not decoding, or no WebAudio: silent, never an error out of here; the countdown runs as without it.
// A failed load is tried again by the next start() that wants the music (not within 2 s of the failure: a volume slider
// sends many), and no timer runs while there is no song.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTCountdownMusic = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';
  // drop / loopA / loopB / onset: seconds in the master (48 kHz WAV); xf: the loop seams' crossfade
  const SONG = Object.freeze({ url: 'assets/music/countdown-music.mp3', drop: 106.88, loopA: 0.156, loopB: 13.887, onset: 0.155, xf: 0.08, end: 150 });
  // lead: a part never starts sooner than this after the context's now; ahead: how far ahead parts are scheduled;
  // firstIn / seekXf / nudgeXf: the first fade-in, a seek's crossfade, a re-anchor's crossfade; drift: the re-anchor line
  const T = Object.freeze({ lead: 0.04, ahead: 20, firstIn: 0.4, seekXf: 0.15, nudgeXf: 0.03, drift: 0.006, calm: 3, stop: 0.5, fade: 3 });
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const num = (x, d) => (x !== null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : d);
  const HALF_PI = Math.PI / 2;

  /**
   * What plays, as parts relative to the zero (0 = the drop is heard). A part: { at, off, dur, fin, fout }: it is heard
   * from `at` for `dur` seconds, from `off` seconds into the song; fin / fout = its equal-power fade in / out (seconds).
   * end = the song's length (the decoded buffer); shift = the decoder's start padding (the file runs that much late).
   */
  function plan(R, end = SONG.end, shift = 0, S = SONG) {
    R = Math.max(0, num(R, 0)); end = num(end, S.end); shift = num(shift, 0);
    const D = S.drop + shift, A = S.loopA + shift, B = S.loopB + shift, L = B - A, H = S.xf / 2;
    if (R <= S.drop) return [{ at: -D, off: 0, dur: end, fin: 0, fout: 0 }];
    const bF = -(D - A);                                     // the last pass reaches the first bar line (0.156) here
    const K = Math.max(1, Math.ceil((R + bF - H) / L));      // loops so the earliest one is already playing at -R
    const parts = [];
    for (let k = K; k >= 1; k--) parts.push({ at: bF - k * L - H, off: A - H, dur: L + 2 * H, fin: S.xf, fout: S.xf });
    parts.push({ at: bF - H, off: A - H, dur: end - (A - H), fin: S.xf, fout: 0 });
    return parts;
  }
  /** a part's own gain, u seconds into it (noIn: its fade-in is left out: a part cut into at a bus's start) */
  function gainAt(p, u, noIn) {
    let g = 1;
    if (!noIn && p.fin > 0 && u < p.fin) g *= Math.sin(HALF_PI * clamp(u / p.fin, 0, 1));
    if (p.fout > 0 && u > p.dur - p.fout) g *= Math.cos(HALF_PI * clamp((u - (p.dur - p.fout)) / p.fout, 0, 1));
    return g;
  }
  /** what is heard at tau (relative to the zero): [{ off, g }] (tests and tools) */
  function heard(parts, tau) {
    const out = [];
    for (const p of parts) if (tau >= p.at && tau < p.at + p.dur) out.push({ off: p.off + (tau - p.at), g: gainAt(p, tau - p.at, false) });
    return out;
  }
  /** where the first beat sits in decoded audio: the first 1 ms window (mean of the channels) reaching half the loudest of the first 0.4 s */
  function onsetOf(chans, sr) {
    const w = Math.max(1, Math.round(sr / 1000)), len = chans && chans[0] ? chans[0].length : 0, n = Math.floor(Math.min(len, 0.4 * sr) / w);
    if (n < 2) return null;
    const r = new Float64Array(n); let top = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * w; j < (i + 1) * w; j++) { let v = 0; for (const c of chans) v += c[j]; v /= chans.length; s += v * v; }
      r[i] = Math.sqrt(s / w); if (r[i] > top) top = r[i];
    }
    if (!(top > 1e-4)) return null;
    for (let i = 0; i < n; i++) if (r[i] >= 0.5 * top) return (i * w) / sr;
    return null;
  }
  /** the decoder's start padding, from where the first beat sits (none, or one that cannot be right, = 0) */
  function shiftOf(chans, sr) { const o = onsetOf(chans, sr); if (o === null) return 0; const s = o - SONG.onset; return s >= -0.01 && s <= 0.06 ? s : 0; }
  const curve = (f, a, b, n = 32) => { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = f(a + ((b - a) * i) / (n - 1)); return c; };

  function create(o = {}) {
    const perf = () => (root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now());
    const clock = typeof o.clock === 'function' ? o.clock : () => perf() / 1000;
    const url = o.url || SONG.url, ahead = o.ahead === Infinity ? Infinity : num(o.ahead, T.ahead);
    const every = o.setInterval || (typeof root.setInterval === 'function' ? root.setInterval.bind(root) : null);
    const never = o.clearInterval || (typeof root.clearInterval === 'function' ? root.clearInterval.bind(root) : () => {});
    const S = { on: false, vol: 0.6, state: 'off', ctx: null, fade: null, an: null, volG: null, buf: null, shift: 0, end: SONG.end, bus: null, old: [], want: null, loading: null,
      fading: null, feat: null, db: null, feedT: null, tickT: null, err: '', drift: 0, over: 0, lastNudge: -1e9, nudges: 0, seeks: 0, resumeAt: -1e9, failAt: 0 };
    const running = () => !!S.ctx && (o.offline === true || S.ctx.state === 'running');

    function ensureCtx() {
      if (S.ctx) return true;
      try {
        const AC = o.ctx ? null : root.AudioContext || root.webkitAudioContext;
        if (!o.ctx && !AC) { S.state = 'missing'; S.err = 'no WebAudio'; return false; }
        const ctx = o.ctx || new AC();
        const fade = ctx.createGain(), volG = ctx.createGain();
        let an = null;
        try { an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0; } catch (e) { an = null; }
        if (an) { fade.connect(an); an.connect(volG); } else fade.connect(volG);
        volG.connect(ctx.destination); volG.gain.value = S.vol;
        Object.assign(S, { ctx, fade, an, volG });
        return true;
      } catch (e) { S.state = 'missing'; S.err = 'no audio: ' + String(e && e.message ? e.message : e).slice(0, 100); return false; }
    }
    /** the context time at which clock moment c is heard */
    function heardAt(c) {
      if (typeof o.toCtx === 'function') return o.toCtx(c);
      const ctx = S.ctx, nowC = clock(), p = perf();
      let ts = null; try { ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null; } catch (e) { ts = null; }
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0 && Math.abs(p - ts.performanceTime) < 1000) return ts.contextTime + (p - ts.performanceTime) / 1000 + (c - nowC);
      return ctx.currentTime - (num(ctx.baseLatency, 0) + num(ctx.outputLatency, 0)) + (c - nowC);
    }
    function load() {
      if (S.loading || S.buf) return S.loading;
      if (S.failAt && perf() - S.failAt < 2000) return null;      // just failed: not again yet (the next start tries)
      S.state = 'loading';
      const p = S.loading = (async () => {
        try {
          if (typeof root.fetch !== 'function') throw new Error('no fetch');
          const r = await root.fetch(url); if (!r || !r.ok) throw new Error('the song is not there (' + (r ? r.status : '?') + ')');
          const bytes = await r.arrayBuffer();
          const buf = await new Promise((ok, no) => { try { const p = S.ctx.decodeAudioData(bytes, ok, no); if (p && typeof p.then === 'function') p.then(ok, no); } catch (e) { no(e); } });
          if (!buf || !(buf.duration > 20)) throw new Error('the song did not decode');
          const chans = []; for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) chans.push(buf.getChannelData(i));
          S.shift = shiftOf(chans, buf.sampleRate); S.end = buf.duration; S.buf = buf; S.err = '';
          S.state = S.on ? 'ready' : 'off';
          step();
        } catch (e) { S.state = 'missing'; S.err = String(e && e.message ? e.message : e).slice(0, 120); S.want = null; S.failAt = perf(); timers(false); feedOn(false); }      // no song: no timer
        return !!S.buf;
      })();
      p.then((ok) => { if (!ok && S.loading === p) S.loading = null; });      // failed: the next start that wants the music loads again
      return p;
    }
    function timers(on) {
      if (!every) return;
      if (on && !S.tickT) S.tickT = every(() => { try { step(); } catch (e) { /* the next tick */ } }, 250);
      if (!on && S.tickT) { never(S.tickT); S.tickT = null; }
    }
    function feedOn(on) {
      if (!every || !S.an || typeof o.onFrame !== 'function' || !root.VTMaskAudio) return;
      if (on && !S.feedT) {
        if (!S.feat) { S.feat = root.VTMaskAudio.create({ sampleRate: S.ctx.sampleRate, fftSize: 2048, rate: 60 }); S.db = new Float32Array(1024); }
        S.feedT = every(() => {
          if (!feeding()) return;
          try { S.an.getFloatFrequencyData(S.db); o.onFrame(S.feat.push(S.db)); } catch (e) { /* the next one */ }
        }, 1000 / 60);
      }
      if (!on && S.feedT) { never(S.feedT); S.feedT = null; }
    }
    /** one part into a bus at its exact time (cut into when its start is already gone) */
    function place(bus, p) {
      const ctx = S.ctx, W = bus.zeroW + p.at, skip = Math.max(0, bus.t0 - W);
      if (skip >= p.dur - 0.002) return;
      const start = W + skip, off = p.off + skip, dur = Math.min(p.dur - skip, S.buf.duration - off);
      if (!(dur > 0.002) || off < 0) return;
      const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = S.buf; src.connect(g); g.connect(bus.g);
      const noIn = bus.first && skip > 0, gu = (u) => gainAt(p, u, noIn), pg = g.gain;
      pg.value = gu(skip);
      if (!noIn && p.fin > 0 && skip < p.fin - 0.001) pg.setValueCurveAtTime(curve(gu, skip, p.fin), start, p.fin - skip);
      if (p.fout > 0) { const fo = Math.max(skip, p.dur - p.fout); if (p.dur - fo > 0.001) pg.setValueCurveAtTime(curve(gu, fo, p.dur), start + (fo - skip), p.dur - fo); }
      bus.first = false;
      src.start(start, off, dur);
      bus.srcs.push({ src, g, end: start + dur });
    }
    function feed(bus) {
      const horizon = ahead === Infinity ? Infinity : S.ctx.currentTime + ahead;
      while (bus.k < bus.parts.length) { const p = bus.parts[bus.k]; if (bus.zeroW + p.at > horizon) break; bus.k++; place(bus, p); }
    }
    /** a new copy of the timeline for this zero. kind: 'first' (fades in), 'seek' (crossfades with the one it replaces), 'nudge' (a re-anchor) */
    function newBus(zeroAt, kind) {
      const ctx = S.ctx, t0 = ctx.currentTime + T.lead, xf = kind === 'nudge' ? T.nudgeXf : kind === 'seek' ? T.seekXf : T.firstIn;
      const g = ctx.createGain(); g.connect(S.fade);
      g.gain.value = 0;
      g.gain.setValueCurveAtTime(kind === 'nudge' ? curve((u) => u, 0, 1) : curve((u) => Math.sin(HALF_PI * u), 0, 1), t0, xf);
      const bus = { g, zeroAt, zeroW: heardAt(zeroAt), t0, born: ctx.currentTime, parts: plan(zeroAt - clock(), S.end, S.shift), k: 0, srcs: [], first: true, until: Infinity };
      feed(bus);
      return bus;
    }
    function retire(bus, kind) {
      const ctx = S.ctx, t0 = ctx.currentTime + T.lead, xf = kind === 'nudge' ? T.nudgeXf : T.seekXf, gp = bus.g.gain;
      try {
        if (typeof gp.cancelAndHoldAtTime === 'function') gp.cancelAndHoldAtTime(t0); else { gp.cancelScheduledValues(t0); gp.setValueAtTime(gp.value, t0); }
        const g0 = clamp(num(gp.value, 1), 0, 1);
        gp.setValueCurveAtTime(kind === 'nudge' ? curve((u) => g0 * (1 - u), 0, 1) : curve((u) => g0 * Math.cos(HALF_PI * u), 0, 1), t0 + 0.0001, xf);
      } catch (e) { try { gp.value = 0; } catch (er) { /* gone */ } }
      bus.until = t0 + xf + 0.02; bus.k = bus.parts.length;
      for (const s of bus.srcs) { try { if (s.end > bus.until) { s.src.stop(bus.until); s.end = bus.until; } } catch (e) { /* already stopped */ } }
      S.old.push(bus);
    }
    function drop(bus) { for (const s of bus.srcs) { try { s.src.stop(); } catch (e) { /* not started / done */ } try { s.g.disconnect(); } catch (e) { /* gone */ } } try { bus.g.disconnect(); } catch (e) { /* gone */ } bus.srcs = []; }
    function unfade() {
      if (!S.fading) return;
      const gp = S.fade.gain, t = S.ctx.currentTime + T.lead;      // pressed again while it fades out: back up, not a jump
      try { if (typeof gp.cancelAndHoldAtTime === 'function') gp.cancelAndHoldAtTime(t); else { gp.cancelScheduledValues(0); gp.setValueAtTime(gp.value, t); } gp.linearRampToValueAtTime(1, t + T.seekXf); } catch (e) { gp.value = 1; }
      S.fading = null;
    }
    function begin(zeroAt) {
      if (S.bus && Math.abs(S.bus.zeroAt - zeroAt) < 0.002 && !S.fading) { S.want = null; return; }      // the same zero: it plays on as it is
      unfade();
      const kind = S.bus ? 'seek' : 'first';
      if (S.bus) { retire(S.bus, 'seek'); S.seeks++; }
      S.bus = newBus(zeroAt, kind); S.want = null; S.state = 'playing'; S.over = 0;
      timers(true); feedOn(true);
    }
    function step() {
      if (!S.ctx) return;
      const ctx = S.ctx, now = ctx.currentTime;
      if (!running() && S.ctx.state === 'suspended' && typeof ctx.resume === 'function' && now - S.resumeAt > 2) { S.resumeAt = now; try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed yet */ } }
      if (S.want !== null && S.buf && S.on && running()) begin(S.want);
      if (S.bus) {
        feed(S.bus);
        const b = S.bus, left = b.zeroAt - clock();
        // the sound card's clock against the page's: re-anchor when they have drifted apart (never close to the zero)
        if (left > T.calm && now - b.born > 2 && !S.fading && ahead !== Infinity) {
          const err = heardAt(b.zeroAt) - b.zeroW; S.drift = err;
          S.over = Math.abs(err) > T.drift ? S.over + 1 : 0;
          if (S.over >= 3 && now - S.lastNudge > 5) { S.over = 0; S.lastNudge = now; retire(b, 'nudge'); S.bus = newBus(b.zeroAt, 'nudge'); S.nudges++; }
        }
        if (S.bus) {
          const B = S.bus; B.srcs = B.srcs.filter((s) => { if (s.end < now - 0.5) { try { s.g.disconnect(); } catch (e) { /* gone */ } return false; } return true; });
          if (B.k >= B.parts.length && !B.srcs.length) { drop(B); S.bus = null; S.state = 'ended'; }
        }
      }
      S.old = S.old.filter((b) => { if (now > b.until + 0.05) { drop(b); return false; } return true; });
      if (S.fading && now > S.fading.until) {
        if (S.bus) { drop(S.bus); S.bus = null; }
        for (const b of S.old) drop(b); S.old = [];
        try { S.fade.gain.cancelScheduledValues(0); S.fade.gain.setValueAtTime(1, now); } catch (e) { S.fade.gain.value = 1; }
        S.fading = null; S.state = S.on ? 'ready' : 'off';
      }
      if (!S.bus && !S.old.length && !S.fading && S.want === null) { timers(false); feedOn(false); }
    }
    function stop(sec = T.stop) {
      S.want = null;
      if (!S.ctx || (!S.bus && !S.old.length)) { if (S.state !== 'missing' && S.state !== 'loading') S.state = S.on && S.buf ? 'ready' : S.on ? S.state : 'off'; return false; }
      if (S.fading) return true;
      const ctx = S.ctx, t0 = ctx.currentTime + T.lead, d = Math.max(0.05, num(sec, T.stop)), gp = S.fade.gain;
      try {
        if (typeof gp.cancelAndHoldAtTime === 'function') gp.cancelAndHoldAtTime(t0); else { gp.cancelScheduledValues(t0); gp.setValueAtTime(gp.value, t0); }
        gp.setValueCurveAtTime(curve((u) => Math.cos(HALF_PI * u), 0, 1), t0 + 0.0001, d);
      } catch (e) { try { gp.setTargetAtTime(0, t0, d / 4); } catch (er) { gp.value = 0; } }
      S.fading = { at: t0, until: t0 + d + 0.03, sec: d };
      for (const b of [S.bus, ...S.old]) if (b) { b.k = b.parts.length; for (const s of b.srcs) { try { if (s.end > S.fading.until) { s.src.stop(S.fading.until); s.end = S.fading.until; } } catch (e) { /* done */ } } }
      S.state = 'fading';
      timers(true);
      return true;
    }
    function set(v = {}) {
      if (v.vol !== undefined) { S.vol = clamp(num(v.vol, S.vol), 0, 1); if (S.volG) { try { S.volG.gain.setTargetAtTime(S.vol, S.ctx.currentTime, 0.04); } catch (e) { S.volG.gain.value = S.vol; } } }
      if (v.on !== undefined) {
        const on = v.on === true;
        if (S.on && !on) { S.on = false; stop(T.stop); if (S.state !== 'fading' && S.state !== 'missing') S.state = 'off'; }
        else if (!S.on && on) { S.on = true; if (S.state === 'off') S.state = S.buf ? 'ready' : 'off'; }
      }
      return status();
    }
    function start(zeroAt) {
      zeroAt = num(zeroAt, null); if (!S.on || zeroAt === null) return false;
      if (!ensureCtx()) return false;
      S.want = zeroAt;
      if (!S.buf) { if (!load()) { S.want = null; return false; } timers(true); return true; }      // (loading: its timer starts it; failed a moment ago: nothing runs)
      if (running()) begin(zeroAt); else timers(true);
      return true;
    }
    function feeding() { return !!S.feedT && !!S.bus && running() && (S.state === 'playing' || S.state === 'fading') && S.vol >= 0.02; }
    function aims(zeroAt) { return S.on && S.state !== 'missing' && (S.want === zeroAt || (!!S.bus && S.bus.zeroAt === zeroAt && !S.fading)); }
    function status() {
      const b = S.bus, ctx = S.ctx;
      let pos = null;
      if (b && ctx) { const tau = ctx.currentTime - b.zeroW, h = heard(b.parts, tau).sort((x, y) => y.g - x.g)[0]; pos = h ? Math.round(h.off * 100) / 100 : null; }
      return { on: S.on, vol: Math.round(S.vol * 100) / 100, state: S.state, zeroAt: b ? b.zeroAt : S.want, pos, shift: Math.round(S.shift * 10000) / 10000, nudges: S.nudges, seeks: S.seeks, drift: Math.round(S.drift * 10000) / 10000, err: S.err || undefined };
    }
    return { set, start, stop, fadeOut: (sec = T.fade) => stop(sec), step, aims, feeding, status, load, debug: S };
  }

  return { SONG, T, plan, gainAt, heard, onsetOf, shiftOf, create };
});
