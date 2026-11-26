// V9 CONTROL DECK: the VTuber window on one screen (design-source/v9-deck/index.html, the approved mockup).
// Zones PRE-SHOW | ON AIR | FIGHT (the zone of the moment glows red by itself), a LOOKS strip, a STATUS bar and a
// SETTINGS drawer. The deck is a second face of THIS window: every deck control presses the window's own control or
// calls the window's own function (window.__vt), so the messages, the settings and the keys are exactly the window's.
// The classic layout is kept unchanged behind "Classic controls" (SETTINGS); the window's set-once controls are moved
// into the drawer while the deck shows and moved back, to the same spot, when the classic layout opens.
// Kill switch: vtuber.html?deck=0 (this file then does nothing at all: today's window).
'use strict';
(function () {
  const html = document.documentElement;
  const vt = window.__vt, L = window.VTLogic, D = window.VTDeckLogic, SHOW = window.VTShow || null;
  if (!vt || !L || !D || /[?&]deck=0(?:&|$)/.test(location.search)) { html.classList.remove('dk-on'); return; }

  const $ = (id) => document.getElementById(id);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const S = vt.settings, live = vt.live, st = vt.st;
  const now = () => performance.now();
  const errors = [];
  const guard = (name, fn) => { try { fn(); } catch (e) { if (errors.length < 40) errors.push(name + ': ' + (e && e.message ? e.message : e)); } };
  const W = D.WAITS;

  // ---------------------------------------------------------------- the deck's own preferences (this browser only)
  const PREF = 'vt-deck';
  const pref = (() => { try { const p = JSON.parse(localStorage.getItem(PREF) || '{}'); return p && typeof p === 'object' ? p : {}; } catch (e) { return {}; } })();
  if (!D.HERO_FACE_HOLDS.some(([ms]) => ms === pref.faceHold)) pref.faceHold = 0;
  const savePref = () => { try { localStorage.setItem(PREF, JSON.stringify({ view: pref.view === 'classic' ? 'classic' : 'deck', faceHold: pref.faceHold })); } catch (e) { /* not kept */ } };

  // ---------------------------------------------------------------- small helpers (they write only what changed)
  const T = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
  const C = (el, c, on) => { if (el) el.classList.toggle(c, !!on); };
  const DIS = (el, d) => { if (el && el.disabled !== !!d) el.disabled = !!d; };
  const HID = (el, h) => { if (el && el.hidden !== !!h) el.hidden = !!h; };
  const TIP = (el, t) => { if (el && el.title !== (t || '')) el.title = t || ''; };
  const sel = (el) => !!el && el.classList.contains('sel');
  /** the window's control is there and not inside a hidden part of the classic layout */
  const shownEl = (el) => !!el && !el.closest('[hidden]');
  let pending = 0;
  const after = () => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; sync(); }); };
  /** press the window's own button: its own click handler runs (the same message, setting and key as the classic layout) */
  function press(el) { const b = typeof el === 'string' ? $(el) : el; if (!b || b.disabled) return false; b.click(); after(); return true; }
  /** press the window's own pick (a child of one of its rows) by its data value */
  function pick(boxId, key, value) { const box = $(boxId); if (!box) return false; return press(Array.from(box.children).find((c) => c.dataset[key] === value)); }
  /** move the window's own slider (its own input / change handlers run) */
  function slide(id, v) { const r = $(id); if (!r || r.disabled) return; r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); after(); }
  const typing = (e) => { const t = e.target && e.target.tagName; return t === 'SELECT' || t === 'TEXTAREA' || (t === 'INPUT' && e.target.type !== 'range'); };
  const paintRange = (r) => { if (r) r.style.setProperty('--p', ((Number(r.value) - Number(r.min)) / ((Number(r.max) - Number(r.min)) || 1)) * 100 + '%'); };
  /** a switch: on / greyed; its small line says why it is greyed (or its own sub line) */
  function sw(el, on, why) {
    if (!el) return;
    C(el, 'on', on); DIS(el, !!why);
    const s = el.querySelector('small');
    if (s) { T(s, why || s.dataset.sub || ''); C(s, 'dk-why', !!why); }
    TIP(el, why || el.dataset.tip || '');
  }
  /** a pad's small line: the reason it is greyed (amber) or its normal sub line */
  function padSub(el, sub, why) { if (!el) return; T(el, why || sub || ''); C(el, 'dk-why', !!why); }
  const keyChip = (el, code) => { if (!el) return; const k = L.keyLabel(code); T(el, k); HID(el, !k); };

  // ---------------------------------------------------------------- the speaker line (the status bar's right end)
  let sayText = '', sayUntil = 0;
  const say = (t) => { sayText = t; sayUntil = now() + 4200; after(); };

  // ---------------------------------------------------------------- the markup (the mockup's, with the build's ids)
  const SWX = (id, text, sub, extra) => '<button class="dk-sw' + (extra || '') + '" id="' + id + '"><span>' + text + (sub !== undefined ? '<small data-sub="' + (sub || '') + '">' + (sub || '') + '</small>' : '') + '</span><i></i></button>';
  const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>';
  const G = D.GLOBAL_KEYS;
  const MARKUP = ''
    + '<div class="dk-room"></div>'
    + '<div class="dk-deck" id="dkDeck">'
    // ---- top bar
    + '<div class="dk-top dk-glass">'
    + '<button class="dk-power" id="dkPower" title="Avatar on / off"><i></i><span id="dkPowerText">OFF</span><small id="dkPowerHint"></small><span class="dk-k">Space</span></button>'
    + '<div class="dk-chars" id="dkChars" title="Who you are on stream"><button data-c="ryo">Ryo</button><button data-c="melanie">Melanie</button><button data-c="mask">Mask</button></div>'
    // the window's own sentence, only while it needs him (a camera to pick, OBS's password, the app stopped): in a slot of
    // the top bar that is always there (over the brand), so it never moves a zone (fix round 1, I-2)
    + '<div class="dk-slot" id="dkSlot"><div class="dk-brand"><span class="dk-chrome">V<b>Tuber</b> Deck</span><small>ReactivVibe LIVE</small></div>'
    + '<div class="dk-alert" id="dkAlert" role="status" hidden><i></i><div><span id="dkAlertText"></span><small id="dkAlertNote"></small></div><button class="dk-mini" id="dkAlertGo" hidden>OBS link</button></div></div>'
    + '<button class="dk-gear" id="dkGear" title="Mic, tracking, framing, keys, OBS link, colours, show sign, live overlay (URL), gifts, and Classic controls">' + GEAR + '<span>Settings</span></button>'
    + '</div>'
    + '<div class="dk-zones" id="dkZones">'
    // ---- PRE-SHOW
    + '<section class="dk-zone dk-glass" data-zone="pre" id="dkZonePre">'
    + '<header><span class="dk-n">01</span><h2 class="dk-chrome">Pre-show</h2><span class="dk-what">countdown · transform · camera</span><span class="dk-now"><i></i>NOW</span></header>'
    + '<div class="dk-zbody">'
    + '<div class="dk-blk"><div class="dk-row primary">'
    + '<div class="dk-step" title="Minutes until you start"><button id="dkMinDown" aria-label="One minute less">&minus;</button><div><span id="dkMin">10</span><small>MIN</small></div><button id="dkMinUp" aria-label="One minute more">+</button></div>'
    + '<button class="dk-pad hero dk-fill" id="dkCdStart"><b id="dkCdText">Start countdown</b><small id="dkCdSub">Covers your camera, burns away at zero</small></button>'
    + '</div>'
    + '<div class="dk-meter" title="Ignition: taps and gifts charge it; they never change the time"><i id="dkIgn"></i></div>'
    + '<div class="dk-read" id="dkCdRead"><b id="dkCdLeft">10:00</b><span>ignition <b id="dkCdIgn">0</b>%</span><span><b id="dkCdTaps">0</b> taps</span><span><b id="dkCdGifts">0</b> gifts</span></div>'
    + '</div>'
    + '<div class="dk-blk"><div class="dk-lbl">Countdown music <em id="dkCdMusicWhy"></em></div><div class="dk-row">'
    + '<button class="dk-sw dk-fill" id="dkCdMusic"><span>Music</span><i></i></button>'
    + '<div class="dk-fill dk-volrow" title="Music volume"><input type="range" class="dk-range" id="dkCdVol" min="0" max="100" step="1" value="70" aria-label="Countdown music volume"><span class="dk-k dk-val" id="dkCdVolVal">70%</span></div>'
    + '<button class="dk-mini" id="dkCdFade" title="Fades the countdown song out">Fade out</button>'
    + '</div></div>'
    + '<div class="dk-blk big dk-tfblk keep"><div class="dk-lbl">Transform <em id="dkTfWhy">your real face burns into the Mask, on the next beat</em></div>'
    + '<button class="dk-pad stretch primary" id="dkTransform"><b id="dkTfText">Transform</b><small id="dkTfSub"></small></button>'
    + '<div class="dk-row"><div class="dk-chips dk-fill" id="dkTfPick" title="Which transform the next switch uses"></div><button class="dk-mini" id="dkTfBeat" hidden title="The change waits for the next beat of the music">On the beat</button></div>'
    + '</div>'
    + '<div class="dk-blk"><div class="dk-lbl">Camera</div><div class="dk-g2">'
    + SWX('dkCamMode', 'Camera mode', 'your real face, effects only')
    + '<button class="dk-sw" id="dkSmartCam"><span>Smart camera<small data-sub="cuts with the music">cuts with the music</small></span><span class="dk-k" id="dkSmartKey">K</span><i></i></button>'
    + '</div></div>'
    + '<div class="dk-blk"><div class="dk-lbl">On the picture <em id="dkSignWhy"></em></div><div class="dk-g2">'
    + '<div class="dk-row"><button class="dk-sw dk-fill" id="dkSignOn"><span>Show sign</span><i></i></button><button class="dk-mini" id="dkSignHide" title="Hide the sign now / show it again">Hide</button></div>'
    + '<div class="dk-row"><button class="dk-sw dk-fill" id="dkOverlayOn"><span>Live overlay (URL)</span><i></i></button><button class="dk-mini" id="dkOverlayHide" title="Hide the live overlay now / show it again">Hide</button></div>'
    + '</div></div>'
    + '</div></section>'
    // ---- ON AIR
    + '<section class="dk-zone dk-glass" data-zone="air" id="dkZoneAir">'
    + '<header><span class="dk-n">02</span><h2 class="dk-chrome">On air</h2><span class="dk-what">eat it · visualizer · vote · moves</span><span class="dk-now"><i></i>NOW</span></header>'
    + '<div class="dk-zbody">'
    + '<div class="dk-blk"><button class="dk-pad hero dk-eat primary" id="dkEat"><span class="dk-disc"></span><span class="dk-t"><b>Eat it</b><span class="dk-eatline" id="dkEatLine" data-s="wait"><i></i><span id="dkEatText"></span></span></span><span class="dk-keys"><span class="dk-k g" title="Works from any window (LIVE Link)">' + G.eatIt + '</span></span></button></div>'
    + '<div class="dk-blk"><div class="dk-g2 vv">'
    + '<div class="dk-col"><button class="dk-pad" id="dkViz"><b id="dkVizText">Visualizer</b><small id="dkVizSub"></small></button><div class="dk-chips c3" id="dkVizPick" title="Visualizer style"></div></div>'
    + '<div class="dk-col"><button class="dk-pad" id="dkVote"><b id="dkVoteText">Vote now</b><small id="dkVoteSub"></small><span class="dk-keys"><span class="dk-k" id="dkVoteKey">V</span><span class="dk-k g" title="Works from any window (LIVE Link)">' + G.vote + '</span></span></button>'
    + '<div class="dk-row"><select id="dkVoteWhich" class="dk-field dk-fill" aria-label="Which vote"></select>'
    + '<button class="dk-sw dk-fix" id="dkVoteRand" data-tip="A new vote by itself about every 4 minutes. Never during a boss fight."><span>Random<small data-sub="every ~4 min">every ~4 min</small></span><i></i></button></div></div>'
    + '</div>'
    + '<div class="dk-row" id="dkOwnBox" hidden><input type="text" class="dk-field dk-fill" id="dkOwnQ" maxlength="60" placeholder="Your question: Is this song a banger?" aria-label="Your question"><input type="text" class="dk-field dk-fill" id="dkOwnA" maxlength="100" placeholder="Answers, a comma between: Yes, No" aria-label="The answers"></div>'
    + '</div>'
    + '<div class="dk-blk"><div class="dk-lbl">Moves <em id="dkMovesWhy">hold the button or the key</em> <em id="dkMovesWait" class="dk-why" hidden></em></div><div class="dk-moves" id="dkMoves"></div></div>'
    + '<div class="dk-blk"><div class="dk-lbl">Show switches</div><div class="dk-g3">'
    + SWX('dkV8On', 'Puppet show', 'moves, fight, votes') + SWX('dkV8Chat', 'Chat triggers moves', 'goo, fire, melt, crack, eat') + SWX('dkV8Orbit', 'Gifters orbit', 'a gifter\'s picture circles him')
    + SWX('dkV8Hands', 'Hand puppets', 'right = angel, left = devil')
    + '<button class="dk-sw hook" id="dkHandFx"><span>Hand effect <i class="dk-tagnew">NEW</i><small data-sub="catch and throw particles">catch and throw particles</small></span><i></i></button>'
    + '<div class="dk-row">' + SWX('dkShuffle', 'Shuffle', 'look changes on the beat', ' dk-fill') + '</div>'
    + '</div></div>'
    + '<div class="dk-blk"><div class="dk-sh">'
    + '<div class="dk-blk"><div class="dk-lbl">Shuffle amount</div><div class="dk-chips hype dk-amt" id="dkShuffleAmt" title="Shuffle amount"></div></div>'
    + '<div class="dk-blk"><div class="dk-lbl">Hype look <em id="dkHypeWhy"></em></div><div class="dk-chips hype" id="dkHypeLook" title="Hype look"></div></div>'
    + '</div></div>'
    + '</div></section>'
    // ---- FIGHT
    + '<section class="dk-zone dk-glass" data-zone="fight" id="dkZoneFight">'
    + '<header><span class="dk-n">03</span><h2 class="dk-chrome">Fight</h2><span class="dk-what">boss fight · attacks</span><span class="dk-now"><i></i>NOW</span></header>'
    + '<div class="dk-zbody">'
    + '<div class="dk-blk"><button class="dk-pad hero primary" id="dkFight"><b id="dkFightText">Boss fight</b><small id="dkFightWhy"></small><span class="dk-keys"><span class="dk-k" id="dkFightKey">B</span><span class="dk-k g" title="Works from any window (LIVE Link)">' + G.fight + '</span></span></button>'
    + '<div class="dk-bars" id="dkBars" title="The fight\'s two bars, as on stream"><div class="dk-boss">BOSS<span><i id="dkBossBar"></i></span><em id="dkBossPct">-</em></div><div class="dk-chat">CHAT<span><i id="dkChatBar"></i></span><em id="dkChatPct">-</em></div></div></div>'
    + '<div class="dk-blk dk-fmblk"><div class="dk-lbl">Face moves <em id="dkFightMovesWhy"></em></div><div class="dk-g2" id="dkFightMoves"></div></div>'
    + '<div class="dk-blk big dk-atkblk"><div class="dk-lbl">Attacks <em id="dkAtkWhy">your face and hands do these too</em></div><div class="dk-g2 stretch" id="dkAtk"></div></div>'
    + '<div class="dk-blk"><div class="dk-lbl">Fight switches <em id="dkFightSwWhy"></em></div><div class="dk-g2">' + SWX('dkFightSong', 'Fights during music') + SWX('dkHandMoves', 'Hand moves in a fight') + '</div></div>'
    + '<div class="dk-blk"><div class="dk-lbl">Where the bars sit <em id="dkBarsWhy"></em></div><div class="dk-row dk-mid"><div class="dk-chips" id="dkBarsPick"></div><input type="range" class="dk-range" id="dkBarsY" min="0" max="100" step="1" value="0" aria-label="The bars: up - down"></div></div>'
    + '</div></section>'
    + '</div>'
    // ---- LOOKS
    + '<div class="dk-looks dk-glass">'
    + '<div class="dk-mon" id="dkMon" title="What is on stream now (from the avatar page; hover to refresh it)"><div class="dk-mon-sw" id="dkMonSw"></div><canvas id="dkMonCv" width="108" height="192"></canvas><span id="dkMonTag">LIVE</span></div>'
    + '<div class="dk-lgroup"><div class="dk-lbl" id="dkFaceLbl">Face style</div><div class="dk-thumbs" id="dkFaces"></div></div>'
    + '<div class="dk-lgroup"><div class="dk-lbl">Background <em id="dkBgCount"></em></div><div class="dk-thumbs dk-scroller" id="dkBgs"></div></div>'
    + '<div class="dk-lgroup"><div class="dk-lbl">Colour <em id="dkColWhy"></em></div><div class="dk-cols" id="dkCols"></div></div>'
    + '<div class="dk-ask" id="dkAsk" hidden><div class="dk-lbl">Your camera <em>click the picture that shows you</em></div><div id="dkAlertSlot"></div></div>'
    + '</div>'
    // ---- STATUS
    + '<div class="dk-status dk-glass" id="dkStatus">'
    + '<div class="dk-st" id="dkStLink" data-s="off" title="LIVE Link sends the show to the Mask"><i class="dk-dot"></i><u>LIVE Link</u><b id="dkLinkText">-</b></div>'
    + '<div class="dk-st song" id="dkStSong" data-s="off"><i class="dk-dot"></i><u>On air</u><b id="dkSongText">-</b></div>'
    + '<div class="dk-st" id="dkStEat" data-s="off"><i class="dk-dot"></i><u>Eat</u><b id="dkStEatText">-</b></div>'
    + '<div class="dk-st" id="dkStTrack" data-s="off"><i class="dk-dot"></i><u>Tracking</u><b id="dkTrackText">-</b></div>'
    + '<div class="dk-st" id="dkStMusic" data-s="off"><i class="dk-dot"></i><u>Music</u><b id="dkMusicText">-</b></div>'
    + '<div class="dk-st" id="dkStMic" title="Microphone level"><u>Mic</u><span class="dk-vu"><i id="dkVu"></i></span></div>'
    + '<div class="dk-st" id="dkStObs" data-s="off"><i class="dk-dot"></i><u>OBS</u><b id="dkObsText">-</b></div>'
    + '<div class="dk-st" id="dkStFps" title="The avatar page: frames a second, and the time one frame takes to draw"><span class="dk-num" id="dkFps">-</span><u>fps</u><span class="dk-num dk-ms" id="dkMs"></span></div>'
    + '<div class="dk-st tick" id="dkStTick"><b id="dkTick"></b></div>'
    + '</div>'
    + '</div>'
    // ---- SETTINGS drawer
    + '<div class="dk-scrim" id="dkScrim"></div>'
    + '<aside class="dk-drawer dk-glass" id="dkDrawer" aria-label="Settings">'
    + '<header><h2 class="dk-chrome">Settings</h2><p>Set once, rarely touched. Nothing here is needed mid-show.</p><button class="dk-mini" id="dkClose">Close <span class="dk-k">Esc</span></button></header>'
    + '<nav class="dk-tabs" id="dkTabs"></nav><div class="dk-panes" id="dkPanes"></div>'
    + '</aside>';

  const PANES = {
    mic: '<h3>Microphone</h3><p>Moves the mouth when no music plays on this PC.</p>'
      + '<div class="dk-classic" data-classic="mic"></div>'
      + '<div class="dk-f"><span>Sensitivity</span><input type="range" class="dk-range" id="dkMicSens" min="-12" max="30" step="1" aria-label="Microphone sensitivity"><span id="dkMicSensVal"></span></div>'
      + '<div class="dk-f"><span>Noise gate</span><input type="range" class="dk-range" id="dkMicGate" min="0" max="0.5" step="0.01" aria-label="Microphone noise gate"><span id="dkMicGateVal"></span></div>'
      + '<div class="dk-wrap"><button class="dk-mini" id="dkMicOn">Stop the microphone</button></div><p class="dk-hint" id="dkMicLine"></p>',
    tracking: '<h3>Face tracking</h3><p>Which camera watches you, and how the face follows you.</p>'
      + '<div class="dk-classic" data-classic="tracking"></div>'
      + '<div class="dk-f"><span>Hero face holds for</span><select class="dk-field" id="dkFaceHold" aria-label="How long a hero face you pick holds"></select><span></span></div>'
      + '<p class="dk-hint">Ryo and Melanie: the faces in the LOOKS strip (keys Q W E R T Y, 0 = Auto) hold this long, then your own face leads again.</p>',
    framing: '<h3>Where you sit in the picture</h3><p class="dk-wait" id="dkPlaceWait" hidden></p><div class="dk-classic" data-classic="framing"></div>',
    keys: '<h3>Keys</h3><p>White = works while this window is in front. Red = LIVE Link\'s key, works from any window (change those in LIVE Link).</p>'
      + '<div class="dk-lbl">This window</div><div class="dk-keyrow" id="dkFixedKeys"></div>'
      + '<div class="dk-lbl">The puppet show (press Change, then the key)</div><p class="dk-wait" id="dkKeysWait" hidden></p><div class="dk-classic" data-classic="keys"></div>'
      + '<div class="dk-lbl">LIVE Link (from any window)</div><div class="dk-keyrow dk-gkeys" id="dkGlobalKeys"></div>',
    obs: '<h3>OBS link</h3><p id="dkObsLine"></p><div class="dk-classic" data-classic="obs"></div>',
    colours: '<h3>Mask colour</h3><p class="dk-wait" id="dkColWait" hidden></p><div class="dk-classic" data-classic="colours"></div>',
    sign: '<h3>Show sign</h3><p>Your looping video or picture at the top of the picture.</p><p class="dk-wait" id="dkSignWait" hidden></p><div class="dk-classic" data-classic="sign"></div>',
    overlay: '<h3>Live overlay (URL)</h3><p>Your ReactivVibe overlay page, shown in a frame over the picture.</p><p class="dk-wait" id="dkOverlayWait" hidden></p><div class="dk-classic" data-classic="overlay"></div>',
    gifts: '<h3>Gifts</h3><div class="dk-classic" data-classic="gifts"></div>',
    try: '<h3>Try the effects</h3><div class="dk-classic" data-classic="try"></div>',
  };

  const root = document.createElement('div');
  root.id = 'dk';
  root.innerHTML = MARKUP;
  document.body.appendChild(root);
  // tabs + panes
  {
    const tabs = $('dkTabs'), panes = $('dkPanes');
    D.TABS.forEach(([id, name], i) => {
      const t = document.createElement('button'); t.textContent = name; t.dataset.tab = id; if (!i) t.className = 'on'; tabs.appendChild(t);
      const p = document.createElement('div'); p.className = 'dk-pane' + (i ? '' : ' on'); p.dataset.pane = id; p.innerHTML = PANES[id] || ''; panes.appendChild(p);
    });
    const c = document.createElement('button'); c.id = 'dkClassic'; c.className = 'dk-classicbtn'; c.innerHTML = 'Classic controls<small>today\'s layout, unchanged</small>'; tabs.appendChild(c);
    const fixed = [['Avatar on / off', 'Space'], ['Smart camera (Mask)', 'K'], ['Close Settings', 'Esc'], ['Hero faces (Ryo / Melanie)', 'Q W E R T Y'], ['Hero face: Auto', '0']];
    $('dkFixedKeys').innerHTML = fixed.map(([a, k]) => '<div><span>' + a + '</span><span class="dk-k">' + k + '</span></div>').join('');
    const gl = [['Goo', G.goo], ['Fire', G.fire], ['Melt', G.melt], ['Crack', G.crack], ['Eat (the move)', G.eat], ['Boss fight', G.fight], ['Vote now', G.vote], ['Eat it', G.eatIt], ['Galaxy', G.galaxy], ['Show sign: show / hide', G.sign]];
    $('dkGlobalKeys').innerHTML = gl.map(([a, k]) => '<div><span>' + a + '</span><span class="dk-k g">' + k + '</span></div>').join('');
    const fh = $('dkFaceHold');
    for (const [ms, label] of D.HERO_FACE_HOLDS) { const o = document.createElement('option'); o.value = String(ms); o.textContent = label; fh.appendChild(o); }
    fh.value = String(pref.faceHold);
  }

  // ---------------------------------------------------------------- moves and attacks (built from the show's own lists)
  const MOVE_SHORT = { goo: 'Goo', fire: 'Fire', melt: 'Melt', crack: 'Crack', eat: 'Eat' };
  const MOVES = SHOW && Array.isArray(SHOW.MOVES) ? SHOW.MOVES : ['goo', 'fire', 'melt', 'crack', 'eat'];
  /** a move pad: the window's own press / let go (js/vtuber.js v8Down / v8Up: Goo and Fire keep going while held) */
  function movePad(name, label) {
    const b = document.createElement('button'); b.className = 'dk-pad sm'; b.dataset.move = name; b.title = (SHOW && SHOW.MOVE_LABEL && SHOW.MOVE_LABEL[name]) || name;
    b.innerHTML = '<b></b><small data-why hidden></small><span class="dk-keys"><span class="dk-k" data-wk></span>' + (G[name] ? '<span class="dk-k g">' + G[name] + '</span>' : '') + '</span><span class="dk-cool"></span>';
    b.firstChild.textContent = label || MOVE_SHORT[name] || b.title;
    b.addEventListener('pointerdown', (e) => { if (e.button || b.disabled) return; try { b.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ } b.classList.add('down'); vt.v8Down(name); after(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => { b.classList.remove('down'); vt.v8Up(name); after(); });
    b.addEventListener('keydown', (e) => { if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && !b.disabled) { e.preventDefault(); vt.v8Down(name); after(); } });
    b.addEventListener('keyup', (e) => { if (e.code === 'Enter' || e.code === 'NumpadEnter') { vt.v8Up(name); after(); } });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
  {
    const box = $('dkMoves');
    for (const name of MOVES) box.appendChild(movePad(name));
    // FIGHT: in a boss fight Goo and Fire head are his attacks on chat (V8T.movesFight); the same window buttons
    for (const name of ['goo', 'fire']) if (MOVES.includes(name)) $('dkFightMoves').appendChild(movePad(name, name === 'fire' ? 'Fire head' : ''));
    const g = document.createElement('button'); g.className = 'dk-pad sm dk-galaxy'; g.id = 'dkGalaxy';
    g.title = 'Calls the galaxy up; again sends it away. Both fists = black hole. Burst open = supernova.';
    g.innerHTML = '<b>Galaxy</b><small id="dkGalSub">fists = black hole · burst = supernova</small><span class="dk-keys"><span class="dk-k g" title="Works from any window (LIVE Link)">' + G.galaxy + '</span></span>';
    g.addEventListener('click', () => { const h = hook('galaxy'); if (h && typeof h.press === 'function') { h.press(); say('Galaxy.'); } after(); });
    // the show sign's show / hide, the window's own #signShow (the show-sign update), with LIVE Link's key (R28)
    const sg = document.createElement('button'); sg.className = 'dk-pad sm dk-signpad'; sg.id = 'dkSignPad';
    sg.innerHTML = '<b>Sign</b><small id="dkSignPadSub">show / hide</small><span class="dk-keys"><span class="dk-k g" title="Works from any window (LIVE Link; Stream Deck F22)">' + G.sign + '</span></span>';
    sg.addEventListener('click', () => { if (press('signShow')) say('Show sign: show / hide.'); });
    const gs = document.createElement('div'); gs.className = 'dk-gs'; gs.appendChild(g); gs.appendChild(sg);
    box.appendChild(gs);
    const atk = $('dkAtk');
    for (const a of D.ATTACKS) {
      const b = document.createElement('button'); b.className = 'dk-pad sm' + (a.wide ? ' dk-wide' : ''); b.dataset.atk = a.name;
      b.innerHTML = '<b></b>' + (a.sub ? '<small data-sub="' + a.sub + '">' + a.sub + '</small>' : '<small data-why hidden></small>') + '<span class="dk-keys"><span class="dk-k" data-wk></span></span>' + (a.kind === 'hold' ? '<span class="dk-charge"><i></i></span>' : '');
      b.firstChild.textContent = a.label;
      if (a.kind === 'hold') {
        b.addEventListener('pointerdown', (e) => { if (e.button || b.disabled) return; try { b.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ } b.classList.add('down'); hyperDown(); after(); });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => { b.classList.remove('down'); hyperUp(); after(); });
        b.addEventListener('contextmenu', (e) => e.preventDefault());
      } else b.addEventListener('click', () => { atkTap(a.name); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); after(); });
      atk.appendChild(b);
    }
  }
  /** the boss fight's attacks are in this build (V9 boss: VTShow.HAND_MOVES and the keys mouth / hyper in L.V8_ACTIONS) */
  const bossOk = () => !!(SHOW && Array.isArray(SHOW.HAND_MOVES) && Array.isArray(L.V8_ACTIONS) && L.V8_ACTIONS.includes('mouth') && L.V8_ACTIONS.includes('hyper'));
  const v8Go = () => S.mask && S.v8 && S.v8.on && !vt.KILL.v8;
  // the very calls the V9 boss window makes on its keys (js/vtuber.js on v9-boss: a tap, or the hyper beam's down / up)
  function atkTap(name) { if (!bossOk() || !v8Go() || !live.on) return; vt.v8Cmd({ action: 'tap', name }); say(((SHOW.HAND_LABEL && SHOW.HAND_LABEL[name]) || name) + '!'); }
  function hyperDown() { if (!bossOk() || !v8Go() || !live.on || vt.v8.held.hyper) return; vt.v8.held.hyper = true; vt.v8Cmd({ action: 'down', name: 'hyper' }); }
  function hyperUp() { if (!vt.v8.held.hyper) return; vt.v8.held.hyper = false; vt.v8Cmd({ action: 'up', name: 'hyper' }); }
  window.addEventListener('blur', hyperUp);
  /** a placeholder hook (js/v9-deck-logic.js HOOKS): there at runtime, or null */
  const hook = (name) => { const h = window.VTDeckHooks && window.VTDeckHooks[name]; return h && typeof h === 'object' ? h : null; };

  // ---------------------------------------------------------------- wiring the deck's own buttons
  $('dkPower').addEventListener('click', () => { press('power'); say(live.on ? 'Avatar ON.' : 'Avatar OFF: your real camera shows.'); });
  for (const b of $$('#dkChars button')) b.addEventListener('click', () => { clearHeroFace(); if (pick('heroes', 'id', b.dataset.c)) say(b.textContent + ' picked.'); });
  $('dkGear').addEventListener('click', () => (root.classList.contains('dk-set') ? closeSet() : openSet()));
  $('dkClose').addEventListener('click', closeSet);
  $('dkScrim').addEventListener('click', closeSet);
  $('dkTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.id === 'dkClassic') { setView('classic'); return; } showTab(b.dataset.tab); });
  $('dkAlertGo').addEventListener('click', () => openSet('obs'));
  // PRE-SHOW
  const setMin = (v) => { const m = $('showMin'); if (!m) return; m.value = String(Math.min(60, Math.max(1, Math.round(v) || 10))); m.dispatchEvent(new Event('input', { bubbles: true })); m.dispatchEvent(new Event('change', { bubbles: true })); after(); };
  $('dkMinDown').addEventListener('click', () => setMin(Number(($('showMin') || {}).value || 10) - 1));
  $('dkMinUp').addEventListener('click', () => setMin(Number(($('showMin') || {}).value || 10) + 1));
  $('dkCdStart').addEventListener('click', () => { if (press('showStart')) say('Countdown: ' + $('dkCdText').textContent.toLowerCase() + '.'); });
  $('dkCdMusic').addEventListener('click', () => press('showMusic'));
  $('dkCdVol').addEventListener('input', (e) => { paintRange(e.target); T($('dkCdVolVal'), e.target.value + '%'); slide('showVol', Number(e.target.value) / 100); });
  $('dkCdFade').addEventListener('click', () => { if (press('showMusicFade')) say('Countdown music fades out.'); });
  $('dkTransform').addEventListener('click', () => { if (press('showFire')) say('Transform: on the next beat.'); });
  $('dkTfPick').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const id = b.dataset.tf, m = tfModel();
    if (m.kind === 'window') pick('faceTfs', 'tf', id); else if (m.kind === 'hook') { hook('transform').set(id); after(); }
    say('Transform: ' + b.textContent.replace(/NEW$/, '').trim());
  });
  $('dkTfBeat').addEventListener('click', () => press('faceTfBeat'));
  $('dkCamMode').addEventListener('click', () => press('camMode'));
  $('dkSmartCam').addEventListener('click', () => press('smartCam'));
  $('dkSignOn').addEventListener('click', () => press('signOn'));
  $('dkSignHide').addEventListener('click', () => press('signShow'));
  $('dkOverlayOn').addEventListener('click', () => press('overlayOn'));
  $('dkOverlayHide').addEventListener('click', () => press('overlayShow'));
  // ON AIR
  $('dkEat').addEventListener('click', () => { if (press('v8Eat')) { const b = $('dkEat'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); say('EAT IT: he chews the cover on the beat, then spits your verdict as a word.'); } });
  $('dkViz').addEventListener('click', () => press('mode'));
  $('dkVizPick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) pick('maskVizs', 'viz', b.dataset.viz); });
  $('dkVote').addEventListener('click', () => press('v8Vote'));
  $('dkVoteWhich').addEventListener('change', (e) => { const s = $('v8VoteWhich'); if (!s) return; s.value = e.target.value; s.dispatchEvent(new Event('change', { bubbles: true })); after(); });
  $('dkVoteRand').addEventListener('click', () => press('v8Rand'));
  for (const [d, c] of [['dkOwnQ', 'v8OwnQ'], ['dkOwnA', 'v8OwnA']]) $(d).addEventListener('input', (e) => { const t = $(c); if (!t) return; t.value = e.target.value; t.dispatchEvent(new Event('input', { bubbles: true })); });
  $('dkV8On').addEventListener('click', () => press('v8On'));
  $('dkV8Chat').addEventListener('click', () => press('v8Chat'));
  $('dkV8Orbit').addEventListener('click', () => press('v8Orbit'));
  $('dkV8Hands').addEventListener('click', () => press('v8Hands'));
  $('dkHandFx').addEventListener('click', () => { const h = hook('handFx'); if (h && typeof h.set === 'function' && typeof h.get === 'function') { h.set(!h.get()); after(); } });
  $('dkShuffle').addEventListener('click', () => press('shuffle'));
  $('dkShuffleAmt').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) pick('shuffleAmt', 'amount', b.dataset.amount); });
  $('dkHypeLook').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled && pick('hypeStyles', 'style', b.dataset.style)) say('Hype look: ' + b.textContent + '.'); });
  // FIGHT
  $('dkFight').addEventListener('click', () => press('v8Fight'));
  $('dkFightSong').addEventListener('click', () => press('v8FightSong'));
  $('dkHandMoves').addEventListener('click', () => press('v8HandMoves'));
  $('dkBarsPick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) pick('v8Bars', 'bars', b.dataset.bars); });
  $('dkBarsY').addEventListener('input', (e) => { paintRange(e.target); slide('v8BarsY', Number(e.target.value) / 100); });
  // LOOKS
  $('dkFaces').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.style) { if (pick('maskStyles', 'style', b.dataset.style)) say('Face style: ' + b.title + '.'); }
    else if (b.dataset.face) setHeroFace(b.dataset.face);
  });
  $('dkBgs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (pick(S.mask ? 'maskBgs' : 'bgs', 'bg', b.dataset.bg)) say('Background: ' + b.title + (S.mask ? ' (burns in behind a scan line).' : '.'));
  });
  $('dkCols').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.classList.contains('more')) { openSet('colours'); return; }
    if (pick('swatches', 'hex', b.dataset.hex)) say('Mask colour: ' + b.title + '.');
  });
  // SETTINGS: the deck's own bits
  $('dkMicSens').addEventListener('input', (e) => { paintRange(e.target); vt.claim(); S.sens = Number(e.target.value); vt.save(); after(); });
  $('dkMicGate').addEventListener('input', (e) => { paintRange(e.target); vt.claim(); S.gate = Number(e.target.value); vt.save(); after(); });
  $('dkMicOn').addEventListener('click', () => { const p = st.micOn ? vt.stopMic() : vt.startMic(); Promise.resolve(p).then(() => { vt.render(); after(); }, () => after()); });
  $('dkFaceHold').addEventListener('change', (e) => { pref.faceHold = Number(e.target.value) || 0; savePref(); if (live.face) { live.faceHoldMs = pref.faceHold; live.faceAt = now(); vt.claim(); vt.sendAvatar(); } after(); });
  // the stacked layout: a folded zone's header opens it
  for (const z of $$('#dk .dk-zone')) z.querySelector('header').addEventListener('click', () => { if (layout === 'stack' && !z.classList.contains('now')) { D.foldToggle(fold, z.dataset.zone, z.classList.contains('open')); syncMoment(); after(); } });
  // the monitor: the mouse over it asks the avatar page for a fresh small picture (as the classic picture does)
  let touchAt = 0;
  $('dkMon').addEventListener('pointermove', () => { if (now() - touchAt > 1000) { touchAt = now(); vt.touchCard(); } });

  // ---------------------------------------------------------------- hero faces (Ryo / Melanie): the avatar page's own manual face
  /** pick a hero face ('auto' = his face leads again); it holds for the time set in SETTINGS > Tracking */
  function setHeroFace(face) {
    if (S.mask) return;
    const f = face === 'auto' ? '' : L.validFace(S.character, face);
    if (face !== 'auto' && !f) return;
    live.face = f || ''; live.faceHoldMs = f ? pref.faceHold : 0; live.faceAt = now(); live.faceFor = S.character;
    vt.claim(); vt.sendAvatar(); after();
    const labels = (L.CHARACTERS[S.character] || {}).faceLabels || {};
    say(f ? 'Face: ' + (labels[f] || f) + (pref.faceHold ? ' for ' + pref.faceHold / 1000 + ' s.' : ', until you change it.') : 'Face: Auto (your own face leads).');
  }
  /** forget a picked hero face (it ran out, another one was picked, or the Mask): nothing is sent, the avatar page lets go by itself */
  function clearHeroFace(send) { if (!live.face) return; live.face = ''; live.faceHoldMs = 0; if (send) { vt.claim(); vt.sendAvatar(); } }

  // ---------------------------------------------------------------- the SETTINGS drawer
  let moreWas = null;
  function showTab(id) { for (const b of $$('#dkTabs button[data-tab]')) C(b, 'on', b.dataset.tab === id); for (const p of $$('#dkPanes .dk-pane')) C(p, 'on', p.dataset.pane === id); after(); }
  function openSet(tab) {
    if (!deckOn()) return;
    root.classList.add('dk-set'); if (tab) showTab(tab);
    // the window loads its camera pictures and its gift list while "More" is open: the drawer is that "More"
    const more = $('more'); if (more) { if (moreWas === null) moreWas = more.open; if (!more.open) more.open = true; }
    after();
  }
  function closeSet() {
    if (!root.classList.contains('dk-set')) return;
    root.classList.remove('dk-set');
    const more = $('more'); if (more && moreWas !== null) { more.open = moreWas; moreWas = null; }
  }
  // the window's own controls, moved in while the deck shows (a comment keeps each one's spot; they go back there)
  const parked = [];
  function park(n, box) { if (!n || !box || !n.parentNode) return; const ph = document.createComment('dk:' + (n.id || 'row')); n.parentNode.insertBefore(ph, n); box.appendChild(n); parked.push([n, ph]); }
  function moveIn() {
    if (parked.length) return;
    for (const [tab, ids] of Object.entries(D.MOVED)) {
      const box = root.querySelector('[data-classic="' + tab + '"]'); if (!box) continue;
      for (const id of ids) { const n = $(id); if (n) park(id === 'giftAdd' ? n.parentNode : n, box); }
    }
    park($('camAsk'), $('dkAlertSlot'));
  }
  function moveOut() { for (let i = parked.length - 1; i >= 0; i--) { const [n, ph] = parked[i]; if (ph.parentNode) { ph.parentNode.insertBefore(n, ph); ph.parentNode.removeChild(ph); } } parked.length = 0; }

  // ---------------------------------------------------------------- the view: the deck, or the classic layout (unchanged)
  const deckOn = () => html.classList.contains('dk-on');
  let loop = 0, vuLoop = 0, monLoop = false;
  function setView(v) {
    const deck = v !== 'classic';
    pref.view = deck ? 'deck' : 'classic'; savePref();
    if (deck) { moveIn(); html.classList.add('dk-on'); start(); sync(); }
    else { closeSet(); clearHeroFace(true); moveOut(); html.classList.remove('dk-on'); stop(); }
    guard('render', () => vt.render());
    if (!deck) window.scrollTo(0, 0);
  }
  function start() {
    if (!loop) loop = setInterval(sync, 200);
    if (!vuLoop) vuLoop = setInterval(() => { const v = $('dkVu'); if (v) v.style.width = (Math.max(0, Math.min(1, st.level || 0)) * 100).toFixed(1) + '%'; }, 50);
    if (!monLoop) { monLoop = true; requestAnimationFrame(drawMon); }
  }
  function stop() { clearInterval(loop); clearInterval(vuLoop); loop = vuLoop = 0; }
  const back = document.createElement('button');
  back.id = 'dkOpen'; back.type = 'button'; back.textContent = 'Control deck'; back.title = 'Back to the one-screen control deck';
  back.addEventListener('click', () => setView('deck'));
  document.body.appendChild(back);

  window.addEventListener('keydown', (e) => {
    if (!deckOn()) return;
    if (e.code === 'Escape') { if (root.classList.contains('dk-set')) { e.preventDefault(); closeSet(); } return; }
    // Ryo / Melanie: Q W E R T Y = the six faces, 0 = Auto (window keys only; the Mask's keys are its own)
    if (S.mask || e.ctrlKey || e.altKey || e.metaKey || e.repeat || typing(e) || (vt.v8 && vt.v8.keyWait)) return;
    const f = D.heroFaceForKey(e.code, (L.CHARACTERS[S.character] || {}).faces);
    if (!f) return;
    e.preventDefault(); setHeroFace(f);
  });
  window.addEventListener('resize', after);

  // ---------------------------------------------------------------- the monitor (the stream's small picture, from the avatar page)
  let monAt = -1;
  function drawMon() {
    if (!deckOn()) { monLoop = false; return; }
    requestAnimationFrame(drawMon);
    const cv = $('dkMonCv'); if (!cv) return;
    const img = st.pvImg, ok = live.on && img && st.pvWho === vt.who();
    cv.style.visibility = ok ? 'visible' : 'hidden';
    if (!ok || st.pvAt === monAt) return;
    monAt = st.pvAt;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    try { ctx.drawImage(img, 0, 0, cv.width, cv.height); } catch (e) { /* not drawable */ }
  }

  // ---------------------------------------------------------------- the transform picker (the transforms update, a hook, or scan line only)
  function tfModel() {
    const NEW = Object.fromEntries(D.TRANSFORMS.map((t) => [t.id, !!t.isNew]));
    const box = $('faceTfs');
    if (box && box.children.length) return { kind: 'window', why: '', items: Array.from(box.children).filter((c) => c.dataset.tf).map((c) => ({ id: c.dataset.tf, label: c.textContent.trim(), on: sel(c), dis: c.disabled, isNew: NEW[c.dataset.tf] })) };
    const h = hook('transform');
    if (h && Array.isArray(h.list) && typeof h.get === 'function' && typeof h.set === 'function') { const cur = h.get(); return { kind: 'hook', why: '', items: h.list.map((t) => ({ id: t.id, label: t.label || t.id, on: t.id === cur, dis: false, isNew: NEW[t.id] })) }; }
    return { kind: 'none', why: D.HOOKS.transform, items: D.TRANSFORMS.map((t) => ({ id: t.id, label: t.label, on: t.id === 'scan', dis: t.id !== 'scan', isNew: t.isNew })) };
  }

  // ---------------------------------------------------------------- mirrors: deck chips / thumbnails drawn from the window's own rows
  function mirrorChips(box, src, key) {
    if (!box) return [];
    const kids = src ? Array.from(src.children).filter((c) => c.dataset[key] !== undefined) : [];
    const sig = kids.map((c) => c.dataset[key] + ':' + c.textContent).join('|');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig; box.textContent = '';
      for (const c of kids) { const b = document.createElement('button'); b.dataset[key] = c.dataset[key]; b.textContent = c.textContent.trim(); b.title = b.textContent; box.appendChild(b); }
    }
    kids.forEach((c, i) => { const b = box.children[i]; if (b) C(b, 'on', sel(c)); });
    return kids;
  }
  const BASE_BGS = ['black', 'summer', 'ice', 'forge', 'nebula', 'studio', 'street', 'transparent', 'green', 'preset:courtyard', 'preset:grove', 'preset:frostkeep'];
  const BASE_STYLES = ['classic', 'core', 'quantum'];
  function thumbStyle(th, c) {
    th.style.cssText = c.style.cssText;
    if (!c.style.cssText) th.style.background = c.dataset.bg === 'transparent' ? 'repeating-conic-gradient(#2a211e 0 25%, #171110 0 50%) 0 0 / 1.2rem 1.2rem' : '#120d0b';
    else { th.style.backgroundSize = 'cover'; th.style.backgroundPosition = 'center'; }
  }
  function mirrorThumbs(box, src, key, base) {
    if (!box) return [];
    const kids = src ? Array.from(src.children).filter((c) => c.dataset[key] !== undefined) : [];
    const sig = key + '#' + kids.map((c) => c.dataset[key] + ':' + c.textContent + ':' + c.style.cssText).join('|');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig; box.textContent = '';
      for (const c of kids) {
        const th = document.createElement('button'); th.className = 'dk-th'; th.dataset[key] = c.dataset[key]; th.title = c.textContent.trim();
        thumbStyle(th, c);
        th.innerHTML = (base.includes(c.dataset[key]) ? '' : '<i class="dk-tagnew">NEW</i>') + '<span></span>';
        th.lastChild.textContent = th.title;
        box.appendChild(th);
      }
    }
    kids.forEach((c, i) => { const b = box.children[i]; if (b) C(b, 'on', sel(c)); });
    return kids;
  }
  function heroFaceThumbs(box) {
    const ch = L.CHARACTERS[S.character] || { faces: [], faceLabels: {} };
    const sig = 'face#' + S.character;
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig; box.textContent = '';
      const keys = ['Q', 'W', 'E', 'R', 'T', 'Y'];
      [...ch.faces.slice(0, 6), 'auto'].forEach((f, i) => {
        const th = document.createElement('button'); th.className = 'dk-th'; th.dataset.face = f;
        th.title = f === 'auto' ? 'Auto: your own face leads' : (ch.faceLabels[f] || f);
        th.style.background = 'linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.8)), url("assets/ui/' + S.character + '.jpg") center 22% / cover no-repeat';
        th.innerHTML = '<kbd class="dk-k"></kbd><span></span>';
        th.firstChild.textContent = f === 'auto' ? '0' : keys[i]; th.lastChild.textContent = f === 'auto' ? 'Auto' : (ch.faceLabels[f] || f);
        box.appendChild(th);
      });
    }
    const cur = L.validFace(S.character, live.face) || 'auto';
    for (const b of box.children) C(b, 'on', b.dataset.face === cur);
  }
  let shownBg = '';
  function keepBgInView(box) {
    const on = box.querySelector('.on'); const key = on ? on.dataset.bg : '';
    if (!on || key === shownBg || box.scrollWidth <= box.clientWidth) return;
    shownBg = key;
    const a = on.offsetLeft - box.offsetLeft, b = a + on.offsetWidth;
    if (a < box.scrollLeft) box.scrollLeft = a; else if (b > box.scrollLeft + box.clientWidth - 40) box.scrollLeft = b - box.clientWidth + 48;
  }

  // ---------------------------------------------------------------- the zone of the moment
  let moment = null, layout = '';
  // the stacked layout's folding: what he opens or closes by hand stays so for the whole moment; it goes back to the
  // default only once a new moment has held 1.5 s (a flicker of the song is not a new moment; fix round 1, I-1)
  const fold = D.foldNew();
  function syncMoment() {
    const m = D.momentOf({ on: live.on, v8: vt.v8Ack(), show: vt.showAck() });
    const lay = D.layoutFor(window.innerWidth);
    root.dataset.layout = lay; root.dataset.moment = m || 'none';
    moment = m; layout = lay;
    D.foldTick(fold, m, now());
    const first = D.openZoneFor(m);
    for (const z of $$('#dk .dk-zone')) {
      const id = z.dataset.zone;
      C(z, 'now', id === m);
      C(z, 'dk-first', id === first);
      C(z, 'open', D.zoneOpen(fold, id));
    }
  }

  // ---------------------------------------------------------------- the sync: the deck follows the window (every 200 ms, and right after a press)
  const EAT_S = { ready: 'ok', busy: 'busy', waiting: 'wait', wait: 'wait', 'no-cover': 'warn', 'not-linked': 'warn', off: 'off' };
  const EAT_SHORT = { ready: 'EAT READY', busy: 'Eating', waiting: 'Waiting for a song', wait: 'Waiting for the Mask', 'no-cover': 'No cover yet', 'not-linked': 'Not linked', off: 'Avatar off' };
  const notIn = 'Not in this build.';
  const alertSt = D.alertNew();
  function sync() {
    if (!deckOn()) return;
    const k8 = live.on ? vt.v8Ack() : null, ks = vt.showAck();
    const maskWhy = S.mask ? '' : W.mask;
    const v8Why = !S.mask ? W.mask : vt.KILL.v8 ? notIn : !S.v8.on ? W.v8off : '';

    guard('moment', syncMoment);
    guard('top', () => {
      C($('dkPower'), 'on', live.on); T($('dkPowerText'), live.on ? 'ON' : 'OFF');
      const whoName = S.mask ? 'The Mask' : (L.CHARACTERS[S.character] || {}).label || 'Ryo';
      T($('dkPowerHint'), live.on ? whoName + ' is on stream' : 'Your real camera is showing');
      const c = S.mask ? 'mask' : S.character;
      for (const b of $$('#dkChars button')) C(b, 'on', b.dataset.c === c);
      // a hero face runs out, or another character / the Mask is picked: forget it (the avatar page lets go by itself)
      if (live.face && (S.mask || live.faceFor !== S.character || (live.faceHoldMs && now() - live.faceAt > live.faceHoldMs))) clearHeroFace(false);
    });
    guard('alert', () => {
      const cls = vt.cls(), n = vt.notes(), ask = $('camAsk'), askOn = !!ask && !ask.hidden, pw = !!(st.srv && st.srv.obs === 'password');
      const want = cls === 'bad' || cls === 'wait' || n.length > 0 || askOn;
      const on = D.alertTick(alertSt, want, now()).on;
      HID($('dkAlert'), !on); C(root, 'dk-alerting', on);
      // the words follow the window while it is wanted; while it waits to hide it keeps the last ones
      if (want) {
        const text = vt.sentence(), note = n.join(' · ');
        T($('dkAlertText'), text); T($('dkAlertNote'), note); HID($('dkAlertNote'), !n.length); C($('dkAlert'), 'bad', cls === 'bad');
        TIP($('dkAlert'), text + (note ? '\n' + n.join('\n') : ''));
      }
      HID($('dkAsk'), !(on && askOn));
      HID($('dkAlertGo'), !pw);
    });

    // ---------------- PRE-SHOW
    guard('pre', () => {
      const cdWhy = !S.mask ? W.mask : !L.v9Shows('countdown') || !$('showStart') ? notIn : S.camMode ? W.camMode : '';
      const up = !!(ks && ks.state === 'card');
      const min = Number(($('showMin') || {}).value) || 10;
      T($('dkMin'), String(min)); DIS($('dkMinDown'), !!cdWhy || min <= 1); DIS($('dkMinUp'), !!cdWhy || min >= 60);
      const start = $('dkCdStart');
      DIS(start, !!cdWhy || !$('showStart') || $('showStart').disabled); C(start, 'on', up);
      T($('dkCdText'), up ? 'Stop countdown' : 'Start countdown');
      padSub($('dkCdSub'), up ? 'Running. Camera covered until zero.' : 'Covers your camera, burns away at zero', cdWhy);
      const left = up ? ks.left : min * 60, meter = up ? Math.round((ks.meter || 0) * 100) : 0;
      T($('dkCdLeft'), D.clock(left)); T($('dkCdIgn'), String(meter)); T($('dkCdTaps'), String(up ? ks.taps || 0 : 0)); T($('dkCdGifts'), String(up ? ks.gifts || 0 : 0));
      $('dkIgn').style.width = meter + '%';
      // countdown music (the countdown-music update: #showMusic, #showVol, #showMusicFade)
      const mus = $('showMusic'), musWhy = !mus ? W.cdMusic : !S.mask ? W.mask : '';
      sw($('dkCdMusic'), sel(mus), musWhy); T($('dkCdMusicWhy'), musWhy); C($('dkCdMusicWhy'), 'dk-why', !!musWhy);
      const vol = $('showVol'), dv = $('dkCdVol');
      DIS(dv, !vol || !!musWhy);
      if (vol && document.activeElement !== dv) { const p = Math.round(Number(vol.value) * 100); if (Number(dv.value) !== p) dv.value = String(p); }
      T($('dkCdVolVal'), dv.value + '%'); paintRange(dv);
      DIS($('dkCdFade'), !$('showMusicFade') || !!musWhy || $('showMusicFade').disabled);
      // TRANSFORM (#showFire)
      const fire = $('showFire'), tf = $('dkTransform');
      DIS(tf, !!cdWhy || !fire || fire.disabled);
      T($('dkTfText'), ks && ks.queued ? 'Queued' : ks && ks.running ? 'Transforming' : ks && ks.state === 'real' ? 'Transform' : 'Back to my face');
      C(tf, 'on', !!(ks && (ks.queued || ks.running)));
      padSub($('dkTfSub'), fire ? $('showFireHint').textContent : '', cdWhy);
      const m = tfModel(), pickBox = $('dkTfPick');
      const sig = m.kind + '#' + m.items.map((t) => t.id + ':' + t.label).join('|');
      if (pickBox.dataset.sig !== sig) {
        pickBox.dataset.sig = sig; pickBox.textContent = '';
        for (const t of m.items) { const b = document.createElement('button'); b.dataset.tf = t.id; b.textContent = t.label; if (t.isNew) b.insertAdjacentHTML('beforeend', ' <i class="dk-tagnew">NEW</i>'); pickBox.appendChild(b); }
      }
      m.items.forEach((t, i) => { const b = pickBox.children[i]; if (!b) return; C(b, 'on', t.on); DIS(b, t.dis); TIP(b, t.dis ? m.why : t.label); });
      const beat = $('faceTfBeat'); HID($('dkTfBeat'), !beat); if (beat) C($('dkTfBeat'), 'on', sel(beat));
      // camera
      const cm = $('camMode');
      sw($('dkCamMode'), !!S.camMode, !cm ? notIn : maskWhy);
      const scWhy = !S.mask ? W.mask : !L.v9Shows('smartcam') || !$('smartCam') ? W.smartcam : '';
      sw($('dkSmartCam'), !!S.maskCam, scWhy);
      const taken = vt.smartCamKeyTaken();
      HID($('dkSmartKey'), !!taken || !!scWhy); TIP($('dkSmartKey'), taken ? 'K belongs to the puppet show right now: use the switch.' : 'K, while this window is in front');
      // the show sign and the live overlay (URL) (the show-sign update; R31: the URL frame's ids are 'overlay', 'hype' is the meter)
      const sOn = $('signOn'), oOn = $('overlayOn');
      const signWhy = !sOn ? W.sign : !S.mask && !shownEl(sOn) ? W.mask : '', ovWhy = !oOn ? W.overlay : !S.mask && !shownEl(oOn) ? W.mask : '';
      sw($('dkSignOn'), sel(sOn), signWhy); sw($('dkOverlayOn'), sel(oOn), ovWhy);
      const sH = $('signShow'), oH = $('overlayShow');
      DIS($('dkSignHide'), !!signWhy || !sH || sH.disabled); DIS($('dkOverlayHide'), !!ovWhy || !oH || oH.disabled);
      T($('dkSignHide'), sH && /show/i.test(($('signShowText') || sH).textContent) ? 'Show' : 'Hide');
      T($('dkOverlayHide'), oH && /show/i.test(($('overlayShowText') || oH).textContent) ? 'Show' : 'Hide');
      const sw2 = signWhy && ovWhy && signWhy !== ovWhy ? signWhy + ' ' + ovWhy : signWhy || ovWhy;
      T($('dkSignWhy'), sw2); C($('dkSignWhy'), 'dk-why', !!sw2);
    });

    // ---------------- ON AIR
    guard('air', () => {
      const eatB = $('v8Eat'), el = L.eatLine({ on: live.on, ack: k8 });
      const eatWhy = !S.mask ? W.mask : vt.KILL.v8 || !eatB ? notIn : '';
      DIS($('dkEat'), !!eatWhy || !eatB || eatB.disabled);
      const es = eatWhy ? 'off' : el.state;
      $('dkEatLine').dataset.s = EAT_S[es] || 'wait';
      T($('dkEatText'), eatWhy || (es === 'ready' ? 'EAT READY: ' : '') + (($('v8EatText') && $('v8EatText').textContent) || el.text || EAT_SHORT[es] || ''));
      // Visualizer (#mode) and its styles (#maskVizs)
      const viz = !!$('mode') && $('mode').classList.contains('viz');
      DIS($('dkViz'), !!maskWhy); C($('dkViz'), 'on', viz && !maskWhy);
      T($('dkVizText'), viz ? 'Face' : 'Visualizer');
      padSub($('dkVizSub'), viz ? 'Visualizer is on. Press to bring your face back.' : 'Break the face apart into a music visualizer', maskWhy);
      const vk = mirrorChips($('dkVizPick'), $('maskVizs'), 'viz');
      HID($('dkVizPick'), !vk.length || !shownEl($('maskVizs')) && !!S.mask);
      for (const b of $('dkVizPick').children) DIS(b, !!maskWhy);
      // votes (#v8Vote, #v8VoteWhich, #v8Rand, #v8OwnQ / #v8OwnA)
      const vote = $('v8Vote'), voting = !!(k8 && k8.vote && k8.vote.active);
      DIS($('dkVote'), !!v8Why || !vote || vote.disabled); C($('dkVote'), 'on', voting);
      T($('dkVoteText'), voting ? 'End vote' : 'Vote now');
      padSub($('dkVoteSub'), voting ? (k8.vote.left + ' s left. ' + ($('v8VoteHint') ? $('v8VoteHint').textContent : '')) : 'Starts the vote picked below, on stream', v8Why || (vote && vote.disabled ? (!live.on ? 'Turn the avatar ON first.' : 'Not during a boss fight.') : ''));
      keyChip($('dkVoteKey'), S.v8Keys.vote);
      const src = $('v8VoteWhich'), dst = $('dkVoteWhich');
      if (src) {
        const sig = Array.from(src.options).map((o) => o.value + ':' + o.textContent).join('|');
        if (dst.dataset.sig !== sig) { dst.dataset.sig = sig; dst.textContent = ''; for (const o of src.options) { const n = document.createElement('option'); n.value = o.value; n.textContent = o.textContent; dst.appendChild(n); } }
        if (document.activeElement !== dst && dst.value !== src.value) dst.value = src.value;
      }
      DIS(dst, !!v8Why);
      sw($('dkVoteRand'), !!S.v8.rand, v8Why);
      HID($('dkOwnBox'), !!v8Why || !$('v8Own') || $('v8Own').hidden);
      for (const [d, c] of [['dkOwnQ', 'v8OwnQ'], ['dkOwnA', 'v8OwnA']]) { const a = $(d), b = $(c); if (b && document.activeElement !== a && a.value !== b.value) a.value = b.value; }
      // moves (the window's own #v8Moves buttons: greyed / going / cooling, and why)
      for (const b of $$('#dkMoves [data-move], #dkFightMoves [data-move]')) {
        const name = b.dataset.move, c = document.querySelector('#v8Moves [data-move="' + name + '"]');
        const why = v8Why || (c ? c.children[2].textContent : '');
        const dis = !!v8Why || !c || c.disabled;
        if (dis && b.classList.contains('down')) { b.classList.remove('down'); vt.v8Up(name); }
        DIS(b, dis); C(b, 'go', !v8Why && !!c && c.classList.contains('go')); C(b, 'on', !v8Why && !!c && c.classList.contains('atk'));
        const s = b.querySelector('[data-why]'); T(s, why); HID(s, !why); C(s, 'dk-why', !!why);
        keyChip(b.querySelector('[data-wk]'), S.v8Keys[name]);
        b.querySelector('.dk-cool').style.width = !v8Why && c ? c.children[3].style.width || '0%' : '0%';
      }
      T($('dkMovesWhy'), v8Why || 'hold the button or the key'); C($('dkMovesWhy'), 'dk-why', !!v8Why);
      T($('dkFightMovesWhy'), v8Why || (k8 && k8.fight ? 'your attacks on chat now, 20 s apart' : 'in a fight these hit chat, 20 s apart')); C($('dkFightMovesWhy'), 'dk-why', !!v8Why);
      const gal = hook('galaxy'), galOk = !!gal && typeof gal.press === 'function', galWhy = !galOk ? D.HOOKS.galaxy : maskWhy;
      DIS($('dkGalaxy'), !!galWhy); padSub($('dkGalSub'), 'fists = black hole · burst = supernova', !galOk ? 'comes with the galaxy update' : maskWhy);
      TIP($('dkGalaxy'), galWhy || 'Calls the galaxy up; again sends it away. Both fists = black hole. Burst open = supernova.');
      const sgOn = $('signOn'), sgH = $('signShow');
      const sgWhy = !sgOn || !sgH ? W.sign : !S.mask && !shownEl(sgOn) ? W.mask : sgH.disabled ? 'Turn the show sign on first (PRE-SHOW).' : '';
      DIS($('dkSignPad'), !!sgWhy); padSub($('dkSignPadSub'), 'show / hide', sgWhy);
      TIP($('dkSignPad'), sgWhy || ((sgH && /show/i.test(($('signShowText') || sgH).textContent)) ? 'Shows the show sign again' : 'Hides the show sign now') + ' (' + G.sign + ' from any window).');
      // what is greyed in the moves row and why, in words (the shared cell is too small for the reasons)
      const later = [!galOk ? 'Galaxy' : '', !sgOn || !sgH ? 'Sign' : ''].filter(Boolean);
      const mw = v8Why ? '' : later.length === 2 ? 'Galaxy and Sign come with their updates.' : later[0] === 'Galaxy' ? 'Galaxy comes with the galaxy update.' : later[0] === 'Sign' ? W.sign : '';
      T($('dkMovesWait'), mw); HID($('dkMovesWait'), !mw);
      // the show switches
      sw($('dkV8On'), !!S.v8.on, !S.mask ? W.mask : vt.KILL.v8 ? notIn : '');
      sw($('dkV8Chat'), !!S.v8.chat, v8Why); sw($('dkV8Orbit'), !!S.v8.orbit, v8Why); sw($('dkV8Hands'), !!S.v8.hands, v8Why);
      const fx = hook('handFx'); sw($('dkHandFx'), !!(fx && typeof fx.get === 'function' && fx.get()), fx && typeof fx.set === 'function' ? maskWhy : D.HOOKS.handFx);
      const shufCard = $('shuffleCard'), shufWhy = !shufCard || shufCard.hidden ? notIn : '';
      sw($('dkShuffle'), !!S.shuffle, shufWhy);
      mirrorChips($('dkShuffleAmt'), $('shuffleAmt'), 'amount');
      for (const b of $('dkShuffleAmt').children) DIS(b, !!shufWhy);
      mirrorChips($('dkHypeLook'), $('hypeStyles'), 'style');
      for (const b of $('dkHypeLook').children) DIS(b, !!maskWhy);
      // the window's own warning: the look he picked could not start on the avatar page (it says what draws instead)
      const hn = $('hypeNote'), hypeSay = maskWhy || (hn && !hn.hidden ? hn.textContent : '');
      T($('dkHypeWhy'), hypeSay); C($('dkHypeWhy'), 'dk-why', !!hypeSay);
      for (const b of $('dkHypeLook').children) { const c = document.querySelector('#hypeStyles [data-style="' + b.dataset.style + '"]'); C(b, 'dk-real', !!c && c.classList.contains('now')); }
    });

    // ---------------- FIGHT
    guard('fight', () => {
      const f = $('v8Fight');
      DIS($('dkFight'), !!v8Why || !f || f.disabled); C($('dkFight'), 'on', !v8Why && !!f && f.classList.contains('run'));
      const ft = ($('v8FightText') || {}).textContent || 'BOSS FIGHT', fWhy = (($('v8FightWhy') || {}).textContent || '').replace(/\s+\[[^\]]*\]\s*$/, '');
      // while it runs the window's button reads the score ("YOU 62% - CHAT 38%"), too long beside the key chips: the deck
      // says END FIGHT (as the approved mockup) and puts the score in the line under it
      const fRun = !v8Why && !!f && f.classList.contains('run');
      T($('dkFightText'), v8Why ? 'Boss fight' : fRun ? 'End fight' : ft);
      padSub($('dkFightWhy'), fRun ? [ft, fWhy].filter(Boolean).join(' · ') : fWhy, v8Why);
      keyChip($('dkFightKey'), S.v8Keys.fight);
      const fight = k8 && k8.fight;
      const bp = fight ? Math.max(0, Math.min(100, Number(fight.boss) || 0)) : 0, cp = fight ? Math.max(0, Math.min(100, Number(fight.chat) || 0)) : 0;
      $('dkBossBar').style.width = bp + '%'; $('dkChatBar').style.width = cp + '%';
      T($('dkBossPct'), fight ? bp + '%' : '-'); T($('dkChatPct'), fight ? cp + '%' : '-');
      const boss = bossOk(), atkWhy = !boss ? W.boss : v8Why;
      for (const b of $$('#dkAtk [data-atk]')) {
        const name = b.dataset.atk;
        DIS(b, !!atkWhy || !live.on);
        if (b.disabled && b.classList.contains('down')) { b.classList.remove('down'); hyperUp(); }
        keyChip(b.querySelector('[data-wk]'), boss ? S.v8Keys[name] : '');
      }
      T($('dkAtkWhy'), atkWhy || (!live.on ? 'Turn the avatar ON first.' : 'your face and hands do these too')); C($('dkAtkWhy'), 'dk-why', !!atkWhy || !live.on);
      const fs = $('v8FightSong'), hm = $('v8HandMoves'), fsWhy = !fs || !hm ? W.boss : v8Why;
      sw($('dkFightSong'), sel(fs), fsWhy); sw($('dkHandMoves'), sel(hm), fsWhy);
      T($('dkFightSwWhy'), fsWhy); C($('dkFightSwWhy'), 'dk-why', !!fsWhy);
      mirrorChips($('dkBarsPick'), $('v8Bars'), 'bars');
      for (const b of $('dkBarsPick').children) DIS(b, !!v8Why);
      const by = $('dkBarsY'); DIS(by, !!v8Why);
      if (document.activeElement !== by) { const p = Math.round((Number(S.v8.bars) || 0) * 100); if (Number(by.value) !== p) by.value = String(p); }
      paintRange(by);
      T($('dkBarsWhy'), v8Why); C($('dkBarsWhy'), 'dk-why', !!v8Why);
    });

    // ---------------- LOOKS
    guard('looks', () => {
      const faces = $('dkFaces'), bgs = $('dkBgs');
      T($('dkFaceLbl'), S.mask ? 'Face style' : 'Face');
      if (S.mask) mirrorThumbs(faces, $('maskStyles'), 'style', BASE_STYLES); else heroFaceThumbs(faces);
      const list = mirrorThumbs(bgs, $(S.mask ? 'maskBgs' : 'bgs'), 'bg', BASE_BGS);
      T($('dkBgCount'), list.length + (bgs.scrollWidth > bgs.clientWidth + 2 ? ' · slide for more' : ''));
      keepBgInView(bgs);
      // the colours (#swatches): the Mask's; greyed for the heroes
      const cols = $('dkCols'), swx = $('swatches'), card = $('colourCard');
      const colWhy = !S.mask ? W.mask : vt.KILL.colour || !card ? notIn : '';
      const kids = swx ? Array.from(swx.children).filter((c) => c.dataset.hex !== undefined) : [];
      const sig = kids.map((c) => c.dataset.hex + ':' + c.title).join('|');
      if (cols.dataset.sig !== sig) {
        cols.dataset.sig = sig; cols.textContent = '';
        for (const c of kids) {
          const b = document.createElement('button'); b.dataset.hex = c.dataset.hex; b.title = c.title; b.setAttribute('aria-label', c.title);
          if (!c.dataset.hex) { b.className = 'auto'; b.textContent = 'A'; b.title = 'Auto: crimson, and the music and your face shift it'; }
          else b.style.background = 'linear-gradient(165deg, #ffffff66 0%, #ffffff00 46%, #00000040 100%), ' + c.dataset.hex;
          cols.appendChild(b);
        }
        const m = document.createElement('button'); m.className = 'more'; m.textContent = '...'; m.title = 'Any other colour'; m.setAttribute('aria-label', 'Any other colour'); cols.appendChild(m);
      }
      kids.forEach((c, i) => { const b = cols.children[i]; if (b) { C(b, 'on', sel(c)); DIS(b, !!colWhy); } });
      DIS(cols.lastChild, !!colWhy);
      T($('dkColWhy'), colWhy ? 'the Mask\'s' : ''); C($('dkColWhy'), 'dk-why', !!colWhy); TIP(cols, colWhy);
      // the monitor's stand-in (no fresh small picture): the face's own swatch
      const swEl = $('dkMonSw'), cur = S.mask ? document.querySelector('#maskStyles [data-style="' + S.maskStyle + '"]') : null;
      const bgStand = S.mask ? (cur ? cur.style.background : '') || '#120d0b' : 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,.7)), url("assets/ui/' + S.character + '.jpg") center 22% / cover no-repeat';
      if (swEl.dataset.bg !== bgStand) { swEl.dataset.bg = bgStand; swEl.style.background = bgStand; }
      T($('dkMonTag'), live.on ? 'LIVE' : 'OFF');
    });

    // ---------------- STATUS
    guard('status', () => {
      const set = (id, s, text, tip) => { const el = $(id); if (el.dataset.s !== s) el.dataset.s = s; const b = el.querySelector('b'); if (b) T(b, text); if (tip !== undefined) TIP(el, tip); };
      if (!S.mask) set('dkStLink', 'off', 'Mask only', 'LIVE Link sends the show to the Mask');
      else if (!k8) set('dkStLink', 'off', live.on ? 'Waiting for the Mask' : 'Avatar off', 'LIVE Link sends the show to the Mask');
      else set('dkStLink', k8.songSrc === 'link' ? 'ok' : 'warn', k8.songSrc === 'link' ? 'Linked to your studio' : k8.songSrc === 'ear' ? 'Not linked (hearing the music)' : 'Not linked', 'LIVE Link sends the show to the Mask');
      const song = k8 && k8.song;
      set('dkStSong', song ? 'live' : 'off', song ? (k8.title || 'A song is on air') : k8 ? 'No song on air' : '-');
      const el = L.eatLine({ on: live.on, ack: k8 }), es = !S.mask ? 'off' : el.state;
      set('dkStEat', !S.mask || es === 'off' ? 'off' : EAT_S[es] === 'ok' || EAT_S[es] === 'busy' ? 'ok' : 'warn', !S.mask ? 'Mask only' : EAT_SHORT[es] || es);
      const ts = vt.tracker(), s = ts && ts.stats, flowing = !!(s && s.lastFrameAgo >= 0 && s.lastFrameAgo < 1500);
      set('dkStTrack', !ts ? 'off' : !flowing ? 'warn' : s.faceFound ? 'ok' : 'warn', !ts ? 'Starting' : !flowing ? 'No picture' : s.faceFound ? 'Face found' : 'No face', vt.sentence());
      const snd = st.srv && st.srv.mask ? st.srv.mask.sound : null;
      set('dkStMusic', !snd ? 'off' : snd.src === 'pc' || snd.src === 'obs' ? 'ok' : 'warn', !snd ? '-' : snd.src === 'pc' ? 'Hearing this PC' : snd.src === 'obs' ? 'Hearing OBS' : snd.pc === 'starting' ? 'Starting' : st.micOn ? 'Your voice' : 'Your face only', ($('sound') || {}).textContent || '');
      const obs = st.srv ? st.srv.obs : '';
      set('dkStObs', obs === 'ok' ? 'ok' : obs ? 'warn' : 'off', obs === 'ok' ? 'Linked' : obs === 'password' ? 'Needs the password' : obs === 'closed' ? 'OBS is closed' : obs === 'off' ? 'Not linked' : '-');
      const fps = Number(st.ackFps), ms = st.maskAck && S.mask && Number(st.maskAck.drawMs);
      T($('dkFps'), Number.isFinite(fps) && fps > 0 ? String(Math.round(fps)) : '-'); T($('dkMs'), Number.isFinite(ms) && ms > 0 ? Math.round(ms) + ' ms' : '');
      const note = ($('v8Note') || {}).textContent || '', shuf = S.shuffle ? ($('shuffleNow') || {}).textContent || '' : '';
      T($('dkTick'), now() < sayUntil ? sayText : note || shuf || '');
    });

    // ---------------- SETTINGS (only what the deck adds; the moved controls draw themselves)
    guard('settings', () => {
      const sens = $('dkMicSens'), gate = $('dkMicGate');
      if (document.activeElement !== sens && Number(sens.value) !== S.sens) sens.value = String(S.sens);
      if (document.activeElement !== gate && Number(gate.value) !== S.gate) gate.value = String(S.gate);
      paintRange(sens); paintRange(gate);
      T($('dkMicSensVal'), (S.sens > 0 ? '+' : '') + S.sens); T($('dkMicGateVal'), Number(S.gate).toFixed(2));
      T($('dkMicOn'), st.micOn ? 'Stop the microphone' : 'Start the microphone');
      T($('dkMicLine'), st.micOn ? 'The microphone is on.' : st.micFailed ? 'The microphone is not heard (blocked, or none).' : 'The microphone is off.');
      const fh = $('dkFaceHold'); if (document.activeElement !== fh && fh.value !== String(pref.faceHold)) fh.value = String(pref.faceHold);
      const pc = $('placeCard'); HID($('dkPlaceWait'), !(pc && pc.hidden)); T($('dkPlaceWait'), notIn);
      HID($('dkKeysWait'), S.mask && S.v8.on && !vt.KILL.v8); T($('dkKeysWait'), !S.mask ? 'The puppet show keys are the Mask\'s: pick MASK at the top.' : W.v8off);
      const obs = st.srv ? st.srv.obs : '';
      T($('dkObsLine'), obs === 'ok' ? (st.srv.avatar && st.srv.avatar.removed ? 'Linked. The avatar is out of your OBS scenes.' : 'Linked. The avatar is in your OBS scenes.') : obs === 'password' ? 'OBS asks for its Server Password: paste it below.' : obs === 'closed' ? 'OBS is closed.' : obs === 'off' ? 'Not linked to OBS.' : 'Asking OBS ...');
      const cc = $('colourCard'); HID($('dkColWait'), !!cc && !cc.hidden); T($('dkColWait'), !S.mask ? W.mask : notIn);
      const sc = $('signCard'), oc = $('overlayCard');
      HID($('dkSignWait'), !!sc && !sc.hidden); T($('dkSignWait'), !sc ? W.sign : W.mask);
      HID($('dkOverlayWait'), !!oc && !oc.hidden); T($('dkOverlayWait'), !oc ? W.overlay : W.mask);
    });
  }

  // ---------------------------------------------------------------- start
  window.VTDeckHooks = window.VTDeckHooks || {};
  window.VTDeck = {
    setView, view: () => (deckOn() ? 'deck' : 'classic'), openSet, closeSet, showTab, sync,
    moment: () => moment, layout: () => layout, setHeroFace, errors, parked: () => parked.map(([n]) => n.id || 'row'),
  };
  if (pref.view === 'classic') setView('classic'); else setView('deck');
})();
