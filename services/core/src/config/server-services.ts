import { type RuntimeEnv, runtimeEnv } from '../platform/index.js';
import type { UserRepo } from '../user/repo.js';
import { decryptJson, encryptJson } from './codec.js';
import type { Config } from './schema.js';
import { last4Label } from './secrets.js';

/**
 * Clés de services au niveau du serveur, partagées par tous les comptes. Trois sources, dans l'ordre : la base des
 * données utilisateur (chiffrée, gérée par le propriétaire), puis les variables d'exécution (environnement Node,
 * secrets Worker), puis la clé saisie dans le compte. OpenRouter n'a pas de clé en base : compte, puis
 * OPENROUTER_API_KEY. Ces valeurs ne sont jamais renvoyées au client ni journalisées : seul l'état masqué sort de ce module.
 */

/** Champs gérés par le propriétaire, stockés en base. OpenRouter n'y est jamais stocké. */
const SERVER_SERVICE_FIELDS = [
  'tmdbToken',
  'tmdbApiKey',
  'mdblistApiKey',
  'tvdbApiKey',
  'tvdbPin',
  'fanartApiKey',
  'introdbApiKey',
  'skipdbApiKey',
  'animeskipClientId',
] as const;

export type ServerServiceField = (typeof SERVER_SERVICE_FIELDS)[number];

/** Variable d'exécution de chaque clé serveur (OpenRouter inclus, qui ne vient que de là côté serveur). */
const SERVER_SERVICE_ENV: Record<ServerServiceField | 'openrouterApiKey', string> = {
  tmdbToken: 'TMDB_TOKEN',
  tmdbApiKey: 'TMDB_API_KEY',
  mdblistApiKey: 'MDBLIST_API_KEY',
  tvdbApiKey: 'TVDB_API_KEY',
  tvdbPin: 'TVDB_PIN',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  fanartApiKey: 'FANART_API_KEY',
  introdbApiKey: 'INTRODB_API_KEY',
  skipdbApiKey: 'SKIPDB_API_KEY',
  animeskipClientId: 'ANIMESKIP_CLIENT_ID',
};

/** Libellé de dérivation de la clé de chiffrement des clés serveur (distinct de celui des configurations de compte). */
const SEAL_PURPOSE = 'server-services';

/** Longueur maximale d'une clé serveur (aligné sur le schéma des clés de compte). */
const MAX_KEY_LENGTH = 500;

/** Durée de vie du cache des clés stockées, par isolat. */
const CACHE_TTL_MS = 60_000;

/** Dépôt utilisé pour lire et écrire les clés serveur (sous-ensemble du dépôt des données utilisateur). */
export type ServerServicesRepo = Pick<UserRepo, 'listServerServiceRows' | 'writeServerServices'>;

/** Ce qu'il faut pour résoudre et écrire les clés serveur : dépôt, secret de chiffrement, variables d'exécution. */
export interface ServerServicesEnv {
  readonly users: ServerServicesRepo;
  readonly secret: string;
  readonly runtime: RuntimeEnv;
}

/** Clés serveur effectives (base, sinon variable d'exécution). Ne jamais journaliser ni renvoyer ces valeurs. */
export type ServerServices = Partial<Record<ServerServiceField | 'openrouterApiKey', string>>;

/** Origine d'une clé serveur : la base, une variable d'exécution, ou aucune. */
type ServerServiceSource ='db' | 'env' | 'none';

/** État masqué d'une clé serveur : présence, quatre derniers caractères si la clé est assez longue, origine. */
interface ServerServiceState {
  set: boolean;
  last4?: string;
  source: ServerServiceSource;
}

export type ServerServicesState = Record<ServerServiceField, ServerServiceState>;

/** Modification : valeur (écrite), vide ou absente (gardée), null (effacée de la base). */
export type ServerServicesPatch = Partial<Record<ServerServiceField, string | null>>;

/** Clés stockées en base, déjà déchiffrées. */
type Stored = Partial<Record<ServerServiceField, string>>;

/** Cache des clés stockées, par dépôt (un dépôt par isolat en production). */
const cache = new WeakMap<ServerServicesRepo, { at: number; stored: Stored }>();

function isServerServiceField(name: string): name is ServerServiceField {
  return (SERVER_SERVICE_FIELDS as readonly string[]).includes(name);
}

/** Valeur d'une variable d'exécution, sans espaces ; undefined si absente ou vide. */
function runtimeValue(env: ServerServicesEnv, key: ServerServiceField | 'openrouterApiKey'): string | undefined {
  return env.runtime.get(SERVER_SERVICE_ENV[key])?.trim() || undefined;
}

