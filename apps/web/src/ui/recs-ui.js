/* Page « Recommandé pour toi » (#/browse/ai) : toute la liste du jour, filtres Films / Séries (la raison n'apparaît que dans l'aperçu au survol). */
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';

let filter = 'all';

function renderGrid() {
  const box = detailEl.querySelector('#ai-grid');
  if (!box) return;
  const items = (state.ai.items || []).filter((it) => filter === 'all' || it.type === filter);
  box.innerHTML = items.length ? items.map((it) => posterCard(it)).join('') : '<p class="row-msg">Aucune recommandation pour le moment.</p>';
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
