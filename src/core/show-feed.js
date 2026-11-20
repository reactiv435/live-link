'use strict';
// V8 (the puppet show): the "show state" for the VTuber on this computer. The Mask changes with the hype rank of the
// song on air, "eats" the song's cover, spits the host's grade out as fire or goo, and may start a boss fight only
// between songs. Contract: the VTuber repo's V8-PHASE2.md, C3:
//   { v: 2, type: 'show', onAir, song: { id, title, cover } | null, hype: { taps, rank, label, mythic }, score, at }
//   sent on every change and at least every 5 s while a TikTok LIVE is connected.
//
// Where each part comes from:
//  * The song on air: the site's own answer to LIVE Link's push / config (`target` = { submission_id, title } or null;
//    controller.js). Nothing is read from the site without a song on air (except two looks for a late grade, below).
//  * Hype: two public tables, read with the site's publishable key (the same key the site's own pages use; RLS lets
//    anyone read them): project_hype.hype_bar (the song's bar) and the song's newest hype_plays row (start_bar,
//    ended_at). This play's taps = max(0, hype_bar - start_bar), as the site's src/hooks/useProjectHype.ts does it.
//  * The rank shown: the site's /live/now overlay lets its bar climb about one rank per 15 s (RANKS_PER_SECOND). The
//    same limit is applied here, and this file only learns of taps 0-3 s after the overlay does, so the Mask's rank
//    never runs ahead of the bar on the stream.
//  * The cover: submissions_public.album_artwork_url, else the first picture in attachment_urls: the overlay's own
//    rule (src/pages/NowLivePopout.tsx). Only a cover on the site's storage host is passed on; a YouTube or Suno
//    thumbnail (the overlay's last resort) is not, so that song has no cover here (null: the Mask keeps its colours).
//  * The grade: ranking_board.host_grade, the verdict the host gives in the live studio's review panel: one of
//    fire / gem / solid / promising (not a letter). Only a verdict given DURING this play counts (reviewed_at at or
//    after the play began): an old verdict from an earlier review must not come out of the Mask's mouth at the
//    song's start. GRADE_SCORE below maps it to 0-100 for mask.score(n).
//
// Gentle on the site: one small read every 2.5 s while a song is on air AND a VTuber that speaks v2 is listening;
// nothing otherwise. Any failed read doubles the wait (5 s, 10 s, 20 s, 30 s at most; a 429's Retry-After is honoured);
// the first good read puts it back. Electron-free.
const { cleanPictureUrl } = require('./pictures');

// ---------------------------------------------------------------- the site's hype ranks
// Copied from the site: src/lib/hypeTiers.ts (HYPE_TIERS, MYTHIC_MIN, MYTHIC_STEP, FILL_STOPS, rankPosition,
// tapsAtRankPosition, RANKS_PER_SECOND), read Nov 20, 2026. If the site changes its numbers, change them here.
const MYTHIC_MIN = 8000;
const MYTHIC_STEP = 8000;
const HYPE_TIERS = Object.freeze([
  { min: 0, label: 'Tap to hype it up' },
  { min: 1, label: 'Warming Up' },
  { min: 300, label: 'Heating Up' },
  { min: 900, label: 'ON FIRE' },
  { min: 1800, label: 'WILDFIRE' },
  { min: 3600, label: 'LEGENDARY' },
  { min: MYTHIC_MIN, label: 'MYTHIC' },
]);
const RANK_STOPS = [0, 300, 900, 1800, 3600, MYTHIC_MIN];   // the taps at rank positions 0, 1, 2, 3, 4, 5
const RANKS_PER_SECOND = 1 / 15;

