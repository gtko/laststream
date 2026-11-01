/*
 * « En vedette » de l'accueil : huit titres tirés chaque jour dans un pool construit depuis TMDB (tendances, sorties de la
 * semaine, populaires, genres préférés du profil). Module sans DOM ni backend : seules les routes TMDB de la liste blanche
 * du Worker sont appelées (chemins trending|movie|tv|discover, paramètres de TMDB_PUBLIC_PARAMS dans
 * lastaddon/src/lt/providers.ts). Le rendu est dans src/ui/collections.js.
 */
import { tmdb } from './lt';
import { getRegion } from './prefs';
import { bannedGenreIds, keepVisible, type GenreKey, type HomeItemLike } from './homeFilters';
import { userStore } from './userStore';
import type { WatchedTitle } from './watchedHistory';
import { kidAllows, kidGenreOk } from './kid';
import { kidBase, makeCtx, type RowCtx } from './rows';
import { pad2 } from './format';

/** Titres affichés dans « En vedette ». */
const FEATURED_COUNT = 8;
/** Pool minimal après filtres : en dessous, rien n'est proposé et l'appelant replie. */
const MIN_POOL = 4;
/** Séries demandées d'abord, si le pool en compte assez. */
const MIN_SERIES = 2;
/** Un titre mis en tête depuis moins de 14 jours perd presque toute sa chance. */
const HISTORY_DAYS = 14;
/** Entrées gardées par profil (environ 7 jours à 8 titres par jour). */
const HISTORY_MAX = 60;
const HISTORY_PREFIX = 'laststream.featured.';
const NEW_DAYS = 30;
const WEEK_DAYS = 7;
const TOP_GENRES = 2;
const MIN_WEIGHT = 0.05;
/** Genres « bruit » : actualités, talk-shows, téléréalité (exclus des séries, jamais comptés comme goût). */
const NOISE_IDS: ReadonlySet<number> = new Set([10763, 10764, 10767]);
const NOISE_GENRES = '10763,10767,10764';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 864e5;
/** Paramètres communs des listes TMDB « populaires » (liste blanche du Worker). */
const POPULAR = { sort_by: 'popularity.desc', include_adult: 'false' };

export type FeaturedType = 'movie' | 'tv';

/** Titre du pool, normalisé : champs lus par le filtre de l'accueil et par la tuile. */
export interface FeaturedItem extends HomeItemLike {
  key: string;
  type: FeaturedType;
  id: number;
  name: string;
  /** Chemin TMDB du fond (backdrop) : obligatoire, sans fond le titre n'est pas proposé. */
  backdropPath: string;
  /** Date de sortie ou de première diffusion (AAAA-MM-JJ). */
  date: string;
  genreIds: number[];
  originalLanguage: string;
  originCountry: string[];
  popularity: number;
  vote: number;
  votes: number;
  /** Classification, si la source la donne (les listes TMDB ne la donnent pas). */
  certification: string;
}

export interface FeaturedHistoryEntry {
  key: string;
  /** Jour local de la mise en tête (AAAA-MM-JJ). */
  at: string;
}

