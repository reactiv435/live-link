'use strict';
// V9 release: the galaxy key is DORMANT, by one switch (src/core/puppet-keys.js GALAXY_KEY_ON = false). Its VTuber part
// is not finished, and the VTuber this release vendors accepts the sign and overlay keys but not 'tap'. Off, the galaxy
// keeps its row and its place in the order (nothing renumbers: the sign stays Ctrl+Alt+0 / F22, the overlay F23), but it
// is never registered, has no usual key and no Stream Deck key, shows no card line, is not in the keys list, and a
// saved key file that names it loads cleanly and is ignored. On (test/puppet-keys-build.js loads the same file with the
// switch flipped), it is a key like the others again (all of it: test/v9-galaxy-key.test.js).
// No real key is ever registered here: `register` / `unregister` are functions inside the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const REL = require('../src/core/puppet-keys');
const { puppetKeysWith, SWITCH, FILE } = require('./puppet-keys-build');
const ON = puppetKeysWith({ galaxy: true });
const OFF = puppetKeysWith({ galaxy: false });

const GALAXY = 'Control+Alt+9';
function keyboard() {
  const k = { held: new Map(), calls: [] };
  k.register = (acc, fn) => { k.calls.push(['+', acc]); if (k.held.has(acc)) return false; k.held.set(acc, fn); return true; };
  k.unregister = (acc) => { k.calls.push(['-', acc]); k.held.delete(acc); };
  k.press = (acc) => { const fn = k.held.get(acc); return fn ? fn() : undefined; };
  return k;
}
const ids = (list) => list.map((a) => a.id);

test('the switch: ONE line in puppet-keys.js, and it is OFF in this release', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.equal((src.match(new RegExp(SWITCH.source, 'gm')) || []).length, 1);
  assert.match(src, /^const GALAXY_KEY_ON = false;/m, 'this release ships with the galaxy key dormant');
  assert.equal(REL.GALAXY_KEY_ON, false);
  assert.equal(ON.GALAXY_KEY_ON, true);
  assert.equal(OFF.GALAXY_KEY_ON, false);
  // the shipped file and the helper's "off" build are the same keys
  assert.deepEqual(ids(OFF.ACTIONS), ids(REL.ACTIONS));
  assert.deepEqual({ ...OFF.DEFAULT_KEYS }, { ...REL.DEFAULT_KEYS });
  assert.deepEqual({ ...OFF.STREAM_DECK_KEYS }, { ...REL.STREAM_DECK_KEYS });
});

