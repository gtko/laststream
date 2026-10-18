/* Partage de lecture dans un salon, de bout en bout.
 *  - Hôte : `HostRelaySession` branche un RelayHost sur le WebSocket du salon (signalisation `rtc` relayée par le serveur) et
 *    sert la source de plages de l'hôte aux invités (`guest:true`) qui le demandent. La source est lue sur l'appareil de
 *    l'hôte : aucune URL n'entre ici, ni dans les états ni dans les journaux.
 *  - Invité : `GuestRelaySession` ouvre le WebSocket du salon avec son lien d'invitation, trouve le pair de l'hôte parmi les
 *    participants `host:true`, établit le DataChannel, lit les plages (RangeClient) et les donne au lecteur (GuestPlayer).
 *    Les actions locales (play, pause, seek) partent vers le salon ; l'état du salon est appliqué au lecteur sans écho.
 * Le client de salon, le lecteur et les connexions WebRTC sont injectés (tests). Aucun secret : la clé TURN, si elle existe,
 * est injectée par `setRelayTurn`. */

import { PartyClient, type ClientStatus, type SocketLike } from '../party/client';
import type { PartyParticipant } from '../data/socialApi';
import { endText, hostLostText, refusedText, relayErrorText, waitingHostText } from '../party/join';
import { RangeClient } from './guest';
import { RelayGuest, RelayHost, buildIceServers, type PeerOptions, type RelaySignal, type SignalTransport, type TurnConfig } from './peer';
import type { RangeSource, UploadStats } from './host';
import { RelayError, type ChannelLike } from './protocol';
import type { PlaybackPlan, PlayerCallbacks, PlayerState, RangeReader, RoomState } from './player/types';

let relayTurn: TurnConfig | null = null;

/** Délai avant une nouvelle tentative quand l'hôte ne lit pas encore (pas de partage en cours). */
const RETRY_HOST_MS = 4000;
/** Délai de connexion à l'hôte côté invité (une poignée de main RTC dure quelques secondes). */
const CONNECT_MS = 10_000;
/** Après une action locale, on attend l'écho du salon avant de recaler le lecteur (sinon l'état périmé la défait). */
const ECHO_WAIT_MS = 1500;

/** TURN facultatif, injecté par l'application (jamais en dur dans le code). `null` : STUN seul. */
export function setRelayTurn(turn: TurnConfig | null): void {
  relayTurn = turn;
}

/** Signalisation pair à pair relayée par le WebSocket du salon : `{type:'rtc',to,data}` en émission, `from` en réception. */
export function partySignal(client: Pick<PartyClient, 'sendRtc' | 'on'>): SignalTransport {
  return {
    send(to: string, data: RelaySignal): void {
      client.sendRtc(to, data);
    },
    onMessage(cb: (from: string, data: unknown) => void): () => void {
      return client.on('rtc', (m) => cb(m.from, m.data));
    },
  };
}

// ---- Hôte ----------------------------------------------------------------------------------------------

export interface RelayStats {
  /** Invités présents dans le salon (participants `guest:true`). */
  guests: number;
  /** Liaisons ouvertes (invités en cours de connexion ou connectés). */
  links: number;
  /** Octets envoyés depuis le début de la session. */
  bytesSent: number;
  /** Débit montant (octets/s) des liaisons ouvertes. */
  rateBps: number;
}

export interface HostRelayOptions {
  client: Pick<PartyClient, 'sendRtc' | 'on' | 'participants'>;
  /** Source de plages de la lecture courante de l'hôte (lien débridé lu sur cet appareil). */
  source: RangeSource;
  /** Fabrique de connexion (tests). */
  createPc?: PeerOptions['createPc'];
}

export class HostRelaySession {
  private readonly host: RelayHost;
  private readonly uploads = new Map<string, UploadStats>();
  private readonly unsubscribe: () => void;
  private guestIds = new Set<string>();
  private closed = false;

