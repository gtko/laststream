/* Connexions WebRTC directes entre invités, signalées par le salon (`{type:'rtc',to,data}` avec `data.m === 'mesh'`).
 * Le serveur pose lui-même l'identifiant de l'émetteur (`from`) et refuse tout type hors hello, offer, answer, ice, ou toute
 * signalisation de maillage qui ne soit pas entre deux invités.
 * Protocole : n'importe quel côté peut envoyer `hello` ; le pair d'identifiant le plus petit crée l'offre et le DataChannel
 * « mesh » (pas de collision d'offres) ; l'autre répond. Un invité répond seulement aux pairs admis par `allow`. */

import { buildIceServers, parseSignal, type PeerOptions, type RelaySignal, type SignalTransport } from '../peer';
import type { ChannelLike } from '../protocol';

const MESH_CHANNEL_LABEL = 'mesh';
const MESH_CONNECT_TIMEOUT_MS = 12_000;
const MAX_PENDING_ICE = 32;

/** Transport de maillage au-dessus d'un transport de salon : étiquette `m:'mesh'` en émission, filtre en réception. */
export function meshTransport(base: SignalTransport): SignalTransport {
  return {
    send(to, data): void {
      base.send(to, { m: 'mesh', ...data } as unknown as RelaySignal);
    },
    onMessage(cb): () => void {
      return base.onMessage((from, raw) => {
        if (typeof raw === 'object' && raw !== null && (raw as { m?: unknown }).m === 'mesh') cb(from, raw);
      });
    },
  };
}

/** Ce que le maillage attend d'une couche de connexion entre pairs (le vrai WebRTC, ou un faux en mémoire pour les tests). */
export interface PeerConnector {
  /** Ouvre la liaison avec ce pair ; rejette en cas d'échec ou de délai. */
  connect(peerId: string): Promise<ChannelLike>;
  /** Liaison ouverte à l'initiative d'un pair admis. */
  onIncoming(cb: (peerId: string, channel: ChannelLike) => void): () => void;
  /** Ferme la liaison en cours de négociation avec ce pair (le canal ouvert reste à la charge de l'appelant). */
  abort(peerId: string): void;
  close(): void;
}

export interface RtcConnectorOptions extends PeerOptions {
  /** Pairs admis (invités du salon, non bannis, capacité restante). Refus par défaut. */
  allow: (peerId: string) => boolean;
  timeoutMs?: number;
}

interface Session {
  peer: string;
  pc: RTCPeerConnection | null;
  remote: { promise: Promise<void>; resolve: () => void; reject: () => void } | null;
  promise: Promise<ChannelLike>;
  resolve: (c: ChannelLike) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Créée par un pair (pas par `connect`) : le canal ouvert est annoncé par `onIncoming`. */
  incoming: boolean;
  settled: boolean;
  /** Négociation abandonnée (délai, échec, fermeture) : plus rien à envoyer. */
  failed: boolean;
  pendingIce: number;
}