/** 0 = Tap to hype .. 6 = MYTHIC */
function tierIndex(taps) { let i = 0; for (let k = 0; k < HYPE_TIERS.length; k++) if (taps >= HYPE_TIERS[k].min) i = k; return i; }
/** the site's getMythicMultiplier: 0 below MYTHIC; 1 at 8,000; 2 at 16,000; 3 at 24,000 ... */
function mythicMultiplier(taps) { return taps < MYTHIC_MIN ? 0 : 1 + Math.floor((taps - MYTHIC_MIN) / MYTHIC_STEP); }
/** the site's rankPosition: 0 at 0 taps, 1 at Heating Up, 2 at ON FIRE ... 5 at MYTHIC, +1 per further 8,000 */
function rankPosition(taps) {
  if (!(taps > 0)) return 0;
  if (taps >= MYTHIC_MIN) return 5 + (taps - MYTHIC_MIN) / MYTHIC_STEP;
  for (let i = 1; i < RANK_STOPS.length; i++) if (taps < RANK_STOPS[i]) return i - 1 + (taps - RANK_STOPS[i - 1]) / (RANK_STOPS[i] - RANK_STOPS[i - 1]);
  return 5;
}
/** the inverse of rankPosition */
function tapsAtRankPosition(pos) {
  if (!(pos > 0)) return 0;
  if (pos >= 5) return MYTHIC_MIN + (pos - 5) * MYTHIC_STEP;
  const i = Math.floor(pos);
  return RANK_STOPS[i] + (pos - i) * (RANK_STOPS[i + 1] - RANK_STOPS[i]);
}
const CLIMB_STEP_S = 0.1;      // the site's own step (its setInterval of 100 ms)
/** one step of the site's "visible climb" (useProjectHype.ts), with its arithmetic: whole taps, rounded down */
function climbStep(shown, real, dt) {
  if (shown >= real) return real;
  const target = rankPosition(real);
  const next = Math.min(target, rankPosition(shown) + RANKS_PER_SECOND * dt);
  if (next >= target) return real;
  return Math.min(real, Math.max(shown, Math.floor(tapsAtRankPosition(next))));
}
/**
 * The site's "visible climb": the shown taps rise toward the real taps by at most RANKS_PER_SECOND rank positions a
 * second; a lower real value is taken at once. Walked in the site's own 100 ms steps, so the rounding (which makes the
 * overlay a little slower than 15 s a rank) comes out the same here and the Mask is never ahead of the overlay.
 */
function climb(shown, real, dtSeconds) {
  shown = Math.max(0, Math.floor(Number(shown) || 0)); real = Math.max(0, Math.floor(Number(real) || 0));
  if (shown >= real) return real;
  let left = Math.min(600, Math.max(0, Number(dtSeconds) || 0));
  while (left > 1e-9 && shown < real) { const dt = Math.min(CLIMB_STEP_S, left); shown = climbStep(shown, real, dt); left -= dt; }
  return shown;
}
/** the contract's hype block for a number of (shown) taps. mythic = how many "+1 MYTHIC" past the first MYTHIC. */
function hypeOf(taps) {
  taps = Math.max(0, Math.floor(Number(taps) || 0));
  const rank = tierIndex(taps), mult = mythicMultiplier(taps);
  return { taps, rank, label: mult >= 2 ? `MYTHIC x${mult}` : HYPE_TIERS[rank].label, mythic: Math.max(0, mult - 1) };
}

// ---------------------------------------------------------------- the host's grade -> 0..100
// The site's verdicts, best first (src/components/HostVerdictBadge.tsx; its own weights elsewhere are fire 50, gem 35,
// solid 20, promising 10). The Mask breathes fire at 70 and above, goo at 40 and below, a small puff in between
// (the VTuber's mask-v8.js). So: Fire and Hidden Gem = fire, Solid = the puff, Promising (the lowest verdict) = goo.
const GRADE_SCORE = Object.freeze({ fire: 95, gem: 82, solid: 60, promising: 38 });
// content_scores.grade letters (the site's own computed grade; NOT used for the Mask today, kept for a later switch)
const LETTER_SCORE = Object.freeze({ S: 98, A: 88, B: 72, C: 55, D: 40, F: 20 });
function gradeToScore(g) {
  const k = String(g || '').trim();
  if (Object.prototype.hasOwnProperty.call(GRADE_SCORE, k.toLowerCase())) return GRADE_SCORE[k.toLowerCase()];
  if (Object.prototype.hasOwnProperty.call(LETTER_SCORE, k.toUpperCase())) return LETTER_SCORE[k.toUpperCase()];
  return null;
}

