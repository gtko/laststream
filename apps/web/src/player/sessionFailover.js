/* Bascule sur une autre copie en cas d'échec : candidats, sources mémorisées en échec, repli local ou flux. */
import { requestKey, webCompatContext } from '../sources/load';
import { failoverCandidates } from '../sources/webCompat';
import { currentOs } from './appDownload';
import { failoverOrder, pickRaceCandidate } from './failover';
import { isOfflineView, offlineFailureView } from './offlinePlay';
import { forgetLaunch } from './launchCache';
import { badSources, markBad, sourceKey } from './memory';
import { getDesktopEngine } from '../data/prefs';
import { shouldRetryOnLibvlc } from './engine';
import { isNativePlayer } from './native';
import { shellHasLibvlc } from './shell';
import { searchAndPlay, searchInstead } from './session.js';
import { loaderExtra } from './sessionOpen.js';
import { playView, releaseLocal } from './sessionPlay.js';
import { S, badKey, MAX_ATTEMPTS, originalLangOf } from './sessionState.js';
import { languageChanged, partyFallbackNotice, roomLangOf, sourceLabel } from '../party/sourceChoice';
import { expandPlayer } from './sessionUi.js';


/** Écarte les sources mémorisées comme lentes ou en échec pour ce titre (24 h), sauf s'il n'en reste aucune. */
export function withoutBad(p, views) {
  const bad = badSources(badKey(p));
  const good = views.filter((v) => !bad.has(sourceKey(v)));
  return good.length ? good : views;
}

/** Prochain candidat de la course : lecture directe de la même source, sinon la meilleure autre (langue, cache, lecture directe). */
export function nextCandidate(p, tried) {
  const first = tried[0];
  if (p.hint && p.hint.fastDirect && !tried.some((c) => c.direct)) return { view: first.view, direct: true };
  const bad = new Set(badSources(badKey(p)).keys());
  const skip = new Set([...p.tried, ...tried.map((c) => c.view.index)]);
  const v = pickRaceCandidate(fallbackPool(p), first.view, skip, bad, sourceKey);
  if (!v) return null;
  // Salon : une source de repli hors de la langue du salon est annoncée, jamais lue en silence (comme au repli).
  const notice = partyFallbackNotice(v, roomLangOf(p.launchOpts && p.launchOpts.partyLang, originalLangOf(p)));
  if (notice) S.ui.toast(notice, 5000);
  return { view: v, direct: false };
}

export function recordRace(p, win) {
  const key = badKey(p);
  win.lost.forEach((f) => markBad(key, sourceKey(f.candidate.view), 'trop lente à démarrer'));
  win.failures.forEach((f) => markBad(key, sourceKey(f.candidate.view), f.message));
}

/** Le fichier téléchargé ne se lit pas : message clair (et proposition d'ouvrir dans l'app, ou de lire en streaming s'il y a du réseau). */
export function localFailure(kind, reason) {
  const p = S.P;
  if (!p || p.localFailed) return;
  p.localFailed = true;
  p.failing = true;
  try { p.engine.pause(); } catch (_) { /* ignoré */ }
  if (p.engine.kind === 'native') p.engine.closeNow();
  expandPlayer();
  S.ui.setLoading(null);
  const platform = S.shell ? 'shell' : isNativePlayer() ? 'android' : 'web';
  const v = offlineFailureView({ kind, reason, platform, os: currentOs(), online: navigator.onLine !== false });
  S.ui.setError(v.title, v.text, v.actions);
}

/** Abandonne le fichier téléchargé pour chercher une source en streaming (bouton « Lire en streaming » ou « Sources »). */
export function streamInstead(opts = { force: true }) {
  const p = S.P;
  if (!p) return;
  if (navigator.onLine === false) { S.ui.toast('Aucune connexion : seul le fichier téléchargé est disponible', 4000); return; }
  const at = p.engine ? p.engine.state().time : 0;
  if (p.engine && p.engine.kind === 'native') p.engine.closeNow(); else if (p.engine) { try { p.engine.destroy(); } catch (_) { /* ignoré */ } }
  releaseLocal(p);
  Object.assign(p, { localFailed: false, failing: false, attempts: 0, tried: new Set(), view: null, views: [], ranked: [], pending: [], seekStart: at > 5 ? at : null, resumeMode: p.resumeMode || 'ask' });
  S.ui.setError(null);
  S.ui.root.classList.add('is-searching');
  S.ui.setLoading(p.meta.title || 'Lecture', 'Recherche de la meilleure source…', loaderExtra(0));
  searchAndPlay(p, p.req, opts).catch(() => undefined);
}

