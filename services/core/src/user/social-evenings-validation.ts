import { z } from 'zod';
import { isValidTimeZone } from './evening-recurrence.js';
import { MAX_EVENING_PAGE } from './social-evenings-store.js';

/**
 * Schémas des routes de soirées (`/user/social/evenings*`, LAST-198, lot L2). Objets stricts : une clé inconnue est refusée.
 * Les bornes de dates et les plafonds (fenêtre, nombre de soirées, invités présents) sont vérifiés par EveningStore : ici,
 * seulement la forme du corps et des paramètres.
 */

const TITLE_MAX = 80;
/** Invités par soirée, hôte non compris (voir EveningStore). */
const MAX_GUESTS = 19;
/** Limite de l'instant : au-delà, Date ne sait plus le représenter, donc aucune conversion de fuseau n'est possible. */
const MAX_DATE_MS = 8.64e15;
const EVENING_PAGE_DEFAULT = 20;

const TITLE = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= TITLE_MAX, 'title:too_long');
const INSTANT = z.number().int().min(-MAX_DATE_MS).max(MAX_DATE_MS);
/**
 * Pid d'un invité, sans contrôle de forme : un pid mal formé équivaut à un pid inconnu (docs/social.md), donc `not_friend` (403)
 * comme pour un profil qui n'est pas ami, et non `invalid_body`. Le store le rejette ; la longueur reste bornée.
 */
const GUEST_PID = z.string().max(64);
const SCOPE = z.enum(['occurrence', 'series']);
const ANSWER = z.enum(['yes', 'maybe', 'no']);

/** Récurrence hebdomadaire (protocole : `EveningRecurrence`). `until` : fin de la série, en ms UTC. */
const RECURRENCE = z.strictObject({
  freq: z.literal('weekly'),
  interval: z.union([z.literal(1), z.literal(2)]),
  until: INSTANT.optional(),
});

/** Corps de création (`POST /user/social/evenings`). `guests` : pids des amis invités, l'hôte exclu. */
export const eveningCreateSchema = z.strictObject({
  title: TITLE,
  startsAt: INSTANT,
  tz: z
    .string()
    .max(64)
    .refine((value) => isValidTimeZone(value), 'tz:invalid'),
  guests: z.array(GUEST_PID).max(MAX_GUESTS),
  recurrence: RECURRENCE.optional(),
});

/** Corps de modification (`PATCH`) : au moins un titre ou un instant ; `scope` seul est refusé. */
export const eveningUpdateSchema = z
  .strictObject({
    title: TITLE.optional(),
    startsAt: INSTANT.optional(),
    scope: SCOPE,
  })
  .refine((body) => body.title !== undefined || body.startsAt !== undefined, 'body:empty');

/** Corps d'invitation (`POST …/guests`) : au moins un pid. */
export const eveningGuestsSchema = z.strictObject({ pids: z.array(GUEST_PID).min(1).max(MAX_GUESTS) });

/** Corps de réponse (`PUT …/response`) : `pending` n'est pas une réponse envoyable. */
export const eveningResponseSchema = z.strictObject({ response: ANSWER });

/** Corps de sortie (`POST …/leave`). */
export const eveningLeaveSchema = z.strictObject({ scope: SCOPE });

/** Paramètres de liste : `?scope=` (upcoming par défaut), `?cursor=`, `?limit=` (20 par défaut, 50 au plus). */
export const eveningListQuery = z.strictObject({
  scope: z
    .enum(['upcoming', 'past', 'invites'])
    .optional()
    .transform((value) => value ?? 'upcoming'),
  cursor: z.string().min(1).max(100).optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_EVENING_PAGE))
    .optional()
    .transform((value) => value ?? EVENING_PAGE_DEFAULT),
});

/** Paramètre de suppression : `?scope=occurrence` par défaut (une seule soirée), `series` arrête la série. */
export const eveningDeleteQuery = z.strictObject({
  scope: SCOPE.optional().transform((value) => value ?? 'occurrence'),
});

export type EveningUpdateBody = z.output<typeof eveningUpdateSchema>;

const EVENING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Vrai si `value` a la forme d'un identifiant de soirée (UUID v4 émis par le store). */
export function isEveningId(value: string): boolean {
  return EVENING_ID.test(value);
}
