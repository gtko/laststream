import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { announceActivity } from './social-v2-activity.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf, pidParam } from './social-v2-routes.js';
import { cleanNoteBody, friendNotesQuery, noteEditSchema, noteSchema, notesQuery } from './social-v2-validation.js';
import { normalizeMedia } from './social-v2-store.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes des notes (`/user/social/notes`) : contrat « Social v2 ». Une note est posée par le profil agissant sur un titre,
 * à une position. Visibles par leur auteur, ses amis et son foyer. Seul l'auteur peut la modifier ou la supprimer.
 */
export function registerSocialV2NoteRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);

  /** Notes d'un titre visibles par le profil agissant : `{ notes }`, triées par position, 500 au plus. */
  router.get('/social/notes', async (c) => {
    const me = await actor(c);
    const query = parseWith(notesQuery, queryParams(c));
    return sendJson(c, { notes: await social().notesOf(me.pid, normalizeMedia(query)) });
  });

  /**
   * Pose une note : texte de 1 à 140 caractères, ou exactement un emoji. 201 `{ note }`. 429 au-delà de 20 par minute.
   * L'événement `note` part vers les amis et le foyer de l'auteur.
   */
  router.post('/social/notes', async (c) => {
    const me = await actor(c);
    const input = parseWith(noteSchema, c.get('body'));
    const { body, issues } = cleanNoteBody(input.kind, input.body);
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    const media = normalizeMedia(input);
    const outcome = await social().addNote(me.pid, media, input.pos, input.kind, body, Date.now());
    if (outcome.result === 'unknown') throw new UserApiError(404, 'profile_not_found');
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    emitSocialEvent(deps.socialEvents, outcome.audience, { t: 'note', media, note: outcome.note });
    if (outcome.activity !== undefined) await announceActivity(deps.socialEvents, social(), outcome.activity);
    return sendJson(c, { note: outcome.note }, 201);
  });

  /**
   * Modifie le texte ou l'emoji de sa note : position, date et titre inchangés, pas de quota. 200 `{ note }` ; 400
   * `invalid_body` ; 404 `note_not_found` si la note n'existe pas ou n'est pas à ce profil. L'événement `note` repart vers
   * les amis et le foyer de l'auteur, et le client remplace la note par son identifiant.
   */
  router.patch('/social/notes/:id', async (c) => {
    const me = await actor(c);
    const input = parseWith(noteEditSchema, c.get('body'));
    const { body, issues } = cleanNoteBody(input.kind, input.body);
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    const outcome = await social().updateNote(me.pid, String(c.req.param('id')), input.kind, body);
    if (outcome.result === 'not_found') throw new UserApiError(404, 'note_not_found');
    emitSocialEvent(deps.socialEvents, outcome.audience, { t: 'note', media: outcome.media, note: outcome.note });
    return sendJson(c, { note: outcome.note });
  });

  /**
   * Supprime une note de son auteur. 204 ; 404 `note_not_found` si la note n'existe pas ou n'est pas à ce profil. L'événement
   * `note_removed` (titre et identifiant) part vers les amis et le foyer de l'auteur ; rien n'part en cas de refus.
   */
  router.delete('/social/notes/:id', async (c) => {
    const me = await actor(c);
    const id = String(c.req.param('id'));
    const removed = await social().removeNote(me.pid, id);
    if (removed === undefined) throw new UserApiError(404, 'note_not_found');
    emitSocialEvent(deps.socialEvents, removed.audience, { t: 'note_removed', media: removed.media, id });
    return sendEmpty(c, 204);
  });

  /**
   * Notes d'un ami ou d'un membre du foyer (ou les miennes), du plus récent au plus ancien : `{ notes }` (`?limit=` 1 à 50,
   * 30 par défaut ; `?before=` createdAt ms exclu). 404 `friend_not_found` sans lien ; 403 `hidden` si l'historique de
   * l'ami est masqué. Une note masquée par l'anti-spoiler sort avec `hidden: true` et un corps vide.
   */
  router.get('/social/friends/:pid/notes', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const query = parseWith(friendNotesQuery, queryParams(c));
    const outcome = await social().friendNotes(me.pid, targetPid, query.before, query.limit);
    if (outcome.result === 'unknown') throw new UserApiError(404, 'friend_not_found');
    if (outcome.result === 'hidden') throw new UserApiError(403, 'hidden');
    return sendJson(c, { notes: outcome.notes });
  });
}
