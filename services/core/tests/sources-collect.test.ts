import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/schema.js';
import { clearUpstreamTasks, collectStreams, mergeIndexerCopies } from '../src/sources/collect.js';
import type { FetchFn } from '../src/sources/http.js';
import type { ContentRef } from '../src/types.js';

// Les recherches d'addons amont sont gardées en mémoire (5 min) : chaque test repart de zéro.
beforeEach(() => clearUpstreamTasks());

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const TORZNAB_KEY = 'TZ-COLLECT-SECRET-9';
const UPSTREAM_KEY = 'UP-COLLECT-SECRET-8';

/** Faux fetch : aucun appel réseau, la réponse dépend de l'URL demandée. */
function mockFetch(handler: (url: string) => Promise<Response>) {
  const mock = vi.fn((url: string) => handler(url));
  return { fetch: mock as unknown as FetchFn, mock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Route les appels vers les addons amont, par hôte : chaque addon a sa propre réponse. */
function upstreamsHandler(responses: Record<string, () => Promise<Response>>) {
  return async (url: string): Promise<Response> => {
    const respond = responses[new URL(url).hostname];
    if (respond === undefined) throw new Error(`URL inattendue (test) ${url}`);
    return respond();
  };
}

describe('collectStreams', () => {
  it('fusionne les streams des addons amont, dans l’ordre des sources', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: 'https://a.example.com/addon/manifest.json' },
        { type: 'upstream', name: 'Second', url: 'https://b.example.com/addon/manifest.json' },
      ],
    });
    const { fetch } = mockFetch(
      upstreamsHandler({
        'a.example.com': async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'a'.repeat(40) }] }),
        'b.example.com': async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'b'.repeat(40) }] }),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch });

    expect(result.errors).toEqual([]);
    expect(result.streams.map((s) => [s.sourceKind, s.sourceName])).toEqual([
      ['upstream', 'Amont'],
      ['upstream', 'Second'],
    ]);
  });

  it('isole les erreurs : une source en HTTP 500 n’empêche pas les autres', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Cassé', url: 'https://a.example.com/addon' },
        { type: 'upstream', name: 'Ok', url: 'https://b.example.com/addon' },
      ],
    });
    const { fetch } = mockFetch(
      upstreamsHandler({
        'a.example.com': async () => new Response('boom', { status: 500 }),
        'b.example.com': async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'c'.repeat(40) }] }),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch });

    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.sourceName).toBe('Ok');
    expect(result.errors).toEqual([{ source: 'Cassé', error: 'Source "Cassé" : HTTP 500' }]);
  });

  it('toutes les sources en échec : streams vides et une erreur par source', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'A', url: 'https://a.example.com/addon' },
        { type: 'upstream', name: 'B', url: 'https://b.example.com/addon' },
      ],
    });
    const { fetch } = mockFetch(
      upstreamsHandler({
        'a.example.com': async () => new Response('', { status: 503 }),
        'b.example.com': async () => new Response('', { status: 503 }),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch });

    expect(result.streams).toEqual([]);
    expect(result.errors.map((e) => e.source)).toEqual(['A', 'B']);
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
        { type: 'upstream', name: 'Amont', url: `https://a.example.com/addon?apikey=${UPSTREAM_KEY}` },
        { type: 'upstream', name: 'Autre', url: 'https://b.example.com/addon' },
      ],
    });
    const { fetch } = mockFetch(async (url) => {
      throw new TypeError(`connexion refusée vers ${url}`);
    });

    const result = await collectStreams(config, MOVIE, { fetch });
    const serialized = JSON.stringify(result.errors);

    expect(result.errors).toHaveLength(2);
    expect(serialized).not.toContain(UPSTREAM_KEY);
    expect(serialized).not.toContain('a.example.com');
    expect(serialized).not.toContain('b.example.com');
  });

  it('interroge les addons en parallèle', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: 'https://a.example.com/addon' },
        { type: 'upstream', name: 'Second', url: 'https://b.example.com/addon' },
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
      upstreamsHandler({
        'a.example.com': slow(() => jsonResponse({ streams: [] })),
        'b.example.com': slow(() => jsonResponse({ streams: [] })),
      }),
    );

    await collectStreams(config, MOVIE, { fetch });

    expect(maxInFlight).toBe(2);
  });

  it('les anciens indexeurs de la configuration ne sont jamais interrogés', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Amont', url: 'https://a.example.com/addon' },
        { type: 'torznab', name: 'Torz', baseUrl: 'https://idx.example.com', apiKey: TORZNAB_KEY },
        { type: 'jackett', name: 'JK', baseUrl: 'http://127.0.0.1:9117', apiKey: UPSTREAM_KEY },
      ],
    });
    const { fetch, mock } = mockFetch(
      upstreamsHandler({ 'a.example.com': async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'e'.repeat(40) }] }) }),
    );

    const result = await collectStreams(config, MOVIE, { fetch });

    expect(mock.mock.calls.every(([url]) => new URL(url).hostname === 'a.example.com')).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.streams.map((s) => s.sourceName)).toEqual(['Amont']);
  });
});

