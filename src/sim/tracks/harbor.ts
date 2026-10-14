// Scaffold for M6-01: a copy of the current MEADOW layout that M6-01 replaces with TIDEWATER HARBOR.
// Kept identical to MEADOW's controlPoints so scaffoldIds() reports it as pending until then.
import type { TrackDef } from '../types';
import { meadow } from './meadow';

export const harbor: TrackDef = { ...meadow, id: 'harbor', name: 'TIDEWATER HARBOR', layoutVersion: 1, themeId: 'harbor' };
