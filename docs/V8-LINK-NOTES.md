# V8 phase 2, the LINK side: LIVE Link feeds the puppet show (Nov 20, 2026)

Branch `v8-link` (from `main` = c44cc3a), worktree `D:\claude-cache\livelink-v8`. Contract: the VTuber repo's
`V8-PHASE2.md` (section B = this work, section C = the messages both sides speak). No release was made, no tag, nothing
in `dist/`, `dist-source/` or `dist-mac/` was touched, `vendor/vtuber/` was not edited.

## BEFORE THIS WORKTREE IS EVER REMOVED

`node_modules` in this worktree is a **junction** to the main checkout's `node_modules`.
`git worktree remove` FOLLOWS a junction and would delete the real folder. Remove the junction first:

    cmd /c rmdir D:\claude-cache\livelink-v8\node_modules

then check that `...\live link\node_modules\electron` still exists, and only then remove the worktree.
(No dependency was added: `package.json` and `package-lock.json` are unchanged.)

## What was built

| File | What it does |
| --- | --- |
| `src/core/pictures.js` | Which picture addresses may be passed on (C2), reading a viewer's picture out of a TikTok user object, cleaning the viewer id and @handle, and a counter of picture-server families (names only). |
| `src/core/tiktok-link.js` | Every local event now carries `avatar`; likes and gifts also carry the viewer's TikTok id. Nothing new goes to the site. |
| `src/core/vtuber-link.js` | Contract v2: events with `handle`, `uid`, `avatar`; `sendShow` (C3) and `sendControl` (C4) with their own cap; one viewer per tap event; a v1 VTuber gets exactly the 2.2.0 events. |
| `src/core/show-feed.js` | The show state (C3): song on air, cover, hype rank at the overlay's pace, the host's verdict as a score. Reads the site's public tables gently, with back-off. |
| `src/core/puppet-keys.js` | The keys that work in any window (B3): held only while they can do something, one `control` message per press. |
| `src/core/vtuber-host.js` | `wire`: which contract the VTuber inside the app speaks (1 or 2). |
| `src/main.js`, `src/preload.js` | The wiring: the feed follows the controller's state, the keys follow the LIVE and the VTuber, three small calls for the card. |
| `src/ui/*` | A "Puppet show keys" part on the VTuber card. |
| `test/mock-server.js` | The stand-in site also answers `GET /rest/v1/<table>` for the five public tables. |

## C1: who the viewer is

`{ v: 2, type, name, gift, coins, count, text, at, handle, uid, avatar }`

- `handle`: the @id without `@`, only `A-Z a-z 0-9 . _`, at most 40 characters, `''` when there is none.
- `uid`: TikTok's user id as a string of 1-30 digits, or `null`. A made-up id (LIVE Link's old fallback to the handle)
  is never sent as `uid`.
- `avatar`: an https address on an allowed picture server, at most 600 characters, or `null`.
- The old fields are unchanged, in the same order. The biggest possible event is under the VTuber's 2 KB door.

**Which VTuber gets v2.** Over HTTP: only one whose `GET /api/tiktok-event` answers `{ ok: true, v: 2 }` (or higher).
Inside the app: only when `VtuberHost.wire` is 2 (its `js/mask-wire.js` has `cleanShow`, or its `ready` message says
`wire: 2`). Any other VTuber, including the V7 one that ships in 2.2.0, gets the 2.2.0 events field for field, and no
`show` or `control`. **The vendored VTuber in this branch is still V7, so in a run of this branch today nothing new is
sent and the keys part of the card stays hidden. It all switches on by itself once `vendor/vtuber` is re-synced from
the v8 branch.**

**Taps (changed for a v2 VTuber only).** In 2.2.0 all taps of a quarter second were summed into one event under the
last tapper's name. A missile has to carry the right face and the fight's top 3 has to be true, so for v2:

- each `like` event is ONE viewer with their OWN taps (`count`), their handle, id and picture;
- still at most 4 like events a second; the viewer with the most waiting taps goes first;
- taps that waited 3 s (a big room, more tappers than 4 a second) go out summed as one event with **no viewer on it**:
  `name: 'Someone'`, `handle: ''`, `uid: null`, `avatar: null`. They take turns with the named ones. The total is never
  lost. **STAGE: treat a like with no handle and no uid as "the crowd": missiles with the placeholder, no name in
  the top 3.**
- a tap event the caps refuse (the 10 other events a second are shared with comments, follows and shares) keeps its
  taps for the next turn, so a busy chat delays taps but does not lose them (in 2.2.0, and still for a v1 VTuber, a
  refused tap event is lost);
- taps still waiting when the LIVE ends are dropped (a late effect is worse than none).

## C2: the picture hosts, and where the list comes from

The list (a host is allowed when it IS one of these names or ends with `.` + one of them):

    tiktokcdn.com   tiktokcdn-us.com   tiktokcdn-eu.com   ibyteimg.com   byteimg.com

Covers: only the site's own storage host, taken from `src/site-config.json` (`apiBase`'s host).

**Honest provenance:**

- `tiktokcdn.com` is **measured**: the site's table `hype_gift_alerts` holds the gift pictures LIVE Link sent from real
  LIVEs. All 88 rows (Oct 31 to Nov 15, 2026) sit on `p16-webcast.tiktokcdn.com` (one read-only SELECT of the host
  part, grouped; no viewer data was read).
- The other four names are **not measured**. `tiktok-live-connector` 2.4.4 and `tiktok-live-proto` 0.2.4 ship no
  tests or fixtures with any address in them (searched: zero hits), this repo's own fixtures only have a made-up
  `p16-webcast.tiktokcdn.com` gift picture, and no real viewer picture has ever been recorded on this computer. The
  four are TikTok's sister picture servers for the US and the EU and ByteDance's image servers, from general knowledge
  of how TikTok names them; STAGE's list is the same five.
