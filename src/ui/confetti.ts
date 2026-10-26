export const CONFETTI_COUNT = 140;
export const CONFETTI_MS = 2400;
const COLORS = ['#d8ff75', '#ffd863', '#ff7a59', '#6ec6ff', '#ffffff'];

export interface Particle { x: number; y: number; vx: number; vy: number; size: number; spin: number; angle: number; color: string }

/** Burst from the top centre; positions in 0..1 of the canvas, velocities in canvas-widths per second. */
export function createParticles(count: number, random: () => number = Math.random): Particle[] {
  return Array.from({ length: count }, () => ({
    x: 0.5 + (random() - 0.5) * 0.3, y: -0.05, vx: (random() - 0.5) * 0.9, vy: 0.2 + random() * 0.5,
    size: 6 + random() * 6, spin: (random() - 0.5) * 12, angle: random() * Math.PI * 2,
    color: COLORS[Math.floor(random() * COLORS.length)]!,
  }));
}

export function stepParticles(particles: Particle[], dt: number): void {
  for (const p of particles) {
    p.vy += 0.9 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.angle += p.spin * dt;
  }
}

/** 2D canvas overlay inside `host`; returns a cancel function. Decorative only. */
export function startConfetti(host: HTMLElement): () => void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return () => undefined;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return () => undefined;
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = Math.max(1, host.clientWidth || window.innerWidth);
  canvas.height = Math.max(1, host.clientHeight || window.innerHeight);
  host.append(canvas);
  const particles = createParticles(CONFETTI_COUNT);
  let start = -1, last = 0, frame = 0, done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    canvas.remove();
  };
  const tick = (now: number): void => {
    if (done) return;
    if (start < 0) { start = now; last = now; }
    const elapsed = now - start;
    if (elapsed >= CONFETTI_MS) return finish();
    stepParticles(particles, Math.min(0.05, (now - last) / 1000));
    last = now;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = Math.min(1, (CONFETTI_MS - elapsed) / 600);
    for (const p of particles) {
      context.save();
      context.translate(p.x * canvas.width, p.y * canvas.width);
      context.rotate(p.angle);
      context.fillStyle = p.color;
      context.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      context.restore();
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return finish;
}
