/* Port du prototype (voir tools/port-prototype.mjs). */
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { getVideoLang } from '../data/prefs';
import { sortVideos } from '../data/trailers';
import { certLabel, certification, pickLogo, pickTrailer, register, toItem, videoLanguages, videosOf } from './catalog.js';
import { IMG } from './constants.js';
import { names } from './util.js';

export const fullCache = new Map();
export const STATUS_FR = {
  Released: 'Sorti', 'Returning Series': 'En cours', Ended: 'Terminée', Canceled: 'Annulée',
  'In Production': 'En production', 'Post Production': 'En postproduction', Planned: 'Prévu', Rumored: 'Rumeur',
};
export const VIDEO_TYPE = {
  Trailer: ['Bande-annonce', 0], Teaser: ['Teaser', 1], Featurette: ['Featurette', 2],
  'Behind the Scenes': ['Making-of', 3], Clip: ['Extrait', 4], Bloopers: ['Bêtisier', 5], 'Opening Credits': ['Générique', 6],
};

export function frReleaseDate(raw) {
  const fr = ((raw.release_dates && raw.release_dates.results) || []).find((x) => x.iso_3166_1 === getRegion().code);
  if (!fr) return '';
  const dates = (fr.release_dates || []).filter((d) => d.release_date);
  const th = dates.filter((d) => d.type === 3 || d.type === 2);
  const pool = (th.length ? th : dates).map((d) => d.release_date.slice(0, 10)).sort();
  return pool[0] || '';
}

export function buildModel(type, id, raw, en) {
  const isTv = type === 'tv';
  const crew = (raw.credits && raw.credits.crew) || [];
  const uniq = (list) => Array.from(new Set(list));
  const videos = sortVideos(((raw.videos && raw.videos.results) || [])
    .filter((v) => v.site === 'YouTube' && v.key && VIDEO_TYPE[v.type]), (v) => VIDEO_TYPE[v.type][1], getVideoLang())
    .slice(0, 14)
    .map((v) => ({ key: v.key, name: v.name || '', label: VIDEO_TYPE[v.type][0] }));
  const recs = ((raw.recommendations && raw.recommendations.results) || []);
  const sims = ((raw.similar && raw.similar.results) || []);
  const recList = (recs.length ? recs : sims).filter((r) => r.poster_path).slice(0, 20).map((r) => register(toItem(r, type)));
  const runtime = isTv
    ? Number((raw.episode_run_time || [])[0]) || Number(raw.last_episode_to_air && raw.last_episode_to_air.runtime) || 0
    : Number(raw.runtime) || 0;
  const origLang = raw.original_language || '';
  const spoken = uniq([origLang, ...((raw.spoken_languages || []).map((l) => l.iso_639_1))].filter(Boolean));
  return {
    type, id: String(id), key: type + ':' + id,
    name: raw.title || raw.name || raw.original_title || raw.original_name || 'Sans titre',
    original: raw.original_title || raw.original_name || '',
    tagline: raw.tagline || (en && en.tagline) || '',
    overview: raw.overview || (en && en.overview) || '',
    year: String(raw.release_date || raw.first_air_date || '').slice(0, 4),
    backdropPath: raw.backdrop_path || '',
    posterPath: raw.poster_path || '',
    logo: pickLogo(raw.images && raw.images.logos, 'w780'),
    trailer: pickTrailer(raw.videos && raw.videos.results),
    videos,
    genres: (raw.genres || []).map((g) => g.name),
    minutes: runtime,
    certRaw: certification(raw, type),
    cert: certLabel(certification(raw, type)),
    seasons: (raw.seasons || []).filter((s) => s.season_number > 0).length
      ? (raw.seasons || []).filter((s) => s.season_number > 0) : (raw.seasons || []),
    nSeasons: raw.number_of_seasons || 0,
    nEpisodes: raw.number_of_episodes || 0,
    status: STATUS_FR[raw.status] || raw.status || '',
    next: raw.next_episode_to_air
      ? { airDate: raw.next_episode_to_air.air_date || '', code: 'S' + raw.next_episode_to_air.season_number + ' · É' + raw.next_episode_to_air.episode_number, name: raw.next_episode_to_air.name || '' }
      : null,
    lastAired: raw.last_episode_to_air ? { season_number: raw.last_episode_to_air.season_number, episode_number: raw.last_episode_to_air.episode_number } : null,
    tvdbId: (raw.external_ids && raw.external_ids.tvdb_id) || null,
    imdbId: raw.imdb_id || (raw.external_ids && raw.external_ids.imdb_id) || '',
    vote: raw.vote_average || 0,
    cast: ((raw.credits && raw.credits.cast) || []).slice(0, 15).map((p) => ({ id: p.id, name: p.name, role: p.character || '', photo: IMG('w185', p.profile_path) })),
    directors: isTv ? (raw.created_by || []).map((p) => ({ id: p.id, name: p.name })) : crew.filter((p) => p.job === 'Director').map((p) => ({ id: p.id, name: p.name })),
    writers: isTv ? [] : (() => { const seen = new Set(); return crew.filter((p) => ['Screenplay', 'Writer', 'Story'].includes(p.job)).filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, 3).map((p) => ({ id: p.id, name: p.name })); })(),
    countries: (raw.production_countries || []).map((c) => names('region', c.iso_3166_1)).concat(!(raw.production_countries || []).length ? (raw.origin_country || []).map((c) => names('region', c)) : []),
    origLang: origLang ? names('language', origLang) : '',
    spoken: spoken.map((c) => names('language', c)),
    companies: (raw.production_companies || []).map((c) => c.name).slice(0, 5),
    networks: (raw.networks || []).map((c) => c.name).slice(0, 4),
    budget: raw.budget || 0,
    revenue: raw.revenue || 0,
    releaseFR: isTv ? raw.first_air_date || '' : frReleaseDate(raw) || raw.release_date || '',
    lastAir: isTv ? raw.last_air_date || '' : '',
    collection: raw.belongs_to_collection ? { id: raw.belongs_to_collection.id, name: raw.belongs_to_collection.name } : null,
    recs: recList,
    homepage: raw.homepage || '',
  };
}

export function fetchFull(type, id) {
  const key = type + ':' + id;
  if (!fullCache.has(key)) {
    const append = (type === 'tv' ? 'videos,images,credits,external_ids,content_ratings' : 'videos,images,credits,external_ids,release_dates') + ',recommendations,similar';
    const p = (async () => {
      const raw = await tmdb(type + '/' + id, { append_to_response: append, include_image_language: 'fr,en,null', include_video_language: videoLanguages() });
      raw.videos = { results: await videosOf(raw, type, id) };
      let en = null;
      if (!raw.overview || !raw.tagline) {
        try { en = await tmdb(type + '/' + id, { language: 'en-US' }); } catch (_) { /* repli silencieux */ }
      }
      return buildModel(type, id, raw, en);
    })();
    p.catch(() => fullCache.delete(key));
    fullCache.set(key, p);
  }
  return fullCache.get(key);
}
