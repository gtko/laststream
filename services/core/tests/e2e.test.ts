import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { decodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import { serveApp } from './serve.js';

/*
 * Parcours complet : configuration (plain ou chiffrée), agrégation, filtre, tri et formatage. Toutes les sources
 * externes (addon amont, Cinemeta, AllDebrid) passent par un fetch simulé injecté dans les dépendances : aucun appel
 * réseau, aucune vraie clé. Le serveur n'appelle jamais AllDebrid : le fetch simulé doit donc ne jamais le voir.
 */

const GB = 1024 ** 3;
const SECRET = 'e2e-test-secret';
const AD_KEY = 'AD-E2E-KEY-9999-SECRET';
const TZ_KEY = 'TZ-E2E-KEY-4242-SECRET';
const CDN_URL = 'https://cdn.example.test/film-vostfr.mkv';
const UPSTREAM_URL = 'https://upstream.example.test';
const BROKEN_URL = 'https://broken.example.test';
const INDEXER_URL = 'https://indexer.example.test';

const H = {
  vff: 'a'.repeat(40),
  remux: 'b'.repeat(40),
  cam: 'd'.repeat(40),
  multiSmall: 'e'.repeat(40),
  multiBig: 'f'.repeat(40),
};

interface StreamOut {
  name?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: Record<string, unknown>;
}

interface StreamsBody {
  streams: StreamOut[];
  debrid?: 'client';
  onlyCached?: boolean;
}

interface Recorded {
  url: string;
  method: string;
  form: string;
}

const requests: Recorded[] = [];

const UPSTREAM_MOVIE_STREAMS = [
  {
    name: 'Upstream\n1080p',
    title: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP',
    description: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP\n👤 120 💾 4.2 GB ⚙️ Upstream',
    infoHash: H.vff,
  },
  {
    name: 'Upstream\n2160p',
    title: 'Film.2024.MULTi.2160p.BluRay.REMUX.HEVC.TrueHD.Atmos-GRP',
    infoHash: H.remux,
    behaviorHints: { videoSize: 50 * GB },
  },
  { name: 'Upstream', title: 'Film.2024.1080p.BluRay.x264.VOSTFR-XYZ', url: CDN_URL },
  { name: 'Upstream', title: 'Film.2024.CAM.720p.x264-CAMRIP', infoHash: H.cam },
  {
    name: 'Upstream',
    title: 'Film.2024.MULTi.1080p.WEB-DL.x264-SMALL',
    description: 'Film\n👤 15 💾 2.5 GB',
    infoHash: H.multiSmall,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function upstreamRoute(pathname: string): Response {
  const path = decodeURIComponent(pathname);
  if (path === '/manifest.json') return jsonResponse({ id: 'upstream.test', resources: ['stream'] });
  if (path.startsWith('/stream/movie/')) return jsonResponse({ streams: UPSTREAM_MOVIE_STREAMS });
  return jsonResponse({}, 404);
}

function cinemetaRoute(pathname: string): Response {
  if (pathname === '/meta/movie/tt1234567.json') return jsonResponse({ meta: { runtime: '120 min' } });
  return jsonResponse({}, 500);
}

function route(url: URL): Response {
  switch (url.hostname) {
    case 'upstream.example.test':
      return upstreamRoute(url.pathname);
    case 'broken.example.test':
      return jsonResponse({}, 500);
    case 'v3-cinemeta.strem.io':
      return cinemetaRoute(url.pathname);
    default:
      return jsonResponse({}, 404);
  }
}

/** fetch simulé : journalise chaque appel sortant et répond selon l'hôte. */
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const form = init?.body instanceof URLSearchParams ? init.body : undefined;
  requests.push({ url: url.toString(), method: init?.method ?? 'GET', form: form?.toString() ?? '' });
  return route(url);
};

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

async function start(deps: AppDeps): Promise<Running> {
  const server: Server = serveApp(createApp(deps));
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Configuration en JSON brut encodé en base64url (accepté seulement avec allowPlain). */
const plain = (config: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');

const UPSTREAM_SOURCE = { type: 'upstream', name: 'Upstream', url: UPSTREAM_URL };
/** Ancien type de source (indexeur Torznab) : accepté par la configuration, jamais interrogé. */
const TZ_SOURCE = { type: 'torznab', name: 'Indexeur', baseUrl: INDEXER_URL, apiKey: TZ_KEY };
const PLAIN_CONFIG = { sources: [UPSTREAM_SOURCE] };
const DEBRID = { service: 'alldebrid', apiKey: AD_KEY };
const DEBRID_CONFIG = { sources: [UPSTREAM_SOURCE], debrid: DEBRID };

let main: Running;

beforeAll(async () => {
  main = await start({ secret: SECRET, allowPlain: true, fetch: fakeFetch as unknown as typeof fetch });
});

afterAll(async () => {
  await main.close();
});

beforeEach(() => {
  requests.length = 0;
});

async function streamsFor(config: string, id: string, query = '', type = 'movie'): Promise<StreamsBody> {
  const res = await fetch(`${main.baseUrl}/${config}/stream/${type}/${id}.json${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as StreamsBody;
}

/** Aucun appel sortant vers AllDebrid pendant la requête : le serveur ne débride jamais. */
const callsAllDebrid = (): boolean => requests.some((r) => r.url.includes('alldebrid'));

/* ---------- Tests ---------- */

describe('agrégation : mode client (seul mode)', () => {
  it('sans ?torrents=1 : seul le lien HTTP direct est livré, aucun infoHash, mode client annoncé', async () => {
    const body = await streamsFor(plain(DEBRID_CONFIG), 'tt1234567');

    expect(body.debrid).toBe('client');
    expect(body.streams.some((s) => s.infoHash !== undefined)).toBe(false);
    expect(body.streams.map((s) => s.url)).toContain(CDN_URL);
    expect(callsAllDebrid()).toBe(false);
  });

  it('avec ?torrents=1 : les torrents partent sans URL, marqués client, jamais via /play', async () => {
    const body = await streamsFor(plain(DEBRID_CONFIG), 'tt1234567', '?torrents=1');

    const vff = body.streams.find((s) => s.infoHash === H.vff);
    expect(vff).toBeDefined();
    expect(vff?.url).toBeUndefined();
    expect(vff?.behaviorHints?.lastDebrid).toBe('client');
    expect(body.streams.some((s) => s.url?.includes('/play/'))).toBe(false);
    expect(callsAllDebrid()).toBe(false);
  });

  it('configuration chiffrée : aller-retour /config/encode puis stream, clé jamais en clair', async () => {
    const res = await fetch(`${main.baseUrl}/config/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(DEBRID_CONFIG),
    });
    expect(res.status).toBe(200);
    const { config: token } = (await res.json()) as { config: string };

    expect(token).not.toContain(AD_KEY);
    expect(decodeConfig(token, SECRET, { allowPlain: false }).debrid?.apiKey).toBe(AD_KEY);

    const body = await streamsFor(token, 'tt1234567');
    expect(body.streams.map((s) => s.url)).toContain(CDN_URL);
  });
});

