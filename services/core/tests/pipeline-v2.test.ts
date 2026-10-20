import { afterEach, describe, expect, it, vi } from 'vitest';
import { LruCache } from '../src/cache/lru.js';
import { getStreams, type PipelineContext, type PipelineResult } from '../src/pipeline.js';
import type { MediaProbe } from '../src/media/probe.js';
import { decodeCopiesToken } from '../src/play/token.js';
import type { FetchFn } from '../src/sources/http.js';
import { clearUpstreamTasks } from '../src/sources/collect.js';
import type { ContentRef } from '../src/types.js';
import { cfg as baseCfg, GB } from './engine-fixtures.js';

/*
 * Pipeline v2 de bout en bout, sans réseau : sources, Cinemeta, TMDB, sonde et .torrent
 * sont simulés. Chaque test utilise des identifiants IMDb distincts (les caches de métadonnées sont en mémoire).
 */

const SECRET = 'pipeline-v2-test-secret';
const PLAY = 'https://addon.test';
const DEBRID = { service: 'alldebrid', apiKey: 'AD-PIPELINE-KEY-1234' };
const UPSTREAM = { type: 'upstream', name: 'Upstream', url: 'https://upstream.test' };
/** Trois hashes valides (40 hexadécimaux). A a le plus de seeders, puis B, puis C. */
const H = { a: '1'.repeat(40), b: '2'.repeat(40), c: '3'.repeat(40) };

/** Configuration de base : avec une clé debrid (utilisée par l'appareil, jamais par le serveur). */
const cfg = (input: Record<string, unknown> = {}) => baseCfg({ debrid: DEBRID, ...input });

type Route = (url: URL, init?: RequestInit) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Faux fetch : les routes répondent par hôte ; une URL sans route renvoie 404. Toutes les URL appelées sont gardées. */
function routedFetch(routes: Route[]): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    calls.push(url.toString());
    for (const route of routes) {
      const response = route(url, init);
      if (response !== undefined) return response;
    }
    return json({}, 404);
  }) as unknown as FetchFn;
  return { fetch, calls };
}

const CINEMETA: Route = (url) =>
  url.hostname === 'v3-cinemeta.strem.io' ? json({ meta: { runtime: '120 min' } }) : undefined;

const upstreamWith =
  (streams: unknown[]): Route =>
  (url) =>
    url.hostname === 'upstream.test' ? json({ streams }) : undefined;

/** Réponse TMDB : /find puis fiche film (durée, certification FR, date de sortie). */
function tmdbWith(options: { certification?: string; releaseDate?: string; runtime?: number }): Route {
  return (url) => {
    if (url.hostname !== 'api.themoviedb.org') return undefined;
    if (url.pathname.startsWith('/3/find/')) return json({ movie_results: [{ id: 9001 }] });
    if (url.pathname === '/3/movie/9001') {
      const release_dates =
        options.certification === undefined
          ? { results: [] }
          : { results: [{ iso_3166_1: 'FR', release_dates: [{ certification: options.certification }] }] };
      // Année de sortie cohérente avec les releases de test (« 2024 ») : la pipeline écarte les releases d'une autre année.
      return json({ runtime: options.runtime ?? 120, release_date: options.releaseDate ?? '2024-01-01', release_dates });
    }
    return json({}, 404);
  };
}

/** Fabrique de contexte : sonde désactivée, cache de résultats désactivé (sauf test dédié). */
function ctxFor(fetch: FetchFn, extra: Partial<PipelineContext> = {}): PipelineContext {
  return {
    playBaseUrl: PLAY,
    configToken: 'TOKEN',
    secret: SECRET,
    fetch,
    probe: async () => null,
    cache: false,
    // Mode client (seul mode) : les torrents sont livrés sans URL, avec leur infoHash.
    deliverTorrents: true,
    ...extra,
  };
}

const movie = (imdb: string): ContentRef => ({ type: 'movie', id: imdb, imdbId: imdb });

/** Jeton d'une URL /play/c/ : décodé avec le secret du test. */
function copiesOfUrl(url: string | undefined): ReturnType<typeof decodeCopiesToken> {
  const marker = '/play/c/';
  const at = url?.indexOf(marker) ?? -1;
  if (url === undefined || at < 0) return null;
  return decodeCopiesToken(url.slice(at + marker.length), SECRET);
}

