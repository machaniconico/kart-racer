import type { TrackDef } from '../types';

const lower = { roadHalfWidth: 5.5, wallHalfWidth: 8 };
const upper = { roadHalfWidth: 3.6, wallHalfWidth: 8 };
const bank = 12 * Math.PI / 180;

/** One route: lower outer loop, entry jump, upper aqueduct crossing, lower return. */
export const aqueduct: TrackDef = {
  id: 'aqueduct', name: 'AQUEDUCT', layoutVersion: 1, themeId: 'aqueduct',
  physics: {},
  controlPoints: [
    [-150, 0, 0], [-100, 0, 0], [-50, 0, 0], [0, 0, 0],
    [50, 0, 0], [100, 0, 0], [150, 0, 0], [200, 0, 0], [250, 0, 0], [300, 0, 0],
    [330, 0, 8.038476], [351.961524, 0, 30], [360, 0, 60],
    [360, 0, 100], [360, 0, 140], [360, 0, 180], [360, 0, 220],
    [351.961524, 0, 250], [330, 0, 271.961524], [300, 0, 280],
    [240, 0, 280], [180, 0, 280], [120, 0, 280], [60, 0, 280],
    [30, 0, 271.961524], [8.038476, 0, 250], [0, 0, 220],
    // Climb to the aqueduct on a straight, with a level launch and landing.
    [0, 3, 200], [0, 9, 170], [0, 14, 140], [0, 16, 120], [0, 16, 100],
    [0, 16, 60], [0, 16, 20], [0, 16, 0], [0, 16, -40], [0, 16, -90], [0, 16, -120], [0, 16, -140],
    [-8.038476, 14, -170], [-30, 9, -191.961524], [-60, 4, -200],
    // Leave the upper terrace before descending onto the wide lower return.
    [-90, 1, -200], [-120, 0, -200], [-160, 0, -200], [-200, 0, -200],
    [-225, 0, -200], [-250, 0, -200],
    [-280, 0, -191.961524], [-301.961524, 0, -170], [-310, 0, -140],
    [-310, 0, -100], [-310, 0, -60],
    [-301.961524, 0, -30], [-280, 0, -8.038476], [-250, 0, 0], [-200, 0, 0],
  ],
  scale: 1, samplesPerSegment: 16, spline: 'centripetal',
  ...lower,
  // The entire exposed upper section and its recovery runway share the last
  // checkpoint interval, so a fall can return to the entrance without skipping a gate.
  checkpointCount: 3, checkpointPhase: -0.4,
  boxRows: [0.025, 0.13, 0.24, 0.36, 0.47, 0.55, 0.78, 0.9],
  boxLanes: [-2.4, 0, 2.4],
  racingLine: [{ distance: 0, offset: 0 }],
  widthKeys: [
    { distance: 0, ...lower }, { distance: 1210, ...lower },
    { distance: 1250, ...upper }, { distance: 1470, ...upper },
    { distance: 1510, ...lower },
  ],
  // Cross the earlier lower straight at right angles, with 16 m clearance.
  decks: [{ from: 1250, to: 1470 }],
  bankKeys: [
    { distance: 0, roll: 0 }, { distance: 1260, roll: 0 },
    { distance: 1280, roll: bank }, { distance: 1305, roll: bank },
    // Existing crossing validation requires a level, low-roll 40 m approach.
    { distance: 1325, roll: 0 }, { distance: 1375, roll: 0 },
    { distance: 1395, roll: bank }, { distance: 1450, roll: bank },
    { distance: 1470, roll: 0 },
  ],
  surfaces: [
    // The central launch lane leaves the shoulder falls outside its flight envelope.
    { kind: 'jump', from: 1250, to: 1254, duration: 0.8, height: 2,
      offsetMin: -3.5, offsetMax: 3.5 },
    // End the exposed straight before the return bend, leaving a wide descent
    // that throttle-only steering assistance can recover onto after a fall.
    { kind: 'fall', from: 1255, to: 1470, offsetMin: -8, offsetMax: -3.6, respawnAt: 1200 },
    { kind: 'fall', from: 1255, to: 1470, offsetMin: 3.6, offsetMax: 8, respawnAt: 1200 },
  ],
};
