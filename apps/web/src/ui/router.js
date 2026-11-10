/* Port du prototype (voir tools/port-prototype.mjs). */
import { showCalendar } from './calendar.js';
import { ensureSocial } from './socialHooks.js';
import { listIdFrom, shareCodeFrom } from './shareModel.js';
import { joinRouteOf } from '../party/join';
import { canAdmin, isKidProfile, kidSection } from '../data/auth';
import { browseAllowed, showBrowse } from './registry.js';
import { app, detailEl, toast } from './dom.js';
import { showFiche, teardownFiche } from './fiche.js';
import { ensembleTabOf } from './ensembleTabs.js';
import { ficheHash, parseFicheHash } from './ficheRoute.js';
import { closeHover } from './hover.js';
import { renderContinue, startHomeLive, stopHomeLive } from './home.js';
import { notifyHomeChange } from '../data/homeFilters';
import { renderLibrary, showLibrary } from './library.js';
import { closeModal } from './modal.js';
import { closePlayer } from './player.js';
import { cancelDwell, setupPreviews, stopPreview } from './preview.js';
import { showCollection, showCollections } from './collections.js';
import { parseAddonHash, resolveAddonSlug } from './addonRoutes.js';
import { showService, showServices } from './services.js';
import { state } from './state.js';
import { showShow, showShowsPage, renderTvRows } from './shows.js';
import { renderLive, showTvLive } from './tv.js';

// Vues chargées à la première ouverture (import dynamique) : hors du premier chargement de l'application (LAST-129).
const loaded = {}; // modules déjà chargés : leurs fonctions de démontage ne s'appellent que s'ils le sont
const lazyView = (name, loader) => () => loader().then((m) => { loaded[name] = m; return m; });
const lazy = {
  hidden: lazyView('hidden', () => import('./hidden.js')),
  stats: lazyView('stats', () => import('./stats.js')),
  friendLibrary: lazyView('friendLibrary', () => import('./friendLibrary.js')),
  sharedList: lazyView('sharedList', () => import('./sharedList.js')),
  publicTitle: lazyView('publicTitle', () => import('./publicTitle.js')),
  parties: lazyView('parties', () => import('./parties.js')),
  ensemble: lazyView('ensemble', () => import('./ensemble.js')),
  socialProfile: lazyView('socialProfile', () => import('./socialProfile.js')),
  partyjoin: lazyView('partyjoin', () => import('./partyjoin.js')),
  admin: lazyView('admin', () => import('./admin.js')),
  recs: lazyView('recs', () => import('./recs-ui.js')),
  search: lazyView('search', () => import('./search.js')),
  downloads: lazyView('downloads', () => import('./downloads.js')),
  person: lazyView('person', () => import('./person.js')),
  discover: lazyView('discover', () => import('./discover.js')),
  addonCatalog: lazyView('addonCatalog', () => import('./addonCatalogPage.js')),
  addonFiche: lazyView('addonFiche', () => import('./addonFiche.js')),
  hubs: lazyView('hubs', () => import('./hubs.js')),
  settings: lazyView('settings', () => import('./settings.js')),
};
/** Navigation en cours : un module qui arrive après une autre navigation n'affiche plus rien. */
let navToken = 0;
/** Abandonne la vue chargée à la demande encore en route (navigation ailleurs ou retour à l'accueil). */
function cancelPendingView() { navToken++; }
/** Page qui n'a pas pu être chargée (réseau, module introuvable) : message et bouton pour réessayer. */
function showLoadError() {
  detailEl.innerHTML = '<div class="load-error" role="alert"><p>Impossible de charger cette page.</p><button type="button" class="btn" data-load-retry>Réessayer</button></div>';
  const b = detailEl.querySelector('[data-load-retry]');
  if (b) { b.addEventListener('click', () => route()); b.focus({ preventScroll: true }); }
}
/** Charge la vue puis l'ouvre, sauf si l'utilisateur a navigué ailleurs entre-temps ; un échec de chargement s'affiche. */
function open(load, run) {
  cancelPendingView();
  const token = navToken;
  load().then((m) => { if (token === navToken && m) run(m); }, () => { if (token === navToken) showLoadError(); });
}
/** Barre des amis par-dessus la page en cours : le Social est chargé au besoin. */
const openSidebar = () => { void ensureSocial().then(() => import('./socialSidebar.js')).then((m) => m.openSidebar()).catch(() => toast('Impossible de charger les amis.')); };
const teardownDownloads = () => loaded.downloads?.teardownDownloads();
const teardownPartyJoin = () => loaded.partyjoin?.teardownPartyJoin();

