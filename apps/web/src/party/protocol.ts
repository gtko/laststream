import { MAX_FRAME_BYTES } from '@laststream/protocol/party';
import type { ClientMessage, Fingerprint, ServerMessage } from '@laststream/protocol/party';

/* Messages JSON du salon (WebSocket /party/:id/ws), une trame = un message de 4 Ko au plus.
 * Constantes, objets échangés et unions ServerMsg / ClientMsg : source unique dans @laststream/protocol (partagée avec lastaddon). */

export {
  COUNTDOWN_DEFAULT_SEC,
  CHAT_MAX_CHARS,
  DEFAULT_SETTINGS,
  MAX_FRAME_BYTES,
  PARTY_RESUME_AHEAD_SEC,
  PARTY_WAIT_MAX_MS,
  REACTIONS,
  VOTE_MAX_OPTIONS,
} from '@laststream/protocol/party';
export type {
  ChatLine,
  ControlMode,
  EventKind,
  PartySettings,
  PrepStatus,
  ReactionMode,
  VoteInput,
  VoteView,
  WaitLateMode,
} from '@laststream/protocol/party';

/** Avance de tampon acceptée par le serveur (secondes) ; au-delà, le client la ramène à cette valeur. */
export const PARTY_BUF_AHEAD_MAX_SEC = 600;

/** Joueur local tel que le serveur l'annonce dans `welcome`. */
export type You = Extract<ServerMessage, { t: 'welcome' }>['you'];

/** Messages du serveur et du client : unions de @laststream/protocol (sans la signalisation WebRTC, relayée à part) ; `pos`, `fingerprint` et `reason` restent omis de la trame quand ils sont inconnus (un serveur antérieur ne les lit pas). */
export type ServerMsg = ServerMessage;
export type ClientMsg = Exclude<ClientMessage, { t: 'rtc' }> extends infer M
  ? M extends { t: 'chat' | 'react' } ? Omit<M, 'pos'> & { pos?: number | null }
    : M extends { t: 'episode' } ? Omit<M, 'fingerprint'> & { fingerprint?: Fingerprint | null }
    : M extends { t: 'report' } ? Omit<M, 'reason'> & { reason?: string | null }
    : M
  : never;

const SERVER_TYPES = new Set(['welcome', 'pong', 'state', 'media', 'join', 'leave', 'chat', 'react', 'settings', 'prep', 'countdown', 'vote', 'event', 'muted', 'host', 'reported', 'removed', 'wait', 'link_renewed', 'error', 'ended']);

/** Message serveur d'une trame texte, ou null si elle est illisible ou d'un type inconnu. */
export function parseServerMessage(raw: unknown): ServerMsg | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const t = (v as { t?: unknown }).t;
  return typeof t === 'string' && SERVER_TYPES.has(t) ? (v as ServerMsg) : null;
}

/** Signalisation WebRTC relayée par le salon (`{type:'rtc',from,data}`), ou null si la trame n'en est pas une. */
export function parseRtcFrame(raw: unknown): { from: string; data: unknown } | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { type?: unknown; from?: unknown; data?: unknown };
  return o.type === 'rtc' && typeof o.from === 'string' && o.data !== undefined ? { from: o.from, data: o.data } : null;
}

/** Trame à envoyer ; null si elle dépasse 4 Ko (le serveur fermerait la connexion). */
export function encodeClientMessage(msg: ClientMsg): string | null {
  const s = JSON.stringify(msg);
  return new TextEncoder().encode(s).length <= MAX_FRAME_BYTES ? s : null;
}

/** Codes de fermeture après lesquels on ne se reconnecte pas. */
export const FINAL_CLOSE_CODES: Readonly<Record<number, 'ended' | 'expired' | 'kicked' | 'banned' | 'replaced' | 'full' | 'name_taken' | 'name_changed'>> = {
  4000: 'ended', 4001: 'expired', 4003: 'kicked', 4004: 'banned', 4009: 'replaced', 4010: 'full', 4011: 'name_taken', 4012: 'name_changed',
};

/** Messages lisibles des erreurs du salon. */
export function partyErrorText(code: string): string {
  switch (code) {
    case 'not_host': return 'Seul l’hôte peut faire ça.';
    case 'muted': return 'Tu as été rendu muet par l’hôte.';
    case 'rate_limited': return 'Trop de messages : ralentis un peu.';
    case 'invalid_message': return 'Message invalide.';
    case 'invalid_reaction': return 'Réaction inconnue.';
    case 'empty_message': return 'Message vide.';
    case 'message_not_found': return 'Message introuvable.';
    case 'cannot_report_self': return 'Tu ne peux pas signaler ton propre message.';
    case 'cannot_target_self': return 'Action impossible sur toi-même.';
    case 'user_not_found': return 'Participant introuvable.';
    case 'not_series': return 'Ce salon ne lit pas une série.';
    case 'already_playing': return 'La lecture a déjà démarré.';
    case 'vote_already_open': return 'Un vote est déjà ouvert.';
    default: return ''; // type ou code inconnu (serveur plus ancien ou plus récent) : ignoré sans bruit
  }
}
