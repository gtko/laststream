import { isFullyWatched, type SeenStore } from './seen';
import { userStore } from './userStore';

/*
 * Filtres d'accueil propres à chaque profil : titres « Ne plus proposer », genres bannis, séries marquées vues en entier.
 * Stockés par profil sur ce navigateur et synchronisés avec le compte (réglages du profil, clés `home…`, découpées en
 * morceaux de moins de 4 Ko comme les recommandations). Un seul point de filtrage pour l'accueil : `keepVisible`.
 */

export interface HiddenEntry {
  /** Clé de titre : `movie:550` ou `tv:1399`. */
  key: string;
  title: string;
  /** Chemin d'affiche TMDB (réglages : liste des titres masqués). */
  poster: string;
  addedAt: number;
}

export interface HomeFilters {
  hidden: HiddenEntry[];
  /** Identifiants TMDB de genres bannis (films et séries). */
  genres: number[];
  /** Clés `tv:ID` des séries marquées vues en entier. */
  completed: string[];
}

/** Élément affichable sur l'accueil : titre (clé, type, identifiant) et genres TMDB si connus. */
export interface HomeItemLike {
  key?: string;
  type: 'movie' | 'tv';
  id: number;
  genreIds?: number[];
}

/** Genres proposés dans les réglages (libellés français). Les doublons TMDB (films / séries) partagent une puce. */
export const GENRE_OPTIONS: ReadonlyArray<{ label: string; ids: number[] }> = [
  { label: 'Action', ids: [28, 10759] },
  { label: 'Aventure', ids: [12] },
  { label: 'Animation', ids: [16] },
  { label: 'Comédie', ids: [35] },
  { label: 'Crime', ids: [80] },
  { label: 'Documentaire', ids: [99] },
  { label: 'Drame', ids: [18] },
  { label: 'Familial', ids: [10751] },
  { label: 'Enfants', ids: [10762] },
  { label: 'Fantastique', ids: [14] },
  { label: 'Histoire', ids: [36] },
  { label: 'Horreur', ids: [27] },
  { label: 'Musique', ids: [10402] },
  { label: 'Mystère', ids: [9648] },
  { label: 'Romance', ids: [10749] },
  { label: 'Science-fiction', ids: [878, 10765] },
  { label: 'Guerre et politique', ids: [10752, 10768] },
  { label: 'Thriller', ids: [53] },
  { label: 'Western', ids: [37] },
  { label: 'Téléfilm', ids: [10770] },
  { label: 'Feuilleton', ids: [10766] },
  { label: 'Talk-show', ids: [10767] },
  { label: 'Téléréalité', ids: [10764] },
  { label: 'Actualités', ids: [10763] },
];

export const HOME_FILTERS_KEY_PREFIX = 'laststream.homeFilters.';
/** Nombre maximal de titres masqués par profil (tient dans les morceaux de réglages). */
export const MAX_HIDDEN = 150;
const TITLE_MAX = 60;
const POSTER_MAX = 40;
const CHUNK_BYTES = 3300;
const MAX_CHUNKS = 12;
const KEY_RE = /^(movie|tv):\d+$/;

export const EMPTY_FILTERS: HomeFilters = { hidden: [], genres: [], completed: [] };

// ---------- Changements (rafraîchissement de l'accueil sans rechargement) ----------
const listeners = new Set<() => void>();
/** Abonnement aux changements de filtres ou de « vu » : l'accueil retire alors les titres concernés. */
export function onHomeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function notifyHomeChange(): void {
  listeners.forEach((fn) => fn());
}

// ---------- Envoi au compte (branché par auth.ts) ----------
type Pusher = (profileId: string, settings: Record<string, unknown>) => void;
let pusher: Pusher | null = null;
export function setFiltersPusher(fn: Pusher | null): void {
  pusher = fn;
}

// ---------- Lecture / écriture par profil ----------
const profileId = (): string => userStore.currentProfile().id;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const isHiddenEntry = (x: unknown): x is HiddenEntry => {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.key === 'string' && KEY_RE.test(r.key) && typeof r.title === 'string' && typeof r.poster === 'string' && typeof r.addedAt === 'number';
};

