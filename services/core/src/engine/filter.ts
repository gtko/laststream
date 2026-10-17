import type { Config } from '../config/schema.js';
import type { Lang, Resolution } from '../types.js';
import { type Candidate, effectiveLanguages, isDirect, RESOLUTION_RANK, sizeOf } from './types.js';

const GIB = 1024 ** 3;

interface TagRule {
  /** Valeur comparée à parsed.source (insensible à la casse). */
  source: string;
  /** Mot entier dans titre/fichier/nom : évite le faux positif « TS » dans « Tsunami ». */
  word: RegExp;
}

interface SizeRange {
  minGb?: number;
  maxGb?: number;
}

function wordPattern(tag: string): RegExp {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

function isExcludedTag(c: Candidate, rules: readonly TagRule[]): boolean {
  const source = c.parsed.source.toUpperCase();
  const texts = [c.raw.title, c.raw.filename, c.raw.name].filter((t): t is string => typeof t === 'string');
  return rules.some((rule) => rule.source === source || texts.some((text) => rule.word.test(text)));
}

function resolutionAllowed(res: Resolution, allowed: ReadonlySet<Resolution>, maxRank: number | undefined): boolean {
  if (res === 'unknown') return true;
  if (!allowed.has(res)) return false;
  return maxRank === undefined || RESOLUTION_RANK[res] <= maxRank;
}

function withinRange(bytes: number, range: SizeRange | undefined): boolean {
  if (!range) return true;
  if (range.minGb !== undefined && bytes < range.minGb * GIB) return false;
  if (range.maxGb !== undefined && bytes > range.maxGb * GIB) return false;
  return true;
}

function sizeAllowed(c: Candidate, config: Config): boolean {
  const bytes = sizeOf(c);
  // Taille inconnue : on garde, on ne peut pas la juger.
  if (bytes === undefined) return true;
  if (!withinRange(bytes, config.size)) return false;
  const { resolution } = c.parsed;
  return resolution === 'unknown' || withinRange(bytes, config.size.perResolution?.[resolution]);
}

/**
 * Garde si : aucune langue n'est exigée, OU une langue préférée est présente (multi = fr + original),
 * OU les sous-titres FR sont acceptés et présents. Une VO sans FR est donc exclue quand des langues sont exigées.
 */
function languageAllowed(c: Candidate, preferred: readonly Lang[], acceptVostfr: boolean): boolean {
  if (preferred.length === 0) return true;
  const langs = effectiveLanguages(c.parsed);
  if (preferred.some((lang) => langs.has(lang))) return true;
  return acceptVostfr && c.parsed.subsFr;
}

/** Filtre les candidats selon la configuration. L'ordre d'arrivée est conservé. */
export function filterCandidates(cands: Candidate[], config: Config): Candidate[] {
  const allowed = new Set<Resolution>(config.resolutions.allowed);
  const maxRank = config.resolutions.max === undefined ? undefined : RESOLUTION_RANK[config.resolutions.max];
  const rules: TagRule[] = config.excludedTags.map((tag) => ({ source: tag.toUpperCase(), word: wordPattern(tag) }));
  const preferred = config.languages.preferred;

  return cands.filter((c) => {
    if (!resolutionAllowed(c.parsed.resolution, allowed, maxRank)) return false;
    if (isExcludedTag(c, rules)) return false;
    if (!sizeAllowed(c, config)) return false;
    if (!languageAllowed(c, preferred, config.languages.acceptVostfr)) return false;
    if (config.onlyCached && c.cached !== true && !isDirect(c)) return false;
    return true;
  });
}
