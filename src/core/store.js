'use strict';
// Settings file + the device token. The token is encrypted with the injected cipher (Electron's safeStorage =
// Windows DPAPI for the current user, the Keychain on a Mac). Electron-free so tests can use a plain in-memory cipher.
const fs = require('fs');
const path = require('path');

class Store {
  // allowPlain: may the token be kept in clear text when no OS encryption exists? Tests and development only: a
  // packaged app keeps such a token in memory for the run instead of writing it to disk.
  constructor({ dir, cipher, file = 'settings.json', allowPlain = true }) {
    this.file = path.join(dir, file);
    this.cipher = cipher || { available: () => false };
    this.allowPlain = allowPlain;
    this.tokenLocked = false;   // a saved token exists but the OS would not decrypt it (a Mac Keychain "Deny")
    fs.mkdirSync(dir, { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  get(k) { return this.data[k]; }
  set(k, v) { if (v === undefined || v === null) delete this.data[k]; else this.data[k] = v; this._save(); }

  getToken() {
    if (this._tokenCache !== undefined) return this._tokenCache;
    const enc = this.data.tokenEnc, plain = this.data.tokenPlain;
    let t = null;
    this.tokenLocked = false;
    if (enc) {
      if (this.cipher.available()) { try { t = this.cipher.decrypt(Buffer.from(enc, 'base64')); } catch { t = null; } }
      // Keep the saved token: once the host allows access, unlock() reads it again. Never treat this as "unpaired"
      // (the cached null also stops a refused Keychain from asking again on every call).
      if (!t) this.tokenLocked = true;
    } else if (plain) {
      t = plain;
      // A clear-text token from an older run moves into the OS store as soon as one exists.
      if (!this.allowPlain && this.cipher.available()) { try { this.setToken(plain); } catch {} }
    }
    this._tokenCache = t;
    return t;
  }
  // Try the saved token again (after the host allowed Keychain access). Returns it, or null if still locked.
  unlock() { this._tokenCache = undefined; return this.getToken(); }
  setToken(token) {
    this._tokenCache = token || null;
    this.tokenLocked = false;
    delete this.data.tokenEnc; delete this.data.tokenPlain;
    if (token) {
      if (this.cipher.available()) this.data.tokenEnc = this.cipher.encrypt(token).toString('base64');
      else if (this.allowPlain) this.data.tokenPlain = token;
      // else: memory only for this run (the host pairs again after a restart; better than a token in clear text)
    }
    this._save();
  }
}

module.exports = { Store };
