// V4 MASK: MediaPipe's face result -> the mask's geometry. Pure UMD (page, worker, Node); needs face-topology.js.
//
//   const core = VTMaskCore.create({ neutral });           // neutral: from VTMaskCore.calibrate(...) (or a saved one)
//   core.process(lm, bs, mat, { width, height }, tMs);     // lm: 478 * (x, y, z) as MediaPipe gives them (un-mirrored),
//                                                          // bs: the 52 scores in MediaPipe's order, mat: 16 or null
//   core.pos, core.nrm      Float32Array(nFine * 3): the smooth mask in HEAD space (units: the distance between his eye
//                           centres = 1; x picture right, y up, z toward the camera), expression BOOSTED
//   core.pose               { R: [9] row-major head -> camera (against `restR`, his usual head position, when given), x, y: head centre in the picture (-1..1, y up, in units
//                             of the picture HEIGHT / 2), size: head size against the picture height }
//   core.eyes               [{ c: [x, y, z], r, gaze: [x, y, z], open }, x2]  (index 0 = picture-left eye)
//   core.mouth              { ring: Float32Array(20 * 3), open }             the inner lip line, head space
//   core.act                Float32Array(nFine): how far each point is from his neutral right now (0..1), for looks
//                           that light up where the face works
//   core.mesh               static: { nFine, index: Uint32Array, rest: Float32Array (his neutral, smooth),
//                             mask: { lip, lipIn, lid, brow, rim, struct, feature }: Float32Array(nFine) each, 0..1 }
//
// What it does, in order:
//   1. Pose. The landmarks are put in picture pixels (x right, y up, z toward the camera) and fitted to his neutral face
//      on the points that do not take part in expressions (forehead, nose bridge, eye corners, temples): rotation,
//      size and place (Horn's closed form, so it does not need MediaPipe's own matrix).
//   2. Head space + smoothing. The fit is undone, so a turned head does not fake an expression. Every point is then
//      steadied with a One Euro filter (quick moves pass, the tremble of a still face does not): on a mirror-like
//      material a trembling point is a trembling reflection.
//   3. EXPRESSION BOOST. Each point's distance from his neutral is multiplied: brows x1.45, lips x1.4, jaw and cheeks
//      x1.3, lids x1.2, nose and outline x1.0 (smooth between), sideways and up/down only (depth is MediaPipe's
//      weakest number and stays x1). A soft limit keeps a wide laugh from tearing the mask.
//   4. Lids. A blink is taken from the blendshape scores (the lid points alone never quite close) and closes the
//      opening for real.
//   5. The mask gets a rim that curls back (so it is an object with an edge, not a floating sheet), eye and mouth
//      openings are cut, and everything is smoothed by two rounds of Loop subdivision (a fixed table: about 8,000
//      points from his 468).
(function (root, factory) {
  const topo = (typeof module === 'object' && module && module.exports) ? require('./face-topology.js') : root.VTMaskTopology;
  const api = factory(topo);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTMaskCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (TOPO) {
  'use strict';
  const NL = 478;
  // ---------------------------------------------------------------- landmark sets ('r' = the PERSON's right = picture left)
  const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  const LID_PAIRS_R = [[246, 7], [161, 163], [160, 144], [159, 145], [158, 153], [157, 154], [173, 155]];     // [upper, lower]
  const LID_PAIRS_L = [[466, 249], [388, 390], [387, 373], [386, 374], [385, 380], [384, 381], [398, 382]];
  const LIP_IN = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
  const LIP_OUT = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
  const BROW_R = [70, 63, 105, 66, 107, 46, 53, 52, 65, 55], BROW_L = [300, 293, 334, 296, 336, 276, 283, 282, 295, 285];
  const NOSE = [1, 2, 4, 5, 6, 19, 94, 168, 195, 197, 45, 275, 44, 274, 48, 278, 64, 294, 98, 327, 97, 326, 115, 344, 220, 440];
  const CHIN = [152, 175, 199, 200, 18, 148, 377, 176, 400, 171, 396, 208, 428, 201, 421, 32, 262];
  // the bones a key light finds: nose bridge, cheekbones, jaw line (the particle look packs points there)
  const STRUCT = [168, 6, 197, 195, 5, 4, 116, 117, 118, 123, 50, 345, 346, 347, 352, 280, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 58, 288, 132, 361];
  const CHEEK = [50, 280, 205, 425, 187, 411, 207, 427, 216, 436, 206, 426, 36, 266, 101, 330, 123, 352];
  // points that hold still when the face works: the fit uses these only
  const RIGID = [10, 109, 338, 67, 297, 151, 9, 8, 108, 337, 168, 6, 197, 195, 5, 4, 33, 133, 263, 362, 127, 356, 234, 454, 162, 389, 116, 345, 123, 352, 21, 251];
  const GAIN = { brow: 1.45, lip: 1.4, chin: 1.3, cheek: 1.3, lid: 1.2, nose: 1.0, base: 1.15 };

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  // ---------------------------------------------------------------- topology (built once)
  let MESH = null;
  function buildMesh() {
    if (MESH) return MESH;
    const hole = [new Set(EYE_R), new Set(EYE_L), new Set(LIP_IN)];
    let tris = [];
    for (let i = 0; i < TOPO.TRIS.length; i += 3) {
      const a = TOPO.TRIS[i], b = TOPO.TRIS[i + 1], c = TOPO.TRIS[i + 2];
      if (hole.some((h) => h.has(a) && h.has(b) && h.has(c))) continue;      // the skin over the eyes and between the lips
      tris.push([a, b, c]);
    }
    // the outer edge, in order
    const edgeUse = new Map();
    const ek = (a, b) => (a < b ? a * 4096 + b : b * 4096 + a);
    for (const t of tris) for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); edgeUse.set(key, (edgeUse.get(key) || 0) + 1); }
    const next = new Map();                                                    // directed boundary edges a -> b, as their triangle has them
    for (const t of tris) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; if (edgeUse.get(ek(a, b)) === 1) next.set(a, b); }
    const inHole = (v) => hole.some((h) => h.has(v));
    let start = 10;
    const loop = [];
    for (let v = start, guard = 0; guard < 200; guard++) { loop.push(v); v = next.get(v); if (v === start || v == null) break; }
    if (loop.some(inHole) || loop.length < 20) throw new Error('mask: the outline of the face mesh was not found');
    // the rim: two more rings behind the outline (their positions are made per frame in rim())
    const n = loop.length, ringB = NL, ringC = NL + n;
    for (let k = 0; k < n; k++) {
      const a = loop[k], b = loop[(k + 1) % n], a1 = ringB + k, b1 = ringB + (k + 1) % n, a2 = ringC + k, b2 = ringC + (k + 1) % n;
      tris.push([b, a, a1], [b, a1, b1], [b1, a1, a2], [b1, a2, b2]);
    }
    const nCoarse = NL + 2 * n;

    // Loop subdivision as a table: every fine point = a fixed weighted sum of coarse points
    let rows = new Array(nCoarse).fill(null);
    for (const t of tris) for (const v of t) if (!rows[v]) rows[v] = new Map([[v, 1]]);
    const addTo = (dst, src, w) => { for (const [k, v] of src) dst.set(k, (dst.get(k) || 0) + v * w); };
    function subdivide(rowsIn, trisIn) {
      const nV = rowsIn.length;
      const edges = new Map();                                                 // key -> { a, b, opp: [], id }
      const nbr = Array.from({ length: nV }, () => new Set());
      for (const t of trisIn) for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3], key = ek(a, b);
        let e = edges.get(key);
        if (!e) { e = { a, b, opp: [] }; edges.set(key, e); }
        e.opp.push(c); nbr[a].add(b); nbr[b].add(a);
      }
      const bnd = Array.from({ length: nV }, () => []);
      for (const e of edges.values()) if (e.opp.length === 1) { bnd[e.a].push(e.b); bnd[e.b].push(e.a); }
      const out = [];
      for (let v = 0; v < nV; v++) {
        if (!rowsIn[v]) { out.push(null); continue; }
        const r = new Map();
        if (bnd[v].length === 2) { addTo(r, rowsIn[v], 0.75); addTo(r, rowsIn[bnd[v][0]], 0.125); addTo(r, rowsIn[bnd[v][1]], 0.125); }
        else if (bnd[v].length > 2) addTo(r, rowsIn[v], 1);
        else {
          const k = nbr[v].size, beta = k === 3 ? 3 / 16 : 3 / (8 * k);
          addTo(r, rowsIn[v], 1 - k * beta);
          for (const u of nbr[v]) addTo(r, rowsIn[u], beta);
        }
        out.push(r);
      }
      for (const e of edges.values()) {
        const r = new Map();
        if (e.opp.length === 2) { addTo(r, rowsIn[e.a], 0.375); addTo(r, rowsIn[e.b], 0.375); addTo(r, rowsIn[e.opp[0]], 0.125); addTo(r, rowsIn[e.opp[1]], 0.125); }
        else { addTo(r, rowsIn[e.a], 0.5); addTo(r, rowsIn[e.b], 0.5); }
        e.id = out.length; out.push(r);
      }
      const trisOut = [];
      for (const t of trisIn) {
        const [a, b, c] = t, ab = edges.get(ek(a, b)).id, bc = edges.get(ek(b, c)).id, ca = edges.get(ek(c, a)).id;
        trisOut.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      }
      return [out, trisOut];
    }
    for (let level = 0; level < 2; level++) [rows, tris] = subdivide(rows, tris);
    // drop the unused slots (the iris points) and flatten to a CSR table
    const remap = new Int32Array(rows.length).fill(-1);
    let nFine = 0, nnz = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i]) { remap[i] = nFine++; nnz += rows[i].size; }
    const ptr = new Uint32Array(nFine + 1), col = new Uint16Array(nnz), wgt = new Float32Array(nnz);
    let p = 0, f = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i]) { ptr[f++] = p; for (const [k, v] of rows[i]) { col[p] = k; wgt[p++] = v; } }
    ptr[nFine] = p;
    const index = new Uint32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) for (let k = 0; k < 3; k++) index[i * 3 + k] = remap[tris[i][k]];

    // per-point masks, set on the coarse points and smoothed by the same table
    const set = (list, v = 1) => { const a = new Float32Array(nCoarse); for (const i of list) a[i] = v; return a; };
    const rimA = new Float32Array(nCoarse);
    for (let k = 0; k < n; k++) { rimA[loop[k]] = 0.15; rimA[ringB + k] = 0.6; rimA[ringC + k] = 1; }
    const coarseMask = { lip: set(LIP_IN.concat(LIP_OUT)), lipIn: set(LIP_IN), lid: set(EYE_R.concat(EYE_L)), brow: set(BROW_R.concat(BROW_L)), rim: rimA, struct: set(STRUCT) };
    // the expression gain per coarse point: seeds, then smoothed over the mesh so there is no crease between regions
    let gain = new Float32Array(nCoarse).fill(GAIN.base);
    const seed = (list, g) => { for (const i of list) gain[i] = g; };
    seed(CHEEK, GAIN.cheek); seed(CHIN, GAIN.chin); seed(NOSE, GAIN.nose); seed(EYE_R.concat(EYE_L), GAIN.lid);
    seed(LIP_IN.concat(LIP_OUT), GAIN.lip); seed(BROW_R.concat(BROW_L), GAIN.brow); seed(loop, 1.0);
    const cn = Array.from({ length: NL }, () => new Set());
    for (let i = 0; i < TOPO.TRIS.length; i += 3) for (let k = 0; k < 3; k++) { const a = TOPO.TRIS[i + k], b = TOPO.TRIS[i + (k + 1) % 3]; cn[a].add(b); cn[b].add(a); }
    for (let it = 0; it < 2; it++) {
      const g2 = gain.slice();
      for (let v = 0; v < NL; v++) if (cn[v].size) { let s = 0; for (const u of cn[v]) s += gain[u]; g2[v] = 0.5 * gain[v] + 0.5 * s / cn[v].size; }
      gain = g2;
    }
    // neighbours of every landmark, and how much of a point's move is evened out with them (none on lips and lids)
    const nbrs = cn.map((s) => Array.from(s)), even = new Float32Array(NL).fill(0.55);
    for (const i of LIP_IN.concat(LIP_OUT, EYE_R, EYE_L)) even[i] = 0;
    MESH = { nCoarse, nFine, index, ptr, col, wgt, loop, ringB, ringC, coarseMask, gain, nbrs, even, mask: {}, rest: null };
    for (const k in coarseMask) MESH.mask[k] = applyScalar(MESH, coarseMask[k]);
    return MESH;
  }
  function applyScalar(M, src) {
    const out = new Float32Array(M.nFine);
    for (let i = 0; i < M.nFine; i++) { let s = 0; for (let p = M.ptr[i]; p < M.ptr[i + 1]; p++) s += src[M.col[p]] * M.wgt[p]; out[i] = s; }
    return out;
  }
  function applyVec(M, src, out) {
    const { ptr, col, wgt } = M;
    for (let i = 0; i < M.nFine; i++) {
      let x = 0, y = 0, z = 0;
      for (let p = ptr[i]; p < ptr[i + 1]; p++) { const c = col[p] * 3, w = wgt[p]; x += src[c] * w; y += src[c + 1] * w; z += src[c + 2] * w; }
      out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
    }
  }
  function normals(M, pos, nrm) {
    nrm.fill(0);
    const ix = M.index;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz; nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz; nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
  }
  /** The rim: two rings behind the outline, curling back and in. coarse: Float32Array(nCoarse * 3), filled for 0..477. */
  function rim(M, coarse) {
    const n = M.loop.length;
    let cx = 0, cy = 0, cz = 0;
    for (const v of M.loop) { cx += coarse[v * 3]; cy += coarse[v * 3 + 1]; cz += coarse[v * 3 + 2]; }
    cx /= n; cy /= n; cz /= n;
    for (let k = 0; k < n; k++) {
      const v = M.loop[k] * 3, x = coarse[v], y = coarse[v + 1], z = coarse[v + 2];
      const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1;
      const b = (M.ringB + k) * 3, c = (M.ringC + k) * 3;
      coarse[b] = x + dx / l * 0.035; coarse[b + 1] = y + dy / l * 0.035; coarse[b + 2] = z - 0.13;
      coarse[c] = x - dx / l * 0.05; coarse[c + 1] = y - dy / l * 0.05; coarse[c + 2] = z - 0.30;
    }
  }

  // ---------------------------------------------------------------- pose fit (Horn 1987, unit quaternion by power iteration)
  /** P, Q: Float64Array(n * 3), both centred. Returns the rotation R (row-major 3x3) with P ~ s R Q, and s. q0: last quaternion. */
  function fit(P, Q, n, q0) {
    let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0, qq = 0;
    for (let i = 0; i < n; i++) {
      const qx = Q[i * 3], qy = Q[i * 3 + 1], qz = Q[i * 3 + 2], px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      Sxx += qx * px; Sxy += qx * py; Sxz += qx * pz; Syx += qy * px; Syy += qy * py; Syz += qy * pz; Szx += qz * px; Szy += qz * py; Szz += qz * pz;
      qq += qx * qx + qy * qy + qz * qz;
    }
    const N = [
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
    ];
    const shift = Math.abs(Sxx) + Math.abs(Syy) + Math.abs(Szz) + Math.abs(Sxy) + Math.abs(Sxz) + Math.abs(Syx) + Math.abs(Syz) + Math.abs(Szx) + Math.abs(Szy);
    let q = q0 ? q0.slice() : [1, 0, 0, 0];
    for (let it = 0; it < 60; it++) {
      const r = [0, 0, 0, 0];
      for (let a = 0; a < 4; a++) { for (let b = 0; b < 4; b++) r[a] += N[a][b] * q[b]; r[a] += shift * q[a]; }
      const l = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
      q = [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
    }
    const [w, x, y, z] = q;
    const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    let num = 0;
    for (let i = 0; i < n; i++) {
      const qx = Q[i * 3], qy = Q[i * 3 + 1], qz = Q[i * 3 + 2];
      num += P[i * 3] * (R[0] * qx + R[1] * qy + R[2] * qz) + P[i * 3 + 1] * (R[3] * qx + R[4] * qy + R[5] * qz) + P[i * 3 + 2] * (R[6] * qx + R[7] * qy + R[8] * qz);
    }
    return { R, s: num / (qq || 1), q };
  }
  /** picture landmarks -> pixels, x right, y up, z toward the camera */
  function toPixels(lm, W, H, out) {
    for (let i = 0; i < NL; i++) { out[i * 3] = (lm[i * 3] - 0.5) * W; out[i * 3 + 1] = (0.5 - lm[i * 3 + 1]) * H; out[i * 3 + 2] = -lm[i * 3 + 2] * W; }
    return out;
  }
  const eyeMid = (p, a, b) => [(p[a * 3] + p[b * 3]) / 2, (p[a * 3 + 1] + p[b * 3 + 1]) / 2, (p[a * 3 + 2] + p[b * 3 + 2]) / 2];

  class OneEuro {
    constructor(n, minCut, beta) { this.n = n; this.mc = minCut; this.beta = beta; this.x = null; this.dx = new Float32Array(n); this.t = 0; }
    reset() { this.x = null; this.dx.fill(0); }
    run(v, tMs, zScale) {
      if (!this.x) { this.x = Float32Array.from(v); this.t = tMs; return this.x; }
      let dt = (tMs - this.t) / 1000;
      if (!(dt > 0)) return this.x;
      if (dt > 0.2) dt = 0.2;
      this.t = tMs;
      const aD = 1 / (1 + 1 / (2 * Math.PI * 1.0 * dt)), x = this.x, dx = this.dx;
      for (let i = 0; i < this.n; i++) {
        const z = zScale && i % 3 === 2 ? zScale : 1;                        // depth: steadied harder
        dx[i] += aD * ((v[i] - x[i]) / dt - dx[i]);
        const fc = (this.mc + this.beta * Math.abs(dx[i])) * z;
        x[i] += (v[i] - x[i]) / (1 + 1 / (2 * Math.PI * fc * dt));
      }
      return x;
    }
  }

  // ---------------------------------------------------------------- his neutral face
  /**
   * frames: [{ lm, bs, mat }] (record-raw's `face` objects), names: MediaPipe's blendshape names, size: { width, height }.
   * Picks the calmest frames (mouth shut, no smile, brows at rest, eyes open, head near straight), turns each straight
   * with MediaPipe's own matrix, averages, then fits them all to that average once more and averages again.
   * Returns { v: 1, lm: [478 * 3] in head space (eye distance 1, centred on the middle of the eyes), frames, gaze: [[x, y], [x, y]] }.
   */
  function calibrate(frames, names, size) {
    const ix = (nm) => names.indexOf(nm);
    const keys = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'browDownLeft', 'browDownRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'mouthPucker', 'mouthFunnel', 'eyeSquintLeft', 'eyeSquintRight'].map(ix);
    const scored = [];
    for (const f of frames) {
      if (!f || !f.mat) continue;
      let s = 0;
      for (const k of keys) s += f.bs[k];
      const m = f.mat, yaw = Math.atan2(m[8], m[10]), pitch = Math.asin(clamp(-m[9], -1, 1));
      s += Math.abs(yaw) * 3 + Math.abs(pitch) * 2;
      scored.push([s, f]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const pick = scored.slice(0, Math.max(8, Math.round(scored.length * 0.06))).map((s) => s[1]);
    const P = new Float64Array(NL * 3), acc = new Float64Array(NL * 3);
    const local0 = [];
    for (const f of pick) {
      toPixels(f.lm, size.width, size.height, P);
      const m = f.mat, sc = Math.hypot(m[0], m[1], m[2]) || 1;
      const R = [m[0] / sc, m[4] / sc, m[8] / sc, m[1] / sc, m[5] / sc, m[9] / sc, m[2] / sc, m[6] / sc, m[10] / sc];   // row-major, model -> camera
      const er = eyeMid(P, 33, 133), el = eyeMid(P, 263, 362), c = [(er[0] + el[0]) / 2, (er[1] + el[1]) / 2, (er[2] + el[2]) / 2];
      const iod = Math.hypot(el[0] - er[0], el[1] - er[1], el[2] - er[2]);
      const L = new Float64Array(NL * 3);
      for (let i = 0; i < NL; i++) {
        const x = (P[i * 3] - c[0]) / iod, y = (P[i * 3 + 1] - c[1]) / iod, z = (P[i * 3 + 2] - c[2]) / iod;
        L[i * 3] = R[0] * x + R[3] * y + R[6] * z; L[i * 3 + 1] = R[1] * x + R[4] * y + R[7] * z; L[i * 3 + 2] = R[2] * x + R[5] * y + R[8] * z;   // R transposed
      }
      local0.push(L);
      for (let i = 0; i < NL * 3; i++) acc[i] += L[i] / pick.length;
    }
    // second round: fit every picked frame to the first average on the rigid points, average again
    let N = acc;
    for (let round = 0; round < 2; round++) {
      const acc2 = new Float64Array(NL * 3);
      for (const L of local0) { const A = alignTo(L, N); for (let i = 0; i < NL * 3; i++) acc2[i] += A[i] / local0.length; }
      N = acc2;
    }
    // straighten and centre: eyes level on the x axis, their middle at the origin, distance 1
    const er = eyeMid(N, 33, 133), el = eyeMid(N, 263, 362), c = [(er[0] + el[0]) / 2, (er[1] + el[1]) / 2, (er[2] + el[2]) / 2];
    const iod = Math.hypot(el[0] - er[0], el[1] - er[1], el[2] - er[2]);
    const out = new Array(NL * 3);
    for (let i = 0; i < NL; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round((N[i * 3 + k] - c[k]) / iod * 1e5) / 1e5;
    const gz = (iris, a, b) => { const m = eyeMid(out, a, b), w = Math.hypot(out[a * 3] - out[b * 3], out[a * 3 + 1] - out[b * 3 + 1]); return [(out[iris * 3] - m[0]) / w, (out[iris * 3 + 1] - m[1]) / w]; };
    return { v: 1, lm: out, frames: pick.length, gaze: [gz(468, 33, 133), gz(473, 263, 362)] };
  }
  /** L fitted onto N (both NL * 3) on the rigid points; returns the fitted copy of L. */
  function alignTo(L, N) {
    const n = RIGID.length, P = new Float64Array(n * 3), Q = new Float64Array(n * 3), cp = [0, 0, 0], cq = [0, 0, 0];
    for (const i of RIGID) for (let k = 0; k < 3; k++) { cp[k] += L[i * 3 + k] / n; cq[k] += N[i * 3 + k] / n; }
    RIGID.forEach((i, j) => { for (let k = 0; k < 3; k++) { P[j * 3 + k] = L[i * 3 + k] - cp[k]; Q[j * 3 + k] = N[i * 3 + k] - cq[k]; } });
    const { R, s } = fit(P, Q, n, null);
    const out = new Float64Array(NL * 3);
    for (let i = 0; i < NL; i++) {
      const x = (L[i * 3] - cp[0]) / s, y = (L[i * 3 + 1] - cp[1]) / s, z = (L[i * 3 + 2] - cp[2]) / s;
      out[i * 3] = R[0] * x + R[3] * y + R[6] * z + cq[0]; out[i * 3 + 1] = R[1] * x + R[4] * y + R[7] * z + cq[1]; out[i * 3 + 2] = R[2] * x + R[5] * y + R[8] * z + cq[2];
    }
    return out;
  }

  // ---------------------------------------------------------------- per frame
  function create({ neutral, boost = 1, bsNames = null, restR = null } = {}) {
    const M = buildMesh();
    const N = Float64Array.from(neutral.lm);
    const coarse = new Float32Array(M.nCoarse * 3);
    // the neutral mask, smooth: the "rest" coordinates the looks paint their patterns in
    for (let i = 0; i < NL * 3; i++) coarse[i] = N[i];
    rim(M, coarse);
    const rest = new Float32Array(M.nFine * 3), restN = new Float32Array(M.nFine * 3);
    applyVec(M, coarse, rest); normals(M, rest, restN);
    // triangles must face outward (toward the camera on the front of the face): flip the list once if they do not
    let front = 0;
    for (let i = 0; i < M.nFine; i++) front += restN[i * 3 + 2];
    if (front < 0 && !M.flipped) { for (let i = 0; i < M.index.length; i += 3) { const t = M.index[i + 1]; M.index[i + 1] = M.index[i + 2]; M.index[i + 2] = t; } M.flipped = true; normals(M, rest, restN); }
    M.rest = rest; M.restN = restN;
    // feature weight (where the particle look puts more points, where lines are drawn)
    const feat = new Float32Array(M.nFine);
    for (let i = 0; i < M.nFine; i++) feat[i] = clamp01(Math.max(M.mask.lip[i] * 1.2, M.mask.lid[i] * 1.5, M.mask.brow[i] * 0.75));
    M.mask.feature = feat;

    const nR = RIGID.length, Qr = new Float64Array(nR * 3), cq = [0, 0, 0];
    for (const i of RIGID) for (let k = 0; k < 3; k++) cq[k] += N[i * 3 + k] / nR;
    RIGID.forEach((i, j) => { for (let k = 0; k < 3; k++) Qr[j * 3 + k] = N[i * 3 + k] - cq[k]; });
    const Pr = new Float64Array(nR * 3), px = new Float64Array(NL * 3), local = new Float32Array(NL * 3);
    const filt = new OneEuro(NL * 3, 2.2, 5.0), poseF = new OneEuro(7, 1.6, 3.0);
    const names = bsNames || [];
    const bi = (nm) => names.indexOf(nm);
    let BL = -1, BR = -1;
    const actC = new Float32Array(M.nCoarse), dlt = new Float32Array(NL * 3);
    const neutralEye = (a, b) => { const m = eyeMid(N, a, b); return { c: [m[0], m[1], m[2] - 0.2], w: Math.hypot(N[a * 3] - N[b * 3], N[a * 3 + 1] - N[b * 3 + 1]) }; };
    const eyeN = [neutralEye(33, 133), neutralEye(263, 362)];
    const st = {
      mesh: M, pos: new Float32Array(M.nFine * 3), nrm: new Float32Array(M.nFine * 3), act: new Float32Array(M.nFine), coarse,
      pose: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], x: 0, y: 0, size: 0.3 },
      eyeLock: false,        // set by the page (mask-live.js setEyeLock): eyes on camera
      eyes: [{ c: eyeN[0].c, r: 0.27, gaze: [0, 0, 1], open: 1 }, { c: eyeN[1].c, r: 0.27, gaze: [0, 0, 1], open: 1 }],
      mouth: { ring: new Float32Array(LIP_IN.length * 3), open: 0 },
      found: false, q: null, boost,
      setNames(n) { names.length = 0; names.push(...n); BL = bi('eyeBlinkLeft'); BR = bi('eyeBlinkRight'); },
      reset() { filt.reset(); poseF.reset(); st.q = null; },
      process, rebuild,
    };
    if (names.length) st.setNames(names);

    function process(lm, bs, mat, size, tMs) {
      if (!lm || lm.length < NL * 3) { st.found = false; return false; }
      const W = size.width, H = size.height;
      toPixels(lm, W, H, px);
      const cp = [0, 0, 0];
      for (const i of RIGID) for (let k = 0; k < 3; k++) cp[k] += px[i * 3 + k] / nR;
      RIGID.forEach((i, j) => { for (let k = 0; k < 3; k++) Pr[j * 3 + k] = px[i * 3 + k] - cp[k]; });
      const { R, s, q } = fit(Pr, Qr, nR, st.q);
      st.q = q;
      // head space: R transposed, 1 / s
      for (let i = 0; i < NL; i++) {
        const x = (px[i * 3] - cp[0]) / s, y = (px[i * 3 + 1] - cp[1]) / s, z = (px[i * 3 + 2] - cp[2]) / s;
        local[i * 3] = R[0] * x + R[3] * y + R[6] * z + cq[0]; local[i * 3 + 1] = R[1] * x + R[4] * y + R[7] * z + cq[1]; local[i * 3 + 2] = R[2] * x + R[5] * y + R[8] * z + cq[2];
      }
      const L = filt.run(local, tMs, 0.6);
      // the pose, steadied: quaternion (sign kept), place and size
      const origin = [cp[0] - s * (R[0] * cq[0] + R[1] * cq[1] + R[2] * cq[2]), cp[1] - s * (R[3] * cq[0] + R[4] * cq[1] + R[5] * cq[2])];   // where head-space 0 lands
      const pf = poseF.run([q[0], q[1], q[2], q[3], origin[0] / (H / 2), origin[1] / (H / 2), s / H], tMs);
      const ql = Math.hypot(pf[0], pf[1], pf[2], pf[3]) || 1, w = pf[0] / ql, x = pf[1] / ql, y = pf[2] / ql, z = pf[3] / ql;
      const Ra = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
      st.pose.Rabs = Ra;
      if (restR) {                                                         // against his usual head position: R * restR^T
        const o = st.pose.R;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) o[a * 3 + b] = Ra[a * 3] * restR[b * 3] + Ra[a * 3 + 1] * restR[b * 3 + 1] + Ra[a * 3 + 2] * restR[b * 3 + 2];
      } else st.pose.R = Ra;
      st.pose.x = pf[4]; st.pose.y = pf[5]; st.pose.size = pf[6];

      // the boost: distance from neutral x gain (x and y), soft-limited; depth as measured
      const g = M.gain, k = st.boost;
      for (let i = 0; i < NL; i++) {
        const gi = 1 + (g[i] - 1) * k;
        let dx = (L[i * 3] - N[i * 3]) * gi, dy = (L[i * 3 + 1] - N[i * 3 + 1]) * gi;
        const dz = L[i * 3 + 2] - N[i * 3 + 2];
        const d = Math.hypot(dx, dy), lim = 0.42;
        if (d > lim * 0.6) { const over = d - lim * 0.6, soft = lim * 0.6 + (lim * 0.4) * (1 - Math.exp(-over / (lim * 0.4))); dx *= soft / d; dy *= soft / d; }
        dlt[i * 3] = dx; dlt[i * 3 + 1] = dy; dlt[i * 3 + 2] = dz;
      }
      // even the moves out over neighbours (not on lips and lids): a single point that jumps alone is noise, and on a
      // mirror it is a dent
      for (let i = 0; i < NL; i++) {
        const nb = M.nbrs[i], e = nb.length ? M.even[i] : 0;
        let dx = dlt[i * 3], dy = dlt[i * 3 + 1], dz = dlt[i * 3 + 2];
        if (e > 0) {
          let sx = 0, sy = 0, sz = 0;
          for (const u of nb) { sx += dlt[u * 3]; sy += dlt[u * 3 + 1]; sz += dlt[u * 3 + 2]; }
          dx += (sx / nb.length - dx) * e; dy += (sy / nb.length - dy) * e; dz += (sz / nb.length - dz) * e;
        }
        coarse[i * 3] = N[i * 3] + dx; coarse[i * 3 + 1] = N[i * 3 + 1] + dy; coarse[i * 3 + 2] = N[i * 3 + 2] + dz;
        const a = clamp01(Math.hypot(dx, dy, dz) / 0.16);
        actC[i] += (a - actC[i]) * (a > actC[i] ? 0.6 : 0.12);
      }
      // brow ridge: the mesh has no brow of its own; a low ridge makes his brow line (and its moves) read
      for (const i of BROW_R) coarse[i * 3 + 2] += 0.014;
      for (const i of BROW_L) coarse[i * 3 + 2] += 0.014;
      // lids: close for real on a blink (person's left = MediaPipe "Left" = picture right = eyes[1])
      const blink = [BR >= 0 ? bs[BR] : 0, BL >= 0 ? bs[BL] : 0];
      [LID_PAIRS_R, LID_PAIRS_L].forEach((pairs, e) => {
        const c = sstep(0.38, 0.72, blink[e]);
        let gap = 0;
        for (const [u, l] of pairs) {
          if (c > 0) for (let kk = 0; kk < 3; kk++) coarse[u * 3 + kk] += (coarse[l * 3 + kk] - coarse[u * 3 + kk]) * c * 0.94;
          gap += Math.hypot(coarse[u * 3] - coarse[l * 3], coarse[u * 3 + 1] - coarse[l * 3 + 1]);
        }
        st.eyes[e].open = clamp01(gap / pairs.length / 0.11);
      });
      // gaze from the iris points (head space, not boosted), against his neutral
      [[468, 33, 133], [473, 263, 362]].forEach(([iris, a, b], e) => {
        const m = eyeMid(L, a, b), gx = (L[iris * 3] - m[0]) / eyeN[e].w - neutral.gaze[e][0], gy = (L[iris * 3 + 1] - m[1]) / eyeN[e].w - neutral.gaze[e][1];
        let ex = clamp(gx * 2.6, -0.6, 0.6), ey = clamp(gy * 3.2, -0.45, 0.45);
        st.eyes[e].live = [ex, ey];                                         // where HE looks (kept for the numbers)
        // round 5, eyes on camera: the eyes point at the lens whatever he looks at; the head still turns, so in head
        // space the lens is the head's turn undone (R is head -> camera, row-major: its third row is the camera's z)
        if (st.eyeLock) { const R = st.pose.R, z = Math.max(0.25, R[8]); ex = clamp(R[6] / z, -0.6, 0.6); ey = clamp(R[7] / z, -0.45, 0.45); }
        const l = Math.hypot(ex, ey, 1);
        st.eyes[e].gaze = [ex / l, ey / l, 1 / l];
        const mb = eyeMid(coarse, a, b);
        st.eyes[e].c = [mb[0], mb[1] - 0.012, eyeN[e].c[2]];
      });
      rim(M, coarse);
      rebuild();
      LIP_IN.forEach((i, j) => { for (let kk = 0; kk < 3; kk++) st.mouth.ring[j * 3 + kk] = coarse[i * 3 + kk]; });
      st.mouth.open = clamp01((coarse[13 * 3 + 1] - coarse[14 * 3 + 1]) / 0.32);
      st.found = true;
      return true;
    }
    function rebuild() {
      applyVec(M, coarse, st.pos); normals(M, st.pos, st.nrm);
      const a = st.act, { ptr, col, wgt } = M;
      for (let i = 0; i < M.nFine; i++) { let s = 0; for (let p = ptr[i]; p < ptr[i + 1]; p++) { const c = col[p]; if (c < NL) s += actC[c] * wgt[p]; } a[i] = s; }
    }
    // start at neutral
    for (let i = 0; i < NL * 3; i++) coarse[i] = N[i];
    rim(M, coarse); rebuild();
    LIP_IN.forEach((i, j) => { for (let kk = 0; kk < 3; kk++) st.mouth.ring[j * 3 + kk] = coarse[i * 3 + kk]; });
    return st;
  }
  return { create, calibrate, buildMesh, GAIN, LIP_IN, EYE_R, EYE_L, NL };
});
