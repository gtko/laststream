import { stripInvisible } from './text.js';

/**
 * Watch party : types partagés du salon (état, messages WebSocket) et limites. Le salon ne transporte jamais de lien de
 * lecture ni de donnée debrid : seulement l'identité du titre et l'empreinte de la version préférée par l'hôte ; chaque
 * participant résout sa propre source.
 */

export const DEFAULT_MAX_PARTICIPANTS = 20;
export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS_LIMIT = 20;
export const MAX_ROOMS_PER_HOST = 3;
/** Durée de vie maximale d'un salon, et délai avant suppression d'un salon vide. */
export const ROOM_MAX_AGE_MS = 12 * 3600_000;
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
/** Absence de l'hôte avant qu'un autre participant soit promu hôte. */
export const HOST_GRACE_MS = 60_000;
export const CHAT_MAX_CHARS = 500;
export const CHAT_HISTORY = 50;
export const MAX_REPORTS = 50;
export const MAX_FRAME_BYTES = 4096;
/** Validité du ticket de connexion WebSocket. */
export const TICKET_TTL_MS = 60_000;
/** Durée d'une séance invité (jeton signé délivré par l'hôte ou un membre). */
export const GUEST_SESSION_MS = 12 * 3600_000;
/** Invités sans compte connectés en même temps dans un salon. */
export const MAX_GUESTS = 4;
export const GUEST_NAME_MAX = 24;
/** Signalisation WebRTC : donnée opaque de 16 Ko au plus (UTF-8), trame de 64 Kio au plus. */
export const RTC_MAX_DATA_BYTES = 16 * 1024;
export const RTC_MAX_FRAME_CHARS = 64 * 1024;
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉'] as const;

/** Codes de fermeture WebSocket propres au salon (4000-4999). */
export const CLOSE = {
  /** Salon terminé. */
  ended: 4000,
  /** Jeton d'invité expiré ou invalide. */
  expired: 4001,
  kicked: 4003,
  /** Exclu du salon (refus de reconnexion). */
  banned: 4004,
  rateLimited: 4008,
  replaced: 4009,
  /** Salon plein, ou quatre invités déjà connectés. */
  full: 4010,
  /** Pseudo déjà pris par un autre participant. */
  nameTaken: 4011,
  /** Reconnexion d'une invitation avec un autre pseudo que le premier. */
  nameChanged: 4012,
} as const;

/** Invitations émises par un salon : au plus INVITES_PER_WINDOW par INVITE_WINDOW_MS. */
export const INVITES_PER_WINDOW = 10;
/** Entrées d'invités par le lien partagé : au plus ENTRIES_PER_WINDOW par ENTRY_WINDOW_MS pour le salon (donc pour le lien). */
export const ENTRIES_PER_WINDOW = 30;
export const ENTRY_WINDOW_MS = 10 * 60_000;
export const INVITE_WINDOW_MS = 10 * 60_000;
/** Pseudos d'invités retenus pour la reconnexion (les plus anciens sont oubliés au-delà). */
export const GUEST_NAMES_MAX = 200;

export type MediaType = 'movie' | 'series';

export interface PartyMedia {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
}

/** Empreinte de la version lue par l'hôte (nom de fichier, taille, hash) : chacun choisit la source la plus proche. */
export interface Fingerprint {
  fileName: string | null;
  size: number | null;
  hash: string | null;
}

/** Position de lecture à l'instant serveur `at` (ms) ; `rev` croît à chaque changement. */
export interface PlaybackState {
  playing: boolean;
  pos: number;
  at: number;
  rev: number;
}

export interface RoomMeta {
  id: string;
  visibility: 'private' | 'public';
  hostId: string;
  hostName: string;
  title: string;
  poster: string | null;
  language: string | null;
  media: PartyMedia;
  fingerprint: Fingerprint | null;
  maxParticipants: number;
  createdAt: number;
}

/** Ligne de chat telle que vue des participants : pseudo seulement. */
export interface ChatLine {
  id: string;
  from: string;
  text: string;
  at: number;
}

/** Ligne conservée par le salon : porte aussi l'identifiant du compte (signalements, jamais diffusé). */
export interface StoredChatLine extends ChatLine {
  fromId: string;
}

