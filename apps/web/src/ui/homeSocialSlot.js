/* Sections sociales de l'accueil (LAST-194) : « Ensemble, ce soir », « Ce que regardent tes amis », « Coups de cœur de tes amis ».
 * Emplacement posé par le gabarit de l'accueil, rempli par homeSocialRows.js chargé à la demande. Compte connecté, jamais sur un
 * profil enfant : aucune requête hors de ce cas. */
import { socialAvailable } from './socialButton.js';

/** Emplacement des trois sections ; chaîne vide si le social n'est pas disponible. */
export const homeSocialSlotHTML = () => (socialAvailable() ? '<div id="social-slot" class="hsr-slot"></div>' : '');

/** Remplit l'emplacement affiché ; un échec de chargement laisse l'accueil sans ces sections. */
export function mountHomeSocial() {
  if (!document.getElementById('social-slot') || !socialAvailable()) return;
  void import('./homeSocialRows.js').then((m) => m.paintHomeSocial()).catch(() => undefined);
}
