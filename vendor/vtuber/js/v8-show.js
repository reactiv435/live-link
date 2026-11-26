// V8 phase 2, THE SHOW DIRECTOR (V8-PHASE2.md section A): everything that decides WHAT the puppet show does, live.
// Pure logic (UMD, no DOM, no network, no timers, no clock of its own: every call takes the time in seconds, the Mask's
// own clock). It runs in the avatar page (js/mask-page.js), next to the Mask, because that is where the tracker's raw
// face results arrive and where every frame is drawn. The control page only sends it settings and commands.
//
//   const show = VTShow.create({ mask, engines: { VTBoss, VTFaceTriggers, VTVotes, VTHandPuppets }, bsNames, seed, pictureOf });
//   show.settings({ on, chat, hands, rand })     the switches on the Mask card ("Puppet show", "Chat can trigger moves", ...)
//   show.cmd({ action, name, ... }, t)           a button / a key: 'down' 'up' 'tap' (a move), 'fight', 'stop', 'vote', 'vote-stop',
//                                                'eat' (EAT IT: works with the Puppet show switched off)
//   show.setShow(s, t)                           LIVE Link's show state (C3): song on air, cover, hype rank, his verdict, the song's finish
//   show.ear(level, src, t)                      without LIVE Link: the Mask's own ear (is music playing in the PC sound?)
//   show.event(ev, t) -> { v4 }                  a viewer event (C1, cleaned): taps, gifts, comments. v4 = also play the V4 effect
//   show.face(f, t); show.mic(level, t)          a tracker frame ({ bs, mat, lm } or null) and the mic level: his face fights
//   show.hands(list, o, t)                       the hand model's result (0..2 hands) for the angel / devil puppets
//   show.step(t) -> status                       once per drawn frame: runs the engines, feeds the Mask, returns what the
//                                                control page shows (cooldowns, the fight, the vote, why a button is grey)
//   show.takeActs() -> [{ do, ... }]             what only the PAGE can do: load a cover ('cover' = the colour only, 'eat' = the Mask
//                                                eats it), a size / colour for a while ('over')
// RELEASE A, ALBUM EATING: a song going on air only gives the Mask its cover's colour. The cover is EATEN when the host
// finishes the song on his site (LIVE Link's `finish`: DONE or ADD TO AI RADIO, once per song) or presses EAT IT. The
// Mask then chews and waits up to 20 s for his verdict (`grade`), which it spits as a word (mask.verdict); no verdict,
// or the next song going on air = a gulp (mask.gulp), never a word. None of this needs the Puppet show switch.
// `mask` is mask/mask-live.js's object (or a stand-in with the same V8 calls in tests).
// TikTok LIVE rules live here too: a comment that is eaten is cleaned first (no links, no @mentions, a word filter,
// 26 characters), and nothing this file puts on screen asks for gifts (a test reads every string).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTShow = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const MOVES = ['goo', 'fire', 'melt', 'crack', 'eat'];
  const MOVE_LABEL = { goo: 'Goo', fire: 'Fire head', melt: 'Melt', crack: 'Crack open', eat: 'Eat a comment' };
  // what the Mask itself allows (mask/mask-v8.js MOVES): the seconds a move cools down, and how long a tap lasts
  const COOL = { goo: 5, fire: 5, melt: 9, crack: 9, eat: 4 }, TAP_LEN = { goo: 3, fire: 4.5 }, HOLD_MAX = 12;

  // ---------------------------------------------------------------- chat
  // CHAT WORDS: the whole comment is the word ("goo", "!fire", "MELT!"): a sentence that only contains it does nothing.
  const CHAT_WORDS = { goo: 'goo', slime: 'goo', fire: 'fire', flames: 'fire', melt: 'melt', crack: 'crack', eat: 'eat', chomp: 'eat' };
  const LIMITS = { room: 12, viewer: 60, gift: 3, eatKeep: 45 };        // seconds: between two chat moves in the room; per viewer; between two gift moves; how long a comment may wait to be eaten
  const normWord = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().trim().replace(/^[!#]+/, '').replace(/[.!?]+$/, '').trim();
  /** which move a comment asks for, or null */
  const chatWord = (text) => { const w = normWord(text); return Object.prototype.hasOwnProperty.call(CHAT_WORDS, w) ? CHAT_WORDS[w] : null; };
  // GIFTS BY SIZE (coins each): the Mask reacts a moment after the V4 gift effect has landed
  const giftMove = (coins, flip) => (coins >= 200 ? { move: 'melt', flare: true, delay: 2.4 } : coins >= 20 ? { move: 'crack', delay: 1.6 } : { move: flip ? 'fire' : 'goo', delay: 1.0 });

  // A COMMENT THE MASK MAY EAT (it is shown as glowing text): no links, no @mentions, no phone-like numbers, no words
  // from the filter, printable characters only, at most 26. null = this one is not shown.
  const BAD_WORDS = /(?:^|[^a-z])(?:f+u+c+k|sh[i1]+t|b[i1]tch|c[u\*]nt|n[i1]gg|f[a@]gg?|r[e3]tard|wh[o0]re|sl[u\*]t|d[i1]ck|c[o0]ck|pu+ss+y|r[a@]pe|k[i1]ll\s*(?:your|ur)\s*self|kys|n[a@]zi|h[i1]tler|porn|sex|onlyfans|c[u\*]m)/i;
  const BAD_CORE = /(?:f+u+c+k|sh[i1]+t|b[i1]tch|c[u\*]nt|n[i1]gg|f[a@]gg?|r[e3]tard|wh[o0]re|sl[u\*]t|d[i1]ck|c[o0]ck|pu+ss+y|r[a@]pe|k[i1]ll\s*(?:your|ur)\s*self|kys|n[a@]zi|h[i1]tler|porn|sex|onlyfans|c[u\*]m)/i;      // (the same words with the letters squeezed together: "f u c k")
  const LINK = /(?:https?:|www\.|\b[a-z0-9-]{2,}\.(?:com|net|org|gg|io|co|tv|me|ly|xyz|shop|live|link|app|ru|cn)\b|\b(?:discord|telegram|whatsapp|snap(?:chat)?|insta(?:gram)?|cash\s?app|paypal|venmo)\b)/i;
  function cleanComment(text) {
    if (typeof text !== 'string') return null;
    let s = text.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) return null;
    if (/@/.test(s) || LINK.test(s) || /\d[\d\s().-]{6,}\d/.test(s) || BAD_WORDS.test(s) || BAD_CORE.test(s.replace(/[^a-z]/gi, ''))) return null;
    if (/^[!#]?\d$/.test(s) || chatWord(s)) return null;                 // a vote or a chat word is not a comment to eat
    const out = Array.from(s).slice(0, 26).join('').trim();
    return out.length >= 2 ? out : null;
  }
  /** who a viewer is: a stable id, the name to show (the @handle when there is one), the picture's address */
  function viewerOf(ev) {
    const handle = typeof ev.handle === 'string' ? ev.handle.replace(/[^A-Za-z0-9._]/g, '').slice(0, 24) : '';
    let name = handle || String(ev.name || '').normalize('NFKC').replace(/[^\p{L}\p{N}._ -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name || BAD_WORDS.test(name) || LINK.test(name)) name = 'viewer';
    const id = ev.uid ? 'u' + ev.uid : handle ? 'h' + handle.toLowerCase() : 'n' + name.toLowerCase();
    return { id, name, url: typeof ev.avatar === 'string' ? ev.avatar : null };
  }
  // THE CROWD (LIVE Link, event v2): a like with no handle and no uid is not one viewer: it is the taps of a big room that
  // waited 3 s. Its taps count and fly, with the placeholder picture; it is never in the top 3 and never named.
  const CROWD = 'crowd';
  const isCrowd = (ev) => ev.type === 'like' && !ev.handle && !ev.uid;      // (also a v1 like, which has neither field: one display name must not collect a whole room's taps)

  // ---------------------------------------------------------------- album eating (release A)
  // wait: seconds the Mask chews and waits for his verdict; again: between two EAT IT presses; keep: how long a song that
  // went off air uneaten can still be eaten by EAT IT; show: how long a spat word is the Mask's business
  const EAT_TEXT = {
    notLinked: 'LIVE Link is not sending the show, so DONE and ADD TO AI RADIO cannot reach the Mask. EAT IT eats a record.',
    waiting: 'Waiting for a song. The one on air is eaten at DONE or ADD TO AI RADIO.',
    ready: 'EAT READY: {song} is eaten at DONE or ADD TO AI RADIO.',
    noCover: '{song} has no cover the Mask can load: it eats a glowing record at DONE or ADD TO AI RADIO.',
    eaten: '{song} is eaten. EAT IT eats it again.',
    chewing: 'Chewing. It spits your verdict when you give it; in {n} s it swallows.',
    spat: 'It spat your verdict: {word}.',
    fight: 'A boss fight is on. EAT IT works when it is over.',
  };
  const EAT = { wait: 20, again: 3, keep: 90, show: 7, replay: 600, text: EAT_TEXT };      // replay: the same song on air again this long after its eat can be eaten again
  const idOf = (song) => (song ? song.id || song.title || 'song' : null);

  // ---------------------------------------------------------------- votes he can call
  // Colours: warm only (the house look), plus Hot Pink by name. Every `action` is applied by this file.
  const VOTES = [
    { id: 'boss', title: 'Boss fight?', question: 'Fight the Mask in a boss battle?', options: [{ label: 'Fight', words: ['yes', 'fight', 'boss'], action: 'boss' }, { label: 'Mercy', words: ['no', 'mercy'], action: null }], seconds: 30, needsNoSong: true },
    { id: 'size', title: 'Shrink or HUGE', question: 'What do we do to him?', options: [{ label: 'Shrink him to an inch', words: ['shrink', 'small', 'tiny'], action: 'shrink' }, { label: 'Make him HUGE', words: ['huge', 'big', 'giant'], action: 'huge' }, { label: 'Leave him', words: ['leave', 'nothing'], action: null }], seconds: 30 },
    { id: 'colour', title: 'His colour', question: 'What colour should he be?', options: [{ label: 'Hot Pink', words: ['pink', 'hot pink'], action: { colour: '#ff2d95' } }, { label: 'Gold', words: ['gold', 'yellow'], action: { colour: '#ffb224' } }, { label: 'Ember', words: ['ember', 'orange'], action: { colour: '#ff5a1f' } }, { label: 'Crimson', words: ['crimson', 'red'], action: { colour: '#e01f3d' } }], seconds: 30 },
    { id: 'power', title: 'Which move next', question: 'Which move next?', options: [{ label: 'Goo', action: { puppet: 'goo' } }, { label: 'Fire', action: { puppet: 'fire' } }, { label: 'Melt', action: { puppet: 'melt' } }, { label: 'Crack', action: { puppet: 'crack' } }], seconds: 25 },
  ];
  const OVER = { shrink: { zoom: 0.2, secs: 20 }, huge: { zoom: 1.7, secs: 20 }, colour: { secs: 60 } };
  /** a question he typed himself: two to four plain answers, no action (a poll only) */
  function customVote(question, options) {
    const tidy = (s, n) => String(s == null ? '' : s).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
    const fine = (s) => !!s && !/@/.test(s) && !LINK.test(s) && !BAD_WORDS.test(s);
    const q = tidy(question, 60);
    const opts = (Array.isArray(options) ? options : String(options || '').split(/[,/|]/)).map((o) => tidy(o, 22)).filter(fine).slice(0, 4);
    if (!fine(q) || q.length < 3 || opts.length < 2) return null;
    return { id: 'custom', question: q, options: opts.map((label) => ({ label, action: null })), seconds: 30 };
  }

  // ---------------------------------------------------------------- is a song playing? (without LIVE Link)
  // The Mask already hears what the PC plays. Music = that sound above a low level for 3 s; no music = under it for 4 s.
  // His own voice never counts (it is the microphone, not the PC's sound), and the Mask's own bangs are held back by
  // the page before they get here.
  function createEar({ level = 0.12, on = 3, off = 4, stale = 3 } = {}) {
    let playing = false, loud = null, quiet = null, last = -1e9, src = '';
    return {
      push(v, s, t) {
        last = t; src = s;
        if (s !== 'pc' && s !== 'obs') { playing = false; loud = quiet = null; return; }
        if (v >= level) { quiet = null; if (loud === null) loud = t; if (t - loud >= on) playing = true; }
        else { if (quiet === null) quiet = t; if (t - quiet >= off) { playing = false; loud = null; } else if (!playing && t - quiet > 0.6) loud = null; }
      },
      /** true / false, or null when the Mask hears no PC sound at all (it cannot tell) */
      playing: (t) => (t - last > stale || (src !== 'pc' && src !== 'obs') ? null : playing),
    };
  }

  // ---------------------------------------------------------------- the director
  function create({ mask, engines = {}, bsNames = [], seed = 20261120, pictureOf = null, bossParams = null, voteSeconds = 0 } = {}) {
    const E = engines;
    const boss = E.VTBoss ? E.VTBoss.create({ seed, params: bossParams || undefined }) : null;
    const trig = E.VTFaceTriggers ? E.VTFaceTriggers.create({ bsNames }) : null;
    const votes = E.VTVotes ? E.VTVotes.create({ seed }) : null;
    const sched = E.VTVotes ? E.VTVotes.scheduler({ every: 240, first: 90 }) : null;
    const puppets = E.VTHandPuppets ? E.VTHandPuppets.create({ sourceMirrored: false }) : null;
    const ear = createEar();
    const S = {
      cfg: { on: true, chat: true, hands: false, rand: false, swap: false, orbit: true },
      show: null, showAt: -1e9, songId: null, scoreKey: '', hypeRank: -1, mythic: 0, songOn: false, songSrc: 'none',
      a: null, fired: { shock: false, scream: false }, mic: null, micAt: -1e9, faceAt: -1e9,
      handsIn: null, handsAt: -1e9, handsStepAt: -1e9, p: null, aspect: 0.5625, nose: null,
      move: {}, queue: [], acts: [], comments: [], lastChatAt: -1e9, lastGiftAt: -1e9, perViewer: new Map(), giftFlip: false,
      bs: null, vs: null, voteDef: null, note: '', noteAt: -1e9, t: 0, lastFight: null, counts: { chatMoves: 0, giftMoves: 0, votes: 0, taps: 0, trig: {} },
      viewers: new Map(),
      // album eating: the songs seen on air (id -> { title, cover }), the ids already eaten, the eat in progress
      songs: new Map(), eaten: new Map(), owed: new Map(), finSeen: [], eat: null, eatAt: -1e9, showN: 0, lastId: null, offAt: -1e9,
    };
    for (const m of MOVES) S.move[m] = { held: false, until: 0, coolAt: -1e9 };
    const note = (text, t) => { S.note = text; S.noteAt = t; };
    const fightOn = () => !!(boss && (boss.phase === 'intro' || boss.phase === 'fight'));
    const busyFight = () => !!(boss && boss.phase !== 'idle');
    /** one object per viewer for the whole show (the engines keep it; the page hangs the loaded picture on it) */
    function viewer(ev) {
      if (isCrowd(ev)) return S.crowd || (S.crowd = { id: CROWD, name: 'the raid', avatar: null });
      const v = viewerOf(ev); let o = S.viewers.get(v.id);
      if (!o) { o = { id: v.id, name: v.name, avatar: null }; S.viewers.set(v.id, o); if (S.viewers.size > 600) S.viewers.delete(S.viewers.keys().next().value); }
      else { S.viewers.delete(v.id); S.viewers.set(v.id, o); o.name = v.name; }
      if (pictureOf && (v.url || !o.avatar)) { try { const pic = pictureOf(o, v.url); if (pic) o.avatar = pic; } catch (e) { /* the placeholder */ } }
      return o;
    }

    // ---- is a song on air: LIVE Link's word when it is fresh (it sends at least every 5 s), else the Mask's own ear
    function songNow(t) {
      if (S.show && t - S.showAt < 15) { S.songSrc = 'link'; return !!S.show.onAir; }
      const e = ear.playing(t);
      S.songSrc = e === null ? 'none' : 'ear';
      return e === true;
    }

    // ---- the moves
    const maskState = (name) => { try { const st = mask.v8 && mask.v8(); return st ? st.state.moves[name] : null; } catch (e) { return null; } };
    /** fire a move now -> true when the Mask took it. In a fight Goo and Fire are attacks on CHAT (the engine's cooldown). */
    function fireMove(name, { hold = false, text = '', t, len = 0 }) {
      if (!MOVES.includes(name) || !S.cfg.on) return false;
      const M = S.move[name];
      if (fightOn()) {
        if (name !== 'fire' && name !== 'goo') return false;
        if (boss.phase !== 'fight' || !boss.special(name, t)) return false;
        mask.puppet(name, {}); M.coolAt = t; return true;
      }
      if (busyFight()) return false;                                     // the ending is playing
      const o = { hold: hold || !!len };
      if (name === 'eat') o.text = text || nextComment(t) || 'nom nom nom';
      if (!mask.puppet(name, o)) return false;
      M.held = !!hold; M.until = len ? t + len : 0; M.startAt = t;
      return true;
    }
    function releaseMove(name, t) { const M = S.move[name]; if (!M) return; if (M.held || M.until) { M.held = false; M.until = 0; mask.release(name); } void t; }
    function nextComment(t) {
      while (S.comments.length && t - S.comments[0].t > LIMITS.eatKeep) S.comments.shift();
      const c = S.comments.pop(); return c ? c.text : '';
    }

    // ---- commands from the buttons, the page's keys and LIVE Link's global keys
    function cmd(c, t) {
      if (!c || typeof c !== 'object') return false;
      if (c.action === 'eat') { S.t = t; return eatNow(t); }             // EAT IT: not a puppet move, so it does not need the Puppet show switch
      if (!S.cfg.on) return false;
      S.t = t;
      const name = MOVES.includes(c.name) ? c.name : '';
      if (c.action === 'down' && name) return fireMove(name, { hold: name === 'goo' || name === 'fire', t });
      if (c.action === 'up' && name) { releaseMove(name, t); return true; }
      if (c.action === 'tap' && name) {
        // a key with no key-up (LIVE Link's global keys): the move's standard length; a second press while it pours makes it longer
        const M = S.move[name];
        if (TAP_LEN[name] && M.until > t && !fightOn()) { M.until = Math.min(M.startAt + HOLD_MAX - 0.5, M.until + TAP_LEN[name]); return true; }
        return fireMove(name, { t, len: fightOn() ? 0 : TAP_LEN[name] || 0 });
      }
      if (c.action === 'fight') return startFight(t, 'button');
      if (c.action === 'stop') { if (boss && boss.stop(t)) { note('Fight called off.', t); return true; } return false; }
      if (c.action === 'vote') return startVote(c.custom ? customVote(c.custom.question, c.custom.options) : VOTES.find((v) => v.id === c.id) || null, t);
      if (c.action === 'vote-stop') { if (votes && votes.active) { votes.cancel(t); return true; } return false; }
      return false;
    }
    function startFight(t, why) {
      if (!boss || !S.cfg.on) return false;
      if (songNow(t)) { note('No boss fight while a song is on air. It can start when the song is over.', t); return false; }
      if (boss.phase !== 'idle') return false;
      if (votes && votes.active) votes.cancel(t);
      for (const m of ['goo', 'fire']) releaseMove(m, t);
      boss.setSongPlaying(false, t);
      const ok = boss.start(t);
      if (ok) { S.lastFight = null; note(why === 'vote' ? 'Chat voted for a boss fight.' : '', t); }
      return ok;
    }
    function startVote(def, t) {
      if (!votes || !S.cfg.on || votes.active || busyFight()) return false;
      if (!def) def = votes.pickRandom(VOTES, { songPlaying: songNow(t), fight: busyFight() });
      if (!def || (def.needsNoSong && songNow(t))) { if (def) note('That vote waits until the song is over.', t); return false; }
      const ok = votes.start({ id: def.id, question: def.question, options: def.options, seconds: voteSeconds || def.seconds || 30 }, t);
      if (ok) { S.voteDef = def; S.counts.votes++; }
      return ok;
    }
    function applyVote(action, label, t) {
      if (action === 'boss') { if (!startFight(t, 'vote')) note('Chat voted for a fight, but a song is on air.', t); }
      else if (action === 'shrink' || action === 'huge') S.acts.push({ do: 'over', zoom: OVER[action].zoom, secs: OVER[action].secs });
      else if (action && typeof action === 'object' && typeof action.colour === 'string') S.acts.push({ do: 'over', colour: action.colour, secs: OVER.colour.secs });
      else if (action && typeof action === 'object' && MOVES.includes(action.puppet)) S.queue.push({ at: t + 1.2, move: action.puppet });
      if (label) note('Chat voted: ' + label + '.', t);
    }

    // ---- LIVE Link's show state
    function setShow(s, t) {
      if (!s || typeof s !== 'object') { S.show = null; return; }
      S.show = s; S.showAt = t;
      // a finish that is already there in the very first state this page sees is not news (the page was loaded again
      // inside the 20 s LIVE Link keeps it): that song is not eaten a second time
      if (++S.showN === 1 && s.finish && s.finish.id) { S.eaten.set(s.finish.id, t); S.finSeen.push(s.finish.id); }
    }
    const freshShow = (t) => (S.show && t - S.showAt < 15 ? S.show : null);
    /** his verdict for THIS song: the word LIVE Link sends with the song it is for (on air or just ended), or the word on that song's finish */
    const gradeFor = (id, s) => (!id || !s ? null : s.grade && s.song && idOf(s.song) === id ? s.grade : s.finish && s.finish.id === id && s.finish.grade ? s.finish.grade : null);
    /** what is known of a song by its id (title, cover): what the message says right now when it has the cover, else what was seen on air. Never another song's. */
    function songOf(id, s) {
      const now = id && s && s.song && idOf(s.song) === id ? s.song : null, kept = (id && S.songs.get(id)) || null;
      return now && now.cover ? { title: now.title || (kept ? kept.title : ''), cover: now.cover } : kept || (now ? { title: now.title || '', cover: null } : null);
    }
    /** the Mask eats now: the page loads the cover and feeds the stage. wait = it then chews until mask.verdict / mask.gulp */
    function startEat(o, t) {
      const wait = !!o.id && !o.grade && !o.noWait;
      if (o.id) { S.eaten.delete(o.id); S.eaten.set(o.id, t); if (S.eaten.size > 60) S.eaten.delete(S.eaten.keys().next().value); S.owed.delete(o.id); }
      S.acts.push({ do: 'eat', id: o.id || null, title: o.title || '', cover: o.cover || null, grade: o.grade || null, why: o.why, wait });
      S.eatAt = t;
      S.eat = wait ? { id: o.id, t0: t, until: t + EAT.wait, said: false, word: '', title: o.title || '' } : o.grade ? { id: o.id, t0: t, until: t + EAT.show, said: true, word: o.grade, title: o.title || '' } : null;
    }
    /** EAT IT (the button, LIVE Link's key): the song on air, else the one that just went off air uneaten, else a record */
    function eatNow(t) {
      if (t - S.eatAt < EAT.again || busyFight()) return false;
      const s = freshShow(t), air = s && s.onAir && s.song ? idOf(s.song) : null;
      const id = air || (S.lastId && t - S.offAt < EAT.keep && !S.eaten.has(S.lastId) ? S.lastId : null), sg = id ? songOf(id, s) : null;
      startEat({ id, title: sg ? sg.title : '', cover: sg ? sg.cover : null, grade: gradeFor(id, s), why: 'button' }, t);
      return true;
    }
    function followShow(t) {
      const s = freshShow(t), on = S.cfg.on;
      // the song: a new one on air = its cover gives the Mask its colour (the page loads the picture; nothing is eaten
      // yet); off air = the Mask's own colours again. Not tied to the Puppet show switch any more.
      const id = s && s.onAir && s.song ? idOf(s.song) : null;
      if (id !== S.songId) {
        if (!id) { S.lastId = S.songId; S.offAt = t; }
        S.songId = id;
        if (id) {
          // (fix round V-4: the same song on air again more than 10 minutes after it was eaten is a replay: it can be eaten again)
          if (S.eaten.has(id) && t - S.eaten.get(id) > EAT.replay) { S.eaten.delete(id); S.owed.delete(id); }
          S.songs.delete(id); S.songs.set(id, { title: s.song.title || '', cover: s.song.cover || null }); if (S.songs.size > 8) S.songs.delete(S.songs.keys().next().value);
          S.acts.push({ do: 'cover', id, title: s.song.title || '', cover: s.song.cover || null });
        } else S.acts.push({ do: 'songOff' });
      } else if (id) {
        // (fix round V-1: LIVE Link's first message for a song may have no cover and no title yet; they follow on a later
        // message for the SAME id. What is learned is kept, and the page is told again.)
        const k = S.songs.get(id), cv = s.song.cover || null, ti = s.song.title || '';
        if (k && ((cv && cv !== k.cover) || (ti && ti !== k.title))) { k.cover = cv || k.cover; k.title = ti || k.title; S.acts.push({ do: 'cover', id, title: k.title, cover: k.cover }); }
      }
      // THE EAT: the host finished the song on his site (DONE = 'played', ADD TO AI RADIO = 'radio'). Once per song:
      // both buttons, or EAT IT before them, are one eat. A song cleared without either is not eaten.
      const f = s && s.finish && s.finish.id ? s.finish : null, firstFin = !!(f && !S.finSeen.includes(f.id));
      if (firstFin) { S.finSeen.push(f.id); if (S.finSeen.length > 60) S.finSeen.shift(); }
      if (f && !S.eaten.has(f.id)) {
        const sg = songOf(f.id, s), next = !!(id && id !== f.id), g = gradeFor(f.id, s);
        // next = another song is already on air. The verdict he gave THIS song before DONE comes with its finish and is
        // spat with its title (V-3: the climax of its review); with no verdict yet: the bite, a gulp, and no word later.
        startEat({ id: f.id, title: sg ? sg.title : '', cover: sg ? sg.cover : null, grade: g, why: f.kind, noWait: next && !g }, t);
      }
      // ... and what comes out: his verdict as a word when it lands inside the wait; the next song or no verdict = a gulp.
      // A word that is already out stays for its few seconds.
      const e = S.eat;
      if (e) {
        if (e.said) { if (t >= e.until) S.eat = null; }
        else if (id && id !== e.id) { mask.gulp(); S.eat = null; }
        else {
          const g = t - e.t0 >= 0.25 ? gradeFor(e.id, s) : null;
          if (g) { mask.verdict(g); e.said = true; e.word = g; e.until = t + EAT.show; }
          else if (t >= e.until) {
            // (V-2: eaten in the middle of its song (ADD TO AI RADIO, EAT IT) and swallowed with no word: the word is OWED)
            mask.gulp(); if (id === e.id) { S.owed.set(e.id, { title: e.title }); if (S.owed.size > 20) S.owed.delete(S.owed.keys().next().value); } S.eat = null;
          }
        }
      }
      // V-2, the owed word: his verdict lands while that song is still on air, or as it ends (its message, or its finish
      // seen for the first time): no second bite, a belch and the word with the song's title. Never once another song
      // has been on air for a while (a verdict that arrives then gives no word).
      if (!S.eat && S.owed.size) {
        for (const [oid, o] of S.owed) {
          const g = gradeFor(oid, s), ok = g && (id === oid || !id || (firstFin && f.id === oid));
          if (!ok) continue;
          S.owed.delete(oid); if (typeof mask.belch === 'function') mask.belch(g, { title: o.title || '' });
          S.eat = { id: oid, t0: t, until: t + EAT.show, said: true, word: g, title: o.title || '' }; S.eatAt = t; break;
        }
        if (id) for (const oid of Array.from(S.owed.keys())) if (oid !== id) S.owed.delete(oid);
      }
      // A LIVE LINK 2.3.0 sends his score as a number and no word: it shows as it did (a number, fire or goo). With the
      // word (`grade`) the number is not shown: the verdict is what the Mask spits after the eat.
      // his score: once per song and number
      if (id && on && s.score !== null && s.score !== undefined && !s.grade) { const k = id + '|' + s.score; if (k !== S.scoreKey) { S.scoreKey = k; mask.score(s.score); } }
      // his grade for the song that just ENDED (LIVE Link: onAir false, the song and a score, sent for 10 s): shown once
      if (!id && on && s && !s.onAir && s.song && s.score !== null && s.score !== undefined && !s.grade) { const k = idOf(s.song) + '|' + s.score; if (k !== S.scoreKey) { S.scoreKey = k; mask.score(s.score); } }
      // the hype rank: LIVE Link's 0..6 (0 = nothing yet, 1 = Warming Up ... 6 = MYTHIC) -> the Mask's -1..5; each further MYTHIC (`mythic` counts the EXTRA ones: 0 at 8,000, 1 at 16,000 ...) = a flare
      const rank = s && s.onAir && on ? clamp((s.hype ? s.hype.rank : 0) - 1, -1, 5) : -1, mythic = s && s.hype ? s.hype.mythic || 0 : 0;
      const wasMythic = S.hypeRank === 5;
      if (rank !== S.hypeRank) { S.hypeRank = rank; mask.setHype(rank, 0); }
      if (rank === 5 && wasMythic && mythic > S.mythic) mask.hypePlus();
      S.mythic = rank === 5 ? mythic : 0;
    }

    // ---- viewers
    function event(ev, t) {
      if (!ev || typeof ev !== 'object' || !S.cfg.on) return { v4: true };
      S.t = t;
      const inFight = fightOn(), who = viewer(ev);
      if (ev.type === 'like') { S.counts.taps += ev.count || 1; if (boss) boss.tap({ viewer: who, count: ev.count || 1 }, t); return { v4: !inFight }; }
      if (ev.type === 'gift') {
        if (boss && boss.phase === 'fight') { boss.gift({ viewer: who, coins: ev.coins || 1, count: ev.count || 1, gift: ev.gift || '' }, t); return { v4: false }; }
        if (inFight) return { v4: false };
        // V9 HYPE: the gifter's picture joins the orbit round the Mask (on unless settings({ orbit: false }): the "Gifters orbit" switch; the picture is the one the
        // page already loads and keeps for the fight's missiles, the placeholder when there is none)
        if (S.cfg.orbit && mask.gifter && !isCrowd(ev)) mask.gifter(who, (ev.coins || 1) * (ev.count || 1));
        if (S.cfg.chat && !busyFight() && t - S.lastGiftAt >= LIMITS.gift) {
          const g = giftMove((ev.coins || 1), S.giftFlip); S.giftFlip = !S.giftFlip; S.lastGiftAt = t;
          S.queue.push({ at: t + g.delay, move: g.move, flare: !!g.flare, gift: true });
        }
        return { v4: true };
      }
      if (ev.type === 'comment') {
        if (votes && votes.active && votes.cast(who.id, ev.text, t) >= 0) return { v4: false };
        const w = chatWord(ev.text);
        if (w) {
          if (S.cfg.chat && !inFight && chatAllowed(who.id, t)) {      // (fix round S1: never in a fight, where Goo / Fire head are HIS attacks on chat)
            const ok = fireMove(w, { t, len: TAP_LEN[w] || 0 });
            if (ok) { S.lastChatAt = t; S.perViewer.set(who.id, t); if (S.perViewer.size > 2000) S.perViewer.delete(S.perViewer.keys().next().value); S.counts.chatMoves++; note('@' + who.name + ' set off ' + MOVE_LABEL[w] + '.', t); }
          }
          return { v4: !inFight };
        }
        const c = cleanComment(ev.text);
        if (c) { S.comments.push({ t, text: c }); if (S.comments.length > 12) S.comments.shift(); }
        return { v4: !inFight };
      }
      return { v4: true };                                               // follow, share: the names the Mask already shows
    }
    /** the room cooldown and the per-viewer limit for chat words */
    function chatAllowed(id, t) { return t - S.lastChatAt >= LIMITS.room && t - (S.perViewer.has(id) ? S.perViewer.get(id) : -1e9) >= LIMITS.viewer; }

    // ---- his face (the real tracker) and his voice
    function face(f, t) {
      S.faceAt = t;
      if (!trig) return;
      const mic = t - S.micAt < 0.6 ? S.mic : null;
      const a = trig.step(t, f && f.bs ? { bs: f.bs, mat: f.mat || null, lm: f.lm || null, mic } : { bs: null });
      // a move that goes off in ONE tracker frame must not be lost between two drawn frames (nor counted twice)
      if (a.shockwave && a.shockwave.fired) S.fired.shock = true;
      if (a.scream && a.scream.fired) S.fired.scream = true;
      for (const e of a.events || []) S.counts.trig[e.type] = (S.counts.trig[e.type] || 0) + 1;
      S.a = a;
    }
    function mic(level, t) { S.mic = clamp(Number(level) || 0, 0, 1); S.micAt = t; }
    function hands(list, o, t) { S.handsIn = Array.isArray(list) ? list : []; S.handsAt = t; if (o && o.aspect) S.aspect = o.aspect; if (o && o.face !== undefined) S.nose = o.face; stepHands(t); }
    function stepHands(t) {
      if (!puppets) return;
      if (!S.cfg.on || !S.cfg.hands) { if (S.p) { S.p = puppets.step(t, [], { aspect: S.aspect, face: S.nose }); if (!S.p.angel.on && !S.p.devil.on && S.p.angel.k <= 0.001 && S.p.devil.k <= 0.001) S.p = null; } S.handsStepAt = t; return; }
      const fresh = t - S.handsAt < 0.3;
      S.p = puppets.step(t, fresh ? S.handsIn : [], { aspect: S.aspect, face: S.nose }); S.handsStepAt = t;
    }

    // ---- once per drawn frame
    function step(t) {
      S.t = t;
      const on = S.cfg.on, song = songNow(t);
      S.songOn = song;
      followShow(t);
      // moves on a timer (a tap's length, the gift reactions, a vote's winner) and holds that ran too long
      for (const m of MOVES) { const M = S.move[m]; if (M.until && t >= M.until) releaseMove(m, t); }
      if (S.queue.length) {
        const due = S.queue.filter((q) => t >= q.at); S.queue = S.queue.filter((q) => t < q.at);
        for (const q of due) { if (!on) continue; const ok = fireMove(q.move, { t, len: TAP_LEN[q.move] ? 2.2 : 0 }); if (ok && q.gift) S.counts.giftMoves++; if (ok && q.flare) S.acts.push({ do: 'flare' }); }
      }
      // the fight
      if (boss) {
        if (!on && fightOn()) boss.stop(t);
        boss.setSongPlaying(song, t);                                    // a song going on air ends a fight cleanly (the engine: the fuller bar wins, the top 3 show)
        let a = null;
        if (S.a && t - S.faceAt < 0.5) { a = S.a; if (S.fired.shock || S.fired.scream) { a = Object.assign({}, a, { shockwave: Object.assign({}, a.shockwave, { fired: S.fired.shock }), scream: Object.assign({}, a.scream, { fired: S.fired.scream }) }); } else if ((a.shockwave && a.shockwave.fired) || (a.scream && a.scream.fired)) a = Object.assign({}, a, { shockwave: Object.assign({}, a.shockwave, { fired: false }), scream: Object.assign({}, a.scream, { fired: false }) }); }
        S.fired.shock = S.fired.scream = false;
        const bs = noCrowd(boss.step(t, a)); S.bs = bs;
        for (const e of bs.events || []) { if (e.type === 'fight-end') { S.lastFight = { winner: e.winner, reason: e.reason, length: Math.round(e.length || 0), at: t }; note(e.winner === 'boss' ? 'You won the fight.' : e.winner === 'chat' ? 'Chat won the fight.' : e.reason === 'song' ? 'The fight ended: a song went on air.' : 'Fight called off.', t); } }
        mask.boss(bs.phase === 'idle' ? null : bs);
      }
      // the vote
      if (votes) {
        if (sched && sched.due(t, { on: on && S.cfg.rand, busy: votes.active || busyFight() })) startVote(null, t);
        if (!on && votes.active) votes.cancel(t);
        const v = votes.step(t); S.vs = v;
        for (const e of v.events || []) if (e.type === 'vote-end') applyVote(e.action, e.winner >= 0 ? e.label : '', t);
        mask.vote(v.active || v.result ? v : null);
      }
      // the hand puppets (the hand model runs slower than the picture: a quiet moment is filled in, so they poof away)
      if (puppets && t - S.handsStepAt > 0.12) stepHands(t);
      mask.hands(S.p, { aspect: S.aspect });
      return status(t);
    }
    /** the crowd is never a name: out of the live top 3 and the ending's top 3; a final blow by the crowd is the raid's */
    function noCrowd(bs) {
      const keep = (l) => (Array.isArray(l) && l.some((r) => r.viewer && r.viewer.id === CROWD) ? l.filter((r) => !(r.viewer && r.viewer.id === CROWD)).map((r, i) => Object.assign({}, r, { rank: i + 1 })) : l);
      if (bs.top) bs.top = keep(bs.top);
      const E = bs.ending;
      if (E) { if (E.top3) E.top3 = keep(E.top3); if (E.finalBlow && E.finalBlow.id === CROWD) { E.finalBlow = null; E.text = 'The raid landed the final blow'; } }
      return bs;
    }
    function status(t) {
      const mv = {}, f = fightOn(), ended = busyFight() && !f;
      for (const m of MOVES) {
        const ms = maskState(m), M = S.move[m]; let cool = 0, onNow = false, why = '';
        if (f) {
          if (m === 'fire' || m === 'goo') { const left = boss.params && boss.params[m] ? boss.params[m].cooldown - (t - M.coolAt) : 0; cool = boss.phase === 'fight' ? Math.max(0, left) : 0; if (boss.phase !== 'fight') why = 'intro'; }
          else why = 'fight';
        } else if (ended) why = 'fight';
        else if (ms) { onNow = !!ms.on; cool = ms.on ? 0 : Math.max(0, ms.t1 + COOL[m] - t); }
        mv[m] = { on: onNow, cool: Math.round(cool * 10) / 10, why };
      }
      const bs = S.bs, v = S.vs;
      return {
        eat: eatStatus(t),
        on: S.cfg.on, song: S.songOn, songSrc: S.songSrc, title: S.show && S.songOn && S.show.song ? S.show.song.title || '' : '',
        hype: S.hypeRank, moves: mv, attack: f,
        fight: bs && bs.phase !== 'idle' ? { phase: bs.phase, boss: Math.round(bs.boss.hp * 100), chat: Math.round(bs.chat.hp * 100), stage: bs.boss.stage, left: Math.round(bs.fightLeft || 0), tappers: bs.chat.tappers || 0, winner: bs.ending ? bs.ending.winner : undefined } : null,
        lastFight: S.lastFight && t - S.lastFight.at < 600 ? { winner: S.lastFight.winner, reason: S.lastFight.reason, length: S.lastFight.length } : null,
        vote: v && (v.active || v.result) ? { active: !!v.active, id: v.id, question: v.question, left: Math.ceil(v.left || 0), total: v.total, lead: v.active ? (v.options.find((o) => o.leading) || {}).label || '' : v.result && v.result.winner >= 0 ? v.result.label : '' } : null,
        puppets: S.p ? { angel: !!S.p.angel.on, devil: !!S.p.devil.on } : null, handsSeen: t - S.handsAt < 1.5,
        face: t - S.faceAt < 1, note: t - S.noteAt < 8 ? S.note : '', counts: S.counts,
      };
    }
    /** why the Mask will or will not eat, in one line, for the window (release A): ready | waiting | no-cover | not-linked */
    function eatStatus(t) {
      const s = freshShow(t), air = s && s.onAir && s.song ? s.song : null, e = S.eat;
      const name = (sg) => { const x = Array.from(String((sg && sg.title) || '').replace(/["“”]/g, '')).slice(0, 36).join('').trim(); return x ? '"' + x + '"' : 'The song on air'; };
      const state = !s ? 'not-linked' : !air ? 'waiting' : !air.cover ? 'no-cover' : 'ready';
      let reason = !s ? EAT_TEXT.notLinked : !air ? EAT_TEXT.waiting : S.eaten.has(idOf(air)) ? EAT_TEXT.eaten.replace('{song}', name(air)) : (air.cover ? EAT_TEXT.ready : EAT_TEXT.noCover).replace('{song}', name(air));
      if (busyFight()) reason = EAT_TEXT.fight;
      else if (e && e.said) reason = EAT_TEXT.spat.replace('{word}', e.word.toUpperCase());
      else if (e) reason = EAT_TEXT.chewing.replace('{n}', String(Math.max(1, Math.ceil(e.until - t))));
      return { state, reason, busy: !!e, eaten: !!(air && S.eaten.has(idOf(air))) };
    }
    return {
      settings(c) { if (!c || typeof c !== 'object') return; for (const k of ['on', 'chat', 'hands', 'rand', 'swap', 'orbit']) if (typeof c[k] === 'boolean') S.cfg[k] = c[k]; if (puppets && puppets.setSourceMirrored) puppets.setSourceMirrored(S.cfg.swap);      // (swap: the angel showed on his left hand)
        if (!S.cfg.on) { for (const m of MOVES) releaseMove(m, S.t); S.queue = []; } },
      cmd, setShow, ear: (v, s, t) => ear.push(clamp(Number(v) || 0, 0, 1), s, t), event, face, mic, hands, step, status,
      takeActs() { const a = S.acts; S.acts = []; return a; },
      get songOn() { return S.songOn; }, state: S, boss, votes, trig, puppets,
    };
  }
  return { create, createEar, cleanComment, chatWord, giftMove, viewerOf, customVote, VOTES, MOVES, MOVE_LABEL, CHAT_WORDS, LIMITS, COOL, TAP_LEN, OVER, EAT };
});
