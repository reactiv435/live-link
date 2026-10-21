'use strict';
// 2.0.7: a LIVE that TikTok never hands the video for (shadowulf75, Oct 18 + 21: "0 MB · no clips yet", no error
// anywhere). The recorder keeps asking for the whole LIVE, notices within a minute that nothing is being saved, says why,
// writes what TikTok answered into session.json, and tries every link it was given.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder, NO_LINK_RETRY, FAILURE_TEXT, cleanErr } = require('../src/core/recorder');
const { streamCandidates, pickStream, whyNoStream } = require('../src/core/stream-url');
const { roomFromPageHtml } = require('../src/core/tiktok-link');
const { errInfo } = require('../src/core/show-manager');
const { ClipJobs } = require('../src/core/clip-jobs');

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

// A fake clock with timers and intervals that run in time order.
function fakeClock(start = 1_792_555_294_742) {
  let t = start, id = 0;
  const timers = [];
  const add = (fn, ms, every) => { const x = { id: ++id, fn, at: t + Math.max(0, ms), every }; timers.push(x); return x; };
  const clear = (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); };
  return {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (x) => clear(x),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (x) => clear(x),
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
    },
  };
}

// A fake ffmpeg: `behave(child, url, cwd)` decides what each run does (write a piece, fail with a message...).
function fakeSpawn(behave) {
  const runs = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let closed = false;
    child.close = (code) => { if (!closed) { closed = true; child.emit('close', code); } };
    child.stdin = { write() {}, end() { setImmediate(() => child.close(0)); } };
    child.kill = () => child.close(1);
    const url = args[args.indexOf('-i') + 1];
    runs.push({ url, cwd: opts.cwd, args });
    setImmediate(() => behave(child, url, opts.cwd, args));
    return child;
  };
  return { spawn, runs };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'll-health-'));
// A run that keeps writing (like a real recording): a piece that grows every 2 s until ffmpeg is told to stop.
function keepWriting(c, child, cwd, file) {
  const p = path.join(cwd, file);
  fs.writeFileSync(p, Buffer.alloc(5000));
  child.stdout.emit('data', Buffer.from('out_time_us=2000000\nprogress=continue\n'));
  const iv = c.setInterval(() => fs.appendFileSync(p, Buffer.alloc(1000)), 2000);
  child.on('close', () => c.clearInterval(iv));
}
const readSession = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));

