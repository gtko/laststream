/* Recherche (#/search) : champ dans la barre du haut (barre de navigation conservée), meilleur résultat en bandeau,
 * filtres, puis grilles de jaquettes Films / Séries et rangée Personnalités (searchRank.js).
 * Les deux premières pages sont classées ensemble ; chaque section n'affiche d'abord que ses premiers résultats (searchPaging.js),
 * un bouton « Charger plus » par section affiche le lot suivant et va chercher les pages suivantes au besoin.
 * Profil enfant : genres jeunesse uniquement, pas de personnalités. */
import { stopInfinite } from './infinite.js';
import { applyRestore } from './router.js';
import { filterAvailable } from './avail.js';
import { todayStr } from './dates.js';
import { auth, canAdmin, isKidProfile, isServerMode, kidSection } from '../data/auth';
import { kidGenreOk } from '../data/kid';
import { tmdb } from '../data/lt';
import { register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { detailEl, modal } from './dom.js';
import { teardownFiche } from './fiche.js';
import { brand } from './fragments.js';
import { tabbar } from './home.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { mainNavHTML, topActionsHTML } from './topnav.js';
import { esc, plural } from './util.js';
import { kindOf, rankResults, resultKey, splitBanned, titleMatch } from './searchRank.js';
import { MAX_PAGES_PER_CLICK, hasMore, moreLabel, needsMore, sectionLimit } from './searchPaging.js';
import { homeFacts, isBannedGenre } from '../data/homeFilters';

const DEBOUNCE_MS = 300;
const RECENT_MAX = 8;
const BEST_MIN_SCORE = 60; // correspondance exacte ou préfixe du titre
const RECENT_BASE = 'laststream.search.recent';
const PILLS = [['all', 'Tout'], ['movie', 'Films'], ['tv', 'Séries'], ['people', 'Personnalités']];
const KINDS = ['movie', 'tv']; // ordre des groupes : Films, puis Séries, puis Personnalités
const GROUP_TITLE = { movie: 'Films', tv: 'Séries' };
/** Suffixe des ids des menus de la barre de recherche : la barre de l'accueil (masquée) garde les siens. */
const BAR_ID = '-search';

let timer = null;
let seq = 0; // jeton de la dernière recherche lancée : une réponse plus ancienne est ignorée
let session = null; // { q, token, media, held, people, raw, seen, next, total, done, best, filter, shown, lots, gen, loading, failed }

/** Champ de recherche de la barre du haut (remplace la loupe). */
const searchFieldHTML = (q) =>
  '<form id="search-form" class="search-form" role="search">' +
  '<div class="search-bar"><label class="sr-only" for="search-input">Rechercher un film, une série ou une personnalité</label>' +
  '<span class="search-ico" aria-hidden="true">' + ICON.search + '</span>' +
  '<input id="search-input" class="search-input" type="search" name="q" autocomplete="off" enterkeyhint="search" placeholder="Films, séries, personnalités…" value="' + esc(q) + '">' +
  '<button type="button" class="search-clear" data-search-clear aria-label="Effacer la recherche"' + (q ? '' : ' hidden') + '>' + ICON.close + '</button>' +
  '</div></form>';

/** Barre du haut de la page Recherche : logo, liens de l'app, champ, puis profil (même menu que l'accueil). */
function topbarHTML(q) {
  const kid = isKidProfile();
  const server = isServerMode();
  const nav = kid
    ? '<a href="#/library" data-libnav>Mes favoris</a>' + (kidSection('tv') ? '<a href="#/tv-live" data-tvlive>TV jeunesse</a>' : '')
    : mainNavHTML({ idSuffix: BAR_ID, social: server });
  return '<header class="topbar search-topbar">' + brand() +
    '<nav class="nav" aria-label="Principale">' + nav + '</nav>' +
    topActionsHTML({ kid, social: server && !kid, server, owner: canAdmin(), search: searchFieldHTML(q), idSuffix: BAR_ID }) + '</header>';
}

export function showSearch() {
  clearTimeout(timer);
  teardownFiche();
  stopInfinite();
  seq += 1;
  session = null;
  state.kind = 'search';
  document.title = 'Recherche · Laststream';
  const q = state.searchQ || '';
  detailEl.innerHTML = '<div class="s-a search-root">' + topbarHTML(q) +
    '<article class="svc-page search-page" aria-labelledby="search-title">' +
    '<h1 class="sr-only" id="search-title" tabindex="-1">Recherche</h1>' +
    '<div class="search-body" id="search-body"></div>' +
    '<p class="sr-only" id="search-status" role="status" aria-live="polite"></p>' +
    '</article>' + tabbar('search') + '</div>';
  const inp = input();
  if (inp) { inp.focus(); run(inp.value); }
}

/** Résultats utilisables : jamais de personne ni de titre sans affiche ; pour un enfant, genres jeunesse uniquement. */
export function filterResults(results, kid) {
  return (results || []).filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path &&
    (r.release_date || r.first_air_date || '9999').slice(0, 10) <= todayStr() && (!kid || kidGenreOk(r.genre_ids)));
}

