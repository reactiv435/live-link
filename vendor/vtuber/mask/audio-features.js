// V4 MASK: music analysis. Pure UMD, no DOM: the same code reads a live AnalyserNode spectrum (Phase 2) or an
// offline STFT of a file (tools/v4-mask-audio.mjs), so what the clips show is what the live mask will do.
//
//   const a = VTMaskAudio.create({ sampleRate: 48000, fftSize: 2048, rate: 60 });
//   const f = a.push(magDb);        // one spectrum per call, `rate` calls a second. magDb: Float32Array(fftSize / 2),
//                                   // decibels as AnalyserNode.getFloatFrequencyData gives them (smoothing 0)
//   f = { bass, mid, high,          // 0..1 band levels: fast attack, slow release, self-levelling (so a quiet and a
//                                   //   loud song both fill the range). They BREATHE.
//         beat,                     // 0..1: jumps to the strength of a kick and decays in about a fifth of a second
//         kick,                     // 0, or the strength (0..1) on the ONE frame a kick starts
//         hit,                      // 0, or the strength (0..1) on the one frame a BIG hit starts (a drop, a crash, the
//                                   //   first kick after a break): at most one about every second
//         flux, level,              // the raw onset curve (0..1) and the overall loudness (0..1)
//         bright }                  // 0..1: how bright the sound is (its spectral centroid between 300 Hz and 5 kHz, on a
//                                   //   log scale, followed over about a second): dark pads low, hats and air high
//
// How: three bands (bass 35-150 Hz, mid 200-2000 Hz, high 4-12 kHz) in decibels. Each band is levelled against its own
// slowly forgetting floor and ceiling. A kick = the rise of the bass band (positive spectral flux, in dB) standing clear
// of what the last second and a half did (helped by the rise of the whole band: a kick is a thump and a click), taken at
// its PEAK (so one frame, 16 ms, late), with a 160 ms dead time. Its strength is measured against the strongest onset of
// the last seconds. A big hit = a top-strength kick whose whole-band rise matches the best of the last 4 seconds, or a
// kick that ends at least 0.6 s of quiet bass. Band levels are half absolute, half against the last 2.5 s, so a
// sustained sub bass still breathes.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const BANDS = { bass: [35, 150], mid: [200, 2000], high: [4000, 12000] };

  function create({ sampleRate = 48000, fftSize = 2048, rate = 60 } = {}) {
    const hz = sampleRate / fftSize, dt = 1 / rate;
    const bins = {};
    for (const k in BANDS) bins[k] = [Math.max(1, Math.round(BANDS[k][0] / hz)), Math.min(fftSize / 2 - 1, Math.round(BANDS[k][1] / hz))];
    const coef = (sec) => 1 - Math.exp(-dt / sec);
    const st = {};
    for (const k in BANDS) st[k] = { lo: -70, hi: -30, env: 0, seen: 0 };
    const fluxHist = [], allHist = [];
    let brightEnv = null, prevSpec = null, cur = null, beat = 0, sinceKick = 9, sinceHit = 9, quiet = 0, wasQuiet = 0, levelEnv = 0, o1 = 0, o2 = 0, oMax = 0, fa1 = 0;

    /** mean power of a band, in dB */
    function bandDb(mag, a, b) {
      let s = 0;
      for (let i = a; i <= b; i++) s += Math.pow(10, mag[i] / 10);
      return 10 * Math.log10(s / (b - a + 1) + 1e-12);
    }
    const med = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((p, q) => p - q); return s[s.length >> 1]; };

    function push(mag) {
      const out = { bass: 0, mid: 0, high: 0, beat: 0, kick: 0, hit: 0, flux: 0, level: 0, bright: 0 };
      let loud = 0;
      for (const k in BANDS) {
        const s = st[k], db = Math.max(-100, bandDb(mag, bins[k][0], bins[k][1]));
        // floor and ceiling: jump outward at once, creep back in (ceiling over ~8 s, floor over ~20 s)
        // Round 5 (the first drop after a start was missed live): the floor must not learn from SILENCE. One spectrum of
        // digital silence (the moment before the PC-sound helper's first samples, a gap in its pipe) dropped `lo` to
        // -100 dB at once, and it climbs back with a 20 s time constant: for the first half minute every quiet stretch
        // read as half loud (bass 0.4 instead of 0.1), so "the bass has been away" never held. Now a silent spectrum
        // moves neither end, the first real one sets them, and the floor never falls further than 48 dB under the top.
        const silent = db <= -90;
        if (!s.seen && silent) { out[k] = 0; continue; }
        if (!s.seen) { s.hi = db + 6; s.lo = db - 24; }
        s.seen++;
        if (!silent) {
          s.hi = db > s.hi ? db : s.hi + (db - s.hi) * coef(8);
          s.lo = db < s.lo ? Math.max(db, s.hi - 48) : s.lo + (db - s.lo) * coef(20);
        }
        const span = Math.max(18, s.hi - s.lo);                       // never stretch noise to the full range
        const abs = clamp01((db - (s.hi - span)) / span);
        s.mean = s.mean == null ? db : s.mean + (db - s.mean) * coef(2.5);
        const rel = clamp01(0.5 + (db - s.mean) / 14);                  // against the last seconds: +-7 dB fills the range
        const v = clamp01(abs * (0.45 + 0.55 * rel) * 1.25);
        const shaped = v * v * (3 - 2 * v);
        s.env += (shaped - s.env) * (shaped > s.env ? coef(0.025) : coef(k === 'bass' ? 0.26 : k === 'mid' ? 0.32 : 0.15));
        out[k] = s.env;
        loud += abs;
      }
      levelEnv += (loud / 3 - levelEnv) * coef(0.5);
      out.level = levelEnv;
      // brightness: the centre of gravity of the spectrum (linear magnitude), 150 Hz .. 10 kHz
      let cn = 0, cd = 0;
      for (let i = Math.max(1, Math.round(150 / hz)), e = Math.min(fftSize / 2 - 1, Math.round(10000 / hz)); i <= e; i++) { const a = Math.pow(10, mag[i] / 20); cn += a * i * hz; cd += a; }
      const cen = cd > 1e-9 ? cn / cd : 1000, b01 = clamp01(Math.log(cen / 300) / Math.log(5000 / 300));
      brightEnv = brightEnv === null ? b01 : brightEnv + (b01 - brightEnv) * coef(0.9);
      out.bright = brightEnv;

      // onset curves: positive change of the COMPRESSED magnitude spectrum (log(1 + 400 |X|): loud partials count, the
      // noise floor does not), in the bass band and over the whole band
      let fb = 0, fa = 0;
      const top = Math.min(fftSize / 2 - 1, Math.round(12000 / hz)), b0 = bins.bass[0], b1 = Math.min(fftSize / 2 - 1, Math.round(220 / hz));
      if (!prevSpec) { prevSpec = new Float32Array(fftSize / 2); cur = new Float32Array(fftSize / 2); for (let i = 1; i <= top; i++) prevSpec[i] = Math.log(1 + 400 * Math.pow(10, mag[i] / 20)); }
      for (let i = 1; i <= top; i++) {
        const c = Math.log(1 + 400 * Math.pow(10, mag[i] / 20)), d = c - prevSpec[i];
        if (d > 0) { fa += d; if (i >= b0 && i <= b1) fb += d; }
        prevSpec[i] = c;
      }
      fb /= (b1 - b0 + 1); fa /= top;

      // one onset curve: mostly the bass band, helped by the whole band (a kick is a thump AND a click)
      const o = fb + 4 * fa;
      const m = med(fluxHist), dev = med(fluxHist.map((v) => Math.abs(v - m)));
      const maxAll = allHist.length ? Math.max.apply(null, allHist) : 0;
      oMax = Math.max(o, oMax * Math.exp(-dt / 6));                       // the strongest onset of the last seconds
      sinceKick += dt; sinceHit += dt;
      quiet = st.bass.env < 0.3 ? quiet + dt : 0;
      // a kick is the PEAK of the curve: decided one frame late (16 ms), so the strength is the peak's, not the first rise
      let kick = 0;
      const thr = m + 3.5 * dev + 0.28 * oMax;
      if (fluxHist.length > rate * 0.3 && o1 > thr && o1 >= o && o1 > o2 && sinceKick > 0.16) {
        kick = clamp01(0.25 + 0.75 * (o1 - thr) / Math.max(1e-6, oMax - thr));
        sinceKick = 0;
      }
      o2 = o1; o1 = o;
      let hit = 0;
      if (kick && sinceHit > 0.9 && allHist.length > rate) {
        if (kick > 0.82 && fa1 > maxAll * 0.95) hit = kick;
        else if (wasQuiet > 0.6) hit = Math.max(0.8, kick);
      }
      fa1 = fa;
      wasQuiet = kick ? 0 : quiet;
      if (hit) sinceHit = 0;
      fluxHist.push(o); if (fluxHist.length > Math.round(rate * 1.5)) fluxHist.shift();
      allHist.push(fa); if (allHist.length > Math.round(rate * 4)) allHist.shift();

      beat = kick ? Math.max(beat, kick) : beat * Math.exp(-dt / 0.2);
      out.beat = beat; out.kick = kick; out.hit = hit; out.flux = clamp01(o / Math.max(1e-3, oMax));
      return out;
    }
    return { push, bands: BANDS };
  }
  return { create, BANDS };
});
