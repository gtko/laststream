/* Côté invité : maillage de morceaux avec les autres invités.
 *  - Les morceaux reçus (1 Mio) sont gardés dans un cache LRU borné (256 Mio par défaut) et servis aux autres invités par un
 *    RangeServer branché sur ce cache ; les morceaux détenus sont annoncés (HAVE : intervalles, au plus un envoi par 500 ms).
 *  - Pour un morceau : cache, sinon un pair qui l'annonce (au plus 2 essais), sinon l'hôte. Le pair est abandonné s'il est
 *    absent, lent (délai d'expiration), en erreur ou s'il renvoie des octets dont le SHA-256 diffère de celui de l'hôte :
 *    dans ce dernier cas il est banni pour la séance.
 *  - Le hachage d'un morceau vient de l'hôte (LOCATE). Sans hachage connu, aucun pair n'est utilisé : le morceau est lu chez l'hôte.
 *  - Aucune URL ni lien de débrideur ne circule ici : seulement des octets de fichier et l'identifiant opaque donné par l'hôte.
 *  - Un hôte qui ne répond pas à MESH? (version ancienne) laisse `negotiate` rendre null : l'appelant garde le relais direct. */

import { RangeClient } from '../guest';
import { DEFAULT_UPLOAD_MBPS, RangeServer, UploadBudget, mbpsToBytesPerSec, type RangeSource } from '../host';
import {
  RelayError, decodeFrame, encodeHave, encodeLocate, encodeMesh, encodeMeshReq, toBytes, type ChannelLike, type RelayFrame,
} from '../protocol';
import type { RangeReader } from '../player/types';
import { PIECE_BYTES, PIECE_SHIFT, DEFAULT_CACHE_BYTES, PieceCache, fromIntervals, pieceBounds, pieceCount, sameHash, sha256, toIntervals } from './pieces';
import type { PeerConnector } from './rtc';

export interface MeshGuestOptions {
  /** Canal « ranges » vers l'hôte (MESH?, LOCATE, HAVE). */
  hostChannel: ChannelLike;
  /** Client de plages de l'hôte : repli, taille du fichier. */
  host: RangeClient;
  connector: PeerConnector;
  /** Autres invités du salon, par ordre de préférence (les plus anciens d'abord) ; soi-même exclu par l'appelant. */
  guests: () => readonly string[];
  cacheBytes?: number;
  maxPeers?: number;
  /** Inactivité tolérée d'un pair avant de se replier (ms), et durée maximale d'un morceau chez un pair (ms). */
  peerTimeoutMs?: number;
  peerDeadlineMs?: number;
  locateTimeoutMs?: number;
  /** Intervalle minimal entre deux annonces HAVE (ms). */
  haveEveryMs?: number;
  /** Plafond de débit montant vers les pairs (Mb/s). */
  serveMbps?: number;
  /** Attente entre deux LOCATE quand un autre invité reçoit le morceau de l'hôte (ms), et nombre d'attentes. */
  pendingWaitMs?: number;
  pendingWaits?: number;
}

export interface MeshStats {
  /** Pairs prêts (liaison ouverte, même fichier). */
  peers: number;
  bytesFromHost: number;
  bytesFromPeers: number;
  /** Octets servis aux autres invités. */
  bytesServed: number;
  banned: number;
}

interface Peer {
  id: string;
  channel: ChannelLike;
  client: RangeClient;
  server: RangeServer;
  have: Set<number>;
  ready: boolean;
  /** Requêtes en cours chez ce pair (les suivantes font la queue plutôt que de retomber sur l'hôte). */
  active: number;
  gate: Gate;
}

interface Located {
  hash: Uint8Array | null;
  holders: string[];
  pending: boolean;
}

/** Identifiants de requête du maillage vers l'hôte : bit haut posé, disjoints de ceux de RangeClient. */
const MESH_REQ_BASE = 0x80000000;
const COOL_MS = 15_000;
const BUSY_COOL_MS = 2000;
const RETRY_PEER_MS = 15_000;
const MAX_PEER_TRIES = 2;
const PEER_PARALLEL = 2;
const HOST_PARALLEL = 3;
const READ_PARALLEL = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sémaphore minimal : au plus `n` tâches à la fois. */
class Gate {
  private free: number;
  private readonly queue: Array<() => void> = [];

