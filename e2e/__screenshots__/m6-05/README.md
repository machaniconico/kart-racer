# M6-05 evidence — darwin-arm64

All five acceptance criteria were verified locally. Linux screenshots remain **pending-ci (M6-06)**.

## Verification

- `VITE_KART_DEBUG=1 npm run build`: **one build**, successful; see [build.log](build.log). Playwright only starts preview, and CI now builds once explicitly.
- [dist-sha256.json](dist-sha256.json): hashes recorded immediately after the build and checked unchanged after the final E2E run.
- `npm test`: **45 files, 1772 tests passed**, Vitest 98.45 s / wall 98.72 s. See [npm-test.log](npm-test.log).
- `npm run typecheck`: passed, including E2E TypeScript. See [typecheck.log](typecheck.log).
- `npm run e2e -- --update-snapshots=none --global-timeout=3600000`: **29/29 passed**, wall **1437.15 s (23 min 57.15 s)**. See [e2e-full.log](e2e-full.log).
- E2E ran alone, workers 1, with no concurrent story/build. C-010 passed eight courses × three laps. All 27 Darwin goldens were compared with updates disabled.
- Final cleanup retained the original CANYON geometry upper bound. The focused sixteen-switch rerun passed **1/1**, wall **24.42 s**, with the same build; see [e2e-memory-final.log](e2e-memory-final.log).
- Sixteen switches (eight courses × two) passed: disposed geometry count always 0, repeat-course counts identical, maximum 90. See [geometry-memory.json](geometry-memory.json).
- Full-suite time is below 35 min; workers 2 was not needed. Keep 300 s/test and the 45 min CI budget. Courses took 16.9 min and multiplayer 5.9 min; Linux CI duration is not yet measured.

## Baselines

Handling: eight CPUs × seeds `[1, 42, 98765]` × three laps = 72 laps per course, with deterministic replay. All eight baseline ratios are enforced at 0.95–1.05. Original four handling rows re-measured exactly to M5-05; their lengths are pinned in `tracks.test.ts`.

Rendering: Chromium, 1280×720, DPR 1, seed 127, desktop shadows, ten stationary frames per view. Every group of ten frames matched exactly. Golden capture also pins renderer elapsed time to 0 because item-box spin/bob uses a separate clock.

| Course | Mean lap (s) | Wall / band hits | Grid calls / triangles | Meshes | Triangle cap |
| --- | ---: | ---: | ---: | ---: | ---: |
| harbor | 69.73750000000001 | 0 / 0 | 129 / 110460 | 47 | 170474.44 |
| forest | 70.53587962962962 | 0 / 0 | 134 / 133980 | 38 | 164241.93 |
| volcano | 67.82407407407408 | 0 / 0 | 132 / 100648 | 37 | 165938.06 |
| skyline | 67.35324074074076 | 0 / 1 | 136 / 90174 | 40 | 173425.67 |

All feature views passed positive calls/triangles, calls ≤ 200, and triangles ≤ `60 * length + 30000`. [render-measurements.json](render-measurements.json) contains every measured viewpoint from the final full run. FPS uses 30 requestAnimationFrame-paced static renders with GPU completion; it includes the active application loop plus the probe render, not a hardware gameplay benchmark.

MEADOW and SNOWPEAK rendering remain at M5-05. CANYON is 139 / 124630 / 43 meshes and NEON 134 / 115336 / 38 meshes, matching M6-09. Protocol 16 COURSE_FINGERPRINT is **513548114**; protocol 15 **642527371** remains pinned. `scaffoldIds()` is fixed to an empty array.

## Golden and visual review

The [darwin directory](../darwin) contains 22 new-course scene views, four minimaps, and one title/picker golden. The title comparison isolates the UI by hiding the animated background canvas. All scene/title PNGs are 1280×720. M6-09's five visual items and remaining observations are in [followups.md](followups.md), inside the allowed file scope.

## Capture history and limits

- [render-measurement.log](render-measurement.log): initial capture-only preflight, 9 cases / 6.2 min; this did not claim race completion.
- [e2e-interrupted-clock.log](e2e-interrupted-clock.log): first full attempt was interrupted after item-box animation produced small golden differences; wall 416.27 s. The capture clock was then pinned.
- [golden-fixed-clock.log](golden-fixed-clock.log): corrected capture-only preflight, 4 cases / wall 188.00 s. The temporary measurement-only return was removed before the final full run.
- CI budget uses the complete successful run above; capture and debugging attempts are recorded separately.
- Independent reviewer spawning was unavailable (`no thread with id`). Static diff review and all automated checks were completed locally; no independent approval is claimed.

No course definition, theme, or `surfaces.test.ts` MEADOW golden was changed.
