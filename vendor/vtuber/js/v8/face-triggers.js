// V8 ENGINE: his face as the boss's controller. Pure UMD, no DOM, no clock of its own (js/v8/README.md, section 1).
//
//   const trig = VTFaceTriggers.create({ bsNames });
//   const a = trig.step(tSeconds, { bs, mat, lm, mic });
//
// Six moves from what MediaPipe can really see on his face (measured on his footage, review/V8-ENGINE-NOTES.md):
//   eat        the jaw wide open and held                       (jawOpen)
//   dodge      a quick turn of the head away from where he sits (the face matrix)
//   shield     a pucker, held, the jaw shut                     (mouthPucker)
//   shockwave  the cheeks puffed: MediaPipe's cheekPuff score is dead (0.00 on all his clips) and the cheek points do not
//              move enough to tell (they wander +-5..10 % while he talks), so it is read from what the MOUTH does in a
//              puff: lips pressed shut and held, jaw closed, no smile, no pucker. See the notes: unproven on him.
//   lasers     both eyes squinted well below HIS resting lids, held, no smile, no blink (eyeSquint, against a slow average)
//   scream     a loud mic together with a wide jaw, held        (mic + jawOpen)
// Every move has a hold time (a syllable is not a move), a way out, and its own cooldown or stamina.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTFaceTriggers = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const DEG = 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // The numbers. Chosen on his recorded talking / laughing / show clips (tools/v8-sim-triggers.mjs prints the misfires).
  const DEFAULTS = {
    restTau: 6,                 // s: how slowly "where he normally sits" (head angle) follows him
    eat: { on: 0.58, off: 0.42, chargeFrom: 0.30, hold: 0.15, max: 1.6, rest: 0.7 },
    dodge: { on: 18, off: 8, speed: 60, window: 0.45, dur: 0.9 },
    shield: { on: 0.75, off: 0.50, hold: 0.45, jawMax: 0.22, drain: 2.5, refill: 5.0, minEnergy: 0.25 },
    puff: { press: 0.45, off: 0.25, jawMax: 0.08, smileMax: 0.25, puckerMax: 0.45, hold: 0.50, cooldown: 8 },
    laser: { rise: 0.25, off: 0.12, floor: 0.45, hold: 0.30, smileMax: 0.35, blinkMax: 0.55, jawMax: 0.30, tau: 8, heatUp: 3.0, coolDown: 4.0, restart: 0.35 },
    scream: { mic: 0.90, rise: 0.12, jaw: 0.45, hold: 0.30, cooldown: 30, micTau: 3 },
    gaze: { yaw: 25, pitch: 18 },   // degrees the eyes add to the aim at full look
  };

  const NAMES = ['jawOpen', 'mouthPucker', 'mouthFunnel', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPressLeft', 'mouthPressRight', 'eyeSquintLeft', 'eyeSquintRight',
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
    'browDownLeft', 'browDownRight', 'mouthRollLower', 'mouthRollUpper'];

  /** yaw (+ = he turns toward picture right) and pitch (+ = up) in degrees from MediaPipe's 4x4 face matrix (column-major) */
  function headAngles(mat) {
    if (!mat || mat.length < 11) return null;
    const yaw = Math.atan2(mat[8], mat[10]) * DEG, pitch = Math.asin(clamp(mat[9], -1, 1)) * DEG;
    return Number.isFinite(yaw) && Number.isFinite(pitch) ? { yaw, pitch } : null;
  }

  function merge(a, b) {
    const o = {};
    for (const k of Object.keys(a)) o[k] = a[k] && typeof a[k] === 'object' ? Object.assign({}, a[k], b && b[k]) : (b && b[k] != null ? b[k] : a[k]);
    return o;
  }

  function create({ bsNames = null, params = null } = {}) {
    const P = merge(DEFAULTS, params);
    let ix = null;
    const setNames = (names) => { ix = {}; for (const k of NAMES) ix[k] = names ? names.indexOf(k) : -1; };
    setNames(bsNames);
    let S;
    function reset() {
      S = {
        t: null, yaw0: null, pitch0: null, yawHist: [],
        eat: { on: false, hold: 0, t0: 0, rest: 0 },
        dodge: { on: false, dir: 0, t0: -99, armed: true },
        shield: { on: false, hold: 0, energy: 1, locked: false },
        puff: { hold: 0, last: -1e9, armed: true },
        laser: { on: false, hold: 0, heat: 0, over: false, bl: null, br: null, off: -99 },
        scream: { hold: 0, last: -1e9, armed: true, mic0: null },
        yaw: 0, pitch: 0, gaze: [0, 0],
      };
    }
    reset();

    /** the scores by name (0 when the name is unknown or there is no face) */
    function read(bs) {
      const o = {};
      for (const k of NAMES) { const i = ix[k]; o[k] = bs && i >= 0 && Number.isFinite(bs[i]) ? bs[i] : 0; }
      return o;
    }

    function step(t, input) {
      const inp = input || {};
      const dt = S.t == null ? 0 : clamp(t - S.t, 0, 0.25);
      S.t = t;
      const ev = [];
      const face = !!(inp.bs && inp.bs.length);
      const b = read(face ? inp.bs : null);
      const mic = Number.isFinite(inp.mic) ? clamp(inp.mic, 0, 1) : null;
      const smile = (b.mouthSmileLeft + b.mouthSmileRight) / 2, press = (b.mouthPressLeft + b.mouthPressRight) / 2;
      const blink = Math.max(b.eyeBlinkLeft, b.eyeBlinkRight);

      // ---------------------------------------------------------------- the head: against where he normally sits
      const ang = face ? headAngles(inp.mat) : null;
      if (ang) {
        if (S.yaw0 == null) { S.yaw0 = ang.yaw; S.pitch0 = ang.pitch; }
        const dev = ang.yaw - S.yaw0;
        // the resting pose follows him slowly, and four times slower while he is clearly turned away (a held turn is not the new rest)
        const k = 1 - Math.exp(-dt / (P.restTau * (Math.abs(dev) > P.dodge.off ? 4 : 1)));
        S.yaw0 += (ang.yaw - S.yaw0) * k; S.pitch0 += (ang.pitch - S.pitch0) * k;
        S.yaw = ang.yaw - S.yaw0; S.pitch = ang.pitch - S.pitch0;
        S.yawHist.push([t, ang.yaw]);
        while (S.yawHist.length && t - S.yawHist[0][0] > P.dodge.window) S.yawHist.shift();
      } else if (!face) S.yawHist.length = 0;
      if (face) {
        S.gaze = [clamp(((b.eyeLookOutLeft - b.eyeLookInLeft) + (b.eyeLookInRight - b.eyeLookOutRight)) / 2, -1, 1),
          clamp(((b.eyeLookUpLeft + b.eyeLookUpRight) - (b.eyeLookDownLeft + b.eyeLookDownRight)) / 2, -1, 1)];
      }
      /** a hold timer: fills with the time the condition is true, drains twice as fast (one dropped frame does not reset it) */
      const hold = (h, ok) => (ok ? h + dt : Math.max(0, h - 2 * dt));

      // ---------------------------------------------------------------- EAT: the jaw wide, held
      const E = S.eat, PE = P.eat;
      E.rest = Math.max(0, E.rest - dt);
      if (!E.on) {
        E.hold = hold(E.hold, face && b.jawOpen >= PE.on && E.rest <= 0);
        if (E.hold >= PE.hold) { E.on = true; E.t0 = t; E.hold = 0; ev.push({ type: 'eat-start', t }); }
      } else if (!face || b.jawOpen < PE.off || t - E.t0 >= PE.max) {
        E.on = false; E.rest = PE.rest; ev.push({ type: 'eat-end', t });
      }
      const eatCharge = E.on ? 1 : face && E.rest <= 0 ? clamp((b.jawOpen - PE.chargeFrom) / (PE.on - PE.chargeFrom), 0, 1) * (0.6 + 0.4 * clamp(E.hold / PE.hold, 0, 1)) : 0;

      // ---------------------------------------------------------------- DODGE: a quick turn away from his resting pose
      const D = S.dodge, PD = P.dodge;
      if (D.on && t - D.t0 >= PD.dur) D.on = false;
      if (ang) {
        const a = Math.abs(S.yaw);
        if (!D.armed && a < PD.off) D.armed = true;
        if (D.armed && !D.on && a >= PD.on) {
          // quick = the head came at least `speed` degrees a second over the last moments (a slow drift is not a dodge)
          const h0 = S.yawHist[0]; const span = t - h0[0];
          const sp = span > 0.05 ? Math.abs(ang.yaw - h0[1]) / span : 0;
          if (sp >= PD.speed) { D.on = true; D.armed = false; D.t0 = t; D.dir = S.yaw > 0 ? 1 : -1; ev.push({ type: 'dodge', t, dir: D.dir }); }
        }
      }

      // ---------------------------------------------------------------- SHIELD: a pucker, held; it runs on energy
      const H = S.shield, PH = P.shield;
      const puckered = face && b.mouthPucker >= (H.on ? PH.off : PH.on) && b.jawOpen <= PH.jawMax;
      if (!H.on) {
        H.energy = Math.min(1, H.energy + dt / PH.refill);
        if (H.locked && H.energy >= PH.minEnergy && !puckered) H.locked = false;      // after it ran empty: relax the mouth first
        H.hold = hold(H.hold, puckered && !H.locked && H.energy >= PH.minEnergy);
        if (H.hold >= PH.hold) { H.on = true; H.hold = 0; ev.push({ type: 'shield-on', t }); }
      } else {
        H.energy = Math.max(0, H.energy - dt / PH.drain);
        if (H.energy <= 0) { H.on = false; H.locked = true; ev.push({ type: 'shield-empty', t }); ev.push({ type: 'shield-off', t }); }
        else if (!puckered) { H.on = false; ev.push({ type: 'shield-off', t }); }
      }

      // ---------------------------------------------------------------- SHOCKWAVE: the puff (lips pressed shut and held)
      const U = S.puff, PU = P.puff;
      const puffing = face && press >= PU.press && b.jawOpen <= PU.jawMax && smile <= PU.smileMax && b.mouthPucker <= PU.puckerMax;
      const puffReady = t - U.last >= PU.cooldown;
      if (!U.armed && (!face || press < PU.off)) U.armed = true;
      U.hold = hold(U.hold, puffing && puffReady && U.armed);
      let shock = false;
      if (U.hold >= PU.hold) { shock = true; U.hold = 0; U.last = t; U.armed = false; ev.push({ type: 'shockwave', t }); }

      // ---------------------------------------------------------------- LASERS: a hard squint, against HIS resting lids
      const L = S.laser, PL = P.laser;
      if (face) {
        if (L.bl == null) { L.bl = b.eyeSquintLeft; L.br = b.eyeSquintRight; }
        // the resting lids are learned only from calm frames (no smile, no blink, not firing): a laugh does not move them
        if (!L.on && smile < PL.smileMax && blink < PL.blinkMax) { const k = 1 - Math.exp(-dt / PL.tau); L.bl += (Math.min(b.eyeSquintLeft, L.bl + 0.15) - L.bl) * k; L.br += (Math.min(b.eyeSquintRight, L.br + 0.15) - L.br) * k; }
      }
      const rise = face && L.bl != null ? Math.min(b.eyeSquintLeft - L.bl, b.eyeSquintRight - L.br) : 0;
      const calm = face && smile <= PL.smileMax && blink <= PL.blinkMax && b.jawOpen <= PL.jawMax;
      if (L.over && L.heat <= PL.restart) L.over = false;
      if (!L.on) {
        L.heat = Math.max(0, L.heat - dt / PL.coolDown);
        L.hold = hold(L.hold, calm && !L.over && rise >= PL.rise && Math.min(b.eyeSquintLeft, b.eyeSquintRight) >= PL.floor);
        if (L.hold >= PL.hold) { L.on = true; L.hold = 0; ev.push({ type: 'laser-on', t }); }
      } else {
        L.heat = Math.min(1, L.heat + dt / PL.heatUp);
        // staying on is easier than starting: a blink of a frame or two does not cut the beam
        L.hold = hold(L.hold, !(face && rise >= PL.off && smile <= PL.smileMax + 0.15));
        if (L.heat >= 1) { L.on = false; L.over = true; L.hold = 0; ev.push({ type: 'laser-overheat', t }); ev.push({ type: 'laser-off', t }); }
        else if (L.hold >= 0.12) { L.on = false; L.hold = 0; ev.push({ type: 'laser-off', t }); }
      }

      // ---------------------------------------------------------------- SCREAM: loud AND the jaw wide, held
      const C = S.scream, PC = P.scream;
      if (mic != null) { if (C.mic0 == null) C.mic0 = mic; C.mic0 += (mic - C.mic0) * (1 - Math.exp(-dt / PC.micTau)); }
      const loud = mic != null && mic >= PC.mic && mic - Math.min(C.mic0, 1 - PC.rise) >= PC.rise * (C.hold > 0 ? 0.25 : 1);
      const screamReady = t - C.last >= PC.cooldown;
      if (!C.armed && (!face || b.jawOpen < PC.jaw * 0.6)) C.armed = true;
      C.hold = hold(C.hold, face && loud && b.jawOpen >= PC.jaw && screamReady && C.armed);
      let scream = false;
      if (C.hold >= PC.hold) { scream = true; C.hold = 0; C.last = t; C.armed = false; ev.push({ type: 'scream', t }); }

      return {
        t, face,
        yaw: S.yaw, pitch: S.pitch, gaze: [S.gaze[0], S.gaze[1]],
        aim: [S.yaw + S.gaze[0] * P.gaze.yaw, S.pitch + S.gaze[1] * P.gaze.pitch],
        eat: { on: E.on, charge: eatCharge, left: E.on ? clamp(1 - (t - E.t0) / PE.max, 0, 1) : 0 },
        dodge: { on: D.on, dir: D.on ? D.dir : 0, left: D.on ? clamp(1 - (t - D.t0) / PD.dur, 0, 1) : 0 },
        shield: { on: H.on, energy: H.energy },
        shockwave: { fired: shock, ready: puffReady && !shock, cool: clamp(1 - (t - U.last) / PU.cooldown, 0, 1), charge: clamp(U.hold / PU.hold, 0, 1) },
        laser: { on: L.on, heat: L.heat, overheated: L.over },
        scream: { fired: scream, ready: screamReady && !scream, cool: clamp(1 - (t - C.last) / PC.cooldown, 0, 1), charge: clamp(C.hold / PC.hold, 0, 1) },
        events: ev,
      };
    }

    return { step, reset, read, setNames, params: P };
  }

  return { create, headAngles, DEFAULTS, NAMES };
});
