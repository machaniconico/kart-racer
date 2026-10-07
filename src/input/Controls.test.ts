import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controls, touchSteerCurve } from './Controls';
import { createRace, stepRace, type InputFrame } from '../sim/index';

// Lightweight fake DOM: just enough surface for Controls (no happy-dom/jsdom dependency).
class FakeElement extends EventTarget {
  readonly classes = new Set<string>();
  readonly style: Record<string, string> = {};
  readonly children = new Map<string, FakeElement>();
  rect = { left: 0, top: 0, width: 200, height: 200 };
  readonly classList = {
    add: (name: string) => void this.classes.add(name),
    remove: (name: string) => void this.classes.delete(name),
    toggle: (name: string, force?: boolean) => {
      if (force ?? !this.classes.has(name)) this.classes.add(name);
      else this.classes.delete(name);
    },
  };
  setAttribute(): void {}
  matches(): boolean { return false; }
  hasPointerCapture(): boolean { return false; }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getBoundingClientRect() { return this.rect; }
  querySelector(selector: string): FakeElement | null { return this.children.get(selector) ?? null; }
}

const IDS = ['steering-pad', 'steering-knob', 'auto-accelerate', 'accelerate', 'brake', 'drift', 'use-item'];

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, props);
  target.dispatchEvent(event);
}

const neutral: InputFrame = { steer: 0, throttle: 0, brake: false, drift: false, useItem: false };

let win: EventTarget;
let root: FakeElement;
let controls: Controls;
let gamepads: unknown[] = [];

beforeEach(() => {
  win = new EventTarget();
  root = new FakeElement();
  for (const id of IDS) root.children.set(`#${id}`, new FakeElement());
  gamepads = [];
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('navigator', { getGamepads: () => gamepads });
  controls = new Controls(root as unknown as HTMLElement);
  controls.setEnabled(true);
  controls.setAutoAccelerate(true); // keep the kart moving so steering is observable
});

afterEach(() => {
  controls.dispose();
  vi.unstubAllGlobals();
});

/** Lateral displacement on screen (camera right) after driving with the frames Controls.sample() produces. */
function screenRightFromControls(): number {
  const state = createRace(1);
  const me = state.karts.find((kart) => kart.human)!;
  const framesFor = (frame: InputFrame | null) =>
    state.karts.map((kart) => (kart.id === me.id && frame ? frame : { ...neutral }));
  while (state.phase !== 'racing') stepRace(state, framesFor(null));
  for (let i = 0; i < 60; i++) stepRace(state, framesFor({ ...neutral, throttle: 1 }));
  const { heading, x, z } = me;
  for (let i = 0; i < 40; i++) stepRace(state, framesFor(controls.sample(state, me.id)));
  return (me.x - x) * -Math.cos(heading) + (me.z - z) * Math.sin(heading);
}

const RIGHT = 0.5;
const LEFT = -0.5;

describe('Controls steering direction (input -> sample -> sim)', () => {
  it.each([['ArrowRight'], ['KeyD']])('keyboard %s turns right on screen', (code) => {
    fire(win, 'keydown', { code: 'ArrowUp' }); // a key press turns auto-accelerate off
    fire(win, 'keydown', { code });
    expect(screenRightFromControls()).toBeGreaterThan(RIGHT);
  });

  it.each([['ArrowLeft'], ['KeyA']])('keyboard %s turns left on screen', (code) => {
    fire(win, 'keydown', { code: 'ArrowUp' }); // a key press turns auto-accelerate off
    fire(win, 'keydown', { code });
    expect(screenRightFromControls()).toBeLessThan(LEFT);
  });

  function touch(clientX: number): void {
    const pad = root.children.get('#steering-pad')!;
    const props = { pointerId: 1, pointerType: 'touch', button: 0, clientX, clientY: 100 };
    fire(pad, 'pointerdown', props);
    fire(pad, 'pointermove', props);
  }

  it('touch pad right of centre turns right on screen', () => {
    touch(190);
    expect(screenRightFromControls()).toBeGreaterThan(RIGHT);
  });

  it('touch pad left of centre turns left on screen', () => {
    touch(10);
    expect(screenRightFromControls()).toBeLessThan(LEFT);
  });

  function pad(axis: number, dpad?: 14 | 15): unknown {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    if (dpad !== undefined) buttons[dpad] = { pressed: true, value: 1 };
    return { connected: true, axes: [axis, 0], buttons };
  }

  it('gamepad stick right / D-pad right turns right on screen', () => {
    gamepads = [pad(1)];
    expect(screenRightFromControls()).toBeGreaterThan(RIGHT);
    gamepads = [pad(0, 15)];
    expect(screenRightFromControls()).toBeGreaterThan(RIGHT);
  });

  it('gamepad stick left / D-pad left turns left on screen', () => {
    gamepads = [pad(-1)];
    expect(screenRightFromControls()).toBeLessThan(LEFT);
    gamepads = [pad(0, 14)];
    expect(screenRightFromControls()).toBeLessThan(LEFT);
  });
});

