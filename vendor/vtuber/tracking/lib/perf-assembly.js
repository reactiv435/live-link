// Tracker v2: builds the `perf` message (protocol v2, V2-PLAN.md) and the low-rate v1 `face` message.
// Pure UMD (no DOM): used by the hub worker and by the Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VTPerf = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const c01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  /**
   * One `perf` message for one face frame.
   *   seq, at (capture time of the face frame, epoch ms), fps (perf messages per second), sent (epoch ms now)
   *   face: what face-signal.js returned for this frame, or null
   *   bodyPart: the newest result of the body worker, { at, body, hands }, or null. It may be older than the face
   *             frame, so `body.at` and `hands.at` carry its own capture time. Older than `staleMs` = not seen = null.
   * Whatever body-signal.js puts on its `body` and `hands` objects goes out unchanged (for example `hands.overFace`,
   * also when both hands are null); only `at` is added and a missing side becomes null.
   */
  function assemble({ seq, at, fps, sent, face, bodyPart, staleMs = 600 }) {
    let body = null;
    let hands = { l: null, r: null };
    if (bodyPart && at - bodyPart.at <= staleMs) {
      const bAt = r1(bodyPart.at);
      if (bodyPart.body) body = { ...bodyPart.body, at: bAt };
      const h = bodyPart.hands;
      if (h && (h.l || h.r)) hands = { ...h, l: h.l || null, r: h.r || null, at: bAt };
      else if (h) hands = { ...h, l: null, r: null, at: bAt };
    }
    const msg = { t: 'perf', v: 2, seq, at: r1(at), fps: r1(fps), face: face || null, body, hands };
    if (sent !== undefined) msg.sent = r1(sent);
    return msg;
  }

  /**
   * The v1 `face` message, sent a few times a second so the control panel's lights keep working.
   * perfFace: the `face` part of a perf message (or null). why: 'obs' | 'password' | 'source' | 'frames' | 'face'.
   * Sides: perf "Left"/"Right" already mean the picture's left / right after the mirror, which is what v1 means too.
   */
  function v1Face(perfFace, at, why, fps) {
    if (!perfFace) {
      return { t: 'face', ok: false, yaw: 0, pitch: 0, roll: 0, blinkL: 0, blinkR: 0, jaw: 0, smile: 0, browUp: 0, browDown: 0, eyeWide: 0, mood: null, at: Math.round(at), why: why || 'face' };
    }
    const bs = perfFace.bs || {};
    const rot = perfFace.rot || [0, 0, 0];
    const b = (k) => c01(num(bs[k]));
    const msg = {
      t: 'face', ok: true, yaw: r1(num(rot[0])), pitch: r1(num(rot[1])), roll: r1(num(rot[2])),
      blinkL: r3(b('eyeBlinkLeft')), blinkR: r3(b('eyeBlinkRight')), jaw: r3(b('jawOpen')),
      smile: r3((b('mouthSmileLeft') + b('mouthSmileRight')) / 2),
      browUp: r3(Math.max(b('browInnerUp'), (b('browOuterUpLeft') + b('browOuterUpRight')) / 2)),
      browDown: r3((b('browDownLeft') + b('browDownRight')) / 2),
      eyeWide: r3((b('eyeWideLeft') + b('eyeWideRight')) / 2),
      mood: null, at: Math.round(at), v2: true,
    };
    // this status copy goes out only a few times a second; `fps` says how often the avatar really gets an update
    if (typeof fps === 'number' && Number.isFinite(fps)) msg.fps = r1(fps);
    return msg;
  }

  return { assemble, v1Face };
});
