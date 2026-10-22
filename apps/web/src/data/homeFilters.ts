import { isFullyWatched, type SeenStore } from './seen';
import { userStore } from './userStore';
import { isAnime } from './anime';

/*
 * Filtres d'accueil propres à chaque profil : titres « Ne plus proposer », genres bannis, séries marquées vues en entier.
 * Stockés par profil sur ce navigateur et synchronisés avec le compte (réglages du profil, clés `home…`, découpées en
 * morceaux de moins de 3500 octets UTF-8). Au login, les filtres locaux et ceux du compte sont fusionnés, puis l'union
 * est renvoyée au compte. Les envois sont groupés (600 ms) et ne contiennent que les clés qui changent.
 * Un seul point de filtrage pour l'accueil : `keepVisible`.
 */

export interface HiddenEntry {
  /** Clé de titre : `movie:550` ou `tv:1399`. */
  key: string;
  title: string;
  /** Chemin d'affiche TMDB (réglages : liste des titres masqués). */
  poster: string;
  addedAt: number;
}

/** Clés des catégories dérivées (hors genres TMDB) : stables, stockées à côté des identifiants numériques. */
export const DERIVED_KEYS = ['anime', 'kdrama', 'bollywood', 'chinese', 'telenovela', 'classics'] as const;
export type DerivedKey = (typeof DERIVED_KEYS)[number];
/** Genre banni : identifiant TMDB (nombre) ou catégorie dérivée (clé). */
export type GenreKey = number | DerivedKey;

export interface HomeFilters {
  hidden: HiddenEntry[];
  /** Genres bannis : identifiants TMDB (films et séries) et clés de catégories dérivées. */
  genres: GenreKey[];
  /** Clés `tv:ID` des séries marquées vues en entier. */
  completed: string[];
}

/** Champs lus par le filtre, tous optionnels : genres TMDB, langue et pays d'origine, date de sortie ou de première diffusion. */
export interface ItemFacts {
  genreIds?: number[];
  /** `original_language` TMDB (ISO 639-1, ex. `ja`). */
  originalLanguage?: string;
  /** `origin_country` TMDB, séries surtout (ISO 3166-1, ex. `JP`). */
  originCountry?: string[];
  /** Date de sortie ou de première diffusion (`AAAA-MM-JJ`). */
  date?: string;
}

/** Élément affichable sur l'accueil : titre (clé, type, identifiant) et champs du filtre si connus. */
export interface HomeItemLike extends ItemFacts {
  key?: string;
  type: 'movie' | 'tv';
  id: number;
}

/** Genres proposés dans les réglages (libellés français). Les doublons TMDB (films / séries) partagent une puce. */
export const GENRE_OPTIONS: ReadonlyArray<{ label: string; ids: GenreKey[] }> = [
  { label: 'Action', ids: [28, 10759] },
  { label: 'Aventure', ids: [12] },
  { label: 'Animation', ids: [16] },
  { label: 'Anime', ids: ['anime'] },
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
  { label: 'Télénovelas', ids: ['telenovela'] },
  { label: 'Talk-show', ids: [10767] },
  { label: 'Téléréalité', ids: [10764] },
  { label: 'Actualités', ids: [10763] },
  { label: 'K-drama', ids: ['kdrama'] },
  { label: 'Bollywood (cinéma indien)', ids: ['bollywood'] },
  { label: 'Cinéma chinois', ids: ['chinese'] },
  { label: 'Classiques (avant 1980)', ids: ['classics'] },
];

const isDerivedKey = (g: unknown): g is DerivedKey => typeof g === 'string' && (DERIVED_KEYS as readonly string[]).includes(g);
/** Vrai pour un identifiant TMDB entier ou une clé dérivée connue ; le reste est écarté à la lecture. */
export const isGenreKey = (g: unknown): g is GenreKey => (typeof g === 'number' && Number.isInteger(g)) || isDerivedKey(g);

