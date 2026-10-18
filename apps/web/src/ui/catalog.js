/* Port du prototype (voir tools/port-prototype.mjs). */
import { hasProviders, movieAvailability, releasedByDate } from '../data/released';
import { dayDiff, todayStr } from './dates.js';
import { completeVideos, includeVideoLanguages, pickTrailerKey, trailerLang } from '../data/trailers';
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
    genreIds: raw.genre_ids || [],
    votes: typeof raw.vote_count === 'number' ? raw.vote_count : undefined,
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
  return pickTrailerKey(videos, trailerLang());
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
/** « Nouvel épisode le 24 oct. » ou « S3 disponible » pour la mise en avant d'une série. */
/** Disponibilité d'un film d'après un détail TMDB contenant release_dates et watch/providers. */
export function availOf(raw) {
  return movieAvailability(raw.release_dates && raw.release_dates.results, getRegion().code, raw.release_date, todayStr(),
    hasProviders(raw['watch/providers'], getRegion().code));
}

export function seriesNote(raw) {
  const next = raw.next_episode_to_air;
  const short = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  if (next && next.air_date) {
    const d = dayDiff(next.air_date);
    if (d >= 0 && d <= 45) return 'Nouvel épisode le ' + short(next.air_date);
  }
  const aired = (raw.seasons || []).filter((s) => s.season_number > 1 && s.air_date && dayDiff(s.air_date) <= 0).sort((a, b) => b.season_number - a.season_number)[0];
  return aired && dayDiff(aired.air_date) >= -120 ? 'S' + aired.season_number + ' disponible' : '';
}

// Notes MDBList : à part du détail TMDB, car chaque appel compte dans le quota quotidien partagé.
const ratingsPending = new Map(); // clé -> requête MDBList en cours (partagée entre appelants)
const ratingsDone = new Map(); // clé -> { notes, until } : notes gardées jusqu'à `until` (ms ; Infinity : toute la session)

/** Délai avant un nouvel essai après « unavailable » : `retryAfter` en secondes (une heure à défaut). */
function retryMs(retryAfter) {
  const s = Number(retryAfter);
  return (Number.isFinite(s) && s > 0 ? s : 3600) * 1000;
}

/** Notes MDBList d'un titre : une seule requête à la fois, et aucun nouvel essai avant `retryAfter` si le quota est épuisé. */
export function ratingsOf(item, imdbId) {
  const hit = ratingsDone.get(item.key);
  if (hit && Date.now() < hit.until) return Promise.resolve(hit.notes);
  if (!ratingsPending.has(item.key)) {
    const p = api('mdblist/' + item.type + '/' + (imdbId || item.id)).then(
      (json) => {
        // Quota épuisé : 200 avec `unavailable` (TMDB seul, sans erreur).
        if (json && json.unavailable) ratingsDone.set(item.key, { notes: {}, until: Date.now() + retryMs(json.retryAfter) });
        else ratingsDone.set(item.key, { notes: (json && json.ratings) || {}, until: Infinity });
      },
      () => {
        // Échec réseau ou amont : pas de puce, pas de nouvel essai pendant la session (comme avant).
        ratingsDone.set(item.key, { notes: {}, until: Infinity });
      },
    ).then(() => {
      ratingsPending.delete(item.key);
      return ratingsDone.get(item.key).notes;
    });
    ratingsPending.set(item.key, p);
  }
  return ratingsPending.get(item.key);
}

/** Ajoute les notes à un détail déjà chargé (le détail TMDB n'est pas redemandé). */
const withRatings = (item, d) => ratingsOf(item, d.imdbId).then((notes) => {
  d.ratings = notes;
  return d;
});

/** `ratings` : appelle aussi MDBList ; sinon `ratings` reste vide. */
export async function fetchDetail(item, { ratings = false } = {}) {
  const append = item.type === 'tv' ? 'videos,images,external_ids,content_ratings' : 'videos,images,external_ids,release_dates,watch/providers';
  const raw = await tmdb(item.type + '/' + item.id, { append_to_response: append, include_image_language: 'fr,en,null', include_video_language: videoLanguages() });
  let overview = raw.overview || '';
  if (!overview) {
    try {
      overview = (await tmdb(item.type + '/' + item.id, { language: 'en-US' })).overview || '';
    } catch (_) { /* repli silencieux */ }
  }
  const imdbId = raw.imdb_id || (raw.external_ids && raw.external_ids.imdb_id) || '';
  const notes = ratings ? await ratingsOf(item, imdbId) : {};
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
    note: item.type === 'tv' ? seriesNote(raw) : '',
    released: item.type === 'tv' ? releasedByDate(raw.first_air_date, todayStr()) : availOf(raw).available,
    cinemaSince: item.type === 'movie' ? availOf(raw).cinemaSince : null,
    ratings: notes,
    imdbId,
    vote: fmtNum(raw.vote_average, 1),
  };
}

/** Langues demandées pour les vidéos : la langue choisie, l'anglais, puis les vidéos sans langue. */
export const videoLanguages = () => includeVideoLanguages(trailerLang());

/**
 * Vidéos du titre, complétées si la langue choisie n'a pas de bande-annonce doublée (saison 1 pour une série,
 * variantes régionales pour un film, anglais en dernier recours).
 */
export async function videosOf(raw, type, id) {
  const list = (raw.videos && raw.videos.results) || [];
  return completeVideos(list, type, id, trailerLang(), (path, params) => tmdb(path, params));
}

/**
 * Détail d'un titre, mis en cache. `ratings: true` ajoute les notes MDBList (à demander seulement là où elles sont
 * affichées). Un détail déjà en cache n'est pas redemandé à TMDB : seules les notes manquantes sont chargées.
 */
export function getDetail(item, { ratings = false } = {}) {
  if (!detailPromises.has(item.key)) {
    const p = fetchDetail(item, { ratings })
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
  const base = detailPromises.get(item.key);
  return ratings ? base.then((d) => (d ? withRatings(item, d) : null)) : base;
}
