import type { Config } from '../config/schema.js';
import { isRecord } from '../sources/http.js';
import type { SkipRepo } from '../user/repo.js';
import type { AutoSegment, CommunityKind, CommunitySegment, Proposal } from '../user/skip-segments.js';
import type { AutoDetector } from './detect/index.js';
import { seriesEpisodes, type SeriesEpisode } from './episodes.js';
import { LtError, type LtContext, ltRequest, TTL } from './context.js';
import {
  INTRODB_BASE,
  parseSkipTarget,
  SKIPDB_BASE,
  type SkipResponse,
  type SkipSegment,
  skipSegments,
  type SkipTarget,
} from './skip.js';
import { inferCredits, inferIntro, type Span } from './skip-infer.js';
import { tmdbGet } from './providers.js';

/** Recherches de voisins par requête (épisodes de la même saison, les plus proches d'abord). */
const SIBLING_LOOKUPS = 6;
/** Confiance d'un segment déduit (ni vérifié ni voté). */
const INFERRED_CONFIDENCE = 0.5;
/** Longueur maximale d'un segment proposé, par type (secondes). */
const MAX_SEGMENT_SECONDS: Record<CommunityKind, number> = { intro: 300, recap: 300, credits: 600, postcredits: 600 };
/** Durée maximale d'un épisode ou d'un film proposé (24 h). */
const MAX_DURATION_SECONDS = 86_400;
/** Type de segment côté IntroDB (les films utilisent « outro » et « post-credits »). */
const INTRODB_TYPE: Record<CommunityKind, string> = {
  intro: 'intro',
  recap: 'recap',
  credits: 'outro',
  postcredits: 'post-credits',
};

/** Type de segment côté SkipDB. Pas de post-générique chez SkipDB : ce type n'est pas envoyé. */
const SKIPDB_TYPE: Partial<Record<CommunityKind, string>> = { intro: 'intro', recap: 'recap', credits: 'outro' };

type Services = Config['services'];

/** Proposition (ou vote négatif) validée. */
interface Submission {
  target: SkipTarget;
  kind: CommunityKind;
  start: number;
  end: number;
  duration: number;
  negative: boolean;
}

/** Résultat de la déduction d'une saison. `complete` faux si un voisin ou TMDB a échoué : rien n'est alors mis en cache. */
interface Inferred {
  segments: SkipSegment[];
  complete: boolean;
}

/** Épisode voisin, avec ses segments (externes, ou communautaires à défaut) et sa durée si elle est connue. */
interface Neighbour {
  episode: number;
  segments: SkipSegment[];
  duration: number | undefined;
}

