'use strict';
// Ties the TikTok link, the tap batcher and the site API together, and decides what the host sees.
// Electron-free so it can be tested headlessly against test/mock-server.js.
const EventEmitter = require('events');
const crypto = require('crypto');
const { LikeBatcher } = require('./batcher');
const { ApiError } = require('./api');

const DEFAULTS = {
  push_interval_ms: 2000,
  idle_push_interval_ms: 10000,
  status_interval_ms: 60000,
  max_likes_per_push: 500,
  max_events_per_push: 200,
};
const CONFIG_EVERY_MS = 60000;          // pick up username / enabled / target changes
const CONFIG_WAITING_MS = 10000;        // while waiting for Approve
const CONFIG_UNVERIFIED_MS = 30000;
const RETRY_STEPS_MS = [2000, 4000, 8000, 16000, 30000];

function semverLess(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}

class Controller extends EventEmitter {
  constructor(opts) {
    super();
    this.api = opts.api;
    this.link = opts.link;
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.appVersion = opts.appVersion || '0.0.0';
    this.deviceName = opts.deviceName || 'PC';
    this.now = opts.now || (() => Date.now());
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.batcher = new LikeBatcher();
    this.cfg = null;
    this.clockOffset = 0;
    this.timers = { config: null, push: null, status: null };
    this.inFlight = null;          // the push being sent (kept for an idempotent retry)
    this.retryStep = 0;
    this.lastPushAt = 0;
    this.lastStatusAt = 0;
    this.lastStatusKey = '';
    this.stopped = true;
    this.s = {
      phase: 'starting',           // unpaired | starting | pending_approval | ready | revoked | suspended | update_required
      deviceId: null, hostName: null,
      tiktokUsername: null, verified: false, enabled: false, siteLive: false, target: null,
      dryRun: !!this.store.get('dryRun'),
      tiktok: { ...this.link.state },
      taps: { session: 0, accepted: 0, deferred: 0, lastAccepted: 0, lastPushAt: null },
      siteError: null,
      message: null,
      appVersion: this.appVersion,
    };

    this.link.on('state', (st) => { this.s.tiktok = st; this._statusSoon(); this._render(); });
    this.link.on('roomChanged', (roomId) => { this.batcher.reset(roomId); this.s.taps.session = 0; this._render(); });
    this.link.on('like', (l) => {
      this.batcher.add(l);
      this.s.taps.session = this.batcher.sessionTaps;
      this._pushSoon();
      this._render(true);
    });
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    this.stopped = false;
    if (!this.store.getToken()) { this._setPhase('unpaired'); return; }
    this._setPhase('starting');
    await this._refreshToken();
    if (!this.stopped && this.s.phase !== 'revoked') await this._loadConfig();
  }

  stop() {
    this.stopped = true;
    for (const k of Object.keys(this.timers)) { this.clearTimeout(this.timers[k]); this.timers[k] = null; }
    this.link.stop();
  }

  async pair(code) {
    const res = await this.api.pair(code, this.deviceName, this.appVersion);   // throws ApiError with a code
    this.store.setToken(res.device_token);
    this.s.deviceId = res.device_id || null;
    this.s.hostName = res.host_display_name || null;
    this.stopped = false;
    this._setPhase(res.status === 'approved' ? 'ready' : 'pending_approval');
    await this._loadConfig();
    return res;
  }

  unpair() {
    this.stop();
    this.store.setToken(null);
    this.cfg = null;
    Object.assign(this.s, { deviceId: null, hostName: null, tiktokUsername: null, verified: false, enabled: false, siteLive: false, target: null });
    this.stopped = false;
    this._setPhase('unpaired');
  }

  setDryRun(on) {
    this.s.dryRun = !!on;
    this.store.set('dryRun', this.s.dryRun);
    this._applyConfig();
  }

  retryNow() {
    if (this.s.phase === 'unpaired') return;
    this.link.retryNow();
    this._loadConfig();
  }

  getState() { return JSON.parse(JSON.stringify(this.s)); }

  // ---------------------------------------------------------------- site calls
  async _refreshToken() {
    try {
      const res = await this.api.refresh(this.appVersion);
      if (res.device_token) this.store.setToken(res.device_token);
      this.s.deviceId = res.device_id || this.s.deviceId;
      this.s.siteError = null;
      if (res.status === 'pending_approval') this._setPhase('pending_approval');
    } catch (e) {
      this._handleApiError(e, 'refresh');
    }
  }

