/* Migration depuis Stremio, Nuvio, Simkl et Plex : modèle commun. Chaque lecteur de source (stremio.ts, nuvio.ts, simkl.ts,
 * plex.ts) produit des `MigrationItem` ; le moteur (runner.ts) les résout en titres TMDB et les écrit sur le profil, un par un,
 * avec un journal qui permet de reprendre après une coupure. Aucun module de ce dossier n'envoie d'identifiant de source au serveur. */

export type MigrationSource = 'stremio' | 'stremio-file' | 'nuvio' | 'simkl' | 'plex';

/** Ce que l'élément devient dans Laststream. */
export type MigrationAction = 'library' | 'list' | 'watched' | 'progress';

/** Listes créées par l'import : titres aimés et liste à voir. */
export type MigrationList = 'favorites' | 'watchlist';

export interface EpisodeRef {
  season: number;
  episode: number;
}

/** Identifiants connus d'un titre. Le moteur cherche dans cet ordre : TMDB, IMDb, TVDB. */
export interface TitleRef {
  tmdb?: number;
  imdb?: string;
  tvdb?: number;
}

export interface MigrationItem {
  /** Clé stable de l'élément dans la source : sert au journal (reprise sans doublon). */
  uid: string;
  action: MigrationAction;
  /** Pour `list` : la liste visée. */
  list?: MigrationList;
  type: 'movie' | 'tv';
  ref: TitleRef;
  title: string;
  year?: string;
  /** Épisode (progression d'une série). */
  season?: number;
  episode?: number;
  /** Progression, en secondes. */
  positionSec?: number;
  durationSec?: number;
  /** Date de l'évènement (ajout, visionnage), en ms ; 0 si inconnue. */
  at?: number;
  /** Épisodes vus d'une série, quand la source les donne directement (Simkl, Plex, Nuvio). */
  episodes?: EpisodeRef[];
  /** Champ « watched » Stremio d'une série (épisodes vus, compressés) : décodé par le moteur avec la liste des épisodes. */
  stremioWatched?: string;
  /** Catégorie anime de la source (Simkl, Nuvio) : conservée dans les filtres Laststream. */
  anime?: boolean;
  /** Type inconnu de la source : le moteur garde ce que TMDB trouve (film ou série). */
  typeUnknown?: boolean;
  /** Élément reconnu mais impossible à importer : il figure au rapport comme ignoré, avec cette raison. */
  skipReason?: string;
}

/** Addon trouvé dans la source (Stremio, Nuvio). L'adresse peut contenir une clé : elle reste sur l'appareil. */
export interface MigrationAddon {
  manifestUrl: string;
  name: string;
  /** Addon officiel de Stremio (Cinemeta, local, OpenSubtitles…), déjà couvert par Laststream. */
  official?: boolean;
}

/** Contenu lu dans une source, avant écriture. `notes` : remarques à afficher dans l'aperçu (ex. champ inconnu ignoré). */
export interface MigrationBundle {
  source: MigrationSource;
  items: MigrationItem[];
  addons: MigrationAddon[];
  notes: string[];
}

export type ItemStatus = 'ok' | 'skipped' | 'failed';

/** Résultat d'un élément, conservé dans le rapport. `reason` : phrase en langage clair. */
export interface ItemResult {
  uid: string;
  status: ItemStatus;
  action: MigrationAction;
  title: string;
  reason?: string;
}

export const ACTION_LABEL: Record<MigrationAction, string> = {
  library: 'Bibliothèque',
  list: 'Listes',
  watched: 'Vus',
  progress: 'Progression',
};

export const LIST_NAME: Record<MigrationList, string> = {
  favorites: 'Favoris',
  watchlist: 'À voir',
};

export const SOURCE_LABEL: Record<MigrationSource, string> = {
  stremio: 'Stremio',
  'stremio-file': 'Stremio (fichier)',
  nuvio: 'Nuvio',
  simkl: 'Simkl',
  plex: 'Plex',
};

// ---------- Utilitaires partagés par les lecteurs ----------

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
export const posInt = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
export const imdbOf = (v: unknown): string | undefined => {
  const s = str(v);
  return /^tt\d{1,12}$/.test(s) ? s : undefined;
};
/** Date ISO, nombre de ms ou de secondes depuis l'époque ; 0 si illisible. */
export function timeOf(v: unknown): number {
  const n = num(v);
  if (n !== undefined) return n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
}
export const yearOf = (v: unknown): string | undefined => {
  const m = /\b(\d{4})\b/.exec(String(v ?? ''));
  return m ? m[1] : undefined;
};

/**
 * Identifiants contenus dans un identifiant de média Stremio ou Nuvio : `tt123`, `tmdb:123`, `tvdb:123`. Les identifiants
 * propres à un addon (`kitsu:`, `fk:`…) ne donnent rien : ils ne correspondent à aucun titre TMDB.
 */
export function refOfMediaId(id: string): TitleRef {
  const imdb = imdbOf(id.split(':')[0]);
  if (imdb) return { imdb };
  const m = /^(tmdb|tvdb):(\d+)/.exec(id);
  if (m) return m[1] === 'tmdb' ? { tmdb: Number(m[2]) } : { tvdb: Number(m[2]) };
  return {};
}

export const hasRef = (r: TitleRef): boolean => !!(r.tmdb || r.imdb || r.tvdb);

/** Type Laststream d'un type de source ; null pour les chaînes et la TV en direct (`tv` chez Stremio) et le reste. */
export function typeOf(t: unknown): 'movie' | 'tv' | null {
  const s = str(t).toLowerCase();
  if (s === 'movie' || s === 'movies' || s === 'film') return 'movie';
  if (s === 'series' || s === 'show' || s === 'shows' || s === 'anime' || s === 'episode') return 'tv';
  return null;
}
