'use strict';
// V9: the VTuber window opens at the one-screen control deck's size, 1366 x 768 (it was 600 x 940, which the deck
// draws stacked: below 1000 wide). Always clamped to the primary display's work area (a smaller screen never gets a
// window bigger than itself), never below about 1000 x 640 (unless the screen itself is smaller). A size he chose
// himself is kept (saved when he resizes it, size only, never the place); a saved size that is the old 600 x 940
// default, smaller than 1000 x 640, or not a sane whole number gets the new default instead.
// Fix round 1: every size is the PAGE's (useContentSize: the deck measures its page, it stacks under 1000 px of page
// width), clamped to the work area MINUS the frame around the page; the saved size is the page's too; it is saved on
// 'close' AND right before every destroy() (LIVE Link quitting with the window open, the VTuber process ending, its
// page crashing or not loading: destroy() skips 'close').
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { vtuberWindowSize, cleanVtuberSize, vtSizeToSave, fitVtuberWindow, VT_WINDOW, VT_WINDOW_MIN, VT_WINDOW_OLD } = require('../src/core/vtuber-window');

const FHD = { x: 0, y: 0, width: 1920, height: 1040 };         // 1920 x 1080 with the taskbar
const LAPTOP = { x: 0, y: 0, width: 1366, height: 728 };       // 1366 x 768 with the taskbar
const size = (o) => { const r = vtuberWindowSize(o); return [r.width, r.height, r.minWidth, r.minHeight]; };

test('the numbers: the deck size, the minimum, the old default', () => {
  assert.deepEqual({ ...VT_WINDOW }, { width: 1366, height: 768 });
  assert.deepEqual({ ...VT_WINDOW_MIN }, { width: 1000, height: 640 });
  assert.deepEqual({ ...VT_WINDOW_OLD }, { width: 600, height: 940 });
});

test('nothing saved: 1366 x 768, clamped to the work area, minimum 1000 x 640 (or the screen, if smaller)', () => {
  assert.deepEqual(size({ workArea: FHD }), [1366, 768, 1000, 640]);
  assert.deepEqual(size({ workArea: LAPTOP }), [1366, 728, 1000, 640], 'a 1366 x 768 laptop: the window fits above the taskbar');
  assert.deepEqual(size({ workArea: { x: 0, y: 0, width: 1280, height: 680 } }), [1280, 680, 1000, 640]);
  assert.deepEqual(size({ workArea: { x: 0, y: 0, width: 960, height: 600 } }), [960, 600, 960, 600], 'a screen smaller than the minimum: the screen wins');
  assert.deepEqual(size({ workArea: { x: 0, y: 0, width: 2560.6, height: 1392.4 } }), [1366, 768, 1000, 640], 'scaled displays report fractions');
  assert.deepEqual(size({ workArea: { x: 0, y: 0, width: 1500.7, height: 700.9 } }), [1366, 700, 1000, 640], 'clamped down to whole pixels');
  // a broken work area (never seen, but never a broken window): the deck size as it is
  for (const workArea of [undefined, null, {}, { width: 0, height: 0 }, { width: NaN, height: 768 }, { width: -5, height: 900 }]) {
    assert.deepEqual(size({ workArea }), [1366, 768, 1000, 640], JSON.stringify(workArea));
  }
  assert.deepEqual(size(), [1366, 768, 1000, 640]);
  assert.equal(vtuberWindowSize({ workArea: FHD }).saved, false);
});