const INDIAN_LANGUAGES: readonly string[] = ['hi', 'ta', 'te', 'ml', 'kn'];
const CHINESE_LANGUAGES: readonly string[] = ['zh', 'cn'];
const TELENOVELA_LANGUAGES: readonly string[] = ['es', 'pt'];

/** Année de sortie ou de première diffusion, ou null si la date est inconnue. */
const yearOf = (date: string | undefined): number | null => {
  const m = /^(\d{4})-/.exec(date ?? '');
  return m ? Number(m[1]) : null;
};

/**
 * Catégories dérivées : TMDB n'a ni genre « anime », ni « K-drama », ni « télénovela ». Un élément dont l'information
 * manque n'est jamais exclu (pas de faux positif).
 */
const DERIVED: Record<DerivedKey, (it: ItemFacts) => boolean> = {
  anime: isAnime,
  kdrama: (it) => it.originalLanguage === 'ko',
  bollywood: (it) => INDIAN_LANGUAGES.includes(it.originalLanguage ?? ''),
  chinese: (it) => CHINESE_LANGUAGES.includes(it.originalLanguage ?? ''),
  telenovela: (it) => (it.genreIds ?? []).includes(10766) && TELENOVELA_LANGUAGES.includes(it.originalLanguage ?? ''),
  classics: (it) => {
    const year = yearOf(it.date);
    return year !== null && year < 1980;
  },
};

/** Ordre stable des genres : identifiants TMDB croissants, puis clés dérivées par ordre alphabétique. */
const sortGenres = (list: GenreKey[]): GenreKey[] => [...list].sort((a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a.localeCompare(b);
});

export const HOME_FILTERS_KEY_PREFIX = 'laststream.homeFilters.';
/** Morceaux par liste dans les réglages du compte. */
export const MAX_CHUNKS = 12;
/** Taille maximale d'un morceau, en octets UTF-8 (marge sous la limite de 4 Ko par valeur). */
export const CHUNK_MAX_BYTES = 3500;
/** Délai d'anti-rebond avant l'envoi au compte : seul le dernier état compte. */
export const SYNC_DELAY_MS = 600;
const TITLE_MAX = 60;
const POSTER_MAX = 40;
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
/** Envoie des réglages au profil ; renvoie faux (ou une promesse fausse) si le compte a refusé. */
export type Pusher = (profileId: string, settings: Record<string, unknown>) => Promise<boolean> | boolean | void;
let pusher: Pusher | null = null;
export function setFiltersPusher(fn: Pusher | null): void {
  pusher = fn;
}

// ---------- Stockage serveur des titres masqués (API /user/profiles/:id/hidden) ----------
/**
 * Titres masqués côté serveur, par profil (jusqu'à 20 000, paginés). Quand il est branché et chargé pour le profil actif,
 * la liste vit en mémoire (ensemble de filtrage de l'accueil) et chaque changement part vers l'API ; les anciens réglages
 * `homeHidden*` ne sont plus écrits (le serveur les importe au premier accès).
 */
export interface HiddenBackend {
  /** Toute la liste, de la plus ancienne entrée à la plus récente. */
  load(profileId: string): Promise<HiddenEntry[]>;
  put(profileId: string, entries: HiddenEntry[]): Promise<boolean>;
  remove(profileId: string, keys: string[]): Promise<boolean>;
}
/** Plafond serveur de titres masqués par profil. */
export const SERVER_HIDDEN_MAX = 20_000;
/** Taille d'un envoi vers l'API (500 au plus par appel). */
export const SERVER_BATCH = 500;
let hiddenBackend: HiddenBackend | null = null;
/** Profil dont la liste serveur est chargée en mémoire (sinon : stockage par morceaux dans les réglages, comme avant). */
let serverReady: string | null = null;
export function setHiddenBackend(b: HiddenBackend | null): void {
  hiddenBackend = b;
  serverReady = null;
  cache = null;
}
/** Vrai quand les titres masqués du profil actif viennent de l'API. */
export const hiddenOnServer = (): boolean => hiddenBackend !== null && serverReady !== null && serverReady === profileId();

