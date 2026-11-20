// V4 MASK: the three looks (and a plain "clay" look for checking the geometry). Needs mask-gl.js; draws what
// mask-core.js produced. One call per frame:
//   const L = VTMaskLooks.create(G, core);
//   L.draw('chrome' | 'particles' | 'obsidian' | 'clay', { time, audio: { bass, mid, high, beat, level }, kicks: [[age, strength] x8],
//          hits: [[age, strength] x4], head: { R, x, y, scale } });
// Design notes (why each look is built the way it is) are in review/V4-MASK-NOTES.md.
(function (root) {
  'use strict';
  const { M4 } = root.VTMaskGL;
  const CRIM = 'vec3(1.0, 0.045, 0.03)';                    // crimson in linear light: warm, so hot cores go to warm white, never pink
  const COMMON = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform mat4 uModel, uViewProj; uniform vec3 uCam; uniform float uTime, uBass, uMid, uHigh, uBeat, uLevel, uEnvRot;
  uniform vec2 uKick[8]; uniform vec2 uHit[4];
  // round 3: the palette (mask-mood.js) and the gift / chat effects (mask-fx.js)
  uniform vec3 uShade, uShade2, uKeyCol, uAccent, uRingCol; uniform vec4 uFlash; uniform float uRainbow, uPulse, uShatter, uGain; uniform vec2 uRing;
  uniform vec4 uImp[10]; uniform vec4 uImpT[10]; uniform vec3 uImpC[10]; uniform int uNImp; uniform vec4 uLock; uniform vec4 uLockCol; uniform vec4 uTap[6]; uniform float uStreak, uViz; uniform int uBg;
  vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
  const vec3 CRIM = ${CRIM};
  float band(float x, float a, float b, float s) { return smoothstep(a - s, a + s, x) * (1.0 - smoothstep(b - s, b + s, x)); }
  vec3 hash3(vec3 p) { p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453123); }
  float hash1(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash1(i), hash1(i + vec3(1, 0, 0)), f.x), mix(hash1(i + vec3(0, 1, 0)), hash1(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash1(i + vec3(0, 0, 1)), hash1(i + vec3(1, 0, 1)), f.x), mix(hash1(i + vec3(0, 1, 1)), hash1(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  `;
  const FACE_VS = COMMON + `
  in vec3 aPos, aNrm, aRest; in vec4 aMask; in vec2 aMask2; in float aAct;
  out vec3 vWorld, vNrm, vRest; out vec4 vMask; out vec2 vMask2; out float vAct;
  uniform float uRipple, uShrink;
  void main() {
    vec3 p = aPos;
    // a kick sends one ring of displacement out from the middle of the face (the silhouette moves with it)
    float d = 0.0, r = length(aRest - vec3(0.0, -0.45, 0.5));
    for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = r - age * 4.2; d += cos(x * 9.0) * exp(-x * x * 9.0) * uKick[i].y * exp(-age * 2.4); }
    p += aNrm * (d * uRipple - uShrink);
    vec4 w = uModel * vec4(p, 1.0);
    vWorld = w.xyz; vNrm = mat3(uModel) * aNrm; vRest = aRest; vMask = aMask; vMask2 = aMask2; vAct = aAct;
    gl_Position = uViewProj * w;
  }`;

  // ------------------------------------------------------------------------------------------------ LIQUID CHROME
  // A mirror shows only its surroundings, so the look is the room: black, with one long white soft box overhead
  // (the form), a warm low fill (the chin never goes dead), two crimson strips at the sides (the cheeks), a rim
  // behind (the edge against the void), and crimson rings round the lens that open on every kick. A ring round the
  // lens mirrors as a contour of equal slope, so each kick sweeps a red contour line out over forehead and cheeks.
  const ENV_CHROME = `
  vec3 envChrome(vec3 d, float sf) {
    float ca = cos(uEnvRot), sa = sin(uEnvRot);
    vec3 q = vec3(ca * d.x + sa * d.z, d.y, -sa * d.x + ca * d.z);
    float el = asin(clamp(q.y, -1.0, 1.0)), az = atan(q.x, q.z);
    vec3 c = vec3(0.012, 0.011, 0.010) * smoothstep(-0.5, 0.9, q.y);
    float key = band(el, 0.66, 0.98, 0.04 + sf) * band(az, -0.95, 0.55, 0.06 + sf);
    float mull = smoothstep(0.012, 0.04, abs(fract((az + 0.95) / 0.5 + 0.5) - 0.5));
    c += key * mix(0.45, 1.0, mull) * vec3(3.4, 3.28, 3.12) * (0.8 + 0.4 * uMid);
    c += band(el, -0.85, -0.40, 0.09 + sf) * band(az, -0.35, 0.95, 0.12 + sf) * vec3(1.0, 0.86, 0.76) * 0.30;
    float side = band(el, -0.45, 0.70, 0.10 + sf) * (band(az, 1.36, 1.50, 0.03 + sf) + band(az, -1.64, -1.50, 0.03 + sf));
    c += side * CRIM * (1.4 + 1.6 * uBeat + 0.6 * uBass);
    c += band(abs(az), 2.35, 3.3, 0.2) * band(el, -0.4, 0.7, 0.2) * CRIM * (0.30 + 0.5 * uBass);
    // rings round the lens
    float th = acos(clamp(d.z, -1.0, 1.0));
    float g = (th - 0.36) / (0.030 + sf * 0.3);
    vec3 rc = CRIM;
    c += rc * exp(-g * g) * (0.05 + 0.9 * uBass * uBass);
    for (int i = 0; i < 8; i++) {
      float age = uKick[i].x, rad = 0.10 + 1.55 * (1.0 - exp(-age * 2.6)), w = 0.035 + age * 0.07 + sf * 0.3, x = (th - rad) / w;
      c += rc * exp(-x * x) * uKick[i].y * exp(-age * 3.2) * 3.2;
    }
    return c;
  }`;
  const CHROME_FS = COMMON + ENV_CHROME + `
  in vec3 vWorld, vNrm, vRest; in vec4 vMask; in vec2 vMask2; in float vAct; out vec4 o;
  void main() {
    vec3 N = normalize(vNrm); bool back = !gl_FrontFacing; if (back) N = -N;
    vec3 V = normalize(uCam - vWorld), p = vRest; float t = uTime;
    // liquid: slow swells that grow with the bass and where his face is working, a fine shiver from the highs
    vec3 w = vec3(sin(p.y * 4.3 + t * 1.1) + sin(p.z * 5.1 - t * 0.8 + p.x * 2.0), sin(p.x * 3.7 - t * 0.9) + sin(p.z * 4.4 + t * 1.3 + p.y * 1.7), sin(p.x * 4.9 + t * 0.7) + sin(p.y * 3.3 - t * 1.2));
    w += vec3(sin(p.y * 17.0 + t * 5.0), sin(p.x * 19.0 - t * 6.0), sin(p.z * 23.0 + t * 4.0)) * uHigh * 0.20;
    float amp = 0.003 + 0.009 * uBass;
    vec3 c0 = vec3(0.0, -0.45, 0.5); float r = length(p - c0); vec3 rd = (p - c0) / max(r, 1e-3);
    for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = r - age * 4.2; N += rd * (sin(x * 9.0) * exp(-x * x * 9.0) * uKick[i].y * exp(-age * 2.4) * 0.14); }
    N = normalize(N + w * amp);
    float nv = clamp(dot(N, V), 0.0, 1.0);
    vec3 R = reflect(-V, N);
    float satin = 0.05 * vMask.x + 0.03 * vMask.z;                       // lips and brow ridge: a slightly softer mirror, so they read as features
    vec3 col = envChrome(R, satin) * mix(vec3(0.93, 0.92, 0.90), vec3(1.0), pow(1.0 - nv, 5.0));
    // a hair of crimson light inside the lip line and the lid line: where his mouth and eyes are, at any size
    float line = smoothstep(0.55, 0.9, vMask2.x) + 0.7 * smoothstep(0.6, 0.95, vMask.y) + 1.6 * smoothstep(0.66, 0.9, vMask.z);   // lips, lids, brow line
    col += CRIM * line * (0.16 + 0.45 * uBeat + 0.25 * uBass);
    if (back) col = col * 0.10 + vec3(0.004, 0.002, 0.002);
    o = vec4(col, 1.0);
  }`;

  // ------------------------------------------------------------------------------------------------ MOLTEN OBSIDIAN
  // Black volcanic glass over a glow. The glass is chipped into plates (the cells of a 3D Voronoi pattern fixed to
  // his neutral face): each plate tilts a little, so the white soft box breaks into shards as he moves. The cracks
  // are the same pattern's edges, so light comes out exactly between the plates. How hot a crack is: the music's
  // level opens them from his eyes and mouth outward, a kick sends a front of heat across the face that cools behind
  // itself (white -> orange -> crimson -> dark), and where his face is working the cracks run hotter. A second, finer
  // and deeper layer (looked up a little way along the view ray) glows under the glass, so the heat has depth.
  const OBS_FS = COMMON + `
  in vec3 vWorld, vNrm, vRest; in vec4 vMask; in vec2 vMask2; in float vAct; out vec4 o;
  vec2 voro(vec3 x, out vec3 id) {
    vec3 n = floor(x), f = fract(x); float f1 = 8.0, f2 = 8.0; id = vec3(0.0);
    for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec3 g = vec3(float(i), float(j), float(k)), h = hash3(n + g), r = g + h - f; float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) f2 = d;
    }
    return vec2(sqrt(f1), sqrt(f2));
  }
  vec3 lava(float t) {
    vec3 c = mix(vec3(0.0), vec3(0.10, 0.002, 0.002), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.85, 0.036, 0.024), smoothstep(0.2, 0.55, t));
    c = mix(c, vec3(2.6, 0.15, 0.07), smoothstep(0.5, 0.8, t));
    c = mix(c, vec3(6.0, 0.85, 0.30), smoothstep(0.75, 1.0, t));
    return mix(c, vec3(12.0, 5.0, 2.6), smoothstep(1.0, 1.5, t));
  }
  vec3 envObs(vec3 d) {
    float ca = cos(uEnvRot), sa = sin(uEnvRot);
    vec3 q = vec3(ca * d.x + sa * d.z, d.y, -sa * d.x + ca * d.z);
    float el = asin(clamp(q.y, -1.0, 1.0)), az = atan(q.x, q.z);
    vec3 c = vec3(0.020, 0.017, 0.016) * smoothstep(-0.4, 0.9, q.y);
    c += band(el, 0.55, 1.0, 0.05) * band(az, -1.1, 0.5, 0.06) * vec3(6.5, 6.2, 5.8);
    c += band(el, -0.2, 0.9, 0.05) * band(az, 1.15, 1.27, 0.02) * vec3(3.0, 2.8, 2.6);
    c += band(el, -0.15, 0.35, 0.12) * band(az, -1.35, -0.55, 0.15) * vec3(0.75, 0.70, 0.66);
    c += band(abs(az), 2.2, 3.3, 0.2) * band(el, -0.4, 0.7, 0.2) * vec3(1.0, 0.16, 0.10) * (0.7 + 1.2 * uBass);
    c += smoothstep(-0.25, -0.85, q.y) * CRIM * (0.25 + 1.0 * uBass + 0.9 * uBeat);      // the glow below, mirrored under chin, nose and brow
    return c;
  }
  void main() {
    vec3 N = normalize(vNrm); bool back = !gl_FrontFacing; if (back) N = -N;
    vec3 V = normalize(uCam - vWorld), p = vRest;
    vec3 id, id2, id3;
    vec2 f = voro(p * 2.5 + 3.7, id); float e = f.y - f.x;
    vec2 g = voro(p * 5.6 + 11.1, id2); float e2 = g.y - g.x;
    float smoothArea = clamp(vMask.y * 1.4 + vMask2.x, 0.0, 1.0);             // lids and the lip line stay smooth glass
    float crack = (1.0 - smoothstep(0.006, 0.022 + fwidth(e) * 1.5, e));
    float crack2 = 1.0 - smoothstep(0.004, 0.020 + fwidth(e2) * 1.5, e2);
    float halo = exp(-e * 14.0);
    // where the heat is
    float dv = min(length(p - vec3(0.0, -1.02, 0.36)), min(length(p - vec3(-0.5, 0.0, 0.02)), length(p - vec3(0.5, 0.0, 0.02))));
    float thr = 0.10 + clamp(dv * 0.42, 0.0, 1.0) * 0.50 + vnoise(p * 1.7 + 5.0) * 0.40;
    float E = 0.04 + 0.26 * uBass + 0.10 * uMid + 0.16 * uLevel;
    vec3 c0 = vec3(0.0, -0.55, 0.42); float r = length(p - c0), wave = 0.0;
    for (int i = 0; i < 8; i++) {
      float age = uKick[i].x, x = r - age * 4.6, s = uKick[i].y;
      wave += s * exp(-x * x * 12.0) * exp(-age * 2.2) + s * 0.30 * smoothstep(0.1, -0.5, x) * exp(-max(age - r / 4.6, 0.0) * 3.4) * exp(-age * 1.4);
    }
    float open = smoothstep(thr - 0.10, thr + 0.22, E + 0.28 * vAct + 0.40 * wave);
    float T = open * (0.40 + 0.16 * uBeat + 0.10 * uBass) + wave * 0.42 * (0.35 + 0.65 * open) + vAct * 0.16 * open;
    float open2 = smoothstep(thr + 0.10, thr + 0.50, E + 0.25 * vAct + 0.5 * wave);
    // the deeper layer, seen through the glass
    vec3 Vl = normalize(transpose(mat3(uModel)) * V);
    vec2 h = voro((p - Vl * 0.055) * 5.3 + 21.3, id3); float e3 = h.y - h.x;
    float deep = 1.0 - smoothstep(0.0, 0.11, e3);
    vec3 emis = lava(T) * crack + lava(T * 0.6) * halo * 0.07 + lava(T * 0.8) * crack2 * open2 * 0.40 + lava(T * 0.5) * deep * 0.10 * open;
    emis *= 1.0 - 0.55 * smoothArea;
    // the glass
    vec3 Nf = normalize(N + (id - 0.5) * 0.26 * (1.0 - smoothArea) * smoothstep(0.0, 0.16, e));
    float nv = clamp(dot(Nf, V), 0.0, 1.0), nv0 = clamp(dot(N, V), 0.0, 1.0);
    float F = 0.045 + 0.955 * pow(1.0 - nv, 5.0), F0 = 0.045 + 0.955 * pow(1.0 - nv0, 5.0);
    vec3 spec = envObs(reflect(-V, Nf)) * F * (1.0 - 0.85 * crack) + envObs(reflect(-V, N)) * F0 * 0.35;
    vec3 col = spec + emis + vec3(0.0035, 0.0025, 0.0022);
    // the lip line and lid line catch the glow from inside
    col += lava(0.30 + 0.30 * uBeat + 0.20 * uBass) * (smoothstep(0.6, 0.95, vMask2.x) * 0.45 + smoothstep(0.65, 0.97, vMask.y) * 0.30 + smoothstep(0.68, 0.92, vMask.z) * 0.40);
    if (back) col = lava(0.30 + 0.2 * uBass) * 0.10 + spec * 0.05;                 // the inside of the mask is lit by the glow
    o = vec4(col, 1.0);
  }`;

  // ------------------------------------------------------------------------------------------------ CLAY (geometry check)
  const CLAY_FS = COMMON + `
  in vec3 vWorld, vNrm, vRest; in vec4 vMask; in vec2 vMask2; in float vAct; out vec4 o;
  void main() {
    vec3 N = normalize(vNrm); if (!gl_FrontFacing) N = -N;
    float l = 0.12 + 0.88 * max(dot(N, normalize(vec3(-0.4, 0.6, 0.7))), 0.0);
    vec3 col = vec3(0.55) * l; col = mix(col, vec3(0.9, 0.2, 0.15) * l, vMask.x); col = mix(col, vec3(0.9, 0.7, 0.2) * l, vMask.z); col = mix(col, vec3(0.9) * l, vMask.y);
    if (!gl_FrontFacing) col *= 0.2;
    o = vec4(col, 1.0);
  }`;
  const OCCLUDE_FS = COMMON + `
  in vec3 vWorld, vNrm, vRest; in vec4 vMask; in vec2 vMask2; in float vAct; out vec4 o;
  void main() {
    vec3 N = normalize(vNrm); if (!gl_FrontFacing) N = -N;
    float rim = pow(1.0 - clamp(dot(N, normalize(uCam - vWorld)), 0.0, 1.0), 3.0);
    o = vec4(CRIM * rim * (0.012 + 0.03 * uBass), 1.0);
  }`;

  // ------------------------------------------------------------------------------------------------ eyes, mouth
  const EYE_VS = COMMON + `
  in vec3 aPos; out vec3 vLocal, vWorld; uniform vec3 uCenter; uniform float uRadius;
  void main() { vLocal = aPos; vec4 w = uModel * vec4(uCenter + aPos * uRadius, 1.0); vWorld = w.xyz; gl_Position = uViewProj * w; }`;
  const EYE_FS = COMMON + ENV_CHROME + `
  in vec3 vLocal, vWorld; out vec4 o; uniform vec3 uGaze; uniform int uStyle;
  void main() {
    if (uStyle == 2) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 n = normalize(vLocal), N = normalize(mat3(uModel) * n), V = normalize(uCam - vWorld);
    float ang = acos(clamp(dot(n, uGaze), -1.0, 1.0));
    const float AP = 0.19, AI = 0.46;
    vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.0), uGaze)), t2 = cross(uGaze, t1);
    float phi = atan(dot(n, t2), dot(n, t1));
    float iris = band(ang, AP, AI, 0.018), edge = clamp((ang - AP) / (AI - AP), 0.0, 1.0);
    float fib = 0.55 + 0.45 * sin(phi * 34.0 + sin(phi * 7.0) * 2.0 + edge * 3.0);
    float pulse = 0.75 + 1.3 * uBeat + 0.7 * uBass;
    vec3 col;
    float nv = clamp(dot(N, V), 0.0, 1.0), F = 0.06 + 0.94 * pow(1.0 - nv, 5.0);
    vec3 glass = envChrome(reflect(-V, N), 0.0) * F;
    if (uStyle == 3) {
      // a soft lit iris: crimson, warmest in a ring round a dark pupil, a faint halo, one catch-light. No hard rings.
      float ir = (1.0 - smoothstep(AI - 0.07, AI + 0.01, ang)) * smoothstep(AP - 0.035, AP + 0.03, ang);
      vec3 em = CRIM * ir * (0.55 + 1.1 * edge * edge) + vec3(1.0, 0.50, 0.34) * ir * exp(-pow((ang - AP - 0.06) / 0.07, 2.0)) * 1.3;
      em += CRIM * exp(-pow((ang - AI) / 0.10, 2.0)) * 0.10;
      float cl = pow(max(dot(reflect(-V, N), normalize(vec3(-0.50, 0.52, 0.70))), 0.0), 220.0);
      col = em * (0.80 + 0.9 * uBeat + 0.4 * uBass) + vec3(1.0, 0.93, 0.86) * cl * 3.0 + CRIM * 0.006;
    } else if (uStyle == 0) {
      // black glass ball, a crimson iris lit from inside: brightest at its outer ring, a hot hair-line round the pupil
      vec3 em = CRIM * iris * (0.05 + 0.10 * edge) * pulse;
      em += CRIM * exp(-pow((ang - AI + 0.035) / 0.028, 2.0)) * 3.2 * pulse;      // the ring
      col = glass * 1.2 + em;
    } else {
      // an ember: hottest round the pupil, cooling outward, with dark flecks
      float heat = (1.0 - edge) * 0.55 + 0.42 + 0.20 * uBeat + 0.12 * uBass;
      vec3 c1 = mix(vec3(0.85, 0.036, 0.024), vec3(5.0, 0.8, 0.3), smoothstep(0.55, 1.1, heat));
      vec3 em = c1 * iris * (0.45 + 0.55 * fib) * (0.8 + 0.5 * uBeat);
      col = glass * 0.9 + em + vec3(0.003, 0.002, 0.002);
    }
    o = vec4(col, 1.0);
  }`;
  const MOUTH_VS = COMMON + `
  in vec3 aPos; in float aDepth; out float vDepth; out vec3 vWorld;
  void main() { vDepth = aDepth; vec4 w = uModel * vec4(aPos, 1.0); vWorld = w.xyz; gl_Position = uViewProj * w; }`;
  const MOUTH_FS = COMMON + `
  in float vDepth; in vec3 vWorld; out vec4 o; uniform int uStyle; uniform float uOpen;
  void main() {
    // nothing to see in a shut mouth; an open one shows light from inside, stronger the wider it is and with the music
    float g = pow(vDepth, 1.6) * uOpen;
    vec3 col = vec3(0.0);
    if (uStyle == 0) col = CRIM * g * g * (0.02 + 0.20 * uBeat + 0.06 * uMid);
    else if (uStyle == 1) col = mix(vec3(0.85, 0.036, 0.024), vec3(3.0, 0.3, 0.1), g * (0.3 + 0.7 * uBeat)) * g * g * (0.12 + 0.35 * uBass + 0.6 * uBeat);
    else if (uStyle == 3) col = uShade * uGain * (1.0 - clamp(uShatter * 1.5, 0.0, 1.0)) * (pow(1.0 - vDepth, 2.2) * (0.25 + 0.75 * uOpen) * (0.45 + 0.5 * uBeat + 0.35 * uMid) + g * 0.05);   // the inner lips glow, the throat is dark
    else col = CRIM * g * (0.05 + 0.25 * uBeat);
    o = vec4(col, 1.0);
  }`;

  // ------------------------------------------------------------------------------------------------ PARTICLE FACE
  // 150,000 points that live ON his face: each one is tied to a triangle of the smooth mask, so it follows every
  // expression exactly. They are small and many (density reads as a surface, not as dots), packed three times as
  // tightly on lids, lips and brows (so the features draw themselves in light), lit like a solid (a key light and a
  // rim), and have a lens: points in front of or behind the focus plane get larger and fainter. A big hit throws them
  // off the face along its surface normal and a swirl (a few fly far, most a little, so the face never vanishes),
  // and a spring pulls them back in about a second; every kick is a small version of that and a wave of white heat
  // across the face.
  const PART_VS = COMMON + `
  in vec3 aTri; in vec2 aBary; in vec4 aRnd; in vec3 aRest; in float aFeat;
  uniform sampler2D uPosTex, uNrmTex; uniform float uPx, uFocus, uDof; uniform int uMode; uniform vec3 uEyeC, uGaze; uniform float uEyeR, uEyeOpen;
  out vec4 vCol; out float vSoft;
  vec4 fetch(sampler2D t, float id) { int i = int(id + 0.5); return texelFetch(t, ivec2(i & 127, i >> 7), 0); }
  void main() {
    vec3 P, N; float act = 0.0, feat = aFeat; vec3 rest = aRest; float t = uTime;
    float burstK = 1.0;
    if (uMode == 0) {
      float b0 = aBary.x, b1 = aBary.y, b2 = 1.0 - b0 - b1;
      vec4 p0 = fetch(uPosTex, aTri.x), p1 = fetch(uPosTex, aTri.y), p2 = fetch(uPosTex, aTri.z);
      P = p0.xyz * b0 + p1.xyz * b1 + p2.xyz * b2; act = p0.w * b0 + p1.w * b1 + p2.w * b2;
      N = normalize(fetch(uNrmTex, aTri.x).xyz * b0 + fetch(uNrmTex, aTri.y).xyz * b1 + fetch(uNrmTex, aTri.z).xyz * b2);
      P += N * ((aRnd.x - 0.3) * 0.030);
    } else if (uMode == 1) {
      // the eye: aRest = (polar angle from the gaze, angle round it, kind)
      vec3 g = uGaze, t1 = normalize(cross(vec3(0.0, 1.0, 0.0), g)), t2 = cross(g, t1);
      float a = aRest.x, ph = aRest.y;
      N = normalize(g * cos(a) + (t1 * cos(ph) + t2 * sin(ph)) * sin(a));
      P = uEyeC + N * uEyeR; rest = uEyeC; feat = aRest.z; burstK = 0.12; act = 0.0;
    } else {
      // dust in the room: slow drift, wrapped in a box
      vec3 q = aRest + vec3(sin(t * 0.11 + aRnd.x * 6.3), t * (0.03 + 0.05 * aRnd.y), cos(t * 0.09 + aRnd.z * 6.3)) * vec3(0.3, 1.0, 0.3);
      q.y = mod(q.y + 5.0, 10.0) - 5.0; P = q; N = vec3(0.0, 0.0, 1.0); feat = 0.0; burstK = 0.0;
    }
    // shimmer: a slow flow along the face, a little more with the bass; single points twitch on the highs
    vec3 fl = vec3(sin(dot(rest, vec3(3.1, 1.7, 2.3)) + t * 1.3 + aRnd.y * 6.28), sin(dot(rest, vec3(2.2, 3.4, 1.1)) - t * 1.1 + aRnd.z * 6.28), sin(dot(rest, vec3(1.3, 2.6, 3.7)) + t * 0.9 + aRnd.w * 6.28));
    if (uMode != 2) P += fl * (0.004 + 0.012 * uBass + 0.03 * uHigh * step(0.86, aRnd.z)) * burstK * (uMode == 0 ? 1.0 : 3.0);
    // bursts
    vec3 c0 = vec3(0.0, -0.45, 0.2); float r = length(rest - c0);
    vec3 rnd3 = hash3(vec3(aRnd.xy * 91.7, aRnd.w * 37.1)) - 0.5;
    vec3 dir = normalize(N * 0.9 + normalize(rest - c0 + 1e-3) * 0.45 + rnd3 * 0.9);
    float far = pow(aRnd.w, 4.0) * 1.7 + 0.03, heat = 0.0, off = 0.0;
    for (int i = 0; i < 4; i++) {
      float age = uHit[i].x - r * 0.035, s = uHit[i].y;
      if (age > 0.0) { float a = s * (exp(-age * 4.2) - exp(-age * 18.0)) * 1.15; off += a; heat += s * exp(-age * 4.5) * 0.45; P += cross(dir, vec3(0.0, 1.0, 0.0)) * (a * far * 0.35 * sin(age * 3.0 + aRnd.x * 6.28)); }
    }
    for (int i = 0; i < 8; i++) {
      float age = uKick[i].x - r * 0.05, s = uKick[i].y;
      if (age > 0.0) { off += s * (exp(-age * 6.0) - exp(-age * 22.0)) * 0.05; float x = r - uKick[i].x * 3.6; heat += s * exp(-x * x * 7.0) * exp(-uKick[i].x * 2.2) * 0.8; }
    }
    P += dir * (off * far * burstK);
    vec4 w = uModel * vec4(P, 1.0);
    vec3 Nw = normalize(mat3(uModel) * N), V = normalize(uCam - w.xyz);
    vec4 clip = uViewProj * w; gl_Position = clip;
    // light: a key from the upper left, a rim; the far side of the face stays dark
    float nv = dot(Nw, V), key = pow(max(dot(Nw, normalize(vec3(-0.35, 0.45, 0.82))), 0.0), 1.6), rim = pow(1.0 - abs(nv), 3.0);
    float lit = (0.34 + 0.95 * key + 1.10 * rim) * (nv < 0.0 ? 0.10 : 1.0);
    float tw = 0.72 + 0.5 * sin(t * (2.0 + aRnd.y * 7.0) + aRnd.z * 40.0) + step(0.93, aRnd.x) * uHigh * 2.2;
    float flying = clamp(off * far * 3.0, 0.0, 1.0);
    float h = clamp(feat * 0.42 + act * 0.35 + heat * 0.7 + 0.08 * uBeat, 0.0, 1.6);
    vec3 col = mix(CRIM, vec3(1.0, 0.56, 0.40), smoothstep(0.25, 0.75, h)); col = mix(col, vec3(1.0, 0.90, 0.80), smoothstep(0.7, 1.3, h));
    float bright = (0.50 + 1.1 * feat + 0.5 * act) * lit * tw * (0.80 + 0.45 * uBeat + 0.5 * heat) * (1.0 - 0.45 * flying);
    if (uMode == 1) { bright = (0.3 + 1.7 * feat) * tw * (0.8 + 0.9 * uBeat + 0.4 * uBass) * (nv < 0.0 ? 0.0 : 1.0) * smoothstep(0.02, 0.25, uEyeOpen); col = mix(CRIM, vec3(1.0, 0.62, 0.45), feat * feat); }
    if (uMode == 2) { bright = 0.20 * (0.5 + aRnd.w) * (0.6 + 0.8 * uLevel); col = mix(CRIM, vec3(1.0, 0.7, 0.6), aRnd.x * 0.5); }
    // lens: size from distance, blur from the focus plane
    float dist = clip.w, base = uPx * (0.55 + 1.5 * aRnd.x * aRnd.x) * (1.0 + 0.5 * feat) * (uMode == 2 ? 1.6 : 1.0) / dist;
    float coc = abs(dist - uFocus) * uDof / dist;
    float size = max(base + coc, 1.6);
    bright *= (base * base) / (size * size) * max(1.0, 2.56 / max(base * base, 0.01) * 0.0 + 1.0);
    gl_PointSize = size; vSoft = clamp(coc / size, 0.0, 1.0);
    vCol = vec4(col * bright, 1.0);
  }`;
  const PART_FS = `#version 300 es
  precision highp float; in vec4 vCol; in float vSoft; out vec4 o;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard;
    float core = exp(-r2 * 3.5), disc = smoothstep(1.0, 0.75, r2) * 0.55;       // in focus: a soft core; out of focus: a flat disc (bokeh)
    o = vec4(vCol.rgb * mix(core, disc, vSoft), 1.0);
  }`;


  // ------------------------------------------------------------------------------------------------ PARTICLE FACE, second round
  // What changed against the first particle look (kept above as 'particles' for the before / after):
  //   * FORM: a point's colour is its light. The key light is chrome-white, the shadow side and the rim are crimson, so
  //     the head turns from silver to red across its form and reads as a solid. Under the points the face itself is
  //     drawn as a very dim, smooth, lit surface: the cheeks and forehead are a soft volume, not noise.
  //   * FEATURES are LINES: the lip line, the lid lines and the brow lines are dense, larger, brighter points that hold
  //     their place through a burst; nose bridge, cheekbones and jaw get more points than flat skin.
  //   * FEWER, LARGER points and almost no per-point flicker; points that would be nearly dark are not drawn at all
  //     (fine noise in the dark is what a video encoder destroys first).
  //   * MUSIC: bass lifts the skin outward (and a kick is a short breath), mids drive a slow drift along the face,
  //     highs flash single points. A burst turns the flying points crimson, never white.
  //   * EDGE: the outline fades out, and a sparse tail of points continues the head backward, so a turned head has
  //     no shell edge.
  const PART2_VS = COMMON + `
  in vec3 aTri; in vec3 aBary; in vec4 aRnd; in vec3 aRest; in float aFeat; in vec4 aM;
  uniform sampler2D uPosTex, uNrmTex; uniform float uPx, uFocus, uDof; uniform int uMode;
  uniform float uKey, uAmb, uRim, uLine, uLineWhite, uBurst, uKickAmt, uSparkle, uWave;
  uniform vec3 uEyeC, uGaze; uniform float uEyeR, uEyeOpen;
  out vec4 vCol; out float vSoft;
  vec4 fetch(sampler2D t, float id) { int i = int(id + 0.5); return texelFetch(t, ivec2(i & 127, i >> 7), 0); }
  // VISUALIZER: where a point of the face goes when the face is broken up (world space), its colour and its size.
  // Four formations (uVizF), all made of the same points, so the face breaks into any of them and comes back:
  //   0 ORB      an orb that swells with the bass, a crown of 48 radial bars, rings that fly out of the depth
  //   1 TUNNEL   a spiral funnel the lens flies down (log depth: an endless zoom), a spoked wheel travelling ahead of it
  //   2 YINYANG  two swarms in two colours that orbit, chase and collide; where they meet the colours mix
  //   3 RIDGES   a landscape of ridge lines rolling toward the lens, the song as its mountains
  //   4 BLACKHOLE  a disc of matter round a dark middle, bent over it by its pull; jets on a drop
  //   5 HELIX    two strands winding up through the frame, the song in the rungs between them
  // uVizMove = (how far down the tunnel, the turn of the yin-yang, how far over the ridges, the turn of the disc / the helix), integrated from the music
  // on the page; uVizEnv = (kick envelope 0..1, drop envelope 0..1, 0, 0).
  uniform int uVizFa, uVizFb; uniform float uVizK; uniform vec4 uVizEnv, uVizMove; uniform vec3 uVizC1, uVizC2;
  mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
  // a place on the picture plane (z = 0), pushed along the line of sight to a depth: it stays where it is in the
  // picture, but the lens sees its real size, blur and parallax
  vec3 onRay(vec3 p0, float dv) { return uCam + (p0 - uCam) * (dv / 14.0); }
  float ridgeH(float x, float W, float jf, float t) {
    float ax = abs(x);
    float amp = (0.16 + 0.95 * uBass) * exp(-x * x * 3.4) + (0.10 + 0.50 * uMid) * exp(-(ax - 0.40) * (ax - 0.40) * 16.0) + (0.04 + 0.34 * uHigh) * exp(-(ax - 0.74) * (ax - 0.74) * 26.0);
    float n = vnoise(vec3(x * 3.4 + 7.0, W * 0.36, t * 0.12)); n = 1.0 - abs(n * 2.0 - 1.0);
    float n2 = vnoise(vec3(x * 10.0, W * 0.9, 3.0 + t * 0.25));
    float h = amp * (0.20 + 0.90 * n * n + 0.12 * n2) * 0.62;
    for (int i = 0; i < 8; i++) { float age = uKick[i].x, d = (jf - age * 15.0) / 2.6; h += uKick[i].y * exp(-d * d) * exp(-age * 1.1) * 0.30 * exp(-x * x * 1.5); }
    return h;
  }
  vec2 ridgeXY(float x, float jf, float h, out float pers) {
    pers = 1.0 / (1.0 + 1.9 * jf / 30.0);
    float yb = -2.88 + 3.80 * (1.0 - pers) / 0.6552, room = max(0.94 - yb, 0.02), hh = h * 1.55 * pers;      // a ridge never reaches the horizon blade: its height runs out softly
    return vec2(x * 2.35 * pers, yb + room * (1.0 - exp(-hh / room)));
  }
  void vizEval(int f, vec4 r, float t, vec3 SH, vec3 CHROME, out vec3 pos, out vec3 col, out float psz) {
    vec3 c = vec3(0.0, -0.55, 0.0); psz = 1.0;
    if (f == 1) {
      // ---- HYPNOTIC TUNNEL
      float push = uVizEnv.x, open = uVizEnv.y, trav = uVizMove.x;
      vec2 swayF = vec2(sin(t * 0.37) + 0.5 * sin(t * 0.71 + 1.0), cos(t * 0.29) + 0.5 * sin(t * 0.53)) * 0.20;
      if (r.w < 0.20) {
        // the wheel: a rim, six curved spokes, a hub; it turns against the funnel and the lens closes on it with every kick
        float k = r.w / 0.20, Rw = 0.56 * (1.0 + 0.08 * uBeat + 0.34 * push + 0.25 * open), a, q, lv;
        if (k < 0.32) { q = (k < 0.22 ? 1.0 : 0.87) + (r.z - 0.5) * 0.018; a = r.x * 6.2832; lv = 0.75 + 0.6 * uBeat; }
        else if (k < 0.88) { float arm = floor(r.x * 6.0); q = 0.12 + 0.74 * r.y; a = arm / 6.0 * 6.2832 + 2.5 * q + (r.z - 0.5) * 0.085 / max(q, 0.2); float wv = fract(q * 1.0 - t * 0.9); lv = 0.40 + 0.5 * uMid + 0.9 * exp(-wv * 7.0) * (0.4 + uBass); }
        else { q = 0.105 * sqrt(r.y); a = r.x * 6.2832; lv = (0.20 + 0.16 * uBass) * (0.45 + 0.55 * r.y); }
        a -= uVizMove.y * 1.25;
        vec2 w2 = vec2(cos(a), sin(a)) * q * Rw; float tl = 0.50 * sin(t * 0.53), tl2 = 0.35 * sin(t * 0.41 + 2.0);
        float dz = sin(tl) * w2.x + sin(tl2) * w2.y; w2.x *= cos(tl); w2.y *= cos(tl2);
        pos = onRay(vec3(c.xy + swayF * 0.55 + w2, 0.0), 13.2 - dz * 2.0);
        col = mix(CHROME, uAccent, 0.5) * (k < 0.88 ? 0.26 + 1.0 * lv : lv) * (k < 0.88 ? 1.0 - 0.45 * smoothstep(0.34, 0.12, q) * smoothstep(0.5, 1.0, uBass) : 1.0); psz = 1.05;
      } else {
        float u = fract(r.x - trav), ang, lv, lowB = 1.0 - smoothstep(0.15, 0.60, uBass); vec3 base = SH * 1.55;
        if (r.w < 0.70) {
          // four spiral bands on the wall of the funnel: the hypnotic spiral
          float arm = floor(r.y * 4.0), e = abs(r.z - 0.5) * 2.0;
          ang = 6.2832 * (arm / 4.0 + (r.z - 0.5) * 0.125 + 1.0 * r.x) + 0.28 * sin(u * 9.0 - t * 1.4) * (0.3 + uMid);
          lv = (0.82 + 0.48 * uBass + 0.35 * uLevel + 0.22 * lowB) * (0.60 + 0.9 * smoothstep(0.70, 1.0, e));
          base = mix(mix(SH * 1.55, uVizC2 * 1.25, 0.45 * lowB), mix(SH, mix(CHROME, uVizC2, 0.65 * lowB), 0.55) * 1.1, smoothstep(0.80 - 0.18 * lowB, 1.0, e));
        } else if (r.w < 0.93) {
          // rings: the ribs of the funnel, lit by the beat
          float ring = floor(r.x * 14.0); u = fract((ring + 0.5) / 14.0 - trav); ang = r.y * 6.2832 + ring * 1.3;
          lv = 0.10 + 0.70 * uBeat * (mod(ring, 2.0) < 0.5 ? 1.0 : 0.40) + 0.15 * uHigh; base = mix(SH, CHROME, 0.6);
        } else { ang = r.y * 6.2832; lv = 0.55 + 0.9 * uHigh; base = CHROME; }
        float rho = 3.5 * exp(-u * 3.0 * (1.0 - 0.30 * open));
        if (r.w >= 0.93) rho *= 0.22 + 0.62 * r.z;
        // every kick sends a ring of light down the funnel
        for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = (u - 0.04 - age * 0.80) * 8.0; lv += uKick[i].y * exp(-x * x) * exp(-age * 1.5) * 1.5; }
        float fog = smoothstep(1.0, 0.50, u) * smoothstep(0.0, 0.05, u) * mix(0.10, 1.0, smoothstep(0.22, 1.25, rho));
        pos = onRay(vec3(c.xy + swayF * smoothstep(0.05, 0.9, u) + vec2(cos(ang), sin(ang)) * rho, 0.0), mix(7.5, 22.0, pow(u, 0.6)));
        col = base * (lv * fog) + uAccent * (open * 0.5 * fog * lv);
      }
      return;
    }
    if (f == 2) {
      // ---- YIN-YANG COLLISION
      float sys = step(0.5, r.x), rx = fract(r.x * 2.0), kc = uVizEnv.x, mg = uVizEnv.y, kind = r.w;
      float R = 1.20 * (1.0 + 0.07 * uBass) * (1.0 - 0.36 * mg), th = uVizMove.y + sys * 3.14159, lv = 1.0, z = 0.0;
      float hr = 0.5 * R * (1.0 - clamp(0.62 * kc + 0.20 * mg, 0.0, 0.80));       // the heads' orbit: a kick throws them at each other
      vec2 hc = vec2(cos(th), sin(th)) * hr, p;
      vec3 h3 = hash3(vec3(r.yz * 41.0, r.x * 13.0));
      vec3 own = sys < 0.5 ? uVizC1 : uVizC2; float spark = 0.0;
      if (kind < 0.30) {
        // the head: a disc of points with a hole for the other colour's eye
        float q = mix(0.185, 0.47, sqrt(r.y)), a = r.z * 6.2832; p = hc + vec2(cos(a), sin(a)) * q * R;
        z = (h3.x - 0.5) * 0.55 * R * sqrt(max(0.0, 1.0 - q * q / 0.2209)); lv = 0.85 + 0.25 * h3.y;
      } else if (kind < 0.74) {
        // the tail: it trails round the orbit and thins to a point; the points stream along it
        float u = pow(fract(rx + t * 0.045), 1.25), a = th - 0.30 - u * (2.95 + 2.6 * mg);
        float rc = mix(hr + 0.10 * R, R * (0.58 + 0.38 * u), smoothstep(0.0, 0.32, u)), w = R * (0.37 * pow(1.0 - u, 1.35) + 0.012);
        p = vec2(cos(a), sin(a)) * (rc + (r.y - 0.5) * 2.0 * w); z = (h3.x - 0.5) * w * 0.9; lv = (0.30 + 0.70 * pow(1.0 - u, 0.8)) * min(1.0, w / (0.10 * R)) * smoothstep(1.0, 0.85, u) * smoothstep(0.0, 0.14, u);
      } else if (kind < 0.80) {
        float q = 0.105 * R * sqrt(r.y), a = r.z * 6.2832; p = -hc + vec2(cos(a), sin(a)) * q; lv = 1.5; psz = 1.15;      // the eye, in the other one's head
      } else if (kind < 0.87) {
        float a = th - r.y * 3.14159; p = vec2(cos(a), sin(a)) * R * (1.045 + (r.z - 0.5) * 0.012); lv = 0.28 + 0.55 * uBeat; psz = 0.8;      // the circle that holds them
      } else {
        // sparks: every collision throws them out of the middle, in the mixed colour
        float age = uKick[0].x, s = uKick[0].y; vec2 d = normalize(h3.xy - 0.5 + 1e-3);
        float dist = (0.20 + 2.4 * h3.z * h3.z) * (1.0 - exp(-age * 3.0));
        p = d * dist; z = (r.y - 0.5) * dist * 1.2; lv = s * exp(-age * 2.4) * 2.0; spark = 1.0; psz = 0.9;
      }
      vec3 q3 = vec3(p, z); q3.yz = rot2(0.42 * sin(t * 0.31)) * q3.yz; q3.xz = rot2(0.50 * sin(t * 0.23 + 1.0)) * q3.xz;
      pos = c + q3;
      vec3 mixc = mix((uVizC1 + uVizC2) * 0.55, uVizC2, 0.35);
      float dO = length(p + hc), dC = length(p);
      float mk = clamp(exp(-dO * dO / (0.20 * R * R)) * (0.20 + 2.2 * kc) + spark, 0.0, 1.0);
      col = mix(own, mixc, mk) * ((0.34 + 0.45 * uBass + 0.30 * uLevel) * lv * (1.0 - 0.35 * clamp(0.7 * kc, 0.0, 1.0) * (1.0 - spark)) * (1.0 + 0.35 * mg)) + mix(mixc, uAccent, 0.25) * ((kc * 1.1 + mg * 0.35) * exp(-dC * dC / (0.05 * R * R)) * (1.0 - spark));
      return;
    }
    if (f == 3) {
      // ---- RIDGES
      float scroll = uVizMove.z;
      if (r.w < 0.90) {
        float j0 = floor(r.x * 30.0), jf = mod(j0 - scroll, 30.0), W = jf + scroll, x = r.y * 2.0 - 1.0, pers, p2;
        float h = ridgeH(x, W, jf, t); vec2 xy = ridgeXY(x, jf, h, pers);
        // a nearer ridge hides what is behind it
        float vis = 1.0;
        for (int k = 1; k <= 4; k++) {
          float jn = jf - float(k); if (jn < 0.0) break;
          float pn = 1.0 / (1.0 + 1.9 * jn / 30.0), xn = xy.x / (2.35 * pn);
          if (abs(xn) < 1.0) { vec2 o = ridgeXY(xn, jn, ridgeH(xn, W - float(k), jn, t), p2); vis *= smoothstep(-0.035, 0.015, xy.y - o.y); }
        }
        float q = jf / 30.0, wave = 0.0;
        for (int i = 0; i < 8; i++) { float age = uKick[i].x, d = (jf - age * 15.0) / 2.6; wave += uKick[i].y * exp(-d * d) * exp(-age * 1.1); }
        float fade = smoothstep(0.0, 1.6, jf) * smoothstep(30.0, 23.0, jf) * smoothstep(1.0, 0.80, abs(x));
        pos = onRay(vec3(c.x + xy.x, xy.y + (r.z - 0.5) * 0.010 * pers, 0.0), mix(11.0, 20.0, q));
        col = mix(SH * 1.3, CHROME * 1.1, smoothstep(0.42, 1.0, h)) * min(0.34 + 0.62 * h + 0.5 * wave, 0.95) * mix(1.0, 0.42, q) * fade * vis + uAccent * (wave * 0.22 * fade * vis);
        psz = 1.0;
      } else if (r.w < 0.95) {
        // the horizon: one blade of light, behind the last ridge
        float x = r.x * 2.0 - 1.0;
        pos = onRay(vec3(x * 1.15, 0.985 + (r.z - 0.5) * 0.006, 0.0), 21.0);
        col = mix(SH, uAccent, 0.5) * (0.35 + 1.3 * uBeat + 0.5 * uBass) * exp(-x * x * 2.6); psz = 0.8;
      } else {
        // sparks that rise off the horizon with the highs
        float life = fract(r.x + t * (0.06 + 0.08 * r.y)), x = (r.z * 2.0 - 1.0) * 1.5;
        pos = onRay(vec3(x + 0.08 * sin(t * 0.7 + r.y * 30.0), 1.0 + life * (0.35 + 0.55 * r.y), 0.0), 19.0);
        col = mix(SH, CHROME, 0.6) * ((0.10 + 0.9 * uHigh) * (1.0 - life) * (1.0 - life) * smoothstep(0.0, 0.08, life) * exp(-x * x * 1.3) * (0.5 + 0.5 * sin(t * 6.0 + r.x * 90.0))); psz = 0.7;
      }
      return;
    }
    if (f == 4) {
      // ---- BLACK HOLE: a disc of matter in lanes (the inner ones faster), seen almost edge on; the half of it that passes
      // behind the hole is bent up over it (the arc), a thin ring of light hugs the dark, two jets leave along the axis,
      // and the far stars slide round it. Nothing is drawn inside the dark: additive points cannot make black.
      float kc = uVizEnv.x, dr = uVizEnv.y, rot = uVizMove.w * 0.5, lv = 0.0, Rs = 0.50 * (1.0 + 0.05 * uBass - 0.10 * kc);
      vec3 h3 = hash3(vec3(r.xy * 53.0, r.z * 17.0)), q3;
      float tilt = 0.30 + 0.07 * sin(t * 0.21), roll = 0.24 + 0.08 * sin(t * 0.17 + 1.0), ct = cos(tilt), st = sin(tilt);
      if (r.w < 0.70) {
        float lane = floor(r.x * 18.0), ql = (lane + r.y) / 18.0, q = Rs * 1.16 + 1.42 * pow(ql, 1.35) * (1.0 + 0.10 * dr), ks = 1.0 + floor(5.0 * (1.0 - lane / 18.0) * (1.0 - lane / 18.0) + 0.5);
        float a0 = h3.x * 6.2832, a = a0 - rot * ks;
        float clump = vnoise(vec3(cos(a0) * 2.2 + lane * 0.9, sin(a0) * 2.2, lane * 0.37)), arms = 0.5 + 0.5 * sin(2.0 * a0 + ql * 7.0);
        vec3 P = vec3(cos(a) * q, (r.z - 0.5) * 0.045 * (0.5 + q) * (1.0 + 1.2 * uMid), sin(a) * q);
        q3 = vec3(P.x, P.y * ct - P.z * st, P.z * ct + P.y * st);
        float dop = smoothstep(-1.0, 1.0, -cos(a)), hot = 1.0 - ql;                    // the side that turns toward the lens is brighter and whiter
        lv = (0.25 + 0.28 * uBass * hot + 0.13 * uLevel) * (0.22 + 1.00 * clump * clump + 0.35 * arms) * mix(0.22, 1.30, dop * dop) * (0.30 + 0.80 * hot * hot) * (0.55 + 0.95 * ql);
        for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = (ql - age * 0.85) * 7.0; lv += uKick[i].y * exp(-x * x) * exp(-age * 1.7) * 0.55; }      // a kick: a ring of light out through the disc
        float heat = clamp(hot * hot * (0.50 + 0.85 * dop) + 0.10 * dop + 0.3 * kc, 0.0, 1.0);
        col = (heat < 0.6 ? mix(uVizC1 * 1.15, uVizC2, heat / 0.6) : mix(uVizC2, mix(uVizC2, CHROME, 0.45) * 1.15, (heat - 0.6) / 0.4)) * lv; psz = 1.05;      // the first colour far out, the second where it is hot, white only at the hottest
        // behind the hole its light is bent round the dark and reaches the lens over the top of it: the nearer a point's
        // line of sight passes to the dark, the further it is pushed out (far from it, not at all)
        float rho = max(length(q3.xy), 1e-3), R0 = Rs * 1.06, back = smoothstep(0.0, 0.30 * q, -P.z);
        float rn = pow(rho * rho * rho + R0 * R0 * R0 * 1.12, 1.0 / 3.0);
        q3.xy *= mix(1.0, rn / rho, back); q3.z = mix(q3.z, -0.02, back);
        col *= 1.0 + 0.9 * back * exp(-(rho - 0.3 * Rs) * (rho - 0.3 * Rs) * 6.0);              // the arc is the brightest part of the far side
      } else if (r.w < 0.79) {
        // the ring of light at the edge of the dark, and the fainter arc below it (the underside of the far disc)
        float a = r.x * 6.2832, low = step(0.62, r.y), rad = Rs * (low > 0.5 ? 1.09 + 0.34 * r.z * r.z : 1.0 + 0.085 * r.z * r.z * r.z);
        if (low > 0.5) a = 3.14159 + (0.10 + 0.80 * r.x) * 3.14159;
        q3 = vec3(cos(a) * rad, sin(a) * rad, 0.0);
        lv = low > 0.5 ? 0.20 * (1.0 - r.z) * sin((a - 3.14159)) * (0.5 + uBass) : (0.36 + 0.50 * uBeat + 0.9 * kc) * mix(0.40, 1.25, smoothstep(-1.0, 1.0, -cos(a))) * (1.0 - 0.6 * r.z);
        col = (low > 0.5 ? mix(uVizC1, uVizC2, 0.5) : mix(uVizC2, uAccent, 0.6)) * lv; psz = low > 0.5 ? 0.9 : 0.85;
      } else if (r.w < 0.85) {
        // the jets: matter thrown out along the axis; faint with the highs, they fire on a drop
        float sgn = r.y < 0.5 ? -1.0 : 1.0, s = fract(r.x + t * (0.22 + 0.5 * uLevel)), hgt = Rs * 1.12 / ct + 3.0 * pow(s, 1.25), rc = (0.020 + 0.20 * s) * sqrt(h3.y), b = h3.x * 6.2832 + s * 5.0;
        vec3 P = vec3(cos(b) * rc, sgn * hgt, sin(b) * rc);
        q3 = vec3(P.x, P.y * ct - P.z * st, P.z * ct + P.y * st);
        lv = (0.015 + 0.10 * uHigh + 1.0 * dr + 0.10 * kc) * pow(1.0 - s, 2.2) * smoothstep(0.0, 0.10, s) * (0.6 + 0.4 * sin(s * 40.0 - t * 9.0 + h3.z * 6.0));
        col = mix(uVizC2, uAccent, 0.6) * lv; psz = 0.85;
      } else {
        // the far stars: they drift across, and their light is pushed round the dark as they pass it
        vec2 sp = vec2(fract(r.x + t * 0.012) * 2.0 - 1.0, r.y * 2.0 - 1.0) * vec2(1.75, 2.9); float rr = max(length(sp), 1e-3);
        sp *= (rr + Rs * Rs * 2.0 / rr) / rr;
        pos = onRay(vec3(c.xy + sp, 0.0), 15.2);
        col = CHROME * ((0.10 + 0.55 * uHigh) * step(0.62, h3.z) * (0.6 + 0.4 * sin(t * (2.0 + 5.0 * h3.x) + h3.y * 40.0)) * smoothstep(1.0, 0.85, abs(fract(r.x + t * 0.012) * 2.0 - 1.0))); psz = 0.75;
        return;
      }
      q3.xy = rot2(roll) * q3.xy;
      pos = c + q3;
      return;
    }
    if (f == 5) {
      // ---- HELIX: two strands in the two colours wind up through the whole frame, in real depth; the rungs between them
      // are the song (bass at the foot, highs at the top; each fills from its strands toward the middle with its band);
      // a kick sends light climbing the strands, a drop pulls the strands apart and the rungs break in the middle.
      float kc = uVizEnv.x, op = uVizEnv.y, rot = uVizMove.w, lv, turns = 2.2, Rh = 0.60 * (1.0 + 0.10 * uBass + 0.40 * op), H0 = -2.95, H1 = 2.95;
      vec3 h3 = hash3(vec3(r.xz * 47.0, r.y * 19.0)), q3;
      if (r.w < 0.44) {
        float s = r.x, sys = step(0.5, r.y), ph = s * turns * 6.2832 + rot + sys * 3.14159, tube = (0.028 + 0.050 * uBass) * sqrt(h3.x), ta = h3.y * 6.2832;
        q3 = vec3(cos(ph) * (Rh + tube * cos(ta)), mix(H0, H1, s) + tube * sin(ta), sin(ph) * (Rh + tube * cos(ta)));
        lv = 0.34 + 0.30 * uLevel + 0.25 * uBass;
        for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = (s - 0.02 - age * 0.75) * 7.0; lv += uKick[i].y * exp(-x * x) * exp(-age * 1.3) * 1.9; }
        col = (sys < 0.5 ? uVizC1 : uVizC2) * lv; psz = 1.0;
      } else if (r.w < 0.90) {
        float N = 46.0, j = floor(r.x * N), s = (j + 0.5) / N, ph = s * turns * 6.2832 + rot, u = r.y * 2.0 - 1.0;
        float bl = mix(mix(uBass, uMid, smoothstep(0.12, 0.48, s)), uHigh, smoothstep(0.52, 0.92, s));
        float fill = clamp(0.14 + 1.40 * bl * (0.55 + 0.45 * sin(j * 91.0 + t * (2.0 + 3.0 * bl))) + 0.25 * kc - 0.45 * op, 0.04, 1.0);
        float lit = smoothstep(1.0 - fill - 0.03, 1.0 - fill + 0.03, abs(u));
        q3 = vec3(cos(ph) * Rh * u, mix(H0, H1, s) + (r.z - 0.5) * 0.016, sin(ph) * Rh * u);
        lv = lit * (0.20 + 0.75 * bl) + 0.022;
        col = mix(uVizC2, uVizC1, u * 0.5 + 0.5) * lv + uAccent * (lit * smoothstep(0.10, 0.0, abs(abs(u) - (1.0 - fill))) * 0.30 * bl); psz = 0.9;      // the tip of each bar is hot
      } else {
        float s = fract(r.x + t * (0.015 + 0.03 * r.y)), ang = r.z * 6.2832 + rot, rad = 0.95 + 0.9 * h3.x;
        q3 = vec3(cos(ang) * rad, mix(H0, H1, s), sin(ang) * rad);
        col = CHROME * ((0.08 + 0.6 * uHigh) * (0.5 + 0.5 * sin(t * (2.0 + 5.0 * h3.y) + h3.z * 40.0)) * smoothstep(0.0, 0.08, s) * smoothstep(1.0, 0.92, s)); psz = 0.75;
      }
      col *= 0.40 + 0.60 * smoothstep(-0.7, 0.7, q3.z);                                  // the far side of the turn is dimmer: it reads as depth
      q3.yz = rot2(0.10) * q3.yz; q3.xy = rot2(0.16 * sin(t * 0.19)) * q3.xy;
      pos = c + q3;
      return;
    }
    // ---- ORB + CROWN + RINGS
    float lvl;
    if (r.w < 0.26) {
      vec3 d = normalize(hash3(vec3(r.xy * 37.0, r.z * 11.0)) - 0.5);
      lvl = 0.35 + 0.65 * uBass;
      pos = c + d * (0.34 + 0.22 * uBass + 0.16 * uBeat + 0.07 * sin(dot(d, vec3(4.0, 5.0, 3.0)) + t * 1.3) * (0.5 + uMid));
    } else if (r.w < 0.76) {
      float seg = floor(r.x * 48.0) / 48.0, a = seg * 6.2832 + t * 0.10, sy = sin(seg * 6.2832);
      lvl = mix(mix(uBass, uMid, smoothstep(-0.9, 0.0, sy)), uHigh, smoothstep(0.0, 0.9, sy));
      float jig = 0.55 + 0.45 * sin(seg * 91.0 + t * (2.0 + 3.0 * lvl)), h = 0.06 + (0.10 + 0.62 * lvl) * jig + 0.22 * uBeat * fract(seg * 7.3);
      float rad = 0.80 + r.y * h, a2 = a + (r.z - 0.5) * 0.085;
      pos = c + vec3(cos(a2) * rad, sin(a2) * rad, (r.z - 0.5) * 0.12);
    } else {
      float ring = floor(r.x * 9.0), ph = fract(ring / 9.0 + t * 0.11), a = r.y * 6.2832 + ring * 0.7 + t * 0.2;
      lvl = (0.25 + 0.75 * uBeat) * smoothstep(0.0, 0.15, ph) * (1.0 - smoothstep(0.8, 1.0, ph));
      float rad = 1.55 + 0.25 * sin(ring * 2.3) + 0.25 * uBass;
      pos = c + vec3(cos(a) * rad, sin(a) * rad, -7.5 + ph * 11.0);
    }
    col = mix(SH * 1.2, CHROME * 1.25, smoothstep(0.35, 0.95, lvl)) * (0.35 + 1.5 * lvl);
  }
  void main() {
    vec3 CHROME = uKeyCol;
    float t = uTime; vec3 P, N; float act = 0.0; vec3 rest = aRest;
    float lipIn = aM.x, lid = aM.y, brow = aM.z, bone = aM.w, rimM = aBary.z;
    if (uMode == 2) {
      vec3 q = aRest + vec3(sin(t * 0.11 + aRnd.x * 6.3), t * (0.03 + 0.05 * aRnd.y), cos(t * 0.09 + aRnd.z * 6.3)) * vec3(0.3, 1.0, 0.3);
      q.y = mod(q.y + 5.0, 10.0) - 5.0;
      vec4 w = uModel * vec4(q, 1.0); vec4 clip = uViewProj * w; gl_Position = clip;
      float base = uPx * 1.3 * (0.5 + aRnd.x) / clip.w, coc = abs(clip.w - uFocus) * uDof * 2.0 / clip.w, size = max(base + coc, 2.0);
      gl_PointSize = size; vSoft = clamp(coc / size, 0.0, 1.0);
      vCol = vec4(uShade * 0.16 * (0.4 + aRnd.w) * (0.5 + 0.8 * uLevel + 0.6 * uBeat + 0.8 * uPulse) * (base * base) / (size * size), 1.0); return;
    }
    float eyeB = 0.0, eyeW = 0.0, part = -1.0, flame = 0.0;
    if (uMode == 4) {
      // a part of the HEAD round the face (cranium, neck, ears, hair, horns, flames): fixed in head space, so it turns and
      // tilts with him in 3D. aRest = where, aTri = its normal, aM.x = which part, aBary.x = along a strand / horn / a flame's phase
      P = aRest; N = normalize(aTri); part = aM.x; lipIn = 0.0; lid = 0.0; brow = 0.0; bone = 0.0; rimM = 0.0;
      if (part > 2.5) {
        flame = fract(t * (0.30 + 0.45 * aBary.y) + aBary.x);
        float lick = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(atan(aRest.x, aRest.z + 0.9) * 9.0 + sin(t * 0.7) * 1.5 + aRest.y * 3.0), 2.0);      // tongues, not a haze
        float h = (0.30 + 0.85 * aRnd.x) * (0.50 + 0.75 * uBass + 0.55 * uBeat) * aBary.z * lick * 1.25;
        P += vec3(sin(t * 2.0 + aRnd.y * 20.0 + flame * 5.0) * 0.10 * flame, flame * h, -0.12 * flame + cos(t * 1.7 + aRnd.z * 17.0) * 0.06 * flame);
      } else if (part > 0.5 && part < 1.5) P += vec3(sin(t * 1.3 + aRnd.y * 6.28 + aBary.x * 2.0), 0.0, cos(t * 1.1 + aRnd.z * 6.28)) * (0.03 * aBary.x * (1.0 + 2.2 * uBass));
    } else if (uMode == 1) {
      // an eye made of the same points: aRest = (angle from the gaze, angle round it, brightness), aM.x = how white
      vec3 g = uGaze, t1 = normalize(cross(vec3(0.0, 1.0, 0.0), g)), t2 = cross(g, t1);
      N = normalize(g * cos(aRest.x) + (t1 * cos(aRest.y) + t2 * sin(aRest.y)) * sin(aRest.x));
      P = uEyeC + N * uEyeR; rest = uEyeC; eyeB = aRest.z; eyeW = aM.x; lipIn = 0.0; lid = 0.0; brow = 0.0; bone = 0.0; rimM = 0.0;
    } else {
      float b0 = aBary.x, b1 = aBary.y, b2 = 1.0 - b0 - b1;
      vec4 p0 = fetch(uPosTex, aTri.x), p1 = fetch(uPosTex, aTri.y), p2 = fetch(uPosTex, aTri.z);
      P = p0.xyz * b0 + p1.xyz * b1 + p2.xyz * b2; act = p0.w * b0 + p1.w * b1 + p2.w * b2;
      N = normalize(fetch(uNrmTex, aTri.x).xyz * b0 + fetch(uNrmTex, aTri.y).xyz * b1 + fetch(uNrmTex, aTri.z).xyz * b2);
    }
    // the gradient across the face: one shade at the chin, another at the forehead, drifting slowly
    vec3 SH = mix(uShade, uShade2, smoothstep(-1.5, 0.8, rest.y + 0.30 * sin(rest.x * 1.7 + t * 0.35)));
    // the lines of the face: lips, lids, brows
    float lLip = smoothstep(0.50, 0.88, lipIn), lLid = smoothstep(0.55, 0.90, lid), lBrow = smoothstep(0.74, 0.96, brow);
    float line = max(lLip, max(lLid, lBrow * 0.75));
    float feat = uMode == 1 || uMode == 4 ? 0.0 : aFeat;
    float hold = uMode == 1 ? 0.75 : uMode == 4 ? (part > 1.5 && part < 2.5 ? 0.85 : 0.25) : clamp(max(line, feat * 0.55), 0.0, 1.0);    // lines keep their place when the skin flies
    float tail = 0.0;
    if (uMode == 3) {
      // the tail: the head goes on behind the edge of the mask, thinning out
      tail = pow(aRnd.w, 1.3) * 1.25;
      P.z -= tail; P.xy *= 1.0 - 0.20 * tail * tail; P += (hash3(vec3(aRnd.xyz * 53.1)) - 0.5) * (0.05 + 0.16 * tail);
      hold = 0.0; line = 0.0;
    } else if (uMode == 0) P += N * ((aRnd.x - 0.3) * 0.028 * (1.0 - line));
    // bass: the skin lifts; mids: a slow drift along the face
    vec3 fl = vec3(sin(dot(rest, vec3(3.1, 1.7, 2.3)) + t * 0.8 + aRnd.y * 6.28), sin(dot(rest, vec3(2.2, 3.4, 1.1)) - t * 0.7 + aRnd.z * 6.28), sin(dot(rest, vec3(1.3, 2.6, 3.7)) + t * 0.6 + aRnd.w * 6.28));
    fl -= N * dot(fl, N);
    P += (N * (0.030 * uBass * aRnd.y) + fl * (0.004 + 0.030 * uMid)) * (1.0 - hold);
    // bursts (big hits) and breaths (kicks): out fast, back on a spring
    vec3 c0 = vec3(0.0, -0.45, 0.2); float r = length(rest - c0);
    vec3 rnd3 = hash3(vec3(aRnd.xy * 91.7, aRnd.w * 37.1)) - 0.5;
    vec3 dir = normalize(N * 0.9 + normalize(rest - c0 + 1e-3) * 0.45 + rnd3 * 0.9);
    float far = pow(aRnd.z, 4.0) * 1.7 + 0.03, off = 0.0, kOff = 0.0, wave = 0.0;
    for (int i = 0; i < 4; i++) {
      float age = uHit[i].x - r * 0.02, s = uHit[i].y;
      if (age > 0.0) { float a = s * (exp(-age * 4.4) - exp(-age * 26.0)) * uBurst; off += a; P += cross(dir, vec3(0.0, 1.0, 0.0)) * (a * far * 0.4 * sin(age * 3.0 + aRnd.x * 6.28)) * (1.0 - hold); }
    }
    for (int i = 0; i < 8; i++) {
      float age = uKick[i].x, s = uKick[i].y;
      kOff += s * (exp(-age * 7.0) - exp(-age * 30.0)) * uKickAmt;
      float x = r - age * 4.5; wave += s * exp(-x * x * 6.0) * exp(-age * 2.6);
    }
    float move = (off * far + kOff * (0.3 + 0.7 * aRnd.z)) * (1.0 - 0.85 * hold);    // a kick lifts every point a little; only a big hit throws some far
    P += dir * move;
    // gifts and chat: each impact blasts the points round it off the face (features too) and lets them come back;
    // a shatter throws everything
    vec3 impCol = vec3(0.0); float impMove = 0.0;
    vec3 at0 = uMode == 1 ? uEyeC : aRest;      // (for a head part aRest is its own place in head space)
    for (int i = 0; i < 10; i++) {
      if (i >= uNImp) break;                                             // no gift landing: no work
      float age = uImpT[i].x, sI = uImpT[i].y;
      if (sI > 0.0 && age >= 0.0 && age < 6.0) {
        vec3 dv = at0 - uImp[i].xyz; float wI = exp(-dot(dv, dv) / (uImp[i].w * uImp[i].w));
        float aI = sI * wI * (exp(-age * uImpT[i].z) - exp(-age * 22.0));
        vec3 dI = normalize(normalize(dv + 1e-3) * 0.8 + N * 0.9 + rnd3 * 0.9);
        P += dI * aI * (0.20 + 1.7 * aRnd.z * aRnd.z) * (1.0 - 0.40 * hold); impMove += aI;
        impCol += uImpC[i] * (wI * sI * exp(-age * 5.0));
        float bl = uImpT[i].w;                                           // a gift: an explosion
        if (bl > 0.0) {
          float dI2 = length(dv), rg = (dI2 - age * (1.9 + 0.5 * bl)) / (0.055 + 0.02 * bl);
          impCol += mix(uImpC[i], vec3(1.0, 0.95, 0.9), 0.55) * (exp(-rg * rg) * exp(-age * 3.0) * (0.95 + 0.30 * bl));      // the shock ring, over the face
          impCol += mix(uImpC[i], CRIM, clamp(age * 1.2, 0.0, 1.0)) * (wI * exp(-age * 1.5) * 0.30 * min(bl, 2.0));            // the scorch: it glows on for a second
        }
      }
    }
    P += dir * uShatter * (0.22 + 2.4 * aRnd.z * aRnd.z) + cross(dir, vec3(0.0, 1.0, 0.0)) * uShatter * 0.5 * sin(t * 2.0 + aRnd.x * 6.28) * aRnd.z;
    // taps: each one is a small ring that runs through the points from where it landed
    float tapRing = 0.0;
    for (int i = 0; i < 6; i++) { float ta = uTap[i].w; if (ta < 1.3) { float dT = length(at0 - uTap[i].xyz), x = (dT - ta * 1.5) / 0.095; float rg = exp(-x * x) * exp(-ta * 2.0); tapRing += rg * 1.25 + exp(-dT * dT / 0.030) * exp(-ta * 7.0) * 0.9; P += N * rg * 0.050 * (1.0 - hold); } }
    vec4 w = uModel * vec4(P, 1.0);
    // Face <-> Visualizer: every point leaves at its own moment, swings round the middle, and lands in the formation
    float vm = 0.0, vpsz = 1.0; vec3 vcol = vec3(0.0);
    if (uViz > 0.0 && uMode != 1) {
      vec3 vp; vizEval(uVizFa, aRnd, t, SH, CHROME, vp, vcol, vpsz);
      if (uVizK < 1.0) {
        // one formation into another: each point leaves at its own moment and takes a curved way
        vec3 vp0, vc0; float ps0; vizEval(uVizFb, aRnd, t, SH, CHROME, vp0, vc0, ps0);
        float k = smoothstep(0.0, 1.0, clamp(uVizK * 1.5 - aRnd.z * 0.5, 0.0, 1.0)), arc = sin(3.14159 * k);
        vec3 d0 = vp0 - vec3(0.0, -0.55, 0.0);
        vp = mix(vp0, vp, k) + vec3(-d0.y, d0.x, 0.6) * (0.30 * arc); vcol = mix(vc0, vcol, k) * (1.0 + 0.6 * arc); vpsz = mix(ps0, vpsz, k);
      }
      vm = smoothstep(0.0, 1.0, clamp(uViz * 1.45 - aRnd.y * 0.45, 0.0, 1.0));
      vec3 fromC = w.xyz - vec3(0.0, -0.55, 0.0);
      w.xyz = mix(w.xyz, vp, vm) + vec3(-fromC.y, fromC.x, 0.4) * (0.55 * sin(3.14159 * vm));
    }
    vec3 Nw = normalize(mat3(uModel) * N), V = normalize(uCam - w.xyz);
    vec4 clip = uViewProj * w; gl_Position = clip;
    float nv = dot(Nw, V);
    float kd = pow(max((dot(Nw, normalize(vec3(-0.50, 0.52, 0.70))) + 0.30) / 1.30, 0.0), 1.7), rim = pow(1.0 - abs(nv), 2.5);   // a wrapped key: the far cheek is not dead
    float flying = clamp((move + impMove * 0.7 + uShatter * 0.6) * 2.2 - 0.12, 0.0, 1.0);
    // colour IS light: the key colour where the key falls, the shade colour in the shade and on the rim
    vec3 col = SH * (uAmb + uRim * rim + 0.5 * act + uWave * wave) + CHROME * (uKey * kd * (0.55 + 0.75 * bone + 0.4 * feat));
    col *= 0.70 + 0.5 * feat + 0.5 * bone;
    vec3 lineCol = mix(SH * 1.6, uAccent, uLineWhite * (0.55 + 0.45 * kd));
    col += lineCol * line * uLine * (0.75 + 0.45 * uBeat + 0.3 * act) * (lLip >= lBrow ? 1.0 : 0.8);
    if (uMode == 4) {
      if (part < 0.5) col = (SH * (uAmb * 0.28 + uRim * 1.0 * rim) + CHROME * (uKey * kd * 0.40)) * (0.45 + 0.8 * aFeat);                       // the head: quieter than the face, so the face stays the picture
      else if (part < 1.5) col = (SH * (0.45 + 1.3 * rim) + CHROME * (kd * 1.5 + 0.10)) * (0.5 + 2.2 * aFeat * aFeat) * (0.8 + 0.6 * aBary.x);                // hair: strands with their own sheen
      else if (part < 2.5) col = SH * (0.30 + 1.5 * rim + 1.3 * aFeat) + CHROME * (kd * (0.35 + 0.9 * aFeat)) + uAccent * (pow(aBary.x, 3.0) * (0.5 + 1.4 * uBeat + 0.6 * uBass));      // horns: ridges catch the light, the tips burn on the beat
      else { float heat = 1.0 - flame; col = mix(SH * 1.9, uAccent * 2.4, heat * heat * heat) * (pow(heat, 1.2) * (0.7 + 1.1 * aRnd.w)) * smoothstep(0.0, 0.05, flame); }      // flame: white-gold at the root, the shade colour above, gone at the top
    }
    if (uMode == 1) col = mix(SH * 1.6, uAccent, eyeW) * eyeB * 2.5 * (0.80 + 0.5 * uBeat + 0.25 * uBass) * smoothstep(0.02, 0.22, uEyeOpen);
    float sp = step(0.955, aRnd.x) * (uHigh * uSparkle + 2.5 * uPulse) * (0.5 + 0.5 * sin(t * (9.0 + aRnd.y * 14.0) + aRnd.z * 60.0));
    col += uAccent * sp * 1.6;
    col *= 1.0 + 0.55 * uPulse;
    col += uAccent * tapRing * 4.0 + SH * (rim * 1.3 + 0.10) * uStreak;      // the tap ring; a streak of taps makes the rim glow
    col = mix(col, SH * (dot(col, vec3(0.5, 0.3, 0.2)) * 1.6 + 0.25), flying);            // what flies takes the shade colour
    col += impCol * (2.2 + 2.0 * aRnd.x);
    if (uLockCol.a > 0.0) { float dl = (length(at0 - uLock.xyz) - uLock.w) / 0.045; col += uLockCol.rgb * (exp(-dl * dl) * uLockCol.a * 3.2); }      // lock-on: a ring closing on the face                                                    // the flash of an impact, in the gift's own colour
    float lum = dot(col, vec3(0.45, 0.35, 0.20));
    col = mix(col, uFlash.rgb * (lum * 1.9 + 0.05), uFlash.a);
    // a shatter is HEAT, not a rainbow: white-hot as it bursts, gold as it flies, crimson as it comes home
    float ht = clamp(uRainbow + (aRnd.y - 0.5) * 0.30, 0.0, 1.0);
    vec3 heatCol = ht > 0.6 ? mix(vec3(1.0, 0.62, 0.16), vec3(1.0, 0.96, 0.90), (ht - 0.6) / 0.4) : mix(CRIM, vec3(1.0, 0.62, 0.16), ht / 0.6);
    col = mix(col, heatCol * (lum * 2.6 + 0.14), clamp(uRainbow * 1.6, 0.0, 1.0));
    if (uMode == 1) col *= 1.0 - smoothstep(0.0, 0.35, uViz);
    float spv = uVizFa == 0 && uVizK >= 1.0 ? sp : step(0.955, fract(aRnd.x * 7.31 + aRnd.w * 3.77)) * (uHigh * uSparkle + 2.5 * uPulse) * (0.5 + 0.5 * sin(t * (9.0 + aRnd.y * 14.0) + aRnd.z * 60.0)) * 0.55 * min(1.0, dot(vcol, vcol) * 2.0);
    vec3 vizCol = (vcol + uAccent * spv * 1.6) * (0.7 + 0.5 * aRnd.x) * (1.0 + 0.55 * uPulse) + impCol * 2.5 + uAccent * tapRing;
    col = mix(col, vizCol, vm);
    col *= uGain * mix(nv < 0.0 && part < 2.5 ? 0.0 : 1.0, 1.0, vm) * (1.0 - 0.80 * smoothstep(0.15, 0.9, rimM) * (1.0 - vm)) * (0.92 + 0.12 * sin(t * (1.5 + aRnd.y * 3.0) + aRnd.z * 40.0));
    if (uMode == 3 && vm < 0.5) { float f = 1.0 - tail / 1.25; col = (SH * (0.30 + 0.9 * rim) + CHROME * kd * 0.35) * f * f * (0.6 + 0.5 * uBass) * (dot(Nw, V) < -0.2 ? 0.25 : 1.0) * uGain; }
    float dist = clip.w, base = uPx * (0.70 + 0.9 * aRnd.x * aRnd.x) * (1.0 + 0.45 * line) * mix(1.0, vpsz, vm) / dist;
    float coc = abs(dist - uFocus) * uDof / dist, size = max(base + coc, 1.8);
    col *= (base * base) / (size * size);
    if (max(col.r, max(col.g, col.b)) < 0.035) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vCol = vec4(0.0); vSoft = 0.0; return; }   // too dark to matter: not drawn
    gl_PointSize = size; vSoft = clamp(coc / size, 0.0, 1.0); vCol = vec4(col, 1.0);
  }`;
  const SKIN_FS = COMMON + `
  in vec3 vWorld, vNrm, vRest; in vec4 vMask; in vec2 vMask2; in float vAct; out vec4 o; uniform float uSkin;
  void main() {
    vec3 N = normalize(vNrm); if (!gl_FrontFacing) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 V = normalize(uCam - vWorld);
    vec3 SH = mix(uShade, uShade2, smoothstep(-1.5, 0.8, vRest.y + 0.30 * sin(vRest.x * 1.7 + uTime * 0.35)));
    float kd = pow(max(dot(N, normalize(vec3(-0.50, 0.52, 0.70))), 0.0), 1.3), rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    vec3 col = SH * (0.10 + 0.60 * kd + 0.9 * rim) * uSkin * uGain * (0.8 + 0.4 * uBass + 0.3 * uBeat) * (1.0 - clamp(uShatter * 1.6, 0.0, 1.0));
    float hole = 0.0;                                                     // where a gift has blasted the points off, the surface under them is gone too
    for (int i = 0; i < 10; i++) { if (i >= uNImp) break; float age = uImpT[i].x; if (uImpT[i].y > 0.0 && age >= 0.0 && age < 6.0) { vec3 dv = vRest - uImp[i].xyz; hole += uImpT[i].y * exp(-dot(dv, dv) / (uImp[i].w * uImp[i].w)) * exp(-age * uImpT[i].z); } }
    float lum = dot(col, vec3(0.45, 0.35, 0.20));
    col = mix(col, uFlash.rgb * lum * 1.9, uFlash.a);
    vec3 scorch = vec3(0.0);
    for (int i = 0; i < 10; i++) { if (i >= uNImp) break; float age = uImpT[i].x, bl = uImpT[i].w; if (bl > 0.0 && age >= 0.0 && age < 3.0) { float d = length(vRest - uImp[i].xyz), rr = uImp[i].w, x = (d - rr * 0.8) / (rr * 0.33); scorch += mix(uImpC[i], CRIM, clamp(age * 1.1, 0.0, 1.0)) * (exp(-x * x) * exp(-age * 1.6) * 0.20 * min(bl, 2.0)); } }
    // no edge: the surface is gone before the outline, and at grazing angles
    o = vec4((col * (1.0 - clamp(hole * 1.4, 0.0, 1.0)) + scorch) * (1.0 - smoothstep(0.0, 0.11, vMask.w)) * smoothstep(0.05, 0.45, dot(N, V)), 1.0);
  }`;
  // missiles and comment streaks: plain points with a colour and a size, made on the CPU each frame (a few hundred)
  const FXP_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec4 aCol; uniform mat4 uViewProj; uniform float uPx; out vec4 vCol; out float vSoft;
  void main() { vec4 c = uViewProj * vec4(aPos, 1.0); gl_Position = c; gl_PointSize = max(aCol.a * uPx / c.w, 1.5); vCol = vec4(aCol.rgb, 1.0); vSoft = 0.0; }`;

  // ------------------------------------------------------------------------------------------------ the void behind
  const BG_FS = COMMON + `
  in vec2 vUv; out vec4 o; uniform vec2 uHead; uniform float uAspect, uHeadR; uniform int uStyle; uniform vec4 uHole;
  float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  // ---- round 4: four more backgrounds. Each is a scene in layers of depth; the slow drift of the lens (uCam) moves the
  // layers against each other (far ones with the lens, near ones against it), so they are rooms, not pictures.
  float n2(vec2 x) { vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
  float fbm(vec2 x) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n2(x); x = x * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return s; }
  vec2 voro(vec2 x) {
    vec2 n = floor(x), f = fract(x); float f1 = 8.0, f2 = 8.0, id = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)), o = vec2(h21(n + g), h21(n + g + 71.7)), rr = g + o - f; float d = dot(rr, rr); if (d < f1) { f2 = f1; f1 = d; id = h21(n + g + 13.1); } else if (d < f2) f2 = d; }
    return vec2(sqrt(f2) - sqrt(f1), id);
  }
  // FORGE: volcanic. A floor of cooling crust whose seams glow where the heat moves under it, running to a far edge of
  // fire; a black ridge against the glow with a stream of lava coming down it; smoke lit from below; embers rising at
  // three depths (the nearest out of focus, in front of him).
  vec3 bgForge(vec2 p, vec2 par) {
    float T = uTime, hz = -0.50; vec2 q = p - par; float y = q.y - hz, pulse = 0.70 + 0.50 * uBass + 0.22 * uBeat;
    const vec3 EMB = vec3(1.30, 0.17, 0.020), GOLD = vec3(1.45, 0.58, 0.10), HOT = vec3(1.75, 1.20, 0.60);
    vec3 col;
    if (y > 0.0) {
      vec2 gs = vec2(q.x + 0.26, y * 1.6);
      col = vec3(0.014, 0.004, 0.003) + EMB * (0.20 * exp(-y * 4.0) + 0.030 * exp(-y * 0.9) + 0.42 * exp(-dot(gs, gs) * 7.0)) * pulse;      // the sky over the fire, hottest where the crater is
      float sm = fbm(vec2(q.x * 1.7 + T * 0.012, y * 1.4 - T * 0.040)), sm2 = fbm(vec2(q.x * 3.1 - T * 0.018 + 7.0, y * 2.4 - T * 0.070 + 3.0));
      col += mix(EMB, GOLD, 0.25) * smoothstep(0.40, 0.72, sm) * 0.26 * exp(-y * 1.25) * pulse;       // smoke lit from below
      col *= 1.0 - 0.70 * smoothstep(0.40, 0.70, sm2) * smoothstep(0.0, 0.45, y);                     // darker billows in front of it
      // the ridge: black rock against the glow, nearer than the sky
      vec2 rq = p - par * 0.72; float rx = rq.x, ry = rq.y - hz;
      float rh = 0.050 + 0.26 * fbm(vec2(rx * 1.9 + 4.0, 2.0)) * smoothstep(-0.10, 0.50, abs(rx + 0.26)) + 0.035 * n2(vec2(rx * 13.0, 5.0));
      float rock = smoothstep(rh + 0.004, rh - 0.004, ry);
      vec3 rc = vec3(0.010, 0.0035, 0.0025) + EMB * 0.05 * exp(-ry * 9.0) * pulse;
      // a stream of lava down its right flank
      float lx = rx - 0.40 - 0.030 * sin(ry * 21.0 + 1.0) - 0.012 * sin(ry * 57.0), lw = 0.004 + 0.010 * (1.0 - ry / max(rh, 0.01));
      float flow = 0.55 + 0.45 * n2(vec2(3.0, ry * 26.0 + T * 1.6));
      rc += (HOT * exp(-lx * lx / (lw * lw)) * 1.3 * flow + EMB * exp(-abs(lx) * 34.0) * 0.30) * pulse;
      col = mix(col, rc, rock) + GOLD * exp(-abs(ry - rh) * 90.0) * 0.10 * exp(-gs.x * gs.x * 5.0) * pulse;      // its edge catches the crater
    } else {
      float d = -y, z = 1.0 / (d + 0.04);
      vec2 w = vec2(uCam.x * 0.30 + q.x * z * 1.15, z * 0.62);
      vec2 wq = w * 1.05 + 0.60 * vec2(fbm(w * 0.9), fbm(w * 0.9 + 7.3));
      vec2 v = voro(wq);
      float heat = smoothstep(0.40, 0.66, fbm(w * 0.42 + vec2(T * 0.03, -T * 0.06))) * pulse, fl2 = n2(wq * 3.0 + vec2(v.y * 9.0, T * 0.35));
      float wd = 0.012 + 0.085 * heat * (0.4 + 0.6 * fl2), seam = smoothstep(wd, wd * 0.25, v.x);
      vec3 lava = mix(EMB, GOLD, min(heat * (0.5 + 0.6 * fl2), 1.0)) * seam * (0.05 + 1.5 * heat) + HOT * smoothstep(wd * 0.35, 0.0, v.x) * heat * heat * (0.3 + 0.9 * fl2);
      vec3 crust = vec3(0.030, 0.008, 0.004) * (0.25 + 0.75 * fbm(wq * 3.5 + v.y * 20.0)) + EMB * 0.30 * heat * exp(-v.x * 7.0);      // the plates, lit from their seams
      col = mix(mix(EMB, GOLD, 0.3) * 0.45 * pulse, crust + lava, smoothstep(0.0, 0.10, d)) * (0.50 + 0.50 * exp(-d * 2.0));
    }
    col += GOLD * exp(-abs(y) * 60.0) * 0.40 * pulse;                                                  // the far edge of the floor, white-gold
    for (int l = 0; l < 3; l++) {
      float fl = float(l), sc = l == 0 ? 3.2 : l == 1 ? 6.5 : 13.0, kp = l == 0 ? -0.9 : l == 1 ? 0.25 : 0.7;
      vec2 g = (p - par * kp) * sc + vec2(fl * 3.7 + 0.25 * sin(T * 0.31 + fl * 2.0), -T * (0.050 + 0.016 * fl) * sc); vec2 cell = floor(g), f = fract(g);
      float rnd = h21(cell + fl * 31.0);
      if (rnd > 0.55) {
        vec2 c = vec2(0.25 + 0.5 * h21(cell + 1.7) + 0.10 * sin(T * (0.9 + rnd) + rnd * 40.0), 0.25 + 0.5 * h21(cell + 4.1)); float dd = length(f - c), rad = l == 0 ? 0.085 : l == 1 ? 0.05 : 0.045;
        float life = smoothstep(-1.05, -0.45, p.y) * smoothstep(1.05, 0.1, p.y), fk = 0.55 + 0.45 * sin(T * (3.0 + 4.0 * rnd) + rnd * 90.0);
        float m = l == 0 ? smoothstep(rad, rad * 0.62, dd) * (0.6 + 0.4 * smoothstep(rad * 0.4, rad * 0.9, dd)) * 0.20 : exp(-dd * dd / (rad * rad * 0.10)) * (l == 1 ? 1.3 : 0.9);
        col += mix(GOLD, HOT, rnd) * m * life * fk * (0.55 + 0.9 * uBass);
      }
    }
    return col;
  }
  // NEBULA: deep space. A crimson cloud with gold-white cores and dark lanes of dust lies across the frame, stars at
  // three depths (the big ones with spikes), and the lit limb of a dark world low in the picture, much nearer.
  vec3 bgNebula(vec2 p, vec2 par) {
    float T = uTime; vec2 q = p - par * 0.92;
    const vec3 CR = vec3(0.95, 0.045, 0.030), EM = vec3(1.25, 0.22, 0.04), GO = vec3(1.35, 0.78, 0.26), WH = vec3(1.40, 1.20, 0.95);
    vec2 a = q * 1.25 + vec2(T * 0.006, -T * 0.004);
    vec2 wv = vec2(fbm(a * 1.3 + vec2(0.0, T * 0.010)), fbm(a * 1.3 + vec2(5.2, 1.3 - T * 0.008)));
    float d1 = fbm(a * 1.7 + 2.4 * wv), d2 = fbm(a * 3.6 - 1.7 * wv + 9.0), fil = 1.0 - abs(2.0 * fbm(a * 2.6 + 1.6 * wv + 3.0) - 1.0);
    float bc = dot(q - vec2(0.0, 0.10), vec2(0.588, 0.809)), band = exp(-bc * bc * 2.4), dd1 = d1 * (0.50 + 0.80 * band);
    float dens = smoothstep(0.30, 0.74, dd1), dust = smoothstep(0.42, 0.62, d2), core = smoothstep(0.62, 0.84, dd1 * (0.80 + 0.35 * fil));
    vec3 col = CR * 0.05 * dens + mix(CR, EM, fil * fil) * dens * dens * 0.32 * (0.20 + 1.1 * fil * fil * fil);
    col += mix(mix(EM, GO, core), WH, core * core * core * 0.35) * core * (0.30 + 0.70 * fil) * 0.36 * (0.8 + 0.5 * uBass);
    col *= 1.0 - 0.88 * dust * smoothstep(0.1, 0.6, dens);
    for (int l = 0; l < 3; l++) {
      float fl = float(l), sc = l == 0 ? 9.0 : l == 1 ? 17.0 : 30.0; vec2 g = (p - par * (0.80 + 0.08 * fl)) * sc + fl * 13.7; vec2 cell = floor(g), f = fract(g);
      float rnd = h21(cell + fl * 7.0);
      if (rnd > 0.60) {
        vec2 dd = (f - vec2(0.2 + 0.6 * h21(cell + 2.3), 0.2 + 0.6 * h21(cell + 6.1))) / sc; float d = length(dd), m = (rnd - 0.60) / 0.40, tw = 0.65 + 0.35 * sin(T * (0.7 + 2.0 * rnd) + rnd * 80.0);
        vec3 sc3 = mix(mix(WH, GO, step(0.5, fract(rnd * 17.0))), EM, step(0.85, fract(rnd * 29.0)));
        float pt = exp(-d * d * (l == 0 ? 60000.0 : 160000.0)) * (0.4 + 2.2 * m * m);
        float spike = l == 0 && m > 0.70 ? (exp(-abs(dd.x) * 700.0 - abs(dd.y) * 60.0) + exp(-abs(dd.y) * 700.0 - abs(dd.x) * 60.0)) * 0.5 : 0.0;
        col += sc3 * (pt + spike) * tw * (1.0 - 0.6 * dust * dens);
      }
    }
    vec2 pc = (p - par * 0.45) - vec2(0.34, -2.02); float pr = length(pc), R = 1.42, inside = smoothstep(R + 0.004, R - 0.004, pr);
    float lit = clamp(dot(pc / pr, vec2(-0.55, 0.835)), 0.0, 1.0);
    col *= 1.0 - inside;
    col += mix(EM, GO, lit * lit) * (exp(-max(pr - R, 0.0) * 70.0) * (1.0 - inside) + exp(-max(R - pr, 0.0) * 26.0) * inside) * (0.06 + 1.0 * lit * lit * lit) * (0.9 + 0.3 * uBass);
    return col;
  }
  // STUDIO: a black studio. A slot of white light where the wall meets the floor, two crimson tubes at the sides, a
  // blade of light overhead; the floor is liquid metal: it mirrors all of it, its swell breaks the mirror, every kick
  // sends rings out from under him, and his own light lies on it as a long smear.
  vec3 studioWall(vec2 s) {
    const vec3 CH = vec3(1.0, 0.96, 0.92);
    vec3 c = vec3(0.003, 0.0027, 0.0026) + CH * 0.010 * exp(-s.y * 2.6);
    c += CH * (exp(-s.y * 110.0) * 1.0 + exp(-s.y * 12.0) * 0.06) * (0.85 + 0.3 * uBass);
    for (int i = 0; i < 2; i++) {
      float dx = abs(s.x - (i == 0 ? -0.465 : 0.465)), on = smoothstep(0.02, 0.05, s.y) * smoothstep(1.22, 1.12, s.y);
      c += CRIM * (exp(-dx * dx / 0.00003) * 3.0 + exp(-dx * 30.0) * 0.26 + exp(-dx * 6.0) * 0.05) * on * (0.8 + 0.6 * uBeat);
    }
    vec2 b = vec2(s.x, s.y - 1.37); float bd = length(vec2(max(abs(b.x) - 0.33, 0.0), max(abs(b.y) - 0.004, 0.0)));
    c += CH * (smoothstep(0.006, 0.0, bd) * 2.2 + exp(-bd * 30.0) * 0.20 + exp(-bd * 6.0) * 0.016);
    return c;
  }
  vec3 bgStudio(vec2 p, vec2 par, vec2 hd) {
    float T = uTime, hz = -0.50; vec2 q = p - par * vec2(0.5, 1.0); float y = q.y - hz;
    const vec3 CH = vec3(1.0, 0.96, 0.92);
    if (y >= 0.0) return studioWall(vec2(q.x, y));
    float d = -y, z = 1.0 / (d + 0.03);
    vec2 w = vec2(uCam.x * 0.3 + q.x * z, z);
    float sw = n2(w * vec2(1.3, 0.45) + vec2(T * 0.10, T * 0.22)) - 0.5 + 0.4 * (n2(w * vec2(3.4, 1.2) - vec2(T * 0.16, T * 0.30)) - 0.5);
    vec2 wc = vec2(uCam.x * 0.3 + (hd.x - par.x * 0.5) * 5.9, 5.9); float dr = length((w - wc) * vec2(1.0, 0.45)), rings = 0.0;
    for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = dr - age * 3.2; rings += uKick[i].y * cos(x * 5.0) * exp(-x * x * 1.6) * exp(-age * 1.8); }
    float slope = sw * 0.9 + rings * 0.55;
    vec3 col = studioWall(vec2(q.x + slope * 0.045 * (0.3 + d), max(d * (1.0 + slope * 0.7), 0.0))) * mix(0.55, 0.92, exp(-d * 3.0));
    float sheen = max(0.0, slope + 0.25);
    col += CH * sheen * sheen * sheen * 0.055 * exp(-d * 1.5);                                              // the swell catches the blade overhead
    float mx = p.x - hd.x + slope * 0.09;
    col += (uKeyCol * 0.45 + uShade * 0.75) * exp(-mx * mx / (0.020 + 0.22 * d * d)) * exp(-d * 2.0) * 0.42 * (0.7 + 0.5 * uBass + 0.6 * abs(rings)) * (0.75 + 0.9 * slope);
    return col;
  }
  // STREET: a wet street at night, seen down its length. Neon bars and lamps on both sides run off to the vanishing
  // point, out of focus; the road mirrors them as long streaks broken by the rain; rain falls at two depths.
  vec3 streetLights(vec2 s) {
    vec3 c = vec3(0.0); float T = uTime;
    for (int i = 0; i < 22; i++) {
      float fi = float(i), side = mod(fi, 2.0) < 0.5 ? -1.0 : 1.0, rn = h21(vec2(fi, 3.0)), rn2 = h21(vec2(fi, 9.0)), z = 0.95 + 0.24 * floor(fi * 0.5) + rn * 0.2;
      vec2 dd = s - vec2((side * (0.56 + 0.10 * rn2) - uCam.x * 0.25) / z, (mod(fi, 4.0) < 2.0 ? 0.12 + 1.0 * fract(rn2 * 5.3 + fi * 0.37) : 1.25 + 1.2 * fract(rn2 * 5.3 + fi * 0.37)) * 0.85 / z); float rb = 0.012 + 0.034 / z, tc = fract(rn * 7.3 + rn2 * 3.1);
      vec3 lc = tc < 0.45 ? vec3(1.30, 0.050, 0.035) : tc < 0.85 ? vec3(1.35, 0.50, 0.06) : vec3(1.20, 1.00, 0.75);
      float fk = 0.85 + 0.15 * sin(T * (1.0 + 3.0 * rn) + fi), m;
      if (rn > 0.50) { float dist = length(vec2(max(abs(dd.x) - 0.010 / z, 0.0), max(abs(dd.y) - (0.10 + 0.22 * rn2) / z, 0.0))); m = smoothstep(rb * 0.55, 0.0, dist) * 1.1 + exp(-dist * dist / (rb * rb * 2.0)) * 0.40 + exp(-dist * 9.0) * 0.06; fk *= 0.85 + 0.5 * uBeat; }
      else { float len = length(dd); m = smoothstep(rb, rb * 0.82, len) * (0.5 + 0.5 * smoothstep(rb * 0.45, rb, len)) * 0.55 + exp(-len * 11.0) * 0.05; }
      c += lc * m * fk;
    }
    return c;
  }
  // the walls of the street: where a line of sight meets them (how far down the street, how high up), blocks of
  // different heights against a dull red sky, and their lit windows
  vec3 streetFacade(vec2 s) {
    float side = s.x < 0.0 ? -1.0 : 1.0, z = 0.52 / (abs(s.x) + 1e-3), h = s.y * z, blk = floor(z * 0.9 + side * 3.3), top = 1.5 + 1.9 * h21(vec2(blk, side * 7.0 + 2.0));
    vec3 sky = vec3(0.085, 0.012, 0.008) * (0.45 + 0.55 * exp(-s.y * 1.2)) * (0.9 + 0.3 * uBass);
    if (h > top || z > 9.0) return sky;
    vec2 g = vec2(z * 9.0, h * 8.5), cell = floor(g), f = fract(g); float rn = h21(cell + side * 17.0 + blk);
    float win = smoothstep(0.16, 0.26, f.x) * smoothstep(0.84, 0.74, f.x) * smoothstep(0.20, 0.30, f.y) * smoothstep(0.80, 0.70, f.y) * step(0.70, rn) * smoothstep(1.05, 1.5, z);
    vec3 wc = fract(rn * 9.0) < 0.60 ? vec3(1.30, 0.50, 0.07) : fract(rn * 9.0) < 0.90 ? vec3(1.25, 0.06, 0.04) : vec3(1.25, 0.80, 0.40);
    return vec3(0.007, 0.0025, 0.002) + sky * 0.10 * exp(-(top - h) * 3.0) + wc * win * 0.20 * exp(-z * 0.14) * (0.75 + 0.25 * sin(uTime * 0.4 + rn * 40.0));
  }
  vec3 bgStreet(vec2 p, vec2 par) {
    float T = uTime, hz = -0.46; vec2 q = p - par; float y = q.y - hz;
    vec2 fq = vec2(q.x * 1.5, y);
    vec3 fog = (vec3(1.10, 0.16, 0.05) * exp(-dot(fq, fq) * 2.6) * 0.20 + vec3(0.014, 0.004, 0.004)) * (0.85 + 0.4 * uBass);
    vec3 col;
    if (y >= 0.0) col = fog + streetFacade(vec2(q.x, y)) + streetLights(vec2(q.x, y));
    else {
      float d = -y, z = 1.0 / (d + 0.03); vec2 w = vec2(uCam.x * 0.25 + q.x * z, z);
      float wet = smoothstep(0.38, 0.60, fbm(w * vec2(0.9, 0.35) + 4.0)), wob = (n2(w * vec2(5.0, 1.5) + vec2(0.0, T * 0.6)) - 0.5) * (0.010 + 0.016 * d);
      vec2 g = w * 2.6; vec2 cell = floor(g), f = fract(g); float rr = h21(cell + 5.0), ph = fract(T * (0.7 + 0.5 * rr) + rr * 9.0);
      float rd = length(f - vec2(0.3 + 0.4 * h21(cell + 1.1), 0.3 + 0.4 * rr)), rx = (rd - ph * 0.28) / 0.030, ring = exp(-rx * rx) * (1.0 - ph) * (1.0 - ph) * step(0.35, rr);
      wob += ring * 0.010;
      vec3 rf = streetLights(vec2(q.x + wob, d)) * 0.42 + streetLights(vec2(q.x + wob * 1.6, d * 1.9)) * 0.34 + streetLights(vec2(q.x + wob * 2.2, d * 3.3)) * 0.24 + streetFacade(vec2(q.x + wob * 1.6, d * 2.4)) * 0.55;
      col = (rf * 1.35 + fog) * mix(0.30, 1.0, wet) * mix(0.45, 1.0, exp(-d * 2.5)) + vec3(0.012, 0.005, 0.004) * (0.5 + n2(w * 9.0)) + (rf + fog * 0.5) * ring * 0.8;
    }
    float lum = dot(col, vec3(0.4, 0.4, 0.2));
    for (int l = 0; l < 2; l++) {
      vec2 a = p - par * (l == 0 ? -0.6 : 0.3); float sc = l == 0 ? 26.0 : 55.0, cx = (a.x + a.y * 0.10) * sc, id = floor(cx), fx = fract(cx) - 0.5, rn = h21(vec2(id, float(l) * 5.0 + 1.0));
      float ph = fract(a.y * (l == 0 ? 0.9 : 1.6) + T * (1.9 + 1.2 * rn) + rn * 17.0);
      col += vec3(1.0, 0.72, 0.55) * pow(ph, 22.0) * step(0.40, rn) * exp(-fx * fx * (l == 0 ? 110.0 : 160.0)) * (l == 0 ? 0.24 : 0.13) * (0.35 + 2.5 * lum);
    }
    return col;
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0; p.x *= uAspect; vec2 hd = vec2(uHead.x * uAspect, uHead.y); float r = length(p - hd);
    vec3 col = vec3(0.0);
    if (uStyle == 0) {
      // a breath of haze and one thin neon ring behind the head; every kick sends a second ring outward
      col += CRIM * (0.002 + 0.006 * uBass) * exp(-r * r * 2.2);
      float R0 = uHeadR * 1.50, x = (r - R0) / 0.0032;
      vec3 rc = CRIM;
      col += rc * (exp(-x * x) * (0.8 + 3.2 * uBeat + 0.8 * uBass) + exp(-abs(r - R0) * 40.0) * (0.015 + 0.05 * uBeat + 0.02 * uBass));
      for (int i = 0; i < 8; i++) { float age = uKick[i].x, rad = R0 + age * 0.95, w = 0.004 + age * 0.02, y = (r - rad) / w; col += rc * exp(-y * y) * uKick[i].y * exp(-age * 3.4) * 1.4; }
    } else if (uStyle == 1) {
      col += uShade * (0.0015 + 0.004 * uBass + 0.004 * uBeat + 0.02 * uFlash.a) * exp(-r * r * 1.6) * (1.0 - 0.75 * uViz);      // the breath of haze behind the face (a formation wants black behind it)
      col += uShade * uStreak * 0.06 * exp(-r * r * 1.4) * (1.0 - 0.6 * uViz);                 // a streak of taps: a glow round the face
      if (uBg == 1) {
        // SUMMER: the last minutes of a sunset over water. Depth in layers: the far sky (ember above, gold at the
        // horizon), a real sun half sunk beside the jaw (never behind the face) with its glow and slow rays, long clouds
        // lit from below that drift across it, the water with the sun's broken path of light coming toward the lens,
        // and warm motes of light drifting up in front of it all.
        float hz = -0.55, y = p.y - hz; vec2 sp = vec2(p.x - 0.33, y - 0.060); float sd = length(sp);
        vec3 sky = mix(vec3(1.05, 0.43, 0.085), vec3(0.40, 0.070, 0.020), smoothstep(0.0, 0.50, y));
        sky = mix(sky, vec3(0.070, 0.013, 0.008), smoothstep(0.30, 1.45, y));
        sky += vec3(1.30, 0.60, 0.15) * (exp(-sd * sd * 9.0) * 1.10 + exp(-sd * 2.6) * 0.34) * (1.0 + 0.12 * uBass);                 // the glow round the sun
        float ang = atan(sp.y, sp.x), rays = vnoise(vec3(ang * 4.0, uTime * 0.045, 1.0)) * vnoise(vec3(ang * 11.0 + 4.0, uTime * 0.07, 7.0));
        sky += vec3(1.25, 0.58, 0.16) * rays * exp(-sd * 1.7) * 0.75 * (0.8 + 0.5 * uBass);                                      // slow rays through the haze
        float cl = vnoise(vec3(p.x * 1.3 + uTime * 0.014, y * 10.0, 2.0)) * 0.62 + vnoise(vec3(p.x * 3.1 - uTime * 0.022, y * 26.0, 5.0)) * 0.38;
        float cloud = smoothstep(0.42, 0.82, cl) * smoothstep(0.015, 0.16, y) * smoothstep(1.25, 0.25, y);
        float under = smoothstep(0.42, 0.56, cl) * (1.0 - smoothstep(0.56, 0.78, cl));                                           // the lit lower edge of a cloud
        sky = mix(sky, sky * 0.50, cloud) + vec3(1.35, 0.60, 0.15) * under * exp(-sd * 2.0) * 0.38 * smoothstep(0.015, 0.16, y);
        float disc = smoothstep(0.118, 0.104, sd), haze = smoothstep(0.30, 0.62, vnoise(vec3(p.x * 2.0 + uTime * 0.02, y * 46.0, 9.0)));
        sky += mix(vec3(2.6, 0.95, 0.16), vec3(3.4, 2.3, 1.0), smoothstep(0.118, 0.0, sd)) * disc * (0.72 + 0.28 * haze) * 2.2;                                                      // the sun itself, cut by bands of haze
        if (y < 0.004) {
          // the water: the sky's colour sinking into the dark, and the sun's path of light, broken by the swell
          float d = -y, wx = sp.x / (0.085 + d * 0.50), path = exp(-wx * wx);
          vec3 w = mix(vec3(0.46, 0.135, 0.030), vec3(0.022, 0.006, 0.005), smoothstep(0.0, 0.45, d));
          float pv = 1.0 / (d + 0.05), rip = 0.62 * vnoise(vec3(p.x * pv * 2.2, pv * 5.0 + uTime * 0.9, uTime * 0.30)) + 0.38 * vnoise(vec3(p.x * pv * 6.0 + 3.0, pv * 13.0 + uTime * 1.6, uTime * 0.5));
          w += vec3(1.55, 0.80, 0.24) * path * (0.10 + 1.6 * smoothstep(0.50, 0.72, rip)) * exp(-d * 2.2) * smoothstep(0.50, 0.22, d) * (0.9 + 0.5 * uHigh);
          float rip3 = vnoise(vec3(p.x * pv * 15.0 + 9.0, pv * 34.0 + uTime * 2.6, uTime * 0.8)), fine = smoothstep(0.10, 0.42, d);      // fine ripples: only near the lens, where the swell is large enough to carry them
          w += (vec3(1.55, 0.80, 0.24) * path * 1.3 + vec3(0.95, 0.34, 0.07) * 0.16) * smoothstep(0.60, 0.82, rip3) * (0.35 + 0.65 * rip) * fine * exp(-d * 1.6);
          w *= 1.0 - 0.30 * fine * smoothstep(0.42, 0.20, rip3);                                                                         // and the dark backs of them
          float rip2 = vnoise(vec3(p.x * pv * 3.0 + 5.0, pv * 7.0 + uTime * 0.7, 4.0));
          w += vec3(0.95, 0.34, 0.07) * 0.20 * smoothstep(0.60, 0.80, rip2) * exp(-d * 3.0) * smoothstep(0.42, 0.12, d);                                     // the sky caught on the swell, away from the sun
          sky = mix(sky, w, smoothstep(0.004, -0.004, y));
        }
        sky += vec3(1.25, 0.60, 0.16) * exp(-abs(y) * 70.0) * 0.32 * exp(-sp.x * sp.x * 1.4);                                    // the line of the horizon, hot under the sun
        for (int l = 0; l < 3; l++) {
          // motes of light, three depths: large soft discs with a brighter edge near the lens, sparks far away
          float fl = float(l), sc = l == 0 ? 2.6 : l == 1 ? 4.6 : 11.0; vec2 g = p * sc + vec2(fl * 3.7 + uTime * 0.025 + 0.15 * sin(uTime * 0.11 + fl), -uTime * (0.035 + 0.022 * fl)); vec2 cell = floor(g), f = fract(g);
          float rnd = h21(cell + fl * 31.0);
          if (rnd > (l == 2 ? 0.40 : 0.34)) {
            float d = length(f - vec2(0.3 + 0.4 * h21(cell + 1.7), 0.3 + 0.4 * h21(cell + 4.1))), rad = l == 2 ? 0.045 : 0.10 + 0.13 * rnd, tw = 0.55 + 0.45 * sin(uTime * (0.6 + rnd) + rnd * 30.0);
            float disc2 = smoothstep(rad, rad * 0.82, d) * (0.55 + 0.45 * smoothstep(rad * 0.55, rad * 0.95, d));
            sky += vec3(1.15, 0.58, 0.17) * disc2 * tw * (l == 2 ? 0.30 : 0.050 + 0.035 * fl) * (0.6 + 1.2 * exp(-sd * 2.0));
          }
        }
        vec2 fe = (p - hd) * vec2(1.30, 0.86);
        col += sky * (0.24 + 0.76 * smoothstep(0.20, 0.64, length(fe))) * 0.36;      // darker straight behind the face, so the face reads
      } else if (uBg == 2) {
        // ICE: a frozen dark. Cold light from above, frost growing in from the edges, slow drifting crystals.
        float y = p.y;
        vec3 sky = mix(vec3(0.002, 0.008, 0.016), vec3(0.012, 0.06, 0.10), smoothstep(-1.0, 1.1, y));
        sky += vec3(0.25, 0.85, 1.0) * 0.20 * exp(-pow((y - 0.78 - 0.10 * sin(p.x * 2.3 + uTime * 0.12)) * 3.2, 2.0)) * (0.6 + 0.4 * vnoise(vec3(p.x * 2.0 + uTime * 0.05, y * 3.0, uTime * 0.04))) * (0.8 + 0.5 * uBass);
        vec3 q = vec3(p * 5.5, 0.4); vec3 n0 = floor(q), f0 = fract(q); float f1 = 8.0, f2 = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec3 g = vec3(float(i), float(j), 0.0), o2 = hash3(n0 + g); vec2 rr = g.xy + o2.xy - f0.xy; float d = dot(rr, rr); if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d; }
        float frost = (1.0 - smoothstep(0.0, 0.06, sqrt(f2) - sqrt(f1))) * smoothstep(0.55, 1.25, length(p * vec2(1.25, 0.85)));
        sky += vec3(0.55, 0.90, 1.0) * frost * 0.10;
        for (int l = 0; l < 2; l++) {
          float sc = l == 0 ? 7.0 : 12.0; vec2 g = p * sc + vec2(sin(uTime * 0.2 + float(l)) * 0.3, uTime * (0.10 + 0.05 * float(l)) * sc * 0.3); vec2 cell = floor(g), f = fract(g);
          float rnd = h21(cell + float(l) * 17.0);
          if (rnd > 0.72) { vec2 dd = (f - vec2(0.25 + 0.5 * h21(cell + 2.3), 0.25 + 0.5 * h21(cell + 6.1))) / sc; float d = length(dd); sky += vec3(0.75, 0.95, 1.0) * (exp(-d * d * (l == 0 ? 30000.0 : 90000.0)) * 1.4 + exp(-abs(dd.x) * 900.0 - abs(dd.y) * 120.0) * 0.25) * (0.5 + 0.5 * sin(uTime * 2.0 + rnd * 50.0)); }
        }
        col += sky * (0.25 + 0.75 * smoothstep(0.30, 1.15, r)) * 0.8;
      } else if (uBg >= 3) {
        vec2 par = vec2(uCam.x, uCam.y + 0.5) * 0.416;                  // how far the drift of the lens moves what is infinitely far (in picture units)
        vec3 sc = uBg == 3 ? bgForge(p, par) : uBg == 4 ? bgNebula(p, par) : uBg == 5 ? bgStudio(p, par, hd) : bgStreet(p, par);
        vec2 fe = (p - hd) * vec2(1.30, 0.86);
        col += sc * mix(0.22 + 0.78 * smoothstep(0.20, 0.66, length(fe)), 0.30, uViz) * (uBg == 3 ? 0.55 : uBg == 4 ? 0.85 : uBg == 5 ? 0.70 : 0.75);      // darker straight behind the face, so the face reads
      }
      if (uRing.y > 0.0 && uRing.x < 2.0) {                           // a ring round the face: a follow, a share, a big gift
        float age = uRing.x, rad = uHeadR * 1.15 + 1.1 * (1.0 - exp(-age * 2.4)), wd = 0.005 + age * 0.012, y = (r - rad) / wd;
        col += uRingCol * (exp(-y * y) * 2.6 + exp(-abs(r - rad) * 22.0) * 0.10) * uRing.y * exp(-age * 2.2);
      }
    } else {
      // the glow of whatever is molten below, and embers rising out of it
      vec2 q = p - vec2(hd.x, -1.25);
      col += vec3(1.0, 0.06, 0.03) * (0.012 + 0.03 * uBass + 0.03 * uBeat) * exp(-dot(q * vec2(0.9, 1.5), q * vec2(0.9, 1.5)) * 1.1);
      col += CRIM * (0.002 + 0.005 * uBass) * exp(-r * r * 1.5);
      for (int l = 0; l < 2; l++) {
        float sc = l == 0 ? 9.0 : 15.0, sp = l == 0 ? 0.22 : 0.13;
        vec2 g = p * sc + vec2(float(l) * 7.3, -uTime * sp * sc); vec2 cell = floor(g), f = fract(g);
        float rnd = h21(cell + float(l) * 19.0);
        if (rnd > 0.80) {
          vec2 c = vec2(0.2 + 0.6 * h21(cell + 3.1) + 0.12 * sin(uTime * 1.3 + rnd * 40.0), 0.2 + 0.6 * h21(cell + 5.7));
          float d = length((f - c) / sc), life = smoothstep(-1.0, 0.1, -p.y) * smoothstep(1.0, -0.2, p.y);
          col += vec3(2.4, 0.22, 0.08) * exp(-d * d * (l == 0 ? 90000.0 : 200000.0)) * life * (0.5 + 0.5 * sin(uTime * 5.0 + rnd * 90.0)) * (0.5 + 1.2 * uBass);
        }
      }
    }
    // the black hole's dark: points only add light, so the scene itself goes black where the hole is (x, y, radius, how much)
    if (uHole.w > 0.0) col *= 1.0 - uHole.w * smoothstep(uHole.z * 1.03, uHole.z * 0.93, length(p - vec2(uHole.x * uAspect, uHole.y)));
    o = vec4(col, 1.0);
  }`;

  function create(G, core) {
    const gl = G.gl, M = core.mesh, nF = M.nFine;
    const progs = { chrome: G.program(FACE_VS, CHROME_FS), obsidian: G.program(FACE_VS, OBS_FS), clay: G.program(FACE_VS, CLAY_FS), occlude: G.program(FACE_VS, OCCLUDE_FS) };
    progs.skin = G.program(FACE_VS, SKIN_FS);
    const pEye = G.program(EYE_VS, EYE_FS), pMouth = G.program(MOUTH_VS, MOUTH_FS), pPart = G.program(PART_VS, PART_FS), pPart2 = G.program(PART2_VS, PART_FS), pFx = G.program(FXP_VS, PART_FS), pBg = G.program(G.FS_TRI, BG_FS);
    // ---- the face mesh
    const bPos = G.buffer(core.pos, true), bNrm = G.buffer(core.nrm, true), bAct = G.buffer(core.act, true), bRest = G.buffer(M.rest);
    const mask4 = new Float32Array(nF * 4), mask2 = new Float32Array(nF * 2);
    for (let i = 0; i < nF; i++) { mask4[i * 4] = M.mask.lip[i]; mask4[i * 4 + 1] = M.mask.lid[i]; mask4[i * 4 + 2] = M.mask.brow[i]; mask4[i * 4 + 3] = M.mask.rim[i]; mask2[i * 2] = M.mask.lipIn[i]; mask2[i * 2 + 1] = M.mask.feature[i]; }
    const bMask = G.buffer(mask4), bMask2 = G.buffer(mask2);
    const ibo = gl.createBuffer();
    const faceVao = {};
    for (const k in progs) {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      G.attrib(progs[k], 'aPos', bPos, 3); G.attrib(progs[k], 'aNrm', bNrm, 3); G.attrib(progs[k], 'aRest', bRest, 3); G.attrib(progs[k], 'aMask', bMask, 4); G.attrib(progs[k], 'aMask2', bMask2, 2); G.attrib(progs[k], 'aAct', bAct, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      if (!faceVao._filled) { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, M.index, gl.STATIC_DRAW); faceVao._filled = true; }
      faceVao[k] = vao;
    }
    // ---- an eyeball
    const sv = [], si = [], SEG = 28, RINGS = 18;
    for (let j = 0; j <= RINGS; j++) for (let i = 0; i <= SEG; i++) { const a = j / RINGS * Math.PI, b = i / SEG * 2 * Math.PI; sv.push(Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)); }
    for (let j = 0; j < RINGS; j++) for (let i = 0; i < SEG; i++) { const a = j * (SEG + 1) + i, b = a + SEG + 1; si.push(a, a + 1, b, b, a + 1, b + 1); }
    const eyeVao = gl.createVertexArray(); gl.bindVertexArray(eyeVao);
    G.attrib(pEye, 'aPos', G.buffer(new Float32Array(sv)), 3);
    const eyeIbo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eyeIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(si), gl.STATIC_DRAW);
    // ---- the inside of the mouth: the lip line, a smaller ring behind it, a point behind that
    const NR = core.mouth.ring.length / 3, mouthPos = new Float32Array((NR * 2 + 1) * 3), mouthDepth = new Float32Array(NR * 2 + 1), mi = [];
    for (let k = 0; k < NR; k++) { mouthDepth[k] = 0; mouthDepth[NR + k] = 0.75; const k1 = (k + 1) % NR; mi.push(k, k1, NR + k, k1, NR + k1, NR + k, NR + k, NR + k1, NR * 2); }
    mouthDepth[NR * 2] = 1;
    const bMouth = G.buffer(mouthPos, true);
    const mouthVao = gl.createVertexArray(); gl.bindVertexArray(mouthVao);
    G.attrib(pMouth, 'aPos', bMouth, 3); G.attrib(pMouth, 'aDepth', G.buffer(mouthDepth), 1);
    const mouthIbo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mouthIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mi), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // ---- particles (built on first use)
    let part = null;
    function buildParticles(count = 150000) {
      // a fixed random series: the same particles every run
      let seed = 1234567;
      const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const ix = M.index, nT = ix.length / 3, cum = new Float64Array(nT), R = M.rest, feat = M.mask.feature, rimM = M.mask.rim, lipIn = M.mask.lipIn, lid = M.mask.lid;
      let total = 0;
      for (let t = 0; t < nT; t++) {
        const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2];
        const ux = R[b * 3] - R[a * 3], uy = R[b * 3 + 1] - R[a * 3 + 1], uz = R[b * 3 + 2] - R[a * 3 + 2], vx = R[c * 3] - R[a * 3], vy = R[c * 3 + 1] - R[a * 3 + 1], vz = R[c * 3 + 2] - R[a * 3 + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        const f = (feat[a] + feat[b] + feat[c]) / 3, rm = (rimM[a] + rimM[b] + rimM[c]) / 3, edge = Math.max(lipIn[a], lipIn[b], lipIn[c], lid[a], lid[b], lid[c]);
        total += area * (1.0 + 2.0 * f + 2.5 * Math.pow(edge, 3)) * (1 - 0.55 * rm);
        cum[t] = total;
      }
      const aTri = new Float32Array(count * 3), aBary = new Float32Array(count * 2), aRnd = new Float32Array(count * 4), aRest = new Float32Array(count * 3), aFeat = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const u = rnd() * total; let lo = 0, hi = nT - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
        const a = ix[lo * 3], b = ix[lo * 3 + 1], c = ix[lo * 3 + 2];
        let b0 = rnd(), b1 = rnd(); if (b0 + b1 > 1) { b0 = 1 - b0; b1 = 1 - b1; }
        const b2 = 1 - b0 - b1;
        aTri.set([a, b, c], i * 3); aBary.set([b0, b1], i * 2); aRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4);
        for (let k = 0; k < 3; k++) aRest[i * 3 + k] = R[a * 3 + k] * b0 + R[b * 3 + k] * b1 + R[c * 3 + k] * b2;
        aFeat[i] = feat[a] * b0 + feat[b] * b1 + feat[c] * b2;
      }
      const mk = (n, tri, bary, rn, rest, ft) => {
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        G.attrib(pPart, 'aTri', G.buffer(tri), 3); G.attrib(pPart, 'aBary', G.buffer(bary), 2); G.attrib(pPart, 'aRnd', G.buffer(rn), 4); G.attrib(pPart, 'aRest', G.buffer(rest), 3); G.attrib(pPart, 'aFeat', G.buffer(ft), 1);
        return { vao, n };
      };
      const face = mk(count, aTri, aBary, aRnd, aRest, aFeat);
      // one eye: an iris ring (dense, bright), a faint ball round it
      const NE = 2600, eR = new Float32Array(NE * 3), eRnd = new Float32Array(NE * 4);
      for (let i = 0; i < NE; i++) {
        const kind = rnd();
        let a, f;
        if (kind < 0.62) { const e = Math.pow(rnd(), 0.55); a = 0.21 + 0.29 * e; f = 0.35 + 0.65 * e * e; if (rnd() < 0.22) { a = 0.20 + rnd() * 0.02; f = 0.9; } }     // iris, heavier toward its outer ring, and the pupil's edge
        else { a = 0.52 + rnd() * 0.75; f = 0.05; }                                                              // the ball
        eR.set([a, rnd() * Math.PI * 2, f], i * 3); eRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4);
      }
      const eye = mk(NE, new Float32Array(NE * 3), new Float32Array(NE * 2), eRnd, eR, new Float32Array(NE));
      const ND = 2200, dR = new Float32Array(ND * 3), dRnd = new Float32Array(ND * 4);
      for (let i = 0; i < ND; i++) { dR.set([(rnd() - 0.5) * 9, (rnd() - 0.5) * 10, -6 + rnd() * 14], i * 3); dRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4); }
      const dust = mk(ND, new Float32Array(ND * 3), new Float32Array(ND * 2), dRnd, dR, new Float32Array(ND));
      const rows = Math.ceil(nF / 128), posTex = G.dataTex(128, rows), nrmTex = G.dataTex(128, rows);
      part = { face, eye, dust, posTex, nrmTex, posData: new Float32Array(128 * rows * 4), nrmData: new Float32Array(128 * rows * 4) };
      gl.bindVertexArray(null);
    }

    // ---- second-round particles: one set per variant
    const V2 = {
      // refined: more, finer points; a silver key light; restrained bursts
      particlesA: { count: 64000, tail: 9000, px: 0.0235, key: 1.45, amb: 0.16, rim: 1.00, line: 2.0, lineWhite: 0.85, burst: 0.80, kick: 0.030, wave: 0.7, sparkle: 1.0, skin: 0.060, bloom: 0.36, dof: 0.0026 },
      // bolder: fewer, larger points; more crimson, hotter lines, bigger bursts and breaths
      particlesB: { count: 30000, tail: 6000, px: 0.0400, key: 0.85, amb: 0.26, rim: 2.30, line: 2.4, lineWhite: 0.45, burst: 1.50, kick: 0.060, wave: 1.8, sparkle: 1.8, skin: 0.105, bloom: 0.55, dof: 0.0040 },
    };
    // round 3: Bolder as the base for the colour system, the particle eyes and the gift / chat effects
    V2.particlesC = { ...V2.particlesB };
    const part2 = {};
    const FXMAX = 24000, fxData = new Float32Array(FXMAX * 7), fxBuf = G.buffer(fxData, true), fxVao = gl.createVertexArray();
    gl.bindVertexArray(fxVao); G.attrib(pFx, 'aPos', fxBuf, 3, { stride: 28, offset: 0 }); G.attrib(pFx, 'aCol', fxBuf, 4, { stride: 28, offset: 12 }); gl.bindVertexArray(null);
    function buildParticles2(name) {
      const cfg = V2[name];
      let seed = 987654 + cfg.count;
      const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const ix = M.index, nT = ix.length / 3, R = M.rest, K = M.mask;
      const sample = (count, weight) => {
        const cum = new Float64Array(nT); let total = 0;
        for (let t = 0; t < nT; t++) {
          const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2];
          const ux = R[b * 3] - R[a * 3], uy = R[b * 3 + 1] - R[a * 3 + 1], uz = R[b * 3 + 2] - R[a * 3 + 2], vx = R[c * 3] - R[a * 3], vy = R[c * 3 + 1] - R[a * 3 + 1], vz = R[c * 3 + 2] - R[a * 3 + 2];
          total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * weight(a, b, c); cum[t] = total;
        }
        const aTri = new Float32Array(count * 3), aBary = new Float32Array(count * 3), aRnd = new Float32Array(count * 4), aRest = new Float32Array(count * 3), aFeat = new Float32Array(count), aM = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
          const u = rnd() * total; let lo = 0, hi = nT - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
          const a = ix[lo * 3], b = ix[lo * 3 + 1], c = ix[lo * 3 + 2];
          let b0 = rnd(), b1 = rnd(); if (b0 + b1 > 1) { b0 = 1 - b0; b1 = 1 - b1; }
          const b2 = 1 - b0 - b1, mix = (arr) => arr[a] * b0 + arr[b] * b1 + arr[c] * b2;
          aTri.set([a, b, c], i * 3); aBary.set([b0, b1, mix(K.rim)], i * 3); aRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4);
          for (let k = 0; k < 3; k++) aRest[i * 3 + k] = R[a * 3 + k] * b0 + R[b * 3 + k] * b1 + R[c * 3 + k] * b2;
          aFeat[i] = mix(K.feature); aM.set([mix(K.lipIn), mix(K.lid), mix(K.brow), mix(K.struct)], i * 4);
        }
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        G.attrib(pPart2, 'aTri', G.buffer(aTri), 3); G.attrib(pPart2, 'aBary', G.buffer(aBary), 3); G.attrib(pPart2, 'aRnd', G.buffer(aRnd), 4); G.attrib(pPart2, 'aRest', G.buffer(aRest), 3); G.attrib(pPart2, 'aFeat', G.buffer(aFeat), 1); G.attrib(pPart2, 'aM', G.buffer(aM), 4);
        return { vao, n: count };
      };
      const mx = (arr, a, b, c) => Math.max(arr[a], arr[b], arr[c]), av = (arr, a, b, c) => (arr[a] + arr[b] + arr[c]) / 3;
      // flat skin least, bones more, features more again, the three line features far above that; the outline thins out
      const face = sample(cfg.count, (a, b, c) => (0.55 + 1.6 * av(K.struct, a, b, c) + 2.0 * av(K.feature, a, b, c) + 7.0 * Math.pow(mx(K.lipIn, a, b, c), 3) + 5.0 * Math.pow(mx(K.lid, a, b, c), 3) + 4.0 * Math.pow(av(K.brow, a, b, c), 4)) * (1 - 0.7 * av(K.rim, a, b, c)));
      const tail = sample(cfg.tail, (a, b, c) => Math.pow(av(K.rim, a, b, c), 1.5));
      // two eyes to choose from, both made of points on the eyeball (angle from the gaze, angle round it, brightness; aM.x = how white)
      const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 0.58;
      const eyeSet = (kind) => {
        const NE = kind === 1 ? 2200 : 1700, eR = new Float32Array(NE * 3), eM = new Float32Array(NE * 4), eRnd = new Float32Array(NE * 4);
        for (let i = 0; i < NE; i++) {
          const u = rnd(); let a, ph = rnd() * Math.PI * 2, f, wh;
          if (kind === 1) {
            // A, "iris": fine radial fibres of points round an empty pupil, brightest in the middle of the ring, a small catch-light
            // (bold on purpose: 26 thick fibres, a ring at the rim, a clean dark pupil, a catch-light big enough to see on a phone)
            if (u < 0.52) { const e = Math.pow(rnd(), 0.7); a = 0.215 + 0.25 * e; ph = Math.floor(rnd() * 26) / 26 * Math.PI * 2 + gauss() * 0.045; f = 0.75 + 0.9 * Math.exp(-Math.pow((e - 0.45) / 0.4, 2)); wh = 0.12 + 0.45 * Math.pow(1 - e, 2); }
            else if (u < 0.70) { a = 0.465 + gauss() * 0.012; f = 1.25; wh = 0.05; }                 // the rim of the iris
            else if (u < 0.80) { a = 0.205 + Math.abs(gauss()) * 0.012; f = 1.5; wh = 0.75; }         // the edge of the pupil, bright
            else if (u < 0.90) { const q = Math.sqrt(rnd()) * 0.085, th = rnd() * Math.PI * 2, cx = 0.27 * Math.cos(2.25), cy = 0.27 * Math.sin(2.25), x = cx + q * Math.cos(th), y = cy + q * Math.sin(th); a = Math.hypot(x, y); ph = Math.atan2(y, x); f = 3.0; wh = 1; }     // the catch-light
            else { a = 0.50 + rnd() * 0.80; f = 0.10; wh = 0; }
          } else {
            // B, "star": no iris at all: a small hot core of points where he looks, a soft halo round it
            if (u < 0.50) { a = Math.abs(gauss()) * 0.11; f = 1.9 * Math.exp(-Math.pow(a / 0.15, 2)) + 0.3; wh = 0.9; }
            else if (u < 0.85) { const e = rnd(); a = 0.12 + 0.36 * e * e; f = 0.60 * (1 - e) + 0.10; wh = 0.15; }
            else { a = 0.50 + rnd() * 0.80; f = 0.09; wh = 0; }
          }
          eR.set([a, ph, f], i * 3); eM[i * 4] = wh; eRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4);
        }
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        G.attrib(pPart2, 'aRnd', G.buffer(eRnd), 4); G.attrib(pPart2, 'aRest', G.buffer(eR), 3); G.attrib(pPart2, 'aM', G.buffer(eM), 4);
        return { vao, n: NE };
      };
      const eyes = { 1: eyeSet(1), 2: eyeSet(2) };
      const ND = 900, dR = new Float32Array(ND * 3), dRnd = new Float32Array(ND * 4);
      for (let i = 0; i < ND; i++) { dR.set([(rnd() - 0.5) * 9, (rnd() - 0.5) * 10, -6 + rnd() * 12], i * 3); dRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4); }
      const dv = gl.createVertexArray(); gl.bindVertexArray(dv);
      G.attrib(pPart2, 'aRnd', G.buffer(dRnd), 4); G.attrib(pPart2, 'aRest', G.buffer(dR), 3);
      const rows = Math.ceil(nF / 128);
      part2[name] = { face, tail, eyes, dust: { vao: dv, n: ND }, posTex: G.dataTex(128, rows), nrmTex: G.dataTex(128, rows), posData: new Float32Array(128 * rows * 4), nrmData: new Float32Array(128 * rows * 4) };
      gl.bindVertexArray(null);
    }

    // ---- HEAD options (V4-MASK.md, "Head options"): point sets fixed in head space round the face, so it reads as a head
    // made of particles and not a front mask. Units: his eye distance = 1; eyes at y = 0; +z toward the camera.
    const HEADS = { none: [], head: ['skull'], hair: ['skull', 'hair'], horns: ['skull', 'horns'], flames: ['skull', 'flames'], demon: ['skull', 'horns', 'embers'] };
    const headSets = {};
    function buildHeadSet(kind) {
      let seed = 4242 + kind.length * 977;
      const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const pos = [], nrm = [], ft = [], pm = [], bar = [];
      const add = (p, n, f, part, u = 0, v = 0, w = 1) => { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); ft.push(f); pm.push(part, 0, 0, 0); bar.push(u, v, w); };
      const inFace = (x, y) => { const ex = x / 1.02, ey = (y + 0.42) / 1.42; return ex * ex + ey * ey < 1; };      // the face oval, as an ellipse (centre (0, -0.42), half-axes 1.02 x 1.42)
      const C = [0, 0.12, -0.92], RX = 1.10, RY = 1.42, RZ = 1.26;        // the cranium: an ellipsoid behind the face
      const onSkull = (th, ph) => { const sx = Math.sin(ph) * Math.cos(th), sy = Math.cos(ph), sz = Math.sin(ph) * Math.sin(th); const p = [C[0] + RX * sx, C[1] + RY * sy, C[2] + RZ * sz], n = [sx / RX, sy / RY, sz / RZ], l = Math.hypot(n[0], n[1], n[2]); return [p, [n[0] / l, n[1] / l, n[2] / l]]; };
      if (kind === 'skull') {
        for (let i = 0; i < 15000; i++) {
          const [p, n] = onSkull(rnd() * Math.PI * 2, Math.acos(1 - 2 * rnd()));
          if (p[2] > -0.42 && inFace(p[0], p[1])) continue;                // the face is there
          if (p[1] < -0.95) continue;                                      // below: the neck takes over
          add(p, n, 0.35 + 0.5 * rnd(), 0);
        }
        for (let i = 0; i < 2200; i++) {                                     // the neck: a column that fades out downward
          const a = rnd() * Math.PI * 2, y = -0.85 - Math.pow(rnd(), 1.8) * 1.25, r = 0.50 + 0.16 * Math.pow(Math.max(0, -1.35 - y), 1.5);
          add([Math.cos(a) * r, y, -0.62 + Math.sin(a) * r * 0.92], [Math.cos(a), 0, Math.sin(a)], (0.3 + 0.4 * rnd()) * Math.pow(Math.max(0, 1 - (-0.85 - y) / 1.25), 1.5), 0);
        }
        for (const side of [-1, 1]) for (let i = 0; i < 700; i++) {         // the ears: a rim, an inner fold
          const a = rnd() * Math.PI * 2, inner = rnd() < 0.35 ? 0.55 : 1, w = (rnd() - 0.5) * 0.03;
          add([side * (1.10 + 0.07 * Math.abs(Math.sin(a)) * inner + w), -0.02 + 0.33 * Math.sin(a) * inner, -0.78 + 0.17 * Math.cos(a) * inner - 0.05 * inner], [side * 0.9, 0, 0.42], inner === 1 ? 0.95 : 0.5, 0);
        }
      } else if (kind === 'hair') {
        // strands: rooted on the scalp, combed back and down over the cranium to a bob at the jaw
        for (let sIdx = 0; sIdx < 2600; sIdx++) {
          let th = rnd() * Math.PI * 2, ph = Math.acos(1 - 1.25 * rnd());
          let [p, n] = onSkull(th, ph);
          if (p[2] > -0.30 && p[1] < 0.98) continue;                       // the hairline: above the forehead, behind the temples
          if (p[1] < -0.35) continue;
          const sheen = 0.25 + 0.75 * rnd(), len = 9 + Math.floor(rnd() * 12), lift = 0.05 + 0.07 * rnd();
          let q = p.slice();
          for (let k = 0; k < len; k++) {
            const u = k / 20;
            add([q[0] + n[0] * (lift + 0.10 * u), q[1] + n[1] * (lift + 0.10 * u), q[2] + n[2] * (lift + 0.10 * u)], n, sheen * (0.6 + 0.6 * Math.abs(Math.sin(k * 0.9 + sIdx))), 1, u);
            // comb: down and back along the surface
            let d = [0.25 * Math.sign(q[0] || 1) * (q[2] > -0.6 ? 1 : 0.2), -1, -0.55];
            const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]; d = [d[0] - dn * n[0], d[1] - dn * n[1], d[2] - dn * n[2]];
            const dl = Math.hypot(d[0], d[1], d[2]) || 1; q = [q[0] + d[0] / dl * 0.085, q[1] + d[1] / dl * 0.085, q[2] + d[2] / dl * 0.085];
            if (q[1] > -0.85) {                                            // stay on the cranium; below it the hair hangs free
              const e = [(q[0] - C[0]) / RX, (q[1] - C[1]) / RY, (q[2] - C[2]) / RZ], el = Math.hypot(e[0], e[1], e[2]);
              q = [C[0] + RX * e[0] / el, C[1] + RY * e[1] / el, C[2] + RZ * e[2] / el]; n = [e[0] / el / RX, e[1] / el / RY, e[2] / el / RZ]; const nl = Math.hypot(n[0], n[1], n[2]); n = [n[0] / nl, n[1] / nl, n[2] / nl];
            }
            if (q[1] < -1.25) break;
          }
        }
      } else if (kind === 'horns') {
        // two horns from the upper forehead: out, up and back, then curling forward; ridged; thick at the root, a point at the tip
        for (const side of [-1, 1]) {
          const at = (u) => [side * (0.50 + 0.42 * u + 0.30 * u * u), 0.86 + 1.15 * u - 0.28 * u * u, 0.02 - 0.62 * u + 0.78 * u * u * u];
          for (let i = 0; i < 4200; i++) {
            const u = Math.pow(rnd(), 0.85), a = rnd() * Math.PI * 2, ridge = Math.pow(0.5 + 0.5 * Math.cos(u * 2 * Math.PI * 9), 6);
            const c = at(u), c2 = at(Math.min(1, u + 0.01)), tg = [c2[0] - c[0], c2[1] - c[1], c2[2] - c[2]], tl = Math.hypot(tg[0], tg[1], tg[2]) || 1, T = [tg[0] / tl, tg[1] / tl, tg[2] / tl];
            let b1 = [T[1], -T[0], 0]; const bl = Math.hypot(b1[0], b1[1], b1[2]) || 1; b1 = [b1[0] / bl, b1[1] / bl, b1[2] / bl];
            const b2 = [T[1] * b1[2] - T[2] * b1[1], T[2] * b1[0] - T[0] * b1[2], T[0] * b1[1] - T[1] * b1[0]];
            const r = (0.185 * Math.pow(1 - u, 0.75) + 0.008) * (1 + 0.10 * ridge), n = [b1[0] * Math.cos(a) + b2[0] * Math.sin(a), b1[1] * Math.cos(a) + b2[1] * Math.sin(a), b1[2] * Math.cos(a) + b2[2] * Math.sin(a)];
            add([c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r], n, 0.25 + 0.75 * ridge, 2, u);
          }
        }
      } else {
        // flames (a crown of heat off the scalp) or embers (a few, off the brow and the horn roots)
        const n = kind === 'flames' ? 22000 : 2600, tall = kind === 'flames' ? 1 : 0.55;
        for (let i = 0; i < n; i++) {
          const [p, nn] = onSkull(rnd() * Math.PI * 2, Math.acos(1 - 0.75 * rnd()));
          if (p[2] > -0.30 && p[1] < 0.95) continue;
          add([p[0] + nn[0] * 0.03, p[1] + nn[1] * 0.03, p[2] + nn[2] * 0.03], nn, 1, 3, rnd(), rnd(), tall * (0.6 + 0.4 * Math.max(0, nn[1])));
        }
      }
      const cnt = ft.length, rn = new Float32Array(cnt * 4); for (let i = 0; i < cnt * 4; i++) rn[i] = rnd();
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      G.attrib(pPart2, 'aRest', G.buffer(new Float32Array(pos)), 3); G.attrib(pPart2, 'aTri', G.buffer(new Float32Array(nrm)), 3); G.attrib(pPart2, 'aFeat', G.buffer(new Float32Array(ft)), 1);
      G.attrib(pPart2, 'aM', G.buffer(new Float32Array(pm)), 4); G.attrib(pPart2, 'aBary', G.buffer(new Float32Array(bar)), 3); G.attrib(pPart2, 'aRnd', G.buffer(rn), 4);
      gl.bindVertexArray(null);
      return { vao, n: cnt };
    }

    const kickU = new Float32Array(16), hitU = new Float32Array(8);
    const CRIM3 = [1.0, 0.045, 0.03], CHROME3 = [1.0, 0.93, 0.86], IMP0 = new Float32Array(40), IMPT0 = new Float32Array(40).fill(0), IMPC0 = new Float32Array(30);
    for (let i = 0; i < 10; i++) IMPT0[i * 4] = 99;
    const TAP0 = new Float32Array(24); for (let i = 0; i < 6; i++) TAP0[i * 4 + 3] = 99;
    // ---- the visualizer's own motion. The shader knows only "now"; how far the lens has flown down the tunnel, how far the
    // yin-yang has turned and how far the ridges have rolled are sums over the song so far, kept here. A jump in time (a
    // still, a loop) starts them again from a fixed place, so one frame is always one picture.
    const BG_NAMES = ['black', 'summer', 'ice', 'forge', 'nebula', 'studio', 'street'];
    const VIZ_NAMES = ['orb', 'tunnel', 'yinyang', 'ridges', 'blackhole', 'helix'];
    // the two colours of the yin-yang, per background (linear light). They must mix to something clean: crimson + gold =
    // amber (black), ember + pale gold = orange (summer), deep cyan + white = pale cyan (ice). Never crimson + white (pink).
    const VIZ_COL = [[[1.30, 0.060, 0.035], [1.15, 0.70, 0.17]], [[1.30, 0.17, 0.05], [1.25, 1.02, 0.62]], [[0.07, 0.48, 1.20], [1.05, 1.15, 1.22]],
      [[1.35, 0.20, 0.03], [1.30, 1.00, 0.58]], [[1.30, 0.060, 0.035], [1.20, 0.74, 0.20]], [[1.15, 0.66, 0.15], [1.12, 1.08, 1.04]], [[1.30, 0.060, 0.035], [1.30, 0.52, 0.07]]];      // forge, nebula, studio, street
    const VZ = { t: null, env: new Float32Array(4), move: new Float32Array(4) };
    function vizStep(t, A, kicks, hits) {
      let kc = 0, kv = 0, mg = 0, hv = 0;
      for (const k of kicks) { const a = k[0], s = k[1]; if (a < 0 || a > 3) continue; kc += s * (Math.exp(-a * 6) - Math.exp(-a * 24)) * 1.9; kv += s * Math.exp(-a * 7); }
      for (const k of hits) { const a = k[0], s = k[1]; if (a < 0 || a > 6) continue; mg += s * (Math.exp(-a * 2.1) - Math.exp(-a * 10)) * 1.75; hv += s * Math.exp(-a * 2.5); }
      VZ.env[0] = Math.min(1, kc); VZ.env[1] = Math.min(1, mg);
      const dt = VZ.t === null ? -1 : t - VZ.t; VZ.t = t;
      if (dt <= 0 || dt > 0.3) { VZ.move[0] = t * 0.21; VZ.move[1] = t * 1.25; VZ.move[2] = t * 4.6; VZ.move[3] = (t * 0.85) % 12.566370614; return; }
      VZ.move[0] += dt * (0.07 + 0.17 * A.level + 0.10 * A.bass + 1.5 * kv);            // down the tunnel: the level carries it, a kick pushes
      VZ.move[1] += dt * (0.35 + 0.95 * A.level + 0.5 * A.mid + 2.2 * kv + 7.8 * hv);     // the yin-yang turns; a drop swings it half round (they swap sides)
      VZ.move[2] += dt * (1.2 + 4.0 * A.level + 1.5 * A.bass + 9.0 * kv);                // the ridges roll
      VZ.move[3] += dt * (0.30 + 0.70 * A.level + 0.35 * A.bass + 1.8 * kv);            // the black hole's disc and the helix turn (whole turns of every lane fit in 4 pi)
      VZ.move[0] %= 1; VZ.move[1] %= 25.132741; VZ.move[3] %= 12.566370614; if (VZ.move[2] > 30000) VZ.move[2] -= 30000;      // kept small: hours of show must not wear the numbers out
    }
    const VIEW = { fov: 19.5 * Math.PI / 180, dist: 14, targetY: -0.60, halfH: 2.405 };
    function draw(look, S) {
      const { time: t, audio: A } = S;
      for (let i = 0; i < 8; i++) { const k = S.kicks[i] || [99, 0]; kickU[i * 2] = k[0]; kickU[i * 2 + 1] = k[1]; }
      for (let i = 0; i < 4; i++) { const k = S.hits[i] || [99, 0]; hitU[i * 2] = k[0]; hitU[i * 2 + 1] = k[1]; }
      // camera: a long lens, a slow drift so a still face is never a still picture, a small push on the beat
      const sway = S.still ? 0 : 1, beatPush = 1 - 0.012 * A.beat - 0.010 * A.bass;
      const FX0 = S.fx || null, KK = FX0 ? FX0.kick : [0, 0, 0], HEADP = HEADS[S.headPart] || [], back = (FX0 ? 1 + 0.34 * Math.max(0, FX0.scale - 1) : 1) * (HEADP.length ? (S.headPart === 'head' ? 1.16 : 1.32) : 1), hUp = HEADP.length ? (S.headPart === 'head' ? 0.10 : 0.34) : 0;
      const cam = [Math.sin(t * 0.31) * 0.42 * sway + KK[0] * 0.16, VIEW.targetY + 0.10 + Math.sin(t * 0.23 + 1.0) * 0.16 * sway + KK[1] * 0.12, VIEW.dist * beatPush * back * (1 - 0.035 * KK[2])];
      cam[1] += hUp;
      const view = M4.lookAt(cam, [-KK[0] * 0.05, VIEW.targetY - KK[1] * 0.04 + hUp, 0], [0, 1, 0]);
      const proj = M4.perspective(VIEW.fov, G.W / G.H, 2, 60);
      // V7: where the face sits and how big it is (S.place = { zoom, x, y }, x / y in parts of the picture, + = right / up).
      // Done AFTER the camera, on the finished picture positions, so the face and everything that belongs to it (its
      // points, missiles, rings, the Visualizer's formation) move and grow together; the background and the drifting
      // dust are drawn with the plain camera (vp0) and stay full frame.
      const vp0 = M4.mul(proj, view), PLC = S.place || null, ps = PLC ? PLC.zoom : 1, pox = PLC ? 2 * PLC.x : 0, poy = PLC ? 2 * PLC.y : 0;
      let vp = vp0;
      if (PLC && (ps !== 1 || pox || poy)) { vp = vp0.slice(); for (let c = 0; c < 4; c++) { vp[c * 4] = ps * vp0[c * 4] + pox * vp0[c * 4 + 3]; vp[c * 4 + 1] = ps * vp0[c * 4 + 1] + poy * vp0[c * 4 + 3]; } }
      const FX = S.fx || null, PAL = S.palette || null;
      const hx = S.head.x, hy = S.head.y, sc = S.head.scale * (FX ? FX.scale * (1 + 0.03 * FX.pulse) : 1);
      const model = M4.trs(S.head.R, sc, [hx, hy, 0]);
      const BGI = Math.max(0, BG_NAMES.indexOf(S.bg)), VIZ = FX ? FX.viz : 0;
      // the visualizer: which formation (and the one it is leaving), and how far the music has carried it
      const FORM = FX && FX.form ? FX.form : [S.viz || 'orb', S.viz || 'orb', 1];
      const VZF = [Math.max(0, VIZ_NAMES.indexOf(FORM[0])), Math.max(0, VIZ_NAMES.indexOf(FORM[1]))], VZK = FORM[2], VC = S.vizCol || VIZ_COL[BGI];
      vizStep(t, A, S.kicks, S.hits);
      const fa = FX ? FX.flash : [0, 0, 0, 0], fb = PAL && PAL.flash ? PAL.flash : [0, 0, 0, 0], flashU = fa[3] >= fb[3] ? fa : fb;
      const envRot = 0.22 * Math.sin(t * 0.19) + 0.10 * Math.sin(t * 0.43 + 2.0);
      const common = (p) => p.use().u('uModel', model).u('uViewProj', vp).u('uCam', cam).u('uTime', t).u('uBass', A.bass).u('uMid', A.mid).u('uHigh', A.high).u('uBeat', A.beat).u('uLevel', A.level).u('uEnvRot', envRot).uv('uKick', 2, kickU).uv('uHit', 2, hitU)
        .u('uShade', PAL ? PAL.shade : CRIM3).u('uShade2', PAL ? PAL.shade2 : CRIM3).u('uKeyCol', PAL ? PAL.key : CHROME3).u('uAccent', PAL ? PAL.accent : CHROME3).u('uGain', (PAL ? PAL.gain : 1) * (FX ? 1 - 0.42 * FX.brace : 1))
        .u('uLock', FX && FX.lock ? [FX.lock.pos[0], FX.lock.pos[1], FX.lock.pos[2], FX.lock.r] : [0, 0, 0, 9]).u('uLockCol', FX && FX.lock ? [FX.lock.col[0], FX.lock.col[1], FX.lock.col[2], FX.lock.a] : [0, 0, 0, 0])
        .u('uFlash', flashU).u('uRainbow', FX ? FX.rainbow : 0).u('uPulse', FX ? FX.pulse : 0).u('uShatter', FX ? FX.shatter : 0).u('uRing', FX ? FX.ring : [99, 0]).u('uRingCol', FX ? FX.ringCol : CRIM3)
        .ui('uNImp', FX ? FX.nImp : 0).uv('uTap', 4, FX ? FX.taps : TAP0).u('uStreak', FX ? FX.streak : 0).u('uViz', FX ? FX.viz : 0).ui('uVizFa', VZF[0]).ui('uVizFb', VZF[1]).u('uVizK', VZK).u('uVizEnv', VZ.env).u('uVizMove', VZ.move).u('uVizC1', VC[0]).u('uVizC2', VC[1]).ui('uBg', BGI).uv('uImp', 4, FX ? FX.imp : IMP0).uv('uImpT', 4, FX ? FX.impT : IMPT0).uv('uImpC', 3, FX ? FX.impC : IMPC0);
      // where the head is on screen (for the background)
      const hc = [hx, hy - 0.45 * sc, 0];
      const cw = vp[3] * hc[0] + vp[7] * hc[1] + vp[11] * hc[2] + vp[15];
      const hs = [(vp[0] * hc[0] + vp[4] * hc[1] + vp[8] * hc[2] + vp[12]) / cw, (vp[1] * hc[0] + vp[5] * hc[1] + vp[9] * hc[2] + vp[13]) / cw];
      const headR = 1.15 * sc * ps / VIEW.halfH;

      gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, core.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, bNrm); gl.bufferSubData(gl.ARRAY_BUFFER, 0, core.nrm);
      gl.bindBuffer(gl.ARRAY_BUFFER, bAct); gl.bufferSubData(gl.ARRAY_BUFFER, 0, core.act);
      // mouth geometry
      const ring = core.mouth.ring; let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < NR; k++) { cx += ring[k * 3] / NR; cy += ring[k * 3 + 1] / NR; cz += ring[k * 3 + 2] / NR; }
      for (let k = 0; k < NR; k++) {
        mouthPos[k * 3] = ring[k * 3]; mouthPos[k * 3 + 1] = ring[k * 3 + 1]; mouthPos[k * 3 + 2] = ring[k * 3 + 2] - 0.012;
        mouthPos[(NR + k) * 3] = cx + (ring[k * 3] - cx) * 0.8; mouthPos[(NR + k) * 3 + 1] = cy + (ring[k * 3 + 1] - cy) * 0.8; mouthPos[(NR + k) * 3 + 2] = cz - 0.22;
      }
      mouthPos[NR * 6] = cx; mouthPos[NR * 6 + 1] = cy; mouthPos[NR * 6 + 2] = cz - 0.34;
      gl.bindBuffer(gl.ARRAY_BUFFER, bMouth); gl.bufferSubData(gl.ARRAY_BUFFER, 0, mouthPos);

      G.beginScene();
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      const bgStyle = look === 'chrome' ? 0 : look === 'particles' || V2[look] ? 1 : look === 'obsidian' ? 2 : 1;
      // where the black hole's dark is in the picture (its middle is the formations' middle), and how much of it is there
      const bc = [0, -0.55, 0], bw = vp[3] * bc[0] + vp[7] * bc[1] + vp[11] * bc[2] + vp[15], holeW = VIZ * ((VZF[0] === 4 ? VZK : 0) + (VZF[1] === 4 && VZF[0] !== 4 ? 1 - VZK : 0));
      const hole = [(vp[0] * bc[0] + vp[4] * bc[1] + vp[8] * bc[2] + vp[12]) / bw, (vp[1] * bc[0] + vp[5] * bc[1] + vp[9] * bc[2] + vp[13]) / bw, 0.50 * (1.0 + 0.05 * A.bass - 0.10 * VZ.env[0]) * ps * proj[5] / bw, Math.max(0, Math.min(1, holeW * 1.6 - 0.6))];
      common(pBg).u('uHead', hs).u('uAspect', G.W / G.H).u('uHeadR', headR).ui('uStyle', bgStyle).u('uHole', hole);
      G.fsTri();
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      const v2 = V2[look] || null;
      const style = v2 ? 2 : look === 'obsidian' ? 1 : look === 'particles' ? 2 : 0;
      const faceProg = v2 ? 'skin' : look === 'particles' ? 'occlude' : look;
      common(progs[faceProg]).u('uRipple', look === 'chrome' ? 0.022 : look === 'obsidian' ? 0.006 : 0).u('uShrink', look === 'particles' || v2 ? 0.03 : 0).u('uSkin', v2 ? v2.skin : 0);
      const solid = VIZ < 0.04;                                           // in the visualizer there is no head to hide points behind
      if (solid) { gl.bindVertexArray(faceVao[faceProg]); gl.drawElements(gl.TRIANGLES, M.index.length, gl.UNSIGNED_INT, 0); }
      common(pEye).ui('uStyle', style); gl.bindVertexArray(eyeVao);
      if (solid) for (const e of core.eyes) { pEye.u('uCenter', e.c).u('uRadius', look === 'particles' ? e.r * 0.94 : e.r).u('uGaze', e.gaze); gl.drawElements(gl.TRIANGLES, si.length, gl.UNSIGNED_SHORT, 0); }
      common(pMouth).ui('uStyle', v2 ? 3 : style).u('uOpen', core.mouth.open); gl.bindVertexArray(mouthVao); if (solid) gl.drawElements(gl.TRIANGLES, mi.length, gl.UNSIGNED_SHORT, 0);

      if (look === 'particles') {
        if (!part) buildParticles();
        const pd = part.posData, nd = part.nrmData, P = core.pos, Nn = core.nrm, act = core.act;
        for (let i = 0; i < nF; i++) { pd[i * 4] = P[i * 3]; pd[i * 4 + 1] = P[i * 3 + 1]; pd[i * 4 + 2] = P[i * 3 + 2]; pd[i * 4 + 3] = act[i]; nd[i * 4] = Nn[i * 3]; nd[i * 4 + 1] = Nn[i * 3 + 1]; nd[i * 4 + 2] = Nn[i * 3 + 2]; }
        part.posTex.set(pd); part.nrmTex.set(nd);
        gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        common(pPart); G.bindTex(0, part.posTex.tex); G.bindTex(1, part.nrmTex.tex);
        pPart.ui('uPosTex', 0).ui('uNrmTex', 1).u('uPx', G.H * 0.017).u('uFocus', VIEW.dist - 0.35 * sc).u('uDof', G.H * 0.0032);
        pPart.ui('uMode', 2); gl.bindVertexArray(part.dust.vao);
        pPart.u('uViewProj', vp0).u('uModel', M4.trs([1, 0, 0, 0, 1, 0, 0, 0, 1], 1, [0, 0, 0])); gl.drawArrays(gl.POINTS, 0, part.dust.n);
        pPart.u('uViewProj', vp).u('uModel', model).u('uPx', G.H * 0.017 * ps).u('uDof', G.H * 0.0032 * ps);
        pPart.ui('uMode', 0); gl.bindVertexArray(part.face.vao); gl.drawArrays(gl.POINTS, 0, part.face.n);
        pPart.ui('uMode', 1); gl.bindVertexArray(part.eye.vao);
        for (const e of core.eyes) { pPart.u('uEyeC', e.c).u('uEyeR', e.r).u('uGaze', e.gaze).u('uEyeOpen', e.open); gl.drawArrays(gl.POINTS, 0, part.eye.n); }
        gl.disable(gl.BLEND); gl.depthMask(true);
      }
      if (v2) {
        if (!part2[look]) buildParticles2(look);
        const pt = part2[look], pd = pt.posData, nd = pt.nrmData, P = core.pos, Nn = core.nrm, act = core.act;
        for (let i = 0; i < nF; i++) { pd[i * 4] = P[i * 3]; pd[i * 4 + 1] = P[i * 3 + 1]; pd[i * 4 + 2] = P[i * 3 + 2]; pd[i * 4 + 3] = act[i]; nd[i * 4] = Nn[i * 3]; nd[i * 4 + 1] = Nn[i * 3 + 1]; nd[i * 4 + 2] = Nn[i * 3 + 2]; }
        pt.posTex.set(pd); pt.nrmTex.set(nd);
        gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        common(pPart2); G.bindTex(0, pt.posTex.tex); G.bindTex(1, pt.nrmTex.tex);
        pPart2.ui('uPosTex', 0).ui('uNrmTex', 1).u('uPx', G.H * v2.px).u('uFocus', VIEW.dist - 0.35 * sc).u('uDof', G.H * v2.dof)
          .u('uKey', v2.key).u('uAmb', v2.amb).u('uRim', v2.rim).u('uLine', v2.line).u('uLineWhite', v2.lineWhite).u('uBurst', v2.burst).u('uKickAmt', v2.kick).u('uSparkle', v2.sparkle).u('uWave', v2.wave);
        pPart2.ui('uMode', 2).u('uViewProj', vp0).u('uModel', M4.trs([1, 0, 0, 0, 1, 0, 0, 0, 1], 1, [0, 0, 0])); gl.bindVertexArray(pt.dust.vao); gl.drawArrays(gl.POINTS, 0, pt.dust.n);
        pPart2.u('uViewProj', vp).u('uModel', model).u('uPx', G.H * v2.px * ps).u('uDof', G.H * v2.dof * ps);
        pPart2.ui('uMode', 3); gl.bindVertexArray(pt.tail.vao); gl.drawArrays(gl.POINTS, 0, pt.tail.n);
        pPart2.ui('uMode', 4);
        for (const k of HEADP) { const hs = headSets[k] || (headSets[k] = buildHeadSet(k)); gl.bindVertexArray(hs.vao); gl.drawArrays(gl.POINTS, 0, hs.n); }
        pPart2.ui('uMode', 0); gl.bindVertexArray(pt.face.vao); gl.drawArrays(gl.POINTS, 0, pt.face.n);
        const eyeSetNow = pt.eyes[S.eyeStyle === 2 ? 2 : 1];
        pPart2.ui('uMode', 1); gl.bindVertexArray(eyeSetNow.vao);
        for (const e of core.eyes) { pPart2.u('uEyeC', e.c).u('uEyeR', e.r).u('uGaze', e.gaze).u('uEyeOpen', e.open); gl.drawArrays(gl.POINTS, 0, eyeSetNow.n); }
        if (FX && (FX.missiles.length || FX.bursts.length || FX.glints.length || FX.taps[3] < 0.3)) {
          // A missile is light: a white-hot core inside a wide glow (it blooms), and a thick tail of points along the
          // curve it has flown, in the colour of the gift, that keeps burning for a moment after it lands. A landing is a flash.
          let n = 0;
          const put = (x, y, z, r, g, b, sz) => { if (n >= FXMAX) return; const o = n * 7; fxData[o] = x; fxData[o + 1] = y; fxData[o + 2] = z; fxData[o + 3] = r; fxData[o + 4] = g; fxData[o + 5] = b; fxData[o + 6] = sz; n++; };
          const mdl = model, tw = (p) => [mdl[0] * p[0] + mdl[4] * p[1] + mdl[8] * p[2] + mdl[12], mdl[1] * p[0] + mdl[5] * p[1] + mdl[9] * p[2] + mdl[13], mdl[2] * p[0] + mdl[6] * p[1] + mdl[10] * p[2] + mdl[14]];
          for (const m of FX.missiles) {
            const end = tw(m.target), uu = Math.min(1, m.u), u1 = Math.pow(uu, 1.6), landed = m.u > 1;
            const burn = landed ? Math.max(0, 1 - (m.u - 1) * m.dur / 0.45) : 1;                 // after the landing the tail fades out
            const at = (u) => { const a = (1 - u) * (1 - u), b2 = 2 * u * (1 - u), c = u * u; return [a * m.start[0] + b2 * m.ctrl[0] + c * end[0], a * m.start[1] + b2 * m.ctrl[1] + c * end[1], a * m.start[2] + b2 * m.ctrl[2] + c * end[2]]; };
            const c = m.col, W = (w, k) => [(c[0] * (1 - w) + w) * k, (c[1] * (1 - w) + w) * k, (c[2] * (1 - w) + w) * k];
            if (!landed) {
              const h = at(u1), g = W(0.35, 1.5), core = W(0.85, 16);
              put(h[0], h[1], h[2], g[0], g[1], g[2], m.size * 15);                              // the glow
              put(h[0], h[1], h[2], core[0], core[1], core[2], m.size * 4.2);                    // the core
            }
            for (let k = 1; k < m.trail; k++) {
              const u = u1 - k * 0.0052 * (0.6 + uu); if (u < 0) break;
              const f = 1 - k / m.trail, hsh = Math.sin((k + 1) * 12.9898 + m.seed * 78.233) * 43758.5453, r1 = hsh - Math.floor(hsh), hs2 = Math.sin((k + 1) * 39.346 + m.seed * 11.135) * 24634.6345, r2 = hs2 - Math.floor(hs2);
              const p = at(u), j = k * 0.0020, col = W(k < 10 ? 0.6 : 0.12 * f, (k < 10 ? 5.5 : 3.4 * Math.pow(f, 1.3)) * burn);
              put(p[0] + (r1 - 0.5) * j, p[1] + (r2 - 0.5) * j, p[2], col[0], col[1], col[2], m.size * (0.9 + 1.9 * f) * (0.6 + 0.5 * r1));
            }
          }
          const h1 = (x) => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
          for (const bz of FX.bursts) {
            const p = tw(bz.pos), c = bz.col, sz = Math.sqrt(bz.s) * (bz.size || 1), age = bz.age;
            if (age < 0.32) {
              const q = 1 - age / 0.32;
              put(p[0], p[1], p[2] + 0.2, (c[0] * 0.5 + 0.5) * 9 * q * q, (c[1] * 0.5 + 0.5) * 9 * q * q, (c[2] * 0.5 + 0.5) * 9 * q * q, sz * (7 + 30 * (1 - q)));          // the flash, opening
              put(p[0], p[1], p[2] + 0.2, 22 * q * q * q, 21 * q * q * q, 20 * q * q * q, sz * 5);                                                                     // its white core
            }
            if (!bz.blast) continue;
            // a gift lands as an explosion: sparks thrown out fast (they slow, fall and cool from white through the
            // colour of the gift to crimson, each with a short streak), and embers that drift up and wink out
            const B = bz.blast, nS = Math.min(110, Math.round(40 * B)), nE = Math.min(40, Math.round(11 * B));
            for (let j = 0; j < nS; j++) {
              const r1 = h1(bz.seed * 91 + j), r2 = h1(bz.seed * 57 + j * 1.7 + 3), r3 = h1(bz.seed * 33 + j * 2.3 + 7), r4 = h1(bz.seed * 19 + j * 3.1 + 11);
              const life = 0.40 + 0.65 * r4; if (age > life) continue;
              const th = r1 * Math.PI * 2, up = 0.25 + 0.75 * r2, dx = Math.cos(th) * Math.sqrt(1 - up * up * 0.5), dy = Math.sin(th) * Math.sqrt(1 - up * up * 0.5) + 0.25, dz = up * 0.9;
              const v = (1.5 + 2.8 * r3) * Math.sqrt(B) * sc;
              for (let k = 0; k < 3; k++) {
                const a2 = age - k * 0.022; if (a2 < 0) break;
                const dist = v * (1 - Math.exp(-3.4 * a2)) / 3.4, f = 1 - a2 / life, w = Math.max(0, f * 1.6 - 0.6), cool = f < 0.4 ? f / 0.4 : 1, br = (k === 0 ? 11 : 4.5) * f * f;
                put(p[0] + dx * dist, p[1] + dy * dist - 1.5 * a2 * a2, p[2] + 0.15 + dz * dist,
                  (c[0] * (1 - w) + w) * br, (c[1] * (1 - w) + w) * br * (0.35 + 0.65 * cool), (c[2] * (1 - w) + w) * br * (0.2 + 0.8 * cool), (0.85 + 1.1 * r4) * Math.sqrt(B) * (k === 0 ? 1 : 0.7));
              }
            }
            for (let j = 0; j < nE; j++) {
              const r1 = h1(bz.seed * 71 + j * 1.3), r2 = h1(bz.seed * 43 + j * 2.9 + 5), r3 = h1(bz.seed * 29 + j * 4.1 + 9);
              const life = 0.9 + 0.8 * r3; if (age > life) continue;
              const th = r1 * Math.PI * 2, v = (0.35 + 0.7 * r2) * Math.sqrt(B) * sc, dist = v * (1 - Math.exp(-2.2 * age)) / 2.2, f = 1 - age / life;
              const tw2 = 0.6 + 0.4 * Math.sin(age * (14 + 20 * r2) + r1 * 40), br = 2.6 * f * tw2;
              put(p[0] + Math.cos(th) * dist + Math.sin(age * 3 + r1 * 9) * 0.03, p[1] + Math.sin(th) * dist * 0.7 + 0.42 * age, p[2] + 0.2 + r3 * 0.3,
                (c[0] * 0.5 + 0.5) * br, (c[1] * 0.5 + 0.12) * br, (c[2] * 0.5 + 0.06) * br, 0.75 + 0.5 * r3);
            }
          }
          for (let i = 0; i < 6; i++) { const ta = FX.taps[i * 4 + 3]; if (ta < 0.3) { const p = tw([FX.taps[i * 4], FX.taps[i * 4 + 1], FX.taps[i * 4 + 2]]), q = 1 - ta / 0.3; put(p[0], p[1], p[2] + 0.15, 22 * q * q, 20 * q * q, 18 * q * q, 4.0 + 5.0 * (1 - q)); put(p[0], p[1], p[2] + 0.15, 3.2 * q, 2.9 * q, 2.5 * q, 13.0); } }
          // lock-on / build-up: a glint at the edge of the picture: a hard point of light with a thin flare through it
          for (const gz of FX.glints) {
            const e = Math.sin(Math.PI * Math.min(1, gz.k)), k2 = e * e * (0.75 + 0.25 * Math.sin(gz.k * 40)), c = gz.col;
            // the glint sits at the EDGE OF THE PICTURE wherever the face has been moved to: its place is worked back
            // through the move (hw / hh: half the picture's width / height at the glint's depth), its size is not scaled
            const gzz = 1.0, hh = Math.tan(VIEW.fov / 2) * (cam[2] - gzz), hw = hh * G.W / G.H;
            const gx = (gz.side * 1.12 * back - pox * hw) / ps, gy = VIEW.targetY + (gz.y * back - poy * hh) / ps, gsz = gz.size / ps;
            put(gx, gy, gzz, (c[0] * 0.3 + 0.7) * 16 * k2, (c[1] * 0.3 + 0.7) * 16 * k2, (c[2] * 0.3 + 0.7) * 16 * k2, gsz * 3.2);
            put(gx, gy, gzz, c[0] * 2.2 * k2, c[1] * 2.2 * k2, c[2] * 2.2 * k2, gsz * 13);
            for (let j = 1; j <= 16; j++) { const f = 1 - j / 17, br = 3.2 * f * f * k2, o2 = j * 0.028 * gsz * (0.6 + 0.4 * e); put(gx + o2, gy, gzz, c[0] * br, c[1] * br, c[2] * br, (1.5 * f + 0.5) / ps); put(gx - o2, gy, gzz, c[0] * br, c[1] * br, c[2] * br, (1.5 * f + 0.5) / ps); if (j <= 6) { put(gx, gy + o2 * 0.6, gzz, c[0] * br, c[1] * br, c[2] * br, (1.2 * f + 0.4) / ps); put(gx, gy - o2 * 0.6, gzz, c[0] * br, c[1] * br, c[2] * br, (1.2 * f + 0.4) / ps); } }
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, fxBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, fxData.subarray(0, n * 7));
          pFx.use().u('uViewProj', vp).u('uPx', G.H * 0.066 * ps); gl.bindVertexArray(fxVao); gl.disable(gl.DEPTH_TEST); gl.drawArrays(gl.POINTS, 0, n); gl.enable(gl.DEPTH_TEST);
        }
        gl.disable(gl.BLEND); gl.depthMask(true);
      }
      gl.bindVertexArray(null);
      const post = v2 ? { bloom: v2.bloom, exposure: 1.0, cool: BGI === 2 ? 1 : 0 } : look === 'chrome' ? { bloom: 0.38, exposure: 1.0 } : look === 'particles' ? { bloom: 0.40, exposure: 1.0 } : look === 'obsidian' ? { bloom: 0.42, exposure: 1.0 } : { bloom: 0.1, exposure: 1.0 };
      G.endScene({ ...post, time: S.still ? 0.37 : t, vignette: 0.55, grain: 1.5 / 255 });
    }
    return { draw, VIEW, VISUALIZERS: VIZ_NAMES.slice(), BACKGROUNDS: BG_NAMES.slice() };
  }
  root.VTMaskLooks = { create };
})(typeof globalThis !== 'undefined' ? globalThis : self);
