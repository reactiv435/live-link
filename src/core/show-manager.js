'use strict';
// Show helpers that ride along with the tap link:
//  - records the host's TikTok LIVE while LIVE Link watches it (recorder.js),
//  - after the LIVE ends, makes and sends the review clips (clip-jobs.js) when the site has clips switched on,
//  - reminds the host now and then to clear old recordings (never deletes anything by itself),
//  - nudges the host when nobody has tapped for 2 minutes during a song ("remind chat: taps fill the bar").
// Electron-free: main.js passes paths, and shows the notifications this emits.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Recorder } = require('./recorder');
const { ClipJobs } = require('./clip-jobs');
const { pickStream } = require('./stream-url');

const NUDGE_QUIET_MS = 120000;              // no taps for 2 min during a song...
const NUDGE_GAP_MS = 10 * 60000;            // ...at most one nudge per 10 min
const CLIP_DELAY_MS = 90000;                // after a LIVE ends, give the site time to close its last review
const REMIND_TOTAL_BYTES = 50 * 1024 ** 3;  // remind when recordings use more than 50 GB...
const REMIND_FREE_BYTES = 30 * 1024 ** 3;   // ...or the disk has less than 30 GB free
const REMIND_EVERY_MS = 14 * 24 * 3600000;  // and not more than every 2 weeks
const RETRY_LATER_MS = 30 * 60000;          // clips still owed after a run: try again in 30 min (3 times per app run)
const RESUME_WINDOW_MS = 7 * 24 * 3600000;  // unfinished clips of recordings up to a week old are picked up after a restart

function dirBytes(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); n += f.isDirectory() ? dirBytes(p) : fs.statSync(p).size; } } catch {}
  return n;
}

class ShowManager extends EventEmitter {
  constructor({ ctl, link, api, store, log = () => {}, ffmpegPath, fontFile, defaultRoot, spawn, fetch, now = Date.now, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, clipDelayMs = CLIP_DELAY_MS }) {
    super();
    this.ctl = ctl; this.link = link; this.api = api; this.store = store; this.log = log;
    this.now = now; this.setTimeout = st; this.clearTimeout = ct;
    this.defaultRoot = defaultRoot;
    this.clipDelayMs = clipDelayMs;
    this.serverNow = () => this.now() + (this.ctl.clockOffset || 0);
    this.recorder = new Recorder({ ffmpegPath, clock: this.serverNow, log, ...(spawn ? { spawn } : {}) });
    this.jobs = new ClipJobs({ api, ffmpegPath, fontFile, log, ...(spawn ? { spawn } : {}), ...(fetch ? { fetch } : {}), getOptions: () => this._clipOptions() });
    this.ffmpegOk = !!ffmpegPath && fs.existsSync(ffmpegPath);
    this.starting = false;
    this.room = null;
    this.clipState = null;          // { dir, phase, index, total, title, sent, failed }
    this.storage = { totalBytes: 0, freeBytes: null, remind: false };
    this.lastTapAt = 0; this.songSince = 0; this.lastTarget = null; this.lastNudgeAt = -Infinity;
    this.clipTimers = new Set();

    this.recorder.on('state', () => this._emit());
    this.recorder.on('finished', ({ dir }) => this._recordingFinished(dir));
    this.retries = new Map();       // dir -> automatic re-runs this app session (uploads that didn't finish)
    this.jobs.on('progress', (p) => {
      this.clipState = p.phase === 'done' || p.phase === 'error' ? null : p;
      if (p.phase === 'done' && p.sent > 0) this.emit('clipsSent', { dir: p.dir, sent: p.sent, failed: p.failed });
      if (p.phase === 'done' && p.failed > 0) this.emit('clipsFailed', { dir: p.dir, failed: p.failed });
      // Something still owed (an upload that kept failing, a full review not sent): try again in 30 min, up to 3 times.
      if ((p.phase === 'done' && p.pending) || p.phase === 'error') this._retryLater(p.dir);
      this._emit();
    });
    ctl.on('state', (s) => this._onState(s));
    link.on('like', (l) => {
      const c = Math.max(0, Number(l.count) || 0);
      if (c > 0) { this.lastTapAt = this.now(); this.recorder.noteActivity(c, this.serverNow()); }
    });
    // A gift is worth 10 taps per coin on the bar; it counts the same toward a song's hottest moment.
    link.on('gift', (g) => { if (g && g.coins > 0) this.recorder.noteActivity(g.coins * 10, this.serverNow()); });
    this.nudgeTimer = setInterval(() => this._checkNudge(), 15000);
    if (this.nudgeTimer.unref) this.nudgeTimer.unref();
    this._checkStorage(false);
  }

  root() { return this.store.get('recordRoot') || this.defaultRoot; }
  enabled() { return this.store.get('recordEnabled') !== false; }   // on unless the host switched it off
  clipsOn() { return !!(this.ctl.cfg && this.ctl.cfg.clips && this.ctl.cfg.clips.enabled); }

