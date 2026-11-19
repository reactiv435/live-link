// The windows on this PC, for the one-click VTuber (Windows only): list them, and size / send back / close / raise the
// ONE window the app opened itself (the camera's small OBS window, or its own page). Every call that touches a window
// names the window number AND the title it must still have; anything else is left alone.
'use strict';
const path = require('path');
const { execFile } = require('child_process');
const SCRIPT = path.join(__dirname, 'win-windows.ps1');

function run(args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}
/** [{ hwnd, pid, minimised, rect: [x, y, w, h], title }] of every visible window with a title (real screen pixels); [] when it cannot be read. */
async function listWindows() {
  const out = await run(['-Action', 'list']);
  return out.split(/\r?\n/).map((line) => {
    const m = /^(\d+)\|(\d+)\|([01])\|(-?\d+),(-?\d+),(-?\d+),(-?\d+)\|(.*)$/.exec(line.trim());
    return m ? { hwnd: Number(m[1]), pid: Number(m[2]), minimised: m[3] === '1', rect: [+m[4], +m[5], +m[6], +m[7]], title: m[8] } : null;
  }).filter(Boolean);
}
const act = (action) => async (hwnd, title, extra = []) => (await run(['-Action', action, '-Hwnd', String(hwnd), '-Title', title, ...extra])).trim() === 'ok';
const place = act('place'), close = act('close'), front = act('front'), hide = act('hide');
/** Un-minimise, make the INSIDE of the window w x h real screen pixels (0 = keep the size) and send it behind the others, without taking the focus. */
const placeWindow = (hwnd, title, w = 0, h = 0) => place(hwnd, title, ['-W', String(Math.round(w)), '-H', String(Math.round(h))]);
module.exports = { listWindows, placeWindow, closeWindow: (hwnd, title) => close(hwnd, title), frontWindow: (hwnd, title) => front(hwnd, title), hideWindow: (hwnd, title) => hide(hwnd, title) };
