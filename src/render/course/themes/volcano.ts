// Scaffold for M6-03 (EMBER CALDERA, id 'volcano'): MEADOW scenery with the decided palette.
// M6-03 replaces the props and landmarks and decides where the emissive lava and accent are used.
import type { CourseTheme } from '../buildCourse';
import { meadow } from './meadow';

export const volcanoPalette = {
  basalt: 0x2b2224, lava: 0xff4d1a, sky: 0x5a2b24, fog: 0x7a3a2a, accent: 0xffb347,
} as const;

export const volcano: CourseTheme = {
  ...meadow,
  colors: { ...meadow.colors, sky: volcanoPalette.sky, ground: volcanoPalette.basalt },
  fog: { ...meadow.fog, color: volcanoPalette.fog },
};
