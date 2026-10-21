'use strict';
// Show helpers that ride along with the tap link:
//  - records the host's TikTok LIVE while LIVE Link watches it (recorder.js),
//  - after the LIVE ends, makes and sends the review clips (clip-jobs.js) when the site has clips switched on,
//  - reminds the host now and then to clear old recordings (never deletes anything by itself),
//  - nudges the host when nobody has tapped for 2 minutes during a song ("remind chat: taps fill the bar"),
//  - "Clip that": the host marks moments while recording; each becomes a phone clip after the LIVE (kept on this PC).
// Electron-free: main.js passes paths, and shows the notifications this emits.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Recorder, FAILURE_TEXT, cleanErr } = require('./recorder');
const { ClipJobs } = require('./clip-jobs');
const { streamCandidates, whyNoStream } = require('./stream-url');

const NUDGE_QUIET_MS = 120000;              // no taps for 2 min during a song...
const NUDGE_GAP_MS = 10 * 60000;            // ...at most one nudge per 10 min
const CLIP_DELAY_MS = 90000;                // after a LIVE ends, give the site time to close its last review
const REMIND_TOTAL_BYTES = 50 * 1024 ** 3;  // remind when recordings use more than 50 GB...
const REMIND_FREE_BYTES = 30 * 1024 ** 3;   // ...or the disk has less than 30 GB free
const REMIND_EVERY_MS = 14 * 24 * 3600000;  // and not more than every 2 weeks
const RETRY_LATER_MS = 30 * 60000;          // clips still owed after a run: try again in 30 min (3 times per app run)
const RESUME_WINDOW_MS = 7 * 24 * 3600000;  // unfinished clips of recordings up to a week old are picked up after a restart
const WAF_COOLDOWN_MS = 10 * 60000;         // TikTok sent its bot check instead of the LIVE page: leave the page alone 10 min
const REFUSED_COOLDOWN_MS = 5 * 60000;      // a source answered 403/429: leave it alone 5 min (asking more extends a block)
const ERROR_COOLDOWN_MS = 15000;            // any other failed request: not again for 15 s
// The fewest ms between two asks of a source. Room info (webcast room/info) is the main one and may follow the recorder's
// pace (every 4 s at the start of a LIVE); api-live and the LIVE page are TikTok's lookup pages, which it rate-limits per
// network (the tap link needs them too), so they are asked at most every 30 s. In between, their last answer counts.
const MIN_EVERY_MS = { room: 0, api: 30000, page: 30000, kept: 0 };
// Answers that mean "TikTok is refusing this network", not "there is no video".
const BLOCK_CODES = new Set(['waf', 'http_403', 'http_429', 'timeout', 'network']);
// Why this computer isn't recording the LIVE, as status reason codes for the site (^[a-z_]{1,40}$).
const ISSUE_TEXT = {
  ...FAILURE_TEXT,
  recording_disk_full: 'Not recording: less than 2 GB free on the recordings drive',
  recorder_missing: 'Not recording: this copy of LIVE Link is missing its recorder (ffmpeg)',
  recording_folder: "Not recording: LIVE Link can't write to the recordings folder",
};

// A failed TikTok request -> { code, http, message } for the log and session.json. got (the connector's HTTP client)
// puts the status in response.statusCode; the connector may wrap the original error.
function errInfo(e) {
  const inner = (e && (e.exception || e.cause)) || null;
  const http = Number((e && e.response && e.response.statusCode) || (inner && inner.response && inner.response.statusCode) || (e && e.statusCode) || 0) || null;
  const message = cleanErr((e && e.message) || e) + (inner && inner.message && inner.message !== (e && e.message) ? ` (${cleanErr(inner.message, 120)})` : '');
  const raw = String((e && e.code) || (inner && inner.code) || '');
  let code = 'error';
  if (raw === 'waf' || raw === 'no_room_data') code = raw;
  else if (http) code = `http_${http}`;
  else if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out/i.test(raw + ' ' + message)) code = 'timeout';
  else if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up/i.test(raw + ' ' + message)) code = 'network';
  else if (/blocked|captcha|SIGI_STATE/i.test(message)) code = 'waf';
  return { code, http, message: message.slice(0, 200) };
}

