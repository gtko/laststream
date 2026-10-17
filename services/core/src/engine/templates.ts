/**
 * Gabarits d'affichage FR des streams Stremio (`name` et `description`).
 * Fonctions pures : aucune I/O, aucune dépendance au reste de l'addon.
 *
 * Choix d'affichage :
 * - Langues : drapeaux des langues vérifiées d'abord, suivis de « ✓ » si au moins une est vérifiée.
 *   Les langues seulement annoncées suivent, suffixées de « ? » (Détaillé, Compact) ou de « (annoncé) » (Netflix).
 *   Un code inconnu s'affiche en majuscules (« PT ») à la place du drapeau ou du nom.
 * - Préfixe AD (Détaillé) : « [AD⚡] » si débridé et en cache, « [AD⏳] » si débridé sans cache.
 *   Aucun préfixe pour un flux direct ou P2P.
 * - Copies : segment « 🔎 N copies » seulement à partir de 2. Un exemplaire unique n'a pas de segment
 *   (règle « pas de segment si copies <= 1 » du brief, prioritaire sur « 1 copie » singulier).
 * - Seeders : affichés pour les flux P2P uniquement, au singulier pour 0 et 1 (usage français).
 * - Texte libre (source, groupe, codec, filename…) : balises HTML retirées, caractères de contrôle et
 *   retours ligne remplacés par un espace, espaces multiples réduits. Le filename est en plus tronqué à 140 caractères.
 */

/** Vue neutre d'un stream, construite par l'appelant à partir du flux classé. */
export interface StreamView {
  /** Nom de l'addon en tête du nom (défaut « lastAddon »). */
  addonName?: string;
  /** Libellé de résolution : « 4K », « 1080p », « 720p », « SD »… */
  resolutionLabel: string;
  /** Source : « BluRay REMUX », « WEB-DL »… */
  source: string;
  /** Marques HDR et Dolby Vision : « DV », « HDR10 »… */
  hdr: string[];
  bitrateMbps?: number;
  languages: { code: string; verified: boolean }[];
  sizeBytes?: number;
  copies: number;
  videoCodec?: string;
  audioLabel?: string;
  group?: string;
  filename?: string;
  cached?: boolean;
  direct?: boolean;
  debrid?: boolean;
  seeders?: number;
  fallbackLanguage?: boolean;
}

export type TemplateId = 'direct' | 'netflix' | 'compact' | 'detaille';

type Rendered = { name: string; description: string };

const ADDON_NAME = 'lastAddon';
const FILENAME_MAX = 140;
const FALLBACK_LABEL = 'Autre langue';
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DOT = ' · ';
const BULLET = ' • ';

/** Émojis en échappements, pour qu'ils restent vérifiables en revue. */
const EMOJI = {
  bolt: '⚡', // ⚡
  wait: '⏳', // ⏳
  check: '✓', // ✓
  signal: '\u{1F4F6}', // 📶
  disk: '\u{1F4BE}', // 💾
  count: '\u{1F50E}', // 🔎
  audio: '\u{1F3A7}', // 🎧
  file: '\u{1F5C2}️', // 🗂️
  seed: '\u{1F331}', // 🌱
  globe: '\u{1F310}', // 🌐
  reel: '\u{1F39E}️', // 🎞️
} as const;

/** Drapeau à partir d'un code pays ISO 3166 à deux lettres (indicateurs régionaux). */
const flagOf = (country: string): string =>
  String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 'A'.charCodeAt(0)));

interface LanguageInfo {
  flag: string;
  name: string;
}

/** Table des langues connues. Le code est la clé ; toute autre langue passe par son code en majuscules. */
const LANGUAGES = new Map<string, LanguageInfo>([
  ['fr', { flag: flagOf('FR'), name: 'Français' }],
  ['en', { flag: flagOf('GB'), name: 'Anglais' }],
  ['es', { flag: flagOf('ES'), name: 'Espagnol' }],
  ['de', { flag: flagOf('DE'), name: 'Allemand' }],
  ['it', { flag: flagOf('IT'), name: 'Italien' }],
  ['ja', { flag: flagOf('JP'), name: 'Japonais' }],
  ['multi', { flag: EMOJI.globe, name: 'Multilingue' }],
  ['original', { flag: EMOJI.reel, name: 'Version originale' }],
]);

/** Assemble les segments présents ; un segment absent (undefined ou vide) est omis. */
const join = (parts: readonly (string | undefined)[], sep: string): string =>
  parts.filter((part): part is string => part !== undefined && part.length > 0).join(sep);