const input = () => detailEl.querySelector('#search-input');
const bodyEl = () => detailEl.querySelector('#search-body');
const groupsEl = () => detailEl.querySelector('#srch-groups');
const isLive = (s) => s.token === seq && state.kind === 'search';
const fetchPage = (q, page) => tmdb('search/multi', { query: q, include_adult: 'false', ...(page > 1 ? { page } : {}) });

/** Lance une recherche ; une requête identique à la requête affichée ne refait rien. */
async function run(raw) {
  // Débounce arrivé après avoir quitté la page : ne touche pas à la page courante.
  if (state.kind !== 'search') return;
  const q = String(raw || '').trim();
  if (session && session.q === q && q.length >= 2) return;
  const my = ++seq;
  stopInfinite();
  session = null;
  state.searchQ = q;
  if (q.length < 2) { paintEmpty(my); return; }
  const s = { q, token: my, media: [], held: [], people: [], raw: new Map(), seen: new Set(), next: 3, total: 1, done: false, best: null, filter: 'all', shown: false, lots: freshLots(), gen: 0, loading: false, failed: null };
  session = s;
  paintLoading();
  let a;
  let b;
  try {
    [a, b] = await Promise.all([fetchPage(q, 1), fetchPage(q, 2).catch(() => ({ results: [] }))]);
  } catch (_) {
    if (isLive(s)) { session = null; paintError(); }
    return;
  }
  if (!isLive(s)) return;
  s.total = Math.max(1, Number(a.total_pages) || 1);
  s.done = s.total < 3;
  const first = [...(a.results || []), ...(s.total > 1 ? b.results || [] : [])];
  s.media = await ingest(s, first);
  if (!isLive(s)) return;
  releaseBanned(s);
  s.best = pickBest(s);
  saveRecent(q);
  if (s.done && !s.media.length && !s.people.length) { paintNone(s); return; }
  paintSession(s);
}

/** Ajoute un lot de résultats bruts : dédoublonnage, classement, filtres, disponibilité. Renvoie les titres, classés. */
async function ingest(s, raws) {
  const kid = isKidProfile();
  const fresh = [];
  for (const r of raws || []) {
    if (!r || r.id == null) continue;
    const k = resultKey(r);
    if (s.seen.has(k)) continue;
    s.seen.add(k);
    s.raw.set(k, r);
    fresh.push(r);
  }
  const ranked = rankResults(fresh, s.q, { today: todayStr() });
  if (!kid) s.people.push(...ranked.filter((r) => kindOf(r) === 'person'));
  const media = filterResults(ranked, kid);
  const { keep, banned } = splitBanned(await filterAvailable(media.map((r) => register(toItem(r, r.media_type)))), (it) => isBannedGenre(it));
  s.held.push(...banned); // genres bannis : en fin de liste, ajoutés quand la dernière page est reçue
  return keep;
}

