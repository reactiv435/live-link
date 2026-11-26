'use strict';
// V9 (the show sign + the live overlay): two more keys that work in any window, after the galaxy's.
//  * "Show sign: show / hide" (id 'sign'): Ctrl+Alt+0, set by hand (the numbering Ctrl+Alt+(i+1) would give it
//    "Ctrl+Alt+10", not a key), `always` like EAT IT and the galaxy, Stream Deck F22.
//  * "Live overlay: show / hide" (id 'overlay'): NO keyboard key by default ('off'; he can give it one), Stream Deck F23.
// Each press = the existing control message { v: 2, type: 'control', action: 'sign' | 'overlay', name: '', at }
// (the VTuber's mask-wire.js cleanControl takes both; review/V9-SIGN-NOTES.md "What LIVE Link must change").
// No real key is ever registered here: `register` / `unregister` are functions inside the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PuppetKeys, puppetWanted, eatWanted, ACTIONS, KEY_CHOICES, DEFAULT_KEYS, STREAM_DECK_KEYS, cleanKeys, setKey } = require('../src/core/puppet-keys');
const { buildControl, CONTROL_ACTIONS } = require('../src/core/vtuber-link');

const SIGN = 'Control+Alt+0';

function keyboard({ taken = [] } = {}) {
  const k = { held: new Map(), calls: [], taken: new Set(taken) };
  k.register = (acc, fn) => { k.calls.push(['+', acc]); if (k.taken.has(acc) || k.held.has(acc)) return false; k.held.set(acc, fn); return true; };
  k.unregister = (acc) => { k.calls.push(['-', acc]); k.held.delete(acc); };
  k.press = (acc) => { const fn = k.held.get(acc); return fn ? fn() : undefined; };
  return k;
}

test('sign + overlay: the two control messages are exactly { v: 2, type: "control", action: "sign" | "overlay", name: "", at }', () => {
  assert.ok(CONTROL_ACTIONS.includes('sign'));
  assert.ok(CONTROL_ACTIONS.includes('overlay'));
  assert.deepEqual(buildControl('sign', '', 77), { v: 2, type: 'control', action: 'sign', name: '', at: 77 });
  assert.deepEqual(buildControl('overlay', '', 77), { v: 2, type: 'control', action: 'overlay', name: '', at: 77 });
  // a name is never carried for either (the VTuber reads only the action)
  assert.deepEqual(buildControl('sign', 'anything', 77), { v: 2, type: 'control', action: 'sign', name: '', at: 77 });
  assert.deepEqual(buildControl('overlay', 'galaxy', 77), { v: 2, type: 'control', action: 'overlay', name: '', at: 77 });
  // the old name of the overlay (the VTuber's first build called it "hype") is not an action: the VTuber refuses it too
  assert.equal(buildControl('hype', '', 77), null);
  assert.equal(buildControl('Sign', '', 77), null);
  // the older actions are as they were
  assert.deepEqual(buildControl('tap', 'galaxy', 77), { v: 2, type: 'control', action: 'tap', name: 'galaxy', at: 77 });
  assert.deepEqual(buildControl('eat', 'ignored', 77), { v: 2, type: 'control', action: 'eat', name: '', at: 77 });
});

