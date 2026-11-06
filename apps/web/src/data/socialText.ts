import { UserApiError } from './userApi';

/* Messages d'erreur lisibles du parrainage, des bibliothèques partagées et des salons (testés). */

/** Message lisible d'une erreur de l'API sociale. */
export function socialErrorText(err: unknown): string {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  switch (err.code) {
    case 'network': return 'lastAddon est injoignable.';
    case 'rate_limited': return 'Trop de tentatives, réessaie dans un instant.';
    case 'kid_profile': return 'Indisponible pour un profil enfant.';
    case 'room_not_found': return 'Ce salon n’existe plus.';
    case 'room_full': return 'Le salon est complet.';
    case 'banned': return 'Tu as été exclu de ce salon.';
    case 'party_unavailable': return 'Les watch parties ne sont pas disponibles sur ce serveur.';
    case 'too_many_rooms': return 'Trois salons ouverts au plus : termine-en un d’abord.';
    case 'player_unavailable': return 'Le lecteur est indisponible : recharge la page.';
    default: return 'Erreur (' + err.code + ').';
  }
}
