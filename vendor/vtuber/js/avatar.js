// avatar.html: the OBS Browser Source. Draws ONLY the avatar (and its background). State arrives over the WebSocket.
// js/avatar-boot.js has already run: it painted the background / cover for the last known state and opened the socket
// before this file (and the 3D library) loaded, so an ON avatar never shows the camera while the models load.
//   ?manual=1  no WebSocket, no render loop: a capture script drives it with window.__vt.apply(msg) and __vt.step(ms)
//   ?on=1&character=ryo|melanie&bg=green&face=happy&zoom=1   a starting state, for looking at the page alone
//
// v2: the face is one continuously animated drawing (js/face2.js) driven by `perf` messages (protocol v2, V2-PLAN.md)
// through js/face-map.js. The page draws at the display rate and INTERPOLATES between perf messages (their `at` capture
// times); it never steps when a message arrives. A v1 `face` message is still understood (older tracker).
//
// PER-FRAME ORDER (tick). Other modules hook in at the marked places and nowhere else:
//   1. idle clip poses the skeleton                      (every joint is re-posed each frame)
//   2. FACE: FaceAnimator.update -> rig parameters       (perf.face, microphone, held preset, idle life)
//   3. HEAD: the head turn and the head shift are DECIDED (head.yaw / pitch / roll, shift) but not applied yet
//   4. BODY HOOK: hero.body.update(perf, t, dt, ctx)     (js/body.js, window.VTBody; ctx = { head, talk, shift, tracked })
//   5. HEAD applied to the joint chain, the whole-avatar shift applied to the holder; then the FRAME LIMIT: whatever the
//      slide, the body's lean and the head turn add up to, the face centre stays inside the picture
//   6. face picture redrawn + laid on the head, camera framed, scene rendered
(function () {
  'use strict';
  const B = window.BABYLON, L = window.VTLogic, F2 = window.VTFace2, M = window.VTFaceMap, Boot = window.VTBoot;
  const MANUAL = Boot.MANUAL;
  const BODY_ON = new URLSearchParams(location.search).get('body') !== '0';   // ?body=0: the face alone (face review captures)
  const HANDS3D_ON = new URLSearchParams(location.search).get('hands3d') !== '0';
  const GESTURES_ON = new URLSearchParams(location.search).get('gestures') !== '0';   // ?gestures=0: no talk gestures (fix round B1; on by default)   // ?hands3d=0: the model's own hands (no fingers)
  const GIFTS_ON = new URLSearchParams(location.search).get('gifts') !== '0';         // ?gifts=0: no gift missiles on the heroes (round 5; on by default)
  const canvas = document.getElementById('stage');
  const RAD = Math.PI / 180;
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason && e.reason.message || e.reason)));

  // ------------------------------------------------------------------ state
  const state = {
    avatar: Boot.initial,
    faceSince: 0,           // when the manual face last changed
    perf: null, perfAt: -1e9,          // the newest `perf` message and when it arrived (page clock)
    micAt: -1e9,
  };
  let clock = 0;            // ms; performance.now() live, stepped in manual mode
  const now = () => clock;
  const anim = new M.FaceAnimator(state.avatar.character, 5);
  // V5: the voice-led mouth and the snapping expressions (js/voice.js + js/expr.js). ?v5=0: the v2 face as it was.
  if (new URLSearchParams(location.search).get('v5') !== '0' && window.VTExpr && window.VTVoice) anim.v5 = window.VTExpr.create(state.avatar.character);
  // Round 5, EYES ON CAMERA (on unless the avatar message says eyes: false): the eyes point at the lens. The head still
  // turns, so the eyes turn against it (EYES.yawPer / pitchPer degrees of head turn = the whole of the eye's range).
  const EYES = { yawPer: 42, pitchPer: 36, max: 0.8 };
  const eyeLock = { x: 0, y: 0 };
  const PERF_STALE_MS = 1000;
  // Head: the tracker's angles go through a soft limit (the big chibi head breaks past it), are interpolated between
  // perf messages and followed by a short spring. v1 used a 90 ms half life; this is 28 ms.
  const HEAD = { gain: 1.25, yaw: 30, pitch: 18, roll: 18, halfLifeMs: 28, shiftX: 0.42, shiftY: 0.35, shiftZ: 0.9, shiftHalfLifeMs: 60, shiftMax: 0.6 };
  const head = { yaw: new L.Damped(HEAD.halfLifeMs), pitch: new L.Damped(HEAD.halfLifeMs), roll: new L.Damped(HEAD.halfLifeMs),
    x: new L.Damped(HEAD.shiftHalfLifeMs), y: new L.Damped(HEAD.shiftHalfLifeMs), z: new L.Damped(HEAD.shiftHalfLifeMs) };
  const headFrom = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, s: 1 }, headTo = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, s: 1 }, headNow = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, s: 1 };
  const headHeld = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, s: 1 };
  let headArrive = -1e9, headDur = 33, headAt = null, headLostAt = -1e9;
  const soft = (v, limit) => limit * Math.tanh(v * HEAD.gain / limit);
  // Webcam-style framing: head and shoulders. Fractions of the frame height.
  const FRAME = { head: 0.40, eyes: 0.38 };   // crown to chin = 40 % of the height; the eye line sits 38 % from the top (v1 was 0.45 / 0.42; wider so raised hands and chest gestures stay in the picture)
  // How far the face centre may leave its rest place in the picture (review finding 7: leaning in close and sideways slid
  // the avatar half out of its frame). Sideways: up to the point where the face itself (not the hair) meets the frame's
  // edge, and never less than 12 % of the width; up: until the eye line is 14 % under the top edge; down: a quarter.
  const LIMIT = { faceHalf: 0.38, minX: 0.12, top: 0.14, down: 0.25, knee: 0.6 };
  /** d limited to +-max: straight up to knee * max, then eased so that it never passes max. */
  const softLimit = (d, max) => { const a = Math.abs(d), k = LIMIT.knee * max; return a <= k ? d : Math.sign(d) * (k + (max - k) * Math.tanh((a - k) / (max - k))); };

  // ------------------------------------------------------------------ engine + scene
  const engine = new B.Engine(canvas, true, {
    alpha: true, premultipliedAlpha: true, antialias: true, stencil: false, preserveDrawingBuffer: MANUAL,
    powerPreference: 'high-performance',
  }, false);
  const scene = new B.Scene(engine);
  scene.clearColor = new B.Color4(0, 0, 0, 0);
  scene.autoClear = true;
  scene.skipPointerMovePicking = true;
  const camera = new B.FreeCamera('cam', new B.Vector3(0, 1, 6), scene);
  camera.fov = 16 * RAD; camera.minZ = 0.2; camera.maxZ = 60;
  camera.inputs.clear();
  // soft, even light with a gentle key from the upper front: the faces are flat anime art and must read cleanly
  const sky = new B.HemisphericLight('sky', new B.Vector3(0.1, 1, 0.5), scene);
  sky.intensity = 0.9; sky.diffuse = new B.Color3(1, 0.98, 0.96); sky.groundColor = new B.Color3(0.8, 0.76, 0.74); sky.specular = new B.Color3(0, 0, 0);
  const key = new B.DirectionalLight('key', new B.Vector3(0.35, -0.55, -1), scene);
  key.intensity = 0.55; key.diffuse = new B.Color3(1, 0.97, 0.93); key.specular = new B.Color3(0.25, 0.25, 0.25);
  scene.imageProcessingConfiguration.toneMappingEnabled = false;
  scene.imageProcessingConfiguration.exposure = 1;

  // ------------------------------------------------------------------ gift missiles (js/gift-fx.js + js/gifts3d.js)
  let gifts = null;
  if (GIFTS_ON && window.VTGifts3D && window.VTGiftFx) { try { gifts = window.VTGifts3D.create(scene, { noAudio: MANUAL }); } catch (e) { errors.push('gifts: ' + (e && e.message || e)); gifts = null; } }
  const faceC = new B.Vector3();
  let giftsAsked = -1e9, giftDrawn = true;
  /** his gift list (the Mask's: which gift sets off which size), read when the avatar goes ON; without it the standard list */
  function askGifts() {
    if (!gifts || MANUAL || performance.now() - giftsAsked < (arguments[0] || 5000)) return;
    giftsAsked = performance.now();
    fetch('/api/vt/gifts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((g) => { if (g && Array.isArray(g.rows)) gifts.setMap(g.rows); }).catch(() => { /* the standard list */ });
  }

  // ------------------------------------------------------------------ heroes
  const HERO = {
    ryo: { file: 'ryo-arena.glb', idle: 'Ryo_Idle_Local', chain: ['Chest', 'Neck', 'Head'], share: [0.15, 0.25, 0.6] },
    melanie: { file: 'melanie-arena.glb', idle: 'Melanie_Idle_Local', chain: ['Spine', 'neck', 'Head'], share: [0.15, 0.25, 0.6] },
  };
  const faceData = id => fetch('assets/faces/' + id + '-face-data.json').then(r => {
    if (!r.ok) throw new Error(id + ': face data missing');
    return r.json();
  }).then(d => Object.assign(d, { url: 'assets/faces/' + id + '-face-atlas.webp', baseUrl: 'assets/faces/' + id + '-base-clean.webp',
    normalUrl: 'assets/faces/' + id + '-normal-clean.webp', ormUrl: 'assets/faces/' + id + '-orm-clean.webp',
    partsUrl: 'assets/faces/' + id + '-parts.json', partsImageUrl: 'assets/faces/' + id + '-parts.webp' }));
  const heroes = {};
  const tmpM = new B.Matrix(), tmpP = new B.Matrix(), tmpD = new B.Matrix(), tmpL = new B.Matrix(), tmpS = new B.Vector3(), tmpT = new B.Vector3(), tmpQ = new B.Quaternion();

  /**
   * The hero object. js/body.js receives it in VTBody.create(scene, hero) and may keep it: every field stays the same
   * object for the life of the page.  { id, spec, holder, root, skeleton, transformNodes, node(name), idle, nodes
   * (the head chain), rest, meshes, face, box, anchor, body }
   */
  async function loadHero(id) {
    const spec = HERO[id];
    const result = await B.SceneLoader.ImportMeshAsync('', 'assets/models/', spec.file, scene);
    const root = result.meshes[0];                      // __root__ (right-handed -> left-handed)
    const holder = new B.TransformNode(id + '-holder', scene);
    root.parent = holder;
    for (const g of result.animationGroups) g.stop();
    const idle = result.animationGroups.find(g => g.name === spec.idle) || null;
    if (idle) { idle.start(true); idle.pause(); idle.goToFrame(idle.from); }
    const byName = new Map(result.transformNodes.map(n => [n.name, n]));
    const nodes = spec.chain.map(name => byName.get(name));
    if (nodes.some(n => !n)) throw new Error(id + ': missing joint ' + spec.chain.join('/'));
    const meshes = result.meshes.filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
    for (const m of meshes) { m.alwaysSelectAsActiveMesh = true; m.isPickable = false; }
    const data = await faceData(id);
    const face = await F2.Face2Rig.create(scene, meshes, data, nodes[nodes.length - 1]);
    const hero = { id, spec, holder, root, skeleton: result.skeletons[0], transformNodes: result.transformNodes, node: name => byName.get(name) || null,
      idle, nodes, meshes, face, box: headBox(meshes, result.skeletons[0], 'Head'), rest: nodes.map(n => n.rotationQuaternion.clone()), body: null };
    hero.anchor = measureFace(hero, result.skeletons[0], 'Head');
    // the face centre (middle of the eye line) as a point of the head joint, for the frame limit
    const headNode = nodes[nodes.length - 1];
    hero.faceLocal = B.Vector3.TransformCoordinates(new B.Vector3(hero.anchor.x, hero.anchor.eye, headNode.getAbsolutePosition().z), headNode.computeWorldMatrix(true).clone().invert());
    face.set(M.params());
    // BODY: js/body.js (window.VTBody), when it is loaded. A failure there must never take the face down.
    if (BODY_ON && window.VTBody && typeof window.VTBody.create === 'function') {
      try { hero.body = window.VTBody.create(scene, hero); if (!GESTURES_ON) hero.body.params.gestures = false; } catch (e) { errors.push('body: ' + (e && e.message || e)); hero.body = null; }
    }
    // V5 HANDS HOOK (1 of 2): js/hands3d.js (window.VTHands3D) gives the hero fingers. ?hands3d=0 keeps the model's own hands.
    hero.hands3d = null;
    if (hero.body && HANDS3D_ON && window.VTHands3D && typeof window.VTHands3D.create === 'function') {
      try { hero.hands3d = window.VTHands3D.create(scene, hero); } catch (e) { errors.push('hands3d: ' + (e && e.message || e)); hero.hands3d = null; }
    }
    if (gifts) { try { gifts.attach(hero); } catch (e) { errors.push('gifts: ' + (e && e.message || e)); } }
    holder.setEnabled(false);
    heroes[id] = hero;
    return hero;
  }

  /** Bind-pose box of everything that moves with the head (hair, ears, glasses), in model units. */
  function headBox(meshes, skeleton, jointName) {
    const j = skeleton.bones.findIndex(b => b.name === jointName);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const mesh of meshes) {
      const p = mesh.getVerticesData(B.VertexBuffer.PositionKind), mi = mesh.getVerticesData(B.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData(B.VertexBuffer.MatricesWeightsKind);
      if (!p || !mi || !mw) continue;
      for (let v = 0; v < p.length / 3; v++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (mi[v * 4 + k] === j) w += mw[v * 4 + k];
        if (w < 0.6) continue;
        const x = p[v * 3], y = p[v * 3 + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { x0, x1, y0, y1 };
  }

  /**
   * Where the face sits in the idle pose (scene units): the eye line, the chin, the crown and the middle of the face.
   * The eye line comes from the face art (the blink areas); chin and crown are the lowest / highest points that move
   * with the head in a narrow strip down the middle of the face (so side hair, ears and long back hair do not count).
   */
  function measureFace(hero, skeleton, jointName) {
    const d = hero.face.data, j = skeleton.bones.findIndex(b => b.name === jointName);
    hero.root.computeWorldMatrix(true);
    for (const n of hero.nodes) n.computeWorldMatrix(true);
    skeleton.prepare(true);
    hero.face.update();
    const toCrop = hero.face.plugin.faceMatrix, fromCrop = toCrop.clone().invert();
    const zones = d.blinkZones, eyeU = (zones[0][0] + (zones[1] || zones[0])[0]) / 2 / 1024, eyeV = (zones[0][1] + (zones[1] || zones[0])[1]) / 2 / 1024;
    const depthMid = (d.depthRange[0] + d.depthRange[1]) / 2;
    const eye = B.Vector3.TransformCoordinates(new B.Vector3(eyeU, eyeV, depthMid), fromCrop);
    let chin = Infinity, crown = -Infinity, n = 0;
    const p = new B.Vector3(), c = new B.Vector3();
    for (const mesh of hero.meshes) {
      const mi = mesh.getVerticesData(B.VertexBuffer.MatricesIndicesKind), mw = mesh.getVerticesData(B.VertexBuffer.MatricesWeightsKind);
      let pos = null;
      try { pos = mesh.getPositionData(true, false); } catch (e) { pos = null; }
      if (!pos || !mi || !mw) continue;
      const world = mesh.computeWorldMatrix(true);
      for (let v = 0; v < pos.length / 3; v++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (mi[v * 4 + k] === j) w += mw[v * 4 + k];
        if (w < 0.3) continue;
        B.Vector3.TransformCoordinatesFromFloatsToRef(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], world, p);
        B.Vector3.TransformCoordinatesToRef(p, toCrop, c);
        if (w >= 0.6 && Math.abs(c.x - 0.5) < 0.35 && p.y > crown) crown = p.y;                     // top of the hair (not the ears at the sides)
        if (Math.abs(c.x - 0.5) < 0.1 && c.y > eyeV && c.z >= d.depthRange[0] && p.y < chin) chin = p.y;   // front surface, below the eyes
        n++;
      }
    }
    const headH = hero.box.y1 - hero.box.y0;
    if (!n || !Number.isFinite(chin) || !Number.isFinite(crown) || !(crown > eye.y && eye.y > chin)) {
      // could not measure (unexpected model): fall back to the head box, eyes a little under its middle
      return { x: -(hero.box.x0 + hero.box.x1) / 2, eye: hero.box.y0 + headH * 0.45, chin: hero.box.y0, crown: hero.box.y1, measured: false };
    }
    return { x: eye.x, eye: eye.y, chin, crown, measured: true };
  }

  /**
   * Webcam-style framing, the same for every hero and every frame shape: head and shoulders, the head (chin to crown)
   * FRAME.head of the frame height, the eye line FRAME.eyes from the top. The camera does not follow the head: like a
   * real webcam it stays put while the head moves in the picture. The panel's Size and Height sliders adjust around it.
   */
  function frame(hero) {
    const an = hero.anchor, headH = an.crown - an.chin;
    const zoom = state.avatar.zoom;
    let viewH = headH / FRAME.head / zoom;
    let cy = an.eye - (0.5 - FRAME.eyes) * viewH - state.avatar.offsetY * viewH;   // offsetY > 0 moves the avatar up
    let cx = an.x;
    if (debug.closeUp) { const b = hero.box; viewH = (b.y1 - b.y0) * debug.closeUp; cy = b.y0 + (b.y1 - b.y0) * debug.closeUpAt; cx = -(b.x0 + b.x1) / 2; }   // review close-up of the face
    const dist = (viewH / 2) / Math.tan(camera.fov / 2);
    camera.position.set(cx, cy, dist);     // the heroes face +z
    camTarget.set(cx, cy, 0);
    camera.setTarget(camTarget);
  }

  /** Turn `node` by a model-space rotation `q` (applied on top of its current pose). */
  function turnInModelSpace(hero, node, q) {
    // parent's rotation relative to the model root (the root's own flip is left out: it only has a uniform scale below it)
    hero.root.computeWorldMatrix(true).invertToRef(tmpM);
    node.parent.computeWorldMatrix(true).multiplyToRef(tmpM, tmpP);
    tmpP.decompose(tmpS, tmpQ, tmpT);
    B.Matrix.FromQuaternionToRef(tmpQ, tmpP);                     // P: parent rotation only
    B.Matrix.FromQuaternionToRef(node.rotationQuaternion, tmpL);   // L: local rotation
    B.Matrix.FromQuaternionToRef(q, tmpD);                         // D: the extra turn, model space
    // L' = L * P * D * P^-1 (row vectors: local, then to model space, turn, back)
    tmpL.multiplyToRef(tmpP, tmpM); tmpM.multiplyToRef(tmpD, tmpL);
    tmpP.invertToRef(tmpM); tmpL.multiplyToRef(tmpM, tmpD);
    B.Quaternion.FromRotationMatrixToRef(tmpD, node.rotationQuaternion);
  }
  const camTarget = new B.Vector3();
  const AX = new B.Vector3(1, 0, 0), AY = new B.Vector3(0, 1, 0), AZ = new B.Vector3(0, 0, 1);
  /** Image-space angles (deg; +yaw = toward image right, +pitch = up, +roll = clockwise on screen) as a model-space turn. */
  function headQuaternion(yaw, pitch, roll, share) {
    const qy = B.Quaternion.RotationAxis(AY, yaw * RAD * share);
    const qx = B.Quaternion.RotationAxis(AX, -pitch * RAD * share);
    const qz = B.Quaternion.RotationAxis(AZ, -roll * RAD * share);
    return qz.multiply(qy.multiply(qx));
  }

  // ------------------------------------------------------------------ per frame
  let lastTick = null, cleared = false, shown = null, frames = 0, fps = 0, fpsAt = 0;
  const ctx = { head: { yaw: 0, pitch: 0, roll: 0 }, talk: 0, shift: { x: 0, y: 0, z: 0 }, tracked: false };   // what the body hook is told
  function tick(dt) {
    const t = now();
    const a = state.avatar, hero = heroes[a.character];
    if (!a.on || !hero || a.mask) {     // a.mask: the Mask is shown instead (js/mask-page.js, its own canvas on top)
      if (!a.on || a.mask) Boot.uncover();   // nothing to hide behind a cover when the avatar is off
      if (shown) { shown.holder.setEnabled(false); shown = null; }
      if (!cleared) { engine.clear(scene.clearColor, true, true); cleared = true; }
      return;
    }
    cleared = false;
    if (shown !== hero) { if (shown) shown.holder.setEnabled(false); hero.holder.setEnabled(true); shown = hero; anim.setHero(hero.id); }
    const s = t / 1000;
    // gift missiles: what is in the air this frame, and what the character does about it (null = nothing)
    let react = null;
    if (gifts) { try { react = gifts.begin(hero.id, t); } catch (e) { react = null; if (!debug.giftsError) { debug.giftsError = String(e && e.message || e); errors.push('gifts: ' + debug.giftsError); } } }

    // --- 1. the idle clip poses every joint
    if (hero.idle) {
      const span = hero.idle.to - hero.idle.from;
      hero.idle.goToFrame(hero.idle.from + ((s * 60) % span));
    } else hero.nodes.forEach((n, i) => n.rotationQuaternion.copyFrom(hero.rest[i]));

    // --- 2. FACE: parameters for this frame (a held manual face overrides tracking)
    const manual = a.face !== 'auto' && (a.faceHoldMs === 0 || t - state.faceSince <= a.faceHoldMs + 2500) ? a.face : null;
    if (manual !== anim.preset) anim.setPreset(manual);
    // eyes on camera: the eyes turn against the head (the angles the head was drawn with a frame ago)
    if (a.eyes !== false) { eyeLock.x = L.clamp(-ctx.head.yaw / EYES.yawPer, -EYES.max, EYES.max); eyeLock.y = L.clamp(-ctx.head.pitch / EYES.pitchPer, -EYES.max, EYES.max); anim.lock = eyeLock; } else anim.lock = null;
    let P = anim.update(t, dt);
    if (react) P = gifts.face(P, hero.id, a.eyes === false);      // a flinch on a hit, the shocked face at a finale; then his own again
    if (debug.params0) P = debug.params0;                       // review tools: show exactly this parameter set
    hero.face.set(P);
    const tracked = anim.tracked;

    // --- 3. HEAD decided: interpolate between perf messages, soft limit, short spring; untracked = a slow drift
    if (tracked) {
      const u = L.clamp((t - headArrive) / headDur, 0, 1);
      for (const k in headNow) headNow[k] = headFrom[k] + (headTo[k] - headFrom[k]) * u;
      for (const k in headNow) headHeld[k] = headNow[k];
      headLostAt = null;
    } else {
      // tracking lost: ease from where the head was into the idle drift over 0.7 s (never a snap back to centre)
      if (headLostAt == null) headLostAt = t;
      const e = L.clamp((t - headLostAt) / 700, 0, 1), w = e * e * (3 - 2 * e);
      const drift = { yaw: 4 * Math.sin(s * 0.43) + 2 * Math.sin(s * 1.1 + 1), pitch: 2 * Math.sin(s * 0.61 + 2), roll: 1.6 * Math.sin(s * 0.37 + 0.5), x: 0, y: 0, s: 1 };
      for (const k in headNow) headNow[k] = headHeld[k] + (drift[k] - headHeld[k]) * w;
    }
    const talkNod = anim.talk * 1.6;   // a small lift while speaking
    const yaw = head.yaw.update(soft(headNow.yaw, HEAD.yaw), dt), pitch = head.pitch.update(soft(headNow.pitch, HEAD.pitch) + talkNod, dt) + (react ? react.knock : 0), roll = head.roll.update(soft(headNow.roll, HEAD.roll), dt);
    // the whole avatar shifts a little in the frame as he does (head widths -> model units)
    const headW = hero.box.x1 - hero.box.x0, lim = HEAD.shiftMax;
    const sx = head.x.update(L.clamp(headNow.x, -lim, lim) * HEAD.shiftX * headW, dt), sy = head.y.update(L.clamp(headNow.y, -lim, lim) * HEAD.shiftY * headW, dt);
    const sz = head.z.update(L.clamp(headNow.s - 1, -0.3, 0.4) * HEAD.shiftZ * headW, dt);
    ctx.head.yaw = yaw; ctx.head.pitch = pitch; ctx.head.roll = roll; ctx.talk = anim.talk; ctx.voice = anim.v5 && anim.v5.voice ? anim.v5.voice.out : null; ctx.shift.x = -sx; ctx.shift.y = sy; ctx.shift.z = sz; ctx.tracked = tracked;

    // --- 4. BODY HOOK (js/body.js): torso, arms, hands, tails. Runs on the idle pose, before the head is turned.
    if (hero.body) {
      const perf = t - state.perfAt < PERF_STALE_MS ? state.perf : null;
      try { hero.body.update(perf, t, dt, ctx); } catch (e) { if (!debug.bodyError) { debug.bodyError = String(e && e.message || e); errors.push('body: ' + debug.bodyError); } }
      // V5 HANDS HOOK (2 of 2): fingers, pose snapping, wave (after the body has placed the arms)
      if (hero.hands3d) { try { hero.hands3d.update(perf, t, dt); } catch (e) { if (!debug.handsError) { debug.handsError = String(e && e.message || e); errors.push('hands3d: ' + debug.handsError); } } }
    }

    // --- 5. HEAD applied to the chain (chest, neck, head share the turn), shift applied to the holder
    hero.nodes.forEach((node, i) => turnInModelSpace(hero, node, headQuaternion(yaw, pitch, roll, hero.spec.share[i])));
    hero.holder.rotation.y = 1.2 * RAD * Math.sin(s * 0.5);
    hero.holder.position.x = -sx;   // the camera looks down -z, so model +x is screen LEFT; face.pos x is + toward picture right (ctx.shift.x carries this same value)
    hero.holder.position.y = sy + 0.006 * (hero.box.y1 - hero.box.y0) * Math.sin(s * 1.9);
    hero.holder.position.z = sz;
    // --- 5b. FRAME LIMIT: where the face centre has ended up against its rest place, limited; the holder takes the difference
    if (!debug.closeUp) {
      for (const n of hero.nodes) n.computeWorldMatrix(true);
      B.Vector3.TransformCoordinatesToRef(hero.faceLocal, hero.nodes[hero.nodes.length - 1].getWorldMatrix(), tmpT);
      const an = hero.anchor, viewH = (an.crown - an.chin) / FRAME.head / a.zoom, viewW = viewH * engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
      const dx = tmpT.x - an.x, dy = tmpT.y - an.eye;
      const maxX = Math.max(LIMIT.minX * viewW, viewW / 2 - LIMIT.faceHalf * headW);
      const upRoom = Math.max(0.05, FRAME.eyes + a.offsetY - LIMIT.top) * viewH, downRoom = LIMIT.down * viewH;
      const lx = softLimit(dx, maxX), ly = dy >= 0 ? softLimit(dy, upRoom) : softLimit(dy, downRoom);
      if (Number.isFinite(lx) && Number.isFinite(ly)) { hero.holder.position.x += lx - dx; hero.holder.position.y += ly - dy; }
      debug.frameLimit = { dx: lx - dx, dy: ly - dy, maxX, upRoom };
    }

    // --- 5c. a gift's hit shakes the avatar a little and a finale squashes it; the missiles are placed round the head as it is NOW
    const hh = hero.anchor.crown - hero.anchor.chin;
    if (react && (react.shakeX || react.shakeY || react.squash)) {
      hero.holder.position.x += react.shakeX * hh; hero.holder.position.y += react.shakeY * hh;
      hero.holder.scaling.set(1 + 0.5 * react.squash, 1 - react.squash, 1 + 0.5 * react.squash);
    } else if (hero.holder.scaling.y !== 1) hero.holder.scaling.set(1, 1, 1);
    // nothing in the air: no joint matrices and no drawing (one more draw after the last thing has gone puts the rockets away)
    const giftBusy = !!(gifts && gifts.sample && gifts.sample.busy > 0);
    if (gifts && (giftBusy || giftDrawn)) {
      giftDrawn = giftBusy;
      hero.holder.computeWorldMatrix(true); hero.root.computeWorldMatrix(true);
      for (const n of hero.nodes) n.computeWorldMatrix(true);
      B.Vector3.TransformCoordinatesToRef(hero.faceLocal, hero.nodes[hero.nodes.length - 1].getWorldMatrix(), faceC);
      try { gifts.draw(hero, faceC); } catch (e) { if (!debug.giftsError) { debug.giftsError = String(e && e.message || e); errors.push('gifts: ' + debug.giftsError); } }
    }

    // --- 6. the face picture follows the head; draw (a failure in the face drawing must not stop the avatar)
    try { hero.face.update(); } catch (e) { if (!debug.faceError) { debug.faceError = String(e && e.message || e); errors.push('face: ' + debug.faceError); } }
    frame(hero);
    scene.render();
    Boot.uncover();   // the avatar is on screen: the loading cover (if any) goes in the same frame
    frames++;
    debug.base = anim.preset || (tracked ? 'tracked' : 'idle'); debug.mouth = null;
    debug.blink = P.eyeL_open < 0.2 && P.eyeR_open < 0.2 && P.eyeL_happy < 0.5;
    debug.mouthState = P.mouthOpen > 0.55 ? 'loud' : P.mouthOpen > 0.1 ? 'talk' : 'closed';
    debug.v5 = anim.v5 ? anim.v5.state() : null;
    debug.tracker = tracked; debug.params = P; debug.faceMs = hero.face.ms; debug.head = ctx.head;
  }

  // ------------------------------------------------------------------ messages
  /** A v1 `face` message (older tracker) as a perf.face, so the v1 tracker still drives the v2 face. */
  function fromV1(m) {
    const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const smile = n(m.smile), up = n(m.browUp), down = n(m.browDown), wide = n(m.eyeWide), jaw = n(m.jaw);
    return {
      rot: [n(m.yaw), n(m.pitch), n(m.roll)], pos: [0, 0, 1], gaze: [0, 0], blink: [n(m.blinkL), n(m.blinkR)],
      bs: { jawOpen: jaw, mouthSmileLeft: smile, mouthSmileRight: smile, browInnerUp: up, browOuterUpLeft: up, browOuterUpRight: up, browDownLeft: down, browDownRight: down },
      lm: { mouthOpen: jaw, eyeOpenL: 1 + 0.5 * wide, eyeOpenR: 1 + 0.5 * wide, browL: up - down, browR: up - down, cornerL: smile, cornerR: smile },
    };
  }
  function takeFace(face, at) {
    const t = now();
    anim.pushPerf(face, at, t);
    if (!face) return;
    for (const k in headNow) headFrom[k] = headNow[k];
    const r = face.rot || [0, 0, 0], p = face.pos || [0, 0, 1], n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    headTo.yaw = n(r[0]); headTo.pitch = n(r[1]); headTo.roll = n(r[2]); headTo.x = n(p[0]); headTo.y = n(p[1]); headTo.s = Number.isFinite(Number(p[2])) ? Number(p[2]) : 1;
    const gap = headAt == null || !Number.isFinite(at) ? 33 : at - headAt;
    headDur = gap > 0 ? L.clamp(gap, 8, 100) : 33; headAt = Number.isFinite(at) ? at : null; headArrive = t;
  }
  function apply(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'avatar') {
      const next = L.readAvatarMessage(msg);
      if (!next) return;
      if (next.face !== state.avatar.face || next.character !== state.avatar.character) state.faceSince = now();
      const bgChanged = next.bg !== state.avatar.bg || next.on !== state.avatar.on || !!next.mask !== !!state.avatar.mask;
      const cameOn = next.on && !state.avatar.on;
      state.avatar = next;
      if (gifts) { gifts.setSounds(next.sounds !== false); if (cameOn) askGifts(); }
      if (bgChanged) Boot.paint(next);
    } else if (msg.t === 'mask-event') {
      // a viewer event (LIVE Link, or a "Try the effects" button). The Mask takes its own in js/mask-page.js; these are the heroes'.
      const a = state.avatar;
      if (gifts && a.on && !a.mask && msg.e && typeof msg.e === 'object') { try { debug.giftLast = gifts.fire(msg.e, a.character, now()); debug.giftEvents = (debug.giftEvents || 0) + 1; } catch (e) { /* an event it does not know */ } }
    } else if (msg.t === 'mic') {
      state.micAt = now();
      anim.pushMic(msg.level, now(), msg.b);
    } else if (msg.t === 'perf') {
      state.perf = msg; state.perfAt = now();
      // a hand over the lower face (js/body: perf.hands.overFace): the face holds what it showed before the hand came.
      // A message without the field (an older body module) behaves as before.
      anim.setOverFace(!!(msg.hands && msg.hands.overFace === true), now());
      takeFace(msg.face && typeof msg.face === 'object' ? msg.face : null, Number(msg.at));   // the tracker has already applied `mirror`: never flip here
    } else if (msg.t === 'face') {
      if (now() - state.perfAt < PERF_STALE_MS) return;          // a v2 tracker is talking: its v1 status copy is not used
      takeFace(msg.ok === true ? fromV1(msg) : null, Number(msg.at));
    }
  }

  function ack() {
    const a = state.avatar;
    if (a.mask && window.VTMaskPage) return;       // the Mask is shown: js/mask-page.js answers for it
    if (a.on) askGifts(20000);                     // a gift list saved meanwhile counts within 20 s
    Boot.send({ t: 'avatar-ack', ready: debug.ready, on: a.on, character: a.character, fps, w: engine.getRenderWidth(), h: engine.getRenderHeight(), at: Date.now() });
  }

  // ------------------------------------------------------------------ start
  const debug = { closeUp: 0, closeUpAt: 0.3, params0: null, ready: false, base: null, mouth: null, blink: false, mouthState: 'closed', tracker: false, params: null, faceMs: 0, head: null, bodyError: null, faceError: null, frameLimit: null };
  window.__vt = {
    errors, debug, state, heroes, apply, anim, HEAD, EYES, get gifts() { return gifts; },
    /** manual mode: advance the clock by `ms` and draw one frame */
    step(ms) { clock += ms; tick(ms); },
    setSize() { engine.resize(); },
    /** fraction of canvas pixels with any alpha (0 = fully transparent) */
    alphaCoverage() {
      cleared = false; tick(0);          // draw (or clear) now, then read the same buffer
      const gl = engine._gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
      return n / (w * h);
    },
    get fps() { return fps; },
  };
  Boot.take(apply);        // messages from now on (the state that arrived while this file loaded comes first)
  window.addEventListener('resize', () => engine.resize());
  window.__vtReady = Promise.all([loadHero('ryo'), loadHero('melanie')]).then(() => scene.whenReadyAsync()).then(async () => {
    // gift missiles: built and drawn once, unseen, so the first gift of a show does not hitch
    if (gifts && new URLSearchParams(location.search).get('giftwarm') !== '0') { for (const id of ['ryo', 'melanie']) { const h = heroes[id]; h.holder.setEnabled(true); frame(h); await gifts.warm(h); h.holder.setEnabled(false); } engine.clear(scene.clearColor, true, true); debug.gifts = gifts.stats; }
    debug.ready = true;
    if (MANUAL) return true;
    askGifts();
    setInterval(ack, 1000);
    engine.runRenderLoop(() => {
      const t = performance.now();
      const dt = lastTick == null ? 16 : Math.min(100, t - lastTick);
      lastTick = t; clock = t;
      if (t - fpsAt >= 1000) { fps = Math.round(frames * 1000 / (t - fpsAt)); frames = 0; fpsAt = t; }
      tick(dt);
    });
    return true;
  }).catch(err => { errors.push(String(err && err.message || err)); console.error(err); return false; });
})();
