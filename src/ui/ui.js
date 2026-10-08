'use strict';
// LIVE Link window. Talks to the app only through window.liveLink (preload.js).
// Opened in a normal browser (no bridge), it runs a demo that cycles through sample states, for design checks.
(function () {
  const $ = (id) => document.getElementById(id);
  const bridge = window.liveLink || demoBridge();
  const fmt = (n) => Number(n || 0).toLocaleString();

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
    renderAtom(s);
    $('msg').textContent = m.text;
    const who = [];
    if (s.tiktokUsername) who.push('@' + s.tiktokUsername);
    if (s.hostName) who.push(s.hostName);
    if (s.tiktok && s.tiktok.status === 'live' && s.tiktok.viewers) who.push(`${fmt(s.tiktok.viewers)} watching`);
    $('who').textContent = who.join('  ·  ');
    $('t-session').textContent = fmt(s.taps && s.taps.session);
    $('t-sent').textContent = fmt(s.taps && s.taps.accepted);
    $('t-song').textContent = s.target ? (s.target.title || 'Current song') : 'No song playing yet';
    renderGifts(s);
    renderSteps(s.steps || []);
  }

  // ---------------------------------------------------------------- atom + Connect / Disconnect
  let current = null, lastAtom = '';
  const SPEED = { live: [2.2, 2.7, 2.5], connecting: [1.3, 1.6, 1.45], off: [4.8, 5.6, 5.2], paused: [9, 10.5, 9.8] };
  function renderAtom(s) {
    current = s;
    const kind = s.paused ? 'paused' : (s.atom || 'off');
    const atom = $('atom');
    // a pulse for every new batch of taps (at most ~4 a second); kept through re-renders until it finishes
    const taps = (s.taps && s.taps.session) || 0;
    if (taps > lastTaps && kind === 'live' && Date.now() - pulseAt > 250) pulseAt = Date.now();
    lastTaps = taps;
    const pulseLeft = 200 - (Date.now() - pulseAt);
    atom.setAttribute('class', 'atom ' + (kind === 'live' ? 'live' : 'off') + (kind === 'paused' ? ' paused' : '') + (pulseLeft > 0 ? ' pulse' : ''));
    if (pulseLeft > 0) { clearTimeout(pulseTimer); pulseTimer = setTimeout(() => atom.classList.remove('pulse'), pulseLeft); }
    if (kind !== lastAtom) {   // change orbit speed only when the state changes (SMIL restarts the motion)
      lastAtom = kind;
      atom.querySelectorAll('animateMotion').forEach((am, i) => am.setAttribute('dur', SPEED[kind][i] + 's'));
    }
    const tk = s.tiktok || {};
    const label = $('atom-label');
    label.className = 'atom-label' + (kind === 'live' ? ' live' : '');
    label.textContent = kind === 'live' ? (s.dryRun ? 'CONNECTED · TEST MODE' : 'CONNECTED TO YOUR LIVE')
      : kind === 'paused' ? 'DISCONNECTED'
      : kind === 'connecting' ? 'CONNECTING...'
      : (tk.status === 'offline' ? 'WAITING FOR YOUR LIVE' : 'NOT CONNECTED');
    const btn = $('conn-btn');
    btn.textContent = s.paused ? 'Connect' : 'Disconnect';
    btn.classList.toggle('disconnect', !s.paused);
    btn.disabled = s.phase !== 'ready';
    renderLiveMeta();
    renderLast(s);
  }
  let lastTaps = 0, pulseAt = 0, pulseTimer = null;
  function fmtDur(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }
  function renderLiveMeta() {
    const el = $('live-meta');
    const s = current;
    const on = s && s.atom === 'live' && s.liveSince;
    el.classList.toggle('hidden', !on);
    if (on) el.textContent = `LIVE for ${fmtDur(Date.now() - s.liveSince)} \u00b7 ${fmt(s.tapsPerMin)} taps/min`;
  }
  setInterval(renderLiveMeta, 1000);
  function renderGifts(s) {
    const G = s.gifts || { coins: 0, taps: 0, recent: [] };
    $('t-gifts').textContent = fmt(G.coins);
    $('t-gifts-sub').textContent = !s.giftsEnabled ? 'coins \u00b7 not counted yet on your channel'
      : G.taps ? `coins \u00b7 +${fmt(G.taps)} hype` : 'coins';
    const items = $('gift-items');
    items.textContent = '';
    for (const g of G.recent || []) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.textContent = `${g.who ? '@' + g.who : g.name} \u00b7 ${g.gift}${g.units > 1 ? ' x' + g.units : ''}`;
      const b = document.createElement('span'); b.textContent = `${fmt(g.coins)} coin${g.coins === 1 ? '' : 's'}`;
      li.append(a, b); items.append(li);
    }
    $('gift-list').classList.toggle('hidden', !(G.recent && G.recent.length));
  }
  function renderLast(s) {
    const x = s.lastSession;
    const show = !!x && s.atom !== 'live';
    $('last-live').classList.toggle('hidden', !show);
    if (!show) return;
    const when = new Date(x.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const gifts = x.giftCoins ? ` \u00b7 ${fmt(x.giftCoins)} coins in gifts${x.giftTaps ? ` (+${fmt(x.giftTaps)} hype)` : ''}${x.topGifter ? `, top @${x.topGifter.who}` : ''}` : '';
    $('last-live-text').textContent = `${when} \u00b7 ${fmtDur(x.endedAt - x.startedAt)} \u00b7 ${fmt(x.taps)} taps \u00b7 ${fmt(x.accepted)} sent to the bar${gifts} \u00b7 peak ${fmt(x.peakViewers)} watching` + (x.dryRun ? ' (test mode)' : '')
      + (x.reason === 'disconnected' ? ' \u00b7 ended by Disconnect' : x.reason === 'stopped' ? ' \u00b7 LIVE Link stopped watching' : '');
  }
  $('conn-btn').addEventListener('click', () => { if (current) bridge.setSetting('paused', !current.paused); });

  // ---------------------------------------------------------------- checklist
  const ICON = { done: '✓', todo: '!', problem: '!', wait: '', off: '', test: 'T' };
  function fmtLeft(ms) {
    const sec = Math.max(0, Math.round((ms - Date.now()) / 1000));
    return sec >= 90 ? `${Math.round(sec / 60)} min` : `${sec} s`;
  }
  function fmtAgo(ms) {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return sec < 60 ? 'just now' : `${Math.round(sec / 60)} min ago`;
  }
  function renderSteps(steps) {
    const ol = $('steps');
    ol.textContent = '';
    for (const st of steps) {
      const li = document.createElement('li');
      li.className = st.state;
      const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = ICON[st.state] || '';
      const body = document.createElement('div');
      const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = st.label;
      const txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = st.text;
      body.append(lbl, txt);
      if (st.retryAt || st.at) {
        const sub = document.createElement('span'); sub.className = 'sub';
        sub.dataset.retryAt = st.retryAt || ''; sub.dataset.at = st.at || '';
        body.append(sub);
      }
      li.append(ico, body);
      if (st.action) {
        const btn = document.createElement('button'); btn.className = 'act';
        btn.textContent = st.action === 'check' ? 'Check now' : 'Open dashboard';
        btn.addEventListener('click', () => (st.action === 'check' ? bridge.retry() : bridge.open('dashboard')));
        li.append(btn);
      } else li.append(document.createElement('span'));
      ol.append(li);
    }
    tickSteps();
  }
  function tickSteps() {
    document.querySelectorAll('#steps .sub').forEach((el) => {
      const r = Number(el.dataset.retryAt), at = Number(el.dataset.at);
      if (r) el.textContent = r > Date.now() ? `Checking again in ${fmtLeft(r)}` : 'Checking now...';
      else if (at) el.textContent = `Last update ${fmtAgo(at)}`;
    });
  }
  setInterval(tickSteps, 1000);


  function showPairError(text) { const e = $('pair-error'); e.textContent = text; e.classList.toggle('hidden', !text); }
  const PAIR_ERRORS = {
    invalid_code: "That code doesn't match. Check it on your dashboard and try again.",
    code_expired: 'That code has expired. Click "Get a pair code" on your dashboard for a new one.',
    too_many_attempts: 'Too many tries. Wait 10 minutes, then get a new code.',
    network: "Can't reach reactivvibeai.com. Check the internet and try again.",
    not_found: "The site isn't ready for LIVE Link yet. Try again once it's switched on.",
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
    if (st.platform === 'darwin') {
      const l = $('s-autostart-label');
      l.textContent = 'Open at login';
      const sm = document.createElement('small'); sm.textContent = 'Starts quietly in the menu bar when you log in to your Mac.';
      l.append(sm);
    }
    $('s-dry').checked = !!st.dryRun;
    $('s-notify').checked = st.notify !== false;
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
  $('s-notify').addEventListener('change', (e) => bridge.setSetting('notify', e.target.checked));
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
      atom: 'live', paused: false, liveSince: Date.now() - 42 * 60000, tapsPerMin: 1234, giftsEnabled: true,
      gifts: { units: 64, coins: 1186, taps: 11860, top: { who: 'maria', coins: 1000 }, recent: [
        { who: 'maria', gift: 'Galaxy', units: 1, coins: 1000 }, { who: 'sam_beats', gift: 'Rose', units: 12, coins: 12 },
        { who: 'kayla', gift: 'Doughnut', units: 5, coins: 150 }] },
      message: { level: 'ok', text: 'Connected to @the_boneyard_ai. Taps are going to the hype bar.' },
      steps: [
        { key: 'pc', label: 'This PC', state: 'done', text: 'Connected to Bone Daddy.' },
        { key: 'tt', label: 'TikTok account', state: 'done', text: 'Verified as @the_boneyard_ai.' },
        { key: 'send', label: 'Sending taps', state: 'done', text: 'On: taps fill your hype bar.' },
        { key: 'live', label: 'TikTok LIVE', state: 'done', text: 'LIVE now · 214 watching.' },
        { key: 'site', label: 'reactivvibeai.com', state: 'done', text: 'Connected.', at: Date.now() - 4000 },
      ] };
    const states = {
      live: base,
      paused: { ...base, paused: true, atom: 'off', tiktok: { status: 'idle' }, message: { level: 'off', text: "Disconnected. LIVE Link isn't watching your TikTok. Press Connect when you're ready." } },
      waiting: { ...base, atom: 'off', lastSession: { startedAt: Date.now() - 26 * 3600000, endedAt: Date.now() - 24.8 * 3600000, taps: 4821, accepted: 4790, peakViewers: 214, dryRun: false }, tiktok: { status: 'offline' }, taps: { session: 0, accepted: 0 }, target: null, message: { level: 'info', text: 'Ready. Waiting for @reactivvibeai to go LIVE on TikTok.' },
        steps: [
          { key: 'pc', label: 'This PC', state: 'done', text: 'Connected to ReactivVibeAI.' },
          { key: 'tt', label: 'TikTok account', state: 'done', text: 'Verified as @reactivvibeai.' },
          { key: 'send', label: 'Sending taps', state: 'test', text: 'Test mode: taps are checked, nothing is added.' },
          { key: 'live', label: 'TikTok LIVE', state: 'wait', text: "@reactivvibeai isn't LIVE yet.", retryAt: Date.now() + 24000, action: 'check' },
          { key: 'site', label: 'reactivvibeai.com', state: 'done', text: 'Connected.', at: Date.now() - 30000 },
        ] },
      verify: { ...base, tiktokUsername: null, tiktok: { status: 'idle' }, taps: { session: 0, accepted: 0 }, target: null,
        message: { level: 'setup', text: 'One step left: verify your TikTok on your dashboard (LIVE Link tab, TikTok verification).' },
        steps: [
          { key: 'pc', label: 'This PC', state: 'done', text: 'Connected to ReactivVibeAI.' },
          { key: 'tt', label: 'TikTok account', state: 'todo', text: 'Not verified yet. Dashboard: LIVE Link tab, TikTok verification.', action: 'dashboard' },
          { key: 'send', label: 'Sending taps', state: 'off', text: 'Not switched on for your channel yet. Turn on Test mode in Settings to try it.' },
          { key: 'live', label: 'TikTok LIVE', state: 'off', text: 'Starts watching once the steps above are done.' },
          { key: 'site', label: 'reactivvibeai.com', state: 'done', text: 'Connected.', at: Date.now() - 8000 },
        ] },
      pending: { ...base, phase: 'pending_approval', message: { level: 'setup', text: 'Almost there. On your host dashboard, click Approve for "STREAM-PC".' } },
      pair: { ...base, phase: 'unpaired' },
      test: { ...base, dryRun: true },
      warn: { ...base, message: { level: 'warn', text: 'TikTok asked us to slow down. Trying again at 9:42 PM.' } },
    };
    const pick = new URLSearchParams(location.search).get('demo') || 'live';
    setTimeout(() => listeners.forEach((f) => f(states[pick] || base)), 0);
    return {
      getState: async () => states[pick] || base,
      getSettings: async () => ({ notify: true, startWithWindows: true, dryRun: pick === 'test', deviceName: 'STREAM-PC', version: '1.0.0', testServer: null }),
      pair: async (c) => (c === 'TEST2345' ? { ok: true } : { ok: false, code: 'invalid_code' }),
      unpair: async () => true, retry: async () => true, setSetting: async () => true, open: async () => true,
      onState: (f) => { listeners.push(f); return () => {}; },
    };
  }
})();
