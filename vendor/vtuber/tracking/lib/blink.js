// Eyelid reading -> "how closed is this eye" (0 open .. 1 shut). Browser ES module, also used by the offline checks.
//
// MediaPipe's eyeBlink score rises in a blink, but ALSO when the eye looks down (the lid follows the eye) and when it
// squints (a smile); on some faces a real blink only reaches 0.5-0.65 while a lowered lid already reads 0.4-0.5, so the
// score alone cannot tell them apart. Two things can:
//   1. A blink is SHORT. eyeLookDown and eyeSquint are measured separately; their SUSTAINED part (the lowest value of
//      the last quarter second, which a blink is too short to move much) is taken out of the blink score. A lowered or squinted lid
//      then reads about 0, and a blink on top of it still stands out.
//   2. The lid gap itself (from the landmarks), against how open this eye normally is. Only when the gap is nearly
//      gone does this term reach 1, so eyes that are really held shut keep reading "shut" after part 1 has faded.
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const remap01 = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

// Tuned on the owner's three test clips (tools/fix-blink-sim.mjs): his blinks peak at 0.5-0.65, a lowered lid at 0.4-0.5.
export const BLINK_MAP = {
  windowMs: 250,            // "sustained" = lowest value in this window (longer than the closing half of a blink)
  down: 0.5, squint: 0.2,   // how much of the sustained look-down / squint is removed from the blink score
  lo: 0.16, hi: 0.36,       // what is left: lo = open, hi = shut
  shutLo: 0.68, shutHi: 0.8, // 1 - (gap / open gap): from here the lid gap alone says "shut"
  openRiseS: 0.3, openFallS: 20, // the "open gap" follows a wider eye quickly and a narrower one slowly
};

/** One eye. Call update() once per tracked picture. */
export class EyeLid {
  constructor(o = BLINK_MAP) { this.o = o; this.reset(); }
  reset() { this.dn = []; this.sq = []; this.open = null; this.t = null; }
  _min(list, v, t) {
    list.push([t, v]);
    while (list.length > 1 && t - list[0][0] > this.o.windowMs) list.shift();
    let m = v;
    for (const e of list) if (e[1] < m) m = e[1];
    return m;
  }
  /** blink / lookDown / squint: MediaPipe scores of this eye (0..1). gap: lid gap / eye width (0 = unknown). */
  update(blink, lookDown, squint, gap, tMs) {
    const o = this.o;
    const dt = this.t === null ? 0.05 : Math.min(0.5, Math.max(0.001, (tMs - this.t) / 1000));
    this.t = tMs;
    const sustained = o.down * this._min(this.dn, Number(lookDown) || 0, tMs) + o.squint * this._min(this.sq, Number(squint) || 0, tMs);
    let c = remap01((Number(blink) || 0) - sustained, o.lo, o.hi);
    if (gap > 0) {
      if (this.open === null) this.open = gap;
      else this.open += (gap - this.open) * (1 - Math.exp(-dt / (gap > this.open ? o.openRiseS : o.openFallS)));
      c = Math.max(c, remap01(1 - gap / Math.max(1e-6, this.open), o.shutLo, o.shutHi));
    }
    return c;
  }
}
