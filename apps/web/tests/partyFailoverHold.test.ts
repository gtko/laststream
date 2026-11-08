// Retenue du salon pendant le basculement de source (LAST-1620) : le lecteur abandonne sa source en cours de lecture et en essaie
// une autre. Le participant se déclare non prêt (`sourceFailing`), comme au départ d'un salon d'attente (LAST-1615, L4), jusqu'à ce
// que la nouvelle source soit prête (`viewReady`), qu'il n'y ait plus de source à essayer (`sourceFailed`) ou que le plafond
// LAUNCH_HOLD_MAX_MS (45 s, bridge.ts) soit atteint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyController } from '../src/party/controller';

vi.mock('../src/data/socialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialApi')>()),
  createParty: vi.fn(async () => ({ room: { id: 'r1' } })),
}));

// Profil courant fixe : le proxy du magasin ne se laisse pas espionner, on remplace seulement `currentProfile`.
vi.mock('../src/data/userStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/data/userStore')>();
  const store = new Proxy(m.userStore, { get: (target, key) => (key === 'currentProfile' ? () => ({ id: 'p1' }) : Reflect.get(target, key)) });
  return { ...m, userStore: store };
});

let clock = 1000;
const room = { id: 'r1', title: 'Film', poster: null, media: { type: 'movie', tmdbId: 42, season: null, episode: null }, fingerprint: null };

/** Client de salon minimal : seules les méthodes lues ou appelées par le pont et le contrôleur sont simulées. */
function fakeClient(over: Record<string, unknown> = {}) {
  return {
    isHost: true,
    v3: true,
    room,
    settings: { control: 'all', waitLate: 'short', reactions: 'on' },
    state: { playing: false, pos: 0, at: 0, rev: 1 },
    status: 'open',
    countdownAt: null,
    participants: [],
    serverNow: () => clock,
    control: vi.fn(() => true),
    sendBuffering: vi.fn(() => true),
    sendReady: vi.fn(() => true),
    sendStatus: vi.fn(() => true),
    requestSync: vi.fn(() => true),
    changeEpisode: vi.fn(() => true),
    sendSource: vi.fn(() => true),
    close: vi.fn(),
    ...over,
  };
}

/** Lecteur simulé : position et pause mesurables, commandes qui les modifient. */
function player(time: number, paused: boolean) {
  const st = { time, paused };
  return {
    kind: 'html',
    state: () => ({ time: st.time, duration: 7200, paused: st.paused, buffering: false, rate: 1 }),
    play: vi.fn(() => { st.paused = false; }),
    pause: vi.fn(() => { st.paused = true; }),
    seek: vi.fn((t: number) => { st.time = t; }),
    setRate: vi.fn(),
  };
}

function adapterOf(engine: ReturnType<typeof player>, over: Record<string, unknown> = {}) {
  return {
    req: { type: 'movie', id: '42', name: 'Film', season: null, episode: null, key: 'movie:42' },
    cur: { season: null, episode: null },
    view: null,
    poster: '',
    engine,
    ready: true,
    ...over,
  } as any;
}

async function install(client: ReturnType<typeof fakeClient>, launcher?: () => Promise<unknown>) {
  const { partyBridge } = await import('../src/party/bridge');
  partyBridge.client = client as any;
  partyBridge.controller = new PartyController(client as any, () => clock);
  if (launcher) partyBridge.launcher = launcher as any;
  return partyBridge;
}

