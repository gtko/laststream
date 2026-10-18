import { describe, expect, it, vi } from 'vitest';
import { searchJackett } from '../src/sources/jackett.js';
import type { FetchFn } from '../src/sources/http.js';
import { searchTorznab, type TorznabSource } from '../src/sources/torznab.js';
import type { ContentRef } from '../src/types.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const SERIES: ContentRef = { type: 'series', id: 'tt1234567:1:2', imdbId: 'tt1234567', season: 1, episode: 2 };
const KEY = 'TZ-SECRET-KEY-77';
const SOURCE: TorznabSource = { name: 'Indexeur', baseUrl: 'https://idx.example.com', apiKey: KEY };
const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TITLES = { titles: ['Dune Part Two'], year: 2024 };

/** Faux fetch : aucun appel réseau ; le gestionnaire reçoit l'URL de chaque requête. */
function mockFetch(handler: (url: URL) => Response | Promise<Response>) {
  const mock = vi.fn((input: string | URL | Request) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(new URL(raw)));
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

/** Flux RSS Torznab : un <item> par release (titre, guid, magnet porteur d'un infoHash). */
function feed(items: { title: string; hash: string; guid: string }[]): string {
  const entries = items
    .map(
      (item) => `<item>
        <title>${item.title}</title>
        <guid>${item.guid}</guid>
        <size>1073741824</size>
        <link>magnet:?xt=urn:btih:${item.hash}&amp;dn=x</link>
      </item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${entries}</channel></rss>`;
}

const DUNE = { title: 'Dune.Part.Two.2024.1080p.WEB', hash: HASH_A, guid: 'guid-a' };

describe('searchTorznab : requêtes texte en plus de la requête par id', () => {
  it('avec des titres : requête par id puis requête texte (t=movie, q=…), résultats fusionnés sans doublon', async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([DUNE])));

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch, titles: TITLES });

    const urls = mock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls).toHaveLength(3);
    const byId = urls.find((url) => url.searchParams.has('imdbid'));
    const byTexts = urls.filter((url) => url.searchParams.has('q'));
    expect(byId?.searchParams.get('t')).toBe('movie');
    expect(byTexts.map((url) => url.searchParams.get('q'))).toEqual(['Dune Part Two', 'Dune Part Two 2024']);
    expect(byTexts.every((url) => url.searchParams.get('t') === 'movie' && !url.searchParams.has('imdbid'))).toBe(true);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ infoHash: HASH_A.toLowerCase(), title: DUNE.title });
  });

  it('film : une requête texte dont l’année diffère de plus de 1 est écartée', async () => {
    const old = { title: 'Dune.1984.1080p.BluRay', hash: HASH_B, guid: 'guid-b' };
    const { fetch } = mockFetch((url) => xmlResponse(feed(url.searchParams.has('q') ? [DUNE, old] : [])));

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch, titles: TITLES });

    expect(streams.map((stream) => stream.title)).toEqual([DUNE.title]);
  });

  it('une requête texte en échec n’efface pas le résultat de la requête par id', async () => {
    const { fetch } = mockFetch((url) =>
      url.searchParams.has('q') ? new Response('boom', { status: 500 }) : xmlResponse(feed([DUNE])),
    );

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch, titles: TITLES });

    expect(streams.map((stream) => stream.title)).toEqual([DUNE.title]);
  });

  it('toutes les requêtes en échec avec des titres : SourceError sûre, sans clé', async () => {
    const { fetch } = mockFetch(() => new Response('boom', { status: 500 }));

    await expect(searchTorznab(SOURCE, MOVIE, { fetch, titles: TITLES })).rejects.toThrow('Source "Indexeur" : HTTP 500');
    const error = await searchTorznab(SOURCE, MOVIE, { fetch, titles: TITLES }).catch((err: Error) => err);
    expect(String(error)).not.toContain(KEY);
  });

  it('budget épuisé : les requêtes texte sont ignorées, seule la requête par id part', async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([DUNE])));

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch, titles: TITLES, budgetMs: 0 });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(1);
  });

  it('sans titre : une seule requête, par id (comportement inchangé)', async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([DUNE])));

    await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('série : requêtes texte « Titre S01E02 », « Titre Saison 1 », « Titre S01 » en tvsearch', async () => {
    const { fetch, mock } = mockFetch(() => xmlResponse(feed([])));

    await searchTorznab(SOURCE, SERIES, { fetch, titles: { titles: ['Severance'] } });

    const queries = mock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.searchParams.has('q'))
      .map((url) => [url.searchParams.get('t'), url.searchParams.get('q')]);
    expect(queries).toEqual([
      ['tvsearch', 'Severance S01E02'],
      ['tvsearch', 'Severance Saison 1'],
      ['tvsearch', 'Severance S01'],
    ]);
  });
});

describe('searchJackett : titres transmis à chaque cible', () => {
  it('cible agrégée « all » : la requête texte part vers l’endpoint Torznab Jackett', async () => {
    const { fetch, mock } = mockFetch((url) => xmlResponse(feed(url.searchParams.has('q') ? [DUNE] : [])));

    const streams = await searchJackett(
      { name: 'Jackett', baseUrl: 'http://127.0.0.1:9117', apiKey: KEY, indexers: 'all' },
      MOVIE,
      { fetch, titles: TITLES },
    );

    const urls = mock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls.every((url) => url.pathname === '/api/v2.0/indexers/all/results/torznab/api')).toBe(true);
    expect(urls.some((url) => url.searchParams.get('q') === 'Dune Part Two 2024')).toBe(true);
    expect(streams.map((stream) => stream.title)).toEqual([DUNE.title]);
  });
});
