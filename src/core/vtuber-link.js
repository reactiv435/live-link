'use strict';
// 2.1.2: passes the TikTok LIVE's gifts, likes, comments, follows and shares to a VTuber running on THIS computer, so
// the host's avatar can react. The host does nothing: when a VTuber is listening it just works, when none is, nothing
// happens. The contract (fixed; the VTuber side is built to it):
//   POST http://127.0.0.1:<port>/api/tiktok-event   Content-Type: application/json, X-LiveLink-Event: 1
//        { v: 1, type: gift|like|comment|follow|share, name, gift, coins, count, text, at }
//        name <= 40 chars (the viewer's display name), gift = the gift's name, coins = diamonds per gift,
//        count = the combo's gifts or the taps, text = the comment (<= 150 chars), at = ms epoch; unused fields null
//   GET  the same path answers 200 { ok: true, v: 1 } while a VTuber is listening.
// Rules:
//  * Only 127.0.0.1 (never a host name, never a proxy). Names and comment text go nowhere else: not to the site, not to
//    the log, not to the disk. This file makes no other request of any kind.
//  * Only while a TikTok LIVE is connected: it asks (GET) right away and then every 15 s, and sends only while the last
//    answer was "ok". A send that fails stops the sending until the next ask succeeds. With no VTuber running, all this
//    costs is one refused local connection every 15 s.
//  * Gifts: one event per finished combo (its end frame) or per single gift, with the final count. A combo whose end
//    frame never arrives goes out after 5 s without a frame. Likes are summed and go out at most 4 times a second.
//  * At most 20 gifts and 10 other events a second (the VTuber's own limits) and 8 requests at a time; anything over
//    is dropped, never queued. Nothing is retried: a late effect is worse than none.
//  * Every listener is wrapped: nothing in here can throw into the TikTok feed, the gift crediting, the taps, the
//    recording or the clips.
// 2.2.0: the VTuber can also run INSIDE LIVE Link (the VTuber card). While it does, events are handed to it inside the
// app (opts.direct() returns a function that takes one event; core/vtuber-host.js) and nothing is asked or sent over
// HTTP. Every rule above stays: the same events, the same caps, only while a LIVE is connected. When no VTuber runs
// inside the app, the HTTP way is used exactly as in 2.1.2 (the desktop-shortcut VTuber on the host's own computer).
// opts.http === false (test runs) switches the HTTP way off altogether.
// V8 (the puppet show; the VTuber repo's V8-PHASE2.md, section C): contract v2.
//  * C1: an event also says who the viewer is: { v: 2, ..., handle, uid, avatar }. handle = the @id without '@'
//    (<= 40, A-Z a-z 0-9 . _), uid = TikTok's user id as digits (<= 30) or null, avatar = an https picture address on an
//    allowed TikTok picture server (pictures.js) or null. The picture address goes to the VTuber on this computer only.
//  * C3 `show` (sendShow: the song on air, its cover, the hype rank, the host's grade; built by show-feed.js) and
//    C4 `control` (sendControl: a global key pressed in LIVE Link) travel the same two ways, with their own small cap.
//  * Only to a VTuber that speaks v2: the in-app one says so (direct().v >= 2), the HTTP one in its GET answer (v >= 2).
//    A v1 VTuber (an older desktop-shortcut copy) gets exactly the 2.1.2 / 2.2.0 events and no show / control.
//  * v2 taps: each like event names ONE viewer with their OWN taps (a boss-fight missile carries their picture, and the
//    fight's top 3 must be true). Still at most 4 like sends a second: the viewer with the most waiting taps goes first;
//    taps that waited 3 s (a big room) go out summed as one event with no viewer on it, so the total is never lost.
const http = require('http');
const { clip } = require('./tiktok-link');
const { cleanPictureUrl, cleanUid, cleanHandle, TIKTOK_PICTURE_HOSTS } = require('./pictures');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8791;
const PATH = '/api/tiktok-event';
const TYPES = ['gift', 'like', 'comment', 'follow', 'share'];
const PROBE_EVERY_MS = 15000;
const PROBE_TIMEOUT_MS = 3000;          // a refused local connection takes ~2 s to fail on Windows
const SEND_TIMEOUT_MS = 2000;
const LIKE_EVERY_MS = 250;              // at most 4 like sends a second
const COMBO_QUIET_MS = 5000;            // a combo with no frame for this long is over, end frame or not
const MAX_IN_FLIGHT = 8;
const RATE_PER_S = { gift: 20, other: 10 };
const FOLLOW_REPEAT_MS = 10 * 60000;    // a follow-unfollow-follow loop shows once
const TOLD_MAX = 2000;
const CROWD_AFTER_MS = 3000;            // v2 taps: a viewer's taps that waited this long go out summed, with no viewer on them
const TAPPERS_MAX = 300;                // v2 taps: viewers with waiting taps kept at once (the rest are summed)
const SIDE_PER_S = 6;                   // show + control messages a second (their own cap, never the viewers' events')
const PUPPET_MOVES = ['goo', 'fire', 'melt', 'crack', 'eat'];
const CONTROL_ACTIONS = ['puppet', 'fight', 'vote'];

