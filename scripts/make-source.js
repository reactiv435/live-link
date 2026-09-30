'use strict';
// Builds dist-source/: the complete source of this exact version (a git archive of HEAD) plus SOURCE.md.
// The installer ships it in resources/source, and the release uploads the same zip next to the installer.
// Required because tiktok-live-connector and tiktok-live-proto are AGPL-3.0-only: everyone who receives the
// app must be able to get its Corresponding Source.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const out = path.join(root, 'dist-source');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
if (dirty) {
  console.error('Commit your changes first: the source zip must match the build exactly.\n' + dirty);
  process.exit(1);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
const zipName = `LIVE-Link-source-${pkg.version}.zip`;
execFileSync('git', ['archive', '--format=zip', '-o', path.join(out, zipName), 'HEAD'], { cwd: root });
fs.writeFileSync(path.join(out, 'SOURCE.md'), `# ReactivVibe LIVE Link ${pkg.version}: source code

This app is free software under the GNU Affero General Public License v3.0 (see LICENSE.txt one folder up).
It includes tiktok-live-connector and tiktok-live-proto (AGPL-3.0-only), plus MIT-licensed libraries.

- Complete source for this version: ${zipName} (in this folder), commit ${commit}.
- The same zip is published next to the installer in the site's live-link bucket (${pkg.version}/${zipName}).
- Third-party libraries are installed from npm with \`npm ci\` using the package-lock.json inside the zip.
`);
console.log(`source: ${zipName} (${commit.slice(0, 7)})`);
