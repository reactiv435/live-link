'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ShowManager } = require('../src/core/show-manager');

function setup({ clips = true } = {}) {
  const ctl = new EventEmitter(); ctl.clockOffset = 0; ctl.cfg = { clips: { enabled: clips, delay_ms: 5000 } };
  const link = new EventEmitter(); link.conn = { roomInfo: { data: { stream_url: { flv_pull_url: { HD1: 'https://pull.example/a.flv' } } } } };
  const store = new Map(); const st = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  let t = 1_000_000; const timers = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'll-show-'));
  const show = new ShowManager({ ctl, link, api: {}, store: st, ffmpegPath: process.execPath, fontFile: null, defaultRoot: root, now: () => t,
    setTimeout: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, clearTimeout: () => {}, clipDelayMs: 90000 });
  clearInterval(show.nudgeTimer);
  // a fake recorder: records calls, no ffmpeg
  const rec = new EventEmitter(); rec.active = false; rec.dir = null; rec.calls = []; rec.notes = [];
  rec.start = async (o) => { rec.calls.push(['start', o.roomId, o.handle]); rec.active = true; rec.dir = path.join(root, 'r1'); rec.stream = await o.getStream(false); return rec.dir; };
  rec.stop = async () => { rec.calls.push(['stop']); rec.active = false; rec.emit('finished', { dir: rec.dir }); return rec.dir; };
  rec.noteActivity = (w, at) => rec.notes.push([w, at]);
  rec.session = { moments: [] };
  rec.markMoment = (at, by) => { if (!rec.active) return null; const m = { at, by }; rec.session.moments.push(m); return m; };
  rec.failure = null; rec.error = null; rec.noted = []; rec.retries = 0;
  rec.getState = () => ({ recording: rec.active, failure: rec.failure, error: rec.error });
  rec.noteStreamErrors = (tries, verdict) => rec.noted.push({ tries, verdict });
  rec.retryNow = () => { rec.retries++; return true; };
  show.recorder = rec;
  // what the controller is told about recording while LIVE
  ctl.issues = []; ctl.setRecordingIssue = (i) => ctl.issues.push(i);
  show._wireRecorder(rec);   // what the constructor wires on the real one
  const queued = []; show.jobs.enqueue = (dir, o) => queued.push([dir, o]);
  const live = (extra = {}) => ({ phase: 'ready', connected: true, tiktok: { status: 'live', roomId: '777' }, tiktokUsername: 'host1', siteLive: true, target: { title: 'Song' }, paused: false, dryRun: false, ...extra });
  return { ctl, link, show, rec, queued, timers, live, adv: (ms) => { t += ms; }, runTimers: () => { for (const x of timers.splice(0)) if (x.at <= t) x.fn(); } };
}

test('records when the LIVE is confirmed, stops when it ends, then queues the clips after the delay', async () => {
  const { ctl, rec, queued, timers, live, adv, runTimers } = setup();
  ctl.emit('state', { ...live(), tiktok: { status: 'connecting', roomId: '777' }, connected: false });
  assert.equal(rec.calls.length, 0, 'not before the LIVE is confirmed');
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rec.calls[0], ['start', '777', 'host1']);
  assert.equal(rec.stream.url, 'https://pull.example/a.flv');
  ctl.emit('state', { ...live(), tiktok: { status: 'reconnecting', roomId: '777' } });
  assert.equal(rec.calls.length, 1, 'a reconnect keeps the same recording');
  ctl.emit('state', { ...live(), connected: false, tiktok: { status: 'offline', roomId: null } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rec.calls[1], ['stop']);
  assert.equal(queued.length, 0);
  assert.equal(timers.length, 1);
  adv(90000); runTimers();
  assert.equal(queued.length, 1);
});