// One event in the contract's shape, every field clipped; null when there is nothing to send.
// v = 2 adds who the viewer is (handle, uid, avatar), each checked again here; v = 1 is the 2.1.2 event, field for field.
function buildEvent(type, x = {}, at = Date.now(), v = 1) {
  if (!TYPES.includes(type)) return null;
  const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : null; };
  const t = Math.floor(Number(at));
  const ev = { v: 1, type, name: clip(x.name, 40) || 'Someone', gift: null, coins: null, count: null, text: null, at: t > 0 ? t : Date.now() };
  if (type === 'gift') {
    ev.gift = clip(x.gift, 60) || 'Gift';
    ev.coins = int(x.coins, 1000000);
    ev.count = int(x.count, 100000) || 1;
  } else if (type === 'like') {
    ev.count = int(x.count, 100000);
    if (!ev.count) return null;
  } else if (type === 'comment') {
    ev.text = clip(String(x.text || '').replace(/\s+/g, ' '), 150);
    if (!ev.text) return null;
  }
  if (v === 2) {
    ev.v = 2;
    ev.handle = cleanHandle(x.handle);
    ev.uid = cleanUid(x.uid);
    ev.avatar = cleanPictureUrl(x.avatar, TIKTOK_PICTURE_HOSTS);
  }
  return ev;
}

/** C4: { v: 2, type: 'control', action, name, at } or null. name = the move for 'puppet', '' otherwise. */
function buildControl(action, name, at = Date.now()) {
  if (!CONTROL_ACTIONS.includes(action)) return null;
  if (action === 'puppet' && !PUPPET_MOVES.includes(name)) return null;
  const t = Math.floor(Number(at));
  return { v: 2, type: 'control', action, name: action === 'puppet' ? name : '', at: t > 0 ? t : Date.now() };
}

// who a local event is from, in the v2 event's words (a v1 event ignores them)
const whoOf = (x) => ({ handle: x.handle || x.userHandle, uid: x.userId, avatar: x.avatar });

