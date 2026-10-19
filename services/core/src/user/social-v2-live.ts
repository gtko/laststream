import type { SocialEvent } from './social-v2-events.js';
import {
  type FriendRequestView,
  type FriendView,
  type Handle,
  type MediaRef,
  type MessageView,
  type NoteView,
  type PollView,
  type ReactionView,
  type SubjectView,
  normalizeMedia,
  normalizeWatching,
} from './social-v2-store.js';

/**
 * Flux temps réel social (contrat « WebSocket temps réel ») : traduction pure d'un événement social en trames JSON, et
 * lecture des trames client. Aucun accès aux données ici : les vues (amis, demandes) sont celles que l'émetteur a déjà
 * calculées pour son groupe de destinataires (drapeau « foyer » posé par social-v2-routes, statut invisible vu hors
 * ligne et sans titre par le store). Chaque forme ne reprend que les champs du contrat : aucun identifiant interne.
 */

/** Chemin de la mise à niveau WebSocket, obtenu par POST /user/social/live-ticket. */
export const SOCIAL_LIVE_PATH = '/user/social/live';
/**
 * En-tête interne posé par le Worker après vérification du ticket (profil = pid vérifié). Le client ne peut pas le
 * forger : le Worker l'écrase toujours. Seul le Durable Object des données lit cet en-tête.
 */
export const SOCIAL_LIVE_PID_HEADER = 'x-social-live-pid';
/** En-têtes internes (écrasés par le Worker) : nonce et échéance (ms) du ticket, pour son usage unique. */
export const SOCIAL_LIVE_NONCE_HEADER = 'x-social-live-nonce';
export const SOCIAL_LIVE_EXP_HEADER = 'x-social-live-exp';
/** Taille maximale d'une trame client, en caractères. Au-delà, la connexion est fermée (4013). */
export const SOCIAL_LIVE_MAX_FRAME_CHARS = 1024;
/** Code de fermeture d'une connexion remplacée par une plus récente du même profil. */
export const SOCIAL_LIVE_REPLACED = 4000;
/** Code de fermeture d'une connexion qui dépasse le débit de trames autorisé. */
export const SOCIAL_LIVE_RATE_LIMITED = 4008;
/**
 * Code de fermeture d'une trame client trop grande. Un code applicatif (4000-4999) : les codes standard comme 1009 ne
 * peuvent pas être envoyés par `WebSocket.close` dans l'exécution Workers.
 */
export const SOCIAL_LIVE_FRAME_TOO_LARGE = 4013;
/**
 * Code de fermeture d'une trame non texte (binaire). Applicatif lui aussi : 1003 (« données non acceptables ») est refusé
 * par workerd, qui n'admet que 1000 et 3000-4999 (voir le commentaire de 4013).
 */
export const SOCIAL_LIVE_BINARY_FRAME = 4003;

/** Trame sortante du contrat, telle qu'un client la reçoit. */
export type LiveFrame =
  | { t: 'message'; message: MessageView }
  | { t: 'read'; pid: string; at: number }
  | { t: 'presence'; friend: FriendView }
  | { t: 'request'; request: FriendRequestView }
  | { t: 'friend'; friend: FriendView }
  | { t: 'unfriend'; pid: string }
  | { t: 'note'; media: MediaRef; note: NoteView }
  | { t: 'reaction'; conv: string; id: string; reactions: ReactionView[] }
  | { t: 'poll'; conv: string; poll: PollView }
  | { t: 'typing'; conv: string; pid: string };

/** Trame à remettre à un profil : sa destination et le texte JSON exact. */
export interface LiveEnvelope {
  pid: string;
  frame: string;
}

function handleOut(handle: Handle): Handle {
  return { name: handle.name, tag: handle.tag, full: handle.full };
}

function subjectOut(view: SubjectView): SubjectView {
  const out: SubjectView = { pid: view.pid, handle: handleOut(view.handle), avatarColor: view.avatarColor, status: view.status };
  // Hors ligne (dont le mode invisible) : jamais de titre en cours.
  if (view.status !== 'offline' && view.watching !== undefined) out.watching = normalizeWatching(view.watching);
  if (view.lastSeen !== undefined) out.lastSeen = view.lastSeen;
  return out;
}