const encoder = new TextEncoder();
/** Taille UTF-8 d'une valeur sérialisée en JSON (un titre japonais pèse 3 octets par caractère). */
export const byteSize = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? 'null').length;

/** Découpe en morceaux de moins de CHUNK_MAX_BYTES octets, sans limite de nombre. */
export function chunkItems(items: readonly unknown[]): unknown[][] {
  const out: unknown[][] = [];
  let cur: unknown[] = [];
  for (const it of items) {
    if (cur.length && byteSize([...cur, it]) > CHUNK_MAX_BYTES) {
      out.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Vrai si la liste tient dans les morceaux disponibles. */
export const fitsChunks = (items: readonly unknown[]): boolean => chunkItems(items).length <= MAX_CHUNKS;

/** Morceaux à envoyer : au-delà de MAX_CHUNKS, le surplus n'est pas envoyé et un avertissement est écrit dans la console. */
function splitChunks(items: readonly unknown[], name: string): unknown[][] {
  const parts = chunkItems(items);
  if (parts.length > MAX_CHUNKS) {
    console.warn(`[laststream] réglages de l’accueil : « ${name} » tient en ${parts.length} morceaux (${MAX_CHUNKS} au plus) ; le surplus n’est pas envoyé au compte.`);
  }
  return parts.slice(0, MAX_CHUNKS);
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
  const hidden = Array.isArray(r.hidden) ? r.hidden.filter(isHiddenEntry) : [];
  const genres = Array.isArray(r.genres) ? [...new Set(r.genres.filter(isGenreKey))] : [];
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
    storage()?.setItem(HOME_FILTERS_KEY_PREFIX + id, JSON.stringify(serverReady === id ? { ...f, hidden: [] } : f));
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

/** Réinitialise l'état mémoire : cache, envois en attente et état connu du compte (tests, déconnexion). */
export function resetFiltersCache(): void {
  cache = null;
  serverReady = null;
  hiddenBackend = null;
  pendingTimers.forEach((t) => clearTimeout(t));
  pendingTimers.clear();
  pendingState.clear();
  accountKeys.clear();
}

// ---------- Envoi groupé : anti-rebond, clés modifiées seulement ----------
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingState = new Map<string, HomeFilters>();
/** Clé de réglage -> JSON de ce que le compte détient (ou a reçu). Absent : état du compte inconnu. */
const accountKeys = new Map<string, Record<string, string>>();

const jsonOf = (v: unknown): string => JSON.stringify(v) ?? 'null';

/**
 * Réglages qui diffèrent de ce que le compte détient déjà (tous, si son état n'est pas connu). Un morceau devenu inutile
 * part à null pour être effacé côté compte.
 */
export function changedSettings(id: string, f: HomeFilters): Record<string, unknown> {
  const packed = packFilters(f, serverReady !== id);
  const known = accountKeys.get(id);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(packed)) {
    if (!known || known[k] !== jsonOf(v)) out[k] = v;
  }
  accountKeys.set(id, Object.fromEntries(Object.entries(packed).map(([k, v]) => [k, jsonOf(v)])));
  return out;
}

function send(id: string, settings: Record<string, unknown>): void {
  if (!pusher || !Object.keys(settings).length) return;
  Promise.resolve(pusher(id, settings)).then(
    (ok) => { if (ok === false) accountKeys.delete(id); }, // refus : le prochain envoi repartira de zéro
    () => { accountKeys.delete(id); },
  );
}

function schedule(id: string, f: HomeFilters): void {
  pendingState.set(id, f);
  const t = pendingTimers.get(id);
  if (t) clearTimeout(t);
  pendingTimers.set(id, setTimeout(() => flushSync(id), SYNC_DELAY_MS));
}

/** Envoie tout de suite les réglages en attente (de tous les profils, ou d'un seul). */
export function flushSync(id?: string): void {
  for (const pid of id ? [id] : [...pendingState.keys()]) {
    const t = pendingTimers.get(pid);
    if (t) clearTimeout(t);
    pendingTimers.delete(pid);
    const f = pendingState.get(pid);
    pendingState.delete(pid);
    if (f && pusher) send(pid, changedSettings(pid, f));
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushSync());
}

function save(id: string, f: HomeFilters): void {
  cache = { id, f };
  writeLocal(id, f);
  schedule(id, f);
  notifyHomeChange();
}

// ---------- Envois vers l'API des titres masqués ----------
const batches = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += SERVER_BATCH) out.push(items.slice(i, i + SERVER_BATCH));
  return out;
};

let serverRetryMs = 4000;
/** Délai avant la nouvelle tentative d'un envoi échoué (réglable pour les tests). */
export function setServerRetryDelay(ms: number): void {
  serverRetryMs = ms;
}

/** Envois en série (l'ordre des masquages et réaffichages compte) ; un échec est retenté une fois. */
let serverQueue: Promise<unknown> = Promise.resolve();
function enqueue(task: () => Promise<boolean>): void {
  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (await task()) return;
      } catch { /* retenté ci-dessous */ }
      if (attempt === 0) await new Promise((r) => setTimeout(r, serverRetryMs));
    }
    console.warn('[laststream] titres masqués : l’envoi au compte a échoué.');
  };
  serverQueue = serverQueue.then(run, run);
}
/** Attend la fin des envois en cours (tests, fermeture). */
export const hiddenIdle = (): Promise<unknown> => serverQueue;