  constructor(opts: HostRelayOptions) {
    this.host = new RelayHost(opts.source, partySignal(opts.client), {
      iceServers: buildIceServers(relayTurn),
      createPc: opts.createPc,
      onStats: (guestId, stats) => {
        this.uploads.set(guestId, stats);
      },
    });
    this.unsubscribe = opts.client.on('participants', (list) => this.onParticipants(list));
    this.onParticipants(opts.client.participants);
  }

  /** Invités du salon : une liaison est ouverte dès qu'un invité dit bonjour (hello) ; elle se ferme quand il quitte le salon. */
  private onParticipants(list: readonly PartyParticipant[]): void {
    if (this.closed) return;
    const ids = new Set<string>();
    for (const p of list) if (p.guest && p.peerId) ids.add(p.peerId);
    this.guestIds = ids;
    for (const id of this.host.guests) if (!ids.has(id)) this.host.drop(id);
  }

  stats(): RelayStats {
    const live = this.host.guests;
    let rateBps = 0;
    let bytesSent = 0;
    for (const s of this.uploads.values()) bytesSent += s.bytesSent;
    for (const id of live) rateBps += this.uploads.get(id)?.rateBps ?? 0;
    return { guests: this.guestIds.size, links: live.length, bytesSent, rateBps };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.host.close();
  }
}

// ---- Invité --------------------------------------------------------------------------------------------

export type GuestPhase =
  | 'joining'
  | 'waiting-host'
  | 'connecting-host'
  | 'loading'
  | 'ready'
  | 'unsupported'
  | 'host-lost'
  | 'refused'
  | 'ended';

export interface GuestRelayView {
  phase: GuestPhase;
  /** Message à afficher (vide si aucun). */
  message: string;
  /** Débit descendant (octets/s) depuis l'hôte. */
  rateBps: number;
  bytesReceived: number;
  playing: boolean;
  /** Position et durée du lecteur, en secondes. */
  position: number;
  duration: number;
}

/** Ce que la session attend du lecteur invité (GuestPlayer la satisfait). */
export interface GuestPlayerLike {
  load(reader: RangeReader, canvas: HTMLCanvasElement): Promise<PlaybackPlan>;
  play(): void;
  pause(): void;
  seek(t: number): void;
  applyRoomState(room: RoomState, nowMs?: number): void;
  getState(): PlayerState;
  destroy(): void;
}

export interface GuestRelayDeps {
  /** Ouvre le WebSocket du salon en tant qu'invité (le lien d'invitation est dans son adresse). */
  connect: () => Promise<SocketLike>;
  createPlayer: (callbacks: PlayerCallbacks) => GuestPlayerLike;
  canvas: HTMLCanvasElement;
  /** Options de connexion pair à pair (tests, TURN). */
  peer?: PeerOptions;
  /** Échecs de connexion avant que le salon soit considéré comme refusé (défaut : 3). */
  maxRefusals?: number;
  /** Délai de connexion à l'hôte (ms). */
  connectTimeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const EMPTY_VIEW: GuestRelayView = { phase: 'joining', message: '', rateBps: 0, bytesReceived: 0, playing: false, position: 0, duration: 0 };

export class GuestRelaySession {
  private client: PartyClient | null = null;
  private player: GuestPlayerLike | null = null;
  private relay: RelayGuest | null = null;
  private range: RangeClient | null = null;
  private hostId: string | null = null;
  /** Vrai dès qu'une première recherche d'hôte a eu lieu (même sans hôte trouvé). */
  private roomSeen = false;
  private welcomed = false;
  private refusals = 0;
  /** Incrémenté à chaque changement de lecture : les étapes en retard se taisent. */
  private seq = 0;
  private stopped = false;
  private view: GuestRelayView = EMPTY_VIEW;
  private retryTimer: unknown = null;
  /** Action locale en attente d'écho : révision du salon à ce moment, et fin de la fenêtre d'attente. */
  private pendingRev = -1;
  private pendingUntil = 0;

