/* Mouvement de l'interface (LAST animations) : retour immédiat au clic et au toucher, apparition des blocs, transitions
 * d'écran et barre de progression de navigation. Tout passe par transform et opacity (composées par le GPU, 60 i/s) et
 * par les propriétés individuelles `scale` / `translate`, qui se cumulent avec les `transform` existants (zoom des
 * affiches, centrage des menus) sans les écraser.
 *
 *  - Appui : léger enfoncement (scale) de tout élément cliquable, proportionné à sa taille, et onde « Material » partant
 *    du point touché. Au toucher, l'onde attend 70 ms : un doigt qui fait défiler une rangée ne déclenche rien.
 *  - Apparition : les blocs (rangées, sections de fiche, grilles) montent en fondu à leur entrée dans l'écran, une fois,
 *    en cascade ; les affiches d'une rangée suivent en décalé (styles/motion.css).
 *  - Images : les affiches apparaissent en fondu une fois chargées, au lieu de « tomber » d'un coup.
 *  - Écran : fondu court du nouvel écran (router.js), barre fine en haut quand une page met du temps à venir.
 *
 * Coupé sous prefers-reduced-motion et sur TV (data-device="tv" : webOS et Android TV, processeurs modestes), où seuls
 * restent les zooms de focus en CSS. */

import '../styles/motion.css'; // après les feuilles du démarrage : elle les complète
import { motionHooks } from './motionHooks.js';

const root = document.documentElement;
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const hasIndividualTransforms = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('scale', '1');

/** Animations riches permises : ni mouvement réduit, ni TV, ni navigateur trop ancien. */
export function motionOn() {
  return !(reduceMq && reduceMq.matches) && root.dataset.device !== 'tv' && hasIndividualTransforms && typeof Element.prototype.animate === 'function';
}

/* Courbes Material 3 : « emphasized decelerate » pour ce qui arrive, « standard » pour le reste. */
export const EASE_OUT = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
const EASE_STD = 'cubic-bezier(0.2, 0, 0, 1)';
/** Retour d'appui avec un très léger rebond. */
const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/* ---------------------------------------------------------------- Appui ---------------------------------------------------------------- */

const PRESSABLE = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], summary, label.set-switch, .card';
/** Pas d'appui animé : champs, curseurs, zones de lecture du lecteur, opt-out explicite. */
const NO_PRESS = '[data-no-press], input, textarea, select, [contenteditable="true"], .lp-seek, .lp-vol, [role="slider"]';
/** Pas d'onde (l'enfoncement reste) : liens dans le texte, opt-out explicite. */
const NO_RIPPLE = '[data-no-ripple]';

/** @param {EventTarget | null} t */
function pressTarget(t) {
  if (!(t instanceof Element)) return null;
  const el = t.closest(PRESSABLE);
  if (!el || el.closest(NO_PRESS) || /** @type {HTMLButtonElement} */ (el).disabled || el.getAttribute('aria-disabled') === 'true') return null;
  return /** @type {HTMLElement} */ (el);
}

/** Enfoncement proportionné : ~6 px sur le plus grand côté, entre 0,92 (petite icône) et 0,985 (grand bloc). */
function pressScale(r) {
  const s = 1 - 6 / Math.max(r.width, r.height, 1);
  return Math.min(0.985, Math.max(0.92, s));
}

/** Hôte de l'onde : la jaquette pour une affiche, sinon l'élément lui-même. */
function rippleHost(el) {
  if (el.classList.contains('card')) return /** @type {HTMLElement | null} */ (el.querySelector('.card-media'));
  return el;
}

/** L'hôte peut-il recevoir une onde positionnée en absolu ? Un élément statique sans enfant positionné passe en relatif. */
function canHostRipple(host) {
  const cs = getComputedStyle(host);
  if (cs.display === 'inline' || cs.display === 'contents' || cs.display === 'none') return false;
  if (cs.position !== 'static') return true;
  for (const c of host.children) {
    const p = getComputedStyle(c).position;
    if (p === 'absolute' || p === 'fixed') return false;
  }
  host.style.position = 'relative';
  return true;
}

