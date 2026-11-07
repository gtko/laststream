/* Quand la bande-annonce passe en grand (classe `is-quiet` posée par playback.js sur la zone : #detail de la fiche ou
   diapositive de l'accueil), le logo du titre (ou le titre texte) descend et se réduit au-dessus du bouton principal.
   Technique FLIP : on mesure les rectangles à l'état naturel, on en tire un décalage (--f-qx, --f-qy) posé sur le titre ;
   le CSS (styles.css) anime `transform` seulement. */
import { QUIET_CLASS } from './playback.js';

/** Écart entre le bas du logo réduit et le haut du bouton principal. */
export const QUIET_GAP_PX = 12;
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const SETTLE_MS = 600;

/** Fiche : titre, bouton principal (Lecture, ou « Me prévenir » d'un titre pas encore jouable) et bloc d'infos. */
const FICHE = { title: '.f-info .f-title', anchor: '.f-actions > .btn-primary', box: '.f-info' };
/** Diapositive de l'accueil. */
export const HERO_QUIET = { title: '.hero-title', anchor: '.hero-actions > .btn-primary', box: '.hero-content' };

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
 * Branche l'animation sur `zone` ; `sel` donne les sélecteurs du titre, du bouton et du bloc qui les contient. Le titre
 * et le bouton sont relus à chaque mesure : le contenu du bloc peut être réécrit (diapositive rafraîchie).
 * Renvoie la fonction d'arrêt (null si la zone n'a ni titre ni bouton).
 */
export function quietGlide(zone, sel) {
  const box = zone && zone.querySelector(sel.box);
  if (!box || !box.querySelector(sel.title) || !box.querySelector(sel.anchor)) return null;
  const ac = new AbortController();
  let timer = 0;
  let stopped = false;
  const title = () => zone.querySelector(sel.title);
  const apply = () => {
    const t = title();
    const a = zone.querySelector(sel.anchor);
    if (stopped || !t || !a) return;
    const { dx, dy } = quietOffset(t, a);
    t.style.setProperty('--f-qx', px(dx));
    t.style.setProperty('--f-qy', px(dy));
  };
  const quiet = () => zone.classList.contains(QUIET_CLASS);
  const settle = (on) => {
    clearTimeout(timer);
    const t = title();
    if (!t) return;
    if (reduced()) {
      t.style.transition = 'none';
      t.style.willChange = '';
      return;
    }
    t.style.removeProperty('transition');
    if (on !== undefined) {
      t.style.willChange = 'transform'; // seulement pendant la transition
      timer = setTimeout(() => { t.style.willChange = ''; }, SETTLE_MS);
    }
  };
  let was = quiet();
  const mo = new MutationObserver((records) => {
    // Contenu réécrit (diapositive rafraîchie) : nouveau titre à mesurer.
    if (records.some((r) => r.type === 'childList')) apply();
    const now = quiet();
    if (now === was) return;
    was = now;
    settle(now);
  });
  mo.observe(zone, { attributes: true, attributeFilter: ['class'] });
  mo.observe(box, { childList: true });
  // Mesure par offset* (non affecté par la transformation en cours) : aucune bascule de transform, l'animation n'est pas coupée.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(apply);
    ro.observe(title());
    ro.observe(box); // le bouton suit la hauteur du bloc ; la zone n'est pas observée (sa taille varie pendant la transition)
  }
  window.addEventListener('resize', apply, { signal: ac.signal });
  settle();
  apply();
  return () => {
    if (stopped) return;
    stopped = true;
    ac.abort();
    mo.disconnect();
    if (ro) ro.disconnect();
    clearTimeout(timer);
    const t = title();
    if (t) {
      t.style.removeProperty('--f-qx');
      t.style.removeProperty('--f-qy');
      t.style.removeProperty('transition');
      t.style.willChange = '';
    }
  };
}

/** Fiche affichée dans `zone` ; remplace l'installation précédente. */
export function ficheQuietSetup(zone) {
  ficheQuietStop();
  ctl = quietGlide(zone, FICHE);
}

export function ficheQuietStop() {
  if (!ctl) return;
  const stop = ctl;
  ctl = null;
  stop();
}
