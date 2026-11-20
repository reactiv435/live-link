# js/v8: the V8 engine interface (ENGINE writes it, VISUALS renders from it)

Changes after the first commit get a dated line here, newest first.
- Nov 20 (5): a strike's `blocked` values and `VTVotes.scheduler` written down (both were there already).
- Nov 20 (4): section 1: the shockwave is read from pressed lips, not from the cheek points (`lm` is not used).
- Nov 20 (3): `tools/v8-sim-state.mjs` writes the demo's state tracks (section 6). Nothing in the state shapes changed.
- Nov 20 (2): the balance dials are in section 2 ("Balance"). A gift weapon now flies INSTEAD of tap missiles (it does not
  add to them). `VTBoss.create({ params })` and `VTFaceTriggers.create({ params })` take overrides of the numbers.
- Nov 20 (1): the `missile-launch` event carries `power`.
- First version: Nov 20 2026 (cbdf5f9).

Four pure modules. No DOM, no network, no timers, no `Date.now()`: every call takes the time. The same calls with the
same seed give the same answer (a demo render can be re-run frame for frame). Each is a UMD file like `mask/mask-fx.js`:
`require()` in node, a global in a page.

| File | Global | What it does |
|---|---|---|
| `face-triggers.js` | `VTFaceTriggers` | his face scores + mic level -> the six boss moves (eat, dodge, shield, shockwave, lasers, scream) |
| `boss-engine.js` | `VTBoss` | the fight: two health bars, missiles, hits, damage, phases, endings, top 3 |
| `votes.js` | `VTVotes` | a poll: start, cast, countdown, result; a random-vote picker |
| `hand-puppets.js` | `VTHandPuppets` | right hand = ANGEL, left hand = DEVIL: pose + sock-puppet mouth from the 21 hand points |

## 0. Units and spaces (the same everywhere)

- **Time `t`: seconds**, rising, any zero (the same clock `fx.fire(ev, t)` and `fx.sample(t)` use). The tracker's `tMs / 1000`.
- **PICTURE space** (hand puppets): MediaPipe's own. `x`, `y` in 0..1 of the camera picture, **un-mirrored, y DOWN**, exactly
  like the `lm` the Mask's `frame()` takes. The page flips the whole canvas when Mirror is on (`js/mask-page.js`), so draw
  un-mirrored and let that flip do its work. Lengths (`size`) are in parts of the picture's **height**; pass
  `aspect = width / height` (his phone: 720 / 1280 = 0.5625) so angles and lengths are true on a non-square picture.
- **FACE space** (the boss fight): the Mask's rest space, the one `mask-fx.js` already uses for `SPOTS` and its missiles:
  **eye distance = 1, origin between the eyes, x = picture right, y UP, z toward the camera.** The face is about 1.6 wide
  and reaches from y = +0.9 (forehead) to y = -1.6 (chin); the mouth is at `[0, -0.95, 0.35]`. The engine works on the face
  at rest; VISUALS puts every FACE-space point through the Mask's own head transform and place (zoom / x / y), the same
  way the V4 gift missiles are drawn. A missile is the same quadratic curve as a V4 missile: `start`, `ctrl`, `target`, `u`.
- **Angles:** degrees for the head (`yaw` + = he turns toward picture right, `pitch` + = up); radians for a puppet's `tilt`.
- **Health:** 0..1. **Viewers:** `{ id, name, avatar }`: `id` is any stable string, `name` the display name (already
  cleaned by the caller), `avatar` whatever the page can draw (a URL or a key; the engine only carries it).
- **Events:** every `step()` returns `events: []`, the things that happened since the last step (each has `type` and `t`).
  They are returned once. Sounds and one-shot effects hang off events; everything that lasts is in the state.
