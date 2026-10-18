/** Calculs sur les épisodes d'une série (nombre de nouveaux épisodes non vus). */
export interface SeasonInfo {
  season_number: number;
  episode_count?: number;
}
export interface AiredRef {
  season_number: number;
  episode_number: number;
}
export interface WatchedKey {
  season: number;
  episode: number;
}

/** Position d'un épisode dans la série (saisons ordonnées, saison 0 exclue), à partir de 1 ; 0 si inconnu. */
export function episodeIndex(seasons: SeasonInfo[], season: number, episode: number): number {
  let before = 0;
  for (const s of seasons.filter((x) => x.season_number > 0).sort((a, b) => a.season_number - b.season_number)) {
    if (s.season_number === season) return before + episode;
    before += s.episode_count ?? 0;
  }
  return 0;
}

/**
 * Nombre d'épisodes diffusés après le dernier épisode vu : `+N` des tuiles. Sans dernier épisode diffusé connu, 0.
 * Aucun épisode vu : tous les épisodes diffusés comptent seulement si `countAllWhenNone` (série suivie, jamais commencée).
 */
export function newEpisodeCount(seasons: SeasonInfo[], lastAired: AiredRef | null | undefined, watched: WatchedKey[], countAllWhenNone = false): number {
  if (!lastAired || !lastAired.season_number) return 0;
  const aired = episodeIndex(seasons, lastAired.season_number, lastAired.episode_number);
  if (!aired) return 0;
  if (!watched.length) return countAllWhenNone ? aired : 0;
  const last = Math.max(...watched.map((w) => episodeIndex(seasons, w.season, w.episode)));
  return Math.max(0, aired - last);
}
