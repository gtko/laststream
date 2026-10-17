import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import { searchProwlarr, type ProwlarrSource } from '../src/sources/prowlarr.js';
import type { ContentRef } from '../src/types.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt15239678', imdbId: 'tt15239678' };
const KEY = 'PR-SECRET-KEY-4242';
const SOURCE: ProwlarrSource = { name: 'Prowlarr', baseUrl: 'https://prowlarr.example.com', apiKey: KEY };
const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';
const TITLES = { titles: ['Dune Part Two', 'Dune Deuxième Partie'], year: 2024 };

/** Indexeur qui ne répond qu'à la recherche texte (pas d'identifiant IMDb). */
function textOnly(id: number, name: string) {
  return {
    id,
    name,
    protocol: 'torrent',
    enable: true,
    privacy: 'public',
    capabilities: { movieSearchParams: ['q'], tvSearchParams: ['q'] },
  };
}

/** Indexeur qui accepte l'identifiant IMDb pour les films. */
function idCapable(id: number, name: string) {
  return {
    id,
    name,
    protocol: 'torrent',
    enable: true,
    privacy: 'public',
    capabilities: { movieSearchParams: ['q', 'imdbId'], tvSearchParams: ['q', 'imdbId'] },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Faux Prowlarr : indexeurs sur /api/v1/indexer, `search` pour /api/v1/search. Aucun réseau. */
function prowlarr(
  indexers: unknown[],
  search: (url: URL) => Response | Promise<Response>,
): { fetch: FetchFn; searches: () => URL[] } {
  const mock = vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === '/api/v1/indexer') return Promise.resolve(jsonResponse(indexers));
    if (url.pathname === '/api/v1/search') return Promise.resolve(search(url));
    return Promise.resolve(new Response('introuvable', { status: 404 }));
  });
  const searches = (): URL[] =>
    mock.mock.calls.map((call) => new URL(String(call[0]))).filter((url) => url.pathname === '/api/v1/search');
  return { fetch: mock as unknown as FetchFn, searches };
}

function query(url: URL): string {
  return url.searchParams.get('query') ?? '';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('searchProwlarr : requêtes texte par variante de titre', () => {
  it('plusieurs requêtes texte partent en parallèle et leurs résultats sont fusionnés sans doublon', async () => {
    const releaseA = { title: 'Dune.Part.Two.2024.1080p.WEB', indexer: 'Beta', indexerId: 2, infoHash: HASH_A, guid: 'guid-a' };
    const releaseB = { title: 'Dune.Deuxieme.Partie.2024.FRENCH.1080p', indexer: 'Beta', indexerId: 2, infoHash: HASH_B, guid: 'guid-b' };
    let inFlight = 0;
    let maxInFlight = 0;
    const { fetch, searches } = prowlarr([textOnly(2, 'Beta')], async (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(30);
      inFlight -= 1;
      const byQuery: Record<string, unknown[]> = {
        'Dune Part Two 2024': [releaseA],
        'Dune Deuxième Partie 2024': [releaseA, releaseB],
        'Dune Deuxieme Partie 2024': [releaseB],
      };
      return jsonResponse(byQuery[query(url)] ?? []);
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titles: TITLES });

    expect(searches().map(query)).toEqual([
      'Dune Part Two 2024',
      'Dune Deuxième Partie 2024',
      'Dune Deuxieme Partie 2024',
    ]);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(streams.map((stream) => stream.title)).toEqual([
      'Dune.Part.Two.2024.1080p.WEB',
      'Dune.Deuxieme.Partie.2024.FRENCH.1080p',
    ]);
    expect(streams.map((stream) => stream.infoHash)).toEqual([HASH_A, HASH_B]);
  });

  it('un indexeur qui ne répond qu’au titre français est interrogé et renvoie ses résultats ; l’année hors ±1 est écartée', async () => {
    const french = { title: 'Dune.Deuxieme.Partie.2024.FRENCH.1080p', indexer: 'Gamma', indexerId: 5, infoHash: HASH_B };
    const oldDune = { title: 'Dune.1984.FRENCH.720p', indexer: 'Gamma', indexerId: 5, infoHash: HASH_C };
    const { fetch, searches } = prowlarr([idCapable(1, 'Alpha'), textOnly(5, 'Gamma')], (url) => {
      const text = query(url);
      if (url.searchParams.has('imdbId')) return jsonResponse([]);
      if (text.includes('Deuxième') || text.includes('Deuxieme')) return jsonResponse([french, oldDune]);
      return jsonResponse([]); // titre anglais : rien chez cet indexeur
    });

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titles: TITLES });

    expect(searches().map(query).filter(Boolean)).toContain('Dune Part Two 2024');
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ title: 'Dune.Deuxieme.Partie.2024.FRENCH.1080p', sourceName: 'Gamma', infoHash: HASH_B });
  });

  it('même release par la requête id et par la requête texte : une seule entrée, indexeurs réunis', async () => {
    const release = { title: 'Dune.Part.Two.2024.1080p.WEB', infoHash: HASH_A, guid: 'guid-a' };
    const { fetch } = prowlarr([idCapable(1, 'Alpha'), textOnly(2, 'Beta')], (url) =>
      jsonResponse(url.searchParams.has('imdbId') ? [{ ...release, indexer: 'Alpha' }] : [{ ...release, indexer: 'Beta' }]),
    );

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titles: { titles: ['Dune Part Two'], year: 2024 } });

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ sourceName: 'Alpha', infoHash: HASH_A, indexers: ['Alpha', 'Beta'] });
  });

  it('sans infoHash : deux requêtes renvoyant le même guid donnent une seule entrée', async () => {
    const proxied = `https://prowlarr.example.com/1/download?apikey=${KEY}&link=abc`;
    const release = { title: 'Sans.Hash.2024.1080p', indexer: 'Beta', indexerId: 2, downloadUrl: proxied, guid: 'guid-x' };
    const { fetch, searches } = prowlarr([textOnly(2, 'Beta')], () => jsonResponse([release]));

    const streams = await searchProwlarr(SOURCE, MOVIE, { fetch, titles: TITLES });

    expect(searches().length).toBeGreaterThanOrEqual(2);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.guid).toBe('guid-x');
  });

  it('titleInfo reste accepté (rétrocompatibilité) : requête « Titre Année » unique pour un titre sans variante', async () => {
    const { fetch, searches } = prowlarr([textOnly(2, 'Beta')], () => jsonResponse([]));

    await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film', year: 2024 } });

    expect(searches().map(query)).toEqual(['Film 2024']);
  });
});
