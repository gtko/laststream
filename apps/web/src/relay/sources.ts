/* RangeSource de l'hôte : lit des plages du lien débridé (URL https) avec un en-tête `Range`, depuis l'appareil de l'hôte.
 *  - web : `fetch` du navigateur (CORS requis chez l'hébergeur : sinon erreur `source`) ;
 *  - Windows : pont `native-http` de la coque (liste de domaines débrideurs côté coque ; réponse complète en base64, donc
 *    les plages restent bornées à 8 Mo) ;
 *  - Android : CapacitorHttp (responseType arraybuffer, hors WebView).
 * Le transport est choisi comme pour les débrideurs (`nativeKind`). Limite : un serveur qui ignore `Range` (réponse 200)
 * est refusé plutôt que téléchargé en entier. Aucune URL dans les erreurs, aucun journal. */

import { browserFetchHttp, capacitorHttp, nativeKind, shellHttp, type HttpFn, type HttpRequest, type HttpResponse, type NativeKind } from '../sources/debrid/http';
import type { RangeSource } from './host';
import { RelayError } from './protocol';

const TIMEOUT_MS = 30_000;

/** Transport HTTP de la plateforme courante (même détection que les débrideurs). */
export function rangeTransport(kind: NativeKind = nativeKind()): HttpFn {
  if (kind === 'shell') return shellHttp();
  if (kind === 'capacitor') return capacitorHttp();
  return browserFetchHttp();
}

export interface UrlSourceOptions {
  /** Lien débridé (https). Jamais journalisé ni repris dans une erreur. */
  url: string;
  /** Transport (défaut : selon la plateforme). */
  http?: HttpFn;
  mime?: string;
}

/** `Content-Range: bytes a-b/total` → bornes et taille totale. */
export function parseContentRange(raw: string | undefined): { start: number; end: number; total: number | null } | null {
  const m = raw ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(raw.trim()) : null;
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/** Appel HTTP ; toute erreur de transport devient un `RelayError` sans contenu. */
async function call(http: HttpFn, req: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(req);
  } catch {
    throw new RelayError(req.signal?.aborted ? 'cancelled' : 'source');
  }
}

function sourceUrlOk(url: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(url);
}

/** Source de plages pour un lien débridé. Rejette sans écho les URL qui ne sont pas en https. */
export function urlRangeSource(opts: UrlSourceOptions): RangeSource {
  if (!sourceUrlOk(opts.url)) throw new RelayError('bad_request');
  const http = opts.http ?? rangeTransport();
  const { url } = opts;
  let sizeP: Promise<number> | null = null;

  const probeSize = async (): Promise<number> => {
    const head = await call(http, { url, method: 'HEAD', timeoutMs: TIMEOUT_MS });
    const len = head.headers['content-length'];
    if (head.status >= 200 && head.status < 300 && typeof len === 'string' && /^\d+$/.test(len)) return Number(len);
    // Pas de Content-Length : la taille vient de Content-Range d'une plage d'un octet.
    const probe = await call(http, { url, method: 'GET', headers: { Range: 'bytes=0-0' }, timeoutMs: TIMEOUT_MS });
    const total = probe.status === 206 ? parseContentRange(probe.headers['content-range'])?.total : null;
    if (typeof total !== 'number' || !Number.isSafeInteger(total)) throw new RelayError('source');
    return total;
  };

  return {
    mime: opts.mime,
    size(): Promise<number> {
      if (!sizeP) {
        sizeP = probeSize().catch((err: unknown) => {
          sizeP = null;
          throw err;
        });
      }
      return sizeP;
    },
    async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new RelayError('bad_request');
      const res = await call(http, {
        url,
        method: 'GET',
        headers: { Range: `bytes=${start}-${end - 1}` },
        timeoutMs: TIMEOUT_MS,
        signal,
      });
      if (res.status !== 206) throw new RelayError('source');
      const cr = res.headers['content-range'];
      if (cr !== undefined) {
        const parsed = parseContentRange(cr);
        if (!parsed || parsed.start !== start) throw new RelayError('source');
      }
      if (!res.body || res.body.byteLength !== end - start) throw new RelayError('source');
      return res.body;
    },
  };
}
