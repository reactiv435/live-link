# Notes for the site side (send to the Lovable agent with the Phase 1 go)

Contract: site repo `.lovable/plan.md` (commit 0c49df1). The app is built and tested against it with a local mock.
Please confirm or adjust these points while building Phase 1:

1. **Refresh grace.** `live-link-refresh` rotates the token and "the old token stops working immediately". If the
   refresh response is lost (flaky Wi-Fi at app start), the app still holds the old token and the device is lost.
   Please keep the previous token valid until the new one is first used, or for 5 minutes.
2. **Dashboard link.** Please add `dashboard_url` to the `live-link-config` response (the page with the LIVE Link
   card). Until then the app opens https://reactivvibeai.com.
3. **Status meaning.** `connected` = the app is running and watching the host's TikTok username.
   `tiktok_live` = it is inside a live TikTok room right now.
4. **First push per room.** The app sends the room total from just before its first like batch, so the baseline
   push credits 0 and the next push credits every tap it saw. After an app restart in the same room, the first
   push is below `last_session_total` and should credit 0 (clamp at 0).
5. **Headers.** Every call sends `apikey: <publishable anon key>` and `x-client-info: ReactivVibe-LIVE-Link/<v>`;
   device calls add `Authorization: Bearer <device_token>`.
6. **Pushes** go out every `push_interval_ms` only while taps arrive or `deferred > 0`; with no song playing,
   every `idle_push_interval_ms`. Status rides inside each push; a separate status call goes out on state change
   or after `status_interval_ms` without a push.
8. **`rebaseline: true` (new, please support).** When set on a push, store `last_session_total = session_total` for
   that room and credit 0 (it still counts as a normal push for idempotency). The app sends it after leaving test
   mode and after a `not_live` pause, so taps from those stretches are never credited later. `dry_run` pushes
   write nothing, so without this a host who tests for a while would get all test-period taps credited at once.
9. **When the site show is off,** please either accept pushes and advance `last_session_total` without crediting
   (preferred, as the plan says for `target: null`), or return `409 not_live`. The app handles both: on 409 it
   pauses, re-baselines, and resumes when `live-link-config` reports `site_live: true` (it polls config every
   15 s while TikTok is live and the site show is not).
10. **TikTok's room total:** tiktok-live-proto v3 defaults `total` to "0" when TikTok omits it. The app never sends
    a 0 or a total smaller than a batch as `session_total`.
7. **Files to host** in the public `live-link` bucket: `LIVE-Link-Setup-<v>.exe`, `LIVE-Link-source-<v>.zip`,
   `latest.json` `{version, url, sha256, source_url, released_at}`. The dashboard card links the exe and the
   source zip (AGPL).

## After Phase 1 (2026-09-30)
Phase 1 shipped as migration `0027_live_link_phase1` (commit 74f3d33): six functions deployed, refresh grace,
`dashboard_url`, `rebaseline`, clamp-at-0 and `session_total <= 0 -> 400` all verified by the site's own dry run.
The `live-link` bucket is PRIVATE (the project blocks public buckets), files live under `<version>/`.

11. **Update link (Phase 2):** please add to the `live-link-config` response
    `latest: { version, download_url, sha256 }`, where `download_url` is a short-lived signed URL for
    `<version>/LIVE-Link-Setup-<version>.exe`. The app shows "a new version is ready" when `version` is newer and
    opens `download_url` (only links on bxiejoktoknybpraxebm.supabase.co or reactivvibeai.com are opened).
    The dashboard card uses the same kind of signed link for the Download button and the source zip.

## 1.0.4: gifts and the Mac app (2026-10-07)
12. **`session_total >= 0`** (site migration 0030): a brand-new room's first push may report 0. The app still sends at
    least 1 (one tap of a fresh room is never credited), so it works against both rules.