  _clipOptions() {
    const c = (this.ctl.cfg && this.ctl.cfg.clips) || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
    const o = { delayMs: num(c.delay_ms), padStartMs: num(c.pad_start_ms), padEndMs: num(c.pad_end_ms), hotSec: num(c.hot_sec), verdictSec: num(c.verdict_sec) };
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  }

  getState() {
    return {
      ffmpegOk: this.ffmpegOk,
      enabled: this.enabled(),
      root: this.root(),
      clipsOn: this.clipsOn(),
      recording: this.recorder.getState(),
      live: !!(this.lastS && this.lastS.connected && this.lastS.tiktok && this.lastS.tiktok.status === 'live'),
      hostStopped: !!this.hostStoppedRoom && !this.recorder.active,
      clips: this.clipState,
      storage: { ...this.storage },
    };
  }
  _emit() { this.emit('state', this.getState()); }

  // ---------------------------------------------------------------- recording follows the TikTok LIVE
  _onState(s) {
    const live = s.phase === 'ready' && s.connected && s.tiktok && s.tiktok.status === 'live';
    const roomId = s.tiktok && s.tiktok.roomId ? String(s.tiktok.roomId) : null;
    if (this.recorder.active && (!live && ['offline', 'idle'].includes(s.tiktok && s.tiktok.status) || s.phase !== 'ready')) this.stopRecording('the LIVE ended');
    else if (this.recorder.active && roomId && this.room && roomId !== this.room) this.stopRecording('a new LIVE began');
    else if (live && !this.recorder.active && !this.starting && this.enabled() && this.ffmpegOk && !(roomId && roomId === this.hostStoppedRoom)) this._start(s, roomId);
    // a new song resets the quiet timer for the nudge
    const target = s.target ? JSON.stringify(s.target) : null;
    if (target !== this.lastTarget) { this.lastTarget = target; this.songSince = this.now(); }
    this.lastS = s;
    if (live !== this.prevLive) { this.prevLive = live; this._emit(); }
    // Once the app is connected (and the site has clips on), pick up any clips a restart interrupted. Not mid-LIVE.
    if (s.phase === 'ready' && !live && !this.recorder.active) this._resumePending();
  }

  async _start(s, roomId) {
    this.starting = true;
    try {
      this.room = roomId;
      const dir = await this.recorder.start({ root: this.root(), handle: s.tiktokUsername, roomId, getStream: (fresh) => this._stream(fresh) });
      if (dir) this.log('info', `recording the LIVE to ${dir}`);
    } catch (e) { this.log('error', `recording: ${e && e.message}`); }
    finally { this.starting = false; this._emit(); }
  }

  // The stream link, from (1) the room info kept since connecting, (2) a fresh room info, (3) the LIVE page.
  async _stream(fresh) {
    const conn = this.link.conn;
    if (!conn) return null;
    let s = !fresh && conn.roomInfo ? pickStream(conn.roomInfo) : null;
    if (!s && typeof conn.fetchRoomInfo === 'function') {
      try { s = pickStream(await conn.fetchRoomInfo()); } catch (e) { this.log('info', `recording: room info refused (${e && e.message})`); }
    }
    if (!s && typeof this.link.liveRoomFromPage === 'function') s = pickStream(await this.link.liveRoomFromPage());
    if (!s) this.log('warn', 'recording: TikTok gave no stream link for this LIVE');
    else this.log('info', `recording: stream ${s.quality} ${s.kind}${s.codec ? ` ${s.codec}` : ''}${s.width ? ` ${s.width}x${s.height}` : ''}`);
    return s;
  }

  async stopRecording(why) {
    if (!this.recorder.active) return null;
    this.log('info', `recording stopped (${why})`);
    return this.recorder.stop();
  }

  // The host's Stop button: no automatic restart for the rest of this LIVE (a new LIVE records again).
  async stopByHost() {
    this.hostStoppedRoom = this.room || (this.lastS && this.lastS.tiktok && this.lastS.tiktok.roomId ? String(this.lastS.tiktok.roomId) : null);
    await this.stopRecording('stopped by the host');
    this._emit();
  }
  // The host's Record button during a LIVE they stopped (or with recording switched off for this one LIVE).
  resumeByHost() {
    this.hostStoppedRoom = null;
    if (this.lastS) this._onState(this.lastS);
    this._emit();
  }

  _recordingFinished(dir) {
    this.room = null;
    this._checkStorage(true);
    this._emit();
    if (!dir || !this.clipsOn()) return;
    const t = this.setTimeout(() => { this.clipTimers.delete(t); this.jobs.enqueue(dir); }, this.clipDelayMs);
    this.clipTimers.add(t);
  }

  _retryLater(dir) {
    const n = this.retries.get(dir) || 0;
    if (!dir || n >= 3 || !this.clipsOn()) return;
    this.retries.set(dir, n + 1);
    const t = this.setTimeout(() => { this.clipTimers.delete(t); this.jobs.enqueue(dir); }, RETRY_LATER_MS);
    this.clipTimers.add(t);
  }

