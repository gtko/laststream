import { randomBytes } from 'node:crypto';

/**
 * Invitations sur un profil du foyer (contrat invitations v3, partie A) : un membre adulte du compte crée un lien pour un
 * profil existant ; l'invité crée son identifiant et sa session est verrouillée sur ce profil. Constantes, états et
 * types partagés par le store (UserStore) et les routes ; aucune I/O ici.
 */

/** Durées acceptées du lien, en heures. */
export const HOUSEHOLD_TTL_HOURS = [24, 72, 168] as const;
export type HouseholdTtlHours = (typeof HOUSEHOLD_TTL_HOURS)[number];
export const HOUSEHOLD_DEFAULT_TTL_HOURS: HouseholdTtlHours = 72;

/** Fenêtre de la liste « Invitations du foyer ». */
export const HOUSEHOLD_LIST_DAYS = 30;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const householdTtlMs = (ttlHours: HouseholdTtlHours): number => ttlHours * HOUR_MS;
export const householdListSinceMs = (now: number): number => now - HOUSEHOLD_LIST_DAYS * DAY_MS;

/** Jeton d'invitation : 32 octets aléatoires, base64url. Le clair ne sort qu'une fois, dans la réponse de création. */
export function generateHouseholdToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Identifiant court du lien (pour l'interface et l'annulation). */
export function generateHouseholdId(): string {
  return randomBytes(9).toString('base64url');
}

/** Forme attendue d'un jeton (32 octets en base64url = 43 caractères). */
export const HOUSEHOLD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** État d'un lien dans la liste du créateur. Ordre : utilisé, révoqué, expiré, puis en attente. */
export type HouseholdState = 'pending' | 'used' | 'expired' | 'revoked';

/** État renvoyé à l'invité qui ouvre le lien (`ok` = utilisable). */
export type HouseholdCheckState = 'ok' | 'expired' | 'used' | 'revoked' | 'unknown';

export interface HouseholdTimes {
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export function householdStateOf(link: HouseholdTimes, now: number): HouseholdState {
  if (link.usedAt !== null) return 'used';
  if (link.revokedAt !== null) return 'revoked';
  if (link.expiresAt <= now) return 'expired';
  return 'pending';
}

export function householdCheckStateOf(link: HouseholdTimes, now: number): Exclude<HouseholdCheckState, 'unknown'> {
  const state = householdStateOf(link, now);
  return state === 'pending' ? 'ok' : state;
}

/** Écriture d'un lien (les horodatages sont en ms epoch). */
export interface HouseholdInviteWrite {
  id: string;
  tokenHash: string;
  accountId: string;
  profileId: string;
  createdByProfile: string;
  createdAt: number;
  expiresAt: number;
}

export type HouseholdCreateResult = { ok: true } | { ok: false; reason: 'profile_has_login' };

/** Ligne de la liste du créateur : lien et nom du profil invité. */
export interface HouseholdInviteRow extends HouseholdTimes {
  id: string;
  profileId: string;
  profileName: string;
  createdAt: number;
}

/** Lien vu par son jeton (vérification anonyme) : profil invité, créateur et bibliothèque du créateur. */
export interface HouseholdInviteView extends HouseholdTimes {
  id: string;
  accountId: string;
  profileId: string;
  profileName: string;
  profileAvatar: string | null;
  profileAvatarColor: string;
  createdByProfile: string | null;
  inviterName: string | null;
  inviterAvatar: string | null;
  inviterAvatarColor: string | null;
}

export type HouseholdRedeemResult =
  | { ok: true; accountId: string; profileId: string }
  | { ok: false; reason: 'unknown' | 'used' | 'revoked' | 'expired' | 'login_taken' | 'account_suspended' };

export interface HouseholdRedeemInput {
  tokenHash: string;
  login: string;
  passwordHash: string;
  /** Nom choisi par l'invité (aucun changement si null). */
  name: string | null;
  sessionHash: string;
  /** Instant de l'utilisation (ms epoch). */
  now: number;
  /** Échéance de la session verrouillée (ISO 8601 UTC, comme les autres sessions). */
  sessionExpiresAt: string;
  userAgent?: string | null;
}

/** Login de profil (connexion par identifiant de profil). */
export interface ProfileLoginRecord {
  login: string;
  passwordHash: string;
  accountId: string;
  profileId: string;
  isOwner: boolean;
  suspended: boolean;
}
