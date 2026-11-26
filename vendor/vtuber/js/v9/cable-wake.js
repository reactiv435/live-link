// COUNTDOWN 2.0: THE LIGHT THAT FILLS THE MASK (review/V9-COUNTDOWN-NOTES.md). Drawn by the cable look Quantum Flow
// (js/v9/mask-cables.js) at one place, right after its specks, and only while VTMaskCables.wake(o) holds an object:
//   VTCableWake.draw(G, { t, e, vp, model, cam, gain, look, core, faceVao, faceN, skullVao, skullN, aPos, aNrm, rig, wake, audio, ps })
// wake (from the page, js/v9-show-page.js, which takes it from js/v9-countdown.js):
//   fill 0..1     the level of the light inside the head: the chin at 0, the crown at 1 (it is the clock)
//   rich 0..1     how much the chat has given: brighter, more sparks (never a higher level)
//   churn 0..2    the last ten: the light swirls, its surface waves
//   flash, alive  the zero: it ignites, then settles into the living Mask
//   arr           the pulses that have just arrived: [{ c (the cable, -1 = all), age, s, kind }] -> a flash and a ring
// It reads the Mask's own meshes (the face as it moves, the cranium) and draws them once more, ADDED on top, behind
// what is solid in front of them (depth test, no depth write). It leaves the state as it found it: additive blending,
// no depth write, the depth test on (and the depth function it had).
(function (root) {
  'use strict';
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const cache = new WeakMap(), CROWN = [0, 1.3, -0.4];
  const TAP_FLARE = 2.8;      // how hard the socket of a cable flares when a pulse arrives (one tap must be seen; was 1.6)
  const VS = (lp, ln) => `#version 300 es
  precision highp float;
  layout(location = ${lp}) in vec3 aPos; layout(location = ${ln}) in vec3 aNrm;
  uniform mat4 uModel, uViewProj; out vec3 vL, vW, vN;
  void main() { vec4 w = uModel * vec4(aPos, 1.0); vW = w.xyz; vL = aPos; vN = mat3(uModel) * aNrm; gl_Position = uViewProj * w; }`;
  const FS = `#version 300 es
  precision highp float;
  in vec3 vL, vW, vN; out vec4 o;
  uniform vec3 uCam, uColA, uColB, uSpeck; uniform float uTime, uLevel, uRich, uChurn, uFlash, uAlive, uBeat, uGain, uY0, uY1, uForm, uKind, uNArr, uHit;
  uniform vec4 uArr[8]; uniform vec2 uArrS[8];
  float h1(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  vec3 h3(vec3 p) { return fract(sin(vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)))) * 43758.5453); }
  float vn(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h1(i), h1(i + vec3(1, 0, 0)), f.x), mix(h1(i + vec3(0, 1, 0)), h1(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h1(i + vec3(0, 0, 1)), h1(i + vec3(1, 0, 1)), f.x), mix(h1(i + vec3(0, 1, 1)), h1(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { return 0.55 * vn(p) + 0.30 * vn(p * 2.03 + 7.1) + 0.15 * vn(p * 4.01 + 3.3); }
  void main() {
    vec3 p = vL, N = normalize(vN), V = normalize(uCam - vW);
    float nv = abs(dot(N, V)), glass = 0.30 + 0.70 * pow(nv, 0.7);
    float sp = 0.35 + 1.1 * uChurn, t = uTime;
    // the level, with a living surface (it waves more in the last ten)
    float L = mix(uY0, uY1, uLevel) + (0.030 + 0.070 * uChurn) * (0.6 * sin(p.x * 5.0 + t * 1.7) + 0.4 * sin(p.z * 7.0 - t * 2.3 + p.x * 2.0));
    float d = L - p.y, below = smoothstep(-0.012, 0.030, d) * step(0.001, uLevel);
    float band = exp(-pow(d / 0.028, 2.0)) * step(0.001, uLevel) * step(uLevel, 0.995);
    if (below <= 0.0 && band < 0.002 && uFlash <= 0.0 && uNArr < 0.5) discard;      // (most of the head while the fill is low)
    // the energy: it flows upward through the glass, in veins
    vec3 q = p * 2.4 + vec3(0.0, -t * sp, 0.13 * t);
    float n = fbm(q), w = 1.0 - abs(2.0 * fbm(p * 3.3 + vec3(0.0, -t * sp * 0.8, t * 0.07) + n * 0.8) - 1.0), vein = pow(w, 7.0);
    vec3 deep = uColA * 0.55, top = uColB * 0.95, col = mix(deep, top, exp(-max(d, 0.0) / 0.32));
    float body = (0.045 + 0.10 * n) * (0.65 + 0.7 * uRich), veins = vein * (0.30 + 0.55 * uRich) * (0.8 + 0.5 * uBeat * uChurn);
    vec3 c = col * (body + veins) * below * glass * (1.0 + 0.9 * uHit);      // (a tap that lands: the light brightens a moment)
    // its surface: a bright meniscus line (the level reads at a glance)
    c += mix(uColB, vec3(1.0, 0.9, 0.7), 0.35 + 0.3 * uHit) * band * (0.55 + 0.4 * uRich + 0.6 * uChurn + 2.2 * uHit) * glass;      // (and its surface flares)
    // sparks in it (more of them when the chat has given more)
    vec3 g = p * 21.0, cell = floor(g), f = fract(g) - 0.5 - (h3(cell) - 0.5) * 0.6; float hh = h1(cell + 1.7);
    float on = step(0.955 - 0.075 * uRich - 0.03 * uChurn, hh), tw = pow(0.5 + 0.5 * sin(t * (2.0 + 4.0 * hh) + hh * 40.0), 5.0);
    c += uSpeck * on * tw * smoothstep(0.16, 0.02, length(f)) * below * (1.1 + 1.6 * uRich) * glass;
    // the pulses that just arrived: a flash where they came in, a ring that runs through the head
    for (int i = 0; i < 8; i++) {
      float a = uArr[i].w; if (a < 0.0) continue;
      float s = uArrS[i].x, big = uArrS[i].y, r = length(p - uArr[i].xyz);
      float tp = 1.0 - step(0.001, big);                                          // a tap (a gift has its size here)
      float fl = exp(-r * r / (0.07 + 0.03 * tp + 0.25 * big)) * exp(-a * (6.0 - 1.8 * tp)), ring = exp(-pow((r - a * (2.0 + 1.6 * big)) / (0.07 + 0.05 * big), 2.0)) * exp(-a * (2.6 - big));
      c += mix(uColB, vec3(1.0, 0.86, 0.95), 0.4 + 0.2 * tp) * s * (fl * (1.6 + 1.4 * tp) + ring * (0.30 + 0.25 * tp + 0.55 * big)) * glass;
    }
    // the zero: it ignites, then the light settles into the living Mask
    c += mix(uColB, vec3(1.0), 0.5) * uFlash * (0.30 + 0.42 * glass) * (0.5 + n);
    c *= mix(1.0, 0.42, uAlive * (1.0 - uFlash));
    if (uKind > 0.5) c *= 0.55;                                                   // the cranium behind: a little less
    if (uForm < 0.999) { if (h1(floor(vL * 38.0) + 3.0) > uForm * 1.15 - 0.10) discard; }
    o = vec4(c * uGain, 1.0);
  }`;
  const PVS = `#version 300 es
  precision highp float; in vec4 aP; in vec4 aC; uniform mat4 uViewProj; uniform float uPx; out vec4 vC;
  void main() { vec4 c = uViewProj * vec4(aP.xyz, 1.0); gl_Position = c; gl_PointSize = clamp(uPx * aP.w / c.w, 1.0, 600.0); vC = aC; }`;
  const PFS = `#version 300 es
  precision highp float; in vec4 vC; out vec4 o;
  void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard; o = vec4(vC.rgb * (exp(-r2 * 5.0) * 0.5 + exp(-r2 * 30.0) * 1.3), 1.0); }`;

  function setup(G, aPos, aNrm) {
    const gl = G.gl;
    let c = cache.get(gl);
    if (c && c.lp === aPos && c.ln === aNrm) return c;
    const prog = G.program(VS(aPos, aNrm), FS), pts = G.program(PVS, PFS);
    const data = new Float32Array(48 * 8), buf = G.buffer(data, true), vao = gl.createVertexArray();
    gl.bindVertexArray(vao); G.attrib(pts, 'aP', buf, 4, { stride: 32, offset: 0 }); G.attrib(pts, 'aC', buf, 4, { stride: 32, offset: 16 }); gl.bindVertexArray(null);
    c = { lp: aPos, ln: aNrm, prog, pts, data, buf, vao, arr: new Float32Array(32), arrS: new Float32Array(16), hit: new Float32Array(64), w3: [0, 0, 0], y0: -1.7, y0At: -9, core: null, ms: 0, df: 0, dfAt: -9 };
    cache.set(gl, c);
    return c;
  }
  /** the lowest point of the face (his chin), looked up now and then: the level starts there */
  function chin(c, core, t) {
    if (c.core === core && t - c.y0At < 2 && t >= c.y0At) return c.y0;
    const P = core && core.pos; if (!P || !P.length) return c.y0;
    let m = 9; for (let i = 1; i < P.length; i += 3) if (P[i] < m) m = P[i];
    if (Number.isFinite(m) && m < 0 && m > -4) c.y0 = m - 0.04;
    c.core = core; c.y0At = t; return c.y0;
  }

  function draw(G, o) {
    const W = o.wake; if (!W || !o.core || !(o.aPos >= 0) || !(o.aNrm >= 0)) return false;
    const gl = G.gl, b = (typeof performance !== 'undefined' ? performance.now() : 0);
    const c = setup(G, o.aPos, o.aNrm), look = o.look, A = o.audio || {}, t = o.t;
    const fill = clamp01(Number(W.fill) || 0), rich = clamp01(Number(W.rich) || 0), churn = Math.max(0, Math.min(2, Number(W.churn) || 0));
    const flash = clamp01(Number(W.flash) || 0), alive = clamp01(Number(W.alive) || 0), form = Math.max(0, Math.min(1, (o.e - 0.15) / 0.75));
    // the level eases a little faster at first (the chin is small), never past the crown
    const level = fill <= 0 ? 0 : clamp01(0.02 + 0.98 * Math.pow(fill, 0.92));
    const y0 = chin(c, o.core, t), y1 = 1.56;
    // the arrivals, in head space: the socket of the cable a pulse came down (a gift: the crown)
    const rig = o.rig, arr = Array.isArray(W.arr) ? W.arr : [];
    let nArr = 0, hitK = 0;
    for (let i = 0; i < 8; i++) {
      const a = arr[i];
      if (!a || !(a.age >= 0)) { c.arr[i * 4 + 3] = -1; c.arrS[i * 2] = 0; c.arrS[i * 2 + 1] = 0; continue; }
      const sk = a.c >= 0 && rig && rig.cables[a.c] ? rig.cables[a.c].socket : CROWN; nArr++;
      if (a.kind === 'tap') hitK += Math.exp(-a.age * 5.5);
      c.arr[i * 4] = sk[0] * 0.92; c.arr[i * 4 + 1] = sk[1] * 0.92; c.arr[i * 4 + 2] = sk[2] * 0.92 + 0.04; c.arr[i * 4 + 3] = a.age;
      c.arrS[i * 2] = Math.min(2, Number(a.s) || 1) * (a.kind === 'gift' ? 1.4 : 1); c.arrS[i * 2 + 1] = a.kind === 'gift' ? clamp01(Number(a.s) || 0) : 0;
    }
    if (!(t - c.dfAt < 1) || t < c.dfAt) { c.df = gl.getParameter(gl.DEPTH_FUNC); c.dfAt = t; }
    const depthFunc = c.df;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    const P = c.prog.use().u('uModel', o.model).u('uViewProj', o.vp).u('uCam', o.cam).u('uColA', look.a).u('uColB', look.b).u('uSpeck', look.speck || [1, 0.86, 0.6])
      .u('uTime', t).u('uLevel', level).u('uRich', rich).u('uChurn', churn).u('uFlash', flash).u('uAlive', alive).u('uBeat', clamp01(Number(A.beat) || 0))
      .u('uGain', (o.gain === undefined ? 1 : o.gain) * (0.55 + 0.45 * form)).u('uY0', y0).u('uY1', y1).u('uForm', form).uv('uArr', 4, c.arr).uv('uArrS', 2, c.arrS).u('uNArr', nArr).u('uHit', Math.min(1, hitK));
    if (o.skullVao && o.skullN) { P.u('uKind', 1); gl.bindVertexArray(o.skullVao); gl.drawElements(gl.TRIANGLES, o.skullN, gl.UNSIGNED_SHORT, 0); }
    if (o.faceVao && o.faceN) { P.u('uKind', 0); gl.bindVertexArray(o.faceVao); gl.drawElements(gl.TRIANGLES, o.faceN, gl.UNSIGNED_INT, 0); }
    // the sockets: each plug warms with the fill; a pulse that arrives flares its socket
    if (rig && o.model) {
      const m = o.model, D = c.data, look2 = look.b; let n = 0;
      const mw = (p, out) => { out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]; out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]; out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]; return out; };
      const w3 = c.w3; if (c.hit.length < rig.count) c.hit = new Float32Array(rig.count); const hit = c.hit; hit.fill(0, 0, rig.count);
      for (const a of arr) if (a && a.c >= 0 && a.c < rig.count && a.age >= 0) hit[a.c] = Math.max(hit[a.c], Math.exp(-a.age * 4));
      for (let k = 0; k < rig.count && n < 48; k++) {
        const s = rig.cables[k].socket, l = (0.05 + 0.30 * fill + 0.2 * rich) * (1 - 0.6 * alive) + TAP_FLARE * hit[k] + 0.8 * flash;
        if (l < 0.02) continue;
        mw(s, w3); const col = rig.cables[k].hue > 0.5 ? look2 : look.a;
        const j = n * 8; D[j] = w3[0]; D[j + 1] = w3[1]; D[j + 2] = w3[2]; D[j + 3] = 0.9 + 2.2 * hit[k]; D[j + 4] = col[0] * l; D[j + 5] = col[1] * l; D[j + 6] = col[2] * l; D[j + 7] = 0; n++;
      }
      if (n) {
        gl.bindBuffer(gl.ARRAY_BUFFER, c.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, D.subarray(0, n * 8));
        c.pts.use().u('uViewProj', o.vp).u('uPx', G.H * 0.05 * (o.ps || 1)); gl.bindVertexArray(c.vao); gl.drawArrays(gl.POINTS, 0, n);
      }
    }
    gl.bindVertexArray(null); gl.depthFunc(depthFunc);
    c.ms += ((typeof performance !== 'undefined' ? performance.now() : 0) - b - c.ms) * 0.05;
    return true;
  }
  root.VTCableWake = { draw, stats: (G) => { const c = G && cache.get(G.gl); return { ms: c ? c.ms : 0, y0: c ? c.y0 : null }; } };
})(typeof globalThis !== 'undefined' ? globalThis : self);
