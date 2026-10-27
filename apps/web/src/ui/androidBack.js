/* Bouton retour Android (APK Capacitor, LAST-499). Avec le plugin App, le système ne gère plus le retour dès qu'un écouteur
 * existe : une couche ouverte (modale, feuille, menu, lecteur TV) se ferme, une page intérieure revient à la précédente, et sur
 * l'accueil l'app passe en arrière-plan comme le ferait Android. Sans le plugin (APK plus ancien), rien n'est branché. */
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { isPlayerFull, leavePlayer } from '../player/sessionLoader.js';
import { hasLayers } from './backStack.js';
import { goBack } from './router.js';
import { state } from './state.js';

/**
 * @param {{ layers: boolean, player: boolean, inDetail: boolean, canGoBack: boolean }} s  `player` : lecteur film/série affiché en
 *   grand (il ne pose pas d'entrée d'historique)
 * @returns {'back' | 'player' | 'page' | 'exit'} `back` : retour de l'historique (ferme la couche du dessus) ; `player` : quitte
 *   le lecteur (miniature ou fermeture) ; `page` : page précédente de l'app ; `exit` : comportement système (arrière-plan)
 */
export function androidBackAction(s) {
  if (s.layers && s.canGoBack) return 'back';
  if (s.player) return 'player';
  if (s.inDetail) return 'page';
  return 'exit';
}

export function startAndroidBack() {
  try {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('App')) return;
  } catch (_) { return; }
  void App.addListener('backButton', (e) => {
    const a = androidBackAction({ layers: hasLayers(), player: isPlayerFull(), inDetail: !!state.inDetail, canGoBack: !!(e && e.canGoBack) });
    if (a === 'back') history.back();
    else if (a === 'player') leavePlayer();
    else if (a === 'page') goBack();
    else void App.minimizeApp().catch(() => {});
  });
}
