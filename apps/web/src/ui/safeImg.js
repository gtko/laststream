/*
 * Validateur d'images du social : les images viennent de comptes tiers (affiches, bannières, scènes). Seules les URL TMDB
 * `https://image.tmdb.org/t/p/<taille>/<fichier>` ou un chemin TMDB `/xxx.jpg` (converti) passent ; tout le reste donne null.
 */
const BASE = 'https://image.tmdb.org/t/p/';
const FULL = /^https:\/\/image\.tmdb\.org\/t\/p\/(w\d{2,4}|h\d{2,4}|original)\/[\w-]+\.(?:jpe?g|png|webp)$/i;
const PATH = /^\/[\w-]+\.(?:jpe?g|png|webp)$/i;

/** URL TMDB sûre (taille par défaut `size` pour un chemin), ou null. */
export function safeTmdbImage(p, size = 'w342') {
  if (typeof p !== 'string') return null;
  if (FULL.test(p)) return p;
  if (PATH.test(p) && /^(w\d{2,4}|h\d{2,4}|original)$/.test(size)) return BASE + size + p;
  return null;
}

/** Valeur sûre pour `style.backgroundImage` (`url("…")`), ou '' si l'image est refusée. */
export function cssUrl(url) {
  return typeof url === 'string' && FULL.test(url) ? 'url("' + url + '")' : '';
}
