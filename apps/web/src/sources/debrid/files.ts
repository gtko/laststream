/* Choix du fichier vidéo d'un magnet (porté de lastAddon src/sources/alldebrid.ts). Fonctions pures, testées. */

import { DebridError, type FileHint } from './types';

export interface FlatFile {
  /** Identifiant propre au fournisseur (id de fichier TorBox / Real-Debrid, lien AllDebrid). */
  key: string;
  name: string;
  size: number;
}

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'webm']);

export function isVideo(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Nom sans dossier, en minuscules, sans extension vidéo. */
export function stemOf(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).trim().toLowerCase();
  return isVideo(base) ? base.slice(0, base.lastIndexOf('.')) : base;
}

/** Reconnaît SxxExx (S01E02, S1E2) et NxNN (1x02), sans faux positif sur S11E02 pour S01E02. */
export function matchesEpisode(name: string, season: number, episode: number): boolean {
  const patterns = [
    new RegExp(`(?<![0-9a-z])s0*${season}e0*${episode}(?![0-9])`, 'i'),
    new RegExp(`(?<![0-9a-z])0*${season}x0*${episode}(?![0-9])`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(name));
}

const largest = (files: readonly FlatFile[]): FlatFile => files.reduce((best, f) => (f.size > best.size ? f : best));

/**
 * Choisit le fichier vidéo. Ordre : nom attendu, taille attendue, épisode demandé, index Stremio (seulement si sa taille
 * correspond), puis le plus gros fichier vidéo. Lève `no_file` (content) si rien ne convient.
 */
export function pickFile(files: readonly FlatFile[], hint: FileHint): FlatFile {
  const videos = files.filter((f) => isVideo(f.name));
  if (videos.length === 0) throw new DebridError('no_file', 'content');
  const { fileIdx, filename, size, season, episode } = hint;

  if (filename) {
    const wanted = stemOf(filename);
    const named = videos.filter((f) => stemOf(f.name) === wanted);
    if (named.length > 0) return largest(named);
  }
  let candidates = videos;
  if (size !== undefined && size > 0) {
    const sized = videos.filter((f) => f.size === size);
    if (sized.length === 1) return sized[0];
    if (sized.length > 1) candidates = sized;
  }
  if (season !== undefined && episode !== undefined) {
    const matches = candidates.filter((f) => matchesEpisode(f.name, season, episode));
    if (matches.length > 0) return largest(matches);
    // Pack de plusieurs vidéos sans l'épisode demandé : le plus gros fichier serait un autre épisode.
    if (candidates.length > 1) throw new DebridError('no_file', 'content');
  }
  if (fileIdx !== undefined && size !== undefined && fileIdx >= 0 && fileIdx < files.length) {
    const indexed = files[fileIdx];
    if (isVideo(indexed.name) && indexed.size === size) return indexed;
  }
  return largest(candidates);
}
