'use strict';
// V8 (the puppet show), B3 / C4: the keys that work in any window. No real key is ever registered here: `register` and
// `unregister` are functions inside the test (Electron's globalShortcut is never loaded).
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PuppetKeys, ACTIONS, KEY_CHOICES, DEFAULT_KEYS, STREAM_DECK_KEYS, REPEAT_MS, RETRY_TAKEN_MS, cleanKeys, setKey } = require('../src/core/puppet-keys');
const { VtuberLink } = require('../src/core/vtuber-link');
const { VtuberHost } = require('../src/core/vtuber-host');

// a stand-in for the system's key table
function keyboard({ taken = [] } = {}) {
  const k = { held: new Map(), calls: [], taken: new Set(taken) };
  k.register = (acc, fn) => { k.calls.push(['+', acc]); if (k.taken.has(acc) || k.held.has(acc)) return false; k.held.set(acc, fn); return true; };
  k.unregister = (acc) => { k.calls.push(['-', acc]); k.held.delete(acc); };
  k.press = (acc) => { const fn = k.held.get(acc); return fn ? fn() : undefined; };
  return k;
}
function keys(opts = {}) {
  const kb = opts.kb || keyboard(opts);
  const sent = [], logs = [];
  let t = 10000;
  const pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => { sent.push([a, n]); return opts.refuse ? false : true; }, mono: () => t, log: (l, m) => logs.push(`${l} ${m}`), keys: opts.saved, enabled: opts.enabled });
  return { kb, pk, sent, logs, tick: (ms) => { t += ms; } };
}

