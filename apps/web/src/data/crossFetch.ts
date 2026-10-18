import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * `fetch` des appels à lastAddon. L'application Android charge son interface depuis le serveur Laststream (https) : vers
 * ce serveur la requête est de même origine, donc un `fetch` ordinaire. Vers un serveur perso d'une autre origine (PC du
 * réseau local en http, autre domaine), la WebView bloquerait le contenu mixte et exigerait du CORS : la requête part alors
 * du code natif (CapacitorHttp), qui n'a ni l'un ni l'autre.
 */
export function needsNativeHttp(url: string): boolean {
  try {
    if (!Capacitor.isNativePlatform() || typeof location === 'undefined') return false;
    const u = new URL(url, location.href);
    return /^https?:$/.test(u.protocol) && u.origin !== location.origin;
  } catch {
    return false;
  }
}

const NATIVE_TIMEOUT_MS = 15_000;

function abortError(): Error {
  return Object.assign(new Error('Requête annulée'), { name: 'AbortError' });
}

export async function appFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!needsNativeHttp(url)) return fetch(url, init);
  if (init.signal?.aborted) throw abortError();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  let data: unknown;
  if (typeof init.body === 'string') {
    try { data = JSON.parse(init.body); } catch { data = init.body; }
  }
  const call = CapacitorHttp.request({
    url, method: (init.method ?? 'GET').toUpperCase(), headers, data,
    connectTimeout: NATIVE_TIMEOUT_MS, readTimeout: NATIVE_TIMEOUT_MS, responseType: 'text',
  });
  const aborted = new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(abortError()), { once: true }));
  const r = await Promise.race([call, aborted]);
  const text = r.status === 204 || r.status === 205 || r.status === 304 ? null : typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? null);
  const out = new Headers();
  Object.entries(r.headers ?? {}).forEach(([k, v]) => { try { out.set(k, String(v)); } catch { /* en-tête invalide : ignoré */ } });
  if (!out.has('content-type')) out.set('content-type', 'application/json');
  return new Response(text, { status: r.status, headers: out });
}
