import { z } from 'zod';
import { parseHandle } from './social-handles.js';

/** Schémas des routes sociales v2 (`/user/social/*`). Objets stricts : une clé inconnue est refusée. */

/** Statuts choisis par l'utilisateur (`invisible` : vu hors ligne par les autres). */
export const SOCIAL_STATUSES = ['online', 'away', 'dnd', 'invisible'] as const;

/** Identifiant public d'un profil : 16 caractères base32 (voir social-handles.ts). */
const PID_PATTERN = /^[A-Z2-7]{16}$/;

/** Vrai si `value` a la forme d'un pid. Un pid mal formé est traité comme un pid inconnu. */
export function isPid(value: string): boolean {
  return PID_PATTERN.test(value);
}

export const statusSchema = z.strictObject({ status: z.enum(SOCIAL_STATUSES) });

/** Demande d'ami : « Nom#TAG », saisie insensible à la casse. */
export const requestSchema = z.strictObject({
  handle: z
    .string()
    .trim()
    .max(40)
    .refine((value) => parseHandle(value) !== null, 'handle:format'),
});

const TMDB_ID = z.number().int().positive().max(1_000_000_000);
const SEASON = z.number().int().min(0).max(10_000);
const EPISODE = z.number().int().min(0).max(10_000);

/** Titre en cours de lecture (contrat `Watching`). Saison et épisode ignorés pour un film (voir store). */
export const watchingSchema = z.strictObject({
  type: z.enum(['movie', 'series']),
  tmdbId: TMDB_ID,
  imdbId: z
    .string()
    .regex(/^tt\d{1,10}$/)
    .optional(),
  title: z.string().trim().min(1).max(200),
  poster: z.string().max(500).optional(),
  season: SEASON.optional(),
  episode: EPISODE.optional(),
  /** Position en secondes. */
  pos: z.number().min(0).max(10_000_000),
  duration: z.number().min(0).max(10_000_000).optional(),
  paused: z.boolean(),
  /** Instant du relevé, en millisecondes (epoch). */
  at: z.number().int().min(0).max(32_503_680_000_000),
});

/** Battement de présence : `watching` absent ou `null` = simplement en ligne. */
export const presenceSchema = z.strictObject({
  watching: watchingSchema.nullable().optional(),
});

/** Historique d'un ami : `?limit=` de 1 à 50, 20 par défaut. */
export const historyQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 20),
});
