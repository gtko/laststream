import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeLookup, json, mockUpstream, type MockUpstream, postJson, type RunningApp, startApp, tokenFor, type UpstreamCall } from './lt-harness.js';

/** Clé factice : jamais renvoyée par les routes, jamais dans les journaux. */
const SKIPDB_KEY = 'skdb_test_0123456789abcdef';

const SKIPDB = 'https://api.skipdb.tv/api/segments';
const INTRODB = 'https://api.introdb.app/segments';
const ARM = 'https://arm.haglund.dev/api/v2/imdb';
const ANISKIP = 'https://api.aniskip.com/v2/skip-times';

/** Stargate Universe (live-action, sans donnée SkipDB : réponses réelles observées sans clé). */
const SGU = 'tt1286039';
/** Jujutsu Kaisen (anime, MAL 40748) : réponses SkipDB réelles observées avec durée de 1440 s. */
const JJK = 'tt12343534';
/** Série live avec segments IntroDB trustés et SkipDB qui concordent (même intro). */
const ACCORD = 'tt0000041';
/** Série live : SkipDB en panne (500) pendant que IntroDB répond. */
const SKIPDB_DOWN_PARTIAL = 'tt0000042';
/** Série live : SkipDB en panne et IntroDB sans donnée : 503. */
const SKIPDB_DOWN_ALONE = 'tt0000043';
/** Série d'animation (MAL 40750) : le générique SkipDB tombe avant 50 % de l'épisode. */
const ANIME_EARLY_CREDITS = 'tt0000044';
/** Film : SkipDB sans saison ni épisode. */
const MOVIE = 'tt0000045';
/** Série live pour la cible de soumission en échec côté SkipDB. */
const SUBMIT_FAILS = 'tt0000046';
/** Série live : exemple de la documentation SkipDB (Breaking Bad S01E01). */
const BREAKING_BAD = 'tt0903747';

/** Forme réelle SkipDB, sans donnée (Stargate Universe S01E03 et S01E05, sans clé). */
const emptySkipDb = (imdb: string | null, season: string | null, episode: string | null): unknown => ({
  imdb_id: imdb,
  season: season === null ? undefined : Number(season),
  episode: episode === null ? undefined : Number(episode),
  segments: { intro: null, recap: null, outro: null, preview: null },
  intro_length_estimate_ms: null,
});

/** Réponse réelle SkipDB pour Jujutsu Kaisen S1E1, avec duration=1440 (intro agnostique, générique décalé). */
const JJK_WITH_DURATION = {
  imdb_id: JJK,
  season: 1,
  episode: 1,
  segments: {
    intro: { start_ms: 56000, end_ms: 146000, adjusted: false, offset_ms: 0, match: 'agnostic', confidence: 0.75 },
    recap: null,
    outro: { start_ms: 1424700, end_ms: 1435000, adjusted: false, offset_ms: 5000, match: 'shifted', confidence: 0.82 },
    preview: null,
  },
  intro_length_estimate_ms: 90000,
};

/** Exemple de réponse SkipDB dans la documentation (intro, générique, aperçu hors repère). */
const BREAKING_BAD_SEGMENTS = {
  intro: { start_ms: 61000, end_ms: 91000, adjusted: false, offset_ms: 0, match: 'agnostic', confidence: 0.93 },
  recap: null,
  outro: { start_ms: 2760000, end_ms: 2820000, adjusted: false, offset_ms: 0, match: 'agnostic', confidence: 0.9 },
  preview: { start_ms: 2700000, end_ms: 2760000, adjusted: false, offset_ms: 0, match: 'out-of-range', confidence: 0.4 },
};

