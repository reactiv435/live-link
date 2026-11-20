// V8 ENGINE: the boss fight. Pure UMD, no DOM, no clock of its own, seeded (js/v8/README.md, section 2).
//
//   const boss = VTBoss.create({ seed });
//   boss.setSongPlaying(false, t);  boss.tap({ viewer, count }, t);  boss.gift({ viewer, coins, count, gift }, t);
//   boss.start(t);  const s = boss.step(t, a);        a = the VTFaceTriggers result of this moment (or null)
//
// The ideas the numbers below serve:
//   * BOSS (him) and CHAT (the raid) each have a bar, 0..1. Whoever is at zero first loses. 180 s is the cap.
//   * Taps are pooled into missiles: TikTok says WHO tapped and HOW MANY, never where, and viewers see him 5 - 10 s late,
//     so a missile is slow and telegraphed (about 3 s of flight) and he plays against the flow, not against single taps.
//   * BALANCE: a missile's `power` is the taps it carries against the room's own recent tap rate. A room of 20 and a
//     room of 2,000 that tap steadily both throw power-1 missiles at the same pace, so the bars move alike; a room that
//     taps harder than it just did hits harder for a while, a room that goes quiet hits softer.
//   * He wins by taking missiles out of the air (eat, laser, shockwave, scream, the fire / goo buttons): each one taken
//     out hurts CHAT. He loses by letting them land. A boss who does nothing is dead in about 70 s.
//   * Gifts are heavier weapons, never asked for. A gift weapon flies INSTEAD of the tap missiles of the same weight (the
//     tap missiles pause for that long), so gifts change what comes at him and who gets the credit, not how fast his bar
//     falls: nobody buys the ending, and a room full of gifts still fights for about two minutes.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTBoss = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const RAD = Math.PI / 180;

  // places on the face, FACE space = the Mask's rest space (mask-fx.js SPOTS, plus the mouth)
  const SPOTS = { forehead: [0, 0.62, 0.22], cheekL: [-0.62, -0.55, 0.22], cheekR: [0.62, -0.55, 0.22], nose: [0, -0.45, 0.6], chin: [0, -1.45, 0.3], browL: [-0.5, 0.3, 0.2], browR: [0.5, 0.3, 0.2], jawL: [-0.75, -1.05, 0.0], jawR: [0.75, -1.05, 0.0], mouth: [0, -0.95, 0.35] };
  const SPOT_NAMES = Object.keys(SPOTS);
  const SPOT_WEIGHT = { forehead: 3, cheekL: 3, cheekR: 3, nose: 2, chin: 2, browL: 2, browR: 2, jawL: 2, jawR: 2, mouth: 1 };
  const MOUTH = SPOTS.mouth, EYES = [0, 0, 0.3];
  const KEEP = { eaten: 0.4, hit: 0.6, dodged: 0.6, blocked: 0.4, blown: 0.7, lasered: 0.4, screamed: 0.5, burned: 0.5, slimed: 0.5, gulped: 1.0 };

  const DEFAULTS = {
    intro: 6,                    // s between "the fight is on" and the first missile
    cap: 180,                    // s: sudden death, the fuller bar wins
    maxAir: 16,                  // missiles in the air at once
    spawnEvery: 0.75,            // s between tap missiles at a steady room
    flight: [2.6, 3.4],          // s a tap missile is in the air
    powerClamp: [0.25, 3],       // a missile's power against the room's own rate
    rateFloor: 0.4,              // taps a second: a room quieter than this throws weak missiles
    rateTau: 20, rateTauOpen: 2.5, openFor: 20,   // how fast "the room's own rate" follows the room: slowly, but quickly UP while the raid
                                 // gathers (viewers see the call 5 - 10 s late, so the first 20 s are a ramp, not a surge)
    hit: 0.018,                  // BOSS bar lost per power-1 missile that lands (at half health; see `band`)
    band: 0.6,                   // a full bar loses faster, a nearly empty one slower (x 1.3 at full, x 0.7 at empty): both ends of a
                                 // fight last, the middle moves. The same for CHAT's bar.
    eat: { radius: 2.2, fromU: 0.45, perGulp: 3, pull: 0.25, heal: 0.003, damage: 0.0095 },
    laser: { every: 0.35, cone: 16, fromU: 0.15, damage: 0.008, autoEvery: 3.5, autoDamage: 0.004, reach: 6 },
    shock: { fromU: 0.2, flat: 0.012, per: 0.006 },
    scream: { flat: 0.04, per: 0.006 },
    fire: { cooldown: 20, fromU: 0.5, flat: 0.03, per: 0.005 },
    goo: { cooldown: 20, flat: 0.025, per: 0.005, slow: 0.45, slowFor: 5 },
    shield: { radius: 1.9 },
    gift: { every: 3, queue: 12, cap: 1, over: 1, heavyPower: 3, heavyFlight: 3.8, swarm: 5, swarmPower: 0.9, strike: 0.10, strikeBig: 0.15, lock: 2.5, fire: 0.5, shielded: 0.25 },
    rubber: 0.8,                 // the side that is behind is hit less, the side in front more: x (1 +- rubber x the lead), kept
                                 // within 0.55 .. 1.6. A fight stays close and long enough to be a show; the better side still wins more.
    tilt: 1.4, handicap: 0.8, handicapPrior: 0.15,   // the fight handicaps itself to how HE is playing: the side that has been dealing more (before
                                 // any of these factors) is turned down, the other up, by (dealt ratio) ^ (handicap / 2), within 0.6 .. 1.7.
                                 // 0 = off (skill alone decides), 1 = the bars always drain alike (a coin flip). The prior keeps the first
                                 // seconds calm.
    ease: 0.15,
    bossScale: 1, chatScale: 1,  // the two dials: everything that hurts the BOSS / CHAT is multiplied by these (1 = as tuned)
  };

  function merge(a, b) {
    const o = {};
    for (const k of Object.keys(a)) o[k] = a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? Object.assign({}, a[k], b && b[k]) : (b && b[k] != null ? b[k] : a[k]);
    return o;
  }
  const bez = (m, u) => { const v = 1 - u, a = v * v, b = 2 * u * v, c = u * u; return [a * m.start[0] + b * m.ctrl[0] + c * m.target[0], a * m.start[1] + b * m.ctrl[1] + c * m.target[1], a * m.start[2] + b * m.ctrl[2] + c * m.target[2]]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const viewerOf = (v) => (v && typeof v === 'object' ? { id: String(v.id != null ? v.id : v.name), name: String(v.name != null ? v.name : v.id), avatar: v.avatar != null ? v.avatar : null } : { id: String(v), name: String(v), avatar: null });

  function create({ seed = 20261120, place = 'full', params = null } = {}) {
    const P = merge(DEFAULTS, params);
    let s0 = seed | 0;
    const rnd = () => { s0 = (s0 + 0x6D2B79F5) | 0; let t = Math.imul(s0 ^ (s0 >>> 15), 1 | s0); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    let phase = 'idle', phaseAt = 0, now = null, song = false, nextId = 1;
    let ev = [];
    let bossHp = 1, chatHp = 1, bossShown = 1, chatShown = 1, stage = 'whole', bossHit = 0, bossHeal = 0, chatHit = 0, shake = 0;
    let missiles = [], strikes = [], damage = [], regions = {}, ending = null;
    // the room: taps a second (1 s buckets over 5 s), who tapped lately, and the slow "own rate" the power is measured against
    const buckets = new Float64Array(5); let bucketAt = null, rateRef = P.rateFloor, lastSeen = new Map(), tappersN = 0, tappersAt = -99;
    let pool = new Map(), poolTaps = 0, spawnAt = 0, poolHold = -99, lastFace = new Map();
    let credit = new Map();      // viewer id -> { viewer, damage, taps }
    let giftQueue = [], giftAt = -99, giftDamage = 0, rawBoss = 0, rawChat = 0;
    let fightAt = 0, lastShock = null, lastScream = null, laserAt = -99, laserTo = null, laserTarget = null, laserAuto = false, eatCount = 0, wasEating = false;
    let special = { name: null, at: null, fire: -1e9, goo: -1e9 }, slowUntil = -99;
    const resetRegions = () => { regions = {}; for (const k of SPOT_NAMES) regions[k] = 0; };
    resetRegions();

    const push = (e) => { e.t = now; ev.push(e); return e; };
    function rollBuckets(t) {
      const b = Math.floor(t);
      if (bucketAt == null) bucketAt = b;
      while (bucketAt < b) { bucketAt++; buckets[bucketAt % 5] = 0; }
    }
    // the last four whole seconds and the part of this one that has gone by
    const tapRate = (t) => (buckets[0] + buckets[1] + buckets[2] + buckets[3] + buckets[4]) / (4 + (t - Math.floor(t)));

    function setSongPlaying(v, t) {
      song = !!v;
      // a song starts: a fight under way ends at once and the fuller bar wins; one still in its intro is called off
      if (song && (phase === 'intro' || phase === 'fight')) { if (t != null) now = t; if (phase === 'intro') finish(null, 'song', null); else finish(bossHp >= chatHp ? 'boss' : 'chat', 'song', null); }
    }

    function tap(e, t) {
      if (!e) return false;
      const n = Math.max(1, Math.floor(Number(e.count != null ? e.count : e.value) || 1));
      const v = viewerOf(e.viewer != null ? e.viewer : e.name);
      rollBuckets(t); buckets[Math.floor(t) % 5] += n;
      lastSeen.set(v.id, t);
      if (phase === 'intro' || phase === 'fight') {
        // while a gift weapon is taking the place of tap missiles (see fireGift) the taps still count for the viewer, not for a missile
        if (t >= poolHold) { const p = pool.get(v.id); if (p) p.taps += n; else pool.set(v.id, { viewer: v, taps: n }); poolTaps += n; }
        const c = credit.get(v.id); if (c) c.taps += n; else credit.set(v.id, { viewer: v, damage: 0, taps: n });
      }
      return true;
    }

    function gift(e, t) {
      if (phase !== 'fight' || !e) return false;
      const coins = Math.max(1, Number(e.coins) || 1), count = Math.max(1, Math.floor(Number(e.count) || 1)), v = viewerOf(e.viewer != null ? e.viewer : e.name);
      const kind = coins <= 9 ? 'heavy' : coins <= 199 ? 'swarm' : 'strike';
      // the queue is short: a flood of the same gift makes the waiting one stronger instead of making a line
      const same = giftQueue.find((g) => g.kind === kind && g.viewer.id === v.id);
      if (same) { same.count += count; same.coins = Math.max(same.coins, coins); return true; }
      if (giftQueue.length >= P.gift.queue) { const g = giftQueue[giftQueue.length - 1]; g.count += count; return true; }
      giftQueue.push({ kind, viewer: v, coins, count, gift: e.gift || null });
      if (!credit.has(v.id)) credit.set(v.id, { viewer: v, damage: 0, taps: 0 });
      return true;
    }

    function start(t) {
      now = t;
      if (phase !== 'idle') { push({ type: 'refused', reason: 'busy' }); return false; }
      if (song) { push({ type: 'refused', reason: 'song' }); return false; }
      phase = 'intro'; phaseAt = t;
      bossHp = chatHp = bossShown = chatShown = 1; stage = 'whole'; bossHit = bossHeal = chatHit = shake = 0;
      missiles = []; strikes = []; damage = []; resetRegions(); ending = null;
      pool = new Map(); poolTaps = 0; lastFace = new Map(); credit = new Map(); giftQueue = []; giftDamage = 0; giftAt = -99; rawBoss = rawChat = 0; poolHold = -99;
      lastShock = lastScream = null; laserAt = -99; laserTo = laserTarget = null; laserAuto = false; eatCount = 0; wasEating = false;
      special = { name: null, at: null, fire: -1e9, goo: -1e9 }; slowUntil = -99;
      rollBuckets(t); rateRef = Math.max(P.rateFloor, tapRate(t));
      push({ type: 'fight-intro' });
      return true;
    }

    function stop(t) { if (phase === 'intro' || phase === 'fight') { now = t; finish(null, 'stopped', null); return true; } return false; }

    function top3() {
      return [...credit.values()].filter((c) => c.damage > 0 || c.taps > 0).sort((a, b) => b.damage - a.damage || b.taps - a.taps || (a.viewer.id < b.viewer.id ? -1 : 1)).slice(0, 3).map((c, i) => ({ viewer: c.viewer, damage: c.damage, taps: c.taps, rank: i + 1 }));
    }

    function finish(winner, reason, finalBlow) {
      const length = phase === 'fight' ? now - fightAt : 0;
      phase = 'ending'; phaseAt = now;
      const t3 = top3();
      const head = reason === 'time' ? 'Time! ' : reason === 'song' ? 'Song time! ' : '';
      const text = winner == null ? '' : winner === 'chat' ? (reason === 'hp' && finalBlow ? '@' + finalBlow.name + ' landed the final blow' : head + 'The raid wins') : head + 'The boss wins';
      ending = { winner, reason, finalBlow: finalBlow || null, text, top3: t3, at: now };
      for (const m of missiles) if (m.state === 'fly' || m.state === 'pulled') { if (winner === 'boss') { m.state = 'gulped'; m.at = now; m.from = m.pos; } else { m.state = 'gone'; } }
      missiles = missiles.filter((m) => m.state !== 'gone');
      strikes = [];
      giftQueue = [];
      push({ type: 'fight-end', winner, reason, finalBlow: finalBlow || null, top3: t3, length });
    }

    /** the handicap: +1 = the factor on what hurts the BOSS, -1 = on what hurts CHAT */
    const balance = (side) => clamp(Math.pow(P.tilt * (rawChat + P.handicapPrior) / (rawBoss + P.handicapPrior), side * P.handicap / 2), 0.6, 1.7);
    function hurtChat(d, by) {
      if (d <= 0 || phase !== 'fight') return 0;
      d *= P.chatScale; rawChat += d;
      d = Math.min(d * balance(-1) * (1 - P.band / 2 + P.band * chatHp) * clamp(1 + P.rubber * (chatHp - bossHp), 0.55, 1.6), chatHp);
      chatHp -= d; chatHit = 1;
      push({ type: 'chat-hit', damage: d, by });
      return d;
    }
    function hurtBoss(d, m, spot, pos, r) {
      const before = bossHp;
      d *= P.bossScale; rawBoss += d;
      bossHp = Math.max(0, bossHp - d * balance(1) * (1 - P.band / 2 + P.band * bossHp) * clamp(1 + P.rubber * (bossHp - chatHp), 0.55, 1.6)); bossHit = 1; shake = Math.min(1, shake + 0.25 + d * 6);
      // who did it: the taps this missile carried, share by share
      if (m && m.shares) for (const sh of m.shares) { const c = credit.get(sh.id); if (c) c.damage += (before - bossHp) * sh.k; }
      if (pos) {
        damage.push({ pos: [pos[0], pos[1], pos[2]], r, spot, t0: now, by: m && m.viewer ? m.viewer.id : null });
        if (damage.length > 48) mergeHoles();
        if (spot in regions) regions[spot] = Math.min(1, regions[spot] + r * r * 2.2);
      }
      if (stage === 'whole' && bossHp <= 0.5) { stage = 'cracked'; push({ type: 'stage', stage }); }
      if (stage !== 'demon' && bossHp <= 0.2) { stage = 'demon'; push({ type: 'stage', stage }); }
      return before - bossHp;
    }
    function mergeHoles() {
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < damage.length; i++) for (let j = i + 1; j < damage.length; j++) { const d = dist(damage[i].pos, damage[j].pos); if (d < bd) { bd = d; bi = i; bj = j; } }
      const a = damage[bi], b = damage[bj];
      a.pos = lerp3(a.pos, b.pos, 0.5); a.r = Math.min(0.6, Math.sqrt(a.r * a.r + b.r * b.r));
      damage.splice(bj, 1);
    }

    function pickSpot() {
      let tot = 0; for (const k of SPOT_NAMES) tot += SPOT_WEIGHT[k];
      let r = rnd() * tot;
      for (const k of SPOT_NAMES) { r -= SPOT_WEIGHT[k]; if (r <= 0) return k; }
      return 'nose';
    }
    function launch(kind, viewer, power, shares, { size = 1, flight = null, homing = false, delay = 0 } = {}) {
      const spot = pickSpot(), sp = SPOTS[spot];
      const target = [sp[0] + (rnd() - 0.5) * 0.24, sp[1] + (rnd() - 0.5) * 0.24, sp[2]];
      const side = rnd() < 0.5 ? -1 : 1, top = rnd() < 0.3;
      const startP = top ? [(rnd() - 0.5) * 4, 3.6 + rnd(), 2 + rnd() * 3] : [side * (3.2 + rnd()), -1.5 + rnd() * 3.5, 2 + rnd() * 3.5];
      const ctrl = [startP[0] * 0.35 + (rnd() - 0.5) * 1.2, startP[1] * 0.5 + 0.6 + rnd() * 0.8, 2.2 + rnd() * 1.5];
      const m = { id: nextId++, kind, viewer, power, size, start: startP, ctrl, target, spot, u: -delay / (flight || 3), pos: startP, dur: flight || (P.flight[0] + rnd() * (P.flight[1] - P.flight[0])), state: 'fly', at: now, seed: rnd(), shares, homing };
      missiles.push(m);
      push({ type: 'missile-launch', id: m.id, viewer, kind, power });
      return m;
    }

    function spawnFromPool() {
      // whose face rides on it: the one with the most taps in this missile, with a push for those who have not had a turn
      let best = null, bestW = -1;
      const shares = [];
      for (const p of pool.values()) {
        const lf = lastFace.get(p.viewer.id);
        const w = p.taps * (1 + Math.min(3, lf == null ? 3 : (now - lf) / 10)) * (0.85 + 0.3 * rnd());
        if (w > bestW) { bestW = w; best = p; }
        shares.push({ id: p.viewer.id, k: p.taps / poolTaps });
      }
      const power = clamp(poolTaps / (rateRef * P.spawnEvery), P.powerClamp[0], P.powerClamp[1]);
      lastFace.set(best.viewer.id, now);
      launch('tap', best.viewer, power, shares);
      pool = new Map(); poolTaps = 0;
    }

    function fireGift() {
      const g = giftQueue.shift(), G = P.gift, extra = Math.min(2, (g.count - 1) * 0.25);
      const shares = [{ id: g.viewer.id, k: 1 }];
      push({ type: 'gift-weapon', kind: g.kind, viewer: g.viewer });
      // A gift weapon flies INSTEAD of tap missiles of the same weight, not on top of them: the tap missiles pause for as
      // long as it takes the room to throw that much. So a room full of gifts gets heavier, stranger missiles and the gifter
      // gets the credit, but the bars do not move faster and the fight keeps its length.
      let slots;
      if (g.kind === 'heavy') { slots = G.heavyPower + extra; launch('heavy', g.viewer, slots, shares, { size: 2, flight: G.heavyFlight }); }
      else if (g.kind === 'swarm') { slots = G.swarm * G.swarmPower + extra; for (let i = 0; i < G.swarm; i++) launch('swarm', g.viewer, slots / G.swarm, shares, { size: 0.7, homing: true, delay: i * 0.15 }); }
      else {
        slots = (g.coins >= 1000 ? G.strikeBig : G.strike) * (1 + extra * 0.25) / P.hit;
        const spot = pickSpot();
        const st = { id: nextId++, viewer: g.viewer, spot, pos: SPOTS[spot].slice(), state: 'lock', at: now, k: 0, blocked: false, dmg: (g.coins >= 1000 ? G.strikeBig : G.strike) * (1 + extra * 0.25), shares };
        strikes.push(st);
        push({ type: 'strike-lock', id: st.id, viewer: st.viewer, spot, pos: st.pos, damage: 0, blocked: false });
      }
      spawnAt = Math.max(spawnAt, now) + slots * P.spawnEvery; poolHold = spawnAt - P.spawnEvery;
    }
    /** an optional lid on gifts (off by default: cap 1): full strength until all gifts together took `cap` of his bar, `over` of it after that */
    const giftScale = (d) => { const room = Math.max(0, P.gift.cap - giftDamage); const full = Math.min(d, room); return full + (d - full) * P.gift.over; };

    /** what a missile is worth to HIM when he takes it out: its power, but a gift weapon counts for less than its weight (the root of it: a gift makes the
     *  raid's hit heavier; it does not make stopping it a bigger win, or a room full of gifts would be feeding him) */
    const worth = (m) => (m.kind === 'tap' ? m.power : Math.min(m.power, Math.sqrt(m.power)));
    function takeOut(list, state) { let pw = 0; for (const m of list) { m.state = state; m.at = now; m.from = m.pos; pw += worth(m); } return pw; }
    const flying = (fromU = 0) => missiles.filter((m) => m.state === 'fly' && m.u >= fromU);

    function specialMove(name, t) {
      if (phase !== 'fight' || (name !== 'fire' && name !== 'goo')) return false;
      if (t - special[name] < P[name].cooldown) return false;
      now = t; special[name] = t; special.name = name; special.at = t;
      // fire burns what is close to his head; goo slimes the raid further out and slows what is left
      const hitList = name === 'fire' ? flying(P.fire.fromU) : flying(0).filter((m) => m.u < P.fire.fromU);
      const pw = takeOut(hitList, name === 'fire' ? 'burned' : 'slimed');
      if (name === 'goo') slowUntil = t + P.goo.slowFor;
      const d = hurtChat(P[name].flat + P[name].per * pw, name);
      push({ type: 'special', name, n: hitList.length, damage: d });
      return true;
    }

    function step(t, a) {
      const dt = now == null ? 0 : clamp(t - now, 0, 0.25);
      now = t;
      rollBuckets(t);
      const rate = tapRate(t);
      if (t - tappersAt >= 1) { tappersAt = t; let n = 0; for (const [id, at] of lastSeen) { if (t - at > 10) lastSeen.delete(id); else n++; } tappersN = n; }
      const k = (tau) => 1 - Math.exp(-dt / tau);
      bossHit = Math.max(0, bossHit - dt / 0.5); bossHeal = Math.max(0, bossHeal - dt / 0.5); chatHit = Math.max(0, chatHit - dt / 0.5); shake = Math.max(0, shake - dt * 1.6);
      const A = a && a.face !== false ? a : null;

      if (phase === 'intro') {
        rateRef += (Math.max(P.rateFloor, rate) - rateRef) * k(P.rateTauOpen);
        if (t - phaseAt >= P.intro) { phase = 'fight'; phaseAt = fightAt = t; spawnAt = t; giftAt = t; push({ type: 'fight-start', tapRate: rate }); }
      }

      if (phase === 'fight') {
        const ft = t - fightAt;
        // the room's own rate, in the log domain (a room ten times as loud is ten times, not "plus a lot")
        const tau = ft < P.openFor && rate > rateRef ? P.rateTauOpen : P.rateTau;
        rateRef = Math.max(P.rateFloor, Math.exp(Math.log(rateRef) + (Math.log(Math.max(P.rateFloor, rate)) - Math.log(rateRef)) * k(tau)));

        // ---- new missiles
        const air = missiles.filter((m) => m.state === 'fly' || m.state === 'pulled').length;
        if (t >= spawnAt && poolTaps > 0 && air < P.maxAir) { spawnFromPool(); spawnAt = Math.max(spawnAt + P.spawnEvery, t - P.spawnEvery); }
        else if (t >= spawnAt && poolTaps <= 0) spawnAt = t;       // nobody tapped: the next tap flies at once
        if (giftQueue.length && t - giftAt >= P.gift.every) { giftAt = t; fireGift(); }

        // ---- his moves that clear the air at once
        if (A && A.scream && A.scream.fired) { const l = flying(0); const pw = takeOut(l, 'screamed'); lastScream = t; const d = hurtChat(P.scream.flat + P.scream.per * pw, 'scream'); push({ type: 'scream', n: l.length, damage: d }); }
        if (A && A.shockwave && A.shockwave.fired) { const l = flying(P.shock.fromU); const pw = takeOut(l, 'blown'); lastShock = t; const d = hurtChat(P.shock.flat + P.shock.per * pw, 'shockwave'); push({ type: 'shockwave', n: l.length, damage: d }); }

        // ---- eat: the mouth pulls in what is near, a few per gulp
        const eating = !!(A && A.eat && A.eat.on);
        if (eating && !wasEating) eatCount = 0;
        wasEating = eating;
        if (eating) {
          const near = flying(P.eat.fromU).filter((m) => dist(m.pos, MOUTH) <= P.eat.radius).sort((x, y) => y.u - x.u);
          for (const m of near) { if (eatCount >= P.eat.perGulp) break; m.state = 'pulled'; m.at = t; m.from = m.pos; eatCount++; }
        }

        // ---- lasers: his squint, or by themselves in demon mode
        const lasing = !!(A && A.laser && A.laser.on);
        laserAuto = !lasing && stage === 'demon';
        laserTo = null; laserTarget = null;
        if (lasing || laserAuto) {
          const cand = flying(P.laser.fromU);
          let pick = null;
          if (lasing) {
            const yaw = A.aim[0] * RAD, pitch = A.aim[1] * RAD, dir = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
            let bestA = P.laser.cone;
            for (const m of cand) { const v = [m.pos[0] - EYES[0], m.pos[1] - EYES[1], m.pos[2] - EYES[2]], l = Math.hypot(v[0], v[1], v[2]) || 1; const ang = Math.acos(clamp((v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / l, -1, 1)) / RAD; if (ang <= bestA) { bestA = ang; pick = m; } }
            laserTo = pick ? pick.pos : [EYES[0] + dir[0] * P.laser.reach, EYES[1] + dir[1] * P.laser.reach, EYES[2] + dir[2] * P.laser.reach];
          } else { for (const m of cand) if (!pick || m.u > pick.u) pick = m; if (pick) laserTo = pick.pos; }
          if (pick) laserTarget = pick.id;
          if (pick && t - laserAt >= (lasing ? P.laser.every : P.laser.autoEvery)) {
            laserAt = t; pick.state = 'lasered'; pick.at = t; pick.from = pick.pos;
            push({ type: 'lasered', id: pick.id, viewer: pick.viewer });
            hurtChat((lasing ? P.laser.damage : P.laser.autoDamage) * worth(pick), lasing ? 'laser' : 'demon');
          }
        }

        // ---- the missiles move; what arrives lands, or does not
        const slow = t < slowUntil ? P.goo.slow : 1;
        for (const m of missiles) {
          if (m.state === 'fly') {
            m.u += dt / m.dur * slow;
            if (m.u >= 1) {
              m.u = 1; m.pos = m.target.slice(); m.at = t; m.from = m.pos;
              if (A && A.shield && A.shield.on) { m.state = 'blocked'; push({ type: 'blocked', id: m.id, viewer: m.viewer }); }
              else if (A && A.dodge && A.dodge.on && !m.homing) { m.state = 'dodged'; m.dir = [m.target[0] - m.ctrl[0], m.target[1] - m.ctrl[1], m.target[2] - m.ctrl[2]]; push({ type: 'dodged', id: m.id, viewer: m.viewer }); }
              else {
                m.state = 'hit';
                let d = P.hit * m.power;
                if (m.kind !== 'tap') { const sc = giftScale(d); giftDamage += d; d = sc; }
                const r = clamp(0.12 + 0.09 * Math.sqrt(m.power), 0.12, 0.45);
                const done = hurtBoss(d, m, m.spot, m.pos, r);
                push({ type: 'missile-hit', id: m.id, viewer: m.viewer, spot: m.spot, pos: m.pos, damage: done });
                if (bossHp <= 0) { finish('chat', 'hp', m.viewer); break; }
              }
            } else m.pos = bez(m, Math.max(0, m.u));
          } else if (m.state === 'pulled') {
            const kk = clamp((t - m.at) / P.eat.pull, 0, 1);
            m.pos = lerp3(m.from, MOUTH, kk * kk);
            if (kk >= 1) {
              m.state = 'eaten'; m.at = t;
              const before = bossHp; bossHp = Math.min(1, bossHp + P.eat.heal * worth(m)); bossHeal = 1;
              rawBoss = Math.max(0, rawBoss - P.eat.heal * worth(m));      // a heal counts for the handicap like damage undone
              const d = hurtChat(P.eat.damage * worth(m), 'eat');
              push({ type: 'ate', id: m.id, viewer: m.viewer, text: 'ate @' + m.viewer.name, heal: bossHp - before, damage: d });
            }
          }
        }

        // ---- the orbital beam of a big gift
        if (phase === 'fight') for (const st of strikes) {
          if (st.state === 'lock') {
            st.k = clamp((t - st.at) / P.gift.lock, 0, 1);
            if (st.k >= 1) {
              st.state = 'fire'; st.at = t; st.k = 0;
              let d = st.dmg, done = 0;
              if (A && A.dodge && A.dodge.on) { st.blocked = 'dodged'; d = 0; }
              else if (A && A.shield && A.shield.on) { st.blocked = 'shield'; d *= P.gift.shielded; }
              if (d > 0) { const sc = giftScale(d); giftDamage += d; done = hurtBoss(sc, st, st.spot, st.pos, 0.45); }
              push({ type: 'strike-fire', id: st.id, viewer: st.viewer, spot: st.spot, pos: st.pos, damage: done, blocked: st.blocked });
              if (bossHp <= 0) { finish('chat', 'hp', st.viewer); break; }
            }
          } else if (st.state === 'fire') { st.k = clamp((t - st.at) / P.gift.fire, 0, 1); if (st.k >= 1) st.state = 'done'; }
        }
        if (phase === 'fight') strikes = strikes.filter((st) => st.state !== 'done');

        if (phase === 'fight' && chatHp <= 0) finish('boss', 'hp', null);
        if (phase === 'fight' && ft >= P.cap) finish(bossHp >= chatHp ? 'boss' : 'chat', 'time', null);
      }

      // ---- things that are leaving the picture (in every phase: an ending still shows the last explosions)
      for (const m of missiles) {
        const age = t - m.at;
        if (m.state === 'blown') m.pos = lerp3(m.from, m.start, clamp(age / KEEP.blown, 0, 1));
        else if (m.state === 'dodged' && m.dir) m.pos = [m.from[0] + m.dir[0] * age * 1.5, m.from[1] + m.dir[1] * age * 1.5, m.from[2] + m.dir[2] * age * 1.5 - age * 2];
        else if (m.state === 'gulped') { const kk = clamp(age / KEEP.gulped, 0, 1); m.pos = lerp3(m.from, MOUTH, kk * kk); }
      }
      missiles = missiles.filter((m) => m.state === 'fly' || m.state === 'pulled' || t - m.at < (KEEP[m.state] || 0));

      // ---- the ending plays out, then the face is whole again
      let endOut = null;
      if (phase === 'ending') {
        const et = t - ending.at;
        const stages = ending.winner === 'chat' ? [['explode', 1.2], ['rain', 4], ['credits', 9], ['reform', 11]] : ending.winner === 'boss' ? [['shatter', 1], ['gulp', 2.2], ['laugh', 4.5], ['credits', 8.5], ['reform', 10]] : [['reform', 2]];
        let st = stages[stages.length - 1][0], kk = 1, from = 0;
        for (const [name, end] of stages) { if (et < end) { st = name; kk = (et - from) / (end - from); break; } from = end; }
        if (et >= stages[stages.length - 1][1]) {
          phase = 'idle'; phaseAt = t; ending = null; damage = []; resetRegions(); stage = 'whole'; bossHp = chatHp = 1; missiles = [];
          push({ type: 'reformed' });
        } else endOut = { winner: ending.winner, reason: ending.reason, stage: st, k: clamp(kk, 0, 1), t: et, finalBlow: ending.finalBlow, text: ending.text, top3: ending.top3 };
      }
      bossShown += (bossHp - bossShown) * k(P.ease); chatShown += (chatHp - chatShown) * k(P.ease);
      if (phase === 'idle') { bossShown = bossHp; chatShown = chatHp; }

      const events = ev; ev = [];
      const fighting = phase === 'fight';
      return {
        t, place, phase, phaseT: t - phaseAt,
        introLeft: phase === 'intro' ? Math.max(0, P.intro - (t - phaseAt)) : 0,
        fightT: fighting ? t - fightAt : 0, fightLeft: fighting ? Math.max(0, P.cap - (t - fightAt)) : 0,
        prompt: phase === 'intro' || fighting ? 'Tap to attack!' : null,
        boss: { hp: bossHp, shown: bossShown, stage, hit: bossHit, heal: bossHeal, shake },
        chat: { hp: chatHp, shown: chatShown, hit: chatHit, tapRate: rate, tappers: tappersN },
        missiles: missiles.map((m) => ({ id: m.id, kind: m.kind, viewer: m.viewer, power: m.power, size: m.size, start: m.start, ctrl: m.ctrl, target: m.target, u: clamp(m.u, 0, 1), pos: m.pos, spot: m.spot, eta: m.state === 'fly' ? Math.max(0, (1 - m.u) * m.dur / (t < slowUntil ? P.goo.slow : 1)) : 0, state: m.state, age: m.state === 'fly' ? Math.max(0, m.u) * m.dur : t - m.at, seed: m.seed })),
        strikes: strikes.map((st) => ({ id: st.id, viewer: st.viewer, spot: st.spot, pos: st.pos, state: st.state, k: st.k, blocked: st.blocked })),
        damage, regions: Object.assign({}, regions),
        moves: {
          eat: { on: fighting && !!(A && A.eat.on), charge: A ? A.eat.charge : 0, mouth: MOUTH, radius: P.eat.radius },
          dodge: { on: !!(A && A.dodge.on), dir: A ? A.dodge.dir : 0 },
          shield: { on: !!(A && A.shield.on), energy: A ? A.shield.energy : 1, radius: P.shield.radius },
          shockwave: { age: lastShock == null ? null : t - lastShock, ready: A ? A.shockwave.ready : true, cool: A ? A.shockwave.cool : 0 },
          laser: { on: fighting && !!((A && A.laser.on) || (laserAuto && laserTo)), auto: fighting && laserAuto, heat: A ? A.laser.heat : 0, overheated: A ? A.laser.overheated : false, to: fighting ? laserTo : null, target: fighting ? laserTarget : null },
          scream: { age: lastScream == null ? null : t - lastScream, ready: A ? A.scream.ready : true, cool: A ? A.scream.cool : 0 },
          special: { name: special.name, age: special.at == null ? null : t - special.at, ready: { fire: t - special.fire >= P.fire.cooldown, goo: t - special.goo >= P.goo.cooldown }, cool: { fire: clamp(1 - (t - special.fire) / P.fire.cooldown, 0, 1), goo: clamp(1 - (t - special.goo) / P.goo.cooldown, 0, 1) } },
        },
        top: phase === 'idle' ? [] : top3(),
        ending: endOut,
        events,
      };
    }

    return { step, start, stop, tap, gift, special: specialMove, setSongPlaying, get songPlaying() { return song; }, get phase() { return phase; }, params: P, debug: () => ({ rateRef, poolTaps, giftDamage, rawBoss, rawChat, handicap: [balance(1), balance(-1)] }) };
  }

  return { create, SPOTS, DEFAULTS };
});
