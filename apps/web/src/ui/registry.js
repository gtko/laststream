/* Accueil « long » : rangées définies dans src/data/rows.ts, chargées à la demande (2 rangées d'avance),
 * sans doublon excessif, avec « Tout voir » paginé (#/browse/:rowId). */
import { infiniteList } from './infinite.js';
import { applyRestore } from './router.js';
import { closeHover } from './hover.js';
import { filterAvailable } from './avail.js';
import { isReleasedItem, releasedParams, todayStr } from './dates.js';
import { isKidProfile, kidMaxAge, kidSection } from '../data/auth';
import { api, tmdb } from '../data/lt';
import { getRegion, getVideoLang } from '../data/prefs';
import { keepVisible } from '../data/homeFilters';
import { activeRows, Appearances, fillRow, passesQuality, pickSeed, rankTop, kidBase, makeCtx, MIN_ITEMS, PROBES, ROW_MAX, rowById, TOP_COUNT } from '../data/rows';
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
// Une graine ne pilote qu'une seule rangée personnalisée (« Parce que tu as regardé / aimé X »).
const seeds = new Map(); // identifiant de rangée -> graine
const usedSeeds = new Set();

function seedFor(def, candidates) {
  if (seeds.has(def.id)) return seeds.get(def.id);
  const pick = pickSeed(candidates, usedSeeds);
  if (!pick) return null;
  seeds.set(def.id, pick);
  usedSeeds.add(pick.key);
  return pick;
}

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
// Seuls les titres déjà sortis (hors rangées « Bientôt » : def.upcoming).
const toItems = (json, forced, upcoming) => {
  const l = listOf(json, forced);
  return l ? l.filter((it) => (it.poster || it.backdropPath) && (upcoming || (isReleasedItem(it) && passesQuality(it)))).map(register) : [];
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
  if (f.k === 'discover') return { title: def.title, items: toItems(await tmdb('discover/' + f.type, { ...releasedParams(f.type), ...f.params(ctx), ...pg }), f.type) };
  if (f.k === 'top10') {
    // Top 10 : une page des tendances de la semaine, filtrée côté serveur (titres disponibles dans la région). `raw` = titres
    // reçus de la source avant filtre (0 : fin de la source), pour que la rangée complète sa page suivante.
    const json = await api('top10/' + f.type, { page: String(page), region: getRegion().code, language: getVideoLang().tag });
    return { title: def.title, raw: typeof json?.raw === 'number' ? json.raw : 0, items: toItems(json, f.type) };
  }
  if (f.k === 'list') return { title: def.title, items: toItems(await tmdb(f.path, pg), f.type, def.upcoming) };
  if (f.k === 'collections') {
    if (page > 1) return { title: def.title, items: [] };
    const res = await Promise.allSettled(f.ids.map((id) => tmdb('collection/' + id)));
    const items = [];
    res.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const parts = (r.value.parts || []).filter((p) => p.poster_path).sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')));
      const first = parts.find((p) => p.release_date && p.release_date <= todayStr()); // la première partie déjà sortie
      if (first) items.push(register(listOf({ results: [first] }, 'movie')[0]));
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
      const params = { ...base, ...releasedParams(type), ...(type === 'tv' ? tvParams(extra) : extra), watch_region: ctx.region, with_watch_providers: sv.ids.join('|'), with_watch_monetization_types: 'flatrate|free|ads', ...pg };
      return toItems(await tmdb('discover/' + type, params), type);
    };
    if (f.type === 'both') {
      const [m, t] = await Promise.allSettled([one('movie'), one('tv')]);
      return { title: def.title, items: interleave(m.status === 'fulfilled' ? m.value : [], t.status === 'fulfilled' ? t.value : []) };
    }
    return { title: def.title, items: await one(f.type) };
  }
  if (f.k === 'because') {
    const src = seedFor(def, f.source === 'watched' ? watchedSources() : ratedSources());
    if (!src) return null;
    let items;
    if (f.source === 'watched') {
      // Recommandations de TMDB pour ce que tu as regardé.
      items = toItems(await tmdb(src.type + '/' + src.id + '/recommendations', pg), src.type);
    } else {
      // Titres aimés : « similaires » mêlés à une découverte par genres, pour ne pas répéter la rangée précédente.
      const detail = await tmdb(src.type + '/' + src.id).catch(() => null);
      const genres = ((detail && detail.genres) || []).slice(0, 2).map((g) => g.id).join(',');
      const [sim, disc] = await Promise.allSettled([
        tmdb(src.type + '/' + src.id + '/similar', pg),
        genres ? tmdb('discover/' + src.type, { ...releasedParams(src.type), with_genres: genres, sort_by: 'vote_average.desc', 'vote_count.gte': src.type === 'tv' ? '300' : '1000', ...pg }) : Promise.reject(new Error('genres')),
      ]);
      items = interleave(sim.status === 'fulfilled' ? toItems(sim.value, src.type) : [], disc.status === 'fulfilled' ? toItems(disc.value, src.type) : []);
    }
    items = items.filter((it) => it.key !== src.key);
    return { title: (f.source === 'watched' ? 'Parce que tu as regardé ' : 'Parce que tu as aimé ') + src.title, items };
  }
  if (f.k === 'person') {
    const p = followedPeople()[f.index];
    if (!p) return null;
    if (page > 1) return { title: 'Avec ' + (p.name || ''), items: [] };
    const j = await tmdb('person/' + p.id + '/combined_credits');
    const items = (j.cast || []).filter((c) => c.poster_path && (c.media_type === 'movie' || c.media_type === 'tv') && !(c.genre_ids || []).some((g) => g === 10767 || g === 10763))
      .filter((c) => (c.release_date || c.first_air_date || '9999') <= todayStr()).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 40).map((c) => register(listOf({ results: [c] }, c.media_type)[0]));
    return { title: 'Avec ' + (p.name || 'ta personnalité suivie'), items };
  }
  return null;
}

