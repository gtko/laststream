/* Calendrier des suivis (#/calendar) et rangée d'accueil « Cette semaine dans tes suivis ». */
import { soonItemHTML } from './soon.js';
import { tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import { episodeLabel, groupByDate, isoDate, mergeEpisodes, monthGrid, movieReleases } from '../data/calendar';
import { userStore } from '../data/userStore';
import { listOf, register } from './catalog.js';
import { addDays, countdown, fmtShort, todayStr } from './dates.js';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, section, topBar } from './fragments.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { observeTiles, tileCard } from './tiles.js';
import { esc } from './util.js';

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DOW = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const cache = new Map();

const monthRange = (y, m) => [isoDate(y, m, 1), isoDate(y, m, new Date(y, m, 0).getDate())];

function itemOf(type, id, name, poster, backdrop) {
  const raw = { id, poster_path: poster || '', backdrop_path: backdrop || '' };
  raw[type === 'tv' ? 'name' : 'title'] = name;
  return register(listOf({ results: [raw] }, type)[0]);
}

async function seriesEvents(f, from, to) {
  const d = await tmdb('tv/' + f.id);
  const seasons = (d.seasons || []).filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
  // Saisons qui peuvent diffuser dans la période : débutées avant sa fin, et suivies d'une saison qui commence après son début.
  const wanted = seasons.filter((s, i) => {
    const start = s.air_date || '9999';
    const nextStart = seasons[i + 1] && seasons[i + 1].air_date;
    return start <= to && (!nextStart || nextStart >= from);
  }).slice(-3);
  const it = itemOf('tv', f.id, d.name || f.title, d.poster_path || f.poster, d.backdrop_path);
  const out = [];
  const nextEp = d.next_episode_to_air;
  if (nextEp && nextEp.air_date >= from && nextEp.air_date <= to) {
    out.push({ date: nextEp.air_date, kind: 'episode', key: it.key, title: it.name, poster: d.poster_path || f.poster, label: episodeLabel(nextEp.season_number, nextEp.episode_number), season: nextEp.season_number, episode: nextEp.episode_number, epTitle: nextEp.name, backdrop: d.backdrop_path });
  }
  const res = await Promise.allSettled(wanted.map((s) => tmdb('tv/' + f.id + '/season/' + s.season_number)));
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    (r.value.episodes || []).forEach((e) => {
      if (!e.air_date || e.air_date < from || e.air_date > to) return;
      if (out.some((x) => x.date === e.air_date && x.label === episodeLabel(wanted[i].season_number, e.episode_number))) return;
      out.push({ date: e.air_date, kind: 'episode', key: it.key, title: it.name, poster: d.poster_path || f.poster, label: episodeLabel(wanted[i].season_number, e.episode_number), season: wanted[i].season_number, episode: e.episode_number, epTitle: e.name, backdrop: d.backdrop_path });
    });
  });
  return out;
}

async function movieEvents(f, from, to) {
  const d = await tmdb('movie/' + f.id, { append_to_response: 'release_dates' });
  const it = itemOf('movie', f.id, d.title || f.title, d.poster_path || f.poster, d.backdrop_path);
  return movieReleases(d.release_dates && d.release_dates.results, getRegion().code, d.release_date)
    .filter((r) => r.date >= from && r.date <= to)
    .map((r) => ({ date: r.date, kind: 'movie', key: it.key, title: it.name, poster: d.poster_path || f.poster, label: r.label }));
}

async function personEvents(f, from, to) {
  const j = await tmdb('person/' + f.id + '/combined_credits');
  const seen = new Set();
  const out = [];
  (j.cast || []).concat(j.crew || []).forEach((c) => {
    const date = String(c.release_date || c.first_air_date || '').slice(0, 10);
    if ((c.media_type !== 'movie' && c.media_type !== 'tv') || !c.poster_path || date < from || date > to) return;
    const k = c.media_type + ':' + c.id;
    if (seen.has(k)) return;
    seen.add(k);
    const it = itemOf(c.media_type, c.id, c.title || c.name, c.poster_path, c.backdrop_path);
    out.push({ date, kind: 'person', key: it.key, title: it.name, poster: c.poster_path, label: 'Avec ' + f.title });
  });
  return out;
}

/** Événements des suivis dans une période ; une requête par suivi, mise en cache. */
export async function loadEvents(from, to) {
  const follows = userStore.getFollows();
  const sig = follows.map((f) => f.type + f.id).sort().join(',');
  const ck = from + '|' + to + '|' + sig;
  if (!cache.has(ck)) {
    const p = Promise.allSettled(follows.map((f) => (f.type === 'tv' ? seriesEvents(f, from, to) : f.type === 'movie' ? movieEvents(f, from, to) : personEvents(f, from, to))))
      .then((rs) => mergeEpisodes(rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))));
    p.catch(() => cache.delete(ck));
    cache.set(ck, p);
  }
  return cache.get(ck);
}

