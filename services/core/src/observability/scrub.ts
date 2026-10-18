/**
 * Confidentialité des remontées Sentry (Worker lastaddon-core) : ce qui part vers Sentry ne contient ni en-tête
 * d'authentification, ni cookie, ni identifiant de profil, ni adresse IP, ni chaîne de requête, ni corps de requête,
 * ni configuration d'addon (segment de chemin encodé), ni lien débridé, ni lien magnet, ni clé d'API.
 * Module pur (aucun import du SDK à l'exécution) : testé sous Node.
 */
import type { Breadcrumb, ErrorEvent, Event as SentryEvent, EventHint, Exception, RequestEventData, Stacktrace } from '@sentry/cloudflare';

const REDACTED = '[redacted]';
const CONFIG = '[config]';
const DEBRID_URL = '[debrid-url]';
const MAGNET = '[magnet]';
/** Profondeur maximale parcourue dans les contextes et données libres (protection contre les cycles). */
const MAX_DEPTH = 8;
/** Au-delà de cette longueur, un segment de chemin est une configuration d'addon (base64url, JSON…), quel que soit son charset. */
const CONFIG_SEGMENT_MIN_LENGTH = 40;
/** Hôtes gardés en origine seule hors du Worker : métadonnées, visuels, sous-titres et listes de notes. */
const HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'api.themoviedb.org',
  'image.tmdb.org',
  'api4.thetvdb.com',
  'api.mdblist.com',
  'v3-cinemeta.strem.io',
]);
/** Les workers.dev du projet (compte gtux-prog) sont gardés en origine seule. */
const PROJECT_WORKERS_DEV = /\.gtux-prog\.workers\.dev$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Origine publique du Worker, posée à chaque requête (worker.ts) : ses propres URL gardent leur chemin épuré. */
let workerOrigin: string | undefined;

/** En-têtes supprimés : authentification, cookies, profil, adresses IP. */
const DROPPED_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-profile-id|cf-connecting-ip|x-forwarded-for|x-real-ip|true-client-ip)$/i;
/** Tout autre en-tête dont le nom porte un secret est supprimé. */
const SECRET_HEADER_NAME = /token|key|secret/i;
/**
 * Clés supprimées à toute profondeur : corps, cookies, chaînes de requête, secrets, en-têtes d'identité (y compris au
 * format OpenTelemetry, p. ex. `http.request.header.authorization`), e-mail, IP, environnement, variables locales.
 */
const DROPPED_KEY =
  /body|cookie|query|token|secret|authorization|x-profile-id|connecting-ip|forwarded-for|real-ip|true-client-ip|api[_-]?key|ip_address|^ip$|^email$|^env$|^vars$/i;
const DEBRID_HOST = /alldebrid|real-?debrid|torbox|premiumize/i;
/** Erreurs applicatives attendues (voir `isExpectedError`). */
const EXPECTED_CODES: ReadonlySet<string> = new Set(['server_side_disabled']);

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const MAGNET_IN_TEXT = /magnet:[^\s"'<>]*/gi;
const CREDENTIAL_PARAM = /(apikey|api[_-]?key|access[_-]?token|token|secret|password)=[^&\s"'<>;,]*/gi;
const BEARER = /\bBearer\s+[^\s"'<>,;]+/gi;
const LONG_SEGMENT_IN_TEXT = /\/[^\s/]{41,}/g;

/** Enregistre l'origine du Worker qui traite la requête courante (undefined : aucune requête). */
export function setWorkerOrigin(origin: string | undefined): void {
  workerOrigin = origin;
}

function isConfigSegment(segment: string): boolean {
  return segment.length > CONFIG_SEGMENT_MIN_LENGTH;
}

function scrubPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isConfigSegment(segment) ? CONFIG : segment))
    .join('/');
}

/** Adresse littérale IPv4 ou IPv6 (le nom d'hôte d'une URL IPv6 est entre crochets). */
const isIpLiteral = (host: string): boolean => IPV4.test(host) || host.startsWith('[');
/** localhost et les noms *.local (réseau local). */
const isLocalName = (host: string): boolean => host === 'localhost' || host.endsWith('.local');

/** Hors du Worker : [ip] pour une adresse littérale, origine seule si l'hôte est autorisé, sinon [host]. */
function reduceHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host)) return '[ip]';
  if (!host || isLocalName(host)) return '[host]';
  if (HOST_ALLOWLIST.has(host) || PROJECT_WORKERS_DEV.test(host)) return url.origin;
  return '[host]';
}

