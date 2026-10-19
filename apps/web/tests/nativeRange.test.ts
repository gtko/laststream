import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebviewTransport, resetShell, type ShellWindow } from '../src/player/shell';
import { createRangeFetch, type HttpFn, type HttpRequest, type HttpResponse } from '../src/sources/debrid/http';
import { shellRangeHttp } from '../src/sources/debrid/nativeRange';
import { DebridError } from '../src/sources/debrid/types';

/* Pont « native-range » simulé : faux `window.chrome.webview` qui parle le protocole JSON de la coque (comme tests/shell.test.ts).
 * Aucune URL réelle : le débrideur est un domaine fictif, le fichier est une suite d'octets. */

const URL_DEBRID = 'https://example.debrid.it/f';
const FILE = Uint8Array.from({ length: 100 }, (_, i) => i);
const CAPS = { version: 1, maxChunk: 1_048_576, maxRange: 8_388_608 };
const HANDSHAKE = { id: 0, object: 'transport', type: 3, data: { transport: { properties: [] } } };

interface Sent { event: string; args: Record<string, unknown> }
type Reply = (event: string, payload: unknown) => void;

/** Faux WebView2 : chaque message invoke de la page est enregistré puis joué par `onInvoke` (rôle de la coque). */
function fakeWebview(onInvoke: (s: Sent, reply: Reply) => void) {
  const listeners: Array<(ev: { data: unknown }) => void> = [];
  const sent: Sent[] = [];
  const reply: Reply = (event, payload) => {
    queueMicrotask(() => listeners.forEach((fn) => fn({ data: { type: 1, args: [event, payload] } })));
  };
  const webview = {
    postMessage(message: string): void {
      const msg = JSON.parse(message) as { type: number; args?: unknown[] };
      if (msg.type === 3) {
        queueMicrotask(() => listeners.forEach((fn) => fn({ data: HANDSHAKE })));
        return;
      }
      const [event, args = {}] = (msg.args ?? []) as [string, Record<string, unknown>?];
      const s: Sent = { event, args };
      sent.push(s);
      onInvoke(s, reply);
    },
    addEventListener(_type: 'message', fn: (ev: { data: unknown }) => void): void { listeners.push(fn); },
  };
  return { webview, sent, reply };
}

/** Transport de la coque issu du faux WebView2 (poignée de main réelle). */
async function shellOf(webview: NonNullable<NonNullable<ShellWindow['chrome']>['webview']>) {
  const t = await createWebviewTransport({ chrome: { webview } }, 500);
  if (!t) throw new Error('poignée de main absente');
  return t;
}

/** Joue `native-range` : morceaux de `chunk` octets (ordre inverse si `reverse`), puis la réponse finale, comme la coque. */
function streamRange(s: Sent, reply: Reply, opts: { chunk?: number; reverse?: boolean } = {}): void {
  const id = s.args.id as number;
  const m = /^bytes=(\d+)-(\d+)$/.exec((s.args.headers as { Range: string }).Range);
  if (!m) {
    reply('native-range-response', { id, error: 'bad_range' });
    return;
  }
  const a = Number(m[1]);
  const b = Math.min(Number(m[2]), FILE.length - 1);
  const step = opts.chunk ?? 4;
  const chunks: Record<string, unknown>[] = [];
  for (let off = a; off <= b; off += step) {
    const slice = FILE.subarray(off, Math.min(off + step, b + 1));
    chunks.push({ id, seq: chunks.length, bodyBase64: btoa(String.fromCharCode(...slice)), last: false });
  }
  if (opts.reverse) chunks.reverse();
  chunks.forEach((c) => reply('native-range-chunk', c));
  const contentRange = `bytes ${a}-${b}/${FILE.length}`;
  reply('native-range-response', { id, status: 206, contentRange, contentLength: b - a + 1, headers: { 'content-range': contentRange }, chunks: chunks.length });
}

/** Serveur par défaut : sonde → caps, lecture → `streamRange`. */
const serve = (caps: unknown = CAPS, opts: { chunk?: number; reverse?: boolean } = {}) => (s: Sent, reply: Reply): void => {
  if (s.event === 'native-range-caps') reply('native-range-caps', caps);
  else if (s.event === 'native-range') streamRange(s, reply, opts);
};

const rangeReq = (a: number, b: number): HttpRequest => ({ url: URL_DEBRID, method: 'GET', headers: { Range: `bytes=${a}-${b}` }, timeoutMs: 30_000 });
const makeFallback = () => vi.fn<HttpFn>(async () => ({ status: 200, headers: {}, body: new Uint8Array(0) }));
const bytesOf = (r: HttpResponse): number[] => Array.from(r.body);
const rangesSent = (sent: Sent[]): string[] => sent.filter((s) => s.event === 'native-range').map((s) => (s.args.headers as { Range: string }).Range);