// ---------- Rangée d'accueil ----------
export async function renderFollowRow() {
  const slot = document.getElementById('follow-slot');
  if (!slot || !userStore.getFollows().length) return;
  const today = todayStr();
  const events = (await loadEvents(addDays(today, -1), addDays(today, 7))).filter((e) => e.kind !== 'person' || e.date >= today);
  const fresh = document.getElementById('follow-slot');
  if (!fresh || !events.length) return;
  const sorted = [...groupByDate(events).values()].flat();
  const seen = new Set();
  const items = sorted.filter((e) => !seen.has(e.key) && seen.add(e.key)).slice(0, 20).map((e) => {
    const it = state.byKey.get(e.key);
    if (e.kind === 'episode' && e.date >= today && e.season) return soonOf(e);
    return it ? tileCard(it, { variant: 'land', alwaysMeta: true, sub: e.label + ' · ' + (e.date < today ? 'sorti' : countdown(e.date) || fmtShort(e.date)) }) : '';
  }).filter(Boolean);
  if (!items.length) return;
  fresh.innerHTML = section('suivis', 'Cette semaine dans tes suivis', items, () => row(items.join(''))).replace('</h2>', ' <a class="row-link" href="#/calendar" data-calnav>Calendrier</a></h2>');
  observeTiles(fresh);
}

// ---------- Page ----------
const view = { y: 0, m: 0, mode: 'month', kinds: new Set(['movie', 'tv', 'person']), events: [], token: 0 };

const kindOfEvent = (e) => (e.kind === 'episode' ? 'tv' : e.kind === 'movie' ? 'movie' : 'person');

function evHTML(e) {
  const today = todayStr();
  const past = e.date < today;
  const watched = past && (e.kind === 'movie' ? userStore.isWatched(e.key) : e.kind === 'episode' ? userStore.watchedEpisodes(e.key).length > 0 && /É(\d+)/.test(e.label) && isEpWatched(e) : false);
  const src = e.poster ? 'https://image.tmdb.org/t/p/w185' + e.poster : '';
  return '<button type="button" class="cal-ev kind-' + e.kind + (watched ? ' is-seen' : '') + '" data-open="' + esc(e.key) + '" title="' + esc(e.title + ' · ' + e.label) + '">' +
    '<span class="cal-th">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '<b>' + esc(e.title.slice(0, 2)) + '</b>') + (watched ? '<span class="cal-check" aria-hidden="true">' + ICON.check + '</span>' : '') + '</span>' +
    '<span class="cal-tx"><strong>' + esc(e.title) + '</strong><em>' + esc(e.label) + '</em></span></button>';
}

const soonOf = (e) => soonItemHTML({ airDate: e.date, season: e.season, episode: e.episode, epTitle: e.epTitle, backdrop: e.backdrop, poster: e.poster, name: e.title }, e.key);

function isEpWatched(e) {
  const m = /S(\d+) É(\d+)(?:–É(\d+))?/.exec(e.label);
  if (!m) return false;
  return userStore.isWatched(e.key, Number(m[1]), Number(m[3] || m[2]));
}

function gridHTML() {
  const today = todayStr();
  const byDate = groupByDate(view.events.filter((e) => view.kinds.has(kindOfEvent(e))));
  const weeks = monthGrid(view.y, view.m);
  const head = '<div class="cal-dow" role="row">' + DOW.map((d) => '<span role="columnheader">' + d + '</span>').join('') + '</div>';
  const body = weeks.map((w) => '<div class="cal-week" role="row">' + w.map((d) => {
    const evs = byDate.get(d.date) || [];
    const past = d.date < today;
    const recent = past && d.date >= addDays(today, -7);
    return '<div class="cal-day' + (d.inMonth ? '' : ' is-out') + (d.date === today ? ' is-today' : '') + (past ? ' is-past' : '') + (recent ? ' is-recent' : '') + '" role="gridcell" data-date="' + d.date + '">' +
      '<span class="cal-num">' + Number(d.date.slice(8)) + '</span>' +
      '<div class="cal-evs">' + evs.slice(0, 3).map((e) => evHTML(e)).join('') + (evs.length > 3 ? '<span class="cal-more">+' + (evs.length - 3) + ' autres</span>' : '') + '</div></div>';
  }).join('') + '</div>').join('');
  return '<div class="cal-grid" role="grid" aria-label="' + MONTHS[view.m - 1] + ' ' + view.y + '">' + head + body + '</div>';
}

