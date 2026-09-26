'use strict';
// LIVE Link window. Talks to the app only through window.liveLink (preload.js).
// Opened in a normal browser (no bridge), it runs a demo that cycles through sample states, for design checks.
(function () {
  const $ = (id) => document.getElementById(id);
  const bridge = window.liveLink || demoBridge();
  const fmt = (n) => Number(n || 0).toLocaleString();
  const PILL = { ok: 'LIVE', info: 'WAITING', setup: 'SETUP', warn: 'CHECK', error: 'STOPPED' };

  function render(s) {
    if (!s) return;
    const pairing = s.phase === 'unpaired' || s.phase === 'revoked';
    $('pair').classList.toggle('hidden', !pairing);
    $('status').classList.toggle('hidden', pairing);
    $('test-banner').classList.toggle('hidden', !s.dryRun || pairing);
    const up = s.update && s.update.available;
    $('update-banner').classList.toggle('hidden', !up);
    if (up) $('update-text').textContent = `LIVE Link ${s.update.version} is ready.`;
    if (s.phase === 'update_required') { $('update-banner').classList.remove('hidden'); $('update-text').textContent = 'This version is too old to send taps.'; }

    if (pairing) {
      if (s.phase === 'revoked') showPairError('This computer was disconnected from your account. Get a new code from your dashboard.');
      return;
    }
    const m = s.message || { level: 'info', text: '' };
    const pill = $('pill');
    pill.className = 'pill ' + m.level;
    $('pill-text').textContent = m.level === 'ok' && s.tiktok && s.tiktok.status !== 'live' ? 'READY' : (PILL[m.level] || 'READY');
    $('msg').textContent = m.text;
    const who = [];
    if (s.tiktokUsername) who.push('@' + s.tiktokUsername);
    if (s.hostName) who.push(s.hostName);
    if (s.tiktok && s.tiktok.status === 'live' && s.tiktok.viewers) who.push(`${fmt(s.tiktok.viewers)} watching`);
    $('who').textContent = who.join('  ·  ');
    $('t-session').textContent = fmt(s.taps && s.taps.session);
    $('t-sent').textContent = fmt(s.taps && s.taps.accepted);
    $('t-song').textContent = s.target ? (s.target.title || 'Current song') : 'No song playing yet';
  }

  function showPairError(text) { const e = $('pair-error'); e.textContent = text; e.classList.toggle('hidden', !text); }
  const PAIR_ERRORS = {
    invalid_code: "That code doesn't match. Check it on your dashboard and try again.",
    code_expired: 'That code has expired. Click Connect on your dashboard for a new one.',
    too_many_attempts: 'Too many tries. Wait 10 minutes, then get a new code.',
    network: "Can't reach reactivvibeai.com. Check the internet and try again.",
  };

  // code box: letters and numbers only, shown as XXXX-XXXX
  $('code').addEventListener('input', (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    e.target.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
    showPairError('');
  });
  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('code').value.replace(/[^A-Z0-9]/gi, '');
    if (code.length !== 8) return showPairError('The code has 8 letters and numbers.');
    const btn = $('pair-btn');
    btn.disabled = true; btn.textContent = 'Connecting...';
    const r = await bridge.pair(code);
    btn.disabled = false; btn.textContent = 'Connect';
    if (!r.ok) showPairError(PAIR_ERRORS[r.code] || r.message || 'Something went wrong. Try again.');
    else { $('code').value = ''; showPairError(''); }
  });

  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => bridge.open(b.dataset.open)));
  $('retry').addEventListener('click', () => bridge.retry());

  // settings
  async function openSettings() {
    const st = await bridge.getSettings();
    $('s-autostart').checked = !!st.startWithWindows;
    $('s-dry').checked = !!st.dryRun;
    $('s-device').textContent = st.deviceName || '-';
    $('s-version').textContent = st.version || '-';
    const ts = $('s-testserver');
    ts.classList.toggle('hidden', !st.testServer);
    if (st.testServer) ts.textContent = `Connected to a TEST server: ${st.testServer}`;
    $('settings').classList.remove('hidden');
  }
  $('gear').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
  $('s-autostart').addEventListener('change', (e) => bridge.setSetting('startWithWindows', e.target.checked));
  $('s-dry').addEventListener('change', (e) => bridge.setSetting('dryRun', e.target.checked));
  $('unpair').addEventListener('click', async () => {
    if (!confirm('Disconnect this computer? It stops sending taps until you connect it again with a new code.')) return;
    await bridge.unpair();
    $('settings').classList.add('hidden');
  });

  bridge.onState(render);
  bridge.getState().then(render);

  // ------------------------------------------------------------ demo (browser only)
  function demoBridge() {
    const listeners = [];
    const base = { phase: 'ready', dryRun: false, tiktokUsername: 'the_boneyard_ai', hostName: 'Bone Daddy', update: { available: false },
      tiktok: { status: 'live', viewers: 214 }, taps: { session: 4821, accepted: 4790 }, target: { title: 'Midnight Engine (AI remix)' },
      message: { level: 'ok', text: 'Connected to @the_boneyard_ai. Taps are going to the hype bar.' } };
    const states = {
      live: base,
      waiting: { ...base, tiktok: { status: 'offline' }, taps: { session: 0, accepted: 0 }, target: null, message: { level: 'info', text: 'Waiting for your TikTok LIVE to start. Checking again in 24 s.' } },
      pending: { ...base, phase: 'pending_approval', message: { level: 'setup', text: 'Almost there. On your host dashboard, click Approve for "STREAM-PC".' } },
      pair: { ...base, phase: 'unpaired' },
      test: { ...base, dryRun: true },
      warn: { ...base, message: { level: 'warn', text: 'TikTok asked us to slow down. Trying again at 9:42 PM.' } },
    };
    const pick = new URLSearchParams(location.search).get('demo') || 'live';
    setTimeout(() => listeners.forEach((f) => f(states[pick] || base)), 0);
    return {
      getState: async () => states[pick] || base,
      getSettings: async () => ({ startWithWindows: true, dryRun: pick === 'test', deviceName: 'STREAM-PC', version: '1.0.0', testServer: null }),
      pair: async (c) => (c === 'TEST2345' ? { ok: true } : { ok: false, code: 'invalid_code' }),
      unpair: async () => true, retry: async () => true, setSetting: async () => true, open: async () => true,
      onState: (f) => { listeners.push(f); return () => {}; },
    };
  }
})();
