/* Page « Titres masqués » (#/hidden) : la vue dédiée aux titres « Ne plus proposer » (réglages : « Gérer »).
 * Filtre, tri et compteurs en mémoire sur toute la liste ; la grille est rendue par pages (infiniteList, 60 tuiles).
 * Sélection par clic, puis « Réafficher » traite tout le lot en un seul enregistrement. Profil enfant : page absente. */
import '../styles/hidden.css';
import { infiniteList, stopInfinite } from './infinite.js';
import { hiddenTitles, onHomeChange, restoreHidden, unhideTitles } from '../data/homeFilters';
import { hiddenCounts, hiddenView } from '../data/hiddenView';
import { isKidProfile } from '../data/auth';
import { ICON } from './icons.js';
import { IMG } from './constants.js';
import { register, toItem } from './catalog.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { SET_ICON } from './settings-ui.js';
import { state } from './state.js';
import { esc } from './util.js';
import { t as tr, tn } from '../i18n';

const PAGE = 60;
/** Vue mémorisée pendant la session (filtre, tri, recherche) ; la sélection, elle, repart de zéro à chaque ouverture. */
const view = { type: 'all', sort: 'recent', query: '' };
const selected = new Set();
/** Liste filtrée et triée affichée, pour « Tout sélectionner (filtre courant) ». */
let current = [];

const kindOf = (key) => (key.startsWith('tv:') ? tr('Série') : tr('Film'));
const yearOf = (key) => {
  const it = state.byKey.get(key);
  return it && it.year ? it.year : '';
};

/** Tuile compacte : affiche 2:3, case de sélection en coin, titre sur une ligne, bouton « Réafficher » au survol. */
function tileHTML(h) {
  const k = esc(h.key);
  const t = esc(h.title);
  const on = selected.has(h.key);
  const kind = kindOf(h.key);
  return '<div class="hid-tile' + (on ? ' is-sel' : '') + '">' +
    '<button type="button" class="hid-card" data-tile="' + k + '" data-hid-sel="' + k + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + t + ', ' + kind + '">' +
    '<span class="hid-media' + (h.poster ? '' : ' no-img') + '" aria-hidden="true">' +
    (h.poster ? '<img src="' + esc(IMG('w342', h.poster)) + '" alt="" loading="lazy" decoding="async">' : '') +
    '<span class="hid-kind">' + kind + '</span><span class="hid-check">' + ICON.check + '</span></span>' +
    '<span class="hid-t" aria-hidden="true">' + t + '</span></button>' +
    '<button type="button" class="hid-x" data-hid-unhide="' + k + '" aria-label="' + tr('Réafficher « {t} »', { t }) + '" title="' + tr('Réafficher') + '">' + SET_ICON.eye + '</button>' +
    '</div>';
}

/** Met la sélection d'une tuile à jour sans la redessiner. */
function paintSel(card, on) {
  card.setAttribute('aria-pressed', on ? 'true' : 'false');
  const tile = card.closest('.hid-tile');
  if (tile) tile.classList.toggle('is-sel', on);
}

function updateBar() {
  const bar = detailEl.querySelector('#hid-bar');
  if (!bar) return;
  bar.hidden = selected.size === 0;
  const bulk = bar.querySelector('[data-hid-bulk]');
  if (bulk) bulk.textContent = tr('Réafficher ({size})', { size: selected.size });
}

