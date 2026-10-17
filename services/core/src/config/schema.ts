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

export const ConfigSchema = z.object({
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
