'use strict';
// 2.0.8: the video address asked for with the host's TikTok sign-in, the sign server's room info as a last resort, the
// verdicts that name the fix (sign in / subscribers only), and the back-up recording's switches and status.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ShowManager, ISSUE_TEXT, SIGNIN_REASONS } = require('../src/core/show-manager');
const { REASON_RE } = require('../src/core/controller');

const RESTRICTED = { data: { prompts: '' }, extra: { now: 1 }, status_code: 4003110 };
const sdkPull = (u) => ({ stream_data: JSON.stringify({ data: { origin: { main: { flv: `${u}.flv`, hls: `${u}.m3u8`, sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '720x1280' }) } } } }) });
const flv = (u) => ({ status_code: 0, data: { status: 2, stream_url: { flv_pull_url: { HD1: u } } } });

function setup({ signedIn = false, signIn = true, capture = true, captureEnabled = false } = {}) {
  const ctl = new EventEmitter(); ctl.clockOffset = 0; ctl.cfg = { clips: { enabled: true, delay_ms: 5000 } }; ctl.appVersion = '2.0.8';
  const link = new EventEmitter(); link.conn = { roomInfo: RESTRICTED, fetchRoomInfo: async () => RESTRICTED };
  link.liveRoomFromApi = async () => ({ data: { user: { roomId: '777', status: 2 }, liveRoom: { status: 2 } } });
  link.liveRoomFromPage = async () => { throw Object.assign(new Error("TikTok sent its bot check"), { code: 'waf' }); };
  link.liveRoomFromEuler = async () => ({ ok: true, code: 200, data: { room_info: { status: 2, is_live: true } } });
  const store = new Map(); if (captureEnabled !== null) store.set('captureEnabled', !!captureEnabled);
  const st = { get: (k) => store.get(k), set: (k, v) => (v === null || v === undefined ? store.delete(k) : store.set(k, v)) };
  let t = 1_000_000; const timers = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'll-show8-'));
  const auth = { asked: [], signedIn, roomInfo: async () => RESTRICTED, apiLive: async () => ({ data: { user: { roomId: '777', status: 2 }, liveRoom: { status: 2 } } }), livePage: async () => ({ user: { status: 2 }, liveRoom: { status: 2 } }) };
  const signInObj = signIn ? { signedIn: async () => auth.signedIn, roomInfo: (id) => { auth.asked.push(['room_auth', id]); return auth.roomInfo(); }, apiLive: (h) => { auth.asked.push(['api_auth', h]); return auth.apiLive(); }, livePage: (h) => { auth.asked.push(['page_auth', h]); return auth.livePage(); } } : null;
  const cap = capture ? { picks: 0, starts: 0, stops: 0, windows: [{ id: 'window:1', name: 'TikTok LIVE Studio', kind: 'window' }],
    sources: async () => cap.windows, pick: async (pref) => { cap.picks++; cap.pref = pref; return cap.windows[0] || null; },
    start: async () => { cap.starts++; return { file: 'capture-0.webm', mime: 'video/webm;codecs=h264,opus' }; }, stop: async () => { cap.stops++; } } : null;
  const logs = [];
  const show = new ShowManager({ ctl, link, api: {}, store: st, ffmpegPath: process.execPath, fontFile: null, defaultRoot: root, now: () => t, log: (l, m) => logs.push(`${l} ${m}`),
    setTimeout: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, clearTimeout: () => {}, clipDelayMs: 90000, signIn: signInObj, capture: cap, captureAudio: 'system' });
  clearInterval(show.nudgeTimer);
  // a fake recorder (what the real one is told)
  const rec = new EventEmitter(); rec.active = false; rec.dir = null; rec.calls = []; rec.noted = []; rec.flags = []; rec.failure = null; rec.error = null; rec.capture = null; rec.captureEnabled = false; rec.nows = 0;
  rec.start = async (o) => { rec.calls.push(['start', o.roomId]); rec.active = true; rec.dir = path.join(root, 'r1'); rec.stream = await o.getStream(true); return rec.dir; };
  rec.stop = async () => { rec.calls.push(['stop']); rec.active = false; rec.emit('finished', { dir: rec.dir }); return rec.dir; };
  rec.noteActivity = () => {}; rec.session = { moments: [] }; rec.markMoment = () => null;
  rec.getState = () => ({ recording: rec.active, failure: rec.failure, error: rec.error, capture: rec.capture });
  rec.noteStreamErrors = (tries, verdict) => rec.noted.push({ tries, verdict });
  rec.noteRoomFlags = (f, source) => rec.flags.push([source, f]);
  rec.retryNow = () => true; rec.captureNow = () => { rec.nows++; return true; }; rec.setCaptureEnabled = (on) => { rec.captureEnabled = on; };
  show.recorder = rec; show._wireRecorder(rec);
  ctl.issues = []; ctl.setRecordingIssue = (i) => ctl.issues.push(i);
  show.jobs.enqueue = () => {};
  const live = (extra = {}) => ({ phase: 'ready', connected: true, tiktok: { status: 'live', roomId: '777' }, tiktokUsername: 'host1', siteLive: true, target: null, paused: false, dryRun: false, ...extra });
  return { ctl, link, show, rec, auth, cap, store, logs, live, adv: (ms) => { t += ms; } };
}
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('not signed in: the signed-in sources are never asked; room info 4003110 while LIVE = tiktok_signin_needed (the fix is named), the sign server is asked last', async () => {
  const { show, rec, auth, ctl, live } = setup();
  ctl.emit('state', live()); await settle();
  assert.equal(rec.stream, null);
  assert.deepEqual(auth.asked, []);
  const n = rec.noted[rec.noted.length - 1];
  assert.deepEqual(n.tries.map((x) => x.source), ['room info', 'api-live', 'LIVE page', 'kept room info', 'sign server']);
  assert.equal(n.verdict.reason, 'tiktok_signin_needed');
  assert.match(n.verdict.detail, /sign server: no video links/);
  assert.equal(n.tries[0].status, 4003110, 'TikTok\'s own code goes to session.json');
  assert.ok(rec.flags.some(([s]) => s === 'sign server') && rec.flags.some(([s]) => s === 'api-live'), 'the room flags are kept per source');
  assert.equal(show.getState().signedIn, false);
  for (const r of ['tiktok_signin_needed', 'stream_sub_only', 'recording_window_capture', 'capture_no_window', 'capture_failed']) { assert.match(r, REASON_RE); assert.ok(ISSUE_TEXT[r], r); }
  assert.ok(SIGNIN_REASONS.has('tiktok_signin_needed') && SIGNIN_REASONS.has('stream_restricted') && SIGNIN_REASONS.has('stream_blocked'));
});

