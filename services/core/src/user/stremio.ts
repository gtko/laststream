import { getJson, type LtContext, LtError, recordAt } from '../lt/context.js';
import { tmdbGet } from '../lt/providers.js';
import { isRecord } from '../sources/http.js';
import { isFinished } from './progress.js';
import type { MediaType } from './store.js';
import type { UserRepo } from './repo.js';

/**
 * Import de la bibliothèque et de la progression depuis un compte Stremio. Les identifiants Stremio servent une
 * seule fois, pour obtenir l'authKey ; ni l'un ni l'autre n'est stocké ni journalisé.
 */

const STREMIO_API = 'https://api.strem.io/api';
const STREMIO_TIMEOUT_MS = 20_000;
const TMDB_CONCURRENCY = 5;
const IMDB_ID = /^tt\d{1,10}$/;
/** video_id Stremio d'un épisode : « tt0944947:1:3 ». */
const SERIES_VIDEO_ID = /^(tt\d{1,10}):(\d{1,4}):(\d{1,4})$/;
/** Nombre maximal d'entrées traitées par import ; au-delà, les entrées sont ignorées et signalées (truncated). */
const MAX_IMPORT_ITEMS = 5000;
/** Statuts amont qui signifient des identifiants refusés (et non un service indisponible). */
const AUTH_REJECTED_CODES: ReadonlySet<string> = new Set(['upstream_400', 'upstream_401', 'upstream_403']);

export class StremioImportError extends Error {
  readonly code: 'stremio_login_failed' | 'stremio_unavailable';

  constructor(code: 'stremio_login_failed' | 'stremio_unavailable') {
    super(code);
    this.name = 'StremioImportError';
    this.code = code;
  }
}

interface MappedLibraryEntry {
  type: MediaType;
  imdbId: string;
  title: string;
  poster: string | null;
  addedAt: string;
}

interface MappedProgressEntry {
  type: MediaType;
  imdbId: string;
  season: number;
  episode: number;
  positionSec: number;
  durationSec: number;
  updatedAt: string;
}

interface MappedStremioItems {
  library: MappedLibraryEntry[];
  progress: MappedProgressEntry[];
  /** Entrées ignorées : supprimées, types non pris en charge, identifiants illisibles. */
  skipped: number;
}

export interface StremioImportResult {
  library: number;
  progress: number;
  skipped: number;
  tmdbResolved: number;
  /** Vrai si la bibliothèque dépassait MAX_IMPORT_ITEMS (les entrées en trop sont comptées dans skipped). */
  truncated: boolean;
}

async function stremioCall(ctx: LtContext, method: string, payload: Record<string, unknown>): Promise<unknown> {
  return getJson(
    ctx,
    `${STREMIO_API}/${method}`,
    { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) },
    STREMIO_TIMEOUT_MS,
  );
}

/** Connexion Stremio puis lecture de la bibliothèque. Les erreurs n'exposent ni le corps ni les identifiants. */
async function fetchStremioLibrary(ctx: LtContext, email: string, password: string): Promise<unknown[]> {
  let login: unknown;
  try {
    login = await stremioCall(ctx, 'login', { type: 'Login', email, password, facts: {} });
  } catch (err) {
    const rejected = err instanceof LtError && AUTH_REJECTED_CODES.has(err.code);
    throw new StremioImportError(rejected ? 'stremio_login_failed' : 'stremio_unavailable');
  }
  const authKey = recordAt(login, 'result').authKey;
  if (typeof authKey !== 'string' || authKey === '') throw new StremioImportError('stremio_login_failed');

  let data: unknown;
  try {
    data = await stremioCall(ctx, 'datastoreGet', { type: 'DatastoreGet', authKey, collection: 'libraryItem', all: true });
  } catch {
    throw new StremioImportError('stremio_unavailable');
  }
  if (!isRecord(data) || !Array.isArray(data.result)) throw new StremioImportError('stremio_unavailable');
  return data.result as unknown[];
}

function isoOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const time = Date.parse(value);
  return Number.isNaN(time) ? fallback : new Date(time).toISOString();
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function posterOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Transforme les entrées libraryItem Stremio en bibliothèque et progression. Les temps Stremio sont en millisecondes.
 * Une série n'a de progression que si son video_id désigne un épisode de la même série.
 */
