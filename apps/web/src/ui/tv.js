/* Port du prototype (voir tools/port-prototype.mjs). */
import { infiniteList } from './infinite.js';
import { tvChannels, tvEpg, tvFacets, tvImport } from '../data/lt';
import { isKidProfile, kidSection } from '../data/auth';
import { getRegion, getVideoLang } from '../data/prefs';
import { channelNumber, langCode3, rankChannels, sameLang } from '../data/tvRank';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, svcError, topBar } from './fragments.js';
import { externalKind } from './tvExternal.js';
import { ICON } from './icons.js';
import { initialStatus } from './tvStatus.js';
import { state } from './state.js';
import { esc, names, store } from './util.js';

export const tv = {
  user: [], epg: new Map(), epgReq: new Set(), w0: 0,
  cat: 'Toutes', list: [], shown: 0, homeList: [], play: null,
  hls: null, hlsPromise: null, bannerTimer: null, stallTimer: null, playToken: 0, attempt: 0, info: false, opener: null, io: null,
  // Signal d'état du lecteur (tvStatus.js), son minuteur, et chaînes en échec pendant cette session (ids).
  status: initialStatus(), statusTimer: 0, failed: new Set(),
  // Catalogue : chaînes déjà chargées (par id), page courante du filtre, facettes, filtres.
  byId: new Map(), pageList: [], page: 0, hasMore: false, fetching: false, total: null,
  facets: null, catFacets: null, filters: null, qTimer: null,
};
export const TV_CATS = ['Toutes', 'Favoris', 'Info', 'Sport', 'Cinéma', 'Jeunesse', 'Musique', 'Divertissement', 'Documentaires', 'FAST', 'Ma playlist'];
export const PX_MIN = 160 / 30; // 30 min = 160 px
export const EPG_H = 6;
export const EPG_CH_W = 220;
export const playerEl = document.getElementById('player');
export const videoEl = document.getElementById('player-video');
export const bannerEl = document.getElementById('player-banner');
export const perrEl = document.getElementById('player-error');
export const statusEl = document.getElementById('player-status');
export const getFavs = () => store('ls_tv_fav') || [];
export const allChannels = () => Array.from(tv.byId.values()).concat(tv.user);
const FAV_SNAP_KEY = 'ls_tv_favch';
const FILTERS_KEY = 'ls_tv_filters';
const PAGE_LIMIT = 500; // maximum accepté par le serveur : la liste est classée ici, il faut donc tout le catalogue du pays
const SPECIAL_CATS = ['Toutes', 'Favoris', 'Ma playlist'];
export const favSnaps = () => store(FAV_SNAP_KEY) || {};
export { FAV_SNAP_KEY };

/** Filtres par défaut : pays de la région choisie, français, chaînes fiables. */
export const defaultFilters = () => ({ country: getRegion().code, language: langCode3(getVideoLang().lang) || 'fra', source: '', q: '', reliable: true });

export function initFilters() {
  if (!tv.filters) {
    tv.filters = Object.assign(defaultFilters(), store(FILTERS_KEY) || {});
    // Le serveur filtre en ISO 639-3 (« fra ») : un ancien réglage « fr » provoquerait une erreur 400.
    tv.filters.language = langCode3(tv.filters.language);
  }
  return tv.filters;
}
export const saveFilters = () => store(FILTERS_KEY, tv.filters);

/** Chaîne du catalogue étendu ou de l'ancien format : champs absents tolérés. */
export function normChannel(c) {
  const cats = Array.isArray(c.categories) ? c.categories : [];
  const low = c.reliability === 'low' || (c.reliability == null && !!c.flaky);
  return Object.assign({}, c, {
    cat: c.cat || (cats[0] && (cats[0].label || cats[0].id)) || '',
    lowRel: low,
    flaky: low,
    alternatives: Array.isArray(c.alternatives) ? c.alternatives.filter((a) => a && a.url) : [],
  });
}

/** Un filtre n'écarte une chaîne que si elle porte le champ concerné (ancien serveur : rien n'est écarté). */
/** TV jeunesse : seulement les chaînes classées jeunesse ou animation. */
export const isKidChannel = (c) => (Array.isArray(c.categories) && c.categories.some((k) => /^(kids?|animation|children|jeunesse|enfants?)$/i.test(k.id || k.label || '')))
  || /jeunesse|enfant|kids|anim|cartoon/i.test(c.cat || '');
