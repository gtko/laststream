/* Lecteur externe : la source s’ouvre dans une autre application (VLC, Infuse…). Écran d’erreur réutilisé. Pas de sonde, pas de moteur,
 * aucune écriture de progression (une entrée sans durée polluerait « Continuer »). Choix du lecteur et schémas : ./external. */
import { S } from './sessionState.js';
import { stopWebAudio } from './sessionPlay.js';
import { currentPlayer, detectPlatform, iosNeedsExternal, isExternalChoice, launch, planLaunch, playerOptions } from './external';
import { getPreferredExternal } from '../data/prefs';
import { mark } from '../ui/watched.js';
import { isOfflineView } from './offlinePlay';
import { webCompatContext } from '../sources/load';
import { webCompatOf } from '../sources/webCompat';
import { formatClock } from './progress';
import { beginExternalWatch, dropExternalWatch, dropPendingExternalWatch, externalDuration, noteExternalLeft, settleExternalWatch } from './externalWatch';
import { t } from '../i18n';

/** Source passant par le serveur (proxy) : son adresse locale n’est pas joignable depuis une autre application. */
const NOTE_PROXY = t('Cette source passe par notre serveur et ne peut pas s’ouvrir dans un lecteur externe. Essaie une autre source.');
/** Avis quand le lecteur externe est écarté pour une source proxifiée hors iPhone et iPad : la lecture reste intégrée. */
export const NOTE_NOT_EXTERNAL = t('Cette source ne s’ouvre pas dans un lecteur externe : lecture intégrée.');
/** Nom court des options sans nom propre. */
const SHORT = { m3u: t('la playlist'), chooser: t('une autre application'), intent: t('une autre application'), system: t('le lecteur par défaut') };
/** Délai après lequel une app absente se signale : la page est restée visible (sinon l’app a pris la main). */
const NOT_INSTALLED_MS = 2000;

let seq = 0;
let timer = 0;
/** Écran courant : session, adresse de la source, lecteur retenu pour cet écran (un choix ponctuel ne change pas le réglage), plateforme,
 *  position estimée au dernier retour (secondes, pour une relance depuis le même écran). */
let cur = null;

const labelOf = (id, platform) => SHORT[id] || (playerOptions(platform).find((o) => o.id === id) || { label: id }).label;

/** Titre de l’écran : le film, ou « S1 · E1 — titre » pour un épisode. */
function screenTitle(p) {
  if (p.req.type === 'tv' && p.cur && p.cur.season != null) {
    const eps = p.episodes && p.episodes.get ? p.episodes.get(p.cur.season) : null;
    const info = eps && eps.find ? eps.find((e) => e.episode === p.cur.episode) : null;
    const name = info ? (info.part ? info.part.title : info.name) : '';
    return 'S' + p.cur.season + ' · E' + p.cur.episode + (name ? ' — ' + name : '');
  }
  return p.meta.title || t('Lecture');
}

/** Choix de lecture externe, au format de `choice` (moteur « external »). */
function choiceFor(playerId, platform, blocked) {
  return {
    engine: 'external', playerId, platform, blocked, viaServer: false,
    label: t('Lecteur externe ({playerId})', { playerId: labelOf(playerId, platform) }), reason: t('La source s’ouvre dans une autre application.'),
  };
}

/**
 * Court-circuit de la préparation, avant la sonde et le moteur : lecteur externe retenu pour cette source, ou null (lecture intégrée).
 * iPhone et iPad, réglage « auto » : une source que Safari ne lit pas (conteneur MKV, AVI…, codec ou son refusés) part au lecteur préféré (VLC).
 */
export function externalPlan(view, media) {
  const platform = detectPlatform();
  let playerId = currentPlayer(platform);
  if (platform === 'ios' && playerId === 'auto') {
    if (!iosNeedsExternal(view, media.url) && browserReads(view)) return null;
    playerId = getPreferredExternal();
  }
  if (!isExternalChoice(playerId)) return null;
  return choiceFor(playerId, platform, media.proxied === true);
}

