import type { HiddenEntry } from './homeFilters';

/*
 * Vue « Titres masqués » (#/hidden) : filtre, tri et compteurs en mémoire sur toute la liste. Pur (ni DOM ni stockage),
 * donc testable. Les milliers d'entrées sont traitées d'un bloc ; seul le rendu, dans l'interface, est paginé.
 */

export type HiddenType = 'all' | 'movie' | 'tv';
export type HiddenSort = 'recent' | 'title' | 'year';

export interface HiddenViewOptions {
  /** Texte cherché dans le titre, sans accents ni casse. */
  query?: string;
  type?: HiddenType;
  sort?: HiddenSort;
  /** Année connue d'un titre (clé `movie:ID`), ou '' si inconnue. Les titres sans année vont en dernier. */
  yearOf?: (key: string) => string;
}

const folded = new Map<string, string>();
const FOLD_MAX = 20000;

/** Forme de comparaison d'un texte : sans accents, en minuscules, espaces réduits (œ = oe, æ = ae). Mise en cache (la recherche se refait à chaque frappe). */
export function foldText(s: string): string {
  let v = folded.get(s);
  if (v === undefined) {
    v = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/\s+/g, ' ').trim();
    if (folded.size >= FOLD_MAX) folded.clear();
    folded.set(s, v);
  }
  return v;
}

const isTv = (h: HiddenEntry): boolean => h.key.startsWith('tv:');

/** Compteurs par type, pour le texte cherché (le total, les films et les séries). */
export function hiddenCounts(list: readonly HiddenEntry[], query = ''): Record<HiddenType, number> {
  const q = foldText(query);
  let movie = 0;
  let tv = 0;
  for (const h of list) {
    if (q && !foldText(h.title).includes(q)) continue;
    if (isTv(h)) tv += 1;
    else movie += 1;
  }
  return { all: movie + tv, movie, tv };
}

/** Liste filtrée et triée (un nouveau tableau ; la liste d'origine n'est pas modifiée). */
export function hiddenView(list: readonly HiddenEntry[], opts: HiddenViewOptions = {}): HiddenEntry[] {
  const q = foldText(opts.query ?? '');
  const type = opts.type ?? 'all';
  const picked: HiddenEntry[] = [];
  for (const h of list) {
    if (type !== 'all' && (type === 'tv') !== isTv(h)) continue;
    if (q && !foldText(h.title).includes(q)) continue;
    picked.push(h);
  }
  const sort = opts.sort ?? 'recent';
  if (sort === 'title') {
    return picked
      .map((h) => ({ h, t: foldText(h.title) }))
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.h.key.localeCompare(b.h.key)))
      .map((x) => x.h);
  }
  if (sort === 'year') {
    const yearOf = opts.yearOf ?? (() => '');
    return picked
      .map((h) => {
        const y = Number.parseInt(yearOf(h.key), 10);
        return { h, y: Number.isFinite(y) ? y : -1, t: foldText(h.title) };
      })
      .sort((a, b) => b.y - a.y || (a.t < b.t ? -1 : a.t > b.t ? 1 : a.h.key.localeCompare(b.h.key)))
      .map((x) => x.h);
  }
  return picked.sort((a, b) => b.addedAt - a.addedAt || a.key.localeCompare(b.key));
}
