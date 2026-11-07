/* Pastille du nombre de téléchargements en cours (ODY-234), à jour sur toutes les vues : accueil, bibliothèque, barre du haut.
 * Abonnement unique au gestionnaire, démarré au lancement et jamais libéré par le routeur (la visite de #/downloads le libère
 * seulement pour sa liste). Ne repeint que si le compte change. Rien hors profil autorisé ni sans téléchargements sur la plateforme.
 * Note : s'abonner démarre le gestionnaire dès le lancement (reprise des transferts inachevés), d'où la condition. */
import { platformAvailability, subscribeDownloads } from '../downloads/service';
import { activeCount, downloadsAllowed, paintDlBadges } from './downloadBtn.js';

let started = false;
/** Dernier nombre de téléchargements en cours peint : une notification au même compte ne touche pas le DOM. */
let shown = null;

const available = () => {
  try { return platformAvailability().ok; } catch (_) { return false; }
};

function onItems(items) {
  const n = activeCount(items);
  if (n === shown) return;
  shown = n;
  paintDlBadges(items);
}

/** Démarre l'abonnement permanent (idempotent) ; sans effet sur un profil enfant ou une plateforme sans téléchargements. */
export function startDlBadgeWatch() {
  if (started || !downloadsAllowed() || !available()) return;
  started = true;
  subscribeDownloads(onItems);
}
