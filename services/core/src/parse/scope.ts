/** Pack d'une release : saison entière, ou intégrale / plusieurs saisons. */
export type PackKind = 'season' | 'complete';

/**
 * Portée d'une release de série, lue dans son nom : épisode exact, pack de saison, intégrale ou multi-saisons,
 * ou numéro absolu (anime, « Titre - 05 »). Un champ absent signifie « non précisé par le nom ».
 */
export interface ReleaseScope {
  /** Saison et épisode exacts (SxxEyy, NxNN, « Saison N Episode M »). */
  season?: number;
  episode?: number;
  /** Pack : une saison entière (« S04 », « Saison 4 ») ou une intégrale / des saisons multiples. */
  pack?: PackKind;
  /** Saisons couvertes par une intégrale ou un pack multi-saisons, bornes incluses. Absent : toutes les saisons. */
  seasons?: { from: number; to: number };
  /** Numéro absolu d'épisode d'un anime (« Frieren - 05 »), à rapprocher du remappage absolu ↔ saison. */
  absolute?: number;
}

/** Épisode exact : S04E04, S4E4 (séparateur facultatif). */
const SXE = /(?<![a-z0-9])s(\d{1,3})[ ._-]?e(\d{1,4})(?!\d)/i;
/** Épisode exact au format NxNN : 4x04. Deux chiffres seulement, pour ne pas lire « 5.1x264 » comme un épisode. */
const NXNN = /(?<![\dA-Za-z])(\d{1,2})x(\d{2})(?![\dA-Za-z])/i;
/** Épisode exact en toutes lettres : « Saison 4 Episode 4 », « Season 4 Ep 4 ». */
const WORD_EPISODE = /(?:saison|season)[ ._-]?(\d{1,3})\D{0,10}?(?:episode|épisode|ep)[ ._-]?(\d{1,4})(?!\d)/i;
/** Plage de saisons : « S01-S05 », « S01-05 ». */
const SEASON_RANGE_TAG = /(?<![a-z0-9])s(\d{1,2})\s*(?:-|~)\s*s?(\d{1,2})(?![0-9])/i;
/** Plage de saisons en toutes lettres : « Saison 1 à 5 », « Seasons 1-5 ». */
const SEASON_RANGE_WORD = /(?:saisons?|seasons?)[ ._-]?(\d{1,2})\s*(?:-|~|à|to)\s*(\d{1,2})(?!\d)/i;
/** Saison en toutes lettres : « Saison 4 », « Season 4 ». */
const SEASON_WORD = /(?:saison|season)[ ._-]?(\d{1,2})(?!\d)/gi;
/** Saison en abrégé : « S04 » isolé (pas suivi de E, ni de chiffre ou lettre). */
const SEASON_TAG = /(?<![a-z0-9])s(\d{1,2})(?![0-9a-z])/gi;
/** Intégrale : « Intégrale », « integrale », « complete », « full series ». */
const COMPLETE = /(?<![a-z])(?:int[ée]grale|complete|full[ .-]?series|s[ée]rie[ .-]?compl[èe]te)(?![a-z])/i;
/** Numéro absolu d'anime : « - 05 » suivi d'autre chose qu'un chiffre, une lettre ou un tiret (pas de plage). */
const ABSOLUTE = /(?<!\w)-\s*(\d{2,3})(?:v\d)?(?![\dA-Za-z-])/;

/**
 * Certains indexeurs renvoient des titres UTF-8 relus en latin-1 (« IntÃ©grale », « ComplÃ¨te »). Si le texte contient
 * ces séquences et se relit proprement en UTF-8, on le relit ; sinon il est rendu tel quel.
 */
export function repairMojibake(text: string): string {
  if (!/[\u00C2\u00C3][\u0080-\u00BF]/.test(text) || /[\u0100-\uFFFF]/.test(text)) return text;
  try {
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, (char) => char.charCodeAt(0)));
    return repaired;
  } catch {
    return text;
  }
}

function rangeOf(a: number, b: number): { from: number; to: number } {
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * Portée d'une release, d'après son texte (nom de fichier, titre, description). Ordre de lecture : épisode exact,
 * plage de saisons, saison (« S04 », « Saison 4 »), intégrale, numéro absolu. Un texte sans indication : `{}`.
 */
export function releaseScope(rawText: string): ReleaseScope {
  const text = repairMojibake(rawText);
  const episode = SXE.exec(text) ?? WORD_EPISODE.exec(text) ?? NXNN.exec(text);
  if (episode) return { season: Number(episode[1]), episode: Number(episode[2]) };

  const range = SEASON_RANGE_TAG.exec(text) ?? SEASON_RANGE_WORD.exec(text);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a !== b) return { pack: 'complete', seasons: rangeOf(a, b) };
  }

  const seasons = [...new Set([...text.matchAll(SEASON_WORD), ...text.matchAll(SEASON_TAG)].map((m) => Number(m[1])))];
  if (seasons.length === 1) return { pack: 'season', season: seasons[0] };
  if (seasons.length > 1) return { pack: 'complete', seasons: rangeOf(Math.min(...seasons), Math.max(...seasons)) };

  if (COMPLETE.test(text)) return { pack: 'complete' };

  const absolute = ABSOLUTE.exec(text);
  if (absolute) return { absolute: Number(absolute[1]) };
  return {};
}

/**
 * Vrai si une release (sa portée) concerne l'épisode demandé : l'épisode exact, un pack de la saison, ou une
 * intégrale / multi-saisons qui couvre la saison. `absolute` : numéro absolu de l'épisode demandé (anime, mapping
 * connu), seul moyen de reconnaître une release « Titre - 05 ». Une portée inconnue ne correspond à rien.
 */
export function scopeCovers(scope: ReleaseScope, season: number, episode: number, absolute?: number): boolean {
  if (scope.episode !== undefined) return scope.season === season && scope.episode === episode;
  if (scope.absolute !== undefined) return absolute !== undefined && scope.absolute === absolute;
  if (scope.pack === 'season') return scope.season === season;
  if (scope.pack === 'complete') {
    return scope.seasons === undefined || (season >= scope.seasons.from && season <= scope.seasons.to);
  }
  return false;
}
