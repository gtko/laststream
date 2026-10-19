/* Connexion WebRTC entre l'hôte et chaque invité, pour le DataChannel « ranges » (ordonné, fiable).
 * L'hôte crée l'offre ; l'invité envoie `hello` et répond à l'offre. La signalisation passe par un transport abstrait
 * (`SignalTransport`), branché plus tard sur le WebSocket du salon : `{type:"rtc",to,data}` en émission,
 * `{type:"rtc",from,data}` en réception. Les candidats ICE reçus avant la description distante attendent.
 * ICE : STUN Cloudflare, plus un TURN facultatif fourni par l'appelant (jamais en dur). Aucune URL n'est journalisée. */

import { DEFAULT_UPLOAD_MBPS, RangeServer, type RangeServerOptions, type RangeSource, UploadBudget, type UploadStats, mbpsToBytesPerSec } from './host';
import type { MeshHostState } from './mesh/hostState';
import { RELAY_CHANNEL_LABEL, RelayError, type ChannelLike } from './protocol';

export const STUN_URL = 'stun:stun.cloudflare.com:3478';
export const CONNECT_TIMEOUT_MS = 20_000;
const MAX_SDP_CHARS = 32 * 1024;

export interface TurnConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** STUN Cloudflare, suivi du TURN fourni (s'il y en a un). */
export function buildIceServers(turn?: TurnConfig | null): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: STUN_URL }];
  if (turn && turn.urls) servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  return servers;
}

/** Charges de signalisation échangées entre pairs. */
export type RelaySignal =
  | { t: 'hello' }
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidate: RTCIceCandidateInit | null };

/** Charge reçue validée, ou null si elle n'est pas une signalisation du relais. */
export function parseSignal(raw: unknown): RelaySignal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.t === 'hello') return { t: 'hello' };
  if (o.t === 'offer' || o.t === 'answer') {
    if (typeof o.sdp !== 'string' || o.sdp.length > MAX_SDP_CHARS) return null;
    return o.t === 'offer' ? { t: 'offer', sdp: o.sdp } : { t: 'answer', sdp: o.sdp };
  }
  if (o.t === 'ice') {
    if (o.candidate === null) return { t: 'ice', candidate: null };
    if (typeof o.candidate !== 'object' || o.candidate === null) return null;
    return { t: 'ice', candidate: o.candidate as RTCIceCandidateInit };
  }
  return null;
}

/** Transport de signalisation : envoi vers un identifiant de pair, réception `cb(from, data)`. */
export interface SignalTransport {
  send(to: string, data: RelaySignal): void;
  /** Abonne `cb` aux charges reçues ; rend la fonction de désinscription. */
  onMessage(cb: (from: string, data: unknown) => void): () => void;
}

export interface PeerOptions {
  iceServers?: RTCIceServer[];
  /** Fabrique de connexion (injectable pour les tests). */
  createPc?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface HostOptions extends PeerOptions {
  server?: RangeServerOptions;
  onStats?: (guestId: string, stats: UploadStats) => void;
  /** Admission : seul un pair accepté reçoit une offre, et seules ses réponses et candidats sont lus. Refus par défaut. */
  allow?: (from: string) => boolean;
  /** Plafond de débit montant de l'hôte, tous invités confondus, en Mb/s (défaut 60). */
  maxUploadMbps?: number;
  /** Délai entre l'offre et la réponse appliquée, en ms (défaut 15 s) ; au-delà, la liaison est fermée. */
  answerTimeoutMs?: number;
  /** Maillage entre invités : sans lui (hôte ancien ou option coupée), les invités n'ont que le relais direct. */
  mesh?: MeshHostState;
  /** Capacités de décodage annoncées par un invité (masque, voir `DECODE_CAPS`). */
  onCaps?: (guestId: string, mask: number) => void;
}

/** Délai de réponse de l'invité, et nombre de candidats ICE retenus avant la réponse. */
export const ANSWER_TIMEOUT_MS = 15_000;
export const MAX_PENDING_ICE = 32;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Un rejet n'est pas une erreur non gérée : ceux qui attendent la promesse traitent le refus.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function makePc(opts: PeerOptions): RTCPeerConnection {
  const config: RTCConfiguration = { iceServers: opts.iceServers ?? buildIceServers() };
  return opts.createPc ? opts.createPc(config) : new RTCPeerConnection(config);
}

