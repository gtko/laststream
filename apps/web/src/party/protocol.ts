import type { Fingerprint, PartyMedia, PartyParticipant, PartyRoom } from '../data/socialApi';
import type { PlaybackState } from './sync';

/* Messages JSON du salon (WebSocket /party/:id/ws), une trame = un message de 4 Ko au plus. */

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉'] as const;
export const CHAT_MAX = 500;
export const MAX_FRAME_BYTES = 4096;

export interface ChatLine {
  id: string;
  from: string;
  text: string;
  at: number;
}

export interface You {
  username: string;
  host: boolean;
  muted: boolean;
}

export type ServerMsg =
  | { t: 'welcome'; you: You; room: PartyRoom; state: PlaybackState; serverTime: number; participants: PartyParticipant[]; chat: ChatLine[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'state'; state: PlaybackState; serverTime: number; by?: string }
  | { t: 'media'; media: PartyMedia; fingerprint?: Fingerprint | null; state: PlaybackState; serverTime: number }
  | { t: 'join'; participant: PartyParticipant }
  | { t: 'leave'; user: string }
  | { t: 'chat'; line: ChatLine }
  | { t: 'react'; user: string; emoji: string; at: number }
  | { t: 'muted'; user: string; muted: boolean }
  | { t: 'host'; user: string }
  | { t: 'reported'; by?: string; against?: string; text?: string }
  | { t: 'error'; code: string }
  | { t: 'ended'; reason: string };

export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'sync' }
  | { t: 'ctl'; action: 'play' | 'pause' | 'seek' | 'sync'; pos: number }
  | { t: 'episode'; season: number; episode: number; fingerprint?: Fingerprint }
  | { t: 'chat'; text: string }
  | { t: 'react'; emoji: string }
  | { t: 'report'; messageId: string; reason?: string }
  | { t: 'mute'; user: string; muted: boolean }
  | { t: 'kick'; user: string }
  | { t: 'transfer'; user: string }
  | { t: 'end' };

const SERVER_TYPES = new Set(['welcome', 'pong', 'state', 'media', 'join', 'leave', 'chat', 'react', 'muted', 'host', 'reported', 'error', 'ended']);

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

/** Trame à envoyer ; null si elle dépasse 4 Ko (le serveur fermerait la connexion). */
export function encodeClientMessage(msg: ClientMsg): string | null {
  const s = JSON.stringify(msg);
  return new TextEncoder().encode(s).length <= MAX_FRAME_BYTES ? s : null;
}

/** Codes de fermeture après lesquels on ne se reconnecte pas. */
export const FINAL_CLOSE_CODES: Readonly<Record<number, 'ended' | 'kicked' | 'replaced' | 'full'>> = {
  4000: 'ended', 4003: 'kicked', 4009: 'replaced', 4010: 'full',
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
    default: return 'Erreur du salon (' + code + ').';
  }
}