export interface ReportEntry {
  messageId: string;
  by: string;
  against: string;
  text: string;
  reason: string | null;
  at: number;
}

/** État persistant du salon (le reste vit dans les sockets). */
export interface RoomData {
  meta: RoomMeta;
  state: PlaybackState;
  muted: string[];
  banned: string[];
  /** Quand l'hôte est parti (ms), pour la promotion différée ; null s'il est présent. */
  hostAbsentSince: number | null;
  /** Quand le salon est devenu vide (ms) ; null s'il y a du monde. */
  emptySince: number | null;
  /** Pseudo de chaque invité (clé `guest:<id>`) : une reconnexion avec le même jeton reprend le même pseudo. */
  guestNames?: Record<string, string>;
  /** Génération du lien d'invitation partagé : « Nouveau lien » l'incrémente, ce qui invalide les liens précédents (absent = 0). */
  inviteEpoch?: number;
  /** Invités entrés par le lien partagé (clés `guest:<id>`) : leur exclusion renouvelle le lien. Bornée à GUEST_NAMES_MAX. */
  linkGuests?: string[];
  /** Formes canoniques des pseudos d'invités exclus : refusés à l'entrée et à la connexion. Bornée à GUEST_NAMES_MAX. */
  bannedNames?: string[];
}

export interface Identity {
  /** Compte Laststream, ou `guest:<id>` pour un invité sans compte (clé interne, jamais diffusée). */
  accountId: string;
  username: string;
  avatarColor: string;
  /** Avatar illustré du profil (dicebear:<style>:<graine>), absent s'il n'y en a pas. */
  avatar?: string;
  /** Invité sans compte (jeton de séance) : absent pour un compte. */
  guest?: true;
}

export interface Participant {
  username: string;
  avatarColor: string;
  avatar?: string;
  host: boolean;
  muted: boolean;
  joinedAt: number;
  /** Identifiant de connexion (aléatoire) : cible de la signalisation WebRTC. Renouvelé à chaque connexion. */
  peerId: string;
  /** Présent (true) seulement pour un invité sans compte. */
  guest?: true;
}

/** Vue publique d'un salon (liste, détail, jeton de connexion). */
export interface RoomInfo {
  id: string;
  visibility: 'private' | 'public';
  title: string;
  poster: string | null;
  language: string | null;
  media: PartyMedia;
  fingerprint: Fingerprint | null;
  host: string;
  participants: number;
  maxParticipants: number;
  createdAt: number;
}

// Client -> serveur

export type ClientMessage =
  | { t: 'ping'; c: number }
  | { t: 'sync' }
  | { t: 'ctl'; action: 'play' | 'pause' | 'seek' | 'sync'; pos: number }
  | { t: 'episode'; season: number; episode: number; fingerprint: Fingerprint | null }
  | { t: 'chat'; text: string }
  | { t: 'react'; emoji: string }
  | { t: 'report'; messageId: string; reason: string | null }
  | { t: 'kick'; user: string }
  | { t: 'mute'; user: string; muted: boolean }
  | { t: 'transfer'; user: string }
  | { t: 'end' }
  /** Signalisation WebRTC (fil JSON : `{"type":"rtc","to","data"}`) ; `bytes` = taille UTF-8 de `data`, mesurée à l'analyse. */
  | { t: 'rtc'; to: string; data: Record<string, unknown>; bytes: number };

/** Message de signalisation relayé au seul pair visé (fil JSON : `{"type":"rtc","from","data"}`). */
export interface RtcRelay {
  type: 'rtc';
  from: string;
  data: Record<string, unknown>;
}

// Serveur -> client