test('a saved size: the old 600 x 940 default or anything under 1000 x 640 gets the new default; a size he chose himself is kept', () => {
  assert.deepEqual(size({ workArea: FHD, saved: { width: 600, height: 940 } }), [1366, 768, 1000, 640], 'the old default');
  assert.equal(vtuberWindowSize({ workArea: FHD, saved: { width: 600, height: 940 } }).saved, false);
  assert.deepEqual(size({ workArea: FHD, saved: { width: 999, height: 900 } }), [1366, 768, 1000, 640], 'too narrow');
  assert.deepEqual(size({ workArea: FHD, saved: { width: 1400, height: 639 } }), [1366, 768, 1000, 640], 'too low');
  assert.deepEqual(size({ workArea: FHD, saved: { width: 340, height: 480 } }), [1366, 768, 1000, 640], "2.3.1's smallest window");
  // his own sizes
  assert.deepEqual(size({ workArea: FHD, saved: { width: 1600, height: 900 } }), [1600, 900, 1000, 640]);
  assert.equal(vtuberWindowSize({ workArea: FHD, saved: { width: 1600, height: 900 } }).saved, true);
  assert.deepEqual(size({ workArea: FHD, saved: { width: 1000, height: 640 } }), [1000, 640, 1000, 640], 'exactly the minimum is his choice');
  assert.deepEqual(size({ workArea: FHD, saved: { width: 1366, height: 1000 } }), [1366, 1000, 1000, 640]);
  // extra fields (a whole bounds object) are fine: only the size is read
  assert.deepEqual(size({ workArea: FHD, saved: { x: -3000, y: 5000, width: 1200, height: 700 } }), [1200, 700, 1000, 640]);
});

test('a saved size is clamped to the CURRENT work area on every open (another monitor, a lower resolution)', () => {
  const big = { width: 2400, height: 1350 };   // chosen on a 1440p monitor
  assert.deepEqual(size({ workArea: { x: 0, y: 0, width: 2560, height: 1400 }, saved: big }), [2400, 1350, 1000, 640]);
  assert.deepEqual(size({ workArea: FHD, saved: big }), [1920, 1040, 1000, 640], 'back on 1920 x 1080');
  assert.deepEqual(size({ workArea: LAPTOP, saved: big }), [1366, 728, 1000, 640], 'on the laptop');
  assert.deepEqual(size({ workArea: { x: 0, y: 0, width: 960, height: 600 }, saved: big }), [960, 600, 960, 600]);
});

test('a bad saved value never breaks the window: anything but sane whole numbers is ignored', () => {
  const bad = [null, undefined, 'x', 1366, [1366, 768], { width: '1366', height: '768' }, { width: 1366 }, { height: 768 },
    { width: NaN, height: 768 }, { width: Infinity, height: 768 }, { width: 1366.5, height: 768 }, { width: 1366, height: -768 },
    { width: 0, height: 0 }, { width: 1e9, height: 768 }, { width: 1366, height: 20000 }, { width: true, height: 768 },
    Object.create({ width: 1366, height: 768 })];
  for (const saved of bad) {
    assert.equal(cleanVtuberSize(saved), null, JSON.stringify(saved));
    assert.deepEqual(size({ workArea: FHD, saved }), [1366, 768, 1000, 640], JSON.stringify(saved));
  }
  assert.deepEqual(cleanVtuberSize({ width: 1600, height: 900, x: 4, y: 9 }), { width: 1600, height: 900 }, 'only the size is kept');
  assert.deepEqual(cleanVtuberSize({ width: 16384, height: 16384 }), { width: 16384, height: 16384 });
  assert.equal(cleanVtuberSize({ width: 16385, height: 900 }), null);
});

// ---------------------------------------------------------------- fix round 1: the page, the frame, every way it closes
const WIN_FRAME = { width: 16, height: 39 };   // a framed window on Windows 10/11: borders + title bar around the page
const MAC_FRAME = { width: 0, height: 28 };

// a stand-in BrowserWindow, made with useContentSize: true at `content` (the page); destroy() emits no 'close' (Electron)
function fakeWindow({ content = [1366, 768], frame = WIN_FRAME } = {}) {
  const w = new EventEmitter();
  w.page = [...content]; w.normal = null; w.min = null; w.calls = []; w.destroyed = false;
  w.getContentSize = () => [...w.page];
  w.getContentBounds = () => ({ x: 8, y: 31, width: w.page[0], height: w.page[1] });
  w.getBounds = () => ({ x: 0, y: 0, width: w.page[0] + frame.width, height: w.page[1] + frame.height });
  w.getNormalBounds = () => w.normal || w.getBounds();
  w.setContentSize = (a, b) => { w.page = [a, b]; w.calls.push(['setContentSize', a, b]); };
  w.setMinimumSize = (a, b) => { w.min = [a, b]; w.calls.push(['setMinimumSize', a, b]); };
  w.center = () => { w.calls.push(['center']); };
  w.isDestroyed = () => w.destroyed;
  w.destroy = () => { w.destroyed = true; w.calls.push(['destroy']); };
  w.close = () => { w.emit('close', {}); w.destroyed = true; };
  w.drag = (a, b) => { w.page = [a, b]; w.emit('resized'); };   // he drags the window's edge
  return w;
}
function memStore() { const data = {}; return { data, sets: 0, get(k) { return data[k]; }, set(k, v) { this.sets++; data[k] = v; } }; }
// what main.js does: the page size first (no frame known yet), the window made at it, then fitted
function open({ workArea = FHD, store = memStore(), testRun = false, frame = WIN_FRAME } = {}) {
  const o = { workArea, saved: store.get('vtuberSize'), store, testRun };
  const first = vtuberWindowSize(o);
  const w = fakeWindow({ content: [first.width, first.height], frame });
  const fit = fitVtuberWindow(w, o);
  return { w, fit, store };
}

