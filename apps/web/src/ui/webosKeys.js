/* Télécommande LG (TV et projecteurs webOS, LAST-1643). L'app webOS (apps/webos) déclare disableBackHistoryAPI : la touche
 * Retour (keyCode 461) arrive à la page au lieu d'un retour d'historique automatique. Elle devient une touche Échap, que
 * l'interface sait déjà traiter (fenêtre, panneau, lecteur, page intérieure) ; si personne ne s'en sert, la règle du bouton
 * retour Android s'applique (couche, lecteur, page précédente) et, sur l'accueil, un second appui rend la main à la TV.
 * Les touches média de la télécommande (lecture, pause, stop, avance, retour rapides) portent des keyCode propres à LG :
 * elles sont renvoyées sous leur nom standard (MediaPlay…), que le lecteur reconnaît (player/keys.ts). */
import { isPlayerFull, leavePlayer } from '../player/sessionLoader.js';
import { hasLayers } from './backStack.js';
import { isWebOs } from './device.js';
import { toast } from './dom.js';
import { goBack } from './router.js';
import { state } from './state.js';
import { t } from '../i18n';

export const WEBOS_BACK = 461;
/** keyCode des touches média de la télécommande LG → nom standard de KeyboardEvent.key. */
const MEDIA_KEYS = /** @type {Record<number, string>} */ ({ 415: 'MediaPlay', 19: 'MediaPause', 413: 'MediaStop', 417: 'MediaFastForward', 412: 'MediaRewind' });
/** Délai pendant lequel un second Retour sur l'accueil quitte l'app. */
const EXIT_WINDOW_MS = 2500;

/**
 * Nom standard d'une touche média LG, ou null si la touche n'en est pas une ou porte déjà ce nom.
 * @param {number} keyCode
 * @param {string} key
 */
export function webosMediaKey(keyCode, key) {
  const name = MEDIA_KEYS[keyCode];
  return name && name !== key ? name : null;
}

/**
 * Suite d'un appui sur Retour.
 * @param {{ handled: boolean, layers: boolean, player: boolean, inDetail: boolean, armed: boolean }} s  `handled` : la touche
 *   Échap envoyée à la page a été prise en charge ; `armed` : un premier Retour vient d'être fait sur l'accueil
 * @returns {'none' | 'back' | 'player' | 'page' | 'arm' | 'exit'}
 */
export function webosBackAction(s) {
  if (s.handled) return 'none';
  if (s.layers) return 'back';
  if (s.player) return 'player';
  if (s.inDetail) return 'page';
  return s.armed ? 'exit' : 'arm';
}

/** Rend la main à la TV (l'app reste en arrière-plan), comme le Retour des apps LG ; fermeture de la fenêtre en repli. */
function exitWebOsApp() {
  const w = /** @type {any} */ (window);
  for (const api of [w.webOS, w.PalmSystem]) {
    try {
      if (api && typeof api.platformBack === 'function') { api.platformBack(); return; }
    } catch (_) { /* API absente ou refusée : essai suivant */ }
  }
  window.close();
}

/** Renvoie la touche sous un autre nom, au même élément (événement annulable qui remonte, comme une vraie touche). */
const ours = new WeakSet();
function redispatch(target, key) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true });
  ours.add(ev);
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}

let armedAt = 0;

/** @param {KeyboardEvent} e */
function onKeyDown(e) {
  if (ours.has(e)) return; // nos propres renvois
  const target = document.activeElement || document.body;
  if (e.keyCode === WEBOS_BACK) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const handled = redispatch(target, 'Escape');
    const armed = Date.now() - armedAt < EXIT_WINDOW_MS;
    const a = webosBackAction({ handled, layers: hasLayers(), player: isPlayerFull(), inDetail: !!state.inDetail, armed });
    armedAt = 0;
    if (a === 'back') history.back();
    else if (a === 'player') leavePlayer();
    else if (a === 'page') goBack();
    else if (a === 'exit') exitWebOsApp();
    else if (a === 'arm') { armedAt = Date.now(); toast(t('Appuie encore sur Retour pour quitter Laststream')); }
    return;
  }
  const media = webosMediaKey(e.keyCode, e.key);
  if (!media) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  redispatch(target, media);
}

let started = false;

/** Branche la télécommande LG ; sans effet hors webOS. Écoute en capture sur window : avant les écouteurs du document. */
export function startWebOsKeys() {
  if (started || !isWebOs()) return;
  started = true;
  window.addEventListener('keydown', onKeyDown, true);
}
