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
const CONFIG_WATCH_SITE_MS = 15000;     // TikTok is live but the site show isn't on yet: notice it starting quickly
const CONFIG_WAITING_MS = 10000;        // while waiting for Approve
// A token refresh that reached the site but whose answer was lost leaves the app on the previous token, which the
// site honours for 5 minutes only: retry inside that window (about 3 minutes in total).
const REFRESH_RETRY_MS = [10000, 30000, 60000, 90000];
const CONFIG_UNVERIFIED_MS = 30000;
const RETRY_STEPS_MS = [2000, 4000, 8000, 16000, 30000];
const STATUS_RETRY_MS = [5000, 15000, 30000, 60000];

function semverLess(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}

const freshTaps = () => ({ session: 0, accepted: 0, deferred: 0, lastAccepted: 0, lastPushAt: null });

class Controller extends EventEmitter {
  constructor(opts) {
    super();
    this.api = opts.api;
    this.link = opts.link;
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.appVersion = opts.appVersion || '0.0.0';
    this.deviceName = opts.deviceName || 'PC';
    this.now = opts.now || (() => Date.now());                        // wall clock: timestamps + display only
    this.mono = opts.mono || opts.now || (() => performance.now());   // steady clock: every interval
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.batcher = new LikeBatcher();
    this.cfg = null;
    this.clockOffset = 0;
    this.timers = { config: null, push: null, status: null, tpm: null, refresh: null };
    this.refreshRetryMs = opts.refreshRetryMs || REFRESH_RETRY_MS;
    this.refreshRetryStep = 0;
    this.inFlight = null;          // the push being sent (kept for an idempotent retry)
    this.epoch = 0;                // bumped by stop(): any await that returns into an older epoch is ignored
    this.pushRetryStep = 0;
    this.configRetryStep = 0;
    this.statusRetryStep = 0;
    this.lastPushAt = -Infinity;
    this.lastStatusAt = -Infinity;
    this.lastStatusKey = '';
    this.pausedForSite = false;    // the site said not_live: hold pushes until it reports the show is on
    this.refreshing = null;
    this.stopped = true;
    this.s = {
      phase: 'starting',           // unpaired | starting | pending_approval | ready | revoked | suspended | update_required
      deviceId: null, hostName: null,
      tiktokUsername: null, verified: false, enabled: false, siteLive: false, target: null,
      dryRun: !!this.store.get('dryRun'),
      paused: !!this.store.get('paused'),   // the host pressed Disconnect (remembered across restarts)
      atom: 'off',                        // live | connecting | off: drives the atom's colour
      liveSince: null,                    // when the current LIVE session started (wall ms)
      tapsPerMin: 0,                      // taps seen in the last 60 s
      lastSession: this.store.get('lastSession') || null,   // end-of-LIVE summary (kept across restarts)
      pushRejected: null,                 // { field, at } when the site turned a push down (400 validation)
      tiktok: { ...this.link.state },
      taps: freshTaps(),
      siteError: null,
      message: null,
      appVersion: this.appVersion,
      dashboardUrl: null,          // from live-link-config (reactivvibeai.com only)
      siteOkAt: null,              // last successful call to the site
      steps: [],                   // the setup/status checklist the window shows
      update: { available: false },  // from live-link-config `latest` (signed download link)
    };

    this.session = null;           // the LIVE being counted right now
    this.tapWindow = [];           // [wall ms, taps] for taps per minute
    this.link.on('state', (st) => {
      const wasIdle = this.s.tiktok.status === 'idle';
      this.s.tiktok = st;
      if (st.status === 'idle' && !wasIdle) this._stoppedWatching();
      this._trackSession(st);
      if (st.status === 'live') this._pushSoon();
      this._statusSoon();
      this._render();
    });
    this.link.on('roomChanged', (roomId) => {
      if (this.session && this.session.roomId && this.session.roomId !== roomId) this._endSession('ended');
      const old = this.batcher;
      if (old.roomId && (old.hasNews() || this.s.taps.deferred > 0)) this._drainRoom(old);   // a LIVE ended and a new one began
      this.batcher = new LikeBatcher(roomId);
      this.s.taps.session = 0; this.s.taps.deferred = 0;
      this.s.pushRejected = null;
      this._render();
    });
    this.link.on('like', (l) => {
      if (!this.batcher.roomId && this.link.state.roomId) this.batcher.reset(this.link.state.roomId);
      this.batcher.add(l);
      this.s.taps.session = this.batcher.sessionTaps;
      const c = Math.max(0, Number(l.count) || 0);
      if (c > 0) { this.tapWindow.push([this.mono(), c]); if (this.session) this.session.taps += c; }
      this._pushSoon();
      this._render(true);
    });
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    this.stopped = false;
    if (!this.store.getToken()) { this._setPhase('unpaired'); return; }
    this._setPhase('starting');
    const ep = this.epoch;
    this.refreshing = this._refreshToken();
    await this.refreshing;
    this.refreshing = null;
    if (ep !== this.epoch || this.stopped) return;
    if (this.s.phase !== 'revoked') await this._loadConfig();
  }

