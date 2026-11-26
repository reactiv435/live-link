// V4 MASK: the one object a LIVE page needs. It owns the canvas and glues the mask modules together the way the demo
// renderer does (mask.html), one camera frame and one audio frame at a time, never looking ahead.
// Load order: face-topology.js, mask-core.js, mask-gl.js, mask-looks.js, mask-mood.js, mask-fx.js, mask-sfx.js, mask-live.js.
//
//   const mask = VTMaskLive.create(canvas, { neutral, bsNames, width: 1080, height: 1920 });
//   mask.frame(lm, bs, mat, { width, height }, tMs)   one tracker result: lm = 478 * (x, y, z) exactly as MediaPipe's
//                                                     FaceLandmarker gives them (un-mirrored, 0..1), bs = its 52 blendshape
//                                                     scores in its own order (names passed once as `bsNames`), mat = its
//                                                     4x4 matrix (16 numbers, column-major) or null, tMs = capture time.
//                                                     Pass lm = null when there is no face: the mask holds its last face.
//   mask.audio(f)                                     one result of VTMaskAudio (audio-features.js): { bass, mid, high, beat,
//                                                     kick, hit, level, bright }, about 60 a second. Not called = the mask
//                                                     still lives (it breathes on a quiet default).
//   mask.fire(event)                                  a viewer event, in the shape LIVE Link sends (V4-MASK.md): { type: 'gift' |
//                                                     'like' | 'comment' | 'follow' | 'share', name, gift, coins, count, text }.
//                                                     Returns false when it was ignored (cooldown, rate cap, unknown).
//                                                     Chat commands ("boom", "grow") are read here from comment text.
//   mask.setMode('face' | 'visualizer')               the big button; the change takes 1.5 s
//   mask.setVisualizer('orb' | 'tunnel' | 'yinyang' | 'ridges' | 'blackhole' | 'helix')   which formation the Visualizer shows (remembered by the page);
//                                                     changed while it is on, the points fly from one into the other
//   mask.setBackground('black' | 'summer' | 'ice' | 'forge' | 'nebula' | 'studio' | 'street')   the list is stats().backgrounds
//   mask.setHead('none' | 'head' | 'hair' | 'horns' | 'flames' | 'demon')   what is round the face (none = the mask alone)
//   mask.setStyle('classic' | 'core')                 V9: a high-end style on top of the Mask (mask-v9.js, loaded after mask-looks.js;
//                                                     without that file only 'classic' exists). 'core' = Reactiv Core, the gold particle
//                                                     face. The change is a transform, never a cut; styles() lists them
//   mask.setEyeLock(true | false)                     eyes on camera (default true): the eyes point at the lens; stats().eyeLock
//   mask.setPlace({ zoom, x, y })                     V7: where the face sits (x / y in parts of the picture, + = right / up) and how
//                                                     big; the background stays full frame. null = home
//   mask.setColour('#rrggbb' | null, music = true)    V7: a colour he picked (null = Auto: crimson home, the moods move it);
//                                                     music false = the colour holds, true = the song still moves it round his colour
//   mask.busy()                                       true while the effect of a gift is playing (shuffle to the beat waits for it)
//   mask.setGiftSounds(true | false)                  procedural gift sounds through this page's own audio output
//   mask.sfxOutput()                                  the gift sounds' output node (a GainNode on the mask's own AudioContext) or null;
//                                                     stats().sfxLevel = 0..1, how loud the gift sounds are right now (0 = none)
//   mask.setGiftMap(rows)                             the gift list (see GIFT MAP in review/V4-PHASE2-NOTES.md)
//   mask.setNeutral(neutral)                          his resting face (from learnNeutral or a saved one)
//   mask.learnNeutral(seconds = 2) -> Promise         collects the frames of the next seconds and makes a neutral from
//                                                     the calmest of them (he should hold a relaxed face); resolves with
//                                                     the neutral object to save (small JSON), rejects when too few faces
//   mask.names()                                      the viewer names to show right now (follow / share / "<name> sent <gift>"),
//                                                     each for 2.5 s; the PAGE draws them (text is not drawn into the canvas)
//   mask.draw()                                       call once per requestAnimationFrame
//   mask.stats()                                      { drawMs, coreMs, frames, faces, mode, visualizer, visualizers: [names], background, backgrounds: [names], audio: bool, warm: bool, sfxLevel }
//   mask.destroy()
// Without a neutral the mask still shows his face, but un-boosted and with the first second's face taken as rest;
// with one, expressions are boosted exactly as in the demos.
(function (root) {
  'use strict';
  function create(canvas, { neutral = null, bsNames = [], restR = null, width = 1080, height = 1920, look = 'particlesC', giftMap = null, giftSounds = true, background = 'black', visualizer = 'orb', eyeLock = true, v8 = true, gooColour = 'toxic', vizEyes = true, style = 'classic' } = {}) {
    const Core = root.VTMaskCore, GL = root.VTMaskGL, Looks = root.VTMaskLooks, Mood = root.VTMaskMood, Fx = root.VTMaskFx, Sfx = root.VTMaskSfx;
    canvas.width = width; canvas.height = height;
    const G = GL.create(canvas);
    const t0 = performance.now(), now = () => (performance.now() - t0) / 1000;
    let core = null, looks = null, provisional = false;
    // V9 (mask-v9.js): a high-end STYLE switched on top of the look. Nothing of it is made until one is asked for.
    let v9 = null;
    // V9 HANDS (mask-hands.js + an effect file): his hands and a live visual between them. Nothing of it is made until it is switched on.
    let hfx = null;
    const handsOn = () => { if (!hfx && root.VTMaskHands) hfx = root.VTMaskHands.create(G); return hfx; };
    let scam = null;      // V9 SMART CAMERA (js/v9/smart-camera.js): made the first time he switches it on; null = the Mask's own camera, untouched
    const styleOn = () => { if (!v9 && root.VTMaskV9) { v9 = root.VTMaskV9.create(G); if (core) v9.setCore(core); } return v9; };
    // V9 CAMERA MODE (mask-cam.js): his real camera is the picture, only the effects are drawn (on a see-through canvas of
    // the page's). Nothing of it is made until the page asks for it; never asked = the Mask exactly as before.
    let cam = null;
    const camOn = () => { if (!cam && root.VTMaskCam) cam = root.VTMaskCam.create(); return cam; };
    let fx = Fx.create(giftMap ? { map: giftMap } : {});
    const mood = Mood.create();
    // V8 (mask-v8.js): puppet moves, hype layers, the song, the boss fight's look, hand puppets. `v8: false` at create = none of it.
    const stage = v8 !== false && root.VTMaskV8 ? root.VTMaskV8.create({ gooColour, sounds: true }) : null;
    const S = { eyeLock: eyeLock !== false, bg: background, sounds: giftSounds, mode: 'face', viz: Fx.VISUALIZERS.includes(visualizer) ? visualizer : 'orb', frames: 0, faces: 0, coreMs: 0, drawMs: 0, lastDraw: null, audioAt: -9 };
    let a = { bass: 0.25, mid: 0.3, high: 0.2, beat: 0, level: 0.45, bright: 0.8 }, beat = 0;
    const kicks = [];                                   // [t, strength, big strength]
    let head = null, cx = null, cy = 0, cs = 0, lastBs = null, lastSeen = -9, palette = null;
    let learn = null, actx = null, sfxOut = null, cueT = 0;
    const playing = [];                                 // gift sounds that are sounding: [end time, level]
    fx.setVisualizer(S.viz, -9);
    const cmdAt = {}, cuePlayed = new WeakSet();
    const BACKGROUNDS = ['black', 'summer', 'ice', 'forge', 'nebula', 'studio', 'street'];      // the same list, in the same order, as mask-looks.js draws

    function build(n) {
      core = Core.create({ neutral: n, bsNames, restR, boost: provisional ? 0 : 1 });
      core.eyeLock = S.eyeLock;
      looks = Looks.create(G, core);
      if (v9) v9.setCore(core);
      head = null; cx = null;
      warm();
    }
    /**
     * Everything a gift needs for the first time (the point sets, the effect points' program on the graphics card, the
     * sound output and its noise) is made HERE, when the mask is built, not in the frame the first gift starts: two
     * frames of the biggest gift are drawn once, unseen, and the picture is cleared again. Without this the first gift
     * of a show cost one frame of 100 - 400 ms.
     */
    function warm() {
      S.warm = false;
      try {
        const w = Fx.create(), I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        w.fire({ type: 'gift', gift: 'warm', coins: 100000, count: 1 }, 0); w.fire({ type: 'gift', gift: 'warm', coins: 30, count: 1 }, 0.4); w.fire({ type: 'like', value: 5 }, 1.2); w.setMode('visualizer', 0.2);
        for (const t of [1.3, 1.75, 2.4]) looks.draw(look, { time: t, audio: { bass: 0.5, mid: 0.5, high: 0.5, beat: 0.5, level: 0.5, bright: 0.8 }, kicks: [[0.1, 0.8]], hits: [[0.2, 0.8]], head: { R: I, x: 0, y: 0, scale: 1 }, palette: null, fx: w.sample(t), eyeStyle: 1, bg: S.bg, headPart: 'none', vizEyes: false });      // (vizEyes: the vortex eyes need no warming: they are drawn with the gift's own program and buffer)
        const gl = G.gl; gl.finish();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        S.warm = true;
      } catch (e) { /* a warm-up that fails changes nothing: the first gift then pays for it, as before */ }
      if (S.sounds) audioOut(true);
    }
    /** the gift sounds' output: one gain node on this page's own AudioContext, made once (and warmed: the noise, one silent sound of each kind) */
    function audioOut(warmIt) {
      try {
        if (!actx) {
          actx = new (root.AudioContext || root.webkitAudioContext)();
          sfxOut = actx.createGain(); sfxOut.connect(actx.destination);
          Sfx.schedule(actx, sfxOut, [{ t: 0, kind: 'whoosh', size: 1, dur: 0.05 }, { t: 0, kind: 'bang', size: 1 }, { t: 0, kind: 'boom', size: 1 }, { t: 0, kind: 'charge', size: 1, dur: 0.05 }], actx.currentTime + 0.01, { volume: 0 });
        }
        if (actx.state === 'suspended') actx.resume();
      } catch (e) { /* no audio output here: the mask goes on silently */ }
      return sfxOut;
    }
    function setNeutral(n) { provisional = false; build(n); }
    if (neutral) build(neutral);
    if (style && style !== 'classic') setStyle(style);

    function frame(lm, bs, mat, size, tMs) {
      S.frames++;
      if (!lm) return false;
      if (learn) { learn.frames.push({ lm: Array.from(lm), bs: Array.from(bs || []), mat: mat ? Array.from(mat) : null }); learn.size = size; }
      if (!core) {
        // no resting face yet: take this one as rest (no boost) until a real one is set or learned
        if (!mat) return false;
        try { provisional = true; build(Core.calibrate([{ lm, bs, mat }, { lm, bs, mat }, { lm, bs, mat }, { lm, bs, mat }, { lm, bs, mat }, { lm, bs, mat }, { lm, bs, mat }, { lm, bs, mat }], bsNames, size)); } catch (e) { return false; }
      }
      const b = performance.now();
      const ok = core.process(lm, bs, mat, size, tMs);
      if (hfx) hfx.face(lm, size);
      S.coreMs += (performance.now() - b - S.coreMs) * 0.05;
      if (!ok) return false;
      S.faces++; lastBs = bs; lastSeen = now(); S.pic = size;
      const P = core.pose, k = cx === null ? 1 : 0.004;                   // where he usually sits: a slow average (about 8 s at 30 fps)
      if (cx === null) { cx = P.x; cy = P.y; cs = P.size; } else { cx += (P.x - cx) * k; cy += (P.y - cy) * k; cs += (P.size - cs) * k; }
      const soft = (v, lim) => lim * Math.tanh(v / lim);
      head = { R: P.R.slice(), x: soft((P.x - cx) / (2 * cs) * 0.55, 0.55), y: soft((P.y - cy) / (2 * cs) * 0.55, 0.4), scale: Math.min(1.18, Math.max(0.86, Math.pow(P.size / cs, 0.6))) };
      return true;
    }
    function audio(f) {
      const t = now();
      a = { bass: f.bass, mid: f.mid, high: f.high, beat: f.beat, level: f.level, bright: f.bright === undefined ? 0.8 : f.bright };
      S.audioAt = t;
      if (scam && scam.on) scam.audio(f, t);      // V9 SMART CAMERA: the director hears the music (only while it is on)
      if (f.kick) { kicks.push([t, f.kick, f.hit || 0]); if (kicks.length > 64) kicks.splice(0, 32); }
      if (f.hit) S.hit = Math.max(S.hit || 0, f.hit);                    // kept until the next draw: the colour turns on the hit itself
    }
    function fire(ev) {
      if (!ev || typeof ev.type !== 'string') return false;
      const t = now();
      if (ev.type === 'comment') {
        const c = String(ev.text || '').trim().toLowerCase().replace(/^!/, '');
        if (Fx.COMMANDS[c]) fx.fire({ type: 'command', text: c, name: ev.name }, t);      // exact word only; the cooldown is inside
        return fx.fire({ type: 'comment', name: ev.name }, t);
      }
      if (ev.type === 'like') return fx.fire({ type: 'like', value: Math.max(1, Math.min(50, Number(ev.count) || 1)) }, t);
      if (ev.type === 'gift' || ev.type === 'follow' || ev.type === 'share' || ev.type === 'command') return fx.fire(ev, t);
      return false;
    }
    function setMode(m) { if (m !== 'face' && m !== 'visualizer') return false; S.mode = m; return fx.setMode(m, now()); }
    function setVisualizer(v) { if (!Fx.VISUALIZERS.includes(v)) return false; S.viz = v; fx.setVisualizer(v, now()); return true; }
    function setBackground(b) { if (!BACKGROUNDS.includes(b)) return false; S.bg = b; return true; }
    function setGiftSounds(on) { S.sounds = !!on; if (S.sounds && core) audioOut(true); }
    /** eyes on camera (round 5): true = the eyes point at the lens whatever he looks at; blinks and the head are still his */
    function setEyeLock(on) { S.eyeLock = !!on; if (core) core.eyeLock = S.eyeLock; return true; }
    function setPlace(p) { S.place = p && typeof p === 'object' ? { zoom: Math.min(2, Math.max(0.15, Number(p.zoom) || 1)), x: Math.min(0.5, Math.max(-0.5, Number(p.x) || 0)), y: Math.min(0.5, Math.max(-0.5, Number(p.y) || 0)) } : null; return true; }
    function setColour(hex, music) { const c = Mood.hexLinear(hex); S.colour = c ? { hex: hex.toLowerCase(), c, music: music !== false, viz: Mood.customViz(c) } : null; return !!c || hex === null || hex === ''; }
    function busy() { const s = fx.sample(now()); return !!((stage && stage.busy()) || s.busy > 0 || s.missiles.length || s.glints.length || s.lock || Math.abs(s.scale - 1) > 0.02 || s.shatter > 0.05 || s.brace > 0.05 || s.rainbow > 0.05); }
    /** V9: 'classic' (what the Mask has always been) or a style on top of it ('core' = Reactiv Core). The change is a transform, about 1.5 s. */
    function setStyle(name) {
      if (name === 'classic') { S.style = name; if (v9) v9.setStyle(name); if (stage && stage.setHypeTone) stage.setHypeTone('classic', false); return true; }
      const m = styleOn(); if (!m || !m.setStyle(name)) return false;
      S.style = name; if (stage && stage.setHypeTone) stage.setHypeTone(name === 'quantum' ? 'quantum' : 'classic', name !== 'classic'); return true;
    }
    function setHead(h) { if (!['none', 'head', 'hair', 'horns', 'flames', 'demon'].includes(h)) return false; S.head = h; return true; }
    function setGiftMap(rows) {
      // a new list takes effect for the next gift; what is in the air finishes with the old one
      const mode = S.mode; fx = Fx.create({ map: rows }); fx.setVisualizer(S.viz, -9); if (mode === 'visualizer') fx.setMode('visualizer', now() - 5);
    }
    function learnNeutral(seconds = 2) {
      return new Promise((res, rej) => {
        learn = { frames: [], size: null };
        setTimeout(() => {
          const L = learn; learn = null;
          const good = L.frames.filter((f) => f.mat);
          if (good.length < 20) { rej(new Error('too few frames with a face (' + good.length + ')')); return; }
          try { const n = Core.calibrate(good, bsNames, L.size); setNeutral(n); res(n); } catch (e) { rej(e); }
        }, seconds * 1000);
      });
    }
    function sounds(t) {
      // V8 (phase 2): a puppet move is asked for BETWEEN two pictures, with its first sound due at once: that moment is
      // already behind the window the last picture looked through. The stage's sounds are therefore taken by what has
      // not been played yet (a look-back of 0.4 s), each exactly once; a late one plays now.
      let cues = fx.cuesBetween(cueT, t + 0.12);
      if (stage) { const sc = stage.cuesBetween(cueT - 0.4, t + 0.12).filter((c) => !cuePlayed.has(c)); for (const c of sc) cuePlayed.add(c); if (sc.length) cues = cues.concat(sc.map((c) => (c.t < t ? { ...c, t } : c))); }
      cueT = t + 0.12;
      if (!S.sounds || !cues.length) return;
      try {
        const out = audioOut(false); if (!out) return;
        Sfx.schedule(actx, out, cues.map((c) => ({ ...c, t: c.t - t })), actx.currentTime + 0.02);
        for (const c of cues) { const k = Math.sqrt(Math.max(0.3, c.size || 1)), len = c.kind === 'boom' ? 1.0 + 0.35 * k : c.kind === 'bang' ? 0.3 : Math.max(0.3, c.dur || 0.5); playing.push([c.t, c.t + len + 0.1, Math.min(1, (c.kind === 'boom' ? 0.6 : c.kind === 'bang' ? 0.4 : 0.15) * k)]); }
        if (playing.length > 96) playing.splice(0, 48);
      } catch (e) { /* no audio output here: the mask goes on silently */ }
    }
    /** 0..1: how loud the mask's own gift sounds are right now (0 = none sounding, or sounds off). From what was scheduled, not measured. */
    function sfxLevel() { const t = now(); let v = 0; for (const p of playing) if (t >= p[0] - 0.05 && t < p[1]) v = Math.max(v, p[2] * Math.min(1, (p[1] - t) / 0.25 + 0.2)); return S.sounds ? v : 0; }
    function draw() {
      if (!core || !head) return false;
      const b = performance.now(), t = now(), dt = S.lastDraw === null ? 1 / 30 : Math.min(0.1, t - S.lastDraw);
      S.lastDraw = t;
      const live = t - S.audioAt < 1.5;
      const au = live ? a : { bass: 0.25, mid: 0.3, high: 0.2, beat: 0, level: 0.45, bright: 0.8 };
      const ks = [], hs = [];
      for (let k = kicks.length - 1; k >= 0 && ks.length < 8; k--) ks.push([t - kicks[k][0], kicks[k][1]]);
      for (let k = kicks.length - 1; k >= 0 && hs.length < 4; k--) if (kicks[k][2]) hs.push([t - kicks[k][0], kicks[k][2]]);
      const hitNow = live ? S.hit || 0 : 0; S.hit = 0;
      const moodNow = mood.step({ level: au.level, bass: au.bass, beat: au.beat, bright: au.bright, hit: hitNow }, t - lastSeen < 0.5 ? lastBs : null, bsNames, dt);
      // a colour he picked wins over the light of the background (the background still shows, in its own colours)
      palette = S.colour ? Mood.custom(moodNow, S.colour.c, S.colour.music) : Mood.tint(moodNow, S.bg);
      sounds(t);
      // V9 CAMERA MODE: the effects go onto his real face; once the change is over the Mask itself is not drawn at all
      if (cam && cam.active(t) && cam.frame(t, { core, fx: fx.sample(t), pic: S.pic }) >= 1) { S.drawMs += (performance.now() - b - S.drawMs) * 0.05; return true; }
      const fxS = fx.sample(t), o = stage ? stage.pre(t, { core, palette, fx: fxS, head, place: S.place || null, mood: moodNow, colour: S.colour ? S.colour.c : null, audio: au }) : null;
      const scene = { time: t, audio: au, kicks: live ? ks : [], hits: live ? hs : [], head: o ? o.head : head, palette: o ? o.palette : palette, fx: o ? o.fx : fxS, eyeStyle: 1, bg: S.bg, headPart: S.head || 'none', place: o ? o.place : S.place || null, vizCol: S.colour ? S.colour.viz : null, v8: o ? o.v8 : null, vizEyes: vizEyes !== false };
      // V9: a style that is on (or on its way in or out) takes the palette and the effects through its own hands and draws itself into the same scene
      const sty = v9 ? v9.pre(t, dt, { palette: scene.palette, fx: scene.fx, v8u: scene.v8 && scene.v8.u ? scene.v8.u : null, audio: au, hits: scene.hits }) : null;
      if (sty) { scene.palette = sty.palette; scene.fx = sty.fx; scene.v9 = sty.hook; }
      // V9 HANDS: off or no hand up = null = the scene is what it was
      const hf = hfx ? hfx.pre(t, dt, { audio: au, kicks: scene.kicks, hits: scene.hits }) : null;
      if (hf) { scene.hfx = hf; scene.place = hfx.place(scene.place); }
      if (scam) { try { scam.frame(t, dt, scene, stage, v9); } catch (e) { scene.cam = null; if (!scam.err) { scam.err = String(e); console.warn('V9 SMART CAMERA:', e); } } }      // V9 SMART CAMERA: off = it touches nothing; an error in it = said once, the Mask draws on
      looks.draw(look, scene);
      if (stage) stage.post();
      S.drawMs += (performance.now() - b - S.drawMs) * 0.05;
      return true;
    }
    return {
      /** The gift sounds' output: a GainNode on the mask's own AudioContext (`node.context`), connected to that context's
       *  destination. The page may connect it on to an analyser of its own. null when this page has no audio output. */
      sfxOutput: () => (S.sounds ? audioOut(false) : sfxOut),
      // V8: the puppet show. All of these are no-ops (false / null) when the mask was made with v8: false.
      puppet: (name, o) => (stage ? stage.puppet(name, o || {}, now()) : false), release: (name) => (stage ? stage.release(name, now()) : false),
      setHype: (rank, k) => { if (stage) stage.setHype(rank, k, now()); return !!stage; }, hypePlus: () => (stage ? stage.hypePlus(now()) : false),
      // release A (album eating): cover = a song on air gives the Mask its colour only; eat = the Mask eats the cover (no image =
      // a glowing record), chomps on the beat and chews; verdict = it spits his word ('fire' | 'gem' | 'solid' | 'promising');
      // gulp = it swallows, no word. score = a LIVE Link 2.3.0's number, as before.
      cover: (o) => { if (stage) stage.cover(o, now()); return !!stage; }, songOff: () => { if (stage) stage.songOff(); },
      eat: (o) => (stage ? stage.eat(o, now()) : false), verdict: (word) => (stage ? stage.verdict(word, now()) : false), gulp: () => (stage ? stage.gulp(now()) : false),
      /** fix round V-2: a word that was owed (the song was eaten earlier and swallowed with no word): a belch, then the word with its title */
      belch: (word, o) => (stage ? stage.belch(word, o || {}, now()) : false),
      score: (n) => { if (stage) stage.score(n, now()); return !!stage; },
      /** V9 HYPE: the look of the ranks ('classic' = as it always was, 'aura' | 'orbit' | 'smoke' | 'material' | 'stage'); a gifter's picture joins the orbit */
      setHypeStyle: (name) => (stage && stage.setHypeStyle ? stage.setHypeStyle(name) : false), hypeStyles: () => (stage && stage.hypeStyles ? stage.hypeStyles() : ['classic']),
      /** the hype look that is REALLY drawing ('classic' when a look could not be made on this card) */
      hypeStyle: () => (stage && stage.state && stage.state.hypeStyle ? stage.state.hypeStyle : 'classic'),
      gifter: (viewer, coins) => (stage && stage.gifter ? stage.gifter(viewer, coins, now()) : false),
      boss: (s) => { if (stage) stage.boss(s); }, vote: (v) => { if (stage) stage.vote(v); }, hands: (p, o) => { if (stage) stage.hands(p, o); },
      /** what the 2D layer over the canvas draws this frame (mask-hud.js): bars, the vote, names on missiles, the cover, the score */
      hud: () => (stage ? stage.hud() : null), v8: () => stage, clock: now,
      /** V8 phase 2: Mirror is on (the page flips this canvas as a whole): words the Mask spells in points are drawn flipped, so they read right */
      setMirror: (on) => { if (stage && stage.setMirror) stage.setMirror(!!on); },
      /** where the fight's bars sit, 0 (top) .. 1 (bottom) of the part TikTok leaves free: the Mask makes room on the other side */
      setBars: (y) => { if (stage && stage.setBars) stage.setBars(Number(y) || 0); },
      /** one soft full-frame flare (a big gift); goes through the stage's own limit (never 3 a second) */
      flare: () => (stage ? stage.flash(now(), [1.0, 0.82, 0.5], 0.45) : false),
      frame, audio, fire, setMode, setVisualizer, setBackground, setHead, setStyle,
      /** V9 HANDS: the hand effect on / off ({ effect: 'particle-play', room: true }); handsInput = the hand model's hands as the tracker sends them
       *  ({ aspect, face? }); handsState = his hands for other modules (place, speed, pose: a gift missile can ask where a hand is) */
      handsFx: (on, o) => { const h = on ? handsOn() : hfx; if (!h) return false; if (o && o.effect) h.setEffect(o.effect); if (o && o.room !== undefined) h.setRoom(o.room); if (o && o.gain) h.setGain(o.gain); h.setOn(!!on); return true; },
      handsInput: (hands, o) => { if (hfx) hfx.input(hands, o, now()); }, handsState: () => (hfx ? hfx.state() : null), handsStats: () => (hfx ? hfx.stats() : { on: false }),
      /** V9 SMART CAMERA: on / off (off = the Mask's own camera, untouched) -> the camera (stats, aside, fire), or null on a page without smart-camera.js */ smartCam: (on, o) => { if (on && !scam && root.VTSmartCam) scam = root.VTSmartCam.create(o); if (scam) scam.setOn(!!on); return scam; },
      handEffects: () => (root.VTMaskHands ? root.VTMaskHands.effects() : []),
      /** V9 CAMERA MODE: the effects-only layer (mask-cam.js: layer, set, align, showAlign, face, k, anchor, hooks), or null when that file is not loaded */
      camera: () => camOn(),
      /** V9: the styles this build has (the first is the classic Mask) and what the style is doing right now */
      styles: () => (root.VTMaskV9 ? root.VTMaskV9.STYLES.slice() : ['classic']), styleStats: () => (v9 ? v9.stats() : { style: 'classic', shown: 0, ready: false, points: 0 }), setPlace, setColour, busy, setGiftSounds, setGiftMap, setNeutral, learnNeutral, draw, setEyeLock,
      /** the short-lived names to show right now: [{ text, kind: 'follow' | 'share' | 'gift', age (s, of 2.5) }], at most two. The page draws them. */
      names: () => fx.sample(now()).names,
      stats: () => ({ drawMs: S.drawMs, coreMs: S.coreMs, frames: S.frames, faces: S.faces, mode: S.mode, visualizer: S.viz, visualizers: Fx.VISUALIZERS.slice(), background: S.bg, backgrounds: BACKGROUNDS.slice(), audio: now() - S.audioAt < 1.5, warm: !!S.warm, eyeLock: S.eyeLock, place: S.place || null, colour: S.colour ? S.colour.hex : '', colourMusic: S.colour ? S.colour.music : true, sfxLevel: sfxLevel(), neutral: core ? (provisional ? 'provisional' : 'set') : 'none', renderer: G.info.renderer, style: S.style || 'classic', ...(cam ? { camera: cam.stats() } : null) }),
      destroy() { try { if (actx) actx.close(); } catch (e) { /* ignore */ } const lose = G.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); },
    };
  }
  root.VTMaskLive = { create };
})(typeof globalThis !== 'undefined' ? globalThis : self);
