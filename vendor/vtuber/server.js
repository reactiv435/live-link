// VTuber avatar test server: static files + a WebSocket relay. Listens on 127.0.0.1 ONLY (never the network).
//   http://127.0.0.1:8791/control.html   the owner's control panel (Chrome / Edge)
//   http://127.0.0.1:8791/avatar.html    the OBS Browser Source
//   http://127.0.0.1:8791/tracking/tracker.html, .../tracking/hands.html   the tracker page and the hand-line source
//   ws://127.0.0.1:8791/ws               every JSON message is passed on to every OTHER connected page
//   http://127.0.0.1:8791/api/calibration   the tracker's saved face calibration (GET / PUT / DELETE; one small file on this PC)
//   http://127.0.0.1:8791/api/signs         V9: the host's own show signs (list / upload / delete / play; files on this PC only)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('./vendor/ws');

const HOST = '127.0.0.1';
const PORT = Number(process.env.VTUBER_PORT) || 8791;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.task': 'application/octet-stream', '.tflite': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',                                   // the countdown music (assets/music/)
};
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', Pragma: 'no-cache', Expires: '0' };
// never served: the server itself, git data, dependencies, scratch, and the folders that hold the owner's test footage
// and the review media (review/, tracking/review/, tracking/testdata/)
const HIDDEN = /^(?:\.git|node_modules|tmp|tools|review|signs-owner|tracking[\\/](?:review|testdata|tools))(?:[\\/]|$)|^(?:server\.js|start-vtuber\.bat|\.gitignore|gifts-owner\.json|vtuber-obs\.json|tracking[\\/](?:calib-saved|mask-rest)\.json)$/i;

// ---------------------------------------------------------------- the tracker's saved calibration
// "Capture neutral face" and what the tracker learns about the owner's face are kept in ONE file on this PC, so the
// tracker opened in normal Chrome and the one opened by tracking\start-tracker.bat (its own browser profile) start
// from the same calibration. The file is git-ignored and never leaves this PC.
//   GET    /api/calibration   -> the saved object, or null when there is none
//   PUT    /api/calibration   -> keeps the JSON object in the body (it must carry a `data` object; at most 256 kB)
//   DELETE /api/calibration   -> forgets it
// Same rules as the rest: only this PC's loopback names are answered, and a page from anywhere else is refused.
const CALIB_MAX = 256 * 1024;
/**
 * Where the calibration is kept. VTUBER_CALIB_FILE names the file ("none" = nowhere). Without it: next to
 * calib-owner.json when the server runs on the show's own port, and NOWHERE on any other port, so a test or a dev
 * tool (they all use other ports) can never overwrite the owner's calibration with one made from a test clip.
 */
function calibFileFor(port) {
  const env = process.env.VTUBER_CALIB_FILE;
  if (env) return env.toLowerCase() === 'none' ? null : path.resolve(ROOT, env);
  return port === 8791 ? path.join(ROOT, 'tracking', 'calib-saved.json') : null;
}
function calibrationApi(req, res, file) {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...NO_CACHE, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  // a browser says where a request comes from; only this server's own pages (or a local tool, which says nothing) may ask
  const site = req.headers['sec-fetch-site'];
  if (!originAllowed(req.headers.origin) || (site && site !== 'same-origin' && site !== 'none')) { req.resume(); send(403, { error: 'forbidden' }); return; }
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!file) { send(200, null); return; }
    fs.readFile(file, 'utf8', (err, text) => {
      let obj = null;
      if (!err) { try { obj = JSON.parse(text); } catch { obj = null; } }
      send(200, obj && typeof obj === 'object' && !Array.isArray(obj) && obj.data && typeof obj.data === 'object' ? obj : null);
    });
  } else if (req.method === 'DELETE') {
    req.resume();
    if (!file) { send(200, { saved: false }); return; }
    fs.unlink(file, () => send(200, { saved: false }));
  } else if (req.method === 'PUT') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { req.resume(); send(415, { error: 'send JSON' }); return; }
    const parts = [];
    let size = 0, over = false;
    req.on('data', (d) => { size += d.length; if (size > CALIB_MAX) over = true; else parts.push(d); });
    req.on('error', () => { /* the page went away */ });
    req.on('end', () => {
      if (over) { send(413, { error: 'too big' }); return; }
      let obj = null;
      try { obj = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { obj = null; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) { send(400, { error: 'not a calibration' }); return; }
      if (!file) { send(200, { saved: false }); return; }
      const tmp = file + '.tmp';                       // written whole, then swapped in: a crash never leaves half a file
      fs.writeFile(tmp, JSON.stringify(obj), (err) => {
        if (err) { send(500, { error: 'could not save' }); return; }
        fs.rename(tmp, file, (err2) => send(err2 ? 500 : 200, err2 ? { error: 'could not save' } : { saved: true }));
      });
    });
  } else { req.resume(); res.writeHead(405, NO_CACHE); res.end(); }
}

