import type { Fingerprint, PartyMedia, PartyParticipant, PartyRoom } from '../data/socialApi';
import {
  CHAT_MAX, COUNTDOWN_DEFAULT_SEC, DEFAULT_SETTINGS, encodeClientMessage, FINAL_CLOSE_CODES, MAX_FRAME_BYTES, PARTY_BUF_AHEAD_MAX_SEC, PARTY_RESUME_AHEAD_SEC,
  parseRtcFrame, parseServerMessage, REACTIONS,
  type ChatLine, type ClientMsg, type EventKind, type PartySettings, type PrepStatus, type ServerMsg, type VoteInput, type VoteView, type You,
} from './protocol';
import { ClockEstimator, type PlaybackState } from './sync';

/* Constantes d'attente de tampon, miroirs du serveur (réexportées pour les écrans et les tests). */
export { PARTY_RESUME_AHEAD_SEC, PARTY_WAIT_MAX_MS } from './protocol';

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
export type EndReason = 'ended' | 'expired' | 'kicked' | 'banned' | 'replaced' | 'full' | 'name_taken' | 'name_changed' | 'closed' | 'failed';

export interface ClientDeps {
  /** Ouvre une connexion neuve (nouveau ticket à chaque appel : il ne vaut que 60 s). */
  connect(): Promise<SocketLike>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** Attente de tampon en cours : retardataires (pseudos), début (ms serveur), délai maximal et avance de reprise (s). */
export interface PartyWait {
  who: string[];
  since: number;
  maxMs: number;
  resumeAhead: number;
}

export interface ClientEvents {
  welcome: ServerMsg & { t: 'welcome' };
  state: PlaybackState;
  media: { media: PartyMedia; fingerprint: Fingerprint | null; state: PlaybackState };
  participants: PartyParticipant[];
  /** Ligne de chat : une ligne de l'historique reçue à la (re)connexion, ou une nouvelle ligne. */
  chat: ChatLine;
  /** Attente de tampon ouverte ou mise à jour (`PartyWait`), ou fermée (`null`). */
  wait: PartyWait | null;
  /** Réaction : `by` = auteur (identique à `user` sur un serveur antérieur), `pos` = position du film si connue. */
  react: { user: string; by: string; emoji: string; at: number; pos: number | null };
  settings: PartySettings;
  /** Compte à rebours de départ : instant serveur (ms) de reprise, ou null (annulé / terminé). */
  countdown: number | null;
  /** Vote du titre : options avec leurs voix, ou null à la fermeture. */
  vote: VoteView[] | null;
  /** Événement lisible (pause, reprise, saut, arrivée, départ). */
  event: { kind: EventKind; by: string; pos: number; delta?: number };
  host: string;
  muted: { user: string; muted: boolean };
  reported: { by?: string; against?: string; text?: string };
  removed: { messageId: string };
  /** Le lien d'invitation a été renouvelé par le salon (exclusion d'un invité du lien partagé) : hôte seulement. */
  linkRenewed: Record<string, never>;
  /** Signalisation WebRTC relayée par le salon (partage de lecture), `from` = identifiant de pair de l'émetteur. */
  rtc: { from: string; data: unknown };
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
/** Lignes de chat gardées en mémoire (l'historique reçu à la connexion compris). */
export const CHAT_MEMORY_LINES = 200;

/** Champ `pos` d'un message de chat ou de réaction : présent seulement pour une position valide. */
const posField = (pos: number | null | undefined): { pos?: number } =>
  typeof pos === 'number' && Number.isFinite(pos) && pos >= 0 ? { pos: Math.round(pos * 10) / 10 } : {};

export class PartyClient {
  status: ClientStatus = 'idle';
  room: PartyRoom | null = null;
  you: You | null = null;
  state: PlaybackState | null = null;
  participants: PartyParticipant[] = [];
  chat: ChatLine[] = [];
  /** Attente de tampon en cours (null hors attente). */
  waiting: PartyWait | null = null;
  /** Réglages du salon (défauts d'un serveur antérieur). */
  settings: PartySettings = { ...DEFAULT_SETTINGS };
  /** Le serveur annonce les capacités v3 (le welcome porte `settings`). */
  v3 = false;
  /** Départ programmé (instant serveur, ms), null hors compte à rebours. */
  countdownAt: number | null = null;
  /** Vote du titre ouvert (options et voix), null hors vote. */
  vote: VoteView[] | null = null;
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
    this.setWaiting(null);
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
    this.setWaiting(null);
  }

