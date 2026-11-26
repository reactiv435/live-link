// V7 SHUFFLE TO THE BEAT: the clock and the director. Pure UMD, no DOM (the avatar page runs it; the tests and
// tools/v7c-beat-measure.mjs run the same code on a decoded song).
//
// THE CLOCK hears what the Mask already hears: one result of mask/audio-features.js about 60 times a second
// ({ bass, mid, high, beat, kick, hit, level, bright }; `kick` is the strength on the one frame a kick starts). It never
// looks ahead. From the kicks of the last seconds it finds the beat (its length and where it falls), counts beats into
// bars of four and tells where a phrase starts:
//   * a song changes its sound on its phrase lines (every 4 or 8 bars). The clock notes, a bar late, every place where
//     the sound changed and stayed changed, and learns from them where this song's phrase lines fall; from then on it
//     counts to the NEXT line and says so on the beat itself, not after it;
//   * a drop (the bass was away, a strong kick brings it back) is bar 1 of a phrase at once;
//   * until the song has shown its phrases, bar 1 is the first kick once the music was fully there (a guess).
// While the music is silent the clock says so and counts nothing.
//
//   const clock = VTBeat.createClock();
//   const k = clock.push(f, tSeconds);
//   k = { locked, silent, bpm, conf, beat (true on the frame a beat falls), n (beats counted), inBar (0..3),
//         bar (bars since the last phrase start), boundary: null | 'bar' | 'drop', pulse (1 on the beat,
//         falling to 0 before the next), anchor: 'guess' | 'heard' }
//
// THE DIRECTOR turns the clock's bar lines into changes of the look, by the amount he picked (Calm / Normal / Wild):
//   const dir = VTBeat.createDirector({ amount: 'normal', seed: 1 });
//   const acts = dir.step(k, ctx);      // null, or [{ set: 'bg' | 'viz' | 'mode' | 'colour', value }]
//   ctx = { kind: 'mask' | 'hero', busy (a gift ordeal is playing), mode, home (the mode he chose himself), viz, bg,
//           colour, bgs: [...], vizs: [...], colours: [...] or null (he picked a colour: it is never shuffled) }
// Its rules: only on a bar line the clock calls a phrase line (or on a drop / new section); never while `busy`; never
// while silent or without a beat; a value is never chosen twice in a row, and not the one before the last either when
// there are three or more to choose from. While the song has not shown its phrase lines yet it makes one change on
// the first bar line (so he sees it works) and then waits for them.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTBeat = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const mod = (a, n) => ((a % n) + n) % n;
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  const CLOCK = {
    minP: 0.30, maxP: 1.0, stepP: 0.004,     // a beat lasts 0.30 .. 1.0 s (200 .. 60 a minute)
    homeP: 0.5, octaves: 0.9,                 // which of P, 2P, P/2 is "the beat": the one nearest 120 a minute
    window: 14, tau: 7,                        // kicks of the last 14 s count, the newest most
    every: 0.5,                                // the beat is measured again twice a second
    spread: 0,                                 // >1: that measuring cut into this many parts, one a push (a caller on its render thread); 0 = all at once
    minKicks: 6, lockScore: 0.42,
    silence: 0.06, silentAfter: 2.0,           // a level under this for 2 s = no music
    dropAway: 2.0, dropBeats: 5, dropKick: 0.6, dropConfirm: 0.35, // the bass away for this long, then a strong kick = the drop
    span: 4,                                   // "the sound changed here": the 4 beats after against the 4 before
    keep: 0.995,                               // how slowly the learned phrase lines are forgotten (per beat)
    sure: 1.7, minEvidence: 0.5,               // a phrase line is believed when it stands this clear of the others
  };

  function createClock(options) {
    const o = Object.assign({}, CLOCK, options || {});
    let last = null, kicks = [], silentFor = 9, locked = false, P = 0.5, beatT = 0, n = 0, origin = 0, anchor = 'guess', conf = 0;
    let estAt = -9, cand = 0, candN = 0, bassAway = 0, dropHold = 0, heardFor = 0, other = 0, otherN = 0;
    let maybe = null, dropT = 0, flip = 0, awayLen = 0, awayEnd = -9, rel = [0, 0, 0, 0, 0, 0, 0], relN = 0, relTop = 3;
    const RELS = [0.5, 2 / 3, 0.75, 1, 4 / 3, 1.5, 2];
    let acc = [0, 0, 0, 0, 0, 0], accN = 0, F = [], hist = new Float64Array(32), nov = [], want = -1, wantN = 0, lineConf = 0;

    let scan = null;                                       // (options.spread: the measuring in parts)
    function reset() { scan = null; kicks = []; locked = false; n = 0; origin = 0; anchor = 'guess'; conf = 0; cand = 0; candN = 0; bassAway = 0; heardFor = 0; maybe = null; flip = 0; rel = [0, 0, 0, 0, 0, 0, 0]; relN = 0; F = []; hist = new Float64Array(32); nov = []; acc = [0, 0, 0, 0, 0, 0]; accN = 0; want = -1; wantN = 0; lineConf = 0; }

    /** how well a beat of length p fits the kicks, and where it falls: [score 0..1, a beat time] */
    function fit(p, t, ks) {
      let re = 0, im = 0, sw = 0;
      for (const k of ks || kicks) { const w = k.w * Math.exp(-(t - k.t) / o.tau), a = 2 * Math.PI * k.t / p; re += w * Math.cos(a); im += w * Math.sin(a); sw += w; }
      if (sw <= 0) return [0, 0];
      return [Math.hypot(re, im) / sw, Math.atan2(im, re) / (2 * Math.PI) * p];
    }
    /** how good a beat of length p is: it fits the kicks, it still fits when halved (off-beat kicks fall on its half; the
     *  length of a dotted pattern does not), and it is not far from 120 a minute */
    const score = (p, t, ks) => (0.5 * fit(p, t, ks)[0] + 0.5 * fit(p / 2, t, ks)[0]) * Math.exp(-0.5 * Math.pow(Math.log2(p / o.homeP) / o.octaves, 2));
    function estimate(t) {
      if (kicks.length < o.minKicks) return null;
      let best = 0, bp = 0;
      for (let p = o.minP; p <= o.maxP + 1e-9; p += o.stepP) {
        const near = locked && Math.abs(Math.log2(p / P)) < 0.06 ? 1.25 : 1;
        const s = score(p, t) * near;
        if (s > best) { best = s; bp = p; }
      }
      if (!bp) return null;
      // a finer look round the best one
      let fb = 0, fp = bp;
      for (let p = bp - o.stepP; p <= bp + o.stepP + 1e-9; p += o.stepP / 8) { const s = fit(p, t)[0]; if (s > fb) { fb = s; fp = p; } }
      return { p: fp, score: best, r: fb, at: fit(fp, t)[1] };
    }
    /** the same measuring cut into o.spread parts, one a push: begun every o.every s on the kicks as they were then (and the
     *  beat then in use), its answer on the push the last part is done (null on the others) */
    function measure(t) {
      if (!scan) {
        if (t - estAt < o.every) return null;
        estAt = t;
        if (kicks.length < o.minKicks) return null;
        scan = { t, ks: kicks.slice(), p: o.minP, best: 0, bp: 0, lock: locked, P, per: Math.ceil(((o.maxP - o.minP) / o.stepP + 1) / o.spread) };
      }
      const q = scan;
      for (let i = 0; i < q.per && q.p <= o.maxP + 1e-9; i++, q.p += o.stepP) {
        const near = q.lock && Math.abs(Math.log2(q.p / q.P)) < 0.06 ? 1.25 : 1;
        const s = score(q.p, q.t, q.ks) * near;
        if (s > q.best) { q.best = s; q.bp = q.p; }
      }
      if (q.p <= o.maxP + 1e-9) return null;
      scan = null;
      if (!q.bp) return null;
      let fb = 0, fp = q.bp;
      for (let p = q.bp - o.stepP; p <= q.bp + o.stepP + 1e-9; p += o.stepP / 8) { const s = fit(p, q.t, q.ks)[0]; if (s > fb) { fb = s; fp = p; } }
      return { p: fp, score: q.best, r: fb, at: fit(fp, q.t, q.ks)[1] };
    }
    /** the beat number (as counted) nearest to a time */
    const beatAt = (time) => n + Math.round((time - beatT) / P);
    /** the phrase line the changes of the sound point at: [place in the count of beats (0..31 = an 8-bar line; -2 - place = only a 4-bar line is clear; -1 = nothing yet), how clear] */
    function learned() {
      let tot = 0; for (let i = 0; i < 32; i++) tot += hist[i];
      if (tot < o.minEvidence) return [-1, 0];
      // lines every 16 beats first (4 bars): both halves of the 32 count together, a neighbour counts half
      let best = -1, bv = 0, sum = 0;
      const h16 = (i) => hist[mod(i, 32)] + hist[mod(i + 16, 32)];
      for (let i = 0; i < 16; i++) { const v = h16(i) + 0.5 * (h16(i - 1) + h16(i + 1)); sum += v; if (v > bv) { bv = v; best = i; } }
      const clear = bv / Math.max(1e-9, sum / 16);
      // of the two 4-bar lines in 8 bars, the stronger one is the 8-bar line
      const a = hist[best] + 0.5 * (hist[mod(best - 1, 32)] + hist[mod(best + 1, 32)]), b = hist[best + 16] + 0.5 * (hist[mod(best + 15, 32)] + hist[mod(best + 17, 32)]);
      return [b > a * 1.15 ? best + 16 : a > b * 1.15 ? best : -2 - best, clear];
    }

    function push(f, t) {
      const dt = last === null ? 1 / 60 : clamp(t - last, 0, 0.25);
      last = t;
      const out = { locked: false, silent: false, bpm: 0, conf: 0, beat: false, n, inBar: 0, bar: 0, boundary: null, pulse: 0, anchor, lineConf: 0 };
      const level = Number(f && f.level) || 0, bass = Number(f && f.bass) || 0, kick = Number(f && f.kick) || 0;
      silentFor = level > o.silence ? 0 : silentFor + dt;
      if (silentFor > o.silentAfter) { if (locked || kicks.length) reset(); out.silent = true; return out; }
      heardFor += dt;
      while (kicks.length && t - kicks[0].t > o.window) kicks.shift();

      // ---- a drop: the bass was away, and a strong kick brings it back
      dropHold = Math.max(0, dropHold - dt);
      let drop = false;
      if (kick > 0) {
        // a strong kick after the bass was away MAY be the drop: it is one when the bass is really back a moment later
        // (a lone hit inside a break is not). Known within a third of a second; counted from the kick itself.
        // (the bass may be heard coming back a frame or two before the kick is: the stretch it was away still counts for a quarter second)
        const away = bassAway > 0 ? bassAway : t - awayEnd < 0.25 ? awayLen : 0;
        if (locked && dropHold <= 0 && heardFor > 4 && (kick >= o.dropKick || f.hit > 0) && away >= Math.max(o.dropAway, o.dropBeats * P)) maybe = { t, until: t + o.dropConfirm };
        kicks.push({ t, w: kick, full: level > 0.55 });
      }
      if (maybe) { if (bass > 0.6) { drop = true; dropT = maybe.t; maybe = null; } else if (t > maybe.until) maybe = null; }
      if (bass > 0.55 && bassAway > 0) { awayLen = bassAway; awayEnd = t; }
      bassAway = bass < 0.42 ? bassAway + dt : bass > 0.55 ? 0 : bassAway;

      // ---- the beat: measured again twice a second (options.spread: in parts, over that many pushes)
      if (o.spread > 1 || t - estAt >= o.every) {
        const e = o.spread > 1 ? measure(t) : (estAt = t, estimate(t));
        if (e) {
          if (!locked) {
            if (e.score >= o.lockScore && cand && Math.abs(e.p / cand - 1) < 0.04) candN++; else candN = e.score >= o.lockScore ? 1 : 0;
            cand = e.p;
            if (candN >= 2) {
              locked = true; P = e.p; conf = e.r;
              beatT = e.at + Math.floor((t - e.at) / P) * P; n = 0;
              // until the song has shown its phrases: bar 1 starts at the first kick heard once the music was fully there
              let first = kicks[0].t;
              for (const k of kicks) if (k.full) { first = k.t; break; }
              origin = beatAt(first); anchor = 'guess';
            }
          } else {
            conf += (e.r - conf) * 0.3;
            // THE SAME BEAT COUNTED ANOTHER WAY? A clock that began to listen in a syncopated stretch can lock on a
            // relative of the beat (three quarters of it, a dotted one, half, double). Each relative is scored on, slowly
            // (about six seconds); one that stays clearly better than the beat in use for four seconds takes over.
            let top = 3, topV = 0;
            for (let i = 0; i < RELS.length; i++) {
              const p = P * RELS[i], v = p >= o.minP && p <= o.maxP ? score(p, t) : 0;
              rel[i] += (v - rel[i]) * 0.08;
              if (rel[i] > topV) { topV = rel[i]; top = i; }
            }
            relN = top !== 3 && topV > 1.12 * rel[3] ? (relTop === top ? relN + 1 : 1) : 0; relTop = top;
            if (relN >= 8) {
              P *= RELS[top];
              const f2 = fit(P, t); beatT = f2[1] + Math.floor((t - f2[1]) / P) * P;
              rel = rel.map(() => 0); relN = 0; other = 0; otherN = 0; anchor = 'guess'; origin = n; hist = new Float64Array(32); F = []; nov = []; want = -1; wantN = 0;
              return finish(out, t, null);
            }
            if (Math.abs(e.p / P - 1) < 0.06) {
              P += (e.p - P) * 0.3; other = 0; otherN = 0;
              // where the kicks say the beat falls, against where it is counted. Off-beat kicks (a syncopated stretch)
              // must not pull the beat half a beat over: the kicks are read on the HALF beat, where both fall together,
              // and the nearer half is followed. Only when the kicks have sat on the other half for 16 s is it changed.
              const H = P / 2, half = fit(H, t)[1], err = mod(half - beatT + H / 2, H) - H / 2;
              beatT += 0.25 * err;
              const off = mod(e.at - beatT + P / 2, P) - P / 2;
              flip = Math.abs(off) > 0.35 * P && e.r > 0.5 ? flip + 1 : 0;
              if (flip >= 32) { beatT += H; flip = 0; }
            } else if (e.score > 0.5) {
              // another tempo fits better. A song keeps its tempo: a pattern that is the same beat counted another way
              // (half, double, dotted, triplets) never changes it, and anything else only after eight seconds in which
              // the old beat fits no more (the next song began without a silence).
              const ratio = e.p / P, same = [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2].some((r) => Math.abs(ratio / r - 1) < 0.05);
              if (!same && other && Math.abs(e.p / other - 1) < 0.04) otherN++; else otherN = same ? 0 : 1;
              other = e.p;
              if (otherN >= 16 && fit(P, t)[0] < 0.3) { P = e.p; beatT = e.at + Math.floor((t - e.at) / P) * P; other = 0; otherN = 0; anchor = 'guess'; hist = new Float64Array(32); F = []; nov = []; }
            }
          }
        }
      }
      if (!locked) return out;

      // ---- what this beat sounds like
      acc[0] += level; acc[1] += bass; acc[2] += Number(f.mid) || 0; acc[3] += Number(f.high) || 0; acc[4] += Number(f.bright) || 0; acc[5] += kick; accN++;

      // ---- count the beats
      let boundary = null;
      if (drop) {
        const b = beatAt(dropT), offLine = mod(b - origin + 8, 16) - 8;
        dropHold = Math.max(3, 8 * P);
        if (anchor === 'heard' && Math.abs(offLine) > 1) {
          // the song has already shown where its phrases start and this is not there (the bass coming back two bars
          // before a line is a fill, not the drop): nothing changes, the count stays; it is only noted
          hist[mod(b, 32)] += 0.5;
        } else {
          // the drop is bar 1, beat 1; the song's phrases are counted from it
          origin = b; anchor = 'heard'; want = -1; wantN = 0; hist[mod(b, 32)] += 2;
          boundary = 'drop';
        }
      }
      while (t >= beatT + P) {
        beatT += P; n++; out.beat = true;
        const k = Math.max(1, accN);
        F.push([acc[0] / k, acc[1] / k, acc[2] / k, acc[3] / k, acc[4] / k, Math.min(1, acc[5])]); if (F.length > 40) F.shift();
        acc = [0, 0, 0, 0, 0, 0]; accN = 0;
        // "the sound changed here": the bar after a beat line against the bar before it, known a bar late.
        // F's last entry is the beat that ended at count n; the line between the two halves is the beat counted n - S.
        const S = o.span;
        if (F.length >= 2 * S) {
          const m = F.length - S, d = [0, 0, 0, 0, 0, 0];
          for (let i = 0; i < S; i++) for (let j = 0; j < 6; j++) d[j] += (F[m + i][j] - F[m - 1 - i][j]) / S;
          // a phrase STARTS with something coming in (the bass, the drums, the highs): what comes in counts three times
          // what goes out (the break or the fill before a line takes things out a few beats early)
          const up = (x) => (x > 0 ? 1.5 * x : -0.5 * x);
          const v = 1.2 * up(d[0]) + up(d[1]) + 0.7 * up(d[2]) + 0.7 * up(d[3]) + 1.2 * Math.abs(d[4]) + 0.6 * up(d[5]);
          nov.push([n - S, v]); if (nov.length > 5) nov.shift();
          // only the place where the change is strongest counts (a change is seen for several beats round it)
          if (nov.length === 5 && nov[2][1] >= nov[0][1] && nov[2][1] >= nov[1][1] && nov[2][1] >= nov[3][1] && nov[2][1] >= nov[4][1] && nov[2][1] > 0.10) hist[mod(nov[2][0], 32)] += nov[2][1];
        }
        for (let i = 0; i < 32; i++) hist[i] *= o.keep;
        // every bar: do the changes of the sound point at phrase lines other than the ones being counted?
        if (n % 4 === 0 && dropHold <= 0) {
          const got = learned(), place = got[0];
          lineConf = got[1];
          if (place !== -1 && lineConf >= o.sure) {
            const eight = place >= 0, at = eight ? place : -2 - place;      // only a 4-bar line is clear: keep the half we are in
            const size = eight ? 32 : 16, cur = mod(origin, size), goal = mod(at, size);
            if (cur !== goal) {
              // lines that were already heard are only left for lines that are clearly stronger, and seen so for 4 bars
              const hv = (i) => hist[mod(i, 32)] + (eight ? 0 : hist[mod(i + 16, 32)]), ev = (i) => hv(i) + 0.5 * (hv(i - 1) + hv(i + 1));
              const better = anchor === 'guess' || ev(goal) > 1.4 * ev(cur);
              if (!better) { want = -1; wantN = 0; } else if (want === place) wantN++; else { want = place; wantN = 1; }
              if (better && wantN >= (anchor === 'guess' ? 2 : 4)) {
                let shift = mod(goal - cur, size); if (shift > size / 2) shift -= size;
                origin += shift; anchor = 'heard'; want = -1; wantN = 0;
              }
            } else { want = -1; wantN = 0; if (anchor === 'guess') anchor = 'heard'; }
          }
        }
        if (!boundary && mod(n - origin, 4) === 0) boundary = 'bar';
      }
      // the music has just stopped (half a second under the silence line): the beats are still counted on for the
      // two seconds until "silent", but no bar line or drop is called, so nothing changes after the last note
      return finish(out, t, silentFor > 0.5 ? null : boundary);
    }
    function finish(out, t, boundary) {
      const pos = n - origin;
      out.locked = true; out.bpm = 60 / P; out.conf = conf; out.n = n; out.inBar = mod(pos, 4); out.bar = Math.floor(pos / 4);
      out.boundary = boundary; out.anchor = anchor; out.lineConf = lineConf;
      out.pulse = clamp(1 - (t - beatT) / P, 0, 1);
      return out;
    }
    return { push, reset, get period() { return P; }, debug: () => ({ hist: Array.from(hist), origin, n }) };
  }

  // ------------------------------------------------------------------ the director
  // every: a phrase line every so many bars. count: how many things change on a phrase line [min, max].
  // flip: the chance that a phrase line also swaps Face <-> Visualizer (the Mask). stint: how many bars a swap away
  // from his own choice lasts before it comes home. gap: the fewest bars between two changes (a drop right after a
  // phrase line does not change everything twice).
  const AMOUNT = {
    calm: { every: 16, count: [1, 1], flip: 0, stint: 0, gap: 8, dropFlip: false },
    normal: { every: 8, count: [1, 2], flip: 0.25, stint: 8, gap: 4, dropFlip: true },
    wild: { every: 4, count: [2, 3], flip: 0.45, stint: 4, gap: 2, dropFlip: true },
  };
  function createDirector({ amount = 'normal', seed = 1 } = {}) {
    let A = AMOUNT[amount] || AMOUNT.normal, name = AMOUNT[amount] ? amount : 'normal';
    const rand = rng(seed);
    const before = {};                      // per thing: the value before the current one
    let lastBar = -99, barsRun = 0, awayFor = -1, pending = false, lastN = -99, changes = 0, turn = 0, hello = false, helloNow = false;
    const pick = (list, cur, key) => {
      const pool = list.filter((v) => v !== cur && (list.length < 3 || v !== before[key]));
      if (!pool.length) return null;
      return pool[Math.floor(rand() * pool.length) % pool.length];
    };
    function setAmount(a) { if (AMOUNT[a]) { A = AMOUNT[a]; name = a; } }
    function step(k, ctx) {
      if (!k || !k.locked || k.silent || !ctx) return null;
      if (!k.boundary) return null;
      barsRun++;                                             // every bar line (and a drop) counts, also while it waits
      if (awayFor >= 0) awayFor++;
      // The phrase lines are still a guess (the song has not shown them yet). ONE change is made on the first bar line
      // (he has just switched shuffle on, or a new song began: he sees at once that it works), then it waits until the
      // song has shown its lines, at most 32 bars.
      if (k.anchor === 'guess' && k.boundary !== 'drop') {
        if (hello || k.n < 8 || k.boundary !== 'bar') { if (k.n < 128) return null; }
        else { hello = true; helloNow = true; }
      } else if (k.n < 8) hello = false;
      const big = k.boundary === 'drop';
      const line = big || helloNow || mod(k.bar, A.every) === 0 || (pending && mod(k.bar, Math.min(4, A.every)) === 0);
      helloNow = false;
      if (!line) return null;
      if (ctx.busy) { pending = true; return null; }           // a gift is playing: the change waits for a later bar line
      if (barsRun - lastBar < A.gap) return null;
      pending = false; lastBar = barsRun; lastN = k.n;
      const acts = [];
      const put = (key, list, cur) => { const v = Array.isArray(list) && list.length > 1 ? pick(list, cur, key) : null; if (v === null) return false; before[key] = cur; acts.push({ set: key, value: v }); return true; };
      if (ctx.kind === 'hero') { put('bg', ctx.bgs, ctx.bg); }
      else {
        const home = ctx.home === 'visualizer' ? 'visualizer' : 'face', inViz = ctx.mode === 'visualizer';
        let flipped = false;
        // back home after a stint away; or away on a drop / by chance
        if (ctx.mode !== home && awayFor >= A.stint && A.stint) { acts.push({ set: 'mode', value: home }); awayFor = -1; flipped = true; }
        else if (ctx.mode === home && A.stint && ((big && A.dropFlip) || rand() < A.flip)) { acts.push({ set: 'mode', value: home === 'face' ? 'visualizer' : 'face' }); awayFor = 0; flipped = true; }
        const vizShows = flipped ? !inViz : inViz;
        // the things that can change now, in turn (so the same thing is not the only one that ever changes)
        const things = [];
        if (Array.isArray(ctx.bgs) && ctx.bgs.length > 1) things.push(['bg', ctx.bgs, ctx.bg]);
        if (Array.isArray(ctx.colours) && ctx.colours.length > 1) things.push(['colour', ctx.colours, ctx.colour]);
        if (vizShows && Array.isArray(ctx.vizs) && ctx.vizs.length > 1) things.push(['viz', ctx.vizs, ctx.viz]);
        const want = big ? things.length : Math.max(flipped ? A.count[0] - 1 : A.count[0], Math.min(things.length, A.count[0] + Math.floor(rand() * (A.count[1] - A.count[0] + 1)) - (flipped ? 1 : 0)));
        // going into the Visualizer always shows a new formation
        if (flipped && vizShows) { const i = things.findIndex((x) => x[0] === 'viz'); if (i >= 0) { put.apply(null, things[i]); things.splice(i, 1); } }
        for (let i = 0, done = 0; i < things.length && done < want; i++) { const th = things[(turn + i) % things.length]; if (put(th[0], th[1], th[2])) done++; }
        turn++;
      }
      if (!acts.length) return null;
      changes++;
      acts.big = big; acts.why = k.boundary;
      return acts;
    }
    return { step, setAmount, get amount() { return name; }, get changes() { return changes; } };
  }

  // the looks shuffle may choose from (allow-lists). The heroes: only the three painted places (never see-through, green
  // or black: those are choices for people who cut the character out themselves). The Mask's colours in Auto: the house.
  const HERO_BGS = ['preset:courtyard', 'preset:grove', 'preset:frostkeep'];
  const AUTO_COLOURS = ['auto', '#ffb224', '#efe6df', '#ff5a1f'];      // crimson home (Auto itself), gold, chrome, ember

  /** the clock and the director together, as the avatar page uses them: push(f, tSeconds, ctx) -> the changes to make now (or null) */
  function createShuffle({ amount = 'normal', seed = 1 } = {}) {
    const clock = createClock(), dir = createDirector({ amount, seed });
    let k = null;
    return {
      push(f, t, ctx) { k = clock.push(f, t); return dir.step(k, ctx); },
      /** what the clock said last ({ locked, bpm, beat, boundary, pulse ... }) or null */
      get beat() { return k; },
      get amount() { return dir.amount; }, get changes() { return dir.changes; },
      setAmount: dir.setAmount, reset() { clock.reset(); k = null; },
    };
  }
  return { createClock, createDirector, createShuffle, CLOCK, AMOUNT, HERO_BGS, AUTO_COLOURS, rng };
});
