// « En vedette » en collections : génération TMDB simulée (fetch injecté, aucun réseau), tirage quotidien, historique par tuile,
// genres bannis, cache du jour, dossiers du moteur (generatedFolder) et traduction moteur de with_cast / with_crew.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/lt', () => ({
  tmdb: vi.fn(async () => ({ results: [] })),
}));

import { featuredCollections, generatedFolder, rememberFeaturedCollections, type FeaturedCollectionsOptions, type GenTile } from '../src/data/featured';
import { buildRequest, mapFilters, type Source } from '../src/data/collections/engine';
import type { GenreKey } from '../src/data/homeFilters';
import type { WatchedTitle } from '../src/data/watchedHistory';

type Fetch = (path: string, params: Record<string, string>) => Promise<unknown>;
interface Call {
  path: string;
  params: Record<string, string>;
}

const ACTORS = [
  { id: 500, name: 'Tom Cruise', gender: 2 },
  { id: 1245, name: 'Scarlett Johansson', gender: 1 },
  { id: 6193, name: 'Leonardo DiCaprio', gender: 2 },
  { id: 5064, name: 'Meryl Streep', gender: 1 },
];
const DIRECTORS = [
  { id: 525, name: 'Christopher Nolan', gender: 2 },
  { id: 138, name: 'Quentin Tarantino', gender: 2 },
];
const WATCHED: WatchedTitle[] = [
  { key: 'movie:27205', type: 'movie', id: 27205, watched: 1, lastWatchedAt: 1 },
  { key: 'tv:1399', type: 'tv', id: 1399, watched: 3, lastWatchedAt: 2 },
];

