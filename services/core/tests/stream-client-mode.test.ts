import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { serveApp } from './serve.js';

/*
 * Mode « client » (seul mode) : /stream livre les torrents sans lien, l'appareil débride lui-même.
 * Le serveur ne contacte jamais AllDebrid : le fetch simulé journalise chaque hôte appelé et le test exige zéro appel.
 */

const SECRET = 'client-mode-secret';
const AD_KEY = 'AD-CLIENT-MODE-KEY-SECRET';
const CDN_URL = 'https://cdn.example.test/film-vostfr.mkv';
const UPSTREAM_URL = 'https://upstream.example.test';
const H = { vff: 'a'.repeat(40), multi: 'e'.repeat(40), series: '9'.repeat(40) };

const STREAMS = [
  { name: 'Upstream\n1080p', title: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP', infoHash: H.vff, fileIdx: 3, behaviorHints: { videoSize: 4_500_000_000, filename: 'Film.2024.VFF.1080p.mkv' } },
  { name: 'Upstream', title: 'Film.2024.MULTi.1080p.WEB-DL.x264-SMALL', infoHash: H.multi },
  { name: 'Upstream', title: 'Film.2024.1080p.BluRay.x264.VOSTFR-XYZ', url: CDN_URL },
];

const hosts: string[] = [];
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  hosts.push(url.hostname);
  if (url.hostname === 'upstream.example.test') {
    if (url.pathname === '/manifest.json') return json({ id: 'upstream.test', resources: ['stream'] });
    if (url.pathname.startsWith('/stream/movie/')) return json({ streams: STREAMS });
    if (url.pathname.startsWith('/stream/series/')) {
      return json({ streams: [{ name: 'Upstream', title: 'Serie.S01E02.VFF.1080p.WEB-DL.H264-GRP', infoHash: H.series, fileIdx: 1 }] });
    }
  }
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
  hosts.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const plain = (config: Record<string, unknown>): string => Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
const SOURCES = [{ type: 'upstream', name: 'Upstream', url: UPSTREAM_URL }];

interface Out {
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: Record<string, unknown>;
  laststream?: { client?: { copies: Record<string, unknown>[]; season?: number; episode?: number } };
}
async function streamsFor(config: Record<string, unknown>, type: string, id: string, torrents = true): Promise<{ streams: Out[]; notice?: string; debrid?: string; onlyCached?: boolean }> {
  const res = await fetch(`${baseUrl}/${plain(config)}/stream/${type}/${id}.json${torrents ? '?torrents=1' : ''}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { streams: Out[] };
}

describe('mode client : aucun appel AllDebrid depuis le serveur', () => {
  it('livre les torrents sans URL, marqués lastDebrid=client, et garde le lien direct', async () => {
    const body = await streamsFor({ sources: SOURCES, debrid: { service: 'alldebrid', apiKey: AD_KEY } }, 'movie', 'tt1234567');

    expect(hosts.filter((h) => h.includes('alldebrid'))).toEqual([]);
    expect(body.debrid).toBe('client');
    expect(body.notice).toBeUndefined();
    const torrents = body.streams.filter((s) => s.infoHash !== undefined);
    expect(torrents.map((s) => s.infoHash).sort()).toEqual([H.multi, H.vff].sort());
    for (const s of torrents) {
      expect(s.url).toBeUndefined();
      expect(s.behaviorHints?.lastDebrid).toBe('client');
    }
    // Aucune URL /play nulle part.
    expect(JSON.stringify(body)).not.toContain('/play/');
    // Le lien HTTP direct reste tel quel.
    expect(body.streams.filter((s) => s.url !== undefined).map((s) => s.url)).toEqual([CDN_URL]);
    expect(body.streams.find((s) => s.url === CDN_URL)?.behaviorHints?.lastDebrid).toBeUndefined();
    // L'appareil reçoit le fichier attendu pour choisir le bon fichier du magnet.
    const vff = torrents.find((s) => s.infoHash === H.vff);
    expect(vff?.fileIdx).toBe(3);
    expect(vff?.laststream?.client?.copies[0]).toMatchObject({ infoHash: H.vff, fileIdx: 3 });
    // La clé n'apparaît nulle part dans la réponse.
    expect(JSON.stringify(body)).not.toContain(AD_KEY);
  });

  it('sans clé dans la configuration : mêmes entrées, sans message « Configure AllDebrid »', async () => {
    const body = await streamsFor({ sources: SOURCES }, 'movie', 'tt1234567');
    expect(body.notice).toBeUndefined();
    expect(body.streams.filter((s) => s.behaviorHints?.lastDebrid === 'client')).toHaveLength(2);
    expect(hosts.filter((h) => h.includes('alldebrid'))).toEqual([]);
  });

  it('« seulement en cache » n est pas appliqué par le serveur (statut inconnu) mais transmis à l appareil', async () => {
    const body = await streamsFor({ sources: SOURCES, onlyCached: true }, 'movie', 'tt1234567');
    expect(body.streams.filter((s) => s.infoHash !== undefined)).toHaveLength(2);
    expect(body.onlyCached).toBe(true);
  });

  it('série : l épisode visé est transmis pour choisir le fichier d un pack', async () => {
    const body = await streamsFor({ sources: SOURCES }, 'series', 'tt1234567:1:2');
    const stream = body.streams[0];
    expect(stream?.laststream?.client).toMatchObject({ season: 1, episode: 2 });
    expect(stream?.url).toBeUndefined();
    expect(hosts.filter((h) => h.includes('alldebrid'))).toEqual([]);
  });

  it('sans ?torrents=1 (aucun débrideur déclaré par l appareil) : aucun torrent sans lien n est livré', async () => {
    const body = await streamsFor({ sources: SOURCES }, 'movie', 'tt1234567', false);
    expect(body.streams.filter((s) => s.infoHash !== undefined)).toEqual([]);
    expect(body.streams.map((s) => s.url)).toEqual([CDN_URL]);
    expect(body.notice).toBeUndefined();
  });
});
