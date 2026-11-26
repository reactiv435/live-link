'use strict';
// V8 (the puppet show): the "show state" for the VTuber on this computer. The Mask changes with the hype rank of the
// song on air, "eats" the song's cover, spits the host's grade out as fire or goo, and may start a boss fight only
// between songs. Contract: the VTuber repo's V8-PHASE2.md, C3:
//   { v: 2, type: 'show', onAir, song: { id, title, cover } | null, hype: { taps, rank, label, mythic }, score, at }
//   2.3.1 adds two fields (ADDED only: v stays 2, a 2.3.0 VTuber drops what it does not know):
//     grade:  'fire' | 'gem' | 'solid' | 'promising' | null   the host's verdict WORD behind `score`
//     finish: { id, kind: 'played' | 'radio', at } | null     the song was finished (DONE / ADD TO AI RADIO); said for 20 s
//   sent on every change and at least every 5 s, to a VTuber that speaks v2 (2.3.1: with or without a TikTok LIVE).
//
// Where each part comes from:
//  * The song on air (2.3.1): the site's public table active_projects for THIS host (the hype-target row, else the
//    newest), as the site's /live/now overlay finds it; read every 2.5 s while a v2 VTuber listens. So the Mask knows
//    the song whether or not TikTok is connected. Until that read has answered (or when the site's config gives no
//    host id), the site's own answer to LIVE Link's push / config is used (`target` = { submission_id, title } or
//    null; controller.js), and a new target from the controller is taken at once.
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
//  * The finish (2.3.1; the Mask eats the song THEN, not at its start):
//      'radio'  = the host pressed ADD TO AI RADIO for the song on air: its radio_tracks row appears, or stops being
//                 preview-only. Read every 2nd round while the song is on air; the first answer is only the starting
//                 point (a song that was already in the radio before this airing does not finish by it).
//      'played' = the host pressed DONE: the song leaves the air and submissions_public.status becomes 'played'
//                 (played_at not older than this airing). Looked at up to three times as the song leaves. A song
//                 CLEARED without DONE keeps its status: no finish.
//    One finish per song (both buttons = one). After a finish the late looks for a verdict go on to 10 s and 20 s;
//    the next song going on air ends them (never another song's word during this one).
//
// Gentle on the site: one small read round every 2.5 s while a VTuber that speaks v2 is listening (GET only);
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
// 2.3.1: the song's finish
const RADIO_EVERY = 2;                // the AI radio's row for the song on air: every 2nd read (5 s)
const FINISH_TRY_MS = [0, 1500, 4000];   // the song left the air: three looks at its status (DONE writes it a moment later)
const FINISH_GRADE_MS = [10000, 20000];  // after a finish: two more looks for a verdict (the Mask waits 20 s for the word)
const FINISH_SHOW_MS = 20000;         // a finish stays in the show state this long
const FINISH_ONCE_MS = 10 * 60000;    // the same song is not finished twice within this (both buttons, a flicker off and on air)
const PLAYED_SLACK_MS = 60000;        // played_at may be this much before the airing's own start time and still be this DONE
const GRADE_WORDS = Object.freeze(['fire', 'gem', 'solid', 'promising']);
/** the verdict as the Mask says it: one of the four words (lower case), or null (a letter grade has no word) */
function gradeWord(g) { const k = typeof g === 'string' ? g.trim().toLowerCase() : ''; return GRADE_WORDS.includes(k) ? k : null; }

