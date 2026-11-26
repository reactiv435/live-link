// V9 SHOW OPENING, what is READ on the countdown card (V9-SHOW-OPEN.md): the wordmark, the timer, the rotating panels
// (the queue, boosts + skips, every tap counts), the IGNITION meter with the live counters, and the last ten numbers.
// A 2D canvas above the show layer (v9-show-gl.js). Chrome type on crimson, warm darks only (never a blue-grey).
// Everything that matters sits inside TikTok's free area of a 1080 x 1920 picture: x 60 .. 930, y 200 .. 1436.
//
//   const card = VTShowCard.create(canvas, { width, height });
//   card.draw(view, { t, beat (0..1 pulse), covers: Map(url -> image) })      view = the countdown's step() result
//   card.clear()
(function (root) {
  'use strict';
  const FONT = '"Bahnschrift", "Segoe UI", system-ui, sans-serif';
  function create(canvas, { width = 1080, height = 1920, copy = null } = {}) {
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d'), s = width / 1080;
    const C = copy || (root.VTShowOpen ? root.VTShowOpen.COPY : {});
    const L = 70, R = 930, MID = (L + R) / 2;
    const font = (px, w = 700, stretch = 'condensed') => { g.font = `${w} ${stretch} ${px}px ${FONT}`; };
    const space = (px) => { try { g.letterSpacing = px + 'px'; } catch (e) { /* an older browser: no tracking */ } };
    function chrome(y0, y1) {
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.36, '#e9e2de'); gr.addColorStop(0.5, '#8d827d'); gr.addColorStop(0.56, '#f7f2ef'); gr.addColorStop(1, '#b3a8a3');
      return gr;
    }
    /** chrome letters with a crimson glow under them; align: 'center' | 'left' | 'right' */
    function chromeText(text, x, y, px, { align = 'center', weight = 700, glow = 0.8, track = 0, stretch = 'condensed' } = {}) {
      font(px, weight, stretch); space(track); g.textAlign = align; g.textBaseline = 'alphabetic';
      g.save();
      g.shadowColor = `rgba(230, 20, 48, ${glow})`; g.shadowBlur = px * 0.35; g.fillStyle = '#e01f3d'; g.globalAlpha *= 0.9; g.fillText(text, x, y);
      g.restore();
      g.save(); g.lineJoin = 'round'; g.lineWidth = Math.max(2, px * 0.045); g.strokeStyle = 'rgba(20, 4, 4, .95)'; g.strokeText(text, x, y); g.restore();
      g.fillStyle = chrome(y - px * 0.78, y + px * 0.06); g.fillText(text, x, y);
      space(0);
    }
    function plain(text, x, y, px, colour, { align = 'left', weight = 600, track = 0, stretch = 'condensed', max = 0 } = {}) {
      font(px, weight, stretch); space(track); g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillStyle = colour;
      let tx = text;
      if (max && g.measureText(tx).width > max) { while (tx.length > 2 && g.measureText(tx + '…').width > max) tx = tx.slice(0, -1); tx += '…'; }
      g.fillText(tx, x, y); space(0);
    }
    function round(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
    function brackets(x, y, w, h, len, colour, lw = 3) {
      g.strokeStyle = colour; g.lineWidth = lw; g.lineCap = 'square'; g.beginPath();
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) { g.moveTo(cx + dx * len, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + dy * len); }
      g.stroke();
    }
    function rule(y, a = 1) {
      const gr = g.createLinearGradient(L, 0, R, 0); gr.addColorStop(0, 'rgba(224,31,61,0)'); gr.addColorStop(0.2, `rgba(224,31,61,${0.9 * a})`); gr.addColorStop(0.5, `rgba(255,236,228,${a})`); gr.addColorStop(0.8, `rgba(224,31,61,${0.9 * a})`); gr.addColorStop(1, 'rgba(224,31,61,0)');
      g.fillStyle = gr; g.fillRect(L, y, R - L, 2.5);
      g.save(); g.translate(MID, y + 1); g.rotate(Math.PI / 4); g.fillStyle = `rgba(255,236,228,${a})`; g.fillRect(-6, -6, 12, 12); g.restore();
    }
    function header(view, a) {
      g.save(); g.globalAlpha = a;
      // the wordmark: REACTIVVIBE in chrome, AI in crimson
      font(74, 700, 'normal'); space(5);
      const w1 = g.measureText('REACTIVVIBE').width, w2 = g.measureText('AI').width, x0 = MID - (w1 + w2 + 14) / 2;
      space(0);
      chromeText('REACTIVVIBE', x0, 266, 74, { align: 'left', track: 5, glow: 0.55, stretch: 'normal' });
      font(74, 700, 'normal'); space(5); g.textAlign = 'left';
      g.save(); g.shadowColor = 'rgba(255,40,70,.9)'; g.shadowBlur = 22; g.fillStyle = '#ff2d4d'; g.fillText('AI', x0 + w1 + 14, 266); g.restore(); space(0);
      rule(290);
      g.restore();
    }
    function timer(view, a) {
      g.save(); g.globalAlpha = a;
      plain(C.starts || 'THE SHOW STARTS IN', MID, 344, 31, '#f0e2dc', { align: 'center', weight: 600, track: 9, stretch: 'normal' });
      // every character in its own slot: the numbers do not jiggle as they change
      const txt = view.text, px = 176, slot = px * 0.56, colon = px * 0.30;
      let w = 0; for (const ch of txt) w += ch === ':' ? colon : slot;
      let x = MID - w / 2;
      for (const ch of txt) { const cw = ch === ':' ? colon : slot; chromeText(ch, x + cw / 2, 500, px, { weight: 700, glow: 0.7, stretch: 'normal' }); x += cw; }
      g.restore();
    }
    function bigNumber(view, t, beat) {
      const age = view.tickAge, n = view.n, punch = 1 + 0.34 * Math.exp(-age / 0.11), a = Math.min(1, age / 0.04);
      g.save(); g.translate(MID, 548); g.scale(punch, punch); g.globalAlpha = a;
      // a ring thrown off by each number
      g.save(); g.globalAlpha = a * Math.max(0, 1 - age / 0.7) * 0.8; g.strokeStyle = '#ff2d4d'; g.lineWidth = 6 * (1 - Math.min(1, age / 0.7)) + 1; g.shadowColor = '#ff2d4d'; g.shadowBlur = 30; g.beginPath(); g.arc(0, -98, 150 + age * 520, 0, 6.2832); g.stroke(); g.restore();
      if (n > 0) chromeText(String(n), 0, 0, 280, { weight: 700, glow: 1, stretch: 'normal' });
      else chromeText(C.live || 'WE ARE LIVE', 0, -58, 112, { weight: 700, glow: 1, track: 2 });
      g.restore();
    }
    function cover(img, x, y, w, i) {
      g.save(); round(x, y, w, w, 10); g.clip();
      if (img && (img.naturalWidth || img.width)) { const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, k = Math.max(w / iw, w / ih); g.drawImage(img, x + (w - iw * k) / 2, y + (w - ih * k) / 2, iw * k, ih * k); }
      else {
        const gr = g.createLinearGradient(x, y, x + w, y + w); gr.addColorStop(0, '#5c0a16'); gr.addColorStop(1, '#170505'); g.fillStyle = gr; g.fillRect(x, y, w, w);
        font(w * 0.56, 700, 'normal'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,236,228,.85)'; g.fillText('♪', x + w / 2, y + w / 2 + 2);
      }
      g.restore();
      g.save(); round(x, y, w, w, 10); g.strokeStyle = 'rgba(255,60,90,.9)'; g.lineWidth = 2.5; g.stroke(); g.restore();
    }
    function panel(view, o) {
      const p = view.panel; if (!p) return;
      const k = Math.min(1, p.age / 0.45, (p.life - p.age) / 0.35), e = k * k * (3 - 2 * k), x = L, y = 1052 + (1 - e) * 26, w = R - L, h = 282;
      g.save(); g.globalAlpha = e;
      round(x, y, w, h, 14);
      const bg = g.createLinearGradient(0, y, 0, y + h); bg.addColorStop(0, 'rgba(34,8,10,.86)'); bg.addColorStop(1, 'rgba(10,3,3,.88)'); g.fillStyle = bg; g.fill();
      g.strokeStyle = 'rgba(224,31,61,.55)'; g.lineWidth = 1.5; g.stroke();
      brackets(x - 5, y - 5, w + 10, h + 10, 30, '#efe6e1', 3);
      // the title bar
      const body = p.id === 'queue' ? C.queue : p.id === 'boosts' ? C.boosts : C.engage;
      g.fillStyle = '#e01f3d'; g.fillRect(x + 24, y + 26, 7, 40);
      chromeText(body.title, x + 46, y + 63, 46, { align: 'left', glow: 0.5 });
      // which panel of how many
      const ids = (view.queue && view.queue.length ? ['queue'] : []).concat(['boosts', 'engage']);
      ids.forEach((id, i) => { g.fillStyle = id === p.id ? '#ff2d4d' : 'rgba(239,230,225,.28)'; g.fillRect(x + w - 30 - (ids.length - i) * 30, y + 42, 22, 5); });
      if (id2(p.id) === 'queue') {
        const rows = view.queue.slice(0, 3), rh = 62;
        rows.forEach((q, i) => {
          const ry = y + 86 + i * rh;
          plain(String(i + 1), x + 40, ry + 42, 38, i === 0 ? '#ff2d4d' : 'rgba(239,230,225,.55)', { align: 'center', weight: 700, stretch: 'normal' });
          cover(o.covers ? o.covers.get(q.cover) : null, x + 68, ry + 3, 54, i);
          plain(q.title, x + 140, ry + 29, 33, '#fff6f1', { weight: 700, max: w - 170 });
          if (q.artist) plain(q.artist, x + 140, ry + 55, 24, 'rgba(240,214,205,.78)', { weight: 500, stretch: 'normal', max: w - 170 });
        });
      } else {
        body.lines.forEach((ln, i) => {
          const ry = y + 126 + i * 60;
          let tx = x + 30;
          if (ln[0]) {
            font(27, 700, 'normal'); space(2); const tw = g.measureText(ln[0]).width + 30; space(0);
            round(tx, ry - 32, tw, 42, 8); g.fillStyle = '#c8142f'; g.fill();
            plain(ln[0], tx + tw / 2 + 1, ry - 2, 27, '#fff', { align: 'center', weight: 700, track: 2, stretch: 'normal' });
            tx += tw + 18;
          }
          plain(ln[1], tx, ry, 35, ln[0] ? '#fff6f1' : 'rgba(240,214,205,.8)', { weight: 600, max: x + w - 24 - tx });
        });
      }
      g.restore();
    }
    const id2 = (id) => id;
    const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    function meter(view, t, beat) {
      const x = L, y = 1394, w = R - L, h = 36, m = view.meter, full = m >= 0.999, hit = Math.exp(-view.sinceHit / 0.25);
      plain(C.meter || 'IGNITION', x, y - 16, 30, '#fff6f1', { weight: 700, track: 6, stretch: 'normal' });
      // the counters, live
      font(30, 700, 'normal'); g.textAlign = 'right';
      const gTxt = fmt(view.gifts), tTxt = fmt(view.taps);
      let rx = x + w;
      plain(gTxt, rx, y - 16, 32, '#ffd9a8', { align: 'right', weight: 700, stretch: 'normal' }); font(32, 700, 'normal'); rx -= g.measureText(gTxt).width + 10;
      plain(C.gifts || 'GIFTS', rx, y - 16, 22, 'rgba(240,214,205,.75)', { align: 'right', weight: 600, track: 3, stretch: 'normal' }); font(22, 600, 'normal'); space(3); rx -= g.measureText(C.gifts || 'GIFTS').width + 30; space(0);
      plain(tTxt, rx, y - 16, 32, '#fff6f1', { align: 'right', weight: 700, stretch: 'normal' }); font(32, 700, 'normal'); rx -= g.measureText(tTxt).width + 10;
      plain(C.taps || 'TAPS', rx, y - 16, 22, 'rgba(240,214,205,.75)', { align: 'right', weight: 600, track: 3, stretch: 'normal' });
      // the bar
      g.save(); round(x, y, w, h, 6); g.fillStyle = 'rgba(16,4,4,.85)'; g.fill(); g.strokeStyle = 'rgba(239,230,225,.55)'; g.lineWidth = 1.5; g.stroke(); g.clip();
      const fw = Math.max(0, w * m);
      if (fw > 0) {
        const gr = g.createLinearGradient(x, 0, x + Math.max(fw, 60), 0); gr.addColorStop(0, '#5c0612'); gr.addColorStop(0.75, '#d9122f'); gr.addColorStop(0.95, '#ff5a2c'); gr.addColorStop(1, '#fff1e0');
        g.fillStyle = gr; g.fillRect(x, y, fw, h);
        g.fillStyle = `rgba(255,255,255,${0.04 + 0.16 * hit + (full ? 0.08 * beat : 0)})`; g.fillRect(x, y, fw, h * 0.42);
      }
      g.fillStyle = 'rgba(10,3,3,.75)'; for (let i = 1; i < 20; i++) g.fillRect(x + w * i / 20 - 1.5, y, 3, h);
      g.restore();
      if (fw > 4) { g.save(); g.shadowColor = '#ff5a3c'; g.shadowBlur = 26 + 20 * hit; g.fillStyle = '#fff1e0'; g.fillRect(x + fw - 3, y - 4, 4, h + 8); g.restore(); }
      if (full) { g.save(); g.globalAlpha = 0.75 + 0.25 * beat; chromeText('FULL POWER', x + w / 2, y + h - 5, 27, { weight: 700, track: 6, glow: 1, stretch: 'normal' }); g.restore(); }
    }
    function draw(view, o = {}) {
      g.setTransform(s, 0, 0, s, 0, 0); g.clearRect(0, 0, 1080, 1920);
      if (!view) return;
      const t = o.t || 0, beat = o.beat || 0, out = view.done ? Math.max(0, 1 - Math.max(0, view.doneAge - 0.9) / 0.4) : 1;
      g.save(); g.globalAlpha = out;
      header(view, 1);
      if (view.big) bigNumber(view, t, beat); else timer(view, 1);
      panel(view, o);
      if (!view.done) meter(view, t, beat);
      g.restore();
    }
    return { draw, clear() { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, width, height); }, canvas };
  }
  root.VTShowCard = { create };
})(typeof globalThis !== 'undefined' ? globalThis : self);