/** Ajoute en fin de liste les résultats de genre banni, une fois la liste complète. Renvoie ceux ajoutés. */
function releaseBanned(s) {
  if (!s.done || !s.held.length) return [];
  const tail = s.held;
  s.held = [];
  s.media.push(...tail);
  return tail;
}

/** Meilleur résultat : premier titre classé, avec affiche large, si son titre commence exactement par la requête. */
function pickBest(s) {
  const first = s.media[0];
  if (!first || !first.backdropPath || isBannedGenre(first)) return null; // jamais un genre banni
  const raw = s.raw.get(first.key);
  return raw && titleMatch(raw, s.q) >= BEST_MIN_SCORE ? first : null;
}

/** Charge la page suivante et l'ajoute aux résultats chargés (rien n'est dessiné ici). Renvoie false s'il n'y a plus rien à charger ; les pages en échec sont rejouées. */
async function fetchNext(s) {
  if (s.done || !isLive(s)) return false;
  const page = s.next;
  s.next += 1;
  let json;
  try {
    json = await fetchPage(s.q, page);
  } catch (e) {
    s.next = page;
    throw e;
  }
  if (!isLive(s)) return false;
  s.total = Number(json.total_pages) || s.total;
  const items = await ingest(s, json.results);
  if (!isLive(s)) return false;
  s.media.push(...items);
  s.done = s.next > s.total;
  releaseBanned(s);
  if (s.done && !s.media.length && !s.people.length) { paintNone(s); return false; }
  return true;
}

const inFilter = (it, f) => f === 'all' || (f === 'movie' && it.type === 'movie') || (f === 'tv' && it.type === 'tv');
/** Le meilleur résultat a sa propre carte dans la vue « Tout » : il n'est pas répété dans les groupes. */
const visibleInGrid = (s, it) => inFilter(it, s.filter) && !(s.filter === 'all' && s.best && it.key === s.best.key);
const gridItems = (s) => s.media.filter((it) => visibleInGrid(s, it));
const freshLots = () => ({ movie: 0, tv: 0, people: 0 });
/** Résultats chargés d'une section (Films, Séries ou Personnalités), tous les lots confondus. */
const sectionItems = (s, kind) => (kind === 'people' ? s.people : gridItems(s).filter((it) => it.type === kind));
const limitOf = (s, kind) => sectionLimit(kind, s.filter, s.lots[kind]);
/** Nombre affiché à côté d'un filtre : suivi de « + » tant que d'autres pages peuvent encore compléter la liste. */
const countText = (s, n) => String(n) + (s.done ? '' : '+');

function counts(s) {
  const movie = s.media.filter((it) => it.type === 'movie').length;
  return { all: s.media.length + s.people.length, movie, tv: s.media.length - movie, people: s.people.length };
}

const statusText = (s) => {
  const n = s.media.length + s.people.length;
  return n ? (s.done ? '' : 'Au moins ') + plural(n, 'résultat', 'résultats') + ' pour « ' + s.q + ' »' : 'Aucun résultat pour « ' + s.q + ' »';
};

function setStatus(text) {
  const el = detailEl.querySelector('#search-status');
  if (el) el.textContent = text;
}

// ---------- Rendu ----------

/** Message d'un groupe vide ; marqué data-empty pour être retiré quand des résultats arrivent. */
function emptyMsg(s) {
  if (!s.done || (s.filter === 'all' && s.best)) return '';
  const what = s.filter === 'movie' ? 'film' : s.filter === 'tv' ? 'série' : 'film ni série';
  return '<p class="row-msg" data-empty>Aucun ' + what + ' pour cette recherche.</p>';
}

/** Groupe « Films » ou « Séries » : titre, puis grille dense de jaquettes. */
function groupHtml(kind, inner, s) {
  return '<section class="srch-group" id="srch-sec-' + kind + '" aria-labelledby="srch-h-' + kind + '">' +
    '<h2 class="row-title" id="srch-h-' + kind + '">' + GROUP_TITLE[kind] + '</h2>' +
    '<div class="srch-grid" id="srch-grid-' + kind + '" data-nav>' + inner + '</div>' + moreHtml(s, kind) + '</section>';
}

