'use strict';
// 2.0.8: signed-in TikTok lookups for the recorder (optional, started by the host).
//
// TikTok lists a LIVE's video in three places (room info, api-live, the LIVE page). For some LIVEs it lists it only to a
// signed-in viewer (an age-restricted or gated LIVE), and from some networks it answers a bot check instead of the LIVE
// page. The host can sign in to TikTok inside a LIVE Link window (TikTok's own login page, in a separate persistent
// browser session on this computer); from then on the three lookups are made with that session's cookies, the way
// TikTok's website asks for a signed-in viewer. LIVE Link never sees the password, never reads the cookies into this
// code, never logs them and never sends them anywhere but tiktok.com. "Sign out" clears the session.
//
// Electron-free: main.js passes `fetch` (the session's own fetch, which carries its cookies) and `hasSession()` (is a
// TikTok sign-in cookie present). Tests pass fakes. Errors carry `response.statusCode` like the connector's (got), so
// show-manager's errInfo() classifies them the same way (http_403, timeout, waf...).

const { roomFromPageHtml } = require('./tiktok-link');

const HOST_WEB = 'https://www.tiktok.com';
const HOST_WEBCAST = 'https://webcast.tiktok.com';
// A current desktop Chrome; TikTok answers its bot check to unusual User-Agents (Electron's own carries "Electron/").
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// The query TikTok's website sends with these calls (no device id: the session cookies identify the viewer).
const PARAMS = {
  aid: '1988', app_language: 'en-US', app_name: 'tiktok_web', browser_language: 'en-US', browser_name: 'Mozilla',
  browser_online: 'true', browser_platform: 'Win32', browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  cookie_enabled: 'true', device_platform: 'web_pc', focus_state: 'true', from_page: 'user', history_len: '4',
  is_fullscreen: 'false', is_page_visible: 'true', screen_height: '1080', screen_width: '1920', tz_name: 'America/New_York',
  webcast_language: 'en', channel: 'tiktok_web', data_collection_enabled: 'true', user_is_login: 'true',
};
const LOGIN_URL = `${HOST_WEB}/login`;
// Cookie names that mean "signed in" (the connector reads the same ones). Only their PRESENCE is ever checked.
const SESSION_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];
const SIGNIN_HOSTS = /(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|bytedance\.com|ibyteimg\.com|ttwstatic\.com)$/i;

const qs = (o) => new URLSearchParams(o).toString();
const validRoom = (id) => /^\d{6,22}$/.test(String(id || ''));
const validHandle = (h) => /^[A-Za-z0-9._]{2,30}$/.test(String(h || ''));

class TikTokSignIn {
  // fetch(url, { headers, credentials, signal }) -> a WHATWG Response (Electron: session.fetch). hasSession() -> bool.
  constructor({ fetch, hasSession, log = () => {}, timeoutMs = 15000, userAgent = USER_AGENT } = {}) {
    this.fetch = fetch || null;
    this.hasSession = hasSession || (async () => false);
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.lastCheck = { at: 0, value: false };
  }

  // Is the host signed in (a session cookie exists)? Cheap, so no caching beyond a second.
  async signedIn() {
    if (!this.fetch) return false;
    const now = Date.now();
    if (now - this.lastCheck.at < 1000) return this.lastCheck.value;
    let value = false;
    try { value = !!(await this.hasSession()); } catch { value = false; }
    this.lastCheck = { at: now, value };
    return value;
  }

  roomInfoUrl(roomId) { return `${HOST_WEBCAST}/webcast/room/info/?${qs({ ...PARAMS, room_id: String(roomId) })}`; }
  apiLiveUrl(handle) { return `${HOST_WEB}/api-live/user/room/?${qs({ ...PARAMS, uniqueId: String(handle), sourceType: '54' })}`; }
  livePageUrl(handle) { return `${HOST_WEB}/@${encodeURIComponent(String(handle))}/live`; }

  async _get(url, accept) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res, text;
    try {
      res = await this.fetch(url, {
        method: 'GET', credentials: 'include', redirect: 'follow', signal: ctl.signal,
        headers: { 'User-Agent': this.userAgent, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9', Referer: `${HOST_WEB}/`, Origin: HOST_WEB },
      });
      text = await res.text();
    } catch (e) {
      const err = new Error(e && e.name === 'AbortError' ? `Timeout awaiting request for ${this.timeoutMs}ms` : `signed-in request failed (${(e && e.message) || e})`);
      if (e && e.name === 'AbortError') err.code = 'ETIMEDOUT';
      throw err;
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const err = new Error(`Response code ${res.status} (signed in)`);
      err.code = 'ERR_NON_2XX_3XX_RESPONSE';
      err.response = { statusCode: res.status };
      throw err;
    }
    return text;
  }

  // webcast room/info for a room, as TikTok's JSON (status_code 4003110 and the like come back as data, not errors).
  async roomInfo(roomId) {
    if (!validRoom(roomId)) throw new Error('no room id');
    const text = await this._get(this.roomInfoUrl(roomId), 'application/json, text/plain, */*');
    let json;
    try { json = JSON.parse(text); } catch { const e = new Error(`room info (signed in) answered ${text.length} bytes that are not JSON`); e.code = /_wafchallengeid|Please wait/i.test(text) ? 'waf' : 'error'; throw e; }
    return json;
  }

  // api-live/user/room for the account (data.liveRoom.streamData lists the video links).
  async apiLive(handle) {
    if (!validHandle(handle)) throw new Error('no username');
    const text = await this._get(this.apiLiveUrl(handle), 'application/json, text/plain, */*');
    let json;
    try { json = JSON.parse(text); } catch { const e = new Error(`api-live (signed in) answered ${text.length} bytes that are not JSON`); e.code = /_wafchallengeid|Please wait/i.test(text) ? 'waf' : 'error'; throw e; }
    return json;
  }

  // The LIVE page's room data (bot check told apart from a moved layout, like the signed-out read).
  async livePage(handle) {
    if (!validHandle(handle)) throw new Error('no username');
    const html = await this._get(this.livePageUrl(handle), 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    return roomFromPageHtml(html);
  }
}

module.exports = { TikTokSignIn, USER_AGENT, LOGIN_URL, SESSION_COOKIES, SIGNIN_HOSTS, PARAMS };
