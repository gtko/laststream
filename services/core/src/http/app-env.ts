import { type Context, Hono } from 'hono';

/** Liaisons fournies par l'adaptateur Node (@hono/node-server) : seule la socket entrante nous intéresse. */
export interface ServerBindings {
  incoming?: { socket?: { remoteAddress?: string } };
  /** Adresse IP du client fournie par l'hôte (Workers : en-tête CF-Connecting-IP posé par Cloudflare). */
  clientIp?: string;
  /** Pays du client fourni par l'hôte (Workers : request.cf.country). Absent hors Cloudflare (Node). */
  country?: string;
}

/** Variables posées par les middlewares communs. */
export interface AppVariables {
  /** Adresse IP du client (socket, relais de confiance ou relais authentifié), ou undefined si inconnue. */
  ip: string | undefined;
  /** Vrai si la requête vient du relais authentifié (LASTADDON_EDGE_SECRET). */
  edge: boolean;
  /** Corps JSON décodé (undefined si la requête n'en porte pas ou n'est pas en JSON). */
  body: unknown;
  /** Nature de l'erreur interne en cours (nom et message de l'exception) : lue par les métriques, jamais renvoyée au client. */
  failure?: string;
}

/** Environnement Hono de l'application : liaisons de l'hôte et variables des middlewares. */
export type AppEnv = { Bindings: ServerBindings; Variables: AppVariables };
export type App = Hono<AppEnv>;
export type Ctx = Context<AppEnv>;

/** Nouvelle application Hono : routes insensibles au slash final (comme Express). */
export function newApp(): App {
  return new Hono<AppEnv>({ strict: false });
}
