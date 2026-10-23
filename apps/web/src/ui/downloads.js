/* Écran #/downloads (ODY-204) : jauge d'espace, téléchargements en cours et terminés, bandeaux hors ligne, erreur et web.
 * Un seul abonnement par visite (libéré par teardownDownloads, appelé par le routeur) ; la liste n'est redessinée que si
 * l'ensemble des identifiants ou des états change, sinon l'avancement est mis à jour en place (largeur, aria-valuenow). */
import { getDownloads, getSpace, persistStorage, platformAvailability, subscribeDownloads } from '../downloads/service';
import { errorMessage, gauge, itemPercent, itemSubtitle } from '../downloads/viewModel';
import { isAndroidApp } from '../data/config';
import { isShellEnvironment } from '../player/shell';
import { closeSheet, confirmRemove, DL_ICON, itemLabel, itemName, openDoneSheet, openErrorSheet, openSpaceFullSheet, openSheet, pauseItem, paintDlBadges,
  playOffline, resumeItem, retryItem, RING, teardownDownloadControls, visibleItems } from './downloadBtn.js';
import { isTvDevice } from './device.js';
import { detailEl, toast } from './dom.js';
import { focusStorageSettings } from './settings-downloads.js';
import { teardownFiche } from './fiche.js';
import { topBar } from './fragments.js';
import { state } from './state.js';
import { esc } from './util.js';

const SPACE_EVERY_MS = 2000;

/** Valeur échappée pour un sélecteur d'attribut entre guillemets (jsdom n'a pas `CSS.escape`). */
const attr = (s) => String(s).replace(/["\\]/g, '\\$&');

/** État de la visite en cours ; remis à zéro par teardownDownloads. */
const v = { unsub: null, items: [], sig: '', loaded: false, spaceAt: 0, spaceTimer: 0, space: null, token: 0, persisted: null };

const online = () => (typeof navigator === 'undefined' || navigator.onLine !== false);
/** Vue TV (ODY-234) : mêmes données, rangées navigables à la télécommande (groupes data-nav) et indication des touches. */
const tvNav = () => (isTvDevice() ? ' data-nav' : '');
const isWeb = () => !isAndroidApp() && !isShellEnvironment();
const isSafariLike = () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua));
};

// ---------- Rendu ----------
function posterHTML(item) {
  const it = state.byKey && state.byKey.get(item.metaId);
  const name = itemName(item);
  return '<span class="dl-poster" aria-hidden="true">' + (it && it.poster ? '<img src="' + esc(it.poster) + '" alt="" loading="lazy" decoding="async">' : '<span>' + esc(name.slice(0, 1).toUpperCase()) + '</span>') + '</span>';
}

function barHTML(item) {
  const p = itemPercent(item);
  return '<div class="dl-bar' + (item.state === 'paused' ? ' is-paused' : '') + '" role="progressbar" aria-label="' + esc('Progression de ' + itemLabel(item)) + '" aria-valuemin="0" aria-valuemax="100"' +
    (p == null ? ' aria-valuetext="Taille inconnue"' : ' aria-valuenow="' + p + '"') + ' data-dl-bar><i style="width:' + (p || 0) + '%"></i></div>';
}

const pillBtn = (cls, act, label, icon, ring, pct) => '<button type="button" class="dl-pill ' + cls + '" data-dl-act="' + act + '" aria-label="' + esc(label) + '">' +
  (ring ? '<svg class="dl-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="dl-ring-t" cx="22" cy="22" r="19"/><circle class="dl-ring-p" cx="22" cy="22" r="19" stroke-dasharray="' + RING.toFixed(2) +
    '" stroke-dashoffset="' + (RING * (1 - (pct || 0) / 100)).toFixed(2) + '"/></svg>' : '') + '<span class="dl-ic">' + DL_ICON[icon] + '</span></button>';
const iconBtn = (act, label, icon) => '<button type="button" class="dl-ibtn" data-dl-act="' + act + '" aria-label="' + esc(label) + '">' + DL_ICON[icon] + '</button>';

