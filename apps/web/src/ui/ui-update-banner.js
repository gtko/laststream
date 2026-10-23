/* Bannière « Une nouvelle version est disponible » de l'interface (Windows/WebView2 et web), en bas de l'écran. Le serveur publie
 * /version.json à chaque déploiement : contrôle peu après le lancement, au retour au premier plan (1 fois / min au plus) puis toutes
 * les 10 min. Masquée pendant une lecture ou en plein écran ; option : mise à jour seule après 5 min sans interaction. */
import { captureMessage } from '@sentry/browser';
import { getUiUpdateAuto, getUiUpdateNotify } from '../data/prefs';
import {
  applyUpdate, currentBuild, fetchDeployedBuild, isSnoozed, readSnooze, shouldShowBanner, snoozeBuild, uiUpdateActive,
} from '../data/uiUpdate';

const FIRST_CHECK_MS = 5000;
const RECHECK_MS = 10 * 60 * 1000;
const FOCUS_MIN_MS = 60 * 1000;
const WATCH_MS = 2000;
const IDLE_AUTO_MS = 5 * 60 * 1000;
const CONFIRM_MSG = 'La lecture sera interrompue (ta position est sauvegardée). Mettre à jour maintenant ?';
const TRIED_KEY = 'laststream.uiupdate.tried';
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Lecture ouverte (film/série via `isPlayerOpen`, lecteur TV via #player) ou plein écran actif : on ne dérange pas. */
const busyWith = (isPlayerOpen) => () => {
  const tv = document.getElementById('player');
  return !!isPlayerOpen?.() || (!!tv && !tv.hidden) || !!document.fullscreenElement;
};

/** Bannière + surveillance. `deps.isPlayerOpen` vient de main.js (session.js, trop lourd à importer ici) ; le reste substitue
 *  le réseau, l'horloge et l'application de la mise à jour en test. */
export function initUiUpdateBanner(deps = {}) {
  const active = deps.active ?? uiUpdateActive();
  if (!active) return null;
  const fetchBuild = deps.fetchBuild || (() => fetchDeployedBuild());
  const apply = deps.apply || (() => applyUpdate());
  const busy = deps.isBusy || busyWith(deps.isPlayerOpen);
  const now = deps.now || Date.now;
  const confirmFn = deps.confirm || ((m) => window.confirm(m));
  const current = deps.current ?? currentBuild();

  let pending = null; // build déployé en attente d'application
  let root = null;
  let watch = null;
  let lastCheck = 0;
  let lastActivity = now();
  let blocked = null; // build visé par une mise à jour auto qui n'a pas abouti : jamais réappliqué seul

  // Anti-boucle : si le rechargement auto n'a pas amené le build visé (cache tenace), on n'insiste pas.
  const store = deps.session ?? globalThis.sessionStorage;
  try {
    const tried = store?.getItem(TRIED_KEY);
    if (tried && tried === current) store.removeItem(TRIED_KEY);
    else if (tried) {
      blocked = tried;
      const warn = deps.report || ((m) => { try { captureMessage(m, { level: 'warning' }); } catch { /* sans Sentry */ } console.warn(m); });
      warn('uiupdate_auto_failed');
    }
  } catch { /* stockage de session indisponible */ }

  const remove = () => { if (root) root.remove(); root = null; };
  const stopWatch = () => { if (watch) clearInterval(watch); watch = null; };

  function build() {
    const r = el('div', 'uiupd-banner');
    r.setAttribute('role', 'status');
    const info = el('div', 'upd-info');
    info.append(el('p', 'upd-text', 'Une nouvelle version est disponible'), el('p', 'upd-sub', 'L’interface sera rechargée sur la même page.'));
    const go = el('button', 'upd-go', 'Mettre à jour');
    go.type = 'button';
    const x = el('button', 'upd-later', 'Plus tard');
    x.type = 'button';
    go.addEventListener('click', () => {
      if (busy() && !confirmFn(CONFIRM_MSG)) return;
      go.disabled = true;
      apply();
    });
    x.addEventListener('click', () => {
      if (pending) snoozeBuild(pending, now());
      pending = null;
      stopWatch();
      remove();
    });
    r.append(info, go, x);
    return r;
  }

  const wantsWatch = () => pending !== null && (root !== null || (getUiUpdateAuto() && pending !== blocked));
  /** Le sondage de 2 s ne tourne que si une bannière existe (même masquée) ou si l'auto attend l'inactivité. */
  function syncWatch() {
    if (wantsWatch()) { if (!watch) watch = setInterval(refresh, WATCH_MS); } else stopWatch();
  }

  /** Réévalue l'état : bannière présente mais masquée pendant lecture/plein écran ; mise à jour auto si inactif (même sans bannière). */
  function refresh() {
    if (pending === null) { syncWatch(); return; }
    if (isSnoozed(readSnooze(), pending, now())) { remove(); syncWatch(); return; }
    const hide = busy();
    if (shouldShowBanner(current, pending, getUiUpdateNotify(), null, now())) {
      if (!root) { root = build(); document.body.append(root); }
      root.hidden = hide;
    } else remove();
    if (!hide && pending !== blocked && getUiUpdateAuto() && now() - lastActivity >= IDLE_AUTO_MS) {
      stopWatch();
      try { store?.setItem(TRIED_KEY, pending); } catch { /* sans marqueur : au pire une tentative de plus */ }
      apply();
      return;
    }
    syncWatch();
  }

  async function check() {
    if (!getUiUpdateNotify() && !getUiUpdateAuto()) return; // rien à faire d'un build détecté : pas de requête
    lastCheck = now();
    const deployed = await fetchBuild();
    if (deployed === null) return;
    pending = deployed !== current ? deployed : null;
    if (pending === null) remove();
    refresh();
  }

  const touch = () => { lastActivity = now(); };
  ACTIVITY.forEach((t) => window.addEventListener(t, touch, { passive: true, capture: true }));
  document.addEventListener('fullscreenchange', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && now() - lastCheck >= FOCUS_MIN_MS) check();
  });
  setTimeout(check, deps.firstDelay ?? FIRST_CHECK_MS);
  setInterval(check, RECHECK_MS);
  return { check, refresh };
}
