// Tracker v2 scheduling logic. Pure UMD (no DOM): used by the hub worker and by the Node tests.
//   VTSched.Dispatcher  newest-frame-only hand-over from one frame source to workers that take one frame at a time
//   VTSched.LoadLadder  the load-shedding ladder (research/tracking-tech.md 4.4)
//   VTSched.DriftWatch  the slow-leak watchdog (8.1): tells when a model's time has crept up and the task should be rebuilt
//   VTSched.cappedRate  frames a second that get past a rate cap (the Dispatcher's rule, for the ladder's goals)
//   VTSched.ClockMap    frame timestamps (their own clock) -> capture time on this PC's clock
//   VTSched.Rate, VTSched.Window  small rate / percentile helpers
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VTSched = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Newest frame only, never a queue.
   * Workers are put in GROUPS (a group of one is the normal case). Every group has one slot. A frame offered while
   * any worker of the group is busy waits in the slot; a newer frame REPLACES it (the old one is closed and counted
   * as dropped). The moment the whole group is free again it gets the slot's frame: every worker of a group always
   * works on the SAME frame (the pose worker and the hand worker, whose results are joined).
   *   new Dispatcher({ send(id, frame, info, waitedMs), clone(frame), close(frame), now() })
   *   add(id, { group: id, every: 1, minGapMs: 0, enabled: true })     // policy is per group (the first add sets it)
   *   offer(frame, info)   // takes ownership of `frame`
   *   ready(id)            // that worker finished its frame
   */
  class Dispatcher {
    constructor({ send, clone, close, now }) {
      this.send = send;
      this.clone = clone || ((f) => f);
      this.close = close || (() => {});
      this.now = now || (() => Date.now());
      this.groups = new Map();
      this.where = new Map();      // worker id -> group
      this.offered = 0;
    }
    add(id, policy = {}) {
      const name = policy.group || id;
      let g = this.groups.get(name);
      if (!g) {
        g = { name, members: new Map(), pending: null, pendingInfo: null, count: 0, lastCap: -1e15, busySince: 0, every: 1, minGapMs: 0, enabled: true, sent: 0, dropped: 0, skipped: 0, waitMs: 0 };
        this.groups.set(name, g);
        this.policy(name, { every: policy.every, minGapMs: policy.minGapMs, enabled: policy.enabled });
      }
      g.members.set(id, { idle: true, on: true });
      this.where.set(id, g);
    }
    /** Remove a worker from its group (the group goes too when it was the last one). */
    remove(id) {
      const g = this.where.get(id);
      if (!g) return;
      g.members.delete(id); this.where.delete(id);
      if (!g.members.size) { if (g.pending) this.close(g.pending); this.groups.delete(g.name); }
      else this._flush(g);
    }
    _group(key) { return this.groups.get(key) || this.where.get(key); }
    /** key: a group name or the id of one of its workers */
    policy(key, patch) {
      const g = this._group(key);
      if (!g) return;
      if (patch.every !== undefined) g.every = Math.max(1, patch.every | 0 || 1);
      if (patch.minGapMs !== undefined) g.minGapMs = Math.max(0, patch.minGapMs || 0);
      if (patch.enabled !== undefined) {
        g.enabled = !!patch.enabled;
        if (!g.enabled && g.pending) { this.close(g.pending); g.pending = null; g.pendingInfo = null; }
      }
    }
    _free(g) { for (const m of g.members.values()) if (!m.idle) return false; return g.members.size > 0; }
    _send(g, frame, info) {
      const t = this.now();
      g.busySince = t; g.sent++;
      const wait = Math.max(0, t - (info && info.arrive !== undefined ? info.arrive : t));
      g.waitMs += (wait - g.waitMs) * 0.1;
      const ids = Array.from(g.members.keys());
      for (let i = 0; i < ids.length; i++) {
        g.members.get(ids[i]).idle = false;
        this.send(ids[i], i === ids.length - 1 ? frame : this.clone(frame), info, wait);
      }
    }
    _flush(g) {
      if (g.pending && g.enabled && this._free(g)) {
        const f = g.pending, i = g.pendingInfo;
        g.pending = null; g.pendingInfo = null;
        this._send(g, f, i);
      }
    }
    offer(frame, info) {
      this.offered++;
      const t = this.now();
      if (info && info.at !== undefined && this.lastAt !== undefined && info.at < this.lastAt - 500) for (const g of this.groups.values()) g.lastCap = -1e15;   // the source restarted
      if (info && info.at !== undefined) this.lastAt = info.at;
      for (const g of this.groups.values()) {
        if (!g.enabled || !g.members.size) continue;
        g.count++;
        if (g.every > 1 && (g.count % g.every) !== 0) { g.skipped++; continue; }
        // rate cap: a frame taken too soon after the last one accepted is skipped. Judged on the frames' CAPTURE times
        // rather than on when they arrive. The limit is 60 % of the gap: a source running AT the cap (30 a second
        // into a cap of 30, with its timestamps a few ms uneven) loses nothing, a source at twice the cap loses every
        // second frame.
        const cap = info && info.at !== undefined ? info.at : t;
        if (g.minGapMs > 0 && cap - g.lastCap < g.minGapMs * 0.6) { g.skipped++; continue; }
        g.lastCap = cap;
        const copy = this.clone(frame);
        if (this._free(g)) this._send(g, copy, info);
        else {
          if (g.pending) { this.close(g.pending); g.dropped++; }
          g.pending = copy; g.pendingInfo = info;
        }
      }
      this.close(frame);
    }
    ready(id) {
      const g = this.where.get(id);
      if (!g) return;
      g.members.get(id).idle = true;
      this._flush(g);
    }
    /** A worker was restarted or died: forget what it was doing. */
    reset(id) {
      const g = this.where.get(id);
      if (!g) return;
      g.members.get(id).idle = true;
      this._flush(g);
    }
    /** ms that worker has been busy with its current frame (0 when idle): the stall watchdog reads this. */
    busyFor(id) { const g = this.where.get(id); return g && !g.members.get(id).idle ? this.now() - g.busySince : 0; }
    stats(key) { const g = this._group(key); return g ? { sent: g.sent, dropped: g.dropped, skipped: g.skipped, waitMs: g.waitMs, idle: this._free(g) } : { sent: 0, dropped: 0, skipped: 0, waitMs: 0, idle: true }; }
    clear() { for (const g of this.groups.values()) { if (g.pending) { this.close(g.pending); g.pending = null; g.pendingInfo = null; } for (const m of g.members.values()) m.idle = true; } }
  }

  /**
   * Load shedding for body + hands; the face is never shed. Call update() once a second with the measured rates.
   * The steps come from the research report (tracking-tech.md 4.4), tried in the order that costs the least quality on
   * this PC (measured): (1) hands only when a hand was seen in the last second or a wrist is in view, (2) pose model
   * full -> lite, (3) body + hands on every second frame.
   *   - The report's fourth step, pose input at half size, is NOT in the ladder: measured here, the picture size
   *     makes no difference to the model times (the worker still understands the flag, for a PC where it does).
   *   - Step 3 only helps the FACE (it frees the graphics card), so it is used only when the face is behind.
   *   - Every step is a trial: if the rate it was meant to help has not risen by `minGain` after `judgeAfter` seconds
   *     it is taken back and left alone for `blockFor` seconds, twice as long after every further failure (up to an
   *     hour). Quality is never given up for nothing, and a PC that is simply busy is not poked every few minutes.
   *   - When everything has been fine for `downAfter` seconds the newest step is taken back.
   */
  /**
   * How many frames a second get past a rate cap of `cap` when `fps` come in, by the Dispatcher's rule (a frame is
   * skipped when it follows the last accepted one by less than 60 % of the cap's gap): 30 into a cap of 15 -> 15,
   * 26 into 15 -> 13, 30 into 30 -> 30. No cap (0, undefined, Infinity) -> fps.
   */
  function cappedRate(fps, cap) {
    if (!(cap > 0) || !Number.isFinite(cap) || !(fps > 0)) return fps;
    return fps / Math.max(1, Math.ceil(0.6 * fps / cap - 1e-9));
  }

  const STEPS = ['gate', 'lite', 'half'];
  const STEP_TEXT = { lite: 'lighter pose model', half: 'body + hands on every 2nd frame', small: 'pose at half size', gate: 'hands only when in view' };
  class LoadLadder {
    constructor(o = {}) {
      this.o = { faceTarget: 30, bodyTarget: 24, margin: 0.88, upAfter: 3, downAfter: 20, maxDownAfter: 600, judgeAfter: 8, minGain: 0.12, blockFor: 300, maxBlockFor: 3600, ...o };
      this.flags = { lite: false, half: false, small: false, gate: false };
      this.order = [];          // the flags that are set, oldest first
      this.blocked = {};        // step -> the time until which it is not tried again
      this.failed = {};         // step -> how often it did not help
      this.trial = null;        // { step, t, metric: 'face' | 'body', before }
      this.bad = 0; this.good = 0;
      this.downAfter = this.o.downAfter;
      this.lastDownAt = -1e9; this.t = 0;
      this.reason = '';
    }
    get level() { return this.order.length; }
    describe() { return this.order.length ? this.order.map((k) => STEP_TEXT[k]).join(', ') : 'none'; }
    _unset(k) { this.flags[k] = false; this.order = this.order.filter((x) => x !== k); }
    /**
     * m: { inFps, faceFps, bodyFps, bodyOn, faceMax, bodyMax } -> true when the flags changed.
     * inFps = the pictures coming in; faceMax / bodyMax = the caps set on the page ("Face checks / second", "Body checks
     * / second"; left out = no cap). The goals are what each side can GET under its cap (cappedRate, the Dispatcher's
     * own rule), so a body that runs exactly at "Up to 15" is never called behind.
     */
    update(m) {
      this.t++;
      const o = this.o;
      const inFace = cappedRate(m.inFps, m.faceMax);
      if (!(inFace >= 8)) { this.bad = 0; this.good = 0; return false; }       // no steady picture: nothing to judge
      const faceGoal = Math.min(inFace, o.faceTarget) * o.margin;
      const bodyIn = cappedRate(this.flags.half ? m.inFps / 2 : m.inFps, m.bodyMax);
      const bodyGoal = Math.min(bodyIn, o.bodyTarget) * o.margin;
      const faceBad = m.faceFps < faceGoal;
      const bodyBad = !!m.bodyOn && m.bodyFps < bodyGoal;
      // did the last step help?
      if (this.trial && this.t - this.trial.t >= o.judgeAfter) {
        const tr = this.trial;
        this.trial = null;
        const now = tr.metric === 'face' ? m.faceFps : m.bodyFps;
        if (this.flags[tr.step] && now >= tr.before * (1 + o.minGain)) this.failed[tr.step] = 0;
        if (this.flags[tr.step] && now < tr.before * (1 + o.minGain)) {
          this._unset(tr.step);
          this.failed[tr.step] = (this.failed[tr.step] || 0) + 1;
          this.blocked[tr.step] = this.t + Math.min(o.maxBlockFor, o.blockFor * 2 ** (this.failed[tr.step] - 1));
          this.bad = 0; this.good = 0;
          this.reason = STEP_TEXT[tr.step] + ' did not help: taken back';
          return true;
        }
      }
      if (faceBad || bodyBad) { this.bad++; this.good = 0; } else { this.good++; this.bad = 0; }
      if (this.bad >= o.upAfter && !this.trial) {
        this.bad = 0;
        if (!m.bodyOn) return false;                                           // nothing left to shed
        const next = STEPS.find((k) => !this.flags[k] && !(this.blocked[k] > this.t) && (k !== 'half' || faceBad));
        if (!next) return false;
        this.flags[next] = true; this.order.push(next);
        this.trial = { step: next, t: this.t, metric: faceBad ? 'face' : 'body', before: faceBad ? m.faceFps : m.bodyFps };
        this.reason = (faceBad ? 'face ' + m.faceFps.toFixed(0) + '/s under ' + faceGoal.toFixed(0) : 'body ' + m.bodyFps.toFixed(0) + '/s under ' + bodyGoal.toFixed(0));
        // shed again soon after giving something back: wait longer before the next try
        if (this.t - this.lastDownAt < 60) this.downAfter = Math.min(o.maxDownAfter, this.downAfter * 2);
        return true;
      }
      if (this.good >= this.downAfter && this.order.length) {
        this.good = 0;
        this._unset(this.order[this.order.length - 1]);
        this.lastDownAt = this.t;
        this.reason = 'spare capacity';
        return true;
      }
      return false;
    }
  }

  /**
   * Slow-leak watchdog. add(ms, now, found) for every inference; check(now) returns true when the task should be
   * rebuilt. It must never rebuild a healthy model, so it only believes a CREEP:
   *   - Only frames in which the model found something count (an empty picture is quicker and says nothing), and a
   *     minute needs `minSamples` of them; other minutes are skipped.
   *   - The reference is the median of the first `minHist` such minutes. After that a LOWER level is always believed
   *     (the median of the last five minutes, so one odd minute changes nothing), and a JUMP is believed too: when the
   *     last three minutes sit `step` times above the three before them, that is the PC's load changing (the avatar
   *     page opened, the show started, a break ended), not a leak, and the reference moves up to the new level.
   *   - What is left is a level that crept up slowly: `ratio` times the reference for `persist` minutes in a row, with
   *     the cool-down over, means rebuild.
   *   - If the rebuild did not help (the first minute after it stays within 20 % of the level before) the higher
   *     level becomes the reference and the cool-down doubles (up to `maxCooldownMs`): a PC that is simply busier is
   *     not poked again and again.
   * reset(now) forgets what was learned (a different model, a different delegate).
   */
  class DriftWatch {
    constructor(o = {}) {
      this.o = { ratio: 1.5, persist: 5, step: 1.25, minHist: 5, bucketMs: 60000, cooldownMs: 600000, maxCooldownMs: 7200000, minSamples: 200, warmupMs: 15000, ...o };
      this.rebuilds = 0; this.lastRebuildAt = -1e12; this.cooldown = this.o.cooldownMs;
      this.reset(0);
    }
    reset(now) { this.ref = null; this.cur = []; this.hist = []; this.bucketStart = now; this.startedAt = now; this.lastMedian = null; this.before = null; this.high = 0; }
    static median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }
    add(ms, now, found = true) {
      if (now - this.startedAt < this.o.warmupMs) { this.bucketStart = now; return; }
      if (found) this.cur.push(ms);
      if (now - this.bucketStart < this.o.bucketMs) return;
      const med = this.cur.length >= this.o.minSamples ? DriftWatch.median(this.cur) : null;
      this.cur = []; this.bucketStart = now;
      if (med !== null) this._minute(med);
    }
    _minute(med) {
      const o = this.o, h = this.hist, M = DriftWatch.median;
      this.lastMedian = med;
      h.push(med); if (h.length > 12) h.shift();
      if (this.before !== null) {                        // the first full minute after a rebuild: did it help?
        if (med > this.before * 0.8) { this.ref = Math.max(med, this.ref || 0); this.cooldown = Math.min(o.maxCooldownMs, this.cooldown * 2); }
        else { this.ref = med; this.cooldown = o.cooldownMs; }
        this.before = null; this.high = 0;
        return;
      }
      if (this.ref === null) { if (h.length >= o.minHist) this.ref = M(h); return; }
      if (h.length >= 5) { const low = M(h.slice(-5)); if (low < this.ref) this.ref = low; }
      if (h.length >= 4) {                                // a jump = load, not a leak
        const now3 = M(h.slice(-3)), was = M(h.slice(-6, -3));
        if (now3 >= was * o.step && now3 > this.ref) this.ref = now3;
      }
      this.high = med > this.ref * o.ratio ? this.high + 1 : 0;
    }
    check(now) {
      if (this.ref === null || this.lastMedian === null || this.before !== null) return false;
      if (now - this.lastRebuildAt < this.cooldown) return false;
      return this.high >= this.o.persist;
    }
    /** Call when the task was rebuilt because check() said so. */
    rebuilt(now) { this.before = this.lastMedian; this.lastRebuildAt = now; this.rebuilds++; this.cur = []; this.hist = []; this.bucketStart = now; this.startedAt = now; this.lastMedian = null; this.high = 0; }
  }

  /**
   * A frame's own timestamp (monotonic, unknown origin) -> the time it was captured, on this PC's clock.
   * Every frame arrives some time after it was captured, and that time jitters (the reader was busy, a thread hop).
   * The smallest (arrival - timestamp) seen in the last ~10 s is the fixed part; adding it to the timestamp gives a
   * capture time that does not jitter with how busy the tracker was.
   */
  class ClockMap {
    constructor(windowMs = 5000) { this.windowMs = windowMs; this.reset(); }
    reset() { this.a = Infinity; this.b = Infinity; this.aStart = null; this.lastTs = null; }
    /** tsMs: the frame's timestamp in ms; arriveMs: epoch ms when the reader got it. Returns the capture time (epoch ms). */
    map(tsMs, arriveMs) {
      if (this.lastTs !== null && (tsMs < this.lastTs - 1 || tsMs - this.lastTs > 2000)) this.reset();   // new stream or a jump
      this.lastTs = tsMs;
      const d = arriveMs - tsMs;
      if (this.aStart === null) this.aStart = arriveMs;
      if (arriveMs - this.aStart > this.windowMs) { this.b = this.a; this.a = Infinity; this.aStart = arriveMs; }
      if (d < this.a) this.a = d;
      return tsMs + Math.min(this.a, this.b);
    }
  }

  /** Events per second over the last `spanMs`. */
  class Rate {
    constructor(spanMs = 2000) { this.spanMs = spanMs; this.t = []; }
    hit(now) { this.t.push(now); if (this.t.length > 4096) this.trim(now); }
    trim(now) { let i = 0; while (i < this.t.length && now - this.t[i] > this.spanMs) i++; if (i) this.t.splice(0, i); }
    get(now) { this.trim(now); return this.t.length / (this.spanMs / 1000); }
  }

  /** The last `n` samples: median and 95th percentile. */
  class Window {
    constructor(n = 600) { this.n = n; this.a = []; }
    add(v) { this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
    q(p) { if (!this.a.length) return 0; const s = this.a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
    get median() { return this.q(0.5); }
    get p95() { return this.q(0.95); }
    get mean() { return this.a.length ? this.a.reduce((x, y) => x + y, 0) / this.a.length : 0; }
  }

  return { Dispatcher, LoadLadder, DriftWatch, ClockMap, Rate, Window, STEPS, STEP_TEXT, cappedRate };
});
