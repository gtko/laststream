/* Console d'administration (#/admin) : coquille (barre du haut, navigation groupée, compteurs) et chargement des sections.
 * Le registre ./admin/sections.js décrit chaque section (rendu, liaison, chargement) ; ce fichier gère le routage entre sections,
 * le rafraîchissement global (compteurs, état du serveur, compte à rebours d’élévation) et le contexte passé aux sections.
 * Les données restent chargées à la demande, par section. */
import { canAdmin } from '../data/auth';
import * as api from '../data/adminApi';
import { elevationExpiresAt, obtainElevation, setElevationPrompt } from '../data/adminApi';
import { CursorPager, fmtInt, formatCountdown } from '../data/adminModel';
import { closeAllLayers, confirmDialog, passwordDialog } from './admin-dialog.js';
import { defaultActions, installPaletteShortcuts, openPalette } from './admin-palette.js';
import { openAccount as openAccountDrawer } from './admin/account-drawer.js';
import { adminErr, attempt } from './admin/common.js';
import { elevationBoxHTML, pageHTML, statusHTML } from './admin/shell.js';
import { findSection, SECTIONS } from './admin/sections.js';
import { detailEl, toast } from './dom.js';
import { teardownFiche } from './fiche.js';
import { state } from './state.js';

const idle = () => ({ status: 'idle', value: null, error: '' });
/** État partagé de la console. Chaque donnée chargée a sa clé (`{ status, value, error }`), remplie par la section qui la charge. */
const S = {
  sec: 'overview', range: '1h', updatedAt: 0,
  status: null, badges: { todo: null, online: null, reports: null },
  ov: idle(), acc: idle(), accQuery: { q: '', status: '', order: 'newest', filter: 'all' }, accSel: new Set(), accPager: new CursorPager(),
  ref: idle(), inv: idle(), invStatus: 'active', online: idle(), perf: idle(), caches: idle(), purges: {}, tv: idle(), rooms: idle(), reports: idle(), repStatus: 'open',
  settings: idle(), audit: idle(), auditPager: new CursorPager(), auditAction: '',
  health: idle(), traffic: idle(), live: idle(), inbox: idle(),
};
const REFRESH_MS = 30_000;
const tokens = {};
const ctxs = new Map();
let refreshTimer = 0;
let tickTimer = 0;
let hooked = false;

const content = () => detailEl.querySelector('#adm-content');
const live = () => state.kind === 'admin' && !!content();

/** Charge une donnée pour une section : `quiet` garde l'affichage actuel pendant l'actualisation (pas de « Chargement… »). */
async function fetchKey(id, key, fn, quiet) {
  const token = (tokens[key] = (tokens[key] || 0) + 1);
  if (!quiet || S[key].status !== 'ready') { S[key] = { status: 'loading', value: null, error: '' }; if (S.sec === id) paint(); }
  try {
    const value = await fn();
    if (token !== tokens[key]) return;
    S[key] = { status: 'ready', value, error: '' };
    if (key === 'perf' || key === 'ov') S.updatedAt = Date.now();
  } catch (err) {
    if (token !== tokens[key]) return;
    S[key] = { status: 'error', value: null, error: adminErr(err) };
  }
  if (S.sec === id) paint();
}

/** Contexte donné aux sections : état, rafraîchissement, messages, navigation, confirmation, élévation. */
function ctxOf(id) {
  let c = ctxs.get(id);
  if (!c) {
    c = {
      S,
      sectionId: id,
      alive: live,
      isCurrent: () => live() && S.sec === id,
      paint,
      fetch: (key, fn, quiet) => fetchKey(id, key, fn, quiet),
      refresh: (quiet = false) => loadSection(id, quiet),
      go: (sid) => setSection(sid),
      toast,
      confirmDialog,
      elevate,
      badges: updateShell,
    };
    ctxs.set(id, c);
  }
  return c;
}

/** Dessine la section courante, puis la lie. Le focus sur un élément `data-adm-focus` est rétabli après le rendu. */
function paint() {
  const el = content();
  if (!el || !live()) return;
  const sec = findSection(S.sec);
  if (!sec) return;
  const scroll = window.scrollY;
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && el.contains(active) ? active.dataset.admFocus || '' : '';
  el.innerHTML = sec.render(S);
  if (sec.bind) sec.bind(el, ctxOf(sec.id));
  if (focusKey) {
    const n = Array.from(el.querySelectorAll('[data-adm-focus]')).find((x) => x.dataset.admFocus === focusKey);
    if (n) n.focus({ preventScroll: true });
  }
  window.scrollTo(0, scroll);
  syncElevation();
}

function loadSection(id, quiet) {
  const sec = findSection(id);
  return sec && sec.load ? sec.load(ctxOf(id), quiet) : undefined;
}

/** Affiche une section (false si l'identifiant n'existe pas). */
function setSection(id) {
  if (!findSection(id)) return false;
  if (id === S.sec) return true;
  S.sec = id;
  updateNav();
  paint();
  loadSection(id, true);
  const h = detailEl.querySelector('#adm-h');
  if (h) h.focus({ preventScroll: true });
  return true;
}

