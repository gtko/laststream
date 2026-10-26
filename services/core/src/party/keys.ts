import { GUEST_KEY_PREFIX } from './guest.js';

/**
 * Clés de participant d'un salon. Un salon créé avec `meta.memberKeys === 'profile'` identifie chaque participant par son
 * profil (`<compte>:<profil>`), si bien que plusieurs profils d'un même compte peuvent y être présents en même temps.
 * Un salon plus ancien (sans drapeau) garde la clé = identifiant du compte. Règle : clé = profil, droits = compte
 * (exclusion, droits de l'hôte, invitations d'amis, signalements raisonnent sur le compte).
 */

/** Clé de participant d'un compte (salon ancien) ou d'un profil de ce compte (salon `memberKeys: 'profile'`). */
export function memberKey(accountId: string, profileId: string, mode: 'profile' | undefined): string {
  return mode === 'profile' ? `${accountId}:${profileId}` : accountId;
}

/** Compte d'une clé de participant ; la clé d'un invité sans compte (`guest:<id>`) reste intacte. */
export function accountOf(key: string): string {
  if (key.startsWith(GUEST_KEY_PREFIX)) return key;
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
}

/** Longueur maximale d'un pseudo affiché pour un profil secondaire. */
const DISPLAY_NAME_MAX = 40;

/**
 * Pseudo affiché d'un profil dans un salon : le nom du compte pour son profil principal, `<compte> · <profil>` pour les
 * autres (exclusion, silence et transfert ciblent un pseudo : deux participants ne portent jamais le même).
 */
export function displayName(username: string, profileName: string, isPrimary: boolean): string {
  return isPrimary ? username : `${username} · ${profileName}`.slice(0, DISPLAY_NAME_MAX);
}
