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