export interface SkipCommunity {
  /** Segments d'une cible : services externes, puis communauté, puis déduction de saison (série uniquement). */
  resolve(services: Services, target: SkipTarget): Promise<SkipResponse>;
  /** Enregistre une proposition, ou un vote négatif sur les propositions qu'il vise. */
  submit(services: Services, body: Record<string, unknown>): Promise<{ applied: number }>;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Durée en secondes à partir d'une durée TMDB/TVDB en minutes, ou undefined si inconnue. */
function secondsOf(runtimeMinutes: number | null | undefined): number | undefined {
  return runtimeMinutes !== null && runtimeMinutes !== undefined && runtimeMinutes > 0 ? runtimeMinutes * 60 : undefined;
}

/**
 * Corps de POST /skip/submit validé. Toute anomalie : 400 invalid_submission, sans écho de la valeur saisie.
 * Un segment va de 0 à la durée (début < fin ≤ durée) et ne dépasse pas sa limite par type.
 */
function parseSubmission(body: Record<string, unknown>): Submission {
  const invalid = (): never => {
    throw new LtError(400, 'invalid_submission');
  };
  const { type, imdbId, season, episode, kind, start, end, duration, negative } = body;
  if (typeof type !== 'string' || typeof imdbId !== 'string') return invalid();
  if (typeof season !== 'number' || typeof episode !== 'number') return invalid();
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return invalid();
  let target: SkipTarget;
  try {
    target = parseSkipTarget(type, imdbId, String(season), String(episode));
  } catch {
    return invalid();
  }
  if (typeof kind !== 'string' || !Object.hasOwn(MAX_SEGMENT_SECONDS, kind)) return invalid();
  if (!isNumber(start) || !isNumber(end) || !isNumber(duration)) return invalid();
  if (negative !== undefined && typeof negative !== 'boolean') return invalid();
  const segmentKind = kind as CommunityKind;
  const valid =
    start >= 0 &&
    end > start &&
    duration > 0 &&
    duration <= MAX_DURATION_SECONDS &&
    end <= duration &&
    end - start <= MAX_SEGMENT_SECONDS[segmentKind];
  if (!valid) return invalid();
  return { target, kind: segmentKind, start, end, duration, negative: negative === true };
}

/** Segment communautaire mis au format de réponse. */
function communityToSegment(segment: CommunitySegment): SkipSegment {
  return { kind: segment.kind, start: segment.start, end: segment.end, source: 'community', confidence: segment.confidence };
}

/** Segment détecté localement mis au format de réponse. */
function autoToSegment(segment: AutoSegment): SkipSegment {
  return { kind: segment.kind, start: segment.start, end: segment.end, source: 'auto', confidence: segment.confidence, method: segment.method };
}

/**
 * Segments des couches dans l'ordre de priorité : une couche n'apporte que les types absents des précédentes, et
 * jamais un segment qui en chevauche un déjà retenu.
 */
function layered(layers: readonly SkipSegment[][]): SkipSegment[] {
  const chosen: SkipSegment[] = [];
  for (const layer of layers) {
    const taken = new Set(chosen.map((segment) => segment.kind));
    for (const segment of layer) {
      if (taken.has(segment.kind)) continue;
      if (chosen.some((other) => segment.start < other.end && other.start < segment.end)) continue;
      chosen.push(segment);
    }
  }
  return chosen.sort((a, b) => a.start - b.start);
}

function inferredSegment(kind: 'intro' | 'credits', span: { start: number; end: number }): SkipSegment {
  return { kind, start: span.start, end: span.end, source: 'inferred', inferred: true, confidence: INFERRED_CONFIDENCE };
}

/** Identifiant TMDB d'une série à partir de son identifiant IMDb, ou undefined. */
async function tmdbIdOf(ctx: LtContext, token: string, imdbId: string): Promise<string | undefined> {
  const json = await tmdbGet(ctx, token, `find/${imdbId}`, { external_source: 'imdb_id' });
  const results = isRecord(json) && Array.isArray(json.tv_results) ? json.tv_results.filter(isRecord) : [];
  const [first] = results;
  const id = first?.id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : undefined;
}

/**
 * Segments communautaires et déduits. `store` fournit les segments de la base utilisateur (ouverte au premier besoin).
 * Les propositions incrémentent un compteur par saison : la déduction (cache 7 j) est recalculée après tout ajout.
 */
export function createSkipCommunity(ctx: LtContext, store: () => SkipRepo, detector?: AutoDetector): SkipCommunity {
  const db = store;
  const seasonKey = (imdbId: string, season: number): string => `${imdbId}:${season}`;
  const seasonEpochs = new Map<string, number>();
  const epochOf = (imdbId: string, season: number): number => seasonEpochs.get(seasonKey(imdbId, season)) ?? 0;

  function forwardToIntroDb(apiKey: string, sub: Submission): void {
    const { target } = sub;
    const payload = {
      segment_type: INTRODB_TYPE[sub.kind],
      imdb_id: target.imdbId,
      ...(target.type === 'movie' ? { is_movie: true } : { season: target.season, episode: target.episode }),
      start_sec: sub.start,
      end_sec: sub.end,
    };
    // Best-effort : jamais bloquant, jamais de clé dans les journaux.
    ltRequest(ctx, `${INTRODB_BASE}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) console.warn(`[lt][skip] envoi IntroDB refusé (statut amont : ${res.status})`);
      })
      .catch((err: unknown) => {
        console.warn(`[lt][skip] envoi IntroDB indisponible (${err instanceof LtError ? err.code : 'erreur'})`);
      });
  }

  /** Envoi à SkipDB (POST /api/segments, durées en millisecondes). Best-effort, comme IntroDB : jamais de clé dans les journaux. */
  function forwardToSkipDb(apiKey: string, sub: Submission): void {
    const { target } = sub;
    const segmentType = SKIPDB_TYPE[sub.kind];
    if (segmentType === undefined) return;
    const payload = {
      imdb_id: target.imdbId,
      segment_type: segmentType,
      ...(target.type === 'movie' ? {} : { season: target.season, episode: target.episode }),
      start_ms: Math.round(sub.start * 1000),
      end_ms: Math.round(sub.end * 1000),
      duration_ms: Math.round(sub.duration * 1000),
    };
    ltRequest(ctx, `${SKIPDB_BASE}/api/segments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) console.warn(`[lt][skip] envoi SkipDB refusé (statut amont : ${res.status})`);
      })
      .catch((err: unknown) => {
        console.warn(`[lt][skip] envoi SkipDB indisponible (${err instanceof LtError ? err.code : 'erreur'})`);
      });
  }

  /**
   * Déduction pour une série : voisins de la saison (au plus SIBLING_LOOKUPS, les plus proches d'abord), puis intro et
   * générique communs. Le générique se reporte sur la durée de la cible, connue par la structure ou à défaut.
   */
  async function computeInference(services: Services, token: string, target: SkipTarget, externalLength: number | undefined): Promise<Inferred> {
    const { imdbId } = target;
    let episodes: SeriesEpisode[];
    try {
      const tmdbId = await tmdbIdOf(ctx, token, imdbId);
      if (tmdbId === undefined) return { segments: [], complete: true };
      const structure = await seriesEpisodes(
        ctx,
        { tmdbToken: token, tvdbApiKey: services.tvdbApiKey, tvdbPin: services.tvdbPin },
        tmdbId,
        undefined,
      );
      episodes = structure.episodes;
    } catch (err) {
      if (!(err instanceof LtError)) throw err;
      console.warn(`[lt][skip] déduction de saison indisponible (statut amont : ${err.code})`);
      return { segments: [], complete: false };
    }
    const season = episodes.filter((episode) => episode.season === target.season);
    const own = season.find((episode) => episode.episode === target.episode);
    const targetDuration =
      secondsOf(own?.runtime) ?? externalLength ?? (await db().durationOf(imdbId, target.season, target.episode));
    const siblings = season
      .filter((episode) => episode.episode !== target.episode)
      .sort(
        (a, b) =>
          Math.abs(a.episode - target.episode) - Math.abs(b.episode - target.episode) || a.episode - b.episode,
      )
      .slice(0, SIBLING_LOOKUPS);
    const looked = await Promise.all(
      siblings.map(async (sibling): Promise<Neighbour | undefined> => {
        try {
          const external = await skipSegments(ctx, services, {
            type: 'series',
            imdbId,
            season: target.season,
            episode: sibling.episode,
          });
          const segments =
            external.segments.length > 0
              ? external.segments
              : (await db().segmentsFor(imdbId, target.season, sibling.episode)).map(communityToSegment);
          const duration =
            secondsOf(sibling.runtime) ?? external.episodeLength ?? (await db().durationOf(imdbId, target.season, sibling.episode));
          return { episode: sibling.episode, segments, duration };
        } catch (err) {
          console.warn(`[lt][skip] épisode voisin indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
          return undefined;
        }
      }),
    );
    const neighbours = looked.filter((item): item is Neighbour => item !== undefined);
    const complete = neighbours.length === looked.length;

    const intros: Span[] = [];
    const credits: Span[] = [];
    for (const neighbour of neighbours) {
      const intro = neighbour.segments.find((segment) => segment.kind === 'intro');
      if (intro !== undefined) intros.push({ episode: neighbour.episode, a: intro.start, b: intro.end });
      const outro = neighbour.segments.find((segment) => segment.kind === 'credits');
      if (outro !== undefined && neighbour.duration !== undefined) {
        credits.push({ episode: neighbour.episode, a: neighbour.duration - outro.start, b: neighbour.duration - outro.end });
      }
    }
    const segments: SkipSegment[] = [];
    const intro = inferIntro(intros);
    if (intro !== undefined) segments.push(inferredSegment('intro', intro));
    const tail = targetDuration === undefined ? undefined : inferCredits(credits, targetDuration);
    if (tail !== undefined) segments.push(inferredSegment('credits', tail));
    return { segments, complete };
  }

  async function inferSeason(services: Services, target: SkipTarget, externalLength: number | undefined): Promise<SkipSegment[]> {
    const token = services.tmdbToken;
    if (token === undefined) return [];
    const tvdb = services.tvdbApiKey === undefined ? 'tmdb' : 'tvdb';
    const key = `skip-infer:${target.imdbId}:${target.season}:${target.episode}:${epochOf(target.imdbId, target.season)}:${tvdb}`;
    const inferred = await ctx.state.cache.get<Inferred>(
      key,
      (value) => (value.complete ? TTL.skip : 0),
      () => computeInference(services, token, target, externalLength),
    );
    return inferred.segments;
  }

  async function resolve(services: Services, target: SkipTarget): Promise<SkipResponse> {
    const external = await skipSegments(ctx, services, target);
    const community = (await db().segmentsFor(target.imdbId, target.season, target.episode)).map(communityToSegment);
    const auto = (await db().autoSegmentsFor(target.imdbId, target.season, target.episode))
      .sort((a, b) => b.confidence - a.confidence)
      .map(autoToSegment);
    const lacks = (layers: SkipSegment[][]): boolean =>
      target.type === 'series' &&
      (['intro', 'credits'] as const).some((kind) => !layers.some((layer) => layer.some((segment) => segment.kind === kind)));
    // Priorité : services externes > communauté > détection locale (chapitres 0,95, empreinte 0,8) > déduction de saison (0,5).
    const layers = [external.segments, community, auto];
    const inferred = lacks(layers) ? await inferSeason(services, target, external.episodeLength) : [];
    const response: SkipResponse = { segments: layered([...layers, inferred]) };
    if (external.episodeLength !== undefined) response.episodeLength = external.episodeLength;
    if (detector?.analyzing(target) === true) response.analyzing = true;
    return response;
  }

  async function submit(services: Services, body: Record<string, unknown>): Promise<{ applied: number }> {
    const sub = parseSubmission(body);
    const { target } = sub;
    const proposal: Proposal = {
      imdbId: target.imdbId,
      season: target.season,
      episode: target.episode,
      kind: sub.kind,
      start: sub.start,
      end: sub.end,
      duration: sub.duration,
    };
    let applied: number;
    if (sub.negative) {
      applied = await db().dispute(proposal);
    } else {
      await db().propose(proposal, new Date().toISOString());
      applied = 1;
    }
    if (applied > 0) seasonEpochs.set(seasonKey(target.imdbId, target.season), epochOf(target.imdbId, target.season) + 1);
    if (!sub.negative && services.introdbApiKey !== undefined) forwardToIntroDb(services.introdbApiKey, sub);
    if (!sub.negative && services.skipdbApiKey !== undefined) forwardToSkipDb(services.skipdbApiKey, sub);
    return { applied };
  }

  return { resolve, submit };
}
