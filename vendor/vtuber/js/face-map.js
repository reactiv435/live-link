// v2 face: the rig's PARAMETERS, the approved expressions as parameter sets, and the way `perf.face` drives them.
// Pure logic (no DOM, no Babylon): shared by avatar.html, face-lab.html and the tests.
//   PARAMS                      every rig parameter: [name, min, max, rest]
//   PRESETS[hero][name]         the approved pictures (and the extra expressions of the range sheet) as parameter sets
//   mapFace(face, hero)         perf.face (tracking/lib/face-signal.js) -> target parameters, with the cartoon gain curves
//   FaceAnimator                per frame: interpolates between perf messages, adds the microphone, held presets, the
//                               idle life layer and the springs -> the parameters to draw
// L / R always mean the picture's left / right (the viewer's), as in the `perf` message.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTFaceMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /** name, min, max, rest. The rest value of every parameter together IS the approved neutral face. */
  const PARAMS = [
    ['browL_y', -1, 1, 0], ['browR_y', -1, 1, 0],             // brow height: -1 lowered .. +1 raised
    ['browL_ang', -1, 1, 0], ['browR_ang', -1, 1, 0],         // brow angle: -1 angry (inner end down) .. +1 worried (inner end up)
    ['browL_bend', -1, 1, 0], ['browR_bend', -1, 1, 0],       // brow bend: -1 sagging .. +1 arched
    ['eyeL_open', 0, 1.4, 1], ['eyeR_open', 0, 1.4, 1],       // upper lid: 0 closed .. ~0.5 half .. 1 neutral .. 1.4 wide
    ['eyeL_squint', 0, 1, 0], ['eyeR_squint', 0, 1, 0],       // lower lid pushed up (a smile, a wince)
    ['eyeL_happy', 0, 1, 0], ['eyeR_happy', 0, 1, 0],         // the "happy closed arc" of a big smile or a laugh
    ['gazeX', -1, 1, 0], ['gazeY', -1, 1, 0],                 // where the eyes look: +x picture right, +y up
    ['pupil', 0.6, 1.3, 1],                                   // iris size (smaller = shocked)
    ['mouthOpen', 0, 1, 0],                                   // 0 closed .. 1 the big shout
    ['mouthWide', -1, 1, 0],                                  // -1 pucker .. +1 wide
    ['mouthCornerL', -1.2, 1.6, 0], ['mouthCornerR', -1.2, 1.6, 0],   // each corner: down (frown) .. up (smile, smirk)
    ['mouthRound', 0, 1, 0],                                  // the "o"
    ['mouthPress', 0, 1, 0],                                  // lips pressed flat
    ['mouthTeeth', 0, 1, 0], ['mouthTongue', 0, 1, 0],        // how much of the teeth band / tongue shows in an open mouth
    ['mouthX', -1, 1, 0],                                     // mouth pushed sideways (+ picture right)
    ['blush', 0, 1, 0],                                       // extra blush on top of the painted one
  ];
  const NAMES = PARAMS.map((p) => p[0]);
  const REST = Object.freeze(Object.fromEntries(PARAMS.map((p) => [p[0], p[3]])));
  const LIMIT = Object.freeze(Object.fromEntries(PARAMS.map((p) => [p[0], [p[1], p[2]]])));
  /** A full parameter set: the rest face with `over` laid on top (unknown keys ignored, values clamped). */
  function params(over) {
    const out = Object.assign({}, REST);
    if (over) for (const k of NAMES) if (Number.isFinite(over[k])) out[k] = clamp(over[k], LIMIT[k][0], LIMIT[k][1]);
    return out;
  }
  /** Short form used by the presets: b: [y, ang, bend] per side or for both, e: [open, squint, happy], m: {...} */
  function face(o) {
    const p = {};
    const two = (v) => (Array.isArray(v[0]) ? v : [v, v]);
    if (o.brow) { const [l, r] = two(o.brow); p.browL_y = l[0]; p.browL_ang = l[1] || 0; p.browL_bend = l[2] || 0; p.browR_y = r[0]; p.browR_ang = r[1] || 0; p.browR_bend = r[2] || 0; }
    if (o.eye) { const [l, r] = two(o.eye); p.eyeL_open = l[0]; p.eyeL_squint = l[1] || 0; p.eyeL_happy = l[2] || 0; p.eyeR_open = r[0]; p.eyeR_squint = r[1] || 0; p.eyeR_happy = r[2] || 0; }
    if (o.gaze) { p.gazeX = o.gaze[0]; p.gazeY = o.gaze[1]; }
    if (o.pupil != null) p.pupil = o.pupil;
    if (o.mouth) {
      const m = o.mouth;
      if (m.open != null) p.mouthOpen = m.open;
      if (m.wide != null) p.mouthWide = m.wide;
      if (m.corner != null) { const c = Array.isArray(m.corner) ? m.corner : [m.corner, m.corner]; p.mouthCornerL = c[0]; p.mouthCornerR = c[1]; }
      if (m.round != null) p.mouthRound = m.round;
      if (m.press != null) p.mouthPress = m.press;
      if (m.teeth != null) p.mouthTeeth = m.teeth;
      if (m.tongue != null) p.mouthTongue = m.tongue;
      if (m.x != null) p.mouthX = m.x;
    }
    if (o.blush != null) p.blush = o.blush;
    return params(p);
  }

  // ------------------------------------------------------------------ the approved pictures, as parameter sets
  // Tuned by eye against the atlas (review/v2-fidelity-*.jpg). `approved` = has a picture in the atlas.
  const PRESETS = {
    ryo: {
      neutral: face({}),
      happy: face({ brow: [0.5, 0.35, 0.75], eye: [1.12, 0, 0], mouth: { open: 0.53, wide: 0.55, corner: [0.7, 1.1], teeth: 1, tongue: 0.9 }, blush: 0.2 }),
      talk: face({ mouth: { open: 0.33, wide: -0.41, corner: [0.11, -0.06], tongue: 0.8 } }),
      shout: face({ brow: [-0.3, -0.6, 0], eye: [1.05, 0, 0], mouth: { open: 1, wide: 0.85, corner: [0.65, 0.92], teeth: 1, tongue: 1 } }),
      surprised: face({ brow: [1, 0.5, 1], eye: [1.4, 0, 0], pupil: 0.95, mouth: { open: 0.375, round: 1 } }),
      smug: face({ brow: [[-0.4, -0.8, 0], [0.5, 0, 0.6]], eye: [[1.05, 0, 0], [0.95, 0, 0]], mouth: { wide: 0.56, corner: [0, 1.15], x: 0.78 } }),
      bored: face({ brow: [-0.2, 0.5, 0], eye: [0.55, 0, 0], mouth: { wide: -0.42, press: 0.6 } }),
      blink: face({ brow: [-0.15, 0.45, 0.2], eye: [0, 0, 0] }),
    },
    melanie: {
      neutral: face({}),
      skeptical: face({ brow: [[0, 0, 0], [0.7, 0.3, 0.8]], eye: [[0.95, 0, 0], [1, 0, 0]], mouth: { corner: [-0.25, 0.4], wide: 0.3 } }),
      smile: face({ brow: [0.2, 0.2, 0.4], eye: [1.15, 0, 0], mouth: { corner: [0.35, 1], wide: 0.45 }, blush: 0.3 }),
      talk: face({ mouth: { open: 0.5, wide: -0.05, tongue: 0.9, round: 0.25 } }),
      alarmed: face({ brow: [1, 0.6, 1], eye: [1.4, 0, 0], pupil: 0.95, mouth: { open: 0.95, round: 0.55, wide: 0.5, tongue: 1 } }),
      annoyed: face({ brow: [-0.8, -1, 0], eye: [0.5, 0, 0], mouth: { corner: -1, wide: -0.2 } }),
      blink: face({ eye: [0, 0, 0] }),
    },
  };
  const APPROVED = { ryo: ['neutral', 'happy', 'talk', 'shout', 'surprised', 'smug', 'bored', 'blink'], melanie: ['neutral', 'skeptical', 'smile', 'talk', 'alarmed', 'annoyed', 'blink'] };

  // ------------------------------------------------------------------ perf.face -> rig parameters
  /** Cartoon gain: sign(x) * gain * |x|^gamma. gamma under 1 lifts small movements (a real face moves less than a drawn one). */
  const curve = (x, gain, gamma) => (x >= 0 ? 1 : -1) * gain * Math.pow(Math.abs(x), gamma);
  /** Dead zone: nothing until |x| passes z, then straight on to 1 at 1 (sign kept). */
  const dz = (x, z) => { const a = Math.abs(x); return a <= z ? 0 : (x < 0 ? -1 : 1) * (a - z) / (1 - z); };
  /**
   * Per hero. PLAIN TALKING MUST READ AS PLAIN TALKING: every channel that fakes a mood while he only talks has a dead
   * zone (`DEAD`), measured on his own show footage as "where this channel sits while he talks with a level face".
   * Melanie's brows sit under her fringe and her eyes behind glasses, so her eyes and mouth carry the expression: his
   * lowered brows half-close her lids (her approved "annoyed"), her small mouth opens further for the same lip gap.
   */
  const GAIN = {
    ryo: { brow: 1.15, browGamma: 1.2, browDown: 1.0, eyeWide: 1.0, squint: 1.0, corner: 1.3, cornerGamma: 0.75, open: 1.1, openGamma: 0.9, wide: 1.1, gaze: 1.25,
      talkNarrow: 0.4, talkRound: 0, sternLid: 0.15, sternMouth: 0.3 },
    melanie: { brow: 1.3, browGamma: 1.1, browDown: 1.2, eyeWide: 1.25, squint: 1.15, corner: 1.5, cornerGamma: 0.7, open: 1.45, openGamma: 0.72, wide: 1.2, gaze: 1.3,
      talkNarrow: 0.15, talkRound: 0.25, sternLid: 0.55, sternMouth: 0.35 },
  };
  /**
   * Dead zones (in the calibrated units of perf.face: 0 = his neutral, 1 = his strong version).
   *   browUp     his brows ride at 0.2-0.5 for whole stretches of ordinary talk; a raise he MEANS reaches 0.6-1
   *   browDown   resting "down" evidence (blendshape up to 0.5 with no pinch, or a pinch with little blendshape) is his
   *              normal face when he looks into the camera, not a frown: a frown has BOTH (his stern one: 0.8 and 0.5)
   *   tilt       the brow angle wanders +-0.3 with the head and the talk; past that it is worried / angry
   *   eyeWide    lids sit up to 22 % over the learned neutral without any surprise in them; and wide eyes under level
   *              brows read as a glare, so most of "wide" needs the brows to go up with it (as his surprise does)
   *   eyeNarrow  and up to 10 % under it
   *   squint     the lower lid lifts a little with every open vowel
   *   frown      talking pulls the lip corners down by up to 0.2; a frown is counted on a (nearly) closed mouth
   *   press      lips closing between words are not "pressed lips"
   *   lidPair    a difference between the two lids under 0.12 is not shown, over 0.4 fully (squintPair: 0.2 / 0.6)
   *   open       lips only just parted are drawn closed (the approved resting lip line): a slit a few pixels high is a
   *              flat dark bar, and that bar made a calm face read bored or stern
   *   smileGate  the teeth grin and the lifted corners need the smile BLENDSHAPE (0.1 -> 0.35 fades it in): an open
   *              talking mouth lifts the corner landmarks too, but never that score (under 0.1 in 90 % of talk frames,
   *              0.3-0.9 in his smiles and laughs)
   */
  const DEAD = { browUp: 0.3, browDown: 0.42, tilt: 0.35, eyeWide: 0.22, roundFromWidth: 0.3, eyeNarrow: 0.1, squint: 0.25, frown: 0.2, press: 0.3, mouthX: 0.2, open: 0.1, lidPair: [0.12, 0.4], blinkPair: [0.6, 0.85], squintPair: [0.2, 0.6], smileGate: [0.1, 0.35] };
  const num = (v) => (Number.isFinite(v) ? v : 0);

  /**
   * The parameters the face should show for one tracked face (perf.face from tracking/lib/face-signal.js).
   * `out` (optional) is filled and returned. Nothing here is smoothed: FaceAnimator does that.
   */
  function mapFace(f, hero, out) {
    const p = out || {}, G = GAIN[hero] || GAIN.ryo;
    const bs = f.bs || {}, lm = f.lm || {}, b = (k) => num(bs[k]), l = (k) => num(lm[k]);
    const blinkL = f.blink ? num(f.blink[0]) : b('eyeBlinkLeft'), blinkR = f.blink ? num(f.blink[1]) : b('eyeBlinkRight');
    const pinch = l('browPinch');
    // ---- mouth first (the eyes use the smile)
    const openGeo = l('mouthOpen'), jaw = Math.max(b('jawOpen'), l('jaw'));
    const open = clamp(dz(clamp(G.open * Math.pow(clamp(Math.max(openGeo, 0.55 * jaw), 0, 1.3), G.openGamma), 0, 1), DEAD.open), 0, 1);
    const cornerL = l('cornerL'), cornerR = l('cornerR');
    // a REAL smile: the blendshape says so. Only then do the lifted corner landmarks count as well.
    const gate = sstep(DEAD.smileGate[0], DEAD.smileGate[1], Math.max(b('mouthSmileLeft'), b('mouthSmileRight')));
    const smileL = clamp((0.65 * b('mouthSmileLeft') + 0.6 * Math.max(0, cornerL)) * gate, 0, 1.3), smileR = clamp((0.65 * b('mouthSmileRight') + 0.6 * Math.max(0, cornerR)) * gate, 0, 1.3);
    const smile = (smileL + smileR) / 2;
    p.mouthOpen = open;
    // ---- brows (before the mouth corners and the lids: a stern brow sets both)
    const inner = b('browInnerUp');
    // rolling the eyes up drags MediaPipe's brow landmarks DOWN (measured on his footage: a look up read as a full
    // frown): the more he looks up, the less "brow down" is believed
    const lookUp = clamp(num((f.gaze || [0, 0])[1]), 0, 1);
    let stern = 0, browUp = 0;
    for (const S of ['L', 'R']) {
      const side = S === 'L' ? 'Left' : 'Right', h = l('brow' + S), tilt = dz(l('browTilt' + S), DEAD.tilt);
      const up = clamp(dz(Math.max(0, h, 0.8 * (0.6 * b('browOuterUp' + side) + 0.5 * inner)), DEAD.browUp), 0, 1.2);
      // "down" needs the landmarks AND the blendshape to agree before it is strong: a lowered brow is the first thing a
      // small error fakes, and these heroes' resting brows already look stern
      const dnGeo = Math.max(0, -h), dnBs = b('browDown' + side);
      const dn = clamp((0.6 * dnBs + 0.25 * Math.min(dnGeo, dnBs) + 0.5 * pinch - DEAD.browDown) / 0.4, 0, 1.2) * (1 - 0.85 * lookUp) * (1 - Math.min(1, 2 * up));
      p['brow' + S + '_y'] = clamp(curve(up, G.brow, G.browGamma) - G.browDown * dn, -1, 1);
      p['brow' + S + '_ang'] = clamp(0.9 * tilt * (tilt < 0 ? 1 - 0.7 * lookUp : 1) - 0.8 * dn + 0.25 * up, -1, 1);
      p['brow' + S + '_bend'] = clamp(0.95 * up - 0.4 * dn, -1, 1);
      stern += Math.min(1, dn) / 2; browUp += Math.min(1, up) / 2;
    }
    // ---- mouth corners, width, shape
    // a frown is read on a (nearly) closed mouth, and never while the smile score says he smiles (one corner read "down"
    // beside a smiling one drew an S-shaped mouth, mostly on day one before his own corner heights are learned)
    const closed = (1 - 0.85 * sstep(0.04, 0.25, openGeo)) * (1 - gate);
    const frownL = clamp(dz(Math.max(0, -cornerL), DEAD.frown) + G.sternMouth * stern, 0, 1.3) * closed, frownR = clamp(dz(Math.max(0, -cornerR), DEAD.frown) + G.sternMouth * stern, 0, 1.3) * closed;
    p.mouthCornerL = clamp(curve(smileL, G.corner, G.cornerGamma) - curve(frownL, G.corner * 0.95, G.cornerGamma), -1.2, 1.6);
    p.mouthCornerR = clamp(curve(smileR, G.corner, G.cornerGamma) - curve(frownR, G.corner * 0.95, G.cornerGamma), -1.2, 1.6);
    const pucker = b('mouthPucker'), funnel = b('mouthFunnel'), wideGeo = l('mouthWide');
    // a mouth that only talks is the approved "talk" mouth: narrower than the resting line, no teeth band
    const talking = sstep(0.08, 0.3, open) * (1 - Math.min(1, 1.5 * smile));
    p.mouthWide = clamp(curve(wideGeo, G.wide, 0.85) - 0.45 * pucker - G.talkNarrow * talking, -1, 1);
    p.mouthRound = clamp(Math.max(1.2 * funnel, 0.8 * pucker, 0.9 * Math.max(0, dz(-wideGeo, DEAD.roundFromWidth)), G.talkRound * talking) * sstep(0.06, 0.28, openGeo), 0, 1);
    const press = dz(Math.max(l('lipPress'), (b('mouthPressLeft') + b('mouthPressRight')) / 2, (b('mouthRollLower') + b('mouthRollUpper')) / 2), DEAD.press);
    p.mouthPress = clamp(1.2 * press * (1 - 3 * open), 0, 1);
    // teeth: the grin of a real smile, or a wide-open shout. Never just an open talking mouth.
    p.mouthTeeth = clamp(sstep(0.1, 0.28, open) * (1.25 * smile + 0.6 * sstep(0.7, 1, openGeo) * Math.max(0, wideGeo)) * (1 - p.mouthRound), 0, 1);
    p.mouthTongue = clamp(sstep(0.12, 0.4, open) * 0.9, 0, 1);
    p.mouthX = clamp(1.2 * dz(l('mouthX'), DEAD.mouthX), -1, 1);
    p.blush = clamp(0.7 * sstep(0.45, 1, smile), 0, 1);
    // ---- eyes
    let wideAll = 0;
    // the laughing "closed arc": a big REAL smile while his own eyes narrow. Both eyes together (a laugh is not a wink),
    // and a steep curve so the face does not sit half way between an open eye and an arc. The lid value used here is the
    // one held over a blink's length, and the smile is the gated one: a blink while he talks is a blink, not a laugh.
    const openAvg = ((Number.isFinite(lm.eyeOpenL) ? lm.eyeOpenL : 1) + (Number.isFinite(lm.eyeOpenR) ? lm.eyeOpenR : 1)) / 2;
    const happy = sstep(0.6, 0.82, smile) * sstep(0.92, 0.7, openAvg);
    const lids = { L: 1, R: 1 }, sqz = { L: 0, R: 0 };
    for (const [S, sm] of [['L', smileL], ['R', smileR]]) {
      const side = S === 'L' ? 'Left' : 'Right', o = Number.isFinite(lm['eyeOpen' + S]) ? lm['eyeOpen' + S] : 1;
      const wide = clamp((o - 1 - DEAD.eyeWide) / (0.5 - DEAD.eyeWide), 0, 1.2) * G.eyeWide * (0.3 + 0.7 * sstep(0.1, 0.5, browUp));
      const narrow = clamp((1 - DEAD.eyeNarrow - o) / (1 - DEAD.eyeNarrow), 0, 1);
      // a stern brow lowers the lid (Melanie: to her approved "annoyed" half lids, her brows being under the fringe)
      lids[S] = Math.max(0, (o >= 1 ? 1 + 0.4 * Math.min(1, wide) : 1 - 1.2 * narrow) * (1 - G.sternLid * Math.min(1, stern) * (1 - Math.min(1, wide))));
      const squint = clamp(G.squint * dz(Math.max(l('squint' + S), 0.8 * b('eyeSquint' + side)), DEAD.squint) * (1 - 0.6 * Math.min(1, wide)) + 0.3 * sm, 0, 1);
      sqz[S] = squint;
      p['eye' + S + '_happy'] = happy;
      wideAll += Math.min(1, wide) / 2;
    }
    // the two lids move together: a small difference between the eyes is the camera (a turned head, one eye in shadow),
    // not him. Only a clear difference (one eye really narrowed) is shown; a wink comes through `blink`, untouched.
    const lidGap = lids.L - lids.R, lidMid = (lids.L + lids.R) / 2, lidKeep = sstep(DEAD.lidPair[0], DEAD.lidPair[1], Math.abs(lidGap));
    // a blink in transit: one eye shut and the other well on its way = both shut (in a wink the open eye reads near 0)
    let bL = clamp(blinkL, 0, 1), bR = clamp(blinkR, 0, 1);
    if (Math.max(bL, bR) > 0.8 && Math.min(bL, bR) > 0.3) bL = bR = Math.max(bL, bR);
    // one eye HALF shut and the other open is the camera too (a turned or tilted head: the tracker reads 0.5 - 0.7 on one
    // eye for a few frames), and it draws as a half wink. A lone eye closes with the other until it is clearly shut
    // (a real wink reads over 0.85 and is snapped by js/expr.js from the tracker's own numbers, not from these).
    { const hi = Math.max(bL, bR), lo = Math.min(bL, bR), one = lo + (hi - lo) * sstep(DEAD.blinkPair[0], DEAD.blinkPair[1], hi); if (bL > bR) bL = one; else bR = one; }
    p.eyeL_open = clamp((lidMid + lidGap / 2 * lidKeep) * (1 - bL), 0, 1.4);
    p.eyeR_open = clamp((lidMid - lidGap / 2 * lidKeep) * (1 - bR), 0, 1.4);
    // the lower lids as well (one eye in shadow squinted more than the other in every frame of his stern face)
    const sqGap = sqz.L - sqz.R, sqMid = (sqz.L + sqz.R) / 2, sqKeep = sstep(DEAD.squintPair[0], DEAD.squintPair[1], Math.abs(sqGap));
    p.eyeL_squint = clamp(sqMid + sqGap / 2 * sqKeep, 0, 1) * (1 - happy);
    p.eyeR_squint = clamp(sqMid - sqGap / 2 * sqKeep, 0, 1) * (1 - happy);
    const gz = f.gaze || [0, 0];
    p.gazeX = clamp(G.gaze * num(gz[0]), -1, 1); p.gazeY = clamp(G.gaze * num(gz[1]), -1, 1);
    p.pupil = clamp(1 - 0.2 * wideAll * (0.5 + 0.5 * clamp(Math.max(p.browL_y, p.browR_y), 0, 1)), 0.6, 1.3);
    return p;
  }

  // ------------------------------------------------------------------ per frame
  function seeded(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /** Spring per parameter group: [frequency Hz, damping ratio]. Under 1 = a small overshoot and settle (the snap). */
  const SPRING = { brow: [8, 0.42], eye: [14, 0.5], happy: [8, 0.8], gaze: [11, 0.8], mouth: [12, 0.62], corner: [9, 0.5], slow: [5, 1] };
  const GROUP = (name) => (/^brow/.test(name) ? 'brow' : /_open$|_squint$/.test(name) ? 'eye' : /_happy$/.test(name) ? 'happy' : /^gaze|^pupil/.test(name) ? 'gaze'
    : /^mouthCorner/.test(name) ? 'corner' : /^mouth(Teeth|Tongue)|^blush/.test(name) ? 'slow' : 'mouth');
  const LIDS = ['eyeL_open', 'eyeR_open'];
  const ANIM = Object.freeze({
    staleMs: 350,          // no perf for this long = not tracked (hold the last face until then, then ease to the idle face)
    lostEaseMs: 450,
    interpMinMs: 8, interpMaxMs: 100, interpDefaultMs: 33,
    micAttackMs: 12, micReleaseMs: 90, micSlowMs: 260,
    micOnTracked: 0.55,    // how much a syllable's burst opens the mouth on top of the tracked shape
    micAlone: 0.75,        // the mouth from the microphone alone (no face tracked)
    micStaleMs: 350,
    blinkEveryMs: [2000, 6000], blinkMs: 130,
    // a hand (a cup, a wipe of the nose) over the lower face: MediaPipe keeps reporting a face there with wrong mouth,
    // brow and lid values. While perf.hands.overFace is true and for holdAfterMs after it, those parameters stay at
    // what they were holdBackMs BEFORE the hand arrived (a cup covers his mouth about 0.3 s before the hand counts as
    // over the face, so the newest values are already wrong: a short memory of the last holdKeepMs is kept for this),
    // then ease back to the tracked face over holdEaseMs.
    holdAfterMs: 250, holdBackMs: 400, holdEaseMs: 300, holdKeepMs: 900,
  });
  // Round 5: a look DOWN (at his desk, his phone) reads as a blink for as long as it lasts (the tracker's blink is 1.00 for
  // the whole 0.5 - 2 s: measured on body-close 1.4 - 3.3 s, show-mixed 22.5 - 23.0 s), and the avatar stood with its eyes
  // shut. A real blink is over in 0.3 s. So: both eyes 'shut' with the gaze far down for longer than `afterMs`, and the
  // lid gap not really closed (`minOpen`), is a look down: the lids come up to `lid` (lowered, not shut).
  const LOOKDOWN = { gaze: -0.55, afterMs: 380, minOpen: 0.16, lid: 0.62, lockGaze: -0.5, lockEaseMs: 160 };   // lockGaze: where locked eyes go in a look down
  /** What a hand over the face freezes: mouth, brows, lids (not the gaze, not the head; idle blinks go on). */
  const HELD = PARAMS.map((q) => q[0]).filter((k) => /^mouth|^brow|^eye[LR]_|^blush/.test(k));

  /**
   * One per avatar. Feed it `perf.face` messages, microphone levels and the held preset; ask it every frame for the
   * parameters to draw. It never jumps: targets are interpolated between perf messages over their capture interval
   * (`at`), then followed by a spring per parameter.
   */
  class FaceAnimator {
    constructor(hero, seed) {
      this.hero = hero; this.rand = seeded(seed == null ? 5 : seed);
      this.from = params(); this.to = params(); this.target = params(); this.out = params();
      this.vel = Object.fromEntries(NAMES.map((n) => [n, 0]));
      this.tArrive = -1e9; this.dur = ANIM.interpDefaultMs; this.lastAt = null; this.lastPerf = -1e9; this.hasFace = false;
      this.mic = 0; this.micSlow = 0; this.micTarget = 0; this.micAt = -1e9;
      this.preset = null; this.presetParams = null;
      this.idle = { blinkNext: -1, blinkUntil: -1, gazeNext: -1, gx: 0, gy: 0, browNext: -1, brow: 0 };
      this.last = null; this.tracked = false; this.talk = 0; this.gazeLive = [0, 0];
      this.over = false; this.overEnd = -1e9; this.held = null; this.hist = []; this.holdBlink = { next: -1, until: -1 };
      this.lock = null;      // round 5, eyes on camera: { x, y } = where the eyes must point (the lens, against the head's own turn); null = his gaze
      this.v5 = null;        // V5 (js/expr.js VTExpr.create(hero)): the voice-led mouth and the snapping expressions; null = the v2 face
    }
    /** perf.hands.overFace of the newest perf message (a missing field = false: behave as without it). Call before pushPerf. */
    setOverFace(on, now) {
      on = on === true;
      if (on && !this.over && now - this.overEnd > ANIM.holdAfterMs + ANIM.holdEaseMs) {
        // the hand has just arrived: hold what the face showed a moment before it
        let pick = null;
        for (const h of this.hist) if (now - h.t >= ANIM.holdBackMs) pick = h;
        this.held = pick ? pick.p : (this.hist.length ? this.hist[0].p : null);
        this.holdBlink.next = -1;
      }
      if (!on && this.over) this.overEnd = now;
      this.over = on;
    }
    /** 1 while the held values rule, falling to 0 as they ease back, 0 otherwise. */
    holdWeight(now) {
      if (!this.held) return 0;
      if (this.over) return 1;
      const since = now - this.overEnd - ANIM.holdAfterMs;
      if (since <= 0) return 1;
      if (since >= ANIM.holdEaseMs) { this.held = null; return 0; }
      return 1 - sstep(0, 1, since / ANIM.holdEaseMs);
    }
    setHero(hero) { if (hero !== this.hero) { this.hero = hero; if (this.preset) this.setPreset(this.preset); } if (this.v5) this.v5.setHero(hero); }
    /** A perf message's face (or null when the tracker sees none). `at` = its capture time, `now` = this page's clock. */
    /** the face with a long look down no longer counted as a blink (see LOOKDOWN); the same object when there is none */
    _lookDown(face, now) {
      this.downOn = false;
      if (!face) { this.downAt = -1; return face; }
      const bl = face.blink, gz = face.gaze, lm = face.lm || {};
      const down = Array.isArray(bl) && bl[0] > 0.7 && bl[1] > 0.7 && Array.isArray(gz) && gz[1] < LOOKDOWN.gaze;
      if (!down) { this.downAt = -1; return face; }
      if (!(this.downAt >= 0)) this.downAt = now;
      if (now - this.downAt < LOOKDOWN.afterMs) return face;
      const o = ((Number.isFinite(lm.eyeOpenL) ? lm.eyeOpenL : 1) + (Number.isFinite(lm.eyeOpenR) ? lm.eyeOpenR : 1)) / 2;
      if (o < LOOKDOWN.minOpen) return face;                 // the lids really are shut
      this.downOn = true;
      const f = this._down || (this._down = { blink: [0, 0] });
      for (const k in face) if (k !== 'blink') f[k] = face[k];
      return f;
    }
    pushPerf(face, at, now) {
      face = this._lookDown(face, now);
      if (this.v5) this.v5.push(face || null, now);
      if (!face) { this.hasFace = false; return; }
      for (const k of NAMES) this.from[k] = this.target[k];
      mapFace(face, this.hero, this.to);
      for (const k of NAMES) this.to[k] = Number.isFinite(this.to[k]) ? clamp(this.to[k], LIMIT[k][0], LIMIT[k][1]) : REST[k];
      if (this.downOn) { this.to.eyeL_open = Math.max(this.to.eyeL_open, LOOKDOWN.lid); this.to.eyeR_open = Math.max(this.to.eyeR_open, LOOKDOWN.lid); }
      const hw = this.holdWeight(now);
      if (hw > 0) { for (const k of HELD) this.to[k] = lerp(this.to[k], this.held[k], hw); }
      else {
        // remember the last moments of the tracked face (for a hold that may start)
        const rec = this.hist.length && now - this.hist[0].t > ANIM.holdKeepMs ? this.hist.shift() : { t: 0, p: {} };
        rec.t = now; for (const k of HELD) rec.p[k] = this.to[k];
        this.hist.push(rec);
      }
      const gap = this.lastAt == null || !Number.isFinite(at) ? ANIM.interpDefaultMs : at - this.lastAt;
      this.dur = this.hasFace && gap > 0 ? clamp(gap, ANIM.interpMinMs, ANIM.interpMaxMs) : ANIM.interpDefaultMs;
      this.lastAt = Number.isFinite(at) ? at : null; this.tArrive = now; this.lastPerf = now; this.hasFace = true;
    }
    pushMic(level, now, bands) { this.micTarget = clamp(Number(level) || 0, 0, 1); this.micAt = now; if (this.v5) this.v5.mic(this.micTarget, bands, now); }
    /** name: one of PRESETS[hero] (a held face that overrides tracking) or null. */
    setPreset(name) {
      const set = PRESETS[this.hero] || {};
      this.preset = name && set[name] ? name : null;
      this.presetParams = this.preset ? set[this.preset] : null;
    }
    _idle(now, t) {
      const I = this.idle, r = this.rand;
      if (I.blinkNext < 0) I.blinkNext = now + ANIM.blinkEveryMs[0] + (ANIM.blinkEveryMs[1] - ANIM.blinkEveryMs[0]) * r();
      if (now >= I.blinkNext) { I.blinkUntil = now + ANIM.blinkMs; I.blinkNext = now + ANIM.blinkEveryMs[0] + (ANIM.blinkEveryMs[1] - ANIM.blinkEveryMs[0]) * r(); }
      if (now >= I.gazeNext) { I.gazeNext = now + 700 + 2200 * r(); I.gx = (r() - 0.5) * 0.7; I.gy = (r() - 0.5) * 0.35; }
      if (now >= I.browNext) { I.browNext = now + 1500 + 3500 * r(); I.brow = (r() - 0.35) * 0.3; }
      const blink = now < I.blinkUntil ? 0 : 1;
      t.eyeL_open *= blink; t.eyeR_open *= blink;
      t.gazeX += I.gx; t.gazeY += I.gy;
      t.browL_y += I.brow; t.browR_y += I.brow; t.browL_bend += Math.max(0, I.brow); t.browR_bend += Math.max(0, I.brow);
    }
    /** The parameters to draw now. dt = milliseconds since the last call. */
    update(now, dt) {
      const step = clamp(Number(dt) || 0, 0, 100);
      // microphone envelope: fast up, slower down; its slow average separates "a syllable" from "talking"
      const micIn = now - this.micAt > ANIM.micStaleMs ? 0 : this.micTarget;
      this.mic += (micIn - this.mic) * (1 - Math.exp(-step / (micIn > this.mic ? ANIM.micAttackMs : ANIM.micReleaseMs)));
      this.micSlow += (this.mic - this.micSlow) * (1 - Math.exp(-step / ANIM.micSlowMs));
      const tracked = this.hasFace && now - this.lastPerf <= ANIM.staleMs;
      this.tracked = tracked;
      const T = this.target;
      if (tracked) {
        const u = clamp((now - this.tArrive) / this.dur, 0, 1);
        for (const k of NAMES) T[k] = lerp(this.from[k], this.to[k], u);
        // a blink is over in five frames: a lid that is closing fast goes straight to the newest sample
        for (const k of LIDS) if (this.to[k] < this.from[k] - 0.4) T[k] = this.to[k];
      }
      // what to aim at this frame
      const aim = this._aim || (this._aim = params());
      if (this.presetParams) {
        for (const k of NAMES) aim[k] = this.presetParams[k];
        // a held face still talks and blinks: the live mouth opens a closed preset mouth, the live lids close open eyes
        const liveOpen = tracked ? T.mouthOpen : 0;
        const talkOpen = Math.max(liveOpen * 0.8, ANIM.micAlone * Math.pow(this.mic, 0.8) * 0.8);
        if (aim.mouthOpen < 0.3 && talkOpen > aim.mouthOpen) { aim.mouthOpen = talkOpen; aim.mouthTongue = Math.max(aim.mouthTongue, 0.7 * sstep(0.12, 0.4, talkOpen)); aim.mouthPress = 0; }
        if (tracked) { if (aim.eyeL_open > 0.3) aim.eyeL_open *= clamp(T.eyeL_open, 0, 1); if (aim.eyeR_open > 0.3) aim.eyeR_open *= clamp(T.eyeR_open, 0, 1); }
        else if (aim.eyeL_open > 0.3 && aim.eyeR_open > 0.3) {
          const o = { eyeL_open: 1, eyeR_open: 1, gazeX: 0, gazeY: 0, browL_y: 0, browR_y: 0, browL_bend: 0, browR_bend: 0 };
          this._idle(now, o); aim.eyeL_open *= o.eyeL_open; aim.eyeR_open *= o.eyeR_open;
        }
      } else if (tracked) {
        for (const k of NAMES) aim[k] = T[k];
        // the microphone hears a syllable before the camera shows it: its burst opens the mouth a little more, at once
        // (V5: the voice and the camera together shape the mouth, and a recognised expression snaps: js/expr.js)
        if (this.v5) this.v5.apply(aim, now, step, true);
        else {
          const burst = Math.max(0, this.mic - this.micSlow);
          aim.mouthOpen = clamp(aim.mouthOpen + ANIM.micOnTracked * burst * (1 - 0.6 * aim.mouthOpen), 0, 1);
        }
        // a hand over the face: his own blinks cannot be seen, so the held eyes blink by themselves (the face stays alive)
        if (this.over && this.held) {
          const B = this.holdBlink;
          if (B.next < 0) B.next = now + 1200 + 2500 * this.rand();
          if (now >= B.next) { B.until = now + ANIM.blinkMs; B.next = now + ANIM.blinkEveryMs[0] + (ANIM.blinkEveryMs[1] - ANIM.blinkEveryMs[0]) * this.rand(); }
          if (now < B.until) { aim.eyeL_open = 0; aim.eyeR_open = 0; }
        }
      } else {
        // tracking lost: the last face is held (staleMs), then eases into the idle face; it never snaps
        const e = sstep(0, 1, (now - this.lastPerf - ANIM.staleMs) / ANIM.lostEaseMs);
        for (const k of NAMES) aim[k] = lerp(T[k], REST[k], e);
        if (e > 0.5) this._idle(now, aim);
        const m = ANIM.micAlone * Math.pow(this.mic, 0.8);
        if (m > 0.02) {
          aim.mouthOpen = clamp(m, 0, 1); aim.mouthTongue = 0.8 * sstep(0.12, 0.4, m); aim.mouthTeeth = sstep(0.5, 0.9, m);
          aim.mouthWide = 0.5 * sstep(0.45, 0.9, m) - 0.25 * (1 - sstep(0.1, 0.4, m)); aim.mouthCornerL = aim.mouthCornerR = 0.5 * sstep(0.5, 0.95, m);
        }
        if (this.v5) this.v5.apply(aim, now, step, false);     // a snapped expression eases out with the lost face
      }
      // eyes on camera: where the eyes POINT is the lens, whatever he looks at (lids, squints, winks, brows and mouth are
      // still his; a held manual face keeps its own eyes)
      this.gazeLive[0] = aim.gazeX; this.gazeLive[1] = aim.gazeY;
      // ... except in a long look down (LOOKDOWN): eyes held on the lens under lowered lids read as a heavy-lidded glance at
      // the viewer, which is not what he is doing. There the eyes go most of the way down with him and come back as he does.
      this.downW = (this.downW || 0) + ((this.downOn && tracked ? 1 : 0) - (this.downW || 0)) * (1 - Math.exp(-step / LOOKDOWN.lockEaseMs));
      if (this.lock && !this.presetParams) { aim.gazeX = clamp(this.lock.x, -1, 1); aim.gazeY = clamp(this.lock.y, -1, 1); if (this.downW > 0.002) aim.gazeY = lerp(aim.gazeY, Math.min(aim.gazeY, LOOKDOWN.lockGaze), this.downW); }
      this.talk = Math.max(this.mic, tracked ? clamp(T.mouthOpen * 1.5, 0, 1) * 0.6 : 0);
      // springs (sub-stepped so a long frame cannot blow up)
      const o = this.out, v = this.vel;
      if (this.last == null) { for (const k of NAMES) { o[k] = aim[k]; v[k] = 0; } }
      else {
        const n = Math.max(1, Math.ceil(step / 4)), h = step / n / 1000;
        for (const k of NAMES) {
          const [hz, zeta] = SPRING[GROUP(k)], w = 2 * Math.PI * hz;
          let x = o[k], vel = v[k];
          const a = aim[k];
          for (let i = 0; i < n; i++) { vel += (w * w * (a - x) - 2 * zeta * w * vel) * h; x += vel * h; }
          // nothing overshoots through its limit (a lid does not go past "closed")
          if (x < LIMIT[k][0]) { x = LIMIT[k][0]; if (vel < 0) vel = 0; } else if (x > LIMIT[k][1]) { x = LIMIT[k][1]; if (vel > 0) vel = 0; }
          o[k] = x; v[k] = vel;
        }
      }
      this.last = now;
      return o;
    }
  }

  return { clamp, lerp, sstep, PARAMS, NAMES, REST, LIMIT, params, face, PRESETS, APPROVED, GAIN, DEAD, HELD, SPRING, ANIM, LOOKDOWN, curve, dz, mapFace, FaceAnimator };
});
