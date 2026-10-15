import { CUPS, isComplete, nextTrack, standings } from '../gp/grandPrix';
import type { GrandPrix, StandingRow } from '../gp/grandPrix';
import { TRACKS } from '../sim/tracks';
import './gp.css';

export interface GrandPrixUICallbacks {
  onNext: () => void;
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
    this.next.addEventListener('click', this.onNext);

    const header = element('header', 'standings-heading');
    header.append(this.progress, this.cup, this.nextCourse);
    const content = element('div', 'standings-content');
    content.append(header, this.podium, this.list, this.next);
    this.screen.append(content);
    root.append(this.screen);
  }

  render(gp: GrandPrix, localKartId: number): void {
    const complete = isComplete(gp);
    const rows = standings(gp);
    const trackId = nextTrack(gp);
    this.cup.textContent = CUPS.find(cup => cup.id === gp.cupId)!.name;
    this.progress.textContent = complete ? 'FINAL RESULT' : `RACE ${Math.max(1, gp.raceIndex)} / 4`;
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

  show(): void { this.screen.hidden = false; }

  hide(): void { this.screen.hidden = true; }

  destroy(): void {
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
    points.append(element('span', 'gp-sr-only', ` 合計 ${row.points} ポイント`));
    const gained = element('span', 'standings-gained', `+${row.gained}`);
    gained.append(element('span', 'gp-sr-only', ` 今回 ${row.gained} ポイント獲得`));
    item.append(element('span', 'standings-position', String(index + 1).padStart(2, '0')),
      swatch(row.color), name, points, gained);
    return item;
  }
}
