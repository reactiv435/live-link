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

const DEFAULTS = { delayMs: 8000, padStartMs: 4000, padEndMs: 8000, hotSec: 20, verdictSec: 60, minHotGapSec: 2, maxFullSec: 30 * 60, socialHotSec: 12, socialVerdictSec: 12 };

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

// Sizes for the title band and the end card. The band is solid and covers the top of the frame, where streams keep
// their logos and titles (a see-through strip collided with them); faces sit lower.
// size.topBar (px in the target frame) = a black bar the stream already has at the top (TikTok's multi-guest layout):
// the band sits inside it. Without one the band is tall enough to cover a typical stream logo.
function brandLayout({ w: W, h: H, portrait, topBar }) {
  const pad = Math.round(W * 0.05);
  const bandH = topBar ? Math.round(Math.min(H * 0.2, Math.max(H * 0.12, topBar))) : Math.round(H * (portrait ? 0.225 : 0.2));
  const big = Math.round(Math.min(W * 0.095, H * (portrait ? 0.055 : 0.1)));
  return {
    W, H, portrait, pad, bandH, line: Math.max(3, Math.round(H * 0.0035)),
    kicker: Math.round(H * (portrait ? 0.019 : 0.025)), artist: Math.round(H * (portrait ? 0.036 : 0.05)), song: Math.round(H * (portrait ? 0.021 : 0.03)),
    end: { big, label: Math.round(big * 0.4), artist: Math.round(big * 0.52), song: Math.round(big * 0.4), host: Math.round(big * 0.36), cta: Math.round(big * 0.34) },
  };
}

// The top black bar from ffmpeg's cropdetect output ("crop=720:1100:0:90" -> 90 px), scaled to the target frame.
// Only trusted when the stream already has the target's shape and the bar is a real one (>= 9% of the height; a dark room can read as a thin bar).
function topBarFrom(cropdetectText, src, size) {
  const all = [...String(cropdetectText).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length || !src.width || !src.height) return null;
  const [, , , , y] = all[all.length - 1].map(Number);
  if (Math.abs(src.width / src.height - size.w / size.h) > 0.02) return null;
  const px = Math.round(y * (size.h / src.height));
  return px >= size.h * 0.09 ? px : null;
}

