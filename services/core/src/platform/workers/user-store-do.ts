import type { DurableObjectState } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { type AdminOperation, runAdminOperation } from '../../admin/routes.js';
import { AdminStore } from '../../user/admin-store.js';
import { migrate } from '../../user/migrations.js';
import { MetaStore } from '../../user/meta-store.js';
import { SkipSegmentStore } from '../../user/skip-segments.js';
import { SocialStore } from '../../user/social-store.js';
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
const SOCIAL_METHODS = callableNames(SocialStore.prototype);
const ADMIN_METHODS = callableNames(AdminStore.prototype);
const META_METHODS = callableNames(MetaStore.prototype);

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
  private readonly socialStore: SocialStore;
  private readonly adminStore: AdminStore;
  private readonly metaStore: MetaStore;
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
    this.socialStore = new SocialStore(db);
    this.adminStore = new AdminStore(db);
    this.metaStore = new MetaStore(db);
  }

  /** Appelle une méthode de UserStore. */
  user(method: string, args: unknown[]): unknown {
    return dispatch(this.users, USER_METHODS, method, args);
  }

  /** Appelle une méthode de SkipSegmentStore. */
  skip(method: string, args: unknown[]): unknown {
    return dispatch(this.skips, SKIP_METHODS, method, args);
  }

  /** Appelle une méthode de SocialStore (parrainage, amis, présence, masqués, annuaire des salons). */
  social(method: string, args: unknown[]): unknown {
    return dispatch(this.socialStore, SOCIAL_METHODS, method, args);
  }

  /** Appelle une méthode d'AdminStore (administration : comptes, réglages, audit, signalements). Réservé aux routes /admin et aux salons. */
  manage(method: string, args: unknown[]): unknown {
    return dispatch(this.adminStore, ADMIN_METHODS, method, args);
  }

  /** Appelle une méthode de MetaStore (index des fiches partagées, R2). */
  meta(method: string, args: unknown[]): unknown {
    return dispatch(this.metaStore, META_METHODS, method, args);
  }

  /** Migration des données (route /__admin/, protégée par ADMIN_SECRET côté Worker) : voir admin/routes.ts. */
  admin(operation: AdminOperation): Promise<unknown> {
    return runAdminOperation(this.db, operation, this.socialStore);
  }
}
