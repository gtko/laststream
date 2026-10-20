/* Émissions TV : page #/emissions, fiche d'une émission (#/emission/{id}), rangées d'accueil « Émissions du moment »
 * et « Ce soir à la TV ». Les données viennent de TMDB et du guide TV (voir data/showsApi.ts). */
import { isKidProfile } from '../data/auth';
import { loadGuide, loadMoreShows, loadShows, pastEpisodes, showDetail } from '../data/showsApi';
import { airingsFor, dayLabel, foldText, hhmm, isLiveNow, localDate, matchKnown, primeTime, progressPct, seedFor } from '../data/shows';
import { playBest } from '../player/session.js';
import { register, toItem } from './catalog.js';
import { GENRE_FR, IMG } from './constants.js';
import { detailEl } from './dom.js';
import { ficheHeroShell, ficheSkeleton, teardownFiche } from './fiche.js';
import { STATUS_FR } from './ficheModel.js';
import { followBtn } from './follows.js';
import { svcError, topBar } from './fragments.js';
import { ICON } from './icons.js';
import { openPlayer } from './player.js';
import { fetchProviders, providersHTML } from './providers.js';
import { go } from './router.js';
import { state } from './state.js';
import { fallbackHTML } from './typo.js';
import { normChannel, tv } from './tv.js';
import { esc, fmtMin } from './util.js';

const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
const nowSec = () => Math.floor(Date.now() / 1000);

/** Libellé court de la prochaine diffusion : « En direct · TF1 », « Aujourd’hui 21:10 · TF1 ». */
export function airingLabel(a, now) {
  const chan = a.channel.name;
  return isLiveNow(a, now) ? 'En direct · ' + chan : dayLabel(a.start, now) + ' ' + hhmm(a.start) + ' · ' + chan;
}

/** Ligne de sous-titre d'une carte d'émission. */
export function showSub(s, now) {
  if (s.airings.length) return airingLabel(s.airings[0], now);
  if (s.next && s.next.date) return (s.platform ? s.platform + ' · ' : '') + 'épisode le ' + shortDate(s.next.date);
  return s.platform || 'Émission';
}

/** Image d'une émission du guide : seulement une adresse web (le guide peut en fournir de relatives ou vides). */
const guideImg = (u) => (/^https?:\/\//.test(u || '') ? u : '');

/** Carte « Émissions du moment » : affiche 2:3 comme les autres rangées de posters, titre et diffusion dessous.
 * Émission du guide sans affiche : son image au guide (rognée en 2:3), sinon le fond typographique. */
export function showCard(s, now) {
  const live = s.airings.length && isLiveNow(s.airings[0], now);
  const sub = showSub(s, now);
  const src = s.epg ? guideImg(s.icon) : IMG('w342', s.poster);
  return '<button type="button" class="card tile show-card" data-showopen="' + esc(s.id) + '" aria-label="' + esc(s.name + ', ' + sub) + '">' +
    '<span class="card-media' + (src ? '' : ' no-img') + '">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async"' + (s.epg ? ' style="object-fit:cover"' : '') + '>' : '') +
    fallbackHTML({ name: s.name, type: 'tv' }) +
    (live ? '<span class="t-badge show-live" aria-hidden="true">En direct</span>' : '') + '</span>' +
    '<span class="card-title" aria-hidden="true">' + esc(s.name) + '</span><span class="card-meta" aria-hidden="true">' + esc(sub) + '</span></button>';
}

// ---------- Rangées d'accueil ----------
async function renderShowsRow() {
  const slot = document.getElementById('shows-slot');
  if (!slot) return;
  const { shows } = await loadShows();
  const now = nowSec();
  const today = localDate(now);
  const in14 = localDate(now + 14 * 86400);
  const items = shows.filter((s) => s.airings.length || (s.next && s.next.date >= today && s.next.date <= in14)).slice(0, 20);
  const fresh = document.getElementById('shows-slot');
  if (!fresh || !items.length) return;
  fresh.innerHTML = '<section class="row-section" id="emissions" aria-labelledby="h-emissions"><h2 class="row-title" id="h-emissions">Émissions du moment ' +
    '<a class="row-link" href="#/emissions" data-showsnav>Toutes les émissions</a></h2>' + '<div class="row" data-nav>' + items.map((s) => showCard(s, now)).join('') + '</div></section>';
}

/**
 * Carte « Ce soir à la TV » : paysage 16:9 (même gabarit que « Reprendre la lecture »). Image : fond TMDB de l'émission
 * si elle est connue, sinon image du guide, sinon fond typographique. Chaîne en haut à gauche, heure et durée en grand,
 * titre et genre en bas ; « En direct » et progression si l'émission est en cours à `now` (secondes).
 */
