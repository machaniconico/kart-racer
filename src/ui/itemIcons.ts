import type { ItemType } from '../sim/types';

export const icon = (body: string, className = ''): string => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const emptyItemIcon = icon('<path d="M6 4h12l3 8-9 9-9-9 3-8Z"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>');
export const itemIcons: Record<ItemType, string> = {
  dash: icon('<path d="m14 2-9 12h7l-2 8 9-12h-7l2-8Z"/>'),
  trap: icon('<path d="M5 16 12 4l7 12H5Z"/><path d="M3 20h18M12 9v3m0 3h.01"/>'),
  bolt: icon('<path d="m4 16 12-12 4 4-12 12H4v-4ZM13 7l4 4M3 6l3-3m12 18 3-3"/>'),
  seeker: icon('<circle cx="14" cy="10" r="6"/><circle cx="14" cy="10" r="2"/><path d="M14 2v3m8 5h-3M5 10H2m8 9v3M9 15l-6 6m0-6v6h6"/>'),
  skycomet: icon('<path d="m4 3 8 6m-2-7 7 5M2 9l7 7m6-8 2 4 5 1-4 3 1 5-4-2-4 2 1-5-4-3 5-1 2-4Z"/>'),
  tripleDash: icon('<path d="m5 5-3 7h4l-2 7m9-14-3 7h4l-2 7m9-14-3 7h4l-2 7"/>'),
  rapidDash: icon('<path d="M13 2c1 5 6 7 6 12a7 7 0 0 1-14 0c0-3 2-5 4-7v5c3-2 4-5 4-10Z"/><path d="m13 11-4 5h4l-2 5"/>'),
  aura: icon('<path d="m12 6 2 4 5 1-4 3 1 5-4-2-4 2 1-5-4-3 5-1 2-4Zm0-4v1M3 5l2 2m14 0 2-2M2 14h1m18 0h1M5 21l1-1m12 0 1 1"/>'),
  storm: icon('<path d="M5 13a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 3 9M12 10l-5 7h5l-2 5 7-8h-5l2-4M3 17l-1 3m18-3-1 3"/>'),
  ink: icon('<path d="M12 4c-2 4-7 7-7 11a7 7 0 0 0 14 0c0-4-5-7-7-11ZM3 3l1 2m16-3-1 3M2 11h1m18-2 1-1M9 16c0 2 1 3 3 3"/>'),
  decoy: icon('<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm-9 5 9 5 9-5M12 12v10M7 5l10 6M7 13v2m10-2v2m-3 3 2 1"/>'),
  bomb: icon('<circle cx="10" cy="15" r="7"/><path d="m13 9 2-4 3 1m-2-2c1-3 4-2 4 0M7 12l-1 2m15-7 1 1m-1-7 1-1M11 4l-1-1"/>'),
  autopilot: icon('<path d="M8 15c0-6 4-11 10-12 2 6 0 12-6 14l-4-2Zm0-5-4 2-1 5 5-2m8-1-1 6-5 1 2-4M7 18l-3 3m1-5-3 3"/><circle cx="14" cy="9" r="2"/>'),
  barrier: icon('<path d="m12 7 4 2v4c0 2-2 4-4 5-2-1-4-3-4-5V9l4-2Z"/><circle cx="12" cy="3" r="2"/><circle cx="3" cy="17" r="2"/><circle cx="21" cy="17" r="2"/><path d="M6 5a10 10 0 0 0-4 8m16-8a10 10 0 0 1 4 8M7 21a10 10 0 0 0 10 0"/>'),
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
