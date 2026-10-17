import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicMode } from '../config/runtime-env.js';
import { isNonPublicAddress } from './ip.js';

/** Fonction fetch injectable (défaut : fetch global, résolu à chaque appel). */
export type FetchFn = typeof fetch;

/** Délai par défaut d'une requête vers une source, en millisecondes. */
export const DEFAULT_TIMEOUT_MS = 8000;

/** Options communes aux appels HTTP des sources. */
export interface HttpOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
}

/** Résultat d'un test de connexion à une source. */
export interface SourceTestResult {
  ok: boolean;
  error?: string;
}

/** Erreur dont le message est sûr : jamais d'URL complète, de clé API ni de contenu de configuration. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

/** Paramètres de requête considérés comme secrets. */
const SECRET_PARAMS = 'apikey|api_key|access_token|token|passkey|key|secret|password';

/**
 * Masque les secrets d'une URL avant affichage ou journalisation :
 * identifiants (user:pass@), valeurs des paramètres de requête secrets (?apikey=…) et segment suivant /config/.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1***@')
    .replace(new RegExp(`([?&](?:${SECRET_PARAMS})=)[^&#]*`, 'gi'), '$1***')
    .replace(/(\/config\/)[^/?#]+/gi, '$1***');
}

/** Longueur minimale d'un secret masqué. Un secret plus court n'est jamais masqué (il abîmerait le message). */
export const MIN_MASKED_SECRET_LENGTH = 6;
const GENERIC_ERROR = 'erreur inattendue';