test('the frame: the page fits the work area MINUS the frame; the minimum is the page\'s', () => {
  const sz = (o) => { const r = vtuberWindowSize(o); return [r.width, r.height, r.minWidth, r.minHeight]; };
  assert.deepEqual(sz({ workArea: FHD, frame: WIN_FRAME }), [1366, 768, 1000, 640], 'a 1920 x 1080 PC: the full deck page');
  assert.deepEqual(sz({ workArea: LAPTOP, frame: WIN_FRAME }), [1350, 689, 1000, 640], 'a 1366 x 768 laptop: page + frame = the work area');
  assert.deepEqual(sz({ workArea: { x: 0, y: 0, width: 960, height: 600 }, frame: WIN_FRAME }), [944, 561, 944, 561]);
  assert.deepEqual(sz({ workArea: { x: 0, y: 0, width: 1440, height: 875 }, frame: MAC_FRAME }), [1366, 768, 1000, 640], 'a 1440 x 900 Mac');
  assert.deepEqual(sz({ workArea: FHD, saved: { width: 2400, height: 1350 }, frame: WIN_FRAME }), [1904, 1001, 1000, 640], 'his big size on a smaller screen');
  for (const frame of [undefined, null, {}, { width: -5, height: NaN }, { width: 'x', height: 39 }]) {
    assert.deepEqual(sz({ workArea: FHD, frame }), [1366, 768, 1000, 640], JSON.stringify(frame));
  }
});

test('fitVtuberWindow: measures the frame; shrinks the page only when page + frame is bigger than the work area; the window minimum = the page minimum + the frame', () => {
  let { w, fit } = open();
  assert.deepEqual(fit.frame, WIN_FRAME);
  assert.deepEqual(w.page, [1366, 768], 'fits: the page stays the deck size');
  assert.ok(!w.calls.some((c) => c[0] === 'setContentSize'));
  assert.deepEqual(w.min, [1016, 679], 'the page can never go under 1000 x 640');

  ({ w } = open({ workArea: LAPTOP }));
  assert.deepEqual(w.page, [1350, 689]);
  assert.deepEqual(w.calls.slice(0, 2), [['setContentSize', 1350, 689], ['center']]);
  assert.deepEqual(w.min, [1016, 679]);

  ({ w } = open({ workArea: { x: 0, y: 0, width: 960, height: 600 } }));
  assert.deepEqual([w.page, w.min], [[944, 561], [960, 600]], 'a tiny screen: the screen wins');

  ({ w } = open({ frame: MAC_FRAME }));
  assert.deepEqual([w.page, w.min], [[1366, 768], [1000, 668]]);

  // a test run keeps its small window as it is
  ({ w } = open({ testRun: true }));
  assert.deepEqual(w.calls, []);
  // a window that cannot be measured never breaks the open
  const bad = fakeWindow(); bad.getBounds = () => { throw new Error('gone'); };
  assert.doesNotThrow(() => fitVtuberWindow(bad, { workArea: FHD }));
});

