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
    renderManual(s);
    if (show) renderShow(show);   // the recording card follows the connection (shown once this computer is ready)
  }

  // ---------------------------------------------------------------- update banner
  // 2.0.5: the update downloads by itself (never during a LIVE, a recording or while clips are made) and installs on
  // "Restart to update". Without the in-app updater (demo), it falls back to the download link.
  let upd = null;
  const WAIT_FOR = { recording: 'your recording ends', clips: 'your clips are done', live: 'your LIVE ends' };
  function renderUpdate(s) {
    s = s || current || {};
    const need = s.phase === 'update_required', avail = !!(s.update && s.update.available);
    const u = upd && upd.status !== 'idle' ? upd : null;
    const banner = $('update-banner'), btn = $('update-btn'), text = $('update-text');
    banner.classList.toggle('hidden', !need && !avail && !u);
    renderUpdateSetting();
    if (banner.classList.contains('hidden')) return;
    const v = (u && u.version) || (s.update && s.update.version) || '';
    const show = (label, action, disabled = false) => { btn.textContent = label; btn.dataset.action = action; btn.disabled = disabled; btn.classList.remove('hidden'); };
    btn.classList.add('hidden');
    if (u && u.status === 'ready') { text.textContent = u.blocked ? `LIVE Link ${v} is ready. It can install once ${WAIT_FOR[u.blocked] || 'you finish'}.` : `LIVE Link ${v} is ready to install.`; show('Restart to update', 'install', !!u.blocked); return; }
    if (u && u.status === 'downloading') { text.textContent = `Downloading LIVE Link ${v}... ${Math.round((u.progress || 0) * 100)}%`; return; }
    if (u && u.status === 'installing') { text.textContent = `Installing LIVE Link ${v}. It opens again by itself in a moment.`; return; }
    if (u && u.status === 'waiting') { text.textContent = `LIVE Link ${v} is out. It downloads by itself once ${WAIT_FOR[u.blocked] || 'your LIVE ends'}.`; return; }
    if (u && u.status === 'error') { text.textContent = `Couldn't download LIVE Link ${v}.`; show('Try again', 'retry'); return; }
    text.textContent = need ? 'This version is too old to send taps. Get the new one.' : `LIVE Link ${v} is out.`;
    show('Download', 'open');
  }
  $('update-btn').addEventListener('click', async () => {
    const a = $('update-btn').dataset.action;
    if (a === 'install' && bridge.installUpdate) {
      $('update-btn').disabled = true;
      const r = await bridge.installUpdate();
      if (!r || !r.ok) { $('update-text').textContent = r && WAIT_FOR[r.error] ? `It can install once ${WAIT_FOR[r.error]}.` : "Couldn't start the installer. Use Download instead."; $('update-btn').disabled = false; if (!(r && WAIT_FOR[r.error])) { $('update-btn').textContent = 'Download'; $('update-btn').dataset.action = 'open'; } }
    } else if (a === 'retry' && bridge.retryUpdate) bridge.retryUpdate();
    else bridge.open('update');
  });
  // Settings > Version: the status and one button (Check for updates / Restart to update).
  function renderUpdateSetting(note) {
    const b = $('s-update-btn'); if (!b) return;
    const base = (settingsVersion || '-');
    const u = upd || {};
    let status = note || '';
    if (!status) status = u.status === 'ready' ? `${u.version} ready to install` : u.status === 'downloading' ? `downloading ${u.version} (${Math.round((u.progress || 0) * 100)}%)` : u.status === 'waiting' ? `${u.version} downloads after ${WAIT_FOR[u.blocked] || 'your LIVE'}` : u.status === 'error' ? "couldn't download the update" : '';
    $('s-version').textContent = status ? `${base} · ${status}` : base;
    b.textContent = u.status === 'ready' ? 'Restart to update' : 'Check for updates';
    b.disabled = u.status === 'downloading' || u.status === 'installing' || (u.status === 'ready' && !!u.blocked);
  }
  let settingsVersion = null;
  $('s-update-btn').addEventListener('click', async () => {
    if (upd && upd.status === 'ready') { $('update-btn').dataset.action = 'install'; $('update-btn').click(); return; }
    if (!bridge.checkForUpdates) return;
    renderUpdateSetting('checking...');
    const r = await bridge.checkForUpdates();
    if (r && r.updater) upd = r.updater;
    renderUpdate();
    if (r && r.update && !r.update.available) renderUpdateSetting('up to date');
  });
  if (bridge.onUpdater) { bridge.onUpdater((u) => { upd = u; renderUpdate(); }); bridge.getUpdater().then((u) => { upd = u; renderUpdate(); }); }

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
    const todo = steps.find((st) => (st.state === 'todo' || st.state === 'problem') && (st.action === 'dashboard' || st.action === 'retry' || st.action === 'manual'));
    const sendOff = s.phase === 'ready' && steps.some((st) => st.key === 'send' && st.state === 'off');
    let label, cls, act;
    if (s.phase === 'update_required') { label = 'Download update'; cls = 'next'; act = () => bridge.open('update'); }
    else if (s.phase === 'locked') { label = 'Retry'; cls = 'next'; act = () => bridge.retry(); }
    else if (todo) {
      label = todo.action === 'retry' ? 'Retry' : todo.action === 'manual' ? 'Paste your LIVE link' : 'Open dashboard'; cls = 'next';
      act = () => (todo.action === 'retry' ? bridge.retry() : todo.action === 'manual' ? openManual() : bridge.open('dashboard'));
    }
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
        btn.textContent = st.action === 'check' ? 'Check now' : st.action === 'retry' ? 'Retry' : st.action === 'manual' ? 'Paste LIVE link' : 'Open dashboard';
        btn.addEventListener('click', () => (st.action === 'check' || st.action === 'retry' ? bridge.retry() : st.action === 'manual' ? openManual() : bridge.open('dashboard')));
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
    settingsVersion = st.version || '-';
    renderUpdateSetting();
    $('s-record').checked = st.recordEnabled !== false;
    $('s-record').disabled = st.recordAvailable === false;
    $('s-recroot').textContent = st.recordRoot || '-';
    $('s-momentkey').value = st.momentKey || 'F8';
    momentKeyNote(st.momentKeyOk !== false);
    const ts = $('s-testserver');
    ts.classList.toggle('hidden', !st.testServer);
    if (st.testServer) ts.textContent = `Connected to a TEST server: ${st.testServer}`;
    $('settings').classList.remove('hidden');
  }
  $('gear').addEventListener('click', openSettings);
  function openManual() { openSettings().then(() => { const i = $('manual-input'); i.scrollIntoView({ block: 'center' }); i.focus(); }); }
  const MANUAL_ERRORS = {
    not_watching: "LIVE Link isn't watching TikTok yet: finish the setup steps first.",
    not_a_link: "That isn't a TikTok LIVE link or room ID.", not_tiktok: "That isn't a TikTok link.",
    no_room_id: "That link doesn't include your LIVE's room number. While you're LIVE, use TikTok's Share button, then Copy link, and paste that.",
    link_unreachable: "Couldn't open that link. Paste it again, or paste the room ID.",
  };
  function renderManual(s) {
    const el = $('manual-status');
    if (s && s.manualRoom) {
      el.className = 'manual-status';
      el.textContent = `Using your pasted LIVE (room ...${String(s.manualRoom).slice(-5)}) until it ends.`;
      const b = document.createElement('button'); b.className = 'link'; b.type = 'button'; b.textContent = 'Stop using it';
      b.addEventListener('click', async () => { await bridge.setManualRoom(''); el.classList.add('hidden'); });
      el.append(b);
    } else if (!el.classList.contains('bad')) el.classList.add('hidden');
  }
  $('manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('manual-input').value.trim();
    if (!text || !bridge.setManualRoom) return;
    const btn = $('manual-btn'); btn.disabled = true;
    const r = await bridge.setManualRoom(text);
    btn.disabled = false;
    const el = $('manual-status');
    if (r && r.ok) { $('manual-input').value = ''; el.className = 'manual-status'; el.textContent = 'Got it: LIVE Link is connecting to that LIVE now.'; }
    else {
      el.className = 'manual-status bad';
      el.textContent = r && r.error === 'other_account' ? `That link is for @${r.handle}, but your verified TikTok is @${(current && current.tiktokUsername) || ''}.`
        : MANUAL_ERRORS[r && r.error] || "That didn't work. Check the link and try again.";
    }
  });
  $('close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
  $('s-autostart').addEventListener('change', (e) => bridge.setSetting('startWithWindows', e.target.checked));
  $('s-dry').addEventListener('change', (e) => bridge.setSetting('dryRun', e.target.checked));
  $('s-notify').addEventListener('change', (e) => bridge.setSetting('notify', e.target.checked));
  $('s-record').addEventListener('change', (e) => bridge.setSetting('recordEnabled', e.target.checked));
  function momentKeyNote(ok) {
    const n = $('s-momentkey-note');
    n.textContent = ok ? 'Works while TikTok LIVE Studio is in front. Only held while LIVE Link is recording.' : 'Another app is using that key. Pick a different one.';
    n.classList.toggle('bad', !ok);
  }
  $('s-momentkey').addEventListener('change', async (e) => {
    const r = await bridge.setSetting('momentKey', e.target.value);
    momentKeyNote(!(r && r.ok === false));
  });
  $('s-recroot-btn').addEventListener('click', async () => {
    const r = await bridge.chooseRecordFolder();
    if (r && r.root) $('s-recroot').textContent = r.root;
    else if (r && r.error === 'recording') $('s-recroot').textContent += ' (change it after this LIVE ends)';
  });
  $('unpair').addEventListener('click', async () => {
    if (!confirm('Remove this computer from your account? It stops sending taps until you connect it again with a new code from your dashboard. (To stop for a while, use Pause instead.)')) return;
    await bridge.unpair();
    $('settings').classList.add('hidden');
  });

  bridge.onState(render);
  bridge.getState().then(render);

  // ------------------------------------------------------------ recording + review clips (2.0)
  const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, Math.round((n || 0) / 1024 ** 2))} MB`);
  const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
  let show = null, previewAt = 0;
  function renderShow(st) {
    if (!st) return;
    show = st;
    const r = st.recording || {};
    const card = $('rec');
    card.classList.toggle('hidden', !current || current.phase !== 'ready');
    $('rec-dot').className = 'rec-dot' + (r.recording && r.video !== false ? ' on' : (r.recording || (st.enabled && st.ffmpegOk)) ? ' armed' : '');
    let title, note, detail = null, failed = false, retry = false;
    if (!st.ffmpegOk) { title = 'Recording unavailable'; note = 'This copy of LIVE Link is missing its recorder. Download the latest version from your dashboard.'; failed = !!st.live; }
    else if (r.recording && r.failure) {
      // LIVE, but nothing has been saved for a minute: red, with the reason, what to do, and what TikTok answered.
      failed = true; retry = true;
      const mins = Math.max(1, Math.round((Date.now() - (r.failure.since || Date.now())) / 60000));
      title = 'Not recording';
      note = `${r.failure.text}. ${FAIL_HELP[r.failure.reason] || ''} Nothing saved for ${mins} min${r.nextTryAt ? `; next try ${fmtIn(r.nextTryAt - Date.now())}` : ''}.`;
      detail = r.failure.detail ? `What TikTok answered: ${r.failure.detail}` : null;
    }
    else if (r.recording && !r.video) {
      const secs = r.waitingSince ? Math.round((Date.now() - r.waitingSince) / 1000) : 0;
      title = 'Starting the recording...';
      note = `Your LIVE is on. Waiting for TikTok to send the video${secs > 5 ? ` (${secs} s)` : ''}; LIVE Link asks again every few seconds. If nothing arrives within a minute, this card turns red with the reason.`;
      retry = secs > 20;
    }
    else if (r.recording) { title = 'Recording your LIVE'; note = st.clipsOn ? 'When your LIVE ends, every song review becomes a clip for the artist.' : 'Saved on this computer. Review clips start once the site switches them on for your channel.'; }
    else if (r.error === 'disk_full') { title = 'Not recording: disk almost full'; note = 'Less than 2 GB free. Delete old recordings (Recordings) or pick another folder in Settings.'; failed = !!st.live; }
    else if (r.error === 'folder' && st.live) { title = 'Not recording'; note = "LIVE Link can't write to your recordings folder. Pick another folder in Settings."; failed = true; }
    else if (!st.enabled) { title = 'Recording is off'; note = 'Switch it on in Settings to record your LIVEs and make review clips.'; }
    else if (st.live && st.hostStopped) { title = 'Recording stopped'; note = 'You stopped it for this LIVE. Press Record to start again.'; }
    else if (st.live) { title = 'Starting the recording...'; note = 'Getting your LIVE from TikTok.'; }
    else { title = 'Ready to record'; note = 'Your next TikTok LIVE is recorded automatically.'; }
    // After the LIVE: keep-open while clips are made, then a clear "safe to close".
    const done = renderAfterShow(st, r);
    if (done) { title = done.title; note = done.note; }
    renderMoment(st, r);
    card.classList.toggle('failed', failed && !done);
    if (failed && !done) $('rec-dot').className = 'rec-dot fail';
    $('rec-title').textContent = title;
    $('rec-note').textContent = note;
    const det = $('rec-detail');
    det.classList.toggle('hidden', !detail || !!done);
    det.textContent = detail || '';
    $('rec-retry').classList.toggle('hidden', !retry || !!done || !bridge.retryRecording);
    const remind = $('rec-remind');
    remind.classList.toggle('hidden', !(st.storage && st.storage.remind));
    if (st.storage && st.storage.remind) remind.textContent = `Your recordings use ${fmtBytes(st.storage.totalBytes)}${st.storage.freeBytes != null ? ` and ${fmtBytes(st.storage.freeBytes)} is free` : ''}. Open Recordings to clear the ones you don't need.`;
    const tg = $('rec-toggle');
    tg.classList.toggle('hidden', !st.ffmpegOk || !(r.recording || (st.live && st.enabled)));
    tg.textContent = r.recording ? 'Stop recording' : 'Record';
    tickRec();
    if (r.recording && r.previewAt && r.previewAt !== previewAt && bridge.getPreview) {
      previewAt = r.previewAt;
      bridge.getPreview().then((src) => { const img = $('rec-preview'); if (src) { img.src = src; img.classList.remove('hidden'); } });
    }
    if (!r.recording) $('rec-preview').classList.add('hidden');
    if (!$('recordings').classList.contains('hidden')) loadRecordings();
  }
  // What a host can do about each reason (the reason itself is in r.failure.text).
  const FAIL_HELP = {
    stream_restricted: 'If your LIVE is set to adults only (18+) or another audience limit, turn that off for your next LIVE. LIVE Link keeps trying.',
    stream_blocked: 'Try another network (a phone hotspot) or restart your router. LIVE Link keeps trying.',
    stream_unavailable: 'LIVE Link keeps asking. If it lasts, press Try again now, then send your recording folder (session.json) to support.',
    recording_failed: 'LIVE Link keeps trying other video qualities. If it lasts, send your recording folder (session.json) and log folder to support.',
  };
  const fmtIn = (ms) => (ms <= 1500 ? 'now' : ms < 90000 ? `in ${Math.round(ms / 1000)} s` : `in ${Math.round(ms / 60000)} min`);
  $('rec-retry').addEventListener('click', async () => {
    const b = $('rec-retry');
    b.disabled = true; b.textContent = 'Asking TikTok...';
    try { if (bridge.retryRecording) await bridge.retryRecording(); } catch {}
    setTimeout(() => { b.disabled = false; b.textContent = 'Try again now'; }, 2500);
  });
  // The card after a LIVE. Busy: "Keep LIVE Link open" with what it's doing and a progress bar. Done: "safe to close".
  function renderAfterShow(st, r) {
    const bar = $('rec-progress');
    const card = $('rec');
    card.classList.remove('working', 'all-done');
    bar.classList.add('hidden');
    if (r.recording) return null;
    const c = st.clips;
    if (st.busy) {
      card.classList.add('working');
      let note = 'Your LIVE ended. Your clips start in a moment.', pct = null;
      if (c && c.phase === 'reviews') note = 'Finding the reviews from your LIVE...';
      else if (c && c.phase === 'clip') { note = `Making review clips: ${c.index} of ${c.total}${c.title ? ` · ${c.title}` : ''}. About ${Math.max(1, Math.round((c.total - c.index + 1) * 1.5))} min left.`; pct = (c.index - 1) / Math.max(1, c.total); }
      else if (c && c.phase === 'full') { note = `Every artist has their clip. Uploading the full reviews: ${c.index} of ${c.total}.`; pct = (c.index - 1) / Math.max(1, c.total); }
      else if (c && c.phase === 'moment') { note = `Making your "Clip that" moments: ${c.index} of ${c.total}.`; pct = (c.index - 1) / Math.max(1, c.total); }
      else if (c && c.phase === 'fullshow') note = 'Saving your full show as one file...';
      if (pct !== null) { bar.classList.remove('hidden'); $('rec-progress-bar').style.width = `${Math.round(pct * 100)}%`; bar.setAttribute('aria-valuenow', String(Math.round(pct * 100))); }
      return { title: 'Keep LIVE Link open: finishing your clips', note };
    }
    if (st.doneAt && st.lastClips && st.lastClips.notRecorded) {
      return { title: "Done: this LIVE wasn't recorded", note: `No review clips: nothing of the LIVE was saved, so there was nothing to cut. Recordings shows why. It's safe to close LIVE Link.` };
    }
    if (st.doneAt && st.lastClips) {
      card.classList.add('all-done');
      const l = st.lastClips;
      const bits = [];
      if (l.sent) bits.push(`${l.sent} review clip${l.sent === 1 ? '' : 's'} sent`);
      if (l.failed) bits.push(`${l.failed} didn't send: open Recordings and press Make & send clips`);
      if (st.lastFullShow) bits.push('full show saved');
      return { title: l.failed ? 'Done: some clips need resending' : 'All done: safe to close LIVE Link', note: bits.join(' · ') };
    }
    if (st.doneAt && st.lastFullShow) { card.classList.add('all-done'); return { title: 'All done: safe to close LIVE Link', note: 'Your full show is saved.' }; }
    return null;
  }

  // "Clip that": only while recording. The label shows the hotkey; each new mark (button or hotkey) flashes "Marked!".
  let momentFlash = null, lastMoments = null;
  function renderMoment(st, r) {
    const box = $('moment');
    // Only once video is coming in: a mark before that has nothing to clip.
    box.classList.toggle('hidden', !r.recording || r.video === false);
    if (!r.recording || r.video === false) { if (!r.recording) lastMoments = null; return; }
    const key = st.momentKey && st.momentKey !== 'off' ? st.momentKey : null;
    $('moment-key').textContent = key || '';
    $('moment-key').classList.toggle('hidden', !key);
    const n = r.moments || 0;
    if (lastMoments !== null && n > lastMoments) flashMarked();
    lastMoments = n;
    if (!momentFlash) $('moment-label').textContent = 'Clip that';
    $('moment-note').textContent = n
      ? `${n} moment${n === 1 ? '' : 's'} marked. Each becomes a 45-second phone clip after your LIVE.${st.momentKeyOk === false ? ' (Your hotkey is taken by another app: change it in Settings.)' : ''}`
      : `Something wild just happened? ${key ? `Press ${key} or this button` : 'Press this button'}: the last 35 seconds become a clip after your LIVE.`;
  }
  function flashMarked() {
    const b = $('moment-btn');
    b.classList.add('marked');
    $('moment-label').textContent = 'Marked!';
    clearTimeout(momentFlash);
    momentFlash = setTimeout(() => { momentFlash = null; b.classList.remove('marked'); $('moment-label').textContent = 'Clip that'; }, 1400);
  }
  $('moment-btn').addEventListener('click', () => { if (bridge.markMoment) bridge.markMoment(); });
  function tickRec() {
    const r = show && show.recording;
    $('rec-meta').textContent = r && r.recording ? `${fmtClock(Date.now() - r.startedAt)} · ${fmtBytes(r.bytes)}` : '';
  }
  // Once a second: the recording clock, and the "waiting for TikTok's video (N s)" count while it waits.
  setInterval(() => { const r = show && show.recording; if (r && r.recording && (r.video === false || r.failure)) renderShow(show); else tickRec(); }, 1000);
  $('rec-toggle').addEventListener('click', () => (show && show.recording && show.recording.recording ? bridge.stopRecording() : bridge.startRecording()));
  $('rec-open').addEventListener('click', () => bridge.openRecording(show && show.recording && show.recording.recording ? show.recording.dir : ''));
  $('rec-manage').addEventListener('click', () => { $('recordings').classList.remove('hidden'); loadRecordings(); });
  $('rec-folder').addEventListener('click', () => bridge.openRecording(''));
  $('close-recordings').addEventListener('click', () => $('recordings').classList.add('hidden'));

  async function loadRecordings() {
    const list = (await bridge.listRecordings()) || [];
    const ol = $('rec-list');
    ol.textContent = '';
    $('rec-empty').classList.toggle('hidden', list.length > 0);
    const total = list.reduce((n, x) => n + (x.bytes || 0), 0);
    $('rec-summary').textContent = list.length ? `${list.length} recording${list.length === 1 ? '' : 's'} · ${fmtBytes(total)}${show && show.storage && show.storage.freeBytes != null ? ` · ${fmtBytes(show.storage.freeBytes)} free` : ''}. Kept until you delete them.` : '';
    for (const x of list) {
      const li = document.createElement('li');
      const head = document.createElement('div'); head.className = 'rl-head';
      const when = new Date(x.startedAt || Date.now());
      const t = document.createElement('b'); t.textContent = `${when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      const meta = document.createElement('span'); meta.className = 'rl-meta';
      const dur = x.endedAt ? fmtClock(x.endedAt - x.startedAt) : 'recording now';
      const clips = x.working ? 'making clips...' : x.clips.sent ? `${x.clips.sent} clip${x.clips.sent === 1 ? '' : 's'} sent${x.clips.failed ? `, ${x.clips.failed} failed` : ''}` : x.clips.failed ? `${x.clips.failed} clip${x.clips.failed === 1 ? '' : 's'} failed` : 'no clips yet';
      const mo = x.moments || { marked: 0, made: 0 };
      const moments = mo.marked ? ` · ${mo.made} of ${mo.marked} moment clip${mo.marked === 1 ? '' : 's'}` : '';
      const full = x.fullShow ? ' · full show saved' : '';
      // Nothing of the LIVE saved: never listed like a normal recording.
      const bad = x.failed;
      meta.textContent = bad && !x.recording
        ? `@${x.handle || ''} · ${dur} LIVE · nothing saved${clips === 'no clips yet' ? '' : ` · ${clips}`}`
        : `@${x.handle || ''} · ${dur} · ${fmtBytes(x.recordedBytes != null ? x.recordedBytes : x.bytes)} · ${clips}${moments}${full}`;
      head.append(t, meta);
      if (bad) {
        li.classList.add('failed');
        const why = document.createElement('span'); why.className = 'rl-fail';
        why.textContent = `${x.recording ? 'Not recording' : 'Recording failed'}: ${bad.text}${bad.detail ? ` (${bad.detail})` : ''}`;
        head.append(why);
      }
      const acts = document.createElement('div'); acts.className = 'rl-acts';
      const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `ghost small ${cls || ''}`; b.textContent = label; b.addEventListener('click', fn); acts.append(b); return b; };
      btn('Open', '', () => bridge.openRecording(x.dir));
      if (x.fullShow && bridge.openFullShow) btn('Open full show', '', () => bridge.openFullShow(x.dir));
      else if (!x.recording && !x.working && x.endedAt && bridge.makeFullShow) btn('Make full show', '', async () => { const r = await bridge.makeFullShow(x.dir); if (r && r.ok) loadRecordings(); });
      if (mo.made && bridge.openMoments) btn('Open moments', '', () => bridge.openMoments(x.dir));
      const canMake = show && (show.clipsOn || mo.marked > mo.made);
      if (!x.recording && canMake && !x.working) btn(show.clipsOn ? 'Make & send clips' : 'Make moment clips', '', async () => { const r = await bridge.makeClips(x.dir); if (!r || !r.ok) meta.textContent += ` · ${r && r.error === 'clips_off' ? 'clips are not switched on for your channel yet' : "couldn't start"}`; else loadRecordings(); });
      if (!x.recording && !x.working) {
        const del = btn('Delete', 'danger', async () => {
          if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Delete for good?'; setTimeout(() => { del.dataset.sure = ''; del.textContent = 'Delete'; }, 4000); return; }
          const r = await bridge.deleteRecording(x.dir);
          if (r && r.ok) loadRecordings(); else meta.textContent += " · couldn't delete";
        });
      }
      li.append(head, acts);
      ol.append(li);
    }
  }

  if (bridge.onShow) { bridge.onShow(renderShow); bridge.getShow().then(renderShow); }

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
      notrec: { ...base, recordingIssue: { reason: 'stream_restricted' },
        steps: [...doneSteps.slice(0, 4), { key: 'rec', label: 'Recording', state: 'problem', text: "Not recording: TikTok won't share this LIVE's video (restricted, often 18+).", action: 'check' }, doneSteps[4]] },
      error: { ...base, ...notLive, tiktok: { status: 'error', errorKind: 'timeout' }, message: { level: 'warn', text: "TikTok isn't answering right now (your internet works). LIVE Link keeps trying by itself." },
        steps: doneSteps.map((r) => (r.key === 'live' ? { key: 'live', label: 'TikTok LIVE', state: 'problem', text: "TikTok isn't answering (your internet works).", retryAt: Date.now() + 40000, action: 'check' } : r)) },
      blocked: { ...base, ...notLive, tiktok: { status: 'error', errorKind: 'blocked' }, message: { level: 'warn', text: 'TikTok is temporarily blocking lookups from this network. Wait a few minutes, try a phone hotspot, or paste your LIVE link in Settings.' },
        steps: doneSteps.map((r) => (r.key === 'live' ? { key: 'live', label: 'TikTok LIVE', state: 'problem', text: 'TikTok is blocking LIVE lookups from this network for now.', retryAt: Date.now() + 60000, action: 'manual' } : r)) },
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
      setManualRoom: async (t) => (/\d{15,}/.test(t) ? { ok: true } : { ok: false, error: 'no_room_id' }),
      onState: (f) => { listeners.push(f); return () => {}; },
      // recording demo: ?demo=live shows a recording in progress
      getShow: async () => ({ ffmpegOk: true, enabled: true, clipsOn: true, live: pick === 'live' || pick === 'starting' || pick === 'notrec', hostStopped: false, root: 'C:\\Users\\host\\Videos\\LIVE Link Recordings',
        momentKey: 'F8', momentKeyOk: true,
        recording: pick === 'notrec' ? { recording: true, video: false, waitingSince: Date.now() - 95000, startedAt: Date.now() - 95000, bytes: 0, previewAt: 0, moments: 0, nextTryAt: Date.now() + 9000,
            failure: { reason: 'stream_restricted', since: Date.now() - 95000, text: "TikTok won't share this LIVE's video with LIVE Link (it answers 'restricted', code 4003110), which usually means the LIVE is limited to adults (18+) or to signed-in viewers", detail: "room info: status 4003110 (restricted) · api-live: no video links · LIVE page: TikTok's bot check (WAF page) · kept room info: status 4003110 (restricted)" } }
          : pick === 'starting' ? { recording: true, video: false, waitingSince: Date.now() - 22000, startedAt: Date.now() - 22000, bytes: 0, previewAt: 0, moments: 0 }
          : { recording: pick === 'live', video: true, startedAt: Date.now() - 42 * 60000, bytes: 3.1 * 1024 ** 3, previewAt: 0, moments: 2 },
        clips: pick === 'working' ? { phase: 'clip', index: 12, total: 31, title: 'Neon Override' } : null,
        busy: pick === 'working', doneAt: pick === 'done' ? Date.now() : null,
        lastClips: pick === 'done' ? { sent: 31, failed: 0, total: 31 } : null, lastFullShow: pick === 'done' ? { files: ['x - full show.mp4'] } : null,
        storage: { totalBytes: 61 * 1024 ** 3, freeBytes: 24 * 1024 ** 3, remind: pick === 'waiting' } }),
      onShow: () => () => {},
      getPreview: async () => null,
      listRecordings: async () => [
        { dir: 'a', handle: 'the_boneyard_ai', startedAt: Date.now() - 42 * 60000, endedAt: null, recording: true, bytes: 3.1 * 1024 ** 3, clips: { sent: 0, failed: 0 }, working: false },
        { dir: 'b', handle: 'the_boneyard_ai', startedAt: Date.now() - 3 * 86400000, endedAt: Date.now() - 3 * 86400000 + 2.4 * 3600000, recording: false, bytes: 8.7 * 1024 ** 3, clips: { sent: 11, failed: 1 }, moments: { marked: 4, made: 4 }, fullShow: ['b - full show.mp4'], working: false },
        { dir: 'c', handle: 'the_boneyard_ai', startedAt: Date.now() - 7 * 86400000, endedAt: Date.now() - 7 * 86400000 + 1.9 * 3600000, recording: false, bytes: 6.2 * 1024 ** 3, clips: { sent: 9, failed: 0 }, working: false },
        { dir: 'd', handle: 'the_boneyard_ai', startedAt: Date.now() - 9 * 86400000, endedAt: Date.now() - 9 * 86400000 + 3.1 * 3600000, recording: false, bytes: 9000, recordedBytes: 0, clips: { sent: 0, failed: 0, skipped: 26 }, working: false,
          failed: { reason: 'stream_unavailable', text: 'TikTok never gave LIVE Link the video for this LIVE (no video address)', detail: null } },
      ],
      openRecording: async () => true, deleteRecording: async () => ({ ok: true }), makeClips: async () => ({ ok: true }),
      stopRecording: async () => true, startRecording: async () => true, chooseRecordFolder: async () => null,
      markMoment: async () => ({ ok: true, count: 3 }), openMoments: async () => true,
      getUpdater: async () => (pick === 'update' ? { status: 'ready', version: '2.0.5', progress: 1, blocked: null } : pick === 'downloading' ? { status: 'downloading', version: '2.0.5', progress: 0.42 } : { status: 'idle' }),
      onUpdater: () => () => {}, checkForUpdates: async () => ({ update: { available: false }, updater: { status: 'idle' } }),
      retryUpdate: async () => ({}), installUpdate: async () => ({ ok: true }), makeFullShow: async () => ({ ok: true }), openFullShow: async () => true,
      retryRecording: async () => true,
    };
  }
})();
