'use strict';
// After a LIVE ends: asks the site which reviews played during the recording, cuts each one on this computer
// (clipper.js), uploads the files with one-time links from the site, and tells the site they're ready. The site
// attaches them to the submissions and lets the artists know. Nothing here needs the host: it runs by itself, and the
// window's "Make & send clips" button runs it again for a recording (only what isn't sent yet).
//
// Status per review lives in the recording's session.json under `clips[play_id]`:
//   { status: 'sent' | 'failed' | 'not_recorded' | 'working', at, error?, files? }

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const C = require('./clipper');

const CONTENT_TYPE = { full: 'video/mp4', highlight: 'video/mp4', vertical: 'video/mp4', poster: 'image/jpeg' };
const MIN_COVERAGE = 0.6;   // a review the recording covers less than this is skipped (recording started late, gap)
const MAX_ATTEMPTS = 3;     // a review that failed this often waits for the host's "Make & send clips"

class ClipJobs extends EventEmitter {
  constructor({ api, ffmpegPath, fontFile, log = () => {}, spawn = require('child_process').spawn, fetch = globalThis.fetch, getOptions = () => ({}), now = Date.now }) {
    super();
    this.api = api;
    this.ffmpegPath = ffmpegPath;
    this.fontFile = fontFile;
    this.log = log;
    this.spawn = spawn;
    this.fetch = fetch;
    this.getOptions = getOptions;     // { delayMs, padStartMs, ... } from the site's config (or the defaults)
    this.now = now;
    this.queue = [];
    this.running = null;               // dir being processed
  }

  // Queue a recording folder. force: also redo reviews that failed or were skipped.
  enqueue(dir, { force = false } = {}) {
    if (this.running === dir || this.queue.some((q) => q.dir === dir)) return;
    this.queue.push({ dir, force });
    this._next();
  }

  async _next() {
    if (this.running || !this.queue.length) return;
    const { dir, force } = this.queue.shift();
    this.running = dir;
    try { await this.processSession(dir, { force }); }
    catch (e) { this.log('error', `clips: ${path.basename(dir)}: ${e && e.message}`); this.emit('progress', { dir, phase: 'error', error: e && e.message }); }
    finally { this.running = null; this._next(); }
  }

