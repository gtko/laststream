import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { plainText } from '../src/lt/ai.js';
import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, LtError, TTL, TtlCache } from '../src/lt/context.js';
import { tmdbPublicParams, tmdbTtl } from '../src/lt/providers.js';
import {
  fakeLookup,
  fullToken,
  json,
  mockUpstream,
  postJson,
  SECRET,
  startApp,
  tokenFor,
  type MockUpstream,
  type RunningApp,
} from './lt-harness.js';

const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TtlCache : plafonds et éviction LRU', () => {
  const put = (cache: TtlCache, key: string, payload: unknown, ttlMs = 60_000): Promise<unknown> =>
    cache.get(key, ttlMs, async () => payload);

  it('plafond d entrées : la moins récemment consultée part en premier', async () => {
    const cache = new TtlCache(3, 1_000_000);
    await put(cache, 'a', 1);
    await put(cache, 'b', 2);
    await put(cache, 'c', 3);
    await cache.get('a', 60_000, async () => 0); // 'a' redevient la plus récente
    await put(cache, 'd', 4); // évince 'b'
    expect(cache.size).toBe(3);
    let loadsA = 0;
    expect(await cache.get('a', 60_000, async () => ((loadsA += 1), 99))).toBe(1);
    expect(loadsA).toBe(0);
    let loadsB = 0;
    expect(await cache.get('b', 60_000, async () => ((loadsB += 1), 22))).toBe(22);
    expect(loadsB).toBe(1);
  });

  it('plafond d octets : évince jusqu à passer sous le plafond ; une valeur trop grosse n est pas gardée', async () => {
    const cache = new TtlCache(100, 200);
    const payload = 'x'.repeat(80);
    await put(cache, 'a', payload);
    await put(cache, 'b', payload);
    expect(cache.bytes).toBeLessThanOrEqual(200);
    await put(cache, 'c', payload);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBeLessThanOrEqual(200);
    await put(cache, 'huge', 'x'.repeat(500));
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBeLessThanOrEqual(200);
  });

  it('erreur amont 404 mémorisée 60 s, puis rechargée ; autres erreurs jamais mémorisées', async () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache();
      let loads = 0;
      const notFound = async (): Promise<number> => {
        loads += 1;
        throw new LtError(502, 'upstream_404');
      };
      await expect(cache.get('nf', TTL.tmdb, notFound)).rejects.toThrow('upstream_404');
      await expect(cache.get('nf', TTL.tmdb, notFound)).rejects.toThrow('upstream_404');
      expect(loads).toBe(1);
      vi.advanceTimersByTime(61_000);
      await expect(cache.get('nf', TTL.tmdb, notFound)).rejects.toThrow('upstream_404');
      expect(loads).toBe(2);
      let serverErrors = 0;
      const serverError = async (): Promise<number> => {
        serverErrors += 1;
        throw new LtError(502, 'upstream_500');
      };
      await expect(cache.get('se', TTL.tmdb, serverError)).rejects.toThrow('upstream_500');
      await expect(cache.get('se', TTL.tmdb, serverError)).rejects.toThrow('upstream_500');
      expect(serverErrors).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('une entrée expirée est rechargée', async () => {
    const cache = new TtlCache();
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      return loads;
    };
    await cache.get('k', -1, load);
    await cache.get('k', -1, load);
    expect(loads).toBe(2);
  });
});

