import type { DurableObjectState, WebSocket as CfWebSocket } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { type AdminOperation, runAdminOperation } from '../../admin/routes.js';
import { createRateLimiter } from '../../rate-limit.js';
import { AdminStore } from '../../user/admin-store.js';
import { migrate } from '../../user/migrations.js';
import { MetaStore } from '../../user/meta-store.js';
import { SkipSegmentStore } from '../../user/skip-segments.js';
import { SocialStore } from '../../user/social-store.js';
import type { SocialEvent } from '../../user/social-v2-events.js';
import {
  isOversizedLiveFrame,
  LIVE_PONG_FRAME,
  liveEnvelopes,
  parseLiveClientFrame,
  SOCIAL_LIVE_FRAME_TOO_LARGE,
  SOCIAL_LIVE_PID_HEADER,
  SOCIAL_LIVE_RATE_LIMITED,
  SOCIAL_LIVE_REPLACED,
} from '../../user/social-v2-live.js';
import { SocialV2Store } from '../../user/social-v2-store.js';
import type { SqlDb } from '../../user/sql.js';
import { UserStore } from '../../user/store.js';
import { durableObjectSql } from './sql.js';

/** Constructeur de paires WebSocket de l'exécution Workers (non déclaré par les types retenus ici). */
declare const WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };

/** Trames client par profil et par minute : au-delà, la connexion est fermée (4008). Le ping n'en consomme qu'une. */
const LIVE_FRAMES_PER_MINUTE = 30;
const liveFrameLimit = createRateLimiter(LIVE_FRAMES_PER_MINUTE, 60_000);

/** Données attachées à chaque socket du flux social (survivent à l'hibernation). */
interface LiveAttachment {
  pid: string;
}

/** Ferme sans lever : la socket peut déjà être fermée. */
function closeQuietly(ws: CfWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // déjà fermée
  }
}

/** Envoie sans lever : la socket peut être en cours de fermeture. */
function sendQuietly(ws: CfWebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // socket en cours de fermeture
  }
}

/** Méthodes des stores jamais exposées en RPC (internes ou propres à l'hôte). */
const HIDDEN = new Set(['constructor', 'transaction', 'close', 'updateProfileFields', 'createSession']);

function callableNames(prototype: object): Set<string> {
  return new Set(Object.getOwnPropertyNames(prototype).filter((name) => !HIDDEN.has(name)));
}

const USER_METHODS = callableNames(UserStore.prototype);
const SKIP_METHODS = callableNames(SkipSegmentStore.prototype);
const SOCIAL_METHODS = callableNames(SocialStore.prototype);
const SOCIAL_V2_METHODS = callableNames(SocialV2Store.prototype);
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
  private readonly socialV2Store: SocialV2Store;
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
    this.socialV2Store = new SocialV2Store(db);
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

  /** Appelle une méthode de SocialV2Store (identités par profil, amitiés et foyer, présence, bibliothèque et historique). */
  socialV2(method: string, args: unknown[]): unknown {
    return dispatch(this.socialV2Store, SOCIAL_V2_METHODS, method, args);
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

  // Flux temps réel social (GET /user/social/live)

  /**
   * Mise à niveau du flux social. Le Worker a déjà vérifié le ticket et posé l'en-tête interne du profil. Une seule
   * connexion par profil : la nouvelle ferme l'ancienne (4000). API d'hibernation : une socket est étiquetée par son pid.
   */
  fetch(request: Request): Response {
    const pid = request.headers.get(SOCIAL_LIVE_PID_HEADER);
    if (pid === null || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ error: 'upgrade_required' }), { status: 426, headers: { 'content-type': 'application/json' } });
    }
    for (const old of this.ctx.getWebSockets(pid)) closeQuietly(old, SOCIAL_LIVE_REPLACED, 'replaced');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: LiveAttachment = { pid };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [pid]);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /**
   * Diffuse un événement social aux sockets des profils de l'audience (une trame identique par destinataire, voir
   * social-v2-live.ts). Appelé par le Worker après chaque écriture sociale ; sans socket, sans effet.
   */
  liveBroadcast(audience: string[], event: SocialEvent): void {
    for (const { pid, frame } of liveEnvelopes(audience, event)) {
      for (const ws of this.ctx.getWebSockets(pid)) sendQuietly(ws, frame);
    }
  }

  /** Trames client : `{ t: "ping" }` reçoit `{ t: "pong" }` ; trop grosse : fermée (4013) ; invalide : ignorée. */
  webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    if (isOversizedLiveFrame(message)) {
      closeQuietly(ws, SOCIAL_LIVE_FRAME_TOO_LARGE, 'frame_too_large');
      return;
    }
    const attachment = ws.deserializeAttachment() as LiveAttachment | null;
    if (attachment === null) return;
    if (!liveFrameLimit(attachment.pid).allowed) {
      closeQuietly(ws, SOCIAL_LIVE_RATE_LIMITED, 'rate_limited');
      return;
    }
    if (parseLiveClientFrame(message) === 'ping') sendQuietly(ws, LIVE_PONG_FRAME);
  }

  /** Fermeture par le client : la poignée de fermeture est menée à terme (codes 1005 et 1006 non renvoyables). */
  webSocketClose(ws: CfWebSocket, code: number, reason: string): void {
    closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }
}
