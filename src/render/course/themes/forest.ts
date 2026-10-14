// Scaffold for M6-02 (MOSSWOOD TRAIL, id 'forest'): MEADOW scenery with the decided palette.
// M6-02 replaces the props and landmarks and decides where canopy, trunk and accent are used.
import type { CourseTheme } from '../buildCourse';
import { meadow } from './meadow';

export const forestPalette = {
  canopy: 0x1e4a2a, moss: 0x5c8a3a, trunk: 0x4a3426, fog: 0x3b5a3f, accent: 0xe0583f,
} as const;

export const forest: CourseTheme = {
  ...meadow,
  colors: { ...meadow.colors, ground: forestPalette.moss },
  fog: { color: forestPalette.fog, near: 120, far: 320 },
};