// ---------------------------------------------------------------- the cover
/** the overlay's rule (NowLivePopout.tsx), limited to the allowed hosts: album art, else the first picture attached */
function coverOf(sub, hosts) {
  if (!sub || typeof sub !== 'object') return null;
  const list = [sub.album_artwork_url];
  if (Array.isArray(sub.attachment_urls)) list.push(sub.attachment_urls.find((u) => typeof u === 'string' && /\.(png|jpe?g|gif|webp)$/i.test(u)));
  for (const u of list) { const ok = cleanPictureUrl(u, hosts); if (ok) return ok; }
  return null;
}

const text = (v, max) => Array.from(String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : NaN; };

const POLL_MS = 2500;
const POLL_MAX_MS = 30000;
const TICK_MS = 500;
const KEEP_MS = 5000;             // the contract: at least every 5 s
const READ_TIMEOUT_MS = 6000;
const PLAY_EVERY = 4;             // an open play is looked at again every 4th read (10 s); the bar every read
const GRADE_EVERY = 2;            // the grade every 2nd read (5 s)
const LATE_GRADE_MS = [1500, 5000];   // the song just went off air ungraded: two more looks for a grade
const LATE_SCORE_SHOW_MS = 10000;     // a grade found then stays in the show state this long (with the song, off air)

class ShowFeed {
  /**
   * opts: restBase ('https://<site>/rest/v1/'), apiKey (the site's publishable key), fetch, coverHosts (the site's
   *       storage host), send(msg) -> bool (vtuber-link sendShow), wanted() -> bool (a v2 VTuber is listening),
   *       log, now, mono, setTimeout, clearTimeout, pollMs, tickMs
   */
  constructor(opts = {}) {
    this.restBase = String(opts.restBase || '');
    this.apiKey = opts.apiKey || null;
    this.fetch = opts.fetch || globalThis.fetch;
    this.coverHosts = Array.isArray(opts.coverHosts) ? opts.coverHosts : [];
    this.send = opts.send || (() => false);
    this.wanted = opts.wanted || (() => true);
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.mono = opts.mono || (() => performance.now());
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.pollMs = opts.pollMs || POLL_MS;
    this.pollMaxMs = opts.pollMaxMs || POLL_MAX_MS;
    this.tickMs = opts.tickMs || TICK_MS;
    this.keepMs = opts.keepMs || KEEP_MS;
    this.readTimeoutMs = opts.readTimeoutMs || READ_TIMEOUT_MS;
    this.lateGradeMs = opts.lateGradeMs || LATE_GRADE_MS;
    this.lateScoreShowMs = opts.lateScoreShowMs || LATE_SCORE_SHOW_MS;
    this.connected = false;         // a TikTok LIVE is connected
    this.song = null;               // { id, title, cover, coverTried } the song on air
    this.play = null;               // { key, startBar, startedAt, hostId, open } the song's newest play
    this.shownKey = null;           // the play `shown` belongs to
    this.bar = null;                // project_hype.hype_bar, last read
    this.real = 0;                  // this play's taps (as the site counts them)
    this.shown = 0;                 // the climb-limited value (what the overlay shows)
    this.score = null;
    this.late = null;               // { song, score, until } a grade found just after the song went off air
    this.fails = 0; this.retryAfterMs = 0;
    this.reads = 0;                 // good read rounds for this song
    this.pollTimer = null; this.tickTimer = null; this.lateTimers = [];
    this.polling = false; this.gen = 0;
    this.lastTickAt = null; this.lastSentAt = -Infinity; this.lastSentKey = '';
    this.said = new Set();
    this.stats = { reads: 0, failed: 0, sent: 0 };
    this.stopped = false;
  }

