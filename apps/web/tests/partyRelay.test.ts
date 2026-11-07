// Pont salon <-> lecteur : partage de la lecture aux invités. Le relais s'ouvre pour une source HTTP(S) lue par l'hôte (lien débridé
// ou direct d'addon), jamais pour un torrent ; un navigateur qui ne peut pas lire la source le signale à l'hôte ; le relais suit
// la présence d'un invité et se ferme avec le salon.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryChannelPair } from '../src/relay/memory';
import type { HostRelaySession as HostSession } from '../src/relay/session';

const relay = vi.hoisted(() => ({ ctor: vi.fn(), close: vi.fn(), real: false }));
vi.mock('../src/relay/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/relay/session')>();
  return {
    ...actual,
    HostRelaySession: class {
      /** Session réelle seulement quand le test le demande (`relay.real`) ; sinon une coquille qui compte les appels. */
      private readonly inner: HostSession | null;
      constructor(opts: ConstructorParameters<typeof HostSession>[0]) {
        relay.ctor(opts);
        this.inner = relay.real ? new actual.HostRelaySession(opts) : null;
      }
      close() { relay.close(); this.inner?.close(); }
      setSubtitles(tracks: Parameters<HostSession['setSubtitles']>[0]) { this.inner?.setSubtitles(tracks); }
      stats() { return this.inner ? this.inner.stats() : { guests: 1, links: 0, bytesSent: 0, rateBps: 0 }; }
    },
  };
});
vi.mock('../src/data/socialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialApi')>()),
  joinParty: vi.fn(async () => ({ room: { id: 'r1' }, wsPath: '/party/r1/ws' })),
}));
vi.mock('../src/data/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/config')>()),
  requireBase: () => 'https://party.test',
}));

const DIRECT = 'https://gtko.github.io/laststream-test-addon/media/test-720p.mp4';

/** Client de salon minimal côté hôte, avec un invité présent (ou non). */
const hostClient = (guest = true) => ({
  isHost: true,
  status: 'open',
  room: { id: 'r1' },
  participants: guest ? [{ username: 'bob', guest: true, peerId: 'peer-bob', host: false, muted: false }] : [{ username: 'alice', host: true, guest: false }],
  on: () => () => undefined,
  sendRtc: () => true,
  close: () => undefined,
  control: () => true,
});

/** Titre en cours, tel que le lecteur le présente au pont (seule la source relayable varie). */
const adapter = (relayUrl: string | null) => ({
  req: { type: 'movie', id: '653', name: 'Nosferatu', key: 'movie:653' }, cur: {}, view: null, poster: '', engine: null, ready: true,
  relayUrl: () => relayUrl,
}) as any;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('partage de lecture : quel lien ouvre le relais', () => {
  let bridge: any;

  beforeEach(async () => {
    ({ partyBridge: bridge } = await import('../src/party/bridge'));
    relay.ctor.mockClear();
    relay.close.mockClear();
    // Lecture de la source : requête pendante (aucun réseau, aucun refus) sauf dans les tests qui le demandent.
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    bridge.controller = { tick: () => undefined, reset: () => undefined, arm: () => undefined };
  });

  afterEach(() => {
    bridge.leave();
    vi.unstubAllGlobals();
  });

  it('source HTTP directe (lien d’addon) : le relais s’ouvre pour l’invité présent', () => {
    bridge.client = hostClient(true);
    bridge.tick(adapter(DIRECT));
    expect(relay.ctor).toHaveBeenCalledTimes(1);
    const opts = relay.ctor.mock.calls[0][0] as { client: unknown; source: { size: unknown; read: unknown } };
    expect(opts.client).toBe(bridge.client);
    expect(typeof opts.source.size).toBe('function');
    expect(typeof opts.source.read).toBe('function');
  });

  it('torrent ou magnet (aucun lien relayable) : aucun relais, même avec un invité', () => {
    bridge.client = hostClient(true);
    bridge.tick(adapter(null));
    expect(relay.ctor).not.toHaveBeenCalled();
  });

  it('pas d’invité : aucun relais, même pour une source HTTP directe', () => {
    bridge.client = hostClient(false);
    bridge.tick(adapter(DIRECT));
    expect(relay.ctor).not.toHaveBeenCalled();
  });

  it('l’invité part : le relais se ferme ; le salon fermé le ferme aussi', () => {
    bridge.client = hostClient(true);
    bridge.tick(adapter(DIRECT));
    expect(relay.close).not.toHaveBeenCalled();
    bridge.client = hostClient(false);
    bridge.tick(adapter(DIRECT));
    expect(relay.close).toHaveBeenCalledTimes(1);
    bridge.client = hostClient(true);
    bridge.tick(adapter(DIRECT));
    expect(relay.ctor).toHaveBeenCalledTimes(2);
    bridge.leave();
    expect(relay.close).toHaveBeenCalledTimes(2);
  });

  it('navigateur qui ne peut pas lire la source (CORS) : signalé à l’hôte, le relais reste ouvert pour répondre aux invités', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    bridge.client = hostClient(true);
    bridge.tick(adapter(DIRECT));
    await flush();
    expect(bridge.relayRefused()).toBe(true);
    expect(relay.ctor).toHaveBeenCalledTimes(1);
    bridge.tick(adapter(DIRECT));
    expect(relay.ctor).toHaveBeenCalledTimes(1);
  });
});

