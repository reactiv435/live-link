// TEST ONLY: a pretend OBS 32 (obs-websocket v5, password login) holding a scene collection LIKE THE OWNER'S, for the
// one-click VTuber (V3-ONE-CLICK.md). Nothing here ever talks to a real OBS.
//   - two droidcam_obs inputs (named "TEST DroidCam OBS", "TEST DroidCam OBS 2": never the real names, see tools/test-safety.cjs), a dshow_input "Webcam", a few plain sources
//   - "Full Cam left phone" (the scene on air): 29 items, a group "Group", and the second camera as its bottom item
//     (rotation 270 at 0,1920, scale 1 = the whole 1080x1920 canvas)
//   - rotation 90 and rotation 0 placements, hidden placements (reaction scenes), scenes without a camera
//   - the requests the app uses; as in the real obs-websocket, CreateSceneItem / RemoveSceneItem / GetSceneItemList
//     refuse a group, GetGroupSceneItemList refuses a scene
//   - OpenSourceProjector opens a real test window titled exactly as OBS 32 titles it ("Projector - Source: <name>",
//     480x270) that plays the test clip the way the raw camera would show it (lying on its side)
//   - GetSourceScreenshot serves the frames of the same raw picture (setVideo(name, file): that camera shows another clip,
//     e.g. a black or a frozen picture, for screenshots and for camera windows opened afterwards)
//   - a browser source "loads again" as in obs-browser when its url changes or its Refresh button is pressed
//     (PressInputPropertiesButton refreshnocache): reloads[] + onReload(name, url, why), for a stand-in page
//   - seedAvatar({ url, enabled }): the avatar left in OBS by an earlier run (as OBS saved it), for the OBS-first order
// In a test:   const { startMock } = await import('.../tracking/mock-obs-scenes.js'); const mock = await startMock({ port: 4477 });
// By hand:     node tracking/mock-obs-scenes.js --port 4477 [--video testdata/clip.mp4]
// Password: MOCK_OBS_PASSWORD or the `password` option (a test value; never the real one).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from './vendor/ws/wrapper.mjs';
const require = createRequire(import.meta.url);
const safety = require('../tools/test-safety.cjs');
/** the pretend cameras' names: never the bare names a real OBS on this PC uses (tools/test-safety.cjs) */
export const TEST_CAMERAS = safety.TEST_CAMERAS;

const here = path.dirname(fileURLToPath(import.meta.url));
const b64sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
export const projectorTitle = (sourceName) => 'Projector - Source: ' + sourceName;      // OBS 32: "Projector.Title" - "Source: %1"

// a plain grey 32 x 32 picture (JPEG), for a pretend OBS that carries no clip
const GREY_JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABKAAEAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAIAAgAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AAAAAAAAA/9k=';
const CANVAS = { w: 1080, h: 1920 };
const CAM = { w: 1920, h: 1080 };                       // both phones: a landscape picture, the owner lying on his side

function tf(sw, sh, o = {}) {
  const t = {
    alignment: 5, boundsAlignment: 0, boundsHeight: 0, boundsType: 'OBS_BOUNDS_NONE', boundsWidth: 0,
    cropBottom: 0, cropLeft: 0, cropRight: 0, cropToBounds: false, cropTop: 0,
    positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, sourceWidth: sw, sourceHeight: sh, ...o,
  };
  return t;
}
const withSize = (t) => ({ ...t, width: (t.sourceWidth - t.cropLeft - t.cropRight) * t.scaleX, height: (t.sourceHeight - t.cropTop - t.cropBottom) * t.scaleY });

