import { LastAddonError } from './errors';
import { requireBase } from './config';
import { cachedRequest, requestJson } from './transport';

/** Schéma JSON de la configuration (GET {base}/config/schema), mis en cache. */
export function getSchema(base: string = requireBase()): Promise<any> {
  return cachedRequest(`schema ${base}`, () => requestJson<any>(`${base}/config/schema`));
}

/**
 * Chiffre une configuration (POST {base}/config/encode). Avec `previous` (chaîne déjà enregistrée), le serveur garde
 * les secrets que `config` laisse vides ou masqués : les clés n'ont pas à être ressaisies.
 */
export async function encodeConfig(config: Record<string, unknown>, previous?: string, base: string = requireBase()): Promise<string> {
  const body = previous ? { previous, config } : config;
  const res = await requestJson<{ config?: unknown }>(`${base}/config/encode`, { method: 'POST', body });
  if (typeof res.config !== 'string') throw new LastAddonError('invalid_response', 'Réponse d’encodage invalide.');
  return res.config;
}

/** Secret masqué renvoyé par /config/decode : jamais la valeur. */
export interface SecretMask {
  set: true;
  last4?: string;
}

/** Configuration enregistrée, secrets masqués ({set, last4}). Null si le serveur ne la décode pas. */
export async function decodeConfig(encoded: string, base: string = requireBase()): Promise<Record<string, any> | null> {
  try {
    const res = await requestJson<unknown>(`${base}/config/decode`, { method: 'POST', body: { config: encoded }, timeoutMs: 60_000 });
    return typeof res === 'object' && res !== null && !Array.isArray(res) ? (res as Record<string, any>) : null;
  } catch {
    return null;
  }
}

interface CheckResult {
  name: string;
  type: string;
  ok: boolean;
  error?: string;
  note?: string;
}

export interface TestResponse {
  sources: CheckResult[];
  services: CheckResult[];
}

/** Teste les sources, le compte debrid et les clés de service d'une configuration chiffrée (POST /config/test). */
export async function testConfig(encoded: string, base: string = requireBase()): Promise<TestResponse> {
  const res = await requestJson<Partial<TestResponse>>(`${base}/config/test`, { method: 'POST', body: { config: encoded }, timeoutMs: 60_000 });
  return { sources: res.sources ?? [], services: res.services ?? [] };
}

/** Vrai si la valeur est un masque de secret ({set:true}). */
export const isMask = (v: unknown): v is SecretMask =>
  typeof v === 'object' && v !== null && (v as { set?: unknown }).set === true;


export interface SourceProbe {
  ok: boolean;
  error?: string;
  name?: string;
  logo?: string;
  version?: string;
  description?: string;
  types?: string[];
  configurable?: boolean;
}

/** Teste une seule source via lastAddon (repli quand le navigateur ne peut pas lire le manifest : CORS). */
export async function testSource(source: Record<string, unknown>, base: string = requireBase()): Promise<SourceProbe> {
  const res = await requestJson<any>(`${base}/config/test`, { method: 'POST', body: { config: { sources: [source] } }, timeoutMs: 60_000 });
  const r = res?.sources?.[0] ?? {};
  const m = r.manifest && typeof r.manifest === 'object' ? r.manifest : r;
  return {
    ok: !!r.ok,
    error: typeof r.error === 'string' ? r.error : undefined,
    name: typeof m.name === 'string' && m.name !== source.name ? m.name : undefined,
    logo: typeof (m.logo ?? m.icon) === 'string' ? (m.logo ?? m.icon) : undefined,
    version: typeof m.version === 'string' ? m.version : undefined,
    description: typeof m.description === 'string' ? m.description : undefined,
    types: Array.isArray(m.types) ? m.types : undefined,
    configurable: !!(m.behaviorHints && (m.behaviorHints.configurable || m.behaviorHints.configurationRequired)),
  };
}