// How one source's answer reads in the window and the status (short, no links).
function tryText(t) {
  const what = t.code === 'restricted' ? 'status 4003110 (restricted)'
    : t.code === 'waf' ? "TikTok's bot check (WAF page)"
    : t.code === 'ended' ? 'says the LIVE ended'
    : t.code === 'no_stream_data' ? 'no video links'
    : t.code === 'cooling_down' ? 'resting after a refusal'
    : t.http ? `HTTP ${t.http}` : t.code === 'tiktok_error' ? cleanErr(t.error, 60) : t.code;
  return `${t.source}: ${what}`;
}

// Bytes of the LIVE itself in a recording folder: the pieces, or the full-show file(s) they were joined into.
function mediaBytes(dir, s) {
  let n = 0;
  const joined = new Set(((s && s.joined && s.joined.files) || []).map((f) => f && f.file).filter(Boolean));
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^part-\d+-\d+\.mp4$/.test(f) || joined.has(f)) { try { n += fs.statSync(path.join(dir, f)).size; } catch {} }
    }
  } catch {}
  return n;
}

// Why a recording has nothing in it: what the recorder wrote down (2.0.7+), or worked out from an older session.json
// (2.0.6 saved no reason: no runs = TikTok never gave the video address).
function recordingFailure(s) {
  const d = (s && s.diag) || {};
  const last = d.failure || (Array.isArray(d.failures) && d.failures[d.failures.length - 1]) || null;
  if (last && last.reason) return { reason: last.reason, text: ISSUE_TEXT[last.reason] || last.text || last.reason, detail: last.detail || null };
  const runs = Array.isArray(s && s.runs) ? s.runs : [];
  if (!runs.length) return { reason: 'stream_unavailable', text: 'TikTok never gave LIVE Link the video for this LIVE (no video address)', detail: null };
  return { reason: 'recording_failed', text: 'LIVE Link got a video address from TikTok, but no video arrived', detail: (runs.find((r) => r && r.error) || {}).error || null };
}

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

    this._wireRecorder(this.recorder);
    this.cooldown = new Map();      // stream source -> do not ask before (ms)
    this.lastAnswer = new Map();    // stream source -> { at, entry }: its last answer (for paced sources)
    this._issueKey = '';             // the recording issue last told to the controller ('' = none)
    this.retries = new Map();       // dir -> automatic re-runs this app session (uploads that didn't finish)
    this.waiting = new Set();       // recordings waiting out the short pause before their clips start
    this.lastClips = null;          // { dir, sent, failed, total, pending, at }: the last finished clip run, for "safe to close"
    this.jobs.on('progress', (p) => {
      this.clipState = ['done', 'error', 'moments_done', 'fullshow_done'].includes(p.phase) ? null : p;
      if (p.phase === 'done') this.lastClips = { dir: p.dir, sent: p.sent, failed: p.failed, total: p.total, pending: !!p.pending, notRecorded: !!p.notRecorded, at: this.now() };
      if (p.phase === 'fullshow_done' && p.ok && p.files) { this.lastFullShow = { dir: p.dir, files: p.files, at: this.now() }; this.emit('fullShowReady', { dir: p.dir, files: p.files }); }
      if (p.phase === 'moments_done' && p.made > 0) this.emit('momentsMade', { dir: p.dir, made: p.made, outDir: p.outDir });
      if (p.phase === 'done' && p.sent > 0) this.emit('clipsSent', { dir: p.dir, sent: p.sent, failed: p.failed });
      if (p.phase === 'done' && p.failed > 0) this.emit('clipsFailed', { dir: p.dir, failed: p.failed });
      // Something still owed (an upload that kept failing, a full review not sent): try again in 30 min, up to 3 times.
      if ((p.phase === 'done' && p.pending) || p.phase === 'error') this._retryLater(p.dir);
      this._emit();
    });
    // All clip work done (nothing running, queued or about to start): tell the host it's safe to close.
    this.jobs.on('idle', ({ dir }) => {
      if (this.waiting.size || this.jobs.queue.length) return;
      this.doneAt = this.now();
      this.emit('safeToClose', { dir, clips: this.lastClips && this.lastClips.dir === dir ? this.lastClips : null, fullShow: this.lastFullShow && this.lastFullShow.dir === dir ? this.lastFullShow : null });
      this._emit();
    });
    ctl.on('state', (s) => this._onState(s));
    link.on('like', (l) => {
      const c = Math.max(0, Number(l.count) || 0);
      if (c > 0) { this.lastTapAt = this.now(); this.recorder.noteActivity(c, this.serverNow()); }
    });
    // A gift is worth 10 taps per coin on the bar; it counts the same toward a song's hottest moment.
    link.on('gift', (g) => { if (g && g.coins > 0) this.recorder.noteActivity(g.coins * 10, this.serverNow()); });
    this.nudgeTimer = setInterval(() => { this._checkNudge(); }, 15000);
    if (this.nudgeTimer.unref) this.nudgeTimer.unref();
    this._checkStorage(false);
  }

  _wireRecorder(rec) {
    rec.on('state', () => { this._syncIssue(); this._emit(); });
    rec.on('failure', (f) => this.emit('recordingFailed', { ...f, text: ISSUE_TEXT[f.reason] || f.text }));
    rec.on('finished', ({ dir }) => this._recordingFinished(dir));
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
      // Clip work still to do on this computer (closing LIVE Link now would leave it for next time).
      busy: !!(this.jobs.running || this.jobs.queue.length || this.waiting.size),
      lastClips: this.lastClips,
      lastFullShow: this.lastFullShow || null,
      doneAt: this.doneAt || null,
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
    this.liveNow = live;
    this._syncIssue();
    if (live !== this.prevLive) { this.prevLive = live; this._emit(); }
    // Once the app is connected (and the site has clips on), pick up any clips a restart interrupted. Not mid-LIVE.
    if (s.phase === 'ready' && !live && !this.recorder.active) this._resumePending();
  }

  async _start(s, roomId) {
    this.starting = true;
    try {
      this.room = roomId;
      this.cooldown.clear(); this.lastAnswer.clear();
      const dir = await this.recorder.start({ root: this.root(), handle: s.tiktokUsername, roomId, app: this.ctl.appVersion || null, getStream: (fresh) => this._stream(fresh) });
      if (dir) this.log('info', `recording the LIVE to ${dir}`);
    } catch (e) { this.log('error', `recording: ${e && e.message}`); }
    finally { this.starting = false; this._emit(); }
  }

  // The stream link. Every try asks every place TikTok lists the video (a fresh try asks TikTok first, the kept copy
  // last): a fresh room info, TikTok's api-live answer, the LIVE page, and the room info kept since connecting. The first
  // with links wins (all of its links go along, so the recorder can fall back to another quality or format). When none
  // has one, what each answered (HTTP status, TikTok's status code, bot check...) goes to session.json and the log, and
  // the verdict (restricted / blocked / unavailable) is what the host and the site are told if it lasts.
  async _stream(fresh) {
    const conn = this.link.conn;
    if (!conn) { this.recorder.noteStreamErrors([{ source: 'tiktok', code: 'not_connected', error: 'not connected to the LIVE right now' }], { reason: 'stream_unavailable', detail: 'not connected to the LIVE right now' }); return null; }
    const sources = {
      room: ['room info', typeof conn.fetchRoomInfo === 'function' ? () => conn.fetchRoomInfo() : null],
      api: ['api-live', typeof this.link.liveRoomFromApi === 'function' ? () => this.link.liveRoomFromApi() : null],
      page: ['LIVE page', typeof this.link.liveRoomFromPage === 'function' ? () => this.link.liveRoomFromPage() : null],
      kept: ['kept room info', conn.roomInfo ? async () => conn.roomInfo : null],
    };
    const order = fresh ? ['room', 'api', 'page', 'kept'] : ['kept', 'room', 'api', 'page'];
    const tries = [];        // what was asked this time (-> session.json)
    const view = [];         // plus the last answer of a source not asked this time (-> the verdict)
    const note = (key, entry) => { tries.push(entry); view.push(entry); this.lastAnswer.set(key, { at: this.now(), entry }); };
    for (const key of order) {
      const [source, get] = sources[key];
      if (!get) continue;
      const prev = this.lastAnswer.get(key);
      if ((this.cooldown.get(key) || 0) > this.now()) { view.push(prev ? prev.entry : { source, code: 'cooling_down', error: 'refused recently: not asked this time' }); continue; }
      if (prev && this.now() - prev.at < MIN_EVERY_MS[key]) { view.push(prev.entry); continue; }
      try {
        const answer = await get();
        if (!answer) { note(key, { source, code: 'empty', error: 'no answer' }); continue; }
        const all = streamCandidates(answer);
        if (all.length) {
          const s = { ...all[0], from: source, alternates: all.slice(1) };
          if (this._lastStreamLog !== `${source}|${s.quality}|${s.kind}`) {
            this._lastStreamLog = `${source}|${s.quality}|${s.kind}`;
            this.log('info', `recording: stream ${s.quality} ${s.kind}${s.codec ? ` ${s.codec}` : ''}${s.width ? ` ${s.width}x${s.height}` : ''} (from the ${source}; ${all.length} link${all.length === 1 ? '' : 's'})`);
          }
          this.lastAnswer.delete(key);
          if (tries.length) this.recorder.noteStreamErrors(tries);
          return s;
        }
        const why = whyNoStream(answer);
        note(key, { source, code: why.code, http: null, status: why.status || null, error: why.text });
      } catch (e) {
        const info = errInfo(e);
        note(key, { source, code: info.code, http: info.http, error: info.message });
        this.cooldown.set(key, this.now() + (info.code === 'waf' ? WAF_COOLDOWN_MS : (info.http === 403 || info.http === 429) ? REFUSED_COOLDOWN_MS : ERROR_COOLDOWN_MS));
      }
    }
    const verdict = this._verdict(view);
    this.recorder.noteStreamErrors(tries, verdict);
    const summary = view.map(tryText).join(' · ') || 'no source to ask';
    if (summary !== this._lastNoStreamLog || this.now() - (this._lastNoStreamLogAt || 0) > 600000) {
      this._lastNoStreamLog = summary; this._lastNoStreamLogAt = this.now();
      this.log('warn', `recording: no video link from TikTok (${verdict.reason}): ${summary}`);
    }
    this._lastStreamLog = null;
    return null;
  }

  // Why no source had a link. Room info answering 4003110 while TikTok's LIVE data says the LIVE is on = a LIVE TikTok
  // won't show a signed-out viewer (18+). Every request refused (403/429, bot check, timeouts) = this network is blocked.
  _verdict(tries) {
    const detail = cleanErr(tries.map(tryText).join(' · '), 300) || 'no source to ask';
    const asked = tries.filter((t) => !['kept room info', 'tiktok'].includes(t.source) && t.code !== 'cooling_down' && t.code !== 'empty');
    const refusedAll = asked.length > 0 && asked.every((t) => BLOCK_CODES.has(t.code) || /^http_(4|5)\d\d$/.test(t.code));
    let reason = 'stream_unavailable';
    if (tries.some((t) => t.code === 'restricted') && this.liveNow !== false) reason = 'stream_restricted';
    else if (refusedAll) reason = 'stream_blocked';
    return { reason, detail };
  }

  // Ask TikTok for the video right away (the card's "Try again" and "Check TikTok now").
  retryStream() {
    this.cooldown.clear(); this.lastAnswer.clear();
    return this.recorder.retryNow();
  }

  // What the host and the site are told about recording while the TikTok LIVE is on (null = recording fine, or the
  // host chose not to record this one).
  recordingIssue() {
    const r = this.recorder.getState();
    const live = !!this.liveNow;
    if (!live) return null;
    if (r.recording) return r.failure ? { reason: r.failure.reason, text: ISSUE_TEXT[r.failure.reason] || r.failure.text, detail: r.failure.detail || null, since: r.failure.since } : null;
    const room = this.lastS && this.lastS.tiktok && this.lastS.tiktok.roomId ? String(this.lastS.tiktok.roomId) : null;
    if (!this.enabled() || (this.hostStoppedRoom && (!room || room === this.hostStoppedRoom))) return null;   // the host chose not to record
    if (!this.ffmpegOk) return { reason: 'recorder_missing', text: ISSUE_TEXT.recorder_missing, detail: null };
    if (r.error === 'disk_full') return { reason: 'recording_disk_full', text: ISSUE_TEXT.recording_disk_full, detail: null };
    if (r.error === 'folder') return { reason: 'recording_folder', text: ISSUE_TEXT.recording_folder, detail: null };
    if (r.error === 'ffmpeg_missing') return { reason: 'recorder_missing', text: ISSUE_TEXT.recorder_missing, detail: null };
    return null;
  }

  _syncIssue() {
    const issue = this.recordingIssue();
    const key = issue ? `${issue.reason}|${issue.detail || ''}` : '';
    if (key === this._issueKey) return;
    this._issueKey = key;
    if (typeof this.ctl.setRecordingIssue === 'function') this.ctl.setRecordingIssue(issue);
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

  // "Clip that": mark this moment of the recording (the host presses it just after something happened).
  markMoment(by = 'button') {
    if (!this.recorder.active) return { ok: false, error: 'not_recording' };
    const m = this.recorder.markMoment(this.serverNow(), by);
    this.log('info', `moment marked (${by})`);
    return { ok: !!m, count: (this.recorder.session && this.recorder.session.moments || []).length };
  }

  _recordingFinished(dir) {
    this.room = null;
    this._checkStorage(true);
    this._emit();
    // Every recording gets its full-show file; review clips when the site has them on; moments when the host marked some.
    if (!dir) return;
    const reviews = this.clipsOn();
    this.waiting.add(dir);
    const t = this.setTimeout(() => { this.clipTimers.delete(t); this.waiting.delete(dir); this.jobs.enqueue(dir, { reviews }); this._emit(); }, this.clipDelayMs);
    this.clipTimers.add(t);
    this._emit();
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
  // "Clip that" moments are made whether or not the site has review clips on (they stay on this computer).
  _resumePending() {
    const doReviews = !this.resumedReviews && this.clipsOn();
    const doMoments = !this.resumedMoments;
    if (!doReviews && !doMoments) return;
    if (doReviews) this.resumedReviews = true;
    this.resumedMoments = true;
    const now = this.now();
    for (const x of this.listRecordings()) {
      if (x.recording || x.working) continue;
      const file = path.join(x.dir, 'session.json');
      let s;
      try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const reviews = doReviews && !s.clipsDoneAt;
      const momentsOwed = doMoments && (s.moments || []).length > Object.keys(s.momentClips || {}).length;
      const fullShowOwed = doMoments && !s.joined && fs.readdirSync(x.dir).some((f) => /^part-\d+-\d+\.mp4$/.test(f));
      if (!reviews && !momentsOwed && !fullShowOwed) continue;
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
      this.jobs.enqueue(x.dir, { reviews });
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
      const recording = this.recorder.active && this.recorder.dir === dir;
      const recordedBytes = mediaBytes(dir, s);
      out.push({
        dir, name, handle: s.handle, startedAt: s.startedAt, endedAt: s.endedAt,
        recording,
        bytes: dirBytes(dir),
        recordedBytes,
        // Nothing of the LIVE on disk is never shown as a normal recording: "Recording failed" with the reason.
        failed: recording ? (this.recorder.getState().failure ? { reason: this.recorder.getState().failure.reason, text: ISSUE_TEXT[this.recorder.getState().failure.reason] } : null)
          : (recordedBytes > 0 ? null : recordingFailure(s)),
        clips: { sent: clips.filter((c) => c.status === 'sent').length, failed: clips.filter((c) => c.status === 'failed').length, skipped: clips.filter((c) => c.status === 'not_recorded').length },
        moments: { marked: (s.moments || []).length, made: Object.keys(s.momentClips || {}).length },
        fullShow: s.joined && Array.isArray(s.joined.files) ? s.joined.files.map((f) => f.file) : null,
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
    if (!this.clipsOn() && !this._momentsIn(dir)) return { ok: false, error: 'clips_off' };
    this.jobs.enqueue(dir, { force: true, reviews: this.clipsOn() });
    this._emit();
    return { ok: true };
  }

  _momentsIn(dir) {
    try { return (JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).moments || []).length; } catch { return 0; }
  }

  // The recording's "Clip that" clips folder (inside the recordings folder only).
  momentsDir(dir) { return this._inRoot(dir) ? path.join(dir, 'moments') : null; }

  // The recording's full-show file (the first one, if a dropped stream made several), for "Open full show".
  fullShowFile(dir) {
    if (!this._inRoot(dir)) return null;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
      const f = s.joined && s.joined.files && s.joined.files[0];
      return f ? path.join(dir, f.file) : null;
    } catch { return null; }
  }

  // "Make full show" for a recording that has none yet (older than a week, or joining was put off for disk space).
  makeFullShow(dir) {
    if (!this._inRoot(dir)) return { ok: false, error: 'not_a_recording' };
    if (this.recorder.active && this.recorder.dir === dir) return { ok: false, error: 'still_recording' };
    this.jobs.enqueue(dir, { reviews: false });
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

module.exports = { ShowManager, NUDGE_QUIET_MS, CLIP_DELAY_MS, ISSUE_TEXT, errInfo, recordingFailure };
