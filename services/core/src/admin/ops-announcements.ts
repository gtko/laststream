import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { App, Ctx } from '../http/app-env.js';
import { sendEmpty, sendJson } from '../http/respond.js';
import type { Announcement } from '../user/admin-store.js';
import type { AdminRepo, UserBackend } from '../user/repo.js';
import { nowIso, type Session } from '../user/session.js';
import { parseWith, UserApiError } from '../user/validation.js';

/**
 * Annonces (bandeau d'information) et boîte de contrôle : routes d'administration réservées au propriétaire. Les écritures
 * sur les annonces (POST, PUT, DELETE) exigent en plus une ré-authentification récente (élévation) et sont auditées ; la
 * boîte de contrôle n'exige que le propriétaire. Lecture publique GET /announcements : seuls les champs d'affichage des
 * annonces actives dans leur fenêtre. Montées par admin/api.ts (sous /admin) et app.ts (public).
 */

/**
 * Ce que ces routes reprennent de admin/api.ts : contrôle du propriétaire, élévation (ré-authentification récente), journal
 * d'audit, dépôt d'administration.
 */
export interface AdminOps {
  owner(c: Ctx): Promise<Session>;
  elevated(c: Ctx, session: Session): void;
  audit(session: Session, action: string, target: string | null, detail?: Record<string, unknown> | null): Promise<void>;
  admin(): AdminRepo;
}

const MAX_TITLE = 80;
const MAX_MESSAGE = 500;
const MAX_INBOX_KEY = 120;
const LEVELS = ['info', 'warning'] as const;
/** Date ISO 8601 : date seule (minuit UTC) ou date-heure avec fuseau explicite. Normalisée en UTC à l'écriture. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const isoDate = z
  .string()
  .max(40)
  .regex(ISO_DATE, 'date ISO 8601 attendue')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'date invalide')
  .transform((value) => new Date(value).toISOString());

/** Fenêtre cohérente : une fin strictement postérieure au début, quand les deux bornes sont données. */
function windowOk(startsAt: string | null | undefined, endsAt: string | null | undefined): boolean {
  if (startsAt === null || startsAt === undefined || endsAt === null || endsAt === undefined) return true;
  return Date.parse(endsAt) > Date.parse(startsAt);
}

const announcementCreateBody = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE),
    message: z.string().trim().min(1).max(MAX_MESSAGE),
    level: z.enum(LEVELS),
    startsAt: isoDate.nullable().optional(),
    endsAt: isoDate.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => windowOk(body.startsAt, body.endsAt), { message: 'fin_avant_debut', path: ['endsAt'] });

const announcementPatchBody = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE).optional(),
    message: z.string().trim().min(1).max(MAX_MESSAGE).optional(),
    level: z.enum(LEVELS).optional(),
    startsAt: isoDate.nullable().optional(),
    endsAt: isoDate.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'au_moins_un_champ');

const announcementIdParam = z.string().uuid();
/** Clé d'un élément de la boîte (« report:<id> », « quota:<accountId> »…) : 120 caractères au plus, sans contrôle. */
const inboxKeyParam = z
  .string()
  .min(1)
  .max(MAX_INBOX_KEY)
  .regex(/^\P{Cc}+$/u, 'caractere_interdit');

/** Vue publique d'une annonce : seuls les champs d'affichage (pas de dates, d'état ni d'horodatage). */
function publicView(announcement: Announcement): Pick<Announcement, 'id' | 'title' | 'message' | 'level'> {
  return { id: announcement.id, title: announcement.title, message: announcement.message, level: announcement.level };
}

/**
 * Routes d'administration des annonces (propriétaire et élévation pour les écritures) et de la boîte de contrôle (propriétaire).
 * Chaque écriture est auditée.
 */
export function registerAnnouncementAdminRoutes(router: App, ops: AdminOps): void {
  const store = (): AdminRepo => ops.admin();

  router.get('/announcements', async (c) => {
    await ops.owner(c);
    return sendJson(c, { announcements: await store().listAnnouncements() });
  });

  router.post('/announcements', async (c) => {
    const session = await ops.owner(c);
    ops.elevated(c, session);
    const body = parseWith(announcementCreateBody, c.get('body'));
    const now = nowIso();
    const record: Announcement = {
      id: randomUUID(),
      title: body.title,
      message: body.message,
      level: body.level,
      startsAt: body.startsAt ?? null,
      endsAt: body.endsAt ?? null,
      active: body.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    await ops.audit(session, 'announcement.create', record.title, { id: record.id, level: record.level });
    await store().createAnnouncement(record);
    return sendJson(c, record, 201);
  });

  /** Patch partiel : un champ absent garde sa valeur ; `startsAt` ou `endsAt` à null efface la borne. */
  router.put('/announcements/:id', async (c) => {
    const session = await ops.owner(c);
    ops.elevated(c, session);
    const id = parseWith(announcementIdParam, c.req.param('id'));
    const patch = parseWith(announcementPatchBody, c.get('body'));
    const current = await store().announcementById(id);
    if (current === undefined) throw new UserApiError(404, 'announcement_not_found');
    const next: Announcement = {
      ...current,
      title: patch.title ?? current.title,
      message: patch.message ?? current.message,
      level: patch.level ?? current.level,
      startsAt: patch.startsAt === undefined ? current.startsAt : patch.startsAt,
      endsAt: patch.endsAt === undefined ? current.endsAt : patch.endsAt,
      active: patch.active ?? current.active,
      updatedAt: nowIso(),
    };
    if (!windowOk(next.startsAt, next.endsAt)) throw new UserApiError(400, 'invalid_body', ['endsAt:custom']);
    await ops.audit(session, 'announcement.update', next.title, { id, fields: Object.keys(patch) });
    if (!(await store().updateAnnouncement(next))) throw new UserApiError(404, 'announcement_not_found');
    return sendJson(c, next);
  });

  router.delete('/announcements/:id', async (c) => {
    const session = await ops.owner(c);
    ops.elevated(c, session);
    const id = parseWith(announcementIdParam, c.req.param('id'));
    const current = await store().announcementById(id);
    if (current === undefined) throw new UserApiError(404, 'announcement_not_found');
    await ops.audit(session, 'announcement.delete', current.title, { id });
    await store().deleteAnnouncement(id);
    return sendEmpty(c, 204);
  });

  /** Écarte un élément de la boîte de contrôle : il n'y revient que si sa clé change. */
  router.post('/inbox/:key/dismiss', async (c) => {
    const session = await ops.owner(c);
    const key = parseWith(inboxKeyParam, c.req.param('key'));
    await ops.audit(session, 'inbox.dismiss', key);
    await store().dismissInbox(key, nowIso());
    return sendJson(c, { ok: true });
  });
}

/**
 * GET /announcements : route publique (sans authentification, hors /admin). Renvoie uniquement les annonces actives dont
 * la fenêtre contient l'instant présent, réduites à id, titre, message et niveau. Cache navigateur de 60 secondes.
 */
export function registerPublicAnnouncementRoute(app: App, backend: UserBackend): void {
  app.get('/announcements', async (c) => {
    c.header('Cache-Control', 'public, max-age=60');
    // Aucune base créée : une consultation publique ne doit pas ouvrir (ni créer) le fichier de données.
    if (backend.hasData?.() === false) return sendJson(c, { announcements: [] });
    const active = await backend.admin().listActiveAnnouncements(nowIso());
    return sendJson(c, { announcements: active.map(publicView) });
  });
}
