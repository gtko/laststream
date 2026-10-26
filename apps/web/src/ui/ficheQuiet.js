/* Fiche : quand la bande-annonce passe en grand (classe `is-quiet` posée par playback.js sur #detail), le logo du titre
   (ou le titre texte) descend et se réduit au-dessus du bouton principal. Technique FLIP : on mesure les rectangles à
   l'état naturel, on en tire un décalage (--f-qx, --f-qy) ; le CSS (styles.css) anime `transform` seulement. */
import { QUIET_CLASS } from './playback.js';

/** Écart entre le bas du logo réduit et le haut du bouton principal. */
export const QUIET_GAP_PX = 12;
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const SETTLE_MS = 600;

let ctl = null;

const reduced = () => !!(window.matchMedia && window.matchMedia(REDUCED_QUERY).matches);
const px = (n) => Math.round(n * 100) / 100 + 'px';

/** Position d'un élément dans le document par offsetLeft/offsetTop : insensible aux transformations (contrairement à getBoundingClientRect). */
function pagePos(el) {
  let x = 0, y = 0;
  for (let n = el; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
  return { x, y };
}

/** Décalage (dx, dy) qui amène le coin bas gauche du titre à GAP au-dessus du coin haut gauche du bouton, à l'état naturel. */
function quietOffset(title, anchor) {
  const t = pagePos(title);
  const a = pagePos(anchor);
  return { dx: a.x - t.x, dy: Math.max(0, a.y - QUIET_GAP_PX - (t.y + title.offsetHeight)) };
}

/**
 * Branche l'animation sur la fiche affichée dans `zone` ; remplace l'installation précédente. Le bouton principal est
 * `.f-actions > .btn-primary` (Lecture, ou « Me prévenir » d'un titre pas encore jouable).
 */
export function ficheQuietSetup(zone) {
  ficheQuietStop();
  const title = zone && zone.querySelector('.f-info .f-title');
  const anchor = zone && zone.querySelector('.f-actions > .btn-primary');
  const info = title && title.closest('.f-info');
  if (!title || !anchor || !info) return;
  const ac = new AbortController();
  const me = { ac, timer: 0 };
  ctl = me;
  const apply = () => {
    const { dx, dy } = quietOffset(title, anchor);
    title.style.setProperty('--f-qx', px(dx));
    title.style.setProperty('--f-qy', px(dy));
  };
  const quiet = () => zone.classList.contains(QUIET_CLASS);
  // Mesure par offset* (non affecté par la transformation en cours) : aucune bascule de transform, l'animation n'est pas coupée.
  const remeasure = () => { if (ctl === me) apply(); };
  const settle = (on) => {
    clearTimeout(me.timer);
    if (reduced()) {
      title.style.transition = 'none';
      title.style.willChange = '';
      return;
    }
    title.style.removeProperty('transition');
    if (on !== undefined) {
      title.style.willChange = 'transform'; // seulement pendant la transition
      me.timer = setTimeout(() => { title.style.willChange = ''; }, SETTLE_MS);
    }
  };
  let was = quiet();
  const mo = new MutationObserver(() => {
    const now = quiet();
    if (now === was) return;
    was = now;
    settle(now);
  });
  mo.observe(zone, { attributes: true, attributeFilter: ['class'] });
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(remeasure);
    ro.observe(title);
    ro.observe(info); // le bouton suit la hauteur de .f-info ; #detail n'est pas observé (sa taille varie pendant la transition)
  }
  window.addEventListener('resize', remeasure, { signal: ac.signal });
  ac.signal.addEventListener('abort', () => {
    mo.disconnect();
    if (ro) ro.disconnect();
    clearTimeout(me.timer);
    title.style.removeProperty('--f-qx');
    title.style.removeProperty('--f-qy');
    title.style.removeProperty('transition');
    title.style.willChange = '';
  });
  settle();
  apply();
}

export function ficheQuietStop() {
  if (!ctl) return;
  const c = ctl;
  ctl = null;
  c.ac.abort();
}
