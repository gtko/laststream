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
/** Nombre maximal d'alias TMDB retenus (`TitleVariants.aliases`). */
const MAX_ALIASES = 30;

/** Titres d'un contenu, et année de sortie (films) ou de première diffusion (séries), si connue. */
export interface TitleVariants {
  /** Dédupliqués : titre original, anglais, français, puis titre de repli. */
  titles: string[];
  year?: number;
  /** Titre français et titre anglais (TMDB), quand ils sont connus : ils passent en tête des requêtes de film. */
  fr?: string;
  en?: string;
  /** Identifiant TVDB d'une série (TMDB external_ids), quand il est connu. */
  tvdbId?: number;
  /**
   * Titres alternatifs TMDB (romaji, titres d'exportation…), nettoyés, dédupliqués, sans doublon de `titles`, limités à
   * MAX_ALIASES. Servent seulement à la correspondance du nom de release : jamais aux requêtes (`titles` les exclut).
   */
  aliases?: string[];
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
  if (found.tvdbId !== undefined) out.tvdbId = found.tvdbId;
  if (found.aliases !== undefined) out.aliases = found.aliases;
  return out;
}

/** Jetons d'un texte, pour comparer un titre à un nom de release : sans accents, minuscules, lettres et chiffres seuls. */
export function nameTokens(text: string): string[] {
  return stripAccents(text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

/**
 * Groupes de tête ne faisant pas partie du titre : crochets (« [SubsPlease] », « [www.site.org] ») et préfixes de site,
 * « www.Site.com - » ou « www.site.org. » (www. + domaine, séparateurs ensuite), « site.org - » (domaine suivi d'un
 * tiret ou d'une barre, précédé d'un espace). Un domaine nu suivi d'un point ne compte pas : « Star.Trek.S01E01 » reste.
 */
const LEADING_GROUP = /^\s*(?:\[[^\]]*\]\s*|www\.[a-z0-9-]+\.[a-z]{2,6}[\s._|-]+|[a-z0-9-]+\.[a-z]{2,6}\s+[-_|–]+\s*)+/i;

/** Jetons du nom d'une release, sans groupes de tête (crochets et préfixe de site). */
function releaseTokens(name: string): string[] {
  return nameTokens(name.replace(LEADING_GROUP, ''));
}

/** Formes de jetons d'un titre, sans doublon : apostrophe retirée (« lapothicaire ») ou séparatrice (« l apothicaire »). */
function titleTokenForms(title: string): string[][] {
  const forms = [nameTokens(title), nameTokens(title.replace(/['’]/g, ' '))].filter((tokens) => tokens.length > 0);
  const seen = new Set<string>();
  return forms.filter((tokens) => {
    const key = tokens.join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const YEAR_TOKEN_ONLY = /^(?:19|20)\d{2}$/;
/** Saison ou épisode : « s01 », « s01e02 », « s01e01e02 », « e05 », « ep05 », « 2x05 ». */
const EPISODE_TOKEN = /^(?:s\d{1,3}(?:e\d{1,4})*|(?:e|ep)\d{1,4}|\d{1,2}x\d{2,3})$/;
/** Résolution : « 1080p », « 720i », « 4k ». */
const RESOLUTION_TOKEN = /^(?:\d{3,4}[pi]|[248]k|uhd|hd|hdr)$/;
const BARE_NUMBER = /^\d{1,4}$/;
/** Langue, source, mots de saison ou d'intégrale : ce qui peut suivre directement un titre dans un nom de release. */
const LABEL_TOKENS = new Set([
  'saison', 'saisons', 'season', 'seasons', 'integrale', 'complete',
  'multi', 'vf', 'vff', 'vfq', 'vfi', 'vf2', 'vfb', 'vo', 'vost', 'vostfr', 'vostf', 'subfrench', 'truefrench', 'french', 'fr',
  'english', 'eng', 'en', 'dual',
  'web', 'webrip', 'webdl', 'dl', 'bluray', 'blu', 'ray', 'bdrip', 'brrip', 'bd', 'hdtv', 'dvdrip', 'dvd', 'hdrip', 'remux',
  'amzn', 'nf', 'ddp', 'x264', 'x265', 'h264', 'h265', 'hevc', '10bit',
]);

/** Marqueur de fin de titre : année, saison ou épisode, résolution, langue, tag de source. */
function isTitleEndMarker(token: string): boolean {
  return YEAR_TOKEN_ONLY.test(token) || EPISODE_TOKEN.test(token) || RESOLUTION_TOKEN.test(token) || LABEL_TOKENS.has(token);
}

/**
 * Vrai si un titre peut finir au jeton `index` : fin du nom, marqueur de fin, ou numéro absolu d'anime (« One Piece 1071 »)
 * suivi de la fin ou d'un marqueur. Un mot de plus (« Strange New Worlds », « The Next Generation ») empêche la fin.
 */
function titleEndsAt(tokens: readonly string[], index: number): boolean {
  if (index === tokens.length) return true;
  if (isTitleEndMarker(tokens[index])) return true;
  return BARE_NUMBER.test(tokens[index]) && (index + 1 === tokens.length || isTitleEndMarker(tokens[index + 1]));
}

/**
 * Nombre de jetons du titre le plus long qui ouvre le nom (jetons déjà extraits) et se termine à un marqueur ou à la fin
 * du nom. Undefined si aucun titre ne correspond. Le titre doit être le début exact du nom : « Sousou.No.Frieren » ne
 * correspond pas à « Frieren ».
 */
function openingTitleLength(tokens: readonly string[], titles: readonly string[]): number | undefined {
  let best: number | undefined;
  for (const title of titles) {
    for (const form of titleTokenForms(title)) {
      if (form.length > tokens.length || !form.every((token, index) => tokens[index] === token)) continue;
      if (!titleEndsAt(tokens, form.length)) continue;
      if (best === undefined || form.length > best) best = form.length;
    }
  }
  return best;
}

/**
 * Vrai si le nom de la release commence exactement par l'un des titres, suivi directement d'un marqueur de fin (année,
 * SxxEyy / Sxx / « Saison », résolution, langue, tag de source) ou de la fin du nom. « Star.Trek.1966.S01E01 » et
 * « Star Trek S01E01 MULTI » passent pour « Star Trek » ; « Star.Trek.Strange.New.Worlds.2022.S01 » non.
 * Sans titre exploitable (vide, ou sans lettre latine) : vrai, rien à vérifier.
 */
export function nameMatchesTitles(name: string, titles: readonly string[]): boolean {
  if (!titles.some((title) => titleTokenForms(title).length > 0)) return true;
  return openingTitleLength(releaseTokens(name), titles) !== undefined;
}

/** Identifiant TVDB d'une série (réponse external_ids de TMDB), ou undefined. */
function tvdbIdFrom(external: Record<string, unknown> | undefined): number | undefined {
  const id = external?.tvdb_id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
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
  // Séries : identifiants externes (TVDB) pour la recherche par id ; un échec ne rend pas le résultat incomplet.
  // La fiche en-US porte aussi les titres alternatifs (alias) ; ils ne servent qu'à la correspondance des releases.
  const [en, fr, external] = await Promise.all([
    getJson(`${TMDB_API_URL}/${kind}/${id}?language=en-US&append_to_response=alternative_titles`, token, fetchFn, timeoutMs),
    getJson(`${TMDB_API_URL}/${kind}/${id}?language=fr-FR`, token, fetchFn, timeoutMs),
    isMovie ? Promise.resolve(undefined) : getJson(`${TMDB_API_URL}/tv/${id}/external_ids`, token, fetchFn, timeoutMs),
  ]);
  const titles = unique([
    cleanTitle(en?.[originalKey]) ?? cleanTitle(fr?.[originalKey]),
    cleanTitle(en?.[titleKey]),
    cleanTitle(fr?.[titleKey]),
  ]);
  const year = yearOf(en?.[dateKey]) ?? yearOf(fr?.[dateKey]);
  const out: TmdbTitles = {
    titles,
    year,
    fr: cleanTitle(fr?.[titleKey]),
    en: cleanTitle(en?.[titleKey]),
    complete: en !== undefined && fr !== undefined,
  };
  const tvdbId = tvdbIdFrom(external);
  if (tvdbId !== undefined) out.tvdbId = tvdbId;
  const aliases = aliasesOf(en, isMovie, titles);
  if (aliases.length > 0) out.aliases = aliases;
  return out;
}

/**
 * Titres alternatifs d'une fiche TMDB (append_to_response=alternative_titles) : `titles[]` pour un film, `results[]` pour
 * une série. Nettoyés, dédupliqués, sans doublon des titres déjà connus, limités à MAX_ALIASES.
 */
function aliasesOf(en: Record<string, unknown> | undefined, isMovie: boolean, titles: readonly string[]): string[] {
  const block = en?.alternative_titles;
  const list = isRecord(block) ? block[isMovie ? 'titles' : 'results'] : undefined;
  if (!Array.isArray(list)) return [];
  const known = new Set(titles.map((title) => title.toLowerCase()));
  const aliases = unique(list.map((entry: unknown) => (isRecord(entry) ? cleanTitle(entry.title) : undefined)))
    .filter((title) => !known.has(title.toLowerCase()));
  return aliases.slice(0, MAX_ALIASES);
}

/** Ajoute le titre de repli (dédupliqué) et l'année de repli si TMDB n'en donne pas. */
function finish(found: TitleVariants, fallback: TitleInfo | undefined): TitleVariants {
  const titles = unique([...found.titles, cleanTitle(fallback?.title)]);
  const out: TitleVariants = { titles };
  const year = found.year ?? fallback?.year;
  if (year !== undefined) out.year = year;
  if (found.fr !== undefined) out.fr = found.fr;
  if (found.en !== undefined) out.en = found.en;
  if (found.tvdbId !== undefined) out.tvdbId = found.tvdbId;
  if (found.aliases !== undefined) out.aliases = found.aliases;
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

/**
 * Suffixes d'une requête de série, par ordre de priorité. Les packs (« SNN », « Saison N ») et l'intégrale (« Intégrale »,
 * « complete ») passent avant « SxxEyy » : mesuré, les requêtes d'épisode exact sont lentes (2 à 4 s) et rendent peu,
 * alors que les packs répondent en moins de 350 ms. Saison seule : « Saison N » et « SNN ».
 */
function seriesSuffixes(ref: ContentRef): string[] {
  const { season, episode } = ref;
  if (season === undefined) return [''];
  if (episode === undefined) return [` Saison ${season}`, ` S${pad2(season)}`];
  return [` S${pad2(season)}`, ` Saison ${season}`, ' Intégrale', ' complete', ` S${pad2(season)}E${pad2(episode)}`];
}

/** Vrai si le titre contient une lettre latine : un titre japonais seul n'apporte rien aux indexeurs francophones. */
const hasLatinLetter = (text: string): boolean => /\p{Script=Latin}/u.test(text);

/** Titre à ancrer dans une requête par identifiant : français, puis anglais ou original latin. Undefined si aucun. */
export function idQueryOf(variants: TitleVariants): string | undefined {
  return orderedEntries(variants)
    .map((entry) => cleanTitle(entry.text))
    .find((text): text is string => text !== undefined && hasLatinLetter(text));
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

/**
 * Requêtes d'épisode, de saison ou d'intégrale : titre français puis original (latins), suffixés selon `seriesSuffixes`.
 * Ordre : toutes les formes telles quelles d'abord (titre français, puis original, famille par famille), puis les
 * variantes sans accents ni ponctuation (le suffixe est transformé avec le titre).
 */
function seriesQueries(variants: TitleVariants, ref: ContentRef): string[] {
  const bases = orderedEntries(variants)
    .map((entry) => cleanTitle(entry.text))
    .filter((text): text is string => text !== undefined && hasLatinLetter(text));
  const suffixes = seriesSuffixes(ref);
  const queries: string[] = [];
  for (const fold of FOLDS) {
    for (const base of bases) {
      for (const suffix of suffixes) {
        const folded = cleanTitle(fold(`${base}${suffix}`));
        if (folded !== undefined) queries.push(folded);
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

/**
 * Année de la release : la dernière année isolée, hors du titre qui ouvre le nom. « Blade.Runner.2049.2017.1080p » donne
 * 2017 ; « 1923.S01E01 » avec le titre « 1923 » ne donne aucune année (l'année fait partie du titre).
 */
export function releaseYear(name: string, titles: readonly string[] = []): number | undefined {
  const tokens = releaseTokens(name);
  const from = openingTitleLength(tokens, titles) ?? 0;
  let last: number | undefined;
  for (const token of tokens.slice(from)) {
    if (YEAR_TOKEN_ONLY.test(token)) last = Number(token);
  }
  return last;
}

/** Dernière année isolée dans un titre de release (« Blade.Runner.2049.2017.1080p » donne 2017). */
export function detectYear(title: string): number | undefined {
  return releaseYear(title);
}

/** Vrai si l'année du titre est absente ou à ±1 de l'année attendue (absente : vrai). `titles` : l'année d'un titre n'en est pas une. */
export function yearMatches(resultTitle: string, year: number | undefined, titles: readonly string[] = []): boolean {
  if (year === undefined) return true;
  const detected = releaseYear(resultTitle, titles);
  return detected === undefined || Math.abs(detected - year) <= 1;
}

/**
 * Année de la release compatible avec l'œuvre. Films : à ±1 an de la sortie. Séries : pas antérieure à la première
 * diffusion moins un an (une saison plus récente est acceptée). Année absente, ou année attendue inconnue : vrai.
 */
export function releaseYearFits(name: string, variants: TitleVariants, type: ContentRef['type']): boolean {
  const year = variants.year;
  if (year === undefined) return true;
  const detected = releaseYear(name, [...variants.titles, ...(variants.aliases ?? [])]);
  if (detected === undefined) return true;
  return type === 'movie' ? Math.abs(detected - year) <= 1 : detected >= year - 1;
}

/** Retire les flux d'un film dont l'année du titre diffère de plus de 1 de l'année attendue. Séries : inchangé. */
export function filterByYear(streams: RawStream[], ref: ContentRef, variants: TitleVariants | undefined): RawStream[] {
  const year = variants?.year;
  if (ref.type !== 'movie' || year === undefined) return streams;
  const titles = [...(variants?.titles ?? []), ...(variants?.aliases ?? [])];
  return streams.filter((stream) => yearMatches(stream.title ?? stream.filename ?? '', year, titles));
}
