'use strict';
// 2.2.0: the VTuber inside LIVE Link. This file starts and watches the VTuber's own process (vendor/vtuber/
// livelink-host.js, an Electron utility process: its own Node, no window) and turns what it says into the VTuber card.
// Electron-free: main.js passes `spawn` (utilityProcess.fork wrapped), the folders and the log.
//
// Why a separate process: the VTuber cuts a sound spectrum 60 times a second and talks to OBS all the time. Whatever
// happens in there (a bug, a busy loop, a crash) must never reach the TikTok feed, the tap crediting, the recorder or
// the clips. A crash only means: the avatar page in OBS hides itself within 2 s and the card offers "Open VTuber" again.
//
// Messages (the VTuber repo's livelink-host.js documents them): we send { t: 'event', ev } and { t: 'stop' }; it sends
// ready / state / camera-window / front / log / failed / stopped. Viewer names and comment text pass through `event`
// only: they are never logged and never kept here.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const STOP_WAIT_MS = 9000;       // the VTuber switches the avatar off in OBS (under 3 s) and closes its camera window first
// How long the VTuber's process gets to say "ready". It says so the moment its local server listens (before any OBS
// work, which is reported on its own), so this only covers the process starting and loading its files; 90 s leaves
// room for a weak or virus-scanned PC. A slow OBS, or a slow window list, can no longer run into this wait.
const START_WAIT_MS = 90000;
const NAMES = { ryo: 'Ryo', melanie: 'Melanie', mask: 'the Mask' };

/**
 * The card on the main screen, in plain words: { show, tone: 'off' | 'wait' | 'ok' | 'on' | 'fix', title, text, button }.
 * `h` = VtuberHost.getState(); enabled = the site has not switched the card off (a missing switch means ON).
 */
function vtuberCard(h, { enabled = true, platform = process.platform } = {}) {
  const open = 'Open VTuber';
  const card = (tone, text, button = open) => ({ show: true, tone, title: 'VTuber', text, button });
  if (!h) return { show: false };
  if (!enabled && h.status !== 'running' && h.status !== 'starting') return { show: false };
  if (!h.installed) return card('fix', 'VTuber is missing from this install. Download LIVE Link again from reactivvibeai.com and install it.', null);
  if (h.status === 'starting') return card('wait', 'Starting VTuber...', null);
  if (h.status === 'stopping') return card('wait', 'Closing VTuber...', null);
  if (h.status !== 'running') {
    if (h.problem === 'STANDALONE') return card('fix', 'VTuber is already open from your desktop shortcut. Close that window, then press Open VTuber.');
    if (h.problem === 'NO_PORT') return card('fix', 'Another program is using VTuber\'s place on this computer. Restart the computer, then press Open VTuber.');
    if (h.problem === 'TEST') return card('fix', 'This is a test copy of LIVE Link without a test OBS, so VTuber stays off.', null);
    if (h.problem) return card('fix', 'VTuber stopped. Press Open VTuber.');
    return card('off', 'Be Ryo, Melanie or the Mask on your stream. It follows your face through your camera in OBS. You need OBS open.');
  }
  const s = h.vt || {};
  const show = 'Show VTuber';
  if (s.obs === 'closed') return card('fix', 'VTuber needs OBS. Open OBS: it puts the character on top of your camera there.', show);
  if (s.obs === 'off') return card('fix', 'OBS has its remote control switched off. In OBS click Tools, then WebSocket Server Settings, tick "Enable WebSocket server" and click OK.', show);
  if (s.obs === 'password') return card('fix', 'OBS asks for its password. Paste it in the VTuber window: in OBS click Tools, WebSocket Server Settings, Show Connect Info, and copy the password.', show);
  if (s.obs === 'ok' && !s.camera && s.cameraAsk) return card('fix', 'OBS has more than one camera. In the VTuber window, click the picture that shows you.', show);
  if (s.obs === 'ok' && !s.camera) return card('fix', 'VTuber could not find a camera it knows in OBS. It works with DroidCam and Video Capture Device sources.', show);
  const av = s.avatar || {};
  if (av.problem === 'name-taken') return card('fix', 'OBS already has something else called "VTuber Avatar". Rename or delete it in OBS, then press Open VTuber.', show);
  if (av.problem === 'not-visible') return card('fix', 'Your camera is hidden in every OBS scene. Show your camera in the scene you stream, and the character goes on top of it.', show);
  if (av.problem === 'failed') return card('fix', 'VTuber could not add the character to OBS. Close the VTuber window and press Open VTuber again.', show);
  if (av.removed) return card('fix', 'VTuber was taken out of OBS. In the VTuber window open More and press "Add VTuber to OBS".', show);
  if (s.on && av.silent) return card('fix', 'OBS is not showing the character. In OBS right-click "VTuber Avatar" and click Refresh.', show);
  if (s.on) return card('on', `VTuber is ON: your viewers see ${NAMES[s.character] || 'your character'} instead of your camera. Press OFF in the VTuber window, or close it, to show your camera again.`, show);
  if (!s.pageEver) return card('wait', 'Opening the VTuber window...', show);
  return card('ok', 'VTuber is ready. In the VTuber window pick Ryo, Melanie or the Mask and press ON.', show);
}

