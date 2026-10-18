import { safeEqual } from '../user/crypto.js';
import type { SocialStore } from '../user/social-store.js';
import type { SqlDb } from '../user/sql.js';
import {
  type MigratedTable,
  type WireValue,
  digestAll,
  insertBatch,
  isEmpty,
  isMigratedTable,
  wipeAll,
} from './data-migration.js';

/** Préfixe de la route d'administration (migration des données). Absente tant que le secret ADMIN_SECRET n'est pas posé. */
export const ADMIN_PREFIX = '/__admin/';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Opérations exécutées dans le Durable Object (voir UserStoreDO.admin). */
export type AdminOperation =
  | { action: 'counts' }
  | { action: 'begin'; force: boolean }
  | { action: 'insert'; table: MigratedTable; columns: string[]; rows: WireValue[][] }
  | { action: 'createInvite' }
  | { action: 'deleteInvite'; code: string };

export async function runAdminOperation(db: SqlDb, operation: AdminOperation, social: SocialStore): Promise<unknown> {
  switch (operation.action) {
    case 'counts':
      return { tables: await digestAll(db) };
    case 'begin':
      if (!isEmpty(db)) {
        if (!operation.force) return { error: 'not_empty' };
        wipeAll(db);
      }
      return { ok: true };
    case 'insert':
      return { inserted: insertBatch(db, operation.table, operation.columns, operation.rows) };
    case 'createInvite':
      return { code: social.createSystemInvite(new Date().toISOString()).code };
    case 'deleteInvite':
      return { deleted: social.deleteSystemInvite(operation.code) };
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function parseOperation(method: string, path: string, body: unknown): AdminOperation | undefined {
  if (method === 'GET' && path === 'counts') return { action: 'counts' };
  if (method === 'POST' && path === 'invite') return { action: 'createInvite' };
  if (method === 'DELETE' && path.startsWith('invite/') && path.length > 'invite/'.length) return { action: 'deleteInvite', code: decodeURIComponent(path.slice('invite/'.length)) };
  if (method !== 'POST' || path !== 'import' || typeof body !== 'object' || body === null) return undefined;
  const input = body as Record<string, unknown>;
  if (input.action === 'begin') return { action: 'begin', force: input.force === true };
  if (
    input.action === 'insert' &&
    isMigratedTable(input.table) &&
    Array.isArray(input.columns) &&
    input.columns.every((c) => typeof c === 'string') &&
    Array.isArray(input.rows) &&
    input.rows.every(Array.isArray)
  ) {
    return { action: 'insert', table: input.table, columns: input.columns as string[], rows: input.rows as WireValue[][] };
  }
  return undefined;
}

/**
 * Route d'administration : POST /__admin/invite (invitation « système » sans parrain, pour un compte de test) et
 * DELETE /__admin/invite/<code> (nettoyage) ; GET /__admin/counts (nombre de lignes et SHA-256 par table) et POST /__admin/import
 * ({action:'begin', force?} puis {action:'insert', table, columns, rows}). Authentifiée par l'en-tête `x-admin-secret`
 * (secret ADMIN_SECRET) ; 404 si le secret n'est pas posé. Pour la fermer après usage : `wrangler secret delete ADMIN_SECRET`.
 */
export async function handleAdmin(
  request: Request,
  secret: string | undefined,
  run: (operation: AdminOperation) => Promise<unknown>,
): Promise<Response> {
  if (secret === undefined || secret.length < 32) return json(404, { error: 'not_found' });
  if (!safeEqual(request.headers.get('x-admin-secret') ?? '', secret)) return json(401, { error: 'unauthorized' });
  const path = new URL(request.url).pathname.slice(ADMIN_PREFIX.length);
  let body: unknown;
  if (request.method === 'POST' && path !== 'invite') {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
  }
  const operation = parseOperation(request.method, path, body);
  if (operation === undefined) return json(404, { error: 'not_found' });
  try {
    const result = (await run(operation)) as { error?: string };
    return json(result.error === 'not_empty' ? 409 : 200, result);
  } catch (err) {
    return json(500, { error: 'admin_failed', message: err instanceof Error ? err.message.slice(0, 200) : 'inconnue' });
  }
}
