// VTuber Mask: the music the mask moves to, with nothing for the owner to do. Three sources, best first:
//   1. 'pc'    what this PC plays: sound-loopback.ps1 (a hidden helper this file starts) listens to the default playback
//              device like a level meter; this file turns its samples into a spectrum 60 times a second and that into
//              mask/audio-features.js' numbers (bass / mid / high, kicks, drops). No window, no share list, no click.
//   2. 'obs'   OBS's own meter of its desktop-audio input (obs-websocket InputVolumeMeters over the link the app
//              already holds): loudness and kicks only. Used when the helper cannot listen or hears nothing while OBS does.
//   3. 'voice' his microphone level (the page already sends it): the avatar page turns it into numbers itself.
// Which one is in use is told to the page in plain words (state().src). Nothing is recorded, nothing leaves this PC.
// Tests never listen to the real PC: a test run only starts a helper it names itself (opts.cmd, a pretend one).
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const Wire = require('./js/mask-wire.js');
const Audio = require('./mask/audio-features.js');

const N = 2048, RATE = 60;
const WINDOW = new Float64Array(N);
for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / N; WINDOW[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a); }   // Blackman, as a browser's analyser
const REV = new Uint16Array(N);
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < 11; b++) r |= ((i >> b) & 1) << (10 - b); REV[i] = r; }
const COS = new Float64Array(N / 2), SIN = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / N); SIN[i] = Math.sin(2 * Math.PI * i / N); }
/** the last N samples -> decibels per bin, as AnalyserNode.getFloatFrequencyData gives them (no smoothing) */
function spectrumDb(samples, out, re, im) {
  for (let i = 0; i < N; i++) { re[REV[i]] = samples[i] * WINDOW[i]; im[REV[i]] = 0; }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], sn = -SIN[k * step], a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i < N / 2; i++) { const m = Math.hypot(re[i], im[i]) / N; out[i] = m > 1e-8 ? 20 * Math.log10(m) : -160; }
  return out;
}

/**
 * createSound({ log, cmd, allowReal, onAudio }) -> { want(on), meters(eventData), meterInputs(names), state(), stop() }
 *   cmd: [exe, ...args] of the helper (tests: a pretend one). Without it the real helper is started only when allowReal.
 *   onAudio(message): { t: 'mask-audio', s: 'pc' | 'obs' | 'voice', f?: [bass, mid, high, beat, kick, hit, level, bright] }
 */
