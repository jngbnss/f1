import { Peer, type DataConnection } from 'peerjs';
import {
  decodeStates,
  encodeStates,
  joinRecords,
  MAX_CARS,
  packetRecords,
  randomCode,
  ROOM_PREFIX,
  STATE_HZ,
  type CarState,
  type GridSlot,
  type LobbyPlayer,
  type LobbyState,
  type Message,
  type RacePlan,
} from './protocol';
import { Voice } from './Voice';

/**
 * A multiplayer room over WebRTC (PeerJS for signalling, its free public
 * broker; no game server). The room creator's browser is the host: it holds
 * the lobby, builds the grid, starts the race, simulates the AI cars and
 * relays every car's state to everyone else (star topology). Each player
 * simulates only their own car.
 */

const F1_TEAMS = ['f1-ferrari', 'f1-mercedes', 'f1-redbull', 'f1-mclaren', 'f1-aston', 'f1-alpine', 'f1-williams', 'f1-racingbulls', 'f1-haas', 'f1-audi'];
/** Unreliable, unordered channel for car states (same id on both ends, no renegotiation). */
const STATE_CHANNEL_ID = 100;
/** No message from a peer for this long (ms) = gone. */
const TIMEOUT = 15000;
/** Host starts anyway if someone takes longer than this (ms) to load the race. */
const LOAD_TIMEOUT = 30000;
/** Time between "go" and the green light (ms): the start-light countdown plus slack. */
const GO_LEAD = 5000;

interface Link {
  conn: DataConnection;
  state: RTCDataChannel | null;
  lastSeen: number;
}

export class Room {
  lobby: LobbyState = { players: [], laps: 3, aiFill: true, trackId: 'monza' };
  myId = '';
  plan: RacePlan | null = null;
  /** Host clock (ms) = performance.now() + offset. */
  private offset = 0;
  private bestRtt = Infinity;
  private readonly links = new Map<string, Link>();
  private hostLink: Link | null = null;
  private timers: number[] = [];
  private closed = false;
  /** Host: peers that finished loading the race. */
  private loaded = new Set<string>();
  private goSent = false;
  /** Host: latest unsent record per grid slot, and the slot owners. */
  private fresh = new Map<number, Uint8Array>();
  private slotOwner: string[] = [];

  onLobby?: (state: LobbyState) => void;
  onStart?: (plan: RacePlan) => void;
  onGo?: (startAt: number) => void;
  onStates?: (states: CarState[]) => void;
  onLeft?: (id: string) => void;
  onEnd?: (reason: string) => void;
  /** Voice chat over the same peers (listens right away; the mic only when turned on). */
  readonly voice: Voice;

  private constructor(
    private readonly peer: Peer,
    readonly isHost: boolean,
    readonly code: string,
  ) {
    this.myId = peer.id;
    this.voice = new Voice(peer, () => this.myId);
    peer.on('disconnected', () => {
      // Lost the broker only (open connections keep working); reconnect so others can still join.
      if (!this.closed && !peer.destroyed) peer.reconnect();
    });
  }

