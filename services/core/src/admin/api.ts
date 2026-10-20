import type { AppDeps } from '../deps.js';
import { type App, type Ctx, newApp } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { metricsService } from '../metrics/index.js';
import type { PartyBackend } from '../party/backend.js';
import { platform, runtimeEnv } from '../platform/index.js';
import { createRateLimiter } from '../rate-limit.js';
import { generateSessionToken, hashSessionToken, verifySecret } from '../user/crypto.js';
import type { AdminRepo, UserBackend, UserRepo } from '../user/repo.js';
import { assertUnlocked, nowIso, type Session, sessionOf } from '../user/session.js';
import { userErrorHandler } from '../user/routes.js';
import { parseWith, UserApiError } from '../user/validation.js';
import { RESET_TTL_MS } from '../user/admin-store.js';
import { isCachePrefix } from './cache-types.js';
import { registerAnnouncementAdminRoutes } from './ops-announcements.js';
import { ELEVATION_TTL_MS, signElevation, verifyElevation } from './elevation.js';
import type { MaintenanceGate } from './maintenance.js';
import {
  accountIdParam,
  accountListQuery,
  auditQuery,
  cacheQuery,
  elevateBody,
  inviteQuotaBody,
  metricsQuery,
  purgeIdParam,
  reportActionBody,
  reportIdParam,
  reportListQuery,
  roomIdParam,
  sessionIdParam,
  settingsPatch,
} from './validation.js';

/** Point de montage de l'API d'administration. */
export const ADMIN_MOUNT = '/admin';
const WINDOW_MS = 60_000;
/** Limites par IP et par minute (avant toute authentification) : lectures, écritures, ré-authentification. */
const LIMITS = { read: 120, write: 30, elevate: 5 } as const;
const ELEVATE_WINDOW_MS = 10 * 60_000;
const ROOMS_LISTED = 200;
const ROOM_PARALLEL = 10;

/**
 * API d'administration, montée sous /admin et réservée au propriétaire (session du compte owner : 401 sans session,
 * 403 pour tout autre compte et pour un profil enfant). Les actions destructrices exigent un jeton d'élévation récent
 * (POST /admin/elevate : mot de passe du propriétaire, valable 10 minutes) dans l'en-tête X-Admin-Elevation. Toute action
 * est inscrite au journal d'audit avant d'être exécutée. Aucune réponse ne contient de hash, de jeton, de configuration
 * chiffrée ni de clé. Voir docs/admin.md.
 */
