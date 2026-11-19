# VTuber (inside LIVE Link 2.2.0 and later): licences and notices

The VTuber ships inside LIVE Link as plain files in `resources/vtuber` (in this repository: `vendor/vtuber`, a pinned
copy made by `scripts/sync-vtuber.js`; `vendor/vtuber/VTUBER_PIN.json` names the exact commit and hashes every file).

## The VTuber's own code: AGPL-3.0, like LIVE Link

Everything in `vendor/vtuber` that is not listed below (the pages, `js/`, `mask/`, `tracking/*.js`, `tracking/lib/`,
the Node files, the two PowerShell helpers) is written by ReactivVibeAI and is distributed as part of LIVE Link under
the GNU Affero General Public License v3.0 (`LICENSE.txt`). It is included in the source zip that ships with the app.

## Third-party parts

| Part | Where | Licence |
|---|---|---|
| Babylon.js and its glTF loader | `vendor/vtuber/vendor/babylon.js`, `babylon.glTF2FileLoader.min.js` | Apache License 2.0 (full text: `vendor/vtuber/vendor/babylon-LICENSE.md`) |
| MediaPipe Tasks Vision 0.10.21 (JavaScript and WebAssembly) | `vendor/vtuber/tracking/vendor/tasks-vision/` | Apache License 2.0 (Google; see `vendor/vtuber/tracking/vendor/VENDOR.md`) |
| MediaPipe models: face, hand, pose (full and lite) | `vendor/vtuber/tracking/vendor/models/*.task` | Apache License 2.0 (Google; sources and hashes in `VENDOR.md`) |
| ws 8.18.0 (WebSocket library) | `vendor/vtuber/vendor/ws/` | MIT (`vendor/vtuber/vendor/ws/LICENSE`) |

The Apache License 2.0 text: https://www.apache.org/licenses/LICENSE-2.0 (a copy is in `babylon-LICENSE.md`).

## Character and brand art: all rights reserved (NOT under the AGPL)

The following files are brand art of ReactivVibeAI. They are **not** software, they are **not** licensed under the
AGPL or any other open licence, and all rights are reserved. They ship with LIVE Link only so that hosts can use the
characters on their own streams through LIVE Link. They may not be copied out, changed, sold or used anywhere else
without written permission from ReactivVibeAI.

- Ryo and Melanie: the 3D models (`vendor/vtuber/assets/models/*.glb`), their face and texture sheets
  (`vendor/vtuber/assets/faces/*`) and their pictures (`vendor/vtuber/assets/ui/ryo.jpg`, `melanie.jpg`).
- The backgrounds (`vendor/vtuber/assets/bg/*`) and the Mask's picture (`vendor/vtuber/assets/ui/mask.svg`).
- The names and looks of Ryo, Melanie and the Mask.

Because these files are not source code, they are left out of the source zip (`.gitattributes`, `export-ignore`); the
MediaPipe model and WebAssembly files, which are unchanged third-party binaries with public sources (listed in
`VENDOR.md`), are left out of it too. Everything else is in the zip.