export function tonightTile(a, known, now) {
  const live = isLiveNow(a, now);
  const img = known && known.backdrop ? IMG('w780', known.backdrop) : a.icon || '';
  const ch = a.channel;
  const dur = fmtMin(Math.round((a.stop - a.start) / 60));
  const attrs = known ? ' data-showopen="' + esc(known.id) + '"' : ch.playId ? ' data-showwatch="' + esc(ch.playId) + '"' : ' data-showsnav';
  const label = [a.title, ch.name, hhmm(a.start)].join(', ') + (live ? ', en direct' : '');
  const chan = '<span class="tn-chan">' + (ch.num ? '<b class="ch-num">' + esc(String(ch.num)) + '</b>' : '') +
    (ch.logo ? '<img class="tn-logo" src="' + esc(ch.logo) + '" alt="" loading="lazy" decoding="async">' : '<span class="tn-name">' + esc(ch.name) + '</span>') + '</span>';
  return '<button type="button" class="card tile tile-land show-card tonight-card' + (live ? ' is-live' : '') + (known ? '' : ' is-epg') + '"' + attrs + ' aria-label="' + esc(label) + '">' +
    '<span class="card-media' + (img ? '' : ' no-img') + '">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: a.title, type: 'tv' }) +
    '<span class="t-shade" aria-hidden="true"></span>' + chan +
    (live ? '<span class="t-badge show-live" aria-hidden="true">En direct</span>' : '') +
    '<span class="tn-info" aria-hidden="true"><span class="tn-when"><strong class="tn-time">' + hhmm(a.start) + '</strong>' +
    (dur ? '<span class="tn-dur">' + esc(dur) + '</span>' : '') + '</span>' +
    '<span class="tn-title">' + esc(a.title) + '</span>' + (a.category ? '<span class="tn-sub">' + esc(a.category) + '</span>' : '') + '</span>' +
    (live ? '<span class="progress" aria-hidden="true"><span style="width:' + progressPct(a, now) + '%"></span></span>' : '') + '</span></button>';
}

async function renderTonightRow() {
  const slot = document.getElementById('tonight-slot');
  if (!slot) return;
  const [guide, listed] = await Promise.all([loadGuide(), loadShows().catch(() => null)]);
  const now = nowSec();
  const late = new Date().getHours() >= 23;
  const date = localDate(late ? now + 86400 : now);
  const prime = primeTime(guide.programs, guide.channelOf, date);
  const fresh = document.getElementById('tonight-slot');
  if (!fresh || prime.length < 3) return;
  const known = listed ? listed.shows : [];
  fresh.innerHTML = '<section class="row-section" id="ce-soir" aria-labelledby="h-ce-soir"><h2 class="row-title" id="h-ce-soir">' + (late ? 'Demain soir à la TV' : 'Ce soir à la TV') +
    ' <a class="row-link" href="#/tv-live" data-tvlive>Guide TV</a></h2>' + '<div class="row" data-nav>' +
    prime.slice(0, 16).map((a) => tonightTile(a, matchKnown(a.title, known.map((k) => ({ ...k, aliases: k.aliases }))), now)).join('') + '</div></section>';
}

/** Rangées « Ce soir à la TV » et « Émissions du moment » de l'accueil (silencieuses en cas d'échec). */
export function renderTvRows() {
  if (isKidProfile() || state.status !== 'ready') return;
  setTimeout(() => {
    renderTonightRow().catch(() => {});
    renderShowsRow().catch(() => {});
  }, 600);
}

// ---------- Page « Émissions TV » (style « Vitrine ») ----------
const DAY_SEC = 86400;
/** Onglets de genre possibles (identifiant TMDB → libellé) ; seuls ceux présents parmi les émissions s'affichent. */
const SHOW_TABS = [[10764, 'Téléréalité'], [10767, 'Talk-shows'], [35, 'Divertissement'], [10763, 'Magazines et actu'], [99, 'Documentaires'], [10751, 'Famille']];
/** Onglet d'une émission du guide sans fiche TMDB, d'après sa catégorie au guide (texte XMLTV, FR ou EN), sans accents. */
const EPG_TABS = [[/telerealite|realite|reality|dating/, 10764], [/talk/, 10767], [/divertissement|jeux?|game|varietes?/, 35], [/magazine|actu|news/, 10763], [/documentaire/, 99]];
const epgGenres = (cat) => {
  const c = foldText(cat);
  const hit = EPG_TABS.find(([re]) => re.test(c));
  return hit ? [hit[1]] : [];
};
/** Une entrée mise en cache avant le champ `genres` n'en a pas : elle n'appartient à aucun genre. */
const genresOf = (s) => (s.genres && s.genres.length ? s.genres : s.epg ? epgGenres(s.category) : []);
const genreName = (s) => { const id = genresOf(s).find((g) => GENRE_FR[g]); return id ? GENRE_FR[id] : ''; };

/** Onglets de genre présents parmi les émissions, dans l'ordre de SHOW_TABS : [identifiant, libellé]. */
export function genreTabs(shows) {
  const present = new Set(shows.flatMap(genresOf));
  return SHOW_TABS.filter(([id]) => present.has(id));
}

/** Émissions d'un genre (`'all'` pour toutes). */
export function ofGenre(shows, genre) {
  return genre === 'all' ? shows : shows.filter((s) => genresOf(s).includes(genre));
}

