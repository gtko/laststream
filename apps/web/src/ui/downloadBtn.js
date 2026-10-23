/* Téléchargements hors ligne (ODY-204) : bouton large de la fiche, pastille ronde des épisodes, feuilles basses (choix de
 * qualité et de langues, titre téléchargé, suppression, espace plein, détail d'une erreur), entrées de navigation.
 * Aucune URL n'est jamais affichée : seuls des libellés traduits (viewModel) et des tailles. Tout texte passe par esc(). */
import { isKidProfile } from '../data/auth';
import { downloadIdFor, getDownloads, getSpace, listDownloads, listSourceChoices, planSeasonDownload, platformAvailability, recommendedChoice, requestDownload, requestSeasonDownload, subscribeDownloads } from '../downloads/service';
import { getDownloadSettings, isCellular, LIMIT_CHOICES, setDownloadSettings } from '../downloads/settings';
import { buttonState, errorMessage, formatBytes, gauge } from '../downloads/viewModel';
import { playBest } from '../player/session.js';
import { elKey, runOnce, TOGGLE_COOLDOWN_MS } from './busy.js';
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
export const downloadsAllowed = () => !isKidProfile();

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

// ---------- Bouton « Télécharger la saison » (en-tête de la saison affichée, ODY-234) ----------
/** Cibles de la saison affichée, par bouton (renseignées à chaque chargement de saison). */
const seasonTargets = new WeakMap();

/** Bouton de l'en-tête des épisodes, masqué tant que la saison n'est pas chargée. Chaîne vide : profil enfant ou plateforme indisponible. */
export function seasonDownloadHTML() {
  if (!downloadsAllowed() || !avail().ok) return '';
  return '<span class="dl-season-wrap" data-nav><button type="button" class="btn btn-ghost btn-sm dl-season" data-dl-season hidden>' + DL_ICON.dl + '<span class="dl-season-l">Télécharger la saison</span></button></span>';
}

/** Une cible par épisode déjà diffusé de la saison (les épisodes à date future sont exclus). */
export function airedSeasonTargets(m, season, eps, today) {
  return (eps || []).filter((e) => !(e.air_date && e.air_date > today))
    .map((e) => ({ key: m.key, type: 'tv', id: String(m.id), name: m.name, season, episode: e.episode_number }));
}

/** Peint le bouton d'après la liste : « Saison téléchargée » (désactivé) quand tous les épisodes sont terminés, « Saison en file » (désactivé) quand le reste est en file ou en cours ; un épisode en erreur ou absent laisse le bouton actif. */
function paintSeasonButton(btn, items) {
  const targets = seasonTargets.get(btn) || [];
  btn.hidden = targets.length === 0;
  const byId = new Map(visibleItems(items).map((it) => [it.id, it]));
  const found = targets.map((t) => byId.get(downloadIdFor(t)));
  const covered = targets.length > 0 && found.every((it) => it && it.state !== 'error');
  const all = covered && found.every((it) => it.state === 'done');
  const queued = covered && !all;
  btn.disabled = covered;
  btn.classList.toggle('is-done', all);
  const label = btn.querySelector('.dl-season-l');
  const text = all ? 'Saison téléchargée' : queued ? 'Saison en file' : 'Télécharger la saison';
  if (label && label.textContent !== text) label.textContent = text;
}

