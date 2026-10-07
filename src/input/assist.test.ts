import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRace, stepRace } from '../sim/race';
import { sampleTrack } from '../sim/track';
import { getTrack, TRACK_IDS } from '../sim/tracks';
import type { InputFrame, TrackId } from '../sim/types';
import { applySteerAssist } from './assist';
import { Controls } from './Controls';

const input: InputFrame = { steer: 0, throttle: 1, brake: false, drift: false, useItem: false };

function solo(trackId: TrackId = 'meadow') {
  const state = createRace(42, { trackId });
  state.phase = 'racing';
  state.karts = [state.karts[0]!];
  state.boxes = [];
  return state;
}

function straight() {
  const state = solo();
  const track = getTrack(state.trackId);
  // Find a straight long enough to exercise held steering, not just a flat inflection.
  const bend = (distance: number) => {
    const a = sampleTrack(track, distance);
    return Math.max(...[10, 20, 30, 40, 50, 60].map((ahead) => {
      const b = sampleTrack(track, distance + ahead);
      return Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz));
    }));
  };
  const tangent = track.samples.reduce((best, point) => {
    return bend(point.distance) < bend(best.distance) ? point : best;
  });
  const kart = state.karts[0]!;
  Object.assign(kart, { x: tangent.x, z: tangent.z, trackDistance: tangent.distance,
    lateralOffset: 0, heading: Math.atan2(tangent.tx, tangent.tz), speed: 20 });
  return { state, kart };
}

