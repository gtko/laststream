// Onglet « Récemment » de la fiche d'un ami (ODY-220) : le serveur ne connaît le titre et l'affiche que pour les titres que
// l'ami a dans sa bibliothèque (jointure sur library_items). Un épisode regardé hors bibliothèque arrive donc sans titre ni
// affiche : on les résout ici par l'identifiant TMDB, avec un libellé de repli si la résolution échoue.
import type { HistoryItem } from './socialV2Api';

type HistoryMeta = { title: string; poster: string };
/** Résout un titre par son identifiant TMDB (`tmdb('movie/603')` côté app) ; rejette si introuvable ou hors ligne. */
export type MetaFetcher = (kind: 'movie' | 'tv', id: number) => Promise<{ title?: string; name?: string; poster_path?: string | null }>;

const kindOf = (x: Pick<HistoryItem, 'type'>): 'movie' | 'tv' => (x.type === 'series' ? 'tv' : 'movie');

/** Libellé de repli quand rien n'est résolu : jamais « Sans titre » pour un titre qui existe. */
export const fallbackTitle = (x: Pick<HistoryItem, 'type'>): string => (x.type === 'series' ? 'Série' : 'Film');

const needsMeta = (x: HistoryItem): boolean => !x.title || !x.poster;

/** Entrées sans identifiant TMDB : aucune fiche ni affiche possibles, on les masque. */
export const usableHistory = (items: readonly HistoryItem[]): HistoryItem[] => items.filter((x) => Number.isFinite(x.tmdbId) && x.tmdbId > 0);

/**
 * Complète titre et affiche des entrées qui en manquent. Une même série (plusieurs épisodes) n'est résolue qu'une fois.
 * Titre ou affiche renvoyés par le serveur gardent la priorité. Échec de résolution : repli générique, entrée conservée.
 * Titre introuvable chez TMDB (réponse sans nom) : l'entrée est masquée.
 */
export async function enrichHistory(items: readonly HistoryItem[], fetchMeta: MetaFetcher, concurrency = 4): Promise<HistoryItem[]> {
  const list = usableHistory(items);
  const todo = new Map<string, { kind: 'movie' | 'tv'; id: number }>();
  for (const x of list) if (needsMeta(x)) todo.set(kindOf(x) + ':' + x.tmdbId, { kind: kindOf(x), id: x.tmdbId });
  const found = new Map<string, HistoryMeta | 'error' | 'missing'>();
  const jobs = [...todo.entries()];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const [key, { kind, id }] = jobs[next++];
      try {
        const raw = await fetchMeta(kind, id);
        const title = (raw && (raw.title || raw.name)) || '';
        found.set(key, title ? { title, poster: (raw && raw.poster_path) || '' } : 'missing');
      } catch {
        found.set(key, 'error');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const out: HistoryItem[] = [];
  for (const x of list) {
    if (!needsMeta(x)) { out.push(x); continue; }
    const meta = found.get(kindOf(x) + ':' + x.tmdbId);
    if (meta === 'missing') {
      if (!x.title) continue;
      out.push(x);
      continue;
    }
    const resolved = meta && meta !== 'error' ? meta : null;
    out.push({ ...x, title: x.title || (resolved ? resolved.title : fallbackTitle(x)), poster: x.poster || (resolved ? resolved.poster : '') || undefined });
  }
  return out;
}
