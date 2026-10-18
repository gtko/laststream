import type { MediaType, ProgressItem } from './store.js';
import { UserApiError } from './validation.js';

/** Un titre est terminé à partir de 90 % de sa durée. */
export const FINISHED_RATIO = 0.9;
/** Nombre maximal d'éléments renvoyés par « continuer à regarder ». */
export const CONTINUE_LIMIT = 30;
/** Nombre maximal d'épisodes parcourus pour trouver le prochain à proposer. */
const NEXT_EPISODE_SCAN_LIMIT = 200;

export function isFinished(positionSec: number, durationSec: number): boolean {
  return durationSec > 0 && positionSec >= durationSec * FINISHED_RATIO;
}

export interface ContinueItem {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number | null;
  updatedAt: string;
  /** Épisode suivant proposé après un épisode terminé (pas encore de progression enregistrée). */
  suggested: boolean;
}

export interface NormalizedProgress {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  season: number;
  episode: number;
  positionSec: number;
  durationSec: number;
  finished: boolean;
}

interface ProgressBody {
  type: MediaType;
  tmdbId?: number | undefined;
  imdbId?: string | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  positionSec: number;
  durationSec: number;
}

/**
 * Valide et normalise une écriture de progression. Un film a saison et épisode à 0 ; une série exige les deux.
 * La position ne dépasse jamais la durée quand elle est connue.
 */
export function normalizeProgress(body: ProgressBody): NormalizedProgress {
  if (body.tmdbId === undefined && body.imdbId === undefined) {
    throw new UserApiError(400, 'invalid_body', ['(racine):tmdbId_ou_imdbId_requis']);
  }
  let season = 0;
  let episode = 0;
  if (body.type === 'series') {
    if (body.season === undefined || body.episode === undefined) {
      throw new UserApiError(400, 'invalid_body', ['season_et_episode_requis']);
    }
    season = body.season;
    episode = body.episode;
  }
  const durationSec = body.durationSec;
  const positionSec = durationSec > 0 ? Math.min(body.positionSec, durationSec) : body.positionSec;
  return {
    type: body.type,
    tmdbId: body.tmdbId ?? null,
    imdbId: body.imdbId ?? null,
    season,
    episode,
    positionSec,
    durationSec,
    finished: isFinished(positionSec, durationSec),
  };
}

function toContinueItem(row: ProgressItem, suggested: boolean): ContinueItem {
  const series = row.type === 'series';
  return {
    type: row.type,
    tmdbId: row.tmdbId,
    imdbId: row.imdbId,
    season: series ? row.season : null,
    episode: series ? row.episode : null,
    positionSec: suggested ? 0 : row.positionSec,
    durationSec: suggested ? null : row.durationSec,
    updatedAt: row.updatedAt,
    suggested,
  };
}

/**
 * Épisode à proposer après un épisode terminé : le premier épisode suivant sans progression terminée. S'il a une
 * progression en cours, c'est elle qui est reprise ; sinon l'épisode suivant est proposé (sans progression).
 */
async function nextEpisodeAfter(row: ProgressItem, episodeAt: EpisodeLookup): Promise<ContinueItem | undefined> {
  for (let step = 1; step <= NEXT_EPISODE_SCAN_LIMIT; step++) {
    const episode = row.episode + step;
    const found = await episodeAt(row.type, row.titleRef, row.season, episode);
    if (found === undefined) {
      return toContinueItem({ ...row, episode, positionSec: 0, durationSec: 0, finished: false }, true);
    }
    if (!found.finished) return toContinueItem(found, false);
  }
  return undefined;
}

export type EpisodeLookup = (type: MediaType, titleRef: string, season: number, episode: number) => ProgressItem | undefined | Promise<ProgressItem | undefined>;

/**
 * « Continuer à regarder » : une entrée par titre (sa progression la plus récente), non terminée ; pour une série
 * terminée, l'épisode suivant. Trié par date de mise à jour décroissante, au plus CONTINUE_LIMIT éléments.
 * `latest` contient une ligne par titre.
 */
export async function continueWatching(latest: readonly ProgressItem[], episodeAt: EpisodeLookup, limit = CONTINUE_LIMIT): Promise<ContinueItem[]> {
  const candidates: ContinueItem[] = [];
  for (const row of latest) {
    if (!row.finished) {
      candidates.push(toContinueItem(row, false));
    } else if (row.type === 'series') {
      const next = await nextEpisodeAfter(row, episodeAt);
      if (next !== undefined) candidates.push(next);
    }
  }
  candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return candidates.slice(0, limit);
}
