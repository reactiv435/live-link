// V9 SHOW OPENING, what is drawn in light (V9-SHOW-OPEN.md): the crimson digital rain of the countdown card, and the
// TRANSFORM: a crimson scan line sweeps down, what it has passed ignites and burns away into embers, and the embers
// build what comes next. One WebGL2 canvas of its own, ABOVE the Mask's canvas. It never touches the Mask's own
// drawing: it reads the Mask's finished picture as a texture (the Mask's canvas is hidden by the page meanwhile).
//
// The page is see-through where this layer is see-through: in OBS his REAL camera is the source under the browser
// source, so "his real face" here is simply alpha 0. The burn therefore works WITHOUT his camera's pixels: the edge
// adds light (premultiplied, alpha 0 = additive in OBS), the char in front of it darkens (alpha, no colour), and behind
// it the layer is opaque. A render tool (or a later camera-in-the-page mode) may pass `cam`, a picture of the camera:
// then the same shader lays it underneath and the output is opaque, which is what OBS would show.
//
//   const show = VTMaskShow.create(canvas, { width, height });
//   show.draw({
//     t, dt,                       seconds (the page's clock)
//     steady: 'card' | 'cam' | 'mask' | null,     what is shown when no transform runs (null = nothing: clear)
//     tf: VTShowOpen transform sample | null,     a running transform (js/v9-show-engine.js)
//     mask: the Mask's canvas (drawn THIS frame, before this call) | null,
//     cam: an image / canvas / video of the camera (tools only) | null,
//     card: { surge, beat, meter, maskGain, flash },    the countdown card's life
//     face: { pts: Float32Array [x, y] * n in page pixels (his REAL face), cols: Uint8Array [r, g, b] * n | null } | null,
//     maskRect: { cx, cy, h }      where the Mask's face sits on the page (pixels)
//   });
//   show.snapshot(maskCanvas)      keeps the Mask's picture as it is now (for 'swap': one background burns into the next)
//   show.stats() -> { drawMs, embers }
(function (root) {
  'use strict';
  const VS = `#version 300 es
in vec2 a; out vec2 v; void main() { v = a * .5 + .5; gl_Position = vec4(a, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D uMask, uCam, uSnap, uGlyph;
uniform vec2 uRes, uCamFit;
uniform float uTime, uRainT, uHasCam, uFront, uReveal, uImpact, uPost, uPower, uSurge, uBeat, uMeter, uCharge, uMaskGain, uFlash, uSoft, uLook, uRich;
uniform int uA, uB, uKind;
uniform vec3 uFace, uMaskAt;      // centre x, y and half height, in units of the page height (x * aspect)
float h1(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
// one sheet of rain: columns of glyphs, a white-hot head, a crimson tail that dies away
vec3 rain(vec2 px, float cell, float speed, float seed, float bright) {
  vec2 cs = vec2(cell, cell * 1.42), g = px / cs; float col = floor(g.x), row = floor(g.y);
  float rows = uRes.y / cs.y, sum = 0., headK = 0.;
  for (int k = 0; k < 2; k++) {
    float s2 = seed + float(k) * 31.7;
    float sp = (.45 + .85 * h1(vec2(col, s2 + 3.1))) * speed, len = 10. + 26. * h1(vec2(col, s2 + 7.7)), period = rows + len + 4. + 30. * h1(vec2(col, s2 + 1.3));
    float head = mod(uRainT * sp * 11. + h1(vec2(col, s2)) * period, period) - 2., d = head - row;
    float b = d < 0. ? 0. : exp(-d / len * 3.4);
    sum = max(sum, b); headK = max(headK, d >= 0. && d < 1. ? 1. : d >= 1. && d < 2.5 ? .35 : 0.);
  }
  if (sum < .012) return vec3(0.);
  float flick = floor(uRainT * (1.5 + 5. * h1(vec2(col, row) + seed)) + h1(vec2(row, col) + seed) * 10.);
  float gi = floor(h1(vec2(col * 1.7 + flick, row * 2.3 + seed)) * 64.);
  vec2 f = fract(g);
  vec2 auv = (vec2(mod(gi, 8.), floor(gi / 8.)) + vec2(.06 + (1. - f.x) * .88, .04 + (1. - f.y) * .92)) / 8.;
  float a = texture(uGlyph, auv).r;
  vec3 c = mix(vec3(.50, .006, .035), vec3(.98, .06, .09), smoothstep(.25, .9, sum));
  c = mix(c, vec3(1., .42, .16), smoothstep(.82, 1., sum) * .6);
  c = mix(c, vec3(1., .93, .84), headK);
  return c * a * sum * bright * (1. + headK * 1.5) + vec3(.9, .08, .1) * headK * .05 * bright;
}
// countdown 2.0 (js/v9-countdown.js): no rain wall, the Mask is the picture. Warm black; a crimson floor that rises
// with the fill (uMeter); a halo behind the Mask that warms with it; a little rain far out at the sides; the vignette.
vec3 card2(vec2 p, vec2 px, vec2 q) {
  vec3 c = vec3(.011, .005, .004);
  float dm = length((q - uMaskAt.xy) / vec2(uMaskAt.z * .95, uMaskAt.z * 1.15));
  float top = mix(1.10, .62, uMeter);
  c += vec3(.15, .007, .016) * smoothstep(top - .30, 1.08, p.y) * (.45 + .55 * uMeter + .5 * uSurge);
  c += vec3(.05, .004, .007) * exp(-pow((p.y - top) / .012, 2.)) * uMeter * step(uMeter, .999);
  c += vec3(.34, .025, .05) * exp(-dm * dm * 1.25) * (.035 + .11 * uMeter + .05 * uRich + .06 * uBeat * uMeter + .25 * uSurge);
  c += rain(px, uRes.x / 54., .40, 9., .20) * smoothstep(.95, 1.9, dm) * (.18 + .30 * uMeter);
  float vg = smoothstep(1.1, .2, length((p - vec2(.5, .47)) * vec2(1.05, .9)));
  c *= .28 + .72 * vg;
  vec3 m = texture(uMask, v).rgb * uMaskGain;
  c = 1. - (1. - c) * (1. - min(m, 1.));
  c += vec3(1., .80, .62) * uFlash * exp(-dm * dm * .9) * .5;
  return c;
}
vec3 card(vec2 p, vec2 px, vec2 q) {
  if (uLook > .5) return card2(p, px, q);
  vec3 c = vec3(.026, .010, .009);
  c += vec3(.20, .010, .022) * smoothstep(.45, 1.1, p.y) * (.75 + .5 * uSurge);                 // the floor glows crimson
  c += vec3(.10, .008, .014) * exp(-p.y * 5.);
  float dm = length((q - uMaskAt.xy) / vec2(uMaskAt.z * .95, uMaskAt.z * 1.15));
  float hole = smoothstep(.55, 1.5, dm);                                                           // the rain thins behind the Mask, so the face reads
  float k = 1.0 + .55 * uSurge + .16 * uBeat;
  vec3 r = rain(px, uRes.x / 30., 1., 1., 1.) * mix(.10, 1., hole);
  r += rain(px + vec2(7., 0.), uRes.x / 54., .62, 9., .55) * mix(.25, 1., hole);
  r += rain(px, uRes.x / 15., 1.5, 21., .22) * hole;                                                // a few big, fast, soft ones in front
  c += r * k;
  c += vec3(.55, .03, .06) * exp(-dm * dm * 1.6) * (.10 + .10 * uBeat + .22 * uSurge);           // a halo behind the Mask
  c *= .90 + .10 * sin(px.y * 3.14159 / 2.);                                                     // scan lines
  float vg = smoothstep(1.05, .25, length((p - vec2(.5, .47)) * vec2(1.05, .92)));
  c *= .35 + .65 * vg;
  vec3 m = texture(uMask, v).rgb * uMaskGain;
  c = 1. - (1. - c) * (1. - min(m, 1.));
  c += vec3(1., .78, .6) * uFlash * exp(-dm * dm * .9) * .55;
  return c;
}
vec4 layer(int k, vec2 p, vec2 px, vec2 q) {
  if (k == 0) return uHasCam > .5 ? vec4(texture(uCam, (v - .5) * uCamFit + .5).rgb, 1.) : vec4(0.);
  if (k == 1) return vec4(texture(uMask, v).rgb, 1.);
  if (k == 2) return vec4(card(p, px, q), 1.);
  return vec4(texture(uSnap, v).rgb, 1.);
}
void main() {
  vec2 p = vec2(v.x, 1. - v.y), px = p * uRes, q = vec2(p.x * uRes.x / uRes.y, p.y);
  vec4 A = layer(uA, p, px, q);
  if (uFront < -5.) { o = A; return; }
  vec4 B = layer(uB, p, px, q);
  if (uB == 1) B.rgb *= uReveal;
  float inFace = 1. - smoothstep(.7, 1.3, length((q - uFace.xy) / vec2(uFace.z * .8, uFace.z)));
  // the burning edge: it follows the line, ragged; in the face it lags and breaks into islands that burn longer
  float n = fbm(q * vec2(6., 4.5) + vec2(0., uTime * .3)), n2 = fbm(q * 23. - vec2(0., uTime * 1.1));
  float d = (uFront - .03 - .07 * inFace - p.y) + (n - .5) * (.11 + .12 * inFace) + (n2 - .5) * .035;
  float k = smoothstep(0., .03, d);
  float edge = exp(-abs(d) * 85.), glow = d > 0. ? exp(-d * (11. - 5. * inFace)) : exp(d * 42.);
  float flame = fbm(q * vec2(15., 9.) - vec2(0., uTime * 2.4));
  float heat = edge * 1.5 + glow * (.18 + 1.1 * flame * flame) * (.45 + .9 * inFace) * uSoft;
  vec3 fire = mix(vec3(.72, .025, .055), vec3(1., .40, .09), smoothstep(.15, .85, heat));
  fire = mix(fire, vec3(1., .95, .84), smoothstep(.9, 1.7, heat));
  float chr = smoothstep(-.06, 0., d) * (1. - k) * .9;
  A = vec4(A.rgb * (1. - chr), A.a + (1. - A.a) * chr);
  vec4 c = mix(A, B, k);
  float hk = heat * (.75 + .5 * uPower);
  c.rgb += fire * hk; c.a = min(1., c.a + hk * .45);
  // the scan line itself: straight and thin, a white core in crimson; fine lines trail it over what has not burnt yet,
  // and it lights his face as it crosses it
  float dl = p.y - uFront, vis = step(-.08, uFront) * step(uFront, 1.1);
  float line = exp(-abs(dl) * uRes.y / 2.6) + .40 * exp(-abs(dl) * uRes.y / 26.) + .10 * exp(-abs(dl) * uRes.y / 120.);
  float trail = dl < 0. ? exp(dl * 15.) * (1. - k) : exp(-dl * 70.);
  float sl = .5 + .5 * sin(px.y * 3.14159 / 3.);
  vec3 scan = vec3(1., .08, .15) * line * 1.25 + vec3(1., .92, .88) * exp(-abs(dl) * uRes.y / 1.1) * .9 + vec3(.95, .05, .10) * trail * (sl * .30 + inFace * .22 * (.5 + .5 * sin(px.x * 3.14159 / 9.)));
  c.rgb += scan * vis; c.a = min(1., c.a + (line * .8 + trail * .25) * vis);
  // the impact: the embers have arrived. A ring runs out from the Mask, a warm bloom, never a white frame
  float r = length(q - uMaskAt.xy);
  float gather = uCharge * (exp(-r * r / .012) * .30 + exp(-r * r / .09) * .12);
  float R = uPost * (.9 + .7 * uPower) + .05, ring = uPost >= 0. ? exp(-pow((r - R) * (46. - 14. * uPower), 2.)) * exp(-uPost * 4.2) : 0.;
  float bloom = uImpact * exp(-r * r / (.05 + .09 * uPower)) * (.07 + .55 * uPower);
  ring += uPost >= 0. ? uPower * exp(-pow((r - R * .62) * 60., 2.)) * exp(-uPost * 5.) * .7 : 0.;
  vec3 add = vec3(1., .72, .32) * gather + mix(vec3(1., .08, .12), vec3(1., .75, .55), .15 + .25 * uPower) * ring * (.22 + 1.6 * uPower) + vec3(1., .66, .34) * bloom;
  if (uKind == 1) add *= .35;                                   // back to his real face: a soft one
  c.rgb += add; c.a = min(1., c.a + dot(add, vec3(.4)));
  o = c;
}`;
  const PVS = `#version 300 es
in vec2 aPos; in float aSize; in vec4 aCol; uniform vec2 uRes; out vec4 c;
void main() { c = aCol; gl_Position = vec4(aPos.x / uRes.x * 2. - 1., 1. - aPos.y / uRes.y * 2., 0., 1.); gl_PointSize = aSize; }`;
  const PFS = `#version 300 es
precision mediump float; in vec4 c; out vec4 o;
void main() { vec2 d = gl_PointCoord - .5; float r = length(d) * 2.; float a = exp(-r * r * 5.5) * .55 + smoothstep(.38, .0, r) * .75; o = vec4(c.rgb * a * c.a, 0.); }`;

  const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789REACTIV♪♫';
  function glyphAtlas() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '700 50px "MS Gothic", "Yu Gothic", Consolas, monospace';
    for (let i = 0; i < 64; i++) g.fillText(GLYPHS[i % GLYPHS.length], (i % 8) * 64 + 32, Math.floor(i / 8) * 64 + 34);
    return c;
  }
  const MAX = 10000;

  function create(canvas, { width = 1080, height = 1920 } = {}) {
    canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no WebGL2 for the show layer');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('show shader: ' + gl.getShaderInfoLog(s)); return s; };
    const prog = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('show program: ' + gl.getProgramInfoLog(p)); return p; };
    const P = prog(VS, FS), PP = prog(PVS, PFS);
    const U = {}; for (const n of ['uMask', 'uCam', 'uSnap', 'uGlyph', 'uRes', 'uCamFit', 'uTime', 'uRainT', 'uHasCam', 'uFront', 'uReveal', 'uImpact', 'uPost', 'uPower', 'uSurge', 'uBeat', 'uMeter', 'uCharge', 'uMaskGain', 'uFlash', 'uSoft', 'uA', 'uB', 'uKind', 'uFace', 'uMaskAt', 'uLook', 'uRich']) U[n] = gl.getUniformLocation(P, n);
    const quad = gl.createVertexArray(); gl.bindVertexArray(quad);
    const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.bindAttribLocation(P, 0, 'a'); gl.vertexAttribPointer(gl.getAttribLocation(P, 'a'), 2, gl.FLOAT, false, 0, 0);
    const tex = (src) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (src) upload(t, src); else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    };
    function upload(t, src) { gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); }
    const T = { mask: tex(null), cam: tex(null), snap: tex(null), glyph: tex(glyphAtlas()) };
    // the embers: simulated here, drawn as points that only add light
    const E = { n: 0, x: new Float32Array(MAX), y: new Float32Array(MAX), vx: new Float32Array(MAX), vy: new Float32Array(MAX), age: new Float32Array(MAX), life: new Float32Array(MAX), seed: new Float32Array(MAX), tx: new Float32Array(MAX), ty: new Float32Array(MAX), home: new Uint8Array(MAX), col: new Float32Array(MAX * 3), size: new Float32Array(MAX), dur: new Float32Array(MAX) };
    const buf = new Float32Array(MAX * 7), vbo = gl.createBuffer(), pva = gl.createVertexArray();
    gl.bindVertexArray(pva); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
    const la = (n, size, off) => { const l = gl.getAttribLocation(PP, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 28, off); };
    la('aPos', 2, 0); la('aSize', 1, 8); la('aCol', 4, 12);
    const uPRes = gl.getUniformLocation(PP, 'uRes');
    const S = { rainT: 0, drawMs: 0, lastEdge: null, lastKind: null, snapOk: false, rnd: 12345 };
    const rnd = () => { S.rnd = (S.rnd * 1664525 + 1013904223) >>> 0; return S.rnd / 4294967296; };
    const K = height / 1920;

    function spawn(x, y, o) {
      if (E.n >= MAX) return;
      const i = E.n++;
      E.x[i] = x; E.y[i] = y; E.vx[i] = o.vx || 0; E.vy[i] = o.vy || 0; E.age[i] = 0; E.life[i] = o.life; E.seed[i] = rnd(); E.home[i] = o.home ? 1 : 0; E.tx[i] = o.tx || 0; E.ty[i] = o.ty || 0; E.size[i] = o.size;
      E.col[i * 3] = o.r; E.col[i * 3 + 1] = o.g; E.col[i * 3 + 2] = o.b; E.dur[i] = o.dur || 1;
    }
    /** his face's points (page pixels) -> where the same points sit on the Mask: the embers of his brow fly to the Mask's brow */
    function mapper(face, rect) {
      if (!face || !face.pts || face.pts.length < 6) return null;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; const p = face.pts, n = p.length / 2;
      for (let i = 0; i < n; i++) { const x = p[2 * i], y = p[2 * i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, h = Math.max(20, y1 - y0), k = rect.h / h;
      return { n, cx, cy, h, w: x1 - x0, to: (i) => [rect.cx + (p[2 * i] - cx) * k, rect.cy + (p[2 * i + 1] - cy) * k] };
    }
    function emit(tf, face, rect, dt, t) {
      const edge = (tf.front - 0.03) * height, kind = tf.kind;
      if (S.lastKind !== tf.t0) { S.lastKind = tf.t0; S.lastEdge = Math.min(edge, -0.02 * height); }
      const y0 = S.lastEdge, y1 = Math.max(y0, edge); S.lastEdge = y1;
      if (y1 <= y0 || y0 > height * 1.05) return;
      const pw = tf.power, M = mapper(face, rect), band = Math.min(y1, height) - Math.max(y0, 0);
      if (kind === 'toMask' && M) {
        const per = 5 + Math.round(7 * pw), p = face.pts, cols = face.cols, kk = rect.h / M.h;
        for (let i = 0; i < M.n; i++) {
          const y = p[2 * i + 1] + 0.07 * height * 0.6; if (y < y0 || y >= y1) continue;       // (the edge lags inside the face)
          const to = M.to(i);
          for (let j = 0; j < per; j++) {
            const c = cols ? [cols[3 * i] / 255, cols[3 * i + 1] / 255, cols[3 * i + 2] / 255] : [0.95, 0.62, 0.42];
            // a FACE ember: it lifts off this point of his face and flies straight to the same point of the Mask, so the
            // embers are a face on every picture of the way (home 3: vx / vy hold where it started)
            const jx = (rnd() - 0.5) * 9 * K, jy = (rnd() - 0.5) * 9 * K, dur = Math.max(0.3, tf.tI - 0.06 - t) * (0.9 + 0.1 * rnd());
            spawn(p[2 * i] + jx, p[2 * i + 1] + jy, { vx: p[2 * i] + jx, vy: p[2 * i + 1] + jy, life: dur + 0.22, dur, home: 3, tx: to[0] + jx * kk * 0.6, ty: to[1] + jy * kk * 0.6, size: (2.0 + rnd() * 2.6 + pw * 1.0) * K, r: c[0], g: c[1], b: c[2] });
          }
        }
      }
      // along the whole line: sparks off the burning picture
      const density = kind === 'swap' ? 0.2 : kind === 'cardToReal' ? 0.5 : 0.4 + 0.6 * pw, nLine = Math.round(Math.max(0, band) * density / K);
      for (let j = 0; j < nLine; j++) {
        const x = rnd() * width, y = y0 + rnd() * (y1 - y0) + (rnd() - 0.5) * 30 * K;
        const home = false, to = null;
        spawn(x, y, { vx: (rnd() - 0.5) * 220 * K, vy: -(40 + rnd() * 320) * K, life: home ? 9 : 0.35 + rnd() * 0.75, home, tx: home ? to[0] : 0, ty: home ? to[1] : 0, size: (1.4 + rnd() * 2.6) * K, r: 1, g: 0.45 + rnd() * 0.3, b: 0.12 });
      }
      // leaving the Mask: its face breaks into embers that fly off it
      if ((kind === 'toReal' || kind === 'cardToReal') && rect) {
        const n = Math.round(Math.max(0, band) * (kind === 'toReal' ? 5.5 : 2.2) / K);
        for (let j = 0; j < n; j++) {
          const a = rnd() * 6.283, rr = Math.sqrt(rnd()), x = rect.cx + Math.cos(a) * rr * rect.h * 0.42, y = y0 + rnd() * (y1 - y0);
          if (Math.abs(y - rect.cy) > rect.h * 0.62 * Math.sqrt(Math.max(0, 1 - Math.pow((x - rect.cx) / (rect.h * 0.44), 2)))) continue;
          const dx = x - rect.cx, dy = y - rect.cy, l = Math.hypot(dx, dy) + 1;
          spawn(x, y, { vx: dx / l * (80 + rnd() * 420) * K + (rnd() - 0.5) * 120 * K, vy: dy / l * (60 + rnd() * 300) * K - (80 + rnd() * 240) * K, life: 0.5 + rnd() * 1.0, home: 0, size: (1.8 + rnd() * 3.4) * K, r: 1, g: 0.72, b: 0.3 });
        }
      }
    }
    function simulate(t, dt, tf) {
      const u = tf ? tf.u : 1, post = tf ? tf.post : 9, toMask = tf && tf.kind === 'toMask';
      const g = toMask ? Math.pow(Math.min(1, Math.max(0, (u - 0.24) / 0.66)), 2) : 0;
      let w = 0, o = 0;
      for (let i = 0; i < E.n; i++) {
        let age = E.age[i] + dt, life = E.life[i];
        if (E.home[i] === 3) {
          if (!toMask) life = Math.min(life, age + 0.3);
          if (age >= life) continue;
          const sd3 = E.seed[i], dur = E.dur[i], s = Math.min(1, age / dur), e = s * s * (3 - 2 * s), wob = (1 - e) * 4 * K, sx = E.vx[i], sy = E.vy[i];
          const fx = sx + (E.tx[i] - sx) * e + Math.sin(t * 7 + sd3 * 60) * wob, fy = sy + (E.ty[i] - sy) * e + Math.cos(t * 6 + sd3 * 40) * wob;
          E.x[w] = fx; E.y[w] = fy; E.vx[w] = sx; E.vy[w] = sy; E.age[w] = age; E.life[w] = life; E.seed[w] = sd3; E.home[w] = 3; E.tx[w] = E.tx[i]; E.ty[w] = E.ty[i]; E.size[w] = E.size[i]; E.dur[w] = dur;
          const r3 = E.col[i * 3], g3 = E.col[i * 3 + 1], b3 = E.col[i * 3 + 2]; E.col[w * 3] = r3; E.col[w * 3 + 1] = g3; E.col[w * 3 + 2] = b3;
          const m = Math.min(1, s * 2.2), fd = Math.min(1, age / 0.06, (life - age) / 0.2);
          buf[o++] = fx; buf[o++] = fy; buf[o++] = E.size[i] * (1 + 0.9 * e) * 2.4; buf[o++] = r3 + (1 - r3) * m; buf[o++] = g3 + (0.80 - g3) * m; buf[o++] = b3 + (0.42 - b3) * m; buf[o++] = fd * (0.80 + 0.2 * Math.sin(t * 20 + sd3 * 90));
          w++; continue;
        }
        const homing = E.home[i] === 1;
        if (homing && toMask && post >= 0) { life = Math.min(life, age + 0.10 + E.seed[i] * 0.28); E.home[i] = 2; }       // arrived: the Mask is there, the ember goes out
        if (homing && !toMask) life = Math.min(life, age + 0.4);
        if (age >= life) continue;
        const sd = E.seed[i]; let x = E.x[i], y = E.y[i], vx = E.vx[i], vy = E.vy[i];
        const calm = E.home[i] ? 1 - 0.85 * g : 1; vx += Math.sin(y * 0.011 / K + sd * 40 + t * 2.3) * 520 * K * dt * calm; vy += (Math.cos(x * 0.012 / K + sd * 31 + t * 1.9) * 300 - 230 - 160 * sd) * K * dt * calm;
        const drag = Math.exp(-dt * (1.4 + 5 * g)); vx *= drag; vy *= drag;
        x += vx * dt; y += vy * dt;
        if (homing && toMask) { const k = 1 - Math.exp(-dt * g * (6 + 22 * g) * (0.6 + 0.8 * sd)); x += (E.tx[i] - x) * k; y += (E.ty[i] - y) * k; }
        E.x[w] = x; E.y[w] = y; E.vx[w] = vx; E.vy[w] = vy; E.age[w] = age; E.life[w] = life; E.seed[w] = sd; E.home[w] = E.home[i]; E.tx[w] = E.tx[i]; E.ty[w] = E.ty[i]; E.size[w] = E.size[i]; E.dur[w] = E.dur[i];
        const r0 = E.col[i * 3], g0 = E.col[i * 3 + 1], b0 = E.col[i * 3 + 2]; E.col[w * 3] = r0; E.col[w * 3 + 1] = g0; E.col[w * 3 + 2] = b0;
        // colour: what it was (his skin, when the page knows it) -> white-hot -> gold -> crimson -> out
        const a = E.home[i] ? Math.min(1, age / 1.1) : age / life, fade = E.home[i] ? Math.min(1, (life - age) / 0.18) : Math.min(1, (1 - a) * 2.2), tw = 0.75 + 0.25 * Math.sin(t * 22 + sd * 90);
        let cr, cg, cb;
        if (!E.home[i]) { cr = r0 - 0.12 * a; cg = g0 * (1 - 0.88 * a); cb = b0 * (1 - 0.7 * a); } else if (a < 0.22) { const m = a / 0.22; cr = r0 + (1 - r0) * m; cg = g0 + (0.86 - g0) * m; cb = b0 + (0.56 - b0) * m; } else { const m = Math.min(1, (a - 0.22) / 0.5); cr = 1; cg = 0.86 - 0.20 * m; cb = 0.56 - 0.30 * m; }
        buf[o++] = x; buf[o++] = y; buf[o++] = E.size[i] * 2.4; buf[o++] = cr; buf[o++] = cg; buf[o++] = cb; buf[o++] = fade * tw * (E.home[i] ? 0.85 - 0.45 * g : 0.9);
        w++;
      }
      E.n = w;
    }

    function draw(F) {
      const b = performance.now(), t = F.t, dt = Math.min(0.1, Math.max(0, F.dt || 1 / 30)), tf = F.tf || null, cardK = F.card || {};
      S.rainT += dt * (1 + 1.6 * (cardK.surge || 0));
      const rect = F.maskRect || { cx: width * 0.5, cy: height * 0.47, h: height * 0.46 };
      if (tf) emit(tf, F.face, rect, dt, t);
      // the impact: sparks thrown out of the Mask, more of them the fuller the meter was
      if (tf && tf.kind === 'toMask' && tf.post >= 0 && S.burst !== tf.t0) {
        S.burst = tf.t0;
        const n = Math.round(250 + 2300 * tf.power);
        for (let j = 0; j < n; j++) { const a = rnd() * 6.283, sp = (260 + rnd() * 900) * (0.55 + 0.75 * tf.power) * K, rr = rect.h * (0.25 + 0.2 * rnd()); spawn(rect.cx + Math.cos(a) * rr * 0.8, rect.cy + Math.sin(a) * rr, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.35 + rnd() * (0.5 + 0.5 * tf.power), home: 0, size: (1.6 + rnd() * 3.2) * K, r: 1, g: 0.6 + rnd() * 0.3, b: 0.2 + rnd() * 0.2 }); }
      }
      simulate(t, dt, tf);
      gl.viewport(0, 0, width, height); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const LAYER = { cam: 0, mask: 1, card: 2, snap: 3 };
      const PAIR = { toMask: ['cam', 'mask'], toReal: ['mask', 'cam'], cardToReal: ['card', 'cam'], swap: ['snap', 'mask'] };
      const pair = tf ? PAIR[tf.kind] : null, A = pair ? pair[0] : F.steady, B = pair ? pair[1] : F.steady;
      if (A) {
        if (F.mask && (A === 'mask' || B === 'mask' || A === 'card')) { try { upload(T.mask, F.mask); } catch (e) { /* the Mask's picture could not be read this frame: the last one stays */ } }
        if (F.cam) upload(T.cam, F.cam);
        gl.useProgram(P); gl.bindVertexArray(quad);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.mask); gl.uniform1i(U.uMask, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.cam); gl.uniform1i(U.uCam, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, T.snap); gl.uniform1i(U.uSnap, 2);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, T.glyph); gl.uniform1i(U.uGlyph, 3);
        gl.uniform2f(U.uRes, width, height); gl.uniform2f(U.uCamFit, 1, 1);
        gl.uniform1f(U.uTime, t); gl.uniform1f(U.uRainT, S.rainT); gl.uniform1f(U.uHasCam, F.cam ? 1 : 0);
        gl.uniform1f(U.uFront, tf ? tf.front : -9); gl.uniform1f(U.uReveal, tf ? tf.reveal : 1); gl.uniform1f(U.uImpact, tf ? tf.impact : 0); gl.uniform1f(U.uPost, tf ? tf.post : -1);
        gl.uniform1f(U.uPower, tf ? tf.power : 0); gl.uniform1f(U.uCharge, tf ? tf.charge : 0); gl.uniform1f(U.uSoft, tf && tf.kind === 'swap' ? 0.5 : 1);
        gl.uniform1f(U.uSurge, cardK.surge || 0); gl.uniform1f(U.uBeat, cardK.beat || 0); gl.uniform1f(U.uMeter, cardK.meter || 0); gl.uniform1f(U.uMaskGain, cardK.maskGain === undefined ? 1 : cardK.maskGain); gl.uniform1f(U.uFlash, cardK.flash || 0); gl.uniform1f(U.uLook, cardK.look === 2 ? 1 : 0); gl.uniform1f(U.uRich, cardK.rich || 0);
        gl.uniform1i(U.uA, LAYER[A]); gl.uniform1i(U.uB, LAYER[B]); gl.uniform1i(U.uKind, tf && tf.kind !== 'toMask' ? 1 : 0);
        const asp = width / height, M = mapper(F.face, rect);
        const fc = tf && tf.kind === 'toMask' && M ? [M.cx / height, M.cy / height, M.h / height * 0.62] : [rect.cx / height, rect.cy / height, rect.h / height * 0.6];
        gl.uniform3f(U.uFace, fc[0], fc[1], tf && tf.kind === 'swap' ? 1e-4 : fc[2]); gl.uniform3f(U.uMaskAt, rect.cx / height, rect.cy / height, rect.h / height * 0.5);
        void asp;
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      if (E.n) {
        gl.useProgram(PP); gl.bindVertexArray(pva); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf.subarray(0, E.n * 7));
        gl.uniform2f(uPRes, width, height);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, E.n);
        gl.disable(gl.BLEND);
      }
      S.drawMs += (performance.now() - b - S.drawMs) * 0.1;
    }
    return {
      draw, canvas,
      /** the Mask's picture as it is now, kept for a 'swap' (call right after the Mask drew) */
      /** every shader and buffer is used once, unseen, so the first burn of a show costs what every later one does */
      warm(src) {
        try {
          const pts = new Float32Array(40); for (let i = 0; i < 20; i++) { pts[2 * i] = width * (0.4 + 0.01 * i); pts[2 * i + 1] = height * (0.3 + 0.02 * i); }
          const rect = { cx: width * 0.5, cy: height * 0.47, h: height * 0.46 };
          for (const kind of ['toMask', 'toReal', 'cardToReal', 'swap']) for (const post of [-0.5, 0.05]) draw({ t: 0.5 + post, dt: 1 / 30, steady: 'card', tf: { kind, t0: -1 - post, tI: 0.5, u: 0.6, post, front: 0.55 + post, reveal: 0.5, impact: post > 0 ? 1 : 0, charge: 0.3, power: 1, events: [] }, mask: src || null, cam: null, card: { surge: 0.5, beat: 0.5, meter: 1, flash: 0.2 }, face: { pts, cols: null }, maskRect: rect });
          draw({ t: 1, dt: 1 / 30, steady: 'card', mask: src || null, card: {} });
          if (src) upload(T.snap, src);
          gl.finish();
        } catch (e) { /* a warm-up that fails changes nothing: the first burn then pays for it */ }
        E.n = 0; S.lastKind = null; S.lastEdge = null; S.burst = null; S.rainT = 0; S.drawMs = 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        return true;
      },
      snapshot(src) { try { upload(T.snap, src); S.snapOk = true; } catch (e) { S.snapOk = false; } return S.snapOk; },
      clear() { E.n = 0; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
      stats: () => ({ drawMs: S.drawMs, embers: E.n }),
      destroy() { const l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); },
    };
  }
  root.VTMaskShow = { create, MAX_EMBERS: MAX };
})(typeof globalThis !== 'undefined' ? globalThis : self);
