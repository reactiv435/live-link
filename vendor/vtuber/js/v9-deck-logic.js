// V9 CONTROL DECK: the pure part (no DOM). The deck (js/v9-deck.js) is a second face of the VTuber window: every button
// on it drives the SAME control of the window (the classic layout, kept unchanged behind "Classic controls"), so the
// messages, settings and keys are the window's own. This file holds what the deck and the tests share:
//   momentOf(...)    which zone glows (the zone of the moment)        layoutFor(width)  three zones side by side or stacked
//   TABS             the SETTINGS drawer's tabs                       GLOBAL_KEYS       LIVE Link's keys (shown, never set here)
//   INVENTORY        every row of design-source/v9-deck/CONTROL-INVENTORY.md and where it went on the deck
//   HOOKS            the placeholder hooks for features that are still on their own branches
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VTDeckLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** below this many pixels of window width the three zones stack (the zone of the moment open, the other two folded) */
  const STACK_BELOW = 1000;
  const layoutFor = (width) => (Number(width) > 0 && Number(width) < STACK_BELOW ? 'stack' : 'wide');

  /**
   * the zone of the moment: FIGHT while a boss fight runs, PRE-SHOW while the countdown card is up, a transform runs, or
   * after the zero while his real face shows (the transform is next, even with a song or the countdown music playing),
   * ON AIR while a song plays. '' = none of these (nothing glows).
   * `v8` = the avatar page's puppet-show answer (or null), `show` = its show-opening answer (or null), `on` = avatar ON.
   */
  function momentOf({ on, v8, show } = {}) {
    if (!on) return '';
    if (v8 && v8.fight) return 'fight';
    // the countdown runs / a transform is under way / the countdown hit zero and his real face shows (Transform is next)
    if (show && (show.state === 'card' || show.running || show.queued || show.state === 'real')) return 'pre';
    if (v8 && v8.song) return 'air';
    return '';
  }
  /** in the stacked layout the zone of the moment is open; with no moment ON AIR is (it holds the most-used controls) */
  const openZoneFor = (moment) => moment || 'air';

  /**
   * the stacked layout's folding. A zone he opens (or closes) by hand stays so for as long as that moment lasts; it goes
   * back to the default only once the moment has really moved on, i.e. a new moment held MOMENT_HOLD_MS (a flicker of
   * the song or of the avatar page's answer is not a new moment). The default: the zone of the moment is open (it glows),
   * with no moment ON AIR is open, the rest are folded to their main buttons.
   *   const f = foldNew();  foldTick(f, moment, nowMs) on every sync;  foldToggle(f, zone, isOpenNow) on a header click;
   *   zoneOpen(f, zone) = is it open now
   */
  const MOMENT_HOLD_MS = 1500;
  const foldNew = () => ({ raw: null, since: 0, stable: null, hand: {} });
  function foldTick(f, moment, t) {
    const m = moment || '';
    if (m !== f.raw) { f.raw = m; f.since = t; }
    if (f.raw !== f.stable && (f.stable === null || t - f.since >= MOMENT_HOLD_MS)) {
      f.stable = f.raw;
      for (const id of Object.keys(f.hand)) if (f.hand[id].at !== f.stable) delete f.hand[id];
    }
    return f;
  }
  function foldToggle(f, zone, isOpen) { f.hand[zone] = { open: !isOpen, at: f.raw || '' }; return f; }
  function zoneOpen(f, zone) { const h = f.hand[zone]; return h ? h.open : !f.raw && zone === openZoneFor(f.raw); }

  /**
   * the alert (the window's own sentence while it needs him): shown once it has been wanted ALERT_SHOW_MS without a
   * break, hidden once it has not been wanted ALERT_HIDE_MS, so a 200 ms 'wait' never flashes it on and off under
   * his cursor.   const a = alertNew();  alertTick(a, wanted, nowMs).on
   */
  const ALERT_SHOW_MS = 1000, ALERT_HIDE_MS = 3000;
  const alertNew = () => ({ on: false, want: false, since: 0 });
  function alertTick(a, want, t) {
    const w = !!want;
    if (w !== a.want) { a.want = w; a.since = t; }
    if (w !== a.on && t - a.since >= (w ? ALERT_SHOW_MS : ALERT_HIDE_MS)) a.on = w;
    return a;
  }

  /** m:ss */
  function clock(sec) { const s = Math.max(0, Math.round(Number(sec) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  const TABS = Object.freeze([
    ['mic', 'Microphone'], ['tracking', 'Tracking'], ['framing', 'Framing'], ['keys', 'Keys'], ['obs', 'OBS link'],
    ['colours', 'Colours'], ['sign', 'Show sign'], ['overlay', 'Live overlay (URL)'], ['gifts', 'Gifts'], ['try', 'Try the effects'],
  ]);

  /** LIVE Link's global keys (they work from any window). Shown on the deck; changed in LIVE Link, never here.
   *  sign = the show sign's show / hide (ruling R28: Ctrl+Alt+0, Stream Deck F22; 9 is the galaxy's). The live overlay
   *  (URL) has no standard LIVE Link key (its button and H; he can assign one in LIVE Link). */
  const GLOBAL_KEYS = Object.freeze({ goo: 'Ctrl+Alt+1', fire: 'Ctrl+Alt+2', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', eatIt: 'Ctrl+Alt+8', galaxy: 'Ctrl+Alt+9', sign: 'Ctrl+Alt+0' });

  /** the fight's attacks (V9 boss): tap = one press, hold = charge while held, fire on letting go */
  const ATTACKS = Object.freeze([
    { name: 'mouth', label: 'Mouth missiles', kind: 'tap' }, { name: 'hyper', label: 'Hyper beam', kind: 'hold', sub: 'hold to charge, let go to fire' },
    { name: 'swat', label: 'Swat', kind: 'tap' }, { name: 'blast', label: 'Palm blast', kind: 'tap' }, { name: 'laser', label: 'Face laser', kind: 'tap', wide: true },
  ]);

  /** the transform picker as the deck draws it until the transforms branch gives its own list (HOOKS.transform) */
  const TRANSFORMS = Object.freeze([
    { id: 'scan', label: 'Scan line' }, { id: 'embers', label: 'Embers' }, { id: 'shatter', label: 'Shatter', isNew: true }, { id: 'portal', label: 'Portal', isNew: true },
  ]);

  /**
   * PLACEHOLDER HOOKS: features whose code is on a branch that is not merged into this one yet. The deck draws their
   * control greyed with the reason below until the hook is there at runtime; nothing is sent meanwhile.
   *   window.VTDeckHooks.transform = { list: [{ id, label }], get(): id, set(id) }        (v9-transforms: the picker setting)
   *   window.VTDeckHooks.galaxy    = { press() }      (v9-galaxy: the window-side call; LIVE Link sends control tap 'galaxy')
   *   window.VTDeckHooks.handFx    = { get(): bool, set(on) }    (v9-hands: Particle Play is not wired into the show yet)
   * The deck also follows these by themselves once merged (no hook needed): the boss attacks (VTShow.HAND_MOVES and the
   * keys swat / blast / laser / mouth / hyper in L.V8_ACTIONS), #v8FightSong / #v8HandMoves, countdown music (#showMusic,
   * #showVol, #showMusicFade), the show sign and the live overlay (URL) (#signOn, #signShow, #overlayOn, #overlayShow,
   * #signCard, #overlayCard: ruling R31, the sign branch's URL frame is 'overlay'; 'hype' is only the Aura to Nebula
   * meter), new Mask styles (L.maskStylesOffered()), new backgrounds (L.MASK_BACKGROUNDS / the Mask's own list), new
   * votes (VTShow.VOTES), a countdown "tap" test (a 'tap' kind in the window's Try buttons).
   */
  const HOOKS = Object.freeze({
    transform: 'Shatter and Portal come with the transforms update. Scan line is the one that runs today.',
    galaxy: 'Galaxy Hands comes with the galaxy update (LIVE Link Ctrl+Alt+9 then calls it up).',
    handFx: 'Hand effect (catch and throw particles) is not in the show yet.',
  });
  /** why a control of a feature that is not in this build is greyed (one line, plain words) */
  const WAITS = Object.freeze({
    boss: 'The attacks come with the boss-fight update.',
    cdMusic: 'Countdown music comes with the countdown-music update.',
    sign: 'The show sign comes with the show-sign update.',
    overlay: 'The live overlay (URL) comes with the show-sign update.',
    smartcam: 'Not in this build.',
    mask: 'This is the Mask\'s: pick MASK at the top.',
    v8off: 'The Puppet show switch is off.',
    camMode: 'Camera mode is on: the countdown and the transform need the Mask.',
  });

  // INVENTORY: every row of CONTROL-INVENTORY.md (110), where it sits on the deck and what it drives in the window.
  //   place: TOP | PRE | AIR | FIGHT | LOOKS | STATUS | SET:<tab>
  //   deck:  the deck's element (a CSS selector)
  //   via:   '#id ...'   the window's own control (the deck presses it: the same handler, message, setting, key)
  //          'moved #id' the window's own control itself, moved into the SETTINGS drawer while the deck shows
  //          'fn:name'   the window's own function (window.__vt.name)
  //          'hook:name' a placeholder hook (HOOKS)
  //          'read:...'  read only (what the window or the avatar page reports)
  //          'deck'      new on the deck (no control of the window does it)
  //   needs: the branch that brings the window's control, when it is not in this build (the deck greys / hides it then)
  const R = (n, place, deck, via, needs) => ({ n, place, deck, via, needs: needs || '' });
  const INVENTORY = Object.freeze([
    R(1, 'TOP', '#dkPower', '#power'),
    R(2, 'TOP', '#dkChars [data-c="ryo"]', '#heroes [data-id="ryo"]'),
    R(3, 'TOP', '#dkChars [data-c="melanie"]', '#heroes [data-id="melanie"]'),
    R(4, 'TOP', '#dkChars [data-c="mask"]', '#heroes [data-id="mask"]'),
    R(5, 'TOP', '#dkGear', 'deck'),
    R(6, 'PRE', '#dkMin', '#showMin'),
    R(7, 'PRE', '#dkCdStart', '#showStart'),
    R(8, 'PRE', '#dkCdRead', 'read:show'),
    R(9, 'PRE', '#dkCdMusic', '#showMusic', 'v9-countdown'),
    R(10, 'PRE', '#dkCdVol', '#showVol', 'v9-countdown'),
    R(11, 'PRE', '#dkCdFade', '#showMusicFade', 'v9-countdown'),
    R(12, 'PRE', '#dkTransform', '#showFire'),
    R(13, 'PRE', '#dkTfPick', '#faceTfs [data-tf] (else hook:transform)', 'v9-transforms'),
    R(14, 'PRE', '#dkCamMode', '#camMode'),
    R(15, 'PRE', '#dkSmartCam', '#smartCam'),
    R(16, 'PRE', '#dkSignOn', '#signOn', 'v9-sign'),
    R(17, 'PRE', '#dkSignHide', '#signShow', 'v9-sign'),
    R(18, 'PRE', '#dkOverlayOn', '#overlayOn', 'v9-sign'),
    R(19, 'PRE', '#dkOverlayHide', '#overlayShow', 'v9-sign'),
    R(20, 'AIR', '#dkEat', '#v8Eat'),
    R(21, 'AIR', '#dkEatLine', 'read:#v8EatLine'),
    R(22, 'AIR', '#dkViz', '#mode'),
    R(23, 'AIR', '#dkVizPick [data-viz]', '#maskVizs [data-viz]'),
    R(24, 'AIR', '#dkVote', '#v8Vote'),
    R(25, 'AIR', '#dkVoteWhich', '#v8VoteWhich'),
    R(26, 'AIR', '#dkVoteWhich', '#v8VoteWhich', 'the 7 new votes: the list follows VTShow.VOTES'),
    R(27, 'AIR', '#dkOwnQ', '#v8OwnQ'),
    R(28, 'AIR', '#dkVoteRand', '#v8Rand'),
    R(29, 'AIR', '#dkMoves [data-move="goo"]', 'fn:v8Down'),
    R(30, 'AIR', '#dkMoves [data-move="fire"]', 'fn:v8Down'),
    R(31, 'AIR', '#dkMoves [data-move="melt"]', 'fn:v8Down'),
    R(32, 'AIR', '#dkMoves [data-move="crack"]', 'fn:v8Down'),
    R(33, 'AIR', '#dkMoves [data-move="eat"]', 'fn:v8Down'),
    R(34, 'AIR', '#dkGalaxy', 'hook:galaxy', 'v9-galaxy'),
    R(35, 'AIR', '#dkGalaxy small', 'read:hint'),
    R(36, 'AIR', '#dkV8On', '#v8On'),
    R(37, 'AIR', '#dkV8Chat', '#v8Chat'),
    R(38, 'AIR', '#dkV8Hands', '#v8Hands'),
    R(39, 'AIR', '#dkV8Orbit', '#v8Orbit'),
    R(40, 'AIR', '#dkHandFx', 'hook:handFx', 'v9-hands'),
    R(41, 'AIR', '#dkShuffle', '#shuffle'),
    R(42, 'AIR', '#dkShuffleAmt [data-amount]', '#shuffleAmt [data-amount]'),
    R(43, 'AIR', '#dkHypeLook [data-style]', '#hypeStyles [data-style]'),
    R(44, 'FIGHT', '#dkFight', '#v8Fight'),
    R(45, 'FIGHT', '#dkFightWhy', 'read:#v8FightWhy'),
    R(46, 'FIGHT', '#dkAtk [data-atk="mouth"]', 'fn:v8Cmd', 'v9-boss'),
    R(47, 'FIGHT', '#dkAtk [data-atk="hyper"]', 'fn:v8Cmd', 'v9-boss'),
    R(48, 'FIGHT', '#dkAtk [data-atk="swat"]', 'fn:v8Cmd', 'v9-boss'),
    R(49, 'FIGHT', '#dkAtk [data-atk="blast"]', 'fn:v8Cmd', 'v9-boss'),
    R(50, 'FIGHT', '#dkAtk [data-atk="laser"]', 'fn:v8Cmd', 'v9-boss'),
    R(51, 'FIGHT', '#dkFightSong', '#v8FightSong', 'v9-boss'),
    R(52, 'FIGHT', '#dkHandMoves', '#v8HandMoves', 'v9-boss'),
    R(53, 'FIGHT', '#dkBarsPick [data-bars]', '#v8Bars [data-bars]'),
    R(54, 'FIGHT', '#dkBarsY', '#v8BarsY'),
    R(55, 'FIGHT', '#dkBars', 'read:fight'),
    R(56, 'LOOKS', '#dkMon', 'read:#pv'),
    R(57, 'LOOKS', '#dkFaces [data-style="classic"]', '#maskStyles [data-style="classic"]'),
    R(58, 'LOOKS', '#dkFaces [data-style="core"]', '#maskStyles [data-style="core"]'),
    R(59, 'LOOKS', '#dkFaces [data-style="quantum"]', '#maskStyles [data-style="quantum"]'),
    R(60, 'LOOKS', '#dkFaces [data-style="matrix"]', '#maskStyles [data-style="matrix"]', 'v9-matrix'),
    R(61, 'LOOKS', '#dkFaces [data-style="ethereal"]', '#maskStyles [data-style="ethereal"]', 'v9-ethereal'),
    R(62, 'LOOKS', '#dkFaces [data-face]', 'fn:setHeroFace'),
    R(63, 'LOOKS', '#dkBgs [data-bg]', '#maskBgs [data-bg]'),
    R(64, 'LOOKS', '#dkBgs [data-bg]', '#maskBgs [data-bg]', 'v9-backgrounds: the list follows L.MASK_BACKGROUNDS'),
    R(65, 'LOOKS', '#dkBgs [data-bg]', '#bgs [data-bg]'),
    R(66, 'LOOKS', '#dkCols [data-hex]', '#swatches [data-hex]'),
    R(67, 'LOOKS', '#dkCols .more', 'deck'),
    R(68, 'SET:colours', '#colourMusic', 'moved #colourMusic'),
    R(69, 'STATUS', '#dkStLink', 'read:link'),
    R(70, 'STATUS', '#dkStSong', 'read:song'),
    R(71, 'STATUS', '#dkStEat', 'read:#v8EatLine'),
    R(72, 'STATUS', '#dkStTrack', 'read:tracker'),
    R(73, 'STATUS', '#dkStFps', 'read:fps'),
    R(74, 'STATUS', '#dkStMic', 'read:mic'),
    R(75, 'STATUS', '#dkStMusic', 'read:#sound'),
    R(76, 'STATUS', '#dkStObs', 'read:obs'),
    R(77, 'STATUS', '#dkStTick', 'read:#v8Note'),
    R(78, 'SET:mic', '#micDevice', 'moved #micDevice'),
    R(79, 'SET:mic', '#dkMicSens', 'fn:settings'),
    R(80, 'SET:tracking', '#cams', 'moved #cams'),
    R(81, 'SET:tracking', '#face', 'moved #face'),
    R(82, 'SET:tracking', '#eyes', 'moved #eyes'),
    R(83, 'SET:tracking', '#mirror', 'moved #mirror'),
    R(84, 'SET:tracking', '#v8Swap', 'moved #v8Swap'),
    R(85, 'SET:tracking', '#hands', 'moved #hands'),
    R(86, 'SET:tracking', '#dkFaceHold', 'deck'),
    R(87, 'SET:framing', '#stage', 'moved #stage'),
    R(88, 'SET:framing', '#zoom', 'moved #zoom'),
    R(89, 'SET:framing', '#offx', 'moved #offx'),
    R(90, 'SET:framing', '#offy', 'moved #offy'),
    R(91, 'SET:framing', '#placeReset', 'moved #placeReset'),
    R(92, 'SET:framing', '#camAlignRow', 'moved #camAlignRow'),
    R(93, 'SET:keys', '#v8Keys', 'moved #v8Keys'),
    R(94, 'SET:keys', '#v8KeysReset', 'moved #v8KeysReset'),
    R(95, 'SET:keys', '#dkGlobalKeys', 'deck'),
    R(96, 'SET:obs', '#pwbox', 'moved #pwbox'),
    R(97, 'SET:obs', '#remove', 'moved #remove'),
    R(98, 'SET:colours', '#wheel', 'moved #wheel'),
    R(99, 'SET:sign', '#signCard', 'moved #signCard', 'v9-sign'),
    R(100, 'SET:sign', '#signCard', 'moved #signCard', 'v9-sign'),
    R(101, 'SET:sign', '#signCard', 'moved #signCard', 'v9-sign'),
    R(102, 'SET:sign', '#signCard', 'moved #signCard', 'v9-sign'),
    R(103, 'SET:sign', '#signCard', 'moved #signCard', 'v9-sign'),
    R(104, 'SET:overlay', '#overlayCard', 'moved #overlayCard', 'v9-sign'),
    R(105, 'SET:overlay', '#overlayCard', 'moved #overlayCard', 'v9-sign'),
    R(106, 'SET:overlay', '#overlayCard', 'moved #overlayCard', 'v9-sign'),
    R(107, 'SET:gifts', '#giftSounds', 'moved #giftSounds'),
    R(108, 'SET:gifts', '#gifts', 'moved #gifts'),
    R(109, 'SET:try', '#tries', 'moved #tries'),
    R(110, 'SET:try', '#tries', 'moved #tries', 'v9-countdown: a "tap" kind in the Try buttons'),
  ]);

  /** the classic nodes the SETTINGS drawer shows while the deck is up, by tab (moved back when Classic controls opens) */
  const MOVED = Object.freeze({
    mic: ['micDevice'],
    tracking: ['cams', 'camHint', 'face', 'faceText', 'faceBarWrap', 'eyes', 'eyesHint', 'mirror', 'v8Swap', 'v8SwapHint', 'hands'],
    framing: ['placeCard', 'camAlign'],
    keys: ['v8Keys', 'v8KeysHint', 'v8KeysReset'],
    obs: ['pwbox', 'remove', 'removeHint'],
    colours: ['colourCard'],
    sign: ['signCard'],
    overlay: ['overlayCard'],
    gifts: ['giftSounds', 'giftsHint', 'gifts', 'giftAdd', 'giftsNote'],
    try: ['tries', 'tryHint'],
  });

  /** a hero face from a window key while Ryo or Melanie is picked: Q W E R T Y = the six faces, 0 = Auto; '' = not a face key */
  function heroFaceForKey(code, faces) {
    if (code === 'Digit0' || code === 'Numpad0') return 'auto';
    const m = /^Key([QWERTY])$/.exec(String(code || ''));
    if (!m || !Array.isArray(faces)) return '';
    return faces['QWERTY'.indexOf(m[1])] || '';
  }
  const HERO_FACE_HOLDS = Object.freeze([[0, 'until I change it'], [3000, '3 s'], [5000, '5 s'], [10000, '10 s']]);

  return { STACK_BELOW, layoutFor, momentOf, openZoneFor, MOMENT_HOLD_MS, foldNew, foldTick, foldToggle, zoneOpen, ALERT_SHOW_MS, ALERT_HIDE_MS, alertNew, alertTick, clock, TABS, GLOBAL_KEYS, ATTACKS, TRANSFORMS, HOOKS, WAITS, INVENTORY, MOVED, heroFaceForKey, HERO_FACE_HOLDS };
});