/** the site's switch for the card: a missing switch means ON; only an explicit vtuber.enabled === false turns it off */
function vtuberEnabled(cfg) { return !(cfg && cfg.vtuber && cfg.vtuber.enabled === false); }

/**
 * Of the windows Electron can capture, the ONE the VTuber named: the source whose id carries that exact window number
 * ('window:<number>:<n>'). No match by title, no closest pick: no match = null (the page reads the camera the slower way).
 */
function pickCameraSource(list, want) {
  const hwnd = want && Number(want.hwnd);
  if (!Number.isInteger(hwnd) || hwnd <= 0 || !Array.isArray(list)) return null;
  return list.find((s) => s && typeof s.id === 'string' && s.id.startsWith('window:' + hwnd + ':')) || null;
}

class VtuberHost extends EventEmitter {
  /**
   * opts: spawn(entry, env) -> { post(msg), onMessage(fn), onExit(fn), kill() }   (main.js: an Electron utility process)
   *       dir (the VTuber's files: resources/vtuber, or vendor/vtuber in development), dataDir (userData/vtuber),
   *       log(level, text), platform, test (a test run: it must name a pretend OBS, see config()),
   *       testConfig: { obsUrl, obsConfig, ports, soundCmd, windowCapture } for test runs only
   */
  constructor(opts = {}) {
    super();
    this.spawn = opts.spawn;
    this.dir = opts.dir;
    this.dataDir = opts.dataDir;
    this.log = opts.log || (() => {});
    this.platform = opts.platform || process.platform;
    this.test = !!opts.test;
    this.testConfig = opts.testConfig || null;
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.startWaitMs = opts.startWaitMs || START_WAIT_MS;
    this.stopWaitMs = opts.stopWaitMs || STOP_WAIT_MS;
    this.child = null;
    this.status = 'idle';            // idle | starting | running | stopping
    this.problem = null;             // why the last start or run ended badly: STANDALONE | NO_PORT | ERROR | CRASH | TEST
    this.port = 0;
    this.vt = null;                  // the VTuber's own state (plain codes)
    this.cameraWindow = null;        // { hwnd, title } the VTuber page may capture, or null
    this.stats = { events: 0, starts: 0, crashes: 0 };
    this._stopWaiters = [];
  }

  get entry() { return path.join(this.dir || '', 'livelink-host.js'); }
  get installed() { try { return fs.statSync(this.entry).isFile(); } catch { return false; } }
  get running() { return this.status === 'running' && !!this.child; }
  /** ON right now: the character covers the host's camera in OBS (an update must not restart LIVE Link then) */
  get isOn() { return this.running && !!(this.vt && this.vt.on); }

  getState() {
    return { installed: this.installed, status: this.status, problem: this.problem, port: this.port, vt: this.vt, cameraWindow: this.cameraWindow ? { ...this.cameraWindow } : null };
  }
  _emit() { this.emit('state', this.getState()); }

  /** the settings handed to the VTuber's process; null when a test run names no pretend OBS (it must never reach a real one) */
  config() {
    const cfg = { dataDir: this.dataDir };
    // First version on a Mac: the camera is read through OBS's own pictures, so macOS never asks for Screen Recording.
    cfg.windowCapture = this.platform === 'win32';
    if (this.test) {
      const t = this.testConfig || {};
      let u = null;
      try { u = new URL(t.obsUrl); } catch { u = null; }
      if (!u || !u.port || u.port === '4455' || !t.obsConfig || !Array.isArray(t.ports) || !t.ports.length || t.ports.some((p) => Number(p) === 8791 || Number(p) === 4455)) return null;
      cfg.obsUrl = t.obsUrl; cfg.obsConfig = t.obsConfig; cfg.ports = t.ports.map(Number); cfg.test = true;
      if (Array.isArray(t.soundCmd)) cfg.soundCmd = t.soundCmd;
      if (t.windowCapture !== undefined) cfg.windowCapture = !!t.windowCapture;
    }
    return cfg;
  }

