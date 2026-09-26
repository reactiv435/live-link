'use strict';
// After `electron-builder`, writes dist/latest.json for the site's public `live-link` bucket:
//   { version, url, sha256, source_url, released_at }
// Upload dist/LIVE-Link-Setup-<v>.exe, dist-source/LIVE-Link-source-<v>.zip and dist/latest.json to the bucket.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const BUCKET = 'https://bxiejoktoknybpraxebm.supabase.co/storage/v1/object/public/live-link/';
const exe = `LIVE-Link-Setup-${pkg.version}.exe`;
const exePath = path.join(root, 'dist', exe);
if (!fs.existsSync(exePath)) { console.error(`missing ${exePath}`); process.exit(1); }
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
const latest = {
  version: pkg.version,
  url: BUCKET + exe,
  sha256,
  source_url: BUCKET + `LIVE-Link-source-${pkg.version}.zip`,
  released_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'dist', 'latest.json'), JSON.stringify(latest, null, 2));
console.log(JSON.stringify(latest, null, 2));
console.log(`size: ${(fs.statSync(exePath).size / 1048576).toFixed(1)} MB`);
