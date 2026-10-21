import { describe, expect, it } from 'vitest';
import { fetchChunks } from '../../src/downloads/transfer';
import {
  DownloadError,
  MAX_FULL_BODY_BYTES,
  type DownloadSink,
  type HttpFn,
  type TransferParams,
  type TransferProgress,
} from '../../src/downloads/types';
import type { HttpRequest } from '../../src/sources/debrid/http';

const URL = 'https://debrid.example/file.mkv?apikey=SECRET';
const CHUNK = 8;

/** Contenu déterministe d'un fichier distant. */
const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);

/** Magasin en mémoire : journalise les écritures et les troncatures. */
function memorySink(initial: Uint8Array = new Uint8Array(0)) {
  let data = initial.slice();
  const writes: Array<{ offset: number; length: number }> = [];
  const truncates: number[] = [];
  const sink: DownloadSink = {
    size: async () => data.length,
    write: async (offset, chunk) => {
      if (offset > data.length) throw new Error('trou dans le fichier');
      const next = new Uint8Array(Math.max(data.length, offset + chunk.length));
      next.set(data);
      next.set(chunk, offset);
      data = next;
      writes.push({ offset, length: chunk.length });
    },
    truncate: async (len) => {
      truncates.push(len);
      data = data.slice(0, len);
    },
    finalize: async () => {},
    close: async () => {},
  };
  return { sink, writes, truncates, content: () => data };
}

/** Serveur distant simulé : `Range` donne 206 (avec l'ETag du fichier), sans `Range` donne 200 avec le corps entier. */
interface Remote {
  body: Uint8Array;
  etag?: string;
  /** false : le serveur ignore `Range` et répond 200 avec le corps entier. */
  ranges?: boolean;
  /** true : `Content-Range` annonce `*` au lieu de la taille totale. */
  hideTotal?: boolean;
}

