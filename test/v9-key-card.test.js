'use strict';
// V9: the VTuber card's key lines (the galaxy's, the sign's), RENDERED: the real src/ui/ui.js runs in a small fake
// page made from the real src/ui/index.html (only the ids that file has exist), the card is drawn from the real
// PuppetKeys state, and the test reads what he would see. A line says "press <key>" ONLY while LIVE Link really holds
// that key; otherwise it says in plain words why the key does nothing right now (taken by another program, or not
// during a show), or there is no line at all ("No key", or his "Use these keys" switch off).
// No real key is registered: `register` / `unregister` are functions inside the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PuppetKeys, DEFAULT_KEYS, keyLine, galaxyLine } = require('../src/core/puppet-keys');

const UI = path.join(__dirname, '..', 'src', 'ui');
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const UIJS = fs.readFileSync(path.join(UI, 'ui.js'), 'utf8');

// ---------------------------------------------------------------- a fake page (just enough DOM for ui.js)
class El {
  constructor(tag, id = '', cls = '') {
    this.tagName = String(tag).toUpperCase(); this.id = id; this._cls = new Set(String(cls).split(/\s+/).filter(Boolean));
    this.children = []; this._text = ''; this.dataset = {}; this.style = {}; this.attrs = {}; this.listeners = {};
    this.value = ''; this.checked = false; this.disabled = false; this.selected = false; this.title = '';
  }
  get classList() {
    const s = this._cls;
    return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c),
      toggle: (c, on) => { const v = on === undefined ? !s.has(c) : !!on; if (v) s.add(c); else s.delete(c); return v; } };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get hidden() { return this._cls.has('hidden'); }
  append(...n) { this.children.push(...n); }
  appendChild(n) { this.children.push(n); return n; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {} blur() {} click() {} scrollIntoView() {}
  get offsetWidth() { return 0; }
}

