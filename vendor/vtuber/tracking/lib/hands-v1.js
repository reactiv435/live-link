// Tracker v2: the v1 `hands` message (for the hand-line page, tracking/hands.html), now made from the body worker's
// HandLandmarker result instead of a model of its own. Same behaviour as v1's processHands. Pure UMD (no DOM).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VTHandsV1 = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class OneEuro {
    constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; this.t = null; }
    static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
    reset() { this.x = null; this.dx = 0; this.t = null; }
    filter(v, tMs) {
      if (this.x === null || this.t === null) { this.x = v; this.dx = 0; this.t = tMs; return v; }
      let dt = (tMs - this.t) / 1000;
      if (!(dt > 0)) return this.x;
      if (dt > 0.5) dt = 0.5;
      this.t = tMs;
      const rawDx = (v - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
      this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
      return this.x;
    }
  }

  const r3 = (v) => Math.round(v * 1000) / 1000;
  const HAND_HOLD_MS = 130; // ride out one missed detection, then report the hand as gone
  const mkSlot = () => ({ fx: new OneEuro(1.6, 9), fy: new OneEuro(1.6, 9), fdx: new OneEuro(1.2, 3), fdy: new OneEuro(1.2, 3), seen: 0, tip: null, dir: null });

  function create() {
    const slots = { left: mkSlot(), right: mkSlot() };
    let count = 0;
    /**
     * landmarks: HandLandmarker result.landmarks (un-mirrored, 0..1), or [] / null.
     * tMs: capture time; w, h: picture size; mirror: flip left-right; line: is the hand line switched on.
     * Returns the v1 message. "left" / "right" = the side of the picture as shown on stream (after mirror).
     */
    function process(landmarks, tMs, w, h, mirror, line) {
      const list = [];
      const lms = landmarks || [];
      for (let i = 0; i < lms.length && i < 2; i++) {
        const lm = lms[i];
        let wx = lm[0].x; let tx = lm[8].x;
        if (mirror) { wx = 1 - wx; tx = 1 - tx; }
        let dx = (tx - wx) * w; let dy = (lm[8].y - lm[0].y) * h;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l; dy /= l;
        list.push({ wx, tx, ty: lm[8].y, dx, dy });
      }
      count = list.length;
      const assign = {};
      const alive = (s) => s.tip && tMs - s.seen < 400;
      const d2 = (a, s) => (a.tx - s.tip.x) ** 2 + (a.ty - s.tip.y) ** 2;
      if (list.length === 2) {
        let [a, b] = list;
        if (Math.abs(a.wx - b.wx) < 0.06 && alive(slots.left) && alive(slots.right)) {
          // wrists nearly above each other: keep who was who
          if (d2(a, slots.left) + d2(b, slots.right) > d2(b, slots.left) + d2(a, slots.right)) [a, b] = [b, a];
        } else if (a.wx > b.wx) [a, b] = [b, a];
        assign.left = a; assign.right = b;
      } else if (list.length === 1) {
        const a = list[0];
        const la = alive(slots.left); const ra = alive(slots.right);
        let side;
        if (la && ra) side = d2(a, slots.left) <= d2(a, slots.right) ? 'left' : 'right';
        else if (la) side = d2(a, slots.left) < 0.04 ? 'left' : (a.tx < 0.5 ? 'left' : 'right');
        else if (ra) side = d2(a, slots.right) < 0.04 ? 'right' : (a.tx < 0.5 ? 'left' : 'right');
        else side = a.tx < 0.5 ? 'left' : 'right';
        assign[side] = a;
      }
      const out = {};
      for (const side of ['left', 'right']) {
        const s = slots[side];
        const a = assign[side];
        if (a) {
          if (!s.tip || tMs - s.seen > 400) { s.fx.reset(); s.fy.reset(); s.fdx.reset(); s.fdy.reset(); }
          const x = s.fx.filter(a.tx, tMs); const y = s.fy.filter(a.ty, tMs);
          let dx = s.fdx.filter(a.dx, tMs); let dy = s.fdy.filter(a.dy, tMs);
          const l = Math.hypot(dx, dy) || 1;
          dx /= l; dy /= l;
          s.tip = { x, y }; s.dir = { x: dx, y: dy }; s.seen = tMs;
          out[side] = true;
        } else {
          out[side] = !!(s.tip && tMs - s.seen <= HAND_HOLD_MS);
          if (!out[side]) s.tip = null;
        }
      }
      const pt = (p) => ({ x: r3(p.x), y: r3(p.y) });
      return {
        t: 'hands', ok: !!(out.left || out.right),
        left: out.left ? pt(slots.left.tip) : null, right: out.right ? pt(slots.right.tip) : null,
        leftDir: out.left ? pt(slots.left.dir) : null, rightDir: out.right ? pt(slots.right.dir) : null,
        at: Math.round(tMs),
        // optional extras (not in v1): picture shape, and whether the line is switched on
        aspect: r3(w / (h || 1)), line: !!line,
      };
    }
    function none(tMs, line) {
      slots.left.tip = null; slots.right.tip = null; count = 0;
      return { t: 'hands', ok: false, left: null, right: null, leftDir: null, rightDir: null, at: Math.round(tMs), line: !!line };
    }
    return { process, none, count: () => count };
  }

  return { create, OneEuro };
});
