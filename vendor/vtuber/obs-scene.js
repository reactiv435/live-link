// What the one-click VTuber does inside OBS, and nothing more:
//   - finds the camera that is the owner (a droidcam_obs input that is VISIBLE in his scenes),
//   - adds ONE browser source ("VTuber Avatar") and puts one item of it directly above that camera in every scene where
//     the camera is visible, sized to the camera's box on the canvas, upright,
//   - switches those items on and off,
//   - takes them out again ("Remove VTuber from OBS").
// It never moves, hides, edits, renames or re-orders anything that is his. Node only (no browser code).
// obs-websocket v5 facts this is written against (checked in the obs-websocket source): CreateSceneItem and
// RemoveSceneItem work on scenes only, NOT on groups; GetGroupSceneItemList reads a group; the transform / enabled /
// index requests work on scenes and groups; SetSceneItemIndex 0 = the bottom item.
'use strict';

const AVATAR_INPUT = 'VTuber Avatar';
const CAMERA_KINDS = ['droidcam_obs'];
// other hosts' cameras (V6): a webcam or capture card on Windows (dshow_input), the built-in camera, a webcam or an
// iPhone on a Mac (av_capture_input: OBS reports "Video Capture Device" v1 and v2 under this unversioned kind; the two
// longer names are what some OBS builds report for the same plugin), a webcam on Linux (v4l2_input)
const OTHER_CAMERA_KINDS = ['dshow_input', 'av_capture_input', 'av_capture_input_v2', 'macos-avcapture', 'macos-avcapture-fast', 'v4l2_input'];
// the avatar page's address in OBS, whichever of the app's own places it was made on (8791, or 8792 - 8795 inside LIVE Link)
const OWN_AVATAR_URL = /^http:\/\/127\.0\.0\.1:879[1-5]\/avatar\.html$/;
const isOwnAvatarUrl = (u) => OWN_AVATAR_URL.test(String(u || '').split('?')[0]);
const MAX_SHORT = 720, MAX_LONG = 1280;      // the avatar page is drawn at most this big; OBS scales the item up to the box

