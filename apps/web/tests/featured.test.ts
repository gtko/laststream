// « En vedette » : tirage quotidien d'un pool TMDB, profil enfant, sources en échec, filtre de l'accueil, région, historique.
// Aucun réseau : la requête TMDB est injectée (fetch), tmdb() est simulé.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/lt', () => ({
  tmdb: vi.fn(async () => ({ results: [] })),
}));

import { featuredItems, rememberFeatured } from '../src/data/featured';
import { hideTitle, resetFiltersCache, setGenreBanned, setSeriesCompleted } from '../src/data/homeFilters';
import { SEEN_KEY } from '../src/data/userStore';

type Raw = Record<string, unknown>;
interface Fake { kind: 'movie' | 'tv'; raw: Raw }
interface Call { path: string; params: Record<string, string> }

const movieRaw = (id: number, extra: Raw = {}): Raw => ({
  id, title: `Film ${id}`, backdrop_path: `/b${id}.jpg`, poster_path: `/p${id}.jpg`, overview: '', release_date: '2024-05-01',
  genre_ids: [28], popularity: 50 + id, vote_average: 7, vote_count: 500, original_language: 'en', origin_country: [], adult: false, ...extra,
});
const tvRaw = (id: number, extra: Raw = {}): Raw => ({
  id, name: `Série ${id}`, backdrop_path: `/s${id}.jpg`, poster_path: `/sp${id}.jpg`, overview: '', first_air_date: '2023-09-01',
  genre_ids: [18], popularity: 40 + id, vote_average: 7.2, vote_count: 300, original_language: 'en', origin_country: ['US'], adult: false, ...extra,
});

/** Pool de 40 titres : 24 films (100 à 123) et 16 séries (200 à 215). */
const POOL: Fake[] = [
  ...Array.from({ length: 24 }, (_, i): Fake => ({ kind: 'movie', raw: movieRaw(100 + i, { genre_ids: i % 3 === 0 ? [35] : [28], popularity: 20 + ((i * 37) % 90) }) })),
  ...Array.from({ length: 16 }, (_, i): Fake => ({ kind: 'tv', raw: tvRaw(200 + i, { genre_ids: i % 2 ? [18] : [35] }) })),
];

/** Réponse TMDB simulée : films pour les chemins sans « tv », séries sinon. */
function fakeFetch(pool: Fake[], calls: Call[], fail: (path: string) => boolean = () => false) {
  return async (path: string, params: Record<string, string>): Promise<unknown> => {
    calls.push({ path, params });
    if (fail(path)) throw new Error('TMDB indisponible');
    const kind = path.includes('tv') ? 'tv' : 'movie';
    return { results: pool.filter((p) => p.kind === kind).map((p) => p.raw) };
  };
}

const keys = (items: ReadonlyArray<{ key: string }>): string[] => items.map((i) => i.key);
const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Sélection d'adulte, sans état lu dans le stockage (historique et genres injectés). */
function run(now: Date, extra: Parameters<typeof featuredItems>[0] = {}) {
  return featuredItems({
    now, region: 'FR', profileId: 'p1', isKid: false, watched: [], genreHints: [], preferredGenres: [], history: [],
    fetch: fakeFetch(POOL, []), ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetFiltersCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('En vedette : tirage quotidien', () => {
  it('change d’un jour à l’autre (au moins 3 sélections sur 5 jours), reste stable dans la journée, mêle films et séries', async () => {
    const sel: string[][] = [];
    for (let d = 1; d <= 5; d++) sel.push(keys(await run(new Date(2026, 9, d, 9))));
    expect(new Set(sel.map((s) => s.join('|'))).size).toBeGreaterThanOrEqual(3);
    for (const s of sel) {
      expect(s).toHaveLength(8);
      expect(new Set(s).size).toBe(8);
      expect(s.filter((k) => k.startsWith('tv:')).length).toBeGreaterThanOrEqual(2);
    }
    expect(keys(await run(new Date(2026, 9, 1, 22, 30)))).toEqual(sel[0]);
  });

  it('ne renvoie que des titres sortis, avec un fond', async () => {
    const pool: Fake[] = [...POOL, { kind: 'movie', raw: movieRaw(900, { release_date: '2099-01-01' }) }, { kind: 'movie', raw: movieRaw(901, { backdrop_path: '' }) }];
    const out = await run(new Date(2026, 9, 3, 9), { fetch: fakeFetch(pool, []) });
    expect(keys(out)).not.toContain('movie:900');
    expect(keys(out)).not.toContain('movie:901');
    expect(out.every((it) => it.backdropPath.startsWith('/'))).toBe(true);
  });
});

describe('En vedette : profil enfant', () => {
  it('aucun titre adulte, et seulement des appels discover avec la classification du pays', async () => {
    const kidPool: Fake[] = [
      ...[1, 2, 3, 4, 5, 6].map((i): Fake => ({ kind: 'movie', raw: movieRaw(300 + i, { genre_ids: [16], certification: 'U' }) })),
      ...[1, 2, 3].map((i): Fake => ({ kind: 'tv', raw: tvRaw(400 + i, { genre_ids: [10762] }) })),
      { kind: 'movie', raw: movieRaw(900, { genre_ids: [27] }) },
      { kind: 'movie', raw: movieRaw(901, { genre_ids: [16], certification: 'R' }) },
      { kind: 'movie', raw: movieRaw(902, { genre_ids: [16], adult: true }) },
      { kind: 'tv', raw: tvRaw(903, { genre_ids: [10762], certification: 'TV-MA' }) },
    ];
    const calls: Call[] = [];
    const out = await featuredItems({
      now: new Date(2026, 9, 3, 9), region: 'FR', profileId: 'kid', isKid: true, kidMaxAge: 10, watched: [], history: [],
      fetch: fakeFetch(kidPool, calls),
    });
    expect(out).toHaveLength(8);
    const adults = ['movie:900', 'movie:901', 'movie:902', 'tv:903'];
    expect(keys(out).some((k) => adults.includes(k))).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.path.startsWith('discover/'))).toBe(true);
    expect(calls.every((c) => c.params.certification_country === 'FR' && c.params['certification.lte'] === '10')).toBe(true);
  });
});

describe('En vedette : sources en échec et repli', () => {
  it('une source qui rejette ne casse pas la sélection', async () => {
    const out = await run(new Date(2026, 9, 3, 9), { fetch: fakeFetch(POOL, [], (p) => p === 'trending/movie/day') });
    expect(out).toHaveLength(8);
  });

  it('toutes les sources rejettent : liste vide, sans exception', async () => {
    await expect(run(new Date(2026, 9, 3, 9), { fetch: async () => { throw new Error('réseau'); } })).resolves.toEqual([]);
  });

  it('pool insuffisant (moins de 4 titres) : liste vide', async () => {
    const tiny: Fake[] = [{ kind: 'movie', raw: movieRaw(1) }, { kind: 'movie', raw: movieRaw(2) }, { kind: 'movie', raw: movieRaw(3) }];
    await expect(run(new Date(2026, 9, 3, 9), { fetch: fakeFetch(tiny, []) })).resolves.toEqual([]);
  });
});

describe('En vedette : filtre de l’accueil', () => {
  it('exclut les titres vus, masqués, aux genres bannis et les séries vues en entier', async () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(['movie:100']));
    hideTitle({ key: 'movie:101', title: 'Film 101', poster: '' });
    setGenreBanned([27], true);
    setSeriesCompleted('tv:200', true);
    const pool: Fake[] = [...POOL, { kind: 'movie', raw: movieRaw(110, { genre_ids: [27] }) }];
    const out = await run(new Date(2026, 9, 3, 9), { fetch: fakeFetch(pool, []), visible: undefined });
    const k = keys(out);
    for (const bad of ['movie:100', 'movie:101', 'movie:110', 'tv:200']) expect(k).not.toContain(bad);
    expect(out).toHaveLength(8);
  });
});