/** The pretend scene collection. `groupCam` adds a scene whose camera sits INSIDE a group (the owner has none today). */
function buildCollection({ groupCam = false, cameras = TEST_CAMERAS } = {}) {
  const [CAM1, CAM2] = cameras;
  const inputs = new Map();
  const add = (name, kind, w, h, settings = {}) => inputs.set(name, { name, kind, w, h, settings });
  add(CAM1, 'droidcam_obs', CAM.w, CAM.h);
  add(CAM2, 'droidcam_obs', CAM.w, CAM.h);
  add('Webcam', 'dshow_input', 1280, 720);
  add('Mic/Aux', 'wasapi_input_capture', 0, 0);
  add('Desktop Audio', 'wasapi_output_capture', 0, 0);
  add('Alerts', 'browser_source', 800, 600, { url: 'https://example.invalid/alerts', width: 800, height: 600 });
  add('Logo', 'image_source', 400, 400);
  add('Title', 'text_gdiplus_v3', 600, 120);
  add('Chat', 'browser_source', 500, 900, { url: 'https://example.invalid/chat', width: 500, height: 900 });
  for (let i = 1; i <= 24; i++) add('Overlay ' + i, 'image_source', 300, 200);
  let nextId = 1;
  const scenes = new Map(), groups = new Map();
  const item = (source, o = {}, enabled = true) => {
    const s = inputs.get(source) || { w: o.gw || 0, h: o.gh || 0 };
    const { gw, gh, ...rest } = o;
    return { id: nextId++, source, enabled, locked: false, blend: 'OBS_BLEND_NORMAL', transform: tf(s.w || gw || 0, s.h || gh || 0, rest) };
  };
  const scene = (name, items) => scenes.set(name, { name, uuid: crypto.randomUUID(), items });     // items: bottom first
  const upright270 = { rotation: 270, positionX: 0, positionY: 1920 };                             // 1920x1080 turned: 0,0 1080x1920
  const upright90 = { rotation: 90, positionX: 1080, positionY: 0 };

  groups.set('Group', { name: 'Group', uuid: crypto.randomUUID(), items: [item('Logo', { positionX: 0, positionY: 0, scaleX: 0.5, scaleY: 0.5 }), item('Title', { positionX: 0, positionY: 220 })] });
  // the scene on air: the camera at the bottom, 27 other things and the group above it = 29 items
  const full = [item(CAM2, upright270)];
  for (let i = 1; i <= 12; i++) full.push(item('Overlay ' + i, { positionX: 40 * i, positionY: 60 * i }, i % 3 !== 0));
  full.push({ ...item('Group', { gw: 600, gh: 340, positionX: 240, positionY: 60 }), isGroup: true });
  for (let i = 13; i <= 24; i++) full.push(item('Overlay ' + i, { positionX: 20 * i, positionY: 1500 }, i % 4 !== 0));
  full.push(item('Alerts', { positionX: 140, positionY: 300 }), item('Chat', { positionX: 560, positionY: 980 }), item('Title', { positionX: 240, positionY: 1780 }));
  scene('Full Cam left phone', full);
  scene('deskroom PC control', [
    item(CAM1, { rotation: 90, positionX: 540, positionY: 0, scaleX: 0.5, scaleY: 0.5 }),              // 0,0 540x960
    item(CAM2, { rotation: 270, positionX: 540, positionY: 1920, scaleX: 0.5, scaleY: 0.5 }),        // 540,960 540x960
    item('Overlay 1', { positionX: 20, positionY: 1000 }), item('Chat', { positionX: 0, positionY: 1000 }),
  ]);
  scene('Desk Room Leader board', [item(CAM1, upright90), item('Alerts', { positionX: 100, positionY: 100 })]);
  scene('AD Site', [item('Logo'), item(CAM1, { positionX: 0, positionY: 656, scaleX: 0.5625, scaleY: 0.5625 }), item('Title', { positionX: 240, positionY: 80 })]);
  scene('Prize Wheel', [item(CAM1, upright90), item('Overlay 2', { positionX: 300, positionY: 700 })]);
  scene('Full Screen Podcast', [item(CAM1, { positionX: -420, positionY: 0, scaleX: 1.7778, scaleY: 1.7778 }), item('Title', { positionX: 240, positionY: 1700 })]);
  scene('Game play', [
    item('Webcam', { positionX: 0, positionY: 0 }, false),
    item(CAM2, { rotation: 90, positionX: 1080, positionY: 960, scaleX: 0.5, scaleY: 0.5 }),         // 540,960 540x960
    item(CAM1, { rotation: 90, positionX: 540, positionY: 960, scaleX: 0.5, scaleY: 0.5 }),            // 0,960 540x960
    item('Overlay 3', { positionX: 0, positionY: 0 }),
  ]);
  for (let i = 1; i <= 8; i++) {                         // reaction scenes: the cameras are there but HIDDEN
    scene('Reaction ' + i, [item(CAM2, upright270, false), item(CAM1, upright90, false), item('Overlay ' + (i + 3), { positionX: 0, positionY: 0 }), item('Alerts', { positionX: 140, positionY: 300 })]);
  }
  scene('Starting Soon', [item('Logo', { positionX: 340, positionY: 700 }), item('Title', { positionX: 240, positionY: 1200 })]);
  scene('BRB', [item('Logo', { positionX: 340, positionY: 700 })]);
  if (groupCam) {
    groups.set('Cam Group', { name: 'Cam Group', uuid: crypto.randomUUID(), items: [item(CAM2, { rotation: 270, positionX: 0, positionY: 960, scaleX: 0.5, scaleY: 0.5 }), item('Logo', { positionX: 0, positionY: 0, scaleX: 0.25, scaleY: 0.25 })] });
    scene('Grouped Cam', [item('Overlay 5'), { ...item('Cam Group', { gw: 540, gh: 960, positionX: 270, positionY: 480 }), isGroup: true }, item('Title', { positionX: 240, positionY: 80 })]);
  }
  return { inputs, scenes, groups, program: 'Full Cam left phone', nextId: () => nextId++ };
}

