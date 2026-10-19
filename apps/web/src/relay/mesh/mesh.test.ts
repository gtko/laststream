// @vitest-environment node
// Maillage entre invités : trames, morceaux et cache LRU, hachage, ordonnancement (cache, pair, hôte), repli vers l'hôte
// (pair absent, lent, en erreur, falsifié), morceau rare envoyé à un seul invité, compatibilité (hôte ancien), signalisation.
import { describe, expect, it } from 'vitest';
import { RangeClient } from '../guest';
import { RangeServer, type RangeSource } from '../host';
import { memoryChannelPair, type MemoryChannel } from '../memory';
import {
  decodeFrame, encodeHave, encodeLocate, encodeLocated, encodeMesh, encodeMeshReq, type ChannelLike,
} from '../protocol';
import { MeshGuest, type MeshGuestOptions } from './guest';
import { MeshHostState } from './hostState';
import { PIECE_BYTES, PieceCache, fromIntervals, pieceBounds, pieceCount, sameHash, sha256, toIntervals } from './pieces';
import { RtcConnector, meshTransport, type PeerConnector } from './rtc';
import { parseSignal, type RelaySignal, type SignalTransport } from '../peer';

const MIB = 1024 * 1024;

function seededBytes(n: number, seed = 0x1234567): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('délai dépassé en attendant la condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

// ---- Trames ----

describe('trames du maillage', () => {
  it('aller-retour : MESH?, MESH, HAVE, LOCATE, LOCATED', () => {
    expect(decodeFrame(encodeMeshReq(7))).toEqual({ t: 'mesh_req', reqId: 7 });
    expect(decodeFrame(encodeMesh(0, 20, 'abc123'))).toEqual({ t: 'mesh', reqId: 0, pieceShift: 20, fileId: 'abc123' });
    const ranges = [{ start: 0, len: 3 }, { start: 10, len: 1 }];
    expect(decodeFrame(encodeHave(0, ranges))).toEqual({ t: 'have', reqId: 0, ranges });
    expect(decodeFrame(encodeLocate(9, 42))).toEqual({ t: 'locate', reqId: 9, index: 42 });
    const hash = new Uint8Array(32).fill(7);
    expect(decodeFrame(encodeLocated(9, 42, hash, ['p1', 'peer-2'], false))).toEqual({ t: 'located', reqId: 9, index: 42, pending: false, hash, holders: ['p1', 'peer-2'] });
    expect(decodeFrame(encodeLocated(9, 1, null, [], true))).toEqual({ t: 'located', reqId: 9, index: 1, pending: true, hash: null, holders: [] });
  });

  it('trames malformées : refusées sans exception', () => {
    expect(decodeFrame(new Uint8Array([32, 0, 0, 0, 1, 9]))).toBeNull();
    const have = encodeHave(0, [{ start: 0, len: 2 }]);
    expect(decodeFrame(have.subarray(0, have.byteLength - 1))).toBeNull();
    expect(decodeFrame(encodeHave(0, [{ start: 0, len: 0 }]))).toBeNull();
    const located = encodeLocated(1, 1, null, ['abc']);
    expect(decodeFrame(located.subarray(0, located.byteLength - 1))).toBeNull();
    expect(decodeFrame(new Uint8Array([35, 0, 0, 0, 1, 0, 0]))).toBeNull();
    const mesh = encodeMesh(0, 20, 'x');
    mesh[5] = 3; // taille de morceau déraisonnable
    expect(decodeFrame(mesh)).toBeNull();
  });
});

// ---- Morceaux, intervalles, cache ----

describe('morceaux', () => {
  it('bornes : le dernier morceau est plus court, hors fichier refusé', () => {
    const size = 2 * PIECE_BYTES + 10;
    expect(pieceCount(size)).toBe(3);
    expect(pieceBounds(0, size)).toEqual({ start: 0, end: PIECE_BYTES });
    expect(pieceBounds(2, size)).toEqual({ start: 2 * PIECE_BYTES, end: size });
    expect(pieceBounds(3, size)).toBeNull();
    expect(pieceBounds(-1, size)).toBeNull();
  });

  it('intervalles : fusion des index contigus, retour à l’ensemble, borne contre les annonces hostiles', () => {
    expect(toIntervals([5, 1, 2, 3, 9, 10])).toEqual([{ start: 1, len: 3 }, { start: 5, len: 1 }, { start: 9, len: 2 }]);
    expect(toIntervals([])).toEqual([]);
    expect([...fromIntervals([{ start: 1, len: 3 }, { start: 9, len: 2 }], 100)]).toEqual([1, 2, 3, 9, 10]);
    expect(fromIntervals([{ start: 0, len: 4_000_000_000 }], 50).size).toBe(50);
  });

  it('SHA-256 : valeur connue et comparaison', async () => {
    const h = await sha256(new TextEncoder().encode('abc'));
    expect([...h.subarray(0, 4)]).toEqual([0xba, 0x78, 0x16, 0xbf]);
    expect(sameHash(h, h.slice())).toBe(true);
    expect(sameHash(h, new Uint8Array(32))).toBe(false);
  });

  it('cache LRU borné en octets : le moins récemment utilisé part, un accès le garde', () => {
    let changes = 0;
    const cache = new PieceCache(3 * 100, () => (changes += 1));
    cache.put(1, new Uint8Array(100));
    cache.put(2, new Uint8Array(100));
    cache.put(3, new Uint8Array(100));
    expect(cache.get(1)).not.toBeNull(); // 1 redevient le plus récent
    cache.put(4, new Uint8Array(100)); // évince 2
    expect(cache.indexes().sort()).toEqual([1, 3, 4]);
    expect(cache.bytes).toBe(300);
    expect(cache.has(2)).toBe(false);
    cache.put(5, new Uint8Array(1000)); // plus grand que la limite : ignoré
    expect(cache.has(5)).toBe(false);
    expect(changes).toBe(4);
    cache.clear();
    expect(cache.bytes).toBe(0);
  });
});

// ---- Réseau en mémoire ----

/** Couche de liaison factice : relie deux invités par une paire de canaux en mémoire. */
class MemNet {
  readonly nodes = new Map<string, { incoming: Set<(id: string, ch: ChannelLike) => void>; allow: (id: string) => boolean }>();
  /** Invités injoignables (la liaison échoue). */
  readonly down = new Set<string>();

  private readonly pairs = new Map<string, { ends: Record<string, MemoryChannel>; taken: Set<string> }>();

  /** Une seule liaison par couple d'invités (comme RtcConnector) : un connect croisé reprend l'extrémité déjà créée. */
  connector(self: string, allow: (id: string) => boolean = () => true): PeerConnector {
    const incoming = new Set<(id: string, ch: ChannelLike) => void>();
    this.nodes.set(self, { incoming, allow });
    return {
      connect: (peer) => {
        const target = this.nodes.get(peer);
        if (!target || this.down.has(peer) || !target.allow(self)) return Promise.reject(new Error('unavailable'));
        const key = [self, peer].sort().join('|');
        const known = this.pairs.get(key);
        if (known) {
          known.taken.add(self);
          return Promise.resolve(known.ends[self]!);
        }
        const [a, b] = memoryChannelPair(0);
        const link = { ends: { [self]: a, [peer]: b }, taken: new Set([self]) };
        this.pairs.set(key, link);
        setTimeout(() => {
          this.pairs.delete(key);
          if (!link.taken.has(peer)) target.incoming.forEach((cb) => cb(self, b));
        }, 0);
        return Promise.resolve(a);
      },
      onIncoming: (cb) => {
        incoming.add(cb);
        return () => incoming.delete(cb);
      },
      abort: () => undefined,
      close: () => undefined,
    };
  }
}

interface Rig {
  bytes: Uint8Array;
  hostState: MeshHostState;
  /** Octets lus dans la source de l'hôte. */
  sourceReads: { bytes: number };
  /** Octets que le RangeServer a émis vers les invités. */
  served: Map<string, () => number>;
  net: MemNet;
  addGuest: (id: string, o?: Partial<MeshGuestOptions> & { legacyHost?: boolean }) => Promise<{ mesh: MeshGuest | null; client: RangeClient; hostCh: MemoryChannel }>;
  guestIds: string[];
}

function rig(size: number, hostOpts: { mesh?: boolean; pendingMs?: number } = {}): Rig {
  const bytes = seededBytes(size);
  const reads = { bytes: 0 };
  const inner: RangeSource = {
    size: async () => bytes.byteLength,
    read: async (start, end) => {
      reads.bytes += end - start;
      await new Promise((r) => setTimeout(r, 1));
      return bytes.slice(start, end);
    },
  };
  const hostState = new MeshHostState({ fileId: 'fichier-opaque-1', pendingMs: hostOpts.pendingMs ?? 3000 });
  const source = hostOpts.mesh === false ? inner : hostState.wrap(inner);
  const net = new MemNet();
  const served = new Map<string, () => number>();
  const guestIds: string[] = [];
  return {
    bytes,
    hostState,
    sourceReads: reads,
    served,
    net,
    guestIds,
    async addGuest(id, o = {}) {
      const [hostCh, guestCh] = memoryChannelPair(0);
      const server = new RangeServer(source, hostCh, {
        onOther: hostOpts.mesh === false ? undefined : hostState.attach(id, hostCh, () => source.size()),
      });
      served.set(id, () => server.stats().bytesSent);
      const client = new RangeClient(guestCh, { retryDelayMs: 1, timeoutMs: 2000 });
      guestIds.push(id);
      const mesh = await MeshGuest.negotiate({
        hostChannel: guestCh,
        host: client,
        connector: net.connector(id),
        guests: () => guestIds.filter((g) => g !== id),
        haveEveryMs: 10,
        serveMbps: 4000,
        peerTimeoutMs: 150,
        peerDeadlineMs: 600,
        locateTimeoutMs: 500,
        pendingWaitMs: 20,
        ...o,
      });
      return { mesh, client, hostCh };
    },
  };
}

async function readAll(mesh: MeshGuest, size: number, step = 700 * 1024): Promise<Uint8Array> {
  const reader = mesh.reader();
  const out = new Uint8Array(size);
  for (let p = 0; p < size; p += step) out.set(await reader.read(p, Math.min(size, p + step)), p);
  return out;
}

const SIZE = 5 * MIB + 12345;

describe('maillage : lecture par morceaux', () => {
  it('seul avec l’hôte : octets exacts, tout vient de l’hôte, le cache évite de relire', async () => {
    const r = rig(SIZE);
    const a = (await r.addGuest('A')).mesh!;
    expect(a).not.toBeNull();
    expect(a.id).toBe('fichier-opaque-1');
    expect(same(await readAll(a, SIZE), r.bytes)).toBe(true);
    expect(a.stats().bytesFromPeers).toBe(0);
    expect(a.stats().bytesFromHost).toBe(SIZE);
    const before = r.sourceReads.bytes;
    expect(same(await a.reader().read(1000, 2 * MIB), r.bytes.subarray(1000, 2 * MIB))).toBe(true);
    expect(r.sourceReads.bytes).toBe(before);
    a.close();
  });

  it('un 2e invité reçoit ses morceaux du 1er : les octets viennent des pairs, vérifiés, et l’hôte n’envoie presque plus rien', async () => {
    const r = rig(SIZE);
    const a = (await r.addGuest('A')).mesh!;
    const b = (await r.addGuest('B')).mesh!;
    a.refresh();
    b.refresh();
    await readAll(a, SIZE);
    const hostSentA = r.served.get('A')!();
    // A annonce ses morceaux à B (et à l'hôte), l'hôte connaît leurs hachages.
    await until(() => (b as unknown as { peers: Map<string, { have: Set<number> }> }).peers.get('A')?.have.size === pieceCount(SIZE));
    const out = await readAll(b, SIZE);
    expect(same(out, r.bytes)).toBe(true);
    const s = b.stats();
    expect(s.bytesFromPeers).toBe(SIZE);
    expect(s.bytesFromHost).toBe(0);
    expect(r.served.get('B')!()).toBeLessThan(MIB); // seulement des LOCATE, aucun octet de fichier
    expect(a.stats().bytesServed).toBe(SIZE);
    expect(hostSentA).toBeGreaterThanOrEqual(SIZE);
    expect(r.served.get('A')!()).toBe(hostSentA);
    a.close();
    b.close();
  });

  it('morceau rare : deux invités qui le demandent ensemble, l’hôte ne l’envoie qu’une fois', async () => {
    const r = rig(3 * MIB, { pendingMs: 3000 });
    const a = (await r.addGuest('A')).mesh!;
    const b = (await r.addGuest('B', { pendingWaitMs: 25, pendingWaits: 40 })).mesh!;
    a.refresh();
    b.refresh();
    await until(() => (b as unknown as { peers: Map<string, { ready: boolean }> }).peers.get('A')?.ready === true);
    // A demande en premier (reste en tête) ; B demande les mêmes morceaux aussitôt : il patiente puis les prend chez A.
    const pa = a.reader().read(0, 3 * MIB);
    await new Promise((res) => setTimeout(res, 5));
    const pb = b.reader().read(0, 3 * MIB);
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(same(ra, r.bytes)).toBe(true);
    expect(same(rb, r.bytes)).toBe(true);
    // Chaque morceau n'a été lu à la source qu'une fois (par A) ; B l'a pris chez A.
    expect(r.sourceReads.bytes).toBe(3 * MIB);
    expect(b.stats().bytesFromHost).toBe(0);
    expect(b.stats().bytesFromPeers).toBe(3 * MIB);
    a.close();
    b.close();
  });
});

describe('maillage : repli vers l’hôte', () => {
  async function pair(opts: Partial<MeshGuestOptions> = {}) {
    const r = rig(3 * MIB);
    const a = (await r.addGuest('A')).mesh!;
    const b = (await r.addGuest('B', opts)).mesh!;
    a.refresh();
    b.refresh();
    await readAll(a, 3 * MIB);
    await until(() => (b as unknown as { peers: Map<string, { have: Set<number> }> }).peers.get('A')?.have.size === 3);
    // L'hôte doit avoir les hachages avant que B s'adresse à A.
    await until(() => r.hostState.hashOf(0) !== null && r.hostState.hashOf(2) !== null);
    return { r, a, b };
  }

  it('pair lent : délai dépassé, le morceau vient de l’hôte, le pair est mis en pause', async () => {
    const { r, a, b } = await pair({ peerTimeoutMs: 60, peerDeadlineMs: 300 });
    (a as unknown as { serveRange: () => Promise<never> }).serveRange = () => new Promise(() => undefined);
    const out = await readAll(b, 3 * MIB);
    expect(same(out, r.bytes)).toBe(true);
    expect(b.stats().bytesFromPeers).toBe(0);
    expect(b.stats().bytesFromHost).toBe(3 * MIB);
    expect(b.stats().banned).toBe(0);
    a.close();
    b.close();
  });

  it('pair en erreur (morceau évincé) : repli immédiat vers l’hôte', async () => {
    const { r, a, b } = await pair();
    (a as unknown as { cache: PieceCache }).cache.clear();
    const out = await readAll(b, 3 * MIB);
    expect(same(out, r.bytes)).toBe(true);
    expect(b.stats().bytesFromPeers).toBe(0);
    expect(b.stats().bytesFromHost).toBe(3 * MIB);
    a.close();
    b.close();
  });

  it('pair absent (liaison fermée) : repli vers l’hôte', async () => {
    const { r, a, b } = await pair();
    a.close();
    const out = await readAll(b, 3 * MIB);
    expect(same(out, r.bytes)).toBe(true);
    expect(b.stats().bytesFromHost).toBe(3 * MIB);
    b.close();
  });

  it('pair qui falsifie un morceau : détecté par le hachage, banni, morceau redemandé à l’hôte, données exactes', async () => {
    const { r, a, b } = await pair();
    const cache = (a as unknown as { cache: PieceCache }).cache;
    const bad = r.bytes.slice(0, PIECE_BYTES);
    bad[1000] ^= 0xff;
    cache.put(0, bad);
    const out = await readAll(b, 3 * MIB);
    expect(same(out, r.bytes)).toBe(true);
    expect(b.stats().banned).toBe(1);
    // Le morceau falsifié n'est jamais entré dans le cache de B ; les autres, sains, ont pu venir de A avant le bannissement.
    expect(same((b as unknown as { cache: PieceCache }).cache.get(0)!, r.bytes.subarray(0, PIECE_BYTES))).toBe(true);
    expect(b.admits('A')).toBe(false);
    a.close();
    b.close();
  });

  it('sans hachage connu de l’hôte, aucun pair n’est utilisé', async () => {
    const r = rig(2 * MIB);
    const a = (await r.addGuest('A')).mesh!;
    const b = (await r.addGuest('B')).mesh!;
    // A détient un morceau que l'hôte n'a jamais haché (injecté) : B ne peut pas le vérifier, il le lit chez l'hôte.
    (a as unknown as { cache: PieceCache }).cache.put(0, new Uint8Array(PIECE_BYTES).fill(9));
    a.refresh();
    b.refresh();
    await until(() => (b as unknown as { peers: Map<string, { have: Set<number> }> }).peers.get('A')?.have.has(0) === true);
    const out = await b.reader().read(0, PIECE_BYTES);
    expect(same(out, r.bytes.subarray(0, PIECE_BYTES))).toBe(true);
    expect(b.stats().bytesFromPeers).toBe(0);
    a.close();
    b.close();
  });
});

describe('maillage : limites et compatibilité', () => {
  it('cache borné : l’invité ne garde pas plus que la limite, et relit ce qu’il a perdu', async () => {
    const r = rig(4 * MIB);
    const a = (await r.addGuest('A', { cacheBytes: 2 * MIB })).mesh!;
    expect(same(await readAll(a, 4 * MIB), r.bytes)).toBe(true);
    expect((a as unknown as { cache: PieceCache }).cache.bytes).toBeLessThanOrEqual(2 * MIB);
    expect(same(await a.reader().read(0, 1000), r.bytes.subarray(0, 1000))).toBe(true);
    a.close();
  });

  it('plafond de pairs : jamais plus de maxPeers liaisons', async () => {
    const r = rig(MIB);
    const meshes: MeshGuest[] = [];
    for (const id of ['A', 'B', 'C', 'D', 'E']) meshes.push((await r.addGuest(id, { maxPeers: 2 })).mesh!);
    for (const m of meshes) m.refresh();
    await new Promise((res) => setTimeout(res, 100));
    for (const m of meshes) expect((m as unknown as { peers: Map<string, unknown> }).peers.size).toBeLessThanOrEqual(2);
    meshes.forEach((m) => m.close());
  });

  it('hôte ancien (sans maillage) : negotiate rend null et le relais direct continue de marcher', async () => {
    const r = rig(2 * MIB, { mesh: false });
    const g = await r.addGuest('A');
    expect(g.mesh).toBeNull();
    expect(same(await g.client.read(100, MIB), r.bytes.subarray(100, MIB))).toBe(true);
  });

  it('invité ancien (sans maillage) face à un hôte à maillage : relais direct inchangé, trames inconnues ignorées', async () => {
    const r = rig(2 * MIB);
    const [hostCh, guestCh] = memoryChannelPair(0);
    const source = r.hostState.wrap({ size: async () => r.bytes.byteLength, read: async (s, e) => r.bytes.slice(s, e) });
    new RangeServer(source, hostCh, { onOther: r.hostState.attach('legacy', hostCh, () => source.size()) });
    const legacy = new RangeClient(guestCh, { retryDelayMs: 1 });
    expect(same(await legacy.read(0, 1.5 * MIB), r.bytes.subarray(0, 1.5 * MIB))).toBe(true);
    // Un invité récent peut coexister sur un autre canal.
    const g = await r.addGuest('A');
    expect(g.mesh).not.toBeNull();
    g.mesh!.close();
  });

  it('l’hôte ne lit jamais la source pour un LOCATE, et ignore un index hors fichier', async () => {
    const r = rig(2 * MIB);
    const [hostCh, guestCh] = memoryChannelPair(0);
    const source = r.hostState.wrap({ size: async () => r.bytes.byteLength, read: async (s, e) => r.bytes.slice(s, e) });
    new RangeServer(source, hostCh, { onOther: r.hostState.attach('g', hostCh, () => source.size()) });
    const got: unknown[] = [];
    guestCh.addEventListener('message', (ev) => got.push(decodeFrame(new Uint8Array(ev.data as ArrayBuffer))));
    guestCh.send(encodeLocate(5, 1));
    guestCh.send(encodeLocate(6, 99));
    await until(() => got.length >= 1);
    await new Promise((res) => setTimeout(res, 20));
    expect(got).toEqual([{ t: 'located', reqId: 5, index: 1, pending: false, hash: null, holders: [] }]);
    expect(r.sourceReads.bytes).toBe(0);
  });

  it('HAVE hostile (intervalle géant) : borné au nombre de morceaux, sans boucle interminable', async () => {
    const r = rig(2 * MIB);
    const [hostCh, guestCh] = memoryChannelPair(0);
    const source = r.hostState.wrap({ size: async () => r.bytes.byteLength, read: async (s, e) => r.bytes.slice(s, e) });
    new RangeServer(source, hostCh, { onOther: r.hostState.attach('g', hostCh, () => source.size()) });
    guestCh.send(encodeHave(0, [{ start: 0, len: 4_000_000_000 }]));
    await new Promise((res) => setTimeout(res, 20));
    expect(r.hostState.guests).toEqual(['g']);
  });
});

// ---- Signalisation ----

function bus(): (self: string) => SignalTransport {
  const handlers = new Map<string, Set<(from: string, data: unknown) => void>>();
  return (self) => ({
    send(to: string, data: RelaySignal): void {
      const wire: unknown = JSON.parse(JSON.stringify(data));
      setTimeout(() => handlers.get(to)?.forEach((h) => h(self, wire)), 0);
    },
    onMessage(cb): () => void {
      let set = handlers.get(self);
      if (!set) handlers.set(self, (set = new Set()));
      set.add(cb);
      return () => set?.delete(cb);
    },
  });
}

class FakePc {
  connectionState: RTCPeerConnectionState = 'new';
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  onicecandidate: ((ev: { candidate: { toJSON(): object } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private dc: (MemoryChannel & { onopen?: () => void }) | null = null;
  constructor(private readonly shared: { ch?: { a: MemoryChannel; b: MemoryChannel }; label?: string }) {}
  createDataChannel(label: string): unknown {
    const [a, b] = memoryChannelPair(0);
    this.shared.ch = { a, b };
    this.shared.label = label;
    (a as { readyState: string }).readyState = 'connecting';
    this.dc = a;
    return a;
  }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'OFFER' };
  }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return { type: 'answer', sdp: 'ANSWER' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(desc: { type: string }): Promise<void> {
    const ch = this.shared.ch;
    if (desc.type === 'offer' && ch) this.ondatachannel?.({ channel: Object.assign(ch.b, { label: this.shared.label }) });
    if (desc.type === 'answer' && this.dc) {
      (this.dc as { readyState: string }).readyState = 'open';
      this.dc.onopen?.();
    }
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed';
  }
}

describe('signalisation du maillage', () => {
  function connectors(allowA = true, allowB = true) {
    const make = bus();
    const sent: unknown[] = [];
    const wrap = (t: SignalTransport): SignalTransport => ({
      send: (to, d) => {
        sent.push(JSON.parse(JSON.stringify({ ...d, to })));
        t.send(to, d);
      },
      onMessage: (cb) => t.onMessage(cb),
    });
    const shared = {};
    const a = new RtcConnector(meshTransport(wrap(make('a'))), 'a', { allow: () => allowA, createPc: () => new FakePc(shared) as unknown as RTCPeerConnection, timeoutMs: 400 });
    const b = new RtcConnector(meshTransport(wrap(make('b'))), 'b', { allow: () => allowB, createPc: () => new FakePc(shared) as unknown as RTCPeerConnection, timeoutMs: 400 });
    return { a, b, sent };
  }

  it('tous les messages portent l’étiquette mesh ; le plus petit identifiant fait l’offre quel que soit l’initiateur', async () => {
    for (const initiator of ['a', 'b'] as const) {
      const { a, b, sent } = connectors();
      const incoming: string[] = [];
      (initiator === 'a' ? b : a).onIncoming((id) => incoming.push(id));
      const ch = await (initiator === 'a' ? a.connect('b') : b.connect('a'));
      expect(ch.readyState).toBe('open');
      expect(sent.length).toBeGreaterThan(0);
      for (const m of sent) expect(m).toMatchObject({ m: 'mesh' });
      const offers = sent.filter((m) => (m as { t: string }).t === 'offer') as Array<{ to: string }>;
      expect(offers).toHaveLength(1);
      expect(offers[0]!.to).toBe('b'); // a < b : a offre à b
      await until(() => incoming.length === 1);
      a.close();
      b.close();
    }
  });

  it('pair non admis : aucune offre, la connexion échoue au délai', async () => {
    const { a, b, sent } = connectors(true, false);
    await expect(a.connect('b')).rejects.toThrow();
    expect(sent.filter((m) => (m as { t: string }).t === 'offer')).toHaveLength(0);
    a.close();
    b.close();
  });

  it('le transport de maillage ignore la signalisation hôte et ne laisse passer que m:mesh', () => {
    const received: unknown[] = [];
    const handlers: Array<(from: string, raw: unknown) => void> = [];
    const base: SignalTransport = { send: () => undefined, onMessage: (cb) => (handlers.push(cb), () => undefined) };
    meshTransport(base).onMessage((from, raw) => received.push([from, raw]));
    handlers[0]!('x', { t: 'hello' });
    handlers[0]!('x', { m: 'mesh', t: 'hello' });
    handlers[0]!('x', null);
    expect(received).toEqual([['x', { m: 'mesh', t: 'hello' }]]);
    expect(parseSignal({ m: 'mesh', t: 'hello' })).toEqual({ t: 'hello' });
  });
});
