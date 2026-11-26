// V9 CAMERA MODE ("effects only", V9-PHASE2-SHOW.md item 1): his REAL camera is the picture. The Mask draws no face and
// no background; this file draws only what viewers send (gift missiles and their explosions, the lock-on, taps, chat
// streaks, follow / share rings, the big gifts) on a SEE-THROUGH 2D canvas, aimed at and landing on his tracked real
// face: its place in the picture, its size (= his distance), its turn.
// Pure UMD, no network. It reads the same numbers the Mask already has (mask-core.js: the pose fit, the eyes, the lip
// line; mask-fx.js: sample(t)), so every event that works on the Mask works here, with the same timing and sounds.
//
//   const cam = VTMaskCam.create();
//   cam.layer(canvas)                         the see-through 2D canvas the page puts over everything (never flipped)
//   cam.set(true | false, t)                  camera mode on / off; a 0.9 s fade either way, never a cut
//   cam.k(t)                                  0 (the Mask) .. 1 (camera mode); the page fades the Mask's canvas with 1 - k
//   cam.align({ flip, dx, dy, zoom, crop })   how the tracked picture sits in this page (see mapper below); remembered by the app
//   cam.showAlign(t, seconds = 8)             the Align helper: a thin outline on his tracked face, to compare with the camera
//   cam.face(lm, picW, picH)                  the tracker's raw landmarks (for the outline only)
//   cam.frame(t, { core, fx, pic })           once per drawn frame (mask-live.js calls it); returns k
//   cam.anchor()                              where his face is on the page right now: { x, y, unit (px between his eyes),
//                                             R, rx, ry (the head's half size, px), top (y above the head) } or null:
//                                             the hook for what comes later (boss bars above his head, the transforms)
//   cam.hooks.push((ctx, anchor, t, k) => {}) later layers (boss fight, countdown, transforms) draw after the effects
//
// THE RULE FOR HIS FACE (he reviews music on camera): what lands ON the face is quick (a flash, a ring, sparks that
// fly off: gone in well under half a second); whatever stays longer sits AROUND the head (the lock-on, auras, rings,
// the big gifts). Hits are steered off his eyes and mouth, and anything older than 0.35 s is not drawn over them.
//
// ALIGNMENT, as the code stands today: the tracker follows the camera's WHOLE picture, turned and flipped the way the
// camera item sits in the OBS scene (obs-scene.js viewOf), and the avatar page is laid exactly over that item's box
// (coverTransform). So a point at (u, v) of the tracked picture is at (u, v) of this page: no setup, as long as the
// item is not cropped in OBS. mapper() also takes a crop (the part of the picture the box shows), a flip, a nudge and
// a size for the cases where it is not.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskCam = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';
  const FADE = 0.9, LINGER = 0.35;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = (k) => k * k * (3 - 2 * k);
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const CHROME = [0.86, 0.84, 0.82], CRIMSON = [1.0, 0.16, 0.10], GOLD = [1.0, 0.62, 0.16], WHITE = [1.0, 0.95, 0.9];
  // MediaPipe's face mesh: the oval, the eyes, the outer lips (for the Align outline)
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const EYE_A = [33, 160, 158, 133, 153, 144], EYE_B = [362, 385, 387, 263, 373, 380], LIPS = [61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91];
  const DEFAULT_ALIGN = { flip: false, dx: 0, dy: 0, zoom: 1, crop: null, names: 0 };

  /** a saved / sent alignment, made safe: { flip, dx, dy (parts of the page, -0.5..0.5), zoom (0.5..2), crop: [x0, y0, x1, y1] | null } */
  function cleanAlign(o) {
    const a = o && typeof o === 'object' ? o : {}, n = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : d);
    let crop = null;
    if (Array.isArray(a.crop) && a.crop.length === 4) { const c = a.crop.map((v) => n(v, 0, 0, 1)); if (c[2] - c[0] > 0.05 && c[3] - c[1] > 0.05) crop = c; }
    // names: where the lane of the viewer names sits, up (-) or down (+) from just under his chin, in parts of the page
    return { flip: a.flip === true, dx: n(a.dx, 0, -0.5, 0.5), dy: n(a.dy, 0, -0.5, 0.5), zoom: n(a.zoom, 1, 0.5, 2), crop, names: n(a.names, 0, -0.8, 0.8) };
  }
  /**
   * The tracked picture -> this page. (u, v): 0..1 across / down the tracker's picture (MediaPipe's own numbers).
   * The part of the picture the camera item shows (`crop`, the whole picture when null) is laid over the page the way
   * OBS lays the page over the camera (it covers it, cut evenly), then flipped, sized about the middle and nudged.
   * -> { to(u, v) -> [x, y] page pixels, s: page pixels per picture pixel, sx: -1 when flipped }
   */
  function mapper({ picW, picH, pageW, pageH, crop = null, flip = false, dx = 0, dy = 0, zoom = 1 }) {
    const c = crop || [0, 0, 1, 1], cw = (c[2] - c[0]) * picW, ch = (c[3] - c[1]) * picH;
    const s0 = Math.max(pageW / cw, pageH / ch), s = s0 * zoom, mu = (c[0] + c[2]) / 2, mv = (c[1] + c[3]) / 2, sx = flip ? -1 : 1;
    return { s, sx, to: (u, v) => [pageW / 2 + sx * (u - mu) * picW * s + dx * pageW, pageH / 2 + (v - mv) * picH * s + dy * pageH] };
  }
  /**
   * The part of the tracked (upright) picture a camera item shows when it is CROPPED in the OBS scene, from the item's
   * obs-websocket transform: [x0, y0, x1, y1] in parts of the upright picture, or null (no crop). The crop numbers are
   * in pixels of the raw source; the item's flips and its turn (quarter turns, as obs-scene.js viewOf reads them)
   * carry them to the upright picture. Not proven against a real OBS, and not wired into the app yet.
   */
  function cropOf(t) {
    if (!t) return null;
    const sw = Number(t.sourceWidth) || 0, sh = Number(t.sourceHeight) || 0;
    let l = Number(t.cropLeft) || 0, r = Number(t.cropRight) || 0, tp = Number(t.cropTop) || 0, b = Number(t.cropBottom) || 0;
    if (!sw || !sh || !(l || r || tp || b)) return null;
    l /= sw; r /= sw; tp /= sh; b /= sh;
    if ((Number(t.scaleX) || 1) < 0) [l, r] = [r, l];
    if ((Number(t.scaleY) || 1) < 0) [tp, b] = [b, tp];
    const q = ((Math.round((Number(t.rotation) || 0) / 90) % 4) + 4) % 4;
    for (let i = 0; i < q; i++) [l, tp, r, b] = [b, l, tp, r];            // a quarter turn clockwise: the left edge becomes the top
    return [l, tp, 1 - r, 1 - b];
  }

  function create(opts = {}) {
    let trace = opts.trace === true;
    let canvas = null, ctx = null, on = false, tSet = -99, k0 = 0, al = { ...DEFAULT_ALIGN }, alignUntil = -99, alignFrom = -99;
    let raw = null, A = null, drew = false, ms = 0, sprites = 0;
    const cache = new Map(), ops = [], hooks = [];
    const st = { lastT: 0 };

    const kAt = (t) => { const e = clamp((t - tSet) / FADE, 0, 1); return on ? k0 + (1 - k0) * ease(e) : k0 * (1 - ease(e)); };
    function set(v, t) { v = !!v; if (v === on) return false; k0 = kAt(t); on = v; tSet = t; return true; }

    /** a soft round light in one colour: a hot middle, a wide fall-off. Made once per colour. */
    function sprite(col) {
      const key = (col[0] * 15 | 0) + ',' + (col[1] * 15 | 0) + ',' + (col[2] * 15 | 0);
      let s = cache.get(key);
      if (s) return s;
      const doc = root.document;
      if (doc && doc.createElement) {
        s = doc.createElement('canvas'); s.width = s.height = 64;
        const g = s.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32), c = (m, a) => 'rgba(' + Math.round(255 * Math.min(1, col[0] * m + (1 - m))) + ',' + Math.round(255 * Math.min(1, col[1] * m + (1 - m))) + ',' + Math.round(255 * Math.min(1, col[2] * m + (1 - m))) + ',' + a + ')';
        gr.addColorStop(0, c(0.15, 1)); gr.addColorStop(0.14, c(0.55, 0.95)); gr.addColorStop(0.34, c(1, 0.42)); gr.addColorStop(0.62, c(1, 0.12)); gr.addColorStop(1, c(1, 0));
        g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      } else s = { col };
      cache.set(key, s); return s;
    }
    const css = (col, a) => 'rgba(' + Math.round(255 * clamp(col[0], 0, 1)) + ',' + Math.round(255 * clamp(col[1], 0, 1)) + ',' + Math.round(255 * clamp(col[2], 0, 1)) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
    const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

    // ---- the two things everything is drawn with (age = how long this light has been there: older than LINGER, it keeps off his eyes and mouth)
    function spr(x, y, r, col, a, age, tag) {
      if (age > LINGER) a *= clearK(x, y);
      if (a < 0.012 || r < 0.3) return;
      if (trace) ops.push({ k: 's', x, y, r, a, age, tag });
      sprites++;
      ctx.globalAlpha = Math.min(1, a); ctx.drawImage(sprite(col), x - r, y - r, 2 * r, 2 * r);
    }
    function line(pts, col, a, w, age, tag, closed) {
      if (a < 0.012 || pts.length < 2) return;
      if (trace) ops.push({ k: 'l', pts, a, w, age, tag });
      sprites++;
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (closed) ctx.closePath();
      ctx.lineWidth = w * 3.2; ctx.strokeStyle = css(col, a * 0.22); ctx.stroke();          // the glow under the line
      ctx.lineWidth = w; ctx.strokeStyle = css(mix(col, WHITE, 0.45), a); ctx.stroke();
    }
    /** 0 on his eyes and mouth, 1 a little outside them (page pixels) */
    function clearK(x, y) {
      let k = 1;
      if (!A) return k;
      for (const z of A.zones) { const d = Math.hypot((x - z.x) / z.rx, (y - z.y) / z.ry); if (d < 1.45) k = Math.min(k, clamp((d - 1) / 0.45, 0, 1)); }
      return k;
    }

    // ---- where his face is on the page
    function anchorOf(core, pic) {
      const P = core.pose, R = P.Rabs || P.R, W = canvas.width, H = canvas.height;
      const M = mapper({ picW: pic.width, picH: pic.height, pageW: W, pageH: H, flip: al.flip, dx: al.dx, dy: al.dy, zoom: al.zoom, crop: al.crop });
      const s = P.size * pic.height, ox = P.x * pic.height / 2, oy = P.y * pic.height / 2, unit = s * M.s;
      /** a point of his head (mask-core's head space: 1 = between his eyes, x picture right, y up, z toward the camera) -> page pixels */
      const proj = (p) => {
        const X = ox + s * (R[0] * p[0] + R[1] * p[1] + R[2] * p[2]), Y = oy + s * (R[3] * p[0] + R[4] * p[1] + R[5] * p[2]);
        return M.to(0.5 + X / pic.width, 0.5 - Y / pic.height);
      };
      const eyes = core.eyes.map((e) => e.c), ring = core.mouth.ring, n = ring.length / 3, mc = [0, 0, 0];
      for (let i = 0; i < n; i++) { mc[0] += ring[i * 3] / n; mc[1] += ring[i * 3 + 1] / n; mc[2] += ring[i * 3 + 2] / n; }
      const open = clamp(core.mouth.open || 0, 0, 1);
      const zh = [{ c: [eyes[0][0], eyes[0][1], 0.1], r: 0.40 }, { c: [eyes[1][0], eyes[1][1], 0.1], r: 0.40 }, { c: [mc[0], mc[1], 0.2], r: 0.50 }];      // head space, for steering hits
      const zones = zh.map((z, i) => { const p = proj(z.c); return { x: p[0], y: p[1], rx: unit * (i < 2 ? 0.36 : 0.50), ry: unit * (i < 2 ? 0.26 : 0.27 + 0.30 * open) }; });
      const HC = [0, -0.35, 0.05], c = proj(HC), top = proj([0, 1.45, 0]);
      return { x: c[0], y: c[1], unit, R, rx: unit * 1.2, ry: unit * 1.55, top: top[1], proj, zones, zh, HC, W, H, sx: M.sx };
    }
    /** a hit is steered off his eyes and mouth (the same answer for the missile and for its landing) */
    function safe(p) {
      let q = p;
      for (let i = 0; i < A.zh.length; i++) {
        const z = A.zh[i], dx = q[0] - z.c[0], dy = q[1] - z.c[1], d = Math.hypot(dx, dy);
        if (d < z.r) { const ux = d > 1e-3 ? dx / d : 0, uy = d > 1e-3 ? dy / d : (i < 2 ? 1 : -1); q = [z.c[0] + ux * z.r, z.c[1] + uy * z.r, q[2]]; }
      }
      return q;
    }
    /** a circle that lies on his face (round `c`, head space) or round his head, as it looks from the camera: it turns with him */
    function loop(c, rx, ry, n = 44, a0 = 0, a1 = Math.PI * 2) {
      const pts = [];
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push(A.proj([c[0] + Math.cos(a) * rx, c[1] + Math.sin(a) * ry, c[2]])); }
      return pts;
    }
    const around = (r, n) => loop(A.HC, 1.2 * r, 1.55 * r, n);

    // ---- the effects
    function missiles(fx, kf) {
      const W = A.W, H = A.H;
      for (const m of fx.missiles) {
        const gift = m.size >= 1, tg = A.proj(safe(m.target)), top = m.start[1] > 3.55, side = (m.start[0] < 0 ? -1 : 1) * A.sx;
        const s0 = top ? [W / 2 + clamp(m.start[0] / 2, -1, 1) * 0.45 * W, -0.06 * H] : [side < 0 ? -0.08 * W : 1.08 * W, clamp(tg[1] - (m.start[1] - 0.6) * 0.20 * H, 0.04 * H, 0.9 * H)];
        const c0 = [(s0[0] + tg[0]) / 2, Math.min(s0[1], tg[1]) - (0.06 + 0.16 * m.seed) * H];
        const at = (u) => { const e = Math.pow(clamp(u, 0, 1), 1.55), a = (1 - e) * (1 - e), b = 2 * e * (1 - e), c = e * e; return [a * s0[0] + b * c0[0] + c * tg[0], a * s0[1] + b * c0[1] + c * tg[1], e]; };
        const base = A.unit * 0.20 * Math.sqrt(m.size), N = gift ? (fx.missiles.length > 8 ? 8 : 12) : 6, after = Math.max(0, m.u - 1);
        for (let j = N; j >= 1; j--) {                                     // the tail: where it has been, in the gift's colour, burning out after it lands
          const u = m.u - j * 0.032; if (u <= 0 || u >= 1) continue;
          const p = at(u), f = 1 - j / (N + 1);
          spr(p[0], p[1], base * (0.55 + 0.9 * f) * (1 + 1.3 * (1 - p[2])), m.col, kf * 0.55 * f * f * (1 - after * 2.2), 0, 'trail');
        }
        if (m.u < 1) {
          const p = at(m.u), z = 1 + 1.6 * (1 - p[2]);                     // big while it is near the lens, small as it reaches him
          spr(p[0], p[1], base * 2.3 * z, m.col, kf * 0.75, 0, 'missile');
          spr(p[0], p[1], base * 1.0 * z, WHITE, kf, 0, 'missile');
        }
      }
    }
    function bursts(fx, kf) {
      let live = 0; for (const b of fx.bursts) if (b.age < 0.16) live++;
      const share = 1 / Math.sqrt(Math.max(1, live));
      for (const b of fx.bursts) {
        const hp = safe(b.pos), c = A.proj(hp), U = A.unit, sz = Math.sqrt(b.size || 1), blast = b.blast > 0, age = b.age;
        // the flash: 5 frames at most, no wider than his face however big the gift, and shared out when many land at once (never a white-out)
        if (age < 0.16) { const q = age / 0.16, fr = Math.min(1.15, (0.22 + 0.75 * q) * sz * (blast ? 1 : 0.55)); spr(c[0], c[1], U * fr, mix(b.col, WHITE, 0.4), kf * (1 - q) * (1 - q) * 0.6 * share, age, 'flash'); spr(c[0], c[1], U * Math.min(0.4, (0.10 + 0.25 * q) * sz), WHITE, kf * (1 - q) * 0.6 * share, age, 'flash'); }
        if (blast && age < 0.42 && (live <= 3 || b.size >= 3)) { /* a salvo landing together: one ring, the big one's, not a dozen over his eyes */ const q = age / 0.42, r = (0.12 + 0.95 * q) * sz * 0.8; line(loop(hp, r, r, 30), mix(b.col, WHITE, 0.3), kf * (1 - q) * (1 - q) * 0.9, Math.max(1.2, U * 0.035 * (1 - q)), age, 'shock', true); }
        const n = blast ? Math.round(Math.min(40, 14 + 9 * b.size) * (live > 4 ? 0.5 : 1)) : 5;
        for (let i = 0; i < n; i++) {                                      // sparks: out fast, slowing, a little gravity, gone in under a second
          const h1 = hash(b.seed * 97 + i * 1.7), h2 = hash(b.seed * 31 + i * 5.3), h3 = hash(b.seed * 53 + i * 9.1), life = (blast ? 0.42 : 0.26) + 0.5 * h3 * (blast ? 1 : 0.2);
          if (age >= life) continue;
          const ang = h1 * Math.PI * 2, sp = (0.7 + 1.9 * h2) * sz * (blast ? 1 : 0.5), d = U * sp * (1 - Math.exp(-age * 4.2)), q = 1 - age / life;
          const x = c[0] + Math.cos(ang) * d, y = c[1] + Math.sin(ang) * d * 0.9 + U * 1.5 * age * age;
          spr(x, y, U * (0.035 + 0.05 * h3) * (0.6 + sz * 0.4), i % 3 ? b.col : WHITE, kf * q * q * 0.95, age, 'spark');
          if (live > 4) continue;
          const d2 = U * sp * (1 - Math.exp(-Math.max(0, age - 0.035) * 4.2));
          spr(c[0] + Math.cos(ang) * d2, c[1] + Math.sin(ang) * d2 * 0.9 + U * 1.5 * age * age, U * 0.03, b.col, kf * q * q * 0.5, age, 'spark');
        }
        if (blast && age < 1.5) {                                          // embers: they leave the face and rise round it
          const ne = Math.round(4 + 3 * b.size);
          for (let i = 0; i < ne; i++) {
            const h1 = hash(b.seed * 11 + i * 3.3), h2 = hash(b.seed * 71 + i * 7.7), life = 0.8 + 0.7 * h2; if (age >= life) continue;
            const q = 1 - age / life, dir = (h1 - 0.5) * 2, x = c[0] + dir * U * (0.5 + 1.6 * age), y = c[1] - U * (0.25 + 1.5 * h2) * age - U * 0.2 * Math.sin(age * 5 + i);
            spr(x, y, U * 0.045, i % 2 ? GOLD : CRIMSON, kf * q * 0.8 * Math.min(1, age * 8), age, 'ember');
          }
        }
      }
    }
    function lockOn(fx, kf) {
      const L = fx.lock; if (!L) return;
      const r = 1.22 + Math.max(0, L.r - 0.55) * 0.75, a = kf * L.a, U = A.unit;      // the ring closes ROUND his head, never over his eyes
      // a targeting reticle in the house colours (crimson ring, chrome ticks and corner brackets): this becomes the boss fight's target
      line(around(r, 52), CRIMSON, a * 0.9, Math.max(1.4, U * 0.024), 1, 'lock', true);
      line(around(r + 0.10, 52), CHROME, a * 0.35, Math.max(1, U * 0.012), 1, 'lock', true);
      const bx = 1.2 * (r + 0.42), by = 1.55 * (r + 0.42), bl = 0.34;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) line([A.proj([A.HC[0] + sx * bx, A.HC[1] + sy * (by - bl * 1.55), 0]), A.proj([A.HC[0] + sx * bx, A.HC[1] + sy * by, 0]), A.proj([A.HC[0] + sx * (bx - bl * 1.2), A.HC[1] + sy * by, 0])], CHROME, a, Math.max(1.6, U * 0.03), 1, 'lock');
      for (let i = 0; i < 4; i++) {                                        // four ticks, turning in
        const ang = i * Math.PI / 2 + (L.r - 0.55) * 1.4, ca = Math.cos(ang), sa = Math.sin(ang);
        line([A.proj([A.HC[0] + ca * 1.2 * (r - 0.10), A.HC[1] + sa * 1.55 * (r - 0.10), 0]), A.proj([A.HC[0] + ca * 1.2 * (r + 0.24), A.HC[1] + sa * 1.55 * (r + 0.24), 0])], CHROME, a, Math.max(1.5, U * 0.03), 1, 'lock');
      }
    }
    function glints(fx, kf) {
      for (const g of fx.glints) {                                         // a hard point of light at the EDGE of the picture: something is coming from there
        const side = g.side * A.sx, x = side < 0 ? 0.045 * A.W : 0.955 * A.W, y = clamp(A.y - g.y * 0.17 * A.H, 0.06 * A.H, 0.9 * A.H), a = kf * Math.sin(Math.PI * clamp(g.k, 0, 1)), r = A.W * 0.022 * g.size;
        spr(x, y, r * 2.2, g.col, a * 0.8, 1, 'glint'); spr(x, y, r, WHITE, a, 1, 'glint');
        line([[x - r * 4.5, y], [x + r * 4.5, y]], g.col, a * 0.8, 1.4, 1, 'glint'); line([[x, y - r * 2.2], [x, y + r * 2.2]], g.col, a * 0.6, 1.2, 1, 'glint');
      }
    }
    function aura(fx, kf, t) {
      const U = A.unit;
      if (fx.brace > 0.02) {                                               // the second before a big gift: light gathers round his head
        const b = fx.brace; line(around(2.3 - 0.75 * b, 52), WHITE, kf * b * 0.55, Math.max(1.2, U * 0.02), 1, 'brace', true);
        for (let i = 0; i < 18; i++) { const h = hash(i * 3.1), ph = (t * (0.9 + h) + h * 7) % 1, ang = h * 6.283 + i, r = 3.0 - 1.5 * ph, p = A.proj([A.HC[0] + Math.cos(ang) * 1.2 * r, A.HC[1] + Math.sin(ang) * 1.55 * r, 0]); spr(p[0], p[1], U * 0.05, GOLD, kf * b * ph * 0.9, 1, 'brace'); }
      }
      if (fx.pulse > 0.03 || fx.streak > 0.03) {                           // taps: his outline answers; a streak of taps makes it glow
        const p = Math.min(1.6, fx.pulse), s = fx.streak;
        line(around(1.02 + 0.05 * p, 52), mix(CRIMSON, GOLD, s), kf * Math.min(0.6, 0.30 * p + 0.4 * s), Math.max(1.2, U * (0.014 + 0.02 * s)), 1, 'tap', true);
      }
      for (let i = 0; i < 6; i++) {                                        // each batch of taps: a glint on the rim of his face, a short ripple along it
        const age = fx.taps[i * 4 + 3]; if (!(age < 0.7)) continue;
        const ang = Math.atan2(fx.taps[i * 4 + 1] + 0.35, fx.taps[i * 4] || 0.01) + i, q = age / 0.7, p = A.proj([A.HC[0] + Math.cos(ang) * 1.2 * 1.04, A.HC[1] + Math.sin(ang) * 1.55 * 1.04, 0]);
        spr(p[0], p[1], U * (0.10 + 0.25 * q), GOLD, kf * (1 - q) * (1 - q), 1, 'tap'); spr(p[0], p[1], U * 0.07, WHITE, kf * (1 - q), 1, 'tap');
        line(loop(A.HC, 1.2 * 1.04, 1.55 * 1.04, 10, ang - 0.25 - q * 0.6, ang + 0.25 + q * 0.6), GOLD, kf * (1 - q) * 0.8, Math.max(1.2, U * 0.025), 1, 'tap');
      }
      if (fx.ring[1] > 0 && fx.ring[0] < 1.2) {                            // a follow, a share, a big gift: a ring leaves his outline and runs out
        const q = fx.ring[0] / 1.2; line(around(1.15 + 3.4 * q * (0.6 + 0.4 * fx.ring[1]), 60), fx.ringCol, kf * (1 - q) * (1 - q) * 0.9, Math.max(1.5, U * 0.05 * (1 - q)), 1, 'ring', true);
      }
      if (fx.scale > 1.02) {                                               // the "grow" gift: he cannot grow, so the light round him does: rays and rising embers
        const g = clamp((fx.scale - 1) / 0.45, 0, 1.3);
        line(around(1.12 + 0.25 * g, 52), GOLD, kf * 0.7 * Math.min(1, g), Math.max(1.5, U * 0.03), 1, 'grow', true);
        for (let i = 0; i < 26; i++) {
          const h = hash(i * 7.3), ang = i / 26 * 6.283 + 0.1 * Math.sin(t * 3 + i), fl = 0.6 + 0.4 * Math.sin(t * 9 + h * 20), r0 = 1.2 + 0.25 * g, r1 = r0 + g * (0.5 + 1.1 * h) * fl;
          line([A.proj([A.HC[0] + Math.cos(ang) * 1.2 * r0, A.HC[1] + Math.sin(ang) * 1.55 * r0, 0]), A.proj([A.HC[0] + Math.cos(ang) * 1.2 * r1, A.HC[1] + Math.sin(ang) * 1.55 * r1, 0])], i % 3 ? GOLD : WHITE, kf * 0.5 * Math.min(1, g) * fl, Math.max(1.2, U * 0.022), 1, 'grow');
          const ph = (t * (0.35 + 0.3 * h) + h) % 1, ex = A.x + (h - 0.5) * 2 * A.rx * 1.5, ey = A.y + A.ry * (1.1 - 2.9 * ph);
          spr(ex, ey, U * 0.05, i % 2 ? GOLD : CRIMSON, kf * Math.min(1, g) * Math.sin(Math.PI * ph) * 0.85 * (Math.abs(ex - A.x) > A.rx * 0.95 || ey < A.top ? 1 : 0), 1, 'grow');
        }
      }
      if (fx.shatter > 0.04) {                                             // the biggest gift: a detonation thrown out from his outline; the sparks are pulled back as it cools
        const sh = fx.shatter, heat = fx.rainbow, col = heat > 0.5 ? mix(GOLD, WHITE, (heat - 0.5) * 2) : mix(CRIMSON, GOLD, heat * 2);
        for (let i = 0; i < 64; i++) {
          const h1 = hash(i * 1.37), h2 = hash(i * 4.91), ang = h1 * 6.283, r = 1.3 + sh * (0.6 + 2.6 * h2), p = A.proj([A.HC[0] + Math.cos(ang) * 1.2 * r, A.HC[1] + Math.sin(ang) * 1.55 * r, 0]);
          spr(p[0], p[1], U * (0.04 + 0.07 * h2), i % 4 ? col : WHITE, kf * Math.min(0.8, sh * 1.2) * (0.5 + 0.5 * h1), 1, 'shatter');
        }
        line(around(1.2 + 0.5 * sh, 52), col, kf * Math.min(0.9, sh), Math.max(1.5, U * 0.04), 1, 'shatter', true);
      }
    }
    /** a big moment: a thin line of light on the very edge of the picture for a few frames; never a wash, never over him */
    function edgeFlash(fx, kf) {
      const a = Math.min(0.3, fx.flash[3] * 0.6) * kf; if (a < 0.02) return;
      const W = A.W, H = A.H, col = mix([fx.flash[0], fx.flash[1], fx.flash[2]], CRIMSON, 0.5), d = 0.05 * W;
      if (trace) ops.push({ k: 'e', a, tag: 'flash-edge' });
      ctx.globalAlpha = 1;
      for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 0, d, 0, 0, 0, d, H], [W, 0, W - d, 0, W - d, 0, d, H], [0, 0, 0, d, 0, 0, W, d], [0, H, 0, H - d, 0, H - d, W, d]]) {
        const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, css(col, a * 0.85)); g.addColorStop(1, css(col, 0));
        ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
      }
    }
    /** the switch itself is a small moment: one thin crimson ring runs out from his head (on) or closes on it (off) */
    function switchRing(t, k) {
      const age = t - tSet; if (age < 0 || age > 0.8 || !A) return;
      const q = age / 0.8, r = on ? 1.1 + 2.6 * q : 3.7 - 2.6 * q;
      line(around(r, 52), CRIMSON, (1 - q) * 0.8, Math.max(1.4, A.unit * 0.03), 1, 'switch', true);
    }
    function outline(t) {
      if (t >= alignUntil || !raw) return;
      const a = Math.min(1, (t - alignFrom) / 0.25, (alignUntil - t) / 0.8), M = mapper({ picW: raw.w, picH: raw.h, pageW: canvas.width, pageH: canvas.height, ...al });
      const pts = (idx) => idx.map((i) => M.to(raw.lm[i * 3], raw.lm[i * 3 + 1]));
      line(pts(OVAL), CRIMSON, a, 2, 0, 'align', true); line(pts(EYE_A), WHITE, a * 0.9, 1.5, 0, 'align', true); line(pts(EYE_B), WHITE, a * 0.9, 1.5, 0, 'align', true); line(pts(LIPS), WHITE, a * 0.9, 1.5, 0, 'align', true);
      const n = M.to(raw.lm[3], raw.lm[4]); line([[n[0] - 9, n[1]], [n[0] + 9, n[1]]], WHITE, a, 1.5, 0, 'align'); line([[n[0], n[1] - 9], [n[0], n[1] + 9]], WHITE, a, 1.5, 0, 'align');
    }

    function frame(t, { core, fx, pic }) {
      const k = kAt(t); st.lastT = t;
      if (!ctx || !canvas) return k;
      const b = root.performance ? root.performance.now() : 0;
      if (trace) ops.length = 0;
      sprites = 0;
      const helper = t < alignUntil && raw;
      if (k <= 0 && !helper && t - tSet > 0.85) { if (drew) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); drew = false; } return k; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      A = core && pic && pic.width ? anchorOf(core, pic) : null;
      if (A && fx) {
        ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const kx = fx.kick[0] * A.unit * 0.22, ky = fx.kick[1] * A.unit * 0.22;      // a landing shakes the effects (his camera cannot shake)
        ctx.setTransform(1, 0, 0, 1, kx, ky);
        if (k > 0) { aura(fx, k, t); lockOn(fx, k); glints(fx, k); missiles(fx, k); bursts(fx, k); }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (k > 0) edgeFlash(fx, k);
        switchRing(t, k);
        for (const h of hooks) { try { h(ctx, A, t, k); } catch (e) { /* a later layer must never take the effects down */ } }
      }
      if (helper) { ctx.globalCompositeOperation = 'source-over'; outline(t); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      drew = true;
      if (root.performance) ms += (root.performance.now() - b - ms) * 0.05;
      return k;
    }
    // ---- who sent it: ONE name at a time, queued, in one lane just under his chin (never stacked, never up in his show banner)
    const NQ = { seen: [], queue: [], cur: null };
    /** list = mask.names() (mask-fx.js); -> null | { text, kind, a (0..1), fx, fy (the middle of the line, parts of the page) } */
    function callout(list, t) {
      for (const it of list || []) {
        const t0 = t - it.age;
        if (NQ.seen.some((s) => s.text === it.text && Math.abs(s.t0 - t0) < 0.3)) continue;
        NQ.seen.push({ text: it.text, t0 }); if (NQ.seen.length > 24) NQ.seen.shift();
        NQ.queue.push({ text: it.text, kind: it.kind }); if (NQ.queue.length > 6) NQ.queue.shift();
      }
      if (NQ.cur && t >= NQ.cur.t1) NQ.cur = null;
      if (!NQ.cur && NQ.queue.length) NQ.cur = { ...NQ.queue.shift(), t0: t, t1: t + 2.0 };
      const c = NQ.cur; if (!c || !canvas) return null;
      const age = t - c.t0, W = canvas.width, H = canvas.height;
      return { text: c.text, kind: c.kind, a: clamp(Math.min(age / 0.2, (2.0 - age) / 0.3), 0, 1), fx: A ? clamp(A.x / W, 0.3, 0.7) : 0.5, fy: clamp((A ? (A.y + A.ry * 1.22) / H : 0.6) + al.names, 0.06, 0.92) };
    }
    return {
      callout,
      layer(c) { canvas = c || null; ctx = c ? c.getContext('2d') : null; drew = true; return !!ctx; },
      set, k: kAt, on: () => on, active: (t) => on || kAt(t) > 0 || t < alignUntil || t - tSet < 0.9,
      align(o) { al = cleanAlign(o); return { ...al }; }, alignment: () => ({ ...al }),
      showAlign(t, seconds = 8) { alignFrom = t; alignUntil = t + Math.max(0, seconds); },
      face(lm, w, h) { if (!lm || !w || !h) return; if (!raw || raw.lm.length !== lm.length) raw = { lm: new Float32Array(lm.length), w, h }; raw.lm.set(lm); raw.w = w; raw.h = h; },
      frame, hooks,
      anchor: () => (A ? { x: A.x, y: A.y, unit: A.unit, R: A.R, rx: A.rx, ry: A.ry, top: A.top, zones: A.zones } : null),
      /** for tests and tools: where a head-space point is on the page now, the steered hit, what was drawn last frame */
      debug: { trace(v) { trace = !!v; }, project: (p) => (A ? A.proj(p) : null), safe: (p) => (A ? safe(p) : p), ops, clearK },
      stats: () => ({ on, k: kAt(st.lastT), ms, drawn: sprites, align: { ...al } }),
    };
  }
  return { create, mapper, cropOf, cleanAlign, FADE, LINGER, DEFAULT_ALIGN };
});
