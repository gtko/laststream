/* Connexion lente sur un lien débrideur (LAST-507) : quand mpv se remet souvent en tampon, la connexion est rouverte.
 * Palier 1 : même lien, repris 2 s avant la position ; la piste audio et les sous-titres natifs sont rétablis.
 * Palier 2 : la source est relancée avec un lien neuf du débrideur de l'appareil. Au-delà : rien, le failover prend le relais. */
import { isOfflineView } from './offlinePlay';
import { playView } from './sessionPlay.js';
import { S } from './sessionState.js';

/** Sans verdict lent (réouverture ou verdict ignoré) pendant ce délai, le compteur repart à zéro. */
const REOPEN_WINDOW_MS = 600_000;
/** Écart de position entre deux relevés (1 s) au-delà duquel le saut compte comme un seek. */
const TIME_JUMP_SEC = 3;
/** Réouvertures au-delà desquelles on n'agit plus : le failover prend le relais. */
const REOPEN_MAX_COUNT = 3;
/** Au-delà de ce délai, le drapeau `reopening` tombe même sans reprise visible : le blocage redevient surveillé. */
const REOPEN_MAX_MS = 30_000;
/** Hôtes locaux (serveur de streaming, torrent sur cet appareil) : jamais un lien débrideur. */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** Vrai seulement pour un lien HTTP(S) débridé, lu par mpv, hors serveur local, hors lien relayé par le serveur et hors fichier téléchargé. */
export function reopenEligible(p) {
  if (!p || !p.engine || p.engine.kind !== 'mpv') return false;
  if (typeof p.mediaUrl !== 'string' || !/^https?:\/\//i.test(p.mediaUrl)) return false;
  if (p.mediaProxied === true || isOfflineView(p.view)) return false;
  try { return !LOCAL_HOSTS.includes(new URL(p.mediaUrl).hostname); } catch (_) { return false; }
}

/** Compteur des réouvertures : repart à zéro après REOPEN_WINDOW_MS sans verdict lent. Renvoie le palier (1 ou 2), 0 au-delà. */
function nextPalier(p, now) {
  if (p.reopenLast !== undefined && now - p.reopenLast > REOPEN_WINDOW_MS) p.reopenCount = 0;
  const n = (p.reopenCount || 0) + 1;
  // Verdict ignoré : il compte pour la fenêtre, pour que le compteur ne reparte pas tant que le lien reste lent.
  if (n > REOPEN_MAX_COUNT) { p.reopenLast = now; return 0; }
  p.reopenCount = n;
  p.reopenLast = now;
  return n === REOPEN_MAX_COUNT ? 2 : 1;
}

/** Palier 1 : même lien, repris à `p.reopenFrom`. mpv repart sans sous-titres ni piste audio choisie : on les rétablit. */
async function reloadSameLink(p, now) {
  const eng = p.engine;
  const s = p.subs || {};
  const audio = eng.audioTracks().find((t) => t.selected);
  // Seuls les sous-titres que mpv affiche lui-même (natifs) sont rétablis ; ceux que la page affiche ne bougent pas.
  // Avec les deux sous-titres inversés, le principal est celui de mpv en second.
  const primary = s.native ? (s.swapped && s.native2 ? s.secondaryId : s.selectedId) : null;
  const secondary = s.native2 ? (s.swapped ? s.selectedId : s.secondaryId) : null;
  await eng.load({ url: p.mediaUrl, startAt: p.reopenFrom, backend: p.mpvBackend });
  if (audio) eng.setAudioTrack(audio.id);
  if (primary != null) eng.setSubtitleTrack(primary);
  const second = secondary != null && eng.supportsSecondary() ? secondary : null;
  if (second != null) eng.setSecondarySubtitleTrack(second);
  p.reopenTracks = { audio: audio ? audio.id : null, primary, second, at: now };
  if (p.slowLink) p.slowLink.reset(now);
}

/**
 * Premier événement `tracks` du moteur après le rechargement (palier 1) : mpv peut avoir ignoré les pistes choisies avant que sa
 * liste n'existe. Réapplique une fois celles dont la valeur observée diffère ; attend une liste non vide, et n'agit plus au-delà
 * de REOPEN_MAX_MS.
 */
export function reopenTracksEvent(p, now = Date.now()) {
  const want = p && p.reopenTracks;
  if (!want || !p.engine) return;
  if (now - want.at > REOPEN_MAX_MS) { p.reopenTracks = null; return; }
  const eng = p.engine;
  const audios = eng.audioTracks();
  if (!audios.length) return;
  p.reopenTracks = null;
  const audio = audios.find((t) => t.selected);
  if (want.audio != null && (!audio || String(audio.id) !== String(want.audio))) eng.setAudioTrack(want.audio);
  if (want.primary != null) {
    const sub = eng.subtitleTracks().find((t) => t.selected);
    if (!sub || String(sub.id) !== String(want.primary)) eng.setSubtitleTrack(want.primary);
  }
  // Le moteur ne rapporte pas la piste secondaire : elle est réappliquée une fois, sans comparaison (sans effet si elle est déjà la bonne).
  if (want.second != null) eng.setSecondarySubtitleTrack(want.second);
}

/** Fin de la réouverture : le StallWatch repart de zéro, la pause de rechargement ne doit pas compter comme un blocage. */
function endReopen(p, now) {
  p.reopening = false;
  p.reopenRestarted = false;
  if (p.watch) p.watch.reset(now);
}

/** Le drapeau tombe quand mpv a repris la lecture après le rechargement : la position revient en arrière, puis avance. */
function clearReopen(p, time, now) {
  if (!p.reopening) return;
  if (now - p.reopenAt > REOPEN_MAX_MS) { endReopen(p, now); return; }
  if (!p.reopenRestarted) {
    if (time < p.reopenStale - 1) p.reopenRestarted = true;
    return;
  }
  if (time > p.reopenFrom + 1) endReopen(p, now);
}

/**
 * Réouverture après un verdict « lent » du SlowLinkWatch. Les erreurs sont avalées : en cas d'échec, le StallWatch et le failover
 * reprennent le relais. Renvoie le palier lancé, 0 si rien n'a été fait.
 */
export async function reopenLink(p, now = Date.now()) {
  if (!p || !p.engine) return 0;
  const palier = nextPalier(p, now);
  if (palier === 0) return 0;
  const t = p.engine.state().time;
  Object.assign(p, { reopening: true, reopenAt: now, reopenStale: t, reopenFrom: palier === 1 ? Math.max(0, t - 2) : t, reopenRestarted: false });
  S.ui.toast('Connexion lente, reconnexion…', 3000);
  try {
    if (palier === 1) {
      await reloadSameLink(p, now);
    } else {
      // Même remise à zéro que le bouton « Réessayer » : la source repart comme une nouvelle lecture, avec un lien neuf.
      p.tried = new Set();
      p.attempts = 0;
      await playView(p.view, t, { fresh: true });
    }
  } catch (_) {
    p.reopening = false;
  }
  return palier;
}

/**
 * Relevé de la boucle lente (1 s) : suit la fin de la réouverture, puis le SlowLinkWatch du lien. Renvoie la réouverture lancée, le cas échéant.
 */
export function reopenTick(p, st, now = Date.now()) {
  clearReopen(p, st.time, now);
  const seeking = !!st.seeking;
  const seekEnded = p.reopenSeeking === true && !seeking;
  p.reopenSeeking = seeking;
  // Saut de position depuis le relevé précédent, réouverture comprise (son retour à 0 n'est pas un seek, mais le relevé doit suivre).
  const jumped = typeof p.reopenPos === 'number' && Math.abs(st.time - p.reopenPos) > TIME_JUMP_SEC;
  p.reopenPos = st.time;
  if (!reopenEligible(p) || !p.slowLink || p.reopening || p.reloading || p.failing || p.resumeTimer) return undefined;
  // Recherche terminée, ou saut de position : la mise en tampon qui suit ne compte pas comme un lien lent.
  if (seekEnded || jumped) p.slowLink.seeked(now);
  const verdict = p.slowLink.tick(now, st.time, !!st.buffering, !!(st.paused || seeking || st.ended), st.cacheTime ?? null);
  return verdict === 'reopen' ? reopenLink(p, now) : undefined;
}
