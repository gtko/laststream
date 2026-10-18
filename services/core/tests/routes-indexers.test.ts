import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/deps.js';
import { newApp } from '../src/http/app-env.js';
import { jsonBody } from '../src/http/json-body.js';
import { registerIndexerRoutes } from '../src/routes/indexers.js';
import { defaultIndexerHealth, IndexerHealth } from '../src/sources/indexer-health.js';
import { serveApp } from './serve.js';

const PR_KEY = 'PR-ROUTE-KEY-31337';
const JK_KEY = 'JK-ROUTE-KEY-27182';

const PROWLARR_INDEXERS = [
  {
    id: 1,
    name: 'Alpha',
    protocol: 'torrent',
    enable: true,
    privacy: 'public',
    capabilities: { movieSearchParams: ['q', 'imdbId'], tvSearchParams: ['q', 'season', 'imdbId'] },
  },
  { id: 2, name: 'Beta', protocol: 'torrent', enable: true, privacy: 'semiPrivate', capabilities: {} },
  { id: 9, name: 'Usenet', protocol: 'usenet', enable: true, privacy: 'private', capabilities: {} },
];

/** Faux fetch : aucun appel réseau. Prowlarr, Jackett et réponse d'erreur au choix. */
function fakeFetch(options: { prowlarr?: Response | 'ok'; jackett?: Response | 'ok' } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === '/api/v1/indexer') {
      return options.prowlarr instanceof Response
        ? options.prowlarr
        : new Response(JSON.stringify(PROWLARR_INDEXERS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/v2.0/indexers') {
      return options.jackett instanceof Response
        ? options.jackett
        : new Response(
            JSON.stringify([
              { id: 'alpha', title: 'Alpha Tracker', type: 'public', configured: true },
              { id: 'beta', title: 'Beta Priv', type: 'semi-private', configured: true },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
    }
    return new Response('introuvable', { status: 404 });
  }) as unknown as typeof fetch;
}

/** Mini application : seule la route à tester est montée (non enregistrée dans app.ts). */
async function startMini(deps: AppDeps, health: IndexerHealth): Promise<{ url: string; close: () => Promise<void> }> {
  const app = newApp();
  app.use('*', jsonBody(1024 * 1024));
  registerIndexerRoutes(app, deps, health);
  const server: Server = serveApp(app);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

let mini: { url: string; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await mini?.close();
  mini = undefined;
  vi.unstubAllEnvs();
});

describe('POST /config/indexers', () => {
  it('Prowlarr : liste les indexeurs torrent avec leur santé (inconnue si jamais interrogés)', async () => {
    const health = new IndexerHealth();
    health.record('PR', 1, { ok: true, latencyMs: 120 });
    mini = await startMini({ secret: 's', allowPlain: true, fetch: fakeFetch() }, health);

    const res = await postJson(`${mini.url}/config/indexers`, {
      type: 'prowlarr',
      name: 'PR',
      baseUrl: 'https://pr.example.com',
      apiKey: PR_KEY,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { indexers: unknown[] };
    expect(body).toEqual({
      indexers: [
        {
          id: 1,
          name: 'Alpha',
          protocol: 'torrent',
          privacy: 'public',
          enabled: true,
          health: { status: 'ok', avgLatencyMs: 120 },
        },
        {
          id: 2,
          name: 'Beta',
          protocol: 'torrent',
          privacy: 'semiPrivate',
          enabled: true,
          health: { status: 'unknown' },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(PR_KEY);
  });

  it('Jackett : identifiants textuels, confidentialité semi-private mappée', async () => {
    mini = await startMini({ secret: 's', allowPlain: true, fetch: fakeFetch() }, new IndexerHealth());

    const res = await postJson(`${mini.url}/config/indexers`, {
      type: 'jackett',
      name: 'JK',
      baseUrl: 'http://127.0.0.1:9117',
      apiKey: JK_KEY,
    });

    const body = (await res.json()) as { indexers: Array<{ id: string; privacy: string; health: unknown }> };
    expect(body.indexers.map((i) => [i.id, i.privacy, i.health])).toEqual([
      ['alpha', 'public', { status: 'unknown' }],
      ['beta', 'semiPrivate', { status: 'unknown' }],
    ]);
  });

  it('erreur de découverte : 502 générique, sans clé ni URL', async () => {
    const fetch = fakeFetch({ prowlarr: new Response('denied', { status: 401 }) });
    mini = await startMini({ secret: 's', allowPlain: true, fetch }, new IndexerHealth());

    const res = await postJson(`${mini.url}/config/indexers`, {
      type: 'prowlarr',
      name: 'PR',
      baseUrl: 'https://pr.example.com',
      apiKey: PR_KEY,
    });

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('indexers_unavailable');
    expect(text).not.toContain(PR_KEY);
    expect(text).not.toContain('pr.example.com');
  });

  it('validation : type non prévu, clé absente ou URL non http(s) → 400 invalid_config sans valeur saisie', async () => {
    mini = await startMini({ secret: 's', allowPlain: true, fetch: fakeFetch() }, new IndexerHealth());

    const wrongType = await postJson(`${mini.url}/config/indexers`, {
      type: 'torznab',
      name: 'T',
      baseUrl: 'https://t.example.com',
      apiKey: PR_KEY,
    });
    const noKey = await postJson(`${mini.url}/config/indexers`, { type: 'prowlarr', name: 'PR', baseUrl: 'https://pr.example.com' });
    const badUrl = await postJson(`${mini.url}/config/indexers`, {
      type: 'jackett',
      name: 'JK',
      baseUrl: 'ftp://jk.example.com',
      apiKey: JK_KEY,
    });

    for (const res of [wrongType, noKey, badUrl]) {
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('invalid_config');
      expect(text).not.toContain(PR_KEY);
      expect(text).not.toContain(JK_KEY);
    }
  });

  it('mode public : baseUrl vers une adresse privée refusée (garde SSRF), sans contact réseau', async () => {
    vi.stubEnv('LASTADDON_PUBLIC', '1');
    vi.stubEnv('LASTADDON_PUBLIC_URL', 'https://addon.example.com');
    const fetch = fakeFetch();
    mini = await startMini({ secret: 's', allowPlain: true, fetch }, new IndexerHealth());

    const res = await postJson(`${mini.url}/config/indexers`, {
      type: 'prowlarr',
      name: 'PR',
      baseUrl: 'http://10.0.0.5:9696',
      apiKey: PR_KEY,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('adresse non publique refusée');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('corps trop volumineux : 413 sans traitement', async () => {
    const fetch = fakeFetch();
    mini = await startMini({ secret: 's', allowPlain: true, fetch }, new IndexerHealth());

    const res = await postJson(`${mini.url}/config/indexers`, {
      type: 'prowlarr',
      name: 'PR',
      baseUrl: 'https://pr.example.com',
      apiKey: PR_KEY,
      categories: Array.from({ length: 5000 }, (_, i) => 1000 + i),
    });

    expect(res.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('POST /config/test : statuts par indexeur', () => {
  it('Prowlarr : ok, et un statut par indexeur issu de la santé (error après un échec enregistré)', async () => {
    const app = createApp({ secret: 's', allowPlain: true, fetch: fakeFetch() });
    const server = serveApp(app);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      defaultIndexerHealth.record('PR-TEST', 2, { ok: false, latencyMs: 5, error: 'HTTP 503' });

      const res = await postJson(`http://127.0.0.1:${port}/config/test`, {
        sources: [{ type: 'prowlarr', name: 'PR-TEST', baseUrl: 'https://pr.example.com', apiKey: PR_KEY }],
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sources: unknown[] };
      expect(body.sources).toEqual([
        {
          name: 'PR-TEST',
          type: 'prowlarr',
          ok: true,
          indexers: [
            { id: '1', name: 'Alpha', status: 'unknown' },
            { id: '2', name: 'Beta', status: 'error' },
          ],
        },
      ]);
      expect(JSON.stringify(body)).not.toContain(PR_KEY);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('Jackett en échec : ok false, erreur générique sans clé', async () => {
    const app = createApp({
      secret: 's',
      allowPlain: true,
      fetch: fakeFetch({ jackett: new Response('down', { status: 500 }) }),
    });
    const server = serveApp(app);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await postJson(`http://127.0.0.1:${port}/config/test`, {
        sources: [{ type: 'jackett', name: 'JK-TEST', baseUrl: 'http://127.0.0.1:9117', apiKey: JK_KEY }],
      });

      const body = (await res.json()) as { sources: Array<{ ok: boolean; error?: string; indexers?: unknown }> };
      expect(body.sources[0]).toMatchObject({ name: 'JK-TEST', type: 'jackett', ok: false });
      expect(body.sources[0]?.error).toBe('Source "JK-TEST" : HTTP 500');
      expect(body.sources[0]?.indexers).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(JK_KEY);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

afterAll(() => {
  defaultIndexerHealth.clear();
});
