/* Transport HTTP des débrideurs, toujours depuis l'appareil (IP résidentielle).
 *
 * Trois voies, essayées selon le fournisseur :
 *  - `fetch` du navigateur : AllDebrid répond avec CORS (Access-Control-Allow-Origin reflète l'origine, en-tête Authorization accepté) ;
 *  - pont de la coque Windows (laststream-shell-ng, message `native-http` → `native-http-response`), limité aux domaines des débrideurs ;
 *  - CapacitorHttp (natif Android) : hors WebView, donc sans CORS.
 * TorBox (liste d'origines autorisées) et Real-Debrid (aucun en-tête CORS) exigent le pont natif ; le web ne lit alors que les liens directs.
 * Rien n'est journalisé : ni URL, ni clé, ni corps. */

import { connectShell, isShellEnvironment, type ShellTransport } from '../../player/shell';
import { DebridError } from './types';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  /** Corps texte : formulaire urlencodé ou JSON (selon Content-Type). */
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** En-têtes en minuscules. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

const DEFAULT_TIMEOUT_MS = 20_000;

/** Domaines que l'appareil peut contacter (mêmes que la liste de la coque Windows) : API et fichiers des débrideurs. */
const EXACT_HOSTS = ['api.alldebrid.com', 'api.torbox.app'];
const SUFFIXES = ['.debrid.it', '.alldebrid.com', '.torbox.app', '.real-debrid.com'];

export function debridHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return false;
  return EXACT_HOSTS.includes(host) || SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** URL https d'un domaine de débrideur, sans identifiants ni port atypique ; sinon null. */
export function parseDebridUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  return debridHostAllowed(url.hostname) ? url : null;
}

export const textOf = (res: HttpResponse): string => new TextDecoder().decode(res.body);

export function jsonOf(res: HttpResponse): unknown {
  try { return JSON.parse(textOf(res)); } catch { return undefined; }
}

const lowerKeys = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]));

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Voie navigateur ----------

export function browserFetchHttp(fetchImpl: typeof fetch = (i, n) => fetch(i, n)): HttpFn {
  return async (req) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => ctl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        signal: ctl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
    } catch (err) {
      if (req.signal?.aborted) throw new DebridError('aborted', 'transient');
      throw new DebridError(ctl.signal.aborted ? 'timeout' : 'network', 'transient');
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  };
}

// ---------- Pont de la coque Windows ----------

interface NativeReply {
  requestId: number;
  status?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
}

const shellState = new WeakMap<ShellTransport, { next: number; pending: Map<number, (r: NativeReply) => void> }>();

function shellChannel(t: ShellTransport): { next: number; pending: Map<number, (r: NativeReply) => void> } {
  let s = shellState.get(t);
  if (!s) {
    s = { next: 1, pending: new Map() };
    const state = s;
    t.on('native-http-response', (payload) => {
      const r = payload as NativeReply | null;
      const done = r && typeof r.requestId === 'number' ? state.pending.get(r.requestId) : undefined;
      if (done && r) { state.pending.delete(r.requestId); done(r); }
    });
    shellState.set(t, s);
  }
  return s;
}

const utf8ToB64 = (text: string): string => {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Commande IPC dédiée aux addons Stremio (URL `https://…/stream/<type>/<id>.json` ou `/manifest.json`, sans query), distincte de `native-http` réservée aux débrideurs. */
export const NATIVE_ADDON_COMMAND = 'native-addon-http';

export function shellHttp(getShell: () => Promise<ShellTransport | null> = () => connectShell(), command: 'native-http' | typeof NATIVE_ADDON_COMMAND = 'native-http'): HttpFn {
  return async (req) => {
    const t = await getShell();
    if (!t) throw new DebridError('network', 'transient');
    const ch = shellChannel(t);
    const id = ch.next++;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const reply = await new Promise<NativeReply>((resolve, reject) => {
      const timer = setTimeout(() => { ch.pending.delete(id); reject(new DebridError('timeout', 'transient')); }, timeoutMs + 5_000);
      const onAbort = (): void => { clearTimeout(timer); ch.pending.delete(id); reject(new DebridError('aborted', 'transient')); };
      if (req.signal?.aborted) { onAbort(); return; }
      req.signal?.addEventListener('abort', onAbort, { once: true });
      ch.pending.set(id, (r) => { clearTimeout(timer); req.signal?.removeEventListener('abort', onAbort); resolve(r); });
      if (command === NATIVE_ADDON_COMMAND) t.send(command, { requestId: id, url: req.url, method: 'GET', headers: { Accept: req.headers?.Accept ?? 'application/json' } });
      else t.send(command, { requestId: id, url: req.url, method: req.method ?? 'GET', headers: req.headers ?? {}, bodyBase64: req.body === undefined ? undefined : utf8ToB64(req.body), timeoutMs });
    });
    if (reply.error) throw new DebridError(reply.error === 'host_not_allowed' ? 'host_not_allowed' : reply.error, reply.error === 'host_not_allowed' ? 'unsupported' : 'transient');
    return { status: reply.status ?? 0, headers: lowerKeys(reply.headers ?? {}), body: b64ToBytes(reply.bodyBase64 ?? '') };
  };
}

// ---------- CapacitorHttp (Android) ----------

interface CapacitorLike {
  isNativePlatform?: () => boolean;
}

export const capacitorNative = (): boolean => !!(globalThis as { Capacitor?: CapacitorLike }).Capacitor?.isNativePlatform?.();

/** Corps urlencodé → objet (CapacitorHttp réencode lui-même). Les clés répétées ne passent pas : refusées. */
function formToObject(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    if (k in out) throw new DebridError('unsupported_body', 'unsupported');
    out[k] = v;
  }
  return out;
}

