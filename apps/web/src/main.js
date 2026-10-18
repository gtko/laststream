/* Laststream : point d'entrée. Interface du prototype portée en modules ES, backend lastAddon.
 * Routes : #/ (accueil), #/movie/{id}, #/tv/{id}, #/person/{id}, #/services, #/service/{slug}, #/library, #/tv-live, #/settings.
 * ?still désactive les aperçus vidéo. */
import './styles/styles.css';
import './styles/app.css';
import './styles/player.css';
import './styles/player-ui.css';
import './styles/player-panels.css';
import './styles/player-loading.css';
import { initAuth, isKidProfile, kidSection } from './data/auth';
import { userStore } from './data/userStore';
import { renderLibrary, renderLibraryPage } from './ui/library.js';
import { applyTheme, readTheme } from './data/theme';
import { runAuthFlow } from './ui/auth-ui.js';
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
