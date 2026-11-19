// Hand waveform line: an OBS Browser Source overlay (transparent).
// Listens on the relay for `hands`, `wave` and `hands-line`, and draws a glowing crimson line from
// the left index fingertip to the right one, shaped by the song's waveform, shedding sparks.
//   ?test=1    scripted hands + fake waveform (no tracker needed)
//   ?bg=1      dark background (for looking at it in a normal browser)
//   ?ws=...    relay address (default: the server this page came from; ws://127.0.0.1:8791/ws when opened as a file)
//   ?render=1  offline rendering: no live loop; drive it with window.__hands.feed(msg) / .frame(dtMs)
const Q = new URLSearchParams(location.search);
const TEST = Q.get('test') === '1';
const RENDER = Q.get('render') === '1';
const RELAY_URL = Q.get('ws') || (location.host ? 'ws://' + location.host + '/ws' : 'ws://127.0.0.1:8791/ws');
if (Q.get('bg') === '1') document.documentElement.style.background = '#0d0b0a';

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
let W = 0; let H = 0; let S = 1;
function resize() {
  W = Number(Q.get('w')) || window.innerWidth || 1280;
  H = Number(Q.get('h')) || window.innerHeight || 720;
  cv.width = W; cv.height = H;
  S = Math.min(W, H) / 720;
}
resize();
window.addEventListener('resize', resize);

// ---- clock (virtual in render mode so every frame is reproducible)
let vnow = 0;
const now = () => (RENDER ? vnow : performance.now());

// ---- deterministic random (same sparks every render)
let seed = 0x2f6e2b1;
function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- state
const mkHand = () => ({ present: false, at: 0, sx: 0, sy: 0, vx: 0, vy: 0, x: 0, y: 0, dx: 0, dy: 0, tdx: 0, tdy: 0, has: false, speed: 0 });
const hand = { left: mkHand(), right: mkHand() };
let lineOn = Q.get('on') === '1';
let lastHandsAt = -1e9;
let alpha = 0;
const wave = { cur: new Float32Array(64), tgt: new Float32Array(64), rms: 0, level: 0, at: -1e9 };
const parts = [];
const MAX_PARTS = 420;

function feed(m) {
  if (!m || typeof m !== 'object') return;
  const t = now();
  if (m.t === 'hands-line') { lineOn = !!m.on; return; }
  if (m.t === 'wave' && Array.isArray(m.samples)) {
    const n = Math.min(64, m.samples.length);
    for (let i = 0; i < 64; i++) wave.tgt[i] = i < n ? +m.samples[i] || 0 : 0;
    wave.rms = Math.max(0, +m.rms || 0);
    wave.at = t;
    return;
  }
  if (m.t !== 'hands') return;
  if (typeof m.line === 'boolean') lineOn = m.line;
  lastHandsAt = t;
  for (const side of ['left', 'right']) {
    const h = hand[side];
    const p = m[side]; const d = m[side + 'Dir'];
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') { h.present = false; continue; }
    const fresh = !h.present || t - h.at > 300;
    const dt = (t - h.at) / 1000;
    if (fresh || dt <= 0) { h.vx = 0; h.vy = 0; }
    else {
      // light smoothing on velocity so one noisy sample does not kick the line
      h.vx += ((p.x - h.sx) / dt - h.vx) * 0.6;
      h.vy += ((p.y - h.sy) / dt - h.vy) * 0.6;
    }
    h.sx = p.x; h.sy = p.y; h.at = t; h.present = true;
    if (d && typeof d.x === 'number') { h.tdx = d.x; h.tdy = d.y; }
    else { h.tdx = side === 'left' ? 1 : -1; h.tdy = 0; }
    if (fresh && alpha < 0.05) { h.x = p.x; h.y = p.y; h.dx = h.tdx; h.dy = h.tdy; }
    h.has = true;
  }
}

