/* Accueil « long » : rangées définies dans src/data/rows.ts, chargées à la demande (2 rangées d'avance),
 * sans doublon excessif, avec « Tout voir » paginé (#/browse/:rowId). */
import { isKidProfile, kidMaxAge, kidSection } from '../data/auth';
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { activeRows, Appearances, kidBase, makeCtx, MIN_ITEMS, PROBES, ROW_MAX, rowById } from '../data/rows';
import { userStore } from '../data/userStore';
import { listOf, register } from './catalog.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, section, topBar } from './fragments.js';
import { loadServices } from './services.js';
import { state } from './state.js';
import { observeTiles, posterCard, tileCard, topCard } from './tiles.js';
import { esc } from './util.js';

const AHEAD_PX = 700; // environ deux rangées d'avance

// ---------- Paramètres pris en charge par le serveur ----------
const probes = new Map();

/** Vérifie une fois (avec une valeur impossible) que lastAddon applique bien le paramètre ; sinon la rangée est masquée. */
export function supports(param) {
  const spec = PROBES[param];
  if (!spec) return Promise.resolve(true); // paramètre historique de la liste blanche
  if (!probes.has(param)) {
    probes.set(param, tmdb('discover/' + spec.type, { include_adult: 'false', ...spec.params })
      .then((j) => (spec.mode === 'lowTop' ? !j.results.length || (j.results[0].vote_count || 0) <= 5 : !(j.results && j.results.length)))
      .catch(() => false));
  }
  return probes.get(param);
}

export async function rowAvailable(def) {
  if (!def.needs || !def.needs.length) return true;
  return (await Promise.all(def.needs.map(supports))).every(Boolean);
}

// ---------- Sources personnalisées ----------
function watchedSources() {
  const seen = new Set();
  const out = [];
  const add = (e) => { if (e.key && e.title && !seen.has(e.key)) { seen.add(e.key); out.push({ key: e.key, type: e.type, id: e.id, title: e.title }); } };
  userStore.continueWatching(50).forEach(add);
  userStore.getLibrary().sort((a, b) => b.addedAt - a.addedAt).forEach((e) => add({ key: e.type + ':' + e.id, type: e.type, id: e.id, title: e.title }));
  return out;
}

function ratedSources() {
  const list = (userStore.getRatings ? userStore.getRatings() : []).filter((r) => r.rating >= 4 && r.title);
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((r) => ({ key: r.type + ':' + r.id, type: r.type, id: r.id, title: r.title }));
}

const followedPeople = () => (userStore.getFollows ? userStore.getFollows('person').map((p) => ({ id: p.id, name: p.title })) : []);

// ---------- Récupération ----------
const toItems = (json, forced) => {
  const l = listOf(json, forced);
  return l ? l.filter((it) => it.poster).map(register) : [];
};

function interleave(a, b) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    [a[i], b[i]].forEach((it) => { if (it && !seen.has(it.key)) { seen.add(it.key); out.push(it); } });
  }
  return out;
}

const tvParams = (p) => {
  const out = {};
  Object.entries(p).forEach(([k, v]) => {
    out[k.replace('primary_release_date', 'first_air_date')] = String(v).replace('primary_release_date', 'first_air_date');
  });
  return out;
};

