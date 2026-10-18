import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexerHealth } from '../src/sources/indexer-health.js';
import type { FetchFn } from '../src/sources/http.js';
import { MAX_PARALLEL_QUERIES } from '../src/sources/query-merge.js';
import {
  clearProwlarrDiscoveryCache,
  discoverProwlarrIndexers,
  PROWLARR_DISCOVERY_TTL_MS,
  searchProwlarr,
  type ProwlarrSource,
} from '../src/sources/prowlarr.js';
import type { ContentRef } from '../src/types.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const SERIES: ContentRef = { type: 'series', id: 'tt1234567:1:2', imdbId: 'tt1234567', season: 1, episode: 2 };
const KEY = 'PR-SECRET-KEY-4242';
const SOURCE: ProwlarrSource = { name: 'Prowlarr', baseUrl: 'https://prowlarr.example.com', apiKey: KEY };
const HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const HASH_LOWER = HASH.toLowerCase();

beforeEach(() => clearProwlarrDiscoveryCache());
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Film`;

/** Indexeurs Prowlarr bruts : Alpha accepte l'IMDb pour films et séries, Beta seulement la recherche texte. */
const INDEXERS = [
  {
    id: 1,
    name: 'Alpha',
    protocol: 'torrent',
    enable: true,
    privacy: 'public',
    capabilities: { movieSearchParams: ['q', 'imdbId'], tvSearchParams: ['q', 'season', 'ep', 'imdbId', 'tvdbId'] },
  },
  {
    id: 2,
    name: 'Beta',
    protocol: 'torrent',
    enable: true,
    privacy: 'semiPrivate',
    capabilities: { movieSearchParams: ['q'], tvSearchParams: ['q', 'season', 'ep'] },
  },
  { id: 3, name: 'Desactive', protocol: 'torrent', enable: false, privacy: 'public', capabilities: {} },
  { id: 4, name: 'Usenet', protocol: 'usenet', enable: true, privacy: 'private', capabilities: {} },
];

/** Faux fetch : aucun appel réseau. Le gestionnaire reçoit l'URL et les options (signal compris). */
function mockFetch(handler: (url: URL, init?: RequestInit) => Promise<Response> | Response) {
  const mock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(new URL(raw), init));
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Fetch qui ne répond jamais et se rejette seulement lorsque le signal est annulé. */
function hangingFetch(_url: URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

/** Renvoie l'erreur levée par la promesse ; échoue si elle se résout. */
async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('aucune erreur levée');
}

/** Routeur : indexeurs pour /api/v1/indexer, réponse fournie pour /api/v1/search. */
function routes(search: (url: URL) => Response | Promise<Response>) {
  return mockFetch((url) => {
    if (url.pathname === '/api/v1/indexer') return jsonResponse(INDEXERS);
    if (url.pathname === '/api/v1/search') return search(url);
    return new Response('introuvable', { status: 404 });
  });
}

function searchCalls(mock: ReturnType<typeof mockFetch>['mock']): URL[] {
  return mock.mock.calls.map((call) => new URL(String(call[0]))).filter((url) => url.pathname === '/api/v1/search');
}

describe('discoverProwlarrIndexers', () => {
  it('interroge /api/v1/indexer avec X-Api-Key (clé absente de l’URL) et ne garde que les torrents activés', async () => {
    const { fetch, mock } = routes(() => jsonResponse([]));

    const indexers = await discoverProwlarrIndexers(SOURCE, { fetch });

    const [url, init] = mock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://prowlarr.example.com/api/v1/indexer');
    expect(String(url)).not.toContain(KEY);
    expect((init?.headers as Record<string, string>)['X-Api-Key']).toBe(KEY);
    expect(indexers.map((i) => [i.id, i.name])).toEqual([
      [1, 'Alpha'],
      [2, 'Beta'],
    ]);
  });

  it('mappe la confidentialité et les capacités (IMDb, TVDB, saison)', async () => {
    const { fetch } = routes(() => jsonResponse([]));

    const [alpha, beta] = await discoverProwlarrIndexers(SOURCE, { fetch });

    expect(alpha).toMatchObject({
      id: 1,
      protocol: 'torrent',
      enabled: true,
      privacy: 'public',
      supportsImdb: true,
      supportsTvdb: true,
      supportsSeason: true,
      movieImdb: true,
      tvImdb: true,
    });
    expect(beta).toMatchObject({
      privacy: 'semiPrivate',
      supportsImdb: false,
      supportsTvdb: false,
      supportsSeason: true,
      movieImdb: false,
      tvImdb: false,
    });
  });

  it('erreur HTTP : message sûr avec le nom de la source, sans clé', async () => {
    const { fetch } = mockFetch(() => new Response('denied', { status: 401 }));

    const err = await errorOf(discoverProwlarrIndexers(SOURCE, { fetch }));

    expect(err.message).toBe('Source "Prowlarr" : HTTP 401');
    expect(err.message).not.toContain(KEY);
  });

  it('réponse non JSON : erreur sûre', async () => {
    const { fetch } = mockFetch(() => new Response('<html>', { status: 200 }));
    const err = await errorOf(discoverProwlarrIndexers(SOURCE, { fetch }));
    expect(err.message).toBe('Source "Prowlarr" : réponse JSON invalide');
  });

  it('une erreur réseau qui contient l’URL et la clé ne fuit ni l’une ni l’autre', async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError(`connexion refusée vers https://prowlarr.example.com/?apikey=${KEY}`);
    });
    const err = await errorOf(discoverProwlarrIndexers(SOURCE, { fetch }));
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('prowlarr.example.com');
  });
});

