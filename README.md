# ReactivVibe LIVE Link

A small Windows app for ReactivVibe hosts. While you're LIVE on TikTok, every tap (heart) your viewers send fills
the hype bar on your reactivvibeai.com show.

## For hosts
1. Download **LIVE Link for Windows** from your host dashboard and run it. Windows may show a blue
   "Windows protected your PC" box the first time (the app isn't code-signed yet): click **More info**, then
   **Run anyway**.
2. On your host dashboard, open **LIVE Link**, click **Connect**, and type the 8-character code into the app.
3. Click **Approve** on the dashboard.
4. Make sure your TikTok username is saved and verified on the dashboard (a one-time code in your TikTok bio).
5. Go LIVE on TikTok as usual. The app connects by itself and shows **LIVE** in red. Leave it running; closing the
   window keeps it in the tray. **Settings -> Start with Windows** makes it start on its own.

The app never asks for your TikTok password. It watches your LIVE the way a viewer would.

### VTuber (2.2.0+): be Ryo, Melanie or the Mask on your stream
You need OBS (the character is put on top of your camera in OBS). Then:
1. Open LIVE Link.
2. On the **VTuber** card click **Open VTuber**. A VTuber window opens.
3. Click **Ryo**, **Melanie** or **Mask**.
4. Press **ON**. Your viewers now see the character instead of your camera. **OFF**, or closing the VTuber window,
   shows your camera again within 3 seconds.

It finds OBS and your camera by itself and adds one source called "VTuber Avatar" above your camera; nothing else in
your scenes is touched, and **More > Remove VTuber from OBS** takes it out again. If something is in the way, the card
says what to do in one sentence. The one thing some hosts must do once: in OBS click **Tools > WebSocket Server
Settings**, tick **Enable WebSocket server**, click **OK**. On a Mac, macOS asks once to allow the microphone (the
character's mouth follows your voice). Your picture and your voice never leave your computer.

### Recording (2.0+)
LIVE Link records each TikTok LIVE on your computer and, after the LIVE, turns every song review into a clip for the
artist. If TikTok won't hand LIVE Link your LIVE's video (the recording card turns red and says why), 2.0.8 gives you
two ways to record anyway, both only on your computer:
- **Sign in to TikTok inside LIVE Link** (Settings, or the red card's button): TikTok's own login page opens in a
  LIVE Link window; LIVE Link then asks TikTok for your video as a signed-in viewer (some LIVEs, e.g. 18+, only show
  their video to signed-in viewers). Your password never touches LIVE Link; "Sign out" clears it.
- **Back-up recording** (on by default; switch it off in Settings): if TikTok sends no video within 75 seconds, LIVE Link records your stream window
  (TikTok LIVE Studio or OBS) with your computer's audio instead, and makes the clips from that.

## How it works
- TikTok: `tiktok-live-connector` 2.4.4, the same library and reconnect rules the T.O.S CREW show program uses.
  It connects by username (no login), holds TikTok's live WebSocket open for the whole show, and reads like
  batches (`count` = taps in the batch, `total` = the room's running like total).
- Site: the LIVE Link endpoints described in the site repo's `.lovable/plan.md`. Taps are credited from
  `session_total` (TikTok's room total), so retries and short outages never lose or double count taps. The first
  push for a room sets the baseline; the app reports the total from just before its first batch so those taps count.
- The device token is encrypted with Windows DPAPI (Electron `safeStorage`) and rotated on every start.
- VTuber (2.1.2, `src/core/vtuber-link.js`): while a LIVE is connected, the app asks `127.0.0.1:8791` every 15 s
  whether a VTuber is listening and, only while one answers, posts each finished gift combo, likes (at most 4 sends a
  second), comments, follows and shares to it. Nothing for the host to set up; nothing of it goes to the site, the log
  or the disk, and no other address is ever used.

- VTuber card (2.2.0, `src/core/vtuber-host.js`, `vendor/vtuber`): **Open VTuber** starts the VTuber in its own process (an
  Electron utility process running `vendor/vtuber/livelink-host.js`), which serves its page and the OBS avatar source on
  `127.0.0.1:8791` (or 8792-8795 when that place is taken by another program; a desktop-shortcut VTuber already holding
  it is left alone and the card says so). The page opens in a LIVE Link window with its own session: no Node, locked to
  that address, the microphone allowed, and on Windows the ONE OBS camera window the VTuber names, picked by its exact
  window number (no share list). On a Mac the camera is read through OBS's own pictures, so no Screen Recording
  permission is asked. While it runs, the TikTok events above are handed to it inside the app instead of over HTTP.
  An update never installs while VTuber is ON. `live-link-config` may carry `vtuber: { enabled: false }` to hide the
  card for a host; a missing field means ON.
- `vendor/vtuber` is a pinned copy of another repository. Never edit it here: `node scripts/sync-vtuber.js --from <VTuber
  repo> [--commit <commit>]` replaces it and writes `vendor/vtuber/VTUBER_PIN.json`; `npm test` fails when a file differs
  from the pin. Licences: `docs/licenses/VTUBER.md` (the character art is brand art, all rights reserved, not AGPL).

## For developers
```
npm install
npm test            # unit + flow tests against a local mock of the site
npm run smoke       # launches the real app hidden against the mock (no TikTok traffic)
npm run mock        # mock site on http://127.0.0.1:8799/functions/v1/ (pair code TEST2345)
set LIVE_LINK_API=http://127.0.0.1:8799/functions/v1/ && npm start
npm run dist        # requires a clean git tree: source zip + installer + dist/latest.json
npm run vtuber-smoke   # the VTuber card end to end on the real app: own data folder, mock site, pretend OBS, no TikTok
```
Release: upload `dist/LIVE-Link-Setup-<v>.exe`, `dist-source/LIVE-Link-source-<v>.zip` and `dist/latest.json`
to the site's public `live-link` storage bucket.

## License
GNU Affero General Public License v3.0 (see `LICENSE.txt`), because it includes `tiktok-live-connector` and
`tiktok-live-proto` (AGPL-3.0-only). The installer ships the complete source in `resources/source`.