/** Incontournables : les plus populaires qui ont une diffusion ou un épisode dans les 7 jours (six au plus). */
export function weekPicks(shows, now, max = 6) {
  const end = now + 7 * DAY_SEC;
  const today = localDate(now);
  const last = localDate(end);
  return shows
    .filter((s) => s.airings.some((a) => a.start < end) || (s.next && s.next.date >= today && s.next.date <= last))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, max);
}

/**
 * Émission de la soirée : la première (ordre de la page) diffusée ce jour-là entre 20 h 30 et 22 h, avec un fond ;
 * à défaut la plus populaire avec un fond. `tonight` indique laquelle des deux, `airing` la diffusion montrée.
 */
export function heroShow(shows, now) {
  const d = new Date(now * 1000);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 20, 30).getTime() / 1000;
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 22, 0).getTime() / 1000;
  const inWindow = (a) => a.start >= from && a.start < to;
  const withBg = shows.filter((s) => s.backdrop);
  const tonight = withBg.find((s) => s.airings.some(inWindow));
  if (tonight) return { show: tonight, airing: tonight.airings.find(inWindow), tonight: true };
  const top = [...withBg].sort((a, b) => b.popularity - a.popularity)[0];
  return top ? { show: top, airing: top.airings[0] || null, tonight: false } : null;
}

/** Bandeau plein largeur de l'émission de la soirée (ou « À la une ») : titre h1 (cible du focus), diffusion, actions. */
export function heroHTML(h, now) {
  const s = h.show;
  const a = h.airing;
  const live = !!a && isLiveNow(a, now);
  const dur = a ? fmtMin(Math.round((a.stop - a.start) / 60)) : '';
  const when = a
    ? (h.tonight && !live ? 'Ce soir ' + hhmm(a.start) + ' · ' + a.channel.name : airingLabel(a, now)) + (dur ? ' · ' + dur : '')
    : showSub(s, now);
  const kicker = h.tonight ? 'L’émission de la soirée' : 'À la une';
  const watch = live && a.channel.playId;
  const fiche = '<button type="button" class="btn ' + (watch ? 'btn-ghost' : 'btn-primary') + ' btn-pill" data-showopen="' + esc(s.id) + '"><span>Voir la fiche</span></button>';
  const action = watch
    ? '<button type="button" class="btn btn-primary btn-pill" data-showwatch="' + esc(a.channel.playId) + '">' + ICON.play + '<span>Regarder en direct</span></button>'
    : followBtn('tv:' + s.id, 'btn btn-ghost btn-pill', '', 'Me prévenir');
  return '<section class="sv-hero" aria-labelledby="svc-title">' +
    '<div class="sv-hero-bg"><img src="' + esc(IMG('w1280', s.backdrop)) + '" alt="" decoding="async" fetchpriority="high"></div>' +
    '<div class="sv-hero-info"><p class="sv-kicker">' + esc(kicker) + '</p>' +
    '<h1 class="sv-hero-title" id="svc-title" tabindex="-1">' + esc(s.name) + '</h1>' +
    '<p class="sv-hero-line">' + esc(when) + '</p>' +
    (s.overview ? '<p class="sv-hero-syn">' + esc(s.overview) + '</p>' : '') +
    '<div class="sv-hero-actions" data-nav>' + fiche + action + '</div></div></section>';
}

/** Incontournable : tuile paysage 16:10 (fond TMDB, repli sur l'affiche), genre, titre et diffusion. */
function weekTile(s, now) {
  const live = s.airings.length && isLiveNow(s.airings[0], now);
  const src = IMG('w780', s.backdrop || s.poster);
  const sub = showSub(s, now);
  return '<button type="button" class="sv-tile" data-showopen="' + esc(s.id) + '" aria-label="' + esc(s.name + ', ' + sub) + '">' +
    '<span class="sv-tile-media' + (src ? '' : ' no-img') + '">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: s.name, type: 'tv' }) +
    (live ? '<span class="t-badge show-live" aria-hidden="true">En direct</span>' : '') + '</span>' +
    '<span class="sv-tile-shade" aria-hidden="true"></span>' +
    '<span class="sv-tile-text" aria-hidden="true"><span class="sv-tile-kicker">' + esc(genreName(s) || 'Émission') + '</span>' +
    '<span class="sv-tile-title">' + esc(s.name) + '</span><span class="sv-tile-sub">' + esc(sub) + '</span></span></button>';
}

/** Top 10 : affiche avec grand numéro, sur le gabarit de la rangée d'accueil, vers la fiche de l'émission. */
function topItem(s, n) {
  const src = IMG('w342', s.poster);
  return '<button type="button" class="top-item" data-showopen="' + esc(s.id) + '" aria-label="' + n + '. ' + esc(s.name) + '">' +
    '<span class="rank" aria-hidden="true">' + n + '</span>' +
    '<span class="card-media' + (src ? '' : ' no-img') + '">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: s.name, type: 'tv' }) + '</span></button>';
}