/** Page d'addon ouverte (catalogue ou fiche) : son `destroy()` est appelé en la quittant (voir teardownAddonView). */
let addonView = null;

/** Page d'addon quittée : arrêt de son défilement ou de ses chargements, puis remise à zéro de l'état de fiche. */
function teardownAddonView() {
  if (!addonView) return;
  addonView.destroy();
  addonView = null;
  teardownFiche();
}

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
  cancelPendingView(); // une vue chargée à la demande encore en route est abandonnée
  if (r.kind === 'service') showService(r.slug);
  else if (r.kind === 'services') showServices();
  else if (r.kind === 'collections') showCollections(r.cat);
  else if (r.kind === 'collection') showCollection(r.id);
  else if (r.kind === 'discover') open(lazy.discover, (m) => m.showDiscover());
  else if (r.kind === 'library') showLibrary();
  else if (r.kind === 'hidden') open(lazy.hidden, (m) => m.showHidden());
  else if (r.kind === 'stats') open(lazy.stats, (m) => m.showStats());
  else if (r.kind === 'friends') openSidebar();
  else if (r.kind === 'friend') open(lazy.friendLibrary, (m) => m.showFriendLibrary(r.id));
  else if (r.kind === 'socialprofile') open(lazy.socialProfile, (m) => m.showSocialProfile());
  else if (r.kind === 'ensemble') open(lazy.ensemble, (m) => m.showEnsemble(r.tab));
  else if (r.kind === 'list') open(lazy.sharedList, (m) => m.showSharedList(r.id));
  else if (r.kind === 'sharelink') open(lazy.publicTitle, (m) => m.showShareLink(r.code));
  else if (r.kind === 'party') open(lazy.parties, (m) => m.showParty(r.id));
  else if (r.kind === 'partyjoin') open(lazy.partyjoin, (m) => m.showPartyJoin(r.id, r.token));
  else if (r.kind === 'settings') open(lazy.settings, (m) => m.showSettings());
  else if (r.kind === 'admin') open(lazy.admin, (m) => m.showAdmin());
  else if (r.kind === 'browse') { if (r.id === 'ai') open(lazy.recs, (m) => m.showAiBrowse()); else showBrowse(r.id); }
  else if (r.kind === 'search') open(lazy.search, (m) => m.showSearch());
  else if (r.kind === 'calendar') showCalendar();
  else if (r.kind === 'person') open(lazy.person, (m) => m.showPerson(r.id));
  else if (r.kind === 'tvlive') showTvLive();
  else if (r.kind === 'shows') showShowsPage();
  else if (r.kind === 'show') showShow(r.id);
  else if (r.kind === 'hub') open(lazy.hubs, (m) => m.showHub(r.id));
  else if (r.kind === 'downloads') open(lazy.downloads, (m) => m.showDownloads());
  else if (r.kind === 'addonCatalog') open(lazy.addonCatalog, (m) => { addonView = m.showAddonCatalog(detailEl, { addonKey: r.addonKey, type: r.type, catId: r.catId }); });
  else if (r.kind === 'addonFiche') open(lazy.addonFiche, (m) => { addonView = m.showAddonFiche(detailEl, { addonKey: r.addonKey, type: r.type, id: r.id }); });
  else showFiche(r.type, r.id, r.season != null ? { s: r.season, e: r.episode } : null);
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
  if (r && isKidProfile() && (r.kind === 'settings' || r.kind === 'hidden' || r.kind === 'stats' || r.kind === 'friends' || r.kind === 'friend' || r.kind === 'socialprofile' || r.kind === 'list' || r.kind === 'ensemble' || (r.kind === 'tvlive' && !kidSection('tv')) || r.kind === 'calendar' || r.kind === 'shows' || r.kind === 'show' || r.kind === 'collections' || r.kind === 'collection' || r.kind === 'discover' || r.kind === 'downloads' || r.kind === 'hub')) return null;
  if (r && r.kind === 'browse' && !(r.id === 'ai' ? !isKidProfile() : browseAllowed(r.id))) return null;
  // Pages d'addon (catalogue, fiche) : refusées sur le profil enfant, comme le navigateur.
  if (r && (r.kind === 'addonCatalog' || r.kind === 'addonFiche') && isKidProfile()) return null;
  return r;
}

