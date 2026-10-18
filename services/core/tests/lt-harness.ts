import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeApp, createApp } from '../src/app.js';
import { encodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import type { ConfigInput } from '../src/config/schema.js';
import type { LocalProwlarr } from '../src/sources/local-prowlarr.js';

/** Secret de chiffrement des configurations de test (jamais un secret réel). */
export const SECRET = 'lt-test-secret-with-more-than-32-chars';

/** Clés factices utilisées par les tests lt. */
export const KEYS = {
  tmdbToken: 'tmdb-token-abc123',
  tmdbApiKey: 'tmdb-v3-key-456',
  mdblistApiKey: 'mdblist-key-789',
  tvdbApiKey: 'tvdb-key-000',
  openrouterApiKey: 'openrouter-key-111',
  fanartApiKey: 'fanart-key-222',
} as const;

/** Jeton de configuration (chiffré) pour une liste de services. */
export function tokenFor(services: Record<string, string> = {}): string {
  const config: ConfigInput = { services };
  return encodeConfig(config, SECRET);
}

/** Configuration avec tous les services de test. */
export function fullToken(): string {
  return tokenFor({ ...KEYS, openrouterModel: 'test/model' });
}

export interface UpstreamCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export type Handler = (call: UpstreamCall) => Response | Promise<Response>;

export interface MockUpstream {
  fetch: typeof fetch;
  calls: UpstreamCall[];
  /** Appels dont l'URL (origine + chemin) correspond à `prefix`. */
  callsTo(prefix: string): UpstreamCall[];
}

/** Réponse JSON. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Réponse texte. */
export function text(body: string | Uint8Array, status = 200, contentType = 'text/plain'): Response {
  return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: { 'content-type': contentType } });
}

/**
 * fetch simulé : routage par origine + chemin exact (sans la query). Toute URL non prévue répond 599
 * et reste visible dans `calls`, pour que les tests échouent clairement.
 */
export function mockUpstream(handlers: Record<string, Handler>): MockUpstream {
  const calls: UpstreamCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: UpstreamCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers,
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const handler = handlers[url.origin + url.pathname];
    if (handler === undefined) return new Response('non mocké', { status: 599 });
    return handler(call);
  };
  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    callsTo: (prefix) => calls.filter((c) => c.url.origin + c.url.pathname === prefix),
  };
}

/** DNS simulé : chaque hôte renvoie l'adresse donnée, ou une adresse publique par défaut. */
export function fakeLookup(map: Record<string, string> = {}) {
  return async (hostname: string): Promise<readonly string[]> => [map[hostname] ?? '93.184.216.34'];
}

export interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Démarre l'application sur un port libre. */
export async function startApp(options: {
  fetch?: typeof fetch;
  lookupHost?: (h: string) => Promise<readonly string[]>;
  allowPlain?: boolean;
  /** Base des données utilisateur : ':memory:' par défaut (jamais de fichier dans le projet pendant les tests). */
  userDbPath?: string;
  /** Limites /user/* par minute : élevées par défaut, pour que les tests fonctionnels ne soient pas bridés. */
  userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number }>;
  /** Prowlarr local simulé (absent : aucun Prowlarr local). */
  localProwlarr?: () => Promise<LocalProwlarr | null>;
  /** Détection automatique des segments de saut (binaires, URL locales autorisées, budget). */
  skipDetect?: AppDeps['skipDetect'];
  /** Miniatures de la barre (ffmpeg, cache, origines locales de test). */
  thumbs?: AppDeps['thumbs'];
}): Promise<RunningApp> {
  const app = createApp({
    secret: SECRET,
    allowPlain: options.allowPlain ?? false,
    fetch: options.fetch,
    lookupHost: options.lookupHost,
    userDbPath: options.userDbPath ?? ':memory:',
    userRateLimits: options.userRateLimits ?? { read: 10_000, write: 10_000, sensitive: 10_000, loginPerUsername: 10_000 },
    localProwlarr: options.localProwlarr,
    skipDetect: options.skipDetect,
    thumbs: options.thumbs ?? { ffmpeg: null },
  });
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          closeApp(app);
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/** Corps JSON d'une requête POST. */
export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}
