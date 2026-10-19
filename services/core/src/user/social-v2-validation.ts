import { z } from 'zod';
import { parseHandle } from './social-handles.js';
import { MAX_MESSAGE_PAGE } from './social-v2-store.js';

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

/**
 * Affiche acceptée : URL TMDB en https, ou chemin du site (`/…`, jamais `//` ni un antislash après `/`, qui désignent un autre hôte).
 * Toute autre valeur est supprimée sans erreur : le titre en cours reste accepté, sans affiche.
 */
function cleanPoster(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 500) return undefined;
  if (value.startsWith('https://image.tmdb.org/')) return value;
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : undefined;
}

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
  poster: z
    .string()
    .optional()
    .transform((value) => cleanPoster(value)),
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

// Messages et notes

/** Titre (contrat `MediaRef`) : saison et épisode facultatifs. */
const MEDIA_FIELDS = {
  type: z.enum(['movie', 'series']),
  tmdbId: TMDB_ID,
  season: SEASON.optional(),
  episode: EPISODE.optional(),
};

const POSITION = z.number().min(0).max(10_000_000);

/** Corps de `POST /messages/:pid`. Le texte est vérifié ensuite (longueur en caractères, contrôle) : voir `cleanMessageBody`. */
export const messageSchema = z.strictObject({
  body: z.string().max(4000),
  context: z.strictObject({ ...MEDIA_FIELDS, pos: POSITION.optional() }).optional(),
});

/** Corps de `POST /notes` : titre, position, type (texte ou emoji) et contenu (vérifié par `cleanNoteBody`). */
export const noteSchema = z.strictObject({
  ...MEDIA_FIELDS,
  pos: POSITION,
  kind: z.enum(['text', 'emoji']),
  body: z.string().max(1000),
});

/** `?before=<createdAt ms>&limit=` : page de messages, 50 au plus (50 par défaut). */
export const messagesQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_MESSAGE_PAGE))
    .optional()
    .transform((value) => value ?? MAX_MESSAGE_PAGE),
});

/** `?type&tmdbId&season&episode` : notes d'un titre. Saison et épisode facultatifs (ignorés pour un film). */
export const notesQuery = z.strictObject({
  type: z.enum(['movie', 'series']),
  tmdbId: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
  season: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().max(10_000))
    .optional(),
  episode: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().max(10_000))
    .optional(),
});

// Activité (S5)

/** Entier décimal de 1 à 3 chiffres, borné : pagination et nombre de tranches. */
const SMALL_INT = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number);

/** `?before=<at ms>&limit=` : flux d'activité, 30 par défaut, 50 au plus. */
export const activityQuery = z.strictObject({
  before: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  limit: SMALL_INT.pipe(z.number().int().min(1).max(50))
    .optional()
    .transform((value) => value ?? 30),
});

/** `?type&tmdbId&season&episode&buckets=` : carte de chaleur, 60 tranches par défaut, 200 au plus. */
export const heatmapQuery = notesQuery.extend({
  buckets: SMALL_INT.pipe(z.number().int().min(1).max(200))
    .optional()
    .transform((value) => value ?? 60),
});

/**
 * `?since=<ms>` (exclu) et titre facultatif : `type` et `tmdbId` vont ensemble, saison et épisode facultatifs.
 */
export const missedQuery = z
  .strictObject({
    since: z
      .string()
      .regex(/^\d{1,15}$/)
      .transform(Number),
    type: z.enum(['movie', 'series']).optional(),
    tmdbId: z
      .string()
      .regex(/^[1-9]\d{0,8}$/)
      .transform(Number)
      .optional(),
    season: z
      .string()
      .regex(/^\d{1,5}$/)
      .transform(Number)
      .optional(),
    episode: z
      .string()
      .regex(/^\d{1,5}$/)
      .transform(Number)
      .optional(),
  })
  .refine((query) => (query.type === undefined) === (query.tmdbId === undefined), 'media:incomplete');

export const MESSAGE_MAX_CHARS = 1000;
export const NOTE_TEXT_MAX_CHARS = 140;

const CONTROL_CHARACTER = /\p{Cc}/u;
/** Découpage en graphèmes (un emoji composé, ZWJ, drapeau ou ton de peau, ne compte que pour un). */
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Un graphème d'emoji contient toujours un pictogramme (ou un indicateur régional pour les drapeaux). */
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Unités de code au plus pour un emoji (famille ZWJ la plus longue : 11). */
const MAX_EMOJI_CODE_UNITS = 16;

/** Vrai si `text` est exactement un emoji : un seul graphème, qui contient un pictogramme. */
export function isSingleEmoji(text: string): boolean {
  // Plafond avant segmentation : un « graphème » peut enchaîner des centaines de marques combinantes.
  if (text.length > MAX_EMOJI_CODE_UNITS) return false;
  return [...GRAPHEMES.segment(text)].length === 1 && PICTOGRAPHIC.test(text);
}

/** Problèmes d'un texte (déjà débarrassé de ses espaces de bord). Chemins seulement, jamais les valeurs. */
function textIssues(body: string, max: number, allowNewlines: boolean): string[] {
  const issues: string[] = [];
  const length = [...body].length;
  if (length === 0) issues.push('body:empty');
  else if (length > max) issues.push('body:too_long');
  if ([...body].some((ch) => CONTROL_CHARACTER.test(ch) && !(allowNewlines && ch === '\n'))) issues.push('body:control_char');
  return issues;
}

/** Texte d'un message : espaces de bord retirés, 1 à 1000 caractères, sans caractère de contrôle (saut de ligne admis). */
export function cleanMessageBody(raw: string): { body: string; issues: string[] } {
  const body = raw.trim();
  return { body, issues: textIssues(body, MESSAGE_MAX_CHARS, true) };
}

/** Contenu d'une note : texte de 1 à 140 caractères sans contrôle, ou exactement un emoji. */
export function cleanNoteBody(kind: 'text' | 'emoji', raw: string): { body: string; issues: string[] } {
  const body = raw.trim();
  if (kind === 'text') return { body, issues: textIssues(body, NOTE_TEXT_MAX_CHARS, false) };
  if (body === '') return { body, issues: ['body:empty'] };
  return { body, issues: isSingleEmoji(body) ? [] : ['body:not_emoji'] };
}