- What the library does settle is the **shape**: `user.avatarThumb` / `avatarMedium` / `avatarLarge` =
  `ImageModel { urlList: string[] }` (`tiktok-live-proto/dist/node/v3.d.ts`). Older shapes are read too.
- **So the list gets measured on the first real LIVE:** `PictureStats` counts, for every viewer picture seen, only the
  last two labels of its host ("tiktokcdn-us.com"), allowed and refused apart, and writes ONE log line when the LIVE
  ends: `VTuber link: viewer pictures by server family: passed on: ...; not on the list (no picture shown): ...`.
  Never an address, never a viewer. If a family shows up under "not on the list", add it in `pictures.js` and in the
  VTuber's `PIC_HOSTS`.

Rules kept: a viewer's picture address is a signed link. It goes to the VTuber on 127.0.0.1 or inside the app and
nowhere else: not to the site (a test reads every byte sent to the stand-in site), not to the log, not to the disk.
A `.webp` / `.jpeg` / `.png` is picked before a `.heic` (a browser cannot draw `.heic`).

## C3: the show state

`{ v: 2, type: 'show', onAir, song: { id, title, cover } | null, hype: { taps, rank, label, mythic }, score, at }`
on every change and at least every 5 s while a TikTok LIVE is connected.

**Song on air.** From the site's own answer to LIVE Link's push / config (`target`). On air = connected, a target, and
the controller's hold is not `show` or `song`. (Test mode, hold `test`, still counts as a song on air.)

**Hype math** (no site change needed):

- read `project_hype.hype_bar` for the song and the song's newest `hype_plays` row;
- this play's taps = `max(0, hype_bar - start_bar)` **only while that play is open** (`ended_at` null). If the newest
  play is a finished one (the song only just went on air and the site has not opened its play yet), taps = 0: the Mask
  must not wear an old play's rank. (The site's overlay shows a finished play's last value only while off air.)
- ranks, copied from the site's `src/lib/hypeTiers.ts`: 0 Tap to hype it up, 1 Warming Up (1 tap), 2 Heating Up (300),
  3 ON FIRE (900), 4 WILDFIRE (1,800), 5 LEGENDARY (3,600), 6 MYTHIC (8,000);
- **`mythic` = how many "+1 MYTHIC" past the first**: 0 from 8,000, 1 from 16,000, 2 from 24,000... (The site's own
  `getMythicMultiplier` is this plus one.) `label` says `MYTHIC x2` at 16,000, as the site does. **STAGE: fire
  `hypePlus()` each time `mythic` goes up.**
- **the pace**: the site's overlay lets its bar climb about one rank per 15 s (`RANKS_PER_SECOND = 1/15`, walked every
  100 ms with whole taps, rounded down). The feed walks the same steps with the same rounding, and it only learns of
  taps 0-3 s after the overlay does (the overlay gets pushes, the feed reads every 2.5 s). So `hype.taps` and
  `hype.rank` are the SHOWN values and never ahead of the overlay. Measured: a sudden 8,000 taps reaches Heating Up at
  16.5 s, ON FIRE 33 s, WILDFIRE 48 s, LEGENDARY 63 s, MYTHIC 78 s.
- joining a play late (LIVE Link started mid-song): the shown value starts at what the overlay could have reached by
  then (elapsed / 15 s ranks), which for an old play is simply the real value, as a freshly opened overlay shows.

**The cover** (how the site itself does it: `src/pages/NowLivePopout.tsx`, the `/live/now` overlay):
`submissions_public.album_artwork_url`, else the first picture in `attachment_urls`, else a YouTube / Suno thumbnail.
The feed takes the first two and only from the site's storage host; a YouTube / Suno thumbnail is not passed on
(`cover: null`, the Mask keeps its colours). On prod today 850 songs have album art on the site's storage and 103
have none (those fall to an attached picture or to no cover).

**The grade, and the mapping.** The contract expected a letter. What the site really has:

- **his verdict** = `ranking_board.host_grade`, set in the live studio's review panel
  (`src/components/admin/HostReviewPanel.tsx`, shown by `HostVerdictBadge.tsx`): one of `fire`, `gem` (Hidden Gem),
  `solid`, `promising`. Not a letter. On prod: fire 186, gem 44, solid 21, promising 14.
- `content_scores` (`score` 0-88 today, `grade` S / A / B / C) is the site's own computed score, not his.
  `chart_entries` is empty on prod today (0 rows), so it is not used.

Used: his verdict, mapped to what the Mask does (it breathes fire at 70 and above, goo at 40 and below, a small puff
in between):

| Verdict | score | The Mask |
| --- | --- | --- |
| fire | 95 | fire + fireworks |
| gem (Hidden Gem) | 82 | fire + fireworks |
| solid | 60 | the small puff |
| promising | 38 | goo |

(Letters map too, for a later switch to `content_scores`: S 98, A 88, B 72, C 55, D 40, F 20. Not used today.)

Only a verdict given **during this play** counts (`reviewed_at` at or after the play's `started_at`, and by the host
of that play): an old verdict from an earlier review must not come out of the Mask's mouth the moment the song
starts. Once found it stays in the show state until the song changes. If he gives the verdict as the song ends, the
feed looks twice more (1.5 s and 5 s after the song went off air); a verdict found then is sent as
`{ onAir: false, song: <that song>, score: n }` for 10 s, then `song` and `score` go back to null.
**STAGE: a score that arrives with `onAir: false` and a song is "the grade for the song that just ended".**

