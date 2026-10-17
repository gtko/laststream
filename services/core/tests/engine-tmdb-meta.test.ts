import { afterEach, describe, expect, it, vi } from 'vitest';
import { certificationAge, getContentMeta } from '../src/engine/tmdb-meta.js';
import type { ContentRef } from '../src/types.js';

const TOKEN = 'tmdb-read-token-XYZ123';
const API = 'https://api.themoviedb.org/3';
const MOVIE: ContentRef = { type: 'movie', id: 'tt0133093', imdbId: 'tt0133093' };
const EPISODE: ContentRef = { type: 'series', id: 'tt0903747:1:4', imdbId: 'tt0903747', season: 1, episode: 4 };
const SERIES: ContentRef = { type: 'series', id: 'tt0903747', imdbId: 'tt0903747' };
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const MOVIE_FIND = `${API}/find/tt0133093?external_source=imdb_id`;
const MOVIE_DETAILS = `${API}/movie/603?append_to_response=release_dates`;
const SERIES_FIND = `${API}/find/tt0903747?external_source=imdb_id`;
const SERIES_DETAILS = `${API}/tv/1396?append_to_response=content_ratings`;
const EPISODE_DETAILS = `${API}/tv/1396/season/1/episode/4`;

type Handler = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Faux fetch : une réponse par URL exacte. Toute URL non prévue répond 500 pour être repérée. */
function routes(table: Record<string, Handler>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const handler = table[String(input)];
    return handler ? handler() : new Response('unexpected', { status: 500 });
  });
}

/** Réponses TMDB du film « Matrix » (id 603) : runtime 136 min, sortie FR -12 et tous publics. */
function matrixTable(details: Record<string, unknown> = {}): Record<string, Handler> {
  return {
    [MOVIE_FIND]: () => json({ movie_results: [{ id: 603 }], tv_results: [] }),
    [MOVIE_DETAILS]: () =>
      json({
        runtime: 136,
        release_date: '1999-03-31',
        release_dates: {
          results: [
            { iso_3166_1: 'US', release_dates: [{ certification: 'R' }] },
            { iso_3166_1: 'FR', release_dates: [{ certification: '-12' }, { certification: '' }] },
          ],
        },
        ...details,
      }),
  };
}

/** Réponses TMDB de « Breaking Bad » (id 1396), épisode 1x04 : 47 min, diffusé le 2008-02-10, classé -18 en FR. */
function seriesTable(): Record<string, Handler> {
  return {
    [SERIES_FIND]: () => json({ movie_results: [], tv_results: [{ id: 1396 }] }),
    [SERIES_DETAILS]: () =>
      json({
        content_ratings: {
          results: [
            { iso_3166_1: 'US', rating: 'TV-MA' },
            { iso_3166_1: 'FR', rating: '-18' },
          ],
        },
      }),
    [EPISODE_DETAILS]: () => json({ runtime: 47, air_date: '2008-02-10' }),
  };
}

function asFetch(mock: ReturnType<typeof routes>): typeof fetch {
  return mock as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('certificationAge', () => {
  it('convertit les classifications FR TMDB en âge minimum', () => {
    expect(certificationAge('-10')).toBe(10);
    expect(certificationAge('-12')).toBe(12);
    expect(certificationAge('-16')).toBe(16);
    expect(certificationAge('-18')).toBe(18);
    expect(certificationAge('12')).toBe(12);
  });

  it('renvoie 0 pour TP et pour une valeur vide (tous publics)', () => {
    expect(certificationAge('TP')).toBe(0);
    expect(certificationAge('')).toBe(0);
    expect(certificationAge('  ')).toBe(0);
  });

  it('renvoie undefined pour une valeur inconnue ou non textuelle', () => {
    expect(certificationAge('U')).toBeUndefined();
    expect(certificationAge('-14')).toBeUndefined();
    expect(certificationAge(12)).toBeUndefined();
    expect(certificationAge(undefined)).toBeUndefined();
  });
});

describe('getContentMeta : film', () => {
  it('renvoie durée, certification FR (la plus restrictive) et date de sortie', async () => {
    const fetchMock = routes(matrixTable());
    const meta = await getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    expect(meta).toEqual({ runtimeSeconds: 136 * 60, certificationFr: 12, releaseDate: '1999-03-31' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('envoie le jeton en Bearer, jamais dans l\'URL', async () => {
    const fetchMock = routes(matrixTable());
    await getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
      expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
  });

  it('une classification FR TP (tous publics) donne 0', () => {
    const fetchMock = routes(
      matrixTable({ release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ certification: 'TP' }] }] } }),
    );
    return getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() }).then((meta) => {
      expect(meta.certificationFr).toBe(0);
    });
  });

  it('sans entrée FR, la certification reste inconnue', async () => {
    const fetchMock = routes(
      matrixTable({ release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] } }),
    );
    const meta = await getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    expect(meta.certificationFr).toBeUndefined();
  });

  it('omet la date de sortie si elle est absente ou mal formée', async () => {
    const fetchMock = routes(matrixTable({ release_date: '' }));
    const meta = await getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    expect(meta).not.toHaveProperty('releaseDate');
    expect(meta.runtimeSeconds).toBe(136 * 60);
  });
});

