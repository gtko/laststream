/*
 * « En vedette » de l'accueil : huit collections tirées chaque jour depuis TMDB (acteurs et actrices, réalisateurs,
 * thèmes, classiques, décennies). Module sans DOM : seules les routes de la liste blanche du Worker sont appelées
 * (trending, person, movie, tv, discover ; paramètres de TMDB_PUBLIC_PARAMS dans services/core/src/lt/providers.ts).
 * Le rendu est dans src/ui/collections.js ; generatedFolder donne le dossier du moteur (./collections/engine) d'une tuile.
 */
import { tmdb } from './lt';
import { getRegion } from './prefs';
import { bannedGenreIds, type GenreKey } from './homeFilters';
import { userStore } from './userStore';
import type { WatchedTitle } from './watchedHistory';
import type { Folder, Source, SourceFilters } from './collections/engine';
import { pad2 } from './format';

type GenKind = 'cast' | 'crew' | 'keyword' | 'classic' | 'decade';

/** Tuile de « En vedette » : une collection générée depuis TMDB. */
export interface GenTile {
  /** `gen-cast-500`, `gen-crew-525`, `gen-kw-10051`, `gen-classic-37`, `gen-decade-1980`. */
  id: string;
  kind: GenKind;
  title: string;
  kicker: string;
  /** Personnes seulement : portrait TMDB (h632). */
  portrait?: string;
  /** Un à trois fonds TMDB (w780). */
  backdrops: string[];
  /** Deux ou trois titres connus, séparés par « · ». */
  subtitle?: string;
}

export interface FeaturedCollectionsOptions {
  now?: Date;
  profileId?: string;
  /** Région TMDB (par défaut la région des réglages, FR sinon). */
  region?: string;
  /** Requête TMDB (par défaut `tmdb()` de lt.ts). */
  fetch?: (path: string, params: Record<string, string>) => Promise<unknown>;
  /** Tuiles déjà mises en tête (par défaut : historique stocké du profil). */
  history?: readonly { key: string; at: string }[];
  /** Titres vus (par défaut : `userStore.watchedTitles()`). */
  watched?: readonly WatchedTitle[];
  /** Genres bannis (par défaut ceux des réglages du profil). */
  banned?: ReadonlySet<GenreKey>;
  /** Cache du jour par profil (défaut true). */
  cache?: boolean;
}

type Fetch = (path: string, params: Record<string, string>) => Promise<unknown>;

interface Candidate {
  tile: GenTile;
  w: number;
}

interface Film {
  id: number;
  title: string;
  backdrop: string;
  popularity: number;
  votes: number;
}

interface HistoryEntry {
  key: string;
  /** Jour local de la mise en tête (AAAA-MM-JJ). */
  at: string;
}

interface Visuals {
  backdrops: string[];
  subtitle?: string;
}

/** Tuiles affichées dans « En vedette ». */
const TILE_COUNT = 8;
/** En dessous de ce nombre de tuiles, rien n'est proposé et l'appelant replie. */
const MIN_TILES = 4;
/** Tirages de personnes et de thèmes : le quota plus une réserve, au cas où un appel échoue. */
const ACTOR_FETCH = 3;
const DIRECTOR_FETCH = 2;
const THEME_FETCH = 3;
/** Repli réalisateur : trois films tirés parmi la page de movie/top_rated (pages 1 à 3). */
const TOP_RATED_PAGES = 3;
const TOP_RATED_SAMPLE = 3;
/** Poids de base d'une personne, plus le nombre de titres vus où elle apparaît et son poids dans les listes TMDB. */
const PERSON_BASE = 0.2;
/** Un thème, un classique ou une décennie mis en tête depuis moins de 14 jours perd presque toute sa chance. */
const HISTORY_DAYS = 14;
const RECENT_PENALTY = 0.5;
const MIN_WEIGHT = 0.05;
/** Entrées gardées par profil (14 jours à 8 tuiles par jour, avec marge). */
const HISTORY_MAX = 160;
const HISTORY_PREFIX = 'laststream.featured.';
const CACHE_PREFIX = 'laststream.featured.cols.';
/** Derniers titres vus interrogés pour trouver des acteurs et réalisateurs. */
const WATCHED_SAMPLE = 4;
/** Rang maximal (exclu) d'un acteur dans un crédit : les six premiers. */
const CAST_ORDER_MAX = 6;
/** Fonds et titres par tuile. */
const BACKDROPS = 3;
const MIN_VOTES_PERSON = 50;
const IMG = 'https://image.tmdb.org/t/p/';
const DAY_MS = 864e5;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const GEN_ID = /^gen-(cast|crew|kw|classic|decade)-(\d+)$/;
const PERSON_PARAMS: Record<string, string> = { append_to_response: 'movie_credits' };

