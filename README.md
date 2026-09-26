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

## How it works
- TikTok: `tiktok-live-connector` 2.4.4, the same library and reconnect rules the T.O.S CREW show program uses.
  It connects by username (no login), holds TikTok's live WebSocket open for the whole show, and reads like
  batches (`count` = taps in the batch, `total` = the room's running like total).
- Site: the LIVE Link endpoints described in the site repo's `.lovable/plan.md`. Taps are credited from
  `session_total` (TikTok's room total), so retries and short outages never lose or double count taps. The first
  push for a room sets the baseline; the app reports the total from just before its first batch so those taps count.
- The device token is encrypted with Windows DPAPI (Electron `safeStorage`) and rotated on every start.

## For developers
```
npm install
npm test            # unit + flow tests against a local mock of the site
npm run smoke       # launches the real app hidden against the mock (no TikTok traffic)
npm run mock        # mock site on http://127.0.0.1:8799/functions/v1/ (pair code TEST2345)
set LIVE_LINK_API=http://127.0.0.1:8799/functions/v1/ && npm start
npm run dist        # requires a clean git tree: source zip + installer + dist/latest.json
```
Release: upload `dist/LIVE-Link-Setup-<v>.exe`, `dist-source/LIVE-Link-source-<v>.zip` and `dist/latest.json`
to the site's public `live-link` storage bucket.

## License
GNU Affero General Public License v3.0 (see `LICENSE.txt`), because it includes `tiktok-live-connector` and
`tiktok-live-proto` (AGPL-3.0-only). The installer ships the complete source in `resources/source`.
