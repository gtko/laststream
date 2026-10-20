/* Laststream : point d'entrée. Interface du prototype portée en modules ES, backend lastAddon.
 * Routes : #/ (accueil), #/movie/{id}, #/tv/{id}, #/person/{id}, #/services, #/service/{slug}, #/collections[/{catégorie}], #/collection/{id}, #/discover, #/library, #/hidden, #/stats, #/friends, #/friend/{pseudo}, #/parties, #/party/{id}, #/tv-live, #/emissions, #/emission/{id}, #/calendar, #/settings, #/admin (propriétaire), #/reset/{jeton} (public), #/foyer/{jeton} (invitation au foyer, sans compte).
 * ?still désactive les aperçus vidéo. */
import './demoBoot'; // premier module : en démo, stockage du navigateur remplacé par la mémoire avant toute lecture
import { initSentry } from './observability/sentry';
import './styles/styles.css';
import './styles/app.css';
import './styles/search.css';
import './styles/collections.css';
import './styles/settings.css';
import './styles/homeprefs.css';
import './styles/hidden.css';
import './styles/stats.css';
import './styles/social.css';
import './styles/socialProfile.css';
import './styles/chat.css';
import './styles/convwin.css';
import './styles/share.css';
import './styles/partyjoin.css';
import './styles/partylobby.css';
import './styles/player.css';
import './styles/player-ui.css';
import './styles/player-panels.css';
import './styles/tv-panels.css';
import './styles/player-loading.css';
import './styles/player-mini.css';
import './styles/notes.css';
import './styles/bubble.css';
import './styles/social-player.css';
import './styles/badges.css';
import './styles/shows.css';
import './styles/admin.css';
import './styles/scrollbars.css';
import './styles/avatar-studio.css';
import { initAuth, isKidProfile, kidSection } from './data/auth';
import { userStore } from './data/userStore';
import { renderLibrary, renderLibraryPage } from './ui/library.js';
import { applyTheme, readTheme } from './data/theme';
import { runAuthFlow } from './ui/auth-ui.js';
import { resetToken, runResetFlow } from './ui/reset-ui.js';
import { ensureServerSetup } from './ui/server-setup.js';
import { app, detailEl, toast } from './ui/dom.js';
import { state } from './ui/state.js';
import { load } from './ui/home.js';
import { parseRoute, showView } from './ui/router.js';
import { mountSocialSidebar, setConversationRenderer, setWatchWithHandler } from './ui/socialSidebar.js';
import { createConversationRenderer } from './ui/socialChat.js';
import { configureSocialConv } from './ui/socialConv.js';
import './ui/socialProfile.js'; // enregistre openProfileEditor (F2) et la page #/social/profile
import { configureShareDialog } from './ui/shareDialog.js';
import { shareCodeFrom } from './ui/shareModel.js';
import { createWatchWithHandler } from './data/watchWith';
import { playBest } from './player/session.js';
import { parseJoinHash } from './party/join';
import { parseFoyerToken } from './data/foyerLink';
import './ui/events.js';
import './ui/scrollbars.js';
import './ui/focusRing.js';
import './ui/rows.js';
import './ui/ctxmenu.js';
import './ui/hover.js';
import './ui/settings.js';
import './ui/follows.js';
import './ui/rate.js';
import './ui/calendar.js';
import './ui/sources-ui.js';
import './ui/partylobby.js';
import { announceShellReady } from './player/shell';
import { servedByLastAddon } from './data/configSync';
import { setServedOrigin } from './data/serverMode';
import { wipeDeviceDebrid } from './sources/debridWipe';
import { initUpdateBanner } from './ui/update-banner.js';
import { initAnnouncementBanner } from './ui/announcement-banner.js';
import { isDemo, setDemoFlags, startDemo } from './data/demo';

initSentry(); // supervision des erreurs (no-op sans VITE_SENTRY_DSN, en dev et en tests)
wipeDeviceDebrid(); // plus aucune clé de débrideur sur l'appareil

