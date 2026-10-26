import type { ItemType } from '../sim/types';

export const icon = (body: string, className = '', fill = 'none', fillOpacity = ''): string => `<svg class="${className}" viewBox="0 0 24 24" fill="${fill}"${fillOpacity ? ` fill-opacity="${fillOpacity}"` : ''} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const emptyItemIcon = icon('<path d="M6 4h12l3 8-9 9-9-9 3-8Z"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>');
/** Per-item accent: tints the two-tone fill under the currentColor outline and frames the HUD slot. */
export const itemColors: Record<ItemType, string> = {
  dash: '#ffd863', trap: '#ff9f43', bolt: '#4fc3f7', seeker: '#ff6b6b', skycomet: '#b388ff',
  tripleDash: '#ffe066', rapidDash: '#ff7043', aura: '#fff176', storm: '#7c9cff',
  ink: '#9575cd', decoy: '#f48fb1', bomb: '#ef5350', autopilot: '#66bb6a', barrier: '#26c6da',
};
export const itemIcons: Record<ItemType, string> = {
  dash: icon('<path d="m14 2-9 12h7l-2 8 9-12h-7l2-8Z"/>', '', itemColors.dash, '.35'),
  trap: icon('<path d="M5 16 12 4l7 12H5Z"/><path d="M3 20h18M12 9v3m0 3h.01"/>', '', itemColors.trap, '.35'),
  bolt: icon('<path d="m4 16 12-12 4 4-12 12H4v-4ZM13 7l4 4M3 6l3-3m12 18 3-3"/>', '', itemColors.bolt, '.35'),
  seeker: icon('<circle cx="14" cy="10" r="6"/><circle cx="14" cy="10" r="2"/><path d="M14 2v3m8 5h-3M5 10H2m8 9v3M9 15l-6 6m0-6v6h6"/>', '', itemColors.seeker, '.35'),
  skycomet: icon('<path d="m4 3 8 6m-2-7 7 5M2 9l7 7m6-8 2 4 5 1-4 3 1 5-4-2-4 2 1-5-4-3 5-1 2-4Z"/>', '', itemColors.skycomet, '.35'),
  tripleDash: icon('<path d="m5 5-3 7h4l-2 7m9-14-3 7h4l-2 7m9-14-3 7h4l-2 7"/>', '', itemColors.tripleDash, '.35'),
  rapidDash: icon('<path d="M13 2c1 5 6 7 6 12a7 7 0 0 1-14 0c0-3 2-5 4-7v5c3-2 4-5 4-10Z"/><path d="m13 11-4 5h4l-2 5"/>', '', itemColors.rapidDash, '.35'),
  aura: icon('<path d="m12 6 2 4 5 1-4 3 1 5-4-2-4 2 1-5-4-3 5-1 2-4Zm0-4v1M3 5l2 2m14 0 2-2M2 14h1m18 0h1M5 21l1-1m12 0 1 1"/>', '', itemColors.aura, '.35'),
  storm: icon('<path d="M5 13a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 3 9M12 10l-5 7h5l-2 5 7-8h-5l2-4M3 17l-1 3m18-3-1 3"/>', '', itemColors.storm, '.35'),
  ink: icon('<path d="M12 4c-2 4-7 7-7 11a7 7 0 0 0 14 0c0-4-5-7-7-11ZM3 3l1 2m16-3-1 3M2 11h1m18-2 1-1M9 16c0 2 1 3 3 3"/>', '', itemColors.ink, '.35'),
  decoy: icon('<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm-9 5 9 5 9-5M12 12v10M7 5l10 6M7 13v2m10-2v2m-3 3 2 1"/>', '', itemColors.decoy, '.35'),
  bomb: icon('<circle cx="10" cy="15" r="7"/><path d="m13 9 2-4 3 1m-2-2c1-3 4-2 4 0M7 12l-1 2m15-7 1 1m-1-7 1-1M11 4l-1-1"/>', '', itemColors.bomb, '.35'),
  autopilot: icon('<path d="M8 15c0-6 4-11 10-12 2 6 0 12-6 14l-4-2Zm0-5-4 2-1 5 5-2m8-1-1 6-5 1 2-4M7 18l-3 3m1-5-3 3"/><circle cx="14" cy="9" r="2"/>', '', itemColors.autopilot, '.35'),
  barrier: icon('<path d="m12 7 4 2v4c0 2-2 4-4 5-2-1-4-3-4-5V9l4-2Z"/><circle cx="12" cy="3" r="2"/><circle cx="3" cy="17" r="2"/><circle cx="21" cy="17" r="2"/><path d="M6 5a10 10 0 0 0-4 8m16-8a10 10 0 0 1 4 8M7 21a10 10 0 0 0 10 0"/>', '', itemColors.barrier, '.35'),
};
export const itemNames: Record<ItemType, string> = {
  dash: 'ソニックダッシュ', trap: 'ポップトラップ', bolt: 'リコシェボルト',
  seeker: 'ハウンドボルト', skycomet: 'スカイコメット', tripleDash: 'トリプルダッシュ',
  rapidDash: 'ブレイズダッシュ', aura: 'シャインオーラ', storm: 'スパークストーム',
  ink: 'インクスプラッシュ', decoy: 'ダミーボックス', bomb: 'ポップボム',
  autopilot: 'ロケットライド', barrier: 'オービットガード',
};
export const itemShortNames: Record<ItemType, string> = {
  dash: 'ダッシュ', trap: 'トラップ', bolt: 'ボルト', seeker: 'ハウンド', skycomet: 'コメット',
  tripleDash: '3ダッシュ', rapidDash: 'ブレイズ', aura: 'オーラ', storm: 'ストーム',
  ink: 'インク', decoy: 'ダミー', bomb: 'ボム', autopilot: 'ロケット', barrier: 'ガード',
};

export const itemIcon = (item: ItemType): string => itemIcons[item];
export const itemName = (item: ItemType): string => itemNames[item];
export const itemShortName = (item: ItemType): string => itemShortNames[item];

/** Every item icon the roulette may flash; purely decorative and independent of the sim draw. */
export const rouletteItems = Object.keys(itemIcons) as ItemType[];

/** Icons the strip scrolls past between the first frame and the stop. */
export const ROULETTE_STEPS = 24;
/** Seconds the confirmed icon takes to settle from 1.25x back to 1.0x. */
export const ROULETTE_SETTLE = 0.12;

/** Ease-out cubic: fast at the start, coming to rest exactly when the roulette time reaches 0. */
export const rouletteEase = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** Strip position in icons (integer part = icons passed, fraction = scroll between tiles) for the remaining time. */
export function roulettePhase(remaining: number, total: number): number {
  return ROULETTE_STEPS * rouletteEase(1 - Math.min(1, Math.max(0, remaining / total)));
}

/** A random roulette item other than `current`, so every switch visibly changes the icon. */
export function nextRouletteItem(current: ItemType | null, random: () => number = Math.random): ItemType {
  const choices = rouletteItems.filter((item) => item !== current);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

/** The local kart's roulette presentation state; decorative only, never fed back into the sim. */
export interface RouletteView {
  active: boolean;
  /** Icon in the slot; null shows the still "?" used for reduced motion. */
  item: ItemType | null;
  /** Vertical 3-tile strip [above, current, below]; null while reduced motion shows the still "?". */
  strip: [ItemType, ItemType, ItemType] | null;
  /** Icons scrolled past so far. */
  step: number;
  /** Scroll fraction 0..1 toward the next tile. */
  frac: number;
  remaining: number;
  reduced: boolean;
}

export const createRouletteView = (): RouletteView => ({ active: false, item: null, strip: null, step: 0, frac: 0, remaining: 0, reduced: false });

function resetStrip(view: RouletteView, phase: number, reduced: boolean, random: () => number): void {
  const a = nextRouletteItem(null, random);
  const b = nextRouletteItem(a, random);
  const c = nextRouletteItem(b, random);
  Object.assign(view, reduced
    ? { item: null, strip: null }
    : { item: b, strip: [a, b, c] as [ItemType, ItemType, ItemType] },
  { step: Math.floor(phase), frac: phase - Math.floor(phase), reduced });
}

/**
 * Advances the roulette view for one frame. 'start' also covers a new roulette replacing a running one
 * (rouletteTime rose, e.g. a box grabbed right after a storm stole the item); 'restyle' redraws the slot
 * after the reduced-motion preference changes mid-spin; 'switch' is one icon scrolled past.
 * The strip position is a pure easeOut function of the remaining time, so it stops when rouletteTime hits 0.
 */
export function stepRoulette(view: RouletteView, remaining: number, reduced: boolean, total: number,
  random: () => number = Math.random): 'start' | 'switch' | 'restyle' | 'stop' | null {
  if (remaining <= 0) {
    const stopped = view.active;
    Object.assign(view, { active: false, remaining: 0, strip: null, item: null });
    return stopped ? 'stop' : null;
  }
  const phase = roulettePhase(remaining, total);
  let step: 'start' | 'switch' | 'restyle' | null = null;
  if (!view.active || remaining > view.remaining + 1e-6) {
    view.active = true;
    resetStrip(view, phase, reduced, random);
    step = 'start';
  } else if (reduced !== view.reduced) {
    resetStrip(view, phase, reduced, random);
    step = 'restyle';
  } else if (!reduced && view.strip) {
    while (view.step < Math.floor(phase)) {
      view.strip = [view.strip[1], view.strip[2], nextRouletteItem(view.strip[2], random)];
      view.item = view.strip[1];
      view.step++;
      step = 'switch';
    }
    view.frac = phase - Math.floor(phase);
  }
  view.remaining = remaining;
  return step;
}

/**
 * Markup for the scrolling strip. Geometry is anchored to the slot frame: an absolute, clipped wrapper fills it,
 * the strip is 3 frame-heights tall, each tile is exactly one frame tall and the SVG is a % of the tile.
 * The shift is (1 + frac) tiles, so the window always sits inside the strip. Without a strip (reduced motion)
 * the final icon, or the "?" when none is known, is shown still.
 */
export function rouletteStripHtml(view: RouletteView, still: ItemType | null = null): string {
  if (!view.strip) return still ? itemIcons[still] : emptyItemIcon;
  const svgStyle = 'width:70%;height:70%;animation:none';
  const tiles = view.strip.map((item) => `<div style="height:33.3333%;display:flex;align-items:center;justify-content:center">${itemIcons[item].replace('<svg ', `<svg style="${svgStyle}" `)}</div>`).join('');
  return `<div class="roulette-slot" style="position:absolute;inset:0;overflow:hidden"><div style="position:absolute;left:0;right:0;top:0;height:300%;transform:translateY(${(-(1 + view.frac) * 100 / 3).toFixed(3)}%)">${tiles}</div></div>`;
}
