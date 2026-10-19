/* Mise en avant de l'accueil : carrousel des tendances de la semaine (fondu enchaîné, pastilles numérotées, flèches, clavier). */
import { userStore } from '../data/userStore';
import { keepVisible, onHomeChange } from '../data/homeFilters';
import { playTitle } from './ctxmenu.js';
import { getRegion } from '../data/prefs';
import { detailOf, getDetail } from './catalog.js';
import { IMG, REDUCE } from './constants.js';
import { modal } from './dom.js';
import { heroEmpty, infoBtn, titleEl, trailerBtn } from './fragments.js';
import { ICON } from './icons.js';
import { cancelDwell, setupPreviews, stopPreview } from './preview.js';
import { metaHTML, ratingList } from './ratings.js';
import { state } from './state.js';
import { esc } from './util.js';
import { intentTimer } from './intent.js';

export const HERO_MS = 10000;
export const HERO_MAX = 8;

const playBtn = (it) => {
  const resume = userStore.continueWatching(50).find((p) => p.key === it.key);
  const code = resume && resume.type === 'tv' && resume.season != null ? ' S' + resume.season + ' · É' + resume.episode : '';
  return '<button type="button" class="btn btn-primary" data-heroplay="' + esc(it.key) + '">' + ICON.play + '<span>' + (resume ? 'Reprendre' + code : 'Lecture') + '</span></button>';
};

/** Note TMDB de repli (en pourcentage) quand MDBList ne fournit pas la note. */
const tmdbFallback = (it) => (it.vote ? Number(it.vote.replace(',', '.')) * 10 : 0);

/** Contenu d'une diapositive : badge, titre ou logo, méta, notes, fournisseurs, synopsis, boutons. */
export function heroContentHTML(it, eyebrow) {
  const d = detailOf(it);
  const overview = d.overview || it.overview || '';
  return '<span class="eyebrow">' + esc(eyebrow || 'Tendance cette semaine') + '</span>' +
    titleEl(it, d, 'hero-title') +
    '<ul class="meta">' + metaHTML(it, d) + '</ul>' +
    (d.note ? '<p class="hero-note">' + esc(d.note) + '</p>' : '') +
    '<ul class="rates rates-hero" aria-label="Notes">' + ratingList(d.ratings, tmdbFallback(it)) + '</ul>' +
    (d.providers && d.providers.length
      ? '<div class="prov-mini" aria-label="Disponible en streaming ' + getRegion().where + '">' + d.providers.map((l) =>
        '<img src="' + esc(l.logo) + '" alt="' + esc(l.name) + '" title="' + esc(l.name) + '" width="32" height="32">').join('') + '</div>' : '') +
    '<p class="clamp-3 hero-desc">' + esc(overview) + '</p>' +
    '<div class="hero-actions">' + playBtn(it) + trailerBtn(it, d).replace('btn btn-primary', 'btn btn-ghost') + infoBtn(it) + '</div>';
}

const rankLabel = (it) => (it.heroRank ? 'Tendance n°' + it.heroRank + (it.heroKind ? ' · ' + it.heroKind : ' cette semaine') : 'Tendance cette semaine');

function slideHTML(it, eyebrow, current, first) {
  return '<div class="hero-slide' + (current ? ' is-current' : '') + '" data-slide-key="' + esc(it.key) + '"' + (current ? '' : ' inert') + '>' +
    '<div class="hero-bg" data-media="' + esc(it.key) + '">' +
    '<img src="' + esc(IMG('w1280', it.backdropPath)) + '" alt="" data-fb="' + esc(it.backdrop) + '"' + (first ? ' fetchpriority="high"' : ' loading="lazy"') + ' decoding="async"></div>' +
    '<div class="scrim" aria-hidden="true"></div>' +
    '<div class="hero-content">' + heroContentHTML(it, eyebrow) + '</div></div>';
}

/** Mise en avant d'un seul titre (profil enfant). */
export function heroA(it, eyebrow) {
  if (!it) return heroEmpty();
  return '<section class="hero" aria-label="À la une">' + slideHTML(it, eyebrow, true, true) + '</section>';
}

/** Carrousel des tendances ; un seul titre se comporte comme une mise en avant simple. */
export function heroCarousel(items) {
  if (!items || !items.length) return heroEmpty();
  if (items.length === 1) return heroA(items[0], rankLabel(items[0]));
  const n = items.length;
  return '<section class="hero hero-carousel" aria-roledescription="carrousel" aria-label="À la une" tabindex="0" data-hero>' +
    items.map((it, i) => slideHTML(it, rankLabel(it), i === 0, i === 0)).join('') +
    '<button type="button" class="hero-arrow prev" data-hero-step="-1" tabindex="-1" aria-label="Titre précédent">' + ICON.back + '</button>' +
    '<button type="button" class="hero-arrow next" data-hero-step="1" tabindex="-1" aria-label="Titre suivant">' + ICON.chev + '</button>' +
    '<div class="hero-dots" role="group" aria-label="Choisir un titre">' +
    items.map((it, i) => '<button type="button" class="hero-dot' + (i === 0 ? ' is-current' : '') + '" data-hero-go="' + i + '" aria-label="' + esc(it.name + ', ' + (i + 1) + ' sur ' + n) + '"' + (i === 0 ? ' aria-current="true"' : '') + '>' + (i + 1) + '</button>').join('') +
    '</div></section>';
}

