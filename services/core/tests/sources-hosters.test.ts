import { describe, expect, it, vi } from 'vitest';
import { AllDebridClient, AllDebridError } from '../src/sources/alldebrid.js';
import { HosterClient } from '../src/sources/hosters.js';
import { RESOLVE_ERROR_CODES } from '../src/play/failover.js';

const API_KEY = 'AD-TEST-KEY-NE-PAS-FUITER';
const HOUR = 3_600_000;
const HOSTS_TTL_MS = 12 * HOUR;

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
const apiError = (code: string): Reply => ({
  status: 400,
  body: { status: 'error', error: { code, message: `message ${code}` } },
});

const HOSTS = [
  {
    name: '1fichier',
    domains: ['1fichier.com'],
    regexps: ['^https?://(?:[a-z0-9-]+\\.)?1fichier\\.com/[a-z0-9]+'],
  },
  { name: 'Uptobox', domains: ['uptobox.com'], regexps: [] },
  { name: 'Mega', domains: [], regexps: ['^https://mega\\.nz/file/'] },
];

interface Harness {
  hoster: HosterClient;
  calls: Call[];
  clock: { now: number };
}

/** Client hébergeurs branché sur un AllDebridClient simulé ; horloge partagée et injectée. */
function harness(responder: Responder, start = 1_000_000): Harness {
  const fake = fakeAllDebrid(responder);
  const clock = { now: start };
  const api = new AllDebridClient(API_KEY, { fetch: fake.fetch, now: () => clock.now });
  const hoster = new HosterClient(api, { now: () => clock.now });
  return { hoster, calls: fake.calls, clock };
}

/** Répondeur par défaut : le catalogue sur /v4/user/hosts, une erreur explicite sur toute autre route. */
function hostsRoute(call: Call): Reply {
  return call.path === '/v4/user/hosts' ? ok({ hosts: HOSTS }) : apiError('unexpected');
}

function countCalls(calls: Call[], path: string): number {
  return calls.filter((call) => call.path === path).length;
}

describe('HosterClient.getHosts', () => {
  it('lit la liste, normalise les domaines et ignore les regexps invalides', async () => {
    const { hoster, calls } = harness(() =>
      ok({
        hosts: [{ name: 'Test', domains: ['  Example.COM. ', 'pas un domaine'], regexps: ['([', '^https://ok/'] }],
      }),
    );
    const hosts = await hoster.getHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.name).toBe('Test');
    expect(hosts[0]?.domains).toEqual(['example.com']);
    expect(hosts[0]?.patterns).toHaveLength(1);
    expect(hosts[0]?.patterns[0]?.test('https://ok/x')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v4/user/hosts', auth: `Bearer ${API_KEY}` });
  });

  it('accepte la forme indexée par domaine', async () => {
    const { hoster } = harness(() => ok({ hosts: { '1fichier.com': { name: '1fichier', regexps: [] } } }));
    const hosts = await hoster.getHosts();
    expect(hosts).toEqual([{ name: '1fichier', domains: ['1fichier.com'], patterns: [] }]);
  });

  it('garde la liste 12 h : une seule requête avant l’échéance, une nouvelle après', async () => {
    const { hoster, calls, clock } = harness(hostsRoute);
    await hoster.getHosts();
    clock.now += HOSTS_TTL_MS - 1;
    await hoster.getHosts();
    expect(countCalls(calls, '/v4/user/hosts')).toBe(1);
    clock.now += 1;
    await hoster.getHosts();
    expect(countCalls(calls, '/v4/user/hosts')).toBe(2);
  });

  it('partage une requête unique entre appels concurrents', async () => {
    const { hoster, calls } = harness(async (call) => {
      await Promise.resolve();
      return hostsRoute(call);
    });
    const [first, second] = await Promise.all([hoster.getHosts(), hoster.getHosts()]);
    expect(first).toBe(second);
    expect(countCalls(calls, '/v4/user/hosts')).toBe(1);
  });

  it('liste vide : erreur invalid_response traduite en unknown', async () => {
    const { hoster } = harness(() => ok({ hosts: [] }));
    await expect(hoster.getHosts()).rejects.toMatchObject({ code: 'unknown' });
  });

  it('clé refusée : code invalid_key, sans la clé dans le message', async () => {
    const { hoster } = harness(() => apiError('AUTH_BAD_APIKEY'));
    const err = await hoster.getHosts().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AllDebridError);
    expect(err).toMatchObject({ code: 'invalid_key' });
    expect((err as Error).message).not.toContain(API_KEY);
  });
});

