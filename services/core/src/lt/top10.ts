import { isRecord } from '../sources/http.js';
import { TTL, type LtContext } from './context.js';
import { tmdbGet } from './providers.js';

/**
 * Top 10 de l'accueil : jusqu'à dix titres disponibles dans la région et récents, calculés côté serveur, partagés entre
 * les comptes et mis en cache (le client ne vérifie plus chaque tuile).
 *  - rangées de la semaine (`movie`, `tv`) : tendances de la semaine, puis découverte régionale récente (abonnement,
 *    gratuit ou publicité, sorties des derniers jours, les plus populaires), puis populaires si cela ne suffit pas ; au
 *    plus MAX_PAGES pages lues au total, titres dédupliqués, dans l'ordre de lecture ;
 *  - rangée du jour (`all`) : tendances du jour, puis tendances de la semaine ; films et séries mêlés dans l'ordre de
 *    popularité TMDB ;
 *  - film : un abonnement, une offre gratuite ou publicitaire dans la région, ou une sortie numérique (type 4) ou
 *    physique (type 5) déjà passée (repli US si la région n'a aucune date). La location et l'achat ne comptent pas à
 *    part : une précommande (sortie numérique future) n'est pas disponible. Film frais : date de sortie dans les
 *    FRESH_MOVIE_DAYS derniers jours ;
 *  - série : au moins un épisode diffusé (première diffusion ou dernier épisode passés). Série fraîche : première
 *    diffusion dans les FRESH_SERIES_DAYS derniers jours, ou saison la plus récente diffusée il y a moins de
 *    NEW_SEASON_DAYS jours. Écartée si elle est fleuve (plus de LONG_RUNNER_EPISODES épisodes et première diffusion
 *    plus vieille que LONG_RUNNER_YEARS ans, même avec une saison récente) ou si un genre TV exclu y figure
 *    (actualités, téléréalité, feuilleton, talk-show).
 * Une simple sortie en salle ne suffit pas. Sans donnée TMDB exploitable, le titre est écarté.
 */

/** Rangées servies : films et séries (tendances de la semaine), ou les deux mêlés (tendances du jour). */
const TOP_TYPES = ['movie', 'tv', 'all'] as const;
export type TopType = (typeof TOP_TYPES)[number];
/** Type d'un titre une fois identifié : film ou série. */
export type TopKind = 'movie' | 'tv';
/** Fenêtre des tendances : la semaine (rangées films et séries) ou le jour (rangée mêlée). */
export type TopWindow = 'week' | 'day';

/** Fenêtre de chaque rangée. Une autre valeur du paramètre `window` est refusée (cf. topWindowOf). */
const WINDOW_OF: Record<TopType, TopWindow> = { movie: 'week', tv: 'week', all: 'day' };

export function isTopType(value: string): value is TopType {
  return (TOP_TYPES as readonly string[]).includes(value);
}

/** Fenêtre d'une rangée pour la valeur demandée (absente : celle de la rangée) ; null si elle ne lui correspond pas. */
export function topWindowOf(type: TopType, requested: string | undefined): TopWindow | null {
  const expected = WINDOW_OF[type];
  return requested === undefined || requested === expected ? expected : null;
}

/** Titres attendus par rangée : la réponse en compte exactement TOP_SIZE quand les sources le permettent. */
const TOP_SIZE = 10;
/** Pages de liste TMDB lues au plus par requête, toutes sources confondues. */
const MAX_PAGES = 8;
/** Types de sortie TMDB comptés comme disponibles chez soi : numérique (4) et physique (5). */
const DIGITAL_RELEASE_TYPES: readonly number[] = [4, 5];
/** Fournisseurs disponibles sans achat : abonnement, gratuit, publicité. */
const DIRECT_KINDS = ['flatrate', 'free', 'ads'] as const;
/** Fraîcheur d'un film : date de sortie dans les derniers jours. Borne aussi la découverte régionale des films. */
const FRESH_MOVIE_DAYS = 365;
/** Fraîcheur d'une série : première diffusion dans les derniers jours. Borne aussi la découverte régionale des séries. */
const FRESH_SERIES_DAYS = 365;
/** Nouvelle saison : la saison la plus récente déjà diffusée (numéro > 0) a commencé dans les derniers jours. */
const NEW_SEASON_DAYS = 120;
/** Série fleuve : plus de LONG_RUNNER_EPISODES épisodes et première diffusion plus vieille que LONG_RUNNER_YEARS ans. */
const LONG_RUNNER_EPISODES = 100;
const LONG_RUNNER_YEARS = 3;
/** Genres TV écartés (détail `genres[].id`) : actualités, téléréalité, feuilleton, talk-show. */
const EXCLUDED_TV_GENRES: readonly number[] = [10763, 10764, 10766, 10767];
/** Détails TMDB lus en parallèle par lot (une page de tendances en compte 20). */
const CHECK_BATCH = 5;
/** Durée d'un jour en millisecondes. */
const DAY_MS = 24 * 3600e3;

