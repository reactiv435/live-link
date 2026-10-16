'use strict';
// Turns a recorded LIVE into review clips. Pure planning (unit-tested) + the ffmpeg runs (integration-tested).
//
// One fixed recipe per review, no editing by hand:
//   full review  = everything from the song going on air to the host moving on (copied, not re-encoded)
//   highlight    = ~20 s around the song's biggest tap/gift burst + the last ~60 s (the verdict), crossfaded,
//                  with a short title strip at the start, a small ReactivVibeAI tag, and a 2-second end card.
//                  (The host's overlay band is already in the video, so no second lower third.)
//   vertical     = only for a landscape stream: the highlight centered on a blurred copy of itself, 9:16
//   poster       = a still from the hottest moment
//
// Timing: a review's start/end are SERVER times when the host clicked. The recorded TikTok copy shows that moment
// `delayMs` later (the stream's delay), so review times shift by +delayMs and get padding. Viewers react to the same
// delayed video, so tap times are NOT shifted.

const fs = require('fs');
const path = require('path');

const DEFAULTS = { delayMs: 8000, padStartMs: 4000, padEndMs: 8000, hotSec: 20, verdictSec: 60, minHotGapSec: 2, maxFullSec: 30 * 60 };

// ------------------------------------------------------------ session + timeline
function readSession(dir) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  for (const run of s.runs || []) run.parts = readParts(dir, run.index, run);
  return s;
}

// ffmpeg's segment list: "part-0-000.mp4,0.000000,600.021333" (media seconds). The last piece of a run that was cut
// off (crash, power loss) may be missing from the list: it starts where the previous one ended and runs to the last
// media time seen.
function readParts(dir, index, run) {
  const parts = [];
  try {
    for (const line of fs.readFileSync(path.join(dir, `parts-${index}.csv`), 'utf8').split(/\r?\n/)) {
      const [file, a, b] = line.split(',');
      if (file && /^part-\d+-\d+\.mp4$/.test(file) && Number.isFinite(Number(a))) parts.push({ file, start: Number(a), end: Number(b) });
    }
  } catch {}
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => new RegExp(`^part-${index}-\\d+\\.mp4$`).test(f)).sort(); } catch {}
  for (const f of files) {
    if (parts.some((p) => p.file === f)) continue;
    const prev = parts.length ? parts[parts.length - 1].end : 0;
    const end = Math.max(prev, (run && run.lastMediaMs ? run.lastMediaMs / 1000 : prev));
    if (end > prev) parts.push({ file: f, start: prev, end });
  }
  return parts;
}

// [media ms, server ms] samples -> server time for a media time (straight line between samples, slope 1 outside).
function mediaToWall(run, mediaMs) {
  const s = run.samples || [];
  if (!s.length) return run.startedAt + mediaMs;
  if (mediaMs <= s[0][0] || s.length === 1) return s[0][1] + (mediaMs - s[0][0]);
  for (let i = 1; i < s.length; i++) {
    if (mediaMs <= s[i][0]) {
      const [m0, w0] = s[i - 1], [m1, w1] = s[i];
      return w0 + (mediaMs - m0) * ((w1 - w0) / Math.max(1, m1 - m0));
    }
  }
  const [m, w] = s[s.length - 1];
  return w + (mediaMs - m);
}
function wallToMedia(run, wallMs) {
  const s = run.samples || [];
  if (!s.length) return wallMs - run.startedAt;
  if (wallMs <= s[0][1] || s.length === 1) return s[0][0] + (wallMs - s[0][1]);
  for (let i = 1; i < s.length; i++) {
    if (wallMs <= s[i][1]) {
      const [m0, w0] = s[i - 1], [m1, w1] = s[i];
      return m0 + (wallMs - w0) * ((m1 - m0) / Math.max(1, w1 - w0));
    }
  }
  const [m, w] = s[s.length - 1];
  return m + (wallMs - w);
}

// Every recorded piece with its server-time span.
function timeline(session) {
  const out = [];
  for (const run of session.runs || []) {
    for (const p of run.parts || []) {
      out.push({ file: p.file, run, mediaStart: p.start * 1000, mediaEnd: p.end * 1000,
        wallStart: mediaToWall(run, p.start * 1000), wallEnd: mediaToWall(run, p.end * 1000) });
    }
  }
  return out.sort((a, b) => a.wallStart - b.wallStart);
}

