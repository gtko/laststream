/**
 * Socle des téléchargements hors ligne (ODY-198) : types partagés, erreurs, interfaces à brancher par plateforme.
 *
 * Règles : le module ne parle jamais au serveur Laststream (tout passe par des dépendances injectées) ; un lien débridé
 * n'existe qu'en mémoire (jamais persisté, ni dans une erreur, ni dans un journal) ; AllDebrid n'est appelé que depuis l'appareil.
 */
import type { ClientCopy } from '../sources/debrid/types';
import type { HttpFn } from '../sources/debrid/http';

export type { HttpFn };

/** États d'un téléchargement. « disponible » et « indisponible » (maquettes) sont dérivés de la source, hors du socle. */
export type DownloadState = 'pending' | 'running' | 'paused' | 'done' | 'error';

export type DownloadErrorCode =
  | 'link_expired' // lien débridé périmé et re-résolutions épuisées
  | 'resolve_failed' // aucun lien obtenu
  | 'account' // compte débrideur indisponible (clé, abonnement) : pas de nouvel essai automatique
  | 'content' // fichier introuvable, non pris en charge, ou serveur sans lecture par plages
  | 'network' // coupure ou 5xx, tentatives épuisées
  | 'range_mismatch' // le fichier distant a changé pendant la reprise
  | 'quota_exceeded' // limite d'espace choisie par l'utilisateur
  | 'store_full' // le stockage de l'appareil est plein
  | 'store_failed' // écriture ou lecture du stockage impossible
  | 'cancelled';

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    // Le message ne contient jamais d'URL : seulement le code.
    super(code);
    this.name = 'DownloadError';
  }
}

/** Ce qu'il faut pour obtenir un lien : des hashs et un épisode, jamais d'URL. */
export interface DownloadSource {
  copies: ClientCopy[];
  episode?: { season?: number; episode?: number };
  /** Choix de l'utilisateur, mémorisés (ex. « 1080p », ['fr']). */
  quality?: string;
  langs?: string[];
}

export interface DownloadItem {
  /** Dérivé de metaId et de la saison / épisode (`downloadId`). */
  id: string;
  metaId: string;
  title: string;
  season?: number;
  episode?: number;
  source: DownloadSource;
  state: DownloadState;
  /** Octets déjà écrits ; la taille du fichier du magasin (`sink.size()`) fait foi à la reprise. */
  bytesDone: number;
  bytesTotal?: number;
  /** Taille annoncée avant le premier morceau (pour le quota et la saison entière). */
  estimatedSize?: number;
  filename?: string;
  container?: string;
  etag?: string;
  lastModified?: string;
  error?: { code: DownloadErrorCode; message?: string };
  /** Essais réseau consécutifs de la session de téléchargement en cours. */
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueRequest {
  metaId: string;
  title: string;
  season?: number;
  episode?: number;
  source: DownloadSource;
  estimatedSize?: number;
}

/** Lien en clair ; vit seulement en mémoire. */
export interface ResolvedFile {
  url: string;
  size?: number;
  filename?: string;
}

/** Re-résolution d'un lien côté appareil (voir `debridLinkResolver`). Lève `DebridError` ou `DownloadError`. */
export interface LinkResolver {
  resolve(src: DownloadSource, signal: AbortSignal): Promise<ResolvedFile>;
}

/** Fichier en cours d'écriture dans le magasin d'une plateforme (ODY-199 web, 200 Android, 201 Windows). */
export interface DownloadSink {
  /** Taille actuelle : point de reprise. */
  size(): Promise<number>;
  /** Écrit `chunk` à `offset` (jamais au-delà de `size()`). Lève `DownloadError('store_full' | 'store_failed')`. */
  write(offset: number, chunk: Uint8Array): Promise<void>;
  truncate(len: number): Promise<void>;
  /** Le fichier est complet. */
  finalize(): Promise<void>;
  /** Libère les ressources (handle de fichier) ; appelée à la fin de chaque session de téléchargement, réussie ou non. */
  close(): Promise<void>;
}

export interface DownloadStore {
  /** Ouvre (ou crée) le fichier d'un téléchargement ; l'appelant appelle `close()` sur le sink. */
  open(id: string): Promise<DownloadSink>;
  /** Octets déjà écrits pour `id` (0 si absent), sans créer de fichier ni garder de handle. */
  size(id: string): Promise<number>;
  remove(id: string): Promise<void>;
  /** Octets occupés par les téléchargements, et espace libre de l'appareil si connu. */
  usage(): Promise<{ used: number; available?: number }>;
}

/** Index persisté des téléchargements (sans aucun lien). */
export interface DownloadIndex {
  all(): Promise<DownloadItem[]>;
  put(item: DownloadItem): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SpaceInfo {
  used: number;
  limit: number | null;
  /** used / limit, null sans limite. */
  ratio: number | null;
  /** ≥ 90 % de la limite. */
  warn: boolean;
  /** ≥ 100 % de la limite. */
  full: boolean;
}

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_RESOLVES = 3;
export const MAX_NETWORK_RETRIES = 5;
/** Au-delà, un serveur sans `Range` (réponse 200) n'est pas chargé en mémoire. */
export const MAX_FULL_BODY_BYTES = 512 * 1024 * 1024;
export const WARN_RATIO = 0.9;

/** Identifiant stable : `metaId`, plus `:S:E` pour un épisode. */
export const downloadId = (metaId: string, season?: number, episode?: number): string =>
  season !== undefined && episode !== undefined ? `${metaId}:${season}:${episode}` : metaId;

/** Avancement après un morceau écrit. */
export interface TransferProgress {
  bytesDone: number;
  bytesTotal?: number;
  etag?: string;
  lastModified?: string;
}

export interface TransferParams {
  http: HttpFn;
  sink: DownloadSink;
  /** Lien courant (en mémoire seulement). */
  url: string;
  chunkSize: number;
  /** Connu lors d'une reprise : sert à valider `Content-Range`. */
  bytesTotal?: number;
  /**
   * ETag renvoyé par le lien COURANT seulement (jamais celui d'un ancien lien : il peut différer d'un hôte à l'autre).
   * Aucun `If-Range` n'est envoyé. Le transport des plateformes doit couper la lecture sur les en-têtes d'une réponse 200
   * à une demande de plage (`HttpFn` charge sinon tout le corps en mémoire).
   */
  etag?: string;
  signal: AbortSignal;
  /** Appelée après chaque morceau écrit. */
  onProgress(p: TransferProgress): void | Promise<void>;
}
