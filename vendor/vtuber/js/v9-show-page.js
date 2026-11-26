// V9 SHOW OPENING on the avatar page (V9-SHOW-OPEN.md): the countdown card and the transform, next to the Mask.
// js/mask-page.js calls in here at five places (each one line, each only when this file is loaded):
//   VTShowPage.cmd(m, mask, canvas)      { t: 'show-cmd', do: 'countdown' (minutes | seconds) | 'transform' | 'toMask' | 'toReal' | 'stop' }
//   VTShowPage.event(e)                  a viewer event: taps and gifts charge the card's meter (while the card is up)
//   VTShowPage.audio(f, t)               the music numbers: the beat the zero and the impact land on
//   VTShowPage.face(lm, w, h)            the tracker's raw face points (where his REAL face is in the camera picture)
//   VTShowPage.show(s)                   LIVE Link's show state; a `queue` list in it ([{ title, artist, cover }]) fills the card's queue panel
//   VTShowPage.swap(fn)                  a change of background: the old picture burns into the new one behind a scan line
//   VTShowPage.afterDraw(mask, canvas, o)   right after the Mask drew: the show layer reads its picture and draws
// A hand gesture (v9-hands) fires the same thing as the button: VTShowPage.fire() (or window.VTShowFire()).
//
// Until a command (or a change of background) comes, nothing is drawn and neither the Mask nor its canvas is touched.
// The one thing done unasked: about a second after the Mask's first picture the show layer is made, hidden, and every
// shader in it is used once (so the first burn of a show never stalls).
// States: 'off' (the Mask as always) -> 'card' (the countdown) -> 'real' (his camera shows: the Mask's canvas is held
// invisible, the Mask keeps tracking under it) -> transform -> 'off'. And from 'off', the button goes back to 'real'.
// His camera never comes into this page: "real" is this page being see-through over the camera source in OBS.
// Kill switch: avatar.html?showopen=0.
//
// COUNTDOWN 2.0 (review/V9-COUNTDOWN-NOTES.md): when js/v9-countdown.js, js/v9-countdown-card.js and the cable look
// (with its wake hook) are loaded, the countdown card is the Quantum Flow Mask asleep that fills with light as the clock
// runs down (taps and gifts run in along its cables), and comes alive at the zero; then the same hand-over as before.
// Four more calls from js/mask-page.js (each guarded there): VTShowPage.holdsFace() (while the Mask sleeps, its face
// is the sleeping face this file makes, not his tracked one), VTShowPage.beforeDraw(mask) (that face goes in),
// face(lm, w, h, bs, mat) (where his real face sits, so the sleeping one sits there too) and cmd's 4th argument
// { neutral, bsNames } (his resting face). Without those files, or with avatar.html?countdown=classic: the old card.
//
// COUNTDOWN MUSIC (js/v9-countdown-music.js, review/V9-COUNTDOWN-NOTES.md "The music"): a countdown command with
// `music: { on: true, vol }` plays his countdown song under it, its drop heard exactly at the zero (then it plays out);
// { do: 'music', on, vol } switches it / sets its volume mid-run, { do: 'musicFade' } fades it out over 3 s, a stop fades
// it out over 0.5 s. While it plays for this countdown the zero is held on its own time (never moved onto a heard beat)
// and the Mask hears the song from this page: VTShowPage.onMusic(fn) gets its numbers, musicOwns() says when (two more
// calls from js/mask-page.js). No `music` in the command, or music off: nothing of it runs, exactly as before.
(function (root) {
  'use strict';
  const Open = root.VTShowOpen, doc = root.document;
  if (!Open || !doc || /[?&]showopen=0(?:&|$)/.test(root.location ? root.location.search : '')) return;
  const CARD_PLACE = { zoom: 0.62, x: 0, y: 0.045 };
  // countdown 2.0: the Mask bigger (its cables leave the picture), the zero held this long before the hand-over
  const C2 = root.VTCountdown2, CLASSIC2 = /[?&]countdown=classic(?:&|$)/.test(root.location ? root.location.search : ''), CARD2_PLACE = { zoom: 0.78, x: 0, y: 0.005 }, ALIVE_HOLD = 1.5;
  const cables = () => { const c = root.VTMaskCables; return c && typeof c.wake === 'function' ? c : null; };
  const canMode2 = () => !!(C2 && cables() && root.VTCountdownCard && !CLASSIC2);
  const S = { state: 'off', cd: null, tf: Open.createTransform(), gl: null, card: null, showEl: null, cardEl: null, clock: null, beat: null, pulse: 0, face: null, queue: [], covers: new Map(), power: 0, style: 'classic', place: null, idle: 0, warmTried: false, queued: false, lastT: 0, error: '', fired: 0, cdFired: false, map: null, lastImpact: null, m2: null, card2: null, home: null, lastLive: null };

  function layers(canvas) {
    if (S.gl) return true;
    try {
      const mk = (id, z) => { const c = doc.createElement('canvas'); c.id = id; c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:none;pointer-events:none;z-index:' + z; (canvas.parentNode || doc.body).appendChild(c); return c; };
      S.showEl = mk('showc', 4); S.cardEl = mk('showcard', 5);
      S.gl = root.VTMaskShow.create(S.showEl, { width: canvas.width, height: canvas.height });
      S.card = root.VTShowCard.create(S.cardEl, { width: canvas.width, height: canvas.height });
      S.gl.warm(canvas);                                   // every shader is used once, unseen: no stall at the first burn of a show
      return true;
    } catch (e) { S.error = String(e && e.message ? e.message : e).slice(0, 160); S.gl = null; return false; }
  }
  const beatInfo = () => S.beat;
  // COUNTDOWN MUSIC: the engine is made the first time a countdown asks for the music (never before)
  const CM = root.VTCountdownMusic;
  Object.assign(S, { music: null, musicOpt: { on: false, vol: 0.6 }, musicSink: null, clockMask: null });
  const cleanMusic = (x) => ({ on: !!(x && typeof x === 'object' && x.on === true), vol: x && Number.isFinite(Number(x.vol)) ? Math.min(1, Math.max(0, Number(x.vol))) : 0.6 });
  function music(mask) {
    if (mask) S.clockMask = mask;
    if (!S.music && CM) { try { S.music = CM.create({ clock: () => (S.clockMask ? S.clockMask.clock() : 0), onFrame: (f) => { if (S.musicSink) S.musicSink(f); } }); } catch (e) { S.music = null; } }
    return S.music;
  }
  /** COUNTDOWN MUSIC: while his song plays for this countdown, the zero is its own time (the drop is heard there) */
  function beatFor(t) {
    const cd = S.cd, M = S.music, end = cd ? cd.endAt : null;
    if (M && cd && cd.state.ticks[0] === null && t >= end - 0.65 && M.aims(end)) return { locked: true, period: 1, last: end, inBar: 0 };
    return beatInfo();
  }
  function fire(kind, mask) {
    const t = mask.clock(); S.lastT = t;
    const r = S.tf.fire(kind, t, { beat: beatInfo(), power: S.power, lead: kind === 'cardToReal' ? 1.1 : null });
    if (r) S.fired++;
    return !!r;
  }
  /** the one button (and the hand gesture): his real face -> the Mask, or the Mask -> his real face */
  function toggle(mask, canvas) {
    if (!mask || !layers(canvas)) return false;
    if (S.state === 'card' && !S.cdFired) return false;        // the countdown ends at its own time
    // pressed while a transform runs: the press is kept and fires the moment this one has landed (a second press takes it back)
    if (S.tf.running || S.state === 'card') { S.queued = !S.queued; return true; }
    if (S.state === 'real') return fire('toMask', mask);
    try { S.style = mask.styleStats().style || 'classic'; } catch (e) { S.style = 'classic'; }
    return fire('toReal', mask);
  }
  function stop(mask, canvas) {
    if (S.music) { try { S.music.stop(0.5); } catch (e) { /* silent */ } }      // COUNTDOWN MUSIC
    S.tf.cancel(); S.cd = null; S.cdFired = false; S.queued = false;
    release2();
    if (S.state === 'card' && mask) { try { mask.setPlace(S.place); } catch (e) { /* home */ } }
    if (S.state !== 'off' && mask) { try { mask.setStyle(S.style); } catch (e) { /* classic */ } }
    S.state = 'off';
    if (S.gl) S.gl.clear(); if (S.card) S.card.clear();
    if (S.showEl) S.showEl.style.display = 'none'; if (S.cardEl) { S.cardEl.style.display = 'none'; S.cardEl.style.clipPath = ''; }
    if (canvas) canvas.style.opacity = '';
  }
  // ---------------------------------------------------------------- countdown 2.0
  /** his resting face for the sleeping one: the saved one, else made from his last tracked frame (as the Mask itself does) */
  function neutralFor(o) {
    if (o && o.neutral && o.neutral.lm && o.neutral.lm.length >= 478 * 3) return o.neutral.lm;
    const Lv = S.lastLive, Core = root.VTMaskCore;
    if (Lv && Core && o && Array.isArray(o.bsNames)) { try { const f = { lm: Lv.lm, bs: Lv.bs, mat: Lv.mat }; return Core.calibrate([f, f, f, f, f, f, f, f], o.bsNames, { width: Lv.w, height: Lv.h }).lm; } catch (e) { /* no resting face */ } }
    return null;
  }
  function start2(m, mask, o, carry) {
    const K = cables(); let ok = false;
    // the 2.0 card first: if it cannot be made, the old card and the Mask as it is (never the old card over the 2.0 Mask)
    if (!S.card2) { try { S.card2 = root.VTCountdownCard.create(S.cardEl, { width: S.cardEl.width, height: S.cardEl.height }); } catch (e) { S.card2 = null; S.error = 'countdown card: ' + String(e && e.message ? e.message : e).slice(0, 120); return false; } }
    try { ok = mask.setStyle('quantum') !== false; } catch (e) { ok = false; }
    if (!ok) return false;                                  // this Mask has no cable look: the old card
    const names = o && Array.isArray(o.bsNames) ? o.bsNames : null, N = neutralFor(o);
    const lay = root.VTCableRig ? root.VTCableRig.layout() : null, count = lay ? lay.length : 36;
    const order = lay ? lay.map((L, i) => ({ i, z: L.socket[2] })).sort((a, b) => b.z - a.z || a.i - b.i).map((x) => x.i) : null;      // (one tap lands where he can see it)
    const c = carry || {};
    const cd = C2.create({ startAt: S.cd.state.startAt, endAt: S.cd.endAt, fillFrom: Math.max(Number(m.fillFrom) || 0, Number(c.fill) || 0), count, taps0: c.taps, gifts0: c.gifts, rich0: c.rich, order });
    const wake = { inbox: [], ownChat: true, fill: 0, rich: 0, life: 0.15, slack: 1, tight: 0, churn: 0, seam: 0, gem: 0, flash: 0, alive: 0, lum: 0.16, shut: 1, arr: [] };
    S.m2 = { cd, wake, N, names, bs: names ? new Array(names.length).fill(0) : null, iL: names ? names.indexOf('eyeBlinkLeft') : -1, iR: names ? names.indexOf('eyeBlinkRight') : -1, lm: null, charge0: K.charge(), w: cd.step(S.cd.state.startAt, null), tLast: 0, hold: !!(N && names) };
    K.wake(wake); K.charge(S.m2.w.charge);
    // his hands asleep too (the modelled hands and the stream between them): back the moment it wakes
    S.m2.mask = mask; S.m2.hands = false;
    if (typeof mask.learnNeutral === 'function' && !mask.__cdLearn) {
      const learn = mask.learnNeutral; mask.__cdLearn = true;
      mask.learnNeutral = (sec) => (!holdsFace() ? learn(sec) : new Promise((ok, no) => { const wait = () => { if (holdsFace()) setTimeout(wait, 250); else learn(sec).then(ok, no); }; setTimeout(wait, 250); }));
    }
    try { if (mask.handsStats && mask.handsStats().on) { S.m2.hands = true; mask.handsFx(false); } } catch (e) { /* no hands layer */ }
    S.card2.clear(carry ? { taps: S.cd.state.taps, keep: true } : undefined);
    return true;
  }
  function handsBack(m2) { if (m2 && m2.hands && m2.mask) { m2.hands = false; try { m2.mask.handsFx(true); } catch (e) { /* as it is */ } } }
  /** back to the Mask as it was: no wake, its charge as before, his own face again */
  function release2() {
    const m2 = S.m2; if (!m2) return; S.m2 = null;
    const K = cables(); if (K) { try { K.wake(null); K.charge(m2.charge0); } catch (e) { /* as it is */ } }
    handsBack(m2);
  }
  function holdsFace() { return !!(S.m2 && S.m2.hold); }
  /** right before the Mask draws: while it sleeps, its face is the sleeping one (his resting face, bowed, eyes shut) */
  function beforeDraw(mask) {
    const m2 = S.m2; if (!m2 || !m2.hold || !m2.w || !mask) return false;
    const home = S.home || { cx: 0, cy: 14, iod: 140, w: 1280, h: 720 };
    m2.lm = C2.sleepFace(m2.N, home, m2.w, m2.lm); if (!m2.lm) return false;
    if (m2.iL >= 0) m2.bs[m2.iL] = m2.w.blink; if (m2.iR >= 0) m2.bs[m2.iR] = m2.w.blink;
    let tMs = Date.now(); if (tMs <= m2.tLast) tMs = m2.tLast + 1; m2.tLast = tMs;
    try { return mask.frame(m2.lm, m2.bs, null, { width: home.w, height: home.h }, tMs) !== false; } catch (e) { return false; }
  }
  function cmd(m, mask, canvas, o) {
    if (!m || !mask || !canvas) return false;
    if (m.do === 'stop') { stop(mask, canvas); return true; }
    if (m.do === 'countdown') {
      const secs = Number(m.seconds) > 0 ? Number(m.seconds) : (Number(m.minutes) || 10) * 60;
      if (!layers(canvas)) return false;
      if (S.state === 'off') { try { S.style = mask.styleStats().style || 'classic'; const st = mask.stats(); S.place = st.place || null; } catch (e) { S.style = 'classic'; S.place = null; } }
      const carry = carryOf();
      S.tf.cancel(); S.cdFired = false; S.power = 0;
      // taps never move the start: no `shave` is passed (the engine's option stays off)
      S.cd = Open.createCountdown({ seconds: Math.min(3600, Math.max(5, secs)), startAt: mask.clock(), queue: S.queue, carry });
      S.state = 'card';
      release2();
      if (canMode2()) start2(m, mask, o, carry);
      // COUNTDOWN MUSIC: the drop on this zero (pressed again / a new time: it seeks there, never from the top)
      S.musicOpt = cleanMusic(m.music);
      const M = S.musicOpt.on ? music(mask) : S.music;
      if (M) { try { M.set(S.musicOpt); if (S.musicOpt.on) M.start(S.cd.endAt); } catch (e) { /* silent */ } }
      return true;
    }
    if (m.do === 'music' || m.do === 'musicFade') {      // COUNTDOWN MUSIC: on / off and the volume mid-run; the 3 s fade
      if (m.do === 'musicFade') { if (S.music) { try { S.music.fadeOut(3); } catch (e) { /* silent */ } } return !!S.music; }
      S.musicOpt = cleanMusic(m);
      const M = S.musicOpt.on ? music(mask) : S.music; if (!M) return false;
      try { M.set(S.musicOpt); if (S.musicOpt.on && !(o && o.maskOff) && S.state === 'card' && S.cd && !(S.view && S.view.done)) M.start(S.cd.endAt); } catch (e) { /* silent */ }      // (o.maskOff: the Mask is off, js/mask-page.js: the switch and the volume are kept, nothing starts)
      return true;
    }
    if (m.do === 'transform') return toggle(mask, canvas);
    if (m.do === 'toMask') return S.state === 'real' ? toggle(mask, canvas) : false;
    if (m.do === 'toReal') return S.state === 'off' ? toggle(mask, canvas) : false;
    return false;
  }
  /** a countdown that is running (not at its zero): what a new press or a new time carries on from it */
  function carryOf() {
    if (S.state !== 'card' || !S.cd || (S.view && S.view.done)) return null;
    const st = S.cd.state, w = S.m2 && S.m2.w && !S.m2.w.zero && !S.m2.w.done ? S.m2.w : null;
    return { taps: st.taps, gifts: st.gifts, points: st.points, fill: w ? w.fill : 0, rich: w ? w.rich : 0 };
  }
  function event(e) {
    if (S.state !== 'card' || !S.cd || !e) return;
    if (e.type === 'like') { S.cd.tap(Number(e.count) || 1, S.lastT); if (S.m2) S.m2.cd.tap(Number(e.count) || 1, S.lastT); }
    else if (e.type === 'gift') { S.cd.gift(Number(e.coins) || 1, Number(e.count) || 1, S.lastT); if (S.m2) S.m2.cd.gift(Number(e.coins) || 1, Number(e.count) || 1, S.lastT); }
  }
  function audio(f, t) {
    if (S.state === 'off' && !S.tf.running && !S.gl) return;      // before the warm-up: nothing at all (after it the beat is counted, so the first press can land on one)
    if (!S.clock && root.VTBeat) S.clock = root.VTBeat.createClock();
    if (!S.clock) return;
    let k = null; try { k = S.clock.push(f, t); } catch (e) { k = null; }
    if (!k || !k.locked) { S.beat = null; S.pulse = 0; return; }
    if (k.beat) S.beat = { locked: true, period: 60 / k.bpm, last: t, inBar: k.inBar };
    S.pulse = k.pulse || 0;
  }
  function face(lm, w, h, bs, mat) {
    if (S.state === 'real' || S.tf.running) S.face = { lm, w: w || 1, h: h || 1 };
    if (C2 && !CLASSIC2 && lm) {
      // countdown 2.0: where his face usually sits (the slow average the Mask keeps too), and his last full frame
      const f = C2.faceHome(lm, w, h), H = S.home;
      if (f) { if (!H || H.w !== f.w || H.h !== f.h) S.home = f; else { const k = 0.004; H.cx += (f.cx - H.cx) * k; H.cy += (f.cy - H.cy) * k; H.iod += (f.iod - H.iod) * k; } }
      if (mat && bs) S.lastLive = { lm, bs, mat, w, h };
    }
  }
  function show(s) {
    if (!s || !Array.isArray(s.queue)) return;
    const W = root.VTMaskWire, list = [];
    for (const q of s.queue.slice(0, 4)) { if (!q || typeof q !== 'object') continue; const cover = W && W.picUrl ? W.picUrl(q.cover) : null; list.push({ title: q.title, artist: q.artist, cover }); }
    S.queue = Open.cleanQueue(list);
    for (const q of S.queue) if (q.cover && !S.covers.has(q.cover)) { const im = new root.Image(); S.covers.set(q.cover, im); im.src = '/api/pic?u=' + encodeURIComponent(q.cover); }
    if (S.cd) S.cd.setQueue(S.queue);
  }
  /** his face's points in page pixels: the camera picture fills the page (cover), flipped when Mirror is on. v9-cam's own mapping can be set with setCamMap. */
  function facePoints(W, H, mirror) {
    const F = S.face; if (!F || !F.lm) return null;
    const n = Math.floor(F.lm.length / 3), pts = new Float32Array(n * 2), k = Math.max(W / F.w, H / F.h), ox = (W - F.w * k) / 2, oy = (H - F.h * k) / 2;
    for (let i = 0; i < n; i++) {
      let x = F.lm[3 * i] * F.w * k + ox, y = F.lm[3 * i + 1] * F.h * k + oy;
      if (mirror) x = W - x;
      if (S.map) { const p = S.map(x, y, W, H); x = p[0]; y = p[1]; }
      pts[2 * i] = x; pts[2 * i + 1] = y;
    }
    return { pts, cols: null };
  }
  function rect(W, H, place) { const p = place || { zoom: 1, x: 0, y: 0 }; return { cx: W * (0.5 + p.x), cy: H * (0.5 - p.y) - 0.025 * H * p.zoom, h: H * 0.47 * p.zoom }; }

  /** a change of background: asked for now, done right after the Mask's next picture (which is kept and burns into the new one) */
  function swap(fn) { if (S.state !== 'off' || S.tf.running) { fn(); return false; } if (S.swap) { try { S.swap(); } catch (e) { /* the newer one counts */ } } S.swap = fn; return true; }
  function afterDraw(mask, canvas, o) {
    const s0 = S.state;
    if (S.swap) {
      const fn = S.swap; S.swap = null;
      const ok = s0 === 'off' && !S.tf.running && layers(canvas) && S.gl.snapshot(canvas);
      try { fn(); } catch (e) { /* a background this Mask does not have */ }
      if (ok) fire('swap', mask);
    }
    if (s0 === 'off' && !S.tf.running) {                             // the Mask as always: nothing of this file runs
      // ... except once, a second or so after the Mask's first picture: the show layer is made and warmed, hidden
      if (!S.gl && !S.warmTried && ++S.idle > 45) { S.warmTried = true; layers(canvas); }
      return false;
    }
    const t = mask.clock(), dt = Math.min(0.1, Math.max(0, t - S.lastT)); S.lastT = t;
    const W = canvas.width, H = canvas.height;
    let view = null;
    let w2 = null;
    if (S.state === 'card' && S.cd) {
      view = S.view = S.cd.step(t, S.music ? beatFor(t) : beatInfo()); S.power = view.power;      // (COUNTDOWN MUSIC: beatFor)
      if (S.m2) {
        // countdown 2.0: the brain tells the cables, the eyes and the light inside what to do; the Mask is the meter
        const w = w2 = S.m2.w = S.m2.cd.step(t, view), W2 = S.m2.wake;
        for (const x of w.send) W2.inbox.push(x); if (W2.inbox.length > 96) W2.inbox.splice(0, W2.inbox.length - 96);
        W2.fill = w.fill; W2.rich = w.rich; W2.life = w.life; W2.slack = w.slack; W2.tight = w.tight; W2.churn = w.churn; W2.seam = w.seam; W2.gem = w.gem; W2.flash = w.flash; W2.alive = w.alive; W2.lum = w.lum; W2.shut = w.blink; W2.arr = w.arrivals;
        try { cables().charge(w.charge); mask.setPlace(CARD2_PLACE); } catch (e) { /* home */ }
        // COUNTDOWN MUSIC: the drop is heard on this very frame, but the Mask was drawn before the brain saw the zero: it is
        // drawn once more, awake, so the hit is seen on the drop (not a frame later). Only while the song aims at this zero.
        if (w.zero && S.music && typeof mask.draw === 'function') { let aim = false; try { aim = S.music.aims(S.cd.endAt); } catch (e) { aim = false; } if (aim) { try { mask.draw(); } catch (e) { /* the next frame */ } } }
        // the zero: it comes alive, is seen alive a moment, then the same hand-over as before
        if (w.alive > 0.5) handsBack(S.m2);
        if (w.done && !S.cdFired && w.zeroAge >= ALIVE_HOLD) { S.cdFired = true; fire('cardToReal', mask); }
      } else {
        try { mask.setPlace(CARD_PLACE); } catch (e) { /* home */ }
        if (view.done && !S.cdFired) { S.cdFired = true; fire('cardToReal', mask); }
      }
    }
    const s = S.tf.sample(t);
    if (s) for (const e of s.events) {
      if (e === 'style') { try { mask.setStyle(S.style); } catch (er) { /* classic */ } }
      if (e === 'impact') S.lastImpact = { kind: s.kind, on: s.on, at: Date.now() };
      if (e === 'done') {
        if (s.kind === 'cardToReal' || s.kind === 'toReal') { const was2 = !!S.m2; release2(); S.state = 'real'; S.cd = null; try { mask.setPlace(S.place); if (S.style !== 'classic' || was2) mask.setStyle('classic'); } catch (er) { /* home */ } }
        else if (s.kind === 'toMask') S.state = 'off';
      }
    }
    const running = !!s && !s.events.includes('done');
    if (S.queued && !S.tf.running && S.state !== 'card') { S.queued = false; toggle(mask, canvas); }      // the kept press
    const useShow = running || S.state === 'card' || (S.gl && S.gl.stats().embers > 0);
    // who shows: while this layer is up it carries the Mask's picture itself; in 'real' nothing covers his camera
    canvas.style.opacity = S.state === 'off' && !running ? '' : '0';
    S.showEl.style.display = useShow ? 'block' : 'none';
    S.cardEl.style.display = S.state === 'card' ? 'block' : 'none';
    if (useShow) {
      const place = S.state === 'card' ? (S.m2 ? CARD2_PLACE : CARD_PLACE) : S.place;
      try {
        S.gl.draw({
          t, dt, steady: S.state === 'card' ? 'card' : S.state === 'off' ? 'mask' : null, tf: running ? s : null, mask: canvas, cam: null,
          card: view && w2 ? { look: 2, surge: 0.6 * w2.flash, beat: S.pulse, meter: w2.fill, rich: w2.rich, maskGain: 1, flash: 0.55 * w2.flash + (view.big && !view.done ? 0.10 * Math.exp(-view.tickAge / 0.15) : 0) }
            : view ? { surge: view.surge, beat: S.pulse, meter: view.meter, maskGain: 0.92 + 0.10 * S.pulse + 0.25 * Math.min(1, view.surge), flash: view.done ? Math.exp(-view.doneAge / 0.3) : view.big ? 0.25 * Math.exp(-view.tickAge / 0.15) : 0 } : {},
          face: running && s.kind === 'toMask' ? facePoints(W, H, !!(o && o.mirror)) : null, maskRect: rect(W, H, place),
        });
      } catch (e) { S.error = String(e && e.message ? e.message : e).slice(0, 160); stop(mask, canvas); return false; }
    }
    if (S.state === 'card') {
      try { if (S.m2) { if (S.card2) S.card2.draw(view, { t, w: S.m2.w, covers: S.covers }); } else S.card.draw(view, { t, beat: S.pulse, covers: S.covers }); } catch (e) { /* the next frame */ }
      // the card burns away with the line: what the line has passed is gone
      S.cardEl.style.clipPath = running && s.kind === 'cardToReal' ? 'inset(' + Math.max(0, Math.min(100, (s.front - 0.02) * 100)).toFixed(2) + '% 0 0 0)' : '';
    }
    return true;
  }
  root.VTShowPage = {
    cmd, event, audio, face, show, afterDraw, stop, swap, holdsFace, beforeDraw,
    // COUNTDOWN MUSIC: the Mask's ear while the song plays (js/mask-page.js), and a made engine for tools (an offline one)
    onMusic(fn) { S.musicSink = typeof fn === 'function' ? fn : null; },
    musicOwns() { try { return !!(S.music && S.music.feeding()); } catch (e) { return false; } },
    useMusic(engine) { S.music = engine || null; },
    musicStop() { if (S.music) { try { S.music.stop(0.5); } catch (e) { /* silent */ } } },      // the Mask is switched off: its song fades with it
    /** the hook for a hand gesture (v9-hands): the same as the Transform button */
    fire: () => { const P = root.VTMaskPage; const m = P && P.debug ? P.debug.mask : null, c = P && P.debug ? P.debug.canvas : null; return m && c ? toggle(m, c) : false; },
    /** camera mode's own picture -> page mapping (v9-cam), when it is there: (x, y, W, H) -> [x, y] */
    setCamMap(fn) { S.map = typeof fn === 'function' ? fn : null; },
    status() { const v = S.cd && S.state === 'card' ? S.view || null : null; return { state: S.state, running: S.tf.running, queued: !!S.queued, warm: !!S.gl, left: v ? Math.ceil(v.remaining) : 0, meter: v ? Math.round(v.meter * 100) / 100 : Math.round(S.power * 100) / 100, taps: v ? v.taps : 0, gifts: v ? v.gifts : 0, beat: !!S.beat, queue: S.queue.length, ms: S.gl ? Math.round(S.gl.stats().drawMs * 100) / 100 : 0, error: S.error, land: S.lastImpact ? S.lastImpact.on : '', music: S.music ? S.music.status() : null, c2: S.m2 && S.m2.w ? { fill: Math.round(S.m2.w.fill * 1000) / 1000, rich: Math.round(S.m2.w.rich * 100) / 100, pulses: S.m2.w.pulses, taps: S.m2.w.taps, hold: S.m2.hold, alive: S.m2.w.alive } : null }; },
    debug: S,
  };
  root.VTShowFire = root.VTShowPage.fire;
})(typeof globalThis !== 'undefined' ? globalThis : self);
