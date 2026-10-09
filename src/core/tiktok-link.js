'use strict';
// TikTok LIVE connection for one host, built on tiktok-live-connector 2.4.4 (the same library and the same
// reconnect rules as the T.O.S CREW show program, which has read real LIVE taps with it since 2026-09-19).
//
// Emits:
//   'state' { status, roomId, viewers, error, errorKind, retryAt, wrongOwner }
//            errorKind: timeout | error | rate-limit | blocked | not_found | wrong_room | offline
//            status: idle | connecting | live | offline | reconnecting | error
//   'like'  { count, total, at }   count = taps in this batch, total = the room's running like total (or NaN)
//   'gift'  { key, count, units, coins, giftId, name, imageUrl, userHandle, userName, at }
//            key = one combo (or one single gift); count = that combo's running total; units = new since the last frame
//   'roomChanged' roomId
//
// Why these numbers (ported from tos crew live/server.js):
//   * a LIVE room that dropped: retry after 10 s;
//   * the room is not LIVE yet: check every offlinePollMs (30 s while the host's show is on, slower otherwise);
//   * other failures: back off 10 -> 20 -> 40 -> 80 -> 120 s, reset after a minute connected or once TikTok says
//     "not live" (a room that connects and drops at once keeps backing off, up to 40 s);
//   * a rate-limit answer is honoured: never retry before its retry-after (at least 60 s, at most 30 min);
//   * a connect that hangs is abandoned after 90 s (the sign server gets 20 s, TikTok's own calls one retry each);
//     an open socket with no data for 120 s is reconnected once, then left alone for 5 min so a quiet room can't
//     spin into a reconnect loop;
//   * TikTok keeps handing out a LIVE's room for a while after it ended: reconnecting to that same room within 15 min
//     only counts as LIVE once real LIVE data arrives; otherwise it is "not live", checked less and less often.
const EventEmitter = require('events');
const crypto = require('crypto');
const { usableTotal } = require('./batcher');

const validId = (v) => v !== undefined && v !== null && String(v) !== '' && String(v) !== '0';
const sha = (x) => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 24);
// Cut a string to at most n UTF-16 units WITHOUT splitting an emoji: a lone surrogate makes the site's database
// reject the whole push. Control characters are dropped too.
function clip(str, n) {
  const chars = Array.from(String(str || '').replace(/[\u0000-\u001f\u007f]/g, '').trim());
  let out = '';
  for (const c of chars) {
    if (c.length === 1 && c >= '\uD800' && c <= '\uDFFF') continue;   // a lone surrogate straight from TikTok
    if (out.length + c.length > n) break;
    out += c;
  }
  return out;
}

const RETRY_BACKOFF_MS = [10000, 20000, 40000, 80000, 120000];
const RATE_LIMIT_MIN_MS = 60000;
const RATE_LIMIT_MAX_MS = 30 * 60000;
const CONNECTING_TIMEOUT_MS = 90000;
const SILENT_SOCKET_MS = 120000;
const FORCED_RECONNECT_GAP_MS = 300000;
const WATCHDOG_EVERY_MS = 5000;
const STABLE_MS = 60000;               // connected this long = healthy: the error backoff starts over
const UNSTABLE_DROP_MAX_MS = 40000;    // a room that keeps dropping right after connecting: back off, but not for long
const ENDED_ROOM_MS = 15 * 60000;      // how long TikTok may still offer a LIVE's room after it ended
const PROBATION_MS = 20000;            // an ended room has this long to show real LIVE data
const OFFLINE_POLL_MAX_MS = 300000;
// Finding the LIVE's room ID ("lookup") is what TikTok blocks or rate-limits per network. When it refuses, back off
// 30 s -> 1 -> 2 -> 5 min (with jitter, so many PCs don't retry in step), and remember the failure across restarts:
// restarting the app must not retry at once (restarts and fast retries are what get a network blocked).
const BLOCKED_BACKOFF_MS = [30000, 60000, 120000, 300000];
const NOT_FOUND_RETRY_MS = 300000;     // TikTok says the account doesn't exist: check rarely
const RESTART_HOLD_MS = 120000;        // no lookup within 2 min of the last refused one, even after a restart
const ROOM_CACHE_MS = 12 * 3600000;    // a LIVE's room ID is reused (no lookup) for reconnects during that LIVE
const LOOKUP_KEY = 'tiktokLookupFail', CACHE_KEY = 'tiktokRoomCache', MANUAL_KEY = 'tiktokManualRoom';

