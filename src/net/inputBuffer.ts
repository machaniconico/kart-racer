import { MAX_PLAYERS, PacketKind } from './protocol';
import type { InputFrame } from './protocol';

export const INPUT_HISTORY = 4;
export const INPUT_HEADER_BYTES = 8;
export const INPUT_FRAME_BYTES = 3;
export const INPUT_HOLD_TICKS = 10;
export const NEUTRAL_INPUT: Readonly<InputFrame> = Object.freeze({
  steer: 0, throttle: 0, brake: false, drift: false, useItem: false,
});

export interface InputPacket {
  slot: number;
  raceId: number;
  latestTick: number;
  /** Newest first: frames[i] belongs to latestTick - i. */
  frames: InputFrame[];
}

function uint(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}
function validInput(frame: InputFrame): boolean {
  return !!frame && Number.isFinite(frame.steer) && frame.steer >= -1 && frame.steer <= 1 &&
    Number.isFinite(frame.throttle) && frame.throttle >= 0 && frame.throttle <= 1 &&
    typeof frame.brake === 'boolean' && typeof frame.drift === 'boolean' && typeof frame.useItem === 'boolean';
}
function validPacket(packet: InputPacket): boolean {
  return !!packet && uint(packet.slot, MAX_PLAYERS - 1) && uint(packet.raceId, 255) &&
    uint(packet.latestTick, 0xffffffff) && Array.isArray(packet.frames) &&
    packet.frames.length >= 1 && packet.frames.length <= INPUT_HISTORY &&
    packet.frames.length <= packet.latestTick + 1 && Array.from(packet.frames).every(validInput);
}

/** Analog axes use the canonical i8/127 and u8/255 wire lattice. */
export function quantizeInput(frame: InputFrame): InputFrame {
  if (!validInput(frame)) throw new RangeError('Invalid input frame');
  return { ...frame, steer: (Math.round(frame.steer * 127) || 0) / 127, throttle: Math.round(frame.throttle * 255) / 255 };
}

export function pack(packet: InputPacket): ArrayBuffer {
  if (!validPacket(packet)) throw new RangeError('Invalid input packet');
  const buffer = new ArrayBuffer(INPUT_HEADER_BYTES + INPUT_FRAME_BYTES * packet.frames.length);
  const view = new DataView(buffer);
  view.setUint8(0, PacketKind.INPUT);
  view.setUint8(1, packet.slot);
  view.setUint8(2, packet.raceId);
  view.setUint32(3, packet.latestTick, true);
  view.setUint8(7, packet.frames.length);
  packet.frames.forEach((frame, index) => {
    const offset = INPUT_HEADER_BYTES + INPUT_FRAME_BYTES * index;
    view.setInt8(offset, Math.round(frame.steer * 127));
    view.setUint8(offset + 1, Math.round(frame.throttle * 255));
    view.setUint8(offset + 2, Number(frame.brake) | (Number(frame.drift) << 1) | (Number(frame.useItem) << 2));
  });
  return buffer;
}

export function unpack(data: unknown): InputPacket | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < INPUT_HEADER_BYTES) return null;
  const view = new DataView(data);
  const count = view.getUint8(7);
  const packet: InputPacket = {
    slot: view.getUint8(1), raceId: view.getUint8(2), latestTick: view.getUint32(3, true), frames: [],
  };
  if (view.getUint8(0) !== PacketKind.INPUT || packet.slot >= MAX_PLAYERS || count < 1 || count > INPUT_HISTORY ||
    count > packet.latestTick + 1 || data.byteLength !== INPUT_HEADER_BYTES + INPUT_FRAME_BYTES * count) return null;
  for (let index = 0; index < count; index++) {
    const offset = INPUT_HEADER_BYTES + INPUT_FRAME_BYTES * index;
    const steer = view.getInt8(offset);
    const flags = view.getUint8(offset + 2);
    if (steer === -128 || (flags & ~7) !== 0) return null;
    packet.frames.push({ steer: steer / 127, throttle: view.getUint8(offset + 1) / 255,
      brake: (flags & 1) !== 0, drift: (flags & 2) !== 0, useItem: (flags & 4) !== 0 });
  }
  return packet;
}

export interface InputBufferOptions { slot?: number; raceId?: number; maxFutureTicks?: number }

/** One host-side buffer per guest slot. All tick arguments use the host's clock. */
export class InputBuffer {
  private readonly frames = new Map<number, InputFrame>();
  private readonly slot: number;
  private readonly maxFutureTicks: number;
  private raceId: number;
  private latestPacketTick = -1;
  private sampledTick = -1;
  private lastTick = -Infinity;
  private last: InputFrame = { ...NEUTRAL_INPUT };

  constructor({ slot = 0, raceId = 0, maxFutureTicks = 120 }: InputBufferOptions = {}) {
    if (!uint(slot, MAX_PLAYERS - 1) || !uint(raceId, 255) || !uint(maxFutureTicks, 600) || maxFutureTicks < 1) {
      throw new RangeError('Invalid input buffer options');
    }
    this.slot = slot;
    this.raceId = raceId;
    this.maxFutureTicks = maxFutureTicks;
  }
  get size(): number { return this.frames.size; }

  receive(packet: InputPacket, currentTick: number): boolean {
    if (!validPacket(packet) || !uint(currentTick, 0xffffffff) || currentTick < this.sampledTick ||
      packet.slot !== this.slot || packet.raceId !== this.raceId || packet.latestTick <= this.latestPacketTick ||
      packet.latestTick > currentTick + this.maxFutureTicks) return false;
    this.latestPacketTick = packet.latestTick;
    this.prune(currentTick);
    packet.frames.forEach((frame, index) => {
      const tick = packet.latestTick - index;
      const input = { ...frame };
      if (tick <= currentTick) {
        if (tick > this.lastTick) { this.last = input; this.lastTick = tick; }
      } else {
        this.frames.set(tick, input);
      }
    });
    return true;
  }

  private prune(tick: number): void {
    for (const [inputTick, input] of this.frames) {
      if (inputTick <= tick) {
        if (inputTick > this.lastTick) { this.lastTick = inputTick; this.last = input; }
        this.frames.delete(inputTick);
      }
    }
  }

  get(tick: number): InputFrame {
    if (!uint(tick, 0xffffffff) || tick < this.sampledTick) throw new RangeError('Input ticks must be monotonic');
    this.sampledTick = tick;
    this.prune(tick);
    return { ...(tick - this.lastTick <= INPUT_HOLD_TICKS ? this.last : NEUTRAL_INPUT) };
  }

  reset(raceId = this.raceId): void {
    if (!uint(raceId, 255)) throw new RangeError('Invalid race ID');
    this.raceId = raceId;
    this.frames.clear();
    this.latestPacketTick = this.sampledTick = -1;
    this.lastTick = -Infinity;
    this.last = { ...NEUTRAL_INPUT };
  }
}