/** Réponse à POST /api/segments (forme réelle de la documentation). */
const SUBMIT_ACCEPTED = {
  id: 42,
  status: 'approved',
  auto_approved: true,
  reasons: ['matches an existing approved segment (consensus)'],
  message: 'Submission accepted and published.',
  license: 'ODbL 1.0 + Service Provider Reciprocity ...',
};

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    [SKIPDB]: (call) => {
      if (call.method === 'POST') {
        const body = JSON.parse(call.body) as { imdb_id: string };
        if (body.imdb_id === SUBMIT_FAILS) return json({ error: 'down' }, 500);
        return json(SUBMIT_ACCEPTED);
      }
      const id = call.url.searchParams.get('imdb_id');
      const season = call.url.searchParams.get('season');
      const episode = call.url.searchParams.get('episode');
      const duration = call.url.searchParams.get('duration');
      if (id === SKIPDB_DOWN_PARTIAL || id === SKIPDB_DOWN_ALONE) return json({ error: 'down' }, 500);
      if (id === JJK) return json(duration === '1440' ? JJK_WITH_DURATION : emptySkipDb(JJK, season, episode));
      if (id === BREAKING_BAD) {
        return json({ imdb_id: BREAKING_BAD, season: 1, episode: 1, segments: BREAKING_BAD_SEGMENTS, intro_length_estimate_ms: 30000 });
      }
      if (id === ACCORD) {
        return json({
          imdb_id: ACCORD,
          season: 1,
          episode: 1,
          segments: {
            intro: { start_ms: 61000, end_ms: 91000, adjusted: false, offset_ms: 0, match: 'exact', confidence: 0.93 },
            recap: null,
            outro: null,
            preview: null,
          },
          intro_length_estimate_ms: null,
        });
      }
      if (id === ANIME_EARLY_CREDITS) {
        return json({
          imdb_id: ANIME_EARLY_CREDITS,
          season: 1,
          episode: 1,
          segments: {
            intro: null,
            recap: null,
            outro: { start_ms: 200000, end_ms: 260000, adjusted: false, offset_ms: 0, match: 'agnostic', confidence: 0.6 },
            preview: null,
          },
          intro_length_estimate_ms: null,
        });
      }
      if (id === MOVIE) {
        return json({
          imdb_id: MOVIE,
          segments: {
            intro: { start_ms: 12000, end_ms: 70000, adjusted: false, offset_ms: 0, match: 'agnostic', confidence: 0.8 },
            recap: null,
            outro: null,
            preview: null,
          },
          intro_length_estimate_ms: null,
        });
      }
      return json(emptySkipDb(id, season, episode));
    },
    [INTRODB]: (call) => {
      const id = call.url.searchParams.get('imdb_id');
      if (id === ACCORD) {
        return json({
          imdb_id: ACCORD,
          intro: { start_sec: 61, end_sec: 91, confidence: 0.9, submission_count: 3 },
          recap: null,
          outro: null,
          post_credits: null,
        });
      }
      if (id === SKIPDB_DOWN_PARTIAL) {
        return json({
          imdb_id: SKIPDB_DOWN_PARTIAL,
          intro: { start_sec: 61, end_sec: 91, confidence: 0.9, submission_count: 3 },
          recap: null,
          outro: null,
          post_credits: null,
        });
      }
      return json({ error: 'not found' }, 404);
    },
    [ARM]: (call) => {
      const id = call.url.searchParams.get('id');
      if (id === JJK) return json([{ anilist: 113415, myanimelist: 40748, 'themoviedb-season': 1, imdb: JJK }]);
      if (id === ANIME_EARLY_CREDITS) return json([{ anilist: 113416, myanimelist: 40750, 'themoviedb-season': 1, imdb: ANIME_EARLY_CREDITS }]);
      return json({ error: 'not found' }, 404);
    },
    [`${ANISKIP}/40748/1`]: () =>
      json({
        found: true,
        results: [
          { interval: { startTime: 55, endTime: 145 }, skipType: 'op', skipId: 'j1', episodeLength: 1440 },
          { interval: { startTime: 1338, endTime: 1428 }, skipType: 'ed', skipId: 'j2', episodeLength: 1440 },
          { interval: { startTime: 224, endTime: 314 }, skipType: 'mixed-ed', skipId: 'j3', episodeLength: 1440 },
        ],
        statusCode: 200,
      }),
    [`${ANISKIP}/40750/1`]: () =>
      json({
        found: true,
        results: [
          { interval: { startTime: 60, endTime: 150 }, skipType: 'mixed-op', skipId: 'm1', episodeLength: 1440 },
          { interval: { startTime: 224, endTime: 314 }, skipType: 'mixed-ed', skipId: 'm2', episodeLength: 1440 },
          { interval: { startTime: 100, endTime: 160 }, skipType: 'recap', skipId: 'm3', episodeLength: 1440 },
        ],
        statusCode: 200,
      }),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const skip = (config: string, type: string, imdb: string, season: number, episode: number): Promise<Response> =>
  fetch(`${app.baseUrl}/${config}/lt/skip/${type}/${imdb}/${season}/${episode}`);