describe('applySteerAssist', () => {
  it.each([-0.25, 0.25])('corrects a straight-road heading error of %s toward the tangent', (error) => {
    const { state, kart } = straight();
    kart.heading += error;
    expect(applySteerAssist(state, kart, input, 1).steer * error).toBeLessThan(0);
  });

  it.each([-1, 1])('steers inward at wall side %s', (side) => {
    const { state, kart } = straight();
    kart.lateralOffset = side * (getTrack(state.trackId).def.roadHalfWidth - 0.5);
    expect(applySteerAssist(state, kart, input, 1).steer * side).toBeLessThan(0);
  });

  it('does not pull toward the centre outside the wall margin', () => {
    const { state, kart } = straight();
    const centered = applySteerAssist(state, kart, input, 1);
    const margin = getTrack(state.trackId).def.roadHalfWidth - 2;
    for (const offset of [-margin, -2, 2, margin]) {
      kart.lateralOffset = offset;
      expect(applySteerAssist(state, kart, input, 1)).toEqual(centered);
    }
  });

  it.each([-0.2, -0.15, 0.15, 0.2])('held steer %s reaches the road edge without reversing the input', (steer) => {
    const { state, kart } = straight();
    const roadHalfWidth = getTrack(state.trackId).def.roadHalfWidth;
    const side = Math.sign(steer);
    for (let tick = 0; tick < 180 && kart.lateralOffset * side < roadHalfWidth - 1; tick++) {
      const frame = applySteerAssist(state, kart, { ...input, steer }, 1);
      expect(frame.steer * side).toBeGreaterThanOrEqual(0);
      stepRace(state, [frame]);
    }
    expect(kart.lateralOffset * side).toBeGreaterThanOrEqual(roadHalfWidth - 1);
    expect(Math.abs(kart.lateralOffset)).toBeLessThan(roadHalfWidth);
  });

  it.each([-1, 1])('never reverses deliberate input of 0.05 or more toward side %s, even near the wall', (side) => {
    const { state, kart } = straight();
    kart.heading += side * 0.7;
    for (const offset of [0, side * (getTrack(state.trackId).def.roadHalfWidth - 0.5)]) {
      kart.lateralOffset = offset;
      for (const magnitude of [0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.8, 1]) {
        const steer = side * magnitude;
        const result = applySteerAssist(state, kart, { ...input, steer }, 1).steer;
        expect(result * side).toBeGreaterThanOrEqual(0);
        expect(Math.abs(result - steer)).toBeLessThanOrEqual(magnitude);
      }
    }
  });

  it.each([-1, 1])('fades the opposing cap in continuously around neutral at wall side %s', (side) => {
    const { state, kart } = straight();
    kart.lateralOffset = side * (getTrack(state.trackId).def.roadHalfWidth - 0.5);
    kart.heading += side * 0.3;
    let previous = applySteerAssist(state, kart, input, 1).steer;
    for (let i = 1; i <= 120; i += 1) {
      const steer = side * i * 0.001;
      const result = applySteerAssist(state, kart, { ...input, steer }, 1).steer;
      expect(Math.abs(result - previous)).toBeLessThan(0.02);
      previous = result;
    }
  });

  it('bounds correction and smoothly halves it again by strong input of 0.8', () => {
    const { state, kart } = straight();
    kart.heading += 0.7;
    const correction = (steer: number, strength = 1) =>
      Math.abs(applySteerAssist(state, kart, { ...input, steer }, strength).steer - steer);
    expect(correction(0)).toBeGreaterThan(0);
    expect(correction(0)).toBeLessThanOrEqual(0.35);
    expect(correction(0.5)).toBeLessThan(correction(0));
    for (const steer of [0.8, 0.9, 1]) {
      expect(correction(steer)).toBeCloseTo(correction(0) * (1 - 0.65 * steer) / 2);
    }
    for (const boundary of [0.6, 0.8]) {
      expect(Math.abs(correction(boundary - 0.000001) - correction(boundary + 0.000001))).toBeLessThan(0.00001);
    }
    expect(correction(1)).toBeLessThanOrEqual(0.175);
    expect(correction(0, 0.5)).toBeCloseTo(correction(0) / 2);
    expect(correction(0, 10)).toBe(correction(0));
  });

  it.each([0, -0.1, 0.1, -0.2, 0.2])('leaves drift initiation entirely to player steer %s', (steer) => {
    const { state, kart } = straight();
    kart.heading += 0.7;
    const frame = { ...input, steer, drift: true };
    expect(applySteerAssist(state, kart, frame, 1)).toBe(frame);
    stepRace(state, [applySteerAssist(state, kart, frame, 1)]);
    expect(kart.driftDirection).toBe(Math.abs(steer) > 0.12 ? Math.sign(steer) : 0);
  });

  it('does not pick a drift direction while the button remains held after hopping', () => {
    const { state, kart } = straight();
    kart.heading += 0.7;
    for (let tick = 0; tick < 120; tick++) {
      const frame = { ...input, drift: true };
      expect(applySteerAssist(state, kart, frame, 1)).toBe(frame);
      stepRace(state, [frame]);
      expect(kart.driftDirection).toBe(0);
    }
    expect(kart.hopTime).toBe(0);
  });

  it('weakens established drifts while held and on release', () => {
    const { state, kart } = straight();
    kart.heading += 0.3;
    const normal = Math.abs(applySteerAssist(state, kart, input, 1).steer);
    kart.driftDirection = 1;
    for (const drift of [true, false]) {
      expect(Math.abs(applySteerAssist(state, kart, { ...input, drift }, 1).steer)).toBeCloseTo(normal * 0.35);
    }
  });

  it.each([{ wrongWay: true }, { spinTime: 1 }, { airTime: 1 }, { hopTime: 0.2 },
    { human: false }, { speed: -1 }])('leaves excluded kart state %j untouched', (patch) => {
    const { state, kart } = straight();
    Object.assign(kart, patch);
    expect(applySteerAssist(state, kart, input, 1)).toBe(input);
  });

  it('does not correct a backward heading before wrongWay is updated', () => {
    const { state, kart } = straight();
    kart.heading += Math.PI;
    expect(applySteerAssist(state, kart, input, 1)).toBe(input);
  });

  it('is deterministic, preserves non-steering input and never mutates its arguments', () => {
    const { state, kart } = straight();
    const frame = Object.freeze({ ...input, brake: true, useItem: true });
    const before = JSON.stringify(state);
    const result = applySteerAssist(state, kart, frame, 1);
    expect(result).toEqual(applySteerAssist(state, kart, frame, 1));
    expect({ ...result, steer: frame.steer }).toEqual(frame);
    expect(JSON.stringify(state)).toBe(before);
    for (const strength of [0, -1, NaN, Infinity]) expect(applySteerAssist(state, kart, frame, strength)).toBe(frame);
  });

  it.each(TRACK_IDS)('%s: at least halves wall hits over one full lap with throttle alone and no CPU', (trackId) => {
    const drive = (assisted: boolean) => {
      const state = solo(trackId);
      const kart = state.karts[0]!;
      let hits = 0;
      let speedSum = 0;
      while (kart.lap < 1 && state.tick < 60 * 600) {
        stepRace(state, [assisted ? applySteerAssist(state, kart, input, 1) : input]);
        hits += state.events.filter((event) => event.type === 'hit').length;
        speedSum += kart.speed;
      }
      return { hits, lap: kart.lap, seconds: state.time, averageSpeed: speedSum / state.tick };
    };
    const off = drive(false);
    const on = drive(true);
    expect(off.lap, JSON.stringify({ trackId, off, on })).toBe(1);
    expect(on.lap, JSON.stringify({ trackId, off, on })).toBe(1);
    expect(off.hits).toBeGreaterThan(0);
    expect(on.hits, JSON.stringify({ trackId, off, on })).toBeLessThanOrEqual(off.hits / 2);
    expect(on.seconds, JSON.stringify({ trackId, off, on })).toBeLessThan(off.seconds);
    expect(on.averageSpeed, JSON.stringify({ trackId, off, on })).toBeGreaterThan(off.averageSpeed);
  });
});