/** infoHash de la copie de tête d'un stream : lu dans le jeton /play/c/ (un stream ne porte jamais d'infoHash à lire en P2P). */
const hashOf = (stream: { url?: string; infoHash?: string } | undefined): string | undefined =>
  stream?.infoHash ?? copiesOfUrl(stream?.url)?.copies[0]?.infoHash;

/** Trois copies d'un même release (même titre, hashes différents) : A (50 seeders), B (20), C (5). */
const THREE_COPIES = [
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.a, description: '👤 50' },
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.b, description: '👤 20' },
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.c, description: '👤 5' },
];

describe('pipeline v2 : sonde audio et langues vérifiées', () => {
  it('sonde : la langue vérifiée reçoit ✓ et le flux dont l audio n est pas français est écarté', async () => {
    const probe = async (url: string): Promise<MediaProbe | null> => ({
      container: 'mp4',
      subtitles: [],
      audio: [{ lang: url.includes('/aaa') ? 'fr' : 'en', codec: 'AAC', channels: 2 }],
    });
    const { fetch } = routedFetch([
      CINEMETA,
      upstreamWith([
        { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-AAA', url: 'https://cdn.test/aaa' },
        { name: 'Upstream', title: 'Film.2024.VFF.720p.WEB-DL.H264-BBB', url: 'https://cdn.test/bbb' },
      ]),
    ]);
    const config = cfg({
      sources: [UPSTREAM],
      languages: { preferred: ['fr'], fallbackToOthers: false },
      audio: { verifiedLanguagesOnly: true },
    });
    const result = await getStreams(config, movie('tt7100003'), ctxFor(fetch, { probe }));

    expect(result.streams.map((s) => s.url)).toEqual(['https://cdn.test/aaa']);
    expect(result.streams[0]?.laststream).toMatchObject({ verifiedLanguages: ['fr'] });
    expect(result.streams[0]?.description?.split('\n')[0]).toContain('🇫🇷 ✓');
  });
});

describe('pipeline v2 : filtres de contenu (TMDB, Cinemeta)', () => {
  const FILES = [
    { name: 'Upstream', title: 'Film.A.2024.1080p.WEB-DL.H264-XXX', infoHash: H.a, behaviorHints: { videoSize: 2 * GB } },
    { name: 'Upstream', title: 'Film.B.2024.1080p.WEB-DL.H264-YYY', infoHash: H.b, behaviorHints: { videoSize: 20 * GB } },
  ];

  it('limite d âge : un contenu classé 16 est écarté avec une limite de 12, gardé avec 16', async () => {
    const tmdb = tmdbWith({ certification: '16' });
    const { fetch } = routedFetch([CINEMETA, tmdb, upstreamWith(FILES)]);
    const strict = await getStreams(
      cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' }, filters: { ageLimit: 12 } }),
      movie('tt7100010'),
      ctxFor(fetch),
    );
    expect(strict.streams).toEqual([]);

    const allowed = await getStreams(
      cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' }, filters: { ageLimit: 16 } }),
      movie('tt7100011'),
      ctxFor(fetch),
    );
    expect(allowed.streams).toHaveLength(2);
  });

  it('limite d âge active et certification inconnue : le contenu est écarté', async () => {
    const { fetch } = routedFetch([CINEMETA, tmdbWith({}), upstreamWith(FILES)]);
    const result = await getStreams(
      cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' }, filters: { ageLimit: 16 } }),
      movie('tt7100012'),
      ctxFor(fetch),
    );
    expect(result.streams).toEqual([]);
  });

  it('contenu non sorti écarté (masquer les non sortis), sorti gardé', async () => {
    const future = routedFetch([CINEMETA, tmdbWith({ releaseDate: '2099-01-01' }), upstreamWith(FILES)]);
    const hidden = await getStreams(
      cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' } }),
      movie('tt7100013'),
      ctxFor(future.fetch),
    );
    expect(hidden.streams).toEqual([]);

    const past = routedFetch([CINEMETA, tmdbWith({ releaseDate: '2024-01-01' }), upstreamWith(FILES)]);
    const shown = await getStreams(
      cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' } }),
      movie('tt7100014'),
      ctxFor(past.fetch),
    );
    expect(shown.streams).toHaveLength(2);
  });

  it('débit réel = taille / durée : le débit minimum écarte le petit fichier (2 Go sur 120 min)', async () => {
    const tmdb = tmdbWith({ certification: '12' });
    const { fetch } = routedFetch([CINEMETA, tmdb, upstreamWith(FILES)]);
    const result = await getStreams(
      cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' }, filters: { bitrate: { minMbps: 5 } } }),
      movie('tt7100015'),
      ctxFor(fetch),
    );
    expect(result.streams).toHaveLength(1);
    expect(hashOf(result.streams[0])).toBe(H.b);
    expect(result.streams[0]?.laststream).toMatchObject({ bitrateMbps: 23.9 });
  });

  it('film 2026 pas encore sorti en numérique : l’homonyme d’une autre année est écarté, réponse notYetDigital', async () => {
    const odyssey = routedFetch([
      CINEMETA,
      (url) => {
        if (url.hostname !== 'api.themoviedb.org') return undefined;
        if (url.pathname.startsWith('/3/find/')) return json({ movie_results: [{ id: 9002 }] });
        if (url.pathname === '/3/movie/9002') return json({ title: 'L’Odyssée', original_title: 'The Odyssey', runtime: 120, release_date: '2026-07-17', release_dates: { results: [] } });
        if (url.pathname === '/3/movie/9002/release_dates') return json({ results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: '2026-07-17T00:00:00.000Z' }] }] });
        if (url.pathname === '/3/movie/9002/watch/providers') return json({ results: {} });
        return json({}, 404);
      },
      upstreamWith([
        { name: 'Upstream', title: 'The.Odyssey.1997.STV.DVDRip', infoHash: H.a, behaviorHints: { videoSize: 2 * GB } },
        { name: 'Upstream', title: 'The.Odyssey.2026.2160p.WEB-DL', infoHash: H.b, behaviorHints: { videoSize: 20 * GB } },
      ]),
    ]);
    const result = await getStreams(cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' } }), movie('tt7100060'), ctxFor(odyssey.fetch));
    expect(result.notYetDigital).toBe(true);
    expect(result.streams).toHaveLength(1);
    expect(hashOf(result.streams[0])).toBe(H.b);
  });
});

