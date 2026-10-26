import { CUPS, isComplete, nextTrack, standings } from '../gp/grandPrix';
import type { GrandPrix, StandingRow } from '../gp/grandPrix';
import { TRACKS } from '../sim/tracks';
import './gp.css';

export interface GrandPrixUICallbacks {
  onNext: () => void;
}

export const POINTS_COUNT_UP_MS = 600;
export const STANDINGS_ROW_STAGGER_MS = 70;

/** Integer shown `elapsed` ms into a count-up from `from` to `to`. */
export function countUpValue(from: number, to: number, elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed / POINTS_COUNT_UP_MS));
  return Math.round(from + (to - from) * (1 - (1 - t) * (1 - t)));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function swatch(color: number): HTMLElement {
  const node = element('i', 'racer-swatch');
  node.style.backgroundColor = `#${color.toString(16).padStart(6, '0')}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** The caller owns race progression and hiding the other game screens. */
export class GrandPrixUI {
  private readonly screen = element('section', 'screen');
  private readonly cup = element('h2', 'standings-cup');
  private readonly progress = element('p', 'standings-progress');
  private readonly nextCourse = element('p', 'standings-next-course');
  private readonly podium = element('div', 'standings-podium');
  private readonly list = element('ol', 'standings-list');
  private readonly next = element('button', 'primary-button', '次のレースへ');
  private readonly onNext: () => void;
  private counters: { node: HTMLElement; text: HTMLElement; from: number; to: number }[] = [];
  private frame = 0;
  private anims: Animation[] = [];
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private readonly onMotionChange = (): void => { if (this.media?.matches) this.stopMotion(); };

  constructor(root: HTMLElement, callbacks: GrandPrixUICallbacks) {
    this.screen.id = 'standings-screen';
    this.screen.hidden = true;
    this.screen.setAttribute('aria-labelledby', 'gp-cup');
    this.cup.id = 'gp-cup';
    this.progress.id = 'gp-progress';
    this.nextCourse.id = 'gp-next-course';
    this.list.setAttribute('aria-label', '総合順位');
    this.next.id = 'gp-next';
    this.next.type = 'button';
    this.onNext = () => callbacks.onNext();
    this.media?.addEventListener?.('change', this.onMotionChange);
    this.next.addEventListener('click', this.onNext);

    const header = element('header', 'standings-heading');
    header.append(this.progress, this.cup, this.nextCourse);
    const content = element('div', 'standings-content');
    content.append(header, this.podium, this.list, this.next);
    this.screen.append(content);
    root.append(this.screen);
  }

  render(gp: GrandPrix, localKartId: number): void {
    this.stopMotion();
    this.counters = [];
    const complete = isComplete(gp);
    const rows = standings(gp);
    const trackId = nextTrack(gp);
    const cup = CUPS.find(cup => cup.id === gp.cupId)!;
    this.cup.textContent = cup.name;
    this.progress.textContent = complete ? 'FINAL RESULT' : `RACE ${Math.max(1, gp.raceIndex)} / ${cup.tracks.length}`;
    this.nextCourse.textContent = trackId === null ? '' : `NEXT · ${TRACKS[trackId].name}`;
    this.nextCourse.hidden = trackId === null;
    this.next.textContent = complete ? 'タイトルへ' : '次のレースへ';

    this.podium.replaceChildren();
    if (complete) {
      const podium = element('ol', 'podium');
      podium.setAttribute('aria-label', '表彰台');
      rows.slice(0, 3).forEach((row, index) => {
        const place = element('li', 'podium-place');
        place.dataset.kartId = String(row.kartId);
        const name = element('span', 'podium-name', row.name);
        name.title = row.name;
        place.append(element('span', 'podium-position', `${index + 1} 位`), swatch(row.color),
          name, element('strong', 'podium-points', `${row.points} pt`));
        podium.append(place);
      });
      this.podium.append(podium);
    }

    this.list.replaceChildren(...rows.map((row, index) => this.standing(row, index, localKartId)));
  }

  show(): void {
    this.screen.hidden = false;
    this.playEntrance();
  }

  hide(): void {
    this.stopMotion();
    this.screen.hidden = true;
  }

  /** 70 ms row stagger and 600 ms points count-up; skipped (final values stay) under reduced motion or without rAF. */
  private playEntrance(): void {
    this.stopCounting();
    if (this.media?.matches) return;
    this.list.querySelectorAll('.standings-row').forEach((row, index) => {
      const anim = row.animate?.([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, delay: index * STANDINGS_ROW_STAGGER_MS, easing: 'ease-out', fill: 'backwards' });
      if (anim) this.anims.push(anim);
    });
    const active = this.counters.filter(counter => counter.from !== counter.to);
    if (active.length === 0 || typeof requestAnimationFrame !== 'function') return;
    // The strong keeps its final text for assistive tech; the running value is an aria-hidden sibling shown over it.
    for (const { node, text, from } of active) { node.className = 'standings-points is-counting'; text.hidden = false; text.textContent = String(from); }
    let start = -1;
    const tick = (now: number): void => {
      if (start < 0) start = now;
      const elapsed = now - start;
      for (const { text, from, to } of active) text.textContent = String(countUpValue(from, to, elapsed));
      if (elapsed < POINTS_COUNT_UP_MS) this.frame = requestAnimationFrame(tick);
      else this.stopCounting();
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopCounting(): void {
    if (this.frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const { node, text } of this.counters) { node.className = 'standings-points'; text.hidden = true; }
  }

  private stopMotion(): void {
    for (const anim of this.anims) anim.cancel();
    this.anims = [];
    this.stopCounting();
  }

  destroy(): void {
    this.media?.removeEventListener?.('change', this.onMotionChange);
    this.stopMotion();
    this.next.removeEventListener('click', this.onNext);
    this.screen.remove();
  }

  private standing(row: StandingRow, index: number, localKartId: number): HTMLElement {
    const player = row.kartId === localKartId;
    const item = element('li', player ? 'standings-row is-player' : 'standings-row');
    item.dataset.kartId = String(row.kartId);
    const name = element('span', 'racer-name');
    const label = element('span', 'standings-name', row.name);
    label.title = row.name;
    name.append(label);
    if (player) name.append(element('small', 'standings-you', 'YOU'));
    const points = element('strong', 'standings-points', String(row.points));
    const live = element('span', 'standings-points-live');
    live.hidden = true;
    live.setAttribute('aria-hidden', 'true');
    this.counters.push({ node: points, text: live, from: row.points - row.gained, to: row.points });
    points.append(element('span', 'gp-sr-only', ` 合計 ${row.points} ポイント`));
    const cell = element('span', 'standings-points-cell');
    cell.append(points, live);
    const gained = element('span', 'standings-gained', `+${row.gained}`);
    gained.append(element('span', 'gp-sr-only', ` 今回 ${row.gained} ポイント獲得`));
    item.append(element('span', 'standings-position', String(index + 1).padStart(2, '0')),
      swatch(row.color), name, cell, gained);
    return item;
  }
}
