'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core/clipper');
const { pickStream } = require('../src/core/stream-url');
const { LikeBatcher } = require('../src/core/batcher');
const { recordArgs, safeName } = require('../src/core/recorder');

const run = (samples, parts) => ({ index: 0, startedAt: samples[0][1] - samples[0][0], samples, parts });

test('media and server time map both ways, straight between samples', () => {
  const r = run([[0, 100000], [60000, 160500], [120000, 220500]], []);
  assert.equal(C.mediaToWall(r, 30000), 100000 + 30250);
  assert.equal(C.wallToMedia(r, 130250), 30000);
  assert.equal(C.mediaToWall(r, 150000), 250500);          // past the last sample: slope 1
  assert.equal(C.wallToMedia(r, 50000), -50000);           // before the first: slope 1
});

test('a server-time range becomes cuts inside the right pieces, across a piece boundary', () => {
  const r = run([[0, 1000000]], [{ file: 'part-0-000.mp4', start: 0, end: 600 }, { file: 'part-0-001.mp4', start: 600, end: 1200 }]);
  const tl = C.timeline({ runs: [r] });
  const cuts = C.cutsFor(tl, 1000000 + 590000, 1000000 + 610000);
  assert.deepEqual(cuts, [{ file: 'part-0-000.mp4', inSec: 590, outSec: 600 }, { file: 'part-0-001.mp4', inSec: 0, outSec: 10 }]);
  assert.equal(C.coveredMs(cuts), 20000);
  assert.deepEqual(C.cutsFor(tl, 0, 1000), []);             // before the recording
});

test('a gap between two runs (stream dropped) is simply not covered', () => {
  const r0 = { index: 0, startedAt: 0, samples: [[0, 0]], parts: [{ file: 'part-0-000.mp4', start: 0, end: 100 }] };
  const r1 = { index: 1, startedAt: 130000, samples: [[0, 130000]], parts: [{ file: 'part-1-000.mp4', start: 0, end: 100 }] };
  const cuts = C.cutsFor(C.timeline({ runs: [r0, r1] }), 90000, 140000);
  assert.deepEqual(cuts, [{ file: 'part-0-000.mp4', inSec: 90, outSec: 100 }, { file: 'part-1-000.mp4', inSec: 0, outSec: 10 }]);
  assert.equal(C.coveredMs(cuts), 20000);
});

test('the recipe: hottest 20 s + last 60 s, shifted by the stream delay, taps not shifted', () => {
  const start = 1_000_000_000_000;
  const taps = {};
  for (let s = 0; s < 8; s++) taps[Math.floor(start / 1000) + 100 + s] = 50;   // a burst 100-107 s after the song started
  const p = C.planReview({ startedAt: start, endedAt: start + 300000 }, taps, start + 900000, { delayMs: 8000, padStartMs: 4000, padEndMs: 8000 });
  assert.deepEqual(p.full, { from: start + 4000, to: start + 316000 });
  assert.deepEqual(p.verdict, { from: start + 256000, to: start + 316000 });
  assert.ok(p.hot.from <= start + 100000 && p.hot.to >= start + 108000, 'the hot window covers the burst');
  assert.equal(p.hot.to - p.hot.from, 20000);
  assert.equal(p.hotWeight, 400);
});

test('no taps: the hot window sits ~35% into the song; a short review is one piece', () => {
  const start = 2_000_000_000_000;
  const p = C.planReview({ startedAt: start, endedAt: start + 300000 }, {}, start + 900000, {});
  assert.equal(p.hotWeight, 0);
  assert.ok(p.hot.from > p.full.from + 60000 && p.hot.to < p.verdict.from);
  const short = C.planReview({ startedAt: start, endedAt: start + 60000 }, {}, start + 900000, {});
  assert.equal(short.hot, null);
  assert.deepEqual(short.verdict, short.full);
  // still on air when the LIVE ended: ends at the session end
  const open = C.planReview({ startedAt: start, endedAt: null }, {}, start + 200000, {});
  assert.equal(open.full.to, start + 200000 + 8000 + 8000);
});

