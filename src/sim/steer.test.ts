import { describe, expect, it } from 'vitest';
import { createRace, stepRace, type InputFrame } from './index';
import { playerSteerToSim } from './steer';

const neutral: InputFrame = { steer: 0, throttle: 0, brake: false, drift: false, useItem: false };

/** Lateral displacement on screen for the chase camera (three.js lookAt along the kart's heading). */
function screenRightAfterSteering(playerRight: number): number {
  const state = createRace(1);
  const me = state.karts.find((kart) => kart.human)!;
  const frames = (steer: number) => state.karts.map((kart) => (kart.id === me.id ? { ...neutral, throttle: 1, steer } : neutral));
  while (state.phase !== 'racing') stepRace(state, frames(0));
  for (let i = 0; i < 60; i++) stepRace(state, frames(0));
  const { heading, x, z } = me;
  for (let i = 0; i < 40; i++) stepRace(state, frames(playerSteerToSim(playerRight)));
  // Camera right for a view direction (sin h, 0, cos h) with +Y up.
  return (me.x - x) * -Math.cos(heading) + (me.z - z) * Math.sin(heading);
}

describe('player steering direction', () => {
  it('turns right on screen for a right input and left for a left input', () => {
    expect(screenRightAfterSteering(1)).toBeGreaterThan(0.5);
    expect(screenRightAfterSteering(-1)).toBeLessThan(-0.5);
  });

  it('leaves a centred stick untouched', () => {
    expect(Object.is(playerSteerToSim(0), 0)).toBe(true);
  });
});
