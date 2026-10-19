import { createHash } from 'node:crypto';
import { isRecord } from '../sources/http.js';
import type { MetaIndexRow, MetaIndexType } from '../user/meta-store.js';
import type { MetaRepo } from '../user/repo.js';
import { LtError, type LtContext, recordAt } from './context.js';
import { type SeriesEpisodes, seriesEpisodes } from './episodes.js';
import { mdblistRatings, type MdbRatings, tmdbGet, tvdbSeries } from './providers.js';

/**
 * Fiches partagées : détail d'un film ou d'une série (TMDB, TVDB, notes MDBList, casting, saisons et épisodes) assemblé
 * une fois, stocké dans R2 (`meta/<type>/<tmdbId>.json`) et servi à tous les comptes et profils. Le contenu ne contient
 * aucune donnée personnelle : ni profil, ni progression, ni clé de service (les clés ne servent qu'à construire la fiche).
 */

export type MetaType = 'movie' | 'series';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Durées de vie des fiches et des notes (ms). */
export const META_TTL = {
  /** Série terminée, ou film sorti depuis plus d'un an. */
  settled: 30 * DAY,
  /** Film récent ou sans date de sortie. */
  recentMovie: DAY,
  /** Série en cours sans date du prochain épisode. */
  unknownNextAir: DAY,
  /** Série en cours : jusqu'à la date du prochain épisode, bornée à [min, max]. */
  inProgressMin: 6 * HOUR,
  inProgressMax: 7 * DAY,
  /** Fiche incomplète (TVDB ou épisodes indisponibles) : nouvel essai plus tôt. */
  partial: HOUR,
  /** Notes : rafraîchies après 7 jours, ou après 1 jour quand la lecture a échoué. */
  ratings: 7 * DAY,
  ratingsRetry: DAY,
} as const;

/** Statuts TMDB d'une série terminée. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['Ended', 'Canceled']);
/** Âge (depuis la sortie) à partir duquel un film est considéré comme stable. */
const SETTLED_MOVIE_AGE = 365 * DAY;
/** Nombre maximal d'acteurs conservés dans la fiche. */
const CAST_LIMIT = 20;
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMDB_ID = /^tt\d{1,12}$/;
const TMDB_ID = /^[1-9]\d{0,8}$/;

/** Membre TVDB retenu dans la fiche (statut, saisons, dates de diffusion). */
export interface MetaTvdb {
  status: string;
  seasonCount: number;
  nextAired: string;
  lastAired: string;
}

export interface MetaCast {
  id: number;
  name: string;
  character: string | null;
  /** URL d'image TMDB (w185). */
  profile: string | null;
}

/** Fiche normalisée. Le JSON sérialisé de cet objet est le contenu stocké (et son empreinte, l'ETag). */
export interface MetaFiche {
  v: 1;
  type: MetaType;
  tmdbId: number;
  imdbId: string | null;
  tvdbId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  /** Date de sortie (films) ou de première diffusion (séries), AAAA-MM-JJ. */
  releaseDate: string | null;
  /** Statut TMDB (« Ended », « Returning Series », « Released »…). */
  status: string | null;
  /** Date du prochain épisode (séries en cours), AAAA-MM-JJ. */
  nextAirDate: string | null;
  overview: string | null;
  genres: string[];
  runtime: number | null;
  /** Affiche et image de fond : URL TMDB complètes. */
  poster: string | null;
  backdrop: string | null;
  cast: MetaCast[];
  /** Notes MDBList, ou null si indisponibles. */
  ratings: MdbRatings | null;
  /** Échéance de lecture des notes (ms epoch) : rafraîchies seules quand elle passe, sans reconstruire la fiche. */
  ratingsDueAt: number;
  tvdb: MetaTvdb | null;
  /** Saisons et épisodes (séries seulement, null pour un film). */
  episodes: SeriesEpisodes | null;
  /** Une source optionnelle a échoué : la fiche expire plus tôt. */
  partial: boolean;
}

/** Enregistrement stocké : contenu JSON, empreinte et échéance (métadonnées de l'objet R2). */
export interface MetaBlob {
  body: string;
  etag: string;
  expiresAt: number;
}

/** Stockage des fiches (R2 sous Workers). `put` réécrit l'objet entier ; `get` renvoie undefined s'il est absent. */
export interface MetaBlobStore {
  get(key: string): Promise<MetaBlob | undefined>;
  put(key: string, blob: MetaBlob): Promise<void>;
}