/** Filtres valides, sans doublon ; les entrées abîmées sont ignorées. */
export function normalizeFilters(raw: unknown): HomeFilters {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const hidden = Array.isArray(r.hidden) ? r.hidden.filter(isHiddenEntry).slice(0, MAX_HIDDEN) : [];
  const genres = Array.isArray(r.genres) ? [...new Set(r.genres.filter((g): g is number => Number.isInteger(g)))] : [];
  const completed = Array.isArray(r.completed) ? [...new Set(r.completed.filter((k): k is string => typeof k === 'string' && /^tv:\d+$/.test(k)))] : [];
  return { hidden, genres, completed };
}

function readLocal(id: string): HomeFilters {
  try {
    const raw = storage()?.getItem(HOME_FILTERS_KEY_PREFIX + id);
    return raw ? normalizeFilters(JSON.parse(raw)) : EMPTY_FILTERS;
  } catch {
    return EMPTY_FILTERS;
  }
}

function writeLocal(id: string, f: HomeFilters): void {
  try {
    storage()?.setItem(HOME_FILTERS_KEY_PREFIX + id, JSON.stringify(f));
  } catch {
    // Stockage indisponible : les filtres valent pour la session.
  }
}

let cache: { id: string; f: HomeFilters } | null = null;

/** Filtres du profil actif (mis en cache pour ne pas relire le stockage à chaque tuile). */
export function currentFilters(): HomeFilters {
  const id = profileId();
  if (!cache || cache.id !== id) cache = { id, f: readLocal(id) };
  return cache.f;
}

/** Oublie le cache mémoire après une modification directe du stockage (tests, réinitialisation). */
export function resetFiltersCache(): void {
  cache = null;
}

function save(id: string, f: HomeFilters): void {
  cache = { id, f };
  writeLocal(id, f);
  if (pusher) pusher(id, packFilters(f));
  notifyHomeChange();
}

// ---------- Actions ----------
/** Ne plus proposer un titre sur l'accueil. Faux si la liste est pleine. */
export function hideTitle(entry: { key: string; title: string; poster?: string }): boolean {
  const id = profileId();
  const f = currentFilters();
  if (f.hidden.some((h) => h.key === entry.key)) return true;
  if (f.hidden.length >= MAX_HIDDEN || !KEY_RE.test(entry.key)) return false;
  const hiddenEntry: HiddenEntry = { key: entry.key, title: entry.title.slice(0, TITLE_MAX), poster: (entry.poster ?? '').slice(0, POSTER_MAX), addedAt: Date.now() };
  save(id, { ...f, hidden: [...f.hidden, hiddenEntry] });
  return true;
}

/** Réaffiche un titre masqué. Renvoie l'entrée retirée (pour l'annulation), ou null. */
export function unhideTitle(key: string): HiddenEntry | null {
  const f = currentFilters();
  const removed = f.hidden.find((h) => h.key === key) ?? null;
  if (removed) save(profileId(), { ...f, hidden: f.hidden.filter((h) => h.key !== key) });
  return removed;
}

export const isHiddenKey = (key: string): boolean => currentFilters().hidden.some((h) => h.key === key);

/** Bannit (ou lève le bannissement de) plusieurs identifiants de genre, par exemple les deux ids d'une même puce. */
export function setGenreBanned(ids: number[], banned: boolean): void {
  const f = currentFilters();
  const genres = banned ? [...new Set([...f.genres, ...ids])] : f.genres.filter((g) => !ids.includes(g));
  save(profileId(), { ...f, genres });
}

export const bannedGenreIds = (): Set<number> => new Set(currentFilters().genres);

/** Vrai si un élément porte un genre banni (liste `genreIds` de TMDB). */
export function isBannedGenre(item: { genreIds?: number[] }, banned: ReadonlySet<number> = bannedGenreIds()): boolean {
  return (item.genreIds ?? []).some((g) => banned.has(g));
}

/** Enregistre (ou retire) une série marquée vue en entier. Toute décision « non vue » la retire. */
export function setSeriesCompleted(key: string, on: boolean): void {
  if (!/^tv:\d+$/.test(key)) return;
  const f = currentFilters();
  if (f.completed.includes(key) === on) return;
  save(profileId(), { ...f, completed: on ? [...f.completed, key] : f.completed.filter((k) => k !== key) });
}

