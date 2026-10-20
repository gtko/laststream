import type { App, Ctx } from '../http/app-env.js';
import { sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { announceActivity } from './social-v2-activity.js';
import { actorOf, pidParam } from './social-v2-routes.js';
import { cleanProfilePatch, profilePatchSchema } from './social-v2-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Profil social étendu (contrat S1), montées sous `/user` avec les routes sociales v2 : `/social/profile*` (mon profil) et
 * `/social/friends/:pid/profile` (profil d'un ami ou d'un membre du foyer). Mêmes conventions : profil agissant
 * (`X-Profile-Id`), profil enfant refusé (403), pid public seul identifiant exposé, erreurs `{ error }`.
 */

/** Renvoie la vue, ou lève 404 avec le code donné quand elle est absente (profil inconnu, enfant, ou sans lien). */
function found<T>(view: T | undefined, code: string): T {
  if (view === undefined) throw new UserApiError(404, code);
  return view;
}

export function registerSocialV2ProfileRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, users(), social(), deps.secret);

  /** Mon profil social : bio, statut, bannière, favoris, chiffres, et `tagChangeableAt` tant que le tag est bloqué. */
  router.get('/social/profile', async (c) => {
    const me = await actor(c);
    return sendJson(c, found(await social().profileOf(me.pid, Date.now()), 'profile_not_found'));
  });

  /**
   * Modification partielle (`name`, `avatarColor`, `bio`, `customStatus`, `banner`, `favorites`) ; `null` retire bio, statut
   * ou bannière. Renvoie le profil après écriture. 400 `invalid_body` avec la liste des champs refusés (`issues`).
   */
  router.put('/social/profile', async (c) => {
    const me = await actor(c);
    const now = Date.now();
    const { patch, issues } = cleanProfilePatch(parseWith(profilePatchSchema, c.get('body')), now);
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    const activity = await social().updateSocialProfile(me.pid, patch, now);
    for (const item of activity ?? []) await announceActivity(deps.socialEvents, social(), item);
    return sendJson(c, found(await social().profileOf(me.pid, now), 'profile_not_found'));
  });

  /**
   * Nouveau tag tiré au hasard (le nom ne change pas). 429 `tag_cooldown` tant que 30 jours ne se sont pas écoulés depuis le
   * dernier changement (`Retry-After` indique le délai). Renvoie le profil après changement.
   */
  router.post('/social/profile/tag', async (c) => {
    const me = await actor(c);
    const now = Date.now();
    const outcome = await social().changeTag(me.pid, now);
    if (outcome.result === 'unknown') throw new UserApiError(404, 'profile_not_found');
    if (outcome.result === 'cooldown') throw new UserApiError(429, 'tag_cooldown', undefined, outcome.retryAfterSec);
    return sendJson(c, found(await social().profileOf(me.pid, now), 'profile_not_found'));
  });

  /**
   * Profil social d'un ami ou d'un membre du foyer. Sans lien (demande en attente, inconnu, enfant) : 404 `friend_not_found`,
   * sans rien révéler de plus.
   */
  router.get('/social/friends/:pid/profile', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    return sendJson(c, found(await social().friendProfileOf(me.pid, targetPid, Date.now()), 'friend_not_found'));
  });
}
