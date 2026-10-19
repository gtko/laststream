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
import { endText, hostLostText, leftText, refusedText, relayErrorText, waitingHostText } from '../party/join';
import { RangeClient } from './guest';
import { MeshGuest, type MeshGuestOptions } from './mesh/guest';
import { MeshHostState } from './mesh/hostState';
import { RtcConnector, meshTransport, type PeerConnector } from './mesh/rtc';
import { RelayGuest, RelayHost, buildIceServers, type PeerOptions, type RelaySignal, type SignalTransport, type TurnConfig } from './peer';
import type { RangeSource, UploadStats } from './host';
import { RelayError, capsMask, decodeFrame, encodeCaps, encodeMeshReq, toBytes, type ChannelLike, type DecodeCap } from './protocol';
import { detectDecodeCaps } from './player/detect';
import type { PlaybackPlan, PlayerCallbacks, PlayerState, PlayerStats, RangeReader, RoomState } from './player/types';

let relayTurn: TurnConfig | null = null;

/** Délai avant une nouvelle tentative quand l'hôte ne lit pas encore (pas de partage en cours). */
const RETRY_HOST_MS = 4000;
/** Délai de connexion à l'hôte côté invité (une poignée de main RTC dure quelques secondes). */
const CONNECT_MS = 10_000;
/** Après une action locale, on attend l'écho du salon avant de recaler le lecteur (sinon l'état périmé la défait). */
const ECHO_WAIT_MS = 1500;
/** Reconnexion après une coupure de liaison (bascule de source côté hôte, réseau) : 1 s, puis double, 30 s au plus. */
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** Pendant un format refusé : vérification de l'identifiant de fichier annoncé par l'hôte, sur la liaison restée ouverte. */
export const HOLD_PROBE_MS = RECONNECT_MAX_MS;

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
  /** Plafond de débit montant de l'hôte, tous invités confondus, en Mb/s (défaut 60). */
  maxUploadMbps?: number;
  /** Maillage entre invités (défaut : activé). Coupé, ou face à un invité ancien, les invités sont servis en relais direct. */
  mesh?: boolean;
}

export class HostRelaySession {
  private readonly host: RelayHost;
  private readonly mesh: MeshHostState | null;
  private readonly uploads = new Map<string, UploadStats>();
  private readonly unsubscribe: () => void;
  /** Identifiants de connexion des invités du salon : seuls ceux-là sont admis à une liaison. */
  private guestIds = new Set<string>();
  /** Capacités de décodage annoncées par chaque invité (masque DECODE_CAPS), par identifiant de pair. */
  private readonly caps = new Map<string, number>();
  private closed = false;

  constructor(opts: HostRelayOptions) {
    this.mesh = opts.mesh === false ? null : new MeshHostState();
    this.host = new RelayHost(this.mesh ? this.mesh.wrap(opts.source) : opts.source, partySignal(opts.client), {
      iceServers: buildIceServers(relayTurn),
      createPc: opts.createPc,
      mesh: this.mesh ?? undefined,
      allow: (from) => this.guestIds.has(from),
      maxUploadMbps: opts.maxUploadMbps,
      onStats: (guestId, stats) => {
        this.uploads.set(guestId, stats);
      },
      onCaps: (guestId, mask) => {
        if (this.guestIds.has(guestId)) this.caps.set(guestId, mask);
      },
    });
    const offParticipants = opts.client.on('participants', (list) => this.onParticipants(list));
    const offEnd = opts.client.on('end', () => this.onEnd());
    this.unsubscribe = () => {
      offParticipants();
      offEnd();
    };
    this.onParticipants(opts.client.participants);
  }

  /** Invités du salon : une liaison est ouverte dès qu'un invité dit bonjour (hello) ; elle se ferme quand il quitte le salon. */
  private onParticipants(list: readonly PartyParticipant[]): void {
    if (this.closed) return;
    const ids = new Set<string>();
    for (const p of list) if (p.guest && p.peerId) ids.add(p.peerId);
    this.guestIds = ids;
    for (const id of this.host.guests) if (!ids.has(id)) this.host.drop(id);
    for (const id of [...this.caps.keys()]) if (!ids.has(id)) this.caps.delete(id);
  }

  /** Capacités de décodage annoncées par les invités présents (masque DECODE_CAPS, par identifiant de pair). */
  guestCaps(): ReadonlyMap<string, number> {
    return new Map(this.caps);
  }