// App Windows (ou toute page servie par lastAddon lui-même) : serveur = origine de la page, quel que soit le port
// choisi au démarrage, sauf si l'utilisateur a choisi un serveur perso. Déclaré avant la résolution du serveur.
if (await servedByLastAddon()) setServedOrigin(location.origin);
// Application Android : serveur Laststream par défaut, écran de saisie seulement s'il ne répond pas (avant tout appel réseau).
// Mode démo (?demo=1 ou #/demo) : catalogue en lecture seule sans compte ; serveur injoignable, retour à la connexion normale.
const demoMode = isDemo() && await startDemo();
// Démo impossible (serveur injoignable) : rechargement sans paramètre démo, connexion normale avec le vrai stockage.
if (isDemo() && !demoMode) {
  setDemoFlags({ on: false, clean: false, profile: '' });
  location.replace(location.origin + location.pathname);
  await new Promise(() => undefined);
}
if (!demoMode) await ensureServerSetup();
// Lien de réinitialisation du mot de passe (#/reset/<jeton>) : page publique, avant toute connexion.
const resetTok = demoMode ? null : resetToken();
if (resetTok) await runResetFlow(resetTok);
// Lien de partage public (/t/<code> ou #/t/<code>) : page sans compte, comme l'invitation d'un salon.
if (!demoMode && !resetTok) {
  const code = shareCodeFrom(location.hash || '', location.pathname || '');
  if (code && !/^#\/t\//.test(location.hash || '')) {
    try { history.replaceState(null, '', location.pathname.replace(/\/t\/[^/]*\/?$/, '/') + location.search + '#/t/' + code); } catch (_) { /* adresse inchangée */ }
  }
}
const sharePage = !demoMode && shareCodeFrom(location.hash || '', '') !== '';
// Invitation au foyer (#/foyer/<jeton>) : page sans compte, comme l'invitation d'un salon.
const foyerTok = demoMode ? null : parseFoyerToken(location.hash || '');
// Invitation d'un salon (#/party/join/<id>?t=<jeton>), lien public ou invitation au foyer : page sans compte, ni /user/me ni écran de connexion.
const joinPage = !demoMode && (parseJoinHash(location.hash || '') !== null || sharePage || foyerTok !== null);
if (!demoMode) await initAuth({ anonymous: joinPage });
// Titres importés résolus en arrière-plan : la bibliothèque se redessine quand ils arrivent.
if (userStore.subscribe) userStore.subscribe(() => { renderLibrary(); if (state.kind === 'library') renderLibraryPage(); });
if (!joinPage && !demoMode) await runAuthFlow();
if (isKidProfile()) {
  document.body.classList.add('kid-mode');
  if (kidSection('tv')) document.body.classList.add('kid-tv');
}
applyTheme(readTheme()); // après la synchronisation des préférences du profil
// Discussion et « Regarder avec lui » : la lecture passe par le flux normal du lecteur (source de l'utilisateur).
const socialLaunch = (request, opener, opts) => playBest(request, opener, opts);
setConversationRenderer(createConversationRenderer({ launch: socialLaunch, toast }));
setWatchWithHandler(createWatchWithHandler({ launch: socialLaunch, toast }));
configureSocialConv({ launch: socialLaunch, toast }); // fenêtres de discussion Social v3 (hooks openConversation / renderConversationList)
configureShareDialog({ toast }); // fenêtre « Partager » Social v3 (hook openShareDialog)
mountSocialSidebar(); // barre des amis, branchée au profil actif ; #/friends l'ouvre
state.curHash = location.hash || '';
const first = parseRoute();
if (first && first.kind !== 'friends') {
  // Ouverture directe d'une page : l'accueil se charge en arrière-plan.
  state.inDetail = true;
  app.hidden = true;
  detailEl.hidden = false;
  showView(first);
}
// Invitation au foyer : écran sans compte dans la vue détail, chargé seulement à l'ouverture de ce lien.
if (foyerTok !== null) {
  state.inDetail = true;
  app.hidden = true;
  detailEl.hidden = false;
  const { mountFoyerJoin } = await import('./ui/foyer-join.js');
  mountFoyerJoin(detailEl, foyerTok);
}
// La coque Windows garde son écran de démarrage jusqu'à `app-ready` : dès que l'accueil est affiché (ou après 8 s au plus).
Promise.resolve(joinPage ? undefined : load()).catch(() => undefined).finally(() => { announceShellReady(); });
setTimeout(() => { announceShellReady(); }, 8000);
// Application Android : bannière « Mise à jour disponible » (sans effet ailleurs).
initUpdateBanner();
// Annonces publiques : bannière refermable, appel réseau sans bloquer l'affichage (jamais sur #/admin).
initAnnouncementBanner();
