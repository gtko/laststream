// Option --with-keys de scripts/seed-demo.ts : applique au compte démo LOCAL les clés de services lues dans 1Password.
// Garanties : aucune valeur n'est affichée, journalisée ni reprise dans un message d'erreur ; seuls des noms de services
// et de champs sortent. La configuration est chiffrée par encodeConfig (même clé et même format que le serveur) puis
// enregistrée par setAccountConfig, la méthode qu'utilise PUT /account/config. Le test de configuration passe par le
// serveur local avec la configuration chiffrée : aucune clé en clair dans la requête.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decodeConfig, encodeConfig } from '../src/config/codec.js';
import { type Config, ConfigValidationError } from '../src/config/schema.js';

/** Fichier de correspondance versionné : clé de config serveur -> référence 1Password (jamais de valeur). */
export const DEMO_KEYS_MAP_PATH = join(dirname(fileURLToPath(import.meta.url)), 'demo-keys.map.json');

/** Champs secrets de `services`, dans l'ordre de traitement. Même liste que les masques du serveur (secrets.ts). */
export const SECRET_SERVICE_FIELDS = [
  'tmdbToken',
  'tmdbApiKey',
  'mdblistApiKey',
  'tvdbApiKey',
  'tvdbPin',
  'openrouterApiKey',
  'fanartApiKey',
  'introdbApiKey',
  'skipdbApiKey',
  'animeskipClientId',
] as const satisfies readonly (keyof Config['services'])[];

type SecretServiceField = (typeof SECRET_SERVICE_FIELDS)[number];

// Garde-fou à la compilation : tout champ de `services` doit être listé ci-dessus, sauf openrouterModel (non secret).
type UnlistedServiceField = Exclude<keyof Config['services'], SecretServiceField | 'openrouterModel'>;
const _secretFieldsCoverServices: [UnlistedServiceField] extends [never] ? true : never = true;

/** Longueur maximale d'une valeur de service (même borne que le schéma de configuration). */
const MAX_VALUE_LENGTH = 500;
const REF_PATTERN = /^op:\/\/[^/]+\/[^/]+\/[^/]+$/;
const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
// 60 s : le premier déverrouillage biométrique de 1Password peut prendre plusieurs dizaines de secondes.
const OP_TIMEOUT_MS = 60_000;
const OP_BINARY_NAME = process.platform === 'win32' ? 'op.exe' : 'op';
const TEST_TIMEOUT_MS = 120_000;

/** Erreur attendue du script. Le message ne contient jamais de valeur de clé : seulement une cause ou un nom. */
export class DemoKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoKeysError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isServiceField(key: string): key is SecretServiceField {
  return (SECRET_SERVICE_FIELDS as readonly string[]).includes(key);
}

/** Lit le fichier de correspondance. Refuse toute valeur à la place d'une référence, et tout champ hors services secrets. */
export function loadDemoKeyMap(path: string): Partial<Record<SecretServiceField, string>> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new DemoKeysError('fichier de correspondance illisible (scripts/demo-keys.map.json)');
  }
  const parsed = z
    .strictObject({ refs: z.record(z.string(), z.string().regex(REF_PATTERN)) })
    .safeParse(raw);
  if (!parsed.success) {
    throw new DemoKeysError('fichier de correspondance invalide : seules des références op://coffre/item/champ sont acceptées');
  }
  const refs: Partial<Record<SecretServiceField, string>> = {};
  for (const [key, ref] of Object.entries(parsed.data.refs)) {
    if (key.startsWith('debrid')) throw new DemoKeysError('AllDebrid exclu : la clé debrid ne va jamais sur le compte démo');
    if (!isServiceField(key)) throw new DemoKeysError('entrée de correspondance refusée : seuls les champs secrets de services sont acceptés');
    refs[key] = ref;
  }
  return refs;
}

const REFUSED_SERVER = 'serveur refusé : seul un serveur local (localhost, 127.0.0.1 ou [::1]) est accepté, sans identifiants dans l’URL';

/** Origine du serveur visé : http(s) sur localhost, 127.0.0.1 ou [::1] uniquement. Le message ne reprend jamais l'URL. */
export function localServerOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DemoKeysError(REFUSED_SERVER);
  }
  const local =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOCAL_HOSTNAMES.includes(url.hostname) &&
    url.username === '' &&
    url.password === '';
  if (!local) throw new DemoKeysError(REFUSED_SERVER);
  return url.origin;
}

/**
 * Contrôle de cohérence, pas une barrière de sécurité : userDbPath() place déjà la base sous LASTADDON_DATA_DIR (ou
 * data/), donc ce test ne peut échouer que si userDbPath() change. Il refuse en plus :memory: et les URL. Une
 * protection réelle contre un chemin hostile reposerait sur la configuration de l'environnement, pas sur ce test.
 */