export interface FeaturedOptions {
  now?: Date;
  profileId?: string;
  /** Région TMDB (par défaut la région des réglages, FR sinon). */
  region?: string;
  isKid?: boolean;
  kidMaxAge?: number | null;
  /** Requête TMDB (par défaut `tmdb()` de lt.ts). */
  fetch?: (path: string, params: Record<string, string>) => Promise<unknown>;
  /** Filtre de l'accueil (par défaut `keepVisible` : vus, masqués, genres bannis). */
  visible?: (items: FeaturedItem[]) => FeaturedItem[];
  /** Titres déjà mis en tête (par défaut : historique stocké du profil). */
  history?: readonly FeaturedHistoryEntry[];
  /** Titres vus (par défaut : `userStore.watchedTitles()`). */
  watched?: readonly WatchedTitle[];
  /** Titres dont le genre est connu (ex. `state.byKey`) : sert à deviner les genres préférés. */
  genreHints?: ReadonlyArray<{ key: string; genreIds?: readonly number[] }>;
  /** Genres préférés imposés (sinon déduits de `watched` et `genreHints`). */
  preferredGenres?: readonly number[];
  /** Genres bannis (par défaut ceux des réglages du profil). */
  banned?: ReadonlySet<GenreKey>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isEntry = (v: unknown): v is FeaturedHistoryEntry => isRecord(v) && typeof v.key === 'string' && typeof v.at === 'string';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Date locale AAAA-MM-JJ. */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Nombre de jours de `from` à `to` (deux dates AAAA-MM-JJ). */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Résultat TMDB brut -> titre du pool ; null si identifiant, nom, fond ou date manquent, ou si le titre est adulte. */
function toFeatured(raw: unknown, type: FeaturedType): FeaturedItem | null {
  if (!isRecord(raw) || raw.adult === true) return null;
  const id = raw.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  const name = str(raw.title) || str(raw.name) || str(raw.original_title) || str(raw.original_name);
  const backdropPath = str(raw.backdrop_path);
  const date = (str(raw.release_date) || str(raw.first_air_date)).slice(0, 10);
  if (!name || !backdropPath || !ISO_DAY.test(date)) return null;
  const genreIds = Array.isArray(raw.genre_ids) ? raw.genre_ids.filter((g): g is number => typeof g === 'number') : [];
  const originCountry = Array.isArray(raw.origin_country) ? raw.origin_country.filter((c): c is string => typeof c === 'string') : [];
  return {
    key: `${type}:${id}`,
    id,
    type,
    name,
    backdropPath,
    date,
    genreIds,
    originalLanguage: str(raw.original_language),
    originCountry,
    popularity: num(raw.popularity),
    vote: num(raw.vote_average),
    votes: num(raw.vote_count),
    certification: str(raw.certification),
  };
}

interface Source {
  path: string;
  type: FeaturedType;
  params: Record<string, string>;
}

/** Sources d'un profil adulte : tendances, sorties, populaires et, par genre préféré, un discover films et un discover séries. */
function adultSources(region: string, today: string, genres: readonly number[]): Source[] {
  // Disponibilité dans la région (fournisseur, gratuit, location ou achat), comme les rangées de rows.ts.
  const available = { watch_region: region, with_watch_monetization_types: 'flatrate|free|ads|rent|buy' };
  const sources: Source[] = [
    { path: 'trending/movie/day', type: 'movie', params: {} },
    { path: 'trending/tv/week', type: 'tv', params: {} },
    { path: 'movie/now_playing', type: 'movie', params: {} },
    { path: 'movie/popular', type: 'movie', params: {} },
    { path: 'tv/popular', type: 'tv', params: {} },
    // Sorties de la semaine : sans filtre de fournisseur (une sortie récente n'est pas encore louable).
    { path: 'discover/movie', type: 'movie', params: { ...POPULAR, 'primary_release_date.gte': addDays(today, -WEEK_DAYS), 'primary_release_date.lte': today } },
  ];
  for (const g of genres) {
    sources.push({ path: 'discover/movie', type: 'movie', params: { ...POPULAR, ...available, with_genres: String(g), 'vote_count.gte': '200', 'primary_release_date.lte': today } });
    sources.push({ path: 'discover/tv', type: 'tv', params: { ...POPULAR, ...available, with_genres: String(g), without_genres: NOISE_GENRES, 'vote_count.gte': '100', 'first_air_date.lte': today } });
  }
  return sources;
}

/** Sources d'un profil enfant : discover seulement, avec la classification du pays et les genres jeunesse (rows.ts). */
function kidSources(ctx: RowCtx): Source[] {
  return [
    { path: 'discover/movie', type: 'movie', params: kidBase(ctx, 'movie') },
    { path: 'discover/tv', type: 'tv', params: kidBase(ctx, 'tv') },
    { path: 'discover/movie', type: 'movie', params: kidBase(ctx, 'movie', '16') },
    { path: 'discover/movie', type: 'movie', params: kidBase(ctx, 'movie', '10751') },
    { path: 'discover/tv', type: 'tv', params: kidBase(ctx, 'tv', '10762') },
  ];
}

/** Adulte uniquement : un titre enfant doit aussi avoir un genre jeunesse et, si la classification est connue, être permis. */
function kidOk(it: FeaturedItem, maxAge: number): boolean {
  return kidGenreOk(it.genreIds) && (it.certification === '' || kidAllows(it.certification, maxAge));
}

/**
 * Genres préférés : les deux genres les plus présents parmi les titres vus dont le genre est connu (`genreHints`).
 * Les genres bannis et les genres « bruit » sont exclus. Liste vide si rien n'est connu.
 */
function preferredGenresOf(watched: readonly WatchedTitle[], hints: ReadonlyArray<{ key: string; genreIds?: readonly number[] }>, banned: ReadonlySet<GenreKey>): number[] {
  const genresByKey = new Map<string, readonly number[]>(hints.map((h): [string, readonly number[]] => [h.key, h.genreIds ?? []]));
  const count = new Map<number, number>();
  for (const w of watched) {
    for (const g of genresByKey.get(w.key) ?? []) {
      if (banned.has(g) || NOISE_IDS.has(g)) continue;
      count.set(g, (count.get(g) ?? 0) + 1);
    }
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, TOP_GENRES).map(([g]) => g);
}

/** Clés mises en tête dans les 14 derniers jours, hors aujourd'hui : la sélection d'un jour ne dépend pas de ce qui a été affiché ce jour-là. */
function recentKeys(history: readonly FeaturedHistoryEntry[], today: string): Set<string> {
  const out = new Set<string>();
  for (const h of history) {
    if (!ISO_DAY.test(h.at)) continue;
    const ago = daysBetween(h.at, today);
    if (ago >= 1 && ago <= HISTORY_DAYS) out.add(h.key);
  }
  return out;
}

/** Poids d'un titre : popularité et note normalisées, bonus nouveauté, sortie de la semaine et genre préféré, pénalité d'historique. */
function weightOf(it: FeaturedItem, today: string, preferred: ReadonlySet<number>, recent: ReadonlySet<string>): number {
  const popularity = Math.min(1, Math.log10(1 + Math.max(0, it.popularity)) / 3);
  const acclaim = Math.min(1, Math.max(0, it.vote - 5) / 4) * Math.min(1, it.votes / 300);
  const age = daysBetween(it.date, today);
  let s = 0.7 * popularity + 0.3 * acclaim;
  if (age >= 0 && age < NEW_DAYS) s += 0.15;
  if (age >= 0 && age <= WEEK_DAYS) s += 0.1;
  if (it.genreIds.some((g) => preferred.has(g))) s += 0.2;
  if (recent.has(it.key)) s -= 0.5;
  return Math.max(MIN_WEIGHT, s);
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

/** Titres mis en tête pour ce profil (localStorage) ; liste vide si le stockage est indisponible ou corrompu. */
function readFeaturedHistory(profileId: string): FeaturedHistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_PREFIX + profileId) ?? 'null');
    const entries: unknown[] = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
    return entries.filter(isEntry).slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Enregistre les titres mis en tête aujourd'hui (remplace ceux de la même journée). Sans effet si le stockage est indisponible. */
