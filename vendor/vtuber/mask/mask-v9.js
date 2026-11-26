// V9 STYLES: high-end looks for the Mask that are SWITCHED ON TOP of what is there (V9-STYLES.md). Phase 1 has one:
//   'core'  REACTIV CORE, the signature particle face: dense gold / amber / white-hot points on black, a face with
//           DEFINITION (brow ridge, sockets, nose, cheekbones, lips, chin), white glowing irises, sparks that drift off
//           the head, three thin orbit rings that pass in front of and behind it.
// Nothing here runs, loads or compiles until a style is asked for: with the style off, mask-looks.js draws exactly
// what it drew before (tests/v9-styles.test.js holds it to that, call by call).
//
// Where the definition comes from: Blender. tools/v9/blender_bake_core.py sculpts MediaPipe's canonical face and bakes
// ambient occlusion, curvature, a key light with real shadows and the feature lines into two small PNGs in the
// canonical UV space (mask/v9/core-form.png, core-lines.png; mask/face-canonical.js has the UVs). Every tracked face
// has the same 468 points, so the bakes fit anyone: each particle looks its place up in them ONCE, when the points are
// made (where points go = density; what a point carries = how bright and how hot it is), and rides his live face from
// then on (mask-core.js's smooth mesh, through the same position texture the classic particles use).
//
//   const v9 = VTMaskV9.create(G, { base: 'mask/v9/' });
//   v9.setCore(core)                         his face mesh (again after a new resting face)
//   v9.setStyle('classic' | 'core')          false = no such style; the change is a TRANSFORM (about 1.5 s), never a cut
//   const h = v9.pre(t, dt, { palette, fx, v8u, audio, kicks, hits })     once per frame, before looks.draw
//        null = the classic look, untouched. Otherwise { palette, fx, hook }: draw with these and pass `hook` as S.v9.
//   v9.stats()                               { style, shown (0..1), ready, points }
// Needs mask-gl.js, mask-core.js (the mesh tables) and face-canonical.js.
(function (root) {
  'use strict';
  const HERE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') + 'v9/' : 'mask/v9/';
  const STYLES = ['classic', 'core'];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  // the style's own light (linear): what the classic programs (background glow, the mouth, gift effects) are tinted with
  const GOLD = { shade: [0.16, 0.035, 0.002], shade2: [0.20, 0.06, 0.005], key: [1.0, 0.80, 0.50], accent: [1.0, 0.86, 0.62] };
  // the cranium behind the face (head space: his eye distance = 1, eyes at y = 0, +z toward the camera): the same
  // ellipsoid the classic "head" option uses, so the two agree
  const SKULL = { c: [0, 0.12, -0.92], r: [1.10, 1.42, 1.26] };
  const IRIS_R = 0.170;                                    // the white iris, in eye distances (a real one is about 0.19 across)
  const EYE_RING = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]];

  const HEAD = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform mat4 uModel, uViewProj; uniform vec3 uCam; uniform float uTime, uBass, uMid, uHigh, uBeat, uLevel, uGain;
  vec3 hash3(vec3 p) { p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453123); }
  // heat -> light (linear): ember, orange, gold, white-hot. No blue anywhere: the hottest is a warm white.
  vec3 ramp(float h) {
    vec3 c = mix(vec3(0.36, 0.030, 0.002), vec3(1.0, 0.12, 0.004), smoothstep(0.0, 0.34, h));
    c = mix(c, vec3(1.0, 0.26, 0.012), smoothstep(0.30, 0.72, h));
    c = mix(c, vec3(1.0, 0.44, 0.05), smoothstep(0.74, 1.1, h));
    return mix(c, vec3(1.0, 0.76, 0.34), smoothstep(1.15, 1.6, h));
  }`;
  // ---------------------------------------------------------------- the points: face, cranium, sparks, glows
  const PT_VS = HEAD + `
  in vec3 aTri; in vec3 aBary; in vec4 aRnd; in vec3 aRest; in vec4 aTex;
  uniform sampler2D uPosTex, uNrmTex; uniform int uMode; uniform float uAsp, uPx, uForm, uShatter, uPulse, uSpark, uDrop, uMinPx;
  uniform vec2 uKick[8]; uniform vec2 uHit[4];
  uniform vec4 uImp[10]; uniform vec4 uImpT[10]; uniform vec3 uImpC[10]; uniform int uNImp; uniform vec4 uFlash;
  out vec4 vCol; out vec2 vArc;
  vec4 fetch(sampler2D t, float id) { int i = int(id + 0.5); return texelFetch(t, ivec2(i & 127, i >> 7), 0); }
  void main() {
    float t = uTime; vArc = vec2(0.0);
    if (uMode == 3) {
      // a glow: aRest = where (world), aTex = (light, size, heat, 0)
      vec4 c = uViewProj * vec4(aRest, 1.0); gl_Position = c;
      gl_PointSize = max(uPx * aTex.y / c.w, 2.0); vCol = vec4(ramp(aTex.z) * aTex.x * uGain, 0.35 + 0.65 * aTex.w); return;
    }
    vec3 c0 = vec3(0.0, -0.45, 0.2), centre = (uModel * vec4(0.0, -0.45, -0.3, 1.0)).xyz;
    // the transform: every point has its own moment to arrive
    float arrive = uForm * 1.5 - aRnd.y * 0.5, kf = smoothstep(0.0, 1.0, clamp(arrive, 0.0, 1.0)), seen = smoothstep(0.0, 0.22, arrive);
    if (uMode == 2) {
      // a spark: born on the outline of the head, thrown outward, drifting up, cooling from gold-white to ember and gone
      float ember = step(0.72, aRnd.w);                                              // most are strands of flame; some are round embers that travel further (a loose halo of dust round the head)
      float period = mix(1.1 + 1.5 * aRnd.x, 2.6 + 3.4 * aRnd.x, ember), cyc = t / period + aRnd.y, life = fract(cyc), age = life * period;
      vec3 r3 = hash3(vec3(aRnd.zw * 37.0, floor(cyc)));
      float on = step(r3.x, 0.50 + 0.50 * clamp(uSpark, 0.0, 1.0));                  // the highs open more of them
      vec3 dir = normalize(aTri + (r3 - 0.5) * 1.1);
      vec4 w = uModel * vec4(aRest, 1.0); vec3 dw = mat3(uModel) * dir;
      float sc0 = length(dw) + 1e-4, reach = mix(0.16 + 0.34 * r3.y, 0.25 + 1.1 * r3.y * r3.y, ember);
      vec3 p0 = w.xyz;
      // where it is at an age: thrown off the rim, rising, bent by a slow curling flow (flames lick, they do not fly straight)
      #define WISP(a) (p0 + dw * (reach * (1.0 - exp(-(a) * 1.6)) + min(uDrop, 1.0) * (0.25 + 0.8 * aRnd.w) * (0.35 + 0.65 * life)) + sc0 * vec3(sin(p0.y * 2.6 + t * 1.9 + aRnd.z * 20.0 + (a) * 3.0) * 0.10 * (a), (0.30 + 0.25 * r3.z) * (a) + 0.06 * (a) * (a), cos(p0.x * 2.2 + t * 1.3 + aRnd.x * 9.0) * 0.05 * (a)))
      w.xyz = WISP(age);
      vec4 clip = uViewProj * w; gl_Position = clip;
      vec4 cb = uViewProj * vec4(WISP(age - 0.06), 1.0); vec2 vel = (clip.xy / clip.w - cb.xy / cb.w) * vec2(uAsp, 1.0);
      float a = smoothstep(0.0, 0.05, life) * pow(1.0 - life, 1.7), tw = 0.65 + 0.35 * sin(t * (7.0 + 11.0 * aRnd.x) + aRnd.z * 50.0);
      float bright = a * mix(0.40 + 0.45 * r3.z, 0.9 + 4.0 * r3.z * r3.z * r3.z, ember) * (0.75 + 0.7 * uHigh + 0.35 * min(uDrop, 1.0)) * on * tw * seen;
      float base = uPx * mix(3.6 + 3.4 * r3.z, 0.75 + 1.9 * r3.z * r3.z, ember) / clip.w, size = max(base, uMinPx);
      vec3 col = ramp(mix(1.30 - 1.25 * life, 0.86 - 0.62 * life, ember) + 0.3 * uDrop) * bright * (base * base) / (size * size) * uGain;      // a flame: yellow-white at the rim, deep orange, gone
      if (ember < 0.5) vArc = vec2(1.0 + floor(r3.x * 7.99), atan(vel.y, vel.x) + 1.3);
      if (max(col.r, col.g) < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vCol = vec4(0.0); return; }
      gl_PointSize = size; vCol = vec4(col, 0.0); return;
    }
    vec3 P, N; float act = 0.0, ao = aTex.x, curv = aTex.y, form = aTex.z, line = aTex.w;
    if (uMode == 0) {
      float b0 = aBary.x, b1 = aBary.y, b2 = 1.0 - b0 - b1;
      vec4 p0 = fetch(uPosTex, aTri.x), p1 = fetch(uPosTex, aTri.y), p2 = fetch(uPosTex, aTri.z);
      P = p0.xyz * b0 + p1.xyz * b1 + p2.xyz * b2; act = p0.w * b0 + p1.w * b1 + p2.w * b2;
      N = normalize(fetch(uNrmTex, aTri.x).xyz * b0 + fetch(uNrmTex, aTri.y).xyz * b1 + fetch(uNrmTex, aTri.z).xyz * b2);
    } else { P = aRest; N = normalize(aTri); }                                        // the cranium: fixed in head space
    float ridge = max(curv - 0.5, 0.0) * 2.0, crease = max(0.5 - curv, 0.0) * 2.0;
    float crown = uMode == 0 ? aBary.z * smoothstep(0.15, 0.75, aRest.y) : 0.0;       // the top edge of the mask: no edge there, the forehead runs on into the cranium
    float hold = clamp(line * 1.25, 0.0, 1.0);                                        // the lines keep their place when the skin moves
    P += N * ((aRnd.x - 0.35) * 0.020 * (1.0 - hold));                                // a skin with a little depth, not a sheet
    // the song: the bass lifts the skin, the mids move it along the face
    vec3 fl = vec3(sin(dot(aRest, vec3(3.1, 1.7, 2.3)) + t * 0.8 + aRnd.y * 6.28), sin(dot(aRest, vec3(2.2, 3.4, 1.1)) - t * 0.7 + aRnd.z * 6.28), sin(dot(aRest, vec3(1.3, 2.6, 3.7)) + t * 0.6 + aRnd.w * 6.28));
    fl -= N * dot(fl, N);
    P += (N * (0.024 * uBass * aRnd.y) + fl * (0.003 + 0.022 * uMid)) * (1.0 - hold);
    // a drop throws the points off the face and a spring brings them home; every kick is a breath and a wave of heat
    float r = length(aRest - c0);
    vec3 rnd3 = hash3(vec3(aRnd.xy * 91.7, aRnd.w * 37.1)) - 0.5;
    vec3 dir = normalize(N * 0.9 + normalize(aRest - c0 + 1e-3) * 0.45 + rnd3 * 0.9);
    float far = pow(aRnd.z, 4.0) * 1.9 + 0.03, off = 0.0, kOff = 0.0, wave = 0.0;
    for (int i = 0; i < 4; i++) {
      float age = uHit[i].x - r * 0.02, s = uHit[i].y;
      if (age > 0.0) { float a = s * (exp(-age * 4.0) - exp(-age * 24.0)) * 1.25; off += a; P += cross(dir, vec3(0.0, 1.0, 0.0)) * (a * far * 0.4 * sin(age * 3.0 + aRnd.x * 6.28)) * (1.0 - hold); }
    }
    for (int i = 0; i < 8; i++) {
      float age = uKick[i].x, s = uKick[i].y;
      kOff += s * (exp(-age * 7.0) - exp(-age * 30.0)) * 0.045;
      float x = r - age * 4.5; wave += s * exp(-x * x * 6.0) * exp(-age * 2.6);
    }
    float move = (off * far + kOff * (0.3 + 0.7 * aRnd.z)) * (1.0 - 0.80 * hold);
    P += dir * move;
    // gifts and chat (mask-fx.js): each impact blasts the points round it off the face and lets them come back
    vec3 impCol = vec3(0.0); float impMove = 0.0;
    for (int i = 0; i < 10; i++) {
      if (i >= uNImp) break;
      float age = uImpT[i].x, sI = uImpT[i].y;
      if (sI > 0.0 && age >= 0.0 && age < 6.0) {
        vec3 dv = aRest - uImp[i].xyz; float wI = exp(-dot(dv, dv) / (uImp[i].w * uImp[i].w));
        float aI = sI * wI * (exp(-age * uImpT[i].z) - exp(-age * 22.0));
        P += normalize(normalize(dv + 1e-3) * 0.8 + N * 0.9 + rnd3 * 0.9) * aI * (0.20 + 1.7 * aRnd.z * aRnd.z) * (1.0 - 0.40 * hold); impMove += aI;
        impCol += uImpC[i] * (wI * sI * exp(-age * 5.0));
        float bl = uImpT[i].w;
        if (bl > 0.0) { float rg = (length(dv) - age * (1.9 + 0.5 * bl)) / (0.055 + 0.02 * bl); impCol += mix(uImpC[i], vec3(1.0, 0.95, 0.9), 0.55) * (exp(-rg * rg) * exp(-age * 3.0) * (0.95 + 0.30 * bl)); }
      }
    }
    P += dir * uShatter * (0.22 + 2.4 * aRnd.z * aRnd.z);
    vec4 w = uModel * vec4(P, 1.0);
    // the transform: from a wide shell of dust round the head, on a curved way, into the face
    vec3 farP = centre + normalize(hash3(aRnd.xyz * 17.3) - 0.5) * (2.0 + 2.8 * aRnd.w), fromC = w.xyz - centre;
    w.xyz = mix(farP, w.xyz, kf) + vec3(-fromC.y, fromC.x, 0.35) * (0.75 * sin(3.14159 * kf));
    vec3 Nw = normalize(mat3(uModel) * N), V = normalize(uCam - w.xyz);
    vec4 clip = uViewProj * w; gl_Position = clip;
    // the points sit a little in FRONT of the solid things behind them (the dark face, the eyeballs, the mouth): a lid or lip line is never cut by them
    vec4 near = uViewProj * vec4(w.xyz + V * 0.14, 1.0); gl_Position.z = near.z / near.w * clip.w;
    float nv = dot(Nw, V), fres = pow(1.0 - abs(nv), 2.3);
    float kd = pow(max((dot(Nw, normalize(vec3(-0.22, 0.60, 0.77))) + 0.25) / 1.25, 0.0), 1.5);       // the same key light the bake has, on his LIVE face: it turns with him
    float glint = pow(aRnd.x, 7.0);                                                   // a few points are stars
    float flying = clamp((move + impMove * 0.7 + uShatter * 0.6) * 2.2 - 0.12, 0.0, 1.0);
    // HEAT: the baked form (light x occlusion) carries the face; lines and ridges burn; creases and sockets cool
    float h;
    if (uMode == 0) h = 0.05 + 0.40 * form * (0.30 + 0.70 * ao) * (0.50 + 0.70 * kd) + 0.90 * line + 0.60 * ridge - 0.45 * crease + (0.80 * pow(fres, 1.3) + 0.55 * aBary.z) * (1.0 - crown) + 0.28 * act + 0.42 * wave + 0.07 * uBeat;
    else h = 0.14 + 0.36 * kd + 0.50 * pow(fres, 1.3) + 0.25 * wave;                             // the cranium: quiet, its edge glows
    h = clamp(h, 0.0, 1.5);
    float tw = 0.80 + 0.20 * sin(t * (1.5 + aRnd.y * 4.0) + aRnd.z * 40.0);
    float sp = step(0.94, aRnd.w) * (uHigh * 1.9 + 2.5 * uPulse) * (0.5 + 0.5 * sin(t * (9.0 + aRnd.y * 14.0) + aRnd.z * 60.0));
    float bright = (0.035 + 1.5 * pow(min(h, 1.0), 2.0) + 0.8 * max(h - 1.0, 0.0)) * (0.80 + 6.0 * glint) * tw * (0.86 + 0.42 * uBeat + 0.22 * uLevel) + sp * 0.9;
    vec3 col = ramp(h + 0.40 * glint + 0.25 * sp) * bright;
    col = mix(col, ramp(0.26) * (bright * 0.7 + 0.03), flying);                        // what flies cools to orange
    col += impCol * (2.0 + 2.0 * aRnd.x);
    float lum = dot(col, vec3(0.45, 0.35, 0.20)); col = mix(col, uFlash.rgb * (lum * 1.9 + 0.05), uFlash.a);
    col *= (1.0 + 0.5 * uPulse) * uGain * seen * mix(0.35, 1.0, kf) * (1.0 - 0.55 * clamp(crown * 2.5, 0.0, 1.0));
    col *= mix(smoothstep(-0.10, 0.12, nv), 1.0, max(flying, 1.0 - kf));               // the far side of the head is dark (unless the point is in the air)
    // TEXTURE: most points are a short curled FILAMENT (one of eight strands baked in Blender, core-strands.png), turned along a
    // slow flow over the face and flickering; the lines of the face and a share of the skin stay fine round sparks
    float curl = step(0.45, aRnd.y) * (1.0 - smoothstep(0.35, 0.7, line)) * step(0.5, kf);
    vec3 flow = vec3(sin(aRest.y * 4.0 + t * 0.30) + 0.4 * sin(aRest.x * 7.0), cos(aRest.x * 3.5 - t * 0.25) + 0.7, sin(aRest.x * 2.0 + aRest.y * 3.0 + t * 0.2)); flow -= N * dot(flow, N);
    vec4 cf = uViewProj * vec4(w.xyz + mat3(uModel) * flow * 0.06, 1.0); vec2 fd = (cf.xy / cf.w - clip.xy / clip.w) * vec2(uAsp, 1.0);
    float flick = 0.62 + 0.38 * sin(t * (5.0 + 9.0 * aRnd.z) + aRnd.w * 50.0);
    if (curl > 0.5) vArc = vec2(1.0 + mod(floor(aRnd.w * 8.0) + floor(t * 0.7 + aRnd.z * 5.0), 8.0), atan(fd.y, fd.x) + (aRnd.z - 0.5) * 1.6);
    float base = uPx * (0.62 + 0.80 * aRnd.x * aRnd.x + 1.5 * glint) * (1.0 + 0.30 * line) * (1.0 + (3.4 + 2.0 * aRnd.x) * curl) / clip.w, size = max(base, uMinPx);
    col *= mix(1.0, 0.30 * flick, curl);
    col *= (base * base) / (size * size);
    if (max(col.r, max(col.g, col.b)) < 0.012) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vCol = vec4(0.0); return; }
    gl_PointSize = size; vCol = vec4(col, 0.0);
  }`;
  const PT_FS = `#version 300 es
  precision highp float; in vec4 vCol; in vec2 vArc; out vec4 o; uniform sampler2D uStrands;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard;
    if (vArc.x > 0.5) {
      // a filament: one cell of the strand atlas, turned its own way; its core burns toward yellow-white
      float c = cos(vArc.y), sn = sin(vArc.y); vec2 p = vec2(c * q.x - sn * q.y, sn * q.x + c * q.y) * 0.5 + 0.5;
      float cell = vArc.x - 1.0, s = texture(uStrands, (vec2(mod(cell, 4.0), floor(cell / 4.0)) + clamp(p, 0.01, 0.99)) / vec2(4.0, 2.0)).r;
      s = pow(s, 1.7); o = vec4(vCol.rgb * (s * 1.5) + vec3(1.0, 0.72, 0.30) * (pow(s, 4.0) * 0.6 * max(vCol.r, 0.0)), 1.0); return;
    }
    float core = exp(-r2 * 3.5), glow = exp(-r2 * 5.0) * 0.55 + exp(-r2 * 28.0) * 1.6;      // a point; or (vCol.a) a wide soft glow with a hot heart
    vec2 aq = abs(q); float star = (exp(-aq.x * 3.4 - aq.y * 80.0) + exp(-aq.y * 3.4 - aq.x * 80.0)) * 3.2 * smoothstep(0.5, 0.9, vCol.a);      // (vCol.a near 1) a four-point star through it
    o = vec4(vCol.rgb * mix(core, (glow + star) * (1.0 - r2), step(0.1, vCol.a)), 1.0);
  }`;
  // ---------------------------------------------------------------- the orbit rings: thin ribbons, a comet running on each
  const RING_VS = HEAD + `
  in vec2 aRing; uniform vec3 uC, uU, uV; uniform float uR, uWidth, uRef; uniform vec2 uRes; out vec2 vRing;
  vec3 at(float th) { return uC + (uU * cos(th) + uV * sin(th)) * uR; }
  void main() {
    float th = aRing.x * 6.2831853; vec4 c = uViewProj * vec4(at(th), 1.0), c2 = uViewProj * vec4(at(th + 0.02), 1.0);
    vec2 d = normalize((c2.xy / c2.w - c.xy / c.w) * uRes + 1e-6), n = vec2(-d.y, d.x);
    c.xy += n * aRing.y * (uWidth * uRef / c.w) * 2.0 / uRes * c.w;
    gl_Position = c; vRing = aRing;
  }`;
  const RING_FS = HEAD + `
  in vec2 vRing; out vec4 o; uniform vec4 uComet; uniform float uLight, uSeed;
  void main() {
    float s = vRing.y, th = vRing.x;
    float prof = exp(-s * s * 40.0) * 2.6 + exp(-s * s * 4.5) * 0.42;                  // a hair-thin hot line in a soft glow
    float c1 = fract(uComet.x - th), c2 = fract(uComet.y - th), c3 = fract(uComet.z - th);
    float comet = exp(-c1 * 7.0) + 0.7 * exp(-c2 * 10.0) + 0.5 * exp(-c3 * 14.0);       // bright heads, tails fading behind them
    float bead = pow(0.5 + 0.5 * sin(th * 6.2831853 * 61.0 + uSeed * 40.0 + uTime * 0.7), 24.0) * 0.5;
    float b = 0.46 + 1.25 * comet + bead + 0.25 * uBeat;
    o = vec4(ramp(0.56 + 0.50 * min(comet, 1.2)) * (b * prof * uLight * uGain), 1.0);
  }`;
  // ---------------------------------------------------------------- the eyes: the lid opening itself, lit from inside
  const EYE_VS = HEAD + `
  in vec4 aEye; out vec3 vP; out float vIn;
  void main() { vP = aEye.xyz; vIn = aEye.w; gl_Position = uViewProj * (uModel * vec4(aEye.xyz, 1.0)); }`;
  const EYE_FS = HEAD + `
  in vec3 vP; in float vIn; out vec4 o; uniform vec3 uIris; uniform float uIrisR, uOpen;
  void main() {
    float d = length(vP.xy - uIris.xy) / uIrisR;
    float disc = 1.0 - smoothstep(0.84, 1.02, d), heart = exp(-d * d * 2.4), halo = exp(-d * d * 0.30), edge = exp(-pow((d - 0.90) / 0.10, 2.0));
    float lid = smoothstep(0.0, 0.30, vIn);                                          // the light dies toward the lids: it can never cross them
    // a white iris (a hot heart, a fine bright edge so it reads as a disc), in an opening that glows amber
    vec3 col = vec3(1.0, 0.88, 0.56) * (disc * (1.7 + 3.6 * heart)) + vec3(1.0, 0.74, 0.30) * (edge * 2.0) + vec3(1.0, 0.34, 0.02) * (0.80 * halo + 0.40);
    col = col * lid + vec3(1.0, 0.55, 0.10) * (exp(-pow(vIn / 0.075, 2.0)) * 2.6);            // the lids themselves: a glowing outline round the opening
    o = vec4(col * (uOpen * (0.92 + 0.30 * uBeat + 0.12 * uBass) * uGain), 1.0);
  }`;
  // the cranium as something solid (depth only): what is behind the head is hidden by it
  const OCC_VS = `#version 300 es
  precision highp float; in vec3 aPos; uniform mat4 uModel, uViewProj; uniform vec3 uC, uRad;
  void main() { gl_Position = uViewProj * (uModel * vec4(uC + aPos * uRad, 1.0)); }`;
  const OCC_FS = `#version 300 es
  precision highp float; out vec4 o; void main() { o = vec4(0.0, 0.0, 0.0, 1.0); }`;

  function loadPixels(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => { try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); res({ w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data }); } catch (e) { rej(e); } };
      im.onerror = () => rej(new Error('style picture missing: ' + url));
      im.src = url;
    });
  }
  /** one channel of a baked picture at (u, v), 0..1, smooth between pixels (v 0 = the first row = the top of the forehead) */
  function tex(img, u, v, ch) {
    const x = Math.min(img.w - 1.001, Math.max(0, u * img.w - 0.5)), y = Math.min(img.h - 1.001, Math.max(0, v * img.h - 0.5));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, d = img.d, o = (y0 * img.w + x0) * 4 + ch, w4 = img.w * 4;
    return ((d[o] * (1 - fx) + d[o + 4] * fx) * (1 - fy) + (d[o + w4] * (1 - fx) + d[o + w4 + 4] * fx) * fy) / 255;
  }
  /** the canonical UV of every point of the smooth mask (the rim behind the outline takes its outline point's, pushed out a little) */
  function fineUV(M, UV) {
    const cu = new Float32Array(M.nCoarse), cv = new Float32Array(M.nCoarse), n = M.loop.length;
    for (let i = 0; i < 468; i++) { cu[i] = UV[i * 2]; cv[i] = UV[i * 2 + 1]; }
    for (let k = 0; k < n; k++) {
      const v = M.loop[k], dx = cu[v] - 0.5, dy = cv[v] - 0.5, l = Math.hypot(dx, dy) || 1;
      for (const ring of [M.ringB, M.ringC]) { cu[ring + k] = cu[v] + dx / l * 0.008; cv[ring + k] = cv[v] + dy / l * 0.008; }
    }
    const out = new Float32Array(M.nFine * 2), { ptr, col, wgt } = M;
    for (let i = 0; i < M.nFine; i++) { let u = 0, v = 0; for (let p = ptr[i]; p < ptr[i + 1]; p++) { u += cu[col[p]] * wgt[p]; v += cv[col[p]] * wgt[p]; } out[i * 2] = u; out[i * 2 + 1] = v; }
    return out;
  }
  /** how many points a place gets (relative): the lines of the face most, lit ridges more than flat skin, creases least */
  function density(form, lines, u, v) {
    const light = Math.pow(tex(form, u, v, 2), 1.6), curv = tex(form, u, v, 1), line = tex(lines, u, v, 0);
    return Math.max(0.08, 0.34 + 0.50 * light * (0.4 + 0.6 * tex(form, u, v, 0)) + 1.7 * Math.pow(line, 1.4) + 0.9 * Math.max(0, curv - 0.5) - 0.5 * Math.max(0, 0.5 - curv));
  }
  const DENSITY_MAX = 0.34 + 0.50 + 1.7 + 0.45;
  const mulberry = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  /** The point sets of Reactiv Core, as plain arrays (no graphics card: Node can make and test them). */
  function buildCore(M, UV, form, lines, { face = 100000, dome = 30000, sparks = 12000, seed = 20261125 } = {}) {
    const rnd = mulberry(seed), ix = M.index, nT = ix.length / 3, R = M.rest, uv = fineUV(M, UV), rimM = M.mask.rim;
    const cum = new Float64Array(nT); let total = 0;
    for (let t = 0; t < nT; t++) {
      const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2];
      const ux = R[b * 3] - R[a * 3], uy = R[b * 3 + 1] - R[a * 3 + 1], uz = R[b * 3 + 2] - R[a * 3 + 2], vx = R[c * 3] - R[a * 3], vy = R[c * 3 + 1] - R[a * 3 + 1], vz = R[c * 3 + 2] - R[a * 3 + 2];
      total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); cum[t] = total;
    }
    const n = face + dome + sparks, tri = new Float32Array(n * 3), bary = new Float32Array(n * 3), rn = new Float32Array(n * 4), rest = new Float32Array(n * 3), tx = new Float32Array(n * 4);
    let i = 0, tries = 0;
    while (i < face && tries < face * 60) {
      tries++;
      const u0 = rnd() * total; let lo = 0, hi = nT - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u0) lo = mid + 1; else hi = mid; }
      const a = ix[lo * 3], b = ix[lo * 3 + 1], c = ix[lo * 3 + 2];
      let b0 = rnd(), b1 = rnd(); if (b0 + b1 > 1) { b0 = 1 - b0; b1 = 1 - b1; }
      const b2 = 1 - b0 - b1, u = uv[a * 2] * b0 + uv[b * 2] * b1 + uv[c * 2] * b2, v = uv[a * 2 + 1] * b0 + uv[b * 2 + 1] * b1 + uv[c * 2 + 1] * b2;
      const rim = rimM[a] * b0 + rimM[b] * b1 + rimM[c] * b2;
      if (rnd() * DENSITY_MAX * 1.6 > density(form, lines, u, v) * (1 + 0.6 * rim)) continue;
      tri.set([a, b, c], i * 3); bary.set([b0, b1, rim], i * 3); rn.set([rnd(), rnd(), rnd(), rnd()], i * 4);
      for (let k = 0; k < 3; k++) rest[i * 3 + k] = R[a * 3 + k] * b0 + R[b * 3 + k] * b1 + R[c * 3 + k] * b2;
      tx.set([tex(form, u, v, 0), tex(form, u, v, 1), Math.pow(tex(form, u, v, 2), 1.6), tex(lines, u, v, 0) * (1 - 0.6 * rim)], i * 4);
      i++;
    }
    const nFace = i;
    // the cranium: the rest of the head behind and above the face, thinning out toward the back and the neck
    const inFace = (x, y) => { const ex = x / 1.02, ey = (y + 0.42) / 1.42; return ex * ex + ey * ey < 1; };
    const C = SKULL.c, RR = SKULL.r;
    let nd = 0;
    for (let g = 0; g < dome * 8 && nd < dome; g++) {
      const th = rnd() * Math.PI * 2, ph = Math.acos(1 - 2 * rnd());
      const sx = Math.sin(ph) * Math.cos(th), sy = Math.cos(ph), sz = Math.sin(ph) * Math.sin(th), p = [C[0] + RR[0] * sx, C[1] + RR[1] * sy, C[2] + RR[2] * sz];
      if (p[2] > -0.42 && inFace(p[0], p[1]) && p[1] < 0.60) continue;                        // the face is there (above the brow line the two overlap: no seam at the hairline)
      const keep = sstep(-1.55, -0.55, p[1]) * (0.22 + 0.78 * sstep(-1.7, -0.35, p[2]));      // gone below the jaw, thinner at the back
      if (rnd() > keep) continue;
      let nx = sx / RR[0], ny = sy / RR[1], nz = sz / RR[2]; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const o = nFace + nd;
      tri.set([nx, ny, nz], o * 3); rest.set(p, o * 3); rn.set([rnd(), rnd(), rnd(), rnd()], o * 4); tx.set([1, 0.5, 0.3, 0], o * 4);
      nd++;
    }
    // sparks: born on the outline of the head (seen from the front), thrown outward
    const s0 = nFace + nd;
    for (let k = 0; k < sparks; k++) {
      const a = rnd() * Math.PI * 2, top = Math.sin(a) > 0 ? 1.50 : 1.44, o = s0 + k, wob = 0.94 + 0.08 * rnd();
      const p = [Math.cos(a) * 1.10 * wob, -0.36 + Math.sin(a) * top * wob, -0.50 + rnd() * 0.60];
      tri.set([Math.cos(a), Math.sin(a) * 0.9 + 0.25, (rnd() - 0.5) * 0.8], o * 3); rest.set(p, o * 3); rn.set([rnd(), rnd(), rnd(), rnd()], o * 4);
    }
    return { n: s0 + sparks, nFace, nDome: nd, nSparks: sparks, tri, bary, rn, rest, tx, tries };
  }

  function create(G, { base = HERE, assets: given = null } = {}) {      // (assets: the two baked pictures already as pixels { form, lines }; tests)
    const gl = G.gl, M4 = root.VTMaskGL.M4;
    const st = { want: 'classic', k: 0, need: 0, ready: false, failed: '', loading: null, core: null, set: null, ringT: [0.0, 0.31, 0.62, 0.17], drop: 0, lastT: null, iris: [null, null] };
    let assets = given, prog = null;
    const kickU = new Float32Array(16), hitU = new Float32Array(8), IMP0 = new Float32Array(40), IMPC0 = new Float32Array(30);
    const glowData = new Float32Array(20 * 7), eyeData = new Float32Array(2 * 16 * 3 * 4), mouthData = new Float32Array(20 * 3 * 3);

    function load() {
      if (st.loading) return st.loading;
      if (assets) return (st.loading = Promise.resolve());
      st.loading = Promise.all([loadPixels(base + 'core-form.png'), loadPixels(base + 'core-lines.png'), loadPixels(base + 'core-strands.png')]).then(([form, lines, strands]) => { assets = { form, lines, strands }; build(); }, (e) => { st.failed = String(e && e.message ? e.message : e); });
      return st.loading;
    }
    function programs() {
      if (prog) return prog;
      prog = { pt: G.program(PT_VS, PT_FS), ring: G.program(RING_VS, RING_FS), eye: G.program(EYE_VS, EYE_FS), occ: G.program(OCC_VS, OCC_FS) };
      // a ring: a ribbon of 2 x 257 corners (angle 0..1, side -1 / +1)
      const SEG = 256, rv = new Float32Array((SEG + 1) * 4);
      for (let i = 0; i <= SEG; i++) rv.set([i / SEG, -1, i / SEG, 1], i * 4);
      prog.ringVao = gl.createVertexArray(); gl.bindVertexArray(prog.ringVao); G.attrib(prog.ring, 'aRing', G.buffer(rv), 2); prog.ringN = (SEG + 1) * 2;
      // a ball (the cranium, depth only)
      const sv = [], si = [], S = 24, RG = 14;
      for (let j = 0; j <= RG; j++) for (let i = 0; i <= S; i++) { const a = j / RG * Math.PI, b = i / S * 2 * Math.PI; sv.push(Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)); }
      for (let j = 0; j < RG; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + S + 1; si.push(a, a + 1, b, b, a + 1, b + 1); }
      prog.occVao = gl.createVertexArray(); gl.bindVertexArray(prog.occVao); G.attrib(prog.occ, 'aPos', G.buffer(new Float32Array(sv)), 3);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(si), gl.STATIC_DRAW); prog.occN = si.length;
      // the eyes (two fans, new every frame) and the glows (a few points, new every frame)
      prog.eyeBuf = G.buffer(eyeData, true); prog.eyeVao = gl.createVertexArray(); gl.bindVertexArray(prog.eyeVao); G.attrib(prog.eye, 'aEye', prog.eyeBuf, 4);
      prog.mouthBuf = G.buffer(mouthData, true); prog.mouthVao = gl.createVertexArray(); gl.bindVertexArray(prog.mouthVao); G.attrib(prog.occ, 'aPos', prog.mouthBuf, 3);
      prog.glowBuf = G.buffer(glowData, true); prog.glowVao = gl.createVertexArray(); gl.bindVertexArray(prog.glowVao);
      G.attrib(prog.pt, 'aRest', prog.glowBuf, 3, { stride: 28, offset: 0 }); G.attrib(prog.pt, 'aTex', prog.glowBuf, 4, { stride: 28, offset: 12 });
      gl.bindVertexArray(null);
      return prog;
    }
    function build() {
      if (!assets || !st.core) return;
      const M = st.core.mesh, P = programs(), B = buildCore(M, root.VTFaceCanonical.UV, assets.form, assets.lines);
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      G.attrib(P.pt, 'aTri', G.buffer(B.tri), 3); G.attrib(P.pt, 'aBary', G.buffer(B.bary), 3); G.attrib(P.pt, 'aRnd', G.buffer(B.rn), 4); G.attrib(P.pt, 'aRest', G.buffer(B.rest), 3); G.attrib(P.pt, 'aTex', G.buffer(B.tx), 4);
      gl.bindVertexArray(null);
      const rows = Math.ceil(M.nFine / 128);
      if (!P.strands) {
        P.strands = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, P.strands);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, assets.strands.w, assets.strands.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(assets.strands.d.buffer, assets.strands.d.byteOffset, assets.strands.d.byteLength));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      st.set = { vao, nFace: B.nFace, nDome: B.nDome, nSparks: B.nSparks, n: B.n, posTex: G.dataTex(128, rows), nrmTex: G.dataTex(128, rows), posData: new Float32Array(128 * rows * 4), nrmData: new Float32Array(128 * rows * 4) };
      st.ready = true;
    }
    function setCore(core) { st.core = core; st.set = null; st.ready = false; st.iris = [null, null]; if (assets) { try { build(); } catch (e) { st.failed = String(e && e.message ? e.message : e); } } }
    function setStyle(name) { if (!STYLES.includes(name)) return false; st.want = name; if (name !== 'classic') load(); return true; }

    /** once per frame. null = nothing of V9 is on: the caller draws the classic look exactly as before. */
    function pre(t, dt, { palette, fx, v8u, audio, hits }) {
      const target = st.want === 'core' && st.ready ? 1 : 0;
      if (target === 0 && st.k <= 0) { st.lastT = null; st.e = 0; return null; }
      st.k = clamp01(st.k + Math.max(-dt / 1.3, Math.min(dt / 1.7, target - st.k)));
      // what only the classic points can show (the Visualizer's formations, the boss's damage, cracks, MYTHIC): while one
      // of them is on, the face goes back to the classic points (in this style's light) and returns afterwards
      const v8need = v8u && (v8u.gone || v8u.nDmg > 0 || v8u.v8[0] > 0.02 || v8u.v8[1] > 0.02) ? 1 : 0;
      st.need = clamp01(st.need + Math.max(-dt / 1.1, Math.min(dt / 0.6, v8need - st.need)));
      const need = Math.max(sstep(0, 1, st.need), fx ? sstep(0.0, 0.35, fx.viz) : 0);
      const e = sstep(0, 1, st.k) * (1 - need), tone = sstep(0.0, 0.6, st.k);
      st.e = e;
      // the rings turn with the level of the song; a drop spins them up and throws the sparks
      let drop = 0; for (const h of hits || []) if (h[0] >= 0 && h[0] < 6) drop += h[1] * Math.exp(-h[0] * 1.3);
      st.drop = Math.min(1.5, drop);
      const w = 0.55 + 0.9 * audio.level + 0.4 * audio.bass + 3.2 * st.drop;
      [0.115, 0.085, 0.150, 0.100].forEach((sp, i) => { st.ringT[i] = (st.ringT[i] + dt * w * sp) % 1; });
      const pal = palette ? { ...palette, shade: lerp3(palette.shade, GOLD.shade, tone), shade2: lerp3(palette.shade2, GOLD.shade2, tone), key: lerp3(palette.key, GOLD.key, tone), accent: lerp3(palette.accent, GOLD.accent, tone) } : { ...GOLD, gain: 1 };
      const bump = 4 * e * (1 - e);                                        // the classic points leave in a burst as the new ones arrive
      const fx2 = fx ? { ...fx, shatter: Math.max(fx.shatter, 0.55 * bump) } : fx;
      const hook = { fade: 1 - sstep(0.0, 0.55, e), dust: 1 - sstep(0.0, 0.5, e) > 0.02, solo: e >= 0.999, back: 1 + 0.40 * sstep(0, 1, st.k), post: { bloom: 0.55 + (0.25 - 0.55) * e }, render: (ctx) => render({ ...ctx, solo: e >= 0.999 }, e, t) };
      return { palette: pal, fx: fx2, hook };
    }

    function render(ctx, e, t) {
      const S = st.set, core = st.core; if (!S || !core || e <= 0) return;
      const P = programs(), { vp, model, cam, sc, ps, audio: A, fx: FX, palette: PAL } = ctx;
      const gain = (PAL && PAL.gain !== undefined ? PAL.gain : 1) * (FX ? 1 - 0.42 * FX.brace : 1), form = sstep(0.18, 1.0, e), M = core.mesh, nF = M.nFine;
      for (let i = 0; i < 8; i++) { const k = ctx.kicks[i] || [99, 0]; kickU[i * 2] = k[0]; kickU[i * 2 + 1] = k[1]; }
      for (let i = 0; i < 4; i++) { const k = ctx.hits[i] || [99, 0]; hitU[i * 2] = k[0]; hitU[i * 2 + 1] = k[1]; }
      const com = (p) => p.use().u('uModel', model).u('uViewProj', vp).u('uCam', cam).u('uTime', t).u('uBass', A.bass).u('uMid', A.mid).u('uHigh', A.high).u('uBeat', A.beat).u('uLevel', A.level).u('uGain', gain);
      // 1. the cranium is solid: what passes behind the head is hidden (depth only, no colour)
      gl.disable(gl.BLEND); gl.depthMask(true); gl.colorMask(false, false, false, false);
      if (form > 0.5) { P.occ.use().u('uModel', model).u('uViewProj', vp).u('uC', SKULL.c).u('uRad', [SKULL.r[0] * 0.965, SKULL.r[1] * 0.965, SKULL.r[2] * 0.965]); gl.bindVertexArray(P.occVao); gl.drawElements(gl.TRIANGLES, P.occN, gl.UNSIGNED_SHORT, 0); }
      if (ctx.solo) {
        // the mouth is shut by a sheet just behind the lips (the classic look's own mouth is not drawn while the style is fully on)
        const ring = core.mouth.ring, NR = ring.length / 3; let mx = 0, my = 0, mz = 0;
        for (let k = 0; k < NR; k++) { mx += ring[k * 3] / NR; my += ring[k * 3 + 1] / NR; mz += ring[k * 3 + 2] / NR; }
        for (let k = 0; k < NR; k++) { const k1 = (k + 1) % NR; mouthData.set([mx, my, mz - 0.03, ring[k * 3], ring[k * 3 + 1], ring[k * 3 + 2] - 0.012, ring[k1 * 3], ring[k1 * 3 + 1], ring[k1 * 3 + 2] - 0.012], k * 9); }
        gl.bindBuffer(gl.ARRAY_BUFFER, P.mouthBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, mouthData);
        P.occ.use().u('uModel', model).u('uViewProj', vp).u('uC', [0, 0, 0]).u('uRad', [1, 1, 1]); gl.bindVertexArray(P.mouthVao); gl.drawArrays(gl.TRIANGLES, 0, NR * 3);
      }
      gl.colorMask(true, true, true, true); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      // 2. the points
      const pd = S.posData, nd = S.nrmData, Pp = core.pos, Nn = core.nrm, act = core.act;
      for (let i = 0; i < nF; i++) { pd[i * 4] = Pp[i * 3]; pd[i * 4 + 1] = Pp[i * 3 + 1]; pd[i * 4 + 2] = Pp[i * 3 + 2]; pd[i * 4 + 3] = act[i]; nd[i * 4] = Nn[i * 3]; nd[i * 4 + 1] = Nn[i * 3 + 1]; nd[i * 4 + 2] = Nn[i * 3 + 2]; }
      S.posTex.set(pd); S.nrmTex.set(nd);
      com(P.pt); G.bindTex(0, S.posTex.tex); G.bindTex(1, S.nrmTex.tex); G.bindTex(2, P.strands);
      P.pt.ui('uPosTex', 0).ui('uNrmTex', 1).ui('uStrands', 2).u('uAsp', G.W / G.H).u('uPx', G.H * 0.0225 * ps).u('uMinPx', 1.35).u('uForm', form).u('uShatter', FX ? FX.shatter : 0).u('uPulse', FX ? FX.pulse : 0).u('uSpark', 0.25 + 1.1 * A.high + 0.5 * st.drop).u('uDrop', st.drop)
        .uv('uKick', 2, kickU).uv('uHit', 2, hitU).ui('uNImp', FX ? FX.nImp : 0).uv('uImp', 4, FX ? FX.imp : IMP0).uv('uImpT', 4, FX ? FX.impT : IMP0).uv('uImpC', 3, FX ? FX.impC : IMPC0).u('uFlash', FX ? FX.flash : [0, 0, 0, 0]);
      gl.bindVertexArray(S.vao);
      P.pt.ui('uMode', 1); gl.drawArrays(gl.POINTS, S.nFace, S.nDome);
      P.pt.ui('uMode', 0); gl.drawArrays(gl.POINTS, 0, S.nFace);
      P.pt.ui('uMode', 2).u('uPx', G.H * 0.026 * ps); gl.drawArrays(gl.POINTS, S.nFace + S.nDome, S.nSparks);
      // 3. the rings: three orbits round the middle of the head, each tilted its own way, each with comets running on it
      const mw = (p) => [model[0] * p[0] + model[4] * p[1] + model[8] * p[2] + model[12], model[1] * p[0] + model[5] * p[1] + model[9] * p[2] + model[13], model[2] * p[0] + model[6] * p[1] + model[10] * p[2] + model[14]];
      const ringK = sstep(0.45, 1.0, e);
      let ng = 0;
      const glow = (p, light, size, heat, star = 0) => { if (ng >= 20) return; glowData.set([p[0], p[1], p[2], light, size, heat, star], ng * 7); ng++; };
      if (ringK > 0) {
        com(P.ring).u('uRes', [G.W, G.H]).u('uRef', cam[2]).u('uWidth', G.H * 0.0040 * ps);
        gl.bindVertexArray(P.ringVao);
        const RINGS = [[1.50, 1.30, 0.30, 0.21, 0.25], [1.58, -1.36, -0.34, 0.57, -1.02], [1.66, 1.05, 2.95, 0.93, -0.35], [1.62, -1.22, 0.10, 0.39, 0.05]];      // radius, tilt from the picture plane, turn of that tilt, seed, the middle's height on the head
        RINGS.forEach(([R0, tilt, turn, seed, cy0], i) => {
          const tl = tilt + 0.07 * Math.sin(t * 0.21 + i * 2.1), tn = turn + 0.10 * Math.sin(t * 0.13 + i * 1.3), C = mw([0, cy0, -0.50]);
          P.ring.u('uC', C);
          // a circle in the plane spanned by U (in the picture plane, turned by tn) and V (leaning out of it by tl)
          const U = [Math.cos(tn), Math.sin(tn), 0], Wv = [-Math.sin(tn), Math.cos(tn), 0], V = [Wv[0] * Math.cos(tl), Wv[1] * Math.cos(tl), Math.sin(tl)];
          const R = R0 * sc * (1 + 0.035 * A.bass + 0.05 * st.drop) * (0.6 + 0.4 * ringK), ph = st.ringT[i];
          P.ring.u('uU', U).u('uV', V).u('uR', R).u('uComet', [ph, (ph + 0.37) % 1, (ph + 0.71) % 1, 0]).u('uLight', ringK * (1.35 + 0.4 * st.drop)).u('uSeed', seed);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, P.ringN);
          for (const [o, l] of [[0, 1], [0.37, 0.7], [0.71, 0.55]]) { const th = ((ph + o) % 1) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th); glow([C[0] + (U[0] * cs + V[0] * sn) * R, C[1] + (U[1] * cs + V[1] * sn) * R, C[2] + (U[2] * cs + V[2] * sn) * R], 3.4 * l * ringK, 13.0, 0.80, 1); }
        });
      }
      // 4. the eyes: the opening between the lids, as it is right now (it closes with a blink), lit by a white iris
      const co = core.coarse, lit = [], halo = [];
      for (let ei = 0; ei < 2; ei++) {
        const ring = EYE_RING[ei], E = core.eyes[ei]; let cx = 0, cy = 0, cz = 0, x0 = 9, x1 = -9, y0 = 9, y1 = -9;
        for (const v of ring) { const x = co[v * 3], y = co[v * 3 + 1]; cx += x / 16; cy += y / 16; cz += co[v * 3 + 2] / 16; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const z = cz + 0.02, o = ei * 16 * 12, ak = sstep(0.13, 0.40, E.open), AX = 1.32, AY = 1 + 0.62 * ak;      // the almond: his lid line pushed out from the middle of the eye (wider, and taller while the eye is open; flat on a blink)
        const ax = (v) => cx + (co[v * 3] - cx) * AX, ay = (v) => cy + (co[v * 3 + 1] - cy) * AY;
        for (let k = 0; k < 16; k++) {
          const a = ring[k], b = ring[(k + 1) % 16];
          eyeData.set([cx, cy, z, 1, ax(a), ay(a), co[a * 3 + 2] + 0.02, 0, ax(b), ay(b), co[b * 3 + 2] + 0.02, 0], o + k * 12);
        }
        // the iris: where he looks (mask-core's eye, already steadied; with "eyes on camera" it is the lens), kept INSIDE
        // the corners and near the middle of the opening, and eased once more: an iris that trembles reads as nervous
        const rI = IRIS_R, hw = Math.max(0, (x1 - x0) / 2 - rI * 0.92), hh = 0.30 * (y1 - y0) / 2, mx = (x0 + x1) / 2, GAZE = 0.20;      // (0.20: a real eyeball's radius in eye distances)
        const tx2 = Math.min(mx + hw, Math.max(mx - hw, E.c[0] + E.gaze[0] * GAZE)), ty = Math.min(cy + hh, Math.max(cy - hh, E.c[1] + 0.012 + E.gaze[1] * GAZE));
        let ir = st.iris[ei];
        if (!ir) ir = st.iris[ei] = [tx2 - cx, ty - cy];
        else { const dx = tx2 - cx - ir[0], dy = ty - cy - ir[1], d = Math.hypot(dx, dy), kk = d < 0.006 ? 0.04 : 0.30; ir[0] += dx * kk; ir[1] += dy * kk; }
        const open = sstep(0.13, 0.40, E.open) * sstep(0.5, 1.0, e);
        // (eased against the middle of the opening, which itself moves: held inside the corners once more, after the easing)
        const ix = Math.min(mx + hw, Math.max(mx - hw, cx + ir[0])); ir[0] = ix - cx;
        lit.push({ x: ix, y: cy + ir[1], z, x0, x1, y0, y1, r: rI, open: E.open, light: open });
      }
      st.eyeDbg = lit;
      gl.bindBuffer(gl.ARRAY_BUFFER, P.eyeBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, eyeData);
      com(P.eye); gl.bindVertexArray(P.eyeVao); gl.disable(gl.DEPTH_TEST);
      lit.forEach((L, ei) => {
        if (L.light <= 0) return;
        P.eye.u('uIris', [L.x, L.y, L.z]).u('uIrisR', L.r).u('uOpen', L.light);
        gl.drawArrays(gl.TRIANGLES, ei * 48, 48);
        halo.push([mw([L.x, L.y, L.z + 0.06]), 0.50 * L.light * (0.9 + 0.3 * A.beat)]);
      });
      gl.enable(gl.DEPTH_TEST);
      const nRingGlow = ng; for (const hl of halo) glow(hl[0], hl[1], 14.0, 0.58);      // the warm halo round each iris (a glow, not the iris: it may spill)
      // 5. the glows: the comets' heads, the halo of each eye
      if (ng > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, P.glowBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowData.subarray(0, ng * 7));
        com(P.pt).ui('uMode', 3).u('uPx', G.H * 0.066 * ps).u('uModel', M4.trs([1, 0, 0, 0, 1, 0, 0, 0, 1], 1, [0, 0, 0]));
        gl.bindVertexArray(P.glowVao); if (nRingGlow > 0) gl.drawArrays(gl.POINTS, 0, nRingGlow);
        if (ng > nRingGlow) { gl.disable(gl.DEPTH_TEST); gl.drawArrays(gl.POINTS, nRingGlow, ng - nRingGlow); gl.enable(gl.DEPTH_TEST); }
      }
      gl.bindVertexArray(null);
    }
    return { setCore, setStyle, pre, load, stats: () => ({ style: st.want, shown: st.e || 0, ready: st.ready, failed: st.failed, points: st.set ? st.set.n : 0, eyes: st.eyeDbg || null, rings: st.ringT.slice() }), STYLES: STYLES.slice() };
  }
  const api = { create, buildCore, fineUV, density, tex, STYLES: STYLES.slice(), GOLD, SKULL };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskV9 = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
