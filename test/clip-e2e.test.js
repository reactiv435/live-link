'use strict';
// End to end with the real ffmpeg (~2 minutes): a synthetic 9:16 "LIVE" (FLV, like TikTok's) is recorded by the
// Recorder at stream speed while taps are noted, then ClipJobs cuts one review and uploads it to a local server.
// Run: RUN_E2E=1 FFMPEG=<full path to ffmpeg> [E2E_TMP=<work dir>] node --test test/clip-e2e.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { Recorder } = require('../src/core/recorder');
const { ClipJobs } = require('../src/core/clip-jobs');
const C = require('../src/core/clipper');

const FF = process.env.FFMPEG;
const RUN = process.env.RUN_E2E === '1' && FF && fs.existsSync(FF);
const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'ChakraPetch-Bold.ttf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (file) => C.parseProbe(String(spawnSync(FF, ['-hide_banner', '-i', file]).stderr));

test('records a LIVE and turns one review into a full review, a branded highlight and a poster', { skip: !RUN, timeout: 300000 }, async () => {
  const root = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'll-e2e-'));
  const src = path.join(root, 'stream.flv');
  const gen = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '75', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-f', 'flv', src]);
  assert.equal(gen.status, 0, String(gen.stderr));

  const logs = [];
  const rec = new Recorder({ ffmpegPath: FF, realtime: true, segmentSec: 20, log: (l, m) => logs.push(`${l} ${m}`) });
  let calls = 0;
  const dir = await rec.start({ root: path.join(root, 'rec'), handle: 'tester', roomId: '7', getStream: async () => (calls++ === 0 ? { url: src, kind: 'flv', quality: 'origin', codec: 'h264', width: 720, height: 1280 } : null) });
  assert.ok(dir, `recording did not start: ${JSON.stringify(rec.getState())}`);
  const t0 = Date.now();
  // A tap burst ~24-31 s into the stream: the highlight's hottest moment should land there.
  const burst = setInterval(() => { const s = (Date.now() - t0) / 1000; if (s > 24 && s < 31) rec.noteActivity(40, Date.now()); else if (s > 3) rec.noteActivity(1, Date.now()); }, 250);
  // The host presses "Clip that" ~50 s in: the moment clip should cover ~15-60 s of the stream.
  const mark = setTimeout(() => rec.markMoment(Date.now(), 'hotkey'), 50000);
  // Wait for the 75 s stream to end (ffmpeg exits at the end of the file), then stop cleanly.
  for (let i = 0; i < 120; i++) { await sleep(1000); const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); if (s.runs[0] && s.runs[0].endedAt) break; }
  clearInterval(burst); clearTimeout(mark);
  // 2.0.7: the size shown while recording is read from the disk (ffmpeg reports total_size=N/A for pieces)
  assert.ok(rec.getState().bytes > 100000, `recorded size ${rec.getState().bytes}`);
  assert.equal(rec.getState().failure, null, 'a working recording never shows "Not recording"');
  await rec.stop();

  const session = C.readSession(dir);
  const run = session.runs[0];
  assert.ok(run.samples.length >= 2, 'time samples recorded');
  assert.ok(run.parts.length >= 3, `expected 20 s pieces, got ${run.parts.length}`);
  assert.ok(fs.existsSync(path.join(dir, 'preview.jpg')), 'preview picture written');
  const taps = JSON.parse(fs.readFileSync(path.join(dir, 'taps.json'), 'utf8'));
  assert.ok(Object.keys(taps).length > 10, 'taps saved per second');

  // The review: song on air at media 5 s, host moves on at media 70 s (as server times).
  const startedAt = C.mediaToWall(run, 5000), endedAt = C.mediaToWall(run, 70000);
  const got = {};
  const upDir = path.join(root, 'uploads'); fs.mkdirSync(upDir);
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', () => { const b = Buffer.concat(chunks); got[req.url] = b.length; fs.writeFileSync(path.join(upDir, path.basename(req.url) + (req.url.endsWith('poster') ? '.jpg' : '.mp4')), b); res.writeHead(200); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const completes = [];
  const api = {
    reviews: async () => ({ reviews: [{ play_id: 'play-1', started_at: new Date(startedAt).toISOString(), ended_at: new Date(endedAt).toISOString(), title: 'Midnight Signal', artist: 'Sample Artist', host_name: 'ReactivVibeAI' }] }),
    clipUpload: async (m) => ({ upload_url: `http://127.0.0.1:${port}/up/${m.kind}`, path: `host/play-1/${m.kind}` }),
    clipComplete: async (b) => { completes.push(b); return { ok: true }; },
  };
  const jobs = new ClipJobs({ api, ffmpegPath: FF, fontFile: FONT, log: (l, m) => logs.push(`${l} ${m}`), getOptions: () => ({ delayMs: 0, padStartMs: 1000, padEndMs: 1000, hotSec: 8, verdictSec: 20 }) });
  const result = await jobs.processSession(dir);
  assert.equal(result.sent, 1, `clip not sent: ${JSON.stringify(result)}\n${logs.join('\n')}`);
  assert.ok(got['/up/highlight'] > 50000 && got['/up/full'] > 50000 && got['/up/poster'] > 2000, `uploads: ${JSON.stringify(got)}`);
  assert.ok(got['/up/vertical'] > 20000, 'the short phone cut is uploaded too');
  // the artist is told after the FIRST "ready" (highlight + poster); the full review follows in a second one
  assert.equal(completes.length, 2);
  assert.deepEqual(completes[0].files.map((f) => f.kind), ['highlight', 'poster', 'vertical']);
  assert.deepEqual(completes[1].files.map((f) => f.kind), ['full']);

  const job = path.join(dir, 'clips', 'play-1');
  const hl = probe(path.join(job, 'highlight.mp4'));
  assert.equal(hl.codec, 'h264');
  assert.equal(hl.width, 720); assert.equal(hl.height, 1280);
  // 8 s hot + 20 s verdict (+ keyframe slack) - 0.5 s crossfade + 2.4 s end card
  assert.ok(hl.duration > 27 && hl.duration < 38, `highlight duration ${hl.duration}`);
  const full = probe(path.join(upDir, 'full.mp4'));
  assert.ok(full.duration > 62 && full.duration < 72, `full review duration ${full.duration}`);
  assert.ok(!fs.existsSync(path.join(job, 'full.mp4')), 'the local copy of the full review is removed once sent');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).clipsDoneAt, 'the recording is marked done');
  const hotIso = completes[0].recipe.hot.from;
  const hotFrom = Date.parse(hotIso);
  const burstWall = C.mediaToWall(run, 24000);
  assert.ok(Math.abs(hotFrom - burstWall) < 8000, `hottest moment ${((hotFrom - burstWall) / 1000).toFixed(1)} s from the burst`);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).clips['play-1'];
  assert.equal(st.status, 'sent');

  // "Clip that": the marked moment becomes a ~45 s phone clip in moments/ (kept on this computer).
  const mo = await jobs.processMoments(dir);
  assert.deepEqual(mo, { made: 1, failed: 0, total: 1 });
  const made = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).momentClips;
  const momentFile = path.join(dir, 'moments', Object.values(made)[0]);
  const mp = probe(momentFile);
  assert.equal(mp.width, 720); assert.equal(mp.height, 1280);
  assert.ok(mp.duration > 40 && mp.duration < 52, `moment clip duration ${mp.duration}`);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'moments')).filter((f) => f.startsWith('.work')), [], 'work files cleaned up');
  assert.deepEqual(await jobs.processMoments(dir), { made: 0, failed: 0, total: 1 }, 'a second run makes nothing new');

  // The full show: the 20 s pieces become one file, the pieces go, and clips can still be made from the joined file.
  const pieceTotal = run.parts.reduce((n, p) => n + (p.end - p.start), 0);
  const joinedRes = await jobs.processFullShow(dir);
  assert.equal(joinedRes.ok, true, JSON.stringify(joinedRes));
  const jp = probe(path.join(dir, joinedRes.files[0]));
  assert.ok(Math.abs(jp.duration - pieceTotal) < 3, `full show ${jp.duration} s vs pieces ${pieceTotal} s`);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /^part-\d+-\d+\.mp4$/.test(f)), [], 'the pieces are removed');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).joined, 'the pieces are mapped into the full show');
  assert.equal((await jobs.processFullShow(dir)).skipped, true, 'joined once');
  jobs._markSession(dir, { clips: {}, clipsDoneAt: null });
  completes.length = 0;
  const again = await jobs.processSession(dir);
  assert.equal(again.sent, 1, `remade from the full show: ${JSON.stringify(again)}`);
  assert.equal(completes[0].recipe.hot.from, hotIso, 'same hottest moment from the joined file');
  const hl2 = probe(path.join(job, 'highlight.mp4'));
  assert.ok(hl2.duration > 27 && hl2.duration < 38, `remade highlight ${hl2.duration}`);
  server.close();

  assert.equal(C.readSession(dir).diag.result, 'ok');

  // Stills for a human look: the title strip and the end card.
  if (process.env.E2E_OUT) {
    fs.mkdirSync(process.env.E2E_OUT, { recursive: true });
    spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.5', '-i', path.join(job, 'highlight.mp4'), '-frames:v', '1', path.join(process.env.E2E_OUT, 'hl-title.png')]);
    spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-1.2', '-i', path.join(job, 'highlight.mp4'), '-frames:v', '1', path.join(process.env.E2E_OUT, 'hl-end.png')]);
    fs.copyFileSync(path.join(job, 'poster.jpg'), path.join(process.env.E2E_OUT, 'poster.jpg'));
    spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.5', '-i', momentFile, '-frames:v', '1', path.join(process.env.E2E_OUT, 'moment-title.png')]);
  }
});

