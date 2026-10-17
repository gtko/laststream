import { describe, expect, it, vi } from 'vitest';
import { AllDebridClient, AllDebridError } from '../src/sources/alldebrid.js';

const API_KEY = 'AD-TEST-KEY-NE-PAS-FUITER';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Call {
  method: string;
  path: string;
  form: URLSearchParams;
  auth: string | null;
}

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
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
      headers: { 'content-type': 'application/json', ...reply.headers },
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
  opts: { cacheTtlMs?: number; negativeCacheTtlMs?: number; now?: () => number } = {},
): { client: AllDebridClient; calls: Call[] } {
  const fake = fakeAllDebrid(responder);
  const client = new AllDebridClient(API_KEY, { fetch: fake.fetch, ...opts });
  return { client, calls: fake.calls };
}

const noSleep = async (): Promise<void> => {};

/** Répondeur du contrôle « cache » : liste du compte (`account`), upload fourni, suppression acquittée. */
function checkRoutes(upload: Responder, account: Record<string, unknown>[] = []): Responder {
  return (call) => {
    if (call.path === '/v4/magnet/upload') return upload(call);
    if (call.path === '/v4.1/magnet/status') return ok({ magnets: account });
    return ok({ message: 'ok' });
  };
}

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
  it('renvoie ready true/false et supprime seulement les magnets non prêts créés par le contrôle', async () => {
    const readyHash = hashOf(1);
    const pendingHash = hashOf(2);
    const { client, calls } = makeClient(
      checkRoutes(() => ok({ magnets: [uploadEntry(readyHash, true, 11), uploadEntry(pendingHash, false, 12)] })),
    );
    const result = await client.checkCached([readyHash, pendingHash]);
    expect(result.get(readyHash)).toBe(true);
    expect(result.get(pendingHash)).toBe(false);
    const deletions = calls.filter((c) => c.path === '/v4/magnet/delete');
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.form.get('id')).toBe('12');
  });

  it('ne supprime jamais un magnet déjà présent dans le compte (l upload renvoie son id existant)', async () => {
    const hash = hashOf(21);
    const { client, calls } = makeClient(
      checkRoutes(() => ok({ magnets: [uploadEntry(hash, false, 55)] }), [{ id: 55, statusCode: 1 }]),
    );
    const result = await client.checkCached([hash]);
    expect(result.get(hash)).toBe(false);
    expect(countCalls(calls, '/v4/magnet/delete')).toBe(0);
  });

  it('n envoie aucun magnet si la liste du compte est indisponible ou invalide', async () => {
    const hashes = [hashOf(31), hashOf(32)];
    const failing = makeClient((call) => (call.path === '/v4.1/magnet/status' ? apiError('MAINTENANCE', 500) : ok({})));
    expect((await failing.client.checkCached(hashes)).size).toBe(0);
    expect(countCalls(failing.calls, '/v4/magnet/upload')).toBe(0);

    const malformed = makeClient((call) =>
      call.path === '/v4.1/magnet/status' ? ok({ magnets: [{ statusCode: 1 }] }) : ok({}),
    );
    expect((await malformed.client.checkCached(hashes)).size).toBe(0);
    expect(countCalls(malformed.calls, '/v4/magnet/upload')).toBe(0);
  });

  it('envoie les hashes en lots de 20 maximum', async () => {
    const hashes = Array.from({ length: 45 }, (_, i) => hashOf(i + 1));
    const { client, calls } = makeClient(
      checkRoutes((call) => {
        const sent = call.form.getAll('magnets[]');
        return ok({ magnets: sent.map((h, i) => uploadEntry(h, true, i + 1)) });
      }),
    );
    const result = await client.checkCached(hashes);
    const uploads = calls.filter((c) => c.path === '/v4/magnet/upload');
    expect(uploads.map((c) => c.form.getAll('magnets[]').length).sort((a, b) => a - b)).toEqual([5, 20, 20]);
    expect(result.size).toBe(45);
  });

  it('ignore les hashes invalides et les doublons', async () => {
    const valid = hashOf(7);
    const { client, calls } = makeClient(checkRoutes(() => ok({ magnets: [uploadEntry(valid, true, 1)] })));
    const result = await client.checkCached([valid, valid.toUpperCase(), 'pas-un-hash', '']);
    expect(result.size).toBe(1);
    const sent = calls.flatMap((c) => c.form.getAll('magnets[]'));
    expect(sent).toEqual([valid]);
  });

  it('réutilise le cache pendant le TTL positif et interroge à nouveau après expiration', async () => {
    let clock = 1_000;
    const hash = hashOf(3);
    const { client, calls } = makeClient(checkRoutes(() => ok({ magnets: [uploadEntry(hash, true, 1)] })), {
      cacheTtlMs: 600_000,
      now: () => clock,
    });
    await client.checkCached([hash]);
    clock += 300_000;
    const second = await client.checkCached([hash]);
    expect(second.get(hash)).toBe(true);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    clock += 300_001;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
  });

  it('utilise par défaut un TTL positif de 6 h', async () => {
    let clock = 0;
    const hash = hashOf(8);
    const { client, calls } = makeClient(checkRoutes(() => ok({ magnets: [uploadEntry(hash, true, 1)] })), {
      now: () => clock,
    });
    await client.checkCached([hash]);
    clock = 6 * HOUR - 1;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    clock = 6 * HOUR + 1;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
  });

  it('utilise par défaut un TTL négatif de 30 min pour un hash non prêt', async () => {
    let clock = 0;
    const hash = hashOf(9);
    const { client, calls } = makeClient(checkRoutes(() => ok({ magnets: [uploadEntry(hash, false, 9)] })), {
      now: () => clock,
    });
    await client.checkCached([hash]);
    clock = 30 * MINUTE - 1;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    clock = 30 * MINUTE + 1;
    await client.checkCached([hash]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
  });

  it('utilise un TTL négatif plus court que le TTL positif', async () => {
    let clock = 0;
    const hash = hashOf(4);
    const { client, calls } = makeClient(checkRoutes(() => ok({ magnets: [uploadEntry(hash, false, 9)] })), {
      cacheTtlMs: 100_000,
      negativeCacheTtlMs: 10_000,
      now: () => clock,
    });
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
    const { client } = makeClient(
      checkRoutes((call) => {
        const sent = call.form.getAll('magnets[]');
        if (sent.includes(hashOf(1))) return apiError('X', 500);
        return ok({ magnets: sent.map((h) => uploadEntry(h, true, 1)) });
      }),
    );
    const result = await client.checkCached(hashes);
    expect(result.has(hashOf(1))).toBe(false);
    expect(result.get(hashOf(25))).toBe(true);
    expect(result.size).toBe(5);
  });

  it('ne relance pas un hash en échec de lot pendant 30 s', async () => {
    let clock = 0;
    const hash = hashOf(33);
    let failing = true;
    const { client, calls } = makeClient(
      checkRoutes(() => (failing ? apiError('MAGNET_NO_SERVER', 500) : ok({ magnets: [uploadEntry(hash, true, 1)] }))),
      { now: () => clock },
    );
    expect((await client.checkCached([hash])).has(hash)).toBe(false);
    failing = false;
    clock = 29_999;
    expect((await client.checkCached([hash])).has(hash)).toBe(false);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    clock = 30_001;
    expect((await client.checkCached([hash])).get(hash)).toBe(true);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
  });

  it('ignore les entrées magnet en erreur (inconnu)', async () => {
    const hash = hashOf(5);
    const { client } = makeClient(
      checkRoutes(() => ok({ magnets: [{ magnet: 'x', hash, error: { code: 'MAGNET_INVALID_URI' } }] })),
    );
    const result = await client.checkCached([hash]);
    expect(result.has(hash)).toBe(false);
  });

  it('limite la concurrence des lots à 3', async () => {
    const hashes = Array.from({ length: 100 }, (_, i) => hashOf(i + 1));
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = makeClient(
      checkRoutes(async (call) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return ok({ magnets: call.form.getAll('magnets[]').map((h) => uploadEntry(h, true, 1)) });
      }),
    );
    const result = await client.checkCached(hashes);
    expect(result.size).toBe(100);
    expect(maxInFlight).toBe(3);
  });

  it('supprime les magnets créés par le contrôle au plus 3 à la fois', async () => {
    const hashes = Array.from({ length: 10 }, (_, i) => hashOf(100 + i));
    let inFlight = 0;
    let maxInFlight = 0;
    const routes = checkRoutes((call) => ok({ magnets: call.form.getAll('magnets[]').map((h, i) => uploadEntry(h, false, 200 + i)) }));
    const { client, calls } = makeClient(async (call) => {
      if (call.path !== '/v4/magnet/delete') return routes(call);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok({ message: 'ok' });
    });
    const result = await client.checkCached(hashes);
    expect(result.size).toBe(10);
    expect(countCalls(calls, '/v4/magnet/delete')).toBe(10);
    expect(maxInFlight).toBe(3);
  });

  it('un contrôle concurrent pour le même hash partage l upload', async () => {
    const hash = hashOf(10);
    const { client, calls } = makeClient(
      checkRoutes(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return ok({ magnets: [uploadEntry(hash, true, 1)] });
      }),
    );
    const [first, second] = await Promise.all([client.checkCached([hash]), client.checkCached([hash])]);
    expect(first.get(hash)).toBe(true);
    expect(second.get(hash)).toBe(true);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
  });

  it('HTTP 429 : aucun nouvel essai en boucle, recul selon Retry-After puis reprise', async () => {
    let clock = 0;
    const hash = hashOf(34);
    let limited = true;
    const { client, calls } = makeClient(
      checkRoutes(() =>
        limited ? { status: 429, body: {}, headers: { 'retry-after': '45' } } : ok({ magnets: [uploadEntry(hash, true, 1)] }),
      ),
      { now: () => clock },
    );
    expect((await client.checkCached([hash])).size).toBe(0);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);

    const before = calls.length;
    clock = 10_000;
    expect((await client.checkCached([hashOf(35)])).size).toBe(0);
    expect(calls.length).toBe(before);

    limited = false;
    clock = 45_001;
    expect((await client.checkCached([hash])).get(hash)).toBe(true);
  });

  it.each([429, 503])('HTTP %i sans Retry-After : recul de 30 s', async (status) => {
    let clock = 0;
    const hash = hashOf(36);
    let limited = true;
    const { client, calls } = makeClient(
      checkRoutes(() => (limited ? { status, body: {} } : ok({ magnets: [uploadEntry(hash, true, 1)] }))),
      { now: () => clock },
    );
    await client.checkCached([hash]);
    const before = calls.length;
    clock = 29_999;
    await client.checkCached([hashOf(37)]);
    expect(calls.length).toBe(before);

    limited = false;
    clock = 30_001;
    expect((await client.checkCached([hash])).get(hash)).toBe(true);
  });

  it('ne supprime pas un magnet d une résolution en cours et n envoie rien pour ce hash', async () => {
    const hash = hashOf(40);
    let released = false;
    let releasePoll: () => void = () => {};
    const polling = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let signalPolling: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalPolling = resolve;
    });
    const { client, calls } = makeClient((call) => {
      switch (call.path) {
        case '/v4/magnet/upload':
          return ok({ magnets: [uploadEntry(hash, false, 77)] });
        case '/v4.1/magnet/status':
          return ok({ magnets: { id: 77, statusCode: released ? 4 : 1 } });
        case '/v4/magnet/files':
          return ok({ magnets: [{ id: 77, files: [{ n: 'movie.mkv', s: 5000, l: 'locked' }] }] });
        case '/v4/link/unlock':
          return ok({ link: 'https://dl.alldebrid.example/movie.mkv', filename: 'movie.mkv', filesize: 5000 });
        default:
          return ok({ message: 'ok' });
      }
    });
    const pending = client.resolve(hash, undefined, {
      sleep: async () => {
        signalPolling();
        await polling;
      },
    });
    await started;

    const during = await client.checkCached([hash]);
    expect(during.has(hash)).toBe(false);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    expect(countCalls(calls, '/v4/magnet/delete')).toBe(0);

    released = true;
    releasePoll();
    const link = await pending;
    expect(link.url).toBe('https://dl.alldebrid.example/movie.mkv');
    expect(countCalls(calls, '/v4/magnet/delete')).toBe(0);
  });

  it('un contrôle déjà en cours ne supprime pas le magnet d une résolution lancée pendant ce contrôle', async () => {
    const hash = hashOf(41);
    let uploads = 0;
    let releaseCheck: () => void = () => {};
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let signalCheck: () => void = () => {};
    const checkStarted = new Promise<void>((resolve) => {
      signalCheck = resolve;
    });
    const { client, calls } = makeClient((call) => {
      switch (call.path) {
        case '/v4/magnet/upload':
          uploads += 1;
          if (uploads === 1) {
            signalCheck();
            return checkGate.then(() => ok({ magnets: [uploadEntry(hash, false, 88)] }));
          }
          return ok({ magnets: [uploadEntry(hash, true, 88)] });
        case '/v4.1/magnet/status':
          return call.form.has('id') ? ok({ magnets: { id: 88, statusCode: 4 } }) : ok({ magnets: [] });
        case '/v4/magnet/files':
          return ok({ magnets: [{ id: 88, files: [{ n: 'movie.mkv', s: 5000, l: 'locked' }] }] });
        case '/v4/link/unlock':
          return ok({ link: 'https://dl.alldebrid.example/movie.mkv', filename: 'movie.mkv', filesize: 5000 });
        default:
          return ok({ message: 'ok' });
      }
    });
    const checking = client.checkCached([hash]);
    await checkStarted;
    const resolving = client.resolve(hash, undefined, { sleep: noSleep });
    releaseCheck();

    const [checkResult, link] = await Promise.all([checking, resolving]);
    expect(checkResult.get(hash)).toBe(false);
    expect(countCalls(calls, '/v4/magnet/delete')).toBe(0);
    expect(link.url).toBe('https://dl.alldebrid.example/movie.mkv');
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(2);
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

  it('choisit le fichier dont la taille correspond à la taille attendue', async () => {
    const files = [
      { n: 'small.mkv', s: 100, l: 'link-small' },
      { n: 'big.mkv', s: 9000, l: 'link-big' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 0, { size: 100, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('link-small');
  });

  it('ignore l index Stremio quand la taille attendue ne correspond pas', async () => {
    const files = [
      { n: 'small.mkv', s: 100, l: 'link-small' },
      { n: 'big.mkv', s: 9000, l: 'link-big' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 0, { size: 9000, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('link-big');
  });

  it('ignore l index sans nom ni taille attendus et prend le plus gros fichier vidéo', async () => {
    const files = [
      { n: 'small.mkv', s: 100, l: 'link-small' },
      { n: 'big.mkv', s: 9000, l: 'link-big' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 0, { sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('link-big');
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
    // Ordre aplati : 0 readme.txt, 1 ep1.mkv, 2 bonus.mp4, 3 ep2.mkv ; l'index n'est suivi que si la taille concorde.
    await client.resolve(HASH, 2, { size: 20, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('nested-bonus');

    await client.resolve(hashOf(44), 3, { size: 30, sleep: noSleep });
    expect(calls.filter((c) => c.path === '/v4/link/unlock').at(-1)?.form.get('link')).toBe('root-ep2');
  });

  it('pack : le nom attendu prime sur un index et une taille qui désignent un autre épisode', async () => {
    const files = [
      { n: 'Pack/Show.S01E01.1080p.mkv', s: 500, l: 'e1' },
      { n: 'Pack/Show.S01E02.1080p.mkv', s: 400, l: 'e2' },
      { n: 'Pack/Show.S01E03.1080p.mkv', s: 900, l: 'e3' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 2, { filename: 'Show.S01E02.1080p.mkv', size: 900, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('e2');
  });

  it('pack : le nom attendu accepte une extension absente ou une casse différente', async () => {
    const files = [
      { n: 'Pack/Show.S01E01.1080p.mkv', s: 500, l: 'e1' },
      { n: 'Pack/Show.S01E02.1080p.mkv', s: 400, l: 'e2' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, undefined, { filename: 'show.s01e01.1080p', sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('e1');
  });

  it('pack : la taille attendue désigne le fichier quand l index pointe ailleurs', async () => {
    const files = [
      { n: 'Pack/Show.S01E01.1080p.mkv', s: 500, l: 'e1' },
      { n: 'Pack/Show.S01E02.1080p.mkv', s: 400, l: 'e2' },
      { n: 'Pack/Show.S01E03.1080p.mkv', s: 900, l: 'e3' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 2, { size: 400, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('e2');
  });

  it('pack : l épisode demandé prime sur un index sans correspondance', async () => {
    const files = [
      { n: 'Show.S01E01.1080p.mkv', s: 900, l: 'e1' },
      { n: 'Show.S01E02.1080p.mkv', s: 400, l: 'e2' },
      { n: 'Show.S01E03.1080p.mkv', s: 500, l: 'e3' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 0, { season: 1, episode: 3, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('e3');
  });

  it('pack : sans nom, taille ni épisode, l index est ignoré et le plus gros fichier vidéo gagne', async () => {
    const files = [
      { n: 'Show.S01E01.1080p.mkv', s: 900, l: 'e1' },
      { n: 'Show.S01E02.1080p.mkv', s: 400, l: 'e2' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 1, { sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('e1');
  });

  it('pack : l index départage deux fichiers de même taille', async () => {
    const files = [
      { n: 'a.mkv', s: 400, l: 'a-link' },
      { n: 'b.mkv', s: 400, l: 'b-link' },
      { n: 'c.mkv', s: 100, l: 'c-link' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    await client.resolve(HASH, 1, { size: 400, sleep: noSleep });
    expect(calls.find((c) => c.path === '/v4/link/unlock')?.form.get('link')).toBe('b-link');
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

  it('dédoublonne les résolutions concurrentes d un même hash : un seul upload, un lien par sélection', async () => {
    const files = [
      { n: 'small.mkv', s: 100, l: 'link-small' },
      { n: 'big.mkv', s: 9000, l: 'link-big' },
    ];
    const { client, calls } = makeClient(standardRoutes(files));
    const [small, big] = await Promise.all([
      client.resolve(HASH, 0, { size: 100, sleep: noSleep }),
      client.resolve(HASH, 1, { size: 9000, sleep: noSleep }),
    ]);
    expect(countCalls(calls, '/v4/magnet/upload')).toBe(1);
    expect(calls.filter((c) => c.path === '/v4/link/unlock').map((c) => c.form.get('link'))).toEqual(
      expect.arrayContaining(['link-small', 'link-big']),
    );
    expect(small.url).toContain(MOVIE_LINK);
    expect(big.url).toContain(MOVIE_LINK);
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

describe('AllDebridClient (garde réseau : redirections et taille du corps)', () => {
  const okBody = JSON.stringify({ status: 'success', data: { user: { isPremium: false } } });

  it('la requête part avec redirect manual', async () => {
    const fetchImpl = vi.fn(async () => new Response(okBody, { status: 200 }));
    const client = new AllDebridClient(API_KEY, { fetch: fetchImpl as unknown as typeof fetch });
    await client.checkApiKey();
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]?.redirect).toBe('manual');
  });

  it('une redirection n est pas suivie : réponse invalide après un seul appel', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/x' } }));
    const client = new AllDebridClient(API_KEY, { fetch: fetchImpl as unknown as typeof fetch });
    expect(await client.checkApiKey()).toEqual({ ok: false, error: 'invalid_response' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('corps au-delà de 2 Mo : réponse invalide, lecture interrompue', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const client = new AllDebridClient(API_KEY, { fetch: fetchImpl as unknown as typeof fetch });
    const result = await client.checkApiKey();
    expect(result).toEqual({ ok: false, error: 'invalid_response' });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});

describe('AllDebridClient.uploadTorrentFile (multipart)', () => {
  const TORRENT = Buffer.from('d4:infod6:lengthi3e4:name3:abcee', 'latin1');
  const HASH_FILE = hashOf(42);

  interface Sent {
    url: string;
    method: string;
    contentType: string | null;
    body: Buffer | undefined;
    auth: string | null;
  }

  /** fetch simulé qui garde le corps brut (multipart) ; `reply` reçoit le chemin et donne la réponse. */
  function sentFetch(reply: (path: string) => Reply): { fetch: typeof fetch; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      sent.push({
        url: url.toString(),
        method: init?.method ?? 'GET',
        contentType: headers.get('content-type'),
        body: init?.body instanceof Uint8Array ? Buffer.from(init.body) : undefined,
        auth: headers.get('authorization'),
      });
      const found = reply(url.pathname);
      return new Response(JSON.stringify(found.body), {
        status: found.status ?? 200,
        headers: { 'content-type': 'application/json', ...found.headers },
      });
    };
    return { fetch: fetchImpl as unknown as typeof fetch, sent };
  }

  it('POST /v4/magnet/upload/file en multipart/form-data : boundary, champ files[], octets exacts', async () => {
    const { fetch, sent } = sentFetch(() => ok({ magnets: [{ id: 77, ready: true, hash: HASH_FILE, name: 'x' }] }));
    const client = new AllDebridClient(API_KEY, { fetch });

    const result = await client.uploadTorrentFile(TORRENT, 'film.torrent');

    expect(result).toEqual({ id: '77', ready: true, hash: HASH_FILE });
    const call = sent[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toMatch(/\/v4\/magnet\/upload\/file$/);
    const match = /^multipart\/form-data; boundary=(----lastaddon[0-9a-f]{32})$/.exec(call?.contentType ?? '');
    expect(match).not.toBeNull();
    const boundary = match?.[1] ?? '';
    const body = call?.body ?? Buffer.alloc(0);
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="film.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`;
    expect(body.subarray(0, head.length).toString('latin1')).toBe(head);
    expect(body.subarray(head.length, head.length + TORRENT.length)).toEqual(TORRENT);
    expect(body.subarray(head.length + TORRENT.length).toString('latin1')).toBe(`\r\n--${boundary}--\r\n`);
    expect(call?.auth).toBe(`Bearer ${API_KEY}`);
    expect(call?.url).not.toContain(API_KEY);
  });

  it('boundary aléatoire : deux envois n’ont pas la même boundary', async () => {
    const { fetch, sent } = sentFetch(() => ok({ magnets: [{ id: 1, ready: false, hash: HASH_FILE }] }));
    const client = new AllDebridClient(API_KEY, { fetch });

    await client.uploadTorrentFile(TORRENT);
    await client.uploadTorrentFile(TORRENT);

    expect(sent[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent[0]?.contentType).not.toBe(sent[1]?.contentType);
  });

  it('nom de fichier assaini (guillemets, antislash, sauts de ligne) ; sans nom : lastaddon.torrent', async () => {
    const { fetch, sent } = sentFetch(() => ok({ magnets: [{ id: 1, ready: true, hash: HASH_FILE }] }));
    const client = new AllDebridClient(API_KEY, { fetch });

    await client.uploadTorrentFile(TORRENT, 'a"b\\c\r\nd.torrent');
    await client.uploadTorrentFile(TORRENT);

    expect(sent[0]?.body?.toString('latin1')).toContain('filename="a_b_c__d.torrent"');
    expect(sent[1]?.body?.toString('latin1')).toContain('filename="lastaddon.torrent"');
  });

  it('erreur API : code générique, ni octets ni clé dans l’erreur', async () => {
    const { fetch } = sentFetch(() => apiError('AUTH_BAD_APIKEY', 401));
    const client = new AllDebridClient(API_KEY, { fetch });

    const error = await client.uploadTorrentFile(TORRENT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AllDebridError);
    expect((error as AllDebridError).code).toBe('AUTH_BAD_APIKEY');
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('réponse sans hash valide : invalid_response', async () => {
    const { fetch } = sentFetch(() => ok({ magnets: [{ id: 1, ready: true, hash: 'pas-un-hash' }] }));
    const client = new AllDebridClient(API_KEY, { fetch });

    const error = await client.uploadTorrentFile(TORRENT).catch((e: unknown) => e);

    expect((error as AllDebridError).code).toBe('invalid_response');
  });
});

describe('AllDebridClient.resolveTorrentFile (torrent privé)', () => {
  const TORRENT = Buffer.from('d4:infod6:lengthi3e4:name3:abcee', 'latin1');
  const HASH_FILE = hashOf(42);

  function routedFetch(routes: (path: string, body: Buffer | undefined) => Reply) {
    const sent: { path: string; body: Buffer | undefined }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
      sent.push({ path, body });
      const found = routes(path, body);
      return new Response(JSON.stringify(found.body), {
        status: found.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetch: fetchImpl as unknown as typeof fetch, sent };
  }

  it('envoie le fichier (jamais le magnet), attend le statut prêt, choisit le fichier et déverrouille', async () => {
    const files = [
      { n: 'readme.txt', s: 10, l: 'https://dl.example/readme' },
      { n: 'Film.2024.mkv', s: 5000, l: 'https://dl.example/film' },
    ];
    let statusCalls = 0;
    const { fetch, sent } = routedFetch((path) => {
      switch (path) {
        case '/v4/magnet/upload/file':
          return ok({ magnets: [{ id: 77, ready: false, hash: HASH_FILE }] });
        case '/v4.1/magnet/status':
          statusCalls += 1;
          return ok({ magnets: { id: 77, statusCode: statusCalls >= 2 ? 4 : 1 } });
        case '/v4/magnet/files':
          return ok({ magnets: [{ id: 77, files }] });
        case '/v4/link/unlock':
          return ok({ link: 'https://dl.example/unlocked.mkv', filename: 'Film.2024.mkv', filesize: 5000 });
        default:
          return apiError('UNEXPECTED', 404);
      }
    });
    const client = new AllDebridClient(API_KEY, { fetch });

    const link = await client.resolveTorrentFile(TORRENT, HASH_FILE, undefined, { sleep: noSleep, size: 5000 });

    expect(link.url).toBe('https://dl.example/unlocked.mkv');
    expect(statusCalls).toBe(2);
    const paths = sent.map((call) => call.path);
    expect(paths).toContain('/v4/magnet/upload/file');
    expect(paths).not.toContain('/v4/magnet/upload');
    const uploaded = sent.find((call) => call.path === '/v4/magnet/upload/file')?.body ?? Buffer.alloc(0);
    expect(uploaded.indexOf(TORRENT)).toBeGreaterThan(0);
    expect(sent.some((call) => (call.body?.toString('latin1') ?? '').includes(API_KEY))).toBe(false);
  });

  it('octets vides refusés (invalid_torrent) sans aucun appel réseau', async () => {
    const { fetch, sent } = routedFetch(() => ok({}));
    const client = new AllDebridClient(API_KEY, { fetch });

    const error = await client.resolveTorrentFile(Buffer.alloc(0), HASH_FILE).catch((e: unknown) => e);

    expect((error as AllDebridError).code).toBe('invalid_torrent');
    expect(sent).toHaveLength(0);
  });

  it('même hash par fichier puis par magnet : deux préparations distinctes, aucun partage', async () => {
    const files = [{ n: 'Film.mkv', s: 5000, l: 'https://dl.example/film' }];
    const { fetch, sent } = routedFetch((path) => {
      switch (path) {
        case '/v4/magnet/upload/file':
          return ok({ magnets: [{ id: 77, ready: true, hash: HASH_FILE }] });
        case '/v4/magnet/upload':
          return ok({ magnets: [uploadEntry(HASH_FILE, true, 88)] });
        case '/v4/magnet/files':
          return ok({ magnets: [{ id: 77, files }] });
        case '/v4/link/unlock':
          return ok({ link: 'https://dl.example/u.mkv' });
        default:
          return apiError('UNEXPECTED', 404);
      }
    });
    const client = new AllDebridClient(API_KEY, { fetch });

    await client.resolveTorrentFile(TORRENT, HASH_FILE);
    await client.resolve(HASH_FILE);

    const paths = sent.map((call) => call.path);
    expect(paths.filter((path) => path === '/v4/magnet/upload/file')).toHaveLength(1);
    expect(paths.filter((path) => path === '/v4/magnet/upload')).toHaveLength(1);
  });
});