const isKidCat = (k) => /^(kids?|animation|children|jeunesse|enfants?)$/i.test(k.id || k.label || '');

export function matchesFilters(c, f, cat) {
  if (isKidProfile() && !isKidChannel(c)) return false;
  if (f.country && c.country && String(c.country).toUpperCase() !== String(f.country).toUpperCase()) return false;
  if (f.language && Array.isArray(c.languages) && c.languages.length && !c.languages.some((l) => sameLang(l.code, f.language))) return false;
  if (f.source && c.source && c.source !== 'user' && c.source !== f.source) return false;
  if (f.q && !String(c.name || '').toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.reliable && c.lowRel) return false;
  if (cat && !SPECIAL_CATS.includes(cat)) {
    if (Array.isArray(c.categories) && c.categories.length) return c.categories.some((k) => k.id === cat || k.label === cat);
    return !c.cat || c.cat === cat;
  }
  return true;
}
export const epgKey = (c) => (c.source === 'user' ? c.epgId || '' : c.id);
export const fmtHM = (sec) => new Date(sec * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function tvWindow() {
  const now = Math.floor(Date.now() / 1000);
  const w0 = Math.floor((now - 1800) / 1800) * 1800;
  if (!tv.w0 || w0 - tv.w0 >= 3600) {
    if (tv.w0) { tv.epg.clear(); tv.epgReq.clear(); }
    tv.w0 = w0;
  }
  return tv.w0;
}

export function loadUserPlaylist() {
  const cfg = store('ls_tv_playlist');
  if (!cfg) { tv.user = []; return Promise.resolve(); }
  return tvImport(cfg).then((j) => { tv.user = j.channels || []; }).catch(() => { tv.user = []; });
}

export async function loadTvChannels() {
  // Rangée d'accueil : pays + langue de l'utilisateur, chaînes fiables seulement.
  const f = initFilters();
  const r = await fetchChannels({ country: f.country, language: langCode3(f.language), page: 1, limit: PAGE_LIMIT }, { country: f.country, language: f.language, reliable: true }, 'Toutes');
  return rankChannels(r.channels, f.country);
}

/** Une page de chaînes (serveur paginé) ou toute la liste (ancien serveur : filtrée ici, découpée à l'affichage). */
export async function fetchChannels(params, filters, cat) {
  const q = {};
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) q[k] = v; });
  // Page web : les chaînes qui exigent le relais HLS (absent sur Workers) sont filtrées côté serveur ; mpv et libVLC les gardent.
  if (!externalKind()) q.direct = 1;
  let res;
  try {
    res = await tvChannels(q);
  } catch (e) {
    // Filtre de langue refusé par le serveur : on le retire (il reste appliqué ici, chaîne par chaîne).
    if (!(q.language && e && e.status === 400)) throw e;
    delete q.language;
    res = await tvChannels(q);
  }
  const raw = Array.isArray(res) ? res : (res && (res.channels || res.items)) || [];
  const limit = Number(params.limit) || PAGE_LIMIT;
  const all = raw.map(normChannel);
  all.forEach((c) => tv.byId.set(c.id, c));
  const total = !Array.isArray(res) && res && typeof res.total === 'number' ? res.total : null;
  const legacy = raw.length > limit; // le serveur a ignoré country, limit et page
  const channels = all.filter((c) => matchesFilters(c, filters, cat));
  const hasMore = !legacy && (total != null ? (Number(params.page) || 1) * limit < total : raw.length >= limit);
  return { channels, hasMore, total, legacy };
}

function serverParams(page) {
  const f = initFilters();
  return { country: f.country, language: langCode3(f.language), source: f.source, q: f.q, page, limit: PAGE_LIMIT, category: SPECIAL_CATS.includes(tv.cat) ? '' : tv.cat };
}