// ---------------------------------------------------------------- V9: the host's own show signs (/api/signs)
// A looping video or picture each host uploads in the VTuber window; the avatar page plays it with its green keyed out.
// The files stay on this PC, in ONE folder (inside LIVE Link: its data folder; never the app's own files), and are never
// sent anywhere.
//   GET    /api/signs            -> { signs: [{ name, size, video, at }], keep: 6, max: bytes, can: true | false }
//   PUT    /api/signs/<name>     -> the file's bytes in the body. Kept under a SAFE name made from <name> (js/v9-sign.js
//                                   safeSignName: letters, digits, dashes + a known ending; never a path), only when its
//                                   first bytes are what the ending says, at most 60 MB, at most 6 kept. -> { name, size }
//   DELETE /api/signs/<name>     -> the file is removed from the disk
//   GET    /api/signs/<name>     -> the file (byte ranges answered: a video loops and seeks)
// Only this server's own pages may ask (the same rule as the calibration), and a write must carry the page's own header.
const SIGN = require('./js/v9-sign.js');
/** Where the signs are kept. VTUBER_SIGN_DIR names the folder ("none" = nowhere). Without it: `signs-owner` next to this
 *  file when the server runs on the show's own port, and NOWHERE on any other port (a test never writes his folder). */
function signDirFor(port) {
  const env = process.env.VTUBER_SIGN_DIR;
  if (env) return env.toLowerCase() === 'none' ? null : path.resolve(ROOT, env);
  return port === 8791 ? path.join(ROOT, 'signs-owner') : null;
}
function listSigns(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    let st = null;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (!st.isFile()) continue;
    if (SIGN.isSignName(n)) out.push({ name: n, size: st.size, video: SIGN.signIsVideo(n), at: Math.round(st.mtimeMs) });
    else if (/^\.up-[a-f0-9]{12}\.tmp$/.test(n) && Date.now() - st.mtimeMs > 3600000) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* still open */ } }   // an upload that died an hour ago
  }
  return out.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
}
function signsApi(req, res, dir) {
  const send = (code, obj, extra) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...NO_CACHE, ...extra, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const site = req.headers['sec-fetch-site'];
  if (!originAllowed(req.headers.origin) || (site && site !== 'same-origin' && site !== 'none')) { req.resume(); send(403, { error: 'forbidden' }); return; }
  const rest = (req.url || '').split('?')[0].split('#')[0].slice('/api/signs'.length);
  if (rest === '' || rest === '/') {
    req.resume();
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: 'method' }); return; }
    send(200, { signs: dir ? listSigns(dir) : [], keep: SIGN.SIGN_KEEP, max: SIGN.SIGN_MAX_BYTES, can: !!dir });
    return;
  }
  let raw = '';
  try { raw = decodeURIComponent(rest.slice(1)); } catch { raw = ''; }
  const write = req.method === 'PUT' || req.method === 'DELETE';
  if (write && req.headers['x-vtuber-sign'] !== '1') { req.resume(); send(403, { error: 'forbidden' }); return; }
  if (!dir) { req.resume(); send(write ? 503 : 404, { error: 'no folder for signs here' }); return; }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
    req.resume();
    // (only a name exactly as this server made it: no slash, no "..", no other ending ever reaches the disk)
    if (!SIGN.isSignName(raw)) { send(404, { error: 'not found' }); return; }
    const file = path.join(dir, raw);
    if (req.method === 'DELETE') { fs.unlink(file, (err) => { const bad = err && err.code !== 'ENOENT'; send(bad ? 500 : 200, bad ? { error: 'could not delete' } : { ok: true, signs: listSigns(dir) }); }); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { send(404, { error: 'not found' }); return; }
      const head = { 'Cache-Control': 'private, no-cache', 'Content-Type': SIGN.SIGN_TYPES[raw.split('.').pop()], 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Last-Modified': st.mtime.toUTCString() };
      let a = 0, b = st.size - 1, code = 200;
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
      if (m && (m[1] || m[2]) && st.size > 0) {
        if (m[1]) { a = Number(m[1]); if (m[2]) b = Math.min(b, Number(m[2])); } else a = Math.max(0, st.size - Number(m[2]));
        if (!(a <= b) || a >= st.size) { res.writeHead(416, { ...head, 'Content-Range': 'bytes */' + st.size, 'Content-Length': 0 }); res.end(); return; }
        code = 206; head['Content-Range'] = 'bytes ' + a + '-' + b + '/' + st.size;
      }
      res.writeHead(code, { ...head, 'Content-Length': st.size ? b - a + 1 : 0 });
      if (req.method === 'HEAD' || !st.size) { res.end(); return; }
      fs.createReadStream(file, { start: a, end: b }).on('error', () => res.destroy()).pipe(res);
    });
    return;
  }
  if (req.method !== 'PUT') { req.resume(); send(405, { error: 'method' }); return; }
  // ---- an upload
  const refuse = (code, error) => { req.resume(); send(code, { error }, { Connection: 'close' }); };
  const want = SIGN.safeSignName(raw), kind = SIGN.signKind(want);
  if (!want) { refuse(415, 'type'); return; }                                     // not mp4 / webm / png / gif / jpg by its name
  if (Number(req.headers['content-length']) > SIGN.SIGN_MAX_BYTES) { refuse(413, 'big'); return; }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { refuse(500, 'could not save'); return; }
  const have = listSigns(dir);
  if (have.length >= SIGN.SIGN_KEEP) { refuse(409, 'full'); return; }
  // a name already there is never overwritten: "sign.mp4" a second time is kept as "sign-2.mp4"
  let name = want;
  for (let i = 2; have.some((s) => s.name === name) && i < 99; i++) { const dot = want.lastIndexOf('.'); name = want.slice(0, dot).slice(0, 37) + '-' + i + want.slice(dot); }
  if (!SIGN.isSignName(name) || have.some((s) => s.name === name)) { refuse(409, 'full'); return; }
  const tmp = path.join(dir, '.up-' + require('crypto').randomBytes(6).toString('hex') + '.tmp');
  const out = fs.createWriteStream(tmp);
  let size = 0, done = false, head = Buffer.alloc(0), sniffed = false;
  // the half-written file is removed only once its handle is closed (on Windows a file still open is "deleted" but stays
  // listed until then), and only then is the answer sent
  const closed = (fn) => { if (out.closed) fn(); else out.once('close', fn); };
  const fail = (code, error) => {
    if (done) return; done = true;
    req.unpipe(out); closed(() => fs.unlink(tmp, () => refuse(code, error))); out.destroy();
  };
  req.on('data', (d) => {
    if (done) return;
    size += d.length;
    if (size > SIGN.SIGN_MAX_BYTES) { fail(413, 'big'); return; }
    if (!sniffed) {
      head = head.length ? Buffer.concat([head, d]) : d;
      if (head.length >= 12) { sniffed = true; if (SIGN.sniffSign(head) !== kind) { fail(415, 'type'); return; } head = null; }
    }
  });
  req.on('error', () => fail(400, 'broken'));
  req.on('aborted', () => fail(400, 'broken'));
  out.on('error', () => fail(500, 'could not save'));
  req.pipe(out);
  out.on('finish', () => {
    if (done) return;
    if (!sniffed) { fail(415, 'type'); return; }                                  // under 12 bytes: not a picture, not a video
    done = true;
    // the picture size it says it has (the headers only; no picture is decoded here): over 4096 px on a side, or not
    // readable at all, and it is not kept (a tiny file that claims a huge picture would choke the OBS page)
    closed(() => fs.readFile(tmp, (er, buf) => {
      const px = er ? null : SIGN.pixelsOf(buf, kind);
      if (!px || px.w > SIGN.SIGN_MAX_PX || px.h > SIGN.SIGN_MAX_PX) { req.resume(); fs.unlink(tmp, () => send(px ? 422 : 415, px ? { error: 'pixels', w: px.w, h: px.h, max: SIGN.SIGN_MAX_PX } : { error: 'unread' }, { Connection: 'close' })); return; }
      keep(px);
    }));
  });
  const keep = (px) => {
    fs.rename(tmp, path.join(dir, name), (err) => {
      if (err) { fs.unlink(tmp, () => {}); send(500, { error: 'could not save' }); return; }
      send(200, { name, size, w: px.w, h: px.h, signs: listSigns(dir) });
    });
  };
}

