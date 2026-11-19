// Hand tracking in its own thread, so it runs next to the face tracking instead of after it.
// Classic worker (MediaPipe's loader needs importScripts); the library itself is loaded with import().
let lm = null;

// MediaPipe prints harmless start-up notes through console.error / console.warn; keep real errors only.
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    const s = typeof a[0] === 'string' ? a[0] : '';
    if (/^(INFO:|W\d{4} |I\d{4} |Graph successfully started|OpenGL error checking is disabled|GL version:)/.test(s)) { console.debug(...a); return; }
    orig(...a);
  };
}

async function init(delegate) {
  const mp = await import('./vendor/tasks-vision/vision_bundle.js');
  const fileset = await mp.FilesetResolver.forVisionTasks(new URL('./vendor/tasks-vision/wasm', self.location.href).href);
  const make = (d) => mp.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('./vendor/models/hand_landmarker.task', self.location.href).href, delegate: d },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let used = delegate === 'CPU' ? 'CPU' : 'GPU';
  try { lm = await make(used); }
  catch (e) { if (used === 'CPU') throw e; used = 'CPU'; lm = await make('CPU'); }
  return used;
}

let lastTs = 0;
self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try { self.postMessage({ type: 'ready', delegate: await init(m.delegate) }); }
    catch (e) { self.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) }); }
    return;
  }
  if (m.type === 'frame') {
    let hands = [];
    const t = performance.now();
    try {
      if (!m.bmp && m.blob) m.bmp = await createImageBitmap(m.blob);
      if (lm) {
        const ts = Math.max(lastTs + 1, m.ts); // timestamps must always go up
        lastTs = ts;
        const res = lm.detectForVideo(m.bmp, ts);
        hands = (res.landmarks || []).map((h) => { const a = new Float32Array(h.length * 2); h.forEach((p, i) => { a[i * 2] = p.x; a[i * 2 + 1] = p.y; }); return a; });
      }
    } catch (e) {
      self.postMessage({ type: 'error', message: String(e && e.message ? e.message : e), frame: true });
    } finally {
      try { if (m.bmp) m.bmp.close(); } catch (e) { /* ignore */ }
    }
    self.postMessage({ type: 'result', hands, w: m.w, h: m.h, t0: m.t0, ms: performance.now() - t });
  }
};
