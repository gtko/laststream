/* Calendrier des suivis (#/calendar) et rangée d'accueil « Cette semaine dans tes suivis ». */
import { canonical } from './seasons.js';
import { countdownText, isPlaceholderTitle, soonItemHTML } from './soon.js';
import { postLt, tmdb } from '../data/lt';
import { getRegion } from '../data/prefs';
import {
  CAL_KINDS, cellPreview, countByKind, dayAriaLabel, dayTitle, dotKinds, episodeLabel, eventStatus, eventSubtitle, filterByKinds, groupByDate, hueOf, initials, isoDate,
  kindOfEvent, mergeEpisodes, monthGrid, moveSelection, movieReleases, pickSelectedDate,
} from '../data/calendar';
import { userStore } from '../data/userStore';
import { followedAirings, loadGuide } from '../data/showsApi';
import { hhmm, localDate } from '../data/shows';
import { listOf, register } from './catalog.js';
import { addDays, countdown, fmtShort, todayStr } from './dates.js';
import { detailEl } from './dom.js';
import { getRemind, teardownFiche } from './fiche.js';
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

async function canonEvents(f, from, to, canon) {
  const d = await tmdb('tv/' + f.id);
  const it = itemOf('tv', f.id, d.name || f.title, d.poster_path || f.poster, d.backdrop_path);
  return canon.seasons.filter((s) => s.number > 0).flatMap((s) => s.episodes)
    .filter((e) => e.airDate && e.airDate >= from && e.airDate <= to)
    .map((e) => ({ date: e.airDate, kind: 'episode', key: it.key, title: it.name, poster: d.poster_path || f.poster, label: episodeLabel(e.season, e.episode), season: e.season, episode: e.episode, epTitle: e.name, backdrop: d.backdrop_path }));
}