// ---------------------------------------------------------------- V8: viewers' pictures and the song's cover (/api/pic?u=)
// The avatar page never loads a picture from TikTok itself (that would tell TikTok's servers about the OBS page, and a
// picture from another site cannot be read back from a canvas). It asks THIS server, which fetches it once:
//   only https, only the hosts on js/mask-wire.js's list (TikTok's picture servers, the site's storage for covers),
//   only a picture (jpeg / png / webp / gif by its type AND its first bytes), a viewer's picture at most 300 kB, a song's
//   cover (the site's storage host only: album art is often over 1 MB) at most 4 MB, 4 s, no redirects followed,
//   kept in memory only (the newest ~200; never on disk), and the address is never logged.
// Anything else = 404, and the page draws its placeholder.
const PIC = { max: 300 * 1024, maxCover: 4 * 1024 * 1024, timeoutMs: 4000, keep: 200, types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], badMs: 60000 };
/** the real fetch: -> Promise<{ type, body: Buffer }> (rejects with a short code). Tests give their own. */
function httpsPicture(url, { max = PIC.max, timeoutMs = PIC.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, req = null;
    const end = (err, v) => { if (done) return; done = true; clearTimeout(timer); if (err) { try { req.destroy(); } catch { /* gone */ } reject(new Error(err)); } else resolve(v); };
    const timer = setTimeout(() => end('timeout'), timeoutMs);
    req = require('https').get(url, { headers: { Accept: 'image/webp,image/jpeg,image/png,image/gif', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return end('status'); }      // (a redirect is not followed: it could lead off the list)
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!PIC.types.includes(type)) { res.resume(); return end('type'); }
      if (Number(res.headers['content-length']) > max) { res.resume(); return end('big'); }
      const parts = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > max) end('big'); else parts.push(d); });
      res.on('end', () => end(null, { type, body: Buffer.concat(parts) }));
      res.on('error', () => end('read'));
    });
    req.on('error', () => end('net'));
  });
}
/** what the picture's first bytes say it is (the type header alone is not believed) */
function sniffPicture(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return '';
}
/** createPicProxy({ fetch, hosts, keep }) -> { handle(req, res), stats() }. One per server. */
function createPicProxy(o = {}) {
  const Wire = require('./js/mask-wire.js');
  const fetchPic = o.fetch || httpsPicture, cache = new Map(), bad = new Map(), flying = new Map();
  const S = { hits: 0, fetched: 0, refused: 0, failed: 0 };
  const keep = (k, v) => { cache.delete(k); cache.set(k, v); while (cache.size > (o.keep || PIC.keep)) cache.delete(cache.keys().next().value); };
  function handle(req, res) {
    const none = (code = 404) => { res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': 0 }); res.end(); };
    const site = req.headers['sec-fetch-site'];
    if (!originAllowed(req.headers.origin) || (site && site !== 'same-origin' && site !== 'none')) { S.refused++; return none(403); }
    if (req.method !== 'GET') return none(405);
    let u = null;
    try { u = new URLSearchParams((req.url || '').split('?').slice(1).join('?')).get('u'); } catch { u = null; }
    const url = Wire.picUrl(u, o.hosts);
    if (!url) { S.refused++; return none(404); }
    const max = Wire.picUrl(url, Wire.COVER_HOSTS) ? PIC.maxCover : PIC.max;      // (fix round S4: a cover may be big, a viewer's picture may not)
    const give = (p) => { res.writeHead(200, { 'Content-Type': p.type, 'Content-Length': p.body.length, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }); res.end(p.body); };
    const hit = cache.get(url);
    if (hit) { S.hits++; keep(url, hit); return give(hit); }
    if (bad.has(url) && Date.now() - bad.get(url) < PIC.badMs) return none(404);          // it failed a moment ago: not asked again for a minute
    let p = flying.get(url);
    if (!p) {
      if (flying.size >= 8) return none(503);                                              // never more than 8 on their way
      p = Promise.resolve().then(() => fetchPic(url, { max, timeoutMs: PIC.timeoutMs })).then((r) => {
        const type = r && Buffer.isBuffer(r.body) && r.body.length <= max ? sniffPicture(r.body) : '';
        if (!type || !PIC.types.includes(String(r.type || '').split(';')[0].trim().toLowerCase())) throw new Error('not a picture');
        const pic = { type, body: r.body }; keep(url, pic); S.fetched++; return pic;
      });
      flying.set(url, p);
      const clear = () => flying.delete(url);
      p.then(clear, () => { clear(); S.failed++; bad.set(url, Date.now()); if (bad.size > 400) bad.delete(bad.keys().next().value); });
    }
    p.then(give, () => none(404));
  }
  return { handle, stats: () => ({ ...S, kept: cache.size }) };
}

/** Only requests addressed to this PC by its loopback names are answered (a web page elsewhere cannot aim a made-up name at us). */
function hostAllowed(host) {
  if (typeof host !== 'string') return false;
  const name = host.trim().toLowerCase().replace(/:\d{1,5}$/, '');
  return name === '127.0.0.1' || name === 'localhost';
}

/** The file a request path maps to, or null when it is outside the folder or hidden. */
function resolveFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (rel.includes('\0')) return null;
  rel = rel.replace(/^[\\/]+/, '');
  if (rel === '') rel = 'control.html';
  const file = path.resolve(ROOT, rel);
  const inside = path.relative(ROOT, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || HIDDEN.test(inside)) return null;
  return file;
}

