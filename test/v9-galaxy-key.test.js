'use strict';
// V9 (the galaxy): one more key that works in any window. One press = { v: 2, type: 'control', action: 'tap',
// name: 'galaxy' }: the Mask calls the galaxy up; the next press sends it away (the VTuber keeps count, not LIVE Link).
// It follows EAT IT's rule: held only while a v2 VTuber is listening with the Mask chosen AND a show is plausible
// (2.3.1 L-6). No real key is ever registered here: `register` / `unregister` are functions inside the test.
// V9 release: the galaxy key is DORMANT (puppet-keys.js GALAXY_KEY_ON = false). These tests load puppet-keys.js with
// the switch ON, so the galaxy is ready when it flips; the dormant galaxy is tested in test/v9-galaxy-switch.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const PK = require('./puppet-keys-build').puppetKeysWith({ galaxy: true });
const { PuppetKeys, puppetWanted, eatWanted, ACTIONS, KEY_CHOICES, DEFAULT_KEYS, STREAM_DECK_KEYS, cleanKeys, setKey } = PK;
const { VtuberLink, buildControl, CONTROL_ACTIONS } = require('../src/core/vtuber-link');

const GALAXY = 'Control+Alt+9';

function keyboard({ taken = [] } = {}) {
  const k = { held: new Map(), calls: [], taken: new Set(taken) };
  k.register = (acc, fn) => { k.calls.push(['+', acc]); if (k.taken.has(acc) || k.held.has(acc)) return false; k.held.set(acc, fn); return true; };
  k.unregister = (acc) => { k.calls.push(['-', acc]); k.held.delete(acc); };
  k.press = (acc) => { const fn = k.held.get(acc); return fn ? fn() : undefined; };
  return k;
}

test('galaxy: the control message is exactly { v: 2, type: "control", action: "tap", name: "galaxy", at }', () => {
  assert.ok(CONTROL_ACTIONS.includes('tap'));
  assert.deepEqual(buildControl('tap', 'galaxy', 77), { v: 2, type: 'control', action: 'tap', name: 'galaxy', at: 77 });
  for (const n of ['', undefined, null, 'goo', 'Galaxy', '__proto__', 'toString']) assert.equal(buildControl('tap', n, 77), null, `tap/${n}`);
  // the older actions are as they were
  assert.deepEqual(buildControl('eat', 'ignored', 77), { v: 2, type: 'control', action: 'eat', name: '', at: 77 });
  assert.deepEqual(buildControl('puppet', 'goo', 77), { v: 2, type: 'control', action: 'puppet', name: 'goo', at: 77 });
});