test('signed in: the three places are asked as the signed-in viewer FIRST; a link from them wins; still 4003110 = stream_restricted (not "sign in")', async () => {
  const { show, rec, auth, link, ctl, live, adv } = setup({ signedIn: true });
  auth.roomInfo = async () => flv('https://pull.example/signed.flv');
  ctl.emit('state', live()); await settle();
  assert.equal(rec.stream.url, 'https://pull.example/signed.flv');
  assert.equal(rec.stream.from, 'room info (signed in)');
  assert.deepEqual(auth.asked.map((a) => a[0]), ['room_auth']);
  assert.deepEqual(auth.asked[0][1], '777', 'asked for this LIVE\'s room');
  assert.equal(show.getState().signedIn, true);
  // the signed-in viewer is refused too: restricted for real
  auth.roomInfo = async () => RESTRICTED;
  auth.asked.length = 0;
  adv(31000);
  assert.equal(await show._stream(true), null);
  assert.deepEqual(auth.asked.map((a) => a[0]), ['room_auth', 'api_auth', 'page_auth']);
  const n = rec.noted[rec.noted.length - 1];
  assert.equal(n.verdict.reason, 'stream_restricted');
  assert.deepEqual(n.tries.map((x) => x.source).slice(0, 3), ['room info (signed in)', 'api-live (signed in)', 'LIVE page (signed in)']);
  // the signed-in LIVE page lists the links while everything signed out is refused: recorded from there
  auth.livePage = async () => ({ user: { status: 2 }, liveRoom: { status: 2, streamData: { pull_data: sdkPull('https://pull.example/page-auth') } } });
  adv(31000);
  const s = await show._stream(true);
  assert.equal(s.url, 'https://pull.example/page-auth.flv');
  assert.equal(s.from, 'LIVE page (signed in)');
  // signing out: the signed-in sources stop (refreshed before every ask)
  auth.signedIn = false;
  auth.asked.length = 0;
  adv(31000);
  await show._stream(true);
  assert.deepEqual(auth.asked, []);
  assert.equal(rec.noted[rec.noted.length - 1].verdict.reason, 'tiktok_signin_needed');
  assert.equal(link.conn.roomInfo, RESTRICTED);
});

