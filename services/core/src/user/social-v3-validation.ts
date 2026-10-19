import { z } from 'zod';

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
