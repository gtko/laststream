import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/cache/lru.js';
import { parseTorrent } from '../src/torrent/bencode.js';
import { getStreams, type PipelineContext, type PipelineResult } from '../src/pipeline.js';
import type { MediaProbe } from '../src/media/probe.js';
import { decodeCopiesToken } from '../src/play/token.js';
import type { FetchFn } from '../src/sources/http.js';
import { TorrentCache } from '../src/torrent/fetch-torrent.js';
import type { ContentRef } from '../src/types.js';
import { cfg, GB } from './engine-fixtures.js';
import { monoTorrent } from './torrent-fixtures.js';

/*
 * Pipeline v2 de bout en bout, sans réseau : sources, Cinemeta, TMDB, débrideur, hébergeurs, sonde et .torrent
 * sont simulés. Chaque test utilise des identifiants IMDb distincts (les caches de métadonnées sont en mémoire).
 */

const SECRET = 'pipeline-v2-test-secret';
const PLAY = 'https://addon.test';
const DEBRID = { service: 'alldebrid', apiKey: 'AD-PIPELINE-KEY-1234' };
const UPSTREAM = { type: 'upstream', name: 'Upstream', url: 'https://upstream.test' };
const PROWLARR = { type: 'prowlarr', name: 'Prowlarr', baseUrl: 'https://prowlarr.test', apiKey: 'PR-PIPELINE-KEY-1234' };
/** Trois hashes valides (40 hexadécimaux). A a le plus de seeders, puis B, puis C. */
const H = { a: '1'.repeat(40), b: '2'.repeat(40), c: '3'.repeat(40) };

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
      return json({ runtime: options.runtime ?? 120, release_date: options.releaseDate ?? '2001-01-01', release_dates });
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
    ...extra,
  };
}

/** Faux débrideur : statut « cache » par hash, résolution fixe. */
function fakeDebrid(cached: ReadonlySet<string>) {
  return {
    checkCached: async (hashes: readonly string[]) => new Map(hashes.map((h) => [h, cached.has(h)] as const)),
    resolve: async () => ({ url: 'https://cdn.test/resolved.mkv', filename: 'resolved.mkv', size: 1 }),
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

/** Trois copies d'un même release (même titre, hashes différents) : A (50 seeders), B (20), C (5). */
const THREE_COPIES = [
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.a, description: '👤 50' },
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.b, description: '👤 20' },
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.c, description: '👤 5' },
];

describe('pipeline v2 : groupement, copies et statut cache', () => {
  it('groupe les 3 copies d un même release en une seule ligne, avec copies = 3', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(THREE_COPIES)]);
    const result = await getStreams(cfg({ sources: [UPSTREAM] }), movie('tt7100001'), ctxFor(fetch));

    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.infoHash).toBe(H.a);
    expect(result.streams[0]?.laststream).toMatchObject({ copies: 3 });
    expect(result.streams[0]?.description?.split('\n')[0]).toContain('🔎 Upstream · 3 copies');
  });

  it('jeton /play/c/ : copies cachées d abord, puis par seeders, décodable avec le secret', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(THREE_COPIES)]);
    const config = cfg({ sources: [UPSTREAM], debrid: DEBRID });
    const result = await getStreams(config, movie('tt7100002'), ctxFor(fetch, { debrid: fakeDebrid(new Set([H.b])) }));

    const [stream] = result.streams;
    expect(stream?.url?.startsWith(`${PLAY}/TOKEN/play/c/`)).toBe(true);
    expect(copiesOfUrl(stream?.url)?.copies.map((copy) => copy.infoHash)).toEqual([H.b, H.a, H.c]);
    expect(copiesOfUrl('nope')).toBeNull();
    expect(stream?.name).toBe('[AD⚡] lastAddon 1080p');
    expect(stream?.laststream).toMatchObject({ cached: true, copies: 3 });
  });
});

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

    const past = routedFetch([CINEMETA, tmdbWith({ releaseDate: '2001-01-01' }), upstreamWith(FILES)]);
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
    expect(result.streams[0]?.infoHash).toBe(H.b);
    expect(result.streams[0]?.laststream).toMatchObject({ bitrateMbps: 23.9 });
  });
});