describe('touch steering sensitivity curve', () => {
  const levels = [1, 2, 3, 4, 5];

  it.each(levels)('level %i is monotone, odd, and reaches +-1 at the edges', (level) => {
    let prev = -Infinity;
    for (let raw = -1; raw <= 1.0001; raw += 0.01) {
      const out = touchSteerCurve(raw, level);
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
    expect(touchSteerCurve(1, level)).toBeCloseTo(1, 10);
    expect(touchSteerCurve(-1, level)).toBeCloseTo(-1, 10);
    expect(touchSteerCurve(0.03, level)).toBe(0);
    expect(touchSteerCurve(-0.5, level)).toBe(-touchSteerCurve(0.5, level));
  });

  it('returns 0 for NaN input and the default curve for NaN level', () => {
    expect(touchSteerCurve(NaN, 3)).toBe(0);
    expect(touchSteerCurve(0.5, NaN)).toBe(touchSteerCurve(0.5, 3));
  });

  it('ignores key presses aimed at a form control but still switches to keyboard mode otherwise', () => {
    (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
    const touchControls = new Controls(root as unknown as HTMLElement);
    expect(touchControls.isTouch).toBe(true);
    const keyAt = (code: string, tagName: string): void => {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperty(event, 'code', { value: code });
      Object.defineProperty(event, 'target', { value: { tagName } });
      win.dispatchEvent(event);
    };
    keyAt('ArrowRight', 'INPUT');
    keyAt('Tab', 'BUTTON');
    expect(touchControls.isTouch).toBe(true);
    keyAt('ArrowRight', 'DIV');
    expect(touchControls.isTouch).toBe(false);
    touchControls.dispose();
  });

  it('is continuous at the dead-zone edge', () => {
    for (const level of levels) expect(touchSteerCurve(0.0401, level)).toBeLessThan(0.001);
  });

  it('is below linear near the centre except at the linear level, and gentler at lower levels', () => {
    const linear = (0.3 - 0.04) / 0.96;
    expect(touchSteerCurve(0.3, 5)).toBeCloseTo(linear, 10);
    for (const level of [1, 2, 3, 4]) expect(touchSteerCurve(0.3, level)).toBeLessThan(linear);
    for (let level = 1; level < 5; level++) expect(touchSteerCurve(0.3, level)).toBeLessThan(touchSteerCurve(0.3, level + 1));
  });

  it('applies the setting to the sampled touch steer (sim sign flip aside)', () => {
    const state = createRace(1);
    while (state.phase !== 'racing') stepRace(state, state.karts.map(() => ({ ...neutral })));
    const pad = root.children.get('#steering-pad')!;
    const props = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 130, clientY: 100 };
    fire(pad, 'pointerdown', props);
    const at = (level: number): number => {
      controls.setSteerSensitivity(level);
      fire(pad, 'pointermove', props);
      return Math.abs(controls.sample(state, 0).steer);
    };
    const gentle = at(1);
    const sharp = at(5);
    expect(gentle).toBeGreaterThan(0);
    expect(gentle).toBeLessThan(sharp);
  });
});
