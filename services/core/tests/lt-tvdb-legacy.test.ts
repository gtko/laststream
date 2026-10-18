import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fakeLookup,
  type Handler,
  json,
  mockUpstream,
  type MockUpstream,
  postJson,
  type RunningApp,
  startApp,
  tokenFor,
  type UpstreamCall,
} from './lt-harness.js';

/** Clés factices : legacy (32 hexadécimaux), v4 personnelle, PIN, et deux clés qui échouent (refusée, panne). */
const LEGACY = '0123456789abcdef0123456789abcdef';
const LEGACY_EXPIRY = 'fedcba9876543210fedcba9876543210';
const V4_KEY = 'v4-personal-key-0001';
const PIN = '4321';
const REJECTED = 'ffffffffffffffffffffffffffffffff';
const FLAKY = '11111111111111111111111111111111';

const V4_BASE = 'https://api4.thetvdb.com/v4';
const V4_LOGIN = `${V4_BASE}/login`;
const V3_BASE = 'https://api.thetvdb.com';
const V3_LOGIN = `${V3_BASE}/login`;

/** Épisodes simulés sur deux pages (dates passées et futures fixes, indépendantes de l'horloge). */
const EPISODES_PAGE_1 = [
  { airedSeason: 1, airedEpisodeNumber: 1, firstAired: '2011-04-17', episodeName: 'Pilote' },
  { airedSeason: 2, airedEpisodeNumber: 1, firstAired: '2012-04-01', episodeName: 'Suite' },
  { airedSeason: 0, airedEpisodeNumber: 1, firstAired: '2099-01-01', episodeName: 'Spécial futur' },
];
const EPISODES_PAGE_2 = [
  { airedSeason: 2, airedEpisodeNumber: 10, firstAired: '2012-06-03', episodeName: 'Fin' },
  { airedSeason: 3, airedEpisodeNumber: 2, firstAired: '2099-03-08', episodeName: 'Plus tard' },
  { airedSeason: 3, airedEpisodeNumber: 1, firstAired: '2099-03-01', episodeName: 'Prochain' },
  { airedSeason: 4, airedEpisodeNumber: 1, firstAired: '', episodeName: 'Sans date' },
];

/** Forme attendue pour une clé legacy : saisons hors saison 0, prochain (futur le plus proche) et dernier épisode. */
const V3_EXPECTED = {
  status: 'Continuing',
  seasonCount: 3,
  seasons: [{ number: 1 }, { number: 2 }, { number: 3 }],
  nextAired: '2099-03-01',
  lastAired: '2012-06-03',
};
/** Forme attendue pour une clé v4 : identique à la réponse historique de la route. */
const V4_EXPECTED = {
  status: 'Continuing',
  seasonCount: 2,
  seasons: [{ number: 1 }, { number: 2 }],
  nextAired: '2026-11-01',
  lastAired: '2026-10-01',
};

type Handlers = Record<string, Handler>;

/** API v4 : endpoint « extended » d'une série, accessible avec le jeton émis par le login v4. */
function v4Series(id: string): Handlers {
  return {
    [`${V4_BASE}/series/${id}/extended`]: (call) =>
      call.headers.authorization === 'Bearer v4-session'
        ? json({
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
          })
        : json({ status: 'failure' }, 401),
  };
}