/** Mots-clés TMDB (identifiant, libellé), chacun vérifié sur themoviedb.org/keyword/<id>. */
const THEMES: ReadonlyArray<readonly [number, string]> = [
  [10051, 'Braquages'],
  [4379, 'Voyage dans le temps'],
  [4565, 'Dystopie'],
  [10714, 'Tueurs en série'],
  [9672, 'Histoires vraies'],
  [12377, 'Zombies'],
  [9882, 'Espace'],
  [9748, 'Vengeance'],
  [7312, 'Road movies'],
  [310, 'Intelligence artificielle'],
  [9715, 'Super-héros'],
  [6075, 'Sport'],
  [1299, 'Monstres'],
  [33722, 'Affaires criminelles'],
];

/** Genres de films TMDB (identifiant, libellé des classiques). */
const CLASSIC_GENRES: ReadonlyArray<readonly [number, string]> = [
  [28, 'Classiques de l’action'],
  [12, 'Classiques de l’aventure'],
  [16, 'Classiques de l’animation'],
  [35, 'Classiques de la comédie'],
  [80, 'Classiques du polar'],
  [18, 'Classiques du drame'],
  [14, 'Classiques du fantastique'],
  [27, 'Classiques de l’horreur'],
  [9648, 'Classiques du mystère'],
  [10749, 'Classiques romantiques'],
  [878, 'Classiques de science-fiction'],
  [53, 'Classiques du thriller'],
  [10752, 'Classiques de guerre'],
  [37, 'Classiques du western'],
];

/** Débuts de décennie proposés chaque jour. */
const DECADES: readonly number[] = [1950, 1960, 1970, 1980, 1990];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Liste contenue dans un objet TMDB (`results`, `cast`…) ; vide si absente. */
const listOf = (v: unknown, key: string): unknown[] => (isRecord(v) && Array.isArray(v[key]) ? (v[key] as unknown[]) : []);
const bump = (m: Map<number, number>, id: number, n: number): void => {
  m.set(id, (m.get(id) ?? 0) + n);
};
const isEntry = (v: unknown): v is HistoryEntry => isRecord(v) && typeof v.key === 'string' && typeof v.at === 'string';
const isGenTile = (v: unknown): v is GenTile =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.kind === 'string' &&
  typeof v.title === 'string' &&
  typeof v.kicker === 'string' &&
  Array.isArray(v.backdrops) &&
  v.backdrops.length > 0;

/** Date locale AAAA-MM-JJ. */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Nombre de jours de `from` à `to` (deux dates AAAA-MM-JJ). */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
}

/** Entier 32 bits (FNV-1a) pour une chaîne. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Générateur déterministe (mulberry32) : même graine, même suite. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Graine du tirage : jour local (yyyymmdd) et profil. Stable dans la journée, différente d'un jour à l'autre. */
const drawSeed = (today: string, profileId: string): number => (hash32(profileId) ^ Math.imul(Number(today.replaceAll('-', '')), 0x9e3779b1)) >>> 0;

