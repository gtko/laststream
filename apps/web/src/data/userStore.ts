/**
 * Données utilisateur : bibliothèque, progression, « continuer à regarder », épisodes vus, profils.
 * Toute l'interface passe par l'interface `UserStore` ; l'implémentation actuelle est locale (localStorage).
 *
 * TODO(lastAddon user-data API) : écrire un adaptateur serveur (comptes, profils, bibliothèque, progression,
 * import Stremio) qui implémente `UserStore` (cache local synchrone + synchronisation en arrière-plan), puis
 * l'installer avec `setUserStore(adapter)` au démarrage (src/main.js). Aucun autre code n'est à modifier.
 */
import { emitDataEvent } from './events';
import { watchedTitlesFromSeen, type WatchedTitle } from './watchedHistory';

export interface LibraryEntry {
  id: number;
  type: 'movie' | 'tv';
  title: string;
  /** Chemin d'affiche TMDB (ex. /abc.jpg). */
  poster: string;
  year?: string;
  addedAt: number;
}

export interface ProgressEntry {
  /** Clé de titre : `movie:550` ou `tv:1399`. */
  key: string;
  type: 'movie' | 'tv';
  id: number;
  title: string;
  poster: string;
  backdrop?: string;
  season?: number;
  episode?: number;
  /** Position et durée en secondes. */
  position: number;
  duration: number;
  updatedAt: number;
  /** Épisode terminé : la carte propose le suivant. */
  finished?: boolean;
  /** Épisode suivant proposé par le serveur (season / episode désignent déjà cet épisode). */
  suggested?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  /** Champs du compte lastAddon (absents en mode local). */
  avatarColor?: string;
  /** Avatar illustré (dicebear:<style>:<graine>), sinon initiale sur avatarColor. */
  avatar?: string | null;
  isKid?: boolean;
  kidMaxAge?: number | null;
  hasPin?: boolean;
  allowedCatalogs?: string[];
  /** Profil administrateur du serveur (annoncé au compte propriétaire seulement). */
  isAdminProfile?: boolean;
  /** Profil principal du compte : seul à gérer sources, extensions et clés (absent : serveur ancien, tout est permis). */
  isMainProfile?: boolean;
}

export interface UserStore {
  getLibrary(): LibraryEntry[];
  inLibrary(key: string): boolean;
  addToLibrary(entry: Omit<LibraryEntry, 'addedAt'> & { addedAt?: number }): void;
  removeFromLibrary(key: string): void;
  /** Ajoute ou retire ; renvoie vrai si le titre est maintenant dans la bibliothèque. */
  toggleLibrary(entry: Omit<LibraryEntry, 'addedAt'>): boolean;

  getProgress(key: string, season?: number, episode?: number): ProgressEntry | null;
  setProgress(entry: Omit<ProgressEntry, 'updatedAt'>): void;
  /** Charge la progression d'un titre depuis le serveur avant lecture (adaptateur serveur ; sans effet en local). */
  loadProgress?(key: string): Promise<void>;
  /** Titres entamés (2 % à 95 %), le plus récent d'abord, un par titre ; les titres retirés par l'utilisateur sont exclus. */
  continueWatching(limit?: number): ProgressEntry[];
  /** Enregistre l'affiche retrouvée d'un titre de la bibliothèque (chemin TMDB). */
  updateLibraryPoster?(key: string, posterPath: string): void;
  /** Abonnement aux changements asynchrones de la bibliothèque (résolution des titres importés). */
  subscribe?(fn: () => void): void;
  /** Retire un titre de « Reprendre la lecture » sans perdre la progression. Faux en cas d'échec (rien n'a changé). */
  hideContinue(key: string): Promise<boolean>;
  showContinue(key: string): Promise<void>;

  getSeen(): string[];
  isSeen(episodeKey: string): boolean;
  toggleSeen(episodeKey: string): boolean;