  constructor(private readonly deps: GuestRelayDeps) {}

  /** Rejoint le salon (le WebSocket est ouvert par `deps.connect`). Une seule fois par session. */
  start(): void {
    if (this.client || this.stopped) return;
    const client = new PartyClient({
      connect: () => this.deps.connect(),
      now: this.deps.now,
      setTimer: this.deps.setTimer,
      clearTimer: this.deps.clearTimer,
    });
    this.client = client;
    client.on('status', (st) => this.onStatus(st));
    client.on('welcome', () => {
      this.welcomed = true;
      this.refusals = 0;
      this.onRoom();
    });
    client.on('participants', () => this.onRoom());
    client.on('host', () => this.onRoom());
    client.on('state', () => this.syncRoom());
    client.on('media', () => this.fail('ended', 'Le salon a changé de titre : demande un nouveau lien à l’hôte.'));
    client.on('end', (reason) => this.fail('ended', endText(reason)));
    client.start();
  }

  /** Vue courante ; l'interface l'appelle périodiquement (débit, position, recalage sur le salon). */
  tick(): GuestRelayView {
    const st = this.player?.getState();
    const dl = this.range?.stats();
    this.view = {
      ...this.view,
      playing: st?.playing ?? false,
      position: st?.position ?? 0,
      duration: st?.duration ?? 0,
      rateBps: dl?.rateBps ?? 0,
      bytesReceived: dl?.bytesReceived ?? this.view.bytesReceived,
    };
    if (this.view.phase === 'ready') this.syncRoom();
    return this.view;
  }

  /** Lecture locale : l'action part vers le salon (play) par le lecteur. */
  play(): void {
    if (this.view.phase === 'ready') this.player?.play();
  }

  pause(): void {
    if (this.view.phase === 'ready') this.player?.pause();
  }

  /** Saut relatif (secondes), partagé avec le salon par le lecteur (seek). */
  seekBy(delta: number): void {
    if (this.view.phase !== 'ready' || !this.player) return;
    this.player.seek(Math.max(0, this.player.getState().position + delta));
  }

  /** Nouvelle tentative de liaison avec l'hôte (après une coupure, ou à la demande). */
  retry(): void {
    if (this.stopped || !this.client || this.hostId === null) return;
    this.cancelRetry();
    void this.openMedia(this.hostId);
  }

  /** Quitte le salon et libère le lecteur et les connexions. */
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry();
    this.teardownMedia();
    const c = this.client;
    this.client = null;
    c?.close();
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.retryTimer = set(() => {
      this.retryTimer = null;
      if (this.view.phase === 'waiting-host') this.retry();
    }, RETRY_HOST_MS);
  }

  private cancelRetry(): void {
    if (this.retryTimer === null) return;
    const clear = this.deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
    clear(this.retryTimer);
    this.retryTimer = null;
  }

  // ---- Salon ----

  private onStatus(st: ClientStatus): void {
    if (this.stopped || this.welcomed || st !== 'reconnecting') return;
    this.refusals += 1;
    if (this.refusals >= (this.deps.maxRefusals ?? 3)) this.fail('refused', refusedText());
  }

  /** Recherche le pair de l'hôte parmi les participants ; ouvre la lecture quand il change. */
  private onRoom(): void {
    const c = this.client;
    if (!c || this.stopped || !c.you) return;
    const peer = c.participants.find((p) => p.host && p.peerId)?.peerId ?? null;
    if (this.roomSeen && peer === this.hostId) return;
    this.roomSeen = true;
    this.hostId = peer;
    this.cancelRetry();
    this.teardownMedia();
    if (peer === null) this.setView('waiting-host', waitingHostText());
    else void this.openMedia(peer);
  }