function serverPut(id: string, entries: readonly HiddenEntry[]): void {
  const backend = hiddenBackend;
  if (!backend) return;
  for (const part of batches(entries)) enqueue(() => backend.put(id, part));
}

function serverRemove(id: string, keys: readonly string[]): void {
  const backend = hiddenBackend;
  if (!backend) return;
  for (const part of batches(keys)) enqueue(() => backend.remove(id, part));
}

/**
 * Charge (paginé) les titres masqués du profil depuis l'API : ensemble en mémoire pour l'accueil. Les titres masqués
 * encore gardés dans ce navigateur par une ancienne version sont envoyés au compte, puis retirés du stockage local.
 * Renvoie faux si l'API est injoignable (le stockage par réglages reste alors utilisé).
 */
export async function loadServerHidden(id: string): Promise<boolean> {
  const backend = hiddenBackend;
  if (!backend) return false;
  let remote: HiddenEntry[];
  try {
    remote = await backend.load(id);
  } catch {
    return false;
  }
  const local = readLocal(id);
  const have = new Set(remote.map((h) => h.key));
  const extra = local.hidden.filter((h) => !have.has(h.key));
  const all = [...remote, ...extra].sort((a, b) => a.addedAt - b.addedAt);
  serverReady = id;
  cache = { id, f: { ...local, hidden: all } };
  writeLocal(id, cache.f); // sans masqués : la liste vit sur le compte
  if (extra.length) serverPut(id, extra);
  notifyHomeChange();
  return true;
}

// ---------- Actions ----------
/** Ne plus proposer un titre sur l'accueil. Faux si la liste ne tient plus dans les morceaux du compte. */
export function hideTitle(entry: { key: string; title: string; poster?: string }): boolean {
  const id = profileId();
  const f = currentFilters();
  if (f.hidden.some((h) => h.key === entry.key)) return true;
  if (!KEY_RE.test(entry.key)) return false;
  const hiddenEntry: HiddenEntry = { key: entry.key, title: entry.title.slice(0, TITLE_MAX), poster: (entry.poster ?? '').slice(0, POSTER_MAX), addedAt: Date.now() };
  const next = { ...f, hidden: [...f.hidden, hiddenEntry] };
  if (hiddenOnServer()) {
    if (next.hidden.length > SERVER_HIDDEN_MAX) return false;
    save(id, next);
    serverPut(id, [hiddenEntry]);
    return true;
  }
  if (!fitsCapacity(next)) return false;
  save(id, next);
  return true;
}

/** Vrai si les filtres tiennent dans les morceaux du compte. */
export const fitsCapacity = (f: HomeFilters): boolean => fitsChunks(f.hidden) && fitsChunks(f.completed);

