import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { configuredStreamingServer, DEFAULT_STREAMING_SERVER, parseStreamingServer } from '../src/config/runtime-env.js';
import { upstreamUrl } from '../src/streaming-proxy.js';

const SECRET = 'streaming-proxy-test-secret';

interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Requêtes reçues par le faux serveur de streaming, dans l'ordre. */
const seen: Seen[] = [];
/** Passe à true quand le client amont (le relais) ferme la connexion du flux /slow. */
let slowClosed = false;
let upstream: Server;
let upstreamOrigin: string;
let uiDir: string;
let proxied: { server: Server; baseUrl: string };
let noUi: { server: Server; baseUrl: string };
let closedOrigin: string;

function handleUpstream(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ url: req.url ?? '', headers: { ...req.headers } });
  res.on('error', () => undefined);
  const path = (req.url ?? '').split('?')[0];
  const external = { 'access-control-allow-origin': 'https://strem.io' };
  if (path === '/hlsv2/abc/master.m3u8') {
    res.writeHead(200, { ...external, 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
    return;
  }
  if (path === '/abc/video.bin') {
    const common = { ...external, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' };
    if (req.headers.range === 'bytes=0-3') {
      res.writeHead(206, { ...common, 'content-range': 'bytes 0-3/10', 'content-length': '4' });
      res.end('ABCD');
      return;
    }
    res.writeHead(200, { ...common, 'content-length': '10' });
    res.end('0123456789');
    return;
  }
  if (path === '/subtitles.vtt') {
    res.writeHead(200, { 'content-type': 'text/vtt' });
    res.end('WEBVTT\n');
    return;
  }
  if (path === '/slow') {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    const timer = setInterval(() => {
      if (!res.destroyed) res.write('x'.repeat(1024));
    }, 20);
    res.on('close', () => {
      clearInterval(timer);
      slowClosed = true;
    });
    return;
  }
  res.writeHead(404);
  res.end();
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  upstream = createServer(handleUpstream);
  upstreamOrigin = await listen(upstream);

  uiDir = mkdtempSync(join(tmpdir(), 'lastaddon-ss-ui-'));
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>ui</title>');

  const proxiedServer = createApp({ secret: SECRET, allowPlain: false, uiDir, streamingServer: upstreamOrigin });
  const proxiedHttp = proxiedServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => proxiedHttp.once('listening', () => resolve()));
  proxied = { server: proxiedHttp, baseUrl: `http://127.0.0.1:${(proxiedHttp.address() as AddressInfo).port}` };

  const plainHttp = createApp({ secret: SECRET, allowPlain: false }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => plainHttp.once('listening', () => resolve()));
  noUi = { server: plainHttp, baseUrl: `http://127.0.0.1:${(plainHttp.address() as AddressInfo).port}` };

  // Origine dont aucun serveur n'écoute : le relais doit répondre 502.
  const probe = createServer();
  closedOrigin = await listen(probe);
  await close(probe);
});

afterAll(async () => {
  await close(proxied.server);
  await close(noUi.server);
  await close(upstream);
  rmSync(uiDir, { recursive: true, force: true });
});

