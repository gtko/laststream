import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fakeLookup,
  json,
  KEYS,
  mockUpstream,
  postJson,
  type MockUpstream,
  type RunningApp,
  startApp,
  tokenFor,
  type UpstreamCall,
} from './lt-harness.js';

const INTRODB = 'https://api.introdb.app/segments';
const SUBMIT = 'https://api.introdb.app/submit';
const TMDB = 'https://api.themoviedb.org/3';
const ARM = 'https://arm.haglund.dev/api/v2/imdb';

const INTRODB_KEY = 'idb_test_key_0123456789';
const TMDB_CONFIG = tokenFor({ tmdbToken: KEYS.tmdbToken });

/** Séries mockées : intros et génériques (outro) par numéro d'épisode, durée de 40 min (2400 s). */
interface MockShow {
  tv: number;
  episodes: number;
  intros: Record<number, [number, number]>;
  outros: Record<number, [number, number]>;
}
const SHOWS: Record<string, MockShow> = {
  // Saison 1 : épisodes 2 à 4 concordent (intro ~20-105 s, générique à 120 s de la fin).
  'tt7000001': {
    tv: 7001,
    episodes: 8,
    intros: { 2: [20, 105], 3: [21, 105], 4: [22, 108] },
    outros: { 2: [2280, 2390], 3: [2282, 2392], 4: [2279, 2389] },
  },
  // Un seul voisin avec intro : rien à déduire.
  'tt7000002': { tv: 7002, episodes: 3, intros: { 2: [20, 105] }, outros: {} },
  // Deux voisins qui ne concordent pas : rien à déduire.
  'tt7000003': { tv: 7003, episodes: 3, intros: { 2: [20, 105], 3: [60, 140] }, outros: {} },
};
/** Film mocké : aucun segment IntroDB (le test ne vérifie que la communauté). */
const MOVIE = 'tt7100009';
/** Proposition envoyée à IntroDB qui échoue côté amont (la proposition locale doit tout de même réussir). */
const FAILING_FORWARD = 'tt7100008';

let upstream: MockUpstream;

beforeAll(() => {
  const handlers: Parameters<typeof mockUpstream>[0] = {
    [INTRODB]: (call) => {
      const imdb = call.url.searchParams.get('imdb_id') ?? '';
      const show = SHOWS[imdb];
      const episode = Number(call.url.searchParams.get('episode'));
      const seg = (range: [number, number] | undefined) =>
        range === undefined ? null : { start_sec: range[0], end_sec: range[1], confidence: 1, submission_count: 1 };
      if (show === undefined || call.url.searchParams.get('season') !== '1') {
        return json({ intro: null, recap: null, outro: null, post_credits: null });
      }
      return json({ intro: seg(show.intros[episode]), recap: null, outro: seg(show.outros[episode]), post_credits: null });
    },
    [SUBMIT]: (call) => {
      const body = JSON.parse(call.body) as { imdb_id?: string };
      if (body.imdb_id === FAILING_FORWARD) return json({ error: 'down' }, 500);
      return json({ ok: true, submission: { id: 'mock' } });
    },
    [ARM]: () => json({ error: 'not found' }, 404),
  };
  for (const [imdb, show] of Object.entries(SHOWS)) {
    handlers[`${TMDB}/find/${imdb}`] = () => json({ tv_results: [{ id: show.tv }], movie_results: [] });
    handlers[`${TMDB}/tv/${show.tv}`] = () =>
      json({
        id: show.tv,
        number_of_seasons: 1,
        seasons: [{ season_number: 1, name: 'Saison 1', episode_count: show.episodes, air_date: null, poster_path: null }],
        external_ids: { tvdb_id: null },
        episode_groups: { results: [] },
      });
    handlers[`${TMDB}/tv/${show.tv}/season/1`] = () =>
      json({
        season_number: 1,
        episodes: Array.from({ length: show.episodes }, (_, index) => ({
          season_number: 1,
          episode_number: index + 1,
          name: `Épisode ${index + 1}`,
          overview: null,
          air_date: null,
          runtime: 40,
          still_path: null,
        })),
      });
  }
  upstream = mockUpstream(handlers);
});

/** Un test = une application (limites de débit et caches isolés). */
async function freshApp(): Promise<RunningApp> {
  return startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
}

const skipGet = (app: RunningApp, config: string, type: string, imdb: string, season: number, episode: number): Promise<Response> =>
  fetch(`${app.baseUrl}/${config}/lt/skip/${type}/${imdb}/${season}/${episode}`);

const submitBody = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  type: 'series',
  imdbId: 'tt7100001',
  season: 1,
  episode: 1,
  kind: 'intro',
  start: 10,
  end: 90,
  duration: 2400,
  ...overrides,
});

const post = (app: RunningApp, config: string, body: unknown): Promise<Response> =>
  fetch(`${app.baseUrl}/${config}/lt/skip/submit`, postJson(body));

const introDbCalls = (): UpstreamCall[] => upstream.callsTo(INTRODB);
const submitCalls = (): UpstreamCall[] => upstream.callsTo(SUBMIT);

