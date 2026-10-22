'use strict';
// 2.0.8: the back-up recording of the stream window. Which window, when it takes over, how its run is kept, how the
// file becomes the usual pieces after the LIVE, and how the clip maker places it on the server clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickCaptureSource, pickMime, finalizeArgs, extFor, CAPTURE_AFTER_MS } = require('../src/core/capture');
const { Recorder, FAILURE_TEXT } = require('../src/core/recorder');
const { ClipJobs } = require('../src/core/clip-jobs');
const C = require('../src/core/clipper');

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock(start = 1_792_555_294_742) {
  let t = start, id = 0;
  const timers = [];
  const add = (fn, ms, every) => { const x = { id: ++id, fn, at: t + Math.max(0, ms), every }; timers.push(x); return x; };
  const clear = (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); };
  return {
    now: () => t, setTimeout: (fn, ms) => add(fn, ms, null), clearTimeout: clear, setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: clear,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const x = timers[0];
        if (!x || x.at > end) break;
        t = x.at;
        if (x.every) x.at += x.every; else timers.shift();
        x.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'll-cap-'));
const readSession = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));

// A fake screen recorder: writes a growing capture file and reports progress like the real one (main.js).
function fakeCapture(c, { windows = [{ id: 'window:1', name: 'TikTok LIVE Studio', kind: 'window' }], mime = 'video/webm;codecs=h264,opus', failStart = false } = {}) {
  const d = { starts: 0, stops: 0, picks: 0, cur: null, windows };
  d.sources = async () => d.windows;
  d.pick = async (preferred) => { d.picks++; return pickCaptureSource(d.windows, preferred); };
  d.start = async ({ dir, base, source, onProgress, onEnd }) => {
    d.starts++;
    if (failStart) throw new Error('getDisplayMedia: NotAllowedError');
    const file = path.join(dir, `${base}.${extFor(mime)}`);
    fs.writeFileSync(file, Buffer.alloc(1000));
    const t0 = c.now();
    const iv = c.setInterval(() => { fs.appendFileSync(file, Buffer.alloc(4000)); onProgress({ mediaMs: c.now() - t0, bytes: fs.statSync(file).size }); }, 1000);
    d.cur = { file, end: (info) => { c.clearInterval(iv); d.cur = null; onEnd(info || {}); } };
    return { file, mime, width: 720, height: 1280, audio: 'system' };
  };
  d.stop = async () => { d.stops++; if (d.cur) d.cur.end({}); };
  d.die = (error) => { if (d.cur) d.cur.end({ error }); };
  return d;
}
function rec(c, extra = {}) {
  const logs = [];
  const r = new Recorder({ ffmpegPath: process.execPath, clock: c.now, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
    spawn: () => { throw new Error('ffmpeg must not run in this test'); }, log: (l, m) => logs.push(`${l} ${m}`), ...extra });
  r.logs = logs;
  return r;
}
const noLink = (r, reason = 'tiktok_signin_needed') => async () => { r.noteStreamErrors([{ source: 'room info', code: 'restricted', status: 4003110, error: 'TikTok answered status 4003110' }], { reason, detail: 'room info: status 4003110 (restricted)' }); return null; };

test('which window: the host\'s choice first, then TikTok LIVE Studio, then OBS and the others; never a whole screen by itself, never LIVE Link', () => {
  const list = [
    { id: 'screen:0:0', name: 'Entire screen', kind: 'screen' },
    { id: 'window:10', name: 'ReactivVibe LIVE Link', kind: 'window' },
    { id: 'window:11', name: 'OBS 31.0.3 - Profile: Untitled - Scenes: Show', kind: 'window' },
    { id: 'window:12', name: 'TikTok LIVE Studio', kind: 'window' },
    { id: 'window:13', name: 'Streamlabs Desktop', kind: 'window' },
    { id: 'window:14', name: 'Sign in to TikTok (for LIVE Link recording)', kind: 'window' },
  ];
  assert.equal(pickCaptureSource(list).id, 'window:12', 'LIVE Studio shows the final picture (OBS feeds into it)');
  assert.equal(pickCaptureSource(list.filter((s) => s.id !== 'window:12')).id, 'window:11', 'then OBS');
  assert.equal(pickCaptureSource(list.filter((s) => !/window:1[12]/.test(s.id))).id, 'window:13', 'then Streamlabs');
  assert.equal(pickCaptureSource(list, 'OBS 31.0.3 - Profile: Untitled - Scenes: Show').id, 'window:11', 'the host\'s exact choice wins');
  assert.equal(pickCaptureSource(list, 'obs 31.0.3 - profile: untitled - scenes: other').id, 'window:11', 'a title that drifted (scene renamed) still matches loosely');
  assert.equal(pickCaptureSource(list, 'Entire screen').id, 'screen:0:0', 'a screen only when the host chose it');
  assert.equal(pickCaptureSource([list[0], list[1], list[5]]), null, 'nothing to record: no screen, never LIVE Link\'s own windows');
  assert.equal(pickCaptureSource([{ id: 'window:9', name: 'Google Chrome - TikTok LIVE Studio tab' }]).id, 'window:9', 'a title with LIVE Studio in it counts');
  assert.equal(pickCaptureSource(null), null);
});

