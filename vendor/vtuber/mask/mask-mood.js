// V4 MASK: the colour system. Pure UMD, no DOM. "Crimson home, moods shift it" (V4-MASK.md, Round 3):
//   * the SONG sets the palette: calm is gold-dominant, hype is white-hot, between them is home (crimson + chrome);
//     the drop flashes;
//   * HIS FACE tints it: a smile warms and brightens, a frown darkens, surprise flashes.
// Everything moves on slow followers (seconds for the mood, tenths of a second for the face), so it never flickers.
//
//   const mood = VTMaskMood.create();
//   const pal = mood.step(audio, bs, names, dt);       // audio: { level, bass, beat, bright, hit } from audio-features.js,
//                                                      // bs: MediaPipe's 52 scores (or null), dt in seconds
//   pal = { shade: [r, g, b],     the colour of shadow and rim (chin end of the gradient)      linear light
//           shade2: [r, g, b],    the same at the forehead end: the gradient across the face
//           key: [r, g, b],       the colour of the key light on the points ("chrome")
//           accent: [r, g, b],    lip / lid / brow lines and the eyes
//           gain,                 overall brightness (0.6 .. 1.3)
//           flash: [r, g, b, a],  a brief wash over everything (the drop, surprise); a = 0 when there is none
//           calm, hype, smile, frown }   the readings behind it, 0..1, for notes and tests
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskMood = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  // the three homes of the palette (linear light; red always leads, so nothing drifts to pink or purple)
  const PAL = {
    calm: { shade: [0.80, 0.20, 0.015], shade2: [1.10, 0.58, 0.07], key: [1.25, 0.82, 0.30], accent: [1.25, 0.95, 0.50], gain: 0.95 },      // amber shade, gold light
    home: { shade: [1.0, 0.045, 0.03], shade2: [1.0, 0.085, 0.03], key: [1.0, 0.93, 0.86], accent: [1.0, 0.93, 0.86], gain: 1.0 },          // crimson + chrome
    hype: { shade: [1.55, 0.66, 0.13], shade2: [1.72, 1.30, 0.74], key: [1.66, 1.60, 1.48], accent: [1.66, 1.62, 1.52], gain: 1.18 },        // white-hot: an amber shade under a warm white light (never crimson under white: that is pink)
  };
  const SILENCE = 0.06;      // a level under this is no music at all (a calm stretch of a song reads about 0.5)
  function create() {
    let energy = null, calm = 0, hype = 0, smile = 0, frown = 0, browSlow = null, surprise = 0, drop = 0, afterDrop = 0, drive = 0, quietFor = 0, dropHold = 0, heardFor = 0, silentFor = 9;
    function step(a, bs, names, dt) {
      const k = (sec) => 1 - Math.exp(-dt / sec);
      // the song. CALM = it has been quiet for a couple of seconds. HYPE = it is loud AND driving (kicks close together),
      // or the seconds after a drop; a brighter sound (more of it up high) pushes toward hype, a darker one away.
      energy = energy === null ? a.level : energy + (a.level - energy) * k(1.8);
      drive += ((a.beat || 0) - drive) * k(1.3);
      const bright = a.bright === undefined ? 0.5 : clamp01((a.bright - 0.70) / 0.22);
      const calmNow = 1 - sstep(0.58, 0.70, energy);
      // the drop: the bass slams back in after two and a half seconds without it, deep in a calm stretch. The colour changes ON it.
      // `a.hit` (audio-features.js: the one frame a big hit starts) triggers it ON the beat; the bass follower reaches 0.6 about a
      // quarter of a second later, and stays as the trigger for a source that gives no `hit`. After either, the bass coming in
      // cannot fire it a second time (dropHold).
      dropHold = Math.max(0, dropHold - dt);
      // Fix round: a drop is the bass coming back INTO MUSIC. A song that starts after silence (the first song of a show, the
      // next song after a pause) is not one: the music must have been there for the whole stretch without bass. A stop of
      // up to about a second before a drop does not count as silence (only a second of silence ends the music).
      silentFor = a.level > SILENCE ? 0 : silentFor + dt;
      heardFor = a.level > SILENCE ? heardFor + dt : silentFor > 1 ? 0 : heardFor;
      if (calm > 0.85 && quietFor > 2.5 && heardFor > 2.5 && dropHold <= 0 && (a.hit > 0 || a.bass > 0.6)) { drop = 1; afterDrop = 1; calm *= 0.25; energy = Math.max(energy, 0.72); dropHold = 1.0; }
      quietFor = a.bass < 0.6 && dropHold <= 0 ? quietFor + dt : 0;        // how long the bass has been away
      drop *= Math.exp(-dt / 0.45); afterDrop *= Math.exp(-dt / 2.6);
      const hypeNow = clamp01(Math.max(afterDrop * 1.3, sstep(0.17, 0.27, drive)) * sstep(0.62, 0.74, energy) * (0.75 + 0.5 * bright));
      calm += (calmNow - calm) * k(0.9);
      hype += (hypeNow - hype) * k(hypeNow > hype ? 0.35 : 1.4);
      // his face
      let sm = 0, fr = 0, brow = 0;
      if (bs && names) {
        const v = (n) => { const i = names.indexOf(n); return i < 0 ? 0 : bs[i]; };
        sm = sstep(0.35, 0.85, (v('mouthSmileLeft') + v('mouthSmileRight')) / 2);
        fr = sstep(0.30, 0.65, (v('browDownLeft') + v('browDownRight')) / 2) * (1 - sm);
        brow = Math.max(v('browInnerUp'), (v('browOuterUpLeft') + v('browOuterUpRight')) / 2);
      }
      smile += (sm - smile) * k(0.35); frown += (fr - frown) * k(0.5);
      browSlow = browSlow === null ? brow : browSlow + (brow - browSlow) * k(1.2);
      if (brow - browSlow > 0.28 && surprise < 0.3) surprise = 1;       // brows jump up: one flash, not a flicker
      surprise *= Math.exp(-dt / 0.35);

      let p = { ...PAL.home };
      const mixTo = (q, t, ts = t) => { for (const key of ['shade', 'shade2', 'key', 'accent']) p[key] = lerp3(p[key], q[key], key === 'shade' || key === 'shade2' ? ts : t); p.gain += (q.gain - p.gain) * t; };
      mixTo(PAL.calm, calm); mixTo(PAL.hype, hype, Math.min(1, hype * 1.7));      // the shade leaves crimson before the light turns white
      // a smile warms and brightens; a frown darkens and deepens
      p.shade = lerp3(p.shade, [1.2, 0.24, 0.03], 0.50 * smile); p.shade2 = lerp3(p.shade2, [1.3, 0.62, 0.10], 0.55 * smile); p.key = lerp3(p.key, [1.25, 1.0, 0.62], 0.35 * smile);
      p.shade = lerp3(p.shade, [0.42, 0.006, 0.012], 0.85 * frown); p.shade2 = lerp3(p.shade2, [0.5, 0.01, 0.01], 0.85 * frown);
      p.gain *= (1 + 0.30 * smile) * (1 - 0.55 * frown);
      p.key = lerp3(p.key, p.shade, 0.8 * frown); p.accent = lerp3(p.accent, [1.0, 0.16, 0.10], 0.8 * frown);
      const f = Math.max(drop * 0.55, surprise * 0.40);
      p.flash = drop * 0.55 >= surprise * 0.40 ? [1.0, 0.82, 0.55, f] : [1.0, 1.0, 1.0, f];
      p.calm = calm; p.hype = hype; p.smile = smile; p.frown = frown;
      return p;
    }
    return { step };
  }
  /**
   * The backgrounds (V4-MASK.md, Phase 2 additions) pull the palette of the mask toward their own light, so the face
   * belongs to the scene: 'summer' = sunset (coral shade, gold light), 'ice' = frozen (cyan shade, white light; his own
   * exception to the no-blue rule, for this background only). The song and his face still move it inside that family.
   */
  const BG = {
    summer: { shade: [1.15, 0.30, 0.10], shade2: [1.25, 0.62, 0.14], key: [1.25, 0.95, 0.60], accent: [1.25, 1.0, 0.70] },
    ice: { shade: [0.16, 0.62, 1.05], shade2: [0.45, 0.95, 1.20], key: [1.0, 1.12, 1.20], accent: [1.05, 1.18, 1.25] },
    // round 4. forge = iron out of the fire (ember shade, white-gold light); nebula = crimson at the chin running to gold at
    // the brow under a chrome light; studio = chrome (a warm steel shade: a pale red shade would be pink; pulled hard, like ice); street = neon
    // (crimson shade, amber lines and eyes)
    forge: { shade: [1.30, 0.16, 0.02], shade2: [1.40, 0.46, 0.05], key: [1.35, 1.02, 0.58], accent: [1.40, 1.12, 0.70] },
    nebula: { shade: [1.05, 0.040, 0.03], shade2: [1.25, 0.66, 0.13], key: [1.08, 1.0, 0.92], accent: [1.25, 1.0, 0.66] },
    studio: { shade: [0.66, 0.53, 0.46], shade2: [0.98, 0.90, 0.84], key: [1.14, 1.11, 1.08], accent: [1.16, 1.13, 1.10], k: 0.92 },
    street: { shade: [1.15, 0.035, 0.03], shade2: [1.20, 0.30, 0.04], key: [1.20, 0.88, 0.60], accent: [1.35, 0.72, 0.16] },
  };
  function tint(p, bg) {
    const q = BG[bg]; if (!q) return p;
    const lum = (c) => 0.45 * c[0] + 0.35 * c[1] + 0.2 * c[2], o = { ...p };
    for (const key of ['shade', 'shade2', 'key', 'accent']) { const k = q.k || (bg === 'ice' ? 0.92 : 0.72), m = lerp3(p[key], q[key], k), s = Math.max(0.6, Math.min(1.5, lum(p[key]) / Math.max(0.05, lum(PAL.home[key])))); o[key] = [m[0] * (0.6 + 0.4 * s), m[1] * (0.6 + 0.4 * s), m[2] * (0.6 + 0.4 * s)]; }
    return o;
  }
  return { create, tint, PAL, BG };
});
