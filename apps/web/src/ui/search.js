/* Recherche (#/search) : titres et personnes TMDB. Profil enfant : seulement les genres jeunesse, puis contrôle de la classification. */
import { infiniteList } from './infinite.js';
import { applyRestore } from './router.js';
import { filterAvailable } from './avail.js';
import { todayStr } from './dates.js';
import { isKidProfile } from '../data/auth';
import { kidGenreOk } from '../data/kid';
import { tmdb } from '../data/lt';
import { register, toItem } from './catalog.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

let timer = null;
let seq = 0;

export function showSearch() {
  teardownFiche();
  state.kind = 'search';
  document.title = 'Recherche · Laststream';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Recherche</h1>' +
    '<form id="search-form" class="tv-form" role="search"><label class="tv-field">Un film, une série<input type="search" name="q" autocomplete="off" placeholder="Titre ou personnalité" value="' + esc(state.searchQ || '') + '"></label></form>' +
    '</div></header><div class="lib-grid" id="search-grid" data-nav aria-live="polite"></div></article>';
  const inp = detailEl.querySelector('input[name="q"]');
  if (inp) { inp.focus(); if (inp.value) run(inp.value); }
}

/** Résultats utilisables : jamais de personne ni de titre sans affiche ; pour un enfant, genres jeunesse uniquement. */
export function filterResults(results, kid) {
  return (results || []).filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path &&
    (r.release_date || r.first_air_date || '9999').slice(0, 10) <= todayStr() && (!kid || kidGenreOk(r.genre_ids)));
}

async function run(q) {
  const my = ++seq;
  const grid = detailEl.querySelector('#search-grid');
  if (!grid) return;
  state.searchQ = q;
  grid.innerHTML = '';
  if (q.trim().length < 2) return;
  const list = infiniteList({
    host: grid,
    key: location.hash + '|' + q.trim(),
    restore: state.restoreY != null,
    load: async (page) => {
      try {
        // Une page entièrement filtrée ne ferme pas la liste : on enchaîne jusqu'à 4 pages.
        for (let p = page, tries = 0; tries < 4; p += 1, tries += 1) {
          const json = await tmdb('search/multi', { query: q.trim(), include_adult: 'false', ...(p > 1 ? { page: p } : {}) });
          if (my !== seq || state.kind !== 'search') return { html: '', done: true };
          const total = json.total_pages || 1;
          const items = await filterAvailable(filterResults(json.results, isKidProfile()).map((r) => register(toItem(r, r.media_type))));
          if (items.length) return { html: items.map((it) => posterCard(it)).join(''), done: p >= total, advance: p - page + 1 };
          if (p >= total) return { html: '', done: true, advance: p - page + 1 };
        }
        return { html: '', done: true };
      } catch (_) {
        if (my === seq) throw _;
        return { html: '', done: true };
      }
    },
    after: (host) => observeTiles(host),
  });
  await list.ready;
  if (my === seq && !grid.querySelector('[data-tile]') && !grid.querySelector('.row-msg')) grid.insertAdjacentHTML('afterbegin', '<p class="row-msg">Aucun résultat.</p>');
  if (my === seq) applyRestore();
}

detailEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.name !== 'q' || !t.closest('#search-form')) return;
  clearTimeout(timer);
  timer = setTimeout(() => run(t.value), 350);
});
detailEl.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'search-form') { e.preventDefault(); clearTimeout(timer); run(e.target.elements.q.value); }
});
