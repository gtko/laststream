import type { Config } from './config/schema.js';
import { getRuntimeSeconds } from './engine/cinemeta.js';
import { dedupe } from './engine/dedupe.js';
import { filterCandidates } from './engine/filter.js';
import { formatStreams } from './engine/format.js';
import { rankCandidates, selectForCacheCheck } from './engine/score.js';
import { type Candidate, infoHashOf } from './engine/types.js';
import { parseRawStream } from './parse/index.js';
import type { AllDebridClient } from './sources/alldebrid.js';
import { collectStreams, type SourceErrorEntry } from './sources/collect.js';
import type { ContentRef, StremioStream } from './types.js';

/** Nombre maximal d'infoHash interrogés auprès du débrideur pour le statut « cache » (les N premiers après classement). */
const CACHE_CHECK_LIMIT = 8;

export interface PipelineContext {
  /** Base publique du endpoint de lecture (ex. https://addon.example.com). */
  playBaseUrl: string;
  /** Segment de configuration tel que reçu, réutilisé dans les URL de lecture. */
  configToken: string;
  /** fetch injecté pour les sources, Cinemeta (tests). Par défaut : fetch global. */
  fetch?: typeof fetch;
  /** Client debrid pour le statut « cache ». Absent : aucune vérification. */
  debrid?: Pick<AllDebridClient, 'checkCached'>;
}

export interface PipelineResult {
  streams: StremioStream[];
  /** Erreurs isolées des sources : elles ne font jamais échouer la requête. */
  errors: SourceErrorEntry[];
}

/** Interroge le débrideur. Une erreur ou un lot inconnu vaut « non caché » : jamais d'exception. */
async function checkCachedSafely(
  debrid: Pick<AllDebridClient, 'checkCached'>,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  try {
    return await debrid.checkCached(hashes);
  } catch {
    return new Map<string, boolean>();
  }
}

function markCached(candidate: Candidate, cached: ReadonlyMap<string, boolean>): Candidate {
  const hash = infoHashOf(candidate)?.toLowerCase();
  return hash !== undefined && cached.get(hash) === true ? { ...candidate, cached: true } : candidate;
}

/**
 * Agrège les streams de toutes les sources : parsing, filtre, déduplication, classement,
 * statut « cache » debrid (si configuré), puis formatage Stremio.
 * La durée (Cinemeta) est lue en parallèle de la collecte ; son échec est silencieux.
 */
export async function getStreams(config: Config, ref: ContentRef, ctx: PipelineContext): Promise<PipelineResult> {
  // getRuntimeSeconds ne rejette jamais : la durée ne peut pas faire échouer la requête.
  const runtime = getRuntimeSeconds(ref, { fetch: ctx.fetch });
  const collected = await collectStreams(config, ref, { fetch: ctx.fetch });
  const runtimeSeconds = await runtime;

  // Chaque stream est parsé une seule fois ; les étapes suivantes ne lisent que ParsedRelease.
  const candidates: Candidate[] = collected.streams.map((raw) => ({ raw, parsed: parseRawStream(raw) }));
  // Premier passage sans onlyCached : l'exigence de cache ne peut s'appliquer qu'après la vérification.
  const passed = filterCandidates(candidates, { ...config, onlyCached: false });
  let unique = dedupe(passed);

  if (config.debrid !== undefined && ctx.debrid !== undefined) {
    const hashes = selectForCacheCheck(rankCandidates(unique, config), CACHE_CHECK_LIMIT);
    if (hashes.length > 0) {
      const cached = await checkCachedSafely(ctx.debrid, hashes);
      // Dédoublonnage après marquage : un doublon caché doit remplacer un doublon non caché.
      unique = dedupe(passed.map((candidate) => markCached(candidate, cached)));
    }
  }

  const ranked = rankCandidates(filterCandidates(unique, config), config);
  const streams = formatStreams(ranked, {
    playBaseUrl: ctx.playBaseUrl,
    configToken: ctx.configToken,
    runtimeSeconds,
    maxResults: config.maxResults,
    hasDebrid: config.debrid !== undefined,
    season: ref.season,
    episode: ref.episode,
  });
  return { streams, errors: collected.errors };
}
