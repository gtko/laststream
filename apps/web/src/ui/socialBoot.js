/* Démarrage du Social, chargé après l'affichage de l'accueil (ou au premier usage d'un hook) : barre des amis, discussions,
 * partage, profil social et salon d'attente. Hors du premier chargement de l'application (LAST-129). */
import '../styles/convwin.css';
import { toast } from './dom.js';
import { mountSocialSidebar, openSidebar, setConversationRenderer, setWatchWithHandler } from './socialSidebar.js';
import { createConversationRenderer } from './socialChat.js';
import { configureSocialConv } from './socialConv.js';
import './socialProfile.js'; // enregistre openProfileEditor (F2) et la page #/social/profile
import './partylobby.js'; // enregistre inviteToParty et openPartyLobby
import { configureShareDialog } from './shareDialog.js';
import { markSocialReady, registerSocialHook } from './socialHooks.js';
import { createWatchWithHandler } from '../data/watchWith';
import { playBest } from '../player/sessionLoader.js';

export { openSidebar };

let booted = null;

/** Branche le Social une seule fois ; la promesse rendue se résout quand les hooks sont enregistrés. */
export function bootSocial() {
  if (!booted) {
    booted = Promise.resolve().then(() => {
      // Discussion et « Regarder avec lui » : la lecture passe par le flux normal du lecteur (source de l'utilisateur).
      const socialLaunch = (request, opener, opts) => Promise.resolve(playBest(request, opener, opts)).catch(() => undefined);
      setConversationRenderer(createConversationRenderer({ launch: socialLaunch, toast }));
      setWatchWithHandler(createWatchWithHandler({ launch: socialLaunch, toast }));
      registerSocialHook('launchPlayback', socialLaunch); // notes d'un ami (ODY-221) : ouvre le titre à la position de la note
      configureSocialConv({ launch: socialLaunch, toast }); // fenêtres de discussion Social v3
      configureShareDialog({ toast }); // fenêtre « Partager » Social v3
      mountSocialSidebar(); // barre des amis, branchée au profil actif ; #/friends l'ouvre
      markSocialReady();
    });
  }
  return booted;
}
