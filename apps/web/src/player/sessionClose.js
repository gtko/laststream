/* Fermeture du lecteur. */
import { emitDataEvent } from '../data/events';
import { showRatePrompt } from '../ui/rate.js';
import { onWatched } from '../downloads/afterWatch';
import { setShellFullscreen, setShellPip } from './shell';
import { partyBridge } from '../party/bridge';
import { setPresenceMedia } from './presenceV2';
import { releaseLocal, stopWebAudio } from './sessionPlay.js';
import { stopNotes, stopSocialPlayback } from './sessionSocial.js';
import { S } from './sessionState.js';
import { saveProgress, stopTicks } from './sessionTick.js';
import { stopAutoSync } from './sessionTracks.js';
import { resetMini } from './sessionUi.js';


// ---------- Fermeture ----------

export async function teardown(silent) {
  const p = S.P;
  if (!p) return;
  stopNotes(p);
  if (S.bubble) S.bubble.stop();
  stopSocialPlayback(silent);
  if (!silent) S.nativeMini = false;
  resetMini();
  saveProgress(true);
  stopTicks();
  clearTimeout(p.resumeTimer);
  if (p.race) { p.race.cancel(); p.race = null; } // fermeture pendant « Préparation du lien » : les candidats ne courent plus
  stopAutoSync();
  if (S.thumbs) S.thumbs.reset();
  if (S.feed) S.feed.reset();
  if (S.rangeFeed) S.rangeFeed.reset();
  stopWebAudio(p);
  try { if (silent && p.engine.kind === 'native') p.engine.detach(); else p.engine.destroy(); } catch (_) { /* ignoré */ }
  releaseLocal(p);
  if (p.deleteAfterWatch) { const d = p.deleteAfterWatch; p.deleteAfterWatch = null; void onWatched(d.key, d.season, d.episode).catch(() => {}); }
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); } catch (_) { /* ignoré */ } }
  S.P = null;
  emitDataEvent({ kind: 'player' }); // l'accueil rattrape les changements faits pendant la lecture
  partyBridge.sessionClosed(silent);
  if (!silent) {
    setPresenceMedia(null);
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) { /* ignoré */ } }
    S.ui.hide();
    document.body.classList.remove('modal-open', 'lp-open');
  }
}

export function closePlayer() {
  if (!S.P) return;
  // Fenêtre de la coque restée en plein écran : on la rend à sa taille normale en quittant le lecteur.
  if (S.shell && S.shellFullscreen) { S.shellFullscreen = false; setShellFullscreen(S.shell, false); }
  if (S.shell && S.shellPip) setShellPip(S.shell, false);
  const p = S.P;
  const watched = p.watchedMarked;
  const key = p.req.key;
  const opener = p.opener;
  teardown(false).then(() => {
    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    if (watched && !p.finished && !p.addon) setTimeout(() => showRatePrompt(key), 600); // titre d'addon : pas de note
  });
}

export const isPlayerOpen = () => !!S.P;
