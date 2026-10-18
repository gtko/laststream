/* Épisodes d'une saison : numérotation canonique de lastAddon (ordre diffusé TVDB / groupe TMDB), sinon saisons TMDB. */
import { getVideoLang } from '../data/prefs';
import { tmdb } from '../data/lt';
import { fetchCanon, tmdbShape } from '../data/series';

export const canonical = (id) => fetchCanon(id, getVideoLang().tag);

/** { episodes } au format TMDB pour la saison n ; `canonical` indique la source. */
export async function seasonEpisodes(id, n) {
  const c = await canonical(id);
  if (c) {
    const s = c.seasons.find((x) => x.number === n);
    return { episodes: s ? s.episodes.map(tmdbShape) : [], name: s ? s.name : '', canonical: true };
  }
  const d = await tmdb('tv/' + id + '/season/' + n);
  return { ...d, canonical: false };
}

/** Numéro de la saison suivante dans la numérotation canonique ; sinon n + 1 (TMDB). */
export async function nextSeasonNumber(id, n) {
  const c = await canonical(id);
  if (!c) return n + 1;
  const after = c.seasons.filter((s) => s.number > n && s.episodes.length).map((s) => s.number);
  return after.length ? Math.min(...after) : null;
}
