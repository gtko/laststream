/* Téléchargements hors ligne (ODY-204) : bouton large de la fiche, pastille ronde des épisodes, feuilles basses (choix de
 * qualité et de langues, titre téléchargé, suppression, espace plein, détail d'une erreur), entrées de navigation.
 * Aucune URL n'est jamais affichée : seuls des libellés traduits (viewModel) et des tailles. Tout texte passe par esc(). */
import { isKidProfile } from '../data/auth';
import { downloadIdFor, getDownloads, getSpace, listDownloads, listSourceChoices, platformAvailability, recommendedChoice, requestDownload, subscribeDownloads } from '../downloads/service';
import { getDownloadSettings, isCellular, LIMIT_CHOICES, setDownloadSettings } from '../downloads/settings';
import { buttonState, errorMessage, formatBytes, gauge } from '../downloads/viewModel';
import { playBest } from '../player/session.js';
import { detailEl, toast } from './dom.js';
import { esc, names } from './util.js';

const svg = (d, extra = '') => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + extra + '>' + d + '</svg>';

/** Icônes des maquettes (docs/design/telechargements). */
export const DL_ICON = {
  dl: svg('<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
  pause: svg('<path d="M9 6v12M15 6v12"/>'),
  play: svg('<path d="M8 5.5v13l11-6.5z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  alert: svg('<path d="M12 4l9 16H3zM12 10v4M12 17h.01"/>'),
  block: svg('<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>'),
  more: svg('<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  retry: svg('<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  wifiOff: svg('<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.3M19 12.5a10 10 0 0 0-3.3-2M2 8.8a15 15 0 0 1 4.7-2.9M22 8.8A15 15 0 0 0 10.6 5M12 20h.01"/>'),
  disk: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 13h18M7 16.5h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
};

/** Circonférence de l'anneau (r = 19) de la pastille de 44 px. */
export const RING = 2 * Math.PI * 19;
const ringSVG = () => '<svg class="dl-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="dl-ring-t" cx="22" cy="22" r="19"/>' +
  '<circle class="dl-ring-p" cx="22" cy="22" r="19" stroke-dasharray="' + RING.toFixed(2) + '" stroke-dashoffset="' + RING.toFixed(2) + '"/></svg>';

function avail() {
  try { return platformAvailability(); } catch (_) { return { ok: false, reason: 'Téléchargements indisponibles sur cet appareil.' }; }
}

/** Les téléchargements sont masqués sur un profil enfant (comme Statistiques et Réglages). */
const downloadsAllowed = () => !isKidProfile();

const epCode = (s, e) => 'S' + s + ' É' + e;

// ---------- Suppressions différées (toast « Annuler ») ----------
/** id → { timer, restore } : le titre est masqué tout de suite, effacé au bout de 6 s sauf « Annuler » ou une relance. */
const pendingRemoval = new Map();
const UNDO_MS = 6000;
/** Liste visible : sans les titres en cours de suppression. */
export const visibleItems = (items) => (items || []).filter((it) => !pendingRemoval.has(it.id));

// ---------- Cible d'un bouton ----------
function targetAttrs(t) {
  return ' data-dl-id="' + esc(downloadIdFor(t)) + '" data-dl-key="' + esc(t.key) + '" data-dl-type="' + esc(t.type) + '" data-dl-tid="' + esc(t.id) +
    '" data-dl-name="' + esc(t.name) + '"' + (t.season != null ? ' data-dl-s="' + esc(t.season) + '" data-dl-e="' + esc(t.episode) + '"' : '');
}

function targetOf(el) {
  const d = el.dataset;
  const t = { key: d.dlKey, type: d.dlType === 'tv' ? 'tv' : 'movie', id: d.dlTid, name: d.dlName || '' };
  if (d.dlS != null && d.dlS !== '') { t.season = Number(d.dlS); t.episode = Number(d.dlE); }
  return t;
}

/** Requête de lecture d'un téléchargement terminé (le lecteur choisit seul la copie locale, ODY-203). */
function requestOfItem(item) {
  const [type, id] = String(item.metaId).split(':');
  const ref = item.source && item.source.ref;
  return { type, id: String(id), name: (ref && ref.name) || item.title, season: item.season ?? null, episode: item.episode ?? null, key: item.metaId };
}

export const itemName = (item) => {
  const ref = item.source && item.source.ref;
  return (ref && ref.name) || item.title || '';
};
export const itemLabel = (item) => itemName(item) + (item.season != null && item.episode != null ? ' ' + epCode(item.season, item.episode) : '');

// ---------- Bouton large de la fiche ----------
/**
 * Bouton « Télécharger » de la fiche, à côté de « Lecture » : le film, ou l'épisode à suivre d'une série (`ep` = { s, e }).
 * `off` : raison d'indisponibilité propre au titre (pas encore sorti). Chaîne vide sur un profil enfant.
 */
export function ficheDownloadHTML(m, ep, off) {
  if (!downloadsAllowed()) return '';
  const t = { key: m.key, type: m.type, id: String(m.id), name: m.name };
  if (m.type === 'tv') { t.season = ep ? ep.s : 1; t.episode = ep ? ep.e : 1; }
  const whyId = 'dl-why-' + String(m.key).replace(/[^a-z0-9]/gi, '-');
  return '<span class="dl-wrap">' +
    '<button type="button" class="btn btn-pill dl-btn" data-dl-ctl="btn"' + targetAttrs(t) + (off ? ' data-dl-off="' + esc(off) + '"' : '') + ' aria-describedby="' + whyId + '">' +
    '<span class="dl-fill" aria-hidden="true"></span><span class="dl-lbl"><span class="dl-ic">' + DL_ICON.dl + '</span><span class="dl-txt">Télécharger</span></span></button>' +
    '<span class="dl-why" id="' + whyId + '" hidden></span></span>';
}

/** Pastille ronde de 44 px d'un épisode (à côté de .ep-main, jamais dedans). */
export function episodeDownloadHTML(m, season, episode, epName) {
  if (!downloadsAllowed()) return '';
  const t = { key: m.key, type: 'tv', id: String(m.id), name: m.name, season, episode };
  return '<button type="button" class="dl-pill dl-ep" data-dl-ctl="pill"' + targetAttrs(t) + ' data-dl-ep="' + esc(epCode(season, episode) + (epName ? ' ' + epName : '')) +
    '" aria-label="' + esc('Télécharger : ' + epCode(season, episode)) + '">' + ringSVG() + '<span class="dl-ic">' + DL_ICON.dl + '</span></button>';
}

const STATE_ICON = { available: 'dl', pending: 'clock', running: 'pause', paused: 'play', done: 'check', error: 'alert', unavailable: 'block' };

/** Libellés des maquettes (« 62 % · Pause », « Reprendre · 62 % », « Réessayer ») sur la base de buttonState. */
function viewOf(el, item, av) {
  if (!item && el.dataset.dlOff) return { state: 'unavailable', label: 'Indisponible', percent: null, reason: el.dataset.dlOff };
  const vm = buttonState(item, av);
  const p = vm.percent;
  let label = vm.label;
  if (vm.state === 'running') label = p == null ? 'Téléchargement… · Pause' : p + ' % · Pause';
  else if (vm.state === 'paused') label = 'Reprendre' + (p == null ? '' : ' · ' + p + ' %');
  else if (vm.state === 'error') label = 'Réessayer';
  else if (vm.state === 'available' && el.dataset.dlS) label = 'Télécharger ' + epCode(el.dataset.dlS, el.dataset.dlE);
  return { ...vm, label };
}

function pillAria(el, v) {
  const ep = el.dataset.dlEp || '';
  const p = v.percent == null ? '' : v.percent + ' %, ';
  switch (v.state) {
    case 'pending': return 'En attente, annuler : ' + ep;
    case 'running': return 'En cours, ' + p + 'mettre en pause : ' + ep;
    case 'paused': return 'En pause, ' + p + 'reprendre : ' + ep;
    case 'done': return 'Téléchargé : ' + ep + ', ouvrir le menu';
    case 'error': return 'Erreur, réessayer : ' + ep + (v.reason ? ' (' + v.reason + ')' : '');
    case 'unavailable': return 'Indisponible : ' + (v.reason || ep);
    default: return 'Télécharger : ' + ep;
  }
}

/** Met un bouton ou une pastille à jour, en place (pas de nouveau nœud : le focus et le survol sont gardés). */
function paintControl(el, item, av) {
  const v = viewOf(el, item, av);
  const pct = v.percent == null ? 0 : v.percent;
  if (el.dataset.dlState !== v.state) {
    if (el.dataset.dlState) el.classList.remove('is-' + el.dataset.dlState);
    el.classList.add('is-' + v.state);
    el.dataset.dlState = v.state;
    const ic = el.querySelector('.dl-ic');
    if (ic) ic.innerHTML = DL_ICON[STATE_ICON[v.state]];
    if (v.state === 'unavailable') el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
  }
  if (el.dataset.dlCtl === 'pill') {
    const ring = el.querySelector('.dl-ring-p');
    const show = v.state === 'running' || v.state === 'paused';
    if (ring) ring.setAttribute('stroke-dashoffset', (RING * (1 - (show ? pct : 0) / 100)).toFixed(2));
    const aria = pillAria(el, v);
    if (el.getAttribute('aria-label') !== aria) el.setAttribute('aria-label', aria);
    el.title = v.state === 'unavailable' || v.state === 'error' ? v.reason || '' : '';
    return;
  }
  const fill = el.querySelector('.dl-fill');
  if (fill) fill.style.width = (v.state === 'running' || v.state === 'paused' ? pct : 0) + '%';
  const txt = el.querySelector('.dl-txt');
  if (txt && txt.textContent !== v.label) txt.textContent = v.label;
  const why = el.parentElement && el.parentElement.querySelector('.dl-why');
  if (why) {
    const reason = v.state === 'unavailable' || v.state === 'error' ? v.reason || '' : '';
    if (why.textContent !== reason) why.textContent = reason;
    why.hidden = !reason;
    why.classList.toggle('is-err', v.state === 'error');
  }
}

/** Peint tous les contrôles présents dans `root` d'après la liste. */
export function paintControls(items, root = detailEl) {
  const av = avail();
  const byId = new Map(visibleItems(items).map((it) => [it.id, it]));
  root.querySelectorAll('[data-dl-ctl]').forEach((el) => paintControl(el, byId.get(el.dataset.dlId), av));
  paintDlBadges(items);
}

// ---------- Abonnement unique des contrôles de la vue courante ----------
let ctlUnsub = null;
/** À appeler après avoir inséré des boutons (fiche, saison chargée) : peint tout de suite, puis suit la liste (un seul abonnement). */
export function hydrateDownloads(root = detailEl) {
  if (!root || !root.querySelector('[data-dl-ctl]')) return;
  paintControls(listDownloads(), root);
  if (!ctlUnsub && avail().ok) ctlUnsub = subscribeDownloads((items) => paintControls(items));
}
export function teardownDownloadControls() {
  if (ctlUnsub) ctlUnsub();
  ctlUnsub = null;
}

// ---------- Pastilles de navigation (barre du haut, onglet, carte de la Bibliothèque) ----------
const activeCount = (items) => visibleItems(items).filter((it) => it.state === 'running' || it.state === 'pending').length;
const badgeText = (n) => (n > 99 ? '99+' : String(n));
const navLabel = (n) => 'Téléchargements' + (n > 0 ? ', ' + n + ' en cours' : '');

export function paintDlBadges(items) {
  const n = activeCount(items);
  document.querySelectorAll('[data-dl-badge]').forEach((b) => {
    b.textContent = badgeText(n);
    b.hidden = n === 0;
  });
  document.querySelectorAll('[data-dl-nav]').forEach((a) => a.setAttribute('aria-label', navLabel(n)));
}

const badgeHTML = (cls) => {
  const n = activeCount(listDownloads());
  return '<span class="dl-badge ' + cls + '" data-dl-badge' + (n ? '' : ' hidden') + '>' + badgeText(n) + '</span>';
};

/** Bouton rond « Téléchargements » de la barre du haut (bureau, web, TV), avant Amis. */
export function downloadsNavHTML() {
  if (!downloadsAllowed()) return '';
  return '<a class="icon-btn nav-dl" href="#/downloads" data-go data-dl-nav aria-label="' + esc(navLabel(activeCount(listDownloads()))) + '" title="Téléchargements">' + DL_ICON.dl + badgeHTML('') + '</a>';
}

/** Pastille de l'onglet « Téléchargés » (barre mobile). */
export const downloadsTabBadgeHTML = () => badgeHTML('tab-badge');

/** Carte « Téléchargements » en tête de la Bibliothèque (sans compte social : la barre mobile a déjà 5 onglets). */
export function libraryDownloadsCardHTML() {
  if (!downloadsAllowed()) return '';
  const items = visibleItems(listDownloads());
  const done = items.filter((it) => it.state === 'done').length;
  const sub = items.length ? done + ' téléchargé' + (done > 1 ? 's' : '') + (activeCount(items) ? ' · ' + activeCount(items) + ' en cours' : '') : 'Regarde tes titres sans connexion';
  return '<a class="dl-libcard" href="#/downloads" data-go data-dl-nav aria-label="' + esc(navLabel(activeCount(items))) + '"><span class="dl-libcard-ic">' + DL_ICON.dl + badgeHTML('') + '</span>' +
    '<span class="dl-libcard-t"><span class="dl-libcard-h">Téléchargements</span><span class="dl-libcard-s">' + esc(sub) + '</span></span>' +
    '<span class="dl-libcard-go" aria-hidden="true">›</span></a>';
}

// ---------- Feuilles basses ----------
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
let sheetUid = 0;
let openLayer = null;

/**
 * Feuille basse (mobile) ou fenêtre centrée (bureau, TV) : piège le focus, Échap / retour ferme, flèches pour la télécommande,
 * focus rendu à `opener`. `render(body, close)` remplit le contenu. Une seule feuille à la fois.
 */
export function openSheet({ title, sub = '', cls = '', opener = document.activeElement, render, onClose = null, icon = '' }) {
  if (openLayer) openLayer.close(true);
  const id = 'dl-sheet-' + (++sheetUid);
  const el = document.createElement('div');
  el.className = 'dl-layer';
  el.innerHTML = '<div class="dl-scrim" data-dl-close></div>' +
    '<section class="dl-sheet' + (cls ? ' ' + cls : '') + '" role="dialog" aria-modal="true" aria-labelledby="' + id + '" tabindex="-1">' +
    '<span class="dl-grip" aria-hidden="true"></span>' + (icon ? '<span class="dl-sheet-ic" aria-hidden="true">' + icon + '</span>' : '') +
    '<h2 class="dl-sheet-t" id="' + id + '">' + esc(title) + '</h2>' + (sub ? '<p class="dl-sheet-sub">' + esc(sub) + '</p>' : '') +
    '<div class="dl-sheet-b"></div></section>';
  document.body.appendChild(el);
  document.body.classList.add('modal-open');
  const sheet = el.querySelector('.dl-sheet');
  const body = el.querySelector('.dl-sheet-b');
  let closed = false;
  const layer = {
    el,
    body,
    close(silent) {
      if (closed) return;
      closed = true;
      el.remove();
      if (openLayer === layer) openLayer = null;
      if (!document.querySelector('.dl-layer') && !document.querySelector('.adm-layer')) document.body.classList.remove('modal-open');
      if (!silent && opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
      if (onClose) onClose();
    },
  };
  el.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-dl-close]')) { e.preventDefault(); layer.close(); }
  });
  el.addEventListener('keydown', (e) => {
    // Rien ne remonte à la page (retour arrière, navigation de la fiche) tant que la feuille est ouverte.
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'Backspace') { e.preventDefault(); layer.close(); return; }
    const items = Array.from(sheet.querySelectorAll(FOCUSABLE)).filter((x) => !x.closest('[hidden]'));
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Tab') {
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
      return;
    }
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (dir) {
      e.preventDefault();
      items[(i + dir + items.length) % items.length].focus();
    }
  });
  openLayer = layer;
  if (render) render(body, layer.close);
  const first = body.querySelector('[data-dl-autofocus]') || body.querySelector('button:not([disabled])');
  (first || sheet).focus({ preventScroll: true });
  return layer;
}

