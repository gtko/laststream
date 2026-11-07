/* Disponibilité des films récents : un film seulement en salle n'est pas « jouable » (ni rangées, ni recherche, ni mise en avant). */
import { tmdb } from '../data/lt';
import { availOf } from './catalog.js';
import { dayDiff } from './dates.js';

const cache = new Map();
const RECENT_DAYS = 150;

/** { available, cinemaSince } d'un film ; une requête par film (détail avec dates de sortie et fournisseurs), mise en cache. */
function availability(id) {
  if (!cache.has(id)) {
    const p = tmdb('movie/' + id, { append_to_response: 'release_dates,watch/providers' }).then(availOf);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return cache.get(id);
}


const isRecentMovie = (it) => it.type === 'movie' && it.date && dayDiff(it.date) > -RECENT_DAYS;

/**
 * Garde les titres jouables. Séries et films anciens passent sans requête ; les films récents sont vérifiés.
 * Sans réponse (erreur réseau), le titre est gardé : on ne masque rien sur une incertitude.
 * Avec `cinema: true`, ne garde au contraire que les films uniquement en salle (rangée « Au cinéma en ce moment »).
 */
export async function filterAvailable(items, opts) {
  const cinema = !!(opts && opts.cinema);
  const checked = await Promise.all(items.map(async (it) => {
    if (!isRecentMovie(it)) return { it, a: null };
    try { return { it, a: await availability(it.id) }; } catch (_) { return { it, a: null }; }
  }));
  if (cinema) {
    return checked.filter(({ a }) => a && !a.available && a.cinemaSince).map(({ it, a }) => Object.assign(it, { cinema: a.cinemaSince }));
  }
  return checked.filter(({ a }) => !a || a.available).map(({ it }) => it);
}
