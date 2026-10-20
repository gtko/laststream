import { z } from 'zod';
import { isAllowedImageUrl } from './image-hosts.js';
import { HIDDEN_KEY, MAX_INVITE_QUOTA, TICKET_MESSAGE_MAX, TICKET_PICKS_MAX } from './social-store.js';
import { INVITE_CODE } from './validation.js';

/** Schémas des routes sociales (parrainage, amis, présence, visibilité, titres masqués). */

/** Pseudo exact (même format que l'inscription ; comparé en minuscules). */
export const usernameParam = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/);

export const inviteCodeQuery = z.object({ code: INVITE_CODE });
export const inviteSentSchema = z.object({ sent: z.boolean() });
export const inviteQuotaSchema = z.object({ quota: z.number().int().min(0).max(MAX_INVITE_QUOTA) });

/** Affiche ou fond : vide, ou URL https sur un hôte d'image autorisé (voir image-hosts.ts). */
const imageUrlOrEmpty = z
  .string()
  .max(2048)
  .refine((value) => value === '' || isAllowedImageUrl(value), 'image_host');

/** Coup de cœur d'un billet : id, type et nom courts ; affiche et fond vides ou sur un hôte d'image autorisé. */
const ticketPickSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  poster: imageUrlOrEmpty.default(''),
  background: imageUrlOrEmpty.default(''),
});

/** Billet : message (280 caractères au plus, comptés en caractères et non en unités de code) et 3 coups de cœur au plus. Un champ absent reste inchangé. */
export const inviteTicketSchema = z.object({
  message: z
    .string()
    .refine((value) => [...value].length <= TICKET_MESSAGE_MAX, 'message_too_long')
    .optional(),
  picks: z.array(ticketPickSchema).max(TICKET_PICKS_MAX).optional(),
});

export const friendRequestSchema = z.object({ username: usernameParam });

const TITLE = z.string().trim().min(1).max(200);

export const presenceSchema = z.object({
  /** Profil utilisé : un profil enfant n'annonce jamais de titre. Défaut : aucun (présence « en ligne » seulement). */
  profileId: z.string().min(1).max(64).optional(),
  watching: z
    .object({
      type: z.enum(['movie', 'series']),
      tmdbId: z.number().int().positive().max(1_000_000_000).optional(),
      imdbId: z.string().regex(/^tt\d{1,10}$/).optional(),
      title: TITLE,
      season: z.number().int().min(0).max(10_000).optional(),
      episode: z.number().int().min(0).max(10_000).optional(),
    })
    .nullable()
    .optional(),
  /** Mode invisible : le compte apparaît hors ligne à ses amis. */
  invisible: z.boolean().default(false),
});

export const visibilitySchema = z.object({ visibility: z.enum(['private', 'friends']) });
export const bulkVisibilitySchema = z.object({ visibility: z.enum(['private', 'friends']), type: z.enum(['movie', 'series']).optional() });

const intParam = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);

export const friendLibraryQuery = z.object({
  type: z.enum(['movie', 'series']).optional(),
  limit: intParam(1, 100, 50),
  offset: intParam(0, 1_000_000, 0),
});

export const hiddenQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: intParam(1, 500, 100),
  cursor: z.string().max(80).optional(),
});

const hiddenKey = z.string().regex(HIDDEN_KEY);

/** Écriture en lot (500 entrées au plus par appel). `addedAt` : millisecondes ; absent = maintenant. */
export const hiddenWriteSchema = z.object({
  entries: z
    .array(
      z.object({
        key: hiddenKey,
        title: z.string().trim().max(200),
        poster: z.string().max(200).default(''),
        addedAt: z.number().int().min(0).max(32_503_680_000_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const hiddenRemoveSchema = z.object({ keys: z.array(hiddenKey).min(1).max(500) });
export const hiddenKeyParam = hiddenKey;