export const closeSheet = () => { if (openLayer) openLayer.close(true); };

const btnHTML = (cls, attrs, label, icon = '') => '<button type="button" class="btn ' + cls + '"' + attrs + '>' + (icon ? DL_ICON[icon] : '') + '<span>' + esc(label) + '</span></button>';

// ---------- Actions ----------
async function manager() {
  try { return await getDownloads(); } catch (_) { return null; }
}

export async function pauseItem(id) { const m = await manager(); if (m) m.pause(id); }
export async function resumeItem(id) { const m = await manager(); if (m) m.resume(id); }
export async function retryItem(id) { const m = await manager(); if (m) m.retry(id); }

/** Lecture d'un titre téléchargé : chemin normal du lecteur (la copie locale est choisie par ODY-203). */
export function playOffline(item, opener) {
  closeSheet();
  return playBest(requestOfItem(item), opener);
}

/** Annule une suppression en attente : le titre revient tel quel (reprise s'il était en cours). Vrai si quelque chose était en attente. */
function cancelPendingRemoval(id) {
  const pending = pendingRemoval.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRemoval.delete(id);
  pending.restore();
  return true;
}

/** Supprime après 6 s ; « Annuler » rétablit le titre (et relance un téléchargement qui était en cours). */
async function removeWithUndo(item, onChange) {
  const m = await manager();
  if (!m || pendingRemoval.has(item.id)) return;
  const wasActive = item.state === 'running' || item.state === 'pending';
  if (wasActive) m.pause(item.id);
  const timer = setTimeout(() => {
    pendingRemoval.delete(item.id);
    m.remove(item.id).catch(() => toast('La suppression a échoué'));
  }, UNDO_MS);
  const restore = () => {
    if (wasActive) m.resume(item.id);
    if (onChange) onChange();
    paintControls(listDownloads());
  };
  pendingRemoval.set(item.id, { timer, restore });
  if (onChange) onChange();
  paintControls(listDownloads());
  toast('Téléchargement supprimé', {
    ms: UNDO_MS,
    action: { label: 'Annuler', run: () => cancelPendingRemoval(item.id) },
  });
  // Clavier ou télécommande : le bouton « Annuler » reçoit le focus, sinon il n'est pas atteignable sans souris.
  if (document.documentElement.dataset.input === 'kbd') document.querySelector('#toast .toast-action')?.focus({ preventScroll: true });
}