/** Clés de service utilisées pour construire une fiche. Absente : la partie concernée est omise (TMDB obligatoire). */
export interface MetaServices {
  tmdbToken: string | undefined;
  mdblistApiKey: string | undefined;
  tvdbApiKey: string | undefined;
  tvdbPin: string | undefined;
}

/** Ressources de la route : contexte lt, stockage R2 (absent : fiche construite à chaque demande), index, horloge. */
export interface MetaRuntime {
  ctx: LtContext;
  blobs: MetaBlobStore | undefined;
  index: () => MetaRepo;
  now: () => number;
  /** Travail après la réponse (Workers : waitUntil ; Node : sans suivi). */
  background: (work: Promise<unknown>) => void;
}

/** Résultat servi : contenu JSON, empreinte, échéance, et indication de contenu périmé (servi en attendant la reconstruction). */
export interface MetaResult {
  body: string;
  etag: string;
  expiresAt: number;
  stale: boolean;
}

/** Clé R2 d'une fiche. */
export function metaKey(type: MetaType, tmdbId: number): string {
  return `meta/${type}/${tmdbId}.json`;
}

/** Empreinte du contenu : ETag fort, 128 bits (hex), entre guillemets. */
export function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}

/** Début du jour UTC (ms epoch) : les échéances des notes s'y alignent, pour qu'une même fiche garde son empreinte le jour même. */
function dayStart(now: number): number {
  return Math.floor(now / DAY) * DAY;
}

/** Date AAAA-MM-JJ en ms epoch (minuit UTC), ou undefined. */
function dayMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !DATE.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Durée de vie d'une fiche (ms), selon son contenu :
 * - série terminée (statut TMDB ou TVDB « Ended ») : 30 jours ;
 * - série en cours : jusqu'à la date du prochain épisode, bornée à 6 h … 7 jours (24 h si la date est inconnue) ;
 * - film sorti depuis plus d'un an : 30 jours ; film récent ou sans date : 24 heures.
 * Une fiche incomplète (`partial`) expire au plus tard au bout d'une heure.
 */
export function metaTtlMs(fiche: Pick<MetaFiche, 'type' | 'status' | 'releaseDate' | 'nextAirDate' | 'tvdb' | 'partial'>, now: number): number {
  const ttl = ttlOf(fiche, now);
  return fiche.partial ? Math.min(ttl, META_TTL.partial) : ttl;
}

