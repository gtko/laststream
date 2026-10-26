import { z } from 'zod';
import type { Lang, Resolution, SourceKind } from '../types.js';
import { applyPreset } from './presets.js';

// Valeurs autorisées pour les langues et résolutions configurables.
const LangSchema = z.enum(['fr', 'en', 'es', 'de', 'it', 'multi', 'original'] as const satisfies readonly Lang[]);
/**
 * Les configurations enregistrées avant l'ajout du 1440p listent leurs résolutions sans lui, alors que leurs releases 1440p
 * passaient en `unknown` (donc gardées). Une liste qui autorise 2160p et 1080p sans 1440p reçoit donc le 1440p.
 */
function withLegacy1440p(allowed: Resolution[]): Resolution[] {
  if (allowed.includes('1440p') || !allowed.includes('2160p') || !allowed.includes('1080p')) return allowed;
  const at = allowed.indexOf('2160p') + 1;
  return [...allowed.slice(0, at), '1440p', ...allowed.slice(at)];
}

const ResolutionSchema = z.enum(['2160p', '1440p', '1080p', '720p', '480p', 'SD'] as const satisfies readonly Resolution[]);

const SizeRangeSchema = z
  .object({
    minGb: z.number().nonnegative().optional(),
    maxGb: z.number().positive().optional(),
  })
  .refine((range) => range.minGb === undefined || range.maxGb === undefined || range.minGb <= range.maxGb, {
    message: 'minGb must be <= maxGb',
  });

/* ---------- Préréglage, filtres, audio, tri, affichage, lecture ---------- */

/** Préréglages nommés proposés par le configurateur. */
export const PRESET_VALUES = ['essentiel', 'zen', 'cinephile', 'nomade'] as const;
export type Preset = (typeof PRESET_VALUES)[number];

/** Qualités de source configurables (valeurs de SourceKind). */
export const QUALITY_VALUES = [
  'REMUX',
  'BluRay',
  'WEB-DL',
  'WEBRip',
  'HDTV',
  'DVDRip',
  'CAM',
  'TS',
  'SCR',
  'unknown',
] as const satisfies readonly SourceKind[];
export type Quality = (typeof QUALITY_VALUES)[number];

/** Qualités autorisées par défaut : tout sauf CAM, TS et SCR. */
export const DEFAULT_QUALITIES = [
  'REMUX',
  'BluRay',
  'WEB-DL',
  'WEBRip',
  'HDTV',
  'DVDRip',
  'unknown',
] as const satisfies readonly Quality[];

// Garde-fou à la compilation : toute nouvelle valeur de SourceKind doit être ajoutée à QUALITY_VALUES.
type MissingQuality = Exclude<SourceKind, Quality>;
const _qualitiesCoverSourceKinds: [MissingQuality] extends [never] ? true : never = true;

export const AGE_LIMIT_VALUES = ['none', 10, 12, 16, 18] as const;

export const MULTICHANNEL_VALUES = ['none', 'prefer5_1', 'require5_1', 'prefer7_1', 'require7_1'] as const;
export type Multichannel = (typeof MULTICHANNEL_VALUES)[number];

export const ATMOS_VALUES = ['none', 'prefer', 'require'] as const;

export const UNSUPPORTED_FORMAT_VALUES = ['DTS-HD', 'TrueHD', 'EAC3', 'Atmos'] as const;
export type UnsupportedFormat = (typeof UNSUPPORTED_FORMAT_VALUES)[number];

export const UNSUPPORTED_MODE_VALUES = ['exclude', 'deprioritize'] as const;

export const SORT_VALUES = ['default', 'heaviest', 'lightest'] as const;
export type Sort = (typeof SORT_VALUES)[number];

export const DISPLAY_TEMPLATE_VALUES = ['direct', 'netflix', 'compact', 'detaille'] as const;

const PresetSchema = z
  .enum(PRESET_VALUES)
  .meta({
    title: 'Préréglage',
    description: "Préréglage de départ (essentiel, zen, cinéphile ou nomade). Absent : options réglées une à une.",
  })
  .optional();

const AgeLimitSchema = z.union([z.literal('none'), z.literal(10), z.literal(12), z.literal(16), z.literal(18)]);

const QualitySchema = z.enum(QUALITY_VALUES);

const WordSchema = z.string().trim().min(1).max(100);

