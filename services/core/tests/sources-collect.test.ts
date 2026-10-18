import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/schema.js';
import { collectStreams, mergeIndexerCopies } from '../src/sources/collect.js';
import type { FetchFn } from '../src/sources/http.js';
import type { ContentRef } from '../src/types.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const TORZNAB_KEY = 'TZ-COLLECT-SECRET-9';
const UPSTREAM_KEY = 'UP-COLLECT-SECRET-8';
const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Film';

/** Faux fetch : aucun appel réseau, la réponse dépend de l'URL demandée. */
function mockFetch(handler: (url: string) => Promise<Response>) {
  const mock = vi.fn((url: string) => handler(url));
  return { fetch: mock as unknown as FetchFn, mock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

const TORZNAB_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
  <item><title>Film Torznab</title><link>${MAGNET.replaceAll('&', '&amp;')}</link></item>
</channel></rss>`;

/** Route les appels : /stream/ vers l'amont, /api vers Torznab. */
function routeHandler(options: { upstream: () => Promise<Response>; torznab: () => Promise<Response> }) {
  return async (url: string): Promise<Response> => {
    if (url.includes('/stream/')) return options.upstream();
    if (url.includes('/api?')) return options.torznab();
    throw new Error(`URL inattendue (test) ${url}`);
  };
}

describe('collectStreams', () => {
  it('fusionne les streams de l’amont et de Torznab, dans l’ordre des sources', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: 'https://up.example.com/addon/manifest.json' },
        { type: 'torznab', name: 'Torz', baseUrl: 'https://idx.example.com', apiKey: TORZNAB_KEY },
      ],
    });
    const { fetch } = mockFetch(
      routeHandler({
        upstream: async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'a'.repeat(40) }] }),
        torznab: async () => xmlResponse(TORZNAB_RSS),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(result.errors).toEqual([]);
    expect(result.streams.map((s) => [s.sourceKind, s.sourceName])).toEqual([
      ['upstream', 'Amont'],
      ['torznab', 'Torz'],
    ]);
    expect(result.streams[1]?.title).toBe('Film Torznab');
  });

  it('isole les erreurs : une source en HTTP 500 n’empêche pas les autres', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Cassé', url: 'https://up.example.com/addon' },
        { type: 'torznab', name: 'Torz', baseUrl: 'https://idx.example.com', apiKey: TORZNAB_KEY },
      ],
    });
    const { fetch } = mockFetch(
      routeHandler({
        upstream: async () => new Response('boom', { status: 500 }),
        torznab: async () => xmlResponse(TORZNAB_RSS),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.sourceName).toBe('Torz');
    expect(result.errors).toEqual([{ source: 'Cassé', error: 'Source "Cassé" : HTTP 500' }]);
  });

  it('toutes les sources en échec : streams vides et une erreur par source', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'A', url: 'https://up.example.com/addon' },
        { type: 'torznab', name: 'B', baseUrl: 'https://idx.example.com', apiKey: TORZNAB_KEY },
      ],
    });
    const { fetch } = mockFetch(
      routeHandler({
        upstream: async () => new Response('', { status: 503 }),
        torznab: async () => xmlResponse('<error code="100" description="Incorrect user credentials"/>'),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(result.streams).toEqual([]);
    expect(result.errors.map((e) => e.source)).toEqual(['A', 'B']);
    expect(result.errors[1]?.error).toBe('Source "B" : erreur Torznab : Incorrect user credentials (code 100)');
  });

  it('aucune source configurée : résultat vide sans appel réseau', async () => {
    const config = parseConfig({});
    const { fetch, mock } = mockFetch(async () => jsonResponse({}));

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(result).toEqual({ streams: [], errors: [] });
    expect(mock).not.toHaveBeenCalled();
  });

  it('les messages d’erreur ne contiennent aucune clé, même quand le fetch échoue avec l’URL', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: `https://up.example.com/addon?apikey=${UPSTREAM_KEY}` },
        { type: 'torznab', name: 'Torz', baseUrl: 'https://idx.example.com', apiKey: TORZNAB_KEY },
      ],
    });
    const { fetch } = mockFetch(async (url) => {
      throw new TypeError(`connexion refusée vers ${url}`);
    });

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });
    const serialized = JSON.stringify(result.errors);

    expect(result.errors).toHaveLength(2);
    expect(serialized).not.toContain(UPSTREAM_KEY);
    expect(serialized).not.toContain(TORZNAB_KEY);
    expect(serialized).not.toContain('up.example.com');
    expect(serialized).not.toContain('idx.example.com');
  });

  it('interroge les sources en parallèle', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: 'https://up.example.com/addon' },
        { type: 'torznab', name: 'Torz', baseUrl: 'https://idx.example.com', apiKey: TORZNAB_KEY },
      ],
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = (response: () => Response) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return response();
    };
    const { fetch } = mockFetch(
      routeHandler({
        upstream: slow(() => jsonResponse({ streams: [] })),
        torznab: slow(() => xmlResponse('<?xml version="1.0"?><rss version="2.0"><channel/></rss>')),
      }),
    );

    await collectStreams(config, MOVIE, { fetch });

    expect(maxInFlight).toBe(2);
  });
});