function agendaHTML() {
  const today = todayStr();
  const groups = groupByDate(view.events.filter((e) => view.kinds.has(kindOfEvent(e))));
  if (!groups.size) return '<p class="row-msg">Rien de prévu ce mois-ci pour les titres et personnes que tu suis.</p>';
  return '<div class="cal-agenda">' + [...groups].map(([date, evs]) => {
    const d = new Date(date + 'T00:00:00');
    return '<section class="cal-agenda-day' + (date < today ? ' is-past' : '') + (date === today ? ' is-today' : '') + '"><h3>' +
      esc(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })) + (date === today ? ' <span class="cal-now">Aujourd’hui</span>' : '') + '</h3>' +
      '<div class="cal-agenda-list">' + evs.map((e) => (e.kind === 'episode' && e.date >= today && e.season ? soonOf(e) : evHTML(e))).join('') + '</div></section>';
  }).join('') + '</div>';
}

function pageHTML() {
  const pill = (k, label) => '<button type="button" class="pill" data-calkind="' + k + '" aria-pressed="' + view.kinds.has(k) + '">' + label + '</button>';
  return '<div class="cal-bar" data-nav><div class="cal-nav">' +
    '<button type="button" class="f-round" data-calstep="-1" aria-label="Mois précédent">' + ICON.back + '</button>' +
    '<h2 class="cal-title" id="cal-title" aria-live="polite">' + MONTHS[view.m - 1] + ' ' + view.y + '</h2>' +
    '<button type="button" class="f-round" data-calstep="1" aria-label="Mois suivant">' + ICON.chev + '</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-caltoday>Aujourd’hui</button></div>' +
    '<div class="pills" role="group" aria-label="Affichage"><button type="button" class="pill" data-calmode="month" aria-pressed="' + (view.mode === 'month') + '">Mois</button>' +
    '<button type="button" class="pill" data-calmode="agenda" aria-pressed="' + (view.mode === 'agenda') + '">Agenda</button></div>' +
    '<div class="pills" role="group" aria-label="Filtrer">' + pill('movie', 'Films') + pill('tv', 'Séries') + pill('person', 'Personnes') + '</div></div>' +
    '<div id="cal-body" aria-busy="false">' + (view.mode === 'month' ? gridHTML() : agendaHTML()) + '</div>';
}

async function loadMonth() {
  const token = ++view.token;
  const body = detailEl.querySelector('#cal-body');
  if (body) body.setAttribute('aria-busy', 'true');
  const [from, to] = monthRange(view.y, view.m);
  let events = [];
  try { events = await loadEvents(from, to); } catch (_) { events = []; }
  if (token !== view.token || state.kind !== 'calendar') return;
  view.events = events;
  const b = detailEl.querySelector('#cal-body');
  if (b) {
    b.innerHTML = view.mode === 'month' ? gridHTML() : agendaHTML();
    b.setAttribute('aria-busy', 'false');
  }
}

function rerender() {
  const bar = detailEl.querySelector('.cal-wrap');
  if (bar) bar.innerHTML = pageHTML();
}

export function showCalendar() {
  teardownFiche();
  state.kind = 'calendar';
  document.title = 'Calendrier · Laststream';
  const now = new Date();
  if (!view.y) { view.y = now.getFullYear(); view.m = now.getMonth() + 1; }
  const empty = !userStore.getFollows().length;
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Calendrier</h1><p class="svc-eyebrow">Sorties de ce que tu suis : séries, films et personnalités</p></div></header>' +
    '<div class="cal-wrap">' + (empty ? '<p class="row-msg">Tu ne suis encore rien. Utilise « Suivre » sur une fiche, une affiche ou une personnalité pour la retrouver ici.</p>' : pageHTML()) + '</div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  if (!empty) loadMonth();
}

detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !t.closest('.cal-wrap')) return;
  const step = t.closest('[data-calstep]');
  if (step) {
    const d = new Date(view.y, view.m - 1 + Number(step.dataset.calstep), 1);
    view.y = d.getFullYear();
    view.m = d.getMonth() + 1;
    rerender();
    loadMonth();
    return;
  }
  if (t.closest('[data-caltoday]')) {
    const now = new Date();
    view.y = now.getFullYear();
    view.m = now.getMonth() + 1;
    rerender();
    loadMonth();
    return;
  }
  const mode = t.closest('[data-calmode]');
  if (mode) { view.mode = mode.dataset.calmode; rerender(); loadMonth(); return; }
  const kind = t.closest('[data-calkind]');
  if (kind) {
    const k = kind.dataset.calkind;
    if (view.kinds.has(k) && view.kinds.size > 1) view.kinds.delete(k); else view.kinds.add(k);
    rerender();
    loadMonth();
  }
});
