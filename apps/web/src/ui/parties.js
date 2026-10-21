/* Watch parties : liste des salons publics (#/parties) et page d'un salon (#/party/<id>, lien d'invitation) pour le rejoindre. */
import { isKidProfile, isServerMode } from '../data/auth';
import { getParty, listParties } from '../data/socialApi';
import { socialErrorText } from '../data/socialText';
import { userStore } from '../data/userStore';
import { initialsOf } from '../party/lobbyModel';
import { canBrowsePublicParties, canJoinRoom, partyBridge } from '../party/bridge';
import { openLogin } from './auth-ui.js';
import { IMG } from './constants.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { ICON } from './icons.js';
import { sortedFriends } from './partyfriends.js';
import { ago } from './socialFmt.js';
import { state } from './state.js';
import { esc } from './util.js';

const LANGS = [['', 'Toutes'], ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien']];
const KINDS = [['', 'Tout'], ['movie', 'Films'], ['series', 'Séries']];
let filter = { language: '', kind: '' };
let cursor = null;
let rooms = [];
let loading = false;

const langName = (c) => (LANGS.find(([k]) => k === c) || [c, c || ''])[1];
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';

function shell(title, eyebrow, body, tools = '', intro = '') {
  return topBar(false) + '<article class="svc-page soc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain' + (tools ? ' wp-head' : '') + '"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">' + esc(eyebrow) + '</p><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1>' + (intro ? '<p class="wp-intro">' + esc(intro) + '</p>' : '') + '</div>' + tools + '</header><div class="soc-body">' + body + '</div></article>';
}

const message = (text) => '<p class="row-msg" role="status">' + esc(text) + '</p>';

/** Action « Créer une watch party » : point d'entrée unique (la fenêtre de proposition avec recherche la remplacera, ODY-173). */
export function openCreateParty() {
  try { location.hash = '#/discover'; } catch (_) { /* adresse inchangée */ }
  toast('Choisis un titre, puis clique sur Watch party sur sa fiche.');
}

// ---------- Liste des salons publics ----------
/** Noms (normalisés) des amis et profils du foyer : un salon dont l'hôte en fait partie passe dans « Chez tes amis ».
 * Limite : le salon n'expose que le nom libre de l'hôte (non unique), donc un homonyme non ami peut être classé chez les amis. */
function friendNames() {
  const names = new Set();
  try {
    for (const f of sortedFriends()) { names.add(norm(f.handle.name)); names.add(norm(f.handle.full)); }
  } catch (_) { /* social indisponible : aucune section amis */ }
  names.delete('');
  return names;
}

const openedText = (r) => {
  const t = ago(Date.parse(r.createdAt));
  return t ? ' · ouvert ' + (t.startsWith('à') ? t : 'il y a ' + t) : '';
};

function roomCardHTML(r, friend) {
  const nb = Number(r.participants) || 0;
  const max = Number(r.maxParticipants) || 0;
  const full = nb >= max;
  const pct = max > 0 ? Math.min(100, Math.round((nb / max) * 100)) : 0;
  return '<li class="wp-card' + (friend ? ' wp-card-friend' : '') + '" data-room="' + esc(r.id) + '">' +
    '<span class="wp-poster' + (r.poster ? '' : ' no-img') + '">' + (r.poster ? '<img src="' + esc(IMG('w185', r.poster)) + '" alt="" loading="lazy" decoding="async">' : '') + '</span>' +
    '<div class="wp-info">' + (friend ? '<span class="wp-pastille">Ton ami est dedans</span>' : '') + '<strong class="wp-t">' + esc(r.title) + '</strong>' +
    '<span class="wp-chips"><span class="wp-chip">' + (r.mediaType === 'series' ? 'Série' : 'Film') + '</span>' + (r.language ? '<span class="wp-chip">' + esc(langName(r.language)) + '</span>' : '') + '</span>' +
    '<span class="wp-m">' + (friend ? '<span class="wp-av" aria-hidden="true">' + esc(initialsOf(r.host)) + '</span>' : '') + '<span class="wp-host">Hôte : ' + esc(r.host) + openedText(r) + '</span></span>' +
    '<span class="wp-gauge"><span class="wp-bar" aria-hidden="true"><i style="width:' + pct + '%"></i></span><span class="wp-n">' + nb + '/' + max + ' participant' + (nb > 1 ? 's' : '') + '</span></span>' +
    (full ? '<button type="button" class="btn btn-ghost wp-join" disabled>Complet</button>'
      : '<a class="btn btn-primary wp-join" href="#/party/' + encodeURIComponent(r.id) + '" data-go>Rejoindre</a>') + '</div></li>';
}

const CREATE_BTN = '<button type="button" class="btn btn-primary" data-wp-create>' + ICON.plus + 'Créer une watch party</button>';

function emptyHTML() {
  const active = [filter.language && langName(filter.language), filter.kind && (KINDS.find(([k]) => k === filter.kind) || [])[1]].filter(Boolean);
  if (active.length) {
    return '<div class="wp-empty-box"><span class="wp-empty-ico">' + ICON.party + '</span><h2>Aucun salon en ' + esc(active.join(' · ')) + ' pour le moment</h2>' +
      '<div class="wp-empty-acts"><button type="button" class="btn btn-ghost" data-wp-clear>Voir tous les salons</button>' + CREATE_BTN + '</div></div>';
  }
  return '<div class="wp-empty-box"><span class="wp-empty-ico">' + ICON.party + '</span><h2>Aucun salon ouvert pour le moment</h2>' +
    '<p>Lance la tienne : choisis un titre, invite tes amis ou ouvre-la au public. Chacun lit avec sa propre source, vos lectures restent calées ensemble.</p>' +
    '<div class="wp-empty-acts">' + CREATE_BTN + '<a class="btn btn-ghost" href="#/friends" data-go>Voir mes amis</a></div></div>';
}

function syncFilters() {
  detailEl.querySelectorAll('[data-wp-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wpLang === filter.language)));
  detailEl.querySelectorAll('[data-wp-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wpKind === filter.kind)));
}

function paintRooms(err) {
  const slot = detailEl.querySelector('#wp-list');
  if (!slot) return;
  const count = detailEl.querySelector('#wp-count');
  const shown = rooms.filter((r) => !filter.kind || r.mediaType === filter.kind);
  if (count) count.textContent = err || (loading && !rooms.length) ? '' : shown.length + ' salon' + (shown.length > 1 ? 's' : '') + ' ouvert' + (shown.length > 1 ? 's' : '');
  if (err) { slot.innerHTML = '<p class="row-msg" role="alert">' + esc(err) + ' <button type="button" class="link-btn" data-wp-reload>Réessayer</button></p>'; return; }
  if (loading && !rooms.length) {
    slot.innerHTML = '<p class="row-msg" role="status">Chargement…</p><ul class="wp-list wp-skel" aria-hidden="true"><li class="wp-card"></li><li class="wp-card"></li><li class="wp-card"></li></ul>';
    return;
  }
  const names = friendNames();
  const mine = names.size ? shown.filter((r) => names.has(norm(r.host))) : [];
  const pub = mine.length ? shown.filter((r) => !mine.includes(r)) : shown;
  const more = cursor ? '<div class="wp-more"><button type="button" class="btn btn-ghost" data-wp-more>Charger plus</button></div>' : '';
  slot.innerHTML = (mine.length ? '<section class="soc-sec wp-friends" aria-labelledby="wp-h-friends"><h2 class="row-title" id="wp-h-friends">Chez tes amis<em>' + mine.length + '</em></h2><ul class="wp-list">' + mine.map((r) => roomCardHTML(r, true)).join('') + '</ul></section>' : '') +
    (pub.length ? '<section class="soc-sec" aria-labelledby="wp-h-public"><h2 class="row-title" id="wp-h-public">Salons publics<em>' + pub.length + '</em></h2><ul class="wp-list">' + pub.map((r) => roomCardHTML(r, false)).join('') + '</ul></section>' : '') +
    (shown.length ? '' : emptyHTML()) + more;
}

let reqSeq = 0;
async function loadRooms(more) {
  if (more && loading) return;
  const seq = ++reqSeq;
  loading = true;
  if (!more) { rooms = []; cursor = null; paintRooms(); }
  try {
    const res = await listParties(userStore.currentProfile().id, { language: filter.language || undefined, limit: 20, cursor: more ? cursor : null });
    if (seq !== reqSeq) return;
    rooms = more ? [...rooms, ...res.rooms] : res.rooms;
    cursor = res.nextCursor;
    loading = false;
    if (state.kind === 'parties') paintRooms();
  } catch (err) {
    if (seq !== reqSeq) return;
    loading = false;
    if (state.kind === 'parties') paintRooms(socialErrorText(err));
  }
}

export function showParties() {
  teardownFiche();
  state.kind = 'parties';
  document.title = 'Watch parties · Laststream';
  const intro = 'Chacun lit avec sa propre source : la watch party cale vos lectures l’une sur l’autre, aucun flux vidéo n’est partagé.';
  if (!isServerMode() || !canBrowsePublicParties(isKidProfile())) {
    detailEl.innerHTML = shell('Watch parties', 'Regarder ensemble', message(isKidProfile() ? 'Les salons publics ne sont pas disponibles sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour rejoindre une watch party.'));
    return;
  }
  const tools = '<div class="wp-head-acts"><a class="btn btn-ghost" href="#/friends" data-go>' + ICON.users + 'Mes amis</a>' + CREATE_BTN + '</div>';
  const bar = '<div class="wp-filters"><div class="wp-pills" role="group" aria-label="Langue">' +
    LANGS.map(([c, l]) => '<button type="button" class="pill" data-wp-lang="' + c + '" aria-pressed="' + (c === filter.language) + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<div class="wp-seg" role="group" aria-label="Type">' + KINDS.map(([k, l]) => '<button type="button" class="wp-seg-btn" data-wp-kind="' + k + '" aria-pressed="' + (k === filter.kind) + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<span class="wp-count" id="wp-count" aria-live="polite"></span>' +
    '<button type="button" class="wp-refresh" data-wp-reload aria-label="Actualiser la liste" title="Actualiser la liste">' + REFRESH + '</button></div>';
  detailEl.innerHTML = shell('Watch parties', 'Regarder ensemble', bar + '<div id="wp-list">' + message('Chargement…') + '</div>', tools, intro);
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  loadRooms(false);
}

// ---------- Page d'un salon (lien d'invitation) ----------
function roomPageHTML(room, note) {
  const count = Array.isArray(room.participants) ? room.participants.length : room.participants;
  const kid = isKidProfile();
  const blocked = !canJoinRoom(room, kid);
  const ep = room.media.type === 'series' && room.media.season != null ? ' · S' + room.media.season + ':É' + room.media.episode : '';
  return '<div class="wp-card wp-big"><span class="wp-poster' + (room.poster ? '' : ' no-img') + '">' + (room.poster ? '<img src="' + esc(IMG('w342', room.poster)) + '" alt="">' : '') + '</span>' +
    '<div class="wp-info"><strong class="wp-t">' + esc(room.title) + esc(ep) + '</strong>' +
    '<span class="wp-m">' + (room.visibility === 'public' ? 'Salon public' : 'Salon privé') + (room.language ? ' · ' + esc(langName(room.language)) : '') + '</span>' +
    '<span class="wp-m">Hôte : ' + esc(room.host) + ' · ' + count + '/' + room.maxParticipants + ' participant' + (count > 1 ? 's' : '') + '</span>' +
    '<p class="tv-form-msg" data-wp-msg role="status">' + esc(note || (blocked ? 'Ce salon public n’est pas accessible depuis un profil enfant.' : '')) + '</p>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-primary" data-wp-join="' + esc(room.id) + '"' + (blocked ? ' disabled' : '') + '>Rejoindre le salon</button>' +
    '<a class="btn btn-ghost" href="#/" data-go>Accueil</a></div>' +
    '<p class="tv-form-note">Ta lecture utilise ta propre source (ton débrideur) : aucun lien n’est échangé. Elle se cale sur celle de l’hôte.</p></div></div>';
}

export async function showParty(id) {
  teardownFiche();
  state.kind = 'party';
  document.title = 'Watch party · Laststream';
  if (!isServerMode()) {
    detailEl.innerHTML = shell('Watch party', 'Invitation', message('Ce lien est réservé aux comptes Laststream. Demande à l’hôte un lien d’invitation.') +
      '<div class="tv-form-actions"><button type="button" class="btn btn-primary" data-wp-login>Se connecter</button></div>');
    return;
  }
  detailEl.innerHTML = shell('Watch party', 'Invitation', message('Recherche du salon…'));
  const token = state.token;
  try {
    const { room } = await getParty(id);
    if (state.kind !== 'party' || state.token !== token || !detailEl.isConnected) return;
    detailEl.innerHTML = shell('Watch party', 'Invitation', roomPageHTML(room));
  } catch (err) {
    if (state.kind !== 'party') return;
    detailEl.innerHTML = shell('Watch party', 'Invitation', message(socialErrorText(err)) + '<div class="tv-form-actions"><a class="btn btn-ghost" href="#/parties" data-go>Salons publics</a></div>');
  }
}

/** Clic sur « Rejoindre » : connexion au salon puis lecture avec la source de l'utilisateur. */
async function joinFromPage(id, btn) {
  const msg = detailEl.querySelector('[data-wp-msg]');
  btn.disabled = true;
  if (msg) msg.textContent = 'Connexion au salon…';
  try {
    await partyBridge.joinAndPlay(id, userStore.currentProfile().id);
  } catch (err) {
    btn.disabled = false;
    partyBridge.leave();
    const text = err && err.code === 'media_unsupported' ? 'Ce salon ne peut pas être lu depuis cette application.' : socialErrorText(err);
    if (msg) msg.textContent = text;
    else toast(text);
  }
}

detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const join = t.closest('[data-wp-join]');
  if (join && state.kind === 'party') { e.preventDefault(); joinFromPage(join.dataset.wpJoin, join); return; }
  if (t.closest('[data-wp-login]') && state.kind === 'party') { e.preventDefault(); openLogin(); return; }
  if (state.kind !== 'parties') return;
  if (t.closest('[data-wp-create]')) { e.preventDefault(); openCreateParty(); return; }
  if (t.closest('[data-wp-more]')) {
    e.preventDefault();
    loadRooms(true);
    const list = detailEl.querySelector('#wp-list');
    if (list) { list.tabIndex = -1; list.focus({ preventScroll: true }); }
    return;
  }
  if (t.closest('[data-wp-reload]')) { e.preventDefault(); loadRooms(false); return; }
  const lang = t.closest('[data-wp-lang]');
  if (lang) { e.preventDefault(); if (lang.dataset.wpLang !== filter.language) { filter.language = lang.dataset.wpLang; syncFilters(); loadRooms(false); } return; }
  const kind = t.closest('[data-wp-kind]');
  if (kind) { e.preventDefault(); filter.kind = kind.dataset.wpKind; syncFilters(); paintRooms(); return; }
  if (t.closest('[data-wp-clear]')) {
    e.preventDefault();
    const refetch = filter.language !== '';
    filter = { language: '', kind: '' };
    syncFilters();
    if (refetch) loadRooms(false); else paintRooms();
    const all = detailEl.querySelector('[data-wp-lang=""]');
    if (all) all.focus({ preventScroll: true });
  }
});