function updateNav() {
  detailEl.querySelectorAll('[data-adm-sec]').forEach((b) => {
    if (b.dataset.admSec === S.sec) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

// ---------- Coquille : état du serveur, compteurs ----------
/** Met à jour la pastille d’état et les compteurs de navigation (sans reconstruire la page). */
function updateShell() {
  if (!live()) return;
  const st = detailEl.querySelector('[data-adm-status]');
  if (st && st.dataset.state !== String(S.status)) st.outerHTML = statusHTML(S.status);
  detailEl.querySelectorAll('[data-adm-badge]').forEach((b) => {
    const n = S.badges[b.dataset.admBadge];
    b.hidden = n == null;
    b.textContent = n == null ? '' : fmtInt(n);
  });
}

/** État du serveur et compteurs : un échec donne « Inconnu » et masque le compteur concerné. */
async function refreshShell() {
  const [status, inbox, online, reports] = await Promise.allSettled([api.getStatus(), api.getInbox(), api.getLive(), api.listReports('open')]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);
  const report = val(status);
  S.status = report && typeof report.status === 'string' ? report.status : 'unknown';
  const inb = val(inbox);
  const on = val(online);
  const rep = val(reports);
  S.badges = {
    todo: inb && Number.isFinite(inb.total) ? inb.total : null,
    online: on && Number.isFinite(on.online) ? on.online : null,
    reports: rep && Array.isArray(rep.reports) ? rep.reports.length : null,
  };
  updateShell();
}

// ---------- Élévation : puce et compte à rebours ----------
function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!live()) { stopTick(); return; }
    syncElevation();
  }, 1000);
}

function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
}

/** Aligne la puce sur l’élévation réelle : compte à rebours (1 s) tant qu’elle est valable, bouton sinon. */
function syncElevation() {
  const box = detailEl.querySelector('[data-adm-elev]');
  if (!box) return;
  const at = elevationExpiresAt();
  if (at == null) {
    stopTick();
    if (box.dataset.state !== 'off') box.outerHTML = elevationBoxHTML(null);
    return;
  }
  if (box.dataset.state !== 'on') {
    box.outerHTML = elevationBoxHTML(at);
  } else {
    const t = box.querySelector('[data-adm-elev-txt]');
    if (t) t.textContent = formatCountdown(at - Date.now());
  }
  startTick();
}

/** Demande le mot de passe pour élever les droits (la fenêtre d’action est gérée par adminApi.js). */
async function elevate() {
  await attempt(() => obtainElevation(), toast);
  syncElevation();
}

// ---------- Minuteries et événements ----------
function startRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (!live()) { clearInterval(refreshTimer); refreshTimer = 0; stopTick(); return; }
    if (document.hidden) return;
    refreshShell();
    if (S.sec === 'performance') loadSection('performance', true);
  }, REFRESH_MS);
}

function onVisible() {
  if (document.hidden || !live()) return;
  refreshShell();
  if (S.sec === 'performance' && Date.now() - S.updatedAt > REFRESH_MS) loadSection('performance', true);
}

/** Actions de la coquille (délégation) : navigation, actualisation, recherche, élévation. Le reste est lié par les sections. */
function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !t.closest('.adm-shell')) return;
  const nav = t.closest('[data-adm-sec]');
  if (nav) { e.preventDefault(); setSection(nav.dataset.admSec); return; }
  if (t.closest('[data-adm-reload]')) { e.preventDefault(); loadSection(S.sec, false); return; }
  if (t.closest('[data-adm-palette]')) { openPalette(paletteDeps()); return; }
  if (t.closest('[data-adm-elevate]')) { e.preventDefault(); elevate(); }
}

document.addEventListener('click', onClick);

// ---------- Palette de commandes (Ctrl/Cmd+K, « / ») ----------
/** Dépendances de la palette : sections, navigation, actions de la console, ouverture de la fiche d'un compte (panneau latéral). */
function paletteDeps() {
  const go = (sid) => setSection(sid);
  return {
    sections: SECTIONS,
    go,
    openAccount: (id) => { openAccountDrawer(ctxOf('accounts'), id); },
    actions: defaultActions({ go }),
    elevate: async () => { await obtainElevation(); syncElevation(); },
  };
}

let stopShortcuts = null;
/** Pose le raccourci de la palette ; il n'agit que sur la console et se retire en la quittant (voir hashchange). */
function armShortcuts() {
  if (stopShortcuts) stopShortcuts();
  stopShortcuts = installPaletteShortcuts(() => { if (live()) openPalette(paletteDeps()); });
}

function disarmShortcuts() {
  if (stopShortcuts) { stopShortcuts(); stopShortcuts = null; }
}

// ---------- Page ----------
export function showAdmin() {
  if (!canAdmin()) { location.replace('#/'); return; }
  teardownFiche();
  state.kind = 'admin';
  document.title = 'Administration · Laststream';
  setElevationPrompt(({ error }) => passwordDialog({ error }));
  if (!hooked) {
    hooked = true;
    window.addEventListener('hashchange', closeAllLayers);
    window.addEventListener('hashchange', () => { if (!/^#\/admin(\/|$)/.test(location.hash)) disarmShortcuts(); });
    document.addEventListener('visibilitychange', onVisible);
  }
  detailEl.innerHTML = pageHTML(S);
  const h1 = detailEl.querySelector('#adm-title');
  if (h1) h1.focus({ preventScroll: true });
  paint();
  loadSection(S.sec, false);
  refreshShell();
  startRefresh();
  armShortcuts();
}

/** État interne exposé aux tests. */
export const __admin = { S, paint, loadSection, refreshShell, syncElevation, elevate, setSection, stopTick };
