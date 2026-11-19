// Mood detector with hold-and-hysteresis. Browser ES module (also runs in Node for offline checks).
// Input every frame: the smoothed, calibrated 0..1 face values. Output: one of
// 'neutral' | 'happy' | 'surprised' | 'annoyed' | 'smug' | 'bored'.
//
// A mood has a strength 0..1. It may START only after its strength stays >= ENTER for enterMs,
// and it ENDS only after its strength stays < EXIT for exitMs. So it never flickers.

const remap01 = (v, lo, hi) => { const x = (v - lo) / (hi - lo); return x < 0 ? 0 : x > 1 ? 1 : x; };

export const MOOD_DEFAULTS = {
  enter: 0.55,
  exit: 0.3,
  enterMs: 400,
  smugEnterMs: 650, // a smirk must sit a little longer (talking pulls the mouth sideways for a moment)
  exitMs: 450,
  minDwellMs: 700,
  // bored = eyes half closed + low movement for this long
  boredAfterMs: 2500,
  boredEnergyMax: 7, // deg/s of head movement (plus mouth activity)
};

// Order = priority when two moods are equally strong.
const ORDER = ['surprised', 'happy', 'smug', 'annoyed', 'bored'];

export class MoodDetector {
  constructor(opts = {}) {
    this.o = { ...MOOD_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.mood = 'neutral';
    this.since = 0;
    this.candidate = null;
    this.candidateSince = 0;
    this.belowSince = null;
    this.boredMs = 0;
    this.lastT = null;
    this.strengths = { happy: 0, surprised: 0, annoyed: 0, smug: 0, bored: 0 };
  }

  // f: {smile, smileL, smileR, browUp, browDown, eyeWide, jaw, blink, energy, yaw}
  strengthsOf(f, dtMs) {
    const asym = Math.abs(f.smileL - f.smileR);
    const lop = Math.max(f.smileL, f.smileR);
    // bored timer: fills while the eyes are half closed and the head is quiet, drains twice as fast otherwise
    const halfClosed = f.blink > 0.3 && f.blink < 0.85;
    const quiet = f.energy < this.o.boredEnergyMax && f.smile < 0.3 && f.jaw < 0.25;
    if (halfClosed && quiet) this.boredMs = Math.min(this.o.boredAfterMs * 1.5, this.boredMs + dtMs);
    else this.boredMs = Math.max(0, this.boredMs - dtMs * 2);

    return {
      happy: remap01(f.smile, 0.3, 0.6),
      // raised brows are the main sign; wide eyes or a dropped jaw push it over the line
      // (MediaPipe's "eye wide" reading is weak on many faces, so brows + open mouth also counts)
      surprised: remap01(f.browUp, 0.3, 0.6) * Math.min(1, 0.5 + Math.max(remap01(f.eyeWide, 0.1, 0.5), remap01(f.jaw, 0.2, 0.5))),
      annoyed: remap01(f.browDown, 0.35, 0.65) * (1 - remap01(f.smile, 0.15, 0.4)),
      // one-sided smile with the mouth mostly shut (talking also pulls the mouth sideways, so an open jaw cancels it)
      // (a turned head also makes the two mouth corners read differently, so it fades out past ~8 degrees of yaw)
      smug: lop > 0.35 ? remap01(asym, 0.2, 0.4) * (1 - remap01(f.smile, 0.5, 0.75)) * (1 - remap01(f.jaw, 0.15, 0.35)) *
        (1 - remap01(Math.abs(f.yaw || 0), 8, 16)) : 0,
      bored: remap01(this.boredMs, this.o.boredAfterMs * 0.5, this.o.boredAfterMs),
    };
  }

  update(f, tMs) {
    const dt = this.lastT === null ? 0 : Math.min(200, Math.max(0, tMs - this.lastT));
    this.lastT = tMs;
    const s = this.strengthsOf(f, dt);
    this.strengths = s;
    const o = this.o;

    // strongest mood that is over the ENTER line
    let best = null;
    for (const m of ORDER) {
      if (s[m] >= o.enter && (best === null || s[m] > s[best] + 0.05)) best = m;
    }

    if (this.mood !== 'neutral') {
      const cur = s[this.mood];
      // current mood holds while it is above EXIT
      if (cur >= o.exit) this.belowSince = null;
      else if (this.belowSince === null) this.belowSince = tMs;
      const dwellOk = tMs - this.since >= o.minDwellMs;
      const faded = this.belowSince !== null && tMs - this.belowSince >= o.exitMs;
      // a clearly stronger other mood may take over after the hold time
      if (best && best !== this.mood && (faded || s[best] > cur + 0.25)) {
        if (this.candidate !== best) { this.candidate = best; this.candidateSince = tMs; }
        if (dwellOk && tMs - this.candidateSince >= (best === 'smug' ? o.smugEnterMs : o.enterMs)) this.switchTo(best, tMs);
      } else {
        this.candidate = null;
        if (faded && dwellOk) this.switchTo('neutral', tMs);
      }
    } else if (best) {
      if (this.candidate !== best) { this.candidate = best; this.candidateSince = tMs; }
      if (tMs - this.candidateSince >= (best === 'smug' ? o.smugEnterMs : o.enterMs)) this.switchTo(best, tMs);
    } else {
      this.candidate = null;
    }
    return this.mood;
  }

  switchTo(m, tMs) {
    this.mood = m;
    this.since = tMs;
    this.candidate = null;
    this.belowSince = null;
  }
}