describe('POST /skip/submit : validation (400 invalid_submission)', () => {
  let app: RunningApp;
  beforeAll(async () => {
    app = await freshApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const invalidCases: [string, Record<string, unknown>][] = [
    ['début après la fin', { start: 50, end: 40 }],
    ['fin au-delà de la durée', { end: 2500, duration: 2400 }],
    ['intro de plus de 300 s', { start: 0, end: 301 }],
    ['générique de plus de 600 s', { kind: 'credits', start: 1000, end: 1601 }],
    ['type de segment inconnu', { kind: 'preview' }],
    ['type de cible inconnu', { type: 'show' }],
    ['film avec une saison', { type: 'movie', season: 1, episode: 0, imdbId: MOVIE }],
    ['série à la saison 0', { season: 0 }],
    ['vote négatif non booléen', { negative: 'oui' }],
    ['début négatif', { start: -1 }],
    ['durée nulle', { duration: 0, end: 10 }],
    ['épisode non entier', { episode: 1.5 }],
  ];
  it.each(invalidCases)('%s : refusé', async (_label, overrides) => {
    const res = await post(app, TMDB_CONFIG, submitBody(overrides));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_submission' });
  });

  it('proposition valide : 200 et une voix enregistrée', async () => {
    const res = await post(app, TMDB_CONFIG, submitBody({ imdbId: 'tt7100050' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 1 });
  });
});

describe('communauté : agrégation, votes négatifs et masquage', () => {
  let app: RunningApp;
  const config = tokenFor({});
  const imdbId = 'tt7100001';
  const get = (): Promise<Response> => skipGet(app, config, 'series', imdbId, 1, 1);

  beforeAll(async () => {
    app = await freshApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('sans source ni proposition : segments vides', async () => {
    expect(await (await get()).json()).toEqual({ segments: [] });
  });

  it('trois propositions : médiane des bornes, confiance lissée, source communautaire', async () => {
    for (const [start, end] of [
      [10, 90],
      [12, 92],
      [30, 100],
    ] as const) {
      expect((await post(app, config, submitBody({ imdbId, start, end }))).status).toBe(200);
    }
    expect(await (await get()).json()).toEqual({
      segments: [{ kind: 'intro', start: 12, end: 92, source: 'community', confidence: 0.8 }],
    });
  });

  it('vote négatif sur la plage 30-100 : les trois propositions la chevauchent, confiance baisse', async () => {
    const res = await post(app, config, submitBody({ imdbId, start: 30, end: 100, negative: true }));
    expect(await res.json()).toEqual({ applied: 3 });
    expect(await (await get()).json()).toEqual({
      segments: [{ kind: 'intro', start: 12, end: 92, source: 'community', confidence: 0.5 }],
    });
  });

  it('second vote négatif : votes contre > votes pour, segments masqués', async () => {
    expect(await (await post(app, config, submitBody({ imdbId, start: 30, end: 100, negative: true }))).json()).toEqual({
      applied: 3,
    });
    expect(await (await get()).json()).toEqual({ segments: [] });
  });

  it('vote négatif sans proposition qui chevauche : rien n’est modifié', async () => {
    const res = await post(app, config, submitBody({ imdbId, episode: 4, start: 300, end: 350, negative: true }));
    expect(await res.json()).toEqual({ applied: 0 });
  });

  it('film : proposition enregistrée et restituée sur la cible film (saison et épisode à 0)', async () => {
    const res = await post(app, config, {
      type: 'movie',
      imdbId: MOVIE,
      season: 0,
      episode: 0,
      kind: 'intro',
      start: 12,
      end: 70,
      duration: 7200,
    });
    expect(res.status).toBe(200);
    const body = await (await skipGet(app, config, 'movie', MOVIE, 0, 0)).json();
    expect(body).toEqual({ segments: [{ kind: 'intro', start: 12, end: 70, source: 'community', confidence: 2 / 3 }] });
  });

  it('source externe prioritaire : une proposition locale ne remplace pas IntroDB', async () => {
    await post(app, config, submitBody({ imdbId: 'tt7000001', episode: 2, start: 0, end: 10 }));
    const body = await (await skipGet(app, config, 'series', 'tt7000001', 1, 2)).json();
    expect(body).toEqual({
      segments: [
        { kind: 'intro', start: 20, end: 105, source: 'introdb', confidence: 1 },
        { kind: 'credits', start: 2280, end: 2390, source: 'introdb', confidence: 1 },
      ],
    });
  });
});

describe('communauté : envoi à IntroDB (best-effort, sans clé dans les réponses)', () => {
  let app: RunningApp;
  const config = tokenFor({ introdbApiKey: INTRODB_KEY });

  beforeAll(async () => {
    app = await freshApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('générique proposé : envoyé en « outro » avec X-API-Key, réponse sans la clé', async () => {
    const before = submitCalls().length;
    const res = await post(app, config, submitBody({ imdbId: 'tt7100002', kind: 'credits', start: 2280, end: 2390 }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toBe('{"applied":1}');
    expect(text).not.toContain(INTRODB_KEY);
    await vi.waitFor(() => expect(submitCalls().length).toBe(before + 1));
    const call = submitCalls().at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-api-key']).toBe(INTRODB_KEY);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      segment_type: 'outro',
      imdb_id: 'tt7100002',
      season: 1,
      episode: 1,
      start_sec: 2280,
      end_sec: 2390,
    });
  });

  it('film proposé : is_movie à true, sans saison ni épisode', async () => {
    const before = submitCalls().length;
    await post(app, config, { type: 'movie', imdbId: MOVIE, season: 0, episode: 0, kind: 'postcredits', start: 7000, end: 7150, duration: 7200 });
    await vi.waitFor(() => expect(submitCalls().length).toBe(before + 1));
    expect(JSON.parse(submitCalls().at(-1)?.body ?? '{}')).toEqual({
      segment_type: 'post-credits',
      imdb_id: MOVIE,
      is_movie: true,
      start_sec: 7000,
      end_sec: 7150,
    });
  });

  it('échec amont : la proposition locale reste enregistrée (200)', async () => {
    const res = await post(app, config, submitBody({ imdbId: FAILING_FORWARD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 1 });
    expect((await skipGet(app, tokenFor({}), 'series', FAILING_FORWARD, 1, 1).then((r) => r.json())) as unknown).toEqual({
      segments: [{ kind: 'intro', start: 10, end: 90, source: 'community', confidence: 2 / 3 }],
    });
  });
});

describe('déduction de saison (sans clé IntroDB)', () => {
  let app: RunningApp;
  const config = TMDB_CONFIG;

  beforeAll(async () => {
    app = await freshApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('épisode 1 sans source : intro et générique déduits des épisodes 2 à 4 (médianes, confiance 0,5)', async () => {
    const mark = introDbCalls().length;
    const res = await skipGet(app, config, 'series', 'tt7000001', 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      segments: [
        { kind: 'intro', start: 21, end: 105, source: 'inferred', inferred: true, confidence: 0.5 },
        { kind: 'credits', start: 2280, end: 2390, source: 'inferred', inferred: true, confidence: 0.5 },
      ],
    });
    // Au plus 6 recherches de voisins, les plus proches de la cible (ep. 2 à 7 pour la cible 1).
    const siblings = introDbCalls()
      .slice(mark)
      .filter((c) => c.url.searchParams.get('imdb_id') === 'tt7000001' && c.url.searchParams.get('episode') !== '1')
      .map((c) => Number(c.url.searchParams.get('episode')))
      .sort((a, b) => a - b);
    expect(siblings).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('résultat déduit en cache : pas de nouvel appel amont', async () => {
    const before = introDbCalls().length;
    await (await skipGet(app, config, 'series', 'tt7000001', 1, 1)).text();
    expect(introDbCalls().length).toBe(before);
  });

  it('un seul voisin concordant : rien à déduire', async () => {
    const body = await (await skipGet(app, config, 'series', 'tt7000002', 1, 1)).json();
    expect(body).toEqual({ segments: [] });
  });

  it('voisins en désaccord : rien à déduire', async () => {
    const body = await (await skipGet(app, config, 'series', 'tt7000003', 1, 1)).json();
    expect(body).toEqual({ segments: [] });
  });

  it('sans jeton TMDB : pas de déduction, pas d’appel TMDB', async () => {
    const tmdbBefore = upstream.callsTo(`${TMDB}/find/tt7000001`).length;
    const body = await (await skipGet(app, tokenFor({}), 'series', 'tt7000001', 1, 1)).json();
    expect(body).toEqual({ segments: [] });
    expect(upstream.callsTo(`${TMDB}/find/tt7000001`).length).toBe(tmdbBefore);
  });

  it('nouvelle proposition pour la saison : déduction recalculée (cache invalidé)', async () => {
    const before = await (await skipGet(app, config, 'series', 'tt7000001', 1, 1)).json();
    expect(before).toEqual({
      segments: [
        { kind: 'intro', start: 21, end: 105, source: 'inferred', inferred: true, confidence: 0.5 },
        { kind: 'credits', start: 2280, end: 2390, source: 'inferred', inferred: true, confidence: 0.5 },
      ],
    });
    // Épisode 5 (sans source) : sa proposition d'intro (20,5 s) entre dans le consensus et déplace la médiane.
    const res = await post(app, config, submitBody({ imdbId: 'tt7000001', episode: 5, start: 20.5, end: 105 }));
    expect(res.status).toBe(200);
    const after = await (await skipGet(app, config, 'series', 'tt7000001', 1, 1)).json();
    expect(after).toEqual({
      segments: [
        { kind: 'intro', start: 20.75, end: 105, source: 'inferred', inferred: true, confidence: 0.5 },
        { kind: 'credits', start: 2280, end: 2390, source: 'inferred', inferred: true, confidence: 0.5 },
      ],
    });
  });
});

describe('limite de débit des POST lt', () => {
  it('31e POST en une minute : 429 rate_limited', async () => {
    const app = await freshApp();
    try {
      const config = tokenFor({});
      for (let i = 0; i < 30; i += 1) {
        expect((await post(app, config, {})).status).toBe(400);
      }
      const res = await post(app, config, {});
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
    } finally {
      await app.close();
    }
  });
});
