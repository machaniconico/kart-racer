// Scaffold for M6-01 (TIDEWATER HARBOR, id 'harbor'): MEADOW scenery with the decided palette.
// M6-01 replaces the props and landmarks and decides where sand, sea and accent are used.
import type { CourseTheme } from '../buildCourse';
import { meadow } from './meadow';

export const harborPalette = {
  sky: 0x9ad8ff, fog: 0xcfe9f5, road: 0x6f7f86, sand: 0xe6d3a3, sea: 0x2b8fc9, accent: 0xff7a3d,
} as const;

export const harbor: CourseTheme = {
  ...meadow,
  colors: { ...meadow.colors, sky: harborPalette.sky, road: harborPalette.road },
  fog: { ...meadow.fog, color: harborPalette.fog },
};
