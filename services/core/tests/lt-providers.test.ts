import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLookup, fullToken, json, KEYS, mockUpstream, type MockUpstream, startApp, type RunningApp, tokenFor } from './lt-harness.js';

let upstream: MockUpstream;
let app: RunningApp;
let tmdbCalls = 0;

beforeAll(async () => {
  upstream = mockUpstream({
    'https://api.themoviedb.org/3/movie/603': (call) => {
      tmdbCalls += 1;
      if (call.headers.authorization !== `Bearer ${KEYS.tmdbToken}`) return json({ status_message: 'nope' }, 401);
      return json({ id: 603, title: 'Matrix', original_title: 'The Matrix' });
    },
    'https://api.themoviedb.org/3/person/1': () => json({ id: 1 }),
    'https://api.themoviedb.org/3/search/movie': () => json({ results: [{ id: 603, title: 'Matrix' }] }),
    'https://api.themoviedb.org/3/tv/1/broken': () => json({ error: 'x' }, 500),
    'https://api.themoviedb.org/3/movie/401': () => json({ status_message: 'invalid token' }, 401),
    'https://api.mdblist.com/imdb/movie/tt0133093': (call) => {
      if (call.url.searchParams.get('apikey') !== KEYS.mdblistApiKey) return json({ error: 'key' }, 401);
      return json({
        title: 'The Matrix',
        score: 84,
        ratings: [
          { source: 'imdb', value: 8.7 },
          { source: 'tomatoes', value: 88 },
          { source: 'popcorn', value: 85 },
          { source: 'metacritic', value: 73 },
          { source: 'letterboxd', value: 4.2 },
          { source: 'tmdb', value: 8.2 },
          { source: 'trakt', value: 86 },
        ],
      });
    },
    'https://api.mdblist.com/tmdb/show/1399': () =>
      json({ score: null, ratings: [{ source: 'tomatoes', value: 'n/a' }, { source: 'tomatoesaudience', value: 71 }] }),
    'https://api4.thetvdb.com/v4/login': (call) => {
      const body = JSON.parse(call.body) as { apikey?: string };
      if (body.apikey !== KEYS.tvdbApiKey) return json({ status: 'failure' }, 401);
      return json({ data: { token: 'tvdb-session-token' } });
    },
    'https://api4.thetvdb.com/v4/series/81189/extended': (call) => {
      if (call.headers.authorization !== 'Bearer tvdb-session-token') return json({ status: 'failure' }, 401);
      return json({
        data: {
          status: { name: 'Continuing' },
          nextAired: '2026-11-01',
          lastAired: '2026-10-01',
          seasons: [
            { number: 0, type: { type: 'official' } },
            { number: 1, type: { type: 'official' } },
            { number: 2, type: { type: 'official' } },
            { number: 3, type: { type: 'dvd' } },
          ],
        },
      });
    },
    'https://api4.thetvdb.com/v4/series/999/extended': () => json({ status: 'failure' }, 500),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const tmdbToken = (): string => tokenFor({ tmdbToken: KEYS.tmdbToken });

describe('lt : services non configurés', () => {
  it('TMDB sans jeton : 404 service_not_configured avec le nom du service', async () => {
    const res = await fetch(`${app.baseUrl}/${tokenFor({})}/lt/tmdb/movie/603`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'service_not_configured', service: 'tmdb' });
  });

  it('MDBList, TVDB et OpenRouter sans clé : 404 avec le service concerné', async () => {
    const empty = tokenFor({});
    expect(await (await fetch(`${app.baseUrl}/${empty}/lt/mdblist/movie/tt0133093`)).json()).toEqual({
      error: 'service_not_configured',
      service: 'mdblist',
    });
    expect(await (await fetch(`${app.baseUrl}/${empty}/lt/tvdb/series/81189`)).json()).toEqual({
      error: 'service_not_configured',
      service: 'tvdb',
    });
    const why = await fetch(`${app.baseUrl}/${empty}/lt/why`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Matrix' }),
    });
    expect(why.status).toBe(404);
    expect(await why.json()).toEqual({ error: 'service_not_configured', service: 'openrouter' });
  });

  it('configuration illisible : 400 invalid_config', async () => {
    const res = await fetch(`${app.baseUrl}/pas-une-config!/lt/tv/stats`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config' });
  });
});

describe('lt/health', () => {
  it('indique quels services sont configurés, sans jamais renvoyer de clé', async () => {
    const res = await fetch(`${app.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken, fanartApiKey: KEYS.fanartApiKey })}/lt/health`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      ok: true,
      configured: { tmdb: true, mdblist: false, tvdb: false, openrouter: false, fanart: true },
    });
    expect(body).not.toContain(KEYS.tmdbToken);
  });
});

describe('lt/tmdb', () => {
  it('transmet le jeton en Bearer, applique fr-FR et FR, renvoie le JSON TMDB', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/movie/603`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 603, title: 'Matrix', original_title: 'The Matrix' });
    const call = upstream.callsTo('https://api.themoviedb.org/3/movie/603').at(-1);
    expect(call?.url.searchParams.get('language')).toBe('fr-FR');
    expect(call?.url.searchParams.get('region')).toBe('FR');
    expect(call?.headers.authorization).toBe(`Bearer ${KEYS.tmdbToken}`);
  });

  it('transmet les paramètres de requête (query, year)', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/search/movie?query=matrix&year=1999`);
    expect(res.status).toBe(200);
    const call = upstream.callsTo('https://api.themoviedb.org/3/search/movie').at(-1);
    expect(call?.url.searchParams.get('query')).toBe('matrix');
    expect(call?.url.searchParams.get('year')).toBe('1999');
  });

  it('met en cache : une seule requête amont pour deux appels identiques', async () => {
    const before = tmdbCalls;
    await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/person/1`);
    await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/person/1`);
    expect(upstream.callsTo('https://api.themoviedb.org/3/person/1').length).toBe(1);
    expect(tmdbCalls).toBe(before);
  });

  it('chemin hors liste blanche : 404 not_found, sans appel amont', async () => {
    const before = upstream.calls.length;
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/account/secret`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(upstream.calls.length).toBe(before);
  });

  it('erreur amont : 502 upstream_<statut>, sans jeton dans la réponse', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/movie/401`);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'upstream_401' });
    expect(body).not.toContain(KEYS.tmdbToken);
  });

  it('erreur 500 amont : 502 upstream_500', async () => {
    const res = await fetch(`${app.baseUrl}/${tmdbToken()}/lt/tmdb/tv/1/broken`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_500' });
  });
});

