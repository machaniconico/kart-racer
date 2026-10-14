// Scaffold for M6-03: a copy of the current MEADOW layout that M6-03 replaces with EMBER CALDERA.
// Kept identical to MEADOW's controlPoints so scaffoldIds() reports it as pending until then.
import type { TrackDef } from '../types';
import { meadow } from './meadow';

export const volcano: TrackDef = { ...meadow, id: 'volcano', name: 'EMBER CALDERA', layoutVersion: 1, themeId: 'volcano' };
