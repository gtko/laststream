/* Collections : tuiles paysage animées au survol, hub (#/collections), page d'un dossier (#/collection/{id}) et rangées
 * d'accueil (En vedette, Services de streaming, collections du jour).
 * Collections inspirées de Focale (MIT) et Kaptain. Le JSON (~900 Ko) est chargé à la demande. */
import { isKidProfile } from '../data/auth';
import {
  CREDIT, FOR_YOU_ID, SERVICES_CATEGORY, featuredFolders, folderById, loadCatalog, rotatingRows, searchCatalog, serviceFolders, serviceSlug,
} from '../data/collections/catalog';
import { folderBackdrop, newCtx, resolveUntil, usableSources } from '../data/collections/engine';
import { filterAvailable } from './avail.js';
import { register, toItem } from './catalog.js';
import { REDUCE, STILL } from './constants.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { svcError, topBar } from './fragments.js';
import { infiniteList } from './infinite.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { palette } from './typo.js';
import { esc } from './util.js';

const GIF_DELAY_MS = 150;
const HUB_PREVIEW = 12; // tuiles par catégorie dans la vue « Toutes »

// ---------- Tuiles ----------

/** Adresse d'un dossier : « Pour vous » ouvre nos recommandations. */
export const folderHref = (f) => (f.id === FOR_YOU_ID ? '#/browse/ai' : '#/collection/' + f.id);

/**
 * Tuile paysage 16:9 : image de couverture, logo en surimpression (sinon le nom). Le GIF n'est PAS dans le HTML : il
 * n'est créé qu'au survol ou au focus (une seule tuile à la fois), jamais avec prefers-reduced-motion ni ?still.
 * @param {object} f dossier
 * @param {{size?: 'm'|'l'|'xl', href?: string}} [o]
 */
export function folderTile(f, o) {
  o = o || {};
  const pal = palette(f.title);
  const size = o.size || 'm';
  return '<a class="ct ct-' + size + (f.logo ? ' has-logo' : '') + (f.cover ? '' : ' no-img') + '" href="' + esc(o.href || folderHref(f)) + '" data-go data-folder="' + esc(f.id) + '"' +
    (f.gif ? ' data-gif="' + esc(f.gif) + '"' : '') + ' style="--c1:' + pal.c1 + ';--c2:' + pal.c2 + '" aria-label="' + esc(f.title) + '">' +
    '<span class="ct-media">' +
    (f.cover ? '<img class="ct-img" src="' + esc(f.cover) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') +
    '<span class="ct-shade" aria-hidden="true"></span>' +
    (f.logo ? '<img class="ct-logo" src="' + esc(f.logo) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') +
    '<span class="ct-name" aria-hidden="true">' + esc(f.title) + '</span>' +
    '</span></a>';
}

// ---------- GIF au survol / focus ----------

let gifTimer = null;
let gifTile = null;

export function stopGif() {
  if (gifTimer) clearTimeout(gifTimer);
  gifTimer = null;
  if (gifTile) {
    gifTile.querySelectorAll('.ct-gif').forEach((n) => n.remove());
    gifTile.classList.remove('is-playing');
  }
  gifTile = null;
}

/** Charge et joue le GIF de la tuile ; remplace celui d'une autre tuile. */
export function startGif(tile) {
  if (REDUCE || STILL || !tile || !tile.dataset.gif) return;
  if (gifTile === tile) return;
  stopGif();
  gifTile = tile;
  const img = document.createElement('img');
  img.className = 'ct-gif';
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => { img.classList.add('is-on'); tile.classList.add('is-playing'); });
  img.src = tile.dataset.gif;
  const media = tile.querySelector('.ct-media');
  const shade = media && media.querySelector('.ct-shade');
  if (media) media.insertBefore(img, shade || null);
}

function scheduleGif(tile) {
  if (REDUCE || STILL || gifTile === tile) return;
  if (gifTimer) clearTimeout(gifTimer);
  gifTimer = setTimeout(() => { gifTimer = null; startGif(tile); }, GIF_DELAY_MS);
}

const tileOf = (n) => (n instanceof Element ? n.closest('.ct[data-gif]') : null);

/** Écouteurs globaux (un seul jeu : un rechargement de module remplace le précédent). */
const GLOBAL_KEY = '__ltCollectionsOff';
function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}
if (typeof window[GLOBAL_KEY] === 'function') window[GLOBAL_KEY]();
const offs = [];