// Server-time range -> pieces to cut: [{ file, inSec, outSec }] (seconds inside each piece).
function cutsFor(tl, fromWall, toWall) {
  const cuts = [];
  for (const p of tl) {
    if (p.wallEnd <= fromWall || p.wallStart >= toWall) continue;
    const a = Math.max(fromWall, p.wallStart), b = Math.min(toWall, p.wallEnd);
    const inSec = Math.max(0, (wallToMedia(p.run, a) - p.mediaStart) / 1000);
    const outSec = Math.min((p.mediaEnd - p.mediaStart) / 1000, (wallToMedia(p.run, b) - p.mediaStart) / 1000);
    if (outSec - inSec >= 0.5) cuts.push({ file: p.file, inSec: round3(inSec), outSec: round3(outSec) });
  }
  return cuts;
}
const round3 = (x) => Math.round(x * 1000) / 1000;
const coveredMs = (cuts) => cuts.reduce((n, c) => n + (c.outSec - c.inSec) * 1000, 0);

// ------------------------------------------------------------ the recipe
// review: { startedAt, endedAt } server ms (endedAt null = still on air when the LIVE ended -> sessionEnd).
// taps: { [serverSecond]: weight }. Returns server-time ranges.
function planReview(review, taps, sessionEnd, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const started = Number(review.startedAt), ended = Number(review.endedAt || sessionEnd);
  if (!(ended > started)) return null;
  const from = started + o.delayMs - o.padStartMs;
  const to = Math.min(ended + o.delayMs + o.padEndMs, from + o.maxFullSec * 1000);
  const full = { from, to };
  const spanMs = to - from;
  const hotMs = o.hotSec * 1000, verdictMs = o.verdictSec * 1000;
  // A short review: the highlight is the whole thing.
  if (spanMs <= hotMs + verdictMs + 10000) return { full, hot: null, verdict: { from, to }, posterAt: from + spanMs * 0.4, hotWeight: 0 };
  const verdict = { from: to - verdictMs, to };
  // Hottest window: the most taps + gift hype in any hotSec window between the song start and the verdict.
  const lo = Math.floor((from + 5000) / 1000), hi = Math.floor((verdict.from - o.minHotGapSec * 1000) / 1000) - o.hotSec;
  let best = -1, bestAt = null, sum = 0;
  const w = (sec) => Number(taps && taps[sec]) || 0;
  if (hi >= lo) {
    for (let s = lo; s < lo + o.hotSec; s++) sum += w(s);
    best = sum; bestAt = lo;
    for (let s = lo + 1; s <= hi; s++) {
      sum += w(s + o.hotSec - 1) - w(s - 1);
      if (sum > best) { best = sum; bestAt = s; }
    }
  }
  let hot;
  if (bestAt !== null && best > 0) hot = { from: bestAt * 1000, to: bestAt * 1000 + hotMs };
  else {
    // Nobody tapped: take the stretch ~35% into the song (usually past the intro).
    const at = from + Math.min(spanMs - verdictMs - hotMs - 2000, Math.max(5000, (spanMs - verdictMs) * 0.35));
    hot = { from: at, to: at + hotMs };
  }
  return { full, hot, verdict, posterAt: (hot.from + hot.to) / 2, hotWeight: Math.max(0, best) };
}

// ------------------------------------------------------------ ffmpeg argument builders
function concatList(cuts) {
  return 'ffconcat version 1.0\n' + cuts.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'\ninpoint ${c.inSec}\noutpoint ${c.outSec}\n`).join('');
}

// Straight copy of a range (fast; starts at the keyframe before the cut, which the padding covers).
function copyArgs(listFile, outFile, { reencode = false } = {}) {
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-map', '0:v:0', '-map', '0:a:0?'];
  if (reencode) a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k');
  else a.push('-c', 'copy');
  a.push('-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', outFile);
  return a;
}

// Target frame for a source size: portrait stays 720x1280, landscape 1280x720.
function targetSize(w, h) { return w && h && h > w ? { w: 720, h: 1280, portrait: true } : { w: 1280, h: 720, portrait: false }; }

