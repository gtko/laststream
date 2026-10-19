import { emitSocialEvent, type SocialEventHandler } from './social-v2-events.js';
import type { Handle } from './social-v2-store.js';

/**
 * Activité sociale (contrat S5) : types, règles pures et filtres d'audience. L'écriture et la lecture vivent dans
 * SocialV2Store (même base que les notes et les messages) ; les routes dans social-v2-activity-routes.ts.
 */

/** Genres d'événements : débuts et fins de lecture, notes posées, notes sur 5, favoris et listes. */
export const ACTIVITY_KINDS = ['started', 'finished', 'rated', 'noted', 'favorited', 'listed'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Titre d'un événement, figé à l'écriture. Saison et épisode absents pour un film. */
export interface ActivityMedia {
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
 * Filtre d'audience de l'activité : les événements que `viewerPid` voit. Aujourd'hui : ceux des amis acceptés et du foyer,
 * jamais les siens, et jamais ceux d'un profil en statut « invisible » (vu hors ligne par les autres). La requête doit
 * avoir `activity AS a` et `profile_presence AS pr` (LEFT JOIN sur `pr.profile_pid = a.pid`).
 *
 * S2 : activityVisibility / hideActivity / muted. Brancher ici : la liste (GET /activity) et le flux temps réel partagent ce point.
 */
export function activityAudienceFilter(viewerPid: string): { sql: string; params: string[] } {
  const peers = peerPidsFilter('a.pid', viewerPid);
  return { sql: `${peers.sql} AND COALESCE(pr.status, 'online') <> 'invisible'`, params: peers.params };
}

/**
 * Destinataires du flux temps réel `{t:"activity"}`. S2 : seulement un ami favori qui commence un titre (`started`), vers les
 * profils dont `notify.friendStarts` est vrai (défaut : faux). Tant que S2 n'est pas fusionné, personne ne le reçoit.
 */
export function activityLiveAudience(): string[] {
  return [];
}

/** Diffuse un événement d'activité aux destinataires de `activityLiveAudience` (sans effet tant qu'il n'y en a pas). */
export function announceActivity(handler: SocialEventHandler | undefined, item: ActivityItem): void {
  emitSocialEvent(handler, activityLiveAudience(), { t: 'activity', item });
}
