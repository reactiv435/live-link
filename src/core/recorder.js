'use strict';
// Records the host's TikTok LIVE on this computer while LIVE Link watches it.
//
// ffmpeg copies the stream as it arrives (no re-encoding, so it's light on the CPU) into 10-minute MP4 pieces written
// as fragments, so every piece stays playable even if the computer crashes mid-show. A second output saves a small
// preview picture every few seconds for the window. If the stream drops while the LIVE goes on, recording restarts
// with a fresh link from TikTok in the same folder ("runs").
//
// Times: everything stored is SERVER time (the clock the site's review timestamps use). Each run keeps samples of
// [media ms, server ms] so the clip maker can map a review's start/end onto the recording, even across drops.
//
// Folder: <root>/<YYYY-MM-DD HH.MM> @handle/
//   session.json   what was recorded (runs, samples, stream quality) + clip status per review
//   part-<run>-<n>.mp4, parts-<run>.csv   the recording pieces and ffmpeg's list of their start/end times
//   taps.json      taps + gift hype per second (server seconds), for finding each song's hottest moment
//   preview.jpg    the latest preview picture

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const SEGMENT_SEC = 600;
const PREVIEW_EVERY_SEC = 3;
const RESTART_MS = [3000, 5000, 10000, 20000, 30000];
const FAST_RETRY_MS = 4000;            // no video link yet: ask TikTok again this often...
const FAST_RETRY_FOR_MS = 3 * 60000;   // ...for the first 3 minutes of the wait, then back off
const MIN_FREE_BYTES = 2 * 1024 ** 3;        // don't start (or keep) recording below 2 GB free
const SAMPLE_EVERY_MS = 15000;
const FLUSH_EVERY_MS = 30000;
const STOP_GRACE_MS = 8000;