test('sign + overlay: rows 10 and 11, after the galaxy (galaxy, sign, overlay); sign on Ctrl+Alt+0 set by hand, overlay with no key; Stream Deck F22 / F23; no clash with any LIVE Link key', () => {
  assert.equal(ACTIONS.length, 11);
  assert.deepEqual(ACTIONS.slice(8).map((a) => a.id), ['galaxy', 'sign', 'overlay'], 'in this order, after the eight and the galaxy: no saved key changes its row');
  const sign = ACTIONS.find((a) => a.id === 'sign'), overlay = ACTIONS.find((a) => a.id === 'overlay');
  assert.deepEqual([sign.action, sign.name, sign.label, sign.always], ['sign', '', 'Show sign: show / hide', true]);
  assert.deepEqual([overlay.action, overlay.name, overlay.label, overlay.always], ['overlay', '', 'Live overlay: show / hide', true]);
  // the defaults: 1 ... 9 as before, the sign on 0 (not "Ctrl+Alt+10"), the overlay with no keyboard key
  assert.deepEqual(DEFAULT_KEYS, { goo: 'Ctrl+Alt+1', fire: 'Ctrl+Alt+2', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', 'eat-now': 'Ctrl+Alt+8', galaxy: 'Ctrl+Alt+9', sign: 'Ctrl+Alt+0', overlay: 'off' });
  for (const k of Object.values(DEFAULT_KEYS)) assert.ok(Object.prototype.hasOwnProperty.call(KEY_CHOICES, k), `${k} is a key LIVE Link offers`);
  assert.equal(KEY_CHOICES[DEFAULT_KEYS.sign], SIGN);
  assert.equal(Object.keys(KEY_CHOICES).length, 1 + 10 + 12, 'the list of keys he can pick from did not change');
  // ten real keys, all different (the overlay's 'off' is not a key)
  const real = Object.values(DEFAULT_KEYS).filter((k) => k !== 'off').map((k) => KEY_CHOICES[k]);
  assert.equal(real.length, 10);
  assert.equal(new Set(real).size, 10, 'ten different keys');
  // the Stream Deck preset: F13 ... F23, one each, the sign F22 and the overlay F23
  assert.deepEqual(Object.values(STREAM_DECK_KEYS), ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23']);
  assert.deepEqual([STREAM_DECK_KEYS.galaxy, STREAM_DECK_KEYS.sign, STREAM_DECK_KEYS.overlay], ['F21', 'F22', 'F23']);
  for (const k of Object.values(STREAM_DECK_KEYS)) assert.ok(Object.prototype.hasOwnProperty.call(KEY_CHOICES, k));
  // both presets pass the cleaner unchanged (no key used twice inside a preset)
  assert.deepEqual(cleanKeys(DEFAULT_KEYS), { ...DEFAULT_KEYS });
  assert.deepEqual(cleanKeys(STREAM_DECK_KEYS), { ...STREAM_DECK_KEYS });
  // not the "Clip that" key (main.js MOMENT_KEYS: F8 / F9 / F10 / Ctrl+Shift+M)
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const moment = /const MOMENT_KEYS = \{([^}]*)\}/.exec(main)[1];
  for (const acc of [...real, ...Object.values(STREAM_DECK_KEYS)]) assert.ok(!moment.includes(`'${acc}'`), acc);
  // the three keys that do not follow the Puppet show switch
  assert.equal(ACTIONS.filter((a) => a.always).map((a) => a.id).join(), 'eat-now,galaxy,sign,overlay');
});

test('sign + overlay: a key file saved by 2.3.1 (eight keys) loads cleanly: the new actions get their defaults, nothing he assigned changes', () => {
  // 2.3.1 as it shipped, the usual keys
  const usual231 = { goo: 'Ctrl+Alt+1', fire: 'Ctrl+Alt+2', melt: 'Ctrl+Alt+3', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', 'eat-now': 'Ctrl+Alt+8' };
  assert.deepEqual(cleanKeys(usual231), { ...usual231, galaxy: 'Ctrl+Alt+9', sign: 'Ctrl+Alt+0', overlay: 'off' });
  // 2.3.1 with the Stream Deck preset: his F13 ... F20 stay; the new ones get the usual defaults (he can press the preset again)
  const deck231 = { goo: 'F13', fire: 'F14', melt: 'F15', crack: 'F16', eat: 'F17', fight: 'F18', vote: 'F19', 'eat-now': 'F20' };
  assert.deepEqual(cleanKeys(deck231), { ...deck231, galaxy: 'Ctrl+Alt+9', sign: 'Ctrl+Alt+0', overlay: 'off' });
  // keys he moved by hand, one set to "No key": all as he left them
  const mine = { goo: 'F13', fire: 'Ctrl+Alt+2', melt: 'off', crack: 'Ctrl+Alt+4', eat: 'F24', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', 'eat-now': 'F22' };
  assert.deepEqual(cleanKeys(mine), { ...mine, galaxy: 'Ctrl+Alt+9', sign: 'Ctrl+Alt+0', overlay: 'off' });
  // he had already given Ctrl+Alt+0 to an action: that one keeps it, the sign starts with no key (as EAT IT and the galaxy did)
  const zero = { ...usual231, 'eat-now': 'Ctrl+Alt+0' };
  assert.deepEqual(cleanKeys(zero), { ...zero, galaxy: 'Ctrl+Alt+9', sign: 'off', overlay: 'off' });
  // a file from the galaxy build (nine keys): the same
  assert.deepEqual(cleanKeys({ ...usual231, galaxy: 'F21' }), { ...usual231, galaxy: 'F21', sign: 'Ctrl+Alt+0', overlay: 'off' });
  // a file written after this build keeps what he picked for the two new ones
  assert.deepEqual(cleanKeys({ ...DEFAULT_KEYS, sign: 'F22', overlay: 'F23' }), { ...DEFAULT_KEYS, sign: 'F22', overlay: 'F23' });
  assert.deepEqual(cleanKeys({ ...DEFAULT_KEYS, sign: 'off', overlay: 'Ctrl+Alt+0' }), { ...DEFAULT_KEYS, sign: 'off', overlay: 'Ctrl+Alt+0' });
  // a broken value for a new action falls back to its default; nothing else moves
  assert.deepEqual(cleanKeys({ ...usual231, sign: 'Ctrl+Alt+10', overlay: 42 }), { ...usual231, galaxy: 'Ctrl+Alt+9', sign: 'Ctrl+Alt+0', overlay: 'off' });
  // changing them in the card
  assert.equal(setKey(DEFAULT_KEYS, 'overlay', 'F23').keys.overlay, 'F23');
  assert.deepEqual(setKey(DEFAULT_KEYS, 'overlay', 'Ctrl+Alt+0'), { ok: false, why: 'taken', by: 'Show sign: show / hide' });
  assert.deepEqual(setKey(DEFAULT_KEYS, 'sign', 'Ctrl+Alt+9'), { ok: false, why: 'taken', by: 'Galaxy' });
  assert.equal(setKey(DEFAULT_KEYS, 'sign', 'off').keys.sign, 'off');
  assert.deepEqual(setKey(DEFAULT_KEYS, 'sign', 'Ctrl+Alt+10'), { ok: false, why: 'unknown' });
});

test('sign + overlay: held with EAT IT\'s rule (the Mask chosen, a show plausible, Puppet show switch on or off); a press sends the control message; the overlay is held only once he gives it a key', () => {
  const kb = keyboard();
  const sent = [];
  let t = 10000;
  const pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => { sent.push([a, n]); return true; }, mono: () => t });
  const sync = (k) => { pk.setWanted(puppetWanted(k)); pk.setEatWanted(eatWanted(k)); };
  const mask = { canControl: true, enabled: true, inApp: true, vt: { character: 'mask', puppet: true }, show: true };

  // no show plausible: nothing held
  sync({ ...mask, show: false });
  assert.equal(kb.held.size, 0);
  assert.equal(pk.press('sign'), false);
  // a show: ten keys held (the overlay has none by default), the sign among them
  sync(mask);
  assert.equal(kb.held.size, 10);
  assert.equal(kb.held.has(SIGN), true);
  const st = () => Object.fromEntries(pk.getState().rows.map((r) => [r.id, r.state]));
  assert.deepEqual([st().sign, st().overlay], ['held', 'off']);
  assert.equal(kb.press(SIGN), true);
  assert.deepEqual(sent, [['sign', '']]);
  assert.equal(pk.press('overlay'), false, 'no key, nothing held: nothing sent');
  // the Puppet show switch off: EAT IT, the galaxy and the sign stay
  sync({ ...mask, vt: { character: 'mask', puppet: false } });
  assert.deepEqual([...kb.held.keys()].sort(), ['Control+Alt+0', 'Control+Alt+8', 'Control+Alt+9']);
  // he gives the overlay a key (F23): held at once, with the same rule
  pk.setKeys({ ...DEFAULT_KEYS, overlay: 'F23' });
  assert.deepEqual([...kb.held.keys()].sort(), ['Control+Alt+0', 'Control+Alt+8', 'Control+Alt+9', 'F23']);
  t += 1000;
  assert.equal(kb.press('F23'), true);
  assert.deepEqual(sent[sent.length - 1], ['overlay', '']);
  // a held-down key sends at most 4 a second
  const n = sent.length;
  for (let i = 0; i < 30; i++) { t += 33; kb.press(SIGN); }
  assert.ok(sent.length - n >= 3 && sent.length - n <= 5, `${sent.length - n}`);
  // Ryo: none; the Mask again: back; quit: every key given back
  sync({ ...mask, vt: { character: 'ryo' } });
  assert.equal(kb.held.size, 0);
  sync(mask);
  assert.equal(kb.held.size, 11);
  pk.release();
  assert.equal(kb.held.size, 0);
  assert.equal(kb.calls.filter((c) => c[0] === '+').length, kb.calls.filter((c) => c[0] === '-').length, 'every key taken was given back');

  // Ctrl+Alt+0 held by another program: "taken" on the sign's row only, the rest work
  const kb2 = keyboard({ taken: [SIGN] }), logs = [];
  const pk2 = new PuppetKeys({ register: kb2.register, unregister: kb2.unregister, send: () => true, log: (l, m) => logs.push(`${l} ${m}`) });
  pk2.setWanted(true); pk2.setEatWanted(true);
  assert.deepEqual(pk2.getState().rows.filter((r) => r.state !== 'held').map((r) => [r.id, r.state]), [['sign', 'taken'], ['overlay', 'off']]);
  assert.deepEqual(logs, ['warn puppet key Ctrl+Alt+0 (Show sign: show / hide) is taken by another program']);
  pk2.release();
});

test('sign + overlay: the card\'s preset buttons name the new ranges', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
  assert.match(html, />Usual keys: Ctrl\+Alt\+1 to 9 and 0</);
  assert.match(html, />Stream Deck keys: F13 to F23</);
});