afterEach(() => {
  resetShell();
  delete (window as unknown as { chrome?: unknown }).chrome;
});

describe('native-range : sonde, lecture, assemblage', () => {
  it('sonde les capacités une seule fois par transport puis lit les plages', async () => {
    const fw = fakeWebview(serve());
    const fallback = makeFallback();
    const t = await shellOf(fw.webview);
    const http = shellRangeHttp(fallback, { getShell: async () => t });
    const r1 = await http(rangeReq(0, 9));
    const r2 = await http(rangeReq(10, 19));
    expect(fw.sent.filter((s) => s.event === 'native-range-caps')).toHaveLength(1);
    expect(rangesSent(fw.sent)).toEqual(['bytes=0-9', 'bytes=10-19']);
    expect(r1.status).toBe(206);
    expect(bytesOf(r1)).toEqual(Array.from(FILE.subarray(0, 10)));
    expect(bytesOf(r2)).toEqual(Array.from(FILE.subarray(10, 20)));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('assemble les morceaux dans l ordre seq, même reçus à l envers', async () => {
    const fw = fakeWebview(serve(CAPS, { chunk: 3, reverse: true }));
    const r = await shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })(rangeReq(5, 20));
    expect(bytesOf(r)).toEqual(Array.from(FILE.subarray(5, 21)));
    expect(r.headers['content-range']).toBe('bytes 5-20/100');
    expect(r.headers['content-length']).toBe('16');
  });

  it('découpe une plage au-delà de maxRange en requêtes successives, corps assemblé', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', { ...CAPS, maxRange: 8 });
      else if (s.event === 'native-range') streamRange(s, reply);
    });
    const r = await shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 19));
    expect(rangesSent(fw.sent)).toEqual(['bytes=0-7', 'bytes=8-15', 'bytes=16-19']);
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-19/100');
    expect(bytesOf(r)).toEqual(Array.from(FILE.subarray(0, 20)));
  });

  it('une erreur sur un morceau de plage découpée jette tout et n envoie pas les suivants', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', { ...CAPS, maxRange: 8 });
      else if (s.event === 'native-range') {
        const start = (s.args.headers as { Range: string }).Range;
        if (start === 'bytes=8-15') reply('native-range-response', { id: s.args.id, error: 'range_unsupported', status: 200 });
        else streamRange(s, reply);
      }
    });
    await expect(shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 19))).rejects.toMatchObject({ code: 'range_unsupported', kind: 'unsupported' });
    expect(rangesSent(fw.sent)).toEqual(['bytes=0-7', 'bytes=8-15']);
  });

  it('annulation : signal abandonné → native-range-cancel avec le même id, rejet aborted, morceaux tardifs ignorés', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', CAPS);
      else if (s.event === 'native-range') reply('native-range-chunk', { id: s.args.id, seq: 0, bodyBase64: btoa('ab'), last: false });
    });
    const ctl = new AbortController();
    const p = shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })({ ...rangeReq(0, 1), signal: ctl.signal });
    await vi.waitFor(() => expect(fw.sent.some((s) => s.event === 'native-range')).toBe(true));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted', kind: 'transient' });
    const id = fw.sent.find((s) => s.event === 'native-range')?.args.id;
    expect(fw.sent.at(-1)).toEqual({ event: 'native-range-cancel', args: { id } });
    // Réponse finale tardive pour la requête abandonnée : ignorée, pas de second résultat.
    fw.reply('native-range-response', { id, status: 206, chunks: 1, contentLength: 2, headers: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fw.sent.filter((s) => s.event === 'native-range')).toHaveLength(1);
  });

  it('signal déjà abandonné : rejet immédiat, aucune requête envoyée', async () => {
    const fw = fakeWebview(serve());
    const ctl = new AbortController();
    ctl.abort();
    const http = shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) });
    await expect(http({ ...rangeReq(0, 9), signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(fw.sent.filter((s) => s.event === 'native-range')).toHaveLength(0);
  });
});

