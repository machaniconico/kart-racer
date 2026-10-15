import { TRACK_IDS } from '../sim/tracks';
import { decodeFrames } from './codec';
import { CHECKPOINT_INTERVAL, GHOST_FORMAT, MAX_GHOST_TICKS } from './record';
import type { GhostRecord } from './record';

const GHOST_KEY = 'pocket-circuit.timeattack.v1';
const BEST_LAP_KEY = 'pocket-circuit.bestlap.v1';
const knownTracks: ReadonlySet<string> = new Set(TRACK_IDS);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validLayout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function validLaps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3;
}

function readRecords(key: string): Record<string, unknown> {
  const raw = localStorage.getItem(key);
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) ? value : {};
  } catch { return {}; }
}

function validGhost(value: unknown): value is GhostRecord {
  if (!isObject(value) || value.format !== GHOST_FORMAT || typeof value.trackId !== 'string' ||
    !knownTracks.has(value.trackId) || !validLayout(value.layout) || !validLaps(value.laps) ||
    !Number.isSafeInteger(value.seed) || !validTime(value.time) ||
    typeof value.ticks !== 'number' || !Number.isInteger(value.ticks) || value.ticks < 0 || value.ticks > MAX_GHOST_TICKS ||
    typeof value.frames !== 'string' || !Array.isArray(value.lapTimes) || value.lapTimes.length !== value.laps ||
    !value.lapTimes.every(validTime) || !Array.isArray(value.checkpoints)) return false;
  let previousTick = -1;
  for (const checkpoint of value.checkpoints) {
    if (!isObject(checkpoint) || typeof checkpoint.tick !== 'number' || !Number.isInteger(checkpoint.tick) ||
      checkpoint.tick <= previousTick || checkpoint.tick > value.ticks || checkpoint.tick % CHECKPOINT_INTERVAL !== 0 ||
      typeof checkpoint.distance !== 'number' || !Number.isFinite(checkpoint.distance) || checkpoint.distance < 0) return false;
    previousTick = checkpoint.tick;
  }
  decodeFrames(value.frames, value.ticks);
  return true;
}

export function loadGhost(trackId: string, layout: number, laps: number): GhostRecord | null {
  try {
    if (!knownTracks.has(trackId) || !validLayout(layout) || !validLaps(laps)) return null;
    const byLaps = readRecords(GHOST_KEY)[trackId];
    const record = isObject(byLaps) ? byLaps[String(laps)] : null;
    return validGhost(record) && record.trackId === trackId && record.layout === layout && record.laps === laps ? record : null;
  } catch { return null; }
}

export function saveGhost(record: GhostRecord): void {
  try {
    if (!validGhost(record)) return;
    const records = readRecords(GHOST_KEY);
    const existing = records[record.trackId];
    const byLaps = isObject(existing) ? existing : {};
    byLaps[String(record.laps)] = record;
    records[record.trackId] = byLaps;
    localStorage.setItem(GHOST_KEY, JSON.stringify(records));
  } catch { /* Racing remains usable when storage is unavailable or full. */ }
}

export function loadBestLap(trackId: string, layout: number): number | null {
  try {
    if (!knownTracks.has(trackId) || !validLayout(layout)) return null;
    const record = readRecords(BEST_LAP_KEY)[trackId];
    return isObject(record) && record.layout === layout && validTime(record.time) ? record.time : null;
  } catch { return null; }
}

export function saveBestLap(trackId: string, layout: number, time: number): void {
  try {
    if (!knownTracks.has(trackId) || !validLayout(layout) || !validTime(time)) return;
    const records = readRecords(BEST_LAP_KEY);
    records[trackId] = { time, layout };
    localStorage.setItem(BEST_LAP_KEY, JSON.stringify(records));
  } catch { /* Racing remains usable when storage is unavailable or full. */ }
}