/** WebSocket du salon factice : le test pousse les trames entrantes, les envois sont notés. */
class FakeWs {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data?: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { /* sans effet dans ce test */ }
  recv(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

/** Connexion WebRTC factice côté hôte : une offre, et un canal en mémoire sans trafic. */
class FakeRtcPc {
  connectionState = 'new';
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  createDataChannel(): unknown {
    const [host] = memoryChannelPair(0);
    return host;
  }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: 'OFFER' }; }
  async setLocalDescription(): Promise<void> { /* sans effet */ }
  async setRemoteDescription(): Promise<void> { /* sans effet */ }
  async addIceCandidate(): Promise<void> { /* sans effet */ }
  close(): void { this.connectionState = 'closed'; }
}

describe('partage : l’invité qui arrive est admis tout de suite', () => {
  let bridge: any;

  beforeEach(async () => {
    ({ partyBridge: bridge } = await import('../src/party/bridge'));
    relay.ctor.mockClear();
    relay.close.mockClear();
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
  });

  afterEach(() => {
    relay.real = false;
    bridge.leave();
    bridge.adapter = null;
    vi.unstubAllGlobals();
  });

  it('invité qui rejoint puis envoie son hello dans la même pile d’événements : l’offre part sans attendre un pas du lecteur', async () => {
    relay.real = true;
    const sockets: FakeWs[] = [];
    vi.stubGlobal('WebSocket', class extends FakeWs {
      constructor() {
        super();
        sockets.push(this);
      }
    });
    vi.stubGlobal('RTCPeerConnection', FakeRtcPc);
    await bridge.connect('r1', 'p1');
    await flush();
    const ws = sockets[0];
    ws.recv({ t: 'welcome', you: { username: 'alice', host: true, muted: false }, room: { id: 'r1', title: 'Nosferatu', media: { type: 'movie', tmdbId: 653 } }, state: { playing: false, pos: 0, at: 0, rev: 1 }, serverTime: 0, participants: [{ username: 'alice', host: true, peerId: 'h1' }], chat: [] });
    bridge.controller = { tick: () => undefined, reset: () => undefined, arm: () => undefined };
    // Le lecteur de l'hôte tourne, sans invité : rien n'est ouvert.
    bridge.tick(adapter(DIRECT));
    expect(relay.ctor).not.toHaveBeenCalled();

    // L'invité arrive, son hello suit aussitôt : aucun tick entre les deux.
    ws.recv({ t: 'join', participant: { username: 'bob', guest: true, peerId: 'p1', host: false, muted: false } });
    ws.recv({ type: 'rtc', from: 'p1', data: { t: 'hello' } });
    await flush();
    expect(relay.ctor).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContainEqual({ type: 'rtc', to: 'p1', data: { t: 'offer', sdp: 'OFFER' } });
  });
});

describe('partage : source non relayable (torrent, lien protégé)', () => {
  let bridge: any;

  beforeEach(async () => {
    ({ partyBridge: bridge } = await import('../src/party/bridge'));
  });

  afterEach(() => {
    bridge.leave();
    bridge.adapter = null;
  });

  it('hôte, invité présent, lecture prête, lien non relayable : vrai', () => {
    bridge.client = hostClient(true);
    bridge.adapter = () => adapter(null);
    expect(bridge.relayUnavailable()).toBe(true);
  });

  it('faux dans les autres cas : lien relayable, pas d’invité, lecture pas prête, pas hôte, pas de salon, pas de lecteur', () => {
    bridge.client = hostClient(true);
    bridge.adapter = () => adapter(DIRECT);
    expect(bridge.relayUnavailable()).toBe(false);
    bridge.client = hostClient(false);
    bridge.adapter = () => adapter(null);
    expect(bridge.relayUnavailable()).toBe(false);
    bridge.client = hostClient(true);
    bridge.adapter = () => ({ ...adapter(null), ready: false });
    expect(bridge.relayUnavailable()).toBe(false);
    bridge.client = { ...hostClient(true), isHost: false };
    bridge.adapter = () => adapter(null);
    expect(bridge.relayUnavailable()).toBe(false);
    bridge.client = null;
    bridge.adapter = () => adapter(null);
    expect(bridge.relayUnavailable()).toBe(false);
    bridge.client = hostClient(true);
    bridge.adapter = null;
    expect(bridge.relayUnavailable()).toBe(false);
  });
});