**Gentle on the site.** Nothing is read without a song on air (the two late looks above aside), and nothing is read
unless a VTuber that speaks v2 is listening. While on air: the bar every 2.5 s, an open play every 10 s, the verdict
every 5 s until there is one, the cover once per song. About 0.7 small GETs a second. A failed round doubles the wait
(5, 10, 20, 30 s at most), a 429's Retry-After is obeyed, one good read puts the pace back; one log line when it
starts failing and one when it is back. Only GETs, only with the publishable key from `src/site-config.json`
(never the device token), only these tables: `project_hype`, `hype_plays`, `ranking_board`, `submissions_public`.

## C4 / B3: the keys

- Seven actions: Goo, Fire head, Melt, Crack open, Eat a comment, Boss fight, Vote.
- The usual keys: **Ctrl+Alt+1 ... Ctrl+Alt+7**. Nothing in Windows, OBS, TikTok LIVE Studio or a browser uses those
  out of the box. One button switches all seven to **F13 ... F19** for a Stream Deck (no keyboard has those keys, so
  nothing can clash). Each action can also be set by itself to any of Ctrl+Alt+0-9, F13-F24, or "No key".
- Held ONLY while a v2 VTuber is listening AND a TikTok LIVE is connected AND the card's switch is on. The rest of
  the time the keys belong to the other programs. All are given back when LIVE Link quits.
- A key another program holds shows "TAKEN" on its row; the others work.
- No key-up exists for a system-wide key: one press = one `{ v: 2, type: 'control', action, name, at }`. A held key
  repeats: at most 4 a second per key go out (so holding Goo keeps extending the pour, as the contract asks).
  Show + control share their own cap of 6 a second; they never use up the viewers' 10 events a second.
- How it reaches the page: the VTuber's control page is its own window ("LIVE Link VTuber", opened by the card's
  button, loaded from the VTuber's local server). A key goes main process -> `VtuberLink.sendControl` ->
  `VtuberHost.event` -> `{ t: 'event', ev }` to the VTuber's process (the same door as viewer events), or one POST to
  `/api/tiktok-event` for a desktop-shortcut VTuber that speaks v2.
- A test run (`LIVE_LINK_USER_DATA`) never registers a real key.

The card: `docs/v8-stills/` (the app's own page with its demo data, drawn off screen):
`card-keys-closed.png`, `card-keys-working.png`, `card-keys-waiting-for-live.png`, `card-keys-one-taken.png`,
`card-keys-off.png`, `card-keys-stream-deck.png`, `card-keys-clash-message.png`, `window-with-card.png`.
To see them live: open `src/ui/index.html?demo=puppet` (or `puppet-idle`, `puppet-taken`, `puppet-off`) in a browser.

## What STAGE has to match (the receiving side)

1. `GET /api/tiktok-event` answers `v: 2`. (A `ready` message with `wire: 2` is welcome; without it LIVE Link looks
   for `cleanShow` in `js/mask-wire.js`.)
2. `show` and `control` come through the same doors as events (`{ t: 'event', ev }` and the POST). They must reach
   the page even when the avatar is OFF in OBS (today `fireEvent` drops everything while it is off).
3. A like with no handle and no uid = the crowd (see C1).
4. `mythic` counts the EXTRA MYTHICs (0 at the first MYTHIC).
5. A score with `onAir: false` and a song = the grade for the song that just ended.
6. `label` is plain text without "!" ("ON FIRE", "MYTHIC x2"); STAGE already writes its own label from `rank`.

## Real and mocked

**Real:** the hype numbers, the tier table and the climb's arithmetic (read from the site's source); the cover rule
(the overlay's source); the verdict values and their counts (prod, read-only); the shape of the five public tables,
confirmed with one single-row GET each using the publishable key; the gift-picture host (prod); the proto shape of a
user's picture (the library's type file).

**Mocked / not proven live:**

- No real TikTok LIVE was connected, so no real viewer picture was ever seen: the non-`tiktokcdn.com` hosts are
  unmeasured (see C2).
- Every site read in the tests goes to `test/mock-server.js`. The feed has not run against the real site.
- The VTuber side is a function or a stand-in server in every test. The vendored VTuber is still V7, so the whole
  path has not run against the real v8 page. The first joint run is after the vendor re-sync.
- `src/main.js` is covered by a syntax check, a few pattern checks, and a test that wires the same pieces the same
  way with the real controller; the Electron app itself was not launched (the owner's LIVE Link, OBS and VTuber may
  be running on this computer). The real `globalShortcut` was never called.
- The stills are the app's page with demo data in an off-screen window, not the packaged app.

**Reads of production made for this work** (all read-only): 6 SELECTs through the Lovable connector (the columns of
the five tables; the grade values and counts; the cover hosts; the gift-picture column and its hosts; one failed on a
type error and changed nothing) and 10 single-row GETs of the five public tables (the first five were wasted by a
bug in my own print line; no loop). Nothing was written, no LIVE Link endpoint was called.

## Site asks

None needed. One thing worth knowing, not an ask: `supabase/functions/compute-heat5` maps `host_grade` through
`{ S, A, ... }` after upper-casing it, but the column holds `fire / gem / solid / promising`, so that lookup gives 0
points for every verdict. Not touched; for the owner to decide.

## Tests (`npm test`: 252 tests, 248 pass, 4 skip, 0 fail; main had 216 = 212 pass + 4 skip)

