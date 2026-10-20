/* Bannière des annonces publiques dans l'application (jamais sur #/admin). Au démarrage, GET /announcements est appelé sans bloquer
 * le rendu ; une erreur réseau n'affiche rien. La première annonce non fermée s'affiche en haut ; sa fermeture est mémorisée
 * (localStorage, 50 identifiants au plus). Le texte est toujours inséré tel quel (textContent), jamais interprété comme HTML. */
import { fetchPublicAnnouncements } from '../data/announcements';
import '../styles/announcement-banner.css';

export const DISMISSED_KEY = 'ls.announcements.dismissed';
const MAX_DISMISSED = 50;
const ADMIN_ROUTE = /^#\/admin(?:[/?]|$)/;

/** Identifiants d'annonces déjà fermées, les plus récents en fin de liste ; liste vide si le stockage est indisponible. */
export function readDismissed(storage = globalThis.localStorage) {
  try {
    const raw = storage ? storage.getItem(DISMISSED_KEY) : null;
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(-MAX_DISMISSED) : [];
  } catch (_) {
    return [];
  }
}

/** Mémorise la fermeture d'une annonce (les 50 plus récentes gardées). Un stockage indisponible ne bloque rien. */
export function rememberDismissed(id, storage = globalThis.localStorage) {
  try {
    const next = [...readDismissed(storage).filter((x) => x !== id), id].slice(-MAX_DISMISSED);
    storage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch (_) {
    /* stockage indisponible : la fermeture vaut pour cette visite seulement */
  }
}

/** Première annonce valide qui n'est pas encore fermée, dans l'ordre reçu du serveur. */
export function pickAnnouncement(list, dismissed) {
  const closed = new Set(dismissed);
  const items = Array.isArray(list) ? list : [];
  return items.find((a) => a && typeof a.id === 'string' && !closed.has(a.id)) || null;
}

/** Vrai sur la console d'administration (#/admin, #/admin/…) : la bannière n'y apparaît pas. */
export const isAdminRoute = (hash = location.hash) => ADMIN_ROUTE.test(hash);

/** Hauteur de la bannière, écrite dans --ann-h sur :root : la barre du haut et la navigation s'en décalent (0 sans bannière). */
const setBannerHeight = (doc, px) => { doc.documentElement.style.setProperty('--ann-h', px + 'px'); };

function bannerEl(a, onClose) {
  const warning = a.level === 'warning';
  const root = document.createElement('section');
  root.className = 'ann-banner is-' + (warning ? 'warning' : 'info');
  root.setAttribute('aria-label', 'Annonce');
  root.dataset.annId = a.id;
  const body = document.createElement('div');
  body.className = 'ann-body';
  const kind = document.createElement('p');
  kind.className = 'ann-kind';
  kind.textContent = warning ? 'Attention' : 'Information';
  const title = document.createElement('p');
  title.className = 'ann-title';
  title.textContent = typeof a.title === 'string' ? a.title : '';
  const message = document.createElement('p');
  message.className = 'ann-msg';
  message.textContent = typeof a.message === 'string' ? a.message : '';
  body.append(kind, title, message);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ann-close';
  close.setAttribute('aria-label', 'Fermer l’annonce');
  close.textContent = '×';
  close.addEventListener('click', onClose);
  root.append(body, close);
  return root;
}

/**
 * Charge les annonces publiques et affiche la première non fermée. `deps` permet de substituer le chargement, le stockage
 * et le document en test. À appeler sans attendre le résultat : la promesse ne rejette jamais.
 */
export async function initAnnouncementBanner(deps = {}) {
  const load = deps.load || fetchPublicAnnouncements;
  const storage = deps.storage === undefined ? globalThis.localStorage : deps.storage;
  const doc = deps.document || document;
  let list;
  try {
    list = await load();
  } catch (_) {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;

  let el = null;
  // La hauteur suit la bannière (texte qui se replie, rotation) ; elle revient à 0 quand la bannière disparaît.
  const ro = typeof globalThis.ResizeObserver === 'function'
    ? new globalThis.ResizeObserver(() => { if (el) setBannerHeight(doc, el.offsetHeight); })
    : null;
  const remove = () => {
    if (el) { if (ro) ro.unobserve(el); el.remove(); el = null; }
    setBannerHeight(doc, 0);
  };
  const place = () => {
    remove();
    if (isAdminRoute()) return;
    const next = pickAnnouncement(list, readDismissed(storage));
    if (!next) return;
    el = bannerEl(next, () => { rememberDismissed(next.id, storage); place(); });
    doc.body.prepend(el);
    setBannerHeight(doc, el.offsetHeight);
    if (ro) ro.observe(el);
  };
  const onHash = () => {
    if (isAdminRoute()) remove();
    else if (!el) place();
  };
  // Une seule bannière et un seul écouteur : un nouvel appel remplace le précédent.
  if (teardown) teardown();
  globalThis.addEventListener('hashchange', onHash);
  teardown = () => { globalThis.removeEventListener('hashchange', onHash); remove(); };
  place();
  return el;
}

let teardown = null;
