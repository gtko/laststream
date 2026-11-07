/* Ce que l'import garde sur l'appareil, par profil, faute de champ côté serveur :
 * - la catégorie « anime » héritée d'une source (Simkl, Nuvio) : TMDB ne la porte pas et la bibliothèque n'a pas les genres.
 *   La bibliothèque et l'onglet « Vus » s'en servent pour le filtre « Anime » ;
 * - la date réelle d'un visionnage importé (Plex, Simkl, Nuvio, Stremio) : le serveur date le « vu » du moment de l'import.
 *   La date importée remplace celle du serveur tant que le titre n'a pas été revu depuis.
 * Clés de titre : `tv:1429`, `movie:372058`. */

import { userStore } from '../userStore';

const ANIME_PREFIX = 'laststream.animeTags:';
const DATES_PREFIX = 'laststream.importedWatchDates:';
/** Marge entre l'écriture d'un « vu » importé et la date que le serveur lui donne. */
const IMPORT_WINDOW_MS = 10 * 60_000;

const profileKey = (prefix: string): string => {
  let id = 'local';
  try { id = userStore.currentProfile().id || 'local'; } catch { /* profil indisponible : clé locale */ }
  return prefix + id;
};

function read<T>(prefix: string, fallback: T): T {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(profileKey(prefix)) || 'null');
    return raw === null ? fallback : (raw as T);
  } catch {
    return fallback;
  }
}

function write(prefix: string, value: unknown): void {
  try { globalThis.localStorage?.setItem(profileKey(prefix), JSON.stringify(value)); } catch { /* stockage plein : rien n'est gardé */ }
}

// ---------- Anime ----------

export function animeKeys(): Set<string> {
  const raw = read<unknown>(ANIME_PREFIX, []);
  return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
}

/** Ajoute des titres à la catégorie « anime » du profil actif. */
export function tagAnime(keys: readonly string[]): void {
  const set = animeKeys();
  const before = set.size;
  keys.forEach((k) => set.add(k));
  if (set.size !== before) write(ANIME_PREFIX, [...set]);
}

// ---------- Dates de visionnage ----------

type Dates = Record<string, { at: number; importedAt: number }>;

const readDates = (): Dates => {
  const raw = read<unknown>(DATES_PREFIX, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Dates) : {};
};

/** Retient la date réelle du dernier visionnage d'un titre importé (la plus récente si le titre revient). */
export function rememberWatchDate(key: string, at: number, importedAt = Date.now()): void {
  if (!(at > 0)) return;
  const all = readDates();
  if (all[key] && all[key].at >= at) return;
  all[key] = { at, importedAt };
  write(DATES_PREFIX, all);
}

/**
 * Date à afficher pour un titre vu : la date importée si la date connue (serveur ou appareil) est absente ou date de
 * l'import lui-même ; sinon la date connue (le titre a été revu depuis).
 */
export function effectiveWatchedAt(key: string, known: number): number {
  const d = readDates()[key];
  if (!d) return known;
  return !known || known <= d.importedAt + IMPORT_WINDOW_MS ? d.at : known;
}