type Json = Record<string, unknown>;

/** Page du Top 10 : `raw` titres reçus de TMDB en lisant les pages (0 : rien à lire à partir de `page`), `results` titres disponibles retenus (10 au plus). */
export interface Top10Page {
  page: number;
  raw: number;
  results: Json[];
}

/** Date AAAA-MM-JJ d'une valeur TMDB, ou null si absente ou mal formée. */
function isoDay(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** Date passée ou aujourd'hui (AAAA-MM-JJ) ; absente : non. */
function releasedBy(value: unknown, today: string): boolean {
  const day = isoDay(value);
  return day !== null && day <= today;
}

/** Date comprise entre `from` et `to` (bornes incluses, AAAA-MM-JJ) ; absente ou mal formée : non. */
function within(value: unknown, from: string, to: string): boolean {
  const day = isoDay(value);
  return day !== null && day >= from && day <= to;
}

/** Jour AAAA-MM-JJ décalé de `days` jours (négatif : dans le passé). */
export function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Jour AAAA-MM-JJ d'il y a `years` ans. */
function yearsBefore(day: string, years: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

/** Dates de sortie d'une région (`release_dates` de TMDB) ; à défaut, celles des États-Unis. */
function usableReleases(detail: Json, region: string): Json[] {
  const block = detail.release_dates;
  const entries = isRecord(block) && Array.isArray(block.results) ? block.results.filter(isRecord) : [];
  const datesOf = (code: string): Json[] => {
    const entry = entries.find((r) => r.iso_3166_1 === code);
    return entry !== undefined && Array.isArray(entry.release_dates) ? entry.release_dates.filter(isRecord) : [];
  };
  const own = datesOf(region);
  return own.length > 0 ? own : datesOf('US');
}

/** Au moins un abonnement, une offre gratuite ou publicitaire dans la région (location et achat exclus). */
function hasDirectProviderIn(detail: Json, region: string): boolean {
  const block = detail['watch/providers'];
  if (!isRecord(block) || !isRecord(block.results)) return false;
  const country = block.results[region];
  if (!isRecord(country)) return false;
  return DIRECT_KINDS.some((kind) => {
    const list = country[kind];
    return Array.isArray(list) && list.length > 0;
  });
}

/** Sortie numérique ou physique déjà passée dans la région (repli US). */
function digitalReleased(detail: Json, region: string, today: string): boolean {
  return usableReleases(detail, region).some((r) => typeof r.type === 'number' && DIGITAL_RELEASE_TYPES.includes(r.type) && releasedBy(r.release_date, today));
}

/**
 * Film disponible : abonnement, gratuit ou publicitaire dans la région, ou sortie numérique / physique passée. Le détail doit
 * porter `release_dates` et `watch/providers` (append_to_response).
 */
export function movieAvailable(detail: Json, region: string, today: string): boolean {
  return hasDirectProviderIn(detail, region) || digitalReleased(detail, region, today);
}

/** Film frais : date de sortie du détail (`release_date`) dans les FRESH_MOVIE_DAYS derniers jours, jusqu'à aujourd'hui. */
export function movieFresh(detail: Json, today: string): boolean {
  return within(detail.release_date, shiftDays(today, -FRESH_MOVIE_DAYS), today);
}

/** Série avec au moins un épisode diffusé : première diffusion passée, ou dernier épisode diffusé passé. */
export function seriesAired(detail: Json, today: string): boolean {
  const last = detail.last_episode_to_air;
  const lastAirDate = isRecord(last) ? last.air_date : undefined;
  return releasedBy(detail.first_air_date, today) || releasedBy(lastAirDate, today);
}

/** Numéro de saison TMDB, 0 si absent (les spéciaux, numéro 0, ne comptent pas). */
function seasonNumberOf(season: Json): number {
  return typeof season.season_number === 'number' ? season.season_number : 0;
}

/** Saison la plus récente déjà diffusée (numéro > 0, date de diffusion passée ou aujourd'hui), ou null. Les saisons à venir sont ignorées. */
function latestAiredSeason(detail: Json, today: string): Json | null {
  const seasons = Array.isArray(detail.seasons) ? detail.seasons.filter(isRecord) : [];
  const aired = seasons.filter((season) => seasonNumberOf(season) > 0 && releasedBy(season.air_date, today));
  return aired.length > 0 ? aired.reduce((latest, season) => (seasonNumberOf(season) > seasonNumberOf(latest) ? season : latest)) : null;
}

/** Nouvelle saison : la saison la plus récente déjà diffusée a commencé dans les NEW_SEASON_DAYS derniers jours. */
function hasNewSeason(detail: Json, today: string): boolean {
  const season = latestAiredSeason(detail, today);
  return season !== null && within(season.air_date, shiftDays(today, -NEW_SEASON_DAYS), today);
}

/** Série fraîche : première diffusion dans les FRESH_SERIES_DAYS derniers jours, ou nouvelle saison récente. */
export function seriesFresh(detail: Json, today: string): boolean {
  return within(detail.first_air_date, shiftDays(today, -FRESH_SERIES_DAYS), today) || hasNewSeason(detail, today);
}

/**
 * Série fleuve (feuilleton, dessin animé au long cours) : plus de LONG_RUNNER_EPISODES épisodes et première diffusion plus
 * vieille que LONG_RUNNER_YEARS ans. Première diffusion absente : ancienneté inconnue, donc écartée comme fleuve.
 */
export function isLongRunner(detail: Json, today: string): boolean {
  const episodes = typeof detail.number_of_episodes === 'number' ? detail.number_of_episodes : 0;
  if (episodes <= LONG_RUNNER_EPISODES) return false;
  const day = isoDay(detail.first_air_date);
  return day === null || day < yearsBefore(today, LONG_RUNNER_YEARS);
}

/** Genre TV écarté (actualités, téléréalité, feuilleton, talk-show) parmi les genres du détail. */
export function hasExcludedTvGenre(detail: Json): boolean {
  const genres = Array.isArray(detail.genres) ? detail.genres.filter(isRecord) : [];
  return genres.some((genre) => typeof genre.id === 'number' && EXCLUDED_TV_GENRES.includes(genre.id));
}

/** Détail TMDB du titre, puis verdict de disponibilité et de fraîcheur. Une erreur amont écarte le titre (jamais affiché sans preuve). */
async function isAvailable(ctx: LtContext, token: string, kind: TopKind, item: Json, region: string, today: string): Promise<boolean> {
  const id = item.id;
  if (typeof id !== 'number') return false;
  try {
    if (kind === 'movie') {
      const detail = await tmdbGet(ctx, token, `movie/${id}`, { append_to_response: 'release_dates,watch/providers' });
      return isRecord(detail) && movieAvailable(detail, region, today) && movieFresh(detail, today);
    }
    const detail = await tmdbGet(ctx, token, `tv/${id}`);
    return (
      isRecord(detail) &&
      seriesAired(detail, today) &&
      seriesFresh(detail, today) &&
      !isLongRunner(detail, today) &&
      !hasExcludedTvGenre(detail)
    );
  } catch {
    return false;
  }
}

/** Type d'un titre dans la rangée : celui de la rangée, ou celui que TMDB donne pour la rangée mêlée (personnes écartées). */
function kindOf(type: TopType, item: Json): TopKind | null {
  if (type !== 'all') return type;
  return item.media_type === 'movie' || item.media_type === 'tv' ? item.media_type : null;
}

/** Source de liste TMDB : chemin et paramètres propres ; le numéro de page s'y ajoute à la lecture. */
export interface ListSource {
  path: string;
  params: Record<string, string>;
}

/**
 * Paramètres de la découverte régionale récente : titres diffusés chez soi dans la région (abonnement, gratuit ou
 * publicité), sortis dans la fenêtre fraîche (FRESH_MOVIE_DAYS ou FRESH_SERIES_DAYS jusqu'à aujourd'hui), les plus populaires.
 * Séries : les genres TV écartés sont retirés côté TMDB.
 */
export function discoverParams(kind: TopKind, region: string, today: string): Record<string, string> {
  const dateField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
  const days = kind === 'movie' ? FRESH_MOVIE_DAYS : FRESH_SERIES_DAYS;
  const params: Record<string, string> = {
    watch_region: region,
    with_watch_monetization_types: DIRECT_KINDS.join('|'),
    sort_by: 'popularity.desc',
    include_adult: 'false',
    [`${dateField}.gte`]: shiftDays(today, -days),
    [`${dateField}.lte`]: today,
  };
  if (kind === 'tv') params.without_genres = EXCLUDED_TV_GENRES.join(',');
  return params;
}

/**
 * Sources lues dans l'ordre. Semaine (films, séries) : tendances de la semaine, découverte régionale récente, populaires.
 * Jour (`all`) : tendances du jour, puis tendances de la semaine.
 */
export function sourcesOf(type: TopType, region: string, today: string): ListSource[] {
  if (type === 'all') {
    return [
      { path: 'trending/all/day', params: {} },
      { path: 'trending/all/week', params: {} },
    ];
  }
  return [
    { path: `trending/${type}/week`, params: {} },
    { path: `discover/${type}`, params: discoverParams(type, region, today) },
    { path: `${type}/popular`, params: {} },
  ];
}

/** Titres d'une page de liste TMDB (tendances, découverte ou populaires), sans les entrées mal formées. */
async function listPage(ctx: LtContext, token: string, source: ListSource, page: number): Promise<Json[]> {
  const json = await tmdbGet(ctx, token, source.path, { ...source.params, page: String(page) });
  return isRecord(json) && Array.isArray(json.results) ? json.results.filter(isRecord).filter((r) => typeof r.id === 'number') : [];
}

/**
 * Jusqu'à dix titres disponibles et récents, en lisant les pages à partir de `page` : sources de la rangée dans l'ordre, au
 * plus MAX_PAGES pages au total. Une page vide termine sa source. Chaque titre n'est vérifié qu'une fois, par lots de
 * CHECK_BATCH appels simultanés ; la lecture s'arrête dès que la rangée est pleine.
 */
async function buildTop10Page(ctx: LtContext, token: string, type: TopType, region: string, page: number, today: string): Promise<Top10Page> {
  // Un titre est identifié par son type et son numéro : un film et une série peuvent porter le même numéro TMDB.
  const checked = new Set<string>();
  const results: Json[] = [];
  let raw = 0;
  let pagesRead = 0;
  for (const source of sourcesOf(type, region, today)) {
    for (let current = page; pagesRead < MAX_PAGES && results.length < TOP_SIZE; current++) {
      pagesRead++;
      const received = await listPage(ctx, token, source, current);
      if (received.length === 0) break;
      raw += received.length;
      const fresh: Array<{ kind: TopKind; item: Json }> = [];
      for (const item of received) {
        const kind = kindOf(type, item);
        if (kind === null) continue;
        const key = `${kind}:${item.id as number}`;
        if (checked.has(key)) continue;
        checked.add(key);
        fresh.push({ kind, item });
      }
      for (let i = 0; i < fresh.length && results.length < TOP_SIZE; i += CHECK_BATCH) {
        const batch = fresh.slice(i, i + CHECK_BATCH);
        const keep = await Promise.all(batch.map(({ kind, item }) => isAvailable(ctx, token, kind, item, region, today)));
        batch.forEach(({ item }, j) => {
          if (keep[j] === true && results.length < TOP_SIZE) results.push(item);
        });
      }
    }
  }
  return { page, raw, results };
}

/** Date du jour (AAAA-MM-JJ, UTC) pour les règles « déjà sorti » et « récent », et pour la clé de cache. */
export function todayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Top 10 à partir de la page `page`, en cache partagé : durée des tendances TMDB pour la semaine, une heure pour le jour.
 * La date du jour fait partie de la clé : une sortie du jour ne reste pas écartée après minuit. La version de la clé
 * (v3 : filtres de fraîcheur, découverte régionale) change avec les règles : les anciennes entrées ne sont plus lues.
 */
export function top10Page(ctx: LtContext, token: string, type: TopType, region: string, page: number, now: number): Promise<Top10Page> {
  const today = todayOf(now);
  const ttl = WINDOW_OF[type] === 'day' ? TTL.tmdbDay : TTL.tmdbFast;
  return ctx.state.cache.get(`top10v3:${type}:${region}:${today}:${page}`, ttl, () => buildTop10Page(ctx, token, type, region, page, today), {
    provider: 'tmdb',
    swr: true,
  });
}