class ShowFeed {
  /**
   * opts: restBase ('https://<site>/rest/v1/'), apiKey (the site's publishable key), fetch, coverHosts (the site's
   *       storage host), send(msg) -> bool (vtuber-link sendShow), wanted() -> bool (a v2 VTuber is listening),
   *       hostId() -> string | null (the host this computer is paired to: the site's live-link-config host_id),
   *       log, now, mono, setTimeout, clearTimeout, pollMs, tickMs
   */
  constructor(opts = {}) {
    this.restBase = String(opts.restBase || '');
    this.apiKey = opts.apiKey || null;
    this.fetch = opts.fetch || globalThis.fetch;
    this.coverHosts = Array.isArray(opts.coverHosts) ? opts.coverHosts : [];
    this.send = opts.send || (() => false);
    this.wanted = opts.wanted || (() => true);
    this.hostId = typeof opts.hostId === 'function' ? opts.hostId : () => null;
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
    this.finishTryMs = opts.finishTryMs || FINISH_TRY_MS;
    this.finishGradeMs = opts.finishGradeMs || FINISH_GRADE_MS;
    this.finishShowMs = opts.finishShowMs || FINISH_SHOW_MS;
    this.finishOnceMs = opts.finishOnceMs || FINISH_ONCE_MS;
    this.connected = false;         // a TikTok LIVE is connected (kept for the record: it gates nothing here since 2.3.1)
    this.started = false;           // the controller has said something: the clock runs
    this.ctl = { id: null, title: '', hold: null };   // the controller's word: its target and why taps are on hold
    this.ctlRev = 0;                // counts its changes (an answer of the table that is older than the last one is dropped)
    this.air = undefined;           // the site's own word (active_projects): { id, activatedAt } | null; undefined = not answered yet
    this.wasWant = false;           // a v2 VTuber was listening at the last tick
    this.song = null;               // { id, title, cover, coverTried, since, radio, finished } the song on air
    this.play = null;               // { key, startBar, startedAt, hostId, open } the song's newest play
    this.shownKey = null;           // the play `shown` belongs to
    this.bar = null;                // project_hype.hype_bar, last read
    this.real = 0;                  // this play's taps (as the site counts them)
    this.shown = 0;                 // the climb-limited value (what the overlay shows)
    this.score = null; this.grade = null;   // the host's verdict: 0-100, and its word
    this.late = null;               // { song, score, grade, until } a grade found just after the song went off air
    this.finish = null;             // { id, kind, at, until, song, score, grade } the last finish, while it is said
    this.finishedAt = new Map();    // song id -> when it was finished (one finish per song)
    this.lastOff = null;            // { was, play, gen, at } the song that last went off air (for the looks after a finish)
    this.finishTimers = [];
    this.fails = 0; this.retryAfterMs = 0;
    this.reads = 0;                 // good read rounds for this song
    this.pollTimer = null; this.tickTimer = null; this.lateTimers = [];
    this.polling = false; this.gen = 0;
    this.lastTickAt = null; this.lastSentAt = -Infinity; this.lastSentKey = '';
    this.said = new Set();
    this.stats = { reads: 0, failed: 0, sent: 0 };
    this.stopped = false;
  }

  /**
   * The controller's state changed: connected to the TikTok LIVE?, the site's target, why taps are on hold.
   * 2.3.1: TikTok being connected no longer decides anything here. The song on air is the site's own table (read in
   * _poll for this host); the controller's target is the word used until that read has answered, and a NEW target
   * from the controller (the site's push answer, the freshest word there is) is taken at once again.
   * hold 'show' (the site's show is not on) and 'song' (nothing on air) still mean: no song on air.
   */
  update(s) {
    if (this.stopped) return;
    s = s && typeof s === 'object' ? s : {};
    this.connected = !!s.connected;
    const t = s.target && typeof s.target === 'object' ? s.target : null;
    const hold = s.hold === 'show' || s.hold === 'song' ? s.hold : null;
    const id = !hold && t && okId(t.submission_id) ? t.submission_id : null;
    const changed = id !== this.ctl.id || hold !== this.ctl.hold;
    this.ctl = { id, title: id ? text(t.title, 80) : '', hold };
    if (changed) { this.air = undefined; this.ctlRev++; }   // the controller knows something new: ask the table again
    const first = !this.started;
    if (first) { this.started = true; this.wasWant = this._want(); this._startTick(); }
    this._resolve();
    if (first) this._emit(false);                      // the first word (a song or "nothing on air") is said at once
    if (changed && this._hostId() && this._want()) this._pollSoon(0);
  }

  /** the host this computer is paired to, or null (then the controller's target is all there is) */
  _hostId() { try { const h = this.hostId(); return okId(h) ? h : null; } catch { return null; } }