class VtuberLink {
  constructor(opts = {}) {
    this.port = Number(opts.port) || DEFAULT_PORT;
    this.http = opts.http !== false;
    this.direct = typeof opts.direct === 'function' ? opts.direct : null;   // () -> fn(ev) while a VTuber runs in the app, else null
    this.log = opts.log || (() => {});
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;   // V8: live / found / lost changed
    this.now = opts.now || (() => Date.now());
    this.mono = opts.mono || (() => performance.now());
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.probeEveryMs = opts.probeEveryMs || PROBE_EVERY_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs || PROBE_TIMEOUT_MS;
    this.sendTimeoutMs = opts.sendTimeoutMs || SEND_TIMEOUT_MS;
    this.likeEveryMs = opts.likeEveryMs || LIKE_EVERY_MS;
    this.comboQuietMs = opts.comboQuietMs || COMBO_QUIET_MS;
    this.crowdAfterMs = opts.crowdAfterMs || CROWD_AFTER_MS;
    // No keep-alive (Node's default agent keeps sockets): a socket the VTuber closed must never fail the next send.
    this.agent = new http.Agent({ keepAlive: false, maxSockets: MAX_IN_FLIGHT });
    this.live = false;              // a TikTok LIVE is connected
    this.ok = false;                // the last ask found a VTuber listening: sends allowed
    this.peerV = 1;                 // the contract version the HTTP VTuber said it speaks (its GET answer)
    this.tappers = new Map();       // v2 taps: viewer key -> { count, name, handle, uid, avatar, at }
    this.crowd = 0;                 // v2 taps: taps that waited too long, to go out summed
    this.tapTimer = null; this.lastTapNamed = false;
    this.side = { at: -Infinity, n: 0 };   // show + control: their own cap
    this.said = null;               // the last thing logged: 'found' | 'lost' | null (one line per change)
    this.probing = false;
    this.probeTimer = null;
    this.inFlight = 0;
    this.likes = null;              // { count, name, timer } taps waiting for the next like send
    this.lastLikeAt = -Infinity;
    this.combos = new Map();        // combo key -> { at, g }: running combos (from 'gift' frames)
    this.told = new Map();          // combo key -> count already sent (a combo that goes on after its end sends only more)
    this.sweepTimer = null;
    this.follows = new Map();       // viewer -> when their follow was sent (memory only)
    this.rate = { gift: { at: -Infinity, n: 0 }, other: { at: -Infinity, n: 0 } };
    this.stats = { probes: 0, sent: 0, failed: 0, dropped: 0, direct: 0, show: 0, control: 0 };
    this.failedListener = new Set();
    this.stopped = false;
  }

  // Listens to a TikTokLink. Registered after the controller, so the site's gift and like handling runs first.
  attach(link) {
    const on = (event, fn) => link.on(event, (x) => {
      if (this.stopped) return;
      try { fn(x); } catch (e) {
        if (!this.failedListener.has(event)) { this.failedListener.add(event); this.log('warn', `VTuber link: ${event} skipped (${(e && e.name) || 'error'})`); }
      }
    });
    on('state', (st) => this._state(st || {}));
    on('roomChanged', () => this._newRoom());
    on('gift', (g) => this._giftFrame(g));
    on('giftEnd', (g) => this._giftEnd(g));
    on('like', (l) => this._like(l));
    on('comment', (c) => this._send('comment', { name: c.name, text: c.text, ...whoOf(c) }, c.at));
    on('follow', (f) => this._follow(f));
    on('share', (s) => this._send('share', { name: s.name, ...whoOf(s) }, s.at));
    this.pictures = link.pictures && typeof link.pictures.line === 'function' ? link.pictures : null;
    try { this._state(link.state || {}); } catch {}
    return this;
  }

  stop() {
    this.stopped = true;
    this._idle();
    try { this.agent.destroy(); } catch {}
  }

  // ---------------------------------------------------------------- is a VTuber listening?
  _state(st) {
    const live = st.status === 'live';
    if (live === this.live) return;
    this.live = live;
    if (live) this._probeLoop();
    else {
      this._idle();                // the LIVE ended or dropped: ask again when it is back (no log line)
      // V8: which picture-server families this LIVE's viewers used (family names and counts only: no address, no viewer)
      try { const line = this.pictures && this.pictures.line(); if (line) { this.log('info', `VTuber link: ${line}`); this.pictures.reset(); } } catch {}
    }
    this._changed();
  }

  _changed() { if (this.onChange) { try { this.onChange(); } catch {} } }

  /** the contract version the listening VTuber speaks: 2 = it takes who the viewer is, `show` and `control` */
  _v(inApp) { return inApp ? (Number(inApp.v) >= 2 ? 2 : 1) : (this.ok && this.peerV >= 2 ? 2 : 1); }

