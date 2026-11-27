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
import { t as tr } from '../i18n';

/** [libellé, id film, id série] (null : le genre n'existe pas pour ce type). */
const DISCOVER_GENRES = [
  [tr('Action'), 28, 10759], [tr('Aventure'), 12, 10759], [tr('Animation'), 16, 16], [tr('Comédie'), 35, 35], [tr('Crime'), 80, 80],
  [tr('Documentaire'), 99, 99], [tr('Drame'), 18, 18], [tr('Famille'), 10751, 10751], [tr('Fantastique'), 14, 10765], [tr('Guerre'), 10752, 10768],
  [tr('Histoire'), 36, null], [tr('Horreur'), 27, null], [tr('Musique'), 10402, null], [tr('Mystère'), 9648, 9648], [tr('Romance'), 10749, null],
  [tr('Science-fiction'), 878, 10765], [tr('Thriller'), 53, null], [tr('Western'), 37, 37],
];
const DISCOVER_DECADES = [['', tr('Toutes')], ['2020', tr('2020 à aujourd’hui')], ['2010', tr('Années 2010')], ['2000', tr('Années 2000')], ['1990', tr('Années 1990')],
  ['1980', tr('Années 1980')], ['1970', tr('Années 1970')], ['before', tr('Avant 1970')]];
const DISCOVER_COUNTRIES = [['', tr('Tous')], ['FR', tr('France')], ['US', tr('États-Unis')], ['GB', tr('Royaume-Uni')], ['CA', tr('Canada')], ['DE', tr('Allemagne')],
  ['ES', tr('Espagne')], ['IT', tr('Italie')], ['JP', tr('Japon')], ['KR', tr('Corée du Sud')], ['CN', tr('Chine')], ['IN', tr('Inde')], ['SE', tr('Suède')], ['MX', tr('Mexique')], ['BR', tr('Brésil')]];
const DISCOVER_RATINGS = [['', tr('Toutes')], ['6', tr('6 et plus')], ['7', tr('7 et plus')], ['8', tr('8 et plus')]];

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
  document.title = tr('Découvrir · Laststream');
  detailEl.innerHTML = topBar(false) + '<article class="svc-page ct-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head svc-head-plain"><span class="sk sk-title"></span></header></article>';
  let cat;
  try { cat = await loadCatalog(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError(tr('Les collections n’ont pas pu être chargées.'));
    return;
  }
  const services = await loadServices().catch(() => []);
  if (token !== state.token) return;
  const sel = { media: 'movie', genre: '', decade: '', country: '', rating: '', provider: '', sort: 'popularity' };
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page ct-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">' + tr('Sélections et filtres') + '</p><h1 class="svc-title" id="svc-title" tabindex="-1">' + tr('Découvrir') + '</h1></div></header>' +
    '<section class="ct-sec" aria-labelledby="dc-sel"><h2 class="row-title" id="dc-sel">' + tr('Sélections') + '</h2>' +
    '<div class="ct-grid" data-nav>' + discoverFolders(cat).map((f) => folderTile(f)).join('') + '</div></section>' +
    '<section class="ct-sec" aria-labelledby="dc-free"><h2 class="row-title" id="dc-free">' + tr('Explorer à ta façon') + '</h2>' +
    '<div class="dc-form" id="dc-form"></div><p class="cf-count" id="dc-count" role="status" aria-live="polite"></p>' +
    '<div class="lib-grid dc-grid" id="dc-grid" data-nav></div></section></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  const form = detailEl.querySelector('#dc-form');
  const grid = detailEl.querySelector('#dc-grid');
  const count = detailEl.querySelector('#dc-count');
  const paint = () => {
    const genres = [['', tr('Tous')]].concat(DISCOVER_GENRES.filter(([, m, t]) => (sel.media === 'tv' ? t : m) != null).map(([l, m, t]) => [String(sel.media === 'tv' ? t : m), l]));
    // Deux libellés peuvent partager un identifiant série (Action / Aventure) : on n'en garde qu'un.
    const seen = new Set();
    const uniq = genres.filter(([v]) => (seen.has(v) ? false : (seen.add(v), true)));
    form.innerHTML = pillsHTML('dcmedia', [['movie', tr('Films')], ['tv', tr('Séries')]], sel.media, tr('Type de titre')) +
      '<div class="dc-fields">' +
      select('dc-genre', tr('Genre'), uniq, sel.genre) + select('dc-decade', tr('Décennie'), DISCOVER_DECADES, sel.decade) +
      select('dc-country', tr('Pays d’origine'), DISCOVER_COUNTRIES, sel.country) + select('dc-rating', tr('Note minimale'), DISCOVER_RATINGS, sel.rating) +
      select('dc-provider', tr('Service de streaming'), [['', tr('Tous')]].concat(services.map((s) => [s.ids.join('|'), s.name])), sel.provider) +
      select('dc-sort', tr('Trier par'), SORTS.slice(1), sel.sort) + '</div>';
  };
  const run = () => {
    count.textContent = '';
    const folder = buildDiscoverFolder(selectionToQuery(sel));
    startFolderGrid({
      host: grid, folder, sort: sel.sort, media: 'all',
      onCount: (n, done) => { count.textContent = done ? n + (n > 1 ? ' titres' : ' titre') : tr('{n} titres et plus', { n }); },
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