  // After a restart (the app was closed or the PC shut down before the clips were done), and when clips get switched on:
  // recordings from the last 7 days whose clips aren't all sent are picked up again. A recording cut off by a crash
  // gets its end time from what was recorded.
  _resumePending() {
    if (this.resumed || !this.clipsOn()) return;
    this.resumed = true;
    const now = this.now();
    for (const x of this.listRecordings()) {
      if (x.recording || x.working) continue;
      const file = path.join(x.dir, 'session.json');
      let s;
      try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (s.clipsDoneAt) continue;
      if (!s.endedAt) {
        let end = s.startedAt || 0;
        for (const r of s.runs || []) {
          end = Math.max(end, r.endedAt || 0);
          const last = (r.samples || [])[Math.max(0, (r.samples || []).length - 1)];
          if (last) end = Math.max(end, last[1] + Math.max(0, (r.lastMediaMs || 0) - last[0]));
        }
        if (!(end > (s.startedAt || 0))) continue;
        s.endedAt = end;
        try { fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 1)); fs.renameSync(file + '.tmp', file); } catch { continue; }
      }
      if (now - s.endedAt > RESUME_WINDOW_MS) continue;
      this.log('info', `clips: picking up ${path.basename(x.dir)} again`);
      this.jobs.enqueue(x.dir);
    }
  }

  // ---------------------------------------------------------------- the recordings list (the window's manager)
  listRecordings() {
    const root = this.root();
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
    const out = [];
    for (const name of names) {
      const dir = path.join(root, name);
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch { continue; }
      const clips = Object.values(s.clips || {});
      out.push({
        dir, name, handle: s.handle, startedAt: s.startedAt, endedAt: s.endedAt,
        recording: this.recorder.active && this.recorder.dir === dir,
        bytes: dirBytes(dir),
        clips: { sent: clips.filter((c) => c.status === 'sent').length, failed: clips.filter((c) => c.status === 'failed').length, skipped: clips.filter((c) => c.status === 'not_recorded').length },
        working: !!(this.clipState && this.clipState.dir === dir) || this.jobs.running === dir,
      });
    }
    return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  _inRoot(dir) {
    const rel = path.relative(this.root(), String(dir || ''));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
  }

  makeClips(dir) {
    if (!this._inRoot(dir)) return { ok: false, error: 'not_a_recording' };
    if (this.recorder.active && this.recorder.dir === dir) return { ok: false, error: 'still_recording' };
    if (!this.clipsOn()) return { ok: false, error: 'clips_off' };
    this.jobs.enqueue(dir, { force: true });
    this._emit();
    return { ok: true };
  }

  deleteRecording(dir) {
    if (!this._inRoot(dir)) return { ok: false, error: 'not_a_recording' };
    if (this.recorder.active && this.recorder.dir === dir) return { ok: false, error: 'still_recording' };
    if (this.jobs.running === dir) return { ok: false, error: 'busy' };
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
    this._checkStorage(false);
    this._emit();
    return { ok: true };
  }

  previewPath() {
    const st = this.recorder.getState();
    return st.recording && st.dir ? path.join(st.dir, 'preview.jpg') : null;
  }

  // ---------------------------------------------------------------- reminders
  _checkStorage(mayRemind) {
    const root = this.root();
    const totalBytes = dirBytes(root);
    const freeBytes = Recorder.freeBytes(fs.existsSync(root) ? root : path.dirname(root));
    const heavy = totalBytes > REMIND_TOTAL_BYTES || (Number.isFinite(freeBytes) && freeBytes < REMIND_FREE_BYTES && totalBytes > 5 * 1024 ** 3);
    this.storage = { totalBytes, freeBytes: Number.isFinite(freeBytes) ? freeBytes : null, remind: heavy };
    const last = Number(this.store.get('storageRemindedAt')) || 0;
    if (mayRemind && heavy && this.now() - last > REMIND_EVERY_MS) {
      this.store.set('storageRemindedAt', this.now());
      this.emit('storageReminder', { totalBytes, freeBytes: this.storage.freeBytes });
    }
  }

  _checkNudge() {
    const s = this.lastS;
    if (!s || s.phase !== 'ready' || !s.connected || !s.siteLive || !s.target || s.paused || s.dryRun) return;
    const quietSince = Math.max(this.lastTapAt, this.songSince);
    if (this.now() - quietSince < NUDGE_QUIET_MS || this.now() - this.lastNudgeAt < NUDGE_GAP_MS) return;
    this.lastNudgeAt = this.now();
    this.emit('nudge');
  }

  // Quitting: close the recording properly (ffmpeg finishes its last piece), at most ~8 s.
  async shutdown() {
    clearInterval(this.nudgeTimer);
    for (const t of this.clipTimers) this.clearTimeout(t);
    this.clipTimers.clear();
    if (this.recorder.active) await this.recorder.stop();
  }
}

module.exports = { ShowManager, NUDGE_QUIET_MS, CLIP_DELAY_MS };
