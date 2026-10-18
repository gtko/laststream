import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type { SkipRepo, UserBackend, UserRepo } from '../../user/repo.js';
import type { UserStoreDO } from './user-store-do.js';

/** Nom du Durable Object global des données utilisateur. */
export const USER_STORE_NAME = 'users';

/** Dépôt dont chaque méthode est un appel RPC vers le Durable Object (`kind` : store visé). */
function remoteRepo<R>(stub: () => DurableObjectStub<UserStoreDO>, kind: 'user' | 'skip'): R {
  const cache = new Map<string, unknown>();
  return new Proxy({} as R & object, {
    get(_target, name) {
      // Un dépôt n'est jamais « thenable ».
      if (typeof name !== 'string' || name === 'then') return undefined;
      let call = cache.get(name);
      if (call === undefined) {
        // async/await : l'erreur du DO est portée par cette Promise (une RpcPromise rejetée non attendue serait « non gérée »).
        call = async (...args: unknown[]): Promise<unknown> => await (kind === 'user' ? stub().user(name, args) : stub().skip(name, args));
        cache.set(name, call);
      }
      return call;
    },
  }) as R;
}

/** Données utilisateur d'un Worker : un Durable Object SQLite global, appelé en RPC. */
export function createDurableObjectUserBackend(
  namespace: DurableObjectNamespace<UserStoreDO>,
  name: string = USER_STORE_NAME,
): UserBackend {
  const stub = (): DurableObjectStub<UserStoreDO> => namespace.getByName(name);
  const users = remoteRepo<UserRepo>(stub, 'user');
  const skips = remoteRepo<SkipRepo>(stub, 'skip');
  return { users: () => users, skips: () => skips, close: () => undefined };
}