test('subscribers-only / paid LIVE = stream_sub_only; the sign server\'s links are used when this network gets nothing; a sign-server "no" never counts as "blocked"', async () => {
  const { show, rec, link, adv } = setup();
  show.liveNow = true;
  link.liveRoomFromApi = async () => ({ data: { user: { roomId: '777', status: 2 }, liveRoom: { status: 2, liveSubOnly: 1 } } });
  assert.equal(await show._stream(true), null);
  assert.equal(rec.noted[rec.noted.length - 1].verdict.reason, 'stream_sub_only');
  assert.match(rec.noted[rec.noted.length - 1].verdict.detail, /api-live: subscribers only/);
  // every request from this network refused; the sign server (its own network) has the links
  const httpErr = (code) => Object.assign(new Error(`Response code ${code}`), { code: 'ERR_NON_2XX_3XX_RESPONSE', response: { statusCode: code } });
  link.conn = { roomInfo: null, fetchRoomInfo: async () => { throw httpErr(403); } };
  link.liveRoomFromApi = async () => { throw httpErr(429); };
  link.liveRoomFromEuler = async () => ({ ok: true, code: 200, data: { room_info: { status: 2, is_live: true, flv_pull_url: 'https://pull.example/euler.flv' } } });
  show.cooldown.clear(); show.lastAnswer.clear();
  adv(61000);
  const s = await show._stream(true);
  assert.equal(s.url, 'https://pull.example/euler.flv');
  assert.equal(s.from, 'sign server');
  // the sign server says no while this network is refused: still "blocked" (the sign server's no says nothing about this network)
  link.liveRoomFromEuler = async () => { throw Object.assign(new Error('[euler] not live'), { code: 'euler', statusCode: 404 }); };
  show.cooldown.clear(); show.lastAnswer.clear();
  adv(61000);
  assert.equal(await show._stream(true), null);
  const n = rec.noted[rec.noted.length - 1];
  assert.equal(n.verdict.reason, 'stream_blocked');
  assert.deepEqual(n.tries.find((t) => t.source === 'sign server').code, 'euler');
  assert.doesNotMatch(n.tries.find((t) => t.source === 'sign server').code, /http_/, 'the sign server\'s code is not an HTTP status');
  // at most once a minute
  show.cooldown.clear();
  let eulerAsks = 0;
  link.liveRoomFromEuler = async () => { eulerAsks++; throw Object.assign(new Error('[euler] no'), { code: 'euler' }); };
  adv(5000); await show._stream(true);
  adv(5000); await show._stream(true);
  assert.equal(eulerAsks, 0, 'the sign server\'s last answer still counts within a minute');
  adv(61000); await show._stream(true);
  assert.equal(eulerAsks, 1);
});

test('the back-up recording: ON for a host who never touched the setting, off when switched off', async () => {
  const fresh = setup({ captureEnabled: null });
  assert.equal(fresh.store.has('captureEnabled'), false);
  assert.equal(fresh.show.getState().captureEnabled, true, 'on by default');
  fresh.show.setCaptureEnabled(false);
  assert.equal(fresh.store.get('captureEnabled'), false, 'switching it off is remembered');
  assert.equal(fresh.show.getState().captureEnabled, false);
  fresh.show.setCaptureEnabled(true);
  assert.equal(fresh.show.getState().captureEnabled, true);
});

