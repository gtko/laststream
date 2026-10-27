/* Corps des sections sociales de l'accueil (LAST-194). Données : salons ouverts des amis (une requête à l'ouverture, aucun
 * polling), /home/watching et /home/recommendations (LAST-191), soirées proposées de data/homeSocial.ts (vides tant que le
 * serveur n'en sert pas). Une section sans donnée n'est pas écrite ; un échec réseau la fait disparaître sans bruit. Tout texte
 * venant du serveur passe par esc(). */
import { getState, subscribe } from '../data/socialStore';
import { homeRecommendations, homeWatching } from '../data/socialV3Api';
import { listParties } from '../data/socialApi';
import { userStore } from '../data/userStore';
import { friendName, eveningDay, eveningTime, joinEvening, upcomingEvenings } from '../data/homeSocial';
import { toast } from './dom.js';
import { socialAvailable } from './socialButton.js';
import { posterSrc } from './socialFmt.js';
import { esc } from './util.js';

const WATCH_MAX = 12;
const RECO_MAX = 12;
const MOBILE_LIVE_MAX = 3;
const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#3b3750');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const initials = (name) => esc(Array.from(String(name || '?')).slice(0, 2).join('').toUpperCase());
const TINTS = ['#a0552a', '#2d5d73', '#3c4a5c', '#7a2e2e', '#2f5a3e', '#5b3a7a'];
const tintOf = (title) => TINTS[Array.from(String(title || '')).reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 0) % TINTS.length];

const avatar = (f) => '<span class="hsr-av" aria-hidden="true" style="background:' + colorOf(f.avatarColor) + '">' + initials(friendName(f)) + '</span>';

/** Lien de la fiche d'un titre, ou null si l'identifiant n'est pas un entier valide. */
function ficheHref(m) {
  return m && Number.isInteger(m.tmdbId) && m.tmdbId > 0 ? '#/' + (m.type === 'series' ? 'tv' : 'movie') + '/' + m.tmdbId : null;
}

/** Affiche : image TMDB valide, sinon bloc coloré portant le début du titre. */
function posterHTML(src, title) {
  const url = posterSrc(src);
  return '<span class="hsr-img' + (url ? '' : ' no-img') + '"' + (url ? '' : ' style="background:' + tintOf(title) + '"') + '>' +
    (url ? '<img src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' : '<span aria-hidden="true">' + esc(String(title || '').slice(0, 14).toUpperCase()) + '</span>') + '</span>';
}

const epCode = (m) => (m.type === 'series' && m.season != null && m.episode != null ? 'S' + m.season + '·E' + m.episode : '');

// ---------- Ensemble, ce soir ----------
/** Salons ouverts (non pleins) dont l'hôte est un ami : même rapprochement par nom que « Chez tes amis » de la page Ensemble. */
export function friendRooms(rooms, friends) {
  const names = new Set();
  friends.filter((f) => !f.muted).forEach((f) => { names.add(norm(f.handle.name)); names.add(norm(f.handle.full)); });
  names.delete('');
  return rooms.filter((r) => names.has(norm(r.host)) && (Number(r.participants) || 0) < (Number(r.maxParticipants) || 0));
}

function roomCard(r) {
  const nb = Number(r.participants) || 0;
  return '<article class="hsr-card hsr-room"><div class="hsr-top">' + posterHTML(r.poster, r.title) + '<div class="hsr-body">' +
    '<span class="hsr-live"><i aria-hidden="true"></i>En direct · ' + nb + ' spectateur' + (nb > 1 ? 's' : '') + '</span>' +
    '<h3 class="hsr-t">' + esc(r.title) + '</h3><p class="hsr-sub">Salon de ' + esc(r.host) + '.</p></div></div>' +
    '<div class="hsr-foot"><span class="hsr-who" aria-hidden="true">' + initials(r.host) + '</span>' +
    '<a class="btn btn-primary hsr-btn" href="#/party/' + encodeURIComponent(r.id) + '" data-go aria-label="Rejoindre le salon de ' + esc(r.host) + ' : ' + esc(r.title) + '">Rejoindre</a></div></article>';
}