  async _loadConfig() {
    this.clearTimeout(this.timers.config);
    if (this.stopped || !this.store.getToken()) return;
    const t0 = this.now();
    try {
      const cfg = await this.api.config();
      const t1 = this.now();
      const st = Date.parse(cfg.server_time);
      if (Number.isFinite(st)) this.clockOffset = st - Math.round((t0 + t1) / 2);
      this.cfg = { ...DEFAULTS, ...cfg };
      this.s.siteError = null;
      if (this.s.phase === 'starting' || this.s.phase === 'pending_approval') this._setPhase('ready');
      this._applyConfig();
      this._scheduleConfig(this._configEvery());
    } catch (e) {
      this._handleApiError(e, 'config');
      if (!this.stopped && this.store.getToken() && !['revoked', 'suspended'].includes(this.s.phase)) {
        this._scheduleConfig(this.s.phase === 'pending_approval' ? CONFIG_WAITING_MS : this._retryDelay(e));
      }
    }
  }

  _configEvery() {
    const c = this.cfg || {};
    if (!c.tiktok_username || !c.tiktok_verified) return CONFIG_UNVERIFIED_MS;
    return CONFIG_EVERY_MS;
  }

  _scheduleConfig(ms) {
    this.clearTimeout(this.timers.config);
    this.timers.config = this.setTimeout(() => this._loadConfig(), ms);
  }

  // Decide whether to watch TikTok, based on the latest config and the host's settings.
  _applyConfig() {
    const c = this.cfg;
    if (!c) { this._render(); return; }
    this.s.hostName = c.host_display_name || this.s.hostName;
    this.s.tiktokUsername = c.tiktok_username || null;
    this.s.verified = !!c.tiktok_verified;
    this.s.enabled = !!c.live_link_enabled;
    this.s.siteLive = !!c.site_live;
    this.s.target = c.target || null;

    if (c.min_app_version && semverLess(this.appVersion, c.min_app_version)) {
      this.link.stop();
      this._setPhase('update_required');
      return;
    }
    if (this.s.phase === 'update_required') this._setPhase('ready');

    const canRun = this.s.phase === 'ready' && this.s.tiktokUsername && this.s.verified && (this.s.enabled || this.s.dryRun);
    if (canRun) {
      // Check TikTok more often while the host's show is on the site.
      this.link.setOfflinePoll(this.s.siteLive ? 30000 : 90000);
      this.link.start(this.s.tiktokUsername);
      this._statusSoon();
    } else {
      this.link.stop();
    }
    this._render();
  }

  // ---------------------------------------------------------------- pushes
  _pushInterval() {
    const c = this.cfg || DEFAULTS;
    return this.s.target ? (c.push_interval_ms || 2000) : (c.idle_push_interval_ms || 10000);
  }

  _pushSoon() {
    if (this.timers.push || this.inFlight) return;
    const wait = Math.max(0, this.lastPushAt + this._pushInterval() - this.now());
    this.timers.push = this.setTimeout(() => { this.timers.push = null; this._pushOnce(); }, wait);
  }

  async _pushOnce() {
    if (this.stopped || this.inFlight) return;
    const tk = this.s.tiktok;
    if (tk.status !== 'live' || !tk.roomId) return;
    // Push when there are new taps, or when the site deferred some (it credits at most 500 per push).
    if (!this.batcher.hasNews() && !(this.s.taps.deferred > 0)) return;
    if (this.batcher.nextTotal() === null) {
      // Taps are only credited from TikTok's room total. Never send a made-up 0: the site would take it as the
      // baseline and later credit likes that happened before we connected.
      if (!this._warnedNoTotal) { this._warnedNoTotal = true; this.log('warn', 'like events arrive without a room total; waiting for one'); }
      return;
    }
    const { events, stale, dropped, sessionTotal } = this.batcher.take(this.now(), this.clockOffset);
    if (stale || dropped) this.log('info', `push: ${stale} stale taps, ${dropped} events trimmed (credited via session_total)`);
    const body = {
      batch_id: crypto.randomUUID(),
      dry_run: !!this.s.dryRun,
      tiktok_room_id: String(tk.roomId),
      session_total: sessionTotal,
      events,
      status: this._statusBody(false),
    };
    this.inFlight = body;
    await this._sendPush();
  }