/** Suppression toujours confirmée. */
export function confirmRemove(item, opener, onChange) {
  const size = item.state === 'done' ? item.bytesTotal || item.bytesDone : item.bytesDone;
  openSheet({
    title: 'Supprimer « ' + itemLabel(item) + ' » ?',
    cls: 'is-center',
    opener,
    render: (body, close) => {
      body.innerHTML = '<p class="dl-sheet-p">' + esc((size ? 'Libère ' + formatBytes(size) + '. ' : '') + 'Tu pourras le retélécharger quand tu veux.') + '</p>' +
        '<div class="dl-sheet-acts">' + btnHTML('dl-btn-d', ' data-dl-yes', 'Supprimer') + btnHTML('btn-ghost', ' data-dl-close', 'Annuler') + '</div>';
      body.querySelector('[data-dl-yes]').addEventListener('click', () => { close(); void removeWithUndo(item, onChange); });
    },
  });
}

/** Titre terminé : « Lire hors ligne » ou « Supprimer ». */
export function openDoneSheet(item, opener, onChange) {
  openSheet({
    title: itemLabel(item),
    sub: 'Téléchargé' + (item.bytesTotal ? ' · ' + formatBytes(item.bytesTotal) : ''),
    opener,
    render: (body) => {
      body.innerHTML = '<div class="dl-sheet-acts">' + btnHTML('btn-primary', ' data-dl-play', 'Lire hors ligne', 'play') +
        btnHTML('dl-btn-d', ' data-dl-del', 'Supprimer', 'trash') + btnHTML('dl-btn-link', ' data-dl-close', 'Annuler') + '</div>';
      body.querySelector('[data-dl-play]').addEventListener('click', () => playOffline(item, opener));
      body.querySelector('[data-dl-del]').addEventListener('click', () => confirmRemove(item, opener, onChange));
    },
  });
}