const BitrateSchema = z
  .object({
    minMbps: z
      .number()
      .nonnegative()
      .meta({ title: 'Débit minimum (Mbit/s)', description: 'Débit minimum du flux. Vide : pas de minimum.' })
      .optional(),
    maxMbps: z
      .number()
      .nonnegative()
      .meta({ title: 'Débit maximum (Mbit/s)', description: 'Débit maximum du flux. Vide : pas de maximum.' })
      .optional(),
  })
  .refine((range) => range.minMbps === undefined || range.maxMbps === undefined || range.minMbps <= range.maxMbps, {
    message: 'minMbps must be <= maxMbps',
  })
  .meta({ title: 'Débit (Mbit/s)', description: 'Plage de débit acceptée pour les flux, en Mbit/s.' })
  .prefault({});

const FiltersSchema = z
  .object({
    ageLimit: AgeLimitSchema.default('none').meta({
      title: "Limite d'âge",
      description: "Limite d'âge des contenus (10, 12, 16 ou 18 ans). « Aucune » désactive le filtre.",
    }),
    hideUnreleased: z.boolean().default(true).meta({
      title: 'Masquer les contenus non sortis',
      description: 'Masque les films et épisodes qui ne sont pas encore sortis.',
    }),
    qualities: z.array(QualitySchema).default([...DEFAULT_QUALITIES]).meta({
      title: 'Qualités autorisées',
      description:
        'Sources acceptées : REMUX, BluRay, WEB-DL, WEBRip, HDTV, DVDRip et qualité inconnue. CAM, TS et SCR sont exclues par défaut.',
    }),
    bitrate: BitrateSchema,
    maxPerResolution: z
      .partialRecord(ResolutionSchema, z.number().int().min(1))
      .meta({
        title: 'Maximum par résolution',
        description: 'Nombre maximum de flux conservés pour chaque résolution. Vide : pas de limite.',
      })
      .optional(),
    allow3d: z.boolean().default(false).meta({
      title: 'Autoriser la 3D',
      description: 'Garde les flux 3D. Désactivé par défaut.',
    }),
    bannedWords: z.array(WordSchema).default([]).meta({
      title: 'Mots interdits',
      description: 'Les flux dont le nom contient un de ces mots sont retirés.',
    }),
    preferredWords: z.array(WordSchema).default([]).meta({
      title: 'Mots préférés',
      description: 'Les flux dont le nom contient un de ces mots remontent dans le classement.',
    }),
    directVerifiedOnly: z.boolean().default(false).meta({
      title: 'Liens directs vérifiés uniquement',
      description: 'Ne garde que les liens directs dont la disponibilité a été vérifiée.',
    }),
    includeHosterLinks: z.boolean().default(true).meta({
      title: 'Inclure les liens directs (hébergeurs)',
      description: 'Garde les liens des hébergeurs débridés par AllDebrid (ex. 1fichier), vérifiés avant affichage.',
    }),
  })
  .meta({ title: 'Filtres', description: 'Critères de sélection des flux.' })
  .prefault({});

const AudioSchema = z
  .object({
    multichannel: z.enum(MULTICHANNEL_VALUES).default('none').meta({
      title: 'Multicanal',
      description: 'Préférence de canaux audio : aucune, 5.1 ou 7.1, préférée ou exigée.',
    }),
    atmos: z.enum(ATMOS_VALUES).default('none').meta({
      title: 'Dolby Atmos',
      description: 'Aucune préférence, Atmos préféré ou Atmos exigé.',
    }),
    unsupportedFormats: z.array(z.enum(UNSUPPORTED_FORMAT_VALUES)).default([]).meta({
      title: 'Formats audio non supportés',
      description: 'Formats que le lecteur ne gère pas : DTS-HD, TrueHD, EAC3, Atmos.',
    }),
    unsupportedMode: z.enum(UNSUPPORTED_MODE_VALUES).default('deprioritize').meta({
      title: 'Traitement des formats non supportés',
      description: 'Exclure les flux concernés, ou les reléguer en fin de liste.',
    }),
    verifiedLanguagesOnly: z.boolean().default(false).meta({
      title: 'Seulement les langues vérifiées',
      description: "Ne garde que les flux dont la langue audio a été vérifiée.",
    }),
    probeTopN: z.number().int().min(0).max(20).default(5).meta({
      title: 'Nombre de flux sondés',
      description: "Nombre de meilleurs flux dont l'audio est analysé. 0 désactive la sonde.",
    }),
  })
  .meta({ title: 'Audio', description: 'Préférences de pistes audio.' })
  .prefault({});

const SortSchema = z.enum(SORT_VALUES).default('default').meta({
  title: 'Tri des flux',
  description: "Ordre d'affichage : par défaut, le plus lourd d'abord, ou le plus léger d'abord.",
});

