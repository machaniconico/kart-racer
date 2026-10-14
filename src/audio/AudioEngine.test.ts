import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaceEvent, RaceState } from '../sim/types';

vi.mock('./itemSounds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./itemSounds')>()),
  playFallSound: vi.fn(),
  playHitSound: vi.fn(),
}));

import { AudioEngine } from './AudioEngine';
import * as sounds from './itemSounds';

function fakeContext() {
  const node = () => ({
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    gain: { value: 0, setTargetAtTime: vi.fn() },
    frequency: { value: 0, setTargetAtTime: vi.fn() },
    Q: { value: 0 },
  });
  return class {
    state = 'running';
    currentTime = 1;
    sampleRate = 8;
    destination = {};
    createGain = node;
    createOscillator = node;
    createBiquadFilter = node;
    createBufferSource = node;
    createBuffer = () => ({ getChannelData: () => new Float32Array(8) });
    resume = async () => {};
    suspend = async () => {};
    close = async () => {};
  };
}

async function readyEngine(): Promise<AudioEngine> {
  const engine = new AudioEngine(0);
  await engine.unlock();
  engine.update({
    phase: 'racing',
    karts: [{ id: 0, speed: 10, driftTime: 0, spinTime: 0 }],
  } as unknown as RaceState);
  return engine;
}

describe('AudioEngine hit branching', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { AudioContext: fakeContext() });
    vi.stubGlobal('performance', { now: () => 0 });
    vi.mocked(sounds.playFallSound).mockClear();
    vi.mocked(sounds.playHitSound).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const hit = (value?: number): RaceEvent[] => [{ type: 'hit', kartId: 0, ...(value === undefined ? {} : { value }) }];

  it('value 2 plays the pit fall sound only', async () => {
    (await readyEngine()).playEvents(hit(2));
    expect(sounds.playFallSound).toHaveBeenCalledTimes(1);
    expect(sounds.playHitSound).not.toHaveBeenCalled();
  });

  it('value 1 (band) plays the current hit sound', async () => {
    (await readyEngine()).playEvents(hit(1));
    expect(sounds.playHitSound).toHaveBeenCalledTimes(1);
    expect(sounds.playFallSound).not.toHaveBeenCalled();
  });

  it('no value (rail) plays the current hit sound', async () => {
    (await readyEngine()).playEvents(hit());
    expect(sounds.playHitSound).toHaveBeenCalledTimes(1);
    expect(sounds.playFallSound).not.toHaveBeenCalled();
  });
});
