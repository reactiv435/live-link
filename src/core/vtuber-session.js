'use strict';
// 2.2.0: what the VTuber's page is allowed to do. The page (vendor/vtuber/vtuber.html, served on 127.0.0.1 by the
// VTuber's own process) opens in a LIVE Link window with its own browser session; this file sets that session's rules.
// It says yes to exactly two things, and only for that one local address:
//   - the microphone (the character's mouth follows the host's voice); a camera is NEVER opened,
//   - capturing ONE window: the window the VTuber named (OBS's small window of the host's camera), found by its exact
//     window number. There is no share list, no "closest match" and no screen. No such window = the request is
//     refused, and the page reads the camera the slower way by itself.
// Everything else (notifications, location, other origins, ...) is refused.
// With `ownOnly` (the app sets it) the session also cancels every network request that is not to that one local
// address: the VTuber's pages load nothing from anywhere else today, and this keeps it that way.
// Electron objects come in as arguments, so the same rules run in the app and in scripts/vtuber-capture-check.js.
const { pickCameraSource } = require('./vtuber-host');

/** is this address the VTuber's own page? (http://127.0.0.1:<the VTuber's place>/...) */
function ownUrl(url, port) {
  try { const u = new URL(url); return Number(port) > 0 && u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === Number(port); } catch { return false; }
}

/** may the VTuber window's session ask for this address? Its own place (pages, files, the relay), and nothing on any network */
function requestAllowed(url, port) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:'].includes(u.protocol)) return (u.protocol === 'http:' || u.protocol === 'ws:') && u.hostname === '127.0.0.1' && Number(port) > 0 && Number(u.port) === Number(port);
  return true;   // data:, blob:, devtools: and the like never leave this computer
}

/**
 * setupVtuberSession(ses, { desktopCapturer, port: () => number, cameraWindow: () => ({ hwnd, title } | null), log })
 * Returns the session. Safe to call once per session.
 */
function setupVtuberSession(ses, { desktopCapturer, port, cameraWindow, log = () => {}, ownOnly = false }) {
  const own = (url) => ownUrl(url, port());
  if (ownOnly && ses.webRequest) {
    let told = 0;
    ses.webRequest.onBeforeRequest((d, cb) => {
      const ok = requestAllowed(d && d.url, port());
      if (!ok && told++ < 5) log('warn', 'VTuber: a request to somewhere else was stopped');   // (the address is not logged)
      cb({ cancel: !ok });
    });
  }
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const d = details || {};
    if (!own(d.requestingUrl || (wc && wc.getURL()) || '')) return cb(false);
    if (permission === 'media') return cb(!(d.mediaTypes || []).includes('video'));   // the microphone, never a camera
    cb(permission === 'display-capture');
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    const d = details || {};
    if (!own(origin || d.requestingUrl || '')) return false;
    if (permission === 'media') return d.mediaType !== 'video';
    return permission === 'display-capture';
  });
  ses.setDisplayMediaRequestHandler((req, cb) => {
    const no = () => { try { cb({}); } catch { try { cb(null); } catch {} } };   // refused: the page goes the slower way by itself
    const want = cameraWindow();
    if (!want || !own((req && req.securityOrigin) || '')) return no();
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).then((list) => {
      const src = pickCameraSource(list, cameraWindow());
      if (!src) { log('info', 'VTuber: the camera window is not among the windows that can be captured: the slower way'); return no(); }
      try { cb({ video: src }); } catch { no(); }
    }, no);
  }, { useSystemPicker: false });
  return ses;
}

module.exports = { setupVtuberSession, ownUrl, requestAllowed };