/**
 * startMock({ port, password, video, fps, delay, groupCam, projector ('virtual' = no real window), titlePrefix, quiet, cacheDir }) -> { port, close, snapshot, col, calls, projectors, setProgram, closeProjectors }
 * video: a clip, or a still picture (one frame, shown for ever), relative to this folder or a full path;
 *        false = no file at all: every camera shows a plain grey picture (V6: LIVE Link's tests carry no footage).
 * cacheDir: where the frames cut from the clip are kept (default: testdata/ beside this file).
 */
export async function startMock(opts = {}) {
  const port = Number(opts.port) || 4477;
  if (port === 4455) throw new Error('4455 is the real OBS; the mock never uses it');
  const password = opts.password || process.env.MOCK_OBS_PASSWORD || 'mock-test-password';
  const noVideo = opts.video === false;
  const video = noVideo ? '' : path.resolve(here, opts.video || 'testdata/clip.mp4');
  const fps = Number(opts.fps) || 30, delayMs = opts.delay === undefined ? 10 : Number(opts.delay);
  const openProjectors = opts.projector !== false;      // false = OpenSourceProjector fails (the app must fall back)
  // cameras: [first phone, second phone]. The default names start with "TEST ": the owner's real OBS camera window can be
  // open on this PC. A mock that opens REAL windows takes no other names and does not start beside a real camera window.
  const cameras = Array.isArray(opts.cameras) && opts.cameras.length === 2 ? opts.cameras.map(String) : TEST_CAMERAS;
  const realWindows = opts.projector !== false && opts.projector !== 'virtual';
  if (realWindows) {
    safety.assertTestCameraNames(cameras);
    await safety.assertNoForeignProjector(opts.listWindows || require('../win-windows.js').listWindows);
  }
  const [CAM1, CAM2] = cameras;
  const col = buildCollection({ groupCam: !!opts.groupCam, cameras });
  const calls = [];                                     // every request type received, in order
  const projectors = [];                                // { name, title, proc }
  const cacheRoot = opts.cacheDir ? path.resolve(opts.cacheDir) : path.join(here, 'testdata');
  const t0 = Date.now();

  // the raw picture of a camera = the upright test clip turned back the way that camera lies in the scene on air
  const rawTurn = (name) => (name === CAM1 ? 90 : name === CAM2 ? 270 : 0);
  const undo = (rot) => (rot === 90 ? ['transpose=2'] : rot === 270 ? ['transpose=1'] : []);
  const frameSets = new Map();
  const videos = new Map();                             // a camera showing another clip than the test clip
  const videoOf = (name) => videos.get(name) || video;
  const widths = new Map();                             // the picture widths asked for each camera (to make a clip's frames early)
  function framesFor(name, width, v = videoOf(name)) {
    width = Math.max(64, Math.min(1920, Math.round(width / 2) * 2));
    if (!widths.has(name)) widths.set(name, new Set());
    widths.get(name).add(width);
    const rot = rawTurn(name), key = v + '|' + rot + '_' + width;
    if (frameSets.has(key)) return frameSets.get(key);
    const dir = path.join(cacheRoot, 'frames_' + path.basename(v, path.extname(v)) + (rot ? '_r' + rot + '_fnone_c0-0-0-0' : '') + '_' + width);
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
      fs.mkdirSync(dir, { recursive: true });
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', v, '-vf', ['fps=' + fps, ...undo(rot), 'scale=' + width + ':-2'].join(','), '-q:v', '4', path.join(dir, '%05d.jpg')], { stdio: 'ignore' });
      if (r.status !== 0) return [];
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
    frameSets.set(key, files);
    return files;
  }
  /** The clip as the raw camera shows it (lying on its side), for the pretend projector window. Made once, kept in testdata. */
  function rawVideo(name) {
    const v = videoOf(name), rot = rawTurn(name);
    if (!rot) return v;
    const out = path.join(cacheRoot, 'raw_' + path.basename(v, path.extname(v)) + '_r' + rot + '.mp4');
    if (!fs.existsSync(out)) {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', v, '-vf', undo(rot).join(','), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out], { stdio: 'ignore' });
      if (r.status !== 0) return v;
    }
    return out;
  }
  // a browser source loads its page again (obs-browser: a new url, or its Refresh button)
  const reloads = [];
  const api = { onReload: null, meter: null, metersSent: 0 };
  const reload = (name, url, why) => { reloads.push({ name, url, why, at: Date.now() }); if (api.onReload) { try { api.onReload(name, url, why); } catch { /* the test's problem */ } } };
  if (!noVideo && !fs.existsSync(video)) throw new Error('test video not found: ' + video);
  if (noVideo && realWindows) throw new Error('a pretend OBS with no clip opens no real camera window: use projector \'virtual\'');

  const view = (it, index) => {
    const src = col.inputs.get(it.source);
    return {
      inputKind: it.isGroup ? null : src ? src.kind : null, isGroup: it.isGroup ? true : null, sceneItemBlendMode: it.blend, sceneItemEnabled: it.enabled,
      sceneItemId: it.id, sceneItemIndex: index, sceneItemLocked: it.locked, sceneItemTransform: withSize(it.transform), sourceName: it.source,
      sourceType: it.isGroup ? 'OBS_SOURCE_TYPE_SCENE' : 'OBS_SOURCE_TYPE_INPUT', sourceUuid: 'mock-' + it.source,
    };
  };
  const holder = (rd, filter) => {                    // filter: 'scene' | 'group' | 'any'
    const name = rd.sceneName;
    if (filter !== 'group' && col.scenes.has(name)) return col.scenes.get(name);
    if (filter !== 'scene' && col.groups.has(name)) return col.groups.get(name);
    if (col.scenes.has(name) || col.groups.has(name)) return { err: [602, 'The specified source is not a ' + (filter === 'group' ? 'group' : 'scene') + '.'] };
    return { err: [600, 'No source was found by the name of `' + name + '`.'] };
  };
  const findItem = (h, id) => h.items.findIndex((x) => x.id === id);

  function handle(type, rd) {
    switch (type) {
      case 'GetVersion': return { obsVersion: '32.1.1', obsWebSocketVersion: '5.6.3', rpcVersion: 1, platform: 'mock' };
      case 'GetVideoSettings': return { baseWidth: CANVAS.w, baseHeight: CANVAS.h, outputWidth: CANVAS.w, outputHeight: CANVAS.h, fpsNumerator: 30, fpsDenominator: 1 };
      case 'GetSceneList': {
        const names = [...col.scenes.keys()];
        return { currentProgramSceneName: col.program, currentProgramSceneUuid: col.scenes.get(col.program).uuid, currentPreviewSceneName: null, currentPreviewSceneUuid: null,
          scenes: names.map((n, i) => ({ sceneIndex: names.length - 1 - i, sceneName: n, sceneUuid: col.scenes.get(n).uuid })).reverse() };
      }
      case 'GetCurrentProgramScene': return { sceneName: col.program, sceneUuid: col.scenes.get(col.program).uuid, currentProgramSceneName: col.program, currentProgramSceneUuid: col.scenes.get(col.program).uuid };
      case 'SetCurrentProgramScene': if (!col.scenes.has(rd.sceneName)) return { err: [600, 'No such scene.'] }; col.program = rd.sceneName; return {};
      case 'GetInputList': return { inputs: [...col.inputs.values()].filter((i) => !rd.inputKind || i.kind === rd.inputKind).map((i) => ({ inputName: i.name, inputKind: i.kind, unversionedInputKind: i.kind.replace(/_v\d+$/, ''), inputUuid: 'mock-' + i.name })) };
      case 'GetInputSettings': { const i = col.inputs.get(rd.inputName); return i ? { inputKind: i.kind, inputSettings: { ...i.settings } } : { err: [600, 'No source was found by the name of `' + rd.inputName + '`.'] }; }
      case 'SetInputSettings': {
        const i = col.inputs.get(rd.inputName);
        if (!i) return { err: [600, 'No source was found by the name of `' + rd.inputName + '`.'] };
        const oldUrl = i.settings.url;
        i.settings = rd.overlay === false ? { ...rd.inputSettings } : { ...i.settings, ...rd.inputSettings };
        if (i.kind === 'browser_source') { i.w = Number(i.settings.width) || i.w; i.h = Number(i.settings.height) || i.h; refit(i); if (i.settings.url !== oldUrl) reload(i.name, i.settings.url, 'url'); }
        return {};
      }
      case 'PressInputPropertiesButton': {
        const i = col.inputs.get(rd.inputName);
        if (!i) return { err: [600, 'No source was found by the name of `' + rd.inputName + '`.'] };
        if (i.kind !== 'browser_source' || !['refreshnocache', 'refresh'].includes(rd.propertyName)) return { err: [600, 'Unable to find a property by that name.'] };
        reload(i.name, i.settings.url, rd.propertyName);
        return {};
      }
      case 'CreateInput': {
        const h = holder(rd, 'scene'); if (h.err) return h;
        if (col.inputs.has(rd.inputName) || col.scenes.has(rd.inputName) || col.groups.has(rd.inputName)) return { err: [601, 'A source already exists by that input name.'] };
        if (!['browser_source', 'image_source', 'color_source_v3'].includes(rd.inputKind)) return { err: [605, 'Your specified input kind is not supported by OBS (mock).'] };
        const s = rd.inputSettings || {};
        col.inputs.set(rd.inputName, { name: rd.inputName, kind: rd.inputKind, w: Number(s.width) || 800, h: Number(s.height) || 600, settings: { ...s } });
        const it = { id: col.nextId(), source: rd.inputName, enabled: rd.sceneItemEnabled !== false, locked: false, blend: 'OBS_BLEND_NORMAL', transform: tf(Number(s.width) || 800, Number(s.height) || 600) };
        h.items.push(it);
        return { inputUuid: 'mock-' + rd.inputName, sceneItemId: it.id };
      }
      case 'RemoveInput': {
        if (!col.inputs.has(rd.inputName)) return { err: [600, 'No source was found by the name of `' + rd.inputName + '`.'] };
        col.inputs.delete(rd.inputName);
        for (const h of [...col.scenes.values(), ...col.groups.values()]) h.items = h.items.filter((x) => x.source !== rd.inputName);
        return {};
      }
      case 'GetSceneItemList': { const h = holder(rd, 'scene'); return h.err ? h : { sceneItems: h.items.map(view) }; }
      case 'GetGroupSceneItemList': { const h = holder(rd, 'group'); return h.err ? h : { sceneItems: h.items.map(view) }; }
      case 'GetSceneItemId': {
        const h = holder(rd, 'any'); if (h.err) return h;
        const it = h.items.find((x) => x.source === rd.sourceName);
        return it ? { sceneItemId: it.id } : { err: [600, 'No scene items were found in the specified scene by that name or offset.'] };
      }
      case 'CreateSceneItem': {
        const h = holder(rd, 'scene'); if (h.err) return h;
        const src = col.inputs.get(rd.sourceName);
        if (!src) return { err: [600, 'No source was found by the name of `' + rd.sourceName + '`.'] };
        const it = { id: col.nextId(), source: rd.sourceName, enabled: rd.sceneItemEnabled !== false, locked: false, blend: 'OBS_BLEND_NORMAL', transform: tf(src.w, src.h) };
        h.items.push(it);
        return { sceneItemId: it.id };
      }
      case 'RemoveSceneItem': {
        const h = holder(rd, 'scene'); if (h.err) return h;
        const k = findItem(h, rd.sceneItemId); if (k < 0) return { err: [600, 'No scene items were found in the specified scene by that ID.'] };
        h.items.splice(k, 1);
        return {};
      }
      case 'GetSceneItemTransform': case 'GetSceneItemEnabled': case 'GetSceneItemIndex': case 'SetSceneItemTransform': case 'SetSceneItemEnabled': case 'SetSceneItemIndex': {
        const h = holder(rd, 'any'); if (h.err) return h;
        const k = findItem(h, rd.sceneItemId); if (k < 0) return { err: [600, 'No scene items were found in the specified scene by that ID.'] };
        const it = h.items[k];
        if (type === 'GetSceneItemTransform') return { sceneItemTransform: withSize(it.transform) };
        if (type === 'GetSceneItemEnabled') return { sceneItemEnabled: it.enabled };
        if (type === 'GetSceneItemIndex') return { sceneItemIndex: k };
        if (type === 'SetSceneItemEnabled') { it.enabled = rd.sceneItemEnabled === true; return {}; }
        if (type === 'SetSceneItemIndex') {
          const to = Math.max(0, Math.min(h.items.length - 1, Number(rd.sceneItemIndex) || 0));
          h.items.splice(k, 1); h.items.splice(to, 0, it);
          return {};
        }
        const t = rd.sceneItemTransform || {};
        for (const key of Object.keys(t)) if (key in it.transform && key !== 'sourceWidth' && key !== 'sourceHeight') it.transform[key] = t[key];
        return {};
      }
      case 'OpenSourceProjector': {
        const src = col.inputs.get(rd.sourceName);
        if (!src) return { err: [600, 'No source was found by the name of `' + rd.sourceName + '`.'] };
        if (!openProjectors) return { err: [702, 'Could not open the projector (mock, switched off for this test).'] };
        if (rd.monitorIndex !== undefined && rd.monitorIndex !== -1) return { err: [402, 'The mock only opens windowed projectors (monitorIndex -1).'] };
        const title = (opts.titlePrefix || 'Projector - Source: ') + rd.sourceName;   // titlePrefix: a full-chain run on a PC where the real OBS runs too
        if (opts.projector === 'virtual') { projectors.push({ name: rd.sourceName, title, proc: null, open: true }); return {}; }   // node tests: no real window
        const at = opts.projectorAt || { left: 40 + 30 * projectors.length, top: 620, w: 480, h: 270 };   // projectorAt: where the test window goes
        const proc = spawn('ffplay', ['-hide_banner', '-loglevel', 'error', '-window_title', title, '-loop', '0', '-an', '-x', String(at.w || 480), '-y', String(at.h || 270), '-left', String(at.left), '-top', String(at.top), rawVideo(rd.sourceName)], { stdio: 'ignore', env: { ...process.env, SDL_WINDOW_NO_ACTIVATION_WHEN_SHOWN: '1' } });
        const p = { name: rd.sourceName, title, proc, open: true };
        proc.on('exit', () => { p.open = false; });
        projectors.push(p);
        return {};
      }
      default: return undefined;
    }
  }
  /** a browser source changed its size: every item of it reports the new source size (as OBS does) */
  function refit(input) {
    for (const h of [...col.scenes.values(), ...col.groups.values()]) for (const it of h.items) if (it.source === input.name) { it.transform.sourceWidth = input.w; it.transform.sourceHeight = input.h; }
  }

  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
  let logins = 0, refused = 0;
  wss.on('connection', (ws) => {
    const salt = crypto.randomBytes(16).toString('base64'), challenge = crypto.randomBytes(16).toString('base64');
    let identified = false;
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1, authentication: { challenge, salt } } }));
    const respond = (d, res) => {
      if (ws.readyState !== 1) return;
      const out = { requestType: d.requestType, requestId: d.requestId, requestStatus: res && res.err ? { result: false, code: res.err[0], comment: res.err[1] } : { result: true, code: 100 } };
      if (!res || !res.err) out.responseData = res || {};
      ws.send(JSON.stringify({ op: 7, d: out }));
    };
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(4002, 'bad json'); return; }
      const d = msg.d || {};
      if (msg.op === 1) {
        if (d.authentication !== b64sha(b64sha(password + salt) + challenge)) { refused++; ws.close(4009, 'Authentication failed.'); return; }
        identified = true; logins++;
        ws.subs = Number(d.eventSubscriptions) || 0;
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (msg.op === 3) { if (identified) { ws.subs = Number(d.eventSubscriptions) || 0; ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); } return; }
      if (msg.op !== 6) return;
      if (!identified) { ws.close(4007, 'Not identified.'); return; }
      const rd = d.requestData || {};
      calls.push(d.requestType);
      if (d.requestType === 'GetSourceScreenshot') {
        if (!col.inputs.has(rd.sourceName)) { respond(d, { err: [600, 'No source was found by that name.'] }); return; }
        if (noVideo && !videos.has(rd.sourceName)) { setTimeout(() => respond(d, { imageData: 'data:image/jpeg;base64,' + GREY_JPEG }), delayMs); return; }
        const files = framesFor(rd.sourceName, rd.imageWidth || 640);
        if (!files.length) { respond(d, { err: [702, 'Failed to render screenshot.'] }); return; }
        const idx = Math.floor((Date.now() - t0) * fps / 1000) % files.length;
        setTimeout(() => fs.readFile(files[idx], (err, buf) => respond(d, err ? { err: [702, 'Failed to render screenshot.'] } : { imageData: 'data:image/jpeg;base64,' + buf.toString('base64') })), delayMs);
        return;
      }
      const res = handle(d.requestType, rd);
      respond(d, res === undefined ? { err: [204, 'Unknown request type (mock).'] } : res);
    });
    ws.on('error', () => {});
  });

  // the sound meters (obs-websocket InputVolumeMeters, 20 a second) for the pages that asked: api.meter(tMs) -> the level
  // of "Desktop Audio" as a multiplier (0..1), or null = no meters. Only sent when a test sets api.meter.
  const meterTimer = setInterval(() => {
    if (!api.meter) return;
    const v = api.meter(Date.now() - t0);
    if (v === null || v === undefined) return;
    const text = JSON.stringify({ op: 5, d: { eventType: 'InputVolumeMeters', eventIntent: 65536, eventData: { inputs: [
      { inputName: 'Desktop Audio', inputUuid: 'mock-Desktop Audio', inputLevelsMul: [[v * 0.7, v, v], [v * 0.7, v, v]] },
      { inputName: 'Mic/Aux', inputUuid: 'mock-Mic/Aux', inputLevelsMul: [[0.2, 0.3, 0.3]] }] } } });
    for (const c of wss.clients) if (c.readyState === 1 && (c.subs & 65536)) { try { c.send(text); api.metersSent++; } catch { /* gone */ } }
  }, 50);
  meterTimer.unref();
  /** The whole scene collection as plain data, for a before / after comparison. */
  const snapshot = () => JSON.parse(JSON.stringify({
    program: col.program,
    inputs: [...col.inputs.values()],
    scenes: [...col.scenes.values()].map((s) => ({ name: s.name, items: s.items })),
    groups: [...col.groups.values()].map((g) => ({ name: g.name, items: g.items })),
  }));
  const closeProjectors = () => { for (const p of projectors) { p.open = false; try { if (p.proc) p.proc.kill(); } catch { /* gone */ } } };
  const close = () => new Promise((res) => {
    closeProjectors(); clearInterval(meterTimer);
    for (const c of wss.clients) { try { c.terminate(); } catch { /* gone */ } }
    wss.close(() => res());
  });
  /** The avatar an earlier run left in OBS: the browser source and one item directly above each visible placement of the camera. */
  function seedAvatar({ name = 'VTuber Avatar', url, enabled = false, camera = CAM2, width = 720, height = 1280 } = {}) {
    col.inputs.set(name, { name, kind: 'browser_source', w: width, h: height, settings: { url, width, height, fps_custom: true, fps: 30, shutdown: false, restart_when_active: false, reroute_audio: false } });
    for (const sc of col.scenes.values()) {
      const k = sc.items.findIndex((it) => it.source === camera && it.enabled);
      if (k < 0) continue;
      sc.items.splice(k + 1, 0, { id: col.nextId(), source: name, enabled, locked: false, blend: 'OBS_BLEND_NORMAL', transform: tf(width, height) });
    }
  }
  return Object.assign(api, {
    port, password, close, snapshot, col, calls, projectors, closeProjectors, cameras, t0, fps, video, reloads, seedAvatar,
    stats: () => ({ logins, refused }), setProgram: (name) => { col.program = name; },
    setVideo: (name, file) => { if (file) videos.set(name, path.resolve(file)); else videos.delete(name); },
    /** make a clip's frames for a camera now (at the widths asked so far), so a later setVideo does not stall the mock */
    warmVideo: (name, file) => { for (const w of widths.get(name) || []) framesFor(name, w, path.resolve(file)); },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
  const mock = await startMock({ port: Number(arg('port', 4477)), video: arg('video', undefined), groupCam: arg('groupcam', '0') === '1', projector: arg('projector', '1') !== '0' });
  console.log('mock OBS (owner-like scene collection) on ws://127.0.0.1:' + mock.port);
  const stop = () => { mock.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
