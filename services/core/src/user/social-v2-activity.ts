import { emitSocialEvent, type SocialEventHandler } from './social-v2-events.js';
import type { Handle } from './social-v2-store.js';

/**
 * Activité sociale (contrat S5) : types, règles pures et filtres d'audience. L'écriture et la lecture vivent dans
 * SocialV2Store (même base que les notes et les messages) ; les routes dans social-v2-activity-routes.ts.
 */

/** Genres d'événements : débuts et fins de lecture, notes posées, notes sur 5, favoris et listes. */
export type ActivityKind = 'started' | 'finished' | 'rated' | 'noted' | 'favorited' | 'listed';

/** Titre d'un événement, figé à l'écriture. Saison et épisode absents pour un film. */
interface ActivityMedia {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  poster?: string;
  season?: number;
  episode?: number;
}

/** Événement d'activité tel que le contrat le décrit (`GET /user/social/activity`). Aucun identifiant interne. */
export interface ActivityItem {
  id: string;
  pid: string;
  handle: Handle;
  avatarColor: string;
  /** Avatar illustré du profil, absent : la lettre sur la couleur. */
  avatar?: string;
  kind: ActivityKind;
  media: ActivityMedia;
  rating?: number;
  /** Instant de l'événement (ms). */
  at: number;
}

/** Champs facultatifs d'un événement : note sur 5 (demi-étoiles), titre et affiche quand l'appelant les connaît. */
export interface ActivityOptions {
  rating?: number;
  title?: string;
  poster?: string;
}

/** Jour de dédoublonnage : AAAA-MM-JJ en UTC. Un événement par titre, genre et jour. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Note sur 5 par demi-étoiles : de 0,5 à 5. */
export function isActivityRating(value: number): boolean {
  return Number.isFinite(value) && value >= 0.5 && value <= 5 && Number.isInteger(value * 2);
}

/** Relevé de progression utile aux événements : position (s) et terminé. */
export interface ProgressState {
  positionSec: number;
  finished: boolean;
}

/**
 * Événements produits par une écriture de progression. `started` : la position passe de rien (ligne absente ou à 0) à une
 * position positive. `finished` : la ligne devient terminée. `before` : ligne avant écriture (`undefined` si absente).
 */
export function progressActivityKinds(before: ProgressState | undefined, after: ProgressState): ActivityKind[] {
  const kinds: ActivityKind[] = [];
  if ((before === undefined || before.positionSec <= 0) && after.positionSec > 0) kinds.push('started');
  if (after.finished && !(before?.finished ?? false)) kinds.push('finished');
  return kinds;
}

/**
 * Compte des positions (s) par tranches égales de `[0, duration]`, en `buckets` tranches. Une position au-delà de la durée
 * tombe dans la dernière tranche ; sans durée connue, tout tombe dans la première.
 */
export function heatmapBuckets(positions: readonly number[], duration: number, buckets: number): number[] {
  const counts = new Array<number>(buckets).fill(0);
  for (const pos of positions) {
    const index = duration > 0 ? Math.min(buckets - 1, Math.max(0, Math.floor((pos / duration) * buckets))) : 0;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

/**
 * Clause SQL « la colonne `column` désigne un ami accepté ou un profil du foyer de `viewerPid` », le spectateur exclu.
 * Cinq paramètres, tous `viewerPid`, à lier dans `params` dans l'ordre. Sert aux notes, à l'activité et au résumé manqué.
 */
export function peerPidsFilter(column: string, viewerPid: string): { sql: string; params: string[] } {
  return {
    sql: `${column} IN (
            SELECT CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END FROM profile_friendships f
             WHERE f.status = 'accepted' AND (f.low_pid = ? OR f.high_pid = ?)
            UNION
            SELECT h.pid FROM profiles h
             WHERE h.account_id = (SELECT me.account_id FROM profiles me WHERE me.pid = ?) AND h.pid <> ? AND h.is_kid = 0 AND h.pid IS NOT NULL)`,
    params: [viewerPid, viewerPid, viewerPid, viewerPid, viewerPid],
  };
}

/**
 * Filtre d'audience de l'activité : les événements que `viewerPid` voit. Amis acceptés et foyer, jamais les siens, jamais
 * ceux d'un profil en statut « invisible » (vu hors ligne par les autres). Pour un ami (le foyer voit tout) s'ajoutent les
 * réglages de S2 : préférence `activityVisibility` du profil vu (« friends » ; « favorites » : seulement ses favoris ;
 * « nobody »), masquage `hideActivity` posé par le spectateur sur ce profil (il ne veut plus voir cet ami dans son flux),
 * et sourdine (`muted`) posée par le spectateur sur ce profil. La requête doit avoir `activity AS a` et `profile_presence AS pr`
 * (LEFT JOIN sur `pr.profile_pid = a.pid`). Les paramètres se lient dans l'ordre de `params`.
 */
export function activityAudienceFilter(viewerPid: string): { sql: string; params: string[] } {
  const peers = peerPidsFilter('a.pid', viewerPid);
  const visibility = `COALESCE((SELECT CASE WHEN json_valid(sp.prefs) THEN json_extract(sp.prefs, '$.activityVisibility') END FROM social_prefs sp WHERE sp.profile_pid = a.pid), 'friends')`;
  const sql = `${peers.sql} AND COALESCE(pr.status, 'online') <> 'invisible'
            AND NOT EXISTS (SELECT 1 FROM profile_relations muted WHERE muted.owner_pid = ? AND muted.target_pid = a.pid AND muted.muted = 1)
            AND (
              a.pid IN (SELECT h.pid FROM profiles h WHERE h.account_id = (SELECT me.account_id FROM profiles me WHERE me.pid = ?) AND h.pid <> ?)
              OR (
                ${visibility} NOT IN ('favorites', 'nobody')
                OR (${visibility} = 'favorites' AND EXISTS (SELECT 1 FROM profile_relations fav WHERE fav.owner_pid = a.pid AND fav.target_pid = ? AND fav.favorite = 1))
              ) AND NOT EXISTS (SELECT 1 FROM profile_relations hide WHERE hide.owner_pid = ? AND hide.target_pid = a.pid AND hide.hide_activity = 1)
            )`;
  return { sql, params: [...peers.params, viewerPid, viewerPid, viewerPid, viewerPid, viewerPid] };
}

/**
 * Diffuse un événement d'activité en temps réel. Destinataires (voir SocialV2Store.activityLiveAudience) : seulement un début
 * de titre, vers les amis qui ont le profil en favori et dont `notify.friendStarts` est vrai.
 */
export async function announceActivity(
  handler: SocialEventHandler | undefined,
  social: { activityLiveAudience(item: ActivityItem): Promise<string[]> },
  item: ActivityItem,
): Promise<void> {
  if (handler === undefined || item.kind !== 'started') return;
  emitSocialEvent(handler, await social.activityLiveAudience(item), { t: 'activity', item });
}
