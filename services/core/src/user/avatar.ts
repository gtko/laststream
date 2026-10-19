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
