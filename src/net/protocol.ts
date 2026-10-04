import type { RaceEvent, RaceState } from '../sim/types';
import type { RosterPlayer } from './session';

export type { InputFrame, RaceEvent, RaceState } from '../sim/types';
export type { RosterPlayer } from './session';

export const PROTOCOL_VERSION = 4;
export const ROOM_PREFIX = `pcircuit-v${PROTOCOL_VERSION}-`;
/** FNV-1a32 of JSON.stringify(SNAPSHOT_LAYOUT), including enum order and flight fields.
 * Pinned to protocol v4; snapshot codec tests compare the actual wire descriptors.
 */
export const LAYOUT_FINGERPRINT = '2daf5fc7';
export const MAX_PLAYERS = 8;
export const MAX_NAME_LENGTH = 10;
export const MAX_CONTROL_LENGTH = 65_536;
export const MAX_EVENTS = 256;
export const PacketKind = { INPUT: 0x01, SNAPSHOT: 0x02, PING: 0x03, PONG: 0x04 } as const;

export interface Hello { type: 'hello'; protocol: number; name: string; color: number }
export interface Welcome { type: 'welcome'; slot: number; roster: RosterPlayer[]; hostTime: number }
export type RejectReason = 'version' | 'full' | 'in_race' | 'bad_name';
export interface Reject { type: 'reject'; reason: RejectReason }
export interface Roster { type: 'roster'; players: RosterPlayer[] }
export interface Profile { type: 'profile'; name: string; color: number }
export interface RaceStart {
  type: 'race_start'; raceId: number; seed: number; roster: RosterPlayer[]; startAtHostTime: number;
}
export interface Events { type: 'events'; raceId: number; tick: number; events: RaceEvent[] }
export interface RaceEnd { type: 'race_end'; raceId: number; finalState: RaceState }
export interface ReturnLobby { type: 'return_lobby' }
export interface Leave { type: 'leave' }
export interface HostClosed { type: 'host_closed' }
export type ControlMessage = Hello | Welcome | Reject | Roster | Profile | RaceStart | Events |
  RaceEnd | ReturnLobby | Leave | HostClosed;

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function integer(value: unknown, min = 0, max = 0xffffffff): value is number {
  return finite(value) && Number.isInteger(value) && value >= min && value <= max;
}
function positiveTime(value: unknown): value is number { return finite(value) && value >= 0; }
function slot(value: unknown): value is number { return integer(value, 0, MAX_PLAYERS - 1); }
function color(value: unknown): value is number { return integer(value, 0, 0xffffff); }
function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}
function arrayOf(value: unknown, guard: (entry: unknown) => boolean, max: number, min = 0): boolean {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    Array.from(value).every(guard);
}
export function isPlayerName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAME_LENGTH * 2 &&
    [...value].length <= MAX_NAME_LENGTH && value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
export function isRosterPlayer(value: unknown): value is RosterPlayer {
  return record(value) && keys(value, ['slot', 'name', 'color', 'kind', 'connected']) &&
    slot(value.slot) && isPlayerName(value.name) && color(value.color) &&
    oneOf(value.kind, ['host', 'guest', 'cpu']) && typeof value.connected === 'boolean';
}
export function isRosterPlayers(value: unknown): value is RosterPlayer[] {
  return arrayOf(value, isRosterPlayer, MAX_PLAYERS, 1) &&
    new Set((value as RosterPlayer[]).map(player => player.slot)).size === (value as unknown[]).length;
}

const eventTypes = ['countdown', 'go', 'pickup', 'hit', 'boost', 'lap', 'finish', 'use',
  'block', 'explode', 'storm', 'ink', 'aura_start', 'auto_start'];
export function isRaceEvent(value: unknown): value is RaceEvent {
  return record(value) && keys(value, ['type', 'kartId'], ['value', 'x', 'z']) &&
    oneOf(value.type, eventTypes) && integer(value.kartId, -1, MAX_PLAYERS - 1) &&
    ['value', 'x', 'z'].every(key => !Object.hasOwn(value, key) || finite(value[key]));
}