function ttlOf(fiche: Pick<MetaFiche, 'type' | 'status' | 'releaseDate' | 'nextAirDate' | 'tvdb'>, now: number): number {
  if (fiche.type === 'movie') {
    const released = dayMs(fiche.releaseDate);
    return released !== undefined && released <= now - SETTLED_MOVIE_AGE ? META_TTL.settled : META_TTL.recentMovie;
  }
  if (fiche.status !== null && ENDED_STATUSES.has(fiche.status)) return META_TTL.settled;
  if (fiche.tvdb?.status === 'Ended') return META_TTL.settled;
  const next = dayMs(fiche.nextAirDate);
  if (next === undefined) return META_TTL.unknownNextAir;
  return Math.min(META_TTL.inProgressMax, Math.max(META_TTL.inProgressMin, next - now));
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const dateOf = (value: unknown): string | null => (typeof value === 'string' && DATE.test(value) ? value : null);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const image = (size: string, path: unknown): string | null => {
  const p = str(path);
  return p === null ? null : `${TMDB_IMAGE}${size}${p}`;
};

/** Cible d'une route : type et identifiant TMDB validés. Entrée invalide : 404 not_found. */
export function metaTargetOf(type: string, tmdbId: string): { type: MetaType; tmdbId: number } {
  if ((type !== 'movie' && type !== 'series') || !TMDB_ID.test(tmdbId)) throw new LtError(404, 'not_found');
  return { type, tmdbId: Number(tmdbId) };
}

function requireTmdb(svc: MetaServices): string {
  if (svc.tmdbToken === undefined) throw new LtError(404, 'service_not_configured', 'tmdb');
  return svc.tmdbToken;
}

/** Notes : réutilisées tant que leur échéance n'est pas passée ; sinon lues chez MDBList (sans clé : repli sur les notes connues). */
async function ratingsFor(
  ctx: LtContext,
  svc: MetaServices,
  type: MetaType,
  imdbId: string | null,
  tmdbId: number,
  now: number,
  previous: MetaFiche | undefined,
): Promise<{ ratings: MdbRatings | null; dueAt: number }> {
  if (previous !== undefined && previous.ratingsDueAt > now) return { ratings: previous.ratings, dueAt: previous.ratingsDueAt };
  if (svc.mdblistApiKey === undefined) return { ratings: previous?.ratings ?? null, dueAt: dayStart(now) + META_TTL.ratingsRetry };
  try {
    const ratings = await mdblistRatings(ctx, svc.mdblistApiKey, type === 'movie' ? 'movie' : 'tv', imdbId ?? String(tmdbId));
    return { ratings, dueAt: dayStart(now) + META_TTL.ratings };
  } catch (err) {
    if (!(err instanceof LtError)) throw err;
    console.warn(`[lt][meta] notes indisponibles (statut amont : ${err.code})`);
    return { ratings: previous?.ratings ?? null, dueAt: dayStart(now) + META_TTL.ratingsRetry };
  }
}

/** Membre TVDB : absent sans clé ou sans identifiant ; une panne (hors 404) marque la fiche incomplète. */
async function tvdbFor(ctx: LtContext, svc: MetaServices, tvdbId: number | null): Promise<{ tvdb: MetaTvdb | null; failed: boolean }> {
  if (svc.tvdbApiKey === undefined || tvdbId === null) return { tvdb: null, failed: false };
  try {
    const series = await tvdbSeries(ctx, svc.tvdbApiKey, String(tvdbId), svc.tvdbPin);
    return { tvdb: { status: series.status, seasonCount: series.seasonCount, nextAired: series.nextAired, lastAired: series.lastAired }, failed: false };
  } catch (err) {
    if (!(err instanceof LtError)) throw err;
    console.warn(`[lt][meta] TVDB indisponible (statut amont : ${err.code})`);
    return { tvdb: null, failed: err.status !== 404 };
  }
}

/** Saisons et épisodes (séries) : même structure que la route /series/:tmdbId/episodes ; une panne marque la fiche incomplète. */
async function episodesFor(ctx: LtContext, svc: MetaServices, tmdbToken: string, tmdbId: number): Promise<{ episodes: SeriesEpisodes | null; failed: boolean }> {
  try {
    const episodes = await seriesEpisodes(ctx, { tmdbToken, tvdbApiKey: svc.tvdbApiKey, tvdbPin: svc.tvdbPin }, String(tmdbId), undefined);
    return { episodes, failed: false };
  } catch (err) {
    if (!(err instanceof LtError)) throw err;
    console.warn(`[lt][meta] épisodes indisponibles (statut amont : ${err.code})`);
    return { episodes: null, failed: err.status !== 404 };
  }
}

/** Assemble la fiche d'un film ou d'une série à partir des sources amont. Erreur TMDB : propagée (rien n'est stocké). */
export async function buildMetaFiche(
  ctx: LtContext,
  svc: MetaServices,
  type: MetaType,
  tmdbId: number,
  now: number,
  previous?: MetaFiche,
): Promise<MetaFiche> {
  const tmdbToken = requireTmdb(svc);
  const json = recordAt(
    await tmdbGet(ctx, tmdbToken, `${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`, { append_to_response: 'external_ids,credits' }),
  );
  const externalIds = recordAt(json, 'external_ids');
  const title = type === 'movie' ? str(json.title) : str(json.name);
  if (title === null) throw new LtError(404, 'not_found');
  const imdbRaw = str(json.imdb_id) ?? str(externalIds.imdb_id);
  const imdbId = imdbRaw !== null && IMDB_ID.test(imdbRaw) ? imdbRaw : null;
  const tvdbId = num(externalIds.tvdb_id);
  const releaseDate = dateOf(type === 'movie' ? json.release_date : json.first_air_date);
  const runtimeRaw = type === 'movie' ? num(json.runtime) : num(arrayOf(json.episode_run_time)[0]);
  const cast = arrayOf(recordAt(json, 'credits').cast)
    .filter(isRecord)
    .slice(0, CAST_LIMIT)
    .flatMap((raw): MetaCast[] => {
      const name = str(raw.name);
      return name === null ? [] : [{ id: num(raw.id) ?? 0, name, character: str(raw.character), profile: image('w185', raw.profile_path) }];
    });

  const [ratingsPart, tvdbPart, episodesPart] = await Promise.all([
    ratingsFor(ctx, svc, type, imdbId, tmdbId, now, previous),
    type === 'series' ? tvdbFor(ctx, svc, tvdbId) : Promise.resolve({ tvdb: null, failed: false }),
    type === 'series' ? episodesFor(ctx, svc, tmdbToken, tmdbId) : Promise.resolve({ episodes: null, failed: false }),
  ]);
  const tvdb = tvdbPart.tvdb;
  const tmdbNext = dateOf(recordAt(json, 'next_episode_to_air').air_date);
  const fiche: MetaFiche = {
    v: 1,
    type,
    tmdbId,
    imdbId,
    tvdbId,
    title,
    originalTitle: type === 'movie' ? str(json.original_title) : str(json.original_name),
    year: releaseDate === null ? null : Number(releaseDate.slice(0, 4)),
    releaseDate,
    status: str(json.status),
    nextAirDate: type === 'series' ? (tmdbNext ?? dateOf(tvdb?.nextAired) ?? null) : null,
    overview: str(json.overview),
    genres: arrayOf(json.genres)
      .filter(isRecord)
      .map((genre) => str(genre.name))
      .filter((name): name is string => name !== null),
    runtime: runtimeRaw,
    poster: image('w500', json.poster_path),
    backdrop: image('w1280', json.backdrop_path),
    cast,
    ratings: ratingsPart.ratings,
    ratingsDueAt: ratingsPart.dueAt,
    tvdb,
    episodes: episodesPart.episodes,
    partial: tvdbPart.failed || episodesPart.failed,
  };
  return fiche;
}

/** Fiche lue d'un enregistrement R2 ; contenu illisible : undefined (la fiche est reconstruite). */
function parseFiche(body: string): MetaFiche | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed.v === 1 ? (parsed as unknown as MetaFiche) : undefined;
  } catch {
    return undefined;
  }
}

