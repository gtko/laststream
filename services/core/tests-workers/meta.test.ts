import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeLookup, json, KEYS, mockUpstream, tokenFor } from '../tests/harness-core.js';
import { startApp } from './harness.js';
import { createR2MetaBlobs } from '../src/platform/workers/meta-blobs.js';
import { createDurableObjectUserBackend } from '../src/platform/workers/user-backend.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';

const workerEnv = env as unknown as WorkerEnv;
const TMDB = 'https://api.themoviedb.org/3';

describe('fiches partagées sous Workers', () => {
  it('index meta_index : migration v12 appliquée au Durable Object, lecture et écriture par RPC', async () => {
    const backend = createDurableObjectUserBackend(workerEnv.USER_STORE, `meta-${crypto.randomUUID()}`);
    const meta = backend.meta();
    expect(await meta.find('movie', 603)).toBeUndefined();
    await meta.upsert({
      type: 'movie',
      tmdbId: 603,
      imdbId: 'tt0133093',
      tvdbId: null,
      title: 'Matrix',
      originalTitle: 'The Matrix',
      year: 1999,
      status: 'Released',
      updatedAt: '2026-10-19T12:00:00.000Z',
      nextAirDate: null,
      etag: '"abc"',
    });
    expect(await meta.find('movie', 603)).toMatchObject({ title: 'Matrix', etag: '"abc"', year: 1999 });
    expect((await meta.findByImdb('tt0133093')).map((r) => r.tmdbId)).toEqual([603]);
  });

  it('stockage R2 (binding META) : écriture puis lecture du corps, de l’empreinte et de l’échéance', async () => {
    const blobs = createR2MetaBlobs(workerEnv.META as NonNullable<WorkerEnv['META']>);
    const key = `meta/test/${crypto.randomUUID()}.json`;
    expect(await blobs.get(key)).toBeUndefined();
    const expiresAt = Date.now() + 86_400_000;
    await blobs.put(key, { body: '{"v":1}', etag: '"0123"', expiresAt });
    expect(await blobs.get(key)).toEqual({ body: '{"v":1}', etag: '"0123"', expiresAt });
  });

  it('route /lt/meta : construite une fois, servie depuis R2 à un autre compte sans appel amont, 304 sur If-None-Match', async () => {
    const id = String(700_000 + Math.floor(Math.random() * 100_000));
    const upstream = mockUpstream({
      [`${TMDB}/movie/${id}`]: () =>
        json({ id: Number(id), title: 'Film de test', original_title: 'Test movie', release_date: '2001-01-01', status: 'Released', credits: { cast: [] } }),
    });
    const running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    try {
      const accountA = tokenFor({ tmdbToken: KEYS.tmdbToken });
      const accountB = tokenFor({ tmdbToken: 'autre-jeton-tmdb-789' });
      const first = await fetch(`${running.baseUrl}/${accountA}/lt/meta/movie/${id}`);
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      const body = await first.text();
      expect(JSON.parse(body)).toMatchObject({ title: 'Film de test', year: 2001 });
      const calls = upstream.calls.length;
      expect(calls).toBeGreaterThan(0);
      expect(await workerEnv.META?.head(`meta/movie/${id}.json`)).not.toBeNull();

      const second = await fetch(`${running.baseUrl}/${accountB}/lt/meta/movie/${id}`);
      expect(second.status).toBe(200);
      expect(await second.text()).toBe(body);
      expect(upstream.calls.length).toBe(calls);

      const cached = await fetch(`${running.baseUrl}/${accountB}/lt/meta/movie/${id}`, { headers: { 'if-none-match': etag as string } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get('etag')).toBe(etag);
      expect(cached.headers.get('cache-control')).toBe('private, max-age=300');
    } finally {
      await running.close();
    }
  });
});
