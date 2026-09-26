'use strict';
// Settings file + the device token. The token is encrypted with the injected cipher (Electron's safeStorage =
// Windows DPAPI for the current user). Electron-free so tests can use a plain in-memory cipher.
const fs = require('fs');
const path = require('path');

class Store {
  constructor({ dir, cipher, file = 'settings.json' }) {
    this.file = path.join(dir, file);
    this.cipher = cipher || { available: () => false };
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
    if (enc && this.cipher.available()) { try { t = this.cipher.decrypt(Buffer.from(enc, 'base64')); } catch { t = null; } }
    else if (plain) t = plain;                      // only used when no OS encryption exists (tests)
    this._tokenCache = t;
    return t;
  }
  setToken(token) {
    this._tokenCache = token || null;
    delete this.data.tokenEnc; delete this.data.tokenPlain;
    if (token) {
      if (this.cipher.available()) this.data.tokenEnc = this.cipher.encrypt(token).toString('base64');
      else this.data.tokenPlain = token;
    }
    this._save();
  }
}

module.exports = { Store };
