import type { Fingerprint, PartyMedia, PartyParticipant, PartyRoom } from '../data/socialApi';
import {
  encodeClientMessage, FINAL_CLOSE_CODES, parseServerMessage, type ChatLine, type ClientMsg, type ServerMsg, type You,
} from './protocol';
import { ClockEstimator, type PlaybackState } from './sync';

/* Client du protocole d'un salon : connexion WebSocket, horloge serveur (ping/pong), état, reconnexion automatique avec
 * reprise (le `welcome` renvoie l'état, les participants et le chat), envoi des commandes. Aucune dépendance au
 * navigateur : le socket, l'horloge et les minuteurs sont injectés (testé avec un faux socket). */

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type ClientStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export type EndReason = 'ended' | 'kicked' | 'replaced' | 'full' | 'closed' | 'failed';

export interface ClientDeps {
  /** Ouvre une connexion neuve (nouveau ticket à chaque appel : il ne vaut que 60 s). */
  connect(): Promise<SocketLike>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface ClientEvents {
  welcome: ServerMsg & { t: 'welcome' };
  state: PlaybackState;
  media: { media: PartyMedia; fingerprint: Fingerprint | null; state: PlaybackState };
  participants: PartyParticipant[];
  chat: ChatLine;
  react: { user: string; emoji: string; at: number };
  host: string;
  muted: { user: string; muted: boolean };
  reported: { by?: string; against?: string; text?: string };
  removed: { messageId: string };
  error: string;
  status: ClientStatus;
  end: EndReason;
}

type Handler<K extends keyof ClientEvents> = (payload: ClientEvents[K]) => void;

export const PING_BURST = 5;
export const PING_BURST_MS = 250;
export const PING_EVERY_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15_000] as const;

export class PartyClient {
  status: ClientStatus = 'idle';
  room: PartyRoom | null = null;
  you: You | null = null;
  state: PlaybackState | null = null;
  participants: PartyParticipant[] = [];
  chat: ChatLine[] = [];
  readonly clock = new ClockEstimator();
  /** Nombre de reconnexions réussies (reprise après coupure). */
  resumes = 0;

