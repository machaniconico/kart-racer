const BEST_KEY = 'pocket-circuit.best.v1';
const BEST_KEY_V2 = 'pocket-circuit.best.v2';
const MUTE_KEY = 'pocket-circuit.muted.v1';
const SENSITIVITY_KEY = 'pocket-circuit.steer-sensitivity.v1';
const ASSIST_KEY = 'pocket-circuit.steer-assist.v1';

export const SENSITIVITY_MIN = 1;
export const SENSITIVITY_MAX = 5;
export const SENSITIVITY_DEFAULT = 3;

const LEGACY_TRACK_ID = 'meadow';
// Mirrors the sim course registry; kept local so storage stays independent of sim/.
const KNOWN_TRACK_IDS: ReadonlySet<string> = new Set(['meadow', 'canyon', 'snowpeak', 'neon']);

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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

function readLegacyV1(): number | null {
  const raw = localStorage.getItem(BEST_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return validTime(value) ? value : null;
}

/** Reads v2, migrating the single v1 best into it as MEADOW the first time v2 is missing. */
function readBests(): Record<string, number> {
  const bests = readV2();
  if (bests !== null) return bests;
  const legacy = readLegacyV1();
  if (legacy === null) return {};
  const migrated = { [LEGACY_TRACK_ID]: legacy };
  localStorage.setItem(BEST_KEY_V2, JSON.stringify(migrated));
  return migrated;
}

export function loadBest(trackId: string): number | null {
  try {
    const bests = readBests();
    return KNOWN_TRACK_IDS.has(trackId) && Object.prototype.hasOwnProperty.call(bests, trackId) ? bests[trackId] : null;
  } catch { return null; }
}

export function saveBest(trackId: string, time: number): void {
  if (!KNOWN_TRACK_IDS.has(trackId) || !validTime(time)) return;
  try {
    const bests = readBests();
    bests[trackId] = time;
    localStorage.setItem(BEST_KEY_V2, JSON.stringify(bests));
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