describe('En vedette : région', () => {
  it('passe la région demandée à chaque appel, FR par défaut', async () => {
    const be: Call[] = [];
    await run(new Date(2026, 9, 3, 9), { region: 'BE', preferredGenres: [28], fetch: fakeFetch(POOL, be) });
    expect(be.length).toBeGreaterThan(0);
    expect(be.every((c) => c.params.region === 'BE')).toBe(true);
    expect(be.some((c) => c.path === 'discover/movie' && c.params.with_genres === '28')).toBe(true);

    const fr: Call[] = [];
    await featuredItems({ now: new Date(2026, 9, 3, 9), profileId: 'p1', watched: [], history: [], preferredGenres: [], genreHints: [], fetch: fakeFetch(POOL, fr) });
    expect(fr.length).toBeGreaterThan(0);
    expect(fr.every((c) => c.params.region === 'FR')).toBe(true);
  });
});

describe('En vedette : historique des titres mis en tête', () => {
  it('un titre mis en tête hier sort moins souvent (déterministe, sur 30 jours)', async () => {
    const target = 'movie:105';
    let withHistory = 0;
    let withoutHistory = 0;
    for (let d = 2; d <= 31; d++) {
      const now = new Date(2026, 9, d, 12);
      const yesterday = iso(new Date(2026, 9, d - 1, 12));
      if (keys(await run(now, { history: [{ key: target, at: yesterday }] })).includes(target)) withHistory++;
      if (keys(await run(now, { history: [] })).includes(target)) withoutHistory++;
    }
    expect(withoutHistory).toBeGreaterThan(0);
    expect(withHistory).toBeLessThan(withoutHistory);
  });

  it('un titre mis en tête aujourd’hui ne change pas la sélection du jour, même une fois enregistré', async () => {
    const now = new Date(2026, 9, 12, 9);
    const opts = { now, profileId: 'hist', watched: [], preferredGenres: [], genreHints: [], fetch: fakeFetch(POOL, []) };
    const first = await featuredItems(opts);
    rememberFeatured(first, now, 'hist');
    const again = await featuredItems(opts);
    expect(keys(again)).toEqual(keys(first));
  });

  it('stockage indisponible : l’enregistrement ne lève pas d’exception et la sélection tient', async () => {
    const now = new Date(2026, 9, 12, 9);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const realGet = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k.startsWith('laststream.featured.')) throw new Error('stockage bloqué');
      return realGet.call(this, k);
    });
    expect(() => rememberFeatured([], now, 'x')).not.toThrow();
    const out = await featuredItems({ now, profileId: 'x', watched: [], preferredGenres: [], genreHints: [], fetch: fakeFetch(POOL, []) });
    expect(out).toHaveLength(8);
  });
});

describe('En vedette : séries demandées', () => {
  it('au moins deux séries même quand les films dominent largement le pool', async () => {
    const pool: Fake[] = [
      ...Array.from({ length: 24 }, (_, i): Fake => ({ kind: 'movie', raw: movieRaw(100 + i, { popularity: 5000 + i }) })),
      ...Array.from({ length: 16 }, (_, i): Fake => ({ kind: 'tv', raw: tvRaw(200 + i, { popularity: 1, vote_average: 4, vote_count: 3 }) })),
    ];
    for (let d = 1; d <= 5; d++) {
      const s = keys(await run(new Date(2026, 9, d, 9), { fetch: fakeFetch(pool, []) }));
      expect(s.filter((k) => k.startsWith('tv:')).length).toBeGreaterThanOrEqual(2);
    }
  });
});
