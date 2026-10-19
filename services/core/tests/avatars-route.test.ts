import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeAvatarAssets } from '../src/platform/node/index.js';
import type { RuntimeEnv } from '../src/platform/types.js';
import { type RunningApp, startApp } from './lt-harness.js';

const CATALOG = '{"version":"2026-10-20","families":[],"collections":[],"featured":[]}';
const IMAGE = 'RIFF0000WEBPfixture';

let dir: string;
let app: RunningApp;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avatars-route-'));
  mkdirSync(join(dir, 'c'), { recursive: true });
  mkdirSync(join(dir, 'i', 'lol'), { recursive: true });
  writeFileSync(join(dir, 'catalog.json'), CATALOG);
  writeFileSync(join(dir, 'c', 'lol.json'), '{"id":"lol","characters":[{"id":"ahri","name":"Ahri"}]}');
  writeFileSync(join(dir, 'i', 'lol', 'ahri.webp'), IMAGE);
  writeFileSync(join(dir, 'secret.json'), '{"secret":true}');
  // Mode Node avec dossier : la route lit LASTADDON_AVATARS_DIR à chaque requête (process.env, voir vi.stubEnv).
  vi.stubEnv('LASTADDON_AVATARS_DIR', dir);
  app = await startApp({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /avatars/* en mode Node (LASTADDON_AVATARS_DIR)', () => {
  it('sert le catalogue avec son type, son ETag et un cache d une heure', async () => {
    const res = await fetch(`${app.baseUrl}/avatars/catalog.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(await res.text()).toBe(CATALOG);
  });

  it('sert les vignettes avec un cache longue durée immuable', async () => {
    const res = await fetch(`${app.baseUrl}/avatars/i/lol/ahri.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(IMAGE);
  });

  it('If-None-Match : 304 quand l ETag est inchangé', async () => {
    const first = await fetch(`${app.baseUrl}/avatars/c/lol.json`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const again = await fetch(`${app.baseUrl}/avatars/c/lol.json`, { headers: { 'if-none-match': etag ?? '' } });
    expect(again.status).toBe(304);
  });

  it('CORS ouvert comme les routes publiques de lecture', async () => {
    const res = await fetch(`${app.baseUrl}/avatars/catalog.json`, { headers: { origin: 'capacitor://localhost' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('clé absente ou hors des chemins prévus : 404, sans contenu du dossier', async () => {
    for (const path of ['/avatars/absent.json', '/avatars/i/lol/absent.webp', '/avatars/secret.json', '/avatars/c/..%2fsecret.json', '/avatars/i/LOL/ahri.webp']) {
      const res = await fetch(`${app.baseUrl}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('secret');
    }
  });

  it('sans LASTADDON_AVATARS_DIR ni LASTADDON_PUBLIC_URL : 404', async () => {
    vi.stubEnv('LASTADDON_AVATARS_DIR', '');
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    const res = await fetch(`${app.baseUrl}/avatars/catalog.json`);
    expect(res.status).toBe(404);
  });
});

describe('avatars en mode Node : relais vers LASTADDON_PUBLIC_URL', () => {
  /** Environnement de test : seules ces variables existent. */
  const envWith = (values: Record<string, string>): RuntimeEnv => ({
    get: (name) => values[name],
    all: () => values,
  });

  it('relaie /avatars/<clé> vers le Worker public, en gardant l ETag et la validation conditionnelle', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const http = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(input), headers });
        if (headers['if-none-match'] === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
        return new Response('{"id":"lol"}', { status: 200, headers: { 'content-type': 'application/json', etag: '"v1"' } });
      }) as typeof fetch,
    };
    const assets = createNodeAvatarAssets(envWith({ LASTADDON_PUBLIC_URL: 'https://addon.example.com/base/' }), http);
    const ok = await assets.serve(new Request('https://local/avatars/c/lol.json'), 'c/lol.json');
    expect(ok?.status).toBe(200);
    expect(ok?.headers.get('etag')).toBe('"v1"');
    expect(await ok?.text()).toBe('{"id":"lol"}');
    expect(calls[0]?.url).toBe('https://addon.example.com/base/avatars/c/lol.json');

    const notModified = await assets.serve(new Request('https://local/avatars/c/lol.json', { headers: { 'if-none-match': '"v1"' } }), 'c/lol.json');
    expect(notModified?.status).toBe(304);
    expect(calls[1]?.headers).toEqual({ 'if-none-match': '"v1"' });
  });

  it('relais : upstream 404 ou erreur réseau : null (404 côté client)', async () => {
    const missing = createNodeAvatarAssets(envWith({ LASTADDON_PUBLIC_URL: 'https://addon.example.com' }), {
      fetch: (async () => new Response('absent', { status: 404 })) as typeof fetch,
    });
    expect(await missing.serve(new Request('https://local/avatars/catalog.json'), 'catalog.json')).toBeNull();

    const down = createNodeAvatarAssets(envWith({ LASTADDON_PUBLIC_URL: 'https://addon.example.com' }), {
      fetch: (async () => {
        throw new TypeError('réseau coupé');
      }) as typeof fetch,
    });
    expect(await down.serve(new Request('https://local/avatars/catalog.json'), 'catalog.json')).toBeNull();
  });
});