/** Accueil mobile : « Léa regarde en ce moment » en haut de page, avec Rejoindre (les salons ne sont alors plus répétés plus bas). */
function liveCard(r) {
  const nb = Number(r.participants) || 0;
  return '<article class="hsr-mlive"><span class="hsr-live"><i aria-hidden="true"></i>' + esc(r.host) + ' regarde en ce moment</span>' +
    '<div class="hsr-top">' + posterHTML(r.poster, r.title) + '<div class="hsr-body"><h3 class="hsr-t">' + esc(r.title) + '</h3>' +
    '<p class="hsr-sub">' + nb + ' spectateur' + (nb > 1 ? 's' : '') + '</p></div></div>' +
    '<a class="btn btn-primary hsr-btn hsr-mjoin" href="#/party/' + encodeURIComponent(r.id) + '" data-go aria-label="Rejoindre le salon de ' + esc(r.host) + ' : ' + esc(r.title) + '">Rejoindre le salon</a></article>';
}

export const mobileLiveHTML = (rooms) => rooms.slice(0, MOBILE_LIVE_MAX).map(liveCard).join('');

function eveningCard(e, friends) {
  const going = (e.going || []).map((pid) => friends.find((f) => f.pid === pid)).filter(Boolean);
  return '<article class="hsr-card"><div class="hsr-top">' + posterHTML(e.poster, e.title) + '<div class="hsr-body">' +
    '<span class="hsr-eye">Ce soir · ' + esc(eveningTime(e.startsAt)) + '</span>' +
    '<h3 class="hsr-t">' + esc(e.title || 'Soirée proposée') + '</h3>' +
    '<p class="hsr-sub">' + (e.host ? 'Proposée par ' + esc(e.host) + '. ' : '') + (going.length ? going.length + ' confirmé' + (going.length > 1 ? 's' : '') + '.' : '') + '</p></div></div>' +
    '<div class="hsr-foot"><span class="hsr-stack" aria-hidden="true">' + going.slice(0, 3).map(avatar).join('') + '</span>' +
    '<button type="button" class="btn btn-ghost hsr-btn" data-hsr-evening="' + esc(e.id) + '">Je viens</button></div></article>';
}

const proposeCard = () => '<article class="hsr-card hsr-card-add"><h3 class="hsr-t">Rien de prévu ?</h3>' +
  '<p class="hsr-sub">Choisis un titre, invite tes amis : tout le monde lit au même moment, avec sa propre source.</p>' +
  '<a class="btn btn-ghost hsr-btn" href="#/ensemble" data-go>Proposer une soirée</a></article>';

export function tonightHTML(rooms, evenings, friends) {
  if (!rooms.length && !evenings.length) return '';
  return '<section class="row-section hsr-sec" id="ensemble-ce-soir" aria-labelledby="h-ensemble-ce-soir"><div class="hsr-head">' +
    '<h2 class="row-title" id="h-ensemble-ce-soir">Ensemble, ce soir</h2><a class="row-link" href="#/ensemble" data-go>Tout voir dans Ensemble</a></div>' +
    '<div class="hsr-tonight">' + rooms.map(roomCard).join('') + evenings.map((e) => eveningCard(e, friends)).join('') + proposeCard() + '</div></section>';
}

// ---------- Ce que regardent tes amis ----------
function watchCard(it) {
  const m = it && it.media;
  const href = ficheHref(m);
  if (!m || !m.title || !href || !it.friend) return '';
  const ep = epCode(m);
  const pct = it.duration > 0 ? Math.min(100, Math.round((it.pos / it.duration) * 100)) : 0;
  const state = it.live ? '<span class="hsr-live"><i aria-hidden="true"></i>En cours</span>' : it.finished ? 'Terminé' : pct ? pct + ' %' : '';
  const meta = [ep, state].filter(Boolean).map((x) => (x.startsWith('<') ? x : esc(x))).join(' · ');
  const name = friendName(it.friend);
  return '<a class="hsr-po" href="' + href + '" data-go aria-label="' + esc(name + ' : ' + m.title + (ep ? ', ' + ep : '') + (it.live ? ', en cours' : '')) + '">' +
    posterHTML(m.poster, m.title) + '<span class="hsr-who-tag">' + avatar(it.friend) + esc(name) + '</span>' +
    '<span class="hsr-pt">' + esc(m.title) + '</span><span class="hsr-pm">' + meta + '</span></a>';
}

