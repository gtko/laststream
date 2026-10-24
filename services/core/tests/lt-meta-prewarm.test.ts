import { describe, expect, it } from 'vitest';
import { createLtContext } from '../src/lt/context.js';
import { collectPrewarmTargets, PREWARM_HORIZON_MS, PREWARM_MAX_MDBLIST, PREWARM_MAX_TMDB, type PrewarmTarget, prewarmMetaFiches, targetsOf } from '../src/lt/meta-prewarm.js';
import { type MetaBlob, type MetaBlobStore, type MetaRuntime, type MetaServices, etagOf, prewarmFiche, serveMetaFiche } from '../src/lt/meta.js';
import { baseKey, l10nKey, legacyKey, ratingsKey } from '../src/lt/meta-policy.js';
import type { MetaRepo } from '../src/user/repo.js';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, SECRET } from './lt-harness.js';

/** Préchauffage des fiches (cron, lt/meta-prewarm.ts) : budgets par passage, couches fraîches intactes, horizon de 7 h (et au plus le quart de la durée de vie). */

const TMDB = 'https://api.themoviedb.org/3';
const MDB = 'https://api.mdblist.com';
const DAY = 24 * 3600e3;
const HOUR = 3600e3;
/** 24 octobre 2026 (UTC) : la fiche de test (sortie en 1999) est une fiche « réglée ». */
const NOW = Date.UTC(2026, 9, 24);

/** Stockage R2 simulé : corps, empreinte, échéance ; compte les écritures. */
class MemoryBlobs implements MetaBlobStore {
  readonly items = new Map<string, MetaBlob>();
  puts = 0;
  get(key: string): Promise<MetaBlob | undefined> {
    return Promise.resolve(this.items.get(key));
  }
  put(key: string, blob: MetaBlob): Promise<void> {
    this.puts += 1;
    this.items.set(key, blob);
    return Promise.resolve();
  }
}

/** Index des fiches sans effet : seule l'écriture de la couche compte ici. */
const INDEX = { upsert: (): Promise<void> => Promise.resolve() } as unknown as MetaRepo;

const BASE_BODY = JSON.stringify({
  schema: 2,
  type: 'movie',
  tmdbId: 603,
  imdbId: 'tt0133093',
  tvdbId: null,
  originalTitle: 'The Matrix',
  year: 1999,
  releaseDate: '1999-03-31',
  status: 'Released',
  nextAirDate: null,
  lastAirDate: null,
  runtime: 136,
  cast: [],
  tvdb: null,
  episodes: null,
  partial: false,
});
const L10N_BODY = JSON.stringify({
  schema: 2,
  lang: 'fr-FR',
  title: 'Matrix',
  overview: 'Simulation',
  tagline: null,
  genres: ['Science-Fiction'],
  posterPath: null,
  backdropPath: null,
  seasons: null,
  episodes: null,
});
const RATINGS_BODY = JSON.stringify({ schema: 2, ratings: { imdb: 8.7 }, partial: false });

const MATRIX = { base: baseKey('movie', 603), l10n: l10nKey('movie', 603, 'fr-FR'), ratings: ratingsKey('movie', 603) };

function seed(blobs: MemoryBlobs, key: string, body: string, expiresAt: number): void {
  blobs.items.set(key, { body, etag: etagOf(body), expiresAt, ttl: DAY });
}

/** Film 603 tel que TMDB le renvoie (une seule requête : titre, synopsis et genres présents en français). */
const matrixDetails = () => ({
  id: 603,
  title: 'Matrix',
  original_title: 'The Matrix',
  release_date: '1999-03-31',
  status: 'Released',
  overview: 'Simulation',
  genres: [{ id: 878, name: 'Science-Fiction' }],
  runtime: 136,
  poster_path: '/m.jpg',
  backdrop_path: '/b.jpg',
  imdb_id: 'tt0133093',
  external_ids: { imdb_id: 'tt0133093' },
  credits: { cast: [] },
});

function matrixUpstream(): MockUpstream {
  return mockUpstream({
    [`${TMDB}/movie/603`]: () => json(matrixDetails()),
    [`${MDB}/imdb/movie/tt0133093`]: () => json({ ratings: [{ source: 'imdb', value: 8.7 }], score: 85, released: '1999-03-31' }),
  });
}

/** Identifiant IMDb valide (sept chiffres au moins) pour un identifiant TMDB n. */
const imdbOf = (id: number): string => `tt${String(id).padStart(7, '0')}`;

/** Fiche générique (sans couche stockée) : identifiant TMDB n, IMDb valide. */
const bulkMovie = (id: number) => ({
  id,
  title: `Film ${id}`,
  original_title: `Film ${id}`,
  release_date: '1999-01-01',
  status: 'Released',
  overview: 'Synopsis',
  genres: [{ id: 1, name: 'Genre' }],
  runtime: 90,
  poster_path: null,
  backdrop_path: null,
  imdb_id: imdbOf(id),
  external_ids: { imdb_id: imdbOf(id) },
  credits: { cast: [] },
});

