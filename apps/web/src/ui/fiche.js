/* Port du prototype (voir tools/port-prototype.mjs). */
import { stopInfinite } from './infinite.js';
import { followBtn } from './follows.js';
import { ficheRateHTML } from './rate.js';
import { userStore } from '../data/userStore';
import { isHiddenKey } from '../data/homeFilters';
import { isKidProfile, isServerMode, kidMaxAge } from '../data/auth';
import { kidAllows } from '../data/kid';
import { clearAmbient } from './heroVideo.js';
import { getRegion } from '../data/prefs';
import { IMG, REDUCE } from './constants.js';
import { countdown, isFuture } from './dates.js';
import { detailEl } from './dom.js';
import { fetchFull } from './ficheModel.js';
import { inProgressRef } from './epFocus.js';
import { fillCollection, fillNext, fillRatings, fillWhy, loadSeason } from './ficheSections.js';
import { topBar } from './fragments.js';
import { heroVideoSetup, heroVideoStop } from './heroVideo.js';
import { ICON } from './icons.js';
import { inLib } from './library.js';
import { fillProviders } from './providers.js';
import { ratingList } from './ratings.js';
import { applyRestore } from './router.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { tv } from './tv.js';
import { esc, fmtDate, fmtMin, plural, store } from './util.js';

let ficheIO = null;
// ---------- Fiche : rendu ----------
export const sec = (id, title, inner, extra) =>
  '<section class="f-sec" id="' + id + '" aria-labelledby="' + id + '-h"' + (extra || '') + '>' +
  '<h2 class="f-sec-title" id="' + id + '-h">' + title + '</h2>' + inner + '</section>';

export function ratingsHTML(m, r) {
  return ratingList(r, m.vote ? m.vote * 10 : 0);
}

export function metaLine(m) {
  const out = [];
  if (m.year) out.push('<li>' + esc(m.year) + '</li>');
  if (m.cert) out.push('<li><span class="cert-badge" title="Classification ' + esc(getRegion().label) + '">' + esc(m.cert) + '</span></li>');
  if (m.type === 'tv') {
    const parts = [];
    if (m.nSeasons) parts.push(plural(m.nSeasons, 'saison', 'saisons'));
    if (m.nEpisodes) parts.push(plural(m.nEpisodes, 'épisode', 'épisodes'));
    if (parts.length) out.push('<li>' + parts.join(' · ') + '</li>');
    if (m.minutes) out.push('<li>' + fmtMin(m.minutes) + ' / épisode</li>');
  } else if (m.minutes) {
    out.push('<li>' + fmtMin(m.minutes) + '</li>');
  }
  if (m.genres.length) out.push('<li>' + esc(m.genres.slice(0, 3).join(' · ')) + '</li>');
  return out.join('');
}

export const personLink = (p) =>
  '<a href="#/person/' + esc(p.id) + '" data-person="' + esc(p.id) + '">' + esc(p.name) + '</a>';

export const TAB_DEFS = { eps: 'Épisodes', sim: 'Similaires', cast: 'Casting', extras: 'Bonus', coll: 'Collection', infos: 'Infos' };

export function tabsFor(m) {
  const t = [];
  if (m.type === 'tv' && m.seasons.length) t.push('eps');
  if (m.cast.length) t.push('cast');
  if (m.videos.length) t.push('extras');
  if (m.collection) t.push('coll');
  if (m.recs.length) t.push('sim');
  t.push('infos');
  return t;
}

// Prochain épisode à regarder, d'après les épisodes marqués « vus » (localStorage).
export function nextToWatch(m) {
  if (m.type !== 'tv' || !m.seasons.length) return null;
  const seasons = m.seasons.filter((s) => s.season_number > 0);
  const list = seasons.length ? seasons : m.seasons;
  const seen = new Set(userStore.watchedEpisodes(m.key).map((x) => x.season + ':' + x.episode));
  const today = new Date().toISOString().slice(0, 10);
  let last = null;
  for (const s of list) {
    if (s.air_date && s.air_date > today) continue; // saison pas encore diffusée
    for (let e = 1; e <= (s.episode_count || 0); e++) {
      last = { s: s.season_number, e };
      if (!seen.has(s.season_number + ':' + e)) return { s: s.season_number, e, resume: seen.size > 0 };
    }
  }
  if (!seen.size) return { s: list[0].season_number, e: 1, resume: false };
  return last ? { s: last.s, e: last.e, resume: true } : { s: list[0].season_number, e: 1, resume: false };
}