export function rememberFeatured(items: readonly FeaturedItem[], now: Date = new Date(), profileId: string = currentProfileId()): void {
  try {
    const today = localIso(now);
    const kept = readFeaturedHistory(profileId).filter((h) => h.at !== today);
    const entries = [...kept, ...items.map((it) => ({ key: it.key, at: today }))].slice(-HISTORY_MAX);
    localStorage.setItem(HISTORY_PREFIX + profileId, JSON.stringify({ v: 1, entries }));
  } catch {
    /* stockage indisponible : pas de pénalité d'historique, la sélection reste valable */
  }
}

/**
 * Titres de « En vedette » pour ce jour et ce profil, dans l'ordre d'affichage. Liste vide si le pool est insuffisant
 * (moins de 4 titres après filtres) ou si toutes les sources échouent : l'appelant replie. Ne lève jamais d'exception.
 */
export async function featuredItems(opts: FeaturedOptions = {}): Promise<FeaturedItem[]> {
  try {
    const now = opts.now ?? new Date();
    const today = localIso(now);
    const profileId = opts.profileId ?? currentProfileId();
    const region = opts.region ?? defaultRegion();
    const isKid = opts.isKid === true;
    const kidAge = opts.kidMaxAge ?? 12;
    const fetchFn: (path: string, params: Record<string, string>) => Promise<unknown> = opts.fetch ?? tmdb;
    const banned = opts.banned ?? bannedGenreIds();
    const genres = isKid
      ? []
      : (opts.preferredGenres ?? preferredGenresOf(opts.watched ?? safeWatched(), opts.genreHints ?? [], banned)).filter((g) => !banned.has(g)).slice(0, TOP_GENRES);
    const sources = isKid ? kidSources(makeCtx(region, kidAge, now)) : adultSources(region, today, genres);

    const settled = await Promise.allSettled(sources.map((s) => Promise.resolve().then(() => fetchFn(s.path, { region, ...s.params }))));
    const pool = new Map<string, FeaturedItem>();
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const json = r.value;
      if (!isRecord(json) || !Array.isArray(json.results)) return;
      for (const raw of json.results) {
        const it = toFeatured(raw, sources[i].type);
        if (it && !pool.has(it.key)) pool.set(it.key, it);
      }
    });

    const released = [...pool.values()].filter((it) => it.date <= today && (!isKid || kidOk(it, kidAge)));
    const visible = opts.visible ?? ((items: FeaturedItem[]) => keepVisible(items));
    const candidates = visible(released);
    if (candidates.length < MIN_POOL) return [];

    const preferred = new Set(genres);
    const recent = recentKeys(opts.history ?? readFeaturedHistory(profileId), today);
    const scored = candidates.map((it) => ({ it, w: weightOf(it, today, preferred, recent) }));
    const rnd = mulberry32(drawSeed(today, profileId));
    const series = drawWeighted(
      scored.filter((s) => s.it.type === 'tv'),
      MIN_SERIES,
      rnd,
    );
    const rest = scored.filter((s) => !series.includes(s));
    const chosen = [...series, ...drawWeighted(rest, FEATURED_COUNT - series.length, rnd)];
    // Ordre d'affichage : tirage pondéré, pour que les séries ne soient pas toujours en tête.
    return drawWeighted(chosen, chosen.length, rnd).map((s) => s.it);
  } catch {
    return [];
  }
}
