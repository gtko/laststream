// Connexion hôte/invité : ICE (STUN fixe, TURN injecté seulement), validation des signaux, poignée de main par signalisation
// abstraite (RTCPeerConnection factice reliée en mémoire) puis lecture exacte, et délai de connexion.
import { describe, expect, it } from 'vitest';
import { RangeClient } from './guest';
import type { RangeSource } from './host';
import { memoryChannelPair, type MemoryChannel } from './memory';
import { RelayError } from './protocol';
import { RelayGuest, RelayHost, buildIceServers, parseSignal, type RelaySignal, type SignalTransport } from './peer';

const payload = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >>> 8)) & 0xff);

function memSource(bytes: Uint8Array): RangeSource {
  return {
    size: async () => bytes.byteLength,
    read: async (start, end) => bytes.slice(start, end),
  };
}

/** Transport de signalisation en mémoire : chaque envoi est sérialisé en JSON puis livré en tâche différée. */
function signalBus(): (self: string) => SignalTransport {
  const handlers = new Map<string, Set<(from: string, data: unknown) => void>>();
  return (self) => ({
    send(to: string, data: RelaySignal): void {
      const wire: unknown = JSON.parse(JSON.stringify(data));
      setTimeout(() => {
        for (const h of handlers.get(to) ?? []) h(self, wire);
      }, 0);
    },
    onMessage(cb): () => void {
      let set = handlers.get(self);
      if (!set) {
        set = new Set();
        handlers.set(self, set);
      }
      set.add(cb);
      return () => set?.delete(cb);
    },
  });
}

interface Wire {
  ch?: { host: MemoryChannel; guest: MemoryChannel };
}