  async _sendPush() {
    const body = this.inFlight;
    if (!body) return;
    this.lastPushAt = this.now();
    try {
      const res = await this.api.push(body);
      this.inFlight = null;
      this.retryStep = 0;
      this.batcher.markSent(body.session_total);
      this.lastStatusAt = this.now();
      this.lastStatusKey = this._statusKey();
      this.s.siteError = null;
      const acc = Number(res.accepted) || 0;
      this.s.taps.lastAccepted = acc;
      if (!body.dry_run) this.s.taps.accepted += acc;
      this.s.taps.deferred = Number(res.deferred) || 0;
      this.s.taps.lastPushAt = new Date().toISOString();
      if ('target' in res) this.s.target = res.target || null;
      if (this.cfg && res.next_push_ms) this.cfg.push_interval_ms = Math.max(1000, Number(res.next_push_ms));
      this._render();
      if (this.batcher.hasNews() || this.s.taps.deferred > 0) this._pushSoon();
    } catch (e) {
      const kept = this._handleApiError(e, 'push');
      if (kept && !this.stopped) {
        // Same batch_id again: the server returns the stored answer if the first try actually landed.
        const wait = e.retryAfterMs || this._retryDelay(e);
        this.clearTimeout(this.timers.push);
        this.timers.push = this.setTimeout(() => { this.timers.push = null; this._sendPush(); }, wait);
      } else {
        this.inFlight = null;
        if (!this.stopped && this.s.phase === 'ready') this._pushSoon();
      }
    }
  }

  _retryDelay(e) {
    if (e && e.retryAfterMs) return Math.max(2000, e.retryAfterMs);
    return RETRY_STEPS_MS[Math.min(this.retryStep++, RETRY_STEPS_MS.length - 1)];
  }

  // ---------------------------------------------------------------- status
  _statusBody(withTotal = true) {
    const tk = this.s.tiktok;
    const body = {
      connected: this.link.running,                 // the app is running and watching this host's TikTok
      tiktok_live: tk.status === 'live',
      app_version: this.appVersion,
      last_error: tk.error || this.s.siteError || null,
    };
    if (withTotal) {
      body.tiktok_room_id = tk.roomId ? String(tk.roomId) : null;
      body.session_total = this.batcher.sessionTotal;
    }
    return body;
  }
  _statusKey() { const b = this._statusBody(false); return `${b.connected}|${b.tiktok_live}|${this.s.tiktok.roomId}|${b.last_error}`; }

  // Status rides inside each push; a separate call goes out only when the state changes or after 60 s without one.
  _statusSoon() {
    this.clearTimeout(this.timers.status);
    if (this.stopped || this.s.phase !== 'ready' || !this.store.getToken()) return;
    const every = (this.cfg && this.cfg.status_interval_ms) || DEFAULTS.status_interval_ms;
    const changed = this._statusKey() !== this.lastStatusKey;
    const wait = changed ? 1500 : Math.max(1000, this.lastStatusAt + every - this.now());
    this.timers.status = this.setTimeout(() => this._sendStatus(), wait);
  }

  async _sendStatus() {
    this.timers.status = null;
    if (this.stopped || this.s.phase !== 'ready') return;
    const every = (this.cfg && this.cfg.status_interval_ms) || DEFAULTS.status_interval_ms;
    if (this._statusKey() === this.lastStatusKey && this.now() - this.lastStatusAt < every - 500) { this._statusSoon(); return; }
    try {
      await this.api.status(this._statusBody(true));
      this.lastStatusAt = this.now();
      this.lastStatusKey = this._statusKey();
      this.s.siteError = null;
    } catch (e) {
      this._handleApiError(e, 'status');
    }
    this._render();
    this._statusSoon();
  }