  /** Starts the VTuber's process. Resolves when it listens ({ ok: true, port }) or says why not ({ ok: false, problem }). */
  start() {
    if (this.status === 'running') return Promise.resolve({ ok: true, port: this.port });
    if (this._starting) return this._starting;
    if (this.status === 'stopping') return Promise.resolve({ ok: false, problem: 'BUSY' });
    const fail = (problem) => { this.problem = problem; this.status = 'idle'; this._emit(); return Promise.resolve({ ok: false, problem }); };
    if (!this.installed) return fail('ERROR');
    const cfg = this.config();
    if (!cfg) { this.log('warn', 'VTuber: a test run without a pretend OBS: not started'); return fail('TEST'); }
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
    let child;
    try { child = this.spawn(this.entry, { VTUBER_HOST_CONFIG: JSON.stringify(cfg) }); }
    catch (e) { this.log('warn', `VTuber: could not start its process (${e && e.message})`); return fail('ERROR'); }
    this.child = child;
    this.status = 'starting'; this.problem = null; this.port = 0; this.vt = null; this.cameraWindow = null;
    this.stats.starts++;
    this._emit();
    this._starting = new Promise((resolve) => {
      let settled = false;
      const settle = (r) => { if (settled) return; settled = true; this.clearTimeout(timer); this._starting = null; resolve(r); };
      const timer = this.setTimeout(() => {
        if (settled || this.child !== child) return;
        this.log('warn', 'VTuber: no answer from its process: stopped');
        this.problem = 'ERROR';
        try { child.kill(); } catch {}
        settle({ ok: false, problem: 'ERROR' });
      }, this.startWaitMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      child.onMessage((m) => {
        if (this.child !== child || !m || typeof m !== 'object') return;
        try { this._message(m, settle); } catch (e) { this.log('warn', `VTuber: a message was skipped (${(e && e.name) || 'error'})`); }
      });
      child.onExit((code) => {
        if (this.child !== child) return;
        const was = this.status;
        this.child = null;
        if (was === 'running') { this.problem = 'CRASH'; this.stats.crashes++; this.log('warn', `VTuber: its process ended by itself (code ${code})`); }
        else if (was === 'starting' && !this.problem) this.problem = 'ERROR';
        this.status = 'idle'; this.port = 0; this.vt = null; this.cameraWindow = null;
        this._emit();
        settle({ ok: false, problem: this.problem || 'ERROR' });
        for (const w of this._stopWaiters.splice(0)) w();
        this.emit('exit', { code, problem: this.problem });
      });
    });
    return this._starting;
  }

  _message(m, settle) {
    if (m.t === 'ready') {
      this.status = 'running'; this.port = Number(m.port) || 0; this.problem = null;
      this.log('info', `VTuber: running on this computer (place ${this.port})`);
      this._emit();
      settle({ ok: true, port: this.port });
    } else if (m.t === 'state') {
      const { t, ...rest } = m;
      this.vt = rest;
      this._emit();
    } else if (m.t === 'camera-window') {
      this.cameraWindow = m.none || !m.hwnd ? null : { hwnd: Number(m.hwnd), title: String(m.title || '') };
      this.emit('camera-window', this.cameraWindow);
    } else if (m.t === 'front') this.emit('front');
    else if (m.t === 'log') this.log('info', `VTuber: ${String(m.line || '').slice(0, 400)}`);
    else if (m.t === 'failed') {
      this.problem = m.code === 'STANDALONE' || m.code === 'NO_PORT' ? m.code : 'ERROR';
      this.log('warn', `VTuber: did not start (${this.problem}${m.detail ? `: ${String(m.detail).slice(0, 200)}` : ''})`);
      settle({ ok: false, problem: this.problem });
    } else if (m.t === 'stopped') {
      if (this.status === 'running') this.status = 'stopping';   // it stopped in an orderly way: not a crash
      this._emit();
    }
  }

  /** One viewer event, handed over inside the app (no HTTP). False when no VTuber runs here. */
  event(ev) {
    if (!this.running) return false;
    try { this.child.post({ t: 'event', ev }); this.stats.events++; return true; } catch { return false; }
  }

  /** Asks the VTuber to stop (avatar OFF in OBS first) and waits for its process to end; ends it after 9 s regardless. */
  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    if (this.status !== 'stopping') { this.status = 'stopping'; this._emit(); }
    try { child.post({ t: 'stop' }); } catch {}
    return new Promise((resolve) => {
      const timer = this.setTimeout(() => { if (this.child === child) { this.log('warn', 'VTuber: its process did not end in time: ended now'); try { child.kill(); } catch {} } }, this.stopWaitMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._stopWaiters.push(() => { this.clearTimeout(timer); resolve(); });
    });
  }

  /** LIVE Link is going away right now: no waiting */
  kill() { const c = this.child; if (c) { try { c.post({ t: 'stop' }); } catch {} try { c.kill(); } catch {} } }
}

module.exports = { VtuberHost, vtuberCard, vtuberEnabled, pickCameraSource, NAMES };