  /** « Vu » d'un film (`movie:550`) ou d'un épisode (`tv:1399`, saison, épisode). */
  isWatched(key: string, season?: number, episode?: number): boolean;
  /** Épisodes vus d'une série. */
  watchedEpisodes(key: string): WatchedRef[];
  /**
   * Marque films / épisodes comme vus ou non vus. Le cache change tout de suite (affichage optimiste) ;
   * la promesse vaut false si le serveur a refusé, le cache est alors revenu à l'état précédent.
   */
  setWatched(key: string, episodes: WatchedRef[] | null, watched: boolean): Promise<boolean>;
  /** Charge l'état « vu » d'un titre depuis le serveur avant affichage (adaptateur serveur ; sans effet en local). */
  loadWatched?(key: string): Promise<void>;
  /** Titres vus (films et séries) du profil, pour l'onglet « Vus » : historique du serveur s'il est chargé, sinon celui de ce téléphone. */
  watchedTitles(): WatchedTitle[];
  /** Le titre vu, ou null s'il ne l'est plus (ou jamais). */
  watchedTitle(key: string): WatchedTitle | null;

  /** Suivis (films, séries, personnes). Clés : `movie:1`, `tv:2`, `person:3`. */
  getFollows(type?: FollowEntry['type']): FollowEntry[];
  isFollowing(key: string): boolean;
  /** Suit ou ne suit plus ; faux si le serveur a refusé (le cache est alors revenu à l'état précédent). */
  setFollow(entry: Omit<FollowEntry, 'addedAt'>, follow: boolean): Promise<boolean>;

  /** Notes. */
  getRatings(): RatingEntry[];
  getRating(key: string): number | null;
  /** `rating` null retire la note. */
  setRating(entry: Omit<RatingEntry, 'updatedAt' | 'rating'>, rating: number | null): Promise<boolean>;

  getProfiles(): Profile[];
  currentProfile(): Profile;
  setProfile(id: string): void;
}

/** Titre ou personne suivi (type `tv` pour une série). Indépendant de la bibliothèque. */
export interface FollowEntry {
  type: 'movie' | 'tv' | 'person';
  id: number;
  title: string;
  /** Affiche ou photo (chemin TMDB). */
  poster: string;
  addedAt: number;
}

/** Note de 0,5 à 5 (par demi-étoile). */
export interface RatingEntry {
  type: 'movie' | 'tv';
  id: number;
  title: string;
  year: string;
  rating: number;
  updatedAt: number;
}

export const FOLLOWS_KEY = 'laststream.follows';
export const RATINGS_KEY = 'laststream.ratings';
export const validRating = (n: number): boolean => Number.isFinite(n) && n >= 0.5 && n <= 5 && Math.round(n * 2) === n * 2;

export interface WatchedRef {
  season: number;
  episode: number;
}

/** Clé de stockage d'un « vu » : le film seul, ou titre + saison + épisode. */
export const watchedKey = (key: string, season?: number, episode?: number): string =>
  season != null && episode != null ? `${key}:${season}:${episode}` : key;

export const CONTINUE_HIDDEN_KEY = 'laststream.continue.hidden';
export const LIBRARY_KEY = 'laststream.library';
export const PROGRESS_KEY = 'laststream.progress';
export const SEEN_KEY = 'ls_seen';
export const PROFILES_KEY = 'laststream.profiles';
export const PROFILE_CURRENT_KEY = 'laststream.profile';

const libKey = (e: { type: string; id: number | string }): string => `${e.type}:${e.id}`;

export const progressKey = (key: string, season?: number, episode?: number): string =>
  season != null && episode != null ? `${key}:${season}:${episode}` : key;

function readJson<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage: Storage | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Stockage indisponible : la donnée n'est pas conservée.
  }
}

/** Entrée de bibliothèque valide, ou null (migration de l'ancien format du prototype). */
export function normalizeLibraryEntry(x: unknown): LibraryEntry | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isFinite(id) || id <= 0 || (r.type !== 'movie' && r.type !== 'tv')) return null;
  return {
    id,
    type: r.type,
    title: typeof r.title === 'string' ? r.title : '',
    poster: typeof r.poster === 'string' ? r.poster : '',
    year: typeof r.year === 'string' ? r.year : undefined,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
  };
}

export class LocalUserStore implements UserStore {
  /** `storage` : stockage de remplacement (mode démo : en mémoire) ; par défaut le localStorage du navigateur. */
  constructor(private readonly storage?: Storage) {}

  private get ls(): Storage | undefined {
    if (this.storage) return this.storage;
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  }

  getLibrary(): LibraryEntry[] {
    const raw = readJson<unknown>(this.ls, LIBRARY_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeLibraryEntry).filter((e): e is LibraryEntry => e !== null);
  }

  private saveLibrary(list: LibraryEntry[]): void {
    writeJson(this.ls, LIBRARY_KEY, list);
  }