interface HostLink {
  pc: RTCPeerConnection;
  server: RangeServer;
  /** Résolu quand la réponse de l'invité est appliquée ; rejeté quand la liaison est fermée avant. */
  remote: Deferred;
  /** Délai de réponse, annulé dès que la réponse est appliquée ou que la liaison est fermée. */
  answerTimer: ReturnType<typeof setTimeout> | null;
  /** Candidats ICE en attente de la réponse. */
  pendingIce: number;
}

/** Côté hôte : un RTCPeerConnection et un RangeServer par invité. */
export class RelayHost {
  private readonly links = new Map<string, HostLink>();
  private readonly unsubscribe: () => void;
  /** Plafond de débit montant partagé par tous les liens. */
  private readonly budget: UploadBudget;

  constructor(
    private readonly source: RangeSource,
    private readonly signaling: SignalTransport,
    private readonly opts: HostOptions = {},
  ) {
    this.budget = new UploadBudget(mbpsToBytesPerSec(opts.maxUploadMbps ?? DEFAULT_UPLOAD_MBPS));
    this.unsubscribe = signaling.onMessage((from, raw) => {
      void this.onSignal(from, raw);
    });
  }

  /** Invités dont le lien est ouvert ou en cours d'ouverture. */
  get guests(): string[] {
    return [...this.links.keys()];
  }

  /** Ferme le lien d'un invité. */
  drop(guestId: string): void {
    const link = this.links.get(guestId);
    if (!link) return;
    this.links.delete(guestId);
    if (link.answerTimer !== null) clearTimeout(link.answerTimer);
    link.answerTimer = null;
    link.remote.reject(new RelayError('unavailable'));
    link.server.close();
    link.pc.close();
    this.opts.mesh?.detach(guestId);
  }

  close(): void {
    this.unsubscribe();
    for (const id of [...this.links.keys()]) this.drop(id);
  }

  private async onSignal(from: string, raw: unknown): Promise<void> {
    // Pair non admis : aucune offre, et ses réponses et candidats sont ignorés en silence.
    if (this.opts.allow?.(from) !== true) return;
    const s = parseSignal(raw);
    if (!s) return;
    if (s.t === 'hello') {
      await this.offer(from);
      return;
    }
    const link = this.links.get(from);
    if (!link) return;
    if (s.t === 'answer') {
      try {
        await link.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        link.remote.resolve();
        if (link.answerTimer !== null) clearTimeout(link.answerTimer);
        link.answerTimer = null;
      } catch {
        this.drop(from);
      }
      return;
    }
    if (s.t === 'ice' && s.candidate) {
      // Candidats reçus avant la réponse : bornés, les excédents sont ignorés.
      if (link.pendingIce >= MAX_PENDING_ICE) return;
      link.pendingIce += 1;
      try {
        await link.remote.promise;
        await link.pc.addIceCandidate(s.candidate).catch(() => undefined);
      } catch {
        // Liaison fermée avant la réponse : le candidat est abandonné.
      } finally {
        link.pendingIce -= 1;
      }
    }
  }

  /** Ferme la liaison seulement si `server` est encore celle de l'invité (une liaison plus récente n'est pas touchée). */
  private dropServer(guestId: string, server: RangeServer): void {
    if (this.links.get(guestId)?.server === server) this.drop(guestId);
  }