  /** Met à jour l'attente de tampon et l'annonce ; sans effet si elle reste absente. */
  private setWaiting(next: PartyWait | null): void {
    if (next === null && this.waiting === null) return;
    this.waiting = next;
    this.emit('wait', next);
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
    if (!msg) {
      const rtc = parseRtcFrame(data);
      if (rtc) this.emit('rtc', rtc);
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        // Historique : les lignes déjà connues ne sont pas réémises. Une attente en cours, si elle existe, est renvoyée par le serveur.
        const known = new Set(this.chat.map((l) => l.id));
        this.room = msg.room;
        this.you = msg.you;
        this.participants = msg.participants;
        this.chat = (msg.chat ?? []).slice(-CHAT_MEMORY_LINES);
        this.state = msg.state;
        this.settings = { ...DEFAULT_SETTINGS, ...(msg.settings ?? {}) };
        this.v3 = msg.settings !== undefined && msg.settings !== null;
        this.countdownAt = typeof msg.countdownAt === 'number' ? msg.countdownAt : null;
        this.vote = Array.isArray(msg.vote) ? msg.vote : null;
        this.setWaiting(null);
        this.emit('welcome', msg);
        this.emit('participants', this.participants);
        this.emit('state', msg.state);
        for (const line of this.chat) if (!known.has(line.id)) this.emit('chat', line);
        break;
      }
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
        if (!this.chat.some((l) => l.id === msg.line.id)) {
          this.chat = [...this.chat, msg.line].slice(-CHAT_MEMORY_LINES);
          this.emit('chat', msg.line);
        }
        break;
      case 'wait': {
        const who = Array.isArray(msg.who) ? msg.who.filter((w): w is string => typeof w === 'string') : [];
        this.setWaiting(who.length === 0 ? null : {
          who,
          since: msg.since,
          maxMs: msg.maxMs,
          resumeAhead: typeof msg.resumeAhead === 'number' && Number.isFinite(msg.resumeAhead) ? msg.resumeAhead : PARTY_RESUME_AHEAD_SEC,
        });
        break;
      }
      case 'react':
        this.emit('react', { user: msg.user, by: typeof msg.by === 'string' ? msg.by : msg.user, emoji: msg.emoji, at: msg.at, pos: typeof msg.pos === 'number' ? msg.pos : null });
        break;
      case 'settings':
        this.settings = { ...DEFAULT_SETTINGS, ...(msg.settings ?? {}) };
        this.emit('settings', this.settings);
        break;
      case 'prep':
        this.participants = this.participants.map((p) => (p.username === msg.user ? { ...p, ready: msg.ready, quality: msg.quality, status: msg.status } : p));
        this.emit('participants', this.participants);
        break;
      case 'countdown':
        this.countdownAt = typeof msg.at === 'number' ? msg.at : null;
        this.emit('countdown', this.countdownAt);
        break;
      case 'vote':
        this.vote = msg.open && Array.isArray(msg.options) ? msg.options : null;
        this.emit('vote', this.vote);
        break;
      case 'event':
        this.emit('event', { kind: msg.kind, by: msg.by, pos: msg.pos, ...(typeof msg.delta === 'number' ? { delta: msg.delta } : {}) });
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
      case 'link_renewed':
        this.emit('linkRenewed', {});
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
  /**
   * Message du chat : espaces retirés, CHAT_MAX caractères au plus ; vide = rien n'est envoyé. `pos` : position du film (s),
   * jointe seulement si elle est connue (un serveur antérieur ne la lit pas).
   */
  sendChat(text: string, pos?: number | null): boolean {
    const t = text.trim().slice(0, CHAT_MAX);
    return t ? this.raw({ t: 'chat', text: t, ...posField(pos) }) : false;
  }
  /** Réaction : emoji de la liste du salon uniquement ; false sinon ou hors ligne. */
  sendReact(emoji: string, pos?: number | null): boolean {
    return (REACTIONS as readonly string[]).includes(emoji) && this.raw({ t: 'react', emoji, ...posField(pos) });
  }
  /** Alias de `sendReact` (appels existants). */
  react(emoji: string, pos?: number | null): boolean { return this.sendReact(emoji, pos); }
  /** Réglages du salon (hôte seul) : seuls les champs donnés changent. */
  sendSettings(patch: Partial<PartySettings>): boolean {
    if (!this.isHost) return false;
    const msg: ClientMsg = { t: 'settings' };
    if (patch.control) msg.control = patch.control;
    if (patch.waitLate) msg.waitLate = patch.waitLate;
    if (patch.reactions) msg.reactions = patch.reactions;
    return Object.keys(msg).length > 1 && this.raw(msg);
  }
  /** Préparation : prêt à lire (et qualité de la source choisie, ou null). */
  sendReady(ready: boolean, quality: string | null = null): boolean { return this.v3 && this.raw({ t: 'ready', ready, quality }); }
  /** État de recherche de source : cherche, prêt ou en tampon. */
  sendStatus(status: PrepStatus): boolean { return this.v3 && this.raw({ t: 'status', status }); }
  /** Départ (hôte seul) : la lecture reprend après `countdown` secondes (1 à 10). */
  startPlayback(countdown: number = COUNTDOWN_DEFAULT_SEC): boolean {
    return this.isHost && this.raw({ t: 'start', countdown: Math.min(10, Math.max(1, Math.round(countdown))) });
  }
  /** Vote du titre : l'hôte l'ouvre (2 à 6 options) et le ferme ; chacun choisit une option. */
  openVote(options: readonly VoteInput[]): boolean { return this.isHost && this.raw({ t: 'vote_open', options: [...options] }); }
  castVote(optionId: string): boolean { return this.raw({ t: 'vote', optionId }); }
  closeVote(): boolean { return this.isHost && this.raw({ t: 'vote_close' }); }
  /**
   * Tampon local, envoyé au salon : `ready` = assez d'avance pour lire, `ahead` = secondes de tampon devant la position
   * (ramenées à 0..PARTY_BUF_AHEAD_MAX_SEC). Le salon retient la lecture tant qu'un participant n'est pas prêt.
   */
  sendBuffering(ready: boolean, ahead: number): boolean {
    const a = Number.isFinite(ahead) ? Math.min(PARTY_BUF_AHEAD_MAX_SEC, Math.max(0, ahead)) : 0;
    return this.raw({ t: 'buf', ready: !!ready, ahead: a });
  }
  report(messageId: string, reason?: string): boolean { return this.raw({ t: 'report', messageId, ...(reason ? { reason } : {}) }); }
  mute(user: string, muted: boolean): boolean { return this.isHost && this.raw({ t: 'mute', user, muted }); }
  kick(user: string): boolean { return this.isHost && this.raw({ t: 'kick', user }); }
  transfer(user: string): boolean { return this.isHost && this.raw({ t: 'transfer', user }); }
  endRoom(): boolean { return this.isHost && this.raw({ t: 'end' }); }

  /** Signalisation WebRTC vers un pair du salon (relayée par le serveur). False si hors ligne ou trame trop grande. */
  sendRtc(to: string, data: unknown): boolean {
    const s = this.socket;
    if (!s || this.status !== 'open') return false;
    const frame = JSON.stringify({ type: 'rtc', to, data });
    if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES) return false;
    try { s.send(frame); } catch { return false; }
    return true;
  }
}
