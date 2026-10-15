export const BASE_RENDER_DELAY_MS = 100;
export const MAX_RENDER_DELAY_MS = 250;
export const JITTER_WINDOW_MS = 3000;
export const MIN_JITTER_SAMPLES = 10;
export const JITTER_DEADBAND_MS = 2;
export const DELAY_SLEW = 0.05;
export const OFFSET_SLEW = 0.05;

function clampDelay(delayMs: number): number {
  return Math.max(BASE_RENDER_DELAY_MS, Math.min(MAX_RENDER_DELAY_MS, delayMs));
}

/** Arrival-local minus snapshot-host time; a constant clock offset cancels out. */
export class JitterEstimator {
  private samples: { latenessMs: number; now: number }[] = [];

  observe(latenessMs: number, now: number): void {
    if (!Number.isFinite(latenessMs) || !Number.isFinite(now)) return;
    this.expire(now);
    this.samples.push({ latenessMs, now });
  }

  target(now: number): number {
    if (!Number.isFinite(now)) return BASE_RENDER_DELAY_MS;
    this.expire(now);
    const values = this.samples.filter(sample => sample.now <= now)
      .map(sample => sample.latenessMs).sort((a, b) => a - b);
    if (values.length < MIN_JITTER_SAMPLES) return BASE_RENDER_DELAY_MS;
    const jitter = values[Math.ceil(values.length * 0.95) - 1] - values[0];
    return clampDelay(BASE_RENDER_DELAY_MS + (jitter < JITTER_DEADBAND_MS ? 0 : Math.round(jitter)));
  }

  private expire(now: number): void {
    this.samples = this.samples.filter(sample => sample.now >= now - JITTER_WINDOW_MS);
  }
}

function approach(current: number, target: number, maxStep: number): number {
  return current + Math.max(-maxStep, Math.min(maxStep, target - current));
}

/** Slews both corrections at 50 ms/s, keeping forward time at 90–110% speed. */
export class RenderClock {
  private offset = 0;
  private delay = BASE_RENDER_DELAY_MS;
  private lastNow: number | null = null;
  private lastHostTime = -Infinity;

  constructor(offsetMs: number, delayMs = BASE_RENDER_DELAY_MS) {
    this.reset(offsetMs, delayMs);
  }

  reset(offsetMs: number, delayMs = BASE_RENDER_DELAY_MS): void {
    this.offset = Number.isFinite(offsetMs) ? offsetMs : 0;
    this.delay = Number.isFinite(delayMs) ? clampDelay(delayMs) : BASE_RENDER_DELAY_MS;
    this.lastNow = null;
    this.lastHostTime = -Infinity;
  }

  advance(now: number, clockOffsetMs: number, targetDelayMs: number): void {
    if (!Number.isFinite(now)) return;
    const elapsed = Math.max(0, now - (this.lastNow ?? now));
    // A stale frame must not grant the same elapsed time again on the next frame.
    this.lastNow = Math.max(now, this.lastNow ?? now);
    if (Number.isFinite(clockOffsetMs)) {
      this.offset = approach(this.offset, clockOffsetMs, elapsed * OFFSET_SLEW);
    }
    if (Number.isFinite(targetDelayMs)) {
      this.delay = approach(this.delay, clampDelay(targetDelayMs), elapsed * DELAY_SLEW);
    }
  }

  hostTime(now: number): number {
    // Hold the last displayed time when the caller supplies a backwards timestamp.
    const localNow = Number.isFinite(now) ? now : this.lastNow ?? 0;
    this.lastHostTime = Math.max(this.lastHostTime, localNow + this.offset - this.delay);
    return this.lastHostTime;
  }

  get delayMs(): number { return this.delay; }
  get offsetMs(): number { return this.offset; }
}
