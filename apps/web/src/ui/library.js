/* Port du prototype (voir tools/port-prototype.mjs). */
import { infiniteList } from './infinite.js';
import { applyRestore } from './router.js';
import { paintTileRatings } from './rate.js';
import { isKidProfile } from '../data/auth';
import { userStore } from '../data/userStore';
import { onDataEvent } from '../data/events';
import { tmdb } from '../data/lt';
import { compareWatched, isWatchedComplete, watchedProgressLabel } from '../data/watchedHistory';
import { register, toItem } from './catalog.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, topBar } from './fragments.js';
import { keepRowState } from './rows.js';
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
/** Dernier HTML de la rangée par emplacement : un rafraîchissement sans changement ne redessine rien. */
const libHtml = new WeakMap();

export function renderLibrary() {
  const slot = document.getElementById('lib-slot');
  if (!slot) return;
  const items = libItems().sort((a, b) => b.added - a.added);
  if (!items.length) { slot.innerHTML = ''; libHtml.delete(slot); return; }
  const html = '<section class="row-section" id="bibliotheque" aria-labelledby="h-bibliotheque"><h2 class="row-title" id="h-bibliotheque">' + (isKidProfile() ? 'Mes favoris' : 'Ma bibliothèque') + ' ' +
    '<a class="row-link" href="#/library" data-libnav>Tout voir</a></h2>' + row(items.slice(0, 30).map((it) => posterCard(it)).join('')) + '</section>';
  if (libHtml.get(slot) === html) return;
  libHtml.set(slot, html);
  keepRowState(slot, () => { slot.innerHTML = html; }, 'data-tile');
  fillMissingPosters(items.slice(0, 30));
}

/** Onglets de la page : « Ma bibliothèque » (la liste choisie) ou « Vus » (tout l'historique du profil). */
export function setLibMode(mode) {
  state.libMode = mode === 'watched' ? 'watched' : 'library';
  state.libView.sort = state.libMode === 'watched' ? 'recent' : 'date';
  state.restoreY = null;
  showLibrary();
}