/** Tirage pondéré sans remise : `n` éléments (ou moins si le pool est plus petit). */
function drawWeighted<T extends { w: number }>(pool: readonly T[], n: number, rnd: () => number): T[] {
  const left = [...pool];
  const out: T[] = [];
  while (out.length < n && left.length > 0) {
    const total = left.reduce((sum, x) => sum + x.w, 0);
    let x = rnd() * total;
    let idx = left.length - 1;
    for (let i = 0; i < left.length; i++) {
      x -= left[i].w;
      if (x < 0) {
        idx = i;
        break;
      }
    }
    out.push(...left.splice(idx, 1));
  }
  return out;
}

/** Attend toutes les requêtes ; une requête en échec donne null. */
const settleAll = (ps: Promise<unknown>[]): Promise<unknown[]> =>
  Promise.allSettled(ps).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));

function currentProfileId(): string {
  try {
    return userStore.currentProfile().id || 'default';
  } catch {
    return 'default';
  }
}

function defaultRegion(): string {
  try {
    return getRegion().code || 'FR';
  } catch {
    return 'FR';
  }
}

function safeWatched(): readonly WatchedTitle[] {
  try {
    return userStore.watchedTitles();
  } catch {
    return [];
  }
}

/** Tuiles mises en tête pour ce profil (localStorage) ; liste vide si le stockage est indisponible ou corrompu. */
function readFeaturedHistory(profileId: string): HistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_PREFIX + profileId) ?? 'null');
    const entries: unknown[] = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
    return entries.filter(isEntry).slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Identifiants mis en tête dans les 14 derniers jours, hors aujourd'hui : la sélection d'un jour ne dépend pas de ce qui a été affiché ce jour-là. */
function recentKeys(history: readonly HistoryEntry[], today: string): Set<string> {
  const out = new Set<string>();
  for (const h of history) {
    if (!ISO_DAY.test(h.at)) continue;
    const ago = daysBetween(h.at, today);
    if (ago >= 1 && ago <= HISTORY_DAYS) out.add(h.key);
  }
  return out;
}

/** Enregistre les tuiles mises en tête aujourd'hui (remplace celles de la même journée). Sans effet si le stockage est indisponible. */
export function rememberFeaturedCollections(tiles: readonly GenTile[], now: Date = new Date(), profileId: string = currentProfileId()): void {
  try {
    const today = localIso(now);
    const kept = readFeaturedHistory(profileId).filter((h) => h.at !== today);
    const entries = [...kept, ...tiles.map((t) => ({ key: t.id, at: today }))].slice(-HISTORY_MAX);
    localStorage.setItem(HISTORY_PREFIX + profileId, JSON.stringify({ v: 1, entries }));
  } catch {
    /* stockage indisponible : pas de pénalité d'historique, la sélection reste valable */
  }
}

/** Tuiles du jour pour ce profil (cache localStorage par jour), ou null. */
function readCache(profileId: string, today: string): GenTile[] | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CACHE_PREFIX + profileId) ?? 'null');
    if (!isRecord(raw) || raw.day !== today || !Array.isArray(raw.tiles)) return null;
    const tiles = raw.tiles.filter(isGenTile);
    return tiles.length >= MIN_TILES ? tiles : null;
  } catch {
    return null;
  }
}

function writeCache(profileId: string, today: string, tiles: readonly GenTile[]): void {
  try {
    localStorage.setItem(CACHE_PREFIX + profileId, JSON.stringify({ day: today, tiles }));
  } catch {
    /* stockage indisponible : pas de cache, la sélection est refaite au prochain appel */
  }
}

/** Film utilisable : fond, titre, sorti, non adulte, sans genre banni. */
function toFilm(raw: unknown, today: string, banned: ReadonlySet<GenreKey>): Film | null {
  if (!isRecord(raw) || raw.adult === true) return null;
  const id = raw.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  const backdrop = str(raw.backdrop_path);
  const title = str(raw.title) || str(raw.original_title);
  const date = str(raw.release_date).slice(0, 10);
  if (!backdrop || !title || !ISO_DAY.test(date) || date > today) return null;
  const genres: unknown[] = Array.isArray(raw.genre_ids) ? raw.genre_ids : [];
  if (genres.some((g) => typeof g === 'number' && banned.has(g))) return null;
  return { id, title, backdrop, popularity: num(raw.popularity), votes: num(raw.vote_count) };
}

