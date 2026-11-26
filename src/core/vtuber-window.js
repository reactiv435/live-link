'use strict';
// V9: the size of the VTuber window. It opens at the one-screen control deck's size, 1366 x 768 (2.3.1 opened it at
// 600 x 940, which the deck draws stacked: it needs 1000 wide), never below about 1000 x 640, and always clamped to the
// primary display's work area (a smaller screen never gets a window bigger than itself; a screen smaller than the
// minimum gets the screen). A size the host chose himself (he resized the window: the size only, never the place) is
// used again, clamped to the CURRENT work area on every open. A saved size that is the old 600 x 940 default, smaller
// than the minimum, or not a sane whole number is ignored: he gets the new default.
// Fix round 1: every size here is the PAGE's, not the window's: the deck measures its page (it stacks under 1000 px
// of page width), so main.js makes the window with useContentSize: true, and fitVtuberWindow then measures the frame
// around the page (borders, title bar) and keeps page + frame inside the work area. His size is saved as the page's,
// on 'close' and right before the window is destroyed (destroy() skips 'close').
// Electron-free so tests can run it (fitVtuberWindow takes anything shaped like a BrowserWindow).

const VT_WINDOW = Object.freeze({ width: 1366, height: 768 });
const VT_WINDOW_MIN = Object.freeze({ width: 1000, height: 640 });
const VT_WINDOW_OLD = Object.freeze({ width: 600, height: 940 });
const MAX_SIDE = 16384;   // bigger than any screen: a saved number above it is a broken entry, not a size
const MAX_FRAME = 400;    // a frame (borders + title bar) bigger than this is a bad measurement, not a frame

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const side = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIDE;

// A saved size as { width, height } (only those two, whole pixels in a sane range), or null.
function cleanVtuberSize(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !own(v, 'width') || !own(v, 'height')) return null;
  if (!side(v.width) || !side(v.height)) return null;
  return { width: v.width, height: v.height };
}

// The frame around the page in whole pixels ({ 0, 0 } when unknown or not believable).
function cleanFrame(f) {
  const one = (v) => { const n = typeof v === 'number' ? Math.round(v) : NaN; return Number.isFinite(n) && n > 0 && n <= MAX_FRAME ? n : 0; };
  return f && typeof f === 'object' ? { width: one(f.width), height: one(f.height) } : { width: 0, height: 0 };
}

// The room for the PAGE: the work area minus the frame, in whole pixels, or null when the display reports nothing
// usable (the deck size is then used as it is).
function area(a, frame) {
  if (!a || typeof a !== 'object') return null;
  const w = Math.floor(Number(a.width)) - frame.width, h = Math.floor(Number(a.height)) - frame.height;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
}

// The PAGE size { width, height, minWidth, minHeight, saved } (saved = his own size was used). frame = the window's
// frame around the page, when known (fitVtuberWindow measures it); without it the work area is the page's room.
function vtuberWindowSize({ workArea, saved, frame } = {}) {
  const s = cleanVtuberSize(saved);
  const his = !!s && !(s.width === VT_WINDOW_OLD.width && s.height === VT_WINDOW_OLD.height)
    && s.width >= VT_WINDOW_MIN.width && s.height >= VT_WINDOW_MIN.height;
  const want = his ? s : VT_WINDOW;
  const a = area(workArea, cleanFrame(frame));
  const fit = (n, k) => (a ? Math.min(n, a[k]) : n);
  return {
    width: fit(want.width, 'width'), height: fit(want.height, 'height'),
    minWidth: fit(VT_WINDOW_MIN.width, 'width'), minHeight: fit(VT_WINDOW_MIN.height, 'height'),
    saved: his,
  };
}

// The page size to save when the window goes away, or null: only after he resized it, never in a test run, never
// the maximized size (normalBounds = the window's size when not maximized; minus the frame = the page).
function vtSizeToSave({ testRun, resized, normalBounds, frame } = {}) {
  if (testRun || !resized || !normalBounds || typeof normalBounds !== 'object') return null;
  const f = cleanFrame(frame);
  return cleanVtuberSize({ width: normalBounds.width - f.width, height: normalBounds.height - f.height });
}

// Fits a just-made, still hidden VTuber window (made with useContentSize: true at vtuberWindowSize's page size):
// measures its frame; when page + frame is bigger than the work area, shrinks the page and centres the window; sets
// the window's minimum to the page minimum + the frame. Then keeps his size: once he resized it, the page size is
// saved through `store` ('vtuberSize') when the window closes, and by destroy() right before it destroys it.
// A test run's window is left as it is and never saves. Returns { frame, save(), destroy() }.
function fitVtuberWindow(w, { workArea, saved, store, testRun } = {}) {
  let frame = { width: 0, height: 0 };
  try {
    const b = w.getBounds(), c = w.getContentBounds();
    frame = cleanFrame({ width: b.width - c.width, height: b.height - c.height });
  } catch {}
  if (!testRun) {
    try {
      const fit = vtuberWindowSize({ workArea, saved, frame });
      const [cw, ch] = w.getContentSize();
      if (cw !== fit.width || ch !== fit.height) { w.setContentSize(fit.width, fit.height); w.center(); }
      w.setMinimumSize(fit.minWidth + frame.width, fit.minHeight + frame.height);   // Electron: the WINDOW's minimum
    } catch {}
  }
  let resized = false;
  const save = () => {
    try {
      if (testRun || !resized || !store || w.isDestroyed()) return false;
      const s = vtSizeToSave({ testRun, resized, normalBounds: w.getNormalBounds(), frame });
      if (!s) return false;
      store.set('vtuberSize', s);
      return true;
    } catch { return false; }
  };
  try { w.on('resized', () => { resized = true; }); w.on('close', save); } catch {}
  return {
    frame,
    save,
    destroy() {
      try { if (w.isDestroyed()) return; } catch { return; }
      save();
      try { w.destroy(); } catch {}
    },
  };
}

module.exports = { vtuberWindowSize, cleanVtuberSize, vtSizeToSave, fitVtuberWindow, VT_WINDOW, VT_WINDOW_MIN, VT_WINDOW_OLD };