/** Safari lit-il cette source tout seul (vidéo et son), sans lecteur externe ? */
function browserReads(view) {
  return webCompatOf(view, { ...webCompatContext(), external: null }).level === 'ok';
}

/** Démarre la lecture externe à la place du moteur : aucun moteur, aucune progression, écran externe (ou message si le lien passe par le serveur). */
export function openExternal(p, choice, url) {
  p.engine = null;
  p.choice = choice;
  p.reloading = false;
  p.memStart = false;
  p.partySwitch = false;
  S.ui.video.hidden = true;
  S.ui.root.classList.remove('is-mpv', 'is-video');
  S.ui.setPipAvailable(false);
  S.ui.setCastAvailable(false);
  S.ui.setMarkAvailable(false);
  if (choice.blocked) { showBlocked(p); return; }
  showExternal(p, url, choice.playerId);
}

/** Repli iPhone et iPad (réglage « auto ») : le lecteur intégré refuse le format ou le décodage (media-error 3 ou 4). Renvoie vrai si le repli a pris la main. */
export function externalAfterError(p, message) {
  const platform = detectPlatform();
  if (platform !== 'ios' || currentPlayer(platform) !== 'auto' || !/media-error:[34]\b/.test(message)) return false;
  // Source proxifiée (adresse locale du serveur, inutilisable ailleurs) ou fichier téléchargé : pas d’écran externe, le repli habituel prend la main.
  if (p.mediaProxied === true || isOfflineView(p.view)) return false;
  if (p.engine) { try { if (p.engine.kind === 'native') p.engine.detach(); else p.engine.destroy(); } catch (_) { /* ignoré */ } }
  stopWebAudio(p);
  openExternal(p, choiceFor(getPreferredExternal(), platform, p.mediaProxied === true), p.mediaUrl);
  return true;
}

function showBlocked(p) {
  cur = null;
  clearTimeout(timer);
  S.ui.setLoading(null);
  S.ui.setError(screenTitle(p), NOTE_PROXY, [{ act: 'source', label: t('Essayer une autre source') }, { act: 'close', label: t('Fermer') }]);
}

function showExternal(p, url, playerId) {
  cur = { p, url, playerId, platform: detectPlatform(), position: 0 };
  seq += 1;
  S.ui.setLoading(null);
  renderMain();
  launchNow();
}

/** Autres lecteurs externes proposés sur cette plateforme (ni « auto », ni « intégré », ni le lecteur de l’écran, ni ceux qui manquent). */
function otherPlayers() {
  return playerOptions(cur.platform).filter((o) => isExternalChoice(o.id) && !o.disabled && o.id !== cur.playerId);
}

function renderMain() {
  const { p, playerId, platform } = cur;
  const label = labelOf(playerId, platform);
  const actions = [{ act: 'ext-open', label: t('Ouvrir dans {label}', { label }) }];
  if (otherPlayers().length) actions.push({ act: 'ext-other', label: t('Changer de lecteur') });
  actions.push({ act: 'ext-copy', label: t('Copier le lien') });
  // Titre d’addon : pas de « vu » (il est indexé par id TMDB côté serveur, voir sessionTick).
  if (!p.addon) actions.push({ act: 'ext-seen', label: t('Marquer comme vu') });
  actions.push({ act: 'close', label: t('Fermer') });
  S.ui.setError(screenTitle(p), t('Lecture dans {label}…', { label }), actions);
}

function renderPicker() {
  const actions = otherPlayers().map((o) => ({ act: 'ext-pick:' + o.id, label: o.label }));
  actions.push({ act: 'ext-back', label: t('Retour') });
  S.ui.setError(screenTitle(cur.p), t('Dans quelle application ouvrir cette source ? Le réglage ne change pas.'), actions);
}