/** Détail d'une erreur : motif, conseils, « Réessayer » et « Supprimer ». */
export function openErrorSheet(item, opener, onChange) {
  const code = item.error ? item.error.code : 'resolve_failed';
  openSheet({
    title: errorMessage(code),
    sub: itemLabel(item),
    icon: DL_ICON.alert,
    cls: 'is-error',
    opener,
    render: (body, close) => {
      body.innerHTML = '<ul class="dl-sheet-hints"><li>Réseau coupé : reprise automatique au retour du réseau.</li>' +
        '<li>Espace insuffisant : libère de la place ou augmente la limite.</li><li>Fichier inaccessible : supprime-le et relance.</li></ul>' +
        '<div class="dl-sheet-acts">' + btnHTML('btn-primary', ' data-dl-retry', 'Réessayer', 'retry') +
        (item.source && item.source.ref ? btnHTML('btn-ghost', ' data-dl-other', 'Choisir une autre source') : '') +
        btnHTML('dl-btn-d', ' data-dl-del', 'Supprimer le téléchargement') + '</div>';
      body.querySelector('[data-dl-retry]').addEventListener('click', () => { close(); void retryItem(item.id); });
      const other = body.querySelector('[data-dl-other]');
      if (other) other.addEventListener('click', () => { close(true); void chooseAnotherSource(item, opener); });
      body.querySelector('[data-dl-del]').addEventListener('click', () => confirmRemove(item, opener, onChange));
    },
  });
}