/** Films d'une réponse de liste (`results`), dans l'ordre de TMDB. */
const filmsIn = (json: unknown, today: string, banned: ReadonlySet<GenreKey>): Film[] =>
  listOf(json, 'results').flatMap((r) => {
    const f = toFilm(r, today, banned);
    return f ? [f] : [];
  });

/** Filmographie d'une personne : films joués (cast) ou réalisés (crew, job Director), la plus populaire d'abord. */
function personFilms(json: unknown, role: 'cast' | 'crew', today: string, banned: ReadonlySet<GenreKey>): Film[] {
  const credits = isRecord(json) ? json.movie_credits : null;
  const rows = role === 'cast' ? listOf(credits, 'cast') : listOf(credits, 'crew').filter((c) => isRecord(c) && c.job === 'Director');
  return rows
    .flatMap((r) => {
      const f = toFilm(r, today, banned);
      return f ? [f] : [];
    })
    .sort((a, b) => b.popularity - a.popularity);
}

/** Fonds (w780) et sous-titre (deux ou trois titres) d'une tuile ; null sans fond. */
function visualsOf(films: readonly Film[]): Visuals | null {
  const top = films.slice(0, BACKDROPS);
  if (top.length === 0) return null;
  const out: Visuals = { backdrops: top.map((f) => `${IMG}w780${f.backdrop}`) };
  if (top.length >= 2) out.subtitle = top.map((f) => f.title).join(' · ');
  return out;
}

/** Acteurs (rang inférieur à six) et réalisateurs ou créateurs d'un crédit, comptés par titre. */
function addCredits(json: unknown, actors: Map<number, number>, directors: Map<number, number>): void {
  for (const c of listOf(json, 'cast')) {
    if (isRecord(c) && typeof c.id === 'number' && typeof c.order === 'number' && c.order < CAST_ORDER_MAX) bump(actors, c.id, 1);
  }
  for (const c of listOf(json, 'crew')) {
    if (!isRecord(c) || typeof c.id !== 'number') continue;
    const jobs: unknown[] = [c.job, ...listOf(c, 'jobs').map((j) => (isRecord(j) ? j.job : null))];
    if (jobs.some((j) => j === 'Director' || j === 'Creator')) bump(directors, c.id, 1);
  }
}

/** Personnes des listes de popularité TMDB, selon leur département. */
function addPopular(json: unknown, actors: Map<number, number>, directors: Map<number, number>): void {
  for (const p of listOf(json, 'results')) {
    if (!isRecord(p) || typeof p.id !== 'number') continue;
    if (p.known_for_department === 'Acting') bump(actors, p.id, 0.5);
    else if (p.known_for_department === 'Directing') bump(directors, p.id, 0.5);
  }
}

function personTile(kind: 'cast' | 'crew', json: unknown, today: string, banned: ReadonlySet<GenreKey>): GenTile | null {
  if (!isRecord(json) || typeof json.id !== 'number') return null;
  const id = json.id;
  const name = str(json.name);
  const profile = str(json.profile_path);
  if (!name || !profile) return null;
  const visuals = visualsOf(personFilms(json, kind, today, banned).filter((f) => f.votes >= MIN_VOTES_PERSON));
  if (!visuals) return null;
  const female = num(json.gender) === 1;
  const kicker = kind === 'cast' ? (female ? 'Actrice' : 'Acteur') : female ? 'Réalisatrice' : 'Réalisateur';
  return { id: `gen-${kind}-${id}`, kind, title: name, kicker, portrait: `${IMG}h632${profile}`, ...visuals };
}

function themeTile(id: number, label: string, json: unknown, today: string, banned: ReadonlySet<GenreKey>): GenTile | null {
  const visuals = visualsOf(filmsIn(json, today, banned));
  return visuals ? { id: `gen-kw-${id}`, kind: 'keyword', title: label, kicker: 'Thème', ...visuals } : null;
}

