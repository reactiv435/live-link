'use strict';
// V9: the size of the VTuber window. It opens at the one-screen control deck's size, 1366 x 768 (2.3.1 opened it at
// 600 x 940, which the deck draws stacked: it needs 1000 wide), never below about 1000 x 640, and always clamped to the
// primary display's work area (a smaller screen never gets a window bigger than itself; a screen smaller than the
// minimum gets the screen). A size the host chose himself (main.js saves it when he resizes the window: the size only,
// never the place) is used again, clamped to the CURRENT work area on every open. A saved size that is the old
// 600 x 940 default, smaller than the minimum, or not a sane whole number is ignored: he gets the new default.
// Electron-free so tests can run it.

const VT_WINDOW = Object.freeze({ width: 1366, height: 768 });
const VT_WINDOW_MIN = Object.freeze({ width: 1000, height: 640 });
const VT_WINDOW_OLD = Object.freeze({ width: 600, height: 940 });
const MAX_SIDE = 16384;   // bigger than any screen: a saved number above it is a broken entry, not a size

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const side = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIDE;

// A saved size as { width, height } (only those two, whole pixels in a sane range), or null.
function cleanVtuberSize(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !own(v, 'width') || !own(v, 'height')) return null;
  if (!side(v.width) || !side(v.height)) return null;
  return { width: v.width, height: v.height };
}

// The work area in whole pixels, or null when the display reports nothing usable (the deck size is then used as it is).
function area(a) {
  if (!a || typeof a !== 'object') return null;
  const w = Math.floor(Number(a.width)), h = Math.floor(Number(a.height));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
}

// { width, height, minWidth, minHeight, saved } for new BrowserWindow (saved = his own size was used).
function vtuberWindowSize({ workArea, saved } = {}) {
  const s = cleanVtuberSize(saved);
  const his = !!s && !(s.width === VT_WINDOW_OLD.width && s.height === VT_WINDOW_OLD.height)
    && s.width >= VT_WINDOW_MIN.width && s.height >= VT_WINDOW_MIN.height;
  const want = his ? s : VT_WINDOW;
  const a = area(workArea);
  const fit = (n, k) => (a ? Math.min(n, a[k]) : n);
  return {
    width: fit(want.width, 'width'), height: fit(want.height, 'height'),
    minWidth: fit(VT_WINDOW_MIN.width, 'width'), minHeight: fit(VT_WINDOW_MIN.height, 'height'),
    saved: his,
  };
}

module.exports = { vtuberWindowSize, cleanVtuberSize, VT_WINDOW, VT_WINDOW_MIN, VT_WINDOW_OLD };
