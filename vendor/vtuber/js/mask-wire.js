// V4 MASK, the wiring shared by the tracker's face worker, the avatar page, the one page and the server (plain UMD, no DOM):
//   - BS_NAMES: MediaPipe's 52 blendshape names in its own order (what mask/mask-live.js wants as `bsNames`)
//   - packFace / unpackFace: ONE raw face result (478 points + 52 scores + the 4x4 matrix) as one small binary message
//   - cleanEvent: a viewer event as LIVE Link sends it (V4-MASK.md), checked and clipped, or null
//   - cleanGiftRows / TRY_EVENTS: the gift list and the "Try the effects" events
//   - levelFollower: a sound LEVEL only (OBS's meter, his voice) as the features mask.audio() takes
// Nothing in here keeps, logs or sends anything.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskWire = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const BS_NAMES = ['_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
    'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
    'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
    'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft',
    'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight'];

  // ---------------------------------------------------------------- one face result as bytes
  // 0  u32 magic 'VTM1'   4 u32 seq   8 f64 at (capture time, ms epoch)   16 u16 w   18 u16 h   20 u8 flags (1 = a face,
  // 2 = the matrix is there)   21..23 0   then, with a face: 1434 f32 points, 52 f32 scores, 16 f32 matrix = 6,032 bytes
  const MAGIC = 0x314d5456, NL = 478, NB = 52, HEAD = 24, FULL = HEAD + (NL * 3 + NB + 16) * 4;
  /**
   * lm: MediaPipe's faceLandmarks[0] ([{x, y, z}] or a flat array of 1434), bs: the 52 scores (an array, or MediaPipe's
   * categories [{score, categoryName}]: put in BS_NAMES order by name), mat: 16 numbers or null. lm null = no face.
   */
  function packFace(lm, bs, mat, w, h, at, seq) {
    const found = !!lm;
    const buf = new ArrayBuffer(found ? FULL : HEAD), dv = new DataView(buf);
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, seq >>> 0, true); dv.setFloat64(8, at, true);
    dv.setUint16(16, Math.max(0, Math.min(65535, w | 0)), true); dv.setUint16(18, Math.max(0, Math.min(65535, h | 0)), true);
    dv.setUint8(20, (found ? 1 : 0) | (found && mat ? 2 : 0));
    if (!found) return buf;
    const f = new Float32Array(buf, HEAD);
    if (typeof lm[0] === 'number') f.set(lm.length > NL * 3 ? lm.subarray ? lm.subarray(0, NL * 3) : lm.slice(0, NL * 3) : lm);
    else { const n = Math.min(NL, lm.length); for (let i = 0; i < n; i++) { const p = lm[i]; f[i * 3] = p.x; f[i * 3 + 1] = p.y; f[i * 3 + 2] = p.z; } }
    const o = NL * 3;
    if (bs && bs.length) {
      if (typeof bs[0] === 'number') { for (let i = 0; i < NB && i < bs.length; i++) f[o + i] = bs[i]; }
      else {
        let inOrder = bs.length === NB;
        for (let i = 0; inOrder && i < NB; i++) if (bs[i].categoryName !== BS_NAMES[i]) inOrder = false;
        if (inOrder) for (let i = 0; i < NB; i++) f[o + i] = bs[i].score;
        else for (const c of bs) { const k = BS_NAMES.indexOf(c.categoryName); if (k >= 0) f[o + k] = c.score; }
      }
    }
    if (mat) for (let i = 0; i < 16; i++) f[o + NB + i] = mat[i];
    return buf;
  }
  /** -> { seq, at, w, h, lm: Float32Array(1434) | null, bs: Float32Array(52) | null, mat: Float32Array(16) | null }, or null when it is not one */
  function unpackFace(buf) {
    // (told by its tag, not by instanceof: a buffer made in the tracker's frame is another window's ArrayBuffer)
    const isBuf = (x) => Object.prototype.toString.call(x) === '[object ArrayBuffer]';
    if (!isBuf(buf)) { if (buf && isBuf(buf.buffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); else return null; }
    if (buf.byteLength < HEAD) return null;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    const flags = dv.getUint8(20), out = { seq: dv.getUint32(4, true), at: dv.getFloat64(8, true), w: dv.getUint16(16, true), h: dv.getUint16(18, true), lm: null, bs: null, mat: null };
    if (!(flags & 1)) return out;
    if (buf.byteLength < FULL) return null;
    out.lm = new Float32Array(buf, HEAD, NL * 3);
    out.bs = new Float32Array(buf, HEAD + NL * 12, NB);
    if (flags & 2) out.mat = new Float32Array(buf, HEAD + (NL * 3 + NB) * 4, 16);
    return out;
  }

  // ---------------------------------------------------------------- a viewer event (the contract with LIVE Link)
  const EVENT_TYPES = ['gift', 'like', 'comment', 'follow', 'share'];
  // no control characters, no line breaks, no direction marks; cut to the length the contract allows
  const text = (v, max) => (typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2066-\u2069\ufeff]/g, ' ').trim()).slice(0, max).join('') : '');
  const int = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
  /** The event checked and clipped (only the fields the contract names), or null when it is not one. */
  function cleanEvent(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || e.v !== 1 || !EVENT_TYPES.includes(e.type)) return null;
    const out = { type: e.type, name: text(e.name, 40), gift: null, coins: null, count: null, text: null };
    if (e.type === 'gift') {
      out.gift = text(e.gift, 40) || null; out.coins = int(e.coins, 0, 1000000); out.count = int(e.count, 1, 9999) || 1;
      if (!out.gift && out.coins === null) return null;                       // a gift with neither a name nor a price says nothing
    } else if (e.type === 'like') out.count = int(e.count, 1, 9999) || 1;
    else if (e.type === 'comment') out.text = text(e.text, 150);
    return out;
  }

  // ---------------------------------------------------------------- the gift list
  const EFFECTS = ['chip', 'barrage', 'grow', 'shatter'];
  const EFFECT_LABEL = { chip: 'Small', barrage: 'Mid', grow: 'Big', shatter: 'Biggest' };
  /** Rows as mask.setGiftMap takes them: named gifts first (as written), then the coin ranges rising, the catch-all last. */
  function cleanGiftRows(rows) {
    if (!Array.isArray(rows)) return null;
    const named = [], ranges = [];
    let rest = null;
    for (const r of rows.slice(0, 200)) {
      if (!r || typeof r !== 'object' || !EFFECTS.includes(r.effect)) continue;
      const gift = text(r.gift, 40);
      if (gift) { if (!named.some((x) => x.gift.toLowerCase() === gift.toLowerCase())) named.push({ gift, effect: r.effect }); }
      else if (typeof r.upTo === 'number' && Number.isFinite(r.upTo) && r.upTo >= 0) ranges.push({ upTo: Math.min(1000000, Math.round(r.upTo)), effect: r.effect });
      else if (!rest) rest = { effect: r.effect };
    }
    ranges.sort((a, b) => a.upTo - b.upTo);
    const out = [...named, ...ranges.filter((r, i) => !i || r.upTo !== ranges[i - 1].upTo), rest || { effect: 'shatter' }];
    return out;
  }
  /** which effect a gift gets from the rows (the same rule mask-fx.js applies): its name first, then its price */
  function effectFor(rows, gift, coins) {
    const g = String(gift || '').trim().toLowerCase();
    for (const r of rows) if (r.gift && String(r.gift).toLowerCase() === g) return r.effect;
    for (const r of rows) if (!r.gift && (r.upTo === undefined || (Number(coins) || 0) <= r.upTo)) return r.effect;
    return null;
  }
  // "Try the effects": the same events a real viewer causes
  const TRY_EVENTS = {
    small: { v: 1, type: 'gift', name: 'Test', gift: 'Test gift', coins: 1, count: 3 },
    mid: { v: 1, type: 'gift', name: 'Test', gift: 'Test gift', coins: 30, count: 1 },
    big: { v: 1, type: 'gift', name: 'Test', gift: 'Test gift', coins: 500, count: 1 },
    biggest: { v: 1, type: 'gift', name: 'Test', gift: 'Test gift', coins: 5000, count: 1 },
    likes: { v: 1, type: 'like', name: 'Test', count: 15 },
    comment: { v: 1, type: 'comment', name: 'Test', text: 'hello' },
    follower: { v: 1, type: 'follow', name: 'Test' },
    share: { v: 1, type: 'share', name: 'Test' },
    boom: { v: 1, type: 'comment', name: 'Test', text: 'boom' },
  };
  const TRY_LABEL = { small: 'Small gift', mid: 'Mid gift', big: 'Big gift', biggest: 'Biggest gift', likes: 'Likes', comment: 'Comment', follower: 'Follower', share: 'Share', boom: '"boom"' };

  // ---------------------------------------------------------------- a level only -> what mask.audio() takes
  /**
   * follower.push(level 0..1, tSeconds) -> { bass, mid, high, beat, kick, hit, level, bright }. The level is set against
   * its own slow floor and ceiling (a quiet and a loud source both fill the range); a kick = the level standing clear
   * of its short average, at most one every 160 ms.
   */
  function levelFollower() {
    let lo = 0, hi = 0.25, env = 0, avg = 0, beat = 0, lastT = null, kickAt = -9;
    return {
      push(v, t) {
        v = Math.max(0, Math.min(1, Number(v) || 0));
        const dt = lastT === null ? 1 / 30 : Math.max(0.001, Math.min(0.5, t - lastT));
        lastT = t;
        const k = (sec) => 1 - Math.exp(-dt / sec);
        lo += (v - lo) * (v < lo ? k(0.3) : k(12));
        hi += (v - hi) * (v > hi ? k(0.05) : k(20));
        const span = Math.max(0.08, hi - lo), n = Math.max(0, Math.min(1, (v - lo) / span));
        env += (n - env) * (n > env ? k(0.03) : k(0.22));
        let kick = 0;
        if (n - avg > 0.22 && n > 0.35 && t - kickAt > 0.16) { kick = Math.min(1, 0.45 + (n - avg)); kickAt = t; }
        avg += (n - avg) * k(0.35);
        beat = kick ? Math.max(beat, kick) : beat * Math.exp(-dt / 0.2);
        return { bass: env, mid: env, high: env * 0.6, beat, kick, hit: 0, level: env, bright: 0.8 };
      },
    };
  }
  /** OBS's meter (a multiplier, 0..1 and above) as a level 0..1: -50 dB and below = 0, -6 dB and above = 1 */
  const meterLevel = (mul) => { const db = 20 * Math.log10(Math.max(1e-6, Number(mul) || 0)); return Math.max(0, Math.min(1, (db + 50) / 44)); };

  return { BS_NAMES, MAGIC, FACE_BYTES: FULL, packFace, unpackFace, EVENT_TYPES, cleanEvent, EFFECTS, EFFECT_LABEL, cleanGiftRows, effectFor, TRY_EVENTS, TRY_LABEL, levelFollower, meterLevel };
});
