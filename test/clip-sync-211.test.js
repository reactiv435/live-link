'use strict';
// Sound and picture stay together in a highlight (2.1.1).
// Before: the two copied pieces of a highlight were joined on the first piece's FILE length. A copied piece's sound
// usually ends before its picture (the copy runs on to the next keyframe), so the second piece's sound started early
// and stayed early (0.3 to 2 s) for the rest of the clip; a sound dropout on the stream added to it.
// Now: each piece is cut to one length for picture and sound, and the sound keeps its own place in time.
// The last test needs the real ffmpeg: RUN_E2E=1 FFMPEG=<full path to ffmpeg> node --test test/clip-sync-211.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../src/core/clipper');
const { recordArgs } = require('../src/core/recorder');

test('sync: where a stream ends is read from ffmpeg\'s last time= line', () => {
  assert.equal(C.parseStreamEnd('size=N/A time=00:00:04.10 bitrate=N/A\rsize=N/A time=00:00:20.67 bitrate=N/A speed=900x'), 20.67);
  assert.equal(C.parseStreamEnd('frame= 1810 fps=0.0 q=-1.0 Lsize=N/A time=00:01:00.32 bitrate=N/A'), 60.32);
  assert.equal(C.parseStreamEnd('no stats here'), null);
  assert.equal(C.parseStreamEnd(''), null);
  assert.deepEqual(C.streamEndArgs('hot.mp4', 'a'), ['-hide_banner', '-i', 'hot.mp4', '-map', '0:a:0', '-c', 'copy', '-f', 'null', '-']);
});

test('sync: a piece gets one length - where its picture or its sound ends, whichever comes first', () => {
  assert.equal(C.pieceLength(20.78, 20.67, 20.0), 20);
  assert.equal(C.pieceLength(60.43, 60.32, 60.02), 60.02);
  assert.equal(C.pieceLength(12.4, 12.3, null), 12.3);       // no sound: the picture decides
  assert.equal(C.pieceLength(12.4, null, null), 12.4);       // nothing measured: the file length, as before
  assert.equal(C.pieceLength(null, null, null), null);
});

test('sync: both pieces are cut to their one length before the join, and sound is never slid forward', () => {
  const f = C.brandFilter({ hasHot: true, hotDur: 20, verdictDur: 60.02, size: C.targetSize(720, 1280), font: 'font.ttf', texts: {} });
  assert.match(f, /\[0:v\]trim=end=20\.000,/);
  assert.match(f, /\[1:v\]trim=end=60\.020,/);
  assert.match(f, /\[0:a\]aresample=48000:async=1:first_pts=0,[^;]*,atrim=end=20\.000\[ha\]/);
  assert.match(f, /\[1:a\]aresample=48000:async=1:first_pts=0,[^;]*,atrim=end=60\.020\[va\]/);
  assert.match(f, /xfade=transition=fade:duration=0\.5:offset=19\.500/);
  const one = C.brandFilter({ hasHot: false, hotDur: 0, verdictDur: 44.5, size: C.targetSize(720, 1280), font: 'font.ttf', texts: {} });
  assert.match(one, /\[0:v\]trim=end=44\.500,/);
  assert.match(one, /atrim=end=44\.500\[ma\]/);
});

const FF = process.env.FFMPEG;
const RUN = process.env.RUN_E2E === '1' && FF && fs.existsSync(FF);

test('sync: a flash and a beep at every second stay together through the whole highlight', { skip: !RUN, timeout: 300000 }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'll-sync-'));
  const ff = (args) => spawnSync(FF, args, { cwd: dir });
  const ok = (r) => assert.equal(r.status, 0, String(r.stderr).slice(-600));
  // A 40 s "LIVE": white flash (0.1 s) and a 1 kHz beep (0.1 s) at every whole second, keyframe every 2 s.
  ok(ff(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=720x1280:r=30:d=40',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=40',
    '-filter_complex', "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.1)'[v];[1:a]volume='if(lt(mod(t,1),0.1),1,0)':eval=frame[a]",
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', 'live.mp4']));
  // Recorded the way the app records (fragmented pieces), then cut the way the app cuts.
  ok(ff(recordArgs('live.mp4', 0, {})));
  const piece = (name, inSec, outSec) => {
    fs.writeFileSync(path.join(dir, `${name}.txt`), C.concatList([{ file: 'part-0-000.mp4', inSec, outSec }]));
    ok(ff(C.copyArgs(`${name}.txt`, `${name}.mp4`)));
    const p = C.parseProbe(String(ff(['-hide_banner', '-i', `${name}.mp4`]).stderr));
    const end = (k) => C.parseStreamEnd(String(ff(C.streamEndArgs(`${name}.mp4`, k)).stderr));
    return { file: p.duration, video: end('v'), audio: end('a'), len: C.pieceLength(p.duration, end('v'), end('a')) };
  };
  const hot = piece('hot', 5.7, 13.7), verdict = piece('verdict', 20.3, 32.3);
  // The reason this test exists: the copied piece's sound ends before its picture.
  assert.ok(hot.video - hot.audio > 0.2, `expected the hot piece's sound to end early (picture ${hot.video}, sound ${hot.audio})`);
  const size = C.targetSize(720, 1280); size.topBar = null;
  const texts = C.brandTexts(size, { artist: 'A', title: 'T', host: 'H' });
  for (const [name, text] of Object.entries(texts)) fs.writeFileSync(path.join(dir, name), text);
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'fonts', 'ChakraPetch-Bold.ttf'), path.join(dir, 'font.ttf'));
  ok(ff(C.highlightArgs({ hotFile: 'hot.mp4', verdictFile: 'verdict.mp4', outFile: 'highlight.mp4', size, font: 'font.ttf',
    hotDur: hot.len, verdictDur: verdict.len, hasAudio: [true, true], texts })));
  // Flashes (picture) and beeps (sound) in the finished clip.
  const v = String(ff(['-hide_banner', '-nostats', '-i', 'highlight.mp4', '-vf', 'crop=200:200:260:900,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-']).stderr);
  const flashes = []; let t = null, prev = 0;
  for (const line of v.split(/\r?\n/)) {
    const mt = /pts_time:([0-9.]+)/.exec(line); if (mt) t = Number(mt[1]);
    const my = /YAVG=([0-9.]+)/.exec(line);
    if (my && t != null) { const y = Number(my[1]); if (y > 120 && prev <= 120) flashes.push(t); prev = y; }
  }
  const a = String(ff(['-hide_banner', '-nostats', '-i', 'highlight.mp4', '-af', 'silencedetect=noise=-30dB:d=0.2', '-vn', '-f', 'null', '-']).stderr);
  const beeps = [...a.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const content = hot.len + verdict.len - 0.5;
  const checked = flashes.filter((f) => f > 0.5 && f < content - 1 && Math.abs(f - (hot.len - 0.25)) > 0.9);   // not in the crossfade, not in the end card
  assert.ok(checked.length >= 12, `expected a dozen flashes to check, got ${checked.length}`);
  const worst = Math.max(...checked.map((f) => Math.min(...beeps.map((b) => Math.abs(b - f)))));
  assert.ok(worst <= 0.08, `sound and picture are ${worst.toFixed(2)} s apart somewhere in the clip`);
  fs.rmSync(dir, { recursive: true, force: true });
});
