/* Pages du menu principal : Séries (#/series), Films (#/films) et Documentaires (#/documentaires).
 * Chacune est une suite de rangées du catalogue (HUBS dans data/rows.ts), chargées l'une après l'autre sous la barre du haut,
 * avec l'entrée de la page soulignée. Profil enfant : ces pages n'existent pas (voir parseRoute). */
import { canAdmin, isServerMode } from '../data/auth';
import { HUBS } from '../data/rows';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { brand } from './fragments.js';
import { tabbar } from './home.js';
import { loadHubRows } from './registry.js';
import { socialAvailable } from './socialButton.js';
import { state } from './state.js';
import { mainNavHTML, topActionsHTML } from './topnav.js';
import { esc } from './util.js';

/** Suffixe des ids des menus de cette barre : la barre de l'accueil (masquée) garde les siens. */
const BAR_ID = '-hub';

/** Barre du haut : logo, menu principal (entrée de la page soulignée), recherche, profil. */
const topbarHTML = (id) =>
  '<header class="topbar">' + brand() + '<nav class="nav" aria-label="Principale">' + mainNavHTML({ current: id, idSuffix: BAR_ID }) + '</nav>' +
  topActionsHTML({ social: socialAvailable(), server: isServerMode(), owner: canAdmin(), idSuffix: BAR_ID }) + '</header>';

/** Affiche la page `id` ('films', 'series' ou 'documentaires'). */
export async function showHub(id) {
  const hub = HUBS[id];
  if (!hub) return;
  teardownFiche();
  const token = state.token;
  state.kind = 'hub';
  document.title = hub.title + ' · Laststream';
  detailEl.innerHTML = '<div class="s-a hub-root">' + topbarHTML(id) +
    '<article class="svc-page hub-page" aria-labelledby="hub-title" aria-busy="true">' +
    '<h1 class="hub-title" id="hub-title" tabindex="-1">' + esc(hub.title) + '</h1>' +
    '<div class="rows hub-rows" id="hub-rows"></div>' +
    '<div class="hub-sk" aria-hidden="true"><span class="sk sk-line"></span><div class="row">' + '<span class="sk sk-card"></span>'.repeat(6) + '</div></div>' +
    '<p class="sr-only" role="status">Chargement du catalogue…</p></article>' + tabbar() + '</div>';
  const h1 = detailEl.querySelector('#hub-title');
  if (h1) h1.focus({ preventScroll: true });
  const slot = detailEl.querySelector('#hub-rows');
  const page = detailEl.querySelector('.hub-page');
  const alive = () => token === state.token && slot.isConnected && !detailEl.hidden;
  const shown = await loadHubRows(hub.rows, slot, alive);
  if (!alive()) return;
  page.removeAttribute('aria-busy');
  page.querySelectorAll('.hub-sk, [role="status"]').forEach((el) => el.remove());
  if (!shown) slot.innerHTML = '<p class="row-msg">Rien à voir ici pour le moment.</p>';
}