describe('relais /_ss/* vers le serveur de streaming', () => {
  it('HLS : playlist et segments passent avec leur type et le chemin amont exact', async () => {
    const res = await fetch(`${proxied.baseUrl}/_ss/hlsv2/abc/master.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(await res.text()).toContain('#EXTM3U');
    expect(seen.at(-1)?.url).toBe('/hlsv2/abc/master.m3u8');
  });

  it('requête avec query string transmise telle quelle', async () => {
    const res = await fetch(`${proxied.baseUrl}/_ss/subtitles.vtt?lang=fr&id=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/vtt');
    expect(seen.at(-1)?.url).toBe('/subtitles.vtt?lang=fr&id=1');
  });

  it('Range : 206 avec Content-Range et Accept-Ranges, et en-tête Range transmis', async () => {
    const res = await fetch(`${proxied.baseUrl}/_ss/abc/video.bin`, { headers: { range: 'bytes=0-3' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('ABCD');
    expect(seen.at(-1)?.headers.range).toBe('bytes=0-3');
  });

  it('les en-têtes CORS de l\'amont ne sont pas relayés (même origine)', async () => {
    const res = await fetch(`${proxied.baseUrl}/_ss/abc/video.bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('aucun en-tête d\'authentification ou de profil n\'est transmis en amont', async () => {
    await fetch(`${proxied.baseUrl}/_ss/abc/video.bin`, {
      headers: { cookie: 'sid=secret', authorization: 'Bearer jeton', 'x-profile-token': 'profil', 'x-bootstrap-token': 'amorce' },
    });
    const last = seen.at(-1)?.headers ?? {};
    expect(last.cookie).toBeUndefined();
    expect(last.authorization).toBeUndefined();
    expect(last['x-profile-token']).toBeUndefined();
    expect(last['x-bootstrap-token']).toBeUndefined();
  });

  it('HEAD est relayé sans corps', async () => {
    const res = await fetch(`${proxied.baseUrl}/_ss/abc/video.bin`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
  });

  it('les méthodes autres que GET et HEAD reçoivent 405', async () => {
    const before = seen.length;
    const res = await fetch(`${proxied.baseUrl}/_ss/abc/video.bin`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(seen.length).toBe(before);
  });

  it('serveur de streaming injoignable : 502 sans détail', async () => {
    const app = createApp({ secret: SECRET, allowPlain: false, uiDir, streamingServer: closedOrigin });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/_ss/abc/video.bin`);
      expect(res.status).toBe(502);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'streaming_server_unavailable' });
    } finally {
      await close(server);
    }
  });

  it('le client qui part interrompt le flux amont', async () => {
    slowClosed = false;
    const controller = new AbortController();
    const res = await fetch(`${proxied.baseUrl}/_ss/slow`, { signal: controller.signal });
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    controller.abort();
    await waitFor(() => slowClosed);
    expect(slowClosed).toBe(true);
  });

  it('sans LASTADDON_UI_DIR, le relais n\'est pas monté', async () => {
    const res = await fetch(`${noUi.baseUrl}/_ss/abc/video.bin`);
    expect(res.status).toBe(404);
  });

  it('upstreamUrl reste sur l\'origine de la cible, même pour un chemin commençant par //', () => {
    const base = new URL('http://127.0.0.1:11470');
    const url = upstreamUrl(base, '/_ss//evil.example/x?y=1');
    expect(url.host).toBe('127.0.0.1:11470');
    expect(url.search).toBe('?y=1');
    expect(upstreamUrl(base, '/_ss?a=b').pathname).toBe('/');
  });
});

describe('LASTADDON_STREAMING_SERVER', () => {
  it('valeur par défaut : 127.0.0.1:11470', () => {
    expect(DEFAULT_STREAMING_SERVER).toBe('http://127.0.0.1:11470');
    vi.stubEnv('LASTADDON_STREAMING_SERVER', '');
    expect(configuredStreamingServer()).toBe('http://127.0.0.1:11470');
    vi.unstubAllEnvs();
  });

  it('accepte les origines locales (localhost, 127.0.0.1, [::1]), http ou https', () => {
    expect(parseStreamingServer('http://localhost:11470/')).toBe('http://localhost:11470');
    expect(parseStreamingServer('http://[::1]:11470')).toBe('http://[::1]:11470');
    expect(parseStreamingServer('https://127.0.0.1:11471')).toBe('https://127.0.0.1:11471');
  });

  it('refuse un hôte distant, un chemin, des identifiants, une requête ou un autre schéma, sans écho de la valeur', () => {
    const refused = [
      'http://example.com:11470',
      'http://192.168.1.10:11470',
      'http://127.0.0.1.example.com:11470',
      'http://127.0.0.1:11470/stremio',
      'http://user:mot-de-passe@127.0.0.1:11470',
      'http://127.0.0.1:11470?x=1',
      'ftp://127.0.0.1',
      'pas une url',
    ];
    for (const raw of refused) {
      let message = '';
      try {
        parseStreamingServer(raw);
      } catch (err) {
        message = err instanceof Error ? err.message : '';
      }
      expect(message).toMatch(/^LASTADDON_STREAMING_SERVER invalide/);
      expect(message).not.toContain('example');
      expect(message).not.toContain('mot-de-passe');
    }
  });
});
