import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '../../src/sources/debrid/http';
import { fetchChunks } from '../../src/downloads/transfer';
import { MAX_FULL_BODY_BYTES, type DownloadSink } from '../../src/downloads/types';
import { BLOCKED_STATUS, createWebDownloadHttp, type WebHttpOptions } from '../../src/downloads/webHttp';

const LINK = 'https://x.alldebrid.com/f.mkv?token=SECRET';

/** Contenu déterministe d'un fichier distant (`ArrayBuffer` explicite : c'est ce qu'attend `Response`). */
const bytesOf = (n: number, seed = 3): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256);

/** Octets pseudo-aléatoires, identiques d'un passage à l'autre. */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  let seed = 0x2f6b;
  return Uint8Array.from({ length: n }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  });
}

/** `fetch` simulé : chaque appel est journalisé ; la réponse vient de `respond` (numéro d'appel à partir de 1). */
function fakeFetch(respond: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {}, calls.length);
  };
  return { impl: impl as typeof fetch, calls };
}

const rangeOf = (init: RequestInit): string | undefined => (init.headers as Record<string, string> | undefined)?.Range;

function request(headers?: Record<string, string>, extra: { url?: string; signal?: AbortSignal } = {}): HttpRequest {
  return { url: extra.url ?? LINK, method: 'GET', headers, signal: extra.signal };
}

const options = (impl: typeof fetch, extra: Partial<WebHttpOptions> = {}): WebHttpOptions => ({
  fetchImpl: impl,
  allowHost: () => true,
  online: () => true,
  ...extra,
});

/** Serveur d'hébergeur débridé : honore `Range`. `exposeRange` faux : `Content-Range` n'est pas lisible par le navigateur. */
function serve(content: Uint8Array<ArrayBuffer>, init: RequestInit, exposeRange: boolean): Response {
  const m = /^bytes=(\d+)-(\d+)$/.exec(rangeOf(init) ?? '');
  if (!m) return new Response(content, { status: 200, headers: { 'content-length': String(content.length) } });
  const start = Number(m[1]);
  if (start >= content.length) {
    return new Response(null, { status: 416, headers: exposeRange ? { 'content-range': `bytes */${content.length}` } : {} });
  }
  const last = Math.min(Number(m[2]), content.length - 1);
  return new Response(content.slice(start, last + 1), {
    status: 206,
    headers: exposeRange ? { 'content-range': `bytes ${start}-${last}/${content.length}` } : {},
  });
}

/** Magasin en mémoire, sans journal : l'intégration ne vérifie que le contenu final. */
function memorySink() {
  let data = new Uint8Array(0);
  const sink: DownloadSink = {
    size: async () => data.length,
    write: async (offset, chunk) => {
      if (offset > data.length) throw new Error('trou dans le fichier');
      const next = new Uint8Array(Math.max(data.length, offset + chunk.length));
      next.set(data);
      next.set(chunk, offset);
      data = next;
    },
    truncate: async (len) => {
      data = data.slice(0, len);
    },
    finalize: async () => {},
    close: async () => {},
  };
  return { sink, content: () => data };
}

const EMPTY = new Uint8Array(0);

/** Octets comparables : un corps issu de `Response` n'a pas le même constructeur que les tableaux du test (realm), `toEqual` échouerait. */
const octets = (u: Uint8Array): number[] => Array.from(u);

describe('createWebDownloadHttp : réponses ordinaires', () => {
  it('206 : statut, en-têtes en minuscules et corps exact', async () => {
    const body = bytesOf(8);
    const { impl } = fakeFetch(
      () => new Response(body, { status: 206, headers: { 'Content-Range': 'bytes 0-7/20', ETag: '"v1"', 'X-Test': 'ok' } }),
    );
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }));
    expect(res.status).toBe(206);
    expect(res.headers).toMatchObject({ 'content-range': 'bytes 0-7/20', etag: '"v1"', 'x-test': 'ok' });
    expect(Object.keys(res.headers).every((k) => k === k.toLowerCase())).toBe(true);
    expect(octets(res.body)).toEqual(octets(body));
  });

  it('206 sans Content-Range lisible : déduit de la plage demandée', async () => {
    const { impl } = fakeFetch(() => new Response(bytesOf(8), { status: 206 }));
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=8-15' }));
    expect(res.headers['content-range']).toBe('bytes 8-15/*');
    expect(octets(res.body)).toEqual(octets(bytesOf(8)));
  });

  it('206 sans Content-Range lisible : déduit d’après le corps reçu, plus court que la plage', async () => {
    const { impl } = fakeFetch(() => new Response(bytesOf(5), { status: 206 }));
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=8-15' }));
    expect(res.headers['content-range']).toBe('bytes 8-12/*');
  });

  it('416 sans Content-Range : bytes */début demandé', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 416 }));
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=40-47' }));
    expect(res).toEqual({ status: 416, headers: { 'content-range': 'bytes */40' }, body: EMPTY });
  });

  it('200 sans Range demandé : corps entier renvoyé', async () => {
    const body = bytesOf(20);
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }));
    const res = await createWebDownloadHttp(options(impl))(request());
    expect(res.status).toBe(200);
    expect(octets(res.body)).toEqual(octets(body));
  });

  it('options transmises à fetch : pas de cookies, pas de référent, pas de cache, plage seule', async () => {
    const { impl, calls } = fakeFetch(() => new Response(bytesOf(8), { status: 206, headers: { 'content-range': 'bytes 0-7/20' } }));
    await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { Range: 'bytes=0-7' },
    });
    expect(calls[0]?.url).toBe(LINK);
  });
});