13. **Gifts in `live-link-push`.** Optional `gifts` array, at most 50 per push. Each item:
    `{ key, count, coins, gift_id, name, image_url?, user_handle, user_name, at }`
    - `key` `/^[A-Za-z0-9:_.-]{8,120}$/`: one combo (`c:<hash>:<seq>`) or one single gift (`m:<msgId or hash>`).
    - `count` int 1..100000: the combo's RUNNING total (absolute, never a delta); `coins` int 1..1000000 per unit.
    - `gift_id` digits <= 24; `name` <= 60; `image_url` https <= 500 (TikTok CDN icon, optional);
      `user_handle` <= 60 (no @); `user_name` <= 80; `at` ISO (server time).
    - `session_total` is OPTIONAL when `gifts` is non-empty; without it the site skips all room-total logic.
    - The site keeps the highest `count` per (host, room, key) and credits only `count - previous` units, so retries,
      repeated frames and app restarts can never count a gift twice. Credit = units x coins x 10 taps, into
      `project_hype.gift_taps` (on the bar AND the charts; not subject to the per-minute TikTok tap net). Units with no
      song on air (or the host not live on the site) are consumed, not credited. Dry runs credit nothing.
    - Per-host switch `host_profiles.gifts_enabled` (rollout: ReactivVibeAI first).
    - Response adds `gifts_enabled`, `gifts_credited`, `gift_taps`. Each credited gift is broadcast on the private topic
      `gifts:<host_id>` (event `gift`) for the Now Live overlay's corner alert.
    - App side: combos (gift.type 1, or combo:true) credit live as they build; a lower count after an end, or after a
      3 s quiet gap, is a new combo; gifts to another host (multi-guest/battles) and unpriced gifts are skipped.
14. **Platform-aware updates.** The app calls `live-link-config?platform=<win32|darwin>&arch=<x64|arm64>`. For darwin
    the site builds `latest` from `latest-mac.json` (bucket root):
    `{ version, file: "<v>/LIVE-Link-<v>-mac.dmg", sha256, size, zip_file, zip_sha256, zip_size, released_at }`.
    `latest.json` stays Windows-only for installed Windows apps. Mac builds come from `.github/workflows/mac.yml`.

## 1.0.5: smooth-running review (2026-10-08)
15. **Status while paused / on quit.** While the host has LIVE Link paused, status (and the status inside pushes) carries
    `connected: false` and `last_error: "Paused in the app"`; the dashboard and the Go Live check show it as paused,
    not broken. Quitting sends one last status `{ connected: false, tiktok_live: false, last_error:
    "LIVE Link was closed on this computer", tiktok_room_id: null, session_total: null }` (best effort, 1.5 s).
    Pause is not kept across a restart, and it ends by itself when `site_live` goes from false to true.
16. **Poison batches.** A push that gets a 5xx three times while config/status calls succeed is resent with a new
    `batch_id`: first without `events`, then without `gifts` (logged as dropped), then the app re-baselines
    (`rebaseline: true`). While the whole site fails, pushes are only retried with the same `batch_id`.
17. **Gift queue.** Up to 20,000 queued gift items (one per combo) are held through an outage; beyond that the oldest
    are dropped and logged. Off-air gifts: the site answers them as a thank-you only (no hype); the app needs no change.

