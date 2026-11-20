// avatar.html, V7 helpers shared by the heroes (js/avatar.js) and the Mask (js/mask-page.js):
//   * the URL kill switches of this round: ?place=0 (no move / size: everything sits at home), ?colour=0 (the Mask
//     stays on Auto), ?shuffle=0 (no shuffle to the beat, no beat light), ?pv=0 (no small picture is sent to the page);
//   * the small picture: what this page shows (background + character, or the Mask), as a tiny JPEG about six times a
//     second while the VTuber window asks for it (`pv: true` in the avatar message). It rides inside an `avatar-ack`
//     (the only thing an avatar page may say on the relay) and never leaves this PC;
//   * the heroes' background shuffle: the next painted place fades in over the old one (never a hard cut to nothing).
(function (root) {
  'use strict';
  const q = new URLSearchParams(root.location ? root.location.search : '');
  const KILL = { place: q.get('place') === '0', colour: q.get('colour') === '0', shuffle: q.get('shuffle') === '0', pv: q.get('pv') === '0', v8: q.get('v8') === '0' };
  const PV = { w: 162, h: 288, everyMs: 160, quality: 0.6 };
  let cv = null, cx = null, lastAt = -1e9;
  const images = {};
  /** a painted background as an image (loaded once; null until it is there) */
  function bgImage(bg) {
    if (typeof bg !== 'string' || !bg.startsWith('preset:')) return null;
    let im = images[bg];
    if (!im) { im = images[bg] = new Image(); im.src = 'assets/bg/' + bg.slice(7) + '.webp'; }
    return im.complete && im.naturalWidth ? im : null;
  }
  const preload = (list) => { for (const b of list || []) bgImage(b); };
  /**
   * The small picture, when one is due (else null). `layers`: what to draw, back to front:
   *   { color: '#000' } | { bg: 'preset:grove' | 'green' | 'black' | 'transparent' } | { canvas, mirror }
   * Call it right after the frame was drawn (a WebGL canvas can only be copied in the same turn it was drawn in).
   */
  function picture(layers, now) {
    if (KILL.pv || now - lastAt < PV.everyMs) return null;
    lastAt = now;
    try {
      if (!cv) { cv = document.createElement('canvas'); cv.width = PV.w; cv.height = PV.h; cx = cv.getContext('2d'); }
      cx.setTransform(1, 0, 0, 1, 0, 0); cx.globalAlpha = 1; cx.filter = 'none';
      cx.fillStyle = '#000'; cx.fillRect(0, 0, PV.w, PV.h);
      for (const l of layers) {
        if (!l) continue;
        if (l.color) { cx.fillStyle = l.color; cx.fillRect(0, 0, PV.w, PV.h); }
        else if (l.bg) {
          if (l.bg === 'green') { cx.fillStyle = '#00c800'; cx.fillRect(0, 0, PV.w, PV.h); }
          else if (l.bg === 'transparent') {            // see-through: his camera shows there; drawn as a quiet pattern
            cx.fillStyle = '#1a1310'; cx.fillRect(0, 0, PV.w, PV.h); cx.fillStyle = '#241a16';
            for (let y = 0; y < PV.h; y += 12) for (let x = (y / 12) % 2 ? 12 : 0; x < PV.w; x += 24) cx.fillRect(x, y, 12, 12);
          } else {
            const im = bgImage(l.bg);
            if (im) { const k = Math.max(PV.w / im.naturalWidth, PV.h / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k; cx.filter = 'blur(1px) brightness(0.82)'; cx.drawImage(im, (PV.w - w) / 2, (PV.h - h) / 2, w, h); cx.filter = 'none'; }
          }
        } else if (l.canvas && l.canvas.width > 1) {
          if (l.mirror) { cx.setTransform(-1, 0, 0, 1, PV.w, 0); }
          cx.drawImage(l.canvas, 0, 0, PV.w, PV.h);
          cx.setTransform(1, 0, 0, 1, 0, 0);
        }
      }
      return cv.toDataURL('image/jpeg', PV.quality);
    } catch (e) { return null; }
  }

  // ---- the heroes' background: the next one fades in over the old one
  let fadeEl = null;
  function fadeTo(bgEl, paint) {
    try {
      if (!fadeEl) { fadeEl = document.getElementById('bg2'); }
      if (fadeEl && bgEl && bgEl.style.display !== 'none') {
        fadeEl.className = bgEl.className; fadeEl.style.backgroundImage = bgEl.style.backgroundImage;
        fadeEl.style.transition = 'none'; fadeEl.style.opacity = '1'; fadeEl.style.display = 'block';
        void fadeEl.offsetWidth;                        // the old picture is on top, at full strength, before the new one is painted under it
        paint();
        fadeEl.style.transition = 'opacity 0.45s ease-out'; fadeEl.style.opacity = '0';
        return;
      }
    } catch (e) { /* no fade: the plain change below */ }
    paint();
  }
  root.VTStage = { KILL, PV, picture, bgImage, preload, fadeTo };
})(typeof globalThis !== 'undefined' ? globalThis : self);
