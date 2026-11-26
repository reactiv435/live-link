'use strict';
// Copies the VTuber's runtime files from a COMMIT of the VTuber repo into vendor/vtuber, and pins every file by hash.
// The VTuber is developed in its own repo; LIVE Link carries this pinned copy and nothing else of it. Nobody edits
// vendor/vtuber by hand: a fix is made in the VTuber repo, committed there, then synced here with a new pin.
//
//   node scripts/sync-vtuber.js --from <path to the VTuber repo> [--commit <commit, default HEAD>]
//   node scripts/sync-vtuber.js --check          only checks vendor/vtuber against its pin (what the test does)
//   (VTUBER_REPO=<path> works instead of --from)
//
// What is copied is decided by the VTuber repo's own runtime-files.json AT THAT COMMIT (an allow-list: include, exclude,
// dev). Files are read straight from git (the commit's exact bytes: uncommitted work and line-ending settings do not
// matter), so the same commit always gives the same copy. Re-runnable: it replaces the whole copy each time.
//   vendor/vtuber/            what ships inside the app (package.json: extraResources -> resources/vtuber)
//   vendor/vtuber/VTUBER_PIN.json   { commit, date, files: { path: sha256 }, dev: { path: sha256 } }
//   test/vtuber-dev/          the pretend OBS and its helpers, for tests and CI only (never packaged)
// Never copied, whatever the list says: videos, the owner's calibration or saved face, review media, tests, scratch.
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'vendor', 'vtuber');
const DEV = path.join(root, 'test', 'vtuber-dev');
const PIN = path.join(OUT, 'VTUBER_PIN.json');
const NEVER = /(^|\/)(testdata|review|tests|research|tmp|node_modules|chrome-vtuber|chrome-profile)\/|calib-(owner|saved)\.json$|mask-rest\.json$|gifts-owner\.json$|vtuber-obs\.json$|\.(mp4|mov|mkv|webm|wav|mp3|log)$/i;
// V9: the ONE exception to NEVER, by exact path: the countdown song (the owner's own Suno song, off by default for
// every host; the VTuber's assets/NOTICE.txt says it is his). Every other .mp3 is still never copied.
const NEVER_EXCEPT = new Set(['assets/music/countdown-music.mp3']);
const isNever = (f) => NEVER.test(f) && !NEVER_EXCEPT.has(f);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** every file under dir, as forward-slash paths relative to it */
function walk(dir, rel = '') {
  let out = [];
  let list = [];
  try { list = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(dir, r)); else out.push(r);
  }
  return out;
}

/** vendor/vtuber and test/vtuber-dev against the pin: [] when every file matches and none is extra or missing
 *  (out / dev: other folders, for tests only) */
function check({ out = OUT, dev = DEV } = {}) {
  const problems = [];
  let pin = null;
  try { pin = JSON.parse(fs.readFileSync(path.join(out, 'VTUBER_PIN.json'), 'utf8')); } catch { return ['vendor/vtuber/VTUBER_PIN.json is missing or unreadable: run scripts/sync-vtuber.js']; }
  if (!/^[0-9a-f]{40}$/.test(String(pin.commit || ''))) problems.push('the pin names no commit');
  for (const [dir, files, label] of [[out, pin.files || {}, 'vendor/vtuber'], [dev, pin.dev || {}, 'test/vtuber-dev']]) {
    const have = new Set(walk(dir).filter((f) => !(dir === out && f === 'VTUBER_PIN.json')));
    for (const [f, want] of Object.entries(files)) {
      if (isNever(f)) problems.push(`${label}/${f}: must never be copied`);
      if (!have.has(f)) { problems.push(`${label}/${f}: missing`); continue; }
      have.delete(f);
      if (sha(fs.readFileSync(path.join(dir, f))) !== want) problems.push(`${label}/${f}: differs from the pinned commit (edited by hand?)`);
    }
    for (const f of have) problems.push(`${label}/${f}: not in the pin (added by hand?)`);
  }
  return problems;
}

