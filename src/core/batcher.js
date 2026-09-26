'use strict';
// Collects TikTok like batches between pushes.
//
// The site credits taps from `session_total` (TikTok's room like total, the largest value seen), not from the
// events: accepted = clamp(session_total - last_session_total, 0, 500) per push, and any excess is carried over
// server-side. So a dropped push or a stale event never loses taps; events are for diagnostics and checks.
// Contract limits: at most 200 events per push, each count an integer 1..500, `at` within +-10 s of server time.

const MAX_EVENTS = 200;
const MAX_COUNT = 500;
const STALE_MS = 9000;          // a little inside the server's 10 s window

class LikeBatcher {
  constructor() { this.reset(null); }

  reset(roomId) {
    this.roomId = roomId || null;
    this.buckets = new Map();   // second (local ms / 1000) -> taps
    this.sessionTotal = null;   // largest room total seen in this room
    this.lastSentTotal = null;  // session_total of the last successful push
    this.firstBase = null;      // the room total just BEFORE the first batch we saw
    this.sessionTaps = 0;       // taps seen since we joined this room (for the UI)
  }

  add({ count, total, at }) {
    const c = Math.max(0, Math.floor(Number(count) || 0));
    if (c > 0) {
      const sec = Math.floor(Number(at) / 1000);
      this.buckets.set(sec, (this.buckets.get(sec) || 0) + c);
      this.sessionTaps += c;
    }
    const t = Number(total);
    if (Number.isFinite(t) && t >= 0) {
      if (this.firstBase === null) this.firstBase = Math.max(0, Math.floor(t) - c);
      if (this.sessionTotal === null || t > this.sessionTotal) this.sessionTotal = Math.floor(t);
    }
  }

  // The session_total to send next. The site treats the FIRST push for a room as the baseline (credits 0), so the
  // first push reports the total from just before our first batch; the next push then credits every tap we saw.
  nextTotal() {
    if (this.sessionTotal === null) return null;
    if (this.lastSentTotal === null && this.firstBase !== null) return this.firstBase;
    return this.sessionTotal;
  }

  hasNews() {
    return this.buckets.size > 0 || (this.sessionTotal !== null && this.sessionTotal !== this.lastSentTotal);
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
    return { events: dropped ? events.slice(dropped) : events, stale, dropped, sessionTotal: this.nextTotal() };
  }

  markSent(sessionTotal) { if (sessionTotal !== null && sessionTotal !== undefined) this.lastSentTotal = sessionTotal; }
}

module.exports = { LikeBatcher, MAX_EVENTS, MAX_COUNT, STALE_MS };