/** Film TMDB simulé, avec fond et date passée. */
const film = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Film ${id}`,
  backdrop_path: `/b${id}.jpg`,
  release_date: '2010-05-01',
  genre_ids: [18],
  popularity: 100 - (id % 50),
  vote_count: 800,
  adult: false,
  ...extra,
});
/** Film d'épouvante (genre 27) au fond reconnaissable, très populaire pour apparaître dans les fonds. */
const horror = (id: number): Record<string, unknown> => film(id, { genre_ids: [27], backdrop_path: '/horror.jpg', popularity: 500 });

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100000, 7);

function discoverFilms(params: Record<string, string>): Record<string, unknown>[] {
  const base = 100000 + (hash(JSON.stringify(params)) % 1000) * 10;
  return [film(base), film(base + 1), film(base + 2), film(base + 3, { popularity: 1 }), horror(base + 9)];
}

/** Fiche de personne simulée : films joués, et réalisés (job Director) pour les réalisateurs. */
function personDetails(id: number): Record<string, unknown> {
  const p = [...ACTORS, ...DIRECTORS].find((x) => x.id === id);
  if (!p) return {};
  const films = [film(id * 10 + 1), film(id * 10 + 2), film(id * 10 + 3), horror(id * 10 + 4)];
  return {
    id,
    name: p.name,
    gender: p.gender,
    profile_path: `/p${id}.jpg`,
    movie_credits: { cast: films, crew: films.map((f) => ({ ...f, job: 'Director' })) },
  };
}

const personRow = (p: { id: number; gender: number }, dept: string): Record<string, unknown> => ({
  id: p.id,
  name: `Personne ${p.id}`,
  gender: p.gender,
  profile_path: `/p${p.id}.jpg`,
  known_for_department: dept,
});

/** TMDB simulé : crédits, tendances, personnes, mieux notés et discover. `fail` fait échouer les chemins voulus. */
function fakeTmdb(calls: Call[], fail: (path: string) => boolean = () => false): Fetch {
  return async (path, params) => {
    calls.push({ path, params });
    if (fail(path)) throw new Error('TMDB indisponible');
    if (path === 'trending/person/week') {
      return { results: [...ACTORS.map((p) => personRow(p, 'Acting')), ...DIRECTORS.map((p) => personRow(p, 'Directing'))] };
    }
    if (path === 'person/popular') return { results: ACTORS.slice(0, 2).map((p) => personRow(p, 'Acting')) };
    if (/^(movie|tv)\/\d+\/(credits|aggregate_credits)$/.test(path)) {
      return {
        cast: ACTORS.map((p, i) => ({ id: p.id, name: p.name, gender: p.gender, profile_path: `/p${p.id}.jpg`, order: i })),
        crew: DIRECTORS.map((p) => ({ id: p.id, name: p.name, gender: p.gender, profile_path: `/p${p.id}.jpg`, job: 'Director' })),
      };
    }
    if (path === 'movie/top_rated') return { results: [film(301), film(302), film(303), film(304)] };
    const person = /^person\/(\d+)$/.exec(path);
    if (person) return personDetails(Number(person[1]));
    if (path === 'discover/movie') return { results: discoverFilms(params) };
    return { results: [] };
  };
}

const ids = (tiles: readonly GenTile[]): string[] => tiles.map((t) => t.id);
const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Sélection sans état lu dans le stockage (cache, historique et genres injectés). */
function run(now: Date, extra: FeaturedCollectionsOptions = {}) {
  return featuredCollections({
    now,
    profileId: 'p1',
    region: 'FR',
    watched: WATCHED,
    history: [],
    banned: new Set<GenreKey>(),
    cache: false,
    fetch: fakeTmdb([]),
    ...extra,
  });
}

/** Première source d'un dossier généré (erreur si le dossier n'existe pas). */
async function sourceOf(id: string): Promise<Source> {
  const folder = await generatedFolder(id, fakeTmdb([]));
  if (!folder) throw new Error(`dossier attendu pour ${id}`);
  return folder.sources[0];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('En vedette (collections) : composition', () => {
  it('huit tuiles : deux acteurs, un réalisateur, deux thèmes, un classique, une décennie, une tuile en plus', async () => {
    const out = await run(new Date(2026, 9, 3, 9));
    expect(out).toHaveLength(8);
    expect(new Set(ids(out)).size).toBe(8);
    const count = (k: GenTile['kind']) => out.filter((t) => t.kind === k).length;
    expect(count('classic')).toBe(1);
    expect(count('decade')).toBe(1);
    expect(count('cast')).toBeGreaterThanOrEqual(2);
    expect(count('crew')).toBeGreaterThanOrEqual(1);
    expect(count('keyword')).toBeGreaterThanOrEqual(2);
  });

  it('chaque tuile a de un à trois fonds TMDB, un portrait seulement pour les personnes, un sous-titre de deux ou trois titres', async () => {
    for (const t of await run(new Date(2026, 9, 3, 9))) {
      expect(t.backdrops.length).toBeGreaterThanOrEqual(1);
      expect(t.backdrops.length).toBeLessThanOrEqual(3);
      expect(t.backdrops.every((b) => b.startsWith('https://image.tmdb.org/t/p/w780/'))).toBe(true);
      if (t.kind === 'cast' || t.kind === 'crew') expect(t.portrait).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/h632\/p\d+\.jpg$/);
      else expect(t.portrait).toBeUndefined();
      if (t.subtitle !== undefined) {
        const parts = t.subtitle.split(' · ');
        expect(parts.length).toBeGreaterThanOrEqual(2);
        expect(parts.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('stable dans la journée, change d’un jour à l’autre', async () => {
    const sel: string[][] = [];
    for (let d = 1; d <= 5; d++) sel.push(ids(await run(new Date(2026, 9, d, 9))));
    expect(new Set(sel.map((s) => s.join('|'))).size).toBeGreaterThanOrEqual(3);
    expect(ids(await run(new Date(2026, 9, 1, 22, 30)))).toEqual(sel[0]);
  });

  it('n’appelle que des routes du Worker, avec la région, dans la limite d’environ quinze appels', async () => {
    const calls: Call[] = [];
    await run(new Date(2026, 9, 3, 9), { fetch: fakeTmdb(calls) });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(16);
    for (const c of calls) {
      expect(c.path).toMatch(/^(trending|movie|tv|discover|person)\//);
      expect(c.params.region).toBe('FR');
    }
  });
});

describe('En vedette (collections) : historique et genres bannis', () => {
  it('une décennie mise en tête hier sort moins souvent (déterministe, sur 30 jours)', async () => {
    const target = 'gen-decade-1980';
    let withHistory = 0;
    let withoutHistory = 0;
    for (let d = 2; d <= 31; d++) {
      const now = new Date(2026, 9, d, 12);
      if (ids(await run(now, { history: [{ key: target, at: iso(new Date(2026, 9, d - 1, 12)) }] })).includes(target)) withHistory++;
      if (ids(await run(now)).includes(target)) withoutHistory++;
    }
    expect(withoutHistory).toBeGreaterThan(0);
    expect(withHistory).toBeLessThan(withoutHistory);
  });

  it('genres bannis : ni classique de ce genre, ni fond d’un titre de ce genre', async () => {
    let sawHorror = false;
    for (let d = 1; d <= 5; d++) {
      const out = await run(new Date(2026, 9, d, 9));
      if (out.some((t) => t.backdrops.some((b) => b.includes('/horror.jpg')))) sawHorror = true;
    }
    expect(sawHorror).toBe(true);
    for (let d = 1; d <= 5; d++) {
      const out = await run(new Date(2026, 9, d, 9), { banned: new Set<GenreKey>([27]) });
      expect(ids(out)).not.toContain('gen-classic-27');
      expect(out.every((t) => t.backdrops.every((b) => !b.includes('/horror.jpg')))).toBe(true);
    }
  });
});

describe('En vedette (collections) : repli', () => {
  it('une source qui rejette ne casse pas la sélection', async () => {
    const out = await run(new Date(2026, 9, 3, 9), { fetch: fakeTmdb([], (p) => p.startsWith('trending/')) });
    expect(out).toHaveLength(8);
  });

  it('toutes les sources rejettent : liste vide, sans exception', async () => {
    await expect(run(new Date(2026, 9, 3, 9), { fetch: fakeTmdb([], () => true) })).resolves.toEqual([]);
  });

  it('moins de quatre tuiles : liste vide', async () => {
    const onlyThemes: Fetch = async (path, params) => ({
      results: path === 'discover/movie' && params.with_keywords ? discoverFilms(params) : [],
    });
    await expect(run(new Date(2026, 9, 3, 9), { watched: [], fetch: onlyThemes })).resolves.toEqual([]);
  });
});

describe('En vedette (collections) : cache du jour', () => {
  it('même jour et même profil : aucun nouvel appel ; le lendemain : nouveaux appels ; cache:false : toujours des appels', async () => {
    const first: Call[] = [];
    const a = await featuredCollections({ now: new Date(2026, 9, 3, 9), profileId: 'cache-p', region: 'FR', watched: WATCHED, history: [], fetch: fakeTmdb(first) });
    const second: Call[] = [];
    const b = await featuredCollections({ now: new Date(2026, 9, 3, 18), profileId: 'cache-p', region: 'FR', watched: WATCHED, history: [], fetch: fakeTmdb(second) });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    expect(ids(b)).toEqual(ids(a));
    const next: Call[] = [];
    await featuredCollections({ now: new Date(2026, 9, 4, 9), profileId: 'cache-p', region: 'FR', watched: WATCHED, history: [], fetch: fakeTmdb(next) });
    expect(next.length).toBeGreaterThan(0);
    const forced: Call[] = [];
    await featuredCollections({ now: new Date(2026, 9, 4, 10), profileId: 'cache-p', region: 'FR', watched: WATCHED, history: [], cache: false, fetch: fakeTmdb(forced) });
    expect(forced.length).toBeGreaterThan(0);
  });

  it('même jour : un genre banni ou une région changés refont la sélection', async () => {
    const base = { now: new Date(2026, 9, 5, 9), profileId: 'cache-b', watched: WATCHED, history: [], banned: new Set<number>() } as const;
    await featuredCollections({ ...base, region: 'FR', fetch: fakeTmdb([]) });
    const same: Call[] = [];
    await featuredCollections({ ...base, region: 'FR', fetch: fakeTmdb(same) });
    expect(same).toHaveLength(0);
    const bannedNow: Call[] = [];
    await featuredCollections({ ...base, region: 'FR', banned: new Set([27]), fetch: fakeTmdb(bannedNow) });
    expect(bannedNow.length).toBeGreaterThan(0);
    const otherRegion: Call[] = [];
    await featuredCollections({ ...base, region: 'BE', banned: new Set([27]), fetch: fakeTmdb(otherRegion) });
    expect(otherRegion.length).toBeGreaterThan(0);
  });
});

describe('En vedette (collections) : dossiers du moteur (generatedFolder)', () => {
  it('personne : titre au nom, filmographie par with_cast (acteur) ou with_crew (réalisateur), fond en repli', async () => {
    const cast = await generatedFolder('gen-cast-500', fakeTmdb([]));
    expect(cast?.title).toBe('Tom Cruise');
    expect(cast?.hero).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/w780\//);
    expect(cast?.sources).toEqual([
      { kind: 'DISCOVER', media: 'movie', name: 'Films populaires', sort: 'popularity.desc', filters: { withCast: '500' } },
      { kind: 'DISCOVER', media: 'movie', name: 'Les mieux notés', sort: 'vote_average.desc', filters: { withCast: '500', voteCountGte: 200 } },
    ]);
    const crew = await generatedFolder('gen-crew-525', fakeTmdb([]));
    expect(crew?.title).toBe('Christopher Nolan');
    expect(crew?.sources[0].filters).toEqual({ withCrew: '525' });
  });

  it('thème, classique et décennie : titres et sources discover', async () => {
    const kw = await generatedFolder('gen-kw-10051', fakeTmdb([]));
    expect(kw?.title).toBe('Braquages');
    expect(kw?.sources.map((s) => s.media)).toEqual(['movie', 'tv']);
    expect(kw?.sources.every((s) => s.filters?.withKeywords === '10051')).toBe(true);

    const classic = await generatedFolder('gen-classic-37', fakeTmdb([]));
    expect(classic?.title).toBe('Classiques du western');
    expect(classic?.sources).toEqual([
      {
        kind: 'DISCOVER',
        media: 'movie',
        name: 'Les mieux notés',
        sort: 'vote_average.desc',
        filters: { withGenres: '37', releaseDateLte: '1995-12-31', voteCountGte: 1000 },
      },
    ]);

    const decade = await generatedFolder('gen-decade-1980', fakeTmdb([]));
    expect(decade?.title).toBe('Les années 80');
    expect(decade?.sources[0].filters).toEqual({ releaseDateGte: '1980-01-01', releaseDateLte: '1989-12-31', voteCountGte: 500 });
  });

  it('identifiants invalides ou hors liste : null', async () => {
    const bad = [
      'gen-cast-0',
      'gen-cast-abc',
      'gen-cast-1.5',
      'gen-cast-500 ',
      'gen-cast-999',
      'gen-kw-999999',
      'gen-classic-999',
      'gen-decade-1985',
      'gen-decade-1910',
      'gen-decade-2030',
      'gen-foo-1',
      '',
    ];
    for (const id of bad) {
      expect(await generatedFolder(id, fakeTmdb([])), id).toBeNull();
    }
  });

  it('les sources se traduisent en requêtes discover : dates, votes, tri, with_cast et with_crew', async () => {
    const opts = { region: 'FR', today: '2026-10-03' };
    expect(buildRequest(await sourceOf('gen-cast-500'), 1, opts)?.params).toMatchObject({ with_cast: '500', sort_by: 'popularity.desc' });
    expect(buildRequest(await sourceOf('gen-crew-525'), 1, opts)?.params).toMatchObject({ with_crew: '525' });
    expect(buildRequest(await sourceOf('gen-classic-37'), 1, opts)?.params).toMatchObject({
      with_genres: '37',
      'primary_release_date.lte': '1995-12-31',
      'vote_count.gte': '1000',
      sort_by: 'vote_average.desc',
    });
    expect(buildRequest(await sourceOf('gen-decade-1980'), 1, opts)?.params).toMatchObject({
      'primary_release_date.gte': '1980-01-01',
      'primary_release_date.lte': '1989-12-31',
      'vote_count.gte': '500',
    });
  });

  it('moteur : with_cast et with_crew sortent dans les paramètres discover', () => {
    expect(mapFilters({ withCast: '500' }, 'movie', 'FR', '2026-10-03')).toMatchObject({ with_cast: '500' });
    expect(mapFilters({ withCrew: '525' }, 'movie', 'FR', '2026-10-03')).toMatchObject({ with_crew: '525' });
  });
});

describe('En vedette (collections) : historique par tuile et stockage', () => {
  it('rememberFeaturedCollections enregistre les identifiants des tuiles du jour', async () => {
    const tiles = await run(new Date(2026, 9, 12, 9));
    rememberFeaturedCollections(tiles, new Date(2026, 9, 12, 9), 'hist');
    const raw = JSON.parse(localStorage.getItem('laststream.featured.hist') ?? 'null') as { entries: { key: string }[] };
    expect(raw.entries.map((e) => e.key)).toEqual(ids(tiles));
  });

  it('stockage en écriture indisponible : pas d’exception', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => rememberFeaturedCollections([], new Date(2026, 9, 12, 9), 'x')).not.toThrow();
  });

  it('stockage bloqué en lecture : la sélection tient', async () => {
    const realGet = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k.startsWith('laststream.featured')) throw new Error('stockage bloqué');
      return realGet.call(this, k);
    });
    const out = await featuredCollections({ now: new Date(2026, 9, 12, 9), profileId: 'x', region: 'FR', watched: WATCHED, banned: new Set<GenreKey>(), fetch: fakeTmdb([]) });
    expect(out).toHaveLength(8);
  });
});