/** RTCPeerConnection factice : la piste de données est une paire de canaux en mémoire, sans réseau ni ICE. */
class FakePc {
  connectionState: RTCPeerConnectionState = 'new';
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  onicecandidate: ((ev: { candidate: { toJSON(): object } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(private readonly role: 'host' | 'guest', private readonly wire: Wire) {}
  createDataChannel(): unknown {
    const [host, guest] = memoryChannelPair(0);
    this.wire.ch = { host, guest };
    return host;
  }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'OFFER' };
  }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return { type: 'answer', sdp: 'ANSWER' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(desc: { type: string }): Promise<void> {
    if (this.role === 'guest' && desc.type === 'offer' && this.wire.ch) this.ondatachannel?.({ channel: this.wire.ch.guest });
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed';
  }
}

describe('ICE', () => {
  it('STUN Cloudflare par défaut, aucun TURN sans configuration injectée', () => {
    expect(buildIceServers()).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    expect(buildIceServers(null)).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
  });

  it('TURN injecté s’ajoute après le STUN', () => {
    const servers = buildIceServers({ urls: 'turn:turn.example.invalid:3478', username: 'u', credential: 'c' });
    expect(servers).toHaveLength(2);
    expect(servers[1]).toEqual({ urls: 'turn:turn.example.invalid:3478', username: 'u', credential: 'c' });
  });
});

describe('signalisation', () => {
  it('accepte les charges du relais, refuse le reste', () => {
    expect(parseSignal({ t: 'hello' })).toEqual({ t: 'hello' });
    expect(parseSignal({ t: 'offer', sdp: 'v=0' })).toEqual({ t: 'offer', sdp: 'v=0' });
    expect(parseSignal({ t: 'answer', sdp: 'v=0' })).toEqual({ t: 'answer', sdp: 'v=0' });
    expect(parseSignal({ t: 'ice', candidate: null })).toEqual({ t: 'ice', candidate: null });
    expect(parseSignal({ t: 'ice', candidate: { candidate: 'a', sdpMid: '0' } })).toMatchObject({ t: 'ice' });
    expect(parseSignal(null)).toBeNull();
    expect(parseSignal('hello')).toBeNull();
    expect(parseSignal({ t: 'bye' })).toBeNull();
    expect(parseSignal({ t: 'offer' })).toBeNull();
    expect(parseSignal({ t: 'offer', sdp: 'x'.repeat(40_000) })).toBeNull();
    expect(parseSignal({ t: 'ice', candidate: 'texte' })).toBeNull();
  });
});

describe('poignée de main et lecture', () => {
  it('l’invité se connecte à l’hôte par signalisation abstraite puis lit les octets exacts', async () => {
    const bus = signalBus();
    const bytes = payload(2 * 1024 * 1024);
    const wire: Wire = {};
    const host = new RelayHost(memSource(bytes), bus('host'), { allow: () => true, createPc: (c) => new FakePc('host', wire) as unknown as RTCPeerConnection, onStats: () => undefined });
    const guest = new RelayGuest('host', bus('guest'), { createPc: (c) => new FakePc('guest', wire) as unknown as RTCPeerConnection });
    const channel = await guest.connect(2000);
    const client = new RangeClient(channel, { retryDelayMs: 1 });
    const got = await client.read(0, bytes.byteLength);
    let bad = 0;
    for (let i = 0; i < bytes.byteLength; i += 1) if (got[i] !== bytes[i]) bad += 1;
    expect(bad).toBe(0);
    expect(host.guests).toEqual(['guest']);
    host.close();
    guest.close();
    expect(host.guests).toEqual([]);
  });

  it('hôte absent : la connexion échoue par délai (timeout), sans URL', async () => {
    const bus = signalBus();
    const guest = new RelayGuest('host', bus('guest'), { createPc: (c) => new FakePc('guest', {}) as unknown as RTCPeerConnection });
    const err = await guest.connect(30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('timeout');
  });
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Transport manuel : `deliver` simule un message entrant de `from` ; les envois sont notés. */
function manualTransport(): { transport: SignalTransport; sent: Array<{ to: string; data: RelaySignal }>; deliver: (from: string, data: unknown) => void } {
  const sent: Array<{ to: string; data: RelaySignal }> = [];
  let handler: (from: string, data: unknown) => void = () => undefined;
  const transport: SignalTransport = {
    send: (to, data) => {
      sent.push({ to, data });
    },
    onMessage: (cb) => {
      handler = cb;
      return () => undefined;
    },
  };
  return { transport, sent, deliver: (from, data) => handler(from, data) };
}

class IcePc extends FakePc {
  added = 0;
  async addIceCandidate(): Promise<void> {
    this.added += 1;
  }
}

describe('admission et délais de l’hôte', () => {
  it('hello d’un pair refusé par allow : aucune offre, aucune liaison ; l’invité admis reçoit son offre', async () => {
    const { transport, sent, deliver } = manualTransport();
    const host = new RelayHost(memSource(payload(10)), transport, {
      allow: (from) => from === 'bob',
      createPc: () => new FakePc('host', {}) as unknown as RTCPeerConnection,
    });
    deliver('mallory', { t: 'hello' });
    await wait(10);
    expect(sent.filter((m) => m.data.t === 'offer')).toEqual([]);
    expect(host.guests).toEqual([]);
    deliver('bob', { t: 'hello' });
    await wait(10);
    expect(sent.filter((m) => m.data.t === 'offer').map((m) => m.to)).toEqual(['bob']);
    host.close();
  });

  it('réponse jamais reçue : la liaison est fermée au délai de réponse', async () => {
    const { transport, deliver } = manualTransport();
    const host = new RelayHost(memSource(payload(10)), transport, {
      allow: () => true,
      answerTimeoutMs: 30,
      createPc: () => new FakePc('host', {}) as unknown as RTCPeerConnection,
    });
    deliver('bob', { t: 'hello' });
    await wait(10);
    expect(host.guests).toEqual(['bob']);
    await wait(60);
    expect(host.guests).toEqual([]);
    host.close();
  });

  it('candidats ICE reçus avant la réponse : au plus 32 sont retenus', async () => {
    const { transport, deliver } = manualTransport();
    const pcs: IcePc[] = [];
    const host = new RelayHost(memSource(payload(10)), transport, {
      allow: () => true,
      createPc: () => {
        const pc = new IcePc('host', {});
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    deliver('bob', { t: 'hello' });
    await wait(5);
    for (let i = 0; i < 50; i += 1) deliver('bob', { t: 'ice', candidate: { candidate: `c${i}`, sdpMid: '0' } });
    deliver('bob', { t: 'answer', sdp: 'ANSWER' });
    await wait(20);
    expect(pcs[0]?.added).toBeGreaterThan(0);
    expect(pcs[0]?.added).toBeLessThanOrEqual(32);
    host.close();
  });
});
