/*
 * « Vus » : historique des films et séries vus par le profil actif, même hors « Ma bibliothèque ». Module sans DOM ni
 * réseau : la source (serveur ou repli local) est choisie par userStore, l'affichage par library.js.
 */

/** Un titre vu. `watched` : 1 pour un film, nombre d'épisodes vus hors saison 0 pour une série. */
export interface WatchedTitle {
  /** `movie:550` ou `tv:1399`. */
  key: string;
  type: 'movie' | 'tv';
  id: number;
  watched: number;
  /** Dernière fois terminé (ms depuis l'époque) ; 0 si inconnue (historique local, sans date). */
  lastWatchedAt: number;
}

/** Sous-ensemble du DTO serveur utile ici (voir `WatchedTitleDto` de userApi.ts). */
export interface WatchedTitleWire {
  type: 'movie' | 'series';
  tmdbId: number | null;
  watched: number;
  lastWatchedAt: string;
}

export type WatchedSort = 'recent' | 'title' | 'year';

/** Ce que le tri lit : date du dernier visionnage, titre affiché, année (`YYYY` ou vide). */
export interface WatchedSortable {
  lastWatchedAt: number;
  name: string;
  year: string;
}

const byTitle = (a: WatchedSortable, b: WatchedSortable): number => a.name.localeCompare(b.name, 'fr');

/** Comparateur du sélecteur de tri ; à égalité, le titre (ordre français). `recent` : le plus récemment vu d'abord. */
export function compareWatched(sort: WatchedSort): (a: WatchedSortable, b: WatchedSortable) => number {
  if (sort === 'title') return byTitle;
  if (sort === 'year') return (a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || byTitle(a, b);
  return (a, b) => b.lastWatchedAt - a.lastWatchedAt || byTitle(a, b);
}

/** « 12/40 épisodes vus » ; sans total connu, « 12 épisodes vus » ; un film vu n'a pas de compteur. */
export function watchedProgressLabel(watched: number, total: number): string {
  const n = Math.max(0, Math.floor(watched));
  const unit = n > 1 ? 'épisodes vus' : 'épisode vu';
  if (total > 0) return Math.min(n, total) + '/' + total + ' ' + unit;
  return n + ' ' + unit;
}

/** Vrai si toute la série est vue (le total TMDB est atteint). Un film vu l'est toujours. */
export function isWatchedComplete(t: Pick<WatchedTitle, 'type' | 'watched'>, total: number): boolean {
  return t.type === 'movie' ? t.watched > 0 : total > 0 && t.watched >= total;
}

/**
 * Historique local (repli sans serveur) à partir des clés « vu » : `movie:550` pour un film, `tv:1399:1:2` pour un épisode
 * (saison 0 exclue). Pas de date : `lastWatchedAt` vaut 0.
 */
export function watchedTitlesFromSeen(seen: readonly string[]): WatchedTitle[] {
  const out = new Map<string, WatchedTitle>();
  for (const k of seen) {
    const p = k.split(':');
    if (p.slice(1).some((x) => !Number.isFinite(Number(x)) || x === '')) continue;
    if (p[0] === 'movie' && p.length === 2) {
      out.set('movie:' + p[1], { key: 'movie:' + p[1], type: 'movie', id: Number(p[1]), watched: 1, lastWatchedAt: 0 });
    } else if (p[0] === 'tv' && p.length === 4 && Number(p[2]) > 0) {
      const key = 'tv:' + p[1];
      const cur = out.get(key);
      out.set(key, { key, type: 'tv', id: Number(p[1]), watched: (cur ? cur.watched : 0) + 1, lastWatchedAt: 0 });
    }
  }
  return [...out.values()].filter((t) => t.watched > 0);
}

/** Titre de l'historique serveur ; null sans identifiant TMDB (import Stremio sans TMDB : impossible à ouvrir). */
export function watchedTitleFromWire(w: WatchedTitleWire): WatchedTitle | null {
  if (w.tmdbId == null || !Number.isFinite(w.tmdbId)) return null;
  const type = w.type === 'series' ? 'tv' : 'movie';
  return { key: type + ':' + w.tmdbId, type, id: w.tmdbId, watched: Math.max(0, w.watched), lastWatchedAt: Date.parse(w.lastWatchedAt) || 0 };
}
