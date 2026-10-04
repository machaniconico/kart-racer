import './items.css';

let overlay: HTMLDivElement | null = null;

/** Mount after GameUI creates its DOM. Recreating the UI replaces the old layer. */
export function createInkOverlay(parent: HTMLElement): HTMLDivElement {
  disposeInkOverlay();
  overlay = parent.ownerDocument.createElement('div');
  overlay.id = 'ink-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.hidden = true;
  parent.append(overlay);
  return overlay;
}

/** Remaining simulation seconds, not wall time: pause and snapshots stay in sync. */
export function update(inkTime: number): void {
  if (!overlay) return;
  const remaining = Number.isFinite(inkTime) ? Math.max(0, Math.min(4, inkTime)) : 0;
  overlay.style.opacity = String(remaining / 4 * 0.9);
  overlay.hidden = remaining === 0;
}

export function disposeInkOverlay(): void {
  overlay?.remove();
  overlay = null;
}
