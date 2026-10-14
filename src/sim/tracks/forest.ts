// Scaffold for M6-02: a copy of the current MEADOW layout that M6-02 replaces with MOSSWOOD TRAIL.
// Kept identical to MEADOW's controlPoints so scaffoldIds() reports it as pending until then.
import type { TrackDef } from '../types';
import { meadow } from './meadow';

export const forest: TrackDef = { ...meadow, id: 'forest', name: 'MOSSWOOD TRAIL', layoutVersion: 1, themeId: 'forest' };
