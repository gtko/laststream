// Onglet « Vus » : historique de films et séries du profil (serveur, repli local), tri, progression, marquer non vu.
// Le faux serveur répond aux routes /user ; le store est le vrai ServerUserStore.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareWatched, isWatchedComplete, watchedProgressLabel, watchedTitleFromWire, watchedTitlesFromSeen } from '../src/data/watchedHistory';

// Importé après le faux fetch (les couches réseau capturent fetch au chargement).
let ServerUserStore: typeof import('../src/data/serverUserStore').ServerUserStore;
beforeAll(async () => {
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: 'CFG' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  ({ ServerUserStore } = await import('../src/data/serverUserStore'));
});

const BASE = 'http://localhost:7000';
const PROFILE = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };

/** État du faux serveur : historique listé, films vus, épisodes vus par série. */
interface Fake {
  history: Array<{ type: 'movie' | 'series'; tmdbId: number; imdbId: null; watched: number; lastWatchedAt: string }>;
  historyApi: boolean;
  refuse: boolean;
  movies: Set<number>;
  series: Map<number, Set<string>>;
}
let fake: Fake;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (!u.pathname.startsWith('/user/profiles/' + PROFILE.id)) return json({ error: 'not_found' }, 404);
  const p = u.pathname.slice(('/user/profiles/' + PROFILE.id).length);
  if (method === 'GET' && p === '/library') return json({ items: [] });
  if (method === 'GET' && p === '/continue') return json({ items: [] });
  if (method === 'GET' && (p === '/follows' || p === '/ratings')) return json({ error: 'not_found' }, 404);
  if (p === '/watched' && method === 'GET') return fake.historyApi ? json({ items: fake.history }) : json({ error: 'not_found' }, 404);
  if (p === '/watched' && method === 'PUT') {
    if (fake.refuse) return json({ error: 'boom' }, 500);
    for (const e of body.episodes ?? [{ season: 0, episode: 0 }]) {
      if (body.type === 'movie') {
        if (body.watched) fake.movies.add(body.tmdbId);
        else fake.movies.delete(body.tmdbId);
      } else {
        const set = fake.series.get(body.tmdbId) ?? new Set<string>();
        const k = e.season + ':' + e.episode;
        if (body.watched) set.add(k);
        else set.delete(k);
        fake.series.set(body.tmdbId, set);
      }
    }
    return new Response(null, { status: 204 });
  }
  const movie = /^\/watched\/movie\/(\d+)$/.exec(p);
  if (movie && method === 'GET') return json({ movie: fake.movies.has(Number(movie[1])) });
  const series = /^\/watched\/series\/(\d+)$/.exec(p);
  if (series && method === 'GET') {
    const eps = [...(fake.series.get(Number(series[1])) ?? [])].map((k) => {
      const [season, episode] = k.split(':').map(Number);
      return { season, episode, finished: true, positionSec: 0, durationSec: 0 };
    });
    return json({ episodes: eps });
  }
  return json({ error: 'not_found' }, 404);
}