describe('basculement de source pendant la lecture (LAST-1620)', () => {
  beforeEach(async () => {
    clock = 1000;
    const { partyBridge } = await import('../src/party/bridge');
    partyBridge.leave();
  });
  afterEach(async () => {
    const { partyBridge } = await import('../src/party/bridge');
    partyBridge.leave();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('salon v3 (attente « short ») : le participant se déclare non prêt une seule fois, puis prêt quand la source suivante est chargée', async () => {
    const client = fakeClient();
    const pb = await install(client);
    pb.sourceFailing();
    expect(client.sendBuffering).toHaveBeenCalledTimes(1);
    expect(client.sendBuffering).toHaveBeenCalledWith(false, 0);
    pb.sourceFailing();
    expect(client.sendBuffering).toHaveBeenCalledTimes(1);
    pb.viewReady(adapterOf(player(0, true)));
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });

  it('réglage « attendre les retardataires » à off : aucune retenue', async () => {
    const client = fakeClient({ settings: { control: 'all', waitLate: 'off', reactions: 'on' } });
    const pb = await install(client);
    pb.sourceFailing();
    expect(client.sendBuffering).not.toHaveBeenCalled();
  });

  it('serveur sans réglages v3 : aucune retenue', async () => {
    const client = fakeClient({ v3: false });
    const pb = await install(client);
    pb.sourceFailing();
    expect(client.sendBuffering).not.toHaveBeenCalled();
  });

  it('salon sans titre (room absente) : aucune retenue', async () => {
    const client = fakeClient({ room: null });
    const pb = await install(client);
    pb.sourceFailing();
    expect(client.sendBuffering).not.toHaveBeenCalled();
  });

  it('hors salon : sourceFailing, sourceFailed et roomPosition ne lèvent rien', async () => {
    const { partyBridge: pb } = await import('../src/party/bridge');
    expect(pb.client).toBeNull();
    expect(() => pb.sourceFailing()).not.toThrow();
    expect(() => pb.sourceFailed()).not.toThrow();
    expect(pb.roomPosition()).toBeNull();
  });

  it('plafond de 45 s (LAUNCH_HOLD_MAX_MS) : sans source suivante, le participant se déclare prêt pour ne pas bloquer le salon', async () => {
    const client = fakeClient();
    const pb = await install(client);
    vi.useFakeTimers();
    pb.sourceFailing();
    vi.advanceTimersByTime(44_999);
    expect(client.sendBuffering).not.toHaveBeenCalledWith(true, 0);
    vi.advanceTimersByTime(1);
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });

  it('sourceFailed après sourceFailing : plus aucune source à essayer, le salon n’attend plus', async () => {
    const client = fakeClient();
    const pb = await install(client);
    pb.sourceFailing();
    pb.sourceFailed();
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });

  it('sourceFailed libère aussi le plafond : rien n’est envoyé à son expiration', async () => {
    const client = fakeClient();
    const pb = await install(client);
    vi.useFakeTimers();
    pb.sourceFailing();
    pb.sourceFailed();
    client.sendBuffering.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(client.sendBuffering).not.toHaveBeenCalled();
  });

  it('sourceFailed sans retenue en cours : aucun envoi', async () => {
    const client = fakeClient();
    const pb = await install(client);
    pb.sourceFailed();
    expect(client.sendBuffering).not.toHaveBeenCalled();
  });

  it('roomPosition : position extrapolée de l’état du salon et de l’horloge serveur', async () => {
    const client = fakeClient({ state: { playing: true, pos: 100, at: 1000, rev: 2 }, serverNow: () => 3000 });
    const pb = await install(client);
    expect(pb.roomPosition()).toBe(102);
  });

  it('roomPosition : le salon diffuse un autre titre ou un autre épisode (suivant pas encore annoncé), null', async () => {
    const tvRoom = { ...room, media: { type: 'tv', tmdbId: 7, season: 1, episode: 1 } };
    const client = fakeClient({ room: tvRoom, state: { playing: true, pos: 1500, at: 1000, rev: 2 }, serverNow: () => 3000 });
    const pb = await install(client);
    expect(pb.roomPosition({ id: '7', season: 1, episode: 1 })).toBe(1502);
    expect(pb.roomPosition({ id: '7', season: 1, episode: 2 })).toBeNull();
    expect(pb.roomPosition({ id: '8', season: 1, episode: 1 })).toBeNull();
  });

  it('roomPosition : salon en pause, la position diffusée telle quelle', async () => {
    const client = fakeClient({ state: { playing: false, pos: 100, at: 1000, rev: 2 }, serverNow: () => 3000 });
    const pb = await install(client);
    expect(pb.roomPosition()).toBe(100);
  });

  it('roomPosition : null hors salon, sans état, ou pour une position négative ou non finie', async () => {
    const { partyBridge: pb } = await import('../src/party/bridge');
    expect(pb.roomPosition()).toBeNull();
    const noState = await install(fakeClient({ state: null }));
    expect(noState.roomPosition()).toBeNull();
    const negative = await install(fakeClient({ state: { playing: false, pos: -3, at: 0, rev: 1 } }));
    expect(negative.roomPosition()).toBeNull();
    const notFinite = await install(fakeClient({ state: { playing: false, pos: Number.NaN, at: 0, rev: 1 } }));
    expect(notFinite.roomPosition()).toBeNull();
  });
});