const DisplaySchema = z
  .object({
    template: z.enum(DISPLAY_TEMPLATE_VALUES).default('detaille').meta({
      title: "Modèle d'affichage",
      description: 'Présentation des flux : direct, netflix, compact ou détaillé.',
    }),
  })
  .meta({ title: 'Affichage', description: 'Présentation des flux dans Stremio.' })
  .prefault({});

const PlaySchema = z
  .object({
    budgetMs: z.number().int().min(1000).max(60000).default(12000).meta({
      title: 'Délai de résolution (ms)',
      description: "Temps maximum accordé à la résolution d'un lien de lecture, en millisecondes (1 000 à 60 000).",
    }),
  })
  .meta({ title: 'Lecture', description: 'Réglages de résolution des liens de lecture.' })
  .prefault({});

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/** Source activée (défaut). Une source désactivée n'est jamais interrogée, et POST /config/test la rapporte. */
const EnabledSchema = z.boolean().default(true).meta({
  title: 'Activée',
  description: 'Désactiver une source la retire de la recherche sans la supprimer de la configuration.',
});

const UpstreamSourceSchema = z.object({
  enabled: EnabledSchema,
  type: z.literal('upstream'),
  name: z.string().trim().min(1).max(100),
  url: HttpUrlSchema,
});

const TorznabSourceSchema = z.object({
  enabled: EnabledSchema,
  type: z.literal('torznab'),
  name: z.string().trim().min(1).max(100),
  baseUrl: HttpUrlSchema,
  apiKey: z.string().min(1).max(500),
  categories: z.array(z.number().int().positive()).optional(),
});

/** Prowlarr : un point d'entrée, plusieurs indexeurs. `indexerIds` vide ou absent : tous les indexeurs torrent activés. */
const ProwlarrSourceSchema = z.object({
  enabled: EnabledSchema,
  type: z.literal('prowlarr'),
  name: z.string().trim().min(1).max(100),
  baseUrl: HttpUrlSchema,
  apiKey: z.string().min(1).max(500),
  indexerIds: z.array(z.number().int().positive()).max(200).optional(),
  categories: z.array(z.number().int().positive()).optional(),
});

/** Identifiant d'indexeur Jackett : lettres, chiffres, point, tiret, souligné. */
const JackettIndexerIdSchema = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/);

/** Jackett : `indexers` vaut 'all' (agrégation Jackett) ou la liste des identifiants à interroger. */
const JackettSourceSchema = z.object({
  enabled: EnabledSchema,
  type: z.literal('jackett'),
  name: z.string().trim().min(1).max(100),
  baseUrl: HttpUrlSchema,
  apiKey: z.string().min(1).max(500),
  indexers: z.union([z.literal('all'), z.array(JackettIndexerIdSchema).max(200)]).default('all'),
});

/** Clé de service facultative : libellé et description affichés dans /config/schema. */
const serviceKey = (title: string, description: string) =>
  z.string().trim().min(1).max(500).meta({ title, description }).optional();

/**
 * Clés des services de données (TMDB, MDBList, TVDB, OpenRouter, Fanart.tv). Toutes facultatives :
 * une route qui en a besoin répond 404 `service_not_configured` si sa clé manque.
 */
const ServicesSchema = z
  .object({
    tmdbToken: serviceKey(
      'Jeton TMDB (lecture v4)',
      'Jeton de lecture TMDB (API v4, en-tête Bearer). Requis pour les catalogues, /lt/tmdb et les recommandations.',
    ),
    tmdbApiKey: serviceKey('Clé API TMDB (v3)', 'Clé API TMDB v3 facultative, testée par POST /config/test.'),
    mdblistApiKey: serviceKey('Clé MDBList', 'Clé API MDBList : notes IMDb, Rotten Tomatoes, Metacritic, Letterboxd.'),
    tvdbApiKey: serviceKey(
      'Clé TheTVDB',
      'Clé API TheTVDB : clé v4 personnelle, ou clé legacy de 32 caractères hexadécimaux (API v3). Saisons et prochain épisode des séries.',
    ),
    tvdbPin: serviceKey(
      "PIN d'abonné TVDB (clés v4 personnelles)",
      "PIN d'abonné TheTVDB, requis seulement avec une clé v4 personnelle. Inutile pour une clé legacy.",
    ),
    openrouterApiKey: serviceKey(
      'Clé OpenRouter',
      'Clé OpenRouter : recommandations IA et textes sur les personnes (facturés par OpenRouter).',
    ),
    openrouterModel: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .default('openai/gpt-4o-mini')
      .meta({
        title: 'Modèle OpenRouter',
        description: 'Identifiant du modèle OpenRouter utilisé pour les recommandations et les textes.',
      }),
    fanartApiKey: serviceKey('Clé Fanart.tv', 'Clé API Fanart.tv facultative, testée par POST /config/test.'),
    introdbApiKey: serviceKey(
      'Clé IntroDB (introdb.app)',
      'Clé API IntroDB facultative : segments intro, reprise et générique (sans clé, la lecture reste possible). Si une clé est disponible (la vôtre, sinon celle du serveur), les propositions de segments (hors votes négatifs) sont aussi envoyées à IntroDB ; le contenu envoyé ne contient aucun identifiant de profil.',
    ),
    skipdbApiKey: serviceKey(
      'Clé SkipDB (skipdb.tv)',
      'Clé API SkipDB facultative : sans clé, les segments se lisent. Si une clé est disponible (la vôtre, sinon celle du serveur), les propositions de segments (hors votes négatifs) sont aussi envoyées à SkipDB (données sous licence ODbL 1.0 + réciprocité) ; le contenu envoyé ne contient aucun identifiant de profil.',
    ),
    animeskipClientId: serviceKey(
      'Client ID Anime Skip (anime-skip.com)',
      'Identifiant client Anime Skip facultatif : repères de saut pour les séries d’animation.',
    ),
  })
  .meta({
    title: 'Services',
    description: 'Clés des services de données. Facultatives : une clé absente désactive les routes qui en dépendent.',
  })
  .prefault({});

