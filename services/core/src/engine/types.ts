import type { Lang, ParsedRelease, RawStream, Resolution, SourceKind } from '../types.js';

/** Candidat : un stream amont déjà parsé, prêt pour le moteur (le moteur ne parse jamais). */
export interface Candidate {
  raw: RawStream;
  parsed: ParsedRelease;
  cached?: boolean;
}

/** Candidat classé : `score` composite (plus haut = meilleur), `tier` = rang de résolution. */
export interface Ranked extends Candidate {
  score: number;
  tier: number;
}

/** Rang des résolutions (plus grand = meilleur). `unknown` est le plus bas. */
export const RESOLUTION_RANK: Record<Resolution, number> = {
  '2160p': 5,
  '1080p': 4,
  '720p': 3,
  '480p': 2,
  SD: 1,
  unknown: 0,
};

/** Rang de qualité des sources (plus grand = meilleur). */
export const SOURCE_RANK: Record<SourceKind, number> = {
  REMUX: 10,
  BluRay: 9,
  'WEB-DL': 8,
  WEBRip: 7,
  HDTV: 6,
  DVDRip: 5,
  unknown: 4,
  SCR: 3,
  TS: 2,
  CAM: 1,
};

/** Taille en octets : celle du parseur si connue, sinon celle de l'amont. */
export function sizeOf(c: Candidate): number | undefined {
  return c.parsed.sizeBytes ?? c.raw.sizeBytes;
}

/** Nombre de seeders : celui du parseur si connu, sinon celui de l'amont. */
export function seedersOf(c: Candidate): number | undefined {
  return c.parsed.seeders ?? c.raw.seeders;
}

/** infoHash du parseur ou de l'amont (chaîne vide ⇒ absent). */
export function infoHashOf(c: Candidate): string | undefined {
  return c.parsed.infoHash || c.raw.infoHash || undefined;
}

export function fileIdxOf(c: Candidate): number | undefined {
  return c.parsed.fileIdx ?? c.raw.fileIdx;
}

/** Vrai si le stream amont fournit une URL directe (aucun débridage requis). */
export function isDirect(c: Candidate): boolean {
  return typeof c.raw.url === 'string' && c.raw.url.length > 0;
}

/** Langues effectives : `multi` compte comme `fr` + `original`. */
export function effectiveLanguages(parsed: ParsedRelease): Set<Lang> {
  const langs = new Set<Lang>(parsed.languages);
  if (langs.has('multi')) {
    langs.add('fr');
    langs.add('original');
  }
  return langs;
}
