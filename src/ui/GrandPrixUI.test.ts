import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUPS, createGrandPrix, GP_POINTS, standings } from '../gp/grandPrix';
import type { CupId, GrandPrix } from '../gp/grandPrix';
import { TRACKS } from '../sim/tracks';
import { GrandPrixUI } from './GrandPrixUI';

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
      .toEqual(['+10', '+1', '+8', '+2', '+6', '+5', '+4', '+3']);
    standings(gp).forEach((standing, index) => {
      const row = rows[index];
      expect(row.tagName).toBe('li');
      expect(row.children).toHaveLength(5);
      expect(Number(row.querySelector('.standings-position').textContent)).toBe(index + 1);
      expect(row.querySelector('.standings-name').textContent).toBe(standing.name);
      expect(row.querySelector('.standings-points').textContent).toBe(String(standing.points));
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
      expect(root.querySelector('#gp-progress').textContent).toBe(`RACE ${races} / 4`);
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
    expect(root.querySelectorAll('.standings-gained').map(node => node.textContent)).toEqual(Array(8).fill('+0'));
    const player = root.querySelector('.is-player');
    expect(player.querySelector('.standings-name').textContent).toBe(gp.karts[3].name);
    expect(player.querySelector('.standings-name').children).toHaveLength(0);
    expect(player.querySelector('.racer-swatch').style.backgroundColor).toBe('#000123');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.querySelector('#gp-progress').textContent).toBe('RACE 1 / 4');
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
