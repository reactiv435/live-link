// Minimal obs-websocket v5 client (browser ES module). No dependencies.
// Implements: Hello (op 0) -> Identify (op 1, SHA-256 challenge auth) -> Identified (op 2),
// Request (op 6) / RequestResponse (op 7). Events are not subscribed (eventSubscriptions: 0).
// The password is only ever held in memory here; it is never logged.

async function sha256b64(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export class ObsError extends Error {
  constructor(message, kind, code) { super(message); this.kind = kind; this.code = code; }
}

export class ObsClient {
  constructor() {
    this.ws = null;
    this.identified = false;
    this.pending = new Map();
    this.seq = 0;
    this.onclose = null; // (info:{code, reason, kind}) => void
  }

  // Resolves once Identified. Rejects with ObsError(kind: 'auth' | 'unreachable' | 'protocol').
  connect(host, port, password, timeoutMs = 4000) {
    this.close();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      let ws;
      try { ws = new WebSocket(`ws://${host}:${port}`); }
      catch (e) { reject(new ObsError('Bad host or port', 'unreachable')); return; }
      this.ws = ws;
      const timer = setTimeout(() => {
        done(reject, new ObsError('OBS did not answer (is the WebSocket server turned on?)', 'unreachable'));
        try { ws.close(); } catch (e) { /* ignore */ }
      }, timeoutMs);

      ws.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const d = msg.d || {};
        if (msg.op === 0) { // Hello
          const identify = { rpcVersion: 1, eventSubscriptions: 0 };
          if (d.authentication) {
            if (!password) {
              done(reject, new ObsError('OBS wants a password and none is saved', 'auth'));
              try { ws.close(); } catch (e) { /* ignore */ }
              return;
            }
            try {
              const secret = await sha256b64(password + d.authentication.salt);
              identify.authentication = await sha256b64(secret + d.authentication.challenge);
            } catch (e) {
              done(reject, new ObsError('Could not compute the password answer (page must be opened from http://127.0.0.1 or localhost)', 'protocol'));
              try { ws.close(); } catch (e2) { /* ignore */ }
              return;
            }
          }
          if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (msg.op === 2) { // Identified
          this.identified = true;
          done(resolve, d);
        } else if (msg.op === 7) { // RequestResponse
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          clearTimeout(p.timer);
          const st = d.requestStatus || {};
          if (st.result) p.resolve(d.responseData || {});
          else p.reject(new ObsError(st.comment || `OBS request failed (code ${st.code})`, 'request', st.code));
        }
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = (ev) => {
        const wasIdentified = this.identified;
        this.identified = false;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ObsError('OBS connection closed', 'closed')); }
        this.pending.clear();
        let kind = 'unreachable';
        let text = 'Could not reach OBS (is OBS open and the WebSocket server turned on?)';
        if (ev.code === 4009) { kind = 'auth'; text = 'Wrong OBS WebSocket password'; }
        else if (ev.code === 4008) { kind = 'auth'; text = 'OBS wants a password'; }
        else if (wasIdentified) { kind = 'closed'; text = 'OBS connection closed'; }
        done(reject, new ObsError(text, kind, ev.code));
        if (this.ws === ws) {
          this.ws = null;
          if (wasIdentified && this.onclose) this.onclose({ code: ev.code, kind, text });
        }
      };
    });
  }

  call(requestType, requestData, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.identified || this.ws.readyState !== 1) {
        reject(new ObsError('Not connected to OBS', 'closed'));
        return;
      }
      const requestId = 'r' + (++this.seq);
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new ObsError(requestType + ' timed out', 'timeout'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.identified = false;
    if (ws) {
      ws.onclose = null; ws.onmessage = null; ws.onerror = null;
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ObsError('OBS connection closed', 'closed')); }
    this.pending.clear();
  }
}
