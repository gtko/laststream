import { isRecord } from '../sources/http.js';
import { TTL, type LtContext } from './context.js';
import { tmdbGet } from './providers.js';

/**
 * Top 10 de l'accueil : jusqu'à dix titres disponibles dans la région, calculés côté serveur, partagés entre les comptes
 * et mis en cache (le client ne vérifie plus chaque tuile).
 *  - rangées de la semaine (`movie`, `tv`) : tendances de la semaine, puis populaires si la semaine ne suffit pas ; au
 *    plus MAX_PAGES pages lues au total, titres dédupliqués, dans l'ordre de popularité ;
 *  - rangée du jour (`all`) : tendances du jour, films et séries mêlés dans l'ordre de popularité (une seule source) ;
 *  - film : un abonnement, une offre gratuite ou publicitaire dans la région, ou une sortie numérique (type 4) ou
 *    physique (type 5) déjà passée (repli US si la région n'a aucune date). La location et l'achat ne comptent pas à
 *    part : une précommande (sortie numérique future) n'est pas disponible ;
 *  - série : au moins un épisode diffusé (première diffusion ou dernier épisode passés).
 * Une simple sortie en salle ne suffit pas. Sans donnée TMDB exploitable, le titre est écarté.
 */

/** Rangées servies : films et séries (tendances de la semaine), ou les deux mêlés (tendances du jour). */
export const TOP_TYPES = ['movie', 'tv', 'all'] as const;
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
const MAX_PAGES = 5;
/** Types de sortie TMDB comptés comme disponibles chez soi : numérique (4) et physique (5). */
const DIGITAL_RELEASE_TYPES: readonly number[] = [4, 5];
/** Fournisseurs disponibles sans achat : abonnement, gratuit, publicité. */
const DIRECT_KINDS = ['flatrate', 'free', 'ads'] as const;
/** Détails TMDB lus en parallèle par lot (une page de tendances en compte 20). */
const CHECK_BATCH = 5;

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

/** Série avec au moins un épisode diffusé : première diffusion passée, ou dernier épisode diffusé passé. */
export function seriesAired(detail: Json, today: string): boolean {
  const last = detail.last_episode_to_air;
  const lastAirDate = isRecord(last) ? last.air_date : undefined;
  return releasedBy(detail.first_air_date, today) || releasedBy(lastAirDate, today);
}

/** Détail TMDB du titre, puis verdict de disponibilité. Une erreur amont écarte le titre (jamais affiché sans preuve). */
async function isAvailable(ctx: LtContext, token: string, kind: TopKind, item: Json, region: string, today: string): Promise<boolean> {
  const id = item.id;
  if (typeof id !== 'number') return false;
  try {
    if (kind === 'movie') {
      const detail = await tmdbGet(ctx, token, `movie/${id}`, { append_to_response: 'release_dates,watch/providers' });
      return isRecord(detail) && movieAvailable(detail, region, today);
    }
    const detail = await tmdbGet(ctx, token, `tv/${id}`);
    return isRecord(detail) && seriesAired(detail, today);
  } catch {
    return false;
  }
}

/** Type d'un titre dans la rangée : celui de la rangée, ou celui que TMDB donne pour la rangée mêlée (personnes écartées). */
function kindOf(type: TopType, item: Json): TopKind | null {
  if (type !== 'all') return type;
  return item.media_type === 'movie' || item.media_type === 'tv' ? item.media_type : null;
}

/** Titres d'une page de liste TMDB (tendances ou populaires), sans les entrées mal formées. */
async function listPage(ctx: LtContext, token: string, path: string, page: number): Promise<Json[]> {
  const json = await tmdbGet(ctx, token, path, { page: String(page) });
  return isRecord(json) && Array.isArray(json.results) ? json.results.filter(isRecord).filter((r) => typeof r.id === 'number') : [];
}

/** Sources lues dans l'ordre : tendances de la semaine puis populaires ; la rangée du jour n'a que les tendances du jour. */
function sourcesOf(type: TopType): string[] {
  return type === 'all' ? ['trending/all/day'] : [`trending/${type}/week`, `${type}/popular`];
}

/**
 * Jusqu'à dix titres disponibles, en lisant les pages à partir de `page` : sources de la rangée dans l'ordre, au plus
 * MAX_PAGES pages au total. Une page vide termine sa source. Chaque titre n'est vérifié qu'une fois, par lots de
 * CHECK_BATCH appels simultanés ; la lecture s'arrête dès que la rangée est pleine.
 */
export async function buildTop10Page(ctx: LtContext, token: string, type: TopType, region: string, page: number, today: string): Promise<Top10Page> {
  // Un titre est identifié par son type et son numéro : un film et une série peuvent porter le même numéro TMDB.
  const checked = new Set<string>();
  const results: Json[] = [];
  let raw = 0;
  let pagesRead = 0;
  for (const path of sourcesOf(type)) {
    for (let current = page; pagesRead < MAX_PAGES && results.length < TOP_SIZE; current++) {
      pagesRead++;
      const received = await listPage(ctx, token, path, current);
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

/** Date du jour (AAAA-MM-JJ, UTC) pour les règles « déjà sorti » et la clé de cache. */
export function todayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Top 10 à partir de la page `page`, en cache partagé : durée des tendances TMDB pour la semaine, une heure pour le jour.
 * La date du jour fait partie de la clé : une sortie du jour ne reste pas écartée après minuit. La version de la clé
 * change avec le format de la réponse (une page seule, avant le remplissage) : les anciennes entrées ne sont plus lues.
 */
export function top10Page(ctx: LtContext, token: string, type: TopType, region: string, page: number, now: number): Promise<Top10Page> {
  const today = todayOf(now);
  const ttl = WINDOW_OF[type] === 'day' ? TTL.tmdbDay : TTL.tmdbFast;
  return ctx.state.cache.get(`top10v2:${type}:${region}:${today}:${page}`, ttl, () => buildTop10Page(ctx, token, type, region, page, today), {
    provider: 'tmdb',
    swr: true,
  });
}