/**
 * Mode auto : un échec de mpv avant que la vidéo soit prête (`ready`) relance la même source une seule fois avec libVLC, à la même position.
 * Vrai si la relance a eu lieu (l'échec ne passe alors pas par le repli).
 */
export function retryOnLibvlc(p, engine) {
  if (!p || !p.view || isOfflineView(p.view)) return false;
  p.libvlcTried = p.libvlcTried || new Set();
  const key = sourceKey(p.view);
  const retry = shouldRetryOnLibvlc({
    mode: getDesktopEngine(), backend: p.choice && p.choice.backend, videoReady: !!p.videoReady,
    libvlcAvailable: shellHasLibvlc(), alreadyRetried: p.libvlcTried.has(key),
  });
  if (!retry) return false;
  p.libvlcTried.add(key);
  // La relance libVLC n'est pas un nouvel essai de source : playView va compter une tentative, on la rend ici.
  p.attempts = Math.max(0, (p.attempts || 0) - 1);
  const time = engine.state().time;
  playView(p.view, time > 5 ? time : p.startAt || 0, { shellBackend: 'libvlc' });
  return true;
}

/** Repli automatique : copie équivalente d'abord, puis source suivante. */
export function failover(reason) {
  const p = S.P;
  if (!p || p.failing) return;
  p.failing = true;
  if (isOfflineView(p.view)) { localFailure(/media-error:[34]\b/.test(reason) ? 'video' : /bloquée|trop de temps/.test(reason) ? 'stalled' : 'error', reason); return; }
  const time = p.engine ? p.engine.state().time : 0;
  const options = failoverOrder(fallbackPool(p), p.view, p.tried);
  // Une source en échec n'est plus rejouée à la relance ; démarrée depuis la mémoire sans autre choix connu : recherche complète.
  forgetLaunch(requestKey(p.req), sourceKey(p.view));
  if (p.fromCache && (!options.length || p.attempts >= MAX_ATTEMPTS)) { searchInstead(p, time > 5 ? time : p.startAt || 0); return; }
  if (!options.length || p.attempts >= MAX_ATTEMPTS) {
    try { p.engine.pause(); } catch (_) { /* ignoré */ }
    if (p.engine.kind === 'native') p.engine.closeNow();
    expandPlayer();
    S.ui.setLoading(null);
    S.ui.setError('Lecture impossible', reason + '. Aucune autre source à essayer automatiquement.', [{ act: 'source', label: 'Essayer une autre source' }, { act: 'retry', label: 'Réessayer' }, { act: 'close', label: 'Fermer' }]);
    return;
  }
  const next = options[0];
  // Salon : une source de repli hors de la langue du salon est annoncée, jamais lue en silence.
  const roomLang = roomLangOf(p.launchOpts && p.launchOpts.partyLang, originalLangOf(p));
  const label = languageChanged(next, roomLang)
    ? sourceLabel(next) + ' · hors langue du salon'
    : [next.quality, next.sourceType, next.langs.map((l) => l.label).join('/')].filter(Boolean).join(' · ');
  S.ui.toast('Source indisponible, essai de la suivante : ' + label, 5000);
  playView(next, time > 5 ? time : p.startAt || 0);
}

/**
 * Salon : lecture d'une autre source déjà chargée du titre, à la position courante (choix de l'hôte). `allow` filtre les
 * sources de repli de cette bascule (compatibles avec les invités) : la lecture ne retombe jamais sur une autre.
 */
export function switchToView(view, allow) {
  const p = S.P;
  if (!p || !p.engine || !p.view || !view || view.index === p.view.index) return false;
  const st = p.engine.state();
  p.attempts = 0;
  p.tried = new Set();
  p.fallbackFilter = typeof allow === 'function' ? allow : null;
  p.partySwitch = true;
  S.ui.toast('Changement de source…');
  playView(view, Math.max(0, st.time || 0));
  return true;
}

/** Sources pouvant servir au repli : celles qu'autorise la bascule en cours, sinon toutes les sources classées. */
function fallbackPool(p) {
  const pool = p.fallbackFilter ? p.ranked.filter((v) => p.fallbackFilter(v)) : p.ranked;
  // Reprise automatique : comme au premier choix, jamais une source dont la vidéo ou le son ne passe pas dans le navigateur.
  return failoverCandidates(pool, p.view, webCompatContext());
}
