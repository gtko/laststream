import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LtError, TTL, TtlCache } from '../src/lt/context.js';
import { parseSkipTarget } from '../src/lt/skip.js';
import { fakeLookup, json, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor, type UpstreamCall } from './lt-harness.js';

/** Clés factices : IntroDB et Anime Skip (jamais renvoyées par les routes). */
const INTRODB_KEY = 'idb_test_key_0123456789';
const ANIMESKIP_CLIENT = 'animeskip-client-0123456789';

const INTRODB = 'https://api.introdb.app/segments';
const SKIPDB = 'https://api.skipdb.tv/api/segments';
const ARM = 'https://arm.haglund.dev/api/v2/imdb';
const ANISKIP = 'https://api.aniskip.com/v2/skip-times';
const ANIMESKIP = 'https://api.anime-skip.com/graphql';

/** Fixtures : Game of Thrones S1E1 (live-action), Frieren S1E1 et S2E1 (anime), un film. */
const GOT = 'tt0944947';
const FRIEREN = 'tt22248376';
const MOVIE = 'tt0000002';
const UNKNOWN = 'tt0000001';
const BROKEN = 'tt0000003';
/** Jujutsu Kaisen S1E1 (MAL 40748) : AniSkip et IntroDB concordent sur l'intro, un générique « mixed » parasite. */
const JJK = 'tt12343534';
/** Fixture de repli : génériques mêlés seuls (MAL 40750), un recap qui chevauche l'intro. */
const MIXED = 'tt0000011';

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    [INTRODB]: (call) => {
      const id = call.url.searchParams.get('imdb_id');
      const season = call.url.searchParams.get('season');
      const episode = call.url.searchParams.get('episode');
      if (id === UNKNOWN) return json({ error: 'not found' }, 404);
      if (id === BROKEN) return json({ error: 'down' }, 500);
      if (id === JJK && season === '1' && episode === '1') {
        return json({
          imdb_id: JJK,
          intro: { start_sec: 55, end_sec: 145, confidence: 0.8, submission_count: 5 },
          recap: null,
          outro: { start_sec: 1350, end_sec: 1436, confidence: 0.8, submission_count: 2 },
          post_credits: null,
        });
      }
      if (id === MIXED || (id === FRIEREN && season === '1')) {
        return json({ intro: null, recap: null, outro: null, post_credits: null });
      }
      if (id === MOVIE && call.url.searchParams.get('is_movie') === 'true') {
        return json({ imdb_id: MOVIE, is_movie: true, intro: { start_sec: 12, end_sec: 70, confidence: 0.9, submission_count: 3 }, post_credits: null });
      }
      if (id === GOT) {
        return json({
          imdb_id: GOT,
          season: 1,
          episode: 1,
          intro: { start_ms: 437000, end_ms: 531000, start_sec: 437, end_sec: 531, confidence: 1, submission_count: 2 },
          recap: null,
          outro: { start_ms: 3631500, end_ms: 3699500, start_sec: 3631.5, end_sec: 3699.5, confidence: 1, submission_count: 2 },
          post_credits: null,
        });
      }
      if (id === FRIEREN && call.url.searchParams.get('season') === '2') {
        return json({ intro: { start_sec: 117, end_sec: 207, confidence: 1, submission_count: 1 }, recap: null, outro: null, post_credits: null });
      }
      return json({ error: 'unexpected' }, 599);
    },
    // SkipDB sans donnée pour ces cibles (forme réelle observée : Stargate Universe S01E03, tt1286039).
    [SKIPDB]: (call) =>
      json({
        imdb_id: call.url.searchParams.get('imdb_id'),
        segments: { intro: null, recap: null, outro: null, preview: null },
        intro_length_estimate_ms: null,
      }),
    [ARM]: (call) => {
      const id = call.url.searchParams.get('id');
      if (id === FRIEREN) {
        return json([
          { anilist: 154587, myanimelist: 52991, 'themoviedb-season': 1, imdb: FRIEREN },
          { anilist: 182255, myanimelist: 59978, 'themoviedb-season': 2, imdb: FRIEREN },
        ]);
      }
      if (id === 'tt0000009') return json([{ anilist: 1, 'themoviedb-season': 1 }]);
      if (id === JJK) return json([{ anilist: 113415, myanimelist: 40748, 'themoviedb-season': 1, imdb: JJK }]);
      if (id === MIXED) return json([{ anilist: 113416, myanimelist: 40750, 'themoviedb-season': 1, imdb: MIXED }]);
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
    [`${ANISKIP}/52991/1`]: () =>
      json({
        found: true,
        results: [
          { interval: { startTime: 3.221, endTime: 93.221 }, skipType: 'op', skipId: 'a', episodeLength: 1420 },
          { interval: { startTime: 1417.135, endTime: 1507.135 }, skipType: 'ed', skipId: 'b', episodeLength: 1420 },
        ],
        message: 'Successfully retrieved skip times',
        statusCode: 200,
      }),
    [`${ANISKIP}/59978/1`]: () => json({ found: false, results: [], statusCode: 404 }, 404),
    [ANIMESKIP]: (call) => {
      const body = JSON.parse(call.body) as { query: string };
      if (call.headers['x-client-id'] !== ANIMESKIP_CLIENT) return json({ errors: [{ message: 'client' }] }, 401);
      if (body.query.includes('findShowsByExternalId')) return json({ data: { findShowsByExternalId: [{ id: 'show-frieren' }] } });
      if (body.query.includes('findEpisodesByShowId')) {
        return json({
          data: {
            findEpisodesByShowId: [
              { id: 'ep-1', season: '1', number: '1' },
              { id: 'ep-2', season: '1', number: '2' },
            ],
          },
        });
      }
      if (body.query.includes('findTimestampsByEpisodeId')) {
        return json({
          data: {
            findTimestampsByEpisodeId: [
              { at: 1550, type: { name: 'Preview' } },
              { at: 0, type: { name: 'New Intro' } },
              { at: 90, type: { name: 'Canon' } },
              { at: 1460, type: { name: 'New Credits' } },
              { at: 1131.9, type: { name: 'Title Card' } },
            ],
          },
        });
      }
      return json({ errors: [{ message: 'unknown query' }] }, 400);
    },
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const skip = (config: string, type: string, imdb: string, season: number, episode: number): Promise<Response> =>
  fetch(`${app.baseUrl}/${config}/lt/skip/${type}/${imdb}/${season}/${episode}`);
const callsTo = (prefix: string): UpstreamCall[] => upstream.callsTo(prefix);

describe('parseSkipTarget : validation de la cible', () => {
  it('film : saison et épisode à 0 uniquement ; série : à partir de 1', () => {
    expect(parseSkipTarget('movie', MOVIE, '0', '0')).toEqual({ type: 'movie', imdbId: MOVIE, season: 0, episode: 0 });
    expect(parseSkipTarget('series', GOT, '1', '1')).toEqual({ type: 'series', imdbId: GOT, season: 1, episode: 1 });
    expect(() => parseSkipTarget('movie', MOVIE, '1', '0')).toThrow(LtError);
    expect(() => parseSkipTarget('series', GOT, '0', '1')).toThrow(LtError);
    expect(() => parseSkipTarget('show', GOT, '1', '1')).toThrow(LtError);
    expect(() => parseSkipTarget('series', 'abc', '1', '1')).toThrow(LtError);
    expect(() => parseSkipTarget('series', GOT, 'x', '1')).toThrow(LtError);
  });

  it('route : cible invalide 404 not_found', async () => {
    const res = await skip(tokenFor({}), 'series', 'tt0944947', 0, 1);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('lt/skip : série live-action (IntroDB)', () => {
  it('segments IntroDB mappés (outro → credits), forme {segments}, sans clé ni appel anime', async () => {
    const aniBefore = callsTo(`${ANISKIP}/52991/1`).length + callsTo(ANIMESKIP).length;
    const res = await skip(tokenFor({}), 'series', GOT, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      segments: [
        { kind: 'intro', start: 437, end: 531, source: 'introdb', confidence: 1 },
        { kind: 'credits', start: 3631.5, end: 3699.5, source: 'introdb', confidence: 1 },
      ],
    });
    expect(callsTo(`${ANISKIP}/52991/1`).length + callsTo(ANIMESKIP).length).toBe(aniBefore);
  });

  it('clé IntroDB configurée : envoyée en X-API-Key ; absente sinon', async () => {
    // Épisodes distincts pour échapper au cache partagé.
    await skip(tokenFor({ introdbApiKey: INTRODB_KEY }), 'series', GOT, 1, 2);
    expect(callsTo(INTRODB).at(-1)?.headers['x-api-key']).toBe(INTRODB_KEY);
    await skip(tokenFor({}), 'series', GOT, 1, 3);
    expect(callsTo(INTRODB).at(-1)?.headers['x-api-key']).toBeUndefined();
  });

  it('segments de cache partagé : même réponse sans nouvel appel amont', async () => {
    const before = callsTo(INTRODB).length;
    await skip(tokenFor({}), 'series', GOT, 1, 1);
    expect(callsTo(INTRODB).length).toBe(before);
  });
});

describe('lt/skip : film', () => {
  it('is_movie=true, sans saison ni épisode, sans appel ARM', async () => {
    const armBefore = callsTo(ARM).length;
    const res = await skip(tokenFor({}), 'movie', MOVIE, 0, 0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ segments: [{ kind: 'intro', start: 12, end: 70, source: 'introdb', confidence: 0.9 }] });
    const call = callsTo(INTRODB).at(-1);
    expect(call?.url.searchParams.get('is_movie')).toBe('true');
    expect(call?.url.searchParams.has('season')).toBe(false);
    expect(callsTo(ARM).length).toBe(armBefore);
  });
});

describe('lt/skip : anime (AniSkip, puis Anime Skip)', () => {
  it('AniSkip : op → intro, ed → credits, durée de l\'épisode ; IntroDB interrogé mais sans segment, rien ne change', async () => {
    const introBefore = callsTo(INTRODB).length;
    const res = await skip(tokenFor({}), 'series', FRIEREN, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      episodeLength: 1420,
      segments: [
        { kind: 'intro', start: 3.221, end: 93.221, source: 'aniskip' },
        { kind: 'credits', start: 1417.135, end: 1507.135, source: 'aniskip' },
      ],
    });
    expect(callsTo(INTRODB).length).toBe(introBefore + 1);
  });

  it('Anime Skip configuré : X-Client-ID envoyé ; repères Anime Skip perdus face à AniSkip (priorité)', async () => {
    const res = await skip(tokenFor({ animeskipClientId: ANIMESKIP_CLIENT }), 'series', FRIEREN, 1, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { segments: { source: string }[] };
    expect(body.segments.map((s) => s.source)).toEqual(['aniskip', 'aniskip']);
    expect(callsTo(ANIMESKIP).every((call) => call.headers['x-client-id'] === ANIMESKIP_CLIENT)).toBe(true);
    expect(callsTo(ANIMESKIP).length).toBeGreaterThanOrEqual(3);
  });

  it('saison 2 : AniSkip sans résultat, IntroDB en repli avec la saison demandée', async () => {
    const res = await skip(tokenFor({}), 'series', FRIEREN, 2, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ segments: [{ kind: 'intro', start: 117, end: 207, source: 'introdb', confidence: 1 }] });
    const call = callsTo(INTRODB).at(-1);
    expect(call?.url.searchParams.get('season')).toBe('2');
  });

  it('entrée ARM sans identifiant MAL : Anime Skip seul (repères → segments, fin = repère suivant)', async () => {
    const res = await skip(tokenFor({ animeskipClientId: ANIMESKIP_CLIENT }), 'series', 'tt0000009', 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      segments: [
        { kind: 'intro', start: 0, end: 90, source: 'animeskip' },
        { kind: 'credits', start: 1460, end: 1550, source: 'animeskip' },
      ],
    });
  });
});

describe('lt/skip : fiabilité des segments (fusion, garde-fous de position, pas de chevauchement)', () => {
  it('fixture Jujutsu Kaisen S1E1 : intro AniSkip et IntroDB fusionnées, générique IntroDB (≥ 2 soumissions) préféré, mixed-ed écarté', async () => {
    const res = await skip(tokenFor({}), 'series', JJK, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      episodeLength: 1440,
      segments: [
        { kind: 'intro', start: 55, end: 145, source: 'introdb', sources: ['introdb', 'aniskip'], confidence: 1 },
        { kind: 'credits', start: 1350, end: 1436, source: 'introdb', confidence: 0.8 },
      ],
    });
  });

  it('mixed-op seul devient intro ; mixed-ed sous 50 % écarté ; recap chevauchant écarté', async () => {
    const res = await skip(tokenFor({}), 'series', MIXED, 1, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      episodeLength: 1440,
      segments: [{ kind: 'intro', start: 60, end: 150, source: 'aniskip' }],
    });
  });
});

