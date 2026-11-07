/* Fermeture du lecteur. */
import { emitDataEvent } from '../data/events';
import { showRatePrompt } from '../ui/rate.js';
import { onWatched } from '../downloads/afterWatch';
import { setShellFullscreen, setShellPip } from './shell';
import { partyBridge } from '../party/bridge';
import { setPresenceMedia } from './presenceV2';
import { forgetExternal } from './externalScreen.js';
import { endCasting } from './sessionCast.js';
import { releaseLocal, stopWebAudio } from './sessionPlay.js';
import { stopNotes, stopSocialPlayback } from './sessionSocial.js';
import { S } from './sessionState.js';
import { saveProgress, stopTicks } from './sessionTick.js';
import { stopAutoSync } from './sessionTracks.js';
import { resetMini } from './sessionUi.js';
import * as playerState from './playerState';


// ---------- Fermeture ----------

export async function teardown(silent) {
  const p = S.P;
  if (!p) return;
  const fromMini = S.ui.isMini(); // fermeture depuis la vignette : pas d'animation plein écran
  stopNotes(p);
  if (S.bubble) S.bubble.stop();
  stopSocialPlayback(silent);
  if (!silent) S.nativeMini = false;
  resetMini();
  saveProgress(true);
  endCasting(p, 'close'); // fermeture du lecteur : le Chromecast s'arrête aussi (la progression vient d'être écrite)
  stopTicks();
  clearTimeout(p.resumeTimer);
  if (p.race) { p.race.cancel(); p.race = null; } // fermeture pendant « Préparation du lien » : les candidats ne courent plus
  stopAutoSync();
  if (S.thumbs) S.thumbs.reset();
  if (S.feed) S.feed.reset();
  if (S.rangeFeed) S.rangeFeed.reset();
  stopWebAudio(p);
  forgetExternal();
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
    // Fondu de fermeture : la page réapparaît sous le lecteur, qui s'efface. Une réouverture pendant ce temps reprend la main
    // (hide résout false) : on ne défait alors rien de la nouvelle session.
    if (await S.ui.hide(fromMini)) {
      document.body.classList.remove('modal-open', 'lp-open');
      playerState.set({ open: false, mini: false });
    }
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
    if (!S.P && opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    if (!S.P && watched && !p.finished && !p.addon) setTimeout(() => showRatePrompt(key), 600); // titre d'addon : pas de note
  });
}

export const isPlayerOpen = () => !!S.P;