describe('pipeline v2 : cache LRU des résultats', () => {
  it('second appel identique : aucun fetch, moins de 10 ms, clés de cache hachées', async () => {
    const lru = new LruCache<PipelineResult>({ max: 200, ttlMs: 5 * 60 * 1000 });
    const { fetch, calls } = routedFetch([CINEMETA, upstreamWith(THREE_COPIES)]);
    const config = cfg({ sources: [UPSTREAM] });
    const ref = movie('tt7100040');

    const first = await getStreams(config, ref, ctxFor(fetch, { cache: lru }));
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;

    const started = performance.now();
    const second = await getStreams(config, ref, ctxFor(fetch, { cache: lru }));
    const elapsed = performance.now() - started;

    expect(calls).toHaveLength(0);
    expect(elapsed).toBeLessThan(10);
    expect(second).toEqual(first);
    expect(lru.dump().every((entry) => /^[0-9a-f]{64}$/.test(entry.key))).toBe(true);
  });

  it('une erreur de source n est pas mise en cache', async () => {
    const lru = new LruCache<PipelineResult>({ max: 200, ttlMs: 5 * 60 * 1000 });
    const { fetch } = routedFetch([CINEMETA]);
    const config = cfg({ sources: [{ type: 'upstream', name: 'Cassé', url: 'https://broken.test' }] });
    const first = await getStreams(config, movie('tt7100041'), ctxFor(fetch, { cache: lru }));
    expect(first.errors).toHaveLength(1);
    expect(lru.size).toBe(0);
  });
});

/** Route qui ne répond jamais (la réponse n'arrive pas : seule une limite externe peut rendre la main). */
const HANGING_HOST = 'slow.test';
const HANG: Route = (url) =>
  url.hostname === HANGING_HOST ? (new Promise<never>(() => undefined) as unknown as Response) : undefined;

