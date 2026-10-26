import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { App } from '../src/http/app-env.js';
import { assertUiDir } from '../src/platform/node/index.js';
import { isApiPath, sameOriginsFor } from '../src/ui.js';
import { serveApp } from './serve.js';

const SECRET = 'ui-static-test-secret';
const UI_MARKER = 'interface-lastaddon-test';
const PORT = 7000;
const ORIGIN = `http://localhost:${PORT}`;

let uiDir: string;
let withUi: { server: Server; baseUrl: string };
let withoutUi: { server: Server; baseUrl: string };

async function listen(app: App): Promise<{ server: Server; baseUrl: string }> {
  const server = serveApp(app);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function close(target: { server: Server }): Promise<void> {
  target.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => target.server.close((err) => (err ? reject(err) : resolve())));
}

beforeAll(async () => {
  uiDir = mkdtempSync(join(tmpdir(), 'lastaddon-ui-'));
  mkdirSync(join(uiDir, 'assets'));
  writeFileSync(join(uiDir, 'index.html'), `<!doctype html><title>${UI_MARKER}</title>`);
  writeFileSync(join(uiDir, 'assets', 'app.abc123.js'), 'console.log(1);');
  writeFileSync(join(uiDir, 'service-worker.js'), 'self.addEventListener("fetch", () => {});');
  withUi = await listen(createApp({ secret: SECRET, allowPlain: false, uiDir, uiOrigins: sameOriginsFor(PORT) }));
  withoutUi = await listen(createApp({ secret: SECRET, allowPlain: false }));
});

afterAll(async () => {
  await close(withUi);
  await close(withoutUi);
  rmSync(uiDir, { recursive: true, force: true });
});

describe('interface statique (LASTADDON_UI_DIR / --ui)', () => {
  it('GET / sert index.html sans cache', async () => {
    const res = await fetch(`${withUi.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain(UI_MARKER);
  });

  it('index.html et service-worker.js ne sont jamais mis en cache', async () => {
    const index = await fetch(`${withUi.baseUrl}/index.html`);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const sw = await fetch(`${withUi.baseUrl}/service-worker.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
  });

  it('/assets/* est mis en cache longtemps (fichiers versionnés)', async () => {
    const res = await fetch(`${withUi.baseUrl}/assets/app.abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('repli SPA : une navigation inconnue (Accept text/html) reçoit index.html', async () => {
    const res = await fetch(`${withUi.baseUrl}/bibliotheque/serie/42`, { headers: { accept: 'text/html,*/*;q=0.8' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain(UI_MARKER);
  });

  it('un fichier absent reste un 404 pour les requêtes de script (pas de repli)', async () => {
    const res = await fetch(`${withUi.baseUrl}/assets/absent.js`, { headers: { accept: '*/*' } });
    expect(res.status).toBe(404);
  });

  it('les routes API gardent la priorité sur le repli, même pour une navigation', async () => {
    const health = await fetch(`${withUi.baseUrl}/health`, { headers: { accept: 'text/html' } });
    expect(await health.json()).toEqual({ ok: true, degraded: false, release: 'lastaddon-core@0.1.0', deps: {} });
    const manifest = await fetch(`${withUi.baseUrl}/manifest.json`, { headers: { accept: 'text/html' } });
    expect((await manifest.json()) as { id: string }).toMatchObject({ id: 'com.laststream.lastaddon' });
    const config = await fetch(`${withUi.baseUrl}/config/inconnu`, { headers: { accept: 'text/html' } });
    expect(config.status).toBe(404);
    expect(await config.text()).not.toContain(UI_MARKER);
    const user = await fetch(`${withUi.baseUrl}/user/inconnu`, { headers: { accept: 'text/html' } });
    expect(user.status).toBe(404);
    expect(await user.text()).not.toContain(UI_MARKER);
  });

  it('une configuration encodée garde son manifest, même avec Accept text/html', async () => {
    const res = await fetch(`${withUi.baseUrl}/abc/manifest.json`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(UI_MARKER);
  });

  it('les méthodes autres que GET ne reçoivent pas index.html', async () => {
    const res = await fetch(`${withUi.baseUrl}/`, { method: 'POST', headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
  });

  it('sans LASTADDON_UI_DIR, aucune interface n\'est servie', async () => {
    const res = await fetch(`${withoutUi.baseUrl}/`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
  });

  it('CORS : l\'origine de l\'interface (même site) est autorisée sur /config/*', async () => {
    const allowed = await fetch(`${withUi.baseUrl}/config/encode`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const other = await fetch(`${withUi.baseUrl}/config/encode`, {
      method: 'OPTIONS',
      headers: { origin: 'https://autre.example', 'access-control-request-method': 'POST' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('helpers de l\'interface', () => {
  it('isApiPath reconnaît les racines API et les routes par configuration', () => {
    for (const path of ['/health', '/manifest.json', '/config/schema', '/user/me', '/abc/manifest.json', '/abc/stream/movie/tt1.json', '/abc/play/c/xyz', '/abc/lt/x', '/abc/catalog/movie/y']) {
      expect(isApiPath(path)).toBe(true);
    }
    for (const path of ['/', '/bibliotheque', '/assets/app.js', '/serie/42']) {
      expect(isApiPath(path)).toBe(false);
    }
  });

  it('sameOriginsFor : localhost et 127.0.0.1 sur le port, plus l\'origine publique', () => {
    expect(sameOriginsFor(7000)).toEqual(['http://localhost:7000', 'http://127.0.0.1:7000']);
    expect(sameOriginsFor(7000, 'https://addon.example.com/base')).toEqual([
      'http://localhost:7000',
      'http://127.0.0.1:7000',
      'https://addon.example.com',
    ]);
  });

  it('assertUiDir refuse un dossier sans index.html', () => {
    expect(() => assertUiDir(uiDir)).not.toThrow();
    expect(() => assertUiDir(join(uiDir, 'assets'))).toThrow(/index\.html introuvable/);
  });
});
