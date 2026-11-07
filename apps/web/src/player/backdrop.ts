/* Fond du lecteur : en plein écran, la page derrière est rendue inerte (clavier, lecteurs d'écran, souris) et masquée par le CSS
   (`body.lp-full` / `body.lp-covered`, voir player.css). Tout repose sur l'état plein écran, jamais sur « lecteur ouvert » :
   en miniature la page reste interactive. */
import { isFull, onChange } from './playerState';

/** Restent au-dessus du lecteur (ni inertes ni masqués) : lecteur, fenêtres ouvertes depuis lui, toasts, notes, menus. */
export const OVER_PLAYER = '#lsplayer, #modal, #toast, .toast, .ss, .cvw-root, .cvd-veil, .ctxmenu, .shd-veil, [data-over-player]';
const MARK = 'data-lp-inert';
/** Éléments rendus inertes par nous : relâchés même s'ils ont quitté le document entre-temps. */
const locked = new Set<HTMLElement>();

let observer: MutationObserver | null = null;
let started = false;

function lock(el: Element): void {
  if (!(el instanceof HTMLElement) || el.matches(OVER_PLAYER) || el.hasAttribute('inert')) return;
  el.setAttribute('inert', '');
  el.setAttribute(MARK, '');
  locked.add(el);
}

function unlockAll(): void {
  locked.forEach((el) => { el.removeAttribute('inert'); el.removeAttribute(MARK); });
  locked.clear();
}

/** Le lecteur est opaque : la page derrière peut être masquée. Sans effet hors plein écran. Prévient showVideo (mpv). */
export function markCovered(): void {
  if (!isFull() || document.body.classList.contains('lp-covered')) return;
  document.body.classList.add('lp-covered');
  window.dispatchEvent(new Event('lsplayer:covered'));
}

/** Fondu d'ouverture en cours : lp-covered attend sa fin (ui.js appelle markCovered). */
const entering = (): boolean => !!document.getElementById('lsplayer')?.classList.contains('is-entering');

function sync(): void {
  const full = isFull();
  document.body.classList.toggle('lp-full', full);
  if (!full) document.body.classList.remove('lp-covered');
  else if (!entering()) markCovered();
  if (full) {
    [...document.body.children].forEach(lock);
    if (!observer) {
      observer = new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.parentNode === document.body) lock(n as Element); })));
      observer.observe(document.body, { childList: true });
    }
  } else {
    if (observer) { observer.disconnect(); observer = null; }
    unlockAll();
  }
}

/** À appeler une fois au démarrage ; renvoie l'arrêt (tests). */
export function initBackdrop(): () => void {
  if (started) return () => {};
  started = true;
  const off = onChange(sync);
  sync();
  return () => { off(); started = false; if (observer) { observer.disconnect(); observer = null; } unlockAll(); document.body.classList.remove('lp-full', 'lp-covered'); };
}