test('his size is the PAGE size, saved only when he resized it, through the store; reopening gives the same page (it never grows by the frame)', () => {
  const store = memStore();
  let { w } = open({ store });
  w.close();
  assert.equal(store.sets, 0, 'he did not resize it: nothing saved');

  ({ w } = open({ store }));
  w.drag(1500, 900);
  w.close();
  assert.deepEqual(store.data.vtuberSize, { width: 1500, height: 900 }, 'the page, not 1516 x 939');

  for (let i = 0; i < 3; i++) {   // open, nudge, close, three times: the same page every time
    ({ w } = open({ store }));
    assert.deepEqual(w.page, [1500, 900]);
    w.drag(1500, 900); w.close();
  }
  assert.deepEqual(store.data.vtuberSize, { width: 1500, height: 900 });

  // maximized when it closes: the size he gave it before (getNormalBounds), never the maximized one
  ({ w } = open({ store }));
  w.drag(1700, 950);
  w.normal = { x: 10, y: 10, width: 1700 + 16, height: 950 + 39 }; w.page = [1904, 1001];
  w.close();
  assert.deepEqual(store.data.vtuberSize, { width: 1700, height: 950 });

  // a test run never saves
  const t = memStore();
  ({ w } = open({ store: t, testRun: true }));
  w.drag(1500, 900); w.close();
  assert.equal(t.sets, 0);
  // a store that throws never breaks closing
  const broken = { get: () => null, set: () => { throw new Error('disk full'); } };
  ({ w } = open({ store: broken }));
  w.drag(1500, 900);
  assert.doesNotThrow(() => w.close());
});

test('every way the window goes away saves his size first: destroy() (LIVE Link quitting with it open, the VTuber process ending, its page crashing / not loading) skips "close"', () => {
  const store = memStore();
  const { w, fit } = open({ store });
  w.drag(1440, 820);
  fit.destroy();                                        // what main.js destroyVtWin does on all three paths
  assert.deepEqual(store.data.vtuberSize, { width: 1440, height: 820 });
  assert.deepEqual(w.calls[w.calls.length - 1], ['destroy']);
  assert.equal(w.destroyed, true);
  assert.doesNotThrow(() => fit.destroy(), 'twice: nothing happens');
  assert.equal(store.sets, 1);
  // not resized: destroyed, nothing saved
  const s2 = memStore(), o2 = open({ store: s2 });
  o2.fit.destroy();
  assert.equal(s2.sets, 0);
  assert.equal(o2.w.destroyed, true);
  // the decision itself
  assert.deepEqual(vtSizeToSave({ resized: true, normalBounds: { width: 1516, height: 939 }, frame: WIN_FRAME }), { width: 1500, height: 900 });
  assert.equal(vtSizeToSave({ resized: false, normalBounds: { width: 1516, height: 939 }, frame: WIN_FRAME }), null);
  assert.equal(vtSizeToSave({ testRun: true, resized: true, normalBounds: { width: 1516, height: 939 }, frame: WIN_FRAME }), null);
  assert.equal(vtSizeToSave({ resized: true, normalBounds: { width: 'x', height: 939 }, frame: WIN_FRAME }), null);
});

test('main.js: the window is made at the PAGE size (useContentSize) and fitted by fitVtuberWindow; a test run keeps its small window; every destroy() of it goes through destroyVtWin (saves first)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(!/width: 600, height: 940/.test(main), 'the old fixed size is gone');
  assert.match(main, /require\('\.\/core\/vtuber-window'\)/);
  assert.match(main, /const vtOpts = \{ workArea: screen\.getPrimaryDisplay\(\)\.workArea, saved: store \? store\.get\('vtuberSize'\) : null, store, testRun: TEST_RUN \};/);
  assert.match(main, /TEST_RUN \? \{ \.\.\.testBounds\(360, 560, 0\), minWidth: 340, minHeight: 480 \} : \{ useContentSize: true, width: vt\.width, height: vt\.height, minWidth: vt\.minWidth, minHeight: vt\.minHeight \}/);
  assert.match(main, /vtFits\.set\(w, fitVtuberWindow\(w, vtOpts\)\)/);
  assert.ok(!/\b(?:w|vtWin)\.destroy\(\)/.test(main), 'no bare destroy() of the VTuber window: it would skip saving his size');
  assert.match(main, /render-process-gone[^\n]*destroyVtWin\(w\)/);
  assert.match(main, /loadURL\([^\n]*destroyVtWin\(w\)/);
  assert.match(main, /vtHost\.on\('exit', [^\n]*destroyVtWin\(vtWin\)/);
});
