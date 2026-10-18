/* Émissions TV : page #/emissions, fiche d'une émission (#/emission/{id}), rangées d'accueil « Émissions du moment »
 * et « Ce soir à la TV ». Les données viennent de TMDB et du guide TV (voir data/showsApi.ts). */
import { isKidProfile } from '../data/auth';
import { loadGuide, loadShows, pastEpisodes, showDetail } from '../data/showsApi';
import { airingsFor, dayLabel, hhmm, isLiveNow, localDate, matchKnown, primeTime, progressPct, seedFor } from '../data/shows';
import { register, toItem } from './catalog.js';
import { IMG } from './constants.js';
import { detailEl } from './dom.js';
import { ficheHeroShell, ficheSkeleton, fsec, teardownFiche } from './fiche.js';
import { followBtn } from './follows.js';
import { svcError, topBar } from './fragments.js';
import { ICON } from './icons.js';
import { openPlayer } from './player.js';
import { fetchProviders, providersHTML } from './providers.js';
import { go } from './router.js';
import { state } from './state.js';
import { fallbackHTML } from './typo.js';
import { normChannel, tv } from './tv.js';
import { esc, fmtDate, fmtMin } from './util.js';

const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
const nowSec = () => Math.floor(Date.now() / 1000);

/** Libellé court de la prochaine diffusion : « En direct · TF1 », « Aujourd’hui 21:10 · TF1 ». */
export function airingLabel(a, now) {
  const chan = a.channel.name;
  return isLiveNow(a, now) ? 'En direct · ' + chan : dayLabel(a.start, now) + ' ' + hhmm(a.start) + ' · ' + chan;
}

/** Ligne de sous-titre d'une carte d'émission. */
export function showSub(s, now) {
  if (s.airings.length) return airingLabel(s.airings[0], now);
  if (s.next && s.next.date) return (s.platform ? s.platform + ' · ' : '') + 'épisode le ' + shortDate(s.next.date);
  return s.platform || 'Émission';
}

/** Carte « Émissions du moment » : affiche 2:3 comme les autres rangées de posters, titre et diffusion dessous. */
export function showCard(s, now) {
  const live = s.airings.length && isLiveNow(s.airings[0], now);
  const sub = showSub(s, now);
  const src = IMG('w342', s.poster);
  return '<button type="button" class="card tile show-card" data-showopen="' + esc(s.id) + '" aria-label="' + esc(s.name + ', ' + sub) + '">' +
    '<span class="card-media' + (src ? '' : ' no-img') + '">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: s.name, type: 'tv' }) +
    (live ? '<span class="t-badge show-live" aria-hidden="true">En direct</span>' : '') + '</span>' +
    '<span class="card-title" aria-hidden="true">' + esc(s.name) + '</span><span class="card-meta" aria-hidden="true">' + esc(sub) + '</span></button>';
}

// ---------- Rangées d'accueil ----------
async function renderShowsRow() {
  const slot = document.getElementById('shows-slot');
  if (!slot) return;
  const { shows } = await loadShows();
  const now = nowSec();
  const today = new Date().toISOString().slice(0, 10);
  const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const items = shows.filter((s) => s.airings.length || (s.next && s.next.date >= today && s.next.date <= in14)).slice(0, 20);
  const fresh = document.getElementById('shows-slot');
  if (!fresh || !items.length) return;
  fresh.innerHTML = '<section class="row-section" id="emissions" aria-labelledby="h-emissions"><h2 class="row-title" id="h-emissions">Émissions du moment ' +
    '<a class="row-link" href="#/emissions" data-showsnav>Toutes les émissions</a></h2>' + '<div class="row" data-nav>' + items.map((s) => showCard(s, now)).join('') + '</div></section>';
}

/**
 * Carte « Ce soir à la TV » : paysage 16:9 (même gabarit que « Reprendre la lecture »). Image : fond TMDB de l'émission
 * si elle est connue, sinon image du guide, sinon fond typographique. Chaîne en haut à gauche, heure et durée en grand,
 * titre et genre en bas ; « En direct » et progression si l'émission est en cours à `now` (secondes).
 */