test('the recorder\'s format choice and the ffmpeg arguments that turn the capture into the usual pieces', () => {
  assert.equal(pickMime((m) => m === 'video/webm;codecs=vp9,opus' || m === 'video/webm'), 'video/webm;codecs=vp9,opus');
  assert.equal(pickMime((m) => m.startsWith('video/mp4')), 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'MP4 + H.264 first (no re-encoding later)');
  assert.equal(pickMime(() => false), '');
  assert.equal(extFor('video/mp4;codecs=avc1'), 'mp4'); assert.equal(extFor('video/webm;codecs=h264,opus'), 'webm'); assert.equal(extFor(null), 'webm');
  const copy = finalizeArgs('capture-1.webm', 1, 'video/webm;codecs=h264,opus');
  assert.ok(copy.includes('-c:v') && copy[copy.indexOf('-c:v') + 1] === 'copy', 'H.264 is copied, not re-encoded');
  assert.ok(copy.includes('aac'), 'audio becomes AAC');
  assert.equal(copy[copy.length - 1], 'part-1-%03d.mp4');
  assert.ok(copy.includes('parts-1.csv') && copy.includes('segment') && copy.includes('movflags=+frag_keyframe+empty_moov+default_base_moof'));
  const enc = finalizeArgs('capture-0.webm', 0, 'video/webm;codecs=vp9,opus');
  assert.ok(enc.includes('libx264'), 'VP9 is encoded to H.264');
  assert.equal(finalizeArgs('capture-0.webm', 0, null)[finalizeArgs('capture-0.webm', 0, null).indexOf('-c:v') + 1], 'libx264', 'unknown format: encode to be safe');
});

test('no TikTok video for 75 s and the back-up on: the stream window is recorded (run + file + samples), the card never turns red, TikTok is still asked once a minute; stop closes the run', async () => {
  const c = fakeClock();
  const cap = fakeCapture(c);
  const r = rec(c, { capture: cap });
  r.captureEnabled = true;
  const failures = [];
  r.on('failure', (f) => failures.push(f));
  let asks = 0;
  const getStream = async (fresh) => { asks++; return noLink(r)(); };
  const dir = await r.start({ root: tmp(), handle: 'shadowulf75', roomId: '7698965875919031070', getStream, app: '2.0.8' });
  await c.advance(60000);
  assert.equal(r.getState().failure && r.getState().failure.reason, 'tiktok_signin_needed', 'red at 60 s like 2.0.7 (the reason names the fix)');
  assert.equal(cap.starts, 0, 'not before 75 s');
  await c.advance(20000);
  assert.equal(cap.starts, 1, 'the back-up took over at ~75 s');
  const st = r.getState();
  assert.equal(st.video, true);
  assert.deepEqual([st.capture.source, st.capture.file], ['TikTok LIVE Studio', 'capture-0.webm']);
  await c.advance(30000);
  assert.equal(r.getState().failure, null, 'bytes are being written: the red card cleared');
  assert.ok(r.getState().bytes > 50000, `size from the capture file (${r.getState().bytes})`);
  assert.equal(r.getState().capture.bytes, r.getState().bytes);
  const asksBefore = asks;
  await c.advance(3 * 60000);
  assert.ok(asks - asksBefore >= 2 && asks - asksBefore <= 4, `TikTok still asked about once a minute while the back-up records (${asks - asksBefore} asks in 3 min)`);
  assert.equal(failures.length, 1);
  assert.equal(r.markMoment(c.now(), 'hotkey') !== null, true, '"Clip that" works during the back-up');
  await r.stop();
  assert.equal(cap.stops, 1);
  const s = readSession(dir);
  assert.equal(s.runs.length, 1);
  const run = s.runs[0];
  assert.equal(run.capture, true);
  assert.deepEqual([run.kind, run.quality, run.from, run.source, run.file, run.mime, run.width, run.height], ['capture', 'window', 'window capture', 'TikTok LIVE Studio', 'capture-0.webm', 'video/webm;codecs=h264,opus', 720, 1280]);
  assert.ok(run.samples.length >= 10, `time samples kept (${run.samples.length})`);
  assert.ok(run.samples.every(([m, w]) => Math.abs(w - m - run.startedAt) < 3000), 'media time 0 = when the capture began (server clock)');
  assert.ok(run.endedAt > run.startedAt && run.bytes > 50000);
  assert.deepEqual([s.stream.kind, s.stream.quality, s.stream.codec], ['capture', 'window', 'h264']);
  assert.equal(s.diag.result, 'partial', 'the first 75 s were lost, the rest saved');
  assert.equal(s.diag.captured, true);
  assert.equal(s.diag.failures[0].reason, 'tiktok_signin_needed');
  assert.ok(s.diag.failures[0].to, 'the failure closed when the back-up began writing');
  assert.ok(s.streamErrors.find((e) => e.source === 'room info').status === 4003110, 'TikTok\'s own code is kept per source');
  assert.ok(fs.existsSync(path.join(dir, 'capture-0.webm')), 'the file stays for the clip job to cut');
});

