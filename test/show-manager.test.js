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

test('clips off on the site: it still records, but nothing is queued for upload', async () => {
  const { ctl, rec, queued, timers, live, show } = setup({ clips: false });
  ctl.emit('state', live());
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.calls[0][0], 'start');
  await rec.stop();
  assert.equal(timers.length, 0);
  assert.equal(queued.length, 0);
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
