/* Watch parties : liste des salons ouverts (onglet « Maintenant » de la page Ensemble, ensemble.js) et page d'un salon (#/party/<id>, lien d'invitation) pour le rejoindre. */
import { isKidProfile, isServerMode } from '../data/auth';
import { getParty, listParties } from '../data/socialApi';
import { requestJoin, subscribe } from '../data/socialStore';
import { socialErrorText } from '../data/socialText';
import { userStore } from '../data/userStore';
import { initialsOf } from '../party/lobbyModel';
import { canJoinRoom, partyBridge } from '../party/bridge';
import { openLogin } from './auth-ui.js';
import { IMG } from './constants.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { ICON } from './icons.js';
import { sortedFriends } from './partyfriends.js';
import { friendRooms } from './homeSocialRows.js';
import { ago, clock, episodeCode, livePos, shortName, watchLine } from './socialFmt.js';
import { state } from './state.js';
import { esc } from './util.js';

const LANGS = [['', 'Toutes'], ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien']];
const KINDS = [['', 'Tout'], ['movie', 'Films'], ['series', 'Séries']];
let filter = { language: '', kind: '' };
let cursor = null;
let rooms = [];
let loading = false;
/** Mode du panneau : « now » (Maintenant : amis en direct puis salons publics) ou « public » (onglet Salons publics : liste complète, bouton Entrer). */
let paneMode = 'now';
/** Dernier message d'erreur de chargement ('' = aucun) : relu par chaque redessin (présence des amis) pour ne pas l'effacer. */
let paneErr = '';
/** Amis dont la demande d'entrée est partie pendant ce montage. */
const knocked = new Set();
/** Compteur de montages : une réponse ou un clic dont le montage est périmé n'écrit plus rien. */
let mountGen = 0;
/** Dernier HTML écrit par élément (évite de réécrire le DOM quand rien ne change). */
const written = new WeakMap();
function setHtml(el, html) {
  if (written.get(el) === html) return;
  written.set(el, html);
  // eslint-disable-next-line no-restricted-syntax -- données serveur échappées par esc dans chaque gabarit
  el.innerHTML = html;
}

const langName = (c) => (LANGS.find(([k]) => k === c) || [c, c || ''])[1];
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';

function shell(title, eyebrow, body) {
  return topBar(false) + '<article class="svc-page soc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">' + esc(eyebrow) + '</p><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header><div class="soc-body">' + body + '</div></article>';
}

const message = (text) => '<p class="row-msg" role="status">' + esc(text) + '</p>';

/** Action « Créer une watch party » : point d'entrée unique (la fenêtre de proposition avec recherche la remplacera, ODY-173). */
export function openCreateParty() {
  try { location.hash = '#/discover'; } catch (_) { /* adresse inchangée */ }
  toast('Choisis un titre, puis clique sur Watch party sur sa fiche.');
}

// ---------- Liste des salons publics ----------
/** Amis et profils du foyer (vide si le social est indisponible). */
function allFriends() {
  try { return sortedFriends(); } catch (_) { return []; }
}

/** Ami hôte du salon `host` (même rapprochement par nom que friendRooms), ou null.
 * Limite : le salon n'expose que le nom libre de l'hôte (non unique), donc un homonyme non ami peut être classé chez les amis. */
const hostFriend = (host, friends) => friends.find((f) => !f.muted && (norm(f.handle.name) === norm(host) || norm(f.handle.full) === norm(host))) || null;

const openedText = (r) => {
  const t = ago(Date.parse(r.createdAt));
  return t ? ' · ouvert ' + (t.startsWith('à') ? t : 'il y a ' + t) : '';
};

const posterHTML = (poster) => '<span class="wp-poster' + (poster ? '' : ' no-img') + '">' + (poster ? '<img src="' + esc(IMG('w185', poster)) + '" alt="" loading="lazy" decoding="async">' : '') + '</span>';
const epSuffix = (w) => (w && w.type === 'series' && episodeCode(w) ? ' · ' + episodeCode(w) : '');

/** Carte d'un salon. `friend` : ami hôte (ou null) ; sa présence donne l'épisode et la position de lecture. `cta` : libellé du bouton (Rejoindre / Entrer). */
function roomCardHTML(r, friend, cta) {
  const nb = Number(r.participants) || 0;
  const max = Number(r.maxParticipants) || 0;
  const full = nb >= max;
  const pct = max > 0 ? Math.min(100, Math.round((nb / max) * 100)) : 0;
  const w = friend && friend.watching;
  const live = friend ? '<span class="wp-live"><i aria-hidden="true"></i>En direct' + (w ? ' · ' + esc(clock(livePos(w))) : '') + '</span>' : '';
  return '<li class="wp-card' + (friend ? ' wp-card-friend' : '') + '" data-room="' + esc(r.id) + '">' + posterHTML(r.poster) +
    '<div class="wp-info">' + (friend ? '<span class="wp-pastille">Ton ami est dedans</span>' + live : '') + '<strong class="wp-t">' + esc(r.title) + esc(epSuffix(w)) + '</strong>' +
    '<span class="wp-chips"><span class="wp-chip">' + (r.mediaType === 'series' ? 'Série' : 'Film') + '</span>' + (r.language ? '<span class="wp-chip">' + esc(langName(r.language)) + '</span>' : '') + '</span>' +
    '<span class="wp-m">' + (friend ? '<span class="wp-av" aria-hidden="true">' + esc(initialsOf(r.host)) + '</span>' : '') + '<span class="wp-host">Hôte : ' + esc(r.host) + openedText(r) + '</span></span>' +
    '<span class="wp-gauge"><span class="wp-bar" aria-hidden="true"><i style="width:' + pct + '%"></i></span><span class="wp-n">' + nb + '/' + max + ' participant' + (nb > 1 ? 's' : '') + '</span></span>' +
    (full ? '<button type="button" class="btn btn-ghost wp-join" disabled>Complet</button>'
      : '<a class="btn btn-primary wp-join" href="#/party/' + encodeURIComponent(r.id) + '" data-go>' + cta + '</a>') + '</div></li>';
}

/** Ami qui regarde sans salon public repéré : seul un message à l'ami peut ouvrir la porte (le serveur ne liste pas les salons privés). */
function knockCardHTML(f) {
  const w = f.watching;
  const name = shortName(f);
  const sent = knocked.has(f.pid);
  return '<li class="wp-card wp-card-friend wp-card-private" data-friend="' + esc(f.pid) + '">' + posterHTML(w.poster) +
    '<div class="wp-info"><span class="wp-pastille">Entrée sur demande</span><span class="wp-live"><i aria-hidden="true"></i>En direct · ' + esc(clock(livePos(w))) + '</span>' +
    '<strong class="wp-t">' + esc(w.title) + esc(epSuffix(w)) + '</strong>' +
    '<span class="wp-m"><span class="wp-av" aria-hidden="true">' + esc(initialsOf(name)) + '</span><span class="wp-host">' + esc(name) + ' · ' + esc(watchLine(w)) + '</span></span>' +
    '<button type="button" class="btn btn-ghost wp-join" data-ens-knock="' + esc(f.pid) + '"' + (sent ? ' disabled' : '') + ' aria-label="Demander à entrer dans le salon de ' + esc(name) + '">' + (sent ? 'Demande envoyée' : 'Demander à entrer') + '</button></div></li>';
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

function paintRooms() {
  const slot = detailEl.querySelector('#wp-list');
  if (!slot) return;
  const err = paneErr;
  const count = detailEl.querySelector('#wp-count');
  const shown = rooms.filter((r) => !filter.kind || r.mediaType === filter.kind);
  if (count) count.textContent = err || (loading && !rooms.length) ? '' : shown.length + ' salon' + (shown.length > 1 ? 's' : '') + ' ouvert' + (shown.length > 1 ? 's' : '');
  if (err) { setHtml(slot, '<p class="row-msg" role="alert">' + esc(err) + ' <button type="button" class="link-btn" data-wp-reload>Réessayer</button></p>'); return; }
  if (loading && !rooms.length) {
    setHtml(slot, '<p class="row-msg" role="status">Chargement…</p><ul class="wp-list wp-skel" aria-hidden="true"><li class="wp-card"></li><li class="wp-card"></li><li class="wp-card"></li></ul>');
    return;
  }
  const friends = paneMode === 'now' ? allFriends() : [];
  const mine = paneMode === 'now' ? friendRooms(shown, friends) : [];
  const pub = mine.length ? shown.filter((r) => !mine.includes(r)) : shown;
  const taken = new Set(rooms.map((r) => hostFriend(r.host, friends)).filter(Boolean).map((f) => f.pid));
  const knock = friends.filter((f) => !f.muted && f.watching && f.status !== 'offline' && !taken.has(f.pid) && (!filter.kind || f.watching.type === filter.kind));
  const cta = paneMode === 'public' ? 'Entrer' : 'Rejoindre';
  const more = cursor ? '<div class="wp-more"><button type="button" class="btn btn-ghost" data-wp-more>Charger plus</button></div>' : '';
  const nbFriends = mine.length + knock.length;
  setHtml(slot, (nbFriends ? '<section class="soc-sec wp-friends" aria-labelledby="wp-h-friends"><h2 class="row-title" id="wp-h-friends">En direct chez tes amis<em>' + nbFriends + '</em></h2><ul class="wp-list">' +
      mine.map((r) => roomCardHTML(r, hostFriend(r.host, friends), cta)).join('') + knock.map(knockCardHTML).join('') + '</ul></section>' : '') +
    (pub.length ? '<section class="soc-sec" aria-labelledby="wp-h-public"><h2 class="row-title" id="wp-h-public">Salons publics<em>' + pub.length + '</em></h2><ul class="wp-list">' + pub.map((r) => roomCardHTML(r, null, cta)).join('') + '</ul></section>' : '') +
    (shown.length || nbFriends ? '' : emptyHTML()) + more);
}

let reqSeq = 0;
async function loadRooms(more) {
  if (more && loading) return;
  const seq = ++reqSeq;
  const gen = mountGen;
  const pid = userStore.currentProfile().id;
  const current = () => seq === reqSeq && gen === mountGen && pid === userStore.currentProfile().id;
  loading = true;
  paneErr = '';
  if (!more) { rooms = []; cursor = null; paintRooms(); }
  try {
    const res = await listParties(pid, { language: filter.language || undefined, limit: 20, cursor: more ? cursor : null });
    if (!current()) return;
    rooms = more ? [...rooms, ...res.rooms] : res.rooms;
    cursor = res.nextCursor;
    loading = false;
    if (state.kind === 'ensemble') paintRooms();
  } catch (err) {
    if (!current()) return;
    loading = false;
    paneErr = socialErrorText(err);
    if (state.kind === 'ensemble') paintRooms();
  }
}

let subscribed = false;
/** Remplit `host` (panneau « Maintenant » ou « Salons publics » de la page Ensemble, selon `mode`) : filtres, puis salons chargés depuis le serveur. Réservé aux comptes connectés hors profil enfant (ensemble.js). */
export function mountPartiesPane(host, mode = 'now') {
  paneMode = mode === 'public' ? 'public' : 'now';
  mountGen++;
  reqSeq++; // une réponse d'un montage précédent (autre onglet, autre profil) ne doit rien écrire
  paneErr = '';
  loading = false;
  rooms = [];
  cursor = null;
  knocked.clear();
  if (!subscribed) {
    subscribed = true;
    // La présence des amis redessine « En direct chez tes amis » sans nouvelle requête ; setHtml ignore les émissions sans effet.
    subscribe(() => { if (state.kind === 'ensemble' && !loading && detailEl.querySelector('#wp-list')) paintRooms(); });
  }
  const intro = '<p class="wp-intro">Chacun lit avec sa propre source : la watch party cale vos lectures l’une sur l’autre, aucun flux vidéo n’est partagé.</p>';
  const bar = '<div class="wp-filters"><div class="wp-pills" role="group" aria-label="Langue">' +
    LANGS.map(([c, l]) => '<button type="button" class="pill" data-wp-lang="' + c + '" aria-pressed="' + (c === filter.language) + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<div class="wp-seg" role="group" aria-label="Type">' + KINDS.map(([k, l]) => '<button type="button" class="wp-seg-btn" data-wp-kind="' + k + '" aria-pressed="' + (k === filter.kind) + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<span class="wp-count" id="wp-count" aria-live="polite"></span>' +
    '<button type="button" class="wp-refresh" data-wp-reload aria-label="Actualiser la liste" title="Actualiser la liste">' + REFRESH + '</button></div>';
  // eslint-disable-next-line no-restricted-syntax -- gabarit statique, libellés échappés par esc
  host.innerHTML = '<div class="soc-body wp-pane">' + intro + bar + '<div id="wp-list">' + message('Chargement…') + '</div></div>';
  loadRooms(false);
}

/** Clic sur « Demander à entrer » : message à l'ami (POST /friends/:pid/join-request). Le bouton se désactive ; un échec le rend. */
async function knockFriend(btn) {
  const pid = btn.dataset.ensKnock;
  if (!pid || knocked.has(pid) || btn.disabled) return;
  const gen = mountGen;
  btn.disabled = true;
  btn.textContent = 'Envoi…';
  try {
    await requestJoin(pid);
    if (gen !== mountGen) return;
    knocked.add(pid);
    btn.textContent = 'Demande envoyée';
    toast('Demande envoyée : tu seras prévenu si on t’ouvre la porte.');
  } catch (err) {
    if (gen !== mountGen) return;
    btn.disabled = false;
    btn.textContent = 'Demander à entrer';
    toast(err && err.status === 403 ? 'Cet ami n’accepte pas les demandes d’entrée.' : socialErrorText(err));
  }
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
    detailEl.innerHTML = shell('Watch party', 'Invitation', message(socialErrorText(err)) + '<div class="tv-form-actions"><a class="btn btn-ghost" href="#/ensemble" data-go>Salons ouverts</a></div>');
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
  if (state.kind !== 'ensemble') return;
  const knock = t.closest('[data-ens-knock]');
  if (knock) { e.preventDefault(); void knockFriend(knock); return; }
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
