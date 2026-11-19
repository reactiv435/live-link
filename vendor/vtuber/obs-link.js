// The link to OBS (obs-websocket v5), for the one-click VTuber. Node only; no browser tricks in here, so the same
// module can sit inside LIVE Link later.
//   - The password is read from OBS's own settings file on this PC each time a connection is tried. It is held in
//     memory only for the moment of the login: never printed, never logged, never written anywhere, never sent to a page.
//   - While OBS is closed the link tries again every 2 s by itself.
//   - States, in plain codes for the page: 'closed' (OBS is not open), 'off' (OBS's remote control is switched off),
//     'password' (the login was refused, or OBS wants a password and none was found), 'ok'.
// Tests only: VTUBER_OBS_URL (where "OBS" listens) and VTUBER_OBS_CONFIG (a stand-in settings file).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('./vendor/ws');

const RETRY_MS = 2000;
const b64sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

/**
 * OBS keeps its remote-control settings here. Windows: %APPDATA%\obs-studio. macOS: ~/Library/Application Support/
 * obs-studio (OBS on a Mac is not sandboxed; unproven on a real Mac: when the file cannot be read the page's paste box
 * takes over). Linux: $XDG_CONFIG_HOME or ~/.config (the Flatpak build keeps its own copy; not looked for).
 * The same JSON keys everywhere: server_enabled, server_port, auth_required, server_password.
 */
function defaultConfigFile(platform = process.platform, env = process.env, home = os.homedir()) {
  const tail = ['obs-studio', 'plugin_config', 'obs-websocket', 'config.json'];
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, ...tail) : '';
  if (!home) return '';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...tail);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), ...tail);
}

/** { found, enabled, port, authRequired, password } from OBS's settings file; found false when it cannot be read. */
function readObsConfig(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const c = JSON.parse(text);
    if (!c || typeof c !== 'object') return { found: false };
    return {
      found: true,
      enabled: c.server_enabled !== false,
      port: Number(c.server_port) || 4455,
      authRequired: c.auth_required !== false,
      password: typeof c.server_password === 'string' ? c.server_password : '',
    };
  } catch { return { found: false }; }
}

class ObsError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

class ObsLink extends EventEmitter {
  /** opts: { url, configFile, retryMs } (url / configFile default to the env overrides, then to the real OBS on this PC) */
  constructor(opts = {}) {
    super();
    this.url = opts.url || process.env.VTUBER_OBS_URL || '';
    this.configFile = opts.configFile || process.env.VTUBER_OBS_CONFIG || defaultConfigFile();
    this.retryMs = opts.retryMs || RETRY_MS;
    this.state = 'closed';
    this.version = '';
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.timer = null;
    this.running = false;
    this.pasted = null;          // a password typed into the page (memory only)
    this.refused = null;         // a hash of the password OBS refused last, so the same one is not tried over and over
    this.connects = 0;
  }

  start() { if (this.running) return; this.running = true; this._try(); }

  stop() {
    this.running = false;
    clearTimeout(this.timer); this.timer = null;
    this._drop();
    this._set('closed');
  }

  /** The owner pasted the password by hand (fallback). Kept in memory for this run only. */
  setPassword(pw) {
    this.pasted = typeof pw === 'string' && pw ? pw : null;
    this.refused = null;
    if (this.running && this.state !== 'ok') { clearTimeout(this.timer); this._try(); }
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  _drop() {
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.removeAllListeners(); ws.on('error', () => {}); try { ws.terminate(); } catch { /* gone */ } }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ObsError('OBS connection closed', 'closed')); }
    this.pending.clear();
  }

  _again() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._try(), this.retryMs);
  }

  _try() {
    if (!this.running || this.ws) return;
    const cfg = readObsConfig(this.configFile);
    if (cfg.found && !cfg.enabled && !this.url) { this._set('off'); this._again(); return; }
    const url = this.url || 'ws://127.0.0.1:' + (cfg.found ? cfg.port : 4455);
    const password = this.pasted || (cfg.found ? cfg.password : '');
    let ws;
    try { ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 3000, maxPayload: 64 * 1024 * 1024 }); }
    catch { this._set('closed'); this._again(); return; }
    this.ws = ws;
    let identified = false;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const d = msg.d || {};
      if (msg.op === 0) {
        const identify = { rpcVersion: 1, eventSubscriptions: this.subs || 0 };
        if (d.authentication) {
          const tried = password ? b64sha('vt' + password) : '';
          if (!password || tried === this.refused) {             // nothing to log in with (or the same one OBS just refused)
            this._drop(); this._set('password'); this._again(); return;
          }
          identify.authentication = b64sha(b64sha(password + d.authentication.salt) + d.authentication.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (msg.op === 2) {
        identified = true;
        this.refused = null;
        this.connects++;
        this._set('ok');
      } else if (msg.op === 5) {
        if (this.subs) this.emit('event', d.eventType, d.eventData || {});
      } else if (msg.op === 7) {
        const p = this.pending.get(d.requestId);
        if (!p) return;
        this.pending.delete(d.requestId);
        clearTimeout(p.timer);
        const st = d.requestStatus || {};
        if (st.result) p.resolve(d.responseData || {});
        else p.reject(new ObsError(st.comment || 'OBS said no (' + st.code + ')', st.code));
      }
    });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this._drop();
      if (!identified && (code === 4009 || code === 4008)) {      // the login was refused
        this.refused = password ? b64sha('vt' + password) : null;
        if (this.pasted) this.pasted = null;                       // a wrong pasted password is forgotten
        this._set('password');
      } else this._set('closed');
      this._again();
    });
  }

  /**
   * Which of OBS's events are wanted (obs-websocket's bit mask; 0 = none, the default). Only the Mask asks for any:
   * InputVolumeMeters (1 << 16), the sound level of each input about 20 times a second. Kept across reconnects.
   */
  subscribe(mask) {
    mask = Number(mask) || 0;
    if (mask === (this.subs || 0)) return;
    this.subs = mask;
    const ws = this.ws;
    if (ws && this.state === 'ok' && ws.readyState === 1) { try { ws.send(JSON.stringify({ op: 3, d: { eventSubscriptions: mask } })); } catch { /* the next connect carries it */ } }
  }

  /** One request; rejects with ObsError (code = OBS's status code, or 'closed' / 'timeout'). */
  call(requestType, requestData, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || this.state !== 'ok' || ws.readyState !== 1) { reject(new ObsError('not connected to OBS', 'closed')); return; }
      const requestId = 'v' + (++this.seq);
      const timer = setTimeout(() => { if (this.pending.delete(requestId)) reject(new ObsError(requestType + ' timed out', 'timeout')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
    });
  }
}

module.exports = { ObsLink, ObsError, readObsConfig, defaultConfigFile };
