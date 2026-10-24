import { createHash } from 'node:crypto';
import { isRecord } from '../sources/http.js';
import type { MetaIndexRow, MetaIndexType } from '../user/meta-store.js';
import type { MetaRepo } from '../user/repo.js';
import { LtError, type LtContext, recordAt } from './context.js';
import { type SeriesEpisodes, seriesEpisodes } from './episodes.js';
import {
  baseKey,
  fichePrefix,
  freshness,
  type Freshness,
  l10nKey,
  type Lang,
  legacyKey,
  type MetaKind,
  ratingsKey,
  resolveLang,
  SCHEMA_VERSION,
  type Subject,
  ttlMs,
} from './meta-policy.js';
import { mdblistRatings, type MdbRatings, tmdbGet, tvdbSeries } from './providers.js';

/**
 * Fiches partagées : détail d'un film ou d'une série (TMDB, TVDB, notes MDBList, casting, saisons et épisodes), stocké dans
 * R2 en couches (schéma 2, clés et durées de vie de meta-policy.ts) : `base.json` (données sans langue, chemins d'images),
 * `l10n/<langue>.json` (titre, synopsis, genres, affiches, noms d'épisodes) et `ratings.json` (notes MDBList). La réponse
 * recompose la forme MetaFiche à partir des trois couches. Le contenu ne contient aucune donnée personnelle : ni profil, ni
 * progression, ni clé de service (les clés ne servent qu'à construire la fiche).
 */

export type MetaType = 'movie' | 'series';

const DAY = 24 * 3600e3;
/** Durée de vie des notes reprises d'une ancienne fiche (schéma 1) : courte, pour qu'elles soient relues sans tarder. */
const LEGACY_RATINGS_TTL_MS = DAY;

/** Nombre maximal d'acteurs conservés dans la fiche. */
const CAST_LIMIT = 20;
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMDB_ID = /^tt\d{1,12}$/;
const TMDB_ID = /^[1-9]\d{0,8}$/;

/** Membre TVDB retenu dans la fiche (statut, saisons, dates de diffusion). */
interface MetaTvdb {
  status: string;
  seasonCount: number;
  nextAired: string;
  lastAired: string;
}

interface MetaCast {
  id: number;
  name: string;
  character: string | null;
  /** URL d'image TMDB (w185). */
  profile: string | null;
}