test('clips off on the site: it still records; the full show is made but no review clips are sent', async () => {
  const { ctl, rec, queued, timers, live, show, adv, runTimers } = setup({ clips: false });
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.calls[0][0], 'start');
  await rec.stop();
  assert.equal(timers.length, 1);
  assert.equal(show.getState().busy, true, 'waiting to start: not safe to close yet');
  adv(90000); runTimers();
  assert.deepEqual(queued[0][1], { reviews: false });
  assert.equal(show.makeClips(rec.dir).error, 'clips_off');
});

test('host Stop: no restart in the same LIVE; Record or a new LIVE starts again', async () => {
  const { ctl, rec, show, live } = setup();
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  await show.stopByHost();
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.calls.filter((c) => c[0] === 'start').length, 1, 'stopped by the host stays stopped');
  ctl.emit('state', live({ tiktok: { status: 'live', roomId: '888' } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.calls.filter((c) => c[0] === 'start').length, 2, 'a new LIVE records again');
});

test('taps and gifts feed the hottest-moment log; the quiet nudge waits 2 min and repeats at most every 10 min', async () => {
  const { ctl, link, rec, show, live, adv } = setup();
  let nudges = 0; show.on('nudge', () => nudges++);
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  link.emit('like', { count: 7 });
  link.emit('gift', { coins: 5, count: 1 });
  assert.deepEqual(rec.notes.map((n) => n[0]), [7, 50]);
  adv(60000); show._checkNudge(); assert.equal(nudges, 0);
  adv(61000); show._checkNudge(); assert.equal(nudges, 1);
  adv(120000); show._checkNudge(); assert.equal(nudges, 1, 'not again within 10 min');
  link.emit('like', { count: 1 });
  adv(9 * 60000); show._checkNudge(); assert.equal(nudges, 2);
  ctl.emit('state', live({ target: null }));
  adv(20 * 60000); show._checkNudge(); assert.equal(nudges, 2, 'no song on air: no nudge');
});

test('after a restart, unfinished clips are picked up once the app is ready (a crashed recording gets its end time)', async () => {
  const { ctl, show, queued, live } = setup();
  const root = show.root();
  const mk = (name, s) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify(s)); return d; };
  const t = 1_790_000_000_000;   // real epoch times (the test clock is far behind: every recording counts as recent)
  const done = mk('done', { startedAt: t - 7200000, endedAt: t - 3600000, runs: [], clipsDoneAt: 'x' });
  const crashed = mk('crashed', { startedAt: t - 7200000, endedAt: null, runs: [{ index: 0, endedAt: null, samples: [[0, t - 7200000], [3000000, t - 4200000]], lastMediaMs: 3600000 }] });
  const pending = mk('pending', { startedAt: t - 7200000, endedAt: t - 3600000, runs: [] });
  ctl.emit('state', { ...live(), connected: false, tiktok: { status: 'offline' } });
  const dirs = queued.map((q) => q[0]);
  assert.ok(dirs.includes(pending) && dirs.includes(crashed) && !dirs.includes(done));
  assert.equal(JSON.parse(fs.readFileSync(path.join(crashed, 'session.json'), 'utf8')).endedAt, t - 3600000);
  ctl.emit('state', { ...live(), connected: false, tiktok: { status: 'offline' } });
  assert.equal(queued.length, dirs.length, 'only once per app run');
});

test('"Clip that": only while recording; with review clips off, a LIVE with moments is still queued (moments only)', async () => {
  const { ctl, rec, show, live, queued, timers, adv, runTimers } = setup({ clips: false });
  assert.equal(show.markMoment('button').error, 'not_recording');
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(show.markMoment('hotkey'), { ok: true, count: 1 });
  assert.equal(rec.session.moments[0].by, 'hotkey');
  await rec.stop();
  assert.equal(timers.length, 1, 'queued after the delay even though review clips are off');
  adv(90000); runTimers();
  assert.deepEqual(queued[0][1], { reviews: false });
  // the Recordings button works for moments when review clips are off
  fs.mkdirSync(rec.dir, { recursive: true });
  fs.writeFileSync(path.join(rec.dir, 'session.json'), JSON.stringify({ startedAt: 1, endedAt: 2, runs: [], moments: [{ at: 1 }] }));
  assert.equal(show.makeClips(rec.dir).ok, true);
  assert.deepEqual(queued[1][1], { force: true, reviews: false });
});

