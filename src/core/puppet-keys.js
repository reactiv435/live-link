'use strict';
// V8 (the puppet show): keys that work in ANY window (OBS, TikTok LIVE Studio, a browser) for the Mask's puppet moves,
// the boss fight and a vote. Contract: the VTuber repo's V8-PHASE2.md, B3 and C4.
//  * Held ONLY while a VTuber that understands them is listening (vtuber-link.js canControl; 2.3.1: with or without
//    a TikTok LIVE) AND a show is plausible (show-feed.js `plausible`: a song on air, up to 30 minutes after one went
//    off air, or a TikTok LIVE connected), and only when the host has not switched them off. The rest of the time the
//    keys belong to the other programs again (Ctrl+Alt+digit types a symbol on some keyboards). All are given back
//    when LIVE Link quits.
//  * 2.3.1: "Eat it" (Ctrl+Alt+8) = the Mask eats the song on air NOW (control action 'eat'; not the puppet move
//    "Eat a comment"). It is the one key that does not follow the VTuber's Puppet show switch (`always`): it is held
//    whenever the Mask is the chosen character (eatWanted below).
//  * V9: "Galaxy" (Ctrl+Alt+9) = the Mask calls the galaxy up; the next press sends it away (control action 'tap',
//    name 'galaxy'; the VTuber keeps count). It follows EAT IT's rule exactly (`always`): the Mask chosen and a show
//    plausible, whatever the Puppet show switch says. (Not Ctrl+Alt+G: Google's Gemini app holds that key in every
//    window on Windows, and Figma uses it.)
//  * V9: "Show sign: show / hide" (Ctrl+Alt+0) and "Live overlay: show / hide" (no keyboard key until he gives it one)
//    = the VTuber window's show sign and live overlay step aside / come back (control actions 'sign' and 'overlay'; the
//    VTuber repo's review/V9-SIGN-NOTES.md "What LIVE Link must change"). Both follow EAT IT's rule (`always`). Their
//    usual keys are set by hand (`key`): numbering them Ctrl+Alt+(i+1) would give "Ctrl+Alt+10" and "Ctrl+Alt+11".
//  * A system-wide key has no "key up": one press = one `control` message. The VTuber plays the move at its standard
//    length; a second press of Goo while it pours makes it pour longer. Holding a key down repeats it: at most 4 a
//    second per key go out.
//  * The usual keys are Ctrl+Alt+1 ... Ctrl+Alt+9 and Ctrl+Alt+0: nothing in Windows, OBS, TikTok LIVE Studio or a
//    browser uses them out of the box. F13-F24 are offered for a Stream Deck (no keyboard has them, so nothing else can clash). A key
//    another program already holds is reported per key ("taken"), never silently dropped.
// Electron-free: main.js passes `register(accelerator, fn) -> bool` and `unregister(accelerator)` (globalShortcut).

const ACTIONS = Object.freeze([
  { id: 'goo', action: 'puppet', name: 'goo', label: 'Goo' },
  { id: 'fire', action: 'puppet', name: 'fire', label: 'Fire head' },
  { id: 'melt', action: 'puppet', name: 'melt', label: 'Melt' },
  { id: 'crack', action: 'puppet', name: 'crack', label: 'Crack open' },
  { id: 'eat', action: 'puppet', name: 'eat', label: 'Eat a comment' },
  { id: 'fight', action: 'fight', name: '', label: 'Boss fight' },
  { id: 'vote', action: 'vote', name: '', label: 'Vote' },
  { id: 'eat-now', action: 'eat', name: '', label: 'Eat it (the song)', always: true },
  { id: 'galaxy', action: 'tap', name: 'galaxy', label: 'Galaxy', always: true },
  { id: 'sign', action: 'sign', name: '', label: 'Show sign: show / hide', always: true, key: 'Ctrl+Alt+0', toggle: true },
  { id: 'overlay', action: 'overlay', name: '', label: 'Live overlay: show / hide', always: true, key: 'off', toggle: true },
]);

