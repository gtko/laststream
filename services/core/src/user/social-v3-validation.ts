import { z } from 'zod';
import { cleanNoteBody, isPid } from './social-v2-validation.js';

/**
 * Schémas des routes de partage (`/user/social/share`, `/user/social/share-links`) et des listes partagées
 * (`/user/social/lists`) : contrat « Social v3 », S3b. Objets stricts : une clé inconnue est refusée.
 */

const TMDB_ID = z.number().int().positive().max(1_000_000_000);
const SEASON = z.number().int().min(0).max(10_000);
const EPISODE = z.number().int().min(0).max(10_000);
const POSITION = z.number().min(0).max(10_000_000);
const MEDIA_TYPE = z.enum(['movie', 'series']);
const TITLE = z.string().trim().min(1).max(200);
const LIST_NAME = z.string().trim().min(1).max(40);
const PID = z.string().refine(isPid, 'pid:format');

/** Affiche ou image acceptée : URL TMDB en https, ou chemin du site (`/…`). Toute autre valeur est retirée sans erreur. */
export function cleanPoster(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 500) return undefined;
  if (value.startsWith('https://image.tmdb.org/')) return value;
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : undefined;
}

const POSTER = z
  .string()
  .optional()
  .transform((value) => cleanPoster(value));

/** Titre partagé (`kind: 'title'`) : fiche, note facultative de l'expéditeur (/5) et année. */
const TITLE_REF = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID,
  title: TITLE,
  poster: POSTER,
  year: z.number().int().min(1800).max(3000).optional(),
  rating: z.number().min(0).max(5).optional(),
});

/** Moment partagé (`kind: 'moment'`) : titre, position (secondes) et image de la scène (chemin TMDB). */
const MOMENT_REF = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID,
  season: SEASON.optional(),
  episode: EPISODE.optional(),
  title: TITLE,
  pos: POSITION,
  still: POSTER,
});

/** Destinataire : un ami (`pid`) ou un groupe (`group`, ignoré tant que les groupes n'existent pas : voir social-v3-store). */
const RECIPIENT = z.union([z.strictObject({ pid: PID }), z.strictObject({ group: z.string().min(1).max(64) })]);

/** Corps de `POST /share`. La cohérence kind / titre / moment est vérifiée par la route. */
export const shareSchema = z.strictObject({
  to: z.array(RECIPIENT).min(1).max(20),
  kind: z.enum(['title', 'moment']),
  title: TITLE_REF.optional(),
  moment: MOMENT_REF.optional(),
  body: z.string().max(4000).optional(),
});

/**
 * Corps de `POST /share-links`. `title` est facultatif : sans lui, la route reprend le titre de l'index des fiches (meta_index).
 * `pos` ne se donne que pour un moment ; la note est vérifiée ensuite (`cleanNoteBody`, 140 caractères).
 */
export const shareLinkSchema = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID,
  title: TITLE.optional(),
  poster: POSTER,
  pos: POSITION.optional(),
  withInvite: z.boolean(),
  note: z.string().max(400).optional(),
});

/** Code d'un lien public : 10 à 64 caractères base64url (le code produit en fait 22). */
export const SHARE_CODE = /^[A-Za-z0-9_-]{10,64}$/;

/** Corps de `POST /lists` : nom et amis membres (le propriétaire est ajouté par le serveur). */
export const listCreateSchema = z.strictObject({
  name: LIST_NAME,
  members: z.array(PID).max(49).optional(),
});

/** Corps de `PUT /lists/:id` : renommer, ajouter et retirer des membres (propriétaire seulement). */
export const listUpdateSchema = z.strictObject({
  name: LIST_NAME.optional(),
  add: z.array(PID).max(49).optional(),
  remove: z.array(PID).max(49).optional(),
});

/** Corps de `POST /lists/:id/items` : un titre à ajouter à la liste. */
export const listItemSchema = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID,
  title: TITLE,
  poster: POSTER,
});

/** Identifiant de liste dans une URL : 1 à 64 caractères alphanumériques ou tirets (sinon, liste inconnue). */
export const LIST_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Paramètres `:type/:tmdbId` d'un élément de liste ; saison et épisode ne sont pas utilisés. */
export const listItemKeySchema = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
});

/** Texte d'une note de lien public : nettoyé et vérifié (140 caractères, sans contrôle), ou absent. */
export function cleanShareNote(raw: string | undefined): { note?: string; issues: string[] } {
  if (raw === undefined || raw.trim() === '') return { issues: [] };
  const cleaned = cleanNoteBody('text', raw);
  return cleaned.issues.length > 0 ? { issues: cleaned.issues } : { note: cleaned.body, issues: [] };
}
