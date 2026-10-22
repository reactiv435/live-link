'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Updater, macSwapScript } = require('../src/core/updater');

const BYTES = Buffer.from('pretend installer '.repeat(1000));
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
const URL_OK = 'https://bxiejoktoknybpraxebm.supabase.co/storage/v1/object/sign/live-link/2.0.9/LIVE-Link-Setup-2.0.9.exe?token=x';
const offer = (o = {}) => ({ available: true, version: '2.0.9', url: URL_OK, sha256: SHA, ...o });
const settle = (u, status) => new Promise((resolve) => { const f = (s) => { if (s.status === status) { u.off('state', f); resolve(s); } }; u.on('state', f); if (u.state.status === status) resolve(u.getState()); });

function make({ busy = () => null, bytes = BYTES, platform = 'win32' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-upd-'));
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push([cmd, args, opts]); const p = new EventEmitter(); p.unref = () => {}; setImmediate(() => p.emit('close', 0)); return p; };
  const fetches = [];
  const fetch = async (url) => { fetches.push(url); return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }); };
  const u = new Updater({ dir, platform, appVersion: '2.0.4', appPath: '/Applications/LIVE Link.app/Contents/MacOS/LIVE Link', fetch, spawn, busy });
  return { u, dir, spawned, fetches };
}

test('downloads the update, checks it against the site checksum, and is ready to install', async () => {
  const { u, dir, fetches } = make();
  u.offer(offer());
  const s = await settle(u, 'ready');
  assert.equal(s.version, '2.0.9');
  assert.equal(fetches.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'LIVE-Link-2.0.9.exe')));
  u.offer(offer());   // a config refresh with a new signed link doesn't download again
  assert.equal(fetches.length, 1);
});

test('a download that does not match the checksum is thrown away', async () => {
  const { u, dir } = make({ bytes: Buffer.from('tampered') });
  u.offer(offer());
  const s = await settle(u, 'error');
  assert.equal(s.error, 'download_failed');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('never downloads during a LIVE: waits, then starts by itself once the LIVE is over', async () => {
  let live = true;
  const { u, fetches } = make({ busy: (kind) => (live && kind === 'download' ? 'live' : null) });
  u.offer(offer());
  assert.equal(u.state.status, 'waiting');
  assert.equal(u.state.blocked, 'live');
  assert.equal(fetches.length, 0);
  live = false; u.poke();
  await settle(u, 'ready');
  assert.equal(fetches.length, 1);
});

test('install on Windows runs the installer silently and relaunches; refused while clips are being made', async () => {
  let clips = true;
  const { u, spawned } = make({ busy: (kind) => (clips && kind === 'install' ? 'clips' : null) });
  u.offer(offer());
  await settle(u, 'ready');
  assert.equal(u.getState().blocked, 'clips');
  assert.deepEqual(await u.install(), { ok: false, error: 'clips' });
  clips = false;
  assert.deepEqual(await u.install(), { ok: true });
  const [cmd, args, opts] = spawned[0];
  assert.ok(cmd.endsWith('LIVE-Link-2.0.9.exe'));
  assert.deepEqual(args, ['/S', '--updated', '--force-run']);
  assert.equal(opts.detached, true);
});

test('2.0.8: "a new version is out" is announced once per version (the OS pop-up), whatever the download does', async () => {
  const { u } = make({ busy: () => 'live' });
  const seen = [];
  u.on('newVersion', (x) => seen.push(x.version));
  u.offer(offer());
  u.offer(offer());                                   // every config refresh offers it again
  u.offer(offer({ url: 'https://evil.example/x' }));  // even a bad link is still "a version is out"
  assert.deepEqual(seen, ['2.0.9']);
  u.offer(offer({ version: '2.1.0' }));
  assert.deepEqual(seen, ['2.0.9', '2.1.0']);
  assert.equal(u.state.status, 'waiting', 'during a LIVE it waits, but the banner (and pop-up) know');
});

test('only signed links from our own servers are used', async () => {
  const { u, fetches } = make();
  u.offer(offer({ url: 'https://evil.example/LIVE-Link.exe' }));
  assert.equal(u.state.status, 'error');
  assert.equal(u.state.error, 'no_download');
  assert.equal(fetches.length, 0);
  u.offer({ available: false });
  assert.equal(u.state.status, 'idle');
});

test('Mac: finds the running bundle and the swap script restores the old app if the copy fails', () => {
  const { u } = make({ platform: 'darwin' });
  assert.equal(u.macBundle(), '/Applications/LIVE Link.app');
  const sh = macSwapScript(4242, "/tmp/it's new/LIVE Link.app", '/Applications/LIVE Link.app');
  assert.match(sh, /while kill -0 4242/);
  assert.match(sh, /ditto '\/tmp\/it'\\''s new\/LIVE Link\.app' '\/Applications\/LIVE Link\.app'/);
  assert.match(sh, /else rm -rf '\/Applications\/LIVE Link\.app'; mv '\/Applications\/LIVE Link\.app\.old' '\/Applications\/LIVE Link\.app'; fi/);
  assert.match(sh, /open '\/Applications\/LIVE Link\.app'/);
});