  stop() {
    this.stopped = true;
    this.epoch++;
    for (const k of Object.keys(this.timers)) { this.clearTimeout(this.timers[k]); this.timers[k] = null; }
    this.clearTimeout(this._renderTimer); this._renderTimer = null;
    this.inFlight = null;
    this.pushRetryStep = this.configRetryStep = this.statusRetryStep = this.refreshRetryStep = 0;
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
    this.batcher = new LikeBatcher();
    this.pausedForSite = false;
    this.lastStatusKey = '';
    Object.assign(this.s, { deviceId: null, hostName: null, tiktokUsername: null, verified: false, enabled: false, siteLive: false, target: null, taps: freshTaps(), siteError: null, pushRejected: null });
    this.stopped = false;
    this._setPhase('unpaired');
  }

  setDryRun(on) {
    const was = this.s.dryRun;
    const b = this.batcher;
    // Entering test mode: real taps already seen (and any backlog the site still owes) go out as REAL first.
    if (!was && on && !this.stopped && b.roomId && (b.hasNews() || this.s.taps.deferred > 0)) this._drainRoom(b, false);
    this.s.dryRun = !!on;
    this.store.set('dryRun', this.s.dryRun);
    // Leaving test mode: taps seen during the test must never be credited afterwards. Marking the totals stale (not just
    // re-baselining at the last one seen) also covers a TikTok outage at that moment: its test taps can't be told apart.
    if (was && !this.s.dryRun) { b.markStale(); this.s.taps.deferred = 0; }
    this._applyConfig();
  }

  // The Connect / Disconnect button. Disconnect stops watching TikTok and is remembered across restarts, so a
  // host who disconnected stays disconnected. Taps from the disconnected stretch are never credited: stopping marks
  // the room totals stale (see _stoppedWatching), so Connect baselines at the first fresh TikTok total.
  setPaused(on) {
    this.s.paused = !!on;
    this.store.set('paused', this.s.paused);
    this.s.pushRejected = null;
    if (this.s.paused) { this._endSession('disconnected'); this.link.stop(); }
    else this.s.taps.deferred = 0;
    this._applyConfig();
    this._statusSoon();
  }

  // The link just stopped watching TikTok (Disconnect, switched off, unverified, update needed, unpaired, quit).
  // Send what was already collected (one best-effort push), then mark the totals stale: whatever happens on TikTok
  // until watching resumes is never credited.
  _stoppedWatching() {
    const b = this.batcher;
    if (!this.stopped && this.s.phase === 'ready' && b.roomId && (b.hasNews() || this.s.taps.deferred > 0)) this._drainRoom(b);
    b.markStale();
  }

  // ---------------------------------------------------------------- LIVE sessions (for the timer + summary)
  _trackSession(st) {
    if (st.status === 'live') {
      if (!this.session) {
        this.session = { roomId: st.roomId || null, startedAt: this.now(), taps: 0, peakViewers: 0,
          acceptedAtStart: this.s.taps.accepted, username: this.s.tiktokUsername, dryRun: !!this.s.dryRun };
      }
      this.session.droppedAt = null;
      if (st.roomId && !this.session.roomId) this.session.roomId = st.roomId;
      this.session.peakViewers = Math.max(this.session.peakViewers, Number(st.viewers) || 0);
    } else if (this.session && st.status === 'reconnecting' && !this.session.droppedAt) {
      this.session.droppedAt = this.now();
    } else if (st.status === 'offline' && this.session) {
      this._endSession('ended');        // TikTok says the account is no longer LIVE
    } else if (st.status === 'idle' && this.session) {
      this._endSession('stopped');      // LIVE Link stopped watching (unpaired, switched off, update needed, quit)
    }
    this.s.liveSince = this.session ? this.session.startedAt : null;
  }

  _endSession(reason) {
    const se = this.session;
    if (!se) return;
    this.session = null;
    this.s.liveSince = null;
    const endedAt = se.droppedAt || this.now();
    if (endedAt - se.startedAt < 30000 && se.taps === 0) return;   // a blip, not a LIVE
    const summary = { username: se.username, roomId: se.roomId, startedAt: se.startedAt, endedAt, taps: se.taps,
      accepted: Math.max(0, this.s.taps.accepted - se.acceptedAtStart), peakViewers: se.peakViewers,
      dryRun: !se.realPush && (se.dryRun || !!this.s.dryRun), reason };   // "test mode" only if nothing real was sent
    this.s.lastSession = summary;
    this.store.set('lastSession', summary);
    this.emit('sessionEnded', summary);
    this._render();
  }

