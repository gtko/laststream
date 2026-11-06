/* Session de lecture : s'ouvre tout de suite (écran de chargement), cherche et choisit la source à l'intérieur du lecteur,
 * choisit le moteur, suit la progression, saute les génériques, bascule sur une autre copie en cas d'échec, gère pistes
 * audio, sous-titres (calage compris), épisodes. L'interface est dans ui.js et panels.js. */
import { DEMO_BLOCKED_MSG, isDemo } from '../data/demo';
import { toast } from '../ui/dom.js';
import { getAutoplay } from '../data/prefs';
import { measureBandwidthKbps } from '../data/sources';
import { userStore } from '../data/userStore';
import { addonStreamIdOf } from './addonRequest';
import { addonKeyOf, readAddonCatalogs } from '../data/addonCatalog';
import { loadAddonSources } from '../sources/addonSources';
import { awaitLaunchable, loadSources, recommendFor, requestKey, sourceLangFor, viewFromStream, webCompatContext } from '../sources/load';
import { webCompatOf } from '../sources/webCompat';
import { describeLaunch, describePending, isGoodMatch } from '../sources/rank';
import { currentCapHeight } from '../sources/resolutionCap';
import { offlineSourceFor } from '../downloads/offline';
import { offlineView } from './offlinePlay';
import { MEMORY_INDEX, forgetLaunch, launchUsable, reconcileLaunch, recallLaunch } from './launchCache';
import { badSources, sourceKey } from './memory';
import { isNativePlayer } from './native';
import { connectShell } from './shell';
import { debrid } from '../sources/debridClient';
import { partyBridge } from '../party/bridge';
import { LANG_WAIT_MS, bestSource, choiceReason, chooseSource, languageChanged, languageFallbackNotice, roomLangOf, sourceLabel } from '../party/sourceChoice';
import { notYetAiredMessage, showSourcesPanel } from './sessionActions.js';
import { switchToView, withoutBad } from './sessionFailover.js';
import { pollMoreSources, syncNative } from './sessionNative.js';
import { continueWith, initSession, loaderExtra } from './sessionOpen.js';
import { partyAdapter } from './sessionSocial.js';
import { S, badKey, langPrefsOf, originalLangOf, sourceLine } from './sessionState.js';

// API publique du lecteur : `startSession`, `playBest` et `playSource` ci-dessous, la fermeture dans sessionClose.js.
export { closePlayer, isPlayerOpen } from './sessionClose.js';
export { isPlayerFull, leavePlayer } from './sessionUi.js';

/** Lance le lecteur sur `view` (sources déjà connues, par exemple choisies dans un tiroir). */
export async function startSession(request, views, view, opts = {}) {
  if (isDemo()) { toast(DEMO_BLOCKED_MSG); return undefined; }
  await initSession(request, views, view, opts);
  return continueWith(view, opts);
}

// ---------- Lecture automatique (bouton « Lecture ») ----------

/**
 * Ouvre le lecteur tout de suite ; la recherche de sources et le choix de la meilleure (débit, langue, lecture directe)
 * se font dans l'écran de chargement. Réglage « lecture automatique » désactivé, aucune source ou aucune qui convienne :
 * le sélecteur s'ouvre dans un panneau du lecteur. « Annuler » ramène à la fiche.
 */
export async function playBest(request, opener, opts = {}) {
  if (isDemo()) { toast(DEMO_BLOCKED_MSG); return; } // mode démo : aucune recherche de source ni lecture
  const p = await initSession(request, [], null, { opener });
  p.resumeMode = opts.resume || 'ask';
  p.seekStart = opts.startAt ?? null;
  // Extrait partagé : arrêt unique à `stopAt` (clipTick), seulement avec une position de départ chiffrée.
  p.stopAt = typeof opts.stopAt === 'number' && typeof opts.startAt === 'number' && opts.stopAt > opts.startAt ? opts.stopAt : undefined;
  p.stopFrom = typeof opts.startAt === 'number' ? opts.startAt : 0;
  p.clipArmed = false;
  p.launchOpts = opts;
  p.noLaunchCache = !!opts.prefer; // salon : chacun suit la version de l'hôte, sans toucher à la source mémorisée
  // Salon : la source choisie dans le salon d'attente est lancée telle quelle, sans seconde recherche (le failover habituel reste).
  if (opts.chosen && (await playChosen(p, request, opts))) return;
  S.ui.setLoading(p.meta.title || 'Lecture', 'Recherche de la meilleure source…', loaderExtra(0));
  // Titre téléchargé : lu depuis l'appareil, sans recherche de source ni serveur de streaming (sauf salon : chacun suit la version de l'hôte).
  if (!opts.prefer && !opts.picker && !p.addon && (await playDownloaded(p, request))) return;
  await searchAndPlay(p, request, opts);
}

