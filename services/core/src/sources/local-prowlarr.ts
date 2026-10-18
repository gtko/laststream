import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import type { FetchFn } from './http.js';
import { discoverProwlarrIndexers } from './prowlarr.js';

/**
 * Prowlarr local : instance installée sur la machine du serveur, détectée au lieu d'être configurée. La clé API ne
 * sort jamais de ce module vers les clients (ni /config/*, ni les erreurs, ni les journaux).
 */
export interface LocalProwlarr {
  baseUrl: string;
  apiKey: string;
  /** Indexeurs torrent activés, lus à la validation. */
  indexerCount: number;
}

/** Statut public du Prowlarr local (sans URL ni clé) : affiché par /config/schema et /config/test. */
export interface LocalProwlarrStatus {
  detected: boolean;
  indexers: number;
  label: string;
  /** Entrée virtuelle de la liste des sources (présente si détecté) : à afficher, désactiver et réordonner. */
  source?: LocalProwlarrSourceEntry;
}

/** Entrée virtuelle « Prowlarr local » dans la liste des sources : `position` = rang parmi les sources configurées. */
export interface LocalProwlarrSourceEntry {
  type: 'prowlarr-local';
  name: string;
  enabled: boolean;
  position: number | null;
}

/** Entrées de la détection : variables d'environnement, lecture de fichier (synchrone), fetch injectable. */
export interface LocalProwlarrIo {
  env: Readonly<Record<string, string | undefined>>;
  /** Lit un fichier texte ; lève si le fichier est absent. */
  readFile: (path: string) => string;
  fetch?: FetchFn;
  /** Plateforme (tests). Défaut : process.platform. */
  platform?: NodeJS.Platform;
  /** Dossier personnel (tests). Défaut : os.homedir(). */
  homeDir?: string;
}

/** Fournisseur du Prowlarr local, injecté dans l'application (absent : aucun Prowlarr local). */
export type LocalProwlarrProvider = () => Promise<LocalProwlarr | null>;

export const LOCAL_PROWLARR_NAME = 'Prowlarr local';
export const LOCAL_PROWLARR_URL = 'http://localhost:9696';
/** Durée de mise en cache du résultat de détection (succès comme échec) : 60 secondes. */
export const LOCAL_PROWLARR_CACHE_MS = 60_000;
/** Délai de la validation (GET /api/v1/indexer) : une instance locale répond vite, sinon elle est ignorée. */
const DETECT_TIMEOUT_MS = 3_000;
const WINDOWS_CONFIG_PATH = 'C:\\ProgramData\\Prowlarr\\config.xml';

/**
 * Activation de la détection. LASTADDON_PROWLARR_AUTO=0 la coupe. En mode public (LASTADDON_PUBLIC=1), elle est
 * désactivée par défaut (abus et SSRF) : seul LASTADDON_PROWLARR_AUTO=1 l'active.
 */
export function localProwlarrEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const flag = env.LASTADDON_PROWLARR_AUTO?.trim();
  if (flag === '0') return false;
  if (env.LASTADDON_PUBLIC === '1') return flag === '1';
  return true;
}

/** Clé API dans config.xml (balise ApiKey de Prowlarr). Renvoie seulement la valeur, jamais le document. */
export function apiKeyFromXml(xml: string): string | undefined {
  const match = /<ApiKey>\s*([^<\s]{1,500})\s*<\/ApiKey>/.exec(xml);
  return match?.[1];
}

/** Fichier config.xml de Prowlarr : Windows (ProgramData), sinon ~/.config/Prowlarr. */
export function defaultConfigPath(platform: NodeJS.Platform, homeDir: string): string {
  return platform === 'win32' ? WINDOWS_CONFIG_PATH : join(homeDir, '.config', 'Prowlarr', 'config.xml');
}

/**
 * Clé API lue une seule fois : LASTADDON_PROWLARR_KEY, sinon config.xml. Mémorisée dès qu'elle est trouvée ; une
 * absence n'est pas mémorisée (elle peut être ajoutée plus tard).
 */
let memoizedKey: string | undefined;

function readApiKey(io: LocalProwlarrIo): string | undefined {
  if (memoizedKey !== undefined) return memoizedKey;
  const fromEnv = io.env.LASTADDON_PROWLARR_KEY?.trim();
  let key: string | undefined = fromEnv ? fromEnv : undefined;
  if (key === undefined) {
    const path =
      io.env.LASTADDON_PROWLARR_CONFIG_PATH?.trim() ||
      defaultConfigPath(io.platform ?? process.platform, io.homeDir ?? homedir());
    try {
      key = apiKeyFromXml(io.readFile(path));
    } catch {
      // Fichier absent ou illisible : pas de Prowlarr local. Le chemin n'est pas journalisé.
      key = undefined;
    }
  }
  if (key !== undefined) memoizedKey = key;
  return key;
}

/** URL de base : LASTADDON_PROWLARR_URL, sinon http://localhost:9696. Undefined si elle n'est pas une URL absolue. */
function baseUrlOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = (env.LASTADDON_PROWLARR_URL?.trim() || LOCAL_PROWLARR_URL).replace(/\/+$/, '');
  try {
    new URL(raw);
    return raw;
  } catch {
    return undefined;
  }
}