/** Fiche normalisée : forme servie au client (inchangée par le stockage en couches). */
interface MetaFiche {
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

/** Couche « base » (schéma 2) : données sans langue, chemins d'images TMDB (jamais d'URL complète). */
interface BaseLayer {
  schema: typeof SCHEMA_VERSION;
  type: MetaType;
  tmdbId: number;
  imdbId: string | null;
  tvdbId: number | null;
  originalTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  status: string | null;
  nextAirDate: string | null;
  lastAirDate: string | null;
  runtime: number | null;
  cast: { id: number; name: string; character: string | null; profilePath: string | null }[];
  tvdb: MetaTvdb | null;
  /** Structure des saisons et des épisodes (dates de diffusion…), sans les textes traduits. */
  episodes: BaseEpisodes | null;
  /** TVDB ou épisodes indisponibles, ou clé TVDB manquante : la couche expire plus tôt. */
  partial: boolean;
}

type Season = SeriesEpisodes['seasons'][number];
type Episode = SeriesEpisodes['episodes'][number];
interface BaseEpisodes {
  source: SeriesEpisodes['source'];
  seasons: Omit<Season, 'name'>[];
  episodes: Omit<Episode, 'name' | 'overview'>[];
}

/** Couche « traduction » (schéma 2) : textes et visuels localisés. */
interface L10nLayer {
  schema: typeof SCHEMA_VERSION;
  lang: Lang;
  title: string;
  overview: string | null;
  tagline: string | null;
  genres: string[];
  posterPath: string | null;
  backdropPath: string | null;
  seasons: { number: number; name: string }[] | null;
  episodes: { season: number; episode: number; name: string | null; overview: string | null }[] | null;
}

/** Couche « notes » (schéma 2). `partial` : notes absentes faute de clé ou de réponse, relues dès qu'une clé est disponible. */
interface RatingsLayer {
  schema: typeof SCHEMA_VERSION;
  ratings: MdbRatings | null;
  partial: boolean;
}

/**
 * Enregistrement stocké : contenu JSON d'une couche, empreinte, échéance et durée de vie (ms) fixées à l'écriture
 * (métadonnées de l'objet R2). `ttl` vaut 0 pour un objet écrit avant le schéma 2.
 */
export interface MetaBlob {
  body: string;
  etag: string;
  expiresAt: number;
  ttl: number;
}

/** Stockage des couches (R2 sous Workers). `put` réécrit l'objet entier ; `get` renvoie undefined s'il est absent. */
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

/** Résultat servi : contenu JSON, empreinte (dérivée de celles des couches), plus proche échéance, et indication de contenu périmé. */
export interface MetaResult {
  body: string;
  etag: string;
  expiresAt: number;
  stale: boolean;
}

/** Empreinte du contenu : ETag fort, 128 bits (hex), entre guillemets. */
export function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const dateOf = (value: unknown): string | null => (typeof value === 'string' && DATE.test(value) ? value : null);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const imageUrl = (size: string, path: string | null): string | null => (path === null ? null : `${TMDB_IMAGE}${size}${path}`);

/** Cible d'une route : type et identifiant TMDB validés. Entrée invalide : 404 not_found. */
export function metaTargetOf(type: string, tmdbId: string): { type: MetaType; tmdbId: number } {
  if ((type !== 'movie' && type !== 'series') || !TMDB_ID.test(tmdbId)) throw new LtError(404, 'not_found');
  return { type, tmdbId: Number(tmdbId) };
}

function requireTmdb(svc: MetaServices): string {
  if (svc.tmdbToken === undefined) throw new LtError(404, 'service_not_configured', 'tmdb');
  return svc.tmdbToken;
}

const kindOf = (type: MetaType): MetaKind => (type === 'movie' ? 'movie' : 'tv');

/** Ce que la politique de durée de vie sait de la fiche (couche base), `partial` étant celui de la couche concernée. */
function subjectOf(base: BaseLayer, partial: boolean): Subject {
  return {
    kind: kindOf(base.type),
    ...(base.status === null ? {} : { status: base.status }),
    releaseDate: base.releaseDate,
    nextAirDate: base.nextAirDate,
    lastAirDate: base.lastAirDate,
    ...(base.tvdb?.status === 'Ended' ? { ended: true } : {}),
    partial,
  };
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
async function episodesFor(
  ctx: LtContext,
  svc: MetaServices,
  tmdbToken: string,
  tmdbId: number,
  lang: Lang,
): Promise<{ episodes: SeriesEpisodes | null; failed: boolean }> {
  try {
    const episodes = await seriesEpisodes(ctx, { tmdbToken, tvdbApiKey: svc.tvdbApiKey, tvdbPin: svc.tvdbPin }, String(tmdbId), lang);
    return { episodes, failed: false };
  } catch (err) {
    if (!(err instanceof LtError)) throw err;
    console.warn(`[lt][meta] épisodes indisponibles (statut amont : ${err.code})`);
    return { episodes: null, failed: err.status !== 404 };
  }
}

/** Sépare la structure des épisodes (couche base) de leurs textes (couche traduction). */
function splitEpisodes(full: SeriesEpisodes | null): { base: BaseEpisodes | null; seasons: L10nLayer['seasons']; episodes: L10nLayer['episodes'] } {
  if (full === null) return { base: null, seasons: null, episodes: null };
  return {
    base: {
      source: full.source,
      seasons: full.seasons.map(({ name: _name, ...season }) => season),
      episodes: full.episodes.map(({ name: _name, overview: _overview, ...episode }) => episode),
    },
    seasons: full.seasons.map((s) => ({ number: s.number, name: s.name })),
    episodes: full.episodes.map((e) => ({ season: e.season, episode: e.episode, name: e.name, overview: e.overview })),
  };
}

/**
 * Construit les couches base et traduction à partir de TMDB (un appel dans la langue demandée, plus un appel en en-US
 * seulement si le titre, le synopsis ou les genres sont vides), de TVDB et des épisodes. Erreur TMDB : propagée.
 */
async function buildCore(ctx: LtContext, svc: MetaServices, type: MetaType, tmdbId: number, lang: Lang): Promise<{ base: BaseLayer; l10n: L10nLayer }> {
  const tmdbToken = requireTmdb(svc);
  const path = `${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;
  const json = recordAt(
    await tmdbGet(ctx, tmdbToken, path, { append_to_response: 'external_ids,credits', language: lang }),
  );
  const externalIds = recordAt(json, 'external_ids');
  const titleOf = (data: Record<string, unknown>): string | null => (type === 'movie' ? str(data.title) : str(data.name));
  const genresOf = (data: Record<string, unknown>): string[] =>
    arrayOf(data.genres)
      .filter(isRecord)
      .map((genre) => str(genre.name))
      .filter((name): name is string => name !== null);

  const localTitle = titleOf(json);
  const localGenres = genresOf(json);
  let english: Record<string, unknown> | undefined;
  if (lang !== 'en-US' && (localTitle === null || str(json.overview) === null || localGenres.length === 0)) {
    try {
      english = recordAt(await tmdbGet(ctx, tmdbToken, path, { language: 'en-US' }));
    } catch (err) {
      if (!(err instanceof LtError)) throw err;
      console.warn(`[lt][meta] repli en-US indisponible (statut amont : ${err.code})`);
    }
  }
  const originalTitle = type === 'movie' ? str(json.original_title) : str(json.original_name);
  const title = localTitle ?? (english === undefined ? null : titleOf(english)) ?? originalTitle;
  if (title === null) throw new LtError(404, 'not_found');

  const imdbRaw = str(json.imdb_id) ?? str(externalIds.imdb_id);
  const imdbId = imdbRaw !== null && IMDB_ID.test(imdbRaw) ? imdbRaw : null;
  const tvdbId = num(externalIds.tvdb_id);
  const releaseDate = dateOf(type === 'movie' ? json.release_date : json.first_air_date);
  const runtime = type === 'movie' ? num(json.runtime) : num(arrayOf(json.episode_run_time)[0]);
  const cast = arrayOf(recordAt(json, 'credits').cast)
    .filter(isRecord)
    .slice(0, CAST_LIMIT)
    .flatMap((raw) => {
      const name = str(raw.name);
      return name === null ? [] : [{ id: num(raw.id) ?? 0, name, character: str(raw.character), profilePath: str(raw.profile_path) }];
    });

  const [tvdbPart, episodesPart] = await Promise.all([
    type === 'series' ? tvdbFor(ctx, svc, tvdbId) : Promise.resolve({ tvdb: null, failed: false }),
    type === 'series' ? episodesFor(ctx, svc, tmdbToken, tmdbId, lang) : Promise.resolve({ episodes: null, failed: false }),
  ]);
  const tvdb = tvdbPart.tvdb;
  const split = splitEpisodes(episodesPart.episodes);
  const tmdbNext = dateOf(recordAt(json, 'next_episode_to_air').air_date);
  const base: BaseLayer = {
    schema: SCHEMA_VERSION,
    type,
    tmdbId,
    imdbId,
    tvdbId,
    originalTitle,
    year: releaseDate === null ? null : Number(releaseDate.slice(0, 4)),
    releaseDate,
    status: str(json.status),
    nextAirDate: type === 'series' ? (tmdbNext ?? dateOf(tvdb?.nextAired) ?? null) : null,
    lastAirDate: type === 'series' ? (dateOf(json.last_air_date) ?? dateOf(tvdb?.lastAired)) : null,
    runtime,
    cast,
    tvdb,
    episodes: split.base,
    // Complète seulement si les clés de service couvrent TVDB et les épisodes ; sinon une heure au plus de stockage.
    partial: tvdbPart.failed || episodesPart.failed || (type === 'series' && tvdbId !== null && svc.tvdbApiKey === undefined),
  };
  const l10n: L10nLayer = {
    schema: SCHEMA_VERSION,
    lang,
    title,
    overview: str(json.overview) ?? (english === undefined ? null : str(english.overview)),
    tagline: str(json.tagline) ?? (english === undefined ? null : str(english.tagline)),
    genres: localGenres.length > 0 ? localGenres : english === undefined ? [] : genresOf(english),
    posterPath: str(json.poster_path) ?? (english === undefined ? null : str(english.poster_path)),
    backdropPath: str(json.backdrop_path) ?? (english === undefined ? null : str(english.backdrop_path)),
    seasons: split.seasons,
    episodes: split.episodes,
  };
  return { base, l10n };
}

/** Recompose les épisodes servis : structure de la couche base, textes de la couche traduction. */
function mergeEpisodes(base: BaseEpisodes | null, l10n: L10nLayer): SeriesEpisodes | null {
  if (base === null) return null;
  const seasonNames = new Map((l10n.seasons ?? []).map((s) => [s.number, s.name]));
  const texts = new Map((l10n.episodes ?? []).map((e) => [`${e.season}:${e.episode}`, e]));
  return {
    source: base.source,
    seasons: base.seasons.map((s) => ({
      number: s.number,
      name: seasonNames.get(s.number) ?? '',
      episodeCount: s.episodeCount,
      airDate: s.airDate,
      poster: s.poster,
    })),
    episodes: base.episodes.map((e) => {
      const text = texts.get(`${e.season}:${e.episode}`);
      return {
        season: e.season,
        episode: e.episode,
        absolute: e.absolute,
        name: text?.name ?? null,
        overview: text?.overview ?? null,
        airDate: e.airDate,
        runtime: e.runtime,
        still: e.still,
        tmdbSeason: e.tmdbSeason,
        tmdbEpisode: e.tmdbEpisode,
        ...(e.streamId === undefined ? {} : { streamId: e.streamId }),
      };
    }),
  };
}

/** Recompose la fiche servie (forme MetaFiche) : la taille des images est choisie ici. */
function assemble(base: BaseLayer, l10n: L10nLayer, ratings: RatingsLayer | null, ratingsDueAt: number): MetaFiche {
  return {
    v: 1,
    type: base.type,
    tmdbId: base.tmdbId,
    imdbId: base.imdbId,
    tvdbId: base.tvdbId,
    title: l10n.title,
    originalTitle: base.originalTitle,
    year: base.year,
    releaseDate: base.releaseDate,
    status: base.status,
    nextAirDate: base.nextAirDate,
    overview: l10n.overview,
    genres: l10n.genres,
    runtime: base.runtime,
    poster: imageUrl('w500', l10n.posterPath),
    backdrop: imageUrl('w1280', l10n.backdropPath),
    cast: base.cast.map((c) => ({ id: c.id, name: c.name, character: c.character, profile: imageUrl('w185', c.profilePath) })),
    ratings: ratings?.ratings ?? null,
    ratingsDueAt,
    tvdb: base.tvdb,
    episodes: mergeEpisodes(base.episodes, l10n),
    partial: base.partial || (ratings?.partial ?? false),
  };
}

/** Couche lue ou construite : contenu, enregistrement stocké (ou à stocker) et fraîcheur au moment de la lecture. */
interface Layer<T> {
  value: T;
  blob: MetaBlob;
  state: Freshness;
}

/** Lit une couche : une erreur, un contenu illisible ou d'un autre schéma est traité comme une couche absente (journalisé sans contenu). */
async function readLayer<T>(
  blobs: MetaBlobStore,
  key: string,
  now: number,
  valid: (value: Record<string, unknown>) => boolean,
): Promise<Layer<T> | undefined> {
  try {
    const blob = await blobs.get(key);
    if (blob === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.body);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed) || parsed.schema !== SCHEMA_VERSION || !valid(parsed)) {
      console.warn('[lt][meta] couche illisible dans le stockage : reconstruite');
      return undefined;
    }
    return { value: parsed as T, blob, state: freshness(blob.expiresAt, blob.ttl, now) };
  } catch (err) {
    console.warn(`[lt][meta] lecture du stockage échouée (${err instanceof Error ? err.name : 'inconnue'})`);
    return undefined;
  }
}

/** Travaux en cours par clé (dédoublonnage dans l'isolat). */
const building = new Map<string, Promise<unknown>>();

/** Délai avant un nouvel essai après l'échec d'une reconstruction ou d'un rafraîchissement de notes (ms). */
const RETRY_COOLDOWN_MS = 60e3;
/** Dernier échec par travail (clé), dans l'isolat : pas de nouvel essai pendant le délai, pour ne pas marteler une source en panne. */
const failures = new Map<string, number>();

function coolingDown(label: string, now: number): boolean {
  const at = failures.get(label);
  return at !== undefined && now - at < RETRY_COOLDOWN_MS;
}

/**
 * Travail dédoublonné : un seul en vol par clé dans l'isolat. Les clés de service sont celles du demandeur : celui qui rejoint
 * un travail en vol relance le sien seulement si ce travail a échoué sur un refus de jeton (401/403, propre au compte qui l'a
 * lancé). Toute autre erreur (panne amont) lui est transmise : un seul appel amont pour N requêtes concurrentes.
 */
function once<T>(rt: MetaRuntime, label: string, run: () => Promise<T>): Promise<T> {
  const running = building.get(label) as Promise<T> | undefined;
  if (running !== undefined) {
    // Seule une erreur propre au jeton (401/403) fait relancer le travail par celui qui l'a rejoint ; une panne amont lui est transmise.
    return running.catch((err: unknown) => {
      if (err instanceof LtError && (err.code === 'upstream_401' || err.code === 'upstream_403')) return once(rt, label, run);
      throw err;
    });
  }
  const work = run()
    .then((result) => {
      failures.delete(label);
      return result;
    })
    .catch((err: unknown) => {
      failures.set(label, rt.now());
      throw err;
    })
    .finally(() => building.delete(label));
  building.set(label, work);
  return work;
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
 * Écrit une couche si son contenu a changé, ou si l'enregistrement précédent était expiré (renouvellement de l'échéance,
 * R2 ne sait pas modifier les métadonnées seules). Sinon rien n'est écrit et l'enregistrement précédent reste en place.
 */
async function persistLayer(
  rt: MetaRuntime,
  key: string,
  value: BaseLayer | L10nLayer | RatingsLayer,
  ttl: number,
  previous: MetaBlob | undefined,
  now: number,
): Promise<{ blob: MetaBlob; changed: boolean; stored: boolean }> {
  const body = JSON.stringify(value);
  const etag = etagOf(body);
  const blob: MetaBlob = { body, etag, expiresAt: now + ttl, ttl };
  const changed = previous?.etag !== etag;
  if (rt.blobs === undefined) return { blob, changed, stored: false };
  if (previous !== undefined && !changed && previous.expiresAt > now) return { blob: previous, changed, stored: false };
  try {
    await rt.blobs.put(key, blob);
    return { blob, changed, stored: true };
  } catch (err) {
    console.warn(`[lt][meta] écriture du stockage échouée (${err instanceof Error ? err.name : 'inconnue'})`);
    return { blob, changed, stored: false };
  }
}

function indexRow(base: BaseLayer, l10n: L10nLayer, etag: string, now: number): MetaIndexRow {
  return {
    type: base.type satisfies MetaIndexType,
    tmdbId: base.tmdbId,
    imdbId: base.imdbId,
    tvdbId: base.tvdbId,
    title: l10n.title,
    originalTitle: base.originalTitle,
    year: base.year,
    status: base.status,
    updatedAt: new Date(now).toISOString(),
    nextAirDate: base.nextAirDate,
    etag,
  };
}

/** Couches base et traduction à servir. */
interface Core {
  base: Layer<BaseLayer>;
  l10n: Layer<L10nLayer>;
}

/**
 * Reconstruit les couches base et traduction visées (`targets`) depuis les sources. Les autres couches, saines, restent
 * telles quelles : jamais réécrites. La ligne d'index suit les titres français, seulement après un écrit réussi qui change le contenu.
 */
async function rebuildCore(
  rt: MetaRuntime,
  svc: MetaServices,
  type: MetaType,
  tmdbId: number,
  lang: Lang,
  targets: { base: boolean; l10n: boolean },
  current: { base: Layer<BaseLayer> | undefined; l10n: Layer<L10nLayer> | undefined },
): Promise<Core> {
  const built = await buildCore(rt.ctx, svc, type, tmdbId, lang);
  const now = rt.now();
  const kind = kindOf(type);
  const subject = (partial: boolean): Subject => subjectOf(built.base, partial);
  let baseLayer = current.base;
  let l10nLayer = current.l10n;
  let changed = false;
  let stored = false;
  if (targets.base || baseLayer === undefined) {
    const result = await persistLayer(rt, baseKey(kind, tmdbId), built.base, ttlMs('base', subject(built.base.partial), now), current.base?.blob, now);
    baseLayer = { value: built.base, blob: result.blob, state: 'fresh' };
    changed ||= result.changed;
    stored ||= result.stored;
  }
  if (targets.l10n || l10nLayer === undefined) {
    const result = await persistLayer(rt, l10nKey(kind, tmdbId, lang), built.l10n, ttlMs('l10n', subject(built.base.partial), now), current.l10n?.blob, now);
    l10nLayer = { value: built.l10n, blob: result.blob, state: 'fresh' };
    changed ||= result.changed;
    stored ||= result.stored;
  }
  if (stored && changed && lang === 'fr-FR') {
    // L'index ne se met à jour qu'après un écrit réussi ; son propre échec ne doit pas passer pour un échec d'écriture.
    try {
      await rt.index().upsert(indexRow(baseLayer.value, l10nLayer.value, etagOf(`${baseLayer.blob.etag}|${l10nLayer.blob.etag}`), now));
    } catch (err) {
      console.warn(`[lt][meta] index des fiches non mis à jour (${err instanceof Error ? err.name : 'inconnue'})`);
    }
  }
  return { base: baseLayer, l10n: l10nLayer };
}

/** Notes d'une ancienne fiche (schéma 1, clé `meta/<type>/<id>.json`), lues sans jamais rien y écrire. Absente ou illisible : undefined. */
async function legacyRatings(blobs: MetaBlobStore, type: MetaType, tmdbId: number): Promise<MdbRatings | undefined> {
  try {
    const blob = await blobs.get(legacyKey(kindOf(type), tmdbId));
    if (blob === undefined) return undefined;
    const parsed: unknown = JSON.parse(blob.body);
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.ratings)) return undefined;
    return parsed.ratings as unknown as MdbRatings;
  } catch {
    return undefined;
  }
}

/** Reprise des notes de l'ancienne fiche v1 dans la couche v2 (sans appel MDBList). Aucun ancien objet : undefined. */
async function adoptLegacyRatings(rt: MetaRuntime, base: BaseLayer, now: number): Promise<Layer<RatingsLayer> | undefined> {
  const legacy = rt.blobs === undefined ? undefined : await legacyRatings(rt.blobs, base.type, base.tmdbId);
  if (legacy === undefined) return undefined;
  const value: RatingsLayer = { schema: SCHEMA_VERSION, ratings: legacy, partial: false };
  const result = await persistLayer(rt, ratingsKey(kindOf(base.type), base.tmdbId), value, LEGACY_RATINGS_TTL_MS, undefined, now);
  return { value, blob: result.blob, state: 'fresh' };
}

/**
 * Construit (et stocke) la couche des notes. Sans clé MDBList : une couche vide `partial` si rien n'existe encore, sinon
 * undefined (on ne remplace pas des notes connues par du vide). Lecture en échec : notes connues conservées, `partial`.
 */
async function rebuildRatings(
  rt: MetaRuntime,
  svc: MetaServices,
  base: BaseLayer,
  previous: Layer<RatingsLayer> | undefined,
): Promise<Layer<RatingsLayer> | undefined> {
  let value: RatingsLayer;
  if (svc.mdblistApiKey === undefined) {
    if (previous !== undefined) return undefined;
    value = { schema: SCHEMA_VERSION, ratings: null, partial: true };
  } else {
    try {
      const ratings = await mdblistRatings(rt.ctx, svc.mdblistApiKey, base.type === 'movie' ? 'movie' : 'tv', base.imdbId ?? String(base.tmdbId), true);
      value = { schema: SCHEMA_VERSION, ratings, partial: false };
    } catch (err) {
      console.warn(`[lt][meta] notes indisponibles (${err instanceof LtError ? `statut amont : ${err.code}` : err instanceof Error ? err.name : 'inconnue'})`);
      value = { schema: SCHEMA_VERSION, ratings: previous?.value.ratings ?? null, partial: true };
    }
  }
  const now = rt.now();
  const ttl = ttlMs('ratings', subjectOf(base, value.partial), now);
  const result = await persistLayer(rt, ratingsKey(kindOf(base.type), base.tmdbId), value, ttl, previous?.blob, now);
  return { value, blob: result.blob, state: 'fresh' };
}

/** Notes servies, et indication de contenu périmé. Film non sorti : aucune couche, aucun appel MDBList, `ratings: null`. */
async function resolveRatings(
  rt: MetaRuntime,
  svc: MetaServices,
  base: BaseLayer,
  loaded: Layer<RatingsLayer> | undefined,
): Promise<{ layer: Layer<RatingsLayer> | undefined; stale: boolean }> {
  const now = rt.now();
  if (ttlMs('ratings', subjectOf(base, false), now) === 0) return { layer: undefined, stale: false };
  const label = `ratings:${fichePrefix(kindOf(base.type), base.tmdbId)}`;
  const rebuild = (previous: Layer<RatingsLayer> | undefined) => once(rt, label, () => rebuildRatings(rt, svc, base, previous));
  if (loaded === undefined) {
    // Absente : reprise des notes de l'ancienne fiche (sans appel MDBList), sinon lecture chez MDBList.
    const adopted = await adoptLegacyRatings(rt, base, now);
    if (adopted !== undefined) return { layer: adopted, stale: false };
    return { layer: await rebuild(undefined), stale: false };
  }
  // Couche sans notes faute de clé : relue dès qu'un compte avec clé passe, même si elle n'a pas expiré.
  const needsKey = loaded.value.partial && svc.mdblistApiKey !== undefined;
  if (loaded.state === 'fresh' && !needsKey) return { layer: loaded, stale: false };
  if (loaded.state === 'dead' && !coolingDown(label, now)) {
    try {
      const rebuilt = await rebuild(loaded);
      if (rebuilt !== undefined) return { layer: rebuilt, stale: false };
    } catch (err) {
      console.warn(`[lt][meta] notes non reconstruites (${err instanceof Error ? err.name : 'inconnue'}) : couche périmée servie`);
    }
    return { layer: loaded, stale: true };
  }
  if (loaded.state !== 'dead' && svc.mdblistApiKey !== undefined && !coolingDown(label, now)) {
    detached(
      rt,
      rebuild(loaded).then((rebuilt) => {
        if (rebuilt?.value.partial === true) failures.set(label, rt.now());
      }),
      'rafraîchissement des notes',
    );
  }
  return { layer: loaded, stale: loaded.state !== 'fresh' };
}

const isBase = (v: Record<string, unknown>): boolean => typeof v.tmdbId === 'number' && (v.type === 'movie' || v.type === 'series');
const isL10n = (v: Record<string, unknown>): boolean => typeof v.title === 'string' && Array.isArray(v.genres);
const isRatings = (v: Record<string, unknown>): boolean => typeof v.partial === 'boolean';

/**
 * Sert la fiche d'un film ou d'une série, recomposée à partir de trois couches (base, traduction, notes) :
 * - fraîche : servie telle quelle, sans appel amont ;
 * - périmée (encore dans sa fenêtre) : servie aussitôt (`stale`), la couche concernée seule est reconstruite en arrière-plan ;
 * - morte : reconstruite avant la réponse ; si la reconstruction échoue, la couche périmée est servie (`stale`) ;
 * - absente : construite, puis stockée (notes : reprise de l'ancienne fiche si elle existe).
 * Sans stockage R2 (Node, tests) : construite à chaque demande, avec les caches des sources.
 */
export async function serveMetaFiche(rt: MetaRuntime, svc: MetaServices, type: MetaType, tmdbId: number, language?: string): Promise<MetaResult> {
  const lang = resolveLang(language);
  const kind = kindOf(type);
  const blobs = rt.blobs;
  const start = rt.now();
  const [storedBase, storedL10n, storedRatings] =
    blobs === undefined
      ? [undefined, undefined, undefined]
      : await Promise.all([
          readLayer<BaseLayer>(blobs, baseKey(kind, tmdbId), start, isBase),
          readLayer<L10nLayer>(blobs, l10nKey(kind, tmdbId, lang), start, isL10n),
          readLayer<RatingsLayer>(blobs, ratingsKey(kind, tmdbId), start, isRatings),
        ]);

  let base = storedBase;
  let l10n = storedL10n;
  let stale = false;
  if (base?.state !== 'fresh' || l10n?.state !== 'fresh') {
    const targets = { base: base?.state !== 'fresh', l10n: l10n?.state !== 'fresh' };
    const label = `core:${fichePrefix(kind, tmdbId)}${lang}:${targets.base ? 'b' : ''}${targets.l10n ? 'l' : ''}`;
    const run = (): Promise<Core> => rebuildCore(rt, svc, type, tmdbId, lang, targets, { base: storedBase, l10n: storedL10n });
    const needsNow = base === undefined || l10n === undefined || base.state === 'dead' || l10n.state === 'dead';
    if (!needsNow) {
      if (svc.tmdbToken !== undefined && !coolingDown(label, start)) detached(rt, once(rt, label, run), 'reconstruction de la fiche');
      stale = true;
    } else {
      try {
        requireTmdb(svc);
        // Morte seulement (rien d'absent) : pendant le délai de nouvel essai, la couche périmée est servie sans relancer les sources.
        if (base !== undefined && l10n !== undefined && coolingDown(label, start)) throw new LtError(503, 'cooling_down');
        const core = await once(rt, label, run);
        base = core.base;
        l10n = core.l10n;
      } catch (err) {
        if (base === undefined || l10n === undefined) throw err;
        if (!(err instanceof LtError)) console.warn(`[lt][meta] reconstruction échouée (${err instanceof Error ? err.name : 'inconnue'}) : couches périmées servies`);
        stale = true;
      }
    }
  }
  if (base === undefined || l10n === undefined) throw new LtError(502, 'meta_unavailable');

  const notes = await resolveRatings(rt, svc, base.value, storedRatings);
  stale ||= notes.stale;
  const ratingsDueAt = notes.layer?.blob.expiresAt ?? base.blob.expiresAt;
  const fiche = assemble(base.value, l10n.value, notes.layer?.value ?? null, ratingsDueAt);
  const body = JSON.stringify(fiche);
  return {
    body,
    // Empreinte du contenu servi : une couche réécrite au contenu identique (nouvelle échéance des notes) change l'ETag.
    etag: etagOf(body),
    expiresAt: Math.min(base.blob.expiresAt, l10n.blob.expiresAt, notes.layer?.blob.expiresAt ?? Infinity),
    stale,
  };
}

/** Budget d'un passage de préchauffage : décrémenté à chaque reconstruction TMDB ou appel MDBList engagé. */
export interface PrewarmBudget {
  /** Reconstructions des couches base et traduction (une par fiche). */
  tmdb: number;
  /** Appels MDBList pour les notes. */
  mdblist: number;
}

/** Couches reconstruites pour une fiche par le préchauffage. */
export interface PrewarmOutcome {
  core: boolean;
  ratings: boolean;
}

/**
 * Couche à reconstruire : R2 ne renouvelle l'échéance d'une couche saine que si son contenu change. Marquée expirée, elle
 * est réécrite avec une échéance neuve, contenu identique ou non (les notes reprises en cas d'échec restent).
 */
function renewing<T>(layer: Layer<T> | undefined, rebuild: boolean): Layer<T> | undefined {
  if (layer === undefined || !rebuild) return layer;
  return { ...layer, blob: { ...layer.blob, expiresAt: 0 } };
}

/**
 * Préchauffage d'une fiche (cron) : reconstruit les couches absentes ou dont l'échéance tombe dans min(`horizonMs`, quart de leur
 * durée de vie enregistrée) (expirées comprises). Une couche fraîche au-delà de ce délai n'est ni lue en amont ni réécrite. Chaque reconstruction engagée
 * décrémente `budget` ; sans budget restant, la couche attend le passage suivant. Les erreurs remontent à l'appelant.
 */
export async function prewarmFiche(
  rt: MetaRuntime,
  svc: MetaServices,
  type: MetaType,
  tmdbId: number,
  horizonMs: number,
  budget: PrewarmBudget,
  lang: Lang = 'fr-FR',
): Promise<PrewarmOutcome> {
  const outcome: PrewarmOutcome = { core: false, ratings: false };
  const blobs = rt.blobs;
  if (blobs === undefined) return outcome;
  const kind = kindOf(type);
  const now = rt.now();
  // Due : absente, ou échéance dans min(horizon, quart de sa durée de vie) : une couche de 1 j fraîche n'est pas refaite à chaque passe.
  const due = (layer: Layer<unknown> | undefined): boolean =>
    layer === undefined || layer.blob.expiresAt <= now + (layer.blob.ttl > 0 ? Math.min(horizonMs, layer.blob.ttl / 4) : horizonMs);
  const [storedBase, storedL10n, storedRatings] = await Promise.all([
    readLayer<BaseLayer>(blobs, baseKey(kind, tmdbId), now, isBase),
    readLayer<L10nLayer>(blobs, l10nKey(kind, tmdbId, lang), now, isL10n),
    readLayer<RatingsLayer>(blobs, ratingsKey(kind, tmdbId), now, isRatings),
  ]);

  let base = storedBase;
  const targets = { base: due(storedBase), l10n: due(storedL10n) };
  if ((targets.base || targets.l10n) && svc.tmdbToken !== undefined && budget.tmdb > 0) {
    budget.tmdb -= 1;
    const label = `core:${fichePrefix(kind, tmdbId)}${lang}:${targets.base ? 'b' : ''}${targets.l10n ? 'l' : ''}`;
    const core = await once(rt, label, () =>
      rebuildCore(rt, svc, type, tmdbId, lang, targets, { base: renewing(storedBase, targets.base), l10n: renewing(storedL10n, targets.l10n) }),
    );
    base = core.base;
    outcome.core = true;
  }

  if (base !== undefined && storedRatings === undefined && ttlMs('ratings', subjectOf(base.value, false), now) > 0 && (await adoptLegacyRatings(rt, base.value, now)) !== undefined) {
    return outcome;
  }
  if (base !== undefined && svc.mdblistApiKey !== undefined && budget.mdblist > 0 && due(storedRatings) && ttlMs('ratings', subjectOf(base.value, false), now) > 0) {
    budget.mdblist -= 1;
    const current = base.value;
    await once(rt, `ratings:${fichePrefix(kind, tmdbId)}`, () => rebuildRatings(rt, svc, current, renewing(storedRatings, true)));
    outcome.ratings = true;
  }
  return outcome;
}

/** Vrai si l'en-tête If-None-Match contient l'empreinte (ou « * »). */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.trim() === '') return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}