function parseRouteRaw() {
  const h = location.hash || '';
  const fiche = parseFicheHash(h);
  if (fiche) return { kind: 'fiche', ...fiche };
  // Adresse d'un addon (#/addon/<slug>/…) : le slug donne la clé du registre, null si l'addon n'est plus activé (la page le dit).
  const addon = parseAddonHash(h);
  if (addon) {
    const addonKey = resolveAddonSlug(addon.addonSlug);
    return addon.kind === 'catalog'
      ? { kind: 'addonCatalog', addonKey, type: addon.type, catId: addon.catId }
      : { kind: 'addonFiche', addonKey, type: addon.type, id: addon.id };
  }
  let r = /^#\/service\/([a-z0-9-]{1,40})$/.exec(h);
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
  r = /^#\/friend\/([A-Za-z0-9_-]{3,32})$/.exec(h);
  if (r) return { kind: 'friend', id: r[1] };
  if (h === '#/social/profile') return { kind: 'socialprofile' };
  const listId = listIdFrom(h);
  if (listId) return { kind: 'list', id: listId };
  // Lien public d'un titre recommandé : #/t/<code> (ou /t/<code> servi par le Worker), sans session.
  const shareCode = shareCodeFrom(h, '');
  if (shareCode) return { kind: 'sharelink', code: shareCode };
  // Ensemble : #/ensemble[/<onglet>]. L'ancienne adresse #/parties y mène (route() la remplace dans la barre d'adresse).
  if (h === '#/parties') return { kind: 'ensemble', tab: 'maintenant', redirect: '#/ensemble' };
  r = /^#\/ensemble(?:\/([a-z-]{1,20}))?$/.exec(h);
  if (r && (!r[1] || ensembleTabOf(r[1]))) return { kind: 'ensemble', tab: r[1] || 'maintenant' };
  r = /^#\/party\/([A-Za-z0-9_-]{1,64})$/.exec(h);
  if (r) return { kind: 'party', id: r[1] };
  // Invitation d'un invité (sans compte) : #/party/join/<id>?t=<jeton>.
  const join = joinRouteOf(h);
  if (join) return { kind: 'partyjoin', id: join.roomId, token: join.token };
  if (h === '#/settings') return { kind: 'settings' };
  if (h === '#/downloads') return { kind: 'downloads' };
  if (h === '#/admin') return { kind: 'admin' };
  r = /^#\/browse\/([a-z-]{1,20})$/.exec(h);
  if (r) return { kind: 'browse', id: r[1] };
  if (h === '#/search') return { kind: 'search' };
  if (h === '#/calendar') return { kind: 'calendar' };
  if (h === '#/emissions') return { kind: 'shows' };
  r = /^#\/(films|series|documentaires)$/.exec(h);
  if (r) return { kind: 'hub', id: r[1] };
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
  // #/parties est devenue #/ensemble : l'adresse est remplacée (pas d'entrée d'historique en plus) puis la route rejouée.
  if (r && r.redirect) {
    location.replace(r.redirect);
    return;
  }
  if (!r || r.kind !== 'partyjoin') teardownPartyJoin();
  // Amis (#/friends) : la barre latérale s'ouvre par-dessus la page en cours, qui reste affichée.
  if (r && r.kind === 'friends') {
    openSidebar();
    return;
  }
  teardownDownloads(); // téléchargements : abonnement de la vue quittée libéré (la vue suivante se réabonne)
  teardownAddonView(); // page d'addon quittée : défilement et chargements arrêtés
  if (r) {
    stopHomeLive(); // accueil masqué par la vue ouverte : pas de resynchronisation ni d'écouteurs d'accueil pendant ce temps
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
    cancelPendingView(); // retour à l'accueil : une vue encore en chargement ne doit pas s'afficher dessus
    closeModal(true);
    if (!state.inDetail) return;
    startHomeLive(); // accueil de nouveau affiché : resynchronisation et écouteurs repris
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

/** Ouvre la fiche d'un titre ; `ep` ({ season, episode }) : série ouverte sur cet épisode. */
export function openItem(key, opener, ep) {
  const it = state.byKey.get(key);
  if (!it) return;
  go(ficheHash(it.type, it.id, ep), opener);
}

export function goBack() {
  if (state.depth > 0) history.back();
  else location.hash = '#/';
}
