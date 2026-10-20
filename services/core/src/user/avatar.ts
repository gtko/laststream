import { KID_AVATAR_COLLECTIONS } from './avatar-collections.js';

/**
 * Avatar illustré d'un profil, trois formats :
 * - `dicebear:<style>:<graine>` (style en minuscules et tirets, graine alphanumérique) ;
 * - `hero:<famille>:<graine>` (générateur maison laststream-heroes ; famille : heros, vilains, scifi ou fantasy) ;
 * - `col:<colId>:<charId>` (collection publiée, voir avatar-collections.ts ; seuls les identifiants connus sont acceptés).
 */
export const AVATAR_PATTERN = /^(?:dicebear:[a-z][a-z0-9-]{1,23}|hero:(?:heros|vilains|scifi|fantasy)):[A-Za-z0-9_-]{1,40}$/;

/** Avatar d'une collection : `col:<colId>:<charId>`, identifiants en slug ASCII minuscule (48 caractères au plus). */
export const AVATAR_COLLECTION_PATTERN = /^col:([a-z0-9][a-z0-9-]{0,47}):([a-z0-9][a-z0-9-]{0,47})$/;

/** Longueur maximale d'un avatar stocké : `col:` + colId (48) + `:` + charId (48). */
export const AVATAR_MAX_LENGTH = 101;

/** Identifiant de collection d'un avatar `col:`, ou undefined pour les autres formats (dicebear, hero) et les valeurs invalides. */
export function collectionOfAvatar(avatar: string): string | undefined {
  return AVATAR_COLLECTION_PATTERN.exec(avatar)?.[1];
}

/** Vrai pour tout format d'avatar de profil reconnu (dicebear, hero ou collection) : le format seul, sans liste de collections. */
export const isAvatarValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= AVATAR_MAX_LENGTH && (AVATAR_PATTERN.test(value) || AVATAR_COLLECTION_PATTERN.test(value));

/**
 * Avatar admis pour un invité sans compte (liste blanche) : dicebear et hero (dessinés localement par l'application) ou
 * une collection adaptée aux enfants. Jamais d'URL ni d'autre forme libre. `undefined` si la valeur n'est pas admise.
 */
export function guestAvatarOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > AVATAR_MAX_LENGTH) return undefined;
  if (AVATAR_PATTERN.test(value)) return value;
  const colId = collectionOfAvatar(value);
  return colId !== undefined && KID_AVATAR_COLLECTIONS.has(colId) ? value : undefined;
}
