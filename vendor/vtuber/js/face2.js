// v2 face: ONE continuously animated face per hero, built every frame from parts (js/face-map.js names the parameters).
//
// Painter (plain 2D canvas, no 3D needed): draws the face picture in the approved style from
//   - the BLANK face (the approved skin, blush and fixed marks; tools/build_face_parts.py),
//   - the iris art, the eye outline with the upper lash, and the brow stroke CUT from the approved pictures and moved:
//     the outline's columns slide to follow the eyelids, the brow strip is laid along a curve,
//   - eyelid curves TRACED from the approved pictures (closed, half, neutral, wide), blended by `eyeOpen`,
//   - a mouth drawn by code (lip line, opening, teeth, tongue) in the colours measured from the art.
// Face2Rig (needs window.BABYLON and js/face.js): lays that picture on the head with the same head-space projection
// and depth gating as v1 (the atlas still supplies the depth cell and the "how much of the model's face is replaced"
// alpha), from a dynamic texture that is redrawn each frame.
// All geometry is in CELL pixels (the atlas cell, 768 px = picture px * 0.75); L / R = picture left / right.
(function (root) {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const rgb = (c, a) => (a == null ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')');
  const SIDES = ['L', 'R'];
  /** Rest value of every parameter the painter reads (the approved neutral): what a non-finite parameter is drawn as. */
  const SAFE = { browL_y: 0, browR_y: 0, browL_ang: 0, browR_ang: 0, browL_bend: 0, browR_bend: 0, eyeL_open: 1, eyeR_open: 1, eyeL_squint: 0, eyeR_squint: 0,
    eyeL_happy: 0, eyeR_happy: 0, gazeX: 0, gazeY: 0, pupil: 1, mouthOpen: 0, mouthWide: 0, mouthCornerL: 0, mouthCornerR: 0, mouthRound: 0, mouthPress: 0,
    mouthTeeth: 0, mouthTongue: 0, mouthX: 0, blush: 0 };

  /** Per hero: what the tracer cannot know (measured by eye on the approved pictures, cell px). */
  const STYLE = {
    ryo: {
      eyeStops: [0, 0.55, 1, 1.4],            // eyeOpen value of the closed / half / neutral / wide lid shapes
      gaze: [25, 20],                         // iris travel in px at gaze = 1 (x, y)
      squint: 0.36, happyArc: 0.36, happyDrop: 0.10, lashFill: 0,
      // which cut-out outline is drawn between two traced lid shapes: the upper one from this share of the way up.
      // [closed -> half, half -> neutral, neutral -> wide]. Ryo's NARROWED eyes (0.55-0.9: looking down, a squint) keep
      // the clean, heavy lash of the approved half-closed ("bored") eye almost up to neutral: the neutral lash of his
      // picture-right eye lies half under the brow in the approved picture and tore into pieces when it was bent down.
      handOver: [0.3, 0.8, 0.3], shutBelow: 0.17,
      rim: { colour: [25, 18, 19], alpha: 0.8, width: 1.9 },   // the thin line round the eye opening
      brow: { rise: 30, drop: 20, angry: 15, worried: 30, bend: 15, slide: 5, thin: 0.3 },
      blush: [[156, 438, 46, 24], [566, 428, 44, 24]], blushColour: [255, 120, 120],
      mouth: {
        L: [315, 515], M: [368, 520], R: [429, 504],        // the neutral lip line: left end, lowest point, right end
        corner: 34, wide: 0.93, openH: 128, lift: 0.10, line: 6.2, outline: 5.6,
        lineColour: [25, 18, 19], outlineColour: [25, 18, 19], inside: [92, 30, 34], insideLow: [150, 36, 38],
        teeth: [253, 250, 248], teethH: [9, 0.13], tongue: [228, 118, 110], box: 0.06,
      },
    },
    melanie: {
      eyeStops: [0, 0.5, 1, 1.4],
      gaze: [18, 14],
      squint: 0.42, happyArc: 0.34, happyDrop: 0.12, lashFill: 13,
      // (closed -> half: the thin closed arc takes over early, so a nearly shut eye is a lash line with a sliver under it,
      //  not the thick bar of the half-closed lash)
      handOver: [0.55, 0.3, 0.3], shutBelow: 0.12,
      rim: { colour: [140, 80, 72], alpha: 0.55, width: 1.6 },
      // rest: degrees added to the traced stroke angle (negative = outer end up). Her strokes are level in the approved
      // picture, but laid on the round forehead and seen in the avatar's framing they ran DOWN toward the temples, which
      // read as a worried face in every frame; this brings them level again on the model.
      brow: { rise: 20, drop: 12, angry: 14, worried: 16, bend: 10, slide: 3, thin: 0.15, rest: -10 },
      blush: [[205, 432, 52, 22], [560, 428, 52, 22]], blushColour: [240, 110, 110],
      mouth: {
        L: [349, 459.5], M: [383, 459.6], R: [417, 459],
        // round 5: her mouth is 68 px wide at rest (Ryo's 114) and talking shapes were hard to read at phone size. The
        // resting line is the approved one; an OPEN mouth is drawn wider (talkW) and taller (openH 64 -> 84), a wide one wider.
        corner: 10.5, wide: 0.72, openH: 84, talkW: 0.34, lift: 0.34, line: 4.2, outline: 3.4,
        lineColour: [120, 52, 58], outlineColour: [62, 18, 24], inside: [86, 24, 32], insideLow: [150, 50, 58],
        teeth: [250, 244, 240], teethH: [4, 0.1], tongue: [208, 106, 108], box: 0.2,
      },
    },
  };

  class Painter {
    /** data: assets/faces/<hero>-parts.json; image: the parts picture (HTMLImageElement / ImageBitmap); canvas: where to draw. */
    constructor(data, image, canvas) {
      this.d = data; this.img = image; this.canvas = canvas; this.s = STYLE[data.id];
      canvas.width = data.region[2]; canvas.height = data.region[3];
      this.ctx = canvas.getContext('2d');
      const n = this.n = data.eyes[0].keys.neutral.x.length;
      this.X = new Float32Array(n); this.T = new Float32Array(n); this.B = new Float32Array(n);
      for (const eye of data.eyes) {
        const k = eye.keys.neutral;
        let h = 0;
        for (let i = 0; i < n; i++) h = Math.max(h, k.bot[i] - k.top[i]);
        eye.H = h;                                               // the neutral opening, the unit for squint and arcs
        eye.yIn = (k.top[0] + k.bot[0]) / 2; eye.yOut = (k.top[n - 1] + k.bot[n - 1]) / 2;
      }
      this.ms = 0; this.pick = [null, null];
    }

    /** Lid curves of eye e for the given parameters, into this.X / T / B (top and bottom of the opening). */
    lids(e, open, squint, happy) {
      const eye = this.d.eyes[e], n = this.n, stops = this.s.eyeStops, names = ['closed', 'half', 'neutral', 'wide'];
      open = clamp(open, stops[0], stops[3]);
      let i = 0;
      while (i < 2 && open > stops[i + 1]) i++;
      const a = eye.keys[names[i]], b = eye.keys[names[i + 1]], t = (open - stops[i]) / (stops[i + 1] - stops[i]);
      const X = this.X, T = this.T, B = this.B, H = eye.H;
      for (let k = 0; k < n; k++) {
        const s = k / (n - 1), bulge = Math.pow(Math.sin(Math.PI * s), 0.8);
        X[k] = lerp(a.x[k], b.x[k], t);
        let top = lerp(a.top[k], b.top[k], t), bot = lerp(a.bot[k], b.bot[k], t);
        bot -= squint * this.s.squint * H * bulge;               // the lower lid rises in the middle
        if (bot < top) top = bot = (top + bot) / 2;
        if (happy > 0) {
          const arc = lerp(eye.yIn, eye.yOut, s) + this.s.happyDrop * H - this.s.happyArc * H * Math.pow(Math.sin(Math.PI * s), 0.9);
          top = lerp(top, arc, happy); bot = lerp(bot, arc, happy);
        }
        T[k] = top; B[k] = bot;
      }
    }

    _opening(ctx, grow) {
      const X = this.X, T = this.T, B = this.B, n = this.n;
      ctx.beginPath();
      ctx.moveTo(X[0], T[0] - grow);
      for (let k = 1; k < n - 1; k++) ctx.quadraticCurveTo(X[k], T[k] - grow, (X[k] + X[k + 1]) / 2, (T[k] + T[k + 1]) / 2 - grow);
      ctx.lineTo(X[n - 1], T[n - 1] - grow);
      ctx.lineTo(X[n - 1], B[n - 1] + grow);
      for (let k = n - 2; k > 0; k--) ctx.quadraticCurveTo(X[k], B[k] + grow, (X[k] + X[k - 1]) / 2, (B[k] + B[k - 1]) / 2 + grow);
      ctx.lineTo(X[0], B[0] + grow);
      ctx.closePath();
    }

    _eye(e, p) {
      const ctx = this.ctx, d = this.d, eye = d.eyes[e], S = SIDES[e], st = this.s, n = this.n, img = this.img;
      const open = this.lidSync != null ? this.lidSync : p['eye' + S + '_open'], squint = clamp(p['eye' + S + '_squint'], 0, 1), happy = clamp(p['eye' + S + '_happy'], 0, 1);
      // Melanie: the whole eye is drawn INSIDE its lens (a clip path a little in from the lens' rim). When the head turns,
      // the 3D glasses frame slides off the rim; what shows there is clean skin and a clean lash end, never fragments.
      const lens = eye.lens;
      if (lens) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(lens[0][0], lens[0][1]);
        for (let k = 1; k < lens.length; k++) ctx.lineTo(lens[k][0], lens[k][1]);
        ctx.closePath();
        ctx.clip();
      }
      this._eyeParts(e, p, open, squint, happy);
      if (lens) { ctx.restore(); ctx.setTransform(1, 0, 0, 1, -d.region[0], -d.region[1]); }
    }

    _eyeParts(e, p, open, squint, happy) {
      const ctx = this.ctx, d = this.d, eye = d.eyes[e], S = SIDES[e], st = this.s, n = this.n, img = this.img;
      // the last sliver before "shut" is drawn shut: a slit of bare iris under the lash read as a red line
      if (open < st.shutBelow) open = 0;
      this.lids(e, open, squint, happy);
      const X = this.X, T = this.T, B = this.B;
      let gap = 0;
      for (let k = 0; k < n; k++) gap = Math.max(gap, B[k] - T[k]);
      // --- the eye itself: white, then the iris art, both only inside the opening
      if (gap > 0.6) {
        ctx.save();
        this._opening(ctx, 1.2);
        ctx.clip();
        ctx.fillStyle = rgb(d.colours.white);
        ctx.fillRect(X[0] - 4, eye.keys.wide.top.reduce((a, b) => Math.min(a, b)) - 30, X[n - 1] - X[0] + 8, 260);
        const sp = d.sprites['iris' + S], ir = eye.iris, sc = clamp(p.pupil, 0.6, 1.3);
        const w = sp[2] * sc, h = sp[3] * sc;
        const cx = ir.cx + clamp(p.gazeX, -1.2, 1.2) * st.gaze[0], cy = ir.cy - clamp(p.gazeY, -1.2, 1.2) * st.gaze[1];
        ctx.drawImage(img, sp[0], sp[1], sp[2], sp[3], cx - w / 2, cy - h / 2, w, h);
        ctx.restore();
      }
      // --- a thin line all round the opening (the approved eyes have one along the lower lid and the inner side;
      //     along the top it lies under the lash). A raised lower lid (squint) gets a stronger line.
      if (gap > 0.6) {
        ctx.strokeStyle = rgb(st.rim.colour, st.rim.alpha);
        ctx.lineWidth = st.rim.width; ctx.lineJoin = 'round';
        this._opening(ctx, 0.3);
        ctx.stroke();
        if (squint > 0.05) {
          ctx.strokeStyle = rgb(d.colours.ink);
          ctx.lineWidth = 1.5 + 3 * squint; ctx.lineCap = 'round';
          ctx.beginPath();
          const a0 = Math.round(0.1 * (n - 1)), a1 = Math.round(0.9 * (n - 1));
          ctx.moveTo(X[a0], B[a0]);
          for (let k = a0 + 1; k < a1; k++) ctx.quadraticCurveTo(X[k], B[k], (X[k] + X[k + 1]) / 2, (B[k] + B[k + 1]) / 2);
          ctx.stroke();
        }
      }
      // --- a plain lash band along the upper lid, under the cut-out outline: where the approved picture's lash is
      //     hidden (Melanie's glasses frame covers most of it) the lid still has a solid line when it comes down
      if (st.lashFill > 0) {
        // (thinner as the lid comes down past half: a nearly closed eye is a lash line with a sliver under it, not a dark bar)
        const lf = st.lashFill * lerp(0.45, 1, clamp(open * (1 - happy) / st.eyeStops[1], 0, 1));
        ctx.fillStyle = rgb(d.colours.ink);
        ctx.beginPath();
        ctx.moveTo(X[0], T[0] + 1);
        for (let k = 1; k < n; k++) ctx.lineTo(X[k], T[k] + 1);
        for (let k = n - 1; k >= 0; k--) ctx.lineTo(X[k], T[k] - lf * (0.45 + 0.55 * Math.pow(Math.sin(Math.PI * k / (n - 1)), 0.6)));
        ctx.closePath();
        ctx.fill();
      }
      // --- the eye outline (upper lash, corner flicks, side line), cut from the approved pictures: the outline of
      //     the NEAREST traced eye shape, bent to the current lids. A more open shape bends down well, so it is used
      //     for most of the way to the next shape below it. Exactly one outline is drawn (never two blended); the
      //     hand-over point has a little hysteresis so a lid resting near it does not flip between two line weights.
      const eff = open * (1 - happy), stops = st.eyeStops, names = ['closed', 'half', 'neutral', 'wide'];
      let i = 0;
      while (i < 2 && eff > stops[i + 1]) i++;
      const u = clamp((eff - stops[i]) / (stops[i + 1] - stops[i]), 0, 1), AT = st.handOver[i], HYST = 0.06;
      const was = this.pick[e];
      let key = u > AT ? names[i + 1] : names[i];
      if (Math.abs(u - AT) < HYST && (was === names[i] || was === names[i + 1])) key = was;
      this.pick[e] = key;
      this._outline(e, key, 1);
    }

    /** One traced eye outline, its columns moved so its upper part rides this.T and its lower part this.B. */
    _outline(e, key, alpha) {
      const d = this.d, eye = d.eyes[e], n = this.n, img = this.img;
      const sp = d.sprites['lash' + SIDES[e] + '_' + key], kw = eye.keys[key];
      if (!sp) return;
      // a half-transparent outline is drawn opaque on a scratch canvas first, then laid on in one piece
      let ctx = this.ctx;
      if (alpha < 0.999) {
        if (!this.tmp) { this.tmp = document.createElement('canvas'); this.tmp.width = d.region[2]; this.tmp.height = d.region[3]; this.tctx = this.tmp.getContext('2d'); }
        ctx = this.tctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.tmp.width, this.tmp.height);
      }
      const ox = -d.region[0], oy = -d.region[1];
      const X = this.X, T = this.T, B = this.B;
      const xw0 = kw.x[0], xw1 = kw.x[n - 1], xc0 = X[0], xc1 = X[n - 1], scale = (xc1 - xc0) / (xw1 - xw0), SW = 4, EDGE = 14;
      const h = sp[3], ay = sp[5];
      const at = (xs, out) => {                                          // lids of the traced shape and of the current one at picture x
        const sc = clamp((xs - xw0) / (xw1 - xw0), 0, 1), f = sc * (n - 1), k0 = Math.min(n - 2, f | 0), ft = f - k0;
        out[0] = lerp(kw.top[k0], kw.top[k0 + 1], ft); out[1] = lerp(kw.bot[k0], kw.bot[k0 + 1], ft);
        out[2] = lerp(T[k0], T[k0 + 1], ft); out[3] = lerp(B[k0], B[k0 + 1], ft);
      };
      const a = [0, 0, 0, 0], b = [0, 0, 0, 0], c = [0, 0, 0, 0];
      for (let i = 0; i < sp[2]; i += SW) {
        const w = Math.min(SW, sp[2] - i), xl = sp[4] + i, xs = xl + w / 2, se = (xs - xw0) / (xw1 - xw0);
        at(xl, a); at(xl + w, b); at(xs, c);
        const inside = se >= 0 && se <= 1;
        const xd = se < 0 ? xc0 + (xs - xw0) : se > 1 ? xc1 + (xs - xw1) : xc0 + se * (xc1 - xc0);
        const wd = (inside ? w * scale : w), x0 = xd - wd / 2, sx = sp[0] + i, sy = sp[1];
        // rows: [0, ru) above the opening ride the upper lid; [rl, h) below it ride the lower lid; between them
        // (only the side line at the eye's ends has ink there) the column stretches with the opening.
        // Each piece is sheared by the slope of its lid across the slice, so neighbouring slices join without steps.
        const ru = clamp(Math.round(c[0] - ay) + 1, 0, h), rl = clamp(Math.max(ru, Math.round(c[1] - ay) - 1), 0, h);
        const du = c[2] - c[0], dl = c[3] - c[1];
        const su = ((b[2] - b[0]) - (a[2] - a[0])) / wd, sl = ((b[3] - b[1]) - (a[3] - a[1])) / wd;
        if (ru > 0) {
          ctx.setTransform(1, su, 0, 1, x0 + ox, ay + du - su * wd / 2 + oy);
          ctx.drawImage(img, sx, sy, w, ru, 0, 0, wd + 0.7, ru);
        }
        if (rl < h) {
          ctx.setTransform(1, sl, 0, 1, x0 + ox, ay + rl + dl - sl * wd / 2 + oy);
          ctx.drawImage(img, sx, sy + rl, w, h - rl, 0, 0, wd + 0.7, h - rl);
        }
        if (rl > ru && (!inside || xs - xw0 < EDGE || xw1 - xs < EDGE)) {
          const y0 = ay + ru + du, y1 = ay + rl + dl;
          if (y1 - y0 > 0.5) { ctx.setTransform(1, 0, 0, 1, x0 + ox, oy); ctx.drawImage(img, sx, sy + ru, w, rl - ru, 0, y0, wd + 0.7, y1 - y0); }
        }
      }
      if (ctx !== this.ctx) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.globalAlpha = alpha;
        this.ctx.drawImage(this.tmp, 0, 0);
        this.ctx.globalAlpha = 1;
      }
      this.ctx.setTransform(1, 0, 0, 1, ox, oy);
    }

    _brow(e, p) {
      const ctx = this.ctx, d = this.d, b = d.eyes[e].brow, S = SIDES[e], st = this.s.brow, sp = d.sprites.brow;
      const y = clamp(p['brow' + S + '_y'], -1, 1), ang = clamp(p['brow' + S + '_ang'], -1, 1), bend = clamp(p['brow' + S + '_bend'], -1, 1);
      const dir = e === 0 ? -1 : 1;                        // which way "outward" is in the picture
      const dy = y >= 0 ? -y * st.rise : -y * st.drop;
      const theta = (b.angle + (st.rest || 0) + (ang < 0 ? ang * st.angry : ang * st.worried)) * Math.PI / 180;   // outward frame, y down
      const base = b.angle * Math.PI / 180, len = b.len, pivot = 0.45 * len;
      // turn about a point 45 % along the stroke, so "angry" drops the inner end and lifts the outer one
      const px = pivot * Math.cos(base), py = pivot * Math.sin(base);
      const ox = px - pivot * Math.cos(theta) - Math.max(0, -ang) * st.slide, oy = py - pivot * Math.sin(theta) + dy;
      const thick = 1 - st.thin * Math.max(0, y) * (0.5 + 0.5 * Math.max(0, bend));
      const DU = 8, cos = Math.cos(theta), sin = Math.sin(theta);
      for (let u0 = -b.pad; u0 < sp[2] - b.pad; u0 += DU) {
        const um = clamp((u0 + DU / 2) / len, 0, 1);
        const off = -bend * st.bend * 4 * um * (1 - um), slope = -bend * st.bend * 4 * (1 - 2 * um) / len;
        const phi = theta + Math.atan(slope);
        const ux = u0 * cos - off * sin + ox, uy = u0 * sin + off * cos + oy;       // outward frame
        const c = Math.cos(phi), s = Math.sin(phi);
        const w = Math.min(DU + 1, sp[2] - (u0 + b.pad));
        // strip x -> along the stroke (mirrored for the picture-left brow), strip y -> across it
        ctx.setTransform(dir * c, s, -dir * s * thick, c * thick, b.inner[0] + dir * ux - d.region[0], b.inner[1] + uy - d.region[1]);
        ctx.drawImage(this.img, sp[0] + u0 + b.pad, sp[1], w, sp[3], 0, -b.mid, w, sp[3]);
      }
      ctx.setTransform(1, 0, 0, 1, -d.region[0], -d.region[1]);
    }

    _mouth(p) {
      const ctx = this.ctx, m = this.s.mouth;
      const open = clamp(p.mouthOpen, 0, 1), wide = clamp(p.mouthWide, -1, 1), round = clamp(p.mouthRound, 0, 1), press = clamp(p.mouthPress, 0, 1);
      const cl = clamp(p.mouthCornerL, -1.2, 1.6), cr = clamp(p.mouthCornerR, -1.2, 1.6);
      const w0 = (m.R[0] - m.L[0]) / 2, cx0 = (m.R[0] + m.L[0]) / 2;
      let w = w0 * (wide >= 0 ? 1 + m.wide * wide : 1 + 0.6 * wide * (1 - 0.7 * round)) * (1 - 0.5 * round) * (1 + 0.1 * press);
      w *= 1 + 0.12 * Math.max(0, cl + cr) * 0.5 * (1 - round);        // a smile is a little wider
      if (m.talkW) w *= 1 + m.talkW * clamp((open - 0.06) / 0.3, 0, 1) * (1 - 0.5 * round);   // a small mouth opens wider as it talks
      // the first few percent of opening only part the lips: still a line (a 2 px slit of mouth interior reads as a red lip)
      const h = Math.max(0, open - 0.035) / 0.965 * m.openH * (1 - 0.25 * press);
      const sx = clamp(p.mouthX, -1, 1) * w0 * 0.35;
      const flat = 1 - 0.8 * press;                                       // pressed lips: a straight line
      const cg = m.corner * (1 - 0.6 * round);
      // corners: the neutral ends, raised or lowered; an open mouth hangs from them
      const lift = m.lift * h;                                            // the upper lip rises a little as the mouth opens
      const yl = lerp(m.M[1], m.L[1], flat * (1 - round)) - cl * cg - lift, yr = lerp(m.M[1], m.R[1], flat * (1 - round)) - cr * cg - lift;
      const xl = cx0 + sx - w, xr = cx0 + sx + w, xm = cx0 + sx + (m.M[0] - cx0) * (1 - round);
      // the lip line's lowest (or highest) point: stays near the neutral line while the corners move
      const ym = m.M[1] - lift - 0.22 * (cl + cr) * 0.5 * cg + (lerp((yl + yr) / 2, m.M[1] - lift, flat) - (m.M[1] - lift)) * (1 - flat);
      if (!(h >= 1.2)) {
        // closed: one tapered stroke through left end, middle, right end
        const lw = m.line * (1 + 0.45 * press);
        const cxq = 2 * xm - (xl + xr) / 2, cyq = 2 * ym - (yl + yr) / 2;
        const N = 18, pts = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N, a = (1 - t) * (1 - t), b2 = 2 * t * (1 - t), c = t * t;
          const x = a * xl + b2 * cxq + c * xr, y = a * yl + b2 * cyq + c * yr;
          const tx = 2 * (1 - t) * (cxq - xl) + 2 * t * (xr - cxq), ty = 2 * (1 - t) * (cyq - yl) + 2 * t * (yr - cyq), tl = Math.hypot(tx, ty) || 1;
          const hw = lw * 0.5 * (0.35 + 0.65 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.5));
          pts.push([x, y, -ty / tl * hw, tx / tl * hw]);
        }
        ctx.fillStyle = rgb(m.lineColour);
        ctx.beginPath();
        ctx.moveTo(pts[0][0] + pts[0][2], pts[0][1] + pts[0][3]);
        for (let i = 1; i <= N; i++) ctx.lineTo(pts[i][0] + pts[i][2], pts[i][1] + pts[i][3]);
        for (let i = N; i >= 0; i--) ctx.lineTo(pts[i][0] - pts[i][2], pts[i][1] - pts[i][3]);
        ctx.closePath();
        ctx.fill();
        return;
      }
      // open: an outline of four curves, left corner -> top middle -> right corner -> bottom middle.
      //   grin / shout: sharp corners, a nearly straight top edge, a bottom that hangs by h (boxier the wider it opens)
      //   "o": round corners, the top bowed up as far as the bottom hangs down
      const chord = (yl + yr) / 2;
      const up = round * Math.min(0.5 * h, 0.95 * w);                     // how far the top middle rises above the corners
      const sag = (1 - round) * Math.min(0.06 * w, 0.2 * h) * clamp(0.5 + 0.5 * (cl + cr) * 0.5, 0, 1);   // a grin's top edge dips a little
      const ty = chord - up + sag, by = chord + h - up;
      const boxy = sstep(0.45, 0.95, open) * (1 - round);
      const cu = round * 0.56 * up, cd = lerp(lerp(0.72, 0.94, boxy), 0.56, round) * (by - chord);
      const tu = lerp(0.6, 0.56, round) * w, td = lerp(lerp(0.6, 0.88, boxy), 0.56, round) * w;
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(xl, yl);
        ctx.bezierCurveTo(xl, yl - cu, xm - tu, ty, xm, ty);
        ctx.bezierCurveTo(xm + tu, ty, xr, yr - cu, xr, yr);
        ctx.bezierCurveTo(xr, yr + cd, xm + td, by, xm, by);
        ctx.bezierCurveTo(xm - td, by, xl, yl + cd, xl, yl);
        ctx.closePath();
      };
      ctx.save();
      path();
      ctx.fillStyle = rgb(m.inside);
      ctx.fill();
      ctx.clip();
      // the back of the mouth is lighter low down (the approved "o")
      const g = ctx.createLinearGradient(0, ty, 0, by);
      g.addColorStop(0, rgb(m.inside, 1)); g.addColorStop(0.5, rgb(m.inside, 1)); g.addColorStop(1, rgb(m.insideLow, 1));
      ctx.fillStyle = g;
      ctx.fillRect(xl - 4, ty - 4, xr - xl + 8, by - ty + 8);
      // tongue: rises from the floor of the mouth
      const tongue = clamp(p.mouthTongue, 0, 1);
      if (tongue > 0.02 && h > 6) {
        const th = tongue * 0.5 * (by - chord);
        ctx.fillStyle = rgb(m.tongue);
        ctx.beginPath();
        ctx.ellipse(xm, by + th * 0.3, w * lerp(0.86, 0.6, round), th * 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // teeth: a band under the upper lip
      const teeth = clamp(p.mouthTeeth, 0, 1);
      if (teeth > 0.02 && h > 5) {
        const tb = teeth * Math.min(m.teethH[0] + m.teethH[1] * h, 0.42 * h);
        ctx.fillStyle = rgb(m.teeth);
        ctx.beginPath();
        ctx.moveTo(xl - 2, yl - 10);
        ctx.lineTo(xr + 2, yr - 10);
        ctx.lineTo(xr + 2, yr + tb);
        ctx.bezierCurveTo(xr, yr + tb, xm + tu, ty + tb * 1.1, xm, ty + tb * 1.1);
        ctx.bezierCurveTo(xm - tu, ty + tb * 1.1, xl, yl + tb, xl - 2, yl + tb);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      path();
      ctx.lineJoin = 'round';
      ctx.lineWidth = m.outline * clamp(0.55 + h / 30, 0.55, 1) * (1 - 0.45 * round);
      ctx.strokeStyle = rgb(round > 0.5 ? m.inside : m.outlineColour);
      ctx.stroke();
    }

    /** The blank face alone (its own transparency kept: Melanie's forehead islands are left to the model's skin). */
    _blank() {
      const ctx = this.ctx, r = this.d.region;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(this.img, 0, 0, r[2], r[3], 0, 0, r[2], r[3]);
      ctx.globalCompositeOperation = 'source-over';
    }
    /** The blank face cut to the parts' own mask (what the texture holds before the first real draw). */
    blankOnly() {
      this._blank();
      const mk = this.d.sprites.mask, r = this.d.region, ctx = this.ctx;
      if (mk) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(this.img, mk[0], mk[1], mk[2], mk[3], mk[4] - r[0], mk[5] - r[1], mk[2], mk[3]); ctx.globalCompositeOperation = 'source-over'; }
    }

    /**
     * Draw the whole face for the parameter set p (see VTFaceMap.PARAMS). A parameter that is not a number is drawn at
     * its rest value, and whatever goes wrong inside, the canvas is left usable (never clipped, never half drawn).
     */
    draw(p) {
      const t0 = performance.now();
      let q = p;
      for (const k in SAFE) if (!Number.isFinite(p[k])) { if (q === p) q = Object.assign({}, p); q[k] = SAFE[k]; }
      try { this._draw(q); } catch (err) {
        // a throw between save() and restore() leaves a clip behind: setting the size resets every bit of canvas state
        this.canvas.width = this.d.region[2];
        this.ctx = this.canvas.getContext('2d');
        this.blankOnly();
        this.failed = (this.failed || 0) + 1; this.lastError = String(err && err.message || err);
      }
      this.ms = performance.now() - t0;
    }

    _draw(p) {
      const ctx = this.ctx, d = this.d, r = d.region;
      this._blank();
      ctx.setTransform(1, 0, 0, 1, -r[0], -r[1]);
      const blush = clamp(p.blush, 0, 1);
      if (blush > 0.02) {
        for (const [x, y, rx, ry] of this.s.blush) {
          ctx.save();
          ctx.translate(x, y); ctx.scale(1, ry / rx);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 1.25);
          g.addColorStop(0, rgb(this.s.blushColour, 0.42 * blush)); g.addColorStop(0.55, rgb(this.s.blushColour, 0.22 * blush)); g.addColorStop(1, rgb(this.s.blushColour, 0));
          ctx.fillStyle = g;
          ctx.fillRect(-rx * 1.3, -rx * 1.3, rx * 2.6, rx * 2.6);
          ctx.restore();
        }
      }
      // two nearly shut eyes are drawn alike (the same lid height): one eye a sliver and the other a closed line, for
      // the single frame in which they pass the "drawn shut" threshold one after the other, read as a wink flash
      const eL = p.eyeL_open, eR = p.eyeR_open;
      this.lidSync = Math.max(eL, eR) < 0.45 && Math.abs(eL - eR) < 0.2 ? (eL + eR) / 2 : null;
      this._eye(0, p); this._eye(1, p);
      this._brow(0, p); this._brow(1, p);
      this._mouth(p);
      // the parts' own replace-mask (Melanie): everything drawn is cut to it, and the shader then uses the picture's alpha
      const mk = d.sprites.mask;
      if (mk) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(this.img, mk[0], mk[1], mk[2], mk[3], mk[4] - r[0], mk[5] - r[1], mk[2], mk[3]);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Face parts picture failed: ' + url));
      im.src = url;
    });
  }

  // ------------------------------------------------------------------------------------------- on the 3D head
  const B = root.BABYLON, F = root.VTFace;
  let Face2Rig = null;
  if (B && F) {
    const GLSL = {
      definitions: `
#ifdef VTFACE2
uniform vec4 vtgState; uniform vec4 vtgMask; uniform vec4 vtgRect;
uniform sampler2D vtgAtlas; uniform sampler2D vtgArt;
uniform mat4 vtgFace; uniform vec4 vtgDepthCell; uniform vec4 vtgDepth; uniform vec4 vtgRingL; uniform vec4 vtgRingR;
uniform vec4 vtgLensL; uniform vec4 vtgLensR; uniform vec4 vtgWallP; uniform vec4 vtgFrame;
vec3 vtgLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
#endif
`,
      albedo: `vec4 albedoTexture=TEXRD(albedoSampler,vAlbedoUV+uvOffset);
float vtgW=0.0;
float vtgFrameW=0.0;
#ifdef VTFACE2
if (vtgState.x > 0.5) {
  vec4 vtgP = vtgFace * vec4(vPositionW, 1.0);
  vec2 vtgL = vtgP.xy;
  vec2 vtgC = clamp(vtgL, 0.002, 0.998);
  float vtgRef = texture2D(vtgAtlas, vtgDepthCell.xy + vtgC * vtgDepthCell.zw).a * vtgDepth.y + vtgDepth.x;
  float vtgIn = step(0.0, vtgL.x) * step(vtgL.x, 1.0) * step(0.0, vtgL.y) * step(vtgL.y, 1.0)
    * (1.0 - smoothstep(vtgDepth.z * 0.6, vtgDepth.z, abs(vtgP.z - vtgRef)));
  float vtgA = texture2D(vtgAtlas, vtgMask.xy + vtgC * vtgMask.zw).a;
  vec4 vtgArtPx = texture2D(vtgArt, clamp((vtgC - vtgRect.xy) / vtgRect.zw, 0.0, 1.0));
  vec3 vtgRgb = vtgArtPx.rgb;
  if (vtgState.z > 0.5) vtgRgb = vtgLinear(vtgRgb);
  // the art's own alpha: where the blank is transparent the model's skin stays
  vtgW = vtgA * vtgIn * vtgState.y * vtgArtPx.a;
  if (vtgDepth.w > 0.5) {
    // the parts carry their own, wider mask (Melanie's lens rings). Outside the approved mask the art is laid only on
    // surfaces that lie near the SKIN round that lens (a plane per lens): the skin under the glasses frame, never the
    // frame in front of it.
    float vtgBounds = step(0.0, vtgL.x) * step(vtgL.x, 1.0) * step(0.0, vtgL.y) * step(vtgL.y, 1.0);
    bool vtgLeft = vtgC.x < vtgRingL.w;
    vec4 vtgPl = vtgLeft ? vtgRingL : vtgRingR;
    float vtgOff = vtgP.z - (vtgPl.x * vtgC.x + vtgPl.y * vtgC.y + vtgPl.z);      // how far in front of the skin round this lens
    float vtgSkin = 1.0 - smoothstep(vtgDepth.w * 0.6, vtgDepth.w, abs(vtgOff));
    vtgW = vtgState.y * vtgArtPx.a * mix(vtgBounds * vtgSkin, vtgIn, vtgA);
    // the INNER WALL of the 3D glasses frame (between the skin and the frame's front face, in the rim band of the lens):
    // the model's texture is mottled there and the eye art used to land on it in pieces. It is the frame: one dark colour.
    vec4 vtgEl = vtgLeft ? vtgLensL : vtgLensR;
    float vtgRad = length((vtgC - vtgEl.xy) / vtgEl.zw);
    float vtgWall = vtgBounds * vtgState.y * smoothstep(vtgWallP.z, vtgWallP.z + 0.08, vtgRad) * (1.0 - smoothstep(0.96, 1.0, vtgRad)) * step(vtgWallP.w, vtgC.y)
      * smoothstep(vtgWallP.x, vtgWallP.x * 1.35, vtgOff) * (1.0 - smoothstep(vtgWallP.y, vtgWallP.y + 0.5, vtgOff));
    vtgW *= 1.0 - vtgWall;
    vtgFrameW = vtgWall;
  }
  albedoTexture.rgb = mix(albedoTexture.rgb, vtgRgb, vtgW);
  albedoTexture.rgb = mix(albedoTexture.rgb, vtgFrame.rgb, vtgFrameW);
  normalW = normalize(mix(normalW, geometricNormalW, vtgW));
}
#endif
`,
      reflectivity: `
#if defined(VTFACE2) && defined(METALLICWORKFLOW)
surfaceMetallicOrReflectivityColorMap.g = mix(surfaceMetallicOrReflectivityColorMap.g, vtgState.w, vtgW);
surfaceMetallicOrReflectivityColorMap.b = mix(surfaceMetallicOrReflectivityColorMap.b, 0.0, vtgW);
#endif
vec4 baseReflectivity=surfaceMetallicOrReflectivityColorMap;`,
    };
    const UNIFORMS = ['vtgState', 'vtgMask', 'vtgRect', 'vtgFace', 'vtgDepthCell', 'vtgDepth', 'vtgRingL', 'vtgRingR', 'vtgLensL', 'vtgLensR', 'vtgWallP', 'vtgFrame'];

    class VTFace2Plugin extends B.MaterialPluginBase {
      constructor(material, data, atlas, art, rect, srgb) {
        super(material, 'VTFace2', 221, { VTFACE2: false }, true, false);
        this.data = data; this.atlas = atlas; this.art = art; this.rect = rect; this.srgb = srgb;
        this.on = true; this.weight = 1; this.ring = null;
        this.mask = F.cellRect(data, data.order[0]);
        this.depthCell = F.cellRect(data, 'depth');
        this.faceMatrix = B.Matrix.Identity();
        this.registerForExtraEvents = true;
        this.doNotSerialize = true;
        this._enable(true);
      }
      getClassName() { return 'VTFace2Plugin'; }
      isCompatible(shaderLanguage) { return shaderLanguage === 0; }
      isReadyForSubMesh() { return this.atlas.isReady() && this.art.isReady(); }
      prepareDefines(defines) { defines.VTFACE2 = !!this._material.albedoTexture; }
      getSamplers(samplers) { samplers.push('vtgAtlas', 'vtgArt'); }
      getUniforms() { return { externalUniforms: UNIFORMS }; }
      hardBindForSubMesh(_ubo, _scene, _engine, subMesh) {
        const effect = subMesh.effect;
        if (!effect || !effect.getUniform('vtgState')) return;
        const d = this.data, m = this.mask, c = this.depthCell, r = this.rect;
        effect.setFloat4('vtgState', this.on ? 1 : 0, this.weight, this.srgb ? 1 : 0, d.skinRoughness);
        effect.setFloat4('vtgMask', m[0], m[1], m[2], m[3]);
        effect.setFloat4('vtgRect', r[0], r[1], r[2], r[3]);
        effect.setMatrix('vtgFace', this.faceMatrix);
        effect.setFloat4('vtgDepthCell', c[0], c[1], c[2], c[3]);
        // vtgDepth.w: 0 = the approved mask alone; otherwise the parts' own mask is in use and this is the ring's depth tolerance
        const ring = this.ring;
        effect.setFloat4('vtgDepth', d.depthRange[0], d.depthRange[1] - d.depthRange[0], d.slab, ring ? ring.tol : 0);
        if (ring) {
          effect.setFloat4('vtgRingL', ring.planes[0][0], ring.planes[0][1], ring.planes[0][2], ring.split);
          effect.setFloat4('vtgRingR', ring.planes[1][0], ring.planes[1][1], ring.planes[1][2], ring.split);
          const eL = ring.ellipses[0], eR = ring.ellipses[1], lin = (v) => { const c = v / 255; return this.srgb ? (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) : c; };
          effect.setFloat4('vtgLensL', eL[0], eL[1], eL[2], eL[3]);
          effect.setFloat4('vtgLensR', eR[0], eR[1], eR[2], eR[3]);
          effect.setFloat4('vtgWallP', ring.wallFrom, ring.wallTo, ring.wallBand, ring.wallTop);
          effect.setFloat4('vtgFrame', lin(ring.frame[0]), lin(ring.frame[1]), lin(ring.frame[2]), 1);
        }
        effect.setTexture('vtgAtlas', this.atlas);
        effect.setTexture('vtgArt', this.art);
      }
      getCustomCode(shaderType) {
        if (shaderType !== 'fragment') return null;
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: GLSL.definitions,
          '!vec4 albedoTexture=TEXRD\\(albedoSampler,vAlbedoUV\\+uvOffset\\);': GLSL.albedo,
          '!vec4 baseReflectivity=surfaceMetallicOrReflectivityColorMap;': GLSL.reflectivity,
        };
      }
    }

    /** One hero's v2 face: `set(params)` whenever they change, `update()` every frame after the skeleton moved. */
    Face2Rig = class {
      /** data: face-data.json (+ url, baseUrl, normalUrl, ormUrl, partsUrl, partsImageUrl) */
      static async create(scene, meshes, data, headNode) {
        const material = F.bodyMaterialOf(meshes);
        if (!material) throw new Error(data.id + ': no body material');
        if (data.mouthFlatten && !F.flattenMouth(meshes, data.mouthFlatten)) throw new Error(data.id + ': mouth flatten did not match the model');
        const like = material.albedoTexture;
        const [atlas, parts, image] = await Promise.all([
          F.loadAtlas(data, scene, like),
          fetch(data.partsUrl).then((r) => { if (!r.ok) throw new Error(data.id + ': face parts data missing'); return r.json(); }),
          loadImage(data.partsImageUrl),
        ]);
        if (data.baseUrl) await F.swapBase(material, data.baseUrl, scene);
        if (data.normalUrl) await F.swapBase(material, data.normalUrl, scene, 'bumpTexture');
        if (data.ormUrl) await F.swapBase(material, data.ormUrl, scene, 'metallicTexture');
        const art = new B.DynamicTexture('face2-' + data.id, { width: parts.region[2], height: parts.region[3] }, scene, true, B.Texture.TRILINEAR_SAMPLINGMODE);
        art.wrapU = B.Texture.CLAMP_ADDRESSMODE; art.wrapV = B.Texture.CLAMP_ADDRESSMODE;
        art.anisotropicFilteringLevel = 4;
        const painter = new Painter(parts, image, art.getContext().canvas);
        painter.blankOnly();
        art.update(false);                                   // a dynamic texture is "ready" only after its first upload
        const C = parts.cell, r = parts.region;
        const plugin = new VTFace2Plugin(material, data, atlas, art, [r[0] / C, r[1] / C, r[2] / C, r[3] / C], !!(like && like._useSRGBBuffer === true));
        plugin.ring = parts.ownMask && parts.sprites.mask && parts.ring ? parts.ring : null;
        const rig = new Face2Rig(data, parts, plugin, painter, art, headNode);
        const own = meshes.filter((m) => m.material === material);
        await Promise.all(own.map((m) => material.forceCompilationAsync(m).catch(() => undefined)));
        return rig;
      }
      constructor(data, parts, plugin, painter, art, headNode) {
        this.data = data; this.parts = parts; this.plugin = plugin; this.painter = painter; this.art = art; this.headNode = headNode;
        const A = data.faceAxesInHead, c = data.centreHead, s = data.side;
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        // head-local point -> (picture u, picture v, depth along the face axis), as a Babylon (row-vector) matrix
        this.cropFromHead = B.Matrix.FromValues(
          A.x[0] / s, -A.y[0] / s, A.z[0], 0,
          A.x[1] / s, -A.y[1] / s, A.z[1], 0,
          A.x[2] / s, -A.y[2] / s, A.z[2], 0,
          0.5 - dot(c, A.x) / s, 0.5 + dot(c, A.y) / s, -dot(c, A.z), 1);
        this.inv = new B.Matrix();
        this.params = null; this.shown = null; this.dirty = false; this.ms = 0; this.drawn = 0;
      }
      /** The parameter set to show (an object with every VTFaceMap.PARAMS key). */
      set(params) { this.params = params; this.dirty = true; }
      /** The picture follows the head: call after the skeleton moved, before rendering. Redraws the face if it changed. */
      update() {
        this.headNode.computeWorldMatrix(true).invertToRef(this.inv);
        this.inv.multiplyToRef(this.cropFromHead, this.plugin.faceMatrix);
        if (this.dirty && this.params) {
          // redraw only when something moved enough to see (a still face costs nothing)
          const p = this.params, was = this.shown;
          let moved = !was;
          if (was) for (const k in p) if (Math.abs(p[k] - was[k]) > 0.004) { moved = true; break; }
          if (moved) {
            const t0 = performance.now();
            this.painter.draw(p);
            this.art.update(false);
            this.ms = performance.now() - t0;
            this.shown = Object.assign(this.shown || {}, p);
            this.drawn++;
          } else this.ms = 0;
          this.dirty = false;
        }
      }
    };
  }

  root.VTFace2 = { Painter, Face2Rig, STYLE, loadImage };
})(typeof window !== 'undefined' ? window : globalThis);