describe('searchProwlarr : regroupement par capacité', () => {
  it('film : Alpha (id IMDb) en requête par id, Beta (texte) en requêtes « Titre » et « Titre Année » avec les catégories 2000', async () => {
    const { fetch, mock } = routes(() => jsonResponse([]));

    await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film', year: 2024 } });

    const searches = searchCalls(mock);
    // Une requête par id (Alpha, ancrée sur le titre), puis une requête texte par variante pour Beta.
    expect(searches).toHaveLength(3);
    const byId = searches.find((url) => url.searchParams.has('imdbId'));
    const byText = searches.filter((url) => !url.searchParams.has('imdbId'));
    expect(byId?.searchParams.get('type')).toBe('movie');
    expect(byId?.searchParams.get('imdbId')).toBe('1234567');
    expect(byId?.searchParams.getAll('indexerIds')).toEqual(['1']);
    expect(byId?.searchParams.getAll('categories')).toEqual(['2000']);
    expect(byId?.searchParams.get('query')).toBe('Film');
    expect(byText.map((url) => url.searchParams.get('query'))).toEqual(['Film', 'Film 2024']);
    expect(byText.map((url) => url.searchParams.getAll('indexerIds'))).toEqual([['1', '2'], ['1', '2']]);
  });

  it('épisode : tvsearch avec titre, saison et épisode pour l’id ; texte « Titre S01 » puis « Titre S01E02 », catégories 5000', async () => {
    const { fetch, mock } = routes(() => jsonResponse([]));

    await searchProwlarr(SOURCE, SERIES, { fetch, titleInfo: { title: 'Serie' } });

    const searches = searchCalls(mock);
    const byId = searches.find((url) => url.searchParams.has('imdbId'));
    const byText = searches.filter((url) => !url.searchParams.has('imdbId'));
    expect(byId?.searchParams.get('type')).toBe('tvsearch');
    expect(byId?.searchParams.get('query')).toBe('Serie');
    expect(byId?.searchParams.get('season')).toBe('1');
    expect(byId?.searchParams.get('episode')).toBe('2');
    expect(byId?.searchParams.getAll('categories')).toEqual(['5000']);
    expect(byText.map((url) => url.searchParams.get('query'))).toEqual([
      'Serie S01',
      'Serie Saison 1',
      'Serie Intégrale',
      'Serie complete',
      'Serie S01E02',
      'Serie Integrale',
    ]);
    // Packs et intégrale : tous les indexeurs ; épisode exact : seulement les indexeurs sans id (Beta).
    expect(byText.map((url) => [url.searchParams.get('query'), url.searchParams.getAll('indexerIds')])).toEqual([
      ['Serie S01', ['1', '2']],
      ['Serie Saison 1', ['1', '2']],
      ['Serie Intégrale', ['1', '2']],
      ['Serie complete', ['1', '2']],
      ['Serie S01E02', ['2']],
      ['Serie Integrale', ['1', '2']],
    ]);
  });

  it('sans titre connu : pas de requête texte, seule la requête par id part', async () => {
    const { fetch, mock } = routes(() => jsonResponse([]));

    await searchProwlarr(SOURCE, MOVIE, { fetch });

    // Prowlarr ignore imdbId seul (liste générale) : sans titre, aucune requête par id ni requête texte.
    expect(searchCalls(mock)).toHaveLength(0);
  });

  it('indexerIds restreint les indexeurs interrogés ; catégories de la source prioritaires', async () => {
    const { fetch, mock } = routes(() => jsonResponse([]));

    await searchProwlarr({ ...SOURCE, indexerIds: [2], categories: [2010] }, MOVIE, {
      fetch,
      titleInfo: { title: 'Film' },
    });

    const searches = searchCalls(mock);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.searchParams.getAll('indexerIds')).toEqual(['2']);
    expect(searches[0]?.searchParams.getAll('categories')).toEqual(['2010']);
  });
});

