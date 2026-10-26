import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { parsePublicUrl } from '../src/config/runtime-env.js';
import { probeDirectStreams } from '../src/lt/tv-build.js';
import type { TvCatalog } from '../src/lt/tv-catalog.js';
import type { PartyBackend } from '../src/party/backend.js';
import { signTicket } from '../src/party/ticket.js';
import { handlePartyWs } from '../src/party/ws.js';
import { serveApp } from './serve.js';

/**
 * LAST-480 : le core accepte les origines des domaines en service (app.laststream.app, core.laststream.app…) et refuse
 * l'ancienne adresse workers.dev, retirée. Les valeurs testées sont celles de wrangler.jsonc, c'est-à-dire du déploiement.
 */

const SECRET = 'domaines-test-secret-with-32-chars-min!';
const APP = 'https://app.laststream.app';
const CORE = 'https://core.laststream.app';
const RETIRED = 'https://laststream.gtux-prog.workers.dev';
const WRANGLER = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const ROOM = 'room-0123456789abcdef';
const IDENTITY = { accountId: 'compte-1', username: 'alice', avatarColor: '#aa5500' };

/** Valeur d'une variable de `vars` du déploiement (wrangler.jsonc est du JSONC : lecture par expression régulière). */
function deployedVar(name: string): string {
  const match = new RegExp(`"${name}":\\s*"([^"]*)"`).exec(readFileSync(WRANGLER, 'utf8'));
  if (match === null) throw new Error(`${name} absente de wrangler.jsonc`);
  return match[1] ?? '';
}

const servers: Server[] = [];

/** Serveur de l'application avec LASTADDON_ALLOWED_ORIGINS tel que déployé (lu à la construction de l'application). */
async function listenDeployed(): Promise<string> {
  vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', deployedVar('LASTADDON_ALLOWED_ORIGINS'));
  const server = serveApp(createApp({ secret: SECRET, allowPlain: false }));
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  vi.unstubAllEnvs();
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('/config : origines des domaines en service', () => {
  let base = '';
  beforeAll(async () => {
    base = await listenDeployed();
  });

  it.each([APP, CORE, 'https://lastaddon-core.gtux-prog.workers.dev'])(
    'origine %s : renvoyée à l identique dans Access-Control-Allow-Origin',
    async (origin) => {
      const res = await fetch(`${base}/config/schema`, { headers: { Origin: origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    },
  );

  it('ancienne adresse workers.dev du relais : plus autorisée, aucun ACAO', async () => {
    const res = await fetch(`${base}/config/schema`, { headers: { Origin: RETIRED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('WebSocket /party : vérification d origine avec la configuration déployée', () => {
  const party = { room: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }) } as unknown as PartyBackend;
  const IP = '10.20.0.1';

  /** Mise à niveau vers le salon, avec un ticket frais (valide 60 s) et l'origine donnée. */
  const upgrade = (origin: string): Request => {
    const { ticket } = signTicket(ROOM, IDENTITY, Date.now(), SECRET);
    return new Request(`${CORE}/party/${ROOM}/ws?ticket=${encodeURIComponent(ticket)}`, {
      headers: { upgrade: 'websocket', origin },
    });
  };

  beforeEach(() => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', deployedVar('LASTADDON_ALLOWED_ORIGINS'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('origine app.laststream.app : non refusée, le ticket valide ouvre le salon', async () => {
    const res = await handlePartyWs(upgrade(APP), { party, secret: SECRET, ip: IP });
    expect(res.status).toBe(204);
  });

  it('origine evil.example : refusée (403 origin_forbidden) avant tout contrôle du ticket', async () => {
    const res = await handlePartyWs(upgrade('https://evil.example'), { party, secret: SECRET, ip: IP });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_forbidden' });
  });

  it('ancienne adresse workers.dev : refusée (403 origin_forbidden)', async () => {
    const res = await handlePartyWs(upgrade(RETIRED), { party, secret: SECRET, ip: IP });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_forbidden' });
  });
});

describe('URL publique et sonde des flux TV', () => {
  it('LASTADDON_PUBLIC_URL déployée : app.laststream.app, acceptée sans slash final', () => {
    expect(deployedVar('LASTADDON_PUBLIC_URL')).toBe(APP);
    expect(parsePublicUrl(`${APP}/`)).toBe(APP);
  });

  it('par défaut, chaque flux sondé reçoit l origine de l application (app.laststream.app)', async () => {
    const origins: string[] = [];
    const fetchStream = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      origins.push(new Headers(init?.headers).get('origin') ?? '');
      return Promise.resolve(new Response(null, { status: 200, headers: { 'access-control-allow-origin': '*' } }));
    }) as typeof fetch;
    const catalog = { channels: [{ url: 'https://flux.example/tf1.m3u8', alternatives: [] }] } as unknown as TvCatalog;
    await probeDirectStreams(catalog, undefined, { probe: true, fetch: fetchStream, now: () => Date.UTC(2026, 9, 26, 12) });
    expect(origins).not.toHaveLength(0);
    expect(origins.every((origin) => origin === APP)).toBe(true);
  });
});