// what the host sees -> Electron's accelerator
const KEY_CHOICES = (() => {
  const m = { off: null };
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) m[`Ctrl+Alt+${d}`] = `Control+Alt+${d}`;
  for (let f = 13; f <= 24; f++) m[`F${f}`] = `F${f}`;
  return Object.freeze(m);
})();
// the usual key of each action: Ctrl+Alt+1 ... 9 in order, or the one set by hand (V9: the sign's 0, the overlay's none)
const DEFAULT_KEYS = Object.freeze(Object.fromEntries(ACTIONS.map((a, i) => [a.id, a.key || `Ctrl+Alt+${i + 1}`])));
const STREAM_DECK_KEYS = Object.freeze(Object.fromEntries(ACTIONS.map((a, i) => [a.id, `F${13 + i}`])));
const REPEAT_MS = 250;
// V9 fix round 1: an on/off switch (`toggle`: the sign, the overlay) fires ONCE per press. A press within this long of
// the last one (sent or ignored) is the OS repeating a held key, so a held key sends once and never flips back and
// forth; let go for 0.6 s and the next press toggles again. The other keys keep REPEAT_MS (Goo pours longer).
const TOGGLE_MS = 600;
const RETRY_TAKEN_MS = 30000;      // a key another program holds is tried again this often while it is still wanted

const isChoice = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(KEY_CHOICES, k);

// V9: the card's lines that name a key (the galaxy's, the sign's). "Press <key>" ONLY while LIVE Link really holds it;
// otherwise the line says in plain words why the key does nothing right now. state = the key's row state ('held' |
// 'taken' | 'idle' | 'off'); not said = 'idle' (a line never claims a key works by default). '' = no line: no key, or
// his "Use these keys" switch off (the card already says so).
const KEY_LINES = Object.freeze({
  galaxy: Object.freeze({ name: 'Galaxy', press: 'to call the galaxy up. Press it again to send it away.', does: 'calls the galaxy up' }),
  sign: Object.freeze({ name: 'Show sign', press: 'to hide the show sign, and again to bring it back (once the sign is on in the VTuber window).', does: 'hides and shows the show sign' }),
});
const DURING_SHOW = 'during your show (VTuber open with the Mask, and a song on air or your TikTok LIVE connected). Right now it does nothing.';
function keyLine(id, key, state = 'idle', enabled = true) {
  const L = Object.prototype.hasOwnProperty.call(KEY_LINES, id) ? KEY_LINES[id] : null;
  if (!L || !isChoice(key) || key === 'off' || !enabled || state === 'off') return '';
  if (state === 'held') return `${L.name}: press ${key} ${L.press}`;
  if (state === 'taken') return `${L.name}: another program already uses ${key}, so it does nothing here. Pick another key for ${L.name} in Puppet show keys.`;
  return `${L.name}: ${key} ${L.does} ${DURING_SHOW}`;
}
/** V9: the galaxy's line (kept for the galaxy build's callers) */
const galaxyLine = (key, state, enabled) => keyLine('galaxy', key, state, enabled);

/** Saved keys -> a full, valid map { goo: 'Ctrl+Alt+1', ... }: unknown values fall back to the usual key; a key used twice stays with the first action, the second goes 'off'. */
function cleanKeys(saved) {
  const src = saved && typeof saved === 'object' ? saved : {};
  const out = {}, used = new Set();
  for (const a of ACTIONS) {
    let k = isChoice(src[a.id]) ? src[a.id] : DEFAULT_KEYS[a.id];
    if (k !== 'off' && used.has(k)) k = 'off';
    if (k !== 'off') used.add(k);
    out[a.id] = k;
  }
  return out;
}

/** One key changed in the card. -> { ok: true, keys } | { ok: false, why: 'unknown' | 'taken', by: <label of the action that has it> } */
function setKey(keys, id, key) {
  const cur = cleanKeys(keys);
  if (!ACTIONS.some((a) => a.id === id) || !isChoice(key)) return { ok: false, why: 'unknown' };
  if (key !== 'off') {
    const other = ACTIONS.find((a) => a.id !== id && cur[a.id] === key);
    if (other) return { ok: false, why: 'taken', by: other.label };
  }
  return { ok: true, keys: { ...cur, [id]: key } };
}

