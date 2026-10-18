import type { DurableObjectState } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { type AdminOperation, runAdminOperation } from '../../admin/routes.js';
import { migrate } from '../../user/migrations.js';
import { SkipSegmentStore } from '../../user/skip-segments.js';
import type { SqlDb } from '../../user/sql.js';
import { UserStore } from '../../user/store.js';
import { durableObjectSql } from './sql.js';

/** Méthodes des stores jamais exposées en RPC (internes ou propres à l'hôte). */
const HIDDEN = new Set(['constructor', 'transaction', 'close', 'updateProfileFields', 'createSession']);

function callableNames(prototype: object): Set<string> {
  return new Set(Object.getOwnPropertyNames(prototype).filter((name) => !HIDDEN.has(name)));
}

const USER_METHODS = callableNames(UserStore.prototype);
const SKIP_METHODS = callableNames(SkipSegmentStore.prototype);

function dispatch(target: object, allowed: ReadonlySet<string>, method: string, args: unknown[]): unknown {
  if (!allowed.has(method)) throw new Error(`méthode inconnue : ${method}`);
  return (target as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args);
}

/**
 * Durable Object des données utilisateur : base SQLite du DO (comptes, sessions, profils, bibliothèque, progression,
 * suivis, notes, réglages, segments de saut). Mêmes stores et mêmes migrations que le serveur Node, appelés en RPC par
 * le Worker (voir user-backend.ts). Un seul objet global nommé « users » : toutes les requêtes passent par lui, une à
 * la fois (limite : quelques centaines de requêtes par seconde, 10 Go de données). Au-delà, partitionner par compte.
 */
export class UserStoreDO extends DurableObject {
  private readonly users: UserStore;
  private readonly skips: SkipSegmentStore;
  private readonly db: SqlDb;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const db = durableObjectSql(ctx.storage);
    this.db = db;
    // Migrations avant toute requête.
    void ctx.blockConcurrencyWhile(() => {
      migrate(db);
      return Promise.resolve();
    });
    this.users = new UserStore(db);
    this.skips = new SkipSegmentStore(db);
  }

  /** Appelle une méthode de UserStore. */
  user(method: string, args: unknown[]): unknown {
    return dispatch(this.users, USER_METHODS, method, args);
  }

  /** Appelle une méthode de SkipSegmentStore. */
  skip(method: string, args: unknown[]): unknown {
    return dispatch(this.skips, SKIP_METHODS, method, args);
  }

  /** Migration des données (route /__admin/, protégée par ADMIN_SECRET côté Worker) : voir admin/routes.ts. */
  admin(operation: AdminOperation): Promise<unknown> {
    return runAdminOperation(this.db, operation);
  }
}
