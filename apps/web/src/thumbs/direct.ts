/* Lecture de plages directement depuis l'appareil (en-tête Range) : chez l'hébergeur débridé, avec l'IP de la lecture, ou sur un serveur local. */

import type { FetchRange, RangeResponse } from './bytes';

export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Pick<Response, 'status' | 'headers' | 'arrayBuffer'>>;

/** La source refuse la lecture (401, 403 : lien expiré) : l'appelant demande une nouvelle source. */
export class RangeAuthError extends Error {
  constructor() { super('range_auth'); }
}

/** Taille totale lue dans Content-Range (`bytes 0-99/1234`, ou `bytes étoile/1234` sur un 416). */
export function totalFromContentRange(value: string | null): number | null {
  const m = value === null ? null : /\/(\d+)\s*$/.exec(value);
  return m === null ? null : Number(m[1]);
}

async function toResult(res: Pick<Response, 'status' | 'headers' | 'arrayBuffer'>): Promise<RangeResponse> {
  if (res.status === 416) return { data: new Uint8Array(0), total: totalFromContentRange(res.headers.get('content-range')) };
  if (res.status === 401 || res.status === 403) throw new RangeAuthError();
  if (res.status !== 206) throw new Error(`range_http_${res.status}`);
  return { data: new Uint8Array(await res.arrayBuffer()), total: totalFromContentRange(res.headers.get('content-range')) };
}

/** Lecture directe avec l'en-tête Range (serveur local ou source qui envoie du CORS). */
export function directFetchRange(url: string, fetchFn: FetchFn): FetchRange {
  return async (start, end, signal) => toResult(await fetchFn(url, { signal, headers: { Range: `bytes=${start}-${end}` } }));
}
