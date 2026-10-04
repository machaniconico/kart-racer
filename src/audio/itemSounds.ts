import type { RaceEvent } from '../sim/types';

/** The engine's tracked one-shot voices, so item sounds stop with suspend(). */
export interface SoundKit {
  tone(frequency: number, start: number, duration: number, volume: number, type: OscillatorType, endFrequency?: number): void;
  noise(start: number, duration: number, volume: number, frequency: number): void;
}

/** Uses only the engine's master-routed, tracked voices: mute and suspend apply. */
export function playItemEvent(kit: SoundKit, event: RaceEvent, time: number): void {
  switch (event.type) {
    case 'block':
      kit.tone(1760, time, 0.09, 0.13, 'square', 880);
      kit.tone(2637, time, 0.13, 0.08, 'sine', 1318);
      break;
    case 'explode':
      kit.noise(time, 0.16, 0.30, 1600);
      kit.noise(time + 0.09, 0.32, 0.19, 360);
      kit.tone(125, time, 0.40, 0.22, 'triangle', 35);
      break;
    case 'storm':
      kit.noise(time, 0.18, 0.18, 4200);
      kit.tone(240, time + 0.10, 0.52, 0.14, 'sawtooth', 48);
      kit.noise(time + 0.16, 0.38, 0.14, 480);
      break;
    case 'ink':
      kit.tone(520, time, 0.16, 0.18, 'sine', 95);
      kit.tone(290, time + 0.09, 0.15, 0.12, 'sine', 65);
      kit.noise(time, 0.08, 0.09, 700);
      break;
    case 'aura_start':
      for (const [index, frequency] of [523, 659, 784, 1046, 1318].entries()) {
        kit.tone(frequency, time + index * 0.065, 0.22, 0.12, 'triangle');
      }
      break;
    case 'auto_start':
      kit.noise(time, 0.22, 0.22, 900);
      kit.tone(65, time, 0.42, 0.17, 'sawtooth', 620);
      kit.noise(time + 0.14, 0.28, 0.10, 2400);
      break;
  }
}