function classicTile(genre: number, label: string, json: unknown, today: string, banned: ReadonlySet<GenreKey>): GenTile | null {
  const visuals = visualsOf(filmsIn(json, today, banned));
  return visuals ? { id: `gen-classic-${genre}`, kind: 'classic', title: label, kicker: 'Classique', ...visuals } : null;
}

const decadeTitle = (y: number): string => `Les années ${y < 2000 ? y % 100 : y}`;

function decadeTile(year: number, json: unknown, today: string, banned: ReadonlySet<GenreKey>): GenTile | null {
  const visuals = visualsOf(filmsIn(json, today, banned));
  return visuals ? { id: `gen-decade-${year}`, kind: 'decade', title: decadeTitle(year), kicker: 'Décennie', ...visuals } : null;
}

const themeQuery = (id: number): Record<string, string> => ({
  with_keywords: String(id),
  sort_by: 'popularity.desc',
  'vote_count.gte': '300',
  include_adult: 'false',
});

const classicQuery = (genre: number): Record<string, string> => ({
  with_genres: String(genre),
  'primary_release_date.lte': '1995-12-31',
  'vote_count.gte': '1000',
  sort_by: 'vote_average.desc',
  include_adult: 'false',
});

const decadeQuery = (year: number): Record<string, string> => ({
  'primary_release_date.gte': `${year}-01-01`,
  'primary_release_date.lte': `${year + 9}-12-31`,
  'vote_count.gte': '500',
  sort_by: 'popularity.desc',
  include_adult: 'false',
});