export function tonightTile(a, known, now) {
  const live = isLiveNow(a, now);
  const img = known && known.backdrop ? IMG('w780', known.backdrop) : a.icon || '';
  const ch = a.channel;
  const dur = fmtMin(Math.round((a.stop - a.start) / 60));
  const attrs = known ? ' data-showopen="' + esc(known.id) + '"' : ch.playId ? ' data-showwatch="' + esc(ch.playId) + '"' : ' data-showsnav';
  const label = [a.title, ch.name, hhmm(a.start)].join(', ') + (live ? ', en direct' : '');
  const chan = '<span class="tn-chan">' + (ch.num ? '<b class="ch-num">' + ch.num + '</b>' : '') +
    (ch.logo ? '<img class="tn-logo" src="' + esc(ch.logo) + '" alt="" loading="lazy" decoding="async">' : '<span class="tn-name">' + esc(ch.name) + '</span>') + '</span>';
  return '<button type="button" class="card tile tile-land show-card tonight-card' + (live ? ' is-live' : '') + (known ? '' : ' is-epg') + '"' + attrs + ' aria-label="' + esc(label) + '">' +
    '<span class="card-media' + (img ? '' : ' no-img') + '">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" decoding="async">' : '') +
    fallbackHTML({ name: a.title, type: 'tv' }) +
    '<span class="t-shade" aria-hidden="true"></span>' + chan +
    (live ? '<span class="t-badge show-live" aria-hidden="true">En direct</span>' : '') +
    '<span class="tn-info" aria-hidden="true"><span class="tn-when"><strong class="tn-time">' + hhmm(a.start) + '</strong>' +
    (dur ? '<span class="tn-dur">' + esc(dur) + '</span>' : '') + '</span>' +
    '<span class="tn-title">' + esc(a.title) + '</span>' + (a.category ? '<span class="tn-sub">' + esc(a.category) + '</span>' : '') + '</span>' +
    (live ? '<span class="progress" aria-hidden="true"><span style="width:' + progressPct(a, now) + '%"></span></span>' : '') + '</span></button>';
}

async function renderTonightRow() {
  const slot = document.getElementById('tonight-slot');
  if (!slot) return;
  const [guide, listed] = await Promise.all([loadGuide(), loadShows().catch(() => null)]);
  const now = nowSec();
  const late = new Date().getHours() >= 23;
  const date = localDate(late ? now + 86400 : now);
  const prime = primeTime(guide.programs, guide.channelOf, date);
  const fresh = document.getElementById('tonight-slot');
  if (!fresh || prime.length < 3) return;
  const known = listed ? listed.shows : [];
  fresh.innerHTML = '<section class="row-section" id="ce-soir" aria-labelledby="h-ce-soir"><h2 class="row-title" id="h-ce-soir">' + (late ? 'Demain soir à la TV' : 'Ce soir à la TV') +
    ' <a class="row-link" href="#/tv-live" data-tvlive>Guide TV</a></h2>' + '<div class="row" data-nav>' +
    prime.slice(0, 16).map((a) => tonightTile(a, matchKnown(a.title, known.map((k) => ({ ...k, aliases: k.aliases }))), now)).join('') + '</div></section>';
}

/** Rangées « Ce soir à la TV » et « Émissions du moment » de l'accueil (silencieuses en cas d'échec). */
export function renderTvRows() {
  if (isKidProfile() || state.status !== 'ready') return;
  setTimeout(() => {
    renderTonightRow().catch(() => {});
    renderShowsRow().catch(() => {});
  }, 600);
}