  /** Which song is on air right now, from the two words above; says it when it changed. */
  _resolve() {
    if (this.stopped) return;
    let id = null;
    if (!this.ctl.hold) id = this.air !== undefined ? (this.air ? this.air.id : null) : this.ctl.id;
    const title = id && id === this.ctl.id ? this.ctl.title : '';
    if ((this.song && this.song.id) !== id) {
      if (this.song) this._offAir(true);
      if (id) {
        this.gen++;
        this._clearLate();
        // since = when this airing began by the SITE's clock (active_projects.activated_at), if the table said so
        this.song = { id, title, cover: null, coverTried: 0, since: this.air && this.air.id === id ? this.air.activatedAt : NaN, radio: undefined, finished: false };
        this.play = null; this.bar = null; this.real = 0; this.shown = 0; this.score = null; this.grade = null; this.reads = 0; this.shownKey = null;
        this.fails = 0; this.retryAfterMs = 0;
        this._pollSoon(0);
      }
      this._emit(true);
    } else if (this.song && title && title !== this.song.title) { this.song.title = title; this._emit(true); }
  }

  /** A VTuber just started listening: the state is sent again now, not at the next 5 s beat. */
  nudge() { if (this.stopped || !this.started) return; this.lastSentKey = ''; this.lastSentAt = -Infinity; this._emit(true); }

  stop() {
    this.stopped = true; this.connected = false; this._offAir(false); this._stopTick(); this.clearTimeout(this.pollTimer); this.pollTimer = null;
    for (const t of this.finishTimers.splice(0)) this.clearTimeout(t);
    this.finish = null;
  }

  // ---------------------------------------------------------------- the message
  message() {
    const late = this.late && this.mono() < this.late.until ? this.late : null;
    const fin = this.finish && this.mono() < this.finish.until ? this.finish : null;
    // off air: the song a late verdict or a finish belongs to stays in the message (the Mask needs its cover to eat it)
    const song = this.song || (late && late.song) || (fin && fin.song) || null;
    const said = this.song ? this : late || fin || { score: null, grade: null };
    return {
      v: 2, type: 'show', onAir: !!this.song,
      song: song ? { id: song.id, title: song.title, cover: song.cover || null } : null,
      hype: hypeOf(this.song ? this.shown : 0),
      score: said.score,
      grade: said.score === null ? null : said.grade || null,
      finish: fin ? { id: fin.id, kind: fin.kind, at: fin.at } : null,
      at: this.now(),
    };
  }

  _emit(force) {
    if (!this.started || this.stopped) return;
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
    if (!this.started || this.stopped) return;
    const now = this.mono(), dt = Math.max(0, (now - (this.lastTickAt === null ? now : this.lastTickAt)) / 1000);
    this.lastTickAt = now;
    if (this.song) this.shown = climb(this.shown, this.real, dt);
    if (this.late && now >= this.late.until) this.late = null;
    if (this.finish && now >= this.finish.until) this.finish = null;
    const want = this._want();
    if (want && !this.wasWant) {
      // a VTuber appeared: what the table said while nobody listened is old (ask again), and it gets the state now
      this.air = undefined; this._resolve();
      this.lastSentKey = ''; this.lastSentAt = -Infinity;
    }
    this.wasWant = want;
    // a VTuber is listening: read (the song on air for this host; the bar of the song on air)
    if (want && (this.song || this._hostId()) && !this.pollTimer && !this.polling) this._pollSoon(0);
    this._emit(false);
    this.tickTimer = this._later(() => this._tick(), this.tickMs);
  }

