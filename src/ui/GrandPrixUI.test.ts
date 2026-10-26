import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUPS, createGrandPrix, GP_POINTS, standings } from '../gp/grandPrix';
import type { CupId, GrandPrix } from '../gp/grandPrix';
import { TRACKS } from '../sim/tracks';
import { GrandPrixUI, POINTS_COUNT_UP_MS, STANDINGS_ROW_STAGGER_MS, countUpValue } from './GrandPrixUI';

// Like LobbyUI.test.ts, these tests use element doubles in the repository's
// Node environment. Actual sizing and scrolling need browser layout tests.
class ElementDouble extends EventTarget {
  id = '';
  className = '';
  hidden = false;
  title = '';
  type = '';
  style = { backgroundColor: '' };
  dataset: Record<string, string> = {};
  children: ElementDouble[] = [];
  parent: ElementDouble | null = null;
  private text = '';
  private attributes = new Map<string, string>();

  constructor(readonly tagName: string) { super(); }

  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  append(...nodes: ElementDouble[]): void {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: ElementDouble[]): void {
    for (const child of [...this.children]) child.remove();
    this.text = '';
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  click(): void { this.dispatchEvent(new Event('click')); }
  querySelectorAll(selector: string): ElementDouble[] {
    const matches = (node: ElementDouble) => selector.startsWith('#') ? node.id === selector.slice(1)
      : selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
      : node.tagName === selector;
    return this.children.flatMap(child => [
      ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): ElementDouble {
    const node = this.querySelectorAll(selector)[0];
    if (!node) throw new Error(`Missing test element: ${selector}`);
    return node;
  }
}

function harness() {
  vi.stubGlobal('document', { createElement: (tag: string) => new ElementDouble(tag) });
  const root = new ElementDouble('main');
  const onNext = vi.fn();
  const ui = new GrandPrixUI(root as unknown as HTMLElement, { onNext });
  return { root, ui, onNext, screen: root.querySelector('#standings-screen') };
}

function grandPrix(races = 2, cupId: CupId = 'sunrise'): GrandPrix {
  const gp = createGrandPrix(cupId, 3, 'normal');
  const cup = CUPS.find(cup => cup.id === cupId)!;
  const orders = [[0, 1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1, 0]];
  gp.results = cup.tracks.slice(0, races).map((trackId, index) => {
    const order = orders[index % 2];
    return { trackId, order, points: gp.karts.map(kart => GP_POINTS[order.indexOf(kart.id)]) };
  });
  gp.raceIndex = races;
  return gp;
}

afterEach(() => vi.unstubAllGlobals());

describe('GrandPrixUI', () => {
  it('keeps EXTREME CUP open after race four and finishes after aqueduct', () => {
    const { root, ui } = harness();
    ui.render(grandPrix(4, 'extreme'), 0);
    expect(root.querySelector('#gp-progress').textContent).toBe('RACE 4 / 5');
    expect(root.querySelector('#gp-next-course').textContent).toBe('NEXT · AQUEDUCT');
    expect(root.querySelector('#gp-next').textContent).toBe('次のレースへ');
    expect(root.querySelectorAll('.podium')).toHaveLength(0);
    ui.render(grandPrix(5, 'extreme'), 0);
    expect(root.querySelector('#gp-progress').textContent).toBe('FINAL RESULT');
    expect(root.querySelector('#gp-next').textContent).toBe('タイトルへ');
    expect(root.querySelectorAll('.podium')).toHaveLength(1);
  });

  it('mounts a hidden, labelled section and toggles only its own screen', () => {
    const { root, screen, ui } = harness();
    const sibling = new ElementDouble('section');
    root.append(sibling);
    expect(root.children).toHaveLength(2);
    expect(screen.tagName).toBe('section');
    expect(screen.className).toBe('screen');
    expect(screen.hidden).toBe(true);
    expect(screen.getAttribute('aria-labelledby')).toBe('gp-cup');
    ui.render(grandPrix(), 0);
    expect(screen.hidden).toBe(true);
    ui.show();
    expect(screen.hidden).toBe(false);
    ui.render(grandPrix(4), 0);
    expect(screen.hidden).toBe(false);
    ui.hide();
    expect(screen.hidden).toBe(true);
    expect(sibling.hidden).toBe(false);
  });

  it('renders eight rows in standings order, including tied totals and latest gains', () => {
    const { root, ui } = harness();
    const gp = grandPrix();
    const before = structuredClone(gp);
    ui.render(gp, 6);
    const rows = root.querySelectorAll('.standings-row');
    expect(rows).toHaveLength(8);
    expect(rows.map(row => Number(row.dataset.kartId))).toEqual([7, 0, 6, 1, 5, 4, 3, 2]);
    expect(rows.map(row => row.querySelector('.standings-gained').textContent))
      .toEqual([10, 1, 8, 2, 6, 5, 4, 3].map(n => `+${n} 今回 ${n} ポイント獲得`));
    standings(gp).forEach((standing, index) => {
      const row = rows[index];
      expect(row.tagName).toBe('li');
      expect(row.children).toHaveLength(5);
      expect(Number(row.querySelector('.standings-position').textContent)).toBe(index + 1);
      expect(row.querySelector('.standings-name').textContent).toBe(standing.name);
      expect(row.querySelector('.standings-points').textContent).toBe(`${standing.points} 合計 ${standing.points} ポイント`);
      expect(row.querySelector('.standings-points').getAttribute('aria-label')).toBeNull();
      expect(row.querySelector('.standings-gained').getAttribute('aria-label')).toBeNull();
      expect(row.querySelector('.racer-swatch').style.backgroundColor)
        .toBe(`#${standing.color.toString(16).padStart(6, '0')}`);
    });
    expect(gp).toEqual(before);
  });

  it('marks only the local kart and moves the YOU badge on rerender', () => {
    const { root, ui } = harness();
    const gp = grandPrix();
    for (const id of [6, 2]) {
      ui.render(gp, id);
      const players = root.querySelectorAll('.is-player');
      expect(players).toHaveLength(1);
      expect(players[0].dataset.kartId).toBe(String(id));
      expect(players[0].querySelector('.standings-you').textContent).toBe('YOU');
      expect(root.querySelectorAll('.standings-you')).toHaveLength(1);
      expect(root.querySelectorAll('.standings-row')).toHaveLength(8);
    }
  });

  it.each(CUPS)('shows the $name, finished race number, and next course between races', cup => {
    const { root, ui } = harness();
    for (const races of [1, 2, 3]) {
      ui.render(grandPrix(races, cup.id), 0);
      expect(root.querySelector('#gp-cup').textContent).toBe(cup.name);
      expect(root.querySelector('#gp-progress').textContent).toBe(`RACE ${races} / ${cup.tracks.length}`);
      expect(root.querySelector('#gp-next-course').textContent).toContain(TRACKS[cup.tracks[races]].name);
      expect(root.querySelector('#gp-next-course').hidden).toBe(false);
      expect(root.querySelector('#gp-next').textContent).toBe('次のレースへ');
      expect(root.querySelectorAll('.podium')).toHaveLength(0);
    }
  });

  it('shows the final top three from standings and removes the podium when reused', () => {
    const { root, ui } = harness();
    const gp = grandPrix(4);
    ui.render(gp, 6);
    expect(root.querySelector('#gp-progress').textContent).toBe('FINAL RESULT');
    expect(root.querySelector('#gp-next-course').hidden).toBe(true);
    expect(root.querySelector('#gp-next-course').textContent).toBe('');
    expect(root.querySelector('#gp-next').textContent).toBe('タイトルへ');
    const podium = root.querySelector('.podium');
    expect(podium.children).toHaveLength(3);
    standings(gp).slice(0, 3).forEach((standing, index) => {
      const place = podium.children[index];
      expect(place.dataset.kartId).toBe(String(standing.kartId));
      expect(place.querySelector('.podium-position').textContent).toBe(`${index + 1} 位`);
      expect(place.querySelector('.podium-name').textContent).toBe(standing.name);
      expect(place.querySelector('.podium-points').textContent).toBe(`${standing.points} pt`);
      expect(place.querySelector('.racer-swatch').style.backgroundColor)
        .toBe(`#${standing.color.toString(16).padStart(6, '0')}`);
    });
    expect(root.querySelectorAll('.standings-row')).toHaveLength(8);
    ui.render(gp, 6);
    expect(root.querySelectorAll('.podium')).toHaveLength(1);
    ui.render(grandPrix(1), 6);
    expect(root.querySelectorAll('.podium')).toHaveLength(0);
    expect(root.querySelector('#gp-next').textContent).toBe('次のレースへ');
    expect(root.querySelector('#gp-next-course').hidden).toBe(false);
  });

  it('uses isComplete rather than the race counter to select the final state', () => {
    const { root, ui } = harness();
    ui.render({ ...grandPrix(4), raceIndex: 0 }, 0);
    expect(root.querySelectorAll('.podium')).toHaveLength(1);
    expect(root.querySelector('#gp-next').textContent).toBe('タイトルへ');
  });

  it('calls onNext once per click in either state after repeated renders', () => {
    const { root, ui, onNext } = harness();
    const button = root.querySelector('#gp-next');
    expect(button.type).toBe('button');
    ui.render(grandPrix(1), 0);
    ui.render(grandPrix(2), 0);
    ui.show();
    button.click();
    expect(onNext).toHaveBeenCalledTimes(1);
    ui.render(grandPrix(4), 0);
    button.click();
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it('removes its screen and click listener on destroy without removing siblings', () => {
    const { root, ui, onNext } = harness();
    const sibling = new ElementDouble('section');
    root.append(sibling);
    const button = root.querySelector('#gp-next');
    ui.render(grandPrix(), 0);
    ui.destroy();
    ui.destroy();
    expect(root.querySelectorAll('#standings-screen')).toHaveLength(0);
    expect(root.children).toEqual([sibling]);
    button.click();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('supports an initial zero-point grid and keeps names as text', () => {
    const { root, ui } = harness();
    const gp = grandPrix(0);
    gp.karts[3].name = '<img src=x onerror=alert(1)>';
    gp.karts[3].color = 0x123;
    ui.render(gp, 3);
    expect(root.querySelectorAll('.standings-gained').map(node => node.textContent)).toEqual(Array(8).fill('+0 今回 0 ポイント獲得'));
    const player = root.querySelector('.is-player');
    expect(player.querySelector('.standings-name').textContent).toBe(gp.karts[3].name);
    expect(player.querySelector('.standings-name').children).toHaveLength(0);
    expect(player.querySelector('.racer-swatch').style.backgroundColor).toBe('#000123');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.querySelector('#gp-progress').textContent).toBe('RACE 1 / 4');
  });
});

describe('GrandPrixUI entrance', () => {
  const media = (matches: boolean) => {
    const m = { matches, handlers: [] as (() => void)[], addEventListener: (_: string, h: () => void) => m.handlers.push(h), removeEventListener: () => undefined };
    return m;
  };

  it('counts points up over 600 ms in an aria-hidden overlay and keeps the real text final', () => {
    const frames: ((t: number) => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('matchMedia', () => media(false));
    const { ui, root } = harness();
    ui.render(grandPrix(2), 0);
    ui.show();
    const lives = root.querySelectorAll('.standings-points-live');
    const finals = standings(grandPrix(2));
    const starts = finals.map(row => row.points - row.gained);
    expect(lives.map(node => node.textContent)).toEqual(starts.map(String));
    expect(lives.every(node => node.getAttribute('aria-hidden') === 'true' && !node.hidden)).toBe(true);
    const strongs = root.querySelectorAll('.standings-points');
    expect(strongs.every(node => node.className.includes('is-counting'))).toBe(true);
    frames.shift()!(1000);
    frames.shift()!(1000 + POINTS_COUNT_UP_MS / 2);
    expect(Number(lives[0].textContent)).toBeGreaterThan(starts[0]);
    expect(strongs[0].textContent).toBe(`${finals[0].points} 合計 ${finals[0].points} ポイント`);
    frames.shift()!(1000 + POINTS_COUNT_UP_MS);
    expect(strongs.some(node => node.className.includes('is-counting'))).toBe(false);
    expect(lives.every(node => node.hidden)).toBe(true);
    expect(POINTS_COUNT_UP_MS).toBe(600);
  });

  it('skips the count-up and stagger under reduced motion', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('matchMedia', () => media(true));
    const { ui, root } = harness();
    ui.render(grandPrix(2), 0);
    ui.show();
    expect(raf).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.standings-points').some(node => node.className.includes('is-counting'))).toBe(false);
  });

  it('stops the count-up and cancels row animations when reduced motion turns on mid-run', () => {
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', () => 7);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const m = media(false);
    vi.stubGlobal('matchMedia', () => m);
    const { ui, root } = harness();
    ui.render(grandPrix(2), 0);
    const cancel = vi.fn();
    root.querySelectorAll('.standings-row').forEach(row => Object.assign(row, { animate: () => ({ cancel }) }));
    ui.show();
    expect(root.querySelectorAll('.standings-points').every(node => node.className.includes('is-counting'))).toBe(true);
    m.matches = true;
    m.handlers.forEach(handler => handler());
    expect(cancel).toHaveBeenCalledTimes(8);
    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(root.querySelectorAll('.standings-points').some(node => node.className.includes('is-counting'))).toBe(false);
    expect(root.querySelectorAll('.standings-points-live').every(node => node.hidden)).toBe(true);
  });

  it('staggers rows by 70 ms and eases the count-up to its target', () => {
    vi.stubGlobal('matchMedia', () => media(false));
    const { ui, root } = harness();
    ui.render(grandPrix(2), 0);
    const calls: number[] = [];
    root.querySelectorAll('.standings-row').forEach(row => {
      Object.assign(row, { animate: (_k: unknown, o: { delay: number }) => { calls.push(o.delay); } });
    });
    ui.show();
    expect(calls.slice(0, 3)).toEqual([0, STANDINGS_ROW_STAGGER_MS, 2 * STANDINGS_ROW_STAGGER_MS]);
    expect([countUpValue(0, 10, 0), countUpValue(0, 10, 600), countUpValue(0, 10, 9999)]).toEqual([0, 10, 10]);
  });
});

describe('Grand Prix stylesheet contracts', () => {
  const css = readFileSync(new URL('./gp.css', import.meta.url), 'utf8');

  it('declares a 47px action and a vertically scrollable, touch-pannable content area', () => {
    const content = css.match(/\.standings-content\s*\{([^}]+)\}/)![1];
    expect(content).toMatch(/max-height:\s*100%/);
    expect(content).toMatch(/overflow-y:\s*auto/);
    expect(content).toMatch(/touch-action:\s*pan-y/);
    expect(css.match(/#gp-next\s*\{([^}]+)\}/)![1]).toMatch(/min-height:\s*47px/);
  });

  it('keeps five columns on one line with a shrinkable, truncated name', () => {
    const row = css.match(/\.standings-row\s*\{([^}]+)\}/)![1];
    expect(row).toMatch(/grid-template-columns:\s*24px 12px 1fr auto auto/);
    expect(row).toMatch(/white-space:\s*nowrap/);
    const name = css.match(/\.standings-name\s*\{([^}]+)\}/)![1];
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/overflow:\s*hidden/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
  });
});
