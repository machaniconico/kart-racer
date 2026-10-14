# M6-05 visual followups (darwin)

The story's file lock excludes `.omc/followups.md`; this file records the handoff inside the permitted screenshot directory.

## Remaining work

- **M6-06 / pending-ci:** capture Linux goldens on Linux. Darwin images must not be copied to Linux baselines.
- **Performance observation:** the 30 paced, GPU-synchronized stationary frames on the four new courses measured about 3.84–7.01 FPS on this headless Darwin run. These numbers include the active application render loop and the explicit probe render; they are not a hardware gameplay FPS benchmark. Draw calls and triangles passed every sampled feature view. Consider a separate hardware gameplay profile if a frame-rate target is introduced.
- **Optional visual polish:** at the VOLCANO pit approach, the bright pit floor and jump strip are similar orange tones. The opening/rim geometry is visible and no floating decal was observed, but stronger contrast could make the hazard easier to read. See [volcano-pit](../darwin/volcano-pit.png).

## M6-09 screenshot review

- Pit decals: [VOLCANO](../darwin/volcano-pit.png) and [SKYLINE](../darwin/skyline-pit.png) show exposed openings without a decal spanning the hole.
- Pit edge walls: those same views show the cut road edge; SKYLINE retains its open sky below the hole.
- Tapered island scenery: [HARBOR](../darwin/harbor-island.png) and [SKYLINE](../darwin/skyline-island.png) show broad scenery bodies and clear tapered noses, without the previous needle-shaped props.
- Lane width: both approach images retain two usable lanes around the island. Exact widths remain protected by the existing unit tests.
- Minimap joins: [HARBOR](../darwin/harbor-minimap.png) and [SKYLINE](../darwin/skyline-minimap.png) show connected split entrances/exits and no visible break in the closed loop. The start marker covers part of the seam; the existing canvas-path tests additionally check closure at distance length/0.
