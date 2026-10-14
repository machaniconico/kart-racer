// Scaffold for M6-04: a copy of the current MEADOW layout that M6-04 replaces with STRATOS CITY.
// Kept identical to MEADOW's controlPoints so scaffoldIds() reports it as pending until then.
import type { TrackDef } from '../types';
import { meadow } from './meadow';

export const skyline: TrackDef = { ...meadow, id: 'skyline', name: 'STRATOS CITY', layoutVersion: 1, themeId: 'skyline' };