/** Limite suivante proposée par « Espace plein » (null : déjà sans limite ou au maximum). */
function nextLimit(current) {
  const i = LIMIT_CHOICES.indexOf(current);
  return i >= 0 && i < LIMIT_CHOICES.length - 1 ? LIMIT_CHOICES[i + 1] : null;
}

/** Feuille « Espace plein » (100 % de la limite choisie). */
export async function openSpaceFullSheet(opener) {
  const s = await getSpace();
  const g = s ? gauge(s) : { percent: 100, label: '', level: 'full' };
  const limit = getDownloadSettings().limitBytes;
  const next = limit == null ? undefined : nextLimit(limit);
  openSheet({
    title: 'Espace plein',
    icon: DL_ICON.disk,
    cls: 'is-center',
    opener,
    render: (body, close) => {
      body.innerHTML = '<p class="dl-sheet-p">' + esc('Tu as atteint ta limite' + (limit ? ' de ' + formatBytes(limit) : '') + '. Supprime des titres ou augmente la limite pour continuer.') + '</p>' +
        '<div class="dl-bar dl-bar-lg is-full" role="progressbar" aria-label="Espace utilisé" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + g.percent + '"><i style="width:' + g.percent + '%"></i></div>' +
        (g.label ? '<p class="dl-sheet-note">' + esc(g.label) + '</p>' : '') +
        '<div class="dl-sheet-acts"><a class="btn btn-primary" href="#/downloads" data-dl-manage>Gérer l’espace</a>' +
        (next !== undefined ? btnHTML('btn-ghost', ' data-dl-raise', next === null ? 'Passer sans limite' : 'Augmenter la limite à ' + formatBytes(next)) : '') +
        btnHTML('dl-btn-link', ' data-dl-close', 'Annuler') + '</div>';
      body.querySelector('[data-dl-manage]').addEventListener('click', () => close(true));
      const raise = body.querySelector('[data-dl-raise]');
      if (raise) raise.addEventListener('click', () => { setDownloadSettings({ limitBytes: next }); close(); toast(next === null ? 'Limite d’espace retirée' : 'Limite portée à ' + formatBytes(next)); });
    },
  });
}