/** Compteurs des puces, résumé, bouton d'effacement de la recherche et état des puces de tri et de type. */
function paintControls(all) {
  const counts = hiddenCounts(all, view.query);
  detailEl.querySelectorAll('[data-hid-count]').forEach((n) => { n.textContent = String(counts[n.dataset.hidCount]); });
  detailEl.querySelectorAll('[data-hid-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hidType === view.type)));
  detailEl.querySelectorAll('[data-hid-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hidSort === view.sort)));
  const summary = detailEl.querySelector('#hid-summary');
  if (summary) {
    summary.textContent = current.length === all.length
      ? tn(all.length, '{n} titre masqué', '{n} titres masqués')
      : current.length + ' sur ' + tn(all.length, '{n} titre masqué', '{n} titres masqués');
  }
  const clear = detailEl.querySelector('[data-hid-qclear]');
  if (clear) clear.hidden = !view.query;
}

/** Affiche la liste filtrée : la grille repart de la première page ; les pages suivantes suivent le défilement. */
function renderGrid() {
  const grid = detailEl.querySelector('#hid-grid');
  if (!grid) return;
  const all = hiddenTitles();
  current = hiddenView(all, { query: view.query, type: view.type, sort: view.sort, yearOf });
  paintControls(all);
  stopInfinite();
  grid.innerHTML = '';
  if (!all.length) {
    grid.innerHTML = '<div class="hid-empty">' + tr('<strong>Aucun titre masqué</strong>') +
      '<span>' + tr('« Ne plus proposer » (fiche d’un titre, menu contextuel) le retire de l’accueil ; il apparaît alors ici.') + '</span></div>';
    return;
  }
  if (!current.length) {
    grid.innerHTML = '<p class="row-msg">' + tr('Aucun titre masqué ne correspond à ces filtres.') + '</p>';
    return;
  }
  const list = current;
  infiniteList({
    host: grid,
    load: async (page) => {
      const slice = list.slice((page - 1) * PAGE, page * PAGE);
      // Les tuiles deviennent des titres connus : le menu contextuel (clic droit, appui long) les trouve.
      slice.forEach((h) => register(toItem({ id: Number(h.key.split(':')[1]), title: h.title, poster_path: h.poster }, h.key.startsWith('tv:') ? 'tv' : 'movie')));
      return { html: slice.map(tileHTML).join(''), done: page * PAGE >= list.length };
    },
  });
}

/** Réaffiche des titres : un seul enregistrement, puis un message avec annulation. */
function reveal(keys) {
  for (const k of keys) selected.delete(k);
  const removed = unhideTitles(keys);
  updateBar();
  if (!removed.length) return;
  toast(tn(removed.length, '{n} titre réaffiché', '{n} titres réaffichés'), {
    ms: 6000,
    action: { label: tr('Annuler'), run: () => { if (!restoreHidden(removed)) toast(tr('Liste pleine : impossible d’annuler')); } },
  });
}

/** Recale l'état visuel des tuiles affichées sur la sélection (sans redessiner la grille). */
function paintVisible() {
  detailEl.querySelectorAll('#hid-grid [data-hid-sel]').forEach((c) => paintSel(c, selected.has(c.dataset.hidSel)));
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || state.kind !== 'hidden' || !detailEl.querySelector('#hid-grid')) return;
  const type = t.closest('[data-hid-type]');
  if (type) { view.type = type.dataset.hidType; renderGrid(); return; }
  const sort = t.closest('[data-hid-sort]');
  if (sort) { view.sort = sort.dataset.hidSort; renderGrid(); return; }
  if (t.closest('[data-hid-qclear]')) {
    view.query = '';
    const input = detailEl.querySelector('#hid-q');
    if (input) { input.value = ''; input.focus(); }
    renderGrid();
    return;
  }
  const un = t.closest('[data-hid-unhide]');
  if (un) { reveal([un.dataset.hidUnhide]); return; }
  const card = t.closest('[data-hid-sel]');
  if (card) {
    const k = card.dataset.hidSel;
    if (selected.has(k)) selected.delete(k); else selected.add(k);
    paintSel(card, selected.has(k));
    updateBar();
    return;
  }
  if (t.closest('[data-hid-all]')) {
    for (const h of current) selected.add(h.key);
    paintVisible();
    updateBar();
    return;
  }
  if (t.closest('[data-hid-clear]')) {
    selected.clear();
    paintVisible();
    updateBar();
    return;
  }
  if (t.closest('[data-hid-bulk]') && selected.size) reveal([...selected]);
}

function onInput(e) {
  const input = e.target instanceof Element ? e.target : null;
  if (!input || !input.matches('#hid-q') || state.kind !== 'hidden') return;
  view.query = input.value;
  renderGrid();
}

detailEl.addEventListener('click', onClick);
detailEl.addEventListener('input', onInput);

// Une modification des titres masqués (ici, ou depuis le menu contextuel) redessine la page si elle est affichée.
onHomeChange(() => {
  if (!detailEl.querySelector('#hid-grid')) return;
  const keep = new Set(hiddenTitles().map((h) => h.key));
  for (const k of [...selected]) if (!keep.has(k)) selected.delete(k);
  renderGrid();
  updateBar();
});

export function showHidden() {
  if (isKidProfile()) return; // profil enfant : pas de titres masqués (le routeur refuse déjà la route)
  teardownFiche();
  state.kind = 'hidden';
  document.title = tr('Titres masqués · Laststream');
  selected.clear();
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page search-page hid-page" aria-labelledby="hid-title">' +
    '<header class="search-head"><p class="svc-eyebrow">' + tr('Accueil et recommandations') + '</p>' +
    '<h1 class="search-title" id="hid-title" tabindex="-1">' + tr('Titres masqués') + '</h1>' +
    '<p class="hid-intro">' + tr('Ces titres ne sont plus proposés sur l’accueil. Sélectionne-les pour les réafficher en une fois, ou survole une affiche pour la réafficher seule.') + '</p>' +
    '<p class="hid-summary" id="hid-summary" aria-live="polite"></p>' +
    '<div class="search-form" role="search"><div class="search-bar"><label class="sr-only" for="hid-q">' + tr('Rechercher parmi les titres masqués') + '</label>' +
    '<span class="search-ico" aria-hidden="true">' + ICON.search + '</span>' +
    '<input id="hid-q" class="search-input" type="search" name="q" autocomplete="off" placeholder="' + tr('Rechercher un titre masqué…') + '" value="' + esc(view.query) + '">' +
    '<button type="button" class="search-clear" data-hid-qclear aria-label="' + tr('Effacer la recherche') + '" hidden>' + ICON.close + '</button></div></div>' +
    '<div class="hid-tools"><div class="pills" data-nav role="group" aria-label="' + tr('Type') + '">' +
    '<button type="button" class="pill" data-hid-type="all">' + tr('Tout') + ' <span class="srch-n" data-hid-count="all">0</span></button>' +
    '<button type="button" class="pill" data-hid-type="movie">' + tr('Films') + ' <span class="srch-n" data-hid-count="movie">0</span></button>' +
    '<button type="button" class="pill" data-hid-type="tv">' + tr('Séries') + ' <span class="srch-n" data-hid-count="tv">0</span></button></div>' +
    '<div class="pills" data-nav role="group" aria-label="' + tr('Trier') + '">' +
    '<button type="button" class="pill" data-hid-sort="recent">' + tr('Masqués récemment') + '</button>' +
    '<button type="button" class="pill" data-hid-sort="title">' + tr('Titre A→Z') + '</button>' +
    '<button type="button" class="pill" data-hid-sort="year">' + tr('Année') + '</button></div></div>' +
    '</header>' +
    '<div class="hid-grid" id="hid-grid" data-nav></div>' +
    '<div class="hid-bar" id="hid-bar" role="toolbar" aria-label="' + tr('Actions sur la sélection') + '" data-nav hidden>' +
    '<button type="button" class="btn btn-primary btn-sm" data-hid-bulk>' + tr('Réafficher (0)') + '</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-hid-all>' + tr('Tout sélectionner (filtre courant)') + '</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-hid-clear>' + tr('Annuler') + '</button></div>' +
    '</article>';
  const h1 = detailEl.querySelector('#hid-title');
  if (h1) h1.focus({ preventScroll: true });
  renderGrid();
  updateBar();
}
