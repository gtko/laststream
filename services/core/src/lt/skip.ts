import type { Config } from '../config/schema.js';
import { isRecord } from '../sources/http.js';
import { getJson, LtError, type LtContext, recordAt, TTL } from './context.js';

/** Types de segments : intro, reprise, générique de fin, post-générique, aperçu. */
export type SkipKind = 'intro' | 'recap' | 'credits' | 'postcredits' | 'preview';
/** Source d'un segment. */
export type SkipSource = 'introdb' | 'aniskip' | 'animeskip';

export interface SkipSegment {
  kind: SkipKind;
  /** Secondes depuis le début de l'épisode. */
  start: number;
  end: number;
  source: SkipSource;
  /** Confiance rapportée par la source (IntroDB uniquement). */
  confidence?: number;
}

export interface SkipResponse {
  segments: SkipSegment[];
  /** Durée de l'épisode en secondes, si AniSkip la connaît. */
  episodeLength?: number;
}

/** Cible validée : un film (saison et épisode à 0) ou un épisode de série (saison et épisode à partir de 1). */
export interface SkipTarget {
  type: 'movie' | 'series';
  imdbId: string;
  season: number;
  episode: number;
}

const INTRODB_BASE = 'https://api.introdb.app';
const ARM_BASE = 'https://arm.haglund.dev/api/v2';
const ANISKIP_BASE = 'https://api.aniskip.com/v2';
const ANIMESKIP_URL = 'https://api.anime-skip.com/graphql';

/** Priorité des sources pour un même segment (plus petit = prioritaire). */
const PRIORITY = { aniskip: 0, animeskip: 1, introdb: 2 } as const;
/** Durée maximale d'un segment déduit des repères Anime Skip (secondes) : évite un repère isolé qui couvre tout. */
const MAX_SEGMENT_SECONDS = 900;

/** Champs IntroDB et type de segment correspondant. */
const INTRODB_FIELDS: readonly [string, SkipKind][] = [
  ['intro', 'intro'],
  ['recap', 'recap'],
  ['outro', 'credits'],
  ['post_credits', 'postcredits'],
];
/** Types AniSkip v2 (op = générique d'ouverture, ed = générique de fin). */
const ANISKIP_KINDS: Partial<Record<string, SkipKind>> = {
  op: 'intro',
  'mixed-op': 'intro',
  ed: 'credits',
  'mixed-ed': 'credits',
  recap: 'recap',
};
/** Types de repères Anime Skip ; les autres (Canon, Title Card, Filler…) ne donnent pas de segment. */
const ANIMESKIP_KINDS: Partial<Record<string, SkipKind>> = {
  Intro: 'intro',
  'Mixed Intro': 'intro',
  'New Intro': 'intro',
  Recap: 'recap',
  Credits: 'credits',
  'Mixed Credits': 'credits',
  'New Credits': 'credits',
  Preview: 'preview',
};

