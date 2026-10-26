import { AsyncLocalStorage } from 'node:async_hooks';
import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import type { WorkerEnv } from './env.js';

/**
 * Coût de stockage par requête (LAST-138) : compte les opérations KV et R2 faites pendant une requête et les écrit en
 * fin de requête dans une ligne JSON (`msg: "storage_ops"`), lisible dans les journaux Workers / `wrangler tail`.
 *
 * Aucun état partagé entre requêtes : les liaisons enveloppées sont sans état et trouvent le compteur de la requête
 * courante par AsyncLocalStorage. Hors requête (Cron, Durable Object), rien n'est compté. La ligne ne porte que la
 * route épurée (segments variables remplacés, voir `routeLabel`) et des nombres : ni clé, ni préfixe, ni identité.
 */

export type KvOperation = 'get' | 'put' | 'delete' | 'list';
export type R2Operation = 'get' | 'put' | 'head' | 'delete' | 'list';

export interface StorageOps {
  kv: Partial<Record<KvOperation, number>>;
  r2: Partial<Record<R2Operation, number>>;
}

const current = new AsyncLocalStorage<StorageOps>();

/** Méthode de la liaison → opération comptée. `getWithMetadata` est une lecture ; les envois multipart sont des écritures. */
const KV_METHODS: Readonly<Record<string, KvOperation>> = { get: 'get', getWithMetadata: 'get', put: 'put', delete: 'delete', list: 'list' };
const R2_METHODS: Readonly<Record<string, R2Operation>> = {
  get: 'get',
  head: 'head',
  put: 'put',
  createMultipartUpload: 'put',
  delete: 'delete',
  list: 'list',
};

function bump(family: 'kv' | 'r2', operation: string): void {
  const ops = current.getStore();
  if (ops === undefined) return;
  const counts: Record<string, number | undefined> = ops[family];
  counts[operation] = (counts[operation] ?? 0) + 1;
}

/** Liaison dont les méthodes listées sont comptées dans la requête courante (les autres membres passent tels quels). */
function counted<T extends object>(binding: T, family: 'kv' | 'r2', methods: Readonly<Record<string, string>>): T {
  return new Proxy(binding, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      const operation = typeof prop === 'string' ? methods[prop] : undefined;
      return (...args: unknown[]): unknown => {
        if (operation !== undefined) bump(family, operation);
        return (member as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export function countedKv(kv: KVNamespace): KVNamespace {
  return counted(kv, 'kv', KV_METHODS);
}

export function countedR2(bucket: R2Bucket): R2Bucket {
  return counted(bucket, 'r2', R2_METHODS);
}

/** Liaisons KV et R2 d'un `env` du Worker (hors Durable Objects), enveloppées ; le reste est repris tel quel. */
const wrapped = new WeakMap<WorkerEnv, WorkerEnv>();

export function countedEnv(env: WorkerEnv): WorkerEnv {
  const known = wrapped.get(env);
  if (known !== undefined) return known;
  const copy: WorkerEnv = { ...env };
  // Liaisons absentes (tests, environnement partiel) : laissées telles quelles.
  const present = (binding: unknown): boolean => typeof binding === 'object' && binding !== null;
  if (present(env.CACHE)) copy.CACHE = countedKv(env.CACHE);
  if (present(env.TV)) copy.TV = countedR2(env.TV as R2Bucket);
  if (present(env.META)) copy.META = countedR2(env.META as R2Bucket);
  if (present(env.AVATARS)) copy.AVATARS = countedR2(env.AVATARS as R2Bucket);
  wrapped.set(env, copy);
  return copy;
}

function nonEmpty(counts: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(counts)) if (value !== undefined && value > 0) out[name] = value;
  return out;
}

/** Ligne de journal d'une requête, ou undefined si elle n'a touché ni KV ni R2 (pas de bruit). */
export function storageOpsLine(route: string, ops: StorageOps): string | undefined {
  const kv = nonEmpty(ops.kv);
  const r2 = nonEmpty(ops.r2);
  if (Object.keys(kv).length === 0 && Object.keys(r2).length === 0) return undefined;
  return JSON.stringify({ msg: 'storage_ops', route, kv, r2 });
}

/**
 * Exécute `work` en comptant ses opérations KV / R2, puis écrit la ligne `storage_ops` (même si `work` échoue). Le travail
 * d'arrière-plan qui se termine après la réponse n'est pas compté dans la ligne. `emit` : défaut `console.log`.
 */
export async function withStorageOps<T>(route: string, work: () => Promise<T>, emit: (line: string) => void = console.log): Promise<T> {
  const ops: StorageOps = { kv: {}, r2: {} };
  try {
    return await current.run(ops, work);
  } finally {
    try {
      const line = storageOpsLine(route, ops);
      if (line !== undefined) emit(line);
    } catch {
      /* la mesure ne doit jamais changer l'issue de la requête */
    }
  }
}