export type ServerMessage =
  | { t: 'welcome'; you: { username: string; host: boolean; muted: boolean; peerId: string }; room: Omit<RoomInfo, 'participants'>; state: PlaybackState; serverTime: number; participants: Participant[]; chat: ChatLine[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'state'; state: PlaybackState; serverTime: number; by: string }
  | { t: 'media'; media: PartyMedia; fingerprint: Fingerprint | null; state: PlaybackState; serverTime: number }
  | { t: 'join'; participant: Participant }
  | { t: 'leave'; user: string }
  | { t: 'chat'; line: ChatLine }
  | { t: 'react'; user: string; emoji: string; at: number }
  | { t: 'muted'; user: string; muted: boolean }
  | { t: 'host'; user: string }
  | { t: 'reported'; messageId: string; by?: string; against?: string; text?: string }
  /** Message retiré par la modération du serveur : les clients le masquent. */
  | { t: 'removed'; messageId: string }
  /** À l'hôte seulement : le lien partagé a été renouvelé (exclusion d'un invité entré par ce lien) ; il doit en demander la nouvelle valeur. */
  | { t: 'link_renewed' }
  | { t: 'error'; code: string }
  | { t: 'ended'; reason: string };

const MAX_POS = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** Empreinte saisie par le client : champs bornés, ou null si rien d'exploitable. */
export function parseFingerprint(raw: unknown): Fingerprint | null {
  if (!isRecord(raw)) return null;
  const fileName = typeof raw.fileName === 'string' && raw.fileName.trim() !== '' ? stripInvisible(raw.fileName).trim().slice(0, 260) : null;
  const size = finiteNumber(raw.size, 1, 1e13);
  const hash = typeof raw.hash === 'string' && /^[A-Za-z0-9+/=_-]{8,128}$/.test(raw.hash) ? raw.hash : null;
  if (fileName === null && size === undefined && hash === null) return null;
  return { fileName, size: size === undefined ? null : Math.trunc(size), hash };
}

/** Identifiant de connexion (pair WebRTC) : base64url ou UUID, 1 à 64 caractères. */
const PEER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Décode un message client : `undefined` si la forme est invalide (jamais d'exception). */
export function parseClientMessage(text: string): ClientMessage | undefined {
  if (text.length > RTC_MAX_FRAME_CHARS) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  // Signalisation : seule trame autorisée au-delà de MAX_FRAME_BYTES (la taille de `data` est bornée par le salon).
  if (raw.type === 'rtc') {
    if (typeof raw.to !== 'string' || !PEER_ID.test(raw.to) || !isRecord(raw.data)) return undefined;
    const bytes = new TextEncoder().encode(JSON.stringify(raw.data)).length;
    return { t: 'rtc', to: raw.to, data: raw.data, bytes };
  }
  if (text.length > MAX_FRAME_BYTES || typeof raw.t !== 'string') return undefined;
  switch (raw.t) {
    case 'ping': {
      const c = finiteNumber(raw.c, 0, 1e15);
      return c === undefined ? undefined : { t: 'ping', c };
    }
    case 'sync':
      return { t: 'sync' };
    case 'end':
      return { t: 'end' };
    case 'ctl': {
      const pos = finiteNumber(raw.pos, 0, MAX_POS);
      if (pos === undefined || (raw.action !== 'play' && raw.action !== 'pause' && raw.action !== 'seek' && raw.action !== 'sync')) return undefined;
      return { t: 'ctl', action: raw.action, pos };
    }
    case 'episode': {
      const season = finiteNumber(raw.season, 0, 10_000);
      const episode = finiteNumber(raw.episode, 0, 10_000);
      if (season === undefined || episode === undefined || !Number.isInteger(season) || !Number.isInteger(episode)) return undefined;
      return { t: 'episode', season, episode, fingerprint: parseFingerprint(raw.fingerprint) };
    }
    case 'chat':
      return typeof raw.text === 'string' ? { t: 'chat', text: raw.text } : undefined;
    case 'react':
      return typeof raw.emoji === 'string' ? { t: 'react', emoji: raw.emoji } : undefined;
    case 'report':
      if (typeof raw.messageId !== 'string' || raw.messageId.length > 64) return undefined;
      return { t: 'report', messageId: raw.messageId, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : null };
    case 'kick':
    case 'transfer':
      return typeof raw.user === 'string' && raw.user.length <= 40 ? { t: raw.t, user: raw.user } : undefined;
    case 'mute':
      return typeof raw.user === 'string' && raw.user.length <= 40 && typeof raw.muted === 'boolean' ? { t: 'mute', user: raw.user, muted: raw.muted } : undefined;
    default:
      return undefined;
  }
}