test('stream link: a fresh try asks TikTok first and falls back to the kept room info; the LIVE page is asked too', async () => {
  const { show, link, adv } = setup();
  const pull = (u) => ({ data: { stream_url: { flv_pull_url: { HD1: u } } } });
  const asked = [];
  link.conn = { roomInfo: pull('https://pull.example/kept.flv'), fetchRoomInfo: async () => { asked.push('room'); return { data: {} }; } };
  link.liveRoomFromPage = async () => { asked.push('page'); return null; };
  assert.equal((await show._stream(true)).url, 'https://pull.example/kept.flv');
  assert.deepEqual(asked, ['room', 'page']);
  asked.length = 0;
  assert.equal((await show._stream(false)).url, 'https://pull.example/kept.flv');
  assert.deepEqual(asked, [], 'not fresh: the kept copy answers first');
  link.conn = { roomInfo: null, fetchRoomInfo: async () => { throw new Error('blocked'); } };
  link.liveRoomFromPage = async () => ({ liveRoom: { streamData: { pull_data: { stream_data: JSON.stringify({ data: { origin: { main: { flv: 'https://pull.example/page.flv', sdk_params: '{}' } } } }) } } } });
  adv(30000);   // the LIVE page is asked at most every 30 s
  assert.equal((await show._stream(true)).url, 'https://pull.example/page.flv', 'room info refused: the LIVE page answers');
});

// ---------------------------------------------------------------- 2.0.7: the video address, and "Not recording"

const RESTRICTED = { data: { prompts: '' }, extra: { now: 1 }, status_code: 4003110 };   // what TikTok's room info answers (measured 2026-10-21)
const WAF_PAGE = '<!DOCTYPE html><html><body> Please wait... <p id="wci" class="_wafchallengeid"></p></body></html>';
const sdkPull = (u) => ({ stream_data: JSON.stringify({ data: { origin: { main: { flv: `${u}.flv`, hls: `${u}.m3u8`, sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '720x1280' }) } }, sd: { main: { flv: `${u}-sd.flv`, sdk_params: '{}' } } } }) });

