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
  function schedule(ctx, destination, cues, t0, { volume = 1 } = {}) {
    const master = ctx.createGain();
    master.gain.value = 0.34 * volume;                         // under the music: the loudest boom peaks about 6 dB below full scale
    master.connect(destination);
    // a salvo that lands together is ONE loud moment, not fourteen stacked bangs: each sound is turned down by how many of its kind start with it
    for (const c of cues) {
      let n = 0;
      for (const d of cues) if (d.kind === c.kind && Math.abs(d.t - c.t) < 0.07) n++;
      const g = ctx.createGain(); g.gain.value = 1 / Math.pow(n, 0.85); g.connect(master);
      one(ctx, g, c, Math.max(ctx.currentTime, t0 + c.t));
    }
    return master;
  }
  root.VTMaskSfx = { schedule };
})(typeof globalThis !== 'undefined' ? globalThis : self);