function syncPills() {
  const seen = state.libMode === 'watched';
  detailEl.querySelectorAll('[data-libm]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libm === (seen ? 'watched' : 'library'))));
  detailEl.querySelectorAll('[data-libf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libf === state.libView.type)));
  detailEl.querySelectorAll('[data-libs]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.libs === state.libView.sort)));
}

function controlsHTML() {
  const seen = state.libMode === 'watched';
  const modes = '<div class="pills" data-nav role="group" aria-label="Affichage">' +
    '<button type="button" class="pill" data-libm="library">Ma bibliothèque</button><button type="button" class="pill" data-libm="watched">Vus</button></div>';
  const types = '<div class="pills" data-nav role="group" aria-label="Filtrer">' +
    '<button type="button" class="pill" data-libf="all">Tout</button><button type="button" class="pill" data-libf="movie">Films</button><button type="button" class="pill" data-libf="tv">Séries</button></div>';
  const sorts = seen
    ? '<div class="pills" data-nav role="group" aria-label="Trier">' +
      '<button type="button" class="pill" data-libs="recent">Récemment vus</button><button type="button" class="pill" data-libs="title">Titre A→Z</button><button type="button" class="pill" data-libs="year">Année</button></div>'
    : '<div class="pills" data-nav role="group" aria-label="Trier">' +
      '<button type="button" class="pill" data-libs="date">Derniers ajouts</button><button type="button" class="pill" data-libs="title">Titre A→Z</button></div>';
  return modes + types + sorts + (seen ? '' : shareControlsHTML());
}

export function renderLibraryPage(restore) {
  if (state.libMode === 'watched') return renderSeenPage(restore);
  const box = detailEl.querySelector('#lib-grid');
  if (!box) return;
  const v = state.libView;
  let items = libItems();
  if (v.type !== 'all') items = items.filter((it) => it.type === v.type);
  items.sort(v.sort === 'title' ? (a, b) => a.name.localeCompare(b.name, 'fr') : (a, b) => b.added - a.added);
  syncPills();
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

// ---- « Vus » : films et séries vus par le profil, même hors « Ma bibliothèque » ----
// Les titres vus n'ont que leur identifiant côté historique : titre, affiche et année (et le total d'épisodes) viennent de TMDB,
// une seule fois par titre.
const SEEN_PAGE = 60;
const detailCache = new Map();

function detailOf(t) {
  if (!detailCache.has(t.key)) {
    detailCache.set(t.key, tmdb(t.type + '/' + t.id).catch(() => { detailCache.delete(t.key); return null; }));
  }
  return detailCache.get(t.key);
}

/** Vues des titres de l'historique : titre, année et affiche (repli si TMDB ne répond pas), total d'épisodes des séries. */
async function seenViews(entries) {
  const details = await Promise.all(entries.map(detailOf));
  return entries.map((t, i) => {
    const raw = details[i];
    const it = register(toItem(raw ? { ...raw, id: t.id } : { id: t.id, title: 'Titre indisponible' }, t.type));
    return { t, it, total: t.type === 'tv' && raw ? Number(raw.number_of_episodes) || 0 : 0 };
  });
}

function seenCell({ t, it, total }) {
  const opts = { watched: t.type === 'movie' || isWatchedComplete(t, total) };
  if (t.type === 'tv') {
    opts.sub = watchedProgressLabel(t.watched, total);
    if (total) opts.pct = Math.min(100, Math.round((t.watched / total) * 100));
  }
  return posterCard(it, opts);
}

function seenCountLabel(n, type) {
  if (type === 'movie') return n === 0 ? 'Aucun film vu' : n === 1 ? '1 film vu' : n + ' films vus';
  if (type === 'tv') return n === 0 ? 'Aucune série vue' : n === 1 ? '1 série vue' : n + ' séries vues';
  return n === 0 ? 'Aucun titre vu' : n === 1 ? '1 titre vu' : n + ' titres vus';
}

let seenRun = 0;

/** Rend l'onglet « Vus » : filtre, tri, compteur et défilement comme « Ma bibliothèque ». Sans effet si rien n'a changé. */
export async function renderSeenPage(restore) {
  const box = detailEl.querySelector('#lib-grid');
  if (!box) return;
  const v = state.libView;
  const all = userStore.watchedTitles();
  const entries = v.type === 'all' ? all : all.filter((t) => t.type === (v.type === 'tv' ? 'tv' : 'movie'));
  syncPills();
  const eyebrow = detailEl.querySelector('.svc-eyebrow');
  if (eyebrow) eyebrow.textContent = seenCountLabel(entries.length, v.type);
  const sig = v.type + '|' + v.sort + '|' + entries.map((t) => t.key + ':' + t.watched + ':' + t.lastWatchedAt).join(',');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const run = ++seenRun;
  if (!entries.length) {
    box.innerHTML = '<p class="row-msg">' + (all.length ? 'Aucun titre vu dans ce filtre.' : 'Rien de vu pour l’instant. Les films et séries que tu marques comme vus, ou que tu termines, apparaissent ici, même hors de « Ma bibliothèque ».') + '</p>';
    return;
  }
  if (!box.querySelector('[data-tile]')) box.innerHTML = '<p class="row-msg">Chargement des titres…</p>';
  const views = await seenViews(entries);
  if (run !== seenRun || box.dataset.sig !== sig) return; // une demande plus récente a pris la main
  const cmp = compareWatched(v.sort);
  const sorted = views
    .map((x) => ({ x, s: { lastWatchedAt: x.t.lastWatchedAt, name: x.it.name, year: x.it.year || '' } }))
    .sort((a, b) => cmp(a.s, b.s))
    .map((o) => o.x);
  const PAGE = SEEN_PAGE;
  box.innerHTML = '';
  const list = infiniteList({
    host: box,
    key: location.hash + '|seen|' + v.type + '|' + v.sort,
    restore: !!restore,
    load: async (page) => ({
      html: sorted.slice((page - 1) * PAGE, page * PAGE).map(seenCell).join(''),
      done: page * PAGE >= sorted.length,
    }),
    after: (host) => {
      observeTiles(host);
      fillMissingPosters(sorted.slice(0, Math.max(PAGE, host.querySelectorAll('[data-tile]').length)).map((x) => x.it));
      paintTileRatings(document);
    },
  });
  return list.ready;
}

export function showLibrary() {
  teardownFiche();
  state.kind = 'library';
  document.title = 'Bibliothèque · Laststream';
  const seen = state.libMode === 'watched';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Bibliothèque</h1><p class="svc-eyebrow">' + (seen ? '' : 'Tes films et séries Laststream') + '</p>' +
    '<div class="lib-controls">' + controlsHTML() + '</div></div></header>' +
    '<div class="lib-grid" id="lib-grid" data-nav></div></article>';
  syncPills();
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  // La visibilité de chaque titre se lit sur le compte ; les affiches se redessinent à son arrivée.
  if (sharingAvailable() && !seen) loadVisibility().then((ok) => { if (ok && state.kind === 'library' && state.libMode !== 'watched') renderLibraryPage(); });
  renderLibraryPage(state.restoreY != null).then(() => applyRestore());
}

// L'onglet « Vus » suit les changements (marquer vu ou non vu, fin de lecture, relecture du compte) sans recharger la page.
onDataEvent((e) => {
  if (e.kind !== 'watched' && e.kind !== 'remote' && e.kind !== 'progress') return;
  if (state.kind !== 'library' || state.libMode !== 'watched' || !detailEl.querySelector('#lib-grid')) return;
  void renderSeenPage();
});