/** Lecture du stockage : une erreur ou un contenu illisible est traité comme une fiche absente (journalisé sans contenu). */
async function readBlob(blobs: MetaBlobStore, key: string): Promise<MetaBlob | undefined> {
  try {
    const blob = await blobs.get(key);
    if (blob !== undefined && parseFiche(blob.body) === undefined) {
      console.warn('[lt][meta] fiche illisible dans le stockage : reconstruite');
      return undefined;
    }
    return blob;
  } catch (err) {
    console.warn(`[lt][meta] lecture du stockage échouée (${err instanceof Error ? err.name : 'inconnue'})`);
    return undefined;
  }
}

/** Fiches en cours de construction par clé (dédoublonnage dans l'isolat). */
const building = new Map<string, Promise<MetaResult>>();

/** Délai avant un nouvel essai après l'échec d'une reconstruction ou d'un rafraîchissement de notes (ms). */
const RETRY_COOLDOWN_MS = 60e3;
/** Dernier échec par travail (clé), dans l'isolat : pas de nouvel essai pendant le délai, pour ne pas marteler une source en panne. */
const failures = new Map<string, number>();

function coolingDown(label: string, now: number): boolean {
  const at = failures.get(label);
  return at !== undefined && now - at < RETRY_COOLDOWN_MS;
}

/**
 * Écrit la fiche si son contenu a changé, ou si l'enregistrement précédent était expiré (renouvellement de l'échéance,
 * R2 ne sait pas modifier les métadonnées seules). Réécrit la ligne d'index seulement quand l'empreinte change.
 */
async function persist(
  rt: MetaRuntime,
  key: string,
  fiche: MetaFiche,
  expiresAt: number,
  previous: MetaBlob | undefined,
  now: number,
): Promise<MetaResult> {
  const body = JSON.stringify(fiche);
  const etag = etagOf(body);
  if (rt.blobs !== undefined && (previous === undefined || previous.etag !== etag || previous.expiresAt <= now)) {
    try {
      await rt.blobs.put(key, { body, etag, expiresAt });
      if (previous?.etag !== etag) await rt.index().upsert(indexRow(fiche, etag, now));
    } catch (err) {
      console.warn(`[lt][meta] écriture du stockage échouée (${err instanceof Error ? err.name : 'inconnue'})`);
    }
  }
  return { body, etag, expiresAt, stale: false };
}

function indexRow(fiche: MetaFiche, etag: string, now: number): MetaIndexRow {
  return {
    type: fiche.type satisfies MetaIndexType,
    tmdbId: fiche.tmdbId,
    imdbId: fiche.imdbId,
    tvdbId: fiche.tvdbId,
    title: fiche.title,
    originalTitle: fiche.originalTitle,
    year: fiche.year,
    status: fiche.status,
    updatedAt: new Date(now).toISOString(),
    nextAirDate: fiche.nextAirDate,
    etag,
  };
}