test('the back-up recording: off when the host switched it off, kept in the settings, handed to the recorder; "Record my stream window instead" switches it on and starts it; the window the host chose is what gets picked', async () => {
  const { show, rec, cap, store, ctl, live } = setup();
  assert.equal(show.getState().captureAvailable, true);
  assert.equal(show.getState().captureEnabled, false);
  assert.deepEqual((await show.captureSources()).map((s) => s.name), ['TikTok LIVE Studio']);
  assert.equal(show.setCaptureEnabled(true), true);
  assert.equal(store.get('captureEnabled'), true);
  assert.equal(rec.captureEnabled, true);
  assert.equal(show.setCaptureSource('OBS 31 - Profile: x'), 'OBS 31 - Profile: x');
  assert.equal(show.getState().captureSource, 'OBS 31 - Profile: x');
  await show.recorder.capture;   // (the real recorder gets a wrapper; here the fake recorder has none)
  assert.equal(show.setCaptureSource(''), null);
  show.setCaptureEnabled(false);
  assert.equal(store.get('captureEnabled'), false);
  assert.deepEqual(show.captureNow(), { ok: false, error: 'not_recording' });
  ctl.emit('state', live()); await settle();
  assert.deepEqual(show.captureNow(), { ok: true });
  assert.equal(rec.nows, 1);
  assert.equal(show.getState().captureEnabled, true, 'one click switches it on for good (Settings shows it)');
  // the real recorder's capture wrapper resolves the host's choice at pick time
  const { Recorder } = require('../src/core/recorder');
  const real = new ShowManager({ ctl: Object.assign(new EventEmitter(), { clockOffset: 0, cfg: {} }), link: new EventEmitter(), api: {}, store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, ffmpegPath: process.execPath, fontFile: null, defaultRoot: show.root(), capture: cap });
  clearInterval(real.nudgeTimer);
  assert.ok(real.recorder instanceof Recorder && real.recorder.capture);
  store.set('captureSource', 'TikTok LIVE Studio');
  assert.equal((await real.recorder.capture.pick()).name, 'TikTok LIVE Studio');
  assert.equal(cap.pref, 'TikTok LIVE Studio');
  assert.equal(real.recorder.captureEnabled, true);
});

test('while the back-up records, the site is told (reason recording_window_capture, level info, not a failure); a failure still wins; cleared when the LIVE ends', async () => {
  const { show, rec, ctl, live } = setup();
  ctl.emit('state', live()); await settle();
  assert.equal(ctl.issues.length, 0);
  rec.capture = { source: 'TikTok LIVE Studio', since: 1, bytes: 10 };
  rec.emit('state', rec.getState());
  const i = ctl.issues[ctl.issues.length - 1];
  assert.deepEqual([i.reason, i.level, i.detail], ['recording_window_capture', 'info', 'window: TikTok LIVE Studio']);
  assert.equal(i.text, ISSUE_TEXT.recording_window_capture);
  rec.emit('state', rec.getState());
  assert.equal(ctl.issues.length, 1, 'told once');
  rec.failure = { reason: 'capture_failed', text: 'x', detail: 'not writing', since: 2 };
  rec.emit('state', rec.getState());
  assert.deepEqual([ctl.issues[ctl.issues.length - 1].reason, ctl.issues[ctl.issues.length - 1].level], ['capture_failed', 'problem']);
  rec.failure = null; rec.capture = null;
  rec.emit('state', rec.getState());
  assert.equal(ctl.issues[ctl.issues.length - 1], null);
  // the recording issue of "no window" names the fix the host can act on
  rec.failure = { reason: 'capture_no_window', text: 'x', detail: 'no stream window found', since: 3 };
  rec.emit('state', rec.getState());
  assert.equal(ctl.issues[ctl.issues.length - 1].text, ISSUE_TEXT.capture_no_window);
  ctl.emit('state', { ...live(), connected: false, tiktok: { status: 'offline', roomId: null } }); await settle();
  assert.equal(ctl.issues[ctl.issues.length - 1], null, 'the LIVE ended: nothing to report');
});

test('without a sign-in helper or a screen recorder (older main, tests): everything still works the 2.0.7 way', async () => {
  const { show, rec, ctl, live } = setup({ signIn: false, capture: false });
  ctl.emit('state', live()); await settle();
  assert.equal(rec.noted[rec.noted.length - 1].verdict.reason, 'stream_restricted', 'no sign-in to offer: the plain reason');
  assert.deepEqual(show.captureNow(), { ok: false, error: 'unavailable' });
  assert.deepEqual(await show.captureSources(), []);
  assert.equal(show.setCaptureEnabled(true), false, 'can\'t be on without a screen recorder');
  assert.equal(show.getState().signInAvailable, false);
});
