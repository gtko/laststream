/* Lecture réelle des bandes-annonces (API IFrame de YouTube) : suivi de l'état et fondu des textes pendant la lecture. */
import { REDUCE, YT_ORIGIN } from './constants.js';

/** Délai de lecture effective avant le fondu des textes. */
export const FADE_AFTER_MS = 4000;
/** Classe posée sur la zone (fiche, diapositive, carte au survol) quand les textes sont estompés. */
export const QUIET_CLASS = 'is-quiet';
const ACTIVITY = ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'focusin'];

/**
 * Appelle `onInfo(info)` à chaque mise à jour de l'iframe (playerState, currentTime, duration) : abonnement « listening »
 * de l'API IFrame. Renvoie la fonction d'arrêt.
 */
export function watchPlayback(iframe, onInfo) {
  let off = false;
  const onMsg = (e) => {
    if (off || !iframe || !iframe.contentWindow || e.origin !== YT_ORIGIN || e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    const info = d && d.info;
    if (info && typeof info === 'object' && typeof info.playerState === 'number') onInfo(info);
  };
  window.addEventListener('message', onMsg);
  try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN); } catch (_) { /* iframe fermée */ }
  return () => { off = true; window.removeEventListener('message', onMsg); };
}

/**
 * Fondu des textes de `zone` pendant la lecture effective de la bande-annonce de `iframe` : après FADE_AFTER_MS de lecture
 * (état 1), la classe `is-quiet` s'applique. Toute activité dans la zone (souris, clavier, toucher) la retire et relance le
 * délai. Pause ou fin : texte rétabli. Jamais avant le démarrage, jamais avec mouvement réduit.
 * Renvoie la fonction d'arrêt (retire la classe et les écouteurs).
 */
export function textFade(zone, iframe) {
  if (REDUCE || !zone || !iframe) return () => {};
  let playing = false;
  let timer = 0;
  let stopped = false;
  const quiet = (on) => zone.classList.toggle(QUIET_CLASS, on);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; quiet(true); }, FADE_AFTER_MS);
  };
  const onInfo = (info) => {
    const st = info.playerState;
    if (st === 1) {
      if (!playing) { playing = true; arm(); }
      return;
    }
    if (st === 3) return; // mise en mémoire tampon : on attend la suite
    playing = false;
    clearTimeout(timer);
    timer = 0;
    quiet(false);
  };
  const activity = () => {
    if (!playing) return;
    quiet(false);
    arm();
  };
  ACTIVITY.forEach((ev) => zone.addEventListener(ev, activity, { passive: true }));
  const unwatch = watchPlayback(iframe, onInfo);
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    unwatch();
    ACTIVITY.forEach((ev) => zone.removeEventListener(ev, activity));
    zone.classList.remove(QUIET_CLASS);
  };
}