/** Titres masqués du profil actif, en lecture seule (les changer passe par hideTitle, unhideTitle, unhideTitles). */
export const hiddenTitles = (): readonly HiddenEntry[] => currentFilters().hidden;

/**
 * Réaffiche plusieurs titres d'un coup : un seul enregistrement, donc un seul envoi au compte. Renvoie les entrées retirées
 * (pour l'annulation) ; une liste vide si aucune clé ne correspond.
 */
export function unhideTitles(keys: Iterable<string>): HiddenEntry[] {
  const f = currentFilters();
  const want = new Set(keys);
  const removed = f.hidden.filter((h) => want.has(h.key));
  if (removed.length) {
    save(profileId(), { ...f, hidden: f.hidden.filter((h) => !want.has(h.key)) });
    if (hiddenOnServer()) serverRemove(profileId(), removed.map((h) => h.key));
  }
  return removed;
}

/** Remet des titres réaffichés (annulation), à leur place d'origine. Faux si la liste ne tient plus dans les morceaux du compte. */
export function restoreHidden(entries: readonly HiddenEntry[]): boolean {
  const f = currentFilters();
  const have = new Set(f.hidden.map((h) => h.key));
  const back = entries.filter((h) => KEY_RE.test(h.key) && !have.has(h.key));
  if (!back.length) return true;
  const next = { ...f, hidden: [...f.hidden, ...back].sort((a, b) => a.addedAt - b.addedAt) };
  if (hiddenOnServer()) {
    if (next.hidden.length > SERVER_HIDDEN_MAX) return false;
    save(profileId(), next);
    serverPut(profileId(), back);
    return true;
  }
  if (!fitsCapacity(next)) return false;
  save(profileId(), next);
  return true;
}

/** Réaffiche un titre masqué. Renvoie l'entrée retirée (pour l'annulation), ou null. */
export function unhideTitle(key: string): HiddenEntry | null {
  return unhideTitles([key])[0] ?? null;
}

export const isHiddenKey = (key: string): boolean => currentFilters().hidden.some((h) => h.key === key);

/** Bannit (ou lève le bannissement de) plusieurs genres, par exemple les deux ids d'une même puce. */
export function setGenreBanned(ids: GenreKey[], banned: boolean): void {
  const f = currentFilters();
  const keys = ids.filter(isGenreKey);
  const genres = banned ? [...new Set([...f.genres, ...keys])] : f.genres.filter((g) => !keys.includes(g));
  save(profileId(), { ...f, genres });
}

export const bannedGenreIds = (): Set<GenreKey> => new Set(currentFilters().genres);

/** Vrai si un élément porte un genre banni : identifiant TMDB dans `genreIds`, ou catégorie dérivée qui le décrit. */
export function isBannedGenre(item: ItemFacts, banned: ReadonlySet<GenreKey> = bannedGenreIds()): boolean {
  const ids = item.genreIds ?? [];
  for (const g of banned) {
    if (typeof g === 'number' ? ids.includes(g) : DERIVED[g](item)) return true;
  }
  return false;
}

