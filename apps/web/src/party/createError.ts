/* Messages humains quand la création d'un salon (watch party) échoue : un texte par code d'erreur du serveur. */
import { UserApiError } from '../data/userApi';

export const PARTY_CREATE_FALLBACK = 'Création du salon impossible pour le moment.';

export function partyCreateErrorText(err: unknown): string {
  if (!(err instanceof UserApiError)) return PARTY_CREATE_FALLBACK;
  if (err.code === 'pin_required') return 'Saisis le code de ton profil pour créer un salon.';
  if (err.code === 'too_many_rooms') return 'Tu as déjà trois salons ouverts : termine-en un d’abord.';
  if (err.code === 'kid_profile') return 'Un profil enfant ne crée que des salons privés.';
  if (err.code === 'network' || err.status === 0) return 'Serveur injoignable : vérifie ta connexion puis réessaie.';
  if (err.code === 'rate_limited' || err.status === 429) return 'Trop de tentatives : réessaie dans un instant.';
  return PARTY_CREATE_FALLBACK;
}