// ---- relay
function connect() {
  let ws;
  try { ws = new WebSocket(RELAY_URL); } catch (e) { setTimeout(connect, 2000); return; }
  ws.onmessage = (ev) => { if (typeof ev.data !== 'string') return; try { feed(JSON.parse(ev.data)); } catch (e) { /* ignore */ } };
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onerror = () => {};
}

// ---- scripted test (hands at ~18 updates/s like the real tracker, wave at 30/s)
let testNextHands = 0; let testNextWave = 0;
function testFeed(tMs) {
  const T = (tMs / 1000) % 14;
  if (tMs >= testNextHands) {
    testNextHands = tMs + 55;
    const spread = 0.17 + 0.13 * Math.sin(T * 0.9) + (T > 5 && T < 7 ? -0.08 : 0);
    const cy = 0.6 + 0.06 * Math.sin(T * 1.7);
    const tilt = T > 7 && T < 10.5 ? Math.sin((T - 7) * 1.8) * 1.1 : 0.15 * Math.sin(T * 2.3);
    const L = { x: 0.5 - spread, y: cy + 0.03 * Math.sin(T * 3.1) };
    const R = { x: 0.5 + spread, y: cy + 0.03 * Math.cos(T * 2.6) };
    const leftGone = T > 11 && T < 12;
    feed({
      t: 'hands', ok: true, left: leftGone ? null : L, right: R,
      leftDir: leftGone ? null : { x: Math.cos(-tilt), y: Math.sin(-tilt) }, rightDir: { x: -Math.cos(-tilt), y: Math.sin(-tilt) },
      line: !(T > 12.8),
    });
  }
  if (tMs >= testNextWave) {
    testNextWave = tMs + 33;
    const beat = Math.pow(Math.max(0, Math.sin(T * Math.PI * 2)), 6);
    const amp = 0.08 + 0.35 * beat;
    const samples = []; let sq = 0;
    for (let i = 0; i < 64; i++) {
      const ph = i / 64;
      const v = amp * (0.7 * Math.sin(ph * 6.283 * 2.2 + T * 9) + 0.35 * Math.sin(ph * 6.283 * 6.5 - T * 15) + 0.2 * (rnd() - 0.5));
      samples.push(v); sq += v * v;
    }
    feed({ t: 'wave', samples, rms: Math.sqrt(sq / 64) });
  }
}

// ---- drawing
const N = 150;
const px = new Float32Array(N + 1); const py = new Float32Array(N + 1);
const nx = new Float32Array(N + 1); const ny = new Float32Array(N + 1);

function waveAt(u, t, idle) {
  const f = u * 63; const i = Math.floor(f); const a = f - i;
  const v = wave.cur[i] * (1 - a) + wave.cur[Math.min(63, i + 1)] * a;
  const shimmer = 0.07 * Math.sin(u * 24 - t * 7.5);
  return v + shimmer + idle * (0.22 * Math.sin(u * 13 - t * 5) + 0.1 * Math.sin(u * 29 + t * 8));
}

