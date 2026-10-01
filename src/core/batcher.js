'use strict';
// Collects TikTok like batches between pushes for ONE TikTok room.
//
// The site credits taps from `session_total` (TikTok's room like total, the largest value seen), not from the
// events: accepted = clamp(session_total - last_session_total, 0, 500) per push, and any excess is carried over
// server-side. So a dropped push or a stale event never loses taps; events are for diagnostics and checks.
// Contract limits: at most 200 events per push, each count an integer 1..500, `at` within +-10 s of server time.

const MAX_EVENTS = 200;
const MAX_COUNT = 500;
const STALE_MS = 9000;          // a little inside the server's 10 s window

// A usable room total. tiktok-live-proto v3 DEFAULTS `total` to "0" when the wire omits it, so 0 (or anything
// smaller than the batch itself) means "no total in this message", never "the room has 0 likes".
function usableTotal(total, count) {
  const t = Number(total);
  return Number.isFinite(t) && t > 0 && t >= (count || 0) ? Math.floor(t) : null;
}

class LikeBatcher {
  constructor(roomId = null) { this.reset(roomId); }

  reset(roomId) {
    this.roomId = roomId || null;
    this.buckets = new Map();   // second (local ms / 1000) -> taps
    this.sessionTotal = null;   // largest room total seen since we (re)started watching this room
    this.lastSentTotal = null;  // session_total of the last successful push
    this.firstBase = null;      // while a baseline is pending: the room total just BEFORE the first batch we saw
    // The next push asks the site to baseline (credit 0). A new batcher (app start, new room) always starts this
    // way, so taps from before LIVE Link was watching (app closed, crashed, restarting) are never credited.
    this.rebase = true;
    this.gen = 0;               // bumps on every new baseline request, so a push already in flight can't cancel it
    this.sessionTaps = 0;       // taps seen since we joined this room (for the UI)
  }

  add({ count, total, at }) {
    const c = Math.max(0, Math.floor(Number(count) || 0));
    if (c > 0) {
      const sec = Math.floor(Number(at) / 1000);
      this.buckets.set(sec, (this.buckets.get(sec) || 0) + c);
      this.sessionTaps += c;
    }
    const t = usableTotal(total, c);
    if (t !== null) {
      if (this.rebase && this.firstBase === null) this.firstBase = Math.max(0, t - c);
      if (this.sessionTotal === null || t > this.sessionTotal) this.sessionTotal = t;
    }
  }

  // Start counting from "now": taps seen so far in this room will never be credited (Test mode off, show not on).
  rebaseNow() {
    this.buckets.clear();
    this.firstBase = this.sessionTotal;   // null: the next batch with a total sets it
    this.rebase = true;
    this.gen++;
  }

  // LIVE Link stopped watching (Disconnect, switched off, quit...): the totals held are stale. Wait for a fresh total
  // once watching resumes and baseline just before its first batch, so taps from the gap are never credited.
  markStale() {
    this.buckets.clear();
    this.sessionTotal = null;
    this.firstBase = null;
    this.rebase = true;
    this.gen++;
  }

  // The session_total to send next. A baseline push reports the total from just before our first batch, so the
  // next push credits every tap we saw. The site only accepts a POSITIVE total (0 is a 400), so report at least 1:
  // at most one tap of a brand-new room goes uncredited.
  nextTotal() {
    if (this.sessionTotal === null) return null;
    if (this.rebase) return Math.max(1, this.firstBase === null ? this.sessionTotal : this.firstBase);
    return this.sessionTotal;
  }

  hasNews() {
    return this.buckets.size > 0 || (this.sessionTotal !== null && (this.rebase || this.nextTotal() !== this.lastSentTotal));
  }

  // Build the events array for one push. clockOffsetMs = server time - local time.
  take(nowMs, clockOffsetMs = 0) {
    const events = [];
    let stale = 0;
    const secs = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const sec of secs) {
      const taps = this.buckets.get(sec);
      const localMs = sec * 1000 + 500;
      if (nowMs - localMs > STALE_MS) { stale += taps; continue; }
      const at = new Date(localMs + clockOffsetMs).toISOString();
      for (let left = taps; left > 0; left -= MAX_COUNT) events.push({ type: 'like', count: Math.min(MAX_COUNT, left), at });
    }
    this.buckets.clear();
    // Keep the newest events if a huge burst would exceed the per-push limit (crediting uses session_total anyway).
    const dropped = events.length > MAX_EVENTS ? events.length - MAX_EVENTS : 0;
    return { events: dropped ? events.slice(dropped) : events, stale, dropped, sessionTotal: this.nextTotal(), rebaseline: this.rebase, gen: this.gen };
  }

  // gen = the batcher generation the push was taken at: a baseline requested after it stays pending.
  markSent(sessionTotal, rebaseline, gen = this.gen) {
    if (sessionTotal !== null && sessionTotal !== undefined) this.lastSentTotal = sessionTotal;
    if (rebaseline && gen === this.gen) { this.rebase = false; this.firstBase = null; }
  }
}

module.exports = { LikeBatcher, usableTotal, MAX_EVENTS, MAX_COUNT, STALE_MS };