/** Libellés lisibles des groupes de qualité : `SourceChoice.group` est la clé de groupe (2160p, 1080p…). */
const QUALITY_NAME = { '2160p': '4K', '1440p': '2K', '1080p': '1080p', '720p': '720p', SD: 'SD', other: 'Autres' };
/** Sources montrées d'abord par résolution ; les autres se déplient (« Voir N autres sources »). */
const SHOWN_PER_GROUP = 3;
const langName = (code) => {
  const n = names('language', code);
  return n ? n.charAt(0).toLowerCase() + n.slice(1) : code;
};
/** Libellé d'une langue : « audio français » ; « multi » et « original » ne sont pas des codes de langue ISO. */
const langTitle = (code) => (code === 'multi' ? 'multi-audio' : code === 'original' ? 'version originale' : 'audio ' + langName(code));
/** « 1080p · WEB-DL · H.265 » */
const choiceTitle = (c) => [c.quality, c.sourceType, c.codec].filter(Boolean).join(' · ');
/** « Audio français · AAC 5.1 · via Torrentio » */
const choiceSub = (c) => {
  const langs = c.langs.map(langTitle).join(' + ');
  return [langs ? langs.charAt(0).toUpperCase() + langs.slice(1) : '', c.audio, c.origin ? 'via ' + c.origin : ''].filter(Boolean).join(' · ');
};

const SEARCHING = '<p class="dl-sheet-load" role="status"><span class="dl-spin" aria-hidden="true"></span>Recherche des sources…</p>';
const cancelHTML = () => '<div class="dl-sheet-acts">' + btnHTML('dl-btn-link', ' data-dl-close data-dl-autofocus', 'Annuler') + '</div>';

/**
 * Feuille « Télécharger » : état de recherche visible (avec « Annuler »), puis la liste des sources par résolution, avec
 * taille, langue, audio et origine. Une source est présélectionnée (qualité mémorisée, espace libre), le choix reste libre ;
 * celles qui dépassent l'espace libre sont grisées avec le motif. `exclude` : source à ne pas reproposer (elle vient d'échouer).
 * Résout `{ source }` pour la source choisie, ou null si la feuille est fermée.
 */