test('no video address: every source is asked (room info, api-live, LIVE page, kept copy) and what each answered is recorded', async () => {
  const { show, link, rec, adv } = setup();
  const asked = [];
  link.conn = { roomInfo: RESTRICTED, fetchRoomInfo: async () => { asked.push('room'); return RESTRICTED; } };
  link.liveRoomFromApi = async () => { asked.push('api'); return { data: { user: { roomId: '7', status: 2 }, liveRoom: { status: 2 } } }; };
  const { roomFromPageHtml } = require('../src/core/tiktok-link');
  link.liveRoomFromPage = async () => { asked.push('page'); return roomFromPageHtml(WAF_PAGE); };
  assert.equal(await show._stream(true), null);
  assert.deepEqual(asked, ['room', 'api', 'page']);
  const n = rec.noted[rec.noted.length - 1];
  assert.deepEqual(n.tries.map((x) => [x.source, x.code]), [['room info', 'restricted'], ['api-live', 'no_stream_data'], ['LIVE page', 'waf'], ['kept room info', 'restricted']]);
  assert.equal(n.verdict.reason, 'stream_restricted', 'room info says 4003110 while TikTok says the LIVE is on');
  assert.match(n.verdict.detail, /room info: status 4003110 \(restricted\).*LIVE page: TikTok's bot check/);
  // 4 s later: only room info is asked again; api-live and the LIVE page (TikTok's lookup pages) at most every 30 s,
  // their last answer still counts for the verdict
  asked.length = 0;
  adv(4000);
  assert.equal(await show._stream(true), null);
  assert.deepEqual(asked, ['room']);
  assert.deepEqual(rec.noted[rec.noted.length - 1].tries.map((x) => x.source), ['room info', 'kept room info'], 'only what was asked is counted in session.json');
  assert.equal(rec.noted[rec.noted.length - 1].verdict.reason, 'stream_restricted');
  assert.match(rec.noted[rec.noted.length - 1].verdict.detail, /api-live: no video links.*LIVE page: TikTok's bot check/);
  // 30 s on: api-live is asked again; the bot check is left alone for 10 minutes (asking more makes a block last longer)
  asked.length = 0;
  adv(30000);
  await show._stream(true);
  assert.deepEqual(asked, ['room', 'api']);
  adv(10 * 60000);
  asked.length = 0;
  await show._stream(true);
  assert.deepEqual(asked, ['room', 'api', 'page'], 'after 10 minutes the LIVE page is tried again');
  adv(30000);
  // api-live lists the links: recorded from there, with every other quality/format as a fallback
  link.liveRoomFromApi = async () => ({ data: { user: { roomId: '7', status: 2 }, liveRoom: { status: 2, streamData: { pull_data: sdkPull('https://pull.example/api') } } } });
  const s = await show._stream(true);
  assert.equal(s.url, 'https://pull.example/api.flv');
  assert.equal(s.from, 'api-live');
  assert.deepEqual(s.alternates.map((a) => a.url), ['https://pull.example/api.m3u8', 'https://pull.example/api-sd.flv']);
});

test('no video address: every request refused (403/429, bot check) = stream_blocked; HTTP status kept for the log', async () => {
  const { show, link, rec } = setup();
  const httpErr = (code) => Object.assign(new Error(`Response code ${code}`), { code: 'ERR_NON_2XX_3XX_RESPONSE', response: { statusCode: code } });
  link.conn = { roomInfo: null, fetchRoomInfo: async () => { throw httpErr(403); } };
  link.liveRoomFromApi = async () => { throw httpErr(429); };
  link.liveRoomFromPage = async () => { throw Object.assign(new Error('TikTok sent its bot check instead of the LIVE page'), { code: 'waf' }); };
  assert.equal(await show._stream(true), null);
  const n = rec.noted[rec.noted.length - 1];
  assert.deepEqual(n.tries.map((x) => [x.code, x.http]), [['http_403', 403], ['http_429', 429], ['waf', null]]);
  assert.equal(n.verdict.reason, 'stream_blocked');
  // no answer had anything usable but nothing was refused either: stream_unavailable
  show.cooldown.clear(); show.lastAnswer.clear();
  link.conn = { roomInfo: null, fetchRoomInfo: async () => ({ data: { status: 2 } }) };
  link.liveRoomFromApi = async () => null;
  link.liveRoomFromPage = async () => ({ user: { status: 2 }, liveRoom: { status: 2 } });
  await show._stream(true);
  assert.equal(rec.noted[rec.noted.length - 1].verdict.reason, 'stream_unavailable');
  show.lastAnswer.clear();
  // not connected to TikTok at all
  link.conn = null;
  assert.equal(await show._stream(true), null);
  assert.equal(rec.noted[rec.noted.length - 1].tries[0].code, 'not_connected');
});

test('LIVE but not recording: the controller (status to the site) is told the reason; cleared when fine or the LIVE ends', async () => {
  const { ctl, rec, show, live } = setup();
  let popups = 0; show.on('recordingFailed', () => popups++);
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  assert.equal(ctl.issues.length, 0, 'recording fine: nothing to report');
  rec.failure = { reason: 'stream_restricted', text: 'x', detail: 'room info: status 4003110 (restricted)', since: 1 };
  rec.emit('state', rec.getState());
  assert.equal(ctl.issues[ctl.issues.length - 1].reason, 'stream_restricted');
  assert.match(ctl.issues[ctl.issues.length - 1].text, /4003110/);
  for (const reason of Object.keys(require('../src/core/show-manager').ISSUE_TEXT)) assert.match(reason, /^[a-z_]{1,40}$/, `status reason ${reason}`);
  rec.emit('state', rec.getState());
  assert.equal(ctl.issues.length, 1, 'the same issue is not re-sent');
  rec.emit('failure', rec.failure);
  assert.equal(popups, 1, 'one pop-up per failure');
  rec.failure = null; rec.emit('state', rec.getState());
  assert.equal(ctl.issues[ctl.issues.length - 1], null, 'video arrived: cleared');
  // not recording because the disk is full (the recorder refused to start) while LIVE
  await rec.stop();
  rec.error = 'disk_full'; rec.start = async () => null;
  ctl.emit('state', live());
  assert.equal(ctl.issues[ctl.issues.length - 1].reason, 'recording_disk_full');
  // the host stopped it on purpose: not a failure
  await show.stopByHost();
  ctl.emit('state', live());
  assert.equal(ctl.issues[ctl.issues.length - 1], null);
  // "Try again now" asks TikTok at once
  assert.equal(show.retryStream(), true);
  assert.equal(rec.retries, 1);
});

test('Recordings list: a recording with nothing of the LIVE on disk says "Recording failed" with the reason (2.0.6 shows too)', () => {
  const { show } = setup();
  const root = show.root();
  const mk = (name, s, files = {}) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify(s)); for (const [f, n] of Object.entries(files)) fs.writeFileSync(path.join(d, f), Buffer.alloc(n)); return d; };
  const t = 1_792_555_294_742;
  // the Oct 21 show exactly as 2.0.6 saved it: no stream, no runs, every review "not_recorded"
  mk('a-206', { v: 1, handle: 'shadowulf75', roomId: '7', startedAt: t, endedAt: t + 11155414, stream: null, runs: [], moments: [], clips: { p1: { status: 'not_recorded' }, p2: { status: 'not_recorded' } } }, { 'taps.json': 900 });
  mk('b-207', { v: 1, startedAt: t + 1, endedAt: t + 2, runs: [], diag: { failure: { reason: 'stream_restricted', detail: 'room info: status 4003110 (restricted)' } } });
  mk('c-zero', { v: 1, startedAt: t + 3, endedAt: t + 4, runs: [{ index: 0, error: 'Server returned 403 Forbidden' }] }, { 'part-0-000.mp4': 0 });
  mk('d-ok', { v: 1, startedAt: t + 5, endedAt: t + 6, runs: [{ index: 0 }] }, { 'part-0-000.mp4': 1000 });
  mk('e-joined', { v: 1, startedAt: t + 7, endedAt: t + 8, runs: [{ index: 0 }], joined: { files: [{ file: 'e - full show.mp4' }] } }, { 'e - full show.mp4': 2000 });
  const by = Object.fromEntries(show.listRecordings().map((x) => [x.name, x]));
  assert.equal(by['a-206'].failed.reason, 'stream_unavailable');
  assert.match(by['a-206'].failed.text, /never gave LIVE Link the video/);
  assert.equal(by['a-206'].recordedBytes, 0);
  assert.ok(by['a-206'].bytes > 0, 'the folder has files (taps.json) but none of the LIVE');
  assert.equal(by['b-207'].failed.reason, 'stream_restricted');
  assert.match(by['b-207'].failed.detail, /4003110/);
  assert.equal(by['c-zero'].failed.reason, 'recording_failed');
  assert.match(by['c-zero'].failed.detail, /403/);
  assert.equal(by['d-ok'].failed, null);
  assert.equal(by['d-ok'].recordedBytes, 1000);
  assert.equal(by['e-joined'].failed, null, 'joined into the full show: still recorded');
});