function rowHTML(item, off) {
  const label = itemLabel(item);
  const s = item.state;
  const p = itemPercent(item);
  let extra = '';
  let acts = '';
  if (s === 'running' || s === 'paused') extra = barHTML(item);
  if (s === 'error') extra = '<p class="dl-err">' + esc(errorMessage(item.error ? item.error.code : 'resolve_failed')) + '</p>';
  if (s === 'done') extra = '<span class="dl-tag is-ok">' + DL_ICON.check + 'Téléchargé</span>';
  if (s === 'pending') extra = '<span class="dl-tag">' + DL_ICON.clock + 'En attente</span>';
  if (s === 'running') acts = pillBtn('is-running', 'pause', 'Mettre en pause ' + label, 'pause', true, p) + iconBtn('remove', 'Annuler le téléchargement de ' + label, 'x');
  else if (s === 'paused') acts = pillBtn('is-resume', 'resume', 'Reprendre ' + label, 'play') + iconBtn('remove', 'Annuler le téléchargement de ' + label, 'x');
  else if (s === 'pending') acts = pillBtn('is-pending', 'remove', 'Annuler l’attente : ' + label, 'clock');
  else if (s === 'error') acts = pillBtn('is-error', 'error', 'Erreur : ' + label + ', réessayer ou voir le détail', 'alert') + iconBtn('remove', 'Supprimer ' + label, 'x');
  else acts = '<button type="button" class="btn btn-ghost btn-sm dl-play" data-dl-act="play" aria-label="' + esc('Lire ' + label) + '">' + DL_ICON.play + '<span>Lire</span></button>' +
    '<button type="button" class="dl-ibtn dl-more" data-dl-act="more" aria-haspopup="dialog" aria-label="' + esc('Plus d’actions pour ' + label) + '">' + DL_ICON.more + '</button>';
  const sub = itemSubtitle(item) || (item.source && item.source.quality ? item.source.quality : '');
  return '<li class="dl-row is-' + s + (off && s !== 'done' ? ' is-na' : '') + '" data-dl-row="' + esc(item.id) + '" data-nav>' + posterHTML(item) +
    '<div class="dl-meta"><p class="dl-ttl">' + esc(itemName(item)) + '</p><p class="dl-sub" data-dl-sub>' + esc(sub) + '</p>' + extra + '</div>' +
    '<div class="dl-acts">' + acts + '</div></li>';
}

const section = (id, title, items, off) => (items.length
  ? '<section class="dl-sec" aria-labelledby="' + id + '"><h2 class="dl-sec-t" id="' + id + '">' + esc(title) + ' <span>(' + items.length + ')</span></h2><ul class="dl-list">' +
    items.map((it) => rowHTML(it, off)).join('') + '</ul></section>'
  : '');

function bannersHTML(items) {
  const out = [];
  if (!online()) {
    out.push('<div class="dl-banner is-offline" role="status" data-dl-offline>' + DL_ICON.wifiOff + '<span>Hors connexion — seuls tes téléchargements sont disponibles.</span></div>');
  }
  const errs = items.filter((it) => it.state === 'error');
  if (errs.length) {
    out.push('<div class="dl-banner is-err" role="alert"' + tvNav() + '>' + DL_ICON.alert + '<p>' + esc(errs.length === 1 ? '1 téléchargement a échoué.' : errs.length + ' téléchargements ont échoué.') +
      ' Les fichiers déjà reçus sont conservés.</p><button type="button" class="btn btn-sm dl-btn-d" data-dl-act="retry-all">Tout réessayer</button></div>');
  }
  if (isWeb() && items.some((it) => it.state === 'running' || it.state === 'pending')) {
    out.push('<div class="dl-banner is-err" role="status">' + DL_ICON.alert + '<span>Garde cet onglet ouvert : les téléchargements s’arrêtent si tu le fermes.</span></div>');
  }
  return out.join('');
}

function webCardsHTML() {
  if (!isWeb()) return '';
  const persist = v.persisted === true ? ''
    : '<section class="dl-card dl-persist" aria-labelledby="dl-persist-t"><p class="dl-card-h" id="dl-persist-t">' + DL_ICON.lock + 'Stockage persistant</p>' +
      '<p class="dl-card-p">Sans lui, le navigateur peut effacer les vidéos téléchargées quand l’espace manque. Active-le pour les garder.</p>' +
      '<button type="button" class="btn btn-primary btn-sm" data-dl-act="persist">Activer le stockage persistant</button></section>';
  const safari = isSafariLike()
    ? '<div class="dl-banner is-info">' + DL_ICON.info + '<p><b>Safari et iOS.</b> Sur iPhone et iPad, Safari peut supprimer les fichiers après 7 jours sans visite. Ouvre l’app de temps en temps, ou installe-la sur l’écran d’accueil.</p></div>'
    : '';
  return persist + safari;
}

