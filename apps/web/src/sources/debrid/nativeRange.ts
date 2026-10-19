/* Lecture de plages par le pont `native-range` de la coque Windows (laststream-shell-ng) : morceaux bornés, le fichier n'est jamais
 * chargé d'un coup. Repli sur `native-http` (voir http.ts) quand la coque n'annonce pas la commande.
 *
 * Protocole (identifiants fournis par la page ; la réponse finale arrive toujours en dernier) :
 *  - `native-range-caps` → `native-range-caps` `{version: 1, maxChunk, maxRange}` : sonde, mémorisée par transport (1 s au plus) ;
 *  - `native-range` `{id, url, headers: {Range}, timeoutMs}` → `native-range-chunk` `{id, seq, bodyBase64, last}` (seq depuis 0),
 *    puis `native-range-response` `{id, status, contentRange, contentLength, headers, chunks}` ou `{id, error, status?}` ;
 *  - `native-range-cancel` `{id}` : arrête la lecture.
 * La coque accepte au plus `maxRange` octets par requête : une plage plus grande est lue ici en requêtes successives.
 * Une erreur jette tout (aucun morceau partiel rendu). Rien n'est journalisé : ni URL, ni corps. */

import { connectShell, type ShellTransport } from '../../player/shell';
import type { HttpFn, HttpRequest, HttpResponse } from './http';
import { DebridError } from './types';

export interface NativeRangeCaps {
  /** Taille maximale d'un morceau, en caractères base64. */
  maxChunk: number;
  /** Taille maximale d'une plage par requête, en octets. */
  maxRange: number;
}

export interface ShellRangeOptions {
  /** Transport de la coque (défaut : `connectShell`). */
  getShell?: () => Promise<ShellTransport | null>;
  /** Délai de la sonde de capacités (défaut : 1 s). */
  capsTimeoutMs?: number;
}

const CAPS_TIMEOUT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Marge du chien de garde de la page, au-delà du délai transmis à la coque. */
const WATCHDOG_MARGIN_MS = 5_000;

type Listener = (payload: unknown) => void;

interface Pending {
  chunk: Listener;
  final: Listener;
}

interface Channel {
  pending: Map<number, Pending>;
  caps: Promise<NativeRangeCaps | null> | null;
  onCaps: Listener | null;
}

interface FinalReply {
  error?: unknown;
  status?: unknown;
  headers?: unknown;
  contentRange?: unknown;
  contentLength?: unknown;
  chunks?: unknown;
}

/** Identifiants de requête uniques pour toute la page : la coque les garde tous dans un même registre. */
let nextId = 1;
const channels = new WeakMap<ShellTransport, Channel>();

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Écouteurs posés une seule fois par transport (un transport ne se désabonne pas). */
function channelOf(t: ShellTransport): Channel {
  const known = channels.get(t);
  if (known) return known;
  const ch: Channel = { pending: new Map(), caps: null, onCaps: null };
  const route = (payload: unknown, pick: (p: Pending) => Listener): void => {
    const id = (payload as { id?: unknown } | null)?.id;
    const p = typeof id === 'number' ? ch.pending.get(id) : undefined;
    if (p) pick(p)(payload);
  };
  t.on('native-range-caps', (payload) => { ch.onCaps?.(payload); });
  t.on('native-range-chunk', (payload) => { route(payload, (p) => p.chunk); });
  t.on('native-range-response', (payload) => { route(payload, (p) => p.final); });
  channels.set(t, ch);
  return ch;
}

function parseCaps(payload: unknown): NativeRangeCaps | null {
  const c = payload as { version?: unknown; maxChunk?: unknown; maxRange?: unknown } | null;
  if (!c || c.version !== 1 || !posInt(c.maxChunk) || !posInt(c.maxRange)) return null;
  return { maxChunk: c.maxChunk, maxRange: c.maxRange };
}

/** Capacités annoncées par la coque, sondées une fois par transport ; null si la coque ne répond pas à temps ou ne les annonce pas. */
export function nativeRangeCaps(t: ShellTransport, timeoutMs = CAPS_TIMEOUT_MS): Promise<NativeRangeCaps | null> {
  const ch = channelOf(t);
  if (ch.caps) return ch.caps;
  const probe = new Promise<NativeRangeCaps | null>((resolve) => {
    const timer = setTimeout(() => { ch.onCaps = null; resolve(null); }, timeoutMs);
    ch.onCaps = (payload) => { clearTimeout(timer); ch.onCaps = null; resolve(parseCaps(payload)); };
    try { t.send('native-range-caps'); } catch { /* transport fermé : la sonde expire */ }
  });
  ch.caps = probe;
  return probe;
}

/** En-tête `Range` d'une requête GET sans corps ; undefined pour toute autre requête (repli). */
function rangeHeader(req: HttpRequest): string | undefined {
  if ((req.method ?? 'GET') !== 'GET' || req.body !== undefined) return undefined;
  return Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'range')?.[1];
}

/** `bytes=a-b` strict, comme la coque ; sinon null (la requête part telle quelle et la coque la refuse). */
function parseRange(raw: string): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec(raw);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return Number.isSafeInteger(end) && start <= end ? { start, end } : null;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Code d'erreur de la coque → erreur de transport (même nature que `native-http`). */
function rangeError(code: string): DebridError {
  if (code === 'timeout' || code === 'network') return new DebridError(code, 'transient');
  if (code === 'cancelled') return new DebridError('network', 'transient');
  return new DebridError(code, 'unsupported');
}

