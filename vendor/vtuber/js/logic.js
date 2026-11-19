// Pure logic shared by avatar.html, control.html and the tests (no DOM, no Babylon). All clocks are milliseconds.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VTLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  /** Small deterministic random source (mulberry32). */
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------ characters
  /** Faces per character, the mouth cells, the tracker mood map and the panel's face keys (Q W E R T Y). */
  const CHARACTERS = {
    ryo: {
      label: 'Ryo',
      faces: ['neutral', 'happy', 'surprised', 'smug', 'bored', 'shout'],
      faceLabels: { neutral: 'Neutral', happy: 'Happy', surprised: 'Surprised', smug: 'Smug', bored: 'Bored', shout: 'Shout' },
      rest: 'neutral', talk: 'talk', loud: 'shout', blink: 'blink',
      mood: { neutral: 'neutral', happy: 'happy', surprised: 'surprised', smug: 'smug', bored: 'bored', annoyed: 'bored' },
      // faces whose own mouth is already wide open: the talking mouth does not replace it
      ownMouth: ['shout'],
      noBlink: ['shout'],
    },
    melanie: {
      label: 'Melanie',
      faces: ['neutral', 'smile', 'alarmed', 'skeptical', 'annoyed', 'blink'],
      faceLabels: { neutral: 'Deadpan', smile: 'Smile', alarmed: 'Alarmed', skeptical: 'Skeptical', annoyed: 'Annoyed', blink: 'Eyes shut' },
      rest: 'neutral', talk: 'talk', loud: 'alarmed', blink: 'blink',
      mood: { neutral: 'neutral', happy: 'smile', surprised: 'alarmed', annoyed: 'annoyed', smug: 'skeptical', bored: 'neutral' },
      ownMouth: [],
      noBlink: ['blink'],
    },
  };
  const FACE_KEYS = ['q', 'w', 'e', 'r', 't', 'y'];
  const BACKGROUNDS = ['transparent', 'green', 'black', 'preset:courtyard', 'preset:grove', 'preset:frostkeep'];
  const isCharacter = id => Object.prototype.hasOwnProperty.call(CHARACTERS, id);
  // every name the Mask's background may have (mask/mask-live.js stats().backgrounds is what the picker shows; a name
  // that is not in this list is never sent on)
  const MASK_BACKGROUNDS = ['black', 'summer', 'ice', 'forge', 'nebula', 'studio', 'street'];
  // every name the Mask's Visualizer style may have (the same list as mask/mask-fx.js VISUALIZERS; a test keeps them
  // equal). A name that is not in it is never kept and never sent on, exactly as with the backgrounds.
  const MASK_VISUALIZERS = ['orb', 'tunnel', 'yinyang', 'ridges', 'blackhole', 'helix'];
  // "Lift your hands into the camera ...": shown only when his hands are rarely in the picture. Judged over the last two
  // minutes of body checks (at least one minute of them, with his face there): a hand in under 3 % of the checks.
  const HANDS_HINT = { windowMs: 120000, minMs: 60000, minChecks: 300, rare: 0.03, faceShare: 0.5 };
  /** log: [[time ms, body checks, checks with a hand, face seen 0/1], ...] one row per pulse -> true = hands rarely seen */
  function handsRarelySeen(log, o = HANDS_HINT) {
    if (!Array.isArray(log) || log.length < 2) return false;
    if (log[log.length - 1][0] - log[0][0] < o.minMs) return false;
    let checks = 0, hand = 0, face = 0;
    for (const r of log) { checks += r[1]; hand += r[2]; face += r[3] ? 1 : 0; }
    if (checks < o.minChecks || face / log.length < o.faceShare) return false;
    return hand / checks < o.rare;
  }
  /** A face name this character can show as a resting face, else null. */
  function validFace(character, name) {
    const c = CHARACTERS[character];
    return c && typeof name === 'string' && c.faces.includes(name) ? name : null;
  }
  /** The resting face for a tracker mood (unknown or null mood: the character's default). */
  function moodFace(character, mood) {
    const c = CHARACTERS[character];
    if (!c) return null;
    return (typeof mood === 'string' && Object.prototype.hasOwnProperty.call(c.mood, mood)) ? c.mood[mood] : c.rest;
  }

  // ------------------------------------------------------------------ mouth from a level
  const MOUTH_DEFAULTS = Object.freeze({
    talkOn: 0.14, talkOff: 0.08, loudOn: 0.72, loudOff: 0.52,
    holdMs: 110,           // a state lasts at least this long (no flicker)
    attackMs: 12,          // level smoothing: fast up
    releaseMs: 110,        //                  slower down
    flapOpenMs: [150, 260], // steady speech: the mouth closes briefly after being open this long...
    flapShutMs: [70, 110],  // ...for this long, so a held vowel still reads as talking
    staleMs: 350,          // no level for this long = silence
  });

  /** level (0..1) -> 'closed' | 'talk' | 'loud', with hysteresis, a minimum hold, fast attack and slower release. */
  class MouthGate {
    constructor(options, seed) {
      this.o = Object.assign({}, MOUTH_DEFAULTS, options || {});
      this.rand = seededRandom(seed == null ? 7 : seed);
      this.env = 0;
      this.state = 'closed';
      this.since = -1e9;       // when the state began
      this.target = 0;
      this.targetAt = -1e9;
      this.flapUntil = -1;     // forced shut until
      this.openLimit = 0;
      this.last = null;
    }
    /** Feed the newest level (0..1) and when it was measured. */
    push(level, now) { this.target = clamp(Number(level) || 0, 0, 1); this.targetAt = now; }
    _set(state, now) {
      if (state === this.state) return;
      this.state = state; this.since = now;
      if (state !== 'closed') {
        const [a, b] = this.o.flapOpenMs;
        this.openLimit = a + (b - a) * this.rand();
      }
    }
    /** Advance to `now`; returns the state to draw. */
    update(now) {
      const o = this.o;
      const dt = this.last == null ? 16 : clamp(now - this.last, 0, 200);
      this.last = now;
      const target = now - this.targetAt > o.staleMs ? 0 : this.target;
      const tau = target > this.env ? o.attackMs : o.releaseMs;
      this.env += (target - this.env) * (1 - Math.exp(-dt / Math.max(1, tau)));
      const e = this.env, held = now - this.since >= o.holdMs;
      let want = this.state;
      if (this.state === 'closed') {
        if (now >= this.flapUntil) want = e >= o.loudOn ? 'loud' : e >= o.talkOn ? 'talk' : 'closed';
      } else if (this.state === 'talk') {
        if (e >= o.loudOn) want = 'loud';
        else if (e < o.talkOff) want = 'closed';
      } else if (e < o.talkOff) want = 'closed';
      else if (e < o.loudOff) want = 'talk';
      // steady speech: a brief shut so the mouth keeps moving
      if (want !== 'closed' && this.state !== 'closed' && now - this.since >= this.openLimit && want === this.state) {
        const [a, b] = o.flapShutMs;
        this.flapUntil = now + a + (b - a) * this.rand();
        this._set('closed', now);
        return this.state;
      }
      if (want !== this.state && held) this._set(want, now);
      return this.state;
    }
    get speaking() { return this.state !== 'closed' || this.last < this.flapUntil; }
  }

  // ------------------------------------------------------------------ blinks
  const BLINK = Object.freeze({ everyMs: [2000, 6000], lengthMs: 120 });
  /** Automatic blinks every 2-6 s (random), ~120 ms each. */
  class BlinkClock {
    constructor(seed) { this.rand = seededRandom(seed == null ? 11 : seed); this.next = -1; this.until = -1; }
    _schedule(now) { this.next = now + BLINK.everyMs[0] + (BLINK.everyMs[1] - BLINK.everyMs[0]) * this.rand(); }
    /** True while a blink shows. `allowed` false (a face that must not blink) postpones it. */
    update(now, allowed) {
      if (this.next < 0) this._schedule(now);
      if (allowed === false) { this.until = -1; return false; }
      if (this.until >= 0) {
        if (now < this.until) return true;
        this.until = -1; this._schedule(now);
      }
      if (now >= this.next) { this.until = now + BLINK.lengthMs; return true; }
      return false;
    }
  }
  const TRACKED_BLINK = Object.freeze({
    closeAt: 0.6, openAt: 0.5,    // hysteresis on the mean of both eyes (the tracker has already removed look-down and squint)
    capMs: 400,                   // a tracked closure is shown for at most this long...
    shutAt: 0.9,                  // ...unless BOTH eyes still read fully shut then (eyes really held closed)
    rearmBelow: 0.3,              // after a capped closure the eyes must open in the data before they can close again
  });
  /**
   * Tracked eyelids -> blink. Closes above `closeAt`, reopens below `openAt`.
   * A real blink lasts 0.1-0.4 s, so a closure that runs past `capMs` is treated as a lowered lid (looking down, a
   * squint, a tracking plateau) and the eyes reopen, EXCEPT while both eyes still read above `shutAt` (the tracker
   * only reports that when the lid gap is gone): then the eyes stay shut, because he really closed them. After a forced reopen nothing closes again
   * until the reading has dropped below `rearmBelow`, so a long plateau cannot blink over and over.
   */
  class TrackedBlink {
    constructor(options) { this.o = Object.assign({}, TRACKED_BLINK, options || {}); this.closed = false; this.since = 0; this.locked = false; this.t = 0; }
    update(blinkL, blinkR, now) {
      const o = this.o;
      const l = clamp(Number(blinkL) || 0, 0, 1), r = clamp(Number(blinkR) || 0, 0, 1), v = (l + r) / 2;
      this.t = Number.isFinite(now) ? now : this.t + 16;
      if (this.locked && v < o.rearmBelow) this.locked = false;
      if (this.closed) {
        if (v < o.openAt) this.closed = false;
        else if (this.t - this.since >= o.capMs && Math.min(l, r) < o.shutAt) { this.closed = false; this.locked = true; }
      } else if (!this.locked && v > o.closeAt) { this.closed = true; this.since = this.t; }
      return this.closed;
    }
  }

  // ------------------------------------------------------------------ head
  const HEAD_LIMIT = Object.freeze({ yaw: 25, pitch: 15, roll: 15 });
  /** Tracker angles (image space, degrees, ALREADY mirrored by the tracker when mirror is on) -> clamped avatar angles. */
  function headTarget(face) {
    const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
      yaw: clamp(n(face && face.yaw), -HEAD_LIMIT.yaw, HEAD_LIMIT.yaw),
      pitch: clamp(n(face && face.pitch), -HEAD_LIMIT.pitch, HEAD_LIMIT.pitch),
      roll: clamp(n(face && face.roll), -HEAD_LIMIT.roll, HEAD_LIMIT.roll),
    };
  }
  /** Critically damped follower (one per angle): smooth, no overshoot, frame-rate independent. */
  class Damped {
    constructor(halfLifeMs) { this.h = halfLifeMs; this.x = 0; this.v = 0; }
    update(target, dtMs) {
      const dt = clamp(dtMs, 0, 100) / 1000;
      const w = 2 * Math.LN2 / Math.max(0.001, this.h / 1000);   // stiffness from the half life
      const j = this.x - target, k = (this.v + j * w) * dt, e = Math.exp(-w * dt);
      this.x = target + (j + k) * e;
      this.v = (this.v - k * w) * e;
      return this.x;
    }
  }

  // ------------------------------------------------------------------ which face to draw
  /**
   * The face to draw this frame.
   *   manual   : a face name while the owner's pick is active, else null
   *   mood     : the tracker's mood (or null)
   *   mouth    : 'closed' | 'talk' | 'loud'
   * Returns { base, mouth } : `base` = the whole-face picture (eyes, brows, resting mouth),
   * `mouth` = a face whose MOUTH AREA ONLY is laid over it while speaking (null = keep the base's own mouth).
   */
  function pickFace(character, manual, mood, mouth) {
    const c = CHARACTERS[character];
    const base = validFace(character, manual) || moodFace(character, mood);
    let over = null;
    if (mouth === 'talk') over = c.talk;
    else if (mouth === 'loud') over = c.loud;
    if (over === base || c.ownMouth.includes(base)) over = null;
    return { base, mouth: over };
  }

  // ------------------------------------------------------------------ messages
  /** A well-formed copy of an `avatar` message (unknown values fall back to safe ones), or null. */
  function readAvatarMessage(m) {
    if (!m || m.t !== 'avatar') return null;
    const character = isCharacter(m.character) ? m.character : 'ryo';
    const bg = typeof m.bg === 'string' && (BACKGROUNDS.includes(m.bg) || /^preset:[a-z0-9-]{1,40}$/.test(m.bg)) ? m.bg : 'transparent';
    const face = m.face === 'auto' ? 'auto' : (validFace(character, m.face) || 'auto');
    const num = (v, d, a, b) => (Number.isFinite(Number(v)) ? clamp(Number(v), a, b) : d);
    return {
      t: 'avatar', on: m.on === true, character, bg, face,
      faceHoldMs: num(m.faceHoldMs, 4000, 0, 600000), mirror: m.mirror === true,
      zoom: num(m.zoom, 1, 0.5, 2), offsetY: num(m.offsetY, 0, -0.5, 0.5),
      // round 5: eyes on camera (the Mask and the heroes) is ON unless the message says `eyes: false`
      ...(m.eyes === false ? { eyes: false } : null),
      ...(m.sounds === false ? { sounds: false } : null),   // gift sounds off for the heroes (the Mask has maskSounds)
      // V4: the Mask is a third choice. `character` stays one of the two heroes (older pages only know those); `mask`
      // says the mask is shown instead, with its own mode, background and gift sounds. gifts / rest: the numbers the
      // server gives the gift list and the saved resting face (a change = the avatar page reads them again).
      // (The fields are only there when the Mask is chosen: a message without it reads exactly as before.)
      ...(m.mask === true ? {
        mask: true, maskMode: m.maskMode === 'visualizer' ? 'visualizer' : 'face',
        maskBg: MASK_BACKGROUNDS.includes(m.maskBg) ? m.maskBg : 'black', maskSounds: m.maskSounds !== false,
        maskGifts: num(m.maskGifts, 0, 0, 1e15), maskRest: num(m.maskRest, 0, 0, 1e15),
        maskViz: MASK_VISUALIZERS.includes(m.maskViz) ? m.maskViz : '',   // the Visualizer's style ('' = the mask's own first one)
      } : null),
    };
  }

  // ------------------------------------------------------------------ the camera picture: black (phone off) or frozen (phone asleep)
  /**
   * The brightness of an RGBA picture, every `step`-th pixel across and down. Near-white / grey and yellow pixels are
   * marked 255+ (not used): the tracker draws its face dots, arm lines and hand lines in those colours on its picture.
   */
  function lumaOf(rgba, w, h, step = 2, mark = true) {
    const cols = Math.ceil(w / step), rows = Math.ceil(h / step), out = new Uint16Array(cols * rows);
    let k = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const drawn = mark && ((r > 200 && g > 200 && b > 200) || (r > 200 && g > 160 && b < 150));
        out[k++] = drawn ? 999 : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    return out;
  }
  /** mean brightness, the share of lit pixels, and the share of pixels that changed since `prev` (1 = no prev) */
  function pictureLook(luma, prev) {
    let sum = 0, used = 0, lit = 0, both = 0, changed = 0;
    for (let i = 0; i < luma.length; i++) {
      const v = luma[i];
      if (v > 255) continue;
      used++; sum += v; if (v > 40) lit++;
      if (prev && prev[i] <= 255) { both++; if (Math.abs(v - prev[i]) > 4) changed++; }
    }
    return { mean: used ? sum / used : 0, lit: used ? lit / used : 0, changed: prev && both > 100 ? changed / both : 1, used };
  }
  /** fed one look about every 0.7 s: 'dark' after 2 s of a black picture, 'frozen' after 4 s of one that does not change */
  class PictureWatch {
    constructor(o = {}) { this.darkMs = o.darkMs || 2000; this.frozenMs = o.frozenMs || 4000; this.still = o.still || 0.0005; this.reset(); }
    reset() { this.darkSince = 0; this.stillSince = 0; this.state = 'ok'; }
    feed(look, now) {
      const dark = look.used !== 0 && look.mean < 16 && look.lit < 0.005;
      const still = !dark && look.changed < this.still;
      this.darkSince = dark ? this.darkSince || now : 0;
      this.stillSince = still ? this.stillSince || now : 0;
      this.state = this.darkSince && now - this.darkSince >= this.darkMs ? 'dark' : this.stillSince && now - this.stillSince >= this.frozenMs ? 'frozen' : 'ok';
      return this.state;
    }
  }

  return {
    clamp, seededRandom, CHARACTERS, FACE_KEYS, BACKGROUNDS, MASK_BACKGROUNDS, MASK_VISUALIZERS, HANDS_HINT, handsRarelySeen, isCharacter, validFace, moodFace,
    MOUTH_DEFAULTS, MouthGate, BLINK, BlinkClock, TRACKED_BLINK, TrackedBlink, HEAD_LIMIT, headTarget, Damped, pickFace, readAvatarMessage,
    lumaOf, pictureLook, PictureWatch,
  };
});