const post = (config: string, body: unknown): Promise<Response> => fetch(`${app.baseUrl}/${config}/lt/skip/submit`, postJson(body));
const callsTo = (prefix: string): UpstreamCall[] => upstream.callsTo(prefix);
const skipdbGets = (): UpstreamCall[] => callsTo(SKIPDB).filter((call) => call.method === 'GET');
const skipdbPosts = (): UpstreamCall[] => callsTo(SKIPDB).filter((call) => call.method === 'POST');

describe('SkipDB en lecture : réponses réelles sans donnée (Stargate Universe)', () => {
  it.each([3, 5])('S01E%s : segments vides, requête sans clé ni durée', async (episode) => {
    const before = skipdbGets().length;
    const res = await skip(tokenFor({}), 'series', SGU, 1, episode);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ segments: [] });
    expect(skipdbGets().length).toBe(before + 1);
    const call = skipdbGets().at(-1);
    expect(call?.url.searchParams.get('imdb_id')).toBe(SGU);
    expect(call?.url.searchParams.get('season')).toBe('1');
    expect(call?.url.searchParams.get('episode')).toBe(String(episode));
    expect(call?.url.searchParams.has('duration')).toBe(false);
    expect(call?.headers['x-api-key']).toBeUndefined();
  });
});

describe('SkipDB en lecture : série live et film', () => {
  it('sans durée : repères « agnostic » acceptés, aperçu hors repère écarté, sans duration envoyée', async () => {
    const res = await skip(tokenFor({}), 'series', BREAKING_BAD, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      segments: [
        { kind: 'intro', start: 61, end: 91, source: 'skipdb', confidence: 0.93 },
        { kind: 'credits', start: 2760, end: 2820, source: 'skipdb', confidence: 0.9 },
      ],
    });
    expect(skipdbGets().at(-1)?.url.searchParams.has('duration')).toBe(false);
  });

  it('cache partagé : même cible, aucun nouvel appel SkipDB', async () => {
    const before = skipdbGets().length;
    await skip(tokenFor({ skipdbApiKey: SKIPDB_KEY }), 'series', BREAKING_BAD, 1, 1);
    expect(skipdbGets().length).toBe(before);
  });

  it('accord avec IntroDB trusté : fusion (sources listées), confiance relevée à 1, IntroDB en tête', async () => {
    const res = await skip(tokenFor({}), 'series', ACCORD, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      segments: [{ kind: 'intro', start: 61, end: 91, source: 'introdb', sources: ['introdb', 'skipdb'], confidence: 1 }],
    });
  });

  it('film : requête SkipDB sans saison ni épisode', async () => {
    const res = await skip(tokenFor({}), 'movie', MOVIE, 0, 0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ segments: [{ kind: 'intro', start: 12, end: 70, source: 'skipdb', confidence: 0.8 }] });
    const call = skipdbGets().at(-1);
    expect(call?.url.searchParams.has('season')).toBe(false);
    expect(call?.url.searchParams.has('episode')).toBe(false);
  });

  it('panne SkipDB avec IntroDB qui répond : segments IntroDB seuls, réponse non mise en cache (SkipDB rappelé)', async () => {
    const first = await skip(tokenFor({}), 'series', SKIPDB_DOWN_PARTIAL, 1, 1);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ segments: [{ kind: 'intro', start: 61, end: 91, source: 'introdb', confidence: 0.9 }] });
    const before = skipdbGets().length;
    await skip(tokenFor({}), 'series', SKIPDB_DOWN_PARTIAL, 1, 1);
    expect(skipdbGets().length).toBe(before + 1);
  });

  it('panne SkipDB sans autre source : 503 skip_unavailable', async () => {
    const res = await skip(tokenFor({}), 'series', SKIPDB_DOWN_ALONE, 1, 1);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'skip_unavailable' });
  });
});