- `test/v8-events.test.js` (12): the picture hosts and look-alikes; reading a picture from every user shape; ids and
  handles; the family counter; event v2 and v1; the real TikTok link end to end, with a check that nothing new reaches
  the site; a v2 and a v1 VTuber over HTTP; the 2 KB door; the in-app version; one viewer per tap event; the big-room
  crowd; a v1 VTuber's summed taps; control messages and their cap.
- `test/v8-show-feed.test.js` (17): the tier table; rank position and its inverse; the climb; the grade mapping; the
  cover rule; no LIVE / no song; a song on air (reads, cover, the pace); only an open play counts; joining late; the
  verdict during this play only; the late verdict; every way of being off air and odd song ids; the back-off and a
  429; no VTuber = no reads; nonsense from the site; wired with the real controller; main.js's rules.
- `test/v8-keys.test.js` (7): the keys and that none is the "Clip that" key; held only when they can work; one
  message per press and the repeat limit; a taken key; changing keys; a press end to end; which contract the VTuber
  speaks.
- The 2.2.0 files, unchanged, all pass: batcher, capture, clip-e2e (skips), clip-sync-211 (skip), clips,
  controller-208, controller, recording-health, release-210, show-manager-208, show-manager, stream-flags,
  tiktok-link, tiktok-signin, updater, viewers-209, vtuber-212, vtuber-220.

## Weak list (honest)

1. Four of the five picture-host names are unmeasured. If US viewers' pictures live on a family not on the list,
   those missiles fly with the placeholder until the list is fixed; the log line after the first LIVE says which.
2. The grade mapping is my call: Promising = goo may feel harsh on an artist. One line to change (`GRADE_SCORE`).
3. The late verdict (`onAir: false` + song + score) is an addition to C3 that STAGE may not handle yet.
4. Songs whose only picture is a YouTube / Suno thumbnail get no cover.
5. The feed is 0-3 s behind the overlay and its rounding may make it a touch slower still. Never ahead, by design.
6. If the computer's clock is far behind the site's, a play joined late climbs from zero instead of starting at its
   real value (the safe direction).
7. Ctrl+Alt+digit types a symbol on some non-US keyboards (AltGr). While a LIVE runs those symbols cannot be typed;
   the Stream Deck button or "No key" avoids it. On a Mac the same keys read "Control+Option+digit" (not tried).
8. The keys only work during a connected LIVE, so he cannot try them off air from LIVE Link; the page's own buttons
   and keys (STAGE) are for that.
9. In a room with more than 4 different tappers a second, most taps arrive as "the crowd" with no face, up to 3 s
   late. The cap of 4 like events a second is the 2.2.0 contract; raising it is a joint decision with STAGE.
10. One full `npm test` run (of five) did not finish: `test/controller.test.js` (a 2.2.0 file, all 65 of its tests
    pass) sat for 12 minutes without ending while another session was building on this computer. It did not happen
    again in the next two full runs or when run by itself. I could not tie it to this branch's changes or rule it
    out; if a CI run hangs there, that is the place to look.
11. Three of the new tests watch real timers (the 5 s beat, the back-off waits, the tap turns). They were loosened
    after one failed on a busy computer (a timer 49 ms late); a very busy machine could still trip them.
12. No end-to-end run of the packaged app; no run with the real v8 VTuber; the Mac was not tried.

## Fix round (after the independent review; the one and only)

1. **The keys only while the Mask is chosen.** In the app the VTuber's state says which character is chosen
   (`character: 'mask' | 'ryo' | 'melanie'`): the keys are now held only for the Mask, on top of the earlier rules
   (`puppetWanted` in `core/puppet-keys.js`). Two things LIVE Link cannot know: (a) the VTuber's own "Puppet show"
   switch is not in the state it sends, so with the Mask chosen and that switch off the keys are still held (if a
   later VTuber adds `puppet: false` to its state, LIVE Link already gives the keys back); (b) a desktop-shortcut
   VTuber (HTTP) does not say which character is chosen, so there the keys are held as before.
2. **A TAKEN key is tried again every 30 s** while it is still wanted. One log line when it is found taken, one when
   it comes free; the card is redrawn only when something changed; no timer is left when the LIVE ends or on quit.
3. **The LIVE drops: "nothing on air" at once.** `vtuber-link.js` sends
   `{ onAir: false, song: null, hype 0, score: null }` to a v2 VTuber as its last word the moment the TikTok
   connection leaves "live" (before, the Mask kept the last song until its own 15 s time-out). When the LIVE is back,
   or a VTuber starts listening mid-LIVE, the current state is sent at once (`ShowFeed.nudge`), not at the next 5 s beat.

