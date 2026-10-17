import { describe, expect, it, vi } from 'vitest';
import { AllDebridClient, AllDebridError } from '../src/sources/alldebrid.js';

const API_KEY = 'AD-TEST-KEY-NE-PAS-FUITER';

interface Call {
  method: string;
  path: string;
  form: URLSearchParams;
  auth: string | null;
}

interface Reply {
  status?: number;
  body: unknown;
}

type Responder = (call: Call) => Reply | Promise<Reply>;

/** fetch simulé : enregistre chaque appel et délègue la réponse au répondeur. */
function fakeAllDebrid(responder: Responder): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      form: init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(),
      auth: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const reply = await responder(call);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const ok = (data: unknown): Reply => ({ body: { status: 'success', data } });
const apiError = (code: string, status = 400): Reply => ({
  status,
  body: { status: 'error', error: { code, message: `message ${code}` } },
});

function hashOf(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function countCalls(calls: Call[], path: string): number {
  return calls.filter((c) => c.path === path).length;
}

/** Réponse magnet/upload : prêt si `ready`. */
function uploadEntry(hash: string, ready: boolean, id: number): Record<string, unknown> {
  return { magnet: `magnet:?xt=urn:btih:${hash}`, hash, name: 'x', size: 1, ready, id };
}

function makeClient(
  responder: Responder,
  opts: { cacheTtlMs?: number; now?: () => number } = {},
): { client: AllDebridClient; calls: Call[] } {
  const fake = fakeAllDebrid(responder);
  const client = new AllDebridClient(API_KEY, { fetch: fake.fetch, ...opts });
  return { client, calls: fake.calls };
}

const noSleep = async (): Promise<void> => {};

describe('AllDebridClient.checkApiKey', () => {
  it('renvoie ok et premium avec le Bearer sur GET /v4/user', async () => {
    const { client, calls } = makeClient(() => ok({ user: { username: 'u', isPremium: true } }));
    const result = await client.checkApiKey();
    expect(result).toEqual({ ok: true, premium: true });
    expect(calls[0]?.path).toBe('/v4/user');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.auth).toBe(`Bearer ${API_KEY}`);
  });

  it('renvoie ok=false avec le code d\'erreur API pour une clé refusée', async () => {
    const { client } = makeClient(() => apiError('AUTH_BAD_APIKEY', 401));
    const result = await client.checkApiKey();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('AUTH_BAD_APIKEY');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('ne lève pas en cas de panne réseau et ne cite pas la clé', async () => {
    const fetchImpl = (async () => {
      throw new TypeError(`fetch failed ${API_KEY}`);
    }) as unknown as typeof fetch;
    const client = new AllDebridClient(API_KEY, { fetch: fetchImpl });
    const result = await client.checkApiKey();
    expect(result).toEqual({ ok: false, error: 'network' });
  });

  it('traite une réponse sans status comme un échec', async () => {
    const { client } = makeClient(() => ({ body: { user: { isPremium: true } } }));
    expect(await client.checkApiKey()).toEqual({ ok: false, error: 'invalid_response' });
  });
});

describe('AllDebridClient.checkCached', () => {
  it('renvoie ready true/false et supprime les magnets non prêts ajoutés', async () => {
    const readyHash = hashOf(1);
    const pendingHash = hashOf(2);
    const { client, calls } = makeClient((call) => {
      if (call.path === '/v4/magnet/upload') {
        return ok({
          magnets: [uploadEntry(readyHash, true, 11), uploadEntry(pendingHash, false, 12)],
        });
      }
      return ok({});
    });
    const result = await client.checkCached([readyHash, pendingHash]);
    expect(result.get(readyHash)).toBe(true);
    expect(result.get(pendingHash)).toBe(false);
    const deletions = calls.filter((c) => c.path === '/v4/magnet/delete');
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.form.get('id')).toBe('12');
  });

  it('envoie les hashes en lots de 20 maximum', async () => {
    const hashes = Array.from({ length: 45 }, (_, i) => hashOf(i + 1));
    const { client, calls } = makeClient((call) => {
      if (call.path !== '/v4/magnet/upload') return ok({});
      const sent = call.form.getAll('magnets[]');
      return ok({ magnets: sent.map((h, i) => uploadEntry(h, true, i)) });
    });
    const result = await client.checkCached(hashes);
    const uploads = calls.filter((c) => c.path === '/v4/magnet/upload');
    expect(uploads.map((c) => c.form.getAll('magnets[]').length).sort((a, b) => a - b)).toEqual([5, 20, 20]);
    expect(result.size).toBe(45);
  });

  it('ignore les hashes invalides et les doublons', async () => {
    const valid = hashOf(7);
    const { client, calls } = makeClient((call) =>
      call.path === '/v4/magnet/upload' ? ok({ magnets: [uploadEntry(valid, true, 1)] }) : ok({}),
    );
    const result = await client.checkCached([valid, valid.toUpperCase(), 'pas-un-hash', '']);
    expect(result.size).toBe(1);
    const sent = calls.flatMap((c) => c.form.getAll('magnets[]'));
    expect(sent).toEqual([valid]);
  });

  it('réutilise le cache pendant le TTL positif et interroge à nouveau après expiration', async () => {
    let clock = 1_000;
    const hash = hashOf(3);
    const { client, calls } = makeClient(
      () => ok({ magnets: [uploadEntry(hash, true, 1)] }),
      { cacheTtlMs: 600_000, now: () => clock },
    );
    await client.checkCached([hash]);
    clock += 300_000;
    const second = await client.checkCached([hash]);
    expect(second.get(hash)).toBe(true);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    clock += 300_001;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
  });

  it('utilise un TTL négatif plus court que le TTL positif', async () => {
    let clock = 0;
    const hash = hashOf(4);
    const { client, calls } = makeClient(
      () => ok({ magnets: [uploadEntry(hash, false, 9)] }),
      { cacheTtlMs: 100_000, now: () => clock },
    );
    await client.checkCached([hash]);
    clock += 9_999;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    clock += 2;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
  });

  it('considère inconnu (absent de la Map) un lot en erreur, sans lever', async () => {
    const hashes = Array.from({ length: 25 }, (_, i) => hashOf(i + 1));
    const { client } = makeClient((call) => {
      const sent = call.form.getAll('magnets[]');
      if (sent.includes(hashOf(1))) return { status: 503, body: { status: 'error', error: { code: 'X' } } };
      return ok({ magnets: sent.map((h) => uploadEntry(h, true, 1)) });
    });
    const result = await client.checkCached(hashes);
    expect(result.has(hashOf(1))).toBe(false);
    expect(result.get(hashOf(25))).toBe(true);
    expect(result.size).toBe(5);
  });

  it('ignore les entrées magnet en erreur (inconnu)', async () => {
    const hash = hashOf(5);
    const { client } = makeClient(() => ok({ magnets: [{ magnet: 'x', hash, error: { code: 'MAGNET_INVALID_URI' } }] }));
    const result = await client.checkCached([hash]);
    expect(result.has(hash)).toBe(false);
  });

  it('limite la concurrence des lots à 3', async () => {
    const hashes = Array.from({ length: 100 }, (_, i) => hashOf(i + 1));
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = makeClient(async (call) => {
      if (call.path !== '/v4/magnet/upload') return ok({});
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok({ magnets: call.form.getAll('magnets[]').map((h) => uploadEntry(h, true, 1)) });
    });
    const result = await client.checkCached(hashes);
    expect(result.size).toBe(100);
    expect(maxInFlight).toBe(3);
  });
});

describe('AllDebridClient.resolve', () => {
  const HASH = hashOf(42);
  const MOVIE_LINK = 'https://dl.alldebrid.example/movie.mkv';

  function standardRoutes(files: unknown[], extra: (call: Call) => Reply | undefined = () => undefined): Responder {
    return (call) => {
      const custom = extra(call);
      if (custom) return custom;
      switch (call.path) {
        case '/v4/magnet/upload':
          return ok({ magnets: [uploadEntry(HASH, true, 77)] });
        case '/v4.1/magnet/status':
          return ok({ magnets: { id: 77, statusCode: 4 } });
        case '/v4/magnet/files':
          return ok({ magnets: [{ id: 77, files }] });
        case '/v4/link/unlock': {
          const link = call.form.get('link') ?? '';
          return ok({ link: `${MOVIE_LINK}?from=${encodeURIComponent(link)}`, filename: 'movie.mkv', filesize: 5000 });
        }
        default:
          return apiError('UNEXPECTED', 404);
      }
    };
  }

  it('résout un magnet déjà prêt sans interroger le statut', async () => {
    const { client, calls } = makeClient(
      standardRoutes([{ n: 'movie.mkv', s: 5000, l: 'locked-1' }]),
    );
    const result = await client.resolve(HASH, undefined, { sleep: noSleep });
    expect(result.url.startsWith(MOVIE_LINK)).toBe(true);
    expect(result.filename).toBe('movie.mkv');
    expect(result.size).toBe(5000);
    expect(countCalls(calls, '/v4.1/magnet/status')).toBe(0);
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('locked-1');
  });

  it('interroge le statut jusqu\'à ready avec des pauses de 1,5 s', async () => {
    const sleeps: number[] = [];
    const statusCodes = [0, 1, 4];
    const { client, calls } = makeClient(
      standardRoutes([{ n: 'a.mp4', s: 10, l: 'l' }], (call) => {
        if (call.path === '/v4/magnet/upload') return ok({ magnets: [uploadEntry(HASH, false, 77)] });
        if (call.path === '/v4.1/magnet/status') {
          return ok({ magnets: { id: 77, statusCode: statusCodes.shift() ?? 4 } });
        }
        return undefined;
      }),
    );
    await client.resolve(HASH, undefined, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(countCalls(calls, '/v4.1/magnet/status')).toBe(3);
    expect(sleeps).toEqual([1500, 1500]);
  });

  it('lève not_ready après 8 interrogations sans état prêt', async () => {
    const { client, calls } = makeClient(
      standardRoutes([], (call) => {
        if (call.path === '/v4/magnet/upload') return ok({ magnets: [uploadEntry(HASH, false, 77)] });
        if (call.path === '/v4.1/magnet/status') return ok({ magnets: [{ id: 77, statusCode: 2 }] });
        return undefined;
      }),
    );
    const error = await client.resolve(HASH, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllDebridError);
    expect((error as AllDebridError).code).toBe('not_ready');
    expect(countCalls(calls, '/v4.1/magnet/status')).toBe(8);
  });

  it('lève magnet_failed quand le statut est en erreur (code >= 5)', async () => {
    const { client } = makeClient(
      standardRoutes([], (call) => {
        if (call.path === '/v4/magnet/upload') return ok({ magnets: [uploadEntry(HASH, false, 77)] });
        if (call.path === '/v4.1/magnet/status') return ok({ magnets: { id: 77, statusCode: 5 } });
        return undefined;
      }),
    );
    const error = await client.resolve(HASH, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect((error as AllDebridError).code).toBe('magnet_failed');
  });

  it('accepte un statut renvoyé sous forme de tableau', async () => {
    const { client } = makeClient(
      standardRoutes([{ n: 'a.mkv', s: 1, l: 'l' }], (call) => {
        if (call.path === '/v4/magnet/upload') return ok({ magnets: [uploadEntry(HASH, false, 77)] });
        if (call.path === '/v4.1/magnet/status') return ok({ magnets: [{ id: 77, statusCode: 4 }] });
        return undefined;
      }),
    );
    const result = await client.resolve(HASH, undefined, { sleep: noSleep });
    expect(result.url).toContain(MOVIE_LINK);
  });

  it('choisit le fichier par index valide', async () => {
    const files = [
      { n: 'small.mkv', s: 100, l: 'link-small' },
      { n: 'big.mkv', s: 9000, l: 'link-big' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 0, { sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('link-small');
  });

  it('revient au plus gros fichier vidéo si l\'index est hors bornes', async () => {
    const files = [
      { n: 'small.mkv', s: 100, l: 'link-small' },
      { n: 'big.mkv', s: 9000, l: 'link-big' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 9, { sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('link-big');
  });

  it('ignore les fichiers non vidéo lors du choix automatique', async () => {
    const files = [
      { n: 'movie.mkv', s: 100, l: 'link-video' },
      { n: 'sample.nfo', s: 99999, l: 'link-nfo' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, undefined, { sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('link-video');
  });

  it('choisit l\'épisode demandé en SxxExx et en NxNN', async () => {
    const files = [
      { n: 'Show.S01E01.1080p.mkv', s: 500, l: 'e1' },
      { n: 'Show.S01E02.1080p.mkv', s: 400, l: 'e2' },
      { n: 'Show.S01E12.1080p.mkv', s: 900, l: 'e12' },
      { n: 'Show.S11E02.1080p.mkv', s: 950, l: 'e102' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, undefined, { season: 1, episode: 2, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('e2');

    const alt = [
      { n: 'show 1x02 720p.mp4', s: 300, l: 'alt-2' },
      { n: 'show 1x12 720p.mp4', s: 800, l: 'alt-12' },
    ];
    const second = makeClient(standardRoutes(alt));
    await second.client.resolve(hashOf(43), undefined, { season: 1, episode: 2, sleep: noSleep });
    expect(second.calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('alt-2');
  });

  it('parcourt les dossiers imbriqués dans l\'ordre d\'apparition', async () => {
    const files = [
      { n: 'readme.txt', s: 1, l: 'txt' },
      {
        n: 'Saison 1',
        e: [
          { n: 'ep1.mkv', s: 10, l: 'nested-ep1' },
          { n: 'Extras', e: [{ n: 'bonus.mp4', s: 20, l: 'nested-bonus' }] },
        ],
      },
      { n: 'ep2.mkv', s: 30, l: 'root-ep2' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    // Ordre aplati : 0 readme.txt, 1 ep1.mkv, 2 bonus.mp4, 3 ep2.mkv
    await client.resolve(HASH, 2, { sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('nested-bonus');

    await client.resolve(HASH, 3, { sleep: noSleep });
    expect(calls.filter((c) => c.path === '/v4/link/unlock').at(-1)?.form.get('link')).toBe('root-ep2');
  });

  it('lève no_file quand aucun fichier vidéo n\'existe', async () => {
    const { client } = makeClient(standardRoutes([{ n: 'subs.srt', s: 1, l: 'x' }]));
    const error = await client.resolve(HASH, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect((error as AllDebridError).code).toBe('no_file');
  });

  it('met en cache la résolution réussie et ne met pas en cache les échecs', async () => {
    let fail = true;
    const { client, calls } = makeClient(
      standardRoutes([{ n: 'a.mkv', s: 1, l: 'l' }], (call) => {
        if (call.path === '/v4/magnet/upload' && fail) return ok({ magnets: [uploadEntry(HASH, false, 77)] });
        if (call.path === '/v4.1/magnet/status' && fail) return ok({ magnets: { id: 77, statusCode: 1 } });
        return undefined;
      }),
    );
    await expect(client.resolve(HASH, undefined, { sleep: noSleep })).rejects.toThrow(AllDebridError);
    fail = false;
    await client.resolve(HASH, undefined, { sleep: noSleep });
    const uploadsBefore = countCalls(calls, '/v4/magnet/upload');
    await client.resolve(HASH, undefined, { sleep: noSleep });
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(uploadsBefore);
  });

  it('rejette un hash invalide sans appel réseau', async () => {
    const { client, calls } = makeClient(standardRoutes([]));
    await expect(client.resolve('xyz', undefined, { sleep: noSleep })).rejects.toMatchObject({ code: 'invalid_hash' });
    expect(calls).toHaveLength(0);
  });

  it('transmet les codes d\'erreur API sans la clé', async () => {
    const { client } = makeClient(() => apiError('LINK_HOST_NOT_SUPPORTED'));
    const error = await client.resolve(HASH, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect((error as AllDebridError).code).toBe('LINK_HOST_NOT_SUPPORTED');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('signale rate_limited sur HTTP 429', async () => {
    const { client } = makeClient(() => ({ status: 429, body: {} }));
    const error = await client.resolve(HASH, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect((error as AllDebridError).code).toBe('rate_limited');
    expect((error as Error).message).toBe('rate limited');
  });

  it('rejette un lien de déblocage qui n\'est pas une URL http(s)', async () => {
    const { client } = makeClient(
      standardRoutes([{ n: 'a.mkv', s: 1, l: 'l' }], (call) =>
        call.path === '/v4/link/unlock' ? ok({ link: 'javascript:alert(1)' }) : undefined,
      ),
    );
    const error = await client.resolve(HASH, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect((error as AllDebridError).code).toBe('invalid_response');
  });
});

describe('AllDebridClient (sécurité)', () => {
  it('envoie la clé uniquement dans l\'en-tête Authorization', async () => {
    const { client, calls } = makeClient(() => ok({ user: { isPremium: false } }));
    await client.checkApiKey();
    expect(calls[0]?.path).not.toContain(API_KEY);
    expect([...calls[0]?.form.values() ?? []].join('')).not.toContain(API_KEY);
  });

  it('ne fait jamais apparaître la clé dans les erreurs de réseau ou de réponse', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`boom ${API_KEY}`);
    }) as unknown as typeof fetch;
    const client = new AllDebridClient(API_KEY, { fetch: fetchImpl });
    const error = await client.resolve(hashOf(9), undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });
});
