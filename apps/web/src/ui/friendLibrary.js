/* Bibliothèque d'un ami (#/friend/<pid>, ODY-222) : tous ses titres partagés en grille, avec recherche, filtres Films / Séries,
 * tri, vues « en commun » et « pas encore vus par moi », badges, « Ajouter à ma bibliothèque » et « Envoyer ». Ouverte depuis le
 * menu ⋯ de la fiche de l'ami et son onglet Bibliothèque. Le serveur ne renvoie que les titres que l'ami rend visibles
 * (réglage « Ma bibliothèque ») ; recherche, tri et filtres se font ici sur la liste chargée. */
import { isKidProfile, isServerMode } from '../data/auth';
import { applyView, countsOf, DEFAULT_VIEW, usable } from '../data/friendLibraryView';
import * as store from '../data/socialStore';
import { getFriendLibrary } from '../data/socialV2Api';
import { posterPathOf } from '../data/serverUserStore';
import { userStore } from '../data/userStore';
import { register, toItem } from './catalog.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { stopInfinite } from './infinite.js';
import { directPlayRequest } from './playRequest.js';
import { openShareDialog } from './socialHooks.js';
import { playDirect } from './sources-ui.js';
import { state } from './state.js';
import { observeTiles, posterCard } from './tiles.js';
import { esc } from './util.js';

const PAGE = 100; // maximum accepté par le serveur
const MAX_ITEMS = 1000;
const CHUNK = 60;

let fl = { pid: '', name: '', lib: { status: 'loading', items: [] }, view: { ...DEFAULT_VIEW }, shown: CHUNK, seq: 0 };

const ctx = () => ({ have: (k) => userStore.inLibrary(k), seen: (k) => userStore.watchedTitle(k) !== null });

const itemOf = (x) => {
  const type = x.type === 'series' ? 'tv' : 'movie';
  const raw = { id: x.tmdbId, poster_path: posterPathOf(x.poster) };
  raw[type === 'tv' ? 'name' : 'title'] = x.title;
  return register(toItem(raw, type));
};

/** Nom affiché d'un ami, d'après le store social (le pid seul n'est pas lisible). */
function nameOfPid(pid) {
  const s = store.getState();
  const f = s.friends.find((x) => x.pid === pid) || s.household.find((x) => x.pid === pid);
  return f ? f.nickname || f.handle.name : 'Un ami';
}

function unavailable(title) {
  return topBar(false) + '<article class="svc-page soc-page"><header class="svc-head svc-head-plain"><div class="svc-head-t"><h1 class="svc-title" id="svc-title" tabindex="-1">' + esc(title) + '</h1></div></header>' +
    '<div class="soc-body"><p class="row-msg">' + (isKidProfile() ? 'Cette page n’est pas disponible sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour utiliser les fonctions sociales.') + '</p></div></article>';
}

function tileHTML(x) {
  const it = itemOf(x);
  const k = esc(it.key);
  const c = ctx();
  const have = c.have(it.key);
  const seen = c.seen(it.key);
  const badge = have ? '<span class="fl-badge is-common">En commun</span>' : seen ? '<span class="fl-badge">Déjà vu</span>' : '';
  return '<div class="soc-tile fl-tile" data-fr-key="' + k + '"><div class="fl-media">' + posterCard(it) + badge + '</div>' +
    '<div class="soc-tile-acts"><button type="button" class="btn btn-ghost btn-sm" data-fr-play="' + k + '">Lire</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-fr-save="' + k + '"' + (have ? ' disabled' : '') + '>' + (have ? 'Dans ma bibliothèque' : 'Ajouter à ma bibliothèque') + '</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-fr-send="' + k + '">Envoyer</button></div></div>';
}

function pill(attr, value, label, count, on) {
  return '<button type="button" class="pill" ' + attr + '="' + value + '" aria-pressed="' + on + '">' + esc(label) + (count != null ? ' · ' + count : '') + '</button>';
}

function headHTML() {
  const n = usable(fl.lib.items).length;
  const common = fl.lib.status === 'ok' ? countsOf(fl.lib.items, ctx()).common : 0;
  const sub = fl.lib.status === 'ok' && n ? n + ' titre' + (n > 1 ? 's' : '') + (common ? ' · ' + common + ' déjà dans ta bibliothèque' : '') : '';
  return '<p class="svc-eyebrow">Bibliothèque partagée</p><h1 class="svc-title" id="svc-title" tabindex="-1">Bibliothèque de ' + esc(fl.name) + '</h1>' +
    (sub ? '<p class="fl-sub" id="fl-sub">' + esc(sub) + '</p>' : '<p class="fl-sub" id="fl-sub" hidden></p>');
}