const MORE_LABEL = 'Voir plus d’émissions';
/** « 124 émissions », « 1 émission ». */
const countLabel = (n) => n + (n > 1 ? ' émissions' : ' émission');

/**
 * Sections 3 à 5 (filtrées par genre) : incontournables, top 10, « À la télé », « Toutes les émissions » (celles sans
 * diffusion annoncée, avec leur compte et le bouton « Voir plus » tant que TMDB a des pages suivantes).
 */
function zoneHTML(shows, genre, now, more) {
  const list = ofGenre(shows, genre);
  const week = weekPicks(list, now);
  const top = [...list].sort((a, b) => b.popularity - a.popularity).slice(0, 10);
  const onTv = list.filter((s) => s.airings.length);
  const stream = list.filter((s) => !s.airings.length);
  const head = (id, title, extra = '') => '<h2 class="row-title shows-h" id="' + id + '">' + esc(title) + extra + '</h2>';
  const grid = (id, items, empty) => '<div class="lib-grid" id="' + id + '" data-nav>' + (items.length ? items.map((s) => showCard(s, now)).join('') : '<p class="row-msg">' + empty + '</p>') + '</div>';
  const count = ' <span class="shows-count" id="sv-stream-count">' + esc(countLabel(stream.length)) + '</span>';
  const moreBtn = more ? '<div class="shows-more"><button type="button" class="btn btn-ghost btn-pill" id="sv-more">' + esc(MORE_LABEL) + '</button></div>' : '';
  return (week.length ? '<section class="sv-sec" aria-labelledby="sv-h-week">' + head('sv-h-week', 'Les incontournables de la semaine') +
    '<div class="sv-grid" data-nav>' + week.map((s) => weekTile(s, now)).join('') + '</div></section>' : '') +
    (top.length ? '<section class="sv-sec" aria-labelledby="sv-h-top">' + head('sv-h-top', 'Top 10 des émissions') +
      '<div class="sv-top" data-nav>' + top.map((s, i) => topItem(s, i + 1)).join('') + '</div></section>' : '') +
    '<section class="sv-sec" aria-labelledby="sv-h-tv">' + head('sv-h-tv', 'À la télé') +
    grid('sv-tv-grid', onTv, 'Aucune de ces émissions n’est annoncée au guide TV pour le moment.') + '</section>' +
    '<section class="sv-sec" aria-labelledby="sv-h-stream">' + head('sv-h-stream', 'Toutes les émissions', count) +
    grid('sv-stream-grid', stream, 'Rien d’autre pour le moment.') + moreBtn + '</section>';
}

/** Onglets de genre (boutons à état `aria-pressed`) : « Tout » puis les genres présents. */
function tabsHTML(tabs, genre) {
  return '<div class="sv-tabs" role="group" aria-label="Filtrer par genre" data-nav>' +
    [['all', 'Tout'], ...tabs].map(([id, label]) => '<button type="button" class="sv-tab" data-genre="' + id + '" aria-pressed="' +
      (String(genre) === String(id)) + '">' + esc(label) + '</button>').join('') + '</div>';
}

export async function showShowsPage() {
  teardownFiche();
  const token = state.token;
  state.kind = 'shows';
  document.title = 'Émissions TV · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  let data;
  try { data = await loadShows(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les émissions n’ont pas pu être chargées.');
    return;
  }
  if (token !== state.token) return;
  const now = nowSec();
  const hero = heroShow(data.shows, now);
  const tabs = genreTabs(data.shows);
  let genre = 'all';
  let more = data.hasMore;
  const head = hero ? heroHTML(hero, now)
    : '<header class="svc-head svc-head-plain"><div class="svc-head-t">' +
      '<h1 class="svc-title" id="svc-title" tabindex="-1">Émissions TV</h1>' +
      '<p class="svc-eyebrow">Divertissement, jeux, talk-shows et téléréalité : quand et où les regarder</p></div></header>';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page shows-page" aria-labelledby="svc-title">' + head + (tabs.length ? tabsHTML(tabs, genre) : '') +
    '<div class="sv-zone" id="sv-zone">' + zoneHTML(data.shows, genre, now, more) + '</div></article>';
  // Un clic sur un genre redessine seulement la zone filtrée, sans nouvel appel réseau.
  const bar = detailEl.querySelector('.sv-tabs');
  const zone = detailEl.querySelector('#sv-zone');
  if (bar && zone) {
    bar.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-genre]') : null;
      if (!b) return;
      genre = b.dataset.genre === 'all' ? 'all' : Number(b.dataset.genre);
      bar.querySelectorAll('[data-genre]').forEach((t) => t.setAttribute('aria-pressed', String(t === b)));
      zone.innerHTML = zoneHTML(data.shows, genre, nowSec(), more);
    });
    // « Voir plus » : clic délégué sur la zone (redessinée à chaque genre). Les cartes ajoutées suivent le genre actif.
    const setMoreBusy = (busy) => {
      const btn = zone.querySelector('#sv-more');
      if (!btn) return;
      btn.disabled = busy;
      if (busy) { btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Chargement…'; } else { btn.removeAttribute('aria-busy'); btn.textContent = MORE_LABEL; }
    };
    const loadMore = async () => {
      setMoreBusy(true);
      let r;
      try { r = await loadMoreShows(); } catch (_) {
        if (token === state.token) { setMoreBusy(false); zone.querySelector('#sv-more')?.focus({ preventScroll: true }); }
        return;
      }
      if (token !== state.token) return;
      const at = nowSec();
      const grid = zone.querySelector('#sv-stream-grid');
      const fresh = ofGenre(r.added, genre).filter((s) => !s.airings.length);
      if (grid && fresh.length) {
        grid.querySelector('.row-msg')?.remove();
        grid.insertAdjacentHTML('beforeend', fresh.map((s) => showCard(s, at)).join(''));
      }
      const count = zone.querySelector('#sv-stream-count');
      if (count) count.textContent = countLabel(ofGenre(data.shows, genre).filter((s) => !s.airings.length).length);
      more = r.hasMore;
      if (more) {
        setMoreBusy(false);
        zone.querySelector('#sv-more')?.focus({ preventScroll: true });
      } else {
        zone.querySelector('.shows-more')?.remove();
        const cards = grid ? grid.querySelectorAll('.show-card') : [];
        cards[cards.length - fresh.length]?.focus({ preventScroll: true });
      }
    };
    zone.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('#sv-more') : null;
      if (btn && !btn.disabled) loadMore();
    });
  }
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
}