/** Bouton « Charger plus » d'une section : absent quand tout est affiché et que la liste est finie. */
function moreHtml(s, kind) {
  const loaded = sectionItems(s, kind).length;
  const limit = limitOf(s, kind);
  if (!hasMore(loaded, limit, s.done)) return '';
  const busy = s.loading;
  const label = busy ? 'Chargement…' : s.failed === kind ? 'Réessayer' : moreLabel(loaded, limit, s.done);
  return '<div class="srch-more" data-nav><button type="button" class="btn btn-ghost srch-more-btn" data-more="' + kind + '"' +
    (busy ? ' aria-disabled="true" aria-busy="true"' : '') + '>' + esc(label) + '</button></div>';
}

function filtersHtml(s) {
  const c = counts(s);
  return PILLS.filter(([f]) => !(f === 'people' && isKidProfile())).map(([f, label]) =>
    '<button type="button" class="pill" data-filter="' + f + '" aria-pressed="' + (s.filter === f) + '">' + label +
    ' <span class="srch-n" data-count="' + f + '">' + countText(s, c[f]) + '</span></button>').join('');
}

/** Meilleur résultat en bandeau compact : vignette, titre, méta, synopsis court, bouton. */
function bestHtml(it) {
  const meta = [it.type === 'tv' ? 'Série' : 'Film', it.year, it.vote ? '★ ' + it.vote : ''].filter(Boolean);
  return '<section class="srch-best" data-nav aria-label="Meilleur résultat">' +
    '<div class="srch-best-media"><img src="' + esc(IMG('w780', it.backdropPath)) + '" alt="" decoding="async"></div>' +
    '<div class="srch-best-info"><span class="eyebrow">Meilleur résultat</span>' +
    '<h2 class="srch-best-title">' + esc(it.name) + '</h2>' +
    '<p class="meta">' + meta.map((x) => '<span>' + esc(x) + '</span>').join('<span aria-hidden="true">·</span>') + '</p>' +
    (it.overview ? '<p class="srch-best-desc">' + esc(it.overview) + '</p>' : '') +
    '<button type="button" class="btn btn-primary srch-best-btn" data-open="' + esc(it.key) + '">' + ICON.info + 'Plus d’infos</button>' +
    '</div></section>';
}

function personHtml(p) {
  const name = p.name || 'Sans nom';
  const known = (p.known_for || []).map((k) => k.title || k.name).filter(Boolean).slice(0, 2);
  const photo = IMG('w185', p.profile_path);
  const ini = name.split(' ').map((w) => Array.from(w)[0] || '').slice(0, 2).join('');
  return '<li><a class="cast" href="#/person/' + esc(p.id) + '" data-person="' + esc(p.id) + '"' +
    ' aria-label="' + esc(name) + (known.length ? ', connu pour ' + esc(known.join(', ')) : '') + '">' +
    '<span class="cast-ph' + (photo ? '' : ' no-img') + '">' + (photo ? '<img src="' + esc(photo) + '" alt="" loading="lazy" decoding="async">' : '') +
    '<span class="cast-ini" aria-hidden="true">' + esc(ini) + '</span></span>' +
    '<span class="cast-name">' + esc(name) + '</span>' +
    (known.length ? '<span class="cast-role">Connu pour ' + esc(known.join(', ')) + '</span>' : '') + '</a></li>';
}

/** Rangée « Personnalités » (dernier groupe), seulement s'il y en a ; hors profil enfant. */
function peopleHtml(s) {
  if (isKidProfile() || (s.filter !== 'all' && s.filter !== 'people')) return '';
  if (!s.people.length && (s.filter === 'all' || s.done)) return s.filter === 'people' ? '<p class="row-msg" data-empty>Aucune personnalité pour cette recherche.</p>' : '';
  return '<section class="srch-people row-section" id="srch-people" aria-labelledby="srch-people-h"><h2 class="row-title" id="srch-people-h">Personnalités</h2>' +
    '<ul class="cast-row srch-cast" data-nav>' + s.people.slice(0, limitOf(s, 'people')).map(personHtml).join('') + '</ul>' + moreHtml(s, 'people') + '</section>';
}

