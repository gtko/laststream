// Source de la watch party (LAST-1615, lot L5) : trame `source` reçue par le client (salon et langue à jour, sans lecture ni
// relance), envoi par l'hôte une fois par version (jamais de lien), prêt déclaré avec le libellé de la source, langue « vo » à la
// création, libellé de l'hôte transmis au lancement, avis de repli hors langue, et `invalid_message` d'un ancien serveur (aucun message).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { createParty } from '../src/data/socialApi';
import { PartyClient, type SocketLike } from '../src/party/client';
import { sameFingerprint, shareableFingerprintOf } from '../src/party/fingerprint';
import { parseServerMessage, partyErrorText } from '../src/party/protocol';
import { chooseSource, partyFallbackNotice } from '../src/party/sourceChoice';

vi.mock('../src/data/socialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialApi')>()),
  createParty: vi.fn(async () => ({ room: { id: 'r2' } })),
  joinParty: vi.fn(async () => ({
    room: { id: 'r1', visibility: 'private', title: 'Film', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 42 }, fingerprint: null },
    wsPath: '/party/r1/ws',
  })),
}));

vi.mock('../src/data/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/config')>()),
  requireBase: () => 'https://api.test',
}));

// Préférence de langue fixée à la version originale : la création du salon doit envoyer « vo ».
vi.mock('../src/data/langPrefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/langPrefs')>()),
  getLangPrefs: () => ({ audio: 'original' }),
}));

// Profil courant fixe : le proxy du magasin ne se laisse pas espionner, on remplace seulement `currentProfile`.
vi.mock('../src/data/userStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/data/userStore')>();
  const store = new Proxy(m.userStore, { get: (target, key) => (key === 'currentProfile' ? () => ({ id: 'p1' }) : Reflect.get(target, key)) });
  return { ...m, userStore: store };
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Faux socket : les trames envoyées sont gardées, les trames du serveur se livrent à la main. */
class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { /* ignoré */ }
  /** Trames envoyées de ce type `t`, décodées. */
  frames(t: string): Array<Record<string, any>> {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.t === t);
  }
  /** Trame du serveur livrée au client. */
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

let sock: FakeSocket;

/** Bienvenue du salon : l'hôte « Greg » est prêt en « VF · 1080p ». `host` dit si c'est le participant de ce test. */
function welcome(host: boolean, roomOver: Record<string, unknown> = {}) {
  return {
    t: 'welcome',
    room: { id: 'r1', visibility: 'private', title: 'Film', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 42 }, fingerprint: null, host: 'Greg', maxParticipants: 20, ...roomOver },
    you: { username: host ? 'Greg' : 'Léa', host, muted: false },
    participants: [
      { username: 'Greg', host: true, avatarColor: '#ff5a36', ready: true, quality: 'VF · 1080p', status: 'ready' },
      { username: 'Léa', host: false, avatarColor: '#7b5cff', ready: false, quality: null, status: 'searching' },
    ],
    chat: [],
    state: { playing: false, pos: 0, at: 0, rev: 1 },
    settings: { control: 'all', waitLate: 'short', reactions: 'on' },
    countdownAt: null,
    vote: null,
  };
}

/** Source lue (vue de la liste) : VF 1080p par défaut. */
function view(over: Record<string, unknown> = {}) {
  return {
    filename: 'Film.2020.1080p.VF.mkv', sizeBytes: 2_000_000_000, hasFrench: true, info: { languages: ['fr'] }, quality: '1080p', group: 'GRP', index: 1, playable: true, ...over,
  };
}

/** Adaptateur du lecteur, la source `v` (null avant le choix). */
function adapter(v: Record<string, unknown> | null) {
  return {
    req: { type: 'movie', id: '42', name: 'Film', season: null, episode: null, key: 'movie:42' },
    cur: { season: null, episode: null },
    view: v,
    poster: '',
    engine: null,
    ready: true,
  } as any;
}

/** Client de salon seul (sans pont) : pas de minuteurs, pour tester la réception des trames. */
function newClient(connect: () => Promise<SocketLike> = async () => sock) {
  return new PartyClient({ connect, setTimer: () => null, clearTimer: () => undefined });
}

/** Rejoint le salon de test par le pont, avec la bienvenue de `host` (rôle de ce participant). */
async function join(host: boolean, roomOver: Record<string, unknown> = {}) {
  const { partyBridge } = await import('../src/party/bridge');
  await partyBridge.connect('r1', 'p1');
  await flush();
  sock.deliver(welcome(host, roomOver));
  return partyBridge;
}