async function seriesEvents(f, from, to) {
  const canon = await canonical(f.id);
  if (canon) return canonEvents(f, from, to, canon);
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

/** Diffusions TV (guide) des émissions et séries suivies, dans la période ; une seule requête de guide, mise en cache. */
async function airingEvents(follows, from, to) {
  if (!follows.some((f) => f.type === 'tv')) return [];
  const guide = await loadGuide();
  return followedAirings(follows, guide, localDate, hhmm, Math.floor(Date.now() / 1000)).filter((e) => e.date >= from && e.date <= to);
}

/** Suivis sans doublon : un titre suivi deux fois n'est chargé qu'une fois. */
const uniqueFollows = (follows) => [...new Map(follows.map((f) => [f.type + ':' + f.id, f])).values()];

/** Nombre maximal de suivis chargés en même temps (sans cela, N suivis lancent N chaînes de requêtes en parallèle). */
export const CAL_CONCURRENCY = 3;

/** Comme `Promise.allSettled(items.map(fn))`, mais au plus `n` appels en vol à la fois. */
export async function settleLimited(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Route serveur groupée (`POST lt/calendar/batch`, une seule requête pour tous les suivis) : sans elle, `null`. */
let batchMissing = false;
export async function fetchCalendarBatch(follows, from, to) {
  if (batchMissing || !follows.length) return null;
  try {
    const res = await postLt('calendar/batch', { from, to, follows: follows.map((f) => ({ type: f.type, id: f.id })) });
    if (res && Array.isArray(res.events)) return res.events;
    batchMissing = true;
  } catch (err) {
    // Route absente (404, 405, 501) : inutile de la redemander pendant la session. Autre erreur : repli pour cette fois.
    if ([404, 405, 501].includes(err && err.status)) batchMissing = true;
  }
  return null;
}

/** Événements des suivis : une route groupée si lastAddon la fournit, sinon une requête par suivi, au plus CAL_CONCURRENCY à la fois. */
async function loadFollowEvents(follows, from, to) {
  const unique = uniqueFollows(follows);
  const batch = await fetchCalendarBatch(unique, from, to);
  if (batch) return mergeEpisodes(batch);
  const rs = await settleLimited(unique, CAL_CONCURRENCY, (f) => (f.type === 'tv' ? seriesEvents(f, from, to) : f.type === 'movie' ? movieEvents(f, from, to) : personEvents(f, from, to)));
  return mergeEpisodes(rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
}

/** Événements des suivis dans une période ; une requête par suivi (ou une seule route groupée), mise en cache. */
export async function loadEvents(from, to) {
  const follows = userStore.getFollows();
  const sig = follows.map((f) => f.type + f.id).sort().join(',');
  const ck = from + '|' + to + '|' + sig;
  if (!cache.has(ck)) {
    const p = loadFollowEvents(follows, from, to)
      .then(async (evs) => evs.concat(await airingEvents(follows, from, to).catch(() => [])));
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
    // Tout épisode (à venir ou déjà sorti) a la même carte : pastille de date, badge, affiche au même emplacement.
    if (e.kind === 'episode' && e.season) return soonOf(e);
    return it ? tileCard(it, { variant: 'land', alwaysMeta: true, sub: e.label + ' · ' + (e.date < today ? 'sorti' : countdown(e.date) || fmtShort(e.date)) }) : '';
  }).filter(Boolean);
  if (!items.length) return;
  fresh.innerHTML = section('suivis', 'Cette semaine dans tes suivis', items, () => row(items.join(''))).replace('</h2>', ' <a class="row-link" href="#/calendar" data-calnav>Calendrier</a></h2>');
  observeTiles(fresh);
}


// ---------- Page ----------
const view = { y: 0, m: 0, mode: 'month', kinds: new Set(CAL_KINDS.map((k) => k.key)), events: [], token: 0, sel: '', picked: false, loading: false };

const soonOf = (e) => soonItemHTML({ airDate: e.date, season: e.season, episode: e.episode, epTitle: e.epTitle, backdrop: e.backdrop, poster: e.poster, name: e.title }, e.key);

function isEpWatched(e) {
  const m = /S(\d+) É(\d+)(?:–É(\d+))?/.exec(e.label);
  if (!m) return false;
  return userStore.isWatched(e.key, Number(m[1]), Number(m[3] || m[2]));
}

/** Sortie déjà vue (film ou épisode passé), d'après l'historique de visionnage. */
function isSeen(e) {
  if (e.date >= todayStr()) return false;
  if (e.kind === 'movie') return userStore.isWatched(e.key);
  return e.kind === 'episode' && userStore.watchedEpisodes(e.key).length > 0 && /É(\d+)/.test(e.label) && isEpWatched(e);
}

const visibleByDate = () => groupByDate(filterByKinds(view.events, view.kinds));
const kindName = (k) => CAL_KINDS.find((x) => x.key === k).name;

/** Affiche (ou deux initiales sur un dégradé si elle manque ou ne charge pas : repli d'image d'events.js) ; coche si déjà vu. */
function thumbHTML(e, seen) {
  const src = e.poster ? 'https://image.tmdb.org/t/p/w185' + e.poster : '';
  return '<span class="cal-th cal-k-' + kindOfEvent(e) + (seen ? ' is-seen' : '') + '" style="--h:' + hueOf(e.title) + '"><b aria-hidden="true">' + esc(initials(e.title)) + '</b>' +
    (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '') +
    (seen ? '<span class="cal-check" aria-hidden="true">' + ICON.check + '</span>' : '') + '</span>';
}

function cellHTML(d, byDate, today) {
  const n = Number(d.date.slice(8));
  if (!d.inMonth) return '<div class="cal-day is-out" aria-hidden="true"><span class="cal-hd"><span class="cal-num">' + n + '</span></span></div>';
  const evs = byDate.get(d.date) || [];
  const sel = d.date === view.sel;
  const { shown, more } = cellPreview(evs);
  const dots = dotKinds(evs);
  const first = evs[0];
  return '<button type="button" class="cal-day cal-cell' + (d.date === today ? ' is-today' : '') + (d.date < today ? ' is-past' : '') + (sel ? ' is-sel' : '') +
    '" data-caldate="' + d.date + '"' + (d.date === today ? ' aria-current="date"' : '') + ' aria-pressed="' + sel + '" tabindex="' + (sel ? 0 : -1) + '" aria-label="' + esc(dayAriaLabel(d.date, evs.length)) + '">' +
    '<span class="cal-hd"><span class="cal-num">' + n + '</span>' + (d.date === today && evs.length ? '<span class="cal-tag">Ce soir</span>' : '') + '</span>' +
    '<span class="cal-ps">' + shown.map((e) => thumbHTML(e, isSeen(e))).join('') + (more ? '<span class="cal-more">+' + more + '</span>' : '') + '</span>' +
    (first ? '<span class="cal-cap cal-k-' + kindOfEvent(first) + '"><b>' + esc(first.label) + '</b> ' + esc(first.title) + '</span>' : '') +
    '<span class="cal-dots">' + dots.shown.map((k) => '<i class="cal-k-' + k + '"></i>').join('') + (dots.more ? '<b>+</b>' : '') + '</span></button>';
}

function gridHTML() {
  const today = todayStr();
  const byDate = visibleByDate();
  const head = '<div class="cal-dow" aria-hidden="true">' + DOW.map((d) => '<span><i class="cal-dl">' + d + '</i><i class="cal-ds">' + d.charAt(0).toUpperCase() + '</i></span>').join('') + '</div>';
  const cells = monthGrid(view.y, view.m).flat().map((d) => cellHTML(d, byDate, today)).join('');
  return '<div class="cal-gridw" role="group" aria-label="' + MONTHS[view.m - 1] + ' ' + view.y + '" data-nav>' + head + '<div class="cal-cells">' + cells + '</div></div>';
}

/** Action principale d'une sortie : l'épisode lui-même, la fiche du titre, ou la diffusion TV. */
function openAction(e) {
  if (e.kind === 'airing') return { attrs: 'data-showopen="' + esc(e.showId) + '"', text: 'Voir la diffusion' };
  if (e.kind === 'episode' && e.season && e.episode) return { attrs: 'data-open="' + esc(e.key) + '" data-open-season="' + esc(e.season) + '" data-open-episode="' + esc(e.episode) + '"', text: 'Ouvrir l’épisode' };
  return { attrs: 'data-open="' + esc(e.key) + '"', text: 'Ouvrir la fiche' };
}

/** Carte d'une sortie. Panneau : bouton « Ouvrir… » ; agenda : toute la carte cliquable (bouton étendu), la cloche reste un bouton frère. */
function cardHTML(e, agenda) {
  const today = todayStr();
  const k = kindOfEvent(e);
  const seen = isSeen(e);
  const st = eventStatus(e, today, countdownText);
  const sub = eventSubtitle(e, !isPlaceholderTitle(e.epTitle));
  const act = openAction(e);
  const tip = esc(e.label + ' · ' + e.title);
  const name = esc(act.text + ' : ' + e.title + ', ' + sub);
  const remind = e.date > today && e.kind !== 'airing';
  const on = remind && getRemind().includes(e.key);
  const bell = remind
    ? '<button type="button" class="cal-bell" data-remindkey="' + esc(e.key) + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Rappel activé : ' : 'Me rappeler : ') + esc(e.title) + '" data-tip="' + (on ? 'Rappel activé' : 'Me rappeler') + '">' + (on ? ICON.check : ICON.bell) + '</button>'
    : '';
  const status = '<span class="cal-st' + (st.hot ? ' hot' : '') + '">' + esc(st.text) + '</span>';
  return '<article class="cal-ev kind-' + e.kind + ' cal-k-' + k + (seen ? ' is-seen' : '') + (agenda ? ' is-agenda' : '') + '">' + thumbHTML(e, seen) +
    (agenda ? '<button type="button" class="cal-hit" ' + act.attrs + ' title="' + tip + '" aria-label="' + name + '"></button>' : '') + '<div class="cal-evx"><span class="cal-evk"><i aria-hidden="true"></i>' + kindName(k) + '</span>' +
    '<span class="cal-evt">' + esc(e.title) + '</span><span class="cal-evs">' + esc(sub) + '</span>' + (seen ? '<span class="sr-only">Déjà vu</span>' : '') +
    (agenda
      ? '<div class="cal-row2">' + status + bell + '</div>'
      : status + '<div class="cal-acts"><button type="button" class="cal-go" ' + act.attrs + ' title="' + tip + '" aria-label="' + name + '">' + act.text + '</button>' + bell + '</div>') +
    '</div></article>';
}

/** Panneau du jour sélectionné (à droite de la grille, dessous sur écran étroit). */
function panelHTML() {
  const evs = visibleByDate().get(view.sel) || [];
  return '<div class="cal-ph"><h2>' + esc(dayTitle(view.sel)) + '</h2>' + (view.sel === todayStr() ? '<span class="cal-now">Aujourd’hui</span>' : '') + '</div>' +
    (evs.length ? evs.map((e) => cardHTML(e, false)).join('') : '<p class="cal-empty">' + (view.loading ? 'Chargement…' : 'Rien de prévu ce jour-là…') + '</p>') +
    '<p class="cal-legend">Choisis un jour pour voir toutes ses sorties. Une affiche grisée = déjà vu.</p>';
}

function monthHTML() {
  return '<div class="cal-month">' + gridHTML() + '<aside class="cal-panel" id="cal-panel" aria-label="Détail du jour" data-nav>' + panelHTML() + '</aside></div>';
}

function agendaHTML() {
  const today = todayStr();
  const groups = visibleByDate();
  if (!groups.size) return '<p class="row-msg">' + (view.loading ? 'Chargement…' : 'Rien de prévu ce mois-ci pour les titres et personnes que tu suis.') + '</p>';
  return '<div class="cal-agenda">' + [...groups].map(([date, evs]) => {
    const d = new Date(date + 'T00:00:00');
    return '<section class="cal-ag-day' + (date < today ? ' is-past' : '') + (date === today ? ' is-today' : '') + '"><h3 class="cal-dt">' +
      '<span class="cal-dw" aria-hidden="true">' + DOW[(d.getDay() + 6) % 7] + '</span><b class="cal-dn" aria-hidden="true">' + d.getDate() + '</b>' +
      '<span class="cal-dfull">' + esc(dayTitle(date)) + '</span>' + (date === today ? ' <span class="cal-now">Aujourd’hui</span>' : '') + '</h3>' +
      '<div class="cal-ag-list" data-nav>' + evs.map((e) => cardHTML(e, true)).join('') + '</div></section>';
  }).join('') + '</div>';
}

const toolsHTML = () => '<button type="button" class="cal-today" data-caltoday>Aujourd’hui</button>' +
  '<div class="cal-seg" role="group" aria-label="Affichage">' +
  '<button type="button" data-calmode="month" aria-pressed="' + (view.mode === 'month') + '">Mois</button>' +
  '<button type="button" data-calmode="agenda" aria-pressed="' + (view.mode === 'agenda') + '">Agenda</button></div>';

function chipHTML(k, counts) {
  const n = counts[k.key];
  const label = view.loading ? '' : ' aria-label="' + k.label + ', ' + n + (n > 1 ? ' sorties' : ' sortie') + '"';
  return '<button type="button" class="cal-chip cal-k-' + k.key + '" data-calkind="' + k.key + '" aria-pressed="' + view.kinds.has(k.key) + '"' + label + '><i aria-hidden="true"></i>' + k.label +
    (view.loading ? '' : '<em class="cal-n" data-n="' + n + '" aria-hidden="true"></em>') + '</button>';
}

function mainHTML() {
  const counts = countByKind(view.events);
  return '<div class="cal-bar" data-nav><div class="cal-nav">' +
    '<button type="button" class="cal-step" data-calstep="-1" aria-label="Mois précédent">' + ICON.back + '</button>' +
    '<h2 class="cal-title" id="cal-title" aria-live="polite">' + MONTHS[view.m - 1] + ' ' + view.y + '</h2>' +
    '<button type="button" class="cal-step" data-calstep="1" aria-label="Mois suivant">' + ICON.chev + '</button></div>' +
    '<div class="cal-chips" role="group" aria-label="Filtrer par type">' + CAL_KINDS.map((k) => chipHTML(k, counts)).join('') + '</div></div>' +
    '<div id="cal-body" class="cal-body' + (view.loading ? ' is-loading' : '') + '" aria-busy="' + view.loading + '">' + (view.mode === 'month' ? monthHTML() : agendaHTML()) + '</div>';
}

const FOCUS_ATTRS = ['data-calkind', 'data-calmode', 'data-calstep', 'data-caltoday', 'data-caldate'];

/** Ré-affiche les commandes et le corps en gardant le focus sur la même commande (le HTML est remplacé). */
function rerender() {
  const wrap = detailEl.querySelector('.cal-wrap');
  const tools = detailEl.querySelector('#cal-tools');
  const main = detailEl.querySelector('#cal-main');
  if (!wrap || !tools || !main) return;
  const a = document.activeElement;
  const attr = a instanceof Element && wrap.contains(a) ? FOCUS_ATTRS.find((x) => a.hasAttribute(x)) : '';
  const again = attr ? '[' + attr + '="' + a.getAttribute(attr) + '"]' : '';
  tools.innerHTML = toolsHTML();
  main.innerHTML = mainHTML();
  const n = again && wrap.querySelector(again);
  if (n) n.focus({ preventScroll: true });
}

async function loadMonth() {
  const token = ++view.token;
  view.loading = true;
  rerender();
  const [from, to] = monthRange(view.y, view.m);
  let events = [];
  try { events = await loadEvents(from, to); } catch (_) { events = []; }
  if (token !== view.token || state.kind !== 'calendar') return;
  view.events = events;
  view.loading = false;
  if (!view.picked) view.sel = pickSelectedDate(view.y, view.m, filterByKinds(events, view.kinds), todayStr());
  rerender();
}

/** Change de mois : sélection recalculée (aujourd'hui, sinon 1er jour avec une sortie une fois chargé), données rechargées. */
function gotoMonth(y, m) {
  view.y = y;
  view.m = m;
  view.events = [];
  view.picked = false;
  view.sel = pickSelectedDate(y, m, [], todayStr());
  loadMonth();
}

/** Sélectionne un jour de la grille : met à jour les cellules et le panneau en place, sans recharger les données. */
function selectDate(date, focus) {
  const same = date === view.sel;
  view.sel = date;
  view.picked = true;
  const body = detailEl.querySelector('#cal-body');
  if (!body || view.mode !== 'month') return;
  if (!same) {
    body.querySelectorAll('[data-caldate]').forEach((c) => {
      const on = c.dataset.caldate === date;
      c.classList.toggle('is-sel', on);
      c.setAttribute('aria-pressed', String(on));
      c.tabIndex = on ? 0 : -1;
    });
    const panel = body.querySelector('#cal-panel');
    if (panel) {
      panel.innerHTML = panelHTML();
      if (!focus && window.matchMedia && window.matchMedia('(max-width: 800px)').matches) panel.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  if (focus) {
    const c = body.querySelector('[data-caldate="' + date + '"]');
    if (c) c.focus();
  }
}

export function showCalendar() {
  teardownFiche();
  state.kind = 'calendar';
  document.title = 'Calendrier · Laststream';
  const now = new Date();
  if (!view.y) { view.y = now.getFullYear(); view.m = now.getMonth() + 1; }
  if (!view.sel || view.sel.slice(0, 7) !== isoDate(view.y, view.m, 1).slice(0, 7)) {
    view.sel = pickSelectedDate(view.y, view.m, view.events, todayStr());
    view.picked = false;
  }
  const empty = !userStore.getFollows().length;
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page cal-page" aria-labelledby="svc-title"><div class="cal-wrap"><header class="cal-top"><div class="cal-ttl">' +
    '<h1 id="svc-title" tabindex="-1">Calendrier</h1><p class="cal-sub">Les sorties de ce que tu suis</p></div>' +
    (empty ? '' : '<div class="cal-tools" id="cal-tools" data-nav></div>') + '</header>' +
    (empty ? '<p class="row-msg">Tu ne suis encore rien. Utilise « Suivre » sur une fiche, une affiche ou une personnalité pour la retrouver ici.</p>' : '<div class="cal-main" id="cal-main"></div>') +
    '</div></article>';
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
    gotoMonth(d.getFullYear(), d.getMonth() + 1);
    return;
  }
  if (t.closest('[data-caltoday]')) {
    const now = new Date();
    if (now.getFullYear() !== view.y || now.getMonth() + 1 !== view.m) { gotoMonth(now.getFullYear(), now.getMonth() + 1); return; }
    selectDate(todayStr(), false);
    const g = detailEl.querySelector('.cal-ag-day.is-today');
    if (g && typeof g.scrollIntoView === 'function') g.scrollIntoView({ block: 'start' });
    return;
  }
  const mode = t.closest('[data-calmode]');
  if (mode) { view.mode = mode.dataset.calmode; rerender(); return; }
  const kind = t.closest('[data-calkind]');
  if (kind) {
    const k = kind.dataset.calkind;
    if (view.kinds.has(k) && view.kinds.size > 1) view.kinds.delete(k); else view.kinds.add(k);
    rerender();
    return;
  }
  const cell = t.closest('[data-caldate]');
  if (cell) selectDate(cell.dataset.caldate, false);
});

// Clavier sur la grille : flèches (±1 / ±7 jours), Home / End (semaine) déplacent la sélection et le focus.
// Une flèche verticale qui sortirait du mois est laissée à la navigation spatiale globale (groupes `data-nav`, events.js).
detailEl.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || state.kind !== 'calendar') return;
  const cell = e.target instanceof Element ? e.target.closest('[data-caldate]') : null;
  if (!cell) return;
  const from = cell.dataset.caldate;
  const to = moveSelection(from, e.key, view.y, view.m);
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (to === from && (vertical || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))) return;
  e.preventDefault();
  e.stopPropagation();
  if (to !== from) selectDate(to, true);
});