## 1.0.6: room-ID lookups (2026-10-09)
18. **Status `reason`.** Every status (standalone and inside pushes) now carries `reason`, a short code for why this
    computer is not in the host's TikTok LIVE (null while it is): `paused`, `not_watching`, `not_live`, `connecting`,
    `room_id_blocked` (TikTok refuses room lookups from this network), `tiktok_user_not_found` (TikTok says the
    username doesn't exist), `rate_limited`, `manual_room_rejected` (a pasted LIVE belongs to another account),
    `tiktok_unreachable`. `last_error` carries a sentence ending in the same code, e.g.
    "TikTok is blocking LIVE lookups from this network (room_id_blocked)". ll_status ignores unknown fields today.
19. **Lookups.** Refused room lookups back off 30 s, 1, 2, 5 min (+-20 % jitter) and are remembered across restarts
    (no lookup within 2 min of a refused one); an unknown account is retried every 5 min; before the site show is on
    TikTok is checked every 3 min (30 s once it is on). A LIVE's room ID is reused for reconnects. A host can paste
    their LIVE link or room ID (Settings); the app only uses it if the room's owner is the verified username.
20. **1.0.7: TikTok's LIVE page decides "is it LIVE".** Before connecting, the app reads the account's LIVE page
    (fallback TikTok's API): status 4 or no room = not LIVE, no connection at all. Reason: for an ended room TikTok's
    room-info call now answers status_code 4003110 with no data, so the connector's own check passed and it
    "connected" to finished LIVEs (hosts looked connected while not LIVE). Rooms nobody confirmed live (a remembered
    room, or one only the Euler sign server returned) count as LIVE only after real LIVE data within 20 s.

## 2.0: recording, review clips, tapper names (2026-10-16)
21. **`tappers` in `live-link-push`** (built by the site 10-16, commit 5dca90a): optional, at most 20 items
    `{ handle (<= 60, no @), name (<= 80), count (1..100000) }` = taps per viewer since the previous push. Display only
    (the overlay ticker); bad items are dropped silently; never stored long-term. Not sent on dry runs.
22. **`GET live-link-reviews?since=<ISO>&until=<ISO>`** (device token; window <= 26 h). The reviews that played on the
    device's host's show in that window, from `hype_plays` (plays overlapping the window, including one still open):
    `{ server_time, reviews: [{ play_id, submission_id, started_at, ended_at|null, title, artist, host_name,
    rank_name|null, taps }] }`. The app calls it after a LIVE ends to know what to cut.
23. **`POST live-link-clip-upload`** `{ play_id, kind: 'highlight'|'full'|'vertical'|'poster', bytes, content_type,
    duration_ms?, width?, height? }` -> `{ upload_url, path, expires_at }`. The play must belong to the device's host.
    Limits: full <= 400 MB, highlight/vertical <= 150 MB, poster <= 5 MB; content_type video/mp4 (poster image/jpeg).
    Since 2.0.2 `vertical` is always sent: the ~25 s phone cut for TikTok / Reels / Shorts (the site's "Share video" and
    download use it); before 2.0.2 it was only a blurred copy of the highlight for landscape streams.
    `upload_url` = a signed upload URL (upsert) for the PRIVATE bucket `review-clips` at
    `<host_id>/<play_id>/<kind>.<mp4|jpg>`; the app PUTs the file with `content-type` and `x-upsert: true`.
24. **`POST live-link-clip-complete`** `{ play_id, files: [{ kind, path, bytes, content_type, duration_ms, width,
    height }], recipe: { hot: { from, weight } | null, delay_ms } }` -> `{ ok: true, url }`. The site checks each
    object exists with that size, upserts `review_clips`, marks them ready (public), and notifies the artist
    (email + site notification) ONCE per play, when the highlight first becomes ready. Idempotent.
25. **`live-link-config` gains `clips`:** `{ enabled, delay_ms: 8000, pad_start_ms: 4000, pad_end_ms: 8000, hot_sec: 20,
    verdict_sec: 60 }`. `enabled` = the host may upload review clips (per-host switch for the rollout). The app
    records locally either way; it uploads only when enabled, and the host can send a recording later.
    Recipe: highlight = the hottest `hot_sec` of taps + gift hype (10/coin) + the last `verdict_sec` before the host
    moved on; review start/end shift by `delay_ms` (the TikTok copy's delay) with padding; tap times are not shifted.

## 2.0.7: "LIVE but not recording" (2026-10-21)
26. **Recording reasons in the existing status fields (no new endpoint, no new field).** Until 2.0.6 `reason` was
    always null while `tiktok_live: true`. From 2.0.7, while the app is in the host's TikTok LIVE but nothing of it has
    been saved to disk for 60 s, `reason` (standalone status AND the status inside pushes) carries a recording code and
    `last_error` a sentence ending in that code, e.g.
    `"TikTok won't share this LIVE's video with LIVE Link (it answers 'restricted', code 4003110), which usually means
    the LIVE is limited to adults (18+) or to signed-in viewers [room info: status 4003110 (restricted) · api-live: no
    video links · LIVE page: TikTok's bot check (WAF page)] (stream_restricted)"` (<= 500 chars). Codes (all
    `^[a-z_]{1,40}$`): `stream_restricted` (room info answers status_code 4003110 for a LIVE that is on: 18+ /
    signed-in-only), `stream_blocked` (every TikTok request refused: HTTP 403/429, bot check, timeouts),
    `stream_unavailable` (no answer had a video link), `recording_failed` (a link was given but ffmpeg wrote 0 bytes),
    `recording_disk_full` (< 2 GB free), `recorder_missing` (no ffmpeg), `recording_folder` (folder not writable).
    They clear (back to null) as soon as video is being written again or the LIVE ends. The host stopping the
    recording, or switching it off, is not a failure (null). The site should show `tiktok_live: true` + one of these
    codes as "LIVE, but NOT recording: <last_error>" on the dashboard / LIVE Link card (today it likely shows "connected").
27. **session.json (local, sent by the host on request)** gains `app` (version), `streamErrors` (each distinct answer of
    a video-link source once: `{ source, code, http, error, first, last, count }`, at most 40) and `diag`
    (`{ tries, lastTryAt, firstVideoAt, failure, failures[], recordedBytes, result: ok|partial|failed }`); each run
    gains `bytes`, `error`, `quality`, `kind`, `from`. A 0-byte recording is listed as "Recording failed" with the reason.

## 2.0.8: recording no matter what (2026-10-22)
28. **New status reasons** (same fields as item 26, same `^[a-z_]{1,40}$` rule). Problems, shown like the 2.0.7 ones
    ("LIVE, but NOT recording: <last_error>"):
    - `tiktok_signin_needed`: room info answers 4003110 for a LIVE that is on and the host has NOT signed in to TikTok
      inside LIVE Link (2.0.7 called this `stream_restricted`; that code is now only used when the host IS signed in and
      TikTok still refuses). The fix is in the app (Settings > TikTok sign-in for recording, or the red card's button).
    - `stream_sub_only`: TikTok says the LIVE is subscribers-only, a paid event or gated (no video for other viewers).
    - `capture_no_window`: the back-up recording is on but no stream window (TikTok LIVE Studio, OBS...) was found.
    - `capture_failed`: the back-up recording stopped writing.
    One INFORMATIONAL reason, which is NOT a failure and should read as "Recording (back-up)", not red:
    - `recording_window_capture`: TikTok sent no video, so LIVE Link is recording the host's own stream window (with the
      PC's audio) and will cut the review clips from that. `tiktok_live: true`, `last_error` ends in the code like the
      others (e.g. `"Recording the host's stream window instead of TikTok's video (back-up recording) [window: TikTok
      LIVE Studio] (recording_window_capture)"`). Please don't count it as an error in the dashboard's health view.
29. **session.json** gains, per `streamErrors` entry, `status` (TikTok's own `status_code` inside a 200 answer, e.g.
    4003110; `http` stays the HTTP status of a refused request), new source names `"room info (signed in)"`,
    `"api-live (signed in)"`, `"LIVE page (signed in)"` (asked with the host's TikTok sign-in) and `"sign server"` (the
    Euler sign server's room info, fetched from ITS network: when it has links while every source from the host's
    network is refused or answers 4003110, the host's network is the problem, not the LIVE), `diag.flags` /
    `diag.flagsBySource` (`{ ageRestricted, subOnly, paidEvent, gated, regionBlocked, thirdParty (LIVE Studio/OBS),
    audioOnly, multiGuest, multiStream, mode, status }` as each source last described the LIVE), `diag.captured` (true
    when some of the recording is the back-up), and per back-up run `capture: true, source (window title), file,
    mime, width, height`. Nothing in it is a link, a cookie or a token.
30. **TikTok sign-in (host-initiated, optional).** The host signs in on TikTok's own login page inside a LIVE Link
    window (a separate persistent browser session on their PC). LIVE Link only checks that a sign-in cookie exists and
    makes the three lookups through that session; the password and cookies never reach the app's code, the log,
    session.json or the site. Sign out clears the session. No site change.
31. **Back-up recording (host-enabled).** Off by default. Settings toggle + window picker (default: TikTok LIVE Studio,
    then OBS), or one click on the red card ("Record my stream window instead", which also switches it on). Starts 75 s
    after the LIVE began without TikTok video (or after the video died and stayed dead); system audio on Windows, the
    microphone on a Mac (macOS can't loop back its own audio this way). After the LIVE the capture is cut into the
    usual 10-minute pieces (H.264 copied, audio to AAC), so review clips, moments and the full show come out as always;
    clip timing accounts for the capture having no TikTok delay. No site change.
32. **The update banner** in the app is now big, full-width, crimson/black/chrome, "Update LIVE Link: <v> is ready", with
    "Restart to update" / "Update now"; it stays until updated (during a LIVE it can be put off until the LIVE ends),
    and one OS pop-up per new version. `min_app_version` (`update_required`) blocks the whole window behind the same
    flow. The site-side "update your LIVE Link" banner for outdated devices (asked of Lovable) still makes sense: hosts
    on <= 2.0.7 only see the small one-line banner until they install 2.0.8.
