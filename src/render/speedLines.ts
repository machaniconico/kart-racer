const LINE_COUNT = 24;

/** clamp((speed-30)/14, 0, 1) x (boosting ? 1 : 0.5); hidden under reduced motion. */
export function speedLineOpacity(speed: number, boostTime: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  return Math.min(1, Math.max(0, (speed - 30) / 14)) * (boostTime > 0 ? 1 : 0.5);
}

/** 2D canvas overlay (sibling of the WebGL canvas); adds no WebGL program. Inert when there is no DOM parent. */
export class SpeedLines {
  private readonly overlay: HTMLCanvasElement | null = null;
  private readonly ctx: CanvasRenderingContext2D | null = null;
  private drawn = false;

  constructor(canvas: HTMLCanvasElement) {
    const parent = canvas.parentElement;
    if (!parent || typeof document === 'undefined') return;
    const overlay = document.createElement('canvas');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block';
    canvas.after(overlay);
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
  }

  resize(width: number, height: number): void {
    if (!this.overlay) return;
    this.overlay.width = Math.max(1, Math.round(width));
    this.overlay.height = Math.max(1, Math.round(height));
    this.drawn = false;
  }

  update(opacity: number): void {
    const { overlay, ctx } = this;
    if (!overlay || !ctx) return;
    if (opacity <= 0) {
      if (this.drawn) ctx.clearRect(0, 0, overlay.width, overlay.height);
      this.drawn = false;
      return;
    }
    const w = overlay.width, h = overlay.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, w / 480);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const inner = Math.min(w, h) * 0.32;
    for (let i = 0; i < LINE_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const start = inner + Math.random() * inner * 0.6;
      const end = start + w * (0.12 + Math.random() * 0.16);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      ctx.moveTo(w / 2 + cos * start, h / 2 + sin * start);
      ctx.lineTo(w / 2 + cos * end, h / 2 + sin * end);
    }
    ctx.stroke();
    this.drawn = true;
  }

  dispose(): void {
    this.overlay?.remove();
  }
}
