import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnimeMapper,
  type AnimeEntry,
  fetchFribbList,
  FRIBB_ANIME_LIST_URL,
  fromTmdbEpisodeGroups,
  parseFribbList,
} from '../src/anime/mapping.js';
import { SourceError } from '../src/sources/http.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

const LIST_FIXTURE = readFixture('anime-list-mini.json');
const TMDB_FIXTURE = readFixture('tmdb-episode-group.json') as { groups: unknown };

/** Table explicite issue du groupe absolu TMDB (ordre 0-based, doublons et entrées invalides exclus). */
const explicitEpisodes = fromTmdbEpisodeGroups(TMDB_FIXTURE.groups);

/** Horloge de test : le temps n'avance que par advance(). */
const clock = (start = 1_700_000_000_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

/** Fetch factice : enregistre les URL appelées, répond via `respond`. Aucun réseau. */
function fetchStub(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const stub = async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input));
    return respond();
  };
  return { fetch: stub as unknown as typeof fetch, calls };
}

const listResponse = (): Response => new Response(JSON.stringify(LIST_FIXTURE), { status: 200 });

describe('parseFribbList', () => {
  it('garde les entrées TV avec IMDb valide, saison TVDB (à défaut TMDB), et ignore le reste', () => {
    const entries = parseFribbList(LIST_FIXTURE);
    expect(entries).toEqual([
      { imdbId: 'tt0111111', type: 'TV', season: 1 },
      { imdbId: 'tt0111111', type: 'TV', season: 2 },
      { imdbId: 'tt0222222', type: 'TV', season: 1 },
      { imdbId: 'tt0444444', type: 'TV', season: 2 },
    ]);
  });

  it('lève SourceError si la racine n est pas un tableau, sans contenu dans le message', () => {
    expect(() => parseFribbList({ not: 'a list', secret: 'x' })).toThrow(SourceError);
    expect(() => parseFribbList('texte-confidentiel')).toThrow(new SourceError('liste anime au format inattendu'));
  });
});

describe('fromTmdbEpisodeGroups', () => {
  it('construit absolu = order + 1, trié, premier gagnant sur les doublons, invalides ignorés', () => {
    expect(explicitEpisodes).toEqual([
      { absolute: 1, season: 1, episode: 1 },
      { absolute: 2, season: 1, episode: 2 },
      { absolute: 3, season: 2, episode: 1 },
      { absolute: 4, season: 2, episode: 2 },
    ]);
  });

  it('accepte n importe quelle forme non fiable sans lever d erreur', () => {
    expect(fromTmdbEpisodeGroups(undefined)).toEqual([]);
    expect(fromTmdbEpisodeGroups('x')).toEqual([]);
    expect(fromTmdbEpisodeGroups([null, { episodes: 'x' }, { episodes: [null] }])).toEqual([]);
  });
});

describe('AnimeMapper : remappage par décalage', () => {
  const loader = (entries: AnimeEntry[]) => async (): Promise<readonly AnimeEntry[]> => entries;

  it('saison 1 : décalage 0 implicite, numéro absolu = épisode', async () => {
    const mapper = new AnimeMapper({ loadMap: async () => parseFribbList(LIST_FIXTURE) });
    expect(await mapper.toAbsolute('tt0111111', 1, 5)).toBe(5);
    expect(await mapper.toSeasonEpisode('tt0111111', 5)).toEqual({ season: 1, episode: 5 });
  });

  it('saison sans décalage connu : undefined (pas de devinette)', async () => {
    const mapper = new AnimeMapper({ loadMap: async () => parseFribbList(LIST_FIXTURE) });
    expect(await mapper.toAbsolute('tt0111111', 2, 3)).toBeUndefined();
    expect(await mapper.toAbsolute('tt0444444', 2, 1)).toBeUndefined();
  });

  it('décalage fourni par la source : absolu = décalage + épisode, borné par episodeCount', async () => {
    const mapper = new AnimeMapper({
      loadMap: loader([
        { imdbId: 'tt0111111', season: 1, episodeCount: 12 },
        { imdbId: 'tt0111111', season: 2, episodeOffset: 12, episodeCount: 12 },
      ]),
    });
    expect(await mapper.toAbsolute('tt0111111', 2, 3)).toBe(15);
    expect(await mapper.toAbsolute('tt0111111', 2, 13)).toBeUndefined();
    expect(await mapper.toAbsolute('tt0111111', 1, 12)).toBe(12);
    expect(await mapper.toAbsolute('tt0111111', 1, 13)).toBeUndefined();
  });

  it('absolu vers saison : segment le plus proche qui commence avant le numéro', async () => {
    const mapper = new AnimeMapper({
      loadMap: loader([
        { imdbId: 'tt0111111', season: 1, episodeCount: 12 },
        { imdbId: 'tt0111111', season: 2, episodeOffset: 12, episodeCount: 12 },
      ]),
    });
    expect(await mapper.toSeasonEpisode('tt0111111', 5)).toEqual({ season: 1, episode: 5 });
    expect(await mapper.toSeasonEpisode('tt0111111', 15)).toEqual({ season: 2, episode: 3 });
    expect(await mapper.toSeasonEpisode('tt0111111', 25)).toBeUndefined();
  });

  it('sans nombre d épisodes connu, le segment ouvert couvre tout le reste', async () => {
    const mapper = new AnimeMapper({
      loadMap: loader([
        { imdbId: 'tt0111111', season: 1 },
        { imdbId: 'tt0111111', season: 2, episodeOffset: 12 },
      ]),
    });
    expect(await mapper.toSeasonEpisode('tt0111111', 30)).toEqual({ season: 2, episode: 18 });
    expect(await mapper.toSeasonEpisode('tt0111111', 12)).toEqual({ season: 1, episode: 12 });
  });

  it('entrées invalides : identifiant, saison, épisode ou absolu hors bornes', async () => {
    const mapper = new AnimeMapper({ loadMap: async () => parseFribbList(LIST_FIXTURE) });
    expect(await mapper.toAbsolute('tt9999999', 1, 1)).toBeUndefined();
    expect(await mapper.toAbsolute('foo', 1, 1)).toBeUndefined();
    expect(await mapper.toAbsolute('tt0111111', -1, 1)).toBeUndefined();
    expect(await mapper.toAbsolute('tt0111111', 1, 0)).toBeUndefined();
    expect(await mapper.toAbsolute('tt0111111', 1.5, 1)).toBeUndefined();
    expect(await mapper.toSeasonEpisode('tt0111111', 0)).toBeUndefined();
    expect(await mapper.toSeasonEpisode('tt9999999', 3)).toBeUndefined();
  });

  it('l identifiant IMDb est normalisé (casse, espaces)', async () => {
    const mapper = new AnimeMapper({ loadMap: async () => parseFribbList(LIST_FIXTURE) });
    expect(await mapper.toAbsolute('  TT0111111 ', 1, 4)).toBe(4);
  });
});

