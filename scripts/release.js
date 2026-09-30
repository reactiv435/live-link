'use strict';
// After `electron-builder`, writes dist/latest.json for the site's public `live-link` bucket:
//   { version, file, sha256, size, source_file, released_at }   (paths inside the PRIVATE live-link bucket)
// Upload dist/LIVE-Link-Setup-<v>.exe, dist-source/LIVE-Link-source-<v>.zip and dist/latest.json to the bucket.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const exe = `LIVE-Link-Setup-${pkg.version}.exe`;
const exePath = path.join(root, 'dist', exe);
if (!fs.existsSync(exePath)) { console.error(`missing ${exePath}`); process.exit(1); }
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
const latest = {
  // The site's `live-link` bucket is PRIVATE: these are paths inside it. The site hands the app a short-lived
  // signed link (live-link-config `latest.download_url`) and the dashboard does the same for downloads.
  version: pkg.version,
  file: `${pkg.version}/${exe}`,
  sha256,
  size: fs.statSync(exePath).size,
  source_file: `${pkg.version}/LIVE-Link-source-${pkg.version}.zip`,
  released_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'dist', 'latest.json'), JSON.stringify(latest, null, 2));
console.log(JSON.stringify(latest, null, 2));
console.log(`size: ${(fs.statSync(exePath).size / 1048576).toFixed(1)} MB`);
