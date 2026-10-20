/*
 * Statistiques du profil (page #/stats) : agrégations pures, sans DOM ni réseau.
 * Source : l'historique « vu » du profil (compteur et date de dernière lecture par titre) et, pour un sous-ensemble de titres
 * (au plus DETAIL_LIMIT), les données TMDB utiles (`TitleMeta` : durée, genres, année, épisodes, crédits). Les autres titres
 * comptent dans les totaux avec une durée estimée (médiane des titres détaillés).
 * Les dates ne sont que celles de la dernière lecture de chaque titre : les graphiques par mois ou par jour s'en contentent.
 */
import { pad2 } from './format';
import type { WatchedTitle } from './watchedHistory';

/** Titres détaillés au plus par calcul : le reste est estimé (appels TMDB limités). */
export const DETAIL_LIMIT = 50;
/** Données TMDB gardées dans le navigateur : 30 jours, 300 titres au plus. */
export const META_TTL_MS = 30 * 864e5;
export const META_CACHE_KEY = 'laststream.stats.meta';
const META_CACHE_MAX = 300;
const DEFAULT_MOVIE_MIN = 110;
const DEFAULT_EPISODE_MIN = 45;
const DAY_MS = 864e5;

export const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'] as const;
export const DAYPARTS = ['Matin', 'Après-midi', 'Soirée', 'Nuit'] as const;

export type PersonRole = 'cast' | 'director' | 'creator';
export interface PersonRef {
  id: number;
  name: string;
  role: PersonRole;
}

/** Données TMDB d'un titre utiles aux statistiques. `runtime` pour un film, `episodeRuntime` / `episodes` pour une série. 0 si inconnu. */
export interface TitleMeta {
  key: string;
  name: string;
  year: number;
  runtime: number;
  episodeRuntime: number;
  episodes: number;
  genres: string[];
  people: PersonRef[];
}

/** Forme utile de la réponse TMDB « détail + crédits » (un seul appel par titre). */
export interface TmdbTitleRaw {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_episodes?: number;
  genres?: Array<{ name?: string }>;
  created_by?: Array<{ id?: number; name?: string }>;
  credits?: {
    cast?: Array<{ id?: number; name?: string }>;
    crew?: Array<{ id?: number; name?: string; job?: string }>;
  };
}

/** Réponse TMDB → données de statistiques. Les dix premiers acteurs et le réalisateur (ou le créateur) sont retenus. */
export function metaFromTmdb(type: 'movie' | 'tv', key: string, raw: TmdbTitleRaw): TitleMeta {
  const isTv = type === 'tv';
  const people: PersonRef[] = [];
  const ids = new Set<number>();
  const add = (p: { id?: number; name?: string } | undefined, role: PersonRole): void => {
    const id = Number(p?.id);
    if (!p?.name || !Number.isFinite(id) || ids.has(id)) return;
    ids.add(id);
    people.push({ id, name: p.name, role });
  };
  if (isTv) (raw.created_by ?? []).forEach((p) => add(p, 'creator'));
  else (raw.credits?.crew ?? []).filter((p) => p.job === 'Director').forEach((p) => add(p, 'director'));
  (raw.credits?.cast ?? []).slice(0, 10).forEach((p) => add(p, 'cast'));
  const date = String(raw.release_date || raw.first_air_date || '');
  return {
    key,
    name: raw.title || raw.name || raw.original_title || raw.original_name || 'Sans titre',
    year: Number(date.slice(0, 4)) || 0,
    runtime: isTv ? 0 : Number(raw.runtime) || 0,
    episodeRuntime: isTv ? Number(raw.episode_run_time?.[0]) || 0 : 0,
    episodes: isTv ? Number(raw.number_of_episodes) || 0 : 0,
    genres: (raw.genres ?? []).map((g) => g.name ?? '').filter(Boolean),
    people,
  };
}

/** Titres à détailler : les plus récents et les plus vus, en alternance, sans doublon, au plus `limit`. */
export function pickDetailTargets(titles: readonly WatchedTitle[], limit: number = DETAIL_LIMIT): WatchedTitle[] {
  const byRecent = [...titles].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt || b.watched - a.watched || a.key.localeCompare(b.key));
  const byCount = [...titles].sort((a, b) => b.watched - a.watched || b.lastWatchedAt - a.lastWatchedAt || a.key.localeCompare(b.key));
  const out: WatchedTitle[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < titles.length && out.length < limit; i++) {
    for (const t of [byRecent[i], byCount[i]]) {
      if (t && out.length < limit && !seen.has(t.key)) {
        seen.add(t.key);
        out.push(t);
      }
    }
  }
  return out;
}

/** Jour civil local « AAAA-MM-JJ » d'un instant. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Numéro de jour (depuis l'époque, minuit UTC) d'une clé « AAAA-MM-JJ ». Deux jours consécutifs diffèrent de 1. */
const dayNumber = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

/**
 * Jours consécutifs avec au moins une lecture (date de dernière lecture de chaque titre, jour local).
 * `current` : la série en cours, si elle se termine aujourd'hui ou hier ; `best` : la plus longue.
 */
