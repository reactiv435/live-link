'use strict';
// Show helpers that ride along with the tap link:
//  - records the host's TikTok LIVE while LIVE Link watches it (recorder.js),
//  - after the LIVE ends, makes and sends the review clips (clip-jobs.js) when the site has clips switched on,
//  - reminds the host now and then to clear old recordings (never deletes anything by itself),
//  - nudges the host when nobody has tapped for 2 minutes during a song ("remind chat: taps fill the bar"),
//  - "Clip that": the host marks moments while recording; each becomes a phone clip after the LIVE (kept on this PC).
// 2.0.8: the video address is also asked for with the host's TikTok sign-in (tiktok-signin.js) when there is one, and
//  the back-up recording of the stream window (capture.js) is switched on/off and started from here.
// Electron-free: main.js passes paths, and shows the notifications this emits.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Recorder, FAILURE_TEXT, cleanErr, CAPTURE_FILE } = require('./recorder');
const { ClipJobs } = require('./clip-jobs');
const { streamCandidates, whyNoStream, roomFlags } = require('./stream-url');

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
// The signed-in copies (2.0.8) follow the same pace.
const MIN_EVERY_MS = { room: 0, api: 30000, page: 30000, kept: 0, room_auth: 0, api_auth: 30000, page_auth: 30000, euler: 60000 };
// Sources that don't go through this computer's network (so they say nothing about it being blocked).
const OFF_NETWORK_SOURCES = new Set(['kept room info', 'tiktok', 'sign server']);
// Answers that mean "TikTok is refusing this network", not "there is no video".
const BLOCK_CODES = new Set(['waf', 'http_403', 'http_429', 'timeout', 'network']);
// Answers that say who may watch the LIVE (and list no video for anyone else).
const GATED_CODES = new Set(['sub_only', 'paid', 'gated']);
// Why this computer isn't recording the LIVE, as status reason codes for the site (^[a-z_]{1,40}$).
const ISSUE_TEXT = {
  ...FAILURE_TEXT,
  recording_disk_full: 'Not recording: less than 2 GB free on the recordings drive',
  recorder_missing: 'Not recording: this copy of LIVE Link is missing its recorder (ffmpeg)',
  recording_folder: "Not recording: LIVE Link can't write to the recordings folder",
  // Not a failure: the back-up is recording the host's stream window because TikTok sent no video.
  recording_window_capture: "Recording the host's stream window instead of TikTok's video (back-up recording)",
};
// Reasons the host can fix by signing in to TikTok inside LIVE Link (the red card offers the button for these).
const SIGNIN_REASONS = new Set(['tiktok_signin_needed', 'stream_restricted', 'stream_blocked']);

// A failed TikTok request -> { code, http, message } for the log and session.json. got (the connector's HTTP client)
// puts the status in response.statusCode; the connector may wrap the original error.
function errInfo(e) {
  const inner = (e && (e.exception || e.cause)) || null;
  const http = Number((e && e.response && e.response.statusCode) || (inner && inner.response && inner.response.statusCode) || (e && e.statusCode) || 0) || null;
  const message = cleanErr((e && e.message) || e) + (inner && inner.message && inner.message !== (e && e.message) ? ` (${cleanErr(inner.message, 120)})` : '');
  const raw = String((e && e.code) || (inner && inner.code) || '');
  let code = 'error';
  if (raw === 'waf' || raw === 'no_room_data') code = raw;
  else if (raw === 'euler') return { code: 'euler', http: null, message: message.slice(0, 200) };   // the sign server's own no (its code is not an HTTP status)
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
    : t.code === 'sub_only' ? 'subscribers only' : t.code === 'paid' ? 'paid event' : t.code === 'gated' ? 'gated LIVE'
    : t.code === 'cooling_down' ? 'resting after a refusal'
    : t.http ? `HTTP ${t.http}` : t.code === 'tiktok_error' ? cleanErr(t.error, 60) : t.code;
  return `${t.source}: ${what}`;
}

