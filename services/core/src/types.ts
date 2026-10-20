import type { ReleaseScope } from './parse/scope.js';

export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'SD' | 'unknown';
export type SourceKind = 'REMUX' | 'BluRay' | 'WEB-DL' | 'WEBRip' | 'HDTV' | 'DVDRip' | 'CAM' | 'TS' | 'SCR' | 'unknown';
export type Codec = 'HEVC' | 'AVC' | 'AV1' | 'unknown';
export type Hdr = 'HDR10' | 'HDR10+' | 'DV' | 'HLG';
export type Lang = 'fr' | 'en' | 'es' | 'de' | 'it' | 'multi' | 'original';
export type FrVariant = 'VFF' | 'VFQ' | 'VF2' | 'TRUEFRENCH' | 'FRENCH' | 'VOSTFR' | 'SUBFRENCH';

export interface ParsedRelease {
  resolution: Resolution;
  height: number;
  source: SourceKind;
  codec: Codec;
  hdr: Hdr[];
  audio: string[];
  channels?: string;
  languages: Lang[];
  frVariant?: FrVariant;
  multi: boolean;
  subsFr: boolean;
  group?: string;
  sizeBytes?: number;
  /** Pack de série : taille du pack entier (`sizeBytes` en est alors l'estimation par épisode). */
  packSizeBytes?: number;
  seeders?: number;
  infoHash?: string;
  fileIdx?: number;
  title?: string;
  /** Portée de la release (série) : épisode exact, pack de saison, intégrale, numéro absolu. Absente si rien n'est lu. */
  scope?: ReleaseScope;
}

export interface RawStream {
  sourceName: string;
  sourceKind: 'upstream' | 'torznab';
  /**
   * Priorité de la source d'origine : son index dans `sources` (plus petit = prioritaire), renseigné par collectStreams.
   * Sert au départage des scores égaux et au choix de la copie lue en premier. Absent hors collecte.
   */
  sourcePriority?: number;
  title?: string;
  name?: string;
  description?: string;
  filename?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sizeBytes?: number;
  seeders?: number;
  magnet?: string;
  behaviorHints?: Record<string, unknown>;
  sources?: string[];
  /** Indexeurs ayant renvoyé ce flux (Prowlarr, Jackett). Fusionné par infoHash dans collectStreams. */
  indexers?: string[];
  /** Addon amont d'où vient le flux (nom du manifest ou de la source, logo si connu). Absent pour un indexeur. */
  origin?: { name: string; logo?: string };
  /**
   * Lien de téléchargement du .torrent (proxifié par Prowlarr, parfois avec une passkey ou une clé API).
   * SECRET : gardé en mémoire seulement. Ne jamais le recopier dans une réponse Stremio, un journal ou un message
   * d'erreur (les sorties construisent leurs champs un à un ; utiliser scrubUrl pour tout texte).
   * Lu par resolveInfoHashes (torrent/enrich.ts). Pour une copie privée, la lecture à la demande rejoue
   * fetchTorrent(downloadUrl, { guid }) (octets gardés en cache) puis resolveTorrentFile, car un magnet n'a pas la passkey.
   */
  downloadUrl?: string;
  /** Identifiant du release chez l'indexeur (Torznab guid). Clé de cache du .torrent ; jamais exposé. */
  guid?: string;
  /**
   * Torrent privé (info.private = 1), connu après lecture du .torrent. Une copie privée doit être résolue
   * à partir de ses octets (fichier .torrent), jamais à partir d'un magnet reconstruit sans passkey.
   */
  privateTorrent?: boolean;
  /** Fichiers d'un pack, après lecture du .torrent : idx = position dans le .torrent, name = chemin relatif. */
  packFiles?: { idx: number; name: string; size: number }[];
}

export interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  behaviorHints?: Record<string, unknown>;
  laststream?: Record<string, unknown>;
}

export interface ContentRef {
  type: 'movie' | 'series';
  id: string;
  imdbId: string;
  season?: number;
  episode?: number;
}

/** Provenance d'un flux, pour l'affichage : un addon amont ou un indexeur. */
export interface StreamOrigin {
  kind: 'addon' | 'indexer';
  name: string;
  logo?: string;
}