export function assertLocalDbTarget(dbPath: string, dataDirRaw: string | undefined, root: string): void {
  const trimmed = dataDirRaw?.trim();
  const dataDir = resolve(root, trimmed ? trimmed : 'data');
  const rel = relative(dataDir, resolve(dbPath));
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (dbPath === ':memory:' || dbPath.includes('://') || !inside) {
    throw new DemoKeysError('base refusée : le compte démo ne s’écrit que dans la base locale (LASTADDON_DATA_DIR)');
  }
}

/** Lecture d'une référence : renvoie la valeur brute. Injectable (tests) ; la valeur ne doit jamais être journalisée. */
export type OpRunner = (reference: string) => Promise<string>;

/**
 * Chemin absolu de la CLI op, cherché dans PATH. Les entrées relatives sont ignorées : sous Windows, libuv cherche
 * d'abord dans le dossier courant, donc un op.exe déposé dans le dépôt pourrait sinon être exécuté à la place de la CLI.
 */
export function findOpBinary(pathEnv: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, OP_BINARY_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Lance `op read <référence>` sans shell, avec le binaire résolu par findOpBinary. stdout reste en mémoire ; stderr n'est jamais repris. */
export function defaultOpRunner(binary: string | undefined): OpRunner {
  return (reference) =>
    new Promise((resolvePromise, reject) => {
      if (binary === undefined) {
        reject(Object.assign(new Error('CLI op absente de PATH'), { code: 'ENOENT' }));
        return;
      }
      execFile(binary, ['read', reference], { windowsHide: true, timeout: OP_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(stdout);
      });
    });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Coffre de la référence : LASTADDON_OP_VAULT remplace le coffre écrit dans le fichier de correspondance. */
function withVault(ref: string, vault: string | undefined): string {
  if (vault === undefined) return ref;
  const path = ref.slice('op://'.length);
  return `op://${vault}/${path.slice(path.indexOf('/') + 1)}`;
}

function isUsableValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !value.includes('\n') && !value.includes('\r');
}

export interface PrepareInput {
  readonly mapPath: string;
  /** Coffre 1Password (LASTADDON_OP_VAULT). Absent : celui du fichier de correspondance. */
  readonly vault: string | undefined;
  /** URL du serveur local (LASTADDON_SEED_URL ou port local par défaut). Vérifiée avant toute lecture. */
  readonly serverUrl: string;
  /** Clé de chiffrement du serveur (LASTADDON_SECRET), sans génération. */
  readonly secret: string | undefined;
  readonly runOp: OpRunner;
}

export interface DemoKeysPlan {
  /** Valeurs lues : ne jamais journaliser ce plan entier. */
  readonly services: Partial<Record<SecretServiceField, string>>;
  readonly secret: string;
  readonly serverOrigin: string;
  readonly configured: readonly SecretServiceField[];
  readonly ignored: readonly { readonly service: SecretServiceField; readonly field: string; readonly reason: string }[];
}

/**
 * Lit les clés via la commande op, sans rien écrire. Tous les refus (serveur, secret, coffre, CLI absente, aucune
 * valeur) interviennent avant l'écriture de la base. Un champ absent est ignoré avec un avertissement.
 */
export async function prepareDemoKeys(input: PrepareInput): Promise<DemoKeysPlan> {
  const serverOrigin = localServerOrigin(input.serverUrl);
  if (input.secret === undefined) {
    throw new DemoKeysError('LASTADDON_SECRET absent : lancez une fois le serveur local (il génère la clé dans .env), puis relancez');
  }
  if (input.vault !== undefined && (input.vault.trim() === '' || input.vault.includes('/') || input.vault.length > 100)) {
    throw new DemoKeysError('LASTADDON_OP_VAULT invalide : nom de coffre attendu (sans « / », 100 caractères au plus)');
  }
  const refs = loadDemoKeyMap(input.mapPath);
  const services: Partial<Record<SecretServiceField, string>> = {};
  const configured: SecretServiceField[] = [];
  const ignored: { service: SecretServiceField; field: string; reason: string }[] = [];
  for (const service of SECRET_SERVICE_FIELDS) {
    const ref = refs[service];
    if (ref === undefined) continue;
    const field = ref.slice(ref.lastIndexOf('/') + 1);
    try {
      const value = (await input.runOp(withVault(ref, input.vault))).trim();
      if (!isUsableValue(value)) {
        ignored.push({ service, field, reason: 'vide ou invalide' });
        continue;
      }
      services[service] = value;
      configured.push(service);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new DemoKeysError('commande op introuvable : installez la CLI 1Password et connectez-vous (op signin)');
      }
      ignored.push({ service, field, reason: 'absent ou illisible' });
    }
  }
  if (configured.length === 0) {
    throw new DemoKeysError('aucune clé lue : vérifiez la connexion de la CLI op, le coffre (LASTADDON_OP_VAULT), l’item et les noms de champs');
  }
  return { services, secret: input.secret, serverOrigin, configured, ignored };
}