test('the keys: eight actions on Ctrl+Alt+1 ... 8 (2.3.1: EAT IT on Ctrl+Alt+8), F13 ... F20 for a Stream Deck; none is a key LIVE Link or a common program already uses', () => {
  assert.deepEqual(ACTIONS.map((a) => [a.id, a.action, a.name, a.label]), [
    ['goo', 'puppet', 'goo', 'Goo'], ['fire', 'puppet', 'fire', 'Fire head'], ['melt', 'puppet', 'melt', 'Melt'], ['crack', 'puppet', 'crack', 'Crack open'], ['eat', 'puppet', 'eat', 'Eat a comment'],
    ['fight', 'fight', '', 'Boss fight'], ['vote', 'vote', '', 'Vote'], ['eat-now', 'eat', '', 'Eat it (the song)']]);
  assert.deepEqual(DEFAULT_KEYS, { goo: 'Ctrl+Alt+1', fire: 'Ctrl+Alt+2', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', 'eat-now': 'Ctrl+Alt+8' });
  assert.deepEqual(Object.values(STREAM_DECK_KEYS), ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20']);
  // EAT IT is on Ctrl+Alt+8 by default, and its accelerator clashes with nothing: not Ctrl+Alt+1-7, not F8 / F9 / F10, not Ctrl+Shift+M
  assert.equal(KEY_CHOICES[DEFAULT_KEYS['eat-now']], 'Control+Alt+8');
  assert.equal(new Set(Object.values(DEFAULT_KEYS).map((k) => KEY_CHOICES[k])).size, 8, 'eight different keys');
  assert.equal(new Set(Object.values(STREAM_DECK_KEYS)).size, 8);
  for (const other of ['F8', 'F9', 'F10', 'CommandOrControl+Shift+M', 'Control+Shift+M']) assert.notEqual(KEY_CHOICES[DEFAULT_KEYS['eat-now']], other);
  assert.equal(ACTIONS.filter((a) => a.always).map((a) => a.id).join(), 'eat-now', 'the one key that does not follow the Puppet show switch');
  assert.equal(KEY_CHOICES['Ctrl+Alt+1'], 'Control+Alt+1');
  assert.equal(KEY_CHOICES.F13, 'F13');
  assert.equal(KEY_CHOICES.off, null);
  assert.equal(Object.keys(KEY_CHOICES).length, 1 + 10 + 12);
  // not the "Clip that" key (main.js MOMENT_KEYS), not a bare letter, digit or F1-F12 (those belong to other programs)
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const moment = /const MOMENT_KEYS = \{([^}]*)\}/.exec(main)[1];
  for (const acc of Object.values(KEY_CHOICES)) {
    if (!acc) continue;
    assert.ok(!moment.includes(`'${acc}'`), `${acc} is a "Clip that" key`);
    assert.match(acc, /^(Control\+Alt\+[0-9]|F(1[3-9]|2[0-4]))$/);
  }
});

test('held ONLY while a VTuber is listening during a LIVE and the switch is on; given back the moment either ends, and on quit', () => {
  const { kb, pk } = keys();
  assert.equal(kb.calls.length, 0, 'nothing is taken at start');
  assert.equal(pk.getState().active, false);
  assert.ok(pk.getState().rows.every((r) => r.state === 'idle'));
  pk.setWanted(true);
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Alt+4', 'Control+Alt+5', 'Control+Alt+6', 'Control+Alt+7']);
  assert.ok(pk.getState().rows.every((r) => r.state === (r.id === 'eat-now' ? 'idle' : 'held')), 'the seven puppet keys (EAT IT has its own rule: setEatWanted)');
  assert.equal(pk.getState().active, true);
  const n = kb.calls.length;
  pk.setWanted(true);
  assert.equal(kb.calls.length, n, 'said again: nothing is registered twice');
  pk.setWanted(false);                                  // the LIVE ended, or VTuber closed
  assert.equal(kb.held.size, 0);
  pk.setWanted(true);
  pk.setEnabled(false);                                 // the host's switch
  assert.equal(kb.held.size, 0);
  assert.equal(pk.getState().enabled, false);
  pk.setEnabled(true);
  assert.equal(kb.held.size, 7);
  pk.release();                                         // LIVE Link quits
  assert.equal(kb.held.size, 0);
  assert.equal(kb.calls.filter((c) => c[0] === '+').length, kb.calls.filter((c) => c[0] === '-').length, 'every key taken was given back');
});

test('a press = one control message; a held key (the OS repeats it) sends at most 4 a second; no message when nothing listens', () => {
  const { kb, pk, sent, tick } = keys();
  pk.setWanted(true);
  assert.equal(kb.press('Control+Alt+1'), true);
  assert.deepEqual(sent, [['puppet', 'goo']]);
  for (let i = 0; i < 30; i++) { tick(33); kb.press('Control+Alt+1'); }       // held for a second
  assert.ok(sent.length >= 4 && sent.length <= 5, `${sent.length} sends for a one-second hold`);
  assert.equal(REPEAT_MS, 250);
  const n = sent.length;
  kb.press('Control+Alt+2'); kb.press('Control+Alt+6'); kb.press('Control+Alt+7');   // other keys are not held back by it
  assert.deepEqual(sent.slice(n), [['puppet', 'fire'], ['fight', ''], ['vote', '']]);
  tick(1000);
  pk.setEatWanted(true);                                                           // (2.3.1: the eighth key)
  for (const [i, a] of ACTIONS.entries()) { kb.press(`Control+Alt+${i + 1}`); assert.deepEqual(sent[sent.length - 1], [a.action, a.name]); }
  pk.setEatWanted(false);
  assert.equal(pk.press('nope'), false);
  // the fn of a key that was given back does nothing even if the system still calls it
  const stale = kb.held.get('Control+Alt+3');
  pk.setWanted(false);
  const m = sent.length;
  assert.equal(stale(), false);
  assert.equal(sent.length, m);
});

test('a key another program holds is shown as "taken" on that row only; the rest work; picking another key for it fixes it', () => {
  const { kb, pk, logs } = keys({ taken: ['Control+Alt+3'] });
  pk.setWanted(true);
  const st = () => Object.fromEntries(pk.getState().rows.map((r) => [r.id, r.state]));
  assert.deepEqual(st(), { goo: 'held', fire: 'held', melt: 'taken', crack: 'held', eat: 'held', fight: 'held', vote: 'held', 'eat-now': 'idle' });
  assert.deepEqual(logs, ['warn puppet key Ctrl+Alt+3 (Melt) is taken by another program']);
  const r = setKey(pk.keys, 'melt', 'F15');
  assert.equal(r.ok, true);
  pk.setKeys(r.keys);
  assert.equal(st().melt, 'held');
  assert.ok(kb.held.has('F15'));
  assert.equal(kb.calls.filter((c) => c[0] === '+' && c[1] === 'Control+Alt+1').length, 1, 'the other keys were not touched');
  // a register that throws is "taken" too, never a crash
  const k2 = keyboard();
  const pk2 = new PuppetKeys({ register: () => { throw new Error('boom'); }, unregister: k2.unregister, send: () => true });
  assert.doesNotThrow(() => { pk2.setWanted(true); pk2.setEatWanted(true); });
  assert.ok(pk2.getState().rows.every((x) => x.state === 'taken'));
});

test('changing keys: one key per action, a clash names the action that has it, "No key" any number of times; saved nonsense falls back to the usual keys', () => {
  assert.deepEqual(setKey(DEFAULT_KEYS, 'goo', 'Ctrl+Alt+2'), { ok: false, why: 'taken', by: 'Fire head' });
  assert.deepEqual(setKey(DEFAULT_KEYS, 'goo', 'Ctrl+Alt+1').ok, true, 'its own key again');
  assert.deepEqual(setKey(DEFAULT_KEYS, 'goo', 'F8'), { ok: false, why: 'unknown' }, 'F8 is the "Clip that" key: not offered');
  assert.deepEqual(setKey(DEFAULT_KEYS, 'explode', 'F13'), { ok: false, why: 'unknown' });
  assert.deepEqual(setKey(DEFAULT_KEYS, '__proto__', 'F13'), { ok: false, why: 'unknown' });
  assert.deepEqual(setKey(DEFAULT_KEYS, 'goo', 'toString'), { ok: false, why: 'unknown' });
  let k = setKey(DEFAULT_KEYS, 'goo', 'off').keys;
  k = setKey(k, 'fire', 'off').keys;
  assert.deepEqual([k.goo, k.fire, k.melt], ['off', 'off', 'Ctrl+Alt+3']);
  assert.equal(setKey(k, 'melt', 'Ctrl+Alt+1').ok, true, 'a freed key can be given to another action');
  assert.deepEqual(cleanKeys(null), { ...DEFAULT_KEYS });
  assert.deepEqual(cleanKeys({ goo: 'F13', fire: 'F13', melt: 'Shift+Q', crack: 7, extra: 'F20' }), { goo: 'F13', fire: 'off', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', 'eat-now': 'Ctrl+Alt+8' });
  // keys saved by 2.3.0 (seven of them): EAT IT gets Ctrl+Alt+8; if he had already given Ctrl+Alt+8 to another action, that one keeps it and EAT IT starts with no key
  assert.equal(cleanKeys({ goo: 'Ctrl+Alt+1', fire: 'Ctrl+Alt+2', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7' })['eat-now'], 'Ctrl+Alt+8');
  assert.deepEqual([cleanKeys({ vote: 'Ctrl+Alt+8' }).vote, cleanKeys({ vote: 'Ctrl+Alt+8' })['eat-now']], ['Ctrl+Alt+8', 'off']);
  assert.deepEqual(setKey(DEFAULT_KEYS, 'eat-now', 'Ctrl+Alt+7'), { ok: false, why: 'taken', by: 'Vote' });
  assert.equal(setKey(DEFAULT_KEYS, 'eat-now', 'F24').keys['eat-now'], 'F24');
  // changing keys while they are held: the old ones go back, the new ones are taken
  const { kb, pk } = keys({ saved: { ...STREAM_DECK_KEYS } });
  pk.setWanted(true);
  assert.deepEqual([...kb.held.keys()], ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19']);
  pk.setKeys({ ...DEFAULT_KEYS, vote: 'off' });
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Alt+4', 'Control+Alt+5', 'Control+Alt+6']);
  assert.equal(pk.getState().rows.find((r) => r.id === 'vote').state, 'off');
});

test('end to end: a key press reaches a v2 VTuber as { v: 2, type: "control" }; 2.3.1: the keys follow the VTuber by themselves, with or without a TikTok LIVE', () => {
  const link = new EventEmitter(); link.state = { status: 'idle' };
  const got = [];
  let running = false;
  const fn = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const kb = keyboard();
  let pk = null;
  const sync = () => { if (pk) { pk.setWanted(v.canControl); pk.setEatWanted(v.canControl); } };       // (main.js: also on every state the VTuber sends)
  const v = new VtuberLink({ http: false, direct: () => (running ? fn : null), onChange: sync }).attach(link);
  pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => v.sendControl(a, n) });
  sync();
  assert.equal(kb.held.size, 0, 'no VTuber: no key is held');
  running = true; sync();                                               // VTuber opened; TikTok was never connected
  assert.equal(kb.held.size, 8, 'a v2 VTuber in the app: held, TikTok or not');
  kb.press('Control+Alt+1'); kb.press('Control+Alt+6'); kb.press('Control+Alt+7'); kb.press('Control+Alt+8');
  assert.deepEqual(got.map((e) => [e.v, e.type, e.action, e.name]), [[2, 'control', 'puppet', 'goo'], [2, 'control', 'fight', ''], [2, 'control', 'vote', ''], [2, 'control', 'eat', '']]);
  assert.ok(got.every((e) => Number.isInteger(e.at) && Object.keys(e).length === 5));
  for (const status of ['live', 'reconnecting', 'offline']) {
    link.state = { status }; link.emit('state', link.state);
    assert.equal(kb.held.size, 8, `TikTok ${status}: the keys stay`);
  }
  running = false; sync();
  assert.equal(kb.held.size, 0, 'VTuber closed: every key is back with the other programs');
  // a v1 VTuber (one that would not understand a key): the keys are never taken
  fn.v = 1; running = true; sync();
  assert.equal(kb.held.size, 0);
  v.stop();
});

test('2.3.1 EAT IT (Ctrl+Alt+8) does not follow the Puppet show switch: held with the Mask chosen even when that switch is off; one press = one { action: "eat" }', () => {
  const { puppetWanted, eatWanted } = require('../src/core/puppet-keys');
  const on = { canControl: true, enabled: true, inApp: true };
  assert.equal(eatWanted({ ...on, vt: { character: 'mask', puppet: false } }), true, 'Puppet show off: EAT IT still works');
  assert.equal(puppetWanted({ ...on, vt: { character: 'mask', puppet: false } }), false, '(the puppet keys do not)');
  assert.equal(eatWanted({ ...on, vt: { character: 'mask', puppet: true } }), true);
  assert.equal(eatWanted({ ...on, vt: { character: 'mask' } }), true);
  assert.equal(eatWanted({ ...on, vt: { character: 'ryo' } }), false, 'Ryo does not eat songs: the key stays with the other programs');
  assert.equal(eatWanted({ ...on, vt: null }), false, 'the VTuber has not said anything yet');
  assert.equal(eatWanted({ ...on, canControl: false, vt: { character: 'mask' } }), false, 'no v2 VTuber');
  assert.equal(eatWanted({ ...on, enabled: false, vt: { character: 'mask' } }), false, 'the site switched the card off');
  assert.equal(eatWanted({ canControl: true, enabled: true, inApp: false, vt: null }), true, 'over HTTP the character is not known');
  assert.equal(eatWanted(), false);
  // the Puppet show switch off: only Ctrl+Alt+8 is held, and it works
  const { kb, pk, sent, tick } = keys();
  pk.setWanted(false); pk.setEatWanted(true);
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+8']);
  assert.equal(pk.getState().active, true);
  assert.deepEqual(pk.getState().rows.map((r) => r.state), ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'held']);
  assert.equal(kb.press('Control+Alt+8'), true);
  assert.deepEqual(sent, [['eat', '']]);
  assert.equal(pk.press('goo'), false, 'a puppet move is not sent while its keys are not held');
  for (let i = 0; i < 30; i++) { tick(33); kb.press('Control+Alt+8'); }       // held down for a second
  assert.ok(sent.length >= 4 && sent.length <= 5, `at most 4 a second: ${sent.length}`);
  // the switch on: all eight; off again: back to the one; "Use these keys" off: none; quit: none
  pk.setWanted(true);
  assert.equal(kb.held.size, 8);
  pk.setWanted(false);
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+8']);
  pk.setEnabled(false);
  assert.equal(kb.held.size, 0, 'the host\'s own "Use these keys" switch covers EAT IT too');
  assert.equal(pk.press('eat-now'), false);
  pk.setEnabled(true);
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+8']);
  pk.setKeys({ ...DEFAULT_KEYS, 'eat-now': 'off' });
  assert.equal(kb.held.size, 0, '"No key" for EAT IT');
  pk.setKeys({ ...DEFAULT_KEYS });
  pk.release();
  assert.equal(kb.held.size, 0);
  assert.equal(pk.getState().active, false);
  assert.equal(kb.calls.filter((c) => c[0] === '+').length, kb.calls.filter((c) => c[0] === '-').length, 'every key taken was given back');
  // a taken Ctrl+Alt+8 is shown on its row and tried again
  const b = keys({ taken: ['Control+Alt+8'] });
  b.pk.setEatWanted(true);
  assert.equal(b.pk.getState().rows.find((r) => r.id === 'eat-now').state, 'taken');
  assert.deepEqual(b.logs, ['warn puppet key Ctrl+Alt+8 (Eat it (the song)) is taken by another program']);
});

test('which contract the VTuber in this install speaks: 2 when its files know the v2 messages or its "ready" says so, else 1 (it then gets the 2.2.0 events)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-v8-wire-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const mk = (name, wireJs) => { const d = path.join(dir, name); fs.mkdirSync(path.join(d, 'js'), { recursive: true }); fs.writeFileSync(path.join(d, 'livelink-host.js'), '// stand-in'); if (wireJs !== null) fs.writeFileSync(path.join(d, 'js', 'mask-wire.js'), wireJs); return d; };
  assert.equal(new VtuberHost({ dir: mk('v7', 'function cleanEvent(e) { return e.v === 1 ? e : null; }') }).wire, 1);
  assert.equal(new VtuberHost({ dir: mk('v8', 'function cleanEvent(e) {}\nfunction cleanShow(e) {}') }).wire, 2);
  assert.equal(new VtuberHost({ dir: mk('none', null) }).wire, 1);
  assert.equal(new VtuberHost({ dir: path.join(dir, 'missing') }).wire, 1);
  // the copy shipped in this repo right now (vendor/vtuber is re-synced by the main session): whatever it is, it is 1 or 2
  const vendored = new VtuberHost({ dir: path.join(__dirname, '..', 'vendor', 'vtuber') }).wire;
  assert.ok(vendored === 1 || vendored === 2);
  // a "ready" that says wire 2 raises it (a future VTuber whose file layout changed)
  let onMessage = null;
  const posts = [];
  const host = new VtuberHost({ dir: mk('ready', 'function cleanEvent(e) {}'), dataDir: path.join(dir, 'data'),
    spawn: () => ({ post: (m) => posts.push(m), onMessage: (fn) => { onMessage = fn; }, onExit: () => {}, kill: () => {} }) });
  assert.equal(host.wire, 1);
  const started = host.start();
  onMessage({ t: 'ready', port: 45123, wire: 2 });
  assert.deepEqual(await started, { ok: true, port: 45123 });
  assert.equal(host.wire, 2);
  assert.equal(host.getState().wire, 2);
  // show and control ride the same in-app message as the viewers' events
  assert.equal(host.event({ v: 2, type: 'control', action: 'fight', name: '', at: 1 }), true);
  assert.deepEqual(posts, [{ t: 'event', ev: { v: 2, type: 'control', action: 'fight', name: '', at: 1 } }]);
});

// ---------------------------------------------------------------- the fix round (the review's points)

test('fix round: the keys are held only while the Mask is the chosen character (in the app); a desktop-shortcut VTuber does not say, so there they are held as before', () => {
  const { puppetWanted } = require('../src/core/puppet-keys');
  const on = { canControl: true, enabled: true, inApp: true };
  assert.equal(puppetWanted({ ...on, vt: { character: 'mask', on: true } }), true);
  assert.equal(puppetWanted({ ...on, vt: { character: 'ryo', on: true } }), false, 'Ryo: the keys stay with the other programs');
  assert.equal(puppetWanted({ ...on, vt: { character: 'melanie' } }), false);
  assert.equal(puppetWanted({ ...on, vt: { character: null } }), false, 'no character chosen yet');
  assert.equal(puppetWanted({ ...on, vt: null }), false, 'the VTuber has not said anything yet');
  assert.equal(puppetWanted({ ...on, vt: { character: 'mask', puppet: false } }), false, 'a later VTuber that reports its Puppet show switch off');
  assert.equal(puppetWanted({ ...on, canControl: false, vt: { character: 'mask' } }), false, 'no LIVE or no v2 VTuber');
  assert.equal(puppetWanted({ ...on, enabled: false, vt: { character: 'mask' } }), false, 'the site switched the card off');
  assert.equal(puppetWanted({ canControl: true, enabled: true, inApp: false, vt: null }), true, 'over HTTP the character is not known');
  assert.equal(puppetWanted(), false);
  // switching character during a LIVE takes the keys and gives them back
  const { kb, pk } = keys();
  for (const [character, held] of [['mask', 7], ['ryo', 0], ['mask', 7], ['melanie', 0]]) { pk.setWanted(puppetWanted({ ...on, vt: { character } })); assert.equal(kb.held.size, held, character); }
});

test('fix round: a TAKEN key is tried again every 30 s while it is still wanted; it works once the other program lets go; one log line, not one per try', () => {
  const timers = [];
  const kb = keyboard({ taken: ['Control+Alt+3'] });
  const logs = [], changes = [];
  const pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: () => true, log: (l, m) => logs.push(`${l} ${m}`), onChange: () => changes.push(1),
    setTimeout: (fn, ms) => { const t = { fn, ms, dead: false }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.dead = true; } });
  const live = () => timers.filter((t) => !t.dead);
  const fire = () => { const t = live()[0]; t.dead = true; t.fn(); };
  assert.equal(RETRY_TAKEN_MS, 30000);
  pk.setWanted(true);
  assert.deepEqual(live().map((t) => t.ms), [30000], 'one retry is waiting');
  const tries = () => kb.calls.filter((c) => c[0] === '+' && c[1] === 'Control+Alt+3').length;
  assert.equal(tries(), 1);
  for (let i = 0; i < 5; i++) fire();                                  // 2.5 minutes, still taken
  assert.equal(tries(), 6);
  assert.equal(kb.calls.filter((c) => c[0] === '+' && c[1] === 'Control+Alt+1').length, 1, 'the keys that work are not touched by a retry');
  assert.deepEqual(logs, ['warn puppet key Ctrl+Alt+3 (Melt) is taken by another program'], 'said once');
  assert.equal(changes.length, 0, 'nothing changed: the card is not redrawn');
  kb.taken.delete('Control+Alt+3');                                    // the other program closed
  fire();
  assert.equal(pk.getState().rows.find((r) => r.id === 'melt').state, 'held');
  assert.equal(changes.length, 1, 'the card is told');
  assert.equal(live().length, 0, 'nothing left to retry: no timer');
  assert.deepEqual(logs.slice(1), ['info puppet key Ctrl+Alt+3 (Melt) is free again: it works now']);
  // no longer wanted (the LIVE ended): the retry stops
  kb.taken.add('Control+Alt+5'); pk.setWanted(false); pk.setWanted(true);
  assert.equal(live().length, 1);
  pk.setWanted(false);
  assert.equal(live().length, 0);
  pk.setWanted(true); pk.release();
  assert.equal(live().length, 0, 'quit: no timer left');
  assert.equal(kb.held.size, 0);
});
