import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, createRateLimiter } from '../src/app.js';

const SECRET = 'cors-test-secret-with-32-chars-min!';
const ALLOWED = 'https://ui.example.test';
const servers: Server[] = [];

async function listen(env: Record<string, string>, build: () => ReturnType<typeof createApp>): Promise<string> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const server = build().listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  vi.unstubAllEnvs();
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

let custom = '';
let defaults = '';
let limited = '';

beforeAll(async () => {
  custom = await listen(
    { LASTADDON_ALLOWED_ORIGINS: `${ALLOWED}, http://localhost:9000` },
    () => createApp({ secret: SECRET, allowPlain: false }),
  );
  defaults = await listen({ LASTADDON_ALLOWED_ORIGINS: '' }, () => createApp({ secret: SECRET, allowPlain: false }));
  limited = await listen({}, () => createApp({ secret: SECRET, allowPlain: false }));
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('CORS : routes Stremio ouvertes', () => {
  it.each(['/manifest.json', '/abcdef/manifest.json', '/abcdef/stream/movie/tt1234567.json'])(
    '%s renvoie Access-Control-Allow-Origin: *',
    async (path) => {
      const res = await fetch(`${custom}${path}`, { headers: { Origin: 'https://anywhere.example' } });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    },
  );

  it('la route play n a pas de CORS ouvert (/health, sonde publique, l a)', async () => {
    const health = await fetch(`${custom}/health`, { headers: { Origin: 'https://anywhere.example' } });
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('CORS : /config/* restreint aux origines autorisées', () => {
  it('origine autorisée : renvoyée à l identique, Vary: Origin', async () => {
    const res = await fetch(`${custom}/config/schema`, { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('origine non listée : aucun en-tête ACAO, jamais *', async () => {
    const res = await fetch(`${custom}/config/schema`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('préflight depuis une origine autorisée : 204 avec ACAO, POST permis', async () => {
    const res = await fetch(`${custom}/config/encode`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:9000', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:9000');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('préflight depuis une origine non listée : aucun ACAO', async () => {
    const res = await fetch(`${custom}/config/test`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('défaut quand LASTADDON_ALLOWED_ORIGINS est vide : localhost:8089 accepté', async () => {
    const res = await fetch(`${defaults}/config/schema`, { headers: { Origin: 'http://localhost:8089' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8089');
    const other = await fetch(`${defaults}/config/schema`, { headers: { Origin: ALLOWED } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('limite de débit sur /config/*', () => {
  it('30 requêtes par minute et par IP, la 31e reçoit 429 avec Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push((await fetch(`${limited}/config/schema`)).status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);

    const blocked = await fetch(`${limited}/config/schema`);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toEqual({ error: 'rate_limited' });

    // Les routes hors /config ne sont pas limitées.
    expect((await fetch(`${limited}/manifest.json`)).status).toBe(200);
  });
});

describe('createRateLimiter', () => {
  it('compte par fenêtre fixe et se réinitialise à l échéance', () => {
    let now = 0;
    const limiter = createRateLimiter(2, 1000, () => now);
    expect(limiter('ip')).toEqual({ allowed: true, retryAfterSec: 1 });
    expect(limiter('ip').allowed).toBe(true);
    expect(limiter('ip')).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(limiter('autre').allowed).toBe(true);
    now = 1000;
    expect(limiter('ip').allowed).toBe(true);
  });
});

describe('CORS : sonde /health', () => {
  it('est lisible depuis une autre origine (apps Capacitor) sans données', async () => {
    const res = await fetch(`${custom}/health`, { headers: { Origin: 'capacitor://localhost' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ ok: true });
  });
});