test('no video address for the whole LIVE: keeps asking past 3 minutes (4 s, 15 s, then every minute) for 3 hours, red within 60 s, recovers when a link comes', async () => {
  const c = fakeClock();
  const t0 = c.now();
  const linkAt = t0 + 2 * 3600000;                // TikTok finally hands out the video 2 h in
  const asks = [];
  const ff = fakeSpawn((child, url, cwd) => keepWriting(c, child, cwd, 'part-0-000.mp4'));
  const logs = [];
  const rec = new Recorder({ ffmpegPath: process.execPath, clock: c.now, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    setInterval: c.setInterval, clearInterval: c.clearInterval, spawn: ff.spawn, log: (l, m) => logs.push(`${l} ${m}`) });
  const failures = [];
  rec.on('failure', (f) => failures.push(f));
  const getStream = async () => {
    asks.push(c.now());
    if (c.now() >= linkAt) return { url: 'https://pull.example/origin.flv', kind: 'flv', quality: 'origin', codec: 'h264', from: 'room info', alternates: [] };
    rec.noteStreamErrors([{ source: 'room info', code: 'restricted', error: 'TikTok answered status 4003110 with no video' }, { source: 'LIVE page', code: 'waf', error: "TikTok's bot check" }],
      { reason: 'stream_restricted', detail: "room info: status 4003110 (restricted) · LIVE page: TikTok's bot check (WAF page)" });
    return null;
  };
  const dir = await rec.start({ root: tmp(), handle: 'shadowulf75', roomId: '7698965875919031070', getStream, app: '2.0.7' });
  assert.ok(dir);

  await c.advance(59000);
  assert.equal(rec.getState().failure, null, 'not red before a minute');
  await c.advance(6000);
  const f = rec.getState().failure;
  assert.equal(f && f.reason, 'stream_restricted', 'red within ~60 s, with the reason');
  assert.equal(f.text, FAILURE_TEXT.stream_restricted);
  assert.match(f.detail, /4003110/);
  assert.equal(failures.length, 1);
  assert.equal(readSession(dir).diag.failure.reason, 'stream_restricted', 'saved for the host to send');

  await c.advance(linkAt - c.now() - 1);
  const gaps = (from, to) => { const a = asks.filter((x) => x >= from && x < to); return a.slice(1).map((x, i) => x - a[i]); };
  assert.ok(gaps(t0, t0 + 170000).every((g) => g === 4000), 'every 4 s for the first 3 minutes');
  assert.ok(gaps(t0 + 190000, t0 + 590000).every((g) => g === 15000), 'every 15 s up to 10 minutes');
  const late = gaps(t0 + 11 * 60000, linkAt);
  assert.ok(late.length > 100 && late.every((g) => g === 60000), `then every minute for the rest of the LIVE (${late.length} tries)`);
  assert.ok(asks[asks.length - 1] > linkAt - 61000, 'still asking 2 hours in');
  assert.equal(ff.runs.length, 0);
  assert.ok(logs.filter((l) => /no video link from TikTok/.test(l)).length < 30, 'the log is not flooded (one line per change of pace / 10 min)');

  await c.advance(61000);
  assert.equal(ff.runs.length, 1, 'the link arrives: recording starts');
  await c.advance(6000);
  assert.equal(rec.getState().failure, null, 'bytes on disk: the red card clears');
  assert.ok(rec.getState().bytes >= 5000, 'the size comes from the disk (ffmpeg says total_size=N/A for pieces)');
  await c.advance(5 * 60000);
  assert.equal(rec.getState().failure, null, 'still writing: stays fine');

  await rec.stop();
  const s = readSession(dir);
  assert.equal(s.app, '2.0.7');
  assert.equal(s.runs.length, 1);
  assert.ok(s.diag.tries > 150, `tries counted (${s.diag.tries})`);
  assert.ok(s.diag.firstVideoAt);
  assert.equal(s.diag.failures[0].reason, 'stream_restricted');
  assert.ok(s.diag.failures[0].from && s.diag.failures[0].to, 'the failure has a start and an end');
  assert.equal(s.diag.result, 'partial');
  const room = s.streamErrors.find((e) => e.source === 'room info');
  assert.equal(room.code, 'restricted');
  assert.ok(room.count > 150, 'one entry per distinct answer, counted (not one line per try)');
  assert.ok(room.first < room.last);
  assert.ok(s.streamErrors.length <= 40);
});

