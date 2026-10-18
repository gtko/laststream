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
}

export interface SeasonInfo {
  season: number;
  count: number;
}

export interface CanonicalSeries {
  seasons: SeasonInfo[];
  episodes: Map<number, EpisodeInfo[]>;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Un épisode sans date est considéré comme diffusé (les séries anciennes n'en ont pas toujours). */
export function isAired(airDate: string, today: string = isoDay(new Date())): boolean {
  return !airDate || airDate <= today;
}

/** Réponse canonique `{ seasons: [{ number, episodeCount }], episodes: [{ season, episode, name… }] }` ; null si inexploitable. */
export function normalizeCanonical(resp: unknown, today: string = isoDay(new Date())): CanonicalSeries | null {
  const r = resp as { seasons?: unknown; episodes?: unknown } | null;
  if (!r || !Array.isArray(r.episodes) || !r.episodes.length) return null;
  const episodes = new Map<number, EpisodeInfo[]>();
  for (const raw of r.episodes) {
    const e = raw as { season?: unknown; episode?: unknown; name?: unknown; overview?: unknown; airDate?: unknown; runtime?: unknown; still?: unknown } | null;
    if (!e || typeof e.season !== 'number' || typeof e.episode !== 'number' || e.season < 1) continue;
    const airDate = typeof e.airDate === 'string' ? e.airDate : '';
    const list = episodes.get(e.season) ?? [];
    list.push({
      episode: e.episode, name: typeof e.name === 'string' ? e.name : '', runtime: typeof e.runtime === 'number' ? e.runtime : null,
      overview: typeof e.overview === 'string' ? e.overview : '', still: typeof e.still === 'string' ? e.still : '', airDate, aired: isAired(airDate, today),
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

/** Premier épisode diffusé et non vu, en partant de la saison donnée puis les suivantes. */
export function firstUnseen(
  seasons: readonly SeasonInfo[], episodes: ReadonlyMap<number, readonly EpisodeInfo[]>, fromSeason: number, seen: (season: number, episode: number) => boolean,
): { season: number; episode: number } | null {
  for (const s of [...seasons].sort((a, b) => a.season - b.season)) {
    if (s.season < fromSeason) continue;
    for (const e of episodes.get(s.season) ?? []) if (e.aired && !seen(s.season, e.episode)) return { season: s.season, episode: e.episode };
  }
  return null;
}