/** Détection sans cache : activation, clé, puis validation par la découverte des indexeurs. Ne lève jamais. */
async function probeLocalProwlarr(io: LocalProwlarrIo): Promise<LocalProwlarr | null> {
  try {
    if (!localProwlarrEnabled(io.env)) return null;
    const apiKey = readApiKey(io);
    const baseUrl = baseUrlOf(io.env);
    if (apiKey === undefined || baseUrl === undefined) return null;
    const indexers = await discoverProwlarrIndexers(
      { name: LOCAL_PROWLARR_NAME, baseUrl, apiKey },
      { fetch: io.fetch, timeoutMs: DETECT_TIMEOUT_MS },
    );
    return { baseUrl, apiKey, indexerCount: indexers.length };
  } catch {
    // Échec de validation : message et détail ignorés (ils pourraient contenir l'URL ou la clé).
    return null;
  }
}

/** Résultat de détection en cours ou mis en cache (succès ou échec) et sa date d'expiration. */
let cached: { expiresAt: number; pending: Promise<LocalProwlarr | null> } | undefined;

/**
 * Prowlarr local valide, ou null (non détecté, désactivé, clé introuvable, instance injoignable). Ne lève jamais.
 * Le résultat est mis en cache 60 secondes ; les appels simultanés partagent la même détection.
 */
export function detectLocalProwlarr(io: LocalProwlarrIo): Promise<LocalProwlarr | null> {
  const now = Date.now();
  if (cached !== undefined && cached.expiresAt > now) return cached.pending;
  const pending = probeLocalProwlarr(io);
  cached = { expiresAt: now + LOCAL_PROWLARR_CACHE_MS, pending };
  return pending;
}

/** Vide le cache de détection et la clé mémorisée (tests, ou changement d'environnement). */
export function clearLocalProwlarrCache(): void {
  cached = undefined;
  memoizedKey = undefined;
}

/** Statut public d'un Prowlarr local : présence et nombre d'indexeurs, jamais l'URL ni la clé. */
export function localProwlarrStatus(
  local: LocalProwlarr | null,
  config?: Pick<Config, 'sources' | 'autoProwlarr' | 'localProwlarr'>,
): LocalProwlarrStatus {
  if (local === null) return { detected: false, indexers: 0, label: 'Aucun Prowlarr local détecté' };
  const position = config === undefined ? null : Math.min(config.localProwlarr.position ?? config.sources.length, config.sources.length);
  return {
    detected: true,
    indexers: local.indexerCount,
    label: `Prowlarr local détecté (${local.indexerCount} indexeurs)`,
    source: {
      type: 'prowlarr-local',
      name: `Prowlarr local (${local.indexerCount} indexeurs)`,
      enabled: config === undefined ? true : config.autoProwlarr && config.localProwlarr.enabled,
      position,
    },
  };
}

/** Statut à partir d'un fournisseur optionnel ; un fournisseur en échec donne « non détecté ». */
export async function localProwlarrStatusOf(
  provider: LocalProwlarrProvider | undefined,
  config?: Pick<Config, 'sources' | 'autoProwlarr' | 'localProwlarr'>,
): Promise<LocalProwlarrStatus> {
  if (provider === undefined) return localProwlarrStatus(null);
  try {
    return localProwlarrStatus(await provider(), config);
  } catch {
    return localProwlarrStatus(null);
  }
}

/** Hôte et port d'une URL, `localhost` et loopback confondus : sert à reconnaître le même Prowlarr. */
function endpointKey(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
    return `${loopback ? 'localhost' : host}:${port}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw;
  }
}

/** Vrai si la configuration a déjà une source Prowlarr sur cette instance (même URL de base). */
export function hasExplicitProwlarr(sources: Config['sources'], baseUrl: string): boolean {
  const wanted = endpointKey(baseUrl);
  return sources.some((source) => source.type === 'prowlarr' && endpointKey(source.baseUrl) === wanted);
}

/**
 * Sources à interroger : les sources explicites (ordre conservé), plus le Prowlarr local détecté. Le Prowlarr local est
 * ajouté si `autoProwlarr` et `localProwlarr.enabled` sont actifs, qu'il est détecté et qu'aucune source Prowlarr de la
 * configuration ne vise déjà la même instance. Sa position (`localProwlarr.position`, défaut : en dernier) est son rang
 * de priorité. Les sources explicites ne sont jamais remplacées.
 */
export function effectiveSources(
  config: Pick<Config, 'sources' | 'autoProwlarr' | 'localProwlarr'>,
  local: LocalProwlarr | null,
): Config['sources'] {
  if (!config.autoProwlarr || !config.localProwlarr.enabled || local === null) return config.sources;
  if (hasExplicitProwlarr(config.sources, local.baseUrl)) return config.sources;
  const sources = [...config.sources];
  const position = Math.min(config.localProwlarr.position ?? sources.length, sources.length);
  sources.splice(position, 0, {
    enabled: true,
    type: 'prowlarr',
    name: LOCAL_PROWLARR_NAME,
    baseUrl: local.baseUrl,
    apiKey: local.apiKey,
  });
  return sources;
}
