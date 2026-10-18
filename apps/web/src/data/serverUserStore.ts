import { tmdb } from './lt';
import {
  deleteContinue, deleteFollow, deleteLibrary, deleteRating, getContinue, getFollows, getRatings, putFollow, putRating, getLibrary, getTitleProgress, getWatched, putLibrary, putProgress, putWatched, UserApiError,
  type ContinueDto, type LibraryItemDto, type MediaKind, type ProfileDto,
} from './userApi';
import type { FollowEntry, LibraryEntry, Profile, ProgressEntry, RatingEntry, UserStore, WatchedRef } from './userStore';
import { LocalUserStore, progressKey, watchedKey } from './userStore';

/* Adaptateur de l'API utilisateur de lastAddon : lectures synchrones depuis un cache hydraté à la connexion,
 * écritures optimistes envoyées en arrière-plan. Le stockage local reste le repli hors ligne (voir auth). */

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const kindOf = (t: 'movie' | 'tv'): MediaKind => (t === 'tv' ? 'series' : 'movie');
const typeOf = (k: MediaKind): 'movie' | 'tv' => (k === 'series' ? 'tv' : 'movie');

/** Chemin d'affiche TMDB (/abc.jpg) depuis l'URL stockée par le serveur ; vide si l'URL n'est pas TMDB. */
export function posterPathOf(url: string | null): string {
  const m = url ? /\/t\/p\/[^/]+(\/[^/?#]+)$/.exec(url) : null;
  return m ? m[1] : '';
}
export const posterUrlOf = (path: string): string | null => (path ? TMDB_IMG + path : null);

export function libraryFromDto(items: LibraryItemDto[]): LibraryEntry[] {
  // Sans identifiant TMDB (import Stremio sans jeton), un titre ne peut pas s'ouvrir dans l'interface.
  return items
    .filter((i) => i.tmdbId != null)
    .map((i) => ({
      id: i.tmdbId as number,
      type: typeOf(i.type),
      title: i.title,
      poster: posterPathOf(i.poster),
      addedAt: Date.parse(i.addedAt) || 0,
    }));
}

export function profileFromDto(p: ProfileDto): Profile {
  return { id: p.id, name: p.name, avatarColor: p.avatarColor, isKid: p.isKid, kidMaxAge: p.kidMaxAge, hasPin: p.hasPin, allowedCatalogs: p.allowedCatalogs };
}

export class ServerUserStore implements UserStore {
  private library: LibraryEntry[] = [];
  private cont: ProgressEntry[] = [];
  private progress = new Map<string, ProgressEntry>();
  /** Le « vu » par épisode reste local (le serveur ne le propose pas). */
  private local = new LocalUserStore();

  constructor(private profiles: Profile[], private active: Profile) {}

  /** Charge bibliothèque et « Reprendre la lecture » du profil actif. */
  async hydrate(): Promise<void> {
    const id = this.active.id;
    const [lib, cont] = await Promise.all([getLibrary(id), getContinue(id)]);
    this.library = libraryFromDto(lib.items);
    void this.resolveImported(lib.items);
    this.cont = await this.enrich(cont.items);
    await Promise.all([this.loadFollows(), this.loadRatings()]);
  }

  private listeners: Array<() => void> = [];
  subscribe(fn: () => void): void {
    this.listeners.push(fn);
  }
  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  updateLibraryPoster(key: string, posterPath: string): void {
    const e = this.library.find((x) => `${x.type}:${x.id}` === key);
    if (!e || e.poster === posterPath) return;
    e.poster = posterPath;
    putLibrary(this.active.id, kindOf(e.type), e.id, { title: e.title || String(e.id), poster: posterUrlOf(posterPath) }).catch(() => undefined);
  }

  /**
   * Titres importés (Stremio) sans identifiant TMDB : retrouvés un par un via /find (file d'attente à 2 à la fois,
   * en cache côté client), puis enregistrés avec leur affiche sur le profil.
   */
  private async resolveImported(items: LibraryItemDto[]): Promise<void> {
    const todo = items.filter((i) => i.tmdbId == null && i.imdbId);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const i = todo[next++];
        try {
          const found = await tmdb<any>(`find/${i.imdbId}`, { external_source: 'imdb_id' });
          const hit = i.type === 'series' ? found.tv_results?.[0] : found.movie_results?.[0];
          if (!hit) continue;
          const type = typeOf(i.type);
          const entry: LibraryEntry = { id: hit.id, type, title: i.title || hit.title || hit.name || '', poster: hit.poster_path || '', addedAt: Date.parse(i.addedAt) || 0 };
          if (!this.library.some((x) => x.id === entry.id && x.type === type)) this.library.push(entry);
          await putLibrary(this.active.id, i.type, entry.id, { title: entry.title || String(entry.id), poster: posterUrlOf(entry.poster), imdbId: i.imdbId ?? undefined }).catch(() => undefined);
          this.emit();
        } catch {
          // Titre introuvable : il reste masqué.
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  private followsApi = true;
  private ratingsApi = true;

  private async loadFollows(): Promise<void> {
    try {
      const res = await getFollows(this.active.id);
      this.local.replaceFollows(res.items.filter((f) => f.tmdbId != null).map((f): FollowEntry => ({
        type: f.type === 'series' ? 'tv' : f.type, id: f.tmdbId, title: f.title || f.name || '', poster: posterPathOf(f.poster ?? null) || (f.poster ?? ''), addedAt: Date.parse(f.addedAt ?? '') || 0,
      })));
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) this.followsApi = false; // serveur sans cette route : suivis locaux
    }
  }

  private async loadRatings(): Promise<void> {
    try {
      const res = await getRatings(this.active.id);
      this.local.replaceRatings(res.items.filter((r) => r.tmdbId != null).map((r): RatingEntry => ({
        type: r.type === 'series' ? 'tv' : (r.type as 'movie'), id: r.tmdbId, title: r.title || '', year: String(r.year ?? ''), rating: r.rating, updatedAt: Date.parse(r.updatedAt ?? '') || 0,
      })));
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) this.ratingsApi = false;
    }
  }

  // ---- Suivis et notes : cache local immédiat, serveur ensuite, retour arrière si refus ----
  getFollows(type?: FollowEntry['type']): FollowEntry[] {
    return this.local.getFollows(type);
  }
  isFollowing(key: string): boolean {
    return this.local.isFollowing(key);
  }
  async setFollow(entry: Omit<FollowEntry, 'addedAt'>, follow: boolean): Promise<boolean> {
    const before = this.local.getFollows();
    await this.local.setFollow(entry, follow);
    if (!this.followsApi) return true;
    try {
      const kind = entry.type === 'tv' ? 'series' : entry.type;
      if (follow) await putFollow(this.active.id, kind, entry.id, { title: entry.title, poster: entry.type === 'person' ? entry.poster : posterUrlOf(entry.poster) });
      else await deleteFollow(this.active.id, kind, entry.id);
      return true;
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) { this.followsApi = false; return true; }
      this.local.replaceFollows(before);
      return false;
    }
  }
  getRatings(): RatingEntry[] {
    return this.local.getRatings();
  }
  getRating(key: string): number | null {
    return this.local.getRating(key);
  }
  async setRating(entry: Omit<RatingEntry, 'updatedAt' | 'rating'>, rating: number | null): Promise<boolean> {
    const before = this.local.getRatings();
    if (!(await this.local.setRating(entry, rating))) return false;
    if (!this.ratingsApi) return true;
    try {
      const kind = entry.type === 'tv' ? 'series' : 'movie';
      if (rating === null) await deleteRating(this.active.id, kind, entry.id);
      else await putRating(this.active.id, kind, entry.id, { rating, title: entry.title, year: entry.year });
      return true;
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) { this.ratingsApi = false; return true; }
      this.local.replaceRatings(before);
      return false;
    }
  }

  /** Les éléments « continuer » ne portent ni titre ni affiche : TMDB les fournit (en cache côté client). */
  private async enrich(items: ContinueDto[]): Promise<ProgressEntry[]> {
    const out = await Promise.all(items.filter((c) => c.tmdbId != null).slice(0, 12).map(async (c): Promise<ProgressEntry | null> => {
      const type = typeOf(c.type);
      try {
        const raw = await tmdb<any>(`${type}/${c.tmdbId}`);
        return {
          key: `${type}:${c.tmdbId}`, type, id: c.tmdbId as number,
          title: raw.title || raw.name || '', poster: raw.poster_path || '', backdrop: raw.backdrop_path || '',
          season: c.season ?? undefined, episode: c.episode ?? undefined,
          position: c.positionSec, duration: c.durationSec ?? 0, updatedAt: Date.parse(c.updatedAt) || 0,
          suggested: c.suggested || undefined,
        };
      } catch {
        return null;
      }
    }));
    return out.filter((e): e is ProgressEntry => e !== null);
  }

  // ---- Bibliothèque ----
  getLibrary(): LibraryEntry[] {
    return this.library.map((e) => ({ ...e }));
  }
  inLibrary(key: string): boolean {
    return this.library.some((e) => `${e.type}:${e.id}` === key);
  }
  addToLibrary(entry: Omit<LibraryEntry, 'addedAt'> & { addedAt?: number }): void {
    if (this.inLibrary(`${entry.type}:${entry.id}`)) return;
    this.library.push({ ...entry, addedAt: entry.addedAt ?? Date.now() });
    putLibrary(this.active.id, kindOf(entry.type), entry.id, { title: entry.title || String(entry.id), poster: posterUrlOf(entry.poster) }).catch(() => undefined);
  }
  /** Ajout attendu (migration) : le cache n'est mis à jour qu'après la réponse du serveur. */
  async addToLibraryNow(entry: LibraryEntry, profileId: string): Promise<void> {
    await putLibrary(profileId, kindOf(entry.type), entry.id, { title: entry.title || String(entry.id), poster: posterUrlOf(entry.poster) });
    if (!this.inLibrary(`${entry.type}:${entry.id}`)) this.library.push(entry);
  }
  removeFromLibrary(key: string): void {
    const e = this.library.find((x) => `${x.type}:${x.id}` === key);
    if (!e) return;
    this.library = this.library.filter((x) => x !== e);
    deleteLibrary(this.active.id, kindOf(e.type), e.id).catch(() => undefined);
  }
  toggleLibrary(entry: Omit<LibraryEntry, 'addedAt'>): boolean {
    const key = `${entry.type}:${entry.id}`;
    if (this.inLibrary(key)) {
      this.removeFromLibrary(key);
      return false;
    }
    this.addToLibrary(entry);
    return true;
  }

  // ---- Progression ----
  getProgress(key: string, season?: number, episode?: number): ProgressEntry | null {
    return this.progress.get(progressKey(key, season, episode)) ?? null;
  }
  async loadProgress(key: string): Promise<void> {
    const [type, id] = key.split(':');
    try {
      const res = await getTitleProgress(this.active.id, type === 'tv' ? 'series' : 'movie', Number(id));
      res.items.forEach((p) => {
        const e = (this.cont.find((c) => c.key === key) || ({} as Partial<ProgressEntry>));
        this.progress.set(progressKey(key, p.season ?? undefined, p.episode ?? undefined), {
          key, type: type as 'movie' | 'tv', id: Number(id), title: e.title || '', poster: e.poster || '',
          season: p.season ?? undefined, episode: p.episode ?? undefined, position: p.positionSec, duration: p.durationSec, updatedAt: 0,
        });
      });
    } catch {
      // Hors ligne ou profil verrouillé : pas de reprise.
    }
  }
  setProgress(entry: Omit<ProgressEntry, 'updatedAt'>): void {
    const full: ProgressEntry = { ...entry, updatedAt: Date.now() };
    this.progress.set(progressKey(entry.key, entry.season, entry.episode), full);
    this.cont = this.cont.filter((c) => c.key !== entry.key);
    const ratio = entry.duration > 0 ? entry.position / entry.duration : 0;
    if (ratio >= 0.02 && ratio <= 0.95) this.cont.unshift(full);
    else if (ratio > 0.95 && entry.type === 'tv') this.cont.unshift({ ...full, finished: true });
    putProgress(this.active.id, {
      type: kindOf(entry.type), tmdbId: entry.id, season: entry.season, episode: entry.episode,
      positionSec: Math.floor(entry.position), durationSec: Math.floor(entry.duration),
    }).catch(() => undefined);
  }
  continueWatching(limit = 20): ProgressEntry[] {
    return this.cont.slice(0, limit);
  }
  private continueApi = true;
  private hidden: ProgressEntry[] = [];
  async hideContinue(key: string): Promise<boolean> {
    const entry = this.cont.find((c) => c.key === key);
    if (!entry) return true;
    this.cont = this.cont.filter((c) => c.key !== key); // optimiste
    this.hidden.push(entry);
    if (!this.continueApi) return true;
    const [type, id] = key.split(':');
    try {
      await deleteContinue(this.active.id, kindOf(type as 'movie' | 'tv'), Number(id));
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) { this.continueApi = false; return true; } // serveur sans cette route : masqué localement
      this.cont.unshift(entry);
      this.hidden = this.hidden.filter((h) => h !== entry);
      return false;
    }
    return true;
  }
  async showContinue(key: string): Promise<void> {
    const entry = this.hidden.find((h) => h.key === key);
    if (!entry) return;
    this.hidden = this.hidden.filter((h) => h !== entry);
    this.cont.unshift(entry);
    // Côté serveur, le titre revient dès la prochaine lecture (la suppression ne touche pas la progression).
  }

  // ---- Épisodes vus (local) ----
  getSeen(): string[] {
    return this.local.getSeen();
  }
  isSeen(k: string): boolean {
    return this.local.isSeen(k);
  }
  toggleSeen(k: string): boolean {
    return this.local.toggleSeen(k);
  }

  // ---- Vu (film / épisodes) : serveur si disponible, sinon repli local ----
  private watchedApi = true;

  isWatched(key: string, season?: number, episode?: number): boolean {
    return this.local.isWatched(key, season, episode);
  }
  watchedEpisodes(key: string): WatchedRef[] {
    return this.local.watchedEpisodes(key);
  }
  async loadWatched(key: string): Promise<void> {
    if (!this.watchedApi) return;
    const [type, id] = key.split(':');
    try {
      const res = await getWatched(this.active.id, type === 'tv' ? 'series' : 'movie', Number(id));
      if (type === 'tv') {
        const before = this.local.watchedEpisodes(key);
        if (before.length) this.local.applyWatched(key, before, false);
        const done = (res.episodes ?? []).filter((e) => e.finished !== false);
        if (done.length) this.local.applyWatched(key, done.map((e) => ({ season: e.season, episode: e.episode })), true);
      } else {
        this.local.applyWatched(key, null, !!res.movie);
      }
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) this.watchedApi = false; // serveur sans cette route
    }
  }
  async setWatched(key: string, episodes: WatchedRef[] | null, watched: boolean): Promise<boolean> {
    const refs = episodes ?? [];
    const keys = episodes ? refs.map((e) => watchedKey(key, e.season, e.episode)) : [key];
    const before = keys.filter((k) => this.local.getSeen().includes(k));
    this.local.applyWatched(key, episodes, watched); // affichage optimiste
    if (!this.watchedApi) return true;
    const [type, id] = key.split(':');
    try {
      await putWatched(this.active.id, { type: kindOf(type as 'movie' | 'tv'), tmdbId: Number(id), episodes: episodes ?? undefined, watched });
      return true;
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) { this.watchedApi = false; return true; }
      // Refus ou réseau coupé : retour à l'état précédent.
      const was = new Set(before);
      keys.forEach((k) => {
        const e = episodes ? refs[keys.indexOf(k)] : null;
        this.local.applyWatched(key, e ? [e] : null, was.has(k));
      });
      return false;
    }
  }

  // ---- Profils ----
  getProfiles(): Profile[] {
    return this.profiles;
  }
  currentProfile(): Profile {
    return this.active;
  }
  setProfile(id: string): void {
    const p = this.profiles.find((x) => x.id === id);
    if (p) this.active = p;
  }
}