/** Titre et titres d'une rangée (page 1 par défaut). Null si la rangée n'a pas de source (rien regardé, rien noté…). */
export async function resolveRow(def, page = 1, ctx = makeCtx(getRegion().code, kidMaxAge())) {
  const f = def.fetch;
  const pg = page > 1 ? { page } : {};
  if (f.k === 'discover') return { title: def.title, items: toItems(await tmdb('discover/' + f.type, { ...f.params(ctx), ...pg }), f.type) };
  if (f.k === 'list') return { title: def.title, items: toItems(await tmdb(f.path, pg), f.type) };
  if (f.k === 'collections') {
    if (page > 1) return { title: def.title, items: [] };
    const res = await Promise.allSettled(f.ids.map((id) => tmdb('collection/' + id)));
    const items = [];
    res.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const parts = (r.value.parts || []).filter((p) => p.poster_path).sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')));
      if (parts[0]) items.push(register(listOf({ results: [parts[0]] }, 'movie')[0]));
    });
    return { title: def.title, items };
  }
  if (f.k === 'provider') {
    let services;
    try { services = await loadServices(); } catch (_) { return null; }
    const sv = services.find((s) => s.slug === f.slug);
    if (!sv) return null;
    const one = async (type) => {
      const base = def.kid ? kidBase(ctx, type) : { sort_by: 'popularity.desc', include_adult: 'false' };
      const extra = f.params ? f.params(ctx) : {};
      const params = { ...base, ...(type === 'tv' ? tvParams(extra) : extra), watch_region: ctx.region, with_watch_providers: sv.ids.join('|'), with_watch_monetization_types: 'flatrate|free|ads', ...pg };
      return toItems(await tmdb('discover/' + type, params), type);
    };
    if (f.type === 'both') {
      const [m, t] = await Promise.allSettled([one('movie'), one('tv')]);
      return { title: def.title, items: interleave(m.status === 'fulfilled' ? m.value : [], t.status === 'fulfilled' ? t.value : []) };
    }
    return { title: def.title, items: await one(f.type) };
  }
  if (f.k === 'because') {
    const src = (f.source === 'watched' ? watchedSources() : ratedSources())[f.index];
    if (!src) return null;
    const items = toItems(await tmdb(src.type + '/' + src.id + '/recommendations', pg), src.type).filter((it) => it.key !== src.key);
    return { title: (f.source === 'watched' ? 'Parce que tu as regardé ' : 'Parce que tu as aimé ') + src.title, items };
  }
  if (f.k === 'person') {
    const p = followedPeople()[f.index];
    if (!p) return null;
    if (page > 1) return { title: 'Avec ' + (p.name || ''), items: [] };
    const j = await tmdb('person/' + p.id + '/combined_credits');
    const items = (j.cast || []).filter((c) => c.poster_path && (c.media_type === 'movie' || c.media_type === 'tv') && !(c.genre_ids || []).some((g) => g === 10767 || g === 10763))
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 40).map((c) => register(listOf({ results: [c] }, c.media_type)[0]));
    return { title: 'Avec ' + (p.name || 'ta personnalité suivie'), items };
  }
  return null;
}

// ---------- Accueil : chargement progressif ----------
const reg = { token: 0, queue: [], appear: new Appearances(), sentinel: null, io: null, busy: false, ctx: null, onDone: null, done: false, onScroll: null };

export function stopRegistry() {
  reg.token++;
  if (reg.io) reg.io.disconnect();
  reg.io = null;
  if (reg.onScroll) window.removeEventListener('scroll', reg.onScroll);
  reg.onScroll = null;
  reg.queue = [];
  reg.sentinel = null;
}

const near = () => !reg.sentinel || reg.sentinel.getBoundingClientRect().top < window.innerHeight + AHEAD_PX;

function renderDef(def, title, items) {
  const link = def.noBrowse ? '' : ' <a class="row-link" href="#/browse/' + esc(def.id) + '" data-browse="' + esc(def.id) + '">Tout voir</a>';
  let html;
  if (def.kind === 'top10') html = row(items.slice(0, 10).map((it, i) => topCard(it, i + 1)).join(''));
  else if (def.kind === 'landscape') html = row(items.map((it) => tileCard(it, { variant: 'land' })).join(''));
  else if (def.kind === 'logoCard') html = row(items.map((it) => tileCard(it, { variant: 'logo' })).join(''));
  else html = row(items.map((it) => posterCard(it)).join(''));
  return section(def.id, title, items, () => html).replace('</h2>', link + '</h2>');
}

async function loadNext() {
  const def = reg.queue.shift();
  const token = reg.token;
  if (!def) return;
  try {
    if (!(await rowAvailable(def))) return;
    const res = await resolveRow(def, 1, reg.ctx);
    if (token !== reg.token || !res) return;
    const items = res.items.filter((it) => reg.appear.canShow(it.key)).slice(0, def.kind === 'top10' ? 10 : ROW_MAX);
    if (items.length < (def.minItems || MIN_ITEMS)) return;
    items.forEach((it) => reg.appear.commit(it.key));
    const holder = document.createElement('div');
    holder.innerHTML = renderDef(def, res.title, items);
    const el = holder.firstElementChild;
    reg.sentinel.parentNode.insertBefore(el, reg.sentinel);
    observeTiles(el);
  } catch (_) { /* rangée absente */ }
}