// ---------- Fiche d'une émission (classes sf-*) ----------
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const weekSlot = (sec) => capital(new Date(sec * 1000).toLocaleDateString('fr-FR', { weekday: 'long' })) + ' ' + hhmm(sec);

/** Jour d'une diffusion, en grand : « Ce soir » (à partir de 18 h), « Aujourd’hui », « Demain », « Mardi 27 ». */
export function dayWord(sec, now) {
  if (localDate(sec) === localDate(now)) return new Date(sec * 1000).getHours() >= 18 ? 'Ce soir' : 'Aujourd’hui';
  if (localDate(sec) === localDate(now + 86400)) return 'Demain';
  return capital(new Date(sec * 1000).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' }));
}

/** Délai avant une diffusion : « Dans 14 min », « Dans 2 h 14 min ». */
function inText(sec, now) {
  const m = Math.round((sec - now) / 60);
  if (m < 1) return 'Dans moins d’une minute';
  if (m < 60) return 'Dans ' + m + ' min';
  return 'Dans ' + Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
}

/** Lignes « où regarder » : replay (gratuit ou avec publicité), streaming (abonnement) ; à défaut la plateforme connue. */
function whereLines(pr, platform) {
  const out = [];
  if (pr && pr.flatrate[0]) out.push('Streaming sur <strong>' + esc(pr.flatrate[0].name) + '</strong>');
  if (pr && pr.free[0]) out.push('Replay sur <strong>' + esc(pr.free[0].name) + '</strong>');
  if (!out.length && platform) out.push('Streaming sur <strong>' + esc(platform) + '</strong>');
  return out;
}

/**
 * Contenu de la carte « Prochaine diffusion » (HTML) ; '' si rien n'est annoncé, la carte reste alors masquée.
 * `pr` : fournisseurs (fetchProviders), null tant qu'ils ne sont pas chargés.
 */
export function nextCardInner(d, airings, platform, pr, now) {
  const a = airings[0];
  if (!a && !(d.next && d.next.date)) {
    return platform ? '<p class="sf-next-k">Disponible sur</p><p class="sf-next-big">' + esc(platform) + '</p>' : '';
  }
  let head;
  if (a) {
    const ch = a.channel;
    const sub = [ch.name, ch.num ? 'canal ' + ch.num : '', fmtMin(Math.round((a.stop - a.start) / 60))].filter(Boolean).join(' · ');
    head = '<p class="sf-next-k">Prochaine diffusion</p>' +
      '<p class="sf-next-big">' + esc(dayWord(a.start, now)) + ' ' + hhmm(a.start) + '</p>' +
      '<p class="sf-next-sub">' + esc(sub) + '</p>' +
      (isLiveNow(a, now)
        ? '<p class="sf-next-acc">En direct jusqu’à ' + hhmm(a.stop) + '</p><span class="sf-bar" aria-hidden="true"><span style="width:' + progressPct(a, now) + '%"></span></span>'
        : '<p class="sf-next-acc">' + esc(inText(a.start, now)) + '</p>');
  } else {
    head = '<p class="sf-next-k">Nouvel épisode</p>' +
      '<p class="sf-next-big">' + esc(shortDate(d.next.date)) + '</p>' +
      (d.next.season ? '<p class="sf-next-sub">S' + esc(String(d.next.season)) + ' · É' + esc(String(d.next.episode)) + '</p>' : '');
  }
  const where = whereLines(pr, platform);
  return '<div class="sf-next-in">' + head +
    (where.length ? '<ul class="sf-next-where">' + where.map((w) => '<li>' + w + '</li>').join('') + '</ul>' : '') + '</div>';
}

/** Rangée d'une diffusion à venir ; la diffusion en cours a sa barre de progression et « Regarder ». */
function airingRow(a, now, hasPlay) {
  const live = isLiveNow(a, now);
  const ch = a.channel;
  return '<li class="sf-air' + (live ? ' is-live' : '') + '">' +
    '<span class="sf-air-when">' + (live ? '<strong>En direct</strong> jusqu’à ' + hhmm(a.stop) : '<strong>' + esc(dayWord(a.start, now)) + '</strong> ' + hhmm(a.start)) + '</span>' +
    '<span class="sf-air-main"><span class="sf-air-title">' + esc(a.title) + '</span>' +
    '<span class="sf-air-chan">' + (ch.num ? '<b class="ch-num">' + esc(String(ch.num)) + '</b>' : '') + esc(ch.name) + '</span></span>' +
    (live ? '<span class="progress sf-air-prog" aria-hidden="true"><span style="width:' + progressPct(a, now) + '%"></span></span>' : '') +
    (live && hasPlay && ch.playId ? '<button type="button" class="btn btn-primary btn-sm" data-showwatch="' + esc(ch.playId) + '">' + ICON.play + '<span>Regarder</span></button>' : '') +
    '</li>';
}

/** Épisodes précédents : grille de vignettes 16:9 ; chaque carte est un bouton qui lance la recherche de sources de l'épisode. */
function pastHTML(list) {
  if (!list.length) return '<p class="row-msg">Aucun épisode précédent trouvé.</p>';
  return '<div class="sf-eps" data-nav>' + list.slice(0, 8).map((e) => {
    const src = IMG('w300', e.still);
    const code = 'S' + e.season + ' · É' + e.episode;
    const dur = fmtMin(e.runtime);
    return '<button type="button" class="sf-ep" data-showep="' + e.season + ':' + e.episode + '">' +
      '<span class="sf-ep-media' + (src ? '' : ' no-img') + '" aria-hidden="true">' +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '<span class="sf-ep-fb" aria-hidden="true">' + esc(code) + '</span>') +
      (dur ? '<span class="sf-ep-dur">' + esc(dur) + '</span>' : '') + '</span>' +
      '<span class="sf-ep-code">' + esc(code + ' · ' + shortDay(e.date)) + '</span>' +
      '<span class="sf-ep-title">' + esc(e.name || 'Épisode ' + e.episode) + '</span></button>';
  }).join('') + '</div>';
}

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();

