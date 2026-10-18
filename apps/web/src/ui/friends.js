/* Amis (#/friends) : liste avec présence, demandes reçues et envoyées, ajout par pseudo exact, retrait ; et la bibliothèque
 * partagée d'un ami (#/friend/<pseudo>) avec « Ajouter à ma bibliothèque » et lecture directe. */
import { isKidProfile, isServerMode } from '../data/auth';
import { isInvisible, setInvisible } from '../data/presence';
import {
  acceptFriend, dropFriendRequest, getFriendLibrary, getFriends, removeFriend, requestFriend,
} from '../data/socialApi';
import { cleanUsername, presenceLabel, socialErrorText, sortFriends } from '../data/socialText';
import { posterPathOf } from '../data/serverUserStore';
import { userStore } from '../data/userStore';
import { register, toItem } from './catalog.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { infiniteList } from './infinite.js';
import { playDirect } from './sources-ui.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

const POLL_MS = 30_000;
let data = null;
let loadError = false;
let poll = null;
let pollToken = 0;

const avatar = (name, color) => '<span class="soc-av" style="background:' + esc(color || '#94a3b8') + '" aria-hidden="true">' + esc((name || '?').slice(0, 1).toUpperCase()) + '</span>';

function unavailable(title) {
  return topBar(false) + '<article class="svc-page soc-page"><header class="svc-head svc-head-plain"><div class="svc-head-t"><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="soc-body"><p class="row-msg">' + (isKidProfile() ? 'Cette page n’est pas disponible sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour utiliser les fonctions sociales.') + '</p></div></article>';
}

// ---------- Page « Amis » ----------
export function friendRowHTML(f) {
  const live = f.status === 'watching';
  return '<li class="soc-row" data-friend="' + esc(f.username) + '">' + avatar(f.username, f.avatarColor) +
    '<div class="soc-main"><a class="soc-name" href="#/friend/' + encodeURIComponent(f.username) + '" data-go>' + esc(f.username) + '</a>' +
    '<span class="soc-presence is-' + f.status + '">' + (f.status === 'offline' ? '' : '<i aria-hidden="true"></i>') + esc(presenceLabel(f)) + '</span></div>' +
    '<div class="soc-acts"><a class="btn btn-ghost btn-sm" href="#/friend/' + encodeURIComponent(f.username) + '" data-go>Bibliothèque</a>' +
    (live && f.watching && f.watching.tmdbId ? '<a class="btn btn-ghost btn-sm" href="#/' + (f.watching.type === 'series' ? 'tv' : 'movie') + '/' + f.watching.tmdbId + '" data-go>Voir la fiche</a>' : '') +
    '<button type="button" class="btn btn-ghost btn-sm" data-fr-remove="' + esc(f.username) + '">Retirer</button></div></li>';
}

function requestRowHTML(r, incoming) {
  return '<li class="soc-row" data-friend="' + esc(r.username) + '">' + avatar(r.username, r.avatarColor) +
    '<div class="soc-main"><span class="soc-name">' + esc(r.username) + '</span><span class="soc-presence">' + (incoming ? 'veut devenir ton ami' : 'demande envoyée') + '</span></div>' +
    '<div class="soc-acts">' + (incoming
      ? '<button type="button" class="btn btn-primary btn-sm" data-fr-accept="' + esc(r.username) + '">Accepter</button><button type="button" class="btn btn-ghost btn-sm" data-fr-decline="' + esc(r.username) + '">Refuser</button>'
      : '<button type="button" class="btn btn-ghost btn-sm" data-fr-decline="' + esc(r.username) + '">Annuler</button>') + '</div></li>';
}

export function friendsBodyHTML(d) {
  if (loadError && !d) return '<p class="row-msg" role="alert">Impossible de charger tes amis. <button type="button" class="link-btn" data-fr-reload>Réessayer</button></p>';
  if (!d) return '<p class="row-msg" role="status">Chargement…</p>';
  const friends = sortFriends(d.friends);
  return (d.incoming.length ? '<section class="soc-sec"><h2 class="row-title">Demandes reçues <em>' + d.incoming.length + '</em></h2><ul class="soc-list">' + d.incoming.map((r) => requestRowHTML(r, true)).join('') + '</ul></section>' : '') +
    '<section class="soc-sec"><h2 class="row-title">Mes amis <em>' + friends.length + '</em></h2>' +
    (friends.length ? '<ul class="soc-list">' + friends.map(friendRowHTML).join('') + '</ul>'
      : '<p class="row-msg">Pas encore d’ami. Ajoute quelqu’un par son pseudo exact, ou invite-le depuis Réglages > Mes invitations.</p>') + '</section>' +
    (d.outgoing.length ? '<section class="soc-sec"><h2 class="row-title">Demandes envoyées <em>' + d.outgoing.length + '</em></h2><ul class="soc-list">' + d.outgoing.map((r) => requestRowHTML(r, false)).join('') + '</ul></section>' : '');
}

