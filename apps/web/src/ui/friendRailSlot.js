/* Rail d'amis de l'accueil (LAST-193) : emplacement posé par le gabarit de l'accueil, rempli par friendRail.js chargé à la demande
 * (illustrations d'avatars et formats sociaux hors du premier chargement). Compte connecté, jamais sur un profil enfant. */
import { socialAvailable } from './socialButton.js';

/** Emplacement du rail (aside fixe à droite, masqué sur mobile par le CSS) ; chaîne vide si le social n'est pas disponible. */
export const railSlotHTML = () => (socialAvailable() ? '<aside id="friend-rail" class="friend-rail" aria-label="Amis"></aside>' : '');

/** Rangée d'avatars en haut de l'accueil mobile (le rail est masqué sous 768 px) ; masquée par le CSS dès 768 px. */
export const stripSlotHTML = () => (socialAvailable() ? '<nav id="friend-strip" class="friend-strip" aria-label="Amis"></nav>' : '');

/** Remplit le rail affiché et le tient à jour avec le store social. */
export function mountRail() {
  if (!document.getElementById('friend-rail') && !document.getElementById('friend-strip')) return;
  void import('./friendRail.js').then((m) => m.paintRail()).catch(() => undefined);
}