export function playText(m) {
  const n = nextToWatch(m);
  return n ? (n.resume ? 'Reprendre · ' : 'Lecture ') + 'S' + n.s + ' É' + n.e : 'Lecture';
}

export const isUnreleased = (m) => isFuture(m.releaseFR);
export const getRemind = () => store('ls_remind') || [];
export function remindBtn(m, cls, extra) {
  const on = getRemind().includes(m.key);
  return '<button type="button" class="' + cls + '" data-remind aria-pressed="' + on + '"' + (extra || '') + '>' + (on ? ICON.check : ICON.bell) +
    '<span class="f-play-label">' + (on ? 'Rappel activé' : 'Me rappeler') + '</span></button>';
}
export function primaryBtn(m) {
  if (m.cinemaSince) return followBtn(m.key, 'btn btn-primary btn-pill is-cinema', '', 'Me prévenir de la sortie en VOD');
  return isUnreleased(m)
    ? remindBtn(m, 'btn btn-primary btn-pill')
    : '<button type="button" class="btn btn-primary btn-pill" data-play>' + ICON.play + '<span class="f-play-label">' + esc(playText(m)) + '</span></button>';
}

export function updatePlayLabel(m) {
  if (isUnreleased(m)) return;
  detailEl.querySelectorAll('.f-play-label').forEach((el) => { el.textContent = playText(m); });
}

export function markNext(m) {
  const list = detailEl.querySelector('#f-eplist');
  if (!list) return;
  list.querySelectorAll('.ep.is-next').forEach((el) => el.classList.remove('is-next'));
  const n = nextToWatch(m);
  if (!n) return;
  const card = list.querySelector('.ep[data-ep="' + n.s + ':' + n.e + '"]');
  if (card) card.classList.add('is-next');
  return card;
}

export function ficheHeroShell(m, it) {
  const bgPath = m ? m.backdropPath : it && it.backdropPath;
  const bgSrc = m ? IMG('original', bgPath) : it ? it.backdrop : '';
  const fb = m ? IMG('w1280', bgPath) : '';
  return '<div class="f-bg' + (bgSrc ? '' : ' no-img') + '">' +
    (bgSrc ? '<img src="' + esc(bgSrc) + '" alt=""' + (fb ? ' data-fb="' + esc(fb) + '"' : '') + ' fetchpriority="high" decoding="async">' : '') +
    '</div><div class="f-scrim" aria-hidden="true"></div>';
}


export function ficheSkeleton(it) {
  return topBar(false) +
    '<article class="fiche is-loading" aria-busy="true" tabindex="-1" aria-label="' + esc(it ? it.name : 'Chargement de la fiche') + '">' +
    ficheHeroShell(null, it) +
    '<section class="f-first"><div class="f-info"><p class="sr-only" role="status">Chargement de la fiche…</p>' +
    '<span class="sk sk-title"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span>' +
    '<span class="sk sk-para"></span><span class="sk sk-para"></span>' +
    '<div class="f-actions"><span class="sk sk-btn"></span><span class="sk sk-round"></span><span class="sk sk-round"></span></div></div></section>' +
    '</article>';
}

export const fsec = (name, title, inner) =>
  '<section class="f-sec" id="f-p-' + name + '" aria-labelledby="f-p-' + name + '-h"><h2 class="f-sec-title" id="f-p-' + name + '-h">' + title + '</h2>' + inner + '</section>';

/** « Watch party » : compte connecté, titre sorti (les profils enfants ne créent que des salons privés, dans la boîte de dialogue). */
const partyBtn = (m) => (isServerMode() && !isUnreleased(m) && !m.cinemaSince
  ? '<button type="button" class="btn-round" data-wparty data-tip="Regarder en watch party" aria-label="Regarder en watch party">' + ICON.users + '</button>' : '');

