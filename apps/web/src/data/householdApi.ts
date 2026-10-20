import { getSession } from './session';
import { call, UserApiError } from './userApi';

/* Client des invitations au foyer de lastAddon (docs/invitations-v3-contract.md, partie A) : un membre adulte du compte
 * invite une personne sur un profil existant ; l'invité crée son identifiant, et sa session est verrouillée sur ce profil.
 * Les erreurs sont des `UserApiError` dont `code` est le code serveur (`login_taken`, `expired`…). */

export type HouseholdTtlHours = 24 | 72 | 168;
export type HouseholdInviteState = 'pending' | 'used' | 'expired' | 'revoked';
export type HouseholdCheckState = 'ok' | 'expired' | 'used' | 'revoked' | 'unknown';

/** Pseudo et avatar d'une personne affichée sur la page d'invitation (même forme que les profils). */
export interface HouseholdPersonDto {
  name: string;
  avatar?: string | null;
}

/** Lien créé : le jeton clair n'est renvoyé qu'ici (le serveur ne garde que son empreinte). */
export interface HouseholdInviteCreatedDto {
  id: string;
  token: string;
  expiresAt: string;
}

export interface HouseholdInviteDto {
  id: string;
  profileId: string;
  profileName: string;
  createdAt: string;
  expiresAt: string;
  state: HouseholdInviteState;
  usedAt?: string | null;
}

export interface HouseholdInvitesDto {
  invites: HouseholdInviteDto[];
  /** Profils du compte qui ont déjà leur propre identifiant (absent : serveur ancien, on déduit des invitations `used`). */
  linkedProfileIds?: string[];
}

/** Réponse de l'ouverture d'un lien (sans consommer le lien). */
export interface HouseholdCheckDto {
  state: HouseholdCheckState;
  inviter?: HouseholdPersonDto;
  profile?: HouseholdPersonDto;
  expiresAt?: string;
  /** Jusqu'à 12 fonds (TMDB/fanart) tirés de la bibliothèque du créateur, sinon vide. */
  backdrops: string[];
}

export interface HouseholdRedeemBody {
  token: string;
  login: string;
  password: string;
  name?: string;
}

/** Session ouverte par la validation du lien : verrouillée sur `profileId`. */
export interface HouseholdRedeemedDto {
  token: string;
  expiresAt: string;
  profileId: string;
}

/**
 * Codes d'erreur connus des routes foyer. Autre code (ou statut sans code) : `other`. Création d'un lien : `principal_profile`,
 * `kid_profile`, `adult_profile_required`, `pin_required`, `invalid_body`, `profile_not_found`, `profile_has_login`.
 * Retrait de l'accès : `no_login` (404), plus les codes de session (`profile_locked`, `pin_required`).
 */
export type HouseholdErrorCode =
  | 'login_taken' | 'weak_password' | 'bad_login' | 'expired' | 'used' | 'revoked' | 'unknown'
  | 'profile_locked' | 'profile_has_login' | 'rate_limited' | 'network'
  | 'principal_profile' | 'kid_profile' | 'adult_profile_required' | 'pin_required' | 'invalid_body' | 'profile_not_found' | 'no_login';

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  'login_taken', 'weak_password', 'bad_login', 'expired', 'used', 'revoked', 'unknown', 'profile_locked', 'profile_has_login', 'rate_limited', 'network',
  'principal_profile', 'kid_profile', 'adult_profile_required', 'pin_required', 'invalid_body', 'profile_not_found', 'no_login',
]);

/** Code d'erreur d'une route foyer, pour l'interface : `other` si l'erreur n'est pas une erreur API connue. */
export function householdErrorCode(err: unknown): HouseholdErrorCode | 'other' {
  if (!(err instanceof UserApiError)) return 'other';
  return KNOWN_CODES.has(err.code) ? (err.code as HouseholdErrorCode) : 'other';
}

const enc = encodeURIComponent;

/**
 * Crée le lien d'invitation d'un profil adulte du compte (un seul lien actif par profil : le précédent est révoqué).
 * `actorProfileId` : profil qui agit (en-tête X-Profile-Id), adulte du compte ; par défaut le profil actif de la session.
 */
export const createHouseholdInvite = (profileId: string, ttlHours?: HouseholdTtlHours, actorProfileId?: string) => {
  const actor = actorProfileId || getSession()?.profileId || profileId;
  return call<HouseholdInviteCreatedDto>('/profiles/' + enc(profileId) + '/household-invite', {
    method: 'POST',
    body: { ttlHours },
    profileId: actor,
    headers: { 'x-profile-id': actor },
  });
};

/**
 * Retire l'accès d'un profil : supprime son identifiant (le profil et sa bibliothèque restent, ses appareils sont déconnectés).
 * `DELETE /user/profiles/:id/login` → 204 ; 404 `no_login` si le profil n'a pas d'identifiant. `actorProfileId` : profil adulte
 * qui agit (en-tête X-Profile-Id) ; par défaut le profil actif de la session.
 */
export const removeProfileLogin = (profileId: string, actorProfileId?: string) => {
  const actor = actorProfileId || getSession()?.profileId || profileId;
  return call<void>('/profiles/' + enc(profileId) + '/login', {
    method: 'DELETE',
    profileId: actor,
    headers: { 'x-profile-id': actor },
  });
};

/** Invitations du foyer du compte des 30 derniers jours. */
export const listHouseholdInvites = () => call<HouseholdInvitesDto>('/household-invites');

/** Révoque un lien (sans effet sur un identifiant déjà créé). */
export const revokeHouseholdInvite = (id: string) => call<void>('/household-invites/' + enc(id), { method: 'DELETE' });

/** Ouvre un lien pour l'afficher (anonyme) : ne consomme rien. */
export const checkHouseholdInvite = (token: string) =>
  call<HouseholdCheckDto>('/household-invites/check?token=' + enc(token), { anonymous: true });

/** Valide le lien et crée l'identifiant de l'invité (anonyme) : renvoie la session verrouillée sur le profil. */
export const redeemHouseholdInvite = (body: HouseholdRedeemBody) =>
  call<HouseholdRedeemedDto>('/household-invites/redeem', {
    method: 'POST',
    body: { token: body.token, login: body.login, password: body.password, ...(body.name !== undefined ? { name: body.name } : {}) },
    anonymous: true,
  });
