// Source de plage du lien débridé : en-têtes Range, tailles, refus des réponses sans plage, erreurs sans URL.
import { describe, expect, it, vi } from 'vitest';
import type { HttpFn, HttpRequest, HttpResponse } from '../sources/debrid/http';
import { RelayError } from './protocol';
import { parseContentRange, urlRangeSource } from './sources';

const LINK = 'https://example.invalid/file/abc.mkv?token=SECRET';

function reply(status: number, headers: Record<string, string> = {}, body = new Uint8Array(0)): HttpResponse {
  return { status, headers, body };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return (err as RelayError).code;
  }
}

describe('parseContentRange', () => {
  it('lit bornes et total, total inconnu accepté, format invalide refusé', () => {
    expect(parseContentRange('bytes 100-199/1000')).toEqual({ start: 100, end: 199, total: 1000 });
    expect(parseContentRange('bytes 0-0/*')).toEqual({ start: 0, end: 0, total: null });
    expect(parseContentRange('items 0-1/2')).toBeNull();
    expect(parseContentRange(undefined)).toBeNull();
  });
});

describe('urlRangeSource', () => {
  it('lecture : en-tête Range exact, réponse 206 rendue telle quelle', async () => {
    const seen: HttpRequest[] = [];
    const http: HttpFn = async (req) => {
      seen.push(req);
      return reply(206, { 'content-range': 'bytes 100-199/1000' }, new Uint8Array(100).fill(3));
    };
    const out = await urlRangeSource({ url: LINK, http }).read(100, 200);
    expect(seen[0]?.headers?.Range).toBe('bytes=100-199');
    expect(seen[0]?.method).toBe('GET');
    expect(out.byteLength).toBe(100);
    expect(out[0]).toBe(3);
  });

  it('taille : Content-Length par HEAD, mise en cache', async () => {
    const methods: string[] = [];
    const http: HttpFn = async (req) => {
      methods.push(req.method ?? 'GET');
      return reply(200, { 'content-length': '4096' });
    };
    const src = urlRangeSource({ url: LINK, http });
    expect(await src.size()).toBe(4096);
    expect(await src.size()).toBe(4096);
    expect(methods).toEqual(['HEAD']);
  });

  it('taille de repli : total de Content-Range pour bytes=0-0 si pas de Content-Length', async () => {
    const http: HttpFn = async (req) => (req.method === 'HEAD'
      ? reply(200, {})
      : reply(206, { 'content-range': 'bytes 0-0/777' }, new Uint8Array(1)));
    expect(await urlRangeSource({ url: LINK, http }).size()).toBe(777);
  });

  it('serveur qui ignore Range (200) : refusé, pas de téléchargement en entier', async () => {
    const http: HttpFn = async () => reply(200, { 'content-length': '10' }, new Uint8Array(10));
    expect(await codeOf(urlRangeSource({ url: LINK, http }).read(0, 5))).toBe('source');
  });

  it('plage incohérente (début ou longueur différents) : source', async () => {
    const wrongStart: HttpFn = async () => reply(206, { 'content-range': 'bytes 10-14/100' }, new Uint8Array(5));
    expect(await codeOf(urlRangeSource({ url: LINK, http: wrongStart }).read(0, 5))).toBe('source');
    const shortBody: HttpFn = async () => reply(206, { 'content-range': 'bytes 0-4/100' }, new Uint8Array(3));
    expect(await codeOf(urlRangeSource({ url: LINK, http: shortBody }).read(0, 5))).toBe('source');
  });

  it('erreur de transport : code source, le message ne contient ni l’URL ni le jeton', async () => {
    const http: HttpFn = async () => {
      throw new Error(`échec sur ${LINK}`);
    };
    const err = await urlRangeSource({ url: LINK, http }).read(0, 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('source');
    expect((err as Error).message).not.toMatch(/example|token|SECRET|https?:/);
  });

  it('annulation : code cancelled quand le signal est coupé', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const http: HttpFn = async () => {
      throw new Error('aborted');
    };
    expect(await codeOf(urlRangeSource({ url: LINK, http }).read(0, 5, ctl.signal))).toBe('cancelled');
  });

  it('lien direct d’addon en http accepté ; autre schéma ou plage vide : refusés sans écho de l’URL', () => {
    const http: HttpFn = async () => reply(206);
    expect(() => urlRangeSource({ url: 'http://example.invalid/x?token=SECRET', http })).not.toThrow();
    const err = (() => {
      try {
        urlRangeSource({ url: 'ftp://example.invalid/x?token=SECRET' });
        return null;
      } catch (e) {
        return e as RelayError;
      }
    })();
    expect(err?.code).toBe('bad_request');
    expect(err?.message).not.toMatch(/SECRET|example/);
    return expect(codeOf(urlRangeSource({ url: LINK, http }).read(5, 5))).resolves.toBe('bad_request');
  });

  it('navigateur : échec de lecture (CORS refusé par la source) = unshareable, sans écho de l’URL', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch ' + LINK); });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const src = urlRangeSource({ url: LINK });
      const err = await src.size().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayError);
      expect((err as RelayError).code).toBe('unshareable');
      expect((err as Error).message).not.toMatch(/example|token|SECRET|https?:/);
      expect(await codeOf(urlRangeSource({ url: LINK }).read(0, 5))).toBe('unshareable');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
