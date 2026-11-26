// V8 MASK: the 2D layer over the mask's canvas. Everything that must be READ on a phone is drawn here, crisp, on a second
// canvas of the same size stacked on the WebGL one (the mask itself never draws text into its own canvas):
//   the two health bars (BOSS + CHAT), "Tap to attack!", the pictures riding on the missiles, pop-ups ("ATE @name"),
//   the top 3, the vote, the song's cover (or a glowing record) being bitten away, the song's name while it is eaten,
//   "THE VERDICT" over the word of fire the Mask spits (release A), the rank banner.
//   const hud = VTMaskHud.create(canvas2d, { layout: 'stack' | 'versus' });
//   hud.draw(mask.hud(), { label })      // once per drawn frame, after mask.draw(); -> true when anything was drawn
// TikTok LIVE: the only call to action is the engine's own prompt ("Tap to attack!"); nothing here names gifts.
// Layout is tuned at 1080 x 1920 and scales with the canvas. SAFE ZONE (phase 2): every word and every piece of interface
// stays inside x 60 - 930, y 200 - 1436 (TikTok's own interface covers the rest on a phone). A test checks the numbers.
//   hud.draw(V, { mirror, barsY })   mirror: the page flips the MASK's canvas (Mirror), never this one: the words here always
//                                    read right, and what rides on the Mask's picture (missile pictures, the cover, pop-ups)
//                                    has its x flipped to follow. barsY: 0 (top) .. 1 (bottom), where the fight's bars sit.
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v)), lerp = (a, b, k) => a + (b - a) * k;
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const FONT = 'Bahnschrift, "Segoe UI", Arial, sans-serif';
  const hex = (c, a = 1) => 'rgba(' + c.map((v) => Math.round(255 * clamp(v))).join(',') + ',' + a + ')';
  const srgb = (lin) => { const m = Math.max(lin[0], lin[1], lin[2], 1e-3); return lin.map((v) => Math.pow(clamp(v / Math.max(1, m)), 1 / 2.2)); };
  const mix = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  const SAFE = Object.freeze({ x0: 60, x1: 930, y0: 200, y1: 1436, cx: 495 });
  /** the bars' top edge for a place 0 (top) .. 1 (bottom) */
  const barsTop = (v) => Math.round(lerp(256, 1192, clamp(Number(v) || 0)));
  const CRIMSON = [0.91, 0.07, 0.13], CHROME = [0.93, 0.91, 0.88], GOLDC = [1.0, 0.80, 0.42], INK = [0.045, 0.028, 0.022], TOXICC = [0.55, 1.0, 0.25];

  // ---- placeholder profile pictures (demos and tests; never a real viewer): a two-tone disc with the name's first letter
  const phCache = new Map();
  function placeholder(name) {
    const key = String(name || '?'); if (phCache.has(key)) return phCache.get(key);
    const doc = root.document; if (!doc) return null;
    const c = doc.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const hue = [18, 32, 44, 350, 8, 200, 150, 280, 60, 320][h % 10], hue2 = (hue + 40 + (h >> 4) % 60) % 360;
    const g = x.createLinearGradient(0, 0, 128, 128); g.addColorStop(0, 'hsl(' + hue + ',78%,56%)'); g.addColorStop(1, 'hsl(' + hue2 + ',70%,26%)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    x.fillStyle = 'rgba(255,255,255,0.16)'; x.beginPath(); x.arc(64, 150, 62, 0, 7); x.fill(); x.beginPath(); x.arc(64, 54, 26, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.95)'; x.font = '700 62px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(key.replace(/^@/, '').charAt(0).toUpperCase() || '?', 64, 70);
    phCache.set(key, c); return c;
  }

  function create(canvas, { layout = 'stack' } = {}) {
    const x = canvas.getContext('2d');
    let dirty = false, lay = layout;
    const st = { shards: null, barsY: 0, mirror: false };
    const K = () => canvas.width / 1080;
    const font = (w, s) => { x.font = w + ' ' + Math.round(s * K() * 10) / 10 + 'px ' + FONT; };
    const sp = (px) => { try { x.letterSpacing = (px * K()) + 'px'; } catch (e) { /* older canvas: no tracking */ } };
    const avatarOf = (v) => (v && v.avatar && typeof v.avatar === 'object' ? v.avatar : placeholder(v ? v.name : '?'));
    function text(s, px, py, { w = '700', size = 32, col = '#fff', align = 'left', track = 0, glow = null, stroke = 0, a = 1, fit = 0 } = {}) {
      const k = K(); font(w, size); sp(track);
      if (fit) { const tw = x.measureText(s).width / k; if (tw > fit) { size = Math.max(12, Math.floor(size * fit / tw)); font(w, size); } }      // too wide for its place: smaller, never cut off
      x.textAlign = align; x.textBaseline = 'alphabetic'; x.globalAlpha = a;
      if (stroke) { x.lineJoin = 'round'; x.lineWidth = stroke * k; x.strokeStyle = 'rgba(8,4,3,0.85)'; x.strokeText(s, px * k, py * k); }
      if (glow) { x.shadowColor = glow; x.shadowBlur = 18 * k; }
      x.fillStyle = col; x.fillText(s, px * k, py * k); x.shadowBlur = 0; x.globalAlpha = 1; sp(0);
    }
    function disc(img, cx, cy, r, ring, ringW, a = 1) {
      const k = K(); x.save(); x.globalAlpha = a;
      x.shadowColor = ring; x.shadowBlur = 16 * k; x.beginPath(); x.arc(cx, cy, r + ringW * k * 0.5, 0, 6.2832); x.fillStyle = 'rgba(10,6,5,0.9)'; x.fill(); x.shadowBlur = 0;
      x.save(); x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.clip(); if (img) x.drawImage(img, cx - r, cy - r, r * 2, r * 2); else { x.fillStyle = '#333'; x.fill(); } x.restore();
      x.lineWidth = ringW * k; x.strokeStyle = ring; x.beginPath(); x.arc(cx, cy, r + ringW * k * 0.5, 0, 6.2832); x.stroke();
      x.lineWidth = 1.5 * k; x.strokeStyle = 'rgba(255,255,255,0.55)'; x.beginPath(); x.arc(cx, cy, r + ringW * k, 0, 6.2832); x.stroke();
      x.restore();
    }
    /** a slanted bar: the track, the fill (0..1, from the left or from the right), a ghost of what was just lost, ticks, a gloss */
    function bar(bx, by, bw, bh, v, shown, col, { from = 'left', hit = 0, heal = 0, marks = [], a = 1, slant = 16 } = {}) {
      const k = K(), X0 = bx * k, Y0 = by * k, Wd = bw * k, Hd = bh * k, sl = slant * k * (bh / 46);
      const para = (x0, x1, inset) => { x.beginPath(); x.moveTo(x0 + sl + inset, Y0 + inset); x.lineTo(x1 + sl - inset, Y0 + inset); x.lineTo(x1 - inset, Y0 + Hd - inset); x.lineTo(x0 + inset, Y0 + Hd - inset); x.closePath(); };
      x.save(); x.globalAlpha = a;
      para(X0, X0 + Wd, 0); x.fillStyle = 'rgba(12,7,6,0.84)'; x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = 14 * k; x.fill(); x.shadowBlur = 0;
      const seg = (a0, a1) => (from === 'left' ? [X0 + Wd * a0, X0 + Wd * a1] : [X0 + Wd * (1 - a1), X0 + Wd * (1 - a0)]);
      x.save(); para(X0, X0 + Wd, 4 * k); x.clip();
      if (shown > v + 0.002) { const [g0, g1] = seg(v, shown); x.fillStyle = 'rgba(255,244,230,0.85)'; x.fillRect(g0 - sl, Y0, g1 - g0 + sl * 2, Hd); }
      if (v > 0.001) {
        const [f0, f1] = seg(0, v), g = x.createLinearGradient(0, Y0, 0, Y0 + Hd), hi = mix(col, [1, 1, 1], 0.38), lo = mix(col, [0, 0, 0], 0.45);
        g.addColorStop(0, hex(hi)); g.addColorStop(0.42, hex(col)); g.addColorStop(1, hex(lo));
        x.fillStyle = g; x.beginPath();
        if (from === 'left') { x.moveTo(f0 - sl, Y0); x.lineTo(f1 + sl, Y0); x.lineTo(f1, Y0 + Hd); x.lineTo(f0 - sl, Y0 + Hd); } else { x.moveTo(f0 + sl, Y0); x.lineTo(f1 + sl * 2, Y0); x.lineTo(f1 + sl * 2, Y0 + Hd); x.lineTo(f0, Y0 + Hd); }
        x.closePath(); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.20)'; x.fillRect(f0 - sl, Y0 + 5 * k, f1 - f0 + sl * 2, Hd * 0.26);
        const ex = from === 'left' ? f1 : f0; x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.moveTo(ex + sl - 2 * k, Y0); x.lineTo(ex + sl + 2 * k, Y0); x.lineTo(ex + 2 * k, Y0 + Hd); x.lineTo(ex - 2 * k, Y0 + Hd); x.closePath(); x.fill();      // the bright leading edge
      }
      x.strokeStyle = 'rgba(0,0,0,0.42)'; x.lineWidth = 2 * k;
      for (let i = 1; i < 10; i++) { const px = X0 + Wd * i / 10; x.beginPath(); x.moveTo(px + sl, Y0); x.lineTo(px, Y0 + Hd); x.stroke(); }
      if (hit > 0.01) { x.fillStyle = 'rgba(255,255,255,' + 0.5 * hit + ')'; x.fillRect(X0 - sl, Y0, Wd + sl * 3, Hd); }
      if (heal > 0.01) { x.fillStyle = 'rgba(255,214,120,' + 0.45 * heal + ')'; x.fillRect(X0 - sl, Y0, Wd + sl * 3, Hd); }
      x.restore();
      const gb = x.createLinearGradient(0, Y0, 0, Y0 + Hd); gb.addColorStop(0, 'rgba(255,255,255,0.95)'); gb.addColorStop(0.5, 'rgba(190,182,176,0.9)'); gb.addColorStop(1, 'rgba(110,102,98,0.9)');
      para(X0, X0 + Wd, 0); x.lineWidth = 2.5 * k; x.strokeStyle = gb; if (hit > 0.01) { x.shadowColor = '#fff'; x.shadowBlur = 22 * k * hit; } x.stroke(); x.shadowBlur = 0;
      for (const m of marks) { const [m0] = seg(m, m), px = m0 + sl; x.fillStyle = 'rgba(255,255,255,0.92)'; x.beginPath(); x.moveTo(px - 8 * k, Y0 - 12 * k); x.lineTo(px + 8 * k, Y0 - 12 * k); x.lineTo(px, Y0 - 1 * k); x.closePath(); x.fill(); }
      x.restore();
    }

    function bars(B, V) {
      const k = K(), E = B.ending, boss = B.boss, chat = B.chat, t = V.t;
      const bc = V.colour ? srgb(V.colour) : CRIMSON, stage = boss.stage;
      const bossCol = stage === 'demon' ? mix(bc, [1, 0.1, 0.05], 0.6 + 0.25 * Math.sin(t * 9)) : bc;
      let a = B.phase === 'intro' ? ss(0, 0.6, B.phaseT) : 1, chatA = 1, shatterK = 0;
      if (E) { const gone = E.winner === 'chat' ? (E.stage === 'explode' ? 1 : E.stage === 'rain' ? 1 - ss(0.5, 1, E.k) : 0) : (E.stage === 'shatter' || E.stage === 'gulp' ? 1 : E.stage === 'laugh' ? 1 - ss(0.1, 0.5, E.k) : 0); a *= E.winner === null ? 1 - ss(0, 1, E.k) : gone; if (E.winner === 'boss') { shatterK = E.stage === 'shatter' ? E.k : 1; chatA = 0; } }
      if (a <= 0.01) return;
      const pct = (v) => Math.max(0, Math.ceil(v * 100)) + '%', y0 = barsTop(st.barsY), XR = SAFE.x1, BW = SAFE.x1 - SAFE.x0;
      const drawChat = (bx, by, bw, bh, from) => {
        if (shatterK <= 0) { bar(bx, by, bw, bh, chat.shown, chat.shown, GOLDC, { from, hit: chat.hit || 0, a: a * chatA, slant: 12 }); return; }
        if (shatterK >= 1) return;
        // CHAT's bar breaks: shards fall away
        x.save(); x.globalAlpha = a * (1 - shatterK);
        for (let i = 0; i < 12; i++) { const u0 = i / 12, w = bw / 12, hsh = Math.sin(i * 12.9898) * 43758.5453, r = hsh - Math.floor(hsh); x.save(); x.translate((bx + u0 * bw + w / 2 + (r - 0.5) * 220 * shatterK) * k, (by + bh / 2 + (120 + 520 * r) * shatterK * shatterK) * k); x.rotate((r - 0.5) * 5 * shatterK); x.fillStyle = hex(mix(GOLDC, [1, 1, 1], r * 0.5)); x.beginPath(); x.moveTo(-w / 2 * k, -bh / 2 * k); x.lineTo(w / 2 * k, -bh / 2 * k * (0.4 + r)); x.lineTo(w / 2 * k * r, bh / 2 * k); x.lineTo(-w / 2 * k, bh / 2 * k * r); x.closePath(); x.fill(); x.restore(); }
        x.restore();
      };
      if (lay === 'versus') {
        text('THE MASK', 64, y0 - 14, { size: 34, a, stroke: 5 }); text(pct(boss.shown), 452, y0 - 14, { size: 36, align: 'right', a, stroke: 5 });
        text('CHAT', XR - 4, y0 - 14, { size: 34, align: 'right', a: a * chatA, stroke: 5 }); text(pct(chat.shown), 538, y0 - 14, { size: 36, a: a * chatA, stroke: 5 });
        bar(60, y0, 396, 46, boss.shown, Math.max(boss.shown, boss.hp), bossCol, { from: 'right', hit: boss.hit || 0, heal: boss.heal || 0, marks: [0.5, 0.2], a });
        drawChat(534, y0, 380, 46, 'left');
        x.save(); x.globalAlpha = a; x.translate(SAFE.cx * k, (y0 + 23) * k); x.rotate(Math.PI / 4); x.fillStyle = 'rgba(12,7,6,0.92)'; x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 2.5 * k; x.fillRect(-27 * k, -27 * k, 54 * k, 54 * k); x.strokeRect(-27 * k, -27 * k, 54 * k, 54 * k); x.restore();
        text('VS', SAFE.cx, y0 + 35, { size: 30, align: 'center', a });
      } else {
        // BOSS: the long bar, where the hype bar sits on his stream; CHAT right under it, thinner, in the raid's gold
        text('BOSS', 64, y0 - 14, { size: 24, col: hex(mix(bossCol, [1, 1, 1], 0.35)), track: 6, a, stroke: 4 }); text('THE MASK', 168, y0 - 14, { size: 36, a, stroke: 5 });
        if (stage !== 'whole') text(stage === 'demon' ? 'DEMON MODE' : 'CRACKED', 400, y0 - 15, { size: 26, col: stage === 'demon' ? '#ff5a2a' : '#ffc46b', track: 3, a, stroke: 4, glow: stage === 'demon' ? '#ff2a00' : null });
        text(pct(boss.shown), XR - 4, y0 - 12, { size: 42, align: 'right', a, stroke: 5 });
        bar(60, y0, BW - 16, 48, boss.shown, Math.max(boss.shown, boss.hp), bossCol, { hit: boss.hit || 0, heal: boss.heal || 0, marks: [0.5, 0.2], a });
        const y1 = y0 + 48 + 52;
        text('CHAT', 64, y1 - 12, { size: 24, col: hex(GOLDC), track: 6, a: a * chatA, stroke: 4 }); text('THE RAID', 168, y1 - 12, { size: 30, a: a * chatA, stroke: 5 });
        if (chat.tappers) text(chat.tappers + ' tapping', 330, y1 - 13, { w: '600', size: 24, col: 'rgba(255,240,225,0.75)', a: a * chatA, stroke: 4 });
        text(pct(chat.shown), XR - 4, y1 - 10, { size: 34, align: 'right', a: a * chatA, stroke: 5 });
        drawChat(60, y1, BW - 12, 34, 'left');
      }
      const yb = lay === 'versus' ? y0 + 46 : y0 + 48 + 52 + 34;
      // the live top 3: small pictures under CHAT's bar
      if (B.top && B.top.length && B.phase === 'fight') { let px = XR - 4; for (let i = Math.min(3, B.top.length) - 1; i >= 0; i--) { const v = B.top[i].viewer; disc(avatarOf(v), (px - 22) * k, (yb + 40) * k, 20 * k, i === 0 ? '#ffd27a' : i === 1 ? '#e8e4e0' : '#c98a55', 3, a); px -= 52; } text('TOP', px - 6, yb + 49, { w: '600', size: 22, col: 'rgba(255,240,225,0.7)', align: 'right', track: 4, a, stroke: 4 }); }
      // the one call to action (the engine's): a slow pulse, never a flash
if (B.prompt && !E) { const p = 0.84 + 0.16 * Math.sin(t * 2 * Math.PI * 0.8), nudge = 5 * Math.sin(t * 2 * Math.PI * 0.8); text('\u00BB', 62 + nudge, yb + 52, { size: 44, a: a * p, stroke: 6, col: hex(GOLDC) }); text(String(B.prompt).toUpperCase(), 104, yb + 52, { size: 40, track: 3, a: a * p, stroke: 7, col: '#fff' }); }
      if (B.phase === 'intro') { const q = ss(0, 0.5, B.phaseT) * (1 - ss(0.0, 0.6, 0.6 - (B.introLeft || 0))), iy = y0 > 900 ? 620 : y0 > 400 ? 470 : 600; text('BOSS FIGHT', SAFE.cx, iy, { size: 104, align: 'center', track: 6, a: q, stroke: 10, glow: hex(bossCol), fit: 780 }); text('THE RAID GATHERS  ' + Math.ceil(B.introLeft || 0), SAFE.cx, iy + 70, { w: '600', size: 38, align: 'center', track: 5, a: q, stroke: 6, col: hex(GOLDC) }); }
    }

    function credits(B, V) {
      const E = B.ending, k = K(); if (!E || !E.top3 || !E.top3.length) return;
      const a = E.stage === 'credits' ? ss(0, 0.12, E.k) : E.stage === 'reform' ? 1 - ss(0, 0.35, E.k) : 0; if (a <= 0.01) return;
      const y = 1248, slots = [[SAFE.cx, 76, '#ffd27a'], [SAFE.cx - 262, 58, '#e8e4e0'], [SAFE.cx + 262, 58, '#c98a55']];
      text('TOP RAIDERS', SAFE.cx, y - 118, { size: 30, align: 'center', track: 8, col: hex(GOLDC), a, stroke: 5 });
      E.top3.slice(0, 3).forEach((r, i) => {
        const [cx, rad, ring] = slots[i], rise = (1 - ss(0, 1, clamp((E.stage === 'credits' ? E.k : 1) * 6 - i * 0.6))) * 60;
        disc(avatarOf(r.viewer), cx * k, (y + rise) * k, rad * k, ring, i === 0 ? 6 : 4, a);
        x.save(); x.globalAlpha = a; x.fillStyle = ring; x.beginPath(); x.arc((cx - rad * 0.72) * k, (y + rise - rad * 0.72) * k, 20 * k, 0, 7); x.fill(); x.restore();
        text(String(i + 1), cx - rad * 0.72, y + rise - rad * 0.72 + 10, { size: 28, align: 'center', col: '#1a0d08', a });
        text('@' + r.viewer.name, cx, y + rise + rad + 44, { size: i === 0 ? 34 : 28, align: 'center', a, stroke: 5, fit: i === 0 ? 270 : 236 });
        text(Math.round((r.damage || 0) * 100) + '% of his bar', cx, y + rise + rad + 78, { w: '600', size: 23, align: 'center', col: 'rgba(255,240,225,0.78)', a, stroke: 4 });
      });
      void V;
    }

    function vote(v, V) {
      const k = K(), R = v.result, n = v.options.length, bc = V.colour ? srgb(V.colour) : CRIMSON;
      const a = R ? 1 - ss(5.2, 6, R.age || 0) : 1; if (a <= 0.01) return;
      const X0 = SAFE.x0, Wd = SAFE.x1 - SAFE.x0, Y0 = 204, rowH = 78, lines = wrap(v.question, Wd - 64, 46), headH = 76 + lines.length * 54, Ht = headH + n * rowH + 54;
      x.save(); x.globalAlpha = a;
      rr(X0 * k, Y0 * k, Wd * k, Ht * k, 26 * k); x.fillStyle = 'rgba(12,7,6,0.86)'; x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 30 * k; x.fill(); x.shadowBlur = 0;
      const gb = x.createLinearGradient(0, Y0 * k, 0, (Y0 + Ht) * k); gb.addColorStop(0, 'rgba(255,255,255,0.8)'); gb.addColorStop(0.3, 'rgba(160,150,145,0.45)'); gb.addColorStop(1, 'rgba(90,80,76,0.4)'); x.lineWidth = 2 * k; x.strokeStyle = gb; x.stroke();
      rr((X0 + 28) * k, (Y0 + 22) * k, 128 * k, 40 * k, 20 * k); x.fillStyle = hex(bc); x.fill(); x.restore();
      text(R ? 'RESULT' : 'VOTE', X0 + 94, Y0 + 51, { size: 24, align: 'center', track: 4, a });
      if (!R) {      // the countdown: a ring that empties, the seconds in it
        const cx = (X0 + Wd - 62) * k, cy = (Y0 + 44) * k, rad = 26 * k, left = Math.ceil(v.left || 0), urgent = left <= 5;
        x.save(); x.globalAlpha = a; x.lineWidth = 5 * k; x.strokeStyle = 'rgba(255,255,255,0.18)'; x.beginPath(); x.arc(cx, cy, rad, 0, 7); x.stroke(); x.strokeStyle = urgent ? '#ff6a3a' : '#fff'; x.beginPath(); x.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + 6.2832 * (1 - clamp(v.k || 0))); x.stroke(); x.restore();
        text(String(left), X0 + Wd - 62, Y0 + 55, { size: 30, align: 'center', a, col: urgent ? '#ff8a5a' : '#fff' });
        text(v.total + (v.total === 1 ? ' vote' : ' votes'), X0 + Wd - 106, Y0 + 53, { w: '600', size: 24, align: 'right', col: 'rgba(255,240,225,0.7)', a });
      }
      lines.forEach((l, i) => text(l, X0 + 30, Y0 + 118 + i * 54, { size: 46, a }));
      v.options.forEach((o, i) => {
        const y = Y0 + headH + i * rowH, win = R ? R.winner === i : false, lead = R ? win : o.leading && v.total > 0, dim = R && !win ? 0.38 : 1, bx = X0 + 104, bw = Wd - 104 - 28;
        x.save(); x.globalAlpha = a * dim;
        rr(bx * k, (y + 6) * k, bw * k, (rowH - 14) * k, 14 * k); x.fillStyle = 'rgba(255,240,230,0.07)'; x.fill();
        const w = Math.max(0, bw * clamp(o.share || 0)); if (w > 4) { x.save(); rr(bx * k, (y + 6) * k, bw * k, (rowH - 14) * k, 14 * k); x.clip(); const g = x.createLinearGradient(bx * k, 0, (bx + w) * k, 0), c0 = lead ? bc : [0.42, 0.38, 0.36]; g.addColorStop(0, hex(mix(c0, [0, 0, 0], 0.35), 0.95)); g.addColorStop(1, hex(mix(c0, [1, 1, 1], lead ? 0.12 : 0), 0.95)); x.fillStyle = g; if (lead) { x.shadowColor = hex(bc); x.shadowBlur = 20 * k; } x.fillRect(bx * k, (y + 6) * k, w * k, (rowH - 14) * k); x.restore(); }
        rr((X0 + 28) * k, (y + 6) * k, 64 * k, (rowH - 14) * k, 14 * k); x.fillStyle = lead ? '#fff' : 'rgba(255,255,255,0.10)'; x.fill(); x.lineWidth = 2 * k; x.strokeStyle = 'rgba(255,255,255,0.7)'; x.stroke();
        x.restore();
        text(String(o.n || i + 1), X0 + 60, y + 54, { size: 40, align: 'center', col: lead ? '#1a0d08' : '#fff', a: a * dim });
        text(o.label, bx + 22, y + 52, { size: 36, a: a * dim, stroke: 4, fit: bw - (win ? 330 : 150) });
        text(Math.round((o.share || 0) * 100) + '%', X0 + Wd - 46, y + 52, { size: 36, align: 'right', a: a * dim, stroke: 4 });
        if (win) text(R.tie ? 'WINS THE TIE' : 'WINNER', X0 + Wd - 150, y + 50, { size: 24, align: 'right', track: 4, col: '#ffd27a', a, stroke: 4 });
      });
      text(R ? (R.winner < 0 ? 'No votes this time' : '') : 'Type the number in chat', X0 + 30, Y0 + Ht - 20, { w: '600', size: 26, col: 'rgba(255,240,225,0.72)', a });
    }
    /** words on a dark plate (rounded, 86 % black, a chrome hairline), centred on cx, baseline py */
    function plate(s, cx, py, size, track, a, col, glow) {
      const k = K(); font('700', size); sp(track); let tw = x.measureText(s).width / k; sp(0);
      if (tw > 760) { size = Math.floor(size * 760 / tw); tw = 760; }
      const w = tw + 76, h = size * 1.36, px = cx - w / 2, top = py - size * 1.02;
      x.save(); x.globalAlpha = a; rr(px * k, top * k, w * k, h * k, h * 0.5 * k); x.fillStyle = 'rgba(12,7,6,0.86)'; x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 22 * k; x.fill(); x.shadowBlur = 0;
      const gb = x.createLinearGradient(0, top * k, 0, (top + h) * k); gb.addColorStop(0, 'rgba(255,255,255,0.85)'); gb.addColorStop(0.5, 'rgba(170,160,154,0.5)'); gb.addColorStop(1, 'rgba(100,90,86,0.5)'); x.lineWidth = 2 * k; x.strokeStyle = gb; x.stroke(); x.restore();
      text(s, cx, py, { size, align: 'center', track, a, stroke: 6, col, glow, fit: 760 });
    }
    function rr(px, py, w, h, r) { x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r); x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath(); }
    function wrap(s, maxW, size) { font('700', size); const words = String(s || '').split(/\s+/), out = []; let cur = ''; for (const w of words) { const tr = cur ? cur + ' ' + w : w; if (x.measureText(tr).width > maxW * K() && cur) { out.push(cur); cur = w; } else cur = tr; } if (cur) out.push(cur); return out.slice(0, 2); }

    /** RELEASE A: a glowing record (a song with no cover the Mask can load), drawn round 0,0: grooves, a sheen that turns, a warm label */
    function record(s, spin, tint) {
      const k = K(), R = s / 2, tc = srgb(tint || GOLDC), TAU = 6.2832;
      x.shadowColor = hex(tc, 0.95); x.shadowBlur = 70 * k; for (let i = 0; i < 2; i++) { x.beginPath(); x.arc(0, 0, R, 0, TAU); x.fillStyle = '#0a0605'; x.fill(); } x.shadowBlur = 0;
      const g = x.createRadialGradient(0, 0, R * 0.2, 0, 0, R); g.addColorStop(0, '#20140f'); g.addColorStop(0.62, '#0c0706'); g.addColorStop(1, '#1d1210');
      x.beginPath(); x.arc(0, 0, R, 0, TAU); x.fillStyle = g; x.fill();
      x.lineWidth = Math.max(1, 1.3 * k);
      for (let i = 0; i < 10; i++) { x.strokeStyle = 'rgba(255,224,196,' + (0.06 + 0.05 * (i % 3)) + ')'; x.beginPath(); x.arc(0, 0, R * (0.42 + 0.055 * i), 0, TAU); x.stroke(); }
      x.save(); x.rotate(spin || 0);
      for (const a0 of [0.5, 0.5 + Math.PI]) { x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R * 0.97, a0 - 0.20, a0 + 0.20); x.closePath(); x.fillStyle = 'rgba(255,244,230,0.15)'; x.fill(); x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R * 0.97, a0 - 0.05, a0 + 0.05); x.closePath(); x.fillStyle = 'rgba(255,250,240,0.22)'; x.fill(); }
      const lg = x.createRadialGradient(-R * 0.08, -R * 0.08, R * 0.02, 0, 0, R * 0.36); lg.addColorStop(0, hex(mix(tc, [1, 0.96, 0.88], 0.55))); lg.addColorStop(0.7, hex(tc)); lg.addColorStop(1, hex(mix(tc, CRIMSON, 0.6)));
      x.beginPath(); x.arc(0, 0, R * 0.36, 0, TAU); x.fillStyle = lg; x.fill(); x.lineWidth = 2.5 * k; x.strokeStyle = 'rgba(255,236,200,0.9)'; x.stroke();
      x.beginPath(); x.arc(0, 0, R * 0.25, 0.3, 2.2); x.lineWidth = 3 * k; x.strokeStyle = 'rgba(20,8,6,0.55)'; x.stroke();      // a mark on the label: the turning is seen
      x.restore();
      x.beginPath(); x.arc(0, 0, R * 0.05, 0, TAU); x.fillStyle = '#050302'; x.fill();
      x.beginPath(); x.arc(0, 0, R - 1.5 * k, 0, TAU); x.lineWidth = 3 * k; x.strokeStyle = hex(mix(tc, [1, 0.96, 0.88], 0.35), 0.95); x.stroke();
    }

    function draw(V, { label = '', mirror = false, barsY = 0 } = {}) {
      const k = K(), W = canvas.width, H = canvas.height;
      st.mirror = !!mirror; st.barsY = clamp(Number(barsY) || 0);
      const mx = (px) => (st.mirror ? W - px : px);                // a place on the Mask's (flipped) picture -> where it is seen
      if (dirty) { x.clearRect(0, 0, W, H); dirty = false; }
      if (!V) return false;
      let any = false; const mark = () => { any = true; dirty = true; };
      const bc = V.colour ? srgb(V.colour) : CRIMSON;
      // the cover of the song, bitten away at the mouth
      if (V.cover && V.cover.a > 0.01) {
        const c = V.cover, s = c.size, ccx = mx(c.x); mark(); x.save(); x.globalAlpha = c.a;
        if (c.bite > 0) { x.beginPath(); x.moveTo(0, 0); x.lineTo(W, 0); x.lineTo(W, c.clipY); const nb = 5, bw = s / nb, x0 = ccx - s / 2; x.lineTo(x0 + s, c.clipY); for (let i = nb - 1; i >= 0; i--) x.arc(x0 + (i + 0.5) * bw, c.clipY, bw * 0.5, 0, Math.PI, true); x.lineTo(0, c.clipY); x.closePath(); x.clip(); }
        x.translate(ccx, c.y); x.rotate(st.mirror ? -c.rot : c.rot);
        if (c.record || !c.image) record(s, st.mirror ? -(c.spin || 0) : c.spin || 0, c.tint);      // release A: no cover = a glowing record
        else {
          x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 30 * k; rr(-s / 2, -s / 2, s, s, s * 0.06); x.fillStyle = '#111'; x.fill(); x.shadowBlur = 0;
          x.save(); rr(-s / 2, -s / 2, s, s, s * 0.06); x.clip(); try { x.drawImage(c.image, -s / 2, -s / 2, s, s); } catch (e) { /* a picture that cannot be drawn: the frame alone */ } x.restore();
          rr(-s / 2, -s / 2, s, s, s * 0.06); x.lineWidth = 4 * k; x.strokeStyle = 'rgba(255,255,255,0.9)'; x.stroke();
        }
        x.restore();
      }
      // the pictures riding on the missiles
      for (const m of V.missiles || []) {
        mark(); const heavy = m.kind === 'heavy', ring = heavy ? '#ffb347' : m.kind === 'swarm' ? '#fff3dc' : '#ffd27a';
        disc(avatarOf(m.viewer), mx(m.x), m.y, m.r, ring, heavy ? 7 : 4, m.a);
        if (heavy && m.viewer) text('@' + m.viewer.name, clamp(mx(m.x) / k, SAFE.x0 + 110, SAFE.x1 - 110), (m.y + m.r) / k + 34, { size: 26, align: 'center', a: m.a, stroke: 5, fit: 220 });
      }
      for (const s of V.strikes || []) { mark(); const sx = clamp(mx(s.x) / k + (st.mirror ? -120 : 120), SAFE.x0 + 70, SAFE.x1 - 70) * k; disc(avatarOf(s.viewer), sx, s.y - 120 * k, 34 * k, '#ffb347', 5, 0.6 + 0.4 * s.k); text('INCOMING', sx / k, (s.y - 120 * k) / k + 68, { size: 24, align: 'center', track: 4, col: '#ffb347', stroke: 5, a: 0.6 + 0.4 * Math.sin(V.t * 12) * s.k }); }
      if (V.boss) { mark(); bars(V.boss, V); credits(V.boss, V); }
      if (V.vote) { mark(); vote(V.vote, V); }
      // pop-ups
      for (const p of V.pops || []) {
        const u = V.t - p.t; if (u < 0 || u > 1.4) continue; mark();
        const a = ss(0, 0.08, u) * (1 - ss(0.9, 1.4, u)), A = V.anchors || {};
        if (p.kind === 'ate') { const m = A.mouth || [W / 2, H / 2]; text(p.text, clamp(mx(m[0]) / k, SAFE.x0 + 260, SAFE.x1 - 260), m[1] / k + 150 + u * -30, { size: 50, align: 'center', a, stroke: 8, col: '#fff', glow: hex(bc), fit: 520 }); }
        else if (p.kind === 'stage') { const sc = 1 + 0.25 * (1 - ss(0, 0.18, u)), py = barsTop(st.barsY) > 400 && barsTop(st.barsY) < 900 ? 470 : 600; x.save(); x.translate(SAFE.cx * k, py * k); x.scale(sc, sc); x.translate(-SAFE.cx * k, -py * k); text(p.text, SAFE.cx, py, { fit: 700, size: 92, align: 'center', track: 8, a, stroke: 10, col: p.text === 'DEMON MODE' ? '#ff5a2a' : '#ffd27a', glow: '#ff2a00' }); x.restore(); }
        else if (p.at) text(p.text, clamp(mx(p.at[0]) / k, SAFE.x0 + 120, SAFE.x1 - 120), clamp(p.at[1] / k - 60 - u * 70, SAFE.y0 + 40, SAFE.y1 - 10), { size: p.kind === 'dodge' ? 30 : 32, align: 'center', a, stroke: 6, col: p.kind === 'dodge' ? '#fff' : '#ffd27a', fit: 240 });
      }
      // the score: counts up, lands with a small punch
      if (V.score) {
        const s = V.score, u = s.u, shownN = Math.round(s.n * ss(0, 1.1, u)), a = ss(0, 0.2, u) * (1 - ss(4.0, 4.6, u)), punch = 1 + 0.22 * Math.exp(-Math.max(0, u - 1.1) * 9) * (u > 1.1 ? 1 : 0); mark();
        const col = u < 1.1 ? '#fff' : s.kind === 'fire' ? '#ffd27a' : s.kind === 'goo' ? hex(TOXICC) : '#fff', glow = u < 1.1 ? null : s.kind === 'fire' ? '#ff7a1a' : s.kind === 'goo' ? '#3cff1a' : null;
        text('SCORE', SAFE.cx, 244, { size: 30, align: 'center', track: 10, a, stroke: 5, col: 'rgba(255,240,225,0.85)' });
        x.save(); x.translate(SAFE.cx * k, 356 * k); x.scale(punch, punch); x.translate(-SAFE.cx * k, -356 * k); text(String(shownN), SAFE.cx, 378, { size: 150, align: 'center', a, stroke: 12, col, glow }); x.restore();
      }
      // V9 HYPE: a gifter's name, for a moment, under their picture in the orbit
      for (const g of V.gifters || []) { if (!(g.a > 0.02) || !g.front) continue; mark(); text('@' + g.name.replace(/^@/, ''), mx(g.x) / k, (g.y + g.r * 1.25) / k + 30, { size: g.tier >= 2 ? 30 : 26, align: 'center', a: g.a, stroke: 6, col: g.tier >= 2 ? '#ffd27a' : '#ffffff', fit: 300 }); }
      // the rank banner (only when the rank changes) and the "+1 MYTHIC" pop
      if (V.hype && !V.boss && !V.vote && !V.score && !V.verdict) {
        const h = V.hype;
        // (phase 2) the rank's name sits on a dark plate with a chrome hairline: readable over the brightest flames
        if (h.upAge < 2.8) { const a = ss(0, 0.2, h.upAge) * (1 - ss(2.2, 2.8, h.upAge)), size = h.rank >= 4 ? 80 : 66; mark(); plate(h.label, SAFE.cx, 300, size, 8, a, h.rank >= 4 ? '#ffd27a' : '#ffffff', h.rank >= 2 ? '#ff5a1a' : null); }
        else if (h.plusAge < 1.6) { const a = ss(0, 0.1, h.plusAge) * (1 - ss(1.0, 1.6, h.plusAge)); mark(); plate('+1 MYTHIC', SAFE.cx, 300, 70, 8, a, '#ffd27a', '#ff9a2a'); }
      }
      // release A: the song's name while the Mask eats it ...
      if (V.eating && V.eating.title && V.eating.a > 0.01 && !V.score && !(V.hype && V.hype.upAge < 2.8) && !V.boss && !V.vote) { const a = V.eating.a; mark(); text('NOW EATING', SAFE.cx, 244, { size: 26, align: 'center', track: 8, a, stroke: 5, col: hex(GOLDC) }); text(V.eating.title, SAFE.cx, 298, { size: 46, align: 'center', a, stroke: 7, fit: 800 }); }
      // (fix round V-6) while it chews and waits for his verdict: a small caption under the Mask, three dots that count
      if (V.chewing && V.chewing.a > 0.01 && !V.boss && !V.vote) {
        const A = V.anchors || {}, m = A.mouth || [W / 2, H * 0.55], un = A.unit || 300 * k, a = V.chewing.a * (0.78 + 0.22 * Math.sin(V.chewing.u * 3.2)), n = 1 + Math.floor(V.chewing.u * 2.2) % 3; mark();
        const py = clamp(m[1] / k + 0 * un + 410, SAFE.y0 + 300, SAFE.y1 - 30), px = clamp(mx(m[0]) / k - 215, SAFE.x0 + 10, SAFE.x1 - 470);
        void px; plate('CHEWING ON IT' + '...'.slice(0, n) + '   '.slice(n), SAFE.cx, py, 34, 7, a, hex(GOLDC), null);      // (on a dark plate: his chin often reaches the safe zone's lower edge, so it cannot always sit clear of it)
      }
      // ... and his verdict: the WORD itself is the Mask's own fire (mask-v8.js); here only what frames it, crisp: a small
      // "THE VERDICT" under it between two hairlines (flames stand on top of it), then the song's name. No "SCORE", no number.
      if (V.verdict && V.verdict.a > 0.01 && !V.boss && !V.vote) {
        const v = V.verdict, a = v.a, top = clamp((v.top === null || v.top === undefined ? 0.172 * H : v.top) / k, SAFE.y0 + 70, 900), bot = clamp((v.bottom === null || v.bottom === undefined ? 0.318 * H : v.bottom) / k, top + 60, SAFE.y1 - 120); mark();
        const cy = bot + 58; text('THE VERDICT', SAFE.cx, cy, { size: 30, align: 'center', track: 12, a, stroke: 5, col: 'rgba(255,240,225,0.95)' });
        x.globalAlpha = a * 0.8; x.fillStyle = hex(GOLDC); for (const sd of [-1, 1]) x.fillRect((SAFE.cx + sd * 170 - (sd < 0 ? 150 : 0)) * k, (cy - 12) * k, 150 * k, Math.max(1, 2 * k)); x.globalAlpha = 1;
        if (v.title) text(v.title, SAFE.cx, bot + 110, { size: 38, align: 'center', a: a * 0.95, stroke: 6, fit: 760, col: 'rgba(255,246,236,0.98)' });
      }
      // demo only: what is being shown (the render tool passes it; the product never does)
      if (label) { mark(); let size = 44; font('700', size); let tw = x.measureText(label).width / k; if (tw > 960) { size = Math.floor(size * 960 / tw); font('700', size); tw = x.measureText(label).width / k; } const w = (tw + 64) * k; rr(W / 2 - w / 2, 1470 * k, w, 84 * k, 42 * k); x.fillStyle = 'rgba(12,7,6,0.84)'; x.fill(); x.lineWidth = 2 * k; x.strokeStyle = 'rgba(255,255,255,0.6)'; x.stroke(); text(label, 540, 1527, { w: '700', size, align: 'center', col: 'rgba(255,246,236,0.98)' }); }
      void INK; void CHROME;
      return any;
    }
    return { draw, setLayout(l) { lay = l === 'versus' ? 'versus' : 'stack'; }, state: st };
  }
  const api = { create, placeholder, SAFE, barsTop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VTMaskHud = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
