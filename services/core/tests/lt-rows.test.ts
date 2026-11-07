import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLtContext } from '../src/lt/context.js';
import { type RowBlob, type RowBlobStore, refreshRows, rowKey } from '../src/lt/rows.js';
import { CATALOGS } from '../src/lt/catalog.js';
import { metricsService } from '../src/metrics/index.js';
import { fakeLookup, type Handler, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, SECRET, startApp, tokenFor } from './lt-harness.js';

/** Rangées d'accueil communes (lt/rows.ts) : cron qui remplit le stockage, route qui sert sans appel TMDB, 304, repli. */

const TMDB = 'https://api.themoviedb.org/3';
const TRENDING = CATALOGS[0];
const POPULAR_MOVIES = CATALOGS[1];
const POPULAR_SERIES = CATALOGS[2];

class MemoryRows implements RowBlobStore {
  readonly items = new Map<string, RowBlob>();
  puts = 0;

  get(key: string): Promise<RowBlob | undefined> {
    return Promise.resolve(this.items.get(key));
  }

  put(key: string, blob: RowBlob): Promise<void> {
    this.puts += 1;
    this.items.set(key, blob);
    return Promise.resolve();
  }
}

const MATRIX = { id: 'tt0133093', type: 'movie', name: 'Matrix', poster: 'https://image.tmdb.org/t/p/w500/m.jpg', description: 'Simulation', releaseInfo: '1999' };
const GOT = { id: 'tt0944947', type: 'series', name: 'Game of Thrones', releaseInfo: '2011' };
/** Série populaire : la réponse TMDB de ce test ne porte pas de date de sortie. */
const GOT_POPULAR = { id: 'tt0944947', type: 'series', name: 'Game of Thrones' };

/** Simulation de TMDB ; `trendingStatus` permet de simuler une panne amont. */
function tmdb(state: { trendingStatus: number; seriesResults: unknown[] }): MockUpstream {
  const trending: Handler = () =>
    state.trendingStatus === 200
      ? json({
          results: [
            { id: 603, media_type: 'movie', title: 'Matrix', poster_path: '/m.jpg', release_date: '1999-03-31', overview: 'Simulation' },
            { id: 1399, media_type: 'tv', name: 'Game of Thrones', first_air_date: '2011-04-17', poster_path: null },
            { id: 777, media_type: 'movie', title: 'Sans identifiant IMDb' },
          ],
        })
      : new Response('panne', { status: state.trendingStatus });
  return mockUpstream({
    [`${TMDB}/trending/all/week`]: trending,
    [`${TMDB}/movie/popular`]: () => json({ results: [{ id: 603, title: 'Matrix' }] }),
    [`${TMDB}/tv/popular`]: () => json({ results: state.seriesResults }),
    [`${TMDB}/movie/603/external_ids`]: () => json({ imdb_id: 'tt0133093' }),
    [`${TMDB}/tv/1399/external_ids`]: () => json({ imdb_id: 'tt0944947' }),
    [`${TMDB}/movie/777/external_ids`]: () => json({ imdb_id: null }),
  });
}

const freshState = (): { trendingStatus: number; seriesResults: unknown[] } => ({
  trendingStatus: 200,
  seriesResults: [{ id: 1399, name: 'Game of Thrones' }],
});

/** Métas servies pour une rangée, lues dans le stockage (corps tel que servi). */
function metasOf(body: string): unknown {
  return (JSON.parse(body) as { metas: unknown }).metas;
}

async function refreshWith(upstream: MockUpstream, store: RowBlobStore) {
  const ctx = createLtContext({ secret: SECRET, allowPlain: false, fetch: upstream.fetch, lookupHost: fakeLookup() });
  return refreshRows({ ctx, blobs: store, now: () => Date.UTC(2027, 0, 1) }, KEYS.tmdbToken);
}

async function rowsTotals(): Promise<{ r2Hits: number; r2Misses: number; notModified: number }> {
  const service = metricsService();
  if (service === undefined) throw new Error('métriques absentes');
  await service.flush?.();
  const report = await service.report('1h');
  const row = report.providers.totals.find((entry) => entry.provider === 'rows');
  return { r2Hits: row?.r2Hits ?? 0, r2Misses: row?.r2Misses ?? 0, notModified: row?.notModified ?? 0 };
}

let running: RunningApp | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

