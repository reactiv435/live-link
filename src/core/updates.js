'use strict';
// Checks the public latest.json the site hosts in its `live-link` bucket: { version, url, sha256 }.
const { semverLess } = require('./controller');

async function checkForUpdate({ url, currentVersion, fetch = globalThis.fetch, timeoutMs = 10000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: ctl.signal });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    if (!j || !j.version) return { available: false, error: 'no version' };
    return { available: semverLess(currentVersion, j.version), version: j.version, url: j.url || null, sha256: j.sha256 || null };
  } catch (e) {
    return { available: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdate };
