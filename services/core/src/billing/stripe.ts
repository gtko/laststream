/**
 * Client Stripe minimal (fetch + formulaire encodé), sans SDK : fonctionne sous Node et Workers. Version d'API figée
 * pour que la forme des objets lus (abonnement, facture) ne change pas sous nos pieds.
 */

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-06-20';
const TIMEOUT_MS = 15_000;
/** Écart toléré entre l'horodatage signé d'un webhook et l'horloge locale. */
const SIGNATURE_TOLERANCE_S = 300;

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`stripe ${status} ${code}`);
    this.name = 'StripeError';
  }
}

type FormValue = string | number | boolean | undefined | null | FormValue[] | { [key: string]: FormValue };

/** Encode des paramètres imbriqués à la manière de Stripe : a[b][0][c]=… ; undefined et null sont omis. */
export function encodeForm(params: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: FormValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    } else if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(`${prefix}[${key}]`, inner);
    } else {
      out.append(prefix, String(value));
    }
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return out.toString();
}

export interface StripeClient {
  post<T>(path: string, params: Record<string, FormValue>, idempotencyKey?: string): Promise<T>;
  get<T>(path: string): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function createStripeClient(secretKey: string, fetchImpl: typeof fetch = fetch): StripeClient {
  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: string, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
    };
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    let res: Response;
    try {
      res = await fetchImpl(`${STRIPE_API}${path}`, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new StripeError(502, 'stripe_unreachable');
    }
    const json = (await res.json().catch(() => undefined)) as { error?: { code?: string; type?: string } } | undefined;
    if (!res.ok) throw new StripeError(res.status, json?.error?.code ?? json?.error?.type ?? 'stripe_error');
    return json as T;
  }
  return {
    post: (path, params, idempotencyKey) => call('POST', path, encodeForm(params), idempotencyKey),
    get: (path) => call('GET', path),
    del: (path) => call('DELETE', path),
  };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signature HMAC-SHA256 hexadécimale de `payload` (format des webhooks Stripe). */
export async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

/**
 * Vérifie l'en-tête Stripe-Signature (t=…,v1=…) d'un webhook : HMAC de « t.corps » avec le secret, horodatage à moins
 * de 5 minutes. Renvoie false sans détail si quoi que ce soit cloche.
 */
export async function verifyStripeSignature(header: string | undefined, rawBody: string, secret: string, nowMs: number = Date.now()): Promise<boolean> {
  if (header === undefined) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, val] = part.split('=', 2).map((s) => s.trim());
    if (key === 't' && val !== undefined) timestamp = Number(val);
    else if (key === 'v1' && val !== undefined) signatures.push(val);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) return false;
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => timingSafeEqualHex(sig, expected));
}

/** Champs lus sur un abonnement Stripe (API 2024-06-20 ; current_period_end lu aussi sur l'item pour les versions récentes). */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: { data?: { current_period_end?: number }[] };
}

/** Fin de la période en cours (secondes epoch) d'un abonnement, quelle que soit la version d'API. */
export function periodEnd(sub: StripeSubscription): number | undefined {
  return sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? sub.trial_end ?? undefined;
}