function controlsHTML() {
  const c = countsOf(fl.lib.items, ctx());
  const v = fl.view;
  return '<div class="fl-bar"><label class="fl-search"><span class="sr-only">Rechercher dans sa bibliothèque</span>' +
    '<input type="search" id="fl-q" placeholder="Rechercher dans sa bibliothèque" autocomplete="off" value="' + esc(v.q) + '"></label>' +
    '<div class="pills" role="group" aria-label="Filtrer par type">' + pill('data-fl-type', 'all', 'Tout', c.all, v.type === 'all') +
    pill('data-fl-type', 'movie', 'Films', c.movie, v.type === 'movie') + pill('data-fl-type', 'tv', 'Séries', c.tv, v.type === 'tv') + '</div>' +
    '<label class="fl-sort">Trier <select id="fl-sort"><option value="recent"' + (v.sort === 'recent' ? ' selected' : '') + '>Ajoutés récemment</option>' +
    '<option value="az"' + (v.sort === 'az' ? ' selected' : '') + '>Titre A → Z</option><option value="za"' + (v.sort === 'za' ? ' selected' : '') + '>Titre Z → A</option></select></label></div>' +
    '<div class="pills fl-modes" role="group" aria-label="Vues rapides">' + pill('data-fl-mode', 'common', 'En commun avec moi', c.common, v.mode === 'common') +
    pill('data-fl-mode', 'unseen', 'Pas encore vus par moi', c.unseen, v.mode === 'unseen') + '</div>';
}

function gridHTML() {
  const rows = applyView(fl.lib.items, fl.view, ctx());
  if (!rows.length) {
    const filtered = fl.view.q.trim() || fl.view.type !== 'all' || fl.view.mode !== 'all';
    return '<div class="fl-empty row-msg" role="status"><p>' + (filtered ? 'Aucun résultat. Essaie un autre titre ou retire un filtre.' : 'Rien à voir ici pour l’instant.') + '</p>' +
      (filtered ? '<button type="button" class="btn btn-ghost" data-fl-reset>Réinitialiser</button>' : '') + '</div>';
  }
  const shown = rows.slice(0, fl.shown).map(tileHTML).join('');
  const more = rows.length > fl.shown ? '<div class="fl-more"><button type="button" class="btn btn-ghost" data-fl-more>Afficher plus (' + (rows.length - fl.shown) + ')</button></div>' : '';
  return shown + more;
}

function paintGrid() {
  const grid = detailEl.querySelector('#fl-grid');
  if (!grid) return;
  grid.innerHTML = gridHTML();
  observeTiles(grid);
}

function paintBody() {
  const body = detailEl.querySelector('#fl-body');
  const head = detailEl.querySelector('#fl-head');
  if (!body || !head) return;
  head.innerHTML = headHTML();
  const l = fl.lib;
  if (l.status === 'loading') { body.innerHTML = '<p class="row-msg" role="status">Chargement…</p>'; return; }
  if (l.status === 'error') {
    body.innerHTML = '<p class="row-msg" role="alert">Bibliothèque indisponible. <button type="button" class="btn btn-ghost" data-fl-retry>Réessayer</button></p>';
    return;
  }
  if (l.status === 'gone') { body.innerHTML = '<p class="row-msg">Cette bibliothèque n’est pas partagée avec toi.</p>'; return; }
  if (!usable(l.items).length) { body.innerHTML = '<p class="row-msg">' + esc(fl.name) + ' n’a rien partagé avec toi pour l’instant.</p>'; return; }
  body.innerHTML = controlsHTML() + '<div class="lib-grid soc-grid" id="fl-grid" data-nav></div>';
  paintGrid();
}

/** Charge toutes les pages (100 titres par appel, 1000 au plus) : la recherche et le tri travaillent sur la liste entière. */
async function load(pid) {
  const seq = ++fl.seq;
  const items = [];
  try {
    for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
      const res = await getFriendLibrary(pid, { limit: PAGE, offset });
      const got = (res && res.items) || [];
      items.push(...got);
      if (!got.length || offset + got.length >= (res.total ?? 0)) break;
    }
  } catch (err) {
    if (seq !== fl.seq) return;
    fl.lib = { status: err && err.status === 404 ? 'gone' : 'error', items: [] };
    paintBody();
    return;
  }
  if (seq !== fl.seq) return;
  fl.lib = { status: 'ok', items };
  paintBody();
}

