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
  rec.getState = () => ({ recording: rec.active });
  show.recorder = rec;
  rec.on('finished', ({ dir }) => show._recordingFinished(dir));   // what the constructor wires on the real one
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