function freshStore(): import('../src/data/serverUserStore').ServerUserStore {
  return new ServerUserStore([PROFILE], PROFILE);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: 'CFG' }));
  fake = { history: [], historyApi: true, refuse: false, movies: new Set(), series: new Map() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('historique « vu » : fonctions pures', () => {
  it('tri récent : le plus récemment vu d’abord, puis le titre', () => {
    const items = [
      { lastWatchedAt: 100, name: 'Zèbre', year: '2001' },
      { lastWatchedAt: 300, name: 'Alpha', year: '1999' },
      { lastWatchedAt: 200, name: 'Mille', year: '2010' },
    ];
    expect(items.sort(compareWatched('recent')).map((i) => i.name)).toEqual(['Alpha', 'Mille', 'Zèbre']);
  });

  it('tri titre A→Z (ordre français) et tri par année, la plus récente d’abord', () => {
    const items = [
      { lastWatchedAt: 1, name: 'Éclair', year: '2001' },
      { lastWatchedAt: 2, name: 'Bob', year: '1999' },
      { lastWatchedAt: 3, name: 'Ami', year: '2010' },
    ];
    expect([...items].sort(compareWatched('title')).map((i) => i.name)).toEqual(['Ami', 'Bob', 'Éclair']);
    expect([...items].sort(compareWatched('year')).map((i) => i.year)).toEqual(['2010', '2001', '1999']);
  });

  it('progression de série : « 12/40 épisodes vus » ; sans total, « 3 épisodes vus »', () => {
    expect(watchedProgressLabel(12, 40)).toBe('12/40 épisodes vus');
    expect(watchedProgressLabel(1, 40)).toBe('1/40 épisode vu');
    expect(watchedProgressLabel(3, 0)).toBe('3 épisodes vus');
  });

  it('une série est vue en entier seulement quand le total est atteint', () => {
    expect(isWatchedComplete({ type: 'tv', watched: 39 }, 40)).toBe(false);
    expect(isWatchedComplete({ type: 'tv', watched: 40 }, 40)).toBe(true);
    expect(isWatchedComplete({ type: 'movie', watched: 1 }, 0)).toBe(true);
  });

  it('repli local : films `movie:ID`, épisodes `tv:ID:saison:épisode` (saison 0 exclue)', () => {
    const out = watchedTitlesFromSeen(['movie:550', 'tv:1399:1:1', 'tv:1399:1:2', 'tv:1399:0:1']);
    expect(out).toEqual([
      { key: 'movie:550', type: 'movie', id: 550, watched: 1, lastWatchedAt: 0 },
      { key: 'tv:1399', type: 'tv', id: 1399, watched: 2, lastWatchedAt: 0 },
    ]);
  });

  it('une ligne serveur sans identifiant TMDB n’entre pas dans l’historique', () => {
    expect(watchedTitleFromWire({ type: 'series', tmdbId: null, watched: 2, lastWatchedAt: '2026-01-01T00:00:00.000Z' })).toBeNull();
    expect(watchedTitleFromWire({ type: 'movie', tmdbId: 603, watched: 1, lastWatchedAt: '2026-01-01T00:00:00.000Z' })).toEqual({
      key: 'movie:603', type: 'movie', id: 603, watched: 1, lastWatchedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });
});

describe('historique « vu » : store serveur', () => {
  it('un film vu hors de « Ma liste » apparaît dans l’historique', async () => {
    fake.history = [{ type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: '2026-01-01T10:00:00.000Z' }];
    const store = freshStore();
    await store.hydrate();
    expect(store.inLibrary('movie:603')).toBe(false);
    expect(store.watchedTitles().map((t) => t.key)).toEqual(['movie:603']);
    expect(store.watchedTitle('movie:603')).toEqual(expect.objectContaining({ watched: 1 }));
  });

  it('un film terminé en lecture (côté serveur) devient « vu » sur ce téléphone', async () => {
    fake.history = [{ type: 'movie', tmdbId: 550, imdbId: null, watched: 1, lastWatchedAt: '2026-02-01T20:00:00.000Z' }];
    const store = freshStore();
    await store.hydrate();
    expect(store.isWatched('movie:550')).toBe(true);
  });

  it('une série partiellement vue garde son nombre d’épisodes vus', async () => {
    fake.history = [{ type: 'series', tmdbId: 1396, imdbId: null, watched: 12, lastWatchedAt: '2026-01-02T10:00:00.000Z' }];
    const store = freshStore();
    await store.hydrate();
    const t = store.watchedTitle('tv:1396');
    expect(t?.watched).toBe(12);
    expect(watchedProgressLabel(t?.watched ?? 0, 40)).toBe('12/40 épisodes vus');
  });

  it('tri récent sur l’historique du serveur', async () => {
    fake.history = [
      { type: 'series', tmdbId: 1396, imdbId: null, watched: 3, lastWatchedAt: '2026-01-02T10:00:00.000Z' },
      { type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: '2026-01-01T10:00:00.000Z' },
      { type: 'movie', tmdbId: 550, imdbId: null, watched: 1, lastWatchedAt: '2026-01-03T10:00:00.000Z' },
    ];
    const store = freshStore();
    await store.hydrate();
    const sorted = store.watchedTitles().map((t) => ({ ...t, name: t.key, year: '' })).sort(compareWatched('recent'));
    expect(sorted.map((t) => t.key)).toEqual(['movie:550', 'tv:1396', 'movie:603']);
  });

  it('marquer non vu : le titre disparaît tout de suite, et reste absent après la réponse du serveur', async () => {
    fake.history = [{ type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: '2026-01-01T10:00:00.000Z' }];
    fake.movies.add(603);
    const store = freshStore();
    await store.hydrate();
    const pending = store.setWatched('movie:603', null, false);
    expect(store.watchedTitle('movie:603')).toBeNull();
    expect(await pending).toBe(true);
    expect(store.watchedTitle('movie:603')).toBeNull();
    expect(store.watchedTitles()).toEqual([]);
  });

  it('marquer vu ajoute le film à l’historique, avec la date de maintenant', async () => {
    const store = freshStore();
    await store.hydrate();
    const before = Date.now();
    expect(await store.setWatched('movie:550', null, true)).toBe(true);
    const t = store.watchedTitle('movie:550');
    expect(t).toEqual(expect.objectContaining({ key: 'movie:550', watched: 1 }));
    expect(t!.lastWatchedAt).toBeGreaterThanOrEqual(before);
  });

  it('refus du serveur : l’historique revient à son état d’avant', async () => {
    fake.history = [{ type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: '2026-01-01T10:00:00.000Z' }];
    fake.movies.add(603);
    const store = freshStore();
    await store.hydrate();
    fake.refuse = true;
    expect(await store.setWatched('movie:603', null, false)).toBe(false);
    expect(store.watchedTitle('movie:603')).toEqual(expect.objectContaining({ watched: 1 }));
  });

  it('série : marquer des épisodes non vus retire le compte, la relecture fait foi', async () => {
    fake.history = [{ type: 'series', tmdbId: 1396, imdbId: null, watched: 3, lastWatchedAt: '2026-01-02T10:00:00.000Z' }];
    fake.series.set(1396, new Set(['1:1', '1:2', '1:3']));
    const store = freshStore();
    await store.hydrate();
    await store.setWatched('tv:1396', [{ season: 1, episode: 2 }], false);
    expect(store.watchedTitle('tv:1396')?.watched).toBe(2);
  });

  it('serveur sans route d’historique (404) : l’onglet se nourrit du « vu » de ce téléphone', async () => {
    fake.historyApi = false;
    const store = freshStore();
    await store.hydrate();
    await store.setWatched('movie:550', null, true);
    expect(store.watchedTitles().map((t) => t.key)).toEqual(['movie:550']);
  });
});