/** À appeler quand une saison est affichée : mémorise ses cibles (vides : bouton masqué) et peint le bouton. */
export function setSeasonDownload(targets, root = detailEl) {
  root.querySelectorAll('[data-dl-season]').forEach((btn) => {
    seasonTargets.set(btn, targets);
    paintSeasonButton(btn, listDownloads());
  });
  if (targets.length && avail().ok && !ctlUnsub && root.querySelector('[data-dl-season]')) ctlUnsub = subscribeDownloads((items) => paintControls(items));
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
  else if (vm.state === 'available' && el.dataset.dlBusy) label = 'Recherche…';
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
  root.querySelectorAll('[data-dl-season]').forEach((btn) => paintSeasonButton(btn, items));
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
export const activeCount = (items) => visibleItems(items).filter((it) => it.state === 'running' || it.state === 'pending').length;
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

const SEARCHING = 'Recherche des sources…';
/** Bouton « Annuler » seul (feuille de préparation de la saison). */
const cancelHTML = () => '<div class="dl-sheet-acts">' + btnHTML('dl-btn-link', ' data-dl-close data-dl-autofocus', 'Annuler') + '</div>';
/** Au-delà de ce délai sans fin de recherche, la feuille le dit et laisse choisir sans attendre. */
const SLOW_MS = 6000;
const SLOW_TEXT = 'Certaines sources répondent lentement, tu peux choisir maintenant.';

/** Une source sur la feuille : nom, langue, origine, taille. Trop grande pour l'espace libre : grisée, avec le motif. */
function choiceRow(c, free) {
  const off = free !== null && c.sizeBytes > free;
  const tpl = document.createElement('template');
  tpl.innerHTML = '<button type="button" class="dl-opt dl-src' + (off ? ' is-off' : '') + '" role="radio" data-dl-src="' + esc(c.key) + '" aria-checked="false"' +
    (off ? ' disabled aria-disabled="true"' : '') + '>' +
    '<span class="dl-rad" aria-hidden="true"></span><span class="dl-opt-t"><span class="dl-opt-l">' + esc(choiceTitle(c)) +
    ' <span class="dl-tag" data-dl-tag hidden>Recommandé</span></span>' +
    '<span class="dl-opt-s">' + esc(off ? 'Trop grand pour ton espace libre (' + formatBytes(free) + ')' : choiceSub(c)) + '</span></span>' +
    '<span class="dl-opt-v">' + esc(c.sizeBytes ? formatBytes(c.sizeBytes) : 'Taille inconnue') + '</span></button>';
  return tpl.content.firstElementChild;
}

/**
 * Contenu de la feuille « Télécharger ». Le squelette (recherche, Annuler) est posé tout de suite ; `paint` le complète sur
 * place à chaque liste reçue. Les lignes sont gardées par clé : une mise à jour n'en redessine ni n'en déplace aucune, et ne
 * fait pas sauter le défilement ni la ligne survolée. `paint` est idempotent : une même liste ne change rien.
 */
function choiceSheetBody(body, { emptyText, onPick, signal = null }) {
  // La zone role=status englobe la ligne de recherche et la note « lente » : les deux sont annoncées par les lecteurs d’écran.
  body.innerHTML = '<div role="status" data-dl-status>' +
    '<p class="dl-sheet-load" data-dl-line><span class="dl-spin" aria-hidden="true"></span><span data-dl-status-t>' + SEARCHING + '</span></p>' +
    '<p class="dl-sheet-note" data-dl-slow hidden>' + SLOW_TEXT + '</p>' +
    '</div>' +
    '<div class="dl-groups" data-dl-groups></div>' +
    '<p class="dl-sheet-note" data-dl-free hidden></p>' +
    '<p class="dl-sheet-p" role="alert" data-dl-alert hidden></p>' +
    '<div class="dl-sheet-acts">' +
    '<button type="button" class="btn btn-primary" data-dl-go disabled hidden>' + DL_ICON.dl + '<span data-dl-go-l></span></button>' +
    btnHTML('dl-btn-link', ' data-dl-close data-dl-autofocus', 'Annuler') + '</div>';
  const q = (s) => body.querySelector(s);
  const status = q('[data-dl-status]');
  const line = q('[data-dl-line]');
  const statusText = q('[data-dl-status-t]');
  const spin = q('.dl-spin');
  const slow = q('[data-dl-slow]');
  const groupsEl = q('[data-dl-groups]');
  const freeEl = q('[data-dl-free]');
  const alertEl = q('[data-dl-alert]');
  const go = q('[data-dl-go]');
  const goLabel = q('[data-dl-go-l]');
  const cancel = q('[data-dl-autofocus]');
  const sections = new Map(); // groupe de qualité -> { el, list }
  const rows = new Map(); // clé -> bouton de la source
  const shown = new Set(); // lignes affichées : une fois affichée, une ligne le reste
  const opened = new Set(); // groupes dépliés (« Voir N autres »)
  let byKey = new Map();
  let selected = null;
  let chosen = false; // l'utilisateur a choisi : la présélection ne bouge plus
  let count = 0;
  let pending = true;
  let slowDue = false;
  let ready = false; // la première liste est affichée
  const refreshSlow = () => { slow.hidden = !(slowDue && pending && count > 0); };
  const slowTimer = setTimeout(() => {
    slowDue = true;
    refreshSlow();
  }, SLOW_MS);
  // Feuille fermée (ou choix fait) : le délai ne doit plus rien afficher.
  const stopSlow = () => clearTimeout(slowTimer);
  if (signal?.aborted) stopSlow();
  else signal?.addEventListener('abort', stopSlow, { once: true });

  const syncGo = () => {
    rows.forEach((el, key) => el.setAttribute('aria-checked', String(key === selected)));
    const c = selected != null ? byKey.get(selected) : undefined;
    go.disabled = !c;
    goLabel.textContent = 'Télécharger' + (c && c.sizeBytes ? ' · ' + formatBytes(c.sizeBytes) : '');
  };

  /** Insertion de lignes sans saut : la ligne survolée ou focalisée garde sa place à l'écran (le défilement suit). */
  const keepInPlace = (mutate) => {
    const sheet = body.parentElement;
    let anchor = null;
    try {
      anchor = body.querySelector('[data-dl-src]:hover');
    } catch (_) {
      anchor = null;
    }
    const focused = document.activeElement;
    if (!anchor && focused && body.contains(focused) && focused.hasAttribute('data-dl-src')) anchor = focused;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    mutate();
    if (anchor && anchor.isConnected && sheet) sheet.scrollTop += anchor.getBoundingClientRect().top - before;
  };

  const fail = (message) => {
    if (!body.isConnected) return;
    pending = false;
    clearTimeout(slowTimer);
    status.hidden = true;
    slow.hidden = true;
    groupsEl.hidden = true;
    freeEl.hidden = true;
    go.hidden = true;
    alertEl.textContent = message;
    alertEl.hidden = false;
    cancel.querySelector('span').textContent = 'Fermer';
    cancel.focus({ preventScroll: true });
  };

  const paint = (choices, isPending, space) => {
    if (!body.isConnected) return;
    pending = isPending;
    count = choices.length;
    if (!pending) clearTimeout(slowTimer);
    if (!count) {
      if (!pending) fail(emptyText);
      return;
    }
    const free = space && space.limit != null ? Math.max(0, space.limit - space.used) : null;
    const tooBig = (c) => free !== null && c.sizeBytes > free;
    const first = recommendedChoice(choices, free);
    const recommendedKey = first ? first.key : null;
    byKey = new Map(choices.map((c) => [c.key, c]));
    // La ligne choisie n'existe plus (liste finale) : le choix est abandonné, la recommandation reprend la main.
    if (chosen && selected != null && !byKey.has(selected)) chosen = false;
    if (!chosen) selected = recommendedKey;
    const order = [];
    for (const c of choices) if (!order.includes(c.group)) order.push(c.group);
    keepInPlace(() => {
      for (const [key, el] of rows) {
        if (!byKey.has(key)) {
          el.remove();
          rows.delete(key);
        }
      }
      order.forEach((g, i) => {
        if (sections.has(g)) return;
        const el = document.createElement('div');
        el.className = 'dl-group';
        el.innerHTML = '<p class="dl-sheet-h" id="dl-g-' + esc(g) + '">' + esc(QUALITY_NAME[g] || g) + '</p>' +
          '<div class="dl-opts" role="radiogroup" aria-labelledby="dl-g-' + esc(g) + '"></div>';
        // Une section nouvelle prend sa place dans l'ordre de qualité, avant la suivante déjà affichée.
        const next = order.slice(i + 1).map((k) => sections.get(k)).find(Boolean);
        groupsEl.insertBefore(el, next ? next.el : null);
        sections.set(g, { el, list: el.querySelector('.dl-opts') });
      });
      const prevIn = new Map();
      for (const c of choices) {
        let el = rows.get(c.key);
        if (!el) {
          el = choiceRow(c, free);
          rows.set(c.key, el);
        }
        const list = sections.get(c.group).list;
        const prev = prevIn.get(c.group);
        if (prev) {
          if (prev.nextElementSibling !== el) prev.after(el);
        } else if (list.firstElementChild !== el) {
          list.prepend(el);
        }
        prevIn.set(c.group, el);
        el.querySelector('[data-dl-tag]').hidden = c.key !== recommendedKey;
      }
      for (const [g, sec] of sections) {
        const items = choices.filter((c) => c.group === g);
        const rec = items.findIndex((c) => c.key === recommendedKey);
        const limit = Math.max(SHOWN_PER_GROUP, rec + 1);
        items.forEach((c, j) => {
          if (opened.has(g) || j < limit) shown.add(c.key);
          rows.get(c.key).hidden = !shown.has(c.key);
        });
        const rest = items.filter((c) => !shown.has(c.key)).length;
        let more = sec.el.querySelector('[data-dl-more]');
        if (rest > 0) {
          if (!more) {
            more = document.createElement('button');
            more.type = 'button';
            more.className = 'dl-more';
            more.dataset.dlMore = g;
            more.setAttribute('aria-expanded', 'false');
            sec.el.appendChild(more);
          }
          more.textContent = 'Voir ' + rest + (rest > 1 ? ' autres sources' : ' autre source');
        } else if (more) {
          more.remove();
        }
      }
    });
    const found = count + (count > 1 ? ' sources trouvées' : ' source trouvée');
    line.className = 'dl-sheet-note';
    statusText.textContent = found + (pending ? ' · recherche en cours…' : ' · à toi de choisir');
    spin.hidden = !pending;
    groupsEl.hidden = false;
    refreshSlow();
    const freeLine = space && space.limit != null ? 'Espace libre : ' + formatBytes(free) + ' sur ta limite de ' + formatBytes(space.limit)
      : space ? formatBytes(space.used) + ' utilisés · sans limite' : '';
    freeEl.textContent = freeLine;
    freeEl.hidden = !freeLine;
    const allOff = choices.every(tooBig);
    alertEl.innerHTML = allOff ? esc('Aucune source ne tient dans ton espace libre.') + ' <a href="#/downloads" data-dl-manage data-dl-close>Gérer l’espace</a>' : '';
    alertEl.hidden = !allOff;
    go.hidden = false;
    syncGo();
    if (!ready) {
      ready = true;
      // Le focus est sur « Annuler » (ouverture) : il passe au choix dès qu'il existe. Ensuite il ne bouge plus.
      if (!go.disabled && document.activeElement === cancel) go.focus({ preventScroll: true });
    }
  };

  body.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-dl-src], [data-dl-more], [data-dl-go]') : null;
    if (!b || b.disabled) return;
    if (b.dataset.dlSrc != null) {
      chosen = true;
      selected = b.dataset.dlSrc;
      syncGo();
    } else if (b.dataset.dlMore != null) {
      const g = b.dataset.dlMore;
      opened.add(g);
      const revealed = Array.from(sections.get(g).list.children).filter((r) => r.hidden);
      revealed.forEach((r) => {
        r.hidden = false;
        shown.add(r.dataset.dlSrc);
      });
      b.remove();
      // Le bouton qui avait le focus disparaît : le focus passe à la première source dévoilée (clavier, télécommande).
      const next = revealed.find((r) => !r.disabled) || revealed[0];
      if (next) next.focus({ preventScroll: true });
    } else {
      onPick(byKey.get(selected));
    }
  });

  return { paint, fail };
}

