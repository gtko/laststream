/* Recherche (#/search) : meilleur résultat, filtres, titres classés (searchRank.js) et personnalités TMDB.
 * Les deux premières pages sont classées ensemble, puis les suivantes sont ajoutées en fin par défilement infini.
 * Profil enfant : genres jeunesse uniquement, pas de personnalités. */
import { infiniteList, stopInfinite } from './infinite.js';
import { applyRestore } from './router.js';
import { filterAvailable } from './avail.js';
import { todayStr } from './dates.js';
import { auth, isKidProfile } from '../data/auth';
import { kidGenreOk } from '../data/kid';
import { tmdb } from '../data/lt';
import { register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { detailEl, modal } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc, plural } from './util.js';
import { kindOf, rankResults, resultKey, titleMatch } from './searchRank.js';

const DEBOUNCE_MS = 300;
const RECENT_MAX = 8;
const PEOPLE_MAX = 12;
const BEST_MIN_SCORE = 60; // correspondance exacte ou préfixe du titre
const RECENT_BASE = 'laststream.search.recent';
const PILLS = [['all', 'Tout'], ['movie', 'Films'], ['tv', 'Séries'], ['people', 'Personnalités']];

let timer = null;
let seq = 0; // jeton de la dernière recherche lancée : une réponse plus ancienne est ignorée
let session = null; // { q, token, media, people, raw, seen, next, total, done, best, filter, shown }

