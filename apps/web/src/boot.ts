/* Entrée de l'interface (index.html) : charge la langue (catalogue de traduction, LAST-1658) avant tout le reste, traduit
 * les textes figés de index.html, puis charge l'application (main.js). Ainsi `t()` est prêt dès l'évaluation des modules,
 * constantes comprises. En français (langue source), aucun catalogue n'est chargé. Un échec laisse l'interface en français. */
import { initI18n } from './i18n';
import { translateStatic } from './i18n/dom';

initI18n()
  .then(() => translateStatic())
  .catch(() => undefined)
  .finally(() => import('./main.js'));
