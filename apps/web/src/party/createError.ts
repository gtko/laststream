/* Messages humains quand la création d'un salon (watch party) échoue : un texte par code d'erreur du serveur. */
import { UserApiError } from '../data/userApi';
import { t } from '../i18n';

export const PARTY_CREATE_FALLBACK = t('Création du salon impossible pour le moment.');

export function partyCreateErrorText(err: unknown): string {
  if (!(err instanceof UserApiError)) return PARTY_CREATE_FALLBACK;
  if (err.code === 'pin_required') return t('Saisis le code de ton profil pour créer un salon.');
  if (err.code === 'too_many_rooms') return t('Tu as déjà trois salons ouverts : termine-en un d’abord.');
  if (err.code === 'kid_profile') return t('Un profil enfant ne crée que des salons privés.');
  if (err.code === 'network' || err.status === 0) return t('Serveur injoignable : vérifie ta connexion puis réessaie.');
  if (err.code === 'rate_limited' || err.status === 429) return t('Trop de tentatives : réessaie dans un instant.');
  return PARTY_CREATE_FALLBACK;
}