  // ---------------------------------------------------------------- errors
  // Returns true when the failed push should be retried with the same batch.
  _handleApiError(e, where) {
    if (!(e instanceof ApiError)) { this.log('error', `${where}: ${e && e.stack || e}`); this.s.siteError = String(e && e.message || e); this._render(); return false; }
    this.log(e.isNetwork ? 'warn' : 'info', `${where}: ${e.status} ${e.code} ${e.message}`);
    switch (e.code) {
      case 'device_revoked':
        this.link.stop();
        this.store.setToken(null);
        this._setPhase('revoked');
        return false;
      case 'pending_approval':
        this.link.stop();
        this._setPhase('pending_approval');
        this._scheduleConfig(CONFIG_WAITING_MS);
        return false;
      case 'host_suspended':
        this.link.stop();
        this._setPhase('suspended');
        return false;
      case 'live_link_disabled':
        this.s.enabled = false;
        if (!this.s.dryRun) this.link.stop();
        this._render();
        return false;
      case 'tiktok_unverified':
        this.s.verified = false;
        this.link.stop();
        this._scheduleConfig(CONFIG_UNVERIFIED_MS);
        this._render();
        return false;
      case 'validation':
        this.log('error', `${where}: the site rejected the data: ${JSON.stringify(e.details)}`);
        return false;
      case 'not_live':
      case 'stale_room':
        this._statusSoon();
        return false;
      case 'rate_limited':
        return where === 'push';
      default:
        if (e.isNetwork) { this.s.siteError = e.message; this._render(); return where === 'push'; }
        this.s.siteError = e.message;
        this._render();
        return false;
    }
  }

  // ---------------------------------------------------------------- what the host sees
  _setPhase(p) { if (this.s.phase !== p) { this.s.phase = p; this.log('info', `phase: ${p}`); } this._render(); }

  _message() {
    const s = this.s, tk = s.tiktok;
    const at = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const secs = (ms) => ms ? Math.max(1, Math.round((ms - this.now()) / 1000)) : 0;
    switch (s.phase) {
      case 'unpaired': return { level: 'setup', text: 'Connect this computer: on your host dashboard, click "Connect LIVE Link" and type the code here.' };
      case 'starting': return s.siteError ? { level: 'warn', text: `Can't reach reactivvibeai.com (${s.siteError}). Retrying...` } : { level: 'info', text: 'Starting...' };
      case 'pending_approval': return { level: 'setup', text: `Almost there. On your host dashboard, click Approve for "${this.deviceName}".` };
      case 'revoked': return { level: 'error', text: 'This computer was disconnected from your account. Connect it again from your host dashboard.' };
      case 'suspended': return { level: 'error', text: 'Your host account is suspended, so LIVE Link is paused.' };
      case 'update_required': return { level: 'error', text: 'Please update LIVE Link to keep sending taps.' };
    }
    if (!s.tiktokUsername) return { level: 'setup', text: 'Add your TikTok username on your host dashboard.' };
    if (!s.verified) return { level: 'setup', text: 'Verify your TikTok on your host dashboard (a one-time code in your bio).' };
    if (!s.enabled && !s.dryRun) return { level: 'setup', text: "LIVE Link isn't switched on for your account yet." };
    if (s.siteError && !tk.error) return { level: 'warn', text: `Can't reach reactivvibeai.com right now. Taps still count and are sent when it's back.` };
    switch (tk.status) {
      case 'live':
        if (!s.target) return { level: 'ok', text: `Connected to @${s.tiktokUsername}. Start a song on the site and taps will fill its hype bar.` };
        return { level: 'ok', text: `Connected to @${s.tiktokUsername}. Taps are going to the hype bar.` + (s.dryRun ? ' (Test mode: nothing is added.)' : '') };
      case 'connecting': return { level: 'info', text: `Connecting to @${s.tiktokUsername}...` };
      case 'reconnecting': return { level: 'warn', text: `Reconnecting to @${s.tiktokUsername}...` };
      case 'offline': return { level: 'info', text: `Waiting for your TikTok LIVE to start. Checking again in ${secs(tk.retryAt)} s.` };
      case 'error':
        if (tk.errorKind === 'rate-limit') return { level: 'warn', text: `TikTok asked us to slow down. Trying again at ${at(tk.retryAt)}.` };
        return { level: 'warn', text: `Can't reach TikTok (${tk.error}). Trying again in ${secs(tk.retryAt)} s.` };
      default: return { level: 'info', text: 'Ready.' };
    }
  }

  _render(throttle = false) {
    const now = this.now();
    if (throttle && now - (this._lastRender || 0) < 250) {
      if (!this._renderTimer) this._renderTimer = this.setTimeout(() => { this._renderTimer = null; this._render(); }, 250);
      return;
    }
    this._lastRender = now;
    this.s.message = this._message();
    this.emit('state', this.getState());
  }
}

module.exports = { Controller, semverLess, DEFAULTS };