/**
 * Should the keys be held right now? canControl = a v2 VTuber is listening (vtuber-link.js); show = a show is
 * plausible (show-feed.js: a song on air, up to 30 minutes after one, or a TikTok LIVE; not said = yes); enabled = the site has not switched the VTuber card off; inApp = the VTuber runs inside LIVE Link;
 * vt = its own state (vtuber-host.js: { character: 'mask' | 'ryo' | 'melanie' | null, ... }).
 *  * In the app: only while the chosen character is the Mask.
 *  * A desktop-shortcut VTuber (HTTP) does not tell LIVE Link which character is chosen: the keys are held as before.
 *  * The VTuber's own "Puppet show" switch is not in the state it sends today, so LIVE Link cannot know it. If a
 *    later VTuber sends `puppet: false` in its state, the keys are given back then.
 */
function puppetWanted({ canControl, enabled = true, inApp = false, vt = null, show = true } = {}) {
  if (!canControl || !enabled || !show) return false;
  if (!inApp) return true;
  if (!vt || vt.character !== 'mask') return false;
  return vt.puppet !== false;
}

/**
 * 2.3.1: should the "Eat it" key be held right now? As puppetWanted, except that the VTuber's Puppet show switch does
 * not matter: the Mask eats the song whether or not the puppet show is on. It follows the same "a show is plausible"
 * window as the other keys.
 */
function eatWanted({ canControl, enabled = true, inApp = false, vt = null, show = true } = {}) {
  if (!canControl || !enabled || !show) return false;
  if (!inApp) return true;
  return !!vt && vt.character === 'mask';
}

class PuppetKeys {
  /**
   * opts: register(accelerator, fn) -> bool, unregister(accelerator), send(action, name) -> bool (vtuber-link
   *       sendControl), keys (saved map), enabled (the host's switch; default on), mono, log
   */
  constructor(opts = {}) {
    this.register = opts.register;
    this.unregister = opts.unregister;
    this.send = opts.send || (() => false);
    this.mono = opts.mono || (() => performance.now());
    this.log = opts.log || (() => {});
    this.setTimeout = opts.setTimeout || setTimeout;
    this.clearTimeout = opts.clearTimeout || clearTimeout;
    this.retryMs = opts.retryMs || RETRY_TAKEN_MS;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;   // a taken key came free (the card shows it)
    this.retryTimer = null;
    this.saidTaken = new Map();     // action id -> the accelerator already logged as taken (one line per key, not one per try)
    this.keys = cleanKeys(opts.keys);
    this.enabled = opts.enabled !== false;
    this.wanted = false;            // a v2 VTuber is listening (the Mask, its Puppet show on): the puppet keys
    this.eatOn = false;             // 2.3.1: a v2 VTuber is listening (the Mask): the "Eat it" key (V9: and the galaxy, sign and overlay keys)
    this.held = new Map();          // action id -> accelerator held right now
    this.taken = new Set();         // action ids whose key another program holds
    this.lastAt = new Map();        // action id -> when it last went out
    this.seenAt = new Map();        // V9: toggle action id -> when its key was last pressed (sent or ignored)
    this.stats = { presses: 0, sent: 0 };
  }

  /** some key is (or should be) held right now */
  get active() { return this.enabled && (this.wanted || this.eatOn); }
  /** should this action's key be held right now? */
  _on(a) { return this.enabled && (a.always ? this.eatOn : this.wanted); }

  /** the listening VTuber changed: hold the puppet keys, or give them back */
  setWanted(on) { on = !!on; if (on === this.wanted) return false; this.wanted = on; this._sync(); return true; }
  /** 2.3.1: the same for the "Eat it" key (it does not follow the Puppet show switch); V9: the galaxy, sign and overlay keys ride with it */
  setEatWanted(on) { on = !!on; if (on === this.eatOn) return false; this.eatOn = on; this._sync(); return true; }
  setEnabled(on) { on = !!on; if (on === this.enabled) return false; this.enabled = on; this._sync(); return true; }
  setKeys(keys) { this.keys = cleanKeys(keys); this._sync(); }

