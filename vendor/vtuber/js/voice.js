// V5 voice: what his VOICE says about his mouth (open / wide / round / closed), next to what the camera sees.
// Pure logic, three homes: the microphone's audio thread (js/mic-worklet.js loads this file first), the avatar page
// (js/face-map.js FaceAnimator) and Node (tests, tools/v5-*.mjs on a recorded sound track; never the real microphone).
//   VTVoice.Bands(sampleRate)        four band-pass filters over the raw samples: push(samples) ... read() -> { rms, b: [4] }
//                                    bands: 320 Hz (the low first formant: oo, ee, m, n), 800 Hz (an open jaw: ah, a),
//                                    2300 Hz (spread lips: ee, i, e), 5500 Hz (s, sh, f, t: teeth together)
//   VTVoice.levelFromRms(rms, sens, gate)   the 0..1 loudness the pages have always sent as { t: 'mic', level }
//   VTVoice.Mouth()                  update(level, bands | null, nowMs) -> { on, talking, open, wide, round, sib, loud }
//                                    on = a microphone is being heard at all; talking = he is speaking right now
// The shape comes from how the sound is spread over the bands AGAINST HIS OWN AVERAGE (learned while he talks, so a
// dark or a bright microphone gives the same mouth); loudness alone still opens the mouth when no bands arrive.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTVoice = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const CENTRES = [320, 800, 2300, 5500], Q = [1.1, 1.3, 1.3, 1.0];

  class Bands {
    constructor(sampleRate) {
      this.rate = sampleRate || 48000;
      this.c = CENTRES.map((f, i) => {
        const w = 2 * Math.PI * Math.min(f, this.rate * 0.45) / this.rate, alpha = Math.sin(w) / (2 * Q[i]), a0 = 1 + alpha;
        return { b0: alpha / a0, b2: -alpha / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0, sum: 0 };
      });
      this.sum = 0; this.n = 0;
    }
    push(samples) {
      const c = this.c;
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        this.sum += x * x;
        for (let k = 0; k < 4; k++) {
          const f = c[k], y = f.b0 * x + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
          f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; f.sum += y * y;
        }
      }
      this.n += samples.length;
    }
    /** The loudness and the four band levels since the last read (all as RMS). */
    read() {
      const n = Math.max(1, this.n), out = { rms: Math.sqrt(this.sum / n), b: this.c.map((f) => { const v = Math.sqrt(f.sum / n); f.sum = 0; return Number.isFinite(v) ? v : 0; }) };
      for (const f of this.c) if (!Number.isFinite(f.y1) || !Number.isFinite(f.y2)) { f.x1 = f.x2 = f.y1 = f.y2 = 0; }
      this.sum = 0; this.n = 0;
      return out;
    }
  }
  function levelFromRms(rms, sens, gate) {
    const db = 20 * Math.log10(Math.max(rms, 1e-7)) + (Number.isFinite(sens) ? sens : 6);
    const level = clamp((db + 54) / 42, 0, 1);
    return level < (Number.isFinite(gate) ? gate : 0.06) ? 0 : level;
  }

  const P = Object.freeze({
    staleMs: 350,                 // no microphone message for this long = no microphone
    attackMs: 12, releaseMs: 75,  // the syllable envelope
    slowMs: 320,                  // the level of the phrase (a syllable is a rise above it)
    talkOn: 0.16, talkOff: 0.09, talkHoldMs: 180,
    shapeMs: 45,                  // band shares are smoothed this much (a vowel lasts 80 ms and more)
    learnMs: 6000,                // his own average spread over the bands, learned while he talks
    // where the shares sit for an ordinary voice on an ordinary microphone (the start, before anything is learned)
    mean: [0.36, 0.30, 0.22, 0.12], dev: [0.12, 0.10, 0.09, 0.08],
  });

  class Mouth {
    constructor() { this.reset(); }
    reset() {
      this.at = -1e9; this.last = null; this.env = 0; this.slow = 0; this.talking = false; this.talkAt = -1e9;
      this.share = P.mean.slice(); this.mean = P.mean.slice(); this.dev = P.dev.slice(); this.hasBands = false; this.bandsAt = -1e9;
      this.out = { on: false, talking: false, open: 0, wide: 0, round: 0, sib: 0, loud: 0 };
    }
    /** level: 0..1 (the `mic` message); bands: [4] band levels of the same moment, or null; now: this page's clock. */
    update(level, bands, now) {
      const o = this.out, dt = this.last == null ? 16 : clamp(now - this.last, 0, 200);
      this.last = now;
      const lv = clamp(Number(level) || 0, 0, 1);
      this.at = now;
      this.env += (lv - this.env) * (1 - Math.exp(-dt / (lv > this.env ? P.attackMs : P.releaseMs)));
      this.slow += (this.env - this.slow) * (1 - Math.exp(-dt / P.slowMs));
      if (this.env > P.talkOn) { this.talking = true; this.talkAt = now; }
      else if (this.env < P.talkOff && now - this.talkAt > P.talkHoldMs) this.talking = false;
      let ah = 0, ee = 0, oo = 0, sib = 0;
      if (Array.isArray(bands) && bands.length >= 4) {
        const tot = bands[0] + bands[1] + bands[2] + bands[3];
        if (tot > 1e-7 && lv > 0) {
          this.hasBands = true; this.bandsAt = now;
          const k = 1 - Math.exp(-dt / P.shapeMs), kl = this.env > P.talkOn ? 1 - Math.exp(-dt / P.learnMs) : 0;
          for (let i = 0; i < 4; i++) {
            const s = bands[i] / tot;
            this.share[i] += (s - this.share[i]) * k;
            this.mean[i] += (s - this.mean[i]) * kl;
            this.dev[i] += (Math.abs(s - this.mean[i]) * 1.25 - this.dev[i]) * kl;
          }
        }
      }
      if (this.hasBands && now - this.bandsAt < P.staleMs) {
        const z = (i) => (this.share[i] - this.mean[i]) / Math.max(0.04, this.dev[i]);
        sib = sstep(0.9, 2.2, z(3)) * sstep(0.25, 0.4, this.share[3]);
        ah = sstep(0.1, 1.3, z(1)) * (1 - sib);
        ee = sstep(0.2, 1.4, z(2)) * (1 - 0.6 * ah) * (1 - sib);
        oo = sstep(0.2, 1.4, z(0) - 0.5 * Math.max(0, z(2))) * (1 - ee) * (1 - 0.7 * ah) * (1 - sib);
      }
      // the mouth opens with the syllable: the envelope, pushed apart from the level of the phrase
      // (loud or quiet voice alike: a syllable is the envelope standing over the phrase's own level, a gap is it falling under)
      const rel = this.env / Math.max(this.slow, 0.18);
      const base = this.talking ? clamp((rel - 0.62) / 0.6, 0, 1) * (0.5 + 0.5 * Math.min(1, this.env / 0.6)) : 0;
      o.on = true; o.talking = this.talking;
      o.open = clamp(base * (0.8 + 0.3 * ah - 0.28 * ee - 0.25 * oo - 0.62 * sib), 0, 1);
      o.wide = this.talking ? clamp(0.75 * ee + 0.45 * sib - 0.7 * oo - 0.1, -1, 1) : 0;
      o.round = this.talking ? clamp(0.95 * oo, 0, 1) : 0;
      o.sib = this.talking ? sib : 0;
      o.loud = this.env;
      return o;
    }
    /** What the voice says now (the microphone gone quiet for staleMs = { on: false }). */
    read(now) {
      const o = this.out;
      if (now - this.at > P.staleMs) { o.on = false; o.talking = false; o.open = o.wide = o.round = o.sib = o.loud = 0; this.env = 0; this.talking = false; }
      return o;
    }
  }
  return { Bands, Mouth, levelFromRms, CENTRES, P, clamp, sstep };
});