test('the back-up stays off unless the host switched it on; "Record my stream window instead" starts it at once (this LIVE)', async () => {
  const c = fakeClock();
  const cap = fakeCapture(c);
  const r = rec(c, { capture: cap });
  await r.start({ root: tmp(), handle: 'h', roomId: '1', getStream: noLink(r) });
  await c.advance(10 * 60000);
  assert.equal(cap.starts, 0, 'off: never captured by itself');
  assert.equal(r.getState().failure.reason, 'tiktok_signin_needed');
  assert.equal(r.captureNow(), true);
  await c.advance(5000);
  assert.equal(cap.starts, 1);
  assert.equal(r.captureEnabled, true);
  assert.equal(r.getState().capture.source, 'TikTok LIVE Studio');
  await r.stop();
});

test('no stream window open: capture_no_window (with TikTok\'s answer alongside), looked for again every minute; the window dies: TikTok is asked again and the back-up re-arms', async () => {
  const c = fakeClock();
  const cap = fakeCapture(c, { windows: [] });
  const r = rec(c, { capture: cap });
  r.captureEnabled = true;
  await r.start({ root: tmp(), handle: 'h', roomId: '1', getStream: noLink(r, 'stream_restricted') });
  await c.advance(80000);
  assert.equal(cap.picks, 1);
  assert.equal(cap.starts, 0);
  const f = r.getState().failure;
  assert.equal(f.reason, 'capture_no_window');
  assert.equal(f.text, FAILURE_TEXT.capture_no_window);
  assert.match(f.detail, /no stream window found .* TikTok: room info: status 4003110/);
  await c.advance(65000);
  assert.equal(cap.picks, 2, 'looked again a minute later');
  // the host opens LIVE Studio
  cap.windows = [{ id: 'window:1', name: 'TikTok LIVE Studio', kind: 'window' }];
  await c.advance(65000);
  assert.equal(cap.starts, 1);
  assert.equal(r.getState().failure, null);
  // ...and closes it 2 minutes later
  await c.advance(120000);
  const sizeBefore = fs.statSync(cap.cur.file).size;
  cap.die('the window closed (or sharing stopped)');
  await flush();
  assert.equal(r.getState().capture, null);
  assert.equal(r.getState().video, false);
  const s1 = readSession(r.dir);
  assert.match(s1.runs[0].error, /window closed/);
  assert.equal(s1.runs[0].bytes, sizeBefore);
  const asksBefore = r.getState().tries;
  await c.advance(10000);
  assert.ok(r.getState().tries > asksBefore, 'TikTok asked again (every 4 s again)');
  await c.advance(70000);
  assert.equal(cap.starts, 2, 'the back-up re-armed after 75 s without TikTok video');
  assert.equal(readSession(r.dir).runs.length, 2);
  await r.stop();
  const s = readSession(r.dir);
  assert.equal(s.runs[1].capture, true);
  assert.equal(s.runs[1].file, 'capture-1.webm');
});

