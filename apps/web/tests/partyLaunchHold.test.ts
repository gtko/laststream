// Départ d'un salon d'attente (LAST-1615, lot L4) : l'hôte ne ramène pas le salon en arrière (l'alignement sur son lecteur ne
// se fait qu'à la création du salon et au changement d'épisode), et chaque participant avec compte retient la lecture jusqu'à
// ce que sa source soit prête (plafond de 45 s, aucune attente si le réglage « attendre les retardataires » est désactivé).
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

describe('départ du salon d’attente (LAST-1615, L4)', () => {
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

  it('hôte en retard : son lecteur prêt après les autres ne ramène pas le salon en arrière', async () => {
    // Le salon a démarré à 5 s ; le lecteur de l'hôte n'est prêt qu'à 0 s, en pause.
    const client = fakeClient({ state: { playing: true, pos: 5, at: 0, rev: 3 } });
    const pb = await install(client);
    const host = adapterOf(player(0, true));
    pb.viewReady(host);
    clock += 1000;
    pb.tick(host);
    expect(client.control).not.toHaveBeenCalled();
  });

  it('création depuis une lecture : le premier relevé aligne le salon sur le lecteur de l’hôte', async () => {
    const { partyBridge } = await import('../src/party/bridge');
    const { auth } = await import('../src/data/auth');
    auth.profile = { id: 'p1', name: 'Greg', isKid: false } as any;
    const client = fakeClient();
    vi.spyOn(partyBridge, 'connect').mockImplementation(async () => {
      partyBridge.client = client as any;
      partyBridge.controller = new PartyController(client as any, () => clock);
    });
    const host = adapterOf(player(50, false));
    await partyBridge.create(host, 'private');
    clock += 1000;
    partyBridge.tick(host);
    expect(client.control).toHaveBeenCalledWith('play', 50);
  });

  it('épisode suivant décidé par l’hôte : le premier relevé après le changement aligne toujours le salon', async () => {
    const client = fakeClient({ room: { ...room, media: { type: 'series', tmdbId: 42, season: 1, episode: 1 } } });
    const pb = await install(client);
    const next = adapterOf(player(12, false), {
      req: { type: 'tv', id: '42', name: 'Film', season: 1, episode: 2, key: 'tv:42' },
      cur: { season: 1, episode: 2 },
    });
    pb.viewReady(next);
    expect(client.changeEpisode).toHaveBeenCalledWith(1, 2, undefined);
    clock += 1000;
    pb.tick(next);
    expect(client.control).toHaveBeenCalledWith('play', 12);
  });

  it('départ après un compte à rebours : le participant se déclare non prêt, puis prêt quand sa source est chargée', async () => {
    const client = fakeClient();
    let done!: () => void;
    const pb = await install(client, () => new Promise<void>((r) => { done = r; }));
    const run = pb.launchRoom(null, { hold: true });
    expect(client.sendBuffering).toHaveBeenCalledWith(false, 0);
    expect(client.sendBuffering).not.toHaveBeenCalledWith(true, 0);
    pb.viewReady(adapterOf(player(0, true)));
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
    done();
    await run;
  });

  it('le salon déjà en lecture à l’expiration (state diffusé avant le départ) retient quand même', async () => {
    const client = fakeClient({ state: { playing: true, pos: 0, at: 1000, rev: 2 } });
    const pb = await install(client, () => new Promise<void>(() => undefined));
    void pb.launchRoom(null, { hold: true });
    expect(client.sendBuffering).toHaveBeenCalledWith(false, 0);
  });

  it('lanceur rendu sans source prête (panneau Sources) : le salon n’attend plus', async () => {
    const client = fakeClient();
    const pb = await install(client, async () => undefined);
    await pb.launchRoom(null, { hold: true });
    expect(client.sendBuffering).toHaveBeenCalledWith(false, 0);
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });

  it('lanceur rendu pendant le chargement d’une source (adapter présent mais pas prêt) : même libération', async () => {
    const client = fakeClient();
    const pb = await install(client, async () => undefined);
    pb.adapter = () => adapterOf(player(0, true), { ready: false });
    await pb.launchRoom(null, { hold: true });
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });

  it('lanceur rendu avec une source prête : la retenue reste jusqu’à viewReady', async () => {
    const client = fakeClient();
    const pb = await install(client, async () => undefined);
    pb.adapter = () => adapterOf(player(0, true));
    await pb.launchRoom(null, { hold: true });
    expect(client.sendBuffering).not.toHaveBeenCalledWith(true, 0);
  });

  it('retenue d’un lancement plus récent : la fin d’un ancien lanceur ne la libère pas', async () => {
    const client = fakeClient();
    const finish: Array<() => void> = [];
    const pb = await install(client, () => new Promise<void>((r) => { finish.push(r); }));
    const first = pb.launchRoom(null, { hold: true });
    pb.leave();
    pb.client = client as any;
    pb.controller = new PartyController(client as any, () => clock);
    const second = pb.launchRoom(null, { hold: true });
    client.sendBuffering.mockClear();
    finish[0]();
    await first;
    expect(client.sendBuffering).not.toHaveBeenCalledWith(true, 0);
    finish[1]();
    await second;
  });

  it('changement d’épisode : l’empreinte envoyée ne contient jamais de lien', async () => {
    const client = fakeClient({ room: { ...room, media: { type: 'series', tmdbId: 42, season: 1, episode: 1 } } });
    const pb = await install(client);
    const next = adapterOf(player(12, false), {
      req: { type: 'tv', id: '42', name: 'Film', season: 1, episode: 2, key: 'tv:42' },
      cur: { season: 1, episode: 2 },
      view: { filename: 'https://exemple.test/a.mkv', sizeBytes: 5 },
    });
    pb.viewReady(next);
    expect(client.changeEpisode).toHaveBeenCalledWith(1, 2, { fileName: null, size: 5, hash: null });
  });

  it('plafond de 45 s : sans source prête, le participant se déclare prêt pour ne pas bloquer le salon', async () => {
    const client = fakeClient();
    const pb = await install(client, () => new Promise<void>(() => undefined));
    vi.useFakeTimers();
    void pb.launchRoom(null, { hold: true });
    vi.advanceTimersByTime(44_999);
    expect(client.sendBuffering).not.toHaveBeenCalledWith(true, 0);
    vi.advanceTimersByTime(1);
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });

  it('réglage « attendre les retardataires » désactivé : aucune attente au départ', async () => {
    const client = fakeClient({ settings: { control: 'all', waitLate: 'off', reactions: 'on' } });
    const pb = await install(client, async () => undefined);
    vi.useFakeTimers();
    await pb.launchRoom(null, { hold: true });
    vi.advanceTimersByTime(45_000);
    expect(client.sendBuffering).not.toHaveBeenCalled();
  });

  it('arrivée en cours de film (sans retenue demandée) ou serveur sans réglages v3 : aucune attente', async () => {
    const playing = fakeClient({ state: { playing: true, pos: 30, at: 1000, rev: 4 } });
    const pb = await install(playing, async () => undefined);
    await pb.launchRoom();
    expect(playing.sendBuffering).not.toHaveBeenCalled();
    await pb.launchRoom(null, { hold: false });
    expect(playing.sendBuffering).not.toHaveBeenCalled();
    pb.leave();
    const old = fakeClient({ v3: false });
    const pb2 = await install(old, async () => undefined);
    await pb2.launchRoom(null, { hold: true });
    expect(old.sendBuffering).not.toHaveBeenCalled();
  });

  it('leave() annule le plafond : rien n’est envoyé après la sortie', async () => {
    const client = fakeClient();
    const pb = await install(client, () => new Promise<void>(() => undefined));
    vi.useFakeTimers();
    void pb.launchRoom(null, { hold: true });
    pb.leave();
    vi.advanceTimersByTime(60_000);
    expect(client.sendBuffering).not.toHaveBeenCalledWith(true, 0);
  });

  it('lancement en échec : le participant ne retient plus le salon', async () => {
    const client = fakeClient();
    const pb = await install(client, async () => { throw new Error('boom'); });
    await expect(pb.launchRoom(null, { hold: true })).rejects.toThrow('boom');
    expect(client.sendBuffering).toHaveBeenLastCalledWith(true, 0);
  });
});