  /** Opens a new room; resolves once it is registered on the broker. */
  static async create(name: string, team: string): Promise<Room> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      try {
        const peer = await openPeer(ROOM_PREFIX + code);
        const room = new Room(peer, true, code);
        room.lobby.players.push({ id: peer.id, name: cleanName(name), team, host: true });
        room.listenAsHost();
        return room;
      } catch (e) {
        if ((e as { type?: string }).type !== 'unavailable-id') throw e;
      }
    }
    throw new Error('방 코드를 만들지 못했습니다');
  }

  /** Joins an existing room by code; resolves when the host has accepted us. */
  static async join(code: string, name: string, team: string): Promise<Room> {
    const peer = await openPeer();
    const room = new Room(peer, false, code.toUpperCase());
    await room.connectToHost(name, team);
    return room;
  }

  get started(): boolean {
    return this.plan !== null;
  }

  hostNow(): number {
    return performance.now() + this.offset;
  }

  /** My name / team changed in the lobby. */
  setProfile(name: string, team: string): void {
    if (this.isHost) {
      const me = this.lobby.players.find((p) => p.id === this.myId);
      if (me) {
        me.name = cleanName(name);
        me.team = this.freeTeam(team, me.id);
      }
      this.broadcastLobby();
    } else {
      this.send({ t: 'profile', name, team });
    }
  }

  /** Host: race settings. */
  setSettings(laps: number, aiFill: boolean): void {
    if (!this.isHost) return;
    this.lobby.laps = laps;
    this.lobby.aiFill = aiFill;
    this.broadcastLobby();
  }

  /** Host: build the grid and start loading the race everywhere. */
  startRace(): void {
    if (!this.isHost || this.plan) return;
    const humans = shuffle([...this.lobby.players]);
    const used = new Map<string, number>();
    const slots: GridSlot[] = humans.map((p) => {
      const driver = used.get(p.team) ?? 0;
      used.set(p.team, driver + 1);
      return { id: p.id, name: p.name, carId: p.team, driver, ai: false };
    });
    if (this.lobby.aiFill) {
      let n = 0;
      for (const team of F1_TEAMS) {
        while ((used.get(team) ?? 0) < 2 && slots.length < MAX_CARS) {
          const driver = used.get(team) ?? 0;
          used.set(team, driver + 1);
          slots.push({ id: `ai-${n++}`, name: '', carId: team, driver, ai: true });
        }
      }
    }
    const plan: RacePlan = { trackId: this.lobby.trackId, laps: this.lobby.laps, slots };
    this.beginRace(plan);
    for (const id of this.links.keys()) this.sendTo(id, { t: 'start', plan });
    this.onStart?.(plan);
    this.timers.push(window.setTimeout(() => this.maybeGo(true), LOAD_TIMEOUT));
  }

  /** This browser has built the race scene. */
  sendLoaded(): void {
    if (this.isHost) {
      this.loaded.add(this.myId);
      this.maybeGo(false);
    } else {
      this.send({ t: 'loaded' });
    }
  }

  /**
   * States of the cars this browser owns. Clients send them to the host;
   * the host queues them (with everyone else's) for the next relay tick.
   */
  sendStates(states: CarState[]): void {
    if (!states.length) return;
    const buf = encodeStates(states);
    if (this.isHost) {
      for (const r of packetRecords(buf)) this.fresh.set(r[0], r.slice());
    } else if (this.hostLink?.state?.readyState === 'open') {
      try {
        this.hostLink.state.send(buf);
      } catch {
        /* congested: drop, the next state follows */
      }
    }
  }

  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.voice.stop();
    for (const id of this.links.keys()) this.sendTo(id, { t: 'bye', reason: this.isHost ? '방장이 방을 닫았습니다' : 'left' });
    if (this.hostLink) this.send({ t: 'bye', reason: 'left' });
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    setTimeout(() => this.peer.destroy(), 200);
  }

  // --- host ----------------------------------------------------------------

  private listenAsHost(): void {
    this.peer.on('connection', (conn) => {
      const link: Link = { conn, state: null, lastSeen: performance.now() };
      conn.on('open', () => {
        link.state = stateChannel(conn);
        link.state.onmessage = (e) => this.onHostStates(conn.peer, e.data as ArrayBuffer);
      });
      conn.on('data', (raw) => {
        link.lastSeen = performance.now();
        this.onHostMessage(conn.peer, link, raw as Message);
      });
      conn.on('close', () => this.dropPeer(conn.peer));
      conn.on('error', () => this.dropPeer(conn.peer));
    });
    // Relay tick + liveness check.
    this.timers.push(
      window.setInterval(() => this.flushStates(), 1000 / STATE_HZ),
      window.setInterval(() => {
        const now = performance.now();
        for (const [id, l] of this.links) if (now - l.lastSeen > TIMEOUT) this.dropPeer(id);
      }, 1000),
    );
  }

  private onHostMessage(id: string, link: Link, msg: Message): void {
    switch (msg.t) {
      case 'hello': {
        if (this.plan) return this.reject(link.conn, '레이스가 이미 시작됐습니다');
        if (this.lobby.players.length >= MAX_CARS) return this.reject(link.conn, '방이 가득 찼습니다 (최대 20명)');
        this.links.set(id, link);
        this.lobby.players.push({ id, name: cleanName(msg.name), team: this.freeTeam(msg.team, id), host: false });
        this.broadcastLobby();
        return;
      }
      case 'profile': {
        const p = this.lobby.players.find((q) => q.id === id);
        if (!p || this.plan) return;
        p.name = cleanName(msg.name);
        p.team = this.freeTeam(msg.team, id);
        this.broadcastLobby();
        return;
      }
      case 'ping':
        link.conn.send({ t: 'pong', a: msg.a, h: this.hostNow() } satisfies Message);
        return;
      case 'loaded':
        this.loaded.add(id);
        this.maybeGo(false);
        return;
      case 'bye':
        this.dropPeer(id);
        return;
    }
  }

  private onHostStates(from: string, buf: ArrayBuffer): void {
    const link = this.links.get(from);
    if (link) link.lastSeen = performance.now();
    const records = packetRecords(buf).filter((r) => this.slotOwner[r[0]] === from); // only your own car
    if (!records.length) return;
    for (const r of records) this.fresh.set(r[0], r.slice());
    this.onStates?.(decodeStates(joinRecords(records)));
  }

  /** Host: one aggregated packet per client per tick (everything except its own car). */
  private flushStates(): void {
    if (!this.fresh.size) return;
    const records = [...this.fresh.values()];
    this.fresh.clear();
    for (const [id, link] of this.links) {
      const ch = link.state;
      if (ch?.readyState !== 'open') continue;
      const mine = records.filter((r) => this.slotOwner[r[0]] !== id);
      if (!mine.length) continue;
      // Keep packets under the SCTP message size comfort zone (~1.2 KB): split if needed.
      for (let i = 0; i < mine.length; i += 20) {
        try {
          ch.send(joinRecords(mine.slice(i, i + 20)));
        } catch {
          /* congested */
        }
      }
    }
  }

  private maybeGo(force: boolean): void {
    if (!this.plan || this.goSent) return;
    const humans = this.plan.slots.filter((s) => !s.ai && this.lobby.players.some((p) => p.id === s.id));
    if (!force && !humans.every((s) => this.loaded.has(s.id))) return;
    this.goSent = true;
    const startAt = this.hostNow() + GO_LEAD;
    for (const id of this.links.keys()) this.sendTo(id, { t: 'go', startAt });
    this.onGo?.(startAt);
  }

  private dropPeer(id: string): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    link.conn.close();
    this.lobby.players = this.lobby.players.filter((p) => p.id !== id);
    this.voice.drop(id);
    if (this.plan) {
      for (const other of this.links.keys()) this.sendTo(other, { t: 'left', id });
      this.onLeft?.(id);
      this.maybeGo(false);
    } else {
      this.broadcastLobby();
    }
  }

  private reject(conn: DataConnection, reason: string): void {
    conn.send({ t: 'bye', reason } satisfies Message);
    setTimeout(() => conn.close(), 300);
  }

  /** The requested team if it still has a free car, else the first team that does. */
  private freeTeam(team: string, id: string): string {
    const count = (t: string) => this.lobby.players.filter((p) => p.team === t && p.id !== id).length;
    if (F1_TEAMS.includes(team) && count(team) < 2) return team;
    return F1_TEAMS.find((t) => count(t) < 2) ?? F1_TEAMS[0];
  }

  private broadcastLobby(): void {
    for (const id of this.links.keys()) this.sendTo(id, { t: 'lobby', state: this.lobby, you: id });
    this.voice.setPeers(this.lobby.players.map((p) => p.id));
    this.onLobby?.(this.lobby);
  }

  private sendTo(id: string, msg: Message): void {
    const link = this.links.get(id);
    if (link?.conn.open) link.conn.send(msg);
  }

  private beginRace(plan: RacePlan): void {
    this.plan = plan;
    this.slotOwner = plan.slots.map((s) => (s.ai ? this.lobbyHostId() : s.id));
  }

  private lobbyHostId(): string {
    return this.lobby.players.find((p) => p.host)?.id ?? this.myId;
  }

  // --- client --------------------------------------------------------------

  private connectToHost(name: string, team: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(ROOM_PREFIX + this.code, { serialization: 'json', reliable: true });
      const link: Link = { conn, state: null, lastSeen: performance.now() };
      this.hostLink = link;
      let accepted = false;
      const fail = (reason: string) => {
        if (!accepted) reject(new Error(reason));
        else this.end(reason);
      };
      this.peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') fail('방을 찾을 수 없습니다 (코드를 확인하세요)');
        else if (!accepted) fail(`연결 실패: ${e.type}`);
      });
      conn.on('open', () => {
        link.state = stateChannel(conn);
        link.state.onmessage = (e) => {
          link.lastSeen = performance.now();
          this.onStates?.(decodeStates(e.data as ArrayBuffer));
        };
        conn.send({ t: 'hello', name, team } satisfies Message);
        this.startClock();
      });
      conn.on('data', (raw) => {
        link.lastSeen = performance.now();
        const msg = raw as Message;
        if (msg.t === 'lobby') {
          this.lobby = msg.state;
          this.myId = msg.you;
          this.voice.setPeers(msg.state.players.map((p) => p.id));
          if (!accepted) {
            accepted = true;
            resolve();
          }
          this.onLobby?.(msg.state);
        } else if (msg.t === 'bye') {
          fail(msg.reason);
        } else {
          this.onClientMessage(msg);
        }
      });
      conn.on('close', () => fail('방장과 연결이 끊어졌습니다'));
      this.timers.push(
        window.setInterval(() => {
          if (performance.now() - link.lastSeen > TIMEOUT) fail('방장과 연결이 끊어졌습니다');
        }, 1000),
      );
      setTimeout(() => {
        if (!accepted) fail('방에 연결하지 못했습니다 (시간 초과)');
      }, 20000);
    });
  }

  private onClientMessage(msg: Message): void {
    switch (msg.t) {
      case 'pong': {
        const now = performance.now();
        const rtt = now - msg.a;
        // Keep the estimate from the fastest round trip (least queuing delay), slowly forgetting it.
        this.bestRtt *= 1.02;
        if (rtt <= this.bestRtt) {
          this.bestRtt = rtt;
          this.offset = msg.h + rtt / 2 - now;
        }
        return;
      }
      case 'start':
        this.beginRace(msg.plan);
        this.onStart?.(msg.plan);
        return;
      case 'go':
        this.onGo?.(msg.startAt);
        return;
      case 'left':
        this.voice.drop(msg.id);
        this.onLeft?.(msg.id);
        return;
    }
  }

  /** Clock sync: a burst of pings, then one per second (also the keep-alive). */
  private startClock(): void {
    const ping = () => this.send({ t: 'ping', a: performance.now() });
    for (let i = 0; i < 6; i++) this.timers.push(window.setTimeout(ping, i * 150));
    this.timers.push(window.setInterval(ping, 1000));
  }

  private send(msg: Message): void {
    if (this.hostLink?.conn.open) this.hostLink.conn.send(msg);
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.voice.stop();
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.onEnd?.(reason);
    setTimeout(() => this.peer.destroy(), 200);
  }
}

export const TEAM_IDS = F1_TEAMS;

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
    const onError = (e: unknown) => {
      peer.destroy();
      reject(e);
    };
    peer.once('open', () => {
      peer.off('error', onError);
      resolve(peer);
    });
    peer.once('error', onError);
  });
}

/** Negotiated channel on the connection's RTCPeerConnection: both ends create it with the same id. */
function stateChannel(conn: DataConnection): RTCDataChannel {
  const ch = conn.peerConnection.createDataChannel('car-state', {
    negotiated: true,
    id: STATE_CHANNEL_ID,
    ordered: false,
    maxRetransmits: 0,
  });
  ch.binaryType = 'arraybuffer';
  return ch;
}

function cleanName(name: string): string {
  const s = name.replace(/[<>&"']/g, '').trim().slice(0, 12);
  return s || 'Driver';
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type { LobbyPlayer };
