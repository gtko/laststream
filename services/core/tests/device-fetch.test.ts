import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { parseConfig } from '../src/config/schema.js';
import { clearUpstreamTasks, collectStreams } from '../src/sources/collect.js';
import { deviceFetchEntry } from '../src/sources/device-fetch.js';
import type { FetchFn } from '../src/sources/http.js';
import { clearUpstreamManifestCache, looksLikeChallenge, testUpstream, warmUpstreamManifest } from '../src/sources/upstream.js';
import type { ContentRef } from '../src/types.js';
import { serveApp } from './serve.js';

/*
 * Repli « via l'appareil » : un addon amont qui refuse l'IP du serveur est renvoyé dans `deviceFetch` (URL /stream sans clé de
 * débrideur), ou marqué `unsafe` sans URL quand son adresse peut porter une clé.
 */

const MOVIE: ContentRef = { type: 'movie', id: 'tt7654321', imdbId: 'tt7654321' };
const HTML_CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl</body></html>';
const KEY = 'RD-SECRET-KEY-DO-NOT-LEAK-123';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html' } });

beforeEach(() => {
  clearUpstreamManifestCache();
  clearUpstreamTasks();
});

describe('deviceFetchEntry', () => {
  it('donne l’URL /stream du titre, y compris quand l’adresse porte la clé de débrideur de l’utilisateur', () => {
    const withKey = deviceFetchEntry({ name: 'Lumio', url: `https://lumio.example.test/realdebrid=${KEY}/manifest.json` }, MOVIE);
    expect(withKey).toEqual({ addonId: 'Lumio', url: `https://lumio.example.test/realdebrid=${KEY}/stream/movie/tt7654321.json` });
    const entry = deviceFetchEntry({ name: 'Torrentio', url: 'https://torrentio.strem.fun/sort=seeders/manifest.json' }, MOVIE);
    expect(entry).toEqual({ addonId: 'Torrentio', url: 'https://torrentio.strem.fun/sort=seeders/stream/movie/tt7654321.json' });
  });

  it('nomme l’addon d’après son manifest déjà connu, pas d’après son nom par défaut', async () => {
    const source = { name: 'Addon amont', url: 'https://named-blocked.example.test/manifest.json' };
    const fetch = (async () => json({ id: 'named', name: 'Vrai Nom', resources: ['stream'] })) as unknown as FetchFn;
    expect((await testUpstream(source, { fetch })).ok).toBe(true);
    expect(deviceFetchEntry(source, MOVIE)?.addonId).toBe('Vrai Nom');
    expect(deviceFetchEntry({ name: 'Addon amont', url: 'https://unknown-blocked.example.test/manifest.json' }, MOVIE)?.addonId).toBe('Addon amont');
  });

  it('ignore les adresses locales', () => {
    expect(deviceFetchEntry({ name: 'Local', url: 'http://192.168.1.10:7000/manifest.json' }, MOVIE)).toBeUndefined();
    expect(deviceFetchEntry({ name: 'Local', url: 'http://localhost:7000/manifest.json' }, MOVIE)).toBeUndefined();
  });
});

describe('looksLikeChallenge', () => {
  it('reconnaît une page de vérification, pas un JSON', () => {
    expect(looksLikeChallenge(HTML_CHALLENGE)).toBe(true);
    expect(looksLikeChallenge('{"streams":[]}')).toBe(false);
  });
});

