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