export function showFriendLibrary(pid) {
  teardownFiche();
  stopInfinite();
  state.kind = 'friend';
  const name = nameOfPid(pid);
  document.title = 'Bibliothèque de ' + name + ' · Laststream';
  if (!isServerMode() || isKidProfile()) { detailEl.innerHTML = unavailable(name); return; }
  fl = { pid, name, lib: { status: 'loading', items: [] }, view: { ...DEFAULT_VIEW }, shown: CHUNK, seq: fl.seq };
  detailEl.innerHTML = topBar(false) +
    '<article class="svc-page soc-page fl-page" aria-labelledby="svc-title"><header class="svc-head svc-head-plain"><div class="svc-head-t" id="fl-head"></div>' +
    '<button type="button" class="btn btn-ghost fl-send" data-fl-send-friend>Envoyer un titre à ' + esc(name) + '</button></header>' +
    '<div class="soc-body fl-body" id="fl-body"></div></article>';
  paintBody();
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
  load(pid);
}

function setView(patch) {
  fl.view = { ...fl.view, ...patch };
  fl.shown = CHUNK;
  paintGrid();
  detailEl.querySelectorAll('[data-fl-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.flType === fl.view.type)));
  detailEl.querySelectorAll('[data-fl-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.flMode === fl.view.mode)));
}

// ---------- Événements ----------
detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || state.kind !== 'friend') return;
  const type = t.closest('[data-fl-type]');
  if (type) { e.preventDefault(); setView({ type: type.dataset.flType }); return; }
  const mode = t.closest('[data-fl-mode]');
  if (mode) { e.preventDefault(); setView({ mode: fl.view.mode === mode.dataset.flMode ? 'all' : mode.dataset.flMode }); return; }
  if (t.closest('[data-fl-reset]')) {
    e.preventDefault();
    const q = detailEl.querySelector('#fl-q');
    if (q) q.value = '';
    setView({ q: '', type: 'all', mode: 'all' });
    return;
  }
  if (t.closest('[data-fl-more]')) {
    e.preventDefault();
    const first = fl.shown;
    fl.shown += CHUNK;
    paintGrid();
    const next = detailEl.querySelectorAll('#fl-grid .fl-tile')[first];
    const target = next && next.querySelector('a, button');
    if (target) target.focus({ preventScroll: true });
    return;
  }
  if (t.closest('[data-fl-retry]')) {
    e.preventDefault();
    fl.lib = { status: 'loading', items: [] };
    paintBody();
    const h1 = detailEl.querySelector('#svc-title');
    if (h1) h1.focus({ preventScroll: true });
    load(fl.pid);
    return;
  }
  if (t.closest('[data-fl-send-friend]')) { e.preventDefault(); openShareDialog({ media: null, to: [fl.pid] }); return; }
  const send = t.closest('[data-fr-send]');
  if (send) {
    e.preventDefault();
    const it = state.byKey.get(send.dataset.frSend);
    if (it) openShareDialog({ media: { type: it.type === 'tv' ? 'series' : 'movie', tmdbId: Number(it.id), title: it.name, poster: it.posterPath || undefined }, to: [fl.pid] });
    return;
  }
  const play = t.closest('[data-fr-play]');
  if (play) {
    e.preventDefault();
    const req = directPlayRequest(play.dataset.frPlay);
    if (req) playDirect(req, play);
    return;
  }
  const save = t.closest('[data-fr-save]');
  if (save) {
    e.preventDefault();
    const it = state.byKey.get(save.dataset.frSave);
    if (!it) return;
    userStore.addToLibrary({ id: it.id, type: it.type, title: it.name, poster: it.posterPath || '', year: it.year || '' });
    save.disabled = true;
    save.textContent = 'Dans ma bibliothèque';
    toast('Ajouté à ta bibliothèque');
    const tile = save.closest('.fl-tile');
    const media = tile && tile.querySelector('.fl-media');
    if (media) {
      media.querySelectorAll('.fl-badge').forEach((b) => b.remove());
      media.insertAdjacentHTML('beforeend', '<span class="fl-badge is-common">En commun</span>');
    }
    const commonPill = detailEl.querySelector('[data-fl-mode="common"]');
    if (commonPill) commonPill.textContent = 'En commun avec moi · ' + countsOf(fl.lib.items, ctx()).common;
    const sub = detailEl.querySelector('#fl-sub');
    if (sub && fl.lib.status === 'ok') {
      const n = usable(fl.lib.items).length;
      const common = countsOf(fl.lib.items, ctx()).common;
      sub.textContent = n + ' titre' + (n > 1 ? 's' : '') + (common ? ' · ' + common + ' déjà dans ta bibliothèque' : '');
      sub.hidden = false;
    }
  }
});

detailEl.addEventListener('input', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || state.kind !== 'friend' || t.id !== 'fl-q') return;
  setView({ q: t.value });
});

detailEl.addEventListener('change', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || state.kind !== 'friend' || t.id !== 'fl-sort') return;
  setView({ sort: t.value });
});