/** Onde Material : cercle qui grandit depuis (x, y) ; renvoie la fonction qui l'efface au relâchement. */
function ripple(host, x, y) {
  const r = host.getBoundingClientRect();
  if (r.width < 8 || r.height < 8 || r.width * r.height > 900 * 700) return () => {};
  if (!canHostRipple(host)) return () => {};
  let layer = /** @type {HTMLElement | null} */ (host.querySelector(':scope > .m-ripples'));
  if (!layer) {
    layer = document.createElement('span');
    layer.className = 'm-ripples';
    layer.setAttribute('aria-hidden', 'true');
    host.append(layer);
  }
  const cx = x - r.left;
  const cy = y - r.top;
  const radius = Math.hypot(Math.max(cx, r.width - cx), Math.max(cy, r.height - cy));
  const dot = document.createElement('span');
  dot.className = 'm-ripple';
  dot.style.width = dot.style.height = radius * 2 + 'px';
  dot.style.left = cx - radius + 'px';
  dot.style.top = cy - radius + 'px';
  layer.append(dot);
  const born = performance.now();
  const grow = Math.min(600, 320 + radius * 0.9);
  dot.animate([{ transform: 'scale(0.12)', opacity: 0 }, { opacity: 1, offset: 0.12 }, { transform: 'scale(1)', opacity: 1 }], { duration: grow, easing: EASE_STD, fill: 'forwards' });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // L'onde finit sa course (au moins 40 %) avant de s'effacer : un tap très bref reste visible.
    const wait = Math.max(0, grow * 0.4 - (performance.now() - born));
    setTimeout(() => {
      const fade = dot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'linear', fill: 'forwards' });
      fade.onfinish = () => { dot.remove(); if (layer && !layer.childElementCount) layer.remove(); };
    }, wait);
  };
}

/** @type {null | { el: HTMLElement, id: number, scale: Animation | null, release: () => void, timer: number, x: number, y: number, rippled: boolean }} */
let press = null;

function pressIn(el) {
  const r = el.getBoundingClientRect();
  const s = pressScale(r);
  return el.animate([{ scale: '1' }, { scale: String(s) }], { duration: 110, easing: EASE_STD, fill: 'forwards' });
}

function pressOut(p) {
  if (p.timer) clearTimeout(p.timer);
  if (p.scale) {
    const anim = p.scale;
    const back = p.el.animate([{ scale: String(getComputedStyle(p.el).scale === 'none' ? 1 : getComputedStyle(p.el).scale) }, { scale: '1' }], { duration: 280, easing: EASE_SPRING });
    anim.cancel();
    back.onfinish = () => back.cancel();
  }
  p.release();
}

function startRipple(p) {
  if (p.rippled) return;
  p.rippled = true;
  const host = p.el.closest(NO_RIPPLE) ? null : rippleHost(p.el);
  if (host) p.release = ripple(host, p.x, p.y);
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary || !motionOn()) return;
  const el = pressTarget(e.target);
  if (!el) return;
  if (press) pressOut(press);
  const p = { el, id: e.pointerId, scale: null, release: () => {}, timer: 0, x: e.clientX, y: e.clientY, rippled: false };
  press = p;
  if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
    p.scale = pressIn(el);
    startRipple(p);
  } else {
    // Toucher : on attend de savoir si c'est un tap ou le début d'un défilement (pointercancel annule tout).
    p.timer = window.setTimeout(() => { p.timer = 0; if (press === p) { p.scale = pressIn(el); startRipple(p); } }, 70);
  }
}, { capture: true, passive: true });

