import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { announceActivity } from './social-v2-activity.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf } from './social-v2-routes.js';
import { cleanNoteBody, noteSchema, notesQuery } from './social-v2-validation.js';
import { normalizeMedia } from './social-v2-store.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes des notes (`/user/social/notes`) : contrat « Social v2 ». Une note est posée par le profil agissant sur un titre,
 * à une position. Visibles par leur auteur, ses amis et son foyer. Seul l'auteur peut la supprimer.
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
    if (outcome.activity !== undefined) announceActivity(deps.socialEvents, outcome.activity);
    return sendJson(c, { note: outcome.note }, 201);
  });

  /** Supprime une note de son auteur. 204 ; 404 `note_not_found` si la note n'existe pas ou n'est pas à ce profil. */
  router.delete('/social/notes/:id', async (c) => {
    const me = await actor(c);
    if (!(await social().deleteNote(me.pid, String(c.req.param('id'))))) throw new UserApiError(404, 'note_not_found');
    return sendEmpty(c, 204);
  });
}
