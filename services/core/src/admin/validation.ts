import { z } from 'zod';
import { MAX_INVITE_QUOTA } from '../user/social-store.js';
import { MAX_MAINTENANCE_MESSAGE } from '../user/app-settings.js';

/** Schémas de l'API d'administration. */

const intParam = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);

const USERNAME = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/);
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?$/);

export const accountIdParam = z.string().uuid();

/** Identifiant public d'une session (24 caractères hexadécimaux, voir `sessionRef`). */
export const sessionIdParam = z.string().regex(/^[0-9a-f]{24}$/);

export const accountListQuery = z.object({
  q: z.string().trim().max(32).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  referrer: USERNAME.optional(),
  createdFrom: ISO_DATE.optional(),
  createdTo: ISO_DATE.optional(),
  order: z.enum(['newest', 'oldest']).default('newest'),
  limit: intParam(1, 100, 25),
  cursor: z.string().max(120).optional(),
});

export const inviteQuotaBody = z.object({ quota: z.number().int().min(0).max(MAX_INVITE_QUOTA) });

export const elevateBody = z.object({ password: z.string().min(1).max(256) });

export const settingsPatch = z
  .object({
    inviteDefaultQuota: z.number().int().min(0).max(MAX_INVITE_QUOTA).optional(),
    invitesOpen: z.boolean().optional(),
    maintenance: z.object({ enabled: z.boolean(), message: z.string().trim().max(MAX_MAINTENANCE_MESSAGE).default('') }).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'au_moins_un_reglage');

export const metricsQuery = z.object({ range: z.enum(['1h', '24h', '7d']).default('1h') });

export const cacheQuery = z.object({ range: z.enum(['1h', '24h', '7d']).default('24h') });

export const auditQuery = z.object({
  limit: intParam(1, 200, 50),
  before: z.string().regex(/^\d{1,12}$/).transform(Number).optional(),
  action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
});

export const roomIdParam = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const reportIdParam = z.string().regex(/^\d{1,12}$/).transform(Number);

export const reportListQuery = z.object({ status: z.enum(['open', 'deleted', 'suspended', 'ignored']).default('open'), limit: intParam(1, 200, 100) });

export const reportActionBody = z.object({ action: z.enum(['delete', 'suspend', 'ignore']) });

export const purgeIdParam = z.string().uuid();