describe('paramètres TMDB en liste blanche', () => {
  it('garde les paramètres autorisés, écarte les autres et n accepte include_adult qu à false', () => {
    expect(
      tmdbPublicParams({ with_genres: '28', fake_param: '1', include_adult: 'true', sort_by: 'popularity.desc', api_key: 'x', language: 'en-US' }),
    ).toEqual({ with_genres: '28', sort_by: 'popularity.desc', language: 'en-US' });
    expect(tmdbPublicParams({ include_adult: 'false', primary_release_date_gte: '2020' })).toEqual({ include_adult: 'false' });
    expect(tmdbPublicParams({ 'primary_release_date.gte': '2020', 'air_date.lte': '2024' })).toEqual({
      'primary_release_date.gte': '2020',
      'air_date.lte': '2024',
    });
  });

  it('laisse passer les filtres de découverte ajoutés (durée, notes, pays, type, statut, personnes, dates)', () => {
    const filters: Record<string, string> = {
      'with_runtime.gte': '60',
      'with_runtime.lte': '120',
      'vote_average.gte': '7',
      'vote_average.lte': '9',
      'vote_count.lte': '5000',
      with_origin_country: 'FR',
      with_type: '4',
      with_status: '0',
      without_companies: '420',
      with_people: '287',
      with_cast: '287',
      with_crew: '525',
      first_air_date_year: '2020',
      primary_release_year: '2019',
      year: '1999',
      timezone: 'Europe/Paris',
      screened_theatrically: 'true',
      with_release_type: '3',
      'release_date.gte': '2020-01-01',
      'release_date.lte': '2020-12-31',
    };
    expect(tmdbPublicParams(filters)).toEqual(filters);
  });
});

describe('texte IA : brut, sans balises ni caractères de contrôle', () => {
  it('retire les balises et ramène les sauts de ligne à des espaces', () => {
    expect(plainText('<b>Bon</b>\nfilm')).toBe('Bon film');
    expect(plainText('<img src=x onerror=alert(1)>Texte')).toBe('Texte');
  });

  it('supprime les caractères de contrôle et réduit les espaces', () => {
    expect(plainText(`Bon${NUL}${BEL}   film`)).toBe('Bon film');
  });
});

