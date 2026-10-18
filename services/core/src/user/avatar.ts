/**
 * Avatar illustré d'un profil, deux formats :
 * - `dicebear:<style>:<graine>` (style en minuscules et tirets, graine alphanumérique) ;
 * - `hero:<famille>:<graine>` (générateur maison laststream-heroes ; famille : heros, vilains, scifi ou fantasy).
 */
export const AVATAR_PATTERN = /^(?:dicebear:[a-z][a-z0-9-]{1,23}|hero:(?:heros|vilains|scifi|fantasy)):[A-Za-z0-9_-]{1,40}$/;
