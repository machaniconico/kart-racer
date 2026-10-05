import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRouletteView, nextRouletteItem, rouletteInterval, rouletteItems, stepRoulette } from './itemIcons';
import { playRouletteSound, type SoundKit } from '../audio/itemSounds';
import { interpolateState } from '../net/interpolation';
import { attachKartEffects, updateKartEffects } from '../render/itemVisuals';
import { createRace } from '../sim/race';
import { ROULETTE_TIME } from '../sim/items';

describe('item roulette presentation', () => {
  it('flashes all 14 icons and slows down as the remaining time runs out', () => {
    expect(rouletteItems).toHaveLength(14);
    const fast = rouletteInterval(ROULETTE_TIME, ROULETTE_TIME);
    const middle = rouletteInterval(ROULETTE_TIME / 2, ROULETTE_TIME);
    const slow = rouletteInterval(0.01, ROULETTE_TIME);
    expect(fast).toBeLessThan(middle);
    expect(middle).toBeLessThan(slow);
    expect(fast).toBeGreaterThan(1 / 60);
    expect(slow).toBeLessThan(0.3);
    expect(rouletteInterval(-1, ROULETTE_TIME)).toBe(rouletteInterval(0, ROULETTE_TIME));
    expect(rouletteInterval(9, ROULETTE_TIME)).toBe(fast);
  });

  it('never repeats the current icon and stays in range for any random value', () => {
    for (const current of rouletteItems) {
      for (const value of [0, 0.5, 0.999999, 1]) {
        const next = nextRouletteItem(current, () => value);
        expect(next).not.toBe(current);
        expect(rouletteItems).toContain(next);
      }
    }
    expect(rouletteItems).toContain(nextRouletteItem(null, () => 1));
  });

  it('plays a short click per switch and a longer ding on the stop through the tracked kit', () => {
    const calls: { kind: string; duration: number }[] = [];
    const kit: SoundKit = {
      tone: (_frequency, _start, duration) => calls.push({ kind: 'tone', duration }),
      noise: (_start, duration) => calls.push({ kind: 'noise', duration }),
    };
    playRouletteSound(kit, 'tick', 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].duration).toBeLessThan(0.06);
    calls.length = 0;
    playRouletteSound(kit, 'stop', 0);
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((call) => call.duration))).toBeGreaterThan(0.3);
  });
});

describe('roulette view state machine', () => {
  const run = (view: ReturnType<typeof createRouletteView>, from: number, to: number, reduced = false) => {
    const steps: (string | null)[] = [];
    for (let t = from; t > to + 1e-9; t -= 1 / 60) steps.push(stepRoulette(view, t, reduced, ROULETTE_TIME));
    return steps;
  };

  it('restarts the flick timing when a new roulette replaces a running one (storm steal + same-tick pickup)', () => {
    const view = createRouletteView();
    run(view, ROULETTE_TIME, 0.2);
    expect(view.active).toBe(true);
    // The item was stolen and a box grabbed on the same tick: rouletteTime jumps back up without a 0 frame.
    expect(stepRoulette(view, ROULETTE_TIME, false, ROULETTE_TIME)).toBe('start');
    expect(view.lastSwitch).toBe(ROULETTE_TIME);
    const steps = run(view, ROULETTE_TIME - 1 / 60, ROULETTE_TIME - 0.3);
    expect(steps.filter((step) => step === 'switch').length).toBeGreaterThanOrEqual(3);
  });

  it('switches to the still "?" when reduced motion turns on mid-spin, and resumes when it turns off', () => {
    const view = createRouletteView();
    stepRoulette(view, ROULETTE_TIME, false, ROULETTE_TIME);
    expect(view.item).not.toBeNull();
    expect(stepRoulette(view, 1.2, true, ROULETTE_TIME)).toBe('restyle');
    expect(view.item).toBeNull();
    expect(run(view, 1.18, 0.7, true).every((step) => step === null)).toBe(true);
    expect(view.item).toBeNull();
    expect(stepRoulette(view, 0.69, false, ROULETTE_TIME)).toBe('restyle');
    expect(rouletteItems).toContain(view.item);
    expect(run(view, 0.67, 0.1)).toContain('switch');
    expect(stepRoulette(view, 0, false, ROULETTE_TIME)).toBe('stop');
    expect(stepRoulette(view, 0, false, ROULETTE_TIME)).toBeNull();
  });
});

describe('roulette state outside the HUD', () => {
  it('interpolates rouletteTime discretely like the other effect timers', () => {
    const fromState = createRace(1);
    const toState = structuredClone(fromState);
    fromState.karts[0].effects.rouletteTime = 1;
    toState.karts[0].effects.rouletteTime = 0;
    const from = { raceId: 1, hostTime: 1000, state: fromState, lastAppliedInput: [] };
    const to = { raceId: 1, hostTime: 1050, state: toState, lastAppliedInput: [] };
    expect(interpolateState(from, to, 1025).karts[0].effects.rouletteTime).toBe(1);
    expect(interpolateState(from, to, 1050).karts[0].effects.rouletteTime).toBe(0);
  });

  it('hides the orbit guard while its roulette spins, matching the sim hitbox', () => {
    const root = new THREE.Group();
    const effects = attachKartEffects(root);
    const kart = createRace(42).karts[0];
    kart.item = 'barrier';
    kart.effects.orbitKind = 2;
    kart.effects.orbitCount = 3;
    kart.effects.rouletteTime = ROULETTE_TIME;
    updateKartEffects(effects, kart, 1);
    expect(effects.orbit.every((mesh) => !mesh.visible)).toBe(true);
    kart.effects.rouletteTime = 0;
    updateKartEffects(effects, kart, 1);
    expect(effects.orbit.filter((mesh) => mesh.visible)).toHaveLength(3);
  });
});
