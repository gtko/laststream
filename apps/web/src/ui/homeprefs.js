/* « Ne plus proposer » (fiche, menu contextuel) et réglages de l'accueil par profil : titres masqués et genres bannis.
 * Le profil enfant n'a ni le bouton ni le panneau : son accueil est déjà filtré par l'âge et les rubriques. */
import {
  GENRE_OPTIONS, bannedGenreIds, currentFilters, hideTitle, isHiddenKey, setGenreBanned, unhideTitle,
} from '../data/homeFilters';
import { isKidProfile } from '../data/auth';
import { toast } from './dom.js';
import { IMG } from './constants.js';
import { state } from './state.js';
import { esc } from './util.js';
import { SET_ICON, card, chipHTML, chipsHTML } from './settings-ui.js';

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

const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
const KIND_FR = { movie: 'Film', tv: 'Série' };

function maskedOn(ts) {
  try { return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return ''; }
}

/** Liste compacte des titres masqués (petite affiche, titre, type et date, bouton icône « Réafficher »), ou état vide. */
function hiddenListHTML(list) {
  if (!list.length) {
    return '<div class="hm-empty"><span class="hm-empty-ic">' + SET_ICON.eye + '</span><p><strong>Aucun titre masqué</strong>' +
      '<span>« Ne plus proposer » (fiche d’un titre, menu contextuel) le retire de l’accueil ; il apparaît alors ici.</span></p></div>';
  }
  return '<ul class="hm-list" aria-label="Titres masqués">' + list.map((h) => {
    const kind = KIND_FR[String(h.key).split(':')[0]] || '';
    const sub = [kind, h.addedAt ? 'masqué le ' + maskedOn(h.addedAt) : ''].filter(Boolean).join(' · ');
    return '<li class="hm-item">' + (h.poster
      ? '<img class="hm-poster" src="' + esc(IMG('w92', h.poster)) + '" alt="" width="40" height="60" loading="lazy">'
      : '<span class="hm-poster hm-noimg" aria-hidden="true"></span>') +
      '<span class="hm-t"><strong>' + esc(h.title) + '</strong>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
      '<button type="button" class="set-icon-btn" data-unhide="' + esc(h.key) + '" aria-label="Réafficher « ' + esc(h.title) + ' »" title="Réafficher">' + SET_ICON.eyeOff + '</button></li>';
  }).join('') + '</ul>';
}

const hiddenCountText = (n) => (n ? plural(n, 'titre masqué', 'titres masqués') : 'Aucun titre masqué');
const genreCount = () => { const b = bannedGenreIds(); return GENRE_OPTIONS.filter((g) => g.ids.some((id) => b.has(id))).length; };
const genreCountText = (n) => (n ? plural(n, 'genre exclu', 'genres exclus') : 'Aucun genre exclu');

/** Contenu du panneau « Accueil et recommandations » (sans l'en-tête de panneau). Vide pour un profil enfant. */
export function homePanelHTML() {
  if (isKidProfile()) return '';
  const f = currentFilters();
  const banned = bannedGenreIds();
  const n = genreCount();
  const chips = chipsHTML('Genres à ne jamais proposer', GENRE_OPTIONS.map((g) =>
    chipHTML(g.label, g.ids.some((id) => banned.has(id)), 'data-ban-genre="' + g.ids.join(',') + '"')).join(''));
  const info = card('', '<p class="hm-info">Les films vus ou regardés à 90 % et les séries vues en entier ne sont plus proposés sur l’accueil. ' +
    'Ils restent dans la bibliothèque, la recherche et la fiche.</p>');
  const hidden = card('Titres masqués', '<div class="hm-hidden" data-home-hidden>' + hiddenListHTML(f.hidden) + '</div>', {
    desc: 'Ces titres ne sont plus proposés sur l’accueil.',
    aside: '<span class="set-badge" data-hidden-count>' + hiddenCountText(f.hidden.length) + '</span>',
  });
  const genres = card('Genres à ne jamais proposer', chips, {
    desc: 'Les titres de ces genres sortent de l’accueil (films et séries).',
    aside: '<div class="hm-aside"><span class="set-badge' + (n ? ' is-on' : '') + '" data-genre-count aria-live="polite">' + genreCountText(n) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-genres-reset' + (n ? '' : ' disabled') + '>Tout réinitialiser</button></div>',
  });
  return info + hidden + genres;
}

/** Remet à jour le compteur de genres, le bouton de réinitialisation et le compteur de titres masqués. */
function refreshHome(root) {
  const scope = root || document;
  const n = genreCount();
  const badge = scope.querySelector('[data-genre-count]');
  if (badge) { badge.textContent = genreCountText(n); badge.classList.toggle('is-on', n > 0); }
  const reset = scope.querySelector('[data-genres-reset]');
  if (reset) reset.disabled = n === 0;
  const hid = scope.querySelector('[data-hidden-count]');
  if (hid) hid.textContent = hiddenCountText(currentFilters().hidden.length);
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
    refreshHome(box ? box.closest('.set-panel') : null);
    toast('Réaffiché : visible sur l’accueil au prochain chargement');
    return;
  }
  const gc = t.closest('[data-ban-genre]');
  if (gc) {
    e.preventDefault();
    const on = gc.getAttribute('aria-checked') !== 'true';
    gc.setAttribute('aria-checked', String(on));
    setGenreBanned(gc.dataset.banGenre.split(',').map(Number), on);
    refreshHome(gc.closest('.set-panel'));
    return;
  }
  if (t.closest('[data-genres-reset]')) {
    e.preventDefault();
    const panel = t.closest('.set-panel');
    setGenreBanned([...bannedGenreIds()], false);
    if (panel) panel.querySelectorAll('[data-ban-genre]').forEach((c) => c.setAttribute('aria-checked', 'false'));
    refreshHome(panel);
    toast('Genres réinitialisés');
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
