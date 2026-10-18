import { tmdb } from './lt';
import {
  deleteLibrary, getContinue, getLibrary, getTitleProgress, getWatched, putLibrary, putProgress, putWatched, UserApiError,
  type ContinueDto, type LibraryItemDto, type MediaKind, type ProfileDto,
} from './userApi';
import type { LibraryEntry, Profile, ProgressEntry, UserStore, WatchedRef } from './userStore';
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
    this.cont = await this.enrich(cont.items);
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
    putProgress(this.active.id, {
      type: kindOf(entry.type), tmdbId: entry.id, season: entry.season, episode: entry.episode,
      positionSec: Math.floor(entry.position), durationSec: Math.floor(entry.duration),
    }).catch(() => undefined);
  }
  continueWatching(limit = 20): ProgressEntry[] {
    return this.cont.slice(0, limit);
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
