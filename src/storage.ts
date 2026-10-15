const BEST_KEY = 'pocket-circuit.best.v1';
const BEST_KEY_V2 = 'pocket-circuit.best.v2';
const BEST_KEY_V3 = 'pocket-circuit.best.v3';
const BEST_KEY_V4 = 'pocket-circuit.best.v4';
const MUTE_KEY = 'pocket-circuit.muted.v1';
const SENSITIVITY_KEY = 'pocket-circuit.steer-sensitivity.v1';
const ASSIST_KEY = 'pocket-circuit.steer-assist.v1';
const CPU_LEVEL_KEY = 'pocket-circuit.cpu-level.v1';

export const SENSITIVITY_MIN = 1;
export const SENSITIVITY_MAX = 5;
export const SENSITIVITY_DEFAULT = 3;

const LEGACY_TRACK_ID = 'meadow';
// Mirrors the sim course registry; kept local so storage stays independent of sim/.
const KNOWN_TRACK_IDS: ReadonlySet<string> = new Set([
  'meadow', 'canyon', 'snowpeak', 'neon', 'harbor', 'forest', 'volcano', 'skyline',
]);

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

type BestRecord = { time: number; layout: number };

function validLayout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

type BestsV4 = Record<string, Record<string, BestRecord>>;

// Same shape as validLayout; kept local so storage does not import sim/laps.
function validLaps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3;
}

function readV2(): Record<string, number> | null {
  const raw = localStorage.getItem(BEST_KEY_V2);
  if (raw === null) return null;
  const out: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (KNOWN_TRACK_IDS.has(key) && validTime(value)) out[key] = value;
      }
    }
  } catch { /* Corrupt JSON is treated as empty. */ }
  return out;
}

function readV3(): Record<string, BestRecord> | null {
  const raw = localStorage.getItem(BEST_KEY_V3);
  if (raw === null) return null;
  const out: Record<string, BestRecord> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (!KNOWN_TRACK_IDS.has(key) || !value || typeof value !== 'object') continue;
        const { time, layout } = value as { time?: unknown; layout?: unknown };
        if (validTime(time) && validLayout(layout)) out[key] = { time, layout };
      }
    }
  } catch { /* Corrupt JSON is treated as empty. */ }
  return out;
}

function readLegacyV1(): number | null {
  const raw = localStorage.getItem(BEST_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return validTime(value) ? value : null;
}

/** Reads v2, migrating the single v1 best into it as MEADOW the first time v2 is missing. */
function readBestsV2(): Record<string, number> {
  const bests = readV2();
  if (bests !== null) return bests;
  const legacy = readLegacyV1();
  if (legacy === null) return {};
  const migrated = { [LEGACY_TRACK_ID]: legacy };
  localStorage.setItem(BEST_KEY_V2, JSON.stringify(migrated));
  return migrated;
}

/** Reads v3, importing v2 (itself migrated from v1) as layout 1 the first time v3 is missing. */
function readBestsV3(): Record<string, BestRecord> {
  const bests = readV3();
  if (bests !== null) return bests;
  const migrated: Record<string, BestRecord> = {};
  for (const [id, time] of Object.entries(readBestsV2())) migrated[id] = { time, layout: 1 };
  if (Object.keys(migrated).length > 0) {
    try { localStorage.setItem(BEST_KEY_V3, JSON.stringify(migrated)); } catch { /* Reads still work from the migrated copy. */ }
  }
  return migrated;
}

function readV4(): BestsV4 | null {
  const raw = localStorage.getItem(BEST_KEY_V4);
  if (raw === null) return null;
  const out: BestsV4 = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, byLaps] of Object.entries(parsed)) {
        if (!KNOWN_TRACK_IDS.has(key) || !byLaps || typeof byLaps !== 'object' || Array.isArray(byLaps)) continue;
        for (const [laps, value] of Object.entries(byLaps)) {
          if (!validLaps(Number(laps)) || String(Number(laps)) !== laps || !value || typeof value !== 'object') continue;
          const { time, layout } = value as { time?: unknown; layout?: unknown };
          if (validTime(time) && validLayout(layout)) (out[key] ??= {})[laps] = { time, layout };
        }
      }
    }
  } catch { /* Corrupt JSON is treated as empty. */ }
  return out;
}

