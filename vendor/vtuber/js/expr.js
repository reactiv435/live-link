// V5: the mouth that follows his SPEECH, and expressions that SNAP.
// Pure logic (no DOM, no Babylon): shared by avatar.html (through FaceAnimator in js/face-map.js) and the tests.
//
//   const v5 = VTExpr.create(hero)             one per FaceAnimator: `anim.v5 = v5` switches all of this on
//   v5.push(face, now)                         every perf.face (tracking/lib/face-signal.js), null = no face
//   v5.mic(level, bands, now)                  every `mic` message (bands = the four band levels of js/voice.js, or undefined)
//   v5.apply(aim, anim, now, dt, tracked)      called by FaceAnimator.update on the parameters it aims at, before the springs
//   v5.state()                                 { expr, weights, voice, gate, counts } for the page's debug and the tools
//
// 1. THE MOUTH. His jaw hardly moves when he talks (jawOpen: median 0.03-0.06, 90 % under 0.25 on his show footage), so
//    the camera alone gives a mouth that sits nearly shut. His voice gives the timing (no camera delay) and the vowel
//    (open "ah", wide "ee", round "oo", teeth together "s"). The camera is the witness: the voice moves the mouth only
//    while the camera sees his lips move (`gate`), so music or another voice on the microphone never flaps a shut mouth.
// 2. SNAPPING. A classifier over the calibrated blendshape scores (+ the voice) names the expression he is close to.
//    Each has a score, an ENTER level, an EXIT level under it (hysteresis), a dwell before it starts and a minimum
//    hold. While one is on, its authored, exaggerated face (SNAP[hero][name]) is laid over the live face; his gaze,
//    blinks, head and talking mouth stay live. No expression = the live face, untouched: neutral stays neutral.
(function (root, factory) {
  const Voice = (typeof module === 'object' && module && module.exports) ? require('./voice.js') : root.VTVoice;
  const api = factory(Voice);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTExpr = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (Voice) {
  'use strict';
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const num = (v) => (Number.isFinite(v) ? v : 0);

  // ------------------------------------------------------------------ the classifier
  /**
   * Per expression: enter / exit = levels of its score, dwellMs = how long the score must stay over `enter` before
   * the face snaps, holdMs = the least time it stays, rank = who wins when two are on (higher wins).
   * The levels were set on his own footage (calibrated scores; review/V5-NOTES.md has the table): e.g. his smile
   * score is under 0.03 in 90 % of plain talk and 0.65 at the median of a laugh; his brows-down score is under 0.44 in
   * 90 % of talk and 0.80 at the median of his stern face; he raises his brows to 0.5-0.7 in ordinary talk, so
   * "surprise" needs more than that and has to last.
   */
  const RULES = {
    wink: { enter: 0.6, exit: 0.35, dwellMs: 180, holdMs: 380, rank: 10 },                   // fix round: was 110 (one-eyed blinks while he talks read as winks)
    laugh: { enter: 0.6, exit: 0.3, dwellMs: 90, holdMs: 1600, underMs: 500, rank: 9 },      // fix round B5: was 1000 / 260 (a long laugh flickered)
    grin: { enter: 0.6, exit: 0.32, dwellMs: 130, holdMs: 800, underMs: 260, rank: 8 },
    smirk: { enter: 0.6, exit: 0.35, dwellMs: 200, holdMs: 600, rank: 7 },
    smile: { enter: 0.55, exit: 0.28, dwellMs: 110, holdMs: 700, underMs: 380, rank: 6 },
    shocked: { enter: 0.6, exit: 0.35, dwellMs: 170, holdMs: 600, rank: 5 },
    surprise: { enter: 0.6, exit: 0.35, dwellMs: 230, holdMs: 550, rank: 4 },
    angry: { enter: 0.6, exit: 0.35, dwellMs: 280, holdMs: 650, underMs: 300, rank: 3 },
    sad: { enter: 0.6, exit: 0.35, dwellMs: 300, holdMs: 700, rank: 2 },
    squint: { enter: 0.6, exit: 0.35, dwellMs: 320, holdMs: 600, rank: 1 },
    tongue: { enter: 0.6, exit: 0.35, dwellMs: 150, holdMs: 500, rank: 11 },
  };
  const NAMES = Object.keys(RULES);
  const EASE = { inMs: 70, outMs: 190 };
  // Fix round B5: the smile family (smile, big grin, laugh) is one feeling. A long laugh crossed its three levels 31
  // times in 26 s (eyes shut, open, shut). The latch:
  //   - while he still smiles, a laugh stays on until its own score has been away for `laughLatchMs` (not 0.5 s);
  //   - after a laugh the only step down is to the smile: no big grin for `afterLaughMs`;
  //   - a smirk (one corner up) cannot start within `smirkAfterMs` of any of the three: half way out of a laugh one
  //     corner always leads;
  //   - a face that has just gone is kept `stepDownMs` before a lower one may show (it often comes straight back),
  //     and inside the family a step DOWN waits until the face has been shown `familyMinMs`.
  // Surprise from a brow JUMP (he raises his brows for emphasis while he talks): after one ends, no new one for
  // `jumpRestMs`, and it is drawn milder than a real, wide-eyed surprise (SOFT_SURPRISE).
  const LATCH = { laughLatchMs: 1500, afterLaughMs: 1500, smirkAfterMs: 1200, stepDownMs: 250, familyMinMs: 1100, jumpRestMs: 1500 };
  const FAMILY = ['smile', 'grin', 'laugh'];

  /** The measurements the scores are made of, from one perf.face. */
  function features(f, voice) {
    const bs = f.bs || {}, lm = f.lm || {}, b = (k) => num(bs[k]), l = (k) => num(lm[k]);
    const smL = b('mouthSmileLeft'), smR = b('mouthSmileRight');
    const blink = Array.isArray(f.blink) ? [num(f.blink[0]), num(f.blink[1])] : [b('eyeBlinkLeft'), b('eyeBlinkRight')];
    const eyeL = Number.isFinite(lm.eyeOpenL) ? lm.eyeOpenL : 1, eyeR = Number.isFinite(lm.eyeOpenR) ? lm.eyeOpenR : 1;
    return {
      smL, smR, sm: (smL + smR) / 2,
      jaw: Math.max(b('jawOpen'), 0.9 * l('mouthOpen')),
      browUp: clamp(Math.max((l('browL') + l('browR')) / 2, 0.6 * (b('browOuterUpLeft') + b('browOuterUpRight')) / 2 + 0.5 * b('browInnerUp')), 0, 1.3),
      browIn: b('browInnerUp'), browDn: (b('browDownLeft') + b('browDownRight')) / 2, pinch: l('browPinch'),
      tilt: (l('browTiltL') + l('browTiltR')) / 2,
      frown: Math.max((b('mouthFrownLeft') + b('mouthFrownRight')) / 2, -(l('cornerL') + l('cornerR')) / 2),
      eye: (eyeL + eyeR) / 2, squint: (b('eyeSquintLeft') + b('eyeSquintRight')) / 2,
      blinkL: blink[0], blinkR: blink[1],
      pucker: Math.max(b('mouthPucker'), b('mouthFunnel')), wide: l('mouthWide'),
      tongue: b('tongueOut'),
      yaw: Math.abs(num((f.rot || [0])[0])),
      aside: Math.max(sstep(0.45, 0.7, Math.abs(num((f.gaze || [0])[0]))), sstep(14, 24, Math.abs(num((f.rot || [0])[0])))),   // a look to the side (the chat): lowered brows there are not anger
      down: Math.max(sstep(8, 16, -num((f.rot || [0, 0])[1])), sstep(0.35, 0.6, -num((f.gaze || [0, 0])[1]))),   // looking down (at his hands, his desk): the brow scores drop with it
      loud: voice && voice.on ? voice.loud : 0,
    };
  }
  /** The score of every expression (0..1) for those measurements. */
  function scores(m, out) {
    const s = out || {};
    const noSmile = 1 - sstep(0.15, 0.32, m.sm), shut = 1 - sstep(0.2, 0.42, m.jaw);
    // a laugh = a big smile with the jaw dropped, or with the eyes squeezed while the mouth is open (smiling talk is a smile)
    s.laugh = sstep(0.48, 0.7, m.sm) * Math.max(sstep(0.4, 0.6, m.jaw), sstep(0.55, 0.75, m.squint) * sstep(0.15, 0.3, m.jaw));
    s.grin = sstep(0.6, 0.85, m.sm) * (1 - sstep(0.3, 0.5, m.jaw));
    s.smile = sstep(0.28, 0.5, m.sm);
    const hi = Math.max(m.smL, m.smR), lo = Math.min(m.smL, m.smR);
    s.smirk = sstep(0.32, 0.52, hi) * sstep(0.22, 0.38, hi - lo) * (1 - sstep(0.22, 0.4, lo)) * shut;
    s.shocked = sstep(0.55, 0.8, m.jaw) * sstep(0.4, 0.7, m.browUp) * noSmile;
    // brows far up, or brows that JUMP up against where they have been riding (he talks with raised brows for whole
    // stretches: only the jump is a surprise)
    const surOk = noSmile * (1 - sstep(0.3, 0.5, m.browDn));
    m.surFar = sstep(0.78, 0.98, m.browUp) * surOk;                                             // brows far up: the full surprise
    m.surJump = m.noJump ? 0 : sstep(0.25, 0.42, m.browUp - num(m.browBase)) * sstep(0.55, 0.75, m.browUp) * surOk;   // a jump: the milder one
    s.surprise = Math.max(m.surFar, m.surJump);
    if (m.noSmirk) s.smirk = 0;
    s.angry = sstep(0.55, 0.78, m.browDn) * sstep(0.25, 0.5, m.pinch + 0.5 * m.browDn) * noSmile * (1 - sstep(0.3, 0.6, m.browUp)) * (1 - num(m.down)) * (1 - 0.6 * num(m.aside));
    s.sad = sstep(0.38, 0.6, m.frown) * sstep(0.35, 0.6, Math.max(m.browIn, m.tilt)) * (1 - sstep(0.3, 0.5, m.browDn)) * shut * noSmile;
    s.squint = sstep(0.7, 0.86, m.squint) * sstep(1.02, 0.86, m.eye) * (1 - sstep(0.5, 0.7, m.browDn)) * noSmile * (1 - sstep(0.5, 0.8, Math.max(m.blinkL, m.blinkR))) * (1 - num(m.down));     // lowered lids on a look down are not a squint
    const bh = Math.max(m.blinkL, m.blinkR), bl = Math.min(m.blinkL, m.blinkR);
    s.wink = sstep(0.62, 0.8, bh) * (1 - sstep(0.2, 0.4, bl)) * (1 - sstep(14, 22, m.yaw));
    s.tongue = sstep(0.35, 0.6, m.tongue);     // MediaPipe's face model gives no tongue score today (always 0): kept for a tracker that does
    return s;
  }

  class Classifier {
    constructor(rules) {
      this.rules = rules || RULES;
      this.t = {}; for (const n of NAMES) this.t[n] = { over: -1, under: -1, on: false, since: -1e9 };
      this.cur = null; this.side = 1; this.s = {}; this.m = null;
      this.soft = false; this.jumpEndAt = -1e9; this.familyAt = -1e9; this.laughEndAt = -1e9; this.laughSeenAt = -1e9; this.curSince = -1e9; this.lostAt = -1; this.now = 0;
      this.counts = Object.fromEntries(NAMES.map((n) => [n, 0])); this.ms = Object.fromEntries(NAMES.map((n) => [n, 0])); this.lastNow = null;
    }
    reset() { for (const n of NAMES) { const t = this.t[n]; t.over = t.under = -1; t.on = false; } this.cur = null; this.soft = false; this.lostAt = -1; this.jumpEndAt = this.familyAt = this.laughEndAt = this.laughSeenAt = this.curSince = -1e9; }
    /** One perf.face (or null) -> the name of the expression that is on, or null. */
    push(f, voice, now) {
      if (this.lastNow != null && this.cur) this.ms[this.cur] += clamp(now - this.lastNow, 0, 200);
      this.lastNow = now; this.now = now;
      if (!f) {       // no face: what is on runs out its hold, nothing new starts
        for (const n of NAMES) { const t = this.t[n]; t.over = -1; if (t.on && now - t.since > this.rules[n].holdMs) t.on = false; }
        return this._pick();
      }
      const m = this.m = features(f, voice);
      // where his brows have been riding lately (about 4 s; it follows a fall faster than a rise)
      const dtB = this.browAt == null ? 0 : clamp(now - this.browAt, 0, 500); this.browAt = now;
      this.browBase = this.browBase == null ? m.browUp : this.browBase + (m.browUp - this.browBase) * (1 - Math.exp(-dtB / (m.browUp < this.browBase ? 1200 : 4000)));
      m.browBase = this.browBase;
      m.noJump = !this.t.surprise.on && now - this.jumpEndAt < LATCH.jumpRestMs;                 // a brow-jump surprise just ended
      m.noSmirk = !this.t.smirk.on && now - this.familyAt < LATCH.smirkAfterMs;                  // inside / just after a smile, grin or laugh
      const s = scores(m, this.s);
      if (s.laugh >= this.rules.laugh.exit) this.laughSeenAt = now;
      const smiling = this.t.smile.on || this.t.grin.on || s.smile >= this.rules.smile.exit;
      for (const n of NAMES) {
        const R = this.rules[n], t = this.t[n], v = s[n];
        if (!t.on) {
          if (v >= R.enter) { if (t.over < 0) t.over = now; if (now - t.over >= R.dwellMs) { t.on = true; t.since = now; t.under = -1; if (n === 'wink') this.side = m.blinkL >= m.blinkR ? -1 : 1; if (n === 'smirk') this.side = m.smL >= m.smR ? -1 : 1; if (n === 'surprise') this.soft = m.surFar < R.enter; } }
          else t.over = -1;
        } else if (v < R.exit) {
          if (t.under < 0) t.under = now;
          // the laugh's latch: while he still smiles, its own score must have been away for laughLatchMs
          const under = n === 'laugh' && smiling ? Math.max(R.underMs || 120, LATCH.laughLatchMs) : (R.underMs || 120);
          if (now - t.since >= R.holdMs && now - t.under >= under) {
            t.on = false; t.over = -1;
            if (n === 'laugh') this.laughEndAt = now;
            if (n === 'surprise' && this.soft) this.jumpEndAt = now;
          }
        } else t.under = -1;
        if (n === 'surprise' && t.on && this.soft && m.surFar >= R.enter) this.soft = false;      // it grew into the full one
      }
      if (this.t.smile.on || this.t.grin.on || this.t.laugh.on) this.familyAt = now;
      return this._pick();
    }
    _pick() {
      let best = null;
      const now = this.now, rank = (n) => this.rules[n].rank;
      for (const n of NAMES) if (this.t[n].on && (!best || rank(n) > rank(best))) best = n;
      // after a laugh the only step down is to the smile (never the big grin)
      if (best === 'grin' && now - this.laughEndAt < LATCH.afterLaughMs) best = this.t.smile.on ? 'smile' : (this.cur === 'laugh' || this.cur === 'smile' ? this.cur : 'smile');
      const cur = this.cur;
      if (cur && best && best !== cur && rank(best) < rank(cur)) {
        // a step DOWN to another face: the one that has just gone is kept a moment (it often comes straight back), and
        // inside the smile family it must have been shown for a while
        if (this.lostAt < 0) this.lostAt = now;
        const family = FAMILY.includes(cur) && FAMILY.includes(best);
        if (now - this.lostAt < LATCH.stepDownMs || (family && now - this.curSince < LATCH.familyMinMs)) best = cur;
      } else this.lostAt = -1;
      // counts = how often the face CHANGED to that expression (what a viewer sees)
      if (best && best !== cur) this.counts[best]++;
      if (best !== cur) { this.curSince = now; this.lostAt = -1; }
      this.cur = best;
      return best;
    }
  }

  // ------------------------------------------------------------------ the authored faces
  // Parameter names are those of js/face-map.js (PARAMS). `set` = where the face goes; `eyes: 'live'` = his own blinks
  // still close these eyes; `mouth: 'talk'` = the mouth keeps talking inside the expression (its open amount is his,
  // never under `open`); `mouth: 'held'` = the mouth is the picture's. side-dependent ones (wink, smirk) are written for
  // the picture's LEFT and mirrored when it is the right.
  const COMMON = {
    smile: { set: { mouthCornerL: 1.05, mouthCornerR: 1.05, mouthWide: 0.5, eyeL_squint: 0.3, eyeR_squint: 0.3, blush: 0.4, browL_bend: 0.35, browR_bend: 0.35 }, eyes: 'live', mouth: 'talk', open: 0 },
    grin: { set: { mouthCornerL: 1.35, mouthCornerR: 1.35, mouthWide: 0.9, mouthTeeth: 1, mouthTongue: 0, mouthRound: 0, mouthPress: 0, eyeL_squint: 0.45, eyeR_squint: 0.45, eyeL_open: 1.05, eyeR_open: 1.05, blush: 0.55,
      browL_y: 0.35, browR_y: 0.35, browL_bend: 0.6, browR_bend: 0.6, browL_ang: 0.1, browR_ang: 0.1 }, eyes: 'live', mouth: 'talk', open: 0.34 },
    laugh: { set: { eyeL_happy: 1, eyeR_happy: 1, eyeL_squint: 0, eyeR_squint: 0, mouthCornerL: 1.4, mouthCornerR: 1.4, mouthWide: 0.85, mouthTeeth: 1, mouthTongue: 0.85, mouthRound: 0, mouthPress: 0, blush: 0.75,
      browL_y: 0.55, browR_y: 0.55, browL_bend: 0.85, browR_bend: 0.85, browL_ang: 0.3, browR_ang: 0.3 }, eyes: 'held', mouth: 'talk', open: 0.58 },
    surprise: { set: { browL_y: 1, browR_y: 1, browL_bend: 1, browR_bend: 1, browL_ang: 0.4, browR_ang: 0.4, eyeL_open: 1.4, eyeR_open: 1.4, eyeL_squint: 0, eyeR_squint: 0, pupil: 0.82, mouthCornerL: 0, mouthCornerR: 0 }, eyes: 'live', mouth: 'talk', open: 0.22, round: 0.55 },
    shocked: { set: { browL_y: 1, browR_y: 1, browL_bend: 1, browR_bend: 1, browL_ang: 0.55, browR_ang: 0.55, eyeL_open: 1.4, eyeR_open: 1.4, eyeL_squint: 0, eyeR_squint: 0, pupil: 0.7,
      mouthOpen: 0.9, mouthRound: 1, mouthWide: -0.45, mouthCornerL: 0, mouthCornerR: 0, mouthTeeth: 0, mouthTongue: 0.7, mouthPress: 0 }, eyes: 'live', mouth: 'held' },
    angry: { set: { browL_y: -0.95, browR_y: -0.95, browL_ang: -1, browR_ang: -1, browL_bend: 0, browR_bend: 0, eyeL_open: 0.82, eyeR_open: 0.82, eyeL_squint: 0.5, eyeR_squint: 0.5,
      mouthCornerL: -1, mouthCornerR: -1, mouthWide: 0.25, mouthTeeth: 0.7, blush: 0 }, eyes: 'live', mouth: 'talk', open: 0 },
    sad: { set: { browL_y: 0.25, browR_y: 0.25, browL_ang: 1, browR_ang: 1, browL_bend: -0.5, browR_bend: -0.5, eyeL_open: 0.78, eyeR_open: 0.78, eyeL_squint: 0.15, eyeR_squint: 0.15,
      mouthCornerL: -1.15, mouthCornerR: -1.15, mouthWide: -0.25, mouthTeeth: 0, pupil: 1.1 }, eyes: 'live', mouth: 'talk', open: 0 },
    smirk: { set: { mouthCornerL: 1.35, mouthCornerR: -0.1, mouthWide: 0.55, mouthX: -0.75, mouthPress: 0, browL_y: 0.6, browL_bend: 0.6, browL_ang: 0, browR_y: -0.4, browR_ang: -0.7, browR_bend: 0,
      eyeL_open: 1.02, eyeR_open: 0.86, eyeL_squint: 0.25, eyeR_squint: 0.3 }, eyes: 'live', mouth: 'talk', open: 0, sided: true },
    wink: { set: { eyeL_open: 0, eyeL_happy: 0, eyeL_squint: 1, eyeR_open: 1.08, eyeR_squint: 0.1, eyeR_happy: 0, mouthCornerL: 1.2, mouthCornerR: 0.6, mouthWide: 0.5, mouthX: -0.35, browL_y: -0.3, browL_ang: 0.2, browR_y: 0.45, browR_bend: 0.5, blush: 0.4 }, eyes: 'held', mouth: 'talk', open: 0, sided: true },
    squint: { set: { eyeL_open: 0.5, eyeR_open: 0.5, eyeL_squint: 0.95, eyeR_squint: 0.95, browL_y: -0.45, browL_ang: -0.45, browL_bend: 0, browR_y: 0.4, browR_ang: 0, browR_bend: 0.5,
      mouthCornerL: -0.35, mouthCornerR: -0.2, mouthWide: -0.3, mouthPress: 0.5, mouthX: 0.35 }, eyes: 'live', mouth: 'talk', open: 0 },
    tongue: { set: { mouthOpen: 0.55, mouthWide: 0.4, mouthCornerL: 0.9, mouthCornerR: 0.9, mouthTongue: 1, mouthTeeth: 0.4, mouthRound: 0, eyeL_happy: 1, eyeR_happy: 1, blush: 0.5 }, eyes: 'held', mouth: 'held' },
  };
  // per hero: where the approved pictures of the hero differ (Ryo's grin is his approved "happy" mouth; Melanie's brows
  // sit under her fringe and her eyes behind glasses, so her lids and mouth carry more)
  const OVER = {
    ryo: {
      grin: { set: { mouthCornerL: 1.0, mouthCornerR: 1.3 } },
      smirk: { set: { mouthCornerL: 1.3, mouthX: -0.8, mouthWide: 0.56 } },
      squint: { set: { eyeL_open: 0.55, eyeR_open: 0.55 } },
    },
    melanie: {
      smile: { set: { mouthCornerL: 1.3, mouthCornerR: 1.5, mouthWide: 0.85, eyeL_open: 1.12, eyeR_open: 1.12, blush: 0.55 } },
      grin: { set: { mouthCornerL: 1.5, mouthCornerR: 1.5, mouthWide: 1 }, open: 0.46 },
      smirk: { set: { mouthCornerL: 1.6, mouthWide: 0.8, mouthX: -0.9, eyeR_open: 0.7 } },
      angry: { set: { eyeL_open: 0.5, eyeR_open: 0.5, eyeL_squint: 0.2, eyeR_squint: 0.2, mouthCornerL: -1.2, mouthCornerR: -1.2, mouthWide: -0.2, mouthTeeth: 0 } },
      shocked: { set: { mouthOpen: 0.95, mouthRound: 0.6, mouthWide: 0.3, mouthTongue: 1 } },
      sad: { set: { eyeL_open: 0.72, eyeR_open: 0.72, mouthCornerL: -1.2, mouthCornerR: -1.2, mouthWide: -0.5, pupil: 1.2, blush: 0 } },
      squint: { set: { eyeL_open: 0.42, eyeR_open: 0.42, eyeL_squint: 0.6, eyeR_squint: 0.6, mouthX: 0.6, mouthWide: -0.1 } },
    },
  };
  // Fix round: a surprise that is only a brow JUMP (emphasis while he talks) is drawn milder: brows up, eyes a little
  // wider, no shrunken pupils, no rounded mouth. Brows far up = the full authored surprise.
  const SOFT_SURPRISE = { set: { browL_y: 0.8, browR_y: 0.8, browL_bend: 0.8, browR_bend: 0.8, browL_ang: 0.3, browR_ang: 0.3, eyeL_open: 1.18, eyeR_open: 1.18, eyeL_squint: 0, eyeR_squint: 0 }, eyes: 'live', mouth: 'talk', open: 0, round: 0 };
  const SWAP = (k) => (/L_/.test(k) ? k.replace('L_', 'R_') : /R_/.test(k) ? k.replace('R_', 'L_') : k === 'mouthCornerL' ? 'mouthCornerR' : k === 'mouthCornerR' ? 'mouthCornerL' : k);
  function build(hero) {
    const out = {};
    for (const n of NAMES) {
      const c = COMMON[n], o = (OVER[hero] || {})[n] || {};
      out[n] = Object.assign({}, c, o, { set: Object.assign({}, c.set, o.set || {}) });
      if (c.sided) { const mir = {}; for (const k in out[n].set) mir[SWAP(k)] = k === 'mouthX' ? -out[n].set[k] : out[n].set[k]; out[n].mirror = mir; }
    }
    return out;
  }
  const SNAP = { ryo: build('ryo'), melanie: build('melanie') };

  // ------------------------------------------------------------------ the mouth: camera + voice
  const MOUTH = Object.freeze({
    gateOn: [0.1, 0.38],      // how much lip movement the camera must see before the voice may move the mouth
    actFallMs: 420,           // the camera's "his lips are moving" falls away this slowly (it arrives late and in steps)
    voiceGain: 0.95, camKeep: 0.7,
    noMicGain: 1.3,           // no microphone at all: the camera's small openings are drawn larger
  });

  function create(hero) {
    const cls = new Classifier(), voice = new Voice.Mouth();
    const w = Object.fromEntries(NAMES.map((n) => [n, 0]));
    let snap = SNAP[hero] || SNAP.ryo, heroId = hero;
    let camAct = 0, camPrev = 0, camAt = -1e9, liveBlink = [0, 0], gate = 0, lastFace = null, cur = null;
    const dbg = { expr: null, gate: 0, voiceOpen: 0, camOpen: 0, open: 0 };
    return {
      classifier: cls, voice, weights: w,
      setHero(h) { if (h !== heroId) { heroId = h; snap = SNAP[h] || SNAP.ryo; } },
      mic(level, bands, now) { voice.update(level, Array.isArray(bands) ? bands : null, now); },
      push(face, now) {
        lastFace = face || null;
        const v = voice.read(now);
        cur = cls.push(face || null, v, now);
        if (face) {
          const lm = face.lm || {}, bs = face.bs || {};
          const raw = Math.max(num(lm.mouthOpen), 0.55 * num(bs.jawOpen));
          const a = clamp(Math.max(raw / 0.3, Math.abs(raw - camPrev) / 0.07), 0, 1);
          // what was there decays first, then the new evidence
          camAct = Math.max(a, camAct * Math.exp(-clamp(now - camAt, 0, 1000) / MOUTH.actFallMs));
          camPrev = raw; camAt = now;
          liveBlink = Array.isArray(face.blink) ? [clamp(num(face.blink[0]), 0, 1), clamp(num(face.blink[1]), 0, 1)] : [0, 0];
        }
      },
      /** aim: the parameters FaceAnimator is about to follow (changed in place). tracked: a face is being tracked now. */
      apply(aim, now, dt, tracked) {
        const v = voice.read(now), step = clamp(Number(dt) || 0, 0, 100);
        // ---- 1. the talking mouth
        const act = tracked ? camAct * Math.exp(-clamp(now - camAt, 0, 1000) / MOUTH.actFallMs) : 0;
        gate = tracked ? sstep(MOUTH.gateOn[0], MOUTH.gateOn[1], act) : 0;
        const camOpen = aim.mouthOpen;
        let talkOpen = camOpen;
        if (tracked) {
          if (v.on && v.talking && gate > 0) {
            const vo = MOUTH.voiceGain * v.open;
            talkOpen = lerp(camOpen, Math.max(MOUTH.camKeep * camOpen, vo), gate);
            aim.mouthWide = clamp(lerp(aim.mouthWide, 0.45 * aim.mouthWide + 0.9 * v.wide, 0.8 * gate), -1, 1);
            aim.mouthRound = clamp(Math.max(aim.mouthRound * (1 - 0.5 * gate * Math.max(0, v.wide)), v.round * gate), 0, 1);
            aim.mouthTeeth = clamp(Math.max(aim.mouthTeeth, 0.85 * v.sib * gate), 0, 1);
            aim.mouthTongue = clamp(Math.max(aim.mouthTongue, 0.8 * sstep(0.15, 0.45, talkOpen)) * (1 - v.sib), 0, 1);
            aim.mouthPress = aim.mouthPress * (1 - gate * sstep(0.05, 0.2, talkOpen));
          } else if (!v.on) talkOpen = clamp(MOUTH.noMicGain * camOpen, 0, 1);
          aim.mouthOpen = clamp(talkOpen, 0, 1);
        }
        // ---- 2. the expression that is on, laid over the live face
        const on = tracked ? cur : null;
        let any = false;
        for (const n of NAMES) {
          const goal = n === on ? 1 : 0;
          w[n] += (goal - w[n]) * (1 - Math.exp(-step / (goal > w[n] ? EASE.inMs : EASE.outMs)));
          if (w[n] < 0.004 && !goal) w[n] = 0;
          if (w[n] > 0) any = true;
        }
        if (any) {
          const liveOpen = aim.mouthOpen, liveRound = aim.mouthRound;
          // lowest rank first, so the winner is laid on last
          for (let i = NAMES.length - 1; i >= 0; i--) {
            const n = NAMES[i], k = w[n];
            if (!(k > 0)) continue;
            const S = n === 'surprise' && cls.soft ? SOFT_SURPRISE : snap[n], set = S.sided && cls.side > 0 ? S.mirror : S.set;
            for (const key in set) if (key in aim) aim[key] = lerp(aim[key], set[key], k);
            if (S.mouth === 'talk') {
              aim.mouthOpen = lerp(aim.mouthOpen, Math.max(S.open || 0, liveOpen), k);
              if (S.round) aim.mouthRound = lerp(aim.mouthRound, Math.max(liveRound, S.round * (1 - sstep(0.25, 0.5, liveOpen))), k);
            }
            if (S.eyes === 'live') { aim.eyeL_open *= 1 - k * sstep(0.45, 0.8, liveBlink[0]); aim.eyeR_open *= 1 - k * sstep(0.45, 0.8, liveBlink[1]); }
          }
        }
        dbg.expr = on; dbg.gate = gate; dbg.voiceOpen = v.on ? v.open : -1; dbg.camOpen = camOpen; dbg.open = aim.mouthOpen;
        return aim;
      },
      state() { return { soft: dbg.expr === 'surprise' && cls.soft, expr: dbg.expr, gate: dbg.gate, voiceOpen: dbg.voiceOpen, camOpen: dbg.camOpen, open: dbg.open, weights: w, counts: cls.counts, ms: cls.ms, scores: cls.s, voice: voice.out }; },
      reset() { cls.reset(); voice.reset(); for (const n of NAMES) w[n] = 0; camAct = 0; },
    };
  }

  return { create, Classifier, features, scores, RULES, NAMES, SNAP, COMMON, OVER, MOUTH, EASE, LATCH, SOFT_SURPRISE };
});