/** Amont simulé pour de grands passages : films à n'importe quel identifiant, panne pour les identifiants de `failing`. */
function bulkUpstream(failing: ReadonlySet<number> = new Set()): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname);
    const movie = /^\/3\/movie\/(\d+)$/.exec(url.pathname);
    if (movie !== null) {
      const id = Number(movie[1]);
      return Promise.resolve(failing.has(id) ? new Response('panne', { status: 503 }) : json(bulkMovie(id)));
    }
    if (url.pathname.startsWith('/imdb/movie/')) return Promise.resolve(json({ ratings: [{ source: 'imdb', value: 7 }], score: 70, released: '1999-01-01' }));
    return Promise.resolve(new Response('non mocké', { status: 599 }));
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function runtime(fetchImpl: typeof fetch, blobs: MemoryBlobs, mdblistDailyBudget = 1_000_000): MetaRuntime {
  return {
    ctx: createLtContext({
      secret: SECRET,
      allowPlain: false,
      fetch: fetchImpl,
      lookupHost: fakeLookup(),
      mdblistLimiter: () => Promise.resolve(true),
      mdblistDailyBudget,
    }),
    blobs,
    index: () => INDEX,
    now: () => NOW,
    background: () => undefined,
  };
}

const SERVICES: MetaServices = { tmdbToken: KEYS.tmdbToken, mdblistApiKey: KEYS.mdblistApiKey, tvdbApiKey: undefined, tvdbPin: undefined };

const tmdbMovieCalls = (calls: readonly string[]): number => calls.filter((path) => /^\/3\/movie\/\d+$/.test(path)).length;
const mdbCalls = (calls: readonly string[]): number => calls.filter((path) => path.startsWith('/imdb/')).length;

describe('préchauffage : une couche fraîche n est jamais touchée', () => {
  it('fiche entièrement fraîche au-delà de l horizon : aucune lecture amont, aucune écriture', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.ratings, RATINGS_BODY, NOW + 10 * DAY);
    const before = new Map(blobs.items);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: false, ratings: false });
    expect(upstream.calls).toHaveLength(0);
    expect(blobs.puts).toBe(0);
    expect([...blobs.items.entries()]).toEqual([...before.entries()]);
  });

  it('une couche qui expire dans moins de 7 h est reconstruite ; les couches fraîches restent les mêmes objets', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 1 * HOUR);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.ratings, RATINGS_BODY, NOW + 10 * DAY);
    const l10nBefore = blobs.items.get(MATRIX.l10n);
    const ratingsBefore = blobs.items.get(MATRIX.ratings);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: true, ratings: false });
    expect(tmdbMovieCalls(upstream.calls.map((c) => c.url.pathname))).toBe(1);
    expect(mdbCalls(upstream.calls.map((c) => c.url.pathname))).toBe(0);
    expect(blobs.items.get(MATRIX.base)?.expiresAt).toBeGreaterThan(NOW + 24 * HOUR);
    expect(blobs.items.get(MATRIX.l10n)).toBe(l10nBefore);
    expect(blobs.items.get(MATRIX.ratings)).toBe(ratingsBefore);
    expect(blobs.puts).toBe(1);
  });

  it('une couche expirée est reconstruite même si son contenu n a pas changé (échéance renouvelée)', async () => {
    const blobs = new MemoryBlobs();
    const upstream = matrixUpstream();
    await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });
    const stored = blobs.items.get(MATRIX.base);
    if (stored === undefined) throw new Error('couche base absente après le premier passage');
    // Même contenu, échéance dépassée : R2 ne renouvelle pas une couche saine ; le préchauffage doit la réécrire.
    blobs.items.set(MATRIX.base, { ...stored, expiresAt: NOW + 1 * HOUR });
    const callsBefore = upstream.calls.length;

    // Second passage dans un autre isolat (contexte neuf, sans cache de réponses TMDB).
    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome.core).toBe(true);
    expect(upstream.calls.length).toBeGreaterThan(callsBefore);
    expect(blobs.items.get(MATRIX.base)?.body).toBe(stored.body);
    expect(blobs.items.get(MATRIX.base)?.expiresAt).toBeGreaterThan(NOW + 24 * HOUR);
  });

  it('notes qui expirent dans moins de 7 h : un seul appel MDBList, base et traduction fraîches intactes', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.ratings, RATINGS_BODY, NOW + 2 * HOUR);
    const baseBefore = blobs.items.get(MATRIX.base);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: false, ratings: true });
    expect(tmdbMovieCalls(upstream.calls.map((c) => c.url.pathname))).toBe(0);
    expect(mdbCalls(upstream.calls.map((c) => c.url.pathname))).toBe(1);
    expect(blobs.items.get(MATRIX.base)).toBe(baseBefore);
    expect(blobs.items.get(MATRIX.ratings)?.expiresAt).toBeGreaterThan(NOW + 24 * HOUR);
  });

  it('sans clé MDBList : aucun appel aux notes, même si la couche manque', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 10 * DAY);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), { ...SERVICES, mdblistApiKey: undefined }, 'movie', 603, PREWARM_HORIZON_MS, {
      tmdb: 10,
      mdblist: 10,
    });

    expect(outcome.ratings).toBe(false);
    expect(mdbCalls(upstream.calls.map((c) => c.url.pathname))).toBe(0);
  });

  it('sans stockage R2 : rien à préchauffer', async () => {
    const upstream = matrixUpstream();
    const rt: MetaRuntime = { ...runtime(upstream.fetch, new MemoryBlobs()), blobs: undefined };

    const outcome = await prewarmFiche(rt, SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: false, ratings: false });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('budget MDBList quotidien épuisé : notes de la fiche refusées sans appel', () => {
  it('service de la fiche : aucun appel MDBList, fiche servie avec notes null et partielle', async () => {
    const blobs = new MemoryBlobs();
    const upstream = matrixUpstream();

    const served = await serveMetaFiche(runtime(upstream.fetch, blobs, 0), SERVICES, 'movie', 603);

    expect(JSON.parse(served.body)).toMatchObject({ title: 'Matrix', ratings: null, partial: true });
    expect(mdbCalls(upstream.calls.map((c) => c.url.pathname))).toBe(0);
    expect(JSON.parse((blobs.items.get(MATRIX.ratings) as MetaBlob).body)).toMatchObject({ ratings: null, partial: true });
  });

  it('préchauffage : aucun appel MDBList, couche des notes stockée partielle', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 10 * DAY);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs, 0), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: false, ratings: true });
    expect(mdbCalls(upstream.calls.map((c) => c.url.pathname))).toBe(0);
    expect(JSON.parse((blobs.items.get(MATRIX.ratings) as MetaBlob).body)).toMatchObject({ ratings: null, partial: true });
  });
});

