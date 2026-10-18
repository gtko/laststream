/* Recherche (#/search) : titres et personnes TMDB. Profil enfant : seulement les genres jeunesse, puis contrôle de la classification. */
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
    (!kid || kidGenreOk(r.genre_ids)));
}

async function run(q) {
  const my = ++seq;
  const grid = detailEl.querySelector('#search-grid');
  if (!grid) return;
  state.searchQ = q;
  if (q.trim().length < 2) { grid.innerHTML = ''; return; }
  try {
    const json = await tmdb('search/multi', { query: q.trim(), include_adult: 'false' });
    if (my !== seq || state.kind !== 'search') return;
    const items = filterResults(json.results, isKidProfile()).map((r) => register(toItem(r, r.media_type)));
    grid.innerHTML = items.length ? items.map((it) => posterCard(it)).join('') : '<p class="row-msg">Aucun résultat.</p>';
    observeTiles(grid);
  } catch (_) {
    if (my === seq) grid.innerHTML = '<p class="row-msg" role="status">La recherche n’a pas abouti.</p>';
  }
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