describe('rangées communes : cron', () => {
  it('remplit le stockage : une rangée par catalogue, corps { metas }, empreinte et date de génération', async () => {
    const store = new MemoryRows();
    const statuses = await refreshWith(tmdb(freshState()), store);
    expect(statuses).toEqual({ 'lastaddon-trending': 'written', 'lastaddon-popular-movies': 'written', 'lastaddon-popular-series': 'written' });
    const trending = store.items.get(rowKey(TRENDING));
    expect(trending?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(trending?.generatedAt).toBe(Date.UTC(2027, 0, 1));
    expect(metasOf(trending?.body ?? '')).toEqual([MATRIX, GOT]);
    expect(metasOf(store.items.get(rowKey(POPULAR_SERIES))?.body ?? '')).toEqual([GOT_POPULAR]);
  });

  it('contenu inchangé : rangées non réécrites au passage suivant', async () => {
    const store = new MemoryRows();
    await refreshWith(tmdb(freshState()), store);
    const puts = store.puts;
    const statuses = await refreshWith(tmdb(freshState()), store);
    expect(Object.values(statuses)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(store.puts).toBe(puts);
  });

  it('panne TMDB : la rangée précédente est conservée ; liste vide : rien n’est écrit', async () => {
    const store = new MemoryRows();
    await refreshWith(tmdb(freshState()), store);
    const kept = store.items.get(rowKey(TRENDING));
    const state = { trendingStatus: 500, seriesResults: [] };
    const statuses = await refreshWith(tmdb(state), store);
    expect(statuses['lastaddon-trending']).toBe('failed');
    expect(statuses['lastaddon-popular-series']).toBe('skipped');
    expect(store.items.get(rowKey(TRENDING))).toEqual(kept);
    expect(store.items.get(rowKey(POPULAR_SERIES))).toBeDefined();
  });
});

describe('rangées communes : route', () => {
  it('servie depuis R2 à deux comptes différents, sans aucun appel TMDB ; compteurs rows', async () => {
    const store = new MemoryRows();
    await refreshWith(tmdb(freshState()), store);
    const upstream = tmdb(freshState());
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), extra: { rowBlobs: store } });
    const before = await rowsTotals();
    const accountA = tokenFor({ tmdbToken: KEYS.tmdbToken });
    const accountB = tokenFor({ tmdbToken: 'autre-jeton-tmdb-789' });
    const stored = store.items.get(rowKey(TRENDING));

    const first = await fetch(`${running.baseUrl}/${accountA}/catalog/movie/lastaddon-trending.json`);
    const second = await fetch(`${running.baseUrl}/${accountB}/catalog/movie/lastaddon-trending.json`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(stored?.body);
    expect(await second.text()).toBe(stored?.body);
    expect(first.headers.get('etag')).toBe(stored?.etag);
    expect(first.headers.get('cache-control')).toBe('private, max-age=300');
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    expect(upstream.calls).toHaveLength(0);

    const after = await rowsTotals();
    expect(after.r2Hits - before.r2Hits).toBe(2);
  });

  it('If-None-Match identique : 304 sans corps, même empreinte et cache court', async () => {
    const store = new MemoryRows();
    await refreshWith(tmdb(freshState()), store);
    running = await startApp({ fetch: tmdb(freshState()).fetch, lookupHost: fakeLookup(), extra: { rowBlobs: store } });
    const url = `${running.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/catalog/movie/lastaddon-trending.json`;
    const first = await fetch(url);
    const etag = first.headers.get('etag') ?? '';
    const before = await rowsTotals();
    const cached = await fetch(url, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(cached.headers.get('etag')).toBe(etag);
    expect(cached.headers.get('cache-control')).toBe('private, max-age=300');
    expect((await rowsTotals()).notModified - before.notModified).toBe(1);
  });

  it('R2 vide : calcul comme avant, puis écriture en arrière-plan ; rangée illisible recalculée', async () => {
    const store = new MemoryRows();
    const upstream = tmdb(freshState());
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), extra: { rowBlobs: store } });
    const url = `${running.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/catalog/series/lastaddon-popular-series.json`;
    const res = await fetch(url);
    expect(await res.json()).toEqual({ metas: [GOT_POPULAR] });
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(upstream.calls.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(store.items.has(rowKey(POPULAR_SERIES))).toBe(true));

    store.items.set(rowKey(POPULAR_SERIES), { body: 'pas du json', etag: '"x"', generatedAt: 1 });
    const repaired = await fetch(url);
    expect(await repaired.json()).toEqual({ metas: [GOT_POPULAR] });
    await vi.waitFor(() => expect(metasOf(store.items.get(rowKey(POPULAR_SERIES))?.body ?? '')).toEqual([GOT_POPULAR]));
  });

  it('sans R2 (Node) : calcul à chaque demande, empreinte et 304 tout de même', async () => {
    const upstream = tmdb(freshState());
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const url = `${running.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/catalog/movie/lastaddon-trending.json`;
    const first = await fetch(url);
    expect(await first.json()).toEqual({ metas: [MATRIX, GOT] });
    const etag = first.headers.get('etag') ?? '';
    const again = await fetch(url, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });

  it('pages suivantes (skip > 0) : chemin inchangé, sans R2', async () => {
    const store = new MemoryRows();
    await refreshWith(tmdb(freshState()), store);
    const upstream = tmdb(freshState());
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup(), extra: { rowBlobs: store } });
    const res = await fetch(`${running.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/catalog/movie/${POPULAR_MOVIES.id}/skip=20.json`);
    expect(res.status).toBe(200);
    expect(upstream.callsTo(`${TMDB}/movie/popular`).at(-1)?.url.searchParams.get('page')).toBe('2');
  });
});
