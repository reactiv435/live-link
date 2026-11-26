// V9 HANDS: the hand-effects layer of the Mask. His hands (as glowing silhouettes) and a live visual between them, drawn
// into the Mask's own HDR scene IN FRONT of the face, so it blooms with it. Loaded after mask-looks.js; when it is not
// loaded, or the layer is off, the Mask makes exactly the graphics calls it made before (tests/v9-hands.test.js).
//
//   const hx = VTMaskHands.create(G);            // G = mask-gl.js
//   hx.setOn(true | false);  hx.setEffect('particle-play');
//   hx.input(hands, { aspect, face }, t);        // the hand model's hands, at the tracker's rate (js/v9/hand-gestures.js reads them)
//   hx.face(lm);                                 // his face in the camera picture (so a hand in front of his face is in front of the Mask's)
//   const o = hx.pre(t, dt, { audio, kicks, hits });   // each drawn frame: o = null (nothing to draw) | { render(X), room }
//   hx.state();                                  // for OTHER modules (gift missiles a hand can swat ...): hands with place, speed, pose; the events
//
// THE FRAMEWORK IS EFFECT-AGNOSTIC. An effect is registered by name and gets, each frame, one object F:
//   F.t, F.dt, F.A (frame half-width; the frame is x -A..A, y -1..1, y up), F.k (how much of it shows)
//   F.c      the thing between his hands: { x, y, r (frame units), mode, charge, heat, grab, flying, vx, vy, magnet, dir, beam, blast }
//   F.hands  [{ side, k, x, y, size, pose, facing, vx, vy, pts: Float32Array(42) frame units, z: Float32Array(21) depths, tip, dir }]
//   F.face   the Mask's own face in the frame: { x, y, w }
//   F.au     { level, bass, high, kick (0..1, decays), kickNow, hit, hitNow }
//   F.ev     what happened since the last frame: [{ type: 'blast' | 'magnet' | 'reverse' | 'grab' | 'throw' | 'catch' | ... }]
//   F.point(x, y, size, r, g, b, a, kind)       kind 0 = soft dot, 1 = star flare, 2 = wide glow
//   F.ribbon(n, at, width, colour)               a glowing line through n points: at(i, out2), width(i), colour(i, out4)
//   F.spark(x, y, vx, vy, life, size, r, g, b, kind, drag, lift)    a short-lived free particle the framework moves and draws
// and gives back { palette: { rim, glow, fill }, frame(F) }. The framework draws the hands and owns the buffers.
// An effect may also give: always() (true = it is there without hands too), handFS (its own hand: a fragment program
// with FS_HD's inputs), drawHands(X, hands) (it draws the hands itself: a modelled hand), drawBehind(X) / draw(X) (its own
// drawing behind / in front of the hands).
(function (root) {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ease = (v, to, dt, r) => v + (to - v) * (1 - Math.exp(-dt * r));
  const EFFECTS = {};

  const VS_PT = `#version 300 es
  layout(location=0) in vec4 aP; layout(location=1) in vec4 aC;
  uniform vec2 uS; out vec4 vC; out float vK;
  void main() { gl_Position = vec4(aP.x * uS.x, aP.y, 0.0, 1.0); gl_PointSize = clamp(aP.z * uS.y, 1.0, 1000.0); vC = aC; vK = aP.w; }`;
  const FS_PT = `#version 300 es
  precision highp float; in vec4 vC; in float vK; out vec4 o;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
    float a;
    if (vK < 0.5) a = exp(-r2 * 4.5) * (1.0 - r2);
    else if (vK < 1.5) a = exp(-r2 * 26.0) * 1.4 + 0.75 * (exp(-abs(p.x) * 30.0) * exp(-abs(p.y) * 4.0) + exp(-abs(p.y) * 30.0) * exp(-abs(p.x) * 4.0)) * (1.0 - r2);
    else { float d = 1.0 - sqrt(r2); a = d * d * d; }
    o = vec4(vC.rgb * (vC.a * a), 1.0);
  }`;
  const VS_RB = `#version 300 es
  layout(location=0) in vec4 aP; layout(location=1) in vec4 aC;
  uniform vec2 uS; out vec4 vC; out vec2 vU;
  void main() { gl_Position = vec4(aP.x * uS.x, aP.y, 0.0, 1.0); vC = aC; vU = aP.zw; }`;
  const FS_RB = `#version 300 es
  precision highp float; in vec4 vC; in vec2 vU; out vec4 o;
  void main() { float u = abs(vU.x), a = exp(-u * u * 9.0) * 0.85 + 2.2 * exp(-u * u * 160.0); a *= 1.0 - smoothstep(0.8, 1.0, u); o = vec4(vC.rgb * (vC.a * a), 1.0); }`;
  // a hand: the distance to its 21-point skeleton (fingers = tapered capsules, the palm = fat capsules, melted together).
  // Inside = dark (it hides the face behind it), the edge = a hot line, outside = a glow that licks like flame.
  const VS_HD = `#version 300 es
  layout(location=0) in vec2 aQ; uniform vec4 uBox; uniform vec2 uS; out vec2 vP;
  void main() { vP = mix(uBox.xy, uBox.zw, aQ); gl_Position = vec4(vP.x * uS.x, vP.y, 0.0, 1.0); }`;
  const FS_HD = `#version 300 es
  precision highp float; in vec2 vP; out vec4 o;
  uniform vec2 uPt[21]; uniform float uL, uK, uTime, uHot; uniform vec3 uRim, uGlow, uFill;
  float seg(vec2 p, vec2 a, vec2 b, float ra, float rb) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0); return length(pa - ba * h) - mix(ra, rb, h); }
  float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    float L = uL, d = 1e3, k = 0.022 * L, bone = 1e3, crease = 0.0;
    for (int f = 0; f < 5; f++) {
      int b = 1 + f * 4; float r0 = (f == 0 ? 0.100 : f == 4 ? 0.072 : 0.084) * L, r1 = r0 * 0.78;
      float df = min(min(seg(vP, uPt[b], uPt[b + 1], r0 * 1.08, r0), seg(vP, uPt[b + 1], uPt[b + 2], r0, r0 * 0.92)), seg(vP, uPt[b + 2], uPt[b + 3], r0 * 0.92, r1));
      d = smin(d, df, k);
      // the drawn detail inside the hand: a line down each finger and a short crease across each joint
      bone = min(bone, min(min(seg(vP, uPt[b], uPt[b + 1], 0.0, 0.0), seg(vP, uPt[b + 1], uPt[b + 2], 0.0, 0.0)), seg(vP, uPt[b + 2], uPt[b + 3], 0.0, 0.0)));
      for (int j = 0; j < 3; j++) { vec2 J = uPt[b + j], dir = normalize(uPt[b + j + 1] - J + 1e-6); vec2 r = vP - J; float al = dot(r, dir), pe = abs(r.x * dir.y - r.y * dir.x); crease += exp(-abs(al) / L * 120.0) * (1.0 - smoothstep(r0 * 0.55, r0 * 0.95, pe)); }
    }
    float pr = 0.185 * L;
    float dp = min(min(seg(vP, uPt[0], uPt[5], pr * 0.95, pr * 0.72), seg(vP, uPt[0], uPt[9], pr, pr * 0.72)), min(seg(vP, uPt[0], uPt[13], pr, pr * 0.70), seg(vP, uPt[0], uPt[17], pr * 0.95, pr * 0.62)));
    dp = min(dp, min(seg(vP, uPt[5], uPt[17], pr * 0.62, pr * 0.55), seg(vP, uPt[1], uPt[5], pr * 0.8, pr * 0.6)));
    d = smin(d, dp, k * 2.2);
    bone = min(bone, min(min(seg(vP, uPt[0], uPt[5], 0.0, 0.0), seg(vP, uPt[0], uPt[9], 0.0, 0.0)), min(seg(vP, uPt[0], uPt[13], 0.0, 0.0), seg(vP, uPt[0], uPt[17], 0.0, 0.0))));
    float q = d / L;                                   // in palm lengths: < 0 inside
    float n = vn(vP / L * 5.0 + vec2(0.0, -uTime * 1.7)) * 0.6 + vn(vP / L * 11.0 + vec2(uTime * 0.6, -uTime * 2.6)) * 0.4;
    float line = exp(-abs(q) * 85.0) * 2.3 + exp(-abs(q) * 26.0) * 0.50;
    float lick = (0.10 + 1.7 * n * n * n) * exp(-max(q, 0.0) * (11.0 - 4.0 * uHot)) * step(0.0, q);
    float inner = (exp(q * 22.0) * 0.55 + exp(q * 5.0) * 0.10) * (0.4 + n) * step(q, 0.0);
    float detail = (exp(-bone / L * 95.0) * 0.30 + min(crease, 1.0) * 0.55) * step(q, -0.012) * (0.6 + 0.6 * n);
    vec3 c = uRim * line * (0.75 + 0.6 * n) + uGlow * lick * (0.45 + 0.7 * uHot) + uFill * inner + mix(uGlow, uRim, 0.5) * detail;
    float fill = (1.0 - smoothstep(-0.015, 0.008, q)) * 0.95;
    o = vec4(c * uK, fill * uK);
  }`;

  function create(G) {
    const gl = G.gl, A = G.W / G.H;
    const MAXP = 16000, MAXV = 30000, MAXS = 3000;
    const pt = new Float32Array(MAXP * 8), rb = new Float32Array(MAXV * 8);
    let np = 0, nv = 0;
    let progs = null;
    function gpu() {
      if (progs) return progs;
      const pPt = G.program(VS_PT, FS_PT), pRb = G.program(VS_RB, FS_RB), pHd = G.program(VS_HD, FS_HD);
      const mk = (data) => { const vao = gl.createVertexArray(), buf = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16); return { vao, buf }; };
      const a = mk(pt), b = mk(rb);
      const qv = gl.createVertexArray(), qb = gl.createBuffer(); gl.bindVertexArray(qv); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      progs = { pPt, pRb, pHd, a, b, qv };
      return progs;
    }

    // ------------------------------------------------------------------ what the effects draw with
    function point(x, y, size, r, g, b, a, kind) {
      if (np >= MAXP || !(a > 0.002)) return;
      const o = np++ * 8; pt[o] = x; pt[o + 1] = y; pt[o + 2] = size; pt[o + 3] = kind || 0; pt[o + 4] = r; pt[o + 5] = g; pt[o + 6] = b; pt[o + 7] = a;
    }
    const P2 = new Float32Array(2 * 256), W1 = new Float32Array(256), C4 = new Float32Array(4 * 256), t2 = [0, 0], t4 = [0, 0, 0, 0];
    function ribbon(n, at, width, colour) {
      n = Math.min(n, 256); if (n < 2) return;
      for (let i = 0; i < n; i++) { at(i, t2); P2[i * 2] = t2[0]; P2[i * 2 + 1] = t2[1]; W1[i] = width(i); colour(i, t4); C4[i * 4] = t4[0]; C4[i * 4 + 1] = t4[1]; C4[i * 4 + 2] = t4[2]; C4[i * 4 + 3] = t4[3]; }
      let pnx = 0, pny = 0;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1); let dx = P2[i1 * 2] - P2[i0 * 2], dy = P2[i1 * 2 + 1] - P2[i0 * 2 + 1]; const l = Math.hypot(dx, dy) || 1e-6; dx /= l; dy /= l;
        const nx = -dy * W1[i], ny = dx * W1[i];
        if (i > 0) {
          if (nv + 6 > MAXV) return;
          const j = i - 1, ax = P2[j * 2], ay = P2[j * 2 + 1], bx = P2[i * 2], by = P2[i * 2 + 1];
          const put = (x, y, u, c) => { const o = nv++ * 8; rb[o] = x; rb[o + 1] = y; rb[o + 2] = u; rb[o + 3] = 0; rb[o + 4] = C4[c * 4]; rb[o + 5] = C4[c * 4 + 1]; rb[o + 6] = C4[c * 4 + 2]; rb[o + 7] = C4[c * 4 + 3]; };
          put(ax + pnx, ay + pny, 1, j); put(ax - pnx, ay - pny, -1, j); put(bx + nx, by + ny, 1, i);
          put(ax - pnx, ay - pny, -1, j); put(bx - nx, by - ny, -1, i); put(bx + nx, by + ny, 1, i);
        }
        pnx = nx; pny = ny;
      }
    }
    // free sparks
    const SP = new Float32Array(MAXS * 14); let ns = 0;
    function spark(x, y, vx, vy, life, size, r, g, b, kind, drag, lift) {
      if (ns >= MAXS) return;
      const o = ns++ * 14; SP[o] = x; SP[o + 1] = y; SP[o + 2] = vx; SP[o + 3] = vy; SP[o + 4] = 0; SP[o + 5] = life; SP[o + 6] = size; SP[o + 7] = r; SP[o + 8] = g; SP[o + 9] = b; SP[o + 10] = kind || 0; SP[o + 11] = drag === undefined ? 1.5 : drag; SP[o + 12] = lift || 0; SP[o + 13] = 0;
    }
    function sparks(dt, k) {
      for (let i = ns - 1; i >= 0; i--) {
        const o = i * 14; SP[o + 4] += dt;
        if (SP[o + 4] >= SP[o + 5]) { ns--; if (i !== ns) SP.copyWithin(o, ns * 14, ns * 14 + 14); continue; }
        const dr = Math.exp(-dt * SP[o + 11]); SP[o + 2] *= dr; SP[o + 3] = SP[o + 3] * dr + SP[o + 12] * dt; SP[o] += SP[o + 2] * dt; SP[o + 1] += SP[o + 3] * dt;
        const u = 1 - SP[o + 4] / SP[o + 5];
        point(SP[o], SP[o + 1], SP[o + 6] * (0.5 + 0.5 * u), SP[o + 7], SP[o + 8], SP[o + 9], k * Math.min(1, u * 2.2), SP[o + 10]);
      }
    }

    // ------------------------------------------------------------------ state
    const Gest = root.VTHandGestures;
    if (!Gest) throw new Error('mask-hands: js/v9/hand-gestures.js must be loaded first');
    const gest = Gest.create(), ctl = Gest.control();
    const S = { on: false, name: 'particle-play', fx: null, fxName: '', last: null, lastAt: -9, stepAt: -9, evQ: [], gain: 0.80, room: 0, roomOn: true, face: null, faceGiven: null, k: 0, drawMs: 0, kickSeen: 0, hitSeen: 0, kick: 0, hit: 0, out: null, mapped: [], seed: 0x51f15e };
    function rnd() { S.seed |= 0; S.seed = (S.seed + 0x6d2b79f5) | 0; let t = Math.imul(S.seed ^ (S.seed >>> 15), 1 | S.seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    const hs = new Map();          // a hand's points in the frame, by the reader's id

    function setOn(on) { S.on = !!on; if (!S.on) { gest.reset(); S.last = null; } }
    function setEffect(name) { if (!EFFECTS[name]) return false; S.name = name; return true; }
    function setRoom(on) { S.roomOn = !!on; }
    /** his face in the camera picture: lm = the face model's points (x, y, z per point); size = the picture */
    function face(lm, size) {
      if (!lm || lm.length < 468 * 3) return;
      const asp = size && size.width && size.height ? size.width / size.height : 0.5625;
      // cheek to cheek (234, 454), brow middle to chin (10, 152)
      const x = (lm[234 * 3] + lm[454 * 3]) / 2, y = (lm[10 * 3 + 1] + lm[152 * 3 + 1]) / 2, w = Math.hypot((lm[454 * 3] - lm[234 * 3]) * asp, lm[454 * 3 + 1] - lm[234 * 3 + 1]);
      if (!(w > 0.01)) return;
      if (!S.face) S.face = { x, y, w, asp }; else { const f = S.face, a = 0.06; f.x += (x - f.x) * a; f.y += (y - f.y) * a; f.w += (w - f.w) * a; f.asp = asp; }
    }
    function input(hands, o, t) {
      if (!S.on) return;
      const opt = o || {}; if (opt.face) S.faceGiven = opt.face;
      S.last = gest.step(t, hands, { aspect: opt.aspect || 0.5625 }); S.lastAt = t; S.stepAt = t;
      for (const e of S.last.events) S.evQ.push(e);
    }

    // where a picture point is in the frame: a hand keeps its place RELATIVE TO HIS FACE (so a hand held in front of his
    // face is in front of the Mask's face, wherever he sits in the camera picture), scaled by `gain`
    let MAP = { fx: 0.5, fy: 0.4, fw: 0.2, asp: 0.5625, mx: 0, my: 0.2, mw: 0.5, s: 1 };
    const mapX = (xTrue) => MAP.mx + (xTrue - MAP.fx * MAP.asp) * MAP.s, mapY = (y) => MAP.my - (y - MAP.fy) * MAP.s;

    function pre(t, dt, env) {
      if (!S.on) { S.k = 0; S.room = 0; return null; }
      if (S.fxName !== S.name) { S.fx = EFFECTS[S.name]({ rnd, A, G }); S.fxName = S.name; }
      const au = (env && env.audio) || {}, kicks = (env && env.kicks) || [], hits = (env && env.hits) || [];
      // the music: a kick is a pulse that decays; "now" = it began since the last frame
      let kick = 0, kickNow = 0, hit = 0, hitNow = 0;
      for (const q of kicks) { kick = Math.max(kick, q[1] * Math.exp(-q[0] * 7)); if (q[0] < dt + 1e-4) kickNow = Math.max(kickNow, q[1]); }
      for (const q of hits) { hit = Math.max(hit, q[1] * Math.exp(-q[0] * 2.2)); if (q[0] < dt + 1e-4) hitNow = Math.max(hitNow, q[1]); }
      const AU = { level: au.level || 0, bass: au.bass || 0, high: au.high || 0, mid: au.mid || 0, kick, kickNow, hit, hitNow };
      // the reader's newest answer; when the tracker has gone quiet the hands are gone
      // the tracker has sent nothing for a moment (it does that): the reader is stepped with "no hands", so a hand is HELD
      // where it was and only fades when it has really gone
      if (S.last && t - S.lastAt > 0.12 && t - S.stepAt > 0.03) { const s2 = gest.step(t, [], { aspect: S.last.aspect }); for (const e of s2.events) S.evQ.push(e); S.last = s2; S.stepAt = t; }
      const snap = S.last || { aspect: 0.5625, hands: [], events: [] };
      const u = ctl.step(t, dt, { aspect: snap.aspect, hands: snap.hands, events: S.evQ.splice(0) }, AU);
      S.k = u.k; S.out = u; S.snap = snap; S.au = AU;
      const anyK = Math.max(u.k, ...snap.hands.map((h) => h.k), 0);
      S.room = ease(S.room, S.roomOn && anyK > 0.02 ? 1 : 0, dt, 2.2);
      if (anyK < 0.003 && S.room < 0.003 && !ns && !(S.fx.always && S.fx.always())) return null;      // (an effect may be there without hands: `always`)
      S.t = t; S.dt = dt;
      return { render, room: S.room };
    }
    /** the Mask makes room: smaller and higher while the hands are up (the same place message the V7 controls use) */
    function place(p) {
      if (!(S.room > 0.003)) return p;
      const b = p || { zoom: 1, x: 0, y: 0 }, r = S.room * S.room * (3 - 2 * S.room);
      return { zoom: b.zoom * (1 - 0.44 * r), x: b.x, y: b.y + 0.19 * r };
    }

    function render(X) {
      const b0 = performance.now(), u = S.out, snap = S.snap, t = S.t, dt = S.dt;
      // ---- the Mask's own face in the frame (through its camera and its place)
      const vp = X.vp, sc = X.sc, prj = (x, y, z) => { const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]; return [(vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * A, (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w]; };
      const c0 = prj(X.hx, X.hy - 0.42 * sc, 0.2 * sc), c1 = prj(X.hx + 0.98 * sc, X.hy - 0.42 * sc, 0.2 * sc);
      const f = S.faceGiven || S.face || { x: 0.5, y: 0.38, w: 0.2, asp: snap.aspect };
      MAP = { fx: f.x, fy: f.y, fw: f.w, asp: snap.aspect, mx: c0[0], my: c0[1], mw: 2 * Math.abs(c1[0] - c0[0]), s: 2 * Math.abs(c1[0] - c0[0]) / f.w * S.gain };
      const asp = snap.aspect, sL = MAP.s;
      // ---- his hands in the frame
      const H = [];
      for (const id of hs.keys()) if (!snap.hands.some((h) => h.id === id)) hs.delete(id);
      snap.hands.forEach((h) => {
        if (!h.pts) return;
        let slot = hs.get(h.id); if (!slot) { slot = { pts: new Float32Array(42), z: new Float32Array(21), has: false }; hs.set(h.id, slot); }
        const P = slot.pts, kf = slot.has ? 1 - Math.exp(-dt / 0.035) : 1;
        for (let j = 0; j < 21; j++) { const x = mapX(h.pts[j * 2]), y = mapY(h.pts[j * 2 + 1]); P[j * 2] += (x - P[j * 2]) * kf; P[j * 2 + 1] += (y - P[j * 2 + 1]) * kf; }
        // (round 7) each point's DEPTH comes through too, in frame units, + = toward the viewer, the wrist's own = 0 (an effect with a modelled hand needs it)
        if (h.z) for (let j = 0; j < 21; j++) { const zf = -h.z[j] * sL; if (Number.isFinite(zf)) slot.z[j] += (zf - slot.z[j]) * kf; }
        slot.has = true;
        const dl = Math.hypot(P[16] - P[10], P[17] - P[11]) || 1e-6;
        H.push({ id: h.id, side: h.side, k: h.k, on: h.on, held: !!h.held, moving: !!h.moving, x: (P[0] + P[10] + P[18] + P[34]) / 4, y: (P[1] + P[11] + P[19] + P[35]) / 4, size: h.size * sL, L: Math.hypot(P[18] - P[0], P[19] - P[1]), pose: h.pose, poseFor: h.poseFor, facing: h.facing, vx: h.vx * asp * sL, vy: -h.vy * sL, pts: P, z: slot.z, tip: [P[16], P[17]], dir: [(P[16] - P[10]) / dl, (P[17] - P[11]) / dl] });
      });
      const Hon = H.filter((h) => h.on);
      const C = { x: mapX(u.x * asp), y: mapY(u.y), r: u.r * sL, mode: u.mode, charge: u.charge, charging: u.charging, heat: u.heat, grab: u.grab, grabbing: u.grabbing, flying: u.flying, vx: u.vx * asp * sL, vy: -u.vy * sL, magnet: u.magnet, dir: u.dir, beam: u.beam.on ? Hon.find((h) => h.id === u.beam.id) || null : null, beamK: u.beamK, blast: u.blast, blastAge: u.blastAge };
      S.mapped = H; S.core = C;
      np = 0; nv = 0;
      const F = { t, dt, A, k: u.k, c: C, hands: Hon, allHands: H, au: S.au, ev: u.events, point, ribbon, spark, rnd, face: { x: MAP.mx, y: MAP.my, w: MAP.mw } };
      const pal = S.fx.frame(F) || S.fx.palette;
      sparks(dt, 1);
      // ---- draw: the hands (dark, with their hot edge), then everything that glows on top
      const g = gpu(), sU = [1 / A, G.H * 0.5];
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND);
      if (S.fx.drawBehind) S.fx.drawBehind({ gl, G, sU, A, t });                      // an effect's own drawing BEHIND the hands
      // (an effect may bring its own hand: `handFS`, a fragment program with the same inputs)
      const pHd = S.fx.handFS ? (g.own && g.ownOf === S.fx ? g.own : (g.ownOf = S.fx, g.uPtOwn = null, g.own = G.program(VS_HD, S.fx.handFS))) : g.pHd, own = pHd !== g.pHd;
      // (round 7) an effect may draw the hands itself (a modelled, skinned hand); when it cannot (its model has not come yet) it says so and the drawn hand stands in
      if (!(S.fx.drawHands && S.fx.drawHands({ gl, G, sU, A, t, dt }, H)) && H.length) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); pHd.use().u('uS', sU).u('uTime', t).u('uRim', pal.rim).u('uGlow', pal.glow).u('uFill', pal.fill).u('uHot', clamp(0.3 * S.au.high + 0.7 * S.au.kick + u.heat, 0, 1));
        gl.bindVertexArray(g.qv);
        for (const h of H) {
          if (!(h.k > 0.01)) continue;
          let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (let j = 0; j < 21; j++) { x0 = Math.min(x0, h.pts[j * 2]); x1 = Math.max(x1, h.pts[j * 2]); y0 = Math.min(y0, h.pts[j * 2 + 1]); y1 = Math.max(y1, h.pts[j * 2 + 1]); }
          const m = h.L * 1.1;
          pHd.u('uBox', [x0 - m, y0 - m, x1 + m, y1 + m]).u('uL', h.L).u('uK', h.k); gl.uniform2fv(own ? g.uPtOwn || (g.uPtOwn = gl.getUniformLocation(pHd.p, 'uPt')) : g.uPt || (g.uPt = gl.getUniformLocation(g.pHd.p, 'uPt')), h.pts);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      gl.blendFunc(gl.ONE, gl.ONE);
      if (nv) { g.pRb.use().u('uS', sU); gl.bindVertexArray(g.b.vao); gl.bindBuffer(gl.ARRAY_BUFFER, g.b.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, rb.subarray(0, nv * 8)); gl.drawArrays(gl.TRIANGLES, 0, nv); }
      if (np) { g.pPt.use().u('uS', sU); gl.bindVertexArray(g.a.vao); gl.bindBuffer(gl.ARRAY_BUFFER, g.a.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pt.subarray(0, np * 8)); gl.drawArrays(gl.POINTS, 0, np); }
      if (S.fx.draw) S.fx.draw({ gl, G, sU, A, t });                                  // an effect's own drawing in FRONT of the hands
      gl.bindVertexArray(null); gl.enable(gl.DEPTH_TEST);
      S.drawMs += (performance.now() - b0 - S.drawMs) * 0.05;
    }

    /** for other modules: his hands as the layer has them. Frame units (x -A..A, y -1..1, y up), speeds in frame units a second. */
    function state() {
      return {
        on: S.on, effect: S.name, k: S.k, aspect: A,
        hands: S.mapped.filter((h) => !h.moving).map((h) => ({ id: h.id, side: h.side, on: h.on, held: h.held, k: h.k, x: h.x, y: h.y, vx: h.vx, vy: h.vy, size: h.size, pose: h.pose, poseFor: h.poseFor, facing: h.facing, tip: h.tip.slice(), dir: h.dir.slice(), pts: h.pts, z: h.z })),
        picture: S.last ? S.last.hands.map((h) => ({ id: h.id, side: h.side, on: h.on, x: h.x, y: h.y, vx: h.vx, vy: h.vy, size: h.size, pose: h.pose })) : [],
        core: S.core ? { ...S.core, beam: !!S.core.beam } : null, control: S.out ? { mode: S.out.mode, charge: S.out.charge, charging: S.out.charging, dir: S.out.dir, magnet: S.out.magnet, grabbing: S.out.grabbing, flying: S.out.flying } : null,
      };
    }
    return {
      setOn, setEffect, setRoom, input, face, pre, place, state,
      setGain: (g) => { S.gain = clamp(Number(g) || 0.8, 0.3, 2); },
      stats: () => ({ fx: S.fx && S.fx.stats ? S.fx.stats() : null, on: S.on, effect: S.name, k: S.k, room: S.room, points: np, ribbonVerts: nv, sparks: ns, drawMs: S.drawMs, mode: S.out ? S.out.mode : 'none', charge: S.out ? S.out.charge : 0, dir: S.out ? S.out.dir : 1, poses: S.last ? S.last.hands.map((h) => h.pose) : [] }),
      effects: () => Object.keys(EFFECTS),
    };
  }
  root.VTMaskHands = { create, register: (name, make) => { EFFECTS[name] = make; }, effects: () => Object.keys(EFFECTS) };
})(typeof globalThis !== 'undefined' ? globalThis : self);