function spaceCardHTML() {
  return '<section class="dl-card dl-space" aria-label="Espace de stockage" data-dl-space>' +
    '<div class="dl-space-h"' + tvNav() + '><p class="dl-space-l" data-dl-space-l>Espace utilisé…</p><a class="dl-link" href="#/settings" data-dl-act="storage-settings">Réglages de stockage</a></div>' +
    '<div class="dl-bar dl-bar-lg" role="progressbar" aria-label="Espace utilisé" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-dl-space-bar><i style="width:0%"></i></div>' +
    '<p class="dl-space-n" data-dl-space-n hidden></p></section>';
}

function headActionsHTML(items) {
  const active = items.some((it) => it.state === 'running' || it.state === 'pending');
  const paused = items.some((it) => it.state === 'paused');
  return (active ? '<button type="button" class="btn btn-ghost btn-sm" data-dl-act="pause-all">' + DL_ICON.pause + '<span>Tout mettre en pause</span></button>'
    : paused ? '<button type="button" class="btn btn-ghost btn-sm" data-dl-act="resume-all">' + DL_ICON.play + '<span>Tout reprendre</span></button>' : '') +
    (items.length ? '<button type="button" class="btn btn-sm dl-btn-d" data-dl-act="remove-all">Tout supprimer</button>' : '');
}

const shell = (inner, actions = '') => topBar(false) +
  '<article class="svc-page dl-page" aria-labelledby="svc-title"><header class="dl-head"><h1 class="dl-h1" id="svc-title" tabindex="-1">Téléchargements</h1>' +
  '<div class="dl-head-acts" data-nav data-dl-head>' + actions + '</div></header><div class="dl-body" data-dl-body>' + inner + '</div>' + (isTvDevice() ? '<p class="dl-tv-hint" aria-hidden="true">OK : choisir · Retour : fermer</p>' : '') + '</article>';

const emptyHTML = () => '<div class="dl-state"><span class="dl-state-ic" aria-hidden="true">' + DL_ICON.dl + '</span><h2>Rien de téléchargé</h2>' +
  '<p>Télécharge un film ou un épisode depuis sa fiche pour le regarder sans connexion.</p><div data-nav><a class="btn btn-primary" href="#/">Parcourir le catalogue</a></div></div>';

const loadingHTML = () => '<p class="sr-only" role="status">Chargement des téléchargements…</p><div class="dl-sk" aria-hidden="true"><span class="sk sk-line"></span>' +
  '<span class="sk dl-sk-row"></span><span class="sk dl-sk-row"></span><span class="sk dl-sk-row"></span></div>';

function stateHTML(icon, title, text, action = '') {
  return '<div class="dl-state" role="' + (action ? 'alert' : 'status') + '"><span class="dl-state-ic" aria-hidden="true">' + DL_ICON[icon] + '</span><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' +
    (action ? '<div data-nav>' + action + '</div>' : '') + '</div>';
}

/** Signature de la liste : redessin complet seulement si elle change. */
const signature = (items) => items.map((it) => it.id + ':' + it.state).join('|') + '|' + online() + '|' + v.persisted;

function renderList() {
  const body = detailEl.querySelector('[data-dl-body]');
  const head = detailEl.querySelector('[data-dl-head]');
  if (!body) return;
  const items = visibleItems(v.items);
  v.sig = signature(items);
  // Le focus est rendu au même geste de la même ligne après redessin (clavier, télécommande).
  const a = document.activeElement;
  const keep = a && body.contains(a) ? { row: a.closest('[data-dl-row]')?.dataset.dlRow, act: a.dataset.dlAct } : null;
  const keepHead = a && head && head.contains(a) ? a.dataset.dlAct : null; // l'en-tête est redessiné aussi : son focus est rendu
  const off = !online();
  const running = items.filter((it) => it.state !== 'done');
  const done = items.filter((it) => it.state === 'done');
  body.innerHTML = bannersHTML(items) + spaceCardHTML() + webCardsHTML() +
    (items.length ? section('dl-s-run', 'En cours', running, off) + section('dl-s-done', off ? 'Disponibles hors connexion' : 'Terminés', done, off) : emptyHTML());
  if (head) head.innerHTML = headActionsHTML(items);
  paintSpace();
  if (isTvDevice() && !body.contains(document.activeElement)) {
    // Télécommande : le focus arrive sur la première action, sinon les flèches n'ont aucun point de départ.
    const first = body.querySelector('[data-dl-row] [data-dl-act]') || body.querySelector('[data-nav] button, [data-nav] a[href]');
    if (first) first.focus({ preventScroll: true });
  }
  if (keepHead && head) {
    const t = head.querySelector('[data-dl-act="' + keepHead + '"]') || head.querySelector('button');
    if (t) t.focus({ preventScroll: true });
  }
  if (keep && keep.row) {
    const row = body.querySelector('[data-dl-row="' + attr(keep.row) + '"]');
    const t = row && (row.querySelector('[data-dl-act="' + keep.act + '"]') || row.querySelector('button'));
    if (t) t.focus({ preventScroll: true });
  }
}