  // Two passes so artists hear fast: pass 1 makes every review's files and sends the highlight + poster (the artist is
  // told as soon as the highlight lands); pass 2 sends the big full reviews. Status per review:
  //   highlight_sent -> pass 2 still owes the full review; sent = everything is up; failed (attempts counted).
  async processSession(dir, { force = false } = {}) {
    const session = C.readSession(dir);
    if (!session.endedAt) throw new Error('the recording is still running');
    const until = session.endedAt + 60000, since = session.startedAt - 60000;
    this.emit('progress', { dir, phase: 'reviews' });
    const res = await this._retry(() => this.api.reviews(new Date(since).toISOString(), new Date(until).toISOString()), 'reviews');
    const reviews = (res && Array.isArray(res.reviews)) ? res.reviews : [];
    let taps = {};
    try { taps = JSON.parse(fs.readFileSync(path.join(dir, 'taps.json'), 'utf8')); } catch {}
    const tl = C.timeline(session);
    const opts = { ...C.DEFAULTS, ...(this.getOptions() || {}) };
    const clips = () => (C.readSession(dir).clips || {});
    let sent = 0, skipped = 0, failed = 0;
    // pass 1: files + highlight
    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i];
      const key = String(r.play_id);
      const prev = clips()[key];
      if (prev && (prev.status === 'sent' || prev.status === 'highlight_sent')) continue;
      if (prev && !force && (prev.status === 'not_recorded' || (prev.status === 'failed' && (prev.attempts || 0) >= MAX_ATTEMPTS))) { skipped++; continue; }
      this.emit('progress', { dir, phase: 'clip', index: i + 1, total: reviews.length, title: r.title || '' });
      try {
        const out = await this._oneReview(dir, session, tl, taps, r, opts);
        if (out === 'not_recorded') { this._mark(dir, key, { status: 'not_recorded' }); skipped++; continue; }
        this._mark(dir, key, { status: 'highlight_sent', files: out.files, job: out.job, recipe: out.recipe });
      } catch (e) {
        failed++;
        this.log('error', `clips: review ${key} failed: ${e && e.message}`);
        this._mark(dir, key, { status: 'failed', attempts: ((prev && prev.attempts) || 0) + 1, error: String((e && e.message) || e).slice(0, 300) });
      }
    }
    // pass 2: the full reviews
    const owed = reviews.filter((r) => (clips()[String(r.play_id)] || {}).status === 'highlight_sent');
    for (let i = 0; i < owed.length; i++) {
      const r = owed[i], key = String(r.play_id), st = clips()[key];
      this.emit('progress', { dir, phase: 'full', index: i + 1, total: owed.length, title: r.title || '' });
      try {
        const file = path.join(dir, 'clips', st.job || key.replace(/[^\w-]/g, ''), 'full.mp4');
        const f = await this._upload(r, 'full', file);
        await this._retry(() => this.api.clipComplete({ play_id: r.play_id, files: [f], recipe: st.recipe || {} }), 'complete');
        try { fs.unlinkSync(file); } catch {}          // a copy of the recording: the recording itself stays
        this._mark(dir, key, { status: 'sent', files: [...(st.files || []), { kind: 'full', bytes: f.bytes }] });
        sent++;
      } catch (e) {
        this.log('warn', `clips: full review ${key} not sent yet: ${e && e.message}`);
        this._mark(dir, key, { error: String((e && e.message) || e).slice(0, 300) });   // stays highlight_sent: retried next time
      }
    }
    const final = clips();
    const pending = reviews.some((r) => { const s = final[String(r.play_id)]; return !s || s.status === 'highlight_sent' || (s.status === 'failed' && (s.attempts || 0) < MAX_ATTEMPTS); });
    this._markSession(dir, { clipsCheckedAt: new Date(this.now()).toISOString(), ...(pending ? {} : { clipsDoneAt: new Date(this.now()).toISOString() }) });
    sent = reviews.filter((r) => ['sent', 'highlight_sent'].includes((final[String(r.play_id)] || {}).status)).length;
    this.emit('progress', { dir, phase: 'done', sent, skipped, failed, total: reviews.length, pending });
    return { sent, skipped, failed, total: reviews.length, pending };
  }

  // A site call or an upload that hits a network blip or a server error gets two more tries (5 s, then 20 s).
  async _retry(fn, what) {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        const s = Number(e && e.status);
        if (s >= 400 && s < 500 && s !== 408 && s !== 429) break;     // refused for a reason: retrying won't help
        if (i < 2) { this.log('info', `clips: ${what} failed (${e && e.message}), trying again`); await new Promise((r) => setTimeout(r, [5000, 20000][i])); }
      }
    }
    throw last;
  }

  async _upload(r, kind, file) {
    const bytes = fs.statSync(file).size;
    const probe = kind === 'poster' ? {} : C.parseProbe(await this._probe(file));
    const meta = { play_id: r.play_id, kind, bytes, content_type: CONTENT_TYPE[kind], duration_ms: probe.duration ? Math.round(probe.duration * 1000) : null, width: probe.width || null, height: probe.height || null };
    return this._retry(async () => {
      const up = await this.api.clipUpload(meta);
      await this._put(up.upload_url, file, CONTENT_TYPE[kind], bytes);
      return { ...meta, path: up.path };
    }, `${kind} upload`);
  }

  _markSession(dir, patch) {
    const file = path.join(dir, 'session.json');
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(s, patch);
      fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 1));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { this.log('warn', `clips: can't save status (${e.message})`); }
  }

  async _oneReview(dir, session, tl, taps, r, opts) {
    const plan = C.planReview({ startedAt: Date.parse(r.started_at), endedAt: r.ended_at ? Date.parse(r.ended_at) : null }, taps, session.endedAt, opts);
    if (!plan) return 'not_recorded';
    const fullCuts = C.cutsFor(tl, plan.full.from, plan.full.to);
    if (C.coveredMs(fullCuts) < (plan.full.to - plan.full.from) * MIN_COVERAGE) return 'not_recorded';
    const job = path.join(dir, 'clips', String(r.play_id).replace(/[^\w-]/g, ''));
    fs.mkdirSync(job, { recursive: true });
    const write = (name, text) => fs.writeFileSync(path.join(job, name), text);
    // Text for the title strip and end card (files, so quotes/colons/emoji need no escaping).
    const host = String(r.host_name || session.handle || '').slice(0, 60);
    write('title.txt', String(r.artist || 'ReactivVibeAI').toUpperCase().slice(0, 40));
    write('sub.txt', `${r.title ? `"${String(r.title).slice(0, 48)}" · ` : ''}live review${host ? ` with ${host}` : ''}`);
    write('host.txt', host ? `with ${host}` : 'live music reviews');
    if (this.fontFile) fs.copyFileSync(this.fontFile, path.join(job, 'font.ttf'));

    // 1) the full review, copied (re-encoded only if the stream isn't H.264, so every browser can play it)
    const firstPart = path.join(dir, fullCuts[0].file);
    const src = C.parseProbe(await this._probe(firstPart));
    write('full.txt', C.concatList(fullCuts.map((c) => ({ ...c, file: path.relative(job, path.join(dir, c.file)).replace(/\\/g, '/') }))));
    await this._ff(C.copyArgs('full.txt', 'full.mp4', { reencode: !!src.codec && src.codec !== 'h264' }), job);

    // 2) the highlight: hottest moment + verdict
    const size = C.targetSize(src.width, src.height);
    let hotDur = 0, hasAudio = [src.hasAudio, src.hasAudio];
    if (plan.hot) {
      const hotCuts = C.cutsFor(tl, plan.hot.from, plan.hot.to);
      write('hot.txt', C.concatList(hotCuts.map((c) => ({ ...c, file: path.relative(job, path.join(dir, c.file)).replace(/\\/g, '/') }))));
      await this._ff(C.copyArgs('hot.txt', 'hot.mp4'), job);
      const hp = C.parseProbe(await this._probe(path.join(job, 'hot.mp4')));
      hotDur = hp.duration || (plan.hot.to - plan.hot.from) / 1000;
      hasAudio[0] = hp.hasAudio;
    }
    const verdictCuts = C.cutsFor(tl, plan.verdict.from, plan.verdict.to);
    write('verdict.txt', C.concatList(verdictCuts.map((c) => ({ ...c, file: path.relative(job, path.join(dir, c.file)).replace(/\\/g, '/') }))));
    await this._ff(C.copyArgs('verdict.txt', 'verdict.mp4'), job);
    const vp = C.parseProbe(await this._probe(path.join(job, 'verdict.mp4')));
    hasAudio[1] = vp.hasAudio;
    const verdictDur = vp.duration || (plan.verdict.to - plan.verdict.from) / 1000;
    await this._ff(C.highlightArgs({ hotFile: plan.hot ? 'hot.mp4' : null, verdictFile: 'verdict.mp4', outFile: 'highlight.mp4', size, font: 'font.ttf', hotDur, verdictDur, hasAudio }), job);

    // 3) a phone-shaped copy for landscape streams (portrait ones already are)
    if (!size.portrait) await this._ff(C.verticalArgs('highlight.mp4', 'vertical.mp4'), job);
    // 4) the poster, from the hottest moment
    await this._ff(C.posterArgs(plan.hot ? 'hot.mp4' : 'verdict.mp4', plan.hot ? hotDur / 2 : 3, 'poster.jpg'), job);
    for (const f of ['hot.mp4', 'verdict.mp4', 'full.txt', 'hot.txt', 'verdict.txt', 'title.txt', 'sub.txt', 'host.txt', 'font.ttf']) { try { fs.unlinkSync(path.join(job, f)); } catch {} }

    // 5) send the highlight first (the artist is told when it lands); the full review goes in pass 2
    const recipe = { hot: plan.hot ? { from: new Date(plan.hot.from).toISOString(), weight: plan.hotWeight } : null, delay_ms: opts.delayMs };
    const files = [];
    for (const kind of ['highlight', 'poster', ...(size.portrait ? [] : ['vertical'])]) {
      files.push(await this._upload(r, kind, path.join(job, kind === 'poster' ? 'poster.jpg' : `${kind}.mp4`)));
    }
    await this._retry(() => this.api.clipComplete({ play_id: r.play_id, files, recipe }), 'complete');
    return { files: files.map((f) => ({ kind: f.kind, bytes: f.bytes })), job: path.basename(job), recipe };
  }

  _mark(dir, key, patch) {
    const file = path.join(dir, 'session.json');
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      s.clips = s.clips || {};
      s.clips[key] = { ...(s.clips[key] || {}), ...patch, at: new Date(this.now()).toISOString() };
      if (patch.status && patch.status !== 'failed' && !('error' in patch)) delete s.clips[key].error;
      fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 1));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { this.log('warn', `clips: can't save status (${e.message})`); }
  }

  async _put(url, file, contentType, bytes) {
    if (!/^https:\/\/(bxiejoktoknybpraxebm\.supabase\.co|[a-z0-9.-]*reactivvibeai\.com)\//.test(String(url || '')) && !/^http:\/\/127\.0\.0\.1:\d+\//.test(String(url || ''))) {
      throw new Error('the site sent an upload link for an unexpected address');
    }
    const res = await this.fetch(url, { method: 'PUT', headers: { 'content-type': contentType, 'content-length': String(bytes), 'x-upsert': 'true' }, body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half' });
    if (!res.ok) throw new Error(`upload refused (${res.status})`);
  }

  // ffmpeg prints a file's details on stderr when given only an input.
  _probe(file) {
    return new Promise((resolve) => {
      let text = '';
      const p = this.spawn(this.ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
      p.stderr.on('data', (d) => { text += d; });
      p.on('error', () => resolve(text));
      p.on('close', () => resolve(text));
    });
  }

  _ff(args, cwd) {
    return new Promise((resolve, reject) => {
      let err = '';
      const p = this.spawn(this.ffmpegPath, args, { cwd, windowsHide: true });
      try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}   // the host may still be using the PC
      p.stderr.on('data', (d) => { err = (err + d).slice(-800); });
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`)));
    });
  }
}

module.exports = { ClipJobs };