describe('HosterClient.isHosterUrl et hosterFor', () => {
  it('renvoie faux tant que le catalogue n’est pas chargé', () => {
    const { hoster } = harness(hostsRoute);
    expect(hoster.isHosterUrl('https://1fichier.com/?abc123')).toBe(false);
    expect(hoster.hosterFor('https://1fichier.com/?abc123')).toBeUndefined();
  });

  it('reconnaît le domaine, les sous-domaines et les regexps après chargement', async () => {
    const { hoster } = harness(hostsRoute);
    await hoster.getHosts();
    expect(hoster.isHosterUrl('https://1fichier.com/?abc123')).toBe(true);
    expect(hoster.hosterFor('https://cdn7.1fichier.com/x')?.name).toBe('1fichier');
    expect(hoster.hosterFor('https://uptobox.com/abc')?.name).toBe('Uptobox');
    expect(hoster.hosterFor('https://mega.nz/file/XYZ')?.name).toBe('Mega');
    expect(hoster.hosterFor('https://mega.nz/folder/XYZ')).toBeUndefined();
  });

  it('refuse le streaming direct non listé et les schémas non http', async () => {
    const { hoster } = harness(hostsRoute);
    await hoster.getHosts();
    expect(hoster.isHosterUrl('https://example.com/video.mp4')).toBe(false);
    expect(hoster.isHosterUrl('magnet:?xt=urn:btih:0000000000000000000000000000000000000000')).toBe(false);
    expect(hoster.isHosterUrl('ftp://1fichier.com/x')).toBe(false);
    expect(hoster.isHosterUrl('pas une url')).toBe(false);
  });
});

describe('HosterClient.linkInfos', () => {
  const A = 'https://1fichier.com/aaa111';
  const B = 'https://1fichier.com/bbb222';

  it('renvoie vivant ou mort par lien, avec nom, taille, domaine et code d’erreur', async () => {
    const { hoster, calls } = harness((call) => {
      if (call.path !== '/v4/link/infos') return hostsRoute(call);
      return ok({
        infos: [
          { link: A, filename: 'film.mkv', size: 123, hostDomain: '1fichier.com' },
          { link: B, error: { code: 'LINK_DOWN', message: 'down' } },
        ],
      });
    });
    const infos = await hoster.linkInfos([A, B]);
    expect(infos.get(A)).toEqual({ url: A, alive: true, filename: 'film.mkv', size: 123, hostDomain: '1fichier.com', errorCode: undefined });
    expect(infos.get(B)).toMatchObject({ url: B, alive: false, errorCode: 'LINK_DOWN' });
    const infosCall = calls.find((call) => call.path === '/v4/link/infos');
    expect(infosCall?.form.getAll('link[]')).toEqual([A, B]);
  });

  it('découpe en lots de 20 liens', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://1fichier.com/item${i}`);
    const { hoster, calls } = harness((call) => {
      if (call.path !== '/v4/link/infos') return hostsRoute(call);
      const echoed = call.form.getAll('link[]').map((link) => ({ link, filename: link.slice(-6) }));
      return ok({ infos: echoed });
    });
    const infos = await hoster.linkInfos(urls);
    expect(countCalls(calls, '/v4/link/infos')).toBe(2);
    expect(infos.size).toBe(25);
    expect(infos.get(urls[24])?.filename).toBe('item24');
  });

  it('omet les liens d’un lot en erreur, garde les autres lots', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://1fichier.com/x${i}`);
    let batch = 0;
    const { hoster } = harness((call) => {
      if (call.path !== '/v4/link/infos') return hostsRoute(call);
      batch += 1;
      if (batch === 1) return { status: 500, body: {} };
      return ok({ infos: call.form.getAll('link[]').map((link) => ({ link })) });
    });
    const infos = await hoster.linkInfos(urls);
    expect(infos.size).toBe(5);
    expect(infos.has(urls[0])).toBe(false);
    expect(infos.get(urls[20])?.alive).toBe(true);
  });

  it('apparie par position quand la réponse ne rend pas le lien', async () => {
    const { hoster } = harness((call) => {
      if (call.path !== '/v4/link/infos') return hostsRoute(call);
      return ok({ infos: [{ filename: 'un.mkv' }, { error: { code: 'LINK_ERROR' } }] });
    });
    const infos = await hoster.linkInfos([A, B]);
    expect(infos.get(A)).toMatchObject({ alive: true, filename: 'un.mkv' });
    expect(infos.get(B)).toMatchObject({ alive: false, errorCode: 'LINK_ERROR' });
  });

  it('ignore les URL non http sans aucun appel', async () => {
    const { hoster, calls } = harness(hostsRoute);
    const infos = await hoster.linkInfos(['magnet:?xt=urn:btih:abc', 'ftp://a.example/x']);
    expect(infos.size).toBe(0);
    expect(countCalls(calls, '/v4/link/infos')).toBe(0);
  });
});

