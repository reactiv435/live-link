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
//   mask.setEyeLock(true | false)                     eyes on camera (default true): the eyes point at the lens; stats().eyeLock
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
  function create(canvas, { neutral = null, bsNames = [], restR = null, width = 1080, height = 1920, look = 'particlesC', giftMap = null, giftSounds = true, background = 'black', visualizer = 'orb', eyeLock = true } = {}) {
    const Core = root.VTMaskCore, GL = root.VTMaskGL, Looks = root.VTMaskLooks, Mood = root.VTMaskMood, Fx = root.VTMaskFx, Sfx = root.VTMaskSfx;
    canvas.width = width; canvas.height = height;
    const G = GL.create(canvas);
    const t0 = performance.now(), now = () => (performance.now() - t0) / 1000;
    let core = null, looks = null, provisional = false;
    let fx = Fx.create(giftMap ? { map: giftMap } : {});
    const mood = Mood.create();
    const S = { eyeLock: eyeLock !== false, bg: background, sounds: giftSounds, mode: 'face', viz: Fx.VISUALIZERS.includes(visualizer) ? visualizer : 'orb', frames: 0, faces: 0, coreMs: 0, drawMs: 0, lastDraw: null, audioAt: -9 };
    let a = { bass: 0.25, mid: 0.3, high: 0.2, beat: 0, level: 0.45, bright: 0.8 }, beat = 0;
    const kicks = [];                                   // [t, strength, big strength]
    let head = null, cx = null, cy = 0, cs = 0, lastBs = null, lastSeen = -9, palette = null;
    let learn = null, actx = null, sfxOut = null, cueT = 0;
    const playing = [];                                 // gift sounds that are sounding: [end time, level]
    fx.setVisualizer(S.viz, -9);
    const cmdAt = {};
    const BACKGROUNDS = ['black', 'summer', 'ice', 'forge', 'nebula', 'studio', 'street'];      // the same list, in the same order, as mask-looks.js draws

    function build(n) {
      core = Core.create({ neutral: n, bsNames, restR, boost: provisional ? 0 : 1 });
      core.eyeLock = S.eyeLock;
      looks = Looks.create(G, core);
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
        for (const t of [1.3, 1.75, 2.4]) looks.draw(look, { time: t, audio: { bass: 0.5, mid: 0.5, high: 0.5, beat: 0.5, level: 0.5, bright: 0.8 }, kicks: [[0.1, 0.8]], hits: [[0.2, 0.8]], head: { R: I, x: 0, y: 0, scale: 1 }, palette: null, fx: w.sample(t), eyeStyle: 1, bg: S.bg, headPart: 'none' });
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
      S.coreMs += (performance.now() - b - S.coreMs) * 0.05;
      if (!ok) return false;
      S.faces++; lastBs = bs; lastSeen = now();
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
      const cues = fx.cuesBetween(cueT, t + 0.12);
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
      palette = Mood.tint(mood.step({ level: au.level, bass: au.bass, beat: au.beat, bright: au.bright, hit: hitNow }, t - lastSeen < 0.5 ? lastBs : null, bsNames, dt), S.bg);
      sounds(t);
      looks.draw(look, { time: t, audio: au, kicks: live ? ks : [], hits: live ? hs : [], head, palette, fx: fx.sample(t), eyeStyle: 1, bg: S.bg, headPart: S.head || 'none' });
      S.drawMs += (performance.now() - b - S.drawMs) * 0.05;
      return true;
    }
    return {
      /** The gift sounds' output: a GainNode on the mask's own AudioContext (`node.context`), connected to that context's
       *  destination. The page may connect it on to an analyser of its own. null when this page has no audio output. */
      sfxOutput: () => (S.sounds ? audioOut(false) : sfxOut),
      frame, audio, fire, setMode, setVisualizer, setBackground, setHead, setGiftSounds, setGiftMap, setNeutral, learnNeutral, draw, setEyeLock,
      /** the short-lived names to show right now: [{ text, kind: 'follow' | 'share' | 'gift', age (s, of 2.5) }], at most two. The page draws them. */
      names: () => fx.sample(now()).names,
      stats: () => ({ drawMs: S.drawMs, coreMs: S.coreMs, frames: S.frames, faces: S.faces, mode: S.mode, visualizer: S.viz, visualizers: Fx.VISUALIZERS.slice(), background: S.bg, backgrounds: BACKGROUNDS.slice(), audio: now() - S.audioAt < 1.5, warm: !!S.warm, eyeLock: S.eyeLock, sfxLevel: sfxLevel(), neutral: core ? (provisional ? 'provisional' : 'set') : 'none', renderer: G.info.renderer }),
      destroy() { try { if (actx) actx.close(); } catch (e) { /* ignore */ } const lose = G.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); },
    };
  }
  root.VTMaskLive = { create };
})(typeof globalThis !== 'undefined' ? globalThis : self);