export async function loadChannelsPage(reset) {
  if (reset) { tv.page = 0; tv.pageList = []; tv.hasMore = false; tv.total = null; }
  if (tv.cat === 'Favoris' || tv.cat === 'Ma playlist') return;
  if (tv.fetching) return;
  tv.fetching = true;
  try {
    const r = await fetchChannels(serverParams(tv.page + 1), initFilters(), tv.cat);
    tv.page += 1;
    const seen = new Set(tv.pageList.map((c) => c.id));
    rankChannels(r.channels, initFilters().country).forEach((c) => { if (!seen.has(c.id)) tv.pageList.push(c); });
    tv.hasMore = r.hasMore;
    tv.total = r.total;
  } finally {
    tv.fetching = false;
  }
}

function normFacet(x, labelOf) {
  if (!x) return [];
  const arr = Array.isArray(x)
    ? x.map((e) => ({ id: String(e.id != null ? e.id : e.code != null ? e.code : e.value != null ? e.value : ''), label: e.label || e.name || '', count: Number(e.count != null ? e.count : e.n) || 0 }))
    : Object.entries(x).map(([k, v]) => (typeof v === 'number' ? { id: k, label: '', count: v } : { id: k, label: (v && (v.label || v.name)) || '', count: Number(v && v.count) || 0 }));
  return arr.filter((e) => e.id).map((e) => Object.assign(e, { label: e.label || labelOf(e.id) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr'));
}

export function normFacets(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const f = {
    countries: normFacet(raw.countries || raw.country, (id) => names('region', id.toUpperCase())),
    languages: normFacet(raw.languages || raw.language, (id) => names('language', id)),
    categories: normFacet(raw.categories || raw.category, (id) => id),
    sources: normFacet(raw.sources || raw.source, (id) => id),
  };
  return f.countries.length || f.languages.length || f.categories.length || f.sources.length ? f : null;
}

export async function loadFacets() {
  const f = initFilters();
  tv.facets = normFacets(await tvFacets());
  tv.catFacets = normFacets(await tvFacets({ country: f.country, language: langCode3(f.language) })) || tv.facets;
}

export async function ensureEpg(chs) {
  const w0 = tvWindow();
  const keys = Array.from(new Set(chs.map(epgKey).filter((k) => k && !tv.epgReq.has(k))));
  keys.forEach((k) => tv.epgReq.add(k));
  const jobs = [];
  for (let i = 0; i < keys.length; i += 40) {
    const part = keys.slice(i, i + 40);
    jobs.push(tvEpg(part, w0, w0 + EPG_H * 3600)
      .then((list) => {
        part.forEach((k) => { if (!tv.epg.has(k)) tv.epg.set(k, []); });
        list.forEach((p) => tv.epg.get(p.channelId) && tv.epg.get(p.channelId).push(p));
      }).catch(() => { part.forEach((k) => tv.epgReq.delete(k)); }));
  }
  await Promise.all(jobs);
}

export function nowNext(c, now) {
  const arr = tv.epg.get(epgKey(c)) || [];
  const cur = arr.find((p) => p.start <= now && now < p.stop) || null;
  const next = arr.find((p) => p.start >= (cur ? cur.stop : now)) || null;
  return { cur, next };
}

// Rangée d'accueil « En direct maintenant »
export const numHTML = (c) => (channelNumber(c) ? '<b class="ch-num" aria-hidden="true">' + channelNumber(c) + '</b> ' : '');
export function liveTile(c, nn, now) {
  const pct = Math.max(0, Math.min(100, Math.round(((now - nn.cur.start) / (nn.cur.stop - nn.cur.start)) * 100)));
  return '<button type="button" class="live-tile" data-tvplay="' + esc(c.id) + '" data-tvctx="home" aria-label="' + esc((channelNumber(c) ? 'Chaîne ' + channelNumber(c) + ', ' : '') + c.name + ', en direct : ' + nn.cur.title + (nn.next ? ', ensuite : ' + nn.next.title : '')) + '">' +
    '<span class="lt-top"><span class="lt-logo">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="" loading="lazy" decoding="async">' : '<b>' + esc(c.name.slice(0, 3)) + '</b>') + '</span>' +
    '<span class="lt-name">' + numHTML(c) + esc(c.name) + '</span><span class="lt-live" aria-hidden="true">En direct</span></span>' +
    '<span class="lt-title" aria-hidden="true">' + esc(nn.cur.title) + '</span>' +
    '<span class="lt-next" aria-hidden="true">' + (nn.next ? 'Ensuite : ' + esc(nn.next.title) : '&nbsp;') + '</span>' +
    '<span class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></span></button>';
}

export async function renderLive() {
  try {
    if (state.status !== 'ready' || !document.getElementById('live-slot') || (isKidProfile() && !kidSection('tv'))) return;
    const chs = await loadTvChannels();
    const pool = chs.filter((c) => !c.fast).slice(0, 24).concat(chs.filter((c) => c.fast).slice(0, 12));
    await ensureEpg(pool);
    const now = Math.floor(Date.now() / 1000);
    // Seulement les chaînes dont le guide indique un programme en cours.
    const live = pool.map((c) => ({ c, nn: nowNext(c, now) })).filter((x) => x.nn.cur);
    const pick = live.filter((x) => !x.c.fast).slice(0, 8).concat(live.filter((x) => x.c.fast).slice(0, 4));
    const slot = document.getElementById('live-slot');
    if (!slot || !pick.length) return;
    tv.homeList = pick.map((x) => x.c);
    slot.innerHTML = '<section class="row-section" id="direct" aria-labelledby="h-direct"><h2 class="row-title" id="h-direct">En direct maintenant ' +
      '<a class="row-link" href="#/tv-live" data-tvlive>Guide TV</a></h2>' + row(pick.map((x) => liveTile(x.c, x.nn, now)).join('')) + '</section>';
  } catch (_) { /* rangée absente */ }
}

export function tvFilter() {
  const favs = getFavs();
  const cat = tv.cat;
  let l;
  if (cat === 'Favoris') {
    const snaps = favSnaps();
    l = favs.map((id) => tv.byId.get(id) || tv.user.find((c) => c.id === id) || (snaps[id] && normChannel(snaps[id]))).filter(Boolean);
  } else if (cat === 'Ma playlist') {
    l = tv.user.slice();
  } else {
    l = tv.pageList.filter((c) => matchesFilters(c, initFilters(), cat));
  }
  // Favoris d'abord, sans changer l'ordre du catalogue ensuite.
  return l.map((c, i) => ({ c, i })).sort((a, b) => (favs.includes(b.c.id) ? 1 : 0) - (favs.includes(a.c.id) ? 1 : 0) || a.i - b.i).map((x) => x.c);
}

export function catCount(cat) {
  if (cat === 'Favoris') return getFavs().length;
  if (cat === 'Ma playlist') return tv.user.length;
  const fx = tv.catFacets && tv.catFacets.categories.find((k) => k.id === cat || k.label === cat);
  if (fx) return fx.count;
  if (cat === 'Toutes') return tv.total != null ? tv.total : '';
  return tv.catFacets ? '' : tv.pageList.filter((c) => c.cat === cat).length;
}

export function catsHTML() {
  const kid = isKidProfile();
  const server = tv.catFacets && tv.catFacets.categories.length ? tv.catFacets.categories.filter((k) => !kid || isKidCat(k)).map((k) => ({ id: k.id, label: k.label })) : null;
  const list = ['Toutes', 'Favoris'].map((c) => ({ id: c, label: c }))
    .concat(server || TV_CATS.filter((c) => !SPECIAL_CATS.includes(c) && (!kid || /jeunesse/i.test(c))).map((c) => ({ id: c, label: c })))
    .concat(kid ? [] : [{ id: 'Ma playlist', label: 'Ma playlist' }]);
  return list.map((c) => {
    const n = catCount(c.id);
    return '<div data-nav><button type="button" class="tv-cat" data-tvcat="' + esc(c.id) + '" aria-pressed="' + (c.id === tv.cat) + '">' + esc(c.label) +
      (n === '' ? '' : ' <span>' + n + '</span>') + '</button></div>';
  }).join('');
}

const optHTML = (list, cur, allLabel, same) => '<option value="">' + esc(allLabel) + '</option>' + list.map((o) =>
  '<option value="' + esc(o.id) + '"' + ((same || ((a, b) => a.toLowerCase() === b.toLowerCase()))(o.id, String(cur || '')) ? ' selected' : '') + '>' + esc(o.label) + (o.count ? ' (' + o.count + ')' : '') + '</option>').join('');

/** Barre de filtres : pays, langue, catégorie, source, recherche et « Fiable ». */
export function filtersHTML() {
  const f = initFilters();
  const fx = tv.facets;
  const withCur = (list, cur, label, same) => {
    const eq = same || ((a, b) => a.toLowerCase() === b.toLowerCase());
    return cur && !list.some((o) => eq(o.id, cur)) ? [{ id: cur, label, count: 0 }].concat(list) : list;
  };
  const countries = fx ? fx.countries.map((o) => Object.assign({}, o, { label: o.label + ' · ' + o.id.toUpperCase() })) : [];
  const cList = withCur(countries, f.country, names('region', f.country) + ' · ' + f.country);
  const lList = withCur(fx ? fx.languages : [], f.language, names('language', f.language), sameLang);
  const catList = (tv.catFacets && tv.catFacets.categories) || [];
  const srcList = fx ? fx.sources : [];
  return '<form id="tv-filters" class="tv-filters" role="search" aria-label="Filtrer les chaînes">' +
    '<label class="tv-field">Pays<select name="country">' + optHTML(cList, f.country, 'Tous les pays') + '</select></label>' +
    '<label class="tv-field">Langue<select name="language">' + optHTML(lList, f.language, 'Toutes les langues', sameLang) + '</select></label>' +
    (catList.length ? '<label class="tv-field">Catégorie<select name="category">' + optHTML(catList, SPECIAL_CATS.includes(tv.cat) ? '' : tv.cat, 'Toutes les catégories') + '</select></label>' : '') +
    (srcList.length ? '<label class="tv-field">Source<select name="source">' + optHTML(srcList, f.source, 'Toutes les sources') + '</select></label>' : '') +
    '<label class="tv-field tvf-search">Recherche<input type="search" name="q" value="' + esc(f.q) + '" placeholder="Nom de la chaîne" autocomplete="off"></label>' +
    '<label class="set-check tvf-rel"><input type="checkbox" name="reliable"' + (f.reliable ? ' checked' : '') + '> <span>Fiable</span></label></form>';
}

export function settingsHTML() {
  const cfg = store('ls_tv_playlist') || { type: 'm3u' };
  const x = cfg.type === 'xtream';
  const v = (k) => esc(cfg[k] || '');
  return '<form id="tv-form" class="tv-form" autocomplete="off"><h2 class="f-sub">Ma playlist</h2>' +
    '<div class="tv-radios" role="radiogroup" aria-label="Type de playlist"><label><input type="radio" name="ttype" value="m3u"' + (x ? '' : ' checked') + '> Lien M3U</label>' +
    '<label><input type="radio" name="ttype" value="xtream"' + (x ? ' checked' : '') + '> Xtream Codes</label></div>' +
    '<div data-ttype="m3u"' + (x ? ' hidden' : '') + '><label class="tv-field">URL de la playlist M3U<input type="url" name="url" placeholder="https://exemple.fr/playlist.m3u" value="' + v('url') + '"></label></div>' +
    '<div data-ttype="xtream"' + (x ? '' : ' hidden') + '><label class="tv-field">Serveur<input type="text" name="server" placeholder="http://serveur:8080" value="' + v('server') + '"></label>' +
    '<label class="tv-field">Identifiant<input type="text" name="username" value="' + v('username') + '"></label>' +
    '<label class="tv-field">Mot de passe<input type="password" name="password" value="' + v('password') + '"></label></div>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-tvtest>Tester</button><button type="submit" class="btn btn-primary">Enregistrer et charger</button>' +
    '<button type="button" class="btn btn-ghost" data-tvclear>Retirer ma playlist</button></div>' +
    '<p class="tv-form-msg" id="tv-form-msg" role="status"></p>' +
    '<p class="tv-form-note">Enregistrée uniquement dans ce navigateur. Les identifiants sont transmis à ton serveur local pour lire la playlist, sans être enregistrés ni journalisés.</p></form>';
}

export function tvPageHTML() {
  const last = store('ls_tv_last');
  return topBar(false) +
    '<article class="tv-page" aria-labelledby="tv-title"><header class="tv-head"><div><p class="svc-eyebrow">Chaînes gratuites, FAST et ta playlist</p>' +
    '<h1 class="svc-title" id="tv-title" tabindex="-1">TV en direct</h1></div><div class="tv-head-actions" data-nav>' +
    (last ? '<button type="button" class="btn btn-primary" data-tvplay="' + esc(last.id) + '">' + ICON.play + '<span>Reprendre la dernière chaîne</span></button>' : '') +
    '<button type="button" class="btn btn-ghost" data-tvsettings aria-expanded="false">' + ICON.gear + '<span>Ma playlist</span></button></div></header>' +
    filtersHTML() + '<div class="tv-body"><nav class="tv-cats" id="tv-cats" aria-label="Catégories">' + catsHTML() + '</nav><div class="tv-main">' +
    '<div id="tv-settings" class="tv-settings glass" hidden>' + settingsHTML() + '</div>' +
    '<div class="tv-detail glass" id="tv-detail" aria-live="polite"><p class="tv-detail-hint">Sélectionne un programme pour voir le détail. Entrée lance la chaîne.</p></div>' +
    '<div class="epg" id="epg"></div></div></div></article>';
}

export function epgShell() {
  const w0 = tvWindow();
  const total = EPG_H * 60 * PX_MIN;
  let slots = '';
  for (let i = 0; i < EPG_H * 2; i++) slots += '<span class="epg-slot" style="width:' + 30 * PX_MIN + 'px">' + fmtHM(w0 + i * 1800) + '</span>';
  const nowPx = ((Math.floor(Date.now() / 1000) - w0) / 60) * PX_MIN;
  return '<div class="epg-scroll" id="epg-scroll"><div class="epg-inner" style="width:' + (EPG_CH_W + total) + 'px">' +
    '<div class="epg-times"><div class="epg-corner">Chaîne</div><div class="epg-slots">' + slots + '</div></div>' +
    '<div id="epg-rows"></div><div class="epg-now" id="epg-now" style="left:' + (EPG_CH_W + nowPx) + 'px" aria-hidden="true"></div></div></div>' +
    '<div class="epg-more" id="epg-more"></div>';
}

/** Chaîne en échec pendant cette session : grisée dans la liste (ses lignes déjà affichées sont mises à jour aussi). Redevient normale dès qu'elle repart. */
export function setChannelDown(id, down) {
  if (!id) return;
  if (down) tv.failed.add(id); else tv.failed.delete(id);
  const row = detailEl.querySelector('.epg-row[data-chid="' + String(id).replace(/"/g, '\\"') + '"]');
  if (row) row.classList.toggle('is-down', !!down);
}

export function epgRowHTML(c) {
  const fav = getFavs().includes(c.id);
  return '<div class="epg-row' + (tv.failed.has(c.id) ? ' is-down' : '') + '" data-nav data-chid="' + esc(c.id) + '"><div class="epg-chcol">' +
    '<button type="button" class="epg-ch" data-tvplay="' + esc(c.id) + '" data-tvctx="page" aria-label="Regarder ' + esc(c.name) + '">' +
    '<span class="epg-logo">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="" loading="lazy" decoding="async">' : '<b>' + esc(c.name.slice(0, 3)) + '</b>') + '</span>' +
    '<span class="epg-name">' + numHTML(c) + esc(c.name) + (c.flaky ? ' <em>instable</em>' : '') + '</span></button>' +
    '<button type="button" class="epg-fav" data-tvfav="' + esc(c.id) + '" aria-pressed="' + fav + '" aria-label="' + (fav ? 'Retirer des favoris : ' : 'Ajouter aux favoris : ') + esc(c.name) + '">' + (fav ? ICON.starOn : ICON.star) + '</button></div>' +
    '<div class="epg-line" style="width:' + EPG_H * 60 * PX_MIN + 'px"><span class="epg-load">Chargement…</span></div></div>';
}

export function fillEpgRow(c) {
  const line = detailEl.querySelector('.epg-row[data-chid="' + c.id.replace(/"/g, '\\"') + '"] .epg-line');
  if (!line) return;
  const w0 = tv.w0;
  const w1 = w0 + EPG_H * 3600;
  const now = Math.floor(Date.now() / 1000);
  const arr = tv.epg.get(epgKey(c)) || [];
  const cells = arr.filter((p) => p.stop > w0 && p.start < w1).map((p) => {
    const s = Math.max(p.start, w0);
    const e = Math.min(p.stop, w1);
    const left = ((s - w0) / 60) * PX_MIN;
    const width = Math.max(2, ((e - s) / 60) * PX_MIN - 3);
    const isNow = p.start <= now && now < p.stop;
    return '<button type="button" class="epg-cell' + (isNow ? ' is-now' : '') + '" style="left:' + left + 'px;width:' + width + 'px" data-tvprog="' + esc(c.id) + '|' + p.start +
      '" aria-label="' + esc(p.title + ', ' + fmtHM(p.start) + ' à ' + fmtHM(p.stop) + (isNow ? ', en cours' : '')) + '"><span class="ec-t">' + esc(p.title) + '</span><span class="ec-h">' + fmtHM(p.start) + '</span></button>';
  });
  line.innerHTML = cells.length ? cells.join('') :
    '<button type="button" class="epg-cell epg-none" style="left:0;width:' + (EPG_H * 60 * PX_MIN - 3) + 'px" data-tvplay="' + esc(c.id) + '" data-tvctx="page"><span class="ec-t">Programme indisponible</span><span class="ec-h">Regarder en direct</span></button>';
}

export function renderEpgGrid() {
  const epg = detailEl.querySelector('#epg');
  if (!epg) return;
  tv.list = tvFilter();
  tv.shown = 0;
  if (!tv.list.length) {
    epg.innerHTML = '<p class="row-msg">' + (tv.cat === 'Favoris' ? 'Aucun favori pour le moment : clique sur l’étoile d’une chaîne.' : tv.cat === 'Ma playlist' ? 'Aucune chaîne : ajoute une playlist avec le bouton « Ma playlist ».' : 'Aucune chaîne pour ces filtres : élargis le pays, la langue ou la recherche.') + '</p>';
    return;
  }
  epg.innerHTML = epgShell();
  const token = state.token;
  infiniteList({
    host: epg.querySelector('#epg-rows'),
    anchor: epg.querySelector('.epg-scroll'),
    skeleton: '<div class="epg-row epg-sk" aria-hidden="true"><div class="sk sk-line"></div></div>',
    skeletons: 3,
    load: async () => {
      // Liste locale d'abord ; quand elle est épuisée, page suivante du catalogue côté serveur.
      if (tv.shown >= tv.list.length && tv.hasMore) {
        try { await loadChannelsPage(false); } catch (_) { /* la liste reste telle quelle */ }
        if (token !== state.token) return { html: '', done: true };
        tv.list = tvFilter();
        refreshCats();
      }
      const batch = tv.list.slice(tv.shown, tv.shown + 40);
      tv.shown += batch.length;
      ensureEpg(batch).then(() => { if (token === state.token) batch.forEach(fillEpgRow); });
      return { html: batch.map(epgRowHTML).join(''), done: tv.shown >= tv.list.length && !tv.hasMore };
    },
  });
}

export function refreshCats() {
  const nav = detailEl.querySelector('#tv-cats');
  if (nav) nav.innerHTML = catsHTML();
}

export async function showTvLive() {
  teardownFiche();
  const token = state.token;
  state.kind = 'tvlive';
  document.title = 'TV en direct · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  try {
    initFilters();
    await Promise.all([loadChannelsPage(true), loadFacets().catch(() => {}), loadUserPlaylist()]);
  } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('La TV en direct n’a pas pu être chargée.');
    return;
  }
  if (token !== state.token) return;
  detailEl.innerHTML = tvPageHTML();
  const h1 = detailEl.querySelector('#tv-title');
  if (h1) h1.focus({ preventScroll: true });
  renderEpgGrid();
}

export function showProg(chId, start) {
  const c = allChannels().find((x) => x.id === chId);
  if (!c) return;
  const p = (tv.epg.get(epgKey(c)) || []).find((x) => x.start === Number(start));
  const box = detailEl.querySelector('#tv-detail');
  if (!p || !box) return;
  detailEl.querySelectorAll('.epg-cell.is-sel').forEach((el) => el.classList.remove('is-sel'));
  const cell = detailEl.querySelector('[data-tvprog="' + chId.replace(/"/g, '\\"') + '|' + start + '"]');
  if (cell) cell.classList.add('is-sel');
  const now = Math.floor(Date.now() / 1000);
  box.innerHTML = (p.icon ? '<img class="tvd-img" src="' + esc(p.icon) + '" alt="" loading="lazy">' : '') +
    '<div class="tvd-t"><p class="tvd-ch">' + esc(c.name) + '</p><h2 class="tvd-title">' + esc(p.title) + '</h2>' +
    '<p class="tvd-time">' + fmtHM(p.start) + ' – ' + fmtHM(p.stop) + ' · ' + Math.round((p.stop - p.start) / 60) + ' min' + (p.start <= now && now < p.stop ? ' · <strong>En cours</strong>' : '') + (p.category ? ' · ' + esc(p.category) : '') + '</p>' +
    (p.desc ? '<p class="tvd-desc">' + esc(p.desc) + '</p>' : '') +
    '<button type="button" class="btn btn-primary" data-tvplay="' + esc(c.id) + '" data-tvctx="page">' + ICON.play + '<span>Regarder</span></button></div>';
}

export async function tvTest(save) {
  const form = detailEl.querySelector('#tv-form');
  const msg = detailEl.querySelector('#tv-form-msg');
  if (!form || !msg) return;
  const f = form.elements;
  const type = f.ttype.value;
  const cfg = type === 'xtream'
    ? { type, server: f.server.value.trim(), username: f.username.value.trim(), password: f.password.value }
    : { type, url: f.url.value.trim() };
  msg.textContent = 'Test en cours…';
  try {
    const j = await tvImport(cfg);
    msg.textContent = j.count + ' chaîne' + (j.count > 1 ? 's' : '') + ' trouvée' + (j.count > 1 ? 's' : '') + '.';
    if (save) {
      store('ls_tv_playlist', cfg);
      tv.user = j.channels || [];
      refreshCats();
      renderEpgGrid();
    }
  } catch (_) {
    msg.textContent = 'Playlist inaccessible ou refusée. Vérifie l’adresse et tes identifiants.';
  }
}

/** Choix d'une catégorie (navigation latérale ou liste déroulante) : nouvelle requête au serveur. */
export async function setCategory(cat) {
  tv.cat = cat || 'Toutes';
  await reloadList();
  const nb = detailEl.querySelector('[data-tvcat="' + tv.cat.replace(/"/g, '\\"') + '"]');
  if (nb) nb.focus({ preventScroll: true });
}

/** Ajoute ou retire une chaîne des favoris ; garde un instantané pour l'afficher hors du filtre courant. */
export function toggleFav(id) {
  const favs = getFavs();
  const i = favs.indexOf(id);
  const snaps = favSnaps();
  if (i >= 0) { favs.splice(i, 1); delete snaps[id]; } else {
    favs.push(id);
    const c = tv.byId.get(id) || tv.user.find((x) => x.id === id);
    if (c) snaps[id] = c;
  }
  store('ls_tv_fav', favs);
  store(FAV_SNAP_KEY, snaps);
  return i < 0;
}

export async function reloadList() {
  const token = state.token;
  const epg = detailEl.querySelector('#epg');
  if (epg) epg.innerHTML = '<p class="row-msg" role="status">Chargement des chaînes…</p>';
  try { await loadChannelsPage(true); } catch (_) {
    if (epg && token === state.token) epg.innerHTML = '<p class="row-msg" role="alert">Les chaînes n’ont pas pu être chargées.</p>';
    return;
  }
  if (token !== state.token) return;
  refreshCats();
  renderEpgGrid();
}

function applyFilterField(t) {
  const f = initFilters();
  if (t.name === 'category') { setCategory(t.value); return; }
  if (t.name === 'reliable') f.reliable = t.checked;
  else if (t.name === 'q') f.q = t.value.trim();
  else if (t.name === 'language') f.language = langCode3(t.value);
  else f[t.name] = t.value;
  saveFilters();
  loadFacets().then(() => { if (state.kind === 'tvlive') refreshCats(); }).catch(() => {});
  reloadList();
}

detailEl.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && t.closest('#tv-filters') && t.name && t.name !== 'q') applyFilterField(t);
});
detailEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.name !== 'q' || !t.closest('#tv-filters')) return;
  clearTimeout(tv.qTimer);
  tv.qTimer = setTimeout(() => applyFilterField(t), 300);
});
detailEl.addEventListener('submit', (e) => {
  if (e.target && e.target.id === 'tv-filters') e.preventDefault();
});