  // Taps of a finished LIVE can still be credited after it ended (a deferred backlog): keep its summary honest.
  _creditLastSession(room, acc) {
    if (!(acc > 0)) return;
    if (this.session && String(this.session.roomId) === String(room)) return;   // counted by the running session
    if (this.session) this.session.acceptedAtStart += acc;                      // not the running LIVE's taps
    const x = this.s.lastSession;
    if (!x || !x.roomId || String(x.roomId) !== String(room)) return;
    x.accepted += acc;
    this.store.set('lastSession', x);
  }

  retryNow() {
    if (this.s.phase === 'unpaired' || this.s.phase === 'starting') return;   // _loadConfig waits for a refresh itself
    this.link.retryNow();
    this._loadConfig();
  }

  getState() { return JSON.parse(JSON.stringify(this.s)); }

  // ---------------------------------------------------------------- site calls
  async _refreshToken() {
    const ep = this.epoch;
    const used = this.store.getToken();   // the token this call carries (read before its first await)
    try {
      const res = await this.api.refresh(this.appVersion);
      // The site has rotated: keep the new token even if the app stopped meanwhile, unless it was unpaired/re-paired.
      if (res.device_token && this.store.getToken() === used) this.store.setToken(res.device_token);
      if (ep !== this.epoch) return;
      this.refreshRetryStep = 0;
      this.s.deviceId = res.device_id || this.s.deviceId;
      this.s.siteError = null;
      if (res.status === 'pending_approval') this._setPhase('pending_approval');
      this._render();
      return true;
    } catch (e) {
      if (ep !== this.epoch) return false;
      const network = e instanceof ApiError && e.isNetwork;
      // While everything else works, a failed background refresh is not "can't reach the site".
      if (network && this.s.phase === 'ready') this.log('warn', `refresh: ${e.status} ${e.code} ${e.message}`);
      else this._handleApiError(e, 'refresh');
      if (network && !this.stopped && this.store.getToken()) this._retryRefresh();
      return false;
    }
  }

  // Keeps going (at the last step) until the site answers: each refresh that reaches it restarts the 5-minute grace
  // of the token we hold, so retrying is always safe, and stopping early could strand the PC on a dead token.
  _retryRefresh() {
    const step = this.refreshRetryStep;
    this.refreshRetryStep = step + 1;
    this.clearTimeout(this.timers.refresh);
    this.timers.refresh = this.setTimeout(async () => {
      this.timers.refresh = null;
      if (this.stopped || this.refreshing || !this.store.getToken()) return;
      this.refreshing = this._refreshToken();
      const ok = await this.refreshing;
      this.refreshing = null;
      // Use the new token right away: that retires the previous one, so a late answer can't rotate it again.
      if (ok && !this.stopped && this.store.getToken()) this._loadConfig();
    }, this.refreshRetryMs[Math.min(step, this.refreshRetryMs.length - 1)]);
  }

  async _loadConfig() {
    this.clearTimeout(this.timers.config);
    if (this.stopped || !this.store.getToken()) return;
    const ep = this.epoch;
    if (this.refreshing) await this.refreshing;          // never call with a token the refresh is rotating
    if (ep !== this.epoch || this.stopped || !this.store.getToken()) return;
    const t0 = this.now();
    try {
      const cfg = await this.api.config();
      if (ep !== this.epoch) return;
      if (typeof cfg.tiktok_verified !== 'boolean') throw new ApiError(0, 'network', 'The site sent an incomplete config.');
      const t1 = this.now();
      const st = Date.parse(cfg.server_time);
      if (Number.isFinite(st)) this.clockOffset = st - Math.round((t0 + t1) / 2);
      this.cfg = { ...DEFAULTS, ...cfg };
      this.s.siteError = null;
      this.s.siteOkAt = this.now();
      this.configRetryStep = 0;
      if (['starting', 'pending_approval', 'suspended'].includes(this.s.phase)) this._setPhase('ready');
      this._applyConfig();
      this._scheduleConfig(this._configEvery());
    } catch (e) {
      if (ep !== this.epoch) return;
      this._handleApiError(e, 'config');
      if (!this.stopped && this.store.getToken() && this.s.phase !== 'revoked') {
        const wait = this.s.phase === 'pending_approval' ? CONFIG_WAITING_MS
          : this.s.phase === 'suspended' ? CONFIG_EVERY_MS
          : this._retryDelay(e, 'config');
        this._scheduleConfig(wait);
      }
    }
  }