describe('préchauffage : reprise des notes v1 avant le budget MDBList', () => {
  it('notes absentes et ancien objet v1 présent : reprises sans appel MDBList, budget mdblist inchangé', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 10 * DAY);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 10 * DAY);
    blobs.items.set(legacyKey('movie', 603), {
      body: JSON.stringify({ v: 1, type: 'movie', tmdbId: 603, ratings: { ratings: { imdb: 7.7 }, score: 70 } }),
      etag: '"ancien"',
      expiresAt: NOW - DAY,
      ttl: 0,
    });
    const upstream = matrixUpstream();
    const budget = { tmdb: 10, mdblist: 5 };

    await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, budget);

    expect(mdbCalls(upstream.calls.map((c) => c.url.pathname))).toBe(0);
    expect(budget.mdblist).toBe(5);
    expect(JSON.parse((blobs.items.get(MATRIX.ratings) as MetaBlob).body)).toMatchObject({ ratings: { ratings: { imdb: 7.7 } }, partial: false });
    expect(blobs.items.has(legacyKey('movie', 603))).toBe(true);
  });
});

describe('préchauffage : seuil = min(horizon, quart de la durée de vie)', () => {
  it('couche de 1 j créée il y a 6 h (18 h restantes) : ni lue en amont ni réécrite', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 18 * HOUR);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 18 * HOUR);
    seed(blobs, MATRIX.ratings, RATINGS_BODY, NOW + 18 * HOUR);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: false, ratings: false });
    expect(upstream.calls).toHaveLength(0);
    expect(blobs.puts).toBe(0);
  });

  it('couche de 1 j à 5 h de l échéance (moins du quart) : reconstruite', async () => {
    const blobs = new MemoryBlobs();
    seed(blobs, MATRIX.base, BASE_BODY, NOW + 5 * HOUR);
    seed(blobs, MATRIX.l10n, L10N_BODY, NOW + 18 * HOUR);
    seed(blobs, MATRIX.ratings, RATINGS_BODY, NOW + 18 * HOUR);
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: true, ratings: false });
    expect(blobs.items.get(MATRIX.base)?.expiresAt).toBeGreaterThan(NOW + 24 * HOUR);
  });

  it('couche absente : reconstruite', async () => {
    const blobs = new MemoryBlobs();
    const upstream = matrixUpstream();

    const outcome = await prewarmFiche(runtime(upstream.fetch, blobs), SERVICES, 'movie', 603, PREWARM_HORIZON_MS, { tmdb: 10, mdblist: 10 });

    expect(outcome).toEqual({ core: true, ratings: true });
  });
});