function paintFriends() {
  const slot = detailEl.querySelector('#soc-friends');
  if (slot) slot.innerHTML = friendsBodyHTML(data);
}

async function loadFriends() {
  try {
    data = await getFriends();
    loadError = false;
  } catch {
    loadError = true;
  }
  if (state.kind === 'friends') paintFriends();
}

function startPoll() {
  const token = ++pollToken;
  clearInterval(poll);
  poll = setInterval(() => {
    if (token !== pollToken || state.kind !== 'friends') { clearInterval(poll); return; }
    if (!document.hidden) loadFriends();
  }, POLL_MS);
}

export function showFriends() {
  teardownFiche();
  state.kind = 'friends';
  document.title = 'Amis · Laststream';
  if (!isServerMode() || isKidProfile()) { detailEl.innerHTML = unavailable('Amis'); return; }
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page soc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">Ce que regardent tes amis</p><h1 class="svc-title" id="svc-title" tabindex="-1">Amis</h1>' +
    '<div class="soc-tools"><a class="btn btn-ghost btn-sm" href="#/parties" data-go>Watch parties</a>' +
    '<label class="set-check"><input type="checkbox" data-fr-invisible' + (isInvisible() ? ' checked' : '') + '> <span>Apparaître hors ligne</span></label></div></div></header>' +
    '<div class="soc-body"><form class="soc-add" data-fr-add autocomplete="off"><label class="tv-field">Ajouter un ami par son pseudo exact' +
    '<span class="soc-add-f"><input type="text" name="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="pseudo" required><button type="submit" class="btn btn-primary">Envoyer la demande</button></span></label>' +
    '<p class="tv-form-msg" data-fr-msg role="status"></p></form>' +
    '<div id="soc-friends">' + friendsBodyHTML(data) + '</div></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  loadFriends();
  startPoll();
}

async function act(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (err) {
    toast(socialErrorText(err));
  }
  await loadFriends();
}

// ---------- Bibliothèque d'un ami ----------
const FPAGE = 50;
let fview = { name: '', type: 'all' };

const itemOf = (x) => {
  const type = x.type === 'series' ? 'tv' : 'movie';
  const raw = { id: x.tmdbId, poster_path: posterPathOf(x.poster) };
  raw[type === 'tv' ? 'name' : 'title'] = x.title;
  return register(toItem(raw, type));
};

function friendTile(x) {
  const it = itemOf(x);
  const have = userStore.inLibrary(it.key);
  return '<div class="soc-tile" data-fr-key="' + esc(it.key) + '">' + posterCard(it) +
    '<div class="soc-tile-acts"><button type="button" class="btn btn-ghost btn-sm" data-fr-play="' + esc(it.key) + '">Lire</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-fr-save="' + esc(it.key) + '"' + (have ? ' disabled' : '') + '>' + (have ? 'Dans ma bibliothèque' : 'Ajouter à ma bibliothèque') + '</button></div></div>';
}