/**
 * Salon : lance la source choisie dans le salon d'attente avec la liste déjà chargée (repli, panneau Sources), sans recherche.
 * Faux (la recherche habituelle prend le relais) si le choix n'est plus jouable. Hors de la langue du salon, l'avis le dit.
 */
async function playChosen(p, request, opts) {
  const token = p.token;
  const view = opts.chosen;
  if (!view || !view.playable) return false;
  const loaded = opts.chosenLoaded || null;
  const views = loaded && loaded.views.includes(view) ? loaded.views : [view];
  try { if (userStore.loadProgress) await userStore.loadProgress(request.key); } catch (_) { /* progression distante facultative */ }
  if (!S.P || S.P.token !== token) return true;
  if (loaded) { request.imdb = loaded.imdb; p.imdb = loaded.imdb; }
  p.views = views;
  p.pending = loaded ? loaded.pending : [];
  p.loaded = loaded;
  p.ranked = [...views];
  const roomLang = opts.partyLang ? roomLangOf(opts.partyLang, originalLangOf(p)) : null;
  const notice = languageChanged(view, roomLang) ? 'Lecture hors langue du salon : ' + sourceLabel(view) : '';
  S.ui.setLoading(p.meta.title || 'Lecture', 'Source choisie dans le salon…', loaderExtra(2, { source: sourceLine(view) + (view.status === 'cached' ? ' ⚡' : '') }));
  await continueWith(view, { resume: p.resumeMode, notice });
  return true;
}

