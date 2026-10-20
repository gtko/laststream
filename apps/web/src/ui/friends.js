/* Bibliothèque partagée d'un ami (#/friend/<pid>) : ses titres partagés, avec « Ajouter à ma bibliothèque » et lecture directe.
 * La liste des amis, les demandes et la présence ne sont plus ici : elles vivent dans la barre latérale (socialSidebar.js,
 * ouverte par #/friends et par le bouton Amis de la barre du haut). */
import { isKidProfile, isServerMode } from '../data/auth';
import * as store from '../data/socialStore';
import { getFriendLibrary } from '../data/socialV2Api';
import { posterPathOf } from '../data/serverUserStore';
import { userStore } from '../data/userStore';
import { register, toItem } from './catalog.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { infiniteList } from './infinite.js';
import { directPlayRequest } from './playRequest.js';
import { playDirect } from './sources-ui.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

function unavailable(title) {
  return topBar(false) + '<article class="svc-page soc-page"><header class="svc-head svc-head-plain"><div class="svc-head-t"><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="soc-body"><p class="row-msg">' + (isKidProfile() ? 'Cette page n’est pas disponible sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour utiliser les fonctions sociales.') + '</p></div></article>';
}

// ---------- Bibliothèque d'un ami ----------
const FPAGE = 50;
let fview = { pid: '', name: '', type: 'all' };

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
      const res = await getFriendLibrary(fview.pid, { type, limit: FPAGE, offset: (page - 1) * FPAGE });
      const items = res.items.filter((x) => x.tmdbId != null);
      if (page === 1 && !items.length) return { html: '<p class="row-msg">' + esc(fview.name) + ' n’a rien partagé' + (type ? ' dans ce filtre' : ' pour l’instant') + '.</p>', done: true };
      return { html: items.map(friendTile).join(''), done: res.offset + res.items.length >= res.total || !res.items.length };
    },
    after: (host) => observeTiles(host),
  });
  return list.ready;
}

/** Nom affiché d'un ami, d'après la barre latérale (le pid seul n'est pas lisible). */
function nameOfPid(pid) {
  const s = store.getState();
  const f = s.friends.find((x) => x.pid === pid) || s.household.find((x) => x.pid === pid);
  return f ? f.nickname || f.handle.name : 'Un ami';
}

export function showFriendLibrary(pid) {
  teardownFiche();
  state.kind = 'friend';
  const username = nameOfPid(pid);
  document.title = username + ' · Laststream';
  if (!isServerMode() || isKidProfile()) { detailEl.innerHTML = unavailable(username); return; }
  fview = { pid, name: username, type: 'all' };
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page soc-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t">' +
    '<p class="svc-eyebrow">Bibliothèque partagée</p><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(username) + '</h1>' +
    '<div class="lib-controls"><div class="pills" data-nav role="group" aria-label="Filtrer">' +
    '<button type="button" class="pill" data-frf="all">Tout</button><button type="button" class="pill" data-frf="movie">Films</button><button type="button" class="pill" data-frf="tv">Séries</button></div></div></div></header>' +
    '<div class="lib-grid soc-grid" id="fr-grid" data-nav></div></article>';
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  renderFriendLibrary();
}

// ---------- Événements ----------
detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || state.kind !== 'friend') return;
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
    const req = directPlayRequest(play.dataset.frPlay);
    if (req) playDirect(req, play);
  }
});