function createSound({ log = () => {}, cmd = null, allowReal = false, onAudio = () => {}, platform = process.platform } = {}) {
  // the real helper is a Windows PowerShell script: anywhere else (macOS, Linux) there is none, and the order is
  // OBS's own meter of its desktop sound, then his voice (V6; system sound on a Mac is a later experiment)
  if (platform !== 'win32') allowReal = false;
  const S = { want: false, src: 'voice', pc: cmd || allowReal ? 'idle' : 'off', pcLoudAt: -1e12, obsAt: -1e12, obsLoudAt: -1e12, tries: 0, stopped: false, since: 0, pcError: '' };
  let proc = null, timer = null, restart = null, rate = 48000, an = null, headBuf = Buffer.alloc(0), odd = null;
  const RING = 16384;                                    // a third of a second: room for a late clock tick
  const ring = new Float32Array(RING), frame = new Float32Array(N), db = new Float32Array(N / 2), re = new Float64Array(N), im = new Float64Array(N);
  // written: samples taken so far; nextEnd: where the next analysis window ends. Windows are cut every 1/60 s of SOUND
  // (not of the clock, which on Windows ticks every 15 ms or so), so the analysis sees the song evenly.
  let written = 0, nextEnd = N, dataAt = 0, lastTick = 0, voiceAt = 0;
  const follower = Wire.levelFollower();
  let meterNames = null;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const pack = (f) => [r3(f.bass), r3(f.mid), r3(f.high), r3(f.beat), r3(f.kick || 0), r3(f.hit || 0), r3(f.level), r3(f.bright === undefined ? 0.8 : f.bright)];

  function push(v) { ring[written % RING] = v; written++; }
  function onData(d) {
    if (odd) { d = Buffer.concat([odd, d]); odd = null; }
    if (S.pc !== 'on') {                                   // the first bytes: "VTSL" + the sample rate
      headBuf = Buffer.concat([headBuf, d]);
      if (headBuf.length < 8) return;
      if (headBuf.subarray(0, 4).toString('latin1') !== 'VTSL') { log('the sound helper said something else: not used'); killProc(); S.pc = 'failed'; return; }
      rate = headBuf.readInt32LE(4) || 48000;
      an = Audio.create({ sampleRate: rate, fftSize: N, rate: RATE });
      S.pc = 'on'; S.tries = 0; written = 0; nextEnd = N; ring.fill(0);
      log('listening to what this PC plays (' + rate + ' Hz)');
      d = headBuf.subarray(8); headBuf = Buffer.alloc(0);
    }
    const n = d.length & ~1;
    for (let i = 0; i < n; i += 2) push(d.readInt16LE(i) / 32768);
    if (d.length > n) odd = d.subarray(n);
    if (n) dataAt = Date.now();
  }
  function killProc() { const p = proc; proc = null; if (p) { try { p.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 800).unref(); } }
  function startProc() {
    if (proc || S.stopped || S.pc === 'off' || S.pc === 'failed') return;
    const c = cmd || ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sound-loopback.ps1')];
    let p;
    try { p = spawn(c[0], c.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { S.pc = 'failed'; S.pcError = String(e && e.message); return; }
    proc = p; S.pc = 'starting'; headBuf = Buffer.alloc(0); odd = null;
    let err = '';
    p.stdout.on('data', (d) => { if (proc === p) onData(d); });
    p.stderr.on('data', (d) => { if (err.length < 400) err += d.toString(); });
    p.stdin.on('error', () => {});
    p.on('error', () => { if (proc === p) { proc = null; S.pc = 'failed'; } });
    p.on('exit', (code) => {
      if (proc !== p) return;
      proc = null;
      if (S.stopped || !S.want) { S.pc = 'idle'; return; }
      S.pcError = err.trim().split(/\r?\n/)[0] || ('ended (' + code + ')');
      if (++S.tries > 5) { S.pc = 'failed'; log('the PC-sound helper keeps ending (' + S.pcError + '): OBS\'s sound level or his voice is used instead'); return; }
      S.pc = 'starting';
      clearTimeout(restart); restart = setTimeout(startProc, 3000);
    });
  }

  function choose(now) {
    const pcOn = S.pc === 'on', pcLoud = pcOn && now - S.pcLoudAt < 4000, obsOn = now - S.obsAt < 1500, obsLoud = obsOn && now - S.obsLoudAt < 4000;
    // what the PC plays when it can be heard (or when nothing else hears anything either); OBS's meter when only it hears
    // something for 4 s; his voice when neither is there
    let next = pcLoud ? 'pc' : obsLoud ? 'obs' : pcOn ? 'pc' : obsOn ? 'obs' : 'voice';
    if (next !== S.src && now - S.since < 1500 && !(next === 'pc' && pcLoud)) next = S.src;   // no flapping
    if (next !== S.src) { S.src = next; S.since = now; log('the mask\'s music now comes from: ' + (next === 'pc' ? 'what this PC plays' : next === 'obs' ? 'OBS\'s sound level' : 'his voice')); }
  }
  function tick() {
    const now = Date.now();
    if (S.pc === 'on' && an) {
      // nothing playing = no samples come: silence is filled in at the clock's pace
      // (200 ms, not 70: a helper or a busy PC that hands the samples over in 80 - 100 ms pieces is not silence. With 70,
      // zeros were mixed in between the pieces, the spectrum was wrong and the Mask's drop never fired: fix round, Nov 19)
      if (now - dataAt > 200) { const n = Math.min(N, Math.round((now - Math.max(lastTick, dataAt)) * rate / 1000)); for (let i = 0; i < n; i++) push(0); }
      const hop = rate / RATE;
      if (written - nextEnd > hop * 15) nextEnd = written - hop;      // far behind (the PC stalled): skip to now
      while (nextEnd <= written) {
        const end = Math.round(nextEnd), from = end - N;
        let sq = 0;
        for (let i = 0; i < N; i++) { const v = from + i < 0 ? 0 : ring[(from + i) % RING]; frame[i] = v; if (i >= N - 800) sq += v * v; }
        if (Math.sqrt(sq / 800) > 0.0006) S.pcLoudAt = now;           // above about -64 dB: something is playing
        const f = an.push(spectrumDb(frame, db, re, im));
        if (S.src === 'pc') onAudio({ t: 'mask-audio', s: 'pc', f: pack(f) });
        nextEnd += hop;
      }
    }
    lastTick = now;
    choose(now);
    if (S.src === 'voice' && now - voiceAt > 500) { voiceAt = now; onAudio({ t: 'mask-audio', s: 'voice' }); }
  }

  return {
    /** the Mask is the chosen character (or not): the helper and the clock only run while it is */
    want(on) {
      on = !!on;
      if (on === S.want || S.stopped) return;
      S.want = on;
      if (on) { S.tries = 0; if (S.pc === 'failed' && (cmd || allowReal)) S.pc = 'idle'; startProc(); lastTick = Date.now(); timer = setInterval(tick, 8); }
      else { clearInterval(timer); timer = null; clearTimeout(restart); killProc(); if (S.pc !== 'off' && S.pc !== 'failed') S.pc = 'idle'; }
    },
    get wanted() { return S.want; },
    /** which OBS inputs are "what the PC plays" (desktop audio); null = not known yet */
    meterInputs(names) { meterNames = names ? new Set(names) : null; },
    /** one InputVolumeMeters event of OBS (about 20 a second) */
    meters(data) {
      if (!S.want || !data || !Array.isArray(data.inputs) || !meterNames) return;
      let peak = 0, any = false;
      for (const inp of data.inputs) {
        if (!meterNames.has(inp.inputName)) continue;
        any = true;
        for (const ch of inp.inputLevelsMul || []) { const v = Number(ch && ch[1]) || 0; if (v > peak) peak = v; }
      }
      if (!any) return;
      const now = Date.now(), level = Wire.meterLevel(peak);
      S.obsAt = now;
      if (level > 0.03) S.obsLoudAt = now;
      const f = follower.push(level, now / 1000);
      if (S.src === 'obs') onAudio({ t: 'mask-audio', s: 'obs', f: pack(f) });
    },
    state: () => ({ src: S.want ? S.src : 'none', pc: S.pc, obs: Date.now() - S.obsAt < 1500 }),
    stop() { S.stopped = true; S.want = false; clearInterval(timer); clearTimeout(restart); killProc(); },
  };
}

module.exports = { createSound, spectrumDb, N, RATE };
