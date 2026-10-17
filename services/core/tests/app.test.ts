import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { decodeConfig } from '../src/config/codec.js';

const SECRET = 'app-test-secret';
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({ secret: SECRET, allowPlain: false });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('routes générales', () => {
  it('GET /health répond ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /manifest.json renvoie le manifest', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'com.laststream.lastaddon',
      version: '0.1.0',
      name: 'lastAddon',
      resources: ['stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  });

  it('GET /:config/manifest.json renvoie le même manifest', async () => {
    const res = await fetch(`${baseUrl}/abcdef/manifest.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'com.laststream.lastaddon' });
  });

  it('GET /config/schema renvoie le JSON schema', async () => {
    const res = await fetch(`${baseUrl}/config/schema`);
    expect(res.status).toBe(200);
    const schema = (await res.json()) as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('sources');
  });

  it('envoie les en-têtes CORS', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('POST /config/encode', () => {
  it('chiffre une configuration valide', async () => {
    const res = await fetch(`${baseUrl}/config/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxResults: 10 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: string };
    expect(typeof body.config).toBe('string');
    expect(decodeConfig(body.config, SECRET, { allowPlain: false }).maxResults).toBe(10);
  });

  it('répond 400 à une configuration invalide', async () => {
    const res = await fetch(`${baseUrl}/config/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxResults: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe('invalid_config');
    expect(body.issues.some((issue) => issue.startsWith('maxResults'))).toBe(true);
  });

  it('répond 400 à un JSON mal formé sans écho du contenu', async () => {
    const res = await fetch(`${baseUrl}/config/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sources": SECRET-PAS-JSON',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('SECRET-PAS-JSON');
  });
});

describe("routes de streams, test et lecture (validation d'entrée)", () => {
  it('GET /:config/stream/:type/:id.json répond 400 à une configuration invalide', async () => {
    const res = await fetch(`${baseUrl}/abcdef/stream/movie/tt1234567.json`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config' });
  });

  it('POST /config/test répond 400 sans configuration', async () => {
    const res = await fetch(`${baseUrl}/config/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_config');
  });

  it('GET /:config/play/:infoHash répond 400 à un hash invalide', async () => {
    const res = await fetch(`${baseUrl}/abcdef/play/0123456789abcdef`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_hash' });
  });
});