describe('entrées invalides', () => {
  it('configuration invalide : 400 sans écho du contenu', async () => {
    const garbage = await fetch(`${main.baseUrl}/AAAA/stream/movie/tt1234567.json`);
    expect(garbage.status).toBe(400);
    expect(await garbage.text()).toBe('{"error":"invalid_config"}');

    const invalid = await fetch(`${main.baseUrl}/${plain({ maxResults: 0 })}/stream/movie/tt1234567.json`);
    expect(invalid.status).toBe(400);
    const body = await invalid.text();
    expect(body).toBe('{"error":"invalid_config"}');
    expect(body).not.toContain('maxResults');
  });

  it('type ou identifiant hors format : liste vide, sans appel aux sources', async () => {
    const token = plain(PLAIN_CONFIG);
    for (const [type, id] of [
      ['series', 'tt1234567'],
      ['tv', 'tt1234567'],
      ['movie', '12345'],
    ] as const) {
      const { streams } = await streamsFor(token, id, '', type);
      expect(streams).toEqual([]);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('POST /config/test', () => {
  it('renvoie un statut par source, sans jamais renvoyer une clé API, sans appeler AllDebrid ni l’ancien indexeur', async () => {
    const body = {
      sources: [UPSTREAM_SOURCE, TZ_SOURCE, { type: 'upstream', name: 'Cassé', url: BROKEN_URL }],
      debrid: DEBRID,
    };
    const res = await fetch(`${main.baseUrl}/config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(AD_KEY);
    expect(text).not.toContain(TZ_KEY);

    const { sources } = JSON.parse(text) as {
      sources: Array<{ name: string; type: string; ok: boolean; error?: string }>;
    };
    const byName = (name: string) => sources.find((s) => s.name === name);
    expect(byName('Upstream')).toEqual({ name: 'Upstream', type: 'upstream', ok: true, manifest: { types: [], hasStream: true } });
    expect(byName('Indexeur')).toEqual({ name: 'Indexeur', type: 'torznab', ok: false, error: 'source retirée, non interrogée' });
    expect(byName('Cassé')).toEqual({ name: 'Cassé', type: 'upstream', ok: false, error: 'Source "Cassé" : HTTP 500' });
    expect(byName('AllDebrid')).toBeUndefined();
    expect(requests.some((r) => r.url.includes('indexer.example.test'))).toBe(false);
    expect(callsAllDebrid()).toBe(false);
  });
});

describe('journalisation', () => {
  it('aucune sortie console ne contient de clé API ni de configuration', async () => {
    const logged: unknown[][] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args)),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void logged.push(args)),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args)),
      vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => void logged.push(args)),
    ];
    try {
      await streamsFor(plain(DEBRID_CONFIG), 'tt1234567', '?torrents=1');
      await streamsFor(plain({ sources: [{ type: 'upstream', name: 'Cassé', url: BROKEN_URL }, TZ_SOURCE] }), 'tt1234567');
      await fetch(`${main.baseUrl}/AAAA/stream/movie/tt1234567.json`);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    const output = JSON.stringify(logged);
    expect(output).not.toContain(AD_KEY);
    expect(output).not.toContain(TZ_KEY);
    expect(output).not.toContain(plain(DEBRID_CONFIG));
  });
});
