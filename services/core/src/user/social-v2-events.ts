import type { FriendRequestView, FriendView } from './social-v2-store.js';

/**
 * Événements sociaux temps réel. Le serveur les émet après chaque demande, acceptation, suppression d'amitié et
 * changement de présence visible. Le lot « live » (WebSocket `/user/social/live`) s'y branche via `deps.socialEvents` ;
 * ce module ne fait aucune diffusion lui-même.
 *
 * Chaque événement vise une liste de profils destinataires (pid). La vue `friend` / `presence` est celle du destinataire :
 * `household` vaut vrai pour un profil du même compte.
 */
export type SocialEvent =
  | { t: 'request'; request: FriendRequestView }
  | { t: 'friend'; friend: FriendView }
  | { t: 'unfriend'; pid: string }
  | { t: 'presence'; friend: FriendView };

/** Gestionnaire fourni par l'hôte. Appelé de façon synchrone ; ne doit ni attendre ni lever d'exception vers la requête. */
export type SocialEventHandler = (profilePids: readonly string[], event: SocialEvent) => void;

/**
 * Émet un événement vers des destinataires. Sans effet si aucun gestionnaire n'est fourni ou si la liste est vide.
 * Une exception du gestionnaire ne fait jamais échouer la requête qui a déclenché l'événement.
 */
export function emitSocialEvent(handler: SocialEventHandler | undefined, profilePids: readonly string[], event: SocialEvent): void {
  if (handler === undefined || profilePids.length === 0) return;
  try {
    handler(profilePids, event);
  } catch {
    // Le temps réel est une commodité : l'écriture HTTP a déjà réussi.
  }
}
