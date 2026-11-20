// VTuber avatar test server: static files + a WebSocket relay. Listens on 127.0.0.1 ONLY (never the network).
//   http://127.0.0.1:8791/control.html   the owner's control panel (Chrome / Edge)
//   http://127.0.0.1:8791/avatar.html    the OBS Browser Source
//   http://127.0.0.1:8791/tracking/tracker.html, .../tracking/hands.html   the tracker page and the hand-line source
//   ws://127.0.0.1:8791/ws               every JSON message is passed on to every OTHER connected page
//   http://127.0.0.1:8791/api/calibration   the tracker's saved face calibration (GET / PUT / DELETE; one small file on this PC)
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
};
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', Pragma: 'no-cache', Expires: '0' };
// never served: the server itself, git data, dependencies, scratch, and the folders that hold the owner's test footage
// and the review media (review/, tracking/review/, tracking/testdata/)
const HIDDEN = /^(?:\.git|node_modules|tmp|tools|review|tracking[\\/](?:review|testdata|tools))(?:[\\/]|$)|^(?:server\.js|start-vtuber\.bat|\.gitignore|gifts-owner\.json|vtuber-obs\.json|tracking[\\/](?:calib-saved|mask-rest)\.json)$/i;

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

function handle(req, res, calibFile, api, headers, onMissing) {
  if (!hostAllowed(req.headers.host)) { res.writeHead(403, NO_CACHE); res.end('Forbidden'); return; }
  if (api && api(req, res)) return;                    // the one-click app's own requests (one-click.js)
  if ((req.url || '').split('?')[0] === '/api/calibration') { calibrationApi(req, res, calibFile || null); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, NO_CACHE); res.end(); return; }
  const file = resolveFile(req.url || '/');
  if (!file) { res.writeHead(404, NO_CACHE); res.end('Not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { if (onMissing) { try { onMissing((req.url || '').split('?')[0].slice(0, 200)); } catch { /* the hook's problem */ } } res.writeHead(404, NO_CACHE); res.end('Not found'); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const extra = headers ? headers(req) || {} : {};
    res.writeHead(200, { ...NO_CACHE, ...extra, 'Content-Type': type, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff' });
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
  const server = http.createServer((req, res) => handle(req, res, calibFile, opts.api, opts.headers, opts.onMissing));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  // The newest settings messages are replayed to a page that joins later (an OBS source that reloads mid-show).
  const sticky = new Map();
  const STICKY = new Set(['avatar', 'hands-line']);
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
    server.listen(port, HOST, () => resolve({ server, wss, port: server.address().port, broadcast }));
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

module.exports = { start, resolveFile, originAllowed, hostAllowed, calibFileFor };
