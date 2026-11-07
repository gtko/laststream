/* Page d'un catalogue d'addon (#/addon/<clé>/<type>/<catalogue>, ODY-252) : titre, genres, recherche, tri local et grille de
 * titres chargée par `skip` au défilement (infiniteList). Les titres sont lus depuis l'appareil (fetchCatalogPage) ; l'adresse
 * de l'addon, qui peut contenir un jeton, n'est jamais affichée ni journalisée. */
import { catalogDisplay, fetchCatalogPage, readAddonCatalogs } from '../data/addonCatalog';
import { isKidProfile } from '../data/auth';
import { addonItemOf, addonTypeLabel, rememberMetaPreview } from './addonRows.js';
import { topBar } from './fragments.js';
import { infiniteList } from './infinite.js';
import { fallbackHTML } from './typo.js';
import { esc } from './util.js';

/** Pages lues au plus pour un catalogue (défilement infini). */
const ADDON_PAGES_MAX = 100;

const SORTS = [['default', 'Ordre de l’addon'], ['name', 'Nom (A à Z)'], ['year-desc', 'Année (récentes d’abord)'], ['year-asc', 'Année (anciennes d’abord)']];

const select = (id, label, options) =>
  '<label class="dc-field" for="' + id + '"><span>' + esc(label) + '</span><select id="' + id + '">' +
  options.map(([v, l]) => '<option value="' + esc(v) + '">' + esc(l) + '</option>').join('') + '</select></label>';

