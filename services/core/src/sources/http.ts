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

/**
 * Requête avec délai couvrant l'en-tête ET la lecture complète du corps.
 * Les erreurs réseau ou de délai sont renvoyées sous forme de SourceError sans URL.
 */
export async function fetchText(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } catch (err) {
    throw transportError(err, timeoutMs);
  } finally {
    clearTimeout(timer);
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
