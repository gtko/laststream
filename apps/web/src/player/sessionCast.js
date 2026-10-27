/* Chromecast (LAST-347) : bouton « Caster », envoi de la source au téléviseur à la position exacte de la lecture locale,
 * écran « Lecture sur … », progression écrite pendant la diffusion, « Reprendre ici ». Le SDK (./cast) n'est chargé qu'à la
 * première source lue dans un navigateur Chromium ; les décisions (lien envoyable, position, cadence) sont dans ./castLogic. */
import { userStore } from '../data/userStore';
import { getAddonProgress } from '../data/addonUserStore';
import { IMG } from '../ui/constants.js';
import { partyBridge } from '../party/bridge';
import { addonProgressKey } from './addonRequest';
import { castStartPosition, castTarget, castingLabel, createCastProgress } from './castLogic';
import { isOfflineView } from './offlinePlay';
import { isWatched } from './progress';
import { serverBase } from './server';
import { S, headingFor } from './sessionState.js';
import { markWatched, refreshUI, saveProgress, syncTicks } from './sessionTick.js';

/** Un appareil Cast est visible sur le réseau (suivi par le SDK une fois chargé). */
let devices = false;
let watching = false;
/** Module ./cast chargé à la demande (import dynamique : hors du démarrage et du premier chargement du lecteur). */
let castMod = null;
const loadCast = () => import('./cast').then((m) => { castMod = m; return m; });

/** Bouton visible : appareil présent, source lue par le moteur web (mpv et lecteur natif n'existent pas dans Chrome). */
const castUsable = (p) => devices && !!p && !!p.view && !!p.engine && p.engine.kind === 'html' && !!p.mediaUrl;

/**
 * Nouvelle source dans le lecteur : une diffusion en cours s'arrête (le téléviseur lirait l'ancienne), puis le bouton suit la
 * présence d'un appareil. Premier appel : chargement du SDK, sans effet hors navigateur Chromium (bouton caché, aucun script).
 */
export function castSourceChanged(p) {
  if (p.casting) endCasting(p, 'pause');
  S.ui.setCastAvailable(castUsable(p));
  if (watching) return;
  watching = true;
  loadCast().then((m) => m.watchCastAvailability((ok) => {
    devices = ok;
    if (S.ui && S.P) S.ui.setCastAvailable(castUsable(S.P));
  })).catch(() => { watching = false; });
}

/** Progression enregistrée de l'épisode ou du film en cours (repli quand le lecteur local n'a pas de position). */
function savedProgress(p) {
  if (p.addon) {
    const a = getAddonProgress(addonProgressKey(p.addon));
    const same = !a || !a.episode || (a.episode.season === p.cur.season && a.episode.episode === p.cur.episode);
    return a && same ? { position: a.t, duration: a.d } : null;
  }
  return userStore.getProgress(p.req.key, p.cur.season ?? undefined, p.cur.episode ?? undefined);
}

/** Bouton « Caster » : choix de l'appareil (fenêtre de Chrome), chargement sur le téléviseur, pause de la lecture locale. */
async function startCasting() {
  const p = S.P;
  if (!p || !p.view || !p.engine || p.casting || p.castStarting) return;
  if (partyBridge.isActive()) { S.ui.toast('Chromecast indisponible pendant un salon', 4000); return; }
  const target = castTarget({ url: p.mediaUrl, proxied: p.mediaProxied === true, offline: isOfflineView(p.view), serverBase: serverBase() });
  if (!target.ok) { S.ui.toast(target.reason, 6000); return; }
  // Pause dès le clic : la position envoyée est celle de l'image affichée, même si le choix de l'appareil prend du temps.
  const wasPlaying = !p.engine.state().paused;
  try { p.engine.pause(); } catch (_) { /* ignoré */ }
  const st = p.engine.state();
  const startAt = castStartPosition(st.time, savedProgress(p), st.duration);
  const [title, sub] = headingFor(p);
  p.castStarting = true;
  let device;
  try {
    const m = await loadCast();
    device = await m.startCast({
      url: target.url, contentType: target.contentType, startAt, title, subtitle: sub,
      poster: p.meta.poster ? IMG('w342', p.meta.poster) : p.meta.backdrop ? IMG('w780', p.meta.backdrop) : '',
    });
  } catch (e) {
    // Fenêtre de choix fermée : rien à dire. Sinon le téléviseur n'a pas pu ouvrir la source.
    if (S.P === p && wasPlaying) { try { p.engine.play(); } catch (_) { /* ignoré */ } }
    if (!(e && e.code === 'cancel') && S.P === p) S.ui.toast('Envoi vers le Chromecast impossible' + (e && e.code === 'load_failed' ? ' : le téléviseur ne lit pas cette source.' : '.'), 6000);
    return;
  } finally {
    p.castStarting = false;
  }
  if (S.P !== p) { castMod.stopCast(); return; } // lecteur fermé pendant le choix de l'appareil
  saveProgress(true);
  const progress = createCastProgress((time, duration) => { if (S.P === p) saveProgress(true, { time, duration }); });
  p.casting = { device, progress, startAt, unfollow: () => undefined };
  showCasting(p);
  if (target.warn) S.ui.toast(target.warn, 6000);
  const c = p.casting;
  const off = await castMod.followRemote((rs) => onRemote(p, rs), (finished) => onRemoteEnd(p, finished));
  if (p.casting === c) c.unfollow = off; else off(); // diffusion déjà terminée pendant l'abonnement
}

