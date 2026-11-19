// vtuber.html: the ONE page of the one-click VTuber. It holds the controls (character, ON / OFF, framing), the
// microphone, and (inside an unseen frame) the v2 tracker, which it drives so the owner never has to.
// The server (one-click.js) tells it once a second what it found in OBS; the page shows ONE plain sentence.
// Nothing leaves this PC. The OBS password never reaches this page (only the fallback paste box sends one TO the server).
(function () {
  'use strict';
  const L = window.VTLogic, W = window.VTMaskWire;
  const $ = (id) => document.getElementById(id);
  const STORE = 'vt3-settings';
  const BG_LABEL = { transparent: 'See-through', green: 'Green', black: 'Black', 'preset:courtyard': 'Sunset Courtyard', 'preset:grove': 'Jungle Grove', 'preset:frostkeep': 'Moonlit Citadel' };

  // ------------------------------------------------------------------ every sentence this page can show
  const SAY = {
    starting: 'Getting ready ...',
    stopped: 'VTuber has stopped. Close this window and double-click VTuber.bat again.',
    obsClosed: 'OBS is not open. Open OBS and I will connect by myself.',
    obsOff: 'OBS is not letting other programs in. In OBS open Tools, then WebSocket Server Settings, tick "Enable WebSocket server" and press OK. I will connect by myself.',
    obsPassword: 'OBS did not accept its password. In OBS open Tools, then WebSocket Server Settings, press "Show Connect Info", copy the Server Password and paste it here.',
    noCamera: 'I cannot find a camera in OBS. Add your DroidCam camera to a scene and I will find it by myself.',
    nameTaken: 'OBS already has something else named "VTuber Avatar". Rename or delete that one in OBS and I will try again by myself.',
    addFailed: 'I could not add the avatar to OBS. Close this window and double-click VTuber.bat again.',
    hidden: (cam) => 'Your camera (' + cam + ') is hidden in every scene. Show it in the scene you use and I will put the avatar on top of it by myself.',
    removed: 'VTuber is out of OBS. Press "Put VTuber back in OBS" under More to use it again.',
    loading: 'Getting ready: loading the face reader ...',
    readerFailed: 'The face reader could not start. Close this window and double-click VTuber.bat again.',
    waitPicture: (cam) => 'Waiting for the picture from ' + cam + ' ...',
    noPicture: (cam) => 'No picture is coming from ' + cam + '. Is the phone camera on and showing in OBS?',
    fixing: (cam) => 'Getting the picture from ' + cam + ' again ...',
    noFace: (cam) => 'I see the picture from ' + cam + ', but not your face. Sit in front of the camera.',
    ready: (cam, who) => 'Ready. Watching you through ' + cam + '. Press ON to become ' + who + '.',
    on: (who) => 'ON. You are ' + who + ' on stream.',
    onWaiting: (who) => 'ON. ' + who.charAt(0).toUpperCase() + who.slice(1) + ' is appearing in OBS ...',
    onMaskBuilding: 'ON. The Mask is appearing; your real camera shows until it is there ...',
    onNoFace: (who) => 'ON, but I cannot see your face, so ' + who + ' is standing still. Sit in front of the camera.',
    onNoPicture: (who, cam) => 'ON, but no picture is coming from ' + cam + ', so ' + who + ' is standing still. Is the phone camera on?',
    onWaitPicture: (who, cam) => 'ON. Waiting for the picture from ' + cam + '; ' + who + ' stands still until it comes.',
    // the phone is off, asleep or its DroidCam app closed: the picture comes, but it is black or never changes
    asleep: (cam, droid) => 'The picture from ' + cam + ' is black or frozen. ' + (droid ? 'Wake the phone and open DroidCam on it.' : 'Check that the camera is on and not covered.'),
    onAsleep: (who, cam, droid) => 'ON, but the picture from ' + cam + ' is black or frozen, so ' + who + ' is standing still. ' + (droid ? 'Wake the phone and open DroidCam on it.' : 'Check that the camera is on and not covered.'),
    // the avatar page inside OBS never answered, even after its Refresh and a new address
    onSilent: (who) => 'ON, but OBS is not showing ' + who + ', so your real camera is still showing. Close OBS and open it again when you can; I connect again by myself.',
    // the Mask (the third choice): OBS's page could not draw it (its graphics are missing there)
    onNoMask: 'ON, but OBS cannot draw the Mask on this PC, so your real camera is still showing. Pick Ryo or Melanie instead.',
    offHint: 'Your real camera is showing. Press to become the character.',
    onHint: 'The character covers your camera. Press to show your real camera.',
  };
  const NOTE = {
    slowPath: 'Reading the camera the slower way. It still works.',
    busy: 'Your PC is very busy: the arms may lag behind.',               // Ryo / Melanie only: the Mask has no arms
    liftHands: (who) => 'Lift your hands into the camera and ' + who.charAt(0).toUpperCase() + who.slice(1) + ' copies them.',
    micBlocked: 'I cannot hear your microphone, so the mouth follows your face only.',
    otherPanel: 'The old control page is open too and is in charge. Click here to take over.',
    otherPhone: (name) => 'The scene on air shows your other phone (' + name + '). If that phone is you, pick it under More.',
  };
  // the Mask: where its music comes from, in plain words (one line under the Visualizer button)
  const SOUND = {
    pc: 'Music: the mask moves to what this PC plays.',
    obs: 'Music: the mask moves to the sound level OBS hears (loudness and beat only).',
    voice: 'Music: I hear no music from this PC, so the mask moves to your voice.',
    voiceNoMic: 'Music: I hear no music from this PC and no microphone, so the mask only follows your face.',
    starting: 'Music: getting ready to listen to this PC ...',
  };
  const MODE = {
    toViz: 'VISUALIZER', toVizHint: 'Break the face apart into a music visualizer.',
    toFace: 'FACE', toFaceHint: 'Bring your face back.',
  };
  const MASK = {
    label: 'the Mask', tile: 'Mask',
    bg: { black: 'Black', summer: 'Summer', ice: 'Ice', forge: 'Forge', nebula: 'Nebula', studio: 'Studio', street: 'Street' },
    // the small picture on each background's button (Ice is the one place a cold colour is allowed: his own exception)
    bgSwatch: {
      black: '#000', summer: 'linear-gradient(180deg, #5a1a0c, #d9641c 70%, #f2b23a)', ice: 'linear-gradient(180deg, #0b1a22, #6fb6c9 75%, #e8f6fa)',
      forge: 'linear-gradient(180deg, #120503, #3a0d04 62%, #f08a1c 66%, #2a0903 70%, #100402)',
      nebula: 'radial-gradient(120% 90% at 20% 15%, #c9541c, #6a0f0a 38%, #050203 72%)',
      studio: 'linear-gradient(180deg, #050505, #1a1918 64%, #f1ece8 66%, #2a2826 68%, #0a0a0a)',
      street: 'linear-gradient(90deg, #c8181c 0 5%, #0000 5% 88%, #f09a1c 88% 93%, #0000 93%), linear-gradient(180deg, #0a0404, #2a0a08 70%, #120505)',
    },
    viz: { orb: 'Orb', tunnel: 'Tunnel', yinyang: 'Yin-yang', ridges: 'Ridges', blackhole: 'Black hole', helix: 'Helix' },
    tryIdle: 'Each button does what a viewer on TikTok would cause. Nothing is sent to TikTok.',
    tryOff: 'Press ON first: the effects show on the character in OBS.',
    trySent: (what, who) => what + ': sent to ' + who + '.',
    tryMaskOnly: (what, who) => what + ': nothing shows on ' + who + '. Only the Mask reacts to that.',
    giftsSaved: 'Saved. It counts from the next gift.', giftsStandard: 'Back to the standard list.', giftsFailed: 'That was not saved. Try again.',
    giftName: 'Gift name (as TikTok shows it)', upTo: 'Up to', coins: 'coins', bigger: 'Anything bigger',
    restIdle: 'Do this once for the Mask: look at the camera with a relaxed face and your mouth closed, press the button and hold still for two seconds. Your expressions then show stronger.',
    restSaved: ' The Mask uses it too.',
    restCalmest: ' The Mask took the calmest moment of it for now.',
  };
  const FACE = {
    idle: 'Optional, only if the face looks off: look at the camera with a relaxed face and your mouth closed, press the button and hold still for two seconds.',
    hold: 'Hold still, relaxed face, mouth closed ...',
    done: 'Got it. This relaxed face is your resting face now. It is remembered for next time.',
    noPicture: 'Not read: I have no picture of you yet. Try again when the small picture shows you.',
    noAnswer: 'Not read: the face reader did not answer. Nothing was changed. Try again.',
    fix: { 'no-face': 'I cannot see your face', 'mouth-open': 'close your mouth', smiling: 'relax your mouth, no smile', 'eyes-closed': 'open your eyes', moving: 'keep your head still' },
    why: { 'no-face': 'no face was visible', 'mouth-open': 'your mouth was open', smiling: 'you were smiling', 'eyes-closed': 'your eyes were closed', moving: 'your head was moving' },
    rejected: (why) => 'Not read: ' + (why || 'I did not get two calm seconds') + '. Nothing was changed. Try again.',
  };
  const REMOVE = {
    ask: 'Remove VTuber from OBS', sure: 'Press again to remove it', back: 'Put VTuber back in OBS',
    hint: 'Takes the avatar out of your OBS scenes again. Nothing else in OBS is changed.',
    done: 'Removed. Your OBS scenes are as they were before VTuber.',
    failed: 'That did not work because OBS is not connected. Open OBS and try again.',
  };

  // ------------------------------------------------------------------ settings (kept between visits)
  // mask: the Mask is the chosen character (character keeps the hero picked last); maskBg / maskSounds: its background and gift sounds
  const settings = { character: 'ryo', bg: 'preset:courtyard', mirror: false, handsLine: false, sens: 6, gate: 0.06, zoom: 1, offsetY: 0, deviceId: '', mask: false, maskBg: 'black', maskSounds: true, maskViz: '', eyes: true };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') for (const k of Object.keys(settings)) if (typeof saved[k] === typeof settings[k]) settings[k] = saved[k];
  } catch (e) { /* defaults */ }
  if (!L.isCharacter(settings.character)) settings.character = 'ryo';
  if (!L.BACKGROUNDS.includes(settings.bg)) settings.bg = 'preset:courtyard';
  settings.handsLine = settings.handsLine === true;
  if (!L.MASK_BACKGROUNDS.includes(settings.maskBg)) settings.maskBg = 'black';
  if (!L.MASK_VISUALIZERS.includes(settings.maskViz)) settings.maskViz = '';
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* not saved */ } };

  const live = { on: false, mode: 'face' };          // mode: the Mask as his face, or as a visualizer (not kept between starts)
  const st = {
    srv: null, srvFails: 0, srvEver: false, relay: false, ackAt: -1e9, micOn: false, micFailed: false, level: 0,
    applied: '', forceShots: false, badSince: 0, recoveries: [], recovering: false, pictureWaitSince: performance.now(),
    maskAck: null, maskAckAt: -1e9, tryNote: '', giftsNote: '', gifts: null, giftsDirty: false, restSaved: false,
    removeArmed: 0, removeNote: '', faceLostAt: 0, fixingAt: -1e9, picture: new L.PictureWatch(), pictureState: 'ok', look: null, lastLuma: null, reloading: false,
  };

  // ------------------------------------------------------------------ the relay socket (the same messages control.html sends)
  let socket = null, retry = null, adopted = false;
  const send = (obj) => { if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj)); };
  const panel = { id: Math.random().toString(36).slice(2, 10), active: false, since: 0, otherAt: -1e9 };
  const announce = () => send({ t: 'panel', id: panel.id, since: panel.since });
  const avatarMessage = () => {
    const m = { t: 'avatar', on: live.on, character: settings.character, bg: settings.bg, face: 'auto', faceHoldMs: 0, mirror: settings.mirror, zoom: settings.zoom, offsetY: settings.offsetY };
    if (!settings.eyes) m.eyes = false;                   // eyes on camera (round 5): on unless switched off under More
    if (!settings.mask && !settings.maskSounds) m.sounds = false;   // gift sounds for the heroes' missiles: the same switch as the Mask's
    if (settings.mask) {                                  // the Mask instead of a hero: its mode, background, gift sounds, and the stamps of its two files
      const sm = st.srv && st.srv.mask;
      Object.assign(m, { mask: true, maskMode: live.mode, maskBg: settings.maskBg, maskSounds: settings.maskSounds, maskViz: settings.maskViz, maskGifts: sm ? sm.gifts : 0, maskRest: sm ? sm.rest : 0 });
    }
    return m;
  };
  const sendAvatar = () => send(avatarMessage());
  const sendHands = () => send({ t: 'hands-line', on: settings.handsLine });
  function claim() {
    if (panel.active) return;
    panel.active = true; panel.since = Date.now();
    announce();
    if (adopted) { sendAvatar(); sendHands(); }
    render();
  }
  function onPanel(m) {
    if (!m || m.id === panel.id) return;
    if (m.hello) { if (panel.active) announce(); return; }
    panel.otherAt = performance.now();
    const since = Number(m.since) || 0;
    if (panel.active && (since > panel.since || (since === panel.since && String(m.id) > panel.id))) { panel.active = false; render(); }
    else if (panel.active) announce();
  }
  function connect() {
    retry = null;
    try { socket = new WebSocket('ws://' + location.host + '/ws'); } catch (e) { socket = null; retry = setTimeout(connect, 1500); return; }
    socket.onopen = () => {
      st.relay = true; adopted = false;
      const mine = socket;
      send({ t: 'panel', id: panel.id, hello: true });
      setTimeout(() => {                                   // this page is the one in charge (the v2 control page only follows)
        if (socket !== mine) return;
        adopted = true;
        if (panel.active) { announce(); sendAvatar(); sendHands(); } else claim();
      }, 350);
    };
    socket.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'avatar-ack') {
        // with the Mask chosen only an answer about the Mask counts (and the other way round)
        if (settings.mask ? !!(m.mask && m.mask.drawn) : !m.mask) st.ackAt = performance.now();   // the Mask: only once it is really on screen
        if (m.mask && typeof m.mask === 'object') { st.maskAck = m.mask; st.maskAckAt = performance.now(); }
      }
      else if (m.t === 'panel') onPanel(m);
      else if (m.t === 'avatar') {
        const a = L.readAvatarMessage(m);
        if (!a) return;
        live.on = a.on;
        // Before this page is in charge the message is the newest state the server kept (this page was reloaded mid-show,
        // e.g. its window restarted): it is taken over whole, so an ON stays ON. Later: the v2 control page in charge,
        // or the server switching OFF.
        if (!adopted || !panel.active) {
          settings.character = a.character; settings.bg = a.bg; settings.mirror = a.mirror; settings.zoom = a.zoom; settings.offsetY = a.offsetY; settings.eyes = a.eyes !== false;
          settings.mask = a.mask === true;
          if (a.mask) { settings.maskBg = a.maskBg; settings.maskSounds = a.maskSounds; settings.maskViz = a.maskViz; live.mode = a.maskMode; }
          save();
        }
        render();
      } else if (m.t === 'hands-line' && !panel.active) { settings.handsLine = m.on === true; save(); render(); }
    };
    socket.onclose = () => { st.relay = false; socket = null; if (!retry) retry = setTimeout(connect, 1000); };
    socket.onerror = () => { try { socket && socket.close(); } catch (e) { /* closing */ } };
  }

  // ------------------------------------------------------------------ actions
  function setOn(on) { claim(); live.on = !!on; sendAvatar(); render(); }
  function setCharacter(id) {
    if (id === 'mask') { claim(); settings.mask = true; live.mode = 'face'; save(); sendAvatar(); render(); loadGifts(); return; }
    if (!L.isCharacter(id)) return;
    claim(); settings.character = id; settings.mask = false; save(); sendAvatar(); render();
  }
  // ------------------------------------------------------------------ the Mask: Visualizer / Face, background, sounds, the test buttons, the gift list
  function setMode(mode) { if (!settings.mask) return; claim(); live.mode = mode === 'visualizer' ? 'visualizer' : 'face'; sendAvatar(); render(); }
  function setMaskBg(bg) { if (!L.MASK_BACKGROUNDS.includes(bg)) return; claim(); settings.maskBg = bg; save(); sendAvatar(); render(); }
  function setMaskViz(v) { if (!L.MASK_VISUALIZERS.includes(v)) return; claim(); settings.maskViz = v; save(); sendAvatar(); render(); }
  function setGiftSounds(on) { claim(); settings.maskSounds = !!on; save(); sendAvatar(); render(); }
  // the Mask's backgrounds: the full known list from the start (js/logic.js); once the mask itself has told its own
  // (stats().backgrounds, by the avatar page in OBS), that one. Only names this page knows how to send are shown.
  let bgsShown = '';
  function renderMaskBgs() {
    const told = st.maskAck && Array.isArray(st.maskAck.bgs) ? st.maskAck.bgs.filter((n) => L.MASK_BACKGROUNDS.includes(n)) : null;
    const list = told && told.length ? told : bgsShown ? bgsShown.split('|') : L.MASK_BACKGROUNDS.slice(), box = $('maskBgs');
    if (!list.includes(settings.maskBg) && L.MASK_BACKGROUNDS.includes(settings.maskBg)) list.push(settings.maskBg);      // his saved pick is always there
    if (list.join('|') !== bgsShown) {
      bgsShown = list.join('|'); box.textContent = '';
      for (const bg of list) {
        const b = document.createElement('button');
        b.className = 'opt'; b.dataset.bg = bg; b.textContent = MASK.bg[bg] || (bg.charAt(0).toUpperCase() + bg.slice(1).replace(/-/g, ' '));
        b.style.background = MASK.bgSwatch[bg] || '#120d0b';
        b.addEventListener('click', () => { setMaskBg(bg); b.blur(); });
        box.appendChild(b);
      }
    }
    for (const b of box.children) b.classList.toggle('sel', b.dataset.bg === settings.maskBg);
  }
  // the Visualizer's styles: the full known list from the start (js/logic.js); once the mask has told its own, that one
  let vizShown = '';
  function renderViz() {
    const told = st.maskAck && Array.isArray(st.maskAck.viz) ? st.maskAck.viz.filter((n) => L.MASK_VISUALIZERS.includes(n)) : null;
    const list = told && told.length ? told : vizShown ? vizShown.split('|') : L.MASK_VISUALIZERS.slice(), box = $('maskVizs');
    $('vizBox').hidden = !list || list.length < 2;
    if (!list) return;
    if (list.join('|') !== vizShown) {
      vizShown = list.join('|'); box.textContent = '';
      for (const n of list) {
        const b = document.createElement('button');
        b.className = 'opt'; b.dataset.viz = n; b.textContent = MASK.viz[n] || (n.charAt(0).toUpperCase() + n.slice(1).replace(/-/g, ' '));
        b.addEventListener('click', () => { setMaskViz(n); b.blur(); });
        box.appendChild(b);
      }
    }
    const cur = settings.maskViz || list[0];
    for (const b of box.children) b.classList.toggle('sel', b.dataset.viz === cur);
  }
  const MASK_ONLY_TRY = { comment: true, boom: true };   // these two do nothing on the heroes: their buttons are hidden while a hero is picked
  async function tryEffect(kind) {
    const r = await post('try', { kind });
    const who = settings.mask ? 'the Mask' : settings.character === 'melanie' ? 'Melanie' : 'Ryo';
    // Ryo and Melanie show gifts, likes, a follower and a share; chat (a comment, "boom") shows on the Mask only
    st.tryNote = !(r && r.ok) ? MASK.tryOff : !settings.mask && MASK_ONLY_TRY[kind] ? MASK.tryMaskOnly(W.TRY_LABEL[kind], who) : MASK.trySent(W.TRY_LABEL[kind], who);
    render();
  }
  async function loadGifts() {
    if (st.giftsDirty) return;
    const g = await fetch('/api/vt/gifts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
    if (g && Array.isArray(g.rows)) { st.gifts = g.rows; renderGifts(); }
  }
  /** the rows as the list on the page has them now */
  function giftRows() {
    const rows = [];
    for (const el of $('gifts').children) {
      const effect = el.querySelector('select').value, name = el.querySelector('input[type=text]'), num = el.querySelector('input[type=number]');
      if (name) { if (name.value.trim()) rows.push({ gift: name.value.trim(), effect }); }
      else if (num) rows.push({ upTo: Math.max(0, Math.round(Number(num.value) || 0)), effect });
      else rows.push({ effect });
    }
    return rows;
  }
  function renderGifts() {
    const box = $('gifts');
    box.textContent = '';
    const pickEffect = (value) => {
      const sel = document.createElement('select');
      for (const e of W.EFFECTS) { const o = document.createElement('option'); o.value = e; o.textContent = W.EFFECT_LABEL[e]; sel.appendChild(o); }
      sel.value = value; sel.addEventListener('change', () => { st.giftsDirty = true; });
      return sel;
    };
    for (const r of st.gifts || []) {
      const row = document.createElement('div'); row.className = 'gift';
      if (r.gift) {
        const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 40; inp.value = r.gift; inp.placeholder = MASK.giftName; inp.autocomplete = 'off';
        inp.addEventListener('input', () => { st.giftsDirty = true; });
        const del = document.createElement('button'); del.className = 'plain'; del.textContent = 'x'; del.title = 'Remove';
        del.addEventListener('click', () => { st.giftsDirty = true; row.remove(); });
        row.append(inp, pickEffect(r.effect), del);
      } else if (r.upTo !== undefined) {
        const lab = document.createElement('label'), num = document.createElement('input'); num.type = 'number'; num.min = '0'; num.max = '1000000'; num.value = String(r.upTo);
        num.addEventListener('input', () => { st.giftsDirty = true; });
        lab.append(MASK.upTo, num, MASK.coins);
        row.append(lab, pickEffect(r.effect), document.createElement('span'));
      } else { const sp = document.createElement('span'); sp.textContent = MASK.bigger; row.append(sp, pickEffect(r.effect), document.createElement('span')); }
      box.appendChild(row);
    }
  }
  async function saveGifts(reset) {
    const g = await post('gifts', reset ? { reset: true } : { rows: giftRows() });
    if (g && Array.isArray(g.rows)) {
      st.gifts = g.rows; st.giftsDirty = false; st.giftsNote = reset ? MASK.giftsStandard : MASK.giftsSaved;
      if (st.srv && st.srv.mask && g.rev) st.srv.mask.gifts = g.rev;
      renderGifts(); sendAvatar();
    } else st.giftsNote = MASK.giftsFailed;
    render();
  }
  /** the raw results of the two calm seconds ("Read my resting face") -> the Mask's resting face, kept by the server */
  async function onMaskRest(m) {
    try {
      const Core = window.VTMaskCore;
      if (!Core || !W || !m || !Array.isArray(m.frames)) return;
      // two seconds the tracker did not accept (a smile, a word) never replace a resting face the Mask already has; with
      // none yet, the calmest moments of them are still far better than none (the mask picks them itself)
      if (m.ok === false && st.srv && st.srv.mask && st.srv.mask.rest) return;
      const frames = m.frames.map((b) => W.unpackFace(b)).filter((f) => f && f.lm && f.mat);
      if (frames.length < 12) return;
      const neutral = Core.calibrate(frames, W.BS_NAMES, { width: m.w || frames[0].w, height: m.h || frames[0].h });
      const r = await post('mask-rest', { neutral: { ...neutral, lm: Array.from(neutral.lm, (v) => Math.round(v * 1e5) / 1e5) } });
      if (r && r.ok) { st.restSaved = m.ok === false ? 'calmest' : true; if (st.srv && st.srv.mask) st.srv.mask.rest = r.rev; sendAvatar(); render(); }
    } catch (e) { /* the Mask keeps the resting face it had */ }
  }
  function hookTracker() { try { const w = frame.contentWindow; if (w && w.__trackerMaskRest !== onMaskRest) w.__trackerMaskRest = onMaskRest; } catch (e) { /* not there yet */ } }
  function setBg(bg) { claim(); settings.bg = bg; save(); sendAvatar(); render(); }
  const post = (what, body) => fetch('/api/vt/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => (r.ok ? r.json() : null), () => null);

  // ------------------------------------------------------------------ microphone (moves the mouth); starts by itself
  const mic = { ctx: null, stream: null, node: null, source: null };
  function levelFromRms(rms) {
    const db = 20 * Math.log10(Math.max(rms, 1e-7)) + settings.sens;
    const level = L.clamp((db + 54) / 42, 0, 1);
    return level < settings.gate ? 0 : level;
  }
  function pushLevel(level, bands) {
    st.level = level;
    if (!panel.active) return;
    const m = { t: 'mic', level: Math.round(level * 1000) / 1000, at: Date.now() };
    // V5: the four band levels of his voice (js/voice.js), so the avatar's mouth takes the vowel's shape; only while he is heard
    if (bands && level > 0) m.b = bands.map((v) => Math.round(v * 1e5) / 1e5);
    send(m);
  }
  async function listMics() {
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
    const sel = $('micDevice'), keep = settings.deviceId;
    sel.textContent = '';
    const def = document.createElement('option'); def.value = ''; def.textContent = 'Default microphone'; sel.appendChild(def);
    devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d, i) => {
      const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || ('Microphone ' + (i + 1)); sel.appendChild(o);
    });
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  }
  async function stopMic() {
    try { if (mic.node) { mic.node.port.onmessage = null; mic.node.disconnect(); } } catch (e) { /* gone */ }
    try { if (mic.source) mic.source.disconnect(); } catch (e) { /* gone */ }
    if (mic.stream) for (const t of mic.stream.getTracks()) t.stop();
    try { if (mic.ctx) await mic.ctx.close(); } catch (e) { /* gone */ }
    mic.ctx = mic.stream = mic.node = mic.source = null;
    if (st.micOn) pushLevel(0);
    st.micOn = false; st.level = 0;
  }
  async function startMic() {
    await stopMic();
    try {
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (settings.deviceId) audio.deviceId = { exact: settings.deviceId };
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      mic.ctx = new AudioContext({ latencyHint: 'interactive' });
      if (mic.ctx.state === 'suspended') { try { await mic.ctx.resume(); } catch (e) { /* resumes on the first click */ } }
      mic.source = mic.ctx.createMediaStreamSource(mic.stream);
      const silent = mic.ctx.createGain(); silent.gain.value = 0; silent.connect(mic.ctx.destination);      // this page never makes a sound
      let bands = false;
      try { await mic.ctx.audioWorklet.addModule('js/voice.js'); bands = true; } catch (e) { /* loudness only, as before */ }
      await mic.ctx.audioWorklet.addModule('js/mic-worklet.js');
      mic.node = new AudioWorkletNode(mic.ctx, 'vt-level', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { bands } });
      mic.node.port.onmessage = (e) => { const d = e.data; if (d && typeof d === 'object') pushLevel(levelFromRms(d.rms), d.b); else pushLevel(levelFromRms(d)); };
      mic.source.connect(mic.node); mic.node.connect(silent);
      st.micOn = true; st.micFailed = false;
      listMics();
    } catch (e) {
      await stopMic();
      if (settings.deviceId) { settings.deviceId = ''; save(); return startMic(); }       // the remembered microphone is gone: the default one
      st.micFailed = true;
    }
    render();
  }

  // ------------------------------------------------------------------ the tracker (the v2 tracker page, unseen, driven from here)
  const frame = $('trk');
  const T = () => { try { return frame.contentWindow && frame.contentWindow.__tracker ? frame.contentWindow.__tracker : null; } catch (e) { return null; } };
  const tstate = () => { const t = T(); if (!t) return null; try { return t.state(); } catch (e) { return null; } };
  const ready = (ts) => !!(ts && ts.info && ts.info.F && ts.info.F.ready);
  const WINDOW_WAIT_MS = 15000, PROBE_WAIT_MS = 12000;      // B2: how long Chrome gets to hand over the camera window
  /** Give the tracker the picture the server found: the camera's small OBS window, or (fallback) pictures asked one by one. */
  async function applyCapture() {
    const srv = st.srv, t = T(), ts = tstate();
    if (!srv || !t || !ready(ts) || st.recovering) return;
    const usable = srv.obs === 'ok' && srv.camera;
    const mode = !usable ? 'none' : st.forceShots || srv.capture.mode === 'shots' ? 'shots' : srv.capture.mode;
    const key = [mode, srv.camera, mode === 'window' ? srv.capture.hwnd : 0].join('|');
    const view = { turn: srv.view.turn, flip: srv.view.flip };
    if (key === st.applied) {                              // only the turn changed (another scene went on air): no restart
      if (mode === 'window' && (ts.settings.turn !== view.turn || ts.settings.flip !== view.flip)) t.set(view);
      if (mode === 'shots' && (ts.settings.obsTurn !== view.turn || ts.settings.obsFlip !== view.flip)) t.set({ obsTurn: view.turn, obsFlip: view.flip });
      return;
    }
    // the slower way is running and the server says the window may be tried again: asked for on the side first, so the
    // character keeps moving; only a window that really comes is switched to
    if (mode === 'window' && st.applied.startsWith('shots|') && st.probeOk !== key) { probeWindow(key); return; }
    st.applied = key; st.badSince = 0; st.pictureWaitSince = performance.now();
    if (mode === 'window') {
      t.set({ source: 'display', crop: 'auto', turn: view.turn, flip: view.flip, mirror: 'follow', line: 'follow' });
      st.recovering = true;
      let ok = false;
      const asked = t.startDisplay().catch(() => false);
      const within = (ms) => Promise.race([asked, new Promise((r) => setTimeout(() => r('late'), ms))]);
      let first = await within(4500), listSeen = null;
      // B2: a busy PC hands the window over late (seen: 5 - 7 s). The page waits up to 15 s in all, in yellow ("getting
      // the picture"), and meanwhile asks the server whether Chrome's share list is really on screen: only that ends the
      // wait early. A wait that just runs out is not a share list and is never counted against the next start.
      for (let waited = 4500; first === 'late' && waited < WINDOW_WAIT_MS && !listSeen; waited += 3500) {
        st.fixingAt = performance.now();
        first = await within(Math.min(3500, WINDOW_WAIT_MS - waited));
        if (first !== 'late') break;
        const r = await post('picker', { probe: true });
        if (r && r.closed) listSeen = r;
      }
      if (first === 'late') {
        // the server closes the list when it is a window of its own (then it counts); else it only notes "too late": the
        // slower way for a minute, after which the window is tried once more while the slower way keeps running
        const fresh = listSeen || await post('picker', {});
        const settled = await Promise.race([asked.then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))]);
        if (!settled) { st.reloading = true; location.reload(); return; }
        try { t.stopStream(); } catch (e) { /* ignore */ }
        st.recovering = false; st.applied = '';
        if (fresh) st.srv = fresh; else st.forceShots = true;
        return;
      }
      ok = first;
      st.recovering = false;
      const now = tstate();
      // Chrome names the window it captured ("window:<number>:0"): it must be the camera's window, not another one
      const got = now && /^window:(\d+):/.exec(now.trackLabel || '');
      if (!ok || (got && srv.capture.hwnd && Number(got[1]) !== srv.capture.hwnd)) { try { t.stopStream(); } catch (e) { /* ignore */ } windowFailed(); }
    } else if (mode === 'shots') {
      t.set({ source: 'obs', host: '127.0.0.1', port: srv.shotsPort, sourceName: srv.camera, obsView: 'manual', obsTurn: view.turn, obsFlip: view.flip, obsWidth: 540, obsFps: 30, mirror: 'follow', line: 'follow' });
      t.applySource();
    } else { try { t.stopStream(); } catch (e) { /* ignore */ } }
  }
  /** B2: while the slower way keeps running, ask Chrome for the camera window on the side. It comes: switch. It does not: the slower way stays for this run. */
  async function probeWindow(key) {
    if (st.probing) return;
    st.probing = true;
    let settled = false, got = null;
    try {
      const md = frame.contentWindow.navigator.mediaDevices;
      const asked = md.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { max: 5 } }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' })
        .then((x) => { settled = true; return x; }, () => { settled = true; return null; });
      asked.then((x) => { if (x) for (const tr of x.getTracks()) tr.stop(); });        // only a probe: never kept
      got = await Promise.race([asked, new Promise((r) => setTimeout(() => r('late'), PROBE_WAIT_MS))]);
    } catch (e) { settled = true; got = null; }
    if (got && got !== 'late') { st.probeOk = key; st.probing = false; applyCapture(); return; }
    const fresh = await post('picker', { retry: true });
    if (!settled) { await new Promise((r) => setTimeout(r, 1500)); if (!settled) { st.reloading = true; location.reload(); return; } }
    if (fresh) st.srv = fresh; else st.forceShots = true;
    st.probing = false;
  }
  /** The window path gave no picture: ask the server to look after the camera's window, try again; after three tries in a minute, the slower way. */
  async function windowFailed() {
    const now = performance.now();
    st.recoveries = st.recoveries.filter((x) => now - x < 60000);
    st.recoveries.push(now);
    st.fixingAt = now;                                    // the page says it is getting the picture again (not "is the phone on?")
    if (st.recoveries.length >= 3) { st.forceShots = true; st.applied = ''; return; }
    st.recovering = true;
    const fresh = await post('picture');
    st.recovering = false;
    if (fresh) st.srv = fresh;
    st.applied = '';
  }
  function watchPicture() {
    const ts = tstate(), now = performance.now();
    if (!ts || !ready(ts) || st.recovering || !st.applied.startsWith('window|')) { st.badSince = 0; return; }
    const bad = ts.status === 'NOT STARTED' || ts.status === 'NO FRAMES';
    if (!bad) { st.badSince = 0; return; }
    if (!st.badSince) st.badSince = now;
    if (now - st.badSince > 2500) { st.badSince = 0; try { T().stopStream(); } catch (e) { /* ignore */ } windowFailed(); }
  }

  // "Read my resting face": the v2 guided two-second capture, pressed inside the tracker; its result in this page's words
  function readFace() {
    const ts = tstate();
    hookTracker(); st.restSaved = false;
    try { frame.contentDocument.getElementById('calib').click(); } catch (e) { /* the tracker is not there yet */ }
    if (!ts) { $('faceText').textContent = FACE.noPicture; $('faceText').className = 'no'; }
    st.faceAsked = true;
    renderFace();
  }
  function renderFace() {
    const ts = tstate(), c = ts && ts.capture, el = $('faceText');
    $('faceBarWrap').hidden = !(c && c.state === 'collecting');
    const maskNeedsRest = settings.mask && st.srv && st.srv.mask && !st.srv.mask.rest;
    if (!c || !st.faceAsked || c.state === 'idle') { el.textContent = maskNeedsRest ? MASK.restIdle : FACE.idle; el.className = ''; return; }
    if (c.state === 'collecting') {
      $('faceBar').style.width = Math.round((c.progress || 0) * 100) + '%';
      el.textContent = FACE.hold + (c.reason && FACE.fix[c.reason] ? ' (' + FACE.fix[c.reason] + ')' : ''); el.className = '';
    } else if (c.state === 'done') { el.textContent = FACE.done + (st.restSaved === true ? MASK.restSaved : ''); el.className = 'done'; }
    else {
      el.className = 'no';
      el.textContent = (c.reason === 'no-picture' ? FACE.noPicture : c.reason === 'no-answer' ? FACE.noAnswer : FACE.rejected(FACE.why[c.reason])) + (settings.mask && st.restSaved === 'calmest' ? MASK.restCalmest : '');
    }
  }

  // the small picture: a copy of the tracker's own (the camera as it goes out, with the face dots)
  const pv = $('pv'), pctx = pv.getContext('2d');
  function drawPreview() {
    requestAnimationFrame(drawPreview);
    let src = null;
    try { src = frame.contentDocument && frame.contentDocument.getElementById('preview'); } catch (e) { src = null; }
    const ts = tstate();
    const flowing = ts && ts.stats && ts.stats.lastFrameAgo >= 0 && ts.stats.lastFrameAgo < 1500;
    if (!src || !src.width || !flowing) { pctx.fillStyle = '#000'; pctx.fillRect(0, 0, pv.width, pv.height); return; }
    const k = Math.min(pv.width / src.width, pv.height / src.height), w = src.width * k, h = src.height * k;
    pctx.fillStyle = '#000'; pctx.fillRect(0, 0, pv.width, pv.height);
    pctx.drawImage(src, (pv.width - w) / 2, (pv.height - h) / 2, w, h);
  }

  // the picture as it comes, looked at about every 0.7 s: black or never changing = the phone, not him (never "Ready",
  // never "sit in front of the camera" then). It is the tracker's raw small picture (before its dots are drawn: they
  // move a little even on a frozen picture), compared only when a new one came. Only while this window shows (the
  // tracker makes no small picture otherwise).
  const lookAt = { canvas: null, ctx: null };
  function lookAtPicture() {
    const ts = tstate(), now = performance.now();
    const flowing = ts && ready(ts) && ts.stats && ts.stats.lastFrameAgo >= 0 && ts.stats.lastFrameAgo < 1500;
    let img = null;
    try { const tr = frame.contentWindow && frame.contentWindow.__tracker; img = tr && tr.picture ? tr.picture() : null; } catch (e) { img = null; }
    if (!flowing || !img || !img.width || document.visibilityState !== 'visible') { st.picture.reset(); st.pictureState = 'ok'; st.lastLuma = null; st.lastImg = null; return; }
    if (img === st.lastImg) return;                                       // no new picture since the last look
    st.lastImg = img;
    const w = 180, h = Math.max(2, Math.round(w * img.height / img.width));
    if (!lookAt.canvas) { lookAt.canvas = document.createElement('canvas'); lookAt.ctx = lookAt.canvas.getContext('2d', { willReadFrequently: true }); }
    if (lookAt.canvas.width !== w || lookAt.canvas.height !== h) { lookAt.canvas.width = w; lookAt.canvas.height = h; st.lastLuma = null; }
    let data;
    try { lookAt.ctx.drawImage(img, 0, 0, w, h); data = lookAt.ctx.getImageData(0, 0, w, h).data; } catch (e) { return; }   // replaced meanwhile
    const luma = L.lumaOf(data, w, h, 1, false);
    st.look = L.pictureLook(luma, st.lastLuma && st.lastLuma.length === luma.length ? st.lastLuma : null);
    st.lastLuma = luma;
    st.pictureState = st.picture.feed(st.look, now);
  }

  // ------------------------------------------------------------------ B3: the reader's numbers ride on the pulse (numbers only)
  // updates/s, body checks/s, % of body checks that saw a hand since the last pulse (-1: none ran), OBS answer ms (the
  // slower way only), the load step, pictures/s; ok=1: the camera window is being read and pictures are coming.
  const hands = { last: null, log: [] };            // log: [time, body checks, checks with a hand] per pulse, two minutes
  function pulseNumbers() {
    const ts = tstate(), s = ts && ts.stats;
    if (!s || !s.frames) return '';
    const now = performance.now(), f = s.frames, prev = hands.last;
    let share = -1;
    if (prev && f.body >= prev.body && typeof f.hand === 'number') {
      const db = f.body - prev.body, dh = f.hand - prev.hand;
      if (db > 0) share = Math.round(100 * dh / db);
      hands.log.push([now, db, Math.max(0, dh), s.faceFound ? 1 : 0]);
      while (hands.log.length && now - hands.log[0][0] > L.HANDS_HINT.windowMs) hands.log.shift();
    } else hands.log.length = 0;                     // the reader restarted: counted from now
    hands.last = { body: f.body, hand: typeof f.hand === 'number' ? f.hand : 0 };
    const ok = ts.capturing && ts.streamKind === 'display' && s.lastFrameAgo >= 0 && s.lastFrameAgo < 1500 ? '&ok=1' : '';
    const n = (v, d = 1) => (Number.isFinite(v) ? Number(v).toFixed(d) : '0');
    return ok + '&r=' + [n(s.perfFps || s.faceFps), n(s.bodyFps), share, ts.settings && ts.settings.source === 'obs' ? n(s.ms && s.ms.rpc, 0) : 0, s.shedLevel || 0, n(s.inFps)].join(',');
  }

  // ------------------------------------------------------------------ the server's news, once a second (also this page's pulse)
  let polling = false;
  // V6: inside LIVE Link (the server says embedded) there is no VTuber.bat to double-click: the same three sentences
  // name LIVE Link's own button instead. Set once; nothing changes for VTuber.bat.
  function wordsFor(srv) {
    if (!srv || srv.embedded !== true || SAY.embedded) return;
    SAY.embedded = true;
    SAY.stopped = 'VTuber has stopped. Close this window and press Open VTuber in LIVE Link.';
    SAY.addFailed = 'I could not add the avatar to OBS. Close this window and press Open VTuber in LIVE Link.';
    SAY.readerFailed = 'The face reader could not start. Close this window and press Open VTuber in LIVE Link.';
  }
  async function poll() {
    if (polling) return;
    polling = true;
    let srv = null;
    const stopper = new AbortController(), cut = setTimeout(() => stopper.abort(), 2500);
    try { const r = await fetch('/api/vt/state?hb=1&cap=' + encodeURIComponent(st.applied) + pulseNumbers(), { cache: 'no-store', signal: stopper.signal }); if (r.ok) { srv = await r.json(); wordsFor(srv); } } catch (e) { srv = null; }
    clearTimeout(cut);
    polling = false;
    if (srv) { st.srv = srv; st.srvFails = 0; st.srvEver = true; hookTracker(); } else st.srvFails++;
    if (srv) { if (srv.capture.mode === 'window' && st.forceShots && !st.recoveries.length) st.forceShots = false; applyCapture(); watchPicture(); }
    render();
  }

  // ------------------------------------------------------------------ the one sentence
  function sentence() {
    const srv = st.srv, who = settings.mask ? MASK.label : L.CHARACTERS[settings.character].label;
    if (st.srvFails >= 3 || (!srv && st.srvFails >= 1 && st.srvEver)) return ['bad', SAY.stopped];
    if (!srv) return ['wait', SAY.starting];
    if (srv.obs === 'closed') return ['wait', SAY.obsClosed];
    if (srv.obs === 'off') return ['bad', SAY.obsOff];
    if (srv.obs === 'password') return ['bad', SAY.obsPassword];
    if (!srv.camera) return ['bad', SAY.noCamera];
    const cam = srv.camera, ts = tstate();
    if (srv.avatar.removed) return ['wait', SAY.removed];
    if (srv.avatar.problem === 'name-taken') return ['bad', SAY.nameTaken];
    if (srv.avatar.problem === 'failed') return ['bad', SAY.addFailed];
    if (srv.avatar.problem === 'not-visible') return ['bad', SAY.hidden(cam)];
    if (live.on && srv.avatar.silent) return ['bad', SAY.onSilent(who)];
    if (live.on && settings.mask && st.maskAck && st.maskAck.error && st.maskAck.error !== 'loading' && performance.now() - st.maskAckAt < 4000) return ['bad', SAY.onNoMask];
    if (ts && ts.status === 'TRACKER ERROR') return ['bad', SAY.readerFailed];
    if (!ready(ts)) { st.pictureWaitSince = performance.now(); return ['wait', SAY.loading]; }   // the wait for a picture starts once the reader is there
    const s = ts.stats, flowing = s && s.lastFrameAgo >= 0 && s.lastFrameAgo < 1500;
    if (!flowing) {
      // a short wait (the picture is starting) or the page is getting the camera's window back: say so, in yellow;
      // only a picture that stays away is red. A face missing before the gap does not count after it.
      st.faceLostAt = 0;
      const now = performance.now(), waited = now - st.pictureWaitSince, fixing = now - st.fixingAt < 15000;
      if (live.on) return fixing || waited < 4000 ? ['wait', SAY.onWaitPicture(who, cam)] : ['bad', SAY.onNoPicture(who, cam)];
      if (fixing) return ['wait', SAY.fixing(cam)];
      return [waited > 8000 ? 'bad' : 'wait', waited > 8000 ? SAY.noPicture(cam) : SAY.waitPicture(cam)];
    }
    st.pictureWaitSince = performance.now();
    if (st.pictureState !== 'ok') {
      const c = (srv.cameras || []).find((x) => x.name === cam), droid = !c || c.kind === 'droidcam_obs';
      return ['bad', live.on ? SAY.onAsleep(who, cam, droid) : SAY.asleep(cam, droid)];
    }
    // the face lost for a moment (a turn, a hand) does not change the sentence; only after 1.5 s
    // a picture turning black is no face lost: "sit in front of the camera" waits while it may be the phone going dark
    if (!s.faceFound && !st.picture.darkSince) { if (!st.faceLostAt) st.faceLostAt = performance.now(); } else st.faceLostAt = 0;
    if (st.faceLostAt && performance.now() - st.faceLostAt > 1500) return ['bad', live.on ? SAY.onNoFace(who) : SAY.noFace(cam)];
    if (!live.on) return ['good', SAY.ready(cam, who)];
    return ['live', performance.now() - st.ackAt < 4000 ? SAY.on(who) : settings.mask ? SAY.onMaskBuilding : SAY.onWaiting(who)];
  }
  function notes() {
    const out = [], ts = tstate();
    if (st.applied.startsWith('shots|')) out.push(NOTE.slowPath);
    if (!settings.mask && ts && (ts.bodySlow || (ts.stats && ts.stats.shedLevel > 0))) out.push(NOTE.busy);
    // B1: his hands are rarely in the camera picture (measured, the last two minutes): one plain hint, heroes only
    if (!settings.mask && L.handsRarelySeen(hands.log)) out.push(NOTE.liftHands(L.CHARACTERS[settings.character].label));
    if (st.micFailed) out.push(NOTE.micBlocked);
    if (live.on && st.srv && st.srv.onAirOther) out.push(NOTE.otherPhone(st.srv.onAirOther));
    if (adopted && !panel.active) out.push(NOTE.otherPanel);
    if (st.removeNote) out.push(st.removeNote);
    return out;
  }

  // ------------------------------------------------------------------ drawing the page
  function build() {
    const box = $('heroes');
    for (const id of [...Object.keys(L.CHARACTERS), 'mask']) {
      const b = document.createElement('button');
      b.className = 'hero'; b.dataset.id = id;
      const img = document.createElement('img'); img.src = id === 'mask' ? 'assets/ui/mask.svg' : 'assets/ui/' + id + '.jpg'; img.alt = '';
      const name = document.createElement('span'); name.textContent = id === 'mask' ? MASK.tile : L.CHARACTERS[id].label;
      b.append(img, name);
      b.addEventListener('click', () => { setCharacter(id); b.blur(); });
      box.appendChild(b);
    }
    renderMaskBgs();
    for (const kind of Object.keys(W.TRY_EVENTS)) {
      const b = document.createElement('button');
      b.className = 'plain'; b.dataset.kind = kind; b.textContent = W.TRY_LABEL[kind];
      b.addEventListener('click', () => { tryEffect(kind); b.blur(); });
      $('tries').appendChild(b);
    }
    const bgs = $('bgs');
    for (const bg of L.BACKGROUNDS) {
      const b = document.createElement('button');
      b.className = 'opt'; b.dataset.bg = bg; b.textContent = BG_LABEL[bg];
      if (bg === 'green') { b.style.background = '#00c800'; } else if (bg === 'black') b.style.background = '#000';
      else if (bg.startsWith('preset:')) b.style.backgroundImage = 'linear-gradient(180deg, #0000 20%, #000c), url("assets/bg/' + bg.slice(7) + '.webp")';
      b.addEventListener('click', () => { setBg(bg); b.blur(); });
      bgs.appendChild(b);
    }
  }
  let camsShown = '';
  function renderCams() {
    const srv = st.srv, box = $('cams');
    if (!srv) return;
    const key = srv.cameras.map((c) => c.name + ':' + (c.scenes || []).join(',')).join('\n') + '|' + srv.camera;
    if (key !== camsShown) {
      camsShown = key;
      box.textContent = '';
      for (const c of srv.cameras) {
        const b = document.createElement('button');
        b.className = 'plain cam' + (c.name === srv.camera ? ' opt sel' : ''); b.dataset.name = c.name;
        const img = document.createElement('img'); img.alt = '';
        const name = document.createElement('span'); name.textContent = c.name;
        // which phone is which: the scenes this camera shows in
        const where = document.createElement('small'); const sc = c.scenes || [];
        where.textContent = sc.length ? 'In: ' + sc.slice(0, 3).join(', ') + (sc.length > 3 ? ' and ' + (sc.length - 3) + ' more' : '') : 'Not shown in any scene';
        b.title = sc.length ? c.name + ' shows in: ' + sc.join(', ') : c.name;
        b.append(img, name, where);
        b.addEventListener('click', async () => { b.blur(); const fresh = await post('camera', { name: c.name }); if (fresh) { st.srv = fresh; st.forceShots = false; st.recoveries = []; } render(); });
        box.appendChild(b);
      }
      $('camHint').textContent = srv.camera ? 'Watching you through ' + srv.camera + '. Click another picture if that is not you.' : '';
    }
    if ($('more').open && srv.obs === 'ok') for (const b of box.children) b.firstChild.src = '/api/vt/shot?name=' + encodeURIComponent(b.dataset.name) + '&t=' + Date.now();
  }
  function render() {
    const [cls, text] = sentence();
    $('status').className = cls;
    $('sentence').textContent = text;
    const n = notes();
    $('note').hidden = !n.length; $('note').textContent = n.join('\n');
    $('pwbox').hidden = !(st.srv && st.srv.obs === 'password');
    for (const b of $('heroes').children) b.classList.toggle('sel', settings.mask ? b.dataset.id === 'mask' : b.dataset.id === settings.character);
    // the Mask's own controls show only while the Mask is chosen (the heroes' framing only while a hero is)
    $('maskMain').hidden = !settings.mask; $('maskMore').hidden = !settings.mask; $('heroMore').hidden = settings.mask;
    const viz = live.mode === 'visualizer';
    $('mode').classList.toggle('viz', viz);
    $('modeText').textContent = viz ? MODE.toFace : MODE.toViz; $('modeHint').textContent = viz ? MODE.toFaceHint : MODE.toVizHint;
    const snd = st.srv && st.srv.mask ? st.srv.mask.sound : null;
    $('sound').textContent = !settings.mask || !snd ? '' : snd.src === 'pc' ? SOUND.pc : snd.src === 'obs' ? SOUND.obs : snd.pc === 'starting' ? SOUND.starting : st.micOn ? SOUND.voice : SOUND.voiceNoMic;
    renderMaskBgs();
    $('giftSounds').classList.toggle('sel', settings.maskSounds);
    renderViz();
    for (const b of $('tries').children) b.hidden = !settings.mask && !!MASK_ONLY_TRY[b.dataset.kind];
    $('tryHint').textContent = st.tryNote || MASK.tryIdle; $('giftsNote').textContent = st.giftsNote;
    for (const b of $('bgs').children) b.classList.toggle('sel', b.dataset.bg === settings.bg);
    $('power').classList.toggle('on', live.on);
    $('powerText').textContent = live.on ? 'ON' : 'OFF';
    $('powerHint').textContent = live.on ? SAY.onHint : SAY.offHint;
    $('mirror').classList.toggle('sel', settings.mirror);
    $('eyes').classList.toggle('sel', settings.eyes);
    $('hands').classList.toggle('sel', settings.handsLine);
    $('zoom').value = settings.zoom; $('zoomVal').textContent = Math.round(settings.zoom * 100) + '%';
    $('offy').value = settings.offsetY; $('offyVal').textContent = (settings.offsetY > 0 ? '+' : '') + Math.round(settings.offsetY * 100);
    $('micLabel').textContent = st.micOn ? 'Microphone' : st.micFailed ? 'Microphone: not heard' : 'Microphone ...';
    const removed = st.srv && st.srv.avatar.removed;
    $('remove').textContent = removed ? REMOVE.back : performance.now() < st.removeArmed ? REMOVE.sure : REMOVE.ask;
    renderFace();
  }

  // ------------------------------------------------------------------ wiring
  build();
  window.addEventListener('pointerdown', claim, true);
  window.addEventListener('keydown', claim, true);
  $('power').addEventListener('click', () => { setOn(!live.on); $('power').blur(); });
  $('face').addEventListener('click', () => { readFace(); $('face').blur(); });
  $('mode').addEventListener('click', () => { setMode(live.mode === 'visualizer' ? 'face' : 'visualizer'); $('mode').blur(); });
  $('giftSounds').addEventListener('click', () => { setGiftSounds(!settings.maskSounds); $('giftSounds').blur(); });
  $('giftAdd').addEventListener('click', () => { st.gifts = [{ gift: ' ', effect: 'barrage' }, ...giftRows()]; st.giftsDirty = true; renderGifts(); const f = $('gifts').querySelector('input[type=text]'); if (f) { f.value = ''; f.focus(); } });
  $('giftSave').addEventListener('click', () => { saveGifts(false); $('giftSave').blur(); });
  $('giftReset').addEventListener('click', () => { st.giftsDirty = false; saveGifts(true); $('giftReset').blur(); });
  frame.addEventListener('load', hookTracker);
  $('eyes').addEventListener('click', () => { claim(); settings.eyes = !settings.eyes; save(); sendAvatar(); render(); $('eyes').blur(); });
  $('mirror').addEventListener('click', () => { claim(); settings.mirror = !settings.mirror; save(); sendAvatar(); render(); $('mirror').blur(); });
  $('hands').addEventListener('click', () => { claim(); settings.handsLine = !settings.handsLine; save(); sendHands(); render(); $('hands').blur(); });
  $('zoom').addEventListener('input', (e) => { claim(); settings.zoom = Number(e.target.value); save(); sendAvatar(); render(); });
  $('offy').addEventListener('input', (e) => { claim(); settings.offsetY = Number(e.target.value); save(); sendAvatar(); render(); });
  $('micDevice').addEventListener('change', (e) => { settings.deviceId = e.target.value; save(); startMic(); });
  $('more').addEventListener('toggle', renderCams);
  $('more').addEventListener('toggle', () => { if ($('more').open) loadGifts(); });
  $('pwgo').addEventListener('click', async () => { const el = $('pw'); if (!el.value) return; await post('password', { password: el.value }); el.value = ''; });
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwgo').click(); });
  $('remove').addEventListener('click', async () => {
    $('remove').blur();
    if (st.srv && st.srv.avatar.removed) { const fresh = await post('add'); if (fresh) st.srv = fresh; st.removeNote = ''; render(); return; }
    if (performance.now() >= st.removeArmed) { st.removeArmed = performance.now() + 5000; render(); setTimeout(render, 5100); return; }
    st.removeArmed = 0;
    live.on = false; sendAvatar();
    const fresh = await post('remove');
    if (fresh) { st.srv = fresh; st.removeNote = REMOVE.done; } else st.removeNote = REMOVE.failed;
    render();
  });
  // Space = ON / OFF while this window is in front
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) return;
    e.preventDefault();
    setOn(!live.on);
    if (document.activeElement && document.activeElement.blur && tag !== 'BODY') document.activeElement.blur();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && !(e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range')) e.preventDefault(); });
  // closing the window: the avatar goes off at once (the server also notices by itself within 3 s)
  window.addEventListener('pagehide', () => { if (st.reloading) return; try { navigator.sendBeacon('/api/vt/bye', new Blob(['{}'], { type: 'text/plain' })); } catch (e) { /* the server notices anyway */ } });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listMics);
  // an AudioContext made before any click may wait for one
  window.addEventListener('pointerdown', () => { if (mic.ctx && mic.ctx.state === 'suspended') mic.ctx.resume().catch(() => {}); }, true);

  render();
  connect();
  startMic();
  poll();
  // the pulse: a worker's tick (keeps going while the window is minimised); the page's own timer if no worker starts
  let ticks = 0;
  const tick = () => {
    ticks++;
    if (ticks % 2 === 0) poll();                                            // ~0.7 s: the server's news + this page's pulse
    else lookAtPicture();                                                   // ~0.7 s: is the picture black or frozen?
    if (ticks % 3 === 0 && adopted && panel.active) { announce(); sendAvatar(); sendHands(); }   // ~1 s
  };
  try { const w = new Worker('js/vt-tick.js'); w.onmessage = tick; w.onerror = () => { w.terminate(); setInterval(tick, 350); }; }
  catch (e) { setInterval(tick, 350); }
  setInterval(() => { $('micBar').style.width = (st.level * 100).toFixed(1) + '%'; }, 50);
  setInterval(renderCams, 2000);
  requestAnimationFrame(drawPreview);
  loadGifts();
  window.__vt = { settings, live, st, panel, SAY, NOTE, FACE, REMOVE, SOUND, MODE, MASK, setMode, setMaskBg, setMaskViz, setGiftSounds, tryEffect, saveGifts, giftRows, onMaskRest, setOn, setCharacter, setBg, readFace, sentence: () => sentence()[1], cls: () => sentence()[0], notes, tracker: tstate };
})();