// Why "Failed to retrieve Room ID from all sources" happened. The connector tries the LIVE page, TikTok's API and the
// Euler sign server, and attaches each source's error:
//   not_found = TikTok's API says the account doesn't exist (wrong or changed username, banned account);
//   offline   = the account exists but has no LIVE room right now (it simply isn't LIVE);
//   blocked   = captcha / blocked page / HTTP 403-429 / timeouts: TikTok is refusing lookups from this network.
function classifyLookup(e) {
  const subs = (e && e.config && Array.isArray(e.config.requestErrs)) ? e.config.requestErrs : [];
  const msg = String((e && e.message) || e);
  if (!subs.length && !/Room ID from all sources/i.test(msg)) return null;
  const text = subs.map((x) => String((x && x.message) || x)).join(' | ') || msg;
  if (/user_not_found|19881007/i.test(text)) return 'not_found';
  if (/Failed to extract Room ID from (HTML|API)/i.test(text)) return 'offline';
  return 'blocked';
}

// A pasted LIVE link or room ID -> { roomId } | { shortLink } | { error }. `handle` is the @name in a full link, if any.
function parseRoomInput(text) {
  const s = String(text || '').trim();
  if (!s) return { error: 'empty' };
  if (/^\d{15,22}$/.test(s)) return { roomId: s };
  let url;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return { error: 'not_a_link' }; }
  if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) return { error: 'not_tiktok' };
  const handle = (url.pathname.match(/\/@([A-Za-z0-9._]{2,24})/) || [])[1] || null;
  const room = url.searchParams.get('room_id') || url.searchParams.get('roomId') || (url.pathname.match(/\/live\/(\d{15,22})/) || [])[1];
  if (room && /^\d{15,22}$/.test(room)) return { roomId: room, handle: handle && handle.toLowerCase() };
  if (/^(vm|vt)\.tiktok\.com$/i.test(url.hostname) || /^\/t\//.test(url.pathname)) return { shortLink: url.toString() };
  return { error: 'no_room_id', handle: handle && handle.toLowerCase() };
}

function loadConnector() {
  // Lazy so tests can inject a fake without loading the real library.
  const L = require('tiktok-live-connector');
  // The sign-server call has no timeout of its own: a stuck one used to hold the whole connect until our cutoff.
  // Set before the first connection creates (and caches) its client.
  try { if (L.SignConfig && L.SignConfig.baseOptions && !L.SignConfig.cachedInstance) L.SignConfig.baseOptions.timeout = 20000; } catch {}
  return L;
}

