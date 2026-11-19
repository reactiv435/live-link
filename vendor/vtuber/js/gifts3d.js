// ROUND 5: gift missiles for Ryo and Melanie, DRAWN (Babylon). The logic is js/gift-fx.js (VTGiftFx).
//
//   const gifts = VTGifts3D.create(scene, { sounds: true });
//   gifts.attach(hero)                      once per hero, after it is loaded (measures the head)
//   gifts.fire(ev, heroId, tMs)             a viewer event ({ t: 'mask-event' }.e) -> 'now' | 'queued' | 'merged' | false
//   const re = gifts.begin(heroId, tMs)     first thing in a frame: what the character does about it (re = fx react)
//   gifts.face(P, heroId)                   the face parameters with the flinch / the shocked face laid on (a reused object)
//   gifts.draw(hero, faceCentre)            last thing before scene.render(): the missiles, trails, bursts
//   gifts.warm(hero)                        builds and draws everything once, unseen, so the first gift of a show costs
//                                           what the tenth does (the Mask does the same: V4 notes 8c)
//
// Three draw calls while a gift is in the air, none otherwise: the missiles (instances of one small rocket, real 3D:
// the head hides them when they pass behind it), their trails (flat quads, depth-tested), and the bursts on the face
// (flat quads, always on top). Colours: crimson, gold, chrome.
(function (global) {
  'use strict';
  const QUADS_DEPTH = 300, QUADS_TOP = 420, TRAIL = 9, TRAIL_DT = 0.017;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const VS = 'precision highp float; attribute vec3 position; attribute vec2 uv; attribute vec2 uv2; attribute vec4 color; uniform mat4 viewProjection; varying vec2 vUv; varying vec2 vK; varying vec4 vC;' +
    'void main(){ vUv = uv; vK = uv2; vC = color; gl_Position = viewProjection * vec4(position, 1.0); }';
  // kind (vK.x): 0 a soft glow, 1 a ring (vK.y = its width), 2 a streak (bright at its head, +x), 3 a four-point sparkle
  const FS = 'precision highp float; varying vec2 vUv; varying vec2 vK; varying vec4 vC;' +
    'void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p); float i;' +
    ' if (vK.x < 0.5) i = exp(-r * r * 4.2) * smoothstep(1.0, 0.7, r);' +
    ' else if (vK.x < 1.5) { float d = (r - 0.78) / max(vK.y, 0.01); i = exp(-d * d) * smoothstep(1.0, 0.92, r); }' +
    ' else if (vK.x < 2.5) i = exp(-p.y * p.y * 6.0) * smoothstep(-1.0, 0.75, p.x) * smoothstep(1.0, 0.8, p.x);' +
    ' else { float s = max(exp(-abs(p.x) * 11.0) * smoothstep(1.0, 0.1, abs(p.y)), exp(-abs(p.y) * 11.0) * smoothstep(1.0, 0.1, abs(p.x))); i = (exp(-r * r * 9.0) + 0.9 * s) * smoothstep(1.0, 0.85, r); }' +
    ' float v = i * vC.a; float a = clamp(v, 0.0, 1.0); vec3 col = mix(vC.rgb, vec3(1.0, 0.97, 0.93), clamp((v - 0.72) * 1.6, 0.0, 0.9));' +
    ' gl_FragColor = vec4(col * a, a); }';

  function create(scene, opts) {
    const B = global.BABYLON, Fx = global.VTGiftFx;
    if (!B || !Fx) throw new Error('gifts3d: needs Babylon and VTGiftFx');
    const O = Object.assign({ sounds: true }, opts || {});
    const per = {};                 // per hero: { fx, hh, geo }
    let rows = null, cur = null, sample = null, tNow = 0, actx = null, sfxOut = null, cueT = 0, soundsOn = O.sounds !== false;
    const stats = { warm: false, drawMs: 0, maxDrawMs: 0, quads: 0, maxQuads: 0, fired: 0, frames: 0 };

    // ---- the quads (two meshes: depth-tested trails, bursts on top)
    function quadMesh(name, n, top) {
      const pos = new Float32Array(n * 12), col = new Float32Array(n * 16), uv = new Float32Array(n * 8), k = new Float32Array(n * 8), idx = new Uint16Array(n * 6);
      for (let i = 0; i < n; i++) {
        uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
        idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      }
      const mesh = new B.Mesh(name, scene);
      mesh.setVerticesData(B.VertexBuffer.PositionKind, pos, true, 3);
      mesh.setVerticesData(B.VertexBuffer.UVKind, uv, false, 2);
      mesh.setVerticesData(B.VertexBuffer.UV2Kind, k, true, 2);
      mesh.setVerticesData(B.VertexBuffer.ColorKind, col, true, 4);
      mesh.setIndices(idx);
      const mat = new B.ShaderMaterial(name + '-mat', scene, { vertexSource: VS, fragmentSource: FS }, { attributes: ['position', 'uv', 'uv2', 'color'], uniforms: ['viewProjection'], needAlphaBlending: true });
      mat.alphaMode = B.Engine.ALPHA_PREMULTIPLIED; mat.backFaceCulling = false; mat.disableDepthWrite = true;
      if (top) mat.depthFunction = B.Engine.ALWAYS;
      mesh.material = mat; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true; mesh.doNotSyncBoundingInfo = true; mesh.hasVertexAlpha = true;
      mesh.renderingGroupId = 0; mesh.alphaIndex = top ? 20 : 10;
      mesh.setEnabled(false);
      return { mesh, pos, col, k, n, used: 0, prev: 0 };
    }
    const QD = quadMesh('gift-trails', QUADS_DEPTH, false), QT = quadMesh('gift-bursts', QUADS_TOP, true);
    /** one quad: centre, half-extent vectors a (its length, in the picture plane) and b (across), colour, strength, kind, parameter */
    function quad(Q, cx, cy, cz, ax, ay, bx, by, r, g, b, a, kind, par) {
      if (Q.used >= Q.n) return;
      const o = Q.used * 12, c = Q.used * 16, u = Q.used * 8, P = Q.pos, C = Q.col, K = Q.k;
      P[o] = cx - ax - bx; P[o + 1] = cy - ay - by; P[o + 2] = cz;
      P[o + 3] = cx + ax - bx; P[o + 4] = cy + ay - by; P[o + 5] = cz;
      P[o + 6] = cx + ax + bx; P[o + 7] = cy + ay + by; P[o + 8] = cz;
      P[o + 9] = cx - ax + bx; P[o + 10] = cy - ay + by; P[o + 11] = cz;
      for (let i = 0; i < 4; i++) { C[c + i * 4] = r; C[c + i * 4 + 1] = g; C[c + i * 4 + 2] = b; C[c + i * 4 + 3] = a; K[u + i * 2] = kind; K[u + i * 2 + 1] = par; }
      Q.used++;
    }
    function flush(Q) {
      // quads used last frame and not this one fold to nothing
      for (let i = Q.used; i < Q.prev; i++) Q.pos.fill(0, i * 12, i * 12 + 12);
      if (Q.used || Q.prev) {
        Q.mesh.updateVerticesData(B.VertexBuffer.PositionKind, Q.pos, false, false);
        Q.mesh.updateVerticesData(B.VertexBuffer.ColorKind, Q.col, false, false);
        Q.mesh.updateVerticesData(B.VertexBuffer.UV2Kind, Q.k, false, false);
      }
      Q.mesh.setEnabled(Q.used > 0);
      Q.prev = Q.used;
    }

    // ---- the rocket (one mesh, instances): chrome body, crimson nose and fins, a gold band. Its axis is +y.
    function rocket() {
      const part = (m, c) => { const n = m.getTotalVertices(), col = new Float32Array(n * 4); for (let i = 0; i < n; i++) col.set([c[0], c[1], c[2], 1], i * 4); m.setVerticesData(B.VertexBuffer.ColorKind, col); return m; };
      const body = part(B.MeshBuilder.CreateCylinder('r-b', { height: 1.0, diameter: 0.34, tessellation: 10 }, scene), [0.92, 0.92, 0.95]);
      const band = part(B.MeshBuilder.CreateCylinder('r-g', { height: 0.14, diameter: 0.37, tessellation: 10 }, scene), [1.0, 0.70, 0.20]); band.position.y = 0.22;
      const nose = part(B.MeshBuilder.CreateCylinder('r-n', { height: 0.5, diameterTop: 0, diameterBottom: 0.34, tessellation: 10 }, scene), [0.86, 0.10, 0.16]); nose.position.y = 0.75;
      const parts = [body, band, nose];
      for (let i = 0; i < 3; i++) {
        const fin = part(B.MeshBuilder.CreateBox('r-f', { width: 0.36, height: 0.42, depth: 0.05 }, scene), [0.86, 0.10, 0.16]);
        fin.rotation.y = i * 2 * Math.PI / 3; fin.position.set(0.2 * Math.cos(-fin.rotation.y), -0.38, 0.2 * Math.sin(-fin.rotation.y)); parts.push(fin);
      }
      const mesh = B.Mesh.MergeMeshes(parts, true, true);
      mesh.name = 'gift-rocket';
      const mat = new B.StandardMaterial('gift-rocket-mat', scene);
      mat.diffuseColor = new B.Color3(1, 1, 1); mat.emissiveColor = new B.Color3(0.5, 0.5, 0.5); mat.specularColor = new B.Color3(0.5, 0.5, 0.5); mat.specularPower = 24;
      mesh.material = mat; mesh.useVertexColors = true; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true; mesh.setEnabled(false);
      return mesh;
    }
    const rk = rocket(), rockets = [];
    for (let i = 0; i < Fx.MAX_AIR; i++) { const m = rk.createInstance('gift-rocket-' + i); m.rotationQuaternion = new B.Quaternion(); m.isPickable = false; m.alwaysSelectAsActiveMesh = true; m.setEnabled(false); rockets.push(m); }
    let rocketsOn = 0;

    // ---- per hero
    function attach(hero) {
      const an = hero.anchor, hh = an.crown - an.chin, headNode = hero.nodes[hero.nodes.length - 1];
      let faceZ = 0.42;
      try {
        const j = hero.skeleton.bones.findIndex((b) => b.name === 'Head'), hz = headNode.getAbsolutePosition().z, p = new B.Vector3();
        let zmax = -1e9;
        for (const mesh of hero.meshes) {
          const mi = mesh.getVerticesData(B.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData(B.VertexBuffer.MatricesWeightsKind);
          let pos = null; try { pos = mesh.getPositionData(true, false); } catch (e) { pos = null; }
          if (!pos || !mi || !mw) continue;
          const world = mesh.computeWorldMatrix(true);
          for (let v = 0; v < pos.length / 3; v++) {
            let w = 0; for (let k = 0; k < 4; k++) if (mi[v * 4 + k] === j) w += mw[v * 4 + k];
            if (w < 0.6) continue;
            B.Vector3.TransformCoordinatesFromFloatsToRef(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], world, p);
            if (Math.abs(p.x - an.x) < 0.14 * hh && Math.abs(p.y - an.eye) < 0.16 * hh && p.z > zmax) zmax = p.z;
          }
        }
        if (zmax > -1e8) faceZ = clamp((zmax - hz) / hh, 0.2, 0.7);
      } catch (e) { /* the default */ }
      const geo = { crown: (an.crown - an.eye) / hh, chin: (an.chin - an.eye) / hh, halfW: clamp((hero.box.x1 - hero.box.x0) / 2 / hh, 0.35, 0.7), faceZ: faceZ + 0.03, top: 0.93, bottom: -1.55 };
      per[hero.id] = { hh, geo, fx: Fx.create({ map: rows || undefined, geo, seed: hero.id === 'ryo' ? 20261119 : 20261120 }) };
      return per[hero.id];
    }
    /** his gift list, read at ON and every 20 s. The same list again changes nothing; a new one is swapped in place (a gift in the air flies on). */
    let rowsKey = '';
    function setMap(r) {
      const next = Array.isArray(r) && r.length ? r : null;
      let key = ''; try { key = next ? JSON.stringify(next) : ''; } catch (e) { key = String(Math.random()); }
      if (key === rowsKey) return false;
      rowsKey = key; rows = next; stats.maps = (stats.maps || 0) + 1;
      for (const id in per) per[id].fx.setMap(rows);
      return true;
    }
    function fire(ev, heroId, tMs) {
      const h = per[heroId];
      if (!h || !ev) return false;
      const res = h.fx.fire(ev, tMs / 1000);
      if (res) stats.fired++;
      return res;
    }
    const IDLE = { flinch: 0, shock: 0, brace: 0, knock: 0, shakeX: 0, shakeY: 0, squash: 0, lookX: 0, lookY: 0, look: 0 };
    function begin(heroId, tMs) {
      cur = per[heroId] || null; tNow = tMs / 1000;
      sample = cur ? cur.fx.sample(tNow) : null;
      if (sample && soundsOn && !O.noAudio) sounds(tNow);
      return sample ? sample.react : IDLE;
    }

    // ---- the face: a flinch (eyes squeezed, a grimace), the shocked face, a worried brace; then his own again
    let scratch = null;
    function face(P, heroId, follow) {
      const re = sample ? sample.react : IDLE, lk = follow ? re.look : 0;
      if (!(re.flinch > 0.004 || re.shock > 0.004 || re.brace > 0.02 || lk > 0.02)) return P;
      const out = scratch || (scratch = {});
      for (const k in P) out[k] = P[k];
      // eyes on camera switched off: the eyes follow the missile that will land next
      if (lk > 0) { out.gazeX = lerp(out.gazeX, re.lookX, 0.8 * lk); out.gazeY = lerp(out.gazeY, re.lookY, 0.8 * lk); }
      const b = re.brace * 0.6;
      if (b > 0) { out.browL_ang = lerp(out.browL_ang, 0.7, b); out.browR_ang = lerp(out.browR_ang, 0.7, b); out.browL_y = lerp(out.browL_y, 0.45, b); out.browR_y = lerp(out.browR_y, 0.45, b); out.eyeL_open = lerp(out.eyeL_open, Math.max(out.eyeL_open, 1.15), b); out.eyeR_open = lerp(out.eyeR_open, Math.max(out.eyeR_open, 1.15), b); }
      const s = re.shock;
      if (s > 0) {
        const X = global.VTExpr, set = X && X.SNAP && X.SNAP[heroId] ? X.SNAP[heroId].shocked.set : null;
        if (set) for (const k in set) if (k in out) out[k] = lerp(out[k], set[k], s);
        out.eyeL_happy = lerp(out.eyeL_happy, 0, s); out.eyeR_happy = lerp(out.eyeR_happy, 0, s); out.blush = lerp(out.blush, 0, s);
      }
      const f = re.flinch;
      if (f > 0) {
        out.eyeL_open = lerp(out.eyeL_open, 0, f); out.eyeR_open = lerp(out.eyeR_open, 0, f); out.eyeL_squint = lerp(out.eyeL_squint, 1, f); out.eyeR_squint = lerp(out.eyeR_squint, 1, f);
        out.eyeL_happy = lerp(out.eyeL_happy, 0, f); out.eyeR_happy = lerp(out.eyeR_happy, 0, f);
        out.browL_y = lerp(out.browL_y, -0.7, f); out.browR_y = lerp(out.browR_y, -0.7, f); out.browL_ang = lerp(out.browL_ang, 0.5, f); out.browR_ang = lerp(out.browR_ang, 0.5, f);
        out.mouthCornerL = lerp(out.mouthCornerL, -0.7, f); out.mouthCornerR = lerp(out.mouthCornerR, -0.7, f); out.mouthWide = lerp(out.mouthWide, 0.6, f);
        out.mouthOpen = lerp(out.mouthOpen, Math.max(out.mouthOpen, 0.22), f); out.mouthTeeth = lerp(out.mouthTeeth, 1, f); out.mouthRound = lerp(out.mouthRound, 0, f); out.mouthPress = lerp(out.mouthPress, 0, f);
      }
      return out;
    }

    // ---- drawing
    const tr = new Float32Array(3), qv = new B.Quaternion();
    const h3 = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
    function draw(hero, c) {
      const t0 = global.performance ? performance.now() : 0;
      const S = sample, h = cur;
      QD.used = 0; QT.used = 0;
      let nR = 0;
      if (S && h && (S.nM || S.nB || S.nR || S.nS)) {
        const hh = h.hh, ox = c.x, oy = c.y, oz = c.z, t = tNow;
        // world = centre + (-x, y, z) * hh  (the camera looks down -z: world +x is the picture's left)
        for (let i = 0; i < S.nM; i++) {
          const px = ox - S.mPos[i * 3] * hh, py = oy + S.mPos[i * 3 + 1] * hh, pz = oz + S.mPos[i * 3 + 2] * hh, sz = S.mSize[i];
          const dx = -S.mDir[i * 3], dy = S.mDir[i * 3 + 1], dz = S.mDir[i * 3 + 2];
          const m = rockets[nR++];
          m.position.set(px, py, pz);
          // +y of the rocket onto its direction
          const w = 1 + dy;
          if (w < 1e-4) qv.set(1, 0, 0, 0); else { qv.set(dz, 0, -dx, w); qv.normalize(); }
          m.rotationQuaternion.copyFrom(qv);
          const sc = 0.105 * hh * sz; m.scaling.set(sc, sc, sc);
          if (!m.isEnabled()) m.setEnabled(true);
          const cr = S.mCol[i * 3], cg = S.mCol[i * 3 + 1], cb = S.mCol[i * 3 + 2];
          // the engine's flame at the tail, then the trail back along the path (each a streak along the way it went)
          let lx = px - dx * sc * 0.6, ly = py - dy * sc * 0.6, lz = pz - dz * sc * 0.6;
          quad(QD, lx, ly, lz, 0.075 * hh * sz, 0, 0, 0.075 * hh * sz, 1, 0.85, 0.6, 1.5, 0, 0);
          for (let k = 1; k <= TRAIL; k++) {
            h.fx.missilePos(i, t - k * TRAIL_DT - 0.012, tr, 0);
            const qx = ox - tr[0] * hh, qy = oy + tr[1] * hh, qz = oz + tr[2] * hh;
            let ax = (lx - qx) * 0.5, ay = (ly - qy) * 0.5;
            const al = Math.hypot(ax, ay) || 1e-6, f = 1 - k / (TRAIL + 1), wd = 0.034 * hh * sz * (0.45 + 0.55 * f);
            const ex = ax + ax / al * wd, ey = ay + ay / al * wd;
            quad(QD, (lx + qx) / 2, (ly + qy) / 2, (lz + qz) / 2, ex, ey, -ay / al * wd, ax / al * wd, lerp(1.0, cr, 0.35 + 0.65 * (1 - f)), lerp(0.2, cg, f), lerp(0.1, cb, f), 1.25 * f * f + 0.1, 2, 0);
            lx = qx; ly = qy; lz = qz;
          }
        }
        for (let i = 0; i < S.nB; i++) {
          const bx = ox - S.bPos[i * 3] * hh, by = oy + S.bPos[i * 3 + 1] * hh, bz = oz + S.bPos[i * 3 + 2] * hh, age = S.bAge[i], sz = S.bSize[i], kind = S.bKind[i], seed = S.bSeed[i];
          const cr = S.bCol[i * 3], cg = S.bCol[i * 3 + 1], cb = S.bCol[i * 3 + 2];
          // the flash (white-hot, two frames), the fireball (the gift's colour, cooling to crimson), sparks thrown out and falling
          if (age < 0.14) { const r = hh * sz * (0.10 + 1.5 * age); quad(QT, bx, by, bz, r, 0, 0, r, 1, 0.96, 0.9, 2.2 * (1 - age / 0.14), 0, 0); }
          const life = kind >= 2 ? 1.5 : 0.75;
          if (age < life) {
            const u = age / life, r = hh * sz * (0.07 + 0.17 * (1 - Math.exp(-age * 9)));
            quad(QT, bx, by, bz, r, 0, 0, r, lerp(cr, 1.0, u), lerp(cg, 0.13, u), lerp(cb, 0.2, u), (kind >= 2 ? 1.05 * (1 - u) : 1.5) * (1 - u) * (1 - u), 0, 0);
            const n = kind === 0 ? 8 : kind === 1 ? 14 : kind === 2 ? 34 : 26;
            for (let k = 0; k < n; k++) {
              const a = h3(seed * 97 + k * 1.37) * Math.PI * 2, v = (0.55 + 0.9 * h3(seed * 31 + k * 2.11)) * (kind >= 2 ? 1.5 : 0.8) * Math.sqrt(sz), fall = kind === 3 ? 1.5 : 0.9;
              const d = v * (1 - Math.exp(-age * 4.5)) / 4.5, sp = v * Math.exp(-age * 4.5);
              const sx = -Math.cos(a) * d * hh, sy = (Math.sin(a) * d - fall * age * age * 0.5) * hh;
              const vx = -Math.cos(a) * sp, vy = Math.sin(a) * sp - fall * age, vl = Math.hypot(vx, vy) || 1e-6;
              const len = hh * (0.012 + 0.05 * Math.min(1, vl)) * Math.sqrt(sz), wd = hh * 0.011 * Math.sqrt(sz), fd = (1 - u) * (1 - u);
              const gold = k % 3 === 0;
              quad(QT, bx + sx, by + sy, bz, vx / vl * len, vy / vl * len, -vy / vl * wd, vx / vl * wd, gold ? 1 : lerp(cr, 1, u * 0.5), gold ? 0.72 : lerp(cg, 0.15, u), gold ? 0.25 : lerp(cb, 0.2, u), 1.6 * fd, 2, 0);
            }
          }
        }
        for (let i = 0; i < S.nR; i++) {
          const age = S.rAge[i], r = hh * S.rSize[i] * (0.15 + 0.95 * (1 - Math.exp(-age * 3.4)));
          quad(QT, ox, oy - 0.02 * hh, oz + h.geo.faceZ * hh, r, 0, 0, r, S.rCol[i * 3], S.rCol[i * 3 + 1], S.rCol[i * 3 + 2], (S.rSoft[i] ? 0.8 : 1.5) * Math.pow(1 - age / 1.1, 1.6), 1, 0.05 + 0.05 * age);
        }
        for (let i = 0; i < S.nS; i++) {
          const age = S.sAge[i], u = age / 0.7, r = hh * 0.06 * S.sSize[i] * (0.5 + 0.9 * Math.sin(Math.min(1, u * 1.6) * Math.PI));
          quad(QT, ox - S.sPos[i * 3] * hh, oy + S.sPos[i * 3 + 1] * hh, oz + S.sPos[i * 3 + 2] * hh, r, 0, 0, r, S.sCol[i * 3], S.sCol[i * 3 + 1], S.sCol[i * 3 + 2], 1.4 * (1 - u), 3, 0);
        }
      }
      for (let i = nR; i < rocketsOn; i++) rockets[i].setEnabled(false);
      rocketsOn = nR;
      flush(QD); flush(QT);
      stats.quads = QD.used + QT.used; if (stats.quads > stats.maxQuads) stats.maxQuads = stats.quads;
      if (t0) { stats.drawMs = performance.now() - t0; if (stats.drawMs > stats.maxDrawMs) stats.maxDrawMs = stats.drawMs; stats.frames++; }
    }

    // ---- sounds: the Mask's own procedural gift sounds (mask/mask-sfx.js), when that file is loaded
    function audioOut(warmIt) {
      const Sfx = global.VTMaskSfx;
      if (!Sfx || !(global.AudioContext || global.webkitAudioContext)) return null;
      try {
        if (!actx) {
          actx = new (global.AudioContext || global.webkitAudioContext)();
          sfxOut = actx.createGain(); sfxOut.gain.value = 0.8; sfxOut.connect(actx.destination);
          if (warmIt) Sfx.schedule(actx, sfxOut, [{ t: 0, kind: 'whoosh', size: 1, dur: 0.05 }, { t: 0, kind: 'bang', size: 1 }, { t: 0, kind: 'boom', size: 1 }, { t: 0, kind: 'charge', size: 1, dur: 0.05 }], actx.currentTime + 0.01, { volume: 0 });
        }
        if (actx.state === 'suspended') actx.resume();
      } catch (e) { return null; }
      return sfxOut;
    }
    function sounds(t) {
      if (t < cueT - 1 || t > cueT + 1) cueT = t;                       // the clock jumped (a new page clock): start from here
      const cues = cur.fx.cuesBetween(cueT, t + 0.12);
      cueT = t + 0.12;
      if (!cues.length) return;
      try { const out = audioOut(false); if (out) global.VTMaskSfx.schedule(actx, out, cues.map((c) => ({ t: c.t - t, kind: c.kind, size: c.size * 0.8, dur: c.dur })), actx.currentTime + 0.02); } catch (e) { /* silent */ }
    }
    function setSounds(on) { soundsOn = !!on; if (soundsOn && stats.warm && !O.noAudio) audioOut(true); }

    /** everything a gift needs for the first time, made now: the shaders on the graphics card, the buffers, the sound output */
    async function warm(hero) {
      try {
        // the three programs are built on the graphics card first (Babylon builds them in the background and SKIPS a mesh
        // whose program is not ready, so drawing at once would warm nothing) ...
        await Promise.all([rk.material.forceCompilationAsync(rk, { useInstances: true }), QD.mesh.material.forceCompilationAsync(QD.mesh), QT.mesh.material.forceCompilationAsync(QT.mesh)]);
        const h = per[hero.id] || attach(hero), w = Fx.create({ geo: h.geo });
        w.fire({ type: 'gift', coins: 100000, count: 1 }, 0); w.fire({ type: 'like', count: 5 }, 0.2); w.fire({ type: 'follow' }, 0.6);
        const keepCur = cur, keepS = sample, keepT = tNow, an = hero.anchor, c = new B.Vector3(an.x, an.eye, hero.nodes[hero.nodes.length - 1].getAbsolutePosition().z);
        const fake = { hh: h.hh, geo: h.geo, fx: w };
        // a finale squashes the hero (a non-uniform scale): Babylon then needs another variant of the hero's own programs and
        // would build it inside the first finale's frame (25 - 48 ms once). Built here instead: the hero is squashed, unseen,
        // its programs are compiled for that, the warm frames are drawn with it, and the scale is put back.
        const keepScale = hero.holder.scaling.clone();
        try {
          hero.holder.scaling.set(1.04, 0.92, 1.04); hero.holder.computeWorldMatrix(true);
          const own = hero.holder.getChildMeshes ? hero.holder.getChildMeshes(false) : (hero.meshes || []);
          const jobs = [];
          for (const m of own) { m.computeWorldMatrix(true); if (m.material && m.material.forceCompilationAsync && m.subMeshes && m.subMeshes.length) jobs.push(m.material.forceCompilationAsync(m).catch(() => null)); }
          await Promise.all(jobs); stats.squashWarm = (stats.squashWarm || 0) + jobs.length;
        } catch (e) { stats.squashWarmError = String(e && e.message || e); }
        for (const t of [0.7, 2.6, 4.25, 4.5]) { cur = fake; tNow = t; sample = w.sample(t); face({ eyeL_open: 1 }, hero.id); draw(hero, c); scene.render(); }
        hero.holder.scaling.copyFrom(keepScale); hero.holder.computeWorldMatrix(true);
        // ... and the card is made to finish those draws now, not at the first gift
        try { const gl = scene.getEngine()._gl; gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } catch (e) { /* no context to finish */ }
        cur = keepCur; sample = keepS; tNow = keepT; QD.used = 0; QT.used = 0; for (const m of rockets) m.setEnabled(false); rocketsOn = 0; flush(QD); flush(QT);
        stats.warm = true; stats.maxDrawMs = 0; stats.maxQuads = 0;
      } catch (e) { stats.warmError = String(e && e.message || e); }
      if (soundsOn && !O.noAudio) audioOut(true);
      return stats.warm;
    }
    return { attach, fire, begin, face, draw, warm, setMap, setSounds, stats, per, get sample() { return sample; }, get sounds() { return soundsOn; } };
  }
  global.VTGifts3D = { create };
})(typeof window !== 'undefined' ? window : globalThis);