  /** The controller's state changed: connected to the TikTok LIVE?, the site's target, why taps are on hold. */
  update(s) {
    if (this.stopped) return;
    s = s && typeof s === 'object' ? s : {};
    const connected = !!s.connected;
    const t = s.target && typeof s.target === 'object' ? s.target : null;
    // no song on air: no target, the site's show is not on ('show'), or nothing is on air ('song')
    const onAir = connected && !!t && okId(t.submission_id) && s.hold !== 'show' && s.hold !== 'song';
    const id = onAir ? t.submission_id : null;
    if (connected !== this.connected) {
      this.connected = connected;
      if (!connected) { this._offAir(false); this._stopTick(); this.lastSentKey = ''; this.lastSentAt = -Infinity; return; }
      this._startTick();
      if (!id) this._emit(true);
    }
    if (!connected) return;
    if ((this.song && this.song.id) !== id) {
      if (this.song) this._offAir(true);
      if (id) {
        this.gen++;
        this._clearLate();
        this.song = { id, title: text(t.title, 80), cover: null, coverTried: 0 };
        this.play = null; this.bar = null; this.real = 0; this.shown = 0; this.score = null; this.reads = 0; this.shownKey = null;
        this.fails = 0; this.retryAfterMs = 0;
        this._pollSoon(0);
      }
      this._emit(true);
    } else if (this.song && t && text(t.title, 80) !== this.song.title) { this.song.title = text(t.title, 80); this._emit(true); }
  }

  /** A VTuber just started listening (or the LIVE is back after a drop): the state is sent again now, not at the next 5 s beat. */
  nudge() { if (this.stopped || !this.connected) return; this.lastSentKey = ''; this.lastSentAt = -Infinity; this._emit(true); }

  stop() { this.stopped = true; this.connected = false; this._offAir(false); this._stopTick(); }

  // ---------------------------------------------------------------- the message
  message() {
    const late = this.late && this.mono() < this.late.until ? this.late : null;
    const song = this.song || (late && late.song) || null;
    return {
      v: 2, type: 'show', onAir: !!this.song,
      song: song ? { id: song.id, title: song.title, cover: song.cover || null } : null,
      hype: hypeOf(this.song ? this.shown : 0),
      score: this.song ? this.score : late ? late.score : null,
      at: this.now(),
    };
  }

  _emit(force) {
    if (!this.connected || this.stopped) return;
    const m = this.message();
    const key = JSON.stringify({ ...m, at: 0 });
    const due = this.mono() - this.lastSentAt >= this.keepMs;
    if (key === this.lastSentKey && !due && force !== 'again') return;
    let took = false;
    try { took = this.send(m) === true; } catch { took = false; }
    // not taken (no VTuber, or it is busy): the same state is offered again on the next tick
    if (took) { this.lastSentKey = key; this.lastSentAt = this.mono(); this.stats.sent++; }
  }

  // ---------------------------------------------------------------- the clock: the climb + "at least every 5 s"
  _later(fn, wait) { const t = this.setTimeout(fn, wait); if (t && typeof t.unref === 'function') t.unref(); return t; }
  _startTick() { this._stopTick(); this.lastTickAt = this.mono(); this.tickTimer = this._later(() => this._tick(), this.tickMs); }
  _stopTick() { this.clearTimeout(this.tickTimer); this.tickTimer = null; }
  _tick() {
    this.tickTimer = null;
    if (!this.connected || this.stopped) return;
    const now = this.mono(), dt = Math.max(0, (now - (this.lastTickAt === null ? now : this.lastTickAt)) / 1000);
    this.lastTickAt = now;
    if (this.song) this.shown = climb(this.shown, this.real, dt);
    if (this.late && now >= this.late.until) this.late = null;
    // a VTuber appeared after the song went on air: start reading now
    if (this.song && !this.pollTimer && !this.polling) this._pollSoon(0);
    this._emit(false);
    this.tickTimer = this._later(() => this._tick(), this.tickMs);
  }