// ---------- Comportement ----------
const hero = { el: null, items: [], i: 0, timer: null, hover: false, focus: false };

const slides = () => (hero.el ? Array.from(hero.el.querySelectorAll('.hero-slide')) : []);

function paused() {
  return hero.hover || hero.focus || document.hidden || !!state.preview || !modal.hidden || state.inDetail || REDUCE;
}

function schedule(ms) {
  clearTimeout(hero.timer);
  hero.timer = null;
  if (!hero.el || REDUCE) return;
  hero.timer = setTimeout(tick, ms == null ? HERO_MS : ms);
}

function tick() {
  if (!hero.el || !hero.el.isConnected) return;
  if (paused()) { schedule(1000); return; } // la minuterie reprend dès que les conditions de pause disparaissent
  go(hero.i + 1, true);
}

/** Précharge le fond (et le logo, s'il est connu) de la diapositive suivante. */
function preloadNext() {
  const next = hero.items[(hero.i + 1) % hero.items.length];
  if (!next) return;
  [IMG('w1280', next.backdropPath), detailOf(next).logo].filter(Boolean).forEach((src) => { const im = new Image(); im.src = src; });
  getDetail(next);
}

// Notes MDBList : seulement après un survol stable de la mise en avant (500 ms), jamais à l'affichage (le quota est partagé).
const ratings = intentTimer();
/** Mise en avant simple (profil enfant) : son titre, et l'élément qui la contient pour suivre le survol. */
let single = null;
let root = null;

/** Titre dont les notes sont demandées : la diapositive affichée, ou la mise en avant simple. */
const shownItem = () => (hero.el ? hero.items[hero.i] : single);

/** Notes MDBList de la diapositive affichée ; seule la liste des notes de cette diapositive est remplacée. */
function rateNow(it) {
  if (!it) return;
  getDetail(it, { ratings: true }).then((d) => {
    const slide = Array.from(document.querySelectorAll('#app .hero-slide')).find((s) => s.dataset.slideKey === it.key);
    const list = slide && slide.querySelector('.rates-hero');
    if (d && list) list.innerHTML = ratingList(d.ratings, tmdbFallback(it));
  });
}

function armRatings() {
  ratings.arm(() => rateNow(shownItem()));
}

/** Détail TMDB du titre affiché (logo, synopsis, bande-annonce) : immédiat, sans MDBList. */
function loadDetail(it) {
  if (it) getDetail(it).catch(() => null);
}

/** Mise en avant simple (profil enfant) : détail TMDB tout de suite, notes MDBList au survol seulement. */
export function prepareSingle(it) {
  single = it || null;
  root = single ? document.querySelector('#app .hero') : null;
  loadDetail(single);
}

export function go(index, auto) {
  const n = hero.items.length;
  if (!hero.el || n < 2) return;
  const next = ((index % n) + n) % n;
  if (next === hero.i && auto !== 'force') { schedule(); return; }
  stopPreview();
  cancelDwell();
  hero.i = next;
  slides().forEach((s, k) => {
    s.classList.toggle('is-current', k === next);
    if (k === next) s.removeAttribute('inert'); else s.setAttribute('inert', '');
  });
  hero.el.querySelectorAll('.hero-dot').forEach((d, k) => {
    d.classList.toggle('is-current', k === next);
    if (k === next) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current');
  });
  setupPreviews(); // la bande-annonce après inactivité concerne la diapositive courante
  preloadNext();
  loadDetail(hero.items[next]);
  ratings.cancel(); // notes de la diapositive précédente : inutiles désormais
  if (hero.hover) armRatings();
  schedule();
}

/** Les détails (logo, notes, bande-annonce) arrivent après le premier rendu : on met la diapositive à jour. */
/** Retire une diapositive (titre pas encore sorti dans la région). */
function dropSlide(key) {
  const i = hero.items.findIndex((x) => x.key === key);
  if (i < 0 || hero.items.length < 2) return;
  const wasCurrent = i === hero.i;
  hero.items.splice(i, 1);
  const s = hero.el.querySelectorAll('.hero-slide')[i];
  if (s) s.remove();
  hero.el.querySelectorAll('.hero-dot')[i]?.remove();
  hero.el.querySelectorAll('.hero-dot').forEach((dot, k) => { dot.textContent = String(k + 1); dot.dataset.heroGo = String(k); });
  if (hero.i > i || hero.i >= hero.items.length) hero.i = Math.max(0, hero.i - 1);
  if (wasCurrent) go(hero.i, 'force');
}

