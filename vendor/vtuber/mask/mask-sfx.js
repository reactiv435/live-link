// V4 MASK: gift sounds. Procedural WebAudio only (no files, nothing generated or downloaded): a whoosh per missile, a
// small bang per hit, a deeper boom for the big ones, a short rising "charge" under a build-up. For gifts only: likes,
// comments, follows and shares are silent (V4-MASK.md, Phase 2). Mixed to sit under the music.
//
//   VTMaskSfx.schedule(ctx, destination, cues, t0, { volume })
//     ctx: an AudioContext (live) or an OfflineAudioContext (the demo renders); cues: mask-fx.js `cuesBetween(a, b)`,
//     [{ t, kind: 'whoosh' | 'bang' | 'boom' | 'charge', size, dur }]; cue.t is played at ctx time t0 + cue.t.
// Live, the page calls it for the cues of the next fraction of a second, with its own gain node as the destination
// (the "Gift sounds" switch is that gain). The sound goes to the page's output only: it is never fed to the analyser
// the mood listens to.
(function (root) {
  'use strict';
  const noiseOf = new WeakMap();
  function noise(ctx) {
    let b = noiseOf.get(ctx);
    if (b) return b;
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }      // the same noise every run
    noiseOf.set(ctx, b);
    return b;
  }
  function nz(ctx, at, len) { const n = ctx.createBufferSource(); n.buffer = noise(ctx); n.loop = true; n.start(at, (at * 0.37) % 1.5); n.stop(at + len + 0.05); return n; }
  const env = (g, at, pts) => { g.gain.setValueAtTime(0.0001, at); for (const [dt, v, exp] of pts) { if (exp) g.gain.exponentialRampToValueAtTime(Math.max(0.0001, v), at + dt); else g.gain.linearRampToValueAtTime(v, at + dt); } };

  function one(ctx, out, c, at) {
    const k = Math.sqrt(Math.max(0.3, c.size || 1));
    if (c.kind === 'whoosh') {
      const len = Math.max(0.25, c.dur || 0.5), n = nz(ctx, at, len), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'bandpass'; f.Q.value = 1.4; f.frequency.setValueAtTime(420, at); f.frequency.exponentialRampToValueAtTime(2600, at + len);
      env(g, at, [[len * 0.75, 0.085 * k], [len, 0.0001]]);
      n.connect(f); f.connect(g); g.connect(out);
    } else if (c.kind === 'bang') {
      const n = nz(ctx, at, 0.3), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(2600, at); f.frequency.exponentialRampToValueAtTime(320, at + 0.2);
      env(g, at, [[0.004, 0.30 * k], [0.24, 0.0001, true]]);
      n.connect(f); f.connect(g); g.connect(out);
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.setValueAtTime(175 / k, at); o.frequency.exponentialRampToValueAtTime(52 / k, at + 0.18);
      env(og, at, [[0.004, 0.36 * k], [0.22, 0.0001, true]]);
      o.connect(og); og.connect(out); o.start(at); o.stop(at + 0.3);
    } else if (c.kind === 'boom') {
      const len = 0.9 + 0.35 * k, o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.setValueAtTime(92, at); o.frequency.exponentialRampToValueAtTime(30, at + len * 0.8);
      env(og, at, [[0.008, Math.min(0.9, 0.55 * k)], [len, 0.0001, true]]);
      o.connect(og); og.connect(out); o.start(at); o.stop(at + len + 0.1);
      const n = nz(ctx, at, len), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'lowpass'; f.frequency.setValueAtTime(900, at); f.frequency.exponentialRampToValueAtTime(90, at + len * 0.7);
      env(g, at, [[0.006, Math.min(0.6, 0.34 * k)], [len * 0.8, 0.0001, true]]);
      n.connect(f); f.connect(g); g.connect(out);
    } else if (c.kind === 'charge') {
      const len = Math.max(0.3, c.dur || 1), n = nz(ctx, at, len), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'bandpass'; f.Q.value = 2.2; f.frequency.setValueAtTime(260, at); f.frequency.exponentialRampToValueAtTime(3400, at + len);
      env(g, at, [[len * 0.96, 0.075 * k], [len, 0.0001]]);
      n.connect(f); f.connect(g); g.connect(out);
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(160, at); o.frequency.exponentialRampToValueAtTime(560, at + len);
      env(og, at, [[len * 0.96, 0.05 * k], [len, 0.0001]]);
      o.connect(og); og.connect(out); o.start(at); o.stop(at + len + 0.05);
    }
  }
  // V8: the puppet moves, the fight, the hand puppets. Cartoon sounds: wet and round for goo, a roar for fire, never a retch.
  function one8(ctx, out, c, at) {
    const k = Math.sqrt(Math.max(0.3, c.size || 1)), osc = (type, f0, f1, len, peak, a0 = 0.01) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + len); env(g, at, [[a0, peak], [len, 0.0001, true]]); o.connect(g); g.connect(out); o.start(at); o.stop(at + len + 0.05); return o; };
    const nzf = (type, f0, f1, q, len, pts) => { const n = nz(ctx, at, len), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, at); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), at + len); env(g, at, pts); n.connect(f); f.connect(g); g.connect(out); return f; };
    if (c.kind === 'goo') {            // a low gurgle: bubbles of pitch that rise, over a soft wet noise
      const len = Math.max(0.8, c.dur || 1.6);
      nzf('lowpass', 520, 300, 3, len, [[0.08, 0.10 * k], [len * 0.8, 0.07 * k], [len, 0.0001]]);
      for (let i = 0, t = 0.03; t < len - 0.1; i++, t += 0.085 + 0.06 * ((i * 7) % 5) / 5) { const o = ctx.createOscillator(), g = ctx.createGain(), f = 150 + 130 * ((i * 13) % 7) / 7; o.frequency.setValueAtTime(f, at + t); o.frequency.exponentialRampToValueAtTime(f * 2.2, at + t + 0.07); g.gain.setValueAtTime(0.0001, at + t); g.gain.linearRampToValueAtTime(0.11 * k, at + t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, at + t + 0.08); o.connect(g); g.connect(out); o.start(at + t); o.stop(at + t + 0.1); }
    } else if (c.kind === 'fire') {    // a roar that breathes
      const len = Math.max(0.8, c.dur || 2), f = nzf('bandpass', 380, 520, 0.7, len, [[0.12, 0.20 * k], [len * 0.7, 0.15 * k], [len, 0.0001]]);
      const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 7.3; lg.gain.value = 170; l.connect(lg); lg.connect(f.frequency); l.start(at); l.stop(at + len + 0.05);
      osc('sine', 70, 48, len, 0.12 * k, 0.15);
    } else if (c.kind === 'melt') { const len = Math.max(0.8, c.dur || 1.6); osc('sawtooth', 420, 70, len, 0.07 * k, 0.05); osc('sine', 300, 55, len, 0.12 * k, 0.05); nzf('lowpass', 900, 200, 2, len, [[0.1, 0.06 * k], [len, 0.0001]]); }
    else if (c.kind === 'pop') { osc('sine', 260, 880, 0.12, 0.30 * k, 0.005); nzf('highpass', 2500, 5000, 0.7, 0.1, [[0.004, 0.10 * k], [0.09, 0.0001, true]]); }
    else if (c.kind === 'crack') { nzf('highpass', 1800, 900, 0.8, 0.22, [[0.002, 0.42 * k], [0.05, 0.10 * k, true], [0.2, 0.0001, true]]); osc('square', 140, 60, 0.12, 0.10 * k, 0.002); }
    else if (c.kind === 'slurp') { const len = Math.max(0.2, c.dur || 0.5); nzf('bandpass', 300, 2400, 5, len, [[len * 0.9, 0.16 * k], [len, 0.0001]]); osc('sine', 180, 720, len, 0.08 * k, len * 0.5); }
    else if (c.kind === 'chomp') { osc('sine', 190, 60, 0.10, 0.40 * k, 0.003); nzf('lowpass', 1800, 400, 1, 0.09, [[0.002, 0.26 * k], [0.08, 0.0001, true]]); nzf('highpass', 3000, 2400, 1, 0.05, [[0.002, 0.10 * k], [0.04, 0.0001, true]]); }
    else if (c.kind === 'rise') { const len = Math.max(0.4, c.dur || 0.9), pt = c.pitch > 0 ? c.pitch : 1; osc('triangle', 220 * pt, 880 * pt, len, 0.09 * k, len * 0.8); osc('sine', 330 * pt, 1320 * pt, len, 0.06 * k, len * 0.8); nzf('bandpass', 600, 5200, 1.5, len, [[len * 0.92, 0.06 * k], [len, 0.0001]]); }
    else if (c.kind === 'ping') { const pt = c.pitch > 0 ? c.pitch : 1; osc('sine', 1560 * pt, 1480 * pt, 0.35, 0.16 * k, 0.003); osc('sine', 2340 * pt, 2300 * pt, 0.22, 0.07 * k, 0.003); }
    else if (c.kind === 'laser') { const len = Math.max(0.2, c.dur || 0.45); osc('sawtooth', 1500, 240, len, 0.09 * k, 0.005); osc('square', 760, 120, len, 0.05 * k, 0.005); }
    else if (c.kind === 'scream') { const len = Math.max(0.5, c.dur || 0.9); for (const m of [1, 1.51, 2.02]) osc('sawtooth', 330 * m, 190 * m, len, 0.07 * k, 0.04); nzf('bandpass', 1400, 700, 1.2, len, [[0.05, 0.16 * k], [len, 0.0001]]); }
    else if (c.kind === 'glass') { for (let i = 0; i < 9; i++) { const o = ctx.createOscillator(), g = ctx.createGain(), t = i * 0.035, f = 1700 + 2900 * ((i * 37) % 11) / 11; o.frequency.value = f; g.gain.setValueAtTime(0.0001, at + t); g.gain.linearRampToValueAtTime(0.09 * k, at + t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + t + 0.4); o.connect(g); g.connect(out); o.start(at + t); o.stop(at + t + 0.45); } nzf('highpass', 4000, 2500, 0.7, 0.3, [[0.003, 0.22 * k], [0.28, 0.0001, true]]); }
    else if (c.kind === 'laugh') { osc('sawtooth', 210, 150, 0.17, 0.13 * k, 0.02); osc('sine', 105, 80, 0.17, 0.16 * k, 0.02); }
    else if (c.kind === 'poof') { nzf('bandpass', 900, 3200, 0.8, 0.3, [[0.02, 0.16 * k], [0.28, 0.0001, true]]); osc('sine', 520, 1040, 0.18, 0.06 * k, 0.01); }
    else return false;
    return true;
  }
  function schedule(ctx, destination, cues, t0, { volume = 1 } = {}) {
    const master = ctx.createGain();
    master.gain.value = 0.34 * volume;                         // under the music: the loudest boom peaks about 6 dB below full scale
    master.connect(destination);
    // a salvo that lands together is ONE loud moment, not fourteen stacked bangs: each sound is turned down by how many of its kind start with it
    for (const c of cues) {
      let n = 0;
      for (const d of cues) if (d.kind === c.kind && Math.abs(d.t - c.t) < 0.07) n++;
      const g = ctx.createGain(); g.gain.value = 1 / Math.pow(n, 0.85); g.connect(master);
      const at = Math.max(ctx.currentTime, t0 + c.t);
      if (!one8(ctx, g, c, at)) one(ctx, g, c, at);
    }
    return master;
  }
  root.VTMaskSfx = { schedule };
})(typeof globalThis !== 'undefined' ? globalThis : self);
