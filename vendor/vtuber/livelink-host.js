// VTuber inside LIVE Link (V6): the entry LIVE Link starts as an Electron utility process (its own Node, no window,
// walled off from the TikTok feed, the tap crediting and the recorder). It runs the same app VTuber.bat runs
// (one-click.js), embedded: no Chrome, no share list, its files in LIVE Link's data folder.
//
// The parent talks to it with small messages (Electron: process.parentPort; a plain Node parent in tests: process.send):
//   parent -> host : { t: 'event', ev }      a TikTok event, already clipped by LIVE Link (checked and clipped again here)
//   parent -> host : { t: 'stop' }           LIVE Link is quitting, or the VTuber window was closed
//   host -> parent : { t: 'ready', port }    the local server listens (the page and OBS's avatar source load from it);
//                                            sent the moment it listens, BEFORE the OBS work: a slow first start (OBS, the
//                                            camera's window) shows as `state` messages, never as a missing "ready"
//   host -> parent : { t: 'state', ... }     on / off, OBS, camera, character, capture path (plain codes for the card)
//   host -> parent : { t: 'camera-window', hwnd, title } | { t: 'camera-window', none: true }   what the page may capture
//   host -> parent : { t: 'front' }          something asked for the VTuber window (LIVE Link raises it)
//   host -> parent : { t: 'log', line }      for LIVE Link's log (never viewer names, comments or the OBS password)
//   host -> parent : { t: 'failed', code }   it could not start: 'STANDALONE' (the desktop-shortcut VTuber is open),
//                                            'NO_PORT' (every place is taken), 'ERROR'
//   host -> parent : { t: 'stopped', why }   it ended (the avatar is OFF in OBS before this is sent)
// Settings come in one JSON value, VTUBER_HOST_CONFIG: { dataDir, ports?, obsUrl?, obsConfig?, test?, windowCapture?,
// soundCmd? }. obsUrl / obsConfig / ports / soundCmd / test are for test runs only (a pretend OBS on its own port).
'use strict';
const { bootEmbedded } = require('./one-click.js');

const parentPort = process.parentPort || null;           // Electron's utility process
const hasParent = !!parentPort || typeof process.send === 'function';
let readySent = false;
const send = (m) => {
  if (m && m.t === 'ready') { if (readySent) return; readySent = true; }
  try { if (parentPort) parentPort.postMessage(m); else if (process.send && process.connected) process.send(m); } catch { /* the parent is gone */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = {};
try { cfg = JSON.parse(process.env.VTUBER_HOST_CONFIG || '{}') || {}; } catch { cfg = {}; }

let vt = null, ending = false, booting = null;
/** OFF in OBS first (his camera shows), then the word to the parent, then the end */
async function end(why, code) {
  if (ending) return;
  ending = true;
  // asked to stop while the start is still at its OBS work ("ready" is out, the page may be open): wait for the start,
  // then stop it in order (never longer than 7 s; the avatar cannot be ON yet, ON waits behind that same work)
  if (!vt && booting) { try { vt = await Promise.race([booting, sleep(7000)]) || null; } catch { vt = null; } }
  try { if (vt) await Promise.race([vt.stop(why), sleep(7000)]); } catch { /* ending anyway */ }
  send({ t: 'stopped', why: String(why) });
  setTimeout(() => process.exit(code || 0), 60);
}
const crash = (err) => {
  send({ t: 'log', line: 'crashed: ' + String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ').slice(0, 400) });
  end('crashed', 1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
process.on('SIGTERM', () => end('stopped', 0));
process.on('SIGINT', () => end('stopped', 0));
if (!parentPort) process.on('disconnect', () => end('the parent is gone', 0));

const onMessage = (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'event') { if (vt && !ending) { try { vt.event(m.ev); } catch { /* one event lost, nothing else */ } } }
  else if (m.t === 'stop') end('LIVE Link closed the VTuber', 0);
};
if (parentPort) parentPort.on('message', (e) => onMessage(e && e.data));
else process.on('message', onMessage);

(async () => {
  if (!hasParent) { console.error('livelink-host.js is started by LIVE Link, not by hand. Use VTuber.bat.'); process.exit(2); }
  if (!cfg.dataDir || typeof cfg.dataDir !== 'string') { send({ t: 'failed', code: 'ERROR', detail: 'no data folder' }); process.exit(2); }
  try {
    booting = bootEmbedded({
      dataDir: cfg.dataDir,
      ports: Array.isArray(cfg.ports) ? cfg.ports : undefined,
      obsUrl: cfg.obsUrl || undefined, obsConfig: cfg.obsConfig || undefined,
      // a run that names a pretend OBS is a test (it never listens to the real PC and never adopts a window it did not open)
      test: cfg.obsUrl ? true : cfg.test === true ? true : false,
      windowCapture: cfg.windowCapture !== undefined ? !!cfg.windowCapture : undefined,
      soundCmd: Array.isArray(cfg.soundCmd) ? cfg.soundCmd.map(String) : undefined,
      onHost: send,
    });
    const started = await booting;
    if (!vt) vt = started;
  } catch (err) {
    if (ending) return;
    const code = err && (err.code === 'STANDALONE' || err.code === 'NO_PORT') ? err.code : 'ERROR';
    send({ t: 'failed', code, port: err && err.port, detail: code === 'ERROR' ? String((err && err.message) || err).slice(0, 300) : undefined });
    setTimeout(() => process.exit(code === 'ERROR' ? 1 : 0), 60);
    return;
  }
  if (ending) return;                                  // end() has the start in hand and stops it
  send({ t: 'ready', port: vt.port, test: vt.test });  // (already sent by the app itself when it began to listen)
  vt.done.then((why) => end(why || 'stopped by itself', 0));
})();
