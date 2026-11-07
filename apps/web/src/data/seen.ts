/*
 * « Déjà vu » pour l'accueil : un film est vu s'il est marqué vu ou regardé à 90 % ou plus ; une série n'est vue que si
 * l'utilisateur l'a marquée vue en entier (liste `completed` du profil, voir homeFilters.ts). Une série commencée n'est
 * jamais vue. Aucune requête : la liste complète des épisodes diffusés n'est pas connue côté accueil.
 */

export const SEEN_PROGRESS_RATIO = 0.9;

/** Sous-ensemble du UserStore utilisé pour décider (facile à simuler dans les tests). */
export interface SeenStore {
  isWatched(key: string, season?: number, episode?: number): boolean;
  getProgress(key: string, season?: number, episode?: number): { position: number; duration: number } | null;
}

export interface SeenItem {
  type: 'movie' | 'tv';
  id: number;
  key?: string;
}

/** Vrai si le titre est « déjà vu » au sens de l'accueil. `completed` : clés `tv:ID` des séries marquées vues en entier. */
export function isFullyWatched(item: SeenItem, store: SeenStore, completed: ReadonlySet<string> = new Set()): boolean {
  const key = item.key ?? `${item.type}:${item.id}`;
  if (item.type === 'tv') return completed.has(key);
  if (store.isWatched(key)) return true;
  const p = store.getProgress(key);
  return !!p && p.duration > 0 && p.position / p.duration >= SEEN_PROGRESS_RATIO;
}
