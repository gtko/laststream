import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeLookup, json, KEYS, mockUpstream, SECRET, tokenFor } from '../tests/harness-core.js';
import { refreshRowsFromEnv } from '../src/platform/workers/index.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { startApp } from './harness.js';

/** Rangées d'accueil communes sous Workers : cron dans le bucket R2 META, puis route servie sans appel TMDB. */

const workerEnv = env as unknown as WorkerEnv;
const TMDB = 'https://api.themoviedb.org/3';
const TRENDING_KEY = 'rows/lastaddon-trending.json';
const SERIES_KEY = 'rows/lastaddon-popular-series.json';

const MATRIX = { id: 'tt0133093', type: 'movie', name: 'Matrix', poster: 'https://image.tmdb.org/t/p/w500/m.jpg', description: 'Simulation', releaseInfo: '1999' };
const GOT = { id: 'tt0944947', type: 'series', name: 'Game of Thrones', releaseInfo: '2011' };
const GOT_POPULAR = { id: 'tt0944947', type: 'series', name: 'Game of Thrones' };

function amont() {
  return mockUpstream({
    [`${TMDB}/trending/all/week`]: () =>
      json({
        results: [
          { id: 603, media_type: 'movie', title: 'Matrix', poster_path: '/m.jpg', release_date: '1999-03-31', overview: 'Simulation' },
          { id: 1399, media_type: 'tv', name: 'Game of Thrones', first_air_date: '2011-04-17', poster_path: null },
        ],
      }),
    [`${TMDB}/movie/popular`]: () => json({ results: [{ id: 603, title: 'Matrix' }] }),
    [`${TMDB}/tv/popular`]: () => json({ results: [{ id: 1399, name: 'Game of Thrones' }] }),
    [`${TMDB}/movie/603/external_ids`]: () => json({ imdb_id: 'tt0133093' }),
    [`${TMDB}/tv/1399/external_ids`]: () => json({ imdb_id: 'tt0944947' }),
  });
}

describe('rangées communes sous Workers (R2 META)', () => {
  it('cron remplit R2 ; la route sert R2 telle quelle à deux comptes, sans appel TMDB ; 304 ; pas de réécriture si inchangé', async () => {
    const upstream = amont();
    const statuses = await refreshRowsFromEnv(workerEnv, { fetch: upstream.fetch, token: KEYS.tmdbToken, secret: SECRET });
    expect(statuses).toEqual({ 'lastaddon-trending': 'written', 'lastaddon-popular-movies': 'written', 'lastaddon-popular-series': 'written' });
    expect(upstream.calls.length).toBeGreaterThan(0);
    const head = await workerEnv.META?.head(TRENDING_KEY);
    expect(head?.customMetadata?.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Number(head?.customMetadata?.generatedAt)).toBeGreaterThan(0);
    const body = await (await workerEnv.META?.get(TRENDING_KEY))?.text();
    expect(JSON.parse(body ?? '')).toEqual({ metas: [MATRIX, GOT] });

    // Passage suivant, contenu inchangé : aucune réécriture.
    const uploaded = head?.uploaded.getTime();
    const again = await refreshRowsFromEnv(workerEnv, { fetch: upstream.fetch, token: KEYS.tmdbToken, secret: SECRET });
    expect(Object.values(again ?? {})).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect((await workerEnv.META?.head(TRENDING_KEY))?.uploaded.getTime()).toBe(uploaded);

    // Contenu de R2 remplacé par un marqueur : la route doit le servir tel quel. Le cache partagé de TMDB (KV) ne masque
    // donc pas la lecture de R2, et un appel TMDB ne peut pas produire ce corps.
    const marker = JSON.stringify({ metas: [{ id: 'tt0000001', type: 'movie', name: 'Marqueur R2' }] });
    const markerEtag = '"00000000000000000000000000000001"';
    await workerEnv.META?.put(TRENDING_KEY, marker, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { etag: markerEtag, generatedAt: '1' },
    });

    const running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    try {
      const callsBefore = upstream.calls.length;
      const url = (token: string) => `${running.baseUrl}/${token}/catalog/movie/lastaddon-trending.json`;
      const first = await fetch(url(tokenFor({ tmdbToken: KEYS.tmdbToken })));
      const second = await fetch(url(tokenFor({ tmdbToken: 'autre-jeton-tmdb-789' })));
      expect(first.status).toBe(200);
      expect(await first.text()).toBe(marker);
      expect(await second.text()).toBe(marker);
      expect(first.headers.get('etag')).toBe(markerEtag);
      expect(first.headers.get('cache-control')).toBe('private, max-age=300');
      expect(upstream.calls.length).toBe(callsBefore);

      const cached = await fetch(url(tokenFor({ tmdbToken: KEYS.tmdbToken })), { headers: { 'if-none-match': markerEtag } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get('etag')).toBe(markerEtag);
      expect(upstream.calls.length).toBe(callsBefore);
    } finally {
      await running.close();
    }
  });

  it('R2 vide (premier démarrage) : la route calcule la réponse habituelle depuis TMDB', async () => {
    await workerEnv.META?.delete([SERIES_KEY]);
    const running = await startApp({ fetch: amont().fetch, lookupHost: fakeLookup() });
    try {
      const res = await fetch(`${running.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/catalog/series/lastaddon-popular-series.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ metas: [GOT_POPULAR] });
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    } finally {
      await running.close();
    }
  });

  it('sans jeton TMDB côté serveur ni dans la configuration : rien n’est écrit', async () => {
    await workerEnv.META?.delete([SERIES_KEY]);
    const statuses = await refreshRowsFromEnv(workerEnv, { fetch: amont().fetch, secret: SECRET, token: undefined });
    expect(statuses).toBeUndefined();
    expect(await workerEnv.META?.head(SERIES_KEY)).toBeNull();
  });
});