describe('lectures lt : cache privé, erreurs sans cache, clés par service', () => {
  let upstream: MockUpstream;
  let app: RunningApp;

  beforeAll(async () => {
    upstream = mockUpstream({
      'https://api.themoviedb.org/3/discover/movie': () => json({ results: [] }),
      'https://api.themoviedb.org/3/person/7': () => json({ id: 7 }),
      'https://api.themoviedb.org/3/movie/999999': () => json({ status_message: 'not found' }, 404),
      'https://api.themoviedb.org/3/movie/500': () => json({ status_message: 'boom' }, 500),
      'https://api.mdblist.com/imdb/movie/tt0133093': () => json({ ratings: [], score: 1 }),
    });
    app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
  });

  afterAll(async () => {
    await app.close();
  });

  it('succès GET : private, max-age=300 ; erreur et POST : no-store', async () => {
    const ok = await fetch(`${app.baseUrl}/${fullToken()}/lt/health`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, max-age=300');
    const missing = await fetch(`${app.baseUrl}/${tokenFor({})}/lt/tmdb/movie/1`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    const invalid = await fetch(`${app.baseUrl}/not-a-config/lt/health`);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    const post = await fetch(`${app.baseUrl}/${tokenFor({})}/lt/person-why`, postJson({}));
    expect(post.headers.get('cache-control')).toBe('no-store');
  });

  it('TMDB : seuls les paramètres en liste blanche partent vers l amont', async () => {
    const res = await fetch(
      `${app.baseUrl}/${tokenFor({ tmdbToken: 'tmdb-token-A' })}/lt/tmdb/discover/movie?with_genres=28&fake_param=1&include_adult=true&api_key=stolen&sort_by=popularity.desc`,
    );
    expect(res.status).toBe(200);
    const call = upstream.callsTo('https://api.themoviedb.org/3/discover/movie').at(-1);
    expect(call?.url.searchParams.get('with_genres')).toBe('28');
    expect(call?.url.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(call?.url.searchParams.has('fake_param')).toBe(false);
    expect(call?.url.searchParams.has('include_adult')).toBe(false);
    expect(call?.url.searchParams.has('api_key')).toBe(false);
  });

  it('cache partagé entre utilisateurs : deux jetons TMDB différents, une seule requête amont', async () => {
    const before = upstream.callsTo('https://api.themoviedb.org/3/person/7').length;
    await fetch(`${app.baseUrl}/${tokenFor({ tmdbToken: 'tmdb-token-B' })}/lt/tmdb/person/7`);
    await fetch(`${app.baseUrl}/${tokenFor({ tmdbToken: 'tmdb-token-C' })}/lt/tmdb/person/7`);
    expect(upstream.callsTo('https://api.themoviedb.org/3/person/7').length).toBe(before + 1);
  });

  it('cache partagé : deux clés MDBList différentes, une seule requête amont', async () => {
    const before = upstream.callsTo('https://api.mdblist.com/imdb/movie/tt0133093').length;
    await fetch(`${app.baseUrl}/${tokenFor({ mdblistApiKey: 'mdb-key-one' })}/lt/mdblist/movie/tt0133093`);
    await fetch(`${app.baseUrl}/${tokenFor({ mdblistApiKey: 'mdb-key-two' })}/lt/mdblist/movie/tt0133093`);
    expect(upstream.callsTo('https://api.mdblist.com/imdb/movie/tt0133093').length).toBe(before + 1);
  });

  it('erreur amont 404 : mémorisée 60 s (une seule requête amont) ; erreur 500 : jamais mémorisée', async () => {
    const notFound = `${app.baseUrl}/${fullToken()}/lt/tmdb/movie/999999`;
    expect((await fetch(notFound)).status).toBe(502);
    expect((await fetch(notFound)).status).toBe(502);
    expect(upstream.callsTo('https://api.themoviedb.org/3/movie/999999').length).toBe(1);
    const broken = `${app.baseUrl}/${fullToken()}/lt/tmdb/movie/500`;
    await fetch(broken);
    await fetch(broken);
    expect(upstream.callsTo('https://api.themoviedb.org/3/movie/500').length).toBe(2);
  });

  it('TTL : détails 6 h, tendances et populaires 3 h, fournisseurs 12 h, MDBList 24 h, TVDB 12 h, IA 24 h (lot vide 5 min) et 7 jours', () => {
    expect(tmdbTtl('movie/603')).toBe(6 * 3600e3);
    expect(tmdbTtl('movie/upcoming')).toBe(6 * 3600e3);
    expect(tmdbTtl('trending/all/week')).toBe(3 * 3600e3);
    expect(tmdbTtl('trending/all/day')).toBe(3600e3);
    expect(tmdbTtl('tv/popular')).toBe(3 * 3600e3);
    expect(tmdbTtl('movie/603/watch/providers')).toBe(12 * 3600e3);
    expect(TTL.mdb).toBe(24 * 3600e3);
    expect(TTL.tvdb).toBe(12 * 3600e3);
    expect(TTL.aiRecommend).toBe(24 * 3600e3);
    expect(TTL.aiRecommendEmpty).toBe(5 * 60e3);
    expect(TTL.aiText).toBe(7 * 24 * 3600e3);
    expect(TTL.tvChannels).toBe(12 * 3600e3);
    expect(TTL.tvPartial).toBe(15 * 60e3);
    expect(TTL.tvEpg).toBe(3 * 3600e3);
  });

  it('plafonds du cache : 10 000 entrées, 100 Mo', () => {
    expect(CACHE_MAX_ENTRIES).toBe(10_000);
    expect(CACHE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it('textes « pourquoi » : une seule requête IA par identifiant TMDB et langue, les champs texte du client sont ignorés', async () => {
    let calls = 0;
    const aiUpstream = mockUpstream({
      'https://openrouter.ai/api/v1/chat/completions': () => {
        calls += 1;
        return json({ choices: [{ message: { content: 'Texte par identifiant.' } }] });
      },
      'https://api.themoviedb.org/3/person/438631': () => json({ name: 'Denis Villeneuve' }),
      'https://api.themoviedb.org/3/person/438631/combined_credits': () => json({ cast: [] }),
      'https://api.themoviedb.org/3/person/1': () => json({ name: 'Autre' }),
      'https://api.themoviedb.org/3/person/1/combined_credits': () => json({ cast: [] }),
    });
    const aiApp = await startApp({ fetch: aiUpstream.fetch, lookupHost: fakeLookup() });
    try {
      const path = `${aiApp.baseUrl}/${fullToken()}/lt/person-why`;
      await fetch(path, postJson({ tmdbId: 438631, name: 'Nom A' }));
      await fetch(path, postJson({ tmdbId: 438631, name: 'Nom B' }));
      expect(calls).toBe(1);
      await fetch(path, postJson({ tmdbId: 1 }));
      expect(calls).toBe(2);
    } finally {
      await aiApp.close();
    }
  });

  it('listes TV : si toutes les sources échouent, rien n est mis en cache (502 puis nouvel essai)', async () => {
    const failing = mockUpstream({});
    const tvApp = await startApp({ fetch: failing.fetch, lookupHost: fakeLookup() });
    try {
      const path = `${tvApp.baseUrl}/${fullToken()}/lt/tv/channels`;
      expect((await fetch(path)).status).toBe(502);
      expect((await fetch(path)).status).toBe(502);
      expect(failing.callsTo('https://iptv-org.github.io/api/channels.json').length).toBe(2);
    } finally {
      await tvApp.close();
    }
  });

  it('réponse IA : balises et contrôles retirés avant renvoi', async () => {
    const aiUpstream = mockUpstream({
      'https://openrouter.ai/api/v1/chat/completions': () =>
        json({ choices: [{ message: { content: `<img src=x onerror=alert(1)>Film ${BEL}culte` } }] }),
      'https://api.themoviedb.org/3/person/438631': () => json({ name: 'Denis Villeneuve' }),
      'https://api.themoviedb.org/3/person/438631/combined_credits': () => json({ cast: [] }),
    });
    const aiApp = await startApp({ fetch: aiUpstream.fetch, lookupHost: fakeLookup() });
    try {
      const res = await fetch(`${aiApp.baseUrl}/${fullToken()}/lt/person-why`, postJson({ tmdbId: 438631 }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: 'Film culte' });
    } finally {
      await aiApp.close();
    }
  });
});

describe('limite de débit des lectures lt et catalogue', () => {
  let app: RunningApp;

  beforeAll(async () => {
    process.env.LASTADDON_READ_RATE_LIMIT = '120';
    app = await startApp({ lookupHost: fakeLookup() });
  });

  afterAll(async () => {
    delete process.env.LASTADDON_READ_RATE_LIMIT;
    await app.close();
  });

  it('120 GET par minute et par IP, puis 429 avec Retry-After et no-store', async () => {
    const path = `${app.baseUrl}/${tokenFor({})}/lt/health`;
    for (let i = 0; i < 120; i++) {
      expect((await fetch(path)).status).toBe(200);
    }
    const limited = await fetch(path);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(limited.headers.get('cache-control')).toBe('no-store');
  });
});

describe('trust proxy : activé seulement avec LASTADDON_TRUST_PROXY=1', () => {
  const deps = { secret: SECRET, allowPlain: false };

  /** 31 requêtes /config (limite : 30 par minute et par IP) dont X-Forwarded-For change à chaque appel. */
  async function sawRateLimit(app: ReturnType<typeof createApp>): Promise<boolean> {
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const res = await app.request('/config/schema', { headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } });
      if (res.status === 429) limited = true;
    }
    return limited;
  }

  it('sans la variable : X-Forwarded-For ignoré (tous les appels partagent la même IP, donc 429)', async () => {
    vi.stubEnv('LASTADDON_TRUST_PROXY', '');
    expect(await sawRateLimit(createApp(deps))).toBe(true);
  });

  it('avec LASTADDON_TRUST_PROXY=1 : un saut de confiance, le dernier X-Forwarded-For identifie le client', async () => {
    vi.stubEnv('LASTADDON_TRUST_PROXY', '1');
    expect(await sawRateLimit(createApp(deps))).toBe(false);
  });
});