function openChoiceSheet(t, opener, { exclude = null } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    openSheet({
      title: exclude ? 'Choisir une autre source' : 'Télécharger',
      sub: t.name + (t.season != null ? ' · ' + epCode(t.season, t.episode) : ''),
      opener,
      onClose: () => resolve(picked),
      render: (body, close) => {
        body.innerHTML = SEARCHING + cancelHTML();
        Promise.all([listSourceChoices(t, exclude ? { exclude } : {}), getSpace()]).then(([choices, space]) => {
          if (!body.isConnected) return;
          if (!choices.length) {
            body.innerHTML = '<p class="dl-sheet-p" role="alert">' + esc(exclude ? 'Aucune autre source n’est disponible pour ce titre.' : errorMessage('content')) + '</p><div class="dl-sheet-acts">' + btnHTML('btn-ghost', ' data-dl-close data-dl-autofocus', 'Fermer') + '</div>';
            body.querySelector('button').focus();
            return;
          }
          const free = space && space.limit != null ? Math.max(0, space.limit - space.used) : null;
          const tooBig = (c) => free !== null && c.sizeBytes > free;
          const byKey = new Map(choices.map((c) => [c.key, c]));
          const first = recommendedChoice(choices, free);
          const recommendedKey = first ? first.key : null;
          let selected = recommendedKey;
          const groups = [];
          for (const c of choices) {
            const g = groups.find((x) => x.key === c.group);
            if (g) g.items.push(c); else groups.push({ key: c.group, items: [c] });
          }
          const rowHTML = (c, hidden) => '<button type="button" class="dl-opt dl-src' + (tooBig(c) ? ' is-off' : '') + '" role="radio" data-dl-src="' + esc(c.key) + '" aria-checked="false"' +
            (tooBig(c) ? ' disabled aria-disabled="true"' : '') + (hidden ? ' hidden' : '') + '>' +
            '<span class="dl-rad" aria-hidden="true"></span><span class="dl-opt-t"><span class="dl-opt-l">' + esc(choiceTitle(c)) +
            (c.key === recommendedKey ? ' <span class="dl-tag">Recommandé</span>' : '') + '</span>' +
            '<span class="dl-opt-s">' + esc(tooBig(c) ? 'Trop grand pour ton espace libre (' + formatBytes(free) + ')' : choiceSub(c)) + '</span></span>' +
            '<span class="dl-opt-v">' + esc(c.sizeBytes ? formatBytes(c.sizeBytes) : 'Taille inconnue') + '</span></button>';
          const groupHTML = (g) => {
            // La source présélectionnée reste toujours visible, même au-delà des premières.
            const shown = Math.max(SHOWN_PER_GROUP, g.items.findIndex((c) => c.key === recommendedKey) + 1);
            return '<p class="dl-sheet-h" id="dl-g-' + esc(g.key) + '">' + esc(QUALITY_NAME[g.key] || g.key) + '</p>' +
              '<div class="dl-opts" role="radiogroup" aria-labelledby="dl-g-' + esc(g.key) + '">' +
              g.items.map((c, j) => rowHTML(c, j >= shown)).join('') + '</div>' +
              (g.items.length > shown ? '<button type="button" class="dl-more" data-dl-more="' + esc(g.key) + '" aria-expanded="false">Voir ' + (g.items.length - shown) + (g.items.length - shown > 1 ? ' autres sources' : ' autre source') + '</button>' : '');
          };
          const freeLine = space && space.limit != null ? 'Espace libre : ' + formatBytes(free) + ' sur ta limite de ' + formatBytes(space.limit)
            : space ? formatBytes(space.used) + ' utilisés · sans limite' : '';
          const allOff = choices.every(tooBig);
          body.innerHTML = '<p class="dl-sheet-note" role="status">' + esc(choices.length + (choices.length > 1 ? ' sources trouvées' : ' source trouvée') + ' · à toi de choisir') + '</p>' +
            groups.map(groupHTML).join('') +
            (freeLine ? '<p class="dl-sheet-note">' + esc(freeLine) + '</p>' : '') +
            (allOff ? '<p class="dl-sheet-p" role="alert">' + esc('Aucune source ne tient dans ton espace libre.') + ' <a href="#/downloads" data-dl-manage data-dl-close>Gérer l’espace</a></p>' : '') +
            '<div class="dl-sheet-acts"><button type="button" class="btn btn-primary" data-dl-go data-dl-autofocus' + (selected ? '' : ' disabled') + '>' + DL_ICON.dl + '<span data-dl-go-l></span></button>' +
            btnHTML('dl-btn-link', ' data-dl-close', 'Annuler') + '</div>';
          const sync = () => {
            body.querySelectorAll('[data-dl-src]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dlSrc === selected)));
            const c = selected ? byKey.get(selected) : null;
            const go = body.querySelector('[data-dl-go]');
            go.disabled = !c;
            body.querySelector('[data-dl-go-l]').textContent = 'Télécharger' + (c && c.sizeBytes ? ' · ' + formatBytes(c.sizeBytes) : '');
          };
          body.addEventListener('click', (e) => {
            const b = e.target instanceof Element ? e.target.closest('[data-dl-src], [data-dl-more], [data-dl-go]') : null;
            if (!b || b.disabled) return;
            if (b.dataset.dlSrc != null) selected = b.dataset.dlSrc;
            else if (b.dataset.dlMore != null) {
              const revealed = Array.from(b.previousElementSibling.querySelectorAll('[hidden]'));
              revealed.forEach((r) => { r.hidden = false; });
              b.remove();
              // Le bouton qui avait le focus disparaît : le focus passe à la première source dévoilée (clavier, télécommande).
              const next = revealed.find((r) => !r.disabled) || revealed[0];
              if (next) next.focus({ preventScroll: true });
              return;
            } else { picked = { source: byKey.get(selected) }; close(true); return; }
            sync();
          });
          sync();
          (body.querySelector('[data-dl-go]:not([disabled])') || body.querySelector('[data-dl-close]')).focus({ preventScroll: true });
        }).catch((err) => {
          if (!body.isConnected) return;
          const code = err && err.code ? err.code : 'network';
          body.innerHTML = '<p class="dl-sheet-p" role="alert">' + esc(errorMessage(code)) + '</p><div class="dl-sheet-acts">' + btnHTML('btn-ghost', ' data-dl-close data-dl-autofocus', 'Fermer') + '</div>';
          body.querySelector('button').focus();
        });
      },
    });
  });
}