/** Haut de page : meilleur résultat (vue « Tout ») et filtres. */
function topHtml(s) {
  return (s.best && s.filter === 'all' ? bestHtml(s.best) : '') +
    '<div class="pills srch-filters" role="group" aria-label="Filtrer les résultats" data-nav>' + filtersHtml(s) + '</div>';
}

/** Groupes visibles selon le filtre : Films, Séries (grilles), puis Personnalités. */
function groupsHtml(s) {
  const kinds = s.filter === 'all' ? KINDS : KINDS.filter((k) => k === s.filter);
  let h = '';
  for (const k of kinds) {
    const list = sectionItems(s, k);
    // Vue « Tout » : une section sans résultat chargé n'apparaît que si d'autres pages peuvent encore en apporter.
    if (list.length) h += groupHtml(k, list.slice(0, limitOf(s, k)).map((it) => posterCard(it)).join(''), s);
    else if (s.filter !== 'all' || !s.done) h += groupHtml(k, emptyMsg(s), s);
  }
  if (s.filter === 'all' && s.done && !gridItems(s).length) h += emptyMsg(s);
  return h + peopleHtml(s);
}

function bodyHtml(s) {
  return '<div class="srch-top" id="srch-top">' + topHtml(s) + '</div>' +
    '<div class="srch-groups" id="srch-groups">' + groupsHtml(s) + '</div>';
}

function paintSession(s) {
  const body = bodyEl();
  if (!body) return;
  s.shown = true;
  body.innerHTML = bodyHtml(s);
  observeTiles(body);
  setStatus(statusText(s));
  applyRestore();
}

function paintLoading() {
  const body = bodyEl();
  if (!body) return;
  body.innerHTML = '<div class="srch-skel" aria-hidden="true"><span class="sk srch-skel-best"></span><span class="sk srch-skel-pill"></span>' +
    '<div class="srch-grid">' + Array.from({ length: 12 }, () => '<span class="sk sk-card"></span>').join('') + '</div></div>';
  setStatus('Recherche en cours');
}

function paintNone(s) {
  const body = bodyEl();
  if (!body) return;
  body.innerHTML = '<div class="srch-none">' +
    '<span class="srch-none-ico" aria-hidden="true">' + ICON.search + '</span>' +
    '<h2 class="srch-none-title">Aucun résultat pour « ' + esc(s.q) + ' »</h2>' +
    '<p class="srch-none-hint">Vérifie l’orthographe ou essaie le titre original.</p></div>';
  setStatus('Aucun résultat pour « ' + s.q + ' »');
}

function paintError() {
  const body = bodyEl();
  if (!body) return;
  body.innerHTML = '<div class="state srch-error" role="alert"><p>Recherche indisponible pour l’instant.</p>' +
    '<button type="button" class="btn btn-ghost" data-search-retry>Réessayer</button></div>';
  setStatus('Recherche indisponible');
}

/** État vide : recherches récentes du profil, puis tendances de la semaine. */
function paintEmpty(my) {
  const body = bodyEl();
  if (!body) return;
  const recent = loadRecent();
  body.innerHTML = (recent.length ? recentHtml(recent) : '') +
    '<section class="row-section srch-trend" aria-labelledby="srch-trend-h"><h2 class="row-title" id="srch-trend-h">Tendances de la semaine</h2>' +
    '<div class="row srch-row" id="srch-trend" data-nav>' + Array.from({ length: 6 }, () => '<span class="sk sk-card"></span>').join('') + '</div></section>';
  setStatus('');
  loadTrending(my);
}