function renderFriendLibrary() {
  const box = detailEl.querySelector('#fr-grid');
  if (!box) return Promise.resolve();
  detailEl.querySelectorAll('[data-frf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.frf === fview.type)));
  box.innerHTML = '';
  const type = fview.type === 'all' ? undefined : fview.type === 'tv' ? 'series' : 'movie';
  const list = infiniteList({
    host: box,
    key: location.hash + '|' + fview.type,
    load: async (page) => {
      const res = await getFriendLibrary(fview.name, { type, limit: FPAGE, offset: (page - 1) * FPAGE });
      const items = res.items.filter((x) => x.tmdbId != null);
      if (page === 1 && !items.length) return { html: '<p class="row-msg">' + esc(fview.name) + ' n’a rien partagé' + (type ? ' dans ce filtre' : ' pour l’instant') + '.</p>', done: true };
      return { html: items.map(friendTile).join(''), done: res.offset + res.items.length >= res.total || !res.items.length };
    },
    after: (host) => observeTiles(host),
  });
  return list.ready;
}

export function showFriendLibrary(username) {
  teardownFiche();
  state.kind = 'friend';
  document.title = username + ' · Laststream';
  if (!isServerMode() || isKidProfile()) { detailEl.innerHTML = unavailable(username); return; }
  fview = { name: username, type: 'all' };
  const known = data && data.friends.find((f) => f.username === username);
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page soc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">Bibliothèque partagée</p><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(username) + '</h1>' +
    (known ? '<p class="soc-presence is-' + known.status + '">' + esc(presenceLabel(known)) + '</p>' : '') +
    '<div class="lib-controls"><div class="pills" data-nav role="group" aria-label="Filtrer">' +
    '<button type="button" class="pill" data-frf="all">Tout</button><button type="button" class="pill" data-frf="movie">Films</button><button type="button" class="pill" data-frf="tv">Séries</button></div></div></div></header>' +
    '<div class="lib-grid soc-grid" id="fr-grid" data-nav></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  renderFriendLibrary();
}

/** Cible de lecture directe : un film, ou l'épisode en cours / le premier d'une série. */
function requestOf(key) {
  const it = state.byKey.get(key);
  if (!it) return null;
  let season = null;
  let episode = null;
  if (it.type === 'tv') {
    const cont = userStore.continueWatching(50).find((e) => e.type === 'tv' && e.id === it.id && e.season != null);
    season = cont ? cont.season : 1;
    episode = cont ? cont.episode : 1;
  }
  return { type: it.type, id: String(it.id), name: it.name, season, episode, key };
}

// ---------- Événements ----------
detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (state.kind === 'friend') {
    const f = t.closest('[data-frf]');
    if (f) { e.preventDefault(); fview.type = f.dataset.frf; renderFriendLibrary(); return; }
    const save = t.closest('[data-fr-save]');
    if (save) {
      e.preventDefault();
      const it = state.byKey.get(save.dataset.frSave);
      if (!it) return;
      userStore.addToLibrary({ id: it.id, type: it.type, title: it.name, poster: it.posterPath || '', year: it.year || '' });
      save.disabled = true;
      save.textContent = 'Dans ma bibliothèque';
      toast('Ajouté à ta bibliothèque');
      return;
    }
    const play = t.closest('[data-fr-play]');
    if (play) {
      e.preventDefault();
      const req = requestOf(play.dataset.frPlay);
      if (req) playDirect(req, play);
      return;
    }
    return;
  }
  if (state.kind !== 'friends') return;
  const rem = t.closest('[data-fr-remove]');
  if (rem) {
    e.preventDefault();
    const u = rem.dataset.frRemove;
    if (window.confirm('Retirer ' + u + ' de tes amis ?')) act(() => removeFriend(u), u + ' a été retiré');
    return;
  }
  const acc = t.closest('[data-fr-accept]');
  if (acc) { e.preventDefault(); act(() => acceptFriend(acc.dataset.frAccept), 'Ami ajouté'); return; }
  const dec = t.closest('[data-fr-decline]');
  if (dec) { e.preventDefault(); act(() => dropFriendRequest(dec.dataset.frDecline)); return; }
  if (t.closest('[data-fr-reload]')) { e.preventDefault(); loadFriends(); }
});

detailEl.addEventListener('submit', async (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-fr-add]') : null;
  if (!f) return;
  e.preventDefault();
  const msg = f.querySelector('[data-fr-msg]');
  const name = cleanUsername(f.elements.username.value);
  if (!name) { msg.textContent = 'Pseudo invalide : 3 à 32 caractères (a-z, 0-9, _ . -).'; return; }
  msg.textContent = '';
  try {
    const res = await requestFriend(name);
    f.elements.username.value = '';
    msg.textContent = res.status === 'accepted' ? name + ' est maintenant ton ami.' : 'Demande envoyée à ' + name + '.';
    await loadFriends();
  } catch (err) {
    msg.textContent = socialErrorText(err);
  }
});

detailEl.addEventListener('change', (e) => {
  const t = e.target instanceof Element ? e.target.closest('[data-fr-invisible]') : null;
  if (t) setInvisible(t.checked);
});