/** Sous-ensemble de UserStore utilisé pour lire et écrire la configuration chiffrée du compte. */
export interface AccountConfigStore {
  getAccountConfig(accountId: string): string | null;
  setAccountConfig(accountId: string, value: string | null): void;
}

/**
 * Remplace les clés de services du compte par celles du plan, puis enregistre la configuration chiffrée. Les autres
 * réglages existants sont conservés ; AllDebrid (debrid) est retiré ; un service absent du plan n'a plus de clé.
 */
export function applyDemoKeys(store: AccountConfigStore, accountId: string, plan: DemoKeysPlan): { encoded: string; warnings: string[] } {
  const warnings: string[] = [];
  let base: Record<string, unknown> = {};
  const existing = store.getAccountConfig(accountId);
  if (existing !== null) {
    try {
      base = { ...decodeConfig(existing, plan.secret, { allowPlain: false }) };
    } catch {
      warnings.push('configuration existante illisible avec cette clé : remplacée par la configuration de démonstration');
    }
  }
  if (base.debrid !== undefined) {
    delete base.debrid;
    warnings.push('AllDebrid (debrid) retiré du compte démo : ses clés restent côté appareil');
  }
  const services: Record<string, unknown> = { ...(base.services as Record<string, unknown> | undefined) };
  for (const field of SECRET_SERVICE_FIELDS) delete services[field];
  Object.assign(services, plan.services);
  base.services = services;
  let encoded: string;
  try {
    encoded = encodeConfig(base, plan.secret);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw new DemoKeysError(`configuration du compte démo refusée : ${error.issues.join('; ')}`);
    }
    throw error;
  }
  store.setAccountConfig(accountId, encoded);
  return { encoded, warnings };
}

export type DemoServiceTest =
  | { readonly status: 'done'; readonly lines: readonly { readonly name: string; readonly ok: boolean }[] }
  | { readonly status: 'skipped' | 'failed'; readonly reason: string };

/** POST /config/test du serveur local avec la configuration chiffrée. Seuls les noms et l'état OK/échec sont retenus. */
export async function runDemoServiceTest(serverOrigin: string, encoded: string, fetchImpl: typeof fetch = fetch): Promise<DemoServiceTest> {
  let response: Response;
  try {
    // redirect: 'error' : une redirection (307/308) vers un autre hôte enverrait la configuration chiffrée hors de la machine.
    response = await fetchImpl(`${serverOrigin}/config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: encoded }),
      redirect: 'error',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { status: 'skipped', reason: 'serveur local injoignable, ou redirection refusée (lancez-le, puis relancez le script)' };
  }
  if (!response.ok) return { status: 'failed', reason: `réponse HTTP ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'failed', reason: 'réponse non JSON' };
  }
  const services = isObject(body) && Array.isArray(body.services) ? body.services : undefined;
  if (services === undefined) return { status: 'failed', reason: 'réponse inattendue' };
  const lines = services.filter(isObject).map((item) => ({
    name: typeof item.name === 'string' ? item.name : 'service',
    ok: item.ok === true,
  }));
  return { status: 'done', lines };
}

/** Compte rendu lisible : noms de services, champs ignorés, résultat du test. Aucune valeur. */
export function describeDemoKeys(plan: DemoKeysPlan, test: DemoServiceTest): string[] {
  const lines: string[] = [];
  for (const item of plan.ignored) lines.push(`Avertissement : champ 1Password « ${item.field} » ${item.reason}, ignoré.`);
  lines.push(`Services configurés (${plan.configured.length}) : ${plan.configured.join(', ')}.`);
  lines.push(
    plan.ignored.length === 0
      ? 'Services ignorés : aucun.'
      : `Services ignorés : ${plan.ignored.map((item) => item.service).join(', ')}.`,
  );
  if (test.status === 'done') {
    lines.push('Test de configuration (serveur local) :');
    for (const line of test.lines) lines.push(`  ${line.name} : ${line.ok ? 'OK' : 'échec'}`);
  } else {
    lines.push(`Test de configuration ${test.status === 'skipped' ? 'ignoré' : 'en échec'} : ${test.reason}.`);
  }
  return lines;
}