/** Réponse finale : morceaux rangés par `seq` ; jette (sans résultat partiel) si le décompte ou la taille ne concordent pas. */
function assemble(f: FinalReply, parts: Map<number, Uint8Array>): HttpResponse {
  if (typeof f.error === 'string') throw rangeError(f.error);
  const count = f.chunks;
  if (!isSeq(count) || count !== parts.size) throw new DebridError('bad_chunk', 'unsupported');
  const ordered: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const part = parts.get(i);
    if (!part) throw new DebridError('bad_chunk', 'unsupported');
    ordered.push(part);
  }
  const body = concat(ordered);
  if (typeof f.contentLength === 'number' && f.contentLength !== body.byteLength) throw new DebridError('bad_chunk', 'unsupported');
  const headers: Record<string, string> = {};
  if (f.headers && typeof f.headers === 'object') {
    for (const [k, v] of Object.entries(f.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
  }
  if (typeof f.contentRange === 'string') headers['content-range'] = f.contentRange;
  headers['content-length'] = String(body.byteLength);
  return { status: typeof f.status === 'number' ? f.status : 0, headers, body };
}

/** Une requête `native-range` (au plus `caps.maxRange` octets) ; `limit` borne le corps reçu. Abandon : `native-range-cancel`. */
function requestOnce(t: ShellTransport, caps: NativeRangeCaps, req: HttpRequest, range: string, limit: number): Promise<HttpResponse> {
  const ch = channelOf(t);
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<HttpResponse>((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new DebridError('aborted', 'transient'));
      return;
    }
    const id = nextId;
    nextId += 1;
    const parts = new Map<number, Uint8Array>();
    let received = 0;
    let settled = false;

    const settle = (done: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      ch.pending.delete(id);
      done();
    };
    // Arrêt demandé par la page (abandon, délai, morceau invalide) : la coque cesse la lecture, puis on rejette.
    const stop = (err: DebridError): void => {
      if (settled) return;
      try { t.send('native-range-cancel', { id }); } catch { /* transport fermé */ }
      settle(() => reject(err));
    };
    const onAbort = (): void => stop(new DebridError('aborted', 'transient'));
    const timer = setTimeout(() => stop(new DebridError('timeout', 'transient')), timeoutMs + WATCHDOG_MARGIN_MS);
    req.signal?.addEventListener('abort', onAbort, { once: true });

    ch.pending.set(id, {
      chunk: (payload) => {
        const c = payload as { seq?: unknown; bodyBase64?: unknown } | null;
        const seq = c?.seq;
        const b64 = c?.bodyBase64;
        if (!isSeq(seq) || typeof b64 !== 'string' || b64.length > caps.maxChunk || parts.has(seq)) {
          stop(new DebridError('bad_chunk', 'unsupported'));
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = b64ToBytes(b64);
        } catch {
          stop(new DebridError('bad_chunk', 'unsupported'));
          return;
        }
        received += bytes.byteLength;
        if (received > limit) {
          stop(new DebridError('too_large', 'unsupported'));
          return;
        }
        parts.set(seq, bytes);
      },
      final: (payload) => {
        try {
          const out = assemble((payload ?? {}) as FinalReply, parts);
          settle(() => resolve(out));
        } catch (err) {
          settle(() => reject(err));
        }
      },
    });
    try {
      t.send('native-range', { id, url: req.url, headers: { Range: range }, timeoutMs });
    } catch {
      settle(() => reject(new DebridError('network', 'transient')));
    }
  });
}

/** Lit la plage ; au-delà de `maxRange`, plusieurs requêtes successives assemblées (une erreur jette tout). */
async function readRange(t: ShellTransport, caps: NativeRangeCaps, req: HttpRequest, range: string): Promise<HttpResponse> {
  const parsed = parseRange(range);
  if (!parsed) return requestOnce(t, caps, req, range, Number.MAX_SAFE_INTEGER);
  const size = parsed.end - parsed.start + 1;
  if (size <= caps.maxRange) return requestOnce(t, caps, req, range, size);

  const bodies: Uint8Array[] = [];
  let total = '*';
  for (let s = parsed.start; s <= parsed.end; s += caps.maxRange) {
    if (req.signal?.aborted) throw new DebridError('aborted', 'transient');
    const e = Math.min(parsed.end, s + caps.maxRange - 1);
    const part = await requestOnce(t, caps, req, `bytes=${s}-${e}`, e - s + 1);
    if (part.status !== 206 || part.body.byteLength !== e - s + 1) throw new DebridError('range_unsupported', 'unsupported');
    if (s === parsed.start) total = /\/(\d+)$/.exec(part.headers['content-range'] ?? '')?.[1] ?? '*';
    bodies.push(part.body);
  }
  const body = concat(bodies);
  return {
    status: 206,
    headers: { 'content-range': `bytes ${parsed.start}-${parsed.end}/${total}`, 'content-length': String(body.byteLength) },
    body,
  };
}

/**
 * Transport HTTP de la coque : une requête GET avec `Range` passe par `native-range` quand la coque annonce la commande ;
 * tout le reste (autre méthode, sans plage, coque sans `native-range`, sonde sans réponse) passe par `fallback` (`native-http`).
 */
export function shellRangeHttp(fallback: HttpFn, opts: ShellRangeOptions = {}): HttpFn {
  const getShell = opts.getShell ?? (() => connectShell());
  return async (req) => {
    const range = rangeHeader(req);
    if (!range) return fallback(req);
    const t = await getShell();
    if (!t) return fallback(req);
    const caps = await nativeRangeCaps(t, opts.capsTimeoutMs);
    if (!caps) return fallback(req);
    return readRange(t, caps, req, range);
  };
}