/** Segment candidat avant fusion. */
interface Candidate {
  kind: SkipKind;
  start: number;
  end: number;
  source: SkipSource;
  priority: number;
  confidence?: number;
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * Valide la cible. Film : saison et épisode à 0. Série : saison et épisode à partir de 1. Tout autre cas : 404.
 */
export function parseSkipTarget(type: string, imdbId: string, season: string, episode: string): SkipTarget {
  if (!/^tt\d{7,8}$/.test(imdbId) || !/^\d{1,4}$/.test(season) || !/^\d{1,4}$/.test(episode)) throw new LtError(404, 'not_found');
  const s = Number(season);
  const e = Number(episode);
  if (type === 'movie' && s === 0 && e === 0) return { type, imdbId, season: 0, episode: 0 };
  if (type === 'series' && s >= 1 && e >= 1) return { type, imdbId, season: s, episode: e };
  throw new LtError(404, 'not_found');
}

/** Requête JSON dont l'absence (404, ou 400 pour des paramètres refusés) signifie « rien trouvé ». */
async function jsonOrNothing(ctx: LtContext, url: string, init: RequestInit = {}): Promise<unknown> {
  try {
    return await getJson(ctx, url, init);
  } catch (err) {
    if (err instanceof LtError && (err.code === 'upstream_404' || err.code === 'upstream_400')) return undefined;
    throw err;
  }
}

/** IntroDB (lecture publique ; la clé, si elle est configurée, part dans X-API-Key). */
async function introdbSegments(ctx: LtContext, apiKey: string | undefined, target: SkipTarget): Promise<Candidate[]> {
  const query = new URLSearchParams({ imdb_id: target.imdbId });
  if (target.type === 'movie') {
    query.set('is_movie', 'true');
  } else {
    query.set('season', String(target.season));
    query.set('episode', String(target.episode));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey !== undefined) headers['X-API-Key'] = apiKey;
  const json = await jsonOrNothing(ctx, `${INTRODB_BASE}/segments?${query}`, { headers });
  if (!isRecord(json)) return [];
  const candidates: Candidate[] = [];
  for (const [field, kind] of INTRODB_FIELDS) {
    const segment = json[field];
    if (!isRecord(segment)) continue;
    const start = num(segment.start_sec);
    const end = num(segment.end_sec);
    if (start === undefined || end === undefined || end <= start) continue;
    const candidate: Candidate = { kind, start, end, source: 'introdb', priority: PRIORITY.introdb };
    const confidence = num(segment.confidence);
    if (confidence !== undefined) candidate.confidence = confidence;
    candidates.push(candidate);
  }
  return candidates;
}

/** Correspondances ARM d'un identifiant IMDb : une entrée par saison TMDB pour les séries d'animation. */
interface ArmEntry {
  anilist?: number;
  mal?: number;
  tmdbSeason?: number;
}

async function armEntries(ctx: LtContext, imdbId: string): Promise<ArmEntry[]> {
  return ctx.state.cache.get<ArmEntry[]>(
    `arm:${imdbId}`,
    (entries) => (entries.length > 0 ? TTL.skip : TTL.skipEmpty),
    async () => {
      const json = await jsonOrNothing(ctx, `${ARM_BASE}/imdb?id=${encodeURIComponent(imdbId)}`);
      if (!Array.isArray(json)) return [];
      return json.filter(isRecord).map((entry) => ({
        anilist: num(entry.anilist),
        mal: num(entry.myanimelist),
        tmdbSeason: num(entry['themoviedb-season']),
      }));
    },
  );
}

/** Entrée ARM de la saison demandée ; sans numéro de saison TMDB, l'unique entrée connue. */
function armEntryFor(entries: ArmEntry[], season: number): ArmEntry | undefined {
  const exact = entries.find((entry) => entry.tmdbSeason === season);
  if (exact !== undefined) return exact;
  return entries.length === 1 && entries[0] !== undefined && entries[0].tmdbSeason === undefined ? entries[0] : undefined;
}

/** AniSkip v2 (identifiant MAL et numéro d'épisode dans la saison) : intro, crédits, reprise. */
async function aniskipSegments(
  ctx: LtContext,
  malId: number,
  episode: number,
): Promise<{ candidates: Candidate[]; episodeLength?: number }> {
  const types = ['op', 'ed', 'recap', 'mixed-op', 'mixed-ed'].map((type) => `types=${type}`).join('&');
  const json = await jsonOrNothing(ctx, `${ANISKIP_BASE}/skip-times/${malId}/${episode}?${types}&episodeLength=0`);
  if (!isRecord(json) || json.found !== true || !Array.isArray(json.results)) return { candidates: [] };
  const candidates: Candidate[] = [];
  let episodeLength: number | undefined;
  for (const result of json.results) {
    if (!isRecord(result)) continue;
    const kind = typeof result.skipType === 'string' ? ANISKIP_KINDS[result.skipType] : undefined;
    const interval = result.interval;
    if (kind !== undefined && isRecord(interval)) {
      const start = num(interval.startTime);
      const end = num(interval.endTime);
      if (start !== undefined && end !== undefined && end > start) {
        candidates.push({ kind, start, end, source: 'aniskip', priority: PRIORITY.aniskip });
      }
    }
    const length = num(result.episodeLength);
    if (episodeLength === undefined && length !== undefined && length > 0) episodeLength = length;
  }
  return episodeLength === undefined ? { candidates } : { candidates, episodeLength };
}

/** Requête GraphQL Anime Skip (identifiant client en en-tête X-Client-ID). Erreur GraphQL : 502. */
async function animeskipQuery(
  ctx: LtContext,
  clientId: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const json = await getJson(ctx, ANIMESKIP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Client-ID': clientId },
    body: JSON.stringify({ query, variables }),
  });
  if (!isRecord(json)) throw new LtError(502, 'upstream_bad_json');
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new LtError(502, 'upstream_graphql');
  return recordAt(json, 'data');
}

/** Identifiant de la première entrée d'une liste GraphQL, ou undefined. */
function firstId(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const first = list.find(isRecord);
  return first !== undefined && typeof first.id === 'string' ? first.id : undefined;
}

/**
 * Repères Anime Skip : un point par type. Un segment part d'un repère de type connu et finit au repère suivant, quel
 * que soit son type (ex. « New Intro » à 0, « Canon » à 90 : intro de 0 à 90 s).
 */