function endPress(e, tapped) {
  const p = press;
  if (!p || e.pointerId !== p.id) return;
  press = null;
  // Tap plus court que l'attente : l'onde part quand même, pour confirmer le geste.
  if (tapped && !p.rippled) { p.timer && clearTimeout(p.timer); p.timer = 0; p.scale = pressIn(p.el); startRipple(p); }
  pressOut(p);
}
document.addEventListener('pointerup', (e) => endPress(e, true), { capture: true, passive: true });
document.addEventListener('pointercancel', (e) => endPress(e, false), { capture: true, passive: true });
// Le doigt ou la souris sort franchement de l'élément : on relâche sans attendre.
document.addEventListener('pointermove', (e) => {
  const p = press;
  if (!p || e.pointerId !== p.id) return;
  if (Math.abs(e.clientX - p.x) > 12 || Math.abs(e.clientY - p.y) > 12) {
    if (e.pointerType !== 'mouse') { press = null; pressOut(p); }
  }
}, { capture: true, passive: true });

// Clavier (Entrée / Espace sur un bouton) : onde partie du centre.
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || !motionOn()) return;
  const el = pressTarget(e.target);
  if (!el || el.closest(NO_RIPPLE)) return;
  const host = rippleHost(el);
  if (!host) return;
  const r = host.getBoundingClientRect();
  const release = ripple(host, r.left + r.width / 2, r.top + r.height / 2);
  setTimeout(release, 120);
}, true);

/* ------------------------------------------------------------- Apparition ------------------------------------------------------------- */

/** Blocs qui montent en fondu à leur entrée dans l'écran. */
const REVEAL = [
  '.row-section',
  '.f-sec', '.svc-head', '.hub-title', '.lib-grid > *', '.dl-card', '.set-sec', '.set-card', '.stats-card',
  '.fo-topic', '.fo-cat', '.fo-card', '.ens-card', '.pp-head', '.search-results > *',
].join(', ');
/** Images qui apparaissent en fondu une fois chargées. */
const FADE_IMG = '.card-media > img, .f-bg > img, .pp-photo img, .cast img, .ep img, .up-card img, .sv-tile-media > img';

/** Jusqu'à cet instant, les blocs ajoutés s'affichent tout de suite (retour à l'accueil : rien ne doit « remonter »). */
let quietUntil = 0;
let io = null;
/** Blocs entrés dans le même lot : décalés de 45 ms chacun. */
let batch = 0;
let batchReset = 0;

function revealNow(el, delay) {
  el.style.setProperty('--m-delay', delay + 'ms');
  el.classList.add('m-in');
  el.addEventListener('animationend', function done(ev) {
    if (ev.target !== el) return;
    el.removeEventListener('animationend', done);
    el.classList.remove('m-pre', 'm-in');
    el.style.removeProperty('--m-delay');
  });
  // Filet de sécurité : jamais de bloc resté invisible (onglet en arrière-plan, animation coupée).
  setTimeout(() => { el.classList.remove('m-pre', 'm-in'); }, 1400 + delay);
}

function observer() {
  if (io) return io;
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = /** @type {HTMLElement} */ (en.target);
      io && io.unobserve(el);
      if (!el.classList.contains('m-pre')) continue;
      revealNow(el, Math.min(batch, 6) * 45);
      batch++;
    }
    clearTimeout(batchReset);
    batchReset = window.setTimeout(() => { batch = 0; }, 120);
  }, { threshold: 0 });
  return io;
}

function track(el) {
  if (el.classList.contains('m-pre') || el.dataset.mSeen) return;
  el.dataset.mSeen = '1';
  if (performance.now() < quietUntil) return;
  // Déjà entièrement au-dessus de l'écran (page restaurée plus bas) : pas d'animation.
  el.classList.add('m-pre');
  observer().observe(el);
}