test('a video address that gives nothing: real ffmpeg writes 0 bytes, the run is marked failed and "Not recording" follows', { skip: !RUN, timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'll-e2e-fail-'));
  // a local server that answers every request with 403, like an expired TikTok CDN link
  const server = http.createServer((req, res) => { res.writeHead(403); res.end('Forbidden'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/stage/stream-123_or4.flv?expire=1&sign=SECRET`;
  const logs = [];
  const rec = new Recorder({ ffmpegPath: FF, failAfterMs: 4000, healthEveryMs: 500, log: (l, m) => logs.push(`${l} ${m}`) });
  const failures = [];
  rec.on('failure', (f) => failures.push(f));
  const dir = await rec.start({ root: path.join(root, 'rec'), handle: 'tester', roomId: '7', getStream: async () => ({ url, kind: 'flv', quality: 'origin', codec: 'h264' }) });
  for (let i = 0; i < 40 && !failures.length; i++) await sleep(250);
  await rec.stop();
  server.close();
  assert.equal(failures.length, 1, `no failure reported:\n${logs.join('\n')}`);
  assert.equal(failures[0].reason, 'recording_failed');
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.ok(s.runs.length >= 1 && s.runs.every((r) => r.bytes === 0), JSON.stringify(s.runs));
  assert.match(s.runs[0].error, /403|Forbidden|Server returned/i);
  assert.doesNotMatch(JSON.stringify(s) + logs.join('\n'), /SECRET/, 'no signed link in session.json or the log');
  assert.equal(s.diag.result, 'failed');
  assert.ok(s.streamErrors.some((e) => e.source === 'ffmpeg' && e.code === 'no_video'));
});
