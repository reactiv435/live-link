// "The picture as shown on stream": how a camera source sits in an OBS scene (crop, flip, turn), and the numbers needed
// to redraw the raw source picture that way. Browser ES module; pure (also used by the tests in Node).
//
// OBS draws a scene item as: crop the source (pixels of the source) -> scale (a negative scale = a flip) -> rotate
// (degrees, clockwise). A view here is { turn: 0|90|180|270, flipH, flipV, crop: { l, r, t, b } as FRACTIONS of the
// source size, stretch: shown height / shown width relative to the cropped source (1 = not stretched) }.

export const IDENTITY = Object.freeze({ turn: 0, flipH: false, flipV: false, crop: Object.freeze({ l: 0, r: 0, t: 0, b: 0 }), stretch: 1 });

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const frac = (v) => Math.min(0.45, Math.max(0, v));

export function isIdentity(v) {
  return !v || (v.turn === 0 && !v.flipH && !v.flipV && v.crop.l === 0 && v.crop.r === 0 && v.crop.t === 0 && v.crop.b === 0 && Math.abs(v.stretch - 1) < 0.01);
}

/** Any angle -> the nearest quarter turn (0, 90, 180, 270), clockwise. */
export function quarterTurn(deg) {
  return ((Math.round(num(deg) / 90) % 4) + 4) % 4 * 90;
}

/** From obs-websocket's GetSceneItemTransform answer (`sceneItemTransform`). */
export function viewFromObs(tr) {
  if (!tr || typeof tr !== 'object') return IDENTITY;
  const sw = num(tr.sourceWidth), sh = num(tr.sourceHeight);
  const sx = num(tr.scaleX, 1) || 1, sy = num(tr.scaleY, 1) || 1;
  const crop = sw > 0 && sh > 0
    ? { l: frac(num(tr.cropLeft) / sw), r: frac(num(tr.cropRight) / sw), t: frac(num(tr.cropTop) / sh), b: frac(num(tr.cropBottom) / sh) }
    : { l: 0, r: 0, t: 0, b: 0 };
  // a bounding box that stretches decides the shape; every other case keeps the scale's own ratio
  let stretch = Math.abs(sy) / Math.abs(sx);
  const cw = sw * (1 - crop.l - crop.r), ch = sh * (1 - crop.t - crop.b);
  if (tr.boundsType === 'OBS_BOUNDS_STRETCH' && num(tr.boundsWidth) > 0 && num(tr.boundsHeight) > 0 && cw > 0 && ch > 0) {
    stretch = (num(tr.boundsHeight) / num(tr.boundsWidth)) / (ch / cw);
  } else if (tr.boundsType && tr.boundsType !== 'OBS_BOUNDS_NONE') stretch = 1;
  if (!(stretch > 0.2 && stretch < 5)) stretch = 1;
  return { turn: quarterTurn(tr.rotation), flipH: sx < 0, flipV: sy < 0, crop, stretch };
}

/** From the tracker's own "Set by hand" settings (crop in percent of the picture). */
export function viewFromManual(s) {
  return {
    turn: quarterTurn(s.turn), flipH: s.flip === 'h', flipV: s.flip === 'v',
    crop: { l: frac(num(s.cropL) / 100), r: frac(num(s.cropR) / 100), t: frac(num(s.cropT) / 100), b: frac(num(s.cropB) / 100) },
    stretch: 1,
  };
}

/**
 * For a raw picture of w x h: the source rectangle to take (sx, sy, sw, sh), the size it is drawn at before the turn
 * (dw, dh), and the size of the finished picture (cw, ch).
 */
export function viewSize(v, w, h) {
  const sx = Math.round(v.crop.l * w), sy = Math.round(v.crop.t * h);
  const sw = Math.max(1, Math.round(w * (1 - v.crop.l - v.crop.r))), sh = Math.max(1, Math.round(h * (1 - v.crop.t - v.crop.b)));
  const dw = sw, dh = Math.max(1, Math.round(sh * v.stretch));
  const side = v.turn === 90 || v.turn === 270;
  return { sx, sy, sw, sh, dw, dh, cw: side ? dh : dw, ch: side ? dw : dh };
}

/** A point of the RAW picture (0..1) -> where it lands in the finished picture (0..1). Used by the tests. */
export function viewPoint(v, x, y) {
  let px = (x - v.crop.l) / (1 - v.crop.l - v.crop.r), py = (y - v.crop.t) / (1 - v.crop.t - v.crop.b);
  if (v.flipH) px = 1 - px;
  if (v.flipV) py = 1 - py;
  if (v.turn === 90) return { x: 1 - py, y: px };
  if (v.turn === 180) return { x: 1 - px, y: 1 - py };
  if (v.turn === 270) return { x: py, y: 1 - px };
  return { x: px, y: py };
}

export function describeView(v) {
  if (isIdentity(v)) return 'not turned, flipped or cropped';
  const parts = [];
  if (v.turn) parts.push('turned ' + v.turn + ' degrees');
  if (v.flipH) parts.push('flipped left-right');
  if (v.flipV) parts.push('flipped up-down');
  if (v.crop.l || v.crop.r || v.crop.t || v.crop.b) parts.push('cropped');
  if (Math.abs(v.stretch - 1) >= 0.01) parts.push('stretched');
  return parts.join(', ');
}
