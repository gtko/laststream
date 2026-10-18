/* Laststream : point d'entrée. Interface du prototype portée en modules ES, backend lastAddon.
 * Routes : #/ (accueil), #/movie/{id}, #/tv/{id}, #/person/{id}, #/services, #/service/{slug}, #/library, #/tv-live, #/emissions, #/emission/{id}, #/calendar, #/settings.
 * ?still désactive les aperçus vidéo. */
import './styles/styles.css';
import './styles/app.css';
import './styles/search.css';
import './styles/settings.css';
import './styles/homeprefs.css';
import './styles/player.css';
import './styles/player-ui.css';
import './styles/player-panels.css';
import './styles/player-loading.css';
import './styles/player-mini.css';
import { initAuth, isKidProfile, kidSection } from './data/auth';
import { userStore } from './data/userStore';
import { renderLibrary, renderLibraryPage } from './ui/library.js';
import { applyTheme, readTheme } from './data/theme';
import { runAuthFlow } from './ui/auth-ui.js';
import { needsServerSetup, runServerSetup } from './ui/server-setup.js';
import { app, detailEl } from './ui/dom.js';
import { state } from './ui/state.js';
import { load } from './ui/home.js';
import { parseRoute, showView } from './ui/router.js';
import './ui/events.js';
import './ui/rows.js';
import './ui/ctxmenu.js';
import './ui/hover.js';
import './ui/settings.js';
import './ui/follows.js';
import './ui/rate.js';
import './ui/calendar.js';
import './ui/sources-ui.js';
import { announceShellReady } from './player/shell';
import { servedByLastAddon } from './data/configSync';
import { getSettings, saveSettings } from './data/config';

// Application Android, premier lancement : adresse du serveur lastAddon (sur le PC) avant tout appel réseau.
if (needsServerSetup()) await runServerSetup();
// App Windows (ou toute page servie par lastAddon lui-même) : l'adresse du serveur est l'origine de la page,
// quel que soit le port choisi au démarrage (7000 peut être déjà pris).
if (await servedByLastAddon()) {
  const s = getSettings();
  if (s.base !== location.origin) saveSettings({ ...s, base: location.origin });
}
await initAuth();
// Titres importés résolus en arrière-plan : la bibliothèque se redessine quand ils arrivent.
if (userStore.subscribe) userStore.subscribe(() => { renderLibrary(); if (state.kind === 'library') renderLibraryPage(); });
await runAuthFlow();
if (isKidProfile()) {
  document.body.classList.add('kid-mode');
  if (kidSection('tv')) document.body.classList.add('kid-tv');
}
applyTheme(readTheme()); // après la synchronisation des préférences du profil
state.curHash = location.hash || '';
if (parseRoute()) {
  // Ouverture directe d'une page : l'accueil se charge en arrière-plan.
  state.inDetail = true;
  app.hidden = true;
  detailEl.hidden = false;
  showView(parseRoute());
}
// La coque Windows garde son écran de démarrage jusqu'à `app-ready` : dès que l'accueil est affiché (ou après 8 s au plus).
Promise.resolve(load()).catch(() => undefined).finally(() => { announceShellReady(); });
setTimeout(() => { announceShellReady(); }, 8000);
