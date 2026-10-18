import type { ContentRef, RawStream } from '../types.js';
import { fetchText, isRecord, type FetchFn } from './http.js';
import type { TitleInfo } from './indexers.js';

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const DEFAULT_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMDB_ID = /^tt\d+$/;
const MAX_TITLE_LENGTH = 200;

/** Nombre maximal de requêtes texte produites pour une recherche. */
export const MAX_QUERIES = 8;

/** Titres d'un contenu, et année de sortie (films) ou de première diffusion (séries), si connue. */
export interface TitleVariants {
  /** Dédupliqués : titre original, anglais, français, puis titre de repli. */
  titles: string[];
  year?: number;
  /** Titre français et titre anglais (TMDB), quand ils sont connus : ils passent en tête des requêtes de film. */
  fr?: string;
  en?: string;
}

interface CacheEntry {
  expiresAt: number;
  value: TitleVariants;
}

/** Cache mémoire des titres TMDB, clé « type:imdb », valable 7 jours. */
export type TitleCache = Map<string, CacheEntry>;

const defaultCache: TitleCache = new Map();

export interface TitleVariantsOptions {
  /** Jeton de lecture TMDB (API v4, en-tête Bearer). Absent : aucun appel TMDB. */
  tmdbToken?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  cache?: TitleCache;
  /** Titre (et année) connu par ailleurs, typiquement Cinemeta : repli sans jeton ou si TMDB échoue. */
  fallbackTitle?: TitleInfo;
  /** Horloge injectée (tests). Défaut : Date.now. */
  now?: () => number;
}

interface TmdbTitles extends TitleVariants {
  /** Faux si un appel TMDB a échoué : le résultat n'est alors pas mis en cache. */
  complete: boolean;
}

/** Copie des champs de titres renseignés (sans l'indicateur interne de complétude). */
function variantsOnly(found: TmdbTitles): TitleVariants {
  const out: TitleVariants = { titles: found.titles };
  if (found.year !== undefined) out.year = found.year;
  if (found.fr !== undefined) out.fr = found.fr;
  if (found.en !== undefined) out.en = found.en;
  return out;
}

/** Texte nettoyé (espaces réduits, borné), ou undefined si vide. */
function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed === '' ? undefined : trimmed;
}

/** Valeurs non vides, dédupliquées sans tenir compte de la casse ; la première occurrence gagne. */
function unique(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === undefined) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function yearOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}/.test(value)) return undefined;
  return Number(value.slice(0, 4));
}

/** Retire les accents (forme décomposée NFD) : « Deuxième » devient « Deuxieme ». */
export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '');
}