function friendOut(view: FriendView): FriendView {
  return { ...subjectOut(view), household: view.household === true };
}

function requestOut(view: FriendRequestView): FriendRequestView {
  return { pid: view.pid, handle: handleOut(view.handle), avatarColor: view.avatarColor, createdAt: view.createdAt };
}

function reactionOut(view: ReactionView): ReactionView {
  return { emoji: view.emoji, count: view.count, mine: view.mine };
}

function pollOut(view: PollView): PollView {
  return {
    id: view.id,
    question: view.question,
    closed: view.closed,
    options: view.options.map((option) => ({ id: option.id, label: option.label, votes: option.votes, mine: option.mine })),
  };
}

function messageOut(view: MessageView): MessageView {
  const out: MessageView = {
    id: view.id,
    conv: view.conv,
    from: view.from,
    kind: view.kind,
    body: view.body,
    reactions: view.reactions.map(reactionOut),
    createdAt: view.createdAt,
  };
  if (view.to !== undefined) out.to = view.to;
  if (view.context !== undefined) out.context = { ...normalizeMedia(view.context), ...(view.context.pos === undefined ? {} : { pos: view.context.pos }) };
  if (view.title !== undefined) out.title = { ...view.title };
  if (view.moment !== undefined) out.moment = { ...view.moment };
  if (view.party !== undefined) out.party = { ...view.party };
  if (view.poll !== undefined) out.poll = pollOut(view.poll);
  if (view.replyTo !== undefined) out.replyTo = view.replyTo;
  if (view.readAt !== undefined) out.readAt = view.readAt;
  return out;
}

function noteOut(view: NoteView): NoteView {
  return {
    id: view.id,
    author: { pid: view.author.pid, handle: handleOut(view.author.handle), avatarColor: view.author.avatarColor },
    pos: view.pos,
    kind: view.kind,
    body: view.body,
    createdAt: view.createdAt,
  };
}

/** Trame du contrat pour un événement (sans destinataire). */
export function liveFrame(event: SocialEvent): LiveFrame {
  switch (event.t) {
    case 'message':
      return { t: 'message', message: messageOut(event.message) };
    case 'read':
      return { t: 'read', pid: event.pid, at: event.at };
    case 'presence':
      return { t: 'presence', friend: friendOut(event.friend) };
    case 'request':
      return { t: 'request', request: requestOut(event.request) };
    case 'friend':
      return { t: 'friend', friend: friendOut(event.friend) };
    case 'unfriend':
      return { t: 'unfriend', pid: event.pid };
    case 'note':
      return { t: 'note', media: normalizeMedia(event.media), note: noteOut(event.note) };
    case 'reaction':
      return { t: 'reaction', conv: event.conv, id: event.id, reactions: event.reactions.map(reactionOut) };
    case 'poll':
      return { t: 'poll', conv: event.conv, poll: pollOut(event.poll) };
    case 'typing':
      return { t: 'typing', conv: event.conv, pid: event.pid };
  }
}

/**
 * Trames à remettre : une par profil de l'audience (sans doublon), toutes identiques. Audience vide : aucune trame.
 */
export function liveEnvelopes(audience: readonly string[], event: SocialEvent): LiveEnvelope[] {
  if (audience.length === 0) return [];
  const frame = JSON.stringify(liveFrame(event));
  return [...new Set(audience)].map((pid) => ({ pid, frame }));
}

/** Trame de réponse au ping client. */
export const LIVE_PONG_FRAME = JSON.stringify({ t: 'pong' });

/** Vrai si la trame client dépasse la taille autorisée. */
export function isOversizedLiveFrame(raw: string): boolean {
  return raw.length > SOCIAL_LIVE_MAX_FRAME_CHARS;
}

/**
 * Lit une trame client. Seul `{ "t": "ping" }` (exactement cette clé) est reconnu ; toute autre trame, mal formée ou non
 * objet, est ignorée (`undefined`).
 */
export function parseLiveClientFrame(raw: string): 'ping' | undefined {
  if (isOversizedLiveFrame(raw)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 && (value as { t?: unknown }).t === 'ping' ? 'ping' : undefined;
}
