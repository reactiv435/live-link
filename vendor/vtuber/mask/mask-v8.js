// V8 MASK: the stage. Everything the puppet show draws on top of / into the particle face (contract V8-PUPPET.md):
//   * puppet moves: goo spew, fire head, melt, crack open, eat a comment
//   * the hype ranks as layers (embers ... MYTHIC: a galaxy inside, suns for eyes)
//   * the Mask eats the song (release A: at DONE / ADD TO AI RADIO / EAT IT the cover is chomped on the beat, chewed, and his
//     verdict is spat as a giant word of fire; at the start of a song the cover only gives the Mask its colour)
//   * the boss fight's look, drawn from js/v8/boss-engine.js's state (missiles, shield, lasers, damage, phases, endings)
//   * the angel / devil hand puppets, drawn from js/v8/hand-puppets.js's state
// No network, no timers, no clock of its own: every call takes the time (seconds, the clock mask-fx.js uses).
//
//   const stage = VTMaskV8.create({ gooColour: 'toxic' | 'mask', seed });
//   stage.puppet('goo' | 'fire' | 'melt' | 'crack' | 'eat', { hold, text }, t) -> true / false (cooling down)
//   stage.release('goo' | 'fire', t)
//   stage.setHype(rank 0..5 | name | -1 (off), progress01, t);  stage.hypePlus(t)   // the "+1 MYTHIC" flare
//   stage.cover({ colours: [[r,g,b] linear, ...], title }, t);  stage.songOff(t)      // a song on air: its colour only
//   stage.eat({ image | null (= a record), colours, title, grade, wait }, t)       // the Mask eats it: bites on the beat, then chews
//   stage.verdict('fire' | 'gem' | 'solid' | 'promising', t);  stage.gulp(t)       // the word is spat / a gulp, no word
//   stage.score(n 0..100, t)                                                        // (a LIVE Link 2.3.0: his score as a number)
//   stage.boss(s, t)      // the engine's state, every drawn frame (null = no fight)
//   stage.vote(v)         // the engine's poll state (the HUD draws it)
//   stage.hands(p, { aspect }, t)   // the engine's puppet state
//   const o = stage.pre(t, { core, palette, fx, head, place, mood, colour, audio })   // BEFORE looks.draw: -> { palette, fx, head, place, v8 }
//   looks.draw(look, { ..., palette: o.palette, fx: o.fx, head: o.head, place: o.place, v8: o.v8 })   // o.v8.render runs inside it
//   stage.post()          // AFTER looks.draw: the face mesh is put back as the tracker left it
//   stage.hud()           // what the 2D layer (mask-hud.js) draws this frame
//   stage.cuesBetween(a, b)   // sounds, the shape mask-sfx.js plays
// Rules built in: no full-frame flash faster than 3 a second (flash()); nothing here writes a call for gifts; the goo is
// a cartoon (flat two-tone body, an ink rim, a hard highlight, a glow), toxic green by default and never blood red.
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v)), lerp = (a, b, k) => a + (b - a) * k;
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const h1 = (x) => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  const ease = (cur, target, dt, up, down) => cur + (target - cur) * (1 - Math.exp(-dt * (target > cur ? up : down)));

  const RANKS = [{ id: 'warming', label: 'WARMING UP' }, { id: 'heating', label: 'HEATING UP' }, { id: 'onfire', label: 'ON FIRE' }, { id: 'wildfire', label: 'WILDFIRE' }, { id: 'legendary', label: 'LEGENDARY' }, { id: 'mythic', label: 'MYTHIC' }];
  const MOVES = { goo: { cool: 5, max: 12, min: 1.6 }, fire: { cool: 5, dur: 4.5, max: 12 }, melt: { cool: 9, dur: 3.6 }, crack: { cool: 9, dur: 4.4 }, eat: { cool: 4, dur: 3.3 } };
  const GOLD = [1.0, 0.50, 0.10], TOXIC = [0.30, 1.0, 0.10], TOXIC2 = [0.03, 0.34, 0.05], WHITE = [1.0, 0.96, 0.88];
  const FLASH_GAP = 0.36;                               // seconds between two full-frame flashes: under 3 a second

  // ---------------------------------------------------------------- RELEASE A: the Mask eats the song, chews, spits his verdict
  // The four verdicts of his site (ranking_board.host_grade) and how they are shown: upper case, nothing else is ever spelled.
  const WORDS = { fire: 'FIRE', gem: 'GEM', solid: 'SOLID', promising: 'PROMISING' };
  // Seconds. arrive: the cover reaches the mouth. biteGap / biteMax: a bite lands on a beat, at least / without a beat at
  // most this long after the one before. settle: the chew before a word or a gulp. form / hold / suck: the word flies out
  // and forms, is held, is sucked back in. gulp: the swallow. waitMax: the longest it chews when nobody calls verdict()
  // or gulp(). pend: how long a verdict / gulp that arrived before the picture did is kept for the eat that follows.
  const EAT = { arrive: 0.95, biteGap: 0.30, biteMax: 0.52, bites: 4, settle: 0.45, form: 0.55, hold: 3.0, suck: 0.5, gulp: 0.7, waitMax: 22, pend: 4 };
  // How each word burns. br: brightness. flame: fire standing on the letters. ember: sparks rising off them. works:
  // fireworks. jaw: how far the mouth stays open under it. slam: the camera's kick as it lands. boom: its sound.
  // FIX ROUND V-6: a word's colour is FIXED, not the cover's: ramp = its body from the letters' feet to their heads (4
  // stops), edge = its outline, glow = the light behind it. FIRE = white-hot into gold, orange and crimson; GEM =
  // chrome-white (its glints are crimson); SOLID = chrome steel (a dark horizon line, as chrome has); PROMISING = warm amber.
  const TIER = {
    FIRE: { br: 1.0, flame: 1.0, ember: 0.9, works: 5, jaw: 0.42, slam: 1.0, boom: 1.4, ramp: [[1.0, 0.05, 0.02], [1.0, 0.36, 0.03], [1.0, 0.70, 0.14], [1.0, 0.94, 0.72]], edge: [1.0, 0.95, 0.80], glow: [1.0, 0.30, 0.04] },
    GEM: { br: 0.95, flame: 0, ember: 0.5, works: 0, jaw: 0.16, slam: 0.7, boom: 1.0, glint: 1, ramp: [[0.70, 0.67, 0.65], [0.86, 0.84, 0.81], [0.95, 0.93, 0.90], [1.0, 0.98, 0.95]], edge: [1.0, 0.98, 0.95], glow: [0.85, 0.07, 0.10] },
    SOLID: { br: 1.0, flame: 0, ember: 0.4, works: 0, jaw: 0.16, slam: 1.15, boom: 1.3, bar: 1, ramp: [[0.80, 0.77, 0.74], [0.30, 0.285, 0.27], [0.62, 0.60, 0.58], [0.98, 0.96, 0.93]], edge: [1.0, 0.97, 0.93], glow: [0.50, 0.46, 0.43] },
    PROMISING: { br: 0.74, flame: 0, ember: 0.7, works: 0, jaw: 0.12, slam: 0.45, boom: 0.7, soft: 1, ramp: [[1.0, 0.36, 0.04], [1.0, 0.50, 0.08], [1.0, 0.64, 0.16], [1.0, 0.78, 0.32]], edge: [1.0, 0.86, 0.56], glow: [1.0, 0.52, 0.10] },
  };
  const FIRE_GOLD = [1.0, 0.52, 0.08], FIRE_DEEP = [0.95, 0.07, 0.03];      // the fire of a verdict (the letters' tongues, the head's crown under FIRE): fixed
  /**
   * Where the word sits in the frame: its centre and half size, x in half-widths and y in half-heights of the picture
   * (0 = the middle, +y = up), on the Mask's own canvas (Mirror: the page flips that canvas, so x is flipped here).
   * Always inside TikTok's safe zone (x 60 - 930, y 200 - 1436 of 1080 x 1920) and as big as that allows.
   */
  function wordBox(W, mirror, aspect = 0.5625) {
    // (fix round V-6: the word's INK is about 80 % of the safe zone's width (696 of 870 px = 0.644 of the half picture); a short
    // word stops at a height of 0.19 of the half picture)
    const yr = Math.max(0.02, W && W.yr ? W.yr : 0.2), xr = Math.max(0.3, W && W.xr ? W.xr : 0.92), hw = Math.min(0.644 / xr, 0.78, 0.19 / (yr * aspect));
    return { cx: mirror ? 0.083 : -0.083, cy: 0.53, hw, hh: hw * yr * aspect };
  }
  /** the soft full-frame flashes of this frame's events of an eat (the last bite, the spit): in the cover's warm colour, never white */
  function eatFlashes(e) {
    if (!e || !e.ev || !e.ev.length) return [];
    const c = e.col || GOLD, m = Math.max(c[0], c[1], c[2], 0.05), col = [c[0] / m, Math.min(c[1] / m, 0.85), Math.min(c[2] / m, 0.7)], out = [];
    for (const k of e.ev) { if (k === 'lastbite') out.push({ col, a: 0.20 }); else if (k === 'spit') out.push({ col, a: 0.22 }); }
    return out;
  }

  const PTS_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec4 aCol; uniform mat4 uViewProj; uniform float uPx; out vec3 vCol;
  void main() { vec4 c = uViewProj * vec4(aPos, 1.0); gl_Position = c; gl_PointSize = max(aCol.a * uPx / c.w, 1.5); vCol = aCol.rgb; }`;
  const PTS_FS = `#version 300 es
  precision highp float; in vec3 vCol; out vec4 o;
  void main() { float d = length(gl_PointCoord - 0.5) * 2.0; o = vec4(vCol * (exp(-d * d * 3.2) * (1.0 - smoothstep(0.75, 1.0, d))), 1.0); }`;
  // the field: goo and fire are drawn as soft blobs into a half-size target; where they add up past a level there is goo / flame
  const SPL_VS = `#version 300 es
  precision highp float; in vec3 aPos; in vec4 aW; uniform mat4 uViewProj; uniform float uPx; out vec3 vW;
  void main() { vec4 c = uViewProj * vec4(aPos, 1.0); gl_Position = c; gl_PointSize = max(aW.x * uPx / c.w, 1.0); vW = aW.yzw; }`;
  const SPL_FS = `#version 300 es
  precision highp float; in vec3 vW; out vec4 o;
  void main() { float d = length(gl_PointCoord - 0.5) * 2.0, g = exp(-d * d * 4.2) * (1.0 - smoothstep(0.82, 1.0, d)); o = vec4(vW.x * g, vW.y * g, vW.x * vW.z * g, 0.0); }`;
  const COMP_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uField; uniform vec2 uTexel; uniform float uTime, uAspect; uniform vec3 uGooA, uGooA2, uGooB, uGooB2, uFire, uFireDeep;
  float hash1(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash1(i), hash1(i + vec3(1, 0, 0)), f.x), mix(hash1(i + vec3(0, 1, 0)), hash1(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash1(i + vec3(0, 0, 1)), hash1(i + vec3(1, 0, 1)), f.x), mix(hash1(i + vec3(0, 1, 1)), hash1(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  void main() {
    vec4 f = texture(uField, vUv);
    // ---- GOO: a cartoon. A flat body in two tones, a darker ink rim just inside its edge, one hard highlight, a soft glow round it.
    float g = f.r, body = smoothstep(0.47, 0.53, g), tk = clamp(f.b / max(f.r, 1e-3), 0.0, 1.0);
    vec2 e = uTexel * 5.0;
    float gx = texture(uField, vUv + vec2(e.x, 0.0)).r - texture(uField, vUv - vec2(e.x, 0.0)).r, gy = texture(uField, vUv + vec2(0.0, e.y)).r - texture(uField, vUv - vec2(0.0, e.y)).r;
    vec3 n = normalize(vec3(-gx, -gy, 0.55));
    float dif = dot(n, normalize(vec3(-0.45, 0.60, 0.66)));
    vec3 cA = mix(uGooA, uGooB, tk), cD = mix(uGooA2, uGooB2, tk);
    vec3 gc = mix(cD, cA, max(smoothstep(0.30, 0.42, dif), smoothstep(0.80, 1.15, g))) * (0.85 + 0.25 * smoothstep(0.8, 2.2, g));      // (the dark tone only near the edge on the shade side: no camouflage patches inside)
    gc = mix(gc, cD * 0.55, body * (1.0 - smoothstep(0.55, 0.74, g)) * 0.85);                  // the ink rim
    gc += vec3(1.0, 1.0, 0.92) * smoothstep(0.935, 0.965, dif) * smoothstep(0.75, 1.1, g) * 1.5;   // the highlight
    vec3 col = gc * body * 1.25 + cA * (smoothstep(0.10, 0.47, g) * (1.0 - body) * 0.42);
    float alpha = body;
    // ---- FIRE: the field is heat; it is torn into tongues by noise that streams upward, and coloured by how hot it is
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    float n1 = vnoise(vec3(p * vec2(30.0, 9.0) + vec2(0.0, -uTime * 2.6), uTime * 0.7)), n2 = vnoise(vec3(p * vec2(66.0, 20.0) + vec2(3.0, -uTime * 4.6), uTime * 1.1 + 7.0));
    float nn = 0.65 * n1 + 0.35 * n2;
    float n0 = vnoise(vec3(p * vec2(9.0, 3.5) + vec2(0.0, -uTime * 1.5), uTime * 0.4));
    vec2 q = vUv + vec2((n0 - 0.5) * 0.060 + (n1 - 0.5) * 0.022, (n2 - 0.5) * 0.010);
    // a tongue is a string of rising blobs: read along its length too, so it is one tapering flame, not beads
    float ty = uTexel.y * 6.0;
    float h0 = 1.18 * (0.30 * texture(uField, q).g + 0.21 * (texture(uField, q + vec2(0.0, ty)).g + texture(uField, q - vec2(0.0, ty)).g) + 0.14 * (texture(uField, q + vec2(0.0, 2.0 * ty)).g + texture(uField, q - vec2(0.0, 2.0 * ty)).g));
    float h = h0 * (0.66 + 0.70 * nn) - 0.05 * (1.0 - nn);
    float outer = smoothstep(0.10, 0.15, h), mid = smoothstep(0.44, 0.58, h), core = smoothstep(1.00, 1.30, h);
    vec3 fc = mix(mix(uFireDeep * 1.05, uFire * 1.75, mid), vec3(1.0, 0.93, 0.70) * 2.3, core) * outer + uFire * (smoothstep(0.0, 0.5, h0) * 0.16);
    o = vec4(col + fc * (1.0 - 0.6 * alpha), alpha);
  }`;

  function create({ gooColour = 'toxic', seed = 7, sounds = true } = {}) {
    let rs = seed * 9301 + 49297;
    const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
    const st = {
      t: 0, lastT: null, moves: {}, hype: { rank: -1, k: 0, plusAt: -99 }, song: null, eat: null, pend: null, tint: null, score: null, boss: null, vote: null, hands: null, handOpt: { aspect: 0.5625 },
      L: { halo: 0, crown: 0, eyes: 0, mouthFire: 0, embers: 0, eyeHot: 0, bgFire: 0, gold: 0, cosmic: 0, crack: 0, demon: 0, jaw: 0, melt: 0, heat: 0, room: 0, gone: 0, shatter: 0 },
      hypeStyle: 'classic', hypeTone: 'classic', flashAt: -9, flash: [0, 0, 0, 0], cues: [], pops: [], kick: [0, 0, 0], kickV: 0, pool: 0, seen: new Map(), strikeSeen: new Map(), dmgN: 0, songK: 0, stageSeen: 'whole', endSeen: null, text: null, handSeen: { angel: false, devil: false },
    };
    for (const k in MOVES) st.moves[k] = { on: false, t0: -99, t1: -99, held: false, text: '' };
    const cue = (t, kind, size = 1, dur = 0, pitch = 0) => { if (sounds) { st.cues.push(pitch ? { t, kind, size, dur, pitch } : { t, kind, size, dur }); if (st.cues.length > 200) st.cues.splice(0, 100); } };
    /** a full-frame flash, never closer than FLASH_GAP to the one before (TikTok: under 3 a second) -> true when it was taken */
    function flash(t, col, a) { if (t - st.flashAt < FLASH_GAP) return false; st.flashAt = t; st.flash = [col[0], col[1], col[2], Math.min(0.6, a)]; return true; }
    const pop = (t, text, at, kind) => { st.pops.push({ t, text: String(text).slice(0, 28), at, kind }); if (st.pops.length > 12) st.pops.shift(); };

    function puppet(name, o = {}, t = st.t) {
      const M = MOVES[name], m = st.moves[name]; if (!M) return false;
      if (m.on || t < m.t1 + M.cool) return false;
      m.on = true; m.t0 = t; m.held = !!o.hold; m.t1 = 1e9;
      if (name === 'goo') { cue(t, 'goo', 1, o.hold ? 2.5 : M.min); if (!o.hold) m.t1 = t + M.min; }
      if (name === 'fire') { cue(t, 'fire', 1, o.hold ? 3 : M.dur); if (!o.hold) m.t1 = t + M.dur; }
      if (name === 'melt') { cue(t, 'melt', 1, 1.8); cue(t + 2.55, 'pop', 1); m.t1 = t + M.dur; }
      if (name === 'crack') { cue(t, 'crack', 1); cue(t + 0.35, 'crack', 0.7); cue(t + 0.8, 'crack', 1.2); cue(t + 1.0, 'fire', 0.8, 2.4); cue(t + 3.7, 'pop', 0.7); m.t1 = t + M.dur; }
      if (name === 'eat') { m.text = String(o.text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 26) || '...'; m.pts = null; cue(t + 0.1, 'whoosh', 0.8, 1.2); cue(t + 1.5, 'slurp', 1, 0.55); cue(t + 2.15, 'chomp', 1); cue(t + 2.5, 'chomp', 0.8); m.t1 = t + M.dur; }
      return true;
    }
    function release(name, t = st.t) { const m = st.moves[name], M = MOVES[name]; if (!m || !m.on || !m.held) return false; m.held = false; m.t1 = Math.max(t, m.t0 + (M.min || 0.8)); return true; }
    const HYPE_NOTE = [1, 1.1225, 1.2599, 1.4983, 1.6818];      // WARMING UP .. LEGENDARY: a five-note scale going up
    function setHype(rank, progress = 0, t = st.t) {
      let r = typeof rank === 'string' ? RANKS.findIndex((x) => x.id === rank) : Math.round(Number(rank));
      if (!(r >= 0)) r = -1; r = Math.min(5, r);
      if (r > st.hype.rank && r >= 0) {
        // (a new hype look: a rise that is one note higher with every rank, under the transformation; the hit comes at the lock, in pre())
        if (HY && st.hypeStyle !== 'classic' && r < 5) { cue(t, 'rise', 0.7 + 0.22 * r, 0.95, HYPE_NOTE[r]); if (r >= 3) cue(t, 'charge', 0.6 + 0.3 * (r - 3), 0.95); }
        else { cue(t, r >= 4 ? 'rise' : 'whoosh', 0.8 + 0.25 * r, 0.9); if (r === 5) { cue(t + 0.5, 'boom', 1.6); } }
        st.hype.upAt = t;
      }
      st.hype.rank = r; st.hype.k = clamp(progress);
      if (HY) HY.setRank(r, t);
    }
    // V9 HYPE (mask-hype.js): another look for the ranks. 'classic' = this file's own ladder, exactly as it was; nothing of
    // the new module is made until a style or a gifter asks for it.
    let HY = null;
    const hyOn = () => { if (!HY && root.VTMaskHype) { HY = root.VTMaskHype.create({ seed }); HY.setTone(st.hypeTone, st.hypeSolo); HY.setRank(st.hype.rank, st.t); } return HY; };
    function setHypeStyle(name) { const M = root.VTMaskHype; if (!M || !M.STYLES.includes(name)) return false; if (HY && HY.state.failed && name !== 'classic') return false;      // (this card would not take the looks' shaders: classic only)
      if (name === 'classic' && !HY) { st.hypeStyle = name; return true; } const h = hyOn(); if (!h) return false; st.hypeStyle = name; return h.setStyle(name); }
    function setHypeTone(name, solo) { st.hypeTone = name || 'classic'; st.hypeSolo = !!solo; if (HY) HY.setTone(st.hypeTone, st.hypeSolo); }
    /** a gift: the viewer's picture joins the orbit round the Mask (any hype style, the classic one too) */
    function gifter(viewer, coins, t = st.t) { const h = hyOn(); return h ? h.gifter(viewer, coins, t) : false; }
    function hypePlus(t = st.t) { if (st.hype.rank < 5 || t - st.hype.plusAt < 1.2) return false; st.hype.plusAt = t; cue(t, 'boom', 1.2); cue(t, 'rise', 1, 0.6); return true; }
    /** Mirror is on: the page flips the whole canvas, so the words spelled in points are drawn flipped (they then read right) */
    function setMirror(on) { on = !!on; if (on === !!st.mirror) return; st.mirror = on; st.text = null; if (st.moves.eat) st.moves.eat.pts = null; }
    /** where the fight's bars sit, 0 (top) .. 1 (bottom): the Mask steps away from them */
    function setBars(y) { st.barsY = clamp(Number(y) || 0); }
    /** RELEASE A. The song went on air: the Mask takes its cover's colour (warm colours only, the house look). Nothing is eaten. */
    function cover(o, t = st.t) {
      const cols = warmColours((o && o.colours) || []);
      st.song = { t0: t, title: o ? String(o.title || '').slice(0, 40) : '', c1: cols[0] || null, c2: cols[1] || null };
    }
    function songOff() { st.song = null; }
    /**
     * The Mask eats the song: { image (null = a glowing record), colours, title, grade (his verdict, when it is known
     * already), wait (false = chomp and gulp; else it chews until verdict() or gulp(), EAT.waitMax at most) }.
     * The cover flies in, is bitten away in EAT.bites chomps on the beat, is chewed to the beat, then the word or a gulp.
     */
    function eat(o, t = st.t) {
      o = o || {};
      const cols = warmColours(o.colours || []), P = st.pend && t >= st.pend.t && t - st.pend.t < EAT.pend ? st.pend : null; st.pend = null;
      const e = st.eat = {
        t0: t, image: o.image || null, record: !o.image, title: String(o.title || '').replace(/[\u0000-\u001f]/g, '').slice(0, 40), c1: cols[0] || null, c2: cols[1] || null,
        bites: [], chewT: null, munchT: -9, munches: 0, wait: o.wait !== false, word: null, wantGulp: false, wordT: null, spat: false, suckT: null, cut: false, gulpT: null,
        pts: null, ev: [], eatenK: 0, col: null, glints: [], glintT: -9, works: 0,
      };
      const w = WORDS[o.grade] || (P && P.word) || null;
      if (w) { e.word = w; e.pts = wordPoints(w); } else if (!e.wait || (P && P.gulp)) e.wantGulp = true;      // (the word's points are made now, not in the frame it is spat)
      cue(t, 'whoosh', 1, 0.9);
      return true;
    }
    /** his verdict landed ('fire' | 'gem' | 'solid' | 'promising'): the Mask spits it as a word once the bites are done. One word per eat. */
    function verdict(word, t = st.t) {
      const w = WORDS[String(word || '').toLowerCase()]; if (!w) return false;
      const e = st.eat;
      if (!e) { st.pend = { word: w, t }; return true; }                 // (the page is still loading the picture: kept for the eat that follows)
      if (e.word || e.gulpT !== null) return false;
      e.word = w; e.pts = wordPoints(w); e.wantGulp = false; return true;
    }
    /** no verdict, or the next song is on air: a satisfied gulp, no word (a word that is up is sucked back in at once) */
    function gulp(t = st.t) {
      const e = st.eat;
      if (!e) { st.pend = { gulp: true, t }; return false; }
      if (e.gulpT !== null) return false;
      if (e.wordT !== null) { e.cut = true; st.cues = st.cues.filter((c) => c.own !== e || c.t <= t); } else { e.word = null; e.pts = null; e.wantGulp = true; }
      return true;
    }
    /**
     * FIX ROUND V-2, the owed word: the song was eaten earlier (in the middle of its song) and swallowed with no word; his
     * verdict lands now. No second bite: a belch, and the word with the song's title. false while another eat is going on.
     */
    function belch(word, o, t = st.t) {
      const w = WORDS[String(word || '').toLowerCase()]; if (!w || st.eat) return false;
      eat({ image: null, title: o && o.title, grade: word, wait: false }, t);
      const e = st.eat; e.belch = true; e.bites = [t, t, t, t]; e.chewT = t - EAT.settle + 0.35; e.munchT = t; { const lc = st.cues[st.cues.length - 1]; if (lc && lc.kind === 'whoosh' && lc.t === t) st.cues.pop(); } cue(t, 'pop', 1.1); cue(t + 0.05, 'rise', 0.7, 0.4);
      return true;
    }
    /** one frame of an eat: the bites and the munches land on a beat (`onset`) when there is one; then the word or the gulp */
    function eatStep(e, t, onset) {
      const T = EAT; e.ev = [];
      if (e.bites.length < T.bites && t - e.t0 >= T.arrive - 1e-6) {
        const last = e.bites.length ? e.bites[e.bites.length - 1] : e.t0 + T.arrive - T.biteGap;
        if ((onset && t - last >= T.biteGap - 1e-6) || t - last >= T.biteMax - 1e-6) {
          e.bites.push(t); const n = e.bites.length; cue(t, 'chomp', n === T.bites ? 1.15 : 0.85 + 0.05 * n); e.ev.push('bite');
          if (n === T.bites) { e.chewT = t; e.munchT = t; e.ev.push('lastbite'); cue(t + 0.1, 'rise', 0.6, 0.6); }
        }
      }
      if (e.chewT !== null && e.wordT === null && e.gulpT === null) {
        if (t > e.chewT && ((onset && t - e.munchT >= 0.28) || t - e.munchT >= 0.62)) { e.munchT = t; e.munches++; e.ev.push('munch'); if (e.munches <= 3) cue(t, 'chomp', 0.4); }
        if (t - e.chewT >= T.settle - 1e-6) {
          if (e.word) startWord(e, t + 0.12);
          else if (e.wantGulp || t - e.chewT >= T.waitMax) startGulp(e, t);
        }
      }
      if (e.wordT !== null && e.gulpT === null) {
        const w = t - e.wordT;
        if (!e.spat && w >= 0) { e.spat = true; e.ev.push('spit'); }
        if (e.suckT === null && ((e.cut && w >= T.form * 0.5) || w >= T.form + T.hold)) { e.suckT = t; cue(t, 'slurp', 1, T.suck); e.ev.push('suck'); }
        if (e.suckT !== null && t - e.suckT >= T.suck) startGulp(e, t);
      }
      if (e.gulpT !== null && t - e.gulpT >= T.gulp) st.eat = null;
    }
    function startWord(e, at) {
      const tier = TIER[e.word], n0 = st.cues.length;
      e.wordT = at; if (!e.pts) e.pts = wordPoints(e.word);
      cue(at - 0.12, 'rise', 0.8, 0.2); cue(at, 'boom', tier.boom);
      if (tier.flame > 0.5) cue(at + 0.1, 'fire', 1.1, EAT.hold);
      for (let i = 0; i < tier.works; i++) cue(at + 0.55 + i * 0.40, 'bang', 0.8 + 0.3 * (i % 2));
      if (tier.glint) for (let i = 0; i < 3; i++) cue(at + 0.35 + i * 0.22, 'ping', 0.7);
      if (tier.soft) cue(at + 0.12, 'pop', 0.7);
      for (let i = Math.min(n0, st.cues.length); i < st.cues.length; i++) st.cues[i].own = e;      // (a gulp that cuts the word short takes its later sounds with it)
    }
    function startGulp(e, t) { e.gulpT = t; e.ev.push('gulp'); cue(t, 'slurp', e.wordT === null ? 1.2 : 0.6, 0.35); cue(t + 0.32, 'pop', 0.9); }
    /** the jaw of an eat, 0..1: wide for the cover, a snap at each bite, a munch on each beat, wide for the word, a swallow */
    function eatJaw(e, t) {
      const T = EAT, u = t - e.t0;
      if (e.gulpT !== null) { const g = t - e.gulpT; return Math.max(0.5 * Math.sin(Math.PI * clamp(g / 0.22)), 0.16 * Math.sin(Math.PI * clamp((g - 0.36) / 0.30))); }
      if (e.wordT !== null) {
        const w = t - e.wordT; if (w < 0) return 0.03;                   // the wind-up: shut
        if (e.suckT !== null) return 0.95 * ss(0, 0.10, t - e.suckT);
        return lerp(1, TIER[e.word].jaw, ss(T.form * 0.8, T.form + 0.5, w));
      }
      if (e.chewT !== null) return 0.05 + 0.40 * Math.sin(Math.PI * clamp((t - e.munchT) / 0.24));
      return e.bites.length ? ss(0.03, 0.22, t - e.bites[e.bites.length - 1]) : ss(0.45, 0.9, u);
    }
    /**
     * A verdict word as points: the word is written once (heavy, upper case), its body sampled on a staggered grid and its
     * outline on a finer one. -> { n, nFill, d: [x, y, kind] per point (x -1..1 across the word, y in the same unit,
     * kind 0 = body, 1 = outline, 2 = an outline point on a top edge: where flames stand), yr: half its height, tops }.
     * null where there is no canvas to write on (tests without one): the word's timing still runs.
     */
    function wordPoints(word) {
      const doc = root.document; if (!doc && !root.OffscreenCanvas) return null;
      try {
        const F = 240, font = '700 ' + F + 'px Bahnschrift, "Segoe UI", Arial, sans-serif', mk = (w, h) => (root.OffscreenCanvas ? new root.OffscreenCanvas(w, h) : Object.assign(doc.createElement('canvas'), { width: w, height: h }));
        let x = mk(8, 8).getContext('2d'); x.font = font;
        const tw = Math.ceil(x.measureText(word).width), CW = Math.max(64, Math.min(2600, tw + 56)), CH = 330, c = mk(CW, CH); x = c.getContext('2d', { willReadFrequently: true });
        x.fillStyle = '#000'; x.fillRect(0, 0, CW, CH); x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineJoin = 'round'; x.lineWidth = 8; x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.strokeText(word, CW / 2, CH / 2 + 10); x.fillText(word, CW / 2, CH / 2 + 10);
        const d = x.getImageData(0, 0, CW, CH).data, on = (px, py) => px >= 0 && py >= 0 && px < CW && py < CH && d[(py * CW + px) * 4] > 110;
        let cnt = 0, y0 = CH, y1 = 0, x0 = CW, x1 = 0;
        for (let py = 0; py < CH; py += 2) for (let px = 0; px < CW; px += 2) if (d[(py * CW + px) * 4] > 110) { cnt++; if (py < y0) y0 = py; if (py > y1) y1 = py; if (px < x0) x0 = px; if (px > x1) x1 = px; }
        if (!cnt) return null;
        const s = Math.max(2.2, Math.sqrt(cnt * 4 / 4300)), cyM = (y0 + y1) / 2, hw = CW / 2, fill = [], edge = [];
        let row = 0;
        for (let gy = s / 2; gy < CH; gy += s * 0.866, row++) for (let gx = (row % 2) * s / 2; gx < CW; gx += s) {
          const px = Math.round(gx + (h1(gx * 0.37 + gy * 1.3) - 0.5) * s * 0.3), py = Math.round(gy + (h1(gx * 1.7 + gy * 0.21 + 3) - 0.5) * s * 0.3);
          if (on(px, py)) fill.push((px - hw) / hw, (cyM - py) / hw, 0);
        }
        const es = Math.max(2, Math.round(s * 0.6));
        for (let py = 0; py < CH; py += es) for (let px = (Math.floor(py / es) % 2); px < CW; px += es) if (on(px, py) && (!on(px - 3, py) || !on(px + 3, py) || !on(px, py - 3) || !on(px, py + 3))) edge.push((px - hw) / hw, (cyM - py) / hw, on(px, py - 3) ? 1 : 2);
        const thin = (a, max) => { const n = a.length / 3; if (n <= max) return a; const out = [], step = n / max; for (let f = 0; Math.floor(f) < n && out.length < max * 3; f += step) { const i = Math.floor(f) * 3; out.push(a[i], a[i + 1], a[i + 2]); } return out; };
        const A = thin(fill, 4900), B = thin(edge, 2600), all = new Float32Array(A.length + B.length); all.set(A, 0); all.set(B, A.length);
        const n = all.length / 3, tops = []; for (let i = A.length / 3; i < n; i++) if (all[i * 3 + 2] === 2) tops.push(i);
        return { word, n, nFill: A.length / 3, d: all, yr: Math.max(0.02, (y1 - y0) / 2 / hw), xr: Math.max(0.3, Math.max(hw - x0, x1 - hw) / hw), tops };
      } catch (err) { return null; }
    }
    function score(n, t = st.t) { n = clamp(Math.round(Number(n) || 0), 0, 100); st.score = { t0: t, n, kind: n >= 70 ? 'fire' : n <= 40 ? 'goo' : 'meh' }; cue(t, 'rise', 0.8, 1.1); if (n >= 70) { cue(t + 1.2, 'fire', 1.2, 2.2); for (let i = 0; i < 5; i++) cue(t + 1.5 + i * 0.42, 'bang', 0.8 + 0.3 * (i % 2)); } else if (n <= 40) cue(t + 1.2, 'goo', 1, 2.0); else cue(t + 1.2, 'pop', 0.6); }
    function boss(s) { st.boss = s && s.phase && s.phase !== 'idle' ? s : null; }
    function vote(v) { st.vote = v && (v.active || v.result) ? v : null; }
    function hands(p, o) { st.hands = p || null; if (o && o.aspect) st.handOpt.aspect = o.aspect; }

    // ---------------------------------------------------------------- the face mesh, bent (jaw, melt) and put back
    let W8 = null, backup = null, bent = false, ringBk = null, eyeBk = null, openBk = 0;
    function weights(core) {
      const M = core.mesh, n = M.nFine, R = M.rest, lip = M.mask.lipIn; let sy = 0, sw = 0, hw = 0.1;
      for (let i = 0; i < n; i++) if (lip[i] > 0.5) { sy += R[i * 3 + 1] * lip[i]; sw += lip[i]; hw = Math.max(hw, Math.abs(R[i * 3])); }
      const my = sw ? sy / sw : -0.95, jaw = new Float32Array(n), up = new Float32Array(n), col = new Float32Array(n);
      // the line where the lips meet at rest, as a curve y(x): half way between the upper and the lower inner lip
      // (the 20 inner-lip points: 0 and 10 the corners, 1..9 the upper lip, 11..19 the lower)
      const LIP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95], pt = (j) => [R[LIP[j] * 3], R[LIP[j] * 3 + 1]];
      const chainY = (idx, x) => { for (let k = 0; k < idx.length - 1; k++) { const a = pt(idx[k]), b = pt(idx[k + 1]); if ((x >= a[0] && x <= b[0]) || (x <= a[0] && x >= b[0])) return a[1] + (b[1] - a[1]) * (Math.abs(b[0] - a[0]) < 1e-6 ? 0 : (x - a[0]) / (b[0] - a[0])); } return Math.abs(x - pt(0)[0]) < Math.abs(x - pt(10)[0]) ? pt(0)[1] : pt(10)[1]; };
      const upC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], loC = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0], midY = (x) => 0.5 * (chainY(upC, x) + chainY(loC, x));
      for (let i = 0; i < n; i++) {
        const x = R[i * 3], y = R[i * 3 + 1], ax = Math.abs(x), near = ss(my - 0.50, my - 0.06, y), m = midY(x);
        const lat = 1 - Math.pow(ss(0, hw * 1.08, ax), 1.6) * near;
        jaw[i] = (y < m ? 1 : 0) * lat * (1 - 0.6 * ss(0.62, 1.05, ax));
        up[i] = (y < m ? 0 : 1) * (1 - ss(my + 0.10, my + 0.38, y)) * (1 - ss(hw * 0.4, hw * 1.1, ax));
        col[i] = 0.5 + 0.5 * Math.sin(x * 7.3 + 1.7) * Math.sin(x * 3.1 + 0.4);
      }
      return { my, hw, jaw, up, col, n };
    }
    function bend(core, jaw, melt) {
      if (!W8 || W8.n !== core.mesh.nFine) W8 = weights(core);
      const P = core.pos, n = W8.n, R = core.mesh.rest;
      if (!backup || backup.length !== P.length) backup = new Float32Array(P.length);
      backup.set(P); ringBk = core.mouth.ring.slice(); openBk = core.mouth.open; eyeBk = core.eyes.map((e) => e.c.slice()); bent = true;
      const J = jaw * 0.62, U = jaw * 0.10;
      // MELT (phase 2): wax, not a heap. The face keeps its shape and RUNS: every column of it flows down at its own speed
      // (a few long runs), the jaw furthest, the brow only sags; what reaches the pool spreads. The eyes slide with it.
      const sag = Math.pow(melt, 1.25);
      const meltAt = (x, y, z, c) => {
        const hf = clamp((y + 1.84) / 2.84), run = meltRun(x), fl = MELT_FLOOR;
        const drop = sag * ((0.95 + 1.9 * run) * (1 - 0.86 * hf) + 0.24 * hf);
        let ny = y - drop, nx = x * (1 - 0.14 * sag * (1 - hf)) + 0.035 * sag * Math.sin(y * 4.0 + x * 3.0), nz = z * (1 - 0.30 * sag);
        if (ny < fl) { const over = Math.min(1, (fl - ny) / 1.2); ny = fl + 0.05 * c; nx = x * (1 + 0.55 * over); nz = z * (1 - 0.6 * over) + 0.1 * over; }
        return [nx, ny, nz];
      };
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        if (J > 0) { P[o + 1] += U * W8.up[i] - J * W8.jaw[i]; P[o + 2] -= J * 0.12 * W8.jaw[i]; }
        if (melt > 0) { const q = meltAt(P[o], P[o + 1], P[o + 2], W8.col[i]); P[o] = q[0]; P[o + 1] = q[1]; P[o + 2] = q[2]; }
      }
      const ring = core.mouth.ring, NR = ring.length / 3; let cy = 0, cx = 0; for (let k = 0; k < NR; k++) { cy += ring[k * 3 + 1] / NR; cx += ring[k * 3] / NR; }
      for (let k = 0; k < NR; k++) {
        const o = k * 3, dx = (ring[o] - cx) / (W8.hw * 1.02), lat = Math.max(0, 1 - dx * dx);
        if (J > 0) ring[o + 1] += k > 10 ? -J * lat : k > 0 && k < 10 ? U * lat : 0;
        if (melt > 0) { const q = meltAt(ring[o], ring[o + 1], ring[o + 2], 0.5); ring[o] = q[0]; ring[o + 1] = q[1]; ring[o + 2] = q[2]; }
      }
      if (J > 0) core.mouth.open = Math.max(core.mouth.open, Math.min(1, jaw * 1.3));
      if (melt > 0) for (const e of core.eyes) { const q = meltAt(e.c[0], e.c[1], e.c[2], 0.5 + 0.5 * Math.sin(e.c[0] * 7.3 + 1.7) * Math.sin(e.c[0] * 3.1 + 0.4)); e.c[0] = q[0]; e.c[1] = q[1]; e.c[2] = q[2]; }
      void R;
    }
    const MELT_FLOOR = -3.0, meltRun = (x) => { const c = 0.5 + 0.5 * Math.sin(x * 4.1 + 0.6) * Math.cos(x * 2.3 - 0.9); return 0.22 + 0.78 * c * c; };
    function post() { if (!bent || !CORE) return; CORE.pos.set(backup); CORE.mouth.ring.set(ringBk); CORE.mouth.open = openBk; CORE.eyes.forEach((e, i) => { e.c[0] = eyeBk[i][0]; e.c[1] = eyeBk[i][1]; e.c[2] = eyeBk[i][2]; }); bent = false; }
    let CORE = null;

    // ---------------------------------------------------------------- per frame: what every layer is at
    const U = { nDmg: 0, dmg: new Float32Array(64), v8: [0, 0, 0, 0], fire: GOLD.slice() };
    const env = (m, t, a, b) => (m.on ? ss(0, a, t - m.t0) * (1 - ss(m.t1 - b, m.t1, t)) : 0);
    function chompJaw(u, times) { let j = 1; for (const c of times) { const d = u - c; if (d > -0.07 && d < 0.20) j = Math.min(j, d < 0 ? 1 - (d + 0.07) / 0.07 : ss(0.02, 0.20, d)); } return j; }
    function pre(t, ctx) {
      const dt = st.lastT === null ? 1 / 30 : clamp(t - st.lastT, 0, 0.1); st.t = t;
      const L = st.L, A = ctx.audio || { level: 0.4, bass: 0.3, beat: 0 }, hy = st.hype.rank, B = st.boss, mv = st.moves;
      for (const k in mv) if (mv[k].on && t >= mv[k].t1) { mv[k].on = false; mv[k].t1 = t; }
      if (mv.goo.on && t - mv.goo.t0 > MOVES.goo.max) release('goo', t);
      if (mv.fire.on && mv.fire.held && t - mv.fire.t0 > MOVES.fire.max) release('fire', t);
      const fireMv = env(mv.fire, t, 0.35, 0.6), crackMv = mv.crack.on ? ss(0, 1.1, t - mv.crack.t0) * (1 - ss(mv.crack.t1 - 0.7, mv.crack.t1 - 0.15, t)) : 0;
      const stage = B ? B.boss.stage : 'whole', E = B ? B.ending : null, sc = st.score, scU = sc ? t - sc.t0 : 99;
      const scoreFire = sc && sc.kind === 'fire' ? ss(1.1, 1.4, scU) * (1 - ss(3.3, 3.8, scU)) : 0, scoreGoo = sc && sc.kind === 'goo' ? ss(1.1, 1.3, scU) * (1 - ss(3.0, 3.2, scU)) : 0;
      const special = B && B.moves && B.moves.special && B.moves.special.name && B.moves.special.age < 1.6 ? B.moves.special : null;
      const spFire = special && special.name === 'fire' ? 1 - ss(1.1, 1.6, special.age) : 0, spGoo = special && special.name === 'goo' ? 1 - ss(1.1, 1.6, special.age) : 0;
      st.gooOn = Math.max(mv.goo.on ? 1 : 0, scoreGoo > 0.5 ? 1 : 0, spGoo > 0.5 ? 1 : 0);
      // release A: the eat's own clock (a beat's onset = the envelope jumps), and what the word asks of the face
      const bt = A.beat || 0, onset = bt > 0.4 && bt - (st.beatPrev === undefined ? bt : st.beatPrev) > 0.12; st.beatPrev = bt;
      if (st.eat) eatStep(st.eat, t, onset);
      const eN = st.eat, wordUp = eN && eN.wordT !== null && eN.gulpT === null && t >= eN.wordT ? 1 : 0, fireWord = wordUp && eN.word === 'FIRE' && eN.suckT === null ? 1 : 0, wordRoom = wordUp ? (st.faceK === undefined ? 1 : st.faceK) : 0;      // (wordRoom: in the Visualizer nothing moves the formation)
      st.thin = fireWord;
      const tg = {
        halo: hy === 0 ? 0.55 : hy === 1 ? 1 : 0,
        crown: Math.max(hy >= 1 ? [0.27, 0.55, 0.8, 1.0, 0][hy - 1] : 0, fireMv, stage === 'demon' ? 0.75 : stage === 'cracked' ? 0.3 : 0, spFire, 0.55 * fireWord),
        eyes: Math.max(hy === 3 || hy === 4 ? 0.75 : 0, fireMv, stage === 'demon' ? 0.9 : 0, spFire * 0.8),
        mouthFire: Math.max(hy === 3 || hy === 4 ? 0.6 : 0, fireMv, scoreFire, spFire),      // (fix round: no mouth flame under a verdict: it sat over the nose)
        embers: hy >= 0 ? 0.62 + 0.08 * hy : stage !== 'whole' ? 0.5 : 0, eyeHot: hy >= 0 ? 0.45 + 0.11 * hy : 0, bgFire: hy === 3 || hy === 4 ? 1 : 0,
        gold: hy === 4 ? 1 : 0, cosmic: hy === 5 ? 1 : 0,
        crack: Math.max(crackMv, stage === 'demon' ? 0.80 : stage === 'cracked' ? 0.58 : 0), demon: stage === 'demon' ? 1 : 0,
        room: Math.max(st.vote ? 1 : 0, st.hands && (st.hands.angel.on || st.hands.devil.on) ? 1 : 0, B ? (E && E.winner === 'boss' && (E.stage === 'laugh' || E.stage === 'credits') ? 1 : (st.barsY || 0) > 0.25 ? 1 : 0.35) : 0, mv.eat.on && t - mv.eat.t0 < 2.9 ? 1 : 0, wordRoom),
      };
      // V9 HYPE: a new style takes the ranks' layers over (the puppet moves and the fight keep their fire)
      const hyp = HY ? HY.pre(t, dt, { audio: A, fire: st.fire || GOLD, own: st.own || null, viz: ctx.fx && ctx.fx.viz > 0 ? ctx.fx.viz : 0 }) : null; st.hyp = hyp;
      if (hyp && hyp.on) { tg.halo = 0; tg.crown = Math.max(fireMv, stage === 'demon' ? 0.75 : stage === 'cracked' ? 0.3 : 0, spFire); tg.eyes = Math.max(fireMv, stage === 'demon' ? 0.9 : 0, spFire * 0.8); tg.mouthFire = Math.max(fireMv, scoreFire, spFire); tg.bgFire = 0; tg.embers = Math.max(hyp.embers, stage !== 'whole' ? 0.5 : 0); tg.gold = hyp.gold; }
      if (E && (E.stage === 'explode' || E.stage === 'rain' || E.stage === 'credits') && E.winner === 'chat') { tg.crown = 0; tg.eyes = 0; tg.mouthFire = 0; tg.crack = 0; tg.demon = 0; }
      if (E && E.stage === 'reform') { tg.crack = 0; tg.demon = 0; tg.crown = 0; tg.eyes = 0; }
      // the boss wins: he heals as he gulps the raid down (the cracks seal, the demon red goes), so he laughs with a whole face
      const healed = E && E.winner === 'boss' ? (E.stage === 'gulp' ? ss(0.15, 0.9, E.k) : E.stage === 'shatter' ? 0 : 1) : 0;
      if (healed > 0) { tg.crack *= 1 - healed; tg.demon *= 1 - healed; tg.crown = Math.min(tg.crown, 0.45); tg.eyes = Math.min(tg.eyes, 0.5); }
      for (const k of ['halo', 'crown', 'eyes', 'mouthFire', 'embers', 'eyeHot', 'bgFire']) L[k] = ease(L[k], tg[k], dt, 3.0, 2.2);
      L.gold = ease(L.gold, tg.gold, dt, 1.4, 1.4); L.cosmic = ease(L.cosmic, tg.cosmic, dt, 0.9, 1.6); L.crack = ease(L.crack, tg.crack, dt, 2.6, 3.5); L.demon = ease(L.demon, tg.demon, dt, 2.5, 2.5); L.room = ease(L.room, tg.room, dt, 3, 2.2);
      L.heat = ease(L.heat, clamp(0.25 + 0.9 * A.level + 0.5 * A.bass), dt, 9, 4);
      // the jaw: goo, the comment, the cover, the score, the fight's gulp and laugh
      let jaw = 0;
      if (mv.goo.on) jaw = Math.max(jaw, 0.80 * env(mv.goo, t, 0.25, 0.45));
      if (mv.eat.on) { const u = t - mv.eat.t0; jaw = Math.max(jaw, ss(1.05, 1.45, u) * (1 - ss(2.75, 2.95, u)) * chompJaw(u, [2.15, 2.5])); }
      if (eN) jaw = Math.max(jaw, eatJaw(eN, t));                        // release A: the cover, the chew, the word, the gulp
      if (fireMv > 0) jaw = Math.max(jaw, 0.42 * fireMv);
      jaw = Math.max(jaw, 0.75 * scoreFire, 0.80 * scoreGoo, 0.5 * spFire, 0.7 * spGoo);
      if (B && B.moves) { if (B.moves.eat && (B.moves.eat.on || B.moves.eat.charge > 0)) jaw = Math.max(jaw, B.moves.eat.on ? 0.80 : 0.80 * (B.moves.eat.charge || 0)); if (B.moves.scream && B.moves.scream.age !== null && B.moves.scream.age < 0.9) jaw = Math.max(jaw, 0.85 * (1 - ss(0.6, 0.9, B.moves.scream.age))); }
      if (E && E.winner === 'boss') { if (E.stage === 'gulp') jaw = Math.max(jaw, E.k < 0.86 ? ss(0, 0.2, E.k) : 1 - ss(0.86, 0.92, E.k)); if (E.stage === 'laugh') jaw = Math.max(jaw, 0.25 + 0.5 * Math.pow(0.5 + 0.5 * Math.sin(E.t * 2 * Math.PI * 3.1), 2) * (1 - ss(0.85, 1, E.k))); }
      L.jaw = jaw;
      let melt = 0;
      if (mv.melt.on) { const u = t - mv.melt.t0; melt = u < 2.55 ? Math.pow(ss(0, 2.1, u), 0.9) : Math.max(0, 1 - (u - 2.55) / 0.16); st.meltSnap = u > 2.55 ? Math.exp(-(u - 2.55) * 7) * Math.sin((u - 2.55) * 30) : 0; } else st.meltSnap = 0;
      L.melt = melt;
      // the fight's endings
      let gone = 0, shatter = 0;
      if (E && E.winner === 'chat') { if (E.stage === 'explode') { shatter = 3.2 * Math.pow(E.k, 0.6); gone = ss(0.25, 1, E.k); } else if (E.stage === 'rain' || E.stage === 'credits') { shatter = 3.2; gone = 1; } else if (E.stage === 'reform') { shatter = 3.2 * Math.pow(1 - E.k, 2.2); gone = 1 - ss(0.1, 0.7, E.k); } }
      L.gone = gone; L.shatter = shatter;
      CORE = ctx.core;
      if ((jaw > 0.004 || melt > 0.004) && ctx.core) bend(ctx.core, jaw, melt);
      // ---- holes that stay (the engine's list; more than 16 are merged for the shader; a new one opens over 0.2 s)
      let nD = 0;
      if (B && B.damage && B.damage.length && !(E && E.stage === 'reform' && E.k > 0.98)) {
        let list = B.damage.map((d) => ({ p: d.pos.slice(), r: d.r * ss(0, 0.22, t - (d.t0 === undefined ? -9 : d.t0)) }));
        while (list.length > 16) { let bi = 0, bj = 1, bd = 1e9; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const d = Math.hypot(list[i].p[0] - list[j].p[0], list[i].p[1] - list[j].p[1], list[i].p[2] - list[j].p[2]); if (d < bd) { bd = d; bi = i; bj = j; } } const a = list[bi], b = list[bj]; a.p = lerp3(a.p, b.p, 0.5); a.r = Math.max(a.r, b.r) + bd * 0.45; list.splice(bj, 1); }
        const close = healed > 0 ? 1 - healed : E && E.stage === 'reform' ? 1 - ss(0.2, 0.95, E.k) : 1;
        for (const d of list) { U.dmg[nD * 4] = d.p[0]; U.dmg[nD * 4 + 1] = d.p[1]; U.dmg[nD * 4 + 2] = d.p[2]; U.dmg[nD * 4 + 3] = Math.max(0.2, d.r * 1.55) * close; nD++; }
      }
      U.nDmg = nD;
      // ---- colour
      const Mood = root.VTMaskMood, pal0 = ctx.palette, custom = ctx.colour || null;
      let P = pal0 ? { shade: pal0.shade.slice(0, 3), shade2: pal0.shade2.slice(0, 3), key: pal0.key.slice(0, 3), accent: pal0.accent.slice(0, 3), gain: pal0.gain, flash: pal0.flash || [0, 0, 0, 0] } : { shade: [1, 0.045, 0.03], shade2: [1, 0.045, 0.03], key: [1, 0.97, 0.93], accent: [1, 0.97, 0.93], gain: 1, flash: [0, 0, 0, 0] };
      const nrm = (c) => { const m = Math.max(c[0], c[1], c[2], 1e-3); return [c[0] / m, c[1] / m, c[2] / m]; };
      // the song's cover: on Auto the face takes its two main colours (the 3D shading is kept by mask-mood's own recipe);
      // a colour the host picked stays the face, and the cover only tints the lines and the eyes
      // (release A: while the Mask eats, the colours are the eaten cover's, also after the song went off air; they fade
      // out, not snap, when there is no song any more)
      const sg0 = st.eat && st.eat.c1 ? st.eat : st.song && st.song.c1 ? st.song : null; if (sg0) st.tint = { c1: sg0.c1, c2: sg0.c2 };
      const sg = st.tint || null; st.songK = ease(st.songK, sg0 ? 1 : 0, dt, 2.4, 1.5); if (!sg0 && st.songK < 0.003) st.tint = null;
      if (st.songK > 0.003 && sg && sg.c1) {
        if (!custom && Mood) { const sp = Mood.custom(ctx.mood || null, sg.c1, true); if (sg.c2) sp.shade2 = lerp3(sp.shade2, mul3(nrm(sg.c2), 1.05), 0.7); for (const k of ['shade', 'shade2', 'key', 'accent']) P[k] = lerp3(P[k], sp[k], st.songK); P.gain = lerp(P.gain, sp.gain, st.songK); }
        else P.accent = lerp3(P.accent, lerp3(WHITE, nrm(sg.c1), 0.55), 0.6 * st.songK);
      }
      const own = custom ? nrm(custom) : null;
      let fire = own ? lerp3(own, WHITE, 0.12) : sg && sg.c1 && st.songK > 0 ? lerp3(GOLD, nrm(sg.c1), 0.62 * st.songK) : GOLD.slice();      // (the score's fire and the eye glow follow the cover's warm colour)
      if (L.gold > 0.003) {
        // LEGENDARY: molten gold. On Auto the whole face; over a picked colour the light and the lines turn gold, the body stays his.
        if (!own) { P.shade = lerp3(P.shade, [1.10, 0.46, 0.06], L.gold); P.shade2 = lerp3(P.shade2, [1.25, 0.86, 0.30], L.gold); }
        P.key = lerp3(P.key, [1.0, 0.90, 0.70], L.gold); P.accent = lerp3(P.accent, [1.30, 1.06, 0.62], L.gold); P.gain *= 1 + 0.12 * L.gold;
      }
      if (L.cosmic > 0.003) { if (!own) { P.shade = lerp3(P.shade, [1.0, 0.07, 0.05], L.cosmic); P.shade2 = lerp3(P.shade2, [1.1, 0.42, 0.10], L.cosmic); } P.accent = lerp3(P.accent, [1.25, 1.12, 0.85], L.cosmic); P.gain *= 1 + 0.10 * L.cosmic; }
      const hotK = Math.max(L.eyeHot * 0.5, L.eyes, L.crown * 0.5);
      if (hotK > 0.003) P.accent = lerp3(P.accent, lerp3(WHITE, fire, 0.55), 0.55 * hotK);
      if (L.demon > 0.003) { const pulse = 0.85 + 0.25 * Math.sin(t * 7.5); P.shade = lerp3(P.shade, [1.45 * pulse, 0.03, 0.02], L.demon); P.shade2 = lerp3(P.shade2, [1.5, 0.10, 0.03], L.demon); P.key = lerp3(P.key, [1.0, 0.30, 0.16], L.demon); P.accent = lerp3(P.accent, [1.5, 0.42, 0.12], L.demon); P.gain *= 1 + 0.25 * L.demon; fire = lerp3(fire, [1.0, 0.24, 0.05], L.demon); }
      if (L.gone > 0) P.gain *= 1 - L.gone;
      // the flash (decays; its start is rate-limited in flash())
      st.flash[3] *= Math.exp(-dt * 7); const pf = P.flash || [0, 0, 0, 0]; P.flash = st.flash[3] > pf[3] ? st.flash.slice() : pf;
      U.v8 = [L.crack, L.cosmic, clamp(L.heat + 0.5 * L.demon), 0]; U.gone = L.gone > 0.92; U.fire = fire; st.fire = fire; st.own = own; st.pal = P; if (st.eat) st.eat.col = fire; U.hy = hyp && hyp.on ? hyp.face : null;
      // V9 viz fix: in the Visualizer the face is not there, so nothing that draws the head's shape may be (the rim of heat was
      // an outline round nothing). faceK = how much of his FACE is on screen: 1 = the face (every number below is then
      // exactly what it was), 0 = the Visualizer; it follows mask-fx's own 1.5 s ease. The eyes stay, as two vortexes
      // that mask-looks.js draws behind the formation: eyeHeat tells it how hot the show has made them.
      st.faceK = 1 - ss(0, 0.8, ctx.fx && ctx.fx.viz > 0 ? ctx.fx.viz : 0); U.eyeHeat = clamp(Math.max(L.eyeHot * 0.9, L.eyes, L.demon, L.cosmic) * (1 - L.gone));
      if (hyp && hyp.on && hyp.lockNow && hyp.rank >= 0 && hyp.rank < 5) { const r = hyp.rank; cue(t, r >= 3 ? 'boom' : 'bang', 0.55 + 0.26 * r); cue(t, 'ping', 0.6 + 0.12 * r, 0, HYPE_NOTE[r] * 0.75); if (r === 4) cue(t + 0.04, 'glass', 0.55); }      // the transformation's hit, on the lock
      if (hyp && hyp.on) { if (hyp.kick) st.kickV = Math.max(st.kickV, hyp.kick); P.gain *= 1 + 0.25 * hyp.pulse; }
      st.gooA = gooColour === 'mask' && own && !(own[0] > 0.9 && own[1] < 0.42 && own[2] < 0.18) ? own : TOXIC;      // never a blood red: a red Mask keeps the toxic green st.gooA2 = st.gooA === TOXIC ? TOXIC2 : mul3(own, 0.30);
      // ---- the effects' own state (mask-fx): shatter, the camera's kick, the grow
      st.kickV *= Math.exp(-dt * 9); const kx = st.kickV * Math.sin(t * 61), ky = st.kickV * Math.cos(t * 47);
      const shake = (B ? B.boss.shake || 0 : 0) * 0.5 + L.demon * 0.10 + (B && B.moves && B.moves.scream && B.moves.scream.age !== null && B.moves.scream.age < 0.8 ? 0.8 * (1 - B.moves.scream.age / 0.8) : 0);
      const plusAge = t - st.hype.plusAt, plus = plusAge < 1.2 ? Math.exp(-plusAge * 3.2) * Math.sin(Math.min(1, plusAge * 6) * Math.PI * 0.5) : 0;
      const fx0 = ctx.fx || null, fx = fx0 ? Object.assign({}, fx0) : null;
      if (fx) {
        fx.shatter = Math.max(fx0.shatter, L.shatter);
        fx.scale = fx0.scale * (1 + 0.10 * L.cosmic + 0.10 * plus + 0.06 * (st.meltSnap || 0));
        fx.kick = [fx0.kick[0] + kx + shake * Math.sin(t * 53) * 0.8, fx0.kick[1] + ky + shake * Math.cos(t * 41) * 0.8, fx0.kick[2] + st.kickV * 0.8 + plus * 0.5];
        fx.pulse = fx0.pulse + plus * 0.8;
        if (hyp && hyp.on) { fx.scale *= 1 + hyp.push; fx.pulse += hyp.pulse; }
      }
      L.dodge = ease(L.dodge || 0, B && B.moves && B.moves.dodge && B.moves.dodge.on ? (B.moves.dodge.dir || 1) : 0, dt, 13, 5); st.dodgeX = 0.40 * L.dodge;
      const head = ctx.head ? { R: ctx.head.R, x: ctx.head.x + st.dodgeX + shake * 0.03 * Math.sin(t * 67), y: ctx.head.y + shake * 0.03 * Math.cos(t * 59) + (E && E.winner === 'boss' && E.stage === 'laugh' ? 0.035 * Math.sin(E.t * 2 * Math.PI * 3.1) : 0), scale: ctx.head.scale } : null;
      // room for what shares the picture: a vote's panel, the hand puppets, the bars
      const pl0 = ctx.place || { zoom: 1, x: 0, y: 0 }, vt = st.vote ? 1 : 0, room = L.room;
      const hd = st.hands && (st.hands.angel.on || st.hands.devil.on) ? 1 : 0, et = mv.eat.on ? 1 : 0, bw = E && E.winner === 'boss' && (E.stage === 'credits' || E.stage === 'laugh') ? 1 : 0;
      const hA = st.hands && st.hands.angel && st.hands.angel.on, hD = st.hands && st.hands.devil && st.hands.devil.on, two = hA && hD;
      // the fight's bars: at the top the Mask sits a little lower, in the middle it goes small and under them, at the bottom it moves up
      const by = st.barsY || 0, barZ = by > 0.25 && by < 0.75 ? 0.40 : by >= 0.75 ? 0.30 : 0.20, barY = by > 0.25 && by < 0.75 ? 0.20 : by >= 0.75 ? -0.115 : 0.012;
      const zk = vt ? 0.30 : wordRoom > 0.5 ? 0.36 : hd ? (two ? 0.50 : 0.36) : et ? 0.16 : bw ? 0.48 : barZ, yk = vt ? 0.10 : wordRoom > 0.5 ? 0.17 : hd ? (two ? -0.085 : -0.05) : et ? -0.055 : bw ? (by >= 0.75 ? -0.16 : by > 0.25 ? 0.16 : -0.10) : barY;
      L.aside = ease(L.aside || 0, hd && !two ? (hA ? (st.hands.angel.x < 0.5 ? 1 : -1) : (st.hands.devil.x < 0.5 ? 1 : -1)) : 0, dt, 3, 2.5);
      let place = room > 0.003 || Math.abs(L.aside) > 0.003 ? { zoom: pl0.zoom * (1 - zk * room), x: pl0.x + 0.13 * L.aside, y: pl0.y - yk * room } : ctx.place || null;
      if (hyp && hyp.zoom < 0.999) { const b = place || pl0; place = { zoom: b.zoom * hyp.zoom, x: b.x, y: b.y }; }      // (orbits and gifters need room at the sides: the Mask steps back a little)
      st.lastT = t;
      return { palette: P, fx, head, place, v8: { u: U, render } };
    }

    // ---------------------------------------------------------------- particles (CPU): sparks, embers, goo, fire, threads
    const N = 5000, PX = new Float32Array(N), PY = new Float32Array(N), PZ = new Float32Array(N), VX = new Float32Array(N), VY = new Float32Array(N), VZ = new Float32Array(N), AGE = new Float32Array(N), LIFE = new Float32Array(N), SZ = new Float32Array(N), CR = new Float32Array(N), CG = new Float32Array(N), CB = new Float32Array(N), KIND = new Uint8Array(N), AUX = new Float32Array(N);
    let head_ = 0;
    const SPARK = 1, GOO = 3, FIRE = 4, THREAD = 5, HANG = 6;
    function spawn(kind, x, y, z, vx, vy, vz, life, size, c, aux = 0) {
      let i = -1; for (let k = 0; k < 40; k++) { const j = (head_ + k) % N; if (!KIND[j]) { i = j; break; } } if (i < 0) i = head_; head_ = (i + 1) % N;
      KIND[i] = kind; PX[i] = x; PY[i] = y; PZ[i] = z; VX[i] = vx; VY[i] = vy; VZ[i] = vz; AGE[i] = 0; LIFE[i] = life; SZ[i] = size; CR[i] = c[0]; CG[i] = c[1]; CB[i] = c[2]; AUX[i] = aux; return i;
    }
    function burst(p, n, speed, c, { size = 1, life = 0.7, up = 0.25, white = 0.5 } = {}) {
      for (let j = 0; j < n; j++) { const th = rnd() * 6.2832, u = rnd() * 2 - 1, q = Math.sqrt(1 - u * u), v = speed * (0.35 + 0.9 * rnd() * rnd() * 1.6); spawn(SPARK, p[0], p[1], p[2], Math.cos(th) * q * v, Math.sin(th) * q * v + up * speed, u * v * 0.4, life * (0.5 + 0.8 * rnd()), size * (0.6 + 0.9 * rnd()), lerp3(c, WHITE, white * rnd())); }
    }
    // ---------------------------------------------------------------- text as points (the comment; the ending's line)
    function textPoints(lines, maxPts) {
      const doc = root.document; if (!doc && !root.OffscreenCanvas) return null;
      const CW = 1024, CH = 384, c = root.OffscreenCanvas ? new root.OffscreenCanvas(CW, CH) : Object.assign(doc.createElement('canvas'), { width: CW, height: CH }), x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#000'; x.fillRect(0, 0, CW, CH); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
      for (const l of lines) { let size = l.size; x.font = '700 ' + size + 'px Bahnschrift, "Segoe UI", Arial, sans-serif'; const w = x.measureText(l.text).width; if (w > CW - 30) { size = Math.floor(size * (CW - 30) / w); x.font = '700 ' + size + 'px Bahnschrift, "Segoe UI", Arial, sans-serif'; } x.fillText(l.text, CW / 2, l.y); }
      const d = x.getImageData(0, 0, CW, CH).data, pts = [];
      for (let py = 1; py < CH; py += 2) for (let px = (py >> 1) % 2; px < CW; px += 2) if (d[(py * CW + px) * 4] > 120) pts.push((px - CW / 2) / (CW / 2), (CH / 2 - py) / (CW / 2), d[(py * CW + px) * 4] / 255);
      let n = pts.length / 3, step = Math.max(1, n / maxPts), out = new Float32Array(Math.min(n, maxPts) * 3), k = 0;
      for (let f = 0; Math.floor(f) < n && k < out.length / 3; f += step) { const i = Math.floor(f) * 3; out[k * 3] = pts[i]; out[k * 3 + 1] = pts[i + 1]; out[k * 3 + 2] = pts[i + 2]; k++; }
      return out.subarray(0, k * 3);
    }

    // ---------------------------------------------------------------- the hand puppets' point sets (built once)
    // A puppet is a CHARACTER made the way the Mask is: a head of points with normals (so it is lit: a key light, a shade,
    // a rim), features drawn as lines of light (lids, brows, lips), and a muppet mouth: the whole lower head is a jaw on a
    // hinge, the inside glows. Local space: the head's radius is 1, +x picture right, +y up, +z toward the lens.
    // A point: x y z | nx ny nz | part | brightness | size | u | random | spare      (12 numbers)
    // parts: 0 upper head, 1 jaw, 2 upper lip line, 3 lower lip line, 4 eye fill, 5 iris, 6 lid line, 7 brow, 8 sleeve, 9 halo,
    //        10 wing, 11 horn, 12 tail, 13 pitchfork, 14 blush / nose, 15 upper teeth, 16 lower teeth, 17 palate, 18 tongue
    let PUP = null;
    const PST = 12, HINGE = [-0.30, -0.45];
    function buildPuppets() {
      let s0 = 4242; const r = () => { s0 = (s0 * 1664525 + 1013904223) >>> 0; return s0 / 4294967296; };
      const make = (devil) => {
        const p = []; let n = 0;
        const add = (x, y, z, nx, ny, nz, part, br, sz, u = 0) => { p.push(x, y, z, nx, ny, nz, part, br, sz, u, r(), 0); n++; };
        const mY = (x) => (devil ? -0.36 + 0.17 * x * x + 0.05 * x : -0.34 + 0.13 * x * x);            // the line of the mouth: a sly grin / a smile
        const shape = (dx, dy, dz) => { let x = dx, y = dy * 0.95; const z = dz * 0.90; if (devil && dy < 0) { x *= 1 - 0.36 * dy * dy; y *= 1.12; } else if (!devil && dy < 0) x *= 1 + 0.07 * Math.sin(Math.PI * -dy); return [x, y, z]; };
        const front = (x, y) => Math.sqrt(Math.max(0.02, 1 - x * x - (y / 0.95) * (y / 0.95))) * 0.90;
        for (let i = 0; i < 3400; i++) {
          const th = r() * 6.2832, uu = r() * 2 - 1, q = Math.sqrt(1 - uu * uu), dx = q * Math.cos(th), dy = uu, dz = q * Math.sin(th); if (dz < -0.45) continue;
          const [x, y, z] = shape(dx, dy, dz), up = y >= mY(x); if (Math.abs(y - mY(x)) < 0.02 && dz > 0) continue;
          add(x, y, z, dx, dy, dz, up ? 0 : 1, 1, 0.85 + 0.5 * r());
        }
        for (let i = 0; i < 520; i++) { const x = (r() * 2 - 1) * 0.84, y = mY(x), z = front(x, y), up = i % 2 === 0; add(x, y + (up ? 0.022 : -0.022) + (r() - 0.5) * 0.02, z + 0.01, 0, 0, 1, up ? 2 : 3, 1, 1.15 + 0.3 * r()); }
        for (let i = 0; i < 760; i++) {      // the inside of the mouth: a roof and a floor, with a tongue on the floor
          const a = r() * 6.2832, q = Math.sqrt(r()), x = q * Math.cos(a) * 0.80, z = q * Math.sin(a) * 0.74; if (z < -0.42) continue; const roof = i % 2 === 0, tongue = !roof && x * x / 0.20 + (z - 0.28) * (z - 0.28) / 0.16 < 1;
          add(x, mY(x) + (roof ? 0.02 : -0.02), z, 0, roof ? -1 : 1, 0, roof ? 17 : 18, (tongue ? 1.7 : 0.75) * (0.55 + 0.45 * (z + 0.42) / 1.16), 1.1 + 0.3 * r(), tongue ? 1 : 0);
        }
        if (devil) for (let k = 0; k < 16; k++) {      // teeth: nine above (the two outer ones are fangs), seven below
          const up = k < 9, m = up ? 9 : 7, j = up ? k : k - 9, x0 = (j - (m - 1) / 2) * (up ? 0.145 : 0.150), fang = up && (j === 1 || j === 7), h = fang ? 0.24 : up ? 0.13 : 0.10;
          for (let i = 0; i < (fang ? 34 : 20); i++) { const b = r(), a = (r() - 0.5) * 0.11 * (1 - b); add(x0 + a, mY(x0) + (up ? -1 : 1) * (0.02 + b * h), front(x0, mY(x0)) - 0.03, 0, 0, 1, up ? 15 : 16, 1.25 - 0.3 * b, 1.0 + 0.25 * r()); }
        }
        // eyes: kept as places inside the eye (nx, ny), so they can blink, narrow, widen and look. u = which side.
        for (const sd of [-1, 1]) {
          for (let i = 0; i < 150; i++) { const a = r() * 6.2832, q = Math.sqrt(r()); add(0, 0, 0, q * Math.cos(a), q * Math.sin(a), 0, 4, 0.55 + 0.3 * q, 1.0, sd); }
          for (let i = 0; i < 150; i++) { const a = r() * 6.2832, top = Math.sin(a) > 0; add(0, 0, 0, Math.cos(a) * (1.02 + (r() - 0.5) * 0.05), Math.sin(a) * (1.02 + (r() - 0.5) * 0.05), 0, 6, top ? 1.5 : 0.9, top ? 1.3 : 1.0, sd); }
          for (let i = 0; i < 130; i++) { const a = r() * 6.2832, q = (devil ? 0.16 : 0.10) + (devil ? 0.34 : 0.50) * Math.sqrt(r()); add(0, 0, 0, q * Math.cos(a), q * Math.sin(a), 1, 5, 1.2 + 0.8 * (q - 0.16) / 0.34, 1.05, sd); }
          for (let i = 0; i < 8; i++) add(0, 0, 0, -0.22 + (r() - 0.5) * 0.1, 0.24 + (r() - 0.5) * 0.1, 2, 5, 3.0, 1.2, sd);      // the catch-light
          for (let i = 0; i < 80; i++) { const t = r() * 2 - 1, x = sd * 0.38 + t * 0.25, y = devil ? 0.50 + 0.13 * t * sd + (r() - 0.5) * 0.045 : 0.56 + 0.06 * (1 - t * t) + (r() - 0.5) * 0.04; add(x, y, front(x, y) + 0.02, 0, 0.3, 0.95, 7, 1.35, 1.2 - 0.3 * Math.abs(t), sd); }
          if (!devil) for (let i = 0; i < 70; i++) { const a = r() * 6.2832, q = Math.sqrt(r()) * 0.17, x = sd * 0.58 + q * Math.cos(a), y = -0.10 + q * Math.sin(a) * 0.7; add(x, y, front(x, y) + 0.01, 0, 0, 1, 14, 0.9 * (1 - q / 0.17) + 0.2, 1.5, 1); }
        }
        for (let i = 0; i < 36; i++) { const a = r() * 6.2832, q = Math.sqrt(r()) * 0.10; add(q * Math.cos(a), -0.02 + q * Math.sin(a) * 0.8, front(0, 0) + 0.05, 0, 0, 1, 14, 0.8, 1.1, 0); }
        for (let i = 0; i < 520; i++) { const v = r(), a = r() * Math.PI, rad = 0.66 - 0.16 * v; add(Math.cos(a) * rad, -0.80 - v * 1.25, Math.sin(a) * rad * 0.8 - 0.1, Math.cos(a), 0, Math.sin(a), 8, 1 - 0.85 * v, 0.9 + 0.4 * r(), v); }
        if (!devil) {
          for (let i = 0; i < 420; i++) { const a = r() * 6.2832, rr = 0.60 + (i % 3) * 0.035; add(Math.cos(a) * rr, 1.43 + Math.sin(a) * rr * 0.30, Math.sin(a) * rr * 0.5, 0, 0, 1, 9, 1, 1.25); }
          // wings, the way they are drawn on every angel: an arm that arches up and out from the shoulder, and feathers
          // hanging from it, short by the body and long at the tip (two rows: the long ones and a row of short covers)
          for (const sd of [-1, 1]) for (let row = 0; row < 2; row++) for (let f = 0; f < 9; f++) for (let i = 0; i < (row ? 40 : 64); i++) {
            const q = (f + 0.5) / 9, ax = 0.62 + 0.80 * q, ay = 0.10 + 1.05 * Math.sin(q * 1.9) * (1 - 0.22 * q), ang = -1.50 + 0.72 * q, len = (row ? 0.32 : 0.50 + 0.40 * q), b = Math.pow(r(), 0.8), v = r() * 2 - 1, wd = 0.085 * Math.pow(Math.sin(Math.PI * Math.min(1, b * 1.03)), 0.5) + 0.01, al = b * len;
            add(sd * (ax + Math.cos(ang) * al - Math.sin(ang) * v * wd), ay + Math.sin(ang) * al + Math.cos(ang) * v * wd, -0.45 - 0.04 * row, 0, 0, 1, 10, (row ? 1.15 : 0.55 + 0.45 * b + 0.5 * v * v), 1.0 + 0.3 * r(), sd * (0.20 + 0.80 * q));
          }
          for (const sd of [-1, 1]) for (let i = 0; i < 150; i++) { const q = r(), ax = 0.62 + 0.80 * q, ay = 0.10 + 1.05 * Math.sin(q * 1.9) * (1 - 0.22 * q); add(sd * (ax + (r() - 0.5) * 0.03), ay + 0.02 + (r() - 0.5) * 0.04, -0.45, 0, 0, 1, 10, 1.5, 1.25, sd * (0.20 + 0.80 * q)); }      // the arm: the wing's bright upper edge
        } else {
          for (const sd of [-1, 1]) for (let i = 0; i < 300; i++) { const u = Math.pow(r(), 0.8), a = r() * 6.2832, rad = 0.21 * Math.pow(1 - u, 0.75) + 0.012; add(sd * (0.46 + 0.36 * u + 0.12 * u * u) + Math.cos(a) * rad, 0.74 + 1.02 * u - 0.14 * u * u + Math.sin(a) * rad * 0.45, 0.05 - 0.2 * u + Math.sin(a) * rad, Math.cos(a), 0.2, Math.sin(a), 11, (0.7 + 0.3 * Math.sin(u * 30)) * (0.7 + 1.6 * u * u), 1.0 + 0.3 * u, u); }
          for (let i = 0; i < 300; i++) { const u = i / 299; add(0.62 + 0.62 * u + 0.10 * Math.sin(u * 6.2832) + (r() - 0.5) * 0.035, -1.02 + 1.20 * u * u + 0.16 * Math.sin(u * 6.2832 + 1) + (r() - 0.5) * 0.035, -0.3, 0, 0, 1, 12, 0.8 + 0.5 * u, 1.25 - 0.4 * u, u); }
          for (let i = 0; i < 150; i++) { const b = r(), a = (r() * 2 - 1) * 0.20 * (1 - b) * (b < 0.25 ? b / 0.25 * 0.6 + 0.4 : 1), ca = Math.cos(0.5), sa = Math.sin(0.5), lx = a, ly = -0.06 + b * 0.36; add(1.30 + lx * ca + ly * sa, 0.22 - lx * sa + ly * ca, -0.3, 0, 0, 1, 12, 1.5, 1.2, 1); }      // its arrow tip
          for (let i = 0; i < 230; i++) {      // a little pitchfork on the other side
            const k = i % 5, t = r(); let x = -1.24, y;
            if (k < 2) y = -1.05 + t * 1.70; else if (k === 2) { x += (t - 0.5) * 0.44; y = 0.66; } else { const pr = (i % 3) - 1; x += pr * 0.21; y = 0.66 + t * (pr === 0 ? 0.52 : 0.42); }
            add(x + (r() - 0.5) * 0.03, y, -0.25, 0, 0, 1, 13, k < 2 ? 0.8 : 1.4, 1.15, y);
          }
        }
        return { n, d: new Float32Array(p) };
      };
      return { angel: make(false), devil: make(true) };
    }

    // ---------------------------------------------------------------- GL
    let GLS = null;
    const MAXP = 36000, ptData = new Float32Array(MAXP * 7), MAXS = 6000, spData = new Float32Array(MAXS * 7);
    let nP = 0, nS = 0;
    const put = (x, y, z, r, g, b, sz) => { if (nP >= MAXP) return; const o = nP * 7; ptData[o] = x; ptData[o + 1] = y; ptData[o + 2] = z; ptData[o + 3] = r; ptData[o + 4] = g; ptData[o + 5] = b; ptData[o + 6] = sz; nP++; };
    /** a blob in the field: size = world diameter, goo / fire = how much, tint = 0 the goo's colour .. 1 the molten one */
    const splat = (x, y, z, size, goo, fire, tint = 0) => { if (nS >= MAXS) return; const o = nS * 7; spData[o] = x; spData[o + 1] = y; spData[o + 2] = z; spData[o + 3] = size; spData[o + 4] = goo; spData[o + 5] = fire; spData[o + 6] = tint; nS++; };
    function glInit(G) {
      const gl = G.gl, pPts = G.program(PTS_VS, PTS_FS), pSpl = G.program(SPL_VS, SPL_FS), pComp = G.program(G.FS_TRI, COMP_FS);
      const ptBuf = G.buffer(ptData, true), spBuf = G.buffer(spData, true);
      const ptVao = gl.createVertexArray(); gl.bindVertexArray(ptVao); G.attrib(pPts, 'aPos', ptBuf, 3, { stride: 28, offset: 0 }); G.attrib(pPts, 'aCol', ptBuf, 4, { stride: 28, offset: 12 });
      const spVao = gl.createVertexArray(); gl.bindVertexArray(spVao); G.attrib(pSpl, 'aPos', spBuf, 3, { stride: 28, offset: 0 }); G.attrib(pSpl, 'aW', spBuf, 4, { stride: 28, offset: 12 });
      gl.bindVertexArray(null);
      const field = G.target(G.W >> 1, G.H >> 1);
      return { G, gl, pPts, pSpl, pComp, ptBuf, spBuf, ptVao, spVao, field };
    }

    const HUD = { missiles: [], strikes: [], cover: null, vbox: null, pops: [], anchors: {} };
    function render(c) {
      const { G, gl, vp, model: mdl, sc, ps, core, time: t, audio: A } = c;
      if (!GLS || GLS.G !== G) GLS = glInit(G);
      const dt = st.rT === undefined ? 1 / 30 : clamp(t - st.rT, 0, 0.1); st.rT = t;
      const L = st.L, B = st.boss, fire = st.fire || GOLD, heat = L.heat, VIEW = c.VIEW, fk = st.faceK === undefined ? 1 : st.faceK;      // fk: 1 = his face is there, 0 = the Visualizer (no head: nothing head-shaped)
      const tw = (p) => [mdl[0] * p[0] + mdl[4] * p[1] + mdl[8] * p[2] + mdl[12], mdl[1] * p[0] + mdl[5] * p[1] + mdl[9] * p[2] + mdl[13], mdl[2] * p[0] + mdl[6] * p[1] + mdl[10] * p[2] + mdl[14]];
      const scr = (p) => { const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; return [((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w * 0.5 + 0.5) * G.W, (0.5 - (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w * 0.5) * G.H, G.H * 0.5 * c.proj[5] * ps / w]; };      // [x px, y px, px per world unit]
      nP = 0; nS = 0;
      const eyes = core.eyes.map((e) => ({ p: tw(e.c), open: e.open, gaze: e.gaze })), ring = core.mouth.ring, NR = ring.length / 3;
      let mcx = 0, mcy = 0, mcz = 0; for (let k = 0; k < NR; k++) { mcx += ring[k * 3] / NR; mcy += ring[k * 3 + 1] / NR; mcz += ring[k * 3 + 2] / NR; }
      const mouthH = [mcx, mcy, mcz], mouth = tw([mcx, mcy, mcz + 0.05]), mOpen = core.mouth.open, chin = tw([0, -1.72 - 0.62 * L.jaw, 0.30]), faceC = tw([0, -0.42, 0.2]);
      const hh = VIEW.halfH, hw = hh * G.W / G.H, floorY = VIEW.targetY - hh / ps - c.poy * hh / ps;
      const beat = A.beat || 0, bass = A.bass || 0;
      const mv = st.moves;
      // ---- V9 HYPE: the new styles' own layers (behind the face, round it, in orbit), before the stage's light
      if (HY && HY.state.failed && st.hypeStyle !== 'classic') st.hypeStyle = 'classic';      // (the looks could not be made on this card: the stage's own ladder from here on)
      if (HY) HY.render(c, { fire, own: st.own || null, burst, spark: (w, v, life, size, col) => spawn(SPARK, w[0], w[1], w[2], v[0], v[1], v[2], life, size, col, 1) });

      // ---- embers (hype): they rise through the frame, more and brighter with each rank
      if (L.embers > 0.02) {
        const n = Math.round(30 + 110 * L.embers);
        for (let i = 0; i < n; i++) {
          const a = h1(i * 1.37), b = h1(i * 2.91 + 5), d = h1(i * 4.3 + 9), v = 0.35 + 0.8 * b, yy = ((t * v + a * 5.6) % 5.6), x = (a * 2 - 1) * 1.6 + 0.12 * Math.sin(t * (0.8 + b) + i), f = Math.sin(Math.PI * yy / 5.6);
          const tw2 = 0.55 + 0.45 * Math.sin(t * (5 + 9 * d) + i * 3.3), br = (2.6 + 5.5 * d * d) * f * tw2 * (0.5 + 0.7 * L.embers) * (0.7 + 0.6 * heat);
          put(x, VIEW.targetY - 2.9 + yy, -0.6 + 2.2 * d, fire[0] * br + 0.25 * br * d, fire[1] * br + 0.2 * br * d, fire[2] * br, 0.8 + 1.5 * d);
          if (d > 0.6) put(x, VIEW.targetY - 2.9 + yy, -0.6 + 2.2 * d, fire[0] * br * 0.25, fire[1] * br * 0.25, fire[2] * br * 0.25, 5 * d);
        }
      }
      // ---- the low ranks (Warming Up, Heating Up) must be SEEN on a loud section too: a rim of heat round the whole head
      // that breathes with the beat, and heat-shimmer wisps that climb off it (Heating Up also has small flames: the crown)
      if (L.halo * fk > 0.02 && L.gone < 0.5) {
        const q = L.halo * fk * (0.75 + 0.45 * beat + 0.25 * heat), NH = 300;
        for (let i = 0; i < NH; i++) {
          const a = i / NH * 6.2832, wob = 1.06 + 0.035 * Math.sin(a * 5 + t * 2.4) + 0.05 * beat, w = tw([1.10 * wob * Math.sin(a), -0.42 + 1.50 * wob * Math.cos(a), -0.1]);
          const tw2 = 0.7 + 0.3 * Math.sin(t * 3.1 + i * 0.37), br = 1.5 * q * tw2;
          put(w[0], w[1], w[2], fire[0] * br, fire[1] * br, fire[2] * br, 1.7); if (i % 6 === 0) put(w[0], w[1], w[2], fire[0] * br * 0.30, fire[1] * br * 0.30, fire[2] * br * 0.30, 11);
        }
        const nw = L.halo * fk * 1.4; for (let j = 0; j < Math.floor(nw) + (rnd() < nw % 1 ? 1 : 0); j++) { const a = (rnd() * 2 - 1) * 1.5, w = tw([1.14 * Math.sin(a), -0.42 + 1.56 * Math.cos(a), 0]); spawn(SPARK, w[0], w[1], w[2], (rnd() - 0.5) * 0.4, 1.0 + 1.6 * rnd(), 0, 0.9 + 0.8 * rnd(), 0.9, lerp3(fire, WHITE, 0.3), 1); }
      }
      // ---- hot eyes / suns for eyes
      for (const e of eyes) {
        const k = Math.max(L.eyeHot * 0.9, L.eyes, L.demon) * (1 - L.cosmic) * (0.25 + 0.75 * ss(0.05, 0.3, e.open)) * (1 - L.gone) * fk, p = e.p;
        if (k > 0.02) { const b2 = k * (0.8 + 0.4 * beat); put(p[0], p[1], p[2] + 0.3, fire[0] * 2.6 * b2, fire[1] * 2.6 * b2, fire[2] * 2.6 * b2, 30 * sc); put(p[0], p[1], p[2] + 0.3, 9 * b2, 6.0 * b2, 3.4 * b2, 9 * sc); if (rnd() < 0.45 * k) spawn(SPARK, p[0] + (rnd() - 0.5) * 0.2, p[1] + 0.05, p[2] + 0.3, (rnd() - 0.5) * 0.5, 0.9 + 1.2 * rnd(), 0, 0.7 + 0.5 * rnd(), 0.7, lerp3(fire, WHITE, 0.3), 1); }
        if (L.cosmic * fk > 0.02) {
          const q = L.cosmic * (1 - L.gone) * fk, b2 = q * (0.85 + 0.3 * beat + 0.2 * bass);
          put(p[0], p[1], p[2] + 0.3, fire[0] * 1.5 * b2, fire[1] * 1.5 * b2, fire[2] * 1.5 * b2, 44 * sc); put(p[0], p[1], p[2] + 0.3, fire[0] * 5 * b2 + 2 * b2, fire[1] * 5 * b2 + 1.6 * b2, fire[2] * 5 * b2 + b2, 21 * sc); put(p[0], p[1], p[2] + 0.3, 26 * b2, 24 * b2, 20 * b2, 12.5 * sc);
          for (let j = 0; j < 12; j++) { const a = j / 12 * 6.2832 + t * 0.35, len = (0.34 + 0.10 * Math.sin(t * 3 + j * 2.1) + 0.14 * beat) * (j % 2 ? 0.55 : 1) * sc; for (let m = 1; m <= 12; m++) { const f = m / 12, br = (1 - f) * (1 - f) * 7 * b2; put(p[0] + Math.cos(a) * (0.20 * sc + len * f), p[1] + Math.sin(a) * (0.20 * sc + len * f), p[2] + 0.3, br, br * 0.84, br * 0.50, 2.6 - 1.8 * f); } }
        }
      }
      // ---- MYTHIC: a ring of stars round the head, two worlds on it, the aura; the flare of a "+1"
      if (L.cosmic * fk > 0.02) {
        const q = L.cosmic * (1 - L.gone) * fk, tilt = 1.25, c0 = [0, -0.22, 0], Rr = 1.62;
        for (let i = 0; i < 300; i++) {
          const a = h1(i * 3.3) * 6.2832 + t * (0.22 + 0.05 * h1(i)), rr = Rr * (0.93 + 0.16 * h1(i * 7.1)), x = Math.cos(a) * rr, z0 = Math.sin(a) * rr, y = z0 * Math.cos(tilt) * 0.42 + 0.30 * x * 0.25, z = z0 * Math.sin(tilt);
          if (z < 0 && (x / 1.0) * (x / 1.0) + (y / 1.45) * (y / 1.45) < 1) continue;
          const d = h1(i * 9.7), br = (1.4 + 4.6 * d * d) * q * (0.6 + 0.4 * Math.sin(t * (2 + 5 * d) + i)) * (z < 0 ? 0.45 : 1), w = tw([c0[0] + x, c0[1] + y, c0[2] + z]);
          put(w[0], w[1], w[2], br * lerp(fire[0], 1, d), br * lerp(fire[1], 0.95, d), br * lerp(fire[2], 0.85, d), 0.9 + 1.3 * d);
        }
        for (let pI = 0; pI < 2; pI++) { const a = t * (0.5 + 0.2 * pI) + pI * 3.4, x = Math.cos(a) * Rr, z0 = Math.sin(a) * Rr, y = z0 * Math.cos(tilt) * 0.42 + 0.075 * x, z = z0 * Math.sin(tilt); if (z < 0 && x * x + (y / 1.45) * (y / 1.45) < 1) continue; const w = tw([x, -0.40 + y, z]); put(w[0], w[1], w[2], 9 * q, (pI ? 7.5 : 5) * q, (pI ? 5.5 : 1.6) * q, 2.0); put(w[0], w[1], w[2], fire[0] * 1.6 * q, fire[1] * 1.6 * q, fire[2] * 1.6 * q, 7); }
        for (let i = 0; i < 110; i++) { const a = h1(i * 5.1 + 1) * 6.2832, rr = 1.35 + 1.5 * h1(i * 2.3 + 2), d = h1(i * 8.9 + 3), br = (0.5 + 2.4 * d * d * d) * q * (0.5 + 0.5 * Math.sin(t * (1 + 4 * d) + i * 1.7)); put(faceC[0] + Math.cos(a) * rr * 0.92, faceC[1] + Math.sin(a) * rr * 1.25, -1.0 + 1.5 * d, br, br * 0.93, br * 0.8, 0.5 + 0.9 * d * d); }
      }
      const plusAge = t - st.hype.plusAt;
      if (plusAge < 1.4) { const rr = 0.9 + plusAge * 3.4, f = Math.exp(-plusAge * 2.4); for (let i = 0; i < 180; i++) { const a = i / 180 * 6.2832, j = h1(i * 3.1); put(faceC[0] + Math.cos(a) * rr * (1 + 0.03 * j), faceC[1] + Math.sin(a) * rr * (1 + 0.03 * j), 0.2, 6 * f, 5 * f, 3.4 * f, 1.2 + 1.2 * f); } if (plusAge < dt * 1.5) burst(faceC, 150, 4.2, lerp3(fire, WHITE, 0.3), { size: 1.2, life: 1.1, white: 0.7 }); }

      // ---- FIRE: the emitters feed the field (crown, eyes, mouth, the frame's edges, the cracks)
      const hotMul = 0.75 + 0.65 * heat + 0.35 * beat;
      if (L.eyeHot > 0.3 && L.gone < 0.5 && fk > 0.5 && rnd() < 0.55 * L.eyeHot) { const a = (rnd() * 2 - 1) * 1.1, w = tw([1.02 * Math.sin(a), -0.42 + 1.42 * Math.cos(a), 0]); spawn(SPARK, w[0], w[1], w[2], (rnd() - 0.5) * 0.6, 1.2 + 1.8 * rnd(), 0, 0.9 + 0.7 * rnd(), 0.8, lerp3(fire, WHITE, 0.35), 1); }
      const fireAt = (p, vx, vy, size, life, amt) => spawn(FIRE, p[0], p[1], p[2], vx, vy, 0, life, size, fire, amt);
      const alive = 1 - L.gone, onFace = alive * fk;      // onFace: what burns ON the face (crown, eye flames, the mouth's fire, the cracks) goes with it
      if (L.crown * onFace > 0.02) {
        // tongues, not a band: nine sites along the top of the face, each a stream that breathes on its own; LEGENDARY
        // makes every second one tall: a crown of five flames
        const K = 9;
        for (let k = 0; k < K; k++) {
          const a = -1.12 + 2.24 * (k + 0.5) / K + 0.06 * Math.sin(t * 1.3 + k * 2.1), hx = 1.02 * Math.sin(a), hy = -0.42 + 1.42 * Math.cos(a);
          let pk = 0.55 + 0.45 * Math.sin(t * 2.1 + k * 1.9); if (L.gold > 0.3) pk = lerp(pk, k % 2 === 0 ? 1.0 : 0.22, L.gold);
          const thin = st.thin ? 1 : 0, flick = thin ? 0.55 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(t * (6.1 + 0.9 * k) + k * 3.7), 2) : 1;      // (fix round V-6: under the FIRE verdict the crown is thin, tall, flickering tongues)
          const rate = (0.9 + 1.3 * L.crown) * hotMul * (0.5 + 0.5 * pk) * (thin ? 2.4 * flick : 1), n = Math.floor(rate) + (rnd() < rate % 1 ? 1 : 0);
          for (let j = 0; j < n; j++) {
            const w = tw([hx * 0.97 + (rnd() - 0.5) * 0.07, hy - 0.08 + (rnd() - 0.5) * 0.05, -0.05]), up = (2.3 + 1.3 * rnd()) * (0.50 + 0.70 * L.crown) * hotMul * (0.40 + 0.80 * pk);
            if (thin) fireAt([w[0] * 1 + (rnd() - 0.5) * 0.02, w[1], w[2]], Math.sin(a) * 0.30, up * 1.25 * flick, (0.14 + 0.05 * rnd()) * sc, (0.26 + 0.22 * rnd()) * (0.60 + 0.50 * pk), 0.64);
            else fireAt(w, Math.sin(a) * 0.55 + (rnd() - 0.5) * 0.18, up, (0.30 + 0.08 * rnd()) * sc, (0.32 + 0.22 * rnd()) * (0.60 + 0.50 * pk), 0.56);
          }
        }
        if (rnd() < 0.5 * L.crown) { const a = (rnd() * 2 - 1) * 1.0, w = tw([1.02 * Math.sin(a), -0.42 + 1.42 * Math.cos(a), 0]); spawn(SPARK, w[0], w[1], w[2], (rnd() - 0.5) * 0.8, 1.6 + 2 * rnd(), 0, 0.8 + 0.6 * rnd(), 0.8, lerp3(fire, WHITE, 0.4), 1); }
      }
      if (L.eyes * onFace > 0.02) for (let ei = 0; ei < 2; ei++) { const e = eyes[ei], side = ei === 0 ? -1 : 1, n = Math.round(5.6 * L.eyes * hotMul + rnd()); for (let j = 0; j < n; j++) fireAt([e.p[0] + side * 0.14 * sc + (rnd() - 0.5) * 0.08, e.p[1] + 0.02 + (rnd() - 0.5) * 0.05, e.p[2] + 0.3], side * (2.0 + 1.0 * rnd()) * L.eyes, (2.7 + 1.3 * rnd()) * hotMul, (0.33 + 0.09 * rnd()) * sc, 0.42 + 0.24 * rnd(), 0.58); }      // (phase 2: the eye flames stand up next to the crown)
      if (L.mouthFire * onFace > 0.02 && mOpen > 0.10) { const jet = st.score && st.score.kind === 'fire' && t - st.score.t0 < 3.9 ? 1 : 0, k = L.mouthFire * ss(0.10, 0.5, mOpen), n = Math.round((6 + 8 * jet) * k * hotMul + rnd()); for (let j = 0; j < n; j++) fireAt([mouth[0] + (rnd() - 0.5) * 0.30 * sc, mouth[1] + (rnd() - 0.5) * 0.10, mouth[2] + 0.3], (rnd() - 0.5) * (1.4 + 3.4 * jet), jet ? (4.2 + 3.6 * rnd()) : (1.3 + 1.9 * rnd()) * hotMul, (0.20 + 0.13 * rnd() + 0.10 * jet) * sc, 0.30 + 0.30 * rnd() + 0.15 * jet, 0.70); }
      if (L.bgFire > 0.02) for (let k = 0; k < 8; k++) { const side = k < 4 ? -1 : 1, q = k % 4, rate = 0.75 * L.bgFire * hotMul * (0.6 + 0.4 * Math.sin(t * 1.7 + k * 2.3)); if (rnd() < rate) fireAt([side * (hw / ps + 0.04) - c.pox * hw / ps + (rnd() - 0.5) * 0.06, floorY + 0.15 + q * 0.85 + (rnd() - 0.5) * 0.08, -0.5], -side * (0.25 + 0.35 * rnd()), (2.4 + 1.8 * rnd()) * hotMul, 0.38 + 0.12 * rnd(), 0.36 + 0.30 * rnd(), 0.72); }
      if (L.crack * onFace > 0.3 && rnd() < L.crack * 1.2) { const a = rnd() * 6.2832, q = Math.sqrt(rnd()) * 0.85 * L.crack, w = tw([Math.cos(a) * q * 0.85, -0.45 + Math.sin(a) * q * 1.2, 0.35]); fireAt(w, (rnd() - 0.5) * 0.6, (0.8 + 1.2 * rnd()) * hotMul, (0.18 + 0.12 * rnd()) * sc, 0.30 + 0.25 * rnd(), 0.5); if (rnd() < 0.3) spawn(SPARK, w[0], w[1], w[2] + 0.2, (rnd() - 0.5) * 1.6, 1.0 + 1.8 * rnd(), 0, 0.7, 0.7, lerp3(fire, WHITE, 0.3), 1); }
      if (mv.crack.on && t - mv.crack.t0 < dt * 1.5) { burst(faceC, 60, 3.0, lerp3(fire, WHITE, 0.4), { size: 0.9 }); st.kickV = 0.5; }

      // ---- GOO: it pours from the mouth, hangs from the chin, strings, pools at the bottom
      const gooA = st.gooA || TOXIC;
      if (st.gooOn && mOpen > 0.2 && alive > 0.5) {
        const wdt = 0.26 * sc * (0.6 + 0.5 * mOpen);
        for (let j = 0; j < 4; j++) spawn(GOO, mouth[0] + (rnd() - 0.5) * wdt, mouth[1] - 0.05 * sc - rnd() * 0.05, mouth[2] + 0.35, (rnd() - 0.5) * 0.30, -(0.5 + 0.9 * rnd()), 0, 3.0, (0.25 + 0.16 * rnd()) * sc, gooA, 0);
        if (rnd() < 0.22 && fk > 0.5) spawn(HANG, chin[0] + (rnd() - 0.5) * 0.55 * sc, chin[1] + 0.05, chin[2] + 0.2, 0, 0, 0, 3.4, (0.15 + 0.10 * rnd()) * sc, gooA, 0.35 + 0.7 * rnd());
        st.pool = Math.min(1, st.pool + dt * 0.30);
      } else st.pool = Math.max(0, st.pool - dt * 0.20);
      if (mv.melt.on) {      // the melt: the face runs down into a molten pool, drips fall from it
        const u = t - mv.melt.t0, m = L.melt;
        if (u < 2.55 && fk > 0.5) { if (rnd() < 0.6 * m) { const x = (rnd() * 2 - 1) * 0.85, w = tw([x, Math.max(MELT_FLOOR + 0.2, -1.8 - Math.pow(m, 1.25) * (0.95 + 1.9 * meltRun(x))), 0.2]); const id = spawn(HANG, w[0], w[1], w[2] + 0.2, 0, 0, 0, 2.6, (0.12 + 0.10 * rnd()) * sc, fire, 0.25 + 0.5 * rnd()); AUX[id] = -AUX[id]; } for (let j = 0; j < 9; j++) { const x = ((j + 0.5) / 9 * 2 - 1) * 0.95 * (0.5 + 0.5 * m), w = tw([x * 1.25, MELT_FLOOR - 0.02 + 0.03 * Math.sin(t * 3 + j), 0.2]); splat(w[0], w[1], w[2] + 0.2, (0.30 + 0.10 * Math.sin(j * 2.1 + t * 2)) * sc * ss(0.25, 1, m), 1.0 * ss(0.3, 0.9, m), 0, 1); } }
        if (u >= 2.55 && u < 2.55 + dt * 1.5) { burst(tw([0, -1.3, 0.3]), 110, 3.6, lerp3(fire, WHITE, 0.3), { size: 1.0, up: 0.6 }); st.kickV = 0.7; }
      }
      // ---- step the particles
      // the pool's surface rises to the line TikTok's own interface starts at (y 1436 of 1920), and is solid below it
      const safeLift = 0.504 * hh / ps, poolTop = floorY - 0.30 + (0.40 + safeLift) * ss(0, 1, st.pool);
      for (let i = 0; i < N; i++) {
        const k = KIND[i]; if (!k) continue;
        AGE[i] += dt; const a = AGE[i], f = 1 - a / LIFE[i]; if (f <= 0) { KIND[i] = 0; continue; }
        if (k === SPARK) {
          const drag = Math.exp(-dt * 2.2); VX[i] *= drag; VY[i] = VY[i] * drag - (AUX[i] ? -0.6 : 3.2) * dt; VZ[i] *= drag; PX[i] += VX[i] * dt; PY[i] += VY[i] * dt; PZ[i] += VZ[i] * dt;
          const br = 7 * f * f, cool = f < 0.45 ? f / 0.45 : 1; put(PX[i], PY[i], PZ[i], CR[i] * br, CG[i] * br * (0.4 + 0.6 * cool), CB[i] * br * (0.25 + 0.75 * cool), SZ[i] * (0.6 + 0.6 * f));
          if (f > 0.3) put(PX[i] - VX[i] * 0.02, PY[i] - VY[i] * 0.02, PZ[i], CR[i] * br * 0.4, CG[i] * br * 0.3, CB[i] * br * 0.2, SZ[i] * 0.6);
        } else if (k === FIRE) {
          VX[i] += (Math.sin(t * 5 + i * 1.7) * 0.9 - VX[i] * 1.1) * dt; PX[i] += VX[i] * dt; PY[i] += VY[i] * dt; VY[i] *= Math.exp(-dt * 0.9);
          const g = Math.sin(Math.PI * Math.pow(1 - f, 0.55)); void g; splat(PX[i], PY[i], PZ[i], SZ[i] * (0.20 + 0.90 * f), 0, AUX[i] * Math.pow(f, 0.8) * Math.min(1, a * 22) * 1.05, 0);
        } else if (k === GOO) {
          VY[i] -= 6.5 * dt; VX[i] *= Math.exp(-dt * 1.5); PX[i] += VX[i] * dt; PY[i] += VY[i] * dt;
          if (PY[i] < poolTop) { KIND[i] = 0; continue; }
          splat(PX[i], PY[i], PZ[i], SZ[i] * (1 + 0.25 * Math.min(1, a * 3)), 0.95, 0, AUX[i] < 0 ? 1 : 0);
          if (AUX[i] > 0 && a < 0.5 && ((i + Math.floor(t * 60)) % 2) === 0) spawn(THREAD, PX[i], PY[i] + 0.06, PZ[i], 0, 0, 0, 0.55, SZ[i] * 0.62, gooA, 0);
          if (AUX[i] < 0 && a < 0.5 && ((i + Math.floor(t * 60)) % 2) === 0) spawn(THREAD, PX[i], PY[i] + 0.06, PZ[i], 0, 0, 0, 0.55, SZ[i] * 0.62, gooA, -1);
        } else if (k === HANG) {      // a drop that hangs from the chin, swells, then lets go and leaves a string
          const hang = Math.abs(AUX[i]), molten = AUX[i] < 0;
          if (a < hang) { PY[i] -= 0.12 * dt; splat(PX[i], PY[i], PZ[i], SZ[i] * (0.7 + 0.9 * a / hang), 0.95, 0, molten ? 1 : 0); splat(PX[i], PY[i] + 0.10 * sc, PZ[i], SZ[i] * 0.6, 0.9, 0, molten ? 1 : 0); }
          else { KIND[i] = GOO; AGE[i] = 0; LIFE[i] = 3; VY[i] = -0.2; SZ[i] *= 1.5; AUX[i] = molten ? -1 : 1; }
        } else if (k === THREAD) { splat(PX[i], PY[i], PZ[i], SZ[i] * (0.45 + 0.55 * f), 1.1, 0, AUX[i] < 0 ? 1 : 0); }
      }
      if (st.pool > 0.01) { const lvl = ss(0, 1, st.pool), nB = 15, span = hw / ps * 2.3; for (let row = 0; row < 3; row++) for (let j = 0; j < nB; j++) { const x = (j / (nB - 1) - 0.5) * span - c.pox * hw / ps + (row % 2) * span / nB * 0.5, y = poolTop - 0.42 - row * 0.40 + (row ? 0 : 0.035 * Math.sin(t * 2.2 + j * 1.3) * lvl); if (y < floorY - 0.7) continue; splat(x, y, 0.3, 0.62 + 0.10 * Math.sin(j * 1.7 + row), 1.25 * Math.min(1, lvl * 3), 0, 0); } }

      // ---- CRACK OPEN's seal: a line of light that closes
      // ---- EAT A COMMENT: the text flies in under the chin as glowing points, is pulled into the mouth, chomp
      if (mv.eat.on) {
        const m = mv.eat, u = t - m.t0;
        if (!m.pts) m.pts = textPoints([{ text: m.text, size: 150, y: 192 }], 2600) || new Float32Array(0);
        const pts = m.pts, n = pts.length / 3, glide = 1 - Math.pow(1 - clamp(u / 1.25), 3), cx = lerp(hw / ps + 1.6, 0, glide), cy = tw([0, -1.72, 0.3])[1] - 0.40 - 0.03 * Math.sin(u * 3), S2 = Math.min(1.0, hw / ps * 0.76), safeX = (st.mirror ? 0.083 : -0.083) * hw / ps, mirX = st.mirror ? -1 : 1;
        for (let i = 0; i < n; i++) {
          const lx = pts[i * 3], ly = pts[i * 3 + 1], hsh = h1(i * 1.91), su = clamp((u - 1.5 - (lx + 1) * 0.16 - hsh * 0.12) / 0.34), k = su * su;
          if (su >= 1) continue;
          const x0 = cx + lx * S2 * mirX + safeX, y0 = cy + ly * S2 + 0.012 * Math.sin(t * 6 + lx * 9), sw = Math.sin(su * Math.PI) * 0.25;
          const x = lerp(x0, mouth[0], k) + sw * (hsh - 0.5), y = lerp(y0, mouth[1], k) + sw * 0.5, br = (2.6 + 1.2 * beat + 3 * k) * pts[i * 3 + 2];
          put(x, y, 0.6, br, br * lerp(0.93, fire[1] + 0.2, 0.3 + 0.7 * k), br * lerp(0.82, fire[2], 0.3 + 0.7 * k), 0.92 * (1 - 0.6 * k));
        }
        for (const ct of [2.15, 2.5]) if (u >= ct && u < ct + dt * 1.5) { burst([mouth[0], mouth[1], mouth[2] + 0.3], 46, 2.4, lerp3(fire, WHITE, 0.5), { size: 0.8, life: 0.5 }); st.kickV = Math.max(st.kickV, 0.35); }
      }
      // ---- THE EAT (release A): the cover (or a glowing record) flies in and is bitten away at the mouth, on the beat; the
      // Mask chews; his verdict is spat as a word of fire. The 2D layer draws the picture / the record; the light is here.
      HUD.cover = null; HUD.vbox = null;
      const eE = st.eat;
      // FIX ROUND V-5: in the Visualizer there is no face and no mouth: the cover flies into the MIDDLE of the formation and is
      // swallowed there (it shrinks and turns as it goes in, no bite line), and the word is spat from there.
      const mE = fk > 0.999 ? mouth : [lerp(0, mouth[0], fk), lerp(VIEW.targetY, mouth[1], fk), lerp(0.4, mouth[2], fk)], inViz = fk < 0.5;
      if (eE) {
        const T = EAT, u = t - eE.t0, nb = eE.bites.length, lastB = nb ? t - eE.bites[nb - 1] : 0, nrm1 = (q) => mul3(q, 1 / Math.max(q[0], q[1], q[2], 0.05));
        const c1n = eE.c1 ? nrm1(eE.c1) : fire, c2n = eE.c2 ? nrm1(eE.c2) : WHITE, mouth = mE;      // (everything of the eat below happens at mE)
        eE.eatenK = ease(eE.eatenK, nb / T.bites, dt, 26, 26);
        if (!eE.belch && (nb < T.bites || lastB < 0.3)) {
          const k = 1 - Math.pow(1 - clamp(u / T.arrive), 3), size = lerp(1.35, 1.0, k) * sc * (inViz ? 1 - 0.93 * eE.eatenK : 1), slide = inViz ? 0 : eE.eatenK * size;
          const px = lerp(hw / ps + 1.0, mouth[0], k), py = lerp(VIEW.targetY + 2.6, mouth[1] + (inViz ? 0 : size * 0.5 + 0.05), k) - slide, s2 = scr([px, py, 0.6]), ms = scr([mouth[0], mouth[1], 0.6]);
          HUD.cover = { image: eE.image, record: eE.record, x: s2[0], y: s2[1], size: size * s2[2], rot: (1 - k) * 0.5 + 0.03 * Math.sin(u * 5) + (inViz ? 2.6 * eE.eatenK : 0), clipY: ms[1], bite: inViz ? 0 : eE.eatenK, a: nb < T.bites ? 1 : 1 - ss(0.12, 0.3, lastB), spin: u * 4.2, tint: fire };
          if (eE.record && k < 1) put(px, py, 0.5, fire[0] * 1.3, fire[1] * 1.3, fire[2] * 1.3, 36 * sc);      // the record glows as it comes
          if (inViz && eE.eatenK > 0.02) { for (let i = 0; i < 90; i++) { const ph = (t * (1.4 + h1(i * 2.2)) + h1(i * 7.3)) % 1, an = h1(i * 3.9) * 6.2832 + ph * 2.6, rr = 1.5 * sc * (1 - ph) * (0.35 + 0.65 * h1(i * 1.3)), br = 2.8 * ph; put(mouth[0] + Math.cos(an) * rr, mouth[1] + Math.sin(an) * rr, 0.4, br * c1n[0] + 0.3 * br, br * c1n[1] + 0.25 * br, br * c1n[2] + 0.2 * br, 0.8 + 0.8 * (1 - ph)); } }      // the pull of the swallow
        }
        for (const ev of eE.ev) {
          if (ev === 'bite') { const cc = [c1n, c2n, WHITE]; for (let q = 0; q < 3; q++) burst([mouth[0], mouth[1], 0.6], 26, 2.6, cc[q], { size: 1.0, life: 0.6, white: 0.25 }); st.kickV = Math.max(st.kickV, 0.4); }
          else if (ev === 'lastbite') { st.ringAt = t; st.ringCol = c1n; }
          else if (ev === 'munch') { burst([mouth[0], mouth[1], mouth[2] + 0.3], 9, 1.4, c1n, { size: 0.7, life: 0.4, up: 0.3, white: 0.2 }); st.kickV = Math.max(st.kickV, 0.10); }
          else if (ev === 'spit') { burst([mouth[0], mouth[1], mouth[2] + 0.3], 150, 4.4, lerp3(fire, WHITE, 0.4), { size: 1.1, life: 0.9, up: 0.45 }); st.kickV = Math.max(st.kickV, 0.9 * TIER[eE.word].slam); }
          else if (ev === 'gulp') { burst([mouth[0], mouth[1], mouth[2] + 0.3], 28, 1.3, lerp3(fire, WHITE, 0.5), { size: 0.7, life: 0.6, up: 0.9 }); st.kickV = Math.max(st.kickV, 0.4); }
        }
        for (const f of eatFlashes(eE)) flash(t, f.col, f.a);
        if (eE.wordT !== null && t >= eE.wordT) wordDraw(eE, { put, scr, t, dt, c, VIEW, mouth: mE, fire, beat, G, ps });
      }
      if (st.ringAt !== undefined && t - st.ringAt < 1.1) { const a = t - st.ringAt, rr = 0.4 + a * 3.6, f = Math.exp(-a * 3), cc = st.ringCol || fire; for (let i = 0; i < 150; i++) { const an = i / 150 * 6.2832; put(faceC[0] + Math.cos(an) * rr, faceC[1] + Math.sin(an) * rr, 0.2, cc[0] * 5 * f + f, cc[1] * 5 * f + f, cc[2] * 5 * f + f, 1.4); } }
      // ---- THE SCORE: fireworks for a high one (the mouth's fire / goo comes from the layers above)
      const sco = st.score;
      if (sco && sco.kind === 'fire') { const u = t - sco.t0; for (let i = 0; i < 5; i++) { const ft = 1.5 + i * 0.42; if (u >= ft && u < ft + dt * 1.5) { const p = [(h1(i * 3.7 + sco.n) * 2 - 1) * hw / ps * 0.7, VIEW.targetY + (1.15 + 0.9 * h1(i * 5.3 + sco.n)) / ps, 0.4]; burst(p, 120, 2.7, i % 2 ? lerp3(fire, WHITE, 0.2) : [1.0, 0.86, 0.5], { size: 1.1, life: 1.1, up: 0.1, white: 0.4 }); put(p[0], p[1], p[2], 24, 22, 18, 9); } } }
      if (sco && sco.kind === 'meh') { const u = t - sco.t0; if (u >= 1.2 && u < 1.2 + dt * 1.5) burst([mouth[0], mouth[1], mouth[2] + 0.3], 30, 1.4, fire, { size: 0.8, life: 0.8, up: 0.5 }); }

      // ---- THE BOSS FIGHT
      HUD.missiles.length = 0; HUD.strikes.length = 0;
      if (B) bossDraw(B, { tw, scr, put, eyes, mouth, mouthH, faceC, sc, ps, t, dt, hw: hw / ps, hh: hh / ps, VIEW, fire, beat, c, fk });
      else { st.seen.clear(); st.stageSeen = 'whole'; st.endSeen = null; st.text = null; }
      // ---- HAND PUPPETS
      if (st.hands) puppetsDraw(st.hands, { put, t, dt, VIEW, faceC, c, sc });

      // ---- pops for the HUD (screen places), anchors
      const m2 = scr(st.eat ? mE : mouth), f2 = scr(faceC); HUD.anchors = { mouth: [m2[0], m2[1]], face: [f2[0], f2[1]], unit: f2[2] };
      // ---- draw: the field first (goo covers, fire adds), then the light points
      gl.bindVertexArray(null);
      if (nS > 0) {
        const F = GLS.field;
        gl.bindFramebuffer(gl.FRAMEBUFFER, F.fbo); gl.viewport(0, 0, F.w, F.h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindBuffer(gl.ARRAY_BUFFER, GLS.spBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, spData.subarray(0, nS * 7));
        GLS.pSpl.use().u('uViewProj', vp).u('uPx', F.h * 0.5 * c.proj[5] * ps); gl.bindVertexArray(GLS.spVao); gl.drawArrays(gl.POINTS, 0, nS);
        G.bindScene(); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const A2 = st.gooA2 || TOXIC2, mol = lerp3(fire, [1, 0.8, 0.3], 0.35);
        G.bindTex(0, F.tex); GLS.pComp.use().ui('uField', 0).u('uTexel', [1 / F.w, 1 / F.h]).u('uTime', t).u('uAspect', G.W / G.H).u('uGooA', mul3(gooA, 1.0)).u('uGooA2', A2).u('uGooB', mul3(mol, 1.5)).u('uGooB2', mul3(fire, 0.55)).u('uFire', st.thin ? FIRE_GOLD : fire).u('uFireDeep', st.thin ? FIRE_DEEP : st.own ? mul3(st.own, 0.5) : [0.9, 0.06, 0.03]);
        G.fsTri();
      }
      if (nP > 0) {
        gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindBuffer(gl.ARRAY_BUFFER, GLS.ptBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ptData.subarray(0, nP * 7));
        GLS.pPts.use().u('uViewProj', vp).u('uPx', G.H * 0.066 * ps); gl.bindVertexArray(GLS.ptVao); gl.drawArrays(gl.POINTS, 0, nP);
      }
      gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.bindVertexArray(null);
      st.counts = { points: nP, splats: nS };
    }

    // ---------------------------------------------------------------- the fight, drawn from the engine's state
    const RAID = [1.0, 0.80, 0.42];                    // the raid's own light: warm gold-white, against the Mask's colour
    function bossDraw(B, X) {
      const { tw, scr, put, eyes, mouth, faceC, sc, t, dt, fire, beat } = X, mvs = B.moves || {}, E = B.ending;
      // missiles: the picture rides in front (HUD), the light and the tail are here
      for (const m of B.missiles || []) {
        const onFace = m.state === 'hit' || m.state === 'pulled' || m.state === 'eaten' || m.state === 'gulped', dX = onFace ? 0 : (st.dodgeX || 0);
        const prev = st.seen.get(m.id), w = tw(m.pos); w[0] -= dX; const s2 = scr(w), size = (0.6 + 0.4 * (m.size || 1)) * 0.168 * sc, col = m.kind === 'heavy' ? [1.0, 0.62, 0.16] : m.kind === 'swarm' ? [1.0, 0.92, 0.75] : RAID;
        if (prev !== m.state) {
          st.seen.set(m.id, m.state);
          if (m.state === 'fly' && prev === undefined) cue(t, 'whoosh', 0.5 * (m.size || 1), Math.min(1.2, m.eta || 1));
          if (m.state === 'hit') { burst(w, Math.round(46 * (m.size || 1)), 3.2, col, { size: 1.1, life: 0.8 }); put(w[0], w[1], w[2] + 0.2, 26, 23, 19, 9 * (m.size || 1)); st.kickV = Math.max(st.kickV, 0.45 * (m.size || 1)); cue(t, m.kind === 'heavy' ? 'boom' : 'bang', m.size || 1); pop(t, m.viewer ? '@' + m.viewer.name : '', [s2[0], s2[1]], 'hit'); }
          if (m.state === 'eaten') { burst([mouth[0], mouth[1], mouth[2] + 0.3], 22, 1.8, lerp3(fire, WHITE, 0.5), { size: 0.7, life: 0.4 }); cue(t, 'chomp', 0.8); pop(t, 'ATE @' + (m.viewer ? m.viewer.name : ''), null, 'ate'); }
          if (m.state === 'pulled') cue(t, 'slurp', 0.7, 0.25);
          if (m.state === 'blocked') { burst(w, 26, 2.2, [0.9, 0.95, 1.0], { size: 0.8, life: 0.45, white: 0.8 }); cue(t, 'ping', 0.8); }
          if (m.state === 'lasered' || m.state === 'screamed' || m.state === 'burned') { burst(w, 30, 2.4, lerp3(fire, WHITE, 0.3), { size: 0.9, life: 0.5 }); if (m.state === 'lasered') cue(t, 'bang', 0.5); }
          if (m.state === 'slimed') { for (let j = 0; j < 8; j++) spawn(GOO, w[0], w[1], w[2], (rnd() - 0.5) * 2, 1.5 * rnd(), 0, 2, (0.16 + 0.1 * rnd()) * sc, TOXIC, 0); }
          if (m.state === 'dodged') pop(t, 'DODGED', [s2[0], s2[1]], 'dodge');
        }
        let vis = 1, shrink = 1;
        if (m.state === 'hit' || m.state === 'lasered' || m.state === 'screamed' || m.state === 'burned' || m.state === 'slimed' || m.state === 'blocked') vis = 0;
        if (m.state === 'eaten') vis = 0;
        if (m.state === 'pulled' || m.state === 'gulped') shrink = 1 - 0.7 * clamp(m.age / (m.state === 'gulped' ? 1.0 : 0.25));
        if (m.state === 'dodged' || m.state === 'blown') vis = 1 - clamp(m.age / 0.6);
        if (vis <= 0) continue;
        HUD.missiles.push({ x: s2[0], y: s2[1], r: size * s2[2] * shrink, a: vis, viewer: m.viewer, kind: m.kind, seed: m.seed || 0, power: m.power || 1 });
        const g = 1.6 * vis; put(w[0], w[1], w[2], col[0] * g, col[1] * g, col[2] * g, 18 * (m.size || 1) * shrink);
        if (m.state === 'fly' && m.start && m.ctrl && m.target) {
          const at = (u) => { const a = (1 - u) * (1 - u), b2 = 2 * u * (1 - u), c2 = u * u, q = tw([a * m.start[0] + b2 * m.ctrl[0] + c2 * m.target[0], a * m.start[1] + b2 * m.ctrl[1] + c2 * m.target[1], a * m.start[2] + b2 * m.ctrl[2] + c2 * m.target[2]]); q[0] -= dX; return q; };
          for (let k = 1; k < 26; k++) { const u = m.u - k * 0.011; if (u < 0) break; const f = 1 - k / 26, p = at(u), j = k * 0.004, r1 = h1(k * 3.1 + (m.seed || 0) * 91), r2 = h1(k * 7.7 + (m.seed || 0) * 37), br = 3.6 * f * f; put(p[0] + (r1 - 0.5) * j, p[1] + (r2 - 0.5) * j, p[2], col[0] * br, col[1] * br, col[2] * br, (m.size || 1) * (0.8 + 1.7 * f)); }
        }
      }
      for (const id of Array.from(st.seen.keys())) if (!(B.missiles || []).some((m) => m.id === id)) st.seen.delete(id);
      // the orbital beam of a big gift: a ring that closes on the spot, then the beam from above
      for (const s of B.strikes || []) {
        const w = tw(s.pos), prev = st.strikeSeen.get(s.id); if (prev !== s.state) { st.strikeSeen.set(s.id, s.state); if (s.state === 'lock') cue(t, 'charge', 1.2, 2.4); if (s.state === 'fire') { cue(t, 'boom', 1.8); st.kickV = 1.0; burst(w, 120, 4.5, [1.0, 0.75, 0.3], { size: 1.3, life: 1.0 }); } }
        if (s.state === 'lock') { const rr = (1.1 - 0.85 * s.k) * sc, a0 = t * 2.2; for (let i = 0; i < 72; i++) { if ((i >> 2) % 3 === 2) continue; const a = i / 72 * 6.2832 + a0, br = 2.6 + 2 * s.k; put(w[0] + Math.cos(a) * rr, w[1] + Math.sin(a) * rr, w[2] + 0.3, br, br * 0.72, br * 0.25, 1.1); } for (let i = 0; i < 40; i++) { const y = w[1] + 0.3 + i * 0.12, br = 0.8 * s.k * (0.5 + 0.5 * Math.sin(t * 20 - i)); put(w[0], y, 0.3, br, br * 0.7, br * 0.25, 0.6); } const s2 = scr(w); HUD.strikes.push({ x: s2[0], y: s2[1], k: s.k, viewer: s.viewer }); }
        if (s.state === 'fire') { const f = Math.sin(Math.PI * clamp(s.k)), wd = 0.10 + 0.14 * f; for (let i = 0; i < 90; i++) { const y = w[1] + i * 0.062, j = (h1(i * 3.3 + Math.floor(t * 60)) - 0.5) * wd; put(w[0] + j, y, 0.3, 12 * f, 10.5 * f, 8 * f, 2.6); put(w[0] + j * 2.5, y, 0.3, 2.4 * f, 1.5 * f, 0.4 * f, 9); } put(w[0], w[1], 0.4, 30 * f, 26 * f, 20 * f, 12); }
      }
      // the shield: a bubble of points round the face
      if (mvs.shield && mvs.shield.on && X.fk > 0.02) {
        const R = (mvs.shield.radius || 1.9) * sc, en = clamp(mvs.shield.energy === undefined ? 1 : mvs.shield.energy), c0 = tw([0, -0.42, 0]);
        for (let i = 0; i < 620; i++) { const th = h1(i * 1.11) * 6.2832 + t * 0.15, u = h1(i * 2.37) * 2 - 1, q = Math.sqrt(1 - u * u), x = q * Math.cos(th), y = u, z = q * Math.sin(th); if (z < -0.2) continue; const edge = 1 - z, hex = 0.6 + 0.4 * Math.sin(th * 12 + u * 9 + t * 2), br = (0.25 + 2.3 * edge * edge * edge) * hex * (0.35 + 0.65 * en) * (0.8 + 0.4 * beat) * X.fk; put(c0[0] + x * R, c0[1] + y * R * 1.18, c0[2] + z * R, br * 0.9, br * 0.96, br, 0.9 + 0.5 * edge); }
      }
      // the shockwave: a ring that runs out from the face
      if (mvs.shockwave && mvs.shockwave.age !== null && mvs.shockwave.age !== undefined && mvs.shockwave.age < 0.75) {
        const a = mvs.shockwave.age, rr = (0.6 + a * 6) * sc, f = Math.pow(1 - a / 0.75, 1.5);
        if (a < dt * 1.5) { cue(t, 'boom', 1.0); st.kickV = Math.max(st.kickV, 0.8); }
        for (let i = 0; i < 220; i++) { const an = i / 220 * 6.2832, j = h1(i * 5.5) * 0.06; put(faceC[0] + Math.cos(an) * rr * (1 + j), faceC[1] + Math.sin(an) * rr * (1 + j), 0.3, 9 * f, 8.2 * f, 6.4 * f, 1.6 + 2 * f); put(faceC[0] + Math.cos(an) * rr * 0.86, faceC[1] + Math.sin(an) * rr * 0.86, 0.3, fire[0] * 3 * f, fire[1] * 3 * f, fire[2] * 3 * f, 1.2); }
      }
      // lasers: a beam from each eye
      if (mvs.laser && mvs.laser.on && mvs.laser.to) {
        const to = tw(mvs.laser.to), ht = clamp(mvs.laser.heat || 0); if (!st.laserOn) { st.laserOn = true; cue(t, 'laser', 1, 0.5); } else if (Math.floor(t * 2.5) !== Math.floor((t - dt) * 2.5)) cue(t, 'laser', 0.8, 0.45);
        for (const e of eyes) { for (let i = 0; i <= 46; i++) { const f = i / 46, x = lerp(e.p[0], to[0], f), y = lerp(e.p[1], to[1], f), z = lerp(e.p[2] + 0.3, to[2], f), fl = 0.75 + 0.25 * Math.sin(t * 70 + i * 0.9); put(x, y, z, 14 * fl, (9 + 4 * ht) * fl, (6 + 5 * ht) * fl, 1.5); put(x, y, z, fire[0] * 2.4, fire[1] * 2.0 * (1 - 0.5 * L_demon()), fire[2] * 2.0, 5.0); } }
        put(to[0], to[1], to[2], 22, 16, 9, 6); if (rnd() < 0.6) spawn(SPARK, to[0], to[1], to[2], (rnd() - 0.5) * 3, (rnd() - 0.5) * 3, 0, 0.4, 0.8, lerp3(fire, WHITE, 0.4), 0);
      } else st.laserOn = false;
      // the scream: rings thrown out of the mouth
      if (mvs.scream && mvs.scream.age !== null && mvs.scream.age !== undefined && mvs.scream.age < 1.0) {
        const a = mvs.scream.age; if (a < dt * 1.5) { cue(t, 'scream', 1.2, 0.9); st.kickV = 1.0; }
        for (let r0 = 0; r0 < 5; r0++) { const ra = a - r0 * 0.07; if (ra < 0) continue; const rr = (0.25 + ra * 5.2) * sc, f = Math.pow(Math.max(0, 1 - ra / 0.8), 1.3); if (f <= 0) continue; for (let i = 0; i < 150; i++) { const an = i / 150 * 6.2832, wob = 1 + 0.05 * Math.sin(an * 9 + r0 * 2 + t * 30); put(mouth[0] + Math.cos(an) * rr * wob, mouth[1] + Math.sin(an) * rr * wob * 0.92, 0.4, 7 * f, 6.4 * f, 5.2 * f, 1.5 + 1.5 * f); } }
      }
      // the suck-in: streaks spiralling into the open mouth while he eats (and the winning gulp)
      const eatK = Math.max(mvs.eat && (mvs.eat.on || mvs.eat.charge > 0.3) ? Math.max(mvs.eat.on ? 1 : 0, mvs.eat.charge || 0) : 0, E && E.winner === 'boss' && E.stage === 'gulp' ? 1.6 : 0);
      if (eatK > 0.05) { const n = Math.round(70 * eatK), R = ((mvs.eat && mvs.eat.radius) || 1.6) * sc * (eatK > 1 ? 1.9 : 1); for (let i = 0; i < n; i++) { const ph = (t * (1.3 + h1(i * 2.2)) + h1(i * 7.3)) % 1, a = h1(i * 3.9) * 6.2832 + ph * 2.4, rr = R * (1 - ph) * (0.35 + 0.65 * h1(i * 1.3)), br = 2.6 * ph * Math.min(1, eatK); put(mouth[0] + Math.cos(a) * rr, mouth[1] + Math.sin(a) * rr, 0.4, br, br * 0.85, br * 0.6, 0.8 + 0.8 * (1 - ph)); } }
      // a phase change
      const stg = B.boss ? B.boss.stage : 'whole';
      if (stg !== st.stageSeen) { if (stg === 'cracked') { cue(t, 'crack', 1.3); cue(t + 0.2, 'fire', 0.9, 1.6); burst(faceC, 90, 3.4, lerp3(fire, WHITE, 0.4), { size: 1.0 }); st.kickV = 0.8; pop(t, 'CRACKED', null, 'stage'); } if (stg === 'demon') { cue(t, 'scream', 0.9, 0.8); cue(t, 'boom', 1.4); burst(faceC, 140, 4.2, [1.0, 0.25, 0.06], { size: 1.2 }); st.kickV = 1.0; flash(t, [1.0, 0.2, 0.05], 0.35); pop(t, 'DEMON MODE', null, 'stage'); } st.stageSeen = stg; }
      // the endings
      if (E) {
        const key = E.winner + ':' + E.stage;
        if (key !== st.endSeen) {
          st.endSeen = key;
          if (E.winner === 'chat' && E.stage === 'explode') { cue(t, 'boom', 2.2); cue(t + 0.15, 'bang', 1.4); cue(t + 0.4, 'boom', 1.2); burst(faceC, 420, 6.5, lerp3(fire, WHITE, 0.25), { size: 1.4, life: 1.6, up: 0.15 }); st.kickV = 1.4; flash(t, WHITE, 0.5); st.text = null; }
          if (E.winner === 'boss' && E.stage === 'shatter') { cue(t, 'glass', 1.2); }
          if (E.winner === 'boss' && E.stage === 'gulp') { cue(t, 'slurp', 1.4, 1.0); cue(t + 1.05, 'chomp', 1.4); }
          if (E.winner === 'boss' && E.stage === 'laugh') { for (let i = 0; i < 6; i++) cue(t + i * 0.323, 'laugh', 1 - i * 0.08); }
          if (E.stage === 'credits') cue(t, 'rise', 1, 1.0);
          if (E.stage === 'reform') cue(t, 'whoosh', 1.2, 1.2);
        }
        // the particles spell the ending's line: they rain down, gather into the words, and at the end fly home into the face
        if (E.text && (E.winner === 'chat' ? ['rain', 'credits', 'reform'] : ['laugh', 'credits', 'reform']).includes(E.stage)) {
          if (!st.text || st.text.src !== E.text) { const nm = /^(@\S+)\s+(.*)$/.exec(E.text), lines = nm ? [{ text: nm[1], size: 132, y: 120 }, { text: nm[2].toUpperCase(), size: 78, y: 262 }] : [{ text: E.text.toUpperCase(), size: 110, y: 192 }]; st.text = { src: E.text, pts: textPoints(lines, 4200) || new Float32Array(0) }; }
          const pts = st.text.pts, n = pts.length / 3, S2 = X.hw * 0.76, safeX = (st.mirror ? 0.083 : -0.083) * X.hw, mirX = st.mirror ? -1 : 1, boss = E.winner === 'boss', cy = boss ? X.VIEW.targetY + (0.56 - (X.c.poy || 0)) * X.hh : faceC[1] + 0.25, pxo = (X.c.pox || 0) * X.hw;
          const form = boss ? (E.stage === 'laugh' ? ss(0.35, 0.95, E.k) : 1) : (E.stage === 'rain' ? ss(0.30, 0.95, E.k) : 1), home = E.stage === 'reform' ? ss(0.0, 0.7, E.k) : 0;
          for (let i = 0; i < n; i++) {
            const a = h1(i * 1.71), b = h1(i * 3.13 + 2), d = h1(i * 5.7 + 4), tx = pts[i * 3] * S2 * mirX + safeX - pxo, ty = cy + pts[i * 3 + 1] * S2;
            const fall = ((t * (1.1 + 1.6 * b) + a * 6) % 5.4), rx = (a * 2 - 1) * X.hw * 1.05, ry = X.VIEW.targetY + X.hh - fall / 5.4 * X.hh * 2;
            const k = clamp(form * 1.5 - d * 0.5), k2 = k * k * (3 - 2 * k);
            let x = lerp(rx, tx, k2), y = lerp(ry, ty, k2);
            if (home > 0) { const hk = clamp(home * 1.6 - a * 0.6), h2 = hk * hk; x = lerp(x, faceC[0] + (b - 0.5) * 1.4 * sc, h2); y = lerp(y, faceC[1] + (d - 0.5) * 2.0 * sc, h2); if (hk >= 1) continue; }
            const tw2 = 0.75 + 0.25 * Math.sin(t * (4 + 6 * b) + i), br = lerp(1.6, 3.3 + 0.8 * beat, k2) * tw2 * pts[i * 3 + 2] * (1 - home * 0.5), cc = boss ? fire : RAID;
            put(x, y, 0.5, br * lerp(cc[0], 1, 0.55 * k2), br * lerp(cc[1], 0.95, 0.55 * k2), br * lerp(cc[2], 0.85, 0.55 * k2), lerp(0.8, 0.95, k2));
            if (k2 < 0.6) put(x, y + 0.05, 0.5, br * cc[0] * 0.35, br * cc[1] * 0.35, br * cc[2] * 0.35, 0.6);      // the rain's streak
          }
        }
        if (E.winner === 'boss' && E.stage === 'laugh' && Math.floor(E.t * 3.1) !== Math.floor((E.t - dt) * 3.1)) burst([mouth[0], mouth[1], mouth[2] + 0.3], 24, 2.0, lerp3(fire, WHITE, 0.5), { size: 0.8, life: 0.5, up: 0.5 });
      }
    }
    const L_demon = () => st.L.demon;

    // ---------------------------------------------------------------- the hand puppets
    const PR = { angel: { react: 0, talk: 0 }, devil: { react: 0, talk: 0 } };
    function puppetsDraw(H, X) {
      if (!PUP) PUP = buildPuppets();
      const { put, t, dt, c } = X, ps = c.ps, HW = X.VIEW.halfH * c.G.W / c.G.H, HH = X.VIEW.halfH;
      // everything below is worked out in the FRAME (x -HW..HW, y -HH..HH, the picture's middle = 0) and put through the
      // Mask's own move / zoom backwards, so a puppet's place and size do not change when the Mask steps back
      const toW = (fx, fy) => [(fx - c.pox * HW) / ps, X.VIEW.targetY + (fy - c.poy * HH) / ps];
      const maskF = [X.faceC[0] * ps + c.pox * HW, (X.faceC[1] - X.VIEW.targetY) * ps + c.poy * HH], maskHalf = 0.98 * X.sc * ps;
      const both = !!(H.angel && H.devil && H.angel.k > 0.3 && H.devil.k > 0.3);
      const where = {};
      for (const who of ['angel', 'devil']) {
        const P = H[who]; if (!P || !(P.k > 0.01)) continue;
        const Rf = both ? 0.335 : 0.40, ext = (who === 'angel' ? 2.0 : 1.55) * Rf;
        // phase 2: a puppet stays BESIDE the face and follows the hand inside a band round it (his hands are low in the
        // camera picture: mapped one to one they sat at the bottom edge and were clamped there)
        let fx = (P.x - 0.5) * 2 * HW * 0.95, fy = maskF[1] + clamp((0.62 - P.y) * 2 * HH * 0.55, -0.26 * HH, 0.20 * HH);
        const side = Math.abs(fx - maskF[0]) > 0.08 ? Math.sign(fx - maskF[0]) : (who === 'angel' ? -1 : 1), keep = maskHalf + 0.30 * Rf;
        if (Math.abs(fx - maskF[0]) < keep) fx = maskF[0] + side * keep;
        fx = clamp(fx, Math.min(-0.80 * HW + ext * 0.5, 0), Math.max(0.80 * HW - ext * 0.5, 0)); fy = clamp(fy, -HH * 0.46 + Rf, HH * 0.42);
        where[who] = { fx, fy, Rf };
      }
      for (const who of ['angel', 'devil']) {
        const P = H[who], Wh = where[who]; if (!Wh) continue;
        if (P.on && !st.handSeen[who]) { st.handSeen[who] = true; cue(t, 'poof', 1); } else if (!P.on && st.handSeen[who]) { st.handSeen[who] = false; cue(t, 'poof', 0.8); }
        const devil = who === 'devil', k = clamp(P.k), S = PUP[who], Rf = Wh.Rf, other = H[devil ? 'angel' : 'devil'], oW = where[devil ? 'angel' : 'devil'], Q = PR[who];
        // it looks at the other puppet when both are up, else at the Mask; it reacts while the other one talks
        const tx = both && oW ? oW.fx : maskF[0], ty = both && oW ? oW.fy : maskF[1] - 0.1, lx0 = tx - Wh.fx, ly0 = ty - Wh.fy, ll = Math.hypot(lx0, ly0) || 1, lx = lx0 / ll, ly = ly0 / ll;
        Q.react = ease(Q.react, both && other && other.talking && !P.talking ? 1 : 0, dt, 7, 4); Q.talk = ease(Q.talk, P.talking ? 1 : 0, dt, 9, 5);
        const re = Q.react, yaw = clamp(lx * (both ? 0.62 : 0.42), -0.7, 0.7) + 0.05 * Math.sin(t * 1.1 + (devil ? 2 : 0)), cyw = Math.cos(yaw), syw = Math.sin(yaw);
        const roll = clamp(-(P.tilt || 0), -0.6, 0.6) * 0.5 + (devil ? 0.10 * re * Math.sin(t * 9) : -0.10 * re * Math.sign(lx || 1)), cr = Math.cos(roll), sr = Math.sin(roll);
        const mo = clamp(Math.max(P.mouth, devil ? 0.16 * re : 0.30 * re)), jawA = mo * 0.62, upA = -mo * 0.14, cj = Math.cos(jawA), sj = Math.sin(jawA), cu = Math.cos(upA), su = Math.sin(upA);
        const blinkPh = (t * 0.29 + (devil ? 0.57 : 0.13)) % 1, blink = blinkPh < 0.04 ? 1 - Math.abs(blinkPh / 0.04 * 2 - 1) : 0;
        const eyeR = devil ? 0.17 : 0.20, eyeSy = (devil ? 0.60 - 0.22 * re : 1.0 + 0.22 * re) * (1 - 0.94 * blink), slant = devil ? 0.38 : -0.06, browUp = devil ? -0.05 * re : 0.11 * re;
        const flapA = Math.sin(t * (4.2 + 9 * Q.talk)) * (0.07 + 0.30 * Q.talk + 0.15 * clamp(Math.abs(P.mouthV || 0) / 6)) + 0.14 * re;
        const SH = devil ? [1.30, 0.045, 0.03] : [1.05, 0.60, 0.22], KEY = devil ? [1.35, 0.50, 0.24] : [1.20, 1.12, 0.98], LINE = devil ? [1.6, 0.85, 0.30] : [1.5, 1.32, 0.95], IN = devil ? [1.6, 0.42, 0.06] : [1.5, 0.62, 0.34], IRIS = devil ? [1.8, 0.95, 0.12] : [1.7, 0.95, 0.20];
        const d = S.d, scat = (1 - k) * (1 - k), szK = 0.50 / ps * (Rf / 0.36), bob = 0.03 * Math.sin(t * 2.3 + (devil ? 1 : 0)) + 0.05 * Q.talk * Math.abs(Math.sin(t * 9));
        const c0 = toW(Wh.fx, Wh.fy + bob), Rw = Rf / ps;
        for (let i = 0; i < S.n; i++) {
          const o = i * PST, part = d[o + 6], u = d[o + 9], rr = d[o + 10]; let x = d[o], y = d[o + 1], z = d[o + 2], nx = d[o + 3], ny = d[o + 4], nz = d[o + 5], br = d[o + 7], sz = d[o + 8], col = null, lit = true;
          if (part >= 4 && part <= 6) {      // an eye: built here from its inner place, so it can blink, narrow and look
            const sd = u, ex = sd * 0.38, ey = devil ? 0.22 : 0.20, cs2 = Math.cos(slant * sd), sn2 = Math.sin(slant * sd); let ox = nx, oy = ny;
            if (part === 5) { const cat = nz > 1.5; ox = ox + (cat ? 0 : lx * 0.36); oy = oy + (cat ? 0 : ly * 0.30); if (ox * ox + oy * oy > 0.92) continue; col = cat ? [1.6, 1.5, 1.4] : IRIS; br *= 1.5 + 0.5 * re; }
            else if (part === 6) { col = LINE; br *= 1.25; } else { col = devil ? [0.55, 0.10, 0.04] : [0.30, 0.20, 0.10]; }
            const qx = ox * eyeR, qy = oy * eyeR * eyeSy; x = ex + qx * cs2 - qy * sn2; y = ey + qx * sn2 + qy * cs2; z = Math.sqrt(Math.max(0.02, 1 - x * x - (y / 0.95) * (y / 0.95))) * 0.90 + 0.015; nx = 0; ny = 0; nz = 1; lit = false;
          } else if (part === 7) { y += browUp + (devil ? 0 : 0); col = LINE; lit = false; br *= 1.1; }
          else if (part === 2 || part === 3) { col = LINE; lit = false; br *= 0.95 + 0.4 * mo; }
          else if (part === 17 || part === 18) { col = part === 18 && u > 0.5 ? (devil ? [1.7, 0.30, 0.10] : [1.6, 0.50, 0.42]) : IN; lit = false; br *= (0.10 + 2.6 * ss(0.03, 0.5, mo)); sz *= 1.5; if (br < 0.04) continue; }
          else if (part === 15 || part === 16) { col = [1.5, 1.42, 1.25]; lit = false; br *= 0.75 + 0.5 * mo; }
          else if (part === 14) { col = devil ? [1.5, 0.25, 0.08] : (u > 0.5 ? [1.5, 0.52, 0.34] : [1.3, 1.1, 0.8]); lit = false; br *= 0.55; }
          else if (part === 9) { col = [1.6, 1.22, 0.48]; lit = false; br *= 2.3 + 0.7 * Math.sin(t * 3 + rr * 6); y += 0.04 * Math.sin(t * 2.2); }
          else if (part === 10) { const sd = Math.sign(u), al = Math.abs(u), a = sd * flapA * (0.25 + 0.75 * al), ca = Math.cos(a), sa = Math.sin(a), dx = x - sd * 0.62, dy = y - 0.10; x = sd * 0.62 + dx * ca - dy * sa; y = 0.10 + dx * sa + dy * ca; col = [1.25, 1.14, 0.96]; lit = false; br *= 0.95; }
          else if (part === 11) { col = [SH[0] * (1 - u) + 1.7 * u, SH[1] * (1 - u) + 0.75 * u, SH[2] * (1 - u) + 0.16 * u]; }
          else if (part === 12) { const sw = Math.sin(t * 3.1 + u * 4) * 0.10 * u; x += sw * 0.6; y += sw; col = [1.45, 0.16 + 0.5 * u * u, 0.05]; lit = false; br *= 0.9; }
          else if (part === 13) { col = [1.5, 0.80, 0.22]; lit = false; br *= 0.85; y += 0.03 * Math.sin(t * 2.1); }
          else if (part === 8) { col = null; }
          // the hinge: the jaw swings down, the upper head tips back a little
          if (part === 1 || part === 3 || part === 16 || part === 18) { const dy = y - HINGE[0], dz = z - HINGE[1]; y = HINGE[0] + dy * cj - dz * sj * 0.55 - 0.42 * mo; z = HINGE[1] + dy * sj + dz * cj; }
          else if (part !== 8 && part !== 12 && part !== 13) { const dy = y - HINGE[0], dz = z - HINGE[1]; y = HINGE[0] + dy * cu - dz * su; z = HINGE[1] + dy * su + dz * cu; }
          // it turns toward what it looks at, and tips with the hand
          const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw, n1x = nx * cyw + nz * syw, n1z = -nx * syw + nz * cyw;
          if (lit && n1z < -0.12) continue;
          const xr = x1 * cr - y * sr, yr = x1 * sr + y * cr;
          let R3, G3, B3;
          if (lit) {      // lit like the Mask: the key colour where the key falls, the shade colour in the shade and on the rim
            const kd = Math.pow(Math.max((n1x * -0.50 + ny * 0.52 + n1z * 0.70 + 0.30) / 1.30, 0), 1.7), rim = Math.pow(1 - Math.min(1, Math.abs(n1z)), 2.5), a = part === 8 ? 0.10 : 0.16, fl = part === 8 ? 0.55 : 1;
            R3 = (SH[0] * (a + 1.25 * rim) + KEY[0] * kd * 1.15) * fl; G3 = (SH[1] * (a + 1.25 * rim) + KEY[1] * kd * 1.15) * fl; B3 = (SH[2] * (a + 1.25 * rim) + KEY[2] * kd * 1.15) * fl;
            if (col) { R3 = R3 * 0.5 + col[0] * 0.5 * (0.3 + kd + rim); G3 = G3 * 0.5 + col[1] * 0.5 * (0.3 + kd + rim); B3 = B3 * 0.5 + col[2] * 0.5 * (0.3 + kd + rim); }
          } else { R3 = col[0]; G3 = col[1]; B3 = col[2]; }
          let px = c0[0] + xr * Rw, py = c0[1] + yr * Rw;
          if (scat > 0.001) { const a = rr * 6.2832 + i, dd = scat * (0.3 + 2.0 * h1(i * 0.37)) * Rw * 2.2; px += Math.cos(a) * dd; py += Math.sin(a) * dd + scat * 0.3 * Rw; }
          const b2 = br * k * (0.92 + 0.10 * Math.sin(t * (1.5 + rr * 3) + rr * 40)) * 1.25;
          put(px, py, 0.5 + z1 * Rw, R3 * b2, G3 * b2, B3 * b2, sz * szK);
        }
        // light that blooms: the halo, the eyes; the poof
        const glow = (lx2, ly2, col, br, size) => { const x1 = lx2 * cyw + 0.85 * syw, xr = x1 * cr - ly2 * sr, yr = x1 * sr + ly2 * cr; put(c0[0] + xr * Rw, c0[1] + yr * Rw, 0.6, col[0] * br * k, col[1] * br * k, col[2] * br * k, size * szK); };
        for (const sd of [-1, 1]) glow(sd * 0.38, devil ? 0.22 : 0.20, IRIS, (devil ? 1.1 : 0.30) * (1 - blink), devil ? 17 : 13);
        if (mo > 0.08) glow(0, -0.36 - 0.30 * mo, IN, 1.5 * ss(0.08, 0.6, mo), 30 + 26 * mo);      // the glow in the open mouth
        if (!devil) { const hy = 1.43 + 0.04 * Math.sin(t * 2.2), xr = -hy * sr, yr = hy * cr; put(c0[0] + xr * Rw, c0[1] + yr * Rw, 0.4, 1.3 * k, 0.95 * k, 0.35 * k, 60 * szK); }
        if (scat > 0.04 && scat < 0.96) for (let i = 0; i < 40; i++) { const a = h1(i * 3.3 + (devil ? 2 : 1)) * 6.2832, dd = (1 - k) * (0.5 + 1.5 * h1(i * 1.9)) * Rw * 2.4; put(c0[0] + Math.cos(a) * dd, c0[1] + Math.sin(a) * dd, 0.6, LINE[0] * 5 * k, LINE[1] * 5 * k, LINE[2] * 5 * k, 2.2 * szK); }
      }
    }

    // ---------------------------------------------------------------- the verdict: a giant word of fire (release A)
    // Spat from the mouth letter by letter (left to right as it is read), it lands with a small overshoot, burns for
    // EAT.hold seconds (flames stand on the letters' top edges, embers rise; FIRE has fireworks, GEM glints, SOLID a bar
    // under it, PROMISING a softer glow), then is sucked back into the mouth. In the cover's warm colour, white-hot at
    // the outline. It sits in the frame, not on the Mask: the Mask's own move / zoom is taken out again.
    function wordDraw(e, X) {
      const W = e.pts; if (!W || !W.n) return;
      const { put, t, c, VIEW, mouth, fire, beat, G, ps } = X, w = t - e.wordT, tier = TIER[e.word] || TIER.SOLID;
      const HH = VIEW.halfH, HW = HH * G.W / G.H, B = wordBox(W, st.mirror, G.W / G.H), mirX = st.mirror ? -1 : 1, sz = 1 / ps;
      const c0x = (B.cx - c.pox) * HW / ps, c0y = VIEW.targetY + (B.cy - c.poy) * HH / ps, sW = B.hw * HW / ps;      // the word's middle and half width in the Mask's own space
      const suck = e.suckT !== null ? t - e.suckT : -1, mx0 = mouth[0], my0 = mouth[1], d = W.d, n = W.n, yr = W.yr;
      HUD.vbox = [X.scr([c0x, c0y + yr * sW, 0.5])[1], X.scr([c0x, c0y - (yr + (tier.bar ? 0.12 : 0)) * sW, 0.5])[1]];      // its top and bottom in the picture, for the 2D layer's words
      // the colours are the WORD's own (fix round V-6), not the cover's: a ramp from the letters' feet to their heads, and
      // the outline. The cover's colour only tints the embers.
      const R4 = tier.ramp, EC = tier.edge, pulse = 1 + 0.30 * beat, soft = tier.soft ? 0.86 + 0.14 * Math.sin(t * 2.6) : 1;
      for (let i = 0; i < n; i++) {
        const o = i * 3, lx = d[o], ly = d[o + 1], kind = d[o + 2], a = h1(i * 1.91), b = h1(i * 3.13 + 2);
        const dl = 0.11 * (lx + 1) + 0.09 * a, k = (w - dl) / 0.30; if (k <= 0) continue;
        const land = k >= 1 ? Math.exp(-(w - dl - 0.30) * 6.5) : 1, pop = 1 + 0.10 * tier.slam * land * (k >= 1 ? 1 : 0);
        let x = c0x + lx * mirX * sW * pop, y = c0y + ly * sW * pop;
        if (k < 1) { const ek = 1 - Math.pow(1 - k, 3), arc = Math.sin(k * Math.PI); x = lerp(mx0, x, ek) + arc * 0.30 * (a - 0.5) * sW; y = lerp(my0, y, ek) + arc * 0.10 * sW; }
        if (suck >= 0) { const s = clamp((suck - 0.10 * (1 - a) - 0.05 * (1 - lx)) / 0.30); if (s >= 1) continue; const s2 = s * s; x = lerp(x, mx0, s2) + Math.sin(s * Math.PI) * 0.22 * (b - 0.5) * sW; y = lerp(y, my0, s2); }
        const tv = clamp(0.5 + ly / (2 * yr)), tw2 = 0.84 + 0.16 * Math.sin(t * (5 + 7 * b) + i), br = tier.br * (kind ? 2.9 : 1.85) * tw2 * (1 + 1.5 * land) * pulse * soft;
        if (kind) put(x, y, 0.52, br * EC[0], br * EC[1], br * EC[2], 0.74 * sz);
        else { const q = tv * 3, j = q >= 3 ? 2 : Math.floor(q), f = q - j, A0 = R4[j], A1 = R4[j + 1]; put(x, y, 0.5, br * (A0[0] + (A1[0] - A0[0]) * f), br * (A0[1] + (A1[1] - A0[1]) * f), br * (A0[2] + (A1[2] - A0[2]) * f), 1.0 * sz); }
      }
      const formed = ss(0.40, 0.75, w) * (suck >= 0 ? 1 - clamp(suck / 0.2) : 1);
      if (formed <= 0.01) return;
      // a body of light behind it, so it reads as one thing
      const GL0 = tier.glow;
      for (let j = 0; j < 7; j++) { const q = ((j + 0.5) / 7 * 2 - 1) * 0.88, g = (tier.soft ? 0.62 : 0.40) * formed * soft * (0.85 + 0.3 * beat); put(c0x + q * sW, c0y, 0.35, GL0[0] * g, GL0[1] * g, GL0[2] * g, 34 * sz); }
      // FIRE: thin, tall, flickering tongues stand on the letters' top edges. Each site along the top is its own tongue that
      // breathes on its own clock (a stream of small fast blobs in the field, which the field's noise tears into a flame).
      const NT = W.tops.length, at = (i) => [c0x + d[i * 3] * mirX * sW, c0y + d[i * 3 + 1] * sW];
      if (NT && tier.flame > 0.01) {
        const K = 22;
        for (let k = 0; k < K; k++) {
          const i = W.tops[Math.floor((k + 0.5) / K * NT)], fl = Math.pow(0.5 + 0.5 * Math.sin(t * (5.3 + 3.1 * h1(k * 1.7)) + k * 2.9), 2) * (0.6 + 0.4 * Math.sin(t * 13.7 + k * 5.1));
          const pk = clamp(0.30 + 0.85 * fl + 0.35 * beat), rate = 1.9 * tier.flame * formed * pk, nf = Math.floor(rate) + (rnd() < rate % 1 ? 1 : 0), p = at(i);
          for (let j = 0; j < nf; j++) spawn(FIRE, p[0] + (rnd() - 0.5) * 0.018 * sW, p[1] - 0.01 * sW, 0.45, (rnd() - 0.5) * 0.18 * sz, (1.25 + 0.9 * rnd()) * (0.45 + 0.75 * pk) * sz, 0, 0.24 + 0.22 * rnd(), (0.115 + 0.045 * rnd()) * sz, FIRE_GOLD, 0.64);
        }
      }
      if (rnd() < tier.ember * formed) { const p = at(Math.floor(rnd() * n)); spawn(SPARK, p[0], p[1], 0.5, (rnd() - 0.5) * 0.6 * sz, (0.7 + 1.5 * rnd()) * sz, 0, 0.8 + 0.7 * rnd(), 0.75 * sz, [lerp(fire[0], 1, 0.4), lerp(fire[1], 0.96, 0.4), lerp(fire[2], 0.86, 0.4)], 1); }
      // FIRE: fireworks over the word
      for (let i = e.works; i < tier.works; i++) { if (w < 0.55 + i * 0.40) break; e.works = i + 1; const p = [c0x + (h1(i * 3.7 + 1.3) * 2 - 1) * 0.8 * sW, c0y + (yr + 0.18 + 0.30 * h1(i * 5.3 + 2.1)) * sW, 0.4]; burst(p, 120, 2.7 * sz, i % 2 ? [1.0, 0.42, 0.06] : [1.0, 0.86, 0.5], { size: 1.1 * sz, life: 1.1, up: 0.1, white: 0.4 }); put(p[0], p[1], p[2], 24, 22, 18, 9 * sz); }
      // GEM: glints that open and close on the outline (crimson rays, a white heart)
      if (tier.glint && n > W.nFill) {
        if (t - e.glintT > 0.07 && formed > 0.5) { e.glintT = t; e.glints.push({ i: W.nFill + Math.floor(rnd() * (n - W.nFill)), t0: t }); if (e.glints.length > 10) e.glints.shift(); }
        for (const g of e.glints) { const q = (t - g.t0) / 0.42; if (q >= 1) continue; const f = Math.sin(Math.PI * q) * formed, p = at(g.i), L = 0.15 * f * sW; put(p[0], p[1], 0.56, 15 * f, 13 * f, 11 * f, 4.5 * sz); put(p[0], p[1], 0.56, 2.2 * f, 0.16 * f, 0.20 * f, 15 * sz); for (let r = 1; r <= 6; r++) { const v = r / 6, b2 = 8 * f * (1 - v) * (1 - v), gg = 0.20 + 0.6 * (1 - v), bb = 0.22 + 0.5 * (1 - v); put(p[0] + v * L, p[1], 0.56, b2, b2 * gg, b2 * bb, 1.1 * sz); put(p[0] - v * L, p[1], 0.56, b2, b2 * gg, b2 * bb, 1.1 * sz); put(p[0], p[1] + v * L * 1.35, 0.56, b2, b2 * gg, b2 * bb, 1.1 * sz); put(p[0], p[1] - v * L * 1.35, 0.56, b2, b2 * gg, b2 * bb, 1.1 * sz); } }
      }
      // SOLID: a bar of steel slams in under it
      if (tier.bar) { const g = ss(0.30, 0.60, w) * (suck >= 0 ? 1 - clamp(suck / 0.25) : 1), yb = c0y - (yr + 0.085) * sW; if (g > 0.01) for (let i = 0; i < 260; i++) { const q = (i / 259 * 2 - 1) * g, br = 2.5 * (0.85 + 0.15 * Math.sin(t * 6 + i)) * pulse; put(c0x + q * sW * 0.97, yb + ((i % 3) - 1) * 0.011 * sW, 0.5, br * EC[0], br * EC[1], br * EC[2], 0.95 * sz); } }
    }

    function hud() {
      const t = st.t, B = st.boss, sc = st.score, hy = st.hype, e = st.eat, wu = e && e.wordT !== null ? t - e.wordT : -1;
      return {
        t, boss: B, vote: st.vote, missiles: HUD.missiles, strikes: HUD.strikes, cover: HUD.cover, anchors: HUD.anchors,
        pops: st.pops.filter((p) => t - p.t < 1.4),
        score: sc && t - sc.t0 < 4.6 ? { n: sc.n, u: t - sc.t0, kind: sc.kind } : null,
        hype: hy.rank >= 0 ? { rank: hy.rank, label: RANKS[hy.rank].label, k: hy.k, upAge: t - (hy.upAt === undefined ? -99 : hy.upAt), plusAge: t - hy.plusAt } : null,
        // release A: the song's name while it is eaten; the verdict while the word is up (top / bottom: where the word sits, picture px)
        eating: e && e.title && e.wordT === null && e.gulpT === null ? { title: e.title, a: ss(0.15, 0.5, t - e.t0) * (e.chewT !== null ? 1 - ss(0.25, 0.75, t - e.chewT) : 1) } : null,
        // (fix round V-6) the small caption under the Mask while it chews and WAITS for his verdict; it goes when the word lands
        chewing: e && e.wait && !e.word && !e.wantGulp && e.chewT !== null && e.wordT === null && e.gulpT === null ? { a: ss(0.5, 0.9, t - e.chewT), u: t - e.chewT } : null,
        verdict: e && wu >= 0 && e.gulpT === null ? { word: e.word, title: e.title, u: wu, a: ss(0.30, 0.65, wu) * (e.suckT !== null ? 1 - ss(0, 0.25, t - e.suckT) : 1), top: HUD.vbox ? HUD.vbox[0] : null, bottom: HUD.vbox ? HUD.vbox[1] : null } : null,
        colour: st.own, fire: st.fire || GOLD, gifters: HY ? HY.names() : null,
      };
    }
    function cuesBetween(a, b) { return st.cues.filter((c) => c.t >= a && c.t < b); }
    function busy() { const m = st.moves; return !!(m.goo.on || m.fire.on || m.melt.on || m.crack.on || m.eat.on || st.boss || st.eat || (st.score && st.t - st.score.t0 < 4.6)); }
    return { setHypeStyle, setHypeTone, gifter, hypeStyles: () => (root.VTMaskHype ? root.VTMaskHype.STYLES.slice() : ['classic']), hype: () => HY, puppet, release, setHype, hypePlus, cover, songOff, eat, verdict, gulp, belch, score, boss, vote, hands, pre, post, hud, cuesBetween, flash, busy, setMirror, setBars, state: st, RANKS, MOVES };
  }
  /**
   * WARM ONLY (phase 2): the colours a cover may give the Mask. The house look is black / crimson / chrome, so a cover
   * never makes a blue, teal, green or purple face. A warm colour (red, orange, gold, hot pink) is kept as it is; a cool
   * one keeps how rich and bright it was but its hue is folded onto the warm side: yellow-green .. teal -> gold (60 .. 30
   * degrees), teal .. blue .. purple -> hot pink .. crimson-pink (330 .. 350). Colours are linear RGB, as coverColours gives them.
   */
  function warmHue(h) { h = ((h % 360) + 360) % 360; if (h <= 60 || h >= 330) return h; if (h <= 180) return 60 - (h - 60) * 0.25; return 330 + (300 - Math.min(300, h)) / 6; }
  function warmColours(cols) {
    const out = [];
    for (const c of cols || []) {
      if (!c || c.length < 3) continue;
      const g = c.map((v) => Math.pow(clamp(v), 1 / 2.2)), mx = Math.max(g[0], g[1], g[2]), mn = Math.min(g[0], g[1], g[2]), ch = mx - mn;
      if (mx <= 0 || ch < 1e-4) continue;
      const h = (mx === g[0] ? ((g[1] - g[2]) / ch + 6) % 6 : mx === g[1] ? (g[2] - g[0]) / ch + 2 : (g[0] - g[1]) / ch + 4) * 60, wh = warmHue(h);
      if (Math.abs(wh - h) < 0.01) { out.push([c[0], c[1], c[2]]); continue; }
      const s = Math.max(0.55, ch / mx), x = wh / 60, k = Math.floor(x) % 6, f = x - Math.floor(x), p = mx * (1 - s), q = mx * (1 - s * f), u = mx * (1 - s * (1 - f));
      const rgb = k === 0 ? [mx, u, p] : k === 1 ? [q, mx, p] : k === 2 ? [p, mx, u] : k === 3 ? [p, q, mx] : k === 4 ? [u, p, mx] : [mx, p, q];
      out.push(rgb.map((v) => Math.pow(clamp(v), 2.2)));
    }
    return out;
  }
  /**
   * The two main colours of a cover picture, linear RGB, for stage.cover / stage.eat ({ colours }): the picture is read at 24 x 24, its
   * pixels fall into 12 bins of hue weighted by how rich and bright they are; the heaviest bin is the first colour, the
   * heaviest one at least two bins away the second. A grey picture gives []: the face then keeps its own colour.
   */
  function coverColours(image) {
    const doc = root.document; if (!doc && !root.OffscreenCanvas) return [];
    try {
      const c = root.OffscreenCanvas ? new root.OffscreenCanvas(24, 24) : Object.assign(doc.createElement('canvas'), { width: 24, height: 24 }), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(image, 0, 0, 24, 24);
      return coloursOf(x.getImageData(0, 0, 24, 24).data);
    } catch (e) { return []; }
  }
  function coloursOf(d) {
    const bins = []; for (let i = 0; i < 12; i++) bins.push({ w: 0, r: 0, g: 0, b: 0 });
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = mx - mn; if (ch < 0.12 || mx < 0.2) continue;
      let h = mx === r ? ((g - b) / ch + 6) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4; const w = ch * ch * mx, k = bins[Math.floor(h * 2) % 12];
      k.w += w; k.r += r * w; k.g += g * w; k.b += b * w;
    }
    const order = bins.map((k, i) => ({ i, w: k.w })).sort((a, b) => b.w - a.w), out = [];
    const lin = (k) => { const m = Math.max(k.r, k.g, k.b) / k.w; return [Math.pow(k.r / k.w / m, 2.2), Math.pow(k.g / k.w / m, 2.2), Math.pow(k.b / k.w / m, 2.2)]; };
    if (order[0].w <= 0) return out; out.push(lin(bins[order[0].i]));
    for (const o of order.slice(1)) { const dd = Math.min(Math.abs(o.i - order[0].i), 12 - Math.abs(o.i - order[0].i)); if (o.w > order[0].w * 0.08 && dd >= 2) { out.push(lin(bins[o.i])); break; } }
    return out;
  }
  const api = { create, RANKS, MOVES, FLASH_GAP, WORDS, EAT, TIER, wordBox, eatFlashes, coverColours, coloursOf, warmColours, warmHue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VTMaskV8 = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