/** Avancement en place : barres, anneaux et sous-titres, sans toucher au reste. */
function updateInPlace() {
  visibleItems(v.items).forEach((item) => {
    if (item.state !== 'running' && item.state !== 'paused') return;
    const row = detailEl.querySelector('[data-dl-row="' + attr(item.id) + '"]');
    if (!row) return;
    const p = itemPercent(item);
    const bar = row.querySelector('[data-dl-bar]');
    if (bar && p != null) {
      if (bar.getAttribute('aria-valuenow') !== String(p)) {
        bar.setAttribute('aria-valuenow', String(p));
        bar.removeAttribute('aria-valuetext');
        bar.firstElementChild.style.width = p + '%';
      }
    }
    const ring = row.querySelector('.dl-ring-p');
    if (ring) ring.setAttribute('stroke-dashoffset', (RING * (1 - (p || 0) / 100)).toFixed(2));
    const sub = row.querySelector('[data-dl-sub]');
    const text = itemSubtitle(item);
    if (sub && text && sub.textContent !== text) sub.textContent = text;
  });
}

function paintSpace() {
  const card = detailEl.querySelector('[data-dl-space]');
  if (!card) return;
  const s = v.space;
  if (!s) { card.hidden = true; return; }
  card.hidden = false;
  const g = gauge(s);
  const l = card.querySelector('[data-dl-space-l]');
  const bar = card.querySelector('[data-dl-space-bar]');
  const note = card.querySelector('[data-dl-space-n]');
  l.textContent = s.limit == null ? g.label : g.label.replace(' sur ', ' utilisés sur ');
  bar.setAttribute('aria-valuenow', String(g.percent));
  bar.firstElementChild.style.width = g.percent + '%';
  bar.classList.toggle('is-warn', g.level === 'warn');
  bar.classList.toggle('is-full', g.level === 'full');
  note.hidden = g.level === 'ok';
  note.className = 'dl-space-n is-' + g.level;
  note.innerHTML = g.level === 'full'
    ? DL_ICON.alert + '<span>Espace plein : les téléchargements sont arrêtés.</span><button type="button" class="dl-link" data-dl-act="space-full">Libérer de l’espace</button>'
    : g.level === 'warn' ? DL_ICON.alert + '<span>Bientôt plein : plus de 90 % de ta limite est utilisé.</span>' : '';
}

/** Espace relu au plus toutes les 2 s, et seulement sur cet écran. */
function refreshSpace(force = false) {
  const now = Date.now();
  const wait = SPACE_EVERY_MS - (now - v.spaceAt);
  if (!force && wait > 0) {
    if (!v.spaceTimer) v.spaceTimer = setTimeout(() => { v.spaceTimer = 0; refreshSpace(true); }, wait);
    return;
  }
  v.spaceAt = now;
  const token = v.token;
  getSpace().then((s) => {
    if (token !== v.token) return;
    v.space = s;
    paintSpace();
  }).catch(() => undefined);
}

function onItems(items) {
  v.items = items || [];
  paintDlBadges(v.items);
  if (!v.loaded) return;
  if (signature(visibleItems(v.items)) !== v.sig) renderList(); else updateInPlace();
  refreshSpace();
}

const onNet = () => { if (v.loaded && state.kind === 'downloads') renderList(); };

// ---------- Cycle de vie ----------
export function teardownDownloads() {
  teardownDownloadControls();
  closeSheet();
  if (v.unsub) v.unsub();
  v.unsub = null;
  clearTimeout(v.spaceTimer);
  v.spaceTimer = 0;
  v.token++;
  v.loaded = false;
  v.sig = '';
  window.removeEventListener('online', onNet);
  window.removeEventListener('offline', onNet);
}