test('stream picker: source quality first, H.264 preferred, old fields as fallback', () => {
  const sdk = { data: {
    origin: { main: { flv: 'https://pull.example/origin.flv', sdk_params: JSON.stringify({ VCodec: 'h265', resolution: '1080x1920' }) } },
    hd: { main: { flv: 'https://pull.example/hd.flv', sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '720x1280' }) } },
  } };
  const s = pickStream({ data: { stream_url: { live_core_sdk_data: { pull_data: { stream_data: JSON.stringify(sdk) } } } } });
  assert.equal(s.url, 'https://pull.example/hd.flv');
  assert.equal(s.width, 720); assert.equal(s.height, 1280); assert.equal(s.codec, 'h264');
  const old = pickStream({ data: { stream_url: { flv_pull_url: { SD1: 'https://pull.example/sd.flv', HD1: 'https://pull.example/hd1.flv' } } } });
  assert.equal(old.url, 'https://pull.example/hd1.flv');
  assert.equal(pickStream({ data: { stream_url: { flv_pull_url: { HD1: 'javascript:alert(1)' } } } }), null);
  assert.equal(pickStream(null), null);
});

test('tappers: grouped per handle, most taps first, at most 20, cleared after each push', () => {
  const b = new LikeBatcher('room');
  const at = Date.now();
  b.add({ count: 5, total: 100, at, handle: 'nova', name: 'Nova' });
  b.add({ count: 3, total: 103, at, handle: 'rico', name: null });
  b.add({ count: 9, total: 112, at, handle: 'nova', name: 'Nova' });
  b.add({ count: 2, total: 114, at });   // no handle: counted for the bar, not named
  for (let i = 0; i < 30; i++) b.add({ count: 1, total: 115 + i, at, handle: `fan${i}` });
  const t = b.take(at + 100).tappers;
  assert.equal(t.length, 20);
  assert.deepEqual(t[0], { handle: 'nova', name: 'Nova', count: 14 });
  assert.deepEqual(t[1], { handle: 'rico', name: 'rico', count: 3 });
  assert.deepEqual(b.take(at + 200).tappers, []);
});

test('recording arguments: a straight copy into pieces + a keyframe-only preview, safe folder names', () => {
  const a = recordArgs('https://pull.example/x.flv', 2, { segmentSec: 600 });
  assert.ok(a.includes('-c') && a[a.indexOf('-c') + 1] === 'copy');
  assert.ok(a.includes('part-2-%03d.mp4') && a.includes('parts-2.csv') && a.includes('preview.jpg'));
  assert.ok(a.indexOf('-skip_frame') < a.indexOf('-i'));
  assert.ok(a.includes('-reconnect'));
  assert.equal(safeName('my:name/is*bad?'), 'mynameisbad');
});

test('probe parsing reads duration, codec, size and audio', () => {
  const p = C.parseProbe('  Duration: 00:01:02.34, start: 0\n  Stream #0:0: Video: h264 (High), yuv420p, 720x1280, 30 fps\n  Stream #0:1: Audio: aac');
  assert.deepEqual(p, { duration: 62.34, codec: 'h264', width: 720, height: 1280, hasAudio: true });
});

test('stream picker also reads the LIVE page and api-live shapes (streamData.pull_data)', () => {
  const pull = { stream_data: JSON.stringify({ data: { origin: { main: { flv: 'https://pull.example/page.flv', sdk_params: JSON.stringify({ VCodec: 'h264', resolution: '720x1280' }) } } } }) };
  const page = pickStream({ liveRoom: { streamData: { pull_data: pull } } });             // fetchRoomInfoFromHtmlRoute result
  assert.equal(page.url, 'https://pull.example/page.flv');
  const apiLive = pickStream({ data: { liveRoom: { streamData: { pull_data: pull } } } });   // api-live answer
  assert.equal(apiLive.url, 'https://pull.example/page.flv');
  assert.equal(pickStream({ liveRoomUserInfo: { liveRoom: { streamData: { pull_data: pull } } } }).height, 1280);
});