test('a link that writes nothing (0 bytes) is a failed run: the next quality/format is tried; all failing = recording_failed', async () => {
  const c = fakeClock();
  const good = (child, url, cwd) => keepWriting(c, child, cwd, `part-${ff.runs.length - 1}-000.mp4`);
  const bad = (child) => { child.stderr.emit('data', Buffer.from('[http @ 0x1] HTTP error 403 Forbidden\nhttps://pull.example/origin.flv?sign=SECRET: Server returned 403 Forbidden (access denied)\n')); child.close(1); };
  let failAll = false;
  const ff = fakeSpawn((child, url, cwd) => (failAll || url.includes('origin') ? bad(child) : good(child, url, cwd)));
  const rec = new Recorder({ ffmpegPath: process.execPath, clock: c.now, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    setInterval: c.setInterval, clearInterval: c.clearInterval, spawn: ff.spawn });
  const stream = { url: 'https://pull.example/origin.flv?sign=SECRET', kind: 'flv', quality: 'origin', from: 'api-live',
    alternates: [{ url: 'https://pull.example/origin.m3u8?sign=SECRET', kind: 'hls', quality: 'origin-hls' }, { url: 'https://pull.example/sd.flv', kind: 'flv', quality: 'sd' }] };
  const dir = await rec.start({ root: tmp(), handle: 'h', roomId: '1', getStream: async () => stream });
  await c.advance(20000);
  const s = readSession(dir);
  assert.equal(s.runs[0].bytes, 0);
  assert.match(s.runs[0].error, /403 Forbidden/);
  assert.doesNotMatch(JSON.stringify(s), /SECRET/, 'no signed link in session.json');
  assert.deepEqual(ff.runs.map((r) => r.url.split('?')[0]), ['https://pull.example/origin.flv', 'https://pull.example/origin.m3u8', 'https://pull.example/sd.flv'].slice(0, ff.runs.length));
  assert.equal(s.runs[s.runs.length - 1].quality, 'sd', 'the failing links are skipped: sd records');
  assert.ok(s.streamErrors.some((e) => e.source === 'ffmpeg' && e.code === 'no_video'));
  await c.advance(70000);
  assert.equal(rec.getState().failure, null, 'sd is writing: no red card');
  await rec.stop();

  // every link fails: after a minute of nothing on disk -> recording_failed, with ffmpeg's last words
  failAll = true;
  const c2 = fakeClock();
  const rec2 = new Recorder({ ffmpegPath: process.execPath, clock: c2.now, now: c2.now, setTimeout: c2.setTimeout, clearTimeout: c2.clearTimeout,
    setInterval: c2.setInterval, clearInterval: c2.clearInterval, spawn: ff.spawn });
  const dir2 = await rec2.start({ root: tmp(), handle: 'h', roomId: '1', getStream: async () => stream });
  await c2.advance(66000);
  const f = rec2.getState().failure;
  assert.equal(f && f.reason, 'recording_failed');
  assert.match(f.detail, /403 Forbidden/);
  assert.doesNotMatch(f.detail, /SECRET/);
  await rec2.stop();
  const s2 = readSession(dir2);
  assert.equal(s2.diag.result, 'failed');
  assert.equal(s2.diag.failure.reason, 'recording_failed');
});

test('a LIVE shorter than a minute that saved nothing is still marked failed, with why (for the Recordings list)', async () => {
  const c = fakeClock();
  const rec = new Recorder({ ffmpegPath: process.execPath, clock: c.now, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    setInterval: c.setInterval, clearInterval: c.clearInterval, spawn: fakeSpawn(() => {}).spawn });
  const dir = await rec.start({ root: tmp(), handle: 'h', roomId: '1', getStream: async () => { rec.noteStreamErrors([{ source: 'room info', code: 'no_stream_data', error: 'no links' }], { reason: 'stream_unavailable', detail: 'room info: no video links' }); return null; } });
  await c.advance(30000);
  await rec.stop();
  const s = readSession(dir);
  assert.equal(s.diag.result, 'failed');
  assert.equal(s.diag.failure.reason, 'stream_unavailable');
  assert.equal(s.diag.recordedBytes, 0);
});

test('"Try again now" asks TikTok at once and goes back to asking every few seconds', async () => {
  const c = fakeClock();
  let asks = 0;
  const rec = new Recorder({ ffmpegPath: process.execPath, clock: c.now, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    setInterval: c.setInterval, clearInterval: c.clearInterval, spawn: fakeSpawn(() => {}).spawn });
  await rec.start({ root: tmp(), handle: 'h', roomId: '1', getStream: async () => { asks++; return null; } });
  await c.advance(15 * 60000);
  const before = asks;
  assert.equal(rec.retryNow(), true);
  await flush();
  assert.equal(asks, before + 1, 'asked right away');
  await c.advance(20000);
  assert.equal(asks, before + 6, 'every 4 s again');
  await rec.stop();
  assert.equal(rec.retryNow(), false, 'not after the recording ended');
});

