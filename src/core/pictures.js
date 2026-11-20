'use strict';
// V8 (the puppet show): which picture addresses LIVE Link passes on to the VTuber on THIS computer. A viewer's profile
// picture rides on a boss-fight missile; a song's cover is "eaten" by the Mask. Contract: the VTuber repo's
// V8-PHASE2.md, C1 / C2. The VTuber checks the same list again at its own picture door.
//
// Rules:
//  * Only https, only the standard port, no login part, at most 600 characters, and only when the host IS one of the
//    names below or ends with '.' + one of them. Anything else becomes null (the VTuber then draws a placeholder).
//  * These addresses are signed links from TikTok: they go to the VTuber on 127.0.0.1 (or inside the app) and nowhere
//    else. Never to the site, never to the log, never to the disk. Only a host's family name ("tiktokcdn.com") is counted.
//
// Where the list comes from (see docs/V8-LINK-NOTES.md, "Picture hosts"):
//  * tiktokcdn.com    MEASURED: all 88 gift pictures LIVE Link sent to the site from real LIVEs between Oct 31 and
//                     Nov 15, 2026 sit on p16-webcast.tiktokcdn.com (the site's table hype_gift_alerts, read-only).
//  * the other names  NOT measured yet: TikTok's sister picture servers for other regions (US, EU) and ByteDance's
//                     image servers. tiktok-live-connector 2.4.4 and tiktok-live-proto 0.2.4 ship no test data with
//                     any address in it, and no real viewer picture has been recorded on this computer. PictureStats
//                     below counts the host families of real viewer pictures during a LIVE (allowed and refused), so
//                     the first real LIVE settles the list.
const TIKTOK_PICTURE_HOSTS = Object.freeze(['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ibyteimg.com', 'byteimg.com']);
const MAX_URL = 600;

/** the site's storage host for covers, from its API address (src/site-config.json apiBase); [] when it cannot be read */
function coverHosts(apiBase) {
  try { const u = new URL(apiBase); return u.protocol === 'https:' && u.hostname ? [u.hostname.toLowerCase()] : []; } catch { return []; }
}

/** An https picture address on an allowed host, normalised, or null. `hosts` = the family names allowed. */
function cleanPictureUrl(v, hosts = TIKTOK_PICTURE_HOSTS) {
  if (typeof v !== 'string' || v.length > MAX_URL || v.length < 12 || !/^https:\/\//i.test(v)) return null;
  if (/[^!-~]|["<>\\^`{|}]/.test(v)) return null;          // no spaces, no control or non-ASCII characters
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  if (!hosts.some((s) => h === s || h.endsWith('.' + s))) return null;
  return u.href.length <= MAX_URL ? u.href : null;
}

/** the last two labels of a host ("p16-sign-va.tiktokcdn.com" -> "tiktokcdn.com"), or null: all that is ever counted */
function hostFamily(v) {
  try {
    const h = new URL(String(v)).hostname.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(h)) return null;
    const p = h.split('.').filter(Boolean);
    return p.length >= 2 ? p.slice(-2).join('.') : null;
  } catch { return null; }
}

// Every address a TikTok user object may carry its picture in. tiktok-live-proto v3 (what 2.4.4 decodes):
// user.avatarThumb / avatarMedium / avatarLarge = ImageModel { urlList: string[] }. Older decoders: profilePictureUrl,
// profilePicture.urls / .urlList, avatarThumb.url_list.
function candidates(user) {
  const u = user && typeof user === 'object' ? user : {};
  const out = [];
  const add = (x) => { if (typeof x === 'string' && x) out.push(x); };
  const img = (m) => { if (m && typeof m === 'object') for (const k of ['urlList', 'url_list', 'urls']) if (Array.isArray(m[k])) m[k].slice(0, 6).forEach(add); };
  img(u.avatarThumb); img(u.avatarMedium); img(u.profilePicture); add(u.profilePictureUrl); img(u.avatarLarge);
  return out.slice(0, 16);
}

/**
 * A viewer's picture from a TikTok user object: the first allowed address, a .webp / .jpeg / .png before a .heic
 * (a browser cannot draw .heic). null when there is none. `stats` (PictureStats) counts host families only.
 */
function pickAvatar(user, hosts = TIKTOK_PICTURE_HOSTS, stats = null) {
  const list = candidates(user);
  let pick = null, fallback = null;
  for (const raw of list) {
    const ok = cleanPictureUrl(raw, hosts);
    if (!ok) continue;
    if (/\.hei[cf](?:[?~:]|$)/i.test(ok)) { if (!fallback) fallback = ok; continue; }
    pick = ok; break;
  }
  pick = pick || fallback;
  if (stats) stats.note(pick || list[0] || null, !!pick);
  return pick;
}

/** A TikTok user id as the contract wants it: a string of 1-30 digits, or null (a made-up or missing id is never sent). */
function cleanUid(v) {
  const s = typeof v === 'bigint' ? v.toString() : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === 'string' ? v : '';
  return /^[0-9]{1,30}$/.test(s) && !/^0+$/.test(s) ? s : null;
}

/** An @id as the contract wants it: no '@', only A-Z a-z 0-9 . _, at most 40 characters; '' when there is none. */
function cleanHandle(v) {
  return typeof v === 'string' ? v.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 40) : '';
}

/** Counts which picture-host families a LIVE's viewers really use. Family names only: never an address, never a viewer. */
class PictureStats {
  constructor() { this.reset(); }
  reset() { this.allowed = new Map(); this.refused = new Map(); this.none = 0; }
  note(url, ok) {
    if (!url) { this.none++; return; }
    const fam = hostFamily(url) || 'unreadable';
    const m = ok ? this.allowed : this.refused;
    if (m.size < 40 || m.has(fam)) m.set(fam, (m.get(fam) || 0) + 1);
  }
  get total() { let n = this.none; for (const v of this.allowed.values()) n += v; for (const v of this.refused.values()) n += v; return n; }
  /** one plain log line, or null when no viewer was seen */
  line() {
    if (!this.total) return null;
    const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    return `viewer pictures by server family: passed on: ${fmt(this.allowed)}; not on the list (no picture shown): ${fmt(this.refused)}; viewers without a picture: ${this.none}`;
  }
}

module.exports = { TIKTOK_PICTURE_HOSTS, MAX_URL, coverHosts, cleanPictureUrl, hostFamily, pickAvatar, cleanUid, cleanHandle, PictureStats };
