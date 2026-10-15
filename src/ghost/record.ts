import type { InputFrame, RaceState, TrackId } from '../sim/types';
import { encodeFrames, quantizeInput } from './codec';

export const GHOST_FORMAT = 1;
export const CHECKPOINT_INTERVAL = 600;
export const MAX_GHOST_TICKS = 36000;

export interface GhostRecord {
  format: number;
  trackId: TrackId;
  layout: number;
  laps: number;
  seed: number;
  time: number;
  lapTimes: number[];
  ticks: number;
  frames: string;
  checkpoints: { tick: number; distance: number }[];
}

type RecordingOptions = Pick<GhostRecord, 'trackId' | 'layout' | 'laps' | 'seed'>;

export class GhostRecorder {
  private readonly options: RecordingOptions;
  private readonly frames: InputFrame[] = [];
  private readonly checkpoints: GhostRecord['checkpoints'] = [];
  private ticks = 0;

  /** seed is the original createRace argument, not the sim's advancing PRNG state. */
  constructor(options: RecordingOptions) {
    this.options = { ...options };
  }

  /** Call once per stepRace, including countdown, and simulate the returned input. */
  push(frame: InputFrame): InputFrame {
    const quantized = quantizeInput(frame);
    this.ticks++;
    if (this.ticks <= MAX_GHOST_TICKS) this.frames.push({ ...quantized });
    return quantized;
  }

  /** Call after stepRace with state.tick; tick zero may also be recorded initially. */
  checkpoint(tick: number, state: RaceState): void {
    if (tick === this.checkpoints.at(-1)?.tick) return;
    if (tick >= 0 && tick <= MAX_GHOST_TICKS && tick % CHECKPOINT_INTERVAL === 0) {
      this.checkpoints.push({ tick, distance: state.karts[0]!.trackDistance });
    }
  }

  finish(state: RaceState): GhostRecord | null {
    const kart = state.karts[0]!;
    if (this.ticks > MAX_GHOST_TICKS || kart.finishTime === null) return null;
    return {
      format: GHOST_FORMAT, ...this.options,
      time: kart.finishTime, lapTimes: [...kart.lapTimes], ticks: this.ticks,
      frames: encodeFrames(this.frames), checkpoints: this.checkpoints.map(checkpoint => ({ ...checkpoint })),
    };
  }
}