function remoteHttp(remote: Remote, requests: HttpRequest[] = []): HttpFn {
  return async (req): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> => {
    requests.push(req);
    const total = remote.body.length;
    const etagHeader: Record<string, string> = remote.etag === undefined ? {} : { etag: remote.etag };
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers?.Range ?? '');
    if (!range || remote.ranges === false) {
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(total), ...etagHeader },
        body: remote.body,
      };
    }
    const start = Number(range[1]);
    if (start >= total) {
      return { status: 416, headers: { 'content-range': `bytes */${total}` }, body: new Uint8Array(0) };
    }
    const last = Math.min(Number(range[2]), total - 1);
    return {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${last}/${remote.hideTotal ? '*' : total}`,
        ...etagHeader,
      },
      body: remote.body.slice(start, last + 1),
    };
  };
}

function params(http: HttpFn, sink: DownloadSink, extra: Partial<TransferParams> = {}): TransferParams {
  return { http, sink, url: URL, chunkSize: CHUNK, signal: new AbortController().signal, onProgress: () => {}, ...extra };
}

/** Vérifie le code d'une `DownloadError` et qu'aucun fragment du lien ne fuit dans le message. */
async function expectFailure(run: Promise<unknown>, code: string, retryable: boolean): Promise<void> {
  const err: unknown = await run.then(
    () => new Error('aurait dû échouer'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DownloadError);
  expect(err).toMatchObject({ code, retryable });
  expect((err as Error).message).not.toMatch(/SECRET|debrid\.example/);
}

describe('fetchChunks : transfert nominal', () => {
  it('télécharge par plages successives, vérifie chaque réponse et annonce l’avancement', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, writes, content } = memorySink();
    const progress: TransferProgress[] = [];
    const result = await fetchChunks(
      params(remoteHttp({ body, etag: 'v1' }, requests), sink, {
        onProgress: (p) => {
          progress.push(p);
        },
      }),
    );
    expect(requests.map((r) => r.headers?.Range)).toEqual(['bytes=0-7', 'bytes=8-15', 'bytes=16-19']);
    expect(requests.every((r) => r.url === URL)).toBe(true);
    expect(requests[0]?.headers?.['If-Range']).toBeUndefined();
    expect(writes).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: 8 },
      { offset: 16, length: 4 },
    ]);
    expect(content()).toEqual(body);
    expect(progress.map((p) => p.bytesDone)).toEqual([8, 16, 20]);
    expect(progress.at(-1)).toMatchObject({ bytesTotal: 20, etag: 'v1' });
    expect(result).toEqual({ bytesDone: 20, bytesTotal: 20, etag: 'v1', lastModified: undefined, done: true });
  });

  it('reprend à l’offset du magasin, sans réécrire les octets déjà présents', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, writes, truncates, content } = memorySink(body.slice(0, 8));
    const result = await fetchChunks(
      params(remoteHttp({ body, etag: 'v1' }, requests), sink, { bytesTotal: 20, etag: 'v1' }),
    );
    expect(requests.map((r) => r.headers?.Range)).toEqual(['bytes=8-15', 'bytes=16-19']);
    expect(writes.every((w) => w.offset >= 8)).toBe(true);
    expect(truncates).toEqual([]);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, done: true });
  });

  it('magasin déjà complet : terminé sans aucune requête', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, writes } = memorySink(body);
    const result = await fetchChunks(params(remoteHttp({ body }, requests), sink, { bytesTotal: 20 }));
    expect(requests).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, done: true });
  });

  it('magasin plus grand que la taille annoncée : tronqué puis téléchargé en entier', async () => {
    const body = bytesOf(20);
    const { sink, truncates, content } = memorySink(new Uint8Array(30).fill(9));
    const result = await fetchChunks(params(remoteHttp({ body }, []), sink, { bytesTotal: 20 }));
    expect(truncates).toEqual([0]);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, done: true });
  });
});

describe('fetchChunks : ETag du lien courant, sans If-Range', () => {
  it('aucune requête n’envoie If-Range : seul Range part, avec un ETag connu comme sans', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    // Reprise à l’offset 8 avec un ETag connu (2 requêtes), puis téléchargement neuf avec le même ETag (3 requêtes).
    await fetchChunks(params(remoteHttp({ body, etag: 'v1' }, requests), memorySink(body.slice(0, 8)).sink, { bytesTotal: 20, etag: 'v1' }));
    await fetchChunks(params(remoteHttp({ body, etag: 'v1' }, requests), memorySink().sink, { etag: 'v1' }));
    expect(requests).toHaveLength(5);
    for (const r of requests) expect(Object.keys(r.headers ?? {})).toEqual(['Range']);
  });

  it('reprise à l’offset avec l’ETag du lien courant identique : continue sans recommencer', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, truncates, content } = memorySink(body.slice(0, 8));
    const result = await fetchChunks(
      params(remoteHttp({ body, etag: 'v1' }, requests), sink, { bytesTotal: 20, etag: 'v1' }),
    );
    expect(requests.map((r) => r.headers?.Range)).toEqual(['bytes=8-15', 'bytes=16-19']);
    expect(truncates).toEqual([]);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, etag: 'v1', done: true });
  });

  it('reprise sans ETag fourni (nouveau lien dont l’ETag diffère) : offset conservé, 206 accepté', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, writes, truncates, content } = memorySink(body.slice(0, 8));
    const result = await fetchChunks(params(remoteHttp({ body, etag: 'v2' }, requests), sink, { bytesTotal: 20 }));
    expect(requests.map((r) => r.headers?.Range)).toEqual(['bytes=8-15', 'bytes=16-19']);
    expect(truncates).toEqual([]);
    expect(writes.every((w) => w.offset >= 8)).toBe(true);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, etag: 'v2', done: true });
  });
});

describe('fetchChunks : serveur sans Range ou taille inconnue', () => {
  it('répond 200 sans Range : tronque le fichier partiel puis écrit le corps entier en une fois', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, writes, truncates, content } = memorySink(new Uint8Array(5).fill(9));
    const result = await fetchChunks(params(remoteHttp({ body, ranges: false }, requests), sink));
    expect(requests).toHaveLength(1);
    expect(truncates).toEqual([0]);
    expect(writes).toEqual([{ offset: 0, length: 20 }]);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, done: true });
  });

  it('corps 200 annoncé au-delà de la limite sans Range : content, rien n’est écrit ni tronqué', async () => {
    const http: HttpFn = async () => ({
      status: 200,
      headers: { 'content-length': String(MAX_FULL_BODY_BYTES + 1) },
      body: new Uint8Array(4),
    });
    const { sink, writes, truncates } = memorySink(new Uint8Array(5).fill(9));
    await expectFailure(fetchChunks(params(http, sink)), 'content', false);
    expect(writes).toEqual([]);
    expect(truncates).toEqual([]);
  });

  it('taille inconnue : une réponse 416 « */N » avec N atteint termine le fichier', async () => {
    const body = bytesOf(16);
    const requests: HttpRequest[] = [];
    const { sink, content } = memorySink();
    const result = await fetchChunks(params(remoteHttp({ body, hideTotal: true }, requests), sink));
    expect(requests.map((r) => r.headers?.Range)).toEqual(['bytes=0-7', 'bytes=8-15', 'bytes=16-23']);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 16, bytesTotal: 16, done: true });
  });

  it('taille inconnue : un morceau plus court que demandé marque la fin du fichier', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, content } = memorySink();
    const result = await fetchChunks(params(remoteHttp({ body, hideTotal: true }, requests), sink));
    expect(requests).toHaveLength(3);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, done: true });
  });
});

describe('fetchChunks : ETag ou taille qui changent pendant la reprise', () => {
  it('ETag changé : recommence à zéro une seule fois, en oubliant ETag et taille', async () => {
    const body = bytesOf(20);
    const requests: HttpRequest[] = [];
    const { sink, truncates, content } = memorySink(body.slice(0, 8));
    const result = await fetchChunks(
      params(remoteHttp({ body, etag: 'v2' }, requests), sink, { bytesTotal: 20, etag: 'v1' }),
    );
    expect(truncates).toEqual([0]);
    expect(requests.map((r) => r.headers?.Range)).toEqual(['bytes=8-15', 'bytes=0-7', 'bytes=8-15', 'bytes=16-19']);
    expect(content()).toEqual(body);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, etag: 'v2', done: true });
  });

  it('ETag qui change encore après la reprise : range_mismatch, sans nouvel essai', async () => {
    const body = bytesOf(20);
    const remote: Remote = { body, etag: 'v2' };
    const base = remoteHttp(remote, []);
    let calls = 0;
    const http: HttpFn = async (req) => {
      const res = await base(req);
      calls += 1;
      remote.etag = `v${calls + 2}`;
      return res;
    };
    const { sink } = memorySink(bytesOf(20).slice(0, 8));
    await expectFailure(fetchChunks(params(http, sink, { bytesTotal: 20, etag: 'v1' })), 'range_mismatch', false);
    expect(calls).toBe(3);
  });

  it('réponses 206 sans Content-Range, deux fois : range_mismatch, rien n’est écrit', async () => {
    const requests: HttpRequest[] = [];
    const http: HttpFn = async (req) => {
      requests.push(req);
      return { status: 206, headers: {}, body: new Uint8Array(8) };
    };
    const { sink, writes } = memorySink();
    await expectFailure(fetchChunks(params(http, sink)), 'range_mismatch', false);
    expect(requests).toHaveLength(2);
    expect(writes).toEqual([]);
  });
});

describe('fetchChunks : erreurs HTTP', () => {
  it.each([401, 403, 404, 410])('HTTP %i : lien expiré, re-résolution possible', async (status) => {
    const http: HttpFn = async () => ({ status, headers: {}, body: new Uint8Array(0) });
    await expectFailure(fetchChunks(params(http, memorySink().sink)), 'link_expired', true);
  });

  it('page HTML à la place du fichier : lien expiré', async () => {
    const http: HttpFn = async () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: new Uint8Array(10),
    });
    const { sink, writes } = memorySink();
    await expectFailure(fetchChunks(params(http, sink)), 'link_expired', true);
    expect(writes).toEqual([]);
  });

  it('page HTML en cours de reprise : jamais écrite comme fichier terminé', async () => {
    const body = bytesOf(20);
    const base = remoteHttp({ body }, []);
    let calls = 0;
    const http: HttpFn = async (req) => {
      calls += 1;
      if (calls === 2) return { status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array(10) };
      return base(req);
    };
    const { sink, writes, content } = memorySink();
    await expectFailure(fetchChunks(params(http, sink)), 'link_expired', true);
    expect(writes).toEqual([{ offset: 0, length: 8 }]);
    expect(content()).toEqual(body.slice(0, 8));
  });

  it.each([429, 500, 503])('HTTP %i : erreur réseau retryable', async (status) => {
    const http: HttpFn = async () => ({ status, headers: {}, body: new Uint8Array(0) });
    await expectFailure(fetchChunks(params(http, memorySink().sink)), 'network', true);
  });

  it('transport qui rejette (timeout, coupure) : erreur réseau, sans reprendre le message du transport', async () => {
    const http: HttpFn = async () => {
      throw new TypeError(`Failed to fetch ${URL}`);
    };
    await expectFailure(fetchChunks(params(http, memorySink().sink)), 'network', true);
  });

  it('autre 4xx : contenu indisponible, non retryable', async () => {
    const http: HttpFn = async () => ({ status: 400, headers: {}, body: new Uint8Array(0) });
    await expectFailure(fetchChunks(params(http, memorySink().sink)), 'content', false);
  });
});

describe('fetchChunks : annulation', () => {
  it('signal déjà annulé : cancelled, aucune requête', async () => {
    const controller = new AbortController();
    controller.abort();
    const requests: HttpRequest[] = [];
    await expectFailure(
      fetchChunks(params(remoteHttp({ body: bytesOf(20) }, requests), memorySink().sink, { signal: controller.signal })),
      'cancelled',
      false,
    );
    expect(requests).toHaveLength(0);
  });

  it('annulation pendant le transfert : cancelled au morceau suivant', async () => {
    const controller = new AbortController();
    const requests: HttpRequest[] = [];
    const { sink, writes } = memorySink();
    await expectFailure(
      fetchChunks(
        params(remoteHttp({ body: bytesOf(20) }, requests), sink, {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      ),
      'cancelled',
      false,
    );
    expect(requests).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it('morceau reçu après l’annulation : jeté, rien n’est écrit', async () => {
    const controller = new AbortController();
    const base = remoteHttp({ body: bytesOf(20) }, []);
    const http: HttpFn = async (req) => {
      const res = await base(req);
      controller.abort();
      return res;
    };
    const { sink, writes } = memorySink();
    await expectFailure(fetchChunks(params(http, sink, { signal: controller.signal })), 'cancelled', false);
    expect(writes).toEqual([]);
  });
});

describe('fetchChunks : magasin', () => {
  it('erreur de stockage déjà typée : son code remonte tel quel', async () => {
    const { sink } = memorySink();
    const full: DownloadSink = {
      ...sink,
      write: async () => {
        throw new DownloadError('store_full', false);
      },
    };
    await expectFailure(fetchChunks(params(remoteHttp({ body: bytesOf(20) }, []), full)), 'store_full', false);
  });

  it('écriture en échec sans code : store_failed', async () => {
    const { sink } = memorySink();
    const broken: DownloadSink = {
      ...sink,
      write: async () => {
        throw new Error('EIO');
      },
    };
    await expectFailure(fetchChunks(params(remoteHttp({ body: bytesOf(20) }, []), broken)), 'store_failed', false);
  });
});