offs.push(listen(document, 'mouseover', (e) => {
  const t = tileOf(e.target);
  if (t) scheduleGif(t);
}));
offs.push(listen(document, 'mouseout', (e) => {
  const t = tileOf(e.target);
  if (!t) return;
  const to = e.relatedTarget;
  if (to instanceof Node && t.contains(to)) return;
  stopGif();
}));
offs.push(listen(document, 'focusin', (e) => {
  const t = tileOf(e.target);
  if (t) scheduleGif(t);
  else if (gifTile || gifTimer) stopGif();
}));
offs.push(listen(document, 'focusout', (e) => {
  if (tileOf(e.target)) stopGif();
}));
offs.push(listen(window, 'scroll', () => { if (gifTile) stopGif(); }, { passive: true }));

// ---------- Images cassées ----------

let catalogRef = null;

/** Couverture cassée : fond TMDB d'un titre du dossier, sinon dégradé et nom. */
export async function coverFallback(img) {
  const tile = img.closest('.ct');
  if (!tile) return;
  const media = tile.querySelector('.ct-media');
  const giveUp = () => { img.remove(); tile.classList.add('no-img'); };
  if (img.dataset.fb) { giveUp(); return; }
  img.dataset.fb = '1';
  const folder = catalogRef && (catalogRef.byId.get(tile.dataset.folder) || catalogRef.art.get(tile.dataset.folder));
  if (!folder || !media) { giveUp(); return; }
  const url = await folderBackdrop(folder);
  if (url && tile.isConnected) img.src = url;
  else giveUp();
}

offs.push(listen(document, 'error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('ct-img')) coverFallback(img);
  else if (img.classList.contains('ct-logo')) { const t = img.closest('.ct'); if (t) t.classList.remove('has-logo'); img.remove(); }
  else if (img.classList.contains('ct-gif')) img.remove();
}, true));
window[GLOBAL_KEY] = () => { offs.forEach((off) => off()); stopGif(); };

// ---------- Hub #/collections ----------

/**
 * Corps du hub : une section par catégorie (aperçu de HUB_PREVIEW tuiles en vue « Toutes »), ou la grille complète d'une
 * catégorie ou des résultats de recherche. Pur : prend le catalogue et l'état, rend du HTML.
 */
export function hubBodyHTML(cat, st) {
  const q = (st.query || '').trim();
  const groups = searchCatalog(cat, { category: st.category, query: q });
  const count = groups.reduce((n, g) => n + g.folders.length, 0);
  if (!count) {
    return '<p class="row-msg" role="status">Aucune collection ne correspond à « ' + esc(q) + ' ».</p>';
  }
  const preview = st.category === 'all' && !q;
  const sections = groups.map((g) => {
    const shown = preview ? g.folders.slice(0, HUB_PREVIEW) : g.folders;
    const more = preview && g.folders.length > shown.length
      ? '<button type="button" class="row-link ct-more" data-hubcat="' + esc(g.category.id) + '">Voir les ' + g.folders.length + '</button>' : '';
    return '<section class="ct-sec" aria-labelledby="hc-' + esc(g.category.id) + '">' +
      '<h2 class="row-title" id="hc-' + esc(g.category.id) + '">' + esc(g.category.title) + '<span class="ct-n">' + g.folders.length + '</span>' + more + '</h2>' +
      '<div class="ct-grid" data-nav>' + shown.map((f) => folderTile(f)).join('') + '</div></section>';
  }).join('');
  return '<p class="sr-only" role="status" aria-live="polite">' + count + (count > 1 ? ' collections' : ' collection') + '</p>' + sections;
}

