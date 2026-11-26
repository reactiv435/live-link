// V9 CABLES: the cable looks of the Mask (V9-CABLES.md). The first: 'quantum' = QUANTUM FLOW (tile 2 of his cables sheet).
//   a head of black obsidian full of glitter specks, read from its rim light (round 7: its fine form is a Blender
//   normal bake, mask/v9/cables-face-normal.png); glowing almond eyes; a gold crest with a
//   gem, a ribbed tube, ear cups with light rings (Blender: tools/v9/blender_build_gear.py -> mask/v9/cables-gear.bin);
//   glowing liquid CABLES that hang from sockets on the head as ropes with weight (js/v9/cable-rig.js) and carry the
//   music (kicks run out along them, a drop lights them all and whips them) and the chat (taps and gifts run in).
// Everything here is real 3D in the Mask's own scene (a virtual camera can look at it from the side, above, below).
// The stream between his hands is the hands layer's effect 'quantum-stream' (js/v9/fx-quantum-stream.js).
//
// HOW IT IS SWITCHED: this file is loaded AFTER mask/mask-v9.js and takes its place (window.VTMaskV9) with one more
// style in the list. Reactiv Core and the classic Mask go through to mask-v9.js untouched: with this look off, the Mask
// makes exactly the graphics calls it made before (tests/v9-cables.test.js). No old file is changed for it.
//   mask.setStyle('quantum')      the change is a TRANSFORM: the gear materialises, the cables GROW out of their sockets
//   VTMaskCables.charge(0..1)     how alive the look is: 0 = dormant (dark, eyes shut off, cables dim), 1 = alive
//                                 (for a countdown: taps run IN along the cables and fill it up; see the notes)
//   VTMaskCables.hype(rank)       -1..5: the hype rank warms it (more cables lit, a brighter gem)
//   VTMaskCables.LOOKS            the palettes: a new cable look = one entry here + its between-the-hands effect
//   VTMaskCables.wake(o | null)   COUNTDOWN 2.0 (js/v9-countdown.js): its numbers for the cables, the eyes and the light
//                                 that fills the head (js/v9/cable-wake.js). null (the default) = exactly as without it.
(function (root) {
  'use strict';
  const Base = root.VTMaskV9, Rig = root.VTCableRig;
  if (!Base || !Rig) return;                             // without mask-v9.js or the rig there is nothing to add to
  const HERE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/js\/v9\/[^/]*$/, 'mask/v9/') : 'mask/v9/';
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  // A LOOK = its colours (linear light). a / b = the two cable colours (a to the picture's left), eye = the eyes' glow,
  // gem, ring = the ear cups' light, metal = the crest, tone = what the classic programs (background glow, gift effects) are tinted with.
  const LOOKS = {
    quantum: {
      label: 'Quantum Flow', effect: 'quantum-stream',
      a: [0.36, 0.09, 1.65], b: [1.75, 0.95, 0.10], eye: [0.62, 0.22, 1.70], eyeCore: [1.0, 0.92, 1.0], gem: [0.66, 0.20, 1.70], ring: [1.10, 0.25, 1.50],
      metal: [1.0, 0.70, 0.22], speck: [1.0, 0.86, 0.60],
      tone: { shade: [0.0006, 0.0002, 0.0016], shade2: [0.0010, 0.0003, 0.0022], key: [0.80, 0.62, 1.0], accent: [1.0, 0.80, 0.45] },
    },
  };
  const SKULL = Rig.SKULL;
  const EYE_RING = [[33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]];
  const SEG = 56, SIDES = 8;
  const TAP_EMPH = 3.4;      // countdown 2.0: how much louder a pulse running IN is with a wake (1 without)
  let CHARGE = 1, HYPE = null, FLARES = 0, WAKE = null;
  const GOLDEN = [1.75, 0.95, 0.10];

  const HEAD = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform mat4 uModel, uViewProj; uniform vec3 uCam, uColA, uColB; uniform float uTime, uBass, uHigh, uBeat, uLevel, uGain, uForm, uCharge, uSurge, uFlowT;
  uniform vec4 uHype;                                    // the hype rank: x = heat (HEATING UP ..), y = fire (ON FIRE, WILDFIRE), z = gold (LEGENDARY), w = cosmic (MYTHIC)
  uniform float uDim;                                    // countdown 2.0: how lit the Mask itself is (1 without a wake)
  float wakeK() { return uDim * smoothstep(0.40, 0.85, uDim); }      // glints, threads: none while it sleeps (1 without a wake)
  float hash1(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
  vec3 hash3(vec3 p) { p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453123); }`;
  // ---------------------------------------------------------------- what is solid: the obsidian head, the gear, the bust
  const SOLID_VS = HEAD + `
  in vec3 aPos, aNrm; in vec2 aUv, aMat; out vec3 vW, vN, vL; out vec2 vUv, vMat;
  void main() { vec4 w = uModel * vec4(aPos, 1.0); vW = w.xyz; vL = aPos; vN = mat3(uModel) * aNrm; vUv = aUv; vMat = aMat; gl_Position = uViewProj * w; }`;
  const SOLID_FS = HEAD + `
  in vec3 vW, vN, vL; in vec2 vUv, vMat; out vec4 o;
  uniform int uKind; uniform sampler2D uFormTex, uLineTex, uNormTex; uniform vec3 uGem, uRingC, uMetal; uniform float uGemK, uUnder, uDetail;
  // the room the head is in (it is only ever seen in what it mirrors): the look's first colour from the picture's left,
  // its second from the right, a cool strip above, the stream's glow from below
  vec3 env(vec3 r, float sharp) {
    float l = pow(max(dot(r, normalize(vec3(-0.86, 0.22, 0.30))), 0.0), 5.0 * sharp), rt = pow(max(dot(r, normalize(vec3(0.86, 0.26, 0.30))), 0.0), 5.0 * sharp);
    float top = pow(max(dot(r, normalize(vec3(0.05, 0.92, 0.40))), 0.0), 12.0 * sharp), un = pow(max(dot(r, normalize(vec3(0.0, -0.78, 0.62))), 0.0), 3.0);
    return uColA * (l * 1.7) + uColB * (rt * 1.5) + vec3(0.80, 0.82, 1.0) * (top * 0.8) + mix(uColA, uColB, 0.4) * (un * uUnder);
  }
  void main() {
    // the transform: it materialises grain by grain
    if (uForm < 0.999) { float q = hash1(floor(vL * 38.0) + 3.0); if (q > uForm * 1.15 - 0.10) discard; }
    vec3 N = normalize(vN), V = normalize(uCam - vW); if (dot(N, V) < 0.0 && uKind != 2) N = -N;
    if (uKind == 0) {
      // the face's fine form: the Blender sculpt's DETAIL NORMALS (tools/v9/blender_bake_core.py ... normal -> cables-face-normal.png,
      // canonical UV space: how the sculpt turns the surface away from the smooth face), so brow, cheekbones, nose and
      // lips catch the edge light as sculpted while his live face stays what moves
      vec3 dn = (texture(uNormTex, vUv).rgb * 2.0 - 1.0) / 1.5;
      N = normalize(N + mat3(uModel) * dn * (uDetail / max(length(uModel[0].xyz), 1e-5)));
    }
    float nv = clamp(dot(N, V), 0.0, 1.0), fr = pow(1.0 - nv, 5.0); vec3 R = reflect(-V, N);
    float side = smoothstep(-0.5, 0.5, N.x);                                  // which rim light this part of the surface sees
    vec3 rimC = mix(uColA, uColB, side), col;
    int mat = uKind == 2 ? int(vMat.x + 0.5) : -1; float ao = uKind == 2 ? vMat.y : 1.0;
    float live = 0.25 + 0.75 * uCharge;
    if (uKind == 3) {
      // inside the mouth: dark, a glow of the look's colour deep in it, specks on its walls
      float gm = vUv.x, hm = hash1(floor(vL * 70.0)), twm = pow(0.5 + 0.5 * sin(hm * 40.0 + uTime * 1.3), 6.0);
      vec3 cmo = uColA * (0.002 + 0.060 * gm * gm * gm) * (0.55 + 0.5 * uBeat + 0.4 * uBass) * uCharge + vec3(1.0, 0.9, 0.8) * step(0.955, hm) * twm * 0.10 * (0.15 + gm) * live;
      o = vec4(cmo * uGain, 1.0); return;
    }
    if (mat == 0 || mat == 1) {
      // metal: it shows the room. Gold (the crest, the collars, the ferrules) / the darker ribbed pipes
      vec3 f0 = mat == 0 ? uMetal : uMetal * vec3(0.42, 0.44, 0.50);
      float sky = mix(0.05, 0.50, smoothstep(-0.25, 0.75, R.y)) + 0.35 * pow(max(R.z, 0.0), 3.0), band = 0.55 + 0.45 * sin(R.y * 9.0 + R.x * 4.0);
      col = f0 * (sky * band * 0.16 + 0.006) + f0 * env(R, 0.6) * 1.5 + vec3(1.0, 0.95, 0.85) * (pow(max(dot(R, normalize(vec3(-0.3, 0.6, 0.75))), 0.0), 40.0) * 3.0 + pow(max(dot(R, normalize(vec3(0.5, 0.3, 0.8))), 0.0), 60.0) * 2.0);
      col = mix(col, vec3(1.0), fr * 0.5) * (0.25 + 0.75 * ao) * (mat == 0 ? 0.72 : 0.55);
      col += f0 * rimC * pow(1.0 - nv, 2.5) * 0.35;
      col *= 1.0 + 0.9 * uHype.z;                                               // LEGENDARY: the gold takes over
    } else if (mat == 2) {
      // the gem: lit from inside, its facets glint
      float facet = 0.45 + 0.9 * pow(nv, 2.0) + 1.3 * pow(max(dot(R, normalize(vec3(-0.2, 0.5, 0.85))), 0.0), 24.0);
      col = mix(uGem, vec3(1.7, 0.95, 0.30), 0.8 * uHype.z) * facet * (0.75 + 0.55 * uBeat + 0.35 * uBass + 2.6 * uGemK + 1.3 * uHype.x) * live + vec3(1.0, 0.92, 1.0) * (pow(nv, 9.0) * (0.55 + 2.2 * uGemK) * live) + env(R, 1.0) * 0.25;
    } else if (mat == 3) {
      // the light ring of an ear cup: DARK glass with a thin neon line where it turns away (it was a flat pink band)
      float rimE = pow(1.0 - nv, 2.2);
      col = uRingC * (0.05 + 3.4 * rimE * rimE + 0.9 * pow(max(dot(R, normalize(vec3(0.0, 0.5, 0.86))), 0.0), 30.0)) * (1.0 + 0.9 * uBeat + 0.5 * uBass + 2.6 * uSurge) * live;
    } else {
      // obsidian: black glass. Nothing of it is seen but what it mirrors and the light on its edge.
      float gloss = mat == 4 ? 0.50 : uKind == 0 ? 0.045 : uKind == 1 ? 0.07 : 0.55, f = 0.035 + 0.965 * fr, form = 1.0, line = 0.0, ridge = 0.0, lightB = 0.5;
      if (uKind == 0) { vec3 fm = texture(uFormTex, vUv).rgb; form = 0.30 + 0.70 * fm.r; ridge = max(fm.g - 0.5, 0.0) * 2.0; lightB = fm.b; line = texture(uLineTex, vUv).r; }
      f = 0.016 + 0.984 * fr;
      col = env(R, 2.6) * f * gloss * form;
      col += rimC * pow(1.0 - nv, 5.4) * (0.13 + 0.18 * ridge) * form * (mat == 4 ? 0.5 : 1.0);         // the rim light: the head is a silhouette lit from its edges
      if (uKind == 0) {
        // thin highlights where the sculpted form turns into a light: the brow ridge, the nose, the cheekbones, the lips
        float ka = pow(max(dot(R, normalize(vec3(-0.70, 0.28, 0.66))), 0.0), 46.0), kb = pow(max(dot(R, normalize(vec3(0.70, 0.30, 0.66))), 0.0), 46.0), kt = pow(max(dot(R, normalize(vec3(0.0, 0.72, 0.70))), 0.0), 70.0);
        col += (mix(uColA, vec3(1.0), 0.35) * ka * 0.20 + mix(uColB, vec3(1.0), 0.35) * kb * 0.18 + vec3(0.85, 0.88, 1.0) * kt * 0.12) * form;
        col += mix(uColA, uColB, 0.35) * pow(max(dot(R, normalize(vec3(0.0, -0.80, 0.60))), 0.0), 9.0) * 0.012 * uUnder * form;      // the stream under the chin: jaw, lips, the underside of the nose
      }
      col += env(N, 0.35) * (0.0015 + 0.004 * ridge) * form;                    // (almost nothing lies on the planes: it is black)
      col += mix(uColA, vec3(0.8, 0.7, 1.0), 0.4) * line * 0.016;               // lids, lips, the nose's contour: a breath of light
      col += uColB * pow(1.0 - nv, 2.2) * 0.55 * uHype.z * form;                 // LEGENDARY: the edge of the face is lit in gold
      if (uHype.w > 0.01 && (uKind == 0 || uKind == 1)) {
        // MYTHIC: a galaxy inside the face (two arms that turn slowly, a bright heart between the brows, stars)
        vec2 gp = vL.xy * vec2(1.0, 0.82) + vec2(0.0, 0.28); float rr = length(gp), an = atan(gp.y, gp.x);
        float arm = pow(0.5 + 0.5 * sin(an * 2.0 - log(rr + 0.08) * 5.0 + uTime * 0.30), 3.0) * exp(-rr * 1.05), sh = hash1(floor(vL * 52.0));
        vec3 gc = mix(vec3(0.22, 0.10, 0.95), vec3(1.0, 0.36, 0.85), arm) * (arm + 0.30 * exp(-rr * rr * 4.0)) * 0.70 + vec3(1.0, 0.9, 0.7) * exp(-rr * rr * 26.0) * 0.9;
        gc += vec3(1.0) * step(0.972, sh) * pow(0.5 + 0.5 * sin(sh * 50.0 + uTime * 2.0), 4.0) * 0.9;
        col += gc * uHype.w * (0.45 + 0.55 * nv);
      }
      if (mat == 5 || uKind == 1) {
        // specks in the glass itself (the bust and the far head; the face has its own points)
        vec3 cell = floor(vL * 46.0); float h = hash1(cell);
        float tw = pow(0.5 + 0.5 * sin(dot(N, V) * 31.0 + h * 40.0 + uTime * 0.7), 8.0);
        col += vec3(1.0, 0.9, 0.75) * step(0.985, h) * tw * 0.14 * (uKind == 1 ? 0.0 : 1.0);
      }
      if (mat == 5) col *= smoothstep(-4.4, -2.0, vL.y) * 0.42;                   // the shoulders sink into the dark
      col *= 0.65 + 0.35 * live;
    }
    o = vec4(col * uGain, 1.0);
  }`;
  // ---------------------------------------------------------------- the glitter: specks on the face and the far head
  const PT_VS = HEAD + `
  in vec3 aTri; in vec3 aBary; in vec4 aRnd; in vec3 aRest; in vec4 aTex;
  uniform sampler2D uPosTex, uNrmTex; uniform int uMode; uniform float uPx, uMinPx; uniform vec2 uKick[8]; uniform vec3 uSpeck;
  uniform vec4 uImp[10]; uniform vec4 uImpT[10]; uniform vec3 uImpC[10]; uniform int uNImp; uniform vec4 uFlash;
  out vec4 vCol;
  vec4 fetch(sampler2D t, float id) { int i = int(id + 0.5); return texelFetch(t, ivec2(i & 127, i >> 7), 0); }
  void main() {
    vec3 P, N; float ao = aTex.x, form = aTex.z, line = aTex.w;
    if (uMode == 0) {
      float b0 = aBary.x, b1 = aBary.y, b2 = 1.0 - b0 - b1;
      P = fetch(uPosTex, aTri.x).xyz * b0 + fetch(uPosTex, aTri.y).xyz * b1 + fetch(uPosTex, aTri.z).xyz * b2;
      N = normalize(fetch(uNrmTex, aTri.x).xyz * b0 + fetch(uNrmTex, aTri.y).xyz * b1 + fetch(uNrmTex, aTri.z).xyz * b2);
    } else { P = aRest; N = normalize(aTri); }
    P += N * 0.012;
    vec4 w = uModel * vec4(P, 1.0);
    // the transform: the specks fly in from a shell of dust round the head
    float arrive = uForm * 1.5 - aRnd.y * 0.5, kf = smoothstep(0.0, 1.0, clamp(arrive, 0.0, 1.0)), seen = smoothstep(0.0, 0.22, arrive);
    vec3 centre = (uModel * vec4(0.0, -0.45, -0.3, 1.0)).xyz, farP = centre + normalize(hash3(aRnd.xyz * 17.3) - 0.5) * (2.0 + 2.8 * aRnd.w), fromC = w.xyz - centre;
    w.xyz = mix(farP, w.xyz, kf) + vec3(-fromC.y, fromC.x, 0.35) * (0.6 * sin(3.14159 * kf));
    vec3 Nw = normalize(mat3(uModel) * N), V = normalize(uCam - w.xyz);
    vec4 clip = uViewProj * w; gl_Position = clip;
    vec4 near = uViewProj * vec4(w.xyz + V * 0.10, 1.0); gl_Position.z = near.z / near.w * clip.w;
    float nv = dot(Nw, V), fres = pow(1.0 - abs(nv), 2.2);
    // a speck is a tiny mirror: it flashes when its own facet catches the light, and that changes as the head moves
    vec3 facet = normalize(Nw + (aRnd.xyz - 0.5) * 1.5);
    float tw = pow(0.5 + 0.5 * sin(dot(facet, V) * (20.0 + 34.0 * aRnd.w) + aRnd.z * 40.0 + uTime * (0.5 + 1.1 * aRnd.y)), 7.0);
    float r = length(aRest - vec3(0.0, -0.45, 0.2)), wave = 0.0;
    for (int i = 0; i < 8; i++) { float age = uKick[i].x, x = r - age * 4.5; wave += uKick[i].y * exp(-x * x * 6.0) * exp(-age * 2.6); }
    float star = pow(aRnd.x, 9.0), big = step(0.9962, aRnd.w) * step(float(uMode), 0.5), huge = step(0.99935, aRnd.w) * step(float(uMode), 0.5);      // a few large glints among the specks, a handful of them stars
    big *= wakeK(); huge *= wakeK();                                              // (countdown 2.0: no glints while it sleeps)
    float b = (0.085 + 2.10 * tw) * (0.20 + 0.85 * form * (0.35 + 0.65 * ao) + 0.75 * line + 0.30 * fres) * (0.50 + 8.0 * star) * (1.0 + 2.2 * wave + 0.35 * uBeat + 0.9 * uHigh * step(0.8, aRnd.w)) * (1.0 + 2.2 * big + 2.6 * huge);
    if (uMode == 1) b *= 0.55; else b *= 1.0 - 0.65 * aBary.z;                 // (no bright line where the face mesh ends: it is one head)
    vec3 tint = aRnd.z > 0.955 ? mix(uColA, vec3(1.0), 0.35) * 1.4 : mix(vec3(1.0, 0.97, 0.94), uSpeck, step(0.55, aRnd.y));
    tint = mix(tint, uColB * 0.9 + 0.25, 0.6 * uHype.z);
    vec3 col = tint * b * (0.15 + 0.85 * uCharge) * (1.0 + 0.9 * uHype.x + 0.6 * uHype.w);      // HEATING UP: the specks brighten
    for (int i = 0; i < 10; i++) {
      if (i >= uNImp) break;
      float age = uImpT[i].x, sI = uImpT[i].y;
      if (sI > 0.0 && age >= 0.0 && age < 6.0) { vec3 dv = aRest - uImp[i].xyz; float wI = exp(-dot(dv, dv) / (uImp[i].w * uImp[i].w)); col += uImpC[i] * (wI * sI * exp(-age * 4.0)) * (0.6 + 1.6 * aRnd.x); float rg = (length(dv) - age * 2.2) / 0.07; col += uImpC[i] * exp(-rg * rg) * exp(-age * 3.0) * step(0.001, uImpT[i].w); }
    }
    float lum = dot(col, vec3(0.4, 0.4, 0.2)); col = mix(col, uFlash.rgb * (lum * 1.9 + 0.03), uFlash.a);
    col *= uGain * seen * smoothstep(-0.06, 0.14, nv);
    float base = uPx * (0.40 + 0.75 * aRnd.x * aRnd.x + 1.6 * star + 3.6 * big + 7.5 * huge) / clip.w, size = max(base, uMinPx);
    col *= (base * base) / (size * size);
    if (max(col.r, max(col.g, col.b)) < 0.010) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vCol = vec4(0.0); return; }
    gl_PointSize = size; vCol = vec4(col, big + huge);
  }`;
  const PT_FS = `#version 300 es
  precision highp float; in vec4 vCol; out vec4 o;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard; float a = exp(-r2 * 5.5) * 1.25;      // crisp
    if (vCol.a > 1.5) { vec2 aq = abs(q); a = exp(-r2 * 90.0) * 2.2 + (exp(-aq.x * 3.0 - aq.y * 110.0) + exp(-aq.y * 3.0 - aq.x * 110.0)) * 1.5 * (1.0 - r2) + 0.35 * exp(-abs(aq.x - aq.y) * 80.0 - r2 * 9.0); }      // a star: long thin rays (and short ones between)
    else if (vCol.a > 0.5) { vec2 aq = abs(q); a = exp(-r2 * 30.0) * 1.6 + (exp(-aq.x * 4.0 - aq.y * 60.0) + exp(-aq.y * 4.0 - aq.x * 60.0)) * 1.3 * (1.0 - r2); }      // a glint: a hot point with four rays
    o = vec4(vCol.rgb * a, 1.0);
  }`;
  // ---------------------------------------------------------------- the cables: tubes round the rig's ropes
  const CAB_VS = HEAD + `
  in vec3 aCab; uniform sampler2D uRig; uniform float uRad, uSc; uniform int uNodes;
  out vec3 vW, vN; out float vS; out vec4 vPar; out float vPk; out vec2 vA;
  vec3 node(int c, int i) { return texelFetch(uRig, ivec2(clamp(i, 0, uNodes - 1), c), 0).xyz; }
  vec3 curve(int c, float s) {
    float f = clamp(s, 0.0, 1.0) * float(uNodes - 1); int i = min(int(floor(f)), uNodes - 2); float k = f - float(i);
    vec3 p0 = node(c, i - 1), p1 = node(c, i), p2 = node(c, i + 1), p3 = node(c, i + 2);
    return 0.5 * ((2.0 * p1) + (-p0 + p2) * k + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * k * k + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * k * k * k);
  }
  void main() {
    int c = int(aCab.x + 0.5); float s = aCab.y, a = aCab.z * 6.2831853;
    vec3 p = curve(c, s), T = normalize(curve(c, s + 0.012) - curve(c, s - 0.012) + 1e-6), V = normalize(uCam - p);
    vec3 A = normalize(cross(T, V) + 1e-5), B = cross(A, T);
    vec4 par = texelFetch(uRig, ivec2(uNodes, c), 0);                  // hue, glow, radius, surge
    float pk = 0.0;
    for (int j = 1; j <= 3; j++) { vec4 q = texelFetch(uRig, ivec2(uNodes + j, c), 0); float d = (s - q.x) / (0.045 + 0.02 * q.z); pk += q.y * (exp(-d * d) * (1.0 + 0.5 * q.z) + (q.w > 0.0 && s > q.x ? 0.6 * exp(-(s - q.x) / q.w) : 0.0)); }
    float taper = mix(1.0, 0.62, s) * sqrt(clamp((1.0 - s) / 0.035, 0.0, 1.0)) * (0.8 + 0.2 * smoothstep(0.0, 0.04, s));
    float lump = 1.0 + 0.30 * sin(s * 41.0 + par.x * 7.0 + float(c) * 1.7) * sin(s * 13.0 + float(c) * 0.9) + 0.10 * sin(s * 97.0 + float(c));      // a liquid cable is never even
    float r = par.z * 0.85 * taper * lump * (1.0 + 0.50 * min(pk, 1.5)) * uRad * uSc; vA = vec2(aCab.z, float(c));
    vec3 n = A * cos(a) + B * sin(a);
    vec3 w = p + n * r; vW = w; vN = n; vS = s; vPar = par; vPk = pk;
    gl_Position = uViewProj * vec4(w, 1.0);
  }`;
  const CAB_FS = HEAD + `
  in vec3 vW, vN; in float vS; in vec4 vPar; in float vPk; in vec2 vA; out vec4 o; uniform int uPass;
  void main() {
    if (vS > uForm) discard;
    float nv = clamp(dot(normalize(vN), normalize(uCam - vW)), 0.0, 1.0), hue = vPar.x, sheath = step(1.5, hue); hue -= 2.0 * sheath;
    vec3 base = mix(uColA, uColB, hue), hot = mix(base, vec3(1.0, 0.94, 0.90), 0.75), hotC = mix(base, vec3(1.0, 0.94, 0.90), 0.50);
    // the liquid inside: it runs along the cable, thicker and thinner, and it never stands still
    float run = vS * 30.0 - uFlowT, flow = 0.60 + 0.40 * sin(run + 2.5 * sin(vS * 7.0 + uTime * 0.6 + hue * 3.0));
    float glow = vPar.y * (0.2 + 0.8 * uCharge) * (1.0 + 0.9 * uHype.y), surge = vPar.w, pk = min(vPk, 2.0);
    vec3 col;
    vec3 Nn = normalize(vN), Vv = normalize(uCam - vW), Rr = reflect(-Vv, Nn);
    vec3 deep = mix(base, base * base / max(max(base.r, max(base.g, base.b)), 1e-3), 0.55);                        // the look's colour, more saturated
    if (uPass == 0) {
      // (countdown 2.0 on round 8, as it was on round 7: the tube's own light dims with uDim while the Mask sleeps, the pulses and
      // surges on it do not; the streaks and the wet glints are gone while it sleeps (wakeK). Without a wake uDim = wakeK = 1.)
      // (round 8) a GLASS TUBE FULL OF LIQUID LIGHT: a white-hot thread down its middle, the look's colour deep and
      // saturated round it, darker toward the wall, then the wall itself as a thin bright line; long specular streaks
      // from two lights; wet glints. (It was a pastel matte tube: too much light everywhere in it.)
      float mid = pow(nv, 2.6), wall = pow(1.0 - nv, 5.0);
      float thread = pow(nv, 34.0) * (0.72 + 0.28 * sin(vS * 61.0 + uTime * 3.0 + hue * 5.0)) * (0.66 + 0.34 * flow);
      col = deep * (0.22 + 1.05 * mid) * flow * glow * uDim;
      col += (hotC * thread * (2.4 * (0.30 + glow)) + vec3(1.0, 0.97, 0.95) * pow(nv, 90.0) * 1.2 * glow) * uDim;
      col += hot * (pk * (0.6 + 2.6 * mid) + surge * (0.5 + 2.2 * mid));
      col += (deep * wall * 1.10 * (0.35 + glow) + vec3(1.0, 0.95, 1.0) * pow(1.0 - nv, 14.0) * 0.16 * (0.3 + glow)) * uDim;
      float sp1 = pow(max(dot(Rr, normalize(vec3(-0.45, 0.70, 0.55))), 0.0), 48.0), sp2 = pow(max(dot(Rr, normalize(vec3(0.55, 0.45, 0.70))), 0.0), 64.0);
      col += vec3(1.0, 0.97, 1.0) * (sp1 * 1.1 + sp2 * 0.8) * (0.45 + 0.55 * glow) * wakeK();                  // the streak along the glass
      // wet: tiny glints that come and go along it (countdown 2.0: none while the Mask sleeps)
      float hs = hash1(vec3(floor(vS * 320.0), floor(vA.x * 8.0), vA.y));
      col += vec3(1.0, 0.97, 0.95) * (1.0 + 2.5 * uHype.x) * step(0.955 - 0.07 * uHype.x, hs) * pow(0.5 + 0.5 * sin(uTime * (5.0 + 11.0 * hs) + hs * 60.0), 5.0) * 2.2 * (0.4 + glow) * wakeK();
    } else {
      // the glow round it, and the ELECTRICITY that rides it: two jagged threads of lightning that wind round every
      // cable, jump and flicker (a kick and a surge make them fierce), a sheathed cable's clear tube
      float a = pow(nv, 1.5);
      col = deep * a * a * (0.085 * glow * uDim + 0.26 * pk + 0.20 * surge);
      float seg = floor(vS * 46.0), jag = (hash1(vec3(seg, vA.y, floor(uTime * 14.0))) - 0.5) * 0.20, jag2 = (hash1(vec3(seg, vA.y + 9.0, floor(uTime * 11.0))) - 0.5) * 0.26;
      float t1 = exp(-pow((fract(vS * 5.0 + vA.x + jag + uTime * 0.30 + vA.y * 0.37) - 0.5) / 0.026, 2.0)), t2 = exp(-pow((fract(-vS * 3.4 + vA.x + jag2 - uTime * 0.21 + vA.y * 0.61) - 0.5) / 0.020, 2.0));
      float fk = step(0.50, hash1(vec3(floor(vS * 3.0 + uTime * 2.2), vA.y, 1.0))), fk2 = step(0.62, hash1(vec3(floor(vS * 2.0 - uTime * 3.1), vA.y, 2.0)));
      col += mix(base, vec3(1.0), 0.72) * (t1 * fk * 0.62 + t2 * fk2 * 0.50) * (0.30 + 0.9 * glow + 1.3 * pk + 1.3 * surge) * a * wakeK();      // (countdown 2.0: no lightning while it sleeps)
      col += sheath * mix(base, vec3(1.0), 0.5) * (exp(-pow((nv - 0.42) / 0.10, 2.0)) * 0.16 * (0.4 + glow)) * uDim;      // the clear tube: a thin bright line at its edge
    }
    o = vec4(col * uGain, 1.0);
  }`;
  // ---------------------------------------------------------------- the eyes: the lid opening itself, lit from inside
  const EYE_VS = HEAD + `
  in vec4 aEye; out vec3 vP; out float vIn;
  void main() { vP = aEye.xyz; vIn = aEye.w; gl_Position = uViewProj * (uModel * vec4(aEye.xyz, 1.0)); }`;
  const EYE_FS = HEAD + `
  in vec3 vP; in float vIn; out vec4 o; uniform vec3 uIris, uEye, uEyeCore; uniform vec2 uIrisR; uniform float uOpen;
  void main() {
    vec2 q = (vP.xy - uIris.xy) / uIrisR; float d2 = dot(q, q);
    float lid = smoothstep(0.0, 0.34, vIn);                                          // the light dies toward the lids: it never crosses them
    // a white-hot heart where he looks, the look's colour filling the opening, the lids a glowing outline
    vec3 col = uEyeCore * (2.6 * exp(-d2 * 1.5) + 0.9 * exp(-d2 * 0.35)) + uEye * (1.5 * exp(-d2 * 0.22) + 0.75);
    col = col * lid + uEye * (exp(-pow(vIn / 0.10, 2.0)) * 1.5);
    o = vec4(col * (uOpen * (0.90 + 0.32 * uBeat + 0.14 * uBass + 1.6 * uSurge) * uGain), 1.0);
  }`;
  // ---------------------------------------------------------------- glows: the eyes' bloom, the gem, the rings; the bokeh behind
  const GLOW_VS = `#version 300 es
  precision highp float; in vec4 aP; in vec4 aC; uniform mat4 uViewProj; uniform float uPx; out vec4 vC;
  void main() { vec4 c = uViewProj * vec4(aP.xyz, 1.0); gl_Position = c; gl_PointSize = clamp(uPx * aP.w / c.w, 1.0, 700.0); vC = aC; }`;
  const GLOW_FS = `#version 300 es
  precision highp float; in vec4 vC; out vec4 o;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard; float r = sqrt(r2), a;
    if (vC.a < 0.5) a = exp(-r2 * 4.0) * 0.6 + exp(-r2 * 26.0) * 1.2;                  // a glow with a hot heart
    else if (vC.a < 1.5) { vec2 aq = abs(q); a = exp(-r2 * 5.0) * 0.5 + (exp(-aq.x * 3.2 - aq.y * 70.0) + exp(-aq.y * 3.2 - aq.x * 70.0)) * 2.4 * (1.0 - r2); }      // a four-point star
    else a = (0.22 * (1.0 - smoothstep(0.80, 0.98, r)) + 0.9 * exp(-pow((r - 0.86) / 0.07, 2.0))) * (0.75 + 0.5 * q.y);      // a droplet out of focus: a disc with a bright rim
    o = vec4(vC.rgb * a, 1.0);
  }`;

  function loadPixels(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => { try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); res({ w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data }); } catch (e) { rej(e); } };
      im.onerror = () => rej(new Error('style picture missing: ' + url));
      im.src = url;
    });
  }
  /** the Blender gear as typed arrays: { meta, v16 (Int16 x 8 per point), i32 } */
  function parseGear(meta, buf) {
    const v16 = new Int16Array(buf, 0, meta.points * 8), i32 = new Uint32Array(buf.slice(meta.points * 16, meta.points * 16 + meta.indices * 4));
    return { meta, v16, i32 };
  }
  const mulberry = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  function createCables(G, { base = HERE, assets: given = null } = {}) {
    const gl = G.gl, M4 = root.VTMaskGL.M4;
    const st = { hy: -1, flowT: 0, flare: 0, flares: FLARES, pulseAt: 0, nDrip: 0, dripAcc: 0, litN: 0, want: 'classic', look: 'quantum', k: 0, need: 0, e: 0, ready: false, failed: '', loading: null, core: null, set: null, lastT: null, dt: 1 / 30, iris: [null, null], gemK: 0, surge: 0, taps: 0, seen: {}, hype: -1, fxNow: null, v8u: null };
    let assets = given, prog = null, rig = null, gpu = null;
    const kickU = new Float32Array(16), IMP0 = new Float32Array(40), IMPC0 = new Float32Array(30);
    const eyeData = new Float32Array(2 * 16 * 3 * 4), mouthData = new Float32Array(20 * 3 * 5), glowData = new Float32Array(360 * 8), drips = new Float32Array(200 * 8);
    const rnd = mulberry(0xcab1e5);

    function load() {
      if (assets) { if (!st.ready) build(); return st.loading || (st.loading = Promise.resolve()); }
      if (st.loading) return st.loading;
      st.loading = Promise.all([loadPixels(base + 'core-form.png'), loadPixels(base + 'core-lines.png'), loadPixels(base + 'cables-face-normal.png').catch(() => null), fetch(base + 'cables-gear.json').then((r) => { if (!r.ok) throw new Error('cables-gear.json ' + r.status); return r.json(); }), fetch(base + 'cables-gear.bin').then((r) => { if (!r.ok) throw new Error('cables-gear.bin ' + r.status); return r.arrayBuffer(); })])
        .then(([form, lines, normal, meta, buf]) => { assets = { form, lines, normal, gear: parseGear(meta, buf) }; build(); }, (e) => { st.failed = String(e && e.message ? e.message : e); });
      return st.loading;
    }
    function programs() {
      if (prog) return prog;
      prog = { solid: G.program(SOLID_VS, SOLID_FS), pt: G.program(PT_VS, PT_FS), cab: G.program(CAB_VS, CAB_FS), eye: G.program(EYE_VS, EYE_FS), glow: G.program(GLOW_VS, GLOW_FS) };
      return prog;
    }
    const pixTex = (img) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.w, img.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.d.buffer, img.d.byteOffset, img.d.byteLength)); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    const elem = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };

    /** everything that is made once (the gear, the cables' tubes, the cranium, the bokeh) */
    function buildStatic() {
      if (gpu) return gpu;
      const P = programs(), gear = assets.gear, n = gear.meta.points, gv = new Float32Array(n * 8);
      for (let i = 0; i < n; i++) { const o = i * 8; gv[o] = gear.v16[o] / gear.meta.posScale; gv[o + 1] = gear.v16[o + 1] / gear.meta.posScale; gv[o + 2] = gear.v16[o + 2] / gear.meta.posScale; gv[o + 3] = gear.v16[o + 3] / 32767; gv[o + 4] = gear.v16[o + 4] / 32767; gv[o + 5] = gear.v16[o + 5] / 32767; gv[o + 6] = gear.v16[o + 7]; gv[o + 7] = gear.v16[o + 6] / 32767; }
      const gearVao = gl.createVertexArray(); gl.bindVertexArray(gearVao);
      const gb = G.buffer(gv); G.attrib(P.solid, 'aPos', gb, 3, { stride: 32, offset: 0 }); G.attrib(P.solid, 'aNrm', gb, 3, { stride: 32, offset: 12 }); G.attrib(P.solid, 'aMat', gb, 2, { stride: 32, offset: 24 });
      elem(gear.i32);
      // the cranium (a ball in head space, a little inside the specks)
      const sv = [], si = [], S1 = 32, S2 = 20, k = 0.975;
      for (let j = 0; j <= S2; j++) for (let i = 0; i <= S1; i++) { const a = j / S2 * Math.PI, b = i / S1 * 2 * Math.PI, d = [Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)]; const nn = [d[0] / SKULL.r[0], d[1] / SKULL.r[1], d[2] / SKULL.r[2]], l = Math.hypot(nn[0], nn[1], nn[2]); sv.push(SKULL.c[0] + d[0] * SKULL.r[0] * k, SKULL.c[1] + d[1] * SKULL.r[1] * k, SKULL.c[2] + d[2] * SKULL.r[2] * k, nn[0] / l, nn[1] / l, nn[2] / l); }
      for (let j = 0; j < S2; j++) for (let i = 0; i < S1; i++) { const a = j * (S1 + 1) + i, b = a + S1 + 1; si.push(a, a + 1, b, b, a + 1, b + 1); }
      const skullVao = gl.createVertexArray(); gl.bindVertexArray(skullVao);
      const sb = G.buffer(new Float32Array(sv)); G.attrib(P.solid, 'aPos', sb, 3, { stride: 24, offset: 0 }); G.attrib(P.solid, 'aNrm', sb, 3, { stride: 24, offset: 12 }); elem(new Uint16Array(si));
      // the cables: one tube mesh, every point knows its cable, how far along it is and where round it
      const C = rig.count, cv = new Float32Array(C * (SEG + 1) * SIDES * 3), ci = new Uint32Array(C * SEG * SIDES * 6); let q = 0, w = 0;
      for (let c = 0; c < C; c++) {
        const b0 = c * (SEG + 1) * SIDES;
        for (let s = 0; s <= SEG; s++) for (let a = 0; a < SIDES; a++) { cv[q++] = c; cv[q++] = Math.pow(s / SEG, 1.0); cv[q++] = a / SIDES; }
        for (let s = 0; s < SEG; s++) for (let a = 0; a < SIDES; a++) { const a1 = (a + 1) % SIDES, i0 = b0 + s * SIDES + a, i1 = b0 + s * SIDES + a1, j0 = i0 + SIDES, j1 = i1 + SIDES; ci[w++] = i0; ci[w++] = j0; ci[w++] = i1; ci[w++] = i1; ci[w++] = j0; ci[w++] = j1; }
      }
      const cabVao = gl.createVertexArray(); gl.bindVertexArray(cabVao); G.attrib(P.cab, 'aCab', G.buffer(cv), 3); elem(ci);
      const mouthBuf = G.buffer(mouthData, true), mouthVao = gl.createVertexArray(); gl.bindVertexArray(mouthVao); G.attrib(P.solid, 'aPos', mouthBuf, 3, { stride: 20, offset: 0 }); G.attrib(P.solid, 'aUv', mouthBuf, 2, { stride: 20, offset: 12 });
      const eyeBuf = G.buffer(eyeData, true), eyeVao = gl.createVertexArray(); gl.bindVertexArray(eyeVao); G.attrib(P.eye, 'aEye', eyeBuf, 4);
      const glowBuf = G.buffer(glowData, true), glowVao = gl.createVertexArray(); gl.bindVertexArray(glowVao); G.attrib(P.glow, 'aP', glowBuf, 4, { stride: 32, offset: 0 }); G.attrib(P.glow, 'aC', glowBuf, 4, { stride: 32, offset: 16 });
      // the bokeh behind: droplets out of focus, far away, faint
      const NB = 34, bd = new Float32Array(NB * 8), look = LOOKS[st.look];
      for (let i = 0; i < NB; i++) { const c = rnd() < 0.5 ? look.a : look.b, l = 0.014 + 0.040 * rnd() * rnd(); bd.set([(rnd() - 0.5) * 9.5, -0.6 + (rnd() - 0.5) * 13, -3.5 - 5 * rnd(), 0.7 + 1.9 * rnd() * rnd(), c[0] * l, c[1] * l, c[2] * l, 2], i * 8); }
      const bokehVao = gl.createVertexArray(); gl.bindVertexArray(bokehVao); const bb = G.buffer(bd); G.attrib(P.glow, 'aP', bb, 4, { stride: 32, offset: 0 }); G.attrib(P.glow, 'aC', bb, 4, { stride: 32, offset: 16 });
      gl.bindVertexArray(null);
      gpu = { gearVao, gearN: gear.i32.length, ranges: gear.meta.ranges, skullVao, skullN: si.length, cabVao, cabN: ci.length, mouthBuf, mouthVao, eyeBuf, eyeVao, glowBuf, glowVao, bokehVao, bokehN: NB, formTex: pixTex(assets.form), lineTex: pixTex(assets.lines), normTex: pixTex(assets.normal || { w: 1, h: 1, d: new Uint8Array([128, 128, 128, 255]) }), detail: assets.normal ? 1 : 0, rigTex: G.dataTex(rig.nodes + 4, rig.count), rigData: new Float32Array((rig.nodes + 4) * rig.count * 4), aUv: P.solid.a('aUv'), aMat: P.solid.a('aMat') };
      return gpu;
    }
    /** what depends on his face mesh (again after a new resting face) */
    function build() {
      if (!assets || !st.core) return;
      try {
        if (!rig) rig = Rig.create({ cables: Rig.layout() });
        const M = st.core.mesh, P = programs(); buildStatic();
        const B = Base.buildCore(M, root.VTFaceCanonical.UV, assets.form, assets.lines, { face: 86000, dome: 20000, sparks: 0, seed: 20261126 });
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        G.attrib(P.pt, 'aTri', G.buffer(B.tri), 3); G.attrib(P.pt, 'aBary', G.buffer(B.bary), 3); G.attrib(P.pt, 'aRnd', G.buffer(B.rn), 4); G.attrib(P.pt, 'aRest', G.buffer(B.rest), 3); G.attrib(P.pt, 'aTex', G.buffer(B.tx), 4);
        // the face itself, solid: his live mesh
        const faceVao = gl.createVertexArray(); gl.bindVertexArray(faceVao);
        const bPos = G.buffer(new Float32Array(M.nFine * 3), true), bNrm = G.buffer(new Float32Array(M.nFine * 3), true);
        G.attrib(P.solid, 'aPos', bPos, 3); G.attrib(P.solid, 'aNrm', bNrm, 3); G.attrib(P.solid, 'aUv', G.buffer(Base.fineUV(M, root.VTFaceCanonical.UV)), 2);
        elem(new Uint32Array(M.index));
        gl.bindVertexArray(null);
        const rows = Math.ceil(M.nFine / 128);
        st.set = { vao, nFace: B.nFace, nDome: B.nDome, n: B.n, faceVao, faceN: M.index.length, bPos, bNrm, posTex: G.dataTex(128, rows), nrmTex: G.dataTex(128, rows), posData: new Float32Array(128 * rows * 4), nrmData: new Float32Array(128 * rows * 4) };
        st.ready = true;
      } catch (e) { st.failed = String(e && e.message ? e.message : e); }
    }
    function setCore(core) { st.core = core; st.set = null; st.ready = false; st.iris = [null, null]; if (assets && st.want !== 'classic') build(); }      // (nothing is made while the look is not asked for)
    function setStyle(name) { if (name !== 'classic' && !LOOKS[name]) return false; st.want = name; if (name !== 'classic') { st.look = name; load(); } return true; }

    /** once per frame. null = this look is not on (and not on its way out). */
    function pre(t, dt, { palette, fx, v8u }) {
      const target = st.want !== 'classic' && st.ready ? 1 : 0;
      if (target === 0 && st.k <= 0) { st.lastT = null; st.e = 0; if (root.VTCableLink) root.VTCableLink.on = 0; return null; }
      st.k = clamp01(st.k + Math.max(-dt / 1.5, Math.min(dt / 2.0, target - st.k)));
      const v8need = v8u && (v8u.gone || v8u.nDmg > 0 || v8u.v8[0] > 0.02 || v8u.v8[1] > 0.02) ? 1 : 0;
      st.need = clamp01(st.need + Math.max(-dt / 1.1, Math.min(dt / 0.6, v8need - st.need)));
      const need = Math.max(sstep(0, 1, st.need), fx ? sstep(0.0, 0.35, fx.viz) : 0);
      const e = sstep(0, 1, st.k) * (1 - need), tone = sstep(0.0, 0.6, st.k), L = LOOKS[st.look].tone;
      st.e = e; st.fxNow = fx || null; st.v8u = v8u || null;
      { const link = root.VTCableLink || (root.VTCableLink = { inbox: [] }); link.on = e * (WAKE ? st.pw || 0 : 1); link.t = t; link.look = LOOKS[st.look]; link.charge = CHARGE; }      // the stream between his hands reads this (js/v9/fx-quantum-stream.js)
      const pal = palette ? { ...palette, shade: lerp3(palette.shade, L.shade, tone), shade2: lerp3(palette.shade2, L.shade2, tone), key: lerp3(palette.key, L.key, tone), accent: lerp3(palette.accent, L.accent, tone) } : { ...L, gain: 1 };
      const bump = 4 * e * (1 - e), fx2 = fx ? { ...fx, shatter: Math.max(fx.shatter, 0.55 * bump) } : fx;
      const hook = { fade: 1 - sstep(0.0, 0.55, e), solo: e >= 0.999, back: 1 + 0.52 * sstep(0, 1, st.k), post: { bloom: 0.55 + (0.15 - 0.55) * e, cool: e > 0.02 ? 1 : 0 }, render: (ctx) => render({ ...ctx, solo: e >= 0.999 }, e, t) };
      return { palette: pal, fx: fx2, hook };
    }

    function events(t, dt, ctx) {
      // the music: every kick runs out along the cables, a drop is a surge and a whip
      // (each thing once: by the moment it happened, whatever the frame rate does)
      const fresh = (key, age) => { const at = t - age, last = st.seen[key]; if (!(age >= 0 && age < 0.25) || (last !== undefined && at <= last + 1e-3)) return false; st.seen[key] = at; return true; };
      const ks = (ctx.kicks || []).slice().sort((a, b) => b[0] - a[0]), hs = (ctx.hits || []).slice().sort((a, b) => b[0] - a[0]);
      const L = WAKE ? clamp01(WAKE.life) : 1;          // (countdown 2.0: asleep, the music moves it less)
      for (const k of ks) if (k[1] * L > 0.05 && fresh('kick', k[0])) rig.kick(t - k[0], k[1] * L);
      for (const h of hs) if (h[1] * L > 0.3 && fresh('hit', h[0])) { rig.drop(t - h[0], h[1] * L); st.gemK = Math.max(st.gemK, h[1] * L); }
      // the chat: a tap is a spark down one cable; a gift is a burst by its size
      const FX = WAKE && WAKE.ownChat ? null : st.fxNow;      // (countdown 2.0 sends the chat's pulses itself, cable by cable)
      if (FX) {
        const ages = []; if (FX.taps) for (let k = 0; k < 6; k++) ages.push(FX.taps[k * 4 + 3]);
        for (const age of ages.sort((a, b) => b - a)) if (fresh('tap', age)) rig.tap(t - age, rnd());
        for (const b of (FX.bursts || []).slice().sort((p, q) => q.age - p.age)) if (b.blast > 0 && fresh('gift', b.age)) { rig.gift(t - b.age, Math.pow(10, 0.6 + b.blast)); st.gemK = Math.max(st.gemK, 0.4 + 0.2 * b.blast); }
      }
      // the stream between his hands talks to the cables through this (js/v9/fx-quantum-stream.js)
      const link = root.VTCableLink || (root.VTCableLink = { inbox: [] });
      for (const m of link.inbox.splice(0)) if (m === 'drain') rig.drain(t);
      if (WAKE && WAKE.inbox) for (const m of WAKE.inbox.splice(0)) if (m && /^(tap|gift|drain|whip|drop|kick)$/.test(m.k)) rig[m.k](Number.isFinite(m.t) ? m.t : t, m.v);
      link.burst = rig.burst(t);
      st.gemK *= Math.exp(-dt * 2.4);
      // an extra MYTHIC: a flare (every cable surges and whips, the gem and the ring flash)
      if (FLARES !== st.flares) { st.flares = FLARES; if (!WAKE || (st.pw || 0) > 0.5) { st.flare = 1; st.gemK = Math.max(st.gemK, 1.5); rig.drop(t, 1); } }      // (countdown 2.0: a flare while it sleeps is let go)
      st.flare *= Math.exp(-dt * 1.6);
      // with a hype rank the cables pulse by themselves, faster with every rank
      const pw = WAKE ? (st.pw || 0) : 1;      // (countdown 2.0: asleep, it does not pulse by itself)
      if (st.hy > -0.5 && pw > 0.5 && t - st.pulseAt > 1.9 - 0.26 * Math.max(0, st.hy)) { st.pulseAt = t; rig.kick(t, (0.40 + 0.08 * Math.max(0, st.hy)) * pw); }
    }

    function render(ctx, e, t) {
      const S = st.set, core = st.core; if (!S || !core || !rig || e <= 0) return;
      const P = programs(), Gp = buildStatic(), { vp, vp0, model, cam, sc, ps, audio: A, fx: FX, palette: PAL } = ctx, look = LOOKS[st.look];
      const dt = st.lastT === null ? 1 / 30 : Math.max(0, Math.min(0.1, t - st.lastT)); st.lastT = t; st.dt = dt;
      const gain = (PAL && PAL.gain !== undefined ? PAL.gain : 1) * (FX ? 1 - 0.42 * FX.brace : 1), form = sstep(0.0, 0.75, e), grow = sstep(0.25, 1.0, e), M = core.mesh, nF = M.nFine;
      const hypeT = HYPE !== null ? HYPE : st.v8u ? -1 + 6 * clamp01(st.v8u.v8[2]) : -1, charge = clamp01(CHARGE);
      // the rank is reached smoothly (a step of the hype bar is a change you watch, about a second)
      st.hy += Math.max(-dt * 3.0, Math.min(dt * 3.0, hypeT - st.hy));
      const PW = WAKE ? (WAKE.alive !== undefined ? clamp01(Number(WAKE.alive) || 0) : sstep(0.55, 0.95, clamp01(Number(WAKE.life) || 0))) : 1; st.pw = PW;      // (countdown 2.0: asleep, no hype of its own until it wakes at the zero)
      const hype = WAKE ? -1 + (st.hy + 1) * PW : st.hy, LV = hype + 1, warm = clamp01(LV / 6);
      const heat = clamp01(LV - 1), fire = 0.5 * clamp01(LV - 2) + 0.5 * clamp01(LV - 3), gold = clamp01(LV - 4), cosmic = clamp01(LV - 5), hyU = [heat, fire, gold, cosmic];
      st.gold = gold; st.cosmic = cosmic; st.flowT += dt * (1.6 + 2.6 * A.level) * (1 + 1.6 * fire + 0.8 * cosmic);
      const colA = lerp3(look.a, GOLDEN, 0.85 * gold), eyeC = lerp3(look.eye, [1.7, 1.05, 0.35], 0.6 * gold);
      { const link = root.VTCableLink; if (link) { link.hype = hype; link.gold = gold; } }
      events(t, dt, ctx);
      rig.step(t, dt, model, WAKE ? { grow, bass: A.bass * clamp01(WAKE.life), level: A.level * clamp01(WAKE.life), slack: WAKE.slack, tight: WAKE.tight } : { grow, bass: A.bass, level: A.level });
      if (WAKE && WAKE.gem > st.gemK) st.gemK = WAKE.gem;
      let surge = 0; for (let c = 0; c < rig.count; c++) surge = Math.max(surge, rig.surge(c, t)); st.surge = surge;
      for (let i = 0; i < 8; i++) { const k = ctx.kicks[i] || [99, 0]; kickU[i * 2] = k[0]; kickU[i * 2 + 1] = k[1]; }
      const dim = WAKE ? clamp01(WAKE.lum === undefined ? 1 : Number(WAKE.lum)) : 1;      // (countdown 2.0: the Mask dark asleep, lit by the fill)
      const com = (p, m) => p.use().u('uModel', m || model).u('uViewProj', vp).u('uCam', cam).u('uTime', t).u('uBass', A.bass).u('uHigh', A.high).u('uBeat', A.beat).u('uLevel', A.level).u('uGain', gain * dim).u('uDim', dim).u('uColA', colA).u('uColB', look.b).u('uHype', hyU).u('uFlowT', st.flowT).u('uForm', form).u('uCharge', charge).u('uSurge', Math.min(1.2, surge));
      // the rig -> one small data texture: the ropes' points, then per cable its colour, glow, width, surge and its packets of light
      const RD = Gp.rigData, W = rig.nodes + 4; let nLit = 0;
      for (let c = 0; c < rig.count; c++) {
        const C = rig.cables[c], o = c * W * 4; RD.set(rig.pos.subarray(c * rig.nodes * 4, (c + 1) * rig.nodes * 4), o);
        const q = o + rig.nodes * 4, pk = rig.packets(c, t);
        RD[q] = C.hue + (C.sheath ? 2 : 0); const lt = rig.lit(c, hype); if (lt > 0.6) nLit++;
        RD[q + 1] = rig.glow(c, t, A) * lt * (1 + 0.25 * warm); RD[q + 2] = rig.width(c, A) * (1 + 0.15 * fire); RD[q + 3] = Math.max(rig.surge(c, t), 0.85 * cosmic);      // (MYTHIC: every cable white-hot)
        for (let j = 0; j < 3; j++) { const p = pk[pk.length - 1 - j]; RD[q + 4 + j * 4] = p ? (WAKE && p.inward ? Math.pow(clamp01(p.u), 2) : p.u) : -9; RD[q + 5 + j * 4] = p ? p.s : 0; RD[q + 6 + j * 4] = p && p.inward ? (WAKE ? TAP_EMPH : 1) : 0; RD[q + 7 + j * 4] = p && p.inward && WAKE ? 0.03 + 0.20 * Math.min(1, Math.max(0, p.u) / 0.25) : 0; }
      }
      Gp.rigTex.set(RD); st.litN = nLit;
      // ---- 1. what is solid (it hides what is behind it): the cranium, his face, the gear, the bust, the cables' cores
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      const under = (0.30 + 0.55 * A.bass + 0.5 * A.beat + 0.8 * surge) * charge;
      com(P.solid).u('uGem', look.gem).u('uRingC', look.ring).u('uMetal', look.metal).u('uGemK', st.gemK + 0.25 * warm).u('uUnder', under).u('uDetail', 1.15 * Gp.detail).ui('uFormTex', 0).ui('uLineTex', 1).ui('uNormTex', 2);
      G.bindTex(0, Gp.formTex); G.bindTex(1, Gp.lineTex); G.bindTex(2, Gp.normTex);
      gl.vertexAttrib2f(Gp.aUv, 0, 0); gl.vertexAttrib2f(Gp.aMat, 4, 1);
      P.solid.ui('uKind', 1); gl.bindVertexArray(Gp.skullVao); gl.drawElements(gl.TRIANGLES, Gp.skullN, gl.UNSIGNED_SHORT, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, S.bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, core.pos); gl.bindBuffer(gl.ARRAY_BUFFER, S.bNrm); gl.bufferSubData(gl.ARRAY_BUFFER, 0, core.nrm);
      P.solid.ui('uKind', 0); gl.bindVertexArray(S.faceVao); gl.drawElements(gl.TRIANGLES, S.faceN, gl.UNSIGNED_INT, 0);
      if (ctx.solo) {
        // the mouth: a hollow behind the lips (dark, glowing deep inside)
        const ring = core.mouth.ring, NR = ring.length / 3; let mx = 0, my = 0, mz = 0;
        for (let k = 0; k < NR; k++) { mx += ring[k * 3] / NR; my += ring[k * 3 + 1] / NR; mz += ring[k * 3 + 2] / NR; }
        for (let k = 0; k < NR; k++) { const k1 = (k + 1) % NR; mouthData.set([mx, my, mz - 0.16, 1, 0, ring[k * 3], ring[k * 3 + 1], ring[k * 3 + 2] - 0.012, 0, 0, ring[k1 * 3], ring[k1 * 3 + 1], ring[k1 * 3 + 2] - 0.012, 0, 0], k * 15); }
        gl.bindBuffer(gl.ARRAY_BUFFER, Gp.mouthBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, mouthData);
        P.solid.ui('uKind', 3); gl.bindVertexArray(Gp.mouthVao); gl.drawArrays(gl.TRIANGLES, 0, NR * 3);
      }
      P.solid.ui('uKind', 2); gl.bindVertexArray(Gp.gearVao);
      const bustR = Gp.ranges.bust || [0, 0], headN = bustR[0];                          // (the bust is the last material)
      gl.drawElements(gl.TRIANGLES, headN, gl.UNSIGNED_INT, 0);
      // the bust keeps calm: it follows where the head is, and a third of its turn
      const s0 = Math.hypot(model[0], model[1], model[2]) || 1, Rb = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Rb[r * 3 + c] = (r === c ? 0.68 : 0) + 0.32 * model[c * 4 + r] / s0;
      { let l = Math.hypot(Rb[0], Rb[3], Rb[6]) || 1; Rb[0] /= l; Rb[3] /= l; Rb[6] /= l; const d = Rb[0] * Rb[1] + Rb[3] * Rb[4] + Rb[6] * Rb[7]; Rb[1] -= d * Rb[0]; Rb[4] -= d * Rb[3]; Rb[7] -= d * Rb[6]; l = Math.hypot(Rb[1], Rb[4], Rb[7]) || 1; Rb[1] /= l; Rb[4] /= l; Rb[7] /= l; Rb[2] = Rb[3] * Rb[7] - Rb[6] * Rb[4]; Rb[5] = Rb[6] * Rb[1] - Rb[0] * Rb[7]; Rb[8] = Rb[0] * Rb[4] - Rb[3] * Rb[1]; }
      if (bustR[1]) { P.solid.u('uModel', M4.trs(Rb, s0, [model[12], model[13], model[14]])); gl.drawElements(gl.TRIANGLES, bustR[1], gl.UNSIGNED_INT, bustR[0] * 4); }
      // the cables' cores
      com(P.cab).u('uGain', gain).u('uDim', dim).ui('uRig', 0).ui('uNodes', rig.nodes).u('uSc', s0).u('uForm', grow > 0.999 ? 2 : grow).ui('uPass', 0).u('uRad', 1);
      G.bindTex(0, Gp.rigTex.tex); gl.bindVertexArray(Gp.cabVao); gl.drawElements(gl.TRIANGLES, Gp.cabN, gl.UNSIGNED_INT, 0);
      // ---- 2. what glows (added on top; hidden by what is solid)
      gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      P.cab.ui('uPass', 1).u('uRad', 2.1); gl.drawElements(gl.TRIANGLES, Gp.cabN, gl.UNSIGNED_INT, 0);
      // the bokeh, far behind
      P.glow.use().u('uViewProj', vp0 || vp).u('uPx', G.H * 0.12 * e); gl.bindVertexArray(Gp.bokehVao); gl.drawArrays(gl.POINTS, 0, Gp.bokehN);
      // the specks
      const pd = S.posData, nd = S.nrmData, Pp = core.pos, Nn = core.nrm;
      for (let i = 0; i < nF; i++) { pd[i * 4] = Pp[i * 3]; pd[i * 4 + 1] = Pp[i * 3 + 1]; pd[i * 4 + 2] = Pp[i * 3 + 2]; nd[i * 4] = Nn[i * 3]; nd[i * 4 + 1] = Nn[i * 3 + 1]; nd[i * 4 + 2] = Nn[i * 3 + 2]; }
      S.posTex.set(pd); S.nrmTex.set(nd);
      com(P.pt).u('uForm', sstep(0.1, 1.0, e)); G.bindTex(0, S.posTex.tex); G.bindTex(1, S.nrmTex.tex);
      P.pt.ui('uPosTex', 0).ui('uNrmTex', 1).u('uPx', G.H * 0.0195 * ps).u('uMinPx', 1.35).uv('uKick', 2, kickU).u('uSpeck', look.speck).ui('uNImp', FX ? FX.nImp : 0).uv('uImp', 4, FX ? FX.imp : IMP0).uv('uImpT', 4, FX ? FX.impT : IMP0).uv('uImpC', 3, FX ? FX.impC : IMPC0).u('uFlash', FX ? FX.flash : [0, 0, 0, 0]);
      gl.bindVertexArray(S.vao);
      P.pt.ui('uMode', 1); gl.drawArrays(gl.POINTS, S.nFace, S.nDome);
      P.pt.ui('uMode', 0); gl.drawArrays(gl.POINTS, 0, S.nFace);
      // (countdown 2.0: the light that fills the head; it leaves the state as it found it: additive, no depth write)
      if (WAKE && root.VTCableWake) root.VTCableWake.draw(G, { t, e, vp, model, cam, gain, look, core, faceVao: S.faceVao, faceN: S.faceN, skullVao: Gp.skullVao, skullN: Gp.skullN, aPos: P.solid.a('aPos'), aNrm: P.solid.a('aNrm'), rig, wake: WAKE, audio: A, ps });
      // ---- the eyes: the opening between his lids as it is right now (it closes with a blink), glowing
      const mw = (p) => [model[0] * p[0] + model[4] * p[1] + model[8] * p[2] + model[12], model[1] * p[0] + model[5] * p[1] + model[9] * p[2] + model[13], model[2] * p[0] + model[6] * p[1] + model[10] * p[2] + model[14]];
      let ng = 0; const glow = (p, size, c, l, kind = 0) => { if (ng >= 360) return; glowData.set([p[0], p[1], p[2], size, c[0] * l, c[1] * l, c[2] * l, kind], ng * 8); ng++; };
      const co = core.coarse, lit = [], alive = sstep(0.15, 0.6, charge);
      for (let ei = 0; ei < 2; ei++) {
        const ring = EYE_RING[ei], E = core.eyes[ei]; let cx = 0, cy = 0, cz = 0, x0 = 9, x1 = -9, y0 = 9, y1 = -9;
        for (const v of ring) { const x = co[v * 3], y = co[v * 3 + 1]; cx += x / 16; cy += y / 16; cz += co[v * 3 + 2] / 16; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const z = cz - 0.012, o = ei * 16 * 12;
        // (drawn a little larger than his real opening, round its middle: the look's eyes are wide almonds; it still closes with a blink)
        const EX = 1.36, EY = 1.70 * (WAKE ? 0.08 + 0.92 * (1 - clamp01(Number(WAKE.shut) || 0)) : 1), ex = (v) => cx + (co[v * 3] - cx) * EX, ey = (v) => cy + (co[v * 3 + 1] - cy) * EY;
        for (let k = 0; k < 16; k++) { const a = ring[k], b = ring[(k + 1) % 16]; eyeData.set([cx, cy, z, 1, ex(a), ey(a), co[a * 3 + 2] - 0.012, 0, ex(b), ey(b), co[b * 3 + 2] - 0.012, 0], o + k * 12); }
        // the white-hot heart sits where he looks, held INSIDE the corners of the lids, eased so it never trembles (the Reactiv Core eye work)
        const rI = 0.15, hw = Math.max(0, (x1 - x0) / 2 - rI * 0.92), hh = 0.30 * (y1 - y0) / 2, mx = (x0 + x1) / 2, GAZE = 0.20;
        const tx2 = Math.min(mx + hw, Math.max(mx - hw, E.c[0] + E.gaze[0] * GAZE)), ty = Math.min(cy + hh, Math.max(cy - hh, E.c[1] + 0.012 + E.gaze[1] * GAZE));
        let ir = st.iris[ei];
        if (!ir) ir = st.iris[ei] = [tx2 - cx, ty - cy];
        else { const dx = tx2 - cx - ir[0], dy = ty - cy - ir[1], d = Math.hypot(dx, dy), kk = d < 0.006 ? 0.04 : 0.30; ir[0] += dx * kk; ir[1] += dy * kk; }
        const open = WAKE ? Math.max(sstep(0.13, 0.40, E.open) * alive, clamp01(WAKE.seam)) * sstep(0.5, 1.0, e) : sstep(0.13, 0.40, E.open) * sstep(0.5, 1.0, e) * alive;      // (countdown 2.0: a glow along the shut lids)
        const ix = Math.min(mx + hw, Math.max(mx - hw, cx + ir[0])); ir[0] = ix - cx;
        lit.push({ x: ix, y: cy + ir[1], z, x0, x1, y0, y1, r: rI, open: E.open, light: open, w: x1 - x0, h: y1 - y0 });
      }
      st.eyeDbg = lit;
      gl.bindBuffer(gl.ARRAY_BUFFER, Gp.eyeBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, eyeData);
      com(P.eye).u('uGain', gain).u('uEye', eyeC).u('uEyeCore', look.eyeCore); gl.bindVertexArray(Gp.eyeVao); gl.disable(gl.DEPTH_TEST);
      lit.forEach((L, ei) => {
        if (L.light <= 0) return;
        P.eye.u('uIris', [L.x, L.y, L.z]).u('uIrisR', [Math.max(0.12, L.w * 0.34), Math.max(0.07, L.h * 0.55)]).u('uOpen', L.light);
        gl.drawArrays(gl.TRIANGLES, ei * 48, 48);
        glow(mw([L.x, L.y, L.z + 0.08]), 22, eyeC, 0.75 * L.light * (0.9 + 0.3 * A.beat + 1.2 * surge));
      });
      gl.enable(gl.DEPTH_TEST);
      const nEyeGlow = ng;
      // MYTHIC: star eyes, and a ring of light round the head
      if (cosmic > 0.01) {
        for (const L of lit) if (L.light > 0) glow(mw([L.x, L.y, L.z + 0.10]), 34, [1.6, 1.4, 1.7], 0.9 * cosmic * L.light, 1);
        const NR2 = 96, rr = 2.35 + 0.06 * A.bass + 0.25 * st.flare, k2 = cosmic * (0.55 + 0.35 * A.beat + 1.4 * st.flare) * charge;
        for (let i = 0; i < NR2; i++) { const an = i / NR2 * 6.2832 + t * 0.12; glow(mw([Math.cos(an) * rr, 0.10 + Math.sin(an) * rr, -1.0]), 5.5 + 2.5 * Math.sin(an * 8.0 + t * 2.0), i % 4 ? [1.6, 1.25, 0.7] : [1.4, 0.9, 1.7], k2); }
      }
      // ON FIRE / WILDFIRE: energy drips off the ends of the cables
      st.dripAcc += dt * (26 * clamp01(LV - 2) + 34 * clamp01(LV - 3) + 20 * cosmic) * e;
      while (st.dripAcc >= 1) { st.dripAcc -= 1; if (st.nDrip >= 200) break; const c = Math.floor(rnd() * rig.count), q = (c * rig.nodes + rig.nodes - 1 - Math.floor(rnd() * 4)) * 4, d = st.nDrip++ * 8; drips.set([rig.pos[q], rig.pos[q + 1], rig.pos[q + 2], 0, (rnd() - 0.5) * 0.5, 0.2 * rnd(), 0.7 + 0.9 * rnd(), rig.cables[c].hue], d); }
      for (let i = st.nDrip - 1; i >= 0; i--) {
        const d = i * 8; drips[d + 3] += dt; if (drips[d + 3] >= drips[d + 6]) { st.nDrip--; if (i !== st.nDrip) drips.copyWithin(d, st.nDrip * 8, st.nDrip * 8 + 8); continue; }
        drips[d + 5] -= 3.2 * dt; drips[d] += drips[d + 4] * dt; drips[d + 1] += drips[d + 5] * dt;
        const u = 1 - drips[d + 3] / drips[d + 6]; glow([drips[d], drips[d + 1], drips[d + 2]], 2.4 + 1.6 * u, drips[d + 7] > 0.5 ? look.b : colA, 0.9 * Math.min(1, u * 3) * charge, i % 3 ? 0 : 2);
      }
      // the gem's and the rings' own glow
      const meta = assets.gear.meta;
      if (form > 0.6 && meta.gem) { const g = meta.gem; glow(mw([g.at[0] + g.n[0] * 0.10, g.at[1] + g.n[1] * 0.10, g.at[2] + g.n[2] * 0.10]), 9 + 8 * st.gemK, lerp3(look.gem, [1.7, 0.95, 0.3], 0.8 * gold), (0.30 + 0.25 * A.beat + 1.6 * st.gemK + 0.9 * heat) * charge, st.gemK > 0.25 || heat > 0.5 ? 1 : 0); }
      if (form > 0.6) for (const r of meta.rings || []) glow(mw([r.at[0] + r.axis[0] * 0.06, r.at[1], r.at[2]]), 16, look.ring, (0.10 + 0.10 * A.beat + 0.5 * surge) * charge);
      if (ng > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, Gp.glowBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowData.subarray(0, ng * 8));
        P.glow.use().u('uViewProj', vp).u('uPx', G.H * 0.066 * ps); gl.bindVertexArray(Gp.glowVao);
        const nEye = nEyeGlow;
        if (nEye) { gl.disable(gl.DEPTH_TEST); gl.drawArrays(gl.POINTS, 0, nEye); gl.enable(gl.DEPTH_TEST); }
        if (ng > nEye) gl.drawArrays(gl.POINTS, nEye, ng - nEye);
      }
      gl.bindVertexArray(null);
    }
    return { setCore, setStyle, pre, load, has: (n) => !!LOOKS[n], rig: () => rig, stats: () => ({ style: st.want, shown: st.e || 0, ready: st.ready, failed: st.failed, points: st.set ? st.set.n : 0, cables: rig ? rig.count : 0, charge: CHARGE, hype: st.hy, lit: st.litN, drips: st.nDrip, ring: st.cosmic || 0, cosmic: st.cosmic || 0, gold: st.gold || 0, surge: st.surge, eyes: st.eyeDbg || null, effect: LOOKS[st.look].effect }) };
  }

  /** mask-v9.js's object with the cable looks added: Classic and Reactiv Core go through to it untouched */
  function create(G, o) {
    const base = Base.create(G, o), cab = createCables(G, o || {});
    let which = 'base';
    return {
      setCore(c) { base.setCore(c); cab.setCore(c); },
      setStyle(name) {
        if (cab.has(name)) { base.setStyle('classic'); which = 'cab'; return cab.setStyle(name); }
        const ok = base.setStyle(name); if (ok) { cab.setStyle('classic'); which = 'base'; } return ok;
      },
      // one style at a time: the one that is leaving finishes its way out before the other starts its way in
      pre(t, dt, env) {
        if (which === 'cab') { const b = base.pre(t, dt, env); if (b) return b; return cab.pre(t, dt, env); }
        const c = cab.pre(t, dt, env); if (c) return c; return base.pre(t, dt, env);
      },
      load: () => (which === 'cab' ? cab.load() : base.load()),
      // (while a cable look is still on its way out, the numbers are its own)
      stats: () => { if (which === 'cab') return cab.stats(); const c = cab.stats(); return c.shown > 0 ? { ...c, style: base.stats().style } : base.stats(); },
      cables: cab, STYLES: STYLES.slice(),
    };
  }
  const STYLES = Base.STYLES.concat(Object.keys(LOOKS));
  const api = Object.assign({}, Base, { create, STYLES, base: Base });
  root.VTMaskV9 = api;
  root.VTMaskCables = { LOOKS, createCables, parseGear,
    /** an extra MYTHIC: one flare (n = 0 only reads how many there were) */
    flare: (n) => { if (n !== 0) FLARES++; return FLARES; },
    /** the avatar page's Mask: what the show tells it about the hype (mask.setHype(rank -1..5), mask.hypePlus()) reaches the cable looks too */
    attach: (mask) => { if (!mask || mask.__cables) return mask; const sh = mask.setHype, hp = mask.hypePlus; mask.__cables = true; mask.setHype = (r, k) => { const n = Math.round(Number(r)); HYPE = Number.isFinite(n) ? Math.max(-1, Math.min(5, n)) : null; return sh ? sh(r, k) : false; }; mask.hypePlus = () => { FLARES++; return hp ? hp() : false; }; return mask; }, charge: (v) => { if (v !== undefined) CHARGE = clamp01(Number(v)); return CHARGE; }, hype: (r) => { if (r !== undefined) HYPE = r === null ? null : Math.max(-1, Math.min(5, Number(r))); return HYPE; },
    /** COUNTDOWN 2.0 (js/v9-countdown.js): its numbers for the cables, the eyes and the light that fills the head. null = exactly as without it */
    wake: (o) => { WAKE = o && typeof o === 'object' ? o : null; return WAKE; } };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
