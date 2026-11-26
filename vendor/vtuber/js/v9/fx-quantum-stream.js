// V9 CABLES, the hand effect of QUANTUM FLOW: a wide RIVER of liquid energy between and around his hands, and his
// hands as slender obsidian. Round 7: both are BLENDER-MADE and played / posed live.
//   THE STREAM is three loops rendered offline (tools/v9/blender_bake_stream.py -> mask/v9/cables-stream-river.webp, -sphere,
//     -burst; red = the look's first colour, green = its second, blue = white-hot, so the look tints them):
//     hands apart = the river laid along the path between them (it runs past each hand and winds round it);
//     together = the coiled sphere; a fist = the sphere pulled tight into the orb; a palm push / a drop / a big gift =
//     the splash, played once; hands down = it drains into the cables; no hands = it floats in front of the chest.
//     The music: the bass swells it, every kick runs a bright wave along it, the level drives how fast it flows.
//     WHERE it goes is js/v9/stream-sprite.js (numbers, tested in Node); WHAT the stream does is js/v9/quantum-stream.js.
//   THE HANDS are one modelled hand (tools/v9/blender_build_hand.py -> mask/v9/cables-hand.bin), skinned to the 21 tracked
//     points WITH their depth (js/v9/hand-skin.js), mirrored for the left, drawn with depth and lit as black gloss.
//   On top, drawn live as before: the wisps that wind up each finger, the strand a pinch pulls, the orb's ring, tongues,
//     forked lightning, droplets with bright rims, sparks.
// Until the pictures and the model have come (or where there is no page: the tests), a plain drawn river and the drawn
// obsidian hand of round 6 stand in.
// The colours come from the cable look that is on (window.VTCableLink.look, js/v9/mask-cables.js).
(function (root) {
  'use strict';
  const TAU = Math.PI * 2, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const DEF = { a: [0.36, 0.09, 1.65], b: [1.75, 0.95, 0.10] };
  const HERE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/js\/v9\/[^/]*$/, 'mask/v9/') : 'mask/v9/';
  const VS_RB = `#version 300 es
  layout(location=0) in vec4 aP; layout(location=1) in vec4 aC; uniform vec2 uS; out vec4 vC; out vec2 vU;
  void main() { gl_Position = vec4(aP.x * uS.x, aP.y, 0.0, 1.0); vC = aC; vU = aP.zw; }`;
  // a ribbon of liquid light: a soft body, a hot thread down its middle, a bright edge (a tube of liquid), uneven along its length
  const FS_RB = `#version 300 es
  precision highp float; in vec4 vC; in vec2 vU; out vec4 o; uniform float uTime;
  void main() {
    float u = abs(vU.x), w = 0.70 + 0.30 * sin(vU.y * 23.0 - uTime * 5.0) * sin(vU.y * 7.3 + uTime * 1.7);
    float a = exp(-u * u * 5.0) * 0.42 * w + 1.30 * exp(-u * u * 90.0) + 0.42 * exp(-pow((u - 0.66 * w) / 0.09, 2.0));
    a *= 1.0 - smoothstep(0.82, 1.0, u);
    o = vec4(vC.rgb * (vC.a * a), 1.0);
  }`;
  const VS_PT = `#version 300 es
  layout(location=0) in vec4 aP; layout(location=1) in vec4 aC; uniform vec2 uS; out vec4 vC; out float vK;
  void main() { gl_Position = vec4(aP.x * uS.x, aP.y, 0.0, 1.0); gl_PointSize = clamp(aP.z * uS.y, 1.0, 900.0); vC = aC; vK = aP.w; }`;
  const FS_PT = `#version 300 es
  precision highp float; in vec4 vC; in float vK; out vec4 o;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard; float r = sqrt(r2), a;
    if (vK < 0.5) a = exp(-r2 * 4.5) * (1.0 - r2);                                           // a soft dot
    else if (vK < 1.5) a = exp(-r2 * 26.0) * 1.4 + 0.75 * (exp(-abs(p.x) * 30.0) * exp(-abs(p.y) * 4.0) + exp(-abs(p.y) * 30.0) * exp(-abs(p.x) * 4.0)) * (1.0 - r2);      // a star
    else if (vK < 2.5) { float d = 1.0 - r; a = d * d * d; }                                 // a wide glow
    else a = 1.5 * exp(-pow((r - 0.80) / 0.085, 2.0)) * (0.55 + 0.45 * p.y) + 0.10 * (1.0 - smoothstep(0.7, 0.85, r)) + 1.6 * exp(-dot(p - vec2(-0.32, -0.36), p - vec2(-0.32, -0.36)) * 40.0);      // a droplet: a bright rim, a glint
    o = vec4(vC.rgb * (vC.a * a), 1.0);
  }`;
  // ---------------------------------------------------------------- the baked loops: one picture of a sheet, tinted, added
  const VS_SP = `#version 300 es
  layout(location=0) in vec4 aP; uniform vec2 uS; out vec2 vU;
  void main() { gl_Position = vec4(aP.x * uS.x, aP.y, 0.0, 1.0); vU = aP.zw; }`;
  const FS_SP = `#version 300 es
  precision highp float; in vec2 vU; out vec4 o;
  uniform sampler2D uTex; uniform vec2 uGrid, uInset, uUR; uniform vec3 uF, uColA, uColB, uGain; uniform vec4 uWave[3]; uniform float uK, uEnds, uFlip, uCurve, uHot;
  vec3 tile(float f, vec2 q) { float c = mod(f, uGrid.x), r = floor(f / uGrid.x + 1e-3); return texture(uTex, (vec2(c, r) + clamp(q, uInset, 1.0 - uInset)) / uGrid).rgb; }
  void main() {
    vec2 q = vec2(mix(uUR.x, uUR.y, vU.x), 0.5 - 0.5 * vU.y * uFlip);
    vec3 s = mix(tile(uF.x, q), tile(uF.y, q), uF.z);
    s = pow(s, vec3(uCurve));                                                     // (harder: the dim haze between the filaments goes, the filaments stay)
    float ends = mix(1.0, smoothstep(0.0, 0.20, vU.x) * smoothstep(1.0, 0.80, vU.x) * (1.0 - smoothstep(0.70, 0.97, abs(vU.y))), uEnds), wv = 0.0;      // (the river runs out softly: no edge of its picture is ever seen)
    for (int i = 0; i < 3; i++) { float d = (vU.x - uWave[i].x) / 0.085; wv += uWave[i].y * exp(-d * d); }      // a kick: a bright wave runs along it
    wv *= uEnds;
    vec3 c = uColA * (s.r * uGain.x) + uColB * (s.g * uGain.y) + vec3(1.0, 0.94, 1.0) * (s.b * uGain.z);
    c += vec3(1.0, 0.42, 0.95) * (s.r * s.r * uGain.x * 0.85) + vec3(1.0, 0.85, 0.55) * (s.g * s.g * uGain.y * 0.45);      // where the liquid is dense it runs hot: magenta-white, pale gold
    c *= 1.0 + 1.3 * wv; c += vec3(1.0, 0.93, 1.0) * ((s.b * 1.8 + (s.r + s.g) * 0.40) * wv);
    c += vec3(1.0, 0.95, 1.0) * (s.r + s.g + s.b) * uHot * 0.5;                    // the orb: white-hot
    o = vec4(c * (ends * uK), 1.0);
  }`;
  // ---------------------------------------------------------------- the modelled hand: skinned on the graphics card, black gloss
  const VS_HM = `#version 300 es
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec4 aBone; layout(location=3) in vec4 aW;
  uniform mat4 uB[21]; uniform float uSide, uZk; uniform vec2 uS; out vec3 vP, vN, vR; out float vAo;
  void main() {
    vec3 p = vec3(aPos.x * uSide, aPos.yz), n = vec3(aNrm.x * uSide, aNrm.yz);
    mat4 M = uB[int(aBone.x + 0.5)] * aW.x + uB[int(aBone.y + 0.5)] * aW.y + uB[int(aBone.z + 0.5)] * aW.z;
    vec4 w = M * vec4(p, 1.0); vP = w.xyz; vN = mat3(M) * n; vR = aPos; vAo = aBone.w / 255.0;
    gl_Position = vec4(w.x * uS.x, w.y, clamp(-w.z * uZk, -0.98, 0.98), 1.0);
  }`;
  const FS_HM = `#version 300 es
  precision highp float; in vec3 vP, vN, vR; in float vAo; out vec4 o;
  uniform vec3 uColA, uColB, uStream; uniform float uK, uL, uTime, uHot;
  void main() {
    vec3 N = normalize(vN); if (N.z < 0.0) N = normalize(vec3(N.xy, -N.z * 0.35));      // (a normal that the stretch turned away: it still faces us)
    vec3 V = vec3(0.0, 0.0, 1.0), R = reflect(-V, N);
    float nv = clamp(N.z, 0.0, 1.0), ao = 0.35 + 0.65 * vAo;
    // the room it mirrors: a long soft light above (the streak down the back of every finger), the look's first
    // colour from the picture's left, its second from the right, and the stream itself
    float top = smoothstep(0.50, 0.86, R.y) * smoothstep(-0.25, 0.45, R.z);
    float la = max(dot(R, normalize(vec3(-0.84, 0.18, 0.40))), 0.0), lb = max(dot(R, normalize(vec3(0.84, 0.22, 0.40))), 0.0);
    vec3 toS = vec3(uStream.xy - vP.xy, 0.30 * uL); float ds = length(toS.xy) / max(uL, 1e-4); vec3 Ls = normalize(toS);
    float hs = max(dot(N, normalize(Ls + V)), 0.0), dif = max(dot(N, Ls), 0.0), att = 1.0 / (1.0 + 0.22 * ds * ds), en = uStream.z;
    vec3 sc = mix(uColA, uColB, 0.5 + 0.5 * sin(uTime * 0.7 + vP.x * 3.0));
    vec3 c = vec3(0.0008, 0.0006, 0.0012);
    c += vec3(0.80, 0.84, 1.0) * top * 0.022;
    c += uColA * (pow(la, 40.0) * 0.16) + uColB * (pow(lb, 40.0) * 0.14);
    c += vec3(1.0, 0.96, 1.0) * (pow(la, 70.0) + pow(lb, 70.0) + pow(max(dot(R, normalize(vec3(0.10, 0.62, 0.78))), 0.0), 90.0)) * 1.15;      // sharp white glints
    c += mix(sc, vec3(1.0), 0.25) * (pow(hs, 60.0) * 0.8 + 0.004 * dif) * att * en * (0.6 + 0.6 * uHot);                                    // the stream lights what faces it
    c += mix(uColA, uColB, smoothstep(-0.35, 0.35, N.x)) * pow(1.0 - nv, 5.0) * (0.55 + 0.75 * en * att);      // a THIN bright rim: the silhouette is drawn by the light behind it                                 // the rim
    c *= ao;
    float arm = smoothstep(-0.58, -0.04, vR.y);                                   // the forearm runs out into the dark
    o = vec4(c * (arm * uK), arm * uK);
  }`;
  // The drawn hand of round 6 (stands in until the model has come): the hands layer's 21 points as a solid, round, glossy thing.
  const FS_HD = `#version 300 es
  precision highp float; in vec2 vP; out vec4 o;
  uniform vec2 uPt[21]; uniform float uL, uK, uTime, uHot; uniform vec3 uRim, uGlow, uFill;
  float seg(vec2 p, vec2 a, vec2 b, float ra, float rb) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0); return length(pa - ba * h) - mix(ra, rb, h); }
  float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
  float sd(vec2 p) {
    float L = uL, d = 1e3, k = 0.022 * L;
    for (int f = 0; f < 5; f++) {
      int b = 1 + f * 4;
      float r0 = (f == 0 ? 0.105 : f == 4 ? 0.074 : 0.086) * L, r1 = r0 * 0.88, r2 = r0 * 0.76, r3 = r0 * 0.58;
      float df = min(min(seg(p, uPt[b], uPt[b + 1], r0, r1), seg(p, uPt[b + 1], uPt[b + 2], r1, r2)), seg(p, uPt[b + 2], uPt[b + 3], r2, r3));
      d = smin(d, df, k);
    }
    float pr = 0.180 * L;
    float dp = min(min(seg(p, uPt[0], uPt[5], pr * 0.95, pr * 0.72), seg(p, uPt[0], uPt[9], pr, pr * 0.72)), min(seg(p, uPt[0], uPt[13], pr, pr * 0.70), seg(p, uPt[0], uPt[17], pr * 0.95, pr * 0.62)));
    dp = min(dp, min(seg(p, uPt[5], uPt[17], pr * 0.62, pr * 0.55), seg(p, uPt[1], uPt[5], pr * 0.8, pr * 0.6)));
    return smin(d, dp, k * 2.2);
  }
  void main() {
    float L = uL, e = 0.012 * L, d = sd(vP), q = d / L;
    if (q > 0.02) discard;
    vec2 g = vec2(sd(vP + vec2(e, 0.0)) - d, sd(vP + vec2(0.0, e)) - d) / e;
    float t = clamp(-q / 0.090, 0.0, 1.0), z = sqrt(t * (2.0 - t));
    vec3 N = normalize(vec3(g * (1.0 - t) * 1.25, z + 0.10)), V = vec3(0.0, 0.0, 1.0);
    float ha = max(dot(N, normalize(normalize(vec3(-0.75, 0.35, 0.55)) + V)), 0.0), hb = max(dot(N, normalize(normalize(vec3(0.75, 0.30, 0.55)) + V)), 0.0), fr = pow(1.0 - N.z, 2.4);
    vec3 c = vec3(1.0, 0.97, 1.0) * (pow(ha, 110.0) + pow(hb, 110.0)) + uRim * pow(ha, 36.0) * 0.16 + uGlow * pow(hb, 36.0) * 0.10 + mix(uRim, uGlow, 0.35 * smoothstep(-0.4, 0.4, g.x)) * fr * 0.14;
    float inside = 1.0 - smoothstep(-0.012, 0.006, q);
    o = vec4(c * 0.85 * inside * uK, inside * 0.985 * uK);
  }`;

  // ---- what Blender made: the three sheets and the hand. Fetched once per page, by whoever asks first (the effect's
  // first frame, or a page that wants them before its first frame: VTQuantumFlowAssets.preload(), a promise).
  const FILES = { asked: null, meta: null, images: {}, hand: null, failed: '' };
  function preload() {
    if (FILES.asked) return FILES.asked;
    if (typeof fetch !== 'function' || typeof Image === 'undefined') return (FILES.asked = Promise.resolve(FILES));      // (no page: the drawn stand-ins)
    const fail = (e) => { FILES.failed = String(e && e.message ? e.message : e); };
    const picture = (name, m) => new Promise((res) => { const im = new Image(); im.onload = () => { FILES.images[name] = im; res(); }; im.onerror = () => { fail(new Error(m.file + ' missing')); res(); }; im.src = HERE + m.file; });
    const a = fetch(HERE + 'cables-stream.json').then((r) => { if (!r.ok) throw new Error('cables-stream.json ' + r.status); return r.json(); })
      .then((meta) => { FILES.meta = meta; return Promise.all(['river', 'sphere', 'burst'].filter((n) => meta[n]).map((n) => picture(n, meta[n]))); }).catch(fail);
    const b = Promise.all([fetch(HERE + 'cables-hand.json').then((r) => { if (!r.ok) throw new Error('cables-hand.json ' + r.status); return r.json(); }), fetch(HERE + 'cables-hand.bin').then((r) => { if (!r.ok) throw new Error('cables-hand.bin ' + r.status); return r.arrayBuffer(); })])
      .then(([meta, buf]) => { FILES.hand = { meta, buf }; }).catch(fail);
    return (FILES.asked = Promise.all([a, b]).then(() => FILES));
  }
  root.VTQuantumFlowAssets = { preload, files: FILES };

  function make({ rnd, A, G }) {
    const gl = G.gl, QS = root.VTQuantumStream, SPR = root.VTStreamSprite, SKIN = root.VTHandSkin;
    if (!QS) throw new Error('fx-quantum-stream: js/v9/quantum-stream.js must be loaded first');
    const qs = QS.create(), sp = SPR ? SPR.create() : null;
    const MAXV = 30000, MAXP = 3000, SN = SPR ? Math.max(SPR.N, 64) : 64;
    const rb = [new Float32Array(MAXV * 8), new Float32Array(MAXV * 8)], pt = [new Float32Array(MAXP * 8), new Float32Array(MAXP * 8)], nv = [0, 0], np = [0, 0];
    const sv = new Float32Array((SN * 2 + 6) * 4), waveU = new Float32Array(12);
    let gpu = null, o = null, lay = null, tNow = 0, dtNow = 1 / 30;
    const palette = { rim: DEF.a.slice(), glow: DEF.b.slice(), fill: [0, 0, 0] };
    const bolts = [], tongues = []; let boltAt = -9, tongueAcc = 0;
    const cur = { ca: DEF.a, cb: DEF.b, K: 0, bright: 0, held: 0, mx: 0, my: 0, en: 0, hot: 0 };
    // ---- this Mask's own copies on the graphics card (made when the files have come; nothing waits for them)
    const AS = { sheets: {}, hand: null, get failed() { return FILES.failed; } };
    function ask() {
      preload();
      for (const name in FILES.images) {
        if (AS.sheets[name]) continue;
        const im = FILES.images[name], m = FILES.meta[name];
        try {
          const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, im);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, 2.0);
          AS.sheets[name] = { tex, cols: m.cols, rows: m.rows, frames: m.frames, loop: m.loop !== false, inset: [1.5 / m.w, 1.5 / m.h] };
        } catch (e) { FILES.failed = String(e && e.message ? e.message : e); AS.sheets[name] = null; delete FILES.images[name]; }
      }
      if (!AS.hand && FILES.hand && SKIN) { try { AS.hand = { meta: FILES.hand.meta, buf: FILES.hand.buf, skin: SKIN.create(FILES.hand.meta), mesh: null, tr: new Map() }; } catch (e) { FILES.failed = String(e && e.message ? e.message : e); FILES.hand = null; } }
    }
    function init() {
      if (gpu) return gpu;
      const pRb = G.program(VS_RB, FS_RB), pPt = G.program(VS_PT, FS_PT), pSp = G.program(VS_SP, FS_SP);
      const mk = (bytes) => { const vao = gl.createVertexArray(), buf = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16); return { vao, buf }; };
      const svao = gl.createVertexArray(), sbuf = gl.createBuffer(); gl.bindVertexArray(svao); gl.bindBuffer(gl.ARRAY_BUFFER, sbuf); gl.bufferData(gl.ARRAY_BUFFER, sv.byteLength, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gpu = { pRb, pPt, pSp, rb: mk(MAXV * 32), pt: mk(MAXP * 32), svao, sbuf, pHm: null }; gl.bindVertexArray(null);
      return gpu;
    }
    const point = (layer, x, y, size, c, a, kind) => { if (np[layer] >= MAXP || !(a > 0.002)) return; const q = np[layer]++ * 8, p = pt[layer]; p[q] = x; p[q + 1] = y; p[q + 2] = size; p[q + 3] = kind || 0; p[q + 4] = c[0]; p[q + 5] = c[1]; p[q + 6] = c[2]; p[q + 7] = a; };
    const PX = new Float32Array(160), PY = new Float32Array(160), LW = new Float32Array(160), LL = new Float32Array(160);
    /** a ribbon through n points PX / PY with widths LW and lights LL */
    function ribbon(layer, n, c) {
      const R = rb[layer]; let pnx = 0, pny = 0, pl = 0;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1); let dx = PX[i1] - PX[i0], dy = PY[i1] - PY[i0]; const l = Math.hypot(dx, dy) || 1e-6; dx /= l; dy /= l;
        const w = LW[i], nx = -dy * w, ny = dx * w, li = LL[i];
        if (i > 0 && (li > 0.003 || pl > 0.003)) {
          if (nv[layer] + 6 > MAXV) return;
          const j = i - 1, ax = PX[j], ay = PY[j], bx = PX[i], by = PY[i], vj = j / (n - 1) * 6, vi = i / (n - 1) * 6;
          const put = (x, y, u, v, a) => { const q = nv[layer]++ * 8; R[q] = x; R[q + 1] = y; R[q + 2] = u; R[q + 3] = v; R[q + 4] = c[0]; R[q + 5] = c[1]; R[q + 6] = c[2]; R[q + 7] = a; };
          put(ax + pnx, ay + pny, 1, vj, pl); put(ax - pnx, ay - pny, -1, vj, pl); put(bx + nx, by + ny, 1, vi, li);
          put(ax - pnx, ay - pny, -1, vj, pl); put(bx - nx, by - ny, -1, vi, li); put(bx + nx, by + ny, 1, vi, li);
        }
        pnx = nx; pny = ny; pl = li;
      }
    }
    const fill = (n, w, l) => { for (let i = 0; i < n; i++) { LW[i] = typeof w === 'function' ? w(i) : w; LL[i] = typeof l === 'function' ? l(i) : l; } };

    function frame(F) {
      ask();
      const link = root.VTCableLink || null, live = link && Number.isFinite(link.t) && Math.abs(link.t - F.t) < 0.5;
      F.link = live ? link : null;
      o = qs.step(F); tNow = F.t; dtNow = F.dt || 1 / 30;
      if (live) for (const e of o.events) if (e === 'drain') link.inbox.push('drain');
      const hyp = live ? Math.max(0, (link.hype === undefined ? -1 : link.hype) + 1) : 0, gold = live ? link.gold || 0 : 0;
      const look = live && link.look ? link.look : DEF, cb = look.b, ca = [look.a[0] + (cb[0] - look.a[0]) * 0.8 * gold, look.a[1] + (cb[1] - look.a[1]) * 0.8 * gold, look.a[2] + (cb[2] - look.a[2]) * 0.8 * gold], cw = [1.5, 1.4, 1.6];
      const on = live ? clamp(link.on, 0, 1) * (0.15 + 0.85 * clamp(link.charge === undefined ? 1 : link.charge, 0, 1)) : clamp(F.k * 3, 0, 1);
      palette.rim = ca; palette.glow = cb;
      nv[0] = nv[1] = np[0] = np[1] = 0;
      const K = o.k * on; cur.K = K; cur.ca = ca; cur.cb = cb;
      if (!(K > 0.004)) { palette.fill = [0, 0, 0]; lay = null; cur.en = 0; return palette; }
      const t = F.t, dt = F.dt || 1 / 30, au = F.au, w = qs.state.face.w, ax = o.a[0], ay = o.a[1], bx = o.b[0], by = o.b[1], mx = (ax + bx) / 2, my = (ay + by) / 2;
      let dx = bx - ax, dy = by - ay; const len = Math.hypot(dx, dy) || 1e-6; dx /= len; dy /= len; const nx = -dy, ny = dx;
      // (without hands it is a small calm knot at the chest, not a fire)
      const SZ = (0.50 + 0.50 * o.held) * (1 + 0.10 * hyp), fl = o.flow * (1 + 0.12 * hyp), sc = o.scatter, th = o.thick * SZ, ball = o.ball * SZ, coil = o.coil;
      const bright = K * (0.62 + 0.36 * au.level + 0.55 * o.pulse) * (1 - 0.45 * sc) * (1 + 0.06 * hyp);
      // the river runs through his FINGERS, not under his palms: with two hands up its ends sit between palm and middle finger
      const ea = [o.a[0], o.a[1]], eb = [o.b[0], o.b[1]];
      if (F.hands.length >= 2) { const hs = F.hands.slice(0, 2).sort((p, q) => p.x - q.x); for (const [e, h] of [[ea, hs[0]], [eb, hs[1]]]) if (h.pts) { e[0] += (h.pts[20] - h.x) * 0.50 * o.held; e[1] += (h.pts[21] - h.y) * 0.50 * o.held; } }
      lay = sp ? sp.step({ k: 1, a: ea, b: eb, coil, pulse: o.pulse, orb: o.orb, scatter: sc, held: o.held, ball, thick: th, flow: fl, events: o.events }, { t, dt, au, w, hands: F.hands }) : null;
      cur.bright = bright; cur.held = o.held; cur.mx = mx; cur.my = my; cur.hot = clamp(0.3 * au.high + 0.7 * o.pulse, 0, 1);
      cur.en = clamp(K * (0.6 + 0.8 * o.pulse + 0.5 * au.bass), 0, 1.6);
      palette.fill = [mx, my, cur.en];
      const sheets = AS.sheets;
      // ---- the stand-in (the sheets have not come): a plain river of three ribbons along the same path
      if (lay && !sheets.river && lay.river.k > 0.01) {
        const R = lay.river;
        for (const [c, wk, lk] of [[cb, 0.50, 0.42], [ca, 0.36, 0.85], [cw, 0.10, 0.40]]) {
          for (let i = 0; i < R.n; i++) { PX[i] = R.P[i * 2]; PY[i] = R.P[i * 2 + 1]; LW[i] = R.half[i] * wk; LL[i] = bright * lk * R.k * Math.sin(Math.PI * i / (R.n - 1)); }
          ribbon(0, R.n, c);
        }
      }
      if (lay && !sheets.sphere && lay.sphere.k > 0.01) point(0, lay.sphere.x, lay.sphere.y, lay.sphere.r * 1.6, ca, 0.5 * bright * lay.sphere.k, 2);
      // ---- round each finger: a wisp that winds up it (only its near half is seen: it goes round the finger)
      for (const h of F.hands) {
        const L = h.L || 0.1, P = h.pts; if (!P) continue;
        for (let fi = 0; fi < 5; fi++) {
          const b0 = 1 + fi * 4, M2 = 22, c = fi % 2 ? cb : ca, turns = 2.2;
          for (let i = 0; i < M2; i++) {
            const u = i / (M2 - 1) * 2.999, j = Math.floor(u), k2 = u - j, x0 = P[(b0 + j) * 2], y0 = P[(b0 + j) * 2 + 1], x1 = P[(b0 + j + 1) * 2], y1 = P[(b0 + j + 1) * 2 + 1];
            let ex = x1 - x0, ey = y1 - y0; const el = Math.hypot(ex, ey) || 1e-6; ex /= el; ey /= el;
            const an = i / (M2 - 1) * TAU * turns - fl * 2.4 + fi, r = L * 0.125 * (1 - 0.3 * i / (M2 - 1));
            PX[i] = x0 + (x1 - x0) * k2 - ey * r * Math.sin(an); PY[i] = y0 + (y1 - y0) * k2 + ex * r * Math.sin(an);
            LW[i] = th * 0.060; LL[i] = bright * 0.30 * h.k * Math.max(0, Math.cos(an)) * Math.sin(Math.PI * i / (M2 - 1));
          }
          ribbon(1, M2, c);
        }
      }
      if (o.orb > 0.02) {
        // the orb a fist charges: a white heart, a ring that fills
        const r = w * (0.20 + 0.42 * o.orb), M3 = 48;
        point(1, mx, my, r * 1.0, cw, 1.2 * o.orb * K, 0); point(1, mx, my, r * 3.2, cb, 0.30 * o.orb * K, 1);
        for (let i = 0; i < M3; i++) { const an = i / (M3 - 1) * TAU * o.orb + fl; PX[i] = mx + Math.cos(an) * r * 1.5; PY[i] = my + Math.sin(an) * r * 1.5; }
        fill(M3, th * 0.20, 1.2 * o.orb * K); ribbon(1, M3, cb);
      }
      // ---- the strand a pinch pulls out
      if (o.strand.k > 0.02) {
        const M4 = 36, sx = o.strand.x, sy = o.strand.y, ddx = sx - mx, ddy = sy - my, dl = Math.hypot(ddx, ddy) || 1e-6;
        for (let q = 0; q < 5; q++) {
          for (let i = 0; i < M4; i++) { const u = i / (M4 - 1), wv = th * (0.5 + 0.35 * q) * Math.sin(Math.PI * u) * Math.sin(u * (8 + 2 * q) - fl * (5 + q) + q); PX[i] = mx + ddx * u - ddy / dl * wv; PY[i] = my + ddy * u + ddx / dl * wv; }
          fill(M4, (i) => th * (q ? 0.10 : 0.55) * (1 - 0.6 * i / (M4 - 1)), (q ? 0.55 : 0.75) * o.strand.k * K); ribbon(1, M4, q === 0 ? ca : q % 2 ? cw : cb);
        }
        point(1, sx, sy, w * 0.20, cw, 1.2 * o.strand.k * K, 1);
      }
      // ---- where the river's edge is (for the tongues, the lightning): the sprite path when there is one
      const M = [0, 0, 0, 0];
      const mid = (s, out) => {
        if (lay) { const R = lay.river, f = clamp(s, 0, 1) * (R.n - 1), i = Math.min(R.n - 2, Math.floor(f)), k = f - i; out[0] = R.P[i * 2] + (R.P[i * 2 + 2] - R.P[i * 2]) * k; out[1] = R.P[i * 2 + 1] + (R.P[i * 2 + 3] - R.P[i * 2 + 1]) * k; out[3] = R.half[i] * 0.40; return out; }
        const uc = clamp(-0.14 + 1.28 * s, 0, 1); out[0] = ax + dx * uc * len; out[1] = ay + dy * uc * len; out[3] = th * 1.6; return out;
      };
      // ---- splashes: tongues of liquid thrown off its edge (on a kick, the highs, a scatter)
      tongueAcc += dt * (1.2 + 7 * au.high + 14 * o.pulse + 26 * sc) * (0.3 + 0.7 * o.held);
      while (tongueAcc >= 1 && tongues.length < 22) { tongueAcc -= 1; const s = 0.15 + 0.7 * rnd(), side = rnd() < 0.5 ? -1 : 1; tongues.push({ t0: t, s, side, v: (0.20 + 0.40 * rnd()) * (1 + 1.2 * sc), lean: (rnd() - 0.5) * 1.6, life: 0.45 + 0.4 * rnd(), col: rnd() < 0.6 ? 1 : 0 }); }
      if (tongueAcc > 3) tongueAcc = 3;
      for (let q = tongues.length - 1; q >= 0; q--) {
        const g = tongues[q], age = (t - g.t0) / g.life; if (!(age >= 0 && age < 1)) { tongues.splice(q, 1); continue; }
        mid(g.s, M); const R = M[3] * (1 - 0.7 * coil) + ball * 0.8 * coil, ox = M[0] + (mx - M[0]) * coil + nx * g.side * R, oy = M[1] + (my - M[1]) * coil + ny * g.side * R;
        const vx = (nx * g.side + dx * g.lean) * g.v * w, vy = (ny * g.side + dy * g.lean) * g.v * w, T = 14, reach = 0.25 + 0.75 * Math.sqrt(age);
        for (let i = 0; i < T; i++) { const tau = i / (T - 1) * reach * g.life * 1.6; PX[i] = ox + vx * tau; PY[i] = oy + vy * tau - 0.9 * w * tau * tau; LW[i] = th * 0.26 * (1 - 0.75 * i / (T - 1)); LL[i] = bright * 0.8 * (1 - age) * Math.min(1, i / 2); }
        ribbon(1, T, g.col ? cb : ca);
        point(1, PX[T - 1], PY[T - 1], w * 0.07 * (1 - 0.4 * age), g.col ? cb : ca, K * (1 - age), 3);                     // the drop at its tip
      }
      // ---- thin white lightning: it forks out of the river and is gone in a blink
      if (t - boltAt > 0.07) { boltAt = t; bolts.length = 0; const n = Math.round(2 + 3 * au.high + 3 * o.pulse + 4 * sc); for (let k = 0; k < n; k++) bolts.push([0.1 + 0.8 * rnd(), rnd() * TAU, rnd() * 99, 0.6 + 1.6 * rnd()]); }
      for (const b of bolts) {
        mid(b[0], M); const M5 = 18, ox = M[0] + (mx - M[0]) * coil, oy = M[1] + (my - M[1]) * coil, el = (M[3] * 1.3 + w * 0.12) * b[3], ex = Math.cos(b[1]) * el, ey = Math.sin(b[1]) * el;
        for (let i = 0; i < M5; i++) { const u = i / (M5 - 1), j = (Math.sin(b[2] + i * 7.3) + Math.sin(b[2] * 1.7 + i * 3.1) + 0.6 * Math.sin(b[2] * 3.3 + i * 13.7)) * el * 0.045 * Math.sin(Math.PI * Math.min(1, u * 1.3)); PX[i] = ox + ex * u - ey / el * j; PY[i] = oy + ey * u + ex / el * j; LW[i] = th * 0.050 * (1 - 0.6 * u); LL[i] = 0.50 * K * (0.6 + 0.6 * au.high) * (1 - u * 0.7); }
        ribbon(1, M5, cw);
      }
      // ---- the droplets and the sparks
      const D = QS.DROP;
      for (let i = 0; i < o.nDrops; i++) {
        const d = i * D, life = 1 - o.drops[d + 4] / o.drops[d + 5], a = K * Math.min(1, life * 3) * Math.min(1, o.drops[d + 4] * 12), kind = o.drops[d + 7], sz = o.drops[d + 6];
        if (kind === 2) point(1, o.drops[d], o.drops[d + 1], sz * 1.6, i % 3 ? cw : cb, a * 1.3, i % 5 ? 0 : 1);
        else point(1, o.drops[d], o.drops[d + 1], sz * 2.0, i % 3 === 0 ? ca : cb, a * (kind === 1 ? 1.5 : 1.0), 3);
      }
      return palette;
    }

    // ---- one picture of a sheet on a shape
    function sheetUse(g, S, f, X, k, gain, o2) {
      const f0 = Math.floor(f) % S.frames, f1 = S.loop ? (f0 + 1) % S.frames : Math.min(S.frames - 1, f0 + 1), q = o2 || {};
      g.pSp.use().u('uS', X.sU).ui('uTex', 0).u('uGrid', [S.cols, S.rows]).u('uInset', S.inset).u('uF', [f0, f1, f - Math.floor(f)]).u('uColA', cur.ca).u('uColB', cur.cb).u('uGain', gain).u('uK', k)
        .u('uEnds', q.ends ? 1 : 0).u('uUR', q.ur || [0, 1]).u('uFlip', q.flip || 1).u('uCurve', q.curve || 1.25).u('uHot', q.hot || 0).uv('uWave', 4, waveU);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.tex);
    }
    function quad(g, x, y, r, rot) {
      const c = Math.cos(rot || 0) * r, s = Math.sin(rot || 0) * r, P = [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]];
      for (let i = 0; i < 6; i++) { const px = P[i][0], py = P[i][1]; sv[i * 4] = x + px * c - py * s; sv[i * 4 + 1] = y + px * s + py * c; sv[i * 4 + 2] = px * 0.5 + 0.5; sv[i * 4 + 3] = py; }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.sbuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sv.subarray(0, 24)); gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    function drawSheets(layer, X) {
      if (!lay || !(cur.K > 0.004)) return;
      const g = init(), S = AS.sheets, B = cur.bright * lay.bright;
      gl.blendFunc(gl.ONE, gl.ONE); gl.bindVertexArray(g.svao);
      waveU.fill(0); lay.waves.forEach((q, i) => { if (i < 3) { waveU[i * 4] = q.u; waveU[i * 4 + 1] = q.k; } });
      const R = lay.river;
      if (S.river && R.k > 0.01) {
        // behind the hands: all of it. In front of them: a thinner part of it, another moment of the loop, turned over (the liquid goes round his fingers)
        // ALL of it is behind his hands (round 8): the hands are drawn after it, solid, so the liquid passes behind and between his fingers
        const strip = (T) => { for (let i = 0; i < T.n; i++) { const hw = T.half[i], x = T.P[i * 2], y = T.P[i * 2 + 1], qx = T.Nr[i * 2] * hw, qy = T.Nr[i * 2 + 1] * hw; sv.set([x + qx, y + qy, T.u[i], 1, x - qx, y - qy, T.u[i], -1], i * 8); } gl.bindBuffer(gl.ARRAY_BUFFER, g.sbuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sv.subarray(0, T.n * 8)); gl.drawArrays(gl.TRIANGLE_STRIP, 0, T.n * 2); };
        if (layer === 0) {
          sheetUse(g, S.river, R.f, X, R.k * B, [2.5, 2.5, 3.0], { ends: true, ur: [R.u0, R.u1], curve: 1.5 }); strip(R);
          for (const Wp of lay.wraps || []) if (Wp.k > 0.01) { sheetUse(g, S.river, Wp.f, X, Wp.k * B, [2.0, 3.0, 3.0], { ends: true, ur: [Wp.u0, Wp.u1], curve: 1.9 }); strip(Wp); }
        }
      }
      waveU.fill(0);
      if (S.sphere) {
        if (layer === 0) {
          for (const h of lay.halos) if (h.k > 0.01) { sheetUse(g, S.sphere, h.f, X, h.k * B * 0.16, [0.40, 1.45, 0.30], { curve: 2.0 }); quad(g, h.x, h.y, h.r, h.spin); }      // round each hand (mostly its gold)
          const q = lay.sphere; if (q.k > 0.01) { sheetUse(g, S.sphere, q.f, X, q.k * B * 1.5, [1.25, 1.35, 1.60], { hot: q.hot, curve: 1.6 }); quad(g, q.x, q.y, q.r, tNow * 0.11); }
        }
      }
      if (S.burst && layer === 1) for (const b of lay.bursts) { sheetUse(g, S.burst, Math.min(S.burst.frames - 1.001, b.age * S.burst.frames), X, b.k * cur.K * (1.9 - 0.9 * b.age), [1.5, 1.4, 1.5], { curve: 1.1 }); quad(g, b.x, b.y, b.r, 0); }
    }
    function drawLayer(layer, X) {
      drawSheets(layer, X);
      if (!nv[layer] && !np[layer]) return;
      const g = init(); gl.blendFunc(gl.ONE, gl.ONE);
      if (nv[layer]) { g.pRb.use().u('uS', X.sU).u('uTime', tNow); gl.bindVertexArray(g.rb.vao); gl.bindBuffer(gl.ARRAY_BUFFER, g.rb.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, rb[layer].subarray(0, nv[layer] * 8)); gl.drawArrays(gl.TRIANGLES, 0, nv[layer]); }
      if (np[layer]) { g.pPt.use().u('uS', X.sU); gl.bindVertexArray(g.pt.vao); gl.bindBuffer(gl.ARRAY_BUFFER, g.pt.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pt[layer].subarray(0, np[layer] * 8)); gl.drawArrays(gl.POINTS, 0, np[layer]); }
    }
    /** the modelled hands. false = the model has not come (the hands layer draws its stand-in) */
    function drawHands(X, H) {
      const hd = AS.hand; if (!hd) return false;
      const g = init();
      if (!hd.mesh) {
        const m = SKIN.parse(hd.meta, hd.buf); g.pHm = G.program(VS_HM, FS_HM);
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const fb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, fb); gl.bufferData(gl.ARRAY_BUFFER, m.f32, gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        const bb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bb); gl.bufferData(gl.ARRAY_BUFFER, m.u8, gl.STATIC_DRAW); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, false, 8, 0); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 8, 4);
        const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        hd.mesh = { vao, n: m.idx.length, uB: gl.getUniformLocation(g.pHm.p, 'uB') };
      }
      for (const id of hd.tr.keys()) if (!H.some((h) => h.id === id)) hd.tr.delete(id);
      if (!H.length) return true;
      // the hands hide each other and themselves by their own depth (they are always in front of the Mask)
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      g.pHm.use().u('uS', X.sU).u('uZk', 0.45).u('uColA', cur.ca).u('uColB', cur.cb).u('uTime', tNow).u('uHot', cur.hot).u('uStream', [cur.mx, cur.my, cur.en]);
      gl.bindVertexArray(hd.mesh.vao);
      for (const h of H) {
        if (!(h.k > 0.01) || !h.pts) continue;
        let tr = hd.tr.get(h.id); if (!tr) { tr = hd.skin.tracker(h.side >= 0 ? 1 : -1); hd.tr.set(h.id, tr); }
        tr.update(h.pts, h.z, X.dt === undefined ? dtNow : X.dt);
        if (!tr.ok) continue;
        g.pHm.u('uSide', tr.side).u('uK', h.k).u('uL', tr.L); gl.uniformMatrix4fv(hd.mesh.uB, false, tr.mats);
        gl.drawElements(gl.TRIANGLES, hd.mesh.n, gl.UNSIGNED_SHORT, 0);
      }
      gl.bindVertexArray(null); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      return true;
    }
    return {
      palette, frame, handFS: FS_HD, drawHands,
      /** it is there without hands too (it floats in front of the chest) for as long as its cable look is on */
      always: () => { const l = root.VTCableLink; return !!(l && l.on > 0.01); },
      drawBehind: (X) => drawLayer(0, X), draw: (X) => drawLayer(1, X),
      stats: () => (o ? { k: o.k, held: o.held, coil: o.coil, orb: o.orb, drain: o.drain, scatter: o.scatter, drops: o.nDrops, strand: o.strand.k, verts: nv[0] + nv[1], points: np[0] + np[1],
        baked: Object.keys(AS.sheets).filter((k) => AS.sheets[k]).length, hand: AS.hand ? (AS.hand.mesh ? 'model' : 'model (not drawn yet)') : 'drawn', failed: AS.failed, river: lay ? lay.river.k : 0, sphere: lay ? lay.sphere.k : 0, bursts: lay ? lay.bursts.length : 0, waves: lay ? lay.waves.length : 0 } : null),
    };
  }
  if (root.VTMaskHands) root.VTMaskHands.register('quantum-stream', make);
})(typeof globalThis !== 'undefined' ? globalThis : self);