describe('native-range : repli native-http', () => {
  it('caps refusées (version inconnue) : repli, aucune native-range', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', { ...CAPS, version: 2 });
    });
    const fallback = makeFallback();
    await shellRangeHttp(fallback, { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 9));
    expect(fallback).toHaveBeenCalledOnce();
    expect(rangesSent(fw.sent)).toEqual([]);
  });

  it('coque muette (aucune réponse aux caps dans le délai) : repli', async () => {
    const fw = fakeWebview(() => undefined);
    const fallback = makeFallback();
    await shellRangeHttp(fallback, { getShell: async () => shellOf(fw.webview), capsTimeoutMs: 30 })(rangeReq(0, 9));
    expect(fallback).toHaveBeenCalledOnce();
    expect(rangesSent(fw.sent)).toEqual([]);
  });

  it('pas de coque (getShell null) : repli', async () => {
    const fallback = makeFallback();
    await shellRangeHttp(fallback, { getShell: async () => null })(rangeReq(0, 9));
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('requête sans Range, HEAD ou avec corps : repli direct, sonde non faite', async () => {
    const fw = fakeWebview(serve());
    const fallback = makeFallback();
    const http = shellRangeHttp(fallback, { getShell: async () => shellOf(fw.webview) });
    await http({ url: URL_DEBRID, method: 'GET' });
    await http({ url: URL_DEBRID, method: 'HEAD', headers: { Range: 'bytes=0-0' } });
    await http({ url: URL_DEBRID, method: 'POST', headers: { Range: 'bytes=0-0' }, body: 'x=1' });
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(fw.sent).toHaveLength(0);
  });
});

describe('native-range : erreurs de la coque', () => {
  it.each([
    ['range_unsupported', 'unsupported'],
    ['host_not_allowed', 'unsupported'],
    ['bad_status', 'unsupported'],
    ['too_large', 'unsupported'],
    ['redirect_not_allowed', 'unsupported'],
    ['timeout', 'transient'],
    ['network', 'transient'],
  ])('erreur %s : code et nature conservés, pas de repli', async (code, kind) => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', CAPS);
      else if (s.event === 'native-range') reply('native-range-response', { id: s.args.id, error: code, status: 200 });
    });
    const fallback = makeFallback();
    await expect(shellRangeHttp(fallback, { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 9))).rejects.toMatchObject({ code, kind });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('erreur après des morceaux : aucun résultat partiel', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', CAPS);
      else if (s.event === 'native-range') {
        reply('native-range-chunk', { id: s.args.id, seq: 0, bodyBase64: btoa('abcd'), last: false });
        reply('native-range-response', { id: s.args.id, error: 'network' });
      }
    });
    const err = await shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 3)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DebridError);
    expect(err).toMatchObject({ code: 'network', kind: 'transient' });
  });

  it('nombre de morceaux annoncé différent du reçu : erreur bad_chunk', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', CAPS);
      else if (s.event === 'native-range') {
        reply('native-range-chunk', { id: s.args.id, seq: 0, bodyBase64: btoa('abcd'), last: false });
        reply('native-range-response', { id: s.args.id, status: 206, contentLength: 4, headers: {}, chunks: 2 });
      }
    });
    await expect(shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 3))).rejects.toMatchObject({ code: 'bad_chunk', kind: 'unsupported' });
  });

  it('morceau hors protocole (seq manquant) : abandon et erreur bad_chunk', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', CAPS);
      else if (s.event === 'native-range') reply('native-range-chunk', { id: s.args.id, bodyBase64: btoa('abcd'), last: false });
    });
    await expect(shellRangeHttp(makeFallback(), { getShell: async () => shellOf(fw.webview) })(rangeReq(0, 3))).rejects.toMatchObject({ code: 'bad_chunk' });
    expect(fw.sent.at(-1)?.event).toBe('native-range-cancel');
  });
});

describe('createRangeFetch sur la coque Windows', () => {
  const netFail: HttpFn = () => Promise.reject(new DebridError('network', 'transient'));

  it('plage refusée par le navigateur : native-range, sans native-http', async () => {
    const fw = fakeWebview(serve());
    (window as unknown as ShellWindow).chrome = { webview: fw.webview };
    const range = createRangeFetch({ fetchHttp: netFail });
    const r = await range(URL_DEBRID, { headers: { Range: 'bytes=0-9' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 0-9/100');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(FILE.subarray(0, 10));
    expect(fw.sent.map((s) => s.event)).toEqual(['native-range-caps', 'native-range']);
  });

  it('caps refusées : repli sur native-http, même résultat', async () => {
    const fw = fakeWebview((s, reply) => {
      if (s.event === 'native-range-caps') reply('native-range-caps', { version: 2 });
      else if (s.event === 'native-http') {
        const m = /^bytes=(\d+)-(\d+)$/.exec((s.args.headers as { Range: string }).Range)!;
        const body = FILE.subarray(Number(m[1]), Number(m[2]) + 1);
        reply('native-http-response', { requestId: s.args.requestId, status: 206, headers: { 'content-range': `bytes ${m[1]}-${m[2]}/100` }, bodyBase64: btoa(String.fromCharCode(...body)) });
      }
    });
    (window as unknown as ShellWindow).chrome = { webview: fw.webview };
    const range = createRangeFetch({ fetchHttp: netFail });
    const r = await range(URL_DEBRID, { headers: { Range: 'bytes=0-9' } });
    expect(r.status).toBe(206);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(FILE.subarray(0, 10));
    expect(fw.sent.map((s) => s.event)).toEqual(['native-range-caps', 'native-http']);
  });
});