describe('collectStreams : Prowlarr et Jackett', () => {
  const PR_KEY = 'PR-COLLECT-KEY-5';
  const JK_KEY = 'JK-COLLECT-KEY-6';
  const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  const PROWLARR_RELEASE = {
    title: 'Film Prowlarr',
    indexer: 'Alpha',
    indexerId: 1,
    protocol: 'torrent',
    infoHash: HASH,
    seeders: 5,
  };

  /** Routeur : indexeurs et recherche Prowlarr, recherche Jackett agrégée. */
  function routeAll(options: { prowlarr: unknown[] | 'fail'; jackett: string | 'fail' }) {
    return mockFetch(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v1/indexer') {
        return jsonResponse([
          { id: 1, name: 'Alpha', protocol: 'torrent', enable: true, capabilities: { movieSearchParams: ['q', 'imdbId'] } },
        ]);
      }
      if (parsed.pathname === '/api/v1/search') {
        if (options.prowlarr === 'fail') return new Response('down', { status: 503 });
        return jsonResponse(parsed.searchParams.get('query') !== null && parsed.searchParams.get('imdbId') === null ? [] : options.prowlarr);
      }
      if (parsed.pathname.endsWith('/results/torznab/api')) {
        if (options.jackett === 'fail') return new Response('down', { status: 500 });
        return xmlResponse(options.jackett);
      }
      throw new Error(`URL inattendue (test) ${url}`);
    });
  }

  it('dispatch : prowlarr et jackett interrogés, chacun avec ses erreurs isolées', async () => {
    const config = parseConfig({
      sources: [
        { type: 'prowlarr', name: 'PR', baseUrl: 'https://pr.example.com', apiKey: PR_KEY },
        { type: 'jackett', name: 'JK', baseUrl: 'http://127.0.0.1:9117', apiKey: JK_KEY },
      ],
    });
    const { fetch } = routeAll({ prowlarr: 'fail', jackett: '<rss version="2.0"><channel/></rss>' });

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(result.streams).toEqual([]);
    expect(result.errors).toEqual([{ source: 'PR', error: 'Source "PR" : HTTP 503' }]);
  });

  it('même infoHash chez deux indexeurs (Prowlarr + Jackett) : un seul flux, indexers = noms fusionnés', async () => {
    const config = parseConfig({
      sources: [
        { type: 'prowlarr', name: 'PR', baseUrl: 'https://pr.example.com', apiKey: PR_KEY },
        { type: 'jackett', name: 'JK', baseUrl: 'http://127.0.0.1:9117', apiKey: JK_KEY, indexers: 'all' },
      ],
    });
    const jackettFeed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
  <item><title>Film Jackett</title><link>magnet:?xt=urn:btih:${HASH}</link><jackettindexer id="beta">Beta</jackettindexer></item>
</channel></rss>`;
    const { fetch } = routeAll({ prowlarr: [PROWLARR_RELEASE], jackett: jackettFeed });

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });

    expect(result.errors).toEqual([]);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]).toMatchObject({ sourceName: 'Alpha', infoHash: HASH, indexers: ['Alpha', 'Beta'] });
  });

  it('les clés Prowlarr et Jackett ne sortent jamais dans les erreurs', async () => {
    const config = parseConfig({
      sources: [
        { type: 'prowlarr', name: 'PR', baseUrl: 'https://pr.example.com', apiKey: PR_KEY },
        { type: 'jackett', name: 'JK', baseUrl: 'http://127.0.0.1:9117', apiKey: JK_KEY },
      ],
    });
    const { fetch } = mockFetch(async (url) => {
      throw new TypeError(`connexion refusée vers ${url}`);
    });

    const result = await collectStreams(config, MOVIE, { fetch, titleInfo: { title: 'Film' } });
    const serialized = JSON.stringify(result.errors);

    expect(result.errors).toHaveLength(2);
    expect(serialized).not.toContain(PR_KEY);
    expect(serialized).not.toContain(JK_KEY);
    expect(serialized).not.toContain('pr.example.com');
  });
});

describe('mergeIndexerCopies', () => {
  const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  const base = { sourceKind: 'torznab' as const, sourceName: 'X', name: 'X' };

  it('fusionne les copies par infoHash (insensible à la casse), garde la première place et l’union des indexeurs', () => {
    const merged = mergeIndexerCopies([
      { ...base, sourceName: 'A', infoHash: HASH.toUpperCase(), title: 'Premier', indexers: ['A'] },
      { ...base, sourceName: 'B', infoHash: 'f'.repeat(40), title: 'Autre', indexers: ['B'] },
      { ...base, sourceName: 'B', infoHash: HASH, title: 'Copie', indexers: ['B', 'A'] },
    ]);

    expect(merged.map((s) => s.title)).toEqual(['Premier', 'Autre']);
    expect(merged[0]?.indexers).toEqual(['A', 'B']);
  });

  it('ne touche pas aux flux sans indexers (upstream, torznab sans étiquette) ni sans infoHash', () => {
    const plain = { ...base, infoHash: HASH };
    const noHash = { ...base, indexers: ['A'], magnet: 'magnet:?xt=urn:btih:x' };
    const merged = mergeIndexerCopies([plain, plain, noHash, noHash]);
    expect(merged).toHaveLength(4);
    expect(merged[0]).toEqual(plain);
  });
});