test('galaxy: a ninth row "Galaxy" on Ctrl+Alt+9, the next key in the row (Stream Deck: F21); it clashes with no other LIVE Link key and moves none of the eight', () => {
  const row = ACTIONS.find((a) => a.id === 'galaxy');
  assert.deepEqual([row.action, row.name, row.label, row.always], ['tap', 'galaxy', 'Galaxy', true]);
  assert.equal(ACTIONS.length, 11, '(V9: + the sign and the live overlay after it, test/v9-sign-keys.test.js)');
  assert.equal(ACTIONS[8].id, 'galaxy', 'after the eight: no saved key changes its row');
  assert.equal(DEFAULT_KEYS.galaxy, 'Ctrl+Alt+9');
  assert.equal(KEY_CHOICES['Ctrl+Alt+9'], GALAXY);
  // not Ctrl+Alt+G: Google's Gemini app takes that key in every window on Windows, and Figma uses it; it is not offered
  assert.equal(Object.prototype.hasOwnProperty.call(KEY_CHOICES, 'Ctrl+Alt+G'), false);
  assert.equal(Object.keys(KEY_CHOICES).length, 1 + 10 + 12, 'the list of keys he can pick from did not change');
  assert.equal(STREAM_DECK_KEYS.galaxy, 'F21');
  assert.deepEqual(Object.values(DEFAULT_KEYS).slice(0, 8), ['Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Alt+4', 'Ctrl+Alt+5', 'Ctrl+Alt+6', 'Ctrl+Alt+7', 'Ctrl+Alt+8']);
  assert.equal(new Set(Object.values(DEFAULT_KEYS).filter((k) => k !== 'off').map((k) => KEY_CHOICES[k])).size, 10, 'ten different keys (V9: + the sign\'s Ctrl+Alt+0; the live overlay has none)');
  assert.equal(new Set(Object.values(STREAM_DECK_KEYS)).size, 11);
  // not the "Clip that" key (main.js MOMENT_KEYS)
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const moment = /const MOMENT_KEYS = \{([^}]*)\}/.exec(main)[1];
  assert.ok(!moment.includes(`'${GALAXY}'`));
  // keys saved by 2.3.1 (eight of them): the galaxy gets Ctrl+Alt+9 and the eight stay where he put them
  const saved = { goo: 'F13', fire: 'Ctrl+Alt+2', melt: 'off', crack: 'Ctrl+Alt+4', eat: 'Ctrl+Alt+5', fight: 'Ctrl+Alt+6', vote: 'Ctrl+Alt+7', 'eat-now': 'Ctrl+Alt+0' };
  assert.deepEqual(cleanKeys(saved), { ...saved, galaxy: 'Ctrl+Alt+9', sign: 'off', overlay: 'off' }, '(V9: his EAT IT keeps Ctrl+Alt+0, so the sign starts with no key)');
  // he had already given Ctrl+Alt+9 to another action: that one keeps it, the galaxy starts with no key (as EAT IT did in 2.3.1)
  assert.deepEqual([cleanKeys({ vote: 'Ctrl+Alt+9' }).vote, cleanKeys({ vote: 'Ctrl+Alt+9' }).galaxy], ['Ctrl+Alt+9', 'off']);
  assert.deepEqual(setKey(DEFAULT_KEYS, 'galaxy', 'Ctrl+Alt+8'), { ok: false, why: 'taken', by: 'Eat it (the song)' });
  assert.equal(setKey(DEFAULT_KEYS, 'galaxy', 'F24').keys.galaxy, 'F24');
  assert.equal(setKey(DEFAULT_KEYS, 'galaxy', 'off').keys.galaxy, 'off');
});

