/* Accueil et navigation du profil enfant : rangées TMDB (certification + genres jeunesse), héros sûr, pages « Tout voir ». */
import { kidMaxAge, kidSection } from '../data/auth';
import { certLteFor, kidAllows } from '../data/kid';
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { userStore } from '../data/userStore';
import { getDetail, listOf, register } from './catalog.js';
import { todayStr } from './dates.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { heroA } from './hero.js';
import { avatarStyle, continueSection, initialOf } from './home.js';
import { brand, row, section, topBar } from './fragments.js';
import { ICON } from './icons.js';
import { loadServices } from './services.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

const MOVIE_KID = '16|10751';
const TV_KID = '10762|16|10751';

/** Paramètres communs : région, certification maximale du pays et genres jeunesse (voir TMDB /certification). */
export function kidParams(type, extra) {
  const code = getRegion().code;
  const p = { include_adult: 'false', certification_country: code };
  const lte = certLteFor(code, kidMaxAge() || 12);
  if (lte) p['certification.lte'] = lte;
  p.with_genres = type === 'tv' ? TV_KID : MOVIE_KID;
  p.sort_by = 'popularity.desc';
  return Object.assign(p, extra || {});
}

/** Rangées du catalogue enfant : id (aussi identifiant de section parent), titre, type TMDB et paramètres. */
export const KID_ROWS = [
  { id: 'dessins', title: 'Dessins animés', type: 'movie', params: () => kidParams('movie', { with_genres: '16' }) },
  { id: 'famille', title: 'Films en famille', type: 'movie', params: () => kidParams('movie', { with_genres: '10751' }) },
  { id: 'series', title: 'Séries jeunesse', type: 'tv', params: () => kidParams('tv') },
  {
    id: 'disney', title: 'Les grands classiques Disney et Pixar', type: 'movie',
    params: () => kidParams('movie', { with_companies: '2|3|521|6704', sort_by: 'vote_average.desc', 'vote_count.gte': '1000' }),
  },
  { id: 'anime', title: 'Animés pour les jeunes', type: 'tv', params: () => kidParams('tv', { with_genres: '16', with_original_language: 'ja' }) },
  {
    id: 'nouveautes', title: 'Nouveautés jeunesse', type: 'movie',
    params: () => kidParams('movie', { sort_by: 'primary_release_date.desc', 'primary_release_date.lte': todayStr(), 'vote_count.gte': '20' }),
  },
];

const KID_PROVIDERS = [['disney-plus', 'Sur Disney+'], ['netflix', 'Netflix pour les petits']];

const toItems = (json, type) => {
  const l = listOf(json, type);
  return l ? l.filter((it) => it.poster).map(register) : null;
};

async function loadRow(def, page) {
  return toItems(await tmdb('discover/' + def.type, Object.assign(def.params(), page > 1 ? { page } : {})), def.type);
}

async function loadProviderRows() {
  if (!kidSection('plateformes')) return [];
  let services;
  try { services = await loadServices(); } catch (_) { return []; }
  const jobs = KID_PROVIDERS.map(([slug, title]) => {
    const sv = services.find((s) => s.slug === slug);
    if (!sv) return null;
    const params = kidParams('movie', { watch_region: getRegion().code, with_watch_providers: sv.ids.join('|'), with_watch_monetization_types: 'flatrate|free|ads' });
    const tvParams = kidParams('tv', { watch_region: getRegion().code, with_watch_providers: sv.ids.join('|'), with_watch_monetization_types: 'flatrate|free|ads' });
    return Promise.allSettled([tmdb('discover/movie', params), tmdb('discover/tv', tvParams)]).then(([m, t]) => {
      const ms = m.status === 'fulfilled' ? toItems(m.value, 'movie') || [] : [];
      const ts = t.status === 'fulfilled' ? toItems(t.value, 'tv') || [] : [];
      const mixed = [];
      for (let i = 0; i < Math.max(ms.length, ts.length); i++) { if (ms[i]) mixed.push(ms[i]); if (ts[i]) mixed.push(ts[i]); }
      return { id: 'prov-' + slug, title, items: mixed.slice(0, 20) };
    });
  }).filter(Boolean);
  return (await Promise.all(jobs)).filter((r) => r.items.length);
}

/** Héros : premier titre jeunesse autorisé qui a une bande-annonce. */
async function pickKidHero(rows) {
  const pool = [];
  ['famille', 'dessins', 'nouveautes', 'disney', 'series'].forEach((id) => (rows[id] || []).filter((it) => it.backdropPath).slice(0, 4).forEach((it) => pool.push(it)));
  const cands = pool.filter((it, i) => pool.findIndex((x) => x.key === it.key) === i).slice(0, 10);
  const details = await Promise.all(cands.map((it) => getDetail(it)));
  const ok = (i) => details[i] && kidAllows(details[i].cert, kidMaxAge());
  const withTrailer = cands.findIndex((_, i) => ok(i) && details[i].trailer);
  return withTrailer >= 0 ? cands[withTrailer] : null;
}

