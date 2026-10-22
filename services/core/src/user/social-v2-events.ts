import type { ActivityItem } from './social-v2-activity.js';
import type { FriendRequestView, FriendView, Handle, MediaRef, MessageView, NoteView, PollView, ReactionView } from './social-v2-store.js';

/**
 * Événements sociaux temps réel. Le serveur les émet après chaque écriture : demande, acceptation, suppression d'amitié,
 * changement de présence visible, message, lecture, note, réaction, vote et frappe. Le lot « live » (WebSocket
 * `/user/social/live`) s'y branche via `deps.socialEvents` ; ce module ne fait aucune diffusion lui-même.
 *
 * Chaque événement vise une liste de profils destinataires (pid), passée en premier argument du gestionnaire :
 * - `message` : le destinataire seul (DM), ou les membres sauf l'auteur (groupe) ;
 * - `read` : l'expéditeur des messages lus (`pid` = le lecteur, `at` = instant de lecture, en ms) ;
 * - `note` (pose, modification) et `note_removed` (suppression) : les amis et le foyer de l'auteur ;
 * - `reaction`, `poll`, `typing` : les autres membres de la conversation ;
 * - `join_request` : l'hôte (ami visé) seul, avec la vue du demandeur ;
 * - `join_answer` : le demandeur seul (`pid` = l'hôte qui répond).
 * La vue `friend` / `presence` est celle du destinataire : `household` vaut vrai pour un profil du même compte. Les vues
 * de message, réaction et sondage portent `mine` (et `conv`) du destinataire : l'émetteur les envoie donc un par un.
 */
export type SocialEvent =
  | { t: 'request'; request: FriendRequestView }
  | { t: 'friend'; friend: FriendView }
  | { t: 'unfriend'; pid: string }
  | { t: 'presence'; friend: FriendView }
  | { t: 'message'; message: MessageView }
  | { t: 'read'; pid: string; at: number }
  | { t: 'note'; media: MediaRef; note: NoteView }
  /** Note supprimée par son auteur : `id` de la note, titre où elle était posée. */
  | { t: 'note_removed'; media: MediaRef; id: string }
  /** Liste partagée modifiée (contenu, membres, suppression) : chaque membre la relit. */
  | { t: 'list'; listId: string }
  | { t: 'reaction'; conv: string; id: string; reactions: ReactionView[] }
  | { t: 'poll'; conv: string; poll: PollView }
  | { t: 'typing'; conv: string; pid: string }
  | { t: 'join_request'; from: FriendView }
  | { t: 'join_answer'; pid: string; accept: boolean; partyId?: string }
  /** Invitation à un salon de visionnage (watch party) : `from` = l'ami qui invite, destinataire seul. */
  | { t: 'party_invite'; from: { pid: string; handle: Handle; avatarColor: string; avatar?: string }; partyId: string; title: string }
  // Activité : destinataires fixés par activityLiveAudience (social-v2-activity.ts).
  | { t: 'activity'; item: ActivityItem };

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