  /** LIVE Link is quitting: every key back */
  release() { this.wanted = false; this.eatOn = false; this._sync(); }

  _sync(retry) {
    this.clearTimeout(this.retryTimer); this.retryTimer = null;
    const before = retry ? [...this.taken].join() : null;
    const want = new Map();
    for (const a of ACTIONS) { const acc = this._on(a) ? KEY_CHOICES[this.keys[a.id]] : null; if (acc) want.set(a.id, acc); }
    for (const [id, acc] of [...this.held]) {
      if (want.get(id) === acc) continue;
      try { this.unregister(acc); } catch {}
      this.held.delete(id);
    }
    this.taken.clear();
    for (const [id, acc] of want) {
      if (this.held.get(id) === acc) continue;
      let ok = false;
      try { ok = this.register(acc, () => this.press(id)) === true; } catch { ok = false; }
      if (ok) {
        this.held.set(id, acc);
        if (this.saidTaken.get(id) === acc) this.log('info', `puppet key ${this.keys[id]} (${ACTIONS.find((a) => a.id === id).label}) is free again: it works now`);
        this.saidTaken.delete(id);
      } else {
        this.taken.add(id);
        if (this.saidTaken.get(id) !== acc) { this.saidTaken.set(id, acc); this.log('warn', `puppet key ${this.keys[id]} (${ACTIONS.find((a) => a.id === id).label}) is taken by another program`); }
      }
    }
    if (this.active) for (const [id, acc] of [...this.saidTaken]) if (want.get(id) !== acc) this.saidTaken.delete(id);   // its key was changed or set to "No key"
    // a taken key is tried again every 30 s for as long as it is wanted (the other program may have closed)
    if (this.taken.size && this.active) {
      this.retryTimer = this.setTimeout(() => { this.retryTimer = null; if (this.active && this.taken.size) this._sync(true); }, this.retryMs);
      if (this.retryTimer && typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
    }
    if (retry && this.onChange && [...this.taken].join() !== before) { try { this.onChange(); } catch {} }
  }

  /** a key was pressed (or the OS repeats a held one) */
  press(id) {
    const a = ACTIONS.find((x) => x.id === id);
    if (!a || !this._on(a) || !this.held.has(id)) return false;   // V9: only a key LIVE Link holds right now (an action with "No key", e.g. the overlay's default, sends nothing)
    this.stats.presses++;
    const now = this.mono(), last = this.lastAt.get(id);
    if (a.toggle) {   // V9: an on/off switch fires once per press (TOGGLE_MS)
      const seen = this.seenAt.get(id);
      this.seenAt.set(id, now);
      if (seen !== undefined && now - seen < TOGGLE_MS) return false;
    } else if (last !== undefined && now - last < REPEAT_MS) return false;
    this.lastAt.set(id, now);
    let took = false;
    try { took = this.send(a.action, a.name) === true; } catch { took = false; }
    if (took) this.stats.sent++;
    return took;
  }

  /** for the card: { enabled, active, rows: [{ id, label, key, state: 'held' | 'taken' | 'off' | 'idle' }], choices, galaxy, sign: <the lines that name those keys, keyLine> } */
  getState() {
    const rows = ACTIONS.map((a) => ({ id: a.id, label: a.label, key: this.keys[a.id],
      state: this.keys[a.id] === 'off' ? 'off' : this.held.has(a.id) ? 'held' : this.taken.has(a.id) ? 'taken' : 'idle' }));
    const line = (id) => { const r = rows.find((x) => x.id === id); return keyLine(id, r.key, r.state, this.enabled); };
    return { enabled: this.enabled, active: this.active, rows, choices: Object.keys(KEY_CHOICES), galaxy: line('galaxy'), sign: line('sign') };
  }
}

module.exports = { PuppetKeys, puppetWanted, eatWanted, keyLine, galaxyLine, ACTIONS, KEY_CHOICES, DEFAULT_KEYS, STREAM_DECK_KEYS, REPEAT_MS, TOGGLE_MS, RETRY_TAKEN_MS, cleanKeys, setKey };
