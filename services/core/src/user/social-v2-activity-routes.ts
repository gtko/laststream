import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { announceActivity, type ProgressState, progressActivityKinds } from './social-v2-activity.js';
import type { UserBackend } from './repo.js';
import { actorOf } from './social-v2-routes.js';
import { activityQuery, heatmapQuery, missedQuery } from './social-v2-validation.js';
import { type MediaRef, normalizeMedia } from './social-v2-store.js';
import { parseWith } from './validation.js';

/**
 * Routes d'activité, carte de chaleur et résumé manqué (S5), montées sous `/user/social/*` : contrat « Social v3 ».
 * Profil agissant et contrôle d'accès comme les autres routes v2 (`actorOf`). Le filtre d'audience vit dans
 * social-v2-activity.ts (activityAudienceFilter).
 */

/** Titre d'une requête (type, identifiant et saison ou épisode facultatifs) : la forme `MediaRef` sans champ vide. */
function mediaOf(query: { type: 'movie' | 'series'; tmdbId: number; season?: number | undefined; episode?: number | undefined }): MediaRef {
  const media: MediaRef = { type: query.type, tmdbId: query.tmdbId };
  if (query.season !== undefined) media.season = query.season;
  if (query.episode !== undefined) media.episode = query.episode;
  return normalizeMedia(media);
}

/**
 * Activité d'une écriture de progression (PUT /profiles/:id/progress) : débuts et fins, dédoublonnés par titre et jour.
 * Un profil sans identité sociale (enfant) n'en produit aucune. Sans effet tant qu'aucun genre ne s'applique.
 */
export async function recordProgressActivity(
  backend: UserBackend,
  deps: AppDeps,
  profile: { id: string; accountId: string },
  media: MediaRef,
  before: ProgressState | undefined,
  after: ProgressState,
  now: number,
): Promise<void> {
  const kinds = progressActivityKinds(before, after);
  if (kinds.length === 0) return;
  const social = backend.socialV2();
  const identity = await social.identityOf(profile.accountId, profile.id);
  if (identity === undefined || identity.isKid || identity.pid === null) return;
  for (const kind of kinds) {
    const item = await social.recordActivity(identity.pid, kind, media, {}, now);
    if (item !== undefined) announceActivity(deps.socialEvents, item);
  }
}

export function registerSocialV2ActivityRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);

  /**
   * Flux d'activité des amis et du foyer, sans les miennes : `{ items }`, du plus récent au plus ancien. `?before=<at ms>`
   * (les événements antérieurs) et `?limit=` (1 à 50, 30 par défaut). 400 `invalid_body` si mal formé.
   */
  router.get('/social/activity', async (c) => {
    const me = await actor(c);
    const query = parseWith(activityQuery, queryParams(c));
    return sendJson(c, { items: await social().activityFeed(me.pid, query.before, query.limit) });
  });

  /**
   * Carte de chaleur des notes d'un titre (les miennes, amis et foyer) : `{ buckets }`, un compte par tranche. `?buckets=`
   * de 1 à 200, 60 par défaut. Titre requis : `type` et `tmdbId`.
   */
  router.get('/social/notes/heatmap', async (c) => {
    const me = await actor(c);
    const query = parseWith(heatmapQuery, queryParams(c));
    return sendJson(c, { buckets: await social().notesHeatmap(me.pid, mediaOf(query), query.buckets) });
  });

  /**
   * Résumé de fin de mode cinéma depuis `?since=<ms>` (exclu) : `{ messages, byFriend, notes }`. Messages reçus des amis et du
   * foyer ; notes des autres sur le titre si `type` et `tmdbId` sont donnés (sinon `notes` est vide).
   */
  router.get('/social/missed', async (c) => {
    const me = await actor(c);
    const query = parseWith(missedQuery, queryParams(c));
    const media = query.type === undefined || query.tmdbId === undefined ? undefined : mediaOf({ ...query, type: query.type, tmdbId: query.tmdbId });
    return sendJson(c, await social().missedSince(me.pid, query.since, media));
  });
}