/**
 * Feuille « Télécharger » : la recherche est visible tout de suite, avec « Annuler », puis les sources par résolution arrivent au
 * fil des addons. Une source est présélectionnée (qualité mémorisée, espace libre), le choix reste libre ; celles qui dépassent
 * l'espace libre sont grisées avec le motif. `exclude` : source à ne pas reproposer (elle vient d'échouer), sans suivi.
 * Résout `{ source }` pour la source choisie, ou null si la feuille est fermée.
 */
function openChoiceSheet(t, opener, { exclude = null } = {}) {
  return new Promise((resolve) => {
    let picked = null;
    const search = new AbortController();
    openSheet({
      title: exclude ? 'Choisir une autre source' : 'Télécharger',
      sub: t.name + (t.season != null ? ' · ' + epCode(t.season, t.episode) : ''),
      opener,
      onClose: () => {
        search.abort();
        resolve(picked);
      },
      render: (body, close) => {
        const ui = choiceSheetBody(body, {
          emptyText: exclude ? 'Aucune autre source n’est disponible pour ce titre.' : errorMessage('content'),
          onPick: (source) => {
            picked = { source };
            close(true);
          },
          signal: search.signal,
        });
        const space = getSpace();
        const list = exclude
          ? listSourceChoices(t, { exclude })
          : listSourceChoices(t, {
            onUpdate: (choices, pending) => {
              void space.then((sp) => ui.paint(choices, pending, sp), () => undefined);
            },
            signal: search.signal,
          });
        Promise.all([list, space])
          .then(([choices, sp]) => ui.paint(choices, false, sp))
          .catch((err) => ui.fail(errorMessage(err && err.code ? err.code : 'network')));
      },
    });
  });
}