describe('préchauffage : budgets par passage', () => {
  it('plafonds : 300 reconstructions TMDB et 100 appels MDBList par passage', async () => {
    expect(PREWARM_MAX_TMDB).toBe(300);
    expect(PREWARM_MAX_MDBLIST).toBe(100);
    expect(PREWARM_HORIZON_MS).toBe(7 * HOUR);
    const blobs = new MemoryBlobs();
    const upstream = bulkUpstream();
    const targets: PrewarmTarget[] = Array.from({ length: 320 }, (_, i) => ({ type: 'movie', tmdbId: i + 1 }));

    const report = await prewarmMetaFiches({ meta: runtime(upstream.fetch, blobs), svc: SERVICES }, targets);

    expect(tmdbMovieCalls(upstream.calls)).toBe(300);
    expect(mdbCalls(upstream.calls)).toBe(100);
    expect(report.core).toBe(300);
    expect(report.ratings).toBe(100);
    expect(report.failed).toBe(0);
    // Fiches au-delà du budget : rien écrit, elles attendent le passage suivant.
    expect(blobs.items.has(baseKey('movie', 301))).toBe(false);
  });

  it('un budget épuisé en cours de passage arrête les reconstructions (fiche suivante non touchée)', async () => {
    const blobs = new MemoryBlobs();
    const upstream = bulkUpstream();
    const targets: PrewarmTarget[] = [
      { type: 'movie', tmdbId: 1 },
      { type: 'movie', tmdbId: 2 },
      { type: 'movie', tmdbId: 3 },
    ];

    const report = await prewarmMetaFiches({ meta: runtime(upstream.fetch, blobs), svc: SERVICES }, targets, { tmdb: 2, mdblist: 0 });

    expect(report.core).toBe(2);
    expect(tmdbMovieCalls(upstream.calls)).toBe(2);
    expect(blobs.items.has(baseKey('movie', 3))).toBe(false);
  });

  it('une fiche en panne n arrête pas le passage : compté en échec, les suivantes sont préchauffées', async () => {
    const blobs = new MemoryBlobs();
    const upstream = bulkUpstream(new Set([2]));
    const targets: PrewarmTarget[] = [
      { type: 'movie', tmdbId: 1 },
      { type: 'movie', tmdbId: 2 },
      { type: 'movie', tmdbId: 3 },
    ];

    const report = await prewarmMetaFiches({ meta: runtime(upstream.fetch, blobs), svc: SERVICES }, targets, { tmdb: 10, mdblist: 0 });

    expect(report.failed).toBe(1);
    expect(report.core).toBe(2);
    expect(blobs.items.has(baseKey('movie', 3))).toBe(true);
  });
});

describe('préchauffage : identifiants des rangées et du Top 10', () => {
  it('targetsOf : films, séries et mêlés (media_type) ; personnes et identifiants invalides écartés', () => {
    expect(targetsOf([{ id: 603, media_type: 'movie' }, { id: 1399, media_type: 'tv' }, { id: 5, media_type: 'person' }, { id: 'x' }, { media_type: 'movie' }], 'mixed')).toEqual([
      { type: 'movie', tmdbId: 603 },
      { type: 'series', tmdbId: 1399 },
    ]);
    expect(targetsOf([{ id: 7 }, { id: 8, media_type: 'tv' }], 'movie')).toEqual([
      { type: 'movie', tmdbId: 7 },
      { type: 'movie', tmdbId: 8 },
    ]);
    expect(targetsOf([{ id: 9 }], 'tv')).toEqual([{ type: 'series', tmdbId: 9 }]);
  });

  it('collectPrewarmTargets : ids TMDB dédupliqués ; une liste en panne est ignorée', async () => {
    const upstream = mockUpstream({
      [`${TMDB}/trending/all/week`]: () =>
        json({ results: [{ id: 603, media_type: 'movie' }, { id: 1399, media_type: 'tv' }, { id: 5, media_type: 'person' }] }),
      [`${TMDB}/movie/popular`]: () => json({ results: [{ id: 603 }, { id: 777 }] }),
      [`${TMDB}/tv/popular`]: () => new Response('panne', { status: 503 }),
    });
    const ctx = createLtContext({ secret: SECRET, allowPlain: false, fetch: upstream.fetch, lookupHost: fakeLookup() });

    const targets = await collectPrewarmTargets(ctx, KEYS.tmdbToken, NOW);

    expect(targets).toEqual([
      { type: 'movie', tmdbId: 603 },
      { type: 'series', tmdbId: 1399 },
      { type: 'movie', tmdbId: 777 },
    ]);
  });
});