// Bytes of the LIVE itself in a recording folder: the pieces, a back-up capture not yet cut into pieces, or the full-show
// file(s) they were joined into.
function mediaBytes(dir, s) {
  let n = 0;
  const joined = new Set(((s && s.joined && s.joined.files) || []).map((f) => f && f.file).filter(Boolean));
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^part-\d+-\d+\.mp4$/.test(f) || CAPTURE_FILE.test(f) || joined.has(f)) { try { n += fs.statSync(path.join(dir, f)).size; } catch {} }
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
  // signIn: the host's TikTok sign-in for the recorder (tiktok-signin.js), or null. capture: the back-up screen recorder
  // (main.js; see recorder.js), or null when this app has none.
  constructor({ ctl, link, api, store, log = () => {}, ffmpegPath, fontFile, defaultRoot, spawn, fetch, now = Date.now, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, clipDelayMs = CLIP_DELAY_MS, signIn = null, capture = null, captureAudio = 'system' }) {
    super();
    this.ctl = ctl; this.link = link; this.api = api; this.store = store; this.log = log;
    this.now = now; this.setTimeout = st; this.clearTimeout = ct;
    this.defaultRoot = defaultRoot;
    this.clipDelayMs = clipDelayMs;
    this.signIn = signIn;
    this.captureAudio = captureAudio;   // 'system' (Windows) | 'microphone' (a Mac can't capture its own audio this way)
    this.signedInNow = false;       // the last answer of signIn.signedIn() (kept for the sync parts: the verdict, the card)
    this.captureDriver = capture;
    this.serverNow = () => this.now() + (this.ctl.clockOffset || 0);
    // The recorder's view of the back-up: the host's chosen window (or the automatic pick) is resolved at start time.
    const rec = capture ? {
      pick: () => capture.pick(this.captureSource()),
      start: (o) => capture.start(o),
      stop: () => capture.stop(),
    } : null;
    this.ffmpegOk = !!ffmpegPath && fs.existsSync(ffmpegPath);
    this.recorder = new Recorder({ ffmpegPath, clock: this.serverNow, log, capture: rec, ...(spawn ? { spawn } : {}) });
    this.recorder.captureEnabled = this.captureEnabled();
    this.jobs = new ClipJobs({ api, ffmpegPath, fontFile, log, ...(spawn ? { spawn } : {}), ...(fetch ? { fetch } : {}), getOptions: () => this._clipOptions() });
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
      this.clipState = ['done', 'error', 'moments_done', 'fullshow_done', 'capture_done'].includes(p.phase) ? null : p;
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
    this.refreshSignIn();
  }

  _wireRecorder(rec) {
    rec.on('state', () => { this._syncIssue(); this._emit(); });
    rec.on('failure', (f) => this.emit('recordingFailed', { ...f, text: ISSUE_TEXT[f.reason] || f.text }));
    rec.on('finished', ({ dir }) => this._recordingFinished(dir));
  }

  root() { return this.store.get('recordRoot') || this.defaultRoot; }
  enabled() { return this.store.get('recordEnabled') !== false; }   // on unless the host switched it off
  clipsOn() { return !!(this.ctl.cfg && this.ctl.cfg.clips && this.ctl.cfg.clips.enabled); }
  // The back-up recording (2.0.8): off unless the host switched it on; `captureSource` = the window title the host chose
  // in Settings (null = automatic: TikTok LIVE Studio, OBS...).
  captureAvailable() { return !!this.captureDriver && this.ffmpegOk; }
  captureEnabled() { return this.captureAvailable() && this.store.get('captureEnabled') === true; }
  captureSource() { const s = this.store.get('captureSource'); return typeof s === 'string' && s.trim() ? s.trim().slice(0, 120) : null; }

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
      // 2.0.8: the TikTok sign-in for the recorder, and the back-up recording.
      signedIn: !!this.signedInNow,
      signInAvailable: !!this.signIn,
      captureAvailable: this.captureAvailable(),
      captureEnabled: this.captureEnabled(),
      captureSource: this.captureSource(),
      captureAudio: this.captureAudio,
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
      this.recorder.captureEnabled = this.captureEnabled();
      const dir = await this.recorder.start({ root: this.root(), handle: s.tiktokUsername, roomId, app: this.ctl.appVersion || null, getStream: (fresh) => this._stream(fresh) });
      if (dir) this.log('info', `recording the LIVE to ${dir}`);
    } catch (e) { this.log('error', `recording: ${e && e.message}`); }
    finally { this.starting = false; this._emit(); }
  }

  // Is the host signed in to TikTok inside LIVE Link (for the recorder)? Refreshed before each ask for the video and
  // after sign-in / sign-out (main.js calls it).
  async refreshSignIn() {
    const was = this.signedInNow;
    let now = false;
    try { now = !!(this.signIn && await this.signIn.signedIn()); } catch { now = false; }
    this.signedInNow = now;
    if (now !== was) { this.log('info', now ? 'TikTok sign-in: signed in (the recorder asks TikTok as a signed-in viewer)' : 'TikTok sign-in: signed out'); this.cooldown.clear(); this.lastAnswer.clear(); this._syncIssue(); this._emit(); }
    return now;
  }

  // The stream link. Every try asks every place TikTok lists the video (a fresh try asks TikTok first, the kept copy
  // last): a fresh room info, TikTok's api-live answer, the LIVE page, and the room info kept since connecting; with
  // the host signed in to TikTok (2.0.8), the same three places asked as that signed-in viewer come first. The first
  // with links wins (all of its links go along, so the recorder can fall back to another quality or format). When none
  // has one, what each answered (HTTP status, TikTok's status code, bot check...) goes to session.json and the log, and
  // the verdict (sign-in needed / restricted / subscribers only / blocked / unavailable) is what the host and the site
  // are told if it lasts.
  async _stream(fresh) {
    const conn = this.link.conn;
    const roomId = this.room || (this.lastS && this.lastS.tiktok && this.lastS.tiktok.roomId ? String(this.lastS.tiktok.roomId) : null);
    const handle = this.lastS && this.lastS.tiktokUsername;
    const signedIn = await this.refreshSignIn();
    if (!conn && !signedIn) { this.recorder.noteStreamErrors([{ source: 'tiktok', code: 'not_connected', error: 'not connected to the LIVE right now' }], { reason: 'stream_unavailable', detail: 'not connected to the LIVE right now' }); return null; }
    const S = signedIn ? this.signIn : null;
    const sources = {
      room_auth: ['room info (signed in)', S && roomId ? () => S.roomInfo(roomId) : null],
      api_auth: ['api-live (signed in)', S && handle ? () => S.apiLive(handle) : null],
      page_auth: ['LIVE page (signed in)', S && handle ? () => S.livePage(handle) : null],
      room: ['room info', conn && typeof conn.fetchRoomInfo === 'function' ? () => conn.fetchRoomInfo() : null],
      api: ['api-live', conn && typeof this.link.liveRoomFromApi === 'function' ? () => this.link.liveRoomFromApi() : null],
      page: ['LIVE page', conn && typeof this.link.liveRoomFromPage === 'function' ? () => this.link.liveRoomFromPage() : null],
      kept: ['kept room info', conn && conn.roomInfo ? async () => conn.roomInfo : null],
      // The sign server's room info, fetched from ITS network (2.0.8): last, at most once a minute (a shared free service).
      euler: ['sign server', conn && typeof this.link.liveRoomFromEuler === 'function' ? () => this.link.liveRoomFromEuler() : null],
    };
    const auth = ['room_auth', 'api_auth', 'page_auth'];
    const order = fresh ? [...auth, 'room', 'api', 'page', 'kept', 'euler'] : ['kept', ...auth, 'room', 'api', 'page', 'euler'];
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
        if (typeof this.recorder.noteRoomFlags === 'function') this.recorder.noteRoomFlags(roomFlags(answer), source);
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

  // Why no source had a link. An answer that says who may watch (subscribers, a ticket) = subscribers only. Room info
  // answering 4003110 while TikTok's LIVE data says the LIVE is on = a LIVE TikTok won't show a signed-out viewer: the
  // host can sign in to TikTok in LIVE Link (tiktok_signin_needed); if that doesn't help either = stream_restricted.
  // Every request refused (403/429, bot check, timeouts) = this network is blocked.
  _verdict(tries) {
    const detail = cleanErr(tries.map(tryText).join(' · '), 300) || 'no source to ask';
    const asked = tries.filter((t) => !OFF_NETWORK_SOURCES.has(t.source) && t.code !== 'cooling_down' && t.code !== 'empty');
    const refusedAll = asked.length > 0 && asked.every((t) => BLOCK_CODES.has(t.code) || /^http_(4|5)\d\d$/.test(t.code));
    let reason = 'stream_unavailable';
    if (tries.some((t) => GATED_CODES.has(t.code))) reason = 'stream_sub_only';
    else if (tries.some((t) => t.code === 'restricted') && this.liveNow !== false) reason = this.signedInNow || !this.signIn ? 'stream_restricted' : 'tiktok_signin_needed';
    else if (refusedAll) reason = 'stream_blocked';
    return { reason, detail };
  }

  // Ask TikTok for the video right away (the card's "Try again" and "Check TikTok now").
  retryStream() {
    this.cooldown.clear(); this.lastAnswer.clear();
    this.refreshSignIn();
    return this.recorder.retryNow();
  }

  // ---------------------------------------------------------------- the back-up recording (2.0.8)
  // Settings > back-up recording on/off (kept across restarts).
  setCaptureEnabled(on) {
    this.store.set('captureEnabled', on ? true : null);
    this.recorder.setCaptureEnabled(this.captureEnabled());
    this.log('info', `back-up recording ${on ? 'on' : 'off'}`);
    this._emit();
    return this.captureEnabled();
  }
  // Settings > the stream window to record (its title; null = automatic).
  setCaptureSource(name) {
    const v = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
    this.store.set('captureSource', v);
    this._emit();
    return v;
  }
  // The windows the back-up could record right now (for the Settings picker): [{ id, name, kind }].
  async captureSources() {
    if (!this.captureDriver || typeof this.captureDriver.sources !== 'function') return [];
    try { return (await this.captureDriver.sources()).map((s) => ({ id: String(s.id), name: String(s.name || '').slice(0, 120), kind: s.kind === 'screen' ? 'screen' : 'window' })); }
    catch (e) { this.log('warn', `capture: can't list the windows (${cleanErr(e && e.message)})`); return []; }
  }
  // The red card's "Record my stream window instead": switches the back-up on and starts it now.
  captureNow() {
    if (!this.captureAvailable()) return { ok: false, error: 'unavailable' };
    if (!this.recorder.active) return { ok: false, error: 'not_recording' };
    if (!this.captureEnabled()) this.setCaptureEnabled(true);
    const ok = this.recorder.captureNow();
    this._emit();
    return { ok };
  }

  // What the host and the site are told about recording while the TikTok LIVE is on (null = recording fine, or the
  // host chose not to record this one). A back-up recording in progress is reported too (level 'info': not a failure).
  recordingIssue() {
    const r = this.recorder.getState();
    const live = !!this.liveNow;
    if (!live) return null;
    if (r.recording) {
      if (r.failure) return { reason: r.failure.reason, text: ISSUE_TEXT[r.failure.reason] || r.failure.text, detail: r.failure.detail || null, since: r.failure.since, level: 'problem' };
      if (r.capture) return { reason: 'recording_window_capture', text: ISSUE_TEXT.recording_window_capture, detail: r.capture.source ? `window: ${r.capture.source}` : null, since: r.capture.since, level: 'info' };
      return null;
    }
    const room = this.lastS && this.lastS.tiktok && this.lastS.tiktok.roomId ? String(this.lastS.tiktok.roomId) : null;
    if (!this.enabled() || (this.hostStoppedRoom && (!room || room === this.hostStoppedRoom))) return null;   // the host chose not to record
    if (!this.ffmpegOk) return { reason: 'recorder_missing', text: ISSUE_TEXT.recorder_missing, detail: null, level: 'problem' };
    if (r.error === 'disk_full') return { reason: 'recording_disk_full', text: ISSUE_TEXT.recording_disk_full, detail: null, level: 'problem' };
    if (r.error === 'folder') return { reason: 'recording_folder', text: ISSUE_TEXT.recording_folder, detail: null, level: 'problem' };
    if (r.error === 'ffmpeg_missing') return { reason: 'recorder_missing', text: ISSUE_TEXT.recorder_missing, detail: null, level: 'problem' };
    return null;
  }

  _syncIssue() {
    const issue = this.recordingIssue();
    const key = issue ? `${issue.reason}|${issue.level || ''}|${issue.detail || ''}` : '';
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
  // gets its end time from what was recorded. A back-up capture not yet cut into pieces counts as owed work too.
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
      let files = [];
      try { files = fs.readdirSync(x.dir); } catch { continue; }
      const reviews = doReviews && !s.clipsDoneAt;
      const momentsOwed = doMoments && (s.moments || []).length > Object.keys(s.momentClips || {}).length;
      const fullShowOwed = doMoments && !s.joined && files.some((f) => /^part-\d+-\d+\.mp4$/.test(f));
      const captureOwed = doMoments && (s.runs || []).some((r) => r && r.capture && r.file && files.includes(r.file) && !files.some((f) => new RegExp(`^part-${r.index}-\\d+\\.mp4$`).test(f)));
      if (!reviews && !momentsOwed && !fullShowOwed && !captureOwed) continue;
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
        captured: (s.runs || []).some((r) => r && r.capture),   // some or all of it is a back-up recording of the stream window
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

module.exports = { ShowManager, NUDGE_QUIET_MS, CLIP_DELAY_MS, ISSUE_TEXT, SIGNIN_REASONS, errInfo, recordingFailure };
