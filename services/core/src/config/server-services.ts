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

/** Durée de vie du « rien en base » après une panne de lecture : réessai au bout de 5 s. */
const FAILURE_TTL_MS = 5_000;

/** Délai maximal d'une lecture du dépôt : au-delà, la lecture échoue et le repli sur les variables s'applique. */
const READ_TIMEOUT_MS = 3_000;

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

/** Entrée du cache : valable jusqu'à `expires`. `stored` est la lecture en cours ou terminée, partagée. */
interface CacheEntry {
  expires: number;
  stored: Promise<Stored>;
}

/** Cache des clés stockées, par dépôt (un dépôt par isolat en production). */
const cache = new WeakMap<ServerServicesRepo, CacheEntry>();

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
      // Seul le nom du champ est journalisé, jamais la valeur ni le contenu chiffré.
      console.warn(`[server-services] server_services indisponible (champ illisible : ${field})`);
    }
  }
  return stored;
}

/**
 * Lit et déchiffre les clés en base, lecture bornée par READ_TIMEOUT_MS. Une panne ou un délai dépassé donne « rien en
 * base », journalisé sans détail. Quand la lecture se termine, l'entrée du cache reçoit sa fin de validité : 60 s si
 * elle a réussi, 5 s si elle a échoué. Le délai armé est toujours nettoyé.
 */
