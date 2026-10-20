import { z } from 'zod';
import type { ConvScope, MessageKind } from './social-v2-store.js';
import { cleanMessageBody, cleanNoteBody, isPid, MESSAGE_MAX_CHARS } from './social-v2-validation.js';

/** Schémas des routes S2 (préférences, relations, blocages, signalements, demandes de rejoindre). Objets stricts. */

const notifySchema = z.strictObject({
  messages: z.boolean().optional(),
  requests: z.boolean().optional(),
  parties: z.boolean().optional(),
  friendStarts: z.boolean().optional(),
  vibrate: z.boolean().optional(),
  sound: z.boolean().optional(),
});

/** `PUT /prefs` : corps partiel. Les valeurs nulles ne sont pas acceptées (une préférence se remet à sa valeur par défaut en la réécrivant). */
export const prefsPatchSchema = z.strictObject({
  activityVisibility: z.enum(['friends', 'favorites', 'nobody']).optional(),
  watchWith: z.enum(['open', 'ask', 'never']).optional(),
  libraryVisibility: z.enum(['friends', 'household', 'private']).optional(),
  messagesFrom: z.enum(['friends', 'favorites', 'household']).optional(),
  historyVisible: z.boolean().optional(),
  antiSpoiler: z.boolean().optional(),
  playbackSocial: z.enum(['all', 'messages', 'cinema']).optional(),
  notify: notifySchema.optional(),
});

/** `PUT /friends/:pid/relation` : favori, surnom (≤ 32 car. ; vide ou null = aucun), sourdine, masquage d'activité. */
export const relationSchema = z.strictObject({
  favorite: z.boolean().optional(),
  nickname: z.string().trim().max(32).nullable().optional(),
  muted: z.boolean().optional(),
  hideActivity: z.boolean().optional(),
});

/** `POST /reports` : pid du profil signalé, motif, détails facultatifs (≤ 500 car.). */
export const reportSchema = z.strictObject({
  pid: z.string().max(64),
  reason: z.enum(['spam', 'harassment', 'other']),
  details: z.string().trim().max(500).optional(),
});

/** `POST /join-requests/:pid` : réponse de l'hôte. `partyId` : salon à rejoindre, facultatif. */
export const joinAnswerSchema = z.strictObject({
  accept: z.boolean(),
  partyId: z.string().trim().min(1).max(64).optional(),
});

/**
 * Schémas des routes sociales v3 (`/user/social/conv/*`, `/user/social/groups*`) : messages riches, réactions, sondages,
 * groupes. Objets stricts : une clé inconnue est refusée. Titres, moments et sondages sont validés strictement (une valeur
 * hors forme refuse la requête, rien n'est silencieusement retiré).
 */

/** Caractère de contrôle (saut de ligne compris). */
const CONTROL_CHARACTER = /\p{Cc}/u;
const hasControl = (text: string): boolean => [...text].some((ch) => CONTROL_CHARACTER.test(ch));

/** Identifiant de groupe (uuid minuscule, voir social-v2-store). */
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isGroupId = (value: string): boolean => GROUP_ID.test(value);

/**
 * Conversation de l'URL : `dm:<pid de l'autre>` ou `g:<id de groupe>`. Forme inconnue : `undefined` (404 côté route).
 */
export function parseConv(raw: string): ConvScope | undefined {
  if (raw.startsWith('dm:')) {
    const peer = raw.slice(3);
    return isPid(peer) ? { kind: 'dm', peer } : undefined;
  }
  if (raw.startsWith('g:')) {
    const id = raw.slice(2);
    return isGroupId(id) ? { kind: 'group', id } : undefined;
  }
  return undefined;
}

/** Texte d'une ligne (titre, libellé, nom) : 1 à `max` caractères, sans caractère de contrôle. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControl(value), 'text:control_char');

const TMDB_ID = z.number().int().positive().max(1_000_000_000);
const SEASON = z.number().int().min(0).max(10_000);
const EPISODE = z.number().int().min(0).max(10_000);
const POSITION = z.number().min(0).max(10_000_000);
const MEDIA_TYPE = z.enum(['movie', 'series']);

/** Image TMDB : URL https du CDN TMDB, ou chemin du site (`/…`, jamais `//` ni un antislash après `/`). */
function isImageRef(value: string): boolean {
  if (value.startsWith('https://image.tmdb.org/')) return true;
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}
const IMAGE_REF = z
  .string()
  .max(500)
  .refine(isImageRef, 'image:format');

/** Titre partagé (kind title). `rating` : note de l'expéditeur sur 5. */
export const titleSchema = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID,
  title: plainText(200),
  poster: IMAGE_REF.optional(),
  year: z.number().int().min(1870).max(2200).optional(),
  rating: z.number().min(0).max(5).optional(),
});

/** Moment d'un titre (kind moment) : saison et épisode facultatifs (ignorés pour un film), position en secondes. */
export const momentSchema = z.strictObject({
  type: MEDIA_TYPE,
  tmdbId: TMDB_ID,
  season: SEASON.optional(),
  episode: EPISODE.optional(),
  title: plainText(200),
  pos: POSITION,
  still: IMAGE_REF.optional(),
});