/** Formes sous lesquelles un secret peut apparaître dans un message : brute, URL-encodée, base64, base64url. */
function secretVariants(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const variants = new Set([secret, encodeURIComponent(secret), bytes.toString('base64'), bytes.toString('base64url')]);
  return [...variants].filter((variant) => variant.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Masque (***) chaque secret et ses formes encodées dans un message d'erreur.
 * Un secret de moins de MIN_MASKED_SECRET_LENGTH caractères n'est pas masqué : si le message le contient
 * (sous une de ses formes), le message entier est remplacé par un message générique, pour ne jamais l'afficher.
 */
export function maskSecrets(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const variants = secretVariants(secret);
    if (secret.length < MIN_MASKED_SECRET_LENGTH) {
      if (variants.some((variant) => message.includes(variant))) return GENERIC_ERROR;
      continue;
    }
    for (const variant of variants) text = text.split(variant).join('***');
  }
  return text;
}

/** Vérifie qu'une valeur est un objet simple (non null, non tableau). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Applique les valeurs par défaut des options HTTP. */
export function resolveOptions(opts: HttpOptions = {}): { fetchFn: FetchFn; timeoutMs: number } {
  return { fetchFn: opts.fetch ?? fetch, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

/**
 * Fetch avec délai : la requête est annulée (AbortController) si la réponse n'arrive pas dans `timeoutMs`.
 * Le délai couvre uniquement l'obtention de la réponse ; utiliser fetchText pour borner aussi la lecture du corps.
 */
export async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw transportError(err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

/** Réponse HTTP dont le corps a été lu entièrement en texte. */
export interface TextResult {
  status: number;
  ok: boolean;
  text: string;
}

/** Nombre maximal de redirections suivies (chaque saut est revalidé). */
export const MAX_REDIRECTS = 3;
/** Taille maximale du corps d'une réponse lue, en octets. Au-delà, la lecture est interrompue. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Vérifie une URL avant envoi : schéma http(s) uniquement. En mode public (LASTADDON_PUBLIC=1), l'hôte
 * est résolu (DNS) et chaque adresse doit être publique ; une IP littérale est vérifiée sans DNS.
 * Les erreurs ne contiennent jamais l'URL ni l'hôte.
 */
export async function checkOutboundUrl(
  raw: string,
  publicMode: boolean,
  lookupHost: HostLookup = resolveHost,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError('URL invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceError('schéma non autorisé (http ou https attendu)');
  }
  if (!publicMode) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await lookupHost(host);
    } catch {
      throw new SourceError('hôte non résolu');
    }
  }
  if (addresses.length === 0 || addresses.some((address) => isNonPublicAddress(address))) {
    throw new SourceError('adresse non publique refusée (mode public)');
  }
  return url;
}

/** Résolution DNS d'un hôte : toutes les adresses renvoyées. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

/** Résolution DNS réelle d'un hôte : toutes les adresses renvoyées. */
export async function resolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Corps refusé parce qu'il dépasse le plafond. Sous-classe de SourceError : message sans contenu. */
export class SourceTooLargeError extends SourceError {
  constructor(maxBytes: number) {
    super(`réponse trop volumineuse (plus de ${maxBytes / (1024 * 1024)} Mo)`);
    this.name = 'SourceTooLargeError';
  }
}

/** Lit le corps en octets en s'arrêtant dès que `maxBytes` est dépassé (SourceTooLargeError sans contenu). */
export async function readBytesLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.get('content-length') !== null && declared > maxBytes) {
    await discardBody(response);
    throw new SourceTooLargeError(maxBytes);
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Lit le corps en texte UTF-8 en s'arrêtant dès que `maxBytes` est dépassé (SourceError sans contenu). */
export async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8').decode(await readBytesLimited(response, maxBytes));
}

/**
 * Contrôle supplémentaire d'une URL, appelé avant chaque requête (URL initiale et chaque redirection).
 * Doit lever une SourceError si la cible est refusée.
 */
export type UrlGuard = (url: URL) => Promise<void>;

/** Options de lecture du corps : plafond d'octets et contrôle d'URL par saut. */
export interface BodyOptions {
  maxBytes?: number;
  guard?: UrlGuard;
}

/** Réponse dont le corps a été lu en octets. `url` est l'adresse finale, après redirections. */
export interface BytesResult {
  status: number;
  ok: boolean;
  url: string;
  bytes: Uint8Array;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Requête avec délai couvrant l'en-tête ET la lecture complète du corps, renvoyée en octets.
 * Sécurité : schéma http(s) seul ; redirections gérées à la main (redirect: 'manual'), au plus
 * MAX_REDIRECTS, chaque saut revalidé (checkOutboundUrl puis `guard` si fourni) ; corps limité à
 * `body.maxBytes` (défaut MAX_BODY_BYTES). Les erreurs sont des SourceError sans URL.
 */
export async function fetchBytes(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  body: BodyOptions = {},
): Promise<BytesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const publicMode = isPublicMode();
    let target = url;
    for (let redirects = 0; ; redirects++) {
      await checkOutboundUrl(target, publicMode);
      if (body.guard !== undefined) await body.guard(new URL(target));
      const response = await fetchFn(target, { ...init, redirect: 'manual', signal: controller.signal });
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (location === null) {
        const bytes = await readBytesLimited(response, body.maxBytes ?? MAX_BODY_BYTES);
        return { status: response.status, ok: response.ok, url: target, bytes };
      }
      await discardBody(response);
      if (redirects >= MAX_REDIRECTS) {
        throw new SourceError(`trop de redirections (plus de ${MAX_REDIRECTS})`);
      }
      target = resolveLocation(location, target);
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw transportError(err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

/** Comme fetchBytes, avec le corps décodé en UTF-8 (plafond MAX_BODY_BYTES par défaut). */
export async function fetchText(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TextResult> {
  const result = await fetchBytes(fetchFn, url, init, timeoutMs);
  return { status: result.status, ok: result.ok, text: new TextDecoder('utf-8').decode(result.bytes) };
}

function resolveLocation(location: string, base: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    throw new SourceError('redirection invalide');
  }
}

/**
 * Préfixe une erreur par le nom de la source. Toute erreur non prévue devient un message générique,
 * pour ne jamais exposer le détail brut d'une exception susceptible de contenir une URL.
 */
export function sourceFailure(label: string, err: unknown): SourceError {
  const detail = err instanceof SourceError ? err.message : 'erreur inattendue';
  return new SourceError(`Source "${label}" : ${detail}`);
}

function transportError(err: unknown, timeoutMs: number): SourceError {
  if (isAbortError(err)) return new SourceError(`délai dépassé (${timeoutMs} ms)`);
  const code = networkErrorCode(err);
  return new SourceError(code ? `erreur réseau (${code})` : 'erreur réseau');
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Code d'erreur réseau (ex. ECONNREFUSED) : seul le code est gardé, jamais le message ni l'URL. */
function networkErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const cause: unknown = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : undefined;
}
