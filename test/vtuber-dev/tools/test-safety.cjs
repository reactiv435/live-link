// TEST SAFETY (fix round, Nov 19 2026). The owner's own VTuber, OBS and OBS camera window ("Projector - Source: DroidCam
// OBS 2") may be open on this PC while a test runs. A test must never adopt, capture, size or close them.
//   - TEST_CAMERAS: the pretend OBS names its cameras "TEST DroidCam OBS" / "TEST DroidCam OBS 2", so neither the app's
//     exact-title match nor Chrome's "title contains" pick can land on a real camera window.
//   - foreignProjectors / assertNoForeignProjector: a tool that opens real windows refuses to start while any
//     "Projector - Source:" window is open that it did not open itself.
//   - freePort: a port nobody holds (never 8791 / 4455), instead of a fixed number another run may hold.
'use strict';
const net = require('net');

const TEST_CAMERAS = ['TEST DroidCam OBS', 'TEST DroidCam OBS 2'];
const REAL_NEEDLE = 'Projector - Source:';
const NEVER_PORTS = new Set([8791, 4455]);

/** the windows that look like an OBS camera window and are not in `own` (titles this run opened itself) */
function foreignProjectors(list, own = []) {
  const mine = new Set(own);
  return (list || []).filter((w) => w && typeof w.title === 'string' && w.title.includes(REAL_NEEDLE) && !mine.has(w.title));
}
/** throws when a camera window this run did not open is on screen; `listWindows` = win-windows.js's (or a stand-in) */
async function assertNoForeignProjector(listWindows, own = []) {
  const list = await listWindows();
  const bad = foreignProjectors(list, own);
  if (bad.length) {
    const e = new Error('REFUSED: an OBS camera window that this test did not open is on screen (' + bad.map((w) => '"' + w.title + '"').join(', ') +
      '). It is the owner\'s. A test that opens real windows does not start while it is there. Use a virtual camera window (startMock({ projector: \'virtual\' })) instead.');
    e.code = 'FOREIGN_PROJECTOR';
    throw e;
  }
  return list;
}
/** camera names a pretend OBS may use together with REAL windows: never the bare names an OBS on this PC could use */
function assertTestCameraNames(names) {
  for (const n of names) if (!/^TEST /.test(String(n))) { const e = new Error('REFUSED: a pretend OBS that opens real windows must name its cameras "TEST ...": ' + n); e.code = 'REAL_CAMERA_NAME'; throw e; }
}
/** a free port on 127.0.0.1 (never the show's 8791, never OBS's 4455) */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => (NEVER_PORTS.has(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
/** n different free ports */
async function freePorts(n) {
  const out = new Set();
  while (out.size < n) out.add(await freePort());
  return [...out];
}
/** for test files written with fixed numbers: P(4489) -> the same free port every time in this run */
function portMap() {
  const pool = [], map = new Map();
  const P = (slot) => { if (!map.has(slot)) { if (!pool.length) throw new Error('portMap: call await P.fill() first (or raise its count)'); map.set(slot, pool.pop()); } return map.get(slot); };
  P.fill = async (n = 64) => { pool.push(...await freePorts(n)); };
  return P;
}

module.exports = { TEST_CAMERAS, REAL_NEEDLE, foreignProjectors, assertNoForeignProjector, assertTestCameraNames, freePort, freePorts, portMap };
