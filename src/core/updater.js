'use strict';
// In-app updates: when the site says a newer LIVE Link is out, the installer is downloaded in the background (never during
// a LIVE, a recording, or while clips are being made), checked against the site's SHA-256, and kept ready. The host
// installs it with one click ("Restart to update"); it is never installed by itself mid-show.
//   Windows: the per-user installer runs silently (/S) and starts the new version (--force-run).
//   Mac: the .dmg is mounted, the new app copied out, and a small script swaps it in after LIVE Link quits, then opens it.
// Electron-free: main.js passes the folders, the busy check, and quits the app after install() says so.

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const SAFE_URL = /^https:\/\/(bxiejoktoknybpraxebm\.supabase\.co|(www\.)?reactivvibeai\.com)\//;

class Updater extends EventEmitter {
  // busy(kind) -> null, or why not now: kind 'download' | 'install'.
  constructor({ dir, platform = process.platform, appVersion, appPath = process.execPath, fetch = globalThis.fetch, spawn = require('child_process').spawn, log = () => {}, busy = () => null }) {
    super();
    this.dir = dir; this.platform = platform; this.appVersion = appVersion; this.appPath = appPath;
    this.fetch = fetch; this.spawn = spawn; this.log = log; this.busy = busy;
    this.offerInfo = null;
    this.state = { status: 'idle', version: null, progress: 0, error: null, file: null, blocked: null };
    this.abort = null;
  }

  getState() { return { ...this.state, blocked: this.state.status === 'ready' ? this.busy('install') : null }; }
  _set(patch) { Object.assign(this.state, patch); this.emit('state', this.getState()); }

  // From the controller's state.update: { available, version, url, sha256 }. Starts (or keeps) the download.
  offer(update) {
    if (!update || !update.available || !update.version) {
      this.offerInfo = null;
      if (['waiting', 'error'].includes(this.state.status)) this._set({ status: 'idle', version: null, error: null });
      return;
    }
    // A new signed link comes with every config refresh; keep the newest one for the download.
    this.offerInfo = update;
    // 2.0.8: one "a new version is out" per version per app run (main.js shows an OS notification, once per version ever).
    if (this.announced !== update.version) { this.announced = update.version; this.emit('newVersion', { version: String(update.version) }); }
    if (this.state.version === update.version && ['downloading', 'ready', 'installing', 'error'].includes(this.state.status)) return;
    this.tryDownload();
  }

  // Something changed (a LIVE ended, clips finished): a download that was put off can start now.
  poke() {
    if (this.state.status === 'waiting' && !this.busy('download')) this.tryDownload();
    else if (this.state.status === 'ready') this.emit('state', this.getState());   // the install button may be free now
  }

  ext() { return this.platform === 'darwin' ? 'dmg' : 'exe'; }
  fileFor(version) { return path.join(this.dir, `LIVE-Link-${version}.${this.ext()}`); }

  async tryDownload(force = false) {
    const u = this.offerInfo;
    if (!u || this.state.status === 'downloading') return;
    if (!u.url || !SAFE_URL.test(u.url) || !/^[a-f0-9]{64}$/i.test(String(u.sha256 || ''))) { this._set({ status: 'error', version: u.version, error: 'no_download' }); return; }
    const why = this.busy('download');
    if (why && !force) { this._set({ status: 'waiting', version: u.version, error: null, blocked: why }); return; }
    const file = this.fileFor(u.version);
    // Already downloaded and checked (a restart before installing): ready at once.
    if (fs.existsSync(file) && await sha256(file) === u.sha256.toLowerCase()) { this._set({ status: 'ready', version: u.version, progress: 1, file, error: null }); return; }
    this._set({ status: 'downloading', version: u.version, progress: 0, error: null, file: null });
    const part = `${file}.part`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.abort = new AbortController();
      const res = await this.fetch(u.url, { signal: this.abort.signal });
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let got = 0, lastEmit = 0;
      for await (const chunk of Readable.fromWeb(res.body)) {
        hash.update(chunk); got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (total && Date.now() - lastEmit > 400) { lastEmit = Date.now(); this._set({ progress: Math.min(0.99, got / total) }); }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      if (hash.digest('hex') !== u.sha256.toLowerCase()) throw new Error('the download did not match its checksum');
      fs.renameSync(part, file);
      this._cleanOld(file);
      this.log('info', `update ${u.version} downloaded and checked`);
      this._set({ status: 'ready', version: u.version, progress: 1, file, error: null });
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      this.log('warn', `update download: ${e && e.message}`);
      this._set({ status: 'error', error: e && e.name === 'AbortError' ? 'cancelled' : 'download_failed' });
    } finally { this.abort = null; }
  }

