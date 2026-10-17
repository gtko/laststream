import { describe, expect, it, vi } from 'vitest';
import { IndexerHealth } from '../src/sources/indexer-health.js';
import { discoverJackettIndexers, searchJackett, type JackettSource } from '../src/sources/jackett.js';
import type { FetchFn } from '../src/sources/http.js';
import type { ContentRef } from '../src/types.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const SERIES: ContentRef = { type: 'series', id: 'tt1234567:1:2', imdbId: 'tt1234567', season: 1, episode: 2 };
const KEY = 'JK-SECRET-KEY-9977';
const BASE = 'http://127.0.0.1:9117';
const HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Film`;

function mockFetch(handler: (url: URL) => Promise<Response> | Response) {
  const mock = vi.fn((input: string | URL | Request) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(new URL(raw)));
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

/** Flux Torznab agrégé Jackett : chaque item porte <jackettindexer> avec le nom de son indexeur. */
function feed(items: Array<{ title: string; indexer: string; id: string; hash?: string }>): string {
  const entries = items
    .map(
      (item) => `<item>
        <title>${item.title}</title>
        <size>1073741824</size>
        <link>${(item.hash ? `magnet:?xt=urn:btih:${item.hash}&dn=x` : MAGNET).replaceAll('&', '&amp;')}</link>
        <jackettindexer id="${item.id}">${item.indexer}</jackettindexer>
        <torznab:attr name="seeders" value="7" />
      </item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${entries}</channel></rss>`;
}

/** Route /api/v2.0/indexers/{target}/results/torznab/api selon la cible demandée. */
function targetOf(url: URL): string | undefined {
  return /\/api\/v2\.0\/indexers\/([^/]+)\/results\/torznab\/api$/.exec(url.pathname)?.[1];
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('aucune erreur levée');
}

describe('discoverJackettIndexers', () => {
  it('interroge /api/v2.0/indexers?configured=true avec la clé (en paramètre, jamais dans un message) et mappe les types', async () => {
    const { fetch, mock } = mockFetch(() =>
      jsonResponse([
        {
          id: 'alpha',
          title: 'Alpha Tracker',
          type: 'public',
          configured: true,
          searching: {
            'movie-search': { available: true, supportedParams: ['q', 'imdbid'] },
            'tv-search': { available: true, supportedParams: ['q', 'season', 'ep', 'imdbid', 'tvdbid'] },
          },
        },
        { id: 'beta', title: 'Beta', type: 'semi-private', configured: true },
        { id: 'gamma', title: 'Gamma', type: 'private', configured: true },
      ]),
    );

    const indexers = await discoverJackettIndexers({ name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: 'all' }, { fetch });

    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2.0/indexers');
    expect(url.searchParams.get('configured')).toBe('true');
    expect(url.searchParams.get('apikey')).toBe(KEY);
    expect(indexers).toEqual([
      expect.objectContaining({
        id: 'alpha',
        name: 'Alpha Tracker',
        protocol: 'torrent',
        enabled: true,
        privacy: 'public',
        supportsImdb: true,
        supportsTvdb: true,
        supportsSeason: true,
        movieImdb: true,
        tvImdb: true,
      }),
      expect.objectContaining({ id: 'beta', name: 'Beta', privacy: 'semiPrivate', supportsImdb: false }),
      expect.objectContaining({ id: 'gamma', privacy: 'private' }),
    ]);
  });

  it('erreur HTTP : message avec le nom de la source, sans clé', async () => {
    const { fetch } = mockFetch(() => new Response('nope', { status: 401 }));
    const err = await errorOf(
      discoverJackettIndexers({ name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: 'all' }, { fetch }),
    );
    expect(err.message).toBe('Source "Jackett" : HTTP 401');
    expect(err.message).not.toContain(KEY);
  });
});

describe('searchJackett', () => {
  it("'all' : une requête /indexers/all/results/torznab/api avec t=movie, imdbid et apikey, réutilisant le parseur Torznab", async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([{ title: 'Film', indexer: 'Alpha Tracker', id: 'alpha' }])));
    const source: JackettSource = { name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: 'all' };

    const streams = await searchJackett(source, MOVIE, { fetch });

    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v2.0/indexers/all/results/torznab/api');
    expect(url.searchParams.get('t')).toBe('movie');
    expect(url.searchParams.get('imdbid')).toBe('1234567');
    expect(url.searchParams.get('apikey')).toBe(KEY);
    expect(streams).toEqual([
      {
        sourceName: 'Alpha Tracker',
        sourceKind: 'torznab',
        name: 'Alpha Tracker',
        indexers: ['Alpha Tracker'],
        title: 'Film',
        filename: 'Film',
        sizeBytes: 1073741824,
        seeders: 7,
        infoHash: HASH.toLowerCase(),
        magnet: MAGNET,
      },
    ]);
  });

  it('série : t=tvsearch avec season et ep', async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([])));

    await searchJackett({ name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: 'all' }, SERIES, { fetch });

    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('t')).toBe('tvsearch');
    expect(url.searchParams.get('season')).toBe('1');
    expect(url.searchParams.get('ep')).toBe('2');
  });

  it('liste d’indexeurs : une requête par identifiant, chaque flux tagué de son indexeur', async () => {
    const { fetch, mock } = mockFetch((url) => {
      const target = targetOf(url);
      if (target === 'alpha') return xmlResponse(feed([{ title: 'De Alpha', indexer: 'Alpha', id: 'alpha' }]));
      if (target === 'beta') return xmlResponse(feed([{ title: 'De Beta', indexer: 'Beta', id: 'beta' }]));
      return new Response('introuvable', { status: 404 });
    });

    const streams = await searchJackett(
      { name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: ['alpha', 'beta', 'alpha'] },
      MOVIE,
      { fetch },
    );

    expect(mock).toHaveBeenCalledTimes(2);
    expect(streams.map((s) => [s.title, s.indexers])).toEqual([
      ['De Alpha', ['Alpha']],
      ['De Beta', ['Beta']],
    ]);
  });

  it('une cible en échec n’empêche pas les autres ; la santé est tenue par identifiant', async () => {
    const health = new IndexerHealth();
    const { fetch } = mockFetch((url) =>
      targetOf(url) === 'alpha' ? new Response('boom', { status: 500 }) : xmlResponse(feed([{ title: 'Beta ok', indexer: 'Beta', id: 'beta' }])),
    );

    const streams = await searchJackett(
      { name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: ['alpha', 'beta'] },
      MOVIE,
      { fetch, health },
    );

    expect(streams.map((s) => s.title)).toEqual(['Beta ok']);
    expect(health.get('Jackett', 'alpha')).toMatchObject({ status: 'error', lastErrorCode: 'Source "Jackett" : HTTP 500' });
    expect(health.get('Jackett', 'beta')).toMatchObject({ status: 'ok' });
  });

  it('toutes les cibles en échec : SourceError sûre (erreur Torznab décrite, clé masquée)', async () => {
    const { fetch } = mockFetch(() =>
      xmlResponse(`<error code="100" description="Bad key ${KEY}"/>`),
    );

    const err = await (async () => {
      try {
        await searchJackett({ name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: 'all' }, MOVIE, { fetch });
      } catch (e) {
        return e as Error;
      }
      throw new Error('aucune erreur');
    })();

    expect(err.message).toContain('Source "Jackett" : erreur Torznab');
    expect(err.message).not.toContain(KEY);
  });

  it('liste vide : aucune requête, résultat vide', async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([])));
    const streams = await searchJackett({ name: 'Jackett', baseUrl: BASE, apiKey: KEY, indexers: [] }, MOVIE, { fetch });
    expect(streams).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});
