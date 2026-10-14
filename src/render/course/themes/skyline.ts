// Scaffold for M6-04 (STRATOS CITY, id 'skyline'): MEADOW scenery with the decided palette.
// M6-04 replaces the props and landmarks and decides where glass and accent are used.
import type { CourseTheme } from '../buildCourse';
import { meadow } from './meadow';

export const skylinePalette = {
  sky: 0xdbe7ff, deck: 0x8d9bb5, glass: 0x62c6ff, fog: 0xc7d6f0, accent: 0xff4fa3,
} as const;

export const skyline: CourseTheme = {
  ...meadow,
  colors: { ...meadow.colors, sky: skylinePalette.sky, deck: skylinePalette.deck },
  // A longer fog range than MEADOW (170 / 460) keeps the distant towers visible.
  fog: { color: skylinePalette.fog, near: 220, far: 640 },
};