function step(dt) {
  const t = now();
  const ts = t / 1000;
  if (TEST) testFeed(t);

  // presence: both fingertips, fresh data, line switched on
  const live = t - lastHandsAt < 450;
  const both = live && hand.left.present && hand.right.present && hand.left.has && hand.right.has;
  const target = both && lineOn ? 1 : 0;
  if (target > alpha) alpha = Math.min(1, alpha + dt / 0.22);
  else if (target < alpha) alpha = Math.max(0, alpha - dt / 0.27);

  // glide between the ~15-20 updates per second (small look-ahead, then a soft follow)
  for (const side of ['left', 'right']) {
    const h = hand[side];
    if (!h.has) continue;
    let tx = h.sx; let ty = h.sy;
    if (h.present) { const age = Math.min(0.075, (t - h.at) / 1000); tx += h.vx * age * 0.8; ty += h.vy * age * 0.8; }
    const k = 1 - Math.exp(-dt / 0.038);
    const ox = h.x; const oy = h.y;
    h.x += (tx - h.x) * k; h.y += (ty - h.y) * k;
    const kd = 1 - Math.exp(-dt / 0.09);
    h.dx += (h.tdx - h.dx) * kd; h.dy += (h.tdy - h.dy) * kd;
    const sp = dt > 0 ? Math.hypot((h.x - ox) * W, (h.y - oy) * H) / dt / Math.max(W, H) : 0;
    h.speed += (sp - h.speed) * Math.min(1, dt / 0.12);
  }

  // waveform: glide toward the newest snapshot; loudness drives height
  const kw = 1 - Math.exp(-dt / 0.03);
  const fresh = t - wave.at < 400;
  const gain = 1 / Math.max(0.05, wave.rms * 2.6);
  for (let i = 0; i < 64; i++) {
    const tg = fresh ? Math.max(-1.3, Math.min(1.3, wave.tgt[i] * gain)) : 0;
    wave.cur[i] += (tg - wave.cur[i]) * kw;
  }
  const lvT = fresh ? Math.min(1, Math.max(0, (wave.rms - 0.004) / 0.09)) : 0;
  wave.level += (lvT - wave.level) * (1 - Math.exp(-dt / (lvT > wave.level ? 0.04 : 0.18)));

  ctx.clearRect(0, 0, W, H);
  if (alpha > 0.004) drawLine(ts, dt, fresh ? 0 : 1);
  drawParts(dt);
}

function drawLine(ts, dt, idle) {
  const A = hand.left; const B = hand.right;
  const ax = A.x * W; const ay = A.y * H; const bx = B.x * W; const by = B.y * H;
  const dist = Math.hypot(bx - ax, by - ay);
  const rel = Math.min(1, dist / (Math.hypot(W, H) * 0.75)); // 0 = touching, 1 = far apart
  const ln = (h) => { const l = Math.hypot(h.dx, h.dy) || 1; return [h.dx / l, h.dy / l]; };
  const [adx, ady] = ln(A); const [bdx, bdy] = ln(B);
  // wrists bend it: each hand's pointing direction pulls its end of the curve
  const reach = dist * 0.42;
  const c1x = ax + adx * reach; const c1y = ay + ady * reach;
  const c2x = bx + bdx * reach; const c2y = by + bdy * reach;

  // close = tighter + brighter + taller ripple; far = stretched, calmer
  const bright = 1.3 - rel * 0.75;
  const height = Math.min(W, H) * (0.03 + 0.05 * wave.level + 0.012 * idle) * (1.25 - rel * 0.55);

  for (let i = 0; i <= N; i++) {
    const u = i / N; const m = 1 - u;
    const x = m * m * m * ax + 3 * m * m * u * c1x + 3 * m * u * u * c2x + u * u * u * bx;
    const y = m * m * m * ay + 3 * m * m * u * c1y + 3 * m * u * u * c2y + u * u * u * by;
    let tx = 3 * m * m * (c1x - ax) + 6 * m * u * (c2x - c1x) + 3 * u * u * (bx - c2x);
    let ty = 3 * m * m * (c1y - ay) + 6 * m * u * (c2y - c1y) + 3 * u * u * (by - c2y);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    nx[i] = -ty; ny[i] = tx;
    const env = Math.pow(Math.sin(Math.PI * u), 0.7); // pinned at both fingertips
    const off = waveAt(u, ts, idle) * height * env;
    px[i] = x + nx[i] * off; py[i] = y + ny[i] * off;
  }

  const path = () => {
    ctx.beginPath();
    ctx.moveTo(px[0], py[0]);
    for (let i = 1; i < N; i++) ctx.quadraticCurveTo(px[i], py[i], (px[i] + px[i + 1]) / 2, (py[i] + py[i + 1]) / 2);
    ctx.lineTo(px[N], py[N]);
  };
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const a = alpha;
  // Glow = stacked soft strokes (no canvas shadows: those are too slow for 60 frames a second).
  const wide = 0.85 + 0.5 * wave.level;
  const layers = [
    ['#c8102e', 46 * wide, 0.05], ['#c8102e', 32 * wide, 0.08], ['#d81830', 21 * wide, 0.13],
    ['#ff2a3a', 13, 0.24], ['#ff3a44', 7.5, 0.6], ['#ffd2c8', 4, 0.55], ['#fff4ee', 2.2, 1],
  ];
  for (const [color, width, al] of layers) {
    ctx.globalAlpha = a * Math.min(1, al * bright);
    ctx.strokeStyle = color; ctx.lineWidth = width * S;
    path(); ctx.stroke();
  }

  // fingertip orbs
  for (const [x, y] of [[px[0], py[0]], [px[N], py[N]]]) {
    const r = (15 + 12 * wave.level) * S * bright;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,244,238,0.95)');
    g.addColorStop(0.3, 'rgba(255,70,70,0.6)');
    g.addColorStop(1, 'rgba(200,16,46,0)');
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  }
  ctx.restore();

  // shed sparks: more when the music is loud, the hands move, or the line is tight
  const move = Math.min(1, (hand.left.speed + hand.right.speed) * 1.2);
  const rate = a * (26 + 230 * wave.level + 260 * move) * (1.15 - rel * 0.5);
  let n = rate * dt;
  let count = Math.floor(n); if (rnd() < n - count) count++;
  for (let k = 0; k < count && parts.length < MAX_PARTS; k++) {
    const i = 2 + Math.floor(rnd() * (N - 3));
    const dir = rnd() < 0.5 ? -1 : 1;
    const chrome = rnd() < 0.34;
    const sp = (chrome ? 120 + rnd() * 260 : 30 + rnd() * 120) * S * (0.6 + 0.9 * wave.level + 0.6 * move);
    const tgx = ny[i]; const tgy = -nx[i];
    const side = (rnd() - 0.5) * 70 * S;
    parts.push({
      x: px[i], y: py[i],
      vx: nx[i] * dir * sp + tgx * side, vy: ny[i] * dir * sp + tgy * side - 18 * S,
      life: 0, max: chrome ? 0.22 + rnd() * 0.3 : 0.45 + rnd() * 0.6,
      chrome, size: (chrome ? 1.1 + rnd() * 0.9 : 1.4 + rnd() * 2.2) * S, hot: rnd(),
    });
  }
}