/**
 * Rangée telle qu'affichée sur l'accueil et dans « Tout voir » : titres déjà vus, masqués ou aux genres bannis retirés
 * (keepVisible). `raw` compte les titres de la page avant ce retrait : 0 signale la fin de la source.
 */
export async function resolveHomeRow(def, page = 1, ctx) {
  const res = await resolveRow(def, page, ctx);
  if (!res) return null;
  return { title: res.title, raw: res.raw ?? res.items.length, items: keepVisible(res.items) };
}

// ---------- Accueil : chargement progressif ----------
const reg = {
  token: 0,
  queue: [],
  prevKeys: new Set(),
  loaded: 0,
  lastRow: null,
  appear: new Appearances(),
  sentinel: null,
  io: null,
  busy: false,
  ctx: null,
  onDone: null,
  done: false,
  onScroll: null,
};

export function stopRegistry() {
  reg.token++;
  if (reg.io) reg.io.disconnect();
  reg.io = null;
  if (reg.onScroll) window.removeEventListener('scroll', reg.onScroll);
  reg.onScroll = null;
  reg.queue = [];
  reg.sentinel = null;
}

const near = () => {
  if (!reg.sentinel) return true;
  // Sans mise en page (page masquée, environnement de test) les rangées n'ont aucune hauteur : on s'arrête après 6 rangées.
  if (reg.lastRow && reg.lastRow.getBoundingClientRect().height === 0 && reg.loaded >= 6) return false;
  return reg.sentinel.getBoundingClientRect().top < window.innerHeight + AHEAD_PX;
};

function renderDef(def, title, items) {
  const link = def.noBrowse ? '' : ' <a class="row-link" href="#/browse/' + esc(def.id) + '" data-browse="' + esc(def.id) + '">Tout voir</a>';
  let html;
  if (def.kind === 'top10') html = row(rankTop(items).map(({ item, rank }) => topCard(item, rank)).join(''));
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
    // Les titres retirés par le filtre (déjà vus, masqués, genres bannis) sont remplacés par ceux des pages suivantes.
    const res = await fillRow(
      async (page) => (token === reg.token ? resolveHomeRow(def, page, reg.ctx) : null),
      def.kind === 'top10' ? TOP_COUNT : ROW_MAX,
      async (fresh) => {
        const open = fresh.filter((it) => reg.appear.canShow(it.key) && !reg.prevKeys.has(it.key));
        // Top 10 : la disponibilité est décidée côté serveur (une page déjà filtrée), jamais par tuile.
        return def.fetch.k === 'top10' ? open : filterAvailable(open, { cinema: def.cinema });
      },
    );
    if (token !== reg.token || !res) return;
    const items = res.items;
    if (items.length < (def.minItems || MIN_ITEMS)) return;
    items.forEach((it) => reg.appear.commit(it.key));
    reg.prevKeys = new Set(items.map((it) => it.key));
    const holder = document.createElement('div');
    holder.innerHTML = renderDef(def, res.title, items);
    const el = holder.firstElementChild;
    reg.sentinel.parentNode.insertBefore(el, reg.sentinel);
    observeTiles(el);
    reg.loaded += 1;
    reg.lastRow = el;
    closeHover(); // une aperçu ouvert ne doit pas rester figé au-dessus d'une mise en page qui bouge
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
  reg.prevKeys = new Set();
  reg.loaded = 0;
  reg.lastRow = null;
  seeds.clear();
  usedSeeds.clear();
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

export const browseAllowed = (id) => {
  const def = rowById(id);
  if (!def) return false;
  return isKidProfile() ? !!def.kid && (!def.section || kidSection(def.section)) : !def.kid;
};

export async function showBrowse(id) {
  teardownFiche();
  state.kind = 'browse';
  const def = browseAllowed(id) ? rowById(id) : null;
  const title = def ? def.title || 'Catalogue' : 'Catalogue';
  document.title = title + ' · Laststream';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="lib-grid" id="browse-grid" data-nav></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  const box = detailEl.querySelector('#browse-grid');
  if (!def) { box.innerHTML = '<p class="row-msg">Cette section n’est pas disponible.</p>'; return; }
  const ctx = makeCtx(getRegion().code, kidMaxAge());
  const token = state.token;
  const card = (it) => (def.kind === 'landscape' ? tileCard(it, { variant: 'land' }) : posterCard(it));
  const list = infiniteList({
    host: box,
    key: location.hash,
    restore: state.restoreY != null,
    load: async (page) => {
      // Une page entièrement filtrée (déjà vue, indisponible) ne doit pas arrêter la liste : on enchaîne jusqu'à 4 pages.
      const have = new Set(Array.from(box.querySelectorAll('[data-tile]')).map((e) => e.dataset.tile));
      for (let p = page, tries = 0; tries < 4; p += 1, tries += 1) {
        const res = await resolveHomeRow(def, p, ctx);
        if (token !== state.token) return { html: '', done: true };
        if (!res || res.raw === 0) return { html: '', done: true, };
        if (page === 1 && tries === 0 && h1) h1.textContent = res.title;
        const fresh = res.items.filter((it) => !have.has(it.key));
        const items = def.fetch.k === 'top10' ? fresh : (await filterAvailable(fresh, { cinema: def.cinema }));
        if (items.length) return { html: items.map(card).join(''), done: false, advance: p - page + 1 };
      }
      return { html: '', done: true };
    },
    after: (host) => observeTiles(host),
  });
  await list.ready;
  if (!box.children.length) box.innerHTML = '<p class="row-msg">Rien à voir ici pour le moment.</p>';
  applyRestore();
}
