'use strict';
// V9: the VTuber window opens at the one-screen control deck's size, 1366 x 768 (it was 600 x 940, which the deck
// draws stacked: below 1000 wide). Always clamped to the primary display's work area (a smaller screen never gets a
// window bigger than itself), never below about 1000 x 640 (unless the screen itself is smaller). A size he chose
// himself is kept (saved when he resizes it, size only, never the place); a saved size that is the old 600 x 940
// default, smaller than 1000 x 640, or not a sane whole number gets the new default instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { vtuberWindowSize, cleanVtuberSize, VT_WINDOW, VT_WINDOW_MIN, VT_WINDOW_OLD } = require('../src/core/vtuber-window');

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

test('main.js: the window opens at this size (a test run keeps its small window), and only a size he chose is saved (never in a test run)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(!/width: 600, height: 940/.test(main), 'the old fixed size is gone');
  assert.match(main, /require\('\.\/core\/vtuber-window'\)/);
  assert.match(main, /vtuberWindowSize\(\{ workArea: screen\.getPrimaryDisplay\(\)\.workArea, saved: store \? store\.get\('vtuberSize'\) : null \}\)/);
  assert.match(main, /TEST_RUN \? \{ \.\.\.testBounds\(360, 560, 0\), minWidth: 340, minHeight: 480 \}/);
  // saved through the app's store, only after he resized it, only the size, cleaned first, never in a test run
  assert.match(main, /w\.on\('resized', \(\) => \{ vtResized = true; \}\)/);
  assert.match(main, /if \(TEST_RUN \|\| !vtResized \|\| !store\) return;/);
  assert.match(main, /const s = cleanVtuberSize\(w\.getNormalBounds\(\)\);\s*if \(s\) store\.set\('vtuberSize', s\);/);
});
