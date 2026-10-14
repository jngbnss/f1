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
import type { ControlMode } from '../ui/ControlModeSwitch';

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
/** JavaScript timers are commonly suspended in background/mobile tabs. */
const TIMEOUT = 45000;
/** Keep a disconnected player's slot while a transient network failure reconnects. */
const RECONNECT_GRACE = 60000;
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000] as const;
/** Host starts anyway if someone takes longer than this (ms) to load the race. */
const LOAD_TIMEOUT = 30000;
/** Time between "go" and the green light (ms): the start-light countdown plus slack. */
const GO_LEAD = 5000;

interface Link {
  conn: DataConnection;
  state: RTCDataChannel | null;
  lastSeen: number;
}

export type ConnectionState = 'connected' | 'reconnecting';

export class Room {
  lobby: LobbyState = { players: [], laps: 3, aiFill: true, trackId: 'monza', control: 'keyboard' };
  myId = '';
  plan: RacePlan | null = null;
  /** Host clock (ms) = performance.now() + offset. */
  private offset = 0;
  private bestRtt = Infinity;
  private readonly links = new Map<string, Link>();
  private readonly pendingDrops = new Map<string, number>();
  private hostLink: Link | null = null;
  private timers: number[] = [];
  private reconnectTimer = 0;
  private reconnectStarted = 0;
  private reconnectAttempt = 0;
  private clockStarted = false;
  private profileName = '';
  private profileTeam = '';
  private closed = false;
  connectionState: ConnectionState = 'connected';
  connectionDetail = '연결됨';
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
  onConnection?: (state: ConnectionState, detail: string) => void;
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
    peer.on('open', () => {
      if (!this.isHost && this.connectionState === 'reconnecting') this.scheduleReconnect(0);
    });
    peer.on('error', (error) => {
      console.warn('[multiplayer] PeerJS error', error.type, error.message);
      if (!this.isHost && this.connectionState === 'reconnecting') this.scheduleReconnect(1000);
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
    room.profileName = cleanName(name);
    room.profileTeam = team;
    await room.connectToHost();
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
      this.profileName = cleanName(name);
      this.profileTeam = team;
      this.send({ t: 'profile', name, team });
    }
  }

  /** Host: race settings. */
  setSettings(laps: number, aiFill: boolean, control: ControlMode): void {
    if (!this.isHost) return;
    this.lobby.laps = laps;
    this.lobby.aiFill = aiFill;
    this.lobby.control = control;
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
    const plan: RacePlan = { trackId: this.lobby.trackId, laps: this.lobby.laps, control: this.lobby.control, slots };
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
    for (const t of this.pendingDrops.values()) clearTimeout(t);
    clearTimeout(this.reconnectTimer);
    setTimeout(() => this.peer.destroy(), 200);
  }

  // --- host ----------------------------------------------------------------

  private listenAsHost(): void {
    this.peer.on('connection', (conn) => {
      const link: Link = { conn, state: null, lastSeen: performance.now() };
      conn.on('open', () => {
        link.state = stateChannel(conn);
        link.state.onmessage = (e) => this.onHostStates(conn.peer, e.data as ArrayBuffer);
        this.watchTransport(link);
      });
      conn.on('data', (raw) => {
        link.lastSeen = performance.now();
        this.onHostMessage(conn.peer, link, raw as Message);
      });
      conn.on('close', () => this.disconnectPeer(conn.peer, link));
      conn.on('error', () => this.disconnectPeer(conn.peer, link));
    });
    // Relay tick + liveness check. TIMEOUT is deliberately longer than normal
    // browser background throttling; a timed-out peer still gets a reconnect grace.
    this.timers.push(
      window.setInterval(() => this.flushStates(), 1000 / STATE_HZ),
      window.setInterval(() => {
        const now = performance.now();
        for (const [id, l] of this.links) if (now - l.lastSeen > TIMEOUT) this.disconnectPeer(id, l);
      }, 1000),
    );
  }

