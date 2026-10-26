import { stripInvisible } from './text.js';
import {
  COUNTDOWN_DEFAULT_SEC,
  COUNTDOWN_MAX_SEC,
  COUNTDOWN_MIN_SEC,
  CONTROL_MODES,
  MAX_FRAME_BYTES,
  PREP_STATUSES,
  QUALITY_MAX,
  REACTION_MODES,
  RTC_MAX_FRAME_CHARS,
  VOTE_MAX_OPTIONS,
  VOTE_MIN_OPTIONS,
  VOTE_TITLE_MAX,
  WAIT_LATE_MODES,
} from '@laststream/protocol/party';
import type {
  ChatLine,
  ClientMessage,
  ControlMode,
  Fingerprint,
  PartyMedia,
  PartySettings,
  PlaybackState,
  PrepState,
  ReactionMode,
  VoteInput,
  VoteOption,
  WaitLateMode,
} from '@laststream/protocol/party';

/**
 * Watch party : le contrat de fil (constantes, messages, objets échangés) vit dans `@laststream/protocol`, partagé avec
 * l'application. Ce module le ré-exporte et garde ce qui est propre au serveur : état persistant du salon, validation
 * des trames client. Le salon ne transporte jamais de lien de lecture ni de donnée debrid.
 */
export * from '@laststream/protocol/party';

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
  /** `profile` : participants identifiés par profil (`<compte>:<profil>`, voir keys.ts) ; absent : par compte (salons anciens). */
  memberKeys?: 'profile';
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
  /** Participants en tampon (ready=false), par clé de compte, dans l'ordre d'arrivée. Vide ou absent hors attente. */
  waiting?: string[];
  /** Début de l'attente de tampon (ms serveur), null hors attente. */
  waitSince?: number | null;
  /** Lecture suspendue par l'attente, à reprendre à sa fin (aussi vrai pour une lecture demandée pendant l'attente). */
  heldByWait?: boolean;
  /** Retardataires retirés par le délai de l'attente, pas encore prêts : leurs déclarations « pas prêt » ne rouvrent pas l'attente (levée par ready, départ, exclusion ou seek). */
  waitTimedOut?: string[];
  /** Réglages de l'hôte (absent : défauts DEFAULT_SETTINGS). */
  settings?: PartySettings;
  /** Préparation déclarée par participant (clé de compte) ; retirée au départ. */
  prep?: Record<string, PrepState>;
  /** Démarrage programmé (ms serveur) : la lecture reprend à cet instant. Null hors compte à rebours. */
  countdownAt?: number | null;
  /** Vote du titre en cours ; null hors vote. */
  vote?: VoteState | null;
  /** Entrées d'invités par le lien partagé : instants (ms) de la fenêtre de débit, conservés avec le salon (survivent à l'éviction du Durable Object). */
  entryHits?: number[];
  /** Jetons de séance obtenus mais pas encore connectés : clé `guest:<id>` -> instant de réservation (ms). Ils comptent dans les plafonds RESERVATION_MS. */
  guestReserved?: Record<string, number>;
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

/** Vote ouvert : options et choix de chaque compte (clé de compte -> identifiant d'option). */
export interface VoteState {
  options: VoteOption[];
  choices: Record<string, string>;
}

const MAX_POS = 1_000_000;
const AHEAD_MAX_SEC = 600;

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

/** Valeur parmi une liste fermée, ou undefined. */
function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Position optionnelle (s) : null si absente, undefined si invalide. */
function optionalPos(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return finiteNumber(value, 0, MAX_POS);
}

/** Qualité déclarée : texte nettoyé et borné, null si vide ou absente, undefined si d'un autre type. */
function parseQuality(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const clean = stripInvisible(value).trim().slice(0, QUALITY_MAX);
  return clean === '' ? null : clean;
}

/** Option de vote : type, identifiant TMDB entier et titre ; undefined si invalide. */
function parseVoteInput(raw: unknown): VoteInput | undefined {
  if (!isRecord(raw)) return undefined;
  const type = oneOf(raw.type, ['movie', 'series'] as const);
  const tmdbId = finiteNumber(raw.tmdbId, 1, 1_000_000_000);
  const title = typeof raw.title === 'string' ? stripInvisible(raw.title).trim().slice(0, VOTE_TITLE_MAX) : '';
  if (type === undefined || tmdbId === undefined || !Number.isInteger(tmdbId) || title === '') return undefined;
  return { type, tmdbId, title };
}

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
    case 'buf': {
      const ahead = finiteNumber(raw.ahead, 0, AHEAD_MAX_SEC);
      return typeof raw.ready === 'boolean' && ahead !== undefined ? { t: 'buf', ready: raw.ready, ahead } : undefined;
    }
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
    case 'chat': {
      const pos = optionalPos(raw.pos);
      return typeof raw.text === 'string' && pos !== undefined ? { t: 'chat', text: raw.text, pos } : undefined;
    }
    case 'react': {
      const pos = optionalPos(raw.pos);
      return typeof raw.emoji === 'string' && pos !== undefined ? { t: 'react', emoji: raw.emoji, pos } : undefined;
    }
    case 'settings': {
      const patch: { control?: ControlMode; waitLate?: WaitLateMode; reactions?: ReactionMode } = {};
      if (raw.control !== undefined) {
        const control = oneOf(raw.control, CONTROL_MODES);
        if (control === undefined) return undefined;
        patch.control = control;
      }
      if (raw.waitLate !== undefined) {
        const waitLate = oneOf(raw.waitLate, WAIT_LATE_MODES);
        if (waitLate === undefined) return undefined;
        patch.waitLate = waitLate;
      }
      if (raw.reactions !== undefined) {
        const reactions = oneOf(raw.reactions, REACTION_MODES);
        if (reactions === undefined) return undefined;
        patch.reactions = reactions;
      }
      return Object.keys(patch).length > 0 ? { t: 'settings', ...patch } : undefined;
    }
    case 'ready': {
      const quality = parseQuality(raw.quality);
      return typeof raw.ready === 'boolean' && quality !== undefined ? { t: 'ready', ready: raw.ready, quality } : undefined;
    }
    case 'status': {
      const status = oneOf(raw.status, PREP_STATUSES);
      return status === undefined ? undefined : { t: 'status', status };
    }
    case 'start': {
      if (raw.countdown === undefined) return { t: 'start', countdown: COUNTDOWN_DEFAULT_SEC };
      const countdown = finiteNumber(raw.countdown, COUNTDOWN_MIN_SEC, COUNTDOWN_MAX_SEC);
      return countdown === undefined ? undefined : { t: 'start', countdown: Math.round(countdown) };
    }
    case 'vote_open': {
      if (!Array.isArray(raw.options) || raw.options.length < VOTE_MIN_OPTIONS || raw.options.length > VOTE_MAX_OPTIONS) return undefined;
      const options: VoteInput[] = [];
      for (const item of raw.options) {
        const option = parseVoteInput(item);
        if (option === undefined) return undefined;
        options.push(option);
      }
      return { t: 'vote_open', options };
    }
    case 'vote':
      return typeof raw.optionId === 'string' && raw.optionId.length <= 16 ? { t: 'vote', optionId: raw.optionId } : undefined;
    case 'vote_close':
      return { t: 'vote_close' };
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
