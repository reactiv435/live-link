'use strict';
// Fetches the prebuilt FFmpeg the app bundles (it records the LIVE and cuts the review clips) into
// vendor/ffmpeg/<platform>-<arch>/. Source: the ffmpeg-static project's GitHub release (GPL-3.0 builds); the license
// and build notes are kept next to each binary and ship with the app.
// Usage: node scripts/fetch-ffmpeg.js [win32-x64] [darwin-x64] [darwin-arm64]   (default: this computer)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RELEASE = 'b6.0';
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-`;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [`${process.platform}-${process.arch}`];

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  for (const t of targets) {
    if (!/^(win32-x64|darwin-x64|darwin-arm64)$/.test(t)) throw new Error(`unknown target ${t}`);
    const dir = path.join(__dirname, '..', 'vendor', 'ffmpeg', t);
    const exe = path.join(dir, t.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(exe) && fs.statSync(exe).size > 1e6) { console.log(`ffmpeg ${t}: already here`); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const bin = zlib.gunzipSync(await get(BASE + t + '.gz'));
    fs.writeFileSync(exe, bin, { mode: 0o755 });
    // License notice shipped next to the binary (GPL-3.0: where its exact source comes from).
    fs.writeFileSync(path.join(dir, 'FFMPEG-NOTICE.txt'), [
      `FFmpeg ${RELEASE.replace(/^b/, '')} for ${t}, bundled with ReactivVibe LIVE Link to record LIVEs and cut review clips.`,
      'This FFmpeg build is licensed under the GNU General Public License v3.0 (it includes libx264).',
      `Binary: ${BASE}${t}.gz (the ffmpeg-static project, https://github.com/eugeneware/ffmpeg-static).`,
      'FFmpeg source code: https://ffmpeg.org/releases/ (version above); build scripts: https://github.com/eugeneware/ffmpeg-static',
      'GPL-3.0 text: https://www.gnu.org/licenses/gpl-3.0.txt. LIVE Link itself is AGPL-3.0 and ships its own source zip.',
      '',
    ].join('\n'));
    console.log(`ffmpeg ${t}: ${(bin.length / 1e6).toFixed(1)} MB`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