function trackImg(img) {
  if (img.dataset.mImg) return;
  img.dataset.mImg = '1';
  if (img.complete && img.naturalWidth > 0) return; // déjà là (cache) : affichée telle quelle
  img.classList.add('m-img');
  const done = () => { img.classList.add('m-loaded'); img.removeEventListener('load', done); img.removeEventListener('error', fail); };
  const fail = () => { img.classList.remove('m-img'); img.removeEventListener('load', done); img.removeEventListener('error', fail); };
  img.addEventListener('load', done);
  img.addEventListener('error', fail);
}

const SCAN = REVEAL + ', ' + FADE_IMG;
function scan(node) {
  if (!(node instanceof HTMLElement)) return;
  visit(node);
  // Une seule recherche par nœud ajouté (rangée, page entière...) : blocs et images ensemble.
  if (node.firstElementChild) node.querySelectorAll(SCAN).forEach(visit);
}
function visit(el) {
  if (el.tagName === 'IMG') { if (el.matches(FADE_IMG)) trackImg(/** @type {HTMLImageElement} */ (el)); }
  else if (el.matches(REVEAL)) track(el);
}

let mo = null;
function startObserving() {
  if (mo || typeof MutationObserver !== 'function' || typeof IntersectionObserver !== 'function') return;
  mo = new MutationObserver((records) => {
    if (!motionOn()) return;
    for (const rec of records) for (const n of rec.addedNodes) scan(n);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
if (document.body) startObserving(); else document.addEventListener('DOMContentLoaded', startObserving, { once: true });

/** Affiche tout de suite les blocs encore en attente sous `scope` (retour à un écran déjà vu). */
function settle(scope) {
  scope.querySelectorAll('.m-pre').forEach((el) => {
    io && io.unobserve(el);
    el.classList.remove('m-pre', 'm-in');
  });
}

/* ---------------------------------------------------------- Transitions d'écran ---------------------------------------------------------- */

/** Écran qui s'ouvre : fondu court (opacité seule : un `transform` déplacerait les barres fixes de la page). */
export function enterView(el) {
  if (!motionOn() || !el) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE_STD });
}

/** Retour à l'accueil : rien ne remonte, fondu de l'écran seulement. */
export function returnView(el) {
  if (!el) return;
  quietUntil = performance.now() + 600;
  settle(el);
  if (motionOn()) el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 200, easing: EASE_STD });
}

/* ------------------------------------------------------- Barre de progression ------------------------------------------------------- */

let bar = null;
let pending = 0;
let showTimer = 0;
let grow = null;

function barEl() {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.className = 'm-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.append(bar);
  return bar;
}

/** Navigation qui attend un chargement : barre fine en haut après 120 ms. Renvoie la fonction qui la termine. */
export function navProgress() {
  if (!motionOn()) return () => {};
  pending++;
  if (pending === 1) {
    clearTimeout(showTimer);
    showTimer = window.setTimeout(() => {
      const b = barEl();
      b.classList.add('is-on');
      if (grow) grow.cancel();
      grow = b.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(0.35)', offset: 0.2 }, { transform: 'scaleX(0.85)' }], { duration: 6000, easing: 'cubic-bezier(0.1, 0.6, 0.2, 1)', fill: 'forwards' });
    }, 120);
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pending = Math.max(0, pending - 1);
    if (pending) return;
    clearTimeout(showTimer);
    if (!bar || !bar.classList.contains('is-on')) return;
    const b = bar;
    const from = getComputedStyle(b).transform;
    if (grow) { grow.cancel(); grow = null; }
    const fin = b.animate([{ transform: from === 'none' ? 'scaleX(0.85)' : from }, { transform: 'scaleX(1)' }], { duration: 180, easing: EASE_STD, fill: 'forwards' });
    fin.onfinish = () => {
      const out = b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' });
      out.onfinish = () => { if (!pending) b.classList.remove('is-on'); fin.cancel(); out.cancel(); };
    };
  };
}

motionHooks.enterView = enterView;
motionHooks.returnView = returnView;
motionHooks.navProgress = navProgress;