/** Remplace la ponctuation courante des titres (« : », « - », apostrophes…) par un espace. */
export function stripPunctuation(text: string): string {
  return text.replace(/[:'’"«»().,!?[\]&/-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Identifiant TMDB d'un titre à partir de la réponse /find. */
function tmdbIdFrom(found: Record<string, unknown>, type: ContentRef['type']): number | undefined {
  const results = found[type === 'movie' ? 'movie_results' : 'tv_results'];
  if (!Array.isArray(results) || !isRecord(results[0])) return undefined;
  const id = results[0].id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
}

/** GET JSON TMDB authentifié. undefined si l'appel échoue (réseau, HTTP, JSON) ; le jeton n'apparaît jamais. */
async function getJson(
  url: string,
  token: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetchText(
      fetchFn,
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      timeoutMs,
    );
    if (!res.ok) return undefined;
    const json: unknown = JSON.parse(res.text);
    return isRecord(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Titres TMDB : find par id IMDb, puis fiche en anglais (en-US) et en français (fr-FR). */
async function fetchTmdbTitles(ref: ContentRef, token: string, fetchFn: FetchFn, timeoutMs: number): Promise<TmdbTitles> {
  const found = await getJson(`${TMDB_API_URL}/find/${ref.imdbId}?external_source=imdb_id`, token, fetchFn, timeoutMs);
  if (found === undefined) return { titles: [], complete: false };
  const id = tmdbIdFrom(found, ref.type);
  if (id === undefined) return { titles: [], complete: true };

  const isMovie = ref.type === 'movie';
  const kind = isMovie ? 'movie' : 'tv';
  const titleKey = isMovie ? 'title' : 'name';
  const originalKey = isMovie ? 'original_title' : 'original_name';
  const dateKey = isMovie ? 'release_date' : 'first_air_date';
  const [en, fr] = await Promise.all(
    ['en-US', 'fr-FR'].map((language) =>
      getJson(`${TMDB_API_URL}/${kind}/${id}?language=${language}`, token, fetchFn, timeoutMs),
    ),
  );
  const titles = unique([
    cleanTitle(en?.[originalKey]) ?? cleanTitle(fr?.[originalKey]),
    cleanTitle(en?.[titleKey]),
    cleanTitle(fr?.[titleKey]),
  ]);
  const year = yearOf(en?.[dateKey]) ?? yearOf(fr?.[dateKey]);
  return {
    titles,
    year,
    fr: cleanTitle(fr?.[titleKey]),
    en: cleanTitle(en?.[titleKey]),
    complete: en !== undefined && fr !== undefined,
  };
}

/** Ajoute le titre de repli (dédupliqué) et l'année de repli si TMDB n'en donne pas. */
function finish(found: TitleVariants, fallback: TitleInfo | undefined): TitleVariants {
  const titles = unique([...found.titles, cleanTitle(fallback?.title)]);
  const out: TitleVariants = { titles };
  const year = found.year ?? fallback?.year;
  if (year !== undefined) out.year = year;
  if (found.fr !== undefined) out.fr = found.fr;
  if (found.en !== undefined) out.en = found.en;
  return out;
}

function readCache(cache: TitleCache, key: string, now: number): TitleVariants | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function storeEntry(cache: TitleCache, key: string, value: TitleVariants, now: number): void {
  for (const [existingKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(existingKey);
  }
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
}

/**
 * Titres d'un film ou d'une série (original, anglais, français) et année, via TMDB (API v4, jeton Bearer).
 * Sans jeton, ou si TMDB échoue, renvoie le titre de repli (`fallbackTitle`). Résultats complets non vides mis
 * en cache 7 jours (mémoire). Ne lève jamais.
 */
export async function getTitleVariants(ref: ContentRef, opts: TitleVariantsOptions = {}): Promise<TitleVariants> {
  const fallback = opts.fallbackTitle;
  try {
    const token = opts.tmdbToken?.trim();
    if (token === undefined || token === '' || !IMDB_ID.test(ref.imdbId)) return finish({ titles: [] }, fallback);

    const now = opts.now ?? Date.now;
    const cache = opts.cache ?? defaultCache;
    const key = `${ref.type}:${ref.imdbId}`;
    const cached = readCache(cache, key, now());
    if (cached !== undefined) return finish(cached, fallback);

    const found = await fetchTmdbTitles(ref, token, opts.fetch ?? fetch, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (found.complete && found.titles.length > 0) {
      storeEntry(cache, key, variantsOnly(found), now());
    }
    return finish(found, fallback);
  } catch {
    return finish({ titles: [] }, fallback);
  }
}

/** Titres à rechercher : `titles` si fourni, sinon le titre et l'année de `titleInfo` (rétrocompatibilité). */
export function variantsFor(opts: { titles?: TitleVariants; titleInfo?: TitleInfo }): TitleVariants | undefined {
  if (opts.titles !== undefined) return opts.titles;
  if (opts.titleInfo === undefined) return undefined;
  const { title, year } = opts.titleInfo;
  return year === undefined ? { titles: [title] } : { titles: [title], year };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Suffixes d'un épisode de série : SxxEyy, « Saison N » et « SNN » (pack) ; saison seule : « Saison N » et « SNN ». */
function seriesSuffixes(ref: ContentRef): string[] {
  const { season, episode } = ref;
  if (season === undefined) return [''];
  if (episode === undefined) return [` Saison ${season}`, ` S${pad2(season)}`];
  return [` S${pad2(season)}E${pad2(episode)}`, ` Saison ${season}`, ` S${pad2(season)}`];
}

/** Transformations appliquées à chaque titre, dans l'ordre de priorité : tel quel, sans accents, sans accents ni ponctuation, sans ponctuation. */
const FOLDS: readonly ((text: string) => string)[] = [
  (text) => text,
  stripAccents,
  (text) => stripPunctuation(stripAccents(text)),
  stripPunctuation,
];

/** Titre et langue d'une variante. */
interface TitleEntry {
  text: string;
  lang: 'fr' | 'en' | 'other';
}

/** Titres nettoyés et dédupliqués : français d'abord, puis anglais, puis les autres (ordre TMDB). */
function orderedEntries(variants: TitleVariants): TitleEntry[] {
  const entries: TitleEntry[] = [];
  const seen = new Set<string>();
  const add = (text: string | undefined, lang: TitleEntry['lang']): void => {
    if (text === undefined) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ text, lang });
  };
  add(cleanTitle(variants.fr), 'fr');
  add(cleanTitle(variants.en), 'en');
  for (const title of variants.titles) add(cleanTitle(title), 'other');
  return entries;
}

/**
 * Requêtes de film : chaque titre sans année et avec l'année (si elle est connue). Ordre : titre français sans année
 * puis avec, titre anglais avec année puis sans, autres titres sans puis avec. Les transformations (accents,
 * ponctuation) ne viennent qu'après le bloc précédent.
 */
function movieQueries(variants: TitleVariants): string[] {
  const year = variants.year;
  const queries: string[] = [];
  for (const fold of FOLDS) {
    for (const { text, lang } of orderedEntries(variants)) {
      const base = cleanTitle(fold(text));
      if (base === undefined) continue;
      const withYear = year === undefined ? undefined : `${base} ${year}`;
      const pair = lang === 'en' ? [withYear, base] : [base, withYear];
      for (const query of pair) {
        if (query !== undefined) queries.push(query);
      }
    }
  }
  return queries;
}

/** Requêtes d'épisode ou de saison : titres (tels quels, puis transformés) suffixés par SxxEyy, « Saison N » ou « SNN ». */
function seriesQueries(variants: TitleVariants, ref: ContentRef): string[] {
  const bases = unique(variants.titles.map(cleanTitle));
  const suffixes = seriesSuffixes(ref);
  const queries: string[] = [];
  for (const fold of FOLDS) {
    for (const suffix of suffixes) {
      for (const base of bases) {
        const folded = cleanTitle(fold(base));
        if (folded !== undefined) queries.push(`${folded}${suffix}`);
      }
    }
  }
  return queries;
}

/**
 * Requêtes texte, dédupliquées et plafonnées à MAX_QUERIES. Film : chaque titre avec et sans année (titre français
 * sans année d'abord). Série : suffixes d'épisode ou de saison. Dans les deux cas, les titres tels quels passent
 * avant les variantes sans accents ni ponctuation.
 */
export function buildQueries(variants: TitleVariants, ref: ContentRef): string[] {
  const queries = ref.type === 'movie' ? movieQueries(variants) : seriesQueries(variants, ref);
  return unique(queries.map(cleanTitle)).slice(0, MAX_QUERIES);
}

const YEAR_TOKEN = /(?<![A-Za-z0-9])(19\d{2}|20\d{2})(?![A-Za-z0-9])/g;

/** Dernière année isolée dans un titre de release (« Blade.Runner.2049.2017.1080p » donne 2017). */
export function detectYear(title: string): number | undefined {
  let last: number | undefined;
  for (const match of title.matchAll(YEAR_TOKEN)) last = Number(match[1]);
  return last;
}

/** Vrai si l'année du titre est absente ou à ±1 de l'année attendue (absente : vrai). */
export function yearMatches(resultTitle: string, year: number | undefined): boolean {
  if (year === undefined) return true;
  const detected = detectYear(resultTitle);
  return detected === undefined || Math.abs(detected - year) <= 1;
}

/** Retire les flux d'un film dont l'année du titre diffère de plus de 1 de l'année attendue. Séries : inchangé. */
export function filterByYear(streams: RawStream[], ref: ContentRef, variants: TitleVariants | undefined): RawStream[] {
  const year = variants?.year;
  if (ref.type !== 'movie' || year === undefined) return streams;
  return streams.filter((stream) => yearMatches(stream.title ?? stream.filename ?? '', year));
}
