// V9 SHOW SIGN + LIVE OVERLAY: what draws them (js/v9-sign.js has the rules).
//   VTSignLayer.createKeyer(canvas)   the chroma key on the graphics card (the avatar page AND the VTuber window's preview)
//   VTSignLayer.openSource(name, cb)  a sign file from this PC's own server as something the keyer can read: a looping,
//                                     muted video; a picture; an animated GIF (frame by frame when the browser can)
//   On avatar.html only (VTBoot is there): the layer itself.
//     * THE SIGN: its own small canvas over the Mask's picture (and over his real face while the Mask is see-through),
//       under the puppet show's 2D layer, never mirrored. It is only as big as the sign, so it costs next to nothing.
//     * THE LIVE OVERLAY: a sandboxed frame of his overlay page, in a box, scaled to fit.
//     * THE TOP SLOT: the sign slides away while a vote, the boss fight, album eating, the rank banner or the countdown
//       needs the top, and comes back 1.5 s after. His own hide always wins.
// OFF = NOTHING: until an `avatar` message carries `sign` or `overlay`, this file makes no element, no graphics context, no
// frame callback and no request. The Mask's own canvas and its drawing are never touched.
(function (root) {
  'use strict';
  const VS = root.VTSign, doc = root.document;
  if (!VS || !doc) return;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ------------------------------------------------------------------ the chroma key
  // BT.709, full range: Y, Cb, Cr. The key works on the two colour numbers only (how bright the green is does not matter much).
  const VERT = 'attribute vec2 p; uniform vec4 uCrop; varying vec2 uv; void main() { vec2 q = p * 0.5 + 0.5; uv = vec2(mix(uCrop.x, uCrop.z, q.x), mix(uCrop.y, uCrop.w, 1.0 - q.y)); gl_Position = vec4(p, 0.0, 1.0); }';
  const FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif',
    'varying vec2 uv; uniform sampler2D uT; uniform vec3 uKey; uniform vec2 uKd; uniform float uKm; uniform vec3 uP; uniform vec2 uPx; uniform vec3 uSpill;',
    'vec2 cc(vec3 c) { float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748); }',
    // how much of the key colour is in a pixel: 1 = the key itself, 0 = grey / white / black, under 0 = the opposite hue.
    // A colour that only shares a little with the key (gold, yellow next to green) is let off by how far off-hue it is.
    'float green(vec3 c) { vec2 q = cc(c); float g = dot(q, uKd); return (g - 0.5 * length(q - uKd * g)) / uKm; }',
    'float matte(vec3 c) { return clamp((uP.x - green(c)) / uP.y, 0.0, 1.0); }',
    'void main() {',
    '  vec4 s = texture2D(uT, uv);',
    '  float a = matte(s.rgb) * 2.0 + matte(texture2D(uT, uv + vec2(uPx.x, 0.0)).rgb) + matte(texture2D(uT, uv - vec2(uPx.x, 0.0)).rgb) + matte(texture2D(uT, uv + vec2(0.0, uPx.y)).rgb) + matte(texture2D(uT, uv - vec2(0.0, uPx.y)).rgb);',
    '  a = min(matte(s.rgb) * 1.5, a / 6.0);',                       // the edge is smoothed, and a pixel that is pure key never comes back
    '  a = a * a * (3.0 - 2.0 * a);',
    '  vec3 c = max(s.rgb - (1.0 - a) * uKey, 0.0);',               // what is left when the green behind a soft edge is taken out (premultiplied)
    '  vec2 q = cc(c); float g = dot(q, uKd); g = max(0.0, g - 0.5 * length(q - uKd * g));',   // the green tint still on it (gold and yellow are let off, as in the matte) ...
    '  c = max(c - uP.z * g * uSpill, 0.0);',                       // ... taken off without changing how bright it is
    '  c = min(c, vec3(a));',                                       // (never more light than there is picture: no glow is left where the green was)
    '  gl_FragColor = vec4(c * s.a, a * s.a);',
    '}'].join('\n');
  const hexRgb = (h) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || '')); return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 1, 0]; };
  const ccOf = (c) => { const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return [(c[2] - y) / 1.8556, (c[0] - y) / 1.5748]; };
  /** the numbers the shader takes for a key colour and the three sliders (pure; the tests read it) */
  function keyNumbers(o) {
    const key = hexRgb(o && o.key), q = ccOf(key), km = Math.max(0.06, Math.hypot(q[0], q[1])), kd = [q[0] / (Math.hypot(q[0], q[1]) || 1), q[1] / (Math.hypot(q[0], q[1]) || 1)];
    const strength = clamp(Number(o && o.strength) || 0, 0.05, 0.9), soft = clamp(Number(o && o.soft) || 0, 0.005, 0.5), spill = clamp(Number(o && o.spill) || 0, 0, 1);
    // strength: everything at least this green is gone (0.40 -> 60 % of the key colour and up). soft: the width of the
    // ramp from gone to solid, as a share of that (0.08 -> a narrow, clean edge; 0.5 -> a wide, soft one).
    const T = 1 - strength, S = Math.max(0.02, T * Math.min(1, soft * 2 + 0.25));
    // one unit of key chroma, as RGB (Cb, Cr -> R, G, B with Y = 0): what the spill step takes away
    const sp = [1.5748 * kd[1], -0.1873 * kd[0] - 0.4681 * kd[1], 1.8556 * kd[0]];
    return { key, kd, km, T, S, spill: spill * 1.0, sp };
  }
  /** the same key in plain numbers, for one colour [r, g, b] 0..1 -> { a, rgb } (premultiplied): the tests' reference of the shader (no edge smoothing) */
  function keyPixel(c, o) {
    const K = keyNumbers(o), green = (x) => { const q = ccOf(x), g = q[0] * K.kd[0] + q[1] * K.kd[1]; return (g - 0.5 * Math.hypot(q[0] - K.kd[0] * g, q[1] - K.kd[1] * g)) / K.km; };
    let a = clamp((K.T - green(c)) / K.S, 0, 1); a = a * a * (3 - 2 * a);
    let r = c.map((v, i) => Math.max(0, v - (1 - a) * K.key[i]));
    const q = ccOf(r), g0 = q[0] * K.kd[0] + q[1] * K.kd[1], g = Math.max(0, g0 - 0.5 * Math.hypot(q[0] - K.kd[0] * g0, q[1] - K.kd[1] * g0));
    r = r.map((v, i) => Math.min(a, Math.max(0, v - K.spill * g * K.sp[i])));
    return { a, rgb: r };
  }
  /**
   * createKeyer(canvas) -> { draw(source, w, h, opts), read(), lose(), ok }. One texture, one small program.
   *   draw: source = a video / picture / video frame (or null: draw the last one again), w x h = its size,
   *         opts = { key, strength, soft, spill, crop: [x0, y0, x1, y1] | null }. The canvas' own size is the caller's.
   *   read: the picture just drawn as RGBA bytes (the preview's "find the sign"); only right after draw().
   */
  function createKeyer(canvas) {
    const at = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
    let two = true, gl = null;
    try { gl = canvas.getContext('webgl2', at); } catch (e) { gl = null; }
    if (!gl) { two = false; try { gl = canvas.getContext('webgl', at); } catch (e) { gl = null; } }
    if (!gl) throw new Error('no graphics for the sign');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('sign shader: ' + String(gl.getShaderInfoLog(s)).slice(0, 200)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('sign shader: ' + String(gl.getProgramInfoLog(pr)).slice(0, 200));
    gl.useProgram(pr);
    const U = {}; for (const n of ['uT', 'uCrop', 'uKey', 'uKd', 'uKm', 'uP', 'uPx', 'uSpill']) U[n] = gl.getUniformLocation(pr, n);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1i(U.uT, 0); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.clearColor(0, 0, 0, 0);
    let have = false, mips = false, lost = false, kk = '', upW = 0, upH = 0, bad = false;
    const maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    const fits = (w, h) => w > 0 && h > 0 && w <= maxTex && h <= maxTex;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    function draw(source, w, h, o) {
      if (lost) return false;
      if (source) {
        if (!fits(w, h)) { bad = true; have = false; return false; }                   // bigger than this graphics card takes: never drawn
        // a new size is checked once (the error check waits for the graphics card; the same size again cannot fail this way)
        const check = w !== upW || h !== upH;
        if (check) gl.getError();
        let ok = true;
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch (e) { ok = false; }
        if (ok && check) { const e = gl.getError(); if (e && e !== gl.NO_ERROR) ok = false; }
        if (ok) { have = true; bad = false; upW = w; upH = h; } else if (check || !have) { have = false; bad = true; upW = upH = 0; return false; }
        // a file much bigger than its place on screen is shrunk through smaller copies (no shimmer); WebGL 2 only
        const want = two && w > canvas.width * 1.6;
        if (want) gl.generateMipmap(gl.TEXTURE_2D);
        if (want !== mips) { mips = want; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, want ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); }
      }
      if (!have) return false;
      const key = [o.key, o.strength, o.soft, o.spill].join('|');
      if (key !== kk) {
        kk = key; const K = keyNumbers(o);
        gl.uniform3f(U.uKey, K.key[0], K.key[1], K.key[2]); gl.uniform2f(U.uKd, K.kd[0], K.kd[1]); gl.uniform1f(U.uKm, K.km);
        gl.uniform3f(U.uP, K.T, K.S, K.spill); gl.uniform3f(U.uSpill, K.sp[0], K.sp[1], K.sp[2]);
      }
      const c = o.crop || [0, 0, 1, 1];
      gl.uniform4f(U.uCrop, c[0], c[1], c[2], c[3]); gl.uniform2f(U.uPx, 1 / Math.max(1, w), 1 / Math.max(1, h));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }
    function read() { const d = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, d); return d; }
    function lose() { try { const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch (e) { /* gone */ } }
    return { draw, read, lose, fits, maxTex, get ok() { return !lost; }, get bad() { return bad; }, webgl2: two };
  }

  // ------------------------------------------------------------------ a sign file as a picture source
  const fileUrl = (name) => '/api/signs/' + encodeURIComponent(name);
  /** plain words for a video the browser cannot play (the card shows them) */
  function videoProblem(v) {
    const code = v && v.error ? v.error.code : 0;
    if (code === 4 || code === 3) return 'This video cannot be played here: it is saved in a format this app does not know. Export it again as MP4 (H.264) or WebM and upload that.';
    if (code === 2) return 'The video could not be read from this PC. Upload it again.';
    return 'The video could not be played. Export it again as MP4 (H.264) or WebM and upload that.';
  }
  /**
   * openSource(name, { ready({ w, h, video, still }), error(text) }) -> { take(), w, h, video, el, pause(), play(), close() }
   * take(): what to give the keyer NOW, or null when the picture has not changed since the last take.
   */
  function openSource(name, cb) {
    const kind = VS.signKind(name), S = { w: 0, h: 0, video: kind === 'mp4' || kind === 'webm', el: null, closed: false, dirty: false, frame: null, still: false };
    const ready = () => { if (!S.closed && cb && cb.ready) cb.ready({ w: S.w, h: S.h, video: S.video, still: S.still }); };
    const fail = (text) => { if (!S.closed && cb && cb.error) cb.error(text); };
    if (!kind) { setTimeout(() => fail('This file is not a sign.'), 0); }
    else if (S.video) {
      const v = doc.createElement('video');
      v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true;
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      let told = false;
      const got = () => { if (told || !v.videoWidth) return; told = true; S.w = v.videoWidth; S.h = v.videoHeight; S.dirty = true; ready(); };
      v.addEventListener('loadeddata', got); v.addEventListener('canplay', got);
      v.addEventListener('error', () => fail(videoProblem(v)));
      // a new picture of the video: only then is it sent to the graphics card again (a 30 fps sign on a 60 fps page costs half)
      const onFrame = () => { if (S.closed) return; S.dirty = true; if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame); else S.always = true;
      v.src = fileUrl(name);
      const p = v.play(); if (p && p.catch) p.catch(() => { /* it starts when it can (muted videos may always play) */ });
      S.el = v;
    } else if (kind === 'gif' && typeof root.ImageDecoder === 'function') {
      // an animated GIF, frame by frame (a GIF as a plain picture would stand still on the graphics card)
      (async () => {
        try {
          const res = await fetch(fileUrl(name), { cache: 'no-store' }); if (!res.ok) throw new Error('gone');
          const dec = new root.ImageDecoder({ data: await res.arrayBuffer(), type: 'image/gif' });
          if (S.closed) { dec.close(); return; }
          S.dec = dec;
          await dec.tracks.ready; await dec.completed;
          if (S.closed) return;
          const n = Math.max(1, dec.tracks.selectedTrack ? dec.tracks.selectedTrack.frameCount : 1);
          let i = 0, first = true;
          const next = S.next = async () => {
            if (S.closed || S.rest) return;
            let r = null;
            try { r = await dec.decode({ frameIndex: i }); } catch (e) { r = null; }
            if (S.closed) { if (r) r.image.close(); return; }
            if (!r) { if (first) fail('This GIF could not be read. Save it again, or use a PNG or a video.'); return; }
            if (S.frame) S.frame.close();
            S.frame = r.image; S.w = r.image.displayWidth; S.h = r.image.displayHeight; S.dirty = true;
            if (first) { first = false; S.still = n < 2; ready(); }
            if (n < 2) return;
            i = (i + 1) % n;
            S.timer = setTimeout(next, clamp((r.image.duration || 100000) / 1000, 20, 2000));
          };
          next();
        } catch (e) { fail('This GIF could not be read. Save it again, or use a PNG or a video.'); }
      })();
    } else {
      const im = new Image();
      im.onload = () => { S.w = im.naturalWidth; S.h = im.naturalHeight; S.dirty = true; S.still = true; ready(); };
      im.onerror = () => fail('This picture could not be read. Save it again as PNG or JPG and upload that.');
      im.src = fileUrl(name);
      S.el = im;
    }
    return {
      get w() { return S.w; }, get h() { return S.h; }, video: S.video, get el() { return S.el; },
      take() {
        if (S.closed || !S.w) return null;
        if (S.video) { const v = S.el; if (v.readyState < 2 || !(S.dirty || S.always)) return null; S.dirty = false; return v; }
        if (!S.dirty) return null;
        S.dirty = false; return S.frame || S.el;
      },
      again() { S.dirty = true; },
      pause() { if (S.video && S.el && !S.el.paused) S.el.pause(); if (S.next && !S.rest) { S.rest = true; clearTimeout(S.timer); } },
      play() { if (S.video && S.el && S.el.paused) { const p = S.el.play(); if (p && p.catch) p.catch(() => {}); } if (S.rest) { S.rest = false; S.next(); } },
      close() {
        S.closed = true; clearTimeout(S.timer);
        if (S.frame) { try { S.frame.close(); } catch (e) { /* gone */ } S.frame = null; }
        if (S.dec) { try { S.dec.close(); } catch (e) { /* gone */ } }
        if (S.video && S.el) { try { S.el.pause(); S.el.removeAttribute('src'); S.el.load(); } catch (e) { /* gone */ } }
        S.el = null;
      },
    };
  }

  const api = root.VTSignLayer = { createKeyer, openSource, keyNumbers, keyPixel, fileUrl, videoProblem, VERT, FRAG };

  // ------------------------------------------------------------------ the layer on the avatar page
  const Boot = root.VTBoot, L = root.VTLogic;
  if (!Boot || !L || !doc.body) return;
  const KILL = new URLSearchParams(root.location.search).get('sign') === '0';      // avatar.html?sign=0: none of it
  const G = {
    a: null, sign: null, overlay: null, raf: 0, n: 0, tr: null, raw: null, gate: VS.createTriggerGate(), lastT: 0, lost: 0, retryAt: 0, goodAt: 0, namesTop: '',
    slotS: VS.createTopSlot(), slotH: VS.createTopSlot(),
    st: { sign: { state: 'off', why: '', error: '' }, overlay: { state: 'off', why: '' } }, ms: 0, msLog: null,
  };
  const scale = () => (root.innerWidth || VS.FRAME.w) / VS.FRAME.w;
  const hudEl = () => doc.getElementById('maskhud');
  const put = (el) => { const h = hudEl(); if (h && h.parentNode) h.parentNode.insertBefore(el, h); else doc.body.appendChild(el); };
  const wantSign = () => (!KILL && G.a && G.a.on && G.a.mask && G.a.sign ? G.a.sign : null);
  const wantOverlay = () => (!KILL && G.a && G.a.on && G.a.mask && G.a.overlay && VS.overlayUrl(G.a.overlay.url, root.location.host) ? G.a.overlay : null);

  /**
   * The viewer names go just under the sign while it is on screen in their lane, else back to their own place
   * (avatar.html's 7 %). Only a place this layer set is ever taken back, and it is set again if something moved them.
   * Camera mode (v9-int, `camMode` in the avatar message): the Mask's page puts them in one lane under his chin itself,
   * so this layer lets go of them (its place and its glide) until camera mode ends.
   */
  function moveNames(r) {
    const el = G.namesEl || (G.namesEl = doc.getElementById('maskNames')); if (!el) return;
    if (G.a && G.a.camMode === true) { if (G.namesTop !== null) { if (G.namesTop && el.style.top === G.namesTop) el.style.top = ''; el.style.transition = ''; G.namesTop = null; } return; }
    if (G.namesTop === null) G.namesTop = '';
    const y = r ? VS.namesTop(r) : null, v = y === null ? '' : Math.round(y * scale()) + 'px';
    if (!v) { if (G.namesTop) { if (el.style.top === G.namesTop) el.style.top = ''; G.namesTop = ''; } return; }
    if (el.style.top !== v) { el.style.transition = 'top .3s ease'; el.style.top = v; }
    G.namesTop = v;
  }
  function dropSign() {
    moveNames(null);
    const s = G.sign; G.sign = null; if (!s) return;
    try { s.src.close(); } catch (e) { /* gone */ }
    try { if (s.key) s.key.lose(); } catch (e) { /* gone */ }
    try { s.el.remove(); } catch (e) { /* gone */ }
  }
  function makeSign(cfg) {
    dropSign();
    const el = doc.createElement('canvas');
    el.id = 'signc';
    el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;display:none;pointer-events:none;z-index:3;will-change:transform,opacity;transform-origin:50% 0';
    put(el);
    const s = G.sign = { file: cfg.file, el, key: null, src: null, ready: false, error: '', rectKey: '', shownK: -1, drawn: false, paused: false };
    try { s.key = createKeyer(el); } catch (e) {
      if (G.lost) { dropSign(); G.lost++; G.retryAt = root.performance.now() + 1500; return; }       // (while being made again: one more try used)
      s.error = 'This PC could not start the graphics for the sign.';
    }
    s.src = openSource(cfg.file, {
      ready: () => { s.ready = true; s.rectKey = ''; },
      error: (text) => { s.error = text; },
    });
  }
  /** the sign's place and size on the page (only when something changed) */
  function placeSign(s, cfg) {
    const c = cfg.crop || [0, 0, 1, 1], aspect = (s.src.w * (c[2] - c[0])) / Math.max(1, s.src.h * (c[3] - c[1]));
    const k = scale(), key = [cfg.x, cfg.y, cfg.size, c.join(','), s.src.w, s.src.h, k].join('|');
    if (key === s.rectKey) return;
    s.rectKey = key;
    const r = VS.signRect(cfg, aspect), dpr = Math.min(2, root.devicePixelRatio || 1);
    s.el.style.left = (r.x * k) + 'px'; s.el.style.top = (r.y * k) + 'px'; s.el.style.width = (r.w * k) + 'px'; s.el.style.height = (r.h * k) + 'px';
    const w = Math.max(2, Math.round(r.w * k * dpr)), h = Math.max(2, Math.round(r.h * k * dpr));
    if (s.el.width !== w || s.el.height !== h) { s.el.width = w; s.el.height = h; s.src.again(); }
    s.rect = r; s.drawn = false;
  }

  function dropOverlay() { const h = G.overlay; G.overlay = null; if (!h) return; try { h.box.remove(); } catch (e) { /* gone */ } }
  function makeOverlay(cfg) {
    dropOverlay();
    const box = doc.createElement('div');
    box.id = 'overlaybox';
    box.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;display:none;overflow:hidden;pointer-events:none;z-index:3;background:transparent;will-change:opacity';
    const f = doc.createElement('iframe');
    // only what an overlay page needs: its scripts, and its own storage / connection (same-origin = ITS origin, not ours).
    // No forms, no pop-ups, no top navigation, no downloads; no address of this page is sent with the request.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'");
    f.setAttribute('scrolling', 'no'); f.setAttribute('tabindex', '-1'); f.setAttribute('aria-hidden', 'true'); f.setAttribute('title', 'live overlay');
    f.setAttribute('allowtransparency', 'true');
    f.style.cssText = 'position:absolute;left:0;top:0;border:0;background:transparent;transform-origin:0 0;pointer-events:none';
    const h = G.overlay = { url: cfg.url, box, f, loaded: false, rectKey: '', shownK: -1 };
    f.addEventListener('load', () => { h.loaded = true; });
    box.appendChild(f); put(box);
    f.src = cfg.url;
  }
  function placeOverlay(h, cfg) {
    const k = scale(), key = [cfg.x, cfg.y, cfg.w, cfg.h, cfg.zoom, k].join('|');
    if (key === h.rectKey) return;
    h.rectKey = key;
    const r = VS.overlayRect(cfg);
    h.box.style.left = (r.x * k) + 'px'; h.box.style.top = (r.y * k) + 'px'; h.box.style.width = (r.w * k) + 'px'; h.box.style.height = (r.h * k) + 'px';
    h.f.style.width = r.pw + 'px'; h.f.style.height = r.ph + 'px'; h.f.style.transform = 'scale(' + (r.zoom * k) + ')';
    h.rect = r;
  }

  /** the newest `avatar` state: make, change or remove the two layers */
  function apply() {
    const sg = wantSign(), hy = wantOverlay();
    if (!sg) { dropSign(); G.lost = 0; G.goodAt = 0; } else if ((!G.sign && !G.lost) || (G.sign && G.sign.file !== sg.file)) makeSign(sg);
    if (!hy) dropOverlay(); else if (!G.overlay || G.overlay.url !== hy.url) makeOverlay(hy);
    if (!sg) { G.st.sign = { state: 'off', why: '', error: '' }; G.slotS.reset(); }
    if (!hy) { G.st.overlay = { state: 'off', why: '' }; G.slotH.reset(); }
    if ((sg || hy) && !G.raf) { G.lastT = 0; G.raf = root.requestAnimationFrame(tick); }
  }
  /** what needs the top right now (looked at about 20 times a second) */
  function look() {
    let V = null, show = null;
    try { const P = root.VTMaskPage; V = P && typeof P.hud === 'function' ? P.hud() : null; } catch (e) { V = null; }
    try { const P = root.VTShowPage; show = P && typeof P.status === 'function' ? P.status() : null; } catch (e) { show = null; }
    G.raw = VS.triggers(V, show); G.tr = G.gate.pass(G.raw);
  }
  function tick(tms) {
    G.raf = 0;
    const sg = wantSign(), hy = wantOverlay();
    if (!sg && !hy) return;
    const b = root.performance.now(), t = tms / 1000;
    if (G.n++ % 3 === 0 || !G.tr) look();
    if (sg && !G.sign && G.lost && G.lost <= 5 && b > G.retryAt) makeSign(sg);
    else if (sg && !G.sign && G.lost > 5) G.st.sign = { state: 'error', why: '', error: 'The graphics card dropped the sign. Switch the sign off and on again.' };
    else if (sg && !G.sign) G.st.sign = { state: 'loading', why: '', error: '' };      // (made again in a moment: not an error yet)
    if (sg && G.sign) {
      const s = G.sign, r = G.slotS.step(t, { want: sg.show && !s.error && s.ready, busy: VS.anyOf(G.tr) });
      G.st.sign = { state: s.error ? 'error' : !s.ready ? 'loading' : r.state, why: r.why, error: s.error };
      if (s.ready && s.key && !s.error && !s.key.fits(s.src.w, s.src.h)) s.error = VS.pixelProblem(s.src.w, s.src.h, s.key.maxTex) || 'This sign is too big for the graphics card of this PC.';
      if (s.ready && s.key && !s.error) {
        placeSign(s, sg);
        const k = r.k;
        if (k > 0.002) {
          if (s.paused) { s.paused = false; s.src.play(); }
          const frame = s.src.take(), ck = sg.key + '|' + sg.strength + '|' + sg.soft + '|' + sg.spill + '|' + (sg.crop ? sg.crop.join(',') : '');
          if (ck !== s.cfgKey) { s.cfgKey = ck; s.drawn = false; }                    // a slider moved: a still picture is keyed again too
          if (frame || !s.drawn) {
            if (s.key.draw(frame, s.src.w, s.src.h, sg)) { s.drawn = true; if (G.lost && !G.goodAt) G.goodAt = b; if (G.lost && b - G.goodAt > 30000) { G.lost = 0; G.goodAt = 0; } }
            else if (!s.key.ok) { dropSign(); G.lost++; G.goodAt = 0; G.retryAt = b + 1500; }       // the graphics card dropped it: made again in a moment (five times at most)
            else if (s.key.bad) s.error = 'The graphics card of this PC could not take this sign (' + s.src.w + ' x ' + s.src.h + '). Export it at 1920 x 1080 or smaller and upload it again.';
          }
        } else if (sg.show === false && !s.paused) { s.paused = true; s.src.pause(); }      // hidden by him: the video rests (stepped aside: it keeps running, it is back in a moment)
        if (k !== s.shownK) {
          s.shownK = k;
          // it slides up and fades (never a pop): 40 picture px over the move
          s.el.style.display = k > 0.002 && s.drawn ? 'block' : 'none';
          s.el.style.opacity = String(Math.round(k * 1000) / 1000);
          s.el.style.transform = k >= 0.999 ? '' : 'translateY(' + (-(1 - k) * 40 * scale()).toFixed(2) + 'px) scale(' + (0.96 + 0.04 * k).toFixed(4) + ')';
        } else if (k > 0.002 && s.drawn && s.el.style.display === 'none') s.el.style.display = 'block';
        moveNames(k > 0.002 && s.drawn && G.sign === s ? s.rect : null);
      } else { if (s.el.style.display !== 'none') s.el.style.display = 'none'; moveNames(null); }
    }
    if (hy && G.overlay) {
      const h = G.overlay, r = G.slotH.step(t, { want: hy.show, busy: VS.anyOf(G.tr, ['countdown']) });
      G.st.overlay = { state: !h.loaded ? 'loading' : r.state, why: r.why };
      placeOverlay(h, hy);
      if (r.k !== h.shownK) { h.shownK = r.k; h.box.style.display = r.k > 0.002 ? 'block' : 'none'; h.box.style.opacity = String(Math.round(r.k * 1000) / 1000); }
    }
    const ms = root.performance.now() - b;
    G.ms += (ms - G.ms) * 0.05; if (G.msLog) G.msLog.push(ms);
    G.raf = root.requestAnimationFrame(tick);
  }

  // every message the page gets: this layer reads `avatar` first (it never changes or stops one), then the Mask's page
  // gets it exactly as before
  const prev = Boot.onAny;
  Boot.onAny = (m) => {
    if (m && m.t === 'avatar') { try { const a = L.readAvatarMessage(m); if (a) { G.a = a; apply(); } } catch (e) { /* the Mask goes on without the sign */ } }
    if (prev) prev(m);
  };
  root.addEventListener('resize', () => { if (G.sign) G.sign.rectKey = ''; if (G.overlay) G.overlay.rectKey = ''; });
  /** what the avatar page tells the VTuber window about the two (inside its answer, once a second); null = neither is on */
  api.status = () => (G.sign || G.overlay || (G.lost && wantSign()) ? { sign: G.st.sign, overlay: G.st.overlay, ms: Math.round(G.ms * 1000) / 1000 } : null);
  /**
   * clearTriggers(): let go of what the Mask's 2D layer says needs the top RIGHT NOW (vote, boss, album eating, rank;
   * not the countdown), until each of those ends; the sign comes back 1.5 s later. clearTriggers(false): count them all
   * again. Camera mode on v9-int freezes that layer (a vote banner up when it starts would keep the sign away for the
   * whole segment): it calls clearTriggers() when camera mode turns on and clearTriggers(false) when it turns off.
   */
  api.clearTriggers = (on) => { look(); G.gate.clear(G.raw, on); G.tr = G.gate.pass(G.raw); };
  api.debug = G;
  G.a = Boot.shown || Boot.initial || null;
  if (G.a) apply();
})(typeof globalThis !== 'undefined' ? globalThis : self);
