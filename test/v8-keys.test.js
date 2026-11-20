'use strict';
// V8 (the puppet show), B3 / C4: the keys that work in any window. No real key is ever registered here: `register` and
// `unregister` are functions inside the test (Electron's globalShortcut is never loaded).
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PuppetKeys, ACTIONS, KEY_CHOICES, DEFAULT_KEYS, STREAM_DECK_KEYS, REPEAT_MS, cleanKeys, setKey } = require('../src/core/puppet-keys');
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

test('the keys: seven actions on Ctrl+Alt+1 ... 7, F13 ... F19 for a Stream Deck; none is a key LIVE Link or a common program already uses', () => {
  assert.deepEqual(ACTIONS.map((a) => [a.id, a.action, a.name, a.label]), [
    ['goo', 'puppet', 'goo', 'Goo'], ['fire', 'puppet', 'fire', 'Fire head'], ['melt', 'puppet', 'melt', 'Melt'], ['crack', 'puppet', 'crack', 'Crack open'], ['eat', 'puppet', 'eat', 'Eat a comment'],
    ['fight', 'fight', '', 'Boss fight'], ['vote', 'vote', '', 'Vote']]);
  assert.deepEqual(DEFAULT_KEYS, { goo: 'Ctrl+Alt+1', fire: 'Ctrl+Alt+2', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7' });
  assert.deepEqual(Object.values(STREAM_DECK_KEYS), ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19']);
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
  assert.ok(pk.getState().rows.every((r) => r.state === 'held'));
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
  for (const [i, a] of ACTIONS.entries()) { kb.press(`Control+Alt+${i + 1}`); assert.deepEqual(sent[sent.length - 1], [a.action, a.name]); }
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
  assert.deepEqual(st(), { goo: 'held', fire: 'held', melt: 'taken', crack: 'held', eat: 'held', fight: 'held', vote: 'held' });
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
  assert.doesNotThrow(() => pk2.setWanted(true));
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
  assert.deepEqual(cleanKeys({ goo: 'F13', fire: 'F13', melt: 'Shift+Q', crack: 7, extra: 'F20' }), { goo: 'F13', fire: 'off', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7' });
  // changing keys while they are held: the old ones go back, the new ones are taken
  const { kb, pk } = keys({ saved: { ...STREAM_DECK_KEYS } });
  pk.setWanted(true);
  assert.deepEqual([...kb.held.keys()], ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19']);
  pk.setKeys({ ...DEFAULT_KEYS, vote: 'off' });
  assert.deepEqual([...kb.held.keys()], ['Control+Alt+1', 'Control+Alt+2', 'Control+Alt+3', 'Control+Alt+4', 'Control+Alt+5', 'Control+Alt+6']);
  assert.equal(pk.getState().rows.find((r) => r.id === 'vote').state, 'off');
});

test('end to end: a key press reaches a v2 VTuber as { v: 2, type: "control" }; the keys follow the LIVE and the VTuber by themselves', () => {
  const link = new EventEmitter(); link.state = { status: 'idle' };
  const got = [];
  let running = true;
  const fn = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const kb = keyboard();
  let pk = null;
  const v = new VtuberLink({ http: false, direct: () => (running ? fn : null), onChange: () => pk && pk.setWanted(v.canControl) }).attach(link);
  pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => v.sendControl(a, n) });
  pk.setWanted(v.canControl);
  assert.equal(kb.held.size, 0, 'no LIVE: no key is held');
  link.state = { status: 'live' }; link.emit('state', link.state);
  assert.equal(kb.held.size, 7, 'LIVE connected + VTuber in the app: held');
  kb.press('Control+Alt+1'); kb.press('Control+Alt+6'); kb.press('Control+Alt+7');
  assert.deepEqual(got.map((e) => [e.v, e.type, e.action, e.name]), [[2, 'control', 'puppet', 'goo'], [2, 'control', 'fight', ''], [2, 'control', 'vote', '']]);
  assert.ok(got.every((e) => Number.isInteger(e.at) && Object.keys(e).length === 5));
  link.state = { status: 'offline' }; link.emit('state', link.state);
  assert.equal(kb.held.size, 0, 'the LIVE ended: every key is back with the other programs');
  // a v1 VTuber (one that would not understand a key): the keys are never taken
  fn.v = 1;
  link.state = { status: 'live' }; link.emit('state', link.state);
  assert.equal(kb.held.size, 0);
  v.stop();
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