describe('createWebDownloadHttp : hôtes autorisés', () => {
  it('débrideur en https : la requête part', async () => {
    const { impl, calls } = fakeFetch(() => new Response(bytesOf(8), { status: 206, headers: { 'content-range': 'bytes 0-7/20' } }));
    const res = await createWebDownloadHttp({ fetchImpl: impl, online: () => true })(request({ Range: 'bytes=0-7' }));
    expect(res.status).toBe(206);
    expect(calls).toHaveLength(1);
  });

  it.each([
    'http://x.alldebrid.com/f.mkv',
    'https://example.com/f.mkv',
    'https://user:secret@x.alldebrid.com/f.mkv',
    'https://alldebrid.com/f.mkv',
    'pas une url',
  ])('%s : refusé, statut 0, aucun appel réseau', async (url) => {
    const { impl, calls } = fakeFetch(() => new Response(bytesOf(8), { status: 206 }));
    const res = await createWebDownloadHttp({ fetchImpl: impl, online: () => true })(request({ Range: 'bytes=0-7' }, { url }));
    expect(BLOCKED_STATUS).toBe(0);
    expect(res).toEqual({ status: BLOCKED_STATUS, headers: {}, body: EMPTY });
    expect(calls).toHaveLength(0);
  });

  it('allowHost fourni : sa règle remplace celle des débrideurs', async () => {
    const { impl, calls } = fakeFetch(() => new Response(bytesOf(8), { status: 206, headers: { 'content-range': 'bytes 0-7/20' } }));
    const res = await createWebDownloadHttp(options(impl, { allowHost: () => false }))(request({ Range: 'bytes=0-7' }));
    expect(res.status).toBe(BLOCKED_STATUS);
    expect(calls).toHaveLength(0);
  });
});

describe('createWebDownloadHttp : plafond sans Range', () => {
  it('200 annoncé au-delà du plafond à une demande de Range : corps vide, flux jamais lu', async () => {
    let pulled = false;
    // highWaterMark 0 : le flux n'est sollicité qu'à une lecture, qui doit donc ne jamais avoir lieu.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
          throw new Error('flux lu');
        },
      },
      { highWaterMark: 0 },
    );
    const { impl } = fakeFetch(
      () => new Response(stream, { status: 200, headers: { 'content-length': String(MAX_FULL_BODY_BYTES + 1) } }),
    );
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(MAX_FULL_BODY_BYTES + 1));
    expect(res.body).toHaveLength(0);
    expect(pulled).toBe(false);
  });
});