/** API v3 d'une série : statut, saisons diffusées (résumé) et épisodes paginés. Seul le jeton `bearer` est accepté. */
function v3Series(id: string, bearer: string): Handlers {
  const base = `${V3_BASE}/series/${id}`;
  const guard = (call: UpstreamCall, body: () => Response): Response =>
    call.headers.authorization === `Bearer ${bearer}` ? body() : json({ Error: 'Not Authorized' }, 401);
  return {
    [base]: (call) => guard(call, () => json({ data: { id: Number(id), seriesName: 'Série test', status: 'Continuing' } })),
    [`${base}/episodes/summary`]: (call) =>
      guard(call, () => json({ data: { airedSeasons: ['1', '2', '3', '0'], airedEpisodes: '6' } })),
    [`${base}/episodes`]: (call) =>
      guard(call, () =>
        call.url.searchParams.get('page') === '2'
          ? json({ links: { first: 1, last: 2, next: null, prev: 1 }, data: EPISODES_PAGE_2 })
          : json({ links: { first: 1, last: 2, next: 2, prev: null }, data: EPISODES_PAGE_1 }),
      ),
  };
}

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  // Le login v3 de la clé « expiry » renvoie d'abord un jeton déjà expiré côté amont, puis un jeton valide.
  let expiryLogins = 0;
  upstream = mockUpstream({
    [V4_LOGIN]: (call) => {
      const { apikey } = JSON.parse(call.body) as { apikey?: string };
      if (apikey === V4_KEY) return json({ status: 'success', data: { token: 'v4-session' } });
      if (apikey === FLAKY) return json({ status: 'failure' }, 500);
      return json({ status: 'failure', message: 'InvalidAPIKey' }, 401);
    },
    [V3_LOGIN]: (call) => {
      const { apikey } = JSON.parse(call.body) as { apikey?: string };
      if (apikey === LEGACY) return json({ token: 'v3-session' });
      if (apikey === LEGACY_EXPIRY) {
        expiryLogins += 1;
        return json({ token: expiryLogins === 1 ? 'v3-expired' : 'v3-fresh' });
      }
      return json({ Error: 'Invalid API key' }, 401);
    },
    ...v4Series('81189'),
    ...v4Series('81190'),
    ...v3Series('121361', 'v3-session'),
    ...v3Series('121362', 'v3-session'),
    ...v3Series('121370', 'v3-fresh'),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const get = (config: string, id: string): Promise<Response> => fetch(`${app.baseUrl}/${config}/lt/tvdb/series/${id}`);

/** Connexions faites avec une clé donnée sur l'URL de login indiquée. */
function loginsWith(apiKey: string, loginUrl: string): UpstreamCall[] {
  return upstream.callsTo(loginUrl).filter((call) => (JSON.parse(call.body) as { apikey?: string }).apikey === apiKey);
}

/** Nombre d'appels émis vers l'API v3 (toutes routes confondues). */
const v3Calls = (): number => upstream.calls.filter((call) => call.url.origin === V3_BASE).length;

describe('lt/tvdb : clé v4 personnelle', () => {
  it('connexion v4 sans PIN, aucun appel v3, forme inchangée', async () => {
    const before = v3Calls();
    const res = await get(tokenFor({ tvdbApiKey: V4_KEY }), '81189');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(V4_EXPECTED);
    expect(JSON.parse(upstream.callsTo(V4_LOGIN).at(-1)?.body ?? '{}')).toEqual({ apikey: V4_KEY });
    expect(v3Calls()).toBe(before);
  });

  it('PIN configuré : envoyé à la connexion v4 avec la clé', async () => {
    const res = await get(tokenFor({ tvdbApiKey: V4_KEY, tvdbPin: PIN }), '81190');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(V4_EXPECTED);
    expect(JSON.parse(upstream.callsTo(V4_LOGIN).at(-1)?.body ?? '{}')).toEqual({ apikey: V4_KEY, pin: PIN });
  });
});

describe('lt/tvdb : clé legacy (repli sur l\'API v3)', () => {
  it('v4 refusée (401) puis v3 : forme identique, saisons hors saison 0, prochain et dernier épisode, pages lues', async () => {
    const res = await get(tokenFor({ tvdbApiKey: LEGACY }), '121361');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(V3_EXPECTED);
    expect(loginsWith(LEGACY, V4_LOGIN)).toHaveLength(1);
    expect(loginsWith(LEGACY, V3_LOGIN)).toHaveLength(1);
    expect(upstream.callsTo(`${V3_BASE}/series/121361/episodes`).map((call) => call.url.searchParams.get('page'))).toEqual([
      '1',
      '2',
    ]);
  });

  it('version retenue par clé : aucun essai v4 ni nouvelle connexion v3 à la requête suivante', async () => {
    const res = await get(tokenFor({ tvdbApiKey: LEGACY }), '121362');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(V3_EXPECTED);
    expect(loginsWith(LEGACY, V4_LOGIN)).toHaveLength(1);
    expect(loginsWith(LEGACY, V3_LOGIN)).toHaveLength(1);
  });

  it('jeton v3 expiré en cours d\'appel : une seule nouvelle connexion, puis succès', async () => {
    const res = await get(tokenFor({ tvdbApiKey: LEGACY_EXPIRY }), '121370');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(V3_EXPECTED);
    expect(loginsWith(LEGACY_EXPIRY, V3_LOGIN)).toHaveLength(2);
  });

  it('clé refusée par v4 et v3 : 503 tvdb_unavailable, sans la clé dans la réponse', async () => {
    const res = await get(tokenFor({ tvdbApiKey: REJECTED }), '121363');
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'tvdb_unavailable' });
    expect(body).not.toContain(REJECTED);
  });

  it('panne v4 (5xx) : pas de repli sur v3, 503 tvdb_unavailable', async () => {
    const res = await get(tokenFor({ tvdbApiKey: FLAKY }), '121364');
    expect(res.status).toBe(503);
    expect(loginsWith(FLAKY, V3_LOGIN)).toHaveLength(0);
  });
});

describe('POST /config/test : sonde TheTVDB', () => {
  it('clé legacy : ok avec la note « clé legacy (API v3) »', async () => {
    const res = await fetch(`${app.baseUrl}/config/test`, postJson({ services: { tvdbApiKey: LEGACY } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { services: unknown }).services).toEqual([
      { name: 'TheTVDB', type: 'tvdbApiKey', ok: true, note: 'clé legacy (API v3)' },
    ]);
  });

  it('clé v4 personnelle : ok, sans note', async () => {
    const res = await fetch(`${app.baseUrl}/config/test`, postJson({ services: { tvdbApiKey: V4_KEY, tvdbPin: PIN } }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw).services).toEqual([{ name: 'TheTVDB', type: 'tvdbApiKey', ok: true }]);
    expect(JSON.parse(raw).services[0]).not.toHaveProperty('note');
    expect(raw).not.toContain(PIN);
    expect(raw).not.toContain(V4_KEY);
  });

  it('clé refusée : ok à faux, erreur générique, aucune clé dans la réponse', async () => {
    const res = await fetch(`${app.baseUrl}/config/test`, postJson({ services: { tvdbApiKey: REJECTED } }));
    const raw = await res.text();
    expect(JSON.parse(raw).services).toEqual([{ name: 'TheTVDB', type: 'tvdbApiKey', ok: false, error: 'upstream_401' }]);
    expect(raw).not.toContain(REJECTED);
  });
});
