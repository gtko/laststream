import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/deps.js';
import { buildCatalogMetas, CATALOGS } from '../src/lt/catalog.js';
import { createLtContext } from '../src/lt/context.js';
import { fakeLookup, type Handler, json, KEYS, mockUpstream, SECRET } from './lt-harness.js';

/**
 * LAST-138 (Sentry SERVER-3, « N+1 API Call ») : une page de catalogue résout l'id IMDb de ses 20 titres par 20 appels
 * `/external_ids` chez TMDB. L'identifiant ne change plus : une page reconstruite ne doit plus les rappeler.
 */

const TMDB = 'https://api.themoviedb.org/3';
const POPULAR = CATALOGS[1];
const COUNT = 20;
const HOUR = 3600e3;

const ids = Array.from({ length: COUNT }, (_, i) => 1000 + i);

function upstream() {
  const handlers: Record<string, Handler> = {
    [`${TMDB}/movie/popular`]: () => json({ results: ids.map((id) => ({ id, title: `Film ${id}` })) }),
  };
  for (const id of ids) handlers[`${TMDB}/movie/${id}/external_ids`] = () => json({ imdb_id: `tt${id}` });
  return mockUpstream(handlers);
}

function newContext(fetchFn: typeof fetch) {
  return createLtContext({ secret: SECRET, allowPlain: false, fetch: fetchFn, lookupHost: fakeLookup() } as unknown as AppDeps);
}

const externalIdCalls = (mock: ReturnType<typeof upstream>): number => mock.calls.filter((c) => c.url.pathname.endsWith('/external_ids')).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('catalogue TMDB : résolution des ids IMDb (LAST-138)', () => {
  it('première page : un appel external_ids par titre (sans doublon), les appels simultanés sont joints', async () => {
    const mock = upstream();
    const ctx = newContext(mock.fetch);
    const [a, b] = await Promise.all([
      buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1),
      buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1),
    ]);
    expect(a).toHaveLength(COUNT);
    expect(b).toEqual(a);
    expect(externalIdCalls(mock)).toBe(COUNT);
  });

  it('page reconstruite 7 h plus tard : aucun nouvel appel external_ids (20 avant, 0 après)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2027, 0, 1));
    const mock = upstream();
    const ctx = newContext(mock.fetch);
    await buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1);
    expect(externalIdCalls(mock)).toBe(COUNT);

    vi.setSystemTime(Date.UTC(2027, 0, 1) + 7 * HOUR);
    const again = await buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1);
    expect(again.map((m) => m.id)).toEqual(ids.map((id) => `tt${id}`));
    expect(mock.callsTo(`${TMDB}/movie/popular`)).toHaveLength(2);
    expect(externalIdCalls(mock)).toBe(COUNT);
  });

  it('un seul titre nouveau dans la liste : un seul appel external_ids de plus', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2027, 0, 1));
    const withNew = [...ids, 2000];
    let results = ids;
    const handlers: Record<string, Handler> = { [`${TMDB}/movie/popular`]: () => json({ results: results.map((id) => ({ id, title: `Film ${id}` })) }) };
    for (const id of withNew) handlers[`${TMDB}/movie/${id}/external_ids`] = () => json({ imdb_id: `tt${id}` });
    const mock = mockUpstream(handlers);
    const ctx = newContext(mock.fetch);
    await buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1);
    results = withNew;
    vi.setSystemTime(Date.UTC(2027, 0, 1) + 7 * HOUR);
    const next = await buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1);
    expect(next).toHaveLength(COUNT + 1);
    expect(externalIdCalls(mock)).toBe(COUNT + 1);
  });

  it('absence d’id IMDb : reconsultée après 6 h + fenêtre SWR (sortie récente), non gardée 30 jours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2027, 0, 1));
    let imdb: string | null = null;
    const mock = mockUpstream({
      [`${TMDB}/movie/popular`]: () => json({ results: [{ id: 5, title: 'Récent' }] }),
      [`${TMDB}/movie/5/external_ids`]: () => json({ imdb_id: imdb }),
    });
    const ctx = newContext(mock.fetch);
    expect(await buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1)).toEqual([]);
    imdb = 'tt0000005';
    vi.setSystemTime(Date.UTC(2027, 0, 1) + 13 * HOUR);
    const later = await buildCatalogMetas(ctx, KEYS.tmdbToken, POPULAR, 1);
    expect(later.map((m) => m.id)).toEqual(['tt0000005']);
    expect(externalIdCalls(mock)).toBe(2);
  });
});