describe('lt/skip : cache et pannes', () => {
  it('résultat vide mis en cache : pas de second appel amont', async () => {
    const before = callsTo(INTRODB).length;
    expect((await skip(tokenFor({}), 'series', UNKNOWN, 1, 1)).status).toBe(200);
    expect(await (await skip(tokenFor({}), 'series', UNKNOWN, 1, 1)).json()).toEqual({ segments: [] });
    expect(callsTo(INTRODB).length).toBe(before + 1);
  });

  it('panne amont : 503 skip_unavailable, non mise en cache (second appel relancé)', async () => {
    const before = callsTo(INTRODB).length;
    const first = await skip(tokenFor({}), 'series', BROKEN, 1, 1);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'skip_unavailable' });
    const second = await skip(tokenFor({}), 'series', BROKEN, 1, 1);
    expect(second.status).toBe(503);
    expect(callsTo(INTRODB).length).toBe(before + 2);
  });

  it('TTL : 7 jours pour un résultat trouvé, 6 h pour un résultat vide', () => {
    expect(TTL.skip).toBe(7 * 24 * 3600e3);
    expect(TTL.skipEmpty).toBe(6 * 3600e3);
  });

  it('cache : durée calculée à partir de la valeur chargée', async () => {
    const cache = new TtlCache();
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      return 0;
    };
    await cache.get('k', (value: number) => (value > 0 ? 60_000 : 0), load);
    await cache.get('k', (value: number) => (value > 0 ? 60_000 : 0), load);
    expect(loads).toBe(2);
  });

  it('clés de service absentes de la réponse', async () => {
    const raw = await (await skip(tokenFor({ introdbApiKey: INTRODB_KEY, animeskipClientId: ANIMESKIP_CLIENT }), 'series', GOT, 1, 1)).text();
    expect(raw).not.toContain(INTRODB_KEY);
    expect(raw).not.toContain(ANIMESKIP_CLIENT);
  });
});
