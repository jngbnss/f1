/**
 * Multiplayer wire format.
 *
 * Control messages (lobby, start, clock sync) are JSON over PeerJS's reliable
 * data connection. Car states are a compact binary record sent over a second,
 * unordered / no-retransmit WebRTC data channel (UDP-like: a late state is
 * worthless, the next one is already on its way).
 */

/** Room ids on the public PeerJS broker are namespaced with this prefix. */
export const ROOM_PREFIX = 'websimlab-r-';
/** Most cars on a grid (humans + AI). */
export const MAX_CARS = 20;
/** Car states per second sent by each owner and relayed by the host. */
export const STATE_HZ = 20;
/** Remote cars are shown this far in the past (ms) so two states bracket the render time. */
export const INTERP_DELAY = 110;

export interface LobbyPlayer {
  id: string;
  name: string;
  /** F1 team (car id, e.g. "f1-ferrari"). */
  team: string;
  host: boolean;
}

export interface LobbyState {
  players: LobbyPlayer[];
  laps: number;
  /** Fill the empty grid slots with AI cars (simulated by the host). */
  aiFill: boolean;
  trackId: string;
}

/** One grid slot of a networked race (index = grid position). */
export interface GridSlot {
  /** Peer id of the human driving it, or "ai-N". */
  id: string;
  name: string;
  carId: string;
  /** 0 / 1: first or second car of the team (race number, helmet). */
  driver: number;
  ai: boolean;
}

export interface RacePlan {
  trackId: string;
  laps: number;
  slots: GridSlot[];
}

export type Message =
  | { t: 'hello'; name: string; team: string }
  | { t: 'profile'; name: string; team: string }
  | { t: 'lobby'; state: LobbyState; you: string }
  | { t: 'start'; plan: RacePlan }
  | { t: 'loaded' }
  | { t: 'go'; startAt: number }
  | { t: 'ping'; a: number }
  | { t: 'pong'; a: number; h: number }
  | { t: 'left'; id: string }
  | { t: 'bye'; reason: string };

/** Per-car state record (one owner's car at one moment). */
export interface CarState {
  slot: number;
  /** Host-clock time (ms) of this state. */
  time: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  /** Front wheel steer angle (rad). */
  steer: number;
  throttle: number;
  rpm: number;
  damageFront: number;
  damageRear: number;
  /** Index into COMPOUND order (soft, medium, hard). */
  compound: number;
  inPit: boolean;
  /** Rain / endplate lights flashing (harvesting). */
  lights: boolean;
}

export const RECORD_BYTES = 56;
const PACKET_STATES = 1;

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export function writeState(view: DataView, offset: number, s: CarState): void {
  view.setUint8(offset, s.slot);
  view.setUint8(offset + 1, (s.inPit ? 1 : 0) | (s.lights ? 2 : 0));
  view.setUint8(offset + 2, u8(s.damageFront));
  view.setUint8(offset + 3, u8(s.damageRear));
  view.setUint8(offset + 4, s.compound);
  view.setInt8(offset + 5, Math.max(-127, Math.min(127, Math.round(s.steer * 200))));
  view.setUint8(offset + 6, u8(s.throttle));
  view.setUint8(offset + 7, u8(s.rpm));
  view.setFloat64(offset + 8, s.time, true);
  const f = [s.px, s.py, s.pz, s.qx, s.qy, s.qz, s.qw, s.vx, s.vy, s.vz];
  for (let i = 0; i < f.length; i++) view.setFloat32(offset + 16 + i * 4, f[i], true);
}

export function readState(view: DataView, offset: number): CarState {
  const flags = view.getUint8(offset + 1);
  const f = (i: number) => view.getFloat32(offset + 16 + i * 4, true);
  return {
    slot: view.getUint8(offset),
    inPit: (flags & 1) !== 0,
    lights: (flags & 2) !== 0,
    damageFront: view.getUint8(offset + 2) / 255,
    damageRear: view.getUint8(offset + 3) / 255,
    compound: view.getUint8(offset + 4),
    steer: view.getInt8(offset + 5) / 200,
    throttle: view.getUint8(offset + 6) / 255,
    rpm: view.getUint8(offset + 7) / 255,
    time: view.getFloat64(offset + 8, true),
    px: f(0),
    py: f(1),
    pz: f(2),
    qx: f(3),
    qy: f(4),
    qz: f(5),
    qw: f(6),
    vx: f(7),
    vy: f(8),
    vz: f(9),
  };
}

/** Packet: [type u8][count u8][count x record]. */
export function encodeStates(states: readonly CarState[]): ArrayBuffer {
  const buf = new ArrayBuffer(2 + states.length * RECORD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, PACKET_STATES);
  view.setUint8(1, states.length);
  states.forEach((s, i) => writeState(view, 2 + i * RECORD_BYTES, s));
  return buf;
}

/** Raw records of a packet (host relays them without decoding twice). */
export function packetRecords(buf: ArrayBuffer): Uint8Array[] {
  const view = new DataView(buf);
  if (buf.byteLength < 2 || view.getUint8(0) !== PACKET_STATES) return [];
  const count = view.getUint8(1);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count && 2 + (i + 1) * RECORD_BYTES <= buf.byteLength; i++) {
    out.push(new Uint8Array(buf, 2 + i * RECORD_BYTES, RECORD_BYTES));
  }
  return out;
}

export function decodeStates(buf: ArrayBuffer): CarState[] {
  return packetRecords(buf).map((r) => readState(new DataView(r.buffer, r.byteOffset, RECORD_BYTES), 0));
}

/** Packet from raw records. */
export function joinRecords(records: readonly Uint8Array[]): ArrayBuffer {
  const out = new Uint8Array(2 + records.length * RECORD_BYTES);
  out[0] = PACKET_STATES;
  out[1] = records.length;
  records.forEach((r, i) => out.set(r, 2 + i * RECORD_BYTES));
  return out.buffer;
}

/** 5-letter room code without look-alike characters. */
export function randomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
