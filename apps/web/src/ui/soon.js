/* Carte « Bientôt » d'un épisode à venir : fond flouté du fond de série, bloc date, compte à rebours, logo, S1 · É4.
 * Utilisée dans l'onglet Épisodes de la fiche, l'agenda du calendrier et « Cette semaine dans tes suivis ». */
import { userStore } from '../data/userStore';
import { dayDiff } from './dates.js';
import { ICON } from './icons.js';
import { esc } from './util.js';

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

/**
 * Contenu de la carte. `o` : airDate, season, episode, epTitle, still (chemin), backdrop (chemin), poster (chemin),
 * logo (URL), name (série).
 */
export function soonInnerHTML(o) {
  const d = new Date(o.airDate + 'T00:00:00');
  const day = isNaN(d) ? '' : d.getDate();
  const mon = isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '').toUpperCase();
  const base = o.still ? IMG('w500', o.still) : IMG('w780', o.backdrop) || IMG('w500', o.poster);
  const real = !isPlaceholderTitle(o.epTitle);
  return '<span class="soon' + (o.still ? ' has-still' : '') + '">' +
    '<span class="soon-bg">' + (base ? '<img src="' + esc(base) + '" alt="" loading="lazy" decoding="async">' : '') + '</span>' +
    '<span class="soon-grad" aria-hidden="true"></span>' +
    '<span class="soon-date" aria-hidden="true"><b>' + day + '</b><i>' + esc(mon) + '</i></span>' +
    '<span class="soon-count">' + esc(countdownText(o.airDate, o.time)) + '</span>' +
    '<span class="soon-body">' +
    (o.logo ? '<img class="logo-img soon-logo" src="' + esc(o.logo) + '" alt="' + esc(o.name || '') + '" data-logo="' + esc(o.name || '') + '" loading="lazy">'
      : '<span class="soon-series">' + esc(o.name || '') + '</span>') +
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

/** Carte autonome (calendrier, rangée des suivis) : un clic ouvre la fiche de la série. */
export function soonItemHTML(o, tvKey) {
  const label = (o.name || '') + ', S' + o.season + ' épisode ' + o.episode + ', ' + countdownText(o.airDate);
  return '<div class="soon-item"><button type="button" class="soon-card" data-open="' + esc(tvKey) + '" aria-label="' + esc(label) + '">' + soonInnerHTML(o) + '</button>' + soonBell(tvKey) + '</div>';
}