describe('lt/mdblist', () => {
  it('renvoie les notes et le score (clé IMDb tt…)', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/mdblist/movie/tt0133093`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ratings: {
        imdb: 8.7,
        rottentomatoes: 88,
        rottentomatoes_audience: 85,
        metacritic: 73,
        letterboxd: 4.2,
        tmdb: 8.2,
        trakt: 86,
      },
      score: 84,
    });
  });

  it('id TMDB numérique pour une série (type tv → show), audience de repli, valeurs non numériques ignorées', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/mdblist/tv/1399`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ratings: Record<string, unknown>; score: unknown };
    expect(body.ratings.rottentomatoes).toBeNull();
    expect(body.ratings.rottentomatoes_audience).toBe(71);
    expect(body.score).toBeNull();
    expect(upstream.callsTo('https://api.mdblist.com/tmdb/show/1399').length).toBeGreaterThan(0);
  });

  it('clé transmise en paramètre apikey, jamais renvoyée', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/mdblist/movie/tt0133093`);
    expect(await res.text()).not.toContain(KEYS.mdblistApiKey);
  });

  it('type inconnu ou identifiant invalide : 404 not_found', async () => {
    const token = fullToken();
    expect((await fetch(`${app.baseUrl}/${token}/lt/mdblist/book/tt0133093`)).status).toBe(404);
    const res = await fetch(`${app.baseUrl}/${token}/lt/mdblist/movie/abc`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('lt/tvdb/series/:id', () => {
  it('se connecte, lit les saisons officielles hors saison 0 et les dates', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/tvdb/series/81189`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'Continuing',
      seasonCount: 2,
      seasons: [{ number: 1 }, { number: 2 }],
      nextAired: '2026-11-01',
      lastAired: '2026-10-01',
    });
    const login = upstream.callsTo('https://api4.thetvdb.com/v4/login').at(-1);
    expect(login?.method).toBe('POST');
    expect(JSON.parse(login?.body ?? '{}')).toEqual({ apikey: KEYS.tvdbApiKey });
  });

  it('réutilise le jeton de session (pas de nouvelle connexion)', async () => {
    const logins = upstream.callsTo('https://api4.thetvdb.com/v4/login').length;
    await fetch(`${app.baseUrl}/${fullToken()}/lt/tvdb/series/81189`);
    expect(upstream.callsTo('https://api4.thetvdb.com/v4/login').length).toBe(logins);
  });

  it('amont en panne : 503 tvdb_unavailable, sans détail ni clé', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/tvdb/series/999`);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'tvdb_unavailable' });
    expect(body).not.toContain(KEYS.tvdbApiKey);
  });

  it('identifiant invalide : 404 not_found', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/tvdb/series/abc`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('lt : route inconnue', () => {
  it('404 not_found en JSON', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/inconnue`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