/** URL réduite à origine + chemin : sans identifiant, sans chaîne de requête, sans fragment, segments de config masqués. */
export function scrubUrl(raw: string): string {
  if (DEBRID_HOST.test(raw)) return DEBRID_URL;
  let url: URL;
  try {
    // « //hôte/chemin » (relative au schéma) est lue comme une URL https.
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  } catch {
    // Chemin relatif ou valeur non analysable : on coupe la requête et le fragment.
    return scrubPath(raw.split(/[?#]/, 1)[0] ?? '');
  }
  if (url.protocol === 'magnet:') return MAGNET;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return REDACTED;
  const host = url.hostname.toLowerCase();
  // Le Worker lui-même (hors adresse locale) : chemin épuré. Toute autre origine : hôte seul.
  if (url.origin === workerOrigin && !isIpLiteral(host) && !isLocalName(host)) {
    return `${url.origin}${scrubPath(url.pathname)}`;
  }
  return reduceHost(url);
}

/** Texte libre (message, description, valeur) : URL réduites, magnet, clés d'API, jetons, chemins de configuration. */
export function scrubText(text: string): string {
  return text
    .replace(URL_IN_TEXT, (url) => scrubUrl(url))
    .replace(MAGNET_IN_TEXT, MAGNET)
    .replace(CREDENTIAL_PARAM, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(LONG_SEGMENT_IN_TEXT, `/${CONFIG}`);
}

/** En-têtes filtrés : les identifiants, cookies, profils et adresses IP disparaissent ; les autres valeurs sont épurées. */
export function scrubHeaders(headers: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DROPPED_HEADER.test(name) || SECRET_HEADER_NAME.test(name)) continue;
    const text: unknown = Array.isArray(value) ? value.join(', ') : value;
    if (typeof text === 'string') out[name] = scrubText(text);
  }
  return out;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubValue(item, depth + 1));
  if (typeof value === 'object' && value !== null) return scrubRecord(value, depth + 1);
  return value;
}

/** Copie d'un objet libre (données, contextes, extras) : clés sensibles retirées à toute profondeur, valeurs épurées. */
function scrubRecord(record: object, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (DROPPED_KEY.test(key)) continue;
    if (key === 'headers' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = scrubHeaders(value);
    } else if (key === 'url' && typeof value === 'string') {
      out[key] = scrubUrl(value);
    } else {
      out[key] = scrubValue(value, depth);
    }
  }
  return out;
}

/** Liste blanche : méthode, URL réduite et en-têtes filtrés. Corps, cookies, chaîne de requête et environnement ne sont pas recopiés. */
function scrubRequest(request: RequestEventData): RequestEventData {
  return {
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: scrubUrl(request.url) }),
    ...(request.headers === undefined ? {} : { headers: scrubHeaders(request.headers) }),
  };
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(typeof breadcrumb.message === 'string' ? { message: scrubText(breadcrumb.message) } : {}),
    ...(breadcrumb.data === undefined ? {} : { data: scrubRecord(breadcrumb.data) }),
  };
}

function scrubStacktrace(stacktrace: Stacktrace): Stacktrace {
  // Variables locales des cadres retirées : elles peuvent contenir des configurations ou des jetons.
  return {
    ...stacktrace,
    ...(stacktrace.frames === undefined ? {} : { frames: stacktrace.frames.map(({ vars: _vars, ...frame }) => frame) }),
  };
}

function scrubException(exception: Exception): Exception {
  return {
    ...exception,
    ...(exception.value === undefined ? {} : { value: scrubText(exception.value) }),
    ...(exception.stacktrace === undefined ? {} : { stacktrace: scrubStacktrace(exception.stacktrace) }),
  };
}

/** Épure commune aux erreurs et aux transactions. L'utilisateur se réduit à son identifiant (pas d'e-mail, pas d'IP). */
function scrubEvent<E extends SentryEvent>(event: E): E {
  return {
    ...event,
    ...(event.request === undefined ? {} : { request: scrubRequest(event.request) }),
    ...(event.user === undefined ? {} : { user: { id: event.user.id } }),
    ...(event.message === undefined ? {} : { message: scrubText(event.message) }),
    ...(event.transaction === undefined ? {} : { transaction: scrubText(event.transaction) }),
    ...(event.exception?.values === undefined
      ? {}
      : { exception: { ...event.exception, values: event.exception.values.map(scrubException) } }),
    ...(event.breadcrumbs === undefined ? {} : { breadcrumbs: event.breadcrumbs.map(scrubBreadcrumb) }),
    ...(event.spans === undefined ? {} : { spans: event.spans.map((span) => scrubRecord(span)) }),
    ...(event.extra === undefined ? {} : { extra: scrubRecord(event.extra) }),
    ...(event.contexts === undefined ? {} : { contexts: scrubRecord(event.contexts) }),
    ...(event.tags === undefined ? {} : { tags: scrubRecord(event.tags) }),
  };
}

/**
 * Erreur attendue, à ne pas remonter : 4xx applicatifs, abandon côté client (AbortError), AllDebrid désactivé côté
 * serveur (`server_side_disabled`).
 */
export function isExpectedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return true;
  if (record.name === 'AbortError') return true;
  return typeof record.code === 'string' && EXPECTED_CODES.has(record.code);
}

function hasAbortException(event: SentryEvent): boolean {
  return event.exception?.values?.some((value) => value.type === 'AbortError') ?? false;
}

/** `beforeSend` du SDK : écarte les erreurs attendues, épure le reste. */
export function beforeSendFilter(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
  if (isExpectedError(hint?.originalException) || hasAbortException(event)) return null;
  return scrubEvent(event);
}

/** `beforeSendTransaction` du SDK : URL des traces (y compris les appels sortants) épurées. */
export function beforeSendTransactionFilter<E extends SentryEvent>(event: E): E {
  return scrubEvent(event);
}

/** `beforeBreadcrumb` du SDK : fil d'Ariane épuré (URL, en-têtes, corps retirés). */
export function beforeBreadcrumbFilter(breadcrumb: Breadcrumb): Breadcrumb {
  return scrubBreadcrumb(breadcrumb);
}