test('galaxy: the key sends the control message, and ONLY in the show-plausible window (2.3.1 L-6), with the Mask, Puppet show switch on or off', () => {
  // main.js syncPuppetKeys, as it is written there
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /show: !!\(showFeed && showFeed\.plausible\)/, 'main.js passes "a show is plausible" to the key rules');
  assert.match(main, /puppetKeys\.setEatWanted\(eatWanted\(k\)\)/);

  const link = new EventEmitter(); link.state = { status: 'idle' };
  const got = [];
  const fn = Object.assign((ev) => { got.push(ev); return true; }, { v: 2 });
  const kb = keyboard();
  const world = { running: true, vt: { character: 'mask', puppet: true }, show: false };
  let pk = null, v = null;
  const sync = () => {
    if (!pk) return;
    const k = { canControl: v.canControl, enabled: true, inApp: world.running, vt: world.vt, show: world.show };
    pk.setWanted(puppetWanted(k)); pk.setEatWanted(eatWanted(k));
  };
  v = new VtuberLink({ http: false, direct: () => (world.running ? fn : null), onChange: sync, now: () => 1234 }).attach(link);
  let t = 10000;
  pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: (a, n) => v.sendControl(a, n), mono: () => t });
  sync();

  // VTuber open with the Mask, but no show: the key is not held, and a press that still arrives sends nothing
  assert.equal(kb.held.has(GALAXY), false, 'no show plausible: Ctrl+Alt+9 stays with the other programs');
  assert.equal(kb.calls.length, 0);
  assert.equal(pk.press('galaxy'), false);
  assert.equal(got.length, 0);

  // a show is plausible: held; one press = one message
  world.show = true; sync();
  assert.equal(kb.held.has(GALAXY), true);
  assert.equal(pk.getState().rows.find((r) => r.id === 'galaxy').state, 'held');
  assert.equal(kb.press(GALAXY), true);
  assert.deepEqual(got, [{ v: 2, type: 'control', action: 'tap', name: 'galaxy', at: got[0].at }]);
  assert.ok(Number.isInteger(got[0].at));
  // the second press (send it away) is the same message; a held-down key sends at most 4 a second
  t += 1000; kb.press(GALAXY);
  assert.deepEqual(got.map((e) => [e.action, e.name]), [['tap', 'galaxy'], ['tap', 'galaxy']]);
  for (let i = 0; i < 30; i++) { t += 33; kb.press(GALAXY); }
  assert.ok(got.length >= 5 && got.length <= 7, `${got.length}`);
  t += 1000;

  // the Puppet show switch off: the galaxy key stays (as EAT IT does, and V9's sign key), the seven puppet keys go back
  world.vt = { character: 'mask', puppet: false }; sync();
  assert.deepEqual([...kb.held.keys()].sort(), ['Control+Alt+0', 'Control+Alt+8', GALAXY].sort());
  world.vt = { character: 'mask', puppet: true }; sync();
  assert.equal(kb.held.size, 10, '(the live overlay has no key by default)');

  // the window closes (30 minutes after the last song, no LIVE): given back; the stale fn sends nothing
  const stale = kb.held.get(GALAXY);
  const n = got.length;
  world.show = false; sync();
  assert.equal(kb.held.size, 0, 'the show is over: every key is back with the other programs');
  assert.equal(stale(), false);
  assert.equal(got.length, n);

  // another character: not held, show or not
  world.show = true; world.vt = { character: 'ryo' }; sync();
  assert.equal(kb.held.has(GALAXY), false, 'Ryo has no galaxy');
  world.vt = { character: 'mask' }; sync();
  assert.equal(kb.held.has(GALAXY), true);
  // the host's own "Use these keys" switch, "No key", VTuber closed, quit
  pk.setEnabled(false); assert.equal(kb.held.size, 0);
  pk.setEnabled(true); assert.equal(kb.held.has(GALAXY), true);
  pk.setKeys({ ...DEFAULT_KEYS, galaxy: 'off' }); assert.equal(kb.held.has(GALAXY), false);
  pk.setKeys({ ...DEFAULT_KEYS }); assert.equal(kb.held.has(GALAXY), true);
  world.running = false; sync();
  assert.equal(kb.held.size, 0, 'VTuber closed');
  world.running = true; sync(); pk.release();
  assert.equal(kb.held.size, 0);
  assert.equal(kb.calls.filter((c) => c[0] === '+').length, kb.calls.filter((c) => c[0] === '-').length, 'every key taken was given back');
  v.stop();

  // Ctrl+Alt+9 held by another program: shown on its row only, the rest work
  const kb2 = keyboard({ taken: [GALAXY] }), logs = [];
  const pk2 = new PuppetKeys({ register: kb2.register, unregister: kb2.unregister, send: () => true, log: (l, m) => logs.push(`${l} ${m}`) });
  pk2.setWanted(true); pk2.setEatWanted(true);
  assert.deepEqual(pk2.getState().rows.filter((r) => r.state !== 'held').map((r) => [r.id, r.state]), [['galaxy', 'taken'], ['overlay', 'off']]);
  assert.deepEqual(logs, ['warn puppet key Ctrl+Alt+9 (Galaxy) is taken by another program']);
  pk2.release();
});

test('galaxy: the VTuber card has a line that names the key, in plain words; it follows the key he picked, and says "press" only while the key is held', () => {
  assert.equal(PK.galaxyLine('Ctrl+Alt+9', 'held'), 'Galaxy: press Ctrl+Alt+9 to call the galaxy up. Press it again to send it away.');
  assert.equal(PK.galaxyLine('F21', 'held'), 'Galaxy: press F21 to call the galaxy up. Press it again to send it away.');
  assert.equal(PK.galaxyLine('off', 'off'), '', '"No key": no line');
  assert.equal(PK.galaxyLine(undefined), '');
  assert.equal(PK.galaxyLine('Ctrl+Alt+G', 'held'), '', 'not a key LIVE Link offers');
  const kb = keyboard();
  const pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: () => true });
  // V9: not held yet (no show): the line does not say "press" (the card is RENDERED in each state in test/v9-key-card.test.js)
  assert.equal(pk.getState().galaxy, PK.galaxyLine('Ctrl+Alt+9', 'idle'));
  assert.ok(!/press/.test(pk.getState().galaxy));
  pk.setEatWanted(true);
  assert.equal(pk.getState().galaxy, PK.galaxyLine('Ctrl+Alt+9', 'held'));
  pk.setKeys({ ...DEFAULT_KEYS, galaxy: 'F21' });
  assert.equal(pk.getState().galaxy, PK.galaxyLine('F21', 'held'));
  pk.setKeys({ ...DEFAULT_KEYS, galaxy: 'off' });
  assert.equal(pk.getState().galaxy, '');
  pk.release();
});
