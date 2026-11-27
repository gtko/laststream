import { UserApiError } from './userApi';
import { t } from '../i18n';

/* Messages d'erreur lisibles du parrainage, des bibliothèques partagées et des salons (testés). */

/** Message lisible d'une erreur de l'API sociale. */
export function socialErrorText(err: unknown): string {
  if (!(err instanceof UserApiError)) return t('Une erreur est survenue.');
  switch (err.code) {
    case 'network': return t('lastAddon est injoignable.');
    case 'rate_limited': return t('Trop de tentatives, réessaie dans un instant.');
    case 'kid_profile': return t('Indisponible pour un profil enfant.');
    case 'room_not_found': return t('Ce salon n’existe plus.');
    case 'room_full': return t('Le salon est complet.');
    case 'banned': return t('Tu as été exclu de ce salon.');
    case 'party_unavailable': return t('Les watch parties ne sont pas disponibles sur ce serveur.');
    case 'too_many_rooms': return t('Trois salons ouverts au plus : termine-en un d’abord.');
    case 'player_unavailable': return t('Le lecteur est indisponible : recharge la page.');
    default: return t('Erreur ({code}).', { code: err.code });
  }
}