Not changed here (STAGE's side or a joint call): the review's S2 (STAGE counts show + control in the viewers' 10 a
second; LIVE Link gives them their own 6) and S4 (covers over 300 kB are dropped by the VTuber's picture door; LIVE
Link passes the site's full-size artwork address).

Tests after the fix round: `npm test` 256 tests, 252 pass, 4 skip, 0 fail (v8-events 13, v8-show-feed 18, v8-keys 9).

## 2.3.0: the vendor re-sync (Part 2 of the fix round)

- `vendor/vtuber` re-synced with `node scripts/sync-vtuber.js --from D:\claude-cache\vtuber-v8 --commit b07a495` (the
  same script and the same allow-list as every sync before: the VTuber repo's own `runtime-files.json` at that commit,
  files read straight from git, so nothing git-ignored, no testdata, no tmp, no review media can come along; the pin
  test checks it). Pin `b07a495f9fb6be272cc5839bbab6eb5c16ade1ee`, 124 files, 54.1 MB, 22 test helpers. New files:
  `js/v8-show.js`, `js/v8/*` (5), `mask/mask-hud.js`, `mask/mask-v8.js`.
- `package.json` version 2.3.0 (the pin test's version line follows).
- v2 is ON with this copy: `VtuberHost.wire` = 2 from its files and from its `ready` message; its state carries
  `puppet: true | false`, so the keys are now also given back when the Mask's Puppet show switch is off (the one thing
  the fix round could not know).
- `test/v8-vendor.test.js` (1 test, the REAL vendored VTuber in its own process, a pretend OBS, the stand-in site):
  wire 2 from "ready"; seven keys held with the Mask + Puppet show on; a pressed key reaches the VTuber's page
  (`v8-cmd` goo); Puppet show off = keys given back, on = held again; Ryo = given back; no song on air = zero reads of
  the site while "nothing on air" still reaches the page; a song on air = reads begin and the page gets the song and
  its hype (350 taps, rank 2); off air = reads stop; the LIVE drops = keys back and the page hears "nothing on air".
- `npm test`: 257 tests, 253 pass, 4 skip, 0 fail.
- The VTuber smoke on a PACKAGED app (`scripts/vtuber-smoke.js --app ... --video test/fixtures/synthetic-face.jpg
  --characters ryo,mask --secs 30`; a fenced-in test run: own data folder, pretend OBS, a drawn face, made-up
  viewers): no problem found, no missing file. App start 6.6 s, VTuber window 1.0 s, ready 11.2 s.
  Ryo: 28.3 updates a second (face 28.3), picture to pose 53 ms median / 93 ms p95, avatar page 30 frames a second
  (min 30), 0 errors. Mask: 29.5 updates a second (face 29.5), 51 ms / 79 ms, 30 frames a second median (min 1: one
  slow second), 0 errors. Closing VTuber hid the avatar in OBS in 29 ms. The stand-in site saw only pair, config
  and status (no read of the public tables: nothing was on air).
- **How the packaged app was made, and what it is not:** `npx electron-builder --win --dir --publish never` with its
  output in a folder of its own (`D:\claude-cache\livelink-v8-pack`, deleted afterwards), the way the Mac CI does it.
  No installer, no `npm run dist`, no release script, no tag. Because this worktree's `node_modules` is a junction,
  electron-builder could not follow tiktok-live-connector's own dependencies and left them out of that app; a test
  run never connects to TikTok so the smoke is not affected, but **that folder was not a shippable app**. A build
  from a normal checkout is not affected.
- Seen in the smoke's own output, not changed: with a still picture as the camera the page says "ON, but the picture
  ... is black or frozen" (a still picture does not move; as in 2.2.0), and the card text the smoke notes down for
  each run is the one from a moment before the switch (it wrote "Ryo" for the Mask run).
- Not confirmed by eye: the keys part of the card in the packaged app's own window (no screenshot of it was taken).
  It follows from wire 2 (the packaged `resources/vtuber/js/mask-wire.js` has `cleanShow`) and the card code.

## Release A (2.3.1, Nov 26, 2026): the Mask eats the song at DONE / ADD TO AI RADIO / EAT IT (branch `v8-eat`)

LIVE Link's half. The VTuber's half (`v8-eat` in the VTuber repo) turns these into the eat act; the vendor copy here
is still 2.3.0's until the lead re-syncs it (it drops the new fields and the new control, with no error).

**What changed, in his words:** the Mask no longer needs TikTok to know the song. LIVE Link reads the song on air for
his host straight from the site (as the /live/now overlay does), tells the VTuber when he pressed DONE or ADD TO AI
RADIO, and passes his verdict as a word. A new key, Ctrl+Alt+8, means "eat it now".

- **The song on air without TikTok** (`show-feed.js`): `active_projects` for his host (`host_id` = the one the site's
  `live-link-config` answer names; `ctl.cfg.host_id` in `main.js`), the hype-target row, else the newest; read every
  2.5 s while a v2 VTuber listens, with the existing back-off. The controller's `target` is the word used until that
  read answers (and when the site's config has no `host_id`: then it is the only word, as in 2.3.0), and a NEW target
  from the controller is taken at once. `hold` 'show' / 'song' still mean "nothing on air". TikTok's connection
  gates nothing in the feed any more.
- **The finish** (two ADDED fields of the v:2 `show` message; the version stays 2 because a 2.3.0 VTuber requires
  `v === 2` and drops fields it does not know):
  - `grade`: `'fire' | 'gem' | 'solid' | 'promising' | null`, the word behind `score`.
  - `finish`: `{ id, kind: 'played' | 'radio', at } | null`, said for 20 s; the song (id, title, cover) stays in
    the message with it while nothing else is on air. With the NEXT song already on air the message's `song` is the
    new one and `finish.id` names the old one.
  - `'radio'`: the on-air song's `radio_tracks` row appears, or stops being `preview_only` (read every 2nd round;
    the first answer is only the starting point, so a song that was already in the radio does not finish by it).
  - `'played'`: the song leaves the air and `submissions_public.status` is `'played'` (three looks: at once, 1.5 s,
    4 s; a `played_at` more than a minute older than this airing is an earlier show's DONE). A song CLEARED without
    DONE keeps its status: no finish.
  - One finish per song (both buttons = one; the same song is not finished again within 10 minutes).
  - After a finish the late looks for a verdict run at 1.5 s, 5 s, 10 s and 20 s (2.3.0: the first two). The next
    song going on air ends them: never another song's word during this one.
- **Show + control without TikTok** (`vtuber-link.js`): a v2 VTuber IN THE APP gets `show` and `control` with or
  without a TikTok LIVE; the viewers' events still need the LIVE. The desktop-shortcut VTuber (HTTP) is unchanged:
  it is only asked during a LIVE (nothing is asked of 127.0.0.1 otherwise), so it is reached only then, and is told
  "nothing on air" when the LIVE drops. The VTuber in the app is told nothing at a drop: its show goes on.
- **EAT IT** (`puppet-keys.js`): control action `'eat'` (`{ v: 2, type: 'control', action: 'eat', name: '', at }`),
  an eighth row "Eat it (the song)" on **Ctrl+Alt+8** (Stream Deck preset: F20). It is held whenever the Mask is the
  chosen character, even with the VTuber's Puppet show switch off (`eatWanted`); the other seven follow that switch
  as before. The card's own "Use these keys" switch covers all eight. Keys saved by 2.3.0 gain Ctrl+Alt+8 (or "No
  key" if he had already given Ctrl+Alt+8 to another action).
- Site reads are GET only, with the publishable key: `active_projects`, `radio_tracks`, `submissions_public`
  (+ `status`, `played_at`) on top of 2.3.0's `project_hype`, `hype_plays`, `ranking_board`. `stream_status` is NOT
  read (the controller's `hold` already says when the site's show is off, and its columns were not needed).

**Changed on purpose, beyond the plan's words**
1. The keys and the show state now follow "a v2 VTuber is open in the app", not "a TikTok LIVE is connected". So the
   Ctrl+Alt keys are held (taken from other programs) for as long as VTuber is open with the Mask, show or no show.
2. With a host id, `active_projects` is read every 2.5 s whenever VTuber is open in the app, also with no song on air
   (2.3.0 read nothing without a song).
3. The VTuber in the app is no longer told "nothing on air" when the TikTok LIVE drops.
4. The first `show` message is sent the moment the controller first reports (2.3.0: when the LIVE connected).

**Not done / to know**
- The site's real `live-link-config` answer was not looked at from here; the contract's stand-in (`test/mock-server.js`)
  has `host_id` in it. If the real answer lacks it, the feed falls back to the controller's target (the song is then
  only as fresh as LIVE Link's config poll while TikTok is off) and logs nothing about it.
- Without TikTok the feed cannot see "the site's show is not on" (that word comes from the controller's `hold`, which
  is only set during a LIVE): a song left active on the site with no show running reads as on air.
- A song put on air again within 10 minutes of its finish does not finish a second time.
- If he presses ADD TO AI RADIO within the first read or two of a song going on air (about 5 s), that press can be
  taken as the starting point; DONE still finishes the song.
- The desktop-shortcut (HTTP) VTuber still needs TikTok for show + control (see above).
- The vendored VTuber (2.3.0) does nothing with `grade`, `finish` or the `eat` control until it is re-synced.

Tests: `test/v8-show-feed.test.js` (the song on air without TikTok 4, the finish + the word 7, the old ones adapted),
`test/v8-events.test.js` (show + control without TikTok, the HTTP VTuber as before, the drop), `test/v8-keys.test.js`
(eight keys, EAT IT with the Puppet show off), `test/v8-vendor.test.js` (the real vendored VTuber: eight keys, no
TikTok needed, EAT IT accepted without an error, the keys stay at a LIVE drop). All against the stand-in site and
stand-in VTubers on random ports.

### The fix round (Nov 26, after the independent review): L-1 ... L-8

These replace what the section above says where they differ.

- **L-1, the cover (the blocker).** A new song's FIRST `show` message now carries its title and cover: nothing is
  sent about a new song until its `submissions_public` read has answered or failed once (a fraction of a second; never
  longer than 7 s). Before, the first message had `cover: null` (and `title: ''` without TikTok) and the real cover
  was never eaten. If that read fails the song is said with what is known and the cover follows in a later message.
- **Contract change + L-2.** `finish` is `{ id, kind, at, grade }`: `grade` = THAT song's verdict word or null, as
  known when the finish is seen, and filled in on later messages while the finish is kept, also with the next song
  already on air. With the next song on air only a verdict given BEFORE that song's `activated_at` counts (the host
  gave it for the song he finished; LIVE Link had only not read it yet); the top-level `score` / `grade` then belong
  to the song on air.
- **L-3.** The verdict no longer needs a `hype_plays` row: "during this airing" starts at
  `active_projects.activated_at` when the table said it (else the song's open play, as in 2.3.0). A song nobody
  opened a play for, or whose play was closed early, gets its verdict on air and after DONE. With no play row there
  is no host to compare a verdict's `host_id` with, so any host's verdict given during the airing counts.
- **L-4.** ADD TO AI RADIO in the song's first seconds: a `radio_tracks` row with `preview_only` false and
  `added_at` not before this airing's `activated_at` is a 'radio' finish even on the first read. The starting-point
  rule stays for everything else (an old row: no finish; a preview-only row that goes live during the airing: finish).
- **L-5.** `stream_status?select=is_live,active_submission_id&host_id=eq.{hostId}` is read with every
  `active_projects` look: `is_live === false` = nothing on air. No row, or that read failing, changes nothing (and a
  failure of it does not slow the other reads).
- **L-6.** The eight keys (EAT IT too) are held only while a show is plausible: a song on air, or up to 30 minutes
  after one went off air, or a TikTok LIVE connected (`showFeed.plausible`; `main.js` passes it as `show` to
  `puppetWanted` / `eatWanted`, and `onPlausible` re-syncs the keys when it changes). The card says it in one line.
- **L-7.** After a finish its verdict is looked for at 1.5 / 4 / 7 / 10 / 14 / 18 s (counted from the moment LIVE
  Link saw the finish, which is when the VTuber starts chewing). These replace 2.3.0's two looks for a finished song;
  a song cleared without DONE keeps the two looks (1.5 s, 5 s).
- **L-8.** Pace: every 2.5 s with a song on air, every 5 s with none. Nothing is read while another character than
  the Mask is chosen and no show is plausible (`mask` in `main.js`; a desktop-shortcut VTuber does not say which
  character: taken as the Mask).

**Decided here, beyond the fix list**
1. For 2 minutes after a song went off air the next one is still looked for every 2.5 s (not 5 s): between the songs
   of a show a 5 s pace delayed the next song's cover by up to 5 s and let a verdict given in that gap be taken for
   the song before. Outside a show it is 5 s as asked.
2. A verdict given in the up to 2.5 s between the next song really going on air and LIVE Link seeing it can still
   land on `finish.grade` of the song before.
3. With no usable start time for the airing (no host id AND no open play) the verdict is not asked for at all (it
   could not be placed); 2.3.0 asked and dropped the answer.
4. `active_submission_id` is selected (the contract's query) but not used.
5. EAT IT pressed with no show plausible does nothing (its key is not held then): outside a show he uses the EAT IT
   button in the VTuber window.

Tests: 8 more in `test/v8-show-feed.test.js` (one per item; each fails on 1be13dd), the older ones adapted to the held
first message and the new `finish` shape. The reviewer's contract script with a case per item:
`D:/claude-cache/claude-scratch/review-release-a/contract-fix.js` (30 of 30 checks pass).

## 2.3.1 build (Thu Nov 26 2026, ~00:00-01:00 ET; NOT released yet: release is Saturday 5 AM-noon ET with the owner's go)
- Code: 14f17ef (branch `vtuber-card` fast-forwarded from cacb502; same commit on `main` at origin), VTuber pinned to
  7416148 (album eating + verdict words + the Visualizer fix). `npm test`: 278 tests, 274 pass, 0 fail, 4 skipped.
- Windows (`npm run dist` from this main checkout; real node_modules, so tiktok-live-connector 2.4.4 and all its
  dependencies are packed: the same 59 packages as 2.3.0, 0 unresolved):
  - LIVE-Link-Setup-2.3.1.exe 171,799,467 bytes, sha256 07bd97bce3fdad4820cd835d45f227e0064437248763391fc0095467ebc478fd
  - LIVE-Link-source-2.3.1.zip 4,478,612 bytes, sha256 ca17372a2f80023632f321020177da73d6374d6486e00308d62bae8285c639be
    (byte-identical to `git archive` of 14f17ef); dist/latest.json written locally only.
  - Packaged VTuber smoke (synthetic face, ryo + mask, 30 s), on a PC at ~68 % CPU from other jobs: run 1 failed one
    check (never "Ready." within 90 s), run 2 OK (ready 28.8 s; Ryo 29.7 / Mask 29.2 updates a second; 0 errors);
    close hid the avatar in ~2 s (2.3.0 here: 29 ms). Not a 2.3.1 regression: the Mac CI below measured 178 ms
    (2.3.0 on Mac: 228 ms) and the close path did not change. Re-run on a quiet PC before release.
  - `npm run smoke`: PASS (the mock site saw only pair, config and status).
- Mac: tag v2.3.1-ci1 -> run 45758700826, success (universal, signed with the stable certificate, launch check on
  Apple Silicon + Intel, VTuber smoke: ready 25.1 s, closeHidMs 178, problems []). Pre-release v2.3.1-ci1 holds
  LIVE-Link-2.3.1-mac.dmg (350,711,620 bytes, sha256 171221b73a6be61b07ea8fbf078bc4d80563473aa10121e6e4b3e52961da2ee3),
  LIVE-Link-2.3.1-mac.zip (319,682,998 bytes, sha256 ba8270461cbc0b3fad78ecda8de74b95e5c74648e66eb851f7b1337102a91a9b),
  latest-mac.json, SHA256SUMS.txt (fetch from the public pre-release on release day and check against SHA256SUMS).
- Release day (not done): upload exe + source zip + dmg + mac zip through Lovable-minted upload URLs, then latest.json
  and latest-mac.json LAST; verify eTags and live-link-config; owner's account first; never during a LIVE.

## V9: the galaxy key (branch `galaxy-key`, from 756391d; not built, not released)

- A ninth key, **Ctrl+Alt+9** ("Galaxy"; Stream Deck preset: F21). One press sends
  `{ v: 2, type: 'control', action: 'tap', name: 'galaxy', at }`. The first press calls the galaxy up, the next sends
  it away; the VTuber keeps count, LIVE Link only says "pressed".
- Why not Ctrl+Alt+G (the first idea): Google's Gemini app for Windows takes Ctrl+Alt+G in every window, and Figma
  uses it. Ctrl+Alt+9 was already in the list of keys, it is the next one in the row, and none of the eight moved.
- It follows EAT IT's rule exactly (`always` in `core/puppet-keys.js`, so it rides `eatWanted`): held while a v2
  VTuber is listening with the Mask chosen and a show is plausible (L-6), whatever the Puppet show switch says. The
  card's "Use these keys" switch covers it. At most 4 a second, "taken" on its own row, tried again every 30 s.
- Keys saved by 2.3.1 gain `galaxy: Ctrl+Alt+9` (or "No key" if he had already given Ctrl+Alt+9 to another action).
- The card: a line under the buttons, "Galaxy: press Ctrl+Alt+9 to call the galaxy up. Press it again to send it
  away." It follows the key he picked and is hidden when the galaxy has no key or the keys are switched off. The two
  preset buttons now read "Usual keys: Ctrl+Alt+1 to 9" and "Stream Deck keys: F13 to F21". (Superseded by the next section: the
  line now says "press" only while the key is held, and the presets read "1 to 9 and 0" / "F13 to F23".)
- `core/vtuber-link.js`: C4 gains the action `tap` (names: `galaxy` only).
- The VTuber pinned in `vendor/vtuber` (7416148) does not know `tap`: its `cleanControl` drops it. The key does
  nothing until the vendor is re-synced to a VTuber that listens for it.
- Tests: `test/v9-galaxy-key.test.js` (4), and the counts in `v8-keys`, `v8-events`, `v8-show-feed`, `v8-vendor`.

## V9: the show sign and live overlay keys, honest card lines, the VTuber window size (branch `galaxy-key`; not built, not released)

- Two more rows after the galaxy (the VTuber repo's review/V9-SIGN-NOTES.md "What LIVE Link must change"), sent as
  the existing control message `{ v: 2, type: 'control', action: 'sign' | 'overlay', name: '', at }`:
  - "Show sign: show / hide": **Ctrl+Alt+0** (set by hand: `key` in ACTIONS), Stream Deck preset **F22**.
  - "Live overlay: show / hide": **no key** by default ('off'), Stream Deck preset **F23**.
  - Both are `always` (EAT IT's rule: the Mask chosen and a show plausible, whatever the Puppet show switch says).
- The whole table (usual / Stream Deck): goo 1/F13, fire 2/F14, melt 3/F15, crack 4/F16, eat 5/F17, fight 6/F18,
  vote 7/F19, eat-now 8/F20, galaxy 9/F21, sign Ctrl+Alt+0/F22, overlay none/F23. Ten different keyboard keys, eleven
  different F keys, none of them the "Clip that" keys (MOMENT_KEYS).
- A 2.3.1 key file (eight actions) or a V9-galaxy file (nine) loads with `cleanKeys` as before: each missing action
  gets its usual key, and if he already gave that key to another action, that action keeps it and the new one starts
  with "No key". Nothing he set moves. (A 2.3.1 file with EAT IT on Ctrl+Alt+0 gives the sign "No key".)
- `press()` now sends only for a key LIVE Link actually holds (an action with "No key" sends nothing).
- `core/vtuber-link.js` CONTROL_ACTIONS gains `sign` and `overlay` (name always '').
- The card lines (`core/puppet-keys.js keyLine`): the galaxy and the sign each get a line, worded from the row's
  real state. Held: "press <key> ...". Idle (no show right now): what the key does "during your show ... Right now it
  does nothing." Taken: "another program already uses <key> ... Pick another key". No key, or the keys switched off:
  no line. The overlay gets no line. `test/v9-key-card.test.js` runs the real `ui/ui.js` against a fake DOM built from
  the real `ui/index.html` ids and checks the text in each state (it replaced the source-regex test).
- The VTuber window (`core/vtuber-window.js`): opens at **1366 x 768**, never below **1000 x 640** (the deck draws
  stacked below 1000 wide), always clamped to the primary display's work area as it is now (a screen smaller than the
  minimum gets the screen). If he resized it, the size (never the place; `getNormalBounds`) is saved on close as
  `vtuberSize` in the app's store, never in a test run, and used next time, clamped again. A saved value that is the
  old 600 x 940, under the minimum, or not whole numbers in 1..16384 is ignored. A test run keeps 360 x 560.
- The VTuber pinned in `vendor/vtuber` (7416148) does not know `sign` or `overlay`: its `cleanControl` drops them,
  so both keys do nothing until the vendor is re-synced. Its own desktop-shortcut launcher (`vendor/vtuber/one-click.js`)
  still opens Chrome at 600 x 940; that is the VTuber repo's file, not changed here.
- Tests: `test/v9-sign-keys.test.js`, `test/v9-key-card.test.js`, `test/v9-vtuber-window.test.js`, and the counts in
  `v8-keys`, `v8-events`, `v8-show-feed`, `v8-vendor`, `v9-galaxy-key`.

### Fix round 1 (after the independent review, D:/claude-cache/briefs/livelink-keys-review.md)

- **RELEASE GATE**: `test/v8-vendor.test.js` "RELEASE GATE (V9, never skip)". It feeds every key's control message
  through the VENDORED VTuber's `cleanControl` and is RED with the pinned 7416148, which drops `tap` (galaxy),
  `sign` and `overlay`. It goes green only after a re-vendor to a VTuber that accepts all three together
  (`vtuber-v9-galaxy` alone drops sign and overlay; `vtuber-v9-sign` alone drops tap). No release while it is red.
  Never skip, `.todo` or delete it.
- The window sizes are now the PAGE's: the window is made with `useContentSize: true`, and
  `fitVtuberWindow` measures the frame and keeps page + frame inside the work area. The window minimum is the
  1000 x 640 page plus the frame. The saved `vtuberSize` is the page size.
- The size is saved on `close` AND right before every `destroy()` of the VTuber window, through main.js
  `destroyVtWin`. That covers LIVE Link quitting with the window open, the VTuber process ending, and its page
  crashing or not loading. Never destroy that window any other way.
- The sign and overlay keys are `toggle`: one toggle per press. A press within 0.6 s (`TOGGLE_MS`) of the last one,
  sent or ignored, is a held key repeating. The other keys keep their 4 a second.
- The keys part's summary reads "Ctrl+Alt+1 to 9 and 0" / "F13 to F23" (it said "Ctrl+Alt+1 to Ctrl+Alt+0").
- `scripts/sync-vtuber.js`: NEVER still blocks every .mp3 except exactly `assets/music/countdown-music.mp3`. That
  is the countdown song, the owner's own song, off by default for every host. `test/v9-sync-music.test.js` covers it.
