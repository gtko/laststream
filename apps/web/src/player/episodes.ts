/* Saisons et épisodes pour le panneau du lecteur : réponse canonique de lastAddon (/lt/series/:tmdbId/episodes) ou saison TMDB. */

export interface EpisodeInfo {
  episode: number;
  name: string;
  runtime: number | null;
  overview: string;
  still: string;
  airDate: string;
  /** Déjà diffusé à la date donnée. */
  aired: boolean;
  /** Lisible : diffusé, ou diffusion dans les 14 prochains jours (« peut-être déjà en ligne », la recherche de sources décide). */
  playable: boolean;
  /** Identifiant de flux `<imdb>:<saison>:<épisode>` selon la numérotation du serveur ; absent si l'IMDb est inconnu. */
  streamId?: string;
}

export interface SeasonInfo {
  season: number;
  count: number;
}

export interface CanonicalSeries {
  seasons: SeasonInfo[];
  episodes: Map<number, EpisodeInfo[]>;
}

/** Jour civil de l'appareil (AAAA-MM-JJ) : l'épisode diffusé ce jour-là est diffusé, même avant minuit UTC. */
export const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Fenêtre « peut-être déjà en ligne » : les épisodes diffusés dans les 14 prochains jours sont lisibles. */
const SOON_WINDOW_DAYS = 14;

/** Un épisode sans date est considéré comme diffusé (les séries anciennes n'en ont pas toujours). */
export function isAired(airDate: string, today: string = localDay(new Date())): boolean {
  return !airDate || airDate <= today;
}

/** Jours entre `today` et `airDate` (AAAA-MM-JJ) ; null si une des deux dates n'est pas exploitable. */
function daysUntil(airDate: string, today: string = localDay(new Date())): number | null {
  if (!ISO_DAY.test(airDate) || !ISO_DAY.test(today)) return null;
  const diff = Math.round((Date.parse(airDate) - Date.parse(today)) / DAY_MS);
  return Number.isFinite(diff) ? diff : null;
}

/**
 * Diffusion dans les 1 à 14 jours qui suivent `today` : l'épisode peut déjà être en ligne (streaming avant la TV).
 * Aujourd'hui ou passé : c'est `isAired`, pas ce cas. Sans date, ou au-delà de 14 jours : false.
 */
export function playableSoon(airDate: string, today: string = localDay(new Date())): boolean {
  const d = daysUntil(airDate, today);
  return d !== null && d >= 1 && d <= SOON_WINDOW_DAYS;
}

/** Lisible maintenant : diffusé, ou diffusion proche (voir `playableSoon`). */
export function isPlayable(airDate: string, today: string = localDay(new Date())): boolean {
  return isAired(airDate, today) || playableSoon(airDate, today);
}

/**
 * Épisode suivant pour l'enchaînement automatique. Un épisode connu mais pas encore diffusé n'est jamais lancé
 * automatiquement (lancement manuel seulement). Épisode non chargé : inchangé, la recherche de sources décide.
 */
export function autoNextEpisode(
  next: { season: number; episode: number } | null, episodes: ReadonlyMap<number, readonly EpisodeInfo[]>,
): { season: number; episode: number } | null {
  if (!next) return null;
  const info = (episodes.get(next.season) ?? []).find((e) => e.episode === next.episode);
  return !info || info.aired ? next : null;
}

/** Réponse canonique `{ seasons: [{ number, episodeCount }], episodes: [{ season, episode, name… }] }` ; null si inexploitable. */
export function normalizeCanonical(resp: unknown, today: string = localDay(new Date())): CanonicalSeries | null {
  const r = resp as { seasons?: unknown; episodes?: unknown } | null;
  if (!r || !Array.isArray(r.episodes) || !r.episodes.length) return null;
  const episodes = new Map<number, EpisodeInfo[]>();
  for (const raw of r.episodes) {
    const e = raw as { season?: unknown; episode?: unknown; name?: unknown; overview?: unknown; airDate?: unknown; runtime?: unknown; still?: unknown; streamId?: unknown } | null;
    if (!e || typeof e.season !== 'number' || typeof e.episode !== 'number' || e.season < 1) continue;
    const airDate = typeof e.airDate === 'string' ? e.airDate : '';
    const list = episodes.get(e.season) ?? [];
    list.push({
      episode: e.episode, name: typeof e.name === 'string' ? e.name : '', runtime: typeof e.runtime === 'number' ? e.runtime : null,
      overview: typeof e.overview === 'string' ? e.overview : '', still: typeof e.still === 'string' ? e.still : '', airDate,
      aired: isAired(airDate, today), playable: isPlayable(airDate, today),
      ...(typeof e.streamId === 'string' && e.streamId !== '' ? { streamId: e.streamId } : {}),
    });
    episodes.set(e.season, list);
  }
  episodes.forEach((list) => list.sort((a, b) => a.episode - b.episode));
  const seasons = [...episodes.entries()].map(([season, list]) => ({ season, count: list.length })).sort((a, b) => a.season - b.season);
  return seasons.length ? { seasons, episodes } : null;
}

/** Filtre de recherche : numéro (« 5 », « é5 ») ou morceau du titre, sans accents ni casse. */
export function filterEpisodes(list: readonly EpisodeInfo[], query: string): EpisodeInfo[] {
  const strip = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = strip(query.trim());
  if (!q) return [...list];
  const num = /^(?:e|ep|episode)?\s*(\d+)$/.exec(q);
  return list.filter((e) => (num ? e.episode === Number(num[1]) : strip(e.name).includes(q) || strip(e.overview).includes(q)));
}

/** Premier épisode lisible (diffusé ou bientôt disponible) et non vu, en partant de la saison donnée puis les suivantes. */
export function firstUnseen(
  seasons: readonly SeasonInfo[], episodes: ReadonlyMap<number, readonly EpisodeInfo[]>, fromSeason: number, seen: (season: number, episode: number) => boolean,
): { season: number; episode: number } | null {
  for (const s of [...seasons].sort((a, b) => a.season - b.season)) {
    if (s.season < fromSeason) continue;
    for (const e of episodes.get(s.season) ?? []) if (e.playable && !seen(s.season, e.episode)) return { season: s.season, episode: e.episode };
  }
  return null;
}