  _configEvery() {
    const c = this.cfg || {};
    if (!c.tiktok_username || !c.tiktok_verified) return CONFIG_UNVERIFIED_MS;
    if (this.s.tiktok.status === 'live' && (!this.s.siteLive || this.pausedForSite)) return CONFIG_WATCH_SITE_MS;
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
    const wasSiteLive = this.s.siteLive;
    this.s.hostName = c.host_display_name || this.s.hostName;
    this.s.tiktokUsername = c.tiktok_username || null;
    this.s.verified = !!c.tiktok_verified;
    this.s.enabled = !!c.live_link_enabled;
    this.s.siteLive = !!c.site_live;
    this.s.target = c.target || null;
    const du = String(c.dashboard_url || '');
    this.s.dashboardUrl = /^https:\/\/(www\.)?reactivvibeai\.com\//.test(du) ? du : null;
    const L = c.latest;
    this.s.update = (L && L.version)
      ? { available: semverLess(this.appVersion, L.version), version: String(L.version), url: /^https:\/\//.test(String(L.download_url || '')) ? L.download_url : null, sha256: L.sha256 || null }
      : { available: false };
    if (this.s.siteLive && (!wasSiteLive || this.pausedForSite)) {
      if (this.pausedForSite) this.batcher.rebaseNow();   // count from the moment the show is on, not before
      this.pausedForSite = false;
      this._pushSoon();
    }

    if (c.min_app_version && semverLess(this.appVersion, c.min_app_version)) {
      this.link.stop();
      this._setPhase('update_required');
      return;
    }
    if (this.s.phase === 'update_required') this._setPhase('ready');

    const canRun = this.s.phase === 'ready' && !this.s.paused && this.s.tiktokUsername && this.s.verified && (this.s.enabled || this.s.dryRun);
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
    if (this.timers.push || this.inFlight || this.stopped) return;
    const wait = Math.max(0, this.lastPushAt + this._pushInterval() - this.mono());
    this.timers.push = this.setTimeout(() => { this.timers.push = null; this._pushOnce(); }, wait);
  }

  async _pushOnce() {
    if (this.stopped || this.inFlight || this.s.phase !== 'ready' || this.pausedForSite) return;
    // Pushes follow the ROOM the taps belong to, not the socket: after a LIVE ends the last taps and any
    // deferred backlog still go out while the link waits for the next LIVE.
    const room = this.batcher.roomId;
    if (!room || !this.link.running) return;
    if (!this.batcher.hasNews() && !(this.s.taps.deferred > 0)) return;
    if (this.batcher.nextTotal() === null) {
      // Taps are only credited from TikTok's room total. Never send a made-up 0: the site would take it as the
      // baseline and later credit likes that happened before we connected.
      if (!this._warnedNoTotal) { this._warnedNoTotal = true; this.log('warn', 'like events arrive without a room total; waiting for one'); }
      return;
    }
    const { events, stale, dropped, sessionTotal, rebaseline, gen } = this.batcher.take(this.now(), this.clockOffset);
    if (stale || dropped) this.log('info', `push: ${stale} stale taps, ${dropped} events trimmed (credited via session_total)`);
    const body = {
      batch_id: crypto.randomUUID(),
      dry_run: !!this.s.dryRun,
      tiktok_room_id: String(room),
      session_total: sessionTotal,
      events,
      status: this._statusBody(false),
    };
    if (rebaseline) body.rebaseline = true;   // count from session_total, credit nothing for the gap
    this.inFlight = body;
    this.inFlightMeta = { gen, stripped: false };
    await this._sendPush();
  }

  async _sendPush() {
    const body = this.inFlight;
    if (!body) return;
    const ep = this.epoch;
    this.lastPushAt = this.mono();
    try {
      const res = await this.api.push(body);
      if (ep !== this.epoch) return;
      const meta = this.inFlightMeta || {};
      this.inFlight = null;
      this.inFlightMeta = null;
      this.pushRetryStep = 0;
      this.refusals = 0;
      this.s.siteError = null;
      this.s.pushRejected = null;
      this.s.siteOkAt = this.now();
      if (!body.dry_run) {             // the site only files the status riding in a REAL push
        this.lastStatusAt = this.mono();
        this.lastStatusKey = this._statusKey();
      }
      const sameRoom = String(body.tiktok_room_id) === String(this.batcher.roomId);
      if (sameRoom) {
        this.batcher.markSent(body.session_total, body.rebaseline, meta.gen);
        if (!body.dry_run && this.session) this.session.realPush = true;
        this.s.taps.deferred = body.dry_run ? 0 : (Number(res.deferred) || 0);
      }
      const acc = Number(res.accepted) || 0;
      this.s.taps.lastAccepted = acc;
      if (!body.dry_run) { this.s.taps.accepted += acc; this._creditLastSession(body.tiktok_room_id, acc); }
      this.s.taps.lastPushAt = new Date(this.now()).toISOString();
      if ('target' in res) this.s.target = res.target || null;
      if (this.cfg && res.next_push_ms) this.cfg.push_interval_ms = Math.max(1000, Number(res.next_push_ms));
      this._render();
      if (this.batcher.hasNews() || this.s.taps.deferred > 0) this._pushSoon();
    } catch (e) {
      if (ep !== this.epoch) return;
      if (e instanceof ApiError && e.code === 'validation') { this._pushRefused(e, body); return; }
      const kept = this._handleApiError(e, 'push');
      if (kept && !this.stopped) {
        // Same batch_id again: the server returns the stored answer if the first try actually landed.
        const wait = e.retryAfterMs ? Math.max(2000, e.retryAfterMs) : this._retryDelay(e, 'push');
        this.clearTimeout(this.timers.push);
        this.timers.push = this.setTimeout(() => { this.timers.push = null; this._sendPush(); }, wait);
      } else {
        this.inFlight = null;
        this.inFlightMeta = null;
        if (!this.stopped && this.s.phase === 'ready') this._pushSoon();
      }
    }
  }

  // The site refused a push (400/413 'validation'). The session_total carries the credit; the events and status are
  // diagnostics. So first resend the same totals without them (new batch id); only if that is refused too, or the
  // total itself was the problem, count again from now. Never resend refused data as-is: it would be refused forever.
  _pushRefused(e, body) {
    const field = (e.details && e.details.field) || null;
    const meta = this.inFlightMeta || {};
    this.inFlight = null;
    this.inFlightMeta = null;
    this.refusals = (this.refusals || 0) + 1;
    if (this.refusals <= 3 || this.refusals % 20 === 0) {
      this.log('error', `push refused (${e.status} ${field || 'no field'}, ${this.refusals} in a row): ${e.message}`);
    }
    if (this.stopped || this.s.phase !== 'ready') return;
    const sameRoom = String(body.tiktok_room_id) === String(this.batcher.roomId);
    if (sameRoom && field !== 'session_total' && !meta.stripped) {
      this.inFlight = { ...body, batch_id: crypto.randomUUID(), events: [], status: this._statusBody(false) };
      this.inFlightMeta = { gen: meta.gen, stripped: true };
      this.clearTimeout(this.timers.push);
      this.timers.push = this.setTimeout(() => { this.timers.push = null; this._sendPush(); }, 1000);
      return;
    }
    if (sameRoom) {
      this.batcher.rebaseNow();
      this.s.taps.deferred = 0;
      this.s.pushRejected = { field, at: this.now() };
      this._render();
    }
    // An old room's refused batch is simply dropped. Repeated refusals back off instead of retrying every push.
    const wait = this.refusals >= 2 ? RETRY_STEPS_MS[Math.min(this.refusals - 2, RETRY_STEPS_MS.length - 1)] : this._pushInterval();
    this.clearTimeout(this.timers.push);
    this.timers.push = this.setTimeout(() => { this.timers.push = null; this._pushOnce(); }, wait);
  }

  // A room LIVE Link stops pushing for (a new LIVE began, Disconnect, switched off, Test mode on): send its last total
  // until the site has credited everything it owes (deferred 0). It only ever resends a total LIVE Link actually saw,
  // so even a late drain can't credit taps from after it stopped watching (the site ignores totals <= its last).
  // A room whose baseline never reached the site has nothing creditable, and sending that baseline late could move
  // the site backwards, so it is skipped. Best effort: ~100 tries, stops on a refusal or when the app stops.
  async _drainRoom(old, dryRun = !!this.s.dryRun) {
    if (this.s.phase !== 'ready' || old.nextTotal() === null || old.rebase) return;
    const ep = this.epoch;
    const { events, sessionTotal } = old.take(this.now(), this.clockOffset);
    let body = { batch_id: crypto.randomUUID(), dry_run: dryRun, tiktok_room_id: String(old.roomId), session_total: sessionTotal, events, status: this._statusBody(false) };
    for (let i = 0; i < 100; i++) {
      if (ep !== this.epoch || this.stopped || this.s.phase !== 'ready') return;
      try {
        const r = await this.api.push(body);
        if (ep !== this.epoch) return;
        const acc = Number(r.accepted) || 0;
        if (!body.dry_run) { this.s.taps.accepted += acc; this._creditLastSession(old.roomId, acc); }
        this._render();
        if (body.dry_run || !(Number(r.deferred) > 0)) return;
        body = { ...body, batch_id: crypto.randomUUID(), events: [], status: this._statusBody(false) };
        await this._sleep(this._pushInterval());
      } catch (e) {
        if (ep !== this.epoch) return;
        if (e instanceof ApiError && (e.code === 'rate_limited' || e.isNetwork)) {
          await this._sleep(Math.max(1000, e.retryAfterMs || 2000));   // same batch id: a repeat gets the stored answer
          continue;
        }
        this.log('info', `final push for room ${old.roomId}: ${e.code || e.message}`);
        return;
      }
    }
  }

  _sleep(ms) { return new Promise((r) => this.setTimeout(r, ms)); }

  _retryDelay(e, which) {
    if (e && e.retryAfterMs) return Math.max(2000, e.retryAfterMs);
    const key = which === 'push' ? 'pushRetryStep' : 'configRetryStep';
    return RETRY_STEPS_MS[Math.min(this[key]++, RETRY_STEPS_MS.length - 1)];
  }

  // ---------------------------------------------------------------- status
  _statusBody(withTotal = true) {
    const tk = this.s.tiktok;
    const body = {
      connected: this.link.running,                 // the app is running and watching this host's TikTok
      tiktok_live: tk.status === 'live',
      app_version: this.appVersion,
      last_error: String(tk.error || this.s.siteError || '').slice(0, 500) || null,
    };
    if (withTotal) {
      body.tiktok_room_id = tk.roomId ? String(tk.roomId) : (this.batcher.roomId || null);
      body.session_total = this.batcher.sessionTotal;
    }
    return body;
  }
  _statusKey() { const b = this._statusBody(false); return `${b.connected}|${b.tiktok_live}|${this.s.tiktok.roomId}|${this.s.tiktok.error || ''}`; }

  // Status rides inside each push; a separate call goes out only when the state changes or after 60 s without one.
  _statusSoon() {
    if (this._statusBackoff) return;                 // a failed status call is waiting out its backoff
    this.clearTimeout(this.timers.status);
    if (this.stopped || this.s.phase !== 'ready' || !this.store.getToken()) return;
    const every = (this.cfg && this.cfg.status_interval_ms) || DEFAULTS.status_interval_ms;
    const changed = this._statusKey() !== this.lastStatusKey;
    const wait = changed ? 1500 : Math.max(1000, this.lastStatusAt + every - this.mono());
    this.timers.status = this.setTimeout(() => this._sendStatus(), wait);
  }

  async _sendStatus() {
    this.timers.status = null;
    this._statusBackoff = false;
    if (this.stopped || this.s.phase !== 'ready') return;
    const every = (this.cfg && this.cfg.status_interval_ms) || DEFAULTS.status_interval_ms;
    if (this._statusKey() === this.lastStatusKey && this.mono() - this.lastStatusAt < every - 500) { this._statusSoon(); return; }
    const ep = this.epoch;
    try {
      await this.api.status(this._statusBody(true));
      if (ep !== this.epoch) return;
      this.s.siteError = null;
      this.s.siteOkAt = this.now();
      this.statusRetryStep = 0;
      this.lastStatusAt = this.mono();
      this.lastStatusKey = this._statusKey();
    } catch (e) {
      if (ep !== this.epoch) return;
      this._handleApiError(e, 'status');
      this.lastStatusAt = this.mono();
      if (!e.isNetwork && e.code !== 'rate_limited') this.lastStatusKey = this._statusKey();
      if (!this.stopped && this.s.phase === 'ready') {
        const wait = Math.max(e.retryAfterMs || 0, STATUS_RETRY_MS[Math.min(this.statusRetryStep++, STATUS_RETRY_MS.length - 1)]);
        this._statusBackoff = true;
        this.timers.status = this.setTimeout(() => this._sendStatus(), wait);
      }
      this._render();
      return;
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
        // A request that carried a token the app has since rotated says nothing about the current token.
        if (e.tokenUsed && e.tokenUsed !== this.store.getToken()) return where === 'push';
        this.link.stop();
        this.store.setToken(null);
        this.inFlight = null;
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
        this._scheduleConfig(CONFIG_EVERY_MS);
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
        if (where === 'push') {
          // The site isn't taking taps now: forget taps from this stretch and wait for the show to be on.
          this.batcher.rebaseNow();
          this.s.taps.deferred = 0;
          this.pausedForSite = true;
          this._scheduleConfig(CONFIG_WATCH_SITE_MS);
        }
        return false;
      case 'rate_limited':
        return where === 'push';
      default:
        this.s.siteError = e.message;
        this._render();
        return e.isNetwork && where === 'push';
    }
  }

  // ---------------------------------------------------------------- what the host sees
  _setPhase(p) { if (this.s.phase !== p) { this.s.phase = p; this.log('info', `phase: ${p}`); } this._render(); }

  _message() {
    const s = this.s, tk = s.tiktok;
    const at = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const secs = (ms) => ms ? Math.max(1, Math.round((ms - this.now()) / 1000)) : 0;
    switch (s.phase) {
      case 'unpaired': return { level: 'setup', text: 'Connect this computer: on your host dashboard (LIVE Link tab, Connect a PC), click "Get a pair code" and type the code here.' };
      case 'starting': return s.siteError ? { level: 'warn', text: `Can't reach reactivvibeai.com (${s.siteError}). Retrying...` } : { level: 'info', text: 'Starting...' };
      case 'pending_approval': return { level: 'setup', text: `Almost there. On your host dashboard, click Approve for "${this.deviceName}".` };
      case 'revoked': return { level: 'error', text: 'This computer was disconnected from your account. Connect it again from your host dashboard.' };
      case 'suspended': return { level: 'error', text: 'Your host account is suspended, so LIVE Link is paused.' };
      case 'update_required': return { level: 'error', text: 'Please update LIVE Link to keep sending taps.' };
    }
    if (s.paused) return { level: 'off', text: "Disconnected. LIVE Link isn't watching your TikTok. Press Connect when you're ready." };
    // The site hides the username until it is verified, so check verification first.
    if (!s.verified) return { level: 'setup', text: 'One step left: verify your TikTok on your dashboard (LIVE Link tab, TikTok verification).' };
    if (!s.tiktokUsername) return { level: 'setup', text: 'Add your TikTok username on your dashboard (LIVE Link tab).' };
    if (!s.enabled && !s.dryRun) return { level: 'setup', text: "LIVE Link isn't switched on for your account yet." };
    if (s.siteError && !tk.error) return { level: 'warn', text: `Can't reach reactivvibeai.com right now. Taps still count and are sent when it's back.` };
    if (s.pushRejected && tk.status === 'live' && this.now() - s.pushRejected.at < 60000) return { level: 'warn', text: 'The site turned down some tap data, so LIVE Link started counting again from now. If this keeps happening, send your log folder to support.' };
    switch (tk.status) {
      case 'live':
        if (this.pausedForSite || !s.siteLive) return { level: 'ok', text: `Connected to @${s.tiktokUsername}. Start your show on the site and taps will fill the hype bar.` };
        if (!s.target) return { level: 'ok', text: `Connected to @${s.tiktokUsername}. Start a song on the site and taps will fill its hype bar.` };
        return { level: 'ok', text: `Connected to @${s.tiktokUsername}. Taps are going to the hype bar.` + (s.dryRun ? ' (Test mode: nothing is added.)' : '') };
      case 'connecting': return { level: 'info', text: `Connecting to @${s.tiktokUsername}...` };
      case 'reconnecting': return { level: 'warn', text: `Reconnecting to @${s.tiktokUsername}...` };
      case 'offline': return { level: 'info', text: `Ready. Waiting for @${s.tiktokUsername} to go LIVE on TikTok.` };
      case 'error':
        if (tk.errorKind === 'rate-limit') return { level: 'warn', text: `TikTok asked us to slow down. Trying again at ${at(tk.retryAt)}.` };
        return { level: 'warn', text: `Can't reach TikTok right now. It will try again by itself.` };
      default: return { level: 'info', text: 'Ready.' };
    }
  }

  // The checklist the window shows: one row per thing that has to be true for taps to reach the bar.
  // state: done | wait | todo | problem | off.  action: 'dashboard' | 'check' (Check TikTok now).
  _steps() {
    const s = this.s, tk = s.tiktok;
    const paired = ['ready', 'starting', 'update_required'].includes(s.phase);
    const rows = [];
    rows.push(s.phase === 'pending_approval'
      ? { key: 'pc', label: 'This PC', state: 'todo', text: 'Waiting for you to click Approve on your dashboard.', action: 'dashboard' }
      : paired ? { key: 'pc', label: 'This PC', state: 'done', text: `Connected to ${s.hostName || 'your channel'}.` }
      : { key: 'pc', label: 'This PC', state: 'problem', text: 'Not connected to your account.', action: 'dashboard' });
    rows.push(!paired ? { key: 'tt', label: 'TikTok account', state: 'off', text: 'After this PC is approved.' }
      : s.verified && s.tiktokUsername ? { key: 'tt', label: 'TikTok account', state: 'done', text: `Verified as @${s.tiktokUsername}.` }
      : s.verified ? { key: 'tt', label: 'TikTok account', state: 'todo', text: 'Add your TikTok username on your dashboard.', action: 'dashboard' }
      : { key: 'tt', label: 'TikTok account', state: 'todo', text: 'Not verified yet. Dashboard: LIVE Link tab, TikTok verification.', action: 'dashboard' });
    rows.push(!paired ? { key: 'send', label: 'Sending taps', state: 'off', text: 'After this PC is approved.' }
      : s.enabled ? (s.dryRun ? { key: 'send', label: 'Sending taps', state: 'test', text: 'Test mode is on: taps are checked, nothing is added.' } : { key: 'send', label: 'Sending taps', state: 'done', text: 'On: taps fill your hype bar.' })
      : s.dryRun ? { key: 'send', label: 'Sending taps', state: 'test', text: 'Test mode: taps are checked, nothing is added.' }
      : { key: 'send', label: 'Sending taps', state: 'off', text: 'Not switched on for your channel yet. Turn on Test mode in Settings to try it.' });
    const running = this.link.running;
    let live;
    if (s.paused) live = { key: 'live', label: 'TikTok LIVE', state: 'off', text: 'Disconnected. Press Connect to start watching.' };
    else if (!running) live = { key: 'live', label: 'TikTok LIVE', state: 'off', text: 'Starts watching once the steps above are done.' };
    else if (tk.status === 'live') live = { key: 'live', label: 'TikTok LIVE', state: 'done', text: `LIVE now${tk.viewers ? ` · ${tk.viewers.toLocaleString()} watching` : ''}.` };
    else if (tk.status === 'connecting' || tk.status === 'reconnecting') live = { key: 'live', label: 'TikTok LIVE', state: 'wait', text: tk.status === 'connecting' ? 'Connecting to TikTok...' : 'Reconnecting to TikTok...' };
    else if (tk.status === 'offline') live = { key: 'live', label: 'TikTok LIVE', state: 'wait', text: `@${s.tiktokUsername} isn't LIVE yet.`, retryAt: tk.retryAt, action: 'check' };
    else if (tk.status === 'error' && tk.errorKind === 'rate-limit') live = { key: 'live', label: 'TikTok LIVE', state: 'problem', text: 'TikTok asked us to slow down.', retryAt: tk.retryAt };
    else if (tk.status === 'error') live = { key: 'live', label: 'TikTok LIVE', state: 'problem', text: `Can't reach TikTok (${tk.error || 'no answer'}).`, retryAt: tk.retryAt, action: 'check' };
    else live = { key: 'live', label: 'TikTok LIVE', state: 'wait', text: 'Getting ready...' };
    rows.push(live);
    rows.push(s.siteError ? { key: 'site', label: 'reactivvibeai.com', state: 'problem', text: "Can't reach the site. Retrying by itself; taps still count." }
      : s.pushRejected && this.now() - s.pushRejected.at < 60000 ? { key: 'site', label: 'reactivvibeai.com', state: 'problem', text: 'The site turned down some tap data. Counting again from now.' }
      : s.siteOkAt ? { key: 'site', label: 'reactivvibeai.com', state: 'done', text: 'Connected.', at: s.siteOkAt }
      : { key: 'site', label: 'reactivvibeai.com', state: 'wait', text: 'Connecting...' });
    return rows;
  }

  _render(throttle = false) {
    const now = this.mono();
    if (throttle && now - (this._lastRender || -Infinity) < 250) {
      if (!this._renderTimer) this._renderTimer = this.setTimeout(() => { this._renderTimer = null; this._render(); }, 250);
      return;
    }
    this._lastRender = now;
    this.s.message = this._message();
    this.s.steps = this._steps();
    const cutoff = now - 60000;
    while (this.tapWindow.length && this.tapWindow[0][0] < cutoff) this.tapWindow.shift();
    this.s.tapsPerMin = this.tapWindow.reduce((a, [, c]) => a + c, 0);
    // keep re-counting while taps are in the window, so taps/min falls back to 0 when the tapping stops
    if (this.tapWindow.length && !this.timers.tpm && !this.stopped) this.timers.tpm = this.setTimeout(() => { this.timers.tpm = null; this._render(); }, 5000);
    const st = this.s.tiktok.status;
    this.s.atom = this.s.paused || !this.link.running ? 'off' : st === 'live' ? 'live' : (st === 'connecting' || st === 'reconnecting') ? 'connecting' : 'off';
    this.emit('state', this.getState());
  }
}

module.exports = { Controller, semverLess, DEFAULTS };
