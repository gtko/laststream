/* « Ne plus proposer » (fiche, menu contextuel) et réglages de l'accueil par profil : titres masqués et genres bannis. */
import {
  GENRE_OPTIONS, bannedGenreIds, currentFilters, hideTitle, isHiddenKey, setGenreBanned, unhideTitle,
} from '../data/homeFilters';
import { toast } from './dom.js';
import { IMG } from './constants.js';
import { state } from './state.js';
import { esc } from './util.js';

/** Retire un titre de l'accueil, avec annulation dans le message. */
export function hideFromHome(key, title, poster) {
  if (!hideTitle({ key, title: title || key, poster: poster || '' })) {
    toast('Liste pleine : réaffiche des titres dans les réglages');
    return;
  }
  toast('Masqué de l’accueil', { ms: 5000, action: { label: 'Annuler', run: () => { unhideTitle(key); toast('Réaffiché sur l’accueil'); } } });
}

/** Bascule « Ne plus proposer » / « Réafficher ». */
export function toggleHidden(key, title, poster) {
  if (isHiddenKey(key)) {
    unhideTitle(key);
    toast('Réaffiché sur l’accueil');
  } else {
    hideFromHome(key, title, poster);
  }
}

/** Réglages du profil : titres masqués (affiche, bouton « Réafficher ») et genres à ne jamais proposer. */
export function homeSettingsHTML() {
  const f = currentFilters();
  const banned = bannedGenreIds();
  const hidden = f.hidden.length
    ? '<ul class="home-hidden" aria-label="Titres masqués">' + f.hidden.map((h) =>
      '<li class="home-hidden-item">' + (h.poster
        ? '<img src="' + esc(IMG('w92', h.poster)) + '" alt="" width="46" height="69" loading="lazy">'
        : '<span class="home-hidden-noimg" aria-hidden="true"></span>') +
      '<span class="home-hidden-title">' + esc(h.title) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-unhide="' + esc(h.key) + '">Réafficher</button></li>').join('') + '</ul>'
    : '<p class="set-hint">Aucun titre masqué. « Ne plus proposer » (fiche d’un titre, menu contextuel) le retire de l’accueil.</p>';
  const genres = '<div class="pills home-genres" role="group" aria-label="Genres à ne jamais proposer">' + GENRE_OPTIONS.map((g) => {
    const on = g.ids.some((id) => banned.has(id));
    return '<label class="pill home-genre"><input type="checkbox" data-ban-genre="' + g.ids.join(',') + '"' + (on ? ' checked' : '') + '> <span>' + esc(g.label) + '</span></label>';
  }).join('') + '</div>';
  return '<section class="set-sec glass" aria-labelledby="set-hm-h"><h2 class="f-sub" id="set-hm-h">Accueil de ce profil</h2>' +
    '<p class="set-hint">Les films vus ou regardés à 90 % et les séries vues en entier ne sont plus proposés sur l’accueil. ' +
    'Ils restent dans la bibliothèque, la recherche et la fiche.</p>' +
    '<h3 class="f-sub">Titres masqués</h3>' + hidden +
    '<h3 class="f-sub">Genres à ne jamais proposer</h3>' +
    '<p class="set-hint">Les titres de ces genres sortent de l’accueil (films et séries).</p>' + genres + '</section>';
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const un = t.closest('[data-unhide]');
  if (un) {
    e.preventDefault();
    unhideTitle(un.dataset.unhide);
    const li = un.closest('li');
    if (li) li.remove();
    toast('Réaffiché : visible sur l’accueil au prochain chargement');
    return;
  }
  const hd = t.closest('[data-hide-title]');
  if (hd) {
    e.preventDefault();
    const m = state.model;
    if (!m) return;
    toggleHidden(m.key, m.name, m.posterPath);
    const on = isHiddenKey(m.key);
    hd.setAttribute('aria-pressed', String(on));
    hd.textContent = on ? 'Réafficher sur l’accueil' : 'Ne plus proposer sur l’accueil';
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.dataset.banGenre) return;
  setGenreBanned(t.dataset.banGenre.split(',').map(Number), t.checked);
});
