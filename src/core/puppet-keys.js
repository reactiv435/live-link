'use strict';
// V8 (the puppet show): keys that work in ANY window (OBS, TikTok LIVE Studio, a browser) for the Mask's puppet moves,
// the boss fight and a vote. Contract: the VTuber repo's V8-PHASE2.md, B3 and C4.
//  * Held ONLY while a VTuber that understands them is listening AND a TikTok LIVE is connected (vtuber-link.js
//    canControl), and only when the host has not switched them off. The rest of the time the keys belong to the
//    other programs again. All are given back when LIVE Link quits.
//  * A system-wide key has no "key up": one press = one `control` message. The VTuber plays the move at its standard
//    length; a second press of Goo while it pours makes it pour longer. Holding a key down repeats it: at most 4 a
//    second per key go out.
//  * The usual keys are Ctrl+Alt+1 ... Ctrl+Alt+7: nothing in Windows, OBS, TikTok LIVE Studio or a browser uses them
//    out of the box. F13-F24 are offered for a Stream Deck (no keyboard has them, so nothing else can clash). A key
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
]);

// what the host sees -> Electron's accelerator
const KEY_CHOICES = (() => {
  const m = { off: null };
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) m[`Ctrl+Alt+${d}`] = `Control+Alt+${d}`;
  for (let f = 13; f <= 24; f++) m[`F${f}`] = `F${f}`;
  return Object.freeze(m);
})();
const DEFAULT_KEYS = Object.freeze(Object.fromEntries(ACTIONS.map((a, i) => [a.id, `Ctrl+Alt+${i + 1}`])));
const STREAM_DECK_KEYS = Object.freeze(Object.fromEntries(ACTIONS.map((a, i) => [a.id, `F${13 + i}`])));
const REPEAT_MS = 250;
const RETRY_TAKEN_MS = 30000;      // a key another program holds is tried again this often while it is still wanted

const isChoice = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(KEY_CHOICES, k);

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
 * Should the keys be held right now? canControl = a v2 VTuber is listening and a TikTok LIVE is connected
 * (vtuber-link.js); enabled = the site has not switched the VTuber card off; inApp = the VTuber runs inside LIVE Link;
 * vt = its own state (vtuber-host.js: { character: 'mask' | 'ryo' | 'melanie' | null, ... }).
 *  * In the app: only while the chosen character is the Mask.
 *  * A desktop-shortcut VTuber (HTTP) does not tell LIVE Link which character is chosen: the keys are held as before.
 *  * The VTuber's own "Puppet show" switch is not in the state it sends today, so LIVE Link cannot know it. If a
 *    later VTuber sends `puppet: false` in its state, the keys are given back then.
 */
function puppetWanted({ canControl, enabled = true, inApp = false, vt = null } = {}) {
  if (!canControl || !enabled) return false;
  if (!inApp) return true;
  if (!vt || vt.character !== 'mask') return false;
  return vt.puppet !== false;
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
    this.wanted = false;            // a v2 VTuber is listening and a LIVE is connected
    this.held = new Map();          // action id -> accelerator held right now
    this.taken = new Set();         // action ids whose key another program holds
    this.lastAt = new Map();        // action id -> when it last went out
    this.stats = { presses: 0, sent: 0 };
  }

  get active() { return this.enabled && this.wanted; }

  /** the listening VTuber / the LIVE changed: hold the keys, or give them back */
  setWanted(on) { on = !!on; if (on === this.wanted) return false; this.wanted = on; this._sync(); return true; }
  setEnabled(on) { on = !!on; if (on === this.enabled) return false; this.enabled = on; this._sync(); return true; }
  setKeys(keys) { this.keys = cleanKeys(keys); this._sync(); }

  /** LIVE Link is quitting: every key back */
  release() { this.wanted = false; this._sync(); }

  _sync(retry) {
    this.clearTimeout(this.retryTimer); this.retryTimer = null;
    const before = retry ? [...this.taken].join() : null;
    const want = new Map();
    if (this.active) for (const a of ACTIONS) { const acc = KEY_CHOICES[this.keys[a.id]]; if (acc) want.set(a.id, acc); }
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
    if (!a || !this.active) return false;
    this.stats.presses++;
    const now = this.mono(), last = this.lastAt.get(id);
    if (last !== undefined && now - last < REPEAT_MS) return false;
    this.lastAt.set(id, now);
    let took = false;
    try { took = this.send(a.action, a.name) === true; } catch { took = false; }
    if (took) this.stats.sent++;
    return took;
  }

  /** for the card: { enabled, active, rows: [{ id, label, key, state: 'held' | 'taken' | 'off' | 'idle' }], choices } */
  getState() {
    return {
      enabled: this.enabled, active: this.active,
      rows: ACTIONS.map((a) => ({ id: a.id, label: a.label, key: this.keys[a.id],
        state: this.keys[a.id] === 'off' ? 'off' : this.held.has(a.id) ? 'held' : this.taken.has(a.id) ? 'taken' : 'idle' })),
      choices: Object.keys(KEY_CHOICES),
    };
  }
}

module.exports = { PuppetKeys, puppetWanted, ACTIONS, KEY_CHOICES, DEFAULT_KEYS, STREAM_DECK_KEYS, REPEAT_MS, RETRY_TAKEN_MS, cleanKeys, setKey };