  /** Recale le lecteur sur l'état du salon (sans rien renvoyer au salon). */
  private syncRoom(): void {
    const c = this.client;
    const p = this.player;
    if (!c || !p || !c.state || this.view.phase !== 'ready') return;
    const st = c.state;
    if (Date.now() < this.pendingUntil && (st.rev ?? 0) <= this.pendingRev) return; // écho de notre action attendu
    this.pendingUntil = 0;
    p.applyRoomState({ playing: st.playing, position: st.pos, at: st.at }, c.serverNow());
  }

  /** Action locale envoyée au salon : l'état du salon ne recale le lecteur qu'après son écho. */
  private sendLocal(action: 'play' | 'pause' | 'seek', pos: number): void {
    const c = this.client;
    if (!c) return;
    c.control(action, pos);
    this.pendingRev = c.state?.rev ?? 0;
    this.pendingUntil = Date.now() + ECHO_WAIT_MS;
  }

  // ---- Liaison avec l'hôte et lecture ----

  private async openMedia(peer: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.teardownMedia();
    const seq = this.seq;
    this.setView('connecting-host', '');
    const relay = new RelayGuest(peer, partySignal(client), this.deps.peer);
    this.relay = relay;
    try {
      const channel: ChannelLike = await relay.connect(this.deps.connectTimeoutMs ?? CONNECT_MS);
      if (!this.isCurrent(seq)) return;
      channel.addEventListener('close', () => this.onChannelClosed(seq));
      const range = new RangeClient(channel, {
        onStats: (s) => {
          this.view = { ...this.view, bytesReceived: s.bytesReceived, rateBps: s.rateBps };
        },
      });
      this.range = range;
      const player = this.deps.createPlayer(this.callbacks());
      this.player = player;
      this.setView('loading', '');
      const plan = await player.load(range, this.deps.canvas);
      if (!this.isCurrent(seq)) return;
      if (plan.kind === 'unsupported') {
        this.teardownMedia();
        this.setView('unsupported', plan.message);
        return;
      }
      this.setView('ready', '');
      this.syncRoom();
    } catch (err) {
      if (!this.isCurrent(seq)) return;
      this.teardownMedia();
      if (err instanceof RelayError && err.code === 'timeout') {
        // L'hôte ne lit pas encore (pas de partage) : on attend, et la liaison est recomposée automatiquement.
        this.setView('waiting-host', waitingHostText());
        this.scheduleRetry();
        return;
      }
      this.setView('host-lost', err instanceof RelayError ? relayErrorText(err.code) : relayErrorText('unknown'));
    }
  }

  private onChannelClosed(seq: number): void {
    if (!this.isCurrent(seq)) return;
    this.teardownMedia();
    this.setView('host-lost', hostLostText());
  }

  private callbacks(): PlayerCallbacks {
    return {
      onUserPlay: (pos) => this.sendLocal('play', pos),
      onUserPause: (pos) => this.sendLocal('pause', pos),
      onUserSeek: (pos) => this.sendLocal('seek', pos),
      onError: (err) => {
        this.view = { ...this.view, message: err instanceof RelayError ? relayErrorText(err.code) : relayErrorText('unknown') };
      },
    };
  }

  private isCurrent(seq: number): boolean {
    return !this.stopped && this.seq === seq;
  }

  /** Ferme la lecture et la liaison en cours ; invalide les étapes asynchrones en retard. */
  private teardownMedia(): void {
    this.seq += 1;
    this.relay?.close();
    this.relay = null;
    this.range?.close();
    this.range = null;
    this.player?.destroy();
    this.player = null;
    this.view = { ...this.view, rateBps: 0, playing: false, position: 0, duration: 0 };
  }

  private setView(phase: GuestPhase, message: string): void {
    this.view = { ...this.view, phase, message };
  }

  /** Fin définitive pour cet invité : plus de lecture, plus de connexion au salon. */
  private fail(phase: 'refused' | 'ended', message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry();
    this.teardownMedia();
    const c = this.client;
    this.client = null;
    c?.close();
    this.setView(phase, message);
  }
}