/** Lance un téléchargement : la feuille liste les sources trouvées et l'utilisateur choisit. Erreurs traduites en toast. */
export async function startDownload(t, opener) {
  const s = getDownloadSettings();
  if (s.wifiOnly && isCellular()) { toast('Wi-Fi seulement : connecte-toi à un réseau Wi-Fi pour télécharger'); return; }
  const space = await getSpace();
  if (space && space.full) { await openSpaceFullSheet(opener); return; }
  const choice = await openChoiceSheet(t, opener);
  if (!choice) return;
  setDownloadSettings({ asked: true });
  await enqueueChoice(t, choice, opener);
}

/** Ajoute la source choisie à la file ; limite d'espace et réseau traduits en feuille ou en toast. */
async function enqueueChoice(t, choice, opener) {
  const s = getDownloadSettings();
  try {
    await requestDownload(t, choice);
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  } catch (err) {
    const code = err && err.code;
    if (code === 'quota_exceeded') { await openSpaceFullSheet(opener); return; }
    if (code === 'network' && s.wifiOnly && isCellular()) { toast('Wi-Fi seulement : connecte-toi à un réseau Wi-Fi pour télécharger'); return; }
    toast(errorMessage(code || 'resolve_failed'));
  }
}

/**
 * Source en échec : propose les autres sources du titre (même liste, sans nouvelle recherche), sans la source en échec.
 * Le téléchargement en erreur est remplacé seulement une fois la nouvelle source choisie.
 */
async function chooseAnotherSource(item, opener) {
  const ref = item.source && item.source.ref;
  if (!ref) return;
  const t = { key: ref.key, type: ref.type, id: ref.id, name: ref.name, ...(ref.season !== undefined ? { season: ref.season } : {}), ...(ref.episode !== undefined ? { episode: ref.episode } : {}) };
  // Même contrôle que startDownload, avant de supprimer : l'item en erreur ne doit pas disparaître si l'ajout est refusé.
  if (getDownloadSettings().wifiOnly && isCellular()) { toast('Wi-Fi seulement : connecte-toi à un réseau Wi-Fi pour télécharger'); return; }
  const choice = await openChoiceSheet(t, opener, { exclude: ref.match });
  if (!choice) return;
  const m = await manager();
  if (m) await m.remove(item.id);
  await enqueueChoice(t, choice, opener);
}

/** Geste sur un bouton ou une pastille, selon l'état peint. */
async function onControl(el) {
  const st = el.dataset.dlState || 'available';
  const id = el.dataset.dlId;
  const item = visibleItems(listDownloads()).find((it) => it.id === id);
  if (st === 'unavailable') { toast(el.dataset.dlOff || (avail().ok ? 'Indisponible' : avail().reason)); return; }
  if (!item || st === 'available') {
    // Relancé pendant les 6 s d'une suppression : le titre revient, sans nouvel ajout (la suppression différée l'effacerait).
    if (cancelPendingRemoval(id)) return;
    await startDownload(targetOf(el), el);
    return;
  }
  if (st === 'running') return pauseItem(id);
  if (st === 'paused') return resumeItem(id);
  if (st === 'error') return retryItem(id);
  if (st === 'pending') {
    const m = await manager();
    if (m) { await m.remove(id); toast('Téléchargement annulé'); }
    return;
  }
  if (st === 'done') openDoneSheet(item, el);
}

// Délégation sur #detail : avant le gestionnaire global (document), qui lancerait la lecture (data-play) ou fermerait un menu.
detailEl.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-dl-ctl]') : null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  void onControl(el);
});