export function hubPillsHTML(cat, category) {
  const pill = (id, label) => '<button type="button" class="pill" data-hubcat="' + esc(id) + '" aria-pressed="' + String(category === id) + '">' + esc(label) + '</button>';
  return pill('all', 'Toutes') + cat.categories.map((c) => pill(c.id, c.title)).join('');
}

/** Rend le hub dans `root` (pastilles, recherche instantanée, grilles) et branche ses événements. */
export function renderHub(root, cat, initial) {
  const st = { category: initial && cat.categories.some((c) => c.id === initial) ? initial : 'all', query: '' };
  root.innerHTML =
    '<div class="ct-tools"><label class="ct-search"><span class="sr-only">Rechercher une collection</span>' +
    '<input type="search" id="hub-q" placeholder="Rechercher une collection, un studio, un acteur…" autocomplete="off" spellcheck="false" enterkeyhint="search"></label>' +
    '<div class="pills ct-pills" role="group" aria-label="Catégories de collections" data-nav id="hub-pills"></div></div>' +
    '<div id="hub-body"></div>' +
    '<p class="ct-credit">' + esc(CREDIT) + '. Données : TMDb.</p>';
  const pills = root.querySelector('#hub-pills');
  const body = root.querySelector('#hub-body');
  const input = root.querySelector('#hub-q');
  const paint = () => {
    pills.innerHTML = hubPillsHTML(cat, st.category);
    body.innerHTML = hubBodyHTML(cat, st);
  };
  const select = (id) => {
    st.category = id;
    paint();
    const cur = pills.querySelector('[aria-pressed="true"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-hubcat]') : null;
    if (!b) return;
    e.preventDefault();
    select(b.dataset.hubcat);
    if (b.classList.contains('ct-more')) window.scrollTo(0, 0);
    else { const again = pills.querySelector('[data-hubcat="' + b.dataset.hubcat + '"]'); if (again) again.focus({ preventScroll: true }); }
  });
  input.addEventListener('input', () => { st.query = input.value; body.innerHTML = hubBodyHTML(cat, st); });
  paint();
  return st;
}