describe('AnimeMapper : table explicite (groupes TMDB absolus)', () => {
  const mapper = new AnimeMapper({
    loadMap: async () => [{ imdbId: 'tt0555555', season: 1, episodes: explicitEpisodes }],
  });

  it('absolu vers saison et épisode, et saison vers absolu, d après la table', async () => {
    expect(await mapper.toSeasonEpisode('tt0555555', 3)).toEqual({ season: 2, episode: 1 });
    expect(await mapper.toAbsolute('tt0555555', 2, 2)).toBe(4);
  });

  it('une table explicite prime : hors table, undefined même pour la saison 1', async () => {
    expect(await mapper.toAbsolute('tt0555555', 1, 9)).toBeUndefined();
    expect(await mapper.toSeasonEpisode('tt0555555', 99)).toBeUndefined();
  });
});

describe('AnimeMapper : cache mémoire, échecs et concurrence', () => {
  it('la table est chargée une seule fois sur 24 h, puis rechargée', async () => {
    const t = clock();
    const load = vi.fn(async () => parseFribbList(LIST_FIXTURE));
    const mapper = new AnimeMapper({ loadMap: load, now: t.now });
    await mapper.toAbsolute('tt0111111', 1, 1);
    t.advance(23 * HOUR);
    await mapper.toAbsolute('tt0111111', 1, 2);
    expect(load).toHaveBeenCalledTimes(1);
    t.advance(HOUR);
    await mapper.toAbsolute('tt0111111', 1, 3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('les appels simultanés partagent un seul chargement', async () => {
    const load = vi.fn(async () => parseFribbList(LIST_FIXTURE));
    const mapper = new AnimeMapper({ loadMap: load });
    const results = await Promise.all([
      mapper.toAbsolute('tt0111111', 1, 1),
      mapper.toAbsolute('tt0111111', 1, 2),
      mapper.toAbsolute('tt0222222', 1, 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('un échec sans table renvoie undefined, sans lever, et ne réessaie qu après retryAfterMs', async () => {
    const t = clock();
    let attempts = 0;
    const mapper = new AnimeMapper({
      loadMap: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('réseau coupé');
        return parseFribbList(LIST_FIXTURE);
      },
      retryAfterMs: 10 * 60 * 1000,
      now: t.now,
    });
    expect(await mapper.toAbsolute('tt0111111', 1, 1)).toBeUndefined();
    t.advance(9 * 60 * 1000);
    expect(await mapper.toAbsolute('tt0111111', 1, 1)).toBeUndefined();
    expect(attempts).toBe(1);
    t.advance(60 * 1000);
    expect(await mapper.toAbsolute('tt0111111', 1, 1)).toBe(1);
    expect(attempts).toBe(2);
  });

  it('un échec de rechargement garde la table précédente, même périmée', async () => {
    const t = clock();
    let fail = false;
    const mapper = new AnimeMapper({
      loadMap: async () => {
        if (fail) throw new Error('hors ligne');
        return parseFribbList(LIST_FIXTURE);
      },
      now: t.now,
    });
    expect(await mapper.toAbsolute('tt0111111', 1, 7)).toBe(7);
    fail = true;
    t.advance(2 * DAY);
    expect(await mapper.toAbsolute('tt0111111', 1, 7)).toBe(7);
  });

  it('une source qui ne renvoie pas un tableau est traitée comme un échec', async () => {
    const mapper = new AnimeMapper({
      loadMap: async () => null as unknown as readonly AnimeEntry[],
    });
    expect(await mapper.toAbsolute('tt0111111', 1, 1)).toBeUndefined();
    expect(await mapper.toSeasonEpisode('tt0111111', 1)).toBeUndefined();
  });
});

describe('fetchFribbList', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anime-mapping-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('télécharge la liste, la parse, et écrit le cache disque', async () => {
    const cacheFile = join(dir, 'nested', 'anime-list.json');
    const http = fetchStub(listResponse);
    const entries = await fetchFribbList({ fetch: http.fetch, cacheFile });
    expect(entries).toHaveLength(4);
    expect(http.calls).toEqual([FRIBB_ANIME_LIST_URL]);
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual(LIST_FIXTURE);
  });

  it('cache disque frais (< 24 h) : aucune requête réseau', async () => {
    const cacheFile = join(dir, 'anime-list.json');
    await writeFile(cacheFile, JSON.stringify(LIST_FIXTURE), 'utf8');
    const http = fetchStub(() => {
      throw new Error('ne doit pas être appelé');
    });
    const entries = await fetchFribbList({ fetch: http.fetch, cacheFile, now: () => Date.now() + 23 * HOUR });
    expect(entries).toHaveLength(4);
    expect(http.calls).toEqual([]);
  });

  it('cache disque périmé : téléchargement, puis cache mis à jour', async () => {
    const cacheFile = join(dir, 'anime-list.json');
    await writeFile(cacheFile, '[]', 'utf8');
    const past = new Date(Date.now() - 3 * DAY);
    await utimes(cacheFile, past, past);
    const http = fetchStub(listResponse);
    const entries = await fetchFribbList({ fetch: http.fetch, cacheFile });
    expect(entries).toHaveLength(4);
    expect(http.calls).toHaveLength(1);
    expect((await stat(cacheFile)).size).toBeGreaterThan(2);
  });

  it('réseau en panne : le cache disque périmé sert de repli', async () => {
    const cacheFile = join(dir, 'anime-list.json');
    await writeFile(cacheFile, JSON.stringify(LIST_FIXTURE), 'utf8');
    const http = fetchStub(() => {
      throw new TypeError('fetch failed');
    });
    const entries = await fetchFribbList({ fetch: http.fetch, cacheFile, now: () => Date.now() + 5 * DAY });
    expect(entries).toHaveLength(4);
    expect(http.calls).toHaveLength(1);
  });

  it('réponse HTTP en erreur sans cache : SourceError sans URL dans le message', async () => {
    const http = fetchStub(() => new Response('oops', { status: 503 }));
    const failure = fetchFribbList({ fetch: http.fetch, cacheFile: join(dir, 'absent.json') });
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    await expect(failure).rejects.toThrow('HTTP 503');
    await expect(failure).rejects.not.toThrow('githubusercontent');
  });

  it('réseau en panne et aucun cache : SourceError générique, sans URL ni détail brut', async () => {
    const http = fetchStub(() => {
      throw new TypeError('getaddrinfo ENOTFOUND raw.githubusercontent.com');
    });
    const failure = fetchFribbList({ fetch: http.fetch });
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    await expect(failure).rejects.not.toThrow('githubusercontent');
    await expect(failure).rejects.not.toThrow('ENOTFOUND');
  });

  it('cache disque corrompu : ignoré, téléchargement utilisé', async () => {
    const cacheFile = join(dir, 'anime-list.json');
    await writeFile(cacheFile, '{pas du json', 'utf8');
    const http = fetchStub(listResponse);
    const entries = await fetchFribbList({ fetch: http.fetch, cacheFile });
    expect(entries).toHaveLength(4);
    expect(http.calls).toHaveLength(1);
  });

  it('réseau en panne et cache corrompu : SourceError, sans contenu du cache', async () => {
    const cacheFile = join(dir, 'anime-list.json');
    await writeFile(cacheFile, '{"secret":"valeur-confidentielle"', 'utf8');
    const http = fetchStub(() => {
      throw new TypeError('down');
    });
    const failure = fetchFribbList({ fetch: http.fetch, cacheFile, now: () => Date.now() + 5 * DAY });
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    await expect(failure).rejects.not.toThrow('valeur-confidentielle');
  });

  it('branché sur AnimeMapper : remappage de bout en bout, sans réseau pendant la fraîcheur du cache', async () => {
    const cacheFile = join(dir, 'anime-list.json');
    await writeFile(cacheFile, JSON.stringify(LIST_FIXTURE), 'utf8');
    const http = fetchStub(() => {
      throw new Error('ne doit pas être appelé');
    });
    const mapper = new AnimeMapper({
      loadMap: () => fetchFribbList({ fetch: http.fetch, cacheFile, now: () => Date.now() }),
    });
    expect(await mapper.toAbsolute('tt0222222', 1, 4)).toBe(4);
    expect(http.calls).toEqual([]);
  });
});
