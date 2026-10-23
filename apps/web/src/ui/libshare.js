/* Bibliothèque partagée : visibilité (privée / amis) de chaque titre, et de toute la bibliothèque d'un coup.
 * Privée par défaut ; seuls les titres « amis » apparaissent dans la bibliothèque d'un ami (profils enfants : aucun partage). */
import { isKidProfile, isServerMode } from '../data/auth';
import { setAllVisibility, setItemVisibility } from '../data/socialApi';
import { socialErrorText } from '../data/socialText';
import { getLibrary } from '../data/userApi';
import { userStore } from '../data/userStore';
import { runOnce, TOGGLE_COOLDOWN_MS } from './busy.js';
import { detailEl, toast } from './dom.js';
import { SET_ICON } from './settings-ui.js';
import { state } from './state.js';
import { esc } from './util.js';

/** Clé de titre (`movie:550`) -> 'private' | 'friends'. Absent : privée. */
const vis = new Map();
let loaded = false;

export const sharingAvailable = () => isServerMode() && !isKidProfile();
export const visibilityOf = (key) => vis.get(key) || 'private';
const kindOf = (key) => (key.startsWith('tv:') ? 'series' : 'movie');
const idOf = (key) => key.slice(key.indexOf(':') + 1);

/** Lit la visibilité de chaque titre de la bibliothèque du profil actif. */
export async function loadVisibility() {
  if (!sharingAvailable()) return false;
  try {
    const res = await getLibrary(userStore.currentProfile().id);
    vis.clear();
    for (const i of res.items) {
      if (i.tmdbId != null) vis.set((i.type === 'series' ? 'tv:' : 'movie:') + i.tmdbId, i.visibility === 'friends' ? 'friends' : 'private');
    }
    loaded = true;
  } catch {
    loaded = false;
  }
  return loaded;
}

/** Bouton œil en coin d'une affiche de la page Bibliothèque. */
export function visButtonHTML(key) {
  if (!sharingAvailable()) return '';
  const shared = visibilityOf(key) === 'friends';
  return '<button type="button" class="lib-vis' + (shared ? ' is-on' : '') + '" data-libvis="' + esc(key) + '" aria-pressed="' + shared + '" ' +
    'aria-label="' + (shared ? 'Visible par tes amis (rendre privé)' : 'Privé (partager avec mes amis)') + '" title="' + (shared ? 'Visible par tes amis' : 'Privé') + '">' +
    (shared ? SET_ICON.eye : SET_ICON.eyeOff) + '</button>';
}

/** Commandes de partage global, sous les filtres de la page. */
export function shareControlsHTML() {
  if (!sharingAvailable()) return '';
  return '<div class="pills" data-nav role="group" aria-label="Partage avec mes amis">' +
    '<button type="button" class="pill" data-libshare="friends">Partager avec mes amis</button>' +
    '<button type="button" class="pill" data-libshare="private">Tout garder privé</button></div>' +
    '<p class="lib-share-note" data-libshare-note>Par défaut, ta bibliothèque est privée. L’œil sur une affiche la rend visible par tes amis.</p>';
}

function paint(key) {
  detailEl.querySelectorAll('[data-libvis]').forEach((b) => {
    if (b.dataset.libvis !== key) return;
    const shared = visibilityOf(key) === 'friends';
    b.classList.toggle('is-on', shared);
    b.setAttribute('aria-pressed', String(shared));
    b.setAttribute('aria-label', shared ? 'Visible par tes amis (rendre privé)' : 'Privé (partager avec mes amis)');
    b.title = shared ? 'Visible par tes amis' : 'Privé';
    b.innerHTML = shared ? SET_ICON.eye : SET_ICON.eyeOff;
  });
}

/** Bascule la visibilité d'un titre (optimiste, retour arrière si le serveur refuse). */
export async function toggleVisibility(key) {
  const before = visibilityOf(key);
  const next = before === 'friends' ? 'private' : 'friends';
  vis.set(key, next);
  paint(key);
  try {
    await setItemVisibility(userStore.currentProfile().id, kindOf(key), idOf(key), next);
    toast(next === 'friends' ? 'Visible par tes amis' : 'Titre privé');
    return true;
  } catch (err) {
    vis.set(key, before);
    paint(key);
    toast(socialErrorText(err));
    return false;
  }
}

/** Change la visibilité de toute la bibliothèque (ou des films / séries seulement, selon le filtre de la page). */
export async function setAll(visibility) {
  const type = state.libView.type === 'movie' ? 'movie' : state.libView.type === 'tv' ? 'series' : undefined;
  const scope = type === 'movie' ? 'des films' : type === 'series' ? 'des séries' : 'de toute la bibliothèque';
  if (visibility === 'friends' && !window.confirm('Rendre visibles par tes amis les titres ' + scope + ' ?')) return false;
  try {
    const res = await setAllVisibility(userStore.currentProfile().id, visibility, type);
    userStore.getLibrary().forEach((e) => {
      const key = e.type + ':' + e.id;
      if (!type || kindOf(key) === type) { vis.set(key, visibility); paint(key); }
    });
    const note = detailEl.querySelector('[data-libshare-note]');
    const text = res.updated + ' titre' + (res.updated > 1 ? 's' : '') + (visibility === 'friends' ? ' visibles par tes amis.' : ' remis en privé.');
    if (note) note.textContent = text;
    toast(text);
    return true;
  } catch (err) {
    toast(socialErrorText(err));
    return false;
  }
}

detailEl.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || state.kind !== 'library') return;
  const one = t.closest('[data-libvis]');
  if (one) { e.preventDefault(); e.stopPropagation(); runOnce('libvis:' + one.dataset.libvis, () => toggleVisibility(one.dataset.libvis), { el: one, cooldown: TOGGLE_COOLDOWN_MS }); return; }
  const all = t.closest('[data-libshare]');
  if (all) { e.preventDefault(); runOnce('libshare-all', () => setAll(all.dataset.libshare), { el: all, cooldown: TOGGLE_COOLDOWN_MS }); }
}, true);