describe('searchProwlarr : mapping des résultats', () => {
  it('extrait l’infoHash (hex ou base32), le magnet, la taille et les semeurs ; sourceName = nom de l’indexeur', async () => {
    // Vecteur de référence (RFC 4648, calculé hors du code testé) : HASH en base32.
    const base32 = 'VPG66AJDIVTYTK6N54ASGRLHRGV433YB';
    const { fetch } = routes((url) => {
      if (url.searchParams.get('query') !== null && url.searchParams.get('imdbId') === null) return jsonResponse([]);
      return jsonResponse([
        {
          title: 'Film.2024.1080p.BluRay',
          size: 2147483648,
          seeders: 42,
          leechers: 3,
          indexer: 'Alpha',
          indexerId: 1,
          protocol: 'torrent',
          infoHash: HASH,
          magnetUrl: MAGNET,
          publishDate: '2024-05-01T10:00:00Z',
        },
        {
          title: 'Film.b32',
          size: 1000,
          indexer: 'Alpha',
          indexerId: 1,
          protocol: 'torrent',
          magnetUrl: `magnet:?xt=urn:btih:${base32}`,
        },
      ]);
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(streams).toEqual([
      {
        sourceName: 'Alpha',
        sourceKind: 'torznab',
        name: 'Alpha',
        indexers: ['Alpha'],
        title: 'Film.2024.1080p.BluRay',
        filename: 'Film.2024.1080p.BluRay',
        sizeBytes: 2147483648,
        seeders: 42,
        infoHash: HASH_LOWER,
        magnet: MAGNET,
      },
      {
        sourceName: 'Alpha',
        sourceKind: 'torznab',
        name: 'Alpha',
        indexers: ['Alpha'],
        title: 'Film.b32',
        filename: 'Film.b32',
        sizeBytes: 1000,
        infoHash: HASH_LOWER,
        magnet: `magnet:?xt=urn:btih:${base32}`,
      },
    ]);
  });

  it('infoHash seul (sans magnet) : retenu ; release sans hash ni magnet : ignoré ; usenet : ignoré', async () => {
    const { fetch } = routes((url) => {
      if (url.searchParams.get('query') !== null && url.searchParams.get('imdbId') === null) return jsonResponse([]);
      return jsonResponse([
        { title: 'Hash seul', indexer: 'Alpha', protocol: 'torrent', infoHash: HASH },
        { title: 'Rien', indexer: 'Alpha', protocol: 'torrent' },
        { title: 'Usenet', indexer: 'Alpha', protocol: 'usenet', infoHash: 'a'.repeat(40), magnetUrl: MAGNET },
      ]);
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(streams.map((s) => s.title)).toEqual(['Hash seul']);
    expect(streams[0]?.infoHash).toBe(HASH_LOWER);
    expect(streams[0]?.magnet).toBeUndefined();
  });

  it('downloadUrl HTTP (lien .torrent proxifié) : gardé sans infoHash, en mémoire seulement ; un downloadUrl magnet devient magnet', async () => {
    const proxied = `https://prowlarr.example.com/1/download?apikey=${KEY}&link=abc`;
    const { fetch } = routes((url) => {
      if (url.searchParams.get('query') !== null && url.searchParams.get('imdbId') === null) return jsonResponse([]);
      return jsonResponse([
        { title: 'Proxifie', indexer: 'Alpha', protocol: 'torrent', downloadUrl: proxied, guid: 'g-1' },
        { title: 'Magnet', indexer: 'Alpha', protocol: 'torrent', downloadUrl: MAGNET },
      ]);
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(streams.map((s) => s.title)).toEqual(['Proxifie', 'Magnet']);
    expect(streams[0]).toMatchObject({ sourceName: 'Alpha', downloadUrl: proxied, guid: 'g-1' });
    expect(streams[0]?.infoHash).toBeUndefined();
    expect(streams[0]?.magnet).toBeUndefined();
    expect(streams[1]?.magnet).toBe(MAGNET);
    expect(streams[1]?.downloadUrl).toBeUndefined();
  });

  it('downloadUrl HTTP : ignoré si un infoHash existe ou si le schéma n’est pas http(s) ; sans guid, le lien reste sans guid', async () => {
    const { fetch } = routes((url) => {
      if (url.searchParams.get('query') !== null && url.searchParams.get('imdbId') === null) return jsonResponse([]);
      return jsonResponse([
        { title: 'Avec hash', indexer: 'Alpha', protocol: 'torrent', infoHash: HASH, downloadUrl: `https://p.example.com/x?apikey=${KEY}` },
        { title: 'Ftp', indexer: 'Alpha', protocol: 'torrent', downloadUrl: 'ftp://p.example.com/x.torrent' },
        { title: 'Sans guid', indexer: 'Alpha', protocol: 'torrent', downloadUrl: 'https://p.example.com/y.torrent' },
      ]);
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(streams.map((s) => s.title)).toEqual(['Avec hash', 'Sans guid']);
    expect(streams[0]?.downloadUrl).toBeUndefined();
    expect(streams[1]?.downloadUrl).toBe('https://p.example.com/y.torrent');
    expect(streams[1]?.guid).toBeUndefined();
  });

  it('indexeur absent du release : le nom connu à partir de indexerId sert de sourceName', async () => {
    const { fetch } = routes((url) => {
      if (url.searchParams.get('query') !== null && url.searchParams.get('imdbId') === null) return jsonResponse([]);
      return jsonResponse([{ title: 'Sans nom', indexerId: 1, protocol: 'torrent', infoHash: HASH }]);
    });

    const [stream] = await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(stream?.sourceName).toBe('Alpha');
  });
});

describe('searchProwlarr : isolation, santé et budget', () => {
  it('la requête par id en échec n’empêche pas la requête texte ; la santé de l’indexeur en échec garde l’erreur', async () => {
    const health = new IndexerHealth();
    const release = { title: 'Film.2024.1080p.BluRay', indexer: 'Beta', indexerId: 2, protocol: 'torrent', infoHash: HASH, size: 1000 };
    const { fetch } = routes((url) => {
      if (url.searchParams.get('imdbId') !== null) return new Response('boom', { status: 503 }); // requête par id : tombe
      return jsonResponse([release]); // requête texte : répond
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, health, titleInfo: { title: 'Film' } });

    expect(streams.map((stream) => stream.title)).toEqual(['Film.2024.1080p.BluRay']);
    expect(health.get('Prowlarr', 1)).toMatchObject({ errorCount: 1, lastErrorCode: 'HTTP 503' });
    expect(health.get('Prowlarr', 2)).toMatchObject({ status: 'ok' });
  });

  it('tous les groupes en échec : SourceError avec le nom de la source, sans clé', async () => {
    const { fetch } = routes(() => new Response('boom', { status: 500 }));

    const err = await errorOf(searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } }));

    expect(err.message).toBe('Source "Prowlarr" : HTTP 500');
    expect(err.message).not.toContain(KEY);
  });

  it('une réussite met à jour la santé avec la latence de la requête', async () => {
    const health = new IndexerHealth();
    const { fetch } = routes(() => jsonResponse([]));

    await searchProwlarr(SOURCE, MOVIE, { fetch, health, titleInfo: { title: 'Film' } });

    // Alpha reçoit la requête par id et la requête texte (packs : tous les indexeurs) : deux réussites.
    expect(health.get('Prowlarr', 1)).toMatchObject({ status: 'ok', count: 2, errorCount: 0 });
    expect(health.get('Prowlarr', 2)?.avgLatencyMs).toEqual(expect.any(Number));
  });

  it('budget global dépassé : échec sûr « délai dépassé » dans le budget, sans attendre le délai par requête', async () => {
    const { fetch } = mockFetch(hangingFetch);
    const started = Date.now();

    const err = await errorOf(searchProwlarr(SOURCE, MOVIE, { fetch, budgetMs: 60 }));

    expect(err.message).toBe('Source "Prowlarr" : délai dépassé (60 ms)');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('liste des indexeurs gardée 10 min : deux recherches ne font qu une découverte', async () => {
    const { fetch, mock } = mockFetch((url) =>
      url.pathname === '/api/v1/indexer' ? jsonResponse([INDEXERS[2]]) : jsonResponse([]),
    );

    await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });
    await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    const discoveries = mock.mock.calls.filter(([input]) => String(input).includes('/api/v1/indexer'));
    expect(discoveries).toHaveLength(1);
  });

  it('découverte en échec : non mise en cache, la recherche suivante redécouvre', async () => {
    let fail = true;
    const { fetch, mock } = mockFetch((url) => {
      if (url.pathname !== '/api/v1/indexer') return jsonResponse([]);
      return fail ? new Response('boom', { status: 503 }) : jsonResponse([INDEXERS[2]]);
    });

    await expect(searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } })).rejects.toThrow('HTTP 503');
    fail = false;
    await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    const discoveries = mock.mock.calls.filter(([input]) => String(input).includes('/api/v1/indexer'));
    expect(discoveries).toHaveLength(2);
  });

  it('au-delà de 10 min, la liste des indexeurs est redécouverte', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
      const { fetch, mock } = mockFetch((url) =>
        url.pathname === '/api/v1/indexer' ? jsonResponse([INDEXERS[2]]) : jsonResponse([]),
      );
      await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });
      vi.setSystemTime(new Date(Date.now() + PROWLARR_DISCOVERY_TTL_MS + 1));
      await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

      const discoveries = mock.mock.calls.filter(([input]) => String(input).includes('/api/v1/indexer'));
      expect(discoveries).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('budget dépassé : les requêtes terminées gardent leurs résultats, les autres sont abandonnées', async () => {
    const { fetch } = mockFetch((url, init) => {
      if (url.pathname === '/api/v1/indexer') return jsonResponse([INDEXERS[1]]);
      if (url.searchParams.get('query') === 'Film') {
        return jsonResponse([{ title: 'Film.2024.1080p', infoHash: HASH, indexerId: 2, indexer: 'Beta' }]);
      }
      return hangingFetch(url, init);
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, {
      fetch,
      budgetMs: 80,
      titles: { titles: ['Film', 'Autre film'] },
    });

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ title: 'Film.2024.1080p', infoHash: HASH_LOWER });
  });

  it('au plus MAX_PARALLEL_QUERIES requêtes simultanées par recherche', async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetch, mock } = mockFetch(async (url) => {
      if (url.pathname !== '/api/v1/search') return jsonResponse([INDEXERS[1]]);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return jsonResponse([]);
    });

    await searchProwlarr(SOURCE, MOVIE, { fetch, titles: { titles: ['A', 'B', 'C', 'D'], year: 2024 } });

    const sent = searchCalls(mock).length;
    expect(sent).toBeGreaterThan(MAX_PARALLEL_QUERIES);
    expect(peak).toBe(MAX_PARALLEL_QUERIES);
  });

  it('aucun indexeur activé : résultat vide sans requête de recherche', async () => {
    const { fetch, mock } = mockFetch((url) =>
      url.pathname === '/api/v1/indexer' ? jsonResponse([INDEXERS[2], INDEXERS[3]]) : jsonResponse([]),
    );

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(streams).toEqual([]);
    expect(searchCalls(mock)).toHaveLength(0);
  });
});
