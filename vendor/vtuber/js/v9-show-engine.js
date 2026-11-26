// V9 SHOW OPENING, the brain (V9-SHOW-OPEN.md). Pure UMD, no DOM, no clock of its own: the page (and the tests, and
// the render tool) pass the time in seconds. Two things:
//
// THE COUNTDOWN (the pre-show card)
//   const cd = VTShowOpen.createCountdown({ seconds: 600, startAt: t, queue: [...] });
//   cd.tap(count, t); cd.gift(coins, count, t);      viewers: they fill the IGNITION meter and make the card surge
//   const v = cd.step(t, beat);                      beat = { period, last, locked } (the beat clock's) or null
//   v = { remaining, text 'M:SS', big (the last 10 s), n (the number shown big), tickAge, done, doneAge, endAt,
//         meter 0..1, power 0..1, taps, gifts, surge, panel: { id, age, life } | null, queue }
//   THE START TIME NEVER MOVES BY TAPS OR GIFTS: endAt is startAt + seconds, whatever the meter says. (An option that
//   is OFF unless `shave: { on: true, max: 5 }` is passed lets a full meter take up to `max` seconds off.)
//   THE LAST 10 s LAND ON THE BEAT: each of the numbers 10 .. 0 appears on the beat nearest its own second when a beat
//   is within reach (0.22 s; the zero 0.35 s), else on the second itself. That is a shift of the PICTURE of at most
//   0.35 s; `endAt` itself is the time he set.
//
// THE TRANSFORM (real face <-> the Mask, the card -> his real face, one background -> the next)
//   const tf = VTShowOpen.createTransform();
//   tf.fire('toMask' | 'toReal' | 'cardToReal' | 'swap', t, { beat, power });   -> { t0, tI (the impact), tEnd }
//   tf.sample(t) -> null (nothing running: the page draws NOTHING of the show layer) or
//                   { kind, u (0..1 up to the impact), front (the scan line, 0 top .. 1 bottom, past 1 = gone),
//                     burn (the burning edge behind the line), reveal (0..1: what comes after is shown), impact (1 at
//                     the impact, dying), post (s since the impact), power, events: ['style' | 'impact' | 'done'] }
//   The impact is put on a beat when the music has one: the next BAR line if it comes in time, else the next beat;
//   without music it is a fixed time after the press.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTShowOpen = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };

  // The words on the card. Plain and short; nothing here states a price, a payout or a promise. Boosts / skips are
  // described only as what the words mean on the site (the owner checks this copy before a show).
  // The words on the card live in js/v9-show-copy.js (one block the owner can edit), loaded before this file.
  const COPY = (typeof module === 'object' && module && module.exports && typeof require === 'function') ? require('./v9-show-copy.js') : (typeof globalThis !== 'undefined' ? globalThis : self).VTShowCopy;
  const PANEL_SECONDS = 6.5;

  /** the beat nearest `t` from what the clock knows: { at, off } or null */
  function nearestBeat(t, beat) {
    if (!beat || !beat.locked || !(beat.period >= 0.25 && beat.period <= 1.2) || typeof beat.last !== 'number') return null;
    const k = Math.round((t - beat.last) / beat.period), at = beat.last + k * beat.period;
    return { at, off: at - t };
  }

  function cleanQueue(list) {
    const out = [];
    for (const q of Array.isArray(list) ? list : []) {
      if (!q || typeof q !== 'object') continue;
      const title = String(q.title || '').slice(0, 60).trim(); if (!title) continue;
      out.push({ title, artist: String(q.artist || '').slice(0, 40).trim(), cover: q.cover || null });
      if (out.length >= 4) break;
    }
    return out;
  }

  function createCountdown({ seconds = 600, startAt = 0, queue = [], shave = null, meterTarget = 300, carry = null } = {}) {
    const total = clamp(Number(seconds) || 0, 1, 6 * 3600);
    // carry: { taps, gifts, points } of the countdown this one replaces (pressed again, a new time): they go on from there
    const kept = (k) => (carry && Number.isFinite(Number(carry[k])) ? Math.max(0, Number(carry[k])) : 0);
    const S = { startAt, endAt0: startAt + total, taps: kept('taps'), gifts: kept('gifts'), points: kept('points'), surge: 0, lastT: startAt, ticks: new Array(11).fill(null), snapped: new Array(11).fill(0), queue: cleanQueue(queue), doneAt: null };
    const shaveOn = !!(shave && shave.on === true), shaveMax = shaveOn ? clamp(Number(shave.max) || 0, 0, 10) : 0;
    const meter = () => clamp(S.points / meterTarget, 0, 1);
    /** when the show starts. The time he set; only the (off by default) shave option moves it, by a full meter */
    const endAt = () => S.endAt0 - (shaveOn ? shaveMax * smooth(0.5, 1, meter()) : 0);
    function tap(count = 1, t) { const n = clamp(Math.round(Number(count) || 1), 1, 200); S.taps += n; S.points += n; S.surge = Math.min(1.6, S.surge + 0.05 + 0.02 * Math.min(n, 20)); if (t !== undefined) S.lastHit = t; }
    function gift(coins = 1, count = 1, t) { const n = clamp(Math.round(Number(count) || 1), 1, 200), c = clamp(Number(coins) || 1, 1, 1e6); S.gifts += n; S.points += n * Math.min(90, 6 + 4 * Math.sqrt(c)); S.surge = Math.min(1.6, S.surge + 0.5 + 0.1 * Math.log10(c + 1)); if (t !== undefined) { S.lastHit = t; S.lastGift = t; } }
    function panels() { const p = []; if (S.queue.length) p.push('queue'); p.push('boosts', 'engage'); return p; }
    function step(t, beat) {
      const dt = clamp(t - S.lastT, 0, 0.5); S.lastT = t;
      S.surge *= Math.exp(-dt / 0.45);
      const end = endAt();
      // the last ten numbers: each is fixed (once) to the beat nearest its second, a little before it is due
      for (let n = 10; n >= 0; n--) {
        if (S.ticks[n] !== null) continue;
        const nominal = end - n; if (t < nominal - 0.6) break;
        let at = nominal; const b = nearestBeat(nominal, beat), tol = n === 0 ? 0.35 : 0.22;
        if (b && Math.abs(b.off) <= tol) at = b.at;
        if (n < 10 && S.ticks[n + 1] !== null) at = Math.max(at, S.ticks[n + 1] + 0.45);     // never two numbers at once, never out of order
        S.ticks[n] = at; S.snapped[n] = at - nominal;
      }
      let shown = null;
      for (let n = 0; n <= 10; n++) if (S.ticks[n] !== null && t >= S.ticks[n]) { shown = n; break; }
      const done = shown === 0;
      if (done && S.doneAt === null) S.doneAt = S.ticks[0];
      const remaining = Math.max(0, end - t), whole = Math.ceil(remaining - 1e-6);
      const list = panels(), life = t - S.startAt, idx = Math.floor(life / PANEL_SECONDS) % list.length;
      const big = shown !== null;
      return {
        remaining, text: Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0'), big, n: shown, tickAge: big ? t - S.ticks[shown] : 0,
        done, doneAge: done ? t - S.doneAt : 0, endAt: end, landed: big ? S.snapped[shown] : 0,
        meter: meter(), power: meter(), taps: S.taps, gifts: S.gifts, surge: S.surge, sinceHit: S.lastHit === undefined ? 99 : t - S.lastHit, sinceGift: S.lastGift === undefined ? 99 : t - S.lastGift,
        panel: !done ? { id: list[idx], age: life % PANEL_SECONDS, life: PANEL_SECONDS } : null, queue: S.queue,
      };
    }
    return { tap, gift, step, setQueue: (q) => { S.queue = cleanQueue(q); }, get endAt() { return endAt(); }, get endAtSet() { return S.endAt0; }, get meter() { return meter(); }, state: S };
  }

  // ---------------------------------------------------------------- the transform
  // lead = the time from the press to the impact when there is no beat; tail = how long the impact rings out
  const KINDS = { toMask: { lead: 2.5, tail: 1.3, sweep: 0.70 }, toReal: { lead: 2.1, tail: 0.9, sweep: 0.80 }, cardToReal: { lead: 1.5, tail: 0.25, sweep: 0.85 }, swap: { lead: 1.1, tail: 0.5, sweep: 0.9 } };

  /** when the impact falls: the next bar line when it is in reach, else the next beat, else `lead` after the press */
  function landing(t, lead, beat) {
    const b = nearestBeat(t + lead, beat); if (!b) return { at: t + lead, on: 'time' };
    const P = beat.period, first = beat.last + Math.ceil((t + lead - 0.2 - beat.last) / P - 1e-9) * P;       // the first beat not earlier than lead - 0.2 s
    if (typeof beat.inBar === 'number') {
      // beat.inBar = the place in the bar (0..3) of the beat at beat.last: the next bar lines are known
      for (let k = 0; k < 8; k++) { const at = first + k * P, n = Math.round((at - beat.last) / P); if (((beat.inBar + n) % 4 + 4) % 4 === 0) { if (at - (t + lead) <= 1.3) return { at, on: 'bar' }; break; } }
    }
    return { at: first, on: 'beat' };
  }

  function createTransform() {
    let T = null;
    function fire(kind, t, { beat = null, power = 0, lead = null } = {}) {
      const K = KINDS[kind]; if (!K) return null;
      if (T && t < T.tEnd) return null;                       // one at a time: a second press while one runs is not taken
      const L = landing(t, lead === null ? K.lead : lead, beat);
      T = { kind, t0: t, tI: L.at, on: L.on, tEnd: L.at + K.tail, power: clamp(Number(power) || 0, 0, 1), sweep: K.sweep, sent: {} };
      return { t0: T.t0, tI: T.tI, tEnd: T.tEnd, on: T.on };
    }
    function sample(t) {
      if (!T) return null;
      const span = T.tI - T.t0, u = clamp((t - T.t0) / span, 0, 1), post = t - T.tI, events = [];
      const once = (name, when) => { if (!T.sent[name] && t >= when) { T.sent[name] = true; events.push(name); } };
      if (T.kind === 'toMask') once('style', T.tI - 1.45);
      once('impact', T.tI); once('done', T.tEnd);
      // the scan line: eased, top to bottom, gone a little before the impact
      const s = clamp(u / T.sweep, 0, 1.25), front = -0.06 + 1.2 * (s < 1 ? s * s * (3 - 2 * s) * 0.55 + s * 0.45 : 1 + (s - 1) * 0.6);
      const out = {
        kind: T.kind, u, post, front, power: T.power, on: T.on, t0: T.t0, tI: T.tI,
        reveal: T.kind === 'toMask' ? smooth(-1.0, -0.12, post) : 1,
        impact: post >= 0 ? Math.exp(-post / 0.28) : 0, charge: T.kind === 'toMask' ? smooth(0.55, 1, u) * (post < 0 ? 1 : 0) : 0,
        events,
      };
      if (t >= T.tEnd) T = null;
      return out;
    }
    return { fire, sample, get running() { return !!T; }, cancel() { T = null; } };
  }

  return { COPY, KINDS, PANEL_SECONDS, createCountdown, createTransform, nearestBeat, landing, cleanQueue };
});
