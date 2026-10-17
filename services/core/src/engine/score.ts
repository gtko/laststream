import type { Config, Sort, UnsupportedFormat } from '../config/schema.js';
import type { Lang, ParsedRelease } from '../types.js';
import { channelRank, channelTarget, detectedAudioFormats } from './audio.js';
import {
  type Candidate,
  compileWords,
  type ContentMeta,
  effectiveLanguages,
  infoHashOf,
  isDirect,
  languagesFor,
  matchesAnyWord,
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
 * Niveau de langue maximal codé dans le score. Au plus 7 langues distinctes donnent 15 ; le plafond protège
 * le codage si la liste de préférences contient des doublons.
 */
const LANGUAGE_MAX = 63;

/*
 * Score composite : chaque niveau est un chiffre de base `radix` (du moins au plus significatif) et son poids est
 * le produit des bases inférieures. Les niveaux ne débordent donc jamais sur le suivant : comparer deux scores
 * revient à comparer le tuple (non déclassé, langue, résolution, source, préférences audio et mots, HDR, cached).
 */
const W_CACHED = 1; // radix 2 : 0..1
const W_HDR = W_CACHED * 2; // radix 2 : 0..1
const W_WORD = W_HDR * 2; // radix 2 : mot préféré, 0..1
const W_AUDIO = W_WORD * 2; // radix 3 : canaux préférés (+1) et Atmos préféré (+1), 0..2
const W_SOURCE = W_AUDIO * 3; // radix 11 : rang de source, 0..10
const W_RESOLUTION = W_SOURCE * 11; // radix 6 : rang de résolution, 0..5
const W_LANGUAGE = W_RESOLUTION * 6; // radix 64 : niveau de langue, 0..63
const W_KEPT = W_LANGUAGE * (LANGUAGE_MAX + 1); // radix 2 : 1 si non déclassé, 0 sinon

/** Champs du score et du tri, précalculés pour chaque candidat. */
interface Scored {
  /** Faux si le flux porte un format audio non supporté, en mode « deprioritize » : il passe en fin de liste. */
  kept: boolean;
  /** Niveau de langue (même échelle que `languageLevel`), plafonné à LANGUAGE_MAX. */
  language: number;
  score: number;
}

/** Réglages précompilés une fois par classement. */
interface ScoringContext {
  preferred: readonly Lang[];
  verifiedOnly: boolean;
  /** Formats à déclasser (vide hors mode « deprioritize »). */
  deprioritized: ReadonlySet<UnsupportedFormat>;
  words: readonly RegExp[];
  channelTarget: number | undefined;
  atmosPreferred: boolean;
}

function scoringContext(config: Config): ScoringContext {
  const { audio, filters, languages } = config;
  const deprioritized = audio.unsupportedMode === 'deprioritize' ? audio.unsupportedFormats : [];
  return {
    preferred: languages.preferred,
    verifiedOnly: audio.verifiedLanguagesOnly,
    deprioritized: new Set(deprioritized),
    words: compileWords(filters.preferredWords),
    channelTarget: channelTarget(audio.multichannel),
    atmosPreferred: audio.atmos !== 'none',
  };
}

/**
 * Niveau de langue : 2 + 2 × (rang inversé) pour une langue préférée, +1 pour une variante FR exacte ;
 * 1 pour les sous-titres FR seuls.
 */
function levelFor(langs: ReadonlySet<Lang>, parsed: ParsedRelease, preferred: readonly Lang[]): number {
  const index = preferred.findIndex((lang) => langs.has(lang));
  if (index >= 0) {
    const exact = parsed.frVariant !== undefined && EXACT_FR_VARIANTS.has(parsed.frVariant);
    return 2 + 2 * (preferred.length - 1 - index) + (exact ? 1 : 0);
  }
  return parsed.subsFr ? 1 : 0;
}

/**
 * Niveau de langue (entier) :
 * - match d'une langue préférée : 2 + 2 × (rang inversé) ; +1 pour une variante FR exacte.
 *   Plus tôt dans `preferred` = niveau plus haut, et une variante exacte passe devant un MULTi au même rang.
 * - sous-titres FR seuls : 1 (après tous les matchs de langue).
 * - sinon : 0.
 */
export function languageLevel(parsed: ParsedRelease, preferred: readonly Lang[]): number {
  return levelFor(effectiveLanguages(parsed), parsed, preferred);
}

function scoreParts(c: Candidate, ctx: ScoringContext): Scored {
  const { parsed } = c;
  const detected = detectedAudioFormats(c);
  const kept = ![...detected].some((format) => ctx.deprioritized.has(format));
  const language = Math.min(levelFor(languagesFor(c, ctx.verifiedOnly), parsed, ctx.preferred), LANGUAGE_MAX);
  const hdr = parsed.hdr.some((format) => HDR_FORMATS.has(format)) ? 1 : 0;
  const word = matchesAnyWord(c, ctx.words) ? 1 : 0;
  const audioBonus =
    (ctx.channelTarget !== undefined && channelRank(c) >= ctx.channelTarget ? 1 : 0) +
    (ctx.atmosPreferred && detected.has('Atmos') ? 1 : 0);
  const cached = c.cached === true ? 1 : 0;
  const score =
    (kept ? W_KEPT : 0) +
    language * W_LANGUAGE +
    RESOLUTION_RANK[parsed.resolution] * W_RESOLUTION +
    SOURCE_RANK[parsed.source] * W_SOURCE +
    audioBonus * W_AUDIO +
    word * W_WORD +
    hdr * W_HDR +
    cached * W_CACHED;
  return { kept, language, score };
}

/**
 * Score composite entier (plus haut = meilleur), mêmes niveaux que le classement par défaut : non déclassé,
 * langue, résolution, source, préférences (canaux, Atmos, mots préférés), HDR, cached.
 */
export function computeScore(c: Candidate, config: Config): number {
  return scoreParts(c, scoringContext(config)).score;
}

/**
 * Taille comparée dans l'ordre demandé ; taille inconnue toujours en dernier.
 * `direction` : 1 pour croissant, -1 pour décroissant.
 */
function compareSize(a: Candidate, b: Candidate, direction: 1 | -1): number {
  const sizeA = sizeOf(a);
  const sizeB = sizeOf(b);
  if (sizeA === undefined || sizeB === undefined) {
    if (sizeA === sizeB) return 0;
    return sizeA === undefined ? 1 : -1;
  }
  return (sizeA - sizeB) * direction;
}

interface Entry {
  ranked: Ranked;
  scored: Scored;
}

/**
 * Ordre du classement : déclassés en fin de liste, puis selon `sort`.
 * - default : score décroissant, taille la plus petite d'abord (inconnue en dernier), puis seeders décroissants.
 * - heaviest / lightest : niveau de langue décroissant, puis taille (la plus grande ou la plus petite d'abord),
 *   puis score, puis seeders.
 */
function compareEntries(a: Entry, b: Entry, sort: Sort): number {
  if (a.scored.kept !== b.scored.kept) return a.scored.kept ? -1 : 1;
  if (sort === 'default') {
    if (a.scored.score !== b.scored.score) return b.scored.score - a.scored.score;
    const sizeOrder = compareSize(a.ranked, b.ranked, 1);
    if (sizeOrder !== 0) return sizeOrder;
  } else {
    if (a.scored.language !== b.scored.language) return b.scored.language - a.scored.language;
    const sizeOrder = compareSize(a.ranked, b.ranked, sort === 'heaviest' ? -1 : 1);
    if (sizeOrder !== 0) return sizeOrder;
    if (a.scored.score !== b.scored.score) return b.scored.score - a.scored.score;
  }
  return (seedersOf(b.ranked) ?? 0) - (seedersOf(a.ranked) ?? 0);
}

/**
 * Classe les candidats (tri stable, du meilleur au moins bon) selon `config.sort`.
 * `meta` (contenu) est accepté pour aligner la signature sur filterCandidates ; le classement n'en dépend pas.
 */
export function rankCandidates(cands: Candidate[], config: Config, _meta?: ContentMeta): Ranked[] {
  const ctx = scoringContext(config);
  const entries: Entry[] = cands.map((c) => {
    const scored = scoreParts(c, ctx);
    return { ranked: { ...c, score: scored.score, tier: RESOLUTION_RANK[c.parsed.resolution] }, scored };
  });
  return entries.sort((a, b) => compareEntries(a, b, config.sort)).map((entry) => entry.ranked);
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
