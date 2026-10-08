#!/usr/bin/env node
'use strict';
// Mac release files, run on a Mac after `electron-builder --mac --universal --dir` and the ad-hoc signature
// (see .github/workflows/mac.yml):
//   dist-mac/LIVE-Link-<v>-mac.dmg   drag-to-Applications disk image (what hosts download)
//   dist-mac/LIVE-Link-<v>-mac.zip   the same app zipped (ditto keeps the signature and symlinks intact)
//   dist-mac/latest-mac.json         { version, file, sha256, size, zip_file, zip_sha256, zip_size, released_at }
//   dist-mac/SHA256SUMS.txt
// Paths inside latest-mac.json are paths in the PRIVATE live-link bucket (<version>/...), like latest.json for Windows.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const v = pkg.version;
const appDir = path.join(ROOT, 'dist', 'mac-universal');
const app = fs.readdirSync(appDir).find((f) => f.endsWith('.app'));
if (!app) throw new Error(`no .app in ${appDir}`);
const appPath = path.join(appDir, app);
const out = path.join(ROOT, 'dist-mac');
fs.mkdirSync(out, { recursive: true });

const dmgName = `LIVE-Link-${v}-mac.dmg`, zipName = `LIVE-Link-${v}-mac.zip`;
const dmg = path.join(out, dmgName), zip = path.join(out, zipName);
for (const f of [dmg, zip]) fs.rmSync(f, { force: true });

// zip: ditto is the Mac-native way that keeps the code signature, permissions and framework symlinks.
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip], { stdio: 'inherit' });

// dmg: the app plus an Applications shortcut, so the host just drags it across.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-dmg-'));
execFileSync('ditto', [appPath, path.join(stage, app)], { stdio: 'inherit' });
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
// hdiutil is occasionally "Resource busy" on CI Macs: try up to three times.
for (let attempt = 1; ; attempt++) {
  try { execFileSync('hdiutil', ['create', '-volname', 'ReactivVibe LIVE Link', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' }); break; }
  catch (e) { if (attempt >= 3) throw e; console.log(`hdiutil failed (attempt ${attempt}), retrying`); execFileSync('sleep', ['5']); }
}
fs.rmSync(stage, { recursive: true, force: true });

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const latest = {
  version: v,
  file: `${v}/${dmgName}`, sha256: hash(dmg), size: fs.statSync(dmg).size,
  zip_file: `${v}/${zipName}`, zip_sha256: hash(zip), zip_size: fs.statSync(zip).size,
  source_file: `${v}/LIVE-Link-source-${v}.zip`,   // the same AGPL source zip the Windows release uploads
  released_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, 'latest-mac.json'), JSON.stringify(latest, null, 2));
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${latest.sha256}  ${dmgName}\n${latest.zip_sha256}  ${zipName}\n`);
console.log(JSON.stringify(latest, null, 2));
