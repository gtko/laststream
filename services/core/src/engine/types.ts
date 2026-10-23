import type { Lang, ParsedRelease, RawStream, Resolution, SourceKind } from '../types.js';

/** Piste audio vérifiée par sonde (après lecture réelle du flux). */
export interface VerifiedAudio {
  lang: string;
  codec: string;
  channels: string;
  atmos: boolean;
}

/** Candidat : un stream amont déjà parsé, prêt pour le moteur (le moteur ne parse jamais). */
/** Priorité de la source d'origine (index dans `sources`, plus petit = prioritaire). Absente : la plus basse. */
export function sourcePriorityOf(c: Candidate): number {
  return c.raw.sourcePriority ?? Number.MAX_SAFE_INTEGER;
}

export interface Candidate {
  raw: RawStream;
  parsed: ParsedRelease;
  cached?: boolean;
  /** Vrai si le candidat est une langue autre que les préférées, retenu faute de résultat dans ces langues. */
  languageFallback?: boolean;
  /** Langues audio vérifiées par sonde. Absent : candidat non sondé. */
  verifiedLanguages?: string[];
  /** Pistes audio vérifiées par sonde. */
  verifiedAudio?: VerifiedAudio[];
  /** Nombre de copies connues chez l'amont (information, aucun filtre ne s'appuie dessus à ce jour). */
  copiesCount?: number;
  /** Vrai si la disponibilité d'un lien direct a été vérifiée. */
  directVerified?: boolean;
  /** Nom de l'hébergeur débridé (ex. « 1fichier »), pour l'affichage « Lien direct · 1fichier ». */
  hoster?: string;
}

/** Candidat classé : `score` composite (plus haut = meilleur), `tier` = rang de résolution. */
export interface Ranked extends Candidate {
  score: number;
  tier: number;
}

/**
 * Métadonnées du contenu (film ou épisode), issues de TMDB et de Cinemeta. Tous les champs sont facultatifs :
 * absent = inconnu.
 */
export interface ContentMeta {
  /** Durée réelle en secondes. */
  runtimeSeconds?: number;
  /**
   * Âge minimum FR : 0 = tous publics, 10, 12, 16 ou 18. `'none'` = aucune classification connue (traitée comme
   * inconnue). undefined = inconnu.
   */
  certificationFr?: number | 'none';
  /** Date de sortie ISO (AAAA-MM-JJ) du film ou de l'épisode. */
  releaseDate?: string;
  /**
   * Jours de tolérance avant `releaseDate` (épisodes : fenêtre « peut-être déjà en ligne »). Absent : la sortie compte
   * à partir de son jour.
   */
  releaseWindowDays?: number;
}

/** Rang des résolutions (plus grand = meilleur). `unknown` est le plus bas. */
export const RESOLUTION_RANK: Record<Resolution, number> = {
  '2160p': 6,
  '1440p': 5,
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

const KNOWN_LANGS: ReadonlySet<string> = new Set<Lang>(['fr', 'en', 'es', 'de', 'it', 'multi', 'original']);

/** Ensemble de langues : valeurs inconnues ignorées, `multi` compte comme `fr` + `original`. */
function expandLanguages(values: Iterable<string>): Set<Lang> {
  const langs = new Set<Lang>();
  for (const value of values) {
    if (KNOWN_LANGS.has(value)) langs.add(value as Lang);
  }
  if (langs.has('multi')) {
    langs.add('fr');
    langs.add('original');
  }
  return langs;
}

/** Langues effectives : `multi` compte comme `fr` + `original`. */
function effectiveLanguages(parsed: ParsedRelease): Set<Lang> {
  return expandLanguages(parsed.languages);
}

/**
 * Langues retenues pour le classement et le filtre de langue. Avec `verifiedOnly`, seules les langues vérifiées
 * par sonde comptent ; sans sonde, aucune langue.
 */
export function languagesFor(c: Candidate, verifiedOnly: boolean): Set<Lang> {
  return verifiedOnly ? expandLanguages(c.verifiedLanguages ?? []) : effectiveLanguages(c.parsed);
}

/** Textes du stream où chercher un nom : titre, fichier, nom amont. */
export function rawNameTexts(c: Candidate): string[] {
  return [c.raw.title, c.raw.filename, c.raw.name].filter((text): text is string => typeof text === 'string');
}

/** Textes de recherche de mots : nom du stream et groupe de release. */
function nameTexts(c: Candidate): string[] {
  const group = c.parsed.group;
  return group === undefined ? rawNameTexts(c) : [...rawNameTexts(c), group];
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Motif d'un mot entier, insensible à la casse. Les séparateurs (espace, point, tiret, tiret bas) du mot sont
 * interchangeables dans le texte : « Dual Audio » trouve « Dual.Audio ».
 */
export function wordPattern(word: string): RegExp {
  const trimmed = word.trim();
  const parts = trimmed.split(/[\s._-]+/u).filter((part) => part.length > 0);
  const body =
    parts.length > 0
      ? parts.map((part) => part.replace(REGEX_SPECIALS, '\\$&')).join('[\\s._-]+')
      : trimmed.replace(REGEX_SPECIALS, '\\$&');
  if (body.length === 0) return /(?!)/u;
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Motifs de mots entiers, une entrée par mot. */
export function compileWords(words: readonly string[]): RegExp[] {
  return words.map(wordPattern);
}

/** Vrai si un des motifs trouve un mot entier dans le nom du stream (groupe inclus). */
export function matchesAnyWord(c: Candidate, patterns: readonly RegExp[]): boolean {
  if (patterns.length === 0) return false;
  return nameTexts(c).some((text) => patterns.some((pattern) => pattern.test(text)));
}