  // ---------------------------------------------------------------- the song went off air
  _offAir(lookForGrade) {
    const was = this.song, play = this.play, hadScore = this.score !== null;
    this.gen++;
    this.clearTimeout(this.pollTimer); this.pollTimer = null;
    this.song = null; this.play = null; this.bar = null; this.real = 0; this.shown = 0; this.score = null;
    this._clearLate();
    if (!lookForGrade || !was || hadScore || !play || !this.connected) return;
    // The host often gives the verdict as the song ends: look twice more for one given during that play.
    const gen = this.gen;
    for (const wait of this.lateGradeMs) {
      this.lateTimers.push(this._later(async () => {
        if (gen !== this.gen || this.late || !this.connected || this.stopped || !this._want()) return;
        const score = await this._grade(was.id, play).catch(() => null);
        if (gen !== this.gen || this.late || score === null || !this.connected) return;
        this.late = { song: { id: was.id, title: was.title, cover: was.cover }, score, until: this.mono() + this.lateScoreShowMs };
        this._emit(true);
      }, wait));
    }
  }
  _clearLate() { for (const t of this.lateTimers.splice(0)) this.clearTimeout(t); this.late = null; }

  // ---------------------------------------------------------------- reading the site
  _want() { try { return this.wanted() !== false; } catch { return false; } }
  /** the wait before the next read: 2.5 s, doubled per failed round up to 30 s; never sooner than a 429 asked for */
  nextWaitMs() { return Math.max(Math.min(this.pollMaxMs, this.pollMs * 2 ** Math.min(this.fails, 8)), this.retryAfterMs || 0); }
  _pollSoon(wait) {
    this.clearTimeout(this.pollTimer);
    this.pollTimer = this._later(() => { this.pollTimer = null; this._poll(); }, wait);
  }

  async _get(query) {
    if (!this.restBase || !this.fetch) throw new Error('no site');
    const ctl = new AbortController();
    const timer = this.setTimeout(() => ctl.abort(), this.readTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const headers = { accept: 'application/json' };
      if (this.apiKey) { headers.apikey = this.apiKey; headers.authorization = `Bearer ${this.apiKey}`; }
      const res = await this.fetch(this.restBase + query, { method: 'GET', headers, signal: ctl.signal });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        if (ra > 0) e.retryAfterMs = Math.min(120000, ra * 1000);
        try { await res.text(); } catch {}
        throw e;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('not rows');
      return rows;
    } finally { this.clearTimeout(timer); }
  }

  /** the host's verdict given during this play, as 0..100, or null */
  async _grade(id, play) {
    const rows = await this._get(`ranking_board?select=host_id,host_grade,reviewed_at&submission_id=eq.${encodeURIComponent(id)}&host_grade=not.is.null&order=reviewed_at.desc.nullslast&limit=5`);
    const since = play && Number.isFinite(play.startedAt) ? play.startedAt : NaN;
    if (!Number.isFinite(since)) return null;
    for (const r of rows) {
      if (!r || (play.hostId && r.host_id && r.host_id !== play.hostId)) continue;   // another host's verdict
      const at = ms(r.reviewed_at);
      if (!(at >= since)) continue;                                                   // an old verdict (or undated)
      const n = gradeToScore(r.host_grade);
      if (n !== null) return n;
    }
    return null;
  }

