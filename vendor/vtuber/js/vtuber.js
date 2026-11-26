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
    noCamera: 'I could not find a camera I know in OBS. I work with DroidCam and Video Capture Device sources. Add yours to a scene and I will find it by myself.',
    pickCamera: 'OBS has more than one camera. Click the picture below that shows you. I only ask this once.',
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
    onNoMask: 'ON, but OBS cannot draw the Mask on this computer, so your real camera is still showing. Pick Ryo or Melanie instead.',
    offHint: 'Your real camera is showing. Press to become the character.',
    onHint: 'The character covers your camera. Press to show your real camera.',
  };
  const NOTE = {
    slowPath: 'Reading the camera the slower way. It still works.',
    busy: 'Your computer is very busy: the arms may lag behind.',               // Ryo / Melanie only: the Mask has no arms
    liftHands: (who) => 'Lift your hands into the camera and ' + who.charAt(0).toUpperCase() + who.slice(1) + ' copies them.',
    micBlocked: 'I cannot hear your microphone, so the mouth follows your face only.',
    otherPanel: 'The old control page is open too and is in charge. Click here to take over.',
    otherPhone: (name) => 'The scene on air shows your other phone (' + name + '). If that phone is you, pick it under More.',
  };
  // the Mask: where its music comes from, in plain words (one line under the Visualizer button)
  const SOUND = {
    pc: 'Music: the mask moves to what this computer plays.',
    obs: 'Music: the mask moves to the sound level OBS hears (loudness and beat only).',
    voice: 'Music: I hear no music from this computer, so the mask moves to your voice.',
    voiceNoMic: 'Music: I hear no music from this computer and no microphone, so the mask only follows your face.',
    starting: 'Music: getting ready to listen to this computer ...',
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
  // V7: move and size, the Mask's colour, shuffle to the beat (every sentence a first-time host reads)
  const PLACE = {
    title: (who) => 'Where ' + who + ' sits in the picture',
    hint: (who) => 'Drag ' + who + ' in the picture to move. To make ' + who + ' bigger or smaller, click the picture first, then scroll on it (or pinch). The background stays where it is.',
    real: 'This is the picture OBS shows right now.',
    stale: 'The picture from a moment ago. Move the mouse over it to see it live.',
    ghost: (who) => 'The circle shows where ' + who + ' will sit. Press ON to see the real picture here.',
    reset: 'Reset: back to the middle',
  };
  const COLOUR = {
    auto: 'Auto', autoName: 'Auto: crimson; the music and your face shift it.',
    picked: (name) => name + '.', own: 'Your own colour',
    hint: 'Auto is crimson, and the music and your face shift it. Tap a colour to pick your own.',
    musicOn: 'On: your colour still gets brighter on the drop, flashes when the music is wild, and warms with a smile.',
    musicOff: 'Off: your colour holds still. (The mask still moves to the music.)',
    wheelOpen: 'Any other colour ...', wheelClose: 'Hide the colour wheel',
  };
  const SHUFFLE = {
    amounts: { calm: 'Calm', normal: 'Normal', wild: 'Wild' },
    mask: 'When the music changes, the look changes with it: the background, the visualizer style, the colour (while it is on Auto), and Face / Visualizer. Calm = now and then, Wild = often. Never in the middle of a gift.',
    hero: (who) => 'When the music changes, the background changes with it (Sunset Courtyard, Jungle Grove, Moonlit Citadel), and a light pulses on ' + who + ' to the beat. Calm = now and then, Wild = often.',
    heroOwnBg: (who) => 'A light pulses on ' + who + ' to the beat. To let the background change too, pick one of the three places under More.',
    off: '', needOn: 'It starts when you press ON.',
    waiting: 'Listening for music from this computer ...',
    beat: (bpm) => 'Following the beat: ' + bpm + ' a minute.',
    voice: 'I hear no music from this computer, so nothing changes. Play music on this computer.',
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
  // V7: place = where each of the three sits and how big (each keeps its own); maskColour '' = Auto, else '#rrggbb';
  // maskColourMusic = the music still moves a picked colour; shuffle / shuffleAmount = shuffle to the beat
  const settings = { character: 'ryo', bg: 'preset:courtyard', mirror: false, handsLine: false, sens: 6, gate: 0.06, zoom: 1, offsetY: 0, deviceId: '', mask: false, maskBg: 'black', maskSounds: true, maskViz: '', eyes: true,
    place: { ryo: { zoom: 1, x: 0, y: 0 }, melanie: { zoom: 1, x: 0, y: 0 }, mask: { zoom: 1, x: 0, y: 0 } }, maskColour: '', maskColourMusic: true, shuffle: false, shuffleAmount: 'normal', wheelOpen: false,
    // V8: the puppet show's switches (kept between starts), its keys, and which vote the Vote button starts
    v8: { ...L.V8_DEFAULTS }, v8Keys: { ...L.V8_KEYS }, v8Vote: 'random' };
  // the kill switches of this round, as on the avatar page: ?place=0 ?colour=0 ?shuffle=0 (the control is not shown and nothing of it is sent)
  // V8: ?v8=0 = no puppet show at all (the card is not shown, nothing of it is sent: the avatar page then draws the V7 Mask, untouched)
  const QS = new URLSearchParams(location.search), KILL = { place: QS.get('place') === '0', colour: QS.get('colour') === '0', shuffle: QS.get('shuffle') === '0', v8: QS.get('v8') === '0' || !window.VTShow };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(settings)) if (typeof saved[k] === typeof settings[k]) settings[k] = saved[k];
      // settings saved before V7 had one Size / Height for both heroes: both start from it
      if (!saved.place || typeof saved.place !== 'object') settings.place = { ryo: { zoom: settings.zoom, x: 0, y: settings.offsetY }, melanie: { zoom: settings.zoom, x: 0, y: settings.offsetY }, mask: { zoom: 1, x: 0, y: 0 } };
    }
  } catch (e) { /* defaults */ }
  { const p = settings.place && typeof settings.place === 'object' ? settings.place : {}; settings.place = { ryo: L.cleanPlace(p.ryo, 'hero'), melanie: L.cleanPlace(p.melanie, 'hero'), mask: L.cleanPlace(p.mask, 'mask') }; }   // a place saved beyond the limits is pulled back
  settings.maskColour = L.cleanHex(settings.maskColour);
  if (!L.SHUFFLE_LEVELS.includes(settings.shuffleAmount)) settings.shuffleAmount = 'normal';
  if (!L.isCharacter(settings.character)) settings.character = 'ryo';
  if (!L.BACKGROUNDS.includes(settings.bg)) settings.bg = 'preset:courtyard';
  settings.handsLine = settings.handsLine === true;
  if (!L.MASK_BACKGROUNDS.includes(settings.maskBg)) settings.maskBg = 'black';
  if (!L.MASK_VISUALIZERS.includes(settings.maskViz)) settings.maskViz = '';
  settings.v8 = L.cleanV8(settings.v8); settings.v8Keys = L.cleanKeys(settings.v8Keys);      // V8: whatever was saved, made valid
  if (typeof settings.v8Vote !== 'string' || settings.v8Vote.length > 12) settings.v8Vote = 'random';
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* not saved */ } };

  const live = { on: false, mode: 'face', pick: 0 }; // mode: the Mask as his face, or as a visualizer (not kept between starts); pick: see avatarMessage
  /** which of the three is picked ('ryo' | 'melanie' | 'mask') and where it sits */
  const who = () => (settings.mask ? 'mask' : settings.character);
  const placeNow = () => (KILL.place ? L.PLACE_HOME : settings.place[who()]);
  const shuffleOn = () => settings.shuffle && !KILL.shuffle;
  // Fix round S2: the avatar page makes the small picture only while he is AT THE CARD: a press, a drag, a slider, the
  // wheel, the mouse moving over the picture, and five seconds after. With the window open and untouched none is made
  // (the last one stays on the page). Making one costs the avatar page part of a frame.
  const CARD_MS = 5000;
  let cardAt = -1e9, cardTimer = null;
  const atCard = () => !KILL.place && document.visibilityState === 'visible' && performance.now() - cardAt < CARD_MS;
  function touchCard() {
    const was = atCard();
    cardAt = performance.now();
    if (!was && adopted && panel.active) sendAvatar();                          // the picture is wanted from now
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { if (adopted && panel.active) sendAvatar(); }, CARD_MS + 50);   // and no longer after five quiet seconds
  }
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
    const pl = placeNow();
    const m = { t: 'avatar', on: live.on, character: settings.character, bg: settings.bg, face: 'auto', faceHoldMs: 0, mirror: settings.mirror, zoom: pl.zoom, offsetY: pl.y };
    if (pl.x) m.offsetX = pl.x;                           // V7: left-right (a message without it = the middle, as before)
    if (shuffleOn()) { m.shuffle = settings.shuffleAmount; if (live.pick) m.pick = live.pick; }   // pick: he chose a look himself while shuffle runs: shown at once
    if (atCard()) m.pv = true;                            // the small picture: only while he is at the card (fix round S2), never all show
    if (!settings.eyes) m.eyes = false;                   // eyes on camera (round 5): on unless switched off under More
    if (!settings.mask && !settings.maskSounds) m.sounds = false;   // gift sounds for the heroes' missiles: the same switch as the Mask's
    if (settings.mask) {                                  // the Mask instead of a hero: its mode, background, gift sounds, and the stamps of its two files
      const sm = st.srv && st.srv.mask;
      Object.assign(m, { mask: true, maskMode: live.mode, maskBg: settings.maskBg, maskSounds: settings.maskSounds, maskViz: settings.maskViz, maskGifts: sm ? sm.gifts : 0, maskRest: sm ? sm.rest : 0 });
      if (settings.maskColour && !KILL.colour) { m.maskColour = settings.maskColour; if (!settings.maskColourMusic) m.maskColourMusic = false; }
      if (!KILL.v8) m.v8 = { ...settings.v8 };            // V8: the puppet show's switches (no field = the avatar page draws the V7 Mask)
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
        else { st.heroAck = m; st.heroAckAt = performance.now(); }
        // V7: the small picture of what OBS shows (a tiny JPEG made by the avatar page on this PC)
        if (typeof m.pv === 'string' && m.pv.length < 80000 && m.pv.startsWith('data:image/jpeg;base64,')) { const im = new Image(), of = who(); st.pvCount = (st.pvCount || 0) + 1; im.onload = () => { st.pvImg = im; st.pvAt = performance.now(); st.pvWho = of; }; im.src = m.pv; }
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
          settings.character = a.character; settings.bg = a.bg; settings.mirror = a.mirror; settings.eyes = a.eyes !== false;
          settings.mask = a.mask === true;
          if (!KILL.place) settings.place[who()] = L.cleanPlace({ zoom: a.zoom, x: a.offsetX || 0, y: a.offsetY }, settings.mask ? 'mask' : 'hero');   // (?place=0 never saves "home" over his place)
          settings.shuffle = !!a.shuffle; if (a.shuffle) settings.shuffleAmount = a.shuffle;
          if (a.mask && a.v8) settings.v8 = L.cleanV8(a.v8);
          if (a.mask) { settings.maskBg = a.maskBg; settings.maskSounds = a.maskSounds; settings.maskViz = a.maskViz; live.mode = a.maskMode; settings.maskColour = a.maskColour || ''; settings.maskColourMusic = a.maskColourMusic !== false; }
          save();
        }
        render();
      } else if (m.t === 'hands-line' && !panel.active) { settings.handsLine = m.on === true; save(); render(); }
    };
    socket.onclose = () => { st.relay = false; socket = null; if (!retry) retry = setTimeout(connect, 1000); };
    socket.onerror = () => { try { socket && socket.close(); } catch (e) { /* closing */ } };
  }

  // ------------------------------------------------------------------ actions
  function setOn(on) { claim(); live.on = !!on; if (live.on) touchCard(); sendAvatar(); render(); }   // (ON: a fresh small picture for a few seconds)
  function setCharacter(id) {
    if (id === 'mask') { claim(); settings.mask = true; live.mode = 'face'; save(); touchCard(); sendAvatar(); render(); loadGifts(); return; }
    if (!L.isCharacter(id)) return;
    claim(); settings.character = id; settings.mask = false; save(); touchCard(); sendAvatar(); render();
  }
  // ------------------------------------------------------------------ the Mask: Visualizer / Face, background, sounds, the test buttons, the gift list
  // (V7: `picked()` = while shuffle runs, a look he chooses himself is shown at once; shuffle goes on from there)
  const picked = () => { if (shuffleOn()) { live.pick++; st.pickAt = performance.now(); } };
  function setMode(mode) { if (!settings.mask) return; claim(); live.mode = mode === 'visualizer' ? 'visualizer' : 'face'; picked(); sendAvatar(); render(); }
  function setMaskBg(bg) { if (!L.MASK_BACKGROUNDS.includes(bg)) return; claim(); settings.maskBg = bg; picked(); save(); sendAvatar(); render(); }
  function setMaskViz(v) { if (!L.MASK_VISUALIZERS.includes(v)) return; claim(); settings.maskViz = v; picked(); save(); sendAvatar(); render(); }
  // ------------------------------------------------------------------ V7: where it sits, the Mask's colour, shuffle to the beat
  let placeSendAt = 0, placeTimer = null;
  /** move / size the picked character (each of the three keeps its own). The OBS picture follows at once (at most 30 messages a second). */
  function setPlace(p, quiet) {
    if (KILL.place) return;
    claim();
    settings.place[who()] = L.cleanPlace({ ...settings.place[who()], ...p }, settings.mask ? 'mask' : 'hero');
    touchCard();
    save();
    const now = performance.now();
    clearTimeout(placeTimer);
    if (now - placeSendAt >= 33) { placeSendAt = now; sendAvatar(); } else placeTimer = setTimeout(() => { placeSendAt = performance.now(); sendAvatar(); }, 34);
    if (!quiet) render(); else renderPlace();
  }
  function resetPlace() { setPlace({ zoom: 1, x: 0, y: 0 }); }
  /** '' = Auto, or '#rrggbb' */
  function setMaskColour(hex) { claim(); settings.maskColour = L.cleanHex(hex); save(); sendAvatar(); render(); }
  function setColourMusic(on) { claim(); settings.maskColourMusic = !!on; save(); sendAvatar(); render(); }
  function setShuffle(on, amount) {
    claim();
    settings.shuffle = !!on; if (L.SHUFFLE_LEVELS.includes(amount)) settings.shuffleAmount = amount;
    live.pick = 0; save(); sendAvatar(); render();
  }
  /** what shows right now: while shuffle runs the avatar page says so (it changes the look by itself), else his own picks */
  function shown() {
    const fresh = (at) => performance.now() - (at || -1e9) < 3500, held = performance.now() - (st.pickAt || -1e9) < 1500;   // right after his own pick: his pick
    const out = { mode: live.mode, maskBg: settings.maskBg, viz: settings.maskViz, bg: settings.bg, bpm: 0, running: false };
    if (!shuffleOn() || !live.on) return out;
    if (settings.mask) { const k = st.maskAck; if (k && k.shuffle && fresh(st.maskAckAt)) { out.running = true; out.bpm = k.bpm || 0; if (k.look && !held) { out.mode = k.look.mode === 'visualizer' ? 'visualizer' : 'face'; if (L.MASK_BACKGROUNDS.includes(k.look.bg)) out.maskBg = k.look.bg; if (L.MASK_VISUALIZERS.includes(k.look.viz)) out.viz = k.look.viz; } } }
    else { const k = st.heroAck; if (k && k.shuffle && fresh(st.heroAckAt)) { out.running = true; out.bpm = k.bpm || 0; if (k.look && !held && L.BACKGROUNDS.includes(k.look.bg)) out.bg = k.look.bg; } }
    return out;
  }
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
    const cur = shown().maskBg;
    for (const b of box.children) b.classList.toggle('sel', b.dataset.bg === cur);
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
    const cur = shown().viz || list[0];
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
  function setBg(bg) { claim(); settings.bg = bg; picked(); save(); sendAvatar(); render(); }
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
    if (!srv.camera) return ['bad', srv.cameraWhy === 'ask' ? SAY.pickCamera : SAY.noCamera];
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
    // V7: the colour buttons (Auto first, then the one-tap colours; Hot Pink is one of them) and the shuffle amounts
    const sw = $('swatches');
    const swatch = (id, label, hex) => {
      const b = document.createElement('button');
      b.className = 'sw' + (hex ? '' : ' auto'); b.dataset.hex = hex; b.title = label; b.setAttribute('aria-label', label);
      if (hex) b.style.background = 'radial-gradient(circle at 35% 30%, #fff8 0%, ' + hex + ' 38%, ' + hex + ' 62%, #0008 130%)'; else b.textContent = 'Auto';
      b.addEventListener('click', () => { setMaskColour(hex); b.blur(); });
      sw.appendChild(b);
    };
    swatch('auto', COLOUR.auto, '');
    for (const s of L.MASK_SWATCHES) swatch(s.id, s.label, s.hex);
    for (const a of L.SHUFFLE_LEVELS) {
      const b = document.createElement('button');
      b.className = 'opt'; b.dataset.amount = a; b.textContent = SHUFFLE.amounts[a];
      b.addEventListener('click', () => { setShuffle(true, a); b.blur(); });
      $('shuffleAmt').appendChild(b);
    }
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
    const srv = st.srv;
    if (!srv) return;
    // more than one camera and no DroidCam: the same pictures are shown right under the sentence, once, until he clicks one
    const ask = srv.obs === 'ok' && !srv.camera && srv.cameraWhy === 'ask', box = $(ask ? 'camAsk' : 'cams');
    $('camAsk').hidden = !ask;
    const key = (ask ? 'ask|' : '') + srv.cameras.map((c) => c.name + ':' + (c.scenes || []).join(',')).join('\n') + '|' + srv.camera;
    if (key !== camsShown) {
      camsShown = key;
      $('cams').textContent = ''; $('camAsk').textContent = '';
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
        b.addEventListener('click', async () => { b.blur(); const fresh = await post('camera', { name: c.name }); if (fresh) { st.srv = fresh; st.forceShots = false; st.recoveries = []; } render(); renderCams(); });
        box.appendChild(b);
      }
      $('camHint').textContent = srv.camera ? 'Watching you through ' + srv.camera + '. Click another picture if that is not you.' : '';
    }
    if ((ask || $('more').open) && srv.obs === 'ok') for (const b of box.children) b.firstChild.src = '/api/vt/shot?name=' + encodeURIComponent(b.dataset.name) + '&t=' + Date.now();
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
    const now = shown(), viz = now.mode === 'visualizer';
    renderPlace(); renderColour(); renderShuffle(now); renderV8();
    $('mode').classList.toggle('viz', viz);
    $('modeText').textContent = viz ? MODE.toFace : MODE.toViz; $('modeHint').textContent = viz ? MODE.toFaceHint : MODE.toVizHint;
    const snd = st.srv && st.srv.mask ? st.srv.mask.sound : null;
    $('sound').textContent = !settings.mask || !snd ? '' : snd.src === 'pc' ? SOUND.pc : snd.src === 'obs' ? SOUND.obs : snd.pc === 'starting' ? SOUND.starting : st.micOn ? SOUND.voice : SOUND.voiceNoMic;
    renderMaskBgs();
    $('giftSounds').classList.toggle('sel', settings.maskSounds);
    renderViz();
    for (const b of $('tries').children) b.hidden = !settings.mask && !!MASK_ONLY_TRY[b.dataset.kind];
    $('tryHint').textContent = st.tryNote || MASK.tryIdle; $('giftsNote').textContent = st.giftsNote;
    for (const b of $('bgs').children) b.classList.toggle('sel', b.dataset.bg === now.bg);
    $('power').classList.toggle('on', live.on);
    $('powerText').textContent = live.on ? 'ON' : 'OFF';
    $('powerHint').textContent = live.on ? SAY.onHint : SAY.offHint;
    $('mirror').classList.toggle('sel', settings.mirror);
    $('eyes').classList.toggle('sel', settings.eyes);
    $('hands').classList.toggle('sel', settings.handsLine);
    $('micLabel').textContent = st.micOn ? 'Microphone' : st.micFailed ? 'Microphone: not heard' : 'Microphone ...';
    const removed = st.srv && st.srv.avatar.removed;
    $('remove').textContent = removed ? REMOVE.back : performance.now() < st.removeArmed ? REMOVE.sure : REMOVE.ask;
    renderFace();
  }

  // ------------------------------------------------------------------ V7: drawing the three cards
  const label = () => (settings.mask ? 'the Mask' : L.CHARACTERS[settings.character].label);
  function renderPlace() {
    $('placeCard').hidden = KILL.place;
    if (KILL.place) return;
    const p = placeNow(), n = label(), pct = (v) => (v > 0.0005 ? '+' : '') + Math.round(v * 100);
    $('placeTitle').textContent = PLACE.title(n); $('placeHint').textContent = PLACE.hint(n);
    if (document.activeElement !== $('zoom')) $('zoom').value = p.zoom;
    if (document.activeElement !== $('offx')) $('offx').value = p.x;
    $('offy').max = String(L.placeUp(who() === 'mask' ? 'mask' : 'hero'));        // as far up as the middle of the face stays in the picture
    if (document.activeElement !== $('offy')) $('offy').value = p.y;
    $('zoomVal').textContent = Math.round(p.zoom * 100) + '%'; $('offxVal').textContent = pct(p.x); $('offyVal').textContent = pct(p.y);
    $('placeReset').disabled = p.zoom === 1 && p.x === 0 && p.y === 0;
  }
  function renderColour() {
    const showIt = settings.mask && !KILL.colour;
    $('colourCard').hidden = !showIt;
    if (!showIt) return;
    const hex = settings.maskColour, known = L.MASK_SWATCHES.find((s) => s.hex === hex);
    for (const b of $('swatches').children) b.classList.toggle('sel', b.dataset.hex === hex);
    $('swName').textContent = !hex ? COLOUR.autoName : COLOUR.picked(known ? known.label : COLOUR.own);
    $('swName').style.color = hex || '';
    $('wheelBox').hidden = !settings.wheelOpen; $('wheelToggle').textContent = settings.wheelOpen ? COLOUR.wheelClose : COLOUR.wheelOpen;
    $('colourMusicBox').hidden = !hex;
    $('colourMusic').classList.toggle('sel', settings.maskColourMusic);
    $('colourMusicHint').textContent = settings.maskColourMusic ? COLOUR.musicOn : COLOUR.musicOff;
    if (settings.wheelOpen) drawWheel();
  }
  function renderShuffle(now) {
    $('shuffleCard').hidden = KILL.shuffle;
    if (KILL.shuffle) return;
    const on = settings.shuffle, n = label();
    $('shuffle').classList.toggle('sel', on);
    $('shuffleAmt').hidden = !on;
    for (const b of $('shuffleAmt').children) b.classList.toggle('sel', b.dataset.amount === settings.shuffleAmount);
    $('shuffleHint').textContent = settings.mask ? SHUFFLE.mask : L.BACKGROUNDS.indexOf(settings.bg) >= 3 ? SHUFFLE.hero(n) : SHUFFLE.heroOwnBg(n);
    const snd = st.srv && st.srv.mask ? st.srv.mask.sound : null;
    // (the number is shown to the nearest 2 and only changes when the beat moved by 3: it must not flicker)
    if (!now.bpm) st.bpmShown = 0; else if (!st.bpmShown || Math.abs(now.bpm - st.bpmShown) >= 3) st.bpmShown = Math.round(now.bpm / 2) * 2;
    $('shuffleNow').textContent = !on ? SHUFFLE.off : !live.on ? SHUFFLE.needOn : now.bpm ? SHUFFLE.beat(st.bpmShown) : snd && snd.src === 'voice' && snd.pc !== 'starting' ? SHUFFLE.voice : SHUFFLE.waiting;
  }

  // ---- the colour wheel: round the ring is the colour (hue), the edge is rich and the middle pale (saturation); the
  // slider next to it is the brightness. Drawn once per brightness into the canvas; the ring marks his colour.
  const wheel = $('wheel'), wctx = wheel.getContext('2d');
  let wheelV = -1, wheelImg = null;
  const hsvNow = () => L.hexToHsv(settings.maskColour) || { h: 350, s: 0.86, v: 0.9 };
  function drawWheel() {
    const W2 = wheel.width, R = W2 / 2 - 6, c = W2 / 2, hsv = hsvNow(), v = Math.max(0.35, hsv.v);
    if (document.activeElement !== $('bright')) $('bright').value = v;
    if (wheelV !== v || !wheelImg) {
      wheelV = v; wheelImg = wctx.createImageData(W2, W2);
      const d = wheelImg.data;
      for (let y = 0; y < W2; y++) for (let x = 0; x < W2; x++) {
        const dx = x - c, dy = y - c, r = Math.hypot(dx, dy), i = (y * W2 + x) * 4;
        if (r > R + 1) { d[i + 3] = 0; continue; }
        const hex = L.hsvToHex(Math.atan2(dy, dx) * 180 / Math.PI + 90, Math.min(1, r / R), v);
        d[i] = parseInt(hex.slice(1, 3), 16); d[i + 1] = parseInt(hex.slice(3, 5), 16); d[i + 2] = parseInt(hex.slice(5, 7), 16); d[i + 3] = r > R ? Math.round(255 * (R + 1 - r)) : 255;
      }
    }
    wctx.clearRect(0, 0, W2, W2); wctx.putImageData(wheelImg, 0, 0);
    if (settings.maskColour) {
      const a = (hsv.h - 90) * Math.PI / 180, r = hsv.s * R, mx = c + Math.cos(a) * r, my = c + Math.sin(a) * r;
      wctx.lineWidth = 4; wctx.strokeStyle = '#000'; wctx.beginPath(); wctx.arc(mx, my, 11, 0, Math.PI * 2); wctx.stroke();
      wctx.lineWidth = 2.5; wctx.strokeStyle = '#fff'; wctx.beginPath(); wctx.arc(mx, my, 11, 0, Math.PI * 2); wctx.stroke();
    }
  }
  function wheelPick(e) {
    const b = wheel.getBoundingClientRect(), R = b.width / 2 - 6 * b.width / wheel.width, dx = e.clientX - (b.left + b.width / 2), dy = e.clientY - (b.top + b.height / 2);
    setMaskColour(L.hsvToHex(Math.atan2(dy, dx) * 180 / Math.PI + 90, Math.min(1, Math.hypot(dx, dy) / R), Number($('bright').value) || 0.9));
  }
  let wheelDown = false;
  wheel.addEventListener('pointerdown', (e) => { wheelDown = true; e.preventDefault(); wheelPick(e); });
  window.addEventListener('pointermove', (e) => { if (wheelDown) wheelPick(e); });
  window.addEventListener('pointerup', () => { wheelDown = false; });
  window.addEventListener('pointercancel', () => { wheelDown = false; });

  // ---- the picture he drags in. It shows what OBS shows (the small picture the avatar page sends while ON); when that
  // is not there (OFF, or OBS is not showing the source) a circle with the character's picture shows where it will sit.
  // The same numbers place the circle and the real character, so what he drags is where it lands.
  const stage = $('stage'), sctx = stage.getContext('2d'), tiles = {};
  // where the face is in the 9:16 picture at home (parts of the picture): its middle and its height; measured on the renders
  const FACE_AT = { ryo: { cx: 0.5, cy: 0.36, h: 0.40 }, melanie: { cx: 0.5, cy: 0.36, h: 0.40 }, mask: { cx: 0.5, cy: 0.45, h: 0.56 } };
  function tile(id) { if (!tiles[id]) { const im = new Image(); im.src = id === 'mask' ? 'assets/ui/mask.svg' : 'assets/ui/' + id + '.jpg'; tiles[id] = im; } return tiles[id].complete && tiles[id].naturalWidth ? tiles[id] : null; }
  function drawStage() {
    requestAnimationFrame(drawStage);
    if (KILL.place || document.visibilityState !== 'visible') return;
    const Wp = stage.width, Hp = stage.height, id = who(), p = placeNow(), f = FACE_AT[id], fresh = performance.now() - (st.pvAt || -1e9) < 1500, real = live.on && st.pvImg && st.pvWho === id && (fresh || performance.now() - st.pvAt < 600000);
    sctx.fillStyle = '#0a0706'; sctx.fillRect(0, 0, Wp, Hp);
    const cx = (f.cx + p.x) * Wp, cy = (f.cy - p.y) * Hp, r = f.h * p.zoom * Hp / 2;
    if (real) { sctx.imageSmoothingQuality = 'high'; sctx.drawImage(st.pvImg, 0, 0, Wp, Hp); }
    else {
      // the stand-in: a soft floor, and the character's picture in a circle where the face will be
      const g = sctx.createRadialGradient(Wp / 2, Hp * 0.42, 10, Wp / 2, Hp * 0.42, Hp * 0.7); g.addColorStop(0, '#2a1512'); g.addColorStop(1, '#0a0706'); sctx.fillStyle = g; sctx.fillRect(0, 0, Wp, Hp);
      const im = tile(id);
      sctx.save(); sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2); sctx.clip();
      if (im) sctx.drawImage(im, cx - r, cy - r, 2 * r, 2 * r); else { sctx.fillStyle = '#3a0f17'; sctx.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
      sctx.restore();
      sctx.lineWidth = 3; sctx.strokeStyle = '#ff3b57'; sctx.beginPath(); sctx.arc(cx, cy, r, 0, Math.PI * 2); sctx.stroke();
    }
    // while he drags or sizes: corner marks round the face, so the hand has something to hold on to
    if (drag.on || performance.now() - drag.touchedAt < 900) {
      const k = r * 1.08, c = Math.max(10, k * 0.28);
      sctx.lineWidth = 3; sctx.strokeStyle = '#fff'; sctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { sctx.moveTo(cx + sx * k, cy + sy * (k - c)); sctx.lineTo(cx + sx * k, cy + sy * k); sctx.lineTo(cx + sx * (k - c), cy + sy * k); }
      sctx.stroke();
    }
    const note = real ? (fresh ? PLACE.real : PLACE.stale) : PLACE.ghost(label());
    if ($('stageNote').textContent !== note) $('stageNote').textContent = note;
  }
  // drag = move, wheel = size, two fingers = size. Window listeners (not pointer capture): the drag goes on outside the picture.
  const drag = { on: false, id: -1, x: 0, y: 0, px: 0, py: 0, touchedAt: -1e9, pts: new Map(), pinch: 0, zoom0: 1 };
  stage.addEventListener('pointerdown', (e) => {
    if (KILL.place) return;
    e.preventDefault();
    drag.armedAt = performance.now(); touchCard();
    drag.pts.set(e.pointerId, [e.clientX, e.clientY]);
    const p = placeNow();
    if (drag.pts.size === 2) { const [a, b] = [...drag.pts.values()]; drag.pinch = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; drag.zoom0 = p.zoom; drag.on = false; return; }
    drag.on = true; drag.id = e.pointerId; drag.x = e.clientX; drag.y = e.clientY; drag.px = p.x; drag.py = p.y; drag.touchedAt = performance.now();
    stage.classList.add('drag');
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag.pts.has(e.pointerId)) return;
    drag.pts.set(e.pointerId, [e.clientX, e.clientY]); drag.touchedAt = performance.now();
    const b = stage.getBoundingClientRect();
    if (drag.pts.size >= 2 && drag.pinch) { const [a, c] = [...drag.pts.values()]; setPlace({ zoom: drag.zoom0 * Math.hypot(a[0] - c[0], a[1] - c[1]) / drag.pinch }, true); return; }
    if (drag.on && e.pointerId === drag.id) setPlace({ x: drag.px + (e.clientX - drag.x) / b.width, y: drag.py - (e.clientY - drag.y) / b.height }, true);
  });
  const dragEnd = (e) => { drag.pts.delete(e.pointerId); if (drag.pts.size < 2) drag.pinch = 0; if (e.pointerId === drag.id || !drag.pts.size) { drag.on = false; stage.classList.remove('drag'); render(); } };
  window.addEventListener('pointerup', dragEnd); window.addEventListener('pointercancel', dragEnd);
  // Fix round S1: the wheel over the picture SCROLLS THE PAGE, as everywhere else. It only sizes the character when he
  // pressed in the picture just before (within 4 s; each sizing turn keeps it going). A host scrolling down the page
  // with the mouse over the picture never resizes the character on stream by accident.
  const WHEEL_ARM_MS = 4000;
  stage.addEventListener('wheel', (e) => {
    if (KILL.place || performance.now() - (drag.armedAt || -1e9) > WHEEL_ARM_MS) return;      // not armed: the page scrolls
    e.preventDefault(); drag.armedAt = drag.touchedAt = performance.now();
    setPlace({ zoom: placeNow().zoom * Math.exp(-e.deltaY * 0.0012) });
  }, { passive: false });
  stage.addEventListener('pointermove', touchCard);
  for (const id of ['zoom', 'offx', 'offy', 'placeReset']) $(id).addEventListener('pointerdown', touchCard);

  // ------------------------------------------------------------------ V8: the puppet show card
  // The show itself runs on the avatar page in OBS (js/v8-show.js, next to the Mask). This card sends it the switches
  // (inside the `avatar` message) and commands ({ t: 'v8-cmd' }), and shows what it reports back about once a second
  // and at once when something changes (cooldowns, the fight, the vote, why a button is grey).
  const V8T = {
    onHint: 'Buttons, keys, chat and votes move the Mask. Switch this off and the Mask is exactly as it was before.',
    moves: 'Hold Goo or Fire head and it keeps going while you hold. The letter on a button is its key (it works while this window is in front).',
    movesFight: 'In a boss fight Goo and Fire head are your special attacks on chat (20 seconds between two).',
    off: 'Turn the avatar ON first.', wait: 'Waiting for the Mask in OBS ...',
    fight: 'Chat taps the screen to fire missiles at you. Open your mouth wide to eat them, turn your head to dodge, pucker for a shield, squint for laser eyes, yell to blast them all. Only between songs.',
    fightSong: 'A song is on air. The fight can start when it is over.', fightEar: 'I hear music playing. The fight can start when it stops.',
    fightGo: 'Start a fight: chat against you', fightStop: 'Press to call it off (nobody wins)', fightEnd: 'The ending is playing ...',
    noEar: 'I cannot tell whether a song is playing (LIVE Link is not connected and I hear no PC sound): start a fight only between songs.',
    vote: 'Chat types the number, or the word of an answer. After half a minute the winner happens by itself: he shrinks to an inch, goes HUGE, changes colour, makes a move, or the boss fight starts.',
    voteStart: 'Start a vote', voteStop: 'Stop the vote', voteOwn: 'Type a question and two to four answers first.',
    keys: 'Press "Change", then the key you want: a letter, a number or F1 - F10. Esc = leave it as it is.', keyBad: 'That key cannot be used (Space, Enter, Tab, the arrows, F5, F11 and F12 belong to the window). Pick a letter, a number or F1 - F10.',
    hands: 'Hold a hand up by your face: right hand = angel, left = devil.', handsNone: 'Hold a hand up by your face: right hand = angel, left = devil. (I do not see a hand right now.)',
  };
  const V8M = window.VTShow ? window.VTShow.MOVES : [], V8L = window.VTShow ? window.VTShow.MOVE_LABEL : {};
  const v8 = { held: {}, keyWait: '', note: '', noteAt: -1e9, barsAt: -1e9 };
  const v8Ack = () => { const k = st.maskAck && st.maskAck.v8; return k && performance.now() - st.maskAckAt < 3500 ? k : null; };
  const v8Cmd = (o) => { claim(); send({ t: 'v8-cmd', ...o }); };
  const v8Say = (text) => { v8.note = text; v8.noteAt = performance.now(); renderV8(); };
  function v8Set(patch) { claim(); settings.v8 = L.cleanV8({ ...settings.v8, ...patch }); save(); sendAvatar(); render(); }
  /** press / let go of a move (a button or a key). Goo and Fire head keep going while held. */
  function v8Down(name) {
    if (KILL.v8 || !settings.mask || !settings.v8.on || v8.held[name]) return;
    if (!live.on) { v8Say(V8T.off); return; }
    v8.held[name] = true; v8Cmd({ action: 'down', name }); renderV8();
  }
  function v8Up(name) { if (!v8.held[name]) return; v8.held[name] = false; if (name === 'goo' || name === 'fire') v8Cmd({ action: 'up', name }); renderV8(); }
  function v8Fight() {
    if (KILL.v8 || !settings.mask || !settings.v8.on) return;
    if (!live.on) { v8Say(V8T.off); return; }
    const k = v8Ack();
    if (k && k.fight) { if (k.fight.phase === 'intro' || k.fight.phase === 'fight') v8Cmd({ action: 'stop' }); return; }
    if (k && k.song) { v8Say(k.songSrc === 'ear' ? V8T.fightEar : V8T.fightSong); return; }
    v8Cmd({ action: 'fight' });
  }
  /** RELEASE A, EAT IT: the Mask eats the song now. The Mask must be picked and the avatar on; the Puppet show switch is not asked. */
  function v8Eat() {
    if (KILL.v8 || !settings.mask) return;
    if (!L.eatLine({ on: live.on, ack: live.on ? v8Ack() : null }).can) return;
    v8.eatAt = performance.now(); v8Cmd({ action: 'eat' }); renderV8();
  }
  function v8Vote() {
    if (KILL.v8 || !settings.mask || !settings.v8.on) return;
    if (!live.on) { v8Say(V8T.off); return; }
    const k = v8Ack();
    if (k && k.vote && k.vote.active) { v8Cmd({ action: 'vote-stop' }); return; }
    const id = settings.v8Vote;
    if (id === 'own') {
      const c = window.VTShow.customVote($('v8OwnQ').value, $('v8OwnA').value);
      if (!c) { v8Say(V8T.voteOwn); return; }
      v8Cmd({ action: 'vote', custom: { question: c.question, options: c.options.map((o) => o.label) } });
    } else v8Cmd(id === 'random' ? { action: 'vote' } : { action: 'vote', id });
  }
  function buildV8() {
    if (KILL.v8) return;
    for (const name of V8M) {
      const b = document.createElement('button'); b.className = 'mv'; b.dataset.move = name;
      b.innerHTML = '<span></span><b></b><small></small><u></u>'; b.firstChild.textContent = V8L[name];
      b.addEventListener('pointerdown', (e) => { if (e.button) return; try { b.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ } v8Down(name); });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => v8Up(name));
      b.addEventListener('keydown', (e) => { if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) v8Down(name); });
      b.addEventListener('keyup', (e) => { if (e.code === 'Enter' || e.code === 'NumpadEnter') v8Up(name); });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      $('v8Moves').appendChild(b);
    }
    const sel = $('v8VoteWhich');
    for (const [id, text] of [['random', 'Surprise me (a random one)'], ...window.VTShow.VOTES.map((v) => [v.id, v.title]), ['own', 'My own question ...']]) { const o = document.createElement('option'); o.value = id; o.textContent = text; sel.appendChild(o); }
    sel.value = [...sel.options].some((o) => o.value === settings.v8Vote) ? settings.v8Vote : 'random';
    sel.addEventListener('change', () => { settings.v8Vote = sel.value; save(); renderV8(); });
    for (const [id, text] of [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]) { const b = document.createElement('button'); b.className = 'opt'; b.dataset.bars = id; b.textContent = text; b.addEventListener('click', () => { v8.barsAt = performance.now(); v8Set({ bars: L.V8_BARS[id] }); b.blur(); }); $('v8Bars').appendChild(b); }
    $('v8BarsY').addEventListener('input', (e) => { v8.barsAt = performance.now(); v8Set({ bars: Number(e.target.value) }); });
    $('v8On').addEventListener('click', () => { v8Set({ on: !settings.v8.on }); $('v8On').blur(); });
    $('v8Rand').addEventListener('click', () => { v8Set({ rand: !settings.v8.rand }); $('v8Rand').blur(); });
    $('v8Chat').addEventListener('click', () => { v8Set({ chat: !settings.v8.chat }); $('v8Chat').blur(); });
    $('v8Hands').addEventListener('click', () => { v8Set({ hands: !settings.v8.hands }); $('v8Hands').blur(); });
    $('v8Swap').addEventListener('click', () => { v8Set({ swap: !settings.v8.swap }); $('v8Swap').blur(); });
    $('v8Fight').addEventListener('click', () => { v8Fight(); $('v8Fight').blur(); });
    $('v8Eat').addEventListener('click', () => { v8Eat(); $('v8Eat').blur(); });
    $('v8Vote').addEventListener('click', () => { v8Vote(); $('v8Vote').blur(); });
    $('v8KeysReset').addEventListener('click', () => { settings.v8Keys = { ...L.V8_KEYS }; v8.keyWait = ''; save(); renderV8(); $('v8KeysReset').blur(); });
    for (const a of L.V8_ACTIONS) {
      const row = document.createElement('div'); row.className = 'keyrow'; row.dataset.action = a;
      row.innerHTML = '<span></span><b></b><button class="plain"></button>'; row.firstChild.textContent = a === 'fight' ? 'Boss fight' : a === 'vote' ? 'Start a vote' : V8L[a];
      row.lastChild.addEventListener('click', () => { v8.keyWait = v8.keyWait === a ? '' : a; renderV8(); row.lastChild.blur(); });
      $('v8Keys').appendChild(row);
    }
    // the keys, while this window is in front (never while he types in a box). One plain key each; Space stays ON / OFF.
    const typing = (e) => { const tag = e.target && e.target.tagName; return tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range'); };
    window.addEventListener('keydown', (e) => {
      if (v8.keyWait) {                                    // "Change" was pressed: this key becomes that action's key
        e.preventDefault(); e.stopPropagation();
        if (e.code === 'Escape') { v8.keyWait = ''; renderV8(); return; }
        if (e.repeat || ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
        const next = L.setKey(settings.v8Keys, v8.keyWait, e.code);
        if (!next) { v8Say(V8T.keyBad); return; }
        settings.v8Keys = next; v8.keyWait = ''; save(); renderV8(); return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || typing(e) || !settings.mask || !settings.v8.on) return;
      const a = L.keyAction(settings.v8Keys, e.code); if (!a) return;
      e.preventDefault();
      if (e.repeat) return;
      if (a === 'fight') v8Fight(); else if (a === 'vote') v8Vote(); else v8Down(a);
    }, true);
    window.addEventListener('keyup', (e) => { const a = L.keyAction(settings.v8Keys, e.code); if (a && a !== 'fight' && a !== 'vote') v8Up(a); }, true);
    window.addEventListener('blur', () => { for (const m of V8M) v8Up(m); });      // the window lost the focus mid-hold: let go
    setInterval(() => { if (settings.mask && !KILL.v8 && document.visibilityState === 'visible') renderV8(); }, 250);
  }
  function renderV8() {
    const card = $('v8Card'); card.hidden = KILL.v8 || !settings.mask;
    if (card.hidden) return;
    const c = settings.v8, k = live.on ? v8Ack() : null, age = k ? (performance.now() - st.maskAckAt) / 1000 : 0, keys = settings.v8Keys;
    $('v8On').classList.toggle('sel', c.on); $('v8OnHint').textContent = V8T.onHint; $('v8Body').hidden = !c.on;
    // release A: EAT IT and why the Mask will or will not eat (drawn before the return below: it works with the Puppet show off)
    const el = L.eatLine({ on: live.on, ack: k }), pressed = performance.now() - (v8.eatAt || -1e9) < 3000;
    $('v8Eat').disabled = !el.can || pressed; $('v8Eat').classList.toggle('busy', el.state === 'busy');
    $('v8EatLine').dataset.state = el.state; if ($('v8EatText').textContent !== el.text) $('v8EatText').textContent = el.text;
    if (!c.on) { $('v8Note').textContent = ''; return; }
    const fighting = !!(k && k.fight), attack = !!(k && k.attack);
    for (const b of $('v8Moves').children) {
      const name = b.dataset.move, m = k && k.moves ? k.moves[name] : null, cool = m ? Math.max(0, m.cool - age) : 0, isAtk = attack && (name === 'goo' || name === 'fire');
      const why = !live.on ? 'avatar is off' : !k ? '' : m && m.why === 'fight' ? 'not in a fight' : m && m.why === 'intro' ? 'get ready' : cool > 0.05 ? Math.ceil(cool) + ' s' : isAtk ? 'ATTACK' : m && m.on ? 'going' : '';
      b.children[1].textContent = L.keyLabel(keys[name]) || '-'; b.children[2].textContent = why;
      b.children[3].style.width = cool > 0.05 ? Math.min(100, cool / ((attack ? 20 : window.VTShow.COOL[name]) || 5) * 100).toFixed(0) + '%' : '0%';
      b.classList.toggle('go', !!v8.held[name] || !!(m && m.on)); b.classList.toggle('atk', isAtk && cool <= 0.05);
      b.disabled = !live.on || !!(m && (m.why === 'fight' || m.why === 'intro')) || (cool > 0.05 && !v8.held[name]);
    }
    $('v8MovesHint').textContent = fighting ? V8T.movesFight : V8T.moves;
    // the boss fight: only between songs. Greyed with the reason while a song is on air.
    const f = $('v8Fight'), fk = L.keyLabel(keys.fight);
    let text = 'BOSS FIGHT', why = V8T.fightGo + (fk ? '  [' + fk + ']' : ''), dis = false, run = false;
    if (!live.on) { why = V8T.off; dis = true; }
    else if (!k) { why = V8T.wait; dis = true; }
    else if (k.fight) {
      run = true;
      if (k.fight.phase === 'ending') { text = k.fight.winner === 'boss' ? 'YOU WON' : k.fight.winner === 'chat' ? 'CHAT WON' : 'FIGHT OVER'; why = V8T.fightEnd; dis = true; }
      else { text = 'YOU ' + k.fight.boss + '%  -  CHAT ' + k.fight.chat + '%'; why = (k.fight.phase === 'intro' ? 'The raid gathers. ' : k.fight.tappers + ' tapping. ') + V8T.fightStop; }
    } else if (k.song) { why = k.songSrc === 'ear' ? V8T.fightEar : V8T.fightSong; dis = true; }
    f.disabled = dis; f.classList.toggle('run', run && !dis); $('v8FightText').textContent = text; $('v8FightWhy').textContent = why;
    $('v8FightHint').textContent = k && !k.fight && !k.song && k.songSrc === 'none' ? V8T.noEar : V8T.fight;
    // votes
    const vk = L.keyLabel(keys.vote), voting = !!(k && k.vote && k.vote.active);
    $('v8Vote').textContent = voting ? V8T.voteStop + ' (' + k.vote.left + ' s)' : V8T.voteStart + (vk ? '  [' + vk + ']' : '');
    $('v8Vote').disabled = !live.on || fighting; $('v8Own').hidden = settings.v8Vote !== 'own';
    $('v8VoteHint').textContent = voting ? '"' + k.vote.question + '"  ' + k.vote.total + (k.vote.total === 1 ? ' vote' : ' votes') + (k.vote.lead ? ', in front: ' + k.vote.lead : '') : k && k.vote && k.vote.lead ? 'Chat voted: ' + k.vote.lead + '.' : V8T.vote;
    $('v8Rand').classList.toggle('sel', c.rand); $('v8Chat').classList.toggle('sel', c.chat); $('v8Hands').classList.toggle('sel', c.hands); $('v8Swap').classList.toggle('sel', c.swap); $('v8Swap').hidden = $('v8SwapHint').hidden = !c.hands;
    $('v8HandsHint').textContent = c.hands && k && !k.handsSeen && !(k.puppets && (k.puppets.angel || k.puppets.devil)) ? V8T.handsNone : V8T.hands;
    for (const b of $('v8Bars').children) b.classList.toggle('sel', Math.abs(L.V8_BARS[b.dataset.bars] - c.bars) < 0.005);
    if (document.activeElement !== $('v8BarsY')) $('v8BarsY').value = String(c.bars);
    for (const row of $('v8Keys').children) { const a = row.dataset.action, w = v8.keyWait === a; row.children[1].textContent = L.keyLabel(keys[a]) || 'none'; row.children[2].textContent = w ? 'Press a key ...' : 'Change'; row.children[2].classList.toggle('wait', w); }
    $('v8KeysHint').textContent = V8T.keys;
    const fresh = performance.now() - v8.noteAt < 6000;
    $('v8Note').textContent = fresh ? v8.note : k && k.note ? k.note : k && k.song && k.title ? 'On air: ' + k.title : '';
  }

  // ------------------------------------------------------------------ wiring
  build();
  buildV8();
  window.addEventListener('pointerdown', claim, true);
  window.addEventListener('keydown', claim, true);
  $('power').addEventListener('click', () => { setOn(!live.on); $('power').blur(); });
  $('face').addEventListener('click', () => { readFace(); $('face').blur(); });
  $('mode').addEventListener('click', () => { setMode(shown().mode === 'visualizer' ? 'face' : 'visualizer'); $('mode').blur(); });
  $('giftSounds').addEventListener('click', () => { setGiftSounds(!settings.maskSounds); $('giftSounds').blur(); });
  $('giftAdd').addEventListener('click', () => { st.gifts = [{ gift: ' ', effect: 'barrage' }, ...giftRows()]; st.giftsDirty = true; renderGifts(); const f = $('gifts').querySelector('input[type=text]'); if (f) { f.value = ''; f.focus(); } });
  $('giftSave').addEventListener('click', () => { saveGifts(false); $('giftSave').blur(); });
  $('giftReset').addEventListener('click', () => { st.giftsDirty = false; saveGifts(true); $('giftReset').blur(); });
  frame.addEventListener('load', hookTracker);
  $('eyes').addEventListener('click', () => { claim(); settings.eyes = !settings.eyes; save(); sendAvatar(); render(); $('eyes').blur(); });
  $('mirror').addEventListener('click', () => { claim(); settings.mirror = !settings.mirror; save(); sendAvatar(); render(); $('mirror').blur(); });
  $('hands').addEventListener('click', () => { claim(); settings.handsLine = !settings.handsLine; save(); sendHands(); render(); $('hands').blur(); });
  $('zoom').addEventListener('input', (e) => { drag.touchedAt = performance.now(); setPlace({ zoom: Number(e.target.value) }); });
  $('offx').addEventListener('input', (e) => { drag.touchedAt = performance.now(); setPlace({ x: Number(e.target.value) }); });
  $('offy').addEventListener('input', (e) => { drag.touchedAt = performance.now(); setPlace({ y: Number(e.target.value) }); });
  $('placeReset').addEventListener('click', () => { drag.touchedAt = performance.now(); resetPlace(); $('placeReset').blur(); });
  $('wheelToggle').addEventListener('click', () => { settings.wheelOpen = !settings.wheelOpen; save(); render(); $('wheelToggle').blur(); });
  $('bright').addEventListener('input', (e) => { const h = hsvNow(); setMaskColour(L.hsvToHex(h.h, settings.maskColour ? h.s : 0.86, Number(e.target.value))); });
  $('colourMusic').addEventListener('click', () => { setColourMusic(!settings.maskColourMusic); $('colourMusic').blur(); });
  $('shuffle').addEventListener('click', () => { setShuffle(!settings.shuffle); $('shuffle').blur(); });

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
  requestAnimationFrame(drawStage);
  setInterval(() => { if (shuffleOn() && live.on) render(); }, 1000);   // while shuffle runs the buttons follow what shows
  loadGifts();
  window.__vt = { v8, v8Down, v8Up, v8Fight, v8Vote, v8Set, v8Ack, settings, live, st, panel, SAY, NOTE, FACE, REMOVE, SOUND, MODE, MASK, setMode, setMaskBg, setMaskViz, setGiftSounds, tryEffect, saveGifts, giftRows, onMaskRest, setOn, setCharacter, setBg, readFace, setPlace, resetPlace, setMaskColour, setColourMusic, setShuffle, shown, placeNow, who, atCard, touchCard, KILL, PLACE, COLOUR, SHUFFLE, sentence: () => sentence()[1], cls: () => sentence()[0], notes, tracker: tstate };
})();