export async function showCollections(initialCat) {
  teardownFiche();
  const token = state.token;
  state.kind = 'collections';
  document.title = 'Collections · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page ct-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head svc-head-plain"><span class="sk sk-title"></span></header></article>';
  let cat;
  try { cat = await loadCatalog(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les collections n’ont pas pu être chargées.');
    return;
  }
  if (token !== state.token) return;
  catalogRef = cat;
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page ct-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">Parcourir</p><h1 class="svc-title" id="svc-title" tabindex="-1">Collections</h1></div></header>' +
    '<div class="ct-hub" id="ct-hub"></div></article>';
  renderHub(detailEl.querySelector('#ct-hub'), cat, initialCat);
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
}

// ---------- Grille de titres d'un dossier (page dossier et Découvrir) ----------

export const SORTS = [['default', 'Sélection'], ['popularity', 'Popularité'], ['rating', 'Note'], ['recent', 'Récents']];

export function pillsHTML(attr, items, current, label) {
  return '<div class="pills" role="group" aria-label="' + esc(label) + '" data-nav>' +
    items.map(([v, l]) => '<button type="button" class="pill" data-' + attr + '="' + esc(v) + '" aria-pressed="' + String(v === current) + '">' + esc(l) + '</button>').join('') + '</div>';
}

/**
 * Grille infinie des titres d'un dossier (fusion des sources, dédoublonnage et filtres de l'accueil dans le moteur).
 * @param {{host: HTMLElement, folder: object, sort: string, media: string, key?: string, onCount?: (n:number, done:boolean, total:number)=>void}} o
 */
export function startFolderGrid(o) {
  const token = state.token;
  const ctx = newCtx({ sort: o.sort, media: o.media });
  let loaded = 0;
  o.host.innerHTML = '';
  const list = infiniteList({
    host: o.host,
    key: o.key || null,
    restore: !!o.key && state.restoreY != null,
    load: async (page) => {
      o.host.querySelectorAll('[data-tile]').forEach((el) => ctx.seen.add(el.dataset.tile));
      const res = await resolveUntil(o.folder, page, ctx);
      if (token !== state.token) return { html: '', done: true };
      const items = await filterAvailable(res.items.map((r) => register(toItem(r, r.media_type))));
      loaded += items.length;
      if (o.onCount) o.onCount(loaded, res.done, ctx.total);
      return { html: items.map((it) => posterCard(it)).join(''), done: res.done, advance: res.advance };
    },
    after: (host) => observeTiles(host),
  });
  list.ready.then(() => {
    if (token === state.token && !o.host.querySelector('[data-tile]')) {
      o.host.insertAdjacentHTML('beforeend', '<p class="row-msg" role="status">Rien à voir ici pour le moment.</p>');
    }
  });
  return list;
}

// ---------- Page d'un dossier #/collection/{id} ----------

const nTitres = (n) => n.toLocaleString('fr-FR') + (n > 1 ? ' titres' : ' titre');

export async function showCollection(id) {
  teardownFiche();
  const token = state.token;
  state.kind = 'collection';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page ct-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head svc-head-plain"><span class="sk sk-title"></span></header></article>';
  let cat;
  try { cat = await loadCatalog(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les collections n’ont pas pu être chargées.');
    return;
  }
  if (token !== state.token) return;
  catalogRef = cat;
  if (id === FOR_YOU_ID) { location.replace('#/browse/ai'); return; }
  const folder = folderById(cat, id);
  if (!folder) { detailEl.innerHTML = svcError('Collection introuvable.'); return; }
  const category = cat.catOf.get(id);
  const slug = serviceSlug(folder);
  const hasMovie = usableSources(folder, 'movie').length > 0;
  const hasTv = usableSources(folder, 'tv').length > 0;
  document.title = folder.title + ' · Laststream';
  const bg = folder.hero || folder.cover || '';
  const hist = { sort: 'default', media: 'all' };
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page ct-page" aria-labelledby="svc-title">' +
    '<header class="cf-head' + (bg ? '' : ' no-bg') + '" style="--c1:' + palette(folder.title).c1 + ';--c2:' + palette(folder.title).c2 + '">' +
    (bg ? '<img class="cf-bg" src="' + esc(bg) + '" alt="" decoding="async" referrerpolicy="no-referrer">' : '') +
    '<span class="cf-shade" aria-hidden="true"></span>' +
    '<div class="cf-in">' +
    (category ? '<p class="svc-eyebrow"><a href="#/collections/' + esc(category.id) + '" data-go>' + esc(category.title) + '</a></p>' : '') +
    (folder.logo ? '<img class="cf-logo" src="' + esc(folder.logo) + '" alt="" referrerpolicy="no-referrer">' : '') +
    '<h1 class="svc-title cf-title' + (folder.logo ? ' sr-only' : '') + '" id="svc-title" tabindex="-1">' + esc(folder.title) + '</h1>' +
    '<p class="cf-count" id="cf-count" role="status" aria-live="polite"></p>' +
    (slug ? '<a class="btn btn-ghost cf-svc" href="#/service/' + esc(slug) + '" data-go>Nouveautés et genres sur ' + esc(folder.title) + '</a>' : '') +
    '</div></header>' +
    '<div class="cf-tools" id="cf-tools"></div>' +
    '<div class="lib-grid" id="cf-grid" data-nav></div></article>';
  const head = detailEl.querySelector('.cf-head');
  const bgImg = detailEl.querySelector('.cf-bg');
  if (bgImg) bgImg.addEventListener('error', () => { bgImg.remove(); head.classList.add('no-bg'); }, { once: true });
  const logo = detailEl.querySelector('.cf-logo');
  if (logo) logo.addEventListener('error', () => { logo.remove(); detailEl.querySelector('#svc-title').classList.remove('sr-only'); }, { once: true });
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  const tools = detailEl.querySelector('#cf-tools');
  const grid = detailEl.querySelector('#cf-grid');
  const count = detailEl.querySelector('#cf-count');
  const paintTools = () => {
    tools.innerHTML = (hasMovie && hasTv ? pillsHTML('cfmedia', [['all', 'Tout'], ['movie', 'Films'], ['tv', 'Séries']], hist.media, 'Type de titre') : '') +
      pillsHTML('cfsort', SORTS, hist.sort, 'Trier par');
  };
  const run = () => {
    count.textContent = '';
    startFolderGrid({
      host: grid, folder, sort: hist.sort, media: hist.media, key: location.hash + '|' + hist.sort + '|' + hist.media,
      onCount: (n, done, total) => { count.textContent = done ? nTitres(n) : (total > n ? 'Environ ' + nTitres(total) : nTitres(n) + ' et plus'); },
    });
  };
  tools.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-cfsort],[data-cfmedia]') : null;
    if (!b) return;
    e.preventDefault();
    if (b.dataset.cfsort) hist.sort = b.dataset.cfsort;
    else hist.media = b.dataset.cfmedia;
    paintTools();
    const again = tools.querySelector('[aria-pressed="true"][data-' + (b.dataset.cfsort ? 'cfsort' : 'cfmedia') + ']');
    if (again) again.focus({ preventScroll: true });
    run();
  });
  paintTools();
  run();
}