describe('pipeline v2 : groupes de copies', () => {
  it('deux infoHash pour la même release (même nom normalisé) : une seule ligne, copies = 2', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(THREE_COPIES.slice(0, 2))]);
    const result = await getStreams(cfg({ sources: [UPSTREAM] }), movie('tt7100004'), ctxFor(fetch));

    expect(result.streams).toHaveLength(1);
    expect(hashOf(result.streams[0])).toBe(H.a);
    expect(result.streams[0]?.laststream).toMatchObject({ copies: 2 });
    expect(result.streams[0]?.description?.split('\n')[0]).toContain('🔎 Upstream · 2 copies');
  });
});

describe('pipeline v2 : budgets par étape', () => {
  it('source qui ne répond pas : abandonnée au budget, les autres sources gardent leurs résultats', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(THREE_COPIES), HANG]);
    const config = cfg({ sources: [{ type: 'upstream', name: 'Lente', url: `https://${HANGING_HOST}` }, UPSTREAM] });
    const started = Date.now();
    const result = await getStreams(config, movie('tt7100006'), ctxFor(fetch, { budgetsMs: { sources: 150 } }));

    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.laststream).toMatchObject({ copies: 3 });
    expect(result.errors).toEqual([{ source: 'Lente', error: 'Source "Lente" : délai dépassé (150 ms)' }]);
  });
});

describe('pipeline v2 : série en numérotation absolue (anime) sans remappage', () => {
  it('« Titre - 05 » sans remappage connu est gardée ; « Titre S01E04 » est écartée pour S01E05', async () => {
    const cinemeta: Route = (url) =>
      url.hostname === 'v3-cinemeta.strem.io' ? json({ meta: { name: 'Sousou no Frieren', runtime: '24 min' } }) : undefined;
    const { fetch } = routedFetch([
      cinemeta,
      upstreamWith([
        { name: 'Upstream', title: '[SubsPlease] Sousou no Frieren - 05 (1080p) [HEVC]', infoHash: H.a, description: '👤 50' },
        { name: 'Upstream', title: 'Sousou no Frieren S01E04 1080p WEB-DL', infoHash: H.b, description: '👤 20' },
      ]),
    ]);
    const ref: ContentRef = { type: 'series', id: 'tt9900001:1:5', imdbId: 'tt9900001', season: 1, episode: 5 };

    const result = await getStreams(cfg({ sources: [UPSTREAM] }), ref, ctxFor(fetch));

    expect(result.streams.map(hashOf)).toEqual([H.a]);
  });
});

describe('pipeline v2 : série au titre strict (Star Trek 1966, toutes origines)', () => {
  it('Strange New Worlds, Starfleet Academy et The Next Generation écartés ; Star Trek 1966 et S01E01 MULTI gardés', async () => {
    const cinemeta: Route = (url) =>
      url.hostname === 'v3-cinemeta.strem.io'
        ? json({ meta: { name: 'Star Trek', releaseInfo: '1966', runtime: '50 min' } })
        : undefined;
    const H4 = '4'.repeat(40);
    const H5 = '5'.repeat(40);
    const { fetch } = routedFetch([
      cinemeta,
      upstreamWith([
        { name: 'Upstream', title: 'Star.Trek.Strange.New.Worlds.2022.S01E01.1080p.WEB-DL', infoHash: H.a, description: '👤 50' },
        { name: 'Upstream', title: 'Star Trek Starfleet Academy S01E01 MULTI 1080p', infoHash: H.b, description: '👤 40' },
        { name: 'Upstream', title: 'Star.Trek.The.Next.Generation.S01E01.1080p', infoHash: H.c, description: '👤 30' },
        { name: 'Upstream', title: 'Star.Trek.1966.S01E01.MULTI.1080p.WEB-DL', infoHash: H4, description: '👤 20' },
        { name: 'Upstream', title: 'Star Trek S01E01 MULTI 1080p', infoHash: H5, description: '👤 10' },
      ]),
    ]);
    const ref: ContentRef = { type: 'series', id: 'tt0060028:1:1', imdbId: 'tt0060028', season: 1, episode: 1 };

    const result = await getStreams(cfg({ sources: [UPSTREAM] }), ref, ctxFor(fetch));

    expect(result.streams.map(hashOf).sort()).toEqual([H4, H5].sort());
  });
});

