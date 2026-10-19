import type { App, Ctx } from '../http/app-env.js';
import { sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf, pidParam } from './social-v2-routes.js';
import { isPid } from './social-v2-validation.js';
import { joinAnswerSchema, prefsPatchSchema, relationSchema, reportSchema } from './social-v3-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes S2 (`/user/social/*`, contrat « Social v3 », S2) : préférences, relations par ami, blocages, signalements et
 * demandes de rejoindre. Profil agissant et contrôle d'accès comme pour les autres routes v2 (`actorOf`). Les effets
 * (visibilité, messages, blocages) sont appliqués par le store : ces routes ne font que valider, appeler et émettre.
 */
export function registerSocialV3Routes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);

  // Préférences

  /** Préférences du profil agissant, défauts compris. */
  router.get('/social/prefs', async (c) => {
    const me = await actor(c);
    return sendJson(c, await social().prefsOf(me.pid));
  });

  /** Mise à jour partielle des préférences. Renvoie les préférences complètes. */
  router.put('/social/prefs', async (c) => {
    const me = await actor(c);
    const patch = parseWith(prefsPatchSchema, c.get('body'));
    return sendJson(c, await social().updatePrefs(me.pid, patch));
  });

  // Relations par ami

  /**
   * Relation du profil agissant vers un ami : favori, surnom (vide ou null = aucun), sourdine, masquage d'activité.
   * Renvoie la vue de l'ami. 404 `friend_not_found` si ce profil n'est pas un ami.
   */
  router.put('/social/friends/:pid/relation', async (c) => {
    const me = await actor(c);
    const friendPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const input = parseWith(relationSchema, c.get('body'));
    const nickname = input.nickname === undefined ? undefined : input.nickname === '' ? null : input.nickname;
    const view = await social().updateRelation(me.pid, friendPid, { ...input, nickname }, Date.now());
    if (view === undefined) throw new UserApiError(404, 'friend_not_found');
    return sendJson(c, view);
  });

  // Blocages

  /** Profils bloqués par le profil agissant : `{ blocked: [{ pid, handle }] }`. */
  router.get('/social/blocks', async (c) => {
    const me = await actor(c);
    return sendJson(c, { blocked: await social().blockedOf(me.pid) });
  });

  /**
   * Bloque un profil. 204. Retire l'amitié (acceptée ou en attente) et les demandes de rejoindre, dans les deux sens ; les
   * deux profils reçoivent `unfriend` si une amitié vient de tomber. 400 `self`, 400 `household` (le foyer ne se bloque
   * pas), 404 `profile_not_found`.
   */
  router.post('/social/blocks/:pid', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'profile_not_found');
    const outcome = await social().blockProfile(me.pid, targetPid, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'profile_not_found');
    if (outcome.result === 'household') throw new UserApiError(400, 'household');
    if (outcome.unlinked) {
      emitSocialEvent(deps.socialEvents, [targetPid], { t: 'unfriend', pid: me.pid });
      emitSocialEvent(deps.socialEvents, [me.pid], { t: 'unfriend', pid: targetPid });
    }
    return sendEmpty(c, 204);
  });

  /** Débloque un profil. 204 ; 404 `block_not_found` s'il n'était pas bloqué. L'amitié n'est pas rétablie. */
  router.delete('/social/blocks/:pid', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'block_not_found');
    if (!(await social().unblockProfile(me.pid, targetPid))) throw new UserApiError(404, 'block_not_found');
    return sendEmpty(c, 204);
  });

  // Signalements

  /**
   * Signale un profil : `{ pid, reason: 'spam'|'harassment'|'other', details? (≤ 500) }`. 201 sans corps. 400 `self`,
   * 404 `profile_not_found` (pid inconnu ou mal formé).
   */
  router.post('/social/reports', async (c) => {
    const me = await actor(c);
    const input = parseWith(reportSchema, c.get('body'));
    if (!isPid(input.pid)) throw new UserApiError(404, 'profile_not_found');
    const outcome = await social().addReport(me.pid, input.pid, input.reason, input.details, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'profile_not_found');
    return c.body(null, 201);
  });

  // Demandes de rejoindre

  /**
   * Demande à rejoindre le titre en cours de l'ami `:pid`. 204. L'ami reçoit `join_request` (vue du demandeur). 403
   * `not_allowed` si l'ami a désactivé le partage de lecture (`watchWith` = « never »). 404 `friend_not_found` sans lien.
   */
  router.post('/social/friends/:pid/join-request', async (c) => {
    const me = await actor(c);
    const hostPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const outcome = await social().requestJoin(me.pid, hostPid, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'friend_not_found');
    if (outcome.result === 'not_allowed') throw new UserApiError(403, 'not_allowed');
    emitSocialEvent(deps.socialEvents, [hostPid], { t: 'join_request', from: outcome.from });
    return sendEmpty(c, 204);
  });

  /**
   * Réponse de l'hôte à la demande du profil `:pid`. Corps `{ accept, partyId? }`. 204. Le demandeur reçoit `join_answer`
   * (`pid` = l'hôte). 404 `request_not_found` s'il n'y a pas de demande en attente.
   */
  router.post('/social/join-requests/:pid', async (c) => {
    const me = await actor(c);
    const requesterPid = pidParam(String(c.req.param('pid')), 'request_not_found');
    const input = parseWith(joinAnswerSchema, c.get('body'));
    if (!(await social().answerJoin(me.pid, requesterPid))) throw new UserApiError(404, 'request_not_found');
    emitSocialEvent(deps.socialEvents, [requesterPid], {
      t: 'join_answer',
      pid: me.pid,
      accept: input.accept,
      ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
    });
    return sendEmpty(c, 204);
  });
}
