/* Port du prototype (voir tools/port-prototype.mjs). */
import { infiniteList } from './infinite.js';
import { applyRestore } from './router.js';
import { paintTileRatings } from './rate.js';
import { isKidProfile } from '../data/auth';
import { userStore } from '../data/userStore';
import { register, toItem } from './catalog.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, topBar } from './fragments.js';
import { state } from './state.js';
import { fillMissingPosters } from './posters.js';
import { observeTiles, posterCard } from './tiles.js';
import { loadVisibility, sharingAvailable, shareControlsHTML, visButtonHTML } from './libshare.js';

// Bibliothèque : toutes les lectures/écritures passent par userStore (adaptateur local aujourd'hui, API lastAddon ensuite).
export const inLib = (key) => userStore.inLibrary(key);
export function toggleLib(it) {
  const known = state.byKey.get(it.type + ':' + it.id);
  return userStore.toggleLibrary({
    id: it.id, type: it.type, title: it.name, poster: it.posterPath || '', year: (known && known.year) || it.year || '',
  });
}
export function libItems() {
  return userStore.getLibrary().map((x) => {
    const raw = { id: x.id, poster_path: x.poster };
    raw[x.type === 'tv' ? 'name' : 'title'] = x.title;
    const it = register(toItem(raw, x.type));
    it.added = x.addedAt || 0;
    return it;
  });
}
export function renderLibrary() {
  const slot = document.getElementById('lib-slot');
  if (!slot) return;
  const items = libItems().sort((a, b) => b.added - a.added);
  if (!items.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = '<section class="row-section" id="bibliotheque" aria-labelledby="h-bibliotheque"><h2 class="row-title" id="h-bibliotheque">' + (isKidProfile() ? 'Mes favoris' : 'Ma bibliothèque') + ' ' +
    '<a class="row-link" href="#/library" data-libnav>Tout voir</a></h2>' + row(items.slice(0, 30).map((it) => posterCard(it)).join('')) + '</section>';
  fillMissingPosters(items.slice(0, 30));
}

export function renderLibraryPage(restore) {
  const box = detailEl.querySelector('#lib-grid');
  if (!box) return;
  const v = state.libView;
  let items = libItems();
  if (v.type !== 'all') items = items.filter((it) => it.type === v.type);
  items.sort(v.sort === 'title' ? (a, b) => a.name.localeCompare(b.name, 'fr') : (a, b) => b.added - a.added);
  detailEl.querySelectorAll('[data-libf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libf === v.type)));
  detailEl.querySelectorAll('[data-libs]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libs === v.sort)));
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<p class="row-msg">' + (userStore.getLibrary().length ? 'Aucun titre dans ce filtre.' : 'Ta bibliothèque est vide. Ajoute des films et séries depuis leur fiche (bouton marque-page) ou avec un clic droit / appui long sur une affiche.') + '</p>';
    return Promise.resolve();
  }
  const PAGE = 60;
  const list = infiniteList({
    host: box,
    key: location.hash + '|' + v.type + '|' + v.sort,
    restore: !!restore,
    load: async (page) => ({
      html: items.slice((page - 1) * PAGE, page * PAGE).map((it) => (sharingAvailable() ? '<div class="lib-cell">' + posterCard(it) + visButtonHTML(it.key) + '</div>' : posterCard(it))).join(''),
      done: page * PAGE >= items.length,
    }),
    after: (host) => {
      observeTiles(host);
      fillMissingPosters(items.slice(0, Math.max(PAGE, host.querySelectorAll('[data-tile]').length)));
      paintTileRatings(document);
    },
  });
  return list.ready;
}

export function showLibrary() {
  teardownFiche();
  state.kind = 'library';
  document.title = 'Bibliothèque · Laststream';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Bibliothèque</h1><p class="svc-eyebrow">Tes films et séries Laststream</p>' +
    '<div class="lib-controls"><div class="pills" data-nav role="group" aria-label="Filtrer">' +
    '<button type="button" class="pill" data-libf="all">Tout</button><button type="button" class="pill" data-libf="movie">Films</button><button type="button" class="pill" data-libf="tv">Séries</button></div>' +
    '<div class="pills" data-nav role="group" aria-label="Trier">' +
    '<button type="button" class="pill" data-libs="date">Derniers ajouts</button><button type="button" class="pill" data-libs="title">Titre A→Z</button></div>' +
    shareControlsHTML() + '</div></div></header>' +
    '<div class="lib-grid" id="lib-grid" data-nav></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  // La visibilité de chaque titre se lit sur le compte ; les affiches se redessinent à son arrivée.
  if (sharingAvailable()) loadVisibility().then((ok) => { if (ok && state.kind === 'library') renderLibraryPage(); });
  renderLibraryPage(state.restoreY != null).then(() => applyRestore());
}