function launchNow() {
  const c = cur;
  if (!c) return;
  const sent = launch(planLaunch(c.playerId, c.url, screenTitle(c.p), c.platform));
  clearTimeout(timer);
  if (sent) trackLaunch(c); else dropExternalWatch();
  // iPhone : si la page est encore visible après le délai, l’app n’est sans doute pas installée (au retour de l’app, l’écran reste).
  if (sent && c.platform === 'ios') {
    const mine = seq;
    timer = setTimeout(() => {
      if (mine === seq && S.P === c.p && document.visibilityState === 'visible') S.ui.toast(t('{playerId} n’est peut-être pas installé.', { playerId: labelOf(c.playerId, c.platform) }), 5000);
    }, NOT_INSTALLED_MS);
  }
}

/** Durée de ce qui est lu (secondes) : épisode ou film d’après TMDB, sinon l’estimation de la source, sinon 0. */
function durationOf(p) {
  if (p.req.type === 'tv' && p.cur && p.cur.season != null) {
    const eps = p.episodes && p.episodes.get ? p.episodes.get(p.cur.season) : null;
    const info = eps && eps.find ? eps.find((e) => e.episode === p.cur.episode) : null;
    return externalDuration(info && info.runtime, p.view && p.view.durationSec);
  }
  return externalDuration(p.model && p.model.minutes, p.view && p.view.durationSec);
}

/** Suivi de la lecture externe (position estimée au retour, « vu » à 80 %). Titre d’addon : pas de suivi (progression indexée à part). */
function trackLaunch(c) {
  const p = c.p;
  if (p.addon) { dropExternalWatch(); return; }
  const it = p.meta || {};
  beginExternalWatch({
    key: p.req.key, type: p.req.type, id: Number(p.req.id), title: it.title || '', poster: it.poster || '', backdrop: it.backdrop || '',
    season: p.cur.season != null ? p.cur.season : undefined, episode: p.cur.episode != null ? p.cur.episode : undefined,
  }, durationOf(p), c.position);
}

/** Retour dans l’app après le lecteur externe : enregistre la position estimée, ou le « vu », et le dit. */
function externalReturn() {
  const est = settleExternalWatch();
  if (!est) return;
  const here = !!cur && S.P === cur.p;
  if (here) {
    clearTimeout(timer);
    seq += 1;
    cur.position = est.watched ? 0 : est.position;
    // Écran externe encore ouvert, pas fini : si la personne retourne dans le lecteur, le suivi reprend de cette position.
    if (!est.watched) beginExternalWatch(est.watch.entry, est.watch.duration, est.position);
  }
  if (S.ui) S.ui.toast(est.watched ? t('Marqué comme vu') : t('Reprise enregistrée à {position}', { position: formatClock(est.position) }), 4000);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) noteExternalLeft();
    else externalReturn();
  });
}

async function copyLink() {
  try { await navigator.clipboard.writeText(cur.url); S.ui.toast(t('Lien copié')); } catch (_) { S.ui.toast(t('Copie impossible')); }
}

async function markSeen() {
  const p = cur.p;
  if (p.addon) return;
  const refs = p.req.type === 'tv' && p.cur.season != null ? [{ season: p.cur.season, episode: p.cur.episode }] : null;
  if (await mark(p.req.key, refs, true)) S.ui.toast(t('Marqué comme vu'));
}

/** Fermeture de la session : l’écran externe ne retient plus la session fermée. */
export function forgetExternal() {
  cur = null;
  dropPendingExternalWatch();
}

/** Boutons de l’écran externe, routés par onAction (sessionActions). */
export function externalAction(act) {
  if (!cur || !S.P || S.P !== cur.p) return;
  if (act === 'ext-open') { launchNow(); return; }
  if (act === 'ext-other') { renderPicker(); return; }
  if (act === 'ext-back') { renderMain(); return; }
  if (act.startsWith('ext-pick:')) {
    const id = act.slice('ext-pick:'.length);
    if (!otherPlayers().some((o) => o.id === id)) return;
    cur.playerId = id; // ponctuel : le réglage (préférences) ne change pas
    renderMain();
    launchNow();
    return;
  }
  if (act === 'ext-copy') { void copyLink(); return; }
  if (act === 'ext-seen') void markSeen();
}
