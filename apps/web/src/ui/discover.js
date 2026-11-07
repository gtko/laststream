/* Page « Découvrir » (#/discover) : les sélections du catalogue (Nouveaux films, Films tendances, Pour vous…) puis des
 * filtres libres (type, genre, décennie, pays d'origine, note minimale, service) qui construisent une requête discover. */
import { discoverFolders, loadCatalog } from '../data/collections/catalog';
import { buildDiscoverFolder } from '../data/collections/engine';
import { folderTile, pillsHTML, SORTS, startFolderGrid } from './collections.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { svcError, topBar } from './fragments.js';
import { loadServices } from './services.js';
import { state } from './state.js';
import { esc } from './util.js';

/** [libellé, id film, id série] (null : le genre n'existe pas pour ce type). */
const DISCOVER_GENRES = [
  ['Action', 28, 10759], ['Aventure', 12, 10759], ['Animation', 16, 16], ['Comédie', 35, 35], ['Crime', 80, 80],
  ['Documentaire', 99, 99], ['Drame', 18, 18], ['Famille', 10751, 10751], ['Fantastique', 14, 10765], ['Guerre', 10752, 10768],
  ['Histoire', 36, null], ['Horreur', 27, null], ['Musique', 10402, null], ['Mystère', 9648, 9648], ['Romance', 10749, null],
  ['Science-fiction', 878, 10765], ['Thriller', 53, null], ['Western', 37, 37],
];
const DISCOVER_DECADES = [['', 'Toutes'], ['2020', '2020 à aujourd’hui'], ['2010', 'Années 2010'], ['2000', 'Années 2000'], ['1990', 'Années 1990'],
  ['1980', 'Années 1980'], ['1970', 'Années 1970'], ['before', 'Avant 1970']];
const DISCOVER_COUNTRIES = [['', 'Tous'], ['FR', 'France'], ['US', 'États-Unis'], ['GB', 'Royaume-Uni'], ['CA', 'Canada'], ['DE', 'Allemagne'],
  ['ES', 'Espagne'], ['IT', 'Italie'], ['JP', 'Japon'], ['KR', 'Corée du Sud'], ['CN', 'Chine'], ['IN', 'Inde'], ['SE', 'Suède'], ['MX', 'Mexique'], ['BR', 'Brésil']];
const DISCOVER_RATINGS = [['', 'Toutes'], ['6', '6 et plus'], ['7', '7 et plus'], ['8', '8 et plus']];

const select = (id, label, options, value) =>
  '<label class="dc-field" for="' + id + '"><span>' + esc(label) + '</span><select id="' + id + '" data-dc="' + id + '">' +
  options.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';

/** Sélection de l'interface -> paramètres du moteur (pur, testable). */
function selectionToQuery(sel) {
  const genre = DISCOVER_GENRES.find(([, m, t]) => String(sel.media === 'tv' ? t : m) === String(sel.genre));
  return {
    media: sel.media === 'tv' ? 'tv' : 'movie',
    genre: genre ? (sel.media === 'tv' ? genre[2] : genre[1]) : undefined,
    decade: sel.decade || undefined,
    country: sel.country || undefined,
    minRating: sel.rating ? Number(sel.rating) : undefined,
    providers: sel.provider || undefined,
  };
}

export async function showDiscover() {
  teardownFiche();
  const token = state.token;
  state.kind = 'discover';
  document.title = 'Découvrir · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page ct-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head svc-head-plain"><span class="sk sk-title"></span></header></article>';
  let cat;
  try { cat = await loadCatalog(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les collections n’ont pas pu être chargées.');
    return;
  }
  const services = await loadServices().catch(() => []);
  if (token !== state.token) return;
  const sel = { media: 'movie', genre: '', decade: '', country: '', rating: '', provider: '', sort: 'popularity' };
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page ct-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">Sélections et filtres</p><h1 class="svc-title" id="svc-title" tabindex="-1">Découvrir</h1></div></header>' +
    '<section class="ct-sec" aria-labelledby="dc-sel"><h2 class="row-title" id="dc-sel">Sélections</h2>' +
    '<div class="ct-grid" data-nav>' + discoverFolders(cat).map((f) => folderTile(f)).join('') + '</div></section>' +
    '<section class="ct-sec" aria-labelledby="dc-free"><h2 class="row-title" id="dc-free">Explorer à ta façon</h2>' +
    '<div class="dc-form" id="dc-form"></div><p class="cf-count" id="dc-count" role="status" aria-live="polite"></p>' +
    '<div class="lib-grid dc-grid" id="dc-grid" data-nav></div></section></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  const form = detailEl.querySelector('#dc-form');
  const grid = detailEl.querySelector('#dc-grid');
  const count = detailEl.querySelector('#dc-count');
  const paint = () => {
    const genres = [['', 'Tous']].concat(DISCOVER_GENRES.filter(([, m, t]) => (sel.media === 'tv' ? t : m) != null).map(([l, m, t]) => [String(sel.media === 'tv' ? t : m), l]));
    // Deux libellés peuvent partager un identifiant série (Action / Aventure) : on n'en garde qu'un.
    const seen = new Set();
    const uniq = genres.filter(([v]) => (seen.has(v) ? false : (seen.add(v), true)));
    form.innerHTML = pillsHTML('dcmedia', [['movie', 'Films'], ['tv', 'Séries']], sel.media, 'Type de titre') +
      '<div class="dc-fields">' +
      select('dc-genre', 'Genre', uniq, sel.genre) + select('dc-decade', 'Décennie', DISCOVER_DECADES, sel.decade) +
      select('dc-country', 'Pays d’origine', DISCOVER_COUNTRIES, sel.country) + select('dc-rating', 'Note minimale', DISCOVER_RATINGS, sel.rating) +
      select('dc-provider', 'Service de streaming', [['', 'Tous']].concat(services.map((s) => [s.ids.join('|'), s.name])), sel.provider) +
      select('dc-sort', 'Trier par', SORTS.slice(1), sel.sort) + '</div>';
  };
  const run = () => {
    count.textContent = '';
    const folder = buildDiscoverFolder(selectionToQuery(sel));
    startFolderGrid({
      host: grid, folder, sort: sel.sort, media: 'all',
      onCount: (n, done) => { count.textContent = done ? n + (n > 1 ? ' titres' : ' titre') : n + ' titres et plus'; },
    });
  };
  form.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-dcmedia]') : null;
    if (!b) return;
    e.preventDefault();
    sel.media = b.dataset.dcmedia;
    sel.genre = '';
    paint();
    const again = form.querySelector('[data-dcmedia="' + sel.media + '"]');
    if (again) again.focus({ preventScroll: true });
    run();
  });
  form.addEventListener('change', (e) => {
    const s = e.target instanceof Element ? e.target.closest('[data-dc]') : null;
    if (!s) return;
    sel[s.dataset.dc.replace('dc-', '')] = s.value;
    run();
  });
  paint();
  run();
}