/** Préfixe un émoji au texte ; un texte absent ou vide reste absent (pas d'émoji orphelin). */
const withEmoji = (emoji: string, text: string | undefined): string | undefined =>
  text === undefined || text.length === 0 ? undefined : `${emoji} ${text}`;

const finitePositive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;

/** Texte libre rendu en clair : balises retirées, contrôles et espaces normalisés. Undefined si vide. */
function cleanText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : undefined;
}

/** Nom du filename : nettoyé, puis tronqué à 140 points de code (« … » compris). */
function filenameOf(view: StreamView): string | undefined {
  const name = cleanText(view.filename);
  if (name === undefined) return undefined;
  const chars = [...name];
  return chars.length <= FILENAME_MAX ? name : `${chars.slice(0, FILENAME_MAX - 1).join('')}…`;
}

/** Taille au format français : « 54,2 Go » ou « 850 Mo ». */
function sizeFr(bytes: number | undefined): string | undefined {
  if (!finitePositive(bytes)) return undefined;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1).replace('.', ',')} Go`;
  return `${Math.round(bytes / MIB)} Mo`;
}

/** Taille arrondie pour le nom compact : « 54 Go » ou « 850 Mo ». */
function sizeShort(bytes: number | undefined): string | undefined {
  if (!finitePositive(bytes)) return undefined;
  if (bytes >= GIB) return `${Math.round(bytes / GIB)} Go`;
  return `${Math.round(bytes / MIB)} Mo`;
}

/** Débit entier en Mb/s, omis s'il arrondit à 0. */
function bitrateText(mbps: number | undefined): string | undefined {
  if (!finitePositive(mbps)) return undefined;
  const rounded = Math.round(mbps);
  return rounded > 0 ? `${rounded} Mb/s` : undefined;
}

/** « 2 copies » à partir de 2 ; un exemplaire unique ou inconnu n'a pas de segment. */
function copiesText(copies: number): string | undefined {
  return Number.isSafeInteger(copies) && copies >= 2 ? `${copies} copies` : undefined;
}

/** « 1 seeder » pour 0 et 1, « N seeders » au-delà. */
function seedersText(seeders: number | undefined): string | undefined {
  if (seeders === undefined || !Number.isSafeInteger(seeders) || seeders < 0) return undefined;
  return `${seeders} ${seeders <= 1 ? 'seeder' : 'seeders'}`;
}

interface Lang {
  code: string;
  verified: boolean;
}

/** Dédoublonne par code : une vérification suffit. Garde l'ordre d'arrivée. */
function normalizeLanguages(languages: StreamView['languages']): Lang[] {
  const byCode = new Map<string, boolean>();
  for (const lang of languages) {
    const code = cleanText(lang.code)?.toLowerCase();
    if (code === undefined) continue;
    byCode.set(code, byCode.get(code) === true || lang.verified === true);
  }
  return [...byCode].map(([code, verified]) => ({ code, verified }));
}

const flagOfLang = (lang: Lang): string => LANGUAGES.get(lang.code)?.flag ?? lang.code.toUpperCase();
const nameOfLang = (lang: Lang): string => LANGUAGES.get(lang.code)?.name ?? lang.code.toUpperCase();

/**
 * Drapeaux : vérifiées, puis « ✓ » si au moins une est vérifiée, puis annoncées suffixées de « ? ».
 * `sep` vaut ' ' (Détaillé) ou '' (Compact). Undefined si aucune langue.
 */
function flagsText(langs: Lang[], sep: string): string | undefined {
  if (langs.length === 0) return undefined;
  const verified = langs.filter((lang) => lang.verified).map(flagOfLang);
  const announced = langs.filter((lang) => !lang.verified).map((lang) => `${flagOfLang(lang)}?`);
  const tokens = verified.length > 0 ? [...verified, EMOJI.check, ...announced] : announced;
  return tokens.join(sep);
}

/** Langues en toutes lettres : « Français, Espagnol (annoncé) ». */
function languageNamesText(langs: Lang[]): string | undefined {
  if (langs.length === 0) return undefined;
  return langs.map((lang) => (lang.verified ? nameOfLang(lang) : `${nameOfLang(lang)} (annoncé)`)).join(', ');
}

const addonOf = (view: StreamView): string => cleanText(view.addonName) ?? ADDON_NAME;
const resolutionOf = (view: StreamView): string | undefined => cleanText(view.resolutionLabel);
const sourceOf = (view: StreamView): string | undefined => cleanText(view.source);
const hdrOf = (view: StreamView): string[] => view.hdr.map(cleanText).filter((h): h is string => h !== undefined);
const isP2P = (view: StreamView): boolean => view.direct !== true && view.debrid !== true;
const fallbackOf = (view: StreamView): string | undefined => (view.fallbackLanguage === true ? FALLBACK_LABEL : undefined);

/** Préfixe AD du nom : seulement pour un débridé, « ⚡ » en cache et « ⏳ » sinon. */
function adTag(view: StreamView): string | undefined {
  if (view.direct === true || view.debrid !== true) return undefined;
  return view.cached === true ? `[AD${EMOJI.bolt}]` : `[AD${EMOJI.wait}]`;
}

/** Source courte du nom compact : « REMUX » pour tout remux, sinon la source telle quelle. */
function shortSourceOf(view: StreamView): string | undefined {
  const source = sourceOf(view);
  return source !== undefined && /remux/i.test(source) ? 'REMUX' : source;
}

/** Statut du flux en description compacte. */
function compactStatus(view: StreamView): string {
  if (view.direct === true) return 'Direct';
  if (view.debrid === true) return view.cached === true ? 'AllDebrid (en cache)' : 'AllDebrid (pas en cache)';
  const seeders = seedersText(view.seeders);
  return seeders === undefined ? 'P2P' : `P2P (${seeders})`;
}

/** Gabarit détaillé : nom avec préfixe AD, trois lignes de description. */
function detaille(view: StreamView): Rendered {
  const langs = normalizeLanguages(view.languages);
  const tech = join([cleanText(view.videoCodec), cleanText(view.audioLabel)], BULLET);
  const line1 = join(
    [
      fallbackOf(view),
      sourceOf(view),
      ...hdrOf(view),
      join([withEmoji(EMOJI.signal, bitrateText(view.bitrateMbps)), flagsText(langs, ' ')], ' '),
      withEmoji(EMOJI.disk, sizeFr(view.sizeBytes)),
      isP2P(view) ? withEmoji(EMOJI.seed, seedersText(view.seeders)) : undefined,
      withEmoji(EMOJI.count, copiesText(view.copies)),
    ],
    BULLET,
  );
  const line2 = join([withEmoji(EMOJI.audio, tech), cleanText(view.group)], BULLET);
  const line3 = withEmoji(EMOJI.file, filenameOf(view));
  return {
    name: join([adTag(view), addonOf(view), resolutionOf(view)], ' '),
    description: join([line1, line2, line3], '\n'),
  };
}

/** Gabarit Netflix : nom sobre, langues en toutes lettres, qualité et taille. */
function netflix(view: StreamView): Rendered {
  const langs = normalizeLanguages(view.languages);
  const line1 = join([fallbackOf(view), languageNamesText(langs)], DOT);
  const line2 = join([sourceOf(view), ...hdrOf(view), sizeFr(view.sizeBytes)], DOT);
  return {
    name: join([addonOf(view), resolutionOf(view)], ' '),
    description: join([line1, line2], '\n'),
  };
}

/** Gabarit compact : une seule ligne dans le nom, statut et codecs dans la description. */
function compact(view: StreamView): Rendered {
  const langs = normalizeLanguages(view.languages);
  const name = join(
    [resolutionOf(view), shortSourceOf(view), flagsText(langs, ''), sizeShort(view.sizeBytes)],
    DOT,
  );
  return {
    name: name.length > 0 ? name : addonOf(view),
    description: join(
      [fallbackOf(view), compactStatus(view), cleanText(view.videoCodec), cleanText(view.audioLabel)],
      DOT,
    ),
  };
}

/** Gabarit direct : style technique, sans émoji ni préfixe AD. */
function direct(view: StreamView): Rendered {
  return {
    name: addonOf(view),
    description: join(
      [fallbackOf(view), resolutionOf(view), sourceOf(view), sizeFr(view.sizeBytes), cleanText(view.group)],
      DOT,
    ),
  };
}

/** Rend le nom et la description Stremio d'un stream selon le gabarit demandé. */
export function renderTemplate(id: TemplateId, view: StreamView): { name: string; description: string } {
  switch (id) {
    case 'detaille':
      return detaille(view);
    case 'netflix':
      return netflix(view);
    case 'compact':
      return compact(view);
    case 'direct':
      return direct(view);
    default:
      throw new Error(`Gabarit inconnu : ${String(id)}`);
  }
}
