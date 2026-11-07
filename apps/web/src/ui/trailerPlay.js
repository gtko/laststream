/* Fiche uniquement : la bande-annonce se lance, puis enchaîne sur la lecture (réglage « Lancer automatiquement après la
   bande-annonce »). Ni le héros de l'accueil ni la carte au survol n'utilisent ce module. */
import { isKidProfile } from '../data/auth';
import { getTrailerAutoplay } from '../data/prefs';
import { prefetchSources } from '../sources/load';
import { isPlayerOpen, playBest } from '../player/sessionLoader.js';
import { detailEl, modal } from './dom.js';
import { watchPlayback } from './playback.js';
import { postYT } from './preview.js';

/** Recherche silencieuse des sources, après l'ouverture de la fiche. */
export const PREFETCH_MS = 10000;
/** Compte à rebours affiché pendant les dernières secondes de la bande-annonce. */
export const COUNTDOWN_S = 5;
/** Fondu avant le lecteur. */
export const HANDOFF_MS = 600;
// Toute interaction annule l'enchaînement (défilement inclus, voir onScroll).
const CANCEL_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
const SCROLL_TOLERANCE_PX = 8;

/** Réglage du profil : activé par défaut, désactivé par défaut pour les profils enfants. */
export const autoPlayOn = () => getTrailerAutoplay(isKidProfile());

/**
 * Pilote d'un enchaînement pour une fiche. `request` : cible de lecture (celle du bouton « Lecture ») ; `opener` : élément
 * qui ouvre le lecteur ; `alive()` : la fiche affichée est toujours celle-ci.
 * start() à l'affichage de la fiche, attach(iframe) quand la bande-annonce est montée, stop() au départ de la fiche.
 */
export function createTrailerPlay({ request, opener, alive }) {
  let timer = 0;
  let cancelled = false;
  let done = false;
  let startY = 0;
  let listening = false;
  let unwatch = null;
  let iframe = null;
  let countdown = null;

  // Pas de lancement si la fiche a changé, si un lecteur ou un mini-lecteur est ouvert, ou si une fenêtre est affichée.
  const canRun = () => alive() && !isPlayerOpen() && modal.hidden;

  const onInteract = () => cancel();
  const onScroll = () => { if (Math.abs(window.scrollY - startY) > SCROLL_TOLERANCE_PX) cancel(); };
  const listen = () => {
    if (listening) return;
    listening = true;
    CANCEL_EVENTS.forEach((ev) => window.addEventListener(ev, onInteract, { capture: true, passive: true }));
    window.addEventListener('scroll', onScroll, { passive: true });
  };
  const unlisten = () => {
    if (!listening) return;
    listening = false;
    CANCEL_EVENTS.forEach((ev) => window.removeEventListener(ev, onInteract, { capture: true }));
    window.removeEventListener('scroll', onScroll);
  };

  const hideCountdown = () => {
    if (countdown) { countdown.remove(); countdown = null; }
  };
  function cancel() {
    if (cancelled || done) return;
    cancelled = true;
    clearTimeout(timer);
    timer = 0;
    unlisten();
    hideCountdown();
  }

  const prefetch = () => {
    timer = 0;
    if (cancelled || done || document.hidden || !canRun()) return;
    prefetchSources(request); // recherche seule : aucun déblocage de lien avant le démarrage
  };

  const showCountdown = (left) => {
    if (!countdown) {
      countdown = document.createElement('div');
      countdown.className = 'f-next-up';
      countdown.setAttribute('role', 'status');
      countdown.innerHTML = '<span class="f-next-txt"></span><button type="button" class="btn btn-ghost btn-sm" data-autocancel>Annuler</button>';
      countdown.querySelector('[data-autocancel]').addEventListener('click', cancel);
      (detailEl.querySelector('.f-first') || detailEl).appendChild(countdown);
    }
    countdown.querySelector('.f-next-txt').textContent = 'Lecture dans ' + left + ' s';
  };

  const handoff = () => {
    if (cancelled || done) return;
    if (!canRun()) { stop(); return; }
    done = true;
    clearTimeout(timer);
    timer = 0;
    unlisten();
    hideCountdown();
    detailEl.classList.add('is-handoff');
    setTimeout(() => {
      const end = () => detailEl.classList.remove('is-handoff');
      if (!alive()) { end(); return; }
      Promise.resolve(playBest(request, opener, { resume: 'auto' })).then(end, end);
    }, HANDOFF_MS);
  };

  const onInfo = (info) => {
    if (done) return;
    if (info.playerState === 0) {
      if (cancelled) {
        // Annulée : la bande-annonce reboucle, comme avant le réglage.
        if (iframe) { postYT(iframe, 'seekTo', [0, true]); postYT(iframe, 'playVideo'); }
        return;
      }
      handoff();
      return;
    }
    if (cancelled || info.playerState !== 1 || typeof info.duration !== 'number' || typeof info.currentTime !== 'number') return;
    const left = info.duration - info.currentTime;
    if (left > 0 && left <= COUNTDOWN_S && canRun()) showCountdown(Math.max(1, Math.ceil(left)));
  };

  function stop() {
    cancelled = true;
    done = true;
    clearTimeout(timer);
    timer = 0;
    unlisten();
    hideCountdown();
    if (unwatch) { unwatch(); unwatch = null; }
    iframe = null;
  }

  return {
    start() {
      startY = window.scrollY;
      listen();
      timer = setTimeout(prefetch, PREFETCH_MS);
    },
    attach(el) {
      if (unwatch) unwatch();
      iframe = el;
      unwatch = watchPlayback(el, onInfo);
    },
    stop,
  };
}