// ---------- Filtre central ----------
/** Prédicat « visible sur l'accueil » pour un ensemble de filtres et un état « vu ». Pur (testable). */
export function homeVisibility(store: SeenStore, f: HomeFilters): (item: HomeItemLike) => boolean {
  const hidden = new Set(f.hidden.map((h) => h.key));
  const banned = new Set(f.genres);
  const completed = new Set(f.completed);
  return (item) => {
    const key = item.key ?? `${item.type}:${item.id}`;
    if (hidden.has(key) || isBannedGenre(item, banned)) return false;
    return !isFullyWatched({ type: item.type, id: item.id, key }, store, completed);
  };
}

/**
 * Retire de la liste les titres « déjà vus », masqués ou aux genres bannis. C'est le seul point de filtrage de l'accueil
 * (bannière, rangées, Top 10, IA, « Prochainement », « Tout voir »). Ne pas l'appeler pour « Reprendre la lecture »,
 * « Cette semaine dans tes suivis », la bibliothèque, le calendrier, la recherche, la fiche ou les pages personne.
 */
export function keepVisible<T extends HomeItemLike>(items: readonly T[] | null | undefined): T[] {
  if (!items || !items.length) return [];
  const visible = homeVisibility(userStore, currentFilters());
  return items.filter((it) => visible(it));
}

// ---------- Réglages du profil (sérialisation) ----------
/** Découpe en morceaux dont la forme JSON tient sous CHUNK_BYTES. */
function splitChunks(items: readonly unknown[]): unknown[][] {
  const out: unknown[][] = [];
  let cur: unknown[] = [];
  for (const it of items) {
    if (cur.length && JSON.stringify([...cur, it]).length > CHUNK_BYTES) {
      out.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out.slice(0, MAX_CHUNKS);
}

function putChunks(out: Record<string, unknown>, name: string, items: readonly unknown[]): void {
  const parts = splitChunks(items);
  out[name] = parts.length;
  for (let k = 0; k < MAX_CHUNKS; k++) out[name + k] = parts[k] ?? null; // null efface les anciens morceaux
}

function readChunks(settings: Record<string, unknown>, name: string): unknown[] {
  const n = settings[name];
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return [];
  const out: unknown[] = [];
  for (let k = 0; k < Math.min(n, MAX_CHUNKS); k++) {
    const c = settings[name + k];
    if (Array.isArray(c)) out.push(...c);
  }
  return out;
}

/** Réglages envoyés au profil (PUT partiel : les autres clés du profil sont conservées). */
export function packFilters(f: HomeFilters): Record<string, unknown> {
  const out: Record<string, unknown> = { homeGenres: f.genres };
  putChunks(out, 'homeHidden', f.hidden);
  putChunks(out, 'homeCompleted', f.completed);
  return out;
}

/** Filtres lus dans les réglages du profil, ou null si le compte n'en a jamais reçu. */
export function unpackFilters(settings: Record<string, unknown> | null | undefined): HomeFilters | null {
  if (!settings) return null;
  if (!['homeGenres', 'homeHidden', 'homeCompleted'].some((k) => settings[k] !== undefined && settings[k] !== null)) return null;
  return normalizeFilters({
    genres: settings.homeGenres,
    hidden: readChunks(settings, 'homeHidden'),
    completed: readChunks(settings, 'homeCompleted'),
  });
}

const hasAny = (f: HomeFilters): boolean => f.hidden.length > 0 || f.genres.length > 0 || f.completed.length > 0;

/**
 * À la connexion à un profil : les filtres du compte priment ; sans filtres sur le compte, ceux de ce navigateur
 * sont envoyés. Renvoie vrai si les filtres locaux ont été remplacés.
 */
export function applyAccountFilters(id: string, settings: Record<string, unknown>): boolean {
  const remote = unpackFilters(settings);
  if (remote) {
    cache = { id, f: remote };
    writeLocal(id, remote);
    notifyHomeChange();
    return true;
  }
  const local = readLocal(id);
  if (hasAny(local) && pusher) pusher(id, packFilters(local));
  return false;
}