  /** Fin du salon : toutes les liaisons se ferment tout de suite, et plus aucun invité n'est admis. */
  private onEnd(): void {
    this.guestIds = new Set();
    this.caps.clear();
    for (const id of this.host.guests) this.host.drop(id);
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

// ---- Invité ----

/** Identifiants de pair des autres invités du salon, les plus anciens d'abord (le serveur envoie `joinedAt` en ms ou en ISO). */
export function meshPeerOrder(participants: readonly PartyParticipant[], self: string): string[] {
  const when = (p: PartyParticipant): number => {
    const raw = p.joinedAt as unknown;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  };
  return participants
    .filter((p) => p.guest && p.peerId && p.peerId !== self)
    .sort((a, b) => when(a) - when(b) || (a.peerId ?? '').localeCompare(b.peerId ?? ''))
    .map((p) => p.peerId as string);
}


export type GuestPhase =
  | 'joining'
  | 'waiting-host'
  | 'connecting-host'
  | 'loading'
  | 'ready'
  | 'unsupported'
  | 'host-lost'
  | 'refused'
  | 'ended'
  | 'left';

export interface GuestRelayView {
  phase: GuestPhase;
  /** Message à afficher (vide si aucun). */
  message: string;
  /** Débit descendant (octets/s) depuis l'hôte. */
  rateBps: number;
  bytesReceived: number;
  /** Maillage : pairs prêts, octets reçus des autres invités et servis aux autres invités (0 en relais direct). */
  meshPeers: number;
  bytesFromPeers: number;
  bytesServed: number;
  playing: boolean;
  /** Position et durée du lecteur, en secondes. */
  position: number;
  duration: number;
  /** Note discrète sur la lecture (ex. son non pris en charge), vide si aucune. */
  note: string;
}

/** Ce que la session attend du lecteur invité (GuestPlayer la satisfait). */
export interface GuestPlayerLike {
  load(reader: RangeReader, canvas: HTMLCanvasElement): Promise<PlaybackPlan>;
  play(): void;
  pause(): void;
  seek(t: number): void;
  applyRoomState(room: RoomState, nowMs?: number): void;
  getState(): PlayerState;
  /** Compteurs du lecteur (diagnostic seulement) : images et sons décodés. */
  getStats?(): PlayerStats;
  destroy(): void;
}

export interface GuestRelayDeps {
  /** Ouvre le WebSocket du salon en tant qu'invité (le lien d'invitation est dans son adresse). */
  connect: () => Promise<SocketLike>;
  createPlayer: (callbacks: PlayerCallbacks) => GuestPlayerLike;
  canvas: HTMLCanvasElement;
  /** Options de connexion pair à pair (tests, TURN). */
  peer?: PeerOptions;
  /** Maillage entre invités : `false` le coupe ; sinon réglages facultatifs (tests). */
  mesh?: false | Partial<Pick<MeshGuestOptions, 'cacheBytes' | 'maxPeers' | 'peerTimeoutMs' | 'peerDeadlineMs' | 'locateTimeoutMs' | 'haveEveryMs' | 'pendingWaitMs' | 'pendingWaits'>>;
  /** Fabrique de la couche de liaison entre invités (tests ; défaut : WebRTC signalé par le salon). */
  meshConnector?: (self: string, allow: (peerId: string) => boolean) => PeerConnector;
  /** Capacités de décodage de cet appareil (défaut : sonde WebCodecs, voir detectDecodeCaps). */
  decodeCaps?: () => Promise<DecodeCap[]>;
  /** Échecs de connexion avant que le salon soit considéré comme refusé (défaut : 3). */
  maxRefusals?: number;
  /** Délai de connexion à l'hôte (ms). */
  connectTimeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const EMPTY_VIEW: GuestRelayView = { phase: 'joining', message: '', rateBps: 0, bytesReceived: 0, meshPeers: 0, bytesFromPeers: 0, bytesServed: 0, playing: false, position: 0, duration: 0, note: '' };

export class GuestRelaySession {
  private client: PartyClient | null = null;
  private player: GuestPlayerLike | null = null;
  private relay: RelayGuest | null = null;
  private range: RangeClient | null = null;
  private mesh: MeshGuest | null = null;
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
  /** Masque des capacités de décodage de cet appareil, sondé une fois à la connexion au salon. */
  private capsP: Promise<number | null> | null = null;
  /** Coupures consécutives sans liaison réussie : fixe le délai de la prochaine reconnexion. */
  private reconnects = 0;
  /** Format refusé : liaison restée ouverte, identifiant de fichier de l'hôte connu, minuterie de vérification. */
  private heldChannel: ChannelLike | null = null;
  private heldId: string | null = null;
  private probeTimer: unknown = null;
  private probeReq = 0;

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
    const probe = this.deps.decodeCaps ?? (() => detectDecodeCaps());
    // Sonde en échec : capacités inconnues (null), rien n'est annoncé ; l'hôte ne suppose rien.
    this.capsP = probe().then(capsMask, () => null);
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
    const ms = this.mesh?.stats();
    this.view = {
      ...this.view,
      meshPeers: ms?.peers ?? 0,
      bytesFromPeers: ms?.bytesFromPeers ?? 0,
      bytesServed: ms?.bytesServed ?? 0,
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

  /**
   * « Quitter » : ferme le WebSocket du salon, le relais, le maillage et le lecteur, puis affiche « left ». Sans reconnexion ;
   * la page propose de rejoindre à nouveau avec la même invitation (une nouvelle session).
   */
  leave(): void {
    if (this.stopped) return;
    this.destroy();
    this.setView('left', leftText());
  }

  /** Compteurs de diagnostic (lecture seule) : nombres seulement, jamais d'URL. Octets des pairs : maillage. */
  debugCounts(): { videoFrames: number; audioData: number; bytesFromHost: number; bytesFromPeers: number } {
    const st = this.player?.getStats?.();
    return {
      videoFrames: st?.decodedFrames ?? 0,
      audioData: st?.audioChunks ?? 0,
      bytesFromHost: this.view.bytesReceived,
      bytesFromPeers: this.view.bytesFromPeers,
    };
  }

  /**
   * Reconnexion automatique après une coupure : nouvelle liaison (hello), puis annonce des capacités sur le nouveau canal.
   * Délai doublé à chaque coupure (1 s, 2 s, 4 s… 30 s au plus) ; s'arrête avec la lecture, le salon ou la session.
   */
  private scheduleReconnect(): void {
    this.cancelRetry();
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnects);
    this.reconnects += 1;
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.retryTimer = set(() => {
      this.retryTimer = null;
      if (this.view.phase === 'host-lost' || this.view.phase === 'unsupported') this.retry();
    }, delay);
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
    this.mesh?.refresh();
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
      // Capacités de décodage : annoncées à l'hôte sur ce canal, avant la première requête de plage.
      const mask = await (this.capsP ?? Promise.resolve(null));
      if (!this.isCurrent(seq)) return;
      if (mask !== null) {
        try {
          channel.send(encodeCaps(mask));
        } catch {
          // Canal fermé pendant l'annonce : la liaison se rompra d'elle-même (onChannelClosed).
        }
      }
      const range = new RangeClient(channel, {
        onStats: (s) => {
          this.view = { ...this.view, bytesReceived: s.bytesReceived, rateBps: s.rateBps };
        },
      });
      this.range = range;
      const reader = await this.openMesh(client, channel, range, seq);
      if (!this.isCurrent(seq)) return;
      // Identifiant opaque du fichier de l'hôte (maillage négocié), pour reconnaître un nouveau fichier plus tard.
      const fileId = this.mesh?.id ?? null;
      const player = this.deps.createPlayer(this.callbacks());
      this.player = player;
      this.setView('loading', '');
      const plan = await player.load(reader, this.deps.canvas);
      if (!this.isCurrent(seq)) return;
      if (plan.kind === 'unsupported') {
        this.hold(channel, fileId, plan.message);
        return;
      }
      this.setView('ready', '');
      this.reconnects = 0;
      this.view = { ...this.view, note: plan.note ?? '' };
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
      this.scheduleReconnect();
    }
  }

  private otherGuests(client: PartyClient, self: string): string[] {
    return meshPeerOrder(client.participants, self);
  }

  /**
   * Maillage avec les autres invités, si l'hôte le propose (MESH?) : rend le lecteur de plages à donner au lecteur vidéo.
   * Hôte ancien, serveur sans identifiant de pair ou maillage coupé : le RangeClient de l'hôte est lu directement, comme avant.
   */
  private async openMesh(client: PartyClient, channel: ChannelLike, range: RangeClient, seq: number): Promise<RangeReader> {
    const self = client.you?.peerId;
    if (this.deps.mesh === false || !self) return range;
    let mesh: MeshGuest | null = null;
    const allow = (id: string): boolean => this.isCurrent(seq) && this.otherGuests(client, self).includes(id) && (mesh?.admits(id) ?? false);
    const connector = this.deps.meshConnector
      ? this.deps.meshConnector(self, allow)
      : new RtcConnector(meshTransport(partySignal(client)), self, { ...this.deps.peer, allow });
    mesh = await MeshGuest.negotiate({
      ...this.deps.mesh,
      hostChannel: channel,
      host: range,
      connector,
      guests: () => this.otherGuests(client, self),
    });
    if (!mesh || !this.isCurrent(seq)) {
      mesh?.close();
      connector.close();
      return range;
    }
    this.mesh = mesh;
    mesh.refresh();
    return mesh.reader();
  }

  private onChannelClosed(seq: number): void {
    if (!this.isCurrent(seq)) return;
    this.teardownMedia();
    this.setView('host-lost', hostLostText());
    this.scheduleReconnect();
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
    this.stopHold();
    this.relay?.close();
    this.relay = null;
    this.releasePlayback();
  }

  /** Libère le lecteur, le maillage et le lecteur de plages ; la liaison avec l'hôte n'est pas touchée. */
  private releasePlayback(): void {
    this.mesh?.close();
    this.mesh = null;
    this.range?.close();
    this.range = null;
    this.player?.destroy();
    this.player = null;
    this.view = { ...this.view, rateBps: 0, meshPeers: 0, playing: false, position: 0, duration: 0, note: '' };
  }

  /**
   * Format refusé par ce navigateur. La liaison avec l'hôte reste ouverte : sa fermeture relance l'ouverture (bascule côté
   * hôte). L'identifiant de fichier annoncé est vérifié périodiquement ; un nouveau fichier relance le décodage. Le salon
   * reste joignable : seul « Quitter » ou une nouvelle ouverture met fin à cet état.
   */
  private hold(channel: ChannelLike, fileId: string | null, message: string): void {
    this.releasePlayback();
    this.setView('unsupported', message);
    this.heldChannel = channel;
    this.heldId = fileId;
    channel.addEventListener('message', this.onHeldMessage);
    this.scheduleProbe();
  }

  private stopHold(): void {
    if (this.probeTimer !== null) {
      const clear = this.deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
      clear(this.probeTimer);
      this.probeTimer = null;
    }
    this.heldChannel?.removeEventListener('message', this.onHeldMessage);
    this.heldChannel = null;
    this.heldId = null;
  }

  /** Vérification périodique de l'identifiant de fichier (MESH?) sur la liaison restée ouverte. */
  private scheduleProbe(): void {
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.probeTimer = set(() => {
      this.probeTimer = null;
      const channel = this.heldChannel;
      if (!channel || this.view.phase !== 'unsupported') return;
      this.probeReq = (this.probeReq + 1) >>> 0;
      try {
        channel.send(encodeMeshReq(this.probeReq));
      } catch {
        // Canal déjà fermé : sa fermeture relance l'ouverture (onChannelClosed).
      }
      this.scheduleProbe();
    }, HOLD_PROBE_MS);
  }

  private readonly onHeldMessage = (ev: { data?: unknown }): void => {
    const bytes = toBytes(ev.data);
    const frame = bytes ? decodeFrame(bytes) : null;
    if (frame?.t === 'mesh') this.onHeldFileId(frame.fileId);
  };

  /**
   * Identifiant annoncé pendant un format refusé : s'il change, on relance l'ouverture (même délai que la reconnexion).
   * Sans identifiant connu (maillage non négocié), la première annonce sert de référence.
   */
  private onHeldFileId(fileId: string): void {
    if (this.view.phase !== 'unsupported') return;
    if (this.heldId === null) {
      this.heldId = fileId;
      return;
    }
    if (fileId === this.heldId) return;
    this.heldId = fileId;
    this.scheduleReconnect();
  }

  private setView(phase: GuestPhase, message: string): void {
    this.view = { ...this.view, phase, message, note: '' };
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
