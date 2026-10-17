import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/schema.js';
import { collectStreams } from '../src/sources/collect.js';
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

    const result = await collectStreams(config, MOVIE, { fetch });

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

    const result = await collectStreams(config, MOVIE, { fetch });

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

    const result = await collectStreams(config, MOVIE, { fetch });

    expect(result.streams).toEqual([]);
    expect(result.errors.map((e) => e.source)).toEqual(['A', 'B']);
    expect(result.errors[1]?.error).toBe('Source "B" : erreur Torznab : Incorrect user credentials (code 100)');
  });

  it('aucune source configurée : résultat vide sans appel réseau', async () => {
    const config = parseConfig({});
    const { fetch, mock } = mockFetch(async () => jsonResponse({}));

    const result = await collectStreams(config, MOVIE, { fetch });

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

    const result = await collectStreams(config, MOVIE, { fetch });
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
