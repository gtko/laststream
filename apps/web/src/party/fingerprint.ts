import type { Fingerprint } from '../data/socialApi';

/* Empreinte d'une version : nom de fichier, taille et hash si connus. Elle identifie la version lue par l'hôte sans
 * jamais révéler de lien (débridé ou non). Chaque participant retrouve la version la plus proche parmi SES sources. */

/** Champs utiles d'une source (vue de la liste de sources). */
export interface FingerprintSource {
  filename?: string;
  sizeBytes?: number;
  stream?: { infoHash?: string; behaviorHints?: { filename?: string; videoSize?: number } } | null;
  playable?: boolean;
}

/** Empreinte de la source lue (champs inconnus à null). Null si rien n'est connu. */
export function fingerprintOf(view: FingerprintSource | null | undefined): Fingerprint | null {
  if (!view) return null;
  const fileName = (view.filename || view.stream?.behaviorHints?.filename || '').trim();
  const size = view.sizeBytes || view.stream?.behaviorHints?.videoSize || 0;
  const hash = (view.stream?.infoHash || '').trim().toLowerCase();
  if (!fileName && !(size > 0) && !hash) return null;
  return { fileName: fileName ? fileName.slice(0, 300) : null, size: size > 0 ? Math.round(size) : null, hash: hash ? hash.slice(0, 64) : null };
}

/** Nom normalisé pour la comparaison : minuscules, sans extension, séparateurs unifiés. */
function norm(name: string): string {
  return name.toLowerCase().replace(/\.(mkv|mp4|avi|m4v|webm|ts)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Ressemblance de deux noms de fichiers (0 à 1) : jetons communs / jetons du plus long. */
export function nameSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = new Set(x.split(' '));
  const tb = new Set(y.split(' '));
  let common = 0;
  ta.forEach((t) => { if (tb.has(t)) common += 1; });
  return common / Math.max(ta.size, tb.size);
}

/** Score d'une source par rapport à l'empreinte du salon : plus il est haut, plus la version est proche. 0 : aucun lien. */
export function matchScore(view: FingerprintSource, fp: Partial<Fingerprint> | null | undefined): number {
  if (!fp) return 0;
  const mine = fingerprintOf(view);
  if (!mine) return 0;
  if (fp.hash && mine.hash && fp.hash === mine.hash) return 100;
  let score = 0;
  if (fp.fileName && mine.fileName) {
    const sim = nameSimilarity(fp.fileName, mine.fileName);
    if (sim === 1) score += 60;
    else if (sim >= 0.8) score += 40 * sim;
  }
  if (fp.size && mine.size) {
    const rel = Math.abs(fp.size - mine.size) / Math.max(fp.size, mine.size);
    if (rel === 0) score += 40;
    else if (rel < 0.01) score += 25;
  }
  return score;
}

/** Score minimal pour préférer une source à « la meilleure » : au moins un nom quasi identique, ou une taille exacte avec un nom proche. */
const MATCH_MIN = 50;

/**
 * Version à lire pour suivre l'hôte : la source jouable qui correspond le mieux à l'empreinte (hash, puis nom et taille),
 * ou null si aucune ne correspond assez (on prend alors la meilleure source habituelle). Égalité : la première (la mieux classée).
 */
export function pickByFingerprint<V extends FingerprintSource>(views: readonly V[], fp: Partial<Fingerprint> | null | undefined): V | null {
  if (!fp) return null;
  let best: V | null = null;
  let bestScore = 0;
  for (const v of views) {
    if (v.playable === false) continue;
    const s = matchScore(v, fp);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return bestScore >= MATCH_MIN ? best : null;
}

/**
 * Empreinte envoyée au salon : jamais une URL. Un nom de fichier qui ressemble à un lien (http, www, ://) est retiré ; null si rien
 * ne reste. La taille et le hash ne révèlent aucun lien.
 */
export function shareableFingerprintOf(view: FingerprintSource | null | undefined): Fingerprint | null {
  const fp = fingerprintOf(view);
  if (!fp) return null;
  const fileName = fp.fileName && !/https?:|:\/\/|www\./i.test(fp.fileName) ? fp.fileName : null;
  return fileName || fp.size !== null || fp.hash ? { fileName, size: fp.size, hash: fp.hash } : null;
}

/** Deux empreintes identiques, champs à null compris (null égale null). */
export function sameFingerprint(a: Partial<Fingerprint> | null | undefined, b: Partial<Fingerprint> | null | undefined): boolean {
  return (a?.fileName ?? null) === (b?.fileName ?? null) && (a?.size ?? null) === (b?.size ?? null) && (a?.hash ?? null) === (b?.hash ?? null);
}
