import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPinnedAgent, pinnedLookup } from '../src/platform/node/http-client.js';
import {
  checkOutboundUrl,
  fetchBytes,
  SourceError,
  UnsafeTargetError,
  type FetchFn,
  type HostLookup,
} from '../src/sources/http.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Appelle le lookup épinglé pour un hôte fictif et renvoie le résultat du callback. */
function lookupCall(
  resolver: HostLookup,
  options: { all?: boolean } = {},
): Promise<{ err: Error | null; address?: unknown; family?: number }> {
  const lookup = pinnedLookup(resolver);
  return new Promise((resolve) => {
    lookup('pinned.example.test', options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('pinnedLookup : une résolution, contrôle de toutes les adresses', () => {
  it('option all absente : première adresse publique et sa famille', async () => {
    const result = await lookupCall(async () => ['93.184.216.34']);
    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
    const v6 = await lookupCall(async () => ['2606:4700:4700::1111']);
    expect(v6.family).toBe(6);
  });

  it('option all : toutes les adresses publiques, avec leur famille', async () => {
    const result = await lookupCall(async () => ['93.184.216.34', '2606:4700:4700::1111'], { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it.each(['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.0.1', '172.16.4.4', '192.168.1.9', 'fd00::1', '::1', '::ffff:10.0.0.1'])(
    'une seule adresse non publique (%s) refuse toute la résolution',
    async (privateAddress) => {
      const result = await lookupCall(async () => ['93.184.216.34', privateAddress]);
      expect(result.err).toBeInstanceOf(UnsafeTargetError);
      expect(result.address).toBe(''); // aucune adresse exploitable, même partielle
    },
  );

  it('aucune adresse : refus', async () => {
    const result = await lookupCall(async () => []);
    expect(result.err).toBeInstanceOf(UnsafeTargetError);
  });

  it('échec de résolution : l erreur DNS est transmise avec son code', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND pinned.example.test'), { code: 'ENOTFOUND' });
    const result = await lookupCall(async () => {
      throw dnsError;
    });
    expect(result.err).toBe(dnsError);
    expect((result.err as NodeJS.ErrnoException).code).toBe('ENOTFOUND');
  });

  it('une résolution par connexion : le contrôle et l adresse retenue viennent de la même réponse', async () => {
    const resolver = vi.fn<HostLookup>(async () => ['93.184.216.34']);
    const result = await lookupCall(resolver, { all: true });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('connexion épinglée sur un serveur local réel (DNS simulé)', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('nom dont le DNS pointe vers une adresse privée : aucune connexion, UnsafeTargetError', async () => {
    const resolver = vi.fn<HostLookup>(async () => ['127.0.0.1']);
    const agent = createPinnedAgent(resolver);
    const before = hits;
    const error = await fetchBytes(fetch, `http://pinned.example.test:${port}/x`, {}, 5000, { dispatcher: agent }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect(hits).toBe(before);
    expect(resolver).toHaveBeenCalledTimes(1);
    await agent.close();
  });

  it('adresse IP littérale privée : refusée avant toute connexion', async () => {
    const agent = createPinnedAgent(async () => ['93.184.216.34']);
    const before = hits;
    const error = await fetchBytes(fetch, `http://127.0.0.1:${port}/x`, {}, 5000, { dispatcher: agent }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SourceError);
    expect(hits).toBe(before);
    await agent.close();
  });
});

describe('fetchBytes : agent épinglé transmis à la requête', () => {
  it('avec un agent injecté, la requête le reçoit (le DNS n est pas résolu avant la connexion)', async () => {
    const agent = createPinnedAgent(async () => {
      throw new Error('ne doit pas être appelé avant la connexion');
    });
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 }));
    const result = await fetchBytes(mock as unknown as FetchFn, 'https://api.example.test/x', {}, 1000, { dispatcher: agent });
    expect(result.status).toBe(200);
    const init = mock.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(init?.dispatcher).toBe(agent);
    await agent.close();
  });

  it('sans agent, garde ni mode public : rien d ajouté (les sources gardent leur comportement)', async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 }));
    await fetchBytes(mock as unknown as FetchFn, 'https://api.example.test/x');
    const init = mock.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(init).not.toHaveProperty('dispatcher');
  });

  it('mode public : un nom n est pas résolu par la vérification d URL, et une IP privée est refusée', async () => {
    vi.stubEnv('LASTADDON_PUBLIC', '1');
    const lookup = vi.fn<HostLookup>(async () => ['10.0.0.5']);
    await expect(checkOutboundUrl('https://api.example.test/x', true, lookup, true)).resolves.toBeInstanceOf(URL);
    expect(lookup).not.toHaveBeenCalled();
    await expect(checkOutboundUrl('http://10.0.0.5/x', true, lookup, true)).rejects.toThrow('adresse non publique');
    const mock = vi.fn(async () => new Response('ok', { status: 200 }));
    await expect(fetchBytes(mock as unknown as FetchFn, 'http://10.0.0.5/x')).rejects.toBeInstanceOf(SourceError);
    expect(mock).not.toHaveBeenCalled();
  });
});