describe('pipeline v2 : liens d hébergeur', () => {
  const HOSTER_FILES = [
    { name: 'Upstream', title: 'Film.Dead.2024.VFF.1080p.WEB-DL', url: 'https://1fichier.test/?dead' },
    { name: 'Upstream', title: 'Film.Live.2024.VFF.1080p.WEB-DL', url: 'https://1fichier.test/?live' },
  ];
  const hosters = {
    getHosts: async () => [],
    hosterFor: (url: string) =>
      url.includes('1fichier.test') ? { name: '1fichier', domains: ['1fichier.test'], patterns: [] } : undefined,
    linkInfos: async (urls: readonly string[]) =>
      new Map(
        urls.map((url) => [
          url,
          url.includes('dead')
            ? { url, alive: false, errorCode: 'LINK_DOWN' }
            : { url, alive: true, filename: 'Film.Live.mkv', size: 2 * GB },
        ]),
      ),
  };

  it('un lien mort est exclu ; le lien vivant passe par /play/c/ (kind hoster) et affiche Lien direct · 1fichier', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(HOSTER_FILES)]);
    const result = await getStreams(
      cfg({ sources: [UPSTREAM], debrid: DEBRID }),
      movie('tt7100020'),
      ctxFor(fetch, { debrid: fakeDebrid(new Set()), hosters }),
    );

    expect(result.streams).toHaveLength(1);
    const [stream] = result.streams;
    expect(copiesOfUrl(stream?.url)?.copies).toEqual([{ url: 'https://1fichier.test/?live', kind: 'hoster' }]);
    expect(stream?.description).toContain('Lien direct · 1fichier');
    expect(JSON.stringify(result.streams)).not.toContain('?dead');
  });

  it('includeHosterLinks=false : les liens d hébergeur sont retirés', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(HOSTER_FILES)]);
    const result = await getStreams(
      cfg({ sources: [UPSTREAM], debrid: DEBRID, filters: { includeHosterLinks: false } }),
      movie('tt7100021'),
      ctxFor(fetch, { debrid: fakeDebrid(new Set()), hosters }),
    );
    expect(result.streams).toEqual([]);
  });
});

/** Prowlarr : un indexeur privé, un résultat dont le .torrent (passkey dans l'URL) est lu pour son infoHash. */
const PRIVATE_TORRENT = monoTorrent({ name: 'Film.Private.2024.1080p.WEB-DL.H264-PRV.mkv', length: 3, private: true });
const PASSKEY_URL = 'https://tracker.test/dl/42?passkey=PASSKEY-XYZ';

/** Routes Prowlarr pour un release privé ; `release` remplace des champs du résultat (ex. `{ guid: undefined }`). */
function prowlarrRoutes(release: Record<string, unknown> = {}): Route[] {
  return [
    // Cinemeta : titre de repli (sans jeton TMDB, Prowlarr reçoit au moins ce titre).
    (url) =>
      url.hostname === 'v3-cinemeta.strem.io'
        ? json({ meta: { name: 'Film', releaseInfo: '2024', runtime: '100 min' } })
        : undefined,
    (url) =>
      url.hostname === 'prowlarr.test' && url.pathname === '/api/v1/indexer'
        ? json([
            {
              id: 1,
              name: 'Alpha',
              protocol: 'torrent',
              enable: true,
              privacy: 'private',
              capabilities: { movieSearchParams: ['q', 'imdbId'], tvSearchParams: ['q', 'season', 'ep', 'imdbId'] },
            },
          ])
        : undefined,
    (url) =>
      url.hostname === 'prowlarr.test' && url.pathname === '/api/v1/search'
        ? json([
            {
              title: 'Film.Private.2024.1080p.WEB-DL.H264-PRV',
              downloadUrl: PASSKEY_URL,
              guid: 'guid-42',
              size: 2 * GB,
              seeders: 9,
              indexerId: 1,
              protocol: 'torrent',
              ...release,
            },
          ])
        : undefined,
    (url) =>
      url.toString() === PASSKEY_URL ? new Response(new Uint8Array(PRIVATE_TORRENT), { status: 200 }) : undefined,
  ];
}