/** Déchiffre les lignes lues en base. Une ligne illisible (LASTADDON_SECRET changé) compte comme absente. */
function openRows(rows: readonly { field: string; sealed: string }[], secret: string): Stored {
  const stored: Stored = {};
  for (const { field, sealed } of rows) {
    if (!isServerServiceField(field)) continue;
    try {
      const value = decryptJson(sealed, secret, SEAL_PURPOSE);
      if (typeof value === 'string' && value !== '') stored[field] = value;
    } catch {
      // Message générique : aucune valeur ni contenu n'est journalisé.
    }
  }
  return stored;
}

/**
 * Clés stockées en base, mises en cache 60 s. Une panne de lecture donne « rien en base » sans mise en cache : la
 * résolution se replie sur les variables d'exécution et réessaie à la demande suivante.
 */
async function storedKeys(env: ServerServicesEnv): Promise<Stored> {
  const hit = cache.get(env.users);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.stored;
  const rows = await env.users.listServerServiceRows().catch(() => undefined);
  if (rows === undefined) return {};
  const stored = openRows(rows, env.secret);
  cache.set(env.users, { at: Date.now(), stored });
  return stored;
}

/** Clés serveur effectives : la base d'abord, puis la variable d'exécution. OpenRouter ne vient que de la variable. */
export async function getServerServices(env: ServerServicesEnv): Promise<ServerServices> {
  const stored = await storedKeys(env);
  const services: ServerServices = {};
  for (const field of SERVER_SERVICE_FIELDS) {
    const value = stored[field] ?? runtimeValue(env, field);
    if (value !== undefined) services[field] = value;
  }
  const openrouter = runtimeValue(env, 'openrouterApiKey');
  if (openrouter !== undefined) services.openrouterApiKey = openrouter;
  return services;
}

/**
 * Configuration dont les clés sont complétées par celles du serveur. Pour les champs du propriétaire : base, puis
 * variable d'exécution, puis clé du compte. OpenRouter : clé du compte, puis OPENROUTER_API_KEY.
 */
export async function withServerServices(config: Config, env: ServerServicesEnv): Promise<Config> {
  const server = await getServerServices(env);
  let services: Config['services'] | undefined;
  for (const field of SERVER_SERVICE_FIELDS) {
    const value = server[field];
    if (value === undefined) continue;
    services ??= { ...config.services };
    services[field] = value;
  }
  if (config.services.openrouterApiKey === undefined && server.openrouterApiKey !== undefined) {
    services ??= { ...config.services };
    services.openrouterApiKey = server.openrouterApiKey;
  }
  return services === undefined ? config : { ...config, services };
}

/** État masqué des clés serveur : présence, origine et quatre derniers caractères. Aucune valeur complète. */
export async function serverServicesState(env: ServerServicesEnv): Promise<ServerServicesState> {
  const stored = await storedKeys(env);
  const state = {} as ServerServicesState;
  for (const field of SERVER_SERVICE_FIELDS) {
    const fromDb = stored[field];
    const value = fromDb ?? runtimeValue(env, field);
    if (value === undefined) {
      state[field] = { set: false, source: 'none' };
      continue;
    }
    const source: ServerServiceSource = fromDb === undefined ? 'env' : 'db';
    const last4 = last4Label(value);
    state[field] = last4 === undefined ? { set: true, source } : { set: true, last4, source };
  }
  return state;
}

/**
 * Écrit ou efface des clés serveur. Valeur absente ou vide : gardée. `null` : effacée de la base (la variable
 * d'exécution reprend le relais). Invalide le cache de cet isolat et renvoie l'état masqué.
 */
export async function setServerServices(env: ServerServicesEnv, patch: ServerServicesPatch): Promise<ServerServicesState> {
  const writes: { field: string; sealed: string | null }[] = [];
  for (const field of SERVER_SERVICE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) {
      writes.push({ field, sealed: null });
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') continue;
    if (trimmed.length > MAX_KEY_LENGTH) throw new RangeError(`clé serveur trop longue : ${field}`);
    writes.push({ field, sealed: encryptJson(trimmed, env.secret, SEAL_PURPOSE) });
  }
  if (writes.length > 0) await env.users.writeServerServices(writes);
  cache.delete(env.users);
  return serverServicesState(env);
}

/** Environnement de résolution d'une application : secret, dépôt des données utilisateur, variables d'exécution. */
export function serverServicesEnv(secret: string, users: ServerServicesRepo): ServerServicesEnv {
  return { users, secret, runtime: runtimeEnv() };
}
