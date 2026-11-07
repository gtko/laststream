// Bibliothèque d'un ami (ODY-222) : modèle pur de l'écran « Bibliothèque de <ami> » (recherche, filtre, tri, badges).
// Les titres viennent de GET /social/friends/:pid/library (déjà filtrée par le réglage « Ma bibliothèque » de l'ami) ;
// tout le calcul se fait ici, sans réseau ni DOM.
import type { LibraryItem } from './socialV2Api';

type FriendLibType = 'all' | 'movie' | 'tv';
type FriendLibSort = 'recent' | 'az' | 'za';
/** `common` : déjà dans ma bibliothèque ; `unseen` : pas encore vus par moi. */
type FriendLibMode = 'all' | 'common' | 'unseen';
export type FriendLibView = { q: string; type: FriendLibType; sort: FriendLibSort; mode: FriendLibMode };
export type FriendLibCtx = { have: (key: string) => boolean; seen: (key: string) => boolean };

export const DEFAULT_VIEW: FriendLibView = { q: '', type: 'all', sort: 'recent', mode: 'all' };

/** Titres exploitables : ceux sans identifiant TMDB n'ont pas de fiche à ouvrir. */
export const usable = (items: readonly LibraryItem[]): LibraryItem[] => items.filter((x) => x.tmdbId != null);

/** Clé de catalogue (`movie:603`, `tv:95396`) d'un titre de bibliothèque. */
export const keyOfItem = (x: Pick<LibraryItem, 'type' | 'tmdbId'>): string => (x.type === 'series' ? 'tv:' : 'movie:') + x.tmdbId;

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Vrai quand la fiche et l'écran n'ont rien à montrer : réglage « Ma bibliothèque » fermé ou aucun titre partagé. */
export const nothingToShow = (lib: { status: string; items: readonly LibraryItem[] }): boolean => lib.status === 'ok' && usable(lib.items).length === 0;

/** Nombre de titres par filtre (barre de filtres de l'écran). */
export function countsOf(items: readonly LibraryItem[], ctx: FriendLibCtx): { all: number; movie: number; tv: number; common: number; unseen: number } {
  const out = { all: 0, movie: 0, tv: 0, common: 0, unseen: 0 };
  for (const x of usable(items)) {
    const key = keyOfItem(x);
    out.all += 1;
    out[x.type === 'series' ? 'tv' : 'movie'] += 1;
    if (ctx.have(key)) out.common += 1;
    if (!ctx.seen(key)) out.unseen += 1;
  }
  return out;
}

/** Applique recherche, type, mode et tri (« récent » garde l'ordre du serveur : du plus récemment ajouté au plus ancien). */
export function applyView(items: readonly LibraryItem[], view: FriendLibView, ctx: FriendLibCtx): LibraryItem[] {
  const q = fold(view.q.trim());
  const rows = usable(items).filter((x) => {
    if (view.type === 'movie' && x.type !== 'movie') return false;
    if (view.type === 'tv' && x.type !== 'series') return false;
    if (q && !fold(x.title).includes(q)) return false;
    const key = keyOfItem(x);
    if (view.mode === 'common' && !ctx.have(key)) return false;
    if (view.mode === 'unseen' && ctx.seen(key)) return false;
    return true;
  });
  if (view.sort === 'recent') return rows;
  const dir = view.sort === 'az' ? 1 : -1;
  return rows.slice().sort((a, b) => dir * a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
}
