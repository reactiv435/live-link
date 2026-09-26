'use strict';
// TikTok LIVE connection for one host, built on tiktok-live-connector 2.4.4 (the same library and the same
// reconnect rules as the T.O.S CREW show program, which has read real LIVE taps with it since 2026-09-19).
//
// Emits:
//   'state' { status, roomId, viewers, error, errorKind, retryAt }
//            status: idle | connecting | live | offline | reconnecting | error
//   'like'  { count, total, at }   count = taps in this batch, total = the room's running like total (or NaN)
//   'roomChanged' roomId
//
// Why these numbers (ported from tos crew live/server.js):
//   * a LIVE room that dropped: retry after 10 s;
//   * the room is not LIVE yet: check every offlinePollMs (30 s while the host's show is on, slower otherwise);
//   * other failures: back off 10 -> 20 -> 40 -> 80 -> 120 s, reset once connected or once TikTok says "not live";
//   * a rate-limit answer is honoured: never retry before its retry-after (at least 60 s, at most 30 min);
//   * a connect that hangs is abandoned after 45 s; an open socket with no data for 120 s is reconnected once,
//     then left alone for 5 min so a quiet room can't spin into a reconnect loop.
const EventEmitter = require('events');
const { usableTotal } = require('./batcher');

const RETRY_BACKOFF_MS = [10000, 20000, 40000, 80000, 120000];
const RATE_LIMIT_MIN_MS = 60000;
const RATE_LIMIT_MAX_MS = 30 * 60000;
const CONNECTING_TIMEOUT_MS = 45000;
const SILENT_SOCKET_MS = 120000;
const FORCED_RECONNECT_GAP_MS = 300000;
const WATCHDOG_EVERY_MS = 5000;

function loadConnector() {
  // Lazy so tests can inject a fake without loading the real library.
  return require('tiktok-live-connector');
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
    this.username = null;
    this.offlinePollMs = 30000;
    this.conn = null;
    this.generation = 0;
    this.retryStep = 0;
    this.reconnectTimer = null;
    this.connectStartedAt = 0;
    this.lastFrameAt = 0;
    this.lastForcedReconnectAt = 0;
    this.watchdog = null;
    this.state = { status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null };
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
    this._connect();
  }

  // Ends the link with NO auto-reconnect. Bumping the generation mutes every callback of the old connection,
  // including its DISCONNECTED handler and a connect() still in flight.
  stop() {
    this.generation++;
    this.username = null;
    this.connectStartedAt = 0;
    this.clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.watchdog) { this.clearInterval(this.watchdog); this.watchdog = null; }
    this._dropConnection();
    this._setState({ status: 'idle', roomId: null, viewers: 0, error: null, errorKind: null, retryAt: null });
  }

  // Try now (the UI's "Reconnect" button). Never tears down a healthy or in-progress connection, and never
  // jumps a rate-limit wait (each attempt costs a request on the free sign server).
  retryNow() {
    if (!this.username) return;
    const st = this.state.status;
    if (st === 'live' || st === 'connecting' || st === 'reconnecting') return;
    if (this.state.errorKind === 'rate-limit' && this.state.retryAt > this.now()) return;
    this._connect();
  }

  _dropConnection() {
    if (!this.conn) return;
    const old = this.conn; this.conn = null;
    try { old.removeAllListeners(); } catch {}
    try { old.on && old.on('error', () => {}); } catch {}
    try { const p = old.disconnect(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch {}
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

  _failed(e) {
    const msg = String((e && e.message) || e);
    const f = this._classify(e);
    this.connectStartedAt = 0;
    const retryAt = this._schedule(f.ms);
    this._setState({ status: f.kind === 'offline' ? 'offline' : 'error', roomId: null, viewers: 0, error: f.kind === 'offline' ? null : msg, errorKind: f.kind, retryAt });
    this.log(f.kind === 'offline' ? 'info' : 'warn', `TikTok connect: ${f.kind}${f.kind === 'offline' ? '' : ' - ' + msg}; next try in ${Math.round(f.ms / 1000)} s`);
  }

  async _connect() {
    if (!this.username) return;
    if (!this.lib) this.lib = loadConnector();
    const L = this.lib;
    const generation = ++this.generation;
    this.clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    this._dropConnection();
    this.lastFrameAt = this.mono();
    this.connectStartedAt = this.mono();
    this._setState({ status: this.state.status === 'live' ? 'reconnecting' : 'connecting', error: null, errorKind: null, retryAt: null });

    const conn = new L.TikTokLiveConnection(this.username, {
      // Never replay the backlog TikTok hands over on connect: those likes happened before we were listening.
      processInitialData: false,
      enableExtendedGiftInfo: false,
      fetchRoomInfoOnConnect: true,
      ...(this.signApiKey ? { signApiKey: this.signApiKey } : {}),
    });
    this.conn = conn;
    const on = (event, cb) => { if (event) conn.on(event, (...a) => { if (generation === this.generation) cb(...a); }); };
    const C = L.ControlEvent || {}, W = L.WebcastEvent || {};

    on(C.WEBSOCKET_DATA, () => { this.lastFrameAt = this.mono(); });
    on(C.CONNECTED, (s) => {
      this.lastFrameAt = this.mono();
      this.retryStep = 0; this.connectStartedAt = 0;
      this._setState({ status: 'live', roomId: (s && s.roomId) ? String(s.roomId) : null, error: null, errorKind: null, retryAt: null });
      this.log('info', `Connected to @${this.username} room ${this.state.roomId}`);
    });
    on(C.DISCONNECTED, () => {
      this.retryStep = 1;                          // a real drop of a LIVE room: 10 s, then the normal backoff
      const retryAt = this._schedule(RETRY_BACKOFF_MS[0]);
      this._setState({ status: 'reconnecting', retryAt });
      this.log('info', `Disconnected from @${this.username}; retrying in 10 s`);
    });
    on(C.ERROR, (e) => this.log('warn', `${(e && e.info) || 'connector'}: ${(e && e.exception && e.exception.message) || (e && e.message) || String(e)}`));
    on(W.STREAM_END, () => this.log('info', 'TikTok says the LIVE ended'));
    on(W.ROOM_USER, (d) => {
      const v = Number((d && (d.viewerCount || d.total || d.totalUser)) || 0);
      if (v !== this.state.viewers) this._setState({ viewers: v });
    });
    on(W.LIKE, (d) => {
      // tiktok-live-proto v3 (what 2.4.4 decodes): count = taps in this batch, total = room total as a STRING.
      // Older/other shapes use likeCount / totalLikeCount; read both.
      // v3 DEFAULTS total to "0" when the wire omits it: a total of 0 (or below this batch) means "no total".
      const count = Math.max(0, Math.floor(Number(d && (d.count ?? d.likeCount)) || 0));
      const t = usableTotal(d && (d.total ?? d.totalLikeCount), count);
      const total = t === null ? NaN : t;
      if (count > 0 || t !== null) this.emit('like', { count, total, at: this.now() });
    });

    try {
      await conn.connect();
      if (generation !== this.generation) { try { conn.disconnect(); } catch {} }
    } catch (e) {
      if (generation !== this.generation) return;
      this._failed(e);
    }
  }

  _tick() {
    const now = this.mono();
    if (!this.username) return;
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
      this._failed({ timeout: true, message: `TikTok did not answer for ${secs} s (check the internet)` });
    }
  }
}

module.exports = { TikTokLink, RETRY_BACKOFF_MS, RATE_LIMIT_MIN_MS, CONNECTING_TIMEOUT_MS, SILENT_SOCKET_MS };
