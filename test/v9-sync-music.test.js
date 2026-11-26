'use strict';
// V9: scripts/sync-vtuber.js never copies an .mp3 (or any other media, the owner's face, review media, tests)
// whatever the VTuber's runtime-files.json says, EXCEPT exactly one file: assets/music/countdown-music.mp3, the
// countdown song (the owner's own Suno song, ~3.6 MB, off by default for every host; the VTuber's assets/NOTICE.txt
// says it is his). That one path ships when the list names it; any other .mp3 still stops the sync.
// The syncs here run on a throwaway git repo into throwaway folders: vendor/vtuber is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('../scripts/sync-vtuber');

const MUSIC = 'assets/music/countdown-music.mp3';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-v9-sync-'));
test.after(() => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a tiny VTuber repo: the three files the sync insists on, the countdown song, and whatever `extra` adds
function vtuberRepo(name, extra = {}) {
  const dir = path.join(WORK, name);
  const files = {
    'runtime-files.json': JSON.stringify({ include: ['livelink-host.js', 'vtuber.html', 'avatar.html', 'assets/**'], exclude: [], dev: [] }),
    'livelink-host.js': '// host\n', 'vtuber.html': '<!doctype html>\n', 'avatar.html': '<!doctype html>\n',
    'assets/NOTICE.txt': 'countdown-music.mp3: the owner\'s own song\n',
    [MUSIC]: Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5]),   // "ID3..." (an mp3's first bytes)
    ...extra,
  };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'core.autocrlf=false', 'add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'v');
  return { dir, files };
}
const into = (name) => ({ out: path.join(WORK, name, 'vendor-vtuber'), dev: path.join(WORK, name, 'vtuber-dev') });

test('the rule: exactly assets/music/countdown-music.mp3 is exempt; every other .mp3 (and media) is still never copied', () => {
  assert.equal(sync.isNever(MUSIC), false);
  assert.deepEqual([...sync.NEVER_EXCEPT], [MUSIC], 'one path, nothing else');
  for (const f of ['assets/music/other.mp3', 'assets/countdown-music.mp3', 'music/countdown-music.mp3', 'x/assets/music/countdown-music.mp3',
    'assets/music/Countdown-Music.mp3', 'assets/music/countdown-music.MP3', 'assets/music/countdown-music.mp3.mp3', 'assets/music/countdown-music.wav',
    'assets/music/countdown.mp4', 'review/countdown-music.mp3', 'assets/music/tests/countdown-music.mp3']) {
    assert.equal(sync.isNever(f), true, f);
  }
  assert.equal(sync.NEVER.test(MUSIC), true, 'NEVER itself still says no to every .mp3 (the exception is one name beside it)');
});

test('a sync copies the countdown song when runtime-files.json lists it, pins it by hash, and check() accepts it', () => {
  const repo = vtuberRepo('ok');
  const to = into('ok');
  const pin = sync.sync(repo.dir, 'HEAD', to);
  assert.ok(Object.prototype.hasOwnProperty.call(pin.files, MUSIC), 'the song is in the pin');
  assert.equal(pin.files[MUSIC], sha(repo.files[MUSIC]));
  assert.deepEqual(fs.readFileSync(path.join(to.out, MUSIC)), repo.files[MUSIC], 'the exact bytes');
  assert.deepEqual(sync.check(to), [], 'the copy matches its own pin, the song is not "must never be copied"');
  // vendor/vtuber itself was not touched by this test
  assert.notEqual(to.out, sync.OUT);
});

test('any other .mp3 the list names still stops the sync, and nothing is written', () => {
  for (const [name, bad] of [['other', 'assets/music/other.mp3'], ['moved', 'assets/countdown-music.mp3'], ['nested', 'assets/music/more/countdown-music.mp3']]) {   // (a case-only twin cannot sit beside it on Windows: the rule test above covers case)
    const repo = vtuberRepo(name, { [bad]: Buffer.from([0x49, 0x44, 0x33, 9]) });
    const to = into(name);
    assert.throws(() => sync.sync(repo.dir, 'HEAD', to), new RegExp('must never be copied: ' + bad.replace(/[.]/g, '\\.')), bad);
    assert.equal(fs.existsSync(to.out), false, `${bad}: nothing copied`);
  }
  // a pin that names another .mp3 (a copy edited by hand) fails check()
  const repo = vtuberRepo('hand');
  const to = into('hand');
  sync.sync(repo.dir, 'HEAD', to);
  const pinFile = path.join(to.out, 'VTUBER_PIN.json');
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  fs.writeFileSync(path.join(to.out, 'assets/music/extra.mp3'), 'x');
  pin.files['assets/music/extra.mp3'] = sha('x');
  fs.writeFileSync(pinFile, JSON.stringify(pin));
  assert.deepEqual(sync.check(to), ['vendor/vtuber/assets/music/extra.mp3: must never be copied']);
});
