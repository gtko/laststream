import type { Config } from '../config/schema.js';
import { isRecord } from '../sources/http.js';
import { getJson, LtError, type LtContext, recordAt, TTL } from './context.js';

/** Types de segments : intro, reprise, générique de fin, post-générique, aperçu. */
type SkipKind = 'intro' | 'recap' | 'credits' | 'postcredits' | 'preview';
/** Source d'un segment venu d'un service externe. */
type SkipSource = 'introdb' | 'skipdb' | 'aniskip' | 'animeskip';
/** Origine d'un segment : service externe, store communautaire local, détection automatique locale, ou déduction à partir de la saison. */
type SkipOrigin = SkipSource | 'community' | 'auto' | 'inferred';

export interface SkipSegment {
  kind: SkipKind;
  /** Secondes depuis le début de l'épisode. */
  start: number;
  end: number;
  source: SkipOrigin;
  /** Sources concordantes (présent seulement si au moins deux sources ont fusionné sur ce segment). */
  sources?: SkipSource[];
  /** Confiance : rapportée par la source (IntroDB, SkipDB), lissée par les votes (communauté), 0,95 (chapitres), 0,8 (empreinte audio), 0,5 (déduit). */
  confidence?: number;
  /** Vrai pour un segment déduit des autres épisodes de la saison. */
  inferred?: true;
  /** Méthode d'une détection locale (source « auto ») : chapitres du conteneur, empreinte audio, noir et silence de fin. */
  method?: 'chapters' | 'fingerprint' | 'blackdetect';
}

export interface SkipResponse {
  segments: SkipSegment[];
  /** Durée de l'épisode en secondes, si AniSkip la connaît. */
  episodeLength?: number;
  /** Vrai si une détection locale de cet épisode est en attente ou en cours : à relire plus tard. */
  analyzing?: true;
}

/** Cible validée : un film (saison et épisode à 0) ou un épisode de série (saison et épisode à partir de 1). */
export interface SkipTarget {
  type: 'movie' | 'series';
  imdbId: string;
  season: number;
  episode: number;
}

export const INTRODB_BASE = 'https://api.introdb.app';
export const SKIPDB_BASE = 'https://api.skipdb.tv';
const ARM_BASE = 'https://arm.haglund.dev/api/v2';
const ANISKIP_BASE = 'https://api.aniskip.com/v2';
const ANIMESKIP_URL = 'https://api.anime-skip.com/graphql';

/**
 * Rang des sources pour un même segment (plus petit = prioritaire). IntroDB avec au moins TRUSTED_SUBMISSIONS
 * soumissions passe en tête ; viennent ensuite AniSkip (anime), SkipDB, Anime Skip ; IntroDB peu soumis passe en queue.
 */
const RANK = { introdbTrusted: 0, aniskip: 1, skipdb: 2, animeskip: 3, introdbWeak: 4 } as const;
/** Soumissions IntroDB minimales pour qu'un segment soit préféré. */
const TRUSTED_SUBMISSIONS = 2;
/** Écart maximal (secondes) entre deux sources sur le début et la fin pour qu'elles concordent et fusionnent. */
const MERGE_SECONDS = 5;
/** Confiance ajoutée par source concordante supplémentaire (plafonnée à 1). Sans confiance rapportée : 0,5 de base. */
const AGREE_BONUS = 0.2;
const UNREPORTED_CONFIDENCE = 0.5;
/** Garde-fous de position (quand la durée de l'épisode est connue) : générique après 50 %, intro avant 40 %. */
const CREDITS_MIN_SHARE = 0.5;
const INTRO_MAX_SHARE = 0.4;
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
    const submissions = num(segment.submission_count);
    const trusted = submissions !== undefined && submissions >= TRUSTED_SUBMISSIONS;
    const candidate: Candidate = { kind, start, end, source: 'introdb', priority: trusted ? RANK.introdbTrusted : RANK.introdbWeak };
    const confidence = num(segment.confidence);
    if (confidence !== undefined) candidate.confidence = confidence;
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * SkipDB (lecture ouverte, 120 req/min) : intro, reprise, générique de fin (« outro ») et aperçu. Les segments hors
 * repère (`match: out-of-range`) sont écartés : l'API les qualifie d'incertains. Sans `duration`, le repère est
 * « agnostic » (pas de comparaison possible) ; la durée fournie est celle d'AniSkip quand il l'a donnée.
 */
