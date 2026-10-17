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

/** Vrai si le candidat a au moins une langue préférée (multi compte comme fr + original). */
function matchesPreferred(c: Candidate, preferred: readonly Lang[]): boolean {
  const langs = effectiveLanguages(c.parsed);
  return preferred.some((lang) => langs.has(lang));
}

/**
 * Garde si : aucune langue n'est exigée, OU une langue préférée est présente,
 * OU les sous-titres FR sont acceptés et présents. Une VO sans FR est donc exclue quand des langues sont exigées.
 */
function languageAllowed(c: Candidate, preferred: readonly Lang[], acceptVostfr: boolean): boolean {
  if (preferred.length === 0) return true;
  if (matchesPreferred(c, preferred)) return true;
  return acceptVostfr && c.parsed.subsFr;
}

/**
 * Applique tous les filtres. `byLanguage` : applique aussi le filtre de langue (sinon toute langue passe).
 */
function applyFilters(cands: Candidate[], config: Config, byLanguage: boolean): Candidate[] {
  const allowed = new Set<Resolution>(config.resolutions.allowed);
  const maxRank = config.resolutions.max === undefined ? undefined : RESOLUTION_RANK[config.resolutions.max];
  const rules: TagRule[] = config.excludedTags.map((tag) => ({ source: tag.toUpperCase(), word: wordPattern(tag) }));
  const preferred = config.languages.preferred;

  return cands.filter((c) => {
    if (!resolutionAllowed(c.parsed.resolution, allowed, maxRank)) return false;
    if (isExcludedTag(c, rules)) return false;
    if (!sizeAllowed(c, config)) return false;
    if (byLanguage && !languageAllowed(c, preferred, config.languages.acceptVostfr)) return false;
    if (config.onlyCached && c.cached !== true && !isDirect(c)) return false;
    return true;
  });
}

/**
 * Filtre les candidats selon la configuration. L'ordre d'arrivée est conservé.
 * Repli (languages.fallbackToOthers, vrai par défaut) : si aucun candidat ne correspond à une langue préférée
 * après tous les filtres, on renvoie les candidats des autres langues (mêmes filtres de qualité, taille,
 * tags exclus et cache), marqués `languageFallback`. Sinon, comportement strict.
 */
export function filterCandidates(cands: Candidate[], config: Config): Candidate[] {
  const strict = applyFilters(cands, config, true);
  const { preferred, fallbackToOthers } = config.languages;
  if (!fallbackToOthers || preferred.length === 0 || strict.some((c) => matchesPreferred(c, preferred))) {
    return strict;
  }
  // Aucun candidat préféré n'a survécu : les candidats retenus sans filtre de langue ne sont pas préférés.
  return applyFilters(cands, config, false).map((c) => ({ ...c, languageFallback: true }));
}
