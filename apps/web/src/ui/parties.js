/* Watch parties : liste des salons publics (#/parties) et page d'un salon (#/party/<id>, lien d'invitation) pour le rejoindre. */
import { isKidProfile, isServerMode } from '../data/auth';
import { getParty, listParties } from '../data/socialApi';
import { socialErrorText } from '../data/socialText';
import { userStore } from '../data/userStore';
import { canBrowsePublicParties, canJoinRoom, partyBridge } from '../party/bridge';
import { openLogin } from './auth-ui.js';
import { IMG } from './constants.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { esc } from './util.js';

const LANGS = [['', 'Toutes les langues'], ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien']];
let filter = { language: '' };
let cursor = null;
let rooms = [];
let loading = false;

const langName = (c) => (LANGS.find(([k]) => k === c) || [c, c || ''])[1];

function shell(title, eyebrow, body, tools = '') {
  return topBar(false) + '<article class="svc-page soc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">' + esc(eyebrow) + '</p><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1>' + tools + '</div></header><div class="soc-body">' + body + '</div></article>';
}

const message = (text) => '<p class="row-msg" role="status">' + esc(text) + '</p>';

// ---------- Liste des salons publics ----------
export function roomCardHTML(r) {
  const full = r.participants >= r.maxParticipants;
  return '<li class="wp-card" data-room="' + esc(r.id) + '">' +
    '<span class="wp-poster' + (r.poster ? '' : ' no-img') + '">' + (r.poster ? '<img src="' + esc(IMG('w185', r.poster)) + '" alt="" loading="lazy" decoding="async">' : '') + '</span>' +
    '<div class="wp-info"><strong class="wp-t">' + esc(r.title) + '</strong>' +
    '<span class="wp-m">' + (r.mediaType === 'series' ? 'Série' : 'Film') + (r.language ? ' · ' + esc(langName(r.language)) : '') + '</span>' +
    '<span class="wp-m">Hôte : ' + esc(r.host) + ' · ' + r.participants + '/' + r.maxParticipants + ' participant' + (r.participants > 1 ? 's' : '') + '</span></div>' +
    '<a class="btn ' + (full ? 'btn-ghost' : 'btn-primary') + ' btn-sm" href="#/party/' + encodeURIComponent(r.id) + '" data-go>' + (full ? 'Complet' : 'Rejoindre') + '</a></li>';
}

function paintRooms(err) {
  const slot = detailEl.querySelector('#wp-list');
  if (!slot) return;
  if (err) { slot.innerHTML = '<p class="row-msg" role="alert">' + esc(err) + ' <button type="button" class="link-btn" data-wp-reload>Réessayer</button></p>'; return; }
  slot.innerHTML = rooms.length
    ? '<ul class="wp-list">' + rooms.map(roomCardHTML).join('') + '</ul>' + (cursor ? '<div class="wp-more"><button type="button" class="btn btn-ghost" data-wp-more>Charger plus</button></div>' : '')
    : message(loading ? 'Chargement…' : 'Aucun salon public pour le moment. Crée le tien depuis une fiche ou le lecteur.');
}

async function loadRooms(more) {
  if (loading) return;
  loading = true;
  if (!more) { rooms = []; cursor = null; paintRooms(); }
  try {
    const res = await listParties(userStore.currentProfile().id, { language: filter.language || undefined, limit: 20, cursor: more ? cursor : null });
    rooms = more ? [...rooms, ...res.rooms] : res.rooms;
    cursor = res.nextCursor;
    loading = false;
    if (state.kind === 'parties') paintRooms();
  } catch (err) {
    loading = false;
    if (state.kind === 'parties') paintRooms(socialErrorText(err));
  }
}

export function showParties() {
  teardownFiche();
  state.kind = 'parties';
  document.title = 'Watch parties · Laststream';
  if (!isServerMode() || !canBrowsePublicParties(isKidProfile())) {
    detailEl.innerHTML = shell('Watch parties', 'Regarder ensemble', message(isKidProfile() ? 'Les salons publics ne sont pas disponibles sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour rejoindre une watch party.'));
    return;
  }
  const tools = '<div class="soc-tools"><label class="sr-only" for="wp-lang">Langue</label><select class="set-input" id="wp-lang" data-wp-lang>' +
    LANGS.map(([c, l]) => '<option value="' + c + '"' + (c === filter.language ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-wp-reload>Actualiser</button><a class="btn btn-ghost btn-sm" href="#/friends" data-go>Amis</a></div>';
  detailEl.innerHTML = shell('Watch parties', 'Salons publics', '<div id="wp-list">' + message('Chargement…') + '</div>', tools);
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
export async function joinFromPage(id, btn) {
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
  if (t.closest('[data-wp-more]')) { e.preventDefault(); loadRooms(true); return; }
  if (t.closest('[data-wp-reload]')) { e.preventDefault(); loadRooms(false); }
});

detailEl.addEventListener('change', (e) => {
  const sel = e.target instanceof Element ? e.target.closest('[data-wp-lang]') : null;
  if (!sel) return;
  filter = { language: sel.value };
  loadRooms(false);
});
