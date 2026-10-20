import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TurnModule = typeof import('../src/party/turn.js');

const ENV = { TURN_KEY_ID: 'key-abc123', TURN_KEY_API_TOKEN: 'tok-SECRET-value' };
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

/** Réponse type de l'API : une entrée STUN sans identifiants, puis l'entrée TURN (STUN et port 53 à retirer). */
const ICE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
      ],
      username: 'user-1',
      credential: 'cred-1',
    },
  ],
};
const EXPECTED = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp'],
  username: 'user-1',
  credential: 'cred-1',
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchTurnIce: TurnModule['fetchTurnIce'];

beforeEach(async () => {
  // Cache du module : chaque test repart d'un module neuf.
  vi.resetModules();
  ({ fetchTurnIce } = await import('../src/party/turn.js'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchTurnIce : secrets', () => {
  it('secrets absents ou vides : null, aucun appel réseau', async () => {
    const fetchMock = vi.fn();
    for (const env of [{}, { TURN_KEY_ID: 'key-abc123' }, { TURN_KEY_API_TOKEN: 'tok' }, { TURN_KEY_ID: '  ', TURN_KEY_API_TOKEN: 'tok' }, { TURN_KEY_ID: 42, TURN_KEY_API_TOKEN: 'tok' }]) {
      await expect(fetchTurnIce(env, fetchMock as unknown as typeof fetch)).resolves.toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchTurnIce : réponse', () => {
  it('appelle l’API avec la clé, le jeton et un TTL de 24 h, puis garde l’entrée à identifiants sans STUN ni port 53', async () => {
    const fetchMock = vi.fn(async () => json(ICE));
    await expect(fetchTurnIce(ENV, fetchMock as unknown as typeof fetch)).resolves.toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-abc123/credentials/generate-ice-servers');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'Bearer tok-SECRET-value', 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 28_800 });
  });

  it('accepte un objet unique iceServers (anciennes réponses) et une chaîne pour urls', async () => {
    const single = { iceServers: { urls: 'turn:turn.example.test:3478', username: 'u-2', credential: 'c-2' } };
    await expect(fetchTurnIce(ENV, (async () => json(single)) as unknown as typeof fetch)).resolves.toEqual({
      urls: ['turn:turn.example.test:3478'],
      username: 'u-2',
      credential: 'c-2',
    });
  });

  it('une entrée dont tous les URL sont sur le port 53 ou non TURN est ignorée : null', async () => {
    const body = { iceServers: [{ urls: ['turn:turn.example.test:53?transport=udp', 'stun:stun.example.test:3478'], username: 'u', credential: 'c' }] };
    await expect(fetchTurnIce(ENV, (async () => json(body)) as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('réponse sans identifiants (ou sans iceServers) : null', async () => {
    for (const body of [{ iceServers: [{ urls: ['stun:stun.example.test:3478'] }] }, { iceServers: [] }, {}, 'texte']) {
      await expect(fetchTurnIce(ENV, (async () => json(body)) as unknown as typeof fetch)).resolves.toBeNull();
    }
  });
});

describe('fetchTurnIce : échecs', () => {
  it('statut HTTP en erreur : null, et ni le jeton ni le corps de la réponse ne sont journalisés', async () => {
    const warn = vi.mocked(console.warn);
    const fetchMock = vi.fn(async () => new Response('refusé pour tok-SECRET-value', { status: 403 }));
    await expect(fetchTurnIce(ENV, fetchMock as unknown as typeof fetch)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok-SECRET-value');
    expect(JSON.stringify(warn.mock.calls)).toContain('403');
  });

  it('erreur réseau : null, sans message d’erreur ni jeton journalisé', async () => {
    const warn = vi.mocked(console.warn);
    const fetchMock = vi.fn(async () => {
      throw new TypeError('échec pour tok-SECRET-value');
    });
    await expect(fetchTurnIce(ENV, fetchMock as unknown as typeof fetch)).resolves.toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok-SECRET-value');
    expect(JSON.stringify(warn.mock.calls)).toContain('TypeError');
  });

  it('délai de 5 s dépassé : appel interrompu, null', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('délai dépassé', 'AbortError')));
        }),
    );
    const pending = fetchTurnIce(ENV, fetchMock as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.objectContaining({ aborted: false }) });
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });

  it('un échec n’est pas mis en cache : l’appel suivant interroge à nouveau l’API', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => (++calls === 1 ? json({ error: 'panne' }, 500) : json(ICE)));
    await expect(fetchTurnIce(ENV, fetchMock as unknown as typeof fetch)).resolves.toBeNull();
    await expect(fetchTurnIce(ENV, fetchMock as unknown as typeof fetch)).resolves.toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchTurnIce : cache', () => {
  it('identifiants gardés 4 h : un seul appel, puis renouvelés', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const fetchMock = vi.fn(async () => json(ICE));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(fetchTurnIce(ENV, fetchImpl)).resolves.toEqual(EXPECTED);
    vi.setSystemTime(T0 + 3 * HOUR);
    await expect(fetchTurnIce(ENV, fetchImpl)).resolves.toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 4 * HOUR + 1);
    await expect(fetchTurnIce(ENV, fetchImpl)).resolves.toEqual(EXPECTED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('une autre clé ne reprend pas les identifiants en cache', async () => {
    const fetchMock = vi.fn(async () => json(ICE));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await fetchTurnIce(ENV, fetchImpl);
    await fetchTurnIce({ ...ENV, TURN_KEY_ID: 'key-autre' }, fetchImpl);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('secrets absents : null même si des identifiants sont en cache', async () => {
    const fetchMock = vi.fn(async () => json(ICE));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await fetchTurnIce(ENV, fetchImpl);
    await expect(fetchTurnIce({}, fetchImpl)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
