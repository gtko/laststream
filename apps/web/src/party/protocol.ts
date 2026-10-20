import type { Fingerprint, PartyMedia, PartyParticipant, PartyRoom } from '../data/socialApi';
import type { PlaybackState } from './sync';

/* Messages JSON du salon (WebSocket /party/:id/ws), une trame = un message de 4 Ko au plus. */

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉'] as const;
export const CHAT_MAX = 500;
export const MAX_FRAME_BYTES = 4096;
/** Attente de tampon (miroir du serveur) : avance (s) à partir de laquelle un participant se déclare prêt. */
export const PARTY_RESUME_AHEAD_SEC = 10;
/** Attente de tampon (miroir du serveur) : délai maximal (ms) avant reprise sans les retardataires. */
export const PARTY_WAIT_MAX_MS = 45_000;
/** Avance de tampon acceptée par le serveur (secondes) ; au-delà, le client la ramène à cette valeur. */
export const PARTY_BUF_AHEAD_MAX_SEC = 600;

export interface ChatLine {
  id: string;
  from: string;
  text: string;
  at: number;
  /** Position du film (s) au moment de l'envoi, si le serveur la fournit (Social v3). */
  pos?: number;
}

/* Social v3 (S4) : réglages, préparation, compte à rebours, vote, événements. Miroir du protocole du serveur. */
export const PREP_STATUSES = ['searching', 'ready', 'buffering'] as const;
export type PrepStatus = (typeof PREP_STATUSES)[number];
export const CONTROL_MODES = ['all', 'host'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
export const WAIT_LATE_MODES = ['off', '10s', 'always'] as const;
export type WaitLateMode = (typeof WAIT_LATE_MODES)[number];
export const REACTION_MODES = ['float', 'discreet', 'off'] as const;
export type ReactionMode = (typeof REACTION_MODES)[number];
export interface PartySettings {
  control: ControlMode;
  waitLate: WaitLateMode;
  reactions: ReactionMode;
}
/** Défauts du serveur (salon sans réglage, ou serveur antérieur). */
export const DEFAULT_SETTINGS: PartySettings = { control: 'all', waitLate: 'always', reactions: 'float' };
export const COUNTDOWN_DEFAULT_SEC = 5;
export const COUNTDOWN_MIN_SEC = 1;
export const VOTE_MIN_OPTIONS = 2;
export const VOTE_MAX_OPTIONS = 6;
export const EVENT_KINDS = ['pause', 'play', 'seek', 'join', 'leave'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
/** Option d'un vote de titre proposée par l'hôte. */
export interface VoteInput { type: 'movie' | 'series'; tmdbId: number; title: string }
/** Option avec son identifiant et son nombre de voix (aucun votant n'est identifié). */
export interface VoteView extends VoteInput { id: string; votes: number }

export interface You {
  username: string;
  host: boolean;
  muted: boolean;
  /** Identifiant de connexion (cible de la signalisation WebRTC) ; absent des serveurs anciens. */
  peerId?: string;
}

export type ServerMsg =
  | { t: 'welcome'; you: You; room: PartyRoom; state: PlaybackState; serverTime: number; participants: PartyParticipant[]; chat: ChatLine[]; settings?: PartySettings; countdownAt?: number | null; vote?: VoteView[] | null }
  | { t: 'pong'; c: number; s: number }
  | { t: 'state'; state: PlaybackState; serverTime: number; by?: string }
  | { t: 'media'; media: PartyMedia; fingerprint?: Fingerprint | null; state: PlaybackState; serverTime: number }
  | { t: 'join'; participant: PartyParticipant }
  | { t: 'leave'; user: string }
  | { t: 'chat'; line: ChatLine }
  /** Réaction signée (Social v3) : `by` = auteur, `pos` = position du film ; les serveurs antérieurs n'envoient que `user`. */
  | { t: 'react'; user: string; by?: string; emoji: string; at: number; pos?: number | null }
  | { t: 'settings'; settings: PartySettings; by?: string }
  | { t: 'prep'; user: string; ready: boolean; quality: string | null; status: PrepStatus }
  /** Compte à rebours : `at` = instant serveur (ms) où la lecture reprend ; null = annulé. */
  | { t: 'countdown'; at: number | null; by?: string }
  | { t: 'vote'; options: VoteView[]; open: boolean }
  | { t: 'event'; kind: EventKind; by: string; pos: number; delta?: number }
  | { t: 'muted'; user: string; muted: boolean }
  | { t: 'host'; user: string }
  | { t: 'reported'; by?: string; against?: string; text?: string }
  | { t: 'removed'; messageId: string }
  /** Attente de tampon : pseudos des retardataires, début (ms serveur), délai maximal et avance de reprise (s) ; `who` vide = fin. */
  | { t: 'wait'; who: string[]; since: number; maxMs: number; resumeAhead?: number }
  /** À l'hôte seulement : le lien partagé a été renouvelé après l'exclusion d'un invité ; il en redemande la valeur. */
  | { t: 'link_renewed' }
  | { t: 'error'; code: string }
  | { t: 'ended'; reason: string };

export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'sync' }
  | { t: 'ctl'; action: 'play' | 'pause' | 'seek' | 'sync'; pos: number }
  | { t: 'episode'; season: number; episode: number; fingerprint?: Fingerprint }
  | { t: 'chat'; text: string; pos?: number }
  | { t: 'react'; emoji: string; pos?: number }
  | { t: 'settings'; control?: ControlMode; waitLate?: WaitLateMode; reactions?: ReactionMode }
  | { t: 'ready'; ready: boolean; quality: string | null }
  | { t: 'status'; status: PrepStatus }
  | { t: 'start'; countdown: number }
  | { t: 'vote_open'; options: VoteInput[] }
  | { t: 'vote'; optionId: string }
  | { t: 'vote_close' }
  | { t: 'report'; messageId: string; reason?: string }
  | { t: 'mute'; user: string; muted: boolean }
  | { t: 'kick'; user: string }
  | { t: 'transfer'; user: string }
  | { t: 'end' }
  /** Tampon : `ready` = assez d'avance pour lire ; `ahead` = secondes de tampon devant la position (0 à 600). */
  | { t: 'buf'; ready: boolean; ahead: number };

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
    default: return 'Erreur du salon (' + code + ').';
  }
}