async function pump() {
  if (reg.busy) return;
  reg.busy = true;
  const token = reg.token;
  try {
    while (token === reg.token && reg.queue.length && near()) await loadNext();
    if (token === reg.token && !reg.queue.length && !reg.done) {
      reg.done = true;
      if (reg.sentinel) reg.sentinel.remove();
      if (reg.onDone) reg.onDone();
    }
  } finally {
    reg.busy = false;
  }
}

/** Démarre le chargement des rangées dans #reg-slot. `onDone` est appelé quand toutes ont été traitées (Services, Ma bibliothèque). */
export function startRegistry(opts = {}) {
  stopRegistry();
  const slot = document.getElementById('reg-slot');
  if (!slot) { if (opts.onDone) opts.onDone(); return; }
  const kid = isKidProfile();
  reg.ctx = makeCtx(getRegion().code, kidMaxAge());
  reg.queue = activeRows(reg.ctx, kid, kidSection).slice();
  reg.appear = new Appearances();
  reg.done = false;
  reg.onDone = opts.onDone || null;
  (opts.seen || []).forEach((k) => reg.appear.commit(k));
  state.top10.forEach((_, k) => reg.appear.commit(k));
  slot.innerHTML = '<div class="reg-sentinel" aria-hidden="true"></div>';
  reg.sentinel = slot.firstElementChild;
  if ('IntersectionObserver' in window) {
    reg.io = new IntersectionObserver(() => { pump(); }, { rootMargin: '0px 0px ' + AHEAD_PX + 'px 0px' });
    reg.io.observe(reg.sentinel);
  }
  reg.onScroll = () => { pump(); };
  window.addEventListener('scroll', reg.onScroll, { passive: true });
  pump();
}

// ---------- « Tout voir » ----------
const browse = { def: null, page: 0, done: false, busy: false, ctx: null };

export const browseAllowed = (id) => {
  const def = rowById(id);
  if (!def) return false;
  return isKidProfile() ? !!def.kid && (!def.section || kidSection(def.section)) : !def.kid;
};

async function fillBrowse(token) {
  const box = detailEl.querySelector('#browse-grid');
  const more = detailEl.querySelector('#browse-more');
  if (!box || browse.busy) return;
  browse.busy = true;
  try {
    browse.page += 1;
    const res = await resolveRow(browse.def, browse.page, browse.ctx);
    if (token !== state.token) return;
    const have = new Set(Array.from(box.querySelectorAll('[data-tile]')).map((e) => e.dataset.tile));
    const items = ((res && res.items) || []).filter((it) => !have.has(it.key));
    if (!items.length) browse.done = true;
    if (browse.page === 1) {
      const h1 = detailEl.querySelector('#svc-title');
      if (h1 && res) h1.textContent = res.title;
      if (!items.length) box.innerHTML = '<p class="row-msg">Rien à voir ici pour le moment.</p>';
    }
    box.insertAdjacentHTML('beforeend', items.map((it) => (browse.def.kind === 'landscape' ? tileCard(it, { variant: 'land' }) : posterCard(it))).join(''));
    observeTiles(box);
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
  const def = browseAllowed(id) ? rowById(id) : null;
  const title = def ? def.title || 'Catalogue' : 'Catalogue';
  document.title = title + ' · Laststream';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="lib-grid" id="browse-grid" data-nav></div><div class="epg-more" id="browse-more"></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  if (!def) { detailEl.querySelector('#browse-grid').innerHTML = '<p class="row-msg">Cette section n’est pas disponible.</p>'; return; }
  Object.assign(browse, { def, page: 0, done: false, busy: false, ctx: makeCtx(getRegion().code, kidMaxAge()) });
  fillBrowse(state.token);
}

export function browseMore() {
  if (browse.def && !browse.done) fillBrowse(state.token);
}