// (out / dev: other folders, for tests only; the default is vendor/vtuber and test/vtuber-dev)
function sync(from, rev, { out: outDir = OUT, dev: devDir = DEV } = {}) {
  const pinFile = path.join(outDir, 'VTUBER_PIN.json');
  const git = (args, opts = {}) => execFileSync('git', ['-C', from, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });
  const commit = git(['rev-parse', '--verify', rev + '^{commit}']).toString().trim();
  const date = git(['show', '-s', '--format=%cI', commit]).toString().trim();
  let list;
  try { list = JSON.parse(git(['show', commit + ':runtime-files.json']).toString('utf8')); }
  catch { throw new Error(`commit ${commit.slice(0, 7)} of the VTuber repo has no runtime-files.json (it is older than V6)`); }
  const tracked = git(['ls-tree', '-r', '--name-only', '-z', commit]).toString('utf8').split('\0').filter(Boolean);
  const hit = (pat, f) => (pat.endsWith('/**') ? f.startsWith(pat.slice(0, -2)) : f === pat);
  const pick = (pats) => tracked.filter((f) => (pats || []).some((p) => hit(p, f)));
  const files = pick(list.include).filter((f) => !(list.exclude || []).some((p) => hit(p, f)));
  const dev = pick(list.dev);
  for (const f of [...files, ...dev]) if (isNever(f)) throw new Error('the list names a file that must never be copied: ' + f);
  if (!files.includes('livelink-host.js') || !files.includes('vtuber.html') || !files.includes('avatar.html')) throw new Error('the list is missing the app itself');

  // one git process hands over every file's exact bytes
  const all = [...files.map((f) => [f, outDir]), ...dev.map((f) => [f, devDir])];
  const r = spawnSync('git', ['-C', from, 'cat-file', '--batch'], { input: all.map(([f]) => `${commit}:${f}\n`).join(''), maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('git cat-file failed: ' + String(r.stderr || '').slice(0, 300));
  const buf = r.stdout;
  // what was there before, so the names that come and go are printed: a file added under js/**, mask/**, assets/** or
  // vendor/** ships and is published without anyone listing it, so it must at least be seen
  const before = { out: new Set(walk(outDir).filter((f) => f !== 'VTUBER_PIN.json')), dev: new Set(walk(devDir)) };
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(devDir, { recursive: true, force: true });
  const pin = { about: 'Written by scripts/sync-vtuber.js. Never edit vendor/vtuber or test/vtuber-dev by hand: change the VTuber repo, commit, sync again.', commit, date, bytes: 0, files: {}, dev: {} };
  let at = 0;
  for (const [f, dir] of all) {
    const nl = buf.indexOf(10, at);
    const head = buf.subarray(at, nl).toString('utf8').split(' ');
    if (head[1] !== 'blob') throw new Error(`not a file in that commit: ${f} (${head.join(' ')})`);
    const size = Number(head[2]);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const dest = path.join(dir, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    if (dir === outDir) { pin.files[f] = sha(body); pin.bytes += size; } else pin.dev[f] = sha(body);
  }
  fs.writeFileSync(pinFile, JSON.stringify(pin, null, 1) + '\n');
  const diff = (label, was, now) => [...now.filter((f) => !was.has(f)).map((f) => `+ ${label}/${f}`), ...[...was].filter((f) => !now.includes(f)).map((f) => `- ${label}/${f}`)];
  // (not part of the pin file: only for the person running the sync)
  Object.defineProperty(pin, 'changes', { value: [...diff('vendor/vtuber', before.out, files), ...diff('test/vtuber-dev', before.dev, dev)], enumerable: false });
  return pin;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const k = argv.indexOf('--' + name); return k < 0 ? null : argv[k + 1]; };
  if (argv.includes('--check')) {
    const problems = check();
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
    console.log(`vendor/vtuber matches VTuber commit ${pin.commit.slice(0, 7)} (${Object.keys(pin.files).length} files, ${(pin.bytes / 1048576).toFixed(1)} MB)`);
    process.exit(0);
  }
  const from = opt('from') || process.env.VTUBER_REPO;
  if (!from) { console.error('Say where the VTuber repo is: node scripts/sync-vtuber.js --from <path> [--commit <commit>]'); process.exit(2); }
  try {
    const pin = sync(path.resolve(from), opt('commit') || 'HEAD');
    const changes = pin.changes || [];
    console.log(changes.length ? `files added (+) and removed (-) by this sync:\n${changes.join('\n')}` : 'no file was added or removed by this sync (same names as before)');
    const problems = check();
    if (problems.length) throw new Error('the copy does not match its own pin:\n' + problems.join('\n'));
    console.log(`vendor/vtuber = VTuber commit ${pin.commit} (${pin.date}): ${Object.keys(pin.files).length} files, ${(pin.bytes / 1048576).toFixed(1)} MB; test/vtuber-dev: ${Object.keys(pin.dev).length} files`);
  } catch (e) { console.error('sync failed: ' + (e && e.message)); process.exit(1); }
}

module.exports = { check, sync, walk, NEVER, NEVER_EXCEPT, isNever, OUT, DEV, PIN };
