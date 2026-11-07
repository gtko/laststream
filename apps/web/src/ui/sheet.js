/* Feuille de dialogue (LAST-199, lot B) : feuille basse sur mobile (< 768 px), modale centrée sur ordinateur. Sert la planification
 * d'une soirée, ses confirmations et la feuille « Regarder avec… ». `role="dialog"` + `aria-modal`, focus piégé, Échap et clic
 * sur le voile ferment (sauf pendant un appel : `locked()`), le focus revient au déclencheur. Une seule feuille à la fois. */
import { onEveningsReset } from '../data/eveningsStore';
import { esc } from './util.js';
import { pushLayer } from './backStack.js';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** @type {{ close: (silent?: boolean) => void } | null} */
let current = null;
let seq = 0;

const visible = (/** @type {Element} */ el) => !el.closest('[hidden]');

/**
 * @param {{ title: string, html: string, cls?: string, opener?: Element | null, locked?: () => boolean,
 *   initialFocus?: string, onClose?: () => void }} o  `html` : contenu déjà échappé par l'appelant.
 * @returns {{ el: HTMLElement, close: (silent?: boolean) => void, readonly closed: boolean }}
 */
export function openSheet(o) {
  if (current) current.close(true);
  const id = 'sh-t-' + ++seq;
  const opener = o.opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const veil = document.createElement('div');
  veil.className = 'sh-veil';
  const box = document.createElement('div');
  box.className = 'sh' + (o.cls ? ' ' + o.cls : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', id);
  box.tabIndex = -1;
  // eslint-disable-next-line no-restricted-syntax -- gabarit de l'appelant, données dynamiques échappées par esc
  box.innerHTML = '<span class="sh-grab" aria-hidden="true"></span><h2 class="sh-title" id="' + id + '">' + esc(o.title) + '</h2>' + o.html;
  veil.append(box);
  document.body.append(veil);
  let closed = false;
  // Changer de page (retour Android, lien) ou de profil ferme la feuille : elle ne doit ni survivre à son contexte ni écrire pour un autre profil.
  const onHash = () => close(true);
  window.addEventListener('hashchange', onHash);
  const offReset = onEveningsReset(() => close(true));
  const scrollWas = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const locked = () => !!(o.locked && o.locked());
  // Retour du téléphone : ferme la feuille (même pendant un appel, la page ne change pas pour autant).
  const releaseBack = pushLayer(() => close());

  /** @param {boolean} [silent] sans rendre le focus (navigation en cours ou autre feuille qui s'ouvre) */
  function close(silent) {
    if (closed) return;
    closed = true;
    if (current === handle) current = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', onHash);
    releaseBack();
    offReset();
    document.body.style.overflow = scrollWas;
    veil.remove();
    if (!silent) {
      const back = opener && opener.isConnected ? opener : document.querySelector('#ens-title');
      if (back instanceof HTMLElement) back.focus({ preventScroll: true });
    }
    if (o.onClose) o.onClose();
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (closed) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!locked()) close();
    } else if (e.key === 'Tab') {
      const f = Array.from(box.querySelectorAll(FOCUSABLE)).filter((x) => x instanceof HTMLElement && x.tabIndex >= 0 && visible(x));
      if (!f.length) { e.preventDefault(); box.focus(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      const a = document.activeElement;
      if (!box.contains(a) || a === box) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil && !locked()) close(); });
  box.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-sheet-close]') : null;
    if (t && !locked()) close();
  });

  const handle = { el: box, close, get closed() { return closed; } };
  current = handle;
  const first = (o.initialFocus && box.querySelector(o.initialFocus)) || box.querySelector(FOCUSABLE) || box;
  if (first instanceof HTMLElement) first.focus({ preventScroll: true });
  return handle;
}