export const libBtn = (m) => {
  const on = inLib(m.key);
  return '<button type="button" class="btn-round' + (on ? ' is-on' : '') + '" data-lib aria-pressed="' + on + '" data-tip="' + (on ? 'Dans ta bibliothèque' : 'Ajouter à ma bibliothèque Laststream') +
    '" aria-label="' + (on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream') + '">' + (on ? ICON.check : ICON.list) + '</button>';
};

/** « Ne plus proposer » : bouton discret, retire le titre de l'accueil (réglable depuis les réglages du profil). */
// Bouton à bascule : libellé fixe, état porté par aria-pressed (« Réafficher » quand le titre est masqué).
const hideBtn = (m) => {
  if (isKidProfile()) return '';
  const hidden = isHiddenKey(m.key);
  return '<button type="button" class="btn btn-ghost btn-sm home-hide' + (hidden ? ' is-on' : '') + '" data-hide-title aria-pressed="' + hidden + '">' +
    'Ne plus proposer sur l’accueil</button>';
};

const watchBtn = (m) => {
  const on = userStore.isWatched(m.key);
  return '<button type="button" class="btn-round' + (on ? ' is-on' : '') + '" data-watch-movie aria-pressed="' + on + '" data-tip="' + (on ? 'Vu (cliquer pour retirer)' : 'Marquer comme vu') +
    '" aria-label="' + (on ? 'Marqué comme vu (retirer)' : 'Marquer comme vu') + '">' + ICON.check + '</button>';
};

export function ficheHTML(m) {
  const tabs = tabsFor(m);
  const seasonN = (nextToWatch(m) || {}).s;

  const title = m.logo
    ? '<h1 class="f-title" id="f-title" tabindex="-1"><img class="logo-img f-logo" src="' + esc(m.logo) + '" alt="' + esc(m.name) + '" data-logo="' + esc(m.name) + '"></h1>'
    : '<h1 class="f-title" id="f-title" tabindex="-1"><span class="title-text">' + esc(m.name) + '</span></h1>';

  const info =
    '<div class="f-info">' + title +
    '<ul class="meta f-meta">' + metaLine(m) + '</ul>' +
    (m.cinemaSince ? '<p class="f-release"><span>Au cinéma</span> depuis le <strong>' + esc(fmtDate(m.cinemaSince)) + '</strong> · pas encore disponible en streaming</p>' : '') +
    (isUnreleased(m) ? '<p class="f-release"><span>Prochainement</span> Sortie le <strong>' + esc(fmtDate(m.releaseFR)) + '</strong> · ' + esc(countdown(m.releaseFR)) + '</p>' : '') +
    '<ul class="rates" id="f-rates" aria-label="Notes"></ul>' +
    '<div class="f-prov" id="f-prov" data-nav></div>' +
    '<div class="f-syn" data-nav><p class="f-ov">' + esc(m.overview || 'Pas de synopsis disponible.') + '</p>' +
    (m.overview.length > 150 ? '<button type="button" class="link-btn" data-more>Plus</button>' : '') + '</div>' +
    '<div class="f-why glass" id="f-why" hidden><p class="f-why-head">Pourquoi tu vas aimer <span class="ia-tag">IA</span></p>' +
    '<p class="f-why-text" id="f-why-text"></p></div>' +
    '<div class="f-actions" id="f-actions" data-nav>' +
    primaryBtn(m) +
    (m.trailer
      ? '<button type="button" class="btn-round" data-vid="' + esc(m.trailer) + '"' + (m.trailerVO ? ' data-vo="1"' : '') + ' data-vtitle="Bande-annonce" data-tip="Bande-annonce" aria-label="Bande-annonce">' + ICON.film + '</button>'
      : '') +
    libBtn(m) +
    partyBtn(m) +
    (m.type === 'movie' ? watchBtn(m) : '') +
    (m.cinemaSince
      ? '<button type="button" class="btn-round" data-sources-open data-tip="Voir les sources" aria-label="Voir les sources">' + ICON.list + '</button>' // sur demande seulement : aucune vérification automatique
      : followBtn(m.key, 'btn-round')) +
    hideBtn(m) +
    '</div><div class="f-rate" id="f-rate" data-nav>' + ficheRateHTML(m) + '</div></div>';

  const panels = [];
  if (tabs.includes('eps')) {
    panels.push(fsec('eps', 'Épisodes',
      '<div class="f-eps-head"><div class="pills" data-nav role="group" aria-label="Saison">' + m.seasons.map((s) =>
        '<button type="button" class="pill" data-season="' + s.season_number + '" aria-pressed="' + (s.season_number === seasonN) + '">' +
        esc(s.season_number === 0 ? 'Bonus' : 'Saison ' + s.season_number) + '</button>').join('') + '</div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-season-watch>Marquer la saison comme vue</button>' +
      '<span class="ep-menu-wrap"><button type="button" class="btn btn-ghost btn-sm ep-more" data-eps-menu aria-haspopup="menu" aria-expanded="false" aria-label="Plus d’actions sur la série">…</button>' +
      '<span class="ep-menu glass" role="menu" hidden><button type="button" role="menuitem" data-series-watch="1">Marquer toute la série comme vue</button>' +
      '<button type="button" role="menuitem" data-series-watch="0">Marquer toute la série comme non vue</button></span></span>' +
      '<span class="f-newcount" id="f-newcount" hidden></span>' +
      '<p class="f-next" id="f-next"></p></div>' +
      '<ol class="row eps" id="f-eplist" data-nav aria-live="polite"><li class="sk sk-ep"></li><li class="sk sk-ep"></li><li class="sk sk-ep"></li></ol>'));
  }
  if (tabs.includes('cast')) {
    panels.push(fsec('cast', 'Casting', '<ul class="cast-row" data-nav>' + m.cast.map((p) =>
      '<li><a class="cast" href="#/person/' + esc(p.id) + '" data-person="' + esc(p.id) + '">' +
      '<span class="cast-ph' + (p.photo ? '' : ' no-img') + '">' + (p.photo ? '<img src="' + esc(p.photo) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async">' : '') +
      '<span class="cast-ini" aria-hidden="true">' + esc(p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')) + '</span></span>' +
      '<span class="cast-name">' + esc(p.name) + '</span><span class="cast-role">' + esc(p.role) + '</span></a></li>').join('') + '</ul>'));
  }
  if (tabs.includes('extras')) {
    panels.push(fsec('extras', 'Bandes-annonces et bonus', '<ul class="vid-row" data-nav>' + m.videos.map((v) =>
      '<li><button type="button" class="vid" data-vid="' + esc(v.key) + '"' + (v.vo ? ' data-vo="1"' : '') + ' data-vtitle="' + esc(v.label) + '" aria-label="' + esc(v.label + ' : ' + v.name) + '">' +
      '<span class="vid-th"><img src="https://img.youtube.com/vi/' + encodeURIComponent(v.key) + '/hqdefault.jpg" alt="" loading="lazy" decoding="async">' +
      '<span class="vid-play" aria-hidden="true">' + ICON.play + '</span></span>' +
      '<span class="vid-type">' + esc(v.label) + '</span><span class="vid-name">' + esc(v.name) + '</span></button></li>').join('') + '</ul>'));
  }
  if (tabs.includes('coll')) panels.push(fsec('coll', 'Collection', '<div class="row f-posters" id="f-coll" data-nav><span class="sk sk-card"></span><span class="sk sk-card"></span><span class="sk sk-card"></span></div>'));
  if (tabs.includes('sim')) panels.push(fsec('sim', 'Titres similaires', '<div class="row f-posters" data-nav>' + m.recs.map((it) => posterCard(it)).join('') + '</div>'));
  panels.push(fsec('infos', 'Infos', infosHTML(m)));

  return topBar(true) +
    '<article class="fiche" aria-labelledby="f-title" data-key="' + esc(m.key) + '">' + ficheHeroShell(m, null) +
    '<section class="f-first" aria-label="Présentation">' + info + '</section>' +
    '<div class="f-panels">' + panels.join('') + '</div></article>' +
    '<div class="f-sticky" id="f-sticky" aria-hidden="true"><span class="f-sticky-title">' + esc(m.name) + '</span>' +
    (m.cinemaSince ? followBtn(m.key, 'btn btn-primary', ' tabindex="-1"', 'Me prévenir de la sortie en VOD') : isUnreleased(m) ? remindBtn(m, 'btn btn-primary', ' tabindex="-1"') : '<button type="button" class="btn btn-primary" data-play tabindex="-1">' + ICON.play + '<span class="f-play-label">' + esc(playText(m)) + '</span></button>') + '</div>';
}

export function infosHTML(m) {
  const rows = [];
  const money = (n) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  if (m.original && m.original !== m.name) rows.push(['Titre original', m.original]);
  if (m.countries.length) rows.push(['Pays', m.countries.join(', ')]);
  if (m.origLang) rows.push(['Langue originale', m.origLang]);
  if (m.spoken.length > 1) rows.push(['Langues audio', m.spoken.join(', ')]);
  const studios = m.type === 'tv' ? m.networks : m.companies;
  if (studios.length) rows.push([m.type === 'tv' ? 'Chaînes' : 'Studios', studios.join(', ')]);
  if (m.type === 'tv' && m.companies.length) rows.push(['Production', m.companies.slice(0, 3).join(', ')]);
  if (m.type === 'movie' && m.budget) rows.push(['Budget', money(m.budget)]);
  if (m.type === 'movie' && m.revenue) rows.push(['Recettes', money(m.revenue)]);
  if (m.releaseFR) rows.push([m.type === 'tv' ? 'Première diffusion' : 'Sortie en France', fmtDate(m.releaseFR)]);
  if (m.type === 'tv' && m.lastAir) rows.push(['Dernière diffusion', fmtDate(m.lastAir)]);
  if (m.status) rows.push(['Statut', m.status]);

  const creditsRows = [];
  if (m.directors.length) creditsRows.push([m.type === 'tv' ? 'Création' : 'Réalisation', m.directors.map(personLink).join(', ')]);
  if (m.writers.length) creditsRows.push(['Scénario', m.writers.map(personLink).join(', ')]);
  if (m.cast.length) creditsRows.push(['Avec', m.cast.slice(0, 6).map(personLink).join(', ')]);

  return '<div class="f-infos-wrap"><div class="f-infos-text"><h3 class="f-sub">Synopsis</h3>' +
    (m.tagline ? '<p class="f-tagline">' + esc(m.tagline) + '</p>' : '') +
    '<p class="f-ov-full">' + esc(m.overview || 'Pas de synopsis disponible.') + '</p>' +
    (creditsRows.length ? '<dl class="f-credits">' + creditsRows.map((r) => '<div><dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd></div>').join('') + '</dl>' : '') +
    '</div>' +
    (rows.length ? '<div><h3 class="f-sub">Détails</h3><dl class="f-infos">' +
      rows.map((r) => '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('') + '</dl></div>' : '') +
    '<p class="f-attrib">Disponibilités : JustWatch via TMDB</p></div>';
}

export function ficheError(type, id) {
  return topBar(false) +
    '<article class="fiche f-error" tabindex="-1"><div class="state" role="alert"><p>Cette fiche n’a pas pu être chargée.</p>' +
    '<div class="f-actions"><button type="button" class="btn btn-primary" data-fretry="' + esc(type + ':' + id) + '">Réessayer</button>' +
    '<button type="button" class="btn btn-ghost" data-back>Retour</button></div></div></article>';
}

export function scrollToSection(name) {
  const el = detailEl.querySelector('#f-p-' + name);
  if (el) el.scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'start' });
}
export function teardownFiche() {
  stopInfinite();
  clearAmbient();
  if (state.svcIO) state.svcIO.disconnect();
  state.svcIO = null;
  if (tv.io) tv.io.disconnect();
  detailEl.classList.remove('is-ambient', 'is-scrolled');
  state.model = null;
  state.token++;
  heroVideoStop();
  if (ficheIO) ficheIO.disconnect();
  ficheIO = null;
}

export function setupSticky() {
  const bar = detailEl.querySelector('#f-sticky');
  const actions = detailEl.querySelector('#f-actions');
  if (!bar || !actions || !('IntersectionObserver' in window)) return;
  ficheIO = new IntersectionObserver((entries) => {
    const out = !entries[0].isIntersecting && entries[0].boundingClientRect.top < 0;
    bar.classList.toggle('is-on', out);
    bar.setAttribute('aria-hidden', String(!out));
    bar.querySelector('button').tabIndex = out ? 0 : -1;
  }, { threshold: 0 });
  ficheIO.observe(actions);
}

export async function showFiche(type, id) {
  const key = type + ':' + id;
  teardownFiche();
  state.kind = 'fiche';
  const token = state.token;
  state.ficheKey = key;
  state.ficheName = '';
  const it = state.byKey.get(key) || null;
  detailEl.innerHTML = ficheSkeleton(it);
  document.title = (it ? it.name + ' · ' : '') + 'Laststream';
  const shell = detailEl.querySelector('.fiche');
  if (shell) shell.focus({ preventScroll: true });
  let m;
  try {
    [m] = await Promise.all([fetchFull(type, id, { server: true }), Promise.resolve(userStore.loadWatched && userStore.loadWatched(key)).catch(() => undefined)]);
    if (isKidProfile() && !kidAllows(m.certRaw, kidMaxAge())) throw new Error('profil enfant');
  } catch (_) {
    if (token !== state.token) return;
    detailEl.innerHTML = ficheError(type, id);
    const err = detailEl.querySelector('.fiche');
    if (err) err.focus({ preventScroll: true });
    return;
  }
  if (token !== state.token) return;
  state.ficheName = m.name;
  detailEl.innerHTML = ficheHTML(m);
  document.title = m.name + ' · Laststream';
  const h1 = detailEl.querySelector('#f-title');
  if (h1) h1.focus({ preventScroll: true });
  state.model = m;
  observeTiles(detailEl);
  applyRestore();
  setupSticky();
  heroVideoSetup(m);
  fillRatings(m, token);
  fillProviders(m, token);
  fillWhy(m, token);
  if (m.collection) fillCollection(m, token);
  if (m.type === 'tv') {
    fillNext(m, token);
    const n = inProgressRef(m.key) || nextToWatch(m);
    if (n) loadSeason(m, n.s, token);
  }
}