/**
 * Retour visuel immédiat (ODY-238) : le contrôle affiche un chargeur et « Recherche… » dès le clic, avant toute attente réseau
 * ou disque. Le verrou et aria-busy / is-busy viennent de runOnce (busy.js, ODY-237). `done()` le rend ; sans effet si `el` a disparu.
 */
function setBusy(el) {
  if (!el || !el.classList) return () => {};
  el.dataset.dlBusy = '1';
  const txt = el.querySelector('.dl-txt');
  if (txt) txt.textContent = 'Recherche…';
  return () => {
    delete el.dataset.dlBusy;
    if (txt && txt.textContent === 'Recherche…') txt.textContent = el.dataset.dlS ? 'Télécharger ' + epCode(el.dataset.dlS, el.dataset.dlE) : 'Télécharger';
  };
}

/** Lance un téléchargement : la feuille liste les sources trouvées et l'utilisateur choisit. Erreurs traduites en toast. */
export async function startDownload(t, opener) {
  const s = getDownloadSettings();
  if (s.wifiOnly && isCellular()) { toast('Wi-Fi seulement : connecte-toi à un réseau Wi-Fi pour télécharger'); return; }
  const idle = setBusy(opener);
  let choice;
  try {
    const space = await getSpace();
    if (space && space.full) { idle(); await openSpaceFullSheet(opener); return; }
    // La feuille (et son « Recherche des sources… ») s'ouvre de façon synchrone : le contrôle redevient normal derrière elle.
    const sheet = openChoiceSheet(t, opener);
    idle();
    choice = await sheet;
  } finally { idle(); }
  if (!choice) return;
  setDownloadSettings({ asked: true });
  await enqueueChoice(t, choice, opener);
}

