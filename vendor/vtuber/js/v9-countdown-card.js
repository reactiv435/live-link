// COUNTDOWN 2.0, what is READ (review/V9-COUNTDOWN-NOTES.md): a broadcast graphic round the Mask, never over its face.
//   THE TOP BAND     the wordmark, THE SHOW STARTS IN and the time (every digit in its own slot); the last ten numbers
//                    in the same place; at the zero WE ARE LIVE.
//   THE LOWER THIRD  NEXT UP (the queue, or the question when it is empty), what BOOST and SKIP do (the reviewed lines
//                    of js/v9-show-copy.js), and TAP THE SCREEN with the taps counted. No meter: the Mask is the meter.
// Chrome on warm black, crimson accents; Chakra Petch (vendor/fonts, SIL OFL) for the numbers and the labels.
// Everything sits inside TikTok's free area of a 1080 x 1920 picture: x 60 .. 930, y 200 .. 1436.
//   const card = VTCountdownCard.create(canvas, { width, height });
//   card.draw(view, { t, w, covers })     view = the engine's countdown step, w = VTCountdown2's step
//   card.clear()
(function (root) {
  'use strict';
  const FONT = '"Chakra Petch", "Bahnschrift", "Segoe UI", system-ui, sans-serif';
  const HERE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/js\/[^/]*$/, '') : '';
  let fontAsked = false;
  /** the font, once per page (the card draws with the fallback until it has loaded) */
  function loadFont() {
    if (fontAsked || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return null;
    fontAsked = true;
    try { const f = new FontFace('Chakra Petch', 'url(' + HERE + 'vendor/fonts/ChakraPetch-Bold.woff2) format("woff2")', { weight: '700' }); document.fonts.add(f); return f.load().catch(() => null); } catch (e) { return null; }
  }
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const ease = (x) => { const k = clamp01(x); return 1 - Math.pow(1 - k, 3); };

  function create(canvas, { width = 1080, height = 1920, copy = null } = {}) {
    canvas.width = width; canvas.height = height;
    loadFont();
    const main = canvas.getContext('2d'), s = width / 1080, H = height / s;
    let g = main;      // (the helpers draw on g: the card, or for a moment the top band's own picture)
    const C = copy || root.VTShowCopy || {}, M = C.mask || {};
    const L = 70, R = 930, MID = (L + R) / 2;
    const S = { t0: null, tapsShown: 0, tapPop: 0, lastT: null, fontOk: false };
    // the top band while the time runs (the wordmark, THE SHOW STARTS IN, the time) is drawn once a second into its own
    // picture, then copied: not redrawn with its glows every frame
    const BAND_H = 620, band = { cv: null, g: null, key: '' };
    function bandPicture(view, w) {
      if (!S.fontOk) S.fontOk = fontReady();
      const key = view.text + '|' + Math.round((0.6 + 0.3 * (w.last || 0)) * 20) + '|' + (S.fontOk ? 1 : 0);
      if (!band.cv) {
        try {
          const bw = canvas.width, bh = Math.ceil(BAND_H * s);
          band.cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bw, bh) : (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: bw, height: bh }) : null);
          band.g = band.cv ? band.cv.getContext('2d') : null;
        } catch (e) { band.cv = null; band.g = null; }
        if (!band.g) { band.cv = false; return null; }
      }
      if (!band.g) return null;
      if (band.key !== key) {
        g = band.g;
        try { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, band.cv.width, band.cv.height); g.setTransform(s, 0, 0, s, 0, 0); g.globalAlpha = 1; bandBase(); plain(C.starts || 'THE SHOW STARTS IN', MID, 308, 29, 'rgba(244,230,224,.86)', { align: 'center', track: 9 }); slots(view.text, MID, 446, 150, 0.6 + 0.3 * (w.last || 0)); band.key = key; } finally { g = main; }
      }
      return band.cv;
    }
    const fontReady = () => (typeof document !== 'undefined' && document.fonts ? document.fonts.check('700 40px "Chakra Petch"') : false);
    const font = (px, w = 700) => { g.font = `${w} ${px}px ${FONT}`; };
    const space = (px) => { try { g.letterSpacing = px + 'px'; } catch (e) { /* no tracking */ } };
    function chrome(y0, y1) {
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.38, '#ece5e1'); gr.addColorStop(0.52, '#8a7f7a'); gr.addColorStop(0.58, '#f8f3f0'); gr.addColorStop(1, '#b5aaa5');
      return gr;
    }
    function chromeText(text, x, y, px, { align = 'center', glow = 0.7, track = 0 } = {}) {
      font(px); space(track); g.textAlign = align; g.textBaseline = 'alphabetic';
      g.save(); g.shadowColor = `rgba(225, 22, 50, ${glow})`; g.shadowBlur = px * 0.32; g.fillStyle = '#d81c3a'; g.globalAlpha *= 0.85; g.fillText(text, x, y); g.restore();
      g.save(); g.lineJoin = 'round'; g.lineWidth = Math.max(2, px * 0.04); g.strokeStyle = 'rgba(16, 4, 4, .95)'; g.strokeText(text, x, y); g.restore();
      g.fillStyle = chrome(y - px * 0.76, y + px * 0.05); g.fillText(text, x, y);
      space(0);
    }
    function plain(text, x, y, px, colour, { align = 'left', weight = 700, track = 0, max = 0 } = {}) {
      font(px, weight); space(track); g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillStyle = colour;
      let tx = String(text || '');
      if (max && g.measureText(tx).width > max) { while (tx.length > 2 && g.measureText(tx + '…').width > max) tx = tx.slice(0, -1); tx += '…'; }
      g.fillText(tx, x, y); const w = g.measureText(tx).width; space(0); return w;
    }
    const width_ = (text, px, track = 0) => { font(px); space(track); const w = g.measureText(text).width; space(0); return w; };
    function brackets(x, y, w, h, len, colour, lw = 3) {
      g.strokeStyle = colour; g.lineWidth = lw; g.lineCap = 'square'; g.beginPath();
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) { g.moveTo(cx + dx * len, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + dy * len); }
      g.stroke();
    }
    function rule(x0, x1, y, a = 1) {
      const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, 'rgba(224,31,61,0)'); gr.addColorStop(0.25, `rgba(224,31,61,${0.9 * a})`); gr.addColorStop(0.5, `rgba(255,238,230,${a})`); gr.addColorStop(0.75, `rgba(224,31,61,${0.9 * a})`); gr.addColorStop(1, 'rgba(224,31,61,0)');
      g.fillStyle = gr; g.fillRect(x0, y, x1 - x0, 2);
    }
    function chip(text, x, y, px, fill, ink) {
      const w = width_(text, px, 3) + px * 1.1, h = px * 1.45;
      g.fillStyle = fill; g.beginPath(); g.moveTo(x + 8, y - h); g.lineTo(x + w, y - h); g.lineTo(x + w - 8, y); g.lineTo(x, y); g.closePath(); g.fill();
      plain(text, x + px * 0.55, y - h * 0.28, px, ink, { track: 3 });
      return w;
    }
    /** the time, every character in its own slot (the numbers do not jiggle as they change) */
    function slots(txt, cx, y, px, glow) {
      const slot = px * 0.60, colon = px * 0.28; let w = 0;
      for (const ch of txt) w += ch === ':' ? colon : slot;
      let x = cx - w / 2;
      for (const ch of txt) { const cw = ch === ':' ? colon : slot; chromeText(ch, x + cw / 2, y, px, { glow }); x += cw; }
    }
    /** what the top band always has: the backing, the wordmark, its rule */
    function bandBase() {
      // a soft dark backing: the words read on any Mask
      g.save(); g.translate(MID, 345); g.scale(1, 0.52);
      const bg = g.createRadialGradient(0, 0, 0, 0, 0, 380); bg.addColorStop(0, 'rgba(8,3,3,.78)'); bg.addColorStop(0.55, 'rgba(8,3,3,.66)'); bg.addColorStop(1, 'rgba(8,3,3,0)');
      g.fillStyle = bg; g.fillRect(-380, -380, 760, 760); g.restore();
      // the wordmark
      const w1 = width_('REACTIVVIBE', 40, 7), w2 = width_('AI', 40, 7), x0 = MID - (w1 + w2 + 12) / 2;
      chromeText('REACTIVVIBE', x0, 240, 40, { align: 'left', track: 7, glow: 0.45 });
      font(40); space(7); g.textAlign = 'left'; g.save(); g.shadowColor = 'rgba(255,40,70,.85)'; g.shadowBlur = 14; g.fillStyle = '#ff2d4d'; g.fillText('AI', x0 + w1 + 12, 240); g.restore(); space(0);
      rule(MID - 230, MID + 230, 260, 0.9);
    }
    function topBand(view, w, t, a) {
      const bigN = !view.done && view.big && view.n > 0;
      if (!view.done && !bigN) {
        const cv = bandPicture(view, w);
        if (cv) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = a; g.drawImage(cv, 0, 0); g.restore(); return; }
      }
      g.save(); g.globalAlpha = a;
      bandBase();
      if (!view.done) {
        if (!bigN) plain(C.starts || 'THE SHOW STARTS IN', MID, 308, 29, 'rgba(244,230,224,.86)', { align: 'center', track: 9 });
        if (bigN) {
          // the last ten: the number in the time's place, thrown in on its beat
          const age = view.tickAge, k = 1 + 0.18 * Math.exp(-age / 0.12), aa = Math.min(1, age / 0.035);
          g.save(); g.translate(MID, 448); g.scale(k, k); g.globalAlpha *= aa;
          g.save(); g.globalAlpha *= Math.max(0, 1 - age / 0.6) * 0.7; g.strokeStyle = '#ff2d4d'; g.lineWidth = 4; g.shadowColor = '#ff2d4d'; g.shadowBlur = 24;
          g.beginPath(); g.ellipse(0, -66, 110 + age * 300, 64 + age * 150, 0, 0, Math.PI * 2); g.stroke(); g.restore();
          chromeText(String(view.n), 0, 0, 190, { glow: 0.95 });
          g.restore();
        } else slots(view.text, MID, 446, 150, 0.6 + 0.3 * (w.last || 0));
      } else {
        const age = view.doneAge, k = 1 + 0.22 * Math.exp(-age / 0.14), aa = Math.min(1, age / 0.05);
        g.save(); g.translate(MID, 404); g.scale(k, k); g.globalAlpha *= aa;
        chromeText(C.live || 'WE ARE LIVE', 0, 0, 112, { glow: 1, track: 2 });
        g.restore();
        g.save(); g.globalAlpha *= clamp01((age - 0.18) / 0.3);
        font(40); space(6); g.textAlign = 'center'; g.shadowColor = 'rgba(255,40,70,.9)'; g.shadowBlur = 18; g.fillStyle = '#ff3352'; g.fillText(C.go || "LET'S GET REACTIVE", MID, 468); space(0);
        g.restore();
      }
      g.restore();
    }
    function lowerThird(view, w, t, a, o) {
      if (a <= 0.001) return;
      const x = 60, y = 1236, wd = 870, h = 196;
      g.save(); g.globalAlpha = a; g.translate(0, (1 - a) * 24);
      const bg = g.createLinearGradient(0, y, 0, y + h); bg.addColorStop(0, 'rgba(20,6,7,.84)'); bg.addColorStop(1, 'rgba(7,3,3,.90)');
      g.fillStyle = bg; g.fillRect(x, y, wd, h);
      g.fillStyle = '#e01f3d'; g.fillRect(x, y, wd, 3);
      brackets(x - 6, y - 6, wd + 12, h + 12, 26, 'rgba(239,230,225,.9)', 2.5);
      // 1. what is coming
      const q = view.queue && view.queue.length ? view.queue : null;
      const cw = chip(M.next || 'NEXT UP', x + 22, y + 58, 22, '#e01f3d', '#fff4ef');
      if (q) {
        const i = Math.floor(Math.max(0, t - (S.t0 || 0)) / 6) % q.length, item = q[i], fade = Math.min(1, ((t - (S.t0 || 0)) % 6) / 0.4, (6 - ((t - (S.t0 || 0)) % 6)) / 0.4);
        g.save(); g.globalAlpha *= q.length > 1 ? fade : 1;
        const tx = x + 22 + cw + 18, tw = plain(item.title, tx, y + 56, 34, '#fff6f1', { max: wd - (tx - x) - 40 });
        if (item.artist) plain(item.artist, tx + tw + 14, y + 56, 24, 'rgba(240,214,205,.72)', { weight: 700, max: Math.max(0, wd - (tx - x) - tw - 60) });
        g.restore();
      } else plain(C.queue && C.queue.title ? C.queue.title : 'IS YOUR SONG UP TONIGHT?', x + 22 + cw + 18, y + 56, 30, '#fff6f1', { track: 1, max: wd - cw - 70 });
      rule(x + 22, x + wd - 22, y + 82, 0.45);
      // 2. what BOOST and SKIP do (the reviewed words)
      const lines = (C.boosts && C.boosts.lines) || [];
      let bx = x + 22;
      for (const ln of lines.slice(0, 2)) {
        if (!ln[0]) continue;
        const k = chip(ln[0], bx, y + 128, 20, 'rgba(239,230,225,.92)', '#1a0606');
        const tw = plain(ln[1], bx + k + 10, y + 124, 23, 'rgba(244,230,224,.9)', { weight: 700 });
        bx += k + 10 + tw + 26;
      }
      // 3. tap the screen
      const pop = S.tapPop, n = String(Math.round(S.tapsShown)), nx = x + wd - 22;
      const lx = x + 22 + width_(M.tap || 'TAP THE SCREEN', 25, 4) + 14, countL = nx - width_(n, 34) * 1.18 - 12 - width_(M.taps || 'TAPS', 18, 3) - 18;
      plain(M.tap || 'TAP THE SCREEN', x + 22, y + 172, 25, '#ff4a64', { track: 4 });
      if (countL - lx > 40) plain(M.tapLine || '', lx, y + 172, 22, 'rgba(240,214,205,.78)', { weight: 700, max: countL - lx });
      g.save(); g.translate(nx, y + 172); g.scale(1 + 0.18 * pop, 1 + 0.18 * pop);
      plain(n, 0, 0, 34, pop > 0.05 ? '#ffe2c2' : '#fff6f1', { align: 'right' });
      g.restore();
      plain(M.taps || 'TAPS', nx - width_(n, 34) - 12, y + 170, 18, 'rgba(240,214,205,.7)', { align: 'right', track: 3 });
      g.restore();
    }
    function draw(view, o = {}) {
      const t = Number.isFinite(o.t) ? o.t : 0, w = o.w || {};
      if (S.t0 === null) S.t0 = t;
      const dt = S.lastT === null ? 0 : Math.max(0, Math.min(0.2, t - S.lastT)); S.lastT = t;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
      if (!view) return;
      g.setTransform(s, 0, 0, s, 0, 0);
      // the taps counter counts up to the real number (it never shows more than came)
      const taps = Number(view.taps) || 0;
      if (taps > S.tapsShown + 0.5) S.tapPop = 1;
      S.tapsShown += (taps - S.tapsShown) * (1 - Math.exp(-dt * 9)); if (Math.abs(taps - S.tapsShown) < 0.5) S.tapsShown = taps;
      S.tapPop *= Math.exp(-dt * 6);
      const life = t - S.t0, inK = ease(life / 0.7);
      topBand(view, w, t, inK);
      lowerThird(view, w, t, inK * (view.done ? 1 - clamp01(view.doneAge / 0.45) : 1), o);
      void H;
    }
    return { draw, clear(o) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); const keep = !!(o && o.keep); if (!keep) { S.t0 = null; S.lastT = null; } S.tapsShown = o && Number.isFinite(Number(o.taps)) ? Math.max(0, Number(o.taps)) : 0; S.tapPop = 0; }, fontReady };
  }
  root.VTCountdownCard = { create, loadFont };
})(typeof globalThis !== 'undefined' ? globalThis : self);
