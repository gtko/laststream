/* Laststream : point d'entrée. Interface du prototype portée en modules ES, backend lastAddon.
 * Routes : #/ (accueil), #/movie/{id}, #/tv/{id}, #/person/{id}, #/services, #/service/{slug}, #/library, #/tv-live, #/settings.
 * ?still désactive les aperçus vidéo. */
import './styles/styles.css';
import './styles/app.css';
import { applyTheme, readTheme } from './data/theme';
import { app, detailEl } from './ui/dom.js';
import { state } from './ui/state.js';
import { load } from './ui/home.js';
import { parseRoute, showView } from './ui/router.js';
import './ui/events.js';
import './ui/rows.js';
import './ui/ctxmenu.js';
import './ui/hover.js';
import './ui/settings.js';
import './ui/sources-ui.js';

applyTheme(readTheme());
state.curHash = location.hash || '';
if (parseRoute()) {
  // Ouverture directe d'une page : l'accueil se charge en arrière-plan.
  state.inDetail = true;
  app.hidden = true;
  detailEl.hidden = false;
  showView(parseRoute());
}
load();