  private async offer(guestId: string): Promise<void> {
    this.drop(guestId);
    const pc = makePc(this.opts);
    const channel = pc.createDataChannel(RELAY_CHANNEL_LABEL, { ordered: true }) as unknown as ChannelLike;
    channel.binaryType = 'arraybuffer';
    const server: RangeServer = new RangeServer(this.source, channel, {
      ...this.opts.server,
      budget: this.budget,
      onOther: this.opts.mesh?.attach(guestId, channel, () => this.source.size()),
      onCaps: (mask) => this.opts.onCaps?.(guestId, mask),
      onIdle: () => this.dropServer(guestId, server),
      onAbuse: () => this.dropServer(guestId, server),
      onStats: (stats) => this.opts.onStats?.(guestId, stats),
    });
    const link: HostLink = { pc, server, remote: deferred(), answerTimer: null, pendingIce: 0 };
    this.links.set(guestId, link);
    link.answerTimer = setTimeout(() => {
      link.answerTimer = null;
      if (this.links.get(guestId) === link) this.drop(guestId);
    }, this.opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS);
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.links.get(guestId) === link) this.signaling.send(guestId, { t: 'ice', candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.links.get(guestId) === link) this.drop(guestId);
    };
    try {
      const offer = await pc.createOffer();
      if (this.links.get(guestId) !== link) return;
      this.signaling.send(guestId, { t: 'offer', sdp: offer.sdp ?? '' });
      await pc.setLocalDescription(offer);
    } catch {
      this.drop(guestId);
    }
  }
}

/** Côté invité : répond à l'offre de l'hôte et résout avec le canal ouvert. */
export class RelayGuest {
  private pc: RTCPeerConnection | null = null;
  private remote: Deferred | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly hostId: string,
    private readonly signaling: SignalTransport,
    private readonly opts: PeerOptions = {},
  ) {}

  /** Demande la connexion à l'hôte ; rejette avec `timeout` ou `unavailable`. */
  connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<ChannelLike> {
    this.close();
    return new Promise<ChannelLike>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new RelayError('timeout')), timeoutMs);
      const finish = (err: RelayError | null, channel?: ChannelLike): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (err || !channel) {
          this.close();
          reject(err ?? new RelayError('unavailable'));
        } else {
          resolve(channel);
        }
      };
      this.unsubscribe = this.signaling.onMessage((from, raw) => {
        if (from === this.hostId && !settled) void this.onSignal(raw, finish);
      });
      this.signaling.send(this.hostId, { t: 'hello' });
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const pc = this.pc;
    this.pc = null;
    this.remote = null;
    pc?.close();
  }

  private async onSignal(raw: unknown, finish: (err: RelayError | null, channel?: ChannelLike) => void): Promise<void> {
    const s = parseSignal(raw);
    if (!s) return;
    if (s.t === 'offer') {
      const pc = makePc(this.opts);
      const remote = deferred();
      this.pc = pc;
      this.remote = remote;
      pc.ondatachannel = (ev) => {
        if (ev.channel.label !== RELAY_CHANNEL_LABEL) return;
        const dc = ev.channel;
        dc.binaryType = 'arraybuffer';
        const ready = (): void => finish(null, dc as unknown as ChannelLike);
        if (dc.readyState === 'open') ready();
        else dc.onopen = ready;
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) this.signaling.send(this.hostId, { t: 'ice', candidate: ev.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') finish(new RelayError('unavailable'));
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        remote.resolve();
        const answer = await pc.createAnswer();
        this.signaling.send(this.hostId, { t: 'answer', sdp: answer.sdp ?? '' });
        await pc.setLocalDescription(answer);
      } catch {
        finish(new RelayError('unavailable'));
      }
      return;
    }
    if (s.t === 'ice' && s.candidate && this.pc && this.remote) {
      const pc = this.pc;
      await this.remote.promise;
      await pc.addIceCandidate(s.candidate).catch(() => undefined);
    }
  }
}
