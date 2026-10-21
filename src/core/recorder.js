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
// No video link from TikTok: how often to ask again, by how long it has been missing. It never gives up while the LIVE
// is on (2.0.6 also kept asking, every 30 s, but nothing showed that every answer came back empty).
const NO_LINK_RETRY = [
  { untilMs: 3 * 60000, everyMs: 4000 },    // the first 3 minutes: every 4 s (the opening of the show matters)
  { untilMs: 10 * 60000, everyMs: 15000 },  // then every 15 s up to 10 minutes
  { untilMs: Infinity, everyMs: 60000 },    // then once a minute for the rest of the LIVE
];
const FAIL_AFTER_MS = 60000;           // LIVE but nothing written to disk for this long = "Not recording" (host + site)
const HEALTH_EVERY_MS = 5000;
const BAD_LINK_MS = 10 * 60000;        // a link that gave no video is skipped for 10 min: the next quality/format is tried
const MAX_STREAM_ERRORS = 40;          // distinct "why no video" entries kept in session.json
const MAX_FAILURES = 20;
// What the host and the site are told while the LIVE isn't being recorded. The keys are the status reason codes the
// site receives (lowercase letters and underscores, at most 40: ^[a-z_]{1,40}$).
const FAILURE_TEXT = {
  stream_restricted: "TikTok won't share this LIVE's video with LIVE Link (it answers 'restricted', code 4003110), which usually means the LIVE is limited to adults (18+) or to signed-in viewers",
  stream_blocked: "TikTok is refusing LIVE Link's requests for the video from this network",
  stream_unavailable: "TikTok hasn't given LIVE Link the video for this LIVE",
  recording_failed: 'TikTok gave LIVE Link a video address, but no video arrived',
};
const MIN_FREE_BYTES = 2 * 1024 ** 3;        // don't start (or keep) recording below 2 GB free
const SAMPLE_EVERY_MS = 15000;
const FLUSH_EVERY_MS = 30000;
const STOP_GRACE_MS = 8000;