const SKIPDB_FIELDS: readonly [string, SkipKind][] = [
  ['intro', 'intro'],
  ['recap', 'recap'],
  ['outro', 'credits'],
  ['preview', 'preview'],
];

async function skipdbSegments(ctx: LtContext, target: SkipTarget, durationSeconds: number | undefined): Promise<Candidate[]> {
  const query = new URLSearchParams({ imdb_id: target.imdbId });
  if (target.type === 'series') {
    query.set('season', String(target.season));
    query.set('episode', String(target.episode));
  }
  if (durationSeconds !== undefined) query.set('duration', String(durationSeconds));
  const json = await jsonOrNothing(ctx, `${SKIPDB_BASE}/api/segments?${query}`, { headers: { accept: 'application/json' } });
  if (!isRecord(json) || !isRecord(json.segments)) return [];
  const candidates: Candidate[] = [];
  for (const [field, kind] of SKIPDB_FIELDS) {
    const segment = json.segments[field];
    if (!isRecord(segment) || segment.match === 'out-of-range') continue;
    const start = num(segment.start_ms);
    const end = num(segment.end_ms);
    if (start === undefined || end === undefined || end <= start) continue;
    const candidate: Candidate = { kind, start: start / 1000, end: end / 1000, source: 'skipdb', priority: RANK.skipdb };
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
  const found: { type: string; candidate: Candidate }[] = [];
  let episodeLength: number | undefined;
  for (const result of json.results) {
    if (!isRecord(result)) continue;
    const type = typeof result.skipType === 'string' ? result.skipType : undefined;
    const kind = type === undefined ? undefined : ANISKIP_KINDS[type];
    const interval = result.interval;
    if (type !== undefined && kind !== undefined && isRecord(interval)) {
      const start = num(interval.startTime);
      const end = num(interval.endTime);
      if (start !== undefined && end !== undefined && end > start) {
        found.push({ type, candidate: { kind, start, end, source: 'aniskip', priority: RANK.aniskip } });
      }
    }
    const length = num(result.episodeLength);
    if (episodeLength === undefined && length !== undefined && length > 0) episodeLength = length;
  }
  // mixed-op / mixed-ed (génériques mêlés à l'épisode) ne comptent que sans op / ed simple de l'épisode.
  const hasPlain = (type: string): boolean => found.some((item) => item.type === type);
  const candidates = found
    .filter((item) => !(item.type === 'mixed-op' && hasPlain('op')) && !(item.type === 'mixed-ed' && hasPlain('ed')))
    .map((item) => item.candidate);
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
    candidates.push({ kind, start: stamp.at, end: next.at, source: 'animeskip', priority: RANK.animeskip });
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
 * Garde-fous de position, quand la durée de l'épisode est connue : un générique qui commence avant la moitié de
 * l'épisode, ou une intro qui commence après 40 %, est écarté.
 */
function plausible(candidate: Candidate, episodeLength: number | undefined): boolean {
  if (episodeLength === undefined) return true;
  if (candidate.kind === 'credits') return candidate.start >= episodeLength * CREDITS_MIN_SHARE;
  if (candidate.kind === 'intro') return candidate.start <= episodeLength * INTRO_MAX_SHARE;
  return true;
}

/** Confiance d'un segment fusionné : la meilleure confiance des sources, plus un bonus par source concordante. */
function agreedConfidence(members: Candidate[]): number {
  const best = Math.max(...members.map((member) => member.confidence ?? UNREPORTED_CONFIDENCE));
  return Math.min(1, best + AGREE_BONUS * (members.length - 1));
}

/** Segment retenu et sources qui concordent avec lui (la première est la source de tête, aux bornes retenues). */
interface Group {
  head: Candidate;
  members: Candidate[];
}

/**
 * Fusion, dans l'ordre de rang (puis confiance, puis début) :
 * - garde-fous de position (ci-dessus) ;
 * - deux sources différentes du même type qui concordent (début et fin à ±5 s) fusionnent : bornes de la source de
 *   tête, confiance relevée, liste des sources ;
 * - un segment qui chevauche un segment retenu, quel que soit son type, est écarté : jamais de chevauchement.
 */
function mergeCandidates(candidates: Candidate[], episodeLength: number | undefined): SkipSegment[] {
  const ordered = candidates
    .filter((candidate) => plausible(candidate, episodeLength))
    .sort((a, b) => a.priority - b.priority || (b.confidence ?? 0) - (a.confidence ?? 0) || a.start - b.start);
  const groups: Group[] = [];
  for (const candidate of ordered) {
    const agreeing = groups.find(
      (group) =>
        group.head.kind === candidate.kind &&
        !group.members.some((member) => member.source === candidate.source) &&
        Math.abs(group.head.start - candidate.start) <= MERGE_SECONDS &&
        Math.abs(group.head.end - candidate.end) <= MERGE_SECONDS,
    );
    if (agreeing !== undefined) {
      agreeing.members.push(candidate);
      continue;
    }
    const clash = groups.some((group) => candidate.start < group.head.end && group.head.start < candidate.end);
    if (!clash) groups.push({ head: candidate, members: [candidate] });
  }
  return groups
    .map(({ head, members }): SkipSegment => {
      const segment: SkipSegment = { kind: head.kind, start: head.start, end: head.end, source: head.source };
      if (members.length > 1) {
        segment.sources = members.map((member) => member.source);
        segment.confidence = agreedConfidence(members);
      } else if (head.confidence !== undefined) {
        segment.confidence = head.confidence;
      }
      return segment;
    })
    .sort((a, b) => a.start - b.start);
}

function toResponse(candidates: Candidate[], episodeLength: number | undefined): SkipResponse {
  const segments = mergeCandidates(candidates, episodeLength);
  return episodeLength === undefined ? { segments } : { segments, episodeLength };
}

/** Résultat de la recherche de sources : `complete` faux si une source a échoué (la réponse n'est alors pas mise en cache). */
interface Sourced {
  response: SkipResponse;
  complete: boolean;
}

/**
 * Interroge les sources d'une cible et fusionne. Série d'animation (ARM la rattache à un MAL) : AniSkip, puis Anime Skip
 * si son identifiant client est configuré. IntroDB et SkipDB sont interrogés dans tous les cas, en parallèle. Une source
 * en échec ne fait échouer la réponse que si aucune autre n'a donné de segment ; sinon la réponse part sans elle.
 */
async function fetchSegments(ctx: LtContext, services: Config['services'], target: SkipTarget): Promise<Sourced> {
  const entries = target.type === 'series' ? await armEntries(ctx, target.imdbId) : [];
  const entry = target.type === 'series' ? armEntryFor(entries, target.season) : undefined;
  const anime: { candidates: Candidate[]; episodeLength?: number } =
    entry?.mal !== undefined ? await aniskipSegments(ctx, entry.mal, target.episode) : { candidates: [] };
  const candidates = [...anime.candidates];
  if (entry?.anilist !== undefined && services.animeskipClientId !== undefined) {
    candidates.push(...(await animeskipSegments(ctx, services.animeskipClientId, entry.anilist, target.season, target.episode)));
  }
  const [introdb, skipdb] = await Promise.allSettled([
    introdbSegments(ctx, services.introdbApiKey, target),
    skipdbSegments(ctx, target, anime.episodeLength),
  ]);
  const failures = [introdb, skipdb].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  for (const result of [introdb, skipdb]) {
    if (result.status === 'fulfilled') candidates.push(...result.value);
  }
  const [firstFailure] = failures;
  if (firstFailure !== undefined) {
    if (candidates.length === 0) throw firstFailure.reason;
    const code = firstFailure.reason instanceof LtError ? firstFailure.reason.code : 'inconnu';
    console.warn(`[lt][skip] source externe indisponible, autres sources seules (statut amont : ${code})`);
  }
  return { response: toResponse(candidates, anime.episodeLength), complete: failures.length === 0 };
}

/**
 * Segments de saut d'une cible : IntroDB et SkipDB (film ou série live), ou en plus AniSkip et Anime Skip (série
 * d'animation). Fusion des concordances, voir mergeCandidates. Cache partagé, sans clé de service dans la clé (seulement
 * l'état d'Anime Skip) : 7 jours si un segment est trouvé, 6 h sinon, jamais si une source a échoué.
 */
export async function skipSegments(ctx: LtContext, services: Config['services'], target: SkipTarget): Promise<SkipResponse> {
  const animeskipOn = services.animeskipClientId !== undefined ? '1' : '0';
  const key = `skip:${target.type}:${target.imdbId}:${target.season}:${target.episode}:${animeskipOn}`;
  const sourced = await ctx.state.cache.get<Sourced>(
    key,
    (result) => (!result.complete ? 0 : result.response.segments.length > 0 ? TTL.skip : TTL.skipEmpty),
    () => fetchSegments(ctx, services, target),
  );
  return sourced.response;
}