// ---------- Page « Émissions TV » ----------
export async function showShowsPage() {
  teardownFiche();
  const token = state.token;
  state.kind = 'shows';
  document.title = 'Émissions TV · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  let data;
  try { data = await loadShows(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Les émissions n’ont pas pu être chargées.');
    return;
  }
  if (token !== state.token) return;
  const now = nowSec();
  const onTv = data.shows.filter((s) => s.airings.length);
  const stream = data.shows.filter((s) => !s.airings.length);
  const grid = (list, empty) => '<div class="lib-grid" data-nav>' + (list.length ? list.map((s) => showCard(s, now)).join('') : '<p class="row-msg">' + empty + '</p>') + '</div>';
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page shows-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<h1 class="svc-title" id="svc-title" tabindex="-1">Émissions TV</h1>' +
    '<p class="svc-eyebrow">Divertissement, jeux, talk-shows et téléréalité : quand et où les regarder</p></div></header>' +
    '<h2 class="row-title shows-h">À la télé</h2>' + grid(onTv, 'Aucune de ces émissions n’est annoncée au guide TV pour le moment.') +
    '<h2 class="row-title shows-h">Autres émissions</h2>' + grid(stream, 'Rien d’autre pour le moment.') + '</article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
}

// ---------- Fiche d'une émission ----------
function airingRow(a, now, hasPlay) {
  const live = isLiveNow(a, now);
  const ch = a.channel;
  const num = ch.num ? '<b class="ch-num">' + ch.num + '</b>' : '';
  return '<li class="show-air' + (live ? ' is-live' : '') + '"><span class="sa-chan">' +
    (ch.logo ? '<img src="' + esc(ch.logo) + '" alt="" loading="lazy" decoding="async">' : '<b>' + esc(ch.name.slice(0, 3)) + '</b>') + '<span class="sa-name">' + num + esc(ch.name) + '</span></span>' +
    '<span class="sa-when"><strong>' + (live ? 'En direct maintenant' : esc(dayLabel(a.start, now))) + '</strong> ' + hhmm(a.start) + ' – ' + hhmm(a.stop) + '</span>' +
    '<span class="sa-title">' + esc(a.title) + '</span>' +
    (live ? '<span class="progress sa-prog" aria-hidden="true"><span style="width:' + progressPct(a, now) + '%"></span></span>' : '') +
    (live && hasPlay && ch.playId ? '<button type="button" class="btn btn-primary btn-sm" data-showwatch="' + esc(ch.playId) + '">' + ICON.play + '<span>Regarder en direct</span></button>' : '') +
    '</li>';
}

function nextLine(d, airings, platform, now) {
  if (airings.length) {
    const a = airings[0];
    return isLiveNow(a, now) ? '<span>En direct</span> sur <strong>' + esc(a.channel.name) + '</strong> jusqu’à ' + hhmm(a.stop)
      : '<span>Prochaine diffusion</span> ' + esc(dayLabel(a.start, now).toLowerCase()) + ' à <strong>' + hhmm(a.start) + '</strong> sur ' + esc(a.channel.name);
  }
  if (d.next && d.next.date) return (platform ? 'Disponible sur <strong>' + esc(platform) + '</strong>, ' : '') + '<span>Nouvel épisode</span> le <strong>' + esc(fmtDate(d.next.date)) + '</strong>';
  return platform ? 'Disponible sur <strong>' + esc(platform) + '</strong>' : '';
}

function pastHTML(list) {
  if (!list.length) return '<p class="row-msg">Aucun épisode précédent trouvé.</p>';
  return '<ol class="show-past">' + list.map((e) =>
    '<li class="show-ep"><span class="se-code">S' + e.season + ' · É' + e.episode + '</span><span class="se-name">' + esc(e.name || 'Épisode ' + e.episode) + '</span><span class="se-date">' + esc(fmtDate(e.date)) + '</span></li>').join('') + '</ol>';
}

export async function showShow(id) {
  teardownFiche();
  const token = state.token;
  state.kind = 'show';
  state.ficheKey = 'tv:' + id;
  detailEl.innerHTML = ficheSkeleton(null);
  const shell = detailEl.querySelector('.fiche');
  if (shell) shell.focus({ preventScroll: true });
  let d;
  let guide = null;
  try {
    [d, guide] = await Promise.all([showDetail(id), loadGuide().catch(() => null)]);
  } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('Cette émission n’a pas pu être chargée.');
    return;
  }
  if (token !== state.token) return;
  const now = nowSec();
  const seed = seedFor(d.name);
  const airings = guide ? airingsFor({ name: d.name, aliases: seed ? [seed.name, ...(seed.aliases ?? [])] : [] }, guide.programs, guide.channelOf, now) : [];
  const platform = (seed && seed.streaming) || '';
  const key = 'tv:' + id;
  register(toItem({ id: Number(id), name: d.name, poster_path: d.poster, backdrop_path: d.backdrop, overview: d.overview }, 'tv'));
  state.ficheName = d.name;
  const hasPlay = !!guide;
  const line = nextLine(d, airings, platform, now);
  detailEl.innerHTML = topBar(true) +
    '<article class="fiche show-fiche" aria-labelledby="f-title" data-key="' + esc(key) + '">' +
    ficheHeroShell({ backdropPath: d.backdrop }, null) +
    '<section class="f-first" aria-label="Présentation"><div class="f-info"><p class="svc-eyebrow">Émission TV</p>' +
    '<h1 class="f-title" id="f-title" tabindex="-1"><span class="title-text">' + esc(d.name) + '</span></h1>' +
    '<ul class="meta f-meta">' + (d.networks.length ? '<li>' + esc(d.networks.slice(0, 3).join(' · ')) + '</li>' : '') + (d.status ? '<li>' + esc(d.status) + '</li>' : '') + '</ul>' +
    '<p class="f-release" id="show-next"' + (line ? '' : ' hidden') + '>' + line + '</p>' +
    '<div class="f-prov" id="f-prov" data-nav></div>' +
    '<div class="f-syn" data-nav><p class="f-ov">' + esc(d.overview || 'Pas de synopsis disponible.') + '</p></div>' +
    '<div class="f-actions" id="f-actions" data-nav>' +
    (airings.length && isLiveNow(airings[0], now) && hasPlay && airings[0].channel.playId
      ? '<button type="button" class="btn btn-primary btn-pill" data-showwatch="' + esc(airings[0].channel.playId) + '">' + ICON.play + '<span>Regarder en direct</span></button>' : '') +
    followBtn(key, 'btn btn-ghost btn-pill', '', 'Me prévenir') +
    '<a class="btn btn-ghost btn-pill" href="#/tv/' + id + '" data-open="' + esc(key) + '"><span>Fiche série</span></a>' +
    '</div></div></section><div class="f-panels">' +
    fsec('airings', 'Prochaines diffusions', airings.length
      ? '<ul class="show-airs" data-nav>' + airings.slice(0, 12).map((a) => airingRow(a, now, hasPlay)).join('') + '</ul>'
      : '<p class="row-msg">Aucune diffusion annoncée au guide TV pour le moment' + (platform ? ' : cette émission est sur ' + esc(platform) + '.' : '.') + '</p>') +
    fsec('past', 'Épisodes précédents', '<div id="show-past"><span class="sk sk-line"></span></div>') +
    fsec('where', 'Où regarder', '<div class="f-prov" id="show-where"><span class="sk sk-line"></span></div>') +
    '</div></article>';
  document.title = d.name + ' · Laststream';
  const h1 = detailEl.querySelector('#f-title');
  if (h1) h1.focus({ preventScroll: true });
  const today = new Date().toISOString().slice(0, 10);
  pastEpisodes(d, today).then((list) => {
    const box = detailEl.querySelector('#show-past');
    if (box && token === state.token) box.innerHTML = pastHTML(list);
  }).catch(() => {
    const box = detailEl.querySelector('#show-past');
    if (box && token === state.token) box.innerHTML = '<p class="row-msg">Les épisodes n’ont pas pu être chargés.</p>';
  });
  fetchProviders('tv', id).then((pr) => {
    if (token !== state.token) return;
    const where = detailEl.querySelector('#show-where');
    if (where) where.innerHTML = providersHTML(pr);
    const top = detailEl.querySelector('#f-prov');
    if (top) top.innerHTML = providersHTML(pr);
    const prov = platform || (pr.flatrate[0] && pr.flatrate[0].name) || '';
    const next = detailEl.querySelector('#show-next');
    const l = nextLine(d, airings, prov, now);
    if (next && l) { next.innerHTML = l; next.hidden = false; }
  }).catch(() => {
    const where = detailEl.querySelector('#show-where');
    if (where) where.innerHTML = '<p class="row-msg">Disponibilités indisponibles.</p>';
  });
}

// ---------- Lecture en direct d'une chaîne ----------
export async function watchChannel(playId, opener) {
  let guide;
  try { guide = await loadGuide(); } catch (_) { return; }
  const raw = guide.catalog.get(playId);
  if (!raw) return;
  const list = guide.channels.map((c) => (c.playId ? guide.catalog.get(c.playId) : null)).filter(Boolean).map(normChannel);
  list.forEach((c) => tv.byId.set(c.id, c));
  const c = tv.byId.get(playId) || normChannel(raw);
  openPlayer(c, list, opener);
}

// ---------- Clics ----------
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const watch = t.closest('[data-showwatch]');
  if (watch) { e.preventDefault(); e.stopPropagation(); watchChannel(watch.dataset.showwatch, watch); return; }
  const open = t.closest('[data-showopen]');
  if (open) { e.preventDefault(); e.stopPropagation(); go('#/emission/' + open.dataset.showopen, open); return; }
  const nav = t.closest('[data-showsnav]');
  if (nav) { e.preventDefault(); e.stopPropagation(); go('#/emissions', nav); }
}, true);