/** Ajoute la source choisie à la file ; limite d'espace et réseau traduits en feuille ou en toast. */
async function enqueueChoice(t, choice, opener) {
  const s = getDownloadSettings();
  // Confirmation tout de suite : la résolution de la source peut durer avant que le titre apparaisse dans la file.
  toast('Téléchargement lancé · ' + (t.name || 'titre') + (t.season != null ? ' ' + epCode(t.season, t.episode) : ''), { action: { label: 'Voir', run: () => { location.hash = '#/downloads'; } }, ms: 3500 });
  const idle = setBusy(opener);
  try {
    await requestDownload(t, choice);
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  } catch (err) {
    const code = err && err.code;
    if (code === 'quota_exceeded') { await openSpaceFullSheet(opener); return; }
    if (code === 'network' && s.wifiOnly && isCellular()) { toast('Wi-Fi seulement : connecte-toi à un réseau Wi-Fi pour télécharger'); return; }
    toast(errorMessage(code || 'resolve_failed'));
  } finally { idle(); }
}

/**
 * Feuille « Télécharger la saison » (ODY-234) : prépare toute la saison (avec progression), affiche « N épisodes · ~X Go » et
 * demande UNE confirmation. Rien n'est mis en file avant « Télécharger · taille » ; fermer la feuille pendant la préparation
 * abandonne en silence. Résout le plan confirmé, ou null (annulée, abandonnée, ou rien à télécharger).
 */