const kindOf = (input) => input.unversionedInputKind || input.inputKind || '';
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- geometry
/** The four corners (canvas pixels) of a scene item, from its obs-websocket transform. */
function itemCorners(t) {
  const sx = Number(t.scaleX) || 1, sy = Number(t.scaleY) || 1;
  const bounded = t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE';
  let w, h;
  if (bounded) { w = Number(t.boundsWidth) || 0; h = Number(t.boundsHeight) || 0; }
  else {
    w = Math.abs(((Number(t.sourceWidth) || 0) - (Number(t.cropLeft) || 0) - (Number(t.cropRight) || 0)) * sx);
    h = Math.abs(((Number(t.sourceHeight) || 0) - (Number(t.cropTop) || 0) - (Number(t.cropBottom) || 0)) * sy);
    if ((!w || !h) && t.width && t.height) { w = Math.abs(t.width); h = Math.abs(t.height); }
  }
  const al = bounded ? (Number(t.boundsAlignment) || 0) : (Number(t.alignment) || 0);
  // alignment bits: 1 left, 2 right, 4 top, 8 bottom; neither = the centre. The item's position is that point.
  const ax = al & 1 ? 0 : al & 2 ? w : w / 2;
  const ay = al & 4 ? 0 : al & 8 ? h : h / 2;
  const a = (Number(t.rotation) || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const px = Number(t.positionX) || 0, py = Number(t.positionY) || 0;
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => {
    const lx = x - ax, ly = y - ay;
    return [px + lx * c - ly * s, py + lx * s + ly * c];
  });
}
function boxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: round2(x0), y: round2(y0), w: round2(x1 - x0), h: round2(y1 - y0) };
}
/** The item's box on the canvas (upright rectangle around it). rotation 270 at (0,1920), 1920x1080, scale 1 = 0,0 1080x1920. */
function itemBox(t) { return boxOf(itemCorners(t)); }
/** The box of an item that sits inside a group: its corners inside the group, carried through the group item's own transform. */
function groupedItemBox(t, groupT) {
  const gsx = Number(groupT.scaleX) || 1, gsy = Number(groupT.scaleY) || 1;
  const gw = Math.abs((Number(groupT.sourceWidth) || 0) * gsx), gh = Math.abs((Number(groupT.sourceHeight) || 0) * gsy);
  const al = Number(groupT.alignment) || 0;
  const ax = al & 1 ? 0 : al & 2 ? gw : gw / 2, ay = al & 4 ? 0 : al & 8 ? gh : gh / 2;
  const a = (Number(groupT.rotation) || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const px = Number(groupT.positionX) || 0, py = Number(groupT.positionY) || 0;
  return boxOf(itemCorners(t).map(([x, y]) => {
    const lx = (x - (Number(groupT.cropLeft) || 0)) * gsx - ax, ly = (y - (Number(groupT.cropTop) || 0)) * gsy - ay;
    return [px + lx * c - ly * s, py + lx * s + ly * c];
  }));
}
/** How the tracker must turn the raw camera picture so the owner is upright: the item's own turn and flips. */
function viewOf(t) {
  const r = ((Math.round((Number(t.rotation) || 0) / 90) % 4) + 4) % 4 * 90;
  return { turn: r, flip: (Number(t.scaleX) || 1) < 0 ? 'h' : (Number(t.scaleY) || 1) < 0 ? 'v' : 'none' };
}

/** The size the avatar page is drawn at for a box: the box's shape, at most 720 on the short side and 1280 on the long one. */
function renderSize(box) {
  const long = Math.max(box.w, box.h), short = Math.min(box.w, box.h);
  const k = Math.min(1, MAX_LONG / long, MAX_SHORT / short);
  const even = (v) => Math.max(2, Math.round(v * k / 2) * 2);
  return { width: even(box.w), height: even(box.h) };
}
/** The avatar item's transform so a page of `size` covers `box` exactly (scaled up, the overflow cut off evenly). */
function coverTransform(box, size) {
  const k = Math.max(box.w / size.width, box.h / size.height);
  const cutX = Math.max(0, Math.round((size.width - box.w / k) / 2)), cutY = Math.max(0, Math.round((size.height - box.h / k) / 2));
  return {
    positionX: box.x, positionY: box.y, rotation: 0, alignment: 5, boundsType: 'OBS_BOUNDS_NONE',
    scaleX: box.w / (size.width - 2 * cutX), scaleY: box.h / (size.height - 2 * cutY),
    cropLeft: cutX, cropRight: cutX, cropTop: cutY, cropBottom: cutY,
  };
}
const TRANSFORM_KEYS = ['positionX', 'positionY', 'rotation', 'alignment', 'boundsType', 'scaleX', 'scaleY', 'cropLeft', 'cropRight', 'cropTop', 'cropBottom'];
function sameTransform(have, want) {
  return TRANSFORM_KEYS.every((k) => (typeof want[k] === 'number' ? Math.abs((Number(have[k]) || 0) - want[k]) < 0.002 : have[k] === want[k]));
}

// ---------------------------------------------------------------- reading the scene collection (read-only)
/**
 * Everything the choice needs, read from OBS: { canvas, program, scenes: [{ name, items }], groups: { name: items },
 * inputs: [{ name, kind }] }. An item: { id, index, source, enabled, isGroup, transform }.
 */
async function readCollection(link) {
  const [video, list, inputs] = await Promise.all([link.call('GetVideoSettings'), link.call('GetSceneList'), link.call('GetInputList')]);
  const item = (it) => ({ id: it.sceneItemId, index: it.sceneItemIndex, source: it.sourceName, enabled: it.sceneItemEnabled !== false, isGroup: it.isGroup === true, transform: it.sceneItemTransform || {} });
  const scenes = [], groups = {};
  for (const sc of list.scenes || []) {
    const r = await link.call('GetSceneItemList', { sceneName: sc.sceneName });
    const items = (r.sceneItems || []).map(item);
    scenes.push({ name: sc.sceneName, items });
    for (const it of items) {
      if (!it.isGroup || groups[it.source]) continue;
      try { groups[it.source] = ((await link.call('GetGroupSceneItemList', { sceneName: it.source })).sceneItems || []).map(item); }
      catch { groups[it.source] = []; }
    }
  }
  return {
    canvas: { w: Number(video.baseWidth) || 0, h: Number(video.baseHeight) || 0 },
    program: list.currentProgramSceneName || '',
    scenes, groups,
    inputs: (inputs.inputs || []).map((i) => ({ name: i.inputName, kind: kindOf(i) })),
  };
}

/**
 * Where a source shows: one entry per scene item of it (directly in a scene, or inside a group that sits in a scene).
 * { scene, anchorId (the item the avatar goes above: the camera item, or the group item), itemId, visible, box, view, inGroup }
 */
function placementsOf(col, sourceName) {
  const out = [];
  for (const sc of col.scenes) {
    for (const it of sc.items) {
      if (it.source === sourceName && !it.isGroup) {
        out.push({ scene: sc.name, anchorId: it.id, itemId: it.id, visible: it.enabled, box: itemBox(it.transform), view: viewOf(it.transform), inGroup: null, src: { w: it.transform.sourceWidth || 0, h: it.transform.sourceHeight || 0 } });
      } else if (it.isGroup) {
        for (const g of col.groups[it.source] || []) {
          if (g.source !== sourceName) continue;
          out.push({ scene: sc.name, anchorId: it.id, itemId: g.id, visible: it.enabled && g.enabled, box: groupedItemBox(g.transform, it.transform), view: viewOf(g.transform), inGroup: it.source, src: { w: g.transform.sourceWidth || 0, h: g.transform.sourceHeight || 0 } });
        }
      }
    }
  }
  return out;
}

/** The cameras he could mean: droidcam_obs inputs first, then other camera kinds; each with its placements. */
function cameraList(col) {
  const list = [];
  for (const kinds of [CAMERA_KINDS, OTHER_CAMERA_KINDS]) {
    for (const i of col.inputs) {
      if (!kinds.includes(i.kind)) continue;
      const placements = placementsOf(col, i.name);
      list.push({ name: i.name, kind: i.kind, placements, visibleScenes: new Set(placements.filter((p) => p.visible).map((p) => p.scene)).size });
    }
  }
  return list;
}

/** How much of the canvas a box covers (the part outside the canvas does not count). */
function onCanvas(box, canvas) {
  if (!canvas || !canvas.w || !canvas.h) return Math.max(0, box.w) * Math.max(0, box.h);
  const w = Math.min(canvas.w, box.x + box.w) - Math.max(0, box.x), h = Math.min(canvas.h, box.y + box.h) - Math.max(0, box.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The camera that is him. `wanted` = the camera kept from before (picked by hand, or picked by itself once and saved;
 * kept while that input still exists). Otherwise: the droidcam_obs input visible in the scene on air (the bigger box if
 * two); none there: the droidcam_obs input with the biggest box on the canvas in any scene (a tie: the box in the scene
 * with more in it, his show scene). Other camera kinds only when there is no droidcam_obs input at all: exactly one
 * = that one; more than one = { camera: null, why: 'ask' } (he is asked once in the VTuber window).
 * Returns { camera, why: 'chosen' | 'on-air' | 'biggest' | 'not-visible' | 'ask' } or null.
 */
function chooseCamera(col, wanted) {
  const all = cameraList(col);
  if (wanted) { const w = all.find((c) => c.name === wanted); if (w) return { camera: w, why: 'chosen' }; }
  const droid = all.filter((c) => CAMERA_KINDS.includes(c.kind));
  const pool = droid.length ? droid : all;
  if (!pool.length) return null;
  // No DroidCam and more than one other camera (a webcam AND a capture card are the same kind to OBS): the biggest box
  // on air may be the game, not him. Nothing is picked: the page asks once, and the answer is kept (`wanted`).
  if (!droid.length && pool.length > 1) return { camera: null, why: 'ask' };
  const area = (c) => Math.max(0, ...c.placements.filter((p) => p.visible && p.scene === col.program).map((p) => onCanvas(p.box, col.canvas)));
  const onAir = pool.filter((c) => area(c) > 0).sort((a, b) => area(b) - area(a));
  if (onAir.length) return { camera: onAir[0], why: 'on-air' };
  const sizeOf = (name) => { const sc = col.scenes.find((x) => x.name === name); return sc ? sc.items.length : 0; };
  const best = (c) => {
    let a = 0, n = 0;
    for (const p of c.placements) {
      if (!p.visible) continue;
      const v = onCanvas(p.box, col.canvas), k = sizeOf(p.scene);
      if (v > a * 1.02 || (v >= a * 0.98 && k > n)) { a = Math.max(a, v); n = k; }
    }
    return { a, n };
  };
  const ranked = pool.map((c) => ({ c, ...best(c) })).sort((x, y) => (Math.abs(x.a - y.a) > 0.02 * Math.max(x.a, y.a) ? y.a - x.a : y.n - x.n || y.c.visibleScenes - x.c.visibleScenes));
  return { camera: ranked[0].c, why: ranked[0].a > 0 ? 'biggest' : 'not-visible' };
}

/** The placement that decides how the picture is turned and how big the avatar page is drawn: on air first, else the biggest visible. */
function mainPlacement(col, camera) {
  const vis = camera.placements.filter((p) => p.visible);
  const air = vis.filter((p) => p.scene === col.program).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  if (air.length) return air[0];
  return vis.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0] || camera.placements[0] || null;
}

// ---------------------------------------------------------------- the avatar in OBS
function avatarSettings(url, size) {
  return { url, width: size.width, height: size.height, fps_custom: true, fps: 30, shutdown: false, restart_when_active: false, reroute_audio: false };
}

/**
 * Put the avatar above every VISIBLE placement of the camera; take it out of everywhere else. Idempotent: a second
 * call changes nothing. Returns { input, items: [{ scene, id }], size, added, removed } for the record file.
 * Throws ObsError; { code: 'name-taken' } when OBS already has a different thing called "VTuber Avatar".
 */
async function syncAvatar(link, col, camera, { url, on = false, ours = false }) {
  const main = mainPlacement(col, camera);
  // one avatar per scene: when the camera shows twice in a scene, the bigger box
  const targets = new Map();
  for (const p of camera.placements) {
    if (!p.visible) continue;
    const t = targets.get(p.scene);
    if (!t || p.box.w * p.box.h > t.box.w * t.box.h) targets.set(p.scene, p);
  }
  const size = main && main.visible ? renderSize(main.box) : { width: MAX_SHORT, height: MAX_LONG };
  const settings = avatarSettings(url, size);
  const exists = col.inputs.find((i) => i.name === AVATAR_INPUT);
  const existing = [];                                   // scene items of the avatar that are there now
  for (const sc of col.scenes) for (const it of sc.items) if (it.source === AVATAR_INPUT) existing.push({ scene: sc.name, id: it.id });
  let added = 0, removed = 0;
  if (exists) {
    const cur = await link.call('GetInputSettings', { inputName: AVATAR_INPUT });
    const had = String((cur.inputSettings || {}).url || '').split('?')[0];
    const mine = exists.kind === 'browser_source' && (ours || had === url.split('?')[0] || (isOwnAvatarUrl(had) && isOwnAvatarUrl(url)));
    if (!mine) { const e = new Error('OBS already has a different source called ' + AVATAR_INPUT); e.code = 'name-taken'; throw e; }
    if (Object.keys(settings).some((k) => (cur.inputSettings || {})[k] !== settings[k])) await link.call('SetInputSettings', { inputName: AVATAR_INPUT, inputSettings: settings, overlay: true });
  }
  const items = [];
  let created = !!exists;
  for (const [scene, p] of targets) {
    let mineHere = existing.filter((e) => e.scene === scene);
    for (const extra of mineHere.slice(1)) { await link.call('RemoveSceneItem', { sceneName: scene, sceneItemId: extra.id }); removed++; }
    let id = mineHere.length ? mineHere[0].id : null;
    if (id == null) {
      if (!created) {
        id = (await link.call('CreateInput', { sceneName: scene, inputName: AVATAR_INPUT, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: false })).sceneItemId;
        created = true;
      } else id = (await link.call('CreateSceneItem', { sceneName: scene, sourceName: AVATAR_INPUT, sceneItemEnabled: false })).sceneItemId;
      added++;
    }
    // directly above the camera (or above the group the camera sits in)
    const now = (await link.call('GetSceneItemList', { sceneName: scene })).sceneItems || [];
    const anchor = now.find((x) => x.sceneItemId === p.anchorId), me = now.find((x) => x.sceneItemId === id);
    if (anchor && me) {
      const want = me.sceneItemIndex > anchor.sceneItemIndex ? anchor.sceneItemIndex + 1 : anchor.sceneItemIndex;
      if (me.sceneItemIndex !== want) await link.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: id, sceneItemIndex: want });
      const tr = coverTransform(p.box, size);
      if (!sameTransform(me.sceneItemTransform || {}, tr)) await link.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: id, sceneItemTransform: tr });
      if ((me.sceneItemEnabled !== false) !== !!on) await link.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: id, sceneItemEnabled: !!on });
    }
    items.push({ scene, id });
  }
  for (const e of existing) {
    if (targets.has(e.scene)) continue;
    await link.call('RemoveSceneItem', { sceneName: e.scene, sceneItemId: e.id }); removed++;
  }
  return { input: created ? AVATAR_INPUT : null, items, size, added, removed };
}

/** Switch the avatar items on or off. Returns how many answered. Never throws (a scene he deleted is skipped). */
async function setAvatarEnabled(link, items, on) {
  let n = 0;
  await Promise.all((items || []).map((it) => link.call('SetSceneItemEnabled', { sceneName: it.scene, sceneItemId: it.id, sceneItemEnabled: !!on }).then(() => { n++; }, () => {})));
  return n;
}

/** "Remove VTuber from OBS": the items this app added, then the source itself. His scenes are as they were. */
async function removeAvatar(link, items) {
  for (const it of items || []) { try { await link.call('RemoveSceneItem', { sceneName: it.scene, sceneItemId: it.id }); } catch { /* already gone */ } }
  try { await link.call('RemoveInput', { inputName: AVATAR_INPUT }); } catch (e) { if (e.code !== 600) throw e; }
}

module.exports = {
  AVATAR_INPUT, CAMERA_KINDS, OTHER_CAMERA_KINDS, isOwnAvatarUrl, itemBox, groupedItemBox, viewOf, renderSize, coverTransform, readCollection, placementsOf, onCanvas,
  cameraList, chooseCamera, mainPlacement, syncAvatar, setAvatarEnabled, removeAvatar,
};
