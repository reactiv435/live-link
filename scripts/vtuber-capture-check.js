'use strict';
// Proves the VTuber session's rules (src/core/vtuber-session.js) on real Electron, with its OWN two small test windows:
//   electron scripts/vtuber-capture-check.js --user-data-dir=<scratch folder> [--use-fake-device-for-media-stream]
// It opens a small "source" window (a moving colour pattern, NOT named like any OBS window) and a page on 127.0.0.1
// that asks to capture a window, exactly as the VTuber's tracker does. Checked:
//   1. the named window (by its exact window number) is handed over with no share list, its pictures arrive, and the
//      track is labelled with that window's number (the VTuber page checks the same label);
//   2. no window named = refused quickly (no hang, no list);  3. a window number that does not exist = refused;
//   4. the same request from another local address = refused;
//   5. a camera is refused; the microphone is allowed (use the fake-device switch so no real microphone is opened).
// It never looks at, captures or touches any other window. Prints one JSON line; exit code 0 = all as expected.
const { app, BrowserWindow, session, desktopCapturer, screen } = require('electron');
const http = require('http');
const path = require('path');
const { setupVtuberSession } = require('../src/core/vtuber-session');

const udd = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (!udd) { process.stderr.write('give it its own folder: --user-data-dir=<scratch folder>\n'); app.exit(2); }
else app.setPath('userData', path.resolve(udd.split('=')[1]));

const SOURCE_HTML = `<!doctype html><title>V6 capture check source</title><body style="margin:0;background:#000"><canvas id="c" width="320" height="180" style="width:100vw;height:100vh"></canvas><script>
const g = document.getElementById('c').getContext('2d'); let n = 0;
setInterval(() => { n++; g.fillStyle = 'rgb(' + (n * 9 % 256) + ',40,200)'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.fillRect((n * 7) % 300, 60, 20, 60); }, 33);
</script>`;
const PAGE_HTML = `<!doctype html><title>capture check page</title><body><script>
async function grab() {
  const t0 = performance.now();
  let stream = null;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { max: 30 } }, audio: false }); }
  catch (e) { return { ok: false, error: e.name, ms: Math.round(performance.now() - t0) }; }
  const track = stream.getVideoTracks()[0], v = document.createElement('video');
  v.muted = true; v.srcObject = stream; await v.play();
  const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
  const seen = new Set(); let frames = 0;
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    await new Promise((r) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(r) : setTimeout(r, 33)));
    frames++; c.width = 32; c.height = 18; g.drawImage(v, 0, 0, 32, 18);
    const p = g.getImageData(2, 2, 1, 1).data; seen.add(p[0] >> 3);
  }
  const out = { ok: true, label: track.label, frames, colours: seen.size, w: v.videoWidth, h: v.videoHeight, ms: Math.round(performance.now() - t0) };
  for (const t of stream.getTracks()) t.stop();
  return out;
}
async function media(c) { try { const s = await navigator.mediaDevices.getUserMedia(c); const n = s.getTracks().length; for (const t of s.getTracks()) t.stop(); return { ok: true, tracks: n }; } catch (e) { return { ok: false, error: e.name }; } }
</script>`;

app.whenReady().then(async () => {
  const R = { electron: process.versions.electron, problems: [] };
  const bad = (t) => R.problems.push(t);
  const serve = () => new Promise((resolve) => { const s = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const [own, other] = await Promise.all([serve(), serve()]);
  const a = screen.getPrimaryDisplay().workArea;
  const src = new BrowserWindow({ width: 340, height: 220, x: a.x + a.width - 350, y: a.y + a.height - 230, title: 'V6 capture check source', show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  src.on('page-title-updated', (e) => e.preventDefault());
  await src.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SOURCE_HTML));
  src.showInactive();
  const h = src.getNativeWindowHandle();
  const hwnd = process.platform === 'win32' ? h.readUInt32LE(0) : Number(src.getMediaSourceId().split(':')[1]);
  R.sourceId = src.getMediaSourceId(); R.hwnd = hwnd;
  let want = null;
  const ses = setupVtuberSession(session.fromPartition('vtuber-capture-check'), { desktopCapturer, port: () => own.address().port, cameraWindow: () => want, log: (l, t) => { (R.log = R.log || []).push(t); } });
  const page = new BrowserWindow({ width: 300, height: 200, x: a.x + a.width - 660, y: a.y + a.height - 210, show: false, focusable: false, skipTaskbar: true, title: 'V6 capture check page', webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const run = async (port, js) => { await page.loadURL('http://127.0.0.1:' + port + '/'); return Promise.race([page.webContents.executeJavaScript(js, true), new Promise((r) => setTimeout(() => r({ ok: false, error: 'HUNG (no answer in 12 s)' }), 12000))]); };
  await new Promise((r) => setTimeout(r, 800));

  want = { hwnd, title: 'V6 capture check source' };
  R.named = await run(own.address().port, 'grab()');
  if (!R.named.ok) bad('the named window was not handed over: ' + R.named.error);
  else {
    // Chrome labels the track with the window's number ('window:<n>:0'); Electron 44 labels it with the window's title.
    // Either way it must be THIS window (the VTuber page only compares the number when the label carries one).
    if (!String(R.named.label).startsWith('window:' + hwnd + ':') && R.named.label !== 'V6 capture check source') bad('the track is labelled ' + R.named.label + ': not the named window');
    if (R.named.frames < 20) bad('only ' + R.named.frames + ' pictures in 3 s');
    if (R.named.colours < 4) bad('the pictures do not change (' + R.named.colours + ' colours): not the moving source window');
  }
  want = null;
  R.none = await run(own.address().port, 'grab()');
  if (R.none.ok || /HUNG/.test(R.none.error)) bad('with no window named the request was not refused: ' + JSON.stringify(R.none));
  want = { hwnd: 4, title: 'V6 capture check source' };                 // a window number that is no window; the title alone must not match
  R.wrongNumber = await run(own.address().port, 'grab()');
  if (R.wrongNumber.ok || /HUNG/.test(R.wrongNumber.error)) bad('a wrong window number was not refused: ' + JSON.stringify(R.wrongNumber));
  want = { hwnd, title: 'V6 capture check source' };
  R.otherAddress = await run(other.address().port, 'grab()');
  if (R.otherAddress.ok || /HUNG/.test(R.otherAddress.error)) bad('another local address could capture the window: ' + JSON.stringify(R.otherAddress));
  R.camera = await run(own.address().port, 'media({ video: true })');
  if (R.camera.ok) bad('a camera was opened');
  R.cameraAndMic = await run(own.address().port, 'media({ video: true, audio: true })');
  if (R.cameraAndMic.ok) bad('a camera was opened together with the microphone');
  R.microphone = await run(own.address().port, 'media({ audio: true })');
  if (!R.microphone.ok) R.microphoneNote = 'the microphone was not opened here (' + R.microphone.error + '): expected without a (fake) microphone';
  R.micOtherAddress = await run(other.address().port, 'media({ audio: true })');
  if (R.micOtherAddress.ok) bad('another local address got the microphone');
  process.stdout.write(JSON.stringify(R) + '\n');
  try { page.destroy(); src.destroy(); } catch {}
  own.close(); other.close();
  app.exit(R.problems.length ? 1 : 0);
});