function drawParts(dt) {
  if (!parts.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life += dt;
    if (p.life >= p.max) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
    const drag = Math.exp(-dt * (p.chrome ? 2.2 : 1.3));
    p.vx *= drag; p.vy = p.vy * drag + (p.chrome ? 160 : -26) * S * dt; // chrome sparks fall, embers rise
    p.x += p.vx * dt; p.y += p.vy * dt;
    const k = 1 - p.life / p.max;
    if (p.chrome) {
      ctx.globalAlpha = Math.min(1, k * 1.4);
      ctx.strokeStyle = k > 0.6 ? '#ffffff' : '#d9dde2';
      ctx.lineWidth = p.size;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); ctx.stroke();
    } else {
      ctx.globalAlpha = k * 0.9;
      ctx.fillStyle = k > 0.75 ? '#ffd9cf' : p.hot > 0.5 ? '#ff3a3a' : '#c8102e';
      const r = p.size * (0.5 + 0.7 * k);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = k * 0.22;
      ctx.fillStyle = '#c8102e';
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.2, 0, 6.2832); ctx.fill();
    }
  }
  ctx.restore();
}

// ---- run
window.__hands = {
  feed,
  // offline: advance the virtual clock by dtMs, draw, and (optionally) return the frame as a PNG data URL
  frame: (dtMs, wantPng) => { vnow += dtMs; step(dtMs / 1000); return wantPng === false ? null : cv.toDataURL('image/png'); },
  state: () => ({ alpha, lineOn, parts: parts.length, left: hand.left.present, right: hand.right.present, level: wave.level, w: W, h: H }),
};
if (!RENDER) {
  if (!TEST) connect();
  let last = performance.now();
  const loop = (t) => {
    const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
    last = t;
    step(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
