import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import {
  decodeStates,
  encodeStates,
  joinRecords,
  MAX_CARS,
  MAX_LAPS,
  packetRecords,
  randomCode,
  ROOM_PREFIX,
  STATE_HZ,
  type CarState,
  type GridSlot,
  type LobbyPlayer,
  type LobbySettings,
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
/** JavaScript timers are commonly suspended in background/mobile tabs. */
const TIMEOUT = 45000;
/** Keep a disconnected player's slot while a transient network failure reconnects. */
const RECONNECT_GRACE = 60000;
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000] as const;
/** Host starts anyway if someone takes longer than this (ms) to load the race. */
const LOAD_TIMEOUT = 30000;
/** Time between "go" and the green light (ms): the start-light countdown plus slack. */
const GO_LEAD = 5000;
/** One broker registration attempt (ms), and how many are tried. */
const OPEN_TIMEOUT = 7000;
const OPEN_ATTEMPTS = 3;
/** One attempt at reaching the host (ms), and how many are tried before the join fails. */
const JOIN_TIMEOUT = 9000;
const JOIN_ATTEMPTS = 3;
/** PeerJS error types a retry can never fix. */
const FATAL_PEER_ERRORS: Record<string, true> = { 'browser-incompatible': true, 'invalid-id': true, 'invalid-key': true, 'ssl-unavailable': true, 'unavailable-id': true };

interface Link {
  conn: DataConnection;
  state: RTCDataChannel | null;
  lastSeen: number;
}

export type ConnectionState = 'connected' | 'reconnecting';
/** Progress text while a room is being opened or joined (shown in the lobby). */
export type Progress = (text: string) => void;

