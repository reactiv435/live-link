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
  // Wait for the 75 s stream to end (ffmpeg exits at the end of the file), then stop cleanly.
  for (let i = 0; i < 120; i++) { await sleep(1000); const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); if (s.runs[0] && s.runs[0].endedAt) break; }
  clearInterval(burst);
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
  const server = http.createServer((req, res) => { let n = 0; req.on('data', (d) => { n += d.length; }); req.on('end', () => { got[req.url] = n; res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let completed = null;
  const api = {
    reviews: async () => ({ reviews: [{ play_id: 'play-1', started_at: new Date(startedAt).toISOString(), ended_at: new Date(endedAt).toISOString(), title: 'Midnight Signal', artist: 'Sample Artist', host_name: 'ReactivVibeAI' }] }),
    clipUpload: async (m) => ({ upload_url: `http://127.0.0.1:${port}/up/${m.kind}`, path: `host/play-1/${m.kind}` }),
    clipComplete: async (b) => { completed = b; return { ok: true }; },
  };
  const jobs = new ClipJobs({ api, ffmpegPath: FF, fontFile: FONT, log: (l, m) => logs.push(`${l} ${m}`), getOptions: () => ({ delayMs: 0, padStartMs: 1000, padEndMs: 1000, hotSec: 8, verdictSec: 20 }) });
  const result = await jobs.processSession(dir);
  server.close();
  assert.equal(result.sent, 1, `clip not sent: ${JSON.stringify(result)}\n${logs.join('\n')}`);
  assert.ok(got['/up/highlight'] > 50000 && got['/up/full'] > 50000 && got['/up/poster'] > 2000, `uploads: ${JSON.stringify(got)}`);
  assert.equal(got['/up/vertical'], undefined, 'a portrait stream needs no extra vertical copy');
  assert.equal(completed.files.length, 3);

  const job = path.join(dir, 'clips', 'play-1');
  const hl = probe(path.join(job, 'highlight.mp4'));
  assert.equal(hl.codec, 'h264');
  assert.equal(hl.width, 720); assert.equal(hl.height, 1280);
  // 8 s hot + 20 s verdict (+ keyframe slack) - 0.5 s crossfade + 2.4 s end card
  assert.ok(hl.duration > 27 && hl.duration < 38, `highlight duration ${hl.duration}`);
  const full = probe(path.join(job, 'full.mp4'));
  assert.ok(full.duration > 62 && full.duration < 72, `full review duration ${full.duration}`);
  const hotFrom = Date.parse(completed.recipe.hot.from);
  const burstWall = C.mediaToWall(run, 24000);
  assert.ok(Math.abs(hotFrom - burstWall) < 8000, `hottest moment ${((hotFrom - burstWall) / 1000).toFixed(1)} s from the burst`);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).clips['play-1'];
  assert.equal(st.status, 'sent');

  // Stills for a human look: the title strip and the end card.
  if (process.env.E2E_OUT) {
    fs.mkdirSync(process.env.E2E_OUT, { recursive: true });
    spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.5', '-i', path.join(job, 'highlight.mp4'), '-frames:v', '1', path.join(process.env.E2E_OUT, 'hl-title.png')]);
    spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-1.2', '-i', path.join(job, 'highlight.mp4'), '-frames:v', '1', path.join(process.env.E2E_OUT, 'hl-end.png')]);
    fs.copyFileSync(path.join(job, 'poster.jpg'), path.join(process.env.E2E_OUT, 'poster.jpg'));
  }
});
