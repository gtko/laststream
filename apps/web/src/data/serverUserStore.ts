import { tmdb } from './lt';
import {
  deleteContinue, deleteFollow, deleteLibrary, deleteRating, getContinue, getFollows, getRatings, putFollow, putRating, getLibrary, getTitleProgress, getWatched, putLibrary, putProgress, putWatched, UserApiError,
  type ContinueDto, type LibraryItemDto, type MediaKind, type ProfileDto, type ProgressWrite,
} from './userApi';
import { getWatchedTitles, type WatchedDto } from './userApi';
import { watchedTitleFromWire, type WatchedTitle } from './watchedHistory';
import type { FollowEntry, LibraryEntry, Profile, ProgressEntry, RatingEntry, UserStore, WatchedRef } from './userStore';
import { LocalUserStore, progressKey, watchedKey } from './userStore';
import { emitDataEvent, type DataKind } from './events';

/* Adaptateur de l'API utilisateur de lastAddon : lectures synchrones depuis un cache hydraté à la connexion,
 * écritures optimistes envoyées en arrière-plan. Le stockage local reste le repli hors ligne (voir auth). */

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const kindOf = (t: 'movie' | 'tv'): MediaKind => (t === 'tv' ? 'series' : 'movie');
const typeOf = (k: MediaKind): 'movie' | 'tv' => (k === 'series' ? 'tv' : 'movie');
/** Nombre vu d'après la réponse d'un titre : 1 pour un film vu, épisodes terminés hors saison 0 pour une série. */
function watchedCountOf(type: string, res: WatchedDto): number {
  if (type !== 'tv') return res.movie ? 1 : 0;
  return (res.episodes ?? []).filter((e) => e.finished !== false && e.season > 0).length;
}
/** Épisodes par écriture « vu » : le serveur refuse plus de 2 000 épisodes ou plus de 64 ko de JSON par requête. */
const WATCHED_BATCH = 500;
const chunkRefs = (list: WatchedRef[], size: number): WatchedRef[][] => {
  const out: WatchedRef[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

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
  return { id: p.id, name: p.name, avatarColor: p.avatarColor, avatar: p.avatar ?? null, isKid: p.isKid, kidMaxAge: p.kidMaxAge, hasPin: p.hasPin, allowedCatalogs: p.allowedCatalogs, isAdminProfile: p.isAdminProfile === true, isMainProfile: p.isMainProfile };
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
    await Promise.all([this.loadFollows(), this.loadRatings(), this.loadHistory()]);
  }

  /**
   * Relit bibliothèque et « Reprendre la lecture » du profil actif : les changements faits sur un autre appareil ou profil
   * arrivent ainsi sans reconnexion. Si une écriture locale a eu lieu pendant l'appel, le résultat est jeté (le cache local
   * fait foi). Renvoie vrai si le cache a été mis à jour ; les erreurs réseau remontent à l'appelant.
   */
  async refresh(): Promise<boolean> {
    const before = this.writes; // une écriture faite à partir d'ici (même pendant l'attente ci-dessous) fait rejeter le résultat
    await this.settle();
    const id = this.active.id;
    const [lib, cont, watched] = await Promise.all([getLibrary(id), getContinue(id), this.fetchHistory()]);
    const continueList = await this.enrich(cont.items);
    if (before !== this.writes) return false;
    this.library = libraryFromDto(lib.items);
    this.cont = this.withUnsynced(continueList);
    if (watched && !this.watchedInflight) this.adoptHistory(watched);
    emitDataEvent({ kind: 'remote' });
    return true;
  }

  /** Écritures envoyées et pas encore acquittées par le serveur. */
  private inflight = new Set<Promise<unknown>>();
  /** Progressions dont l'envoi a échoué : affichées depuis ce téléphone et renvoyées à la prochaine relecture. */
  private unsynced = new Map<string, { profileId: string; body: ProgressWrite; shown: ProgressEntry | null }>();
  private seq = 0;
  /** Numéro de la dernière écriture de progression de chaque titre : une écriture plus ancienne ne compte plus. */
  private latestSeq = new Map<string, number>();

  /** Écriture envoyée au serveur, suivie jusqu'à sa réponse : une relecture attend qu'elle soit arrivée (voir settle). */
  private send<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => { this.inflight.delete(p); };
    p.then(done, done);
    return p;
  }

  /**
   * Attend que le serveur ait reçu les écritures en vol, puis renvoie les progressions restées sans réponse. Une relecture
   * qui partirait avant renverrait l'ancien état du compte et effacerait la fin de lecture qui vient d'être écrite.
   */
  private async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    for (const [key, u] of [...this.unsynced]) {
      try {
        await putProgress(u.profileId, u.body);
        if (this.unsynced.get(key) === u) this.unsynced.delete(key);
      } catch {
        // Toujours hors ligne : la progression reste affichée depuis ce téléphone.
      }
    }
  }

  /** Le compte ne voit pas encore les progressions non envoyées : elles gardent leur place, la plus récente en tête. */
  private withUnsynced(list: ProgressEntry[]): ProgressEntry[] {
    if (!this.unsynced.size) return list;
    const out = list.filter((e) => !this.unsynced.has(e.key));
    for (const u of this.unsynced.values()) if (u.shown) out.push(u.shown);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Nombre d'écritures locales : une relecture commencée avant une écriture ne doit pas l'écraser. */
  private writes = 0;
  /** Écriture locale : le cache change, les rangées s'y ajustent sans rechargement. */
  private changed(kind: DataKind, key?: string): void {
    this.writes += 1;
    emitDataEvent({ kind, key });
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
    this.send(putLibrary(this.active.id, kindOf(e.type), e.id, { title: e.title || String(e.id), poster: posterUrlOf(posterPath) }).catch(() => undefined));
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
          this.writes += 1; // titre résolu, pas encore confirmé par le serveur : une relecture ne doit pas l'effacer
          await this.send(putLibrary(this.active.id, i.type, entry.id, { title: entry.title || String(entry.id), poster: posterUrlOf(entry.poster), imdbId: i.imdbId ?? undefined }).catch(() => undefined));
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
        const ratio = c.durationSec ? c.positionSec / c.durationSec : 0;
        return {
          key: `${type}:${c.tmdbId}`, type, id: c.tmdbId as number,
          title: raw.title || raw.name || '', poster: raw.poster_path || '', backdrop: raw.backdrop_path || '',
          season: c.season ?? undefined, episode: c.episode ?? undefined,
          position: c.positionSec, duration: c.durationSec ?? 0, updatedAt: Date.parse(c.updatedAt) || 0,
          suggested: c.suggested || undefined,
          // Épisode terminé (plus de 95 %) : la carte propose le suivant, comme après une lecture locale (voir continueWatching).
          finished: type === 'tv' && ratio > 0.95 ? true : undefined,
        };
      } catch {
        return null;
      }
    }));
    return out.filter((e): e is ProgressEntry => e !== null);
  }

  // ---- Historique « vu » : films et séries vus de tout le profil, même hors bibliothèque ----
  /** Historique du serveur, clé `movie:ID` / `tv:ID` ; null tant qu'il n'est pas chargé ou si le serveur ne le propose pas. */
  private history: Map<string, WatchedTitle> | null = null;
  private watchedTitlesApi = true;
  /** Écritures « vu » en cours d'envoi : une relecture de l'historique n'écrase pas leur effet optimiste. */
  private watchedInflight = 0;

  /** Relit l'historique du profil ; null si le serveur ne l'a pas fourni (route absente, réseau coupé). */
  private async fetchHistory(): Promise<WatchedTitle[] | null> {
    if (!this.watchedTitlesApi) return null;
    try {
      const res = await getWatchedTitles(this.active.id);
      return res.items.map(watchedTitleFromWire).filter((t): t is WatchedTitle => t !== null);
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) this.watchedTitlesApi = false; // serveur sans cette route : historique local
      return null;
    }
  }

  private async loadHistory(): Promise<void> {
    const list = await this.fetchHistory();
    if (list) this.adoptHistory(list);
  }

  /** Remplace l'historique par celui du serveur ; les films vus côté serveur (y compris terminés en lecture) gagnent le « vu » de ce téléphone. */
  private adoptHistory(list: WatchedTitle[]): void {
    this.history = new Map(list.map((t) => [t.key, t]));
    for (const t of list) if (t.type === 'movie' && !this.local.isWatched(t.key)) this.local.applyWatched(t.key, null, true);
  }

  watchedTitles(): WatchedTitle[] {
    return this.history ? [...this.history.values()] : this.local.watchedTitles();
  }

  watchedTitle(key: string): WatchedTitle | null {
    return this.history ? this.history.get(key) ?? null : this.local.watchedTitle(key);
  }

  /** Fixe le nombre vu d'un titre (0 le retire). `now` : vu à l'instant, le titre remonte en tête. */
  private applyHistoryCount(key: string, count: number, now = false): void {
    if (!this.history) return;
    if (count <= 0) {
      this.history.delete(key);
      return;
    }
    const cur = this.history.get(key);
    const [type, id] = key.split(':');
    this.history.set(key, { key, type: type === 'tv' ? 'tv' : 'movie', id: Number(id), watched: count, lastWatchedAt: now ? Date.now() : cur?.lastWatchedAt ?? 0 });
  }

  /** Estimation immédiate d'une écriture « vu », avant la réponse du serveur ; `reconcileWatched` la corrige ensuite. */
  private patchHistory(key: string, episodes: WatchedRef[] | null, watched: boolean): void {
    if (!this.history) return;
    if (!key.startsWith('tv:')) {
      this.applyHistoryCount(key, watched ? 1 : 0, watched);
      return;
    }
    if (!episodes) return; // série entière sans liste d'épisodes : la relecture fera foi
    // Appelée avant l'écriture locale : `isWatched` lit encore l'état d'avant. Un épisode déjà vu sur ce téléphone n'est pas recompté.
    const real = episodes.filter((e) => e.season > 0);
    const cur = this.history.get(key)?.watched ?? 0;
    const next = watched
      ? cur + Math.max(0, real.length - real.filter((e) => this.local.isWatched(key, e.season, e.episode)).length)
      : Math.max(0, cur - real.length);
    this.applyHistoryCount(key, next, watched);
  }

  /**
   * Recale le compte d'un titre sur le serveur (après une écriture ou une fin de lecture). Le « vu » local des épisodes n'est
   * pas réécrit : l'écriture l'a déjà appliqué. Un film suit le serveur. Hors ligne : l'estimation reste en place.
   */
  private async reconcileWatched(key: string): Promise<void> {
    if (!this.watchedApi) return;
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    const [type, id] = key.split(':');
    try {
      const res = await getWatched(this.active.id, type === 'tv' ? 'series' : 'movie', Number(id));
      const count = watchedCountOf(type, res);
      if (type !== 'tv') this.local.applyWatched(key, null, count > 0);
      this.applyHistoryCount(key, count);
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) this.watchedApi = false; // serveur sans cette route
    }
    emitDataEvent({ kind: 'watched', key });
  }

  /** Écriture « vu » : affichage optimiste dans l'historique, envoi, puis retour arrière si le serveur refuse. */
  async setWatched(key: string, episodes: WatchedRef[] | null, watched: boolean): Promise<boolean> {
    const before = this.history?.get(key) ?? null;
    this.patchHistory(key, episodes, watched);
    this.watchedInflight += 1;
    let ok = false;
    try {
      ok = await this.sendWatched(key, episodes, watched);
      return ok;
    } finally {
      this.watchedInflight -= 1;
      if (!ok && this.history) {
        if (before) this.history.set(key, before);
        else this.history.delete(key);
        emitDataEvent({ kind: 'watched', key });
      }
      void this.reconcileWatched(key);
    }
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
    this.send(putLibrary(this.active.id, kindOf(entry.type), entry.id, { title: entry.title || String(entry.id), poster: posterUrlOf(entry.poster) }).catch(() => undefined));
    this.changed('library', `${entry.type}:${entry.id}`);
  }
  /** Ajout attendu (migration) : le cache n'est mis à jour qu'après la réponse du serveur. */
  async addToLibraryNow(entry: LibraryEntry, profileId: string): Promise<void> {
    await this.send(putLibrary(profileId, kindOf(entry.type), entry.id, { title: entry.title || String(entry.id), poster: posterUrlOf(entry.poster) }));
    if (!this.inLibrary(`${entry.type}:${entry.id}`)) this.library.push(entry);
    this.changed('library', `${entry.type}:${entry.id}`);
  }
  removeFromLibrary(key: string): void {
    const e = this.library.find((x) => `${x.type}:${x.id}` === key);
    if (!e) return;
    this.library = this.library.filter((x) => x !== e);
    this.send(deleteLibrary(this.active.id, kindOf(e.type), e.id).catch(() => undefined));
    this.changed('library', key);
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
    const prev = this.progress.get(progressKey(entry.key, entry.season, entry.episode));
    this.progress.set(progressKey(entry.key, entry.season, entry.episode), full);
    this.cont = this.cont.filter((c) => c.key !== entry.key);
    const ratio = entry.duration > 0 ? entry.position / entry.duration : 0;
    // Fin de lecture (plus de 95 %) : le serveur marque le titre vu ; l'historique suit, une seule fois au passage.
    if (ratio > 0.95 && !(prev && prev.duration > 0 && prev.position / prev.duration > 0.95)) {
      if (entry.type === 'movie') this.applyHistoryCount(entry.key, 1, true);
      void this.reconcileWatched(entry.key);
    }
    const shown: ProgressEntry | null = ratio >= 0.02 && ratio <= 0.95 ? full : ratio > 0.95 && entry.type === 'tv' ? { ...full, finished: true } : null;
    if (shown) this.cont.unshift(shown);
    const seq = ++this.seq;
    this.latestSeq.set(entry.key, seq);
    this.unsynced.delete(entry.key);
    const profileId = this.active.id;
    const body: ProgressWrite = {
      type: kindOf(entry.type), tmdbId: entry.id, season: entry.season, episode: entry.episode,
      positionSec: Math.floor(entry.position), durationSec: Math.floor(entry.duration),
    };
    this.send(putProgress(profileId, body).catch(() => {
      // Refusée ou réseau coupé : gardée à l'écran et renvoyée à la prochaine relecture, si c'est encore la dernière écriture du titre.
      if (this.latestSeq.get(entry.key) === seq) this.unsynced.set(entry.key, { profileId, body, shown });
    }));
    this.changed('progress', entry.key);
  }
  continueWatching(limit = Infinity): ProgressEntry[] {
    return this.cont.slice(0, limit);
  }
  private continueApi = true;
  private hidden: ProgressEntry[] = [];
  async hideContinue(key: string): Promise<boolean> {
    const entry = this.cont.find((c) => c.key === key);
    if (!entry) return true;
    this.cont = this.cont.filter((c) => c.key !== key); // optimiste
    this.unsynced.delete(key); // une progression pas encore envoyée ne doit pas revenir avec la prochaine relecture
    this.hidden.push(entry);
    this.changed('continue', key);
    if (!this.continueApi) return true;
    const [type, id] = key.split(':');
    try {
      await this.send(deleteContinue(this.active.id, kindOf(type as 'movie' | 'tv'), Number(id)));
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) { this.continueApi = false; return true; } // serveur sans cette route : masqué localement
      this.cont.unshift(entry);
      this.hidden = this.hidden.filter((h) => h !== entry);
      this.changed('continue', key);
      return false;
    }
    return true;
  }
  async showContinue(key: string): Promise<void> {
    const entry = this.hidden.find((h) => h.key === key);
    if (!entry) return;
    this.hidden = this.hidden.filter((h) => h !== entry);
    this.cont.unshift(entry);
    this.changed('continue', key);
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
      this.applyHistoryCount(key, watchedCountOf(type, res));
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) this.watchedApi = false; // serveur sans cette route
    }
  }
  private async sendWatched(key: string, episodes: WatchedRef[] | null, watched: boolean): Promise<boolean> {
    const refs = episodes ?? [];
    const keys = episodes ? refs.map((e) => watchedKey(key, e.season, e.episode)) : [key];
    const before = keys.filter((k) => this.local.getSeen().includes(k));
    this.local.applyWatched(key, episodes, watched); // affichage optimiste
    this.changed('watched', key);
    if (!this.watchedApi) return true;
    const [type, id] = key.split(':');
    const kind = kindOf(type as 'movie' | 'tv');
    // Le serveur accepte 2 000 épisodes et 64 ko par requête : une longue série part en lots, dans l'ordre.
    const parts: Array<WatchedRef[] | undefined> = episodes && episodes.length > WATCHED_BATCH ? chunkRefs(episodes, WATCHED_BATCH) : [episodes ?? undefined];
    const sent: WatchedRef[][] = [];
    try {
      for (const part of parts) {
        await putWatched(this.active.id, { type: kind, tmdbId: Number(id), episodes: part, watched });
        if (part) sent.push(part);
      }
      return true;
    } catch (err) {
      if (err instanceof UserApiError && err.status === 404) { this.watchedApi = false; return true; }
      // Refus ou réseau coupé : retour à l'état précédent, et annulation des lots déjà acceptés par le serveur.
      console.warn('[laststream] vu : écriture refusée par lastAddon', err);
      const was = new Set(before);
      keys.forEach((k, i) => {
        const e = episodes ? refs[i] : null;
        this.local.applyWatched(key, e ? [e] : null, was.has(k));
      });
      for (const part of sent) {
        const undo = part.filter((e) => was.has(watchedKey(key, e.season, e.episode)) !== watched);
        if (undo.length) await putWatched(this.active.id, { type: kind, tmdbId: Number(id), episodes: undo, watched: !watched }).catch(() => undefined);
      }
      this.changed('watched', key);
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
