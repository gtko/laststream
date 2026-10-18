/* Port du prototype (voir tools/port-prototype.mjs). */
import { releasedParams, todayStr } from './dates.js';
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, svcError, topBar } from './fragments.js';
import { state } from './state.js';
import { observeTiles, posterCard, tileCard } from './tiles.js';
import { esc } from './util.js';

// ---------- Services de streaming ----------
export const SERVICE_DEFS = [
  { slug: 'netflix', label: 'Netflix', re: /^netflix/, color: '#E50914' },
  { slug: 'prime-video', label: 'Prime Video', re: /^(amazon )?prime video/, color: '#00A8E1' },
  { slug: 'disney-plus', label: 'Disney+', re: /^disney/, color: '#113CCF' },
  { slug: 'canal-plus', label: 'Canal+', re: /^canal\+/, color: '#000000', outline: true },
  { slug: 'apple-tv-plus', label: 'Apple TV+', re: /^apple tv/, color: '#1D1D1F' },
  { slug: 'max', label: 'Max', re: /^(hbo )?max\b/, color: '#002BE7' },
  { slug: 'paramount-plus', label: 'Paramount+', re: /^paramount/, color: '#0064FF' },
  { slug: 'crunchyroll', label: 'Crunchyroll', re: /^crunchyroll/, color: '#F47521' },
  { slug: 'ocs', label: 'OCS', re: /^ocs/, color: '#17151f' },
  { slug: 'adn', label: 'ADN', re: /^(adn|animation digital)/, color: '#17151f' },
  { slug: 'france-tv', label: 'France TV', re: /^france[ .]?tv/, color: '#17151f' },
  { slug: 'arte', label: 'Arte', re: /^arte/, color: '#17151f' },
  { slug: 'mubi', label: 'MUBI', re: /^mubi/, color: '#17151f' },
  { slug: 'pluto-tv', label: 'Pluto TV', re: /^pluto/, color: '#17151f' },
  { slug: 'molotov', label: 'Molotov', re: /^molotov/, color: '#17151f' },
];
export const SERVICE_CANON = {
  netflix: /^netflix$/, 'prime-video': /^amazon prime video$/, 'disney-plus': /^disney plus$/, 'canal-plus': /^canal\+$/,
  'apple-tv-plus': /^apple tv(\+| plus)$/, max: /^(max|hbo max)$/, 'paramount-plus': /^paramount(\+| plus)$/, crunchyroll: /^crunchyroll$/,
};
let servicesPromise = null;

export function loadServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const res = await Promise.allSettled([
        tmdb('watch/providers/movie', { watch_region: getRegion().code }),
        tmdb('watch/providers/tv', { watch_region: getRegion().code }),
      ]);
      const byId = new Map();
      res.forEach((r) => {
        if (r.status !== 'fulfilled') return;
        ((r.value && r.value.results) || []).forEach((pv) => { if (!byId.has(pv.provider_id)) byId.set(pv.provider_id, pv); });
      });
      if (!byId.size) throw new Error('services indisponibles');
      const all = Array.from(byId.values());
      const out = [];
      SERVICE_DEFS.forEach((def) => {
        const found = all.filter((pv) => def.re.test(String(pv.provider_name || '').toLowerCase()))
          .sort((a, b) => (a.display_priority || 999) - (b.display_priority || 999));
        if (!found.length) return;
        const canon = SERVICE_CANON[def.slug];
        const withLogo = found.filter((pv) => pv.logo_path);
        const logoPv = (canon && withLogo.find((pv) => canon.test(String(pv.provider_name).toLowerCase())))
          || withLogo.slice().sort((a, b) => String(a.provider_name).length - String(b.provider_name).length)[0];
        out.push({
          slug: def.slug, name: def.label, color: def.color, outline: !!def.outline,
          ids: found.map((pv) => pv.provider_id),
          logo: logoPv ? IMG('w154', logoPv.logo_path) : '',
        });
      });
      return out;
    })();
    servicesPromise.catch(() => { servicesPromise = null; });
  }
  return servicesPromise;
}

export function svcTile(sv) {
  return '<button type="button" class="svc' + (sv.outline ? ' svc-outline' : '') + '" data-service="' + esc(sv.slug) + '" style="--svc:' + esc(sv.color) + '" aria-label="' + esc(sv.name) + '">' +
    (sv.logo ? '<img src="' + esc(sv.logo) + '" alt="" loading="lazy" decoding="async">' : '<span class="svc-name" aria-hidden="true">' + esc(sv.name) + '</span>') +
    '<span class="sr-only">' + esc(sv.name) + '</span></button>';
}

export async function renderServices() {
  try {
    const list = await loadServices();
    const slot = document.getElementById('svc-slot');
    if (!slot || !list.length || state.status !== 'ready') return;
    slot.innerHTML = '<section class="row-section" id="services" aria-labelledby="h-services"><h2 class="row-title" id="h-services">Services de streaming</h2>' +
      row(list.map(svcTile).join('')) + '</section>';
  } catch (_) { /* rangée absente si TMDB ne répond pas */ }
}

