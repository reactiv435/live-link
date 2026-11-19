# Vendored files (tracking/vendor)

Everything here is served locally; nothing is loaded from the internet during a show. Download rule (V2-PLAN.md): only
from `registry.npmjs.org` and `storage.googleapis.com/mediapipe-models`. Every file added for v2 is listed with its URL
and SHA-256. Licence of all of it: Apache-2.0 (Google MediaPipe).

## Models (`models/`)

| File | Size (bytes) | URL | SHA-256 | Added |
|---|---|---|---|---|
| `pose_landmarker_full.task` | 9398198 | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task | `5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1` | v2, 2026-11-14 |
| `pose_landmarker_lite.task` | 5777746 | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` | v2, 2026-11-14 |
| `face_landmarker.task` | 3758596 | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task (v1; URL as documented by Google, hash taken from the file on disk) | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` | v1 |
| `hand_landmarker.task` | 7819105 | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task (v1; URL as documented by Google, hash taken from the file on disk) | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` | v1 |

The two pose files were checked after download against the MD5 that Google's storage reports for them
(`x-goog-hash`): full `g4eWidNz0UO+CUyXI1Xkjg==`, lite `BKdd33yBGsehpFIyZt19iA==`. Both matched.

## Libraries

| Folder | What | Source |
|---|---|---|
| `tasks-vision/` | `@mediapipe/tasks-vision` 0.10.21 (v1; `vision_bundle.mjs` saved as `vision_bundle.js`). Other agents' tools load this copy: do not replace it. | npm (v1) |
| `ws/` | `ws` 8.18.0 (Node WebSocket library, used by the test tools) | npm (v1) |

## tasks-vision 1.2.3: tested, NOT vendored (2026-11-14)

The plan allowed a `tasks-vision-1.2.3/` folder if 1.2.3 measured better or more stable in workers. It did not:

- Downloaded for the test only: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.2.3.tgz
  (8798983 bytes, SHA-256 `469602650dab70256df387983ea44e85fa66020335bae85a54fa8fda062ca0a0`; npm integrity
  `sha512-sxJyfhbN+EamexhaaCmUlw7v8vWWMum7VDsORe6d4c8Dk/xlI4qiIgoSw9cE9hpvYhVRRVLIA8y605FbqWkNeQ==` checked).
- Four back-to-back pairs on this PC (same clip, face + pose + hands in workers, graphics card): 1.2.3 was never
  faster. Face model 24.8 to 30.2 ms against 22.5 to 31.1 ms for 0.10.21 (slower in three of four pairs, by about
  10 %); pose and hands the same picture. Both ran without errors. Its wasm is 14.7 MB against 9.6 MB.
- So the tracker stays on 0.10.21 (the `tasks-vision/` folder). The loader still understands `tracker.html?mp=1.2.3`
  if someone puts the files in `tasks-vision-1.2.3/` (`vision_bundle.mjs` saved as `vision_bundle.js`, plus
  `wasm/vision_wasm_internal.js` and `.wasm`) to repeat the comparison.
