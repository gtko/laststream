/* « Ne plus proposer » (fiche, menu contextuel) et réglages de l'accueil par profil : titres masqués (une ligne, « Gérer »
 * ouvre #/hidden) et genres bannis. Le profil enfant n'a ni le bouton ni le panneau : son accueil est déjà filtré par l'âge et les rubriques. */
import {
  GENRE_OPTIONS, bannedGenreIds, currentFilters, hideTitle, isHiddenKey, setGenreBanned, unhideTitle,
} from '../data/homeFilters';
import { isKidProfile } from '../data/auth';
import { toast } from './dom.js';
import { state } from './state.js';
import { card, chipHTML, chipsHTML } from './settings-ui.js';

/** Retire un titre de l'accueil, avec annulation dans le message. */
function hideFromHome(key, title, poster) {
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
/** Clé d'un genre depuis l'attribut `data-ban-genre` : identifiant TMDB (nombre) ou clé d'une catégorie dérivée (« anime »). */
const genreKeyOf = (s) => (/^\d+$/.test(s) ? Number(s) : s);

/** Titres masqués : une seule ligne compacte avec « Gérer » (vue dédiée #/hidden), ou l'état vide sans bouton. */
function hiddenLineHTML(n) {
  if (!n) return '<div class="hm-line is-empty" data-home-hidden><p class="hm-line-t">Aucun titre masqué</p></div>';
  return '<div class="hm-line" data-home-hidden><p class="hm-line-t">Titres masqués — <span data-hidden-count>' + plural(n, 'titre', 'titres') + '</span></p>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-hidden-nav aria-label="Gérer les titres masqués">Gérer</button></div>';
}

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
  const hidden = card('', hiddenLineHTML(f.hidden.length));
  const genres = card('Genres à ne jamais proposer', chips, {
    desc: 'Les titres de ces genres sortent de l’accueil (films et séries).',
    aside: '<div class="hm-aside"><span class="set-badge' + (n ? ' is-on' : '') + '" data-genre-count aria-live="polite">' + genreCountText(n) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-genres-reset' + (n ? '' : ' disabled') + '>Tout réinitialiser</button></div>',
  });
  return info + hidden + genres;
}

/** Remet à jour le compteur de genres, le bouton de réinitialisation et la ligne des titres masqués. */
function refreshHome(root) {
  const scope = root || document;
  const n = genreCount();
  const badge = scope.querySelector('[data-genre-count]');
  if (badge) { badge.textContent = genreCountText(n); badge.classList.toggle('is-on', n > 0); }
  const reset = scope.querySelector('[data-genres-reset]');
  if (reset) reset.disabled = n === 0;
  const line = scope.querySelector('[data-home-hidden]');
  if (line) line.outerHTML = hiddenLineHTML(currentFilters().hidden.length);
}

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || isKidProfile()) return;
  const gc = t.closest('[data-ban-genre]');
  if (gc) {
    e.preventDefault();
    const on = gc.getAttribute('aria-checked') !== 'true';
    gc.setAttribute('aria-checked', String(on));
    setGenreBanned(gc.dataset.banGenre.split(',').map(genreKeyOf), on);
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