export function capacitorHttp(): HttpFn {
  return async (req) => {
    const { CapacitorHttp } = await import('@capacitor/core');
    const headers = { ...(req.headers ?? {}) };
    const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    let data: unknown;
    if (req.body !== undefined) {
      if (/json/i.test(type)) { try { data = JSON.parse(req.body); } catch { data = req.body; } }
      else if (/urlencoded/i.test(type)) data = formToObject(req.body);
      else data = req.body;
    }
    const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const res = await Promise.race([
        CapacitorHttp.request({ url: req.url, method: req.method ?? 'GET', headers, data, responseType: 'arraybuffer', connectTimeout: timeout, readTimeout: timeout, disableRedirects: false }),
        new Promise<never>((_, reject) => {
          if (req.signal?.aborted) reject(new DebridError('aborted', 'transient'));
          req.signal?.addEventListener('abort', () => reject(new DebridError('aborted', 'transient')), { once: true });
        }),
      ]);
      const raw = res.data as unknown;
      const body = typeof raw === 'string' ? b64ToBytes(raw) : new Uint8Array(0);
      return { status: res.status, headers: lowerKeys((res.headers ?? {}) as Record<string, string>), body };
    } catch (err) {
      if (err instanceof DebridError) throw err;
      throw new DebridError('network', 'transient');
    }
  };
}

// ---------- Choix de la voie ----------

export type NativeKind = 'shell' | 'capacitor' | null;

export function nativeKind(): NativeKind {
  if (isShellEnvironment()) return 'shell';
  if (capacitorNative()) return 'capacitor';
  return null;
}

export interface TransportDeps {
  fetchHttp?: HttpFn;
  nativeHttp?: HttpFn | null;
}

function defaultNative(): HttpFn | null {
  const kind = nativeKind();
  return kind === 'shell' ? shellHttp() : kind === 'capacitor' ? capacitorHttp() : null;
}

/**
 * `fetch-first` (AllDebrid, fichiers) : navigateur, puis pont natif si le navigateur échoue (réseau/CORS) ;
 * `native-first` (TorBox, Real-Debrid) : pont natif ; sans pont (web), `fetch` en dernier recours (échouera sur CORS).
 * Seule une erreur de transport (pas un statut HTTP) fait passer à la voie suivante.
 */
export function createHttp(prefer: 'fetch-first' | 'native-first', deps: TransportDeps = {}): HttpFn {
  const fetchHttp = deps.fetchHttp ?? browserFetchHttp();
  const native = deps.nativeHttp === undefined ? defaultNative() : deps.nativeHttp;
  const chain = native === null ? [fetchHttp] : prefer === 'native-first' ? [native, fetchHttp] : [fetchHttp, native];
  return async (req) => {
    if (!parseDebridUrl(req.url)) throw new DebridError('host_not_allowed', 'unsupported');
    let last: unknown;
    for (const hop of chain) {
      try {
        return await hop(req);
      } catch (err) {
        last = err;
        if (!(err instanceof DebridError) || err.kind !== 'transient' || err.code === 'aborted') throw err;
      }
    }
    throw last;
  };
}

/** Les appels de ce fournisseur exigent-ils un pont natif (CORS fermé) ? Vrai sur le web seul : fournisseur inutilisable. */
export function webBlocked(needsNative: boolean, native: NativeKind = nativeKind()): boolean {
  return needsNative && native === null;
}

// ---------- Lecture de plages (miniatures) ----------

export interface RangeReply { status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }
export type RangeFetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<RangeReply>;

/**
 * Lecture de plages directement chez l'hébergeur débridé (même IP que la lecture). Le navigateur d'abord ; si le fichier est servi
 * sans CORS, le pont natif (Windows IPC, CapacitorHttp) prend le relais pour cet hôte ; sinon l'appel échoue (pas de miniatures).
 * Jamais de relais par un serveur.
 */
export function createRangeFetch(deps: TransportDeps = {}): RangeFetchFn {
  const fetchHttp = deps.fetchHttp ?? browserFetchHttp();
  const native = deps.nativeHttp === undefined ? defaultNative() : deps.nativeHttp;
  const needsNative = new Set<string>();
  return async (url, init = {}) => {
    const parsed = parseDebridUrl(url);
    if (!parsed) throw new DebridError('host_not_allowed', 'unsupported');
    const req: HttpRequest = { url, method: 'GET', headers: init.headers, signal: init.signal, timeoutMs: 30_000 };
    let res: HttpResponse;
    if (needsNative.has(parsed.hostname) && native) res = await native(req);
    else {
      try {
        res = await fetchHttp(req);
      } catch (err) {
        if (!native || !(err instanceof DebridError) || err.kind !== 'transient' || err.code === 'aborted') throw err;
        needsNative.add(parsed.hostname);
        res = await native(req);
      }
    }
    return {
      status: res.status,
      headers: { get: (name: string) => res.headers[name.toLowerCase()] ?? null },
      arrayBuffer: () => Promise.resolve(res.body.buffer.slice(res.body.byteOffset, res.body.byteOffset + res.body.byteLength) as ArrayBuffer),
    };
  };
}