function openSeasonSheet(targets, label, opener) {
  return new Promise((resolve) => {
    let confirmed = null;
    let gone = false;
    const ctl = new AbortController(); // fermer la feuille arrête la résolution des sources restantes
    openSheet({
      title: 'Télécharger la saison',
      sub: label,
      opener,
      onClose: () => { gone = true; if (!confirmed) ctl.abort(); resolve(confirmed); },
      render: (body, close) => {
        const fail = (msg) => {
          body.innerHTML = '<p class="dl-sheet-p" role="alert">' + esc(msg) + '</p><div class="dl-sheet-acts">' + btnHTML('btn-ghost', ' data-dl-close data-dl-autofocus', 'Fermer') + '</div>';
          body.querySelector('button').focus({ preventScroll: true });
        };
        // Gabarit posé une fois, puis mis à jour en place : le bouton Annuler garde son nœud et son focus (D-pad).
        body.innerHTML = '<p class="dl-sheet-load" role="status"><span class="dl-spin" aria-hidden="true"></span><span data-dl-load-t></span></p>' +
          '<div class="dl-bar dl-bar-lg" role="progressbar" aria-label="Préparation de la saison" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="width:0%"></i></div>' +
          cancelHTML();
        const progress = (done, total) => {
          if (gone || !body.isConnected) return;
          const txt = body.querySelector('[data-dl-load-t]');
          const bar = body.querySelector('.dl-bar');
          if (!txt || !bar) return;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          txt.textContent = 'Recherche des sources…' + (total > 0 ? ' ' + done + ' / ' + total : '');
          bar.setAttribute('aria-valuenow', String(pct));
          bar.firstElementChild.style.width = pct + '%';
        };
        progress(0, targets.length);
        planSeasonDownload(targets, { onProgress: progress, signal: ctl.signal }).then((plan) => {
          if (gone || !body.isConnected) return;
          if (!plan.entries.length) { fail('Aucune source n’est disponible pour cette saison.'); return; }
          if (!(plan.totalBytes > 0)) { fail('La taille de cette saison est introuvable : le téléchargement n’est pas lancé.'); return; }
          const n = plan.entries.length;
          const size = (plan.unknownCount > 0 ? 'au moins ' : '~') + formatBytes(plan.totalBytes);
          const capped = plan.capped || 0;
          const off = plan.unavailable.length - capped;
          body.innerHTML = '<p class="dl-sheet-p dl-season-sum" role="status">' + esc(n + (n > 1 ? ' épisodes' : ' épisode') + ' · ' + size) + '</p>' +
            (off ? '<p class="dl-sheet-note">' + esc(off + (off > 1 ? ' épisodes indisponibles' : ' épisode indisponible') + ' (aucune source)') + '</p>' : '') +
            (capped ? '<p class="dl-sheet-note">' + esc(capped + (capped > 1 ? ' épisodes au-delà de la limite de 50' : ' épisode au-delà de la limite de 50')) + '</p>' : '') +
            '<div class="dl-sheet-acts"><button type="button" class="btn btn-primary" data-dl-go data-dl-autofocus>' + DL_ICON.dl + '<span>' + esc('Télécharger · ' + formatBytes(plan.totalBytes)) + '</span></button>' +
            btnHTML('dl-btn-link', ' data-dl-close', 'Annuler') + '</div>';
          const go = body.querySelector('[data-dl-go]');
          go.addEventListener('click', () => {
            go.disabled = true; // une seule confirmation
            confirmed = plan;
            close(true);
          });
          go.focus({ preventScroll: true });
        }).catch((err) => {
          if (gone || !body.isConnected) return;
          fail(errorMessage((err && err.code) || 'resolve_failed'));
        });
      },
    });
  });
}

/** Télécharger la saison : une feuille, une confirmation, une mise en file. Limite d'espace et réseau traduits comme pour un titre. */
export async function startSeasonDownload(targets, label, opener) {
  if (!targets.length) return;
  const s = getDownloadSettings();
  if (s.wifiOnly && isCellular()) { toast('Wi-Fi seulement : connecte-toi à un réseau Wi-Fi pour télécharger'); return; }
  const space = await getSpace();
  if (space && space.full) { await openSpaceFullSheet(opener); return; }
  const plan = await openSeasonSheet(targets, label, opener);
  if (!plan) return;
  setDownloadSettings({ asked: true });
  try {
    const added = await requestSeasonDownload(plan);
    if (!added.length) { toast('Opération annulée, réessaie'); return; } // plan caduc (purge, changement de profil)
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
  if (el.dataset.dlBusy) return; // déjà en préparation : un second clic ne relance rien
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
  // Un seul geste à la fois par bouton (ODY-237) : le verrou couvre aussi la feuille de choix, qui peut rester ouverte longtemps.
  void runOnce(el.dataset.dlId ? 'dl:' + el.dataset.dlId : elKey('dl', el), () => onControl(el), { el, cooldown: TOGGLE_COOLDOWN_MS, maxMs: 120000 });
});

// « Télécharger la saison » : mêmes règles que les autres contrôles (avant le gestionnaire global de la page).
detailEl.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-dl-season]') : null;
  if (!el || el.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  const targets = seasonTargets.get(el) || [];
  const first = targets[0];
  void runOnce(elKey('dl-season', el), () => startSeasonDownload(targets, first ? first.name + (first.season != null ? ' · Saison ' + first.season : '') : '', el), { el, maxMs: 120000 });
});
