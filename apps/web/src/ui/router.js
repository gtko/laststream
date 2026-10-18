/* Port du prototype (voir tools/port-prototype.mjs). */
import { isKidProfile, kidSection } from '../data/auth';
import { showBrowse } from './kids.js';
import { showAiBrowse } from './recs-ui.js';
import { showSearch } from './search.js';
import { app, detailEl } from './dom.js';
import { showFiche, teardownFiche } from './fiche.js';
import { closeHover } from './hover.js';
import { renderContinue } from './home.js';
import { renderLibrary, showLibrary } from './library.js';
import { closeModal } from './modal.js';
import { showPerson } from './person.js';
import { closePlayer } from './player.js';
import { cancelDwell, setupPreviews, stopPreview } from './preview.js';
import { showService, showServices } from './services.js';
import { showSettings } from './settings.js';
import { state } from './state.js';
import { renderLive, showTvLive } from './tv.js';

export function go(url, opener) {
  closeHover();
  if (state.inDetail) {
    if (state.kind === 'fiche' && /^#\/(movie|tv)\//.test(url)) location.replace(url); // fiche -> fiche : ne pas empiler l'historique
    else { state.depth = Math.max(state.depth, 1); location.hash = url; }
  } else {
    state.lastFocus = opener || document.activeElement;
    state.depth = 1;
    location.hash = url;
  }
}

export function showView(r) {
  if (r.kind === 'service') showService(r.slug);
  else if (r.kind === 'services') showServices();
  else if (r.kind === 'library') showLibrary();
  else if (r.kind === 'settings') showSettings();
  else if (r.kind === 'browse') (r.id === 'ai' ? showAiBrowse() : showBrowse(r.id));
  else if (r.kind === 'search') showSearch();
  else if (r.kind === 'person') showPerson(r.id);
  else if (r.kind === 'tvlive') showTvLive();
  else showFiche(r.type, r.id);
}
export function applyRestore() {
  if (state.restoreY == null) return;
  const y = state.restoreY;
  state.restoreY = null;
  window.scrollTo(0, y);
  setTimeout(() => window.scrollTo(0, y), 500);
}
export function parseRoute() {
  const r = parseRouteRaw();
  // Profil enfant : ni réglages ni TV en direct.
  if (r && isKidProfile() && (r.kind === 'settings' || (r.kind === 'tvlive' && !kidSection('tv')))) return null;
  if (r && r.kind === 'browse' && (r.id === 'ai') === isKidProfile()) return null; // « ai » : adultes ; les autres : profils enfants
  return r;
}

function parseRouteRaw() {
  const h = location.hash || '';
  let r = /^#\/(movie|tv)\/(\d{1,9})$/.exec(h);
  if (r) return { kind: 'fiche', type: r[1], id: r[2] };
  r = /^#\/service\/([a-z0-9-]{1,40})$/.exec(h);
  if (r) return { kind: 'service', slug: r[1] };
  r = /^#\/person\/(\d{1,9})$/.exec(h);
  if (r) return { kind: 'person', id: r[1] };
  if (h === '#/services') return { kind: 'services' };
  if (h === '#/library') return { kind: 'library' };
  if (h === '#/settings') return { kind: 'settings' };
  r = /^#\/browse\/([a-z-]{1,20})$/.exec(h);
  if (r) return { kind: 'browse', id: r[1] };
  if (h === '#/search') return { kind: 'search' };
  return h === '#/tv-live' ? { kind: 'tvlive' } : null;
}

export function route() {
  closeHover();
  closePlayer(true);
  if (state.curHash) state.scrolls.set(state.curHash, window.scrollY);
  const pop = state.popping;
  state.popping = false;
  state.curHash = location.hash || '';
  state.restoreY = pop && state.scrolls.has(state.curHash) ? state.scrolls.get(state.curHash) : null;
  const r = parseRoute();
  if (r) {
    if (!state.inDetail) {
      state.homeScroll = window.scrollY;
      state.inDetail = true;
      stopPreview();
      cancelDwell();
      app.hidden = true;
      detailEl.hidden = false;
    }
    closeModal(true);
    window.scrollTo(0, 0);
    showView(r);
  } else {
    closeModal(true);
    if (!state.inDetail) return;
    teardownFiche();
    state.inDetail = false;
    state.depth = 0;
    detailEl.hidden = true;
    detailEl.innerHTML = '';
    app.hidden = false;
    document.title = 'Laststream';
    window.scrollTo(0, state.homeScroll);
    setupPreviews();
    renderLibrary();
    renderContinue();
    renderLive();
    const t = state.lastFocus;
    state.lastFocus = null;
    if (t && t.isConnected && t.focus) t.focus({ preventScroll: true });
  }
}

export function openItem(key, opener) {
  const it = state.byKey.get(key);
  if (!it) return;
  go('#/' + it.type + '/' + it.id, opener);
}

export function goBack() {
  if (state.depth > 0) history.back();
  else location.hash = '#/';
}