test('the screen recorder refuses to start: capture_failed, TikTok still asked, no crash; switching the back-up off ends a running capture', async () => {
  const c = fakeClock();
  const cap = fakeCapture(c, { failStart: true });
  const r = rec(c, { capture: cap });
  r.captureEnabled = true;
  await r.start({ root: tmp(), handle: 'h', roomId: '1', getStream: noLink(r) });
  await c.advance(80000);
  assert.equal(cap.starts, 1);
  assert.equal(r.getState().failure.reason, 'capture_failed');
  assert.match(r.getState().failure.detail, /NotAllowedError/);
  const s = readSession(r.dir);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].bytes, 0);
  assert.match(s.runs[0].error, /NotAllowedError/);
  assert.ok(s.streamErrors.some((e) => e.source === 'capture' && e.code === 'failed'));
  await c.advance(70000);
  assert.equal(cap.starts, 2, 'tried again a minute later');
  await r.stop();

  const c2 = fakeClock();
  const cap2 = fakeCapture(c2);
  const r2 = rec(c2, { capture: cap2 });
  r2.captureEnabled = true;
  await r2.start({ root: tmp(), handle: 'h', roomId: '1', getStream: noLink(r2) });
  await c2.advance(90000);
  assert.equal(cap2.starts, 1);
  r2.setCaptureEnabled(false);
  await flush();
  assert.equal(cap2.stops, 1);
  assert.equal(r2.getState().capture, null);
  await c2.advance(5 * 60000);
  assert.equal(cap2.starts, 1, 'off: not again');
  await r2.stop();
});

test('after the LIVE: the capture file is cut into part-N pieces (+ parts-N.csv) before the clips, the file goes; a crash leaves it for next time', async () => {
  const dir = tmp();
  // a "capture" of 70 s and a fake ffmpeg that writes the pieces the real one would
  fs.writeFileSync(path.join(dir, 'capture-0.webm'), Buffer.alloc(300000));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ v: 1, handle: 'h', startedAt: 1000, endedAt: 80000, stream: { kind: 'capture' }, moments: [], clips: {},
    runs: [{ index: 0, startedAt: 2000, endedAt: 72000, capture: true, file: 'capture-0.webm', mime: 'video/webm;codecs=h264,opus', samples: [[0, 2000], [60000, 62000]], lastMediaMs: 70000 }] }));
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    spawned.push(args);
    const p = new EventEmitter(); p.stderr = new EventEmitter(); p.stdout = new EventEmitter(); p.pid = 1;
    setImmediate(() => {
      if (args.includes('-f') && args[args.indexOf('-f') + 1] === 'segment') {
        const cwd = opts.cwd;
        fs.writeFileSync(path.join(cwd, 'part-0-000.mp4'), Buffer.alloc(100000));
        fs.writeFileSync(path.join(cwd, 'part-0-001.mp4'), Buffer.alloc(20000));
        fs.writeFileSync(path.join(cwd, 'parts-0.csv'), 'part-0-000.mp4,0.000000,60.000000\npart-0-001.mp4,60.000000,70.000000\n');
      }
      p.emit('close', 0);
    });
    return p;
  };
  const logs = [];
  const jobs = new ClipJobs({ api: {}, ffmpegPath: process.execPath, fontFile: null, spawn, log: (l, m) => logs.push(`${l} ${m}`) });
  const progress = [];
  jobs.on('progress', (p) => progress.push(p.phase));
  assert.equal(await jobs.processCaptures(dir), 1);
  assert.ok(!fs.existsSync(path.join(dir, 'capture-0.webm')), 'the capture file is gone once its pieces exist');
  assert.ok(fs.existsSync(path.join(dir, 'part-0-001.mp4')));
  assert.deepEqual(progress, ['capture', 'capture_done']);
  const a = spawned[0];
  assert.equal(a[a.indexOf('-i') + 1], 'capture-0.webm');
  assert.equal(a[a.indexOf('-c:v') + 1], 'copy');
  const s = C.readSession(dir);
  assert.equal(s.runs[0].parts.length, 2);
  assert.equal(await jobs.processCaptures(dir), 0, 'done once');
  // the clip maker reads it like any recording (the run is placed on the server clock with the TikTok delay, see below)
  const tl = C.timeline(s, 8000);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].wallStart, 2000 + 8000);
  // a crash before the cut: the run has its file but no pieces -> owed (show-manager's resume checks the same thing)
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'capture-0.webm'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir2, 'session.json'), JSON.stringify({ v: 1, startedAt: 1000, endedAt: null, runs: [{ index: 0, startedAt: 2000, endedAt: null, capture: true, file: 'capture-0.webm', samples: [[0, 2000]], lastMediaMs: 30000 }] }));
  const files = fs.readdirSync(dir2);
  const owed = JSON.parse(fs.readFileSync(path.join(dir2, 'session.json'), 'utf8')).runs.some((r) => r.capture && r.file && files.includes(r.file) && !files.some((f) => /^part-0-\d+\.mp4$/.test(f)));
  assert.equal(owed, true);
  // an empty capture file is skipped and said so, never "cut"
  const dir3 = tmp();
  fs.writeFileSync(path.join(dir3, 'capture-0.webm'), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir3, 'session.json'), JSON.stringify({ v: 1, startedAt: 1, endedAt: 2, runs: [{ index: 0, capture: true, file: 'capture-0.webm' }] }));
  assert.equal(await jobs.processCaptures(dir3), 0);
  assert.ok(logs.some((l) => /wrote nothing/.test(l)));
});

