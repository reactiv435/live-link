'use strict';
// V9: the galaxy key's release switch (src/core/puppet-keys.js GALAXY_KEY_ON). The tests of the galaxy key itself load
// puppet-keys.js with the switch ON, from the same source file with only that one line changed, so the galaxy stays
// tested for the day the switch flips. Every other test checks the file as it ships. (Not a *.test.js file: a helper.)
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FILE = path.join(__dirname, '..', 'src', 'core', 'puppet-keys.js');
const SWITCH = /^const GALAXY_KEY_ON = (true|false);/m;

/** puppet-keys.js with the galaxy switch set to `galaxy` (a fresh module; the shipped one is not touched) */
function puppetKeysWith({ galaxy }) {
  const src = fs.readFileSync(FILE, 'utf8');
  const found = src.match(new RegExp(SWITCH.source, 'gm')) || [];
  if (found.length !== 1) throw new Error(`puppet-keys.js must have exactly one "const GALAXY_KEY_ON = true|false;" line (found ${found.length})`);
  const mod = new Module(FILE, module);
  mod.filename = FILE;
  mod.paths = Module._nodeModulePaths(path.dirname(FILE));
  mod._compile(src.replace(SWITCH, `const GALAXY_KEY_ON = ${galaxy ? 'true' : 'false'};`), FILE);
  return mod.exports;
}

module.exports = { puppetKeysWith, SWITCH, FILE };