const itemTypes = ['dash', 'trap', 'bolt', 'seeker', 'skycomet', 'tripleDash', 'rapidDash',
  'aura', 'storm', 'ink', 'decoy', 'bomb', 'autopilot', 'barrier'];
const poseFields = ['x', 'y', 'z', 'heading'];
const kartNumbers = [...poseFields, 'speed', 'steer', 'trackDistance', 'lateralOffset',
  'lapStartTime', 'driftTime', 'driftDirection', 'boostTime', 'spinTime', 'hopTime',
  'lapProgress', 'aiPhase', 'hitCooldown'];
const kartBooleans = ['wrongWay', 'startedLap', 'lapValid', 'previousDrift', 'previousItem'];
const effectTimers = ['rapidTime', 'auraTime', 'shrinkTime', 'inkTime', 'autoTime'];
function effects(value: unknown): boolean {
  return record(value) && keys(value, [...effectTimers, 'rapidUnused', 'charges', 'holding', 'aiHoldTicks', 'orbitKind', 'orbitCount']) &&
    effectTimers.every(key => positiveTime(value[key])) && integer(value.charges, 0, 3) &&
    integer(value.rapidUnused, 0, 1) && integer(value.aiHoldTicks, 0, 60) &&
    integer(value.holding, 0, 1) && integer(value.orbitKind, 0, 2) && integer(value.orbitCount, 0, 3);
}
function kart(value: unknown): boolean {
  return record(value) && keys(value, [...kartNumbers, ...kartBooleans, 'id', 'name', 'color',
    'lap', 'nextCheckpoint', 'lapTimes', 'finishTime', 'item', 'human', 'effects']) &&
    slot(value.id) && isPlayerName(value.name) && color(value.color) &&
    kartNumbers.every(key => finite(value[key])) && kartBooleans.every(key => typeof value[key] === 'boolean') &&
    integer(value.lap, 0, 255) && integer(value.nextCheckpoint, 0, 255) &&
    arrayOf(value.lapTimes, positiveTime, 255) &&
    (value.finishTime === null || positiveTime(value.finishTime)) &&
    (value.item === null || oneOf(value.item, itemTypes)) &&
    typeof value.human === 'boolean' && effects(value.effects);
}
function box(value: unknown): boolean {
  return record(value) && keys(value, [...poseFields, 'id', 'respawnTime']) &&
    poseFields.every(key => finite(value[key])) && integer(value.id) && positiveTime(value.respawnTime);
}
function entity(value: unknown, trap: boolean): boolean {
  const extra = trap ? 'age' : 'bounces';
  return record(value) && keys(value, [...poseFields, 'id', 'ownerId', 'life', extra, 'kind'],
    trap ? ['target', 'aux'] : ['target', 'aux', 'speed', 'ownerCleared']) &&
    poseFields.every(key => finite(value[key])) && integer(value.id) && slot(value.ownerId) &&
    positiveTime(value.life) && (trap ? positiveTime(value.age) : integer(value.bounces, 0, 127)) &&
    oneOf(value.kind, trap ? ['trap', 'decoy'] : ['bolt', 'seeker', 'skycomet', 'bomb']) &&
    (!Object.hasOwn(value, 'target') || value.target === null || slot(value.target)) &&
    (!Object.hasOwn(value, 'aux') || finite(value.aux)) &&
    (!Object.hasOwn(value, 'speed') || (value.kind === 'bomb' && positiveTime(value.speed) && value.speed <= 127.5)) &&
    (!Object.hasOwn(value, 'ownerCleared') ||
      (oneOf(value.kind, ['bolt', 'bomb']) && typeof value.ownerCleared === 'boolean'));
}
export function isRaceState(value: unknown): value is RaceState {
  if (!record(value) || !keys(value, ['tick', 'seed', 'phase', 'countdown', 'racingTicks', 'time',
    'karts', 'boxes', 'projectiles', 'traps', 'events', 'nextEntityId'])) return false;
  return integer(value.tick) && integer(value.seed) && integer(value.racingTicks) &&
    oneOf(value.phase, ['countdown', 'racing', 'finished']) && finite(value.countdown) && positiveTime(value.time) &&
    arrayOf(value.karts, kart, MAX_PLAYERS, 1) &&
    new Set((value.karts as RecordValue[]).map(entry => entry.id)).size === (value.karts as unknown[]).length &&
    arrayOf(value.boxes, box, 64) && arrayOf(value.projectiles, entry => entity(entry, false), 256) &&
    arrayOf(value.traps, entry => entity(entry, true), 256) && arrayOf(value.events, isRaceEvent, MAX_EVENTS) &&
    integer(value.nextEntityId);
}

