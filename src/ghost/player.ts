import { createRace, NEUTRAL_INPUT, stepRace } from '../sim/race';
import type { InputFrame, RaceState } from '../sim/types';
import { decodeFrames } from './codec';
import type { GhostRecord } from './record';

export class GhostPlayer {
  readonly state: RaceState;
  diverged = false;
  private readonly frames: InputFrame[];
  private readonly checkpoints: Map<number, number>;

  constructor(record: GhostRecord) {
    this.frames = decodeFrames(record.frames, record.ticks);
    this.checkpoints = new Map(record.checkpoints.map(({ tick, distance }) => [tick, distance]));
    this.state = createRace(record.seed, { trackId: record.trackId, laps: record.laps, karts: 1, itemBoxes: false });
    this.checkCheckpoint();
  }

  get finished(): boolean { return this.state.karts[0]!.finishTime !== null; }
  get finishTime(): number | null { return this.state.karts[0]!.finishTime; }

  /** Render interpolation snapshots are captured by the caller before this mutates state. */
  step(): void {
    if (this.finished) return;
    stepRace(this.state, [this.frames[this.state.tick] ?? NEUTRAL_INPUT]);
    this.checkCheckpoint();
  }

  private checkCheckpoint(): void {
    const expected = this.checkpoints.get(this.state.tick);
    if (expected !== undefined && this.state.karts[0]!.trackDistance !== expected) this.diverged = true;
  }
}
