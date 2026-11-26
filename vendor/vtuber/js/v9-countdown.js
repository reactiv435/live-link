// COUNTDOWN 2.0, the brain (review/V9-COUNTDOWN-NOTES.md). Pure UMD, no DOM, no clock of its own: the page, the tests
// and the render tool pass the time in seconds. It turns the countdown (js/v9-show-engine.js: the time, the last ten on
// the beat, the zero) and the chat (taps, gifts) into what the Quantum Flow Mask does while it waits for the show:
//
//   DORMANT   charge 0: the Mask dark and asleep, the cables heavy and slack, the eyes shut.
//   EVERY TAP a pulse of light runs down ONE cable into the Mask (a different cable each time; a bunch is staggered over
//             the cables); its arrival is a small flash inside the face. A gift is a bigger surge, sized by the gift.
//   FILLING   the light inside rises from the chin up WITH THE CLOCK: fill 0 at the start, 1 at the zero. Taps and gifts
//             make it RICHER (brighter, more sparks), never faster or slower: they never touch the time.
//   LAST TEN  the cables tighten and pulse on each number (which the engine put on the beat), the energy churns, the
//             eyes flutter on 3, 2, 1.
//   BUILD-UP  the last 3 s: brighter, churning, the cables taut, the head bows into it; then a short in-breath (the light
//             pulled in, the eyes squeezed shut) so the zero lands as a clear hit.
//   ZERO      once: the eyes open and ignite, every cable surges end to end, the head lifts; then it settles.
//
//   const cd2 = VTCountdown2.create({ startAt, endAt, fillFrom = 0, count = 36, taps0 = 0, gifts0 = 0, rich0 = 0 });
//     (fillFrom, taps0, gifts0, rich0: what a countdown pressed again carries on from the one it replaces;
//      order: the cables in the order they are used, the page puts the sockets that face the camera first)
//   cd2.tap(n, t); cd2.gift(coins, count, t);
//   const w = cd2.step(t, view)     view = the engine's countdown.step(...) (or null: the zero is then endAt itself)
//   w = { fill, rich, charge, life, slack, tight, churn, seam, gem, blink, lum, build, inhale, alive, flash, pitch, yaw, roll,
//         zero (true on the ONE step the zero is reached), zeroAge, tick (the number shown big, or -1), send: [...],
//         arrivals: [{ c, age, s, kind }] }
//   send = what the cables are told this step: { k: 'tap', t, v: 0..1 (the cable) } | { k: 'gift', t, v: coins } |
//          { k: 'drain', t } | { k: 'whip', t, v } | { k: 'drop', t, v }   (VTCableRig's own calls, by name)
// Everything stays a finite number whatever the times do (0 dt, a huge jump, a step back, garbage).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTCountdown2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const clamp01 = (x) => clamp(x, 0, 1);
  const sstep = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
  const fin = (x, d) => (Number.isFinite(x) ? x : d);
  const TAP_RUN = 0.70, GIFT_RUN = 0.62, STAGGER = 0.085, PER_EVENT = 12, QUEUE_MAX = 48, RICH_TAU = 25, RICH_K = 18;
  const BOW = -13 * Math.PI / 180, LIFT = 3 * Math.PI / 180;
  /** ease out with a little overshoot: the head comes up and settles */
  const backOut = (x) => { const k = clamp01(x), c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  /** the size of a gift, the same scale the cable rig uses (0.15 small .. 1 = every cable) */
  const giftSize = (coins) => clamp(Math.log10(Math.max(1, Number(coins) || 1) + 1) / 3.7, 0.15, 1);

  function create({ startAt = 0, endAt = 60, fillFrom = 0, count = 36, taps0 = 0, gifts0 = 0, rich0 = 0, order = null } = {}) {
    const n = Math.max(1, Math.min(256, Math.round(Number(count) || 36)));
    const t0 = fin(Number(startAt), 0), t1 = Math.max(t0 + 1, fin(Number(endAt), t0 + 60)), f0 = clamp01(fin(Number(fillFrom), 0));
    // the order the cables are used in when none has been used yet: spread round the head, not one side then the other
    // (order: the cables to use first, e.g. those whose sockets face the camera, so ONE tap lands where it is seen)
    let scramble = []; for (let i = 0; i < n; i++) scramble.push((i * 17 + 5) % n);
    if (Array.isArray(order) && order.length === n && new Set(order.map(Number)).size === n && order.every((c) => Number.isInteger(Number(c)) && c >= 0 && c < n)) scramble = order.map(Number);
    const S = { lastT: t0, E: 0, queue: [], gq: [], used: new Float64Array(n).fill(-1e9), nextFree: -1e9, arr: [], zeroAt: null, zeroSent: false, tickSeen: 11, tickAt: -9, tickN: -1, gemK: 0, taps: 0, gifts: 0, pulses: 0, out: [] };
    S.taps = Math.max(0, Math.round(fin(Number(taps0), 0))); S.gifts = Math.max(0, Math.round(fin(Number(gifts0), 0)));
    S.E = -RICH_K * Math.log(1 - Math.min(0.999, clamp01(fin(Number(rich0), 0))));
    let pick = 0;
    function cable(at) {
      // the cable that has rested longest; on a tie the next in the scrambled order
      let best = -1, bestT = Infinity;
      for (let k = 0; k < n; k++) { const c = scramble[(pick + k) % n]; if (S.used[c] < bestT - 1e-9) { bestT = S.used[c]; best = c; } }
      pick = (pick + 1) % n; S.used[best] = at; return best;
    }
    const now = (t) => (Number.isFinite(t) ? Math.max(t, S.lastT) : S.lastT);
    function tap(count = 1, t) {
      const k = clamp(Math.round(fin(Number(count), 1)), 1, 200), at = now(t);
      S.taps += k; S.E += k;
      // one pulse per tap (up to a dozen per event, four dozen waiting): a big bunch is the dozen, still staggered
      const m = Math.min(k, PER_EVENT, QUEUE_MAX - S.queue.length);
      let when = Math.max(at, S.nextFree);
      for (let i = 0; i < m; i++) { S.queue.push({ k: 'tap', t: when }); when += STAGGER; }
      if (m > 0) S.nextFree = when;
      return m;
    }
    function gift(coins = 1, cnt = 1, t) {
      const k = clamp(Math.round(fin(Number(cnt), 1)), 1, 200), c = clamp(fin(Number(coins), 1), 1, 1e6), at = now(t), size = giftSize(c);
      S.gifts += k; S.E += Math.min(6, k) * (3 + 8 * size);
      if (S.gq.length < 16) S.gq.push({ k: 'gift', t: at, coins: c, size });      // (a gift never waits behind the taps)
      return size;
    }
    function step(t, view) {
      const tt = Number.isFinite(t) ? t : S.lastT, dt = clamp(tt - S.lastT, 0, 1e6); S.lastT = Math.max(S.lastT, tt);
      const T = S.lastT, send = [];
      S.E *= Math.exp(-dt / RICH_TAU); if (!(S.E >= 0) || S.E > 1e7) S.E = 0;
      S.gemK *= Math.exp(-Math.min(dt, 10) * 2.2);
      const rich = 1 - Math.exp(-S.E / RICH_K);
      // the zero: the engine's (it lands on the beat), once; without the engine, the time itself
      const v = view && typeof view === 'object' ? view : null;
      if (S.zeroAt === null && ((v && v.done) || (!v && T >= t1))) S.zeroAt = v && v.done ? T - clamp(fin(v.doneAge, 0), 0, 5) : t1;
      const z = S.zeroAt !== null, zAge = z ? Math.max(0, T - S.zeroAt) : 0;
      const remaining = v ? Math.max(0, fin(v.remaining, 0)) : Math.max(0, t1 - T);
      // the chat queue: what is due is sent now (to the cables), its arrival is remembered (for the flash in the face)
      while (S.gq.length && S.gq[0].t <= T + 1e-9) { const q = S.gq.shift(); send.push({ k: 'gift', t: q.t, v: q.coins }); S.arr.push({ at: q.t + GIFT_RUN, c: -1, s: q.size, kind: 'gift' }); }
      while (S.queue.length && S.queue[0].t <= T + 1e-9) {
        const q = S.queue.shift();
        if (q.k === 'tap') { const c = cable(q.t); S.pulses++; send.push({ k: 'tap', t: q.t, v: (c + 0.5) / n }); S.arr.push({ at: q.t + TAP_RUN, c, s: 1, kind: 'tap' }); }
        else { send.push({ k: 'gift', t: q.t, v: q.coins }); S.arr.push({ at: q.t + GIFT_RUN, c: -1, s: q.size, kind: 'gift' }); }
      }
      // the last ten: each new number (the engine put it on the beat) is a pulse in on every cable and a small whip
      let tick = -1;
      if (v && v.big && Number.isFinite(v.n) && v.n >= 0) {
        tick = v.n;
        if (v.n < S.tickSeen) {
          S.tickSeen = v.n; S.tickAt = T - clamp(fin(v.tickAge, 0), 0, 2); S.tickN = v.n;
          if (v.n > 0) { send.push({ k: 'drain', t: S.tickAt }); send.push({ k: 'whip', t: S.tickAt, v: 0.25 + 0.04 * (10 - v.n) }); S.gemK = Math.max(S.gemK, 0.5 + 0.05 * (10 - v.n)); }
        }
      }
      let zero = false;
      if (z && !S.zeroSent) { S.zeroSent = true; zero = true; send.push({ k: 'drop', t: S.zeroAt, v: 1.3 }); }
      // arrivals that are due: a bump of the gem; the ones a little past are kept for the face's flashes
      const arrivals = [];
      for (const a of S.arr) {
        const age = T - a.at;
        if (age >= 0 && !a.hit) { a.hit = true; S.gemK = Math.max(S.gemK, a.kind === 'gift' ? 0.3 + 0.5 * a.s : Math.min(0.6, S.gemK + 0.12)); }
        if (age >= 0 && age < 1.6) arrivals.push({ c: a.c, age, s: a.s, kind: a.kind });
      }
      S.arr = S.arr.filter((a) => T - a.at < 1.6);
      if (S.arr.length > 64) S.arr.splice(0, S.arr.length - 64);
      arrivals.sort((a, b) => a.age - b.age); if (arrivals.length > 8) arrivals.length = 8;

      // the clock fills the Mask: monotonic, 0 .. 1, never moved by the chat
      const u = clamp01((T - t0) / (t1 - t0)), fill = z ? 1 : f0 + (1 - f0) * u;
      const last = sstep(10.5, 0, remaining) * (z ? 0 : 1), alive = z ? sstep(0, 0.25, zAge) : 0;
      const tickAge = S.tickAt > -9 ? Math.max(0, T - S.tickAt) : 99, tickP = S.tickN > 0 ? Math.exp(-tickAge / 0.22) : 0;
      const flutter = S.tickN >= 1 && S.tickN <= 3 && !z ? Math.exp(-Math.pow((tickAge - 0.10) / 0.06, 2)) : 0;
      // the build-up (the last 3 s: brighter, churning, the head bowing into it), then a short in-breath just before the
      // zero (the light pulled in, the eyes squeezed shut), so the zero lands as a clear hit; after it, a settle
      const build = z ? 0 : sstep(3.0, 0.35, remaining), inhale = z ? 0 : sstep(0.38, 0.06, remaining);
      const base = 0.04 + 0.36 * fill + 0.12 * rich, charge = z ? base + (1 - base) * sstep(0, 0.25, zAge) : base;
      const life = z ? 0.6 + 0.4 * sstep(0, 0.4, zAge) : 0.15 + 0.45 * fill + 0.25 * last + 0.15 * build;
      const slack = z ? 0 : (1 - 0.7 * fill) * (1 - last);
      const tight = z ? Math.exp(-zAge / 1.4) : Math.max(last * (0.75 + 0.25 * tickP), build);
      const churn = z ? 1.4 * Math.exp(-zAge / 0.9) : last * (0.7 + 0.3 * tickP) + 0.6 * build * (1 - inhale);
      const seam = z ? 0 : (0.04 + 0.30 * Math.pow(fill, 1.5) + 0.08 * rich + 0.25 * last * tickP + 0.15 * build) * (1 - 0.7 * inhale);
      const gem = 0.12 * fill + 0.2 * rich + S.gemK + 0.6 * tickP + 0.8 * build * (1 - inhale) + (z ? 2.0 * Math.exp(-zAge / 0.8) : 0);
      const blink = z ? 1 - sstep(0, 0.16, zAge) : 1 - 0.45 * flutter;
      // how lit the Mask itself is (its glitter, its gear, its cables): dark asleep, the fill and the chat light it, the zero: all of it
      // (the zero: all of it at once, the hit, then it settles a little)
      const lum = z ? 0.90 + 0.10 * Math.exp(-zAge / 0.5) : 0.16 + 0.40 * Math.pow(fill, 1.3) + 0.10 * rich + 0.12 * last + 0.06 * tickP * last + 0.12 * build - 0.30 * inhale;
      // the head: bowed asleep, it breathes; the fill lifts it a little; at the zero it comes up
      const breathe = Math.sin((T - t0) * 2 * Math.PI / 4.6), sway = Math.sin((T - t0) * 2 * Math.PI / 9.3);
      const restP = BOW + 0.07 * fill + 0.014 * breathe * (1 - 0.5 * last) - 0.045 * (z ? 1 : build) - 0.03 * (z ? 1 : inhale), lifted = restP + (LIFT - restP) * backOut(zAge / 0.7);
      const pitch = z ? lifted : restP, yaw = (z ? 0.3 : 1) * 0.035 * sway, roll = (z ? 0.3 : 1) * 0.02 * Math.sin((T - t0) * 2 * Math.PI / 7.1);
      const out = {
        fill, rich, charge: clamp01(charge), life: clamp01(life), slack: clamp01(slack), tight: clamp01(tight), churn: clamp(churn, 0, 2), seam: clamp01(seam),
        gem: clamp(gem, 0, 4), blink: clamp01(blink), lum: clamp01(lum), build: clamp01(build), inhale: clamp01(inhale), alive, flash: z ? Math.exp(-zAge / 0.35) : 0, last, pitch, yaw, roll, zero, zeroAge: zAge, done: z,
        tick, tickAge: Math.min(tickAge, 99), send, arrivals, taps: S.taps, gifts: S.gifts, pulses: S.pulses, queued: S.queue.length, remaining,
      };
      for (const k of Object.keys(out)) if (typeof out[k] === 'number' && !Number.isFinite(out[k])) out[k] = 0;
      return out;
    }
    return { tap, gift, step, startAt: t0, endAt: t1, state: S };
  }
  /**
   * The face the Mask wears while it sleeps: his resting face (the neutral, head space: eyes at 0, his eye distance = 1,
   * y up, z toward the camera) turned by the brain's pose and put where his real face usually sits in the camera picture.
   * Returned as tracker points (478 x, y, z exactly as MediaPipe gives them), so the Mask takes it like any frame.
   *   home = { cx, cy (the eyes' middle, camera pixels from the picture's centre, y up), iod (pixels), w, h }
   */
  function sleepFace(N, home, pose, out) {
    const n = Math.floor((N && N.length ? N.length : 0) / 3); if (n < 1) return null;
    const o = out && out.length >= n * 3 ? out : new Float32Array(n * 3);
    const W = home && home.w > 0 ? home.w : 1280, H = home && home.h > 0 ? home.h : 720;
    const cx = fin(home && home.cx, 0), cy = fin(home && home.cy, 0.02 * H), s = clamp(fin(home && home.iod, 0.11 * W), 4, 4 * W);
    const p = clamp(fin(pose && pose.pitch, 0), -1, 1), y = clamp(fin(pose && pose.yaw, 0), -1, 1), r = clamp(fin(pose && pose.roll, 0), -1, 1);
    // R = Ry(yaw) Rx(pitch) Rz(roll); pitch > 0 = the face looks up
    const cp = Math.cos(p), sp = Math.sin(p), cyw = Math.cos(y), syw = Math.sin(y), cr = Math.cos(r), sr = Math.sin(r);
    const X = [[1, 0, 0], [0, cp, sp], [0, -sp, cp]], Y = [[cyw, 0, syw], [0, 1, 0], [-syw, 0, cyw]], Z = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    const mul = (A, B) => A.map((row, i) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
    const R = mul(Y, mul(X, Z));
    for (let i = 0; i < n; i++) {
      const a = fin(N[i * 3], 0), b = fin(N[i * 3 + 1], 0), c = fin(N[i * 3 + 2], 0);
      const px = cx + s * (R[0][0] * a + R[0][1] * b + R[0][2] * c), py = cy + s * (R[1][0] * a + R[1][1] * b + R[1][2] * c), pz = s * (R[2][0] * a + R[2][1] * b + R[2][2] * c);
      o[i * 3] = px / W + 0.5; o[i * 3 + 1] = 0.5 - py / H; o[i * 3 + 2] = -pz / W;
    }
    return o;
  }
  /** where his real face sits in the camera picture (the eyes' middle and his eye distance), from one tracker frame */
  function faceHome(lm, w, h) {
    if (!lm || lm.length < 364 * 3 || !(w > 0) || !(h > 0)) return null;
    const P = (i) => [(lm[i * 3] - 0.5) * w, (0.5 - lm[i * 3 + 1]) * h, -lm[i * 3 + 2] * w];
    const a = P(33), b = P(133), c = P(263), d = P(362);
    const er = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], el = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2, (c[2] + d[2]) / 2];
    const iod = Math.hypot(el[0] - er[0], el[1] - er[1], el[2] - er[2]), cx = (er[0] + el[0]) / 2, cy = (er[1] + el[1]) / 2;
    return Number.isFinite(iod + cx + cy) && iod > 2 ? { cx, cy, iod, w, h } : null;
  }
  return { create, giftSize, sleepFace, faceHome, TAP_RUN, GIFT_RUN, STAGGER, PER_EVENT, QUEUE_MAX };
});