export function isHello(value: unknown): value is Hello {
  // Other versions are structurally valid so the host can send reject:version.
  return record(value) && keys(value, ['type', 'protocol', 'name', 'color']) && value.type === 'hello' &&
    integer(value.protocol, 1, 0xffff) && isPlayerName(value.name) && color(value.color);
}
export function isWelcome(value: unknown): value is Welcome {
  return record(value) && keys(value, ['type', 'slot', 'roster', 'hostTime']) && value.type === 'welcome' &&
    slot(value.slot) && isRosterPlayers(value.roster) &&
    value.roster.some(player => player.slot === value.slot) && positiveTime(value.hostTime);
}
export function isReject(value: unknown): value is Reject {
  return record(value) && keys(value, ['type', 'reason']) && value.type === 'reject' &&
    oneOf(value.reason, ['version', 'full', 'in_race', 'bad_name']);
}
export function isRoster(value: unknown): value is Roster {
  return record(value) && keys(value, ['type', 'players']) && value.type === 'roster' && isRosterPlayers(value.players);
}
export function isProfile(value: unknown): value is Profile {
  return record(value) && keys(value, ['type', 'name', 'color']) && value.type === 'profile' &&
    isPlayerName(value.name) && color(value.color);
}
export function isRaceStart(value: unknown): value is RaceStart {
  return record(value) && keys(value, ['type', 'raceId', 'seed', 'roster', 'startAtHostTime']) &&
    value.type === 'race_start' && integer(value.raceId, 0, 255) && integer(value.seed) &&
    isRosterPlayers(value.roster) && positiveTime(value.startAtHostTime);
}
export function isEvents(value: unknown): value is Events {
  return record(value) && keys(value, ['type', 'raceId', 'tick', 'events']) && value.type === 'events' &&
    integer(value.raceId, 0, 255) && integer(value.tick) && arrayOf(value.events, isRaceEvent, MAX_EVENTS);
}
export function isRaceEnd(value: unknown): value is RaceEnd {
  return record(value) && keys(value, ['type', 'raceId', 'finalState']) && value.type === 'race_end' &&
    integer(value.raceId, 0, 255) && isRaceState(value.finalState);
}
export function isReturnLobby(value: unknown): value is ReturnLobby {
  return record(value) && keys(value, ['type']) && value.type === 'return_lobby';
}
export function isLeave(value: unknown): value is Leave {
  return record(value) && keys(value, ['type']) && value.type === 'leave';
}
export function isHostClosed(value: unknown): value is HostClosed {
  return record(value) && keys(value, ['type']) && value.type === 'host_closed';
}

export const controlGuards = {
  hello: isHello, welcome: isWelcome, reject: isReject, roster: isRoster, profile: isProfile,
  race_start: isRaceStart, events: isEvents, race_end: isRaceEnd, return_lobby: isReturnLobby,
  leave: isLeave, host_closed: isHostClosed,
} satisfies { [Type in ControlMessage['type']]: (value: unknown) => boolean };

export function isControlMessage(value: unknown): value is ControlMessage {
  return record(value) && typeof value.type === 'string' && Object.hasOwn(controlGuards, value.type) &&
    controlGuards[value.type as ControlMessage['type']](value);
}

/** Only the transport boundary parses JSON; invalid input never escapes as an exception. */
export function parseControlMessage(data: unknown): ControlMessage | null {
  if (typeof data !== 'string' || data.length > MAX_CONTROL_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(data);
    return isControlMessage(value) ? value : null;
  } catch {
    return null;
  }
}

export function encodeControlMessage(message: ControlMessage): string {
  if (!isControlMessage(message)) throw new TypeError('Invalid control message');
  const data = JSON.stringify(message);
  if (data.length > MAX_CONTROL_LENGTH) throw new RangeError('Control message is too large');
  return data;
}
