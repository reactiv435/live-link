'use strict';
// Client for the site's LIVE Link endpoints (contract: site repo .lovable/plan.md, commit 0c49df1).
// Every call returns the parsed JSON body or throws ApiError { status, code, message, retryAfterMs, details }.
// status 0 = the request never got an answer (offline, DNS, timeout).

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || (status === 0 ? 'network' : `http_${status}`);
    this.retryAfterMs = extra.retryAfterMs || null;
    this.details = extra.details || null;
  }
  get isNetwork() { return this.status === 0 || this.status >= 500; }
}

class LiveLinkApi {
  constructor(opts = {}) {
    if (!opts.baseUrl) throw new Error('baseUrl required');
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/';
    this.apiKey = opts.apiKey || null;           // Supabase publishable (anon) key: harmless, sent as `apikey` for the gateway
    this.fetch = opts.fetch || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.getToken = opts.getToken || (() => null);
    this.userAgent = opts.userAgent || 'ReactivVibe-LIVE-Link';
  }

  async _call(method, path, body, { auth = true } = {}) {
    const headers = { 'content-type': 'application/json', 'x-client-info': this.userAgent };
    if (this.apiKey) headers.apikey = this.apiKey;
    if (auth) {
      const t = this.getToken();
      if (!t) throw new ApiError(401, 'device_revoked', 'This computer is not connected yet.');
      headers.authorization = `Bearer ${t}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new ApiError(0, 'network', e && e.name === 'AbortError' ? 'The site did not answer in time.' : `Can't reach the site (${(e && e.message) || e}).`);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
    if (res.ok) return data || {};
    const retryHeader = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    const retryAfterMs = (data && Number(data.retry_after_ms)) || (retryHeader > 0 ? retryHeader * 1000 : null);
    throw new ApiError(res.status, data && data.error, data && data.message, { retryAfterMs, details: data && data.details });
  }

  pair(code, deviceName, appVersion) {
    const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this._call('POST', 'live-link-pair', { code: clean, device_name: String(deviceName || 'PC').slice(0, 60), app_version: appVersion }, { auth: false });
  }
  refresh(appVersion) { return this._call('POST', 'live-link-refresh', { app_version: appVersion }); }
  config() { return this._call('GET', 'live-link-config'); }
  push(body) { return this._call('POST', 'live-link-push', body); }
  status(body) { return this._call('POST', 'live-link-status', body); }
}

module.exports = { LiveLinkApi, ApiError };