describe('HosterClient.unlock', () => {
  const LINK = 'https://1fichier.com/abc';
  const DIRECT = 'https://dl.example.test/file/abc';

  it('lien direct : URL, nom de fichier et taille', async () => {
    const { hoster, calls } = harness((call) => {
      if (call.path !== '/v4/link/unlock') return hostsRoute(call);
      return ok({ link: DIRECT, filename: 'film.mkv', filesize: 999 });
    });
    const result = await hoster.unlock(LINK);
    expect(result).toEqual({ url: DIRECT, filename: 'film.mkv', size: 999 });
    expect(calls.find((call) => call.path === '/v4/link/unlock')?.form.get('link')).toBe(LINK);
  });

  it('lien différé : interroge /v4/link/delayed jusqu’au lien', async () => {
    let polls = 0;
    const { hoster, calls } = harness((call) => {
      if (call.path === '/v4/link/unlock') return ok({ delayed: 42 });
      if (call.path === '/v4/link/delayed') {
        polls += 1;
        return polls < 3 ? ok({ status: 0 }) : ok({ link: DIRECT, filename: 'a.mkv' });
      }
      return apiError('unexpected');
    });
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    const result = await hoster.unlock(LINK, { sleep });
    expect(result.url).toBe(DIRECT);
    expect(countCalls(calls, '/v4/link/delayed')).toBe(3);
    expect(calls.find((call) => call.path === '/v4/link/delayed')?.form.get('id')).toBe('42');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('lien différé : budget épuisé → not_ready', async () => {
    const { hoster, calls } = harness((call) => {
      if (call.path === '/v4/link/unlock') return ok({ delayed: 'abc42' });
      return call.path === '/v4/link/delayed' ? ok({ status: 0 }) : apiError('unexpected');
    });
    const sleep = vi.fn(async (_ms: number): Promise<void> => undefined);
    await expect(hoster.unlock(LINK, { sleep, delayBudgetMs: 3000 })).rejects.toMatchObject({ code: 'not_ready' });
    expect(countCalls(calls, '/v4/link/delayed')).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('lien différé : annulation de l’appelant → arrêt de l’attente', async () => {
    const controller = new AbortController();
    controller.abort();
    const { hoster, calls } = harness((call) => {
      if (call.path === '/v4/link/unlock') return ok({ delayed: 7 });
      return apiError('unexpected');
    });
    await expect(hoster.unlock(LINK, { signal: controller.signal })).rejects.toMatchObject({ code: 'not_ready' });
    expect(countCalls(calls, '/v4/link/delayed')).toBe(0);
  });

  it('flux : choisit la meilleure qualité via /v4/link/streaming', async () => {
    const { hoster, calls } = harness((call) => {
      if (call.path === '/v4/link/unlock') {
        return ok({
          id: 'L1',
          link: DIRECT,
          filename: 'f.mkv',
          streams: [
            { id: 's1', quality: 480 },
            { id: 's2', quality: '1080p' },
            { id: 's3', quality: 720 },
          ],
        });
      }
      if (call.path === '/v4/link/streaming') return ok({ link: 'https://stream.example.test/1080' });
      return apiError('unexpected');
    });
    const result = await hoster.unlock(LINK);
    expect(result.url).toBe('https://stream.example.test/1080');
    const streaming = calls.find((call) => call.path === '/v4/link/streaming');
    expect(streaming?.form.get('id')).toBe('L1');
    expect(streaming?.form.get('stream')).toBe('s2');
  });

  it('flux sans lien de streaming : repli sur le lien direct', async () => {
    const { hoster } = harness((call) => {
      if (call.path === '/v4/link/unlock') return ok({ id: 'L1', link: DIRECT, streams: [{ id: 's1', quality: 720 }] });
      if (call.path === '/v4/link/streaming') return ok({});
      return apiError('unexpected');
    });
    expect((await hoster.unlock(LINK)).url).toBe(DIRECT);
  });

  it('flux en erreur avec lien direct : repli sur le lien direct', async () => {
    const { hoster } = harness((call) => {
      if (call.path === '/v4/link/unlock') return ok({ id: 'L1', link: DIRECT, streams: [{ id: 's1', quality: 720 }] });
      if (call.path === '/v4/link/streaming') return apiError('LINK_ERROR');
      return apiError('unexpected');
    });
    expect((await hoster.unlock(LINK)).url).toBe(DIRECT);
  });

  it('flux en erreur sans lien direct : erreur mappée', async () => {
    const { hoster } = harness((call) => {
      if (call.path === '/v4/link/unlock') return ok({ id: 'L1', streams: [{ id: 's1', quality: 720 }] });
      if (call.path === '/v4/link/streaming') return apiError('LINK_ERROR');
      return apiError('unexpected');
    });
    await expect(hoster.unlock(LINK)).rejects.toMatchObject({ code: 'dead_link' });
  });

  it('réponse sans lien HTTP valide : unknown', async () => {
    const { hoster } = harness((call) =>
      call.path === '/v4/link/unlock' ? ok({ link: 'ftp://example.test/x' }) : apiError('unexpected'),
    );
    await expect(hoster.unlock(LINK)).rejects.toMatchObject({ code: 'unknown' });
  });

  it('URL non http : refusée sans appel réseau', async () => {
    const { hoster, calls } = harness(hostsRoute);
    await expect(hoster.unlock('magnet:?xt=urn:btih:abc')).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toHaveLength(0);
  });
});

describe('erreurs AllDebrid traduites en codes du failover', () => {
  const LINK = 'https://1fichier.com/secret-link-123';
  const cases: [string, string][] = [
    ['AUTH_BAD_APIKEY', 'invalid_key'],
    ['AUTH_MISSING_APIKEY', 'invalid_key'],
    ['MUST_BE_PREMIUM', 'subscription_expired'],
    ['FREE_TRIAL_LIMIT_REACHED', 'quota'],
    ['LINK_HOST_UNAVAILABLE', 'host_unavailable'],
    ['LINK_HOST_FULL', 'host_unavailable'],
    ['LINK_DOWN', 'dead_link'],
    ['LINK_ERROR', 'dead_link'],
    ['LINK_HOST_NOT_SUPPORTED', 'unsupported'],
    ['CODE_INCONNU', 'unknown'],
    ['constructor', 'unknown'],
  ];

  it.each(cases)('%s devient %s, sans clé ni lien dans le message', async (apiCode, expected) => {
    const { hoster } = harness((call) => (call.path === '/v4/link/unlock' ? apiError(apiCode) : apiError('unexpected')));
    const err = await hoster.unlock(LINK).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AllDebridError);
    expect(err).toMatchObject({ code: expected });
    expect(RESOLVE_ERROR_CODES).toContain(expected);
    const text = `${(err as Error).message} ${(err as Error).name}`;
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(LINK);
  });

  it('erreur réseau et délai : unknown', async () => {
    const failing = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    const api = new AllDebridClient(API_KEY, { fetch: failing as unknown as typeof fetch });
    const hoster = new HosterClient(api);
    await expect(hoster.unlock(LINK)).rejects.toMatchObject({ code: 'unknown' });
    await expect(hoster.getHosts()).rejects.toMatchObject({ code: 'unknown' });
  });

  it('limitation HTTP 429 : unknown, sans nouvel essai', async () => {
    const { hoster, calls } = harness(() => ({ status: 429, body: {} }));
    await expect(hoster.unlock(LINK)).rejects.toMatchObject({ code: 'unknown' });
    await expect(hoster.unlock(LINK)).rejects.toMatchObject({ code: 'unknown' });
    expect(calls).toHaveLength(1);
  });
});
