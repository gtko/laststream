/* « Ne plus proposer » (fiche, menu contextuel) et réglages de l'accueil par profil : titres masqués et genres bannis.
 * Le profil enfant n'a ni le bouton ni la section : son accueil est déjà filtré par l'âge et les rubriques. */
import {
  GENRE_OPTIONS, bannedGenreIds, currentFilters, hideTitle, isHiddenKey, setGenreBanned, unhideTitle,
} from '../data/homeFilters';
import { isKidProfile } from '../data/auth';
import { toast } from './dom.js';
import { IMG } from './constants.js';
import { state } from './state.js';
import { esc } from './util.js';

const EMPTY_HIDDEN = 'Aucun titre masqué. « Ne plus proposer » (fiche d’un titre, menu contextuel) le retire de l’accueil.';

/** Retire un titre de l'accueil, avec annulation dans le message. */
export function hideFromHome(key, title, poster) {
  if (isKidProfile()) return;
  if (!hideTitle({ key, title: title || key, poster: poster || '' })) {
    toast('Liste pleine : réaffiche des titres dans les réglages');
    return;
  }
  toast('Masqué de l’accueil', { ms: 5000, action: { label: 'Annuler', run: () => { unhideTitle(key); toast('Réaffiché sur l’accueil'); } } });
}

/** Bascule « Ne plus proposer » / « Réafficher » (menu contextuel). */
export function toggleHidden(key, title, poster) {
  if (isKidProfile()) return;
  if (isHiddenKey(key)) {
    unhideTitle(key);
    toast('Réaffiché sur l’accueil');
  } else {
    hideFromHome(key, title, poster);
  }
}

/** Contenu de la liste des titres masqués : grille d'affiches, ou message quand elle est vide. */
function hiddenListHTML(list) {
  if (!list.length) return '<p class="set-hint home-empty">' + esc(EMPTY_HIDDEN) + '</p>';
  return '<ul class="home-hidden-grid" aria-label="Titres masqués">' + list.map((h) =>
    '<li class="home-hidden-item">' + (h.poster
      ? '<img src="' + esc(IMG('w185', h.poster)) + '" alt="" width="120" height="180" loading="lazy">'
      : '<span class="home-hidden-noimg" aria-hidden="true"></span>') +
    '<span class="home-hidden-title">' + esc(h.title) + '</span>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-unhide="' + esc(h.key) + '">Réafficher</button></li>').join('') + '</ul>';
}

/** Réglages du profil : titres masqués (affiche, bouton « Réafficher ») et genres à ne jamais proposer. Vide pour un profil enfant. */
export function homeSettingsHTML() {
  if (isKidProfile()) return '';
  const f = currentFilters();
  const banned = bannedGenreIds();
  const genres = '<div class="home-genres" role="group" aria-label="Genres à ne jamais proposer">' + GENRE_OPTIONS.map((g) => {
    const on = g.ids.some((id) => banned.has(id));
    return '<label class="pill home-genre"><input type="checkbox" class="home-genre-input" data-ban-genre="' + g.ids.join(',') + '"' + (on ? ' checked' : '') + '>' +
      '<span>' + esc(g.label) + '</span></label>';
  }).join('') + '</div>';
  return '<section class="set-sec glass" aria-labelledby="set-hm-h"><h2 class="f-sub" id="set-hm-h">Accueil de ce profil</h2>' +
    '<p class="set-hint">Les films vus ou regardés à 90 % et les séries vues en entier ne sont plus proposés sur l’accueil. ' +
    'Ils restent dans la bibliothèque, la recherche et la fiche.</p>' +
    '<h3 class="f-sub">Titres masqués</h3>' +
    '<div class="home-hidden" data-home-hidden>' + hiddenListHTML(f.hidden) + '</div>' +
    '<h3 class="f-sub">Genres à ne jamais proposer</h3>' +
    '<p class="set-hint">Les titres de ces genres sortent de l’accueil (films et séries).</p>' + genres + '</section>';
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || isKidProfile()) return;
  const un = t.closest('[data-unhide]');
  if (un) {
    e.preventDefault();
    unhideTitle(un.dataset.unhide);
    const box = un.closest('[data-home-hidden]');
    if (box) box.innerHTML = hiddenListHTML(currentFilters().hidden);
    toast('Réaffiché : visible sur l’accueil au prochain chargement');
    return;
  }
  const hd = t.closest('[data-hide-title]');
  if (hd) {
    e.preventDefault();
    const m = state.model;
    if (!m) return;
    toggleHidden(m.key, m.name, m.posterPath);
    hd.setAttribute('aria-pressed', String(isHiddenKey(m.key)));
    hd.classList.toggle('is-on', isHiddenKey(m.key));
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.dataset.banGenre || isKidProfile()) return;
  setGenreBanned(t.dataset.banGenre.split(',').map(Number), t.checked);
});