export function registerAdminRoutes(app: App, deps: AppDeps, backend: UserBackend, maintenance: MaintenanceGate, party: PartyBackend | undefined): void {
  const users = (): UserRepo => backend.users();
  const admin = (): AdminRepo => backend.admin();
  const limits = { ...LIMITS, ...deps.adminRateLimits };
  const limiters = {
    read: createRateLimiter(limits.read, WINDOW_MS),
    write: createRateLimiter(limits.write, WINDOW_MS),
    elevate: createRateLimiter(limits.elevate, ELEVATE_WINDOW_MS),
  };
  const metricsOf = () => deps.metrics ?? metricsService();
  const cachesOf = () => deps.cacheAdmin ?? platform().cacheAdmin;

  const router = newApp();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  // Limite de débit par IP, avant l'authentification (préflights exclus).
  router.use('*', async (c, next) => {
    if (c.req.method !== 'OPTIONS') {
      const kind = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'write';
      const verdict = limiters[kind](c.get('ip') ?? 'inconnu');
      if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    }
    await next();
  });

  /**
   * Session du profil administrateur : compte propriétaire ET X-Profile-Id égal au profil administrateur (par défaut le
   * plus ancien profil du propriétaire). Sans l'en-tête, ou avec un autre profil (conjoint, enfant) : 403.
   */
  async function owner(c: Ctx): Promise<Session> {
    const session = await sessionOf(users(), c);
    if (!session.account.isOwner) throw new UserApiError(403, 'owner_only');
    const profileId = c.req.header('x-profile-id');
    if (profileId === undefined) throw new UserApiError(403, 'admin_profile_required');
    const profile = await users().findProfile(session.account.id, profileId);
    if (profile === undefined) throw new UserApiError(403, 'profile_invalid');
    if (profile.isKid) throw new UserApiError(403, 'kid_profile');
    if ((await admin().adminProfileId()) !== profile.id) throw new UserApiError(403, 'admin_profile_required');
    assertUnlocked(c, session, profile, deps.secret);
    return session;
  }

  /** Ré-authentification récente exigée (jeton d'élévation lié à cette session). */
  function elevated(c: Ctx, session: Session): void {
    const verdict = verifyElevation(c.req.header('x-admin-elevation'), { accountId: session.account.id, sessionHash: session.tokenHash }, Date.now(), deps.secret);
    if (verdict === 'expired') throw new UserApiError(403, 'elevation_expired');
    if (verdict !== 'ok') throw new UserApiError(403, 'elevation_required');
  }

  const audit = async (session: Session, action: string, target: string | null, detail: Record<string, unknown> | null = null): Promise<void> => {
    await admin().addAudit({ at: nowIso(), actorId: session.account.id, actor: session.account.username, action, target, detail });
  };

  async function targetAccount(c: Ctx) {
    const id = parseWith(accountIdParam, c.req.param('id'));
    const target = await admin().accountById(id);
    if (target === undefined) throw new UserApiError(404, 'account_not_found');
    return target;
  }

  // Session et ré-authentification

  router.get('/me', async (c) => {
    const { account } = await owner(c);
    return sendJson(c, { account: { id: account.id, username: account.username }, elevationTtlSec: ELEVATION_TTL_MS / 1000 });
  });

  /** Désigne un autre profil du propriétaire comme profil administrateur (depuis le profil administrateur seulement). */
  router.put('/admin-profile', async (c) => {
    const session = await owner(c);
    const body = c.get('body') as { profileId?: unknown } | undefined;
    const target = typeof body?.profileId === 'string' ? body.profileId : '';
    const profile = await users().findProfile(session.account.id, target);
    if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
    if (profile.isKid) throw new UserApiError(403, 'kid_profile');
    await audit(session, 'admin.profile', profile.name);
    await admin().setAdminProfileId(profile.id);
    return sendJson(c, { adminProfileId: profile.id });
  });

  /** Ré-authentification : le mot de passe du propriétaire donne un jeton d'élévation de 10 minutes (X-Admin-Elevation). */
  router.post('/elevate', async (c) => {
    const session = await owner(c);
    const body = parseWith(elevateBody, c.get('body'));
    const key = `elevate:${session.account.id}`;
    const allowed = deps.authLimiter !== undefined ? await deps.authLimiter.byUsername(key) : limiters.elevate(key).allowed;
    if (!allowed) throw new UserApiError(429, 'rate_limited', undefined, deps.authLimiter?.retryAfterSec ?? 60);
    const record = await users().accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.password, record.passwordHash))) {
      await audit(session, 'elevate.failed', session.account.username);
      throw new UserApiError(403, 'invalid_password');
    }
    await audit(session, 'elevate', session.account.username);
    return sendJson(c, signElevation({ accountId: session.account.id, sessionHash: session.tokenHash }, Date.now(), deps.secret));
  });

  // Comptes

  router.get('/accounts', async (c) => {
    await owner(c);
    const query = parseWith(accountListQuery, queryParams(c));
    return sendJson(c, await admin().listAccounts(query));
  });

  router.get('/referrals', async (c) => {
    await owner(c);
    return sendJson(c, await admin().referralTree());
  });

  router.get('/accounts/:id', async (c) => {
    await owner(c);
    const id = parseWith(accountIdParam, c.req.param('id'));
    const detail = await admin().accountDetail(id);
    if (detail === undefined) throw new UserApiError(404, 'account_not_found');
    return sendJson(c, detail);
  });

  router.put('/accounts/:id/invite-quota', async (c) => {
    const session = await owner(c);
    const target = await targetAccount(c);
    const { quota } = parseWith(inviteQuotaBody, c.get('body'));
    await audit(session, 'account.invite_quota', target.username, { accountId: target.id, from: target.inviteQuota, to: quota });
    await admin().setInviteQuota(target.id, quota);
    return sendJson(c, { id: target.id, username: target.username, quota });
  });

  router.post('/accounts/:id/suspend', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const target = await targetAccount(c);
    if (target.isOwner || target.id === session.account.id) throw new UserApiError(403, 'cannot_target_owner');
    await audit(session, 'account.suspend', target.username, { accountId: target.id });
    await admin().setSuspended(target.id, true, nowIso());
    return sendJson(c, { id: target.id, username: target.username, status: 'suspended' });
  });

  router.post('/accounts/:id/reactivate', async (c) => {
    const session = await owner(c);
    const target = await targetAccount(c);
    await audit(session, 'account.reactivate', target.username, { accountId: target.id });
    await admin().setSuspended(target.id, false, nowIso());
    return sendJson(c, { id: target.id, username: target.username, status: 'active' });
  });

  router.post('/accounts/:id/revoke-sessions', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const target = await targetAccount(c);
    await audit(session, 'account.revoke_sessions', target.username, { accountId: target.id });
    await users().deleteAllSessions(target.id);
    return sendEmpty(c, 204);
  });

  /** Révoque une session du compte (identifiant `sessions[].id` du détail). 404 si elle n'appartient pas à ce compte. */
  router.delete('/accounts/:id/sessions/:sid', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const target = await targetAccount(c);
    const sessionId = parseWith(sessionIdParam, c.req.param('sid'));
    if (!(await admin().hasSession(target.id, sessionId))) throw new UserApiError(404, 'session_not_found');
    await audit(session, 'account.session.revoke', target.username, { accountId: target.id, sessionId });
    await admin().revokeSession(target.id, sessionId);
    return sendEmpty(c, 204);
  });

  /** Supprime le compte et ses données ; les salons qu'il héberge sont d'abord fermés. */
  router.delete('/accounts/:id', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const target = await targetAccount(c);
    if (target.isOwner || target.id === session.account.id) throw new UserApiError(403, 'cannot_target_owner');
    await audit(session, 'account.delete', target.username, { accountId: target.id });
    if (party !== undefined) {
      for (const roomId of await admin().roomIdsOfHost(target.id)) {
        try {
          await party.room(roomId).close(null);
        } catch {
          // Salon déjà terminé : l'annuaire part avec le compte.
        }
      }
    }
    await users().deleteAccount(target.id);
    return sendEmpty(c, 204);
  });

  /** Lien de réinitialisation à usage unique (24 h). Le jeton n'est montré qu'ici : seule son empreinte est stockée. */
  router.post('/accounts/:id/reset-link', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const target = await targetAccount(c);
    const token = generateSessionToken();
    const now = Date.now();
    const expiresAt = new Date(now + RESET_TTL_MS).toISOString();
    await audit(session, 'account.reset_link', target.username, { accountId: target.id });
    await admin().createPasswordReset(target.id, hashSessionToken(token), new Date(now).toISOString(), expiresAt);
    const base = (runtimeEnv().get('LASTADDON_PUBLIC_URL') ?? new URL(c.req.url).origin).replace(/\/+$/, '');
    return sendJson(c, { token, expiresAt, url: `${base}/reset-password?token=${token}` }, 201);
  });

  // Réglages globaux

  router.get('/settings', async (c) => {
    await owner(c);
    return sendJson(c, await admin().getSettings());
  });

  router.put('/settings', async (c) => {
    const session = await owner(c);
    const patch = parseWith(settingsPatch, c.get('body'));
    const before = await admin().getSettings();
    // Fermer le service à tous est une action lourde : ré-authentification exigée pour l'activer.
    if (patch.maintenance?.enabled === true && !before.maintenance.enabled) elevated(c, session);
    await audit(session, 'settings.update', null, {
      ...(patch.inviteDefaultQuota === undefined ? {} : { inviteDefaultQuota: patch.inviteDefaultQuota }),
      ...(patch.invitesOpen === undefined ? {} : { invitesOpen: patch.invitesOpen }),
      ...(patch.maintenance === undefined ? {} : { maintenance: patch.maintenance.enabled }),
    });
    const next = await admin().updateSettings(patch);
    maintenance.set(next.maintenance);
    return sendJson(c, next);
  });

  // Métriques

  router.get('/metrics', async (c) => {
    await owner(c);
    const service = metricsOf();
    if (service === undefined) throw new UserApiError(501, 'metrics_unavailable');
    const { range } = parseWith(metricsQuery, queryParams(c));
    return sendJson(c, await service.report(range));
  });

  // Caches

  router.get('/caches', async (c) => {
    await owner(c);
    const caches = cachesOf();
    if (caches === undefined) throw new UserApiError(501, 'cache_admin_unavailable');
    const { range } = parseWith(cacheQuery, queryParams(c));
    const [stats, report] = await Promise.all([caches.stats(), metricsOf()?.report(range)]);
    const rates = new Map((report?.caches ?? []).map((entry) => [entry.prefix, entry]));
    return sendJson(c, {
      range,
      caches: stats.map((stat) => {
        const rate = rates.get(stat.prefix);
        return { ...stat, hits: rate?.hits ?? 0, misses: rate?.misses ?? 0, hitRate: rate?.hitRate ?? null };
      }),
    });
  });

  router.get('/caches/purges', async (c) => {
    await owner(c);
    const caches = cachesOf();
    if (caches === undefined) throw new UserApiError(501, 'cache_admin_unavailable');
    return sendJson(c, { jobs: await caches.purgeJobs() });
  });

  router.get('/caches/purges/:id', async (c) => {
    await owner(c);
    const caches = cachesOf();
    if (caches === undefined) throw new UserApiError(501, 'cache_admin_unavailable');
    const job = await caches.purgeJob(parseWith(purgeIdParam, c.req.param('id')));
    if (job === undefined) throw new UserApiError(404, 'purge_not_found');
    return sendJson(c, job);
  });

  /** Purge d'un préfixe, par lots, en arrière-plan : la réponse (202) donne l'identifiant à interroger. */
  router.post('/caches/:prefix/purge', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const caches = cachesOf();
    if (caches === undefined) throw new UserApiError(501, 'cache_admin_unavailable');
    const prefix = c.req.param('prefix');
    if (!isCachePrefix(prefix)) throw new UserApiError(404, 'unknown_cache');
    await audit(session, 'cache.purge', prefix);
    return sendJson(c, await caches.startPurge(prefix), 202);
  });

  // TV (API de l'autre chantier : 501 tant qu'elle n'est pas branchée)

  router.get('/tv', async (c) => {
    await owner(c);
    if (deps.tvAdmin === undefined) throw new UserApiError(501, 'tv_admin_unavailable');
    return sendJson(c, { lastCron: await deps.tvAdmin.lastCron() });
  });

  router.post('/tv/rerun', async (c) => {
    const session = await owner(c);
    if (deps.tvAdmin === undefined) throw new UserApiError(501, 'tv_admin_unavailable');
    await audit(session, 'tv.rerun', null);
    await deps.tvAdmin.rerun();
    return sendJson(c, { ok: true }, 202);
  });

  // Salons de visionnage

  /** Salons actifs (tous, privés compris) : l'annuaire est recoupé avec les salons réellement vivants, les terminés en sont retirés. */
  router.get('/party/rooms', async (c) => {
    await owner(c);
    if (party === undefined) throw new UserApiError(501, 'party_unavailable');
    const registered = await admin().listRegisteredRooms(ROOMS_LISTED);
    const rooms: unknown[] = [];
    for (let start = 0; start < registered.length; start += ROOM_PARALLEL) {
      const slice = registered.slice(start, start + ROOM_PARALLEL);
      const infos = await Promise.all(slice.map((room) => party.room(room.id).info().catch(() => null)));
      for (const [index, room] of slice.entries()) {
        const info = infos[index];
        if (info === null || info === undefined) {
          await admin().deleteRegisteredRoom(room.id);
          continue;
        }
        rooms.push({
          id: room.id,
          host: room.host,
          visibility: room.visibility,
          title: room.title,
          mediaType: room.mediaType,
          createdAt: room.createdAt,
          participants: info.participants,
          maxParticipants: info.maxParticipants,
        });
      }
    }
    return sendJson(c, { rooms });
  });

  router.delete('/party/rooms/:id', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    if (party === undefined) throw new UserApiError(501, 'party_unavailable');
    const id = parseWith(roomIdParam, c.req.param('id'));
    await audit(session, 'party.close_room', id);
    const result = await party.room(id).close(null);
    await admin().deleteRegisteredRoom(id);
    if (result === 'not_found') throw new UserApiError(404, 'room_not_found');
    return sendEmpty(c, 204);
  });

  router.get('/party/reports', async (c) => {
    await owner(c);
    const { status, limit } = parseWith(reportListQuery, queryParams(c));
    return sendJson(c, { reports: await admin().listReports(status, limit) });
  });

  /** Traite un signalement : supprimer le message, suspendre son auteur, ou ignorer. */
  router.post('/party/reports/:id/action', async (c) => {
    const session = await owner(c);
    const id = parseWith(reportIdParam, c.req.param('id'));
    const { action } = parseWith(reportActionBody, c.get('body'));
    if (action === 'suspend') elevated(c, session);
    const report = await admin().reportById(id);
    if (report === undefined) throw new UserApiError(404, 'report_not_found');
    if (report.status !== 'open') throw new UserApiError(409, 'report_closed');
    if (action === 'ignore') {
      await audit(session, 'report.ignore', report.against, { reportId: id });
      await admin().resolveReport(id, 'ignored', nowIso());
    } else if (action === 'delete') {
      await audit(session, 'report.delete_message', report.against, { reportId: id, roomId: report.roomId });
      // Le salon a pu se terminer entre-temps : le signalement est clos dans tous les cas.
      if (party !== undefined) await party.room(report.roomId).deleteMessage(report.messageId).catch(() => 'not_found' as const);
      await admin().resolveReport(id, 'deleted', nowIso());
    } else {
      if (report.againstId === null) throw new UserApiError(409, 'author_unknown');
      const author = await admin().accountById(report.againstId);
      if (author === undefined) throw new UserApiError(404, 'account_not_found');
      if (author.isOwner) throw new UserApiError(403, 'cannot_target_owner');
      await audit(session, 'report.suspend_author', author.username, { reportId: id, accountId: author.id });
      await admin().setSuspended(author.id, true, nowIso());
      await admin().resolveReport(id, 'suspended', nowIso());
    }
    return sendJson(c, { id, status: action === 'ignore' ? 'ignored' : action === 'delete' ? 'deleted' : 'suspended' });
  });

  // Journal d'audit

  router.get('/audit', async (c) => {
    await owner(c);
    const query = parseWith(auditQuery, queryParams(c));
    return sendJson(c, await admin().listAudit(query));
  });

  registerAnnouncementAdminRoutes(router, { owner, audit, admin });

  router.all('*', () => {
    throw new UserApiError(404, 'not_found');
  });
  router.onError(userErrorHandler);
  app.route(ADMIN_MOUNT, router);
}