test('stream links: every quality and format, H.264 first, FLV before HLS, the H.265 copy and old fields last; audio-only skipped', () => {
  const sd = (data) => ({ stream_data: JSON.stringify({ data }) });
  const room = {
    data: {
      stream_url: {
        live_core_sdk_data: { pull_data: sd({
          ao: { main: { flv: 'https://p/ao.flv' } },
          sd: { main: { flv: 'https://p/sd.flv', hls: 'https://p/sd.m3u8', sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '480x854' }) } },
          origin: { main: { flv: 'https://p/origin.flv', sdk_params: JSON.stringify({ VCodec: 'h265', resolution: '1080x1920' }) } },
          hd: { main: { flv: 'https://p/hd.flv', hls: 'https://p/hd.m3u8', sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '720x1280' }) } },
          weird_new_key: { main: { hls: 'https://p/new.m3u8', sdk_params: '{}' } },
        }) },
        flv_pull_url: { SD1: 'https://p/old-sd1.flv', FULL_HD1: 'https://p/old-fhd.flv', HD1: 'https://p/hd.flv' },
        hls_pull_url_map: { HD1: 'https://p/old-hd.m3u8' },
        rtmp_pull_url: 'rtmp://p/not-http',
        hls_pull_url: 'https://p/old.m3u8',
      },
    },
  };
  assert.deepEqual(streamCandidates(room).map((x) => x.url.replace('https://p/', '')), [
    'hd.flv', 'hd.m3u8', 'sd.flv', 'sd.m3u8', 'new.m3u8',      // H.264 (or unknown) by quality, FLV first
    'origin.flv',                                               // H.265 after
    'old-fhd.flv', 'old-sd1.flv', 'old-hd.m3u8', 'old.m3u8',    // old fields (duplicates and rtmp:// dropped)
  ]);
  const best = pickStream(room);
  assert.equal(best.url, 'https://p/hd.flv');
  assert.equal(best.height, 1280);
  assert.equal(best.alternates.length, 9);
  // the LIVE page / api-live H.265 copy (hevcStreamData)
  const page = { liveRoom: { streamData: { pull_data: sd({ hd: { main: { flv: 'https://p/a.flv', sdk_params: '{}' } } }) }, hevcStreamData: { pull_data: sd({ origin: { main: { flv: 'https://p/b.flv', sdk_params: '{}' } } }) } } };
  assert.deepEqual(streamCandidates(page).map((x) => [x.url, x.codec]), [['https://p/a.flv', null], ['https://p/b.flv', 'h265']]);
});

test('why an answer had no link: 4003110 restricted, status 4 ended, no streamData', () => {
  assert.equal(whyNoStream({ data: { prompts: '' }, extra: { now: 1 }, status_code: 4003110 }).code, 'restricted');
  assert.equal(whyNoStream({ data: { message: 'room has finished' }, status_code: 30003 }).code, 'tiktok_error');
  assert.equal(whyNoStream({ data: { user: { status: 4 }, liveRoom: { status: 4 } }, statusCode: 0 }).code, 'ended');
  assert.equal(whyNoStream({ user: { status: 2 }, liveRoom: { status: 2 } }).code, 'no_stream_data');
  assert.equal(whyNoStream(null).code, 'empty');
  assert.equal(streamCandidates({ data: { prompts: '' }, status_code: 4003110 }).length, 0);
});