  _cleanOld(keep) {
    try { for (const f of fs.readdirSync(this.dir)) { const p = path.join(this.dir, f); if (p !== keep && /^LIVE-Link-.*\.(exe|dmg|part)$/.test(f)) fs.unlinkSync(p); } } catch {}
  }

  // Returns { ok: true } when the app should quit now (the installer / swap script takes over), else { ok: false, error }.
  async install() {
    if (this.state.status !== 'ready' || !this.state.file) return { ok: false, error: 'not_ready' };
    const why = this.busy('install');
    if (why) return { ok: false, error: why };
    // Check the file again right before running it (it sat on disk since the download).
    const want = this.offerInfo && String(this.offerInfo.sha256 || '').toLowerCase();
    if (want && await sha256(this.state.file) !== want) { this._set({ status: 'error', error: 'checksum' }); return { ok: false, error: 'checksum' }; }
    this._set({ status: 'installing' });
    try {
      if (this.platform === 'win32') {
        const p = this.spawn(this.state.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
        p.unref();
        return { ok: true };
      }
      if (this.platform === 'darwin') return await this._installMac();
      return { ok: false, error: 'platform' };
    } catch (e) {
      this.log('warn', `update install: ${e && e.message}`);
      this._set({ status: 'ready' });
      return { ok: false, error: 'install_failed' };
    }
  }

  // The running bundle (…/LIVE Link.app/Contents/MacOS/LIVE Link -> …/LIVE Link.app).
  macBundle() {
    const i = this.appPath.indexOf('.app/');
    return i > 0 ? this.appPath.slice(0, i + 4) : null;
  }

  async _installMac() {
    const target = this.macBundle();
    if (!target) return { ok: false, error: 'no_bundle' };
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); fs.accessSync(target, fs.constants.W_OK); } catch { return { ok: false, error: 'not_writable' }; }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'livelink-update-'));
    const mnt = path.join(work, 'mnt');
    fs.mkdirSync(mnt);
    await run(this.spawn, 'hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt, this.state.file]);
    let app;
    try {
      app = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
      if (!app) throw new Error('no app in the update');
      await run(this.spawn, 'ditto', [path.join(mnt, app), path.join(work, app)]);
    } finally { await run(this.spawn, 'hdiutil', ['detach', mnt, '-force']).catch(() => {}); }
    const script = path.join(work, 'swap.sh');
    fs.writeFileSync(script, macSwapScript(process.pid, path.join(work, app), target), { mode: 0o755 });
    const p = this.spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
    p.unref();
    return { ok: true };
  }
}

// Waits for LIVE Link to quit, swaps the new app in (the old one comes back if the copy fails), and opens it.
function macSwapScript(pid, newApp, target) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return [
    '#!/bin/sh',
    `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.5; done`,
    `rm -rf ${q(`${target}.old`)}`,
    `if mv ${q(target)} ${q(`${target}.old`)} && ditto ${q(newApp)} ${q(target)}; then rm -rf ${q(`${target}.old`)}; else rm -rf ${q(target)}; mv ${q(`${target}.old`)} ${q(target)}; fi`,
    `open ${q(target)}`,
    '',
  ].join('\n');
}

function run(spawn, cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

function sha256(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(null));
  });
}

module.exports = { Updater, macSwapScript, sha256, SAFE_URL };
