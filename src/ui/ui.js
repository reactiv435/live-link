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
    renderUpdate(s);

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
    const song = $('hero-song');
    const showSong = !!(s.connected && s.target);
    song.classList.toggle('hidden', !showSong);
    if (showSong) {
      song.textContent = '';
      const b = document.createElement('b'); b.textContent = s.hold ? 'Song' : 'On the bar';
      song.append(b, s.target.title || 'Current song');
      song.title = s.target.title || '';
    }
    $('t-session').textContent = fmt(s.taps && s.taps.session);
    $('t-sent').textContent = fmt(s.taps && s.taps.accepted);
    $('t-song').textContent = s.target ? (s.target.title || 'Current song') : 'No song playing yet';
    $('t-song').parentElement.classList.toggle('hidden', showSong);   // the hero already shows it
    // While setting up, the checklist is what matters: it goes above the (empty) tiles.
    const steps = s.steps || [];
    $('status').classList.toggle('setup', s.phase !== 'ready' || steps.some((st) => st.state === 'todo' || st.state === 'problem' || (st.key === 'send' && st.state === 'off')));
    renderGifts(s);
    renderSteps(s.steps || []);
  }

  // ---------------------------------------------------------------- update banner
  // Never during a LIVE: installing means quitting, so the download button waits for the LIVE to end.
  function renderUpdate(s) {
    const up = s.update && s.update.available, need = s.phase === 'update_required';
    $('update-banner').classList.toggle('hidden', !up && !need);
    const btn = $('update-btn');
    if (need) { $('update-text').textContent = 'This version is too old to send taps. Download the new one.'; btn.classList.remove('hidden'); return; }
    if (!up) return;
    if (s.connected) { $('update-text').textContent = `LIVE Link ${s.update.version} is ready. Update after your LIVE.`; btn.classList.add('hidden'); return; }
    $('update-text').textContent = s.platform === 'darwin'
      ? `LIVE Link ${s.update.version} is ready: download it, quit this one, then drag the new one into Applications.`
      : `LIVE Link ${s.update.version} is ready: download it and run the installer (your settings stay).`;
    btn.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- atom + hero button
  // Atom: green = taps are filling the bar, gold = connected to the LIVE but nothing is added yet, grey = paused,
  // red = not watching.
  let current = null, lastAtom = '';
  const SPEED = { live: [2.2, 2.7, 2.5], hold: [3, 3.6, 3.3], connecting: [1.3, 1.6, 1.45], off: [4.8, 5.6, 5.2], paused: [9, 10.5, 9.8] };
  const HOLD_LABEL = { test: 'CONNECTED · TEST MODE', show: 'CONNECTED · START YOUR SHOW', song: 'CONNECTED · NO SONG ON AIR' };
  function renderAtom(s) {
    current = s;
    const kind = s.paused && s.phase === 'ready' ? 'paused' : (s.atom || 'off');
    const atom = $('atom');
    // a pulse for every new batch of taps (at most ~4 a second); kept through re-renders until it finishes
    const taps = (s.taps && s.taps.session) || 0;
    if (taps > lastTaps && (kind === 'live' || kind === 'hold') && Date.now() - pulseAt > 250) pulseAt = Date.now();
    lastTaps = taps;
    const pulseLeft = 200 - (Date.now() - pulseAt);
    const color = kind === 'live' ? 'live' : kind === 'hold' ? 'hold' : kind === 'paused' ? 'paused' : 'off';
    atom.setAttribute('class', 'atom ' + color + (pulseLeft > 0 ? ' pulse' : ''));
    if (pulseLeft > 0) { clearTimeout(pulseTimer); pulseTimer = setTimeout(() => atom.classList.remove('pulse'), pulseLeft); }
    if (kind !== lastAtom && SPEED[kind]) {   // change orbit speed only when the state changes (SMIL restarts the motion)
      lastAtom = kind;
      atom.querySelectorAll('animateMotion').forEach((am, i) => am.setAttribute('dur', SPEED[kind][i] + 's'));
    }
    const tk = s.tiktok || {};
    const label = $('atom-label');
    label.className = 'atom-label' + (color === 'off' ? '' : ' ' + color);
    label.textContent = s.phase === 'locked' ? 'SIGN-IN LOCKED'
      : kind === 'live' ? 'FILLING THE HYPE BAR'
      : kind === 'hold' ? (HOLD_LABEL[s.hold] || 'CONNECTED')
      : kind === 'paused' ? 'PAUSED'
      : s.lost ? 'LOST TIKTOK · RETRYING'
      : kind === 'connecting' ? 'CONNECTING...'
      : (tk.status === 'offline' ? 'WAITING FOR YOUR LIVE' : 'NOT CONNECTED');
    renderHeroButton(s);
    renderLiveMeta();
    renderLast(s);
  }

  // The hero button is always the one thing to do next: a setup step while setting up, otherwise Pause / Resume.
  let heroAction = null;
  function renderHeroButton(s) {
    const btn = $('conn-btn');
    const steps = s.steps || [];
    const todo = steps.find((st) => (st.state === 'todo' || st.state === 'problem') && (st.action === 'dashboard' || st.action === 'retry'));
    const sendOff = s.phase === 'ready' && steps.some((st) => st.key === 'send' && st.state === 'off');
    let label, cls, act;
    if (s.phase === 'update_required') { label = 'Download update'; cls = 'next'; act = () => bridge.open('update'); }
    else if (s.phase === 'locked') { label = 'Retry'; cls = 'next'; act = () => bridge.retry(); }
    else if (todo) { label = todo.action === 'retry' ? 'Retry' : 'Open dashboard'; cls = 'next'; act = () => (todo.action === 'retry' ? bridge.retry() : bridge.open('dashboard')); }
    else if (s.phase !== 'ready') { label = 'Open dashboard'; cls = 'quiet'; act = () => bridge.open('dashboard'); }
    else if (s.paused) { label = 'Resume'; cls = 'paused-btn'; act = () => bridge.setSetting('paused', false); }
    else if (sendOff && !s.dryRun) { label = 'Try it in Test mode'; cls = 'quiet'; act = () => bridge.setSetting('dryRun', true); }
    else { label = 'Pause'; cls = 'disconnect'; act = () => bridge.setSetting('paused', true); }
    btn.textContent = label;
    btn.className = 'conn ' + cls;
    btn.disabled = false;
    heroAction = act;
  }
  let lastTaps = 0, pulseAt = 0, pulseTimer = null;
  function fmtDur(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }
  function renderLiveMeta() {
    const el = $('live-meta');
    const s = current;
    const on = s && s.connected && s.liveSince;
    el.classList.toggle('hidden', !on);
    el.classList.toggle('hold', !!(s && s.atom === 'hold'));
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
    const show = !!x && !s.connected;
    $('last-live').classList.toggle('hidden', !show);
    if (!show) return;
    const when = new Date(x.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const gifts = x.giftCoins ? ` \u00b7 ${fmt(x.giftCoins)} coins in gifts${x.giftTaps ? ` (+${fmt(x.giftTaps)} hype)` : ''}${x.topGifter ? `, top @${x.topGifter.who}` : ''}` : '';
    $('last-live-text').textContent = `${when} \u00b7 ${fmtDur(x.endedAt - x.startedAt)} \u00b7 ${fmt(x.taps)} taps \u00b7 ${fmt(x.accepted)} sent to the bar${gifts} \u00b7 peak ${fmt(x.peakViewers)} watching` + (x.dryRun ? ' (test mode)' : '')
      + (x.reason === 'disconnected' ? ' \u00b7 ended by Pause' : x.reason === 'stopped' ? ' \u00b7 LIVE Link stopped watching' : '');
  }
  $('conn-btn').addEventListener('click', () => { if (heroAction) heroAction(); });

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
  let stepsOpen = false;
  function renderSteps(steps) {
    const ol = $('steps');
    const allSet = steps.length > 0 && steps.every((st) => st.state === 'done' || st.state === 'test' || (st.key === 'live' && st.state === 'wait'));
    const sum = $('steps-summary');
    sum.classList.toggle('hidden', !allSet);
    $('steps').parentElement.classList.toggle('collapsed', allSet && !stepsOpen);
    sum.setAttribute('aria-expanded', String(allSet && stepsOpen));
    sum.querySelector('.more').textContent = stepsOpen ? 'Hide checklist' : 'Show checklist';
    if (allSet) {
      const tt = steps.find((st) => st.key === 'tt'), send = steps.find((st) => st.key === 'send');
      $('steps-summary-text').textContent = `All set${tt && tt.text.startsWith('Verified as ') ? ' \u00b7 ' + tt.text.slice(12).replace(/\.$/, '') : ''}${send && send.state === 'test' ? ' \u00b7 Test mode' : ''}`;
    }
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
        btn.textContent = st.action === 'check' ? 'Check now' : st.action === 'retry' ? 'Retry' : 'Open dashboard';
        btn.addEventListener('click', () => (st.action === 'check' || st.action === 'retry' ? bridge.retry() : bridge.open('dashboard')));
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
  $('steps-summary').addEventListener('click', () => { stepsOpen = !stepsOpen; if (current) renderSteps(current.steps || []); });

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
    if (!confirm('Remove this computer from your account? It stops sending taps until you connect it again with a new code from your dashboard. (To stop for a while, use Pause instead.)')) return;
    await bridge.unpair();
    $('settings').classList.add('hidden');
  });

  bridge.onState(render);
  bridge.getState().then(render);

  // ------------------------------------------------------------ demo (browser only)
  function demoBridge() {
    const listeners = [];
    const doneSteps = [
      { key: 'pc', label: 'This computer', state: 'done', text: 'Connected to Bone Daddy.' },
      { key: 'tt', label: 'TikTok account', state: 'done', text: 'Verified as @the_boneyard_ai.' },
      { key: 'send', label: 'Sending taps', state: 'done', text: 'On: taps fill your hype bar.' },
      { key: 'live', label: 'TikTok LIVE', state: 'done', text: 'LIVE now · 214 watching.' },
      { key: 'site', label: 'reactivvibeai.com', state: 'done', text: 'Connected.', at: Date.now() - 4000 },
    ];
    const base = { phase: 'ready', platform: 'win32', dryRun: false, tiktokUsername: 'the_boneyard_ai', hostName: 'Bone Daddy', update: { available: false },
      tiktok: { status: 'live', viewers: 214 }, taps: { session: 4821, accepted: 4790 }, target: { title: 'Midnight Engine (AI remix)' },
      atom: 'live', hold: null, connected: true, lost: false, paused: false, liveSince: Date.now() - 42 * 60000, tapsPerMin: 1234, giftsEnabled: true,
      gifts: { units: 64, coins: 1186, taps: 11860, top: { who: 'maria', coins: 1000 }, recent: [
        { who: 'maria', gift: 'Galaxy', units: 1, coins: 1000 }, { who: 'sam_beats', gift: 'Rose', units: 12, coins: 12 },
        { who: 'kayla', gift: 'Doughnut', units: 5, coins: 150 }] },
      message: { level: 'ok', text: 'Taps from @the_boneyard_ai are filling the hype bar.' },
      steps: doneSteps };
    const notLive = { atom: 'off', connected: false, liveSince: null, tapsPerMin: 0 };
    const states = {
      live: base,
      update: { ...base, update: { available: true, version: '1.0.6' } },
      hold: { ...base, atom: 'hold', hold: 'song', target: null, message: { level: 'ok', text: 'Connected to @the_boneyard_ai. Put a song on air and taps will fill its hype bar.' } },
      show: { ...base, atom: 'hold', hold: 'show', target: null, message: { level: 'ok', text: 'Connected to @the_boneyard_ai. Start your show on reactivvibeai.com and taps will fill the hype bar.' } },
      lost: { ...base, ...notLive, atom: 'connecting', lost: true, tiktok: { status: 'reconnecting' }, message: { level: 'warn', text: 'Lost the connection to your LIVE. Reconnecting to @the_boneyard_ai by itself...' },
        steps: doneSteps.map((r) => (r.key === 'live' ? { ...r, state: 'wait', text: 'Reconnecting to TikTok...' } : r)) },
      paused: { ...base, ...notLive, paused: true, tiktok: { status: 'idle' }, message: { level: 'off', text: "Paused: LIVE Link isn't watching your TikTok. It starts again by itself when your next show starts on the site, or press Resume." },
        steps: doneSteps.map((r) => (r.key === 'live' ? { ...r, state: 'off', text: 'Paused. Starts again when your next show starts, or press Resume.' } : r)) },
      waiting: { ...base, ...notLive, lastSession: { startedAt: Date.now() - 26 * 3600000, endedAt: Date.now() - 24.8 * 3600000, taps: 4821, accepted: 4790, peakViewers: 214, gifts: 64, giftCoins: 1186, giftTaps: 11860, topGifter: { who: 'maria', coins: 1000 }, dryRun: false }, tiktok: { status: 'offline' }, taps: { session: 0, accepted: 0 }, target: null, gifts: { units: 0, coins: 0, taps: 0, recent: [] }, message: { level: 'info', text: 'Ready. Waiting for @the_boneyard_ai to go LIVE on TikTok.' },
        steps: doneSteps.map((r) => (r.key === 'live' ? { key: 'live', label: 'TikTok LIVE', state: 'wait', text: "@the_boneyard_ai isn't LIVE yet.", retryAt: Date.now() + 24000, action: 'check' } : r)) },
      error: { ...base, ...notLive, tiktok: { status: 'error', errorKind: 'timeout' }, message: { level: 'warn', text: "TikTok isn't answering right now (your internet works). LIVE Link keeps trying by itself." },
        steps: doneSteps.map((r) => (r.key === 'live' ? { key: 'live', label: 'TikTok LIVE', state: 'problem', text: "TikTok isn't answering (your internet works).", retryAt: Date.now() + 40000, action: 'check' } : r)) },
      verify: { ...base, ...notLive, tiktokUsername: null, tiktok: { status: 'idle' }, taps: { session: 0, accepted: 0 }, target: null, gifts: { units: 0, coins: 0, taps: 0, recent: [] },
        message: { level: 'setup', text: 'One step left: verify your TikTok on your dashboard (LIVE Link tab, TikTok verification).' },
        steps: [
          { key: 'pc', label: 'This computer', state: 'done', text: 'Connected to ReactivVibeAI.' },
          { key: 'tt', label: 'TikTok account', state: 'todo', text: 'Not verified yet. Dashboard: LIVE Link tab, TikTok verification.', action: 'dashboard' },
          { key: 'send', label: 'Sending taps', state: 'off', text: 'Not switched on for your channel yet. Ryan switches it on after your test show; Test mode (Settings) lets you try it now.' },
          { key: 'live', label: 'TikTok LIVE', state: 'off', text: 'Starts watching once the steps above are done.' },
          { key: 'site', label: 'reactivvibeai.com', state: 'done', text: 'Connected.', at: Date.now() - 8000 },
        ] },
      locked: { ...base, ...notLive, phase: 'locked', platform: 'darwin', tiktok: { status: 'idle' }, taps: { session: 0, accepted: 0 }, target: null, gifts: { units: 0, coins: 0, taps: 0, recent: [] },
        message: { level: 'error', text: 'LIVE Link can\'t open its saved sign-in. When your Mac asks about "LIVE Link Safe Storage", type your Mac password and click Always Allow, then press Retry.' },
        steps: [{ key: 'pc', label: 'This computer', state: 'problem', text: 'Its saved sign-in is locked. Allow access, then Retry.', action: 'retry' }] },
      pending: { ...base, ...notLive, phase: 'pending_approval', message: { level: 'setup', text: 'Almost there. On your host dashboard, click Approve for "STREAM-PC".' },
        steps: [{ key: 'pc', label: 'This computer', state: 'todo', text: 'Waiting for you to click Approve on your dashboard.', action: 'dashboard' }] },
      pair: { ...base, phase: 'unpaired' },
      test: { ...base, dryRun: true, atom: 'hold', hold: 'test', message: { level: 'ok', text: 'Connected to @the_boneyard_ai. Test mode: taps are checked, nothing is added to the bar.' },
        steps: doneSteps.map((r) => (r.key === 'send' ? { ...r, state: 'test', text: 'Test mode is on: taps are checked, nothing is added.' } : r)) },
    };
    const pick = new URLSearchParams(location.search).get('demo') || 'live';
    setTimeout(() => listeners.forEach((f) => f(states[pick] || base)), 0);
    return {
      getState: async () => states[pick] || base,
      getSettings: async () => ({ notify: true, startWithWindows: true, dryRun: pick === 'test', deviceName: 'STREAM-PC', version: '1.0.5', testServer: null, platform: pick === 'locked' ? 'darwin' : 'win32' }),
      pair: async (c) => (c === 'TEST2345' ? { ok: true } : { ok: false, code: 'invalid_code' }),
      unpair: async () => true, retry: async () => true, setSetting: async () => true, open: async () => true,
      onState: (f) => { listeners.push(f); return () => {}; },
    };
  }
})();