function cropdetectArgs(inFile) {
  return ['-hide_banner', '-ss', '2', '-i', inFile, '-t', '4', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-an', '-f', 'null', '-'];
}

// The longest text that fits one line at a font size (Chakra Petch Bold runs ~0.62 em per glyph; no wrapping in drawtext).
function fitText(s, width, fontSize) {
  const max = Math.max(4, Math.floor(width / (fontSize * 0.62)));
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const BRAND = 'ReactivVibeAI';
const sameName = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The words on the clip, one file each (drawtext reads files: quotes, colons and emoji need no escaping).
// The host line is left out when the host IS the brand ("with ReactivVibeAI" under "ReactivVibeAI" reads twice).
function brandTexts(size, { artist, title, host }) {
  const L = brandLayout(size), width = L.W - 2 * L.pad;
  const showHost = !!host && !sameName(host, BRAND);
  const song = title ? `“${String(title).trim()}”` : 'Live review';
  return {
    'kicker.txt': `LIVE REVIEW · ${BRAND}`,
    'artist.txt': fitText(String(artist || BRAND).toUpperCase(), width, L.artist),
    'song.txt': fitText(showHost ? `${song} · with ${host}` : song, width, L.song),
    'end-label.txt': 'REVIEWED LIVE ON',
    'end-brand.txt': BRAND,
    'end-artist.txt': fitText(String(artist || '').toUpperCase(), width, L.end.artist),
    'end-song.txt': title ? fitText(song, width, L.end.song) : '',
    'end-host.txt': showHost ? fitText(`with ${host}`, width, L.end.host) : '',
    'cta.txt': 'GET YOUR MUSIC REVIEWED LIVE',
    'tag.txt': BRAND,
  };
}

function brandFilter({ hasHot, hotDur, verdictDur, size, font, endSec = 2.4, introSec = 4.5, hasAudio = [true, true], texts = {} }) {
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
  const L = brandLayout(size), font1 = `fontfile=${font}`;
  const has = (name) => !!String(texts[name] || '').trim();
  const shadow = 'shadowcolor=black@0.55:shadowx=0:shadowy=2';
  const txt = (file, color, fontSize, x, y, extra = '') => `drawtext=${font1}:textfile=${file}:expansion=none:fontcolor=${color}:fontsize=${fontSize}:x=${x}:y=${y}:${shadow}${extra}`;
  // Title band: solid black glass across the top with a chrome hairline over a crimson edge; fades in and out.
  // The three lines sit centred in the band, whatever its height.
  const bh = L.bandH;
  const block = Math.round(L.kicker * 1.5 + L.artist * 1.35 + L.song);
  const top = Math.max(Math.round(L.kicker * 0.5), Math.round((bh - L.line - 2 - block) / 2));
  f.push(`color=c=0x0A0A0AFF:s=${W}x${bh}:r=30:d=${introSec},format=rgba,` +
    `drawbox=x=0:y=${bh - L.line - 2}:w=iw:h=2:color=0xBDBDBD@0.55:t=fill,` +
    `drawbox=x=0:y=${bh - L.line}:w=iw:h=${L.line}:color=0xE01E3C@1:t=fill,` +
    `${txt('kicker.txt', '0xFF3B55', L.kicker, L.pad, top)},` +
    `${txt('artist.txt', 'white', L.artist, L.pad, top + Math.round(L.kicker * 1.5))},` +
    `${txt('song.txt', '0xD0D0D0', L.song, L.pad, top + Math.round(L.kicker * 1.5 + L.artist * 1.35))},` +
    `fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st=${(introSec - 0.35).toFixed(2)}:d=0.35:alpha=1[band]`);
  // The small ReactivVibeAI tag, top right, once the band has gone.
  const tagSize = Math.round(L.song * 0.8);
  f.push(`[mv][band]overlay=0:0:eof_action=pass[t1]`,
    `[t1]drawtext=${font1}:textfile=tag.txt:expansion=none:fontcolor=white@0.9:fontsize=${tagSize}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(tagSize * 0.4)}:` +
    `x=w-tw-${L.pad}:y=${Math.round(H * (portrait ? 0.06 : 0.05))}:enable='gte(t,${introSec})'[bv]`);
  // End card: the last frame frozen, blurred and darkened, with the brand, the song and a call to action.
  const D = hasHot ? Math.max(0.6, hotDur + verdictDur - 0.5) : Math.max(0.6, verdictDur);
  const T = D.toFixed(3), on = `enable='gte(t,${T})'`, fadeIn = `:alpha='min(1,(t-${T})/0.3)':${on}`;
  const E = L.end;
  let y = Math.round(H * (portrait ? 0.35 : 0.24));
  const ys = {};
  ys.label = y; y += Math.round(E.label * 1.5);
  ys.brand = y; y += Math.round(E.big * 1.15);
  ys.bar = y; y += Math.round(E.big * 0.45);
  if (has('end-artist.txt')) { ys.artist = y; y += Math.round(E.artist * 1.35); }
  if (has('end-song.txt')) { ys.song = y; y += Math.round(E.song * 1.4); }
  if (has('end-host.txt')) { ys.host = y; }
  const barW = Math.round(W * 0.22);
  const end = [`tpad=stop_mode=clone:stop_duration=${endSec}`,
    `boxblur=luma_radius=18:luma_power=2:${on}`, `eq=brightness=-0.2:saturation=0.55:${on}`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill:${on}`,
    txt('end-label.txt', '0xC8C8C8', E.label, '(w-tw)/2', ys.label, fadeIn),
    txt('end-brand.txt', 'white', E.big, '(w-tw)/2', ys.brand, fadeIn),
    `drawbox=x=${Math.round((W - barW) / 2)}:y=${ys.bar}:w=${barW}:h=${L.line + 2}:color=0xE01E3C@1:t=fill:${on}`];
  if (ys.artist != null) end.push(txt('end-artist.txt', 'white', E.artist, '(w-tw)/2', ys.artist, fadeIn));
  if (ys.song != null) end.push(txt('end-song.txt', '0xD0D0D0', E.song, '(w-tw)/2', ys.song, fadeIn));
  if (ys.host != null) end.push(txt('end-host.txt', '0xD0D0D0', E.host, '(w-tw)/2', ys.host, fadeIn));
  end.push(`drawtext=${font1}:textfile=cta.txt:expansion=none:fontcolor=white:fontsize=${E.cta}:box=1:boxcolor=0xE01E3C@1:boxborderw=${Math.round(E.cta * 0.75)}:` +
    `x=(w-tw)/2:y=${Math.round(H * (portrait ? 0.7 : 0.78))}${fadeIn}`);
  f.push(`[bv]${end.join(',')}[v]`);
  // The sound fades out under the end card instead of cutting.
  f.push(`[ma]afade=t=out:st=${Math.max(0, D - 0.6).toFixed(3)}:d=0.6,apad=pad_dur=${endSec}[a]`);
  return f.join(';');
}

function highlightArgs({ hotFile, verdictFile, outFile, size, font, hotDur, verdictDur, hasAudio, texts, hotSeek, verdictSeek, introSec, endSec }) {
  const a = ['-hide_banner', '-loglevel', 'error', '-y'];
  // Seeks (the short social cut) apply to the input; durations then mean the trimmed lengths.
  const input = (file, seek, dur) => { if (seek != null) a.push('-ss', Number(seek).toFixed(3), '-t', Number(dur).toFixed(3)); a.push('-i', file); };
  if (hotFile) input(hotFile, hotSeek, hotDur);
  input(verdictFile, verdictSeek, verdictDur);
  a.push('-filter_complex', brandFilter({ hasHot: !!hotFile, hotDur, verdictDur, size, font, hasAudio, texts, introSec, endSec }), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile);
  return a;
}

// The short cut for TikTok / Reels / Shorts (measured: 16-26 s posts keep viewers): the middle of the hottest moment
// plus the last seconds before the host moves on (the verdict), with a shorter band and end card.
function socialPlan({ hotDur, verdictDur, hasHot }, o = {}) {
  const hotLen = hasHot ? Math.min(o.socialHotSec || 12, hotDur) : 0;
  const verdictLen = Math.min(hasHot ? (o.socialVerdictSec || 12) : (o.socialHotSec || 12) + (o.socialVerdictSec || 12), verdictDur);
  return { hotSeek: hasHot ? Math.max(0, (hotDur - hotLen) / 2) : null, hotLen, verdictSeek: Math.max(0, verdictDur - verdictLen), verdictLen };
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
  concatList, copyArgs, targetSize, brandLayout, topBarFrom, cropdetectArgs, brandTexts, fitText, brandFilter, highlightArgs, socialPlan, verticalArgs, posterArgs, parseProbe };