test('off: the galaxy keeps its row and its place in the order; nothing renumbers (the sign Ctrl+Alt+0 / F22, the overlay F23)', () => {
  const all = ['goo', 'fire', 'melt', 'crack', 'eat', 'fight', 'vote', 'eat-now', 'galaxy', 'sign', 'overlay'];
  assert.deepEqual(ids(REL.ALL_ACTIONS), all, 'the galaxy entry is kept, ninth');
  assert.deepEqual(ids(ON.ALL_ACTIONS), all);
  assert.deepEqual(REL.ALL_ACTIONS.find((a) => a.id === 'galaxy'), ON.ACTIONS.find((a) => a.id === 'galaxy'), 'the same entry');
  assert.deepEqual(ids(REL.ACTIONS), all.filter((id) => id !== 'galaxy'), 'the keys offered: all but the galaxy');
  assert.deepEqual(ids(ON.ACTIONS), all);
  // no usual key, no Stream Deck key for the galaxy; every other key exactly where it is with the switch on
  assert.equal(Object.prototype.hasOwnProperty.call(REL.DEFAULT_KEYS, 'galaxy'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(REL.STREAM_DECK_KEYS, 'galaxy'), false);
  const { galaxy: g1, ...usual } = ON.DEFAULT_KEYS;
  const { galaxy: g2, ...deck } = ON.STREAM_DECK_KEYS;
  assert.deepEqual([g1, g2], ['Ctrl+Alt+9', 'F21'], '(the galaxy\'s keys when it is on)');
  assert.deepEqual({ ...REL.DEFAULT_KEYS }, usual);
  assert.deepEqual({ ...REL.STREAM_DECK_KEYS }, deck);
  assert.deepEqual([REL.DEFAULT_KEYS.sign, REL.STREAM_DECK_KEYS.sign, REL.DEFAULT_KEYS.overlay, REL.STREAM_DECK_KEYS.overlay], ['Ctrl+Alt+0', 'F22', 'off', 'F23']);
  assert.ok(!Object.values(REL.DEFAULT_KEYS).includes('Ctrl+Alt+9') && !Object.values(REL.STREAM_DECK_KEYS).includes('F21'), 'its keys stay unused');
});

test('off: never registered, a press sends nothing, no card line, not in the keys list; a saved key file that names it loads cleanly and is ignored', () => {
  // a saved file from the galaxy build names it (its usual key, and a Stream Deck file with F21)
  for (const saved of [{ ...ON.DEFAULT_KEYS }, { ...ON.STREAM_DECK_KEYS }, { galaxy: 'F21' }, { galaxy: 'nonsense' }, { galaxy: 42 }]) {
    assert.doesNotThrow(() => REL.cleanKeys(saved));
    const keys = REL.cleanKeys(saved);
    assert.equal(Object.prototype.hasOwnProperty.call(keys, 'galaxy'), false, JSON.stringify(saved));
    assert.deepEqual(Object.keys(keys), ids(REL.ACTIONS));
    const kb = keyboard(), sent = [];
    let pk;
    assert.doesNotThrow(() => { pk = new REL.PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => { sent.push([a, n]); return true; }, keys: saved }); });
    pk.setWanted(true); pk.setEatWanted(true);
    const registered = kb.calls.filter((c) => c[0] === '+').map((c) => c[1]);
    assert.ok(!registered.includes(GALAXY) && !registered.includes('F21'), `the galaxy's key is never registered (${JSON.stringify(saved)})`);
    assert.equal(pk.press('galaxy'), false);
    assert.ok(!sent.some((s) => s[0] === 'tap'), 'nothing is ever sent for it');
    const st = pk.getState();
    assert.equal(st.galaxy, '', 'no card line');
    assert.ok(!st.rows.some((r) => r.id === 'galaxy'), 'not in the keys list');
    assert.equal(st.rows.length, 10);
    assert.ok(st.sign === '' || /^Show sign: /.test(st.sign));
    pk.release();
  }
  // the card cannot give it a key either
  assert.deepEqual(REL.setKey(REL.DEFAULT_KEYS, 'galaxy', 'F24'), { ok: false, why: 'unknown' });
  assert.deepEqual(REL.setKey(REL.DEFAULT_KEYS, 'galaxy', 'Ctrl+Alt+9'), { ok: false, why: 'unknown' });
  assert.equal(REL.keyLine('galaxy', 'Ctrl+Alt+9', 'held'), '');
  // the usual and Stream Deck presets (main.js puppet:preset) hold no galaxy key
  for (const preset of [REL.DEFAULT_KEYS, REL.STREAM_DECK_KEYS]) {
    const kb = keyboard();
    const pk = new REL.PuppetKeys({ register: kb.register, unregister: kb.unregister, send: () => true, keys: { ...preset } });
    pk.setWanted(true); pk.setEatWanted(true);
    assert.equal(kb.held.size, Object.values(preset).filter((k) => k !== 'off').length);
    assert.ok(!kb.held.has(GALAXY) && !kb.held.has('F21'));
    pk.release();
  }
  // the sign and the overlay still work on their keys
  const kb = keyboard(), sent = [];
  const pk = new REL.PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => { sent.push([a, n]); return true; }, keys: { ...REL.DEFAULT_KEYS, overlay: 'F23' } });
  pk.setEatWanted(true);
  assert.deepEqual([...kb.held.keys()].sort(), ['Control+Alt+0', 'Control+Alt+8', 'F23']);
  kb.press('Control+Alt+0'); kb.press('F23');
  assert.deepEqual(sent, [['sign', ''], ['overlay', '']]);
  assert.equal(pk.getState().sign, 'Show sign: press Ctrl+Alt+0 to hide the show sign, and again to bring it back (once the sign is on in the VTuber window).');
  pk.release();
});

test('on: the galaxy is a key like the others again (Ctrl+Alt+9 / F21, registered, one press = { action: "tap", name: "galaxy" }, its card line and row)', () => {
  const kb = keyboard(), sent = [];
  const pk = new ON.PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => { sent.push([a, n]); return true; } });
  pk.setEatWanted(true);
  assert.ok(kb.held.has(GALAXY));
  assert.equal(kb.press(GALAXY), true);
  assert.deepEqual(sent, [['tap', 'galaxy']]);
  const st = pk.getState();
  assert.equal(st.galaxy, 'Galaxy: press Ctrl+Alt+9 to call the galaxy up. Press it again to send it away.');
  assert.equal(st.rows.length, 11);
  assert.equal(st.rows[8].id, 'galaxy');
  assert.equal(ON.setKey(ON.DEFAULT_KEYS, 'galaxy', 'F24').ok, true);
  assert.equal(ON.cleanKeys({ galaxy: 'F21' }).galaxy, 'F21', 'a saved galaxy key is his again');
  pk.release();
});

test('the release gate (test/v8-vendor.test.js) checks every key that is ON: sign and overlay now, the galaxy once the switch flips', () => {
  const gate = (PK) => PK.ACTIONS.map((a) => `${a.action}${a.name ? ' ' + a.name : ''}`);
  assert.ok(gate(REL).includes('sign') && gate(REL).includes('overlay'));
  assert.ok(!gate(REL).includes('tap galaxy'), 'off: the galaxy is not in the gate');
  assert.ok(gate(ON).includes('tap galaxy'), 'on: the galaxy joins the gate');
  const vendor = fs.readFileSync(require('path').join(__dirname, 'v8-vendor.test.js'), 'utf8');
  assert.match(vendor, /const \{ ACTIONS, GALAXY_KEY_ON \} = require\('\.\.\/src\/core\/puppet-keys'\);/, 'the gate reads the keys that are on from puppet-keys.js');
  assert.match(vendor, /JOINS THIS GATE BY ITSELF when that switch flips/);
});