/** Construit (ou reconstruit) une fiche, sans dédoublonnage : appelé sous `building`. */
async function rebuild(rt: MetaRuntime, svc: MetaServices, type: MetaType, tmdbId: number, previousBlob: MetaBlob | undefined): Promise<MetaResult> {
  const now = rt.now();
  const previous = previousBlob === undefined ? undefined : parseFiche(previousBlob.body);
  const fiche = await buildMetaFiche(rt.ctx, svc, type, tmdbId, now, previous);
  return persist(rt, metaKey(type, tmdbId), fiche, now + metaTtlMs(fiche, now), previousBlob, now);
}

/** Reconstruction dédoublonnée : une seule construction en vol par fiche dans l'isolat. */
function rebuildOnce(rt: MetaRuntime, svc: MetaServices, type: MetaType, tmdbId: number, previousBlob: MetaBlob | undefined): Promise<MetaResult> {
  const key = metaKey(type, tmdbId);
  const running = building.get(key);
  if (running !== undefined) return running;
  const work = rebuild(rt, svc, type, tmdbId, previousBlob)
    .then((result) => {
      failures.delete(key);
      return result;
    })
    .catch((err: unknown) => {
      failures.set(key, rt.now());
      throw err;
    })
    .finally(() => building.delete(key));
  building.set(key, work);
  return work;
}

/** Rafraîchit seulement les notes d'une fiche encore fraîche dont l'échéance des notes est passée. */
async function refreshRatings(rt: MetaRuntime, svc: MetaServices, type: MetaType, tmdbId: number, blob: MetaBlob, fiche: MetaFiche): Promise<void> {
  const now = rt.now();
  const label = `ratings:${metaKey(type, tmdbId)}`;
  if (coolingDown(label, now)) return;
  try {
    const { ratings, dueAt } = await ratingsFor(rt.ctx, svc, type, fiche.imdbId, tmdbId, now, { ...fiche, ratingsDueAt: 0 });
    const next: MetaFiche = { ...fiche, ratings, ratingsDueAt: dueAt };
    await persist(rt, metaKey(type, tmdbId), next, blob.expiresAt, blob, now);
    failures.delete(label);
  } catch (err) {
    failures.set(label, now);
    throw err;
  }
}

/** Travail d'arrière-plan : une erreur est journalisée sans détail, jamais rejetée. */
function detached(rt: MetaRuntime, work: Promise<unknown>, label: string): void {
  rt.background(
    work.catch((err: unknown) => {
      console.warn(`[lt][meta] ${label} échoué (${err instanceof Error ? err.name : 'inconnue'})`);
    }),
  );
}

/**
 * Sert la fiche d'un film ou d'une série :
 * - fraîche dans R2 : servie telle quelle, sans appel amont (ses notes sont rafraîchies en arrière-plan si leur échéance passe) ;
 * - périmée : servie tout de suite (`stale`), reconstruite en arrière-plan (stale-while-revalidate) ;
 * - absente : construite, puis stockée.
 * Sans stockage R2 (Node, tests) : construite à chaque demande, avec les caches des sources.
 */
export async function serveMetaFiche(rt: MetaRuntime, svc: MetaServices, type: MetaType, tmdbId: number): Promise<MetaResult> {
  const key = metaKey(type, tmdbId);
  const stored = rt.blobs === undefined ? undefined : await readBlob(rt.blobs, key);
  const now = rt.now();
  if (stored !== undefined && stored.expiresAt > now) {
    const fiche = parseFiche(stored.body);
    if (fiche !== undefined && fiche.ratingsDueAt <= now && svc.mdblistApiKey !== undefined) {
      detached(rt, refreshRatings(rt, svc, type, tmdbId, stored, fiche), 'rafraîchissement des notes');
    }
    return { body: stored.body, etag: stored.etag, expiresAt: stored.expiresAt, stale: false };
  }
  if (stored !== undefined) {
    if (svc.tmdbToken !== undefined && !coolingDown(key, rt.now())) detached(rt, rebuildOnce(rt, svc, type, tmdbId, stored), 'reconstruction de la fiche');
    return { body: stored.body, etag: stored.etag, expiresAt: stored.expiresAt, stale: true };
  }
  return rebuildOnce(rt, svc, type, tmdbId, undefined);
}

/** Vrai si l'en-tête If-None-Match contient l'empreinte (ou « * »). */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.trim() === '') return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}