export function watchingHTML(items) {
  const cards = (items || []).map(watchCard).filter(Boolean).slice(0, WATCH_MAX);
  if (!cards.length) return '';
  return '<section class="row-section hsr-sec" id="amis-regardent" aria-labelledby="h-amis-regardent"><div class="hsr-head">' +
    '<h2 class="row-title" id="h-amis-regardent">Ce que regardent tes amis</h2></div><div class="row">' + cards.join('') + '</div></section>';
}

// ---------- Coups de cœur ----------
function recoCard(it) {
  const m = it && it.media;
  const href = ficheHref(m);
  const word = String((it && it.word) || '').trim();
  if (!m || !m.title || !href || !word || !it.friend) return '';
  const name = friendName(it.friend);
  return '<div class="hsr-reco"><a class="hsr-po" href="' + href + '" data-go aria-label="' + esc(m.title + ', coup de cœur de ' + name) + '">' + posterHTML(m.poster, m.title) +
    '<span class="hsr-pt">' + esc(m.title) + '</span><span class="hsr-pm">' + (m.type === 'series' ? 'Série' : 'Film') + '</span></a>' +
    '<p class="hsr-quote"><b>' + esc(name) + '</b> — « ' + esc(word) + ' »</p></div>';
}

export function recommendationsHTML(items) {
  const cards = (items || []).map(recoCard).filter(Boolean).slice(0, RECO_MAX);
  if (!cards.length) return '';
  return '<section class="row-section hsr-sec" id="coups-de-coeur" aria-labelledby="h-coups-de-coeur"><div class="hsr-head">' +
    '<h2 class="row-title" id="h-coups-de-coeur">Coups de cœur de tes amis</h2></div><div class="row">' + cards.join('') + '</div></section>';
}

// ---------- Montage ----------
const quiet = (p) => p.then((r) => r, () => null); // échec réseau silencieux : la section n'apparaît pas
let seq = 0;
let model = { rooms: [], watching: [], recos: [] };
let lastEl = null;
let lastHtml = '';
let lastTop = null;
let lastMobile = '';
let subscribed = false;

/** Écrit les sections à partir du modèle chargé et de l'état du store ; sans effet si rien n'a changé. */
export function renderSlot(s = getState(), now = Date.now()) {
  const el = document.getElementById('social-slot');
  const top = document.getElementById('social-mobile');
  if (!el && !top) return;
  const friends = s.friends || [];
  const rooms = friendRooms(model.rooms, friends);
  const on = socialAvailable();
  const html = on ? tonightHTML(rooms, upcomingEvenings(now), friends) + watchingHTML(model.watching) + recommendationsHTML(model.recos) : '';
  const mobile = on ? mobileLiveHTML(rooms) : '';
  if (el === lastEl && top === lastTop && html === lastHtml && mobile === lastMobile) return;
  lastEl = el;
  lastTop = top;
  lastHtml = html;
  lastMobile = mobile;
  // eslint-disable-next-line no-restricted-syntax -- données serveur échappées par esc (tonightHTML, watchingHTML, recommendationsHTML)
  if (el) el.innerHTML = html;
  // eslint-disable-next-line no-restricted-syntax -- données serveur échappées par esc (mobileLiveHTML)
  if (top) top.innerHTML = mobile;
}

/** Charge les trois sources en parallèle puis dessine ; les amis qui arrivent plus tard redessinent sans nouvelle requête. */
export async function paintHomeSocial() {
  if (!socialAvailable()) return;
  const mine = ++seq;
  if (!subscribed) { subscribed = true; subscribe((s) => renderSlot(s)); }
  const [rooms, watching, recos] = await Promise.all([
    quiet(listParties(userStore.currentProfile().id, { limit: 20 })),
    quiet(homeWatching(WATCH_MAX)),
    quiet(homeRecommendations({ limit: RECO_MAX })),
  ]);
  if (mine !== seq) return;
  model = { rooms: (rooms && rooms.rooms) || [], watching: (watching && watching.items) || [], recos: (recos && recos.items) || [] };
  renderSlot();
}

document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-hsr-evening]') : null;
  if (!b) return;
  e.preventDefault();
  void joinEvening(b.dataset.hsrEvening).then((ok) => { if (!ok) toast('Cette soirée n’est plus disponible.'); });
});