beforeEach(async () => {
  vi.clearAllMocks();
  sock = new FakeSocket();
  vi.stubGlobal('WebSocket', class { constructor() { return sock; } });
  const { partyBridge } = await import('../src/party/bridge');
  partyBridge.leave();
  partyBridge.lastError = '';
});

afterEach(async () => {
  const { partyBridge } = await import('../src/party/bridge');
  partyBridge.leave();
  vi.unstubAllGlobals();
});

describe('trame source : protocole et erreur d’un ancien serveur', () => {
  it('la trame source est reconnue comme message serveur', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'source', fingerprint: null, language: 'fr', by: 'Greg' }))).not.toBeNull();
  });

  it('invalid_message (serveur antérieur qui refuse la trame) n’affiche aucun message', () => {
    expect(partyErrorText('invalid_message')).toBe('');
  });
});

describe('client : réception de la trame source', () => {
  const fp = { fileName: 'Film.mkv', size: 123, hash: null };

  it('salon et langue à jour, sans media ni relance, état de lecture intact', async () => {
    const connect = vi.fn(async () => sock);
    const client = newClient(connect);
    const media = vi.fn();
    const source = vi.fn();
    client.on('media', media);
    client.on('source', source);
    client.start();
    await flush();
    sock.deliver(welcome(false));
    const state = client.state;
    sock.deliver({ t: 'source', fingerprint: fp, language: 'en', by: 'Greg' });
    expect(client.room?.fingerprint).toEqual(fp);
    expect(client.room?.language).toBe('en');
    expect(source).toHaveBeenCalledWith({ fingerprint: fp, language: 'en', by: 'Greg' });
    expect(media).not.toHaveBeenCalled();
    expect(client.state).toBe(state);
    expect(connect).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('arrivant tardif : le welcome fait foi sur une trame source reçue avant', async () => {
    const client = newClient();
    client.start();
    await flush();
    sock.deliver({ t: 'source', fingerprint: fp, language: 'en', by: 'Greg' });
    sock.deliver(welcome(false, { fingerprint: { fileName: 'Autre.mkv', size: null, hash: null }, language: 'fr' }));
    expect(client.room?.fingerprint?.fileName).toBe('Autre.mkv');
    expect(client.room?.language).toBe('fr');
    client.close();
  });

  it('sendSource : refusé à un invité, rien n’est envoyé', async () => {
    const client = newClient();
    client.start();
    await flush();
    sock.deliver(welcome(false));
    expect(client.sendSource(fp, 'fr')).toBe(false);
    expect(sock.frames('source')).toHaveLength(0);
    client.close();
  });

  it('sendSource : hôte, trame avec l’empreinte et la langue, sans lien', async () => {
    const client = newClient();
    client.start();
    await flush();
    sock.deliver(welcome(true));
    expect(client.sendSource(fp, 'fr')).toBe(true);
    expect(sock.frames('source')).toEqual([{ t: 'source', fingerprint: fp, language: 'fr' }]);
    client.close();
  });
});

describe('pont : source du salon, prêt et lancement', () => {
  it('hôte : sa source part une seule fois, puis une seule fois au changement de version', async () => {
    const pb = await join(true);
    pb.viewReady(adapter(view()));
    pb.viewReady(adapter(view()));
    expect(sock.frames('source')).toHaveLength(1);
    expect(sock.frames('source')[0]).toEqual({
      t: 'source', fingerprint: { fileName: 'Film.2020.1080p.VF.mkv', size: 2_000_000_000, hash: null }, language: 'fr',
    });
    // L'écho du salon : la version est connue, pas de nouvel envoi.
    sock.deliver({ t: 'source', fingerprint: sock.frames('source')[0].fingerprint, language: 'fr', by: 'Greg' });
    pb.viewReady(adapter(view()));
    expect(sock.frames('source')).toHaveLength(1);
    // Changement de source par l'hôte : un seul nouvel envoi.
    const other = view({ filename: 'Autre.720p.mkv', sizeBytes: 900_000_000, quality: '720p' });
    pb.viewReady(adapter(other));
    pb.viewReady(adapter(other));
    expect(sock.frames('source')).toHaveLength(2);
    expect(sock.frames('source')[1].fingerprint.fileName).toBe('Autre.720p.mkv');
  });

  it('non-hôte : n’envoie jamais de source', async () => {
    const pb = await join(false);
    pb.viewReady(adapter(view()));
    pb.viewReady(adapter(view({ filename: 'Autre.mkv' })));
    expect(sock.frames('source')).toHaveLength(0);
  });

  it('la source envoyée ne contient aucun lien : un nom de fichier en URL est retiré', async () => {
    const pb = await join(true);
    pb.viewReady(adapter(view({ filename: 'https://exemple.test/Film.mkv' })));
    const frames = sock.frames('source');
    expect(frames).toHaveLength(1);
    expect(frames[0].fingerprint.fileName).toBeNull();
    expect(JSON.stringify(frames[0])).not.toMatch(/https?:|:\/\/|exemple/);
  });

  it('prêt déclaré avec le libellé de la source (« VF · 1080p »), pas la seule résolution', async () => {
    const pb = await join(false);
    pb.viewReady(adapter(view()));
    expect(sock.frames('ready')).toEqual([{ t: 'ready', ready: true, quality: 'VF · 1080p' }]);
  });

  it('une reconnexion (nouveau welcome) redéclare la préparation', async () => {
    const pb = await join(false);
    pb.viewReady(adapter(view()));
    expect(sock.frames('ready')).toHaveLength(1);
    sock.deliver(welcome(false));
    pb.viewReady(adapter(view()));
    expect(sock.frames('ready')).toHaveLength(2);
  });

  it('ancien serveur : invalid_message ne pose aucun message d’erreur au salon', async () => {
    const pb = await join(true);
    sock.deliver({ t: 'error', code: 'invalid_message' });
    expect(pb.lastError).toBe('');
  });

  it('lancement : le libellé de la version de l’hôte est transmis au lecteur', async () => {
    const pb = await join(false);
    const launcher = vi.fn(async (_req: unknown, _opts: unknown) => undefined);
    pb.launcher = launcher as any;
    await pb.launchRoom();
    expect(launcher.mock.calls[0][1]).toMatchObject({ hostLabel: 'VF · 1080p' });
  });

  it('salon d’attente : la langue « vo » (version originale) part au salon, pas « fr »', async () => {
    auth.profile = { id: 'p1', name: 'Greg', isKid: false } as any;
    const { partyBridge } = await import('../src/party/bridge');
    await partyBridge.createLobby({ type: 'movie', id: '42', name: 'Film' }, null, 'private');
    expect(createParty).toHaveBeenCalledWith(expect.objectContaining({ language: 'vo' }));
    partyBridge.leave();
  });
});

describe('choix et avis de source', () => {
  it('libellé de l’hôte : la source de même libellé est choisie avant la langue du salon', () => {
    const vo = view({ filename: 'Film.EN.1080p.mkv', hasFrench: false, info: { languages: ['en'] }, quality: '1080p', index: 2 });
    const vf720 = view({ quality: '720p', index: 3 });
    const choice = chooseSource([vo, vf720] as any, { hostLabel: 'VF · 720p', roomLanguage: null });
    expect(choice.motif).toBe('host');
    expect(choice.view).toBe(vf720);
  });

  it('avis de repli : une source hors langue du salon est annoncée, une source dans la langue non', () => {
    const en = view({ hasFrench: false, info: { languages: ['en'] }, quality: '1080p' }) as any;
    expect(partyFallbackNotice(en, 'fr')).toBe('Source indisponible, essai de la suivante : VO EN · 1080p · hors langue du salon');
    expect(partyFallbackNotice(view() as any, 'fr')).toBeNull();
    expect(partyFallbackNotice(en, null)).toBeNull();
  });
});

describe('empreinte partagée', () => {
  it('une URL en guise de nom de fichier n’est jamais envoyée, la taille reste', () => {
    expect(shareableFingerprintOf({ filename: 'https://exemple.test/a.mkv', sizeBytes: 5 } as any)).toEqual({ fileName: null, size: 5, hash: null });
    expect(shareableFingerprintOf({ filename: 'https://exemple.test/a.mkv' } as any)).toBeNull();
  });

  it('comparaison : les champs à null comptent', () => {
    expect(sameFingerprint(null, null)).toBe(true);
    expect(sameFingerprint({ fileName: 'a', size: 1, hash: null }, { fileName: 'a', size: 1, hash: null })).toBe(true);
    expect(sameFingerprint({ fileName: 'a', size: 1, hash: null }, { fileName: 'b', size: 1, hash: null })).toBe(false);
  });
});