// Text for drawtext lives in small files next to the job (no escaping problems with quotes, colons or emoji).
function brandFilter({ hasHot, hotDur, verdictDur, size, font, endSec = 2.4, introSec = 4.5, hasAudio = [true, true] }) {
  const { w: W, h: H, portrait } = size;
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
  const aud = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  // A piece without sound gets silence of its own length, so the crossfade and the end card still line up.
  const silence = (dur, label) => `anullsrc=r=48000:cl=stereo,atrim=0:${Math.max(0.5, Number(dur) || 0.5).toFixed(3)},${aud}[${label}]`;
  const f = [];
  if (hasHot) {
    f.push(`[0:v]${fit}[hv]`, `[1:v]${fit}[vv]`);
    f.push(hasAudio[0] ? `[0:a]${aud}[ha]` : silence(hotDur, 'ha'));
    f.push(hasAudio[1] ? `[1:a]${aud}[va]` : silence(verdictDur, 'va'));
    const off = Math.max(0.1, hotDur - 0.5).toFixed(3);
    f.push(`[hv][vv]xfade=transition=fade:duration=0.5:offset=${off}[mv]`, `[ha][va]acrossfade=d=0.5[ma]`);
  } else {
    f.push(`[0:v]${fit}[mv]`);
    f.push(hasAudio[0] ? `[0:a]${aud}[ma]` : silence(verdictDur, 'ma'));
  }
  // Title strip near the top for the first seconds (clear of TikTok/Reels UI, and of the host's band in the middle).
  const fs1 = Math.round(H * (portrait ? 0.032 : 0.05)), fs2 = Math.round(fs1 * 0.62), pad = Math.round(W * 0.05);
  const y0 = Math.round(H * (portrait ? 0.12 : 0.06)), bh = Math.round(fs1 * 2.6);
  const show = `enable='between(t,0,${introSec})'`;
  const alpha = `alpha='if(lt(t,0.35),t/0.35,if(gt(t,${introSec - 0.35}),(${introSec}-t)/0.35,1))'`;
  const font1 = `fontfile=${font}`;
  f.push(`[mv]drawbox=x=0:y=${y0}:w=iw:h=${bh}:color=black@0.62:t=fill:${show},` +
    `drawbox=x=0:y=${y0}:w=${Math.round(W * 0.012)}:h=${bh}:color=0xE01E3C@1:t=fill:${show},` +
    `drawtext=${font1}:textfile=title.txt:expansion=none:fontcolor=white:fontsize=${fs1}:x=${pad}:y=${y0 + Math.round(bh * 0.14)}:${alpha}:${show},` +
    `drawtext=${font1}:textfile=sub.txt:expansion=none:fontcolor=0xD6D6D6:fontsize=${fs2}:x=${pad}:y=${y0 + Math.round(bh * 0.6)}:${alpha}:${show},` +
    // the small ReactivVibeAI tag, top right, all the way through
    `drawtext=${font1}:text='ReactivVibeAI':expansion=none:fontcolor=white@0.9:fontsize=${Math.round(fs2 * 0.85)}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(fs2 * 0.35)}:x=w-tw-${pad}:y=${Math.round(H * (portrait ? 0.075 : 0.04))}[bv]`);
  // End card: "Reviewed live on ReactivVibeAI" + the host.
  const e1 = Math.round(H * (portrait ? 0.022 : 0.034)), e2 = Math.round(e1 * 2.4), e3 = Math.round(e1 * 1.05);
  f.push(`color=c=0x0A0A0A:s=${W}x${H}:r=30:d=${endSec},format=yuv420p,` +
    `drawbox=x=(iw-${Math.round(W * 0.18)})/2:y=ih/2-${Math.round(e2 * 0.15)}:w=${Math.round(W * 0.18)}:h=${Math.max(3, Math.round(H * 0.004))}:color=0xE01E3C@1:t=fill,` +
    `drawtext=${font1}:text='REVIEWED LIVE ON':expansion=none:fontcolor=0xBDBDBD:fontsize=${e1}:x=(w-tw)/2:y=h/2-${Math.round(e2 * 1.55)},` +
    `drawtext=${font1}:text='ReactivVibeAI':expansion=none:fontcolor=white:fontsize=${e2}:x=(w-tw)/2:y=h/2-${Math.round(e2 * 1.15)},` +
    `drawtext=${font1}:textfile=host.txt:expansion=none:fontcolor=0xD6D6D6:fontsize=${e3}:x=(w-tw)/2:y=h/2+${Math.round(e2 * 0.45)},` +
    `fade=t=in:st=0:d=0.3[ev]`);
  f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${endSec}[ea]`);
  f.push(`[bv][ma][ev][ea]concat=n=2:v=1:a=1[v][a]`);
  return f.join(';');
}

function highlightArgs({ hotFile, verdictFile, outFile, size, font, hotDur, verdictDur, hasAudio }) {
  const a = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (hotFile) a.push('-i', hotFile);
  a.push('-i', verdictFile);
  a.push('-filter_complex', brandFilter({ hasHot: !!hotFile, hotDur, verdictDur, size, font, hasAudio }), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile);
  return a;
}

function verticalArgs(inFile, outFile) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-filter_complex',
    '[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', outFile];
}

function posterArgs(inFile, atSec, outFile) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, atSec)), '-i', inFile, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', outFile];
}

// "Duration: 00:01:02.34" and "Video: h264 ..., 720x1280" from ffmpeg's banner.
function parseProbe(text) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const v = /Video:\s*([a-z0-9]+)[^\n]*?\s(\d{2,5})x(\d{2,5})/i.exec(text);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    codec: v ? v[1].toLowerCase() : null,
    width: v ? Number(v[2]) : null,
    height: v ? Number(v[3]) : null,
    hasAudio: /Audio:/.test(text),
  };
}

module.exports = { DEFAULTS, readSession, readParts, mediaToWall, wallToMedia, timeline, cutsFor, coveredMs, planReview,
  concatList, copyArgs, targetSize, brandFilter, highlightArgs, verticalArgs, posterArgs, parseProbe };