  async _poll() {
    if (this.polling || !this.song || !this.connected || this.stopped) return;
    if (!this._want()) return;                       // no v2 VTuber listening: nothing is read (the tick asks again)
    const gen = this.gen, song = this.song, id = encodeURIComponent(song.id);
    this.polling = true;
    let ok = true, retryAfter = 0;
    const fail = (e) => { ok = false; if (e && e.retryAfterMs) retryAfter = Math.max(retryAfter, e.retryAfterMs); };
    try {
      const needPlay = !this.play || !this.play.open || this.reads % PLAY_EVERY === 0;
      const jobs = [this._get(`project_hype?select=hype_bar&submission_id=eq.${id}&limit=1`).then((rows) => { if (gen === this.gen) this.bar = rows[0] ? Math.max(0, Math.floor(Number(rows[0].hype_bar) || 0)) : 0; }, fail)];
      if (needPlay) {
        jobs.push(this._get(`hype_plays?select=id,host_id,start_bar,end_bar,started_at,ended_at&submission_id=eq.${id}&order=started_at.desc&limit=1`).then((rows) => {
          if (gen !== this.gen) return;
          const p = rows[0];
          this.play = p ? { key: `${p.id}:${p.start_bar}`, startBar: Math.max(0, Math.floor(Number(p.start_bar) || 0)), startedAt: ms(p.started_at), hostId: p.host_id || null,
            open: !p.ended_at } : null;
        }, fail));
      }
      if (!song.cover && song.coverTried < 3) {
        jobs.push(this._get(`submissions_public?select=id,title,album_artwork_url,attachment_urls&id=eq.${id}&limit=1`).then((rows) => {
          if (gen !== this.gen) return;
          song.coverTried = 3;                                     // answered: a song without a usable cover stays without
          song.cover = coverOf(rows[0], this.coverHosts);
        }, (e) => { song.coverTried++; fail(e); }));
      }
      await Promise.all(jobs);
      if (gen !== this.gen) return;
      if (this.play && this.play.open && this.score === null && this.reads % GRADE_EVERY === 0) {
        try { const n = await this._grade(song.id, this.play); if (gen === this.gen && n !== null) this.score = n; } catch (e) { fail(e); }
        if (gen !== this.gen) return;
      }
      this.stats.reads++;
      if (ok) this._took(); else this.stats.failed++;
    } catch (e) { fail(e); this.stats.failed++; }
    finally {
      this.polling = false;
      if (gen === this.gen && this.song && this.connected && !this.stopped) {
        if (ok) { this.fails = 0; this.retryAfterMs = 0; this.reads++; this._say('ok'); }
        else { this.fails++; this.retryAfterMs = retryAfter; this._say('fail'); }
        this._pollSoon(this.nextWaitMs());
        this._emit(false);
      }
    }
  }

  // a good read: this play's taps, as the site counts them
  _took() {
    const p = this.play;
    // No open play for this song yet (it only just went on air and the site has not opened its play, or the newest
    // play is an earlier, finished one): the bar is empty. The site's overlay shows a finished play's last value while
    // off air; the Mask must not wear an old play's rank.
    if (!p || !p.open || this.bar === null) { this.real = 0; this.shown = 0; return; }
    const real = Math.max(0, this.bar - p.startBar);
    if (this.shownKey !== p.key) {
      // A play this file has not shown yet. The overlay began at 0 when the play began and may have climbed one rank
      // per 15 s since: never start above that (a play that began long ago starts at its real value, as a freshly
      // opened overlay does).
      const elapsed = Number.isFinite(p.startedAt) ? Math.max(0, (this.now() - p.startedAt) / 1000) : 0;
      this.shown = Math.min(real, Math.floor(tapsAtRankPosition(elapsed * RANKS_PER_SECOND)));
      this.shownKey = p.key;
      this.lastTickAt = this.mono();                 // the climb counts on from this moment, not from the tick before it
    }
    this.real = real;
    if (this.shown > real) this.shown = real;
  }

  _say(what) {
    if (what === 'fail' && !this.said.has('fail')) { this.said.add('fail'); this.said.delete('ok'); this.log('warn', 'show feed: the site did not answer a read of the hype bar: trying again more slowly'); }
    else if (what === 'ok' && this.said.has('fail')) { this.said.delete('fail'); this.log('info', 'show feed: the site answers again'); }
  }
}

module.exports = { ShowFeed, HYPE_TIERS, MYTHIC_MIN, MYTHIC_STEP, RANKS_PER_SECOND, tierIndex, mythicMultiplier, rankPosition, tapsAtRankPosition, climb, hypeOf,
  GRADE_SCORE, LETTER_SCORE, gradeToScore, coverOf, POLL_MS, POLL_MAX_MS, KEEP_MS };