// ---------- Accueil ----------

const rowSection = (id, title, inner, link) =>
  '<section class="row-section" id="' + id + '" aria-labelledby="h-' + id + '"><h2 class="row-title" id="h-' + id + '">' + esc(title) + (link || '') + '</h2>' + inner + '</section>';
const rowLink = (href, label) => ' <a class="row-link" href="' + esc(href) + '" data-go>' + esc(label) + '</a>';

/** « En vedette » : 8 dossiers en tuiles larges, visuels versionnés tous les 14 jours. */
export async function renderFeatured(now) {
  if (isKidProfile()) return false;
  try {
    const cat = await loadCatalog();
    catalogRef = cat;
    const slot = document.getElementById('feat-slot');
    const list = featuredFolders(cat, now);
    if (!slot || !list.length || state.status !== 'ready') return false;
    slot.innerHTML = rowSection('vedette', 'En vedette', '<div class="row ct-row ct-row-xl" data-nav>' + list.map((f) => folderTile(f, { size: 'xl' })).join('') + '</div>');
    return true;
  } catch (_) { return false; }
}

/** Services de streaming (22 tuiles) puis rangées de collections du jour. Faux si le catalogue est indisponible : l'ancienne rangée prend le relais. */
export async function renderHomeCollections(now) {
  if (isKidProfile()) return false;
  try {
    const cat = await loadCatalog();
    catalogRef = cat;
    const svcSlot = document.getElementById('svc-slot');
    if (!svcSlot || state.status !== 'ready') return false;
    const svcs = serviceFolders(cat);
    if (svcs.length) {
      const all = '<a class="ct ct-m ct-all" href="#/collections" data-go aria-label="Toutes les collections"><span class="ct-media"><span class="ct-all-in"><b>Toutes les collections</b><i aria-hidden="true">→</i></span></span></a>';
      svcSlot.innerHTML = rowSection('services', 'Services de streaming',
        '<div class="row ct-row" data-nav>' + svcs.map((f) => folderTile(f)).join('') + all + '</div>',
        rowLink('#/collections/' + SERVICES_CATEGORY, 'Tout voir') + rowLink('#/services', 'Nouveautés par service'));
    }
    const colSlot = document.getElementById('col-slot');
    if (colSlot) {
      colSlot.innerHTML = rotatingRows(cat, now).map((r) => rowSection('col-' + r.category.id, r.category.title,
        '<div class="row ct-row" data-nav>' + r.folders.map((f) => folderTile(f)).join('') + '</div>',
        rowLink('#/collections/' + r.category.id, 'Tout voir'))).join('');
    }
    return svcs.length > 0;
  } catch (_) { return false; }
}