/** Carte d'un titre d'addon : lien vers sa fiche, avec les classes des cartes de l'accueil. `seq` garde l'ordre de l'addon. */
export function addonCardHTML(it, seq = 0) {
  rememberMetaPreview(it);
  const meta =[addonTypeLabel(it.type), it.year, it.genre].filter(Boolean).join(' · ');
  const label = [it.name, addonTypeLabel(it.type), it.year].filter(Boolean).join(', ');
  return '<a class="card tile" href="' + esc(it.href) + '" data-go' +
    ' data-sort-name="' + esc(it.name.toLocaleLowerCase('fr')) + '" data-sort-year="' + esc(it.year) + '" data-seq="' + seq + '"' +
    ' aria-label="' + esc(label) + '">' +
    '<span class="card-media' + (it.poster ? '' : ' no-img') + '">' +
    (it.poster ? '<img src="' + esc(it.poster) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML(it) + '</span>' +
    '<span class="card-title" aria-hidden="true">' + esc(it.name) + '</span>' +
    '<span class="card-meta" aria-hidden="true">' + esc(meta) + '</span></a>';
}

const notice = (msg, action = '') => '<div class="state" role="status"><p>' + esc(msg) + '</p>' + action + '</div>';
const RETRY = '<button type="button" class="btn btn-ghost" data-ad-retry>Réessayer</button>';
const SETTINGS = '<div class="f-actions"><a class="btn btn-ghost" href="#/settings" data-go>Ouvrir les réglages</a></div>';

/**
 * Affiche le catalogue `{ addonKey, type, catId }` dans `root`. Renvoie `{ destroy }` : à appeler quand la page est quittée
 * (arrête le défilement). Les chargements en cours s'arrêtent d'eux-mêmes quand la grille n'est plus dans la page.
 */
export function showAddonCatalog(root, { addonKey, type, catId }) {
  const entry = readAddonCatalogs()[addonKey];
  const cat = entry ? entry.catalogs.find((c) => c.type === type && c.id === catId) : undefined;
  const display = cat ? catalogDisplay(cat) : 'hidden';
  const title = entry && cat ? cat.name + ' · ' + entry.name : 'Catalogue';
  document.title = title + ' · Laststream';

  if (isKidProfile()) {
    root.innerHTML = topBar(false) + '<article class="svc-page ct-page" tabindex="-1"><div class="state" role="status"><p>Ce catalogue n’est pas disponible sur ce profil.</p></div></article>';
    return { destroy() {} };
  }
  const available = !!entry && !!cat && display !== 'hidden';
  if (!available) {
    root.innerHTML = topBar(false) + '<article class="svc-page ct-page" tabindex="-1">' + notice('Ce catalogue n’est plus activé.', SETTINGS) + '</article>';
    return { destroy() {} };
  }

  const searchOnly = display === 'search-only';
  const hasSearch = searchOnly || cat.extra.some((e) => e.name === 'search');
  const genreExtra = cat.extra.find((e) => e.name === 'genre');
  const genreOptions = genreExtra?.options?.length ? genreExtra.options : null;

  const searchHTML = hasSearch
    ? '<form class="ad-search" id="ad-search" role="search"><label class="dc-field" for="ad-q"><span>Rechercher dans ce catalogue</span>' +
      '<input class="search-input" id="ad-q" type="search" autocomplete="off" enterkeyhint="search" maxlength="100"></label>' +
      '<button type="submit" class="btn btn-ghost">Rechercher</button></form>'
    : '';
  const genreHTML = !searchOnly && genreOptions
    ? select('ad-genre', 'Genre', (genreExtra.isRequired ? [] : [['', 'Tous']]).concat(genreOptions.map((g) => [g, g])))
    : '';
  const sortHTML = searchOnly ? '' : select('ad-sort', 'Trier par', SORTS);

  root.innerHTML = topBar(false) +
    '<article class="svc-page ct-page" aria-labelledby="svc-title">' +
    '<header class="svc-head svc-head-plain"><div class="svc-head-t"><p class="svc-eyebrow">Catalogue d’addon</p>' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="dc-form">' + searchHTML + (genreHTML || sortHTML ? '<div class="dc-fields">' + genreHTML + sortHTML + '</div>' : '') + '</div>' +
    '<p class="cf-count" id="ad-count" role="status" aria-live="polite"></p>' +
    '<div id="ad-status"></div>' +
    '<div class="lib-grid dc-grid" id="ad-grid" data-nav></div></article>';
  const h1 = root.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  const grid = root.querySelector('#ad-grid');
  const countEl = root.querySelector('#ad-count');
  const status = root.querySelector('#ad-status');
  const form = root.querySelector('#ad-search');
  const qInput = root.querySelector('#ad-q');
  const genreSel = root.querySelector('#ad-genre');
  const sortSel = root.querySelector('#ad-sort');

  let list = null;
  let token = 0;

  const updateCount = () => {
    const n = grid.querySelectorAll('.card').length;
    countEl.textContent = n ? n + (n > 1 ? ' titres' : ' titre') : '';
  };

  /** Tri local : ne porte que sur les titres déjà chargés (réappliqué après chaque page). */
  const sortGrid = () => {
    const mode = sortSel ? sortSel.value : 'default';
    const cards = Array.from(grid.children).filter((el) => el.hasAttribute('data-seq'));
    const yr = (el) => Number(el.dataset.sortYear) || 0;
    const orders = {
      default: (a, b) => Number(a.dataset.seq) - Number(b.dataset.seq),
      name: (a, b) => a.dataset.sortName.localeCompare(b.dataset.sortName, 'fr'),
      'year-desc': (a, b) => yr(b) - yr(a),
      'year-asc': (a, b) => (yr(a) || 9999) - (yr(b) || 9999),
    };
    const order = orders[mode];
    if (!order || cards.length < 2) return;
    cards.sort(order).forEach((el) => grid.appendChild(el));
  };

  const start = () => {
    const my = ++token;
    if (list) list.destroy();
    list = null;
    const alive = () => my === token && grid.isConnected;
    grid.innerHTML = '';
    status.innerHTML = '';
    countEl.textContent = '';
    const q = qInput ? qInput.value.trim() : '';
    if (searchOnly && !q) {
      status.innerHTML = '<p class="row-msg" role="status">Saisis un titre pour lancer la recherche.</p>';
      return;
    }
    const base = { genre: genreSel ? genreSel.value : undefined, search: q || undefined };
    const seen = new Set();
    let step = 0;
    let seq = 0;
    let firstError = null;

    const load = async (page) => {
      if (!alive()) return { html: '', done: true };
      const res = await fetchCatalogPage(entry, cat, { ...base, skip: step * (page - 1) });
      if (!alive()) return { html: '', done: true };
      if (res.error) {
        if (page === 1) {
          firstError = res.error;
          return { html: '', done: true };
        }
        throw new Error(res.error); // infiniteList affiche « Réessayer » en pied de liste
      }
      if (page === 1) step = res.metas.length;
      const fresh = res.metas.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      if (!fresh.length) return { html: '', done: true };
      const html = fresh.map((m) => addonCardHTML(addonItemOf(m, addonKey, type), seq++)).join('');
      return { html, done: page >= ADDON_PAGES_MAX };
    };

    list = infiniteList({ host: grid, key: null, load, after: () => { sortGrid(); updateCount(); } });
    list.ready.then(() => {
      if (!alive()) return;
      if (firstError) {
        list.destroy();
        status.innerHTML = notice('Ce catalogue n’a pas pu être chargé.', RETRY);
        const retry = status.querySelector('[data-ad-retry]');
        if (retry) retry.addEventListener('click', start);
        return;
      }
      if (!grid.querySelector('.card')) {
        list.destroy();
        status.innerHTML = '<p class="row-msg">Aucun titre</p>';
      }
    });
  };

  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); start(); });
  if (genreSel) genreSel.addEventListener('change', start);
  if (sortSel) sortSel.addEventListener('change', sortGrid);
  start();

  return {
    destroy() {
      token++;
      if (list) list.destroy();
      list = null;
    },
  };
}
