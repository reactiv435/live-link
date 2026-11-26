// V9 SHOW SIGN + LIVE OVERLAY: the two cards in the VTuber window (vtuber.html). js/vtuber.js owns the settings, the relay
// and the `avatar` message; this file owns everything on the two cards:
//   SHOW SIGN: upload (the file goes to this PC's own server, /api/signs, and nowhere else), up to 6 kept, pick / delete,
//              a live preview with the key applied, key colour + three sliders, where it sits (drag, or the sliders),
//              "trim the empty green" (the sign is found in the file by itself), the switch, SHOW / HIDE (S; Ctrl+Alt+0).
//   LIVE OVERLAY:  the address (https only), the switch, where it sits and how big the page is drawn, SHOW / HIDE (H; no standard LIVE Link key).
// The avatar page (js/v9-sign-layer.js) draws both and reports back in its answers (`sign`).
// Nothing here runs a camera or a microphone, and the only request that leaves this page goes to this PC's own server.
(function (root) {
  'use strict';
  const VS = root.VTSign, SL = root.VTSignLayer, doc = root.document;
  if (!VS || !doc) return;
  const $ = (id) => doc.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const T = {
    signOn: 'Your own looping sign at the top of the picture, with its green taken out. It steps aside by itself for a chat vote, the boss fight, album eating, the rank banner and the countdown, and comes back after.',
    overlayOn: 'Your live overlay page, shown over the picture. It hides by itself during the countdown. Any sound the page plays goes into your stream too.',
    off: 'Turn the avatar ON first.', wait: 'Waiting for the Mask in OBS ...', none: 'Upload your sign first: a video or picture on a pure green background (no green in the sign itself: it is taken out too).',
    full: 'You already keep 6 signs. Delete one first.', big: 'That file is over 60 MB. Export it shorter or smaller (1080 wide is plenty) and try again.',
    type: 'That file is not one this takes. Use a video (mp4, webm) or a picture (png, gif, jpg).', noPlace: 'Signs cannot be kept in this window (a test run).',
    failed: 'The upload did not finish. Try again.', unread: 'The picture size of that file could not be read. Export it again as MP4 (H.264), WebM, PNG or JPG and upload that.', empty: 'The key takes the whole picture away. Is the background pure green? Pick the background colour with "Key colour", or lower "Key strength".',
    url: 'Paste the address of your live overlay page. It must start with https://', urlBad: 'That address cannot be used. It must start with https:// and be a page on the internet (not this PC).',
    overlayNote: 'The page is laid out for a wide screen: "Page size" draws it smaller so it fits. The picture here shows where it sits; the page itself shows in OBS.',
  };
  const C = { ctx: null, list: [], can: true, note: '', noteAt: -1e9, busy: false, arm: '', armAt: 0, pv: null, activeAt: -1e9, raf: 0, find: 0, findTimer: 0, drag: null, overlayNote: '', localError: '' };
  const fresh = () => root.performance.now();
  const S = () => C.ctx.settings, live = () => C.ctx.live;
  const say = (t) => { C.note = t; C.noteAt = fresh(); render(); };
  const ack = () => { const st = C.ctx.st, k = st.maskAck && st.maskAck.sign; return k && fresh() - st.maskAckAt < 3500 ? k : null; };
  const push = () => { C.ctx.save(); C.ctx.sendAvatar(); render(); };

  // ------------------------------------------------------------------ what js/vtuber.js asks
  /** whatever was saved, made valid (nothing saved = both off) */
  function init(settings) { settings.sign = VS.cleanSignSettings(settings.sign); settings.overlay = VS.cleanOverlaySettings(settings.overlay); }
  /** the two fields of the `avatar` message (only while a feature is on and has something to show) */
  function fields(m, settings, lv) {
    const s = VS.signField(settings.sign, lv.signShow !== false), h = VS.overlayField(settings.overlay, lv.overlayShow !== false);
    if (s) m.sign = s;
    if (h) m.overlay = h;
  }
  /** this page was loaded again mid-show: a sign he had hidden stays hidden */
  function adopt(a, lv) { if (a && a.sign) lv.signShow = a.sign.show !== false; if (a && a.overlay) lv.overlayShow = a.overlay.show !== false; }
  /** SHOW / HIDE: the button, the key in this window, or LIVE Link's key from any window */
  function toggle(what) {
    if (!C.ctx || !S().mask) return false;
    const lv = live();
    if (what === 'sign') { if (!S().sign.on || !S().sign.file) return false; C.ctx.claim(); lv.signShow = lv.signShow === false; }
    else if (what === 'overlay') { if (!S().overlay.on || !S().overlay.url) return false; C.ctx.claim(); lv.overlayShow = lv.overlayShow === false; }
    else return false;
    C.ctx.sendAvatar(); render();
    return true;
  }

  // ------------------------------------------------------------------ the saved signs (this PC's own server)
  async function loadList() {
    try { const r = await fetch('/api/signs', { cache: 'no-store' }); const j = r.ok ? await r.json() : null; if (j && Array.isArray(j.signs)) { C.list = j.signs.filter((x) => x && VS.isSignName(x.name)); C.can = j.can !== false; } } catch (e) { /* the list stays as it was */ }
    // a picked sign that is no longer on the disk is not picked any more
    const s = S().sign;
    if (s.file && !C.list.some((x) => x.name === s.file)) { s.file = ''; s.crop = null; closePreview(); push(); }
    render();
  }
  async function upload(file) {
    if (!file || C.busy) return;
    if (!VS.safeSignName(file.name)) { say(T.type); return; }
    if (file.size > VS.SIGN_MAX_BYTES) { say(T.big); return; }
    if (C.list.length >= VS.SIGN_KEEP) { say(T.full); return; }
    C.busy = true; say('Saving "' + file.name.slice(0, 40) + '" on this PC ...');
    let res = null, j = null;
    try { res = await fetch('/api/signs/' + encodeURIComponent(file.name), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-VTuber-Sign': '1' }, body: file }); j = await res.json().catch(() => null); } catch (e) { res = null; }
    C.busy = false;
    if (!res || !res.ok || !j || !VS.isSignName(j.name)) { say(!res ? T.failed : j && j.error === 'pixels' ? VS.pixelProblem(j.w, j.h) || T.type : j && j.error === 'unread' ? T.unread : res.status === 413 ? T.big : res.status === 415 ? T.type : res.status === 409 ? T.full : res.status === 503 ? T.noPlace : T.failed); return; }
    if (Array.isArray(j.signs)) C.list = j.signs;
    C.ctx.claim();
    const first = !S().sign.file;
    pick(j.name, first);
    say(first ? 'Saved, and switched on. Look at the preview: is the green gone?' : 'Saved and picked.');
  }
  function pick(name, switchOn) {
    const s = S().sign;
    if (!VS.isSignName(name)) return;
    C.ctx.claim();
    if (s.file !== name) { s.file = name; s.crop = null; C.localError = ''; closePreview(); }
    if (switchOn) { s.on = true; live().signShow = true; }
    push(); touch(); findSoon(50);
  }
  async function remove(name) {
    if (C.arm !== name || fresh() > C.armAt) { C.arm = name; C.armAt = fresh() + 4000; render(); setTimeout(render, 4100); return; }
    C.arm = '';
    let j = null;
    try { const r = await fetch('/api/signs/' + encodeURIComponent(name), { method: 'DELETE', headers: { 'X-VTuber-Sign': '1' } }); j = r.ok ? await r.json() : null; } catch (e) { j = null; }
    if (!j) { say('That sign could not be deleted. Try again.'); return; }
    if (Array.isArray(j.signs)) C.list = j.signs;
    const s = S().sign;
    if (s.file === name) { C.ctx.claim(); s.file = ''; s.crop = null; closePreview(); push(); }
    say('Deleted from this PC.');
  }

  // ------------------------------------------------------------------ the preview (the key applied), only while he is at the card
  const AT_CARD_MS = 20000;
  function touch() { C.activeAt = fresh(); if (!C.raf) C.raf = root.requestAnimationFrame(frame); }
  function closePreview() { const p = C.pv; C.pv = null; if (!p) return; try { p.src.close(); } catch (e) { /* gone */ } }
  function openPreview() {
    const s = S().sign;
    if (!SL || !s.file || (C.pv && C.pv.file === s.file)) return;
    closePreview();
    const p = C.pv = { file: s.file, src: null, ready: false, drawn: false, key: '' };
    if (!C.keyer) { try { C.keyer = SL.createKeyer($('signKey')); } catch (e) { C.localError = 'This PC could not start the graphics for the preview.'; return; } }
    p.src = SL.openSource(s.file, { ready: () => { p.ready = true; render(); }, error: (text) => { C.localError = text; render(); } });
  }
  /** the picture's place inside the small 9:16 frame: picture px -> canvas px */
  const STAGE = { w: 324, h: 576 }, toStage = (r) => ({ x: r.x * STAGE.w / VS.FRAME.w, y: r.y * STAGE.h / VS.FRAME.h, w: r.w * STAGE.w / VS.FRAME.w, h: r.h * STAGE.h / VS.FRAME.h });
  const aspectNow = () => { const p = C.pv, s = S().sign, c = (s.trim && s.crop) || [0, 0, 1, 1]; return p && p.ready ? (p.src.w * (c[2] - c[0])) / Math.max(1, p.src.h * (c[3] - c[1])) : 16 / 9; };
  /** the small 9:16 picture both cards share: TikTok's safe zone, where his face usually is, the sign and the live overlay */
  function drawStage(cv, mine) {
    const x = cv.getContext('2d'), W = cv.width, H = cv.height, sx = W / VS.FRAME.w, sy = H / VS.FRAME.h, SF = VS.SAFE;
    x.clearRect(0, 0, W, H); x.fillStyle = '#0b0706'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#1a110e'; x.fillRect(SF.x0 * sx, SF.y0 * sy, (SF.x1 - SF.x0) * sx, (SF.y1 - SF.y0) * sy);
    x.fillStyle = '#2b1c17'; x.beginPath(); x.ellipse(W * 0.5, H * 0.47, W * 0.21, H * 0.15, 0, 0, 6.2832); x.fill();        // where a face usually is
    x.setLineDash([4, 4]); x.strokeStyle = '#6a5a52'; x.lineWidth = 1; x.strokeRect(SF.x0 * sx + 0.5, SF.y0 * sy + 0.5, (SF.x1 - SF.x0) * sx - 1, (SF.y1 - SF.y0) * sy - 1); x.setLineDash([]);
    const sg = S().sign, hy = S().overlay;
    if (hy.on && hy.url) {
      const r = toStage(VS.overlayRect(hy));
      x.fillStyle = mine === 'overlay' ? '#e01f3d33' : '#d9d2cb1c'; x.fillRect(r.x, r.y, r.w, r.h);
      x.strokeStyle = mine === 'overlay' ? '#ff3b57' : '#8a7c73'; x.lineWidth = mine === 'overlay' ? 2 : 1; x.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      x.fillStyle = mine === 'overlay' ? '#fff' : '#a8978c'; x.font = '600 13px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('LIVE OVERLAY', r.x + r.w / 2, r.y + r.h / 2, r.w - 6);
    }
    if (sg.file) {
      const r = toStage(VS.signRect(sg, aspectNow())), p = C.pv;
      x.globalAlpha = sg.on ? 1 : 0.4;
      if (p && p.ready && p.drawn && !C.localError) { try { x.drawImage($('signKey'), r.x, r.y, r.w, r.h); } catch (e) { /* the box alone */ } }
      else { x.fillStyle = '#d9d2cb22'; x.fillRect(r.x, r.y, r.w, r.h); }
      x.globalAlpha = 1;
      x.strokeStyle = mine === 'sign' ? '#ff3b57' : '#8a7c73'; x.lineWidth = mine === 'sign' ? 2 : 1; x.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }
  function frame() {
    C.raf = 0;
    if (!C.ctx) return;
    const s = S().sign, at = fresh() - C.activeAt < AT_CARD_MS && doc.visibilityState === 'visible' && S().mask;
    const p = C.pv;
    if (!at) { if (p) p.src.pause(); $('signPvNote').textContent = s.file ? 'The preview rests. Move the mouse over this card to wake it.' : ''; return; }
    if (s.file && !p) openPreview();
    if (p && p.ready && C.keyer && !C.localError && !C.keyer.fits(p.src.w, p.src.h)) { C.localError = VS.pixelProblem(p.src.w, p.src.h, C.keyer.maxTex) || 'This sign is too big for the graphics card of this PC.'; render(); }
    if (p && p.ready && C.keyer && !C.find && !C.localError) {
      p.src.play();
      const crop = s.trim ? s.crop : null, cv = $('signKey'), a = aspectNow(), w = 480, h = Math.max(2, Math.round(clamp(w / a, 40, 640)));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; p.drawn = false; p.src.again(); }
      const key = [s.key, s.strength, s.soft, s.spill, crop ? crop.join(',') : ''].join('|');
      if (key !== p.key) { p.key = key; p.drawn = false; }
      const f = p.src.take();
      if (f || !p.drawn) { if (C.keyer.draw(f, p.src.w, p.src.h, { key: s.key, strength: s.strength, soft: s.soft, spill: s.spill, crop })) p.drawn = true; }
      $('signPvNote').textContent = '';
    }
    drawStage($('signStage'), 'sign');
    if (!$('overlayCard').hidden) drawStage($('overlayStage'), 'overlay');
    C.raf = root.requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ "trim the empty green": find the sign in its file
  const findSoon = (ms) => { clearTimeout(C.findTimer); C.findTimer = setTimeout(findSign, ms === undefined ? 500 : ms); };
  /** the box round everything the key leaves, over the whole loop -> settings.sign.crop (null = the whole file) */
  async function findSign() {
    const s = S().sign;
    if (!SL || !s.file || !s.trim || C.find) return;
    openPreview();
    const p = C.pv; if (!p) return;
    for (let i = 0; i < 60 && !p.ready && C.pv === p && !C.localError; i++) await new Promise((r) => setTimeout(r, 100));
    if (C.pv !== p || !p.ready) return;
    C.find++;
    let box = null, k = null;
    try {
      const W = 160, H = Math.max(8, Math.round(clamp(160 * p.src.h / Math.max(1, p.src.w), 8, 400)));
      const cv = doc.createElement('canvas'); cv.width = W; cv.height = H;
      k = SL.createKeyer(cv); const o = { key: s.key, strength: s.strength, soft: s.soft, spill: s.spill, crop: null }, v = p.src.video ? p.src.el : null;
      const scan = (src) => {
        if (!k.draw(src, p.src.w, p.src.h, o)) return;
        const d = k.read();
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[((H - 1 - y) * W + x) * 4 + 3] > 40) { if (!box) box = [x, y, x, y]; else { if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y; } }
      };
      if (v && Number.isFinite(v.duration) && v.duration > 0.2) {
        const was = v.currentTime; v.pause();
        for (let i = 0; i < 8 && C.pv === p; i++) {
          await new Promise((res) => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); setTimeout(done, 1500); v.currentTime = v.duration * (i + 0.5) / 8; });
          scan(v);
        }
        try { v.currentTime = was; } catch (e) { /* from the start then */ }
      } else { const el = p.src.video ? v : (p.src.again(), p.src.take()); if (el) scan(el); }
      if (C.pv === p && S().sign.file === p.file) {
        let crop = null;
        if (box) { const m = 0.015; crop = VS.cleanCrop([box[0] / W - m, box[1] / H - m, (box[2] + 1) / W + m, (box[3] + 1) / H + m]); if (crop && (crop[2] - crop[0]) * (crop[3] - crop[1]) > 0.9) crop = null; }
        C.empty = !box;
        const before = JSON.stringify(s.crop);
        s.crop = crop;
        if (JSON.stringify(crop) !== before) push(); else render();
      }
    } catch (e) { /* the whole file then */ } finally { if (k) k.lose(); }
    C.find--;
    if (p.src.video) p.src.play();
    p.src.again(); p.drawn = false; touch();
  }

  // ------------------------------------------------------------------ render
  const pct = (v) => Math.round(v * 100) + ' %';
  function signLine() {
    const s = S().sign, lv = live(), k = ack();
    if (C.localError) return ['bad', C.localError];
    if (!s.file) return ['wait', T.none];
    if (C.empty && s.trim) return ['bad', T.empty];
    if (!s.on) return ['wait', 'Switched off. Switch "Show sign" on to put it in the picture.'];
    if (!lv.on) return ['wait', T.off];
    if (!k || !k.sign || k.sign.state === 'off') return ['wait', T.wait];
    const g = k.sign;
    if (g.state === 'error') return ['bad', g.error || 'The sign could not be shown in OBS.'];
    if (g.state === 'loading') return ['wait', 'Loading the sign in OBS ...'];
    if (g.state === 'hidden') return ['wait', 'Hidden by you. It stays hidden until you press SHOW SIGN.'];
    if (g.state === 'aside') return ['busy', 'Stepped aside for ' + (VS.WHY[g.why] || 'the show') + '. It comes back by itself.'];
    if (g.state === 'returning') return ['busy', 'Coming back ...'];
    return ['ready', 'On screen.'];
  }
  function overlayLine() {
    const h = S().overlay, lv = live(), k = ack();
    if (!h.url) return ['wait', T.url];
    if (!h.on) return ['wait', 'Switched off. Switch "Live overlay" on to put it in the picture.'];
    if (!lv.on) return ['wait', T.off];
    if (!k || !k.overlay || k.overlay.state === 'off') return ['wait', T.wait];
    const g = k.overlay;
    if (g.state === 'loading') return ['wait', 'Loading your page in OBS ...'];
    if (g.state === 'hidden') return ['wait', 'Hidden by you. It stays hidden until you press SHOW LIVE OVERLAY.'];
    if (g.state === 'aside') return ['busy', 'Hidden during ' + (VS.WHY[g.why] || 'the show') + '. It comes back by itself.'];
    if (g.state === 'returning') return ['busy', 'Coming back ...'];
    return ['ready', 'On screen.'];
  }
  let tilesKey = '';
  function render() {
    if (!C.ctx || !$('signCard')) return;
    const st = S(), s = st.sign, h = st.overlay, lv = live(), mask = !!st.mask;
    $('signCard').hidden = !mask; $('overlayCard').hidden = !mask;
    if (!mask) return;
    // ---- the sign
    $('signOn').classList.toggle('sel', s.on);
    const canShow = s.on && !!s.file, shown = lv.signShow !== false;
    $('signShow').disabled = !canShow;
    $('signShowText').textContent = shown ? 'HIDE SIGN' : 'SHOW SIGN';
    const taken = C.ctx.puppetKey ? C.ctx.puppetKey(VS.KEYS.sign.code) : '';
    $('signShowKey').textContent = VS.keyLine(VS.KEYS.sign, taken);
    const [sc, stx] = signLine(); $('signLine').dataset.state = sc; $('signLineText').textContent = stx;
    const tk = JSON.stringify([C.list.map((x) => x.name), s.file, C.arm && fresh() < C.armAt ? C.arm : '', C.busy]);
    if (tk !== tilesKey) {
      tilesKey = tk;
      const box = $('signTiles'); box.textContent = '';
      for (const it of C.list) {
        const row = doc.createElement('div'); row.className = 'signtile' + (it.name === s.file ? ' sel' : '');
        const b = doc.createElement('button'); b.className = 'plain'; b.type = 'button'; b.textContent = it.name; b.title = it.name + '  (' + (it.size / 1048576).toFixed(1) + ' MB)';
        b.addEventListener('click', () => { pick(it.name, false); b.blur(); });
        const d = doc.createElement('button'); d.className = 'plain del'; d.type = 'button'; const armed = C.arm === it.name && fresh() < C.armAt;
        d.textContent = armed ? 'Sure?' : 'Delete'; d.setAttribute('aria-label', 'Delete ' + it.name);
        d.addEventListener('click', () => { remove(it.name); d.blur(); });
        row.appendChild(b); row.appendChild(d); box.appendChild(row);
      }
      $('signCount').textContent = C.list.length + ' of ' + VS.SIGN_KEEP + ' kept on this PC';
      $('signUpload').disabled = C.busy || C.list.length >= VS.SIGN_KEEP || !C.can;
    }
    $('signNote').textContent = fresh() - C.noteAt < 9000 ? C.note : '';
    $('signLook').hidden = !s.file;
    if (doc.activeElement !== $('signKeyCol')) $('signKeyCol').value = s.key;
    const set = (id, v, txt) => { const el = $(id); if (doc.activeElement !== el) el.value = String(v); const o = $(id + 'Val'); if (o) o.textContent = txt; };
    set('signStrength', s.strength, pct(s.strength)); set('signSoft', s.soft, pct(s.soft * 2)); set('signSpill', s.spill, pct(s.spill));
    set('signSize', s.size, pct(s.size)); set('signX', s.x, s.x === 0 ? 'middle' : (s.x < 0 ? 'left ' : 'right ') + pct(Math.abs(s.x))); set('signY', s.y, s.y === 0 ? 'top' : pct(s.y) + ' down');
    $('signTrim').classList.toggle('sel', s.trim);
    $('signTrimHint').textContent = !s.trim ? 'Off: the whole file is shown, empty green and all (taken out by the key).' : s.crop ? 'On: only the part of the file that holds your sign is shown, so it can be big.' : 'On: your sign fills the file already, nothing to trim.';
    // ---- the live overlay
    $('overlayOn').classList.toggle('sel', h.on);
    if (doc.activeElement !== $('overlayUrl')) $('overlayUrl').value = h.url;
    const hShown = lv.overlayShow !== false;
    $('overlayShow').disabled = !(h.on && h.url);
    $('overlayShowText').textContent = hShown ? 'HIDE LIVE OVERLAY' : 'SHOW LIVE OVERLAY';
    const taken2 = C.ctx.puppetKey ? C.ctx.puppetKey(VS.KEYS.overlay.code) : '';
    $('overlayShowKey').textContent = VS.keyLine(VS.KEYS.overlay, taken2);
    const [hc, htx] = overlayLine(); $('overlayLine').dataset.state = hc; $('overlayLineText').textContent = htx;
    $('overlayNote').textContent = C.overlayNote;
    set('overlayX', h.x, h.x === 0 ? 'middle' : (h.x < 0 ? 'left ' : 'right ') + pct(Math.abs(h.x))); set('overlayY', h.y, h.y === 1 ? 'bottom' : h.y === 0 ? 'top' : pct(h.y) + ' down');
    set('overlayW', h.w, pct(h.w)); set('overlayH', h.h, h.h + ' px'); set('overlayZoom', h.zoom, pct(h.zoom));
    if (!C.raf) { drawStage($('signStage'), 'sign'); drawStage($('overlayStage'), 'overlay'); }
  }

  // ------------------------------------------------------------------ wiring
  function mount(ctx) {
    C.ctx = ctx;
    if (!$('signCard') || !$('overlayCard')) return;
    $('signHint').textContent = T.signOn; $('overlayHint').textContent = T.overlayOn; $('overlayPlaceHint').textContent = T.overlayNote;
    const setS = (patch, refind) => { ctx.claim(); Object.assign(S().sign, patch); S().sign = VS.cleanSignSettings(S().sign); push(); touch(); if (refind) findSoon(); };
    const setH = (patch) => { ctx.claim(); Object.assign(S().overlay, patch); S().overlay = VS.cleanOverlaySettings(S().overlay); push(); touch(); };
    $('signOn').addEventListener('click', () => { const on = !S().sign.on; if (on) live().signShow = true; setS({ on }); $('signOn').blur(); });
    $('signShow').addEventListener('click', () => { toggle('sign'); $('signShow').blur(); });
    $('signUpload').addEventListener('click', () => { $('signFile').click(); $('signUpload').blur(); });
    $('signFile').addEventListener('change', () => { const f = $('signFile').files && $('signFile').files[0]; $('signFile').value = ''; upload(f); });
    $('signKeyCol').addEventListener('input', (e) => setS({ key: e.target.value }, true));
    $('signKeyGreen').addEventListener('click', () => { setS({ key: VS.SIGN_DEFAULTS.key }, true); $('signKeyGreen').blur(); });
    $('signStrength').addEventListener('input', (e) => setS({ strength: Number(e.target.value) }, true));
    $('signSoft').addEventListener('input', (e) => setS({ soft: Number(e.target.value) }, true));
    $('signSpill').addEventListener('input', (e) => setS({ spill: Number(e.target.value) }));
    $('signSize').addEventListener('input', (e) => setS({ size: Number(e.target.value) }));
    $('signX').addEventListener('input', (e) => setS({ x: Number(e.target.value) }));
    $('signY').addEventListener('input', (e) => setS({ y: Number(e.target.value) }));
    $('signTrim').addEventListener('click', () => { const trim = !S().sign.trim; setS({ trim, crop: null }); if (trim) findSoon(50); $('signTrim').blur(); });
    $('signReset').addEventListener('click', () => { const D = VS.SIGN_DEFAULTS; setS({ key: D.key, strength: D.strength, soft: D.soft, spill: D.spill, x: D.x, y: D.y, size: D.size, trim: true }, true); $('signReset').blur(); });
    // drag the sign (or the live overlay) in its small picture
    const dragOn = (cv, what) => {
      const where = (e) => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) / b.width * VS.FRAME.w, (e.clientY - b.top) / b.height * VS.FRAME.h]; };
      cv.addEventListener('pointerdown', (e) => {
        const r = what === 'sign' ? VS.signRect(S().sign, aspectNow()) : VS.overlayRect(S().overlay), [px, py] = where(e);
        if ((what === 'sign' && !S().sign.file) || px < r.x - 30 || px > r.x + r.w + 30 || py < r.y - 30 || py > r.y + r.h + 30) return;
        C.drag = { what, dx: px - r.x, dy: py - r.y, r }; cv.setPointerCapture(e.pointerId); cv.classList.add('drag'); e.preventDefault();
      });
      cv.addEventListener('pointermove', (e) => {
        touch();
        const d = C.drag; if (!d || d.what !== what) return;
        const [px, py] = where(e), SF = VS.SAFE, top = SF.y0 + (what === 'sign' ? 4 : 0);
        const fx = SF.x1 - SF.x0 - d.r.w, fy = SF.y1 - top - d.r.h;
        const x = fx > 1 ? clamp(((px - d.dx - SF.x0) / fx - 0.5) * 2, -1, 1) : 0, y = fy > 1 ? clamp((py - d.dy - top) / fy, 0, 1) : 0;
        if (what === 'sign') setS({ x: Math.abs(x) < 0.04 ? 0 : x, y: y < 0.015 ? 0 : y }); else setH({ x: Math.abs(x) < 0.04 ? 0 : x, y: y > 0.985 ? 1 : y });
      });
      const end = () => { C.drag = null; cv.classList.remove('drag'); };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    };
    dragOn($('signStage'), 'sign'); dragOn($('overlayStage'), 'overlay');
    for (const id of ['signCard', 'overlayCard']) { $(id).addEventListener('pointermove', touch); $(id).addEventListener('pointerdown', touch); }
    // ---- the live overlay
    const useUrl = () => {
      const raw = $('overlayUrl').value.trim();
      if (!raw) { C.overlayNote = ''; setH({ url: '', on: false }); return; }
      const u = VS.overlayUrl(raw, root.location.host);
      if (!u) { C.overlayNote = T.urlBad; render(); return; }
      C.overlayNote = 'Address saved.'; live().overlayShow = true; setH({ url: u, on: true }); $('overlayUrl').value = u;
    };
    $('overlayUse').addEventListener('click', () => { useUrl(); $('overlayUse').blur(); });
    $('overlayUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useUrl(); $('overlayUrl').blur(); } });
    $('overlayOn').addEventListener('click', () => { const on = !S().overlay.on; if (on && !S().overlay.url) { C.overlayNote = T.url; render(); $('overlayUrl').focus(); return; } if (on) live().overlayShow = true; setH({ on }); $('overlayOn').blur(); });
    $('overlayShow').addEventListener('click', () => { toggle('overlay'); $('overlayShow').blur(); });
    $('overlayX').addEventListener('input', (e) => setH({ x: Number(e.target.value) }));
    $('overlayY').addEventListener('input', (e) => setH({ y: Number(e.target.value) }));
    $('overlayW').addEventListener('input', (e) => setH({ w: Number(e.target.value) }));
    $('overlayH').addEventListener('input', (e) => setH({ h: Number(e.target.value) }));
    $('overlayZoom').addEventListener('input', (e) => setH({ zoom: Number(e.target.value) }));
    $('overlayReset').addEventListener('click', () => { const D = VS.OVERLAY_DEFAULTS; setH({ x: D.x, y: D.y, w: D.w, h: D.h, zoom: D.zoom }); $('overlayReset').blur(); });
    // ---- the keys while this window is in front: S = the sign, H = the live overlay (never while he types, never with Ctrl / Alt,
    // never while a puppet-show key is being changed; a puppet-show key he moved onto S or H wins, and the button says so)
    root.addEventListener('keydown', (e) => {
      const what = e.code === VS.KEYS.sign.code ? 'sign' : e.code === VS.KEYS.overlay.code ? 'overlay' : '';
      if (!what || e.ctrlKey || e.altKey || e.metaKey || e.repeat || !S().mask || (ctx.keyBusy && ctx.keyBusy())) return;
      const tag = e.target && e.target.tagName; if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) return;
      if (ctx.puppetKey && ctx.puppetKey(e.code)) return;
      if (toggle(what)) e.preventDefault();
    });
    loadList().then(() => { if (S().sign.file && S().sign.trim && !S().sign.crop) findSoon(1500); });
    setInterval(() => { if (S().mask) render(); }, 1000);
    render();
  }
  /** a message from the relay that js/vtuber.js does not know: LIVE Link's two keys */
  function message(m) { if (m && m.t === 'v9-sign-cmd' && (m.what === 'sign' || m.what === 'overlay')) toggle(m.what); }

  root.VTSignCard = { init, fields, adopt, toggle, mount, message, render, T, debug: C, upload, pick, remove, findSign, loadList, signLine, overlayLine };
})(typeof globalThis !== 'undefined' ? globalThis : self);
