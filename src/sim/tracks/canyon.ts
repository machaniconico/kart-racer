import type { TrackDef } from '../types';

export const canyon: TrackDef = {
  id: 'canyon',
  name: 'SUNSCAR CANYON',
  // Two long canyon shelves joined by broad mesa bends. The middle of each
  // shelf stays collinear through takeoff and the full 0.8-second flight.
  controlPoints: [
    [65, 6, 65], [65, 3, 21.667], [65, 0, -21.667], [65, 1, -65],
    [45.962, 4, -110.962], [0, 8, -130], [-45.962, 12, -110.962],
    [-65, 12, -65], [-65, 9, -21.667], [-65, 6, 21.667], [-65, 3, 65],
    [-45.962, 1, 110.962], [0, 1, 130], [45.962, 4, 110.962],
  ],
  scale: 1,
  samplesPerSegment: 32,
  roadHalfWidth: 7.2,
  wallHalfWidth: 10.5,
  layoutVersion: 2,
  // A narrow section midway through the right-hand bend, with 20 m entry and exit ramps.
  // Leave room after the first pillar to recover before the entry ramp.
  widthKeys: [
    { distance: 190, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
    { distance: 210, roadHalfWidth: 4.0, wallHalfWidth: 7.3 },
    { distance: 250, roadHalfWidth: 4.0, wallHalfWidth: 7.3 },
    { distance: 270, roadHalfWidth: 7.2, wallHalfWidth: 10.5 },
  ],
  // Centre pillars beyond the opening 100 m, clear of item rows, jump landings and gates.
  barriers: [
    { from: 136, to: 152, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
    { from: 361, to: 377, center: 0, halfWidth: 1.2, taper: 4, scenery: 'pillar' },
  ],
  checkpointCount: 12,
  boxRows: [0.19, 0.4, 0.69, 0.9],
  boxLanes: [-4.1, 0, 4.1],
  // Hold the left line through the first landing and pillar; move left early for pillar two.
  racingLine: [
    { distance: 0, offset: 0 }, { distance: 20, offset: -4.5 },
    { distance: 158, offset: -4.5 }, { distance: 178, offset: 0 },
    { distance: 320, offset: 0 }, { distance: 340, offset: -4.5 },
    { distance: 443, offset: -4.5 }, { distance: 483, offset: 0 },
  ],
  surfaces: [
    { kind: 'jump', from: 60, to: 64 },
    { kind: 'jump', from: 393, to: 397 },
    { kind: 'dirt', from: 500, to: 550 },
  ],
  themeId: 'canyon',
};
