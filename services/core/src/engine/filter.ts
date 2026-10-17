import type { Config } from '../config/schema.js';
import type { Lang, Resolution } from '../types.js';
import { channelRank, channelTarget, detectedAudioFormats } from './audio.js';
import {
  type Candidate,
  compileWords,
  type ContentMeta,
  isDirect,
  languagesFor,
  matchesAnyWord,
  RESOLUTION_RANK,
  rawNameTexts,
  sizeOf,
  wordPattern,
} from './types.js';

const GIB = 1024 ** 3;
const MBIT = 1_000_000;

/** Mots qui signalent un flux 3D (mot entier, dans le nom). */
const THREE_D_WORDS = ['3D', 'SBS', 'HSBS', 'HOU'] as const;

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

function isExcludedTag(c: Candidate, rules: readonly TagRule[]): boolean {
  const source = c.parsed.source.toUpperCase();
  const texts = rawNameTexts(c);
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
 * Débit en Mbit/s (décimal) : taille × 8 / durée réelle. Renvoie undefined si la taille ou la durée est inconnue.
 */
export function bitrateMbps(sizeBytes: number | undefined, runtimeSeconds: number | undefined): number | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return undefined;
  if (runtimeSeconds === undefined || !(runtimeSeconds > 0)) return undefined;
  return (sizeBytes * 8) / runtimeSeconds / MBIT;
}

function bitrateAllowed(
  c: Candidate,
  bitrate: Config['filters']['bitrate'],
  runtimeSeconds: number | undefined,
): boolean {
  if (bitrate.minMbps === undefined && bitrate.maxMbps === undefined) return true;
  const mbps = bitrateMbps(sizeOf(c), runtimeSeconds);
  // Débit non calculable : on garde.
  if (mbps === undefined) return true;
  if (bitrate.minMbps !== undefined && mbps < bitrate.minMbps) return false;
  if (bitrate.maxMbps !== undefined && mbps > bitrate.maxMbps) return false;
  return true;
}

/** Limite d'âge : sans certification FR connue, le titre est exclu dès qu'une limite est active. */
function ageAllowed(meta: ContentMeta | undefined, limit: Config['filters']['ageLimit']): boolean {
  if (limit === 'none') return true;
  const certification = meta?.certificationFr;
  return typeof certification === 'number' && certification <= limit;
}

/** Sortie future exclue ; date inconnue ou illisible gardée. */
function releasedAllowed(meta: ContentMeta | undefined, hideUnreleased: boolean, now: number): boolean {
  if (!hideUnreleased || meta?.releaseDate === undefined) return true;
  const releasedAt = Date.parse(meta.releaseDate);
  if (Number.isNaN(releasedAt)) return true;
  return releasedAt <= now;
}

/**
 * Garde si : aucune langue n'est exigée, OU une langue préférée est présente, OU les sous-titres FR sont acceptés.
 */
function languageAllowed(
  c: Candidate,
  preferred: readonly Lang[],
  acceptVostfr: boolean,
  verifiedOnly: boolean,
): boolean {
  if (preferred.length === 0) return true;
  if (matchesPreferred(c, preferred, verifiedOnly)) return true;
  return acceptVostfr && c.parsed.subsFr;
}

/** Vrai si le candidat a au moins une langue préférée (multi compte comme fr + original). */
export function matchesPreferred(c: Candidate, preferred: readonly Lang[], verifiedOnly: boolean): boolean {
  const langs = languagesFor(c, verifiedOnly);
  return preferred.some((lang) => langs.has(lang));
}

/** Canaux exigés et Atmos exigé ; formats non supportés à exclure. */
function audioAllowed(c: Candidate, config: Config): boolean {
  const { audio } = config;
  const detected = detectedAudioFormats(c);
  if (audio.unsupportedMode === 'exclude' && audio.unsupportedFormats.some((format) => detected.has(format))) {
    return false;
  }
  if (audio.multichannel.startsWith('require')) {
    const target = channelTarget(audio.multichannel);
    // Canaux inconnus : on ne peut pas prouver le 5.1 ou le 7.1, donc on exclut.
    if (target !== undefined && channelRank(c) < target) return false;
  }
  if (audio.atmos === 'require' && !detected.has('Atmos')) return false;
  return true;
}