/** Crée les tuiles du jour pour ce profil, dans l'ordre d'affichage. Liste vide si moins de 4 tuiles ou si toutes les sources échouent. Ne lève jamais d'exception. */
export async function featuredCollections(opts: FeaturedCollectionsOptions = {}): Promise<GenTile[]> {
  try {
    const now = opts.now ?? new Date();
    const today = localIso(now);
    const profileId = opts.profileId ?? currentProfileId();
    if (opts.cache !== false) {
      const cached = readCache(profileId, today);
      if (cached) return cached;
    }
    const region = opts.region ?? defaultRegion();
    const fetchFn: Fetch = opts.fetch ?? tmdb;
    const banned: ReadonlySet<GenreKey> = opts.banned ?? bannedGenreIds();
    const watched: readonly WatchedTitle[] = opts.watched ?? safeWatched();
    const recent = recentKeys(opts.history ?? readFeaturedHistory(profileId), today);
    const weigh = (base: number, id: string): number => Math.max(MIN_WEIGHT, recent.has(id) ? base - RECENT_PENALTY : base);
    /** Requête TMDB ; une erreur donne null, jamais une exception. */
    const get = (path: string, params: Record<string, string> = {}): Promise<unknown> =>
      Promise.resolve()
        .then(() => fetchFn(path, { region, ...params }))
        .catch(() => null);

    // Tirages synchrones, dans un ordre fixe : même jour, même profil, même historique, même tirage.
    const rnd = mulberry32(drawSeed(today, profileId));
    const themeDraw = drawWeighted(
      THEMES.map(([id, label]) => ({ id, label, w: weigh(1, `gen-kw-${id}`) })),
      THEME_FETCH,
      rnd,
    );
    const classicDraw = drawWeighted(
      CLASSIC_GENRES.filter(([g]) => !banned.has(g)).map(([g, label]) => ({ g, label, w: weigh(1, `gen-classic-${g}`) })),
      1,
      rnd,
    );
    const decadeDraw = drawWeighted(
      DECADES.map((y) => ({ y, w: weigh(1, `gen-decade-${y}`) })),
      1,
      rnd,
    );

    // Étape 1 : crédits des derniers titres vus, listes de popularité, thèmes, classique, décennie.
    const recentWatched = [...watched].sort((a, b) => a.lastWatchedAt - b.lastWatchedAt).slice(-WATCHED_SAMPLE);
    const [credits, lists, themes, classics, decades] = await Promise.all([
      settleAll(recentWatched.map((t) => get(t.type === 'movie' ? `movie/${t.id}/credits` : `tv/${t.id}/aggregate_credits`))),
      settleAll([get('trending/person/week'), get('person/popular')]),
      settleAll(themeDraw.map((t) => get('discover/movie', themeQuery(t.id)))),
      settleAll(classicDraw.map((c) => get('discover/movie', classicQuery(c.g)))),
      settleAll(decadeDraw.map((d) => get('discover/movie', decadeQuery(d.y)))),
    ]);

    const actors = new Map<number, number>();
    const directors = new Map<number, number>();
    credits.forEach((j) => addCredits(j, actors, directors));
    lists.forEach((j) => addPopular(j, actors, directors));

    // Repli : sans aucun réalisateur, on prend les réalisateurs de trois films tirés parmi les mieux notés.
    if (directors.size === 0) {
      const page = 1 + Math.floor(rnd() * TOP_RATED_PAGES);
      const top = await get('movie/top_rated', { page: String(page) });
      const ids = drawWeighted(
        listOf(top, 'results').flatMap((r) => (isRecord(r) && typeof r.id === 'number' ? [{ id: r.id, w: 1 }] : [])),
        TOP_RATED_SAMPLE,
        rnd,
      );
      (await settleAll(ids.map((x) => get(`movie/${x.id}/credits`)))).forEach((j) => addCredits(j, new Map(), directors));
    }

    // Étape 2 : tirage des personnes, puis leur fiche et leur filmographie.
    const actorDraw = drawWeighted(
      [...actors].map(([id, s]) => ({ id, w: weigh(PERSON_BASE + s, `gen-cast-${id}`) })),
      ACTOR_FETCH,
      rnd,
    );
    const drawnActors = new Set(actorDraw.map((a) => a.id));
    const directorDraw = drawWeighted(
      [...directors].filter(([id]) => !drawnActors.has(id)).map(([id, s]) => ({ id, w: weigh(PERSON_BASE + s, `gen-crew-${id}`) })),
      DIRECTOR_FETCH,
      rnd,
    );
    const [actorJson, directorJson] = await Promise.all([
      settleAll(actorDraw.map((a) => get(`person/${a.id}`, PERSON_PARAMS))),
      settleAll(directorDraw.map((d) => get(`person/${d.id}`, PERSON_PARAMS))),
    ]);

    // Étape 3 : tuiles de chaque catégorie, puis composition.
    const pool: Candidate[] = [];
    actorDraw.forEach((a, i) => {
      const tile = personTile('cast', actorJson[i], today, banned);
      if (tile) pool.push({ tile, w: a.w });
    });
    directorDraw.forEach((d, i) => {
      const tile = personTile('crew', directorJson[i], today, banned);
      if (tile) pool.push({ tile, w: d.w });
    });
    themeDraw.forEach((t, i) => {
      const tile = themeTile(t.id, t.label, themes[i], today, banned);
      if (tile) pool.push({ tile, w: t.w });
    });
    classicDraw.forEach((c, i) => {
      const tile = classicTile(c.g, c.label, classics[i], today, banned);
      if (tile) pool.push({ tile, w: c.w });
    });
    decadeDraw.forEach((d, i) => {
      const tile = decadeTile(d.y, decades[i], today, banned);
      if (tile) pool.push({ tile, w: d.w });
    });

    // Deux acteurs, un réalisateur, un classique, deux thèmes, une décennie ; le reste (une tuile) tiré parmi les réserves.
    const quotas: ReadonlyArray<readonly [GenKind, number]> = [
      ['cast', 2],
      ['crew', 1],
      ['classic', 1],
      ['keyword', 2],
      ['decade', 1],
    ];
    const picked: Candidate[] = quotas.flatMap(([kind, n]) => pool.filter((c) => c.tile.kind === kind).slice(0, n));
    const spare = pool.filter((c) => !picked.includes(c));
    if (picked.length < TILE_COUNT) picked.push(...drawWeighted(spare, TILE_COUNT - picked.length, rnd));
    if (picked.length < MIN_TILES) return [];

    // Ordre d'affichage : tirage, pour que les catégories ne soient pas toujours dans le même ordre.
    const tiles = drawWeighted(
      picked.map((c) => ({ w: 1, tile: c.tile })),
      picked.length,
      rnd,
    ).map((c) => c.tile);
    if (opts.cache !== false) writeCache(profileId, today, tiles);
    return tiles;
  } catch {
    return [];
  }
}

