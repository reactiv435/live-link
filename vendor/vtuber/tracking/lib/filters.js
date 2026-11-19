// One Euro filter (Casiez et al.) + small helpers. Browser ES module.

export class OneEuro {
  // minCutoff (Hz): lower = steadier when still. beta: higher = snappier when moving.
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset(v = null) { this.x = v; this.dx = 0; this.t = null; }
  // tMs: timestamp in ms. Returns the filtered value.
  filter(v, tMs) {
    if (this.x === null || this.t === null) { this.x = v; this.dx = 0; this.t = tMs; return v; }
    let dt = (tMs - this.t) / 1000;
    if (!(dt > 0)) return this.x;
    if (dt > 0.5) dt = 0.5;
    this.t = tMs;
    const rawDx = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Map v from [lo,hi] to [0,1], clamped.
export const remap01 = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
// Exponential ease of `cur` toward `target` with time constant tau (seconds).
export const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