describe('collectStreams : deviceFetch', () => {
  const config = parseConfig({
    sources: [
      { type: 'upstream', name: 'Bloque', url: 'https://blocked-a.example.test/manifest.json' },
      { type: 'upstream', name: 'Ok', url: 'https://ok-a.example.test/manifest.json' },
    ],
  });

  const run = async (blocked: () => Response) => {
    const fetch = vi.fn(async (url: string) => (url.startsWith('https://blocked-a') ? blocked() : json({ streams: [{ name: 'Ok', infoHash: 'b'.repeat(40) }] }))) as unknown as FetchFn;
    return collectStreams(config, MOVIE, { fetch });
  };

  it.each([
    ['403', () => json({ error: 'forbidden' }, 403)],
    ['429', () => json({}, 429)],
    ['503', () => json({}, 503)],
    ['page Cloudflare', () => html(HTML_CHALLENGE)],
  ])('liste l’addon bloqué (%s) et garde les flux des autres', async (_label, blocked) => {
    const result = await run(blocked);
    expect(result.deviceFetch).toEqual([{ addonId: 'Bloque', url: 'https://blocked-a.example.test/stream/movie/tt7654321.json' }]);
    expect(result.streams.map((s) => s.sourceName)).toEqual(['Ok']);
  });

  it.each([
    ['401', () => json({}, 401)],
    ['451', () => json({}, 451)],
    ['JSON invalide en 200', () => new Response('pas du json', { status: 200 })],
    ['« error code: 1042 » en 404', () => new Response('error code: 1042', { status: 404 })],
    ['« error code: 1042 » en 200', () => new Response('error code: 1042', { status: 200 })],
    ['erreur réseau (reset)', () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }],
  ])('liste l’addon bloqué (%s)', async (_label, blocked) => {
    const result = await run(blocked);
    expect(result.deviceFetch).toEqual([{ addonId: 'Bloque', url: 'https://blocked-a.example.test/stream/movie/tt7654321.json' }]);
  });

  it('ne liste pas un addon en échec sans cause de blocage (404 au manifest inconnu, JSON sans streams) ni un addon vide', async () => {
    expect((await run(() => json({}, 404))).deviceFetch).toBeUndefined();
    expect((await run(() => json({ message: 'hello' }))).deviceFetch).toBeUndefined();
    expect((await run(() => json({ streams: [] }))).deviceFetch).toBeUndefined();
  });

  it('404 sur /stream : bloqué si le corps n’est pas du JSON d’addon, « 0 source » normal si c’est un JSON', async () => {
    const single = parseConfig({ sources: [{ type: 'upstream', name: 'Bloque', url: 'https://blocked-a.example.test/manifest.json' }] });
    const entry = [{ addonId: 'Bloque', url: 'https://blocked-a.example.test/stream/movie/tt7654321.json' }];
    const withBody = (body: string): FetchFn => vi.fn(async () => new Response(body, { status: 404 })) as unknown as FetchFn;

    // Erreur Cloudflare 1042 (Worker vers Worker) : manifest ET /stream en 404 texte, manifest jamais chargé.
    expect((await collectStreams(single, MOVIE, { fetch: withBody('error code: 1042') })).deviceFetch).toEqual(entry);
    expect((await collectStreams(single, MOVIE, { fetch: withBody('Not Found') })).deviceFetch).toEqual(entry);
    expect((await collectStreams(single, MOVIE, { fetch: withBody(HTML_CHALLENGE) })).deviceFetch).toEqual(entry);
    // 404 avec un JSON valide : l'addon répond, il n'a rien pour ce titre.
    expect((await collectStreams(single, MOVIE, { fetch: withBody('{"streams":[]}') })).deviceFetch).toBeUndefined();
  });

  it('cache l’échec du manifest (négatif court) et le rejoue sans nouvelle requête, sauf pour le test explicite', async () => {
    const source = { name: 'Bloque', url: 'https://blocked-a.example.test/manifest.json' };
    const fetch = vi.fn(async () => new Response('error code: 1042', { status: 404 }));
    const opts = { fetch: fetch as unknown as FetchFn };
    const first = await testUpstream(source, opts);
    expect(first).toMatchObject({ ok: false, error: 'Source "Bloque" : HTTP 404' });
    expect(fetch).toHaveBeenCalledTimes(1);
    warmUpstreamManifest(source, opts);
    warmUpstreamManifest(source, opts);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    await testUpstream(source, opts);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('liste un délai dépassé', async () => {
    const slow = parseConfig({ sources: [{ type: 'upstream', name: 'Lent', url: 'https://slow-a.example.test/manifest.json' }] });
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })));
    })) as unknown as FetchFn;
    const result = await collectStreams(slow, MOVIE, { fetch, timeoutMs: 20 });
    expect(result.deviceFetch).toEqual([{ addonId: 'Lent', url: 'https://slow-a.example.test/stream/movie/tt7654321.json' }]);
  });
});

describe('GET /stream : champ deviceFetch', () => {
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'route-blocked.example.test') return json({ error: 'forbidden' }, 403);
    if (url.hostname === 'route-1042.example.test') return new Response('error code: 1042', { status: 404 });
    if (url.hostname === 'route-ok.example.test') return json({ streams: [{ name: 'Ok', title: 'Film.2024.1080p.WEB-DL.x264-GRP', infoHash: 'c'.repeat(40) }] });
    if (url.hostname === 'v3-cinemeta.strem.io') return json({ meta: { runtime: '120 min' } });
    return json({}, 404);
  };
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = serveApp(createApp({ secret: 'device-fetch-secret', allowPlain: true, fetch: fakeFetch as unknown as typeof fetch }));
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  afterEach(() => vi.unstubAllEnvs());

  const plain = (config: Record<string, unknown>): string => Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');

  it('renvoie l’addon bloqué avec son URL (no-store), et rien quand aucun addon n’est bloqué', async () => {
    const res = await fetch(`${baseUrl}/${plain({ sources: [
      { type: 'upstream', name: 'Bloque', url: 'https://route-blocked.example.test' },
      { type: 'upstream', name: 'Unsafe', url: `https://route-blocked.example.test/realdebrid=${KEY}` },
    ] })}/stream/movie/tt7000001.json`);
    const blocked = (await res.json()) as { deviceFetch?: unknown[] };
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(blocked.deviceFetch).toEqual([
      { addonId: 'Bloque', url: 'https://route-blocked.example.test/stream/movie/tt7000001.json' },
      { addonId: 'Unsafe', url: `https://route-blocked.example.test/realdebrid=${KEY}/stream/movie/tt7000001.json` },
    ]);

    const fine = await (await fetch(`${baseUrl}/${plain({ sources: [{ type: 'upstream', name: 'Ok', url: 'https://route-ok.example.test' }] })}/stream/movie/tt7000002.json`)).json() as { deviceFetch?: unknown[] };
    expect(fine.deviceFetch).toBeUndefined();
  });

  it('upstream simulé en 404 texte « error code: 1042 » (manifest et /stream) : 0 source mais deviceFetch présent', async () => {
    const res = await fetch(`${baseUrl}/${plain({ sources: [{ type: 'upstream', name: 'Mur', url: 'https://route-1042.example.test' }] })}/stream/movie/tt7000003.json`);
    const body = (await res.json()) as { streams: unknown[]; deviceFetch?: unknown[] };
    expect(res.status).toBe(200);
    expect(body.streams).toEqual([]);
    expect(body.deviceFetch).toEqual([{ addonId: 'Mur', url: 'https://route-1042.example.test/stream/movie/tt7000003.json' }]);
  });
});
