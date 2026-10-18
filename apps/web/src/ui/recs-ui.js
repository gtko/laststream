/* Page « Recommandé pour toi » (#/browse/ai) : toute la liste du jour, raison sous chaque affiche, filtres Films / Séries. */
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { observeTiles } from './tiles.js';
import { esc } from './util.js';

let filter = 'all';

function cardHTML(it) {
  return '<button type="button" class="card poster ai-card ai-full" data-open="' + esc(it.key) + '" data-tile="' + esc(it.key) + '" aria-label="' + esc(it.name + (it.reason ? ' : ' + it.reason : '')) + '">' +
    '<span class="card-media' + (it.poster ? '' : ' no-img') + '">' +
    (it.poster ? '<img src="' + esc(it.poster) + '" alt="" loading="lazy" decoding="async">' : '') +
    '<span class="card-fallback">' + esc(it.name) + '</span></span>' +
    '<span class="card-title" aria-hidden="true">' + esc(it.name) + '</span>' +
    '<span class="card-reason" aria-hidden="true">' + esc(it.reason) + '</span></button>';
}

function renderGrid() {
  const box = detailEl.querySelector('#ai-grid');
  if (!box) return;
  const items = (state.ai.items || []).filter((it) => filter === 'all' || it.type === filter);
  box.innerHTML = items.length ? items.map(cardHTML).join('') : '<p class="row-msg">Aucune recommandation pour le moment.</p>';
  detailEl.querySelectorAll('[data-aif]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aif === filter)));
  observeTiles(box);
}

export function showAiBrowse() {
  teardownFiche();
  state.kind = 'browse';
  filter = 'all';
  document.title = 'Recommandé pour toi · Laststream';
  const n = (state.ai.items || []).length;
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Recommandé pour toi par l’IA</h1>' +
    '<p class="svc-eyebrow">' + (n ? n + ' titres, renouvelés chaque jour' : 'Ta liste du jour apparaît ici') + '</p>' +
    '<div class="pills" data-nav role="group" aria-label="Filtrer"><button type="button" class="pill" data-aif="all">Tout</button>' +
    '<button type="button" class="pill" data-aif="movie">Films</button><button type="button" class="pill" data-aif="tv">Séries</button></div></div></header>' +
    '<div class="lib-grid ai-grid" id="ai-grid" data-nav></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  renderGrid();
}

detailEl.addEventListener('click', (e) => {
  const b = e.target instanceof Element && e.target.closest('[data-aif]');
  if (!b) return;
  e.preventDefault();
  filter = b.dataset.aif;
  renderGrid();
});