/** Relevé du téléviseur : écran de diffusion, progression (cadence du lecteur local), « vu » à 90 %. */
function onRemote(p, rs) {
  if (S.P !== p || !p.casting) return;
  p.casting.progress.update(rs);
  if (!p.watchedMarked && isWatched(rs.time, rs.duration)) markWatched();
  showCasting(p);
}

/** Session fermée ailleurs (menu de Chrome, téléviseur) ou fin du média : la lecture revient ici, en pause, à la dernière position. */
function onRemoteEnd(p, finished) {
  if (S.P !== p || !p.casting) return;
  const device = p.casting.device;
  endCasting(p, 'pause');
  S.ui.toast(finished ? 'Lecture terminée sur ' + (device || 'le Chromecast') : 'Chromecast déconnecté : lecture en pause ici', 5000);
}

function showCasting(p) {
  const last = p.casting.progress.last();
  S.ui.setCasting({
    label: castingLabel(p.casting.device), time: last ? last.time : p.casting.startAt, duration: last ? last.duration : 0, paused: !!(last && last.paused),
    backdrop: p.meta.backdrop ? IMG('w1280', p.meta.backdrop) : '',
  });
}

/**
 * Fin de la diffusion : progression écrite une dernière fois, récepteur arrêté, lecture locale recalée sur la dernière position
 * du téléviseur. `mode` : 'here' relance la lecture ici (« Reprendre ici »), 'pause' la laisse en pause, 'close' (fermeture du
 * lecteur) ne touche plus au moteur.
 */
export function endCasting(p, mode) {
  const c = p && p.casting;
  if (!c) return;
  c.unfollow();
  c.progress.flush();
  const last = c.progress.last();
  p.casting = null;
  if (castMod) castMod.stopCast();
  if (S.ui) S.ui.setCasting(null);
  if (mode === 'close' || !p.engine || S.P !== p) return;
  const at = last && last.time > 1 ? last.time : c.startAt;
  try {
    p.engine.seek(at);
    if (p.watch) p.watch.reset(Date.now());
    if (mode === 'here') p.engine.play();
  } catch (_) { /* ignoré */ }
  refreshUI();
  syncTicks();
}

/** Lecture sur le téléviseur : les commandes de transport (bouton, Espace, flèches) pilotent le Chromecast. */
export const isCasting = () => !!(S.P && S.P.casting);

export function castTogglePlay() {
  if (castMod) castMod.remoteTogglePlay();
}

export function castSeekBy(d) {
  const last = S.P && S.P.casting ? S.P.casting.progress.last() : null;
  if (!last || !castMod) return;
  castMod.remoteSeek(Math.min(last.duration || Infinity, Math.max(0, last.time + d)));
  S.ui.toast((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900);
}

/** Boutons « Caster », « Pause / Lecture » (écran de diffusion) et « Reprendre ici », routés par onAction (sessionActions). */
export function castAction(act) {
  if (!S.P) return;
  // Bouton « Caster » pendant la diffusion : même effet que « Reprendre ici ».
  if (act === 'cast') { if (S.P.casting) endCasting(S.P, 'here'); else void startCasting(); return; }
  if (!S.P.casting) return;
  if (act === 'cast-toggle') castTogglePlay();
  else if (act === 'cast-here') endCasting(S.P, 'here');
}