/** Champs que lisent les filtres, depuis un résultat TMDB brut (listes, tendances, recherche, moteur de collections). */
export function homeFacts(raw: Record<string, unknown>): ItemFacts & { genreIds: number[] } {
  return {
    genreIds: Array.isArray(raw.genre_ids) ? raw.genre_ids.filter((g): g is number => typeof g === 'number') : [],
    originalLanguage: typeof raw.original_language === 'string' ? raw.original_language : undefined,
    originCountry: Array.isArray(raw.origin_country) ? raw.origin_country.filter((c): c is string => typeof c === 'string') : undefined,
    date: String(raw.release_date || raw.first_air_date || ''),
  };
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
 * (bannière, rangées, Top 10, IA, « Prochainement », « Tout voir », « Reprendre la lecture »). Ne pas l'appeler pour
 * « Cette semaine dans tes suivis », la bibliothèque, le calendrier, la recherche, la fiche ou les pages personne.
 */
export function keepVisible<T extends HomeItemLike>(items: readonly T[] | null | undefined): T[] {
  if (!items || !items.length) return [];
  const visible = homeVisibility(userStore, currentFilters());
  return items.filter((it) => visible(it));
}

// ---------- Réglages du profil (sérialisation) ----------
function putChunks(out: Record<string, unknown>, name: string, items: readonly unknown[]): void {
  const parts = splitChunks(items, name);
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
export function packFilters(f: HomeFilters, withHidden = true): Record<string, unknown> {
  const out: Record<string, unknown> = { homeGenres: f.genres };
  if (withHidden) putChunks(out, 'homeHidden', f.hidden);
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

const canonical = (f: HomeFilters): string => jsonOf({
  h: [...f.hidden].sort((a, b) => a.key.localeCompare(b.key)),
  g: sortGenres(f.genres),
  c: [...f.completed].sort(),
});

/** Vrai si deux jeux de filtres sont identiques (sans tenir compte de l'ordre). */
export const sameFilters = (a: HomeFilters, b: HomeFilters): boolean => canonical(a) === canonical(b);

/**
 * Union de deux jeux de filtres (locaux et compte) : titres masqués (le plus récent gagne pour un même titre), genres bannis
 * et séries vues en entier réunis. Si les titres masqués ne tiennent plus dans les morceaux, les plus anciens sont écartés
 * avec un avertissement dans la console.
 */
export function mergeFilters(a: HomeFilters, b: HomeFilters): HomeFilters {
  const byKey = new Map<string, HiddenEntry>();
  for (const h of [...a.hidden, ...b.hidden]) {
    const cur = byKey.get(h.key);
    if (!cur || h.addedAt > cur.addedAt) byKey.set(h.key, h);
  }
  let hidden = [...byKey.values()].sort((x, y) => x.addedAt - y.addedAt || x.key.localeCompare(y.key));
  const before = hidden.length;
  while (hidden.length && !fitsChunks(hidden)) hidden = hidden.slice(1);
  if (hidden.length < before) console.warn(`[laststream] ${before - hidden.length} titre(s) masqué(s) les plus anciens écartés à la fusion : capacité du compte atteinte.`);
  return {
    hidden,
    genres: sortGenres([...new Set([...a.genres, ...b.genres])]),
    completed: [...new Set([...a.completed, ...b.completed])].sort(),
  };
}

/**
 * À la connexion à un profil : les filtres locaux et ceux du compte sont fusionnés (union), enregistrés ici, puis l'union
 * est renvoyée au compte si elle diffère de ce qu'il détient. Renvoie vrai si les filtres locaux ont changé.
 */
export function applyAccountFilters(id: string, settings: Record<string, unknown>): boolean {
  const onServer = serverReady === id;
  // Liste sur le compte : seuls les genres bannis et les séries vues passent par les réglages ; les masqués viennent de l'API.
  const keepHidden = onServer && cache?.id === id ? cache.f.hidden : [];
  const local = onServer ? { ...readLocal(id), hidden: keepHidden } : readLocal(id);
  const remoteRaw = unpackFilters(settings);
  const remote = onServer && remoteRaw ? { ...remoteRaw, hidden: keepHidden } : remoteRaw;
  const merged = remote && onServer ? { ...mergeFilters({ ...local, hidden: [] }, { ...remote, hidden: [] }), hidden: keepHidden } : remote ? mergeFilters(local, remote) : local;
  const changed = !sameFilters(merged, local);
  cache = { id, f: merged };
  writeLocal(id, merged);
  if (remote) accountKeys.set(id, Object.fromEntries(Object.entries(packFilters(remote, !onServer)).map(([k, v]) => [k, jsonOf(v)])));
  else accountKeys.delete(id);
  if (pusher && hasAny(merged) && (!remote || !sameFilters(merged, remote))) send(id, changedSettings(id, merged));
  if (changed) notifyHomeChange();
  return changed;
}