function safeName(s) { return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'live'; }
function folderStamp(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function recordArgs(url, run, { realtime = false, segmentSec = SEGMENT_SEC } = {}) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  if (/^https?:/i.test(url)) a.push('-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (realtime) a.push('-re');                    // tests: play a file at stream speed
  // Only keyframes are decoded (for the preview picture); the recording itself is a straight copy.
  a.push('-skip_frame', 'nokey', '-i', url);
  a.push('-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-f', 'segment', '-segment_time', String(segmentSec), '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps', '1', '-segment_list', `parts-${run}.csv`, '-segment_list_type', 'csv',
    `part-${run}-%03d.mp4`);
  a.push('-map', '0:v:0', '-vf', `fps=1/${PREVIEW_EVERY_SEC},scale=360:-2`, '-update', '1', '-q:v', '7', '-y', 'preview.jpg');
  return a;
}

class Recorder extends EventEmitter {
  // ffmpegPath: the bundled ffmpeg. clock(): SERVER time in ms. spawn: child_process.spawn (injectable for tests).
  constructor({ ffmpegPath, clock = Date.now, log = () => {}, spawn = require('child_process').spawn, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, realtime = false, segmentSec = SEGMENT_SEC } = {}) {
    super();
    this.segmentSec = segmentSec;
    this.ffmpegPath = ffmpegPath;
    this.clock = clock;
    this.log = log;
    this.spawn = spawn;
    this.setTimeout = st;
    this.clearTimeout = ct;
    this.realtime = realtime;
    this.session = null;      // the recording in progress (session.json contents)
    this.dir = null;
    this.child = null;
    this.active = false;
    this.stopping = null;
    this.restartTimer = null;
    this.flushTimer = null;
    this.restartStep = 0;
    this.taps = new Map();    // server second -> weight
    this.state = { recording: false, dir: null, startedAt: null, bytes: 0, error: null, previewAt: null, moments: 0, momentAt: null, video: false, waitingSince: null };
  }

  getState() { return { ...this.state }; }
  _set(patch) { Object.assign(this.state, patch); this.emit('state', this.getState()); }

  static freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
  }

  // getStream(fresh) -> { url, kind, quality, codec, width?, height? } or null. Resolves the session folder.
  async start({ root, handle, roomId, getStream }) {
    if (this.active) return this.dir;
    if (!this.ffmpegPath || !fs.existsSync(this.ffmpegPath)) { this._set({ error: 'ffmpeg_missing' }); this.log('error', 'recording: ffmpeg is missing'); return null; }
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) { this._set({ error: 'folder' }); this.log('error', `recording: can't create ${root}: ${e.message}`); return null; }
    if (Recorder.freeBytes(root) < MIN_FREE_BYTES) { this._set({ error: 'disk_full' }); this.log('warn', 'recording: less than 2 GB free, not recording'); return null; }
    const startedAt = this.clock();
    let dir = path.join(root, `${folderStamp(Date.now())} @${safeName(handle)}`);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${folderStamp(Date.now())} @${safeName(handle)} (${i})`);
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.getStream = getStream;
    this.taps = new Map();
    this.session = { v: 1, handle: String(handle || ''), roomId: roomId ? String(roomId) : null, startedAt, endedAt: null, stream: null, runs: [], clips: {}, moments: [] };
    this.active = true;
    this.stopping = null;
    this.restartStep = 0;
    this._write();
    this.noLinkSince = null;
    this._set({ recording: true, dir, startedAt, bytes: 0, error: null, previewAt: null, moments: 0, video: false, waitingSince: Date.now() });
    this.flushTimer = setInterval(() => { this._write(); this._writeTaps(); }, FLUSH_EVERY_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
    await this._run(false);
    return dir;
  }

  // Taps (1 each) and gift hype (10 per coin) at a SERVER time, for each song's hottest moment.
  noteActivity(weight, atMs) {
    if (!this.active || !(weight > 0)) return;
    const sec = Math.floor(Number(atMs) / 1000);
    this.taps.set(sec, (this.taps.get(sec) || 0) + weight);
  }

  // The host's "Clip that": a moment at a SERVER time (pressed just after it happened). Saved at once, so a crash keeps it.
  markMoment(atMs, by = 'button') {
    if (!this.active || !this.session) return null;
    const m = { at: Math.round(Number(atMs)), by: String(by) };
    (this.session.moments = this.session.moments || []).push(m);
    this._write();
    this._set({ moments: this.session.moments.length, momentAt: Date.now() });
    return m;
  }

  async _run(fresh) {
    if (!this.active || this.stopping) return;
    let stream = null;
    try { stream = await this.getStream(fresh); } catch (e) { this.log('warn', `recording: no stream link (${e && e.message})`); }
    if (!this.active || this.stopping) return;
    if (!stream || !stream.url) {
      // TikTok can take a while to hand out the video link when a LIVE starts: keep asking every few seconds at first,
      // so the opening of the show (greetings, news) is not lost.
      if (this.noLinkSince == null) this.noLinkSince = Date.now();
      this._scheduleRestart('no stream link from TikTok', Date.now() - this.noLinkSince < FAST_RETRY_FOR_MS ? FAST_RETRY_MS : null);
      return;
    }
    this.noLinkSince = null;
    if (!this.session.stream) this.session.stream = { quality: stream.quality, codec: stream.codec || null, kind: stream.kind, width: stream.width || null, height: stream.height || null };
    const index = this.session.runs.length;
    const run = { index, startedAt: this.clock(), endedAt: null, samples: [], lastMediaMs: 0 };
    this.session.runs.push(run);
    this._write();
    const child = this.spawn(this.ffmpegPath, recordArgs(stream.url, index, { realtime: this.realtime, segmentSec: this.segmentSec }), { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const began = Date.now();
    let buf = '', errTail = '', lastSampleAt = 0, best = null;
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq), v = line.slice(eq + 1);
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const mediaMs = Math.floor(Number(v) / 1000);
          if (!(mediaMs > 0)) continue;
          if (!this.state.video) { this.noLinkSince = null; this._set({ video: true, waitingSince: null }); this.log('info', 'recording: video is coming in'); }
          const wall = this.clock() - mediaMs;               // server time when media time 0 would have arrived
          best = best === null ? wall : Math.min(best, wall);
          run.lastMediaMs = mediaMs;
          const now = Date.now();
          if (!run.samples.length || now - lastSampleAt >= SAMPLE_EVERY_MS) {
            run.samples.push([mediaMs, best + mediaMs]);       // the earliest arrival seen = least network delay
            lastSampleAt = now; best = null;
            if (this.restartStep && now - began > 60000) this.restartStep = 0;
          }
        } else if (k === 'total_size') {
          const n = Number(v);
          if (n > 0) this._set({ bytes: this._bytesBefore(index) + n });
        }
      }
    });
    child.stderr.on('data', (chunk) => { errTail = (errTail + chunk.toString()).slice(-600); });
    child.on('error', (e) => this.log('error', `recording: ffmpeg failed to start (${e.message})`));
    child.on('close', (code) => {
      run.endedAt = this.clock();
      this.child = null;
      if (this.state.video && !this.stopping) this._set({ video: false, waitingSince: Date.now() });
      this._write();
      if (this.stopping) { this.stopping.resolve(); return; }
      if (!this.active) return;
      this.log('warn', `recording: ffmpeg stopped (code ${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`);
      if (Recorder.freeBytes(this.dir) < MIN_FREE_BYTES) { this._set({ error: 'disk_full' }); this._finish(); return; }
      this._scheduleRestart(`ffmpeg exited with code ${code}`);
    });
    this._previewWatch();
  }

  _bytesBefore(index) {
    // bytes of earlier runs (a restart starts its own count)
    let n = 0;
    try { for (const f of fs.readdirSync(this.dir)) { const m = /^part-(\d+)-\d+\.mp4$/.exec(f); if (m && Number(m[1]) < index) n += fs.statSync(path.join(this.dir, f)).size; } } catch {}
    return n;
  }

  _previewWatch() {
    const p = path.join(this.dir, 'preview.jpg');
    let last = 0;
    const tick = () => {
      if (!this.child) return;
      try { const m = fs.statSync(p).mtimeMs; if (m > last) { last = m; this._set({ previewAt: Date.now() }); } } catch {}
      const t = this.setTimeout(tick, 2000); if (t && t.unref) t.unref();
    };
    tick();
  }

  _scheduleRestart(why, fastMs = null) {
    const ms = fastMs || RESTART_MS[Math.min(this.restartStep, RESTART_MS.length - 1)];
    if (!fastMs) this.restartStep++;
    this.log('info', `recording: restarting in ${ms / 1000} s (${why})`);
    this.clearTimeout(this.restartTimer);
    this.restartTimer = this.setTimeout(() => { this.restartTimer = null; this._run(true); }, ms);
  }

  // Stops cleanly ('q' lets ffmpeg close the last piece properly). Resolves the session folder.
  async stop() {
    if (!this.active) return this.dir;
    this.clearTimeout(this.restartTimer); this.restartTimer = null;
    const child = this.child;
    if (child) {
      let resolve; const done = new Promise((r) => { resolve = r; });
      this.stopping = { resolve };
      try { child.stdin.write('q'); child.stdin.end(); } catch {}
      const kill = this.setTimeout(() => { try { child.kill(); } catch {} }, STOP_GRACE_MS);
      await done;
      this.clearTimeout(kill);
    }
    this._finish();
    return this.dir;
  }

  _finish() {
    this.active = false;
    clearInterval(this.flushTimer); this.flushTimer = null;
    if (this.session) { this.session.endedAt = this.clock(); this._write(); this._writeTaps(); }
    this._set({ recording: false });
    this.emit('finished', { dir: this.dir, session: this.session });
  }

  _write() {
    if (!this.dir || !this.session) return;
    try {
      // Keep any clip status another part of the app wrote meanwhile.
      const file = path.join(this.dir, 'session.json');
      let clips = this.session.clips;
      try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur && cur.clips) clips = { ...cur.clips, ...clips }; } catch {}
      this.session.clips = clips;
      fs.writeFileSync(file + '.tmp', JSON.stringify(this.session, null, 1));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { this.log('warn', `recording: can't save session.json (${e.message})`); }
  }

  _writeTaps() {
    if (!this.dir) return;
    try { fs.writeFileSync(path.join(this.dir, 'taps.json'), JSON.stringify(Object.fromEntries(this.taps))); } catch {}
  }
}

module.exports = { Recorder, recordArgs, safeName, folderStamp, SEGMENT_SEC, MIN_FREE_BYTES };