  // ---------------------------------------------------------------- the song went off air
  _offAir(lookForGrade) {
    const was = this.song, play = this.play, hadScore = this.score !== null;
    this.gen++;
    if (was) {
      was.score = this.score; was.grade = this.grade;                 // the verdict it left the air with (for its finish)
      if (this.finish && this.finish.id === was.id) { this.finish.score = this.score; this.finish.grade = this.grade; }
    }
    this.song = null; this.play = null; this.bar = null; this.real = 0; this.shown = 0; this.score = null; this.grade = null;
    this._clearLate();
    this.lastOff = null;
    if (!lookForGrade || !was || this.stopped) return;
    // 2.3.1: did the host press DONE? (a song already finished by the AI radio button is not finished again)
    if (!was.finished) this._lookPlayed(was, Number.isFinite(was.since) ? was.since : play && Number.isFinite(play.startedAt) ? play.startedAt : NaN);
    if (hadScore || !play) return;
    // The host often gives the verdict as the song ends: look twice more for one given during that play
    // (and, once the song is known to be finished, at 10 s and 20 s: the Mask chews that long).
    this.lastOff = { was, play, gen: this.gen, at: this.mono() };
    this._lateLooks(this.lateGradeMs);
    if (was.finished) this._lateLooks(this.finishGradeMs);
  }
  _lateLooks(waits) {
    const off = this.lastOff;
    if (!off || off.gen !== this.gen) return;
    const { was, play, gen } = off, gone = this.mono() - off.at;
    for (const wait of waits) {
      this.lateTimers.push(this._later(async () => {
        if (gen !== this.gen || this.late || this.stopped || !this._want()) return;
        const g = await this._grade(was.id, play).catch(() => null);
        if (gen !== this.gen || this.late || !g || this.stopped) return;
        this.late = { song: { id: was.id, title: was.title, cover: was.cover }, score: g.score, grade: g.word, until: this.mono() + this.lateScoreShowMs };
        if (this.finish && this.finish.id === was.id) { this.finish.score = g.score; this.finish.grade = g.word; }
        this._emit(true);
      }, Math.max(0, wait - gone)));
    }
  }