function animeskipTimestamps(list: unknown): Candidate[] {
  if (!Array.isArray(list)) return [];
  const stamps = list
    .filter(isRecord)
    .flatMap((stamp) => {
      const at = num(stamp.at);
      const name = isRecord(stamp.type) && typeof stamp.type.name === 'string' ? stamp.type.name : undefined;
      return at === undefined ? [] : [{ at, name }];
    })
    .sort((a, b) => a.at - b.at);
  const candidates: Candidate[] = [];
  for (const stamp of stamps) {
    const kind = stamp.name === undefined ? undefined : ANIMESKIP_KINDS[stamp.name];
    if (kind === undefined) continue;
    const next = stamps.find((other) => other.at > stamp.at);
    if (next === undefined || next.at - stamp.at > MAX_SEGMENT_SECONDS) continue;
    candidates.push({ kind, start: stamp.at, end: next.at, source: 'animeskip', priority: PRIORITY.animeskip });
  }
  return candidates;
}

/** Anime Skip : show par identifiant AniList, épisode par saison et numéro, puis ses repères. */
async function animeskipSegments(
  ctx: LtContext,
  clientId: string,
  anilistId: number,
  season: number,
  episode: number,
): Promise<Candidate[]> {
  const shows = await animeskipQuery(
    ctx,
    clientId,
    'query ($service: ExternalService!, $serviceId: String!) { findShowsByExternalId(service: $service, serviceId: $serviceId) { id } }',
    { service: 'ANILIST', serviceId: String(anilistId) },
  );
  const showId = firstId(shows.findShowsByExternalId);
  if (showId === undefined) return [];
  const episodes = await animeskipQuery(ctx, clientId, 'query ($showId: ID!) { findEpisodesByShowId(showId: $showId) { id season number } }', {
    showId,
  });
  const list = Array.isArray(episodes.findEpisodesByShowId) ? episodes.findEpisodesByShowId.filter(isRecord) : [];
  const match = list.find((item) => item.season === String(season) && item.number === String(episode));
  const episodeId = match !== undefined && typeof match.id === 'string' ? match.id : undefined;
  if (episodeId === undefined) return [];
  const stamps = await animeskipQuery(
    ctx,
    clientId,
    'query ($episodeId: ID!) { findTimestampsByEpisodeId(episodeId: $episodeId) { at type { name } } }',
    { episodeId },
  );
  return animeskipTimestamps(stamps.findTimestampsByEpisodeId);
}

/**
 * Fusion : pour un même type de segment, un chevauchement garde la source la plus prioritaire, puis la confiance la
 * plus haute. Les segments de types différents ne se concurrencent pas.
 */
function mergeCandidates(candidates: Candidate[]): SkipSegment[] {
  const ordered = [...candidates].sort(
    (a, b) => a.priority - b.priority || (b.confidence ?? 0) - (a.confidence ?? 0) || a.start - b.start,
  );
  const kept: Candidate[] = [];
  for (const candidate of ordered) {
    const clash = kept.some((other) => other.kind === candidate.kind && candidate.start < other.end && other.start < candidate.end);
    if (!clash) kept.push(candidate);
  }
  return kept
    .sort((a, b) => a.start - b.start)
    .map(({ priority: _priority, ...segment }) => segment);
}

function toResponse(candidates: Candidate[], episodeLength: number | undefined): SkipResponse {
  const segments = mergeCandidates(candidates);
  return episodeLength === undefined ? { segments } : { segments, episodeLength };
}

/**
 * Segments de saut d'une cible. Film ou série live : IntroDB. Série d'animation (ARM la rattache à un MAL) : AniSkip,
 * puis Anime Skip si son identifiant client est configuré ; IntroDB seulement si l'animation ne donne rien. Cache
 * partagé : 7 jours si un segment est trouvé, 6 h sinon. La clé ne contient aucune clé de service, seulement si Anime
 * Skip est configuré.
 */
export async function skipSegments(ctx: LtContext, services: Config['services'], target: SkipTarget): Promise<SkipResponse> {
  const animeskipOn = services.animeskipClientId !== undefined ? '1' : '0';
  const key = `skip:${target.type}:${target.imdbId}:${target.season}:${target.episode}:${animeskipOn}`;
  return ctx.state.cache.get<SkipResponse>(
    key,
    (result) => (result.segments.length > 0 ? TTL.skip : TTL.skipEmpty),
    async () => {
      const entries = target.type === 'series' ? await armEntries(ctx, target.imdbId) : [];
      const entry = target.type === 'series' ? armEntryFor(entries, target.season) : undefined;
      if (entry === undefined) {
        return toResponse(await introdbSegments(ctx, services.introdbApiKey, target), undefined);
      }
      const anime: { candidates: Candidate[]; episodeLength?: number } =
        entry.mal !== undefined ? await aniskipSegments(ctx, entry.mal, target.episode) : { candidates: [] };
      const candidates = [...anime.candidates];
      if (services.animeskipClientId !== undefined && entry.anilist !== undefined) {
        candidates.push(...(await animeskipSegments(ctx, services.animeskipClientId, entry.anilist, target.season, target.episode)));
      }
      if (candidates.length === 0) candidates.push(...(await introdbSegments(ctx, services.introdbApiKey, target)));
      return toResponse(candidates, anime.episodeLength);
    },
  );
}
