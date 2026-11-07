// Résolveur de titre (ODY-220) : titre et affiche d'un film ou d'une série à partir de son identifiant TMDB, quand le serveur
// n'en a pas (activité d'un ami hors de sa bibliothèque). Ordre : titre déjà connu de l'app (catalogue, bibliothèque) →
// mémoire locale enregistrée (localStorage, survit au rechargement) → TMDB. Un titre résolu par TMDB est enregistré pour ne
// plus être redemandé ; un échec réseau n'est jamais enregistré.
import type { MetaFetcher } from './friendHistoryView';

type Raw = Awaited<ReturnType<MetaFetcher>>;
type Stored = { t: string; p: string };
type KnownTitle = (kind: 'movie' | 'tv', id: number) => { title: string; poster: string } | null | undefined;
type Opts = { known?: KnownTitle; storage?: Pick<Storage, 'getItem' | 'setItem'> | null; max?: number };

export const TITLE_CACHE_KEY = 'ls.titleMeta.v1';
const MAX_ENTRIES = 300;

const defaultStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

export function createTitleResolver(fetchMeta: MetaFetcher, opts: Opts = {}): MetaFetcher {
  const store = opts.storage === undefined ? defaultStorage() : opts.storage;
  const max = opts.max ?? MAX_ENTRIES;
  let mem: Record<string, Stored> | null = null;
  const load = (): Record<string, Stored> => {
    if (mem) return mem;
    try {
      const parsed = JSON.parse(store?.getItem(TITLE_CACHE_KEY) || '{}');
      mem = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { mem = {}; }
    return mem as Record<string, Stored>;
  };
  const save = (key: string, v: Stored): void => {
    const all = load();
    delete all[key]; // réinsérée en dernier : les plus anciennes sortent d'abord
    all[key] = v;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete all[k];
    try { store?.setItem(TITLE_CACHE_KEY, JSON.stringify(all)); } catch { /* quota : la mémoire suffit */ }
  };
  return async (kind, id) => {
    const key = kind + ':' + id;
    const known = opts.known?.(kind, id);
    if (known && known.title) return { title: known.title, poster_path: known.poster || null } as Raw;
    const hit = load()[key];
    if (hit && typeof hit.t === 'string' && hit.t) return { title: hit.t, poster_path: typeof hit.p === 'string' && hit.p ? hit.p : null } as Raw;
    const raw = await fetchMeta(kind, id);
    const title = (raw && (raw.title || raw.name)) || '';
    if (title) save(key, { t: title, p: (raw && raw.poster_path) || '' });
    return raw;
  };
}