- **Text rule (TikTok LIVE):** the only strings the engine ever produces for the screen are listed in this file
  (`prompt`, `ending.text`, `'ate @name'`, a vote's question / labels given by the caller). None asks for a gift.

## 1. `VTFaceTriggers` - his face as the controller

```js
const trig = VTFaceTriggers.create({ bsNames });              // MediaPipe's 52 names, given once (index 0 = _neutral)
const a = trig.step(t, { bs, mat, lm, mic });                  // once per tracker frame; any of them may be null
trig.reset();                                                  // forget cooldowns and baselines
```
- `bs`: the 52 scores. `mat`: the 4x4 face matrix (16, column-major) for yaw / pitch. `lm`: the 478 points; accepted, not
  used today (MediaPipe's own `cheekPuff` score is dead, always 0, on his footage, and the cheek points do not move enough
  to tell either, so the shockwave is read from the MOUTH of a puff: lips pressed shut and held). `mic`: the 0..1 loudness the
  pages already send (`VTVoice.levelFromRms`), or null. No face this frame: pass `{ bs: null }`; holds end, cooldowns run.
- It learns his resting head angle and his resting squint by itself (slow averages, about 6 s), so a camera placed to
  one side or his naturally narrow left eye do not fire anything.

What comes back (`a`, a new object each step):
```js
{
  t, face: true,                       // false = no face this frame
  yaw, pitch,                          // degrees, measured against his resting pose (0 = how he normally sits)
  gaze: [gx, gy],                      // -1..1, eyes in the head: + = picture right, + = up
  aim: [yawDeg, pitchDeg],             // where the lasers point: head + eyes together
  eat:       { on, charge, left },     // on = mouth wide and held; charge 0..1 while he is still opening (the suck-in
                                       //   can start to glow); left 1..0 = how much of this gulp is left (max 1.6 s)
  dodge:     { on, dir, left },        // dir -1 = toward picture left, +1 = picture right; on for 0.9 s per turn
  shield:    { on, energy },           // energy 1..0 drains while it is up (2.5 s), refills when it is down
  shockwave: { fired, ready, cool, charge },   // fired = true on the ONE step it goes off; cool 1..0 (8 s); charge 0..1 = cheeks filling
  laser:     { on, heat, overheated }, // heat 0..1; at 1 it cuts out until it has cooled
  scream:    { fired, ready, cool, charge },   // cool 1..0 (30 s)
  events: [ { type, t } ]              // 'eat-start' 'eat-end' 'dodge' { dir } 'shield-on' 'shield-off' 'shield-empty'
                                       // 'shockwave' 'laser-on' 'laser-off' 'laser-overheat' 'scream'
}
```
`a` is handed to the boss engine as it is. Outside a fight the page may use it for anything (or nothing).

## 2. `VTBoss` - the fight

```js
const boss = VTBoss.create({ seed, place: 'full' });
boss.setSongPlaying(bool, t);          // the between-songs rule: a fight cannot start while a song plays
boss.tap({ viewer, count }, t);        // a like batch: who + how many (no position). Any time; before a fight it only feeds the room's tap rate
boss.gift({ viewer, coins, count, gift }, t);   // a gift = a heavier weapon (during a fight; ignored otherwise)
boss.special(name, t);                 // the puppet buttons as attacks on CHAT: 'fire' | 'goo' -> true / false (cooldown)
boss.start(t) -> true | false;         // false + a 'refused' event when a song is playing or a fight is on
boss.stop(t);                          // the host calls it off: no winner
const s = boss.step(t, a);             // once per drawn frame; a = the face-triggers result (or null)
```

### The state `s` (a new object each step; arrays may be kept by the caller until the next step)

```js
{
  t,
  phase: 'idle' | 'intro' | 'fight' | 'ending',
  phaseT,                              // seconds in this phase
  introLeft,                           // 'intro' only: seconds until the first missile may fly (the raid gathers; 6 s)
  fightT, fightLeft,                   // seconds fought / until sudden death (the fight is capped at 180 s)
  prompt: 'Tap to attack!' | null,     // the ONLY call to action; shown in intro + fight. Never anything about gifts.

  boss: { hp, shown, stage, hit, heal, shake },
        // hp 0..1 now; shown = eased for the bar (falls over ~0.4 s); stage 'whole' | 'cracked' (<= 50 %) | 'demon' (<= 20 %),
        // it never goes back up within a fight; hit / heal 1..0 = a flash that fades (0.5 s); shake 0..1
  chat: { hp, shown, hit, tapRate, tappers },
        // tapRate = taps a second right now (smoothed); tappers = how many different viewers tapped in the last 10 s

  missiles: [ {
    id, kind: 'tap' | 'heavy' | 'swarm',
    viewer,                            // whose face rides on it ({ id, name, avatar })
    power, size,                       // power: 1 = an average missile; size: draw scale (1 = a tap missile, 2 = heavy, 0.7 = swarm)
    start, ctrl, target,               // FACE space, the V4 curve: p(u) = (1-u)^2 start + 2u(1-u) ctrl + u^2 target
    u, pos,                            // 0..1 along it, and the point itself
    spot,                              // where it is going: 'forehead' 'cheekL' 'cheekR' 'nose' 'chin' 'browL' 'browR' 'jawL' 'jawR' 'mouth'
    eta,                               // seconds until it lands (flight is slow on purpose: 2.6 - 3.4 s)
    state, age,                        // see below; age = seconds in this state
    seed                               // 0..1, fixed per missile (for its own flicker)
  } ],
        // state: 'fly'       on its way
        //        'pulled'    being sucked toward the mouth (pos runs to the mouth over 0.25 s), then:
        //        'eaten'     gone into the mouth                        (kept 0.4 s for the chomp)
        //        'hit'       landed on the face: an explosion at pos    (kept 0.6 s)
        //        'dodged'    flew past his head (pos keeps going)       (kept 0.6 s)
        //        'blocked'   burst on the shield bubble                 (kept 0.4 s)
        //        'blown'     pushed back by the shockwave (pos runs back toward start) (kept 0.7 s)
        //        'lasered'   shot down                                  (kept 0.4 s)
        //        'screamed'  wiped by the scream                        (kept 0.5 s)
        //        'burned' / 'slimed'   taken out by the fire / goo special (kept 0.5 s)
        //        'gulped'    the boss's winning gulp: every missile runs into the mouth (kept 1.0 s)

  strikes: [ { id, viewer, spot, pos, state: 'lock' | 'fire' | 'done', k, blocked } ],
        // a big gift's orbital beam: 'lock' = a target ring closing on `pos` for 2.5 s (k 0..1), 'fire' = the beam (0.5 s, k 0..1)
        // blocked: false | 'shield' (his bubble took three quarters of it) | 'dodged' (it missed)

  damage: [ { pos, r, spot, t0, by } ],
        // holes knocked out of the face THIS fight, FACE space, r = radius (0.12 - 0.45). They stay until 'reformed'.
        // At most 48; when full the two closest merge into one bigger hole.
  regions: { forehead, cheekL, cheekR, nose, chin, browL, browR, jawL, jawR, mouth },   // 0..1 = how much of each is gone

  moves: {                             // what the boss is doing right now, already worked out against the missiles
    eat:       { on, charge, mouth: [x, y, z], radius },      // radius = how far the suck-in reaches (FACE units)
    dodge:     { on, dir },
    shield:    { on, energy, radius },                        // a bubble round the face, radius in FACE units
    shockwave: { age, ready, cool },                          // age = seconds since the last one (ring radius = age * 6), null if never
    laser:     { on, auto, heat, overheated, to: [x, y, z] | null, target: id | null },
               // auto = demon mode fires them by itself; to = where the beams end (a missile, or a point 6 units out along his aim)
    scream:    { age, ready, cool },
    special:   { name, age, ready: { fire, goo }, cool: { fire, goo } }    // name = the last one fired ('fire' | 'goo' | null)
  },

  top: [ { viewer, damage, taps, rank } ],    // up to 3, by damage done to the boss (0..1 of his bar), live during the fight
  ending: null | {
    winner: 'boss' | 'chat' | null,    // null = called off
    reason: 'hp' | 'time' | 'song' | 'stopped',
    stage, k, t,                       // t = seconds since the end; stage + k (0..1 within the stage):
                                       //   chat wins: 'explode' 0-1.2 s, 'rain' 1.2-4, 'credits' 4-9 (the particles spell `text`,
                                       //              the top 3 pictures show), 'reform' 9-11
                                       //   boss wins: 'shatter' 0-1 s (CHAT's bar breaks), 'gulp' 1-2.2, 'laugh' 2.2-4.5,
                                       //              'credits' 4.5-8.5 (top 3), 'reform' 8.5-10 (his holes close)
                                       //   no winner: 'reform' 0-2
    finalBlow: viewer | null,
    text,                              // '@name landed the final blow' | 'The boss wins' | 'Time! The raid wins' | ... (ready to draw)
    top3: [ { viewer, damage, taps, rank } ]
  },
  events: [ ... ]
}
```

### Events (`type`, plus `t`)
| type | fields | when |
|---|---|---|
| `refused` | `reason: 'song' \| 'busy'` | `start()` said no |
| `fight-intro` | | the fight is announced; the bars come in |
| `fight-start` | `tapRate` | missiles may fly |
| `missile-launch` | `id, viewer, kind, power` | |
| `missile-hit` | `id, viewer, spot, pos, damage` | it landed on him; `damage` = part of his bar |
| `ate` | `id, viewer, text: 'ate @name', heal, damage` | he ate one |
| `dodged` / `blocked` / `lasered` | `id, viewer` | |
| `shockwave` / `scream` | `n, damage` | n = missiles taken out |
| `special` | `name, n, damage` | fire / goo button |
| `gift-weapon` | `kind: 'heavy' \| 'swarm' \| 'strike', viewer` | a gift became a weapon |
| `strike-lock` / `strike-fire` | `id, viewer, spot, pos, damage, blocked` | the beam |
| `chat-hit` | `damage, by` | CHAT's bar lost health (`by` = the move) |
| `stage` | `stage: 'cracked' \| 'demon'` | his bar crossed 50 % / 20 % |
| `fight-end` | `winner, reason, finalBlow, top3, length` | |
| `reformed` | | the ending is over, the face is whole, phase = idle |

### Balance (what the fight does by itself, and the dials)
- A missile's `power` = the taps it carries against the room's own recent tap rate, so 20 viewers and 2,000 viewers make
  the same fight; a room that taps harder than it just did hits harder for a while (up to x 3).
- The fight evens itself out: the side that has dealt more is turned down (`handicap`), the side that is behind is hit less
  (`rubber`), and a nearly empty bar falls slower than a full one (`band`). A fight lasts about two minutes and either side can
  win; a boss who plays better still wins more often, a boss who does nothing loses.
- A gift weapon takes the place of tap missiles of the same weight. Gifts change what comes at him and who gets the credit,
  not how fast his bar falls.
- The dials (all in `VTBoss.create({ params: { ... } })`): `bossScale` / `chatScale` (everything that hurts that side, x), `tilt`
  (> 1 favours CHAT; 1.4 as tuned), `handicap` (0 = skill alone decides ... 1 = a coin flip; 0.8), `rubber` (0.8), `band` (0.6),
  `cap` (180 s), `intro` (6 s). `boss.debug()` shows the live handicap.

### Rules VISUALS can rely on
- The engine never has more than 16 missiles in the air (taps are pooled: a missile carries many taps; `power` says how many).
- A hole in `damage` never moves or shrinks during the fight. `regions` only rises.
- `boss.hp` can rise (eating heals), `chat.hp` never rises.
- Bars: draw `shown`, not `hp`. `place` (given at `create`, passed through as `s.place`) is VISUALS' own option; the engine
  does not use it.

## 3. `VTVotes` - a poll

```js
const votes = VTVotes.create({ seed });
votes.start({ question, options, seconds = 30, id }, t) -> true | false   // options: 2..4 of 'label' or { label, words: [..], action }
votes.cast(viewer, text, t) -> 0-based option index, or -1                // viewer = an id string or { id }
votes.cancel(t);
const v = votes.step(t);
const def = votes.pickRandom(list, { songPlaying, fight });               // one of `list` (default VTVotes.DEFAULT_VOTES)
const sched = VTVotes.scheduler({ every: 240, first: 90 });               // the "random vote every few minutes" switch as a clock
if (sched.due(t, { on, busy })) votes.start(votes.pickRandom(null, { songPlaying }), t);   // busy = a vote / a fight is on: it waits
```
- A vote is `1`-`4` (also `!1`, `#1`, `1️⃣`-style keycaps), or the option's label, or one of its `words`, as the WHOLE
  comment (case, spaces and a leading `!` ignored). One vote per viewer; the last one counts.
- `pickRandom` never returns the last two picks again, and leaves out the boss-fight vote while a song is playing.

```js
v = {
  t, active,                           // true while the countdown runs
  id, question,
  options: [ { n, label, votes, share, leading } ],   // n = 1.., share 0..1 of all votes (bars), leading = in front right now
  total, left, k,                      // votes so far; seconds left; 0..1 of the countdown gone
  result: null | { winner, label, action, votes, total, tie, age },
          // set when the countdown ends, kept 6 s (age = seconds since); winner = 0-based index. A tie is broken by the
          // seeded dice (tie: true). No votes at all: winner = -1, action = null.
  events: [ ]                          // 'vote-start', 'vote-cast' { option, changed }, 'vote-lead' { option }, 'vote-last5',
                                       // 'vote-end' { winner, label, action, tie }, 'vote-clear'
}
```
The page applies `result.action` (a plain string or object the caller put on the option: `'shrink'`, `'huge'`,
`{ colour: '#ff2d95' }`, `'boss'`, ...). The engine does not know what the actions mean.

## 4. `VTHandPuppets` - angel and devil

```js
const hp = VTHandPuppets.create({ sourceMirrored: false });
const p = hp.step(t, hands, { aspect, face: [x, y] | null });
```
- `hands`: what the hand model found this frame, 0..2 of `{ handed: 'Left' | 'Right', score, lm, world }` (`lm` = 21 points
  flat `[x, y, z, ...]` or `[{ x, y, z }]`, PICTURE space; `world` the same in metres, optional but better for the mouth).
  This is the shape of the recorded tracks and of `HandLandmarker` after `raw-pack`. `[]` or null = no hands.
- `sourceMirrored`: false = the picture MediaPipe sees is the true camera picture (today's tracker). His REAL right hand
  is the ANGEL either way; set it true only if the picture handed to MediaPipe is itself flipped.
- `face`: where the Mask's face is in PICTURE space (the nose), so the puppets can look at it. null = they look to the middle.

```js
p = {
  t,
  angel: P, devil: P,
  both,                                // both are up
  argue,                               // 0..1, eases in over 0.6 s while both are up: they turn to face each other
  speaker: 'angel' | 'devil' | null,   // whose mouth is flapping more right now (for "the angel praises, the devil roasts")
  events: [ ]                          // 'puppet-in' { who }, 'puppet-out' { who } (the poof), 'puppet-chomp' { who } (a mouth snap shut)
}
P = {
  on,                                  // the puppet exists (appears after the hand is seen 0.2 s; stays 0.45 s after it is lost)
  k,                                   // 0..1 presence, eased: 0 -> 1 over 0.35 s coming in, 1 -> 0 over 0.3 s (the poof)
  held,                                // true = the hand is not seen this frame, the pose is being held
  x, y,                                // PICTURE space: the middle of the palm (where the puppet's head sits)
  size,                                // the hand's length, wrist to middle fingertip stretched, in parts of the picture HEIGHT
  tilt,                                // radians: 0 = fingers pointing up the picture, + = clockwise as the un-mirrored picture is seen
  mouth,                               // 0..1: 0 = thumb on the fingers (shut), 1 = his widest gap (it learns his range)
  mouthV,                              // 1/s, + = opening (for a snap)
  look: [dx, dy],                      // unit vector in the picture (y down) toward what it looks at: the other puppet when both, else the Mask
  facing,                              // -1 | +1: which way its face points along x (toward `look`)
  talking,                             // true while the mouth is flapping (2 or more open-shut moves in the last second)
  conf                                 // 0..1 the hand model's score, smoothed
}
```
- When `on` is false the other fields hold the last pose (so the poof happens where the hand was).
- The eyes' blinking is VISUALS' own (a clock of yours); the engine gives where they look.

## 5. How a frame goes together (the demo and, later, the page)

```js
const a = trig.step(t, { bs, mat, lm, mic });          // tracker frame
const p = hp.step(t, hands, { aspect, face });         // tracker frame
// events from chat, any time:  boss.tap(...)  boss.gift(...)  votes.cast(...)
const s = boss.step(t, a);                             // drawn frame
const v = votes.step(t);                               // drawn frame
// VISUALS draws s, v, p; plays sounds from s.events / v.events / p.events
```

## 6. State tracks for the demo (`tools/v8-sim-state.mjs`, written to `tmp/v8/`, git-ignored)

```
node tools/v8-sim-state.mjs fight --winner boss     -> tmp/v8/state-fight-boss.json   (a full fight the boss wins, about 26 MiB)
node tools/v8-sim-state.mjs fight --winner chat     -> tmp/v8/state-fight-chat.json
node tools/v8-sim-state.mjs puppets --clip body-close-lo   -> tmp/v8/state-puppets-body-close-lo.json
node tools/v8-sim-state.mjs vote --id colour        -> tmp/v8/state-vote-colour.json
```
- A fight file: `{ kind, meta, script, frames }`. `frames[i] = { t, faceFrame, move, a, s }`: `a` = section 1, `s` = section 2,
  `faceFrame` = which frame of the face clip (`meta.face.clip`, played round and round; null in the 6-frame gap where it starts
  over), `move` = what the scripted player does with his face at that moment (`'eat' | 'pucker' | 'squint' | 'dodge' | 'puff' |
  'scream'` or null). His recorded face never does a boss move, so the Mask has to SHOW the move from `move` / `s.moves`.
  `script` = every input with its time (`start`, `tap`, `gift`, `special`, `move`): replay it through `VTBoss` at any frame rate.
  The fight is called at t = 20 s (`meta.fightCalledAt`); before it a few viewers tap as they always do.
- A puppets file: `frames[i] = { t, frame, p }` (`p` = section 4), one per frame of the clip.
- A vote file: `frames[i] = { t, v }` (`v` = section 3) and `script` (the made-up chat, with `counted` = the option it voted for or -1).
- Viewers are made up (`fakeName(i)`, avatar keys `ph0` .. `ph23`): never a real viewer's name or picture.