export class RtcConnector implements PeerConnector {
  private readonly sessions = new Map<string, Session>();
  private readonly incoming = new Set<(peerId: string, channel: ChannelLike) => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly signaling: SignalTransport,
    private readonly self: string,
    private readonly opts: RtcConnectorOptions,
  ) {
    this.unsubscribe = signaling.onMessage((from, raw) => {
      void this.onSignal(from, raw);
    });
  }

  connect(peerId: string): Promise<ChannelLike> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const existing = this.sessions.get(peerId);
    if (existing) {
      existing.incoming = false;
      return existing.promise;
    }
    const sess = this.create(peerId, false);
    this.signaling.send(peerId, { t: 'hello' });
    return sess.promise;
  }

  onIncoming(cb: (peerId: string, channel: ChannelLike) => void): () => void {
    this.incoming.add(cb);
    return () => this.incoming.delete(cb);
  }

  abort(peerId: string): void {
    this.fail(this.sessions.get(peerId));
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    for (const s of [...this.sessions.values()]) this.fail(s);
    this.incoming.clear();
  }

  private create(peer: string, incoming: boolean): Session {
    let resolve: (c: ChannelLike) => void = () => undefined;
    let reject: (e: Error) => void = () => undefined;
    const promise = new Promise<ChannelLike>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    const sess: Session = { peer, pc: null, remote: null, promise, resolve, reject, timer: null, incoming, settled: false, failed: false, pendingIce: 0 };
    sess.timer = setTimeout(() => this.fail(sess), this.opts.timeoutMs ?? MESH_CONNECT_TIMEOUT_MS);
    this.sessions.set(peer, sess);
    return sess;
  }

  private fail(sess: Session | undefined): void {
    if (!sess) return;
    if (this.sessions.get(sess.peer) === sess) this.sessions.delete(sess.peer);
    if (sess.timer !== null) clearTimeout(sess.timer);
    sess.timer = null;
    const wasSettled = sess.settled;
    sess.settled = true;
    sess.failed = true;
    sess.remote?.reject();
    if (!wasSettled) sess.pc?.close();
    sess.reject(new Error('unavailable'));
  }

  /** Canal ouvert : la session est terminée, le canal appartient à l'appelant (le pc reste lié à lui). */
  private open(sess: Session, channel: ChannelLike): void {
    if (sess.settled) return;
    sess.settled = true;
    if (sess.timer !== null) clearTimeout(sess.timer);
    sess.timer = null;
    if (this.sessions.get(sess.peer) === sess) this.sessions.delete(sess.peer);
    const pc = sess.pc;
    channel.addEventListener('close', () => pc?.close());
    sess.resolve(channel);
    if (sess.incoming) for (const cb of [...this.incoming]) cb(sess.peer, channel);
  }

  private makePc(sess: Session): RTCPeerConnection {
    const config: RTCConfiguration = { iceServers: this.opts.iceServers ?? buildIceServers() };
    const pc = this.opts.createPc ? this.opts.createPc(config) : new RTCPeerConnection(config);
    let resolve: () => void = () => undefined;
    let reject: () => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = () => rej(new Error('closed'));
    });
    promise.catch(() => undefined);
    sess.pc = pc;
    sess.remote = { promise, resolve, reject };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && !sess.failed) this.signaling.send(sess.peer, { t: 'ice', candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail(sess);
    };
    return pc;
  }

  private async onSignal(from: string, raw: unknown): Promise<void> {
    if (this.closed || from === this.self) return;
    const s = parseSignal(raw);
    if (!s) return;
    let sess = this.sessions.get(from);
    if (!sess && !this.opts.allow(from)) return;
    if (s.t === 'hello') {
      if (!sess) sess = this.create(from, true);
      if (this.self < from) {
        if (!sess.pc) await this.offer(sess);
      } else if (!sess.pc && !sess.incoming) {
        return; // notre hello est déjà parti : on attend son offre
      } else if (!sess.pc) {
        this.signaling.send(from, { t: 'hello' }); // le plus petit crée l'offre : on lui dit de la faire
      }
      return;
    }
    if (!sess) return;
    if (s.t === 'offer' && this.self > from && !sess.pc) {
      await this.answer(sess, s.sdp);
    } else if (s.t === 'answer' && sess.pc && this.self < from) {
      try {
        await sess.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        sess.remote?.resolve();
      } catch {
        this.fail(sess);
      }
    } else if (s.t === 'ice' && s.candidate && sess.pc && sess.remote) {
      if (sess.pendingIce >= MAX_PENDING_ICE) return;
      sess.pendingIce += 1;
      try {
        await sess.remote.promise;
        await sess.pc.addIceCandidate(s.candidate).catch(() => undefined);
      } catch {
        /* session fermée avant la description distante */
      } finally {
        sess.pendingIce -= 1;
      }
    }
  }

  private async offer(sess: Session): Promise<void> {
    const pc = this.makePc(sess);
    const dc = pc.createDataChannel(MESH_CHANNEL_LABEL, { ordered: true });
    dc.binaryType = 'arraybuffer';
    const ready = (): void => this.open(sess, dc as unknown as ChannelLike);
    if (dc.readyState === 'open') ready();
    else dc.onopen = ready;
    try {
      const offer = await pc.createOffer();
      if (sess.failed) return;
      this.signaling.send(sess.peer, { t: 'offer', sdp: offer.sdp ?? '' });
      await pc.setLocalDescription(offer);
    } catch {
      this.fail(sess);
    }
  }

  private async answer(sess: Session, sdp: string): Promise<void> {
    const pc = this.makePc(sess);
    pc.ondatachannel = (ev) => {
      if (ev.channel.label !== MESH_CHANNEL_LABEL) return;
      const dc = ev.channel;
      dc.binaryType = 'arraybuffer';
      const ready = (): void => this.open(sess, dc as unknown as ChannelLike);
      if (dc.readyState === 'open') ready();
      else dc.onopen = ready;
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      sess.remote?.resolve();
      const answer = await pc.createAnswer();
      if (sess.failed) return;
      this.signaling.send(sess.peer, { t: 'answer', sdp: answer.sdp ?? '' });
      await pc.setLocalDescription(answer);
    } catch {
      this.fail(sess);
    }
  }
}
