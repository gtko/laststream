import type { Config } from '../config/schema.js';
import type { Lang, ParsedRelease } from '../types.js';
import {
  type Candidate,
  effectiveLanguages,
  infoHashOf,
  isDirect,
  RESOLUTION_RANK,
  type Ranked,
  seedersOf,
  SOURCE_RANK,
  sizeOf,
} from './types.js';

/** Variantes FR exactes : légèrement au-dessus d'un MULTi à même rang de langue. */
const EXACT_FR_VARIANTS: ReadonlySet<string> = new Set(['VFF', 'TRUEFRENCH', 'VF2', 'FRENCH']);
const HDR_FORMATS: ReadonlySet<string> = new Set(['DV', 'HDR10+', 'HDR10']);

/**
 * Niveau de langue (entier) :
 * - match d'une langue préférée : 2 + 2 × (rang inversé) ; +1 pour une variante FR exacte.
 *   Plus tôt dans `preferred` = niveau plus haut, et une variante exacte passe devant un MULTi au même rang.
 * - sous-titres FR seuls : 1 (après tous les matchs de langue).
 * - sinon : 0.
 */
export function languageLevel(parsed: ParsedRelease, preferred: readonly Lang[]): number {
  const langs = effectiveLanguages(parsed);
  const index = preferred.findIndex((lang) => langs.has(lang));
  if (index >= 0) {
    const exact = parsed.frVariant !== undefined && EXACT_FR_VARIANTS.has(parsed.frVariant);
    return 2 + 2 * (preferred.length - 1 - index) + (exact ? 1 : 0);
  }
  return parsed.subsFr ? 1 : 0;
}

/**
 * Score composite entier : langue × 10000 + résolution × 1000 + source × 100 + HDR × 10 + cached.
 * Chaque poids dépasse l'étendue des niveaux inférieurs : source + HDR + cached varient de 911 au plus (< 1000),
 * résolution + niveaux inférieurs de 5911 au plus (< 10000). Comparer les scores revient donc à comparer
 * le tuple (langue, résolution, source, HDR, cached).
 */
export function computeScore(c: Candidate, preferred: readonly Lang[]): number {
  const { parsed } = c;
  const hdr = parsed.hdr.some((format) => HDR_FORMATS.has(format)) ? 1 : 0;
  const cached = c.cached === true ? 1 : 0;
  return (
    languageLevel(parsed, preferred) * 10000 +
    RESOLUTION_RANK[parsed.resolution] * 1000 +
    SOURCE_RANK[parsed.source] * 100 +
    hdr * 10 +
    cached
  );
}

/** Départage à score égal : taille la plus petite d'abord (inconnue en dernier), puis seeders décroissants. */
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score;
  const sizeA = sizeOf(a);
  const sizeB = sizeOf(b);
  if (sizeA !== sizeB) {
    if (sizeA === undefined) return 1;
    if (sizeB === undefined) return -1;
    return sizeA - sizeB;
  }
  return (seedersOf(b) ?? 0) - (seedersOf(a) ?? 0);
}

/** Classe les candidats (tri stable, du meilleur au moins bon). */
export function rankCandidates(cands: Candidate[], config: Config): Ranked[] {
  const preferred = config.languages.preferred;
  return cands
    .map((c) => ({ ...c, score: computeScore(c, preferred), tier: RESOLUTION_RANK[c.parsed.resolution] }))
    .sort(compareRanked);
}

/**
 * Renvoie les infoHash distincts (minuscules) des `n` premiers candidats éligibles, c'est-à-dire qui ont un infoHash
 * et pas d'URL directe. Sert à interroger le débrideur pour le statut « cache » avant le formatage.
 */
export function selectForCacheCheck(ranked: Ranked[], n: number): string[] {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    if (hashes.length >= n) break;
    if (isDirect(item)) continue;
    const hash = infoHashOf(item)?.toLowerCase();
    if (hash === undefined || seen.has(hash)) continue;
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
}