  private onHostMessage(id: string, link: Link, msg: Message): void {
    switch (msg.t) {
      case 'hello': {
        const player = this.lobby.players.find((p) => p.id === id);
        if (player) {
          const current = this.links.get(id);
          if (current && current !== link) return this.reject(link.conn, '같은 참가자가 이미 연결되어 있습니다');
          const pending = this.pendingDrops.get(id);
          if (this.plan && pending === undefined) return this.reject(link.conn, '레이스가 이미 시작됐습니다');
          if (pending !== undefined) {
            clearTimeout(pending);
            this.pendingDrops.delete(id);
          }
          this.links.set(id, link);
          if (!this.plan) {
            player.name = cleanName(msg.name);
            player.team = this.freeTeam(msg.team, id);
          }
          this.sendTo(id, { t: 'lobby', state: this.lobby, you: id });
          this.voice.setPeers(this.lobby.players.map((p) => p.id));
          return;
        }
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

  /** Stop relaying now, but preserve the player/slot for a transient reconnect. */
  private disconnectPeer(id: string, expected: Link): void {
    if (this.links.get(id) !== expected) return;
    this.links.delete(id);
    expected.conn.close();
    this.voice.drop(id);
    if (this.pendingDrops.has(id)) return;
    const timer = window.setTimeout(() => this.dropPeer(id), RECONNECT_GRACE);
    this.pendingDrops.set(id, timer);
  }

  private dropPeer(id: string): void {
    const timer = this.pendingDrops.get(id);
    clearTimeout(timer);
    this.pendingDrops.delete(id);
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

  private connectToHost(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.openHostLink(resolve, reject);
    return promise;
  }

  private openHostLink(initialResolve?: () => void, initialReject?: (reason: Error) => void): void {
    if (this.closed) return;
    if (this.peer.disconnected) {
      if (!this.peer.destroyed) this.peer.reconnect();
      if (initialReject) {
        initialReject(new Error('시그널링 서버에 연결되지 않았습니다'));
        this.end('시그널링 서버에 연결되지 않았습니다');
      } else {
        this.scheduleReconnect(1000);
      }
      return;
    }

    const conn = this.peer.connect(ROOM_PREFIX + this.code, { serialization: 'json', reliable: true });
    const link: Link = { conn, state: null, lastSeen: performance.now() };
    this.hostLink = link;
    let accepted = false;
    let settled = false;
    const onPeerError = (e: { type?: string }) => {
      const reason = e.type === 'peer-unavailable' ? '방을 찾을 수 없습니다 (코드를 확인하세요)' : `연결 실패: ${e.type ?? 'unknown'}`;
      fail(reason, e.type === 'peer-unavailable');
    };
    const cleanup = () => this.peer.off('error', onPeerError);
    const fail = (reason: string, terminal = false) => {
      if (settled || this.hostLink !== link) return;
      settled = true;
      cleanup();
      conn.close();
      this.hostLink = null;
      if (!accepted && initialReject) {
        initialReject(new Error(reason));
        this.end(reason);
      } else if (terminal) {
        this.end(reason);
      } else {
        this.beginReconnect(reason);
      }
    };
    this.peer.on('error', onPeerError);
    conn.on('open', () => {
      link.state = stateChannel(conn);
      link.state.onmessage = (e) => {
        link.lastSeen = performance.now();
        this.onStates?.(decodeStates(e.data as ArrayBuffer));
      };
      this.watchTransport(link);
      conn.send({ t: 'hello', name: this.profileName, team: this.profileTeam } satisfies Message);
      this.startClock();
    });
    conn.on('data', (raw) => {
      if (this.hostLink !== link) return;
      link.lastSeen = performance.now();
      const msg = raw as Message;
      if (msg.t === 'lobby') {
        this.lobby = msg.state;
        this.myId = msg.you;
        this.voice.setPeers(msg.state.players.map((p) => p.id));
        if (!accepted) {
          accepted = true;
          settled = false;
          cleanup();
          this.reconnectAttempt = 0;
          this.reconnectStarted = 0;
          this.setConnection('connected', this.connectionDetail === '재연결 중…' ? '다시 연결됨' : this.connectionDetail);
          initialResolve?.();
        }
        this.onLobby?.(msg.state);
      } else if (msg.t === 'bye') {
        fail(msg.reason, true);
      } else {
        this.onClientMessage(msg);
      }
    });
    conn.on('close', () => fail('방장과 연결이 끊어졌습니다'));
    conn.on('error', () => fail('데이터 연결 오류'));
    const timeout = window.setTimeout(() => {
      if (!accepted) fail(initialReject ? '방에 연결하지 못했습니다 (시간 초과)' : '재연결 시간 초과');
    }, 20000);
    this.timers.push(timeout);
  }

  private beginReconnect(reason: string): void {
    if (this.closed) return;
    if (!this.reconnectStarted) this.reconnectStarted = performance.now();
    if (performance.now() - this.reconnectStarted >= RECONNECT_GRACE) {
      this.end(`${reason} (재연결 실패)`);
      return;
    }
    this.setConnection('reconnecting', '재연결 중…');
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt++, RECONNECT_DELAYS.length - 1)];
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    if (this.closed || this.isHost) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      this.openHostLink();
    }, delay);
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
    if (this.clockStarted) return;
    this.clockStarted = true;
    const ping = () => this.send({ t: 'ping', a: performance.now() });
    for (let i = 0; i < 6; i++) this.timers.push(window.setTimeout(ping, i * 150));
    this.timers.push(
      window.setInterval(ping, 1000),
      window.setInterval(() => {
        const link = this.hostLink;
        if (link && performance.now() - link.lastSeen > TIMEOUT) {
          link.conn.close();
          this.beginReconnect('방장의 응답이 없습니다');
        }
      }, 1000),
    );
  }