test('clip timing: a back-up run shows a moment as it happens, so its pieces sit delayMs later on the server clock and the review cut lands on the right content', () => {
  // The same review recorded two ways. TikTok copy: media 0 = server 100000 (what viewers saw at 100000 happened at 92000).
  // Back-up: media 0 = server 100000 too (what the camera saw at 100000).
  const review = { startedAt: 120000, endedAt: 150000 };   // the host clicked "on air" at 120000, moved on at 150000
  const opts = { ...C.DEFAULTS, delayMs: 8000, padStartMs: 0, padEndMs: 0 };
  const plan = C.planReview(review, {}, 200000, opts);
  assert.equal(plan.full.from, 128000, 'the plan looks 8 s later for the TikTok copy');
  const tiktok = { runs: [{ index: 0, startedAt: 100000, samples: [[0, 100000]], parts: [{ file: 'part-0-000.mp4', start: 0, end: 600 }] }] };
  const backup = { runs: [{ index: 0, startedAt: 100000, capture: true, samples: [[0, 100000]], parts: [{ file: 'part-0-000.mp4', start: 0, end: 600 }] }] };
  const cutT = C.cutsFor(C.timeline(tiktok, 8000), plan.full.from, plan.full.to)[0];
  const cutB = C.cutsFor(C.timeline(backup, 8000), plan.full.from, plan.full.to)[0];
  assert.deepEqual([cutT.inSec, cutT.outSec], [28, 58], 'TikTok copy: 28 s in = the delayed picture of the click at 120000');
  assert.deepEqual([cutB.inSec, cutB.outSec], [20, 50], 'back-up: 20 s in = the click itself (no delay to skip)');
  assert.deepEqual(C.cutsFor(C.timeline(backup), plan.full.from, plan.full.to)[0].inSec, 28, 'without the delay given, a back-up run is treated like the copy (old callers)');
  // a "Clip that" moment: same rule
  const m = C.planMoments([{ at: 140000 }], opts)[0];
  const mT = C.cutsFor(C.timeline(tiktok, 8000), m.from, m.to)[0], mB = C.cutsFor(C.timeline(backup, 8000), m.from, m.to)[0];
  assert.equal(mT.inSec - mB.inSec, 8);
});

test('a session.json of a back-up recording: Recordings reads it as recorded (bytes from the capture file), with the back-up flag', () => {
  const { ShowManager } = require('../src/core/show-manager');
  const ctl = new EventEmitter(); ctl.clockOffset = 0; ctl.cfg = { clips: { enabled: true } };
  const link = new EventEmitter(); link.conn = null;
  const store = new Map();
  const root = tmp();
  const show = new ShowManager({ ctl, link, api: {}, store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, ffmpegPath: process.execPath, fontFile: null, defaultRoot: root });
  clearInterval(show.nudgeTimer);
  const d = path.join(root, 'a'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'capture-0.webm'), Buffer.alloc(123456));
  fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ v: 1, handle: 'h', startedAt: 1, endedAt: 2, runs: [{ index: 0, capture: true, file: 'capture-0.webm' }], clips: {} }));
  const x = show.listRecordings()[0];
  assert.equal(x.failed, null);
  assert.equal(x.recordedBytes, 123456);
  assert.equal(x.captured, true);
  assert.equal(show.getState().captureAvailable, false, 'no screen recorder in a headless app');
  assert.equal(CAPTURE_AFTER_MS, 75000);
});
