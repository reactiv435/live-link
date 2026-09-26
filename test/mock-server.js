'use strict';
// A local stand-in for the site's LIVE Link endpoints, following the contract in the site repo's
// .lovable/plan.md (commit 0c49df1). Used by the tests, and by hand:
//   node test/mock-server.js            -> http://127.0.0.1:8799/functions/v1/
//   then start the app with LIVE_LINK_API=http://127.0.0.1:8799/functions/v1/ and pair with code TEST2345.
const http = require('http');
const crypto = require('crypto');

function createMock(opts = {}) {
  const st = {
    codes: new Map([[opts.code || 'TEST2345', { host_id: 'host-1', expires: Date.now() + 600000, used: false }]]),
    devices: new Map(),       // token -> { id, host_id, status }
    host: { id: 'host-1', name: opts.hostName || 'Test Host', tiktok_username: opts.tiktokUsername ?? 'test_host', verified: opts.verified ?? true, enabled: opts.enabled ?? true, suspended: false, site_live: true },
    target: opts.target === undefined ? { submission_id: 'sub-1', title: 'Test Song' } : opts.target,
    autoApprove: opts.autoApprove ?? false,
    batches: new Map(),       // batch_id -> response
    rooms: new Map(),         // room -> last_session_total
    credited: 0,              // taps credited to the target song
    pushes: [], statuses: [], calls: [],
    failNext: [],             // e.g. [{ path: 'live-link-push', status: 503 }]
  };

  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const err = (res, code, error, message, extra = {}) => send(res, code, { error, message: message || error, ...extra });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
    req.on('end', () => {
      const path = req.url.split('?')[0].replace(/^\/functions\/v1\//, '');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return err(res, 400, 'validation', 'bad json'); }
      st.calls.push({ path, body });
      const fi = st.failNext.findIndex((f) => f.path === path);
      if (fi >= 0) { const f = st.failNext.splice(fi, 1)[0]; return err(res, f.status, f.error || 'server_error', 'injected', f.extra || {}); }

      if (path === 'live-link-pair') {
        const c = st.codes.get(String(body.code || ''));
        if (!c) return err(res, 400, 'invalid_code');
        if (c.used || c.expires < Date.now()) return err(res, 410, 'code_expired');
        c.used = true;
        const token = crypto.randomBytes(32).toString('base64url');
        const dev = { id: 'dev-' + (st.devices.size + 1), host_id: c.host_id, status: st.autoApprove ? 'approved' : 'pending_approval', name: body.device_name };
        st.devices.set(token, dev);
        return send(res, 200, { device_token: token, device_id: dev.id, host_id: dev.host_id, host_display_name: st.host.name, status: dev.status });
      }

      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const dev = st.devices.get(auth);
      if (!dev || dev.status === 'revoked') return err(res, 401, 'device_revoked');
      if (st.host.suspended) return err(res, 403, 'host_suspended');

      if (path === 'live-link-refresh') {
        st.devices.delete(auth);
        const token = crypto.randomBytes(32).toString('base64url');
        st.devices.set(token, dev);
        return send(res, 200, { device_token: token, device_id: dev.id, status: dev.status });
      }
      if (dev.status === 'pending_approval') return err(res, 403, 'pending_approval');

      if (path === 'live-link-config') {
        return send(res, 200, {
          host_id: st.host.id, host_display_name: st.host.name,
          tiktok_username: st.host.verified ? st.host.tiktok_username : null, tiktok_verified: st.host.verified,
          live_link_enabled: st.host.enabled, site_live: st.host.site_live, target: st.target,
          push_interval_ms: opts.pushIntervalMs || 2000, idle_push_interval_ms: opts.idlePushIntervalMs || 10000,
          status_interval_ms: 60000, status_stale_after_ms: 180000, max_likes_per_push: 500, max_events_per_push: 200,
          min_app_version: opts.minAppVersion || '1.0.0', server_time: new Date(Date.now() + (opts.serverSkewMs || 0)).toISOString(),
        });
      }
      if (path === 'live-link-status') { st.statuses.push(body); return send(res, 200, { ok: true, server_time: new Date().toISOString() }); }

      if (path === 'live-link-push') {
        if (!st.host.enabled && !body.dry_run) return err(res, 403, 'live_link_disabled');
        if (opts.notLiveReturns409 && !st.host.site_live) return err(res, 409, 'not_live');
        if (!st.host.verified) return err(res, 403, 'tiktok_unverified');
        const events = Array.isArray(body.events) ? body.events : null;
        if (!events || events.length > 200 || typeof body.batch_id !== 'string' || !Number.isInteger(body.session_total)) return err(res, 400, 'validation', 'bad body', { details: { events: !!events } });
        for (const e of events) if (!Number.isInteger(e.count) || e.count < 1 || e.count > 500) return err(res, 400, 'validation', 'bad count', { details: e });
        if (st.batches.has(body.batch_id)) return send(res, 200, { ...st.batches.get(body.batch_id), duplicate: true });
        const serverNow = Date.now() + (opts.serverSkewMs || 0);
        let stale = 0;
        for (const e of events) if (Math.abs(Date.parse(e.at) - serverNow) > 10000) stale += e.count;
        const key = String(body.tiktok_room_id);
        let accepted = 0, deferred = 0, baseline = false;
        if (!st.rooms.has(key) || body.rebaseline) {
          // first push for a room, or an explicit re-baseline: remember the total, credit nothing
          baseline = true;
          if (!body.dry_run) st.rooms.set(key, body.session_total);
        } else {
          const last = st.rooms.get(key);
          const delta = Math.max(0, body.session_total - last);
          accepted = Math.min(500, delta);
          deferred = delta - accepted;
          if (!body.dry_run) st.rooms.set(key, last + accepted);
        }
        if (!body.dry_run && st.target) st.credited += accepted;
        const resp = { batch_id: body.batch_id, accepted, deferred, stale, ignored: 0, baseline_set: baseline, dry_run: !!body.dry_run,
          duplicate: false, target: st.target, next_push_ms: opts.pushIntervalMs || 2000, server_time: new Date().toISOString() };
        st.batches.set(body.batch_id, resp);
        st.pushes.push(body);
        return send(res, 200, resp);
      }
      return err(res, 404, 'not_found');
    });
  });

  return {
    state: st,
    approveAll() { for (const d of st.devices.values()) if (d.status === 'pending_approval') d.status = 'approved'; },
    revokeAll() { for (const d of st.devices.values()) d.status = 'revoked'; },
    listen(port = 0) { return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))); },
    close() { return new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }); },
  };
}

module.exports = { createMock };

if (require.main === module) {
  const m = createMock({ autoApprove: process.argv.includes('--approve') });
  m.listen(8799).then((p) => console.log(`mock LIVE Link site on http://127.0.0.1:${p}/functions/v1/ (pair code TEST2345)`));
}