describe('createWebDownloadHttp : CORS', () => {
  it('sondage no-cors qui répond et second essai refusé : statut 0, sans nouvel essai', async () => {
    const { impl, calls } = fakeFetch((_url, init) => {
      if (init.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }));
    expect(res).toEqual({ status: BLOCKED_STATUS, headers: {}, body: EMPTY });
    expect(calls.map((c) => c.init.mode)).toEqual([undefined, 'no-cors', undefined]);
  });

  it('premier essai refusé, sondage qui échoue aussi : coupure (TypeError relancée)', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }))).rejects.toBeInstanceOf(TypeError);
    expect(calls.map((c) => c.init.mode)).toEqual([undefined, 'no-cors']);
  });

  it('premier essai refusé, sondage ok, second essai réussi : réponse normale', async () => {
    const body = bytesOf(8);
    const { impl, calls } = fakeFetch((_url, init, call) => {
      if (init.mode === 'no-cors') return new Response(null);
      if (call === 1) throw new TypeError('Failed to fetch');
      return new Response(body, { status: 206, headers: { 'content-range': 'bytes 0-7/20' } });
    });
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }));
    expect(res.status).toBe(206);
    expect(res.headers).toEqual({ 'content-range': 'bytes 0-7/20' });
    expect(octets(res.body)).toEqual(octets(body));
    expect(calls).toHaveLength(3);
  });

  it('TypeError sur une plage après le début, hôte joignable : lien périmé (410) à re-résoudre, pas un blocage', async () => {
    const { impl, calls } = fakeFetch((_url, init) => {
      if (init.mode === 'no-cors') return new Response(null);
      throw new TypeError('Failed to fetch');
    });
    const res = await createWebDownloadHttp(options(impl))(request({ Range: 'bytes=100-199' }));
    expect(res.status).toBe(410);
    expect(calls.map((c) => c.init.mode)).toEqual([undefined, 'no-cors', undefined]);
  });

  it('TypeError sur une plage après le début, hôte injoignable : coupure (TypeError relancée)', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(createWebDownloadHttp(options(impl))(request({ Range: 'bytes=100-199' }))).rejects.toBeInstanceOf(TypeError);
  });

  it('redirection vers un hôte non autorisé : bloquée, corps non lu', async () => {
    const { impl } = fakeFetch(() => {
      const res = new Response(bytesOf(8), { status: 206, headers: { 'content-range': 'bytes 0-7/20' } });
      Object.defineProperty(res, 'url', { value: 'https://evil.example/f.mkv' });
      return res;
    });
    const res = await createWebDownloadHttp({ fetchImpl: impl, online: () => true })(
      request({ Range: 'bytes=0-7' }, { url: 'https://x.alldebrid.com/f.mkv' }),
    );
    expect(res).toEqual({ status: BLOCKED_STATUS, headers: {}, body: EMPTY });
  });

  it('redirection vers un autre hôte de débrideur : acceptée', async () => {
    const { impl } = fakeFetch(() => {
      const res = new Response(bytesOf(8), { status: 206, headers: { 'content-range': 'bytes 0-7/20' } });
      Object.defineProperty(res, 'url', { value: 'https://cdn.alldebrid.com/f.mkv' });
      return res;
    });
    const res = await createWebDownloadHttp({ fetchImpl: impl, online: () => true })(
      request({ Range: 'bytes=0-7' }, { url: 'https://x.alldebrid.com/f.mkv' }),
    );
    expect(res.status).toBe(206);
  });

  it('hôte par défaut : port atypique refusé sans appel réseau', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null));
    const res = await createWebDownloadHttp({ fetchImpl: impl, online: () => true })(
      request({ Range: 'bytes=0-7' }, { url: 'https://x.alldebrid.com:8443/f.mkv' }),
    );
    expect(res.status).toBe(BLOCKED_STATUS);
    expect(calls).toHaveLength(0);
  });

  it('hors ligne : coupure directe, sans sondage', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      createWebDownloadHttp(options(impl, { online: () => false }))(request({ Range: 'bytes=0-7' })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });

  it('erreur qui n’est pas un TypeError : relancée, sans sondage', async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error('boom');
    });
    await expect(createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }))).rejects.toThrow('boom');
    expect(calls).toHaveLength(1);
  });
});

describe('createWebDownloadHttp : annulation et délai', () => {
  it('signal déjà annulé : rejet avant tout appel', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = fakeFetch(() => new Response(bytesOf(8), { status: 206 }));
    await expect(createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }, { signal: controller.signal }))).rejects.toThrow(
      'aborted',
    );
    expect(calls).toHaveLength(0);
  });

  it('signal annulé pendant le fetch : rejet', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('annulé', 'AbortError')));
        }),
    );
    const pending = createWebDownloadHttp(options(impl))(request({ Range: 'bytes=0-7' }, { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('délai d’inactivité : rejet quand le flux ne produit plus rien', async () => {
    const { impl } = fakeFetch(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener('abort', () => controller.error(new DOMException('délai', 'AbortError')));
            },
          }),
          { status: 206, headers: { 'content-range': 'bytes 0-7/20' } },
        ),
    );
    const http = createWebDownloadHttp(options(impl, { idleTimeoutMs: 20 }));
    await expect(http(request({ Range: 'bytes=0-7' }))).rejects.toHaveProperty('name', 'AbortError');
  });
});

describe('createWebDownloadHttp + fetchChunks : serveur sans Content-Range lisible', () => {
  const run = async (content: Uint8Array<ArrayBuffer>, exposeRange: boolean) => {
    const { impl, calls } = fakeFetch((_url, init) => serve(content, init, exposeRange));
    const { sink, content: written } = memorySink();
    const result = await fetchChunks({
      http: createWebDownloadHttp(options(impl)),
      sink,
      url: LINK,
      chunkSize: 10,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    return { result, written: written(), calls };
  };

  it('taille inconnue, fin par morceau court : fichier reconstruit à l’identique', async () => {
    const content = randomBytes(25);
    const { result, written, calls } = await run(content, false);
    expect(written).toEqual(content);
    expect(result).toMatchObject({ bytesDone: 25, bytesTotal: 25, done: true });
    expect(calls).toHaveLength(3);
  });

  it('taille inconnue, fin par 416 (taille multiple du morceau) : fichier reconstruit à l’identique', async () => {
    const content = randomBytes(20);
    const { result, written, calls } = await run(content, false);
    expect(written).toEqual(content);
    expect(result).toMatchObject({ bytesDone: 20, bytesTotal: 20, done: true });
    expect(calls).toHaveLength(3);
  });

  it('Content-Range lisible : taille connue dès le premier morceau, fichier identique', async () => {
    const content = randomBytes(25);
    const { result, written, calls } = await run(content, true);
    expect(written).toEqual(content);
    expect(result).toMatchObject({ bytesDone: 25, bytesTotal: 25, done: true });
    expect(calls.map((c) => rangeOf(c.init))).toEqual(['bytes=0-9', 'bytes=10-19', 'bytes=20-24']);
  });
});
