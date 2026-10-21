/* Messages affichés à l'utilisateur quand un téléchargement échoue dans le navigateur (ODY-199). Le gestionnaire ne porte
 * que des codes (`DownloadErrorCode`) ; l'interface (ODY-204) les traduit ici. Pas de lien, pas de détail technique. */
import type { DownloadErrorCode } from './types';

const WEB_DOWNLOAD_MESSAGES: Record<DownloadErrorCode, string> = {
  link_expired: 'Le lien de ce fichier a expiré et n’a pas pu être renouvelé. Réessaie dans un moment.',
  resolve_failed: 'Aucun lien de téléchargement n’a pu être obtenu pour ce titre. Essaie une autre source.',
  account: 'Ton compte débrideur est indisponible (clé refusée ou abonnement expiré). Vérifie-le dans les réglages.',
  content:
    'Ce fichier ne peut pas être téléchargé depuis le navigateur : son hébergeur refuse l’accès (CORS) ou ne permet pas la lecture par morceaux. Utilise l’application Android ou Windows pour le télécharger.',
  network: 'Le téléchargement est interrompu faute de connexion. Il reprendra là où il s’est arrêté.',
  range_mismatch: 'Le fichier a changé sur le serveur pendant la pause : le téléchargement doit être relancé.',
  quota_exceeded: 'La limite d’espace que tu as choisie est atteinte. Supprime un téléchargement ou augmente la limite pour continuer.',
  store_full:
    'Le navigateur n’a plus de place pour ce téléchargement. Supprime des téléchargements ou libère de l’espace : ce qui est déjà téléchargé reste intact et le téléchargement pourra reprendre.',
  store_failed:
    'Le navigateur refuse d’enregistrer ce téléchargement (navigation privée ou stockage désactivé ?). Essaie hors navigation privée.',
  cancelled: 'Téléchargement annulé.',
};

export const webDownloadErrorMessage = (code: DownloadErrorCode): string => WEB_DOWNLOAD_MESSAGES[code];
