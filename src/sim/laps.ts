import { TRACK_LENGTH, WALL_HALF_WIDTH, sampleTrack } from './track';
import type { KartState, RaceState } from './types';

export const TOTAL_LAPS = 3;
export const CHECKPOINT_COUNT = 12;
export const CHECKPOINT_DISTANCES = Array.from({ length: CHECKPOINT_COUNT }, (_, i) => i * TRACK_LENGTH / CHECKPOINT_COUNT);

export interface PreviousPosition { x: number; z: number; trackDistance: number }

/** A lap requires every finite gate, in order, crossed in its forward direction. */
export function updateLapTracking(state: RaceState, kart: KartState, previous: PreviousPosition): void {
  if (kart.finishTime !== null) return;
  let delta = kart.trackDistance - previous.trackDistance;
  if (delta > TRACK_LENGTH / 2) delta -= TRACK_LENGTH;
  if (delta < -TRACK_LENGTH / 2) delta += TRACK_LENGTH;
  const moved = Math.hypot(kart.x - previous.x, kart.z - previous.z);
  // Projection jumps and teleports cannot pay off checkpoint or lap distance.
  const validStep = moved < 3.5 && Math.abs(delta) < 5;
  if (!validStep) kart.lapValid = false;
  if (validStep && kart.startedLap) kart.lapProgress += delta;
  const sample = sampleTrack(kart.trackDistance);
  kart.wrongWay = kart.speed > 2 && Math.sin(kart.heading) * sample.tx + Math.cos(kart.heading) * sample.tz < -0.3;
  if (!validStep || delta <= 0) return;

  const crosses = (checkpoint: number): boolean => {
    const gate = sampleTrack(CHECKPOINT_DISTANCES[checkpoint]!);
    const oldSide = (previous.x - gate.x) * gate.tx + (previous.z - gate.z) * gate.tz;
    const newSide = (kart.x - gate.x) * gate.tx + (kart.z - gate.z) * gate.tz;
    if (oldSide > 0 || newSide <= 0) return false;
    const t = -oldSide / (newSide - oldSide);
    const x = previous.x + (kart.x - previous.x) * t;
    const z = previous.z + (kart.z - previous.z) * t;
    return Math.abs((x - gate.x) * gate.nx + (z - gate.z) * gate.nz) <= WALL_HALF_WIDTH;
  };

  if (crosses(0)) {
    if (!kart.startedLap) {
      kart.startedLap = true;
      kart.lapProgress = kart.trackDistance;
      kart.lapValid = true;
      kart.nextCheckpoint = 1;
      return;
    }
    if (kart.nextCheckpoint === 0 && kart.lapValid && kart.lapProgress >= TRACK_LENGTH * 0.98) {
      kart.lap++;
      kart.lapTimes.push(state.time - kart.lapStartTime);
      kart.lapStartTime = state.time;
      state.events.push({ type: 'lap', kartId: kart.id, value: kart.lap });
      if (kart.lap === TOTAL_LAPS) {
        kart.finishTime = state.time;
        state.events.push({ type: 'finish', kartId: kart.id, value: state.time });
      }
    }
    // An invalid lap is re-armed at the next legitimate start crossing.
    kart.lapProgress = kart.trackDistance;
    kart.lapValid = true;
    kart.nextCheckpoint = 1;
  } else if (kart.startedLap && kart.nextCheckpoint !== 0 && crosses(kart.nextCheckpoint)) {
    kart.nextCheckpoint = (kart.nextCheckpoint + 1) % CHECKPOINT_COUNT;
  }
}

export function raceProgress(kart: KartState): number {
  return kart.lap * TRACK_LENGTH + (kart.startedLap ? kart.lapProgress : kart.trackDistance - TRACK_LENGTH);
}

export function getRank(state: RaceState, kartId: number): number {
  const ordered = [...state.karts].sort((a, b) => {
    if (a.finishTime !== null && b.finishTime !== null) return a.finishTime - b.finishTime || a.id - b.id;
    if (a.finishTime !== null) return -1;
    if (b.finishTime !== null) return 1;
    return raceProgress(b) - raceProgress(a) || a.id - b.id;
  });
  return ordered.findIndex((kart) => kart.id === kartId) + 1;
}