describe('getContentMeta : série', () => {
  it('renvoie la durée de l\'épisode, sa date de diffusion et la certification FR de la série', async () => {
    const fetchMock = routes(seriesTable());
    const meta = await getContentMeta(EPISODE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    expect(meta).toEqual({ runtimeSeconds: 47 * 60, certificationFr: 18, releaseDate: '2008-02-10' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sans saison ni épisode, n\'appelle pas l\'épisode et ne donne ni durée ni date', async () => {
    const fetchMock = routes(seriesTable());
    const meta = await getContentMeta(SERIES, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    expect(meta).toEqual({ certificationFr: 18 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(EPISODE_DETAILS);
  });
});

describe('getContentMeta : repli sur Cinemeta et absence de jeton', () => {
  it('sans jeton, aucun appel et seul le runtime Cinemeta est renvoyé', async () => {
    const fetchMock = routes(matrixTable());
    expect(await getContentMeta(MOVIE, { fetch: asFetch(fetchMock), cache: new Map() })).toEqual({});
    expect(
      await getContentMeta(MOVIE, { fetch: asFetch(fetchMock), cache: new Map(), cinemetaRuntimeSeconds: 5400 }),
    ).toEqual({ runtimeSeconds: 5400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('la durée TMDB l\'emporte sur celle de Cinemeta', async () => {
    const fetchMock = routes(matrixTable());
    const meta = await getContentMeta(MOVIE, {
      tmdbToken: TOKEN,
      fetch: asFetch(fetchMock),
      cache: new Map(),
      cinemetaRuntimeSeconds: 5400,
    });
    expect(meta.runtimeSeconds).toBe(136 * 60);
  });

  it('si TMDB ne donne pas de durée, Cinemeta complète', async () => {
    const fetchMock = routes(matrixTable({ runtime: null }));
    const meta = await getContentMeta(MOVIE, {
      tmdbToken: TOKEN,
      fetch: asFetch(fetchMock),
      cache: new Map(),
      cinemetaRuntimeSeconds: 5400,
    });
    expect(meta).toEqual({ certificationFr: 12, releaseDate: '1999-03-31', runtimeSeconds: 5400 });
  });

  it('ignore un identifiant IMDb invalide, sans appel', async () => {
    const fetchMock = routes(matrixTable());
    const bad: ContentRef = { type: 'movie', id: 'x', imdbId: 'nope' };
    expect(await getContentMeta(bad, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getContentMeta : erreurs', () => {
  it('ne lève jamais sur une erreur réseau, renvoie {} ou le repli Cinemeta', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const cache = new Map();
    await expect(getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: failing as unknown as typeof fetch, cache })).resolves.toEqual({});
    await expect(
      getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: failing as unknown as typeof fetch, cache, cinemetaRuntimeSeconds: 3000 }),
    ).resolves.toEqual({ runtimeSeconds: 3000 });
  });

  it('ne lève pas sur un corps non JSON et n\'expose jamais le jeton', async () => {
    const fetchMock = routes({ [MOVIE_FIND]: () => new Response('<html>oops</html>', { status: 200 }) });
    const meta = await getContentMeta(MOVIE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() });
    expect(meta).toEqual({});
    expect(JSON.stringify(meta)).not.toContain(TOKEN);
  });

  it('une réponse en erreur serveur n\'est pas mise en cache : la requête est reprise', async () => {
    let failMovie = true;
    const table = matrixTable();
    table[MOVIE_DETAILS] = () => (failMovie ? new Response('boom', { status: 500 }) : json({ runtime: 136 }));
    const fetchMock = routes(table);
    const cache = new Map();
    const options = { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache };

    expect(await getContentMeta(MOVIE, options)).toEqual({});
    failMovie = false;
    expect(await getContentMeta(MOVIE, options)).toEqual({ runtimeSeconds: 136 * 60 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('un épisode introuvable (404) est un résultat définitif : la série reste exploitable', async () => {
    const table = seriesTable();
    table[EPISODE_DETAILS] = () => new Response('gone', { status: 404 });
    const fetchMock = routes(table);
    const meta = await getContentMeta(EPISODE, { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map(), cinemetaRuntimeSeconds: 2700 });
    expect(meta).toEqual({ certificationFr: 18, runtimeSeconds: 2700 });
  });
});

describe('getContentMeta : cache', () => {
  it('ne refait pas les appels dans les 6 heures, puis les refait après', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const fetchMock = routes(matrixTable());
    const options = { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache: new Map() };

    await getContentMeta(MOVIE, options);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock += SIX_HOURS_MS - 1;
    await getContentMeta(MOVIE, options);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock += 2;
    await getContentMeta(MOVIE, options);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('applique le repli Cinemeta même sur un résultat en cache', async () => {
    const fetchMock = routes(matrixTable({ runtime: null }));
    const cache = new Map();
    const options = { tmdbToken: TOKEN, fetch: asFetch(fetchMock), cache };
    await getContentMeta(MOVIE, options);
    const meta = await getContentMeta(MOVIE, { ...options, cinemetaRuntimeSeconds: 4000 });
    expect(meta.runtimeSeconds).toBe(4000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