test('the LIVE page: TikTok\'s bot check is told apart from a moved layout; room data found in SIGI_STATE or UNIVERSAL_DATA', () => {
  const waf = '<!DOCTYPE html> <html lang="en"> <head></head> <body> Please wait... <p id="wci" class="_wafchallengeid"></p> <script src="https://x/waf-aiso/ttp9806.js"></script> </body> </html>';
  assert.throws(() => roomFromPageHtml(waf), (e) => e.code === 'waf');
  assert.throws(() => roomFromPageHtml('<html><body>hello</body></html>'), (e) => e.code === 'no_room_data');
  const room = { user: { roomId: '7', status: 2 }, liveRoom: { status: 2, streamData: { pull_data: { stream_data: '{}' } } } };
  const sigi = `<script id="SIGI_STATE" type="application/json">${JSON.stringify({ LiveRoom: { liveRoomUserInfo: room } })}</script>`;
  assert.deepEqual(roomFromPageHtml(sigi), room);
  const uni = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.live-detail': { liveRoomUserInfo: room } } })}</script>`;
  assert.deepEqual(roomFromPageHtml(uni), room);
});

test('a refused request is classified with its HTTP status (got errors) and no links leak into the message', () => {
  const e403 = Object.assign(new Error('Response code 403 (Forbidden)'), { code: 'ERR_NON_2XX_3XX_RESPONSE', response: { statusCode: 403 } });
  assert.deepEqual(errInfo(e403), { code: 'http_403', http: 403, message: 'Response code 403 (Forbidden)' });
  assert.equal(errInfo(Object.assign(new Error('Timeout awaiting request for 10000ms'), { code: 'ETIMEDOUT' })).code, 'timeout');
  assert.equal(errInfo(Object.assign(new Error('getaddrinfo ENOTFOUND webcast.tiktok.com'), { code: 'ENOTFOUND' })).code, 'network');
  assert.equal(errInfo(new Error('Failed to extract the SIGI_STATE HTML tag, you might be blocked by TikTok.')).code, 'waf');
  const wrapped = { message: 'Failed to fetch room info.', exception: e403 };
  assert.equal(errInfo(wrapped).http, 403);
  assert.equal(cleanErr('GET https://pull.example/a.flv?sign=abc&expire=1 failed'), 'GET <pull.example> failed');
});

test('every reason sent to the site is lowercase letters and underscores, at most 40 characters', () => {
  const { ISSUE_TEXT } = require('../src/core/show-manager');
  for (const reason of [...Object.keys(FAILURE_TEXT), ...Object.keys(ISSUE_TEXT)]) assert.match(reason, /^[a-z_]{1,40}$/, reason);
  for (const step of NO_LINK_RETRY) assert.ok(step.everyMs <= 60000, 'never waits more than a minute between asks');
});

test('clips for a LIVE with nothing recorded: said out loud (log + result), every review marked not_recorded', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ v: 1, handle: 'shadowulf75', startedAt: 1_792_555_294_742, endedAt: 1_792_566_450_156, stream: null, runs: [], clips: {}, moments: [],
    diag: { failure: { reason: 'stream_restricted', detail: 'room info: status 4003110 (restricted)' } } }));
  const logs = [];
  const api = { reviews: async () => ({ reviews: [{ play_id: 'p1', started_at: new Date(1_792_556_000_000).toISOString(), ended_at: new Date(1_792_556_200_000).toISOString(), title: 'A' }, { play_id: 'p2', started_at: new Date(1_792_557_000_000).toISOString(), ended_at: new Date(1_792_557_200_000).toISOString(), title: 'B' }] }) };
  const jobs = new ClipJobs({ api, ffmpegPath: process.execPath, fontFile: null, log: (l, m) => logs.push(`${l} ${m}`) });
  const progress = [];
  jobs.on('progress', (p) => progress.push(p));
  const r = await jobs.processSession(dir);
  assert.equal(r.notRecorded, true);
  assert.equal(r.skipped, 2);
  assert.ok(logs.some((l) => /^error clips: nothing of .* was recorded \(stream_restricted/.test(l)), logs.join('\n'));
  assert.equal(progress[progress.length - 1].notRecorded, true);
  const s = readSession(dir);
  assert.equal(s.clips.p1.status, 'not_recorded');
  assert.equal(s.clipsNotRecorded, true);
});