// Controls integration lives here because Controls.test.ts is outside H4's file lock.
describe('Controls steer assist', () => {
  let controls: Controls | undefined;
  afterEach(() => { controls?.dispose(); vi.unstubAllGlobals(); });

  function setup(touch: boolean) {
    const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: touch }) });
    const root = Object.assign(new EventTarget(), {
      querySelector: () => null,
      classList: { toggle: () => undefined },
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    controls = new Controls(root as unknown as HTMLElement);
    controls.setEnabled(true);
    controls.setAutoAccelerate(true);
    return { controls, win, root };
  }

  it.each([true, false])('defaults to touch=%s and applies the actual ON/OFF setting in sample', (touch) => {
    const { controls } = setup(touch);
    const { state, kart } = straight();
    kart.heading += 0.25;
    expect(controls.steerAssist).toBe(touch);
    controls.setSteerAssist(false);
    const off = controls.sample(state, kart.id);
    expect(off.steer).toBe(0);
    controls.setSteerAssist(true);
    expect(controls.sample(state, kart.id)).toEqual(applySteerAssist(state, kart, off, 1));
    expect(controls.sample(state, kart.id).steer).toBeLessThan(0);
    controls.setEnabled(false);
    expect(controls.sample(state, kart.id).steer).toBe(0);
  });

  it('defaults to OFF for an active gamepad and keeps explicit preferences', () => {
    const { controls } = setup(true);
    const { state, kart } = straight();
    vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true, axes: [0.5], buttons: [] }] });
    controls.sample(state, kart.id);
    expect(controls.steerAssist).toBe(false);
    controls.setSteerAssist(true);
    controls.sample(state, kart.id);
    expect(controls.steerAssist).toBe(true);
  });

  it('preserves the first gamepad item press when switching from touch', () => {
    const { controls } = setup(true);
    const { state, kart } = straight();
    const buttons = Array.from({ length: 6 }, (_, index) => ({ pressed: index === 5, value: index === 5 ? 1 : 0 }));
    vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true, axes: [0], buttons }] });
    expect(controls.sample(state, kart.id).useItem).toBe(true);
    expect(controls.steerAssist).toBe(false);
    controls.reset();
    expect(controls.sample(state, kart.id).useItem).toBe(false);
  });

  it('follows late touch/keyboard detection until the player chooses a preference', () => {
    const { controls, root, win } = setup(false);
    const touch = () => root.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType: 'touch' }));
    const keyboard = () => win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW' }));
    touch();
    expect(controls.steerAssist).toBe(true);
    keyboard();
    expect(controls.steerAssist).toBe(false);
    controls.setSteerAssist(false);
    touch();
    expect(controls.steerAssist).toBe(false);
  });
});