/** Présentation : rangée d'avatars ronds (photo, sinon initiales), nom et rôle. */
function castHTML(cast) {
  return '<ul class="sf-cast">' + cast.map((p) => {
    const src = IMG('w185', p.photo);
    return '<li class="sf-person"><span class="sf-av">' +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '<span aria-hidden="true">' + esc(initials(p.name)) + '</span>') + '</span>' +
      '<span class="sf-pn">' + esc(p.name) + '</span>' + (p.role ? '<span class="sf-pr">' + esc(p.role) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

/** Lecture d'un épisode (`data-showep="S:E"`) : recherche des sources de cet épisode (playBest, selon l'auto-lecture). */
function playEpisode(btn) {
  const art = btn.closest('.show-fiche');
  const key = art ? art.dataset.key || '' : '';
  const name = art && art.dataset.name !== undefined ? art.dataset.name : state.ficheName || '';
  const [season, episode] = String(btn.dataset.showep).split(':').map(Number);
  playBest({ type: 'tv', id: key.split(':')[1] || '', name, season, episode, key }, btn);
}

/**
 * Fiche d'une émission du guide sans fiche TMDB (`#/emission/epg:<clé>`) : mêmes classes que la fiche TMDB, à partir des
 * données du guide. Pas d'épisodes, de casting ni de fournisseurs (aucun identifiant TMDB), ni de « Me prévenir » (le suivi
 * est indexé par identifiant TMDB numérique).
 */
async function showGuideShow(id) {
  const token = state.token;
  state.kind = 'show';
  state.ficheKey = 'tv:' + id;
  detailEl.innerHTML = ficheSkeleton(null);
  const shell = detailEl.querySelector('.fiche');
  if (shell) shell.focus({ preventScroll: true });
  let s;
  try {
    s = (await loadShows()).shows.find((x) => x.epg && x.id === id);
  } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Cette émission n’a pas pu être chargée.');
    return;
  }
  if (token !== state.token) return;
  if (!s) { detailEl.innerHTML = svcError('Cette émission n’est plus au programme.'); return; }
  const now = nowSec();
  const first = s.airings[0];
  const live = s.airings.find((a) => isLiveNow(a, now));
  const liveCh = live && live.channel.playId ? live.channel : null;
  const kicker = 'Émission TV' + (s.category ? ' · ' + s.category : '');
  const meta = (first ? [first.channel.name, weekSlot(first.start)] : []).filter(Boolean).map((t) => '<li>' + esc(t) + '</li>').join('');
  const actions = liveCh ? '<button type="button" class="btn btn-primary btn-pill" data-showwatch="' + esc(liveCh.playId) + '">' + ICON.play + '<span>Regarder en direct</span></button>' : '';
  const nextHTML = nextCardInner({ next: null }, s.airings, '', null, now);
  const hero = '<section class="sf-hero">' + ficheHeroShell(null, { backdrop: guideImg(s.icon) }) +
    '<div class="sf-hero-in"><div class="sf-info"><p class="sf-kicker">' + esc(kicker) + '</p>' +
    '<h1 class="sf-title" id="f-title" tabindex="-1">' + esc(s.name) + '</h1>' +
    (meta ? '<ul class="sf-meta">' + meta + '</ul>' : '') +
    (s.overview ? '<p class="sf-syn">' + esc(s.overview) + '</p>' : '') +
    (actions ? '<div class="sf-actions" data-nav>' + actions + '</div>' : '') + '</div>' +
    '<aside class="sf-next" id="show-next" aria-label="Prochaine diffusion"' + (nextHTML ? '' : ' hidden') + '>' + nextHTML + '</aside></div></section>';
  const body = '<div class="sf-body"><section class="sf-sec sf-airs" aria-labelledby="sf-h-airs"><h2 class="sf-h" id="sf-h-airs">Prochaines diffusions</h2>' +
    '<ul class="sf-airs-list" data-nav>' + s.airings.slice(0, 12).map((a) => airingRow(a, now, true)).join('') + '</ul></section></div>';
  detailEl.innerHTML = topBar(true) +
    '<article class="fiche show-fiche" aria-labelledby="f-title" data-key="' + esc('tv:' + id) + '" data-name="' + esc(s.name) + '">' + hero + body + '</article>';
  document.title = s.name + ' · Laststream';
  state.ficheName = s.name;
  const h1 = detailEl.querySelector('#f-title');
  if (h1) h1.focus({ preventScroll: true });
}

export async function showShow(id) {
  teardownFiche();
  if (String(id).startsWith('epg:')) return showGuideShow(String(id));
  const token = state.token;
  state.kind = 'show';
  state.ficheKey = 'tv:' + id;
  detailEl.innerHTML = ficheSkeleton(null);
  const shell = detailEl.querySelector('.fiche');
  if (shell) shell.focus({ preventScroll: true });
  let d;
  let guide = null;
  try {
    [d, guide] = await Promise.all([showDetail(id), loadGuide().catch(() => null)]);
  } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Cette émission n’a pas pu être chargée.');
    return;
  }
  if (token !== state.token) return;
  const now = nowSec();
  const today = localDate(now);
  const seed = seedFor(d.name);
  const airings = guide ? airingsFor({ name: d.name, aliases: seed ? [seed.name, ...(seed.aliases ?? [])] : [] }, guide.programs, guide.channelOf, now) : [];
  const platform = (seed && seed.streaming) || '';
  const key = 'tv:' + id;
  register(toItem({ id: Number(id), name: d.name, poster_path: d.poster, backdrop_path: d.backdrop, overview: d.overview }, 'tv'));
  state.ficheName = d.name;
  const hasPlay = !!guide;

  // Bouton principal : le direct si l'émission passe maintenant, sinon le dernier épisode diffusé.
  const liveNow = !!airings.length && isLiveNow(airings[0], now);
  const liveCh = liveNow && hasPlay && airings[0].channel.playId ? airings[0].channel : null;
  const last = d.last && d.last.date && d.last.date <= today ? d.last : null;
  const actions = (liveCh
    ? '<button type="button" class="btn btn-primary btn-pill" data-showwatch="' + esc(liveCh.playId) + '">' + ICON.play + '<span>Regarder en direct</span></button>'
    : last ? '<button type="button" class="btn btn-primary btn-pill" data-showep="' + last.season + ':' + last.episode + '">' + ICON.play + '<span>Revoir le dernier épisode</span></button>' : '') +
    followBtn(key, 'btn btn-ghost btn-pill', '', 'Me prévenir') +
    '<a class="btn btn-ghost btn-pill" href="#/tv/' + id + '" data-open="' + esc(key) + '"><span>Fiche série</span></a>';

  const first = d.cast[0];
  const presenter = first && /host|présent|animat/i.test(first.role) ? first.name : '';
  const meta = [
    d.networks.length ? d.networks.slice(0, 3).join(' · ') : (airings.length ? airings[0].channel.name : ''),
    airings.length ? weekSlot(airings[0].start) : '',
    STATUS_FR[d.status] || d.status,
    presenter ? 'Présenté par ' + presenter : '',
  ].filter(Boolean).map((t) => '<li>' + esc(t) + '</li>').join('');
  const kicker = 'Émission TV' + (d.genres.length ? ' · ' + d.genres.slice(0, 2).join(' · ') : '');
  const nextHTML = nextCardInner(d, airings, platform, null, now);

  const hero = '<section class="sf-hero">' + ficheHeroShell({ backdropPath: d.backdrop }, null) +
    '<div class="sf-hero-in"><div class="sf-info"><p class="sf-kicker">' + esc(kicker) + '</p>' +
    '<h1 class="sf-title" id="f-title" tabindex="-1">' + esc(d.name) + '</h1>' +
    (meta ? '<ul class="sf-meta">' + meta + '</ul>' : '') +
    (d.overview ? '<p class="sf-syn">' + esc(d.overview) + '</p>' : '') +
    '<div class="sf-actions" data-nav>' + actions + '</div></div>' +
    '<aside class="sf-next" id="show-next" aria-label="Prochaine diffusion"' + (nextHTML ? '' : ' hidden') + '>' + nextHTML + '</aside></div></section>';

  const airsHTML = airings.length
    ? '<ul class="sf-airs-list" data-nav>' + airings.slice(0, 12).map((a) => airingRow(a, now, hasPlay)).join('') + '</ul>'
    : '<p class="row-msg">Aucune diffusion annoncée au guide TV pour le moment' + (platform ? ' : cette émission est sur ' + esc(platform) + '.' : '.') + '</p>';
  const body = '<div class="sf-body">' +
    '<div class="sf-cols">' +
    '<section class="sf-col sf-airs" aria-labelledby="sf-h-airs"><h2 class="sf-h" id="sf-h-airs">Prochaines diffusions</h2>' + airsHTML + '</section>' +
    '<section class="sf-col sf-past" aria-labelledby="sf-h-past"><h2 class="sf-h" id="sf-h-past">Derniers épisodes</h2>' +
    '<div id="show-past"><div class="sf-eps" aria-hidden="true"><span class="sk sf-sk-ep"></span><span class="sk sf-sk-ep"></span><span class="sk sf-sk-ep"></span></div></div></section>' +
    '</div>' +
    (d.cast.length ? '<section class="sf-sec" aria-labelledby="sf-h-cast"><h2 class="sf-h" id="sf-h-cast">Présentation</h2>' + castHTML(d.cast) + '</section>' : '') +
    '<section class="sf-sec" aria-labelledby="sf-h-where"><h2 class="sf-h" id="sf-h-where">Où regarder</h2>' +
    '<div class="f-prov" id="show-where"><span class="sk sk-line"></span></div></section>' +
    '</div>';

  detailEl.innerHTML = topBar(true) +
    '<article class="fiche show-fiche" aria-labelledby="f-title" data-key="' + esc(key) + '" data-name="' + esc(d.name) + '">' + hero + body + '</article>';
  document.title = d.name + ' · Laststream';
  const h1 = detailEl.querySelector('#f-title');
  if (h1) h1.focus({ preventScroll: true });
  pastEpisodes(d, today).then((list) => {
    const box = detailEl.querySelector('#show-past');
    if (box && token === state.token) box.innerHTML = pastHTML(list);
  }).catch(() => {
    const box = detailEl.querySelector('#show-past');
    if (box && token === state.token) box.innerHTML = '<p class="row-msg">Les épisodes n’ont pas pu être chargés.</p>';
  });
  fetchProviders('tv', id).then((pr) => {
    if (token !== state.token) return;
    const where = detailEl.querySelector('#show-where');
    if (where) where.innerHTML = providersHTML(pr);
    const next = detailEl.querySelector('#show-next');
    if (next) {
      const inner = nextCardInner(d, airings, platform, pr, now);
      next.innerHTML = inner;
      next.hidden = !inner;
    }
  }).catch(() => {
    const where = detailEl.querySelector('#show-where');
    if (where) where.innerHTML = '<p class="row-msg">Disponibilités indisponibles.</p>';
  });
}

// ---------- Lecture en direct d'une chaîne ----------
export async function watchChannel(playId, opener) {
  let guide;
  try { guide = await loadGuide(); } catch (_) { return; }
  const raw = guide.catalog.get(playId);
  if (!raw) return;
  const list = guide.channels.map((c) => (c.playId ? guide.catalog.get(c.playId) : null)).filter(Boolean).map(normChannel);
  list.forEach((c) => tv.byId.set(c.id, c));
  const c = tv.byId.get(playId) || normChannel(raw);
  openPlayer(c, list, opener);
}

// ---------- Clics ----------
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const watch = t.closest('[data-showwatch]');
  if (watch) { e.preventDefault(); e.stopPropagation(); watchChannel(watch.dataset.showwatch, watch); return; }
  const ep = t.closest('[data-showep]');
  if (ep) { e.preventDefault(); e.stopPropagation(); playEpisode(ep); return; }
  const open = t.closest('[data-showopen]');
  if (open) { e.preventDefault(); e.stopPropagation(); go('#/emission/' + open.dataset.showopen, open); return; }
  const nav = t.closest('[data-showsnav]');
  if (nav) { e.preventDefault(); e.stopPropagation(); go('#/emissions', nav); }
}, true);