export const SVC_GENRES = [
  ['Action', 28, 10759], ['Comédie', 35, 35], ['Drame', 18, 18], ['Science-fiction', 878, 10765], ['Thriller', 53, '80|9648'],
  ['Animation', 16, 16], ['Documentaire', 99, 99], ['Famille', 10751, 10751], ['Horreur', 27, null], ['Romance', 10749, null],
];

export function svcRows(type) {
  const isTv = type === 'tv';
  const today = new Date().toISOString().slice(0, 10);
  const dateKey = isTv ? 'first_air_date' : 'primary_release_date';
  const rows = [
    { title: 'Top du moment', land: true, params: { sort_by: 'popularity.desc' } },
    { title: 'Nouveautés', params: { sort_by: dateKey + '.desc', [dateKey + '.lte']: today } },
    { title: 'Les mieux notés', params: { sort_by: 'vote_average.desc', 'vote_count.gte': '300' } },
  ];
  SVC_GENRES.forEach(([title, gm, gt]) => {
    const g = isTv ? gt : gm;
    if (g == null) return;
    rows.push({ title, params: { sort_by: 'popularity.desc', with_genres: String(g) } });
  });
  return rows;
}

export async function loadSvcRow(sec, sv, type, def, token) {
  const isTv = type === 'tv';
  const params = Object.assign({
    ...releasedParams(type),
    watch_region: getRegion().code,
    with_watch_providers: sv.ids.join('|'),
    with_watch_monetization_types: 'flatrate|free|ads',
    'vote_count.gte': isTv ? '35' : '50',
    include_adult: 'false',
  }, def.params);
  let items = [];
  try {
    const j = await tmdb('discover/' + type, params);
    items = (j.results || []).filter((r) => r.poster_path && (r.release_date || r.first_air_date || '9999') <= todayStr()).map((r) => register(toItem(r, type)));
  } catch (_) {
    if (token === state.token) sec.querySelector('.row').innerHTML = '<p class="row-msg" role="status">Cette rangée n’a pas pu être chargée.</p>';
    return;
  }
  if (token !== state.token) return;
  if (!items.length) { sec.remove(); return; }
  sec.querySelector('.row').innerHTML = items.map((it) => (def.land ? tileCard(it, { variant: 'logo' }) : posterCard(it))).join('');
  observeTiles(sec);
}

export function buildSvcRows(sv, type, token) {
  if (state.svcIO) state.svcIO.disconnect();
  state.svcIO = null;
  const box = detailEl.querySelector('#svc-rows');
  if (!box) return;
  const defs = svcRows(type);
  box.innerHTML = defs.map((d, i) =>
    '<section class="row-section svc-row" data-i="' + i + '" aria-label="' + esc(d.title) + '">' +
    '<h2 class="row-title">' + esc(d.title) + '</h2>' +
    '<div class="row f-posters" data-nav>' + '<span class="sk sk-card"></span>'.repeat(6) + '</div></section>').join('');
  const secs = Array.from(box.querySelectorAll('.svc-row'));
  const load = (sec) => { if (sec.dataset.done) return; sec.dataset.done = '1'; loadSvcRow(sec, sv, type, defs[Number(sec.dataset.i)], token); };
  if ('IntersectionObserver' in window) {
    state.svcIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { state.svcIO.unobserve(e.target); load(e.target); } });
    }, { rootMargin: '300px 0px' });
    secs.forEach((x) => state.svcIO.observe(x));
  } else {
    secs.forEach(load);
  }
}


export async function showService(slug) {
  teardownFiche();
  const token = state.token;
  state.kind = 'service';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  let list;
  try { list = await loadServices(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les services de streaming n’ont pas pu être chargés.');
    return;
  }
  if (token !== state.token) return;
  const sv = list.find((x) => x.slug === slug);
  if (!sv) { detailEl.innerHTML = svcError('Service introuvable.'); return; }
  state.svc = { sv, type: 'movie' };
  document.title = sv.name + ' · Laststream';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head" style="--svc:' + esc(sv.color) + '">' +
    (sv.logo ? '<img class="svc-logo" src="' + esc(sv.logo) + '" alt="">' : '') +
    '<div class="svc-head-t"><p class="svc-eyebrow">Services de streaming</p>' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Disponible sur ' + esc(sv.name) + '</h1>' +
    '<div class="pills svc-toggle" role="group" aria-label="Type de contenu" data-nav>' +
    '<button type="button" class="pill" data-svctype="movie" aria-pressed="true">Films</button>' +
    '<button type="button" class="pill" data-svctype="tv" aria-pressed="false">Séries</button></div></div></header>' +
    '<div class="svc-rows" id="svc-rows"></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  buildSvcRows(sv, 'movie', token);
}

export async function showServices() {
  teardownFiche();
  const token = state.token;
  state.kind = 'services';
  document.title = 'Services de streaming · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  let list;
  try { list = await loadServices(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les services de streaming n’ont pas pu être chargés.');
    return;
  }
  if (token !== state.token) return;
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain">' +
    '<div class="svc-head-t"><h1 class="svc-title" id="svc-title" tabindex="-1">Services de streaming</h1>' +
    '<p class="svc-eyebrow">Disponibles ' + getRegion().where + '</p></div></header>' +
    '<div class="services-grid" data-nav>' + list.map(svcTile).join('') + '</div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
}