describe('SkipDB en lecture : série d\'animation', () => {
  it('Jujutsu Kaisen S1E1 (réponse réelle, durée AniSkip 1440 s) : AniSkip prioritaire, SkipDB concorde sur l\'intro, son générique chevauche celui d\'AniSkip et est écarté', async () => {
    const res = await skip(tokenFor({}), 'series', JJK, 1, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { episodeLength: number; segments: { confidence?: number }[] };
    expect(body.episodeLength).toBe(1440);
    expect(body.segments).toEqual([
      { kind: 'intro', start: 55, end: 145, source: 'aniskip', sources: ['aniskip', 'skipdb'], confidence: expect.any(Number) },
      { kind: 'credits', start: 1338, end: 1428, source: 'aniskip' },
    ]);
    expect(body.segments[0]?.confidence).toBeCloseTo(0.95);
    const call = skipdbGets().at(-1);
    expect(call?.url.searchParams.get('duration')).toBe('1440');
    expect(call?.url.searchParams.get('season')).toBe('1');
  });

  it('générique SkipDB commençant avant 50 % de l\'épisode : écarté (garde-fou de position)', async () => {
    const res = await skip(tokenFor({}), 'series', ANIME_EARLY_CREDITS, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      episodeLength: 1440,
      segments: [{ kind: 'intro', start: 60, end: 150, source: 'aniskip' }],
    });
  });
});

describe('SkipDB en écriture : envoi best-effort des propositions locales', () => {
  const submission = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    type: 'series',
    imdbId: 'tt7300001',
    season: 2,
    episode: 4,
    kind: 'intro',
    start: 10,
    end: 90,
    duration: 2400,
    ...overrides,
  });

  it('avec clé : intro envoyée en « intro » (ms, durée en ms), en-tête X-API-Key, réponse sans la clé', async () => {
    const before = skipdbPosts().length;
    const res = await post(tokenFor({ skipdbApiKey: SKIPDB_KEY }), submission({}));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toBe('{"applied":1}');
    expect(text).not.toContain(SKIPDB_KEY);
    await vi.waitFor(() => expect(skipdbPosts().length).toBe(before + 1));
    const call = skipdbPosts().at(-1);
    expect(call?.headers['x-api-key']).toBe(SKIPDB_KEY);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      imdb_id: 'tt7300001',
      segment_type: 'intro',
      season: 2,
      episode: 4,
      start_ms: 10000,
      end_ms: 90000,
      duration_ms: 2400000,
    });
  });

  it('générique proposé : envoyé en « outro » ; film : sans saison ni épisode', async () => {
    const before = skipdbPosts().length;
    await post(tokenFor({ skipdbApiKey: SKIPDB_KEY }), submission({ kind: 'credits', start: 2280, end: 2390 }));
    await post(tokenFor({ skipdbApiKey: SKIPDB_KEY }), submission({ type: 'movie', imdbId: 'tt7300002', season: 0, episode: 0, kind: 'recap', start: 5, end: 60 }));
    await vi.waitFor(() => expect(skipdbPosts().length).toBe(before + 2));
    const bodies = skipdbPosts().map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(bodies).toContainEqual(expect.objectContaining({ segment_type: 'outro', start_ms: 2280000, end_ms: 2390000 }));
    const movieBody = bodies.find((body) => body.imdb_id === 'tt7300002') ?? {};
    expect(movieBody).toMatchObject({ segment_type: 'recap' });
    expect('season' in movieBody).toBe(false);
    expect('episode' in movieBody).toBe(false);
  });

  it('post-générique et vote négatif : jamais envoyés à SkipDB', async () => {
    const before = skipdbPosts().length;
    const config = tokenFor({ skipdbApiKey: SKIPDB_KEY });
    expect((await post(config, submission({ kind: 'postcredits', start: 2300, end: 2390 }))).status).toBe(200);
    expect((await post(config, submission({ start: 10, end: 90, negative: true }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(skipdbPosts().length).toBe(before);
  });

  it('sans clé : aucun envoi à SkipDB', async () => {
    const before = skipdbPosts().length;
    expect((await post(tokenFor({}), submission({ imdbId: 'tt7300003' }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(skipdbPosts().length).toBe(before);
  });

  it('échec amont SkipDB : la proposition locale reste enregistrée (200)', async () => {
    const before = skipdbPosts().length;
    const res = await post(tokenFor({ skipdbApiKey: SKIPDB_KEY }), submission({ imdbId: SUBMIT_FAILS }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"applied":1}');
    await vi.waitFor(() => expect(skipdbPosts().length).toBe(before + 1));
  });
});
