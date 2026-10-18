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

test('"Clip that" marks: 35 s before + 10 s after the press, shifted by the delay; close presses merge, capped at 90 s', () => {
  const t = 1_000_000_000_000, o = { delayMs: 8000 };
  const one = C.planMoments([{ at: t }], o);
  assert.deepEqual(one.map(({ from, to, marks, index }) => ({ from, to, marks, index })), [{ from: t - 27000, to: t + 18000, marks: 1, index: 0 }]);
  const merged = C.planMoments([{ at: t + 5000 }, { at: t }], o);
  assert.equal(merged.length, 1); assert.equal(merged[0].marks, 2); assert.equal(merged[0].to, t + 23000);
  assert.equal(C.planMoments([{ at: t }, { at: t + 60000 }], o).length, 2, 'a minute apart: two clips');
  const chain = C.planMoments([0, 20, 40, 60, 80].map((s) => ({ at: t + s * 1000 })), o);
  assert.ok(chain.length >= 2 && chain.every((m) => m.to - m.from <= 90000), 'a long chain splits at 90 s');
  assert.deepEqual(C.planMoments([{ at: 'x' }, null], o), []);
  const words = C.momentTexts(C.targetSize(720, 1280), { handle: 'reactivvibeai', at: t });
  assert.equal(words['kicker.txt'], 'CLIPPED LIVE · ReactivVibeAI');
  assert.equal(words['artist.txt'], '@reactivvibeai');
  assert.match(words['song.txt'], /^Live · [A-Z][a-z]{2} \d+$/);
  assert.equal(words['end-label.txt'], 'CLIPPED LIVE ON');
  for (const v of Object.values(C.momentTexts(C.targetSize(720, 1280), { handle: null, at: null }))) assert.ok(!/null|undefined|NaN/.test(v));
});

test('full show: pieces map into the joined file, cuts cross a piece boundary as one cut', () => {
  const run = { index: 0, startedAt: 1000000, samples: [[0, 1000000]] };
  const session = { runs: [run], joined: { files: [{ file: 'x - full show.mp4', parts: [{ run: 0, start: 0, end: 600, offset: 0 }, { run: 0, start: 600, end: 1200, offset: 600 }] }] } };
  run.parts = C.joinedPartsFor(session, 0);
  assert.equal(run.parts.length, 2);
  const cuts = C.cutsFor(C.timeline(session), 1000000 + 590000, 1000000 + 610000);
  assert.deepEqual(cuts, [{ file: 'x - full show.mp4', inSec: 590, outSec: 610 }]);
  assert.equal(C.joinedPartsFor({ runs: [] }, 0), null);
});

test('full show plan: runs with the same picture join into one file with running offsets; a new picture size starts part 2', () => {
  const s = { runs: [
    { index: 0, parts: [{ file: 'part-0-000.mp4', start: 0, end: 600 }, { file: 'part-0-001.mp4', start: 600, end: 900 }] },
    { index: 1, parts: [{ file: 'part-1-000.mp4', start: 0, end: 300 }] },
  ] };
  const same = C.fullShowPlan(s, { 'part-0-000.mp4': { codec: 'h264', width: 720, height: 1280 }, 'part-1-000.mp4': { codec: 'h264', width: 720, height: 1280 } }, 'Show');
  assert.equal(same.length, 1);
  assert.equal(same[0].file, 'Show - full show.mp4');
  assert.equal(same[0].duration, 1200);
  assert.deepEqual(same[0].parts.map((p) => [p.source, p.run, p.offset]), [['part-0-000.mp4', 0, 0], ['part-0-001.mp4', 0, 600], ['part-1-000.mp4', 1, 900]]);
  const diff = C.fullShowPlan(s, { 'part-0-000.mp4': { codec: 'h264', width: 720, height: 1280 }, 'part-1-000.mp4': { codec: 'h264', width: 1280, height: 720 } }, 'Show');
  assert.deepEqual(diff.map((f) => f.file), ['Show - full show (part 1).mp4', 'Show - full show (part 2).mp4']);
  assert.equal(diff[1].parts[0].offset, 0);
  const a = C.joinArgs('.join.txt', 'out.mp4');
  assert.ok(a.includes('copy') && a.includes('+faststart') && a.includes('concat'));
});
