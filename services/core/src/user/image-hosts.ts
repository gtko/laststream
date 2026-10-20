/**
 * Affiches et fonds d'image acceptés côté serveur (coups de cœur des billets de parrainage, fonds du foyer) : https seulement,
 * sur un hôte de la liste, sans identifiants ni port. L'app n'a pas de proxy d'images : une adresse relative ou une autre
 * origine est refusée (400 côté billet, retirée côté foyer).
 */
const IMAGE_HOSTS: readonly string[] = [
  'image.tmdb.org',
  'assets.fanart.tv',
  // Affiches des métadonnées Stremio (bibliothèques).
  'images.metahub.space',
  'episodes.metahub.space',
  'live.metahub.space',
];

/** Vrai si `value` est une URL https absolue sur un hôte d'image autorisé. */
export function isAllowedImageUrl(value: string): boolean {
  if (value.length > 2048 || /\p{Cc}/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && IMAGE_HOSTS.includes(url.hostname);
}
