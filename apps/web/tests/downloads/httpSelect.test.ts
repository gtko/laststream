import { describe, expect, it, vi } from 'vitest';
import { createDownloadHttp } from '../../src/downloads/httpSelect';
import { fetchChunks } from '../../src/downloads/transfer';
import { DownloadError, type DownloadSink } from '../../src/downloads/types';
import { BLOCKED_STATUS } from '../../src/downloads/webHttp';
import type { HttpFn, HttpRequest } from '../../src/sources/debrid/http';
import { DebridError } from '../../src/sources/debrid/types';

/** Hôte de débrideur (AllDebrid) : https, sans identifiants. */
const DEBRID_LINK = 'https://s1.alldebrid.com/dl/SECRET/film.mkv';
/** Lien d'addon : hôte public https, hors débrideurs. */
const ADDON_LINK = 'https://addon.example.org/stream/film.mkv';
const PART: Uint8Array<ArrayBuffer> = Uint8Array.from([1, 2, 3, 4]);

const req = (url: string): HttpRequest => ({ url, method: 'GET', headers: { Range: 'bytes=0-3' } });

/** `fetch` simulé : une plage valide, chaque appel est compté par `vi.fn`. */
const fakeFetch = () =>
  vi.fn<typeof fetch>(async () => new Response(PART.slice(), { status: 206, headers: { 'Content-Range': 'bytes 0-3/4' } }));

/** Pont natif simulé : une plage valide. */
const fakeBridge = () => vi.fn<HttpFn>(async () => ({ status: 206, headers: { 'content-range': 'bytes 0-3/4' }, body: PART }));

