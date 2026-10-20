/* Lien d'invitation au foyer (contrat invitations v3, partie A) : `<origine>/#/foyer/<jeton>`. Le jeton est dans le fragment,
 * donc il ne part jamais dans les en-têtes HTTP. Fonctions pures (testées). */

const HASH_RE = /^#\/foyer\/([A-Za-z0-9_-]{20,64})\/?$/;

/** Lien à partager : l'origine (sans barre finale) suivie de `/#/foyer/<jeton>`. */
export function foyerLink(base: string, token: string): string {
  return base.replace(/\/+$/, '') + '/#/foyer/' + encodeURIComponent(token);
}

/** Jeton d'une adresse `#/foyer/<jeton>` (base64url, 20 à 64 caractères), ou null si l'adresse n'est pas une invitation. */
export function parseFoyerToken(hash: string): string | null {
  const m = HASH_RE.exec(hash);
  return m ? m[1] : null;
}