export async function showDownloads() {
  teardownFiche();
  teardownDownloads();
  state.kind = 'downloads';
  document.title = 'Téléchargements · Laststream';
  const token = v.token;
  const av = platformAvailability();
  if (!av.ok) {
    detailEl.innerHTML = shell(stateHTML('block', 'Téléchargements indisponibles', av.reason));
    focusTitle();
    return;
  }
  detailEl.innerHTML = shell(loadingHTML());
  focusTitle();
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  let m = null;
  try { m = await getDownloads(); } catch (_) { m = null; }
  if (token !== v.token) return;
  if (!m) {
    const body = detailEl.querySelector('[data-dl-body]');
    if (body) body.innerHTML = stateHTML('alert', 'Les téléchargements n’ont pas pu être chargés', 'Le stockage de l’appareil ne répond pas. Réessaie dans un instant.',
      '<button type="button" class="btn btn-primary" data-dl-act="reload">Réessayer</button>');
    return;
  }
  if (isWeb() && navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => { if (token === v.token) { v.persisted = p; if (v.loaded) renderList(); } }).catch(() => undefined);
  }
  v.loaded = true;
  v.unsub = subscribeDownloads(onItems);
  if (!v.sig) renderList(); // la liste courante a déjà été reçue par onItems avant v.loaded : premier rendu
  refreshSpace(true);
}

function focusTitle() {
  const h1 = detailEl.querySelector('#svc-title');
  if (h1) h1.focus({ preventScroll: true });
}

const itemById = (id) => visibleItems(v.items).find((it) => it.id === id);

function confirmAll(opener) {
  const items = visibleItems(v.items);
  openSheet({
    title: 'Supprimer tous les téléchargements ?',
    cls: 'is-center',
    opener,
    render: (body, close) => {
      body.innerHTML = '<p class="dl-sheet-p">' + esc(items.length + (items.length > 1 ? ' titres seront effacés' : ' titre sera effacé') + ' de cet appareil.') + '</p>' +
        '<div class="dl-sheet-acts"><button type="button" class="btn dl-btn-d" data-dl-yes>Tout supprimer</button><button type="button" class="btn btn-ghost" data-dl-close>Annuler</button></div>';
      body.querySelector('[data-dl-yes]').addEventListener('click', async () => {
        close();
        const m = await getDownloads();
        if (!m) return;
        await Promise.all(items.map((it) => m.remove(it.id).catch(() => undefined)));
        toast('Téléchargements supprimés');
      });
    },
  });
}

// ---------- Gestes (délégués, limités à la page) ----------
detailEl.addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target.closest('[data-dl-act]') : null;
  if (!t || !t.closest('.dl-page')) return;
  const act = t.dataset.dlAct;
  const id = t.closest('[data-dl-row]')?.dataset.dlRow;
  const item = id ? itemById(id) : null;
  if (act === 'storage-settings') { e.preventDefault(); e.stopPropagation(); focusStorageSettings(); location.hash = '#/settings'; return; }
  e.preventDefault();
  e.stopPropagation();
  if (act === 'reload') { void showDownloads(); return; }
  if (act === 'persist') {
    const ok = await persistStorage();
    v.persisted = ok;
    toast(ok ? 'Stockage persistant activé' : 'Le navigateur a refusé le stockage persistant');
    if (ok) renderList();
    return;
  }
  if (act === 'space-full') { void openSpaceFullSheet(t); return; }
  if (act === 'retry-all') { visibleItems(v.items).filter((it) => it.state === 'error').forEach((it) => void retryItem(it.id)); return; }
  if (act === 'pause-all' || act === 'resume-all') {
    const m = await getDownloads();
    if (m) { if (act === 'pause-all') m.pauseAll(); else m.resumeAll(); }
    return;
  }
  if (act === 'remove-all') { confirmAll(t); return; }
  if (!item) return;
  if (act === 'pause') void pauseItem(item.id);
  else if (act === 'resume') void resumeItem(item.id);
  else if (act === 'error') openErrorSheet(item, t, renderList);
  else if (act === 'remove') confirmRemove(item, t, renderList);
  else if (act === 'play') void playOffline(item, t);
  else if (act === 'more') openDoneSheet(item, t, renderList);
});
