/* Port du prototype (voir tools/port-prototype.mjs). */
import { followBtn } from './follows.js';
import { setupWhy } from './why.js';
import { isKidProfile } from '../data/auth';
import { kidGenreOk } from '../data/kid';
import { personWhy, tmdb } from '../data/lt';
import { register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { todayStr } from './dates.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, section, svcError, topBar } from './fragments.js';
import { applyRestore } from './router.js';
import { state } from './state.js';
import { observeTiles, tileCard } from './tiles.js';
import { esc, fmtDate, fmtNum, plural } from './util.js';

export const personCache = new Map();
export const NOISE_GENRES = [10767, 10763];
export const isSelf = (c) => /\b(self|himself|herself|lui-même|elle-même|soi-même|archive|archives|footage|uncredited|non crédité)\b/i.test(c || '');
export const DEPT_FR = {
  Acting: ['Acteur', 'Actrice'], Directing: ['Réalisateur', 'Réalisatrice'], Writing: ['Scénariste', 'Scénariste'], Production: ['Producteur', 'Productrice'],
  Sound: ['Compositeur', 'Compositrice'], Camera: ['Chef opérateur', 'Cheffe opératrice'], Editing: ['Monteur', 'Monteuse'], Creator: ['Créateur', 'Créatrice'],
};

export function fetchPerson(id) {
  if (!personCache.has(id)) {
    const p = (async () => {
      const raw = await tmdb('person/' + id, { append_to_response: 'combined_credits,images,external_ids,tagged_images' });
      if (!raw.biography) {
        try { raw.biography = (await tmdb('person/' + id, { language: 'en-US' })).biography || ''; } catch (_) { /* biographie absente */ }
      }
      return raw;
    })();
    p.catch(() => personCache.delete(id));
    personCache.set(id, p);
  }
  return personCache.get(id);
}

export function personEntries(raw) {
  const cc = raw.combined_credits || {};
  const map = new Map();
  const get = (c) => {
    if (!c.id || (c.media_type !== 'movie' && c.media_type !== 'tv')) return null;
    const it = register(toItem(c, c.media_type));
    let e = map.get(it.key);
    if (!e) {
      e = { it, kinds: new Set(), jobs: new Set(), char: '', episodes: 0, self: false, date: String(c.release_date || c.first_air_date || ''),
        pop: c.popularity || 0, votes: c.vote_count || 0, rating: c.vote_average || 0, backdrop: c.backdrop_path || '',
        noise: (c.genre_ids || []).some((g) => NOISE_GENRES.includes(g)), kidGenre: kidGenreOk(c.genre_ids) };
      map.set(it.key, e);
    }
    return e;
  };
  (cc.cast || []).forEach((c) => {
    const e = get(c);
    if (!e) return;
    e.kinds.add('Acteur');
    if (!e.char && c.character) e.char = c.character;
    e.episodes = Math.max(e.episodes, c.episode_count || 0);
    if (isSelf(c.character)) e.self = true;
  });
  (cc.crew || []).forEach((c) => {
    const e = get(c);
    if (!e) return;
    const j = c.job || '';
    if (j === 'Director') e.kinds.add('Réalisateur');
    else if (/^(Writer|Screenplay|Story|Creator|Novel|Characters|Teleplay)$/.test(j) || c.department === 'Writing') e.kinds.add('Scénario');
    else if (/Producer/.test(j) || c.department === 'Production') e.kinds.add('Production');
    else e.kinds.add('Équipe');
    if (j) e.jobs.add(j);
  });
  return Array.from(map.values());
}

export const ageOf = (b, d) => {
  const s = new Date(b + 'T00:00:00');
  const e = d ? new Date(d + 'T00:00:00') : new Date();
  let a = e.getFullYear() - s.getFullYear();
  const m = e.getMonth() - s.getMonth();
  if (m < 0 || (m === 0 && e.getDate() < s.getDate())) a--;
  return a;
};

export function personRoles(raw, entries) {
  const g = raw.gender === 1 ? 1 : 0;
  const out = [];
  const add = (x) => { if (x && !out.includes(x)) out.push(x); };
  add((DEPT_FR[raw.known_for_department] || [raw.known_for_department || '', ''])[g]);
  const has = (k, n) => entries.filter((e) => e.kinds.has(k)).length >= n;
  if (has('Réalisateur', 1)) add(g ? 'Réalisatrice' : 'Réalisateur');
  if (has('Scénario', 2)) add('Scénariste');
  if (has('Production', 2)) add(g ? 'Productrice' : 'Producteur');
  return out.filter(Boolean).join(' · ');
}

export const byDateDesc = (a, b) => String(b.date || '9999').localeCompare(String(a.date || '9999'));

export function ppRow(id, title, list, optsFn) {
  if (!list.length) return '';
  return section(id, title, list, (l) => row(l.map((e) => tileCard(e.it, optsFn ? optsFn(e) : {})).join('')));
}

export function ppLinks(x) {
  const out = [];
  if (x.imdb_id) out.push('<a class="pp-link" href="https://www.imdb.com/name/' + esc(x.imdb_id) + '" target="_blank" rel="noopener noreferrer" aria-label="IMDb (nouvel onglet)"><span class="rb rb-imdb" aria-hidden="true">IMDb</span></a>');
  if (x.instagram_id) out.push('<a class="pp-link" href="https://www.instagram.com/' + esc(x.instagram_id) + '" target="_blank" rel="noopener noreferrer" aria-label="Instagram (nouvel onglet)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor"/></svg></a>');
  if (x.twitter_id) out.push('<a class="pp-link" href="https://x.com/' + esc(x.twitter_id) + '" target="_blank" rel="noopener noreferrer" aria-label="X (nouvel onglet)"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3l-6.6 7.6L22 21h-6.1l-4.8-6.3L5.6 21h-3l7-8.1L2 3h6.2l4.3 5.7zm-1.1 16.2h1.7L7.4 4.7H5.6z"/></svg></a>');
  return out.join('');
}

export function filmoRows(pp) {
  let l = pp.entries.slice();
  const f = pp.filter;
  if (f === 'movie' || f === 'tv') l = l.filter((e) => e.it.type === f);
  else if (f !== 'all') l = l.filter((e) => e.kinds.has(f));
  const s = pp.sort;
  if (s === 'pop') l.sort((a, b) => b.pop - a.pop);
  else if (s === 'rating') l.sort((a, b) => (b.votes >= 10 ? b.rating : 0) - (a.votes >= 10 ? a.rating : 0));
  else l.sort(byDateDesc);
  return l;
}

export function renderFilmography() {
  const box = detailEl.querySelector('#pp-list');
  const pp = state.pp;
  if (!box || !pp) return;
  const l = filmoRows(pp);
  const shown = l.slice(0, pp.limit);
  box.innerHTML = shown.length
    ? shown.map((e) => {
      const role = e.kinds.has('Acteur') && e.char ? e.char : Array.from(e.jobs).slice(0, 2).join(', ') || Array.from(e.kinds).join(', ');
      return '<li><button type="button" class="pp-li" data-open="' + esc(e.it.key) + '" aria-label="' + esc(e.it.name + (e.it.year ? ', ' + e.it.year : '') + (role ? ', ' + role : '')) + '">' +
        '<span class="pp-y">' + esc(e.date ? e.date.slice(0, 4) : '—') + '</span>' +
        '<span class="pp-th">' + (e.it.poster ? '<img src="' + esc(e.it.poster) + '" alt="" loading="lazy" decoding="async">' : '') + '</span>' +
        '<span class="pp-t"><strong>' + esc(e.it.name) + '</strong><em>' + esc(e.it.type === 'tv' ? 'Série' : 'Film') + '</em></span>' +
        '<span class="pp-r">' + esc(role) + '</span>' +
        '<span class="pp-n">' + (e.rating > 0 ? '★ ' + esc(fmtNum(e.rating, 1)) : '') + '</span></button></li>';
    }).join('')
    : '<li class="row-msg">Aucun crédit dans ce filtre.</li>';
  const more = detailEl.querySelector('#pp-more');
  if (more) more.innerHTML = l.length > shown.length ? '<button type="button" class="btn btn-ghost" data-ppmore>Afficher plus (' + (l.length - shown.length) + ')</button>' : '';
  detailEl.querySelectorAll('[data-ppf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ppf === pp.filter)));
  detailEl.querySelectorAll('[data-pps]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pps === pp.sort)));
}

export async function showPerson(id) {
  teardownFiche();
  const token = state.token;
  state.kind = 'person';
  document.title = 'Personnalité · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  let raw;
  try { raw = await fetchPerson(id); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Cette fiche personne n’a pas pu être chargée.');
    return;
  }
  if (token !== state.token) return;
  // Profil enfant : seulement les titres aux genres jeunesse (la classification est vérifiée tuile par tuile).
  const entries = personEntries(raw).filter((e) => !isKidProfile() || e.kidGenre);
  const today = todayStr();
  const real = entries.filter((e) => !e.noise && !e.self && e.date && e.date <= today); // seuls les titres déjà sortis
  const known = real.slice().sort((a, b) => b.votes - a.votes).slice(0, 20);
  const films = real.filter((e) => e.kinds.has('Acteur') && e.it.type === 'movie').sort(byDateDesc);
  const series = real.filter((e) => e.kinds.has('Acteur') && e.it.type === 'tv').sort(byDateDesc);
  const crewRow = (k) => real.filter((e) => e.kinds.has(k)).sort(byDateDesc).slice(0, 20);
  const backdropC = entries.filter((e) => e.backdrop).sort((a, b) => b.pop - a.pop)[0];
  const years = real.map((e) => Number((e.date || '').slice(0, 4))).filter((y) => y > (raw.birthday ? Number(raw.birthday.slice(0, 4)) : 1880) && y <= Number(today.slice(0, 4)));
  const rated = known.filter((e) => e.rating > 0);
  const avg = rated.length ? rated.reduce((s, e) => s + e.rating, 0) / rated.length : 0;
  const nFilms = real.filter((e) => e.it.type === 'movie').length;
  const nSeries = real.filter((e) => e.it.type === 'tv').length;
  const roles = personRoles(raw, entries);
  const ext = raw.external_ids || {};
  const photos = ((raw.images && raw.images.profiles) || []).slice(0, 20);
  const bio = (raw.biography || '').trim();
  let life = '';
  if (raw.birthday) {
    const a = ageOf(raw.birthday, raw.deathday);
    life = raw.deathday
      ? 'Né le ' + fmtDate(raw.birthday) + ' · mort le ' + fmtDate(raw.deathday) + ' (' + a + ' ans)'
      : 'Né' + (raw.gender === 1 ? 'e' : '') + ' le ' + fmtDate(raw.birthday) + ' (' + a + ' ans)';
  }
  state.pp = { entries, filter: 'all', sort: 'recent', limit: 80 };
  const chips = [['all', 'Tout'], ['movie', 'Films'], ['tv', 'Séries']];
  [['Acteur', 'Acteur'], ['Réalisateur', 'Réalisateur'], ['Scénario', 'Scénario'], ['Production', 'Production']].forEach(([k, l]) => {
    if (entries.some((e) => e.kinds.has(k))) chips.push([k, l]);
  });
  const stat = (v, l) => '<li><strong>' + esc(v) + '</strong><span>' + esc(l) + '</span></li>';
  const stats = [stat(String(nFilms), nFilms > 1 ? 'films' : 'film'), stat(String(nSeries), nSeries > 1 ? 'séries' : 'série')];
  if (years.length) stats.push(stat(Math.min.apply(null, years) + ' – ' + Math.max.apply(null, years), 'années d’activité'));
  if (avg) stats.push(stat('★ ' + fmtNum(avg, 1), 'note moyenne des plus connus'));
  const bgSrc = backdropC ? IMG('w1280', backdropC.backdrop) : '';

  detailEl.innerHTML = topBar(false) +
    '<article class="pp-page" aria-labelledby="pp-title"><header class="pp-head">' +
    '<div class="pp-bg' + (bgSrc ? '' : ' no-img') + '" aria-hidden="true">' + (bgSrc ? '<img src="' + esc(bgSrc) + '" alt="" decoding="async">' : '') + '</div><div class="pp-scrim" aria-hidden="true"></div>' +
    '<div class="pp-inner"><div class="pp-portrait' + (raw.profile_path ? '' : ' no-img') + '">' + (raw.profile_path ? '<img src="' + esc(IMG('w342', raw.profile_path)) + '" alt="' + esc(raw.name) + '">' : '<span aria-hidden="true">' + esc((raw.name || '?').slice(0, 1)) + '</span>') + '</div>' +
    '<div class="pp-info"><h1 class="pp-name" id="pp-title" tabindex="-1">' + esc(raw.name) + '</h1>' +
    (roles ? '<p class="pp-roles">' + esc(roles) + '</p>' : '') +
    (life ? '<p class="pp-life">' + esc(life) + (raw.place_of_birth ? ' · ' + esc(raw.place_of_birth) : '') + '</p>' : raw.place_of_birth ? '<p class="pp-life">' + esc(raw.place_of_birth) + '</p>' : '') +
    '<div class="pp-follow" data-nav>' + followBtn('person:' + raw.id, 'btn btn-ghost', ' data-fname="' + esc(raw.name) + '" data-fphoto="' + esc(raw.profile_path || '') + '"') + '</div>' +
    (ppLinks(ext) ? '<div class="pp-links" data-nav>' + ppLinks(ext) + '</div>' : '') +
    (bio ? '<div class="pp-bio-wrap"><p class="pp-bio' + (bio.length > 380 ? ' is-clamped' : '') + '" id="pp-bio">' + esc(bio) + '</p>' +
      (bio.length > 380 ? '<button type="button" class="link-btn" data-bio aria-expanded="false" aria-controls="pp-bio">Lire la suite</button>' : '') + '</div>' : '') +
    '<div class="f-why glass pp-why" id="pp-why" hidden><p class="f-why-head">En deux mots <span class="ia-tag">IA</span></p><p class="f-why-text" id="pp-why-text"></p></div>' +
    '</div></div></header>' +
    '<ul class="pp-stats" aria-label="Statistiques">' + stats.join('') + '</ul>' +
    '<div class="pp-rows">' +
    ppRow('pp-known', 'Les plus connus', known, () => ({})) +
    ppRow('pp-films', 'Films', films, (e) => ({ soon: e.date > today, caption: e.char || String(e.it.year || '') })) +
    ppRow('pp-series', 'Séries', series, (e) => ({ soon: e.date > today, caption: [e.char, e.episodes ? plural(e.episodes, 'épisode', 'épisodes') : ''].filter(Boolean).join(' · ') })) +
    ppRow('pp-dir', 'Réalisation', crewRow('Réalisateur'), (e) => ({ soon: e.date > today, caption: String(e.it.year || '') })) +
    ppRow('pp-wri', 'Scénario', crewRow('Scénario'), (e) => ({ soon: e.date > today, caption: Array.from(e.jobs).slice(0, 2).join(', ') })) +
    ppRow('pp-prod', 'Production', crewRow('Production'), (e) => ({ soon: e.date > today, caption: Array.from(e.jobs).slice(0, 2).join(', ') })) +
    (photos.length ? '<section class="row-section" id="pp-photos" aria-labelledby="h-pp-photos"><h2 class="row-title" id="h-pp-photos">Photos</h2><div class="row f-posters" data-nav>' +
      photos.map((ph, i) => '<button type="button" class="pp-photo" data-photo="' + esc(ph.file_path) + '" aria-label="Agrandir la photo ' + (i + 1) + ' de ' + esc(raw.name) + '"><img src="' + esc(IMG('w342', ph.file_path)) + '" alt="" loading="lazy" decoding="async"></button>').join('') + '</div></section>' : '') +
    '</div>' +
    '<section class="pp-film" id="pp-film" aria-labelledby="h-pp-film"><h2 class="row-title" id="h-pp-film">Filmographie complète</h2>' +
    '<div class="pp-controls"><div class="pills" data-nav role="group" aria-label="Filtrer">' + chips.map(([k, l]) => '<button type="button" class="pill" data-ppf="' + esc(k) + '" aria-pressed="' + (k === 'all') + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<div class="pills" data-nav role="group" aria-label="Trier"><button type="button" class="pill" data-pps="recent" aria-pressed="true">Récent</button><button type="button" class="pill" data-pps="pop" aria-pressed="false">Populaire</button><button type="button" class="pill" data-pps="rating" aria-pressed="false">Note</button></div></div>' +
    '<ul class="pp-list" id="pp-list" data-nav></ul><div id="pp-more" class="epg-more"></div></section></article>';
  document.title = raw.name + ' · Laststream';
  const h1 = detailEl.querySelector('#pp-title');
  if (h1) h1.focus({ preventScroll: true });
  renderFilmography();
  observeTiles(detailEl);
  applyRestore();
  // « En deux mots » (IA) : masqué en cas d'erreur
  if (known.length) {
    personWhy(raw.id).then((j) => {
      if (token !== state.token || !j.text) return;
      detailEl.querySelector('#pp-why-text').textContent = j.text;
      detailEl.querySelector('#pp-why').hidden = false;
      setupWhy(detailEl.querySelector('#pp-why'));
    }).catch(() => { /* carte masquée */ });
  }
}
