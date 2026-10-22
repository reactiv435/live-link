'use strict';
// 2.0.8: the back-up recording. When TikTok sends LIVE Link no video for a while (or the video dies and stays dead), the
// recorder can record the host's own stream window instead: TikTok LIVE Studio, OBS, Streamlabs... (the window the host
// picked in Settings, or the best match by its title), with the computer's audio.
// It is ON by default (owner's decision, 2026-10-22: a LIVE must never go unrecorded); the host can switch it off in
// Settings. It only ever records the stream tool's window (never a whole screen unless the host picked one), and the
// recording card says plainly when the back-up is running.
//
// The capture itself runs in a hidden window of the app (the browser's screen recorder, main.js); it writes one file
// per capture run next to the recording pieces (capture-<run>.webm or .mp4). After the LIVE the file is cut into the
// same 10-minute MP4 pieces the stream recorder writes (ffmpeg, see finalizeArgs), with the same parts-<run>.csv, so
// review clips, "Clip that" moments and the full-show file come out of it like any other recording.
// Electron-free: pure helpers + the ffmpeg arguments. Tested without ffmpeg.

const CAPTURE_AFTER_MS = 75000;          // no TikTok video this long after the LIVE began (or after it died) = capture
const CAPTURE_RETRY_MS = 60000;          // no stream window found: look again this often
const CHUNK_MS = 1000;                   // the browser recorder hands over a piece of the file this often
const SEGMENT_SEC = 600;
// What a capture's picture is for the Recordings list and session.json (no window title beyond this length).
const nameOf = (s) => String((s && s.name) || '').replace(/\s+/g, ' ').trim().slice(0, 80);

// Which window to record, from the list the app can see: [{ id, name, kind: 'window' | 'screen' }].
//   preferred = the window title the host chose in Settings (matched exactly, then loosely); null = automatic.
// Automatic picks the stream tool by its title: TikTok LIVE Studio first, then OBS, Streamlabs and the others. A whole
// screen is never picked by itself (only when the host chose it), and LIVE Link's own windows never are.
const AUTO_TITLES = [
  /tiktok live studio|\blive studio\b/i,
  /^obs\b|\bobs\s*(studio|\d)/i,
  /streamlabs/i,
  /prism live|xsplit|wirecast|vmix|restream studio|twitch studio/i,
];
const OWN_WINDOW = /reactivvibe live link|^live link\b|sign in to tiktok/i;
function pickCaptureSource(sources, preferred = null) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && s.id && !OWN_WINDOW.test(String(s.name || '')));
  const want = String(preferred || '').trim().toLowerCase();
  if (want) {
    const lower = (s) => String(s.name || '').trim().toLowerCase();
    const exact = list.find((s) => lower(s) === want);
    if (exact) return exact;
    // The title drifted since the host chose it (OBS puts the profile and scene in its title, a browser tab its page):
    // the part before the first " - " (or the first word, 3+ letters) still tells the app apart.
    const stem = (t) => String(t).split(/\s+[-–—|]\s+/)[0].trim();
    const head = (t) => (String(t).match(/^[a-z0-9]{3,}/i) || [''])[0];
    const loose = list.find((s) => lower(s) && (lower(s).includes(want) || want.includes(lower(s)) || (stem(want) && stem(lower(s)) === stem(want)) || (head(want) && head(lower(s)) === head(want))));
    if (loose) return loose;
  }
  const windows = list.filter((s) => s.kind !== 'screen' && !/^screen:/.test(String(s.id)));
  for (const re of AUTO_TITLES) {
    const hit = windows.find((s) => re.test(String(s.name || '')));
    if (hit) return hit;
  }
  return null;
}

// The browser recorder's container/codec choice, best first: MP4 with H.264 (cut into pieces without re-encoding),
// then H.264 in WebM, then VP9/VP8 (re-encoded to H.264 after the LIVE so every browser plays the clips).
const MIME_PREFERENCE = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=h264,opus', 'video/webm;codecs=h264',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8,opus', 'video/webm',
];
function pickMime(isSupported) {
  for (const m of MIME_PREFERENCE) { try { if (isSupported(m)) return m; } catch {} }
  return '';
}
const extFor = (mime) => (/^video\/mp4/i.test(String(mime || '')) ? 'mp4' : 'webm');
const videoIsH264 = (mime) => /h264|avc1/i.test(String(mime || ''));

// ffmpeg: the capture file -> part-<run>-NNN.mp4 pieces + parts-<run>.csv, exactly like the stream recorder's output.
// H.264 video is copied (no quality loss, minutes not hours); anything else is encoded to H.264. The audio becomes AAC
// (Opus from the browser recorder is not at home in MP4 pieces, and it's cheap).
function finalizeArgs(file, run, mime, { segmentSec = SEGMENT_SEC } = {}) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-fflags', '+genpts', '-i', file, '-map', '0:v:0', '-map', '0:a:0?'];
  if (videoIsH264(mime)) a.push('-c:v', 'copy');
  else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60');
  a.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
  a.push('-f', 'segment', '-segment_time', String(segmentSec), '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps', '1', '-segment_list', `parts-${run}.csv`, '-segment_list_type', 'csv',
    `part-${run}-%03d.mp4`);
  return a;
}

module.exports = { CAPTURE_AFTER_MS, CAPTURE_RETRY_MS, CHUNK_MS, SEGMENT_SEC, MIME_PREFERENCE, AUTO_TITLES, pickCaptureSource, pickMime, extFor, videoIsH264, finalizeArgs, nameOf };