test('clip words: fitted to the frame, no "with ReactivVibeAI" under the brand, a host line for other hosts', () => {
  const size = C.targetSize(720, 1280);
  const own = C.brandTexts(size, { artist: 'Milton Price', title: 'Pay Me Now', host: 'ReactivVibeAI' });
  assert.equal(own['artist.txt'], 'MILTON PRICE');
  assert.equal(own['song.txt'], '“Pay Me Now”');
  assert.equal(own['end-host.txt'], '');
  const other = C.brandTexts(size, { artist: 'A', title: 'B', host: 'Bone Daddy' });
  assert.equal(other['song.txt'], '“B” · with Bone Daddy');
  assert.equal(other['end-host.txt'], 'with Bone Daddy');
  const long = C.brandTexts(size, { artist: 'X'.repeat(80), title: 'Y'.repeat(120), host: null });
  const L = C.brandLayout(size);
  assert.ok(long['artist.txt'].endsWith('…') && long['artist.txt'].length * L.artist * 0.62 <= L.W - 2 * L.pad + L.artist);
  const none = C.brandTexts(size, { artist: null, title: null, host: null });
  for (const v of Object.values(none)) assert.ok(!/null|undefined/.test(v));
  assert.equal(none['end-song.txt'], '');
});

test('title band: sits in an existing top black bar, else tall enough to cover a stream logo', () => {
  const size = C.targetSize(720, 1280);
  assert.equal(C.topBarFrom('x crop=548:894:10:218\n crop=548:896:10:216', { width: 720, height: 1280 }, size), 216);
  assert.equal(C.topBarFrom('crop=718:1200:2:80', { width: 720, height: 1280 }, size), null, 'a thin dark strip is not a bar');
  assert.equal(C.topBarFrom('crop=1076:1520:2:200', { width: 1080, height: 1920 }, size), 133, 'scaled to the 720x1280 frame');
  assert.equal(C.topBarFrom('crop=1280:600:0:120', { width: 1280, height: 720 }, size), null, 'a landscape source is not measured against a portrait frame');
  assert.equal(C.brandLayout({ ...size, topBar: 216 }).bandH, 216);
  assert.equal(C.brandLayout({ ...size, topBar: 500 }).bandH, 256, 'capped at 20%');
  assert.equal(C.brandLayout(size).bandH, 288);
});

test('the short phone cut: middle of the hottest moment + the last seconds of the verdict, ~25 s', () => {
  const p = C.socialPlan({ hotDur: 20, verdictDur: 60, hasHot: true }, C.DEFAULTS);
  assert.deepEqual(p, { hotSeek: 4, hotLen: 12, verdictSeek: 48, verdictLen: 12 });
  const short = C.socialPlan({ hotDur: 0, verdictDur: 40, hasHot: false }, C.DEFAULTS);
  assert.deepEqual(short, { hotSeek: null, hotLen: 0, verdictSeek: 16, verdictLen: 24 });
  const tiny = C.socialPlan({ hotDur: 8, verdictDur: 10, hasHot: true }, C.DEFAULTS);
  assert.equal(tiny.hotLen, 8); assert.equal(tiny.verdictSeek, 0);
  const a = C.highlightArgs({ hotFile: 'hot.mp4', verdictFile: 'verdict.mp4', outFile: 'v.mp4', size: C.targetSize(720, 1280), font: 'font.ttf', hotDur: 12, verdictDur: 12, hotSeek: 4, verdictSeek: 48, texts: {}, introSec: 3.5, endSec: 1.8 });
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 5), ['-ss', '4.000', '-t', '12.000', '-i']);
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('tpad=stop_mode=clone:stop_duration=1.8') && fc.includes("enable='gte(t,23.500)'") && fc.includes('apad=pad_dur=1.8'));
});