export async function loadKidsHome() {
  const defs = KID_ROWS.filter((d) => kidSection(d.id));
  const settled = await Promise.allSettled(defs.map((d) => loadRow(d, 1)));
  const rows = {};
  defs.forEach((d, i) => { rows[d.id] = settled[i].status === 'fulfilled' ? settled[i].value : null; });
  if (defs.length && Object.values(rows).every((v) => v === null)) throw new Error('catalogue indisponible');
  const providers = await loadProviderRows();
  providers.forEach((p) => p.items.forEach(register));
  const hero = await pickKidHero(rows);
  return { kids: true, hero, rows, providers, defs };
}

// ---------- Vue ----------
export function headerKids() {
  const name = userStore.currentProfile().name;
  const links = [['dessins', 'Dessins animés'], ['famille', 'Films'], ['series', 'Séries']].filter(([id]) => kidSection(id))
    .map(([id, label]) => '<a href="#' + id + '" data-scroll="' + id + '">' + label + '</a>').join('');
  return '<header class="topbar">' + brand() + '<nav class="nav" aria-label="Principale">' +
    '<a href="#/" data-noop class="is-current" aria-current="page">Accueil</a>' + links +
    (kidSection('tv') ? '<a href="#/tv-live" data-tvlive>TV jeunesse</a>' : '') +
    '<a href="#/library" data-libnav>Mes favoris</a></nav>' +
    '<div class="top-actions"><button type="button" class="icon-btn" data-search aria-label="Rechercher">' + ICON.search + '</button>' +
    '<button type="button" class="avatar" data-settings' + avatarStyle() + ' aria-label="Profil ' + esc(name) + ', changer de profil">' + esc(initialOf()) + '</button></div></header>';
}

export function viewKids(d) {
  const name = userStore.currentProfile().name;
  const rowsHtml = d.defs.map((def) => {
    const list = d.rows[def.id];
    if (Array.isArray(list) && !list.length) return '';
    return section(def.id, def.title, list, (l) => row(l.map((it) => posterCard(it)).join(''))).replace('</h2>',
      ' <a class="row-link" href="#/browse/' + def.id + '" data-browse="' + def.id + '">Tout voir</a></h2>');
  }).join('');
  const provHtml = d.providers.map((p) => section(p.id, p.title, p.items, (l) => row(l.map((it) => posterCard(it)).join('')))).join('');
  return '<main id="main" class="page-a page-kids">' + headerKids() + heroA(d.hero, 'Pour toi, ' + name) +
    '<div class="rows"><h1 class="kid-hello">Salut ' + esc(name) + ' !</h1>' +
    '<div id="cont-slot">' + continueSection() + '</div>' + '<div id="lib-slot"></div>' +
    rowsHtml +
    provHtml + '<div id="live-slot"></div></div></main>';
}

// ---------- « Tout voir » ----------
const browse = { def: null, page: 0, done: false, busy: false, token: 0 };

async function fillBrowse(token) {
  const box = detailEl.querySelector('#browse-grid');
  const more = detailEl.querySelector('#browse-more');
  if (!box || browse.busy) return;
  browse.busy = true;
  try {
    browse.page += 1;
    const items = (await loadRow(browse.def, browse.page)) || [];
    if (token !== state.token) return;
    if (!items.length) browse.done = true;
    box.insertAdjacentHTML('beforeend', items.map((it) => posterCard(it)).join(''));
    observeTiles(box);
    if (browse.page === 1 && !items.length) box.innerHTML = '<p class="row-msg">Rien à voir ici pour le moment.</p>';
  } catch (_) {
    if (token === state.token) box.insertAdjacentHTML('beforeend', '<p class="row-msg" role="status">Impossible de charger la suite.</p>');
    browse.done = true;
  } finally {
    browse.busy = false;
  }
  if (more && token === state.token) more.innerHTML = browse.done || browse.page >= 10 ? '' : '<button type="button" class="btn btn-ghost" data-browse-more>Afficher plus</button>';
}

export async function showBrowse(id) {
  teardownFiche();
  state.kind = 'browse';
  const def = KID_ROWS.find((d) => d.id === id && kidSection(d.id));
  const title = def ? def.title : 'Catalogue';
  document.title = title + ' · Laststream';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="lib-grid" id="browse-grid" data-nav></div><div class="epg-more" id="browse-more"></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  if (!def) { detailEl.querySelector('#browse-grid').innerHTML = '<p class="row-msg">Cette section n’est pas disponible.</p>'; return; }
  Object.assign(browse, { def, page: 0, done: false, busy: false });
  fillBrowse(state.token);
}

export function browseMore() {
  if (browse.def && !browse.done) fillBrowse(state.token);
}
