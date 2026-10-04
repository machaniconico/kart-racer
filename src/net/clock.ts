import { PacketKind } from './protocol';

export const TICK_MS = 1000 / 60;
export const CLOCK_WINDOW_MS = 10_000;
export interface Ping { kind: typeof PacketKind.PING; t0: number }
export interface Pong { kind: typeof PacketKind.PONG; t0: number; hostNow: number }

export function packPing(t0: number): ArrayBuffer {
  return packClock({ kind: PacketKind.PING, t0 });
}
export function packPong(t0: number, hostNow: number): ArrayBuffer {
  return packClock({ kind: PacketKind.PONG, t0, hostNow });
}
function packClock(packet: Ping | Pong): ArrayBuffer {
  if (!Number.isFinite(packet.t0) || packet.t0 < 0 ||
    ('hostNow' in packet && (!Number.isFinite(packet.hostNow) || packet.hostNow < 0))) {
    throw new RangeError('Invalid clock timestamp');
  }
  const buffer = new ArrayBuffer(packet.kind === PacketKind.PING ? 9 : 17);
  const view = new DataView(buffer);
  view.setUint8(0, packet.kind);
  view.setFloat64(1, packet.t0, true);
  if ('hostNow' in packet) view.setFloat64(9, packet.hostNow, true);
  return buffer;
}
export function unpackClock(data: unknown): Ping | Pong | null {
  if (!(data instanceof ArrayBuffer) || (data.byteLength !== 9 && data.byteLength !== 17)) return null;
  const view = new DataView(data);
  const kind = view.getUint8(0);
  if ((kind !== PacketKind.PING || data.byteLength !== 9) &&
    (kind !== PacketKind.PONG || data.byteLength !== 17)) return null;
  const t0 = view.getFloat64(1, true);
  if (!Number.isFinite(t0) || t0 < 0) return null;
  if (kind === PacketKind.PING) return { kind, t0 };
  const hostNow = view.getFloat64(9, true);
  return Number.isFinite(hostNow) && hostNow >= 0 ? { kind: PacketKind.PONG, t0, hostNow } : null;
}

interface ClockSample { receivedAt: number; t0: number; offset: number; rtt: number }

export class ClockSync {
  private samples: ClockSample[] = [];
  private latestTime = -Infinity;
  private estimate: ClockSample | undefined;
  private estimatedOffset = 0;

  get offset(): number { return this.estimatedOffset; }
  get rtt(): number { return this.estimate?.rtt ?? 0; }
  get sampleCount(): number { return this.samples.length; }
  get ready(): boolean { return this.sampleCount >= 3; }
  get lead(): number { return Math.ceil(this.rtt / (2 * TICK_MS)) + 2; }

  /** hostNow is captured immediately on ping reception (no host processing delay). */
  sample(t0: number, hostNow: number, receivedAt: number): boolean {
    if (![t0, hostNow, receivedAt].every(value => Number.isFinite(value) && value >= 0) ||
      receivedAt < t0 || receivedAt < this.latestTime || receivedAt - t0 > CLOCK_WINDOW_MS) return false;
    this.expire(receivedAt);
    if (this.samples.some(sample => sample.t0 === t0)) return false;
    const rtt = receivedAt - t0;
    this.samples.push({ t0, receivedAt, rtt, offset: hostNow - (t0 + rtt / 2) });
    // At the specified ping cadence this is <= 25 samples; cap unsolicited traffic too.
    if (this.samples.length > 128) this.samples.shift();
    this.selectBest();
    return true;
  }

  /** Call on each frame as well as on reception, so a stale estimate can expire. */
  expire(now: number): void {
    if (!Number.isFinite(now) || now < 0 || now < this.latestTime) return;
    this.latestTime = now;
    this.samples = this.samples.filter(sample => now - sample.receivedAt <= CLOCK_WINDOW_MS);
    this.selectBest();
  }

  private selectBest(): void {
    this.estimate = undefined;
    for (const sample of this.samples) {
      if (!this.estimate || sample.rtt <= this.estimate.rtt) this.estimate = sample;
    }
    // A single minimum-RTT sample can still have asymmetric jitter. Average up to
    // three similarly fast samples, excluding queued packets (> minimum + 5ms).
    const minimumRtt = this.estimate?.rtt ?? 0;
    const fastest = this.samples.filter(sample => sample.rtt <= minimumRtt + 5)
      .sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this.estimatedOffset = fastest.length ? fastest.reduce((sum, sample) => sum + sample.offset, 0) / fastest.length : 0;
  }

  hostTimeAt(localTime: number): number { return localTime + this.offset; }
  targetTick(map: TickMap, localTime: number): number {
    return Math.ceil(map.hostTickAt(this.hostTimeAt(localTime))) + this.lead;
  }
  reset(): void {
    this.samples = [];
    this.latestTime = -Infinity;
    this.estimate = undefined;
    this.estimatedOffset = 0;
  }
}

/** The latest host snapshot replaces the anchor, including after a host pause. */
export class TickMap {
  private tick = 0;
  private hostTime = 0;

  constructor(tick = 0, hostTime = 0) { this.reset(tick, hostTime); }

  update(tick: number, hostTime: number): boolean {
    if (!this.valid(tick, hostTime) || tick < this.tick || hostTime < this.hostTime) return false;
    this.tick = tick;
    this.hostTime = hostTime;
    return true;
  }
  reset(tick = 0, hostTime = 0): void {
    if (!this.valid(tick, hostTime)) throw new RangeError('Invalid tick anchor');
    this.tick = tick;
    this.hostTime = hostTime;
  }
  private valid(tick: number, hostTime: number): boolean {
    return Number.isInteger(tick) && tick >= 0 && tick <= 0xffffffff && Number.isFinite(hostTime) && hostTime >= 0;
  }
  hostTickAt(hostTime: number): number { return this.tick + (hostTime - this.hostTime) / TICK_MS; }
  hostTimeAt(tick: number): number { return this.hostTime + (tick - this.tick) * TICK_MS; }
}
