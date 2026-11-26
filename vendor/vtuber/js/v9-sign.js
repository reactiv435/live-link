// V9 SHOW SIGN + LIVE OVERLAY: the pure part (no page, no graphics; the avatar page, the VTuber window, the server and the
// tests all read it).
//   THE SHOW SIGN: each host's own looping video or picture, its green keyed out, at the top of the picture.
//   THE LIVE OVERLAY:  a web page (his ReactivVibe overlay) shown in a frame over the picture.
// What is in here:
//   cleanSign / cleanOverlay           the two settings as they travel in the `avatar` message (anything else is dropped)
//   cleanSignSettings / cleanOverlaySettings   the same, as the VTuber window keeps them between starts (off by default)
//   overlayUrl                         the only addresses the live overlay may show: https, never this PC, no name:password@
//   signRect / overlayRect             where each sits in the 1080 x 1920 picture, always inside TikTok's safe zone
//   createTopSlot / triggers        THE TOP SLOT: the sign steps aside while something else needs the top, and comes back
//   safeSignName / isSignName / sniffSign   the server's rules for an uploaded file (name, type by its first bytes)
// SAFE ZONE (9:16): everything stays inside x 60 - 930, y 200 - 1436 (TikTok's own interface covers the rest).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTSign = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : d);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const FRAME = Object.freeze({ w: 1080, h: 1920 });
  const SAFE = Object.freeze({ x0: 60, x1: 930, y0: 200, y1: 1436 });
  const SAFE_W = SAFE.x1 - SAFE.x0, SAFE_H = SAFE.y1 - SAFE.y0;

  // ------------------------------------------------------------------ the uploaded file
  const SIGN_MAX_BYTES = 60 * 1024 * 1024, SIGN_KEEP = 6;
  const SIGN_TYPES = Object.freeze({ mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' });
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}\.(mp4|webm|png|gif|jpg|jpeg)$/;
  /** is this exactly a name this server gave a sign? (the only names it serves or deletes; nothing is "repaired" here) */
  const isSignName = (n) => typeof n === 'string' && NAME_RE.test(n) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\./.test(n);
  /** 'mp4' | 'webm' | 'png' | 'gif' | 'jpg' for a name's ending ('' = not a sign) */
  const signKind = (n) => { const m = /\.([a-z0-9]+)$/.exec(String(n || '').toLowerCase()); const e = m ? m[1] : ''; return e === 'jpeg' ? 'jpg' : Object.prototype.hasOwnProperty.call(SIGN_TYPES, e) ? e : ''; };
  const signIsVideo = (n) => { const k = signKind(n); return k === 'mp4' || k === 'webm'; };
  /**
   * The name a file is kept under, from the name the host's file had: its last path part only, lower case, letters /
   * digits / dashes, at most 40, with one of the known endings. '' = not a file this takes (no ending we know, or a
   * name that is not text). No "..", no slash, no drive, no dot but the one before the ending can come out of this.
   */
  function safeSignName(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 300 || raw.includes('\0')) return '';
    const base = raw.split(/[\\/]/).pop().toLowerCase();
    const m = /^(.*)\.([a-z0-9]{1,5})$/.exec(base);
    if (!m || !Object.prototype.hasOwnProperty.call(SIGN_TYPES, m[2])) return '';
    let stem = m[1].normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'sign';
    if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(stem)) stem = 'sign-' + stem;      // (names Windows keeps for its devices, whatever the ending)
    const name = stem + '.' + m[2];
    return isSignName(name) ? name : '';
  }
  /** what a file's first bytes say it is: 'mp4' | 'webm' | 'png' | 'gif' | 'jpg' | '' (the name alone is not believed) */
  function sniffSign(b) {
    if (!b || b.length < 12) return '';
    const s = (a, n) => { let t = ''; for (let i = a; i < a + n; i++) t += String.fromCharCode(b[i]); return t; };
    if (b[0] === 0x89 && s(1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (s(0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    if (s(4, 4) === 'ftyp') return 'mp4';
    return '';
  }
  // A sign is at most this many pixels on either side (a 4096 x 4096 picture is 64 MB once decoded; 1920 x 1080 is plenty).
  // A file that claims more (or a tiny file that claims a huge picture: a "decompression bomb") is refused at the upload.
  const SIGN_MAX_PX = 4096;
  /**
   * The picture size a sign file says it has: { w, h } (the largest of its frames / video tracks), or null when it cannot
   * be read. b = the whole file (Buffer / Uint8Array). Reads the headers only: PNG IHDR, GIF screen + every frame, JPEG
   * SOF, WebM PixelWidth / PixelHeight, MP4 tkhd.
   */
  function pixelsOf(b, kind) {
    if (!b || !b.length) return null;
    const n = b.length, u16 = (i) => (b[i] << 8) | b[i + 1], u16le = (i) => b[i] | (b[i + 1] << 8), u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const t4 = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    const ok = (w, h) => (w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? { w: Math.round(w), h: Math.round(h) } : null);
    try {
      if (kind === 'png') return n >= 24 && t4(12) === 'IHDR' ? ok(u32(16), u32(20)) : null;
      if (kind === 'gif') {
        if (n < 13) return null;
        let w = u16le(6), h = u16le(8), i = 13;
        if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
        for (let guard = 0; i < n && guard < 100000; guard++) {
          const c = b[i];
          if (c === 0x3b) break;
          if (c === 0x21) { i += 2; while (i < n && b[i]) i += b[i] + 1; i++; continue; }
          if (c !== 0x2c || i + 10 > n) return null;
          w = Math.max(w, u16le(i + 1) + u16le(i + 5)); h = Math.max(h, u16le(i + 3) + u16le(i + 7));      // a frame may reach past the screen
          const f = b[i + 9]; i += 10; if (f & 0x80) i += 3 * (1 << ((f & 7) + 1));
          i++; while (i < n && b[i]) i += b[i] + 1; i++;
        }
        return ok(w, h);
      }
      if (kind === 'jpg') {
        let i = 2;
        while (i + 9 < n) {
          if (b[i] !== 0xff) return null;
          const m = b[i + 1];
          if (m === 0xff) { i++; continue; }
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16(i + 7), u16(i + 5));
          if (m === 0xda || m === 0xd9) return null;                                       // the picture data began: no size
          i += 2 + u16(i + 2);
        }
        return null;
      }
      if (kind === 'webm') {
        // EBML: an id (its length marker kept), a size (marker dropped; all ones = unknown), the data
        const vint = (i, keep) => { if (i >= n) return null; const f = b[i]; let l = 1; while (l <= 8 && !(f & (0x80 >> (l - 1)))) l++; if (l > 8 || i + l > n) return null; let v = keep ? f : f & (0xff >> l), all = (f & (0xff >> l)) === (0xff >> l); for (let k = 1; k < l; k++) { v = v * 256 + b[i + k]; if (b[i + k] !== 0xff) all = false; } return { v, l, unknown: !keep && all }; };
        const INTO = { 0x18538067: 1, 0x1654ae6b: 1, 0xae: 1, 0xe0: 1 };      // Segment, Tracks, TrackEntry, Video
        let w = 0, h = 0;
        const walk = (a, z, depth) => {
          let i = a;
          while (i < z) {
            const id = vint(i, true); if (!id) return; const sz = vint(i + id.l, false); if (!sz) return;
            const d = i + id.l + sz.l, e = sz.unknown ? z : Math.min(z, d + sz.v);
            if (id.v === 0x1f43b675) return;                                                // a Cluster: the pictures begin, the tracks were before
            if (INTO[id.v] && depth < 5) walk(d, e, depth + 1);
            else if (id.v === 0xb0 || id.v === 0xba) { let v = 0; for (let k = d; k < e && k < d + 8; k++) v = v * 256 + b[k]; if (id.v === 0xb0) w = Math.max(w, v); else h = Math.max(h, v); }
            else if (sz.unknown) return;
            i = e;
          }
        };
        walk(0, n, 0);
        return ok(w, h);
      }
      if (kind === 'mp4') {
        let w = 0, h = 0;
        const walk = (a, z, depth) => {
          let i = a;
          while (i + 8 <= z) {
            let size = u32(i), head = 8; const type = t4(i + 4);
            if (size === 1) { if (i + 16 > z) return; size = u32(i + 8) * 4294967296 + u32(i + 12); head = 16; } else if (size === 0) size = z - i;
            if (size < head) return;
            const e = Math.min(z, i + size);
            if ((type === 'moov' || type === 'trak') && depth < 3) walk(i + head, e, depth + 1);
            else if (type === 'tkhd' && e - 8 >= i + head) { w = Math.max(w, u32(e - 8) / 65536); h = Math.max(h, u32(e - 4) / 65536); }
            i = e;
          }
        };
        walk(0, n, 0);
        return ok(w, h);
      }
    } catch (e) { return null; }
    return null;
  }
  /** plain words when a sign is bigger than `max` px on a side (the server's cap, or this graphics card's), else '' */
  function pixelProblem(w, h, max) {
    const m = Math.min(SIGN_MAX_PX, Number(max) > 0 ? Number(max) : SIGN_MAX_PX);
    if (!(w > m || h > m)) return '';
    return 'This sign is too big: ' + w + ' x ' + h + ' pixels (' + (m < SIGN_MAX_PX ? 'the graphics card of this PC takes' : 'a sign may be') + ' at most ' + m + ' on a side). Export it at 1920 x 1080 or smaller and upload it again.';
  }

  // ------------------------------------------------------------------ the sign's settings
  const cleanHex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '');
  // key: the colour that is removed (pure green). strength: how far from that colour still counts as green (OBS calls it
  // Similarity). soft: how wide the soft edge is (Smoothness). spill: how much of the green tint is taken off what stays.
  // x: -1 (left) .. 1 (right), 0 = centred. y: 0 (the top of the safe area) .. 1 (its bottom). size: 0.2 .. 1 of the safe
  // width. trim: the empty green round the sign is cut off (crop = what was found: [x0, y0, x1, y1] of the file, 0 .. 1).
  // The standard strength (0.60: everything at least 40 % of the key's colour goes) was 0.40 until the proof: a soft
  // glow over green from a real h.264 export (review/v9-sign) left a khaki rim round the sign at 0.40; at 0.60 it goes,
  // and white, chrome, gold, yellow, crimson, teal and a light green tint on white all stay solid (tests/v9-sign.test.js).
  const SIGN_DEFAULTS = Object.freeze({ on: false, file: '', key: '#00ff00', strength: 0.60, soft: 0.08, spill: 0.90, x: 0, y: 0, size: 0.86, trim: true, crop: null });
  function cleanCrop(c) {
    if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    const x0 = clamp(c[0], 0, 1), y0 = clamp(c[1], 0, 1), x1 = clamp(c[2], 0, 1), y1 = clamp(c[3], 0, 1);
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
    if (x0 <= 0.001 && y0 <= 0.001 && x1 >= 0.999 && y1 >= 0.999) return null;
    return [r3(x0), r3(y0), r3(x1), r3(y1)];
  }
  /** what the VTuber window keeps (whatever was saved, made valid; nothing saved = off) */
  function cleanSignSettings(s) {
    const q = s && typeof s === 'object' && !Array.isArray(s) ? s : {}, D = SIGN_DEFAULTS;
    return {
      on: q.on === true, file: isSignName(q.file) ? q.file : '', key: cleanHex(q.key) || D.key,
      strength: r3(num(q.strength, D.strength, 0.05, 0.9)), soft: r3(num(q.soft, D.soft, 0.005, 0.5)), spill: r3(num(q.spill, D.spill, 0, 1)),
      x: r3(num(q.x, D.x, -1, 1)), y: r3(num(q.y, D.y, 0, 1)), size: r3(num(q.size, D.size, 0.2, 1)),
      trim: q.trim !== false, crop: cleanCrop(q.crop),
    };
  }
  /** the `sign` field of an `avatar` message -> what the avatar page draws, or null (no file = nothing to draw) */
  function cleanSign(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || !isSignName(m.file)) return null;
    const s = cleanSignSettings({ ...m, on: true }), out = { file: s.file, key: s.key, strength: s.strength, soft: s.soft, spill: s.spill, x: s.x, y: s.y, size: s.size, show: m.show !== false };
    if (s.trim && s.crop) out.crop = s.crop;
    return out;
  }
  /** settings -> the field for the message (null = not sent: a message without it reads exactly as before) */
  function signField(s, shown) {
    const c = cleanSignSettings(s);
    if (!c.on || !c.file) return null;
    return cleanSign({ ...c, show: shown !== false });
  }
  const SIGN_MAX_H = 520;      // the tallest a sign may be at full size (picture px): it never reaches down over his face by default
  /**
   * Where the sign sits in the 1080 x 1920 picture: { x, y, w, h } (px). aspect = width / height of what is drawn (the
   * file, or its trimmed part). Always whole inside the safe zone, whatever the numbers.
   */
  function signRect(s, aspect) {
    const a = typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0 ? clamp(aspect, 0.05, 40) : 16 / 9;
    const size = num(s && s.size, SIGN_DEFAULTS.size, 0.2, 1);
    let w = Math.min(SAFE_W * size, SIGN_MAX_H * size * a), h = w / a;
    if (h > SAFE_H) { h = SAFE_H; w = h * a; }
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    const x = SAFE.x0 + (SAFE_W - w) * (0.5 + num(s && s.x, 0, -1, 1) / 2), top = SAFE.y0 + 4, y = top + Math.max(0, SAFE.y1 - top - h) * num(s && s.y, 0, 0, 1);
    return { x: Math.round(x), y: Math.round(Math.min(y, SAFE.y1 - h)), w, h };
  }

  // ------------------------------------------------------------------ the live overlay
  /**
   * The address the live overlay may show, tidied, or '' (refused): https only; a real host name (never this PC: localhost,
   * 127.x, ::1, 0.0.0.0, a bare name without a dot); no name:password@; at most 600 characters. `own` = this page's own
   * host (location.host): refused too, whatever it is.
   */
  function overlayUrl(raw, own) {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    if (!text || text.length > 600 || /[\u0000- \u007f"'<>\\`]/.test(text)) return '';
    let u = null;
    try { u = new URL(text); } catch (e) { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || !host.includes('.') || host.startsWith('[') || host === 'localhost' || host.endsWith('.localhost') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return '';
    if (typeof own === 'string' && own && (u.host.toLowerCase() === own.toLowerCase() || host === own.toLowerCase().replace(/:\d+$/, ''))) return '';
    return u.href.length <= 600 ? u.href : '';
  }
  // x: -1 .. 1 (0 = centred). y: 0 (top of the safe area) .. 1 (bottom). w: 0.3 .. 1 of the safe width. h: its height in
  // picture px. zoom: how big the page is drawn inside its box (1 = as the site lays it out; under 1 = a page made for a
  // wide screen, drawn smaller so it fits).
  // The standard box: the whole safe width at the bottom of the safe area, 16:9, so the page gets a 1280 x 720 window
  // (870 / 0.68 x 488 / 0.68): an overlay made for a 1280 x 720 or 1920 x 1080 stream then fills the width (his
  // reactivvibeai.com/live/now fits its own 16:9 stage into the window and puts its bar on the stage's bottom edge:
  // a full-width bar at y ~1300 - 1416, under the face, far from the sign). Seen in review/v9-sign/overlay-*.jpg.
  const OVERLAY_DEFAULTS = Object.freeze({ on: false, url: '', x: 0, y: 1, w: 1, h: 488, zoom: 0.68 });
  function cleanOverlaySettings(s) {
    const q = s && typeof s === 'object' && !Array.isArray(s) ? s : {}, D = OVERLAY_DEFAULTS;
    return {
      on: q.on === true, url: overlayUrl(q.url), x: r3(num(q.x, D.x, -1, 1)), y: r3(num(q.y, D.y, 0, 1)),
      w: r3(num(q.w, D.w, 0.3, 1)), h: Math.round(num(q.h, D.h, 80, SAFE_H)), zoom: r3(num(q.zoom, D.zoom, 0.25, 1.5)),
    };
  }
  /** the `overlay` field of an `avatar` message -> what the avatar page shows, or null (no good address = nothing) */
  function cleanOverlay(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const s = cleanOverlaySettings({ ...m, on: true });
    if (!s.url) return null;
    return { url: s.url, x: s.x, y: s.y, w: s.w, h: s.h, zoom: s.zoom, show: m.show !== false };
  }
  function overlayField(s, shown) {
    const c = cleanOverlaySettings(s);
    if (!c.on || !c.url) return null;
    return cleanOverlay({ ...c, show: shown !== false });
  }
  /** where the live overlay sits: { x, y, w, h } in picture px, plus the size the page itself is laid out at (pw x ph) */
  function overlayRect(s) {
    const c = cleanOverlaySettings(s), w = Math.round(SAFE_W * c.w), h = Math.min(c.h, SAFE_H);
    const x = SAFE.x0 + (SAFE_W - w) * (0.5 + c.x / 2), y = SAFE.y0 + (SAFE_H - h) * c.y;
    return { x: Math.round(x), y: Math.round(y), w, h, zoom: c.zoom, pw: Math.round(w / c.zoom), ph: Math.round(h / c.zoom) };
  }

  // ------------------------------------------------------------------ THE TOP SLOT
  const TOP = Object.freeze({ out: 0.4, back: 1.5, in: 0.45 });
  const TRIGGERS = Object.freeze(['vote', 'boss', 'eat', 'rank', 'countdown']);
  const ease = (v) => v * v * (3 - 2 * v);
  /**
   * What needs the top of the picture right now, from what the Mask's 2D layer is about to draw (mask.hud()) and the
   * show opening's state (VTShowPage.status()): { vote, boss, eat, rank, countdown } (each true / false).
   *   vote: a chat vote's question banner (it sits at y 204).   boss: a boss fight (its health bars; any place of them).
   *   eat: album eating from the first bite to the verdict word, and the score.   rank: the rank banner / "+1 MYTHIC".
   *   countdown: the countdown card (its top band holds the time) and the Mask asleep under it.
   */
  function triggers(V, show) {
    const v = V && typeof V === 'object' ? V : null, h = v && v.hype;
    return {
      vote: !!(v && v.vote),
      boss: !!(v && v.boss),
      eat: !!(v && ((v.cover && v.cover.a > 0.01) || v.eating || v.chewing || v.verdict || v.score)),
      rank: !!(h && (h.upAge < 2.8 || h.plusAge < 1.6)),
      countdown: !!(show && typeof show === 'object' && (show.state === 'card' || (show.c2 && show.c2.hold))),
    };
  }
  const anyOf = (tr, names) => { if (!tr) return ''; for (const n of names || TRIGGERS) if (tr[n]) return n; return ''; };
  /**
   * One fader. step(t, { want, busy }) -> { k, state, why }:
   *   want: he wants it on screen (the switch is on and he has not hidden it). His hide ALWAYS wins.
   *   busy: '' or the name of what needs the place right now.
   *   k: 0 (gone) .. 1 (fully there), eased; it leaves in `out` seconds, never in one frame, and comes back in `in`
   *      seconds, `back` seconds after the last thing that needed the place has ended.
   *   state: 'shown' | 'hidden' (by him) | 'aside' (something needs the place) | 'returning' (it ended; waiting, easing in)
   * Time may stand still, jump or go back: k stays 0 .. 1 and finite.
   */
  function createTopSlot(o) {
    const P = { ...TOP, ...(o || {}) };
    let v = 0, last = null, busyAt = -Infinity, why = '';
    function step(t, { want = false, busy = '' } = {}) {
      const now = typeof t === 'number' && Number.isFinite(t) ? t : (last === null ? 0 : last);
      let dt = last === null ? 0 : now - last;
      if (!(dt > 0)) dt = 0;
      if (now < busyAt) busyAt = now;                          // the clock went back: the wait starts again from here
      last = now;
      if (busy) { busyAt = now; why = String(busy); }
      const waiting = !busy && now - busyAt < P.back;
      const target = want && !busy && !waiting ? 1 : 0;
      if (target > v) v = Math.min(1, v + dt / P.in); else if (target < v) v = Math.max(0, v - dt / P.out);
      const state = !want ? 'hidden' : busy ? 'aside' : target && v >= 1 ? 'shown' : 'returning';
      return { k: ease(v), state, why: busy || (state === 'returning' && waiting ? why : '') };
    }
    return { step, get k() { return ease(v); }, reset() { v = 0; last = null; busyAt = -Infinity; why = ''; } };
  }
  /**
   * clearTriggers (camera mode on v9-int freezes the Mask's 2D layer, so a vote banner it was drawing keeps reading as
   * "up"): gate.clear(tr) lets go of what the Mask's 2D layer reports right now (vote, boss, eat, rank; never the
   * countdown, which is the show opening's own and stays live) until each of those ends; anything that starts afterwards
   * counts again. gate.clear(tr, false) stops letting go (the Mask's layer is live again). gate.pass(tr) -> what counts.
   */
  function createTriggerGate() {
    let held = null;
    return {
      clear(tr, on) { if (on === false) { held = null; return; } held = {}; for (const k of ['vote', 'boss', 'eat', 'rank']) if (tr && tr[k]) held[k] = true; },
      pass(tr) {
        if (!tr || !held) return tr;
        const out = { ...tr };
        for (const k of Object.keys(held)) { if (!tr[k]) delete held[k]; else out[k] = false; }
        return out;
      },
      get held() { return held ? Object.keys(held) : []; },
    };
  }
  // The viewer names (avatar.html #maskNames: top 7 %, up to two lines of 4.2vh x 1.25 + 0.6vh): while the sign is on
  // screen and in their lane, they move to just under it (never over the sign art); otherwise they stay where they were.
  const NAMES = Object.freeze({ top: Math.round(0.07 * FRAME.h), h: Math.round(2 * (0.042 * 1.25 + 0.006) * FRAME.h), gap: 12 });
  /** where the names' top goes (picture px) under a sign shown at `r`, or null = their own place */
  function namesTop(r) {
    if (!r || !(r.h > 0)) return null;
    if (r.y >= NAMES.top + NAMES.h || r.y + r.h <= NAMES.top) return null;
    return Math.round(Math.min(r.y + r.h + NAMES.gap, SAFE.y1 - NAMES.h));
  }
  /** the words the VTuber window shows for a state (one plain sentence) */
  const WHY = Object.freeze({ vote: 'a chat vote', boss: 'the boss fight', eat: 'album eating', rank: 'the rank banner', countdown: 'the countdown' });

  // ------------------------------------------------------------------ the keys
  // While the VTuber window is in front: one plain key each (the puppet show has G F M C E B V, the smart camera K).
  // From any window: LIVE Link's key system (its `control` messages). 1 - 8 are the puppet show's, 9 is the galaxy's
  // (ruling R28): the sign gets Ctrl + Alt + 0 (set by hand in LIVE Link, `always: true` like the other live keys); the
  // live overlay gets NO standard key there (its action is listed, he can give it one; the button and H always work).
  const KEYS = Object.freeze({ sign: Object.freeze({ code: 'KeyS', label: 'S', global: 'Ctrl + Alt + 0' }), overlay: Object.freeze({ code: 'KeyH', label: 'H', global: '' }) });
  /** the line under a SHOW / HIDE button: the window's key (unless a puppet key took it) and LIVE Link's */
  function keyLine(k, taken) {
    return (taken ? '' : k.label + ' here  /  ') + (k.global ? k.global + ' from any window (LIVE Link)' : 'a key for any window: set one in LIVE Link');
  }

  return {
    FRAME, SAFE, SIGN_MAX_BYTES, SIGN_KEEP, SIGN_TYPES, SIGN_MAX_H, isSignName, signKind, signIsVideo, safeSignName, sniffSign,
    SIGN_MAX_PX, pixelsOf, pixelProblem, createTriggerGate, NAMES, namesTop,
    SIGN_DEFAULTS, cleanCrop, cleanSignSettings, cleanSign, signField, signRect,
    OVERLAY_DEFAULTS, overlayUrl, cleanOverlaySettings, cleanOverlay, overlayField, overlayRect,
    TOP, TRIGGERS, triggers, anyOf, createTopSlot, WHY, KEYS, keyLine,
  };
});