function page() {
  const byId = new Map();
  for (const m of HTML.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
    const attrs = m[2] + ' ' + m[4];
    const cls = (/\bclass="([^"]*)"/.exec(attrs) || [])[1] || '';
    byId.set(m[3], new El(m[1], m[3], cls));
  }
  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    body: new El('body'), documentElement: new El('html'),
  };
  // the app's side (preload.js window.liveLink): every call answers "later" (never), except the VTuber card's feed
  let renderVtuber = null;
  const never = () => new Promise(() => {});
  const bridge = new Proxy({}, {
    get: (_t, name) => {
      if (name === 'onVtuber') return (fn) => { renderVtuber = fn; };
      if (typeof name === 'string' && name.startsWith('on')) return () => {};
      return never;
    },
  });
  const ctx = { document, console, Promise, URLSearchParams, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { search: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  ctx.window = { liveLink: bridge, addEventListener() {} };
  vm.createContext(ctx);
  vm.runInContext(UIJS, ctx, { filename: 'ui.js' });
  assert.equal(typeof renderVtuber, 'function', 'ui.js listens for the VTuber card');
  return { $: (id) => byId.get(id) || null, render: (puppet) => renderVtuber({ show: true, tone: 'on', title: 'VTuber', text: 'VTuber is ON.', button: 'Show VTuber', open: true, puppet }) };
}

function keyboard({ taken = [] } = {}) {
  const k = { held: new Map(), taken: new Set(taken) };
  k.register = (acc, fn) => { if (k.taken.has(acc) || k.held.has(acc)) return false; k.held.set(acc, fn); return true; };
  k.unregister = (acc) => { k.held.delete(acc); };
  return k;
}
function keysIn({ taken = [], keys = DEFAULT_KEYS, on = true, enabled = true } = {}) {
  const kb = keyboard({ taken });
  const pk = new PuppetKeys({ register: kb.register, unregister: kb.unregister, send: () => true, keys, enabled });
  pk.setWanted(on); pk.setEatWanted(on);
  return pk.getState();
}
// what he sees on one line: '' when it is hidden
const seen = (p, id) => { const el = p.$(id); assert.ok(el, `index.html has #${id}`); return el.hidden ? '' : el.textContent; };

test('the card markup: one line for the galaxy key and one for the sign key, next to the keys part', () => {
  assert.match(HTML, /<p class="vtkeys-galaxy[^"]*" id="vtkeys-galaxy"/);
  assert.match(HTML, /<p class="vtkeys-galaxy vtkeys-sign[^"]*" id="vtkeys-sign"/);
  // both start hidden: nothing shows before the app says what the keys are doing
  for (const id of ['vtkeys-galaxy', 'vtkeys-sign']) assert.ok(page().$(id).hidden, id);
});

test('the galaxy and sign lines, rendered: "press" only while the key is held; taken / not during a show say so in plain words; no line for "No key" or keys switched off', () => {
  const p = page();

  // 1. a show is on, the Mask chosen: both keys are held -> the plain instruction
  p.render(keysIn());
  assert.equal(seen(p, 'vtkeys-galaxy'), 'Galaxy: press Ctrl+Alt+9 to call the galaxy up. Press it again to send it away.');
  assert.equal(seen(p, 'vtkeys-sign'), 'Show sign: press Ctrl+Alt+0 to hide the show sign, and again to bring it back (once the sign is on in the VTuber window).');

  // 2. no show yet (or VTuber closed / another character): the keys are not held -> never "press"
  p.render(keysIn({ on: false }));
  assert.equal(seen(p, 'vtkeys-galaxy'), 'Galaxy: Ctrl+Alt+9 calls the galaxy up during your show (VTuber open with the Mask, and a song on air or your TikTok LIVE connected). Right now it does nothing.');
  assert.equal(seen(p, 'vtkeys-sign'), 'Show sign: Ctrl+Alt+0 hides and shows the show sign during your show (VTuber open with the Mask, and a song on air or your TikTok LIVE connected). Right now it does nothing.');
  assert.ok(!/press/i.test(seen(p, 'vtkeys-galaxy')) && !/press/i.test(seen(p, 'vtkeys-sign')));

  // 3. another program holds Ctrl+Alt+9 (and Ctrl+Alt+0): says so, and what to do
  p.render(keysIn({ taken: ['Control+Alt+9', 'Control+Alt+0'] }));
  assert.equal(seen(p, 'vtkeys-galaxy'), 'Galaxy: another program already uses Ctrl+Alt+9, so it does nothing here. Pick another key for Galaxy in Puppet show keys.');
  assert.equal(seen(p, 'vtkeys-sign'), 'Show sign: another program already uses Ctrl+Alt+0, so it does nothing here. Pick another key for Show sign in Puppet show keys.');
  // only one taken: the other line is the plain instruction
  p.render(keysIn({ taken: ['Control+Alt+9'] }));
  assert.match(seen(p, 'vtkeys-galaxy'), /another program already uses Ctrl\+Alt\+9/);
  assert.match(seen(p, 'vtkeys-sign'), /^Show sign: press Ctrl\+Alt\+0 /);

  // 4. the key he picked is named (a Stream Deck key, held)
  p.render(keysIn({ keys: { ...DEFAULT_KEYS, galaxy: 'F21', sign: 'F22' } }));
  assert.match(seen(p, 'vtkeys-galaxy'), /^Galaxy: press F21 /);
  assert.match(seen(p, 'vtkeys-sign'), /^Show sign: press F22 /);

  // 5. "No key": no line
  p.render(keysIn({ keys: { ...DEFAULT_KEYS, galaxy: 'off', sign: 'off' } }));
  assert.equal(seen(p, 'vtkeys-galaxy'), '');
  assert.equal(seen(p, 'vtkeys-sign'), '');

  // 6. his "Use these keys" switch off: no line (the card already says the keys are off)
  p.render(keysIn({ enabled: false }));
  assert.equal(seen(p, 'vtkeys-galaxy'), '');
  assert.equal(seen(p, 'vtkeys-sign'), '');

  // 7. no keys part at all (a VTuber that does not understand the keys): both lines hidden
  p.render(keysIn());
  p.render(null);
  assert.equal(seen(p, 'vtkeys-galaxy'), '');
  assert.equal(seen(p, 'vtkeys-sign'), '');
  assert.ok(p.$('vtkeys').hidden);

  // and back to held: the instruction again (nothing sticks from an earlier state)
  p.render(keysIn());
  assert.match(seen(p, 'vtkeys-galaxy'), /^Galaxy: press Ctrl\+Alt\+9 /);
});

test('the line itself (core/puppet-keys.js keyLine): one rule for every state; the overlay gets no line', () => {
  assert.equal(keyLine('galaxy', 'Ctrl+Alt+9', 'held'), 'Galaxy: press Ctrl+Alt+9 to call the galaxy up. Press it again to send it away.');
  assert.equal(keyLine('galaxy', 'Ctrl+Alt+9', 'idle'), keysIn({ on: false }).galaxy);
  assert.equal(keyLine('galaxy', 'Ctrl+Alt+9', 'taken'), keysIn({ taken: ['Control+Alt+9'] }).galaxy);
  assert.equal(keyLine('galaxy', 'off', 'off'), '');
  assert.equal(keyLine('galaxy', 'Ctrl+Alt+9', 'held', false), '', 'keys switched off');
  assert.equal(keyLine('galaxy', 'Ctrl+Alt+G', 'held'), '', 'not a key LIVE Link offers');
  assert.equal(keyLine('galaxy', undefined, 'held'), '');
  assert.equal(keyLine('overlay', 'F23', 'held'), '', 'the overlay has its row only');
  assert.equal(keyLine('nope', 'F23', 'held'), '');
  // with no state given, a line never claims the key works
  assert.ok(!/press/.test(keyLine('sign', 'Ctrl+Alt+0')));
  assert.equal(galaxyLine('Ctrl+Alt+9', 'held'), keyLine('galaxy', 'Ctrl+Alt+9', 'held'));
  // the state carries both lines
  const st = keysIn();
  assert.equal(st.galaxy, keyLine('galaxy', 'Ctrl+Alt+9', 'held'));
  assert.equal(st.sign, keyLine('sign', 'Ctrl+Alt+0', 'held'));
});