// V9 (the live overlay's frame): a page of this server inside a frame is only ever inside another page of this server
// (vtuber.html frames tracking/tracker.html). A web page that sends its frame here (a redirect, or the frame moving
// itself to http://127.0.0.1:<port>/...) is refused by the browser; avatar.html's own CSP (frame-src https:) refuses it too.
const FRAME_ANCESTORS = "frame-ancestors 'self'";
function handle(req, res, calibFile, api, headers, onMissing, pic, signDir) {
  if (!hostAllowed(req.headers.host)) { res.writeHead(403, NO_CACHE); res.end('Forbidden'); return; }
  if (api && api(req, res)) return;                    // the one-click app's own requests (one-click.js)
  if (pic && (req.url || '').split('?')[0] === '/api/pic') { pic.handle(req, res); return; }   // V8: a viewer's picture / a cover
  if ((req.url || '').split('?')[0] === '/api/calibration') { calibrationApi(req, res, calibFile || null); return; }
  { const p = (req.url || '').split('?')[0]; if (p === '/api/signs' || p.startsWith('/api/signs/')) { signsApi(req, res, signDir || null); return; } }   // V9: the host's own show signs
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, NO_CACHE); res.end(); return; }
  const file = resolveFile(req.url || '/');
  if (!file) { res.writeHead(404, NO_CACHE); res.end('Not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { if (onMissing) { try { onMissing((req.url || '').split('?')[0].slice(0, 200)); } catch { /* the hook's problem */ } } res.writeHead(404, NO_CACHE); res.end('Not found'); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const extra = headers ? headers(req) || {} : {};
    const own = /^text\/html/.test(type) ? { 'Content-Security-Policy': FRAME_ANCESTORS } : null;      // V9: no other site may frame these pages
    res.writeHead(200, { ...NO_CACHE, ...extra, ...own, 'Content-Type': type, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

/** Only pages served by this server (or local tools without an Origin) may join the relay. */
function originAllowed(origin) {
  if (!origin) return true;
  try { const u = new URL(origin); return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'; } catch { return false; }
}

/**
 * start(port, { calibFile, api, onRelay, upgrade, accept, headers }): calibFile overrides where the tracker's calibration
 * is kept (null = nowhere). The others are the one-click app's hooks (one-click.js): api(req, res) -> true when it
 * answered the request; onRelay(msg, who) sees every relayed message and who sent it; upgrade(req, socket, head) ->
 * true when it took a WebSocket that is not /ws; accept(req) -> who a joining page is, or null: that page still gets
 * every message but nothing it sends is taken (`who.only`, a Set: the only message kinds taken from it); headers(req)
 * -> extra headers for a file this server sends. The result also carries broadcast(obj): send a message to every page
 * (kept as the newest state when it is an `avatar` or `hands-line` message). onMissing(path): a page asked for a file
 * that is not there (inside LIVE Link the copy holds only the files on runtime-files.json: a miss must be seen).
 */
function start(port = PORT, opts = {}) {
  const calibFile = opts.calibFile !== undefined ? opts.calibFile : calibFileFor(port);
  const pic = createPicProxy({ fetch: opts.picFetch, hosts: opts.picHosts });
  const signDir = opts.signDir !== undefined ? opts.signDir : signDirFor(port);      // V9: where the host's own show signs are kept (null = nowhere)
  const server = http.createServer((req, res) => handle(req, res, calibFile, opts.api, opts.headers, opts.onMissing, pic, signDir));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  // The newest settings messages are replayed to a page that joins later (an OBS source that reloads mid-show).
  const sticky = new Map();
  const STICKY = new Set(['avatar', 'hands-line', 'v8-show']);   // (v8-show: LIVE Link's newest show state, for a page that loads again)
  const PRIVATE = new Set(['mask-event']);
  server.on('upgrade', (req, socket, head) => {
    const okPath = (req.url || '').split('?')[0] === '/ws';
    // ownOriginOnly (inside LIVE Link): a page served from another local port gets nothing at all; only this server's
    // own pages (the VTuber window, the avatar source in OBS) and local tools without an Origin may join
    const o = req.headers.origin, p = server.address() && server.address().port;
    const originOk = opts.ownOriginOnly ? (!o || o === 'http://127.0.0.1:' + p || o === 'http://localhost:' + p) : originAllowed(o);
    if (!originOk || !hostAllowed(req.headers.host)) { socket.destroy(); return; }
    if (!okPath) { if (!opts.upgrade || !opts.upgrade(req, socket, head)) socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    // who this page is (the one-click app takes messages only from its own pages; the v2 server takes them from all)
    let who = { kind: 'any' };
    if (opts.accept) { try { who = opts.accept(req); } catch { who = null; } }
    for (const text of sticky.values()) { try { ws.send(text); } catch { /* closing */ } }
    // ?bin=1: this page also wants the binary messages (the avatar page: the tracker's raw face results for the Mask)
    ws.wantsBin = /[?&]bin=1(?:&|$)/.test(req.url || '');
    // a page the app did not recognise (any other local page may still join and watch the old messages) never gets
    // what is private: viewer names and comments (`mask-event`) and the owner's face points (binary)
    ws.known = !!who;
    ws.on('message', (data, isBinary) => {
      if (!who) return;
      if (isBinary) {
        // a raw face result (js/mask-wire.js, about 6 kB): handed on as it is, only to the pages that asked for them
        if (who.only || data.length > 16384) return;
        if (opts.onRelay) { try { opts.onRelay({ t: 'bin' }, who); } catch { /* the hook's problem */ } }
        for (const other of wss.clients) {
          if (other !== ws && other.wantsBin && other.known && other.readyState === 1 && other.bufferedAmount < 262144) { try { other.send(data, { binary: true }); } catch { /* closing */ } }
        }
        return;
      }
      const text = data.toString();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if (who.only && !who.only.has(msg.t)) return;
      if (STICKY.has(msg.t)) sticky.set(msg.t, text);
      if (opts.onRelay) { try { opts.onRelay(msg, who); } catch { /* the hook's problem */ } }
      for (const other of wss.clients) {
        if (other !== ws && other.readyState === 1 && (other.known || !PRIVATE.has(msg.t))) { try { other.send(text); } catch { /* closing */ } }
      }
    });
    ws.on('error', () => { /* a page went away */ });
  });
  const broadcast = (obj) => {
    const text = JSON.stringify(obj);
    if (STICKY.has(obj.t)) sticky.set(obj.t, text);
    for (const c of wss.clients) { if (c.readyState === 1 && (c.known || !PRIVATE.has(obj.t))) { try { c.send(text); } catch { /* closing */ } } }
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve({ server, wss, port: server.address().port, broadcast, pic }));
  });
}

if (require.main === module) {
  start().then(({ port }) => {
    console.log('VTuber avatar server running (this PC only).');
    console.log(`  Control panel : http://${HOST}:${port}/control.html`);
    console.log(`  Tracker       : http://${HOST}:${port}/tracking/tracker.html`);
    console.log(`  OBS source 1  : http://${HOST}:${port}/avatar.html`);
    console.log(`  OBS source 2  : http://${HOST}:${port}/tracking/hands.html   (the hand line)`);
    console.log('Setup steps: README.md');
    console.log('Leave this window open during the show. Close it to stop.');
  }, err => {
    console.error(err && err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. The avatar server is probably already running.`
      : `Could not start: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { start, resolveFile, originAllowed, hostAllowed, calibFileFor, createPicProxy, sniffPicture, PIC, signDirFor, listSigns };
