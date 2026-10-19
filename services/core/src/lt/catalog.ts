import { isRecord } from '../sources/http.js';
import { recordAt, type LtContext } from './context.js';
import { tmdbGet, tmdbTtl } from './providers.js';

/**
 * Catalogues Stremio alimentés par TMDB. Chaque entrée renvoie des métas identifiées par l'id IMDb (tt…),
 * pour que le pipeline de métadonnées existant de Stremio et de Laststream prenne le relais.
 */
export const CATALOGS = [
  { id: 'lastaddon-trending', type: 'movie', name: 'lastAddon · Tendances', path: 'trending/all/week', kind: 'mixed' },
  { id: 'lastaddon-popular-movies', type: 'movie', name: 'Films populaires', path: 'movie/popular', kind: 'movie' },
  { id: 'lastaddon-popular-series', type: 'series', name: 'Séries populaires', path: 'tv/popular', kind: 'tv' },
] as const;

export type CatalogDef = (typeof CATALOGS)[number];

export interface StremioMeta {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string;
  description?: string;
  releaseInfo?: string;
}

const PAGE_SIZE = 20;
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const EXTERNAL_IDS_BATCH = 8;
const IMDB_ID = /^tt\d+$/;

/** Entrée `manifest.catalogs` pour chaque catalogue (pagination par `skip`). */
export function catalogEntries(): { type: string; id: string; name: string; extra: { name: string; isRequired: boolean }[] }[] {
  return CATALOGS.map((c) => ({ type: c.type, id: c.id, name: c.name, extra: [{ name: 'skip', isRequired: false }] }));
}

export function findCatalog(type: string, id: string): CatalogDef | undefined {
  return CATALOGS.find((c) => c.type === type && c.id === id);
}

/** `skip` tiré du paramètre Stremio (`skip=40`), 0 si absent ou hors bornes. */
export function parseSkip(extra: string | undefined): number {
  if (extra === undefined || extra === '') return 0;
  const raw = new URLSearchParams(extra).get('skip');
  const value = raw === null ? 0 : Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 10000 ? value : 0;
}

/** Exécute `fn` par lots de `size` appels simultanés, dans l'ordre des éléments. */
async function mapBatched<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

interface TmdbItem {
  id: number;
  kind: 'movie' | 'tv';
  raw: Record<string, unknown>;
}

/** Entrée TMDB → kind (movie ou tv), ou null si l'élément n'est pas un film ni une série. */
function itemsOf(def: CatalogDef, results: Record<string, unknown>[]): TmdbItem[] {
  const items: TmdbItem[] = [];
  for (const raw of results) {
    if (typeof raw.id !== 'number') continue;
    const kind = def.kind === 'mixed' ? (raw.media_type === 'movie' || raw.media_type === 'tv' ? raw.media_type : null) : def.kind;
    if (kind === null) continue;
    items.push({ id: raw.id, kind, raw });
  }
  return items;
}

/** Id IMDb d'un élément TMDB, ou null (élément ignoré). Un échec ne fait pas échouer le catalogue. */
async function imdbIdOf(ctx: LtContext, token: string, item: TmdbItem): Promise<string | null> {
  try {
    const ids = await tmdbGet(ctx, token, `${item.kind}/${item.id}/external_ids`);
    const imdb = recordAt(ids).imdb_id;
    return typeof imdb === 'string' && IMDB_ID.test(imdb) ? imdb : null;
  } catch {
    return null;
  }
}

function toMeta(item: TmdbItem, imdbId: string): StremioMeta | null {
  const raw = item.raw;
  const title = item.kind === 'movie' ? raw.title : raw.name;
  if (typeof title !== 'string' || title === '') return null;
  const date = item.kind === 'movie' ? raw.release_date : raw.first_air_date;
  const year = typeof date === 'string' ? /^\d{4}/.exec(date)?.[0] : undefined;
  const meta: StremioMeta = { id: imdbId, type: item.kind === 'movie' ? 'movie' : 'series', name: title };
  if (typeof raw.poster_path === 'string' && raw.poster_path !== '') meta.poster = POSTER_BASE + raw.poster_path;
  if (typeof raw.overview === 'string' && raw.overview !== '') meta.description = raw.overview;
  if (year !== undefined) meta.releaseInfo = year;
  return meta;
}

/** Page (1 à n) du catalogue correspondant à `skip` (20 éléments TMDB par page). */
export function catalogPage(skip: number): number {
  return Math.floor(skip / PAGE_SIZE) + 1;
}

/**
 * Métas d'une page du catalogue, lues chez TMDB sans passer par le cache (le cron s'en sert pour rafraîchir les
 * rangées). Les ids IMDb sont résolus par lots, en cache (durée TMDB). Doublons et éléments sans id IMDb sont retirés.
 */
export async function buildCatalogMetas(ctx: LtContext, token: string, def: CatalogDef, page: number): Promise<StremioMeta[]> {
  const json = await tmdbGet(ctx, token, def.path, { page: String(page) });
  const results: Record<string, unknown>[] = isRecord(json) && Array.isArray(json.results) ? json.results.filter(isRecord) : [];
  const items = itemsOf(def, results);
  const imdbIds = await mapBatched(items, EXTERNAL_IDS_BATCH, (item) => imdbIdOf(ctx, token, item));
  const seen = new Set<string>();
  const metas: StremioMeta[] = [];
  items.forEach((item, index) => {
    const imdbId = imdbIds[index];
    if (imdbId === null || imdbId === undefined || seen.has(imdbId)) return;
    const meta = toMeta(item, imdbId);
    if (meta === null) return;
    seen.add(imdbId);
    metas.push(meta);
  });
  return metas;
}

/**
 * Métas d'une page du catalogue (20 éléments TMDB par page), en cache (durée TMDB). Voir `buildCatalogMetas`.
 */
export async function catalogMetas(ctx: LtContext, token: string, def: CatalogDef, skip: number): Promise<StremioMeta[]> {
  const page = catalogPage(skip);
  return ctx.state.cache.get(`catalog:${def.id}:${page}`, tmdbTtl(def.path), () => buildCatalogMetas(ctx, token, def, page), {
    provider: 'tmdb',
    swr: true,
  });
}
