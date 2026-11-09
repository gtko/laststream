import { z } from 'zod';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { ConfigValidationError } from '../config/schema.js';
import {
  SERVER_SERVICE_FIELDS,
  type ServerServiceField,
  type ServerServicesEnv,
  type ServerServicesPatch,
  serverServicesState,
  setServerServices,
} from '../config/server-services.js';
import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { sendJson } from '../http/respond.js';
import type { AdminRepo, UserRepo } from '../user/repo.js';
import type { Session } from '../user/session.js';
import { parseWith, UserApiError } from '../user/validation.js';

/**
 * Clés des services gérées dans l'administration (GET, PUT /admin/services, POST /admin/services/import). Les clés sont
 * chiffrées en base (config/server-services.ts) et servent à tous les comptes. Aucune réponse ne contient une clé : seul
 * l'état masqué sort (présence, origine, quatre derniers caractères ; le modèle OpenRouter, non secret, en clair). Les
 * écritures exigent l'élévation et sont inscrites au journal d'audit avec les seuls noms des champs.
 */

/** Réglage de profil de l'ancienne configuration (compatibilité, une version), comme GET /account/config. */
const LEGACY_CONFIG_KEY = 'lastaddonConfig';

/** Modification : valeur (enregistrée), null (effacée de la base), champ absent (gardé). */
const servicesPatchBody = z
  .object(Object.fromEntries(SERVER_SERVICE_FIELDS.map((f) => [f, z.string().max(500).nullable().optional()])) as Record<ServerServiceField, z.ZodOptional<z.ZodNullable<z.ZodString>>>)
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'au_moins_une_cle');

/** Dépendances fournies par api.ts : gardes d'accès, journal d'audit, dépôts et environnement des clés serveur. */
export interface ServicesRouteContext {
  deps: AppDeps;
  owner(c: Ctx): Promise<Session>;
  elevated(c: Ctx, session: Session): void;
  audit(session: Session, action: string, target: string | null, detail?: Record<string, unknown> | null): Promise<void>;
  users(): UserRepo;
  admin(): AdminRepo;
  servicesEnv(): ServerServicesEnv;
}

/** Champs réellement modifiés (valeur non vide ou effacement), pour le journal d'audit : jamais les valeurs. */
function touched(patch: ServerServicesPatch): { set: ServerServiceField[]; cleared: ServerServiceField[] } {
  const set: ServerServiceField[] = [];
  const cleared: ServerServiceField[] = [];
  for (const field of SERVER_SERVICE_FIELDS) {
    const value = patch[field];
    if (value === null) cleared.push(field);
    else if (typeof value === 'string' && value.trim() !== '') set.push(field);
  }
  return { set, cleared };
}

/**
 * Clés à reprendre d'une configuration de compte : champs serveur non vides. Le modèle OpenRouter n'est repris que s'il
 * accompagne une clé OpenRouter (sinon c'est la valeur par défaut du schéma, pas un choix).
 */
export function importableKeys(services: Partial<Record<string, unknown>>): ServerServicesPatch {
  const patch: ServerServicesPatch = {};
  for (const field of SERVER_SERVICE_FIELDS) {
    const value = services[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (field === 'openrouterModel' && typeof services.openrouterApiKey !== 'string') continue;
    patch[field] = value.trim();
  }
  return patch;
}

export function registerServicesRoutes(router: App, ctx: ServicesRouteContext): void {
  const { deps, owner, elevated, audit } = ctx;

  /** Configuration chiffrée du compte (ou, en compatibilité, celle du profil principal), ou null. */
  async function accountConfig(accountId: string): Promise<string | null> {
    const config = await ctx.users().getAccountConfig(accountId);
    if (config !== null) return config;
    const mainId = await ctx.admin().mainProfileId(accountId);
    const legacy = mainId === null ? undefined : (await ctx.users().listSettings(mainId))[LEGACY_CONFIG_KEY];
    return typeof legacy === 'string' ? legacy : null;
  }

  /** État masqué des clés serveur. */
  router.get('/services', async (c) => {
    await owner(c);
    return sendJson(c, { services: await serverServicesState(ctx.servicesEnv()) });
  });

  /** Enregistre ou efface des clés serveur : élévation, audit (noms des champs seulement). */
  router.put('/services', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const patch = parseWith(servicesPatchBody, c.get('body')) as ServerServicesPatch;
    await audit(session, 'services.update', null, touched(patch));
    return sendJson(c, { services: await setServerServices(ctx.servicesEnv(), patch) });
  });

  /**
   * Reprend dans les clés serveur celles de la configuration du compte propriétaire (déchiffrée ici, jamais renvoyée).
   * Seuls les champs présents dans le compte sont écrits ; les autres clés serveur restent telles quelles.
   */
  router.post('/services/import', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const encoded = await accountConfig(session.account.id);
    if (encoded === null) throw new UserApiError(404, 'account_config_missing');
    let services: Partial<Record<string, unknown>>;
    try {
      services = decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain }).services;
    } catch (err) {
      if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) throw new UserApiError(400, 'invalid_config');
      throw err;
    }
    const patch = importableKeys(services);
    const imported = Object.keys(patch) as ServerServiceField[];
    await audit(session, 'services.import', null, { imported });
    const state = imported.length > 0 ? await setServerServices(ctx.servicesEnv(), patch) : await serverServicesState(ctx.servicesEnv());
    return sendJson(c, { services: state, imported });
  });
}
