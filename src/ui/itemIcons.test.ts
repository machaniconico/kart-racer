import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemIcon, itemIcons, itemName, itemNames, itemShortName, itemShortNames, emptyItemIcon } from './itemIcons';
import { createInkOverlay, disposeInkOverlay, update } from './inkOverlay';
import { playItemEvent } from '../audio/itemSounds';
import type { ItemType, RaceEvent } from '../sim/types';

const items: ItemType[] = ['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash', 'rapidDash',
  'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'];

describe('item artwork shared by the HUD and touch button', () => {
  it('covers all 14 items with distinct 24px SVG artwork and Japanese labels', () => {
    expect(Object.keys(itemIcons)).toHaveLength(14);
    expect(Object.keys(itemNames)).toHaveLength(14);
    expect(Object.keys(itemShortNames)).toHaveLength(14);
    expect(new Set(items.map(itemIcon)).size).toBe(14);
    for (const item of items) {
      const svg = itemIcon(item);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toMatch(/^<svg .*<\/svg>$/);
      expect(svg).not.toBe(emptyItemIcon);
      expect(svg).not.toMatch(/<script|<image|href=|on\w+=/);
      expect(itemName(item)).toMatch(/[ァ-ヶ]/);
      expect(itemShortName(item)).toMatch(/[ァ-ヶ]/);
      expect(itemShortName(item).length).toBeLessThanOrEqual(5);
    }
  });
});

describe('ink overlay lifecycle', () => {
  afterEach(disposeInkOverlay);

  function mount() {
    const element = { id: '', hidden: false, style: { opacity: '' }, setAttribute: vi.fn(), remove: vi.fn() };
    const parent = { ownerDocument: { createElement: vi.fn(() => element) }, append: vi.fn() };
    createInkOverlay(parent as unknown as HTMLElement);
    expect(parent.append).toHaveBeenCalledWith(element);
    expect(element.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
    return element;
  }

  it('fades from simulation time and disappears exactly when four seconds elapse', () => {
    const element = mount();
    expect(element.hidden).toBe(true);
    for (const [time, opacity] of [[4, 0.9], [3, 0.675], [2, 0.45], [1, 0.225], [0, 0]]) {
      update(time);
      expect(Number(element.style.opacity)).toBeCloseTo(opacity);
      expect(element.hidden).toBe(time === 0);
    }
    update(4);
    expect(element.hidden).toBe(false);
    expect(element.style.opacity).toBe('0.9');
  });

  it('clamps invalid timers and removes the old layer on remount/disposal', () => {
    const first = mount();
    update(20);
    expect(first.style.opacity).toBe('0.9');
    for (const time of [-1, NaN, Infinity]) {
      update(time);
      expect(first.hidden).toBe(true);
      expect(first.style.opacity).toBe('0');
    }
    const second = mount();
    expect(first.remove).toHaveBeenCalledOnce();
    disposeInkOverlay();
    expect(second.remove).toHaveBeenCalledOnce();
    expect(() => update(4)).not.toThrow();
  });
});

describe('item sound recipes', () => {
  const events: RaceEvent['type'][] = ['block', 'explode', 'storm', 'ink', 'aura_start', 'auto_start'];

  it('schedules six distinct bounded recipes through the engine-owned voices', () => {
    const recipes = new Set<string>();
    for (const type of events) {
      const kit = { tone: vi.fn(), noise: vi.fn() };
      playItemEvent(kit, { type, kartId: 0 }, 10);
      expect(kit.tone.mock.calls.length + kit.noise.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [frequency, start, duration, volume, , endFrequency] of kit.tone.mock.calls) {
        expect(frequency).toBeGreaterThan(0);
        expect(start).toBeGreaterThanOrEqual(10);
        expect(start + duration).toBeLessThan(11);
        expect(volume).toBeGreaterThan(0);
        expect(volume).toBeLessThanOrEqual(0.3);
        if (endFrequency !== undefined) expect(endFrequency).toBeGreaterThan(0);
      }
      for (const [start, duration, volume, frequency] of kit.noise.mock.calls) {
        expect(start).toBeGreaterThanOrEqual(10);
        expect(start + duration).toBeLessThan(11);
        expect(volume).toBeGreaterThan(0);
        expect(volume).toBeLessThanOrEqual(0.3);
        expect(frequency).toBeGreaterThan(0);
      }
      recipes.add(JSON.stringify([kit.tone.mock.calls, kit.noise.mock.calls]));
    }
    expect(recipes.size).toBe(6);
  });

  it('leaves core events to AudioEngine instead of replaying them', () => {
    const kit = { tone: vi.fn(), noise: vi.fn() };
    playItemEvent(kit, { type: 'pickup', kartId: 0 }, 0);
    expect(kit.tone).not.toHaveBeenCalled();
    expect(kit.noise).not.toHaveBeenCalled();
  });
});