  constructor(n: number) {
    this.free = n;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

export class MeshGuest {
  private readonly cache: PieceCache;
  private readonly hashes = new Map<number, Uint8Array>();
  private readonly peers = new Map<string, Peer>();
  private readonly connecting = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly cooling = new Map<string, number>();
  private readonly banned = new Set<string>();
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private readonly locating = new Map<number, (l: Located | null) => void>();
  private readonly hostGate = new Gate(HOST_PARALLEL);
  private readonly budget: UploadBudget;
  private readonly maxPeers: number;
  private readonly offIncoming: () => void;
  private fileId: string | null = null;
  private size = 0;
  private count = 0;
  private nextReq = MESH_REQ_BASE;
  private haveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHave = '';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private fromHost = 0;
  private fromPeers = 0;
  private servedClosed = 0;
  private closed = false;
  private onMessage: (ev: { data?: unknown }) => void = () => undefined;

  private constructor(private readonly o: MeshGuestOptions) {
    this.cache = new PieceCache(o.cacheBytes ?? DEFAULT_CACHE_BYTES, () => this.scheduleHave());
    this.maxPeers = o.maxPeers ?? 8;
    this.budget = new UploadBudget(mbpsToBytesPerSec(o.serveMbps ?? DEFAULT_UPLOAD_MBPS / 3));
    this.offIncoming = o.connector.onIncoming((id, channel) => this.adopt(id, channel));
  }

  /**
   * Négocie le maillage avec l'hôte (MESH?) pendant que la taille du fichier est demandée. Rend null si l'hôte ne le propose
   * pas (version ancienne), si la taille des morceaux diffère, ou en cas d'échec : le relais direct continue de marcher.
   */
  static async negotiate(o: MeshGuestOptions): Promise<MeshGuest | null> {
    const mesh = new MeshGuest(o);
    try {
      return (await mesh.handshake()) ? mesh : (mesh.close(), null);
    } catch {
      mesh.close();
      return null;
    }
  }

  /** Identifiant opaque du fichier (donné par l'hôte). */
  get id(): string | null {
    return this.fileId;
  }

  /** Un pair peut-il être admis (non banni, place restante) ? Sert à la liste d'admission du connecteur. */
  admits(id: string): boolean {
    return !this.closed && !this.banned.has(id) && (this.peers.has(id) || this.peers.size + this.connecting.size < this.maxPeers);
  }

  /** Lecteur par plages d'octets, à donner au lecteur invité à la place du RangeClient. Compte les octets de l'hôte et des pairs. */
  reader(): RangeReader {
    return {
      size: () => this.o.host.size(),
      read: (start, end) => this.read(start, end),
      bytesStats: () => ({ bytesFromHost: this.fromHost, bytesFromPeers: this.fromPeers }),
    };
  }

  stats(): MeshStats {
    let served = this.servedClosed;
    let ready = 0;
    for (const p of this.peers.values()) {
      served += p.server.stats().bytesSent;
      if (p.ready) ready += 1;
    }
    return { peers: ready, bytesFromHost: this.fromHost, bytesFromPeers: this.fromPeers, bytesServed: served, banned: this.banned.size };
  }

  /** Les invités du salon ont changé : ouvre les liaisons manquantes (jusqu'à `maxPeers`), ferme celles d'invités partis. */
  refresh(): void {
    if (this.closed || this.fileId === null) return;
    const wanted = this.o.guests().filter((id) => !this.banned.has(id));
    const set = new Set(wanted);
    for (const [id, p] of [...this.peers]) if (!set.has(id)) this.dropPeer(p);
    const t = Date.now();
    let retryIn = 0;
    for (const id of wanted) {
      if (this.peers.size + this.connecting.size >= this.maxPeers) break;
      if (this.peers.has(id) || this.connecting.has(id)) continue;
      const failed = this.failedAt.get(id);
      if (failed !== undefined && t - failed < RETRY_PEER_MS) {
        retryIn = Math.max(retryIn, RETRY_PEER_MS - (t - failed));
        continue;
      }
      this.connecting.add(id);
      this.o.connector.connect(id).then(
        (channel) => {
          this.connecting.delete(id);
          this.adopt(id, channel);
        },
        () => {
          this.connecting.delete(id);
          this.failedAt.set(id, Date.now());
          this.scheduleRefresh(RETRY_PEER_MS);
        },
      );
    }
    if (retryIn > 0) this.scheduleRefresh(retryIn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.haveTimer !== null) clearTimeout(this.haveTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.haveTimer = this.retryTimer = null;
    this.offIncoming();
    this.o.hostChannel.removeEventListener('message', this.onMessage);
    for (const resolve of [...this.locating.values()]) resolve(null);
    this.locating.clear();
    for (const p of [...this.peers.values()]) this.dropPeer(p);
    this.o.connector.close();
    this.cache.clear();
  }

  // ---- Négociation avec l'hôte ----

  private async handshake(): Promise<boolean> {
    let reply: { fileId: string; shift: number } | null = null;
    this.onMessage = (ev) => {
      const bytes = toBytes(ev.data);
      const frame = bytes ? decodeFrame(bytes) : null;
      if (!frame) return;
      if (frame.t === 'mesh') reply ??= { fileId: frame.fileId, shift: frame.pieceShift };
      else if (frame.t === 'located') this.locating.get(frame.reqId)?.({ hash: frame.hash, holders: frame.holders, pending: frame.pending });
    };
    this.o.hostChannel.addEventListener('message', this.onMessage);
    this.o.hostChannel.send(encodeMeshReq(this.nextReq++));
    // Le canal est ordonné et l'hôte répond à MESH? tout de suite, avant la réponse (asynchrone) à INFO : si INFO est arrivée
    // sans MESH, l'hôte ne connaît pas le maillage. Cet appel doit donc précéder toute autre demande de taille.
    this.size = await this.o.host.size();
    const got = reply as { fileId: string; shift: number } | null;
    if (!got || got.shift !== PIECE_SHIFT || this.size <= 0) return false;
    this.fileId = got.fileId;
    this.count = pieceCount(this.size);
    return true;
  }

  // ---- Lecture ----

  private async read(start: number, end: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new RelayError('bad_request');
    if (this.closed) throw new RelayError('closed');
    if (end > this.size) throw new RelayError('out_of_range');
    const first = Math.floor(start / PIECE_BYTES);
    const last = Math.floor((end - 1) / PIECE_BYTES);
    const out = new Uint8Array(end - start);
    const indexes: number[] = [];
    for (let i = first; i <= last; i += 1) indexes.push(i);
    const gate = new Gate(READ_PARALLEL);
    await Promise.all(
      indexes.map((i) =>
        gate.run(async () => {
          const piece = await this.piece(i);
          const at = i * PIECE_BYTES;
          const from = Math.max(start, at);
          const to = Math.min(end, at + piece.byteLength);
          out.set(piece.subarray(from - at, to - at), from - start);
        }),
      ),
    );
    // Lecture en avant : le morceau suivant, pour que la lecture continue sans attendre.
    if (last + 1 < this.count && !this.cache.has(last + 1)) this.piece(last + 1).catch(() => undefined);
    return out;
  }

  private piece(index: number): Promise<Uint8Array> {
    const hit = this.cache.get(index);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(index);
    if (running) return running;
    const p = this.load(index).finally(() => this.inflight.delete(index));
    this.inflight.set(index, p);
    return p;
  }

  private async load(index: number): Promise<Uint8Array> {
    const b = pieceBounds(index, this.size);
    if (!b) throw new RelayError('out_of_range');
    let hash = this.hashes.get(index) ?? null;
    let advised: string[] = [];
    let pending = false;
    if (!hash || this.candidates(index, advised).length === 0) {
      const loc = await this.locate(index);
      if (loc) ({ hash, advised, pending } = this.learn(index, hash, loc));
    }
    for (let waits = 0; !this.closed; waits += 1) {
      if (hash) {
        for (const peer of this.candidates(index, advised).slice(0, MAX_PEER_TRIES)) {
          const bytes = await this.fromPeer(peer, index, b.start, b.end, hash);
          if (bytes) return bytes;
        }
      }
      if (!pending || waits >= (this.o.pendingWaits ?? 4)) break;
      // Un autre invité reçoit ce morceau de l'hôte : on attend qu'il l'ait, plutôt que de le redemander à l'hôte.
      await sleep(this.o.pendingWaitMs ?? 500);
      const loc = await this.locate(index);
      if (!loc) break;
      ({ hash, advised, pending } = this.learn(index, hash, loc));
    }
    if (this.closed) throw new RelayError('closed');
    const bytes = await this.hostGate.run(() => this.o.host.read(b.start, b.end));
    this.fromHost += bytes.byteLength;
    this.cache.put(index, bytes);
    return bytes;
  }

  private learn(index: number, known: Uint8Array | null, loc: Located): { hash: Uint8Array | null; advised: string[]; pending: boolean } {
    const hash = loc.hash ?? known;
    if (loc.hash) this.hashes.set(index, loc.hash);
    return { hash, advised: loc.holders, pending: loc.pending };
  }

  /** Pairs utilisables pour ce morceau : annoncés par eux (HAVE) ou désignés par l'hôte, non bannis, ni en pause, peu chargés. */
  private candidates(index: number, advised: readonly string[]): Peer[] {
    const t = Date.now();
    const out: Peer[] = [];
    for (const p of this.peers.values()) {
      if (!p.ready || this.banned.has(p.id)) continue;
      if ((this.cooling.get(p.id) ?? 0) > t) continue;
      if (p.have.has(index) || advised.includes(p.id)) out.push(p);
    }
    return out.sort((a, b) => a.active - b.active || Number(advised.includes(b.id)) - Number(advised.includes(a.id)));
  }

  private async fromPeer(peer: Peer, index: number, start: number, end: number, hash: Uint8Array): Promise<Uint8Array | null> {
    peer.active += 1;
    try {
      return await peer.gate.run(() => this.askPeer(peer, index, start, end, hash));
    } finally {
      peer.active -= 1;
    }
  }

  private async askPeer(peer: Peer, index: number, start: number, end: number, hash: Uint8Array): Promise<Uint8Array | null> {
    // Le pair a pu être coupé, banni ou mis en pause pendant l'attente de sa file.
    if (this.closed || this.peers.get(peer.id) !== peer || (this.cooling.get(peer.id) ?? 0) > Date.now()) return null;
    const cached = this.cache.get(index);
    if (cached) return cached;
    const ctl = new AbortController();
    const deadline = setTimeout(() => ctl.abort(), this.o.peerDeadlineMs ?? 8000);
    let bytes: Uint8Array;
    try {
      bytes = await peer.client.read(start, end, ctl.signal);
    } catch (err) {
      this.cooling.set(peer.id, Date.now() + (err instanceof RelayError && err.code === 'busy' ? BUSY_COOL_MS : COOL_MS));
      return null;
    } finally {
      clearTimeout(deadline);
    }
    if (bytes.byteLength !== end - start || !sameHash(await sha256(bytes), hash)) {
      this.ban(peer.id);
      return null;
    }
    this.fromPeers += bytes.byteLength;
    this.cache.put(index, bytes);
    return bytes;
  }

  /** Pair fautif (octets qui ne correspondent pas au hachage de l'hôte) : coupé et banni pour la séance. */
  private ban(id: string): void {
    this.banned.add(id);
    const p = this.peers.get(id);
    if (p) this.dropPeer(p);
    this.o.connector.abort(id);
  }

  private locate(index: number): Promise<Located | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise<Located | null>((resolve) => {
      const reqId = this.nextReq >= 0xffffffff ? MESH_REQ_BASE : this.nextReq++;
      const timer = setTimeout(() => done(null), this.o.locateTimeoutMs ?? 3000);
      const done = (v: Located | null): void => {
        clearTimeout(timer);
        this.locating.delete(reqId);
        resolve(v);
      };
      this.locating.set(reqId, done);
      try {
        this.o.hostChannel.send(encodeLocate(reqId, index));
      } catch {
        done(null);
      }
    });
  }

  // ---- Pairs ----

  private adopt(id: string, channel: ChannelLike): void {
    if (this.closed || this.fileId === null || this.banned.has(id) || this.peers.has(id) || this.peers.size >= this.maxPeers) {
      channel.close();
      return;
    }
    const source: RangeSource = {
      size: () => Promise.resolve(this.size),
      read: (start, end) => this.serveRange(start, end),
    };
    const peer: Peer = {
      id,
      channel,
      client: new RangeClient(channel, { timeoutMs: this.o.peerTimeoutMs ?? 4000, retries: 0, cacheBytes: 0 }),
      server: new RangeServer(source, channel, {
        maxConcurrent: 3,
        maxRangeBytes: 2 * PIECE_BYTES,
        budget: this.budget,
        idleTimeoutMs: 30 * 60_000,
        onIdle: () => this.dropById(id),
        onAbuse: () => this.dropById(id),
        onOther: (frame) => this.onPeerFrame(peer, frame),
      }),
      have: new Set(),
      ready: false,
      active: 0,
      gate: new Gate(PEER_PARALLEL),
    };
    this.peers.set(id, peer);
    channel.addEventListener('close', () => this.dropById(id, channel));
    try {
      channel.send(encodeMesh(0, PIECE_SHIFT, this.fileId));
    } catch {
      this.dropPeer(peer);
    }
  }

  private onPeerFrame(peer: Peer, frame: RelayFrame): void {
    if (frame.t === 'mesh') {
      if (frame.fileId !== this.fileId || frame.pieceShift !== PIECE_SHIFT) {
        this.dropPeer(peer);
        return;
      }
      if (!peer.ready) {
        peer.ready = true;
        this.sendHave(peer.channel, true);
      }
    } else if (frame.t === 'have' && peer.ready) {
      peer.have = fromIntervals(frame.ranges, this.count);
    }
  }

  private dropById(id: string, channel?: ChannelLike): void {
    const p = this.peers.get(id);
    if (p && (channel === undefined || p.channel === channel)) this.dropPeer(p);
  }

  private dropPeer(p: Peer): void {
    if (this.peers.get(p.id) !== p) return;
    this.peers.delete(p.id);
    this.servedClosed += p.server.stats().bytesSent;
    p.server.close();
    p.client.close();
    try {
      p.channel.close();
    } catch {
      /* déjà fermé */
    }
    if (!this.closed) this.scheduleRefresh(RETRY_PEER_MS);
  }

  /** Octets [start, end) servis à un pair, pris dans les morceaux en cache (sinon `out_of_range`). */
  private serveRange(start: number, end: number): Promise<Uint8Array> {
    const first = Math.floor(start / PIECE_BYTES);
    const last = Math.floor((end - 1) / PIECE_BYTES);
    if (first === last) {
      const piece = this.cache.get(first);
      if (!piece || end - first * PIECE_BYTES > piece.byteLength) return Promise.reject(new RelayError('out_of_range'));
      return Promise.resolve(piece.subarray(start - first * PIECE_BYTES, end - first * PIECE_BYTES));
    }
    const out = new Uint8Array(end - start);
    for (let i = first; i <= last; i += 1) {
      const piece = this.cache.get(i);
      const at = i * PIECE_BYTES;
      const from = Math.max(start, at);
      const to = Math.min(end, at + PIECE_BYTES);
      if (!piece || to - at > piece.byteLength) return Promise.reject(new RelayError('out_of_range'));
      out.set(piece.subarray(from - at, to - at), from - start);
    }
    return Promise.resolve(out);
  }

  // ---- Annonces ----

  private scheduleHave(): void {
    if (this.closed || this.haveTimer !== null || this.fileId === null) return;
    this.haveTimer = setTimeout(() => {
      this.haveTimer = null;
      this.sendHave(null, false);
    }, this.o.haveEveryMs ?? 500);
  }

  /** Annonce les morceaux détenus à l'hôte et aux pairs prêts (ou à un seul canal, à son ouverture). */
  private sendHave(only: ChannelLike | null, force: boolean): void {
    const ranges = toIntervals(this.cache.indexes());
    const key = JSON.stringify(ranges);
    if (!force && key === this.lastHave) return;
    if (!only) this.lastHave = key;
    const frame = encodeHave(0, ranges);
    const targets = only ? [only] : [this.o.hostChannel, ...[...this.peers.values()].filter((p) => p.ready).map((p) => p.channel)];
    for (const ch of targets) {
      try {
        if (ch.readyState === 'open') ch.send(frame);
      } catch {
        /* canal fermé : retiré par son événement close */
      }
    }
  }

  private scheduleRefresh(ms: number): void {
    if (this.closed || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refresh();
    }, ms);
  }
}