function mapStremioLibrary(items: readonly unknown[], now: string): MappedStremioItems {
  const library: MappedLibraryEntry[] = [];
  const progress: MappedProgressEntry[] = [];
  let skipped = 0;
  for (const raw of items) {
    if (!isRecord(raw) || raw.removed === true) {
      skipped += 1;
      continue;
    }
    const type = raw.type === 'movie' || raw.type === 'series' ? raw.type : undefined;
    const imdbId = typeof raw._id === 'string' && IMDB_ID.test(raw._id) ? raw._id : undefined;
    if (type === undefined || imdbId === undefined) {
      skipped += 1;
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : '';
    library.push({
      type,
      imdbId,
      title: name === '' ? imdbId : name,
      poster: posterOrNull(raw.poster),
      addedAt: isoOr(raw._ctime, now),
    });

    const state = recordAt(raw, 'state');
    const durationSec = nonNegativeNumber(state.duration) / 1000;
    const positionSec = nonNegativeNumber(state.timeOffset) / 1000;
    if (durationSec === 0 && positionSec === 0) continue;
    let season = 0;
    let episode = 0;
    if (type === 'series') {
      const match = typeof state.video_id === 'string' ? SERIES_VIDEO_ID.exec(state.video_id) : null;
      if (match === null || match[1] !== imdbId) continue;
      season = Number(match[2]);
      episode = Number(match[3]);
    }
    progress.push({
      type,
      imdbId,
      season,
      episode,
      positionSec: durationSec > 0 ? Math.min(positionSec, durationSec) : positionSec,
      durationSec,
      updatedAt: isoOr(state.lastWatched, isoOr(raw._mtime, now)),
    });
  }
  return { library, progress, skipped };
}

async function findTmdbId(ctx: LtContext, token: string, type: MediaType, imdbId: string): Promise<number | undefined> {
  try {
    const body = await tmdbGet(ctx, token, `find/${imdbId}`, { external_source: 'imdb_id' });
    const results = isRecord(body) ? body[type === 'movie' ? 'movie_results' : 'tv_results'] : undefined;
    const first: unknown = Array.isArray(results) ? results[0] : undefined;
    const id = isRecord(first) ? first.id : undefined;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
  } catch {
    // Résolution best effort : sans identifiant TMDB, le titre reste référencé par son identifiant IMDb.
    return undefined;
  }
}

async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(runners);
}

/** Identifiants TMDB des titres (clé `type:imdb`), quand un jeton TMDB est disponible. */
async function resolveTmdbIds(
  ctx: LtContext,
  token: string,
  titles: readonly { type: MediaType; imdbId: string }[],
): Promise<Map<string, number>> {
  const unique = new Map<string, { type: MediaType; imdbId: string }>();
  for (const title of titles) unique.set(`${title.type}:${title.imdbId}`, title);
  const resolved = new Map<string, number>();
  await mapLimit([...unique.entries()], TMDB_CONCURRENCY, async ([key, title]) => {
    const id = await findTmdbId(ctx, token, title.type, title.imdbId);
    if (id !== undefined) resolved.set(key, id);
  });
  return resolved;
}

export interface StremioImportInput {
  store: UserRepo;
  ctx: LtContext;
  profileId: string;
  email: string;
  password: string;
  tmdbToken: string | undefined;
  now: string;
}

/** Import complet : connexion, lecture, résolution TMDB (si possible), puis écriture en une transaction. */
export async function importStremioLibrary(input: StremioImportInput): Promise<StremioImportResult> {
  const received = await fetchStremioLibrary(input.ctx, input.email, input.password);
  const truncated = received.length > MAX_IMPORT_ITEMS;
  const items = truncated ? received.slice(0, MAX_IMPORT_ITEMS) : received;
  const mapped = mapStremioLibrary(items, input.now);
  if (truncated) mapped.skipped += received.length - MAX_IMPORT_ITEMS;
  const titles = [...mapped.library, ...mapped.progress];
  const tmdbIds = input.tmdbToken === undefined ? new Map<string, number>() : await resolveTmdbIds(input.ctx, input.tmdbToken, titles);
  const tmdbFor = (type: MediaType, imdbId: string): number | null => tmdbIds.get(`${type}:${imdbId}`) ?? null;

  await input.store.importMany(
    mapped.library.map((entry) => ({
      profileId: input.profileId,
      type: entry.type,
      tmdbId: tmdbFor(entry.type, entry.imdbId),
      imdbId: entry.imdbId,
      title: entry.title,
      poster: entry.poster,
      addedAt: entry.addedAt,
    })),
    mapped.progress.map((entry) => ({
      profileId: input.profileId,
      type: entry.type,
      tmdbId: tmdbFor(entry.type, entry.imdbId),
      imdbId: entry.imdbId,
      season: entry.season,
      episode: entry.episode,
      positionSec: entry.positionSec,
      durationSec: entry.durationSec,
      updatedAt: entry.updatedAt,
      finished: isFinished(entry.positionSec, entry.durationSec),
    })),
  );

  return {
    library: mapped.library.length,
    progress: mapped.progress.length,
    skipped: mapped.skipped,
    tmdbResolved: tmdbIds.size,
    truncated,
  };
}
