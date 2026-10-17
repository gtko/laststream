import { z } from 'zod';
import type { Lang, Resolution } from '../types.js';

// Valeurs autorisées pour les langues et résolutions configurables.
const LangSchema = z.enum(['fr', 'en', 'es', 'de', 'it', 'multi', 'original'] as const satisfies readonly Lang[]);
const ResolutionSchema = z.enum(['2160p', '1080p', '720p', '480p', 'SD'] as const satisfies readonly Resolution[]);

const SizeRangeSchema = z
  .object({
    minGb: z.number().nonnegative().optional(),
    maxGb: z.number().positive().optional(),
  })
  .refine((range) => range.minGb === undefined || range.maxGb === undefined || range.minGb <= range.maxGb, {
    message: 'minGb must be <= maxGb',
  });

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

const UpstreamSourceSchema = z.object({
  type: z.literal('upstream'),
  name: z.string().trim().min(1).max(100),
  url: HttpUrlSchema,
});

const TorznabSourceSchema = z.object({
  type: z.literal('torznab'),
  name: z.string().trim().min(1).max(100),
  baseUrl: HttpUrlSchema,
  apiKey: z.string().min(1).max(500),
  categories: z.array(z.number().int().positive()).optional(),
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
      'Clé OpenRouter : recommandations IA et textes « Pourquoi tu vas aimer » (facturés par OpenRouter).',
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
      'Clé API IntroDB facultative : segments intro, reprise et générique (sans clé, la lecture reste possible).',
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

export const ConfigSchema = z.object({
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
      allowed: z.array(ResolutionSchema).default(['2160p', '1080p', '720p', '480p', 'SD']),
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
  maxResults: z.number().int().min(1).max(500).default(30),
  sources: z.array(z.discriminatedUnion('type', [UpstreamSourceSchema, TorznabSourceSchema])).default([]),
  debrid: z
    .object({
      service: z.literal('alldebrid'),
      apiKey: z.string().min(1).max(500),
    })
    .optional(),
  onlyCached: z.boolean().default(false),
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

/** Valide une configuration brute et renvoie l'objet avec les défauts appliqués. */
export function parseConfig(input: unknown): Config {
  const result = ConfigSchema.safeParse(input);
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