async function loadTrending(my) {
  const row = detailEl.querySelector('#srch-trend');
  if (!row) return;
  try {
    const json = await tmdb('trending/all/week');
    if (my !== seq || state.kind !== 'search' || !row.isConnected) return;
    // Tendances : les genres bannis sont retirés (et non rangés en fin de liste).
    const items = await filterAvailable(filterResults(json.results, isKidProfile()).filter((r) => !isBannedGenre(homeFacts(r))).map((r) => register(toItem(r, r.media_type))));
    if (my !== seq || state.kind !== 'search' || !row.isConnected) return;
    row.innerHTML = items.length ? items.map((it) => posterCard(it)).join('') : '<p class="row-msg">Rien à afficher pour le moment.</p>';
    observeTiles(row);
  } catch (_) {
    const sec = row.closest('.srch-trend');
    if (sec && my === seq) sec.hidden = true;
  }
}

function recentHtml(list) {
  return '<section class="row-section srch-recent" aria-labelledby="srch-recent-h">' +
    '<div class="srch-sec-head"><h2 class="row-title" id="srch-recent-h">Recherches récentes</h2>' +
    '<button type="button" class="link-btn" data-recent-clear>Effacer</button></div>' +
    '<div class="pills" data-nav>' + list.map((q) => '<button type="button" class="pill" data-recent="' + esc(q) + '">' + esc(q) + '</button>').join('') + '</div></section>';
}

/** Changement de filtre : aucune requête, le haut et les groupes sont redessinés depuis les résultats déjà chargés. */
function setFilter(f) {
  const s = session;
  if (!s || !s.shown || f === s.filter) return;
  s.filter = f;
  s.lots = freshLots();
  s.gen += 1;
  s.failed = null;
  const top = detailEl.querySelector('#srch-top');
  const wrap = groupsEl();
  if (!top || !wrap) return;
  top.innerHTML = topHtml(s);
  const pressed = top.querySelector('[data-filter="' + f + '"]');
  if (pressed) pressed.focus({ preventScroll: true });
  wrap.innerHTML = groupsHtml(s);
  observeTiles(wrap);
  updateCounts(s);
}

function updateCounts(s) {
  const c = counts(s);
  detailEl.querySelectorAll('[data-count]').forEach((el) => { el.textContent = countText(s, c[el.dataset.count] ?? ''); });
}

/** Redessine les sections après un clic sur « Charger plus » ; le focus passe au premier résultat ajouté (ou reste sur le bouton s'il n'y en a pas). */
function repaintGroups(s, kind, prevCount, keyboard) {
  const wrap = groupsEl();
  if (!wrap || !isLive(s)) return;
  wrap.innerHTML = groupsHtml(s);
  observeTiles(wrap);
  updateCounts(s);
  if (prevCount == null) return; // le filtre a changé pendant le chargement : rien à annoncer ni à focaliser
  const shown = Math.min(sectionItems(s, kind).length, limitOf(s, kind));
  setStatus(s.failed === kind ? 'Chargement impossible, réessaie' : (GROUP_TITLE[kind] || 'Personnalités') + ' : ' + plural(shown, 'résultat affiché', 'résultats affichés'));
  const list = wrap.querySelector(kind === 'people' ? '#srch-people .srch-cast' : '#srch-grid-' + kind);
  const fresh = list && list.children[prevCount];
  const inside = (el) => (el && (el.matches('button, a[href]') ? el : el.querySelector('button, a[href]'))) || null;
  // Premier résultat ajouté, sinon le bouton ; sans bouton (liste finie), dernier résultat de la section, son titre, puis le filtre actif.
  const heading = wrap.querySelector(kind === 'people' ? '#srch-people-h' : '#srch-h-' + kind);
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  const target = inside(fresh) || wrap.querySelector('[data-more="' + kind + '"]') || inside(list && list.lastElementChild) || heading ||
    detailEl.querySelector('.srch-filters [aria-pressed="true"]');
  if (target) target.focus({ preventScroll: !keyboard });
}

