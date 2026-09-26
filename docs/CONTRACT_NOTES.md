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
