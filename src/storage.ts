const BEST_KEY = 'pocket-circuit.best.v1';
const MUTE_KEY = 'pocket-circuit.muted.v1';

export function loadBest(): number | null {
  try {
    const value = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function saveBest(time: number): void {
  try { localStorage.setItem(BEST_KEY, String(time)); } catch { /* Private browsing can deny storage. */ }
}

export function loadMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === 'true'; } catch { return false; }
}

export function saveMuted(muted: boolean): void {
  try { localStorage.setItem(MUTE_KEY, String(muted)); } catch { /* Audio remains usable without persistence. */ }
}
