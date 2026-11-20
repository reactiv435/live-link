// avatar.html, the Mask (V4-MASK.md, Phase 2): the third choice next to Ryo and Melanie, shown by the SAME page in the
// same OBS source. It only loads mask/* (the designer's modules) and feeds mask/mask-live.js:
//   - the tracker's raw face results (binary relay messages, js/mask-wire.js) -> mask.frame()
//   - the music ({ t: 'mask-audio' } from the app: what the PC plays, or OBS's level; his voice from the `mic` messages) -> mask.audio()
//   - viewer events ({ t: 'mask-event' }: LIVE Link's, and the "Try the effects" buttons) -> mask.fire()
//   - the `avatar` message's mask fields: Visualizer / Face, background, gift sounds, the gift list, his resting face
// The mask's own canvas sits above the 3D canvas and is opaque black: while the Mask is ON it replaces the camera.
// Viewer names are drawn by this page (an element over the canvas), never into the canvas, and nothing else is ever
// shown as text. Gift sounds are played by mask/* through this page; while one plays (mask/* says so) the music numbers
// are held, so the mask can never react to its own bangs, wherever OBS sends them.
// The mask's canvas is only shown once it has drawn a real picture: until then the page is see-through and his camera
// shows (never a black screen on stream while the mask is being built, or when it cannot be built).
(function () {
  'use strict';
  const Boot = window.VTBoot, W = window.VTMaskWire, L = window.VTLogic;
  const namesEl = document.getElementById('maskNames');
  let canvas = document.getElementById('maskc');
  if (!Boot || !W || !canvas) return;
  const epoch = () => performance.timeOrigin + performance.now();
  const MAX_SHORT = 720, MAX_LONG = 1280;

  // ---------------------------------------------------------------- is a gift sound playing right now?
  // mask/* says how loud its gift sounds are (stats().sfxLevel, from what it scheduled). While one sounds, and a moment
  // after (the way out of the speakers and back in), the music numbers are held (guard() below).
  let ownSoundUntil = 0;
  function ownSound(now) {
    let v = 0;
    try { v = S.mask ? Number(S.mask.stats().sfxLevel) || 0 : 0; } catch (e) { v = 0; }
    if (v > 0.01) ownSoundUntil = now + 280;
    return now < ownSoundUntil;
  }

  // ---------------------------------------------------------------- state
  const S = {
    a: Boot.initial, mask: null, making: false, error: '', tries: 0, unchosenAt: 0, retryAt: 0, fails: 0,
    neutral: null, restRev: -1, rows: null, giftsRev: -1, applied: {},
    src: 'voice', srcAt: -1e9, target: null, cur: { bass: 0.25, mid: 0.3, high: 0.2, beat: 0, level: 0.3, bright: 0.8 }, kick: 0,
    held: { bass: 0.3, mid: 0.3, high: 0.2, level: 0.3 }, guarded: 0,
    faces: 0, frames: 0, draws: 0, fps: 0, fpsAt: 0, fpsN: 0, faceHz: 0, faceN: 0,
    newFaceAt: 0, lat: [], log: null, events: 0, lastEventAt: 0, drawnOnce: false,
  };
  const follower = W.levelFollower();
  // V7: the kill switches (?place=0, ?colour=0, ?shuffle=0, ?pv=0) and shuffle to the beat. `look` = what the Mask shows
  // right now (his own picks, or what the shuffle changed them to); sh = the clock + director while shuffle is on.
  const Stage = window.VTStage || { KILL: {}, picture: () => null }, Beat = window.VTBeat || null;
  const look = { mode: 'face', bg: 'black', viz: 'orb', colour: 'auto' };
  const SH = { sh: null, amount: '', pick: 0, changes: 0, last: null };
  const active = () => !!(S.a && S.a.on && S.a.mask);

  function size() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.max(2, Math.round(window.innerWidth * dpr)), h = Math.max(2, Math.round(window.innerHeight * dpr));
    const k = Math.min(1, MAX_SHORT / Math.min(w, h), MAX_LONG / Math.max(w, h));
    return { width: Math.max(2, Math.round(w * k / 2) * 2), height: Math.max(2, Math.round(h * k / 2) * 2) };
  }
  const getJson = (url) => fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);

  async function make() {
    if (S.mask || S.making || performance.now() < S.retryAt) return;
    S.making = true;
    try {
      // his resting face and the gift list first (a server without them, the v2 one, answers nothing: defaults)
      const a = S.a;
      const [n, g] = await Promise.all([getJson('/api/vt/mask-rest'), getJson('/api/vt/gifts')]);
      S.neutral = n && Array.isArray(n.lm) ? n : null; S.restRev = a.maskRest || 0;
      S.rows = g && Array.isArray(g.rows) ? g.rows : null; S.giftsRev = a.maskGifts || 0;
      if (!window.VTMaskLive) throw new Error('mask: its files did not load');
      const sz = size();
      S.mask = window.VTMaskLive.create(canvas, { neutral: S.neutral, bsNames: W.BS_NAMES, width: sz.width, height: sz.height, giftMap: S.rows || undefined, giftSounds: a.maskSounds !== false, background: a.maskBg || 'black', eyeLock: a.eyes !== false });
      S.applied = { mode: 'face', bg: a.maskBg || 'black', sounds: a.maskSounds !== false, viz: '', eyes: a.eyes !== false };
      S.error = ''; S.drawnOnce = false;
      apply();
    } catch (e) {
      S.mask = null;
      S.error = String(e && e.message ? e.message : e).slice(0, 160);
      // again in a while (the graphics card may be busy for a moment), on a fresh canvas; a PC that cannot draw it at all
      // is asked ever more rarely
      S.fails++; S.retryAt = performance.now() + Math.min(30000, 2000 * S.fails);
      try { const c = canvas.cloneNode(false); c.style.display = 'none'; canvas.replaceWith(c); canvas = c; watchContext(); } catch (e2) { /* keep the old one */ }
      setTimeout(() => { if (S.a && S.a.mask && !S.mask) apply(); }, S.retryAt - performance.now() + 50);
    }
    S.making = false;
    if (S.error) apply(); else S.fails = 0;
  }
  function drop() {
    const m = S.mask; S.mask = null;
    if (m) { try { m.destroy(); } catch (e) { /* gone */ } }
    // a canvas that had a graphics context cannot get a new one: a fresh canvas takes its place
    const c = canvas.cloneNode(false);
    c.style.display = 'none'; S.drawnOnce = false;
    canvas.replaceWith(c); canvas = c; watchContext();
  }
  function watchContext() {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (!S.mask) return;
      S.error = 'the graphics card dropped the picture';
      drop();
      if (S.tries++ < 5) setTimeout(() => { if (S.a && S.a.mask) make(); }, 1500);
    });
  }
  watchContext();

  /** the `avatar` message's mask fields onto the mask (each only when it changed) */
  function apply() {
    const a = S.a, m = S.mask;
    // nothing covers his camera until the mask has drawn its first real picture (and never when it cannot be drawn)
    canvas.style.display = active() && S.mask && S.drawnOnce ? 'block' : 'none';
    canvas.style.transform = a && a.mirror ? 'scaleX(-1)' : '';
    if (namesEl) namesEl.style.display = active() ? 'block' : 'none';
    if (!a || !a.mask) { if (!S.unchosenAt) S.unchosenAt = performance.now(); return; }
    S.unchosenAt = 0;
    if (!m) { make(); return; }
    const ap = S.applied;
    // V7: he picked something himself while shuffle runs (`pick` went up), or shuffle was switched on / off: everything
    // the message says is shown again (his picks), and shuffle goes on from there
    const wantSh = !Stage.KILL.shuffle && Beat && a.on && a.shuffle ? a.shuffle : '';
    if ((a.pick || 0) !== SH.pick || wantSh !== SH.amount) {
      if (wantSh !== SH.amount) { SH.sh = wantSh ? Beat.createShuffle({ amount: wantSh, seed: (Date.now() & 0xffff) || 1 }) : null; SH.amount = wantSh; }
      SH.pick = a.pick || 0;
      ap.mode = ap.bg = ap.viz = ap.colour = undefined;
    }
    if (ap.mode !== a.maskMode) { ap.mode = a.maskMode; m.setMode(a.maskMode); look.mode = a.maskMode; }
    if (ap.bg !== a.maskBg) { ap.bg = a.maskBg; m.setBackground(a.maskBg); look.bg = a.maskBg; }
    // V7: where the face sits and how big (the canvas is flipped as a whole when Mirror is on, so left-right is flipped back)
    const pz = Stage.KILL.place ? 1 : a.zoom, px = Stage.KILL.place ? 0 : (a.mirror ? -1 : 1) * (a.offsetX || 0), py = Stage.KILL.place ? 0 : Math.min(a.offsetY, L.placeUp ? L.placeUp('mask') : 0.45), pk = pz + '|' + px + '|' + py;
    if (ap.place !== pk && typeof m.setPlace === 'function') { ap.place = pk; m.setPlace({ zoom: pz, x: px, y: py }); }
    // V7: a colour he picked (not there = Auto) and whether the music still moves it
    const col = Stage.KILL.colour ? '' : (a.maskColour || ''), ck = col + '|' + (a.maskColourMusic !== false);
    if (ap.colour !== ck && typeof m.setColour === 'function') { ap.colour = ck; m.setColour(col || null, a.maskColourMusic !== false); look.colour = 'auto'; }
    if (ap.eyes !== (a.eyes !== false) && typeof m.setEyeLock === 'function') { ap.eyes = a.eyes !== false; m.setEyeLock(ap.eyes); }      // eyes on camera (round 5)
    if (ap.sounds !== a.maskSounds) { ap.sounds = a.maskSounds; m.setGiftSounds(a.maskSounds); }
    // the Visualizer's style (a newer hook of mask/*, used when it is there). The mask alone is shown: no head round it (his pick).
    if (a.maskViz && ap.viz !== a.maskViz && typeof m.setVisualizer === 'function') { ap.viz = a.maskViz; try { m.setVisualizer(a.maskViz); look.viz = a.maskViz; } catch (e) { /* a name this mask does not have */ } }
    if (a.maskGifts && a.maskGifts !== S.giftsRev) {
      S.giftsRev = a.maskGifts;
      getJson('/api/vt/gifts').then((g) => { if (g && Array.isArray(g.rows) && S.mask) { S.rows = g.rows; S.mask.setGiftMap(g.rows); } });
    }
    if (a.maskRest && a.maskRest !== S.restRev) {
      S.restRev = a.maskRest;
      getJson('/api/vt/mask-rest').then((n) => { if (n && Array.isArray(n.lm) && S.mask) { S.neutral = n; S.mask.setNeutral(n); } });
    }
  }

  // ---------------------------------------------------------------- the face
  Boot.onBinary = (buf) => {
    const f = W.unpackFace(buf);
    if (!f) return;
    S.frames++;
    if (!S.mask || !S.a || !S.a.mask) return;
    let ok = false;
    try { ok = S.mask.frame(f.lm, f.bs, f.mat, { width: f.w || 1, height: f.h || 1 }, f.at); } catch (e) { ok = false; }
    if (ok) { S.faces++; S.faceN++; S.newFaceAt = f.at; if (S.log && S.log.faces.length < 20000) S.log.faces.push([f.at, epoch(), f.lm[3], f.lm[4]]); }
  };

  // ---------------------------------------------------------------- the music
  const fromList = (f) => ({ bass: f[0], mid: f[1], high: f[2], beat: f[3], kick: f[4], hit: f[5], level: f[6], bright: f[7] });
  /** the gift sounds must not move the mask: while one sounds, the music is held at what it was just before */
  function guard(f, now) {
    const H = S.held;
    if (!ownSound(now)) {
      const k = 0.03;
      H.bass += (f.bass - H.bass) * k; H.mid += (f.mid - H.mid) * k; H.high += (f.high - H.high) * k; H.level += (f.level - H.level) * k;
      return f;
    }
    S.guarded++;
    return { bass: Math.min(f.bass, H.bass), mid: Math.min(f.mid, H.mid), high: Math.min(f.high, H.high), beat: Math.min(f.beat, 0.15), kick: 0, hit: 0, level: Math.min(f.level, H.level), bright: f.bright };
  }
  function onAudio(m) {
    const now = performance.now();
    S.src = m.s === 'pc' || m.s === 'obs' ? m.s : 'voice'; S.srcAt = now;
    if (!Array.isArray(m.f) || m.f.length < 8 || !S.mask || !active()) return;
    const f = guard(fromList(m.f), now);
    shuffleStep(f, now);
    if (S.src === 'pc') { try { S.mask.audio(f); } catch (e) { /* the next one */ } }
    else { S.target = f; if (f.kick) S.kick = Math.max(S.kick, f.kick); }       // a level 20 times a second: eased in draw()
  }
  /**
   * V7 SHUFFLE TO THE BEAT: the music numbers go through the beat clock; on a phrase line (or a drop) the director
   * changes the look. Only from real music (what the PC plays, or the level OBS hears): never from his voice, never
   * while a gift is playing (mask.busy()), never while the music is silent. A colour he picked is never changed.
   */
  function shuffleStep(f, now) {
    const a = S.a, m = S.mask;
    if (!SH.sh || !m || !a) return;
    let acts = null;
    try {
      acts = SH.sh.push(f, now / 1000, {
        kind: 'mask', busy: typeof m.busy === 'function' ? m.busy() : false, mode: look.mode, home: a.maskMode, viz: look.viz, bg: look.bg, colour: look.colour,
        bgs: bgNames() || L.MASK_BACKGROUNDS, vizs: vizNames() || L.MASK_VISUALIZERS, colours: a.maskColour || Stage.KILL.colour || typeof m.setColour !== 'function' ? null : Beat.AUTO_COLOURS,
      });
    } catch (e) { acts = null; }
    if (!acts) return;
    for (const x of acts) {
      try {
        if (x.set === 'mode') m.setMode(x.value); else if (x.set === 'bg') m.setBackground(x.value); else if (x.set === 'viz') m.setVisualizer(x.value);
        else if (x.set === 'colour') m.setColour(x.value === 'auto' ? null : x.value, true);
        look[x.set] = x.value;
      } catch (e) { /* a look this mask does not have */ }
    }
    SH.changes++; SH.last = { at: Date.now(), why: acts.why, acts: acts.map((x) => x.set + '=' + x.value) };
    if (S.log && S.log.shuffles) S.log.shuffles.push([epoch(), acts.why, SH.last.acts.join(' ')]);
  }
  function onMic(m) {
    const now = performance.now();
    if (now - S.srcAt > 2500) S.src = 'voice';             // nothing from the app about the music (an older server): his voice
    if (S.src !== 'voice' || !active()) return;
    const f = guard(follower.push(Number(m.level) || 0, now / 1000), now);
    S.target = f; if (f.kick) S.kick = Math.max(S.kick, f.kick);
  }

  Boot.onAny = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'avatar') { const a = L.readAvatarMessage(m); if (a) { const was = active(); S.a = a; apply(); if (active() && !was) loop(); } }
    else if (m.t === 'mask-audio') onAudio(m);
    else if (m.t === 'mic') onMic(m);
    else if (m.t === 'mask-event') {
      if (!S.mask || !active() || !m.e || typeof m.e !== 'object') return;
      S.events++; S.lastEventAt = performance.now();
      try { S.mask.fire(m.e); } catch (e) { /* an event the mask does not know */ }
    }
  };

  // ---------------------------------------------------------------- drawing
  let looping = false;
  function names(list) {
    if (!namesEl) return;
    const n = list ? list.length : 0;
    while (namesEl.children.length > n) namesEl.lastChild.remove();
    while (namesEl.children.length < n) namesEl.appendChild(document.createElement('div'));
    for (let i = 0; i < n; i++) {
      const el = namesEl.children[i], it = list[i], age = Number(it.age) || 0;
      if (el.textContent !== it.text) el.textContent = String(it.text || '').slice(0, 60);
      el.className = it.kind === 'gift' ? 'gift' : 'join';
      el.style.opacity = String(Math.max(0, Math.min(1, age / 0.2, (2.5 - age) / 0.35)));
    }
  }
  function draw() {
    const now = performance.now(), m = S.mask;
    if (!m) return;
    if (S.src !== 'pc' && S.target) {                      // a level-only source: ease to it, a kick goes in once
      const c = S.cur, t = S.target, k = 0.45;
      c.bass += (t.bass - c.bass) * k; c.mid += (t.mid - c.mid) * k; c.high += (t.high - c.high) * k; c.level += (t.level - c.level) * k; c.beat = t.beat; c.bright = t.bright;
      try { m.audio({ ...c, kick: S.kick, hit: 0 }); } catch (e) { /* the next one */ }
      S.kick = 0;
    }
    let drew = false;
    try { drew = m.draw() !== false; } catch (e) { S.error = String(e && e.message ? e.message : e).slice(0, 160); }
    if (drew) {
      S.draws++; S.fpsN++;
      if (!S.drawnOnce) { S.drawnOnce = true; S.firstDrawAt = performance.now(); canvas.style.display = active() ? 'block' : 'none'; }
      // V7: the small picture for the VTuber window (only while it asks for it)
      if (S.a && S.a.pv && S.drawnOnce && active()) { const d = Stage.picture([{ canvas, mirror: !!S.a.mirror }], now); if (d) Boot.send({ t: 'avatar-ack', ready: true, on: S.a.on, character: S.a.character, mask: window.VTMaskPage.status(), fps: S.fps, w: canvas.width, h: canvas.height, at: Date.now(), pv: d }); }
      if (S.newFaceAt) { const d = epoch() - S.newFaceAt; S.lat.push(d); if (S.lat.length > 600) S.lat.splice(0, 300); if (S.log && S.log.draws.length < 20000) S.log.draws.push([S.newFaceAt, epoch()]); S.newFaceAt = 0; }
    }
    try { names(m.names()); } catch (e) { names(null); }
    if (now - S.fpsAt >= 1000) { const s = (now - S.fpsAt) / 1000; S.fps = Math.round(S.fpsN / s); S.faceHz = Math.round(S.faceN / s); S.fpsN = 0; S.faceN = 0; S.fpsAt = now; }
  }
  function loop() {
    if (looping) return;
    looping = true; S.fpsAt = performance.now(); S.fpsN = 0; S.faceN = 0;
    const step = () => {
      if (!active()) { looping = false; names(null); return; }
      draw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // not chosen for a minute: the mask gives its graphics memory back (the encoder next to it may want it)
  setInterval(() => { if (S.mask && S.unchosenAt && performance.now() - S.unchosenAt > 60000) { drop(); S.unchosenAt = 0; } }, 5000);
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!S.mask) return; const sz = size(); if (sz.width === canvas.width && sz.height === canvas.height) return; drop(); if (S.a && S.a.mask) make(); }, 400);
  });

  /** the Visualizer styles this mask offers (null = it has only the one): asked from mask/*, never guessed beyond its own list */
  function vizNames() {
    const m = S.mask;
    if (!m || typeof m.setVisualizer !== 'function') return null;
    let list = null;
    try { const st = m.stats(); list = (st && st.visualizers) || (window.VTMaskFx && window.VTMaskFx.VISUALIZERS) || null; } catch (e) { list = null; }
    if (!Array.isArray(list) || !list.length) list = ['orb', 'tunnel', 'yinyang'];
    return list.filter((n) => typeof n === 'string' && /^[a-z0-9-]{1,24}$/.test(n)).slice(0, 8);
  }
  /** the backgrounds this mask offers, from its own list (stats().backgrounds); null = an older mask that does not say */
  function bgNames() {
    let list = null;
    try { const st = S.mask ? S.mask.stats() : null; list = st && st.backgrounds; } catch (e) { list = null; }
    return Array.isArray(list) && list.length ? list.filter((n) => typeof n === 'string' && /^[a-z0-9-]{1,24}$/.test(n)).slice(0, 12) : null;
  }
  const q = (list, p) => { if (!list.length) return null; const s = list.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10; };
  window.VTMaskPage = {
    /** what the avatar page tells the app about the Mask once a second (inside its avatar-ack) */
    status() {
      let st = null;
      try { st = S.mask ? S.mask.stats() : null; } catch (e) { st = null; }
      return {
        ok: !!S.mask && !S.error, error: S.error || (S.mask ? '' : S.making ? 'loading' : ''), drawn: S.drawnOnce, faceHz: S.faceHz, sound: S.src,
        mode: st ? st.mode : '', bg: st ? st.background : '', rest: st ? st.neutral : 'none', drawMs: st ? Math.round(st.drawMs * 100) / 100 : 0, coreMs: st ? Math.round(st.coreMs * 100) / 100 : 0,
        w: canvas.width, h: canvas.height, lagMs: q(S.lat, 0.5), events: S.events,
        viz: vizNames(), bgs: bgNames(),
        // V7: what shows right now (shuffle may have changed it), and the shuffle's own state
        vizNow: st ? st.visualizer : '', colour: st ? st.colour || '' : '', place: st && st.place ? [st.place.zoom, st.place.x, st.place.y] : null,
        ...(SH.sh ? { shuffle: SH.amount, look: { ...look }, changes: SH.changes, bpm: SH.sh.beat && SH.sh.beat.locked ? Math.round(SH.sh.beat.bpm) : 0 } : null),
      };
    },
    fps: () => S.fps,
    /** for the proof tools only */
    debug: { S, q, SH, look, startLog() { S.log = { faces: [], draws: [], shuffles: [] }; }, takeLog() { const l = S.log; S.log = null; return l; }, get mask() { return S.mask; }, get canvas() { return canvas; } },
  };
  // the Mask answers the app by itself once a second (it does not wait for the heroes' big 3D files)
  setInterval(() => {
    const a = S.a;
    if (!a || !a.mask || Boot.MANUAL) return;
    Boot.send({ t: 'avatar-ack', ready: true, on: a.on, character: a.character, mask: window.VTMaskPage.status(), fps: S.fps, w: canvas.width, h: canvas.height, at: Date.now() });
  }, 1000);
  S.a = Boot.shown || Boot.initial;
  apply();
  if (active()) loop();
})();