export function dayStreaks(stamps: readonly number[], now: number): { current: number; best: number } {
  const days = [...new Set(stamps.filter((t) => t > 0).map((t) => dayNumber(localDayKey(t))))].sort((a, b) => a - b);
  const set = new Set(days);
  let best = 0;
  let run = 0;
  let prev = NaN;
  for (const d of days) {
    run = d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  const today = dayNumber(localDayKey(now));
  const start = set.has(today) ? today : set.has(today - 1) ? today - 1 : null;
  let current = 0;
  if (start !== null) for (let d = start; set.has(d); d--) current++;
  return { current, best };
}

/** Les `count` derniers mois (heure locale), du plus ancien au plus récent. `key` : « AAAA-MM ». */
export function lastMonths(now: number, count = 12): Array<{ key: string; month: number }> {
  const d = new Date(now);
  const out: Array<{ key: string; month: number }> = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: `${m.getFullYear()}-${pad2(m.getMonth() + 1)}`, month: m.getMonth() });
  }
  return out;
}

/** Minutes regardées d'un titre : durée TMDB si connue, sinon estimation. `estimated` vrai si l'estimation a servi. */
export function titleMinutes(t: Pick<WatchedTitle, 'type' | 'watched'>, meta: TitleMeta | undefined, est: { movieMinutes: number; episodeMinutes: number }): { minutes: number; estimated: boolean } {
  if (t.type === 'movie') return meta?.runtime ? { minutes: meta.runtime, estimated: false } : { minutes: est.movieMinutes, estimated: true };
  return meta?.episodeRuntime
    ? { minutes: t.watched * meta.episodeRuntime, estimated: false }
    : { minutes: t.watched * est.episodeMinutes, estimated: true };
}