/** Reads v4, importing v3 as laps 3 only the first time v4 is missing. */
function readBests(): BestsV4 {
  const bests = readV4();
  if (bests !== null) return bests;
  const migrated: BestsV4 = {};
  for (const [id, record] of Object.entries(readBestsV3())) migrated[id] = { '3': record };
  if (Object.keys(migrated).length > 0) {
    try { localStorage.setItem(BEST_KEY_V4, JSON.stringify(migrated)); } catch { /* Reads still work from the migrated copy. */ }
  }
  return migrated;
}

/** Only a record taken on the same course layout and lap count counts; `layout` is TrackDef.layoutVersion (1 when omitted). */
export function loadBest(trackId: string, layout = 1, laps = 3): number | null {
  try {
    if (!KNOWN_TRACK_IDS.has(trackId) || !validLaps(laps)) return null;
    const bests = readBests();
    if (!Object.prototype.hasOwnProperty.call(bests, trackId)) return null;
    const byLaps = bests[trackId];
    if (!Object.prototype.hasOwnProperty.call(byLaps, String(laps))) return null;
    const record = byLaps[String(laps)];
    return record.layout === layout ? record.time : null;
  } catch { return null; }
}

export function saveBest(trackId: string, time: number, layout = 1, laps = 3): void {
  if (!KNOWN_TRACK_IDS.has(trackId) || !validTime(time) || !validLayout(layout) || !validLaps(laps)) return;
  try {
    const bests = readBests();
    (bests[trackId] ??= {})[String(laps)] = { time, layout };
    localStorage.setItem(BEST_KEY_V4, JSON.stringify(bests));
  } catch { /* Private browsing can deny storage. */ }
}

export function loadMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === 'true'; } catch { return false; }
}

export function saveMuted(muted: boolean): void {
  try { localStorage.setItem(MUTE_KEY, String(muted)); } catch { /* Audio remains usable without persistence. */ }
}

export function loadSensitivity(): number {
  try {
    const raw = localStorage.getItem(SENSITIVITY_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isInteger(value) && value >= SENSITIVITY_MIN && value <= SENSITIVITY_MAX ? value : SENSITIVITY_DEFAULT;
  } catch { return SENSITIVITY_DEFAULT; }
}

export function saveSensitivity(level: number): void {
  try { localStorage.setItem(SENSITIVITY_KEY, String(level)); } catch { /* Steering still works without persistence. */ }
}

/** null leaves the initial preference to the active input device. */
export function loadSteerAssist(): boolean | null {
  try {
    const value = localStorage.getItem(ASSIST_KEY);
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch { return null; }
}

export function saveSteerAssist(enabled: boolean): void {
  try { localStorage.setItem(ASSIST_KEY, String(enabled)); } catch { /* The setting still works for this session. */ }
}

// Mirrors sim CpuLevel; kept local so storage stays independent of sim/.
type CpuLevel = 'easy' | 'normal' | 'hard';
const CPU_LEVEL_VALUES: readonly string[] = ['easy', 'normal', 'hard'];

export function loadCpuLevel(): CpuLevel {
  try {
    const value = localStorage.getItem(CPU_LEVEL_KEY);
    return value !== null && CPU_LEVEL_VALUES.includes(value) ? value as CpuLevel : 'normal';
  } catch { return 'normal'; }
}

export function saveCpuLevel(level: CpuLevel): void {
  try { localStorage.setItem(CPU_LEVEL_KEY, level); } catch { /* The level still applies for this session. */ }
}
