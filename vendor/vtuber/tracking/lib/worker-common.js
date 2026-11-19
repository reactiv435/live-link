// Tracker v2: shared by the two model workers (worker-face.js, worker-body.js). Classic-worker script (importScripts).
// Loads MediaPipe tasks-vision from the vendored folder, makes tasks on the graphics card with a fall-back to the
// processor per task, and reports which one is really in use.
'use strict';

// MediaPipe prints harmless start-up notes through console.error / console.warn; keep real errors only.
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    const s = typeof a[0] === 'string' ? a[0] : '';
    if (/^(INFO:|W\d{4} |I\d{4} |Graph successfully started|OpenGL error checking is disabled|GL version:)/.test(s)) return;
    orig(...a);
  };
}

self.VTW = (() => {
  const here = (p) => new URL(p, self.location.href).href;
  const epoch = () => performance.timeOrigin + performance.now();
  let mp = null, fileset = null, version = '';

  /** ver: '0.10.21' (tracking/vendor/tasks-vision) or '1.2.3' (tracking/vendor/tasks-vision-1.2.3). */
  async function loadVision(ver) {
    const base = ver === '1.2.3' ? './vendor/tasks-vision-1.2.3' : './vendor/tasks-vision';
    mp = await import(here(base + '/vision_bundle.js'));
    fileset = await mp.FilesetResolver.forVisionTasks(here(base + '/wasm'));
    version = ver === '1.2.3' ? '1.2.3' : '0.10.21';
    return mp;
  }

  /** The graphics card WebGL really runs on in this worker ('' when it cannot be read). */
  function glRenderer() {
    try {
      const c = new OffscreenCanvas(1, 1);
      const gl = c.getContext('webgl2');
      if (!gl) return 'no WebGL2';
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      const name = e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : '';
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return name;
    } catch (e) { return ''; }
  }

  /**
   * kind: 'FaceLandmarker' | 'PoseLandmarker' | 'HandLandmarker'. want: 'GPU' | 'CPU'.
   * Returns { task, delegate, canvas, fellBack }. On the graphics card the task gets its own OffscreenCanvas, so a lost
   * WebGL context can be noticed (onLost).
   */
  async function makeTask(kind, model, options, want, onLost) {
    const build = async (delegate) => {
      const canvas = new OffscreenCanvas(1, 1);
      if (onLost) canvas.addEventListener('webglcontextlost', (ev) => { try { ev.preventDefault(); } catch (e) { /* ignore */ } onLost(); });
      const task = await mp[kind].createFromOptions(fileset, { baseOptions: { modelAssetPath: here(model), delegate }, canvas, runningMode: 'VIDEO', ...options });
      return { task, delegate, canvas, fellBack: false };
    };
    if (want === 'CPU') return build('CPU');
    try { return await build('GPU'); }
    catch (e) {
      const r = await build('CPU');
      r.fellBack = true; r.error = String(e && e.message ? e.message : e);
      return r;
    }
  }

  /**
   * The first inference of a new task compiles its shaders and can take seconds. Do it on a blank picture while the
   * task is still "loading", so the first real frame is not the slow one. Returns the next free timestamp.
   */
  function warmUp(task, ts) {
    try {
      const c = new OffscreenCanvas(256, 256);
      const g = c.getContext('2d');
      g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
      const bmp = c.transferToImageBitmap();
      for (let i = 0; i < 2; i++) task.detectForVideo(bmp, ++ts);
      bmp.close();
    } catch (e) { /* the real frames will show any real problem */ }
    return ts;
  }

  return { here, epoch, loadVision, glRenderer, makeTask, warmUp, get version() { return version; } };
})();