/** « Charger plus » d'une section : affiche le lot suivant, après avoir chargé les pages manquantes si besoin. */
async function showMore(kind, keyboard) {
  const s = session;
  if (!s || !s.shown || s.loading || !isLive(s)) return;
  s.failed = null;
  const gen = s.gen;
  const prevCount = Math.min(sectionItems(s, kind).length, limitOf(s, kind));
  const nextLimit = sectionLimit(kind, s.filter, s.lots[kind] + 1);
  if (needsMore(sectionItems(s, kind).length, nextLimit, s.done)) {
    s.loading = true;
    const btn = detailEl.querySelector('[data-more="' + kind + '"]');
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Chargement…'; }
    try {
      for (let i = 0; i < MAX_PAGES_PER_CLICK && needsMore(sectionItems(s, kind).length, nextLimit, s.done); i += 1) {
        if (!(await fetchNext(s))) break;
      }
    } catch (_) {
      s.failed = kind;
    }
    s.loading = false;
    if (!isLive(s)) return;
    if (s.gen !== gen) { repaintGroups(s, kind, null, keyboard); return; }
    if (s.failed) { repaintGroups(s, kind, prevCount, keyboard); return; }
  }
  s.lots[kind] += 1;
  repaintGroups(s, kind, prevCount, keyboard);
}

// ---------- Recherches récentes (par profil, en local) ----------

function recentKey() {
  const id = auth.profile && auth.profile.id;
  return id ? RECENT_BASE + ':' + id : RECENT_BASE;
}

function loadRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey()) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, RECENT_MAX) : [];
  } catch (_) {
    return [];
  }
}

function saveRecent(q) {
  try {
    const list = loadRecent().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch (_) { /* stockage indisponible : pas de récentes */ }
}

function clearRecent() {
  try { localStorage.removeItem(recentKey()); } catch (_) { /* stockage indisponible */ }
}

// ---------- Interactions ----------

const syncClear = (el) => {
  const btn = el.closest('.search-bar') && el.closest('.search-bar').querySelector('[data-search-clear]');
  if (btn) btn.hidden = !el.value;
};

function searchNow(q) {
  const inp = input();
  if (inp) { inp.value = q; syncClear(inp); }
  clearTimeout(timer);
  run(q);
}

detailEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.name !== 'q' || !t.closest('#search-form')) return;
  syncClear(t);
  clearTimeout(timer);
  timer = setTimeout(() => run(t.value), DEBOUNCE_MS);
});

detailEl.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.name !== 'q' || e.key !== 'ArrowDown') return;
  // Depuis la barre : flèche bas rejoint le premier élément des résultats (télécommande, clavier).
  const first = Array.from(detailEl.querySelectorAll('#search-body [data-nav] :is(button, a[href])')).find((el) => el.getClientRects().length > 0);
  if (first) { e.preventDefault(); first.focus(); }
});

detailEl.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'search-form') { e.preventDefault(); clearTimeout(timer); run(e.target.elements.q.value); }
});

detailEl.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const filter = t.closest('[data-filter]');
  if (filter && detailEl.contains(filter)) { setFilter(filter.dataset.filter); return; }
  const recent = t.closest('[data-recent]');
  if (recent && detailEl.contains(recent)) { searchNow(recent.dataset.recent); return; }
  if (t.closest('[data-recent-clear]')) {
    clearRecent();
    const sec = t.closest('.srch-recent');
    if (sec) sec.remove();
    return;
  }
  if (t.closest('[data-search-clear]')) {
    const inp = input();
    if (inp) { inp.value = ''; syncClear(inp); inp.focus(); }
    searchNow('');
    return;
  }
  const more = t.closest('[data-more]');
  if (more && detailEl.contains(more)) { showMore(more.dataset.more, e.detail === 0); return; }
  if (t.closest('[data-search-retry]')) { session = null; run(state.searchQ); }
});

// Raccourci « / » : place le curseur dans la barre de recherche quand on est sur la page.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || state.kind !== 'search' || !modal.hidden) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
  const inp = input();
  if (!inp) return;
  e.preventDefault();
  inp.focus();
  inp.select();
});
