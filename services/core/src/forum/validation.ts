import { z } from 'zod';
import { FORUM_REACTIONS } from './store.js';

/** Schémas des routes du forum (`/user/forum`). Objets stricts ; textes nettoyés par `cleanForumText`. */

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MAX = 10_000;

/** Caractères de contrôle refusés (sauts de ligne et tabulations admis dans un message). */
const CONTROL = /(?![\n\t])\p{Cc}/u;

/**
 * Texte d'un titre (une ligne) ou d'un message (Markdown, plusieurs lignes) : espaces de bord retirés, fins de ligne
 * normalisées, longueur bornée en caractères (pas en octets), sans caractère de contrôle.
 */
export function cleanForumText(raw: string, field: 'title' | 'body'): { text: string; issues: string[] } {
  const text = field === 'title' ? raw.replace(/\s+/g, ' ').trim() : raw.replace(/\r\n?/g, '\n').trim();
  const length = [...text].length;
  const issues: string[] = [];
  const min = field === 'title' ? TITLE_MIN : 1;
  const max = field === 'title' ? TITLE_MAX : BODY_MAX;
  if (length < min) issues.push(`${field}:too_short`);
  else if (length > max) issues.push(`${field}:too_long`);
  if (CONTROL.test(text)) issues.push(`${field}:control_char`);
  return { text, issues };
}

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const topicCreateSchema = z.strictObject({
  categoryId: ID,
  title: z.string().max(1000),
  body: z.string().max(BODY_MAX * 4),
  /** Début de la séance (ms epoch), obligatoire dans la catégorie des watch parties et refusé ailleurs. */
  startsAt: z.number().int().positive().optional(),
});

export const rsvpSchema = z.strictObject({ on: z.boolean() });

export const postSchema = z.strictObject({
  body: z.string().max(BODY_MAX * 4),
});

export const reactionSchema = z.strictObject({
  emoji: z.enum(FORUM_REACTIONS),
  on: z.boolean(),
});

export const reportSchema = z.strictObject({
  reason: z.enum(['spam', 'harassment', 'piracy', 'spoiler', 'off_topic', 'other']),
  details: z.string().trim().max(500).optional(),
});

export const topicModSchema = z.strictObject({
  pinned: z.boolean().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  categoryId: ID.optional(),
  title: z.string().max(1000).optional(),
});

export const moderatePostSchema = z.strictObject({ hide: z.boolean() });

export const banSchema = z.strictObject({
  /** Durée en jours (1 à 365), ou null pour une exclusion sans fin. */
  days: z.number().int().min(1).max(365).nullable(),
  reason: z.string().trim().max(300).optional(),
});

export const moderatorSchema = z.strictObject({
  /** Handle `Nom#TAG`. */
  handle: z.string().trim().min(3).max(40),
});

export const topicsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
});
export const topicQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
});
export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });
