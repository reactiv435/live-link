// Tracker v2: finds the camera PICTURE inside a captured window (an OBS Windowed Projector: a title bar on top, and
// black bars left/right or top/bottom where the picture does not fill the window). Pure UMD (no DOM): the tracker
// page hands it a few RGBA snapshots of the captured window; the Node tests hand it made-up windows.
//
//   VTRect.find(frames, opts) -> { x, y, w, h, title, bars: { l, r, t, b }, conf, motion, why }
//     frames: [{ data: RGBA bytes, width, height }, ...] snapshots of the SAME size taken a moment apart (1 is allowed,
//             3-6 is better: what never changes between them cannot be the camera).
//     x, y, w, h: the picture, in pixels of the snapshot, snapped to even numbers. conf 0..1: how sure.
//   VTRect.manual(width, height, { l, r, t, b }) -> the rectangle left after cutting those margins (pixels).
//   VTRect.scale(rect, k) -> the same rectangle in a picture k times larger.
//
// How: a bar is a full run of rows or columns that is one flat colour and never changes. Left / right bars are read
// from the middle of the window (below any title bar). With side bars present the title bar is exact: it is the top
// rows where the bar columns do NOT show the bar colour. Without side bars the title bar is the leading rows that
// never change and are mostly one colour.
// A projector fits the picture into the window, so there are bars on ONE axis only: with side bars the picture runs
// from the title bar to the bottom edge, and flat black rows at its top or bottom belong to the picture (a dark
// room, a letterboxed recording) and are kept.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VTRect = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const even = (v) => v & ~1;
  const evenUp = (v) => (v + 1) & ~1;

  function find(frames, opts = {}) {
    const o = { tol: 14, liveTol: 10, minSide: 48, ...opts };
    const f0 = frames && frames[0];
    if (!f0 || !f0.data || !(f0.width > 0) || !(f0.height > 0)) return null;
    const W = f0.width, H = f0.height, d = f0.data;
    const full = { x: 0, y: 0, w: even(W), h: even(H), title: 0, bars: { l: 0, r: 0, t: 0, b: 0 }, conf: 0, motion: false, why: 'whole window' };
    if (W < o.minSide * 2 || H < o.minSide * 2) return full;

    // ---- what changes between the snapshots ("live" pixels)
    let live = null, liveCount = 0;
    const same = frames.filter((f) => f && f.width === W && f.height === H);
    if (same.length >= 2) {
      live = new Uint8Array(W * H);
      for (let k = 1; k < same.length; k++) {
        const e = same[k].data;
        for (let p = 0, i = 0; p < W * H; p++, i += 4) {
          if (live[p]) continue;
          const dl = Math.abs(d[i] - e[i]) + Math.abs(d[i + 1] - e[i + 1]) + Math.abs(d[i + 2] - e[i + 2]);
          if (dl > o.liveTol * 3) { live[p] = 1; liveCount++; }
        }
      }
    }
    const motion = liveCount > W * H * 0.002;
    const useLive = motion ? live : null;
    const diff = (i, j) => Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2]));

    // ---- flat + unchanging runs
    /** Column x between rows ya..yb: one colour (1 % of stray pixels allowed) and nothing changing. */
    const flatCol = (x, ya, yb) => {
      const ref = (((ya + yb) >> 1) * W + x) * 4;
      let off = 0, lv = 0;
      const n = yb - ya, lim = Math.max(1, Math.floor(n * 0.01));
      for (let y = ya; y < yb; y++) {
        const p = y * W + x;
        if (diff(p * 4, ref) > o.tol && ++off > lim) return false;
        if (useLive && useLive[p] && ++lv > lim) return false;
      }
      return true;
    };
    /** Row y between columns xa..xb: one colour and nothing changing. */
    const flatRow = (y, xa, xb) => {
      const ref = (y * W + ((xa + xb) >> 1)) * 4;
      let off = 0, lv = 0;
      const n = xb - xa, lim = Math.max(1, Math.floor(n * 0.01));
      for (let x = xa; x < xb; x++) {
        const p = y * W + x;
        if (diff(p * 4, ref) > o.tol && ++off > lim) return false;
        if (useLive && useLive[p] && ++lv > lim) return false;
      }
      return true;
    };

    // ---- left / right bars, read below any title bar
    const ya = Math.floor(H * 0.3), yb = Math.floor(H * 0.92);
    let L = 0, R = 0;
    while (L < W - o.minSide && flatCol(L, ya, yb)) L++;
    if (L >= W - o.minSide) return { ...full, motion, why: 'nothing but one flat colour: is the camera showing?' };
    while (R < W - L - o.minSide && flatCol(W - 1 - R, ya, yb)) R++;
    const xa = L, xb = W - R;

    // ---- bottom bar (with side bars: only a thin window edge can be cut off, the picture fills the height)
    const sideBars = L >= 6 || R >= 6;
    const edge = 4;
    let B = 0;
    while (B < (sideBars ? edge : H - o.minSide) && flatRow(H - 1 - B, xa, xb)) B++;

    // ---- top: the title bar, then any top bar
    const yMax = Math.min(Math.floor(H * 0.3), 200);
    let T = 0, how;
    if (sideBars) {
      // Side bars exist. Under the title bar a bar column shows its bar colour; inside the title bar it does not.
      const mid = (ya + yb) >> 1;
      const barRow = (y) => {
        let ok = 0, n = 0;
        for (let x = 1; x < L - 1; x++) { n++; if (diff((y * W + x) * 4, (mid * W + x) * 4) <= o.tol) ok++; }
        for (let x = W - R + 1; x < W - 1; x++) { n++; if (diff((y * W + x) * 4, (mid * W + x) * 4) <= o.tol) ok++; }
        return n === 0 || ok >= n * 0.9;
      };
      for (let y = 0; y < yMax; y++) if (!barRow(y)) T = y + 1;
      how = 'side bars';
    } else {
      // No side bars: the title bar is the leading rows that never change and are mostly one colour.
      const hist = new Uint16Array(32768);
      const chromeLike = (y) => {
        hist.fill(0);
        let best = 0, lv = 0;
        for (let x = 0; x < W; x++) {
          const p = y * W + x, i = p * 4;
          if (useLive && useLive[p]) lv++;
          const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
          const c = ++hist[key];
          if (c > best) best = c;
        }
        return lv <= W * 0.01 && best >= W * 0.5;
      };
      while (T < yMax && chromeLike(T)) T++;
      if (T >= yMax) T = 0;                 // the whole top third looks like a title bar: it is a still picture, not a bar
      how = useLive ? 'still top rows' : 'flat top rows (one snapshot: check it)';
    }
    let P = T;
    while (P < (sideBars ? T + edge : H - B - o.minSide) && flatRow(P, xa, xb)) P++;

    const x = evenUp(L), y = evenUp(P);
    const w = even(W - R - x), h = even(H - B - y);
    if (w < o.minSide || h < o.minSide) return { ...full, motion, why: 'no picture found' };

    // ---- how sure
    let conf = 0.45;
    const topBar = P - T;
    if (sideBars) { conf += 0.2; if (Math.abs(L - R) <= 3) conf += 0.1; }                  // OBS centres the picture
    else if (topBar >= 4 || B >= 4) { if (Math.abs(topBar - B) <= 3) conf += 0.15; }
    if (useLive) {
      // the moving part of the window must lie inside the rectangle
      let lx0 = W, lx1 = -1, ly0 = H, ly1 = -1, inside = 0;
      for (let yy = 0; yy < H; yy += 2) {
        for (let xx = 0; xx < W; xx += 2) {
          if (!live[yy * W + xx]) continue;
          if (xx < lx0) lx0 = xx; if (xx > lx1) lx1 = xx; if (yy < ly0) ly0 = yy; if (yy > ly1) ly1 = yy;
          if (xx >= x && xx < x + w && yy >= y && yy < y + h) inside++;
        }
      }
      const total = liveCount / 4;
      if (total > 0 && inside >= total * 0.98) conf += 0.25; else conf -= 0.25;
    } else conf -= 0.1;
    if (w * h < W * H * 0.15) conf -= 0.2;
    conf = Math.max(0, Math.min(1, conf));
    return { x, y, w, h, title: T, bars: { l: L, r: R, t: topBar, b: B }, conf, motion, why: how };
  }

  /** The rectangle left after cutting fixed margins (pixels) off a width x height window. */
  function manual(width, height, m = {}) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    const x = evenUp(Math.min(n(m.l), width - 16)), y = evenUp(Math.min(n(m.t), height - 16));
    const w = even(Math.max(16, width - x - n(m.r))), h = even(Math.max(16, height - y - n(m.b)));
    return { x, y, w: Math.min(w, even(width - x)), h: Math.min(h, even(height - y)) };
  }

  /** The same rectangle in a picture k times larger (the snapshots may be smaller than the captured frames). */
  function scale(r, k) {
    if (!r) return null;
    const x = evenUp(Math.round(r.x * k)), y = evenUp(Math.round(r.y * k));
    return { ...r, x, y, w: even(Math.round((r.x + r.w) * k) - x), h: even(Math.round((r.y + r.h) * k) - y) };
  }

  /** Keep a rectangle inside a width x height frame, even-aligned; null when nothing sensible is left. */
  function clampTo(r, width, height) {
    if (!r) return null;
    const x = evenUp(Math.max(0, Math.min(r.x, width - 16))), y = evenUp(Math.max(0, Math.min(r.y, height - 16)));
    const w = even(Math.min(r.w, width - x)), h = even(Math.min(r.h, height - y));
    if (w < 16 || h < 16) return null;
    return { x, y, w, h };
  }

  return { find, manual, scale, clampTo };
});
