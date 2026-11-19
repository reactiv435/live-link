// avatar.html, first script: runs BEFORE the 3D library and the models load, so the camera is covered at once.
//   1. Reads the state this page last showed (kept in this browser's own storage) and paints its background, or a
//      plain dark cover, straight away.
//   2. Opens the WebSocket at once; the server replays the newest `avatar` message and that overrules step 1.
// While the models are still loading and the avatar is ON, the background (or the dark cover, when the background is
// "transparent") hides the camera; js/avatar.js takes over the messages as soon as it runs, and drops the cover when
// the first avatar frame has been drawn.
(function () {
  'use strict';
  const L = window.VTLogic;
  const params = new URLSearchParams(location.search);
  const MANUAL = params.has('manual');
  // ?oneclick=1 (the source the one-click app adds to OBS): when the app is gone (closed or crashed) the avatar hides by
  // itself after a moment, so his camera shows again even if OBS still shows this source
  const ONECLICK = params.get('oneclick') === '1';
  // &run=<stamp>: new on every start of the app, so OBS loads this page again each time (a page OBS tried to load
  // before the app was running never retries by itself). The app only takes answers carrying the stamp of its own run.
  const RUN = ONECLICK ? (params.get('run') || '') : '';
  const GONE_MS = 2000;
  const bgEl = document.getElementById('bg');
  const STORE = 'vt-avatar-last';
  const HINT_MAX_AGE_MS = 6 * 3600 * 1000;   // a remembered ON only counts for the same show, not the next day
  const SILENT_SERVER_MS = 2500;             // connected, but the server has no state at all: a fresh start = OFF

  let cover = true;          // models not drawn yet
  let shownFor = null;       // the avatar state the background was painted for
  let lastSaved = '', lastSavedAt = 0;

  function paint(a) {
    shownFor = a;
    const on = !!(a && a.on), bg = a ? a.bg : 'transparent';
    bgEl.className = '';
    bgEl.style.backgroundImage = '';
    if (!on) { bgEl.style.display = 'none'; return; }
    if (a.mask) { bgEl.style.display = 'none'; return; }   // the Mask: nothing but its own canvas, and that only once it has drawn (js/mask-page.js)
    if (bg === 'transparent') {
      // nothing behind the avatar by choice; until the avatar itself is on screen a dark cover stands in
      if (cover) { bgEl.style.display = 'block'; bgEl.classList.add('cover'); } else bgEl.style.display = 'none';
      return;
    }
    bgEl.style.display = 'block';
    if (bg === 'green') bgEl.classList.add('green');
    else if (bg === 'black') bgEl.classList.add('black');
    else if (bg.startsWith('preset:')) {
      bgEl.classList.add('preset');
      bgEl.style.backgroundImage = 'url("assets/bg/' + bg.slice(7) + '.webp")';
    }
  }
  function remember(a) {
    const text = JSON.stringify(a), now = Date.now();
    if (text === lastSaved && now - lastSavedAt < 30000) return;
    lastSaved = text; lastSavedAt = now;
    try { localStorage.setItem(STORE, JSON.stringify({ at: now, avatar: a })); } catch (e) { /* storage blocked: no memory, the server still answers */ }
  }

  // ---- 1. the starting state: the address (?on=1...) when given, else what this page last showed
  let initial = null, fromHint = false;
  if (params.has('on') || MANUAL) {
    initial = L.readAvatarMessage({
      t: 'avatar', on: params.get('on') === '1', character: params.get('character'), bg: params.get('bg') || 'transparent',
      face: params.get('face') || 'auto', faceHoldMs: 0, mirror: params.get('mirror') === '1', zoom: params.get('zoom'),
    });
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (saved && saved.avatar && Date.now() - saved.at < HINT_MAX_AGE_MS) { initial = L.readAvatarMessage(saved.avatar); fromHint = !!initial; }
    } catch (e) { /* no memory */ }
  }
  if (!initial) initial = L.readAvatarMessage({ t: 'avatar', on: false });
  if (initial.face !== 'auto' && fromHint) initial.face = 'auto';   // a picked face is not carried over a reload
  paint(initial);
  const paintedAt = performance.now();

  // ---- 2. the socket (not in ?manual=1, where a capture script feeds the page)
  let socket = null, retry = null, handler = null, silentTimer = null, gotAvatar = false, goneTimer = null;
  function appGone() {
    goneTimer = null;
    const a = shownFor || initial;
    if (a && a.on) { const off = { ...a, on: false, face: 'auto', faceHoldMs: 0 }; tell(off); onMessage(off); }
  }
  /** the Mask's page hears every message first; whatever happens in there, the heroes' path below still runs */
  function tell(m) { if (boot.onAny) { try { boot.onAny(m); } catch (err) { /* the Mask's business */ } } }
  const waiting = [];
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'avatar') {
      const a = L.readAvatarMessage(msg);
      if (!a) return;
      gotAvatar = true;
      if (!boot.firstStateAt) boot.firstStateAt = performance.now();
      if (!handler) paint(a);          // before avatar.js runs; afterwards it paints through VTBoot.paint itself
      remember(a);
    }
    if (handler) handler(msg);
    else if (msg.t === 'avatar') { waiting.length = 0; waiting.push(msg); }
  }
  function connect() {
    retry = null;
    // bin=1: this page also takes the tracker's raw face results (binary), for the Mask
    const where = '/ws?bin=1' + (ONECLICK ? '&oneclick=1&run=' + encodeURIComponent(RUN) : '');
    try { socket = new WebSocket('ws://' + location.host + where); } catch (e) { socket = null; retry = setTimeout(connect, 1500); return; }
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      clearTimeout(goneTimer); goneTimer = null;
      // the app hears at once that this page is alive (the first avatar-ack only comes once the models are drawn)
      if (ONECLICK) boot.send({ t: 'avatar-hello' });
      // The server replays its newest state in the first milliseconds. Nothing at all for a while = a freshly started
      // server that nobody has switched on yet: a remembered ON from before no longer holds.
      clearTimeout(silentTimer);
      silentTimer = setTimeout(() => { if (!gotAvatar && fromHint) { const off = { ...initial, t: 'avatar', on: false }; tell(off); onMessage(off); } }, SILENT_SERVER_MS);
    };
    socket.onmessage = e => { if (typeof e.data !== 'string') { if (boot.onBinary) { try { boot.onBinary(e.data); } catch (err) { /* the Mask's business */ } } return; } let m; try { m = JSON.parse(e.data); } catch (err) { return; } tell(m); onMessage(m); };
    socket.onclose = () => {
      socket = null; clearTimeout(silentTimer);
      if (ONECLICK && !goneTimer) goneTimer = setTimeout(appGone, GONE_MS);
      if (!retry) retry = setTimeout(connect, 1000);
    };
    socket.onerror = () => { try { socket && socket.close(); } catch (e) { /* closing */ } };
  }

  const boot = window.VTBoot = {
    MANUAL, ONECLICK, RUN, initial, fromHint, paintedAt, firstStateAt: 0, coverGoneAt: 0,
    onBinary: null, onAny: null,   // js/mask-page.js: the raw face results, and every message (it runs before the 3D files are in)
    paint,
    /** js/avatar.js: from now on every message goes to `fn` (the newest `avatar` that arrived meanwhile first). */
    take(fn) { handler = fn; for (const m of waiting.splice(0)) fn(m); },
    send(obj) { if (socket && socket.readyState === 1) socket.send(JSON.stringify(ONECLICK ? { ...obj, run: RUN } : obj)); },
    /** The avatar itself is on screen (or the page is OFF): the stand-in cover is no longer needed. */
    uncover() { if (!cover) return; cover = false; boot.coverGoneAt = performance.now(); paint(shownFor); },
    get covered() { return cover; },
    /** the newest avatar state this page has painted for (js/mask-page.js starts from it) */
    get shown() { return shownFor; },
  };
  if (!MANUAL) connect();
})();
