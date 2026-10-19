import { isRecord } from '../sources/http.js';
import { TTL, type LtContext } from './context.js';
import { tmdbGet } from './providers.js';

/**
 * Top 10 de l'accueil (films et séries) : une page des tendances de la semaine, ne gardant que les titres disponibles
 * dans la région. Calcul serveur, partagé entre les comptes et mis en cache (le client ne vérifie plus chaque tuile).
 *  - film : une sortie numérique (type 4) ou physique (type 5) déjà passée, dans la région (repli US si la région n'a
 *    aucune date), ou au moins un fournisseur dans la région (abonnement, gratuit, publicité, location, achat) ;
 *  - série : au moins un épisode diffusé (première diffusion ou dernier épisode passé).
 * Une simple sortie en salle ne suffit pas. Sans donnée TMDB exploitable, le titre est écarté.
 */

export const TOP_TYPES = ['movie', 'tv'] as const;
export type TopType = (typeof TOP_TYPES)[number];

export function isTopType(value: string): value is TopType {
  return (TOP_TYPES as readonly string[]).includes(value);
}

/** Types de sortie TMDB comptés comme disponibles chez soi : numérique (4) et physique (5). */
const DIGITAL_RELEASE_TYPES: readonly number[] = [4, 5];
const PROVIDER_KINDS = ['flatrate', 'free', 'ads', 'rent', 'buy'] as const;
/** Détails TMDB lus en parallèle par lot (une page de tendances en compte 20). */
const CHECK_BATCH = 5;

type Json = Record<string, unknown>;

/** Page de tendances filtrée : `raw` titres reçus de TMDB (0 : fin des tendances), `results` titres disponibles retenus. */
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

/** Au moins un fournisseur de streaming, gratuit, publicitaire, de location ou d'achat dans la région. */
function hasProviderIn(detail: Json, region: string): boolean {
  const block = detail['watch/providers'];
  if (!isRecord(block) || !isRecord(block.results)) return false;
  const country = block.results[region];
  if (!isRecord(country)) return false;
  return PROVIDER_KINDS.some((kind) => {
    const list = country[kind];
    return Array.isArray(list) && list.length > 0;
  });
}

/**
 * Film disponible : fournisseur dans la région, ou sortie numérique / physique passée. Le détail doit porter
 * `release_dates` et `watch/providers` (append_to_response).
 */
export function movieAvailable(detail: Json, region: string, today: string): boolean {
  if (hasProviderIn(detail, region)) return true;
  return usableReleases(detail, region).some((r) => typeof r.type === 'number' && DIGITAL_RELEASE_TYPES.includes(r.type) && releasedBy(r.release_date, today));
}

/** Série avec au moins un épisode diffusé : première diffusion passée, ou dernier épisode diffusé passé. */
export function seriesAired(detail: Json, today: string): boolean {
  const last = detail.last_episode_to_air;
  const lastAirDate = isRecord(last) ? last.air_date : undefined;
  return releasedBy(detail.first_air_date, today) || releasedBy(lastAirDate, today);
}

/** Lots de `size` appels simultanés, dans l'ordre des éléments (évite de saturer l'amont). */
async function mapBatched<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** Détail TMDB du titre, puis verdict de disponibilité. Une erreur amont écarte le titre (jamais affiché sans preuve). */
async function isAvailable(ctx: LtContext, token: string, type: TopType, item: Json, region: string, today: string): Promise<boolean> {
  const id = item.id;
  if (typeof id !== 'number') return false;
  try {
    if (type === 'movie') {
      const detail = await tmdbGet(ctx, token, `movie/${id}`, { append_to_response: 'release_dates,watch/providers' });
      return isRecord(detail) && movieAvailable(detail, region, today);
    }
    const detail = await tmdbGet(ctx, token, `tv/${id}`);
    return isRecord(detail) && seriesAired(detail, today);
  } catch {
    return false;
  }
}

/** Une page des tendances de la semaine (TMDB), filtrée sur la disponibilité. Le client complète avec la page suivante. */
export async function buildTop10Page(ctx: LtContext, token: string, type: TopType, region: string, page: number, today: string): Promise<Top10Page> {
  const json = await tmdbGet(ctx, token, `trending/${type}/week`, { page: String(page) });
  const raw = isRecord(json) && Array.isArray(json.results) ? json.results.filter(isRecord).filter((r) => typeof r.id === 'number') : [];
  const keep = await mapBatched(raw, CHECK_BATCH, (item) => isAvailable(ctx, token, type, item, region, today));
  return { page, raw: raw.length, results: raw.filter((_, i) => keep[i] === true) };
}

/** Date du jour (AAAA-MM-JJ, UTC) pour les règles « déjà sorti » et la clé de cache. */
export function todayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Page du Top 10, en cache partagé (durée des tendances TMDB). La date du jour fait partie de la clé : une sortie
 * du jour ne reste pas écartée après minuit.
 */
export function top10Page(ctx: LtContext, token: string, type: TopType, region: string, page: number, now: number): Promise<Top10Page> {
  const today = todayOf(now);
  return ctx.state.cache.get(`top10:${type}:${region}:${today}:${page}`, TTL.tmdbFast, () => buildTop10Page(ctx, token, type, region, page, today), {
    provider: 'tmdb',
    swr: true,
  });
}