// Error text for logs and session.json: no links (they can carry signatures), no line breaks.
function cleanErr(s, n = 200) {
  return String(s || '').replace(/https?:\/\/[^\s'"<>]+/gi, (u) => { try { return `<${new URL(u).host}>`; } catch { return '<link>'; } })
    .replace(/\s+/g, ' ').trim().slice(0, n);
}

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
  // now(): this computer's clock (waits and timeouts). failAfterMs: no recorded bytes this long while LIVE = a failure.
  constructor({ ffmpegPath, clock = Date.now, now = Date.now, log = () => {}, spawn = require('child_process').spawn, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout,
    setInterval: si = setInterval, clearInterval: ci = clearInterval, realtime = false, segmentSec = SEGMENT_SEC, failAfterMs = FAIL_AFTER_MS, healthEveryMs = HEALTH_EVERY_MS } = {}) {
    super();
    this.segmentSec = segmentSec;
    this.ffmpegPath = ffmpegPath;
    this.clock = clock;
    this.now = now;
    this.log = log;
    this.spawn = spawn;
    this.setTimeout = st;
    this.clearTimeout = ct;
    this.setInterval = si;
    this.clearInterval = ci;
    this.failAfterMs = failAfterMs;
    this.healthEveryMs = healthEveryMs;
    this.realtime = realtime;
    this.healthTimer = null;
    this.badUrls = new Map();  // link -> skip until (it gave no video)
    this.verdict = null;       // why the last ask for a link came back empty: { reason, detail } (from show-manager)
    this.lastOutcome = null;   // 'no_link' | 'link': what the last try got
    this.lastRecError = null;  // ffmpeg's last words when a run wrote nothing
    this.session = null;      // the recording in progress (session.json contents)
    this.dir = null;
    this.child = null;
    this.active = false;
    this.stopping = null;
    this.restartTimer = null;
    this.flushTimer = null;
    this.restartStep = 0;
    this.taps = new Map();    // server second -> weight
    // failure: { reason, text, detail, since } while the LIVE is on but nothing has been written for failAfterMs.
    this.state = { recording: false, dir: null, startedAt: null, bytes: 0, error: null, previewAt: null, moments: 0, momentAt: null, video: false, waitingSince: null,
      failure: null, tries: 0, nextTryAt: null };
  }

  getState() { return { ...this.state }; }
  _set(patch) { Object.assign(this.state, patch); this.emit('state', this.getState()); }

  static freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
  }

  // getStream(fresh) -> { url, kind, quality, codec, width?, height? } or null. Resolves the session folder.
  async start({ root, handle, roomId, getStream, app = null }) {
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
    // streamErrors: why TikTok's video couldn't be had (each distinct answer once, with a count); diag: tries, failures.
    this.session = { v: 1, app: app ? String(app) : null, handle: String(handle || ''), roomId: roomId ? String(roomId) : null, startedAt, endedAt: null, stream: null, runs: [], clips: {}, moments: [],
      streamErrors: [], diag: { tries: 0, lastTryAt: null, firstVideoAt: null, failure: null, failures: [] } };
    this.active = true;
    this.stopping = null;
    this.restartStep = 0;
    this.badUrls = new Map();
    this.verdict = null; this.lastOutcome = null; this.lastRecError = null;
    this.liveSince = this.now(); this.lastGrowAt = 0; this.lastBytes = 0;
    this._write();
    this.noLinkSince = null;
    this._set({ recording: true, dir, startedAt, bytes: 0, error: null, previewAt: null, moments: 0, video: false, waitingSince: this.now(), failure: null, tries: 0, nextTryAt: null });
    this.flushTimer = this.setInterval(() => { this._write(); this._writeTaps(); }, FLUSH_EVERY_MS);
    if (this.flushTimer && this.flushTimer.unref) this.flushTimer.unref();
    this.healthTimer = this.setInterval(() => this.checkHealth(), this.healthEveryMs);
    if (this.healthTimer && this.healthTimer.unref) this.healthTimer.unref();
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
    this.restartTimer = null;
    const d = this._diag();
    d.tries = (d.tries || 0) + 1;
    d.lastTryAt = new Date(this.now()).toISOString();
    let stream = null;
    try { stream = await this.getStream(fresh); } catch (e) {
      this.log('warn', `recording: no stream link (${cleanErr(e && e.message)})`);
      this.noteStreamErrors([{ source: 'recorder', code: 'error', error: e && e.message }]);
    }
    if (!this.active || this.stopping) return;
    stream = this._choose(stream);
    this._set({ tries: d.tries });
    if (!stream) {
      // TikTok can take a while to hand out the video link when a LIVE starts: keep asking every few seconds at first,
      // so the opening of the show (greetings, news) is not lost, then less often, for as long as the LIVE is on.
      this.lastOutcome = 'no_link';
      if (this.noLinkSince == null) this.noLinkSince = this.now();
      this._scheduleNoLink();
      return;
    }
    this.lastOutcome = 'link';
    this.noLinkSince = null;
    if (!this.session.stream) this.session.stream = { quality: stream.quality, codec: stream.codec || null, kind: stream.kind, width: stream.width || null, height: stream.height || null };
    const index = this.session.runs.length;
    const run = { index, startedAt: this.clock(), endedAt: null, samples: [], lastMediaMs: 0, quality: stream.quality || null, kind: stream.kind || null, from: stream.from || null };
    this.session.runs.push(run);
    this._write();
    const child = this.spawn(this.ffmpegPath, recordArgs(stream.url, index, { realtime: this.realtime, segmentSec: this.segmentSec }), { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const began = this.now();
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
          if (!this.state.video) {
            this.noLinkSince = null;
            if (!this._diag().firstVideoAt) this._diag().firstVideoAt = new Date(this.now()).toISOString();
            this._set({ video: true, waitingSince: null });
            this.log('info', 'recording: video is coming in');
          }
          const wall = this.clock() - mediaMs;               // server time when media time 0 would have arrived
          best = best === null ? wall : Math.min(best, wall);
          run.lastMediaMs = mediaMs;
          const now = this.now();
          if (!run.samples.length || now - lastSampleAt >= SAMPLE_EVERY_MS) {
            run.samples.push([mediaMs, best + mediaMs]);       // the earliest arrival seen = least network delay
            lastSampleAt = now; best = null;
            if (this.restartStep && now - began > 60000) this.restartStep = 0;
          }
        }
        // (total_size is "N/A" for a segmented recording: the size is read from the disk, see checkHealth)
      }
    });
    child.stderr.on('data', (chunk) => { errTail = (errTail + chunk.toString()).slice(-600); });
    child.on('error', (e) => this.log('error', `recording: ffmpeg failed to start (${e.message})`));
    child.on('close', (code) => {
      run.endedAt = this.clock();
      this.child = null;
      run.bytes = this._mediaBytes(index);
      if (!run.bytes) {
        // Nothing written: that link (or ffmpeg) didn't work. Skip it for a while so the next quality/format is tried.
        run.error = cleanErr(errTail.trim().split('\n').pop() || `ffmpeg exited with code ${code}`);
        this.lastRecError = run.error;
        this.badUrls.set(stream.url, this.now() + BAD_LINK_MS);
        this.noteStreamErrors([{ source: 'ffmpeg', code: 'no_video', error: `${stream.quality || ''} ${stream.kind || ''}: ${run.error}` }]);
        this.log('warn', `recording: run ${index} (${stream.quality} ${stream.kind}${stream.from ? ` from the ${stream.from}` : ''}) wrote nothing: ${run.error}`);
      }
      if (this.state.video && !this.stopping) this._set({ video: false, waitingSince: this.now() });
      this._write();
      if (this.stopping) { this.stopping.resolve(); return; }
      if (!this.active) return;
      // (ffmpeg's message can quote the signed stream link: never logged as is)
      this.log('warn', `recording: ffmpeg stopped (code ${code})${errTail ? `: ${cleanErr(errTail.trim().split('\n').pop())}` : ''}`);
      if (Recorder.freeBytes(this.dir) < MIN_FREE_BYTES) { this._set({ error: 'disk_full' }); this._finish(); return; }
      this._scheduleRestart(`ffmpeg exited with code ${code}`);
    });
    this._previewWatch();
  }

  // Bytes of the recording pieces on disk (one run's, or all of them).
  _mediaBytes(index = null) {
    let n = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^part-(\d+)-\d+\.mp4$/.exec(f);
        if (m && (index === null || Number(m[1]) === index)) n += fs.statSync(path.join(this.dir, f)).size;
      }
    } catch {}
    return n;
  }

  // The best link not known to fail, with the source it came from. All of them failed: start over with the first.
  _choose(stream) {
    if (!stream || !stream.url) return null;
    const now = this.now();
    for (const [u, until] of this.badUrls) if (until <= now) this.badUrls.delete(u);
    const { alternates, ...first } = stream;
    const all = [first, ...(Array.isArray(alternates) ? alternates : [])].filter((c) => c && c.url).map((c) => ({ ...c, from: c.from || first.from || null }));
    const ok = all.find((c) => !this.badUrls.has(c.url));
    if (ok) return ok;
    this.badUrls.clear();
    return all[0];
  }

  _diag() {
    if (!this.session) return {};
    return this.session.diag || (this.session.diag = { tries: 0, lastTryAt: null, firstVideoAt: null, failure: null, failures: [] });
  }

  // What each try to get TikTok's video found (from show-manager): every distinct answer is kept once in session.json
  // (source, code, HTTP status, message, first/last time, count), so a host can send the file. `verdict` = why it came
  // back empty overall: { reason: 'stream_restricted' | 'stream_blocked' | 'stream_unavailable', detail }.
  noteStreamErrors(tries, verdict) {
    if (verdict !== undefined) this.verdict = verdict;
    if (!this.session || !Array.isArray(tries) || !tries.length) return;
    const list = this.session.streamErrors = this.session.streamErrors || [];
    const at = new Date(this.now()).toISOString();
    let added = false;
    for (const t of tries) {
      const e = { source: cleanErr(t.source, 40), code: cleanErr(t.code || 'error', 40), http: Number(t.http) || null, error: cleanErr(t.error) };
      const hit = list.find((x) => x.source === e.source && x.code === e.code && x.http === e.http && x.error === e.error);
      if (hit) { hit.last = at; hit.count = (hit.count || 0) + 1; continue; }
      list.push({ ...e, first: at, last: at, count: 1 });
      added = true;
    }
    while (list.length > MAX_STREAM_ERRORS) {
      let oldest = 0;
      for (let i = 1; i < list.length; i++) if (list[i].last < list[oldest].last) oldest = i;
      list.splice(oldest, 1);
    }
    if (added) this._write();
  }

  // Every few seconds while recording: how much is on disk, and whether the LIVE is actually being saved. Nothing new
  // written for failAfterMs (no video link, or a link that gives nothing) = a failure the host and the site are told.
  checkHealth() {
    if (!this.active || this.stopping || !this.dir) return;
    const now = this.now();
    const bytes = this._mediaBytes();
    if (bytes > this.lastBytes) { this.lastBytes = bytes; this.lastGrowAt = now; }
    if (bytes !== this.state.bytes) this._set({ bytes });
    const okSince = Math.max(this.liveSince || 0, this.lastGrowAt || 0);
    if (now - okSince < this.failAfterMs) { if (this.state.failure) this._clearFailure(); return; }
    let reason, detail;
    if (this.lastOutcome === 'link' || this.child) {
      reason = 'recording_failed';
      detail = this.child ? (this.lastRecError || 'ffmpeg is running but nothing is being written') : (this.lastRecError || 'ffmpeg stopped');
    } else {
      reason = (this.verdict && FAILURE_TEXT[this.verdict.reason]) ? this.verdict.reason : 'stream_unavailable';
      detail = (this.verdict && this.verdict.detail) || 'no answer from TikTok had a video link';
    }
    this._setFailure(reason, cleanErr(detail, 300), okSince);
  }

  _setFailure(reason, detail, since) {
    const cur = this.state.failure;
    if (cur && cur.reason === reason && cur.detail === detail) return;
    const failure = { reason, text: FAILURE_TEXT[reason], detail, since: cur ? cur.since : since };
    const d = this._diag();
    const at = new Date(this.now()).toISOString();
    d.failure = { ...failure, since: new Date(failure.since).toISOString() };
    d.failures = d.failures || [];
    if (!cur || cur.reason !== reason) {
      const open = d.failures[d.failures.length - 1];
      if (open && !open.to) open.to = at;
      d.failures.push({ reason, from: cur ? at : new Date(failure.since).toISOString(), to: null, detail });
      if (d.failures.length > MAX_FAILURES) d.failures.splice(0, d.failures.length - MAX_FAILURES);
    } else d.failures[d.failures.length - 1].detail = detail;
    this._set({ failure });
    this._write();
    this.log('error', `recording: NOT RECORDING (${reason}) for ${Math.round((this.now() - failure.since) / 1000)} s: ${detail}`);
    if (!cur) this.emit('failure', failure);
  }

  _clearFailure() {
    const d = this._diag();
    const open = (d.failures || [])[(d.failures || []).length - 1];
    if (open && !open.to) open.to = new Date(this.now()).toISOString();
    d.failure = null;
    this._set({ failure: null });
    this._write();
    this.log('info', 'recording: the LIVE is being saved again');
  }

  // The host pressed "Try again" (or "Check TikTok now"): ask TikTok for the video right away, every few seconds again.
  retryNow() {
    if (!this.active || this.stopping || this.child) return false;
    this.clearTimeout(this.restartTimer); this.restartTimer = null;
    this.noLinkSince = this.now();
    this.badUrls.clear();
    this.log('info', 'recording: asking TikTok for the video now');
    this._run(true);
    return true;
  }

  _scheduleNoLink() {
    const waited = this.now() - this.noLinkSince;
    const step = NO_LINK_RETRY.find((s) => waited < s.untilMs) || NO_LINK_RETRY[NO_LINK_RETRY.length - 1];
    // One log line per change of pace (and every 10 min), not one every 4 s.
    if (this._noLinkPace !== step.everyMs || this.now() - (this._noLinkLoggedAt || 0) > 600000) {
      this._noLinkPace = step.everyMs; this._noLinkLoggedAt = this.now();
      this.log('warn', `recording: no video link from TikTok for ${Math.round(waited / 1000)} s${this.verdict ? ` (${this.verdict.reason}: ${cleanErr(this.verdict.detail, 200)})` : ''}; asking again every ${step.everyMs / 1000} s`);
    }
    this.clearTimeout(this.restartTimer);
    this.restartTimer = this.setTimeout(() => { this.restartTimer = null; this._run(true); }, step.everyMs);
    this._set({ nextTryAt: this.now() + step.everyMs });
  }

  _previewWatch() {
    const p = path.join(this.dir, 'preview.jpg');
    let last = 0;
    const tick = () => {
      if (!this.child) return;
      try { const m = fs.statSync(p).mtimeMs; if (m > last) { last = m; this._set({ previewAt: this.now() }); } } catch {}
      const t = this.setTimeout(tick, 2000); if (t && t.unref) t.unref();
    };
    tick();
  }

  _scheduleRestart(why) {
    const ms = RESTART_MS[Math.min(this.restartStep, RESTART_MS.length - 1)];
    this.restartStep++;
    this.log('info', `recording: restarting in ${ms / 1000} s (${why})`);
    this.clearTimeout(this.restartTimer);
    this.restartTimer = this.setTimeout(() => { this.restartTimer = null; this._run(true); }, ms);
    this._set({ nextTryAt: this.now() + ms });
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
    this.clearInterval(this.flushTimer); this.flushTimer = null;
    this.clearInterval(this.healthTimer); this.healthTimer = null;
    if (this.session) {
      this.session.endedAt = this.clock();
      // How it went, for the Recordings list: nothing on disk = "Recording failed" with the reason.
      const d = this._diag();
      const bytes = this._mediaBytes();
      d.recordedBytes = bytes;
      const open = (d.failures || [])[(d.failures || []).length - 1];
      if (open && !open.to) open.to = new Date(this.now()).toISOString();
      if (!bytes && !d.failure) {
        const reason = this.lastOutcome === 'link' ? 'recording_failed' : (this.verdict && FAILURE_TEXT[this.verdict.reason] ? this.verdict.reason : 'stream_unavailable');
        const detail = cleanErr(reason === 'recording_failed' ? (this.lastRecError || 'no video arrived') : ((this.verdict && this.verdict.detail) || 'no answer from TikTok had a video link'), 300);
        d.failure = { reason, text: FAILURE_TEXT[reason], detail, since: new Date(this.liveSince || this.now()).toISOString() };
      }
      d.result = bytes ? ((d.failures || []).length ? 'partial' : 'ok') : 'failed';
      this._write(); this._writeTaps();
    }
    this._set({ recording: false, failure: null, nextTryAt: null });
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

module.exports = { Recorder, recordArgs, safeName, folderStamp, cleanErr, SEGMENT_SEC, MIN_FREE_BYTES, NO_LINK_RETRY, FAIL_AFTER_MS, FAILURE_TEXT };