class TikTokLink extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.lib = opts.lib || null;                 // { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError, SignatureRateLimitError }
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());                       // wall clock: only for retryAt display
    this.mono = opts.mono || opts.now || (() => performance.now());  // steady clock for every interval check
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.setInterval = opts.setInterval || setInterval;
    this.clearInterval = opts.clearInterval || clearInterval;
    this.signApiKey = opts.signApiKey || null;
    // Small key/value store that survives restarts (the app's settings file): refused lookups, the room cache and
    // a pasted room. Tests pass a plain object.
    this.persist = opts.persist || { get: () => undefined, set: () => {} };
    this.random = opts.random || Math.random;
    this.lookupStep = 0;                     // position in BLOCKED_BACKOFF_MS
    this.roomSource = null;                  // 'manual' | 'cache' | null: where the current attempt's room ID came from
    this.username = null;
    this.offlinePollMs = 30000;
    this.conn = null;
    this.generation = 0;
    this.retryStep = 0;
    this.reconnectTimer = null;
    this.connectStartedAt = 0;
    this.lastFrameAt = 0;
    this.lastForcedReconnectAt = -Infinity;   // the steady clock starts near 0: 0 would block the first 5 minutes
    this.upSince = 0;                         // when the current connection came up (steady clock)
    this.endedRoom = null;                    // { id, at } the LIVE TikTok last said ended
    this.endedHits = 0;                       // times in a row TikTok handed that ended room out again
    this.probation = null;                    // { roomId, until } connected to that room, waiting for LIVE data
    this.watchdog = null;
    this.state = { status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null, wrongOwner: null };
    this.giftStreaks = new Map();   // combo base key -> { seq, last, ended, at }
    this.giftMsgs = new Map();      // msgId of single gifts already seen -> at
  }

  get running() { return !!this.username; }

  setOfflinePoll(ms) { this.offlinePollMs = Math.max(10000, Number(ms) || 30000); }

  start(username) {
    const u = String(username || '').trim().replace(/^@/, '').toLowerCase();
    if (!u) return this.stop();
    if (u === this.username && this.state.status !== 'idle') return;   // already on it
    this.stop();
    this.username = u;
    this.retryStep = 0;
    if (!this.watchdog) this.watchdog = this.setInterval(() => this._tick(), WATCHDOG_EVERY_MS);
    // A lookup TikTok refused shortly before (this run or before a restart): wait out the hold instead of asking again.
    const f = this.persist.get(LOOKUP_KEY);
    if (f && f.username === u && Number(f.at) > 0) {
      const age = this.now() - Number(f.at);
      if (age < 30 * 60000) this.lookupStep = Math.min(Number(f.step) || 0, BLOCKED_BACKOFF_MS.length - 1);
      const holdUntil = Math.max(Number(f.at) + RESTART_HOLD_MS, Number(f.retryAt) || 0);
      if (['blocked', 'not_found', 'rate-limit'].includes(f.kind) && holdUntil > this.now()) {
        const ms = holdUntil - this.now();
        this.reconnectTimer = this.setTimeout(() => this._connect(), ms);
        this._setState({ status: 'error', roomId: null, viewers: 0, error: this._kindText(f.kind), errorKind: f.kind, retryAt: holdUntil });
        this.log('info', `last TikTok lookup was refused ${Math.round(age / 1000)} s ago (${f.kind}): waiting ${Math.round(ms / 1000)} s before asking again`);
        return;
      }
    }
    this._connect();
  }

  // Short status text for the site's dashboard (last_error); the window words these itself.
  _kindText(kind) {
    if (kind === 'blocked') return 'TikTok is blocking LIVE lookups from this network (room_id_blocked)';
    if (kind === 'not_found') return `TikTok can't find @${this.username} (tiktok_user_not_found)`;
    if (kind === 'rate-limit') return 'TikTok asked LIVE Link to slow down (rate_limited)';
    if (kind === 'wrong_room') return 'The pasted LIVE belongs to another account (manual_room_rejected)';
    return null;
  }

  // ---------------------------------------------------------------- room cache + a pasted room
  _cachedRoom() {
    const c = this.persist.get(CACHE_KEY);
    return c && c.username === this.username && /^\d{6,22}$/.test(String(c.roomId)) && this.now() - Number(c.at) < ROOM_CACHE_MS ? String(c.roomId) : null;
  }
  _clearCache(roomId) {
    const c = this.persist.get(CACHE_KEY);
    if (c && (!roomId || String(c.roomId) === String(roomId))) this.persist.set(CACHE_KEY, null);
  }
  manualRoom() {
    const m = this.persist.get(MANUAL_KEY);
    return m && m.username === this.username && /^\d{6,22}$/.test(String(m.roomId)) ? String(m.roomId) : null;
  }
  // The host pasted their LIVE (room ID): skip the lookup with it until that LIVE ends. null clears it.
  setManualRoom(roomId) {
    this.persist.set(MANUAL_KEY, roomId && this.username ? { username: this.username, roomId: String(roomId), at: this.now() } : null);
    if (roomId && this.username) {
      this.lookupStep = 0;
      this.persist.set(LOOKUP_KEY, null);
      const st = this.state.status;
      if (st !== 'live') this._connect();                          // a waiting or failing link tries it right away
    }
  }

  // Ends the link with NO auto-reconnect. Bumping the generation mutes every callback of the old connection,
  // including its DISCONNECTED handler and a connect() still in flight.
  stop() {
    this.generation++;
    this.username = null;
    this.connectStartedAt = 0;
    this.upSince = 0;
    this.probation = null;
    this.clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.watchdog) { this.clearInterval(this.watchdog); this.watchdog = null; }
    this._dropConnection();
    this._setState({ status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null, wrongOwner: null });
  }

  // Try now (the UI's "Reconnect" button). Never tears down a healthy or in-progress connection, and never
  // jumps a rate-limit wait (each attempt costs a request on the free sign server).
  retryNow() {
    if (!this.username) return;
    const st = this.state.status;
    if (st === 'live' || st === 'connecting' || st === 'reconnecting') return;
    if (this._holding()) return;
    this._connect();
  }

  // A rate-limit or a refused lookup is being waited out (each extra attempt makes TikTok's block last longer).
  _holding() {
    return ['rate-limit', 'blocked'].includes(this.state.errorKind) && this.state.retryAt > this.now();
  }

  // The computer woke from sleep (or was unlocked). A socket that slept through it is usually dead, and the next
  // scheduled check can be minutes away, so look now. After an unlock (no sleep) a LIVE socket that still gets data is
  // left alone. A rate-limit wait is still honoured.
  wake(fromSleep = true) {
    if (!this.username) return;
    if (this._holding()) return;
    const st = this.state.status;
    if (st === 'live' && !fromSleep && this.mono() - this.lastFrameAt < 30000) return;
    this.log('info', `${fromSleep ? 'woke from sleep' : 'screen unlocked'}: checking TikTok now (was ${st})`);
    this._connect();
  }

  _dropConnection() {
    if (!this.conn) return;
    const old = this.conn; this.conn = null;
    try { old.removeAllListeners(); } catch {}
    try { old.on && old.on('error', () => {}); } catch {}
    try { const p = old.disconnect(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch {}
  }

  // One TikTok gift frame -> what to credit. Learned from the T.O.S show program's live gift handling:
  //  * combo gifts (type 1, or combo:true even with type 0) arrive as running frames x1, x2, x3... and one end frame;
  //    each frame credits only what's new, and the site keeps the highest count per combo, so retries, repeats and
  //    app restarts can never count a combo twice;
  //  * a lower count after an end (or after a quiet gap) is a NEW combo that reused the group id;
  //  * gifts sent to another host (multi-guest, battles) and gifts with no coin price are skipped.
  _gift(d) {
    if (!d) return null;
    const gift = d.gift || d.giftDetails || {};
    const name = clip(gift.name || gift.giftName || d.giftName, 60) || 'Gift';
    const coins = Math.floor(Number(gift.diamondCount || d.diamondCount || 0));
    if (!(coins > 0)) { this.log('info', `skipped gift "${name}" with no coin price`); return null; }
    const toUser = d.toUser || {};
    const toName = String(toUser.displayId || toUser.uniqueId || '').replace(/^@/, '').toLowerCase();
    if (toName && this.username && toName !== this.username) { this.log('info', `skipped a gift to @${toName} (not this LIVE's host)`); return null; }
    const u = d.user || {};
    // The site refuses an empty handle, so fall back to the nickname, then a neutral word.
    const rawHandle = clip(String(u.displayId || u.uniqueId || '').replace(/^@/, ''), 60);
    const userName = clip(u.nickname || rawHandle, 80) || 'Someone';
    const userHandle = rawHandle || clip(userName, 60) || 'viewer';
    const userId = String(u.userId || u.id || userHandle);
    const rawGiftId = validId(d.giftId) ? String(d.giftId) : String(gift.id || '');
    const giftId = /^\d{1,24}$/.test(rawGiftId) ? rawGiftId : '0';
    const count = Math.max(1, Math.floor(Number(d.repeatCount) || 1));
    // The site refuses out-of-range values (and the whole batch with them): skip, don't send.
    if (coins > 50000 || count > 100000) { this.log('warn', `skipped an out-of-range gift "${name}" (${coins} coins x${count})`); return null; }
    const img = gift.image || gift.icon || {};
    const imageUrl = Array.isArray(img.urlList) ? (img.urlList.find((x) => /^https:\/\//.test(x) && x.length <= 500) || null) : null;
    const now = this.mono();
    this._pruneGifts(now);
    let key, units;
    if (Number(gift.type) === 1 || gift.combo === true) {
      const hasGroup = validId(d.groupId);
      const base = sha([this.state.roomId || '', userId, rawGiftId, hasGroup ? String(d.groupId) : '']);
      const s = this.giftStreaks.get(base) || { seq: 0, last: 0, ended: false, at: now };
      const endFrame = Number(d.repeatEnd) === 1;
      if (hasGroup) {
        // Real groupIds are unique per combo (millisecond stamps; 0 reuses in 124 real frames): a count at or below
        // what we have is a stale or repeated frame, never a new combo. The end frame usually repeats the last count.
        if (count <= s.last) { if (endFrame) { s.ended = true; s.at = now; this.giftStreaks.set(base, s); } return null; }
      } else if (s.ended) {
        if (count === s.last) return null;                          // the same end frame again
        if (count < s.last) { s.seq += 1; s.last = 0; }             // no group id: a lower count after an end = new combo
        s.ended = false;
      } else if (count <= s.last) {
        if (count === s.last && endFrame) { s.ended = true; s.at = now; this.giftStreaks.set(base, s); return null; }
        if (count < s.last && now - s.at > 3000) { s.seq += 1; s.last = 0; }   // no group id and the end never came
        else return null;                                           // a stale or repeated frame
      }
      units = count - s.last;
      s.last = count; s.ended = Number(d.repeatEnd) === 1; s.at = now;
      this.giftStreaks.set(base, s);
      key = `c:${base}:${s.seq}`;
    } else {
      const msgId = String((d.common && d.common.msgId) || d.logId || d.orderId || '');
      if (validId(msgId) && /^[A-Za-z0-9_.-]{1,100}$/.test(msgId)) {
        if (this.giftMsgs.has(msgId)) return null;                  // the same message delivered twice
        this.giftMsgs.set(msgId, now);
        key = msgId.length >= 6 ? `m:${msgId}` : `m:${sha(['msg', this.state.roomId || '', msgId])}`;   // keys are 8+ chars
      } else {
        key = `m:${sha([this.state.roomId || '', userId, rawGiftId, this.now(), Math.random()])}`;
      }
      units = count;
    }
    return { key, count, units, coins, giftId, name, imageUrl, userHandle, userName, at: this.now() };
  }

  _pruneGifts(now) {
    if (this.giftStreaks.size > 3000) for (const [k, v] of this.giftStreaks) if (now - v.at > 600000) this.giftStreaks.delete(k);
    if (this.giftMsgs.size > 3000) for (const [k, at] of this.giftMsgs) if (now - at > 600000) this.giftMsgs.delete(k);
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    // Only a genuinely different room counts as a new session (a reconnect to the same room keeps its totals).
    if (this.state.roomId && this.state.roomId !== this.lastRoomId) {
      this.lastRoomId = this.state.roomId;
      this.emit('roomChanged', this.state.roomId);
    }
    this.emit('state', { ...this.state });
  }

  _nextBackoff() { return RETRY_BACKOFF_MS[Math.min(this.retryStep++, RETRY_BACKOFF_MS.length - 1)]; }

  _schedule(ms) {
    this.clearTimeout(this.reconnectTimer);
    const at = this.now() + ms;
    this.reconnectTimer = this.setTimeout(() => this._connect(), ms);
    return at;
  }

  // Why a connect attempt failed, and how long to wait before the next one.
  _classify(e) {
    const L = this.lib || {};
    const msg = String((e && e.message) || e);
    if (e && e.timeout) return { kind: 'timeout', ms: this._nextBackoff() };
    if ((L.UserOfflineError && e instanceof L.UserOfflineError) || /isn'?t online|is not online|user is offline/i.test(msg)) {
      this.retryStep = 0;
      return { kind: 'offline', ms: this.offlinePollMs };
    }
    // tiktok-live-connector 2.4.4 builds SignatureRateLimitError from the 429 response BODY, so reading its
    // retry-after header can itself throw a TypeError that mentions 'retry-after'. Both mean "slow down".
    if ((L.SignatureRateLimitError && e instanceof L.SignatureRateLimitError) || (e && e.reason === 'Rate Limited') || /rate.?limit|too many connections|retry-after|\b429\b/i.test(msg)) {
      let wait = Number(e && e.retryAfter) > 0 ? Number(e.retryAfter) : 0;
      const reset = Number(e && e.resetTime);
      if (reset > this.now()) wait = Math.max(wait, reset - this.now());
      return { kind: 'rate-limit', ms: Math.min(RATE_LIMIT_MAX_MS, Math.max(wait, RATE_LIMIT_MIN_MS, this._nextBackoff())) };
    }
    return { kind: 'error', ms: this._nextBackoff() };
  }

  _jitter(ms) { return Math.round(ms * (0.8 + 0.4 * this.random())); }   // +-20%

  _failed(e, source = null) {
    let msg = String((e && e.message) || e).slice(0, 500);   // sign-server errors can carry a whole HTML page
    const lookup = classifyLookup(e);
    if (lookup) {
      const subs = (e.config && e.config.requestErrs || []).map((x) => String((x && x.message) || x).slice(0, 160)).join(' | ');
      if (subs) msg = `${msg} [${subs}]`.slice(0, 500);
    }
    // A remembered room ID that no longer works (that LIVE ended, or TikTok won't open it): forget it and look the room
    // up again right away. A pasted room whose LIVE ended is dropped too.
    if (source === 'cache') { this._clearCache(); this.log('info', `the remembered room no longer works (${msg.slice(0, 120)}); looking it up again`); this._schedule(1000); return; }
    let f;
    if (lookup === 'offline') { this.retryStep = 0; this.lookupStep = 0; f = { kind: 'offline', ms: this.offlinePollMs }; }
    else if (lookup === 'blocked') {
      f = { kind: 'blocked', ms: this._jitter(BLOCKED_BACKOFF_MS[Math.min(this.lookupStep, BLOCKED_BACKOFF_MS.length - 1)]) };
      this.lookupStep++;
    } else if (lookup === 'not_found') f = { kind: 'not_found', ms: this._jitter(NOT_FOUND_RETRY_MS) };
    else f = this._classify(e);
    if (f.kind === 'offline' && source === 'manual') { this.persist.set(MANUAL_KEY, null); this.log('info', 'the pasted LIVE has ended; it is cleared'); }
    this.connectStartedAt = 0;
    const retryAt = this._schedule(f.ms);
    const human = this._kindText(f.kind);
    if (['blocked', 'not_found', 'rate-limit'].includes(f.kind)) {
      this.persist.set(LOOKUP_KEY, { username: this.username, at: this.now(), kind: f.kind, step: this.lookupStep, retryAt });
    } else if (f.kind === 'offline' && this.persist.get(LOOKUP_KEY)) this.persist.set(LOOKUP_KEY, null);   // no settings write every poll
    this._setState({ status: f.kind === 'offline' ? 'offline' : 'error', roomId: null, viewers: 0, error: f.kind === 'offline' ? null : (human || msg), errorKind: f.kind, retryAt });
    this.log(f.kind === 'offline' ? 'info' : 'warn', `TikTok connect: ${f.kind}${f.kind === 'offline' ? '' : ' - ' + msg}; next try in ${Math.round(f.ms / 1000)} s`);
  }

  async _connect() {
    if (!this.username) return;
    if (!this.lib) this.lib = loadConnector();
    const L = this.lib;
    const generation = ++this.generation;
    this.streamEnded = false;
    this.probation = null;
    this.upSince = 0;
    this.clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    this._dropConnection();
    this.lastFrameAt = this.mono();
    this.connectStartedAt = this.mono();
    // Skip the lookup TikTok rate-limits when the room is already known: a pasted room, or this LIVE's room from the
    // last connection (a reconnect after a drop then needs no lookup at all).
    const manual = this.manualRoom(), cached = manual ? null : this._cachedRoom();
    let source = manual ? 'manual' : cached ? 'cache' : null;   // 'euler' = a room the sign server found (not checked live)
    this.roomSource = source;
    this._setState({ status: this.state.status === 'live' ? 'reconnecting' : 'connecting', error: null, errorKind: null, retryAt: null, wrongOwner: null });

    const conn = new L.TikTokLiveConnection(this.username, {
      // Never replay the backlog TikTok hands over on connect: those likes happened before we were listening.
      processInitialData: false,
      enableExtendedGiftInfo: false,
      fetchRoomInfoOnConnect: true,
      // got retries each TikTok call twice by default (10 s each): one retry keeps a connect inside our cutoff.
      webClientOptions: { retry: { limit: 1 } },
      ...(this.signApiKey ? { signApiKey: this.signApiKey } : {}),
    });
    this.conn = conn;
    const on = (event, cb) => { if (event) conn.on(event, (...a) => { if (generation === this.generation) cb(...a); }); };
    const C = L.ControlEvent || {}, W = L.WebcastEvent || {};
    // Real LIVE data (viewers, taps, gifts) clears a room on probation.
    const confirm = () => { if (this.probation) this._confirmRoom(); };

    on(C.WEBSOCKET_DATA, () => { this.lastFrameAt = this.mono(); });
    on(C.CONNECTED, (s) => {
      this.lastFrameAt = this.mono();
      this.connectStartedAt = 0;
      const roomId = (s && s.roomId) ? String(s.roomId) : null;
      if (source === 'manual') {
        // A pasted room must be this host's own LIVE: crediting another account's taps is never allowed.
        const ri = conn.roomInfo || (s && s.roomInfo) || {};
        const owner = String((ri.data && ri.data.owner && (ri.data.owner.display_id || ri.data.owner.unique_id)) || (ri.owner && ri.owner.display_id) || '').replace(/^@/, '').toLowerCase();
        if (owner !== this.username) { this._rejectManual(owner); return; }
      }
      if (source === 'cache' || source === 'euler') {
        // A room nobody confirmed is LIVE right now: a remembered one (its LIVE may have ended while LIVE Link wasn't
        // watching) or one only the sign server knew. TikTok opens dead and even made-up room IDs without an error,
        // so it counts as LIVE only once real LIVE data arrives. A dead remembered room is forgotten and looked up
        // fresh; a dead sign-server room means "not LIVE".
        this.probation = { roomId, until: this.mono() + PROBATION_MS, fromCache: source === 'cache' };
        this.log('info', `opened ${source === 'cache' ? 'the remembered' : "the sign server's"} room ${roomId}; waiting for LIVE data`);
        return;
      }
      const E = this.endedRoom;
      if (roomId && E && E.id === roomId && this.mono() - E.at < ENDED_ROOM_MS) {
        // The LIVE that just ended, handed out again: stay "connecting" until real LIVE data shows it is back.
        this.probation = { roomId, until: this.mono() + PROBATION_MS };
        this.log('info', `TikTok offered @${this.username}'s ended LIVE again (room ${roomId}); waiting for LIVE data`);
        return;
      }
      this._goLive(roomId);
    });
    on(C.DISCONNECTED, () => {
      const wasProbation = !!this.probation;
      if (wasProbation && this.probation.fromCache && !this.streamEnded) { this._cacheFailed('it closed before any LIVE data'); return; }
      if (this.streamEnded || wasProbation) {
        this.streamEnded = false;
        this._notLive(wasProbation ? 'the ended LIVE closed again' : null);
        return;
      }
      const stable = this.upSince && this.mono() - this.upSince >= STABLE_MS;
      this.upSince = 0;
      let ms;
      if (stable) { this.retryStep = 1; ms = RETRY_BACKOFF_MS[0]; }   // a real drop of a LIVE room: 10 s, then the normal backoff
      else ms = Math.min(UNSTABLE_DROP_MAX_MS, this._nextBackoff());  // it keeps dropping right after connecting
      const retryAt = this._schedule(ms);
      this._setState({ status: 'reconnecting', retryAt });
      this.log('info', `Disconnected from @${this.username}; retrying in ${Math.round(ms / 1000)} s`);
    });
    on(C.ERROR, (e) => this.log('warn', `${(e && e.info) || 'connector'}: ${(e && e.exception && e.exception.message) || (e && e.message) || String(e)}`));
    // TikTok says the LIVE ended (or was suspended); the connector disconnects right after. Report 'offline' at
    // once instead of a reconnect attempt, so the app neither cries "lost" nor dates the end 10-20 s late.
    on(W.STREAM_END, () => {
      this.streamEnded = true;
      const id = this.state.roomId || (this.probation && this.probation.roomId);
      if (id) {
        this.endedRoom = { id: String(id), at: this.mono() };
        this._clearCache(id);                                         // a finished LIVE's room is never reused
        if (this.manualRoom() === String(id)) this.persist.set(MANUAL_KEY, null);
      }
      this.log('info', 'TikTok says the LIVE ended');
    });
    on(W.ROOM_USER, (d) => {
      confirm();
      const v = Number((d && (d.viewerCount || d.total || d.totalUser)) || 0);
      if (v !== this.state.viewers) this._setState({ viewers: v });
    });
    on(W.GIFT, (d) => { confirm(); const g = this._gift(d); if (g) this.emit('gift', g); });
    on(W.LIKE, (d) => {
      confirm();
      // tiktok-live-proto v3 (what 2.4.4 decodes): count = taps in this batch, total = room total as a STRING.
      // Older/other shapes use likeCount / totalLikeCount; read both.
      // v3 DEFAULTS total to "0" when the wire omits it: a total of 0 (or below this batch) means "no total".
      const count = Math.max(0, Math.floor(Number(d && (d.count ?? d.likeCount)) || 0));
      const t = usableTotal(d && (d.total ?? d.totalLikeCount), count);
      const total = t === null ? NaN : t;
      if (count > 0 || t !== null) this.emit('like', { count, total, at: this.now() });
    });

    try {
      let roomId = manual || cached || undefined;
      if (!roomId && L.fetchRoomInfoFromHtmlRoute) {
        const look = await this._lookup(conn, L);
        if (generation !== this.generation) return;
        if (look.live === false) throw new (L.UserOfflineError || Error)("The requested user isn't online :(");
        roomId = look.roomId;
        if (look.live === null) { source = 'euler'; this.roomSource = 'euler'; }
      }
      await conn.connect(roomId);
      if (generation !== this.generation) { try { conn.disconnect(); } catch {} }
    } catch (e) {
      if (generation !== this.generation) return;
      this._failed(e, source);
    }
  }

  // Finds the LIVE's room AND whether it is live, before any connection: TikTok's LIVE page (one request, what the
  // connector itself asks first), then TikTok's API. The connector's own check can't be trusted: for an ended room
  // TikTok's room-info call now answers an error with no status (4003110), so the connector "connects" to a LIVE that
  // is over. Last resort when both are refused: the Euler sign server (it runs elsewhere, so a network TikTok blocks
  // doesn't matter), which knows the room but not whether it's live -> { live: null }, confirmed by LIVE data.
  // Returns { roomId, live: true | false | null }; throws a lookup error (see classifyLookup) when every source fails.
  async _lookup(conn, L) {
    const errs = [];
    const read = (r) => {
      const d = (r && r.data) || r || {};
      const u = d.user || {}, room = d.liveRoom || {};
      const status = Number(room.status !== undefined ? room.status : u.status);
      return { roomId: u.roomId ? String(u.roomId) : null, status };
    };
    for (const route of [L.fetchRoomInfoFromHtmlRoute, L.fetchRoomInfoFromApiLiveRoute]) {
      if (!route) continue;
      try {
        const s = read(await route({ webClient: conn.webClient, uniqueId: this.username }));
        // 4 = the LIVE is over; no room ID = the account has no LIVE room (never went LIVE).
        return { roomId: s.roomId, live: !!s.roomId && s.status !== 4 };
      } catch (e) {
        errs.push(e);
        if (/user_not_found|19881007/i.test(String(e && e.message))) break;   // the account doesn't exist: stop here
      }
    }
    if (L.fetchRoomIdFromEulerRoute && !errs.some((e) => /user_not_found|19881007/i.test(String(e && e.message)))) {
      try {
        const r = await L.fetchRoomIdFromEulerRoute({ webClient: conn.webClient, apiClient: conn.apiClient, uniqueId: this.username });
        if (r && r.ok && r.room_id) return { roomId: String(r.room_id), live: null };
        errs.push(new Error(`[euler] ${(r && r.message) || 'no room id'}`));
      } catch (e) { errs.push(e); }
    }
    const e = new Error('Failed to retrieve Room ID from all sources.');
    e.config = { routeId: 'liveLinkLookup', requestErrs: errs };
    throw e;
  }

  // The pasted room belongs to someone else (or its owner can't be read): drop it and go back to the normal lookup.
  _rejectManual(owner) {
    this.generation++;
    this._dropConnection();
    this.connectStartedAt = 0;
    this.persist.set(MANUAL_KEY, null);
    const retryAt = this._schedule(5000);
    this._setState({ status: 'error', roomId: null, viewers: 0, error: this._kindText('wrong_room'), errorKind: 'wrong_room', wrongOwner: owner || null, retryAt });
    this.log('warn', `the pasted room belongs to ${owner ? '@' + owner : 'an unknown account'}, not @${this.username}: ignored`);
  }

  _goLive(roomId) {
    this.probation = null;
    this.upSince = this.mono();
    if (roomId && (!this.endedRoom || this.endedRoom.id !== roomId)) { this.endedRoom = null; this.endedHits = 0; }
    // Remember this LIVE's room (reconnects skip the lookup) and forget any refused lookup.
    if (roomId) {
      const c = this.persist.get(CACHE_KEY);
      if (!c || c.roomId !== roomId || c.username !== this.username) this.persist.set(CACHE_KEY, { username: this.username, roomId, at: this.now() });
    }
    this.lookupStep = 0;
    if (this.persist.get(LOOKUP_KEY)) this.persist.set(LOOKUP_KEY, null);
    this._setState({ status: 'live', roomId, error: null, errorKind: null, retryAt: null });
    this.log('info', `Connected to @${this.username} room ${this.state.roomId}`);
  }

  // The room on probation showed real LIVE data: it is LIVE again after all.
  _confirmRoom() {
    const id = this.probation.roomId;
    this.endedRoom = null; this.endedHits = 0;
    this.log('info', `room ${id} is LIVE again`);
    this._goLive(id);
  }

  // The remembered room turned out dead: forget it and look the room up fresh in a second (stays "connecting").
  _cacheFailed(why) {
    this.generation++;                            // mute the dead connection
    this._dropConnection();
    this.connectStartedAt = 0; this.upSince = 0; this.probation = null;
    this._clearCache();
    this.log('info', `the remembered room is not LIVE (${why}); looking the room up again`);
    this._schedule(1000);
  }

  // The LIVE is over: report 'offline' and check again later. `again` = TikTok handed out the ended room again, so
  // each repeat waits twice as long (capped at 5 min) instead of looping every check.
  _notLive(again) {
    this.generation++;                            // mute the old connection (its disconnect would call back here)
    this._dropConnection();
    this.connectStartedAt = 0; this.upSince = 0; this.probation = null;
    this.retryStep = 0;
    let ms = this.offlinePollMs;
    if (again) { this.endedHits++; ms = Math.min(OFFLINE_POLL_MAX_MS, this.offlinePollMs * 2 ** this.endedHits); }
    const retryAt = this._schedule(ms);
    this._setState({ status: 'offline', roomId: null, viewers: 0, error: null, errorKind: 'offline', retryAt });
    this.log('info', again ? `@${this.username} is not LIVE (${again}); checking again in ${Math.round(ms / 1000)} s`
      : `@${this.username}'s LIVE ended; checking again in ${Math.round(ms / 1000)} s`);
  }

  _tick() {
    const now = this.mono();
    if (!this.username) return;
    if (this.probation && now > this.probation.until) {
      if (this.probation.fromCache) this._cacheFailed('no LIVE data from it');
      else this._notLive('no LIVE data from the ended room');
      return;
    }
    if (this.state.status === 'live' && this.upSince && this.retryStep && now - this.upSince >= STABLE_MS) this.retryStep = 0;
    if (this.state.status === 'live' && this.lastFrameAt && now - this.lastFrameAt > SILENT_SOCKET_MS && now - this.lastForcedReconnectAt > FORCED_RECONNECT_GAP_MS) {
      this.lastForcedReconnectAt = now;
      this.log('warn', `No data from TikTok for ${Math.round((now - this.lastFrameAt) / 1000)} s - reconnecting once`);
      this._connect();
      return;
    }
    if ((this.state.status === 'connecting' || this.state.status === 'reconnecting') && this.connectStartedAt && now - this.connectStartedAt > CONNECTING_TIMEOUT_MS) {
      const secs = Math.round((now - this.connectStartedAt) / 1000);
      this.generation++;                           // mute the hung attempt
      this._dropConnection();
      this._failed({ timeout: true, message: `TikTok did not answer for ${secs} s` });
    }
  }
}

module.exports = { TikTokLink, classifyLookup, parseRoomInput, RETRY_BACKOFF_MS, RATE_LIMIT_MIN_MS, CONNECTING_TIMEOUT_MS, SILENT_SOCKET_MS, BLOCKED_BACKOFF_MS, NOT_FOUND_RETRY_MS, RESTART_HOLD_MS };