const ConfigSchema = z.object({
  services: ServicesSchema,
  languages: z
    .object({
      preferred: z.array(LangSchema).default(['fr', 'multi']),
      acceptVostfr: z.boolean().default(true),
      fallbackToOthers: z
        .boolean()
        .default(true)
        .describe("Afficher les autres langues s'il n'y a rien dans ma langue"),
    })
    .prefault({}),
  resolutions: z
    .object({
      allowed: z.array(ResolutionSchema).transform(withLegacy1440p).default(['2160p', '1440p', '1080p', '720p', '480p', 'SD']),
      max: ResolutionSchema.optional(),
    })
    .prefault({}),
  excludedTags: z.array(z.string().trim().min(1).max(50)).default(['CAM', 'TS', 'SCR']),
  size: z
    .object({
      minGb: z.number().nonnegative().optional(),
      maxGb: z.number().positive().optional(),
      perResolution: z.partialRecord(ResolutionSchema, SizeRangeSchema).optional(),
    })
    .refine((size) => size.minGb === undefined || size.maxGb === undefined || size.minGb <= size.maxGb, {
      message: 'minGb must be <= maxGb',
    })
    .prefault({}),
  maxResults: z.number().int().min(1).max(500).default(60),
  sources: z
    .array(
      z.discriminatedUnion('type', [
        UpstreamSourceSchema,
        TorznabSourceSchema,
        ProwlarrSourceSchema,
        JackettSourceSchema,
      ]),
    )
    .default([])
    .meta({
      title: 'Sources',
      description:
        "Sources interrogées. L'ordre est la priorité : la première est prioritaire (départage des scores égaux, et copie lue en premier parmi les releases identiques). Une source désactivée est ignorée.",
    }),
  autoProwlarr: z.boolean().default(false).meta({
    title: 'Utiliser le Prowlarr local détecté (obsolète)',
    description:
      "Ajoute le Prowlarr installé sur cette machine aux sources configurées (sauf s'il y figure déjà), interrogé en parallèle.",
  }),
  localProwlarr: z
    .object({
      enabled: z.boolean().default(false),
      position: z.number().int().min(0).max(1000).optional(),
    })
    .prefault({})
    .meta({
      title: 'Prowlarr local',
      description:
        "Entrée virtuelle de la liste des sources : activée ou non, et sa position (rang de priorité) parmi les sources. Absente : en dernier.",
    }),
  debrid: z
    .object({
      service: z.literal('alldebrid'),
      apiKey: z.string().min(1).max(500),
    })
    .optional(),
  onlyCached: z.boolean().default(false),
  preset: PresetSchema,
  filters: FiltersSchema,
  audio: AudioSchema,
  sort: SortSchema,
  display: DisplaySchema,
  play: PlaySchema,
});

export type Config = z.output<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Erreur de validation de configuration. Ne contient que les chemins et messages, jamais les valeurs saisies. */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuration invalide: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/** Valide une configuration brute et renvoie l'objet avec les défauts appliqués (préréglage inclus). */
export function parseConfig(input: unknown): Config {
  const result = ConfigSchema.safeParse(applyPreset(input));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.') || '(racine)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }
  return result.data;
}

/** JSON Schema de la configuration (entrée : les champs avec défaut sont optionnels). */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: 'input' }) as Record<string, unknown>;
}