  // ---------------------------------------------------------------- 2.3.1: the song was finished
  /** One finish per song: said now, kept in the message for 20 s. False when this song was finished a moment ago already. */
  _finish(song, kind) {
    const now = this.mono(), last = this.finishedAt.get(song.id);
    song.finished = true;
    if (last !== undefined && now - last < this.finishOnceMs) return false;
    this.finishedAt.delete(song.id); this.finishedAt.set(song.id, now);
    if (this.finishedAt.size > 50) this.finishedAt.delete(this.finishedAt.keys().next().value);
    // the verdict known so far: the song's own while on air, else what it left the air with or a late look found
    const late = this.late && this.late.song.id === song.id ? this.late : null;
    const said = this.song === song ? this : late || { score: song.score === undefined ? null : song.score, grade: song.grade || null };
    this.finish = { id: song.id, kind, at: Math.floor(this.now()), until: now + this.finishShowMs, song: { id: song.id, title: song.title, cover: song.cover },
      score: said.score, grade: said.grade || null };
    this._emit(true);
    return true;
  }
  /** The song left the air: up to three looks at its status. 'played' (by this airing's DONE) = a finish. */
  _lookPlayed(was, since) {
    for (const wait of this.finishTryMs) {
      const t = this._later(async () => {
        this.finishTimers = this.finishTimers.filter((x) => x !== t);
        if (was.finished || this.stopped || !this._want()) return;
        let rows;
        try { rows = await this._get(`submissions_public?select=id,status,played_at&id=eq.${encodeURIComponent(was.id)}&limit=1`); } catch { return; }
        const r = rows[0];
        if (was.finished || this.stopped || !r || r.status !== 'played') return;
        const at = ms(r.played_at);
        if (Number.isFinite(at) && Number.isFinite(since) && at < since - PLAYED_SLACK_MS) return;   // an earlier show's DONE
        if (this._finish(was, 'played') && this.lastOff && this.lastOff.was === was) this._lateLooks(this.finishGradeMs);
      }, wait);
      this.finishTimers.push(t);
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

  /** the host's verdict given during this play: { score: 0..100, word: 'fire' | 'gem' | 'solid' | 'promising' | null }, or null */
  async _grade(id, play) {
    const rows = await this._get(`ranking_board?select=host_id,host_grade,reviewed_at&submission_id=eq.${encodeURIComponent(id)}&host_grade=not.is.null&order=reviewed_at.desc.nullslast&limit=5`);
    const since = play && Number.isFinite(play.startedAt) ? play.startedAt : NaN;
    if (!Number.isFinite(since)) return null;
    for (const r of rows) {
      if (!r || (play.hostId && r.host_id && r.host_id !== play.hostId)) continue;   // another host's verdict
      const at = ms(r.reviewed_at);
      if (!(at >= since)) continue;                                                   // an old verdict (or undated)
      const n = gradeToScore(r.host_grade);
      if (n !== null) return { score: n, word: gradeWord(r.host_grade) };
    }
    return null;
  }

  /** the song on air for this host, as the site's /live/now overlay finds it: the hype target, else the newest active one */
  async _onAir(hostId) {
    const rows = await this._get(`active_projects?select=submission_id,activated_at,is_hype_target&host_id=eq.${encodeURIComponent(hostId)}&order=activated_at.desc&limit=5`);
    const ok = rows.filter((r) => r && okId(r.submission_id));
    const pick = ok.find((r) => r.is_hype_target === true) || ok[0] || null;
    return pick ? { id: pick.submission_id, activatedAt: ms(pick.activated_at) } : null;
  }

  async _poll() {
    if (this.polling || !this.started || this.stopped) return;
    if (!this._want()) return;                       // no v2 VTuber listening: nothing is read (the tick asks again)
    const hostId = this._hostId();
    if (!hostId && !this.song) return;               // no song on air and no host to ask about: nothing to read
    this.polling = true;
    let ok = true, retryAfter = 0, gen = this.gen;
    const fail = (e) => { ok = false; if (e && e.retryAfterMs) retryAfter = Math.max(retryAfter, e.retryAfterMs); };
    try {
      if (hostId) {
        // 2.3.1: which song is on air, from the site's own table (TikTok or not)
        const rev = this.ctlRev;
        try {
          const air = await this._onAir(hostId);
          if (this.stopped) return;
          if (rev === this.ctlRev) { this.air = air; this._resolve(); }   // (the controller said something new meanwhile: its word stands, the next read settles it)
        } catch (e) { fail(e); }
      }
      gen = this.gen;
      const song = this.song;
      if (!song) { this.stats.reads++; if (!ok) this.stats.failed++; return; }
      const id = encodeURIComponent(song.id);
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
          if (!song.title && rows[0] && typeof rows[0].title === 'string') song.title = text(rows[0].title, 80);   // (the table gave the song, not the controller)
        }, (e) => { song.coverTried++; fail(e); }));
      }
      if (!song.finished && this.reads % RADIO_EVERY === 0) {
        // 2.3.1: ADD TO AI RADIO for the song on air = its row appears, or stops being preview-only
        jobs.push(this._get(`radio_tracks?select=submission_id,preview_only&submission_id=eq.${id}&limit=1`).then((rows) => {
          if (gen !== this.gen || song.finished) return;
          const inRadio = !!rows[0] && rows[0].preview_only !== true;
          if (song.radio === undefined) song.radio = inRadio;          // where this airing starts from
          else if (inRadio && !song.radio) { song.radio = true; this._finish(song, 'radio'); }
        }, fail));
      }
      await Promise.all(jobs);
      if (gen !== this.gen) return;
      if (this.play && this.play.open && this.score === null && this.reads % GRADE_EVERY === 0) {
        try { const g = await this._grade(song.id, this.play); if (gen === this.gen && g) { this.score = g.score; this.grade = g.word; } } catch (e) { fail(e); }
        if (gen !== this.gen) return;
      }
      this.stats.reads++;
      if (ok) this._took(); else this.stats.failed++;
    } catch (e) { fail(e); this.stats.failed++; }
    finally {
      this.polling = false;
      if (!this.stopped) {
        if (ok) { this.fails = 0; this.retryAfterMs = 0; if (gen === this.gen && this.song) this.reads++; this._say('ok'); }
        else { this.fails++; this.retryAfterMs = retryAfter; this._say('fail'); }
        // the song changed while its reads were out: read the new one now; else at the usual pace
        if (this.song || this._hostId()) this._pollSoon(gen !== this.gen && this.song && ok ? 0 : this.nextWaitMs());
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
  GRADE_SCORE, LETTER_SCORE, GRADE_WORDS, gradeToScore, gradeWord, coverOf, POLL_MS, POLL_MAX_MS, KEEP_MS, LATE_GRADE_MS, FINISH_TRY_MS, FINISH_GRADE_MS, FINISH_SHOW_MS };
