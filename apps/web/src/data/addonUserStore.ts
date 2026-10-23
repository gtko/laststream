/* Bibliothèque et progression des titres d'addons Stremio (ODY-252), stockées à part de `userStore`.
 * Pourquoi : la clé de bibliothèque `LibraryEntry.id` est numérique (TMDB) et `ui/continue.js` découpe les clés de progression
 * sur `:` ; un id d'addon (`fk:123`) casserait les deux. Local à l'appareil, sans synchronisation avec le serveur. */

export const ADDON_LIBRARY_KEY = 'laststream.addonLibrary';
export const ADDON_PROGRESS_KEY = 'laststream.addonProgress';

export interface AddonLibraryEntry {
  /** `addon:<type>:<id>` (voir `addonTitleKey`). */
  key: string;
  /** Clé de l'addon dans le registre (`addonKeyOf`). */
  addonKey: string;
  type: string;
  id: string;
  title: string;
  poster?: string;
  year?: string;
  addedAt: number;
}

export interface AddonProgress {
  /** Position et durée (secondes). */
  t: number;
  d: number;
  /** Moment de l'enregistrement (ms). */
  at: number;
  episode?: { season: number; episode: number };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const addonTitleKey = (type: string, id: string): string => `addon:${type}:${id}`;

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Stockage indisponible ou plein : rien n'est conservé, l'app reste utilisable.
  }
}

const isLibraryEntry = (v: unknown): v is AddonLibraryEntry =>
  isObject(v) && typeof v.key === 'string' && typeof v.addonKey === 'string' && typeof v.type === 'string'
  && typeof v.id === 'string' && typeof v.title === 'string' && isNum(v.addedAt);

/** Bibliothèque des titres d'addons, la plus récente d'abord. Illisible ou mal formée : liste vide, sans exception. */
export function readAddonLibrary(): AddonLibraryEntry[] {
  const data = readJson(ADDON_LIBRARY_KEY);
  if (!Array.isArray(data)) return [];
  return data.filter(isLibraryEntry).sort((a, b) => b.addedAt - a.addedAt);
}

export function isInAddonLibrary(key: string): boolean {
  return readAddonLibrary().some((e) => e.key === key);
}

/** Ajoute ou retire le titre ; renvoie vrai s'il est dans la bibliothèque après l'appel. */
export function toggleAddonLibrary(entry: Omit<AddonLibraryEntry, 'addedAt'> & { addedAt?: number }): boolean {
  const list = readAddonLibrary();
  if (list.some((e) => e.key === entry.key)) {
    writeJson(ADDON_LIBRARY_KEY, list.filter((e) => e.key !== entry.key));
    return false;
  }
  writeJson(ADDON_LIBRARY_KEY, [{ ...entry, addedAt: entry.addedAt ?? Date.now() }, ...list]);
  return true;
}

function readProgressMap(): Record<string, AddonProgress> {
  const data = readJson(ADDON_PROGRESS_KEY);
  return isObject(data) ? (data as Record<string, AddonProgress>) : {};
}

/** Progression d'un titre (le dernier épisode lu pour une série) ; null si absente ou illisible. */
export function getAddonProgress(key: string): AddonProgress | null {
  const p = readProgressMap()[key];
  if (!isObject(p) || !isNum(p.t) || !isNum(p.d) || !isNum(p.at)) return null;
  const ep = p.episode;
  const episode = isObject(ep) && isNum(ep.season) && isNum(ep.episode) ? { season: ep.season, episode: ep.episode } : undefined;
  return { t: p.t, d: p.d, at: p.at, ...(episode ? { episode } : {}) };
}

export function saveAddonProgress(key: string, progress: AddonProgress): void {
  if (!isNum(progress.t) || !isNum(progress.d)) return;
  const map = readProgressMap();
  map[key] = progress;
  writeJson(ADDON_PROGRESS_KEY, map);
}