export function showSearch() {
  teardownFiche();
  stopInfinite();
  seq += 1;
  session = null;
  state.kind = 'search';
  document.title = 'Recherche · Laststream';
  const q = state.searchQ || '';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page search-page" aria-labelledby="search-title">' +
    '<header class="search-head"><h1 class="search-title" id="search-title" tabindex="-1">Recherche</h1>' +
    '<form id="search-form" class="search-form" role="search">' +
    '<div class="search-bar"><label class="sr-only" for="search-input">Rechercher un film, une série ou une personnalité</label>' +
    '<span class="search-ico" aria-hidden="true">' + ICON.search + '</span>' +
    '<input id="search-input" class="search-input" type="search" name="q" autocomplete="off" enterkeyhint="search" placeholder="Films, séries, personnalités…" value="' + esc(q) + '">' +
    '<button type="button" class="search-clear" data-search-clear aria-label="Effacer la recherche"' + (q ? '' : ' hidden') + '>' + ICON.close + '</button>' +
    '</div></form></header>' +
    '<div class="search-body" id="search-body"></div>' +
    '<p class="sr-only" id="search-status" role="status" aria-live="polite"></p>' +
    '</article>';
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
const isLive = (s) => s.token === seq && state.kind === 'search';
const fetchPage = (q, page) => tmdb('search/multi', { query: q, include_adult: 'false', ...(page > 1 ? { page } : {}) });

/** Lance une recherche ; une requête identique à la requête affichée ne refait rien. */
async function run(raw) {
  const q = String(raw || '').trim();
  if (session && session.q === q && q.length >= 2) return;
  const my = ++seq;
  stopInfinite();
  session = null;
  state.searchQ = q;
  if (q.length < 2) { paintEmpty(my); return; }
  const s = { q, token: my, media: [], people: [], raw: new Map(), seen: new Set(), next: 3, total: 1, done: false, best: null, filter: 'all', shown: false };
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
  s.media = await ingest(s, first, true);
  if (!isLive(s)) return;
  s.best = pickBest(s);
  saveRecent(q);
  if (s.done && !s.media.length && !s.people.length) { paintNone(s); return; }
  paintSession(s);
}

/** Ajoute un lot de résultats bruts : dédoublonnage, classement, filtres, disponibilité. Renvoie les titres, classés. */
async function ingest(s, raws, first) {
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
  if (first) s.people = kid ? [] : ranked.filter((r) => kindOf(r) === 'person').slice(0, PEOPLE_MAX);
  const media = filterResults(ranked, kid);
  return filterAvailable(media.map((r) => register(toItem(r, r.media_type))));
}

/** Meilleur résultat : premier titre classé, avec affiche large, si son titre commence exactement par la requête. */
function pickBest(s) {
  const first = s.media[0];
  if (!first || !first.backdropPath) return null;
  const raw = s.raw.get(first.key);
  return raw && titleMatch(raw, s.q) >= BEST_MIN_SCORE ? first : null;
}

/** Page suivante du défilement infini : une page par appel ; les pages en échec sont rejouées. */
async function loadMore(s) {
  if (s.done || !isLive(s)) return { html: '', done: true };
  const page = s.next;
  s.next += 1;
  let json;
  try {
    json = await fetchPage(s.q, page);
  } catch (e) {
    s.next = page;
    throw e;
  }
  if (!isLive(s)) return { html: '', done: true };
  s.total = Number(json.total_pages) || s.total;
  const items = await ingest(s, json.results, false);
  if (!isLive(s)) return { html: '', done: true };
  s.media.push(...items);
  s.done = s.next > s.total;
  if (s.done && !s.media.length && !s.people.length) { paintNone(s); return { html: '', done: true }; }
  updateCounts(s);
  if (s.done) setStatus(statusText(s));
  const add = items.filter((it) => visibleInGrid(s, it));
  const html = add.length ? add.map((it) => posterCard(it)).join('') : (s.done && !gridItems(s).length ? emptyMsg(s) : '');
  return { html, done: s.done };
}

const inFilter = (it, f) => f === 'all' || (f === 'movie' && it.type === 'movie') || (f === 'tv' && it.type === 'tv');
/** Le meilleur résultat a sa propre carte dans la vue « Tout » : il n'est pas répété dans la grille. */
const visibleInGrid = (s, it) => inFilter(it, s.filter) && !(s.filter === 'all' && s.best && it.key === s.best.key);
const gridItems = (s) => s.media.filter((it) => visibleInGrid(s, it));

function counts(s) {
  const movie = s.media.filter((it) => it.type === 'movie').length;
  return { all: s.media.length + s.people.length, movie, tv: s.media.length - movie, people: s.people.length };
}

const statusText = (s) => {
  const n = s.media.length + s.people.length;
  return n ? plural(n, 'résultat', 'résultats') + ' pour « ' + s.q + ' »' : 'Aucun résultat pour « ' + s.q + ' »';
};

function setStatus(text) {
  const el = detailEl.querySelector('#search-status');
  if (el) el.textContent = text;
}

// ---------- Rendu ----------

const mediaTitle = (f) => (f === 'movie' ? 'Films' : f === 'tv' ? 'Séries' : 'Films et séries');

function emptyMsg(s) {
  if (!s.done || (s.filter === 'all' && s.best)) return '';
  const what = s.filter === 'movie' ? 'film' : s.filter === 'tv' ? 'série' : 'film ni série';
  return '<p class="row-msg">Aucun ' + what + ' pour cette recherche.</p>';
}

function gridHtml(s) {
  const items = gridItems(s);
  return items.length ? items.map((it) => posterCard(it)).join('') : emptyMsg(s);
}

function filtersHtml(s) {
  const c = counts(s);
  return PILLS.filter(([f]) => !(f === 'people' && isKidProfile())).map(([f, label]) =>
    '<button type="button" class="pill" data-filter="' + f + '" aria-pressed="' + (s.filter === f) + '">' + label +
    ' <span class="srch-n" data-count="' + f + '">' + c[f] + '</span></button>').join('');
}

function bestHtml(it) {
  const meta = [it.type === 'tv' ? 'Série' : 'Film', it.year, it.vote ? '★ ' + it.vote : ''].filter(Boolean);
  return '<section class="srch-best" data-nav aria-label="Meilleur résultat">' +
    '<div class="srch-best-media"><img src="' + esc(IMG('w1280', it.backdropPath)) + '" alt="" decoding="async"></div>' +
    '<div class="srch-best-shade" aria-hidden="true"></div>' +
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
  const ini = name.split(' ').map((w) => w[0] || '').slice(0, 2).join('');
  return '<li><a class="cast" href="#/person/' + esc(p.id) + '" data-person="' + esc(p.id) + '"' +
    ' aria-label="' + esc(name) + (known.length ? ', connu pour ' + esc(known.join(', ')) : '') + '">' +
    '<span class="cast-ph' + (photo ? '' : ' no-img') + '">' + (photo ? '<img src="' + esc(photo) + '" alt="" loading="lazy" decoding="async">' : '') +
    '<span class="cast-ini" aria-hidden="true">' + esc(ini) + '</span></span>' +
    '<span class="cast-name">' + esc(name) + '</span>' +
    (known.length ? '<span class="cast-role">Connu pour ' + esc(known.join(', ')) + '</span>' : '') + '</a></li>';
}

function topHtml(s) {
  const kid = isKidProfile();
  let h = '';
  if (s.best && s.filter === 'all') h += bestHtml(s.best);
  h += '<div class="pills srch-filters" role="group" aria-label="Filtrer les résultats" data-nav>' + filtersHtml(s) + '</div>';
  if (!kid && (s.filter === 'all' || s.filter === 'people') && s.people.length) {
    h += '<section class="srch-people row-section" aria-labelledby="srch-people-h"><h2 class="row-title" id="srch-people-h">Personnalités</h2>' +
      '<ul class="cast-row srch-cast" data-nav>' + s.people.map(personHtml).join('') + '</ul></section>';
  } else if (!kid && s.filter === 'people') {
    h += '<p class="row-msg">Aucune personnalité pour cette recherche.</p>';
  }
  return h;
}

function bodyHtml(s) {
  return '<div class="srch-top" id="srch-top">' + topHtml(s) + '</div>' +
    '<section class="srch-media" id="srch-media"' + (s.filter === 'people' ? ' hidden' : '') + '>' +
    '<h2 class="row-title" id="srch-media-h">' + mediaTitle(s.filter) + '</h2>' +
    '<div class="srch-grid" id="search-grid" data-nav>' + gridHtml(s) + '</div></section>';
}

function paintSession(s) {
  const body = bodyEl();
  if (!body) return;
  s.shown = true;
  body.innerHTML = bodyHtml(s);
  observeTiles(body);
  infiniteList({ host: body.querySelector('#search-grid'), load: () => loadMore(s), after: (h) => observeTiles(h) });
  setStatus(statusText(s));
  applyRestore();
}

function paintLoading() {
  const body = bodyEl();
  if (!body) return;
  body.innerHTML ='<div class="srch-skel" aria-hidden="true"><span class="sk srch-skel-best"></span><span class="sk srch-skel-pill"></span>' +
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
    const items = await filterAvailable(filterResults(json.results, isKidProfile()).map((r) => register(toItem(r, r.media_type))));
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

/** Changement de filtre : aucune requête, la grille et les blocs sont redessinés depuis les résultats déjà chargés. */
function setFilter(f) {
  const s = session;
  if (!s || !s.shown || f === s.filter) return;
  s.filter = f;
  const top = detailEl.querySelector('#srch-top');
  const media = detailEl.querySelector('#srch-media');
  const grid = detailEl.querySelector('#search-grid');
  if (!top || !media || !grid) return;
  top.innerHTML = topHtml(s);
  const pressed = top.querySelector('[data-filter="' + f + '"]');
  if (pressed) pressed.focus({ preventScroll: true });
  media.hidden = f === 'people';
  media.querySelector('#srch-media-h').textContent = mediaTitle(f);
  grid.innerHTML = gridHtml(s);
  observeTiles(grid);
  updateCounts(s);
}

function updateCounts(s) {
  const c = counts(s);
  detailEl.querySelectorAll('[data-count]').forEach((el) => { el.textContent = String(c[el.dataset.count] ?? ''); });
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
