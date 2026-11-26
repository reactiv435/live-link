// V9 HYPE (exploration, Nov 26 2026): new looks for the hype-bar ranks, behind a switch. Loaded next to mask-v8.js.
//   stage.setHypeStyle('classic' | 'aura' | 'orbit' | 'smoke' | 'material' | 'stage' | 'nebula')     'classic' = the V8 ladder, untouched
//   'nebula' = AURA TO NEBULA, the owner's pick (A + C merged): a rim of heat, wisps and lit smoke, fire through smoke, a
//   contained firestorm, then a nebula round the head (gas baked in Blender: tools/v9/blender_bake_nebula.py -> mask/v9/nebula.webp)
//   stage.gifter(viewer, coins)                                                             a gifter's picture joins the orbit (any style)
// The rules every style follows:
//   * every rank ADDS an element (a power-up sequence), nothing is glued onto the mouth or the nose;
//   * what burns round the head is a shader (domain-warped noise, tapered flames, smoke with light inside), drawn BEHIND the
//     face with the scene's own depth, so the face cuts it out; what orbits is real 3D (ribbons, points, crystals, pictures)
//     tested against the same depth, so it passes behind the head and in front of it;
//   * a rank-up is a TRANSFORMATION inside the face: a front of energy crosses the face (each style its own way) and the
//     material behind the front is the new rank's; it waits a moment for a kick, so the new look locks in on the beat;
//   * MYTHIC stays what it is (the galaxy, the suns, the ring of stars): every style lets go into it.
// This file knows nothing of the page: mask-v8.js calls pre() / render(), mask-looks.js reads the face's numbers (uHy*).
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v)), lerp = (a, b, k) => a + (b - a) * k;
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const h1 = (x) => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  const STYLES = ['classic', 'aura', 'orbit', 'smoke', 'material', 'stage', 'nebula'];
  const HERE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, 'v9/') : 'mask/v9/';
  const LABELS = { classic: 'Classic (today)', aura: 'A  Aura Ascension', orbit: 'B  Orbital System', smoke: 'C  Smoke to Nebula', material: 'D  Material Transformation', stage: 'E  The Stage Wakes Up', nebula: 'Aura to Nebula' };
  const WHITE = [1.0, 0.96, 0.88], NEB_GOLD = [1.0, 0.52, 0.085];      // (nebula's face gold: orange in the shade so it never reads olive; the highlights are the shader's warm white)
  // how the front crosses the face, per style (mask-looks.js hyFront): 0 from the core out, 1 a plane from the brow down,
  // 2 from the edges in, 3 from the eyes, 5 from the mouth, 6 from a strike on the brow
  const WAVE = { aura: 0, orbit: 1, smoke: 5, material: 2, stage: 3, classic: 0, nebula: 0 };
  /** nebula: the low ranks ignite from the core (A's ring), WILDFIRE and LEGENDARY are breathed in and out (C's, from the mouth) */
  const waveOf = (style, to) => (style === 'nebula' ? (to >= 3 ? 5 : 0) : WAVE[style] || 0), breathes = (style, to) => style === 'smoke' || (style === 'nebula' && to >= 3);
  // TONES: the colours a style burns in. classic = the house (crimson / fire / gold); quantum = Quantum Flow (violet / gold)
  const TONES = {
    classic: { deep: [0.95, 0.055, 0.03], mid: [1.0, 0.36, 0.06], hot: [1.0, 0.72, 0.30], gold: [1.0, 0.70, 0.22], smoke: [0.090, 0.070, 0.062] },
    quantum: { deep: [0.30, 0.06, 1.20], mid: [0.66, 0.20, 1.50], hot: [1.0, 0.70, 0.95], gold: [1.0, 0.62, 0.14], smoke: [0.060, 0.045, 0.095] },
  };

  /** r = rank + 1: 0 no rank, 1 WARMING UP, 2 HEATING UP, 3 ON FIRE, 4 WILDFIRE, 5 LEGENDARY, 6 MYTHIC. seg(r, n) = how much of rank n is there */
  const seg = (r, n) => clamp(r - n + 1);
  /** what is round the head at level r (a float: it glides between ranks) -> the aura program's numbers and the 3D parts */
  function around(style, r) {
    const s1 = seg(r, 1), s2 = seg(r, 2), s3 = seg(r, 3), s4 = seg(r, 4), s5 = seg(r, 5), m = seg(r, 6), keep = 1 - m;
    const o = { shimmer: 0, wisps: 0, flame: 0, flameH: 0, column: 0, lightning: 0, shock: 0, gold: s5, smoke: 0, inner: 0, vortex: 0, dust: 0, rays: 0, floor: 0, pyro: 0, spots: 0, mandala: 0, haze: 0, nebula: 0, back: 0,
      lit: 0, tongues: 0, storm: 0, neb: 0, ring1: 0, ring2: 0, ring3: 0, ignite: 0, motes: 0, comets: 0, shards: 0, sats: 0, sparks: 0, embers: 0, zoom: 1, push: 0, rain: 0 };
    if (style === 'aura') {
      o.shimmer = s1 * (1 - 0.5 * s3) * keep + 0.45 * m; o.wisps = s2 * (1 - 0.65 * s3) * keep; o.flame = s3 * keep; o.flameH = 0.72 * s3 + 0.95 * s4 + 0.10 * s5;
      o.column = s4 * keep; o.shock = s4 * keep; o.lightning = s5 * keep; o.sparks = (0.4 * s3 + 0.8 * s4 + 0.3 * s5) * keep; o.back = (0.15 * s1 + 0.2 * s2) * keep; o.embers = 0.35 * s2 + 0.25 * s3;
    } else if (style === 'orbit') {
      o.ring1 = s1 * keep; o.ring2 = s2 * keep; o.motes = s2 * keep; o.ignite = s3; o.comets = s3 * keep; o.ring3 = s4 * keep; o.shards = s4 * keep; o.mandala = s5 * keep; o.sats = s5 * keep;
      o.zoom = 1 - 0.15 * s1 * (1 - 0.6 * m) - 0.03 * s4 * keep; o.back = 0.12 * s3 * keep; o.sparks = 0.3 * s4 * keep; o.embers = 0.2 * s1;
    } else if (style === 'smoke') {
      o.smoke = (0.42 * s1 + 0.33 * s2 + 0.10 * s3 + 0.15 * s4) * (1 - 0.35 * m); o.inner = s2 * keep + 0.3 * m; o.flame = 0.85 * s3 * (1 - s5) ; o.flameH = 0.35 * s3 + 0.35 * s4; o.vortex = s4 * (1 - 0.5 * s5) * keep;
      o.dust = s5 * keep; o.nebula = m; o.embers = 0.45 * s1 + 0.2 * s3; o.sparks = 0.5 * s4 * (1 - s5);
    } else if (style === 'material') {
      o.haze = (0.4 * s2 + 0.6 * s3) * (1 - s5) * keep; o.back = (0.30 * s1 + 0.05 * s2 + 0.12 * s3 + 0.15 * s4) * keep; o.rays = (0.42 * s4 + 0.20 * s5) * keep; o.sparks = (0.3 * s3 + 0.6 * s4) * keep; o.embers = 0.3 * s2 + 0.3 * s3;
    } else if (style === 'stage') {
      o.floor = s1 * (1 - 0.6 * m); o.embers = 0.5 * s1 + 0.4 * s2 + 0.3 * s4; o.back = (0.25 * s2 + 0.15 * s3) * keep; o.haze = 0.7 * s2 * (1 - 0.5 * s3) * keep; o.rays = (0.75 * s3 + 0.45 * s4 + 0.2 * s5) * keep;
      o.pyro = s4 * keep; o.shock = s4 * keep; o.spots = s5 * keep; o.rain = s5 * keep; o.push = 0.012 * (s1 + s2 + s3) + 0.03 * s4 + 0.03 * s5; o.zoom = 1 - 0.10 * s1 * keep;
    } else if (style === 'nebula') {
      // WARMING UP a rim of heat | HEATING UP wisps + smoke curls lit by the aura | ON FIRE fire through the smoke, tongues up
      // the cheeks | WILDFIRE a firestorm that stays round the head | LEGENDARY the storm condenses into a nebula, gold, lightning
      o.shimmer = clamp(s1 - 0.1 * s2 - 0.3 * s3 - 0.2 * s4 + 0.6 * s5) * keep + 0.45 * m; o.wisps = clamp(s2 - s3) * keep;
      o.lit = clamp(0.55 * s2 + 0.20 * s3 - 0.80 * s4) * keep; o.flame = clamp(s3 - s4) * keep; o.flameH = 0.86 * s3; o.tongues = clamp(s3 - s4) * keep;      // (the storm takes the fire and the smoke INTO itself: WILDFIRE draws the storm only, which is also what keeps its cost down)
      o.storm = clamp(s4 - s5) * keep; o.neb = s5 * keep; o.lightning = s5 * keep; o.nebula = m;
      o.back = clamp(0.18 * s1 - 0.12 * s2 - 0.06 * s3) * keep; o.embers = 0.25 * s1 + 0.15 * s2 + 0.15 * s3; o.sparks = clamp(0.4 * s3 + 0.4 * s4 - 0.5 * s5) * keep;
      o.zoom = 1 - (0.10 * s4 + 0.03 * s5) * (1 - m);      // (the storm and the nebula need room at the sides of a 9:16 frame)
    }
    return o;
  }
  /** the face's own material at a whole rank: a = (coal edges, magma veins, molten, shards), a2 = (gold, stained dark, a light crossing, glow) */
  function face(style, rank) {
    const r = rank + 1, s1 = seg(r, 1), s2 = seg(r, 2), s3 = seg(r, 3), s4 = seg(r, 4), s5 = seg(r, 5), keep = 1 - seg(r, 6);
    let a = [0, 0, 0, 0], a2 = [0, 0, 0, 0];
    if (style === 'aura') { a = [0.55 * s1 + 0.25 * s2, 0, 0.14 * s2 + 0.16 * s3 + 0.15 * s4 - 0.30 * s5, 0]; a2 = [s5, 0, 0, 0.10 * s3 + 0.12 * s4]; }
    else if (style === 'orbit') { a = [0.30 * s3 + 0.2 * s4, 0, 0, 0]; a2 = [0.85 * s5, 0, 0.45 * s1 + 0.25 * s2 + 0.30 * s3 + 0.25 * s4, 0.06 * (s2 + s3 + s4)]; }
    else if (style === 'smoke') { a = [0.45 * s1 + 0.35 * s2, 0, 0.30 * s3 + 0.30 * s4 - 0.5 * s5, 0]; a2 = [0.9 * s5, 0.40 * s1 + 0.20 * s2 - 0.25 * s3 - 0.35 * s5, 0, 0]; }
    else if (style === 'material') { a = [s1 * (1 - 0.6 * s3), s2 * (1 - 0.45 * s4), s3 * (1 - 0.55 * s4) * (1 - s5), s4]; a2 = [s5, 0.15 * s1 * (1 - s3), 0, 0.08 * s3]; }
    else if (style === 'nebula') { a = [0.55 * s1 + 0.25 * s2, 0, 0.14 * s2 + 0.18 * s3 + 0.16 * s4 - 0.48 * s5, 0]; a2 = [s5, 0, 0, 0.10 * s3 + 0.12 * s4]; }
    else if (style === 'stage') { a = [0.40 * s2 + 0.2 * s3, 0, 0.18 * s4 * (1 - s5), 0]; a2 = [0.75 * s5, 0, 0, 0.07 * s1 + 0.07 * s2 + 0.10 * s3 + 0.10 * s4]; }
    return { a: a.map((v) => clamp(v) * keep), a2: a2.map((v) => clamp(v) * keep) };
  }

  // ---------------------------------------------------------------- shaders
  const NOISE = `
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float vn(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s / 0.9375; }`;
  const AURA_VS = `#version 300 es
  uniform float uZ; out vec2 vUv;
  void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, uZ, 1.0); }`;
  // What is ROUND the head, one full-screen pass, in "head units" (the face is about 2 wide and 3 tall, its middle at (0, -0.42)).
  // Out: light to add (rgb) and how much of what is behind it is hidden (a): smoke hides, fire only adds.
  const AURA_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform vec4 uHead; uniform float uAspect, uTime, uLayer, uFloorY; uniform vec4 uAud; uniform vec2 uKick[8];
  uniform vec3 uC0, uC1, uC2, uC3, uSmokeC, uDeep; uniform vec4 uA, uB, uS, uE, uM, uX, uN, uN2, uN3; uniform float uVis; uniform sampler2D uNebT;
  ${NOISE}
  // the face's outline: about 2 wide at the brow, narrower at the chin, from y = 1.05 down to y = -1.45
  float sdHead(vec2 p) { vec2 q = p - vec2(0.0, -0.20); float a = mix(0.64, 1.04, smoothstep(-1.25, 0.25, q.y)); return (length(q / vec2(a, 1.27)) - 1.0) * a; }
  float line(float x, float w) { x /= w; return exp(-x * x); }
  vec3 ramp(float f) {
    vec3 c = mix(uC0 * 0.80, uC1 * 1.05, smoothstep(0.20, 0.58, f)); c = mix(c, uC2 * 1.45, smoothstep(0.52, 0.92, f)); c = mix(c, vec3(1.0, 0.95, 0.84) * 2.1, smoothstep(0.98, 1.45, f));
    return c * smoothstep(0.02, 0.16, f);
  }
  // a mass of flame standing on the head's outline: H = how far it stands above the head, taper = how much it narrows to a
  // tip. The outline is stretched upward, bent by slow noise, and torn into tongues by noise that streams up through it.
  float flame(vec2 p, float H, float taper, float t, float speed) {
    float cy = -0.20, up = max(p.y - cy, 0.0), top = 1.27 * (1.0 + H);
    float w = fbm(vec3(p.x * 1.25, p.y * 0.65 - t * 1.05 * speed, t * 0.21)) - 0.5;
    vec2 q = vec2(p.x + w * (0.08 + 0.60 * up / top) * (1.0 + 0.5 * H), p.y);
    float upq = max(q.y - cy, 0.0), hgt = upq / top, low = smoothstep(-1.5, 0.1, p.y);
    vec2 s = vec2(q.x * (1.0 + taper * hgt * hgt), q.y > cy ? cy + upq / (1.0 + H) : q.y);
    float d = sdHead(s), e = 1.0 - smoothstep(-0.04, mix(0.06, 0.25, low), d);
    float n = smoothstep(0.24, 0.76, fbm(vec3(q.x * 2.9, q.y * 0.95 - t * 2.3 * speed, t * 0.37))), n2 = vn(vec3(q.x * 6.5, q.y * 2.2 - t * 4.0 * speed, t * 0.8));
    return (e * (0.86 + 0.28 * n2) - (1.0 - n) * (0.26 + 1.05 * hgt)) * mix(0.55, 1.0, low);
  }
  void main() {
    vec2 sp = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
    vec2 p = (sp - uHead.xy) / uHead.z; float cr = cos(uHead.w), sr = sin(uHead.w); p = vec2(cr * p.x + sr * p.y, -sr * p.x + cr * p.y);
    vec2 c0 = vec2(0.0, -0.20), pc = (p - c0) * (1.0 + 0.55 * uM.w); p = c0 + pc;      // (uM.w: breathed in toward the face, or thrown out)
    float t = uTime, d = sdHead(p), dOut = max(d, 0.0), r = length(pc), ang = atan(pc.x, pc.y);
    vec2 ac = vec2(sin(ang), cos(ang));
    float bass = uAud.x, beat = uAud.y;
    vec3 col = vec3(0.0); float al = 0.0;
    float outside = smoothstep(-0.14, 0.02, d);
    float sideFade = 1.0 - smoothstep(uAspect - 0.150, uAspect - 0.045, abs(sp.x));      // (nebula: nothing is cut by the frame's sides; 0 from 43 px in at 1080 wide)
    if (uLayer < 0.5) {
      // ---- THE STAGE: rays from behind the head, a floor, jets of fire, two spotlights
      if (uE.x > 0.001) {
        float ry = pow(smoothstep(0.40, 0.72, fbm(vec3(ac * 2.7, t * 0.06))), 1.5) * 1.5 + pow(smoothstep(0.50, 0.86, vn(vec3(ac * 7.5 + 3.0, t * 0.11))), 2.0) * 1.3;
        float fall = exp(-dOut * (0.70 - 0.22 * beat)) * outside;
        col += mix(uC0, uC1, 0.55) * (ry * fall * uE.x * (0.34 + 0.25 * bass + 0.32 * beat)) + uC0 * (exp(-dOut * 2.8) * outside * 0.14 * uE.x);
      }
      if (uE.y > 0.001) {
        float below = uFloorY - sp.y, hx = sp.x - uHead.x;
        if (below > 0.0) {
          float refl = exp(-hx * hx * (7.0 + 30.0 * below)) * exp(-below * 3.0), sheen = vn(vec3(hx * 3.0 / (below + 0.08), below * 30.0, t * 0.3));
          float rings = 0.0;
          for (int i = 0; i < 4; i++) { float age = uKick[i].x, s = uKick[i].y; if (age < 1.4 && s > 0.05) { float er = length(vec2(hx, (below - 0.075) / 0.19)), x = (er - 0.05 - age * 0.62) / (0.010 + 0.03 * age); rings += exp(-x * x) * exp(-age * 2.6) * s; } }
          col += (mix(uC0, uC1, 0.5) * (refl * (0.20 + 0.25 * bass + 0.25 * beat) * (0.6 + 0.6 * sheen)) + mix(uC1, uC2, 0.6) * (rings * (0.35 + 0.9 * uB.z)) + uC0 * (0.035 * exp(-below * 5.0) * (0.5 + sheen))) * uE.y;
          col += uC1 * (line(below, 0.004) * (0.45 + 0.5 * beat) * uE.y * exp(-abs(hx) * 2.2));
        } else col += uC0 * (exp(below * 16.0) * 0.07 * uE.y * exp(-abs(hx) * 1.6));
      }
      if (uE.z > 0.001) {
        float kv = 0.0; for (int i = 0; i < 4; i++) { float age = uKick[i].x, s = uKick[i].y; kv = max(kv, s * exp(-age * 2.3) * (1.0 - exp(-age * 26.0))); }
        for (int i = 0; i < 4; i++) {
          float sgn = i < 2 ? -1.0 : 1.0, inner = (i == 0 || i == 2) ? 1.0 : 0.0, jx = sgn * mix(0.485, 0.36, inner), hg = (0.50 + 0.90 * kv * mix(0.72, 1.0, inner) + 0.14 * bass) * uE.z;
          vec2 jp = vec2((sp.x - jx) / 0.050, (sp.y - uFloorY + 0.01) / hg);
          if (jp.y > 0.0 && jp.y < 1.12 && abs(jp.x) < 2.4) {
            float n = fbm(vec3(sp.x * 16.0 + float(i) * 7.0, sp.y * 5.0 - t * 6.5, t * 0.9)), wdt = pow(max(1.0 - jp.y, 0.0), 0.55) + 0.08;
            float f = (1.0 - abs(jp.x + (n - 0.5) * 1.3 * jp.y) / wdt) * (1.15 - jp.y) - (1.0 - n) * (0.25 + 0.8 * jp.y);
            col += ramp(f * 1.15) * uE.z;
          }
        }
      }
      if (uE.w > 0.001) for (int i = 0; i < 2; i++) {
        float sgn = i == 0 ? -1.0 : 1.0; vec2 so = vec2(sgn * uAspect * 0.92, 1.12), dir = normalize(vec2(-sgn * (0.34 + 0.20 * sin(t * 0.83 + float(i) * 2.2)), -1.0)), v = sp - so;
        float along = dot(v, dir), perp = abs(dot(v, vec2(-dir.y, dir.x)));
        if (along > 0.0) { float cone = 1.0 - smoothstep(0.0, 0.030 + 0.115 * along, perp); col += mix(uC3, vec3(1.0, 0.95, 0.85), 0.6) * (cone * cone * cone * exp(-along * 0.62) * (0.55 + 0.45 * fbm(vec3(sp * 3.2, t * 0.35))) * 0.42 * uE.w); }
      }
      // ---- a halo: a rotating mandala of gold behind the head
      if (uM.x > 0.001) {
        float R1 = 1.72 + 0.05 * beat, a = ang + t * 0.22, a2 = ang - t * 0.36, ln = line(r - R1, 0.013) + 0.8 * line(r - R1 * 1.24, 0.010);
        ln += 0.7 * smoothstep(0.90, 1.0, cos(a2 * 24.0)) * smoothstep(R1 * 0.80, R1 * 0.83, r) * (1.0 - smoothstep(R1 * 0.90, R1 * 0.93, r));
        float spk = smoothstep(0.988, 1.0, cos(a * 12.0 + 3.14159)) * smoothstep(R1 * 1.24, R1 * 1.27, r) * (1.0 - smoothstep(R1 * 1.26, R1 * 1.62, r));
        float dots = smoothstep(0.55, 1.0, cos(a2 * 36.0)) * line(r - R1 * 1.40, 0.022);
        col += uC3 * ((ln * 1.5 + spk * 0.9 + dots * 1.1) * (0.85 + 0.55 * beat)) * uM.x * outside;
      }
      // ---- AURA: a glow behind, shimmer and a rim, heat haze, wisps, the flame, the ring a kick throws out, lightning
      if (uX.z > 0.001) col += mix(uC0, uC1, 0.25) * (exp(-dOut * 2.4) * outside * uX.z * (0.40 + 0.35 * beat + 0.2 * bass));
      if (uA.x > 0.001) {
        float rim = exp(-dOut * 9.5) * outside, sh = vn(vec3(p.x * 8.0 + sin(p.y * 6.0 + t * 2.6) * 0.7, p.y * 2.6 - t * 1.5, t * 0.45));
        float hz = exp(-dOut * 2.6) * smoothstep(0.52, 0.86, sh) * smoothstep(-1.2, 0.5, p.y + 0.2) * outside;
        col += uC1 * ((rim * (0.95 + 0.9 * beat) + hz * 0.42) * uA.x);
      }
      if (uM.y > 0.001) {      // heat haze: soft light that rises off the top of the head
        float up = max(p.y + 0.20, 0.0), sh = fbm(vec3(p.x * 3.2, p.y * 1.3 - t * 1.5, t * 0.3));
        float env = exp(-max(sdHead(vec2(p.x * 1.1, p.y > -0.20 ? -0.20 + up / 2.2 : p.y)), 0.0) * 3.6) * outside * smoothstep(0.0, 0.9, p.y);
        col += mix(uC0, uC1, 0.4) * (smoothstep(0.50, 0.80, sh) * env * 0.42 * uM.y);
      }
      if (uA.y > 0.001) {
        vec2 q = p; float up = max(q.y + 0.20, 0.0), w1 = fbm(vec3(q.x * 1.4, q.y * 0.75 - t * 0.50, t * 0.14)) - 0.5; q.x += w1 * (0.40 + 0.55 * up);
        float n = fbm(vec3(q.x * 3.0, q.y * 0.85 - t * 0.85, t * 0.19)), wisp = smoothstep(0.50, 0.78, n);
        float env = exp(-max(sdHead(vec2(q.x, q.y > -0.20 ? -0.20 + up / 2.1 : q.y)), 0.0) * mix(2.6, 4.6, uN3.w)) * outside * mix(1.0, smoothstep(-0.35, 0.60, p.y), uN3.w);      // (nebula: off the top of the head only, on a dark stage)
        col += mix(uC0, uC1, wisp) * (wisp * env * uA.y * (0.62 + 0.4 * bass) * (1.0 + 0.5 * uN3.w));
      }
      float fl = 0.0;
      if (uA.z > 0.001) {
        fl = flame(p, uA.w, 0.6 + 1.5 * uB.x, t, 1.0 + 0.55 * uB.x) * (0.94 + 0.16 * bass + 0.14 * beat);
        if (uN.y > 0.001) {      // (nebula) tongues that lick up the cheeks and the temples: the outline itself burns, never the chin
          vec3 tq = vec3(p.x * 3.3, p.y * 1.05 - t * 2.6, t * 0.41); float tn = smoothstep(0.25, 0.75, 0.62 * vn(tq) + 0.38 * vn(tq * 2.3 + 4.0));
          float side = exp(-dOut * 3.6) * smoothstep(-1.30, -0.30, p.y) * outside;
          fl = max(fl, (side * (1.30 + 0.25 * beat) - (1.0 - tn) * (0.50 + 1.1 * dOut)) * uN.y);
        }
        col += ramp(fl) * uA.z * outside;
      }
      // ---- NEBULA (the owner's pick, A + C): smoke curls with glowing edges, a firestorm that stays round the head, the nebula
      if (uN.x > 0.001 && dOut < 1.9) {
        vec2 rise = vec2(0.0, -t * 0.34);
        vec2 wq = pc + 0.85 * vec2(vn(vec3(pc * 1.1 + 3.1 + rise, t * 0.09)) - 0.5, vn(vec3(pc * 1.1 - 7.7 + rise, t * 0.09)) - 0.5);
        float n = fbm(vec3(wq * 1.35 + rise * 1.3, t * 0.11)), up2 = smoothstep(-1.6, 1.2, pc.y);
        float env = exp(-dOut / (0.34 + 0.46 * uN.x) * 1.5) * outside * (0.06 + 1.05 * up2 * up2), th = 0.60 - 0.10 * uN.x;
        float dens = smoothstep(th, th + 0.24, n) * env, near = exp(-dOut * 1.5);
        float edge = smoothstep(th - 0.035, th + 0.03, n) * (1.0 - smoothstep(th + 0.03, th + 0.15, n));      // the rim of every curl
        vec3 smc = uSmokeC * vec3(1.0, 0.80, 0.66), scol = smc * (dens * (0.7 + 0.9 * up2)) + mix(uC0, uC1, 0.25) * (dens * near * near * 0.30);
        scol += mix(uC0, uC1, 0.30 + 0.55 * near) * (edge * env * (0.45 + 2.4 * near * near) * (0.85 + 0.5 * beat + 0.4 * bass) * (0.6 + 0.8 * uN.x));
        float hide = dens * 0.78; col = col * (1.0 - hide) + scol; al = max(al, hide * 0.7);
      }
      if (uN.z > 0.001) {
        // the firestorm: spiral arms of fire and smoke that turn as one body round the head and are drawn inward. An upright
        // oval (it reaches further above and below than to the sides), so it stays inside a 9:16 frame.
        // Its outer edge is torn (tongues leave it), filaments of flame ride the flow, some sides burn white-hot and others deep crimson.
        float reach = mix(0.60, mix(0.95, 1.22, step(0.0, ac.y)), ac.y * ac.y) * uN3.x * (0.62 + 0.38 * vn(vec3(ac * 2.4 + 1.0, t * 0.9 + r * 1.5)));
        if (dOut < reach && d > -0.04) {
        float rr = length(pc * vec2(1.0, 0.84)), a = ang + 2.5 * log(rr + 0.35) + t * 1.30;
        vec3 q = vec3(cos(a) * 1.55, sin(a) * 1.55, rr * 3.3 + t * 0.70);
        float w = fbm(q * vec3(1.0, 1.0, 0.6) + vec3(4.0, 1.0, t * 0.10)) - 0.5; vec3 qw = q + vec3(w * 1.1, -w * 0.9, w * 1.6); float n = fbm(qw);
        float n2 = vn(qw * vec3(2.6, 2.6, 3.4) + vec3(0.0, 0.0, t * 1.6)), n3 = vn(qw * vec3(5.5, 5.5, 7.5) + vec3(3.0, 1.0, t * 2.6));
        float fil = pow(1.0 - abs(2.0 * n2 - 1.0), 3.0), fin = pow(1.0 - abs(2.0 * n3 - 1.0), 2.0);      // filaments: the ridges of finer noise carried by the same flow
        float hot = smoothstep(0.30, 0.72, vn(vec3(cos(a - t * 0.5) * 0.9, sin(a - t * 0.5) * 0.9, rr * 0.8 + 2.0)));
        float env = smoothstep(-0.03, 0.08, d) * (1.0 - smoothstep(reach * 0.50, reach, dOut)) * sideFade, core = exp(-dOut * 5.0) * outside;
        float f = (smoothstep(0.42, 0.78, n) * (0.30 + 0.85 * fil + 0.40 * fin) * (0.50 + 0.85 * hot) + fil * fin * 0.55 * smoothstep(0.30, 0.50, n)) * env + core * 0.34 * (0.4 + 1.0 * fil);
        f = max(f - 0.09, 0.0) * 1.30;
        float sm = smoothstep(0.54, 0.34, n) * env, edge = smoothstep(0.36, 0.45, n) * (1.0 - smoothstep(0.45, 0.56, n)) * env;
        col = col * (1.0 - 0.80 * sm * uN.z) + (uSmokeC * vec3(1.0, 0.80, 0.66) * (sm * (0.6 + 0.8 * fin)) + uC0 * (edge * (0.45 + 0.6 * fil) + sm * exp(-dOut * 2.4) * 0.22) + ramp(f * (1.06 + 0.25 * beat + 0.15 * bass))) * uN.z;
        al = max(al, sm * 0.6 * uN.z);
        }
      }
      if (uN.w > 0.001) {
        // the nebula: three layers of baked gas (R lit from inside, G lit from above, B its own glow, A what it hides), each
        // turning at its own speed and lagging behind the head by its depth; stars between the layers; a pulse on the kick
        vec2 drift = (vec2(fbm(vec3(pc * 0.65, t * 0.045)), vn(vec3(pc * 0.65 + 5.0, t * 0.045))) - 0.5) * 0.20;
        vec3 gas = vec3(0.0); float cover = 0.0, sc = 2.9 * uN2.y * (1.0 - 0.025 * uN2.w), env = exp(-dOut * 0.95) * outside;
        for (int i = 0; i < 3; i++) {
          float fi = float(i), an = uN2.x * (1.0 - 0.28 * fi) + t * (i == 1 ? -0.050 : 0.034 + 0.012 * fi), ca = cos(an), sa = sin(an);
          vec2 pl = (pc + uN3.yz * (1.0 - 0.45 * fi)) * vec2(1.40, 1.0), q = (vec2(ca * pl.x - sa * pl.y, sa * pl.x + ca * pl.y) + drift * (0.6 + 0.5 * fi)) / (sc * (0.90 + 0.09 * fi));
          if (i == 1) {      // stars: behind the middle and the front gas, in front of the far clouds
            for (int ly = 0; ly < 2; ly++) {
              vec2 u = q * (ly == 0 ? 20.0 : 34.0) + 7.3, g = floor(u); float hsh = hash(vec3(g, 1.0 + float(ly))); vec2 fr = fract(u) - 0.5 - (vec2(hash(vec3(g, 2.0)), hash(vec3(g, 3.0))) - 0.5) * 0.7;
              float big = step(0.975, hsh), tw = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(t * (1.5 + 6.0 * hsh) + hsh * 40.0), 2.0), dd = dot(fr, fr);
              float star = step(0.88, hsh) * (exp(-dd * (ly == 0 ? 190.0 : 120.0)) + big * (0.012 / (abs(fr.x * fr.y) * 60.0 + 0.012)) * exp(-dd * 9.0) * 0.8) * tw;
              gas += mix(uC3, vec3(1.0, 0.96, 0.86), 0.35 + 0.65 * big) * (star * env * (1.0 - 0.6 * cover) * (ly == 0 ? 4.0 : 2.2) * (0.35 + 0.65 * hash(vec3(g, 5.0))) * (1.0 + 3.0 * big) * (0.85 + 0.6 * beat));
            }
          }
          vec4 tx = vec4(0.0), tb = vec4(0.0);      // tx = the gas itself, tb = the same gas far out of focus: the glow it stands in
          if (uN2.z > 0.5) { if (abs(q.x) < 0.998 && abs(q.y) < 0.998) { vec2 uv = vec2((fi + q.x * 0.5 + 0.5) * 0.25, 0.5 - q.y * 0.5), uc = vec2(0.75 + (q.x * 0.5 + 0.5) * 0.25, uv.y); tx = vec4(texture(uNebT, uv).rgb, texture(uNebT, uc)[i]); tb = vec4(textureLod(uNebT, uv, 4.3).rgb, tx.a); } float win = 1.0 - smoothstep(0.74, 0.97, length(q)); tx.rgb *= tx.rgb; tb.rgb *= tb.rgb; tx *= win; tb *= win; }
          else { float nn = fbm(vec3(q * 3.2 * (1.5 + fi) + fi * 9.0, t * 0.03)), m = smoothstep(0.50, 0.85, nn) * smoothstep(0.26, 0.40, length(q)) * (1.0 - smoothstep(0.55, 0.92, length(q))); tx = vec4(m, m * 0.5, m * m * m * 0.3, m * 0.5); tb = tx * 0.6; }      // (the picture is not there: gas from noise)
          float heat = exp(-dOut * 1.05);      // the gas nearer the head is hotter: crimson far out, orange and gold close in
          float rc = smoothstep(0.04, 0.85, tx.r);      // (more contrast: the thin gas goes dark, the lit sides stay)
          vec3 g = mix(uDeep * 0.95, uC0, 0.04 + 0.50 * heat * heat) * (tb.r * 0.36 + rc * 0.50) + mix(uC0, uC1, 0.5) * (rc * rc * tx.r * (0.15 + 1.0 * heat))
            + mix(uC0 * 1.1, mix(uC1, uC3, 0.4), smoothstep(0.15, 0.70, tx.g)) * ((tx.g * tx.g * 2.4 + tb.g * 0.10) * (0.02 + 1.10 * heat * heat)) + mix(uC1, uC3, 0.6) * (tx.b * 2.6 * (0.20 + heat));      // (its own glow is gold, never white: far from the head pale light reads grey)
          gas = gas * (1.0 - 0.85 * tx.a) + g * ((1.00 + 0.20 * fi) * (1.0 + 0.45 * uN2.w * (0.4 + fi * 0.3) + 0.25 * bass));
          cover = cover + tx.a * (1.0 - cover);
        }
        gas += mix(uC0, uC1, 0.5) * (exp(-dOut * 4.5) * outside * 0.16);      // the gas nearest the head takes its light
        gas *= sideFade; col = col * (1.0 - 0.6 * cover * uN.w * sideFade) + gas * uN.w; al = max(al, cover * 0.5 * uN.w * sideFade);
      }
      if (uB.z > 0.001 && uE.y < 0.5) for (int i = 0; i < 4; i++) {
        float age = uKick[i].x, s = uKick[i].y;
        if (age < 1.2 && s > 0.05) { float er = length(vec2(p.x, (p.y + 1.62) / 0.20)), x = (er - 0.30 - age * 3.0) / (0.04 + 0.08 * age); col += mix(uC1, uC2, 0.6) * (exp(-x * x) * exp(-age * 2.8) * s * uB.z * 1.5); }
      }
      // ---- SMOKE: dark billows that curl round the head, lit on the side that faces it; it turns (a vortex of fire and
      // smoke), then the smoke goes and what is left is dust of gold
      if (uS.x > 0.001) {
        float tw = uS.z * (t * 1.15 / (0.55 + r * 0.55)), ct = cos(tw), st = sin(tw); vec2 qv = vec2(ct * pc.x - st * pc.y, st * pc.x + ct * pc.y);
        vec2 rise = vec2(0.0, -t * 0.30 * (1.0 - 0.8 * uS.z));
        vec2 wq = qv + 0.80 * vec2(fbm(vec3(qv * 0.85 + 3.1 + rise, t * 0.085)) - 0.5, fbm(vec3(qv * 0.85 - 7.7 + rise, t * 0.085)) - 0.5);
        float n = fbm(vec3(wq * 1.2 + rise * 1.3, t * 0.10)), ext = 0.50 + 0.70 * uS.x + 0.30 * uS.z;
        float up2 = smoothstep(-1.8, 1.5, pc.y), env = exp(-dOut / ext * 1.35) * outside;
        float raw = smoothstep(0.47 - 0.22 * uS.x, 0.80, n) * env * mix(0.45 + 0.70 * up2, 1.0, uS.z), dens = clamp(raw * (1.0 + 1.3 * uS.x), 0.0, 1.0);
        vec2 toHead = normalize(pc + 1e-3) * 0.20; float c2 = cos(tw), s2 = sin(tw); toHead = vec2(c2 * toHead.x - s2 * toHead.y, s2 * toHead.x + c2 * toHead.y);
        float nIn = fbm(vec3((wq - toHead) * 1.2 + rise * 1.3, t * 0.10));
        float facing = smoothstep(-0.02, 0.16, n - nIn), near = exp(-dOut * (1.5 - 0.5 * uS.y)), body = 1.0 - 0.92 * uS.w;
        vec3 scol = uSmokeC * (dens * (0.50 + 0.9 * up2) * body);                                                    // its own grey, a little light from above
        scol += mix(uC0, uC1, 0.35 + 0.4 * near) * (dens * facing * near * (0.22 + 1.05 * uS.y) * (0.75 + 0.5 * bass + 0.5 * beat) * body);      // the side that faces the head glows
        scol += uC0 * (dens * near * near * 0.30 * uS.y * body);
        if (uS.z > 0.001) scol += ramp(smoothstep(0.52, 0.90, nIn) * 1.15 * exp(-dOut * 1.3)) * (0.9 * uS.z * outside * (0.7 + 0.5 * beat) * body);      // the firestorm: arms of fire in the turning smoke
        float hide = dens * 0.90 * body;
        scol += ramp(fl) * uA.z * (dens * 0.12);
        col = col * (1.0 - hide) + scol; al = max(al, hide);
        if (uS.w > 0.001) {
          for (int ly = 0; ly < 2; ly++) {
            vec2 u = (wq + rise * 0.6) * (ly == 0 ? 22.0 : 41.0), g = floor(u); float hsh = hash(vec3(g, 1.0 + float(ly))); vec2 f = fract(u) - 0.5 - (vec2(hash(vec3(g, 2.0)), hash(vec3(g, 3.0))) - 0.5) * 0.7;
            float star = step(0.62, hsh) * exp(-dot(f, f) * (ly == 0 ? 60.0 : 40.0)) * (0.30 + 0.70 * pow(0.5 + 0.5 * sin(t * (2.0 + 7.0 * hsh) + hsh * 40.0), 2.0));
            col += mix(uC3, vec3(1.0, 0.95, 0.8), hsh * hsh) * (star * (raw * 7.0 + 0.22 * env) * uS.w * (0.8 + 0.7 * beat) * (ly == 0 ? 1.6 : 0.9));
          }
        }
      }
      if (uM.z > 0.001) {      // what the smoke becomes at MYTHIC: a thin nebula round the head
        vec2 wq = pc + 0.8 * vec2(fbm(vec3(pc * 0.8 + 3.1, t * 0.05)) - 0.5, fbm(vec3(pc * 0.8 - 7.7, t * 0.05)) - 0.5); float n = fbm(vec3(wq * 1.1, t * 0.04));
        col += (uC0 * 0.30 + uC1 * (0.30 * n)) * (smoothstep(0.46, 0.86, n) * exp(-dOut * 0.9) * outside * 0.55 * uM.z);
      }
      if (uB.y > 0.001) for (int i = 0; i < 5; i++) {
        float fi = float(i), ph = t * 5.5 + fi * 3.7, seed = floor(ph), life = fract(ph);
        if (hash(vec3(seed, fi, 1.0)) < 0.42) continue;
        float a0 = hash(vec3(seed, fi, 2.0)) * 6.2832, jag = (vn(vec3(dOut * 4.5, seed, fi)) - 0.5) * 0.60 + (vn(vec3(dOut * 15.0, seed, fi + 7.0)) - 0.5) * 0.17;
        float da = abs(mod(ang - a0 - jag + 3.14159, 6.2832) - 3.14159) * r, len = 1.0 + 1.4 * hash(vec3(seed, fi, 3.0));
        col += mix(uC3, vec3(1.0, 0.98, 0.92), 0.75) * ((0.020 / (da + 0.008)) * outside * (1.0 - smoothstep(len * 0.55, len, dOut)) * (1.0 - life) * (1.0 - life) * uB.y * 1.3);
      }
    } else {
      // ---- IN FRONT: the pulse that leaves the face when a rank locks in, a thin veil of smoke, the sweep over a face
      // that has no hype material of its own (Quantum Flow)
      if (uX.x >= 0.0 && uX.x < 1.3) { float rr = 0.55 + uX.x * 5.0, x = (r - rr) / (0.045 + 0.10 * uX.x); col += mix(uC2, vec3(1.0, 0.97, 0.9), 0.55) * (exp(-x * x) * exp(-uX.x * 3.3) * 1.9); }
      if (uX.y >= 0.0) { float f = uX.y * 1.30 - 0.15, dist = uX.w > 0.5 ? (1.05 - p.y) / 2.5 : r / 1.55; dist += (vn(vec3(p * 3.0, 3.0)) - 0.5) * 0.12; float x = (dist - f) / 0.07;
        col += mix(uC1, vec3(1.0, 0.97, 0.9), 0.6) * (exp(-x * x) * (1.0 - smoothstep(-0.05, 0.10, d)) * smoothstep(0.0, 0.08, uX.y) * (1.0 - smoothstep(0.92, 1.0, uX.y)) * 1.8); }
      if (uS.x > 0.001) {
        vec2 rise = vec2(0.0, -t * 0.42); float n = fbm(vec3(pc * 1.5 + rise + 11.0, t * 0.13));
        float dens = smoothstep(0.60, 0.92, n) * exp(-abs(d) * 2.6) * uS.x * 0.50 * (1.0 - 0.8 * uS.w);
        col += uSmokeC * dens * 0.9 + uC0 * (dens * 0.12 * uS.y); al = dens * 0.50;
      }
    }
    o = vec4(col, clamp(al, 0.0, 0.94)) * uVis;
  }`;
  const PTS_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec4 aCol; uniform mat4 uViewProj; uniform float uPx; out vec3 vCol;
  void main() { vec4 c = uViewProj * vec4(aPos, 1.0); gl_Position = c; gl_PointSize = max(aCol.a * uPx / c.w, 1.5); vCol = aCol.rgb; }`;
  const PTS_FS = `#version 300 es
  precision highp float; in vec3 vCol; out vec4 o;
  void main() { float d = length(gl_PointCoord - 0.5) * 2.0; o = vec4(vCol * (exp(-d * d * 3.2) * (1.0 - smoothstep(0.75, 1.0, d))), 1.0); }`;
  // a ribbon of light (an orbit ring): u along it, v across it; w = how much it burns
  const RIB_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec2 aUv; in vec4 aCol; uniform mat4 uViewProj; out vec2 vUv; out vec4 vCol;
  void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vUv = aUv; vCol = aCol; }`;
  const RIB_FS = `#version 300 es
  precision highp float; in vec2 vUv; in vec4 vCol; out vec4 o; uniform float uTime;
  ${NOISE}
  void main() {
    float v = vUv.y, n = vn(vec3(vUv.x * 46.0 - uTime * 2.4, v * 1.6 + uTime * 1.1, uTime * 0.6)), n2 = vn(vec3(vUv.x * 120.0 + uTime * 3.0, v * 3.0, 4.0));
    float thin = exp(-v * v * 58.0), glow = exp(-v * v * 5.0);
    float burn = smoothstep(0.30, 0.85, n * (1.25 - abs(v))) * (1.0 - abs(v));
    float k = mix(thin * 1.7 + glow * 0.30, thin * 2.6 + glow * 0.40 + burn * 1.5 * (0.6 + 0.8 * n2), vCol.a);
    o = vec4(mix(vCol.rgb, vec3(1.0, 0.95, 0.85), thin * 0.55 * (0.4 + 0.6 * vCol.a)) * k, 1.0);
  }`;
  // something solid in the orbit (a crystal): flat faces, lit
  const SOL_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec4 aCol; uniform mat4 uViewProj; out vec3 vCol;
  void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vCol = aCol.rgb; }`;
  const SOL_FS = `#version 300 es
  precision highp float; in vec3 vCol; out vec4 o; void main() { o = vec4(vCol, 1.0); }`;
  // a gifter: the picture in a disc, in a ring that says how big the gift was (aTier: 0 chrome, 1 crimson, 2 gold, 3 gold that burns)
  const AVA_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec4 aQuad; in vec4 aInfo; uniform mat4 uViewProj; uniform vec2 uScale; out vec2 vQ; out vec4 vInfo; out float vSlot;
  void main() { vec4 c = uViewProj * vec4(aPos, 1.0); c.xy += aQuad.xy * aQuad.z * uScale; gl_Position = c; vQ = aQuad.xy; vSlot = aQuad.w; vInfo = aInfo; }`;
  const AVA_FS = `#version 300 es
  precision highp float; in vec2 vQ; in vec4 vInfo; in float vSlot; out vec4 o; uniform sampler2D uAtlas; uniform float uTime; uniform vec3 uGold, uHot;
  ${NOISE}
  void main() {
    // vInfo = (tier, light 0..1.5, sun 0..1 (MYTHIC), alpha)
    vec2 q = vQ * 1.9; float r = length(q), tier = vInfo.x, a = vInfo.w, ang = atan(q.y, q.x);
    vec3 pic = pow(texture(uAtlas, vec2((vSlot + clamp(q.x * 0.5 + 0.5, 0.0, 1.0)) / 8.0, clamp(0.5 - q.y * 0.5, 0.0, 1.0))).rgb, vec3(2.2));
    float disc = 1.0 - smoothstep(0.97, 1.0, r);
    float w = tier < 0.5 ? 0.07 : tier < 1.5 ? 0.10 : tier < 2.5 ? 0.14 : 0.17, ring = smoothstep(0.98, 1.0, r) * (1.0 - smoothstep(1.0 + w, 1.0 + w + 0.03, r));
    vec3 rc = tier < 0.5 ? vec3(0.80, 0.80, 0.84) : tier < 1.5 ? vec3(1.0, 0.07, 0.05) * 1.7 : uGold * 1.9;
    float sweep = 0.55 + 0.45 * pow(0.5 + 0.5 * cos(ang * (tier < 0.5 ? 1.0 : 2.0) - uTime * 2.2), 3.0); rc *= (tier < 0.5 ? 0.45 + 1.0 * sweep : 0.75 + 0.9 * sweep) * (0.7 + 0.5 * vInfo.y);
    float glowW = tier < 0.5 ? 0.0 : tier < 1.5 ? 0.35 : 0.6, glow = exp(-max(r - 1.0 - w, 0.0) * (tier > 2.5 ? 3.2 : 5.0)) * step(1.0, r) * glowW;
    float burn = 0.0;
    if (tier > 2.5) { float n = fbm(vec3(cos(ang) * 2.4, sin(ang) * 2.4 + uTime * 0.5, r * 2.6 - uTime * 2.6)); burn = smoothstep(0.42, 0.85, n * (2.05 - r)) * step(1.0 + w * 0.5, r) * (1.0 - smoothstep(1.25, 1.85, r)); }
    vec3 sun = mix(uGold, vec3(1.0, 0.95, 0.8), 0.5);
    vec3 col = pic * (0.80 + 0.35 * vInfo.y) * disc * (1.0 - 0.55 * vInfo.z) + sun * (vInfo.z * disc * (0.9 + 1.6 * (1.0 - r * r)));
    float fade = 1.0 - smoothstep(1.35, 1.85, r);
    col = mix(col, rc, ring) + (rc * glow * 0.6 + mix(uHot, vec3(1.0, 0.9, 0.6), burn) * burn * 2.4 + sun * (vInfo.z * exp(-max(r - 1.0, 0.0) * 3.0) * step(1.0, r) * 1.2)) * fade;
    float alpha = max(disc, ring);
    o = vec4(col * a, alpha * a);
  }`;

  function create({ seed = 11 } = {}) {
    let rs = seed * 9301 + 49297;
    const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
    const st = {
      style: 'classic', tone: 'classic', solo: false, t: 0,
      rank: -1, from: -1, to: -1, t0: -99, lockAt: -99, moving: false, p: -1, antic: 0, rl: -1, beatWas: 0, kickAt: -99,
      curA: [0, 0, 0, 0], curA2: [0, 0, 0, 0], fromA: [0, 0, 0, 0], fromA2: [0, 0, 0, 0], around: around('classic', 0),
      gifters: [], gid: 0, songTop: null, names: [], atlasDirty: true, counts: { points: 0, ribbon: 0, solid: 0, pictures: 0 },
    };
    const U = { a: [0, 0, 0, 0], b: [0, 0, 0, 0], a2: [0, 0, 0, 0], b2: [0, 0, 0, 0], w: [-1, 0, 0, 0], p: [0, 0, 0, 0], c: [1, 0.5, 0.1], c2: [1, 0.7, 0.22] };
    function setStyle(name) { if (!STYLES.includes(name)) return false; if (st.failed && name !== 'classic') return false; if (name !== st.style) { st.style = name; st.moving = false; st.p = -1; if (name === 'nebula') nebLoad(); const f = face(name, st.to); st.curA = f.a; st.curA2 = f.a2; } return true; }
    /** the baked nebula (one picture, four tiles side by side: three layers of gas and their covers): asked for the first time the style is chosen; until it is there (or where there is no page) the gas is drawn from noise */
    function nebLoad() {
      if (st.nebAsked || !root.Image || !root.document) return; st.nebAsked = true;
      try { const im = new root.Image(); const ok = () => { st.nebImg = im; }; im.onload = () => { if (typeof im.decode === 'function') im.decode().then(ok, ok); else ok(); }; /* decoded BEFORE it is handed to the card: no hitch on the frame it arrives */ im.onerror = () => { st.nebFailed = true; }; im.src = HERE + 'nebula.webp'; } catch (e) { st.nebFailed = true; }
    }
    function setTone(name, solo) { st.tone = TONES[name] ? name : 'classic'; st.solo = !!solo; }
    /** the rank arrives (LIVE Link's 0..5, -1 = none). A higher one starts the transformation; a lower one glides down. */
    function setRank(r, t) {
      r = Math.max(-1, Math.min(5, Math.round(r)));
      if (r === st.to) return;
      if (r > st.to && st.style !== 'classic') { st.fromA = st.curA.slice(); st.fromA2 = st.curA2.slice(); st.from = st.to; st.to = r; st.t0 = t; st.moving = true; st.lockAt = -99; st.locked = false; }
      else { st.from = st.to = r; st.moving = false; }
      st.rank = r;
    }
    /** a gift: the viewer's picture joins the orbit. coins = the gift's size. The same viewer again = their ring grows and they stay longer. */
    function gifter(viewer, coins, t) {
      if (!viewer) return false; coins = Math.max(1, Number(coins) || 1);
      const id = viewer.id || viewer.name || '?'; let g = st.gifters.find((x) => x.id === id && !x.leaving);
      if (g) { g.coins += coins; g.until = Math.max(g.until, t) + stay(coins) * 0.6; g.bump = t; g.nameAt = t; }
      else {
        const live = st.gifters.filter((x) => !x.leaving); if (live.length >= 7) { live.sort((a, b) => a.t0 - b.t0); const out = live.find((x) => x !== top()) || live[0]; out.leaving = true; out.leaveAt = t; }
        const used = new Set(st.gifters.map((x) => x.slot)); let slot = 0; while (used.has(slot) && slot < 8) slot++; if (slot >= 8) { const dead = st.gifters.find((x) => x.leaving); slot = dead ? dead.slot : 0; st.gifters = st.gifters.filter((x) => x.slot !== slot); }
        g = { id, name: String(viewer.name || id).slice(0, 18), viewer, coins, t0: t, until: t + stay(coins), slot, n: st.gid++, ph: rnd() * 6.2832, bump: t, nameAt: t, leaving: false, leaveAt: 0, drawn: null };
        st.gifters.push(g); st.atlasDirty = true;
      }
      return true;
    }
    const stay = (coins) => Math.min(45, 12 + 7 * Math.log10(coins + 1));
    const tierOf = (coins) => (coins >= 1000 ? 3 : coins >= 100 ? 2 : coins >= 10 ? 1 : 0);
    const top = () => { let b = null; for (const g of st.gifters) if (!g.leaving && (!b || g.coins > b.coins)) b = g; return b; };
    function songStart() { for (const g of st.gifters) if (!g.leaving) g.until = Math.min(g.until, st.t + 4); }

    /** once a frame, before the face is drawn: where the transformation is, the face's numbers, what the stage must give way to */
    function pre(t, dt, { audio, fire, own, viz = 0 }) {
      st.t = t; st.dt = dt; st.faceK = 1 - ss(0, 0.8, viz);      // (the Visualizer: the face is not there, so nothing round it may be)
      const A = audio || { beat: 0, bass: 0.3, level: 0.4 }, kick = A.beat > 0.55 && st.beatWas <= 0.55; st.beatWas = A.beat; if (kick) st.kickAt = t;
      const on = st.style !== 'classic' && !st.failed;
      let lockNow = false;
      if (st.moving) {
        const u = t - st.t0;
        if (!st.locked) {
          // the front crosses most of the face, then holds its breath for a kick (never longer than 0.45 s)
          const k = clamp((u - 0.14) / 0.66), e = k * k * (3 - 2 * k); st.p = 0.84 * e; st.antic = ss(0, 0.20, u);
          if (u >= 0.80 && ((kick && u >= 0.80) || t - st.kickAt < 0.06 || u >= 1.25)) { st.locked = true; st.lockAt = t; lockNow = true; }
        } else { const v = clamp((t - st.lockAt) / 0.16); st.p = 0.84 + 0.16 * v; st.antic = 1 - v; if (v >= 1) { st.moving = false; st.p = -1; st.antic = 0; } }
      } else { st.p = -1; st.antic = 0; }
      // the level of what is round the head: the old rank until the lock, then the new one (fast); a rank that falls glides down
      const want = st.moving && !st.locked ? st.from : st.to;
      st.rl += (want - st.rl) * (1 - Math.exp(-dt * (want > st.rl ? 11 : 1.6)));
      if (Math.abs(want - st.rl) < 0.002) st.rl = want;
      const arTo = around(st.style, st.to + 1), ar = around(st.style, st.rl + 1);
      // what the NEW rank brings is already on its way in while the front crosses the face (it lands at the lock)
      st.incoming = st.moving && !st.locked ? clamp(st.p / 0.84) : st.moving ? 1 : 0; st.arTo = arTo;
      st.around = ar;
      const tgt = face(st.style, st.to);
      if (st.moving) { U.a = st.fromA; U.a2 = st.fromA2; U.b = tgt.a; U.b2 = tgt.a2; if (st.p >= 0.999) { st.curA = tgt.a; st.curA2 = tgt.a2; } }
      else { const k = 1 - Math.exp(-dt * 2.2); for (let i = 0; i < 4; i++) { st.curA[i] += (tgt.a[i] - st.curA[i]) * k; st.curA2[i] += (tgt.a2[i] - st.curA2[i]) * k; } U.a = U.b = st.curA; U.a2 = U.b2 = st.curA2; }
      const since = t - st.lockAt, popE = since >= 0 && since < 1.4 ? Math.exp(-since * 3.4) : 0;
      st.pop = popE; st.since = since;
      const T = TONES[st.tone], f = own || fire || T.mid;
      // shards: they float apart with the bass and come together on a kick
      const kAge = t - st.kickAt, open = 0.62 + 0.30 * Math.sin(t * 1.3) * 0.5 + 0.25 * (A.bass || 0) - 0.55 * Math.exp(-kAge * 5.5) + 0.9 * popE;
      U.w = [on && st.moving ? st.p : -1, WAVE[st.style] === 2 && st.to === 3 ? 6 : waveOf(st.style, st.to), on ? 0.20 : 0, on && !st.solo ? 1 : 0];
      U.p = [clamp(open, 0.05, 1.6), -0.20 + 1.10 * Math.sin(t * 0.85), st.antic, 0];
      U.c = st.tone === 'classic' ? lerp3(f, T.mid, 0.25) : T.mid; U.c2 = st.style === 'nebula' && st.tone === 'classic' ? NEB_GOLD : T.gold;
      return {
        on, lockNow, rank: st.to, face: U,
        // what the V8 stage does differently while a new style is on
        embers: ar.embers, gold: st.solo ? 0 : clamp((face(st.style, Math.round(st.rl)).a2[0]) * 0.55), zoom: lerp(1, gifterZoom(t) * ar.zoom, st.faceK), push: (ar.push + 0.05 * popE - 0.025 * st.antic) * st.faceK, pulse: 0.9 * popE * st.faceK, kick: lockNow ? 0.9 * st.faceK : 0,      // (in the Visualizer: no step back, no push, no pulse, no kick)
      };
    }
    const gifterZoom = (t) => { if (st.failed) return 1; let k = 0; for (const g of st.gifters) k = Math.max(k, g.leaving ? 1 - clamp((t - g.leaveAt) / 1.2) : ss(0, 0.8, t - g.t0)); st.gz = (st.gz === undefined ? k : st.gz + (k - st.gz) * 0.08); return 1 - 0.15 * st.gz; };

    // ---------------------------------------------------------------- GL
    let GLS = null;
    const MAXP = 9000, ptD = new Float32Array(MAXP * 7), ptF = new Float32Array(3000 * 7), MAXR = 6000, rbD = new Float32Array(MAXR * 9), MAXT = 1200, soD = new Float32Array(MAXT * 7), avD = new Float32Array(8 * 6 * 11);
    let nP = 0, nF = 0, nR = 0, nT = 0, nA = 0; const strips = [];
    /** a point of light that the face can hide (depth-tested) / one that is always in front */
    let PV = 1;      // how much of the looks' points, ribbons and pictures is shown: 1 = the face is there, 0 = the Visualizer (they fade with it)
    const put = (x, y, z, r, g, b, sz) => { if (nP >= MAXP || PV <= 0.003) return; const o = nP * 7; ptD[o] = x; ptD[o + 1] = y; ptD[o + 2] = z; ptD[o + 3] = r * PV; ptD[o + 4] = g * PV; ptD[o + 5] = b * PV; ptD[o + 6] = sz; nP++; };
    function glInit(G) {
      const gl = G.gl, pAura = G.program(AURA_VS, AURA_FS), pPts = G.program(PTS_VS, PTS_FS), pRib = G.program(RIB_VS, RIB_FS), pSol = G.program(SOL_VS, SOL_FS), pAva = G.program(AVA_VS, AVA_FS);
      const ptBuf = G.buffer(ptD, true), rbBuf = G.buffer(rbD, true), soBuf = G.buffer(soD, true), avBuf = G.buffer(avD, true);
      const ptVao = gl.createVertexArray(); gl.bindVertexArray(ptVao); G.attrib(pPts, 'aPos', ptBuf, 3, { stride: 28, offset: 0 }); G.attrib(pPts, 'aCol', ptBuf, 4, { stride: 28, offset: 12 });
      const rbVao = gl.createVertexArray(); gl.bindVertexArray(rbVao); G.attrib(pRib, 'aPos', rbBuf, 3, { stride: 36, offset: 0 }); G.attrib(pRib, 'aUv', rbBuf, 2, { stride: 36, offset: 12 }); G.attrib(pRib, 'aCol', rbBuf, 4, { stride: 36, offset: 20 });
      const soVao = gl.createVertexArray(); gl.bindVertexArray(soVao); G.attrib(pSol, 'aPos', soBuf, 3, { stride: 28, offset: 0 }); G.attrib(pSol, 'aCol', soBuf, 4, { stride: 28, offset: 12 });
      const avVao = gl.createVertexArray(); gl.bindVertexArray(avVao); G.attrib(pAva, 'aPos', avBuf, 3, { stride: 44, offset: 0 }); G.attrib(pAva, 'aQuad', avBuf, 4, { stride: 44, offset: 12 }); G.attrib(pAva, 'aInfo', avBuf, 4, { stride: 44, offset: 28 });
      const triVao = gl.createVertexArray();
      gl.bindVertexArray(null);
      const atlas = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, atlas); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const doc = root.document, cv = doc ? Object.assign(doc.createElement('canvas'), { width: 1024, height: 128 }) : null;
      st.atlasDirty = true;
      const nebTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, nebTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { nebTex, nebReady: false, G, gl, pAura, pPts, pRib, pSol, pAva, ptBuf, rbBuf, soBuf, avBuf, ptVao, rbVao, soVao, avVao, triVao, atlas, cv };
    }
    /** a placeholder picture (a letter on a coloured disc): what is drawn when a viewer's own picture is not there */
    function placeholder(x, name, ox) {
      const key = String(name || '?'); let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      const hue = [18, 32, 44, 350, 8, 200, 150, 280, 60, 320][h % 10], hue2 = (hue + 40 + (h >> 4) % 60) % 360;
      const g = x.createLinearGradient(ox, 0, ox + 128, 128); g.addColorStop(0, 'hsl(' + hue + ',78%,56%)'); g.addColorStop(1, 'hsl(' + hue2 + ',70%,26%)');
      x.fillStyle = g; x.fillRect(ox, 0, 128, 128);
      x.fillStyle = 'rgba(255,255,255,0.95)'; x.font = '700 66px Bahnschrift, "Segoe UI", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(key.replace(/^@/, '').charAt(0).toUpperCase() || '?', ox + 64, 70);
    }
    function atlasUpdate() {
      const S = GLS, x = S.cv ? S.cv.getContext('2d') : null; if (!x) return;
      for (const g of st.gifters) {
        const pic = g.viewer && g.viewer.avatar && typeof g.viewer.avatar === 'object' ? g.viewer.avatar : null, ready = pic && (pic.complete === undefined || (pic.complete && pic.naturalWidth > 0));
        const want = ready ? pic : 'ph'; if (g.drawn === want) continue; g.drawn = want;
        const ox = g.slot * 128; x.clearRect(ox, 0, 128, 128);
        let ok = false; if (ready) { try { const w = pic.naturalWidth || pic.width, h = pic.naturalHeight || pic.height, m = Math.min(w, h); x.drawImage(pic, (w - m) / 2, (h - m) / 2, m, m, ox, 0, 128, 128); ok = true; } catch (e) { ok = false; } }
        if (!ok) placeholder(x, g.name, ox);
      }
      const gl = S.gl; gl.bindTexture(gl.TEXTURE_2D, S.atlas);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, S.cv); } catch (e) { /* a picture from another site that taints the canvas: the placeholders go back in */ for (const g of st.gifters) { g.viewer = { name: g.name }; g.drawn = null; } }
    }

    /** drawn by the V8 stage, after the face, into the same HDR scene. X = the stage's own helpers (sparks, the fire's colour ...) */
    function render(c, X) {
      const { G, gl, vp, model: mdl, time: t, audio: A } = c;
      // a card that will not take these shaders (another host's PC): caught ONCE, the looks are off for good and the stage goes
      // back to its own ladder (mask-v8.js reads st.failed); the Mask itself keeps drawing
      if (st.failed) return;
      if (!GLS || GLS.G !== G) { try { GLS = glInit(G); } catch (e) { st.failed = String((e && e.message) || e).slice(0, 200); st.style = 'classic'; st.moving = false; st.p = -1; GLS = null; return; } }
      const S = GLS, ar = st.around, T = TONES[st.tone], on = st.style !== 'classic';
      const ps = c.ps || 1, sc = c.sc || 1, beat = A.beat || 0, bass = A.bass || 0;
      const tw = (p) => [mdl[0] * p[0] + mdl[4] * p[1] + mdl[8] * p[2] + mdl[12], mdl[1] * p[0] + mdl[5] * p[1] + mdl[9] * p[2] + mdl[13], mdl[2] * p[0] + mdl[6] * p[1] + mdl[10] * p[2] + mdl[14]];
      const clipOf = (p) => { const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; return [(vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w, (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w, w]; };
      nP = 0; nF = 0; nR = 0; nT = 0; nA = 0; strips.length = 0; st.names.length = 0; PV = st.faceK === undefined ? 1 : st.faceK;
      const aspect = G.W / G.H, gold = ar.gold, fire = st.tone === 'classic' ? (X.fire || T.mid) : T.mid;
      // the colours: deep / mid / hot; LEGENDARY turns the three to gold
      const C0 = lerp3(st.tone === 'classic' && X.own ? mul3(X.own, 0.8) : T.deep, st.tone === 'classic' ? [1.0, 0.26, 0.03] : [0.85, 0.20, 0.55], gold * 0.9), C1 = lerp3(st.tone === 'classic' ? lerp3(fire, T.mid, 0.4) : T.mid, [1.0, 0.58, 0.11], gold), C2 = lerp3(T.hot, [1.0, 0.84, 0.46], gold), C3 = T.gold;
      const kickA = t - st.kickAt, kickE = Math.exp(-Math.max(0, kickA) * 6);
      const inc = st.incoming || 0, AT = st.arTo || ar;
      /** how much of a part is there: what the level has, or what is flying in for the rank being taken (k = 0..1, s = its size while it lands) */
      const part = (name) => { const have = ar[name], comes = Math.max(0, AT[name] - have) * inc; return { k: Math.max(have, comes), s: have >= comes ? 1 + 0.10 * st.pop : 1 + 1.5 * Math.pow(1 - inc, 2.2) }; };

      // ---- where the head is in the picture (for the aura): its middle, a unit of it, its roll
      const hc = clipOf(tw([0, -0.20, 0])), hx1 = clipOf(tw([1, -0.20, 0])), hy1 = clipOf(tw([0, 0.80, 0]));
      const unit = Math.hypot((hx1[0] - hc[0]) * aspect, hx1[1] - hc[1]), roll = Math.atan2((hy1[0] - hc[0]) * aspect, hy1[1] - hc[1]);
      const big = st.solo ? 1.34 : 1, head = [hc[0] * aspect, hc[1] + (st.solo ? 0.30 * unit : 0), unit * big, -roll];
      const vis = st.faceK === undefined ? 1 : st.faceK, nb = part('neb');
      const auraOn = on && vis > 0.003 && (ar.shimmer + ar.wisps + ar.flame + ar.smoke + ar.rays + ar.floor + ar.mandala + ar.haze + ar.nebula + ar.back + ar.lightning + ar.spots + ar.pyro + ar.lit + ar.storm + nb.k > 0.003);
      const sweepP = st.solo && st.moving ? st.p : -1;
      const frontOn = on && vis > 0.003 && ((st.since >= 0 && st.since < 1.3) || ar.smoke > 0.003 || sweepP >= 0);
      // the breath of a transformation: drawn in toward the face while the front crosses it, thrown out at the lock
      const breath = breathes(st.style, st.to) ? 0.75 * Math.sin(Math.PI * 0.5 * (st.antic || 0)) * (st.moving && !st.locked ? clamp(st.p / 0.84 + 0.25) : st.antic) - 0.5 * st.pop * (st.style === 'nebula' ? Math.cos(Math.max(0, st.since) * 7.5) : 1) : 0.28 * (st.moving && !st.locked ? st.antic : 0) - 0.22 * st.pop;
      const auraU = (layer) => {
        S.pAura.use().u('uHead', head).u('uAspect', aspect).u('uTime', t).u('uLayer', layer).u('uFloorY', -0.50).u('uAud', [bass, beat, A.level || 0, A.high || 0])
          .uv('uKick', 2, kicksU(c.kicks)).u('uC0', C0).u('uC1', C1).u('uC2', C2).u('uC3', C3).u('uSmokeC', T.smoke)
          .u('uA', [ar.shimmer, ar.wisps, ar.flame, ar.flameH + 0.25 * st.pop]).u('uB', [ar.column, ar.lightning, ar.shock, gold]).u('uS', [ar.smoke, ar.inner, ar.vortex, ar.dust]).u('uE', [ar.rays * (1 + 0.6 * st.pop), ar.floor, ar.pyro, ar.spots])
          .u('uM', [part('mandala').k, ar.haze, ar.nebula, breath]).u('uX', [st.since >= 0 && st.since < 1.3 ? st.since : -1, sweepP, ar.back + 0.5 * st.pop, WAVE[st.style] === 1 ? 1 : 0]).u('uZ', layer ? 0 : 0.99995)
          .u('uDeep', T.deep).u('uVis', vis).ui('uNebT', 0).u('uN', [ar.lit, ar.tongues, ar.storm, nb.k]).u('uN2', [nebSpin, 1 + 0.30 * (nb.s - 1), S.nebReady ? 1 : 0, kickE]).u('uN3', [stormReach, par[0], par[1], st.style === 'nebula' ? 1 : 0]);
      };
      // (nebula) the picture, once it has arrived; how the gas arrives (it winds in from wide while the face breathes in, then settles
      // with a small swing); the storm is breathed OUT at the lock (it opens from the outline, overshoots, settles); the layers lag
      // behind the head when it moves (depth)
      if (st.nebImg && !S.nebReady) { try { gl.bindTexture(gl.TEXTURE_2D, S.nebTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, st.nebImg); gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); S.nebReady = true; } catch (e) { st.nebImg = null; st.nebFailed = true; } }
      const sinceL = st.since >= 0 && st.since < 3 ? st.since : 9, nebSpin = (st.moving && !st.locked ? 2.4 * Math.pow(1 - inc, 2) : 0) + 0.30 * Math.exp(-sinceL * 2.6) * Math.sin(sinceL * 6.5);
      const stormReach = 1 - 0.62 * Math.exp(-sinceL * 4.2) * Math.cos(sinceL * 7.0) + 0.06 * kickE;
      if (!st.lag) st.lag = [head[0], head[1]]; { const kL = 1 - Math.exp(-(st.dt || 1 / 30) * 2.2); st.lag[0] += (head[0] - st.lag[0]) * kL; st.lag[1] += (head[1] - st.lag[1]) * kL; }
      const par = [clamp((st.lag[0] - head[0]) / head[2], -0.5, 0.5) * 0.9, clamp((st.lag[1] - head[1]) / head[2], -0.5, 0.5) * 0.9];
      gl.bindVertexArray(S.triVao);
      if (auraOn) { G.bindTex(0, S.nebTex); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); auraU(0); gl.drawArrays(gl.TRIANGLES, 0, 3); }

      // ---- ORBITS (real 3D, in the head's own space: they turn and tilt with him)
      const O = [0, -0.45, 0.15];
      /** a point on a ring: radius R, the ring's plane tipped by tx (round x: + = the front dips) and rolled by tz, at angle a (0 = picture right, 90 deg = toward the lens) */
      const onRing = (R, tx, tz, a, yAdd = 0) => { const x = Math.cos(a) * R, z0 = Math.sin(a) * R, y = -z0 * Math.sin(tx) + yAdd, z = z0 * Math.cos(tx), cz = Math.cos(tz), sz = Math.sin(tz); return [O[0] + x * cz - y * sz, O[1] + x * sz + y * cz, O[2] + z]; };
      const camL = (() => { // the camera in the head's space is not needed exactly: the ribbons face the lens (z)
        return [0, 0, 1]; })();
      /** a ring as a ribbon that faces the lens: col, width (head units), burn 0..1, a brighter packet running round it on each kick */
      const ribbon = (R, tx, tz, col, width, burn, k, { yAdd = 0, spin = 0, seg = 120, dash = 0 } = {}) => {
        k *= PV; if (k < 0.01 || nR + (seg + 1) * 2 > MAXR) return;
        const first = nR; let prev = onRing(R, tx, tz, -1e-3 + spin, yAdd);
        for (let i = 0; i <= seg; i++) {
          const a = i / seg * 6.2832 + spin, p = onRing(R, tx, tz, a, yAdd), nx = onRing(R, tx, tz, a + 0.02, yAdd);
          let dx = nx[0] - prev[0], dy = nx[1] - prev[1]; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl; prev = p;
          // across = perpendicular to the ring's direction in the picture; where the ring runs straight at the lens it keeps its width
          const ox = -dy * width, oy = dx * width, back = p[2] < O[2] ? 0.55 : 1;
          let pk = 0; for (let q = 0; q < 2; q++) { const kk = (c.kicks || [])[q]; if (kk && kk[0] < 1.6) { let da = (a - spin - kk[0] * 4.2 - q * 2.1) % 6.2832; if (da > 3.1416) da -= 6.2832; if (da < -3.1416) da += 6.2832; pk += kk[1] * Math.exp(-da * da * 18) * Math.exp(-kk[0] * 1.6); } }
          const dsh = dash ? (Math.sin(a * dash) > 0 ? 1 : 0.25) : 1, br = k * back * (1 + 2.2 * pk) * dsh;
          for (const sd of [-1, 1]) { const w = tw([p[0] + ox * sd, p[1] + oy * sd, p[2]]), o = nR * 9; rbD[o] = w[0]; rbD[o + 1] = w[1]; rbD[o + 2] = w[2]; rbD[o + 3] = i / seg * (R * 2.2); rbD[o + 4] = sd; rbD[o + 5] = col[0] * br; rbD[o + 6] = col[1] * br; rbD[o + 7] = col[2] * br; rbD[o + 8] = burn; nR++; }
        }
        strips.push([first, nR - first]);
      };
      void camL;
      if (on && vis > 0.003 && st.style === 'orbit') {
        const ig = ar.ignite, cRing = lerp3(lerp3(C0, C1, 0.35 + 0.5 * ig), C3, gold), sp = (0.22 + 0.10 * (st.rl + 1)) * t;
        const r1 = part('ring1'), r2 = part('ring2'), r3 = part('ring3');
        ribbon(1.40 * r1.s, 0.55, -0.10, cRing, 0.030 + 0.026 * ig, ig, r1.k * (0.95 + 0.55 * ig + 0.3 * beat), { spin: sp });
        ribbon(1.52 * r2.s, -0.88, 0.10, cRing, 0.028 + 0.026 * ig, ig, r2.k * (0.85 + 0.55 * ig + 0.3 * beat), { spin: -sp * 0.8 });
        // the gyroscope: a third ring that swings round the other two
        const pre3 = t * 0.55, t3x = 1.32 + 0.13 * Math.sin(pre3), t3z = 0.5 * Math.sin(pre3 * 0.7); ribbon(1.76 * r3.s, t3x, t3z, lerp3(C2, C3, gold), 0.045, 1, r3.k * (1.0 + 0.4 * beat), { spin: sp * 1.3 });
        // motes: slow specks of light on the rings
        const mo = part('motes');
        if (mo.k > 0.01) for (let i = 0; i < 7; i++) { const onA = i % 2 === 0, a = t * (0.35 + 0.12 * h1(i * 3.1)) * (onA ? 1 : -1) + i * 0.9, p = tw(onA ? onRing(1.40 * mo.s, 0.55, -0.10, a) : onRing(1.52 * mo.s, -0.88, 0.10, a)), b = mo.k * (2.6 + 2.4 * beat); put(p[0], p[1], p[2], C2[0] * b * 2, C2[1] * b * 2, C2[2] * b * 2, 2.4); put(p[0], p[1], p[2], C1[0] * b * 0.5, C1[1] * b * 0.5, C1[2] * b * 0.5, 10); }
        // comets: a bright head and a long tail along a stretched orbit
        const co = part('comets');
        if (co.k > 0.01) for (let i = 0; i < 3; i++) {
          const w0 = (0.9 + 0.25 * i) * (1 + 0.25 * (st.rl - 2)), a0 = t * w0 + i * 2.1, tx = [0.9, -0.95, 0.62][i], tz = [0.30, -0.25, 0.35][i], R = (1.55 + 0.12 * i) * co.s, cc = lerp3(lerp3(C1, WHITE, 0.3), C3, gold * 0.7);
          for (let k = 0; k < 46; k++) { const a = a0 - k * 0.030, p = tw(onRing(R * (1 + 0.10 * Math.sin(a * 2 + i)), tx, tz, a)), f = 1 - k / 46, b = co.k * (k === 0 ? 16 : 5.5 * f * f); put(p[0], p[1], p[2], cc[0] * b, cc[1] * b, cc[2] * b, k === 0 ? 4.6 : 1.0 + 2.6 * f); if (k === 0) put(p[0], p[1], p[2], C1[0] * 1.6 * co.k, C1[1] * 1.6 * co.k, C1[2] * 1.6 * co.k, 17); }
        }
        // shards: crystals that ride the gyroscope and throw sparks on the beat
        const sh = part('shards');
        if (sh.k > 0.01) for (let i = 0; i < 7; i++) {
          const ring = i % 3, a = t * (0.62 + 0.11 * ring) * (ring === 1 ? -1 : 1) + i * 0.698 * 3.3, pos = ring === 0 ? onRing(1.40 * sh.s, 0.55, -0.10, a) : ring === 1 ? onRing(1.52 * sh.s, -0.88, 0.10, a) : onRing(1.76 * sh.s, t3x, t3z, a);
          if (vis > 0.5) crystal(pos, (0.125 + 0.05 * h1(i * 7.7)) * sh.k * (1 + 0.5 * kickE), t * (1.3 + h1(i * 2.3)) + i, i, lerp3(C0, C3, gold), lerp3(C2, WHITE, 0.4), tw);
          const w = tw(pos); put(w[0], w[1], w[2], C1[0] * 1.3 * sh.k, C1[1] * 1.3 * sh.k, C1[2] * 1.3 * sh.k, 13);
          if (kickA >= 0 && kickA < 0.034 && pos[2] > O[2] && X.burst) X.burst(w, 9, 2.2, lerp3(C2, WHITE, 0.3), { size: 0.75, life: 0.5 });
        }
        // LEGENDARY: satellites of gold, each with a small ring of its own
        const sa = part('sats');
        if (sa.k > 0.01) for (let i = 0; i < 3; i++) {
          const a = t * 0.50 + i * 2.094, pos = onRing(1.78 * sa.s, [0.55, -0.92, 0.30][i], [0.20, -0.15, 0.40][i], a), w = tw(pos), b = sa.k;
          put(w[0], w[1], w[2], 14 * b, 11 * b, 6.5 * b, 5.2); put(w[0], w[1], w[2], C3[0] * 2.2 * b, C3[1] * 2.2 * b, C3[2] * 2.2 * b, 22);
          const o0 = O.slice(); O[0] = pos[0]; O[1] = pos[1]; O[2] = pos[2]; ribbon(0.20, 0.9 + 0.4 * Math.sin(t + i), t * 0.7 + i, C3, 0.012, 0.2, b * 1.2, { seg: 28, spin: t * 2 }); O[0] = o0[0]; O[1] = o0[1]; O[2] = o0[2];
        }
        // the transformation: a ring of light that travels down the face with the front
        if (st.moving && st.p >= 0 && st.p < 0.999) { const y = 1.10 - (st.p * 1.42 - 0.15) * 3.1 + 0.45; ribbon(1.22, 0.0, 0.0, lerp3(C2, WHITE, 0.5), 0.035, 0.6, 2.2 * Math.sin(Math.PI * clamp(st.p)), { yAdd: y, seg: 72 }); }
      }
      // sparks off the head (the stage's own sparks: they fall, cool and bloom like every other spark)
      // (nebula) the firestorm's embers: real points on tilted orbits round the head (behind it on the far side), turning the way the arms turn
      if (on && vis > 0.003 && ar.storm > 0.01) for (let i = 0; i < 64; i++) {      // (they fade with the gas, through PV)
        const hA = h1(i * 1.7), hB = h1(i * 3.3 + 2), a0 = -(t * (1.5 + 1.3 * hA) + i * 0.71), R = (1.12 + 0.42 * hB) * (0.75 + 0.25 * stormReach), tx = 1.25 + 0.25 * Math.sin(i * 2.4), tz = 0.5 * Math.sin(i * 1.3), b = ar.storm * (2.2 + 8.0 * hA * hA) * (0.8 + 0.7 * beat);
        for (let k = 0; k < 6; k++) { const q = onRing(R, tx, tz, a0 + k * 0.040), p = tw([q[0], (q[1] + 0.45) * 1.18 - 0.25, q[2]]), f = 1 - k / 6, hd = k === 0 ? 1 : 0; put(p[0], p[1], p[2], C1[0] * b * f + b * 0.35 * hd, C1[1] * b * f + b * 0.28 * hd, C1[2] * b * f, (1.5 + 1.2 * hB) * (0.5 + 0.5 * f)); }
      }
      if (on && vis > 0.5 && ar.sparks > 0.01 && X.spark) {
        const rate = ar.sparks * (1.2 + 2.6 * beat + 1.2 * bass);
        for (let j = 0; j < Math.floor(rate) + (rnd() < rate % 1 ? 1 : 0); j++) { const a = (rnd() * 2 - 1) * 1.9, w = tw([(0.70 + 0.30 * ss(-1.2, 0.3, Math.cos(a) * 1.25)) * Math.sin(a), -0.20 + 1.25 * Math.cos(a), -0.05]); X.spark(w, [(rnd() - 0.5) * 1.2 + Math.sin(a) * 0.6, 1.4 + 2.8 * rnd(), 0], 0.8 + 0.8 * rnd(), 0.8 + 0.4 * rnd(), lerp3(C1, WHITE, 0.3 + 0.4 * gold)); }
      }
      // the lock: sparks thrown out of the whole outline
      if (on && vis > 0.5 && st.since >= 0 && st.since < 0.034 && X.burst) { const fc = tw([0, -0.20, 0.2]); X.burst(fc, 70 + 26 * (st.to + 1), 3.4 + 0.5 * st.to, lerp3(C1, WHITE, 0.35), { size: 1.1, life: 0.9, white: 0.6 }); }
      // gold rain (the stage's LEGENDARY)
      if (on && vis > 0.003 && ar.rain > 0.01) for (let i = 0; i < 90; i++) {
        const a = h1(i * 1.37), b = h1(i * 2.91 + 5), d = h1(i * 4.3 + 9), yy = ((t * (0.6 + 0.9 * b) + a * 5.6) % 5.6), VIEW = c.VIEW, x = (a * 2 - 1) * 1.7 + 0.10 * Math.sin(t * (1 + b) + i), y = VIEW.targetY + 2.9 - yy, tw2 = Math.pow(0.5 + 0.5 * Math.sin(t * (6 + 9 * d) + i * 3.3), 3), br = (1.5 + 7 * tw2) * ar.rain;
        put(x, y, -0.8 + 2.2 * d, C3[0] * br + br * 0.3 * tw2, C3[1] * br + br * 0.25 * tw2, C3[2] * br, 1.0 + 1.3 * d);
      }

      // ---- GIFTERS: pictures in the orbit
      if (vis > 0.003) gifters(c, X, { tw, clipOf, C1, C2, C3, kickE, aspect, vis }); else if (st.gifters.length) gifters(c, X, null);      // (the Visualizer: no pictures, no trails, no names; they still age and leave)

      // ---- draw: crystals (solid), ribbons, points, pictures: all tested against the face's depth
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      if (nT > 0) { gl.disable(gl.BLEND); gl.depthMask(true); gl.bindBuffer(gl.ARRAY_BUFFER, S.soBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, soD.subarray(0, nT * 7)); S.pSol.use().u('uViewProj', vp); gl.bindVertexArray(S.soVao); gl.drawArrays(gl.TRIANGLES, 0, nT); }
      gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      if (nR > 0) { gl.bindBuffer(gl.ARRAY_BUFFER, S.rbBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, rbD.subarray(0, nR * 9)); S.pRib.use().u('uViewProj', vp).u('uTime', t); gl.bindVertexArray(S.rbVao); for (const s of strips) gl.drawArrays(gl.TRIANGLE_STRIP, s[0], s[1]); }
      if (nP > 0) { gl.bindBuffer(gl.ARRAY_BUFFER, S.ptBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptD.subarray(0, nP * 7)); S.pPts.use().u('uViewProj', vp).u('uPx', G.H * 0.066 * ps); gl.bindVertexArray(S.ptVao); gl.drawArrays(gl.POINTS, 0, nP); }
      if (nA > 0) {
        if (st.atlasDirty || st.gifters.some((g) => g.viewer && g.viewer.avatar && typeof g.viewer.avatar === 'object' && g.drawn !== g.viewer.avatar)) { atlasUpdate(); st.atlasDirty = false; }
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, S.avBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, avD.subarray(0, nA * 11)); G.bindTex(0, S.atlas);
        S.pAva.use().u('uViewProj', vp).u('uScale', [c.proj[0] * ps, c.proj[5] * ps]).ui('uAtlas', 0).u('uTime', t).u('uGold', C3).u('uHot', C1); gl.bindVertexArray(S.avVao); gl.drawArrays(gl.TRIANGLES, 0, nA);
      }
      if (frontOn) { G.bindTex(0, S.nebTex); gl.disable(gl.DEPTH_TEST); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.bindVertexArray(S.triVao); auraU(1); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.bindVertexArray(null);
      st.counts = { points: nP, ribbon: nR, solid: nT, pictures: nA / 6 };
      void sc;
    }
    const KU = new Float32Array(16);
    const kicksU = (kicks) => { for (let i = 0; i < 8; i++) { const k = (kicks || [])[i] || [99, 0]; KU[i * 2] = k[0]; KU[i * 2 + 1] = k[1]; } return KU; };
    /** a crystal: a long double pyramid, each face its own light */
    function crystal(pos, size, spin, id, body, edge, tw) {
      if (nT + 24 > MAXT) return;
      const ax = [Math.sin(id * 2.1), Math.cos(id * 1.3), Math.sin(id * 0.7 + spin * 0.3)], al = Math.hypot(ax[0], ax[1], ax[2]) || 1; ax[0] /= al; ax[1] /= al; ax[2] /= al;
      let u = [ax[1], -ax[0], 0]; const ul = Math.hypot(u[0], u[1]) || 1; u = [u[0] / ul, u[1] / ul, 0]; const v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
      const tipA = [pos[0] + ax[0] * size * 1.9, pos[1] + ax[1] * size * 1.9, pos[2] + ax[2] * size * 1.9], tipB = [pos[0] - ax[0] * size * 1.3, pos[1] - ax[1] * size * 1.3, pos[2] - ax[2] * size * 1.3], mid = [];
      for (let k = 0; k < 4; k++) { const a = spin + k * 1.5708, cx = Math.cos(a) * size * 0.62, sx = Math.sin(a) * size * 0.62; mid.push([pos[0] + u[0] * cx + v[0] * sx, pos[1] + u[1] * cx + v[1] * sx, pos[2] + u[2] * cx + v[2] * sx]); }
      const L = [-0.45, 0.55, 0.70];
      for (let k = 0; k < 4; k++) for (const tip of [tipA, tipB]) {
        const a = mid[k], b = mid[(k + 1) % 4], e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [tip[0] - a[0], tip[1] - a[1], tip[2] - a[2]];
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const nl = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / nl, n[1] / nl, n[2] / nl]; if (tip === tipB) n = [-n[0], -n[1], -n[2]];
        const dif = Math.abs(n[0] * L[0] + n[1] * L[1] + n[2] * L[2]), spec = Math.pow(dif, 9), col = [body[0] * (0.10 + 0.9 * dif) + edge[0] * spec * 3.2, body[1] * (0.10 + 0.9 * dif) + edge[1] * spec * 3.2, body[2] * (0.10 + 0.9 * dif) + edge[2] * spec * 3.2];
        for (const q of [a, b, tip]) { const w = tw(q), o = nT * 7; soD[o] = w[0]; soD[o + 1] = w[1]; soD[o + 2] = w[2]; soD[o + 3] = col[0]; soD[o + 4] = col[1]; soD[o + 5] = col[2]; soD[o + 6] = 1; nT++; }
      }
    }
    /** the gifters' orbit. Two tilted paths: one passes under the chin, one over the brow; behind the head on the far side. */
    function gifters(c, X, H) {
      const t = st.t; if (!st.gifters.length) return;
      st.gifters = st.gifters.filter((g) => !(g.leaving && t - g.leaveAt > 1.3));
      for (const g of st.gifters) if (!g.leaving && t > g.until) { g.leaving = true; g.leaveAt = t; }
      if (!H) return; const { tw, clipOf, C1, C3, kickE, vis } = H;
      const live = st.gifters.filter((g) => !g.leaving).sort((a, b) => a.n - b.n), best = top(), cosmic = seg(st.rl + 1, 6), speed = (0.42 + 0.07 * (st.rl + 1)) * (1 + 0.5 * cosmic);
      st.gPhase = (st.gPhase || 0) + speed * Math.min(0.1, t - (st.gT === undefined ? t : st.gT)); st.gT = t;
      st.gifters.forEach((g) => {
        const idx = Math.max(0, live.indexOf(g)), n = Math.max(1, live.length), lower = idx % 2 === 0, perPath = Math.ceil(n / 2);
        const want = (Math.floor(idx / 2) / Math.max(1, perPath)) * 6.2832 + (lower ? 0 : 3.1416 / Math.max(1, perPath)); if (g.off === undefined) g.off = want; let dO = want - g.off; dO -= Math.round(dO / 6.2832) * 6.2832; g.off += dO * 0.04;
        const a = st.gPhase * (lower ? 1 : -1) + g.off, tier = tierOf(g.coins), isTop = g === best && live.length > 1;
        const inK = ss(0, 1.0, t - g.t0), outK = g.leaving ? clamp((t - g.leaveAt) / 1.2) : 0, far = 1 + 2.2 * Math.pow(1 - inK, 2) + 2.6 * outK * outK;
        // the two paths (head space): centre, half-width (x), depth (z), how much the front dips (+) or rises (-)
        const P = lower ? { cy: -0.92, ax: isTop ? 1.30 : 1.47, az: 1.25, tip: 0.86 } : { cy: 0.32, ax: isTop ? 1.30 : 1.47, az: 1.25, tip: -0.95 };
        const spin = a + (1 - inK) * 2.5 + outK * 2.2;
        let x = Math.cos(spin) * P.ax * far, z0 = Math.sin(spin) * P.az * far, y = P.cy - z0 * Math.sin(P.tip), z = z0 * Math.cos(P.tip);
        if (cosmic > 0.01) { const tl = 1.25, xr = Math.cos(spin) * 1.62, zr = Math.sin(spin) * 1.62, yr = zr * Math.cos(tl) * 0.42 + 0.075 * xr - 0.22; x = lerp(x, xr, cosmic); y = lerp(y, yr, cosmic); z = lerp(z, zr * Math.sin(tl), cosmic); }
        const w = tw([x, y, z + 0.15]), front = z / P.az, bump = Math.exp(-(t - g.bump) * 3.5);
        const size = ([0.21, 0.24, 0.28, 0.32][tier] + (isTop ? 0.03 : 0)) * (c.sc || 1) * (1 + 0.10 * front) * (1 + 0.14 * kickE + 0.35 * bump) * lerp(1, 0.62, cosmic) * (0.4 + 0.6 * inK) * (1 - 0.6 * outK);
        const alpha = clamp(inK * 1.6) * (1 - outK) * vis, light = (isTop ? 1.0 : 0.45) + 0.5 * kickE + 0.1 * (st.rl + 1);
        if (nA + 6 <= 8 * 6) for (const q of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) { const o = nA * 11; avD[o] = w[0]; avD[o + 1] = w[1]; avD[o + 2] = w[2]; avD[o + 3] = q[0]; avD[o + 4] = q[1]; avD[o + 5] = size; avD[o + 6] = g.slot; avD[o + 7] = tier; avD[o + 8] = light; avD[o + 9] = cosmic; avD[o + 10] = alpha; nA++; }
        // the trail: longer and hotter with the gift and with the rank
        const tl = tier >= 3 ? 26 : tier === 2 ? 14 : tier === 1 ? 7 : 0, hot = 0.5 + 0.18 * (st.rl + 1);
        for (let k = 1; k <= tl; k++) { const a2 = spin - (lower ? 1 : -1) * k * 0.035, x2 = Math.cos(a2) * P.ax * far, zz = Math.sin(a2) * P.az * far, p = tw([x2, P.cy - zz * Math.sin(P.tip), zz * Math.cos(P.tip) + 0.15]), f = 1 - k / (tl + 1), b = alpha * hot * (tier >= 3 ? 4.2 : 2.4) * f * f * (1 - cosmic), cc = tier >= 2 ? C3 : C1; put(p[0], p[1], p[2], cc[0] * b, cc[1] * b, cc[2] * b, (0.9 + 2.2 * f) * (tier >= 3 ? 1.3 : 1)); }
        if (cosmic > 0.05) { const b = cosmic * alpha; put(w[0], w[1], w[2], C3[0] * 2.4 * b, C3[1] * 2.4 * b, C3[2] * 2.4 * b, 16); }
        if (tier >= 2 || isTop) put(w[0], w[1], w[2] - 0.02, C3[0] * 0.5 * alpha * light, C3[1] * 0.5 * alpha * light, C3[2] * 0.5 * alpha * light, 16 * size / 0.2);
        // the name: for a moment when they join (or give again), under the picture
        const na = t - g.nameAt; if (na < 3.0 && !g.leaving && vis > 0.5) { const s2 = clipOf(w); st.names.push({ x: (s2[0] * 0.5 + 0.5) * c.G.W, y: (0.5 - s2[1] * 0.5) * c.G.H, r: size * c.G.H * 0.5 * c.proj[5] * (c.ps || 1) / s2[2], name: g.name, a: ss(0, 0.25, na) * (1 - ss(2.3, 3.0, na)), tier, front: z > 0 || Math.abs(x) > 1.05 }); }
      });
      void X;
    }
    return { setStyle, setTone, setRank, gifter, songStart, pre, render, state: st, names: () => st.names, get style() { return st.style; } };
  }
  const api = { create, STYLES, LABELS, around, face, TONES };
  root.VTMaskHype = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