describe('pipeline v2 : alias TMDB d’une série (titre alternatif romaji)', () => {
  it('« Sousou.No.Frieren » gardé grâce à l’alias TMDB ; « Frieren Autre Serie » écarté', async () => {
    const cinemeta: Route = (url) =>
      url.hostname === 'v3-cinemeta.strem.io'
        ? json({ meta: { name: 'Frieren', releaseInfo: '2023', runtime: '24 min' } })
        : undefined;
    const tmdbSeries: Route = (url) => {
      if (url.hostname !== 'api.themoviedb.org') return undefined;
      if (url.pathname.startsWith('/3/find/')) return json({ movie_results: [], tv_results: [{ id: 209867 }] });
      if (url.pathname === '/3/tv/209867' && url.searchParams.get('language') === 'fr-FR') {
        return json({ name: 'Frieren : Au-delà du voyage', original_name: '葬送のフリーレン', first_air_date: '2023-09-29' });
      }
      if (url.pathname === '/3/tv/209867') {
        return json({
          name: "Frieren: Beyond Journey's End",
          original_name: '葬送のフリーレン',
          first_air_date: '2023-09-29',
          alternative_titles: { results: [{ iso_3166_1: 'JP', title: 'Sousou no Frieren', type: '' }] },
        });
      }
      return undefined;
    };
    const { fetch } = routedFetch([
      cinemeta,
      tmdbSeries,
      upstreamWith([
        { name: 'Upstream', title: 'Sousou.No.Frieren.S01E05.MULTi.1080p.WEB', infoHash: H.a, description: '👤 50' },
        { name: 'Upstream', title: 'Frieren.Autre.Serie.S01E05.MULTi.1080p', infoHash: H.b, description: '👤 40' },
      ]),
    ]);
    const ref: ContentRef = { type: 'series', id: 'tt9100001:1:5', imdbId: 'tt9100001', season: 1, episode: 5 };

    const result = await getStreams(cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' } }), ref, ctxFor(fetch));

    expect(result.streams.map(hashOf)).toEqual([H.a]);
  });
});

describe('pipeline v2 : épisode diffusé aujourd’hui (minuit à Paris, pas UTC)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('épisode daté d’aujourd’hui à Paris (23 h 03 UTC la veille) : l’addon est interrogé et sa source renvoyée', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T23:03:00Z'));
    const tmdb: Route = (url) => {
      if (url.hostname !== 'api.themoviedb.org') return undefined;
      if (url.pathname === '/3/find/tt9900777') return json({ tv_results: [{ id: 9777 }] });
      if (url.pathname === '/3/tv/9777/season/3/episode/206') return json({ runtime: 47, air_date: '2026-10-19' });
      if (url.pathname === '/3/tv/9777') return json({ name: 'Plus belle la vie', content_ratings: { results: [] } });
      return json({}, 404);
    };
    const { fetch, calls } = routedFetch([
      CINEMETA,
      tmdb,
      upstreamWith([{ name: 'Upstream', title: 'Plus.belle.la.vie.S03E206.1080p.WEB-DL', infoHash: H.a, description: '👤 50' }]),
    ]);
    const ref: ContentRef = { type: 'series', id: 'tt9900777:3:206', imdbId: 'tt9900777', season: 3, episode: 206 };

    const result = await getStreams(cfg({ sources: [UPSTREAM], services: { tmdbToken: 'tmdb-token' } }), ref, ctxFor(fetch));

    expect(calls.some((url) => url.includes('upstream.test'))).toBe(true);
    expect(result.streams.map(hashOf)).toEqual([H.a]);
  });
});

describe('pipeline v2 : réponse vide d’un addon gardée au plus 60 s', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearUpstreamTasks();
  });

  it('film sans flux : la requête suivante, 61 s plus tard, interroge à nouveau l’addon', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    const { fetch, calls } = routedFetch([CINEMETA, upstreamWith([])]);
    const ctx = ctxFor(fetch, { cache: new LruCache<PipelineResult>({ max: 10, ttlMs: 5 * 60 * 1_000 }) });
    const ref: ContentRef = { type: 'movie', id: 'tt9900888', imdbId: 'tt9900888' };
    const upstreamCalls = () => calls.filter((url) => url.includes('upstream.test')).length;

    await getStreams(cfg({ sources: [UPSTREAM] }), ref, ctx);
    const first = upstreamCalls();
    vi.setSystemTime(new Date('2026-10-18T10:01:01Z'));
    await getStreams(cfg({ sources: [UPSTREAM] }), ref, ctx);

    expect(upstreamCalls()).toBeGreaterThan(first);
  });
});