export class Room {
  lobby: LobbyState = { players: [], laps: 3, aiFill: true, trackId: 'monza', control: 'keyboard', weather: 'clear', time: 'day', tyre: 'medium' };
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
  private onProgress: Progress = () => {};
  /** Resolver of the initial join, while it is still being retried. */
  private joinSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private joinAttempt = 0;
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
  static async create(name: string, team: string, onProgress: Progress = () => {}): Promise<Room> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      try {
        const peer = await openPeer(ROOM_PREFIX + code, onProgress);
        const room = new Room(peer, true, code);
        room.lobby.players.push({ id: peer.id, name: cleanName(name), team, host: true, connected: true });
        room.listenAsHost();
        return room;
      } catch (e) {
        if (errorType(e) !== 'unavailable-id') throw e;
      }
    }
    throw new Error('방 코드를 만들지 못했습니다');
  }

  /** Joins an existing room by code; resolves when the host has accepted us. */
  static async join(code: string, name: string, team: string, onProgress: Progress = () => {}): Promise<Room> {
    const peer = await openPeer(undefined, onProgress);
    const room = new Room(peer, false, code.toUpperCase());
    room.profileName = cleanName(name);
    room.profileTeam = team;
    room.onProgress = onProgress;
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

  /** Host: race settings. Conditions are part of them, so the whole grid shares them. */
  setSettings(patch: Partial<LobbySettings>): void {
    if (!this.isHost) return;
    if (patch.laps !== undefined) patch = { ...patch, laps: Math.min(MAX_LAPS, Math.max(1, Math.round(patch.laps) || 1)) };
    Object.assign(this.lobby, patch);
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
    const { trackId, laps, control, weather, time, tyre } = this.lobby;
    const plan: RacePlan = { trackId, laps, control, weather, time, tyre, slots };
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
          player.connected = true;
          this.broadcastLobby();
          return;
        }
        if (this.plan) return this.reject(link.conn, '레이스가 이미 시작됐습니다');
        if (this.lobby.players.length >= MAX_CARS && !this.freeReservedSlot()) {
          return this.reject(link.conn, `방이 가득 찼습니다 (최대 ${MAX_CARS}명)`);
        }
        this.links.set(id, link);
        this.lobby.players.push({ id, name: cleanName(msg.name), team: this.freeTeam(msg.team, id), host: false, connected: true });
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
    const player = this.lobby.players.find((p) => p.id === id);
    if (player) player.connected = false;
    if (!this.plan) this.broadcastLobby();
  }

  /**
   * The room is full, but some of the slots are only held for players whose
   * connection dropped. Give up the oldest reservation so a friend who is
   * actually here can take the twentieth seat.
   */
  private freeReservedSlot(): boolean {
    const oldest = this.pendingDrops.keys().next();
    if (oldest.done) return false;
    this.dropPeer(oldest.value);
    return true;
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
    // A reserved slot has nobody on the other end: no voice call for it.
    this.voice.setPeers(this.lobby.players.filter((p) => p.connected).map((p) => p.id));
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
    this.joinSettle = { resolve, reject };
    this.joinAttempt = 1;
    this.openHostLink();
    return promise;
  }

  /**
   * The first attempt often fails for reasons that pass: the host's broker
   * socket is being re-registered (peer-unavailable), or ICE took longer than
   * the attempt window. Try again a couple of times before telling the player
   * the room is unreachable.
   */
  private joinFailed(reason: string, terminal: boolean): void {
    const settle = this.joinSettle;
    if (!settle) return;
    if (!terminal && this.joinAttempt < JOIN_ATTEMPTS) {
      this.joinAttempt++;
      this.onProgress(`방에 연결하는 중… (${this.joinAttempt}/${JOIN_ATTEMPTS})`);
      this.timers.push(window.setTimeout(() => this.openHostLink(), 700));
      return;
    }
    this.joinSettle = null;
    settle.reject(new Error(terminal || hasTurn() ? reason : `${reason} · 직접 연결이 막힌 망일 수 있습니다 (TURN 설정 필요)`));
    this.end(reason);
  }

  private openHostLink(): void {
    if (this.closed) return;
    if (this.peer.disconnected) {
      if (!this.peer.destroyed) this.peer.reconnect();
      if (this.joinSettle) this.joinFailed('시그널링 서버에 연결되지 않았습니다', false);
      else this.scheduleReconnect(1000);
      return;
    }

    const conn = this.peer.connect(ROOM_PREFIX + this.code, { serialization: 'json', reliable: true });
    const link: Link = { conn, state: null, lastSeen: performance.now() };
    this.hostLink = link;
    let accepted = false;
    let settled = false;
    const onPeerError = (e: unknown) => {
      const type = errorType(e);
      fail(type === 'peer-unavailable' ? '방을 찾을 수 없습니다 (코드를 확인하세요)' : `연결 실패: ${type || 'unknown'}`);
    };
    const cleanup = () => this.peer.off('error', onPeerError);
    const fail = (reason: string, terminal = false) => {
      if (settled || this.hostLink !== link) return;
      settled = true;
      cleanup();
      conn.close();
      this.hostLink = null;
      if (!accepted && this.joinSettle) {
        this.joinFailed(reason, terminal);
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
        this.voice.setPeers(msg.state.players.filter((p) => p.connected).map((p) => p.id));
        if (!accepted) {
          accepted = true;
          settled = false;
          cleanup();
          this.reconnectAttempt = 0;
          this.reconnectStarted = 0;
          this.setConnection('connected', this.connectionDetail === '재연결 중…' ? '다시 연결됨' : this.connectionDetail);
          const settle = this.joinSettle;
          this.joinSettle = null;
          settle?.resolve();
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
    const joining = this.joinSettle !== null;
    const timeout = window.setTimeout(() => {
      if (!accepted) fail(joining ? '방에 연결하지 못했습니다 (시간 초과)' : '재연결 시간 초과');
    }, joining ? JOIN_TIMEOUT : 20000);
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

/** PeerJS tags its errors with a `type`; anything else is a plain Error. */
function errorType(e: unknown): string {
  return e !== null && typeof e === 'object' && 'type' in e && typeof e.type === 'string' ? e.type : '';
}

function turnUrls(): string[] {
  const configured = import.meta.env.VITE_TURN_URLS as string | undefined;
  return (
    configured
      ?.split(',')
      .map((url: string) => url.trim())
      .filter(Boolean) ?? []
  );
}

/** Without a TURN account, players behind CGNAT / company networks cannot connect at all. */
function hasTurn(): boolean {
  return turnUrls().length > 0;
}

function peerOptions(): PeerOptions {
  const iceServers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  const turn = turnUrls();
  if (turn.length) {
    iceServers.push({ urls: turn, username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL });
  }
  // Gather candidates while the offer is still being written: the handshake starts a round earlier.
  const options: PeerOptions = { debug: 1, config: { iceServers, iceCandidatePoolSize: 4, sdpSemantics: 'unified-plan' } };
  // Self-hosted PeerServer (the public cloud broker is shared and often slow).
  const host = import.meta.env.VITE_PEER_HOST as string | undefined;
  if (host) {
    const port = Number(import.meta.env.VITE_PEER_PORT ?? 443);
    options.host = host;
    options.port = port;
    options.path = (import.meta.env.VITE_PEER_PATH as string | undefined) ?? '/';
    options.secure = port === 443;
    const key = import.meta.env.VITE_PEER_KEY as string | undefined;
    if (key) options.key = key;
  }
  return options;
}

/** One broker registration: resolves when the id is live, rejects on error or timeout. */
function openPeerOnce(id: string | undefined, timeout: number): Promise<Peer> {
  const { promise, resolve, reject } = Promise.withResolvers<Peer>();
  const options = peerOptions();
  const peer = id ? new Peer(id, options) : new Peer(options);
  let settled = false;
  let timer = 0;
  const finish = (ok: Peer | null, error?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    peer.off('open', onOpen);
    peer.off('error', onError);
    if (ok) {
      resolve(ok);
      return;
    }
    peer.destroy();
    reject(error);
  };
  const onOpen = () => finish(peer);
  const onError = (e: unknown) => finish(null, e);
  timer = window.setTimeout(() => finish(null, { type: 'timeout', message: '시그널링 서버가 응답하지 않습니다' }), timeout);
  peer.on('open', onOpen);
  peer.on('error', onError);
  return promise;
}

/**
 * Registers on the signalling broker. The free public PeerJS cloud regularly
 * takes many seconds (or never answers) and PeerJS has no timeout of its own,
 * which is what used to leave an invite hanging: give an attempt OPEN_TIMEOUT
 * and start a fresh one instead of waiting forever.
 */
async function openPeer(id: string | undefined, onProgress: Progress): Promise<Peer> {
  let last: unknown = new Error('시그널링 서버에 연결하지 못했습니다');
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    onProgress(attempt === 1 ? '시그널링 서버에 연결하는 중…' : `시그널링 서버 재시도 ${attempt}/${OPEN_ATTEMPTS}…`);
    try {
      return await openPeerOnce(id, OPEN_TIMEOUT);
    } catch (e) {
      last = e;
      if (FATAL_PEER_ERRORS[errorType(e)]) throw e;
      const { promise: wait, resolve: go } = Promise.withResolvers<void>();
      setTimeout(go, 300 * attempt);
      await wait;
    }
  }
  throw last;
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