describe('collectStreams : sources désactivées et priorité d’ordre', () => {
  it('une source désactivée n’est jamais interrogée et n’apparaît pas dans les erreurs', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Off', url: 'https://off.example.com/addon/manifest.json', enabled: false },
        { type: 'upstream', name: 'On', url: 'https://on.example.com/addon' },
      ],
    });
    const { fetch, mock } = mockFetch(
      upstreamsHandler({
        'on.example.com': async () => jsonResponse({ streams: [{ name: 'On', infoHash: 'b'.repeat(40) }] }),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch });

    expect(mock.mock.calls.some(([url]) => url.includes('off.example.com'))).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.streams.map((s) => s.sourceName)).toEqual(['On']);
  });

  it('enabled absent vaut activée (défaut du schéma)', () => {
    const config = parseConfig({ sources: [{ type: 'upstream', name: 'A', url: 'https://a.example.com/' }] });
    expect(config.sources[0]?.enabled).toBe(true);
  });

  it('chaque flux porte sourcePriority = index de sa source dans la configuration (désactivée comprise)', async () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'Off', url: 'https://off.example.com/', enabled: false },
        { type: 'upstream', name: 'Premier', url: 'https://first.example.com/' },
        { type: 'upstream', name: 'Second', url: 'https://second.example.com/' },
      ],
    });
    const { fetch } = mockFetch(
      upstreamsHandler({
        'first.example.com': async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'c'.repeat(40) }] }),
        'second.example.com': async () => jsonResponse({ streams: [{ name: 'Up', infoHash: 'd'.repeat(40) }] }),
      }),
    );

    const result = await collectStreams(config, MOVIE, { fetch });

    const priorities = Object.fromEntries(result.streams.map((s) => [s.sourceName, s.sourcePriority]));
    expect(priorities).toEqual({ Premier: 1, Second: 2 });
  });
});

describe('mergeIndexerCopies', () => {
  const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  const base = { sourceKind: 'upstream' as const, sourceName: 'X', name: 'X' };

  it('fusionne les copies par infoHash (insensible à la casse), garde la première place et l’union des indexeurs', () => {
    const merged = mergeIndexerCopies([
      { ...base, sourceName: 'A', infoHash: HASH.toUpperCase(), title: 'Premier', indexers: ['A'] },
      { ...base, sourceName: 'B', infoHash: 'f'.repeat(40), title: 'Autre', indexers: ['B'] },
      { ...base, sourceName: 'B', infoHash: HASH, title: 'Copie', indexers: ['B', 'A'] },
    ]);

    expect(merged.map((s) => s.title)).toEqual(['Premier', 'Autre']);
    expect(merged[0]?.indexers).toEqual(['A', 'B']);
  });

  it('ne touche pas aux flux sans indexers (addon amont) ni sans infoHash', () => {
    const plain = { ...base, infoHash: HASH };
    const noHash = { ...base, indexers: ['A'], magnet: 'magnet:?xt=urn:btih:x' };
    const merged = mergeIndexerCopies([plain, plain, noHash, noHash]);
    expect(merged).toHaveLength(4);
    expect(merged[0]).toEqual(plain);
  });

  it('une copie fusionnée garde la meilleure priorité parmi ses occurrences', () => {
    const hash = 'd'.repeat(40);
    const merged = mergeIndexerCopies([
      { sourceName: 'Lente', sourceKind: 'upstream', infoHash: hash, indexers: ['A'], sourcePriority: 3 },
      { sourceName: 'Rapide', sourceKind: 'upstream', infoHash: hash, indexers: ['B'], sourcePriority: 0 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourcePriority).toBe(0);
    expect(merged[0]?.indexers).toEqual(['A', 'B']);
  });
});