/** Magasin en mémoire, sans journal. */
function memorySink(): DownloadSink {
  let data = new Uint8Array(0);
  return {
    size: async () => data.length,
    write: async (offset, chunk) => {
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
}

describe('createDownloadHttp : transport selon la plateforme (LAST-182)', () => {
  it('coque + lien débrideur : le pont natif répond, fetch n’est jamais appelé', async () => {
    const fetchSpy = fakeFetch();
    const bridge = fakeBridge();
    const res = await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(req(DEBRID_LINK));
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge.mock.calls[0][0].url).toBe(DEBRID_LINK);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(206);
  });

  it('coque + lien direct d’addon : le pont natif, jamais fetch (LAST-501)', async () => {
    const fetchSpy = fakeFetch();
    const bridge = fakeBridge();
    const res = await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(req(ADDON_LINK));
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge.mock.calls[0][0].url).toBe(ADDON_LINK);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(206);
  });

  it('coque + lien d’addon hors règles du transfert natif (port, identifiants) : fetch, jamais le pont', async () => {
    for (const url of ['https://addon.example.org:8443/stream/film.mkv', 'https://u:p@addon.example.org/stream/film.mkv']) {
      const fetchSpy = fakeFetch();
      const bridge = fakeBridge();
      await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(req(url));
      expect(bridge).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('coque + lien d’addon, hôte refusé par le pont (coque ancienne) : repli sur fetch', async () => {
    const fetchSpy = fakeFetch();
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('host_not_allowed', 'unsupported');
    });
    const res = await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(req(ADDON_LINK));
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(206);
  });

  it('coque + lien débrideur, hôte refusé par le pont : blocage, jamais fetch', async () => {
    const fetchSpy = fakeFetch();
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('host_not_allowed', 'unsupported');
    });
    const res = await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(req(DEBRID_LINK));
    expect(res.status).toBe(BLOCKED_STATUS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('coque + lien d’addon refusé par le pont (redirection) : blocage, sans exception', async () => {
    const fetchSpy = fakeFetch();
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('redirect_not_allowed', 'unsupported');
    });
    const res = await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(req(ADDON_LINK));
    expect(res.status).toBe(BLOCKED_STATUS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('coque + lien débrideur non https : ni pont ni fetch, blocage', async () => {
    const fetchSpy = fakeFetch();
    const bridge = fakeBridge();
    const res = await createDownloadHttp('shell', { fetchImpl: fetchSpy, shell: bridge })(
      req(DEBRID_LINK.replace('https://', 'http://')),
    );
    expect(bridge).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(BLOCKED_STATUS);
  });

  it('web : lien débrideur par fetch, jamais le pont', async () => {
    const fetchSpy = fakeFetch();
    const bridge = fakeBridge();
    const res = await createDownloadHttp('web', { fetchImpl: fetchSpy, shell: bridge })(req(DEBRID_LINK));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveBeenCalled();
    expect(res.status).toBe(206);
  });

  it('android : lien débrideur par fetch, jamais le pont', async () => {
    const fetchSpy = fakeFetch();
    const bridge = fakeBridge();
    const res = await createDownloadHttp('android', { fetchImpl: fetchSpy, shell: bridge })(req(DEBRID_LINK));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveBeenCalled();
    expect(res.status).toBe(206);
  });

  it('coque : refus du pont (host_not_allowed) rendu comme blocage, sans exception', async () => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('host_not_allowed', 'unsupported');
    });
    const res = await createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge })(req(DEBRID_LINK));
    expect(res.status).toBe(BLOCKED_STATUS);
    expect(res.body.length).toBe(0);
  });

  it('coque : délai du pont relancé tel quel, retentable par le gestionnaire', async () => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('timeout', 'transient');
    });
    await expect(createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge })(req(DEBRID_LINK))).rejects.toMatchObject({
      code: 'timeout',
      kind: 'transient',
    });
  });

  it('coque : refus du pont dans fetchChunks → content après un seul appel, sans nouvelle tentative', async () => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('host_not_allowed', 'unsupported');
    });
    const http = createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge });
    const err = await fetchChunks({
      http,
      sink: memorySink(),
      url: DEBRID_LINK,
      chunkSize: 4,
      bytesTotal: 8,
      signal: new AbortController().signal,
      onProgress: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe('content');
    expect((err as DownloadError).retryable).toBe(false);
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(String((err as Error).message)).not.toContain('SECRET');
  });

  /** Erreur levée par un téléchargement de 8 octets (morceaux de 4) via ce transport ; undefined si le transfert réussit. */
  const failureOf = (http: HttpFn): Promise<unknown> =>
    fetchChunks({
      http,
      sink: memorySink(),
      url: DEBRID_LINK,
      chunkSize: 4,
      bytesTotal: 8,
      signal: new AbortController().signal,
      onProgress: async () => {},
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

  it('coque : bad_status 403 → link_expired à fetchChunks, un seul appel au pont', async () => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('bad_status', 'unsupported', { status: 403 });
    });
    const err = await failureOf(createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge }));
    expect(err).toMatchObject({ code: 'link_expired', retryable: true });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('coque : bad_status %i → réseau retentable à fetchChunks', async (status) => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('bad_status', 'unsupported', { status });
    });
    const err = await failureOf(createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge }));
    expect(err).toMatchObject({ code: 'network', retryable: true });
  });

  it('coque : bad_status hors erreur HTTP (200) n’est jamais rendu comme réponse : exception transitoire', async () => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('bad_status', 'unsupported', { status: 200 });
    });
    await expect(createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge })(req(DEBRID_LINK))).rejects.toMatchObject({
      code: 'bad_status',
    });
  });

  it('coque : redirect_not_allowed → content à fetchChunks, un seul appel au pont', async () => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError('redirect_not_allowed', 'unsupported');
    });
    const err = await failureOf(createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge }));
    expect(err).toMatchObject({ code: 'content', retryable: false });
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it.each(['host_not_allowed', 'redirect_not_allowed', 'range_unsupported', 'too_large', 'method_not_allowed'])(
    'coque : refus définitif %s → blocage (statut 0), sans exception',
    async (code) => {
      const bridge = vi.fn<HttpFn>(async () => {
        throw new DebridError(code, 'unsupported');
      });
      const res = await createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge })(req(DEBRID_LINK));
      expect(res.status).toBe(BLOCKED_STATUS);
      expect(res.body.length).toBe(0);
    },
  );

  it.each(['timeout', 'network', 'aborted', 'busy', 'bad_chunk'])('coque : erreur transitoire %s → exception, retentable', async (code) => {
    const bridge = vi.fn<HttpFn>(async () => {
      throw new DebridError(code, 'transient');
    });
    await expect(createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge })(req(DEBRID_LINK))).rejects.toMatchObject({ code });
  });

  it('coque : délai total transmis au pont, 60 s par défaut, `timeoutMs` de la requête sinon', async () => {
    const bridge = fakeBridge();
    const http = createDownloadHttp('shell', { fetchImpl: fakeFetch(), shell: bridge });
    await http(req(DEBRID_LINK));
    await http({ ...req(DEBRID_LINK), timeoutMs: 5_000 });
    expect(bridge.mock.calls.map((c) => c[0].timeoutMs)).toEqual([60_000, 5_000]);
  });
});