  inLibrary(key: string): boolean {
    return this.getLibrary().some((e) => libKey(e) === key);
  }

  addToLibrary(entry: Omit<LibraryEntry, 'addedAt'> & { addedAt?: number }): void {
    const list = this.getLibrary();
    if (list.some((e) => libKey(e) === libKey(entry))) return;
    list.push({ ...entry, addedAt: entry.addedAt ?? Date.now() });
    this.saveLibrary(list);
    emitDataEvent({ kind: 'library', key: libKey(entry) });
  }

  removeFromLibrary(key: string): void {
    this.saveLibrary(this.getLibrary().filter((e) => libKey(e) !== key));
    emitDataEvent({ kind: 'library', key });
  }

  toggleLibrary(entry: Omit<LibraryEntry, 'addedAt'>): boolean {
    const key = libKey(entry);
    if (this.inLibrary(key)) {
      this.removeFromLibrary(key);
      return false;
    }
    this.addToLibrary(entry);
    return true;
  }

  private progressMap(): Record<string, ProgressEntry> {
    const raw = readJson<unknown>(this.ls, PROGRESS_KEY, {});
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, ProgressEntry>) : {};
  }

  getProgress(key: string, season?: number, episode?: number): ProgressEntry | null {
    return this.progressMap()[progressKey(key, season, episode)] ?? null;
  }

  setProgress(entry: Omit<ProgressEntry, 'updatedAt'>): void {
    const map = this.progressMap();
    map[progressKey(entry.key, entry.season, entry.episode)] = { ...entry, updatedAt: Date.now() };
    writeJson(this.ls, PROGRESS_KEY, map);
    this.unhide(entry.key); // une nouvelle lecture réaffiche le titre
    emitDataEvent({ kind: 'progress', key: entry.key });
  }

  hiddenKeys(): string[] {
    const raw = readJson<unknown>(this.ls, CONTINUE_HIDDEN_KEY, []);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  }

  private unhide(key: string): void {
    const list = this.hiddenKeys();
    if (list.includes(key)) writeJson(this.ls, CONTINUE_HIDDEN_KEY, list.filter((k) => k !== key));
  }

  updateLibraryPoster(key: string, posterPath: string): void {
    const list = this.getLibrary();
    const e = list.find((x) => `${x.type}:${x.id}` === key);
    if (e && e.poster !== posterPath) {
      e.poster = posterPath;
      this.saveLibrary(list);
    }
  }

  async hideContinue(key: string): Promise<boolean> {
    const list = this.hiddenKeys();
    if (!list.includes(key)) writeJson(this.ls, CONTINUE_HIDDEN_KEY, [...list, key]);
    emitDataEvent({ kind: 'continue', key });
    return true;
  }

  async showContinue(key: string): Promise<void> {
    this.unhide(key);
    emitDataEvent({ kind: 'continue', key });
  }

  continueWatching(limit = Infinity): ProgressEntry[] {
    const latest = new Map<string, ProgressEntry>();
    const hidden = new Set(this.hiddenKeys());
    Object.values(this.progressMap()).forEach((p) => {
      if (!p || !p.duration || p.duration <= 0 || hidden.has(p.key)) return;
      const ratio = p.position / p.duration;
      if (ratio < 0.02 || (ratio > 0.95 && p.type !== 'tv')) return;
      const cur = latest.get(p.key);
      if (!cur || p.updatedAt > cur.updatedAt) latest.set(p.key, ratio > 0.95 ? { ...p, finished: true } : p);
    });
    return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  getSeen(): string[] {
    const raw = readJson<unknown>(this.ls, SEEN_KEY, []);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  }

  isSeen(episodeKey: string): boolean {
    return this.getSeen().includes(episodeKey);
  }

  toggleSeen(episodeKey: string): boolean {
    const list = this.getSeen();
    const i = list.indexOf(episodeKey);
    if (i >= 0) list.splice(i, 1);
    else list.push(episodeKey);
    writeJson(this.ls, SEEN_KEY, list);
    return i < 0;
  }

  getFollows(type?: FollowEntry['type']): FollowEntry[] {
    const raw = readJson<unknown>(this.ls, FOLLOWS_KEY, []);
    const list = Array.isArray(raw) ? (raw as FollowEntry[]).filter((f) => f && Number.isFinite(f.id) && ['movie', 'tv', 'person'].includes(f.type)) : [];
    return (type ? list.filter((f) => f.type === type) : list).sort((a, b) => b.addedAt - a.addedAt);
  }
  isFollowing(key: string): boolean {
    return this.getFollows().some((f) => `${f.type}:${f.id}` === key);
  }
  replaceFollows(list: FollowEntry[]): void {
    writeJson(this.ls, FOLLOWS_KEY, list);
  }
  async setFollow(entry: Omit<FollowEntry, 'addedAt'>, follow: boolean): Promise<boolean> {
    const key = `${entry.type}:${entry.id}`;
    const rest = this.getFollows().filter((f) => `${f.type}:${f.id}` !== key);
    this.replaceFollows(follow ? [...rest, { ...entry, addedAt: Date.now() }] : rest);
    return true;
  }

  getRatings(): RatingEntry[] {
    const raw = readJson<unknown>(this.ls, RATINGS_KEY, []);
    return (Array.isArray(raw) ? (raw as RatingEntry[]).filter((r) => r && validRating(r.rating) && Number.isFinite(r.id)) : []).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  getRating(key: string): number | null {
    return this.getRatings().find((r) => `${r.type}:${r.id}` === key)?.rating ?? null;
  }
  replaceRatings(list: RatingEntry[]): void {
    writeJson(this.ls, RATINGS_KEY, list);
  }
  async setRating(entry: Omit<RatingEntry, 'updatedAt' | 'rating'>, rating: number | null): Promise<boolean> {
    if (rating !== null && !validRating(rating)) return false;
    const key = `${entry.type}:${entry.id}`;
    const rest = this.getRatings().filter((r) => `${r.type}:${r.id}` !== key);
    this.replaceRatings(rating === null ? rest : [...rest, { ...entry, rating, updatedAt: Date.now() }]);
    return true;
  }

  isWatched(key: string, season?: number, episode?: number): boolean {
    return this.getSeen().includes(watchedKey(key, season, episode));
  }

  watchedEpisodes(key: string): WatchedRef[] {
    const pre = key + ':';
    return this.getSeen().filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split(':').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite)).map(([season, episode]) => ({ season, episode }));
  }

  watchedTitles(): WatchedTitle[] {
    return watchedTitlesFromSeen(this.getSeen());
  }

  watchedTitle(key: string): WatchedTitle | null {
    return this.watchedTitles().find((t) => t.key === key) ?? null;
  }

  /** Remplace les « vus » d'un titre (utilisé par l'adaptateur serveur pour appliquer ou annuler un changement). */
  applyWatched(key: string, episodes: WatchedRef[] | null, watched: boolean): void {
    const set = new Set(this.getSeen());
    const keys = episodes ? episodes.map((e) => watchedKey(key, e.season, e.episode)) : [key];
    keys.forEach((k) => (watched ? set.add(k) : set.delete(k)));
    writeJson(this.ls, SEEN_KEY, [...set]);
  }

  async setWatched(key: string, episodes: WatchedRef[] | null, watched: boolean): Promise<boolean> {
    this.applyWatched(key, episodes, watched);
    emitDataEvent({ kind: 'watched', key });
    return true;
  }

  getProfiles(): Profile[] {
    const raw = readJson<unknown>(this.ls, PROFILES_KEY, null);
    if (Array.isArray(raw)) {
      const list = raw.filter((p): p is Profile => !!p && typeof p.id === 'string' && typeof p.name === 'string');
      if (list.length) return list;
    }
    return [{ id: 'default', name: 'Greg' }];
  }

  currentProfile(): Profile {
    const profiles = this.getProfiles();
    let id: string | null = null;
    try {
      id = this.ls?.getItem(PROFILE_CURRENT_KEY) ?? null;
    } catch {
      id = null;
    }
    return profiles.find((p) => p.id === id) ?? profiles[0];
  }

  setProfile(id: string): void {
    try {
      this.ls?.setItem(PROFILE_CURRENT_KEY, id);
    } catch {
      // Stockage indisponible.
    }
  }
}

let current: UserStore = new LocalUserStore();

/** Point d'accroche de l'adaptateur serveur (voir TODO en tête de fichier). */
export function setUserStore(store: UserStore): void {
  current = store;
}

export const userStore: UserStore = new Proxy({} as UserStore, {
  get: (_t, prop) => {
    const v = (current as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
});
