// V9 CABLES, round 7: the numbers that put a modelled hand (Blender: tools/v9/blender_build_hand.py -> mask/v9/cables-hand.bin +
// cables-hand.json) on the 21 points a hand tracker gives. No drawing here (js/v9/fx-quantum-stream.js draws it); Node runs it
// in tests/v9-cables-hands.test.js.
//
//   const sk = VTHandSkin.create(meta)            meta = cables-hand.json: the 21 rest joints of a RIGHT hand, the bones
//   const tr = sk.tracker(side)                   side 1 = his right hand, -1 = his left (the mesh is mirrored for it)
//   tr.update(pts, z, dt)                         pts = 42 numbers (x, y per joint, frame units, y up), z = 21 depths
//                                                 (frame units, + = toward the viewer, the wrist's own = 0); null = lost
//   tr.mats                                       Float32Array(21 * 16): one matrix per bone, rest hand -> frame (x, y, depth)
//   tr.ok, tr.L, tr.S                             has it ever had a hand; the palm's length; its scale
//
// A bone's frame: its own direction (joint to joint, with the tracked DEPTH: a finger that points at the camera is
// short in the picture and long in depth), the palm's sideways line as the second axis (the thumb's bones: the palm's
// length line), so a finger bends about the axis fingers bend about. Along the bone the mesh is stretched to the
// tracked length; across it, it keeps the hand's own slenderness, a little thicker where it is nearer.
// Nothing here can blow up: a lost hand holds its last pose, numbers that are not numbers are ignored, a jump is
// taken at once (no smear across the frame), a dt of 0 moves nothing, every length is held inside sane limits.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTHandSkin = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const NB = 21, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a, fb) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fb.slice(); };
  /** the frame of a bone: Y along it, X = the reference line made square to it, Z = X x Y */
  function axes(y, ref, alt) {
    let x = sub(ref, [y[0] * dot(ref, y), y[1] * dot(ref, y), y[2] * dot(ref, y)]);
    if (len(x) < 0.12 * len(ref) || !(len(x) > 1e-9)) x = sub(alt, [y[0] * dot(alt, y), y[1] * dot(alt, y), y[2] * dot(alt, y)]);      // (the bone lies along the reference: take the other one)
    x = norm(x, [1, 0, 0]);
    return [x, y, cross(x, y)];
  }
  const pt = (J, i) => [J[i * 3], J[i * 3 + 1], J[i * 3 + 2]];
  /** the size of a hand: its palm, from the wrist to the knuckles and across them (with depth) */
  const palm = (J) => (len(sub(pt(J, 5), pt(J, 0))) + len(sub(pt(J, 9), pt(J, 0))) + len(sub(pt(J, 17), pt(J, 0))) + 1.6 * len(sub(pt(J, 5), pt(J, 17)))) / 4;

  function create(meta) {
    if (!meta || !meta.joints || meta.joints.length < 63 || !meta.bones || meta.bones.length < 20) throw new Error('hand-skin: cables-hand.json is not a hand');
    const bones = meta.bones.slice(0, 20).map((b) => [b[0], b[1]]);
    const fore = meta.forearm || [0, -1.15, 0];
    /** the rest hand of one side: joints, per bone its start, its axes and its length */
    function rest(side) {
      const J = new Float64Array(63);
      for (let i = 0; i < 21; i++) { J[i * 3] = meta.joints[i * 3] * side; J[i * 3 + 1] = meta.joints[i * 3 + 1]; J[i * 3 + 2] = meta.joints[i * 3 + 2]; }
      const R = frames(J, null, [fore[0] * side, fore[1], fore[2]]);
      return { J, size: palm(J), R };
    }
    /** per bone { a, X, Y, Z, len }. rest = null: these ARE the rest frames (the forearm's end is given) */
    function frames(J, restOf, foreEnd) {
      const s = sub(pt(J, 5), pt(J, 17)), py = sub(pt(J, 9), pt(J, 0)), out = [];
      for (let b = 0; b < 20; b++) {
        const a = pt(J, bones[b][0]), e = sub(pt(J, bones[b][1]), a), l = len(e), y = norm(e, restOf ? restOf.R[b].Y : [0, 1, 0]);
        const thumb = b < 4, ax = axes(y, thumb ? py : s, thumb ? s : py);
        out.push({ a, X: ax[0], Y: ax[1], Z: ax[2], len: l });
      }
      // the forearm: on from the wrist, away from the fingers (its depth held back: an arm rarely points at the camera)
      const a = pt(J, 0); let e, l;
      { const d = norm(py, [0, 1, 0]); e = [-d[0], -d[1], -d[2] * 0.45]; l = foreEnd ? len(sub(foreEnd, a)) : 0; }
      const y = norm(e, [0, -1, 0]), ax = axes(y, s, py);
      out.push({ a, X: ax[0], Y: ax[1], Z: ax[2], len: l });
      return out;
    }
    const RESTS = { 1: rest(1), '-1': rest(-1) };

    /** the 21 bone matrices (column-major 4 x 4, 16 numbers each) that carry the rest hand of `side` onto the joints J (63 numbers). false = J is not usable */
    function pose(J, side, out) {
      for (let i = 0; i < 63; i++) if (!Number.isFinite(J[i])) return false;
      const rs = RESTS[side >= 0 ? 1 : -1], L = palm(J);
      if (!(L > 1e-5) || !(L < 50)) return false;
      const S = L / rs.size, F = frames(J, rs, null), z0 = J[2];
      for (let b = 0; b < NB; b++) {
        const f = F[b], r = rs.R[b];
        // along the bone: the tracked length (inside limits); the forearm: the hand's own scale
        const ky = b === 20 ? S : clamp(f.len / r.len, 0.30 * S, 2.2 * S);
        // across it: the hand's scale, thicker where it is nearer the camera (the nearer part of a hand is the bigger part)
        const zm = b === 20 ? 0 : f.a[2] + f.Y[2] * f.len * 0.5 - z0, kx = S * (1 + clamp(zm / (4.2 * L), -0.25, 0.45));
        const o = b * 16;
        // M3 = [X kx | Y ky | Z kx] * Rrest^T
        for (let c = 0; c < 3; c++) {          // column c of M3 = sum over axes of live axis * (rest axis)[c]
          const rx = r.X[c], ry = r.Y[c], rz = r.Z[c];
          out[o + c * 4] = f.X[0] * kx * rx + f.Y[0] * ky * ry + f.Z[0] * kx * rz;
          out[o + c * 4 + 1] = f.X[1] * kx * rx + f.Y[1] * ky * ry + f.Z[1] * kx * rz;
          out[o + c * 4 + 2] = f.X[2] * kx * rx + f.Y[2] * ky * ry + f.Z[2] * kx * rz;
          out[o + c * 4 + 3] = 0;
        }
        const ar = r.a;
        out[o + 12] = f.a[0] - (out[o] * ar[0] + out[o + 4] * ar[1] + out[o + 8] * ar[2]);
        out[o + 13] = f.a[1] - (out[o + 1] * ar[0] + out[o + 5] * ar[1] + out[o + 9] * ar[2]);
        out[o + 14] = f.a[2] - (out[o + 2] * ar[0] + out[o + 6] * ar[1] + out[o + 10] * ar[2]);
        out[o + 15] = 1;
      }
      for (let i = 0; i < NB * 16; i++) if (!Number.isFinite(out[i])) return false;
      return { L, S };
    }

    /** one hand over time: eases the joints (depth more than place: the tracker's depth is the noisy part), holds through a loss */
    function tracker(side) {
      const sd = side >= 0 ? 1 : -1, J = new Float32Array(63), mats = new Float32Array(NB * 16), tmp = new Float32Array(NB * 16), T = new Float32Array(63);
      for (let b = 0; b < NB; b++) { mats[b * 16] = mats[b * 16 + 5] = mats[b * 16 + 10] = mats[b * 16 + 15] = 1; }
      const st = { side: sd, mats, J, ok: false, L: 0, S: 0, lost: 0 };
      st.update = (pts, z, dt) => {
        let good = !!pts && pts.length >= 42;
        if (good) for (let i = 0; i < 42; i++) if (!Number.isFinite(pts[i])) { good = false; break; }
        if (!good) { st.lost += Number.isFinite(dt) && dt > 0 ? dt : 0; return st; }          // lost: it holds its last pose
        const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
        for (let i = 0; i < 21; i++) { T[i * 3] = pts[i * 2]; T[i * 3 + 1] = pts[i * 2 + 1]; const zz = z && Number.isFinite(z[i]) ? z[i] : 0; T[i * 3 + 2] = zz - (z && Number.isFinite(z[0]) ? z[0] : 0); }
        // (depth is kept inside what a hand can be: a finger is never deeper than the hand is long)
        const Lp = Math.hypot(T[27] - T[0], T[28] - T[1]) + Math.hypot(T[15] - T[51], T[16] - T[52]);
        for (let i = 0; i < 21; i++) T[i * 3 + 2] = clamp(T[i * 3 + 2], -1.6 * Lp, 1.6 * Lp);
        const jump = !st.ok || Math.hypot(T[0] - J[0], T[1] - J[1]) > 0.6 * Math.max(Lp, 1e-4);
        if (jump) J.set(T);
        else if (d > 0) { const kp = 1 - Math.exp(-d / 0.022), kz = 1 - Math.exp(-d / 0.085); for (let i = 0; i < 21; i++) { J[i * 3] += (T[i * 3] - J[i * 3]) * kp; J[i * 3 + 1] += (T[i * 3 + 1] - J[i * 3 + 1]) * kp; J[i * 3 + 2] += (T[i * 3 + 2] - J[i * 3 + 2]) * kz; } }
        const r = pose(J, sd, tmp);
        if (r) { mats.set(tmp); st.ok = true; st.L = r.L; st.S = r.S; st.lost = 0; }
        return st;
      };
      return st;
    }
    /** where one point of the rest hand is now (tests; the page does this on the graphics card): p = [x, y, z] of the RIGHT rest hand */
    function skin(mats, side, p, b3, w3, out) {
      const x = p[0] * (side >= 0 ? 1 : -1), y = p[1], z = p[2]; let ox = 0, oy = 0, oz = 0;
      for (let k = 0; k < 3; k++) { const w = w3[k]; if (!(w > 0)) continue; const o = b3[k] * 16; ox += w * (mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12]); oy += w * (mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13]); oz += w * (mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14]); }
      out[0] = ox; out[1] = oy; out[2] = oz; return out;
    }
    return { pose, tracker, skin, rest: (side) => RESTS[side >= 0 ? 1 : -1], bones, NB };
  }
  /** cables-hand.bin as typed arrays: per point 6 floats + 8 bytes (bones 1-3, ao, weights 1-3, 0), then Uint16 indices */
  function parse(meta, buf) {
    const n = meta.points, f32 = new Float32Array(n * 6), u8 = new Uint8Array(n * 8), dv = new DataView(buf);
    for (let i = 0; i < n; i++) { for (let k = 0; k < 6; k++) f32[i * 6 + k] = dv.getFloat32(i * 32 + k * 4, true); for (let k = 0; k < 8; k++) u8[i * 8 + k] = dv.getUint8(i * 32 + 24 + k); }
    const idx = new Uint16Array(meta.indices); for (let i = 0; i < meta.indices; i++) idx[i] = dv.getUint16(n * 32 + i * 2, true);
    return { n, f32, u8, idx };
  }
  return { create, parse, NB };
})
;
