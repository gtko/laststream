/* Laststream : point d'entrée. Interface du prototype portée en modules ES, backend lastAddon.
 * Routes : #/ (accueil), #/movie/{id}, #/tv/{id}, #/person/{id}, #/services, #/service/{slug}, #/films, #/series, #/documentaires, #/collections[/{catégorie}], #/collection/{id}, #/discover, #/library, #/hidden, #/stats, #/friends, #/friend/{pseudo}, #/ensemble[/{onglet}] (#/parties y redirige), #/party/{id}, #/tv-live, #/emissions, #/emission/{id}, #/calendar, #/settings, #/admin (propriétaire), #/reset/{jeton} (public), #/foyer/{jeton} (invitation au foyer, sans compte).
 * ?still désactive les aperçus vidéo. */
import './demoBoot'; // premier module : en démo, stockage du navigateur remplacé par la mémoire avant toute lecture
import { initSentry } from './observability/sentry';
import { initNativeScreen } from './sources/nativeScreen';
import './styles/styles.css';
import './styles/app.css';
import './styles/calendar.css';
import './styles/search.css';
import './styles/collections.css';
import './styles/settings.css';
import './styles/settings-nav.css';
import './styles/settings-appearance.css';
import './styles/homeprefs.css';
import './styles/social.css';
import './styles/friendRail.css';
import './styles/ensemble.css';
import './styles/evenings.css';
import './styles/homeSocial.css';
import './styles/friendLibrary.css';
import './styles/chat.css';
import './styles/convwin.css';
import './styles/partylobby.css';
import './styles/player.css';
import './styles/player-ui.css';
import './styles/player-panels.css';
import './styles/tv-panels.css';
import './styles/player-loading.css';
import './styles/player-mini.css';
import './styles/notes.css';
import './styles/segment-mark.css';
import './styles/bubble.css';
import './styles/social-player.css';
import './styles/badges.css';
import './styles/shows.css';
import './styles/scrollbars.css';
import './styles/credits.css';
import './styles/downloads.css';
import './styles/downloads-tv.css';
import { auth, initAuth, isKidProfile, kidSection, offlineWithoutSession } from './data/auth';
import { userStore } from './data/userStore';
import { renderLibrary, renderLibraryPage } from './ui/library.js';
import { applyTheme, readTheme } from './data/theme';
import { applyDeviceMode } from './ui/device.js';
import { resetToken, runResetFlow } from './ui/reset-ui.js';
import { ensureServerSetup } from './ui/server-setup.js';
import { app, detailEl, toast } from './ui/dom.js';
import { state } from './ui/state.js';
import { load } from './ui/home.js';
import { parseRoute, showView } from './ui/router.js';
import { startDlBadgeWatch } from './ui/dlBadgeWatch.js';
import { ensureSocial, setSocialLoader, setSocialNotifier } from './ui/socialHooks.js';
import { shareCodeFrom } from './ui/shareModel.js';
import { isPlayerOpen } from './player/sessionLoader.js';
import { parseJoinHash } from './party/join';
import { parseFoyerToken } from './data/foyerLink';
import './ui/events.js';
import './ui/scrollbars.js';
import './ui/focusRing.js';
import './ui/rows.js';
import './ui/ctxmenu.js';
import './ui/hover.js';
import './ui/follows.js';
import './ui/rate.js';
import './ui/calendar.js';
import './ui/sources-ui.js';
import { announceShellReady } from './player/shell';
import { servedByLastAddon } from './data/configSync';
import { setServedOrigin } from './data/serverMode';
import { wipeDeviceDebrid } from './sources/debridWipe';
import { isPurgePending } from './downloads/settings';
import { initUiUpdateBanner, initUpdateBanner } from './ui/update-banner.js';
import { installPreloadReload } from './ui/preloadReload.js';
import { initBackdrop } from './player/backdrop';
import { initTrailersGate } from './ui/trailersGate.js';
import { stripReloadParam } from './data/uiUpdate';
import { initAnnouncementBanner } from './ui/announcement-banner.js';
import { isDemo, setDemoFlags, startDemo } from './data/demo';

initBackdrop(); // lecteur plein écran : fond inerte et masqué (LAST-173)
initTrailersGate(); // …et bandes-annonces coupées pendant la lecture
installPreloadReload(); // fichier d'un chargement à la demande introuvable : un rechargement, pas de boucle
stripReloadParam(); // retire le paramètre `_ls` laissé par un rechargement de mise à jour (la route #/… reste)
initSentry(); // supervision des erreurs (no-op sans VITE_SENTRY_DSN, en dev et en tests)
initNativeScreen(); // Android : résolution réelle de la sortie vidéo pour le plafond automatique (ODY-251)
wipeDeviceDebrid(); // plus aucune clé de débrideur sur l'appareil
// Déconnexion explicite suivie d'un rechargement : la purge des téléchargements du compte précédent se termine ici.
if (isPurgePending()) void import('./downloads/service').then((m) => m.purgeForOwnerChange()).catch(() => undefined);

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
// L'écran de connexion / de choix du profil (auth-ui, avatars, éditeur) n'est chargé que s'il faut l'afficher.
if (!joinPage && !demoMode && (auth.status === 'needs-login' || auth.status === 'needs-profile' || offlineWithoutSession())) await (await import('./ui/auth-ui.js')).runAuthFlow();
if (isKidProfile()) {
  document.body.classList.add('kid-mode');
  if (kidSection('tv')) document.body.classList.add('kid-tv');
}
applyDeviceMode(); // mode TV (ODY-234) : data-device sur <html>
applyTheme(readTheme()); // après la synchronisation des préférences du profil
// Social (amis, discussions, partage, salon d'attente) : chargé quand l'accueil est affiché, ou au premier usage d'un de ses points d'entrée.
setSocialNotifier(toast);
setSocialLoader(() => import('./ui/socialBoot.js').then((m) => m.bootSocial()));
// Pastille des téléchargements en cours (ODY-234) : abonnement permanent, qui démarre le gestionnaire dès le lancement (hors profil enfant).
startDlBadgeWatch();
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
Promise.resolve(joinPage ? undefined : load()).catch(() => undefined).finally(() => {
  announceShellReady();
  // Social : après l'affichage de l'accueil, au repos du navigateur (repli sur une minuterie).
  const bootSocial = () => { void ensureSocial().catch(() => undefined); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(bootSocial, { timeout: 3000 }); else setTimeout(bootSocial, 1500);
});
setTimeout(() => { announceShellReady(); }, 8000);
// Application Android : bannière « Mise à jour disponible » (sans effet ailleurs).
initUpdateBanner();
// Windows et web : bannière « Une nouvelle version est disponible » quand le serveur publie un autre build de l'interface.
initUiUpdateBanner({ isPlayerOpen });
// Annonces publiques : bannière refermable, appel réseau sans bloquer l'affichage (jamais sur #/admin).
initAnnouncementBanner();
