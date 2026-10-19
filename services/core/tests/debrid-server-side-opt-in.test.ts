import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AllDebridClient, serverSideDebridBlocked } from '../src/sources/alldebrid.js';
import { serveApp } from './serve.js';

/*
 * Opt-in AllDebrid côté serveur (LASTADDON_DEBRID_SERVER_SIDE) : sans la variable, le serveur n'appelle jamais AllDebrid
 * et /stream passe en mode « client ». Seule la valeur exacte « 1 » rétablit les appels serveur.
 * Le fetch simulé journalise chaque URL appelée : les tests exigent zéro appel vers AllDebrid sans activation.
 */

const SECRET = 'debrid-opt-in-secret';
const AD_KEY = 'AD-OPT-IN-KEY-SECRET';
const VAR = 'LASTADDON_DEBRID_SERVER_SIDE';
const UPSTREAM_URL = 'https://upstream.example.test';
const CDN_URL = 'https://cdn.example.test/film-vostfr.mkv';
const HASH = 'a'.repeat(40);

const STREAMS = [
  { name: 'Upstream', title: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP', infoHash: HASH, fileIdx: 3 },
  { name: 'Upstream', title: 'Film.2024.1080p.BluRay.x264.VOSTFR-XYZ', url: CDN_URL },
];

const urls: string[] = [];
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  urls.push(url.href);
  if (url.hostname === 'upstream.example.test') {
    if (url.pathname === '/manifest.json') return json({ id: 'upstream.test', resources: ['stream'] });
    if (url.pathname.startsWith('/stream/movie/')) return json({ streams: STREAMS });
  }
  if (url.hostname === 'api.alldebrid.com') return json({ status: 'error', error: { code: 'MAGNET_INVALID_URI', message: 'test' } }, 400);
  if (url.hostname === 'v3-cinemeta.strem.io') return json({ meta: { runtime: '120 min' } });
  return json({}, 404);
};

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = serveApp(createApp({ secret: SECRET, allowPlain: true, fetch: fakeFetch as unknown as typeof fetch }));
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});
beforeEach(() => {
  urls.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const plain = (config: Record<string, unknown>): string => Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
const CONFIG = plain({ sources: [{ type: 'upstream', name: 'Upstream', url: UPSTREAM_URL }], debrid: { service: 'alldebrid', apiKey: AD_KEY } });
const alldebridCalls = (): string[] => urls.filter((u) => u.includes('alldebrid'));

interface Out {
  infoHash?: string;
  url?: string;
}

describe('garde serverSideDebridBlocked', () => {
  it('bloque sans variable, avec 0, vide ou toute autre valeur que 1', () => {
    vi.stubEnv(VAR, undefined);
    expect(process.env[VAR]).toBeUndefined();
    expect(serverSideDebridBlocked()).toBe(true);
    for (const value of ['0', '', 'true', ' 1']) {
      vi.stubEnv(VAR, value);
      expect(serverSideDebridBlocked()).toBe(true);
    }
  });

  it('débloque seulement avec la valeur exacte 1', () => {
    vi.stubEnv(VAR, '1');
    expect(serverSideDebridBlocked()).toBe(false);
  });
});

describe('AllDebridClient sans activation serveur', () => {
  const fetchSpy = (calls: string[]) =>
    (async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return json({ status: 'success', data: { user: { isPremium: true } } });
    }) as unknown as typeof fetch;

  it('n appelle jamais AllDebrid par défaut et renvoie server_side_disabled', async () => {
    vi.stubEnv(VAR, undefined);
    const calls: string[] = [];
    const client = new AllDebridClient(AD_KEY, { fetch: fetchSpy(calls) });
    await expect(client.checkApiKey()).resolves.toEqual({ ok: false, error: 'server_side_disabled' });
    await client.checkCached([HASH]);
    expect(calls).toEqual([]);
  });

  it('avec LASTADDON_DEBRID_SERVER_SIDE=1, l appel part vers AllDebrid', async () => {
    vi.stubEnv(VAR, '1');
    const calls: string[] = [];
    const client = new AllDebridClient(AD_KEY, { fetch: fetchSpy(calls) });
    await expect(client.checkApiKey()).resolves.toEqual({ ok: true, premium: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('api.alldebrid.com/v4/user');
  });
});

describe('/stream : mode par défaut', () => {
  it('sans variable : mode client, torrents livrés sans lien, zéro appel AllDebrid, clé absente de la réponse', async () => {
    vi.stubEnv(VAR, undefined);
    const res = await fetch(`${baseUrl}/${CONFIG}/stream/movie/tt1234567.json?torrents=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { streams: Out[]; debrid?: string };
    expect(body.debrid).toBe('client');
    expect(alldebridCalls()).toEqual([]);
    const torrent = body.streams.find((s) => s.infoHash === HASH);
    expect(torrent).toBeDefined();
    expect(torrent?.url).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(AD_KEY);
  });

  it('sans variable et sans ?torrents=1 : aucun torrent livré, toujours aucun appel AllDebrid', async () => {
    vi.stubEnv(VAR, undefined);
    const res = await fetch(`${baseUrl}/${CONFIG}/stream/movie/tt1234567.json`);
    const body = (await res.json()) as { streams: Out[] };
    expect(body.streams.filter((s) => s.infoHash !== undefined)).toEqual([]);
    expect(alldebridCalls()).toEqual([]);
  });

  it('avec LASTADDON_DEBRID_SERVER_SIDE=1 : mode serveur possible, le serveur appelle AllDebrid', async () => {
    vi.stubEnv(VAR, '1');
    const res = await fetch(`${baseUrl}/${CONFIG}/stream/movie/tt1234567.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { debrid?: string };
    expect(body.debrid).toBeUndefined();
    expect(alldebridCalls().length).toBeGreaterThan(0);
  });
});