export function refreshSlide(key) {
  const s = hero.el && hero.el.querySelector('.hero-slide[data-slide-key="' + key.replace(/"/g, '\\"') + '"]');
  const it = hero.items.find((x) => x.key === key);
  if (!s || !it) return;
  if (detailOf(it).released === false) { dropSlide(key); return; }
  s.querySelector('.hero-content').innerHTML = heroContentHTML(it, rankLabel(it));
}

export function stopHero() {
  clearTimeout(hero.timer);
  hero.timer = null;
  hero.el = null;
  hero.hover = false; // un rendu neuf sous le pointeur : la prochaine entrée doit relancer le compte à rebours
  ratings.cancel();
  single = null;
  root = null;
}

/** À appeler après chaque rendu de l'accueil. */
export function initHero(items) {
  stopHero();
  const el = document.querySelector('#app [data-hero]');
  if (!el) { prepareSingle(items && items[0]); return; } // titre unique : mise en avant simple, sans carrousel
  Object.assign(hero, { el, items, i: 0, hover: false, focus: false });
  root = el;
  items.slice(0, 2).forEach((it) => { if (detailOf(it).released === false) dropSlide(it.key); });
  items.slice(2).forEach((it) => getDetail(it).then((d) => { if (d) refreshSlide(it.key); }));
  preloadNext();
  loadDetail(hero.items[hero.i]);
  schedule();
}

export const currentHeroItem = () => hero.items[hero.i] || null;

/** Retire de la mise en avant les titres devenus vus, masqués ou aux genres bannis (sans rechargement). */
export function dropHiddenSlides() {
  if (!hero.el) return;
  const visible = new Set(keepVisible(hero.items).map((x) => x.key));
  hero.items.filter((x) => !visible.has(x.key)).forEach((x) => dropSlide(x.key));
}
onHomeChange(dropHiddenSlides);

document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const inside = !!root && root.isConnected && e.target instanceof Element && root.contains(e.target);
  if (inside && !hero.hover) armRatings(); // entrée dans la mise en avant : les notes attendent 500 ms de survol stable
  if (!inside) ratings.cancel();
  hero.hover = inside;
});
document.addEventListener('mouseleave', () => { hero.hover = false; ratings.cancel(); });
document.addEventListener('focusin', (e) => { hero.focus = !!(hero.el && e.target instanceof Element && hero.el.contains(e.target)); });
document.addEventListener('focusout', (e) => {
  if (hero.el && !(e.relatedTarget instanceof Element && hero.el.contains(e.relatedTarget))) hero.focus = false;
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && hero.el) schedule(1000); });

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const play0 = t && t.closest('[data-heroplay]');
  if (play0 && !(hero.el && hero.el.contains(t))) { e.preventDefault(); e.stopPropagation(); playTitle(play0.dataset.heroplay, play0, false); return; }
  if (!t || !hero.el || !hero.el.contains(t)) return;
  const play = t.closest('[data-heroplay]');
  if (play) { e.preventDefault(); e.stopPropagation(); playTitle(play.dataset.heroplay, play, false); return; }
  const step = t.closest('[data-hero-step]');
  if (step) { e.preventDefault(); e.stopPropagation(); go(hero.i + Number(step.dataset.heroStep), true); return; }
  const dot = t.closest('[data-hero-go]');
  if (dot) { e.preventDefault(); e.stopPropagation(); go(Number(dot.dataset.heroGo), true); }
}, true);

document.addEventListener('keydown', (e) => {
  if (!hero.el || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  const t = e.target;
  if (!(t instanceof Element) || !hero.el.contains(t) || t.closest('input, textarea, select')) return;
  e.preventDefault();
  go(hero.i + (e.key === 'ArrowRight' ? 1 : -1), true);
});

// Fin de la bande-annonce de la diapositive affichée (preview.js) : titre suivant, avec ou sans le son.
document.addEventListener('trailerend', (e) => {
  if (hero.el && e.target instanceof Element && hero.el.contains(e.target)) go(hero.i + 1, true);
});

// Balayage tactile.
let touchX = null;
document.addEventListener('touchstart', (e) => {
  touchX = hero.el && e.target instanceof Element && hero.el.contains(e.target) ? e.touches[0].clientX : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (touchX == null || !hero.el) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) go(hero.i + (dx < 0 ? 1 : -1), true);
}, { passive: true });
