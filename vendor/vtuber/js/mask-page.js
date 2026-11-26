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
  const BURN = !!(L && L.v9Shows && L.v9Shows('bgburn'));   // V9 INTEGRATION: a change of background burns in behind a scan line while js/logic.js V9_SHOW names 'bgburn'
  const SP = window.VTShowPage || null;                    // V9 show opening (js/v9-show-page.js; not loaded or ?showopen=0 = none of it)
  // COUNTDOWN MUSIC (js/v9-countdown-music.js): while his countdown song plays, the Mask hears it from this page (WebAudio), not the loopback
  if (SP && SP.onMusic) SP.onMusic((f) => onAudio({ s: 'pc', own: true, f: [f.bass, f.mid, f.high, f.beat, f.kick, f.hit, f.level, f.bright] }));
  const SG = { status: () => (window.VTSignLayer && window.VTSignLayer.status ? window.VTSignLayer.status() : null) };      // V9 show sign + live overlay (js/v9-sign-layer.js, loaded after this file)

  // ---------------------------------------------------------------- V8: the puppet show (V8-PHASE2.md section A)
  // The show's brain (js/v8-show.js) runs HERE, next to the Mask: this page gets the tracker's raw face, the mic level,
  // the hand points, viewer events and LIVE Link's show state. The VTuber window only sends the switches (`v8` in the
  // `avatar` message) and commands ({ t: 'v8-cmd' }), and reads what this page reports back (`v8` in its answers).
  // Kill switches: ?v8=0 on this page, or a window that sends no `v8` field (an older page, or vtuber.html?v8=0): the
  // Mask is then made without its V8 stage at all (the V7 Mask, untouched).
  const hudEl = document.getElementById('maskhud');
  const V8 = { show: null, hud: null, on: false, status: null, key: '', ackAt: 0, over: null, lastShow: null, pics: new Map(), covers: new Map(), airId: '', nose: null, costMs: 0 };
  const wantV8 = (a) => !Stage.KILL.v8 && !!(a && a.mask && a.v8) && !!window.VTShow && !!window.VTMaskV8 && !!window.VTMaskHud;
  const tNow = () => (S.mask && S.mask.clock ? S.mask.clock() : performance.now() / 1000);
  /** a viewer's picture as something the 2D layer can draw at once: a small canvas with the placeholder on it; the real
   *  picture (through this server's own door, /api/pic: never from TikTok directly) is drawn over it when it has loaded */
  function pictureOf(viewer, url) {
    let p = V8.pics.get(viewer.id);
    if (!p) {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      p = { c, url: '', state: '' };
      try { const ph = window.VTMaskHud.placeholder(viewer.name); if (ph) c.getContext('2d').drawImage(ph, 0, 0, 96, 96); } catch (e) { /* a plain disc */ }
      V8.pics.set(viewer.id, p);
      if (V8.pics.size > 220) V8.pics.delete(V8.pics.keys().next().value);
    } else { V8.pics.delete(viewer.id); V8.pics.set(viewer.id, p); }
    if (url && url !== p.url && p.state !== 'loading') {
      p.url = url; p.state = 'loading';
      const im = new Image();
      im.onload = () => { try { const x = p.c.getContext('2d'), s = Math.min(im.naturalWidth, im.naturalHeight); x.clearRect(0, 0, 96, 96); x.drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, 0, 0, 96, 96); p.state = 'ok'; V8.picsOk = (V8.picsOk || 0) + 1; } catch (e) { p.state = 'bad'; } };
      im.onerror = () => { p.state = 'bad'; V8.picsBad = (V8.picsBad || 0) + 1; };      // the placeholder stays
      im.src = '/api/pic?u=' + encodeURIComponent(url);
    }
    return p.c;
  }
  /**
   * RELEASE A: a song's cover, loaded through this server's own door (/api/pic), kept PER SONG ID (fix round V-1: eating
   * song A after B went on air must not drop B's cover or its colour; the cover of a song may arrive on a later message
   * than the song itself). `then(C)` runs once when the picture is there, cannot be loaded, or is not given.
   * C.eat = a bite waiting for this picture (2.5 s at most: the Mask then eats a record, never nothing).
   */
  function loadCover(id, url, title, then) {
    const old = V8.covers.get(id);
    if (old && old.url === (url || '') && old.state !== 'none') { old.title = title || old.title; if (old.state === 'ok') then(old); else old.then = then; return old; }
    const C = { id, url: url || '', img: null, cols: [], state: url ? 'loading' : 'none', title: title || '', eat: old ? old.eat : null, then };
    V8.covers.delete(id); V8.covers.set(id, C); if (V8.covers.size > 6) V8.covers.delete(V8.covers.keys().next().value);
    const done = () => { const f = C.then; C.then = null; if (f && V8.covers.get(id) === C) f(C); if (C.eat) { const e = C.eat; C.eat = null; e(); } };
    if (!url) { const e = C.eat; C.eat = null; const f = C.then; C.then = null; if (f) f(C); if (e) e(); return C; }
    const im = new Image();
    im.onload = () => { if (C.state !== 'loading') return; C.img = im; try { C.cols = window.VTMaskV8.coverColours(im); } catch (e) { C.cols = []; } C.state = 'ok'; done(); };
    im.onerror = () => { if (C.state !== 'loading') return; C.state = 'none'; done(); };
    im.src = '/api/pic?u=' + encodeURIComponent(url);
    setTimeout(() => { if (C.state === 'loading' && C.eat) { const e = C.eat; C.eat = null; e(); } }, 2500);
    return C;
  }
  /** what only the page can do for the show: the song's cover (its colour at the start, eaten at the end), a size / colour for a while, a flare */
  function v8Acts(acts, m) {
    for (const x of acts) {
      if (x.do === 'cover') {
        // the song on air (or its cover, which LIVE Link may send a moment after the song): its colour only. Nothing is eaten here.
        V8.airId = x.id;
        loadCover(x.id, x.cover, x.title, (C) => { if (!S.mask || V8.airId !== C.id) return; try { S.mask.cover({ colours: C.cols, title: C.title }); } catch (e) { /* the next song */ } });
      } else if (x.do === 'eat') {
        // DONE / ADD TO AI RADIO / EAT IT: the Mask eats the cover of THAT song (a picture it could not get = a glowing record)
        const bite = (C) => { if (!S.mask) return; try { S.mask.eat({ image: C && C.state === 'ok' ? C.img : null, colours: C && C.state === 'ok' ? C.cols : [], title: x.title, grade: x.grade || null, wait: x.wait !== false }); } catch (e) { /* this one is not eaten */ } };
        let C = x.id ? V8.covers.get(x.id) || null : null;
        if (x.id && x.cover && (!C || (C.url !== x.cover && C.state !== 'ok'))) C = loadCover(x.id, x.cover, x.title, () => {});      // not seen on air by this page, or its cover only came now
        if (C && C.state === 'loading') C.eat = () => bite(C);                      // still on its way: when it is there (2.5 s at most)
        else bite(C);
      } else if (x.do === 'songOff') { V8.airId = ''; try { m.songOff(); } catch (e) { /* nothing on */ } }
      else if (x.do === 'over') { V8.over = { zoom: x.zoom || 0, colour: x.colour || '', until: performance.now() + (x.secs || 20) * 1000, ck: S.applied.colourOwn || '' }; S.applied.place = S.applied.colour = undefined; apply(); }
      else if (x.do === 'flare') { try { m.flare(); } catch (e) { /* no stage */ } }
    }
  }
  /** once per drawn frame, before the Mask draws: the show steps, the Mask is fed; what changed is told to the window */
  function v8Step(now) {
    const m = S.mask, show = V8.show; if (!m || !show) return;
    const b = performance.now();
    if (V8.over && now > V8.over.until) { V8.over = null; S.applied.place = S.applied.colour = undefined; apply(); }
    let st = null;
    try { st = show.step(m.clock()); const acts = show.takeActs(); if (acts.length) v8Acts(acts, m); } catch (e) { S.error = 'the puppet show: ' + String(e && e.message ? e.message : e).slice(0, 120); }
    V8.costMs += (performance.now() - b - V8.costMs) * 0.05;
    if (!st) return;
    V8.status = st;
    // told at once when something he can see on his buttons changed (a move, the fight, a vote, the song), at most 5 a second
    const key = [st.eat ? st.eat.state + (st.eat.busy ? 'b' : '') + (st.eat.eaten ? 'e' : '') : '', st.on, st.song, st.songSrc, st.attack, st.fight ? st.fight.phase + (st.fight.winner || '') : '', st.vote ? st.vote.active + st.vote.id : '', st.note, MOVES8.map((k) => (st.moves[k].on ? 'o' : st.moves[k].cool > 0 ? 'c' : '-') + st.moves[k].why).join('')].join('|');
    if (key !== V8.key && now - V8.ackAt > 200) { V8.key = key; V8.ackAt = now; ack(); }
  }
  const MOVES8 = ['goo', 'fire', 'melt', 'crack', 'eat'];
  function ack() { const a = S.a; if (!a || !a.mask || Boot.MANUAL) return; Boot.send({ t: 'avatar-ack', ready: true, on: a.on, character: a.character, mask: window.VTMaskPage.status(), fps: S.fps, w: canvas.width, h: canvas.height, at: Date.now() }); }

  // ---------------------------------------------------------------- V9 CAMERA MODE (mask/mask-cam.js, V9-PHASE2-SHOW.md item 1)
  // `camMode` in the avatar message (V9 INTEGRATION: it was `maskCam: true`; `maskCam` is the smart camera's field): his real camera is the picture. The Mask's canvas fades out (this page is see-through
  // under it, so his camera shows), and only the effects are drawn, on a see-through canvas of their own that is NEVER
  // mirrored (it must sit on the camera picture viewers see). Nothing here runs until the message asks for it.
  // While it is on, the puppet show (V8) rests: events go straight to the effects (its fights on his face come later).
  const camEl = document.getElementById('maskcam');
  const CAM = { c: null, on: false, op: '', show: 0, ak: '' };
  function camApply(a, m) {
    const want = a.camMode === true;
    if (!CAM.c) {
      if (!want || !camEl || typeof m.camera !== 'function') return;
      const c = m.camera(); if (!c) return;
      camEl.width = canvas.width; camEl.height = canvas.height;
      if (!c.layer(camEl)) return;
      CAM.c = c; CAM.on = false; CAM.ak = ''; CAM.show = a.camShow || 0;
    }
    const c = CAM.c, ak = JSON.stringify(a.camAlign || null);
    if (CAM.ak !== ak) { CAM.ak = ak; c.align(a.camAlign || null); }
    // (camera mode already on when the page comes up: the Mask is never shown first, so there is nothing to fade from)
    // (V9 INTEGRATION, the pair v9-cam x v9-sign, review I2: camera mode switching holds what the Mask's 2D layer shows right now (a vote, the fight, an eat), so the sign does not stay aside for it; off counts them all again)
    if (want !== CAM.on) { CAM.on = want; c.set(want, m.clock() - (want && !S.drawnOnce ? 5 : 0)); if (want && SP && SP.musicStop) SP.musicStop(); if (window.VTSignLayer && window.VTSignLayer.clearTriggers) window.VTSignLayer.clearTriggers(want); }      // (V9 INTEGRATION, the pair v9-cam x countdown music: camera mode on mid-countdown, the Mask and its card fade, so its song fades too, 0.5 s, as when the Mask is switched off)
    const sh = a.camShow || 0;
    if (sh !== CAM.show) { CAM.show = sh; if (want) c.showAlign(m.clock(), 8); }      // the Align button: a thin outline on his tracked face for 8 s
  }
  /** after each drawn frame: the Mask's own canvas (and the show's 2D layer) fade with the change, the effects canvas shows */
  function camFade(m) {
    if (!CAM.c) return;
    const k = CAM.c.k(m.clock()), op = k <= 0 ? '' : String(Math.round((1 - k) * 1000) / 1000);
    if (op !== CAM.op) { CAM.op = op; canvas.style.opacity = op; if (hudEl) hudEl.style.opacity = op; }
    const vis = active() && S.drawnOnce ? 'block' : 'none';
    if (camEl.style.display !== vis) camEl.style.display = vis;
  }
  /** camera mode: the viewer names are shown one at a time in one lane just under his chin (mask-cam.js callout), never stacked at the top where his show banner is */
  function camNames(c) {
    if (!namesEl) return;
    names(c ? [{ text: c.text, kind: c.kind, age: 1 }] : null);
    if (c) { CAM.lane = true; namesEl.style.top = (c.fy * 100).toFixed(2) + '%'; namesEl.style.transform = 'translateX(' + ((c.fx - 0.5) * 100).toFixed(2) + '%)'; namesEl.firstChild.style.opacity = String(c.a); }
  }
  function camDrop() { CAM.c = null; CAM.on = false; CAM.op = ''; if (camEl) camEl.style.display = 'none'; if (hudEl) hudEl.style.opacity = ''; }

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
      V8.on = wantV8(a);
      S.mask = window.VTMaskLive.create(canvas, { neutral: S.neutral, bsNames: W.BS_NAMES, width: sz.width, height: sz.height, giftMap: S.rows || undefined, giftSounds: a.maskSounds !== false, background: a.maskBg || 'black', eyeLock: a.eyes !== false, v8: V8.on });
      if (window.VTMaskCables) window.VTMaskCables.attach(S.mask);      // V9 cables: the show's hype rank (mask.setHype, mask.hypePlus) reaches the cable looks
      S.applied = { mode: 'face', bg: a.maskBg || 'black', sounds: a.maskSounds !== false, viz: '', eyes: a.eyes !== false };
      // V8: the show's brain and the 2D layer over the Mask (bars, pictures, the vote: everything that is read)
      V8.show = null; V8.hud = null; V8.status = null; V8.key = '';
      if (V8.on && hudEl) {
        hudEl.width = sz.width; hudEl.height = sz.height;
        V8.hud = window.VTMaskHud.create(hudEl, { layout: 'stack' });
        V8.show = window.VTShow.create({ mask: S.mask, engines: { VTBoss: window.VTBoss, VTFaceTriggers: window.VTFaceTriggers, VTVotes: window.VTVotes, VTHandPuppets: window.VTHandPuppets }, bsNames: W.BS_NAMES, seed: (Date.now() & 0x7fffffff) || 1, pictureOf, bossParams: window.__v8BossParams || null, voteSeconds: Number(window.__v8VoteSecs) || 0 });      // (the two window.__v8... values: proof tools only, e.g. a shorter fight for a clip; never set by the product)
        if (V8.lastShow && Date.now() - V8.lastShow.rx < 15000) V8.show.setShow(V8.lastShow.s, S.mask.clock());
      } else if (hudEl) { try { hudEl.getContext('2d').clearRect(0, 0, hudEl.width, hudEl.height); } catch (e) { /* nothing drawn */ } }
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
    const m = S.mask; S.mask = null; camDrop();
    V8.show = null; V8.hud = null; V8.status = null; V8.over = null; if (hudEl) hudEl.style.display = 'none';
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
    if (camEl && !active()) camEl.style.display = 'none';      // V9 camera mode: its canvas goes with the Mask
    // V8: the 2D layer shows with the Mask and is NEVER flipped (its words must read right; Mirror flips the Mask only)
    if (hudEl) hudEl.style.display = active() && S.mask && S.drawnOnce && V8.on ? 'block' : 'none';
    // (COUNTDOWN MUSIC: the Mask turned OFF mid-countdown, its song fades out too, 0.5 s, as when switched away; only on
    // that edge of the avatar message, never on a rebuild: drop() / make() leave S.a as it is)
    const act = active(); if (S.wasActive && !act && SP && SP.musicStop) SP.musicStop(); S.wasActive = act;
    // (COUNTDOWN MUSIC: switched away from the Mask, its countdown song fades out with it, 0.5 s)
    if (!a || !a.mask) { if (!S.unchosenAt) { S.unchosenAt = performance.now(); if (SP && SP.musicStop) SP.musicStop(); } return; }
    S.unchosenAt = 0;
    if (!m) { make(); return; }
    // the puppet show was switched in or out as a whole (?v8=0, or a window that knows nothing of it): the Mask is made again
    if (wantV8(a) !== V8.on && !S.making) { drop(); make(); return; }
    const ap = S.applied;
    if (V8.show) {
      const v = a.v8 || {}, vk = [v.on, v.chat, v.hands, v.rand, v.bars, v.swap, v.orbit, !!a.mirror].join('|');
      if (ap.v8 !== vk) { ap.v8 = vk; V8.show.settings(v); try { m.setBars(v.bars || 0); m.setMirror(!!a.mirror); } catch (e) { /* an older mask */ } }
    }
    // V7: he picked something himself while shuffle runs (`pick` went up), or shuffle was switched on / off: everything
    // the message says is shown again (his picks), and shuffle goes on from there
    const wantSh = !Stage.KILL.shuffle && Beat && a.on && a.shuffle ? a.shuffle : '';
    if ((a.pick || 0) !== SH.pick || wantSh !== SH.amount) {
      if (wantSh !== SH.amount) { SH.sh = wantSh ? Beat.createShuffle({ amount: wantSh, seed: (Date.now() & 0xffff) || 1 }) : null; SH.amount = wantSh; }
      SH.pick = a.pick || 0;
      ap.mode = ap.bg = ap.viz = ap.colour = undefined;
    }
    if (ap.mode !== a.maskMode) { ap.mode = a.maskMode; m.setMode(a.maskMode); look.mode = a.maskMode; }
    if (ap.bg !== a.maskBg) { const first = ap.bg === undefined, to = a.maskBg; ap.bg = to; if (SP && BURN && !first && S.drawnOnce) SP.swap(() => m.setBackground(to)); else m.setBackground(to); look.bg = to; }      // (V9 show opening: a change of background burns in behind a scan line, never a cut)
    // V7: where the face sits and how big (the canvas is flipped as a whole when Mirror is on, so left-right is flipped back)
    // V8: a vote's winner may change his size ("shrink him to an inch", "make him HUGE") or his colour for a while (V8.over)
    const ov = V8.over, oz = ov && ov.zoom ? ov.zoom : 0;
    const pz = Stage.KILL.place ? 1 : a.zoom, px = Stage.KILL.place ? 0 : (a.mirror ? -1 : 1) * (a.offsetX || 0), py = Stage.KILL.place ? 0 : Math.min(a.offsetY, L.placeUp ? L.placeUp('mask') : 0.45), pk = pz + '|' + px + '|' + py + '|' + oz;
    if (ap.place !== pk && typeof m.setPlace === 'function') { ap.place = pk; m.setPlace(oz ? { zoom: oz < 1 ? oz : Math.min(2, Math.max(pz, 1) * oz), x: oz < 1 ? px : px * 0.4, y: oz < 1 ? py : py * 0.4 } : { zoom: pz, x: px, y: py }); }
    // V7: a colour he picked (not there = Auto) and whether the music still moves it
    const own = Stage.KILL.colour ? '' : (a.maskColour || '');
    // (a colour he picks himself on the card while a voted colour shows wins at once: the voted one is dropped)
    if (ov && ov.colour && own !== ov.ck) { ov.colour = ''; }
    ap.colourOwn = own;
    const col = ov && ov.colour ? ov.colour : own, ck = col + '|' + (a.maskColourMusic !== false);
    if (ap.colour !== ck && typeof m.setColour === 'function') { ap.colour = ck; m.setColour(col || null, a.maskColourMusic !== false); look.colour = 'auto'; }
    if (ap.eyes !== (a.eyes !== false) && typeof m.setEyeLock === 'function') { ap.eyes = a.eyes !== false; m.setEyeLock(ap.eyes); }      // eyes on camera (round 5)
    if (ap.sounds !== a.maskSounds) { ap.sounds = a.maskSounds; m.setGiftSounds(a.maskSounds); }
    // V9: a style on top of the Mask (no field = classic). Only asked of a mask that has styles; the mask transforms, never cuts.
    // V9 HYPE: the look of the hype-bar ranks (no field = Aura to Nebula, the show's own; 'classic' = the old ladder)
    const hys = a.hypeStyle || 'nebula';
    if (ap.hype !== hys && typeof m.setHypeStyle === 'function') { ap.hype = hys; try { m.setHypeStyle(hys); } catch (e) { /* a mask without the hype looks */ } }      // (what really draws is told back: status().hype)
    const stl = a.maskStyle || 'classic';
    if ((ap.style || 'classic') !== stl && typeof m.setStyle === 'function') { ap.style = stl; try { m.setStyle(stl); } catch (e) { /* a style this mask does not have */ }
      // V9 cables: a cable look brings the stream between his hands (the hands layer's effect; it floats at the chest when no hand is up)
      const cab = window.VTMaskCables && window.VTMaskCables.LOOKS[stl] ? window.VTMaskCables.LOOKS[stl] : null;
      if (typeof m.handsFx === 'function' && (cab || S.cableLook)) { try { m.handsFx(!!cab, cab ? { effect: cab.effect } : undefined); } catch (e) { /* no hands layer on this page */ } }
      S.cableLook = !!cab;
    }
    // V9 SMART CAMERA: the virtual camera that cuts with the music (no field = off = the Mask's own camera, untouched)
    const camOn = a.maskCam === 'smart';
    if (!!ap.cam !== camOn && typeof m.smartCam === 'function') { ap.cam = camOn; try { S.cam = m.smartCam(camOn); } catch (e) { S.cam = null; /* a mask without the camera */ } }
    camApply(a, m);                                        // V9 CAMERA MODE (no `camMode` field ever = nothing of it is made)
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
    const held = !!(SP && SP.holdsFace && SP.holdsFace());  // countdown 2.0: while the Mask sleeps it wears the sleeping face (js/v9-show-page.js)
    if (!held) { try { ok = S.mask.frame(f.lm, f.bs, f.mat, { width: f.w || 1, height: f.h || 1 }, f.at); } catch (e) { ok = false; } }
    if (SP) SP.face(f.lm, f.w, f.h, f.bs, f.mat);           // V9 show opening: where his real face is (only kept while it is needed)
    if (CAM.on && CAM.c && f.lm) { try { CAM.c.face(f.lm, f.w || 1, f.h || 1); } catch (e) { /* the outline only */ } }      // V9 camera mode: the raw points, for the Align outline
    if (ok) { S.faces++; S.faceN++; S.newFaceAt = f.at; if (S.log && S.log.faces.length < 20000) S.log.faces.push([f.at, epoch(), f.lm[3], f.lm[4]]); }
    // V8: his REAL face is the boss's controller (mouth wide = eat, a head turn = dodge, a pucker = the shield ...)
    if (V8.show) { try { V8.nose = f.lm ? [f.lm[3], f.lm[4]] : null; V8.show.face(f.lm ? { bs: f.bs, mat: f.mat, lm: f.lm } : null, S.mask.clock()); } catch (e) { /* the next frame */ } }
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
    if (!m.own && SP && SP.musicOwns && SP.musicOwns()) return;      // COUNTDOWN MUSIC: the song is heard from this page meanwhile
    S.src = m.s === 'pc' || m.s === 'obs' ? m.s : 'voice'; S.srcAt = now;
    if (!Array.isArray(m.f) || m.f.length < 8 || !S.mask || !active()) return;
    // V8: the Mask's own ear for "is a song playing?" (only used while LIVE Link says nothing): the PC's sound level,
    // never while one of the Mask's own sounds is playing
    if (V8.show && !ownSound(now)) V8.show.ear(Number(m.f[6]) || 0, S.src, S.mask.clock());
    const f = guard(fromList(m.f), now);
    shuffleStep(f, now);
    if (SP) SP.audio(f, S.mask.clock());                   // V9 show opening: the beat its zero and its impact land on
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
        if (x.set === 'mode') m.setMode(x.value); else if (x.set === 'bg') { const to = x.value; if (SP && BURN && S.drawnOnce) SP.swap(() => m.setBackground(to)); else m.setBackground(to); } else if (x.set === 'viz') m.setVisualizer(x.value);
        else if (x.set === 'colour') m.setColour(x.value === 'auto' ? null : x.value, true);
        look[x.set] = x.value;
      } catch (e) { /* a look this mask does not have */ }
    }
    SH.changes++; SH.last = { at: Date.now(), why: acts.why, acts: acts.map((x) => x.set + '=' + x.value) };
    if (S.log && S.log.shuffles) S.log.shuffles.push([epoch(), acts.why, SH.last.acts.join(' ')]);
  }
  function onMic(m) {
    const now = performance.now();
    if (V8.show && S.mask) V8.show.mic(Number(m.level) || 0, S.mask.clock());      // V8: a real yell = the scream (with a wide jaw)
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
      // V8: the show takes it first (a tap = a missile in a fight, a comment = a vote or a chat word, a gift = a weapon
      // or a move); `v4` says whether the Mask's older gift effect plays as well (not in a fight)
      let v4 = true;
      if (SP) SP.event(m.e);                               // V9 show opening: taps and gifts charge the countdown card's meter
      if (V8.show && !CAM.on) { try { v4 = V8.show.event(m.e, S.mask.clock()).v4 !== false; } catch (e) { v4 = true; } }
      if (v4) { try { S.mask.fire(m.e); } catch (e) { /* an event the mask does not know */ } }
    }
    // V8: a button / key on the VTuber window, or one of LIVE Link's global keys. (Release A: EAT IT comes this way too and
    // works with the Puppet show switched off: the show's brain is there whenever the Mask is, and takes 'eat' first.)
    else if (m.t === 'v8-cmd') { if (V8.show && S.mask && active() && !CAM.on) { try { V8.show.cmd(m, S.mask.clock()); } catch (e) { /* one press lost */ } } }
    // V8: LIVE Link's show state (song on air, its cover, the hype rank, his score). Older than 15 s = not believed.
    else if (m.t === 'v8-show') { if (m.s && typeof m.s === 'object' && typeof m.rx === 'number' && Date.now() - m.rx < 15000) { V8.lastShow = { s: m.s, rx: m.rx }; if (SP) SP.show(m.s); if (V8.show && S.mask) V8.show.setShow(m.s, S.mask.clock()); } }
    // V9 SHOW OPENING (js/v9-show-page.js): the countdown card, the transform between his real face and the Mask
    else if (m.t === 'show-cmd') { if (SP && S.mask && active() && L.v9Shows('countdown') && !CAM.on) {      // (V9 INTEGRATION: not in camera mode: the card and the transform need the Mask's own picture, which camera mode does not draw)
      try { SP.cmd(m, S.mask, canvas, { neutral: S.neutral, bsNames: W.BS_NAMES }); } catch (e) { /* one press lost */ } } }
    // V8: the hand model's raw result, for the angel / devil puppets (the tracker sends it only while the switch is on)
    else if (m.t === 'v8-hands') { if (S.cableLook && S.mask && active() && Array.isArray(m.hands) && typeof S.mask.handsInput === 'function') { try { S.mask.handsInput(m.hands.slice(0, 2), { aspect: m.w && m.h ? m.w / m.h : 0.5625 }); } catch (e) { /* the next one */ } }      // V9 cables: his hands drive the stream
      if (V8.show && S.mask && active() && Array.isArray(m.hands)) { try { V8.show.hands(m.hands.slice(0, 2), { aspect: m.w && m.h ? m.w / m.h : 0.5625, face: V8.nose }, S.mask.clock()); } catch (e) { /* the next one */ } } }
    // COUNTDOWN MUSIC: the Mask is OFF (V9 INTEGRATION: or in camera mode, which drops the other show commands): Stop, "Fade music out" and the music switch still reach its song (and never start it)
    if (m.t === 'show-cmd' && SP && (!(S.mask && active()) || CAM.on) && (m.do === 'stop' || m.do === 'music' || m.do === 'musicFade')) { try { if (S.mask) SP.cmd(m, S.mask, canvas, { neutral: S.neutral, bsNames: W.BS_NAMES, maskOff: true }); else if (SP.musicStop && !(m.do === 'music' && m.on === true)) SP.musicStop(); } catch (e) { /* one press lost */ } }
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
  // V9 SMART CAMERA: the camera stands straight on while a countdown runs: the show opening's countdown card, its transform,
  // the Mask asleep before it wakes (js/v9-show-page.js, when the page has it). Looked at ten times a second.
  const CD = { at: -1e9, on: false, cam: null };
  function camCountdown(now) {
    if (now - CD.at < 100 && CD.cam === S.cam) return;
    CD.at = now;
    let on = false;
    try { const P = window.VTShowPage, st = P && typeof P.status === 'function' ? P.status() : null; on = !!(st && (st.state === 'card' || st.running || (st.c2 && st.c2.hold))); } catch (e) { on = false; }
    if (on !== CD.on || CD.cam !== S.cam) { CD.on = on; CD.cam = S.cam; try { S.cam.aside('countdown', on); } catch (e) { /* an older camera */ } }
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
    if (!CAM.on) v8Step(now);                                           // V8: the show steps and feeds the Mask before it draws
    if (S.applied.cam && S.cam && S.cam.on) camCountdown(now);      // V9 SMART CAMERA: straight on while a countdown runs
    let drew = false;
    if (SP && SP.beforeDraw) { try { SP.beforeDraw(m); } catch (e) { /* his own face then */ } }      // countdown 2.0: the sleeping face goes in (nothing unless it sleeps)
    try { drew = m.draw() !== false; } catch (e) { S.error = String(e && e.message ? e.message : e).slice(0, 160); }
    if (drew && SP) { try { SP.afterDraw(m, canvas, { mirror: !!(S.a && S.a.mirror) }); } catch (e) { /* the Mask goes on without the show layer */ } }      // V9 show opening (does nothing until a show-cmd came)
    if (drew) {
      S.draws++; S.fpsN++;
      if (!S.drawnOnce) { S.drawnOnce = true; S.firstDrawAt = performance.now(); canvas.style.display = active() ? 'block' : 'none'; if (hudEl) hudEl.style.display = active() && V8.on ? 'block' : 'none'; }
      // V8: the 2D layer (never flipped; with Mirror on, what rides on the Mask's picture has its x flipped to follow)
      if (V8.hud) { try { const b = performance.now(); V8.hud.draw(m.hud(), { mirror: !!(S.a && S.a.mirror), barsY: S.a && S.a.v8 ? S.a.v8.bars || 0 : 0 }); V8.hudMs = (V8.hudMs || 0) + (performance.now() - b - (V8.hudMs || 0)) * 0.05; } catch (e) { /* the next frame */ } }
      // V7: the small picture for the VTuber window (only while it asks for it)
      if (S.a && S.a.pv && S.drawnOnce && active()) { const d = Stage.picture(V8.hud && hudEl ? [{ canvas, mirror: !!S.a.mirror }, { canvas: hudEl, mirror: false }] : [{ canvas, mirror: !!S.a.mirror }], now); if (d) Boot.send({ t: 'avatar-ack', ready: true, on: S.a.on, character: S.a.character, mask: window.VTMaskPage.status(), fps: S.fps, w: canvas.width, h: canvas.height, at: Date.now(), pv: d }); }
      if (S.newFaceAt) { const d = epoch() - S.newFaceAt; S.lat.push(d); if (S.lat.length > 600) S.lat.splice(0, 300); if (S.log && S.log.draws.length < 20000) S.log.draws.push([S.newFaceAt, epoch()]); S.newFaceAt = 0; }
    }
    camFade(m);                                            // V9 camera mode: the Mask's canvas fades out / in with the change
    try { if (CAM.on && CAM.c) camNames(CAM.c.callout(m.names(), m.clock())); else { if (CAM.lane) { CAM.lane = false; namesEl.style.top = ''; namesEl.style.transform = ''; } names(m.names()); } } catch (e) { names(null); }      // (V9 camera mode: one name at a time, under his chin)
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
        hype: S.mask && typeof S.mask.hypeStyle === 'function' ? S.mask.hypeStyle() : 'classic',      // V9 HYPE: the look that is really drawing (classic when the asked one could not start)
        vizNow: st ? st.visualizer : '', colour: st ? st.colour || '' : '', place: st && st.place ? [st.place.zoom, st.place.x, st.place.y] : null,
        ...(SP ? { show: SP.status() } : null),
        ...(SG && SG.status && SG.status() ? { sign: SG.status() } : null),      // V9 show sign + live overlay: what the layer is doing (not there while both are off)
        ...(SH.sh ? { shuffle: SH.amount, look: { ...look }, changes: SH.changes, bpm: SH.sh.beat && SH.sh.beat.locked ? Math.round(SH.sh.beat.bpm) : 0 } : null),
        // V8: what the puppet show is doing (cooldowns, the fight, the vote, why a button is grey), for the VTuber window
        ...(CAM.c ? { cam: { on: CAM.on, ...(st && st.camera ? { k: Math.round(st.camera.k * 100) / 100, ms: Math.round(st.camera.ms * 100) / 100, align: st.camera.align } : null) } } : null),      // V9 camera mode
        ...(V8.show && V8.status ? { v8: { ...V8.status, counts: undefined, ms: Math.round(((V8.costMs || 0) + (V8.hudMs || 0)) * 100) / 100, pics: [V8.picsOk || 0, V8.picsBad || 0] } } : null),
      };
    },
    fps: () => S.fps,
    /** V9 show sign: what the 2D layer is about to draw (the vote, the fight, the eat, the rank banner), so the sign can step aside; null without the puppet show's stage */
    hud: () => { try { return S.mask && V8.on ? S.mask.hud() : null; } catch (e) { return null; } },
    /** for the proof tools only */
    debug: { S, q, SH, look, V8, CAM, startLog() { S.log = { faces: [], draws: [], shuffles: [] }; }, takeLog() { const l = S.log; S.log = null; return l; }, get mask() { return S.mask; }, get canvas() { return canvas; } },
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