  private send(msg: Message): void {
    if (this.hostLink?.conn.open) this.hostLink.conn.send(msg);
  }

  private watchTransport(link: Link): void {
    const pc = link.conn.peerConnection;
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') void this.describeTransport(link);
      else if (!this.isHost && this.hostLink === link && pc.connectionState === 'failed') {
        link.conn.close();
      }
    });
    if (pc.connectionState === 'connected') void this.describeTransport(link);
  }

  private async describeTransport(link: Link): Promise<void> {
    if (this.isHost || this.hostLink !== link) return;
    const stats = await link.conn.peerConnection.getStats();
    let detail = '연결됨';
    for (const report of stats.values()) {
      if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || (!report.nominated && report.nominated !== undefined)) continue;
      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);
      detail = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN 릴레이 연결' : '직접 연결';
      if (Number.isFinite(report.currentRoundTripTime)) detail += ` · ${Math.round(report.currentRoundTripTime * 1000)} ms`;
      break;
    }
    this.setConnection('connected', detail);
  }

  private setConnection(state: ConnectionState, detail: string): void {
    this.connectionState = state;
    this.connectionDetail = detail;
    this.onConnection?.(state, detail);
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.voice.stop();
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    clearTimeout(this.reconnectTimer);
    this.onEnd?.(reason);
    setTimeout(() => this.peer.destroy(), 200);
  }
}

export const TEAM_IDS = F1_TEAMS;

function openPeer(id?: string): Promise<Peer> {
  const { promise, resolve, reject } = Promise.withResolvers<Peer>();
  const configuredTurn = import.meta.env.VITE_TURN_URLS as string | undefined;
  const turnUrls = configuredTurn
    ?.split(',')
    .map((url: string) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (turnUrls?.length) {
    iceServers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  }
  const options = { debug: 1, config: { iceServers, sdpSemantics: 'unified-plan' as const } };
  const peer = id ? new Peer(id, options) : new Peer(options);
  const onError = (e: unknown) => {
    peer.destroy();
    reject(e);
  };
  peer.once('open', () => {
    peer.off('error', onError);
    resolve(peer);
  });
  peer.once('error', onError);
  return promise;
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