/**
 * Applique tous les filtres. `byLanguage` : applique aussi le filtre de langue (sinon toute langue passe).
 */
function applyFilters(
  cands: Candidate[],
  config: Config,
  byLanguage: boolean,
  meta: ContentMeta | undefined,
): Candidate[] {
  const { filters, languages, resolutions, audio } = config;
  const allowed = new Set<Resolution>(resolutions.allowed);
  const maxRank = resolutions.max === undefined ? undefined : RESOLUTION_RANK[resolutions.max];
  const rules: TagRule[] = config.excludedTags.map((tag) => ({ source: tag.toUpperCase(), word: wordPattern(tag) }));
  const qualities = new Set<string>(filters.qualities);
  const bannedWords = compileWords(filters.bannedWords);
  const threeDWords = filters.allow3d ? [] : compileWords(THREE_D_WORDS);
  const now = Date.now();
  const verifiedOnly = audio.verifiedLanguagesOnly;

  return cands.filter((c) => {
    if (!resolutionAllowed(c.parsed.resolution, allowed, maxRank)) return false;
    if (isExcludedTag(c, rules)) return false;
    if (!qualities.has(c.parsed.source)) return false;
    if (!sizeAllowed(c, config)) return false;
    if (!ageAllowed(meta, filters.ageLimit)) return false;
    if (!releasedAllowed(meta, filters.hideUnreleased, now)) return false;
    if (!bitrateAllowed(c, filters.bitrate, meta?.runtimeSeconds)) return false;
    if (matchesAnyWord(c, threeDWords)) return false;
    if (matchesAnyWord(c, bannedWords)) return false;
    if (!audioAllowed(c, config)) return false;
    if (filters.directVerifiedOnly && isDirect(c) && c.directVerified !== true) return false;
    // Langue audio non sondée : exclue quand l'option est active, même sans langue préférée exigée.
    if (verifiedOnly && c.verifiedLanguages === undefined) return false;
    if (byLanguage && !languageAllowed(c, languages.preferred, languages.acceptVostfr, verifiedOnly)) return false;
    if (config.onlyCached && c.cached !== true && !isDirect(c)) return false;
    return true;
  });
}

/**
 * Filtre les candidats selon la configuration. L'ordre d'arrivée est conservé.
 * `meta` (film ou épisode) alimente les filtres de limite d'âge, de sortie et de débit ; sans lui, ces filtres
 * ne voient aucune donnée (limite d'âge active ⇒ tout est exclu, faute de certification connue).
 * Repli (languages.fallbackToOthers, vrai par défaut) : si aucun candidat ne correspond à une langue préférée
 * après tous les filtres, on renvoie les candidats des autres langues (mêmes filtres de qualité, taille,
 * tags exclus et cache), marqués `languageFallback`. Sinon, comportement strict.
 */
export function filterCandidates(cands: Candidate[], config: Config, meta?: ContentMeta): Candidate[] {
  const strict = applyFilters(cands, config, true, meta);
  const { preferred, fallbackToOthers } = config.languages;
  const verifiedOnly = config.audio.verifiedLanguagesOnly;
  if (!fallbackToOthers || preferred.length === 0 || strict.some((c) => matchesPreferred(c, preferred, verifiedOnly))) {
    return strict;
  }
  // Aucun candidat préféré n'a survécu : les candidats retenus sans filtre de langue ne sont pas préférés.
  return applyFilters(cands, config, false, meta).map((c) => ({ ...c, languageFallback: true }));
}

/**
 * Garde les `filters.maxPerResolution[r]` premiers candidats de chaque résolution r, dans l'ordre reçu
 * (à appeler après le classement). Les résolutions sans limite et `unknown` ne sont pas limitées.
 */
export function limitPerResolution<T extends Candidate>(ranked: readonly T[], config: Config): T[] {
  const limits = config.filters.maxPerResolution;
  if (limits === undefined) return [...ranked];
  const counts = new Map<Resolution, number>();
  return ranked.filter((item) => {
    const { resolution } = item.parsed;
    const limit = resolution === 'unknown' ? undefined : limits[resolution];
    if (limit === undefined) return true;
    const count = counts.get(resolution) ?? 0;
    if (count >= limit) return false;
    counts.set(resolution, count + 1);
    return true;
  });
}