/** Lit la copie téléchargée du titre si elle existe et se lit sur cette plateforme ; faux sinon (la recherche de sources prend le relais). */
async function playDownloaded(p, request) {
  const token = p.token;
  let src = null;
  try {
    const sh = await connectShell();
    const platform = sh ? 'shell' : isNativePlayer() ? 'android' : 'web';
    src = await offlineSourceFor(platform, { key: request.key, season: request.season, episode: request.episode });
  } catch (_) { src = null; }
  if (!src) return false;
  if (!S.P || S.P.token !== token) { src.release(); return true; }
  p.local = src;
  // Progression distante rattrapée seulement avec du réseau (la locale suffit à reprendre hors ligne).
  if (userStore.loadProgress && navigator.onLine !== false) {
    await Promise.race([Promise.resolve(userStore.loadProgress(request.key)).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    if (!S.P || S.P.token !== token) return true;
  }
  const view = offlineView(src);
  p.views = [view];
  p.ranked = [view];
  p.pending = [];
  S.ui.setLoading(p.meta.title || 'Lecture', 'Lecture du fichier téléchargé…', loaderExtra(2, { source: 'Téléchargé · hors ligne', steps: ['Fichier téléchargé trouvé', 'Lecture depuis l’appareil', 'Préparation du fichier'] }));
  await continueWith(view, { resume: p.resumeMode });
  return true;
}

export const MEMORY_STEPS = ['Dernière source retrouvée', 'Choix de la meilleure source', 'Préparation du lien'];

/** Fiche de `view` dans la liste chargée (même source), sinon `view` : la vue reconstruite de la mémoire n'a pas l'indice du panneau. */
export const listed = (p, view) => p.views.find((v) => sourceKey(v) === sourceKey(view)) || view;

/** Langue de source visée par les préférences : une source mémorisée sous une autre langue n'est plus la bonne. */
export const launchLang = (p) => sourceLangFor(langPrefsOf(p), originalLangOf(p) || undefined);

/**
 * Relance (ODY-206) : reprend directement la source mémorisée pour cet épisode (6 h, même appareil), sans la recherche ni le choix.
 * Vrai si la lecture est lancée avec elle ; faux (aucun effet) si rien n'est mémorisé ou si la source n'est plus valable (voir
 * `launchUsable`) : la recherche complète prend le relais. La liste des sources se charge en arrière-plan (panneau « Sources »,
 * repli) ; un échec de la source mémorisée retombe sur la recherche complète (voir `searchInstead`).
 */
async function playRemembered(p, request) {
  const token = p.token;
  const episode = requestKey(request);
  const entry = recallLaunch(episode, launchLang(p));
  if (!entry) return false;
  let view;
  try {
    view = { ...viewFromStream(entry.stream), index: MEMORY_INDEX };
    const ok = sourceKey(view) === entry.source
      && launchUsable(view, { compat: webCompatContext(), hasDebrid: debrid().hasAny(), bad: new Set(badSources(badKey(p)).keys()), keyOf: sourceKey, maxHeight: currentCapHeight() });
    if (!ok) { forgetLaunch(episode); return false; }
  } catch (_) { forgetLaunch(episode); return false; } // entrée illisible : recherche complète
  // Progression distante rattrapée (1,5 s au plus) pour reprendre là où l'on s'était arrêté.
  if (userStore.loadProgress && navigator.onLine !== false) {
    await Promise.race([Promise.resolve(userStore.loadProgress(request.key)).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
  }
  if (!S.P || S.P.token !== token) return true;
  request.imdb = request.imdb || entry.imdb;
  p.imdb = p.imdb || entry.imdb;
  p.views = [view];
  p.ranked = [view];
  p.pending = [];
  p.memStart = true; // jusqu'au premier démarrage réussi
  p.fromCache = true; // jusqu'à l'arrivée de la liste complète
  p.cacheMerge = view;
  S.ui.setLoading(p.meta.title || 'Lecture', 'Reprise de la dernière source…', loaderExtra(2, { source: sourceLine(view) + (view.status === 'cached' ? ' ⚡' : ''), steps: MEMORY_STEPS }));
  const started = continueWith(view, { resume: p.resumeMode });
  loadSources(request).then((loaded) => mergeRemembered(p, loaded)).catch(() => undefined);
  await started;
  return true;
}

/** La liste complète arrive pendant (ou après) la lecture de la source mémorisée : panneau « Sources » et repli la voient. */
function mergeRemembered(p, loaded) {
  if (!S.P || S.P.token !== p.token || !p.cacheMerge) return;
  const mine = p.cacheMerge;
  p.cacheMerge = null;
  p.req.imdb = p.req.imdb || loaded.imdb;
  p.imdb = p.imdb || loaded.imdb;
  p.fromCache = false;
  const r = reconcileLaunch(mine, loaded.views, sourceKey, p.tried);
  if (p.view === mine) p.view = r.view;
  p.tried = r.tried;
  p.views = loaded.views;
  p.pending = loaded.pending;
  p.loaded = loaded;
  p.ranked = [...loaded.views];
  syncNative();
  pollMoreSources(p);
}

/** Repli silencieux : la source mémorisée n'a pas démarré, recherche complète comme au premier lancement (reprise à `startAt`). */
export function searchInstead(p, startAt) {
  forgetLaunch(requestKey(p.req));
  p.fromCache = false;
  p.memStart = false;
  p.cacheMerge = null;
  p.failing = false;
  p.seekStart = typeof startAt === 'number' ? startAt : null;
  p.view = null;
  p.views = [];
  p.ranked = [];
  p.pending = [];
  p.tried = new Set();
  p.attempts = 0;
  if (p.engine) {
    try { p.engine.pause(); } catch (_) { /* ignoré */ }
    if (p.engine.kind === 'native') p.engine.closeNow(); // sinon l'image figée du lecteur natif reste sous le chargeur
  }
  S.ui.root.classList.add('is-searching');
  S.ui.setLoading(p.meta.title || 'Lecture', 'Recherche de la meilleure source…', loaderExtra(0));
  return searchAndPlay(p, p.req, { ...p.launchOpts, noCache: true });
}

/** Sources d'un titre d'addon : directement chez l'addon (appareil), au format de `loadSources`. Aucune étape TMDB / IMDb. */
async function loadAddonLoaded(p, request) {
  const a = p.addon;
  // Repli hors registre : nom générique, jamais l'adresse de l'addon (elle peut porter un jeton).
  const entry = readAddonCatalogs()[addonKeyOf(a.base)] || { manifestUrl: a.base + '/manifest.json', name: 'Addon' };
  const views = await loadAddonSources(entry, a.type, addonStreamIdOf(request));
  return { imdb: '', views, pending: [] };
}

/** Recherche des sources, choix de la meilleure et lancement (écran de chargement du lecteur). */
export async function searchAndPlay(p, request, opts) {
  const token = p.token;
  const alive = () => S.P && S.P.token === token;
  if (!p.addon && !opts.noCache && !p.noLaunchCache && !opts.picker && (getAutoplay() || opts.force) && (await playRemembered(p, request))) return;
  if (!alive()) return;
  let loaded = null;
  try {
    if (p.addon) loaded = await loadAddonLoaded(p, request);
    else {
      if (userStore.loadProgress) await userStore.loadProgress(request.key);
      loaded = await loadSources(request);
    }
  } catch (_) { loaded = null; }
  if (!alive()) return;
  // Liste vide sans recherche en cours : le panneau explique pourquoi ; vide mais encore en cours : on attend la suite.
  if (!loaded || (!loaded.views.length && !loaded.pending.length)) {
    if (opts.notYetAired) S.ui.toast(notYetAiredMessage(opts.notYetAired));
    showSourcesPanel();
    return;
  }
  request.imdb = loaded.imdb;
  p.imdb = loaded.imdb;
  p.views = loaded.views;
  p.pending = loaded.pending;
  p.loaded = loaded;
  p.ranked = [...loaded.views];
  if (opts.picker || (!getAutoplay() && !opts.force)) { showSourcesPanel(); return; }
  S.ui.setLoading(p.meta.title || 'Lecture', 'Choix de la meilleure source…', loaderExtra(1));
  const t0 = Date.now();
  const bw = await measureBandwidthKbps().catch(() => null);
  if (!alive()) return;
  // Salon : la version de l'hôte (empreinte) passe avant la « meilleure » source ; chacun lit avec SA source.
  const compatCtx = webCompatContext();
  // Salon à langue imposée : la version de l'hôte, puis la langue du salon (et non les préférences personnelles).
  const roomLang = opts.partyLang ? roomLangOf(opts.partyLang, originalLangOf(p)) : null;
  const recommend = (views) => {
    const usable = withoutBad(p, views);
    if (roomLang) {
      // Navigateur : seules les sources compatibles sont choisies (comme recommendFor).
      const pool = compatCtx.web ? usable.filter((v) => webCompatOf(v, compatCtx).level === 'ok') : usable;
      const choice = chooseSource(pool, { fingerprint: opts.partyFingerprint, hostLabel: opts.hostLabel, roomLanguage: roomLang });
      if (choice.view) return { view: choice.view, languageFallback: false, reason: choiceReason(choice.motif), party: choice.motif === 'fingerprint' };
      const best = bestSource(pool);
      return best ? { view: best, languageFallback: true, reason: languageFallbackNotice(best, opts.partyLang) } : null;
    }
    // Navigateur : la version de l'hôte n'est suivie que si elle passe ici (sinon la meilleure source compatible).
    const same = opts.prefer ? opts.prefer(usable.filter((v) => webCompatOf(v, compatCtx).level === 'ok')) : null;
    return same ? { view: same, reason: 'Même version que l’hôte du salon', party: true } : recommendFor(usable, bw, originalLangOf(p) || undefined, undefined, langPrefsOf(p));
  };
  const good = (r) => !!r && (r.party === true || isGoodMatch(r));
  // Lancement sans attendre tous les addons : voir awaitLaunchable. Les addons restants alimentent le panneau Sources.
  const { rec } = await awaitLaunchable(loaded, {
    request,
    since: t0,
    readable: (views) => views.some((v) => v.playable && !v.client && webCompatOf(v, compatCtx).level === 'ok'),
    recommend,
    good,
    fallbackWaitMs: roomLang ? LANG_WAIT_MS : undefined,
    stop: () => !alive() || p.pickMine,
    onUpdate: (next) => {
      p.views = next.views;
      p.pending = next.pending;
      p.loaded = next;
      p.ranked = [...next.views];
    },
    onWait: (next, r) => S.ui.setLoading(
      p.meta.title || 'Lecture',
      r ? describeLaunch(next.views.length, next.pending) : describePending(next.pending),
      loaderExtra(r ? 1 : 0, { slow: true }),
    ),
  });
  if (!alive() || p.pickMine) return;
  if (!rec) { showSourcesPanel(); return; }
  S.ui.setLoading(p.meta.title || 'Lecture', rec.reason, loaderExtra(2, { source: sourceLine(rec.view) + (rec.view.status === 'cached' ? ' ⚡' : '') }));
  await continueWith(rec.view, { resume: p.resumeMode, notice: rec.languageFallback ? rec.reason : '' });
}

/** Lance une source choisie dans le sélecteur de la fiche. */
export function playSource(request, views, view, opener, opts = {}) {
  if (isDemo()) { toast(DEMO_BLOCKED_MSG); return Promise.resolve(); }
  return startSession(request, views, view, { opener, resume: opts.resume || 'ask' });
}

// Salon (watch party) : le pont lance les épisodes demandés par l'hôte avec la source la plus proche de son empreinte.
partyBridge.launcher = (request, o) => playBest(request, null, { resume: o.resume, force: true, prefer: o.prefer, partyLang: o.partyLang, partyFingerprint: o.partyFingerprint, hostLabel: o.hostLabel, chosen: o.chosen, chosenLoaded: o.chosenLoaded });
partyBridge.adapter = () => partyAdapter();
partyBridge.switcher = (view, allow) => switchToView(view, allow);