  private socket: SocketLike | null = null;
  private handlers: { [K in keyof ClientEvents]?: Array<Handler<K>> } = {};
  private attempt = 0;
  private timers = new Set<unknown>();
  private pongTimer: unknown = null;
  private closedByUs = false;
  private everOpen = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly deps: ClientDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  on<K extends keyof ClientEvents>(event: K, fn: Handler<K>): () => void {
    const list = (this.handlers[event] ??= []) as Array<Handler<K>>;
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const fn of [...((this.handlers[event] ?? []) as Array<Handler<K>>)]) {
      try { fn(payload); } catch { /* un écouteur ne casse pas le client */ }
    }
  }

  private setStatus(s: ClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  /** Instant serveur estimé (ms). */
  serverNow(): number {
    return this.now() + this.clock.offset;
  }

  get isHost(): boolean {
    return !!this.you?.host;
  }

  // ---- Connexion ----
  start(): void {
    if (this.status !== 'idle') return;
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    this.setStatus(this.everOpen ? 'reconnecting' : 'connecting');
    this.deps.connect().then((socket) => {
      if (this.closedByUs) { try { socket.close(1000); } catch { /* ignoré */ } return; }
      this.bind(socket);
    }, () => this.scheduleReconnect());
  }

  private bind(socket: SocketLike): void {
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      if (this.everOpen) this.resumes += 1;
      this.everOpen = true;
      this.setStatus('open');
      this.pingBurst();
    };
    socket.onmessage = (ev) => this.onFrame(ev.data);
    socket.onerror = () => { /* la fermeture suit */ };
    socket.onclose = (ev) => this.onClose(socket, ev.code ?? 1006);
    // Un socket déjà ouvert à la livraison (faux sockets, connexion rapide) : onopen ne viendra pas.
    if ((socket as { readyState?: number }).readyState === 1) socket.onopen?.();
  }

  private onClose(socket: SocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopTimers();
    if (this.closedByUs) return;
    const final = FINAL_CLOSE_CODES[code];
    if (final) { this.finish(final); return; }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return;
    this.setStatus('reconnecting');
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    const id = this.setTimer(() => { this.timers.delete(id); if (!this.closedByUs) this.open(); }, delay);
    this.timers.add(id);
  }

  private finish(reason: EndReason): void {
    this.closedByUs = true;
    this.stopTimers();
    this.setStatus('closed');
    this.emit('end', reason);
  }

  /** Quitte le salon (fermeture normale, sans reconnexion). */
  close(): void {
    this.closedByUs = true;
    this.stopTimers();
    const s = this.socket;
    this.socket = null;
    if (s) { try { s.close(1000); } catch { /* ignoré */ } }
    this.setStatus('closed');
  }

  private stopTimers(): void {
    for (const id of this.timers) this.clearTimer(id);
    this.timers.clear();
    if (this.pongTimer !== null) { this.clearTimer(this.pongTimer); this.pongTimer = null; }
  }

  // ---- Horloge ----
  private pingBurst(): void {
    for (let i = 0; i < PING_BURST; i++) {
      const id = this.setTimer(() => { this.timers.delete(id); this.sendPing(); }, i * PING_BURST_MS);
      this.timers.add(id);
    }
    this.armKeepalive();
  }

  private armKeepalive(): void {
    const id = this.setTimer(() => { this.timers.delete(id); this.sendPing(); this.armKeepalive(); }, PING_EVERY_MS);
    this.timers.add(id);
  }

  private sendPing(): void {
    if (this.status !== 'open') return;
    this.raw({ t: 'ping', c: this.now() });
    if (this.pongTimer === null) {
      // Pas de réponse : la connexion est morte sans fermeture visible, on la relance.
      const socket = this.socket;
      this.pongTimer = this.setTimer(() => {
        this.pongTimer = null;
        if (socket && this.socket === socket) {
          this.socket = null;
          try { socket.close(); } catch { /* ignoré */ }
          this.stopTimers();
          this.scheduleReconnect();
        }
      }, PONG_TIMEOUT_MS);
    }
  }

  // ---- Réception ----
  private onFrame(data: unknown): void {
    const msg = parseServerMessage(data);
    if (!msg) return;
    switch (msg.t) {
      case 'welcome':
        this.room = msg.room;
        this.you = msg.you;
        this.participants = msg.participants;
        this.chat = msg.chat ?? [];
        this.state = msg.state;
        this.emit('welcome', msg);
        this.emit('participants', this.participants);
        this.emit('state', msg.state);
        break;
      case 'pong': {
        if (this.pongTimer !== null) { this.clearTimer(this.pongTimer); this.pongTimer = null; }
        this.clock.add(msg.c, this.now(), msg.s);
        break;
      }
      case 'state':
        this.state = msg.state;
        this.emit('state', msg.state);
        break;
      case 'media':
        if (this.room) this.room = { ...this.room, media: msg.media, fingerprint: msg.fingerprint ?? null };
        this.state = msg.state;
        this.emit('media', { media: msg.media, fingerprint: msg.fingerprint ?? null, state: msg.state });
        this.emit('state', msg.state);
        break;
      case 'join':
        this.participants = [...this.participants.filter((p) => p.username !== msg.participant.username), msg.participant];
        this.emit('participants', this.participants);
        break;
      case 'leave':
        this.participants = this.participants.filter((p) => p.username !== msg.user);
        this.emit('participants', this.participants);
        break;
      case 'chat':
        if (!this.chat.some((l) => l.id === msg.line.id)) this.chat = [...this.chat, msg.line].slice(-200);
        this.emit('chat', msg.line);
        break;
      case 'react':
        this.emit('react', { user: msg.user, emoji: msg.emoji, at: msg.at });
        break;
      case 'muted':
        this.participants = this.participants.map((p) => (p.username === msg.user ? { ...p, muted: msg.muted } : p));
        if (this.you && this.you.username === msg.user) this.you = { ...this.you, muted: msg.muted };
        this.emit('muted', { user: msg.user, muted: msg.muted });
        this.emit('participants', this.participants);
        break;
      case 'host':
        this.participants = this.participants.map((p) => ({ ...p, host: p.username === msg.user }));
        if (this.you) this.you = { ...this.you, host: this.you.username === msg.user };
        if (this.room) this.room = { ...this.room, host: msg.user };
        this.emit('host', msg.user);
        this.emit('participants', this.participants);
        break;
      case 'reported':
        this.emit('reported', { by: msg.by, against: msg.against, text: msg.text });
        break;
      case 'removed':
        // Message retiré par la modération : il disparaît du chat.
        this.chat = this.chat.filter((l) => l.id !== msg.messageId);
        this.emit('removed', { messageId: msg.messageId });
        break;
      case 'error':
        this.emit('error', msg.code);
        break;
      case 'ended':
        this.finish('ended');
        break;
      default:
        break;
    }
  }

  // ---- Envoi ----
  private raw(msg: ClientMsg): boolean {
    const s = this.socket;
    if (!s || this.status !== 'open') return false;
    const frame = encodeClientMessage(msg);
    if (!frame) return false;
    try { s.send(frame); } catch { return false; }
    return true;
  }

  requestSync(): boolean { return this.raw({ t: 'sync' }); }
  /**
   * Commande de lecture : `play`, `pause`, `seek` (lecture partagée, tout participant) ou `sync` (rapport de position de
   * l'hôte, horloge de référence).
   */
  control(action: 'play' | 'pause' | 'seek' | 'sync', pos: number): boolean {
    if (action === 'sync' && !this.isHost) return false;
    return this.raw({ t: 'ctl', action, pos: Math.max(0, Math.round(pos * 1000) / 1000) });
  }
  changeEpisode(season: number, episode: number, fingerprint?: Fingerprint): boolean {
    return this.isHost && this.raw({ t: 'episode', season, episode, ...(fingerprint ? { fingerprint } : {}) });
  }
  sendChat(text: string): boolean {
    const t = text.trim().slice(0, 500);
    return t ? this.raw({ t: 'chat', text: t }) : false;
  }
  react(emoji: string): boolean { return this.raw({ t: 'react', emoji }); }
  report(messageId: string, reason?: string): boolean { return this.raw({ t: 'report', messageId, ...(reason ? { reason } : {}) }); }
  mute(user: string, muted: boolean): boolean { return this.isHost && this.raw({ t: 'mute', user, muted }); }
  kick(user: string): boolean { return this.isHost && this.raw({ t: 'kick', user }); }
  transfer(user: string): boolean { return this.isHost && this.raw({ t: 'transfer', user }); }
  endRoom(): boolean { return this.isHost && this.raw({ t: 'end' }); }
}