  _idle() {
    this.live = false;
    this.ok = false;
    this.clearTimeout(this.probeTimer); this.probeTimer = null;
    if (this.likes) { this.clearTimeout(this.likes.timer); this.likes = null; }
    this.clearTimeout(this.tapTimer); this.tapTimer = null; this.tappers.clear(); this.crowd = 0;
    this.clearTimeout(this.sweepTimer); this.sweepTimer = null;
    this.combos.clear();
  }

  _newRoom() { this.told.clear(); this.combos.clear(); this.follows.clear(); }

  _later(fn, ms) {
    const t = this.setTimeout(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();   // never keeps LIVE Link from quitting
    return t;
  }

  _probeLoop() {
    this.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (!this.live || this.stopped) return;
    this._probe();
    this.probeTimer = this._later(() => this._probeLoop(), this.probeEveryMs);
  }

  // the VTuber inside the app, when one runs: a function that takes one event (never throws into the caller)
  _inApp() {
    if (!this.direct) return null;
    try { const fn = this.direct(); return typeof fn === 'function' ? fn : null; } catch { return null; }
  }

  _probe() {
    if (this.probing) return;
    if (!this.http || this._inApp()) { this.ok = false; return; }   // in-app VTuber (or HTTP switched off): nothing is asked
    this.probing = true;
    this.stats.probes++;
    const done = (ok) => {
      if (!this.probing) return;
      this.probing = false;
      if (!this.live || this.stopped) return;
      if (ok) this._found(); else this._lost();
    };
    let req;
    try {
      req = http.request({ host: HOST, port: this.port, path: PATH, method: 'GET', agent: this.agent,
        headers: { 'X-LiveLink-Event': '1', Accept: 'application/json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 1024) body += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch {}
          const ok = res.statusCode === 200 && !!j && j.ok === true && Number(j.v) >= 1;
          if (ok) this.peerV = Number(j.v) >= 2 ? 2 : 1;
          done(ok);
        });
        res.on('error', () => done(false));
      });
      req.setTimeout(this.probeTimeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', () => done(false));
      req.end();
    } catch { done(false); }
  }

  _found() {
    this.ok = true;
    if (this.said !== 'found') { this.said = 'found'; this.log('info', `VTuber found on this computer (port ${this.port}): TikTok events go to it`); }
    this._changed();
  }

  _lost() {
    this.ok = false;
    if (this.said === 'found') { this.said = 'lost'; this.log('info', 'VTuber on this computer stopped answering: no events go to it until it is back'); }
    this._changed();
  }

  // ---------------------------------------------------------------- events
  // Running combo frames: remembered so a combo whose end frame never comes still goes out once it goes quiet.
  _giftFrame(g) {
    if (!this.live || !g || !String(g.key || '').startsWith('c:')) return;
    this.combos.set(g.key, { at: this.mono(), g });
    if (!this.sweepTimer) this.sweepTimer = this._later(() => this._sweep(), Math.min(1000, this.comboQuietMs));
  }

  _sweep() {
    this.sweepTimer = null;
    const now = this.mono();
    for (const [key, c] of this.combos) if (now - c.at >= this.comboQuietMs) { this.combos.delete(key); this._giftOut(c.g); }
    if (this.combos.size && this.live) this.sweepTimer = this._later(() => this._sweep(), Math.min(1000, this.comboQuietMs));
  }

  _giftEnd(e) {
    if (!e) return;
    this.combos.delete(e.key);
    this._giftOut(e);
  }

  // Sends what of this combo (or single gift) the VTuber hasn't had yet.
  _giftOut(g) {
    const key = String(g.key || '');
    const total = Math.floor(Number(g.count) || 0);
    const before = this.told.get(key) || 0;
    if (!(total > before)) return;
    this.told.delete(key);
    this.told.set(key, total);
    if (this.told.size > TOLD_MAX) this.told.delete(this.told.keys().next().value);
    this._send('gift', { name: g.userName || g.userHandle, gift: g.name, coins: g.coins, count: total - before, ...whoOf(g) }, g.at);
  }

  _like(l) {
    if (!this.live || !l || (!this.ok && !this._inApp())) return;   // nothing listening: nothing is kept for later
    const c = Math.floor(Number(l.count) || 0);
    if (!(c > 0)) return;
    if (this._v(this._inApp()) >= 2) { this._tap(l, c); return; }
    if (!this.likes) this.likes = { count: 0, name: null, timer: null };
    this.likes.count += c;
    if (l.name || l.handle) this.likes.name = l.name || l.handle;
    if (!this.likes.timer) {
      const wait = Math.max(0, this.lastLikeAt + this.likeEveryMs - this.mono());
      this.likes.timer = this._later(() => this._flushLikes(), wait);
    }
  }

  _flushLikes() {
    const b = this.likes;
    if (!b) return;
    const early = this.lastLikeAt + this.likeEveryMs - this.mono();   // a timer may fire a hair early
    if (early > 0) { b.timer = this._later(() => this._flushLikes(), Math.ceil(early)); return; }
    this.likes = null;
    this.lastLikeAt = this.mono();
    this._send('like', { name: b.name, count: b.count }, this.now());
  }

  // ---- v2 taps: one viewer per like event, with their own taps
  _tap(l, c) {
    const uid = cleanUid(l.userId), handle = cleanHandle(l.handle);
    const key = uid ? 'u' + uid : handle ? 'h' + handle.toLowerCase() : null;
    if (!key) this.crowd += c;                           // a tap with no viewer on it
    else {
      const e = this.tappers.get(key);
      if (e) { e.count += c; if (l.avatar) e.avatar = l.avatar; if (l.name) e.name = l.name; }
      else if (this.tappers.size >= TAPPERS_MAX) this.crowd += c;
      else this.tappers.set(key, { count: c, name: l.name || l.handle || null, handle, uid, avatar: l.avatar || null, at: this.mono() });
    }
    if (!this.tapTimer) this.tapTimer = this._later(() => this._flushTaps(), Math.max(0, this.lastLikeAt + this.likeEveryMs - this.mono()));
  }

  _flushTaps() {
    this.tapTimer = null;
    const now = this.mono();
    const early = this.lastLikeAt + this.likeEveryMs - now;           // a timer may fire a hair early
    if (early > 0) { this.tapTimer = this._later(() => this._flushTaps(), Math.ceil(early)); return; }
    let top = null, topKey = null;
    for (const [key, e] of this.tappers) {
      if (now - e.at >= this.crowdAfterMs) { this.crowd += e.count; this.tappers.delete(key); continue; }
      if (!top || e.count > top.count) { top = e; topKey = key; }
    }
    if (!top && !this.crowd) return;
    // the waiting crowd and the named viewers take turns, so neither starves the other
    const crowdNow = this.crowd > 0 && (!top || this.lastTapNamed);
    this.lastLikeAt = now;
    if (crowdNow) { const n = this.crowd; this.crowd = 0; this.lastTapNamed = false; this._send('like', { name: null, count: n }, this.now()); }
    else { this.tappers.delete(topKey); this.lastTapNamed = true; this._send('like', { name: top.name, count: top.count, handle: top.handle, uid: top.uid, avatar: top.avatar }, this.now()); }
    if ((this.tappers.size || this.crowd) && this.live) this.tapTimer = this._later(() => this._flushTaps(), this.likeEveryMs);
  }

  _follow(f) {
    const who = String(f.userId || f.handle || f.name || '');
    const now = this.mono();
    const last = who ? this.follows.get(who) : undefined;
    if (last !== undefined && now - last < FOLLOW_REPEAT_MS) return;
    if (who) {
      this.follows.set(who, now);
      if (this.follows.size > TOLD_MAX) this.follows.delete(this.follows.keys().next().value);
    }
    this._send('follow', { name: f.name, ...whoOf(f) }, f.at);
  }

  // ---------------------------------------------------------------- the send
  _send(type, fields, at) {
    const inApp = this.live && !this.stopped ? this._inApp() : null;
    if (!this.live || this.stopped || (!inApp && !this.ok)) { this.stats.dropped++; return false; }
    const ev = buildEvent(type, fields, at || this.now(), this._v(inApp));
    if (!ev) return false;
    const r = this.rate[type === 'gift' ? 'gift' : 'other'];
    const now = this.mono();
    if (now - r.at >= 1000) { r.at = now; r.n = 0; }
    if (r.n >= RATE_PER_S[type === 'gift' ? 'gift' : 'other'] || (!inApp && this.inFlight >= MAX_IN_FLIGHT)) { this.stats.dropped++; return false; }
    r.n++;
    return this._out(ev, inApp);
  }

  // ---------------------------------------------------------------- V8: the show state (C3) and a key press (C4)
  /** Hands one `show` or `control` message to a VTuber that speaks v2. False when none does (nothing is kept for later). */
  _side(msg, stat) {
    if (!msg) return false;
    const inApp = this.live && !this.stopped ? this._inApp() : null;
    if (!this.live || this.stopped || (!inApp && !this.ok) || this._v(inApp) < 2) return false;
    const now = this.mono();
    if (now - this.side.at >= 1000) { this.side.at = now; this.side.n = 0; }
    if (this.side.n >= SIDE_PER_S || (!inApp && this.inFlight >= MAX_IN_FLIGHT)) { this.stats.dropped++; return false; }
    this.side.n++;
    const took = this._out(msg, inApp);
    if (took) this.stats[stat]++;
    return took;
  }
  /** C3: the show state as show-feed.js builds it ({ v: 2, type: 'show', ... }). */
  sendShow(msg) { return msg && msg.v === 2 && msg.type === 'show' ? this._side(msg, 'show') : false; }
  /** C4: a key pressed in LIVE Link: action 'puppet' (name = goo | fire | melt | crack | eat), 'fight' or 'vote'. */
  sendControl(action, name) { return this._side(buildControl(action, name, this.now()), 'control'); }
  /** can a `show` / `control` message reach a VTuber right now? (the global keys are held only then) */
  get canControl() { const inApp = this.live && !this.stopped ? this._inApp() : null; return !!this.live && !this.stopped && (!!inApp || this.ok) && this._v(inApp) >= 2; }

  // one message out: handed over inside the app, or one POST to 127.0.0.1
  _out(ev, inApp) {
    if (inApp) {                                         // handed over inside the app: no request, nothing to wait for
      let took = false;
      try { took = inApp(ev) !== false; } catch { took = false; }
      if (took) { this.stats.sent++; this.stats.direct++; } else this.stats.failed++;
      return took;
    }
    const body = JSON.stringify(ev);
    this.inFlight++;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      this.inFlight--;
      if (ok) this.stats.sent++;
      else { this.stats.failed++; if (this.live) this._lost(); }   // stop sending until the next ask succeeds
    };
    try {
      const req = http.request({ host: HOST, port: this.port, path: PATH, method: 'POST', agent: this.agent,
        headers: { 'Content-Type': 'application/json', 'X-LiveLink-Event': '1', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        // Any answer means it is listening; a refusal (a 4xx such as its rate limit) only drops this one event.
        res.resume();
        res.on('end', () => done(true));
        res.on('error', () => done(true));
      });
      req.setTimeout(this.sendTimeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', () => done(false));
      req.end(body);
    } catch { done(false); }
    return true;
  }
}

module.exports = { VtuberLink, buildEvent, buildControl, PUPPET_MOVES, CONTROL_ACTIONS, CROWD_AFTER_MS, DEFAULT_PORT, PATH, PROBE_EVERY_MS, LIKE_EVERY_MS, COMBO_QUIET_MS };