/** Invitation à un salon (kind party). Identifiant de salon : lettres, chiffres, `_` et `-`. */
export const partySchema = z.strictObject({
  partyId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  title: plainText(200),
});

/** Sondage : question et 2 à 6 options distinctes (sans tenir compte de la casse). */
export const pollSchema = z
  .strictObject({
    question: plainText(200),
    options: z.array(plainText(80)).min(2).max(6),
  })
  .refine((poll) => new Set(poll.options.map((option) => option.toLowerCase())).size === poll.options.length, 'options:duplicate');

export const MESSAGE_KINDS = ['text', 'title', 'moment', 'party', 'poll'] as const;

/**
 * Corps de `POST /conv/:conv/messages`. La charge doit correspondre au kind : `title` pour `kind: "title"`, etc., et
 * aucune autre charge n'est admise. Le texte (`body`) est vérifié ensuite (voir `cleanConvBody`).
 */
export const convMessageSchema = z
  .strictObject({
    kind: z.enum(MESSAGE_KINDS),
    body: z.string().max(4000).optional(),
    title: titleSchema.optional(),
    moment: momentSchema.optional(),
    party: partySchema.optional(),
    poll: pollSchema.optional(),
    replyTo: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  })
  .superRefine((input, ctx) => {
    for (const key of ['title', 'moment', 'party', 'poll'] as const) {
      const present = input[key] !== undefined;
      const expected = key === input.kind;
      if (present && !expected) ctx.addIssue({ code: 'custom', path: [key], message: 'kind:mismatch' });
      if (!present && expected) ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
    }
  });

/** Texte d'un message selon son kind : requis (1 à 1000 caractères) pour `text`, facultatif sinon (légende). */
export function cleanConvBody(kind: MessageKind, raw: string): { body: string; issues: string[] } {
  if (kind === 'text') return cleanMessageBody(raw);
  const body = raw.trim();
  const issues: string[] = [];
  if ([...body].length > MESSAGE_MAX_CHARS) issues.push('body:too_long');
  if ([...body].some((ch) => CONTROL_CHARACTER.test(ch) && ch !== '\n')) issues.push('body:control_char');
  return { body, issues };
}

/** `POST /conv/:conv/messages/:id/reactions` : un emoji (vérifié ensuite, voir isSingleEmoji). */
export const reactionSchema = z.strictObject({ emoji: z.string().min(1).max(64) });

/** `POST /conv/:conv/polls/:pollId/vote` : identifiant de l'option choisie. */
export const voteSchema = z.strictObject({ optionId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });

const GROUP_NAME = plainText(40);
/** Pid d'un membre : une valeur inconnue ou non amie est refusée côté store (403 not_friend). */
const MEMBER_PID = z.string().max(64);

/** `POST /groups` : nom et 2 à 19 autres membres (le créateur compte en plus : 20 au plus). */
export const groupCreateSchema = z
  .strictObject({
    name: GROUP_NAME,
    members: z.array(MEMBER_PID).min(2).max(19),
  })
  .refine((input) => new Set(input.members).size === input.members.length, 'members:duplicate');

/** `PUT /groups/:id` : au moins une des trois clés ; ajouts et retraits disjoints. */
export const groupUpdateSchema = z
  .strictObject({
    name: GROUP_NAME.optional(),
    add: z.array(MEMBER_PID).min(1).max(19).optional(),
    remove: z.array(MEMBER_PID).min(1).max(19).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.name === undefined && input.add === undefined && input.remove === undefined) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'required' });
    }
    if (input.add !== undefined && new Set(input.add).size !== input.add.length) ctx.addIssue({ code: 'custom', path: ['add'], message: 'duplicate' });
    if (input.remove !== undefined && new Set(input.remove).size !== input.remove.length) {
      ctx.addIssue({ code: 'custom', path: ['remove'], message: 'duplicate' });
    }
    if (input.add !== undefined && input.remove !== undefined && input.add.some((pid) => input.remove?.includes(pid))) {
      ctx.addIssue({ code: 'custom', path: ['add'], message: 'overlap' });
    }
  });

/* ---- Partage, liens publics et listes partagées (S3b) : `/user/social/share`, `/share-links`, `/lists` ---- */

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

/** Destinataire : un ami (`pid`) ou un groupe (`group` : identifiant de groupe, S3a). */
const RECIPIENT = z.union([z.strictObject({ pid: PID }), z.strictObject({ group: z.string().refine(isGroupId, 'group:format') })]);

/** Corps de `POST /share`. La cohérence kind / titre / moment est vérifiée par la route. */
export const shareSchema = z.strictObject({
  to: z.array(RECIPIENT).min(1).max(20),
  kind: z.enum(['title', 'moment']),
  title: titleSchema.optional(),
  moment: momentSchema.optional(),
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
