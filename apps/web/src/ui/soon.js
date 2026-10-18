/* Carte « Bientôt » d'un épisode à venir : fond flouté du fond de série, bloc date, compte à rebours, logo, S1 · É4.
 * Utilisée dans l'onglet Épisodes de la fiche, l'agenda du calendrier et « Cette semaine dans tes suivis ». */
import { userStore } from '../data/userStore';
import { playableSoon } from '../player/episodes';
import { dayDiff, fmtShort, todayStr } from './dates.js';
import { ICON } from './icons.js';
import { esc } from './util.js';
import './epStill.js'; // repli des vignettes cassées (voir epStill.js)

const IMG = (size, p) => (p ? 'https://image.tmdb.org/t/p/' + size + p : '');

/** Titre générique de TMDB (« Épisode 4 ») : à ne pas répéter. */
export const isPlaceholderTitle = (t) => !t || /^\s*(é|e)pisode\s*\d+\s*$/i.test(t);

export function countdownText(iso, time) {
  const n = dayDiff(iso);
  if (n < 0) return '';
  if (n === 0) return time || 'Ce soir';
  if (n === 1) return 'Demain';
  if (n < 61) return 'Dans ' + n + ' jours';
  return 'Dans ' + Math.round(n / 30) + ' mois';
}

/** Diffusion dans les 14 prochains jours : l'épisode peut déjà être en ligne (lisible). Sans date ou plus loin : false. */
export const isSoonPlayable = (iso) => playableSoon(iso, todayStr());

/** Badge d'un épisode lisible avant sa diffusion TV. */
export const playableBadge = (iso) => 'Diffusion TV le ' + fmtShort(iso) + ' · déjà en ligne ?';

/**
 * Contenu de la carte. `o` : airDate, season, episode, epTitle, still (chemin), backdrop (chemin), poster (chemin),
 * logo (URL), name (série).
 */
export function soonInnerHTML(o) {
  const d = new Date(o.airDate + 'T00:00:00');
  const day = isNaN(d) ? '' : d.getDate();
  const mon = isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '').toUpperCase();
  // Fond net : image de l'épisode, sinon fond de la série. Le flou n'est que le tout dernier repli (affiche seule).
  const sharp = o.still ? IMG('w500', o.still) : IMG('w780', o.backdrop);
  const blurred = !sharp && !!o.poster;
  const bg = sharp || (blurred ? IMG('w500', o.poster) : '');
  const inset = !blurred && o.poster ? IMG('w342', o.poster) : '';
  const real = !isPlaceholderTitle(o.epTitle);
  const avail = isSoonPlayable(o.airDate);
  const mark = o.logo && !inset
    ? '<img class="logo-img soon-logo is-big" src="' + esc(o.logo) + '" alt="' + esc(o.name || '') + '" data-logo="' + esc(o.name || '') + '" loading="lazy">'
    : '<span class="soon-series">' + esc(o.name || '') + '</span>';
  return '<span class="soon' + (o.still ? ' has-still' : '') + (blurred ? ' is-blur' : '') + (inset ? ' has-poster' : '') + '">' +
    '<span class="soon-bg">' + (bg ? '<img src="' + esc(bg) + '" alt="" loading="lazy" decoding="async" data-still>' : '') + '</span>' +
    '<span class="soon-grad" aria-hidden="true"></span>' +
    (inset ? '<img class="soon-poster" src="' + esc(inset) + '" alt="" loading="lazy" decoding="async" data-still>' : '') +
    '<span class="soon-date" aria-hidden="true"><b>' + day + '</b><i>' + esc(mon) + '</i></span>' +
    '<span class="soon-count' + (avail ? ' is-avail' : '') + '">' + esc(avail ? playableBadge(o.airDate) : countdownText(o.airDate, o.time)) + '</span>' +
    '<span class="soon-body">' + mark +
    '<span class="soon-code">S' + o.season + ' · É' + o.episode + '</span>' +
    (real ? '<span class="soon-title">' + esc(o.epTitle) + '</span>' : '') + '</span>' +
    '<span class="soon-dash" aria-hidden="true"></span></span>';
}

/** Bouton « Me prévenir » : suit la série (si elle ne l'est pas déjà). */
export function soonBell(tvKey) {
  const on = userStore.isFollowing(tvKey);
  return '<button type="button" class="soon-bell' + (on ? ' is-on' : '') + '" data-follow="' + esc(tvKey) + '" data-off-label="Me prévenir" aria-pressed="' + on + '" aria-label="' + (on ? 'Suivi (ne plus suivre)' : 'Me prévenir de la sortie') + '">' +
    (on ? ICON.bellOn : ICON.bell) + '<span>' + (on ? 'Suivi' : 'Me prévenir') + '</span></button>';
}

/**
 * Carte autonome (calendrier, rangée des suivis). Diffusion dans les 14 prochains jours : un clic lance la recherche de
 * sources de cet épisode ; sinon (au-delà, sans date) un clic ouvre la fiche de la série, comme avant.
 */
export function soonItemHTML(o, tvKey) {
  const base = (o.name || '') + ', S' + o.season + ' épisode ' + o.episode + ', ';
  if (!isSoonPlayable(o.airDate)) {
    return '<div class="soon-item"><button type="button" class="soon-card" data-open="' + esc(tvKey) + '" aria-label="' + esc(base + countdownText(o.airDate)) + '">' + soonInnerHTML(o) + '</button>' + soonBell(tvKey) + '</div>';
  }
  return '<div class="soon-item"><button type="button" class="soon-card" data-play data-play-key="' + esc(tvKey) + '" data-name="' + esc(o.name || '') +
    '" data-play-season="' + esc(o.season) + '" data-play-episode="' + esc(o.episode) + '" data-air="' + esc(o.airDate) + '" aria-label="' + esc(base + playableBadge(o.airDate)) + '">' +
    soonInnerHTML(o) + '</button>' + soonBell(tvKey) + '</div>';
}