async function loadStored(env: ServerServicesEnv, entry: CacheEntry): Promise<Stored> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('délai de lecture dépassé');
      err.name = 'TimeoutError';
      reject(err);
    }, READ_TIMEOUT_MS);
  });
  try {
    const rows = await Promise.race([env.users.listServerServiceRows(), deadline]);
    const stored = openRows(rows, env.secret);
    entry.expires = Date.now() + CACHE_TTL_MS;
    return stored;
  } catch (err) {
    console.warn(
      `[server-services] server_services indisponible (lecture échouée : ${err instanceof Error ? err.name : 'inconnue'})`,
    );
    entry.expires = Date.now() + FAILURE_TTL_MS;
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clés stockées en base, mises en cache 60 s. Les lectures simultanées partagent la même promesse : un cache vide ne
 * déclenche qu'un appel au dépôt. Une panne de lecture est mise en cache 5 s seulement.
 */
function storedKeys(env: ServerServicesEnv): Promise<Stored> {
  const hit = cache.get(env.users);
  if (hit !== undefined && Date.now() < hit.expires) return hit.stored;
  // Pendant la lecture, l'entrée expire au bout de 5 s (jamais de fin de validité infinie) : les appels concurrents
  // attendent la même promesse, et une lecture qui ne répond pas ne reste pas en cache.
  const entry: CacheEntry = { expires: Date.now() + FAILURE_TTL_MS, stored: Promise.resolve({}) };
  entry.stored = loadStored(env, entry);
  cache.set(env.users, entry);
  return entry.stored;
}

/** Paire TheTVDB effective (clé et PIN) et sa source. Le PIN peut être absent. */
interface TvdbPair {
  origin: 'db' | 'env';
  key: string;
  pin: string | undefined;
}

/**
 * TheTVDB : clé et PIN forment une paire d'une seule source. Si la base a une clé, la paire est celle de la base (sans
 * PIN si la base n'en a pas, sans reprendre celui des variables). Sinon, si les variables ont une clé, la paire est
 * celle des variables. Sans clé, rien : un PIN seul, en base ou en variable, est ignoré.
 */
function tvdbPair(env: ServerServicesEnv, stored: Stored): TvdbPair | undefined {
  if (stored.tvdbApiKey !== undefined) return { origin: 'db', key: stored.tvdbApiKey, pin: stored.tvdbPin };
  const key = runtimeValue(env, 'tvdbApiKey');
  if (key === undefined) return undefined;
  return { origin: 'env', key, pin: runtimeValue(env, 'tvdbPin') };
}

/**
 * Clés serveur effectives : la base d'abord, puis la variable d'exécution (TheTVDB en paire, voir tvdbPair).
 * OpenRouter ne vient que de la variable.
 */
export async function getServerServices(env: ServerServicesEnv): Promise<ServerServices> {
  const stored = await storedKeys(env);
  const services: ServerServices = {};
  for (const field of SERVER_SERVICE_FIELDS) {
    if (field === 'tvdbApiKey' || field === 'tvdbPin') continue;
    const value = stored[field] ?? runtimeValue(env, field);
    if (value !== undefined) services[field] = value;
  }
  const pair = tvdbPair(env, stored);
  if (pair !== undefined) {
    services.tvdbApiKey = pair.key;
    if (pair.pin !== undefined) services.tvdbPin = pair.pin;
  }
  const openrouter = runtimeValue(env, 'openrouterApiKey');
  if (openrouter !== undefined) services.openrouterApiKey = openrouter;
  return services;
}

/**
 * Configuration dont les clés sont complétées par celles du serveur. Pour les champs du propriétaire : base, puis
 * variable d'exécution, puis clé du compte. TheTVDB : clé et PIN forment une paire d'une seule source. Si le serveur
 * fournit la clé, la paire est celle du serveur (sans PIN si le serveur n'en a pas, sans reprendre celui du compte) ;
 * sinon la paire du compte est gardée telle quelle. OpenRouter : clé du compte, puis OPENROUTER_API_KEY.
 */
export async function withServerServices(config: Config, env: ServerServicesEnv): Promise<Config> {
  const server = await getServerServices(env);
  let services: Config['services'] | undefined;
  for (const field of SERVER_SERVICE_FIELDS) {
    if (field === 'tvdbApiKey' || field === 'tvdbPin') continue;
    const value = server[field];
    if (value === undefined) continue;
    services ??= { ...config.services };
    services[field] = value;
  }
  if (server.tvdbApiKey !== undefined) {
    services ??= { ...config.services };
    services.tvdbApiKey = server.tvdbApiKey;
    if (server.tvdbPin !== undefined) services.tvdbPin = server.tvdbPin;
    else delete services.tvdbPin;
  }
  if (config.services.openrouterApiKey === undefined && server.openrouterApiKey !== undefined) {
    services ??= { ...config.services };
    services.openrouterApiKey = server.openrouterApiKey;
  }
  return services === undefined ? config : { ...config, services };
}

/** État d'une clé serveur : présence, quatre derniers caractères si la clé est assez longue, origine. */
function stateOf(value: string | undefined, source: ServerServiceSource): ServerServiceState {
  if (value === undefined) return { set: false, source: 'none' };
  const last4 = last4Label(value);
  return last4 === undefined ? { set: true, source } : { set: true, last4, source };
}

/**
 * État masqué des clés serveur : présence, origine et quatre derniers caractères. Aucune valeur complète. TheTVDB suit
 * la paire effective : un PIN ignoré n'est pas signalé comme posé.
 */
export async function serverServicesState(env: ServerServicesEnv): Promise<ServerServicesState> {
  const stored = await storedKeys(env);
  const state = {} as ServerServicesState;
  for (const field of SERVER_SERVICE_FIELDS) {
    if (field === 'tvdbApiKey' || field === 'tvdbPin') continue;
    const fromDb = stored[field];
    state[field] = stateOf(fromDb ?? runtimeValue(env, field), fromDb === undefined ? 'env' : 'db');
  }
  const pair = tvdbPair(env, stored);
  const source = pair?.origin ?? 'none';
  state.tvdbApiKey = stateOf(pair?.key, source);
  state.tvdbPin = stateOf(pair?.pin, source);
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
  try {
    if (writes.length > 0) await env.users.writeServerServices(writes);
  } finally {
    // Abandonne le cache et la lecture en cours : la lecture suivante relit la base.
    cache.delete(env.users);
  }
  return serverServicesState(env);
}

/** Environnement de résolution d'une application : secret, dépôt des données utilisateur, variables d'exécution. */
export function serverServicesEnv(secret: string, users: ServerServicesRepo): ServerServicesEnv {
  return { users, secret, runtime: runtimeEnv() };
}
