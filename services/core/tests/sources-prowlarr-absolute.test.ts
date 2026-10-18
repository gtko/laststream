import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import { clearProwlarrDiscoveryCache, searchProwlarr, type ProwlarrSource } from '../src/sources/prowlarr.js';
import type { ContentRef } from '../src/types.js';

const SOURCE: ProwlarrSource = { name: 'Prowlarr', baseUrl: 'https://prowlarr.example.com', apiKey: 'ABS-KEY-TEST' };
/** Frieren S01E05 : numéro absolu 5 (remappage Fribb). */
const EPISODE: ContentRef = { type: 'series', id: 'tt22248376:1:5', imdbId: 'tt22248376', season: 1, episode: 5 };
const INDEXERS = [
  { id: 1, name: 'Alpha', protocol: 'torrent', enable: true, privacy: 'public', capabilities: { tvSearchParams: ['q', 'season', 'ep'] } },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Faux fetch : liste d'indexeurs et recherches vides ; aucun réseau. Renvoie les requêtes texte envoyées. */
function fakeProwlarr() {
  const mock = vi.fn((input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/indexer') return Promise.resolve(json(INDEXERS));
    return Promise.resolve(json([]));
  });
  const queries = (): (string | null)[] =>
    mock.mock.calls
      .map((call) => new URL(String(call[0])))
      .filter((url) => url.pathname === '/api/v1/search' && !url.searchParams.has('imdbId'))
      .map((url) => url.searchParams.get('query'));
  return { fetch: mock as unknown as FetchFn, queries };
}

describe('searchProwlarr : numéro absolu (anime)', () => {
  it('avec numéro absolu : « Titre 05 » et « Titre - 05 » en tête des requêtes texte', async () => {
    clearProwlarrDiscoveryCache();
    const { fetch, queries } = fakeProwlarr();

    await searchProwlarr(SOURCE, EPISODE, { fetch, titleInfo: { title: 'Frieren' }, absolute: 5 });

    expect(queries().slice(0, 2)).toEqual(['Frieren 05', 'Frieren - 05']);
    expect(queries()).toContain('Frieren S01');
  });

  it('sans numéro absolu : aucune requête « Titre 05 »', async () => {
    clearProwlarrDiscoveryCache();
    const { fetch, queries } = fakeProwlarr();

    await searchProwlarr(SOURCE, EPISODE, { fetch, titleInfo: { title: 'Frieren' } });

    expect(queries()).not.toContain('Frieren 05');
    expect(queries()).not.toContain('Frieren - 05');
  });

  it('film : le numéro absolu est ignoré', async () => {
    clearProwlarrDiscoveryCache();
    const { fetch, queries } = fakeProwlarr();
    const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };

    await searchProwlarr(SOURCE, MOVIE, { fetch, titleInfo: { title: 'Film' }, absolute: 5 });

    expect(queries()).toEqual(['Film']);
  });
});