/** Dossier de moteur d'une tuile (`gen-cast-500`…) ; null si l'identifiant est invalide ou hors liste. */
const folderOf = (id: string, title: string, sources: Source[], backdrop: string | undefined): Folder => ({
  id,
  title,
  sources,
  ...(backdrop ? { hero: `${IMG}w780${backdrop}` } : {}),
});

export async function generatedFolder(id: string, fetch: Fetch = tmdb): Promise<Folder | null> {
  const m = GEN_ID.exec(id);
  if (!m) return null;
  const [, kind = '', digits = ''] = m;
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  try {
    const region = defaultRegion();
    const today = localIso(new Date());
    const banned = bannedGenreIds();
    const get = (path: string, params: Record<string, string> = {}): Promise<unknown> =>
      Promise.resolve()
        .then(() => fetch(path, { region, ...params }))
        .catch(() => null);

    if (kind === 'cast' || kind === 'crew') {
      const json = await get(`person/${n}`, PERSON_PARAMS);
      const name = isRecord(json) ? str(json.name) : '';
      if (!name) return null;
      const filters: SourceFilters = kind === 'cast' ? { withCast: String(n) } : { withCrew: String(n) };
      return folderOf(
        id,
        name,
        [
          { kind: 'DISCOVER', media: 'movie', name: 'Films populaires', sort: 'popularity.desc', filters },
          { kind: 'DISCOVER', media: 'movie', name: 'Les mieux notés', sort: 'vote_average.desc', filters: { ...filters, voteCountGte: 200 } },
        ],
        personFilms(json, kind, today, banned)[0]?.backdrop,
      );
    }
    if (kind === 'kw') {
      const theme = THEMES.find(([k]) => k === n);
      if (!theme) return null;
      const backdrop = filmsIn(await get('discover/movie', themeQuery(n)), today, banned)[0]?.backdrop;
      const filters: SourceFilters = { withKeywords: String(n) };
      return folderOf(
        id,
        theme[1],
        [
          { kind: 'DISCOVER', media: 'movie', name: 'Films', sort: 'popularity.desc', filters },
          { kind: 'DISCOVER', media: 'tv', name: 'Séries', sort: 'popularity.desc', filters },
        ],
        backdrop,
      );
    }
    if (kind === 'classic') {
      const genre = CLASSIC_GENRES.find(([g]) => g === n);
      if (!genre) return null;
      const backdrop = filmsIn(await get('discover/movie', classicQuery(n)), today, banned)[0]?.backdrop;
      return folderOf(
        id,
        genre[1],
        [
          {
            kind: 'DISCOVER',
            media: 'movie',
            name: 'Les mieux notés',
            sort: 'vote_average.desc',
            filters: { withGenres: String(n), releaseDateLte: '1995-12-31', voteCountGte: 1000 },
          },
        ],
        backdrop,
      );
    }
    if (kind === 'decade' && n % 10 === 0 && n >= 1920 && n <= 2020) {
      const backdrop = filmsIn(await get('discover/movie', decadeQuery(n)), today, banned)[0]?.backdrop;
      return folderOf(
        id,
        decadeTitle(n),
        [
          {
            kind: 'DISCOVER',
            media: 'movie',
            name: 'Films populaires',
            sort: 'popularity.desc',
            filters: { releaseDateGte: `${n}-01-01`, releaseDateLte: `${n + 9}-12-31`, voteCountGte: 500 },
          },
        ],
        backdrop,
      );
    }
    return null;
  } catch {
    return null;
  }
}
