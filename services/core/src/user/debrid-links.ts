import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { decryptJson, encryptJson } from '../config/codec.js';
import { platform } from '../platform/index.js';
import type { KvCache } from '../platform/types.js';
import { safeEqual } from './crypto.js';
import type { UserBackend, UserRepo } from './repo.js';
import { sessionOf } from './session.js';
import { parseWith, UserApiError } from './validation.js';
import type { Account } from './store.js';

/**
 * Liens débridés partagés entre les profils d'un compte (GET/PUT /user/debrid-links).
 *
 * L'APPAREIL débloque le lien (AllDebrid, depuis son IP) puis le dépose ici. Le serveur ne débloque jamais rien : il
 * ne fait que stocker, chiffré, et rendre le lien au même compte depuis la même IP publique. Le lien n'est jamais
 * journalisé ; l'IP n'est stockée que hachée (HMAC avec le secret serveur).
 */

/** Espace de noms du cache KV partagé : clés `dl:<compte>:<hash de la clé de source>`. */
export const DEBRID_LINK_NAMESPACE = 'dl';
/** Validité par défaut d'un lien débridé, et plafond : un `expiresAt` plus lointain est ramené à ce plafond. */
export const DEBRID_LINK_DEFAULT_TTL_MS = 3 * 3600_000;
export const DEBRID_LINK_MAX_TTL_MS = 24 * 3600_000;
/** Usage de chiffrement (séparé des configurations) ; lié au compte pour qu'une valeur ne se rejoue pas ailleurs. */
const LINK_PURPOSE = 'debrid-link';
const IP_HMAC_PURPOSE = 'debrid-link-ip';
const URL_MAX_LENGTH = 4096;
const IP_PATTERN = /^[0-9A-Fa-f:.]{2,64}$/;

const sourceKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9:._-]+$/);

/** URL http(s) absolue. Les issues ne recopient jamais la valeur (l'URL peut porter un jeton). */
const linkUrlSchema = z
  .string()
  .min(1)
  .max(URL_MAX_LENGTH)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  });

const putSchema = z.object({
  sourceKey: sourceKeySchema,
  url: linkUrlSchema,
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

const getQuerySchema = z.object({ sourceKey: sourceKeySchema });

/** Contenu chiffré d'une entrée : le lien, son échéance, et l'empreinte keyée de l'IP de l'appareil. */
const storedSchema = z.object({ url: z.string(), expiresAt: z.string(), ipHash: z.string() });
type StoredLink = z.infer<typeof storedSchema>;

/** IP publique de l'appareil : CF-Connecting-IP (posé par Cloudflare), sinon l'adresse retenue par l'application. */
function clientIpOf(c: Ctx): string | undefined {
  const fromEdge = c.req.header('cf-connecting-ip')?.trim();
  const ip = fromEdge !== undefined && fromEdge !== '' ? fromEdge : c.get('ip');
  return ip !== undefined && IP_PATTERN.test(ip) ? ip : undefined;
}

/** Empreinte keyée (HMAC-SHA256 avec le secret serveur) : l'IP n'est jamais stockée en clair. */
function ipDigest(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(`${IP_HMAC_PURPOSE}\0${ip}`, 'utf8').digest('base64url');
}

/** Partie de la clé KV propre au compte et à la source : le compte et un hash de la clé de source (jamais la clé brute). */
function storageKey(accountId: string, sourceKey: string): string {
  return `${accountId}:${createHash('sha256').update(sourceKey, 'utf8').digest('hex')}`;
}

/** Déchiffre une entrée ; undefined si illisible, mal formée, ou chiffrée pour un autre compte (message générique). */
function openLink(raw: string, secret: string, accountId: string): StoredLink | undefined {
  try {
    const parsed = storedSchema.safeParse(decryptJson(raw, secret, `${LINK_PURPOSE}:${accountId}`));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Un identifiant de profil fourni doit appartenir au compte (même règle que les sources TV). */
async function assertActorOf(users: UserRepo, account: Account, c: Ctx): Promise<void> {
  const actor = c.req.header('x-profile-id');
  if (actor !== undefined && (await users.findProfile(account.id, actor)) === undefined) throw new UserApiError(404, 'profile_not_found');
}

/**
 * Routes des liens débridés : session obligatoire (401 sans session valide, donc jamais pour un invité ou un jeton
 * étranger). Le lien n'est rendu que pour le même compte, depuis la même IP, avant son échéance ; sinon 404.
 */
export function registerDebridLinkRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  let store: KvCache | undefined;
  // Un seul cache par application : la plateforme peut en créer un nouveau à chaque appel.
  const links = (): KvCache => {
    store ??= platform().createKvCache(DEBRID_LINK_NAMESPACE);
    return store;
  };

  /** GET /user/debrid-links?sourceKey= → 200 `{ url, expiresAt }`, ou 404 `debrid_link_not_found`. */
  router.get('/debrid-links', async (c) => {
    const users = backend.users();
    const { account } = await sessionOf(users, c);
    await assertActorOf(users, account, c);
    const { sourceKey } = parseWith(getQuerySchema, queryParams(c));
    const notFound = (): UserApiError => new UserApiError(404, 'debrid_link_not_found');

    const ip = clientIpOf(c);
    if (ip === undefined) throw notFound();
    const raw = await links().get(storageKey(account.id, sourceKey));
    if (raw === undefined) throw notFound();
    const stored = openLink(raw, deps.secret, account.id);
    if (stored === undefined) throw notFound();
    if (Date.parse(stored.expiresAt) <= Date.now()) throw notFound();
    if (!safeEqual(stored.ipHash, ipDigest(deps.secret, ip))) throw notFound();
    return sendJson(c, { url: stored.url, expiresAt: stored.expiresAt });
  });

  /**
   * PUT /user/debrid-links `{ sourceKey, url, expiresAt? }` → 200 `{ expiresAt }` (échéance effective, bornée). Remplace
   * l'entrée existante de la même source. 400 `invalid_body` (issues sans valeurs), 400 `ip_unknown` sans IP.
   */
  router.put('/debrid-links', async (c) => {
    const users = backend.users();
    const { account } = await sessionOf(users, c);
    await assertActorOf(users, account, c);
    const body = parseWith(putSchema, c.get('body'));
    const now = Date.now();
    if (body.expiresAt !== undefined && Date.parse(body.expiresAt) <= now) {
      throw new UserApiError(400, 'invalid_body', ['expiresAt:passe']);
    }
    const ip = clientIpOf(c);
    if (ip === undefined) throw new UserApiError(400, 'ip_unknown');

    const requested = body.expiresAt === undefined ? now + DEBRID_LINK_DEFAULT_TTL_MS : Date.parse(body.expiresAt);
    const expiresMs = Math.min(requested, now + DEBRID_LINK_MAX_TTL_MS);
    const record: StoredLink = { url: body.url, expiresAt: new Date(expiresMs).toISOString(), ipHash: ipDigest(deps.secret, ip) };
    const value = encryptJson(record, deps.secret, `${LINK_PURPOSE}:${account.id}`);
    await links().set(storageKey(account.id, body.sourceKey), value, Math.ceil((expiresMs - now) / 1000));
    return sendJson(c, { expiresAt: record.expiresAt });
  });
}
