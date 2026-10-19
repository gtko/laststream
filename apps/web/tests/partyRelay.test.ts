// Pont salon <-> lecteur : partage de la lecture aux invités. Le relais s'ouvre pour une source HTTP(S) lue par l'hôte (lien débridé
// ou direct d'addon), jamais pour un torrent ; un navigateur qui ne peut pas lire la source le signale à l'hôte ; le relais suit
// la présence d'un invité et se ferme avec le salon.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({ ctor: vi.fn(), close: vi.fn() }));
vi.mock('../src/relay/session', () => ({
  HostRelaySession: class {
    constructor(opts: unknown) { relay.ctor(opts); }
    close() { relay.close(); }
    stats() { return { guests: 1, links: 0, bytesSent: 0, rateBps: 0 }; }
  },
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
