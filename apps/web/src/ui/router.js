/* Port du prototype (voir tools/port-prototype.mjs). */
import { showCalendar } from './calendar.js';
import { showHidden } from './hidden.js';
import { showStats } from './stats.js';
import { showFriendLibrary } from './friends.js';
import { openSidebar } from './socialSidebar.js';
import { showSharedList } from './sharedList.js';
import { showShareLink } from './publicTitle.js';
import { listIdFrom, shareCodeFrom } from './shareModel.js';
import { showParties, showParty } from './parties.js';
import { showSocialProfile } from './socialProfile.js';
import { showPartyJoin, teardownPartyJoin } from './partyjoin.js';
import { parseJoinHash } from '../party/join';
import { canAdmin, isKidProfile, kidSection } from '../data/auth';
import { showAdmin } from './admin.js';
import { browseAllowed, showBrowse } from './registry.js';
import { showAiBrowse } from './recs-ui.js';
import { showSearch } from './search.js';
import { app, detailEl } from './dom.js';
import { showFiche, teardownFiche } from './fiche.js';
import { closeHover } from './hover.js';
import { renderContinue } from './home.js';
import { notifyHomeChange } from '../data/homeFilters';
import { renderLibrary, showLibrary } from './library.js';
import { closeModal } from './modal.js';
import { showPerson } from './person.js';
import { closePlayer } from './player.js';
import { cancelDwell, setupPreviews, stopPreview } from './preview.js';
import { showCollection, showCollections } from './collections.js';
import { showDiscover } from './discover.js';
import { showService, showServices } from './services.js';
import { showSettings } from './settings.js';
import { state } from './state.js';
import { showShow, showShowsPage, renderTvRows } from './shows.js';
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
  else if (r.kind === 'collections') showCollections(r.cat);
  else if (r.kind === 'collection') showCollection(r.id);
  else if (r.kind === 'discover') showDiscover();
  else if (r.kind === 'library') showLibrary();
  else if (r.kind === 'hidden') showHidden();
  else if (r.kind === 'stats') showStats();
  else if (r.kind === 'friends') openSidebar();
  else if (r.kind === 'friend') showFriendLibrary(r.id);
  else if (r.kind === 'socialprofile') showSocialProfile();
  else if (r.kind === 'parties') showParties();
  else if (r.kind === 'list') showSharedList(r.id);
  else if (r.kind === 'sharelink') showShareLink(r.code);
  else if (r.kind === 'party') showParty(r.id);
  else if (r.kind === 'partyjoin') showPartyJoin(r.id, r.token);
  else if (r.kind === 'settings') showSettings();
  else if (r.kind === 'admin') showAdmin();
  else if (r.kind === 'browse') (r.id === 'ai' ? showAiBrowse() : showBrowse(r.id));
  else if (r.kind === 'search') showSearch();
  else if (r.kind === 'calendar') showCalendar();
  else if (r.kind === 'person') showPerson(r.id);
  else if (r.kind === 'tvlive') showTvLive();
  else if (r.kind === 'shows') showShowsPage();
  else if (r.kind === 'show') showShow(r.id);
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
  // Console d'administration : propriétaire, session serveur, profil non enfant. Sinon la route n'existe pas (retour à l'accueil).
  if (r && r.kind === 'admin' && !canAdmin()) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* adresse inchangée */ }
    return null;
  }
  // Profil enfant : ni réglages ni TV en direct, ni amis ni salons publics (un salon privé s'ouvre par son lien).
  if (r && isKidProfile() && (r.kind === 'settings' || r.kind === 'hidden' || r.kind === 'stats' || r.kind === 'friends' || r.kind === 'friend' || r.kind === 'socialprofile' || r.kind === 'list' || r.kind === 'parties' || (r.kind === 'tvlive' && !kidSection('tv')) || r.kind === 'calendar' || r.kind === 'shows' || r.kind === 'show' || r.kind === 'collections' || r.kind === 'collection' || r.kind === 'discover')) return null;
  if (r && r.kind === 'browse' && !(r.id === 'ai' ? !isKidProfile() : browseAllowed(r.id))) return null;
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
  r = /^#\/collections(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(h);
  if (r) return { kind: 'collections', cat: r[1] || '' };
  r = /^#\/collection\/([A-Za-z0-9_-]{1,64})$/.exec(h);
  if (r) return { kind: 'collection', id: r[1] };
  if (h === '#/discover') return { kind: 'discover' };
  if (h === '#/library') return { kind: 'library' };
  if (h === '#/hidden') return { kind: 'hidden' };
  if (h === '#/stats') return { kind: 'stats' };
  if (h === '#/friends') return { kind: 'friends' };
  r = /^#\/friend\/([a-z0-9_.-]{3,32})$/.exec(h);
  if (r) return { kind: 'friend', id: r[1] };
  if (h === '#/social/profile') return { kind: 'socialprofile' };
  const listId = listIdFrom(h);
  if (listId) return { kind: 'list', id: listId };
  // Lien public d'un titre recommandé : #/t/<code> (ou /t/<code> servi par le Worker), sans session.
  const shareCode = shareCodeFrom(h, '');
  if (shareCode) return { kind: 'sharelink', code: shareCode };
  if (h === '#/parties') return { kind: 'parties' };
  r = /^#\/party\/([A-Za-z0-9_-]{1,64})$/.exec(h);
  if (r) return { kind: 'party', id: r[1] };
  // Invitation d'un invité (sans compte) : #/party/join/<id>?t=<jeton>.
  const join = parseJoinHash(h);
  if (join) return { kind: 'partyjoin', id: join.roomId, token: join.token };
  if (h === '#/settings') return { kind: 'settings' };
  if (h === '#/admin') return { kind: 'admin' };
  r = /^#\/browse\/([a-z-]{1,20})$/.exec(h);
  if (r) return { kind: 'browse', id: r[1] };
  if (h === '#/search') return { kind: 'search' };
  if (h === '#/calendar') return { kind: 'calendar' };
  if (h === '#/emissions') return { kind: 'shows' };
  r = /^#\/emission\/(\d{1,9}|epg:[a-z0-9-]{1,200})$/.exec(h);
  if (r) return { kind: 'show', id: r[1] };
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
  if (!r || r.kind !== 'partyjoin') teardownPartyJoin();
  // Amis (#/friends) : la barre latérale s'ouvre par-dessus la page en cours, qui reste affichée.
  if (r && r.kind === 'friends') {
    openSidebar();
    return;
  }
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
    notifyHomeChange(); // un titre vu dans le lecteur ou la fiche sort des rangées de l'accueil
    renderLive();
    renderTvRows();
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