/** Médiane des valeurs positives, ou `fallback` s'il n'y en a aucune. */
export function median(values: readonly number[], fallback: number): number {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return fallback;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/** Tranche de la journée d'une heure locale : 0 matin, 1 après-midi, 2 soirée, 3 nuit. */
export function daypartOf(hour: number): number {
  if (hour >= 5 && hour < 12) return 0;
  if (hour >= 12 && hour < 18) return 1;
  if (hour >= 18 && hour < 23) return 2;
  return 3;
}

export interface StatsInput {
  titles: readonly WatchedTitle[];
  /** Données TMDB des titres détaillés, par clé (`movie:550`). */
  metas: ReadonlyMap<string, TitleMeta>;
  /** Nombre de titres notés. */
  ratings: number;
  now: number;
}

export interface StatsTotals {
  minutes: number;
  estimatedMinutes: number;
  movies: number;
  episodes: number;
  seriesDone: number;
  seriesOngoing: number;
  rated: number;
  titles: number;
  detailed: number;
}

export interface PersonStat {
  id: number;
  name: string;
  role: PersonRole;
  titles: number;
  minutes: number;
}

export interface SeriesStat {
  key: string;
  name: string;
  watched: number;
  episodes: number;
  complete: boolean;
  minutes: number;
}

export interface LastWatch {
  key: string;
  type: 'movie' | 'tv';
  /** Nom du titre si ses données TMDB sont chargées, sinon null. */
  name: string | null;
  at: number;
}

export interface StatsResult {
  /** Aucun titre vu. */
  empty: boolean;
  /** Au moins un titre avec une date de lecture (absente sur l'historique local). */
  hasDates: boolean;
  totals: StatsTotals;
  /** Les 12 derniers mois, du plus ancien au plus récent ; minutes lues dont la dernière lecture tombe dans le mois. */
  months: Array<{ key: string; month: number; minutes: number }>;
  /** Minutes par jour de la semaine (lundi en premier), d'après la dernière lecture. */
  weekday: number[];
  /** Minutes par tranche de la journée (voir DAYPARTS). */
  dayparts: number[];
  streak: { current: number; best: number };
  genres: Array<{ name: string; count: number }>;
  /** Décennies de sortie, contiguës du début à la fin, titres détaillés seulement. */
  decades: Array<{ decade: number; count: number }>;
  people: PersonStat[];
  topSeries: SeriesStat | null;
  lastWatch: LastWatch | null;
  estimate: { movieMinutes: number; episodeMinutes: number };
}

/** Agrège l'historique « vu » et les données TMDB disponibles. Ne fait aucun appel : les titres sans données sont estimés. */
export function computeStats({ titles: all, metas, ratings, now }: StatsInput): StatsResult {
  const titles = all.filter((t) => t.watched > 0);
  const movieRuntimes: number[] = [];
  const episodeRuntimes: number[] = [];
  for (const t of titles) {
    const m = metas.get(t.key);
    if (!m) continue;
    if (t.type === 'movie') movieRuntimes.push(m.runtime);
    else episodeRuntimes.push(m.episodeRuntime);
  }
  const estimate = { movieMinutes: median(movieRuntimes, DEFAULT_MOVIE_MIN), episodeMinutes: median(episodeRuntimes, DEFAULT_EPISODE_MIN) };
  const totals: StatsTotals = { minutes: 0, estimatedMinutes: 0, movies: 0, episodes: 0, seriesDone: 0, seriesOngoing: 0, rated: ratings, titles: titles.length, detailed: 0 };
  const monthMinutes = new Map<string, number>();
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const dayparts = [0, 0, 0, 0];
  const genres = new Map<string, number>();
  const decadeCount = new Map<number, number>();
  const people = new Map<number, PersonStat>();
  let topSeries: SeriesStat | null = null;
  let lastWatch: LastWatch | null = null;

  for (const t of titles) {
    const meta = metas.get(t.key);
    if (meta) totals.detailed++;
    const { minutes, estimated } = titleMinutes(t, meta, estimate);
    totals.minutes += minutes;
    if (estimated) totals.estimatedMinutes += minutes;
    const complete = t.type === 'tv' && !!meta && meta.episodes > 0 && t.watched >= meta.episodes;
    if (t.type === 'movie') totals.movies++;
    else {
      totals.episodes += t.watched;
      if (complete) totals.seriesDone++;
      else totals.seriesOngoing++;
    }
    if (t.lastWatchedAt > 0) {
      const mk = localDayKey(t.lastWatchedAt).slice(0, 7);
      monthMinutes.set(mk, (monthMinutes.get(mk) ?? 0) + minutes);
      const d = new Date(t.lastWatchedAt);
      weekday[(d.getDay() + 6) % 7] += minutes;
      dayparts[daypartOf(d.getHours())] += minutes;
      if (!lastWatch || t.lastWatchedAt > lastWatch.at) lastWatch = { key: t.key, type: t.type, name: meta?.name ?? null, at: t.lastWatchedAt };
    }
    if (t.type === 'tv' && meta && (!topSeries || t.watched > topSeries.watched || (t.watched === topSeries.watched && minutes > topSeries.minutes))) {
      topSeries = { key: t.key, name: meta.name, watched: t.watched, episodes: meta.episodes, complete, minutes };
    }
    if (!meta) continue;
    if (meta.year) {
      const decade = Math.floor(meta.year / 10) * 10;
      decadeCount.set(decade, (decadeCount.get(decade) ?? 0) + 1);
    }
    for (const g of meta.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
    for (const p of meta.people) {
      const cur = people.get(p.id);
      people.set(p.id, {
        id: p.id,
        name: p.name,
        role: cur && cur.role !== 'cast' ? cur.role : p.role,
        titles: (cur?.titles ?? 0) + 1,
        minutes: (cur?.minutes ?? 0) + minutes,
      });
    }
  }

  const decadeKeys = [...decadeCount.keys()];
  const decades: Array<{ decade: number; count: number }> = [];
  if (decadeKeys.length) {
    const lo = Math.min(...decadeKeys);
    const hi = Math.max(...decadeKeys);
    for (let d = lo; d <= hi; d += 10) decades.push({ decade: d, count: decadeCount.get(d) ?? 0 });
  }

  return {
    empty: titles.length === 0,
    hasDates: titles.some((t) => t.lastWatchedAt > 0),
    totals,
    months: lastMonths(now).map((m) => ({ ...m, minutes: monthMinutes.get(m.key) ?? 0 })),
    weekday,
    dayparts,
    streak: dayStreaks(titles.map((t) => t.lastWatchedAt), now),
    genres: [...genres].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr')).slice(0, 8),
    decades,
    people: [...people.values()].sort((a, b) => b.minutes - a.minutes || b.titles - a.titles || a.name.localeCompare(b.name, 'fr')).slice(0, 10),
    topSeries,
    lastWatch,
    estimate,
  };
}

// ---- Cache des données TMDB (navigateur) ----

export interface MetaEntry {
  /** Instant de la récupération (ms). */
  at: number;
  meta: TitleMeta;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | undefined;

/** Lit le cache ; absent, illisible ou mal formé : vide. Les entrées périmées restent, c'est à l'appelant de les refuser. */
export function readMetaCache(storage: StorageLike): Map<string, MetaEntry> {
  const out = new Map<string, MetaEntry>();
  try {
    const raw = storage?.getItem(META_CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [key, value] of Object.entries(parsed as Record<string, Partial<MetaEntry>>)) {
      const m = value?.meta;
      if (typeof value?.at !== 'number' || !m || typeof m.name !== 'string' || !Array.isArray(m.genres) || !Array.isArray(m.people)) continue;
      out.set(key, { at: value.at, meta: m });
    }
  } catch {
    // Cache absent ou illisible : on repart de zéro.
  }
  return out;
}

/** Écrit le cache en gardant les `META_CACHE_MAX` entrées les plus récentes. Stockage plein : rien n'est gardé. */
export function writeMetaCache(storage: StorageLike, entries: ReadonlyMap<string, MetaEntry>): void {
  const kept = [...entries].sort((a, b) => b[1].at - a[1].at).slice(0, META_CACHE_MAX);
  try {
    storage?.setItem(META_CACHE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Stockage indisponible : le cache ne sert qu'à économiser des appels.
  }
}

/** Vrai si l'entrée de cache est encore valable à `now`. */
export const isFreshMeta = (entry: MetaEntry, now: number): boolean => now - entry.at < META_TTL_MS;
