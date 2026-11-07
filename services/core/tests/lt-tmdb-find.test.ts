import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  const bearerOk = (call: { headers: Record<string, string> }): boolean => call.headers.authorization === `Bearer ${KEYS.tmdbToken}`;
  upstream = mockUpstream({
    [`${TMDB}/find/tt0133093`]: (call) =>
      bearerOk(call) ? json({ movie_results: [{ id: 603, title: 'Matrix' }], tv_results: [] }) : json({ status_message: 'nope' }, 401),
    [`${TMDB}/find/81189`]: (call) =>
      bearerOk(call) ? json({ movie_results: [], tv_results: [{ id: 1396, name: 'Breaking Bad' }] }) : json({ status_message: 'nope' }, 401),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const tmdbToken = (): string => tokenFor({ tmdbToken: KEYS.tmdbToken });

describe('lt/tmdb/find : recherche par identifiant externe', () => {
  it('find/{imdb id} avec external_source=imdb_id : transmis, réponse TMDB renvoyée', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/find/tt0133093?external_source=imdb_id`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ movie_results: [{ id: 603, title: 'Matrix' }], tv_results: [] });
    const call = upstream.callsTo(`${TMDB}/find/tt0133093`).at(-1);
    expect(call?.url.searchParams.get('external_source')).toBe('imdb_id');
    expect(call?.url.searchParams.get('language')).toBe('fr-FR');
    expect(call?.headers.authorization).toBe(`Bearer ${KEYS.tmdbToken}`);
  });

  it('find/{tvdb id} avec external_source=tvdb_id : transmis', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/find/81189?external_source=tvdb_id`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { tv_results: unknown[] }).toMatchObject({ tv_results: [{ id: 1396 }] });
    expect(upstream.callsTo(`${TMDB}/find/81189`).at(-1)?.url.searchParams.get('external_source')).toBe('tvdb_id');
  });

  it('external_source hors liste blanche : paramètre écarté, pas transmis', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/find/tt0133093?external_source=facebook_id`);
    expect(res.status).toBe(200);
    const call = upstream.callsTo(`${TMDB}/find/tt0133093`).at(-1);
    expect(call?.url.searchParams.has('external_source')).toBe(false);
  });

  it('chemin find avec segment invalide : 404 not_found', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/find/..%2Fsecret`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