describe('pipeline v2 : torrent privé et sécurité des sorties', () => {
  it('torrent privé sans infoHash : infoHash lu depuis le .torrent mocké, octets gardés par guid', async () => {
    const { fetch } = routedFetch(prowlarrRoutes());
    const torrentCache = new TorrentCache();
    const result = await getStreams(
      cfg({ sources: [PROWLARR] }),
      movie('tt7100030'),
      ctxFor(fetch, { torrentCache }),
    );

    const expected = parseTorrent(new Uint8Array(PRIVATE_TORRENT)).infoHash;
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.infoHash).toBe(expected);
    expect(torrentCache.get('guid-42')).toMatchObject({ kind: 'torrent', infoHash: expected, private: true });
  });

  it('torrent privé en débrid : le jeton porte le guid et le hash, jamais le passkey', async () => {
    const { fetch } = routedFetch(prowlarrRoutes());
    const torrentCache = new TorrentCache();
    const result = await getStreams(
      cfg({ sources: [PROWLARR], debrid: DEBRID }),
      movie('tt7100031'),
      ctxFor(fetch, { torrentCache, debrid: fakeDebrid(new Set()) }),
    );

    const expected = parseTorrent(new Uint8Array(PRIVATE_TORRENT)).infoHash;
    const [stream] = result.streams;
    expect(copiesOfUrl(stream?.url)?.copies).toEqual([{ infoHash: expected, guid: 'guid-42', privateTorrent: true }]);
    expect(JSON.stringify(result.streams)).not.toContain('PASSKEY-XYZ');
  });

  it('aucune fuite : ni downloadUrl, ni passkey, ni URL de tracker dans la sortie JSON', async () => {
    const { fetch } = routedFetch(prowlarrRoutes());
    const result = await getStreams(
      cfg({ sources: [PROWLARR, UPSTREAM], debrid: DEBRID }),
      movie('tt7100032'),
      ctxFor(fetch, { torrentCache: new TorrentCache(), debrid: fakeDebrid(new Set([])) }),
    );
    const output = JSON.stringify(result);
    expect(output).not.toContain('PASSKEY-XYZ');
    expect(output).not.toContain('downloadUrl');
    expect(output).not.toContain('tracker.test');
    expect(output).not.toContain('PR-PIPELINE-KEY-1234');
    expect(output).not.toContain('AD-PIPELINE-KEY-1234');
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
    expect(result.streams[0]?.infoHash).toBe(H.a);
    expect(result.streams[0]?.laststream).toMatchObject({ copies: 2 });
    expect(result.streams[0]?.description?.split('\n')[0]).toContain('🔎 Upstream · 2 copies');
  });
});

describe('pipeline v2 : garde-fou torrent privé (jamais de magnet public)', () => {
  it('torrent privé sans guid : aucune copie jouable, aucun flux, le hash n apparaît nulle part, AllDebrid non sollicité', async () => {
    const { fetch } = routedFetch(prowlarrRoutes({ guid: undefined }));
    const resolved: string[] = [];
    const debrid = {
      checkCached: async () => new Map<string, boolean>(),
      resolve: async (hash: string) => {
        resolved.push(hash);
        return { url: 'https://cdn.test/private.mkv', filename: 'private.mkv', size: 1 };
      },
    };
    const result = await getStreams(
      cfg({ sources: [PROWLARR], debrid: DEBRID }),
      movie('tt7100050'),
      ctxFor(fetch, { torrentCache: new TorrentCache(), debrid }),
    );

    const privateHash = parseTorrent(new Uint8Array(PRIVATE_TORRENT)).infoHash;
    expect(result.streams).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateHash);
    expect(resolved).toEqual([]);
  });

  it('torrent privé sans guid et copie publique du même release : seule la copie publique est jouable', async () => {
    const publicCopy = {
      name: 'Upstream',
      title: 'Film.Private.2024.1080p.WEB-DL.H264-PRV',
      infoHash: H.a,
      description: '👤 5',
    };
    const { fetch } = routedFetch([...prowlarrRoutes({ guid: undefined }), upstreamWith([publicCopy])]);
    const result = await getStreams(
      cfg({ sources: [PROWLARR, UPSTREAM], debrid: DEBRID }),
      movie('tt7100051'),
      ctxFor(fetch, { torrentCache: new TorrentCache(), debrid: fakeDebrid(new Set()) }),
    );

    const privateHash = parseTorrent(new Uint8Array(PRIVATE_TORRENT)).infoHash;
    expect(result.streams).toHaveLength(1);
    expect(copiesOfUrl(result.streams[0]?.url)?.copies).toEqual([{ infoHash: H.a }]);
    expect(JSON.stringify(result)).not.toContain(privateHash);
  });
});

describe('pipeline v2 : budgets par étape', () => {
  it('cache AllDebrid qui ne répond pas : le budget rend la main, flux sans statut cache', async () => {
    const { fetch } = routedFetch([CINEMETA, upstreamWith(THREE_COPIES)]);
    const hanging = {
      checkCached: () => new Promise<Map<string, boolean>>(() => undefined),
      resolve: async () => ({ url: 'https://cdn.test/x.mkv', filename: 'x.mkv', size: 1 }),
    };
    const started = Date.now();
    const result = await getStreams(
      cfg({ sources: [UPSTREAM], debrid: DEBRID }),
      movie('tt7100005'),
      ctxFor(fetch, { debrid: hanging, budgetsMs: { cache: 50 } }),
    );

    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.laststream?.cached).not.toBe(true);
    expect(result.streams[0]?.laststream).toMatchObject({ copies: 3 });
  });

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

    expect(result.streams.map((stream) => stream.infoHash)).toEqual([H.a]);
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

    expect(result.streams.map((stream) => stream.infoHash).sort()).toEqual([H4, H5].sort());
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

    expect(result.streams.map((stream) => stream.infoHash)).toEqual([H.a]);
  });
});
