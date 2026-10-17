/* Port du prototype (voir tools/port-prototype.mjs). */
import { api, tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { EMPTY_DETAIL, GENRE_FR, IMG } from './constants.js';
import { fetchProviders } from './providers.js';
import { state } from './state.js';
import { fmtMin, fmtNum } from './util.js';

export const detailPromises = new Map();
export const detailOf = (it) => state.details.get(it.key) || EMPTY_DETAIL;
export function toItem(raw, forcedType) {
  const type = (raw.media_type || forcedType || (raw.title !== undefined ? 'movie' : 'tv')) === 'tv' ? 'tv' : 'movie';
  return {
    key: type + ':' + raw.id,
    id: raw.id,
    type,
    name: raw.title || raw.name || raw.original_title || raw.original_name || 'Sans titre',
    poster: IMG('w342', raw.poster_path),
    posterPath: raw.poster_path || '',
    backdropPath: raw.backdrop_path || '',
    backdrop: IMG('w780', raw.backdrop_path),
    overview: raw.overview || '',
    year: String(raw.release_date || raw.first_air_date || '').slice(0, 4),
    date: String(raw.release_date || raw.first_air_date || ''),
    genre: (raw.genre_ids || []).map((g) => GENRE_FR[g]).filter(Boolean)[0] || '',
    vote: fmtNum(raw.vote_average, 1),
    reason: raw.reason_fr || '',
  };
}

export function register(it) {
  if (!state.byKey.has(it.key)) state.byKey.set(it.key, it);
  return state.byKey.get(it.key);
}

export function listOf(json, forcedType) {
  if (!json || !Array.isArray(json.results)) return null;
  return json.results.filter((r) => r.media_type !== 'person').map((r) => toItem(r, forcedType));
}

export function pickLogo(logos, size) {
  if (!logos || !logos.length) return '';
  const rank = (l) => (l.iso_639_1 === 'fr' ? 0 : l.iso_639_1 === 'en' ? 1 : l.iso_639_1 == null ? 2 : 3);
  const png = logos.filter((l) => !/\.svg$/i.test(l.file_path));
  const pool = (png.length ? png : logos).slice().sort((a, b) => rank(a) - rank(b) || (b.vote_average || 0) - (a.vote_average || 0));
  return IMG(size || 'w500', pool[0].file_path);
}

export function pickTrailer(videos) {
  const yt = (videos || []).filter((v) => v.site === 'YouTube' && v.key);
  const trailers = yt.filter((v) => v.type === 'Trailer');
  const pool = (trailers.length ? trailers : yt.filter((v) => v.type === 'Teaser')).slice();
  const score = (v) => (v.iso_639_1 === 'fr' ? 0 : v.iso_639_1 === 'en' ? 1 : 2) + (v.official ? -0.5 : 0);
  pool.sort((a, b) => score(a) - score(b));
  return pool[0] ? pool[0].key : '';
}

export function certification(raw, type) {
  if (type === 'movie') {
    const r = ((raw.release_dates && raw.release_dates.results) || []).find((x) => x.iso_3166_1 === getRegion().code);
    if (!r) return '';
    return (r.release_dates || []).map((d) => d.certification).find(Boolean) || '';
  }
  const r = ((raw.content_ratings && raw.content_ratings.results) || []).find((x) => x.iso_3166_1 === getRegion().code);
  return r ? r.rating || '' : '';
}
export const certLabel = (c) => (!c ? '' : /^(U|TP|0)$/i.test(c) ? 'Tous publics' : /^\d+$/.test(c) ? '-' + c : c);

// Détail léger d'un titre de l'accueil : TMDB (fr-FR, repli en-US pour le synopsis) + notes MDBList.
export async function fetchDetail(item) {
  const append = item.type === 'tv' ? 'videos,images,external_ids,content_ratings' : 'videos,images,external_ids,release_dates';
  const raw = await tmdb(item.type + '/' + item.id, { append_to_response: append, include_image_language: 'fr,en,null' });
  let overview = raw.overview || '';
  if (!overview) {
    try {
      overview = (await tmdb(item.type + '/' + item.id, { language: 'en-US' })).overview || '';
    } catch (_) { /* repli silencieux */ }
  }
  const imdbId = raw.imdb_id || (raw.external_ids && raw.external_ids.imdb_id) || '';
  let ratings = {};
  try {
    ratings = (await api('mdblist/' + item.type + '/' + (imdbId || item.id))).ratings || {};
  } catch (_) { /* notes indisponibles : on n'affiche pas de puce */ }
  let providers = [];
  try {
    providers = (await fetchProviders(item.type, item.id)).flatrate.slice(0, 3);
  } catch (_) { /* pas de pastilles */ }
  const runtime = item.type === 'movie' ? Number(raw.runtime) || 0 : Number((raw.episode_run_time || [])[0]) || 0;
  return {
    providers,
    seasons: raw.number_of_seasons || 0,
    name: raw.title || raw.name || item.name,
    overview,
    tagline: raw.tagline || '',
    logo: pickLogo(raw.images && raw.images.logos, 'w500'),
    trailer: pickTrailer(await videosOf(raw, item.type, item.id)),
    genres: (raw.genres || []).map((g) => g.name),
    minutes: runtime,
    runtime: fmtMin(runtime),
    cert: certification(raw, item.type),
    ratings,
    vote: fmtNum(raw.vote_average, 1),
  };
}

/** Bandes-annonces : la liste blanche du serveur n'accepte pas include_video_language, repli en-US si rien en français. */
export async function videosOf(raw, type, id) {
  const list = (raw.videos && raw.videos.results) || [];
  if (pickTrailer(list)) return list;
  try {
    const en = await tmdb(type + '/' + id + '/videos', { language: 'en-US' });
    return list.concat(en.results || []);
  } catch (_) {
    return list;
  }
}

export function getDetail(item) {
  if (!detailPromises.has(item.key)) {
    const p = fetchDetail(item)
      .then((d) => {
        state.details.set(item.key, d);
        return d;
      })
      .catch(() => {
        detailPromises.delete(item.key);
        return null;
      });
    detailPromises.set(item.key, p);
  }
  return detailPromises.get(item.key);
}
